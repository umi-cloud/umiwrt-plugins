/*
 * 自定义分流（routing_mode = custom）的纯函数：读取、表单、写入计划、校验与引用检查、排序、初始模板。
 * 段与键以 generate_client.uc 自定义分支实际读取的为准：
 *   routing：default_outbound（'nil' 即不启动客户端）、default_outbound_dns；dns：default_server、default_strategy
 *   routing_node（出站）：enabled、node（节点或 'urltest'）、outbound（链式代理的上游出站）、urltest_*
 *   routing_rule / dns_rule（按段顺序匹配）：enabled、匹配条件、action、outbound / server、rule_set
 *   ruleset：enabled、type（remote/local）、format、url / path、outbound（下载用）、update_interval
 *   dns_server：enabled、type、server、server_port、path、tls_sni、address_resolver、outbound
 * 生成配置时引用的出站、规则集、DNS 服务器必须存在且已启用，否则 sing-box 检查失败、服务起不来：
 * 停用或删除被引用的对象前先检查引用（referrers），整体问题由 problems() 汇总提示。
 * 关闭代理时把默认出站暂存到 routing.sight_last_outbound（HomeProxy 不读这个键），再打开时恢复。
 */
import { isIPv4, isIPv6, isCidr, isHostname, toList } from '@sight/sdk/lib';

export const OFF = 'nil', DIRECT = 'direct-out', BLOCK = 'block-out';
/* 规则目标：阻断（action reject）；保持原有动作（route-options、resolve 等，页面不管理） */
export const BLOCK_TARGET = 'block', KEEP_TARGET = 'keep';
export const BUILTIN_DNS = ['default-dns', 'system-dns'];
export const DNS_TYPES = ['udp', 'tcp', 'tls', 'https', 'h3', 'quic'];
export const STRATEGIES = ['', 'prefer_ipv4', 'prefer_ipv6', 'ipv4_only', 'ipv6_only'];
export const NETWORKS = ['', 'tcp', 'udp'];
export const SECTION = { outbound: 'routing_node', rule: 'routing_rule', ruleset: 'ruleset', dns: 'dns_server', dnsRule: 'dns_rule' };
const LIST = { outbound: 'outbounds', rule: 'rules', ruleset: 'rulesets', dns: 'dnsServers', dnsRule: 'dnsRules' };

/* 生成配置时会输出的匹配条件；页面只编辑其中常用的几项，其余原样保留并在摘要里提示 */
const RULE_CONDITIONS = ['ip_version', 'protocol', 'network', 'domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'source_ip_cidr', 'source_ip_is_private',
	'ip_cidr', 'ip_is_private', 'source_port', 'source_port_range', 'port', 'port_range', 'process_name', 'process_path', 'process_path_regex', 'user', 'rule_set'];
const DNS_CONDITIONS = ['ip_version', 'query_type', 'network', 'protocol', 'domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'port', 'port_range',
	'source_ip_cidr', 'source_ip_is_private', 'ip_cidr', 'ip_is_private', 'source_port', 'source_port_range', 'process_name', 'process_path', 'process_path_regex', 'user', 'rule_set'];
const RULE_FIELDS = { domain_suffix: 'list', domain: 'list', domain_keyword: 'list', ip_cidr: 'list', source_ip_cidr: 'list', port: 'list', rule_set: 'list', network: 'string', ip_is_private: 'bool', invert: 'bool' };
const DNS_RULE_FIELDS = { domain_suffix: 'list', domain: 'list', domain_keyword: 'list', source_ip_cidr: 'list', rule_set: 'list', invert: 'bool' };
/* 只对 route 动作有意义的选项：改成阻断时删掉，避免 sing-box 严格解析报错 */
const ROUTE_KEYS = ['override_address', 'override_port', 'udp_disable_domain_unmapping', 'udp_connect', 'udp_timeout', 'tls_fragment', 'tls_fragment_fallback_delay', 'tls_record_fragment'];
const DNS_ROUTE_KEYS = ['domain_strategy', 'dns_disable_cache', 'rewrite_ttl', 'client_subnet'];
const DNS_REJECT_KEYS = ['reject_method', 'reject_no_drop'];
const DNS_PREDEFINED_KEYS = ['predefined_rcode', 'predefined_answer', 'predefined_ns', 'predefined_extra'];

