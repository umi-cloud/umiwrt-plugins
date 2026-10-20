import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, validateSubscriptions, previewLinks, importValues, sectionName, planImport, createHomeProxy } from '../src/service.js';

const cfg = {
	config: { '.type': 'homeproxy', main_node: 'n1', routing_mode: 'gfwlist' },
	subscription: { '.type': 'homeproxy', subscription_url: ['https://a.example/sub'] },
	n1: { '.type': 'node', '.name': 'n1', label: 'Tokyo', type: 'vless', address: 'jp.example', port: '443', grouphash: 'x' },
	n2: { '.type': 'node', '.name': 'n2', type: 'socks', address: '127.0.0.1', port: '1080' },
};
const recorder = () => { const calls = []; const push = kind => async (...a) => { calls.push([kind, ...a]); }; return { calls, uci: { set: push('set'), remove: push('remove'), add: push('add') } }; };

test('整形：main_node 为 nil 即关闭；节点无标签用节名；服务状态取不到为 null；默认值', () => {
	const d = shape(cfg, { homeproxy: { instances: { 'sing-box-c': { running: true } } } });
	assert.deepEqual([d.enabled, d.mainNode, d.mode, d.running, d.subscriptions], [true, 'n1', 'gfwlist', true, ['https://a.example/sub']]);
	assert.deepEqual(d.nodes.map(n => [n.label, !!n.grouphash]), [['Tokyo', true], ['n2', false]]);
	assert.deepEqual([d.udpNode, d.dnsServer, d.chinaDnsServer, d.ports, d.logLevel, d.ipv6], ['nil', '8.8.8.8', '223.5.5.5', 'all', 'warn', false]);
	assert.deepEqual([d.lastNode, d.urltestNodes, d.importSettings.packetEncoding], ['', [], 'xudp']);
	const remembered = shape({ ...cfg, config: { main_node: 'nil', sight_last_node: 'n2', main_urltest_nodes: ['n1', 'gone'] } }, {});
	assert.deepEqual([remembered.lastNode, remembered.urltestNodes], ['n2', ['n1']]);
	assert.equal(shape({ ...cfg, config: { main_node: 'nil', sight_last_node: 'gone' } }, {}).lastNode, '');
	const off = shape({ ...cfg, config: { main_node: 'nil' } }, {});
	assert.deepEqual([off.enabled, off.mainNode, off.mode, off.running], [false, '', 'bypass_mainland_china', false]);
	assert.equal(shape(cfg, null).running, null);
});

test('整形：名单（MAC 统一大写）、端口、IPv6、导入设置、过滤', () => {
	const d = shape({ ...cfg, config: { routing_port: '443,8000-9000', ipv6_support: '1', log_level: 'debug' }, infra: { common_port: '80,443' },
		control: { lan_proxy_mode: 'listed_only', lan_proxy_mac_addrs: ['aa:bb:cc:dd:ee:ff'], lan_direct_mac_addrs: 'aa:aa:aa:aa:aa:aa', lan_gaming_mode_mac_addrs: ['aa:00:00:00:00:01'] },
		subscription: { ...cfg.subscription, auto_update: '1', allow_insecure: '1', packet_encoding: 'xudp', filter_nodes: 'blacklist', filter_keywords: '到期' } }, {});
	assert.deepEqual(d.access, { mode: 'listed_only', proxyMacs: ['AA:BB:CC:DD:EE:FF'], directMacs: ['AA:AA:AA:AA:AA:AA'], gamingMacs: ['AA:00:00:00:00:01'], globalMacs: [] });
	assert.deepEqual([d.ports, d.portsCustom, d.commonPorts, d.logLevel, d.ipv6], ['custom', '443,8000-9000', '80,443', 'debug', true]);
	assert.deepEqual([d.autoUpdate, d.viaProxy, d.importSettings], [true, false, { allowInsecure: true, packetEncoding: 'xudp' }]);
	assert.deepEqual(d.filter, { mode: 'blacklist', keywords: ['到期'], userAgent: '' });
	assert.equal(shape({ control: { lan_proxy_mode: 'weird' } }, {}).access.mode, 'disabled');
});

