import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, validateSubscriptions, createHomeProxy, isDnsServer, validateRouting, previewLinks, importValues, planAccess } from '../src/service.js';

const cfg = {
	config: { '.type': 'homeproxy', main_node: 'n1', routing_mode: 'gfwlist' },
	subscription: { '.type': 'homeproxy', subscription_url: ['https://a.example/sub'] },
	n1: { '.type': 'node', '.name': 'n1', label: 'Tokyo', type: 'vless', address: 'jp.example', port: '443', grouphash: 'x' },
	n2: { '.type': 'node', '.name': 'n2', type: 'socks', address: '127.0.0.1', port: '1080' },
};

test('整形：main_node 为 nil 即关闭；节点无标签用节名；服务状态取不到为 null', () => {
	const d = shape(cfg, { homeproxy: { instances: { 'sing-box-c': { running: true } } } });
	assert.deepEqual([d.enabled, d.mainNode, d.mode, d.running, d.subscriptions], [true, 'n1', 'gfwlist', true, ['https://a.example/sub']]);
	assert.deepEqual(d.nodes.map(n => [n.label, n.subscribed]), [['Tokyo', true], ['n2', false]]);
	const off = shape({ ...cfg, config: { main_node: 'nil' } }, {});
	assert.deepEqual([off.enabled, off.mainNode, off.mode, off.running], [false, '', 'bypass_mainland_china', false]);
	assert.equal(shape(cfg, null).running, null);
});

test('订阅地址只接受 http(s)', () => {
	assert.deepEqual(validateSubscriptions(['https://a/b', 'http://c']), []);
	assert.deepEqual(validateSubscriptions(['ftp://x']), ['Subscription addresses must start with http:// or https://']);
});

test('写入：关闭写 nil；未知模式/站点/日志拒绝；清空订阅用 delete', async () => {
	const calls = [];
	const uci = { set: async (...a) => calls.push(['set', ...a]), remove: async (...a) => calls.push(['remove', ...a]) };
	const svc = createHomeProxy({ call: async () => ({ result: true }) }, uci);
	await svc.turnOff();
	await svc.useNode('n2');
	await svc.saveSubscriptions([]);
	assert.deepEqual(calls, [['set', 'homeproxy', 'config', { main_node: 'nil' }], ['set', 'homeproxy', 'config', { main_node: 'n2' }], ['remove', 'homeproxy', 'subscription', ['subscription_url']]]);
	await assert.rejects(svc.setMode('custom'), /Unknown routing mode/);
	await assert.rejects(svc.check('evil'), /Unknown site/);
	await assert.rejects(svc.log('../../etc/shadow'), /Unknown log/);
	assert.equal(await svc.check('google'), true);
});

test('整形：UDP 节点、DNS、访问控制名单（MAC 统一大写）、订阅选项', () => {
	const d = shape({ ...cfg, config: { ...cfg.config, main_udp_node: 'nil', dns_server: 'tls://1.1.1.1' },
		control: { lan_proxy_mode: 'listed_only', lan_proxy_mac_addrs: ['aa:bb:cc:dd:ee:ff'], lan_direct_mac_addrs: 'aa:aa:aa:aa:aa:aa' },
		subscription: { ...cfg.subscription, auto_update: '1', allow_insecure: '1', packet_encoding: 'xudp' } }, {});
	assert.deepEqual([d.udpNode, d.dnsServer, d.chinaDnsServer], ['nil', 'tls://1.1.1.1', '223.5.5.5']);
	assert.deepEqual(d.access, { mode: 'listed_only', proxyMacs: ['AA:BB:CC:DD:EE:FF'], directMacs: ['AA:AA:AA:AA:AA:AA'] });
	assert.deepEqual([d.autoUpdate, d.viaProxy, d.allowInsecure, d.packetEncoding], [true, false, true, 'xudp']);
	assert.equal(shape({ control: { lan_proxy_mode: 'weird' } }, {}).access.mode, 'disabled');
});

test('DNS 地址：wan、IP、带协议前缀的主机名；裸主机名与乱写拒绝', () => {
	for (const v of ['wan', '8.8.8.8', '2001:4860:4860::8888', 'tls://dns.google', 'https://dns.alidns.com/dns-query', 'quic://[2606:4700::1111]:853']) assert.ok(isDnsServer(v), v);
	for (const v of ['', 'dns.google', 'tls://', 'udp://bad host']) assert.ok(!isDnsServer(v), v);
});

test('分流校验：UDP 节点须存在；仅国内直连模式校验国内 DNS', () => {
	const nodes = [{ id: 'n1' }];
	assert.deepEqual(validateRouting({ mode: 'gfwlist', udpNode: 'same', dnsServer: '8.8.8.8', chinaDnsServer: 'x' }, nodes), []);
	assert.deepEqual(validateRouting({ mode: 'bypass_mainland_china', udpNode: 'gone', dnsServer: 'bad', chinaDnsServer: 'bad' }, nodes), ['Choose a UDP node', 'Invalid DNS server', 'Invalid China DNS server']);
});

