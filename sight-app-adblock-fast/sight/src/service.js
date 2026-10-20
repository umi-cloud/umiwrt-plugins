/*
 * 广告过滤（adblock-fast）：配置在 uci adblock-fast（config 段与各 file_url 拦截列表），写入走会话暂存并带回滚应用，
 * adblock-fast 按配置变化自行重载；运行状态读 procd 服务数据（service list），启停与立即更新用宿主的 sight.setInitAction；
 * 域名检查、限时暂停与可用内存由本包的 sight.adblock-fast 提供。
 */
import { toList as list, ignoreNotFound } from '@sight/sdk/lib';

const flag = on => on ? '1' : '0';

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
	warningDownloadTimeout: 'Downloading %s timed out',
	warningParallelDownloadsThrottled: 'Downloads are limited to %s at a time because free memory is low',
};

/* 界面上无法处理的提示不显示：缺少推荐软件包只影响处理速度 */
const HIDDEN = new Set(['warningMissingRecommendedPackages']);

/** 纯函数：procd 服务数据（与 sight.adblock-fast status）→ 状态 */
export function readStatus(service, extra = {}) {
	const data = service?.data || {};
	const items = (arr, tone) => list(arr).filter(e => !HIDDEN.has(e.code)).map(e => ({ tone, code: e.code, info: e.info || '' }));
	return {
		state: data.status ? (STATES[data.status] || 'working') : 'stopped',
		entries: Number(data.entries) || 0,
		problems: [...items(data.errors, 'error'), ...items(data.warnings, 'warning')],
		paused: !!extra.paused,
		remaining: Number(extra.remaining) || 0,
		memAvailable: Number(extra.mem_available) || 0,
	};
}

/* 列表顺序：已开启的在前；同组内拦截列表在前、放行列表在后，各自按体积从大到小，体积未知（新加、尚未下载）的排最后。
   只在读取时排序，勾选不会让列表跳动 */
const byKind = (a, b) => b.enabled - a.enabled || (a.action === 'allow') - (b.action === 'allow') || (!a.size) - (!b.size) || b.size - a.size;

/** 纯函数：uci adblock-fast → 表单 */
export function readConfig(cfg) {
	const c = cfg?.config || {};
	const lists = Object.values(cfg || {}).filter(s => s['.type'] === 'file_url').sort((a, b) => a['.index'] - b['.index']).map(s => ({
		section: s['.name'], name: s.name || s.url, url: s.url || '', size: Number(s.size) || 0, enabled: s.enabled !== '0', action: s.action === 'allow' ? 'allow' : 'block',
	})).sort(byKind);
	return {
		enabled: c.enabled === '1',
		forceDns: c.force_dns !== '0',
		lists,
		blocked: list(c.blocked_domain),
		allowed: list(c.allowed_domain),
	};
}

/* 不接受 *.example.com：adblock-fast 处理自定义域名时会丢掉这类行，而子域名本来就会一并生效 */
export const DOMAIN = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;
const LIST_URL = /^https?:\/\/[^\s/]+\S*$/;

/** 校验要新加的列表：返回 { url?, name? } 错误消息键 */
export function validateList(l, lists) {
	const errs = {};
	const url = l.url.trim();
	if (!LIST_URL.test(url)) errs.url = 'Enter an address starting with http:// or https://';
	else if (lists.some(x => x.url === url)) errs.url = 'This list is already added';
	if (l.name.trim().length > 64) errs.name = 'Use at most 64 characters';
	return errs;
}

/** 新列表：名称缺省取地址的主机名；保存后由 adblock-fast 下载并补上体积 */
export function newList(l) {
	const url = l.url.trim();
	return { section: null, name: l.name.trim() || new URL(url).hostname, url, size: 0, enabled: true, action: l.action === 'allow' ? 'allow' : 'block' };
}

/* 处理内存估算，与 adblock-fast 下载前的检查一致：已开启列表体积的两倍，加一个下载任务约 4 MB */
const SLOT_RAM = 4 * 1048576;
/** 纯函数：已开启列表 → { count, total, need, unknown }；unknown 为体积未知、未计入的列表数 */
export function listUsage(lists) {
	const on = lists.filter(l => l.enabled);
	const total = on.reduce((n, l) => n + l.size, 0);
	return { count: on.length, total, need: total ? total * 2 + SLOT_RAM : 0, unknown: on.filter(l => !l.size).length };
}

