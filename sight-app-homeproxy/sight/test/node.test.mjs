import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeForm, planNode, validateNode, applicable } from '../src/node.js';

const features = { with_quic: true, with_utls: true };
const msgs = e => e.map(x => x.msg);

test('新建 VLESS Reality：只写适用的键，布尔值写 1，空值不写', () => {
	const f = { ...nodeForm(), type: 'vless', label: 'Tokyo', address: 'jp.example', port: '443', uuid: '0b6a8c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d',
		vless_flow: 'xtls-rprx-vision', tls: true, tls_sni: 'www.example.com', tls_reality: true, tls_reality_public_key: 'PUB', tls_reality_short_id: 'ab12', tls_utls: 'chrome' };
	assert.deepEqual(validateNode(f, features), []);
	const { values, remove } = planNode(f);
	assert.deepEqual(values, { label: 'Tokyo', address: 'jp.example', port: '443', type: 'vless', uuid: '0b6a8c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d', vless_flow: 'xtls-rprx-vision',
		packet_encoding: 'xudp', tls: '1', tls_sni: 'www.example.com', tls_utls: 'chrome', tls_reality: '1', tls_reality_public_key: 'PUB', tls_reality_short_id: 'ab12' });
	assert.deepEqual(remove, []);
});

test('编辑：未管理的选项不出现在计划里；清空的受管键与当前协议用不到的受管键删除', () => {
	const raw = { '.name': 'n1', '.type': 'node', type: 'vmess', label: 'HK', address: '1.2.3.4', port: '443', uuid: '0b6a8c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d', vmess_encrypt: 'auto',
		tls: '1', tls_sni: 'a.example', transport: 'ws', ws_path: '/ray', ws_host: 'a.example', multiplex: '1', multiplex_protocol: 'smux', grouphash: 'abc', tls_min_version: '1.2' };
	const f = nodeForm(raw);
	f.transport = 'grpc'; f.grpc_servicename = 'svc'; f.tls_sni = '';
	const { values, remove } = planNode(f, raw);
	assert.equal(values.grpc_servicename, 'svc');
	assert.ok(!('multiplex' in values) && !('tls_min_version' in values) && !('grouphash' in values));
	assert.deepEqual(remove.sort(), ['tls_sni', 'ws_host', 'ws_path']);
});

test('换协议：上一种协议的专属选项（含不受管的多路复用）删除，通用选项保留', () => {
	const raw = { '.name': 'n1', type: 'vmess', label: 'A', address: 'a.example', port: '443', uuid: 'x', vmess_encrypt: 'auto', multiplex: '1', tcp_fast_open: '1', grouphash: 'g' };
	const f = { ...nodeForm(raw), type: 'trojan', password: 'pw' };
	const { values, remove } = planNode(f, raw);
	assert.equal(values.type, 'trojan');
	assert.deepEqual(remove.sort(), ['multiplex', 'uuid', 'vmess_encrypt']);
});

test('Hysteria2 / TUIC 强制 TLS；QUIC 不可用时拒绝', () => {
	const f = { ...nodeForm(), type: 'hysteria2', address: 'h.example', port: '443', password: 'p', hysteria_obfs_type: 'salamander', hysteria_obfs_password: 'o' };
	assert.equal(planNode(f).values.tls, '1');
	assert.ok(applicable(f).has('hysteria_obfs_password') && !applicable(f).has('tls_utls'));
	assert.deepEqual(msgs(validateNode(f, {})), ['This sing-box build does not support %s']);
	const tuic = { ...nodeForm(), type: 'tuic', address: 't.example', port: '443', uuid: 'bad' };
	assert.deepEqual(msgs(validateNode(tuic, features)), ['Enter a UUID such as 0b6a8c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d']);
});

test('校验：地址、端口、必填密码、2022 密钥长度、Reality 与 uTLS、flow、整数与端口跳跃', () => {
	const ss = { ...nodeForm(), address: 'bad host', port: '70000', shadowsocks_encrypt_method: '2022-blake3-aes-128-gcm', password: 'c2hvcnQ=' };
	assert.deepEqual(msgs(validateNode(ss, features)), ['Enter a domain name or IP address', 'Port must be between 1 and 65535', 'This encryption method needs a %d-byte key in Base64']);
	assert.deepEqual(validateNode({ ...ss, address: '1.2.3.4', port: '8388', password: 'MDEyMzQ1Njc4OWFiY2RlZg==' }, features), []);
	assert.deepEqual(msgs(validateNode({ ...nodeForm(), type: 'trojan', address: 'a.example', port: '443' }, features)), ['Enter the password']);
	assert.deepEqual(validateNode({ ...nodeForm(), shadowsocks_encrypt_method: 'none', address: 'a.example', port: '1' }, features), []);
	const vless = { ...nodeForm(), type: 'vless', address: 'a.example', port: '443', uuid: '0b6a8c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d', tls: true, tls_reality: true, tls_utls: '360', vless_flow: 'xtls-rprx-vision', transport: 'ws' };
	assert.deepEqual(msgs(validateNode(vless, features)), ['Enter the REALITY public key', 'This fingerprint does not work with REALITY or flow control', 'Flow control needs TLS without a transport']);
	const hy = { ...nodeForm(), type: 'hysteria2', address: 'a.example', port: '443', hysteria_up_mbps: 'fast', hysteria_hopping_port: ['20000:30000', 'x'] };
	assert.deepEqual(msgs(validateNode(hy, features)), ['Enter a whole number', 'Enter ports or ranges such as 20000:30000']);
});

test('不支持的协议只写名称、地址与端口；未填名称时用 地址:端口', () => {
	const raw = { '.name': 'w', type: 'wireguard', address: 'wg.example', port: '51820', wireguard_private_key: 'k' };
	const f = { ...nodeForm(raw), address: 'wg2.example' };
	assert.deepEqual(planNode(f, raw), { values: { label: 'wg2.example:51820', address: 'wg2.example', port: '51820' }, remove: [] });
});
