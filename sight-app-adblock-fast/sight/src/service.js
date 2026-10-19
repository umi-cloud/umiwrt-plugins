/*
 * 广告过滤（adblock-fast）：配置在 uci adblock-fast（config 段与各 file_url 拦截列表），写入走会话暂存并带回滚应用，
 * adblock-fast 按配置变化自行重载；运行状态读 procd 服务数据（service list），启停与立即更新用宿主的 sight.setInitAction。
 */
import { toList as list, readFile } from '@sight/sdk/lib';

/* 自动更新：root crontab 里带 # adblock-fast-auto 标记的一行，格式与 luci-app-adblock-fast 相同（互认），
   命令 /etc/init.d/adblock-fast dl 重新下载全部列表；写入即生效（写文件后重启 cron），不走暂存 */
export const CRONTAB = '/etc/crontabs/root';
const AUTO = '# adblock-fast-auto';
const LINE = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6]) \/etc\/init\.d\/adblock-fast dl # adblock-fast-auto$/;
const pad = n => String(n).padStart(2, '0');

/** 纯函数：crontab → { mode: 'off'|'daily'|'weekly'|'other', time, day }；other 为 LuCI 写的其它频率，保留不改 */
export function readSchedule(text) {
	const lines = String(text || '').split('\n').filter(l => l.includes(AUTO));
	const active = lines.find(l => !l.trimStart().startsWith('#'));
	if (!active) return { mode: 'off', time: '04:00', day: 0 };
	const m = LINE.exec(active.trim());
	if (!m) return { mode: 'other', time: '04:00', day: 0, line: active.trim() };
	return { mode: m[3] === '*' ? 'daily' : 'weekly', time: `${pad(m[2])}:${pad(m[1])}`, day: m[3] === '*' ? 0 : Number(m[3]) };
}

/** 纯函数：去掉旧的自动更新行（含 LuCI 注释掉的停用行），开启时追加新行；其它内容原样保留 */
export function buildSchedule(text, s) {
	const lines = String(text || '').split('\n').filter(l => !l.includes(AUTO) && !l.includes('# adblock-fast-auto-'));
	while (lines.length && lines[lines.length - 1] === '') lines.pop();
	if (s.mode === 'daily' || s.mode === 'weekly') {
		const [h, m] = s.time.split(':').map(Number);
		lines.push(`${m} ${h} * * ${s.mode === 'weekly' ? s.day : '*'} /etc/init.d/adblock-fast dl ${AUTO}`);
	}
	return lines.length ? lines.join('\n') + '\n' : '';
}

export const validTime = t => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t || '');

/* adblock-fast 的状态码 → 页面状态 */
const STATES = {
	statusSuccess: 'running', statusStopped: 'stopped', statusFail: 'failed',
	statusStarting: 'working', statusRestarting: 'working', statusForceReloading: 'working', statusDownloading: 'working', statusProcessing: 'working',
};
/* 常见错误与警告的说明（英文 msgid），%s 为附带信息；其它代码原样显示 */
export const MESSAGES = {
	errorNothingToDo: 'No block-list or blocked domain is turned on',
	errorOhSnap: 'Could not build the block-list or restart the DNS resolver',
	errorServiceDisabled: 'Ad blocking is turned off',
	errorDownloadingList: 'Could not download %s',
	errorTooLittleRam: 'Not enough free memory (%s) to process all enabled block-lists',
	errorNoHeartbeat: 'DNS stopped answering after the block-list was loaded, so it was removed',
	errorFailDNSReload: 'Could not restart the DNS resolver',
	errorDNSReload: 'Could not restart the DNS resolver',
	errorNoSSLSupport: 'The router cannot download over HTTPS',
	errorNoWanGateway: 'The internet connection is not ready',
	warningMissingRecommendedPackages: 'Recommended packages are missing: %s',
	warningDownloadTimeout: 'Downloading %s timed out',
	warningParallelDownloadsThrottled: 'Downloads are limited to %s at a time because free memory is low',
};

/** 纯函数：procd 服务数据 → 状态 */
export function readStatus(service) {
	const data = service?.data || {};
	const items = (arr, tone) => list(arr).map(e => ({ tone, code: e.code, info: e.info || '' }));
	return {
		state: data.status ? (STATES[data.status] || 'working') : 'stopped',
		entries: Number(data.entries) || 0,
		message: data.message || '',
		version: data.version || '',
		forceDnsActive: !!data.force_dns_active,
		problems: [...items(data.errors, 'error'), ...items(data.warnings, 'warning')],
	};
}