test('订阅地址只接受 http(s)', () => {
	assert.deepEqual(validateSubscriptions(['https://a/b', 'http://c']), []);
	assert.equal(validateSubscriptions(['ftp://x'])[0].msg, 'Subscription addresses must start with http:// or https://');
});

test('导入：预览去重、按订阅设置补选项、具名段名避开已有名字', () => {
	const p = previewLinks('ss://YWVzLTI1Ni1nY206cGFzcw@5.6.7.8:8388#A\n\nss://YWVzLTI1Ni1nY206cGFzcw@5.6.7.8:8388#A\nbad://x', {});
	assert.deepEqual(p.map(r => !!r.node), [true, false]);
	assert.deepEqual(importValues({ type: 'vless', tls: '1' }, { allowInsecure: true, packetEncoding: 'xudp' }), { type: 'vless', tls: '1', tls_insecure: '1', packet_encoding: 'xudp' });
	assert.deepEqual(importValues({ type: 'trojan', tls: '1' }, { allowInsecure: false, packetEncoding: 'xudp' }), { type: 'trojan', tls: '1' });
	const seq = [1, 1, 0xabc];
	assert.equal(sectionName('rule', ['rule_00000001'], () => seq.shift()), 'rule_00000abc');
	const seq2 = [1, 2];
	assert.deepEqual(planImport([{ type: 'socks' }, { type: 'http' }], { allowInsecure: false, packetEncoding: '' }, [], () => seq2.shift()).map(x => x.name), ['node_00000001', 'node_00000002']);
});

test('写入：关闭写 nil；守卫拒绝未知取值；清空订阅与空名单用 delete', async () => {
	const { calls, uci } = recorder();
	const svc = createHomeProxy({ call: async () => ({ result: true }) }, uci);
	await svc.turnOff('n1');
	await svc.useNode('n2');
	await svc.saveSubscriptions([]);
	await svc.saveAccess('except_listed', []);
	assert.deepEqual(calls, [['set', 'homeproxy', 'config', { main_node: 'nil', sight_last_node: 'n1' }], ['set', 'homeproxy', 'config', { main_node: 'n2' }], ['remove', 'homeproxy', 'subscription', ['subscription_url']],
		['set', 'homeproxy', 'control', { lan_proxy_mode: 'except_listed' }], ['remove', 'homeproxy', 'control', ['lan_direct_mac_addrs']]]);
	await assert.rejects(svc.checkSite('evil'), /Unknown site/);
	await assert.rejects(svc.readLog('../../etc/shadow'), /Unknown log/);
	await assert.rejects(svc.setLogLevel('trace'), /Unknown log level/);
	await assert.rejects(svc.saveDeviceRules([{ mac: 'nope', rule: 'gaming' }]), /Invalid device rule/);
	await assert.rejects(svc.startCoreTask('nuke'), /Unknown action/);
	await assert.rejects(svc.updateResource('x'), /Unknown resource/);
	assert.equal(await svc.checkSite('google'), true);
});

test('写入：分流与端口；离开自定义模式先定主节点', async () => {
	const { calls, uci } = recorder();
	const svc = createHomeProxy({ call: async () => ({}) }, uci);
	await svc.saveRouting({ mode: 'global', udpNode: 'same', dnsServer: '8.8.8.8', ports: 'all', ipv6: false });
	assert.deepEqual(calls, [['set', 'homeproxy', 'config', { main_udp_node: 'same', dns_server: '8.8.8.8', routing_mode: 'global' }], ['set', 'homeproxy', 'config', { ipv6_support: '0' }], ['remove', 'homeproxy', 'config', ['routing_port']]]);
	calls.length = 0;
	await svc.leaveCustom({ enabled: false, custom: { defaultOutbound: 'nil', outbounds: [] }, mainNode: '', nodes: [] }, { mode: 'global', udpNode: 'same', dnsServer: '8.8.8.8' });
	assert.deepEqual(calls[0], ['set', 'homeproxy', 'config', { main_node: 'nil' }]);
});