/* 初始模板用的规则集，与 generate_client.uc 的「国内直连」模式同源 */
export const GEO = {
	geosite_cn: 'https://fastly.jsdelivr.net/gh/1715173329/sing-geosite@rule-set-unstable/geosite-geolocation-cn.srs',
	geoip_cn: 'https://fastly.jsdelivr.net/gh/1715173329/IPCIDR-CHINA@rule-set/cn.srs',
};
export const TEMPLATES = ['bypass_china', 'global', 'blank'];

const has = v => Array.isArray(v) ? v.length > 0 : v != null && v !== '';
const byIndex = (a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0);
const ordered = (cfg, type) => Object.values(cfg).filter(s => s['.type'] === type).sort(byIndex);
const base = s => ({ id: s['.name'], label: s.label || s['.name'], enabled: s.enabled === '1', raw: s });

/** 规则的去向：阻断、保持、或出站 id（含 direct-out）；旧配置里 outbound = block-out 也算阻断 */
export function ruleTarget(s) {
	const action = s.action || 'route';
	if (action === 'reject' || (action === 'route' && s.outbound === BLOCK)) return BLOCK_TARGET;
	return action === 'route' ? (s.outbound || '') : KEEP_TARGET;
}
export function dnsTarget(s) {
	const action = s.action || 'route';
	return action === 'reject' ? BLOCK_TARGET : action === 'route' ? (s.server || '') : KEEP_TARGET;
}

/** 纯函数：uci 配置 → 自定义分流数据（各列表按段顺序） */
export function shapeCustom(cfg) {
	const routing = cfg.routing || {}, dns = cfg.dns || {};
	return {
		defaultOutbound: routing.default_outbound || OFF, lastOutbound: routing.sight_last_outbound || '',
		outboundDns: routing.default_outbound_dns || 'default-dns', defaultDns: dns.default_server || 'default-dns', strategy: dns.default_strategy || '',
		outbounds: ordered(cfg, 'routing_node').map(s => ({ ...base(s), node: s.node || '', detour: s.outbound || '', urltest: toList(s.urltest_nodes) })),
		rules: ordered(cfg, 'routing_rule').map(s => ({ ...base(s), target: ruleTarget(s) })),
		rulesets: ordered(cfg, 'ruleset').map(s => ({ ...base(s), type: s.type || 'remote', source: s.type === 'local' ? s.path || '' : s.url || '', outbound: s.outbound || '' })),
		dnsServers: ordered(cfg, 'dns_server').map(s => ({ ...base(s), address: formatDnsAddress(s), outbound: s.outbound || '', resolver: s.address_resolver || '' })),
		dnsRules: ordered(cfg, 'dns_rule').map(s => ({ ...base(s), target: dnsTarget(s) })),
		/* 全部段名按配置里的顺序，排序时只在同类段占的位置之间调换 */
		order: Object.values(cfg).sort(byIndex).map(s => s['.name']),
	};
}

/** 纯函数：规则已有的匹配条件 [[键, 值数组]]，摘要用 */
export function conditions(raw, dns = false) {
	return (dns ? DNS_CONDITIONS : RULE_CONDITIONS).filter(k => has(raw[k])).map(k => [k, toList(raw[k])]);
}

