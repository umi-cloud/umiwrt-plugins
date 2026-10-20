import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	shapeCustom, parseDnsAddress, formatDnsAddress, ruleForm, planRule, validateRule, dnsRuleForm, planDnsRule, outboundForm, planOutbound, validateOutbound,
	rulesetForm, planRuleset, validateRuleset, dnsForm, planDns, validateDns, settingsForm, planSettings, validateSettings, referrers, missingDeps, problems,
	planOrder, moved, planTemplate, conditions, guessFormat,
} from '../src/routing.js';

const cfg = {
	routing: { '.type': 'homeproxy', '.name': 'routing', '.index': 0, default_outbound: 'proxy', default_outbound_dns: 'default-dns' },
	dns: { '.type': 'homeproxy', '.name': 'dns', '.index': 1, default_server: 'remote' },
	proxy: { '.type': 'routing_node', '.name': 'proxy', '.index': 2, label: 'Proxy', enabled: '1', node: 'n1' },
	chain: { '.type': 'routing_node', '.name': 'chain', '.index': 3, label: 'Chain', enabled: '0', node: 'n2', outbound: 'proxy' },
	r2: { '.type': 'routing_rule', '.name': 'r2', '.index': 5, label: 'Second', enabled: '1', domain_suffix: ['b.example'], action: 'reject' },
	r1: { '.type': 'routing_rule', '.name': 'r1', '.index': 4, label: 'First', enabled: '1', rule_set: ['geo'], process_name: ['curl'], action: 'route', outbound: 'proxy' },
	geo: { '.type': 'ruleset', '.name': 'geo', '.index': 6, label: 'Geo', enabled: '1', type: 'remote', format: 'binary', url: 'https://x.example/a.srs', outbound: 'proxy' },
	remote: { '.type': 'dns_server', '.name': 'remote', '.index': 7, label: 'Remote', enabled: '1', type: 'tls', server: '1.1.1.1', outbound: 'proxy' },
	d1: { '.type': 'dns_rule', '.name': 'd1', '.index': 8, label: 'CN', enabled: '1', rule_set: ['geo'], action: 'route', server: 'remote' },
};
const nodes = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }];
const c = shapeCustom(cfg);
const msgs = e => e.map(x => x.msg);

test('整形：按段顺序，规则去向（阻断/出站），DNS 地址合成为一个串', () => {
	assert.deepEqual(c.rules.map(r => [r.id, r.target]), [['r1', 'proxy'], ['r2', 'block']]);
	assert.equal(c.dnsServers[0].address, 'tls://1.1.1.1');
	assert.deepEqual(c.order, ['routing', 'dns', 'proxy', 'chain', 'r1', 'r2', 'geo', 'remote', 'd1']);
	assert.deepEqual(conditions(cfg.r1), [['process_name', ['curl']], ['rule_set', ['geo']]]);
});

test('DNS 地址解析与格式化', () => {
	assert.deepEqual(parseDnsAddress('8.8.8.8'), { type: 'udp', server: '8.8.8.8', port: '', path: '' });
	assert.deepEqual(parseDnsAddress('https://dns.google/dns-query'), { type: 'https', server: 'dns.google', port: '', path: '/dns-query' });
	assert.deepEqual(parseDnsAddress('quic://[2606:4700::1111]:853'), { type: 'quic', server: '2606:4700::1111', port: '853', path: '' });
	assert.deepEqual(parseDnsAddress('2001:4860:4860::8888', 'tcp'), { type: 'tcp', server: '2001:4860:4860::8888', port: '', path: '' });
	for (const bad of ['', 'ftp://x', 'tls://bad host', 'udp://1.1.1.1/path', 'tcp://1.1.1.1:99999', '[1.1.1.1]']) assert.equal(parseDnsAddress(bad), null, bad);
	assert.equal(formatDnsAddress({ type: 'https', server: 'dns.google', server_port: '443', path: '/dns-query' }), 'https://dns.google:443/dns-query');
	assert.equal(formatDnsAddress({ type: 'udp', server: '223.5.5.5' }), '223.5.5.5');
});

test('规则：改成阻断删掉出站与 route 专属选项；未管理的条件保留；只有未管理条件也算有条件', () => {
	const raw = { ...cfg.r1, override_address: '1.1.1.1' };
	const f = ruleForm(raw);
	f.target = 'block'; f.domain_suffix = ['a.example'];
	assert.deepEqual(validateRule(f, c, raw), []);
	const p = planRule(f, raw);
	assert.equal(p.values.action, 'reject');
	assert.ok(!('process_name' in p.values));
	assert.deepEqual(p.remove.sort(), ['outbound', 'override_address']);
	const empty = ruleForm({ '.name': 'x', label: 'x', action: 'route', outbound: 'direct-out' });
	assert.deepEqual(msgs(validateRule(empty, c, {})), ['Add at least one condition']);
	assert.deepEqual(msgs(validateRule({ ...ruleForm(), label: 'n', domain: ['bad domain'], port: ['0'], target: 'chain', rule_set: ['nope'] }, c)),
		['Enter domain names such as example.com', 'Ports must be between 1 and 65535', 'Choose where matching traffic goes', 'A selected rule set is missing or turned off']);
	const kept = planRule({ ...ruleForm({ '.name': 'k', label: 'K', action: 'resolve', domain: ['a.example'] }) }, { action: 'resolve', domain: ['a.example'] });
	assert.ok(!('action' in kept.values));
});

