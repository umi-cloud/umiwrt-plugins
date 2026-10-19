/*
 * HomeProxy（sing-box 客户端）的 Sight 页面取数服务。按日常任务管理：代理开关与主节点、节点添加/编辑（node.js）、
 * 分享链接导入与删除、分流模式、UDP 节点与 DNS、自定义分流（routing.js）、哪些局域网设备走代理、
 * 订阅（来源归组、过滤、更新结果，subscription.js）与规则库更新、连通性检查、启动失败诊断、日志。服务端不在页面范围内。
 * 配置写入会话暂存（页面保存后立即带回滚应用）；订阅/规则库更新、连通性检查、清空日志为即时操作。
 * 关闭代理即 main_node = 'nil'（后端约定的「禁用」）；自定义分流模式下主节点不生效，开关对应 routing.default_outbound。
 * 设备访问控制只管按 MAC 的名单（lan_proxy_mac_addrs / lan_direct_mac_addrs），按 IP 的名单原样保留。
 */
import { probe, readFile, isIPv4, isIPv6, isHostname, isMac, toList as list, ignoreNotFound } from '@sight/sdk/lib';

/* 启动项操作走宿主自带的 sight 对象（sight-ui ≥ 0.5.0，包依赖已约束） */
const initAction = (client, name, action) => client.call('sight', 'setInitAction', { name, action });
import { parseShareLink } from './sharelink.js';
import { FILTER_MODES, nodesInUse, planFilter, validateFilter, parseStatus } from './subscription.js';
import { shapeCustom, planSettings, planTemplate, referrers, missingDeps, find, SECTION, OFF as CUSTOM_OFF, DIRECT, BLOCK } from './routing.js';

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
/* 节点延迟：rpcd 一次最多测 128 个，页面分批以便逐批显示 */
export const LATENCY_BATCH = 64;
/* 延迟快慢的分界（毫秒）：TCP 握手或 ping，到境外服务器 150 以内算快，350 以内一般 */
export const LATENCY_FAST = 150, LATENCY_FAIR = 350;
const LATENCY_FAILED = ['timeout', 'refused', 'unresolved', 'error'];
/** 纯函数：延迟结果 → 'fast' | 'fair' | 'slow' | 'failed'；未测、测试中、不支持为空串 */
export function latencyTone(l) {
	if (typeof l === 'number') return l <= LATENCY_FAST ? 'fast' : l <= LATENCY_FAIR ? 'fair' : 'slow';
	return LATENCY_FAILED.includes(l) ? 'failed' : '';
}
/** 纯函数：按延迟排序：有毫秒数的从快到慢，其后是失败的，最后是未测或不支持的；同档保持原顺序 */
export function sortByLatency(nodes, latency) {
	const key = n => { const l = latency[n.id]; return typeof l === 'number' ? [0, l] : [LATENCY_FAILED.includes(l) ? 1 : 2, 0]; };
	return [...nodes].sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1]; });
}
/** 纯函数：ping 输出 → 平均延迟（毫秒，取整）；全部丢包或格式不符返回 null */
export function parsePing(stdout) {
	const m = String(stdout || '').match(/min\/avg\/max(?:\/\w+)? = [\d.]+\/([\d.]+)\//);
	return m ? Math.max(1, Math.round(Number(m[1]))) : null;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
/** 纯函数：日志行开头的设备本地时间 → 可比较的 YYYYMMDDhhmmss；服务日志为 "2026-10-19 14:08:11 …"，系统日志为 "Mon Oct 19 14:08:11 2026 …" */
export function logTime(line) {
	let m = String(line).match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) /);
	if (m) return m.slice(1).join('');
	m = String(line).match(/^\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4}) /);
	return m && MONTHS.includes(m[1]) ? `${m[6]}${pad(MONTHS.indexOf(m[1]) + 1)}${pad(m[2])}${m[3]}${m[4]}${m[5]}` : '';
}
/** 去掉 sing-box 日志行的时间与级别前缀，只留错误内容 */
const errorText = line => line.replace(ANSI, '').replace(/^.*?\b(?:FATAL|ERROR)\[\d+\]\s*/, '').trim();
/**
 * 纯函数：代理开着但 sing-box 没在运行时找原因。
 * 服务日志（homeproxy.log）里最近一次启动失败（[DAEMON] Error: …，紧挨着的前几行是 generate_client.uc 或 sing-box check 的错误输出）
 * 晚于最近一次成功启动时，原因是配置生成或检查失败；否则取系统日志里这次启动之后 sing-box 的最后一条 FATAL（启动后退出，
 * procd 重试几次后放弃）。服务日志被清空、找不到启动记录时不比较时间。
 * @param {string | null} serviceLog @param {string[]} fatalLines sight.homeproxy client_errors 的返回
 * @returns {{ reason: 'generate' | 'check' | 'exited', detail: string, log: string } | null}
 */
