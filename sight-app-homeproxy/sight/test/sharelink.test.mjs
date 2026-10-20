import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShareLink } from '../src/sharelink.js';
import { decodeBase64 } from '../src/validators.js';

const Q = { with_quic: true, with_utls: true };
const b64 = s => Buffer.from(s).toString('base64');

test('Base64：URL 安全字符与缺失填充均可解码，非法输入为 null', () => {
	assert.equal(decodeBase64(b64('aes-256-gcm:pa ss').replace(/=+$/, '')), 'aes-256-gcm:pa ss');
	assert.equal(decodeBase64('_-8'), decodeBase64('/+8'));
	assert.equal(decodeBase64('%%%'), null);
});

test('VLESS Reality：标签、TLS、Reality 参数与 flow', () => {
	const n = parseShareLink('vless://11111111-2222-3333-4444-555555555555@95.169.0.78:8443?type=tcp&security=reality&pbk=PUBKEY&sid=ab12&sni=www.example.com&fp=chrome&flow=xtls-rprx-vision#BWG%20Reality', Q);
	assert.deepEqual(n, {
		label: 'BWG Reality', type: 'vless', address: '95.169.0.78', port: '8443', uuid: '11111111-2222-3333-4444-555555555555',
		tls: '1', tls_sni: 'www.example.com', tls_reality: '1', tls_reality_public_key: 'PUBKEY', tls_reality_short_id: 'ab12', tls_utls: 'chrome', vless_flow: 'xtls-rprx-vision',
	});
});

test('VLESS WebSocket：路径里的 ?ed= 拆成早期数据选项；缺 type 或 kcp 拒绝', () => {
	const n = parseShareLink('vless://id@h.example:443?type=ws&security=tls&host=cdn.example&path=%2Fws%3Fed%3D2048#w', Q);
	assert.deepEqual([n.transport, n.ws_host, n.ws_path, n.websocket_early_data, n.websocket_early_data_header], ['ws', 'cdn.example', '/ws', '2048', 'Sec-WebSocket-Protocol']);
	assert.equal(parseShareLink('vless://id@h:443?security=tls', Q).transport, undefined);
	assert.equal(parseShareLink('vless://id@h:443?type=kcp', Q), null);
});

test('VMess（v2rayN JSON）：gRPC 与 h2 传输', () => {
	const grpc = parseShareLink('vmess://' + b64(JSON.stringify({ v: '2', ps: 'JP', add: 'jp.example', port: 443, id: 'uuid', aid: 0, net: 'grpc', path: 'svc', tls: 'tls', sni: 'jp.example' })), Q);
	assert.deepEqual([grpc.label, grpc.port, grpc.vmess_alterid, grpc.transport, grpc.grpc_servicename, grpc.tls], ['JP', '443', '0', 'grpc', 'svc', '1']);
	const h2 = parseShareLink('vmess://' + b64(JSON.stringify({ v: 2, add: 'a', port: '80', id: 'u', net: 'h2', host: 'x.com,y.com', path: '/p' })), Q);
	assert.deepEqual([h2.transport, h2.http_host, h2.label], ['http', ['x.com', 'y.com'], 'a:80']);
	assert.equal(parseShareLink('vmess://' + b64('{"v":"1"}'), Q), null);
});

test('Shadowsocks：SIP002、明文用户信息与整段 Base64 旧格式；未知加密方式拒绝', () => {
	const a = parseShareLink(`ss://${b64('aes-256-gcm:secret')}@1.2.3.4:8388?plugin=obfs-local%3Bobfs%3Dhttp#HK`, Q);
	assert.deepEqual([a.shadowsocks_encrypt_method, a.password, a.shadowsocks_plugin, a.shadowsocks_plugin_opts, a.label], ['aes-256-gcm', 'secret', 'obfs-local', 'obfs=http', 'HK']);
	const b = parseShareLink('ss://2022-blake3-aes-128-gcm:k%3Ae%3Ay@[2001:db8::1]:443#v6', Q);
	assert.deepEqual([b.address, b.password], ['2001:db8::1', 'k:e:y']);
	const c = parseShareLink(`ss://${b64('chacha20-ietf-poly1305:p@ss@5.6.7.8:1000')}#old`, Q);
	assert.deepEqual([c.address, c.port, c.password, c.label], ['5.6.7.8', '1000', 'p@ss', 'old']);
	assert.equal(parseShareLink(`ss://${b64('rc4-md5:x')}@1.2.3.4:1`, Q), null);
});

test('Trojan、Hysteria2、TUIC、SOCKS、HTTPS；QUIC 不可用时拒绝基于 QUIC 的协议', () => {
	const tj = parseShareLink('trojan://pw@t.example:443?type=ws&path=%2Ft&sni=t.example#T', Q);
	assert.deepEqual([tj.password, tj.transport, tj.ws_path, tj.tls], ['pw', 'ws', '/t', '1']);
	const hy = parseShareLink('hy2://auth@h.example:8443?obfs=salamander&obfs-password=o&insecure=1#H', Q);
	assert.deepEqual([hy.type, hy.password, hy.hysteria_obfs_type, hy.tls_insecure], ['hysteria2', 'auth', 'salamander', '1']);
	assert.equal(parseShareLink('hysteria2://auth@h.example:8443', {}), null);
	const tu = parseShareLink('tuic://uuid:pw@t.example:443?congestion_control=bbr&alpn=h3', Q);
	assert.deepEqual([tu.uuid, tu.password, tu.tuic_congestion_control, tu.tls_alpn], ['uuid', 'pw', 'bbr', ['h3']]);
	const so = parseShareLink('socks5://u:p@10.0.0.2:1080', Q);
	assert.deepEqual([so.type, so.socks_version, so.username, so.label], ['socks', '5', 'u', '10.0.0.2:1080']);
	const ht = parseShareLink('https://proxy.example', Q);
	assert.deepEqual([ht.type, ht.tls, ht.port], ['http', '1', '80']);
});

test('非法与不支持的链接返回 null', () => {
	for (const l of ['', 'not a link', 'wireguard://x@y:1', 'vless://@h:1?type=tcp', 'socks5://h:99999'])
		assert.equal(parseShareLink(l, Q), null, l);
});

test('与订阅脚本的解析对齐：vless 缺 type 按 tcp；ss 的 simple-obfs 改名 obfs-local；vmess 带 global padding 且标签解码', () => {
	assert.equal(parseShareLink('vless://11111111-2222-3333-4444-555555555555@h.example:443?security=tls#x', Q).transport, undefined);
	const ss = parseShareLink('ss://YWVzLTI1Ni1nY206cGFzcw@5.6.7.8:8388/?plugin=simple-obfs%3Bobfs%3Dhttp#A', Q);
	assert.deepEqual([ss.shadowsocks_plugin, ss.shadowsocks_plugin_opts], ['obfs-local', 'obfs=http']);
	const vm = parseShareLink('vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'JP%2001', add: 'v.example', port: 443, id: 'u', net: 'tcp' })).toString('base64'), Q);
	assert.deepEqual([vm.label, vm.vmess_global_padding], ['JP 01', '1']);
});
