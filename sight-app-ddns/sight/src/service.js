/*
 * DDNS（ddns-scripts）：实例为 ddns 配置的 service 段，写入走会话暂存；
 * 状态、日志由插件自带的 sight.ddns 读取；服务商取 /usr/share/ddns/default/*.json 的文件名。
 * 即时操作：整体启停（init）、单实例立即更新/停止（lucihelper，参数与 ACL 逐字对应）。
 * 服务商二选一：service_name（预置）或 update_url（自定义），切换时删除另一项。
 * 地址来源只管理 network / web 两种；interface、script 等其他来源整组保持原样。
 * 本机当前地址由 sight.ddns 的 get_current_ip 按条目配置检测，与更新进程同一套逻辑。
 */
import { isHostname, isIPv4, isIPv6, probe, ignoreNotFound } from '@sight/sdk/lib';

/* 启动项操作走宿主自带的 sight 对象（sight-ui ≥ 0.4.0，包依赖已约束） */
const initAction = (client, name, action) => client.call('sight', 'setInitAction', { name, action });

const HELPER = '/usr/lib/ddns/dynamic_dns_lucihelper.sh';

/* 常用服务商排在选择列表前面（仅显示本机实际提供的） */
export const FEATURED = ['duckdns.org', 'dynu.com', 'he.net', 'namecheap.com', 'dynv6.com', 'desec.io', 'oray.com', '3322.org'];

/* 间隔单位与 ddns-scripts 默认值（check 10 分钟、force 72 小时） */
export const UNITS = ['minutes', 'hours', 'days'];
const UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
const DEFAULTS = { check: ['10', 'minutes'], force: ['72', 'hours'] };
const seconds = (kind, interval, unit) => Number(String(interval ?? '').trim() || DEFAULTS[kind][0]) * (UNIT_SECONDS[unit || DEFAULTS[kind][1]] ?? NaN);

/** 状态归纳：条目停用 / 自动更新关闭 / 正在运行 / 已同步 / 解析与本机地址不一致 / 等待首次更新 */
export function entryState(entry, serviceEnabled, match) {
	if (!entry.enabled) return 'off';
	if (!serviceEnabled) return 'paused';
	/* 状态读不到（undefined）时为未知，不当作「等待首次更新」 */
	if (entry.status === undefined) return 'unknown';
	if (entry.status?.ip) return match === 'mismatch' ? 'outdated' : 'synced';
	if (entry.status?.pid) return 'running';
	return 'waiting';
}

