/*
 * HomeProxy（sing-box 客户端）的 Sight 页面取数服务：读配置与服务状态（shape）、调用 rpcd 与 uci 写入。
 * 纯函数按职责分在各模块：constants（取值）、traffic（分流/端口/IPv6）、resources（规则库、域名列表）、latency、diagnose、
 * core（核心更新）、access（设备）、node（节点表单）、routing（自定义分流）、subscription（订阅）、sharelink（分享链接）。
 * 配置写入会话暂存（页面保存后立即带回滚应用）；订阅/规则库更新、连通性检查、清空日志、重启为即时操作。
 * 关闭代理即 main_node = 'nil'；自定义分流模式下主节点不生效，开关对应 routing.default_outbound。服务端不在页面范围内。
 */
import { probe, readFile, isIPv4, isHostname, isMac, toList as list, ignoreNotFound } from '@sight/sdk/lib';
import { OFF, SAME, CUSTOM, DEFAULT_MODE, DEFAULT_DNS, DEFAULT_CHINA_DNS, DEFAULT_COMMON_PORTS, DEFAULT_LOG_LEVEL, LOGS, SITES, ACCESS, DEVICE_RULES, RESOURCES, DOMAIN_LISTS, LOG_LEVELS } from './constants.js';
import { planRouting, planTraffic, leaveCustomNode } from './traffic.js';
import { parseDomains, validDomains, changedLists, updateResult } from './resources.js';
import { parsePing } from './latency.js';
import { diagnose } from './diagnose.js';
import { coreUpdateState } from './core.js';
import { planAccess, planDeviceRules } from './access.js';
import { parseShareLink } from './sharelink.js';
import { FILTER_MODES, nodesInUse, nodeInUse, planFilter, validateFilter, parseStatus } from './subscription.js';
import { shapeCustom, planSettings, planTemplate, referrers, missingDeps, find, SECTION, DIRECT, BLOCK } from './routing.js';

/* 启动项操作走宿主自带的 sight 对象（sight-ui ≥ 0.5.0，包依赖已约束） */
const initAction = (client, name, action) => client.call('sight', 'setInitAction', { name, action });
const PREFIX = { node: 'node', outbound: 'out', rule: 'rule', ruleset: 'ruleset', dns: 'dns', dnsRule: 'dnsrule' };