test('DNS 规则：阻断删掉 server 与 route 选项；改回 route 删掉 reject/predefined 选项', () => {
	const raw = { ...cfg.d1, domain_strategy: 'ipv4_only' };
	const block = planDnsRule({ ...dnsRuleForm(raw), target: 'block' }, raw);
	assert.deepEqual([block.values.action, block.remove.sort()], ['reject', ['domain_strategy', 'server']]);
	const raw2 = { label: 'x', action: 'reject', reject_method: 'drop', domain: ['a.example'] };
	const route = planDnsRule({ ...dnsRuleForm(raw2), target: 'default-dns' }, raw2);
	assert.deepEqual([route.values.server, route.remove], ['default-dns', ['reject_method']]);
});

test('出站：节点唯一、链式代理须启用且无环；URLTest 切换时清理 detour', () => {
	assert.deepEqual(msgs(validateOutbound({ ...outboundForm(), label: 'x', node: 'n1' }, c, nodes)), ['Another outbound already uses this node']);
	assert.deepEqual(msgs(validateOutbound({ ...outboundForm(cfg.proxy), detour: 'chain' }, c, nodes, 'proxy')), ['Choose an outbound that is turned on']);
	const loop = shapeCustom({ ...cfg, chain: { ...cfg.chain, enabled: '1' } });
	assert.deepEqual(msgs(validateOutbound({ ...outboundForm(cfg.proxy), detour: 'chain' }, loop, nodes, 'proxy')), ['These outbounds would go through each other in a loop']);
	const p = planOutbound({ ...outboundForm(cfg.chain), node: 'urltest', urltest_nodes: ['n2', 'n3'] }, cfg.chain);
	assert.deepEqual([p.values.urltest_nodes, p.remove], [['n2', 'n3'], ['outbound']]);
	assert.deepEqual(msgs(validateOutbound({ ...outboundForm(), label: 'u', node: 'urltest' }, c, nodes)), ['Choose at least one node']);
});

test('规则集与 DNS 服务器：按类型只写相关键；地址、间隔、解析环校验', () => {
	const local = planRuleset({ ...rulesetForm(cfg.geo), type: 'local', path: '/etc/homeproxy/ruleset/a.json', format: 'source' }, cfg.geo);
	assert.deepEqual(local.remove.sort(), ['outbound', 'url']);
	assert.deepEqual(msgs(validateRuleset({ ...rulesetForm(), label: 'x', url: 'ftp://x', update_interval: 'daily' }, c)), ['Enter an address starting with http:// or https://', 'Enter a duration such as 12h or 1d']);
	assert.equal(guessFormat('https://x/a.json'), 'source');
	const dns = planDns({ ...dnsForm(cfg.remote), address: 'https://dns.google/dns-query', tls_sni: 'dns.google' }, cfg.remote);
	assert.deepEqual(dns.values, { label: 'Remote', enabled: '1', type: 'https', server: 'dns.google', path: '/dns-query', tls_sni: 'dns.google', outbound: 'proxy' });
	const udp = planDns({ ...dnsForm(cfg.remote), address: '8.8.8.8' }, { ...cfg.remote, tls_sni: 'x', server_port: '853' });
	assert.deepEqual(udp.remove.sort(), ['server_port', 'tls_sni']);
	assert.deepEqual(msgs(validateDns({ ...dnsForm(cfg.remote), resolver: 'remote' }, c, 'remote')), ['Choose a DNS server that is turned on']);
});

test('默认设置：代理关着时默认出站写入 sight_last_outbound', () => {
	assert.deepEqual(settingsForm(c), { defaultOutbound: 'proxy', defaultDns: 'remote', outboundDns: 'default-dns', strategy: '' });
	const off = { ...c, defaultOutbound: 'nil', lastOutbound: 'proxy' };
	assert.equal(settingsForm(off).defaultOutbound, 'proxy');
	assert.deepEqual(planSettings({ ...settingsForm(off), strategy: 'prefer_ipv4' }, off), { routing: { default_outbound_dns: 'default-dns', sight_last_outbound: 'proxy' }, dns: { values: { default_server: 'remote', default_strategy: 'prefer_ipv4' }, remove: [] } });
	assert.deepEqual(msgs(validateSettings({ ...settingsForm(c), defaultOutbound: 'chain', defaultDns: 'local-dns' }, c)), ['Choose an outbound that is turned on', 'Choose a DNS server that is turned on']);
});