/* --- DNS 地址：页面用一个地址串表示 type/server/server_port/path --- */
const isPort = v => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
/** 8.8.8.8、tls://1.1.1.1、https://dns.google/dns-query、quic://[2606:4700::1111]:853 → 各字段；无效返回 null */
export function parseDnsAddress(value, fallback = 'udp') {
	const v = String(value || '').trim();
	if (!v) return null;
	if (isIPv6(v)) return { type: fallback, server: v, port: '', path: '' };
	const m = v.match(/^([a-z0-9]+):\/\/(.*)$/i);
	const type = m ? m[1].toLowerCase() : fallback, rest = m ? m[2] : v;
	if (!DNS_TYPES.includes(type)) return null;
	const hm = rest.match(/^(\[[^\]]+\]|[^/:[\]?#@]+)(?::(\d+))?(\/[^?#\s]*)?$/);
	if (!hm) return null;
	const server = hm[1].replace(/^\[|\]$/g, ''), port = hm[2] || '', path = hm[3] && hm[3] !== '/' ? hm[3] : '';
	if (!(isIPv4(server) || isIPv6(server) || isHostname(server))) return null;
	if (/^\[/.test(hm[1]) !== isIPv6(server)) return null;
	if (port && !isPort(port)) return null;
	if (path && !['https', 'h3'].includes(type)) return null;
	return { type, server, port, path };
}
export function formatDnsAddress(s) {
	if (!s.server) return s.address || '';
	const type = s.type || 'udp', port = s.server_port ? `:${s.server_port}` : '', path = s.path || '';
	if (type === 'udp' && !port && !path) return s.server;
	return `${type}://${isIPv6(s.server) ? `[${s.server}]` : s.server}${port}${path}`;
}

/* --- 表单 --- */
/* 列表复制一份，表单不能改到页面数据 */
const fill = (fields, raw) => Object.fromEntries(Object.entries(fields).map(([k, kind]) => [k, kind === 'list' ? [...toList(raw[k])] : kind === 'bool' ? raw[k] === '1' : raw[k] || '']));
export const ruleForm = (raw = {}) => ({ label: raw.label || '', enabled: raw.enabled ? raw.enabled === '1' : true, target: raw['.name'] ? ruleTarget(raw) : '', ...fill(RULE_FIELDS, raw) });
export const dnsRuleForm = (raw = {}) => ({ label: raw.label || '', enabled: raw.enabled ? raw.enabled === '1' : true, target: raw['.name'] ? dnsTarget(raw) : '', ...fill(DNS_RULE_FIELDS, raw) });
export const outboundForm = (raw = {}) => ({ label: raw.label || '', enabled: raw.enabled ? raw.enabled === '1' : true, node: raw.node || '', detour: raw.outbound || '',
	urltest_nodes: [...toList(raw.urltest_nodes)], urltest_url: raw.urltest_url || '', urltest_interval: raw.urltest_interval || '', urltest_tolerance: raw.urltest_tolerance || '' });
export const rulesetForm = (raw = {}) => ({ label: raw.label || '', enabled: raw.enabled ? raw.enabled === '1' : true, type: raw.type || 'remote', format: raw.format || 'binary',
	url: raw.url || '', path: raw.path || '', outbound: raw.outbound || '', update_interval: raw.update_interval || '' });
export const dnsForm = (raw = {}) => ({ label: raw.label || '', enabled: raw.enabled ? raw.enabled === '1' : true, address: raw['.name'] ? formatDnsAddress(raw) : '',
	outbound: raw.outbound || DIRECT, resolver: raw.address_resolver || '', tls_sni: raw.tls_sni || '' });
export function settingsForm(c) {
	const on = c.defaultOutbound !== OFF;
	return { defaultOutbound: on ? c.defaultOutbound : c.lastOutbound || DIRECT, defaultDns: c.defaultDns, outboundDns: c.outboundDns, strategy: c.strategy };
}
/** 规则集格式：.json 为源文件，其余（.srs）为二进制 */
export const guessFormat = url => /\.json(\?.*)?$/i.test(String(url || '').trim()) ? 'source' : 'binary';

/* --- 写入计划：只写表单管理的键；值为空时删除已有选项 --- */
function planFields(fields, f, raw, values, remove, only) {
	for (const [k, kind] of Object.entries(fields)) {
		const exists = has(raw[k]);
		if (only && !only.includes(k)) { if (exists) remove.add(k); continue; }
		if (kind === 'list') {
			const v = f[k].map(x => String(x).trim()).filter(Boolean);
			if (v.length) values[k] = v; else if (exists) remove.add(k);
		} else if (kind === 'bool') {
			if (f[k]) values[k] = '1'; else if (exists && raw[k] !== '0') remove.add(k);
		} else {
			const v = String(f[k] ?? '').trim();
			if (v) values[k] = v; else if (exists) remove.add(k);
		}
	}
}
const dropKeys = (raw, keys, remove) => keys.forEach(k => { if (has(raw[k])) remove.add(k); });
const result = (values, remove) => ({ values, remove: [...remove] });
const head = f => ({ label: f.label.trim(), enabled: f.enabled ? '1' : '0' });

export function planRule(f, raw = {}) {
	const values = head(f), remove = new Set();
	planFields(RULE_FIELDS, f, raw, values, remove);
	if (f.target === BLOCK_TARGET) { values.action = 'reject'; dropKeys(raw, ['outbound', ...ROUTE_KEYS], remove); }
	else if (f.target !== KEEP_TARGET) { values.action = 'route'; values.outbound = f.target; }
	return result(values, remove);
}
export function planDnsRule(f, raw = {}) {
	const values = head(f), remove = new Set();
	planFields(DNS_RULE_FIELDS, f, raw, values, remove);
	if (f.target === BLOCK_TARGET) { values.action = 'reject'; dropKeys(raw, ['server', ...DNS_ROUTE_KEYS, ...DNS_PREDEFINED_KEYS], remove); }
	else if (f.target !== KEEP_TARGET) { values.action = 'route'; values.server = f.target; dropKeys(raw, [...DNS_REJECT_KEYS, ...DNS_PREDEFINED_KEYS], remove); }
	return result(values, remove);
}
const OUTBOUND_FIELDS = { node: 'string', outbound: 'string', urltest_nodes: 'list', urltest_url: 'string', urltest_interval: 'string', urltest_tolerance: 'string' };
export function planOutbound(f, raw = {}) {
	const values = head(f), remove = new Set();
	const urltest = f.node === 'urltest';
	planFields(OUTBOUND_FIELDS, { ...f, outbound: f.detour }, raw, values, remove, urltest ? ['node', 'urltest_nodes', 'urltest_url', 'urltest_interval', 'urltest_tolerance'] : ['node', 'outbound']);
	return result(values, remove);
}
const RULESET_FIELDS = { type: 'string', format: 'string', url: 'string', path: 'string', outbound: 'string', update_interval: 'string' };
export function planRuleset(f, raw = {}) {
	const values = head(f), remove = new Set();
	planFields(RULESET_FIELDS, f, raw, values, remove, f.type === 'local' ? ['type', 'format', 'path'] : ['type', 'format', 'url', 'outbound', 'update_interval']);
	return result(values, remove);
}
const DNS_FIELDS = { type: 'string', server: 'string', server_port: 'string', path: 'string', tls_sni: 'string', address_resolver: 'string', outbound: 'string' };
export function planDns(f, raw = {}) {
	const values = head(f), remove = new Set();
	const a = parseDnsAddress(f.address) || {};
	const only = ['type', 'server', 'server_port', 'address_resolver', 'outbound'];
	if (['https', 'h3'].includes(a.type)) only.push('path');
	if (a.type && a.type !== 'udp' && a.type !== 'tcp') only.push('tls_sni');
	planFields(DNS_FIELDS, { type: a.type, server: a.server, server_port: a.port, path: a.path, tls_sni: f.tls_sni, address_resolver: f.resolver, outbound: f.outbound }, raw, values, remove, only);
	/* 旧格式的 address 已被迁移脚本拆分；残留时一并去掉，避免与新字段冲突 */
	dropKeys(raw, ['address'], remove);
	return result(values, remove);
}
/** 默认出站：代理关着时写进 sight_last_outbound，打开代理时才生效 */
export function planSettings(f, c) {
	const routing = { default_outbound_dns: f.outboundDns }, dns = { values: { default_server: f.defaultDns }, remove: [] };
	if (c.defaultOutbound !== OFF) routing.default_outbound = f.defaultOutbound; else routing.sight_last_outbound = f.defaultOutbound;
	if (f.strategy) dns.values.default_strategy = f.strategy; else if (c.strategy) dns.remove.push('default_strategy');
	return { routing, dns };
}

/* --- 引用关系 --- */
export const find = (c, kind, id) => c[LIST[kind]].find(x => x.id === id);
/** 纯函数：某对象引用到的其他对象 [kind, id]（内置的直连、阻断与内置 DNS 不算） */
export function deps(kind, raw) {
	const d = [], out = id => { if (id && id !== DIRECT && id !== BLOCK) d.push(['outbound', id]); }, dns = id => { if (id && !BUILTIN_DNS.includes(id)) d.push(['dns', id]); };
	if (kind === 'rule') { if (ruleTarget(raw) !== BLOCK_TARGET && (raw.action || 'route') === 'route') out(raw.outbound); toList(raw.rule_set).forEach(r => d.push(['ruleset', r])); }
	if (kind === 'dnsRule') { if ((raw.action || 'route') === 'route') dns(raw.server); toList(raw.rule_set).forEach(r => d.push(['ruleset', r])); }
	if (kind === 'outbound') { if (raw.node !== 'urltest') out(raw.outbound); dns(raw.domain_resolver); }
	if (kind === 'ruleset' && raw.type !== 'local') out(raw.outbound);
	if (kind === 'dns') { out(raw.outbound); dns(raw.address_resolver); }
	return d;
}
/** 纯函数：引用某对象的项目名称；enabledOnly 时只算启用的（停用前检查），否则全部（删除前检查） */
export function referrers(c, kind, id, { enabledOnly = false, t = s => s } = {}) {
	const names = [];
	for (const k of Object.keys(LIST)) for (const item of c[LIST[k]])
		if ((!enabledOnly || item.enabled) && deps(k, item.raw).some(([dk, did]) => dk === kind && did === id)) names.push(item.label);
	if (kind === 'outbound' && (c.defaultOutbound === id || (!enabledOnly && c.lastOutbound === id))) names.push(t('Default outbound'));
	if (kind === 'dns' && c.defaultDns === id) names.push(t('Default DNS server'));
	if (kind === 'dns' && c.outboundDns === id) names.push(t('DNS for node addresses'));
	return names;
}
const usable = (c, kind, id) => !!find(c, kind, id)?.enabled;
const outboundOk = (c, id) => id === DIRECT || id === BLOCK || usable(c, 'outbound', id);
const dnsOk = (c, id) => BUILTIN_DNS.includes(id) || usable(c, 'dns', id);
/** 纯函数：沿链式代理找环：从 start 出发经 detour 能回到 start */
function loops(next, start, first) {
	const seen = new Set([start]);
	for (let cur = first; cur; cur = next(cur)) { if (seen.has(cur)) return cur === start; seen.add(cur); }
	return false;
}

/**
 * 纯函数：启用对象前检查它引用的对象都存在且已启用。
 * @returns {string[]} 缺失或停用的引用名称
 */
export function missingDeps(c, kind, raw) {
	return deps(kind, raw).filter(([k, id]) => !usable(c, k, id)).map(([k, id]) => find(c, k, id)?.label || id);
}

/** 纯函数：当前自定义配置会让 sing-box 检查失败的问题，显示在分流页顶部；nodes 为全部节点 */
export function problems(c, nodes = []) {
	const p = [], ids = new Set(nodes.map(n => n.id));
	for (const kind of Object.keys(LIST)) for (const item of c[LIST[kind]]) {
		if (!item.enabled) continue;
		const miss = missingDeps(c, kind, item.raw);
		if (miss.length) p.push({ msg: '%s refers to %s, which is missing or turned off', args: [item.label, miss.join(', ')] });
		if (kind === 'outbound' && (item.node === 'urltest' ? item.urltest : [item.node]).some(n => !ids.has(n)))
			p.push({ msg: '%s uses a node that no longer exists', args: [item.label] });
	}
	if (c.defaultOutbound !== OFF && !outboundOk(c, c.defaultOutbound)) p.push({ msg: 'The default outbound is missing or turned off' });
	if (!dnsOk(c, c.defaultDns)) p.push({ msg: 'The default DNS server is missing or turned off' });
	if (!dnsOk(c, c.outboundDns)) p.push({ msg: 'The DNS server for node addresses is missing or turned off' });
	const used = c.outbounds.filter(o => o.enabled && o.node !== 'urltest').map(o => o.node);
	if (new Set(used).size !== used.length) p.push({ msg: 'Two outbounds use the same node' });
	return p;
}

/* --- 校验：返回 [{ msg, args?, field }]，msg 为英文 msgid，field 为表单键 --- */
const isDomain = v => /^\.?([a-z0-9_-]+\.)*[a-z0-9_-]+\.?$/i.test(v);
const isNet = v => isCidr(v) || isCidr(v, 6);
const isDuration = v => /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h|d))+$/.test(v);
const isHttpUrl = v => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) && !!u.hostname; } catch { return false; } };
const lists = (f, e, checks) => { for (const [k, ok, msg] of checks) if (f[k] && !f[k].every(v => ok(String(v).trim()))) e.push({ msg, field: k }); };
function matchChecks(f, e) {
	lists(f, e, [
		['domain_suffix', isDomain, 'Enter domain names such as example.com'], ['domain', isDomain, 'Enter domain names such as example.com'],
		['domain_keyword', v => /^\S+$/.test(v), 'Keywords cannot contain spaces'],
		['ip_cidr', isNet, 'Enter IP addresses or ranges such as 192.0.2.0/24'], ['source_ip_cidr', isNet, 'Enter IP addresses or ranges such as 192.168.1.10'],
		['port', isPort, 'Ports must be between 1 and 65535'],
	]);
}
function conditionCount(f, raw, fields, dns) {
	const managed = Object.entries(fields).filter(([k, kind]) => kind === 'list' ? f[k].some(v => String(v).trim()) : kind === 'string' ? !!f[k] : k !== 'invert' && f[k]).length;
	return managed + conditions(raw, dns).filter(([k]) => !(k in fields)).length;
}