test('导入：逐行预览去重；订阅的不安全与包编码设置作用于导入节点', () => {
	const rows = previewLinks('socks5://1.1.1.1:1080\n\nsocks5://1.1.1.1:1080\nbad://x', {});
	assert.deepEqual(rows.map(r => [r.link, !!r.node]), [['socks5://1.1.1.1:1080', true], ['bad://x', false]]);
	assert.deepEqual(importValues({ type: 'vless', tls: '1' }, { allowInsecure: true, packetEncoding: 'xudp' }), { type: 'vless', tls: '1', tls_insecure: '1', packet_encoding: 'xudp' });
	assert.deepEqual(importValues({ type: 'socks' }, { allowInsecure: true, packetEncoding: 'xudp' }), { type: 'socks' });
});

test('访问控制：按模式写对应 MAC 名单，空名单删除选项；全部设备模式不动名单', () => {
	assert.deepEqual(planAccess('listed_only', ['AA:BB:CC:DD:EE:FF']), { values: { lan_proxy_mode: 'listed_only', lan_proxy_mac_addrs: ['AA:BB:CC:DD:EE:FF'] }, remove: [] });
	assert.deepEqual(planAccess('except_listed', []), { values: { lan_proxy_mode: 'except_listed' }, remove: ['lan_direct_mac_addrs'] });
	assert.deepEqual(planAccess('disabled', ['AA:BB:CC:DD:EE:FF']), { values: { lan_proxy_mode: 'disabled' }, remove: [] });
});

test('删除节点：主节点与 UDP 节点在用时拒绝；规则库更新状态码映射', async () => {
	const calls = [];
	const svc = createHomeProxy({ call: async (o, m, p) => { calls.push([o, m, p]); return m === 'resources_update' ? { status: 3 } : {}; } }, { remove: async (...a) => calls.push(['remove', ...a]) });
	await assert.rejects(svc.removeNode('n1', { mainNode: 'n1', udpNode: 'same' }), /in use/);
	await assert.rejects(svc.removeNode('n2', { mainNode: 'n1', udpNode: 'n2' }), /in use/);
	await svc.removeNode('n3', { mainNode: 'n1', udpNode: 'same' });
	assert.deepEqual(calls.at(-1), ['remove', 'homeproxy', 'n3']);
	assert.equal(await svc.updateResource('gfw_list'), 'latest');
	await assert.rejects(svc.updateResource('../x'), /Unknown resource/);
	await assert.rejects(svc.cleanLog('sing-box-s'), /Unknown log/);
});

test('规则库：有版本号时忽略残留的 error 字段（真机情形）；按模式列出缺失的规则库', async () => {
	const { missingResources } = await import('../src/service.js');
	const svc = createHomeProxy({ call: async (o, m, p) => p.type === 'china_ip4' ? { version: '20261009094558', error: 'No such file or directory' } : p.type === 'gfw_list' ? { error: 'No such file' } : { version: '202610092207', error: null } }, {});
	const v = await svc.resourceVersions();
	assert.equal(v.china_ip4, '20261009094558');
	assert.equal(v.gfw_list, null);
	assert.deepEqual(missingResources('bypass_mainland_china', v), []);
	assert.deepEqual(missingResources('gfwlist', v), ['gfw_list']);
	assert.deepEqual(missingResources('global', v), []);
	assert.deepEqual(missingResources('gfwlist', null), []);
});

test('域名列表：解析去重；只写有变化的列表，代理开着才重载服务；非法域名拒绝', async () => {
	const { parseDomains, validateDomains } = await import('../src/service.js');
	assert.deepEqual(parseDomains('Claude.com\r\n\n example.org \nclaude.com\n'), ['claude.com', 'example.org']);
	assert.deepEqual(validateDomains(['a.example', 'bad domain']), ['Invalid domain']);
	const calls = [];
	const svc = createHomeProxy({ call: async (o, m, p) => { calls.push([o, m, p]); return m === 'acllist_read' ? { content: p.type === 'proxy_list' ? 'claude.com\n' : '' } : { result: true }; } }, {});
	const cur = await svc.domainLists();
	assert.deepEqual(cur, { proxy_list: ['claude.com'], direct_list: [] });
	calls.length = 0;
	await svc.saveDomainLists({ proxy_list: ['claude.com'], direct_list: ['nas.example'] }, cur, true);
	assert.deepEqual(calls, [['sight.homeproxy', 'acllist_write', { type: 'direct_list', content: 'nas.example' }], ['sight', 'setInitAction', { name: 'homeproxy', action: 'reload' }]]);
	calls.length = 0;
	await svc.saveDomainLists({ proxy_list: [], direct_list: [] }, cur, false);
	assert.deepEqual(calls, [['sight.homeproxy', 'acllist_write', { type: 'proxy_list', content: '' }]]);
	await assert.rejects(svc.saveDomainLists({ proxy_list: ['-bad'], direct_list: [] }, cur, false), /Invalid domain/);
});

