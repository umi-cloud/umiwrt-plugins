/*
 * 预设分流（非自定义模式）的纯函数：分流模式、UDP 节点、DNS，以及两种分流方式通用的走代理端口与 IPv6。
 * 走代理的端口（routing_port）：common 为 infra.common_port 里的常用端口，删除该项即全部端口，其余为逗号分隔的端口或范围；
 * 防火墙在分流判断之后按它过滤，自定义分流模式下同样生效。
 * IPv6（ipv6_support，缺省按关闭处理）：关闭时防火墙只接管 IPv4，代理的 DNS 只返回 IPv4 地址，直接发出的 IPv6 连接不经代理。
 */
import { OFF, SAME, URLTEST, CUSTOM, MODES, DNS_PRESETS, CHINA_DNS_PRESETS, PORT_CHOICES } from './constants.js';
import { find, parseDnsAddress } from './routing.js';

const portItems = v => String(v || '').split(',').map(p => p.trim()).filter(Boolean);
/** 纯函数：逗号分隔的端口或范围（如 443,8000-9000） */
export function isPortList(v) {
	const items = portItems(v);
	return items.length > 0 && items.every(p => {
		const m = p.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
		if (!m) return false;
		const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
		return a >= 1 && b <= 65535 && a <= b;
	});
}

/** DNS 地址：wan、IP 或主机名，也可带 sing-box 支持的协议前缀（tcp:// tls:// https:// h3:// quic://）与端口、路径 */
export const isDnsServer = v => String(v || '').trim() === 'wan' || !!parseDnsAddress(v);

/* --- 表单：预设项下拉 + 自定义输入 --- */
const choice = (presets, v) => presets.includes(v) ? v : 'custom';
/** 纯函数：页面数据 → 分流表单草稿 */
export function routingForm(d) {
	return {
		mode: d.mode, udpNode: d.udpNode, ports: d.ports, portsCustom: d.portsCustom, ipv6: d.ipv6,
		dns: choice(DNS_PRESETS, d.dnsServer), dnsCustom: choice(DNS_PRESETS, d.dnsServer) === 'custom' ? d.dnsServer : '',
		china: choice(CHINA_DNS_PRESETS, d.chinaDnsServer), chinaCustom: choice(CHINA_DNS_PRESETS, d.chinaDnsServer) === 'custom' ? d.chinaDnsServer : '',
	};
}
/** 纯函数：表单草稿 → 保存用的值 */
export function routingValues(f) {
	return { mode: f.mode, udpNode: f.udpNode, ports: f.ports, portsCustom: f.portsCustom, ipv6: f.ipv6,
		dnsServer: f.dns === 'custom' ? f.dnsCustom : f.dns, chinaDnsServer: f.china === 'custom' ? f.chinaCustom : f.china };
}
/** 纯函数：比较草稿用的键；没选用的自定义输入不算改动（切回预设项后输入框里留下的内容） */
export function routingKey(f) {
	return JSON.stringify({ ...f, dnsCustom: f.dns === 'custom' ? f.dnsCustom : '', chinaCustom: f.china === 'custom' ? f.chinaCustom : '', portsCustom: f.ports === 'custom' ? f.portsCustom : '' });
}

/** @returns {{ msg: string, field: string }[]} */
export function validateRouting(r, nodes) {
	const e = [];
	if (!MODES.includes(r.mode) && r.mode !== CUSTOM) e.push({ msg: 'Unknown routing mode', field: 'mode' });
	if (r.ports === 'custom' && !isPortList(r.portsCustom)) e.push({ msg: 'Enter ports such as 443 or 8000-9000, separated by commas', field: 'portsCustom' });
	/* 自定义模式的出站与 DNS 在自定义分流里管理 */
	if (r.mode === CUSTOM) return e;
	if (![SAME, OFF, URLTEST].includes(r.udpNode) && !nodes.some(n => n.id === r.udpNode)) e.push({ msg: 'Choose a UDP node', field: 'udpNode' });
	if (!isDnsServer(r.dnsServer)) e.push({ msg: 'Invalid DNS server', field: 'dnsCustom' });
	if (r.mode === 'bypass_mainland_china' && !isDnsServer(r.chinaDnsServer)) e.push({ msg: 'Invalid China DNS server', field: 'chinaCustom' });
	return e;
}

/* --- 写入计划 --- */
/** 纯函数：走代理端口的写入计划；全部端口即删除 routing_port */
export function planPorts(choice, custom) {
	if (choice === 'all') return { values: {}, remove: ['routing_port'] };
	return { values: { routing_port: choice === 'common' ? 'common' : portItems(custom).join(',') }, remove: [] };
}
/** 纯函数：端口与 IPv6（两种分流方式通用）的写入计划 */
export function planTraffic(r) {
	if (!PORT_CHOICES.includes(r.ports)) throw new Error('Unknown port choice');
	if (r.ports === 'custom' && !isPortList(r.portsCustom)) throw new Error('Invalid port list');
	const plan = planPorts(r.ports, r.portsCustom);
	if (typeof r.ipv6 === 'boolean') plan.values.ipv6_support = r.ipv6 ? '1' : '0';
	return plan;
}
/** 纯函数：预设分流模式下模式、UDP、DNS 的写入值 */
export function planRouting(r) {
	const values = { main_udp_node: r.udpNode, dns_server: r.dnsServer.trim() };
	if (MODES.includes(r.mode)) values.routing_mode = r.mode;
	if (r.mode === 'bypass_mainland_china') values.china_dns_server = r.chinaDnsServer.trim();
	return values;
}

/** 纯函数：离开自定义模式时的主节点：代理开着就沿用默认出站的节点（或原主节点、第一个节点），关着则写 nil */
export function leaveCustomNode(data) {
	if (!data.enabled) return OFF;
	const out = find(data.custom, 'outbound', data.custom.defaultOutbound);
	const ids = data.nodes.map(n => n.id);
	return [out?.node, data.mainNode, ids[0]].find(id => id && ids.includes(id)) || OFF;
}