export function validateRule(f, c, raw = {}) {
	const e = [];
	if (!f.label.trim()) e.push({ msg: 'Enter a name', field: 'label' });
	if (!conditionCount(f, raw, RULE_FIELDS, false)) e.push({ msg: 'Add at least one condition', field: 'domain_suffix' });
	matchChecks(f, e);
	if (f.target !== BLOCK_TARGET && f.target !== KEEP_TARGET && !(f.target === DIRECT || usable(c, 'outbound', f.target))) e.push({ msg: 'Choose where matching traffic goes', field: 'target' });
	if (!f.rule_set.every(id => usable(c, 'ruleset', id))) e.push({ msg: 'A selected rule set is missing or turned off', field: 'rule_set' });
	return e;
}
export function validateDnsRule(f, c, raw = {}) {
	const e = [];
	if (!f.label.trim()) e.push({ msg: 'Enter a name', field: 'label' });
	if (!conditionCount(f, raw, DNS_RULE_FIELDS, true)) e.push({ msg: 'Add at least one condition', field: 'domain_suffix' });
	matchChecks(f, e);
	if (f.target !== BLOCK_TARGET && f.target !== KEEP_TARGET && !dnsOk(c, f.target)) e.push({ msg: 'Choose a DNS server', field: 'target' });
	if (!f.rule_set.every(id => usable(c, 'ruleset', id))) e.push({ msg: 'A selected rule set is missing or turned off', field: 'rule_set' });
	return e;
}
export function validateOutbound(f, c, nodes, id = '') {
	const e = [];
	if (!f.label.trim()) e.push({ msg: 'Enter a name', field: 'label' });
	if (f.node === 'urltest') {
		if (!f.urltest_nodes.length) e.push({ msg: 'Choose at least one node', field: 'urltest_nodes' });
		else if (!f.urltest_nodes.every(n => nodes.some(x => x.id === n))) e.push({ msg: 'A selected node no longer exists', field: 'urltest_nodes' });
		if (f.urltest_url.trim() && !isHttpUrl(f.urltest_url.trim())) e.push({ msg: 'Enter an address starting with http:// or https://', field: 'urltest_url' });
		for (const k of ['urltest_interval', 'urltest_tolerance']) if (f[k].trim() && !/^\d+$/.test(f[k].trim())) e.push({ msg: 'Enter a whole number', field: k });
		return e;
	}
	if (!nodes.some(n => n.id === f.node)) e.push({ msg: 'Choose a node', field: 'node' });
	else if (c.outbounds.some(o => o.id !== id && o.node === f.node)) e.push({ msg: 'Another outbound already uses this node', field: 'node' });
	if (f.detour) {
		if (f.detour === id || !usable(c, 'outbound', f.detour)) e.push({ msg: 'Choose an outbound that is turned on', field: 'detour' });
		else if (id && loops(o => find(c, 'outbound', o)?.detour, id, f.detour)) e.push({ msg: 'These outbounds would go through each other in a loop', field: 'detour' });
	}
	return e;
}
export function validateRuleset(f, c) {
	const e = [];
	if (!f.label.trim()) e.push({ msg: 'Enter a name', field: 'label' });
	if (f.type === 'local') { if (!/^\/\S+$/.test(f.path.trim())) e.push({ msg: 'Enter a file path starting with /', field: 'path' }); }
	else {
		if (!isHttpUrl(f.url.trim())) e.push({ msg: 'Enter an address starting with http:// or https://', field: 'url' });
		if (f.outbound && !outboundOk(c, f.outbound)) e.push({ msg: 'Choose an outbound that is turned on', field: 'outbound' });
		if (f.update_interval.trim() && !isDuration(f.update_interval.trim())) e.push({ msg: 'Enter a duration such as 12h or 1d', field: 'update_interval' });
	}
	return e;
}
export function validateDns(f, c, id = '') {
	const e = [];
	if (!f.label.trim()) e.push({ msg: 'Enter a name', field: 'label' });
	if (!parseDnsAddress(f.address)) e.push({ msg: 'Enter an address such as 8.8.8.8, tls://1.1.1.1 or https://dns.google/dns-query', field: 'address' });
	if (!outboundOk(c, f.outbound) || f.outbound === BLOCK) e.push({ msg: 'Choose an outbound that is turned on', field: 'outbound' });
	if (f.resolver) {
		if (f.resolver === id || !dnsOk(c, f.resolver)) e.push({ msg: 'Choose a DNS server that is turned on', field: 'resolver' });
		else if (id && loops(d => find(c, 'dns', d)?.resolver, id, f.resolver)) e.push({ msg: 'These DNS servers would resolve each other in a loop', field: 'resolver' });
	}
	return e;
}
export function validateSettings(f, c) {
	const e = [];
	if (!outboundOk(c, f.defaultOutbound)) e.push({ msg: 'Choose an outbound that is turned on', field: 'defaultOutbound' });
	if (!dnsOk(c, f.defaultDns)) e.push({ msg: 'Choose a DNS server that is turned on', field: 'defaultDns' });
	if (!dnsOk(c, f.outboundDns)) e.push({ msg: 'Choose a DNS server that is turned on', field: 'outboundDns' });
	return e;
}