test('延迟：解析 ping 平均值；全丢包为超时；IPv6 地址不支持', async () => {
	const { parsePing } = await import('../src/service.js');
	assert.equal(parsePing('3 packets transmitted, 3 packets received\nround-trip min/avg/max = 20.1/23.6/30.2 ms'), 24);
	assert.equal(parsePing('rtt min/avg/max/mdev = 0.036/0.042/0.048/0.005 ms'), 1);
	assert.equal(parsePing('3 packets transmitted, 0 packets received, 100% packet loss'), null);
	const svc = createHomeProxy({ call: async (o, m, p) => ({ stdout: p.params.at(-1) === '192.0.2.1' ? '100% packet loss' : 'round-trip min/avg/max = 5.0/6.4/8.0 ms' }) }, {});
	assert.equal(await svc.latency({ address: 'node.example' }), 6);
	assert.equal(await svc.latency({ address: '192.0.2.1' }), 'timeout');
	assert.equal(await svc.latency({ address: '2001:db8::1' }), 'unsupported');
});

test('新建段用具名段：前缀加随机串并避开已有名字；导入的多个节点各自取名', async () => {
	const { sectionName } = await import('../src/service.js');
	const seq = [1, 1, 0xabc];
	assert.equal(sectionName('rule', ['rule_00000001'], () => seq.shift()), 'rule_00000abc');
	const calls = [];
	const svc = createHomeProxy({}, { add: async (...a) => calls.push(a) });
	await svc.importNodes([{ type: 'socks', label: 'a' }, { type: 'socks', label: 'b' }], { custom: { order: [] } });
	assert.ok(calls.every(([c, type, name]) => c === 'homeproxy' && type === 'node' && /^node_[0-9a-f]{8}$/.test(name)) && calls[0][2] !== calls[1][2]);
});

test('离开自定义模式：代理开着取默认出站的节点，关着写 nil', async () => {
	const { leaveCustomNode } = await import('../src/service.js');
	const custom = { defaultOutbound: 'out1', outbounds: [{ id: 'out1', node: 'n2' }], rules: [], rulesets: [], dnsServers: [], dnsRules: [] };
	const nodes = [{ id: 'n1' }, { id: 'n2' }];
	assert.equal(leaveCustomNode({ enabled: true, custom, nodes, mainNode: 'n1' }), 'n2');
	assert.equal(leaveCustomNode({ enabled: true, custom: { ...custom, defaultOutbound: 'direct-out' }, nodes, mainNode: 'n1' }), 'n1');
	assert.equal(leaveCustomNode({ enabled: false, custom, nodes, mainNode: 'n1' }), 'nil');
});

test('自定义模式：切入时按模板建段并保持开关状态；开关写默认出站并记住上次的去向', async () => {
	const { shape } = await import('../src/service.js');
	const calls = [];
	const uci = { add: async (...a) => calls.push(['add', ...a]), set: async (...a) => calls.push(['set', ...a]), remove: async (...a) => calls.push(['remove', ...a]) };
	const svc = createHomeProxy({}, uci);
	const data = shape({ config: { '.name': 'config', main_node: 'n1', routing_mode: 'global', dns_server: '8.8.8.8' }, n1: { '.type': 'node', '.name': 'n1', type: 'socks' } }, {});
	await svc.enterCustom(data, 'global', s => s);
	assert.deepEqual(calls.filter(c => c[0] === 'add').map(c => [c[2], c[3]]), [['routing_node', 'sight_proxy'], ['dns_server', 'sight_dns_remote'], ['routing_rule', 'sight_private']]);
	assert.deepEqual(calls.slice(-3).map(c => [c[2], c[3]]), [['routing', { default_outbound_dns: 'default-dns', default_outbound: 'sight_proxy' }], ['dns', { default_server: 'sight_dns_remote' }], ['config', { routing_mode: 'custom' }]]);
	calls.length = 0;
	const custom = shape({ routing: { '.name': 'routing', default_outbound: 'sight_proxy' }, sight_proxy: { '.type': 'routing_node', '.name': 'sight_proxy', enabled: '1', node: 'n1' } }, {}).custom;
	await svc.setCustomPower(false, custom);
	await svc.setCustomPower(true, { ...custom, defaultOutbound: 'nil', lastOutbound: 'direct-out' });
	await svc.setCustomPower(true, { ...custom, defaultOutbound: 'nil', lastOutbound: 'gone' });
	assert.deepEqual(calls.map(c => c[3]), [{ default_outbound: 'nil', sight_last_outbound: 'sight_proxy' }, { default_outbound: 'direct-out' }, { default_outbound: 'sight_proxy' }]);
});