export function diagnose(serviceLog, fatalLines = []) {
	const lines = String(serviceLog || '').replace(ANSI, '').split('\n');
	const failed = lines.findLastIndex(l => /\[DAEMON\] Error: .*client configuration/.test(l));
	const started = lines.findLastIndex(l => /\[DAEMON\] sing-box .* started\./.test(l));
	if (failed > started) {
		let i = failed;
		while (i > 0 && !logTime(lines[i - 1])) i--;
		const detail = lines.slice(i, failed).map(errorText).find(Boolean) || '';
		return { reason: /failed to generate/.test(lines[failed]) ? 'generate' : 'check', detail, log: 'homeproxy' };
	}
	const since = started >= 0 ? logTime(lines[started]) : '';
	const fatal = fatalLines.filter(l => / sing-box\[\d+\]: /.test(l) && /FATAL/.test(l) && logTime(l) >= since).at(-1);
	return fatal ? { reason: 'exited', detail: errorText(fatal), log: 'syslog' } : null;
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
		/* 订阅导入的节点带 grouphash，手工添加的没有；raw 供编辑表单读取全部选项 */
		subscribed: !!s.grouphash, grouphash: s.grouphash || '', raw: s,
	}));
	const mainNode = config.main_node && config.main_node !== OFF ? config.main_node : '';
	const instance = services?.homeproxy?.instances?.['sing-box-c'];
	const mode = config.routing_mode || 'bypass_mainland_china', custom = shapeCustom(cfg);
	return {
		/* 自定义模式下客户端是否启动取决于默认出站 */
		enabled: mode === 'custom' ? custom.defaultOutbound !== CUSTOM_OFF : !!mainNode, mainNode, mode, nodes, custom,
		used: [...nodesInUse(cfg)],
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
		filter: { mode: FILTER_MODES.includes(sub.filter_nodes) ? sub.filter_nodes : 'disabled', keywords: list(sub.filter_keywords), userAgent: sub.user_agent || '' },
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
	/* 自定义模式的出站与 DNS 在自定义分流里管理 */
	if (r.mode === 'custom') return e;
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

/**
 * 新建段的名字。不建匿名段：匿名段的名字（cfgXXXXXX）含它在文件里的位置，前面的段增删后就会变，
 * 主节点、出站、规则之间按段名互相引用，引用匿名段会悄悄失效。taken 为已有段名。
 */
export function sectionName(prefix, taken, random = () => crypto.getRandomValues(new Uint32Array(1))[0]) {
	for (;;) {
		const name = `${prefix}_${random().toString(16).padStart(8, '0')}`;
		if (!taken.includes(name)) return name;
	}
}
const PREFIX = { node: 'node', outbound: 'out', rule: 'rule', ruleset: 'ruleset', dns: 'dns', dnsRule: 'dnsrule' };

/** 纯函数：离开自定义模式时的主节点：代理开着就沿用默认出站的节点（或原主节点、第一个节点），关着则写 nil */
export function leaveCustomNode(data) {
	if (!data.enabled) return OFF;
	const out = find(data.custom, 'outbound', data.custom.defaultOutbound);
	const ids = data.nodes.map(n => n.id);
	return [out?.node, data.mainNode, ids[0]].find(id => id && ids.includes(id)) || OFF;
}

export function createHomeProxy(client, uci) {
	const drop = (config, section, options) => uci.remove(config, section, options).catch(ignoreNotFound);
	/* 写入一个具名的 homeproxy 节；旧配置里没有这一节时新建 */
	const setNamed = async (section, values) => {
		try { await uci.set('homeproxy', section, values); }
		catch (e) { ignoreNotFound(e); await uci.add('homeproxy', 'homeproxy', section, values); }
	};
	/* id 为空时新建，名字由 sectionName 生成 */
	const writeSection = async (type, id, { values, remove }, name) => {
		if (!id) { await uci.add('homeproxy', type, name, values); return; }
		await uci.set('homeproxy', id, values);
		if (remove.length) await drop('homeproxy', id, remove);
	};
	return {
		/** @returns {Promise<null | ReturnType<typeof shape> & { version: string, features: object }>} null = 未安装 */
		async load() {
			const features = await probe(client, 'sight.homeproxy', 'singbox_get_features');
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
		async importNodes(nodes, data) {
			const taken = [...data.custom.order];
			for (const n of nodes) {
				const name = sectionName(PREFIX.node, taken);
				taken.push(name);
				await uci.add('homeproxy', 'node', name, importValues(n, data));
			}
			return nodes.length;
		},
		/** 正在使用的节点（主节点、UDP 节点、自定义分流的出站）不删，避免服务引用不存在的节点 */
		async removeNode(id, data) {
			if (id === data.mainNode || id === data.udpNode || data.used?.includes(id)) throw new Error('This node is in use');
			await uci.remove('homeproxy', id);
		},
		/** 新建（id 为空）或按计划改写节点；计划来自 node.js 的 planNode */
		async saveNode(id, plan, data) { await writeSection('node', id, plan, id ? null : sectionName(PREFIX.node, data.custom.order)); },
		/** 批量删除（按订阅删除节点）；调用方已排除使用中的节点 */
		async removeNodes(ids, data) {
			if (ids.some(id => id === data.mainNode || id === data.udpNode || data.used.includes(id))) throw new Error('This node is in use');
			for (const id of ids) await uci.remove('homeproxy', id);
		},
		async saveFilter(f) {
			const errs = validateFilter(f);
			if (errs.length) throw new Error(errs[0]);
			const { values, remove } = planFilter(f);
			await uci.set('homeproxy', 'subscription', values);
			if (remove.length) await drop('homeproxy', 'subscription', remove);
		},

		/* --- 自定义分流 --- */
		/** kind 为 routing.js 的 SECTION 键；新建时 id 为空 */
		async saveCustom(kind, id, plan, custom) { await writeSection(SECTION[kind], id, plan, id ? null : sectionName(PREFIX[kind], custom.order)); },
		/** 被引用的对象不删、启用中被引用的不停用，引用的对象缺失或停用时不启用：都会让生成的配置通不过检查 */
		async removeCustom(kind, id, custom) {
			if (referrers(custom, kind, id).length) throw new Error('This item is in use');
			await uci.remove('homeproxy', id);
		},
		async toggleCustom(kind, id, on, custom) {
			if (!on && referrers(custom, kind, id, { enabledOnly: true }).length) throw new Error('This item is in use');
			if (on && missingDeps(custom, kind, find(custom, kind, id).raw).length) throw new Error('Something this item refers to is missing or turned off');
			await uci.set('homeproxy', id, { enabled: on ? '1' : '0' });
		},
		/** order 为全部段名的新顺序（routing.js 的 planOrder） */
		async reorder(order) { await client.call('uci', 'order', { config: 'homeproxy', sections: order }); },
		async saveCustomSettings(f, custom) {
			const { routing, dns } = planSettings(f, custom);
			await setNamed('routing', routing);
			await setNamed('dns', dns.values);
			if (dns.remove.length) await drop('homeproxy', 'dns', dns.remove);
		},
		/** 代理开关（自定义模式）：关闭时把默认出站存到 sight_last_outbound，打开时恢复 */
		async setCustomPower(on, custom) {
			if (on) {
				const first = custom.outbounds.find(o => o.enabled)?.id;
				const ok = id => id === DIRECT || id === BLOCK || !!find(custom, 'outbound', id)?.enabled;
				await setNamed('routing', { default_outbound: [custom.lastOutbound, first].find(id => id && ok(id)) || DIRECT });
			} else await setNamed('routing', { default_outbound: CUSTOM_OFF, sight_last_outbound: custom.defaultOutbound });
		},
		/**
		 * 切换到自定义模式。还没有任何出站时按模板建立初始配置（routing.js 的 planTemplate），
		 * 已有自定义配置则原样沿用，只让代理开关状态与切换前一致。
		 */
		async enterCustom(data, template, t) {
			const c = data.custom;
			if (!c.outbounds.length) {
				const node = data.mainNode || data.nodes[0]?.id;
				if (!node) throw new Error('Add a node first');
				const plan = planTemplate(template, { node, dnsServer: data.dnsServer, chinaDnsServer: data.chinaDnsServer, enabled: data.enabled, names: c.order, t });
				for (const a of plan.add) await uci.add('homeproxy', a.type, a.name, a.values);
				await setNamed('routing', plan.routing);
				await setNamed('dns', plan.dns);
			} else if (data.enabled && c.defaultOutbound === CUSTOM_OFF) {
				await this.setCustomPower(true, c);
			} else if (!data.enabled && c.defaultOutbound !== CUSTOM_OFF) {
				await this.setCustomPower(false, c);
			}
			await uci.set('homeproxy', 'config', { routing_mode: 'custom' });
		},
		/** 从自定义切回预设模式：主节点按 leaveCustomNode 定，再写模式、UDP 与 DNS */
		async leaveCustom(data, r) {
			await uci.set('homeproxy', 'config', { main_node: leaveCustomNode(data) });
			await this.saveRouting(r);
		},
		async saveSubscriptions(urls) {
			if (urls.length) await uci.set('homeproxy', 'subscription', { subscription_url: urls });
			else await drop('homeproxy', 'subscription', ['subscription_url']);
		},
		async saveSubscriptionOptions({ autoUpdate, viaProxy }) {
			await uci.set('homeproxy', 'subscription', { auto_update: autoUpdate ? '1' : '0', update_via_proxy: viaProxy ? '1' : '0' });
		},
		/** 按已生效的订阅地址拉取节点；脚本自行写入配置并重启服务。脚本总是正常退出，结果看它写的状态文件（subscriptionStatus） */
		async updateSubscriptions() {
			const r = await client.call('file', 'exec', { command: '/etc/homeproxy/scripts/update_subscriptions.uc', params: [] });
			return { ok: (r.code ?? 0) === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
		},
		/** @returns {Promise<ReturnType<typeof parseStatus>>} 最近一次订阅更新（含定时更新）的结果；还没更新过为 null */
		async subscriptionStatus() {
			const f = await readFile(client, '/etc/homeproxy/subscription_status.json');
			return f.state === 'ok' ? parseStatus(f.data) : null;
		},
		/** @returns {Promise<Record<string, string | null>>} 规则库版本；文件不存在为 null */
		async resourceVersions() {
			/* 插件在返回版本号的同时可能带着残留的 error 字段（上一次系统调用的 errno）：有版本号即以版本号为准。
			   读取失败向上抛，不当作未下载 */
			const r = await Promise.all(RESOURCES.map(type => client.call('sight.homeproxy', 'resources_get_version', { type })));
			return Object.fromEntries(RESOURCES.map((type, i) => [type, r[i]?.version || null]));
		},
		/** @returns {Promise<'updated' | 'failed' | 'busy' | 'latest'>} */
		async updateResource(type) {
			if (!RESOURCES.includes(type)) throw new Error('Unknown resource');
			const r = await client.call('sight.homeproxy', 'resources_update', { type });
			return UPDATE_RESULT[r?.status] || 'failed';
		},
		/** @returns {Promise<boolean>} 经代理访问该站点是否成功 */
		async check(site) {
			if (!SITES.includes(site)) throw new Error('Unknown site');
			const r = await client.call('sight.homeproxy', 'connection_check', { site });
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
			const r = await Promise.all(DOMAIN_LISTS.map(type => client.call('sight.homeproxy', 'acllist_read', { type })));
			return Object.fromEntries(DOMAIN_LISTS.map((type, i) => [type, parseDomains(r[i]?.content)]));
		},
		/** 写入有变化的列表（文件，不走暂存）；代理开着时重载服务让新列表生效，会短暂中断代理 */
		async saveDomainLists(lists, current, enabled) {
			for (const type of DOMAIN_LISTS) {
				const next = parseDomains(lists[type].join('\n'));
				if (validateDomains(next).length) throw new Error('Invalid domain');
				if (next.join('\n') === current[type].join('\n')) continue;
				const r = await client.call('sight.homeproxy', 'acllist_write', { type, content: next.join('\n') });
				if (r?.result === false) throw new Error(r.error || 'Request failed');
			}
			if (enabled) await initAction(client, 'homeproxy', 'reload');
		},
		/**
		 * 到节点服务器端口的 TCP 握手耗时：路由器直接连接（不经代理），反映服务器是否在线与线路远近，不代表代理速度。
		 * @param {string[]} ids 节点段名，最多 LATENCY_BATCH 个
		 * @returns {Promise<Record<string, number | 'timeout' | 'refused' | 'unresolved' | 'udp' | 'error'>>} 'udp' 为只走 UDP 的协议，改用 ping
		 */
		async latency(ids) {
			const r = await client.call('sight.homeproxy', 'node_latency', { nodes: ids });
			return r?.results || {};
		},
		/**
		 * 只走 UDP 的节点（Hysteria2、TUIC 等）改由路由器 ping 服务器地址。
		 * @returns {Promise<number | 'timeout' | 'unsupported'>} 毫秒；服务器不回应 ping 为 timeout；IPv6 地址暂不支持
		 */
		async ping(node) {
			if (!isIPv4(node.address) && !isHostname(node.address)) return 'unsupported';
			const r = await client.call('file', 'exec', { command: '/bin/ping', params: ['-4', '-c', '3', '-W', '1', node.address] });
			return parsePing(r.stdout) ?? 'timeout';
		},
		/** 代理开着但 sing-box 没运行时的原因（diagnose）；读不到日志时返回 null，不影响页面 */
		async diagnosis() {
			const [service, errors] = await Promise.all([this.log('homeproxy'), client.call('sight.homeproxy', 'client_errors')]);
			return diagnose(service, errors?.lines || []);
		},
		async cleanLog(name) {
			if (!LOGS.includes(name)) throw new Error('Unknown log');
			await client.call('sight.homeproxy', 'log_clean', { type: name });
		},
	};
}