/** 纯函数：排序。order 为全部段名，ids 为该类段的新顺序；只在该类段原来占的位置之间调换 */
export function planOrder(order, ids) {
	const set = new Set(ids), queue = [...ids];
	return order.map(name => set.has(name) ? queue.shift() : name);
}
/** 纯函数：列表里第 index 项上移（-1）或下移（1）后的 id 顺序 */
export function moved(items, index, delta) {
	const ids = items.map(x => x.id), to = index + delta;
	if (to < 0 || to >= ids.length) return ids;
	[ids[index], ids[to]] = [ids[to], ids[index]];
	return ids;
}

/**
 * 纯函数：从其他模式切到自定义时的初始配置。只在还没有任何出站时使用；已有自定义配置则原样沿用。
 * template：bypass_china（国内网站与地址直连、其余走代理）、global（除局域网地址外都走代理）、blank（只建出站，默认直连）。
 * ctx：{ node, dnsServer, chinaDnsServer, enabled, names（已有段名）, t（译名） }
 * @returns {{ add: { type: string, name: string, values: object }[], routing: object, dns: object }}
 */
export function planTemplate(template, { node, dnsServer, chinaDnsServer, enabled, names = [], t = s => s }) {
	const taken = new Set(names), add = [];
	const name = b => { let n = b, i = 2; while (taken.has(n)) n = `${b}_${i++}`; taken.add(n); return n; };
	const section = (type, b, values) => { const n = name(b); add.push({ type, name: n, values: { enabled: '1', ...values } }); return n; };
	const dnsSection = (b, label, server, protocol, outbound) => {
		if (!server || server === 'wan') return 'default-dns';
		const a = parseDnsAddress(server, protocol);
		if (!a) return 'default-dns';
		const v = { label, type: a.type, server: a.server, outbound };
		if (a.port) v.server_port = a.port;
		if (a.path) v.path = a.path;
		if (isHostname(a.server) && !isIPv4(a.server)) v.address_resolver = 'default-dns';
		return section('dns_server', b, v);
	};
	const proxy = section('routing_node', 'sight_proxy', { label: t('Proxy'), node });
	let defaultDns = 'default-dns';
	if (template !== 'blank') {
		/* 与预设模式一致：远程 DNS 默认走 TCP、经代理查询 */
		defaultDns = dnsSection('sight_dns_remote', t('Remote DNS'), dnsServer, 'tcp', proxy);
		section('routing_rule', 'sight_private', { label: t('Local network addresses'), ip_is_private: '1', action: 'route', outbound: DIRECT });
	}
	if (template === 'bypass_china') {
		const site = section('ruleset', 'sight_geosite_cn', { label: t('China sites'), type: 'remote', format: 'binary', url: GEO.geosite_cn, outbound: proxy });
		const ip = section('ruleset', 'sight_geoip_cn', { label: t('China IP addresses'), type: 'remote', format: 'binary', url: GEO.geoip_cn, outbound: proxy });
		section('routing_rule', 'sight_cn_sites', { label: t('China sites'), rule_set: [site], action: 'route', outbound: DIRECT });
		section('routing_rule', 'sight_cn_ips', { label: t('China IP addresses'), rule_set: [ip], action: 'route', outbound: DIRECT });
		const china = dnsSection('sight_dns_china', t('China DNS'), chinaDnsServer, 'udp', DIRECT);
		section('dns_rule', 'sight_dns_cn', { label: t('China sites'), rule_set: [site], action: 'route', server: china });
	}
	const target = template === 'blank' ? DIRECT : proxy;
	const routing = { default_outbound_dns: 'default-dns', ...(enabled ? { default_outbound: target } : { default_outbound: OFF, sight_last_outbound: target }) };
	return { add, routing, dns: { default_server: defaultDns } };
}
