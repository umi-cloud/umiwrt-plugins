/*
 * HomeProxy（sing-box 客户端）的 Sight 页面取数服务。按日常任务管理：代理开关与主节点、节点导入（分享链接）与删除、
 * 分流模式、UDP 节点与 DNS、哪些局域网设备走代理、订阅与规则库更新、连通性检查、日志。
 * 节点的逐项编辑、自定义分流规则、服务端不在页面范围内：已有的这类配置原样保留，不提供编辑。
 * 配置写入会话暂存（页面保存后立即带回滚应用）；订阅/规则库更新、连通性检查、清空日志为即时操作。
 * 关闭代理即 main_node = 'nil'（后端约定的「禁用」）；自定义分流模式下主节点不生效。
 * 设备访问控制只管按 MAC 的名单（lan_proxy_mac_addrs / lan_direct_mac_addrs），按 IP 的名单原样保留。
 */
import { probe, readFile, isIPv4, isIPv6, isHostname, isMac, toList as list, ignoreNotFound, notInstalled } from '@sight/sdk/lib';

/* 启动项操作走宿主自带的 sight 对象；旧版宿主（sight-ui 0.4 之前）只有 LuCI 的 luci 对象 */
async function initAction(client, name, action) {
	try { return await client.call('sight', 'setInitAction', { name, action }); }
	catch (e) {
		if (!notInstalled(e)) throw e;
		return client.call('luci', 'setInitAction', { name, action });
	}
}
import { parseShareLink } from './sharelink.js';