test('删除节点：在用的（主节点、UDP 节点、出站引用）拒绝', async () => {
	const { uci } = recorder();
	const svc = createHomeProxy({ call: async () => ({}) }, uci);
	const data = { mainNode: 'n1', udpNode: 'n3', used: ['n2'] };
	for (const id of ['n1', 'n2', 'n3']) await assert.rejects(svc.removeNodes([id], data), /in use/);
	await svc.removeNodes(['n4'], data);
});

test('自定义模式：切入时按模板建段并保持开关状态；开关写默认出站并记住上次的去向', async () => {
	const { calls, uci } = recorder();
	const svc = createHomeProxy({ call: async () => ({}) }, uci);
	const data = { enabled: true, mainNode: 'n1', nodes: [{ id: 'n1' }], dnsServer: '8.8.8.8', chinaDnsServer: '223.5.5.5', custom: { outbounds: [], order: [], defaultOutbound: 'nil' } };
	await svc.enterCustom(data, 'blank', s => s);
	assert.ok(calls.some(c => c[0] === 'add' && c[2] === 'routing_node'));
	assert.deepEqual(calls.at(-1), ['set', 'homeproxy', 'config', { routing_mode: 'custom' }]);
	calls.length = 0;
	const custom = { outbounds: [{ id: 'o1', enabled: true }], defaultOutbound: 'o1', lastOutbound: '', order: [] };
	await svc.setCustomPower(false, custom);
	assert.deepEqual(calls[0], ['set', 'homeproxy', 'routing', { default_outbound: 'nil', sight_last_outbound: 'o1' }]);
	await svc.setCustomPower(true, { ...custom, defaultOutbound: 'nil', lastOutbound: 'o1' });
	assert.deepEqual(calls[1], ['set', 'homeproxy', 'routing', { default_outbound: 'o1' }]);
});

test('即时操作：延迟、ping、核心任务、订阅任务、重启失败', async () => {
	const { uci } = recorder();
	const svc = createHomeProxy({ call: async (o, m, p) => {
		if (m === 'node_latency') return { results: { n1: 12, n2: 'udp' } };
		if (m === 'core_start') return { started: p.action === 'check' };
		if (m === 'subscription_start') return { started: false };
		if (m === 'subscription_task') return { running: true };
		if (m === 'setInitAction') return { result: false };
		return { stdout: p.params.at(-1) === '192.0.2.1' ? '100% packet loss' : 'round-trip min/avg/max = 5.0/6.4/8.0 ms' };
	} }, uci);
	assert.deepEqual(await svc.measureLatency(['n1', 'n2']), { n1: 12, n2: 'udp' });
	assert.equal(await svc.ping({ address: 'node.example' }), 6);
	assert.equal(await svc.ping({ address: '192.0.2.1' }), 'timeout');
	assert.equal(await svc.ping({ address: '2001:db8::1' }), 'unsupported');
	assert.equal(await svc.startCoreTask('check'), true);
	assert.equal(await svc.startCoreTask('upgrade'), false);
	assert.equal(await svc.startSubscriptionUpdate(), false);
	assert.equal(await svc.subscriptionUpdating(), true);
	await assert.rejects(svc.restart(), /Restart failed/);
});

test('域名列表：只写有变化的列表，代理开着时重载；非法域名拒绝', async () => {
	const calls = [];
	const svc = createHomeProxy({ call: async (o, m, p) => { calls.push([m, p]); return { result: true }; } }, {});
	const cur = { proxy_list: ['a.example'], direct_list: [] };
	await svc.saveDomainLists({ proxy_list: ['a.example', 'b.example'], direct_list: [] }, cur, true);
	assert.deepEqual(calls, [['acllist_write', { type: 'proxy_list', content: 'a.example\nb.example' }], ['setInitAction', { name: 'homeproxy', action: 'reload' }]]);
	await assert.rejects(svc.saveDomainLists({ proxy_list: ['-bad'], direct_list: [] }, cur, false), /Invalid domain/);
});