/** 纯函数：uci adblock-fast → 表单 */
export function readConfig(cfg) {
	const c = cfg?.config || {};
	const lists = Object.values(cfg || {}).filter(s => s['.type'] === 'file_url').sort((a, b) => a['.index'] - b['.index']).map(s => ({
		section: s['.name'], name: s.name || s.url, url: s.url || '', size: Number(s.size) || 0, enabled: s.enabled !== '0', action: s.action || 'block',
	}));
	return {
		enabled: c.enabled === '1',
		forceDns: c.force_dns !== '0',
		lists,
		blocked: list(c.blocked_domain),
		allowed: list(c.allowed_domain),
	};
}

export const DOMAIN = /^(\*\.)?([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;

/** 校验：返回错误消息键数组 */
export function validate(form) {
	const errs = [];
	if ([...form.blocked, ...form.allowed].some(d => !DOMAIN.test(d))) errs.push('Enter domains like ads.example.com');
	return errs;
}

/** 写入计划：[{ section, values?, remove? }]，只含有变化的部分；空列表只能删除选项 */
export function plan(before, form) {
	const ops = [];
	const conf = { values: {}, remove: [] };
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	if (form.forceDns !== before.forceDns) conf.values.force_dns = form.forceDns ? '1' : '0';
	for (const [key, opt] of [['blocked', 'blocked_domain'], ['allowed', 'allowed_domain']]) {
		if (same(form[key], before[key])) continue;
		if (form[key].length) conf.values[opt] = form[key]; else conf.remove.push(opt);
	}
	if (Object.keys(conf.values).length || conf.remove.length) ops.push({ section: 'config', ...conf });
	for (const l of form.lists) {
		const old = before.lists.find(x => x.section === l.section);
		if (old && old.enabled !== l.enabled) ops.push({ section: l.section, values: { enabled: l.enabled ? '1' : '0' }, remove: [] });
	}
	return ops;
}

export function createAdblock(client, uci) {
	const initAction = (action) => client.call('sight', 'setInitAction', { name: 'adblock-fast', action });
	return {
		/** 未安装 adblock-fast（配置不存在）时返回 null */
		async load() {
			const [cfg, svc] = await Promise.all([
				uci.load('adblock-fast').catch(e => { if (e?.kind === 'status' && e.status === 4) return null; throw e; }),
				client.call('service', 'list', { name: 'adblock-fast' }).catch(() => ({})),
			]);
			if (!cfg) return null;
			return { config: readConfig(cfg), status: readStatus(svc?.['adblock-fast']) };
		},
		/** 写入会话暂存（不应用） */
		async save(before, form) {
			for (const o of plan(before, form)) {
				if (Object.keys(o.values).length) await uci.set('adblock-fast', o.section, o.values);
				if (o.remove.length) await uci.remove('adblock-fast', o.section, o.remove).catch(() => {});
			}
		},
		/** 开关：写 enabled 并应用后，启用并启动或停止并停用开机自启 */
		async setEnabled(on) { await uci.set('adblock-fast', 'config', { enabled: on ? '1' : '0' }); },
		async afterToggle(on) {
			await initAction(on ? 'enable' : 'disable');
			await initAction(on ? 'start' : 'stop');
		},
		/** 立即更新：重启服务，重新下载并生成拦截表 */
		update: () => initAction('restart'),
		async loadSchedule() {
			const f = await readFile(client, CRONTAB);
			if (f.state === 'denied') throw new Error('Permission denied');
			return readSchedule(f.state === 'ok' ? f.data : '');
		},
		/** 读最新内容再改，避免覆盖其他程序刚写入的任务 */
		async saveSchedule(s) {
			const f = await readFile(client, CRONTAB);
			if (f.state === 'denied') throw new Error('Permission denied');
			await client.call('file', 'write', { path: CRONTAB, data: buildSchedule(f.state === 'ok' ? f.data : '', s), mode: 0o600 });
			await client.call('sight', 'setInitAction', { name: 'cron', action: 'restart' });
		},
	};
}