export const MODES = ['bypass_mainland_china', 'gfwlist', 'proxy_mainland_china', 'global'];
export const LOGS = ['homeproxy', 'sing-box-c'];
export const SITES = ['google', 'baidu'];
export const RESOURCES = ['china_ip4', 'china_ip6', 'china_list', 'gfw_list'];
/* 各分流模式依赖的规则库：缺失时该模式无法正确分流 */
export const MODE_RESOURCES = {
	bypass_mainland_china: ['china_ip4', 'china_ip6', 'china_list'],
	proxy_mainland_china: ['china_ip4', 'china_ip6', 'china_list'],
	gfwlist: ['gfw_list'],
};
/** 纯函数：当前模式依赖、但还没下载的规则库；versions 未知（null）时返回空 */
export function missingResources(mode, versions) {
	return versions ? (MODE_RESOURCES[mode] || []).filter(r => !versions[r]) : [];
}
/* 自定义域名列表：proxy_list 强制走代理，direct_list 强制直连（自定义分流模式下不生效） */
export const DOMAIN_LISTS = ['proxy_list', 'direct_list'];
/** 纯函数：列表文件内容 → 域名数组（去空行、去重、转小写） */
export function parseDomains(text) {
	return [...new Set(String(text || '').split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(Boolean))];
}
export function validateDomains(domains) {
	return domains.every(isHostname) ? [] : ['Invalid domain'];
}
/** 纯函数：ping 输出 → 平均延迟（毫秒，取整）；全部丢包或格式不符返回 null */
export function parsePing(stdout) {
	const m = String(stdout || '').match(/min\/avg\/max(?:\/\w+)? = [\d.]+\/([\d.]+)\//);
	return m ? Math.max(1, Math.round(Number(m[1]))) : null;
}
export const ACCESS = ['disabled', 'listed_only', 'except_listed'];
/* 预置 DNS 与上游 HomeProxy 的选项一致；wan 表示使用上联下发的 DNS */
export const DNS_PRESETS = ['wan', '1.1.1.1', '8.8.8.8', '208.67.222.222', '223.5.5.5', '119.29.29.29'];
export const CHINA_DNS_PRESETS = ['wan', '223.5.5.5', '119.29.29.29', '210.2.4.8'];
/* resources_update 的状态码 */
export const UPDATE_RESULT = { 0: 'updated', 1: 'failed', 2: 'busy', 3: 'latest' };
const OFF = 'nil';

/** 纯函数：uci 配置 + 服务状态 → 页面数据 */
export function shape(cfg, services) {
	const config = cfg.config || {}, control = cfg.control || {}, sub = cfg.subscription || {};
	const nodes = Object.values(cfg).filter(s => s['.type'] === 'node').map(s => ({
		id: s['.name'], label: s.label || s['.name'], type: s.type || '', address: s.address || '', port: s.port || '',
		/* 订阅导入的节点带 grouphash，手工添加的没有 */
		subscribed: !!s.grouphash,
	}));
	const mainNode = config.main_node && config.main_node !== OFF ? config.main_node : '';
	const instance = services?.homeproxy?.instances?.['sing-box-c'];
	return {
		enabled: !!mainNode, mainNode, mode: config.routing_mode || 'bypass_mainland_china', nodes,
		udpNode: config.main_udp_node || 'same',
		dnsServer: config.dns_server || '8.8.8.8', chinaDnsServer: config.china_dns_server || '223.5.5.5',
		access: {
			mode: ACCESS.includes(control.lan_proxy_mode) ? control.lan_proxy_mode : 'disabled',
			proxyMacs: list(control.lan_proxy_mac_addrs).map(m => m.toUpperCase()),
			directMacs: list(control.lan_direct_mac_addrs).map(m => m.toUpperCase()),
		},
		subscriptions: list(sub.subscription_url),
		autoUpdate: sub.auto_update === '1', viaProxy: sub.update_via_proxy === '1',
		allowInsecure: sub.allow_insecure === '1', packetEncoding: sub.packet_encoding || '',
		/* 服务状态取不到时为 null，不当作未运行 */
		running: services == null ? null : !!instance?.running,
	};
}

export function validateSubscriptions(urls) {
	return urls.every(u => /^https?:\/\/\S+$/i.test(u)) ? [] : ['Subscription addresses must start with http:// or https://'];
}

/** DNS 地址：wan、IP 或 主机名，也可带协议前缀（tcp:// https:// tls:// quic:// 等）与端口、路径 */
export function isDnsServer(v) {
	v = String(v || '').trim();
	if (v === 'wan') return true;
	if (isIPv4(v) || isIPv6(v)) return true;
	try {
		const host = new URL(v.replace(/^[a-z0-9+]+:\/\//i, 'http://')).hostname.replace(/^\[|\]$/g, '');
		return /:\/\//.test(v) && (isIPv4(host) || isIPv6(host) || isHostname(host));
	} catch { return false; }
}

export function validateRouting(r, nodes) {
	const e = [];
	if (!MODES.includes(r.mode) && r.mode !== 'custom') e.push('Unknown routing mode');
	if (!['same', OFF].includes(r.udpNode) && !nodes.some(n => n.id === r.udpNode)) e.push('Choose a UDP node');
	if (!isDnsServer(r.dnsServer)) e.push('Invalid DNS server');
	if (r.mode === 'bypass_mainland_china' && !isDnsServer(r.chinaDnsServer)) e.push('Invalid China DNS server');
	return e;
}

/** 纯函数：多行分享链接 → 逐行解析结果（去重、忽略空行） */
export function previewLinks(text, features) {
	const links = [...new Set(String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean))];
	return links.map(link => ({ link, node: parseShareLink(link, features) }));
}

/** 纯函数：导入节点的最终选项；订阅设置里的「允许不安全」「包编码」同样作用于手工导入（与上游 HomeProxy 一致） */
export function importValues(node, settings) {
	const v = { ...node };
	if (v.tls === '1' && settings.allowInsecure) v.tls_insecure = '1';
	if (['vless', 'vmess'].includes(v.type) && settings.packetEncoding) v.packet_encoding = settings.packetEncoding;
	return v;
}

/** 纯函数：访问控制写入计划；另一种名单保持原样，按 IP 的名单不动 */
export function planAccess(mode, macs) {
	const values = { lan_proxy_mode: mode }, remove = [];
	const key = mode === 'listed_only' ? 'lan_proxy_mac_addrs' : mode === 'except_listed' ? 'lan_direct_mac_addrs' : null;
	if (key) { if (macs.length) values[key] = macs; else remove.push(key); }
	return { values, remove };
}

export function createHomeProxy(client, uci) {
	const drop = (config, section, options) => uci.remove(config, section, options).catch(ignoreNotFound);
	return {
		/** @returns {Promise<null | ReturnType<typeof shape> & { version: string, features: object }>} null = 未安装 */
		async load() {
			const features = await probe(client, 'luci.homeproxy', 'singbox_get_features');
			if (!features) return null;
			const [cfg, services] = await Promise.all([uci.load('homeproxy'), client.call('service', 'list', { name: 'homeproxy' }).catch(() => null)]);
			return { ...shape(cfg, services), version: features.version || '', features };
		},
		async useNode(id) { await uci.set('homeproxy', 'config', { main_node: id }); },
		async turnOff() { await uci.set('homeproxy', 'config', { main_node: OFF }); },
		async setMode(mode) {
			if (!MODES.includes(mode)) throw new Error('Unknown routing mode');
			await uci.set('homeproxy', 'config', { routing_mode: mode });
		},
		/** 自定义模式不在此页面管理，这里只写 UDP 与 DNS */
		async saveRouting(r) {
			const values = { main_udp_node: r.udpNode, dns_server: r.dnsServer.trim() };
			if (MODES.includes(r.mode)) values.routing_mode = r.mode;
			if (r.mode === 'bypass_mainland_china') values.china_dns_server = r.chinaDnsServer.trim();
			await uci.set('homeproxy', 'config', values);
		},
		async saveAccess(mode, macs) {
			if (!ACCESS.includes(mode)) throw new Error('Unknown access mode');
			if (!macs.every(isMac)) throw new Error('Invalid MAC address');
			const { values, remove } = planAccess(mode, macs.map(m => m.toUpperCase()));
			await uci.set('homeproxy', 'control', values);
			if (remove.length) await drop('homeproxy', 'control', remove);
		},
		/** @returns {Promise<number>} 写入暂存的节点数 */
		async importNodes(nodes, settings) {
			for (const n of nodes) await uci.add('homeproxy', 'node', null, importValues(n, settings));
			return nodes.length;
		},
		/** 正在使用的节点（主节点或 UDP 节点）不删，避免服务引用不存在的节点 */
		async removeNode(id, data) {
			if (id === data.mainNode || id === data.udpNode) throw new Error('This node is in use');
			await uci.remove('homeproxy', id);
		},
		async saveSubscriptions(urls) {
			if (urls.length) await uci.set('homeproxy', 'subscription', { subscription_url: urls });
			else await drop('homeproxy', 'subscription', ['subscription_url']);
		},
		async saveSubscriptionOptions({ autoUpdate, viaProxy }) {
			await uci.set('homeproxy', 'subscription', { auto_update: autoUpdate ? '1' : '0', update_via_proxy: viaProxy ? '1' : '0' });
		},
		/** 按已生效的订阅地址拉取节点；脚本自行写入配置并重启服务 */
		async updateSubscriptions() {
			const r = await client.call('file', 'exec', { command: '/etc/homeproxy/scripts/update_subscriptions.uc', params: [] });
			return { ok: (r.code ?? 0) === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
		},
		/** @returns {Promise<Record<string, string | null>>} 规则库版本；文件不存在为 null */
		async resourceVersions() {
			/* 插件在返回版本号的同时可能带着残留的 error 字段（上一次系统调用的 errno）：有版本号即以版本号为准。
			   读取失败向上抛，不当作未下载 */
			const r = await Promise.all(RESOURCES.map(type => client.call('luci.homeproxy', 'resources_get_version', { type })));
			return Object.fromEntries(RESOURCES.map((type, i) => [type, r[i]?.version || null]));
		},
		/** @returns {Promise<'updated' | 'failed' | 'busy' | 'latest'>} */
		async updateResource(type) {
			if (!RESOURCES.includes(type)) throw new Error('Unknown resource');
			const r = await client.call('luci.homeproxy', 'resources_update', { type });
			return UPDATE_RESULT[r?.status] || 'failed';
		},
		/** @returns {Promise<boolean>} 经代理访问该站点是否成功 */
		async check(site) {
			if (!SITES.includes(site)) throw new Error('Unknown site');
			const r = await client.call('luci.homeproxy', 'connection_check', { site });
			return !!r?.result;
		},
		/** @returns {Promise<string | null>} null = 日志文件不存在（服务未运行过） */
		async log(name) {
			if (!LOGS.includes(name)) throw new Error('Unknown log');
			const f = await readFile(client, `/var/run/homeproxy/${name}.log`);
			return f.state === 'ok' ? f.data : null;
		},
		/** @returns {Promise<{ proxy_list: string[], direct_list: string[] }>} */
		async domainLists() {
			const r = await Promise.all(DOMAIN_LISTS.map(type => client.call('luci.homeproxy', 'acllist_read', { type })));
			return Object.fromEntries(DOMAIN_LISTS.map((type, i) => [type, parseDomains(r[i]?.content)]));
		},
		/** 写入有变化的列表（文件，不走暂存）；代理开着时重载服务让新列表生效，会短暂中断代理 */
		async saveDomainLists(lists, current, enabled) {
			for (const type of DOMAIN_LISTS) {
				const next = parseDomains(lists[type].join('\n'));
				if (validateDomains(next).length) throw new Error('Invalid domain');
				if (next.join('\n') === current[type].join('\n')) continue;
				const r = await client.call('luci.homeproxy', 'acllist_write', { type, content: next.join('\n') });
				if (r?.result === false) throw new Error(r.error || 'Request failed');
			}
			if (enabled) await initAction(client, 'homeproxy', 'reload');
		},
		/**
		 * 到节点服务器的线路延迟：路由器直接 ping 服务器地址（不经代理），只反映线路远近，不代表代理速度。
		 * @returns {Promise<number | 'timeout' | 'unsupported'>} 毫秒；服务器不回应 ping 为 timeout；IPv6 地址暂不支持
		 */
		async latency(node) {
			if (!isIPv4(node.address) && !isHostname(node.address)) return 'unsupported';
			const r = await client.call('file', 'exec', { command: '/bin/ping', params: ['-4', '-c', '3', '-W', '1', node.address] });
			return parsePing(r.stdout) ?? 'timeout';
		},
		async cleanLog(name) {
			if (!LOGS.includes(name)) throw new Error('Unknown log');
			await client.call('luci.homeproxy', 'log_clean', { type: name });
		},
	};
}