/** 校验：返回 [{ text, field }]，text 为错误消息键，field 为出错的控件 id */
export function validate(form) {
	return [['blocked', 'adblock-blocked'], ['allowed', 'adblock-allowed']]
		.filter(([key]) => form[key].some(d => !DOMAIN.test(d)))
		.map(([, field]) => ({ text: 'Enter domains like ads.example.com', field }));
}

/** 写入计划：[{ op: 'set'|'add'|'delete', … }]，只含有变化的部分；空列表只能删除选项 */
export function plan(before, form) {
	const ops = [];
	const conf = { values: {}, remove: [] };
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	if (form.forceDns !== before.forceDns) conf.values.force_dns = flag(form.forceDns);
	for (const [key, opt] of [['blocked', 'blocked_domain'], ['allowed', 'allowed_domain']]) {
		if (same(form[key], before[key])) continue;
		if (form[key].length) conf.values[opt] = form[key]; else conf.remove.push(opt);
	}
	if (Object.keys(conf.values).length || conf.remove.length) ops.push({ op: 'set', section: 'config', ...conf });
	for (const old of before.lists) if (!form.lists.some(l => l.section === old.section)) ops.push({ op: 'delete', section: old.section });
	for (const l of form.lists) {
		const old = l.section && before.lists.find(x => x.section === l.section);
		if (!l.section) ops.push({ op: 'add', type: 'file_url', values: { name: l.name, url: l.url, action: l.action, enabled: flag(l.enabled) } });
		else if (old && old.enabled !== l.enabled) ops.push({ op: 'set', section: l.section, values: { enabled: flag(l.enabled) }, remove: [] });
	}
	return ops;
}

export function createAdblock(client, uci) {
	const initAction = action => client.call('sight', 'setInitAction', { name: 'adblock-fast', action });
	const rpc = (method, args) => client.call('sight.adblock-fast', method, args);
	return {
		/** 未安装 adblock-fast（配置不存在）时返回 null */
		async load() {
			const [cfg, svc, extra] = await Promise.all([
				uci.load('adblock-fast').catch(e => { ignoreNotFound(e); return null; }),
				/* 服务没在 procd 登记时返回空对象，读取失败照常报错，不当成已停止 */
				client.call('service', 'list', { name: 'adblock-fast' }),
				rpc('status'),
			]);
			if (!cfg) return null;
			return { config: readConfig(cfg), status: readStatus(svc?.['adblock-fast'], extra) };
		},
		/** 写入会话暂存（不应用） */
		async save(before, form) {
			for (const o of plan(before, form)) {
				if (o.op === 'add') await uci.add('adblock-fast', o.type, null, o.values);
				else if (o.op === 'delete') await uci.remove('adblock-fast', o.section);
				else {
					if (Object.keys(o.values).length) await uci.set('adblock-fast', o.section, o.values);
					if (o.remove.length) await uci.remove('adblock-fast', o.section, o.remove).catch(ignoreNotFound);
				}
			}
		},
		/** 开关：写 enabled 并应用后，启用并启动或停止并停用开机自启 */
		async setEnabled(on) { await uci.set('adblock-fast', 'config', { enabled: flag(on) }); },
		async afterToggle(on) {
			/* 暂停中关闭时先取消暂停，免得到时又被启动 */
			if (!on) await this.resume();
			await initAction(on ? 'enable' : 'disable');
			await initAction(on ? 'start' : 'stop');
		},
		/** 立即更新：重启服务，重新下载并生成拦截表 */
		update: () => initAction('restart'),
		/** 在当前生效的拦截表里查域名：{ blocked, match }；未生成拦截表时为状态 5 */
		check: domain => rpc('check', { domain }),
		/** 暂停若干分钟，到时由后台进程重新启动 */
		pause: minutes => rpc('pause', { minutes }),
		/** 只取消暂停，不启动服务 */
		resume: () => rpc('resume'),
		/** 提前恢复：取消暂停并启动服务 */
		async resumeNow() { await this.resume(); await initAction('start'); },
	};
}