test('引用：删除看全部引用、停用只看启用的；启用前检查依赖；整体问题汇总', () => {
	assert.deepEqual(referrers(c, 'outbound', 'proxy').sort(), ['Chain', 'Default outbound', 'First', 'Geo', 'Remote']);
	assert.deepEqual(referrers(c, 'outbound', 'proxy', { enabledOnly: true }).sort(), ['Default outbound', 'First', 'Geo', 'Remote']);
	assert.deepEqual(referrers(c, 'ruleset', 'geo'), ['First', 'CN']);
	assert.deepEqual(referrers(c, 'dns', 'remote'), ['CN', 'Default DNS server']);
	assert.deepEqual(missingDeps(c, 'outbound', { node: 'n2', outbound: 'gone' }), ['gone']);
	assert.deepEqual(problems(c, nodes), []);
	const bad = shapeCustom({ ...cfg, dns: { ...cfg.dns, default_server: 'local-dns' }, geo: { ...cfg.geo, enabled: '0' } });
	assert.deepEqual(problems(bad, [{ id: 'n2' }]).map(p => [p.msg, ...(p.args || [])]), [['%s uses a node that no longer exists', 'Proxy'], ['%s refers to %s, which is missing or turned off', 'First', 'Geo'],
		['%s refers to %s, which is missing or turned off', 'CN', 'Geo'], ['The default DNS server is missing or turned off']]);
});

test('排序：只在同类段的位置之间调换', () => {
	assert.deepEqual(moved(c.rules, 1, -1), ['r2', 'r1']);
	assert.deepEqual(moved(c.rules, 0, -1), ['r1', 'r2']);
	assert.deepEqual(planOrder(c.order, ['r2', 'r1']), ['routing', 'dns', 'proxy', 'chain', 'r2', 'r1', 'geo', 'remote', 'd1']);
});

test('切到自定义的初始配置：国内直连模板建规则集、规则与国内 DNS；名称冲突时加后缀；代理关着不启动', () => {
	const p = planTemplate('bypass_china', { node: 'n1', dnsServer: 'tls://dns.google', chinaDnsServer: '223.5.5.5', enabled: true, names: ['sight_proxy'] });
	assert.deepEqual(p.add.map(a => [a.type, a.name]), [['routing_node', 'sight_proxy_2'], ['dns_server', 'sight_dns_remote'], ['routing_rule', 'sight_private'],
		['ruleset', 'sight_geosite_cn'], ['ruleset', 'sight_geoip_cn'], ['routing_rule', 'sight_cn_sites'], ['routing_rule', 'sight_cn_ips'], ['dns_server', 'sight_dns_china'], ['dns_rule', 'sight_dns_cn']]);
	assert.deepEqual(p.add[1].values, { enabled: '1', label: 'Remote DNS', type: 'tls', server: 'dns.google', outbound: 'sight_proxy_2', address_resolver: 'default-dns' });
	assert.deepEqual(p.add[7].values, { enabled: '1', label: 'China DNS', type: 'udp', server: '223.5.5.5', outbound: 'direct-out' });
	assert.deepEqual([p.routing.default_outbound, p.dns.default_server], ['sight_proxy_2', 'sight_dns_remote']);
	const plain = planTemplate('global', { node: 'n1', dnsServer: '8.8.8.8', enabled: false });
	assert.deepEqual(plain.add[1].values.type, 'tcp');
	assert.deepEqual(plain.routing, { default_outbound_dns: 'default-dns', default_outbound: 'nil', sight_last_outbound: 'sight_proxy' });
	const blank = planTemplate('blank', { node: 'n1', dnsServer: 'wan', enabled: true });
	assert.deepEqual([blank.add.length, blank.routing.default_outbound, blank.dns.default_server], [1, 'direct-out', 'default-dns']);
	/* 模板生成的配置自身没有问题 */
	const names = Object.fromEntries(p.add.map((a, i) => [a.name, { '.type': a.type, '.name': a.name, '.index': i + 2, ...a.values }]));
	const shaped = shapeCustom({ routing: { '.name': 'routing', ...p.routing }, dns: { '.name': 'dns', ...p.dns }, ...names });
	assert.deepEqual(problems(shaped, nodes), []);
});

test('模板：主节点为自动选择时出站带节点列表；IPv6 关闭时 DNS 只返回 IPv4', async () => {
	const { planTemplate } = await import('../src/routing.js');
	const p = planTemplate('blank', { node: 'urltest', urltestNodes: ['a', 'b'], enabled: true, ipv6: false });
	assert.deepEqual(p.add[0].values, { enabled: '1', label: 'Proxy', node: 'urltest', urltest_nodes: ['a', 'b'] });
	assert.equal(p.dns.default_strategy, 'ipv4_only');
	assert.equal(planTemplate('blank', { node: 'n1', enabled: true }).dns.default_strategy, undefined);
});
