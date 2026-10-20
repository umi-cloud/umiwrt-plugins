import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPortList, isDnsServer, routingForm, routingValues, routingKey, validateRouting, planPorts, planTraffic, planRouting, leaveCustomNode } from '../src/traffic.js';

test('端口列表：端口与范围；空、越界、倒序、分号拒绝', () => {
	assert.ok(isPortList('443') && isPortList(' 80, 443 ,8000-9000') && isPortList('1-65535'));
	assert.ok(!isPortList('') && !isPortList('0') && !isPortList('70000') && !isPortList('9000-8000') && !isPortList('80;443') && !isPortList('http'));
});

test('DNS 地址：wan、IP、带协议前缀的主机名；裸主机名拒绝', () => {
	assert.ok(isDnsServer('wan') && isDnsServer('8.8.8.8') && isDnsServer('2001:4860:4860::8888') && isDnsServer('tls://dns.google') && isDnsServer('https://1.1.1.1/dns-query') && isDnsServer('dns.google'));
	assert.ok(!isDnsServer('') && !isDnsServer('tls://') && !isDnsServer('http://1.1.1.1') && !isDnsServer('dhcp://auto'));
});

test('分流表单：预设项与自定义输入互转；没选用的自定义输入不算改动', () => {
	const d = { mode: 'global', udpNode: 'same', ports: 'common', portsCustom: '', ipv6: true, dnsServer: 'tls://dns.google', chinaDnsServer: '223.5.5.5' };
	const f = routingForm(d);
	assert.deepEqual([f.dns, f.dnsCustom, f.china, f.chinaCustom], ['custom', 'tls://dns.google', '223.5.5.5', '']);
	assert.deepEqual(routingValues(f), d);
	assert.equal(routingKey({ ...f, chinaCustom: 'leftover' }), routingKey(f));
	assert.notEqual(routingKey({ ...f, dnsCustom: 'changed' }), routingKey(f));
});

test('校验：返回 { msg, field }；自定义模式只校验端口', () => {
	const nodes = [{ id: 'n1' }];
	assert.deepEqual(validateRouting({ mode: 'global', udpNode: 'n2', ports: 'custom', portsCustom: 'x', dnsServer: 'http://x', chinaDnsServer: '' }, nodes).map(e => e.field), ['portsCustom', 'udpNode', 'dnsCustom']);
	assert.deepEqual(validateRouting({ mode: 'bypass_mainland_china', udpNode: 'nil', ports: 'all', dnsServer: '8.8.8.8', chinaDnsServer: 'tcp://' }, nodes).map(e => e.field), ['chinaCustom']);
	assert.deepEqual(validateRouting({ mode: 'global', udpNode: 'urltest', ports: 'all', dnsServer: '8.8.8.8' }, nodes), []);
	assert.deepEqual(validateRouting({ mode: 'custom', udpNode: 'n2', ports: 'common', dnsServer: 'bad' }, nodes), []);
	assert.equal(validateRouting({ mode: 'weird', ports: 'all' }, nodes)[0].msg, 'Unknown routing mode');
});

test('写入计划：全部端口用 delete；IPv6 只在给出布尔值时写；预设模式的值', () => {
	assert.deepEqual(planPorts('all'), { values: {}, remove: ['routing_port'] });
	assert.deepEqual(planPorts('common', 'x'), { values: { routing_port: 'common' }, remove: [] });
	assert.deepEqual(planPorts('custom', ' 80, 443,,8000-9000 '), { values: { routing_port: '80,443,8000-9000' }, remove: [] });
	assert.deepEqual(planTraffic({ ports: 'all', ipv6: false }), { values: { ipv6_support: '0' }, remove: ['routing_port'] });
	assert.deepEqual(planTraffic({ ports: 'common' }), { values: { routing_port: 'common' }, remove: [] });
	assert.throws(() => planTraffic({ ports: 'custom', portsCustom: 'x' }), /Invalid port list/);
	assert.throws(() => planTraffic({ ports: 'nope' }), /Unknown port choice/);
	assert.deepEqual(planRouting({ mode: 'bypass_mainland_china', udpNode: 'same', dnsServer: ' 8.8.8.8 ', chinaDnsServer: '223.5.5.5' }), { main_udp_node: 'same', dns_server: '8.8.8.8', routing_mode: 'bypass_mainland_china', china_dns_server: '223.5.5.5' });
	assert.deepEqual(planRouting({ mode: 'custom', udpNode: 'same', dnsServer: '8.8.8.8' }), { main_udp_node: 'same', dns_server: '8.8.8.8' });
});

test('离开自定义模式：代理开着取默认出站的节点，关着写 nil', () => {
	const custom = { defaultOutbound: 'o1', outbounds: [{ id: 'o1', node: 'n2' }] };
	assert.equal(leaveCustomNode({ enabled: true, custom, mainNode: 'n1', nodes: [{ id: 'n1' }, { id: 'n2' }] }), 'n2');
	assert.equal(leaveCustomNode({ enabled: true, custom: { defaultOutbound: 'direct-out', outbounds: [] }, mainNode: 'gone', nodes: [{ id: 'n1' }] }), 'n1');
	assert.equal(leaveCustomNode({ enabled: false, custom, mainNode: 'n1', nodes: [{ id: 'n1' }] }), 'nil');
});