/** 纯函数：uci 配置 + 服务状态 → 页面数据 */
export function shape(cfg, services) {
	const config = cfg.config || {}, control = cfg.control || {}, sub = cfg.subscription || {};
	const nodes = Object.values(cfg).filter(s => s['.type'] === 'node').map(s => ({
		id: s['.name'], label: s.label || s['.name'], type: s.type || '', address: s.address || '', port: s.port || '',
		/* 订阅导入的节点带 grouphash，手工添加的没有；raw 供编辑表单读取全部选项 */
		grouphash: s.grouphash || '', raw: s,
	}));
	const mainNode = config.main_node && config.main_node !== OFF ? config.main_node : '';
	const nodeIds = new Set(nodes.map(n => n.id));
	const instance = services?.homeproxy?.instances?.['sing-box-c'];
	const mode = config.routing_mode || DEFAULT_MODE, custom = shapeCustom(cfg);
	const macs = key => list(control[key]).map(m => m.toUpperCase());
	return {
		/* 自定义模式下客户端是否启动取决于默认出站 */
		enabled: mode === CUSTOM ? custom.defaultOutbound !== OFF : !!mainNode, mainNode, mode, nodes, custom,
		/* 关闭代理时记住的主节点（config.sight_last_node，HomeProxy 不读这个键），再打开时沿用；节点已不存在则忽略 */
		lastNode: nodeIds.has(config.sight_last_node) ? config.sight_last_node : '',
		/* 主节点为自动选择时参与测速的节点 */
		urltestNodes: list(config.main_urltest_nodes).filter(id => nodeIds.has(id)),
		used: [...nodesInUse(cfg)],
		/* 后端缺省为 nil（UDP 直连），不是 same */
		udpNode: config.main_udp_node || OFF,
		dnsServer: config.dns_server || DEFAULT_DNS, chinaDnsServer: config.china_dns_server || DEFAULT_CHINA_DNS,
		access: {
			mode: ACCESS.includes(control.lan_proxy_mode) ? control.lan_proxy_mode : 'disabled',
			proxyMacs: macs('lan_proxy_mac_addrs'), directMacs: macs('lan_direct_mac_addrs'),
			gamingMacs: macs('lan_gaming_mode_mac_addrs'), globalMacs: macs('lan_global_proxy_mac_addrs'),
		},
		ports: !config.routing_port ? 'all' : config.routing_port === 'common' ? 'common' : 'custom',
		portsCustom: config.routing_port && config.routing_port !== 'common' ? config.routing_port : '',
		commonPorts: cfg.infra?.common_port || DEFAULT_COMMON_PORTS,
		logLevel: config.log_level || DEFAULT_LOG_LEVEL,
		ipv6: config.ipv6_support === '1',
		subscriptions: list(sub.subscription_url),
		autoUpdate: sub.auto_update === '1', viaProxy: sub.update_via_proxy === '1',
		/* 订阅设置里的「允许不安全」「包编码」同样作用于手工导入（与上游 HomeProxy 一致） */
		importSettings: { allowInsecure: sub.allow_insecure === '1', packetEncoding: sub.packet_encoding || 'xudp' },
		filter: { mode: FILTER_MODES.includes(sub.filter_nodes) ? sub.filter_nodes : 'disabled', keywords: list(sub.filter_keywords), userAgent: sub.user_agent || '' },
		/* 服务状态取不到时为 null，不当作未运行 */
		running: services == null ? null : !!instance?.running,
	};
}

/** @returns {{ msg: string, field: string }[]} */
export function validateSubscriptions(urls) {
	return urls.every(u => /^https?:\/\/\S+$/i.test(u)) ? [] : [{ msg: 'Subscription addresses must start with http:// or https://', field: 'subscriptions' }];
}

/** 纯函数：多行分享链接 → 逐行解析结果（去重、忽略空行） */
export function previewLinks(text, features) {
	const links = [...new Set(String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean))];
	return links.map(link => ({ link, node: parseShareLink(link, features) }));
}