/** 地址规范化：IPv6 展开为 8 组小写、去前导零，便于与解析结果比较；不是地址返回空串 */
export function normalizeIp(ip) {
	const s = String(ip ?? '').trim().toLowerCase();
	if (isIPv4(s)) return s;
	if (!isIPv6(s)) return '';
	let v = s;
	const v4 = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
	if (v4) { const o = v4[2].split('.').map(Number); v = v4[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
	const [head, tail] = v.split('::');
	const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
	const groups = tail === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
	return groups.map(g => parseInt(g, 16).toString(16)).join(':');
}

/** 状态接口把多条解析结果用 <br/> 连接 */
export const registeredList = ip => String(ip ?? '').split(/<br\s*\/?>|[\s,]+/).filter(Boolean);

/** 本机当前公网地址与域名解析是否一致：match / mismatch / unknown（任一方读不到） */
export function addressMatch(current, registered) {
	const cur = normalizeIp(current);
	const list = registeredList(registered).map(normalizeIp).filter(Boolean);
	if (!cur || !list.length) return 'unknown';
	return list.includes(cur) ? 'match' : 'mismatch';
}

/* get_services_status 的 next_update 除日期外还有这几个关键字 */
const SCHEDULE = { Verify: 'Checking now', 'Run once': 'Runs once', Disabled: 'Off', Stopped: 'Not running' };
/** 下次检查：运行中取 next_check；否则按 next_update 关键字说明；返回 { text: msgid } 或 { value } */
export function nextCheck(status) {
	if (status?.pid && status.next_check) return { value: status.next_check };
	if (Object.hasOwn(SCHEDULE, status?.next_update ?? '')) return { text: SCHEDULE[status.next_update] };
	return { value: '' };
}

export function createDdns(client, uci) {
	function validate(s, existing) {
		const e = [];
		if (!s.id && !/^[a-zA-Z0-9_]{1,32}$/.test(s.name)) e.push('Name must be 1-32 letters, digits or underscores');
		else if (!s.id && existing.includes(s.name)) e.push('A DDNS entry with this name already exists');
		if (s.provider === 'custom') { if (!/^https?:\/\/\S+$/.test(s.updateUrl.trim())) e.push('Enter an update URL starting with http:// or https://'); }
		else if (!s.provider) e.push('Choose a provider');
		/* 部分服务商要求 host@domain 等写法，只拒绝空值与空白 */
		if (!s.domain.trim() || /\s/.test(s.domain)) e.push('Invalid domain');
		if (s.lookupHost.trim() && !isHostname(s.lookupHost.trim())) e.push('Invalid lookup host');
		if (s.ipSource === 'web' && s.ipUrl.trim() && !/^https?:\/\/\S+$/.test(s.ipUrl.trim())) e.push('Enter a detection URL starting with http:// or https://');
		/* ddns-scripts 把低于 5 分钟的检查间隔改回 5 分钟，强制更新间隔为 0（只运行一次）或不小于检查间隔 */
		const check = String(s.checkInterval).trim(), force = String(s.forceInterval).trim();
		if (check && (!/^\d+$/.test(check) || seconds('check', check, s.checkUnit) < 300)) e.push('Check interval must be at least 5 minutes');
		else if (force && (!/^\d+$/.test(force) || (+force > 0 && seconds('force', force, s.forceUnit) < seconds('check', check, s.checkUnit)))) e.push('Forced update interval must be 0 or not shorter than the check interval');
		/* 与 ddns-scripts 的 DNS 字符集一致：主机名或地址，可带 :端口 */
		if (s.dnsServer.trim() && !/^[a-zA-Z0-9.:_-]+$/.test(s.dnsServer.trim())) e.push('Invalid DNS server');
		return e;
	}

	/* 间隔与单位：间隔为空且单位为默认时两项都删除；单位不是默认值时单独保留，否则 ddns-scripts 会按「默认间隔 × 该单位」计算 */
	function interval(values, remove, kind, value, unit) {
		const v = String(value ?? '').trim(), u = unit || DEFAULTS[kind][1];
		if (v) values[`${kind}_interval`] = v; else remove.push(`${kind}_interval`);
		if (v || u !== DEFAULTS[kind][1]) values[`${kind}_unit`] = u; else remove.push(`${kind}_unit`);
	}

	/* 只写界面管理的键；未管理的选项（含 interface/script 等其他地址来源的整组设置）保持原样 */
	function plan(s) {
		const values = {
			enabled: s.enabled ? '1' : '0', use_ipv6: s.ipv6 ? '1' : '0', domain: s.domain.trim(),
			lookup_host: (s.lookupHost.trim() || s.domain.trim()),
		};
		const remove = [];
		if (s.provider === 'custom') { values.update_url = s.updateUrl.trim(); remove.push('service_name'); }
		else { values.service_name = s.provider; remove.push('update_url'); }
		for (const [k, v] of [['username', s.username], ['password', s.password]]) { if (v) values[k] = v; else remove.push(k); }
		if (s.ipSource === 'network') Object.assign(values, { ip_source: 'network', ip_network: s.network, interface: s.network });
		else if (s.ipSource === 'web') {
			values.ip_source = 'web';
			if (s.ipUrl.trim()) values.ip_url = s.ipUrl.trim(); else remove.push('ip_url');
			/* 新条目仍在所选接口上线时启动（hotplug 按 interface 触发）；已有条目不改触发接口 */
			if (!s.id) values.interface = s.network;
		}
		interval(values, remove, 'check', s.checkInterval, s.checkUnit);
		interval(values, remove, 'force', s.forceInterval, s.forceUnit);
		/* 证书留空即用各下载工具的系统证书库（/etc/ssl/certs）；只管理「不校验」（IGNORE），自定义证书路径不动 */
		if (s.https) {
			values.use_https = '1';
			if (s.insecure) values.cacert = 'IGNORE';
			else if (s.cacert === 'IGNORE') remove.push('cacert');
		} else remove.push('use_https');
		if (s.dnsServer.trim()) values.dns_server = s.dnsServer.trim(); else remove.push('dns_server');
		return { values, remove };
	}

	return {
		validate, plan,
		/** @returns {Promise<null | object>} null = 未安装 */
		async load() {
			const state = await probe(client, 'sight.ddns', 'get_ddns_state');
			if (!state) return null;
			const [cfg, status, dir, network] = await Promise.all([
				uci.load('ddns'),
				client.call('sight.ddns', 'get_services_status').catch(() => null),
				/* 服务商目录不存在视为没有预置服务商；其它读取失败单独标记，不当作空列表 */
				client.call('file', 'list', { path: '/usr/share/ddns/default' }).catch(e => e?.status === 4 ? { entries: [] } : null),
				uci.load('network').catch(() => ({})),
			]);
			const services = Object.values(cfg).filter(s => s['.type'] === 'service').map(s => ({
				id: s['.name'], name: s['.name'], enabled: s.enabled === '1', ipv6: s.use_ipv6 === '1',
				provider: s.update_url && !s.service_name ? 'custom' : (s.service_name || ''), updateUrl: s.update_url || '',
				domain: s.domain || '', lookupHost: s.lookup_host || '', username: s.username || '', password: s.password || '',
				network: s.ip_network || s.interface || 'wan',
				/* ip_source 缺省时 ddns-scripts 按 network 处理 */
				ipSource: ['network', 'web'].includes(s.ip_source || 'network') ? (s.ip_source || 'network') : 'other', ipSourceRaw: s.ip_source || 'network', ipUrl: s.ip_url || '',
				checkInterval: s.check_interval || '', checkUnit: s.check_unit || 'minutes', forceInterval: s.force_interval || '', forceUnit: s.force_unit || 'hours',
				https: s.use_https === '1', insecure: s.cacert === 'IGNORE', cacert: s.cacert || '', dnsServer: s.dns_server || '',
				status: status ? status[s['.name']] || null : undefined,
			}));
			return {
				enabled: !!state._enabled, version: String(state._version || '').trim(), services,
				providersError: !dir,
				providers: (dir?.entries || []).filter(e => e.type === 'file' && e.name.endsWith('.json')).map(e => e.name.slice(0, -5)).sort(),
				networks: Object.values(network).filter(s => s['.type'] === 'interface' && s['.name'] !== 'loopback').map(s => s['.name']),
			};
		},
		async save(s) {
			const { values, remove } = plan(s);
			if (s.id) {
				await uci.set('ddns', s.id, values);
				if (remove.length) await uci.remove('ddns', s.id, remove).catch(ignoreNotFound);
			} else {
				await uci.add('ddns', 'service', s.name, values);
			}
		},
		async remove(id) { await uci.remove('ddns', id); },
		async setEnabled(id, on) { await uci.set('ddns', id, { enabled: on ? '1' : '0' }); },
		/** 整体启停：开机自启与运行状态一并切换（与 LuCI 行为一致） */
		async toggleService(on) {
			await initAction(client, 'ddns', on ? 'enable' : 'disable');
			await initAction(client, 'ddns', on ? 'start' : 'stop');
		},
		/** 单实例立即更新 / 停止 */
		async run(name, action) {
			if (!['start', 'stop'].includes(action)) throw new Error('Unknown action');
			const r = await client.call('file', 'exec', { command: HELPER, params: ['-S', name, '--', action] });
			if ((r.code ?? 0) !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
		},
		/** 服务商需要哪些凭据：按更新地址模板中的占位符判断；读不到时两项都显示 */
		async providerInfo(name) {
			if (!name || name === 'custom') return { username: true, password: true, ipv6: true };
			try {
				const r = await client.call('file', 'read', { path: `/usr/share/ddns/default/${name}.json` });
				const def = JSON.parse(r.data || '{}');
				const urls = [def.ipv4?.url, def.ipv6?.url].filter(Boolean).join(' ');
				const scripted = !urls && (def.ipv4?.script || def.ipv6?.script);
				return { username: scripted || urls.includes('[USERNAME]'), password: scripted || urls.includes('[PASSWORD]'), ipv6: !!def.ipv6 };
			} catch { return { username: true, password: true, ipv6: true }; }
		},
		/** 本机当前地址（按条目的地址来源检测）；检测不到返回 null */
		async currentIp(name) {
			const r = await client.call('sight.ddns', 'get_current_ip', { service_name: name });
			if (r?.error) throw new Error(r.error);
			return normalizeIp(r?.ip) ? r.ip : null;
		},
		async log(name) {
			const r = await client.call('sight.ddns', 'get_services_log', { service_name: name });
			const text = String(r?.result ?? '');
			return text === 'File not found or empty' ? '' : text;
		},
	};
}