/** 纯函数：导入节点的最终选项（importSettings 见 shape） */
export function importValues(node, { allowInsecure, packetEncoding }) {
	const v = { ...node };
	if (v.tls === '1' && allowInsecure) v.tls_insecure = '1';
	if (['vless', 'vmess'].includes(v.type) && packetEncoding) v.packet_encoding = packetEncoding;
	return v;
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

/** 纯函数：批量导入的写入计划：每个节点取一个不重复的段名 */
export function planImport(nodes, settings, taken, random) {
	const names = [...taken];
	return nodes.map(n => { const name = sectionName(PREFIX.node, names, random); names.push(name); return { name, values: importValues(n, settings) }; });
}

export function createHomeProxy(client, uci) {
	const CONFIG = 'homeproxy';
	const drop = (section, options) => uci.remove(CONFIG, section, options).catch(ignoreNotFound);
	const apply = async (section, { values, remove }) => {
		if (Object.keys(values).length) await uci.set(CONFIG, section, values);
		if (remove.length) await drop(section, remove);
	};
	/* 写入一个具名的 homeproxy 节；旧配置里没有这一节时新建 */
	const setNamed = async (section, values) => {
		try { await uci.set(CONFIG, section, values); }
		catch (e) { ignoreNotFound(e); await uci.add(CONFIG, 'homeproxy', section, values); }
	};
	/* id 为空时新建，名字由调用方生成 */
	const writeSection = async (type, id, plan, name) => {
		if (!id) { await uci.add(CONFIG, type, name, plan.values); return; }
		await apply(id, plan);
	};
	const call = (method, args = {}) => client.call('sight.homeproxy', method, args);

	/** 走代理的端口与 IPv6，两种分流方式通用；自定义分流模式下单独保存 */
	const saveTraffic = r => apply('config', planTraffic(r));
	/** 预设分流模式下的模式、UDP、DNS，连同端口与 IPv6 */
	const saveRouting = async (r) => {
		await uci.set(CONFIG, 'config', planRouting(r));
		if (r.ports) await saveTraffic(r);
	};
	/** 代理开关（自定义模式）：关闭时把默认出站存到 sight_last_outbound，打开时恢复 */
	const setCustomPower = async (on, custom) => {
		if (on) {
			const first = custom.outbounds.find(o => o.enabled)?.id;
			const ok = id => id === DIRECT || id === BLOCK || !!find(custom, 'outbound', id)?.enabled;
			await setNamed('routing', { default_outbound: [custom.lastOutbound, first].find(id => id && ok(id)) || DIRECT });
		} else await setNamed('routing', { default_outbound: OFF, sight_last_outbound: custom.defaultOutbound });
	};
	/** @returns {Promise<string | null>} null = 日志文件不存在（服务未运行过） */
	const readLog = async (name) => {
		if (!LOGS.includes(name)) throw new Error('Unknown log');
		const f = await readFile(client, `/var/run/homeproxy/${name}.log`);
		return f.state === 'ok' ? f.data : null;
	};

	return {
		/** @returns {Promise<null | ReturnType<typeof shape> & { version: string, features: object }>} null = 未安装 */
		async load() {
			const features = await probe(client, 'sight.homeproxy', 'singbox_get_features');
			if (!features) return null;
			const [cfg, services] = await Promise.all([uci.load(CONFIG), client.call('service', 'list', { name: 'homeproxy' }).catch(() => null)]);
			return { ...shape(cfg, services), version: features.version || '', features };
		},

		/* --- 开关与主节点 --- */
		async useNode(id) { await uci.set(CONFIG, 'config', { main_node: id }); },
		/** 关闭时记住当前主节点，再打开时沿用（页面按 data.lastNode 取） */
		async turnOff(current) { await uci.set(CONFIG, 'config', current ? { main_node: OFF, sight_last_node: current } : { main_node: OFF }); },
		setCustomPower,

		/* --- 分流 --- */
		saveRouting,
		saveTraffic,
		/**
		 * 切换到自定义模式。还没有任何出站时按模板建立初始配置（routing.js 的 planTemplate），
		 * 已有自定义配置则原样沿用，只让代理开关状态与切换前一致。
		 */
		async enterCustom(data, template, t) {
			const c = data.custom;
			if (!c.outbounds.length) {
				const node = data.mainNode || data.nodes[0]?.id;
				if (!node) throw new Error('Add a node first');
				const plan = planTemplate(template, { node, urltestNodes: data.urltestNodes, dnsServer: data.dnsServer, chinaDnsServer: data.chinaDnsServer, enabled: data.enabled, ipv6: data.ipv6, names: c.order, t });
				for (const a of plan.add) await uci.add(CONFIG, a.type, a.name, a.values);
				await setNamed('routing', plan.routing);
				await setNamed('dns', plan.dns);
			} else if (data.enabled !== (c.defaultOutbound !== OFF)) {
				await setCustomPower(data.enabled, c);
			}
			await uci.set(CONFIG, 'config', { routing_mode: CUSTOM });
		},
		/** 从自定义切回预设模式：主节点按 leaveCustomNode 定，再写模式、UDP 与 DNS */
		async leaveCustom(data, r) {
			await uci.set(CONFIG, 'config', { main_node: leaveCustomNode(data) });
			await saveRouting(r);
		},
		async setLogLevel(level) {
			if (!LOG_LEVELS.includes(level)) throw new Error('Unknown log level');
			await uci.set(CONFIG, 'config', { log_level: level });
		},

		/* --- 设备 --- */
		async saveAccess(mode, macs) {
			if (!macs.every(isMac)) throw new Error('Invalid MAC address');
			await apply('control', planAccess(mode, macs.map(m => m.toUpperCase())));
		},
		async saveDeviceRules(rules) {
			if (!rules.every(r => isMac(r.mac) && DEVICE_RULES.includes(r.rule))) throw new Error('Invalid device rule');
			await apply('control', planDeviceRules(rules));
		},

		/* --- 节点 --- */
		/** @returns {Promise<number>} 写入暂存的节点数 */
		async importNodes(nodes, data) {
			for (const { name, values } of planImport(nodes, data.importSettings, data.custom.order)) await uci.add(CONFIG, 'node', name, values);
			return nodes.length;
		},
		/** 新建（id 为空）或按计划改写节点；计划来自 node.js 的 planNode */
		async saveNode(id, plan, data) { await writeSection('node', id, plan, id ? null : sectionName(PREFIX.node, data.custom.order)); },
		/** 正在使用的节点（主节点、UDP 节点、自定义分流的出站）不删，避免服务引用不存在的节点 */
		async removeNodes(ids, data) {
			if (ids.some(id => nodeInUse(data, id))) throw new Error('This node is in use');
			for (const id of ids) await uci.remove(CONFIG, id);
		},

		/* --- 自定义分流 --- */
		/** kind 为 routing.js 的 SECTION 键；新建时 id 为空 */
		async saveCustom(kind, id, plan, custom) { await writeSection(SECTION[kind], id, plan, id ? null : sectionName(PREFIX[kind], custom.order)); },
		/** 被引用的对象不删、启用中被引用的不停用，引用的对象缺失或停用时不启用：都会让生成的配置通不过检查 */
		async removeCustom(kind, id, custom) {
			if (referrers(custom, kind, id).length) throw new Error('This item is in use');
			await uci.remove(CONFIG, id);
		},
		async toggleCustom(kind, id, on, custom) {
			if (!on && referrers(custom, kind, id, { enabledOnly: true }).length) throw new Error('This item is in use');
			if (on && missingDeps(custom, kind, find(custom, kind, id).raw).length) throw new Error('Something this item refers to is missing or turned off');
			await uci.set(CONFIG, id, { enabled: on ? '1' : '0' });
		},
		/** order 为全部段名的新顺序（routing.js 的 planOrder） */
		async reorder(order) { await client.call('uci', 'order', { config: CONFIG, sections: order }); },
		async saveCustomSettings(f, custom) {
			const { routing, dns } = planSettings(f, custom);
			await setNamed('routing', routing);
			await setNamed('dns', dns.values);
			if (dns.remove.length) await drop('dns', dns.remove);
		},

		/* --- 订阅 --- */
		async saveSubscriptions(urls) {
			if (urls.length) await uci.set(CONFIG, 'subscription', { subscription_url: urls });
			else await drop('subscription', ['subscription_url']);
		},
		async saveSubscriptionOptions({ autoUpdate, viaProxy }) {
			await uci.set(CONFIG, 'subscription', { auto_update: autoUpdate ? '1' : '0', update_via_proxy: viaProxy ? '1' : '0' });
		},
		async saveFilter(f) {
			const errs = validateFilter(f);
			if (errs.length) throw new Error(errs[0].msg);
			await apply('subscription', planFilter(f));
		},
		/** 开始更新订阅（后台任务，脚本自行写入配置并重启服务）；@returns {Promise<boolean>} 已有更新进行中时为 false */
		async startSubscriptionUpdate() { return (await call('subscription_start'))?.started !== false; },
		/** @returns {Promise<boolean>} 更新是否仍在进行 */
		async subscriptionUpdating() { return !!(await call('subscription_task'))?.running; },
		/** @returns {Promise<ReturnType<typeof parseStatus>>} 最近一次订阅更新（含定时更新）的结果；还没更新过为 null */
		async subscriptionStatus() {
			const f = await readFile(client, '/etc/homeproxy/subscription_status.json');
			return f.state === 'ok' ? parseStatus(f.data) : null;
		},

		/* --- 规则库与域名列表 --- */
		/** @returns {Promise<Record<string, string | null>>} 规则库版本；文件不存在为 null。读取失败向上抛，不当作未下载 */
		async resourceVersions() {
			const r = await Promise.all(RESOURCES.map(type => call('resources_get_version', { type })));
			return Object.fromEntries(RESOURCES.map((type, i) => [type, r[i]?.version || null]));
		},
		/** @returns {Promise<'updated' | 'failed' | 'busy' | 'latest'>} */
		async updateResource(type) {
			if (!RESOURCES.includes(type)) throw new Error('Unknown resource');
			return updateResult(await call('resources_update', { type }));
		},
		/** @returns {Promise<{ proxy_list: string[], direct_list: string[] }>} */
		async domainLists() {
			const r = await Promise.all(DOMAIN_LISTS.map(type => call('acllist_read', { type })));
			return Object.fromEntries(DOMAIN_LISTS.map((type, i) => [type, parseDomains(r[i]?.content)]));
		},
		/** 写入有变化的列表（文件，不走暂存）；代理开着时重载服务让新列表生效，会短暂中断代理 */
		async saveDomainLists(lists, current, enabled) {
			if (!DOMAIN_LISTS.every(k => validDomains(lists[k]))) throw new Error('Invalid domain');
			for (const type of changedLists(lists, current)) {
				const r = await call('acllist_write', { type, content: lists[type].join('\n') });
				if (r?.result === false) throw new Error(r.error || 'Request failed');
			}
			if (enabled) await initAction(client, 'homeproxy', 'reload');
		},

		/* --- 状态与诊断 --- */
		/** @returns {Promise<boolean>} 经代理访问该站点是否成功 */
		async checkSite(site) {
			if (!SITES.includes(site)) throw new Error('Unknown site');
			return !!(await call('connection_check', { site }))?.result;
		},
		/**
		 * @param {string[]} ids 节点段名，最多 LATENCY_BATCH 个
		 * @returns {Promise<Record<string, number | 'timeout' | 'refused' | 'unresolved' | 'udp' | 'error'>>} 'udp' 为只走 UDP 的协议，改用 ping
		 */
		async measureLatency(ids) { return (await call('node_latency', { nodes: ids }))?.results || {}; },
		/** 只走 UDP 的节点由路由器 ping 服务器地址。@returns {Promise<number | 'timeout' | 'unsupported'>} IPv6 地址不支持 */
		async ping(node) {
			if (!isIPv4(node.address) && !isHostname(node.address)) return 'unsupported';
			const r = await client.call('file', 'exec', { command: '/bin/ping', params: ['-4', '-c', '3', '-W', '1', node.address] });
			return parsePing(r.stdout) ?? 'timeout';
		},
		readLog,
		/** 代理开着但 sing-box 没运行时的原因（diagnose）；找不到原因时为 null */
		async readDiagnosis() {
			const [service, errors] = await Promise.all([readLog('homeproxy'), call('client_errors')]);
			return diagnose(service, errors?.lines || []);
		},
		async clearLog(name) {
			if (!LOGS.includes(name)) throw new Error('Unknown log');
			await call('log_clean', { type: name });
		},

		/* --- sing-box 核心 --- */
		/** @returns {Promise<{ running: boolean, uptime?: number | null, memory?: number | null }>} 运行时长（秒）与内存（字节） */
		async clientStatus() { return await call('client_status') || { running: false }; },
		/** @returns {Promise<ReturnType<typeof coreUpdateState>>} */
		async readCoreTask() { return coreUpdateState(await call('core_task')); },
		/** 开始检查（check）或更新（upgrade）；后台进行，之后用 readCoreTask 轮询。@returns {Promise<boolean>} 已有任务进行中时为 false */
		async startCoreTask(action) {
			if (!['check', 'upgrade'].includes(action)) throw new Error('Unknown action');
			return (await call('core_start', { action }))?.started !== false;
		},
		/** 重启 HomeProxy（即时操作，代理中断几秒） */
		async restart() {
			const r = await initAction(client, 'homeproxy', 'restart');
			if (r?.result === false) throw new Error('Restart failed');
		},
	};
}
