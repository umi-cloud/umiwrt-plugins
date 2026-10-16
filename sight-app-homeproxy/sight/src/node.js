/*
 * 手工添加/编辑节点（uci 'node' 节）的表单模型：按协议决定显示与写入哪些选项，校验为纯函数。
 * 选项名与取值以 generate_client.uc 的 generate_outbound 为准。
 * 只写表单管理的键（MANAGED）；当前协议用不到的受管键删除——sing-box 严格解析配置，残留的字段会让检查失败。
 * 换协议时连同不受管的协议专属选项一并清掉，只留 KEEP 里的通用选项。
 */
import { isIPv4, isIPv6, isHostname, toList } from '@sight/sdk/lib';
import { SS_METHODS } from './sharelink.js';

export { SS_METHODS };
export const NODE_TYPES = ['shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'socks', 'http'];
/* 需要 sing-box 带 with_quic 编译 */
export const QUIC_TYPES = ['hysteria2', 'tuic'];
export const TRANSPORTS = ['', 'ws', 'grpc', 'http', 'httpupgrade'];
export const VMESS_SECURITY = ['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'];
export const VLESS_FLOWS = ['', 'xtls-rprx-vision'];
export const UTLS = ['', 'chrome', 'firefox', 'safari', 'ios', 'edge', 'android', '360', 'qq', 'random', 'randomized'];
export const PACKET_ENCODINGS = ['', 'xudp', 'packetaddr'];
export const SS_PLUGINS = ['', 'obfs-local', 'v2ray-plugin'];
export const SOCKS_VERSIONS = ['5', '4a', '4'];
export const TUIC_CONGESTION = ['cubic', 'new_reno', 'bbr'];
export const TUIC_RELAY = ['', 'native', 'quic'];
export const HY2_OBFS = ['', 'salamander'];

const TLS_TYPES = ['vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'http'];
const TLS_REQUIRED = ['hysteria2', 'tuic'];
const TRANSPORT_TYPES = ['vmess', 'vless', 'trojan'];
/* 2022 系列方法的密钥是固定字节数的 Base64 */
const SS_KEY_BYTES = { '2022-blake3-aes-128-gcm': 16, '2022-blake3-aes-256-gcm': 32, '2022-blake3-chacha20-poly1305': 32 };

const BOOLS = ['udp_over_tcp', 'tuic_enable_zero_rtt', 'tls', 'tls_insecure', 'tls_reality'];
const LISTS = ['tls_alpn', 'http_host', 'hysteria_hopping_port'];
const STRINGS = ['username', 'password', 'uuid', 'shadowsocks_encrypt_method', 'shadowsocks_plugin', 'shadowsocks_plugin_opts', 'socks_version',
	'vmess_encrypt', 'vmess_alterid', 'vless_flow', 'packet_encoding', 'hysteria_obfs_type', 'hysteria_obfs_password', 'hysteria_up_mbps',
	'hysteria_down_mbps', 'hysteria_hop_interval', 'tuic_congestion_control', 'tuic_udp_relay_mode', 'tuic_heartbeat', 'tls_sni', 'tls_utls',
	'tls_reality_public_key', 'tls_reality_short_id', 'transport', 'ws_host', 'ws_path', 'websocket_early_data', 'websocket_early_data_header',
	'grpc_servicename', 'http_path', 'httpupgrade_host'];
export const MANAGED = [...STRINGS, ...BOOLS, ...LISTS];
const KEEP = ['label', 'address', 'port', 'grouphash', 'tcp_fast_open', 'tcp_multi_path', 'udp_fragment'];

export const supported = type => NODE_TYPES.includes(type);
export const hasTls = type => TLS_TYPES.includes(type);
export const tlsRequired = type => TLS_REQUIRED.includes(type);
export const hasTransport = type => TRANSPORT_TYPES.includes(type);

/** 纯函数：uci 节 → 表单值；新建时 section 为空 */
export function nodeForm(section = {}) {
	const s = section || {};
	const f = { type: s.type || 'shadowsocks', label: s.label || '', address: s.address || '', port: s.port || '' };
	for (const k of STRINGS) f[k] = s[k] ?? '';
	for (const k of BOOLS) f[k] = s[k] === '1';
	/* 列表复制一份，表单不能改到页面数据 */
	for (const k of LISTS) f[k] = [...toList(s[k])];
	if (!section?.type) Object.assign(f, { shadowsocks_encrypt_method: 'aes-128-gcm', vmess_encrypt: 'auto', socks_version: '5', tuic_congestion_control: 'cubic', packet_encoding: 'xudp' });
	return f;
}

/** 纯函数：在当前协议、传输方式与 TLS 设置下适用的受管键 */
export function applicable(f) {
	const keys = new Set();
	const add = (...k) => k.forEach(x => keys.add(x));
	switch (f.type) {
		case 'shadowsocks':
			add('shadowsocks_encrypt_method', 'password', 'shadowsocks_plugin', 'udp_over_tcp');
			if (f.shadowsocks_plugin) add('shadowsocks_plugin_opts');
			break;
		case 'socks':
			add('socks_version', 'username', 'udp_over_tcp');
			if (f.socks_version === '5') add('password');
			break;
		case 'http': add('username', 'password'); break;
		case 'vmess': add('uuid', 'vmess_encrypt', 'vmess_alterid', 'packet_encoding'); break;
		case 'vless': add('uuid', 'vless_flow', 'packet_encoding'); break;
		case 'trojan': add('password'); break;
		case 'hysteria2':
			add('password', 'hysteria_obfs_type', 'hysteria_up_mbps', 'hysteria_down_mbps', 'hysteria_hopping_port');
			if (f.hysteria_obfs_type) add('hysteria_obfs_password');
			if (f.hysteria_hopping_port.length) add('hysteria_hop_interval');
			break;
		case 'tuic': add('uuid', 'password', 'tuic_congestion_control', 'tuic_udp_relay_mode', 'tuic_enable_zero_rtt', 'tuic_heartbeat'); break;
	}
	if (hasTls(f.type)) {
		add('tls');
		if (f.tls || tlsRequired(f.type)) {
			add('tls_sni', 'tls_insecure', 'tls_alpn');
			if (!tlsRequired(f.type)) add('tls_utls');
			if (f.type === 'vless') add('tls_reality');
			if (f.type === 'vless' && f.tls_reality) add('tls_reality_public_key', 'tls_reality_short_id');
		}
	}
	if (hasTransport(f.type)) {
		add('transport');
		if (f.transport === 'ws') add('ws_host', 'ws_path', 'websocket_early_data', 'websocket_early_data_header');
		else if (f.transport === 'grpc') add('grpc_servicename');
		else if (f.transport === 'http') add('http_host', 'http_path');
		else if (f.transport === 'httpupgrade') add('httpupgrade_host', 'http_path');
	}
	return keys;
}

/**
 * 纯函数：表单 → 写入计划。section 为原有节（新建为空）。
 * 不认识的协议（如 WireGuard、SSH）只写名称、地址与端口，其余原样保留。
 * @returns {{ values: Record<string, string | string[]>, remove: string[] }}
 */
export function planNode(f, section = {}) {
	const s = section || {};
	const values = { label: f.label.trim() || `${f.address.trim()}:${String(f.port).trim()}`, address: f.address.trim(), port: String(f.port).trim() };
	const remove = new Set();
	if (!supported(f.type)) return { values, remove: [] };
	values.type = f.type;
	const keys = applicable(f);
	for (const k of MANAGED) {
		const has = s[k] != null && s[k] !== '';
		if (!keys.has(k)) { if (has) remove.add(k); continue; }
		if (BOOLS.includes(k)) {
			/* hysteria2 / tuic 必须启用 TLS */
			const on = k === 'tls' && tlsRequired(f.type) ? true : f[k];
			if (on) values[k] = '1';
			else if (has && s[k] !== '0') remove.add(k);
		} else if (LISTS.includes(k)) {
			const v = f[k].map(x => String(x).trim()).filter(Boolean);
			if (v.length) values[k] = v; else if (has) remove.add(k);
		} else {
			const v = String(f[k] ?? '').trim();
			if (v) values[k] = v; else if (has) remove.add(k);
		}
	}
	/* 换协议：上一种协议的专属选项（含表单不管理的，如多路复用）一并清掉 */
	if (s.type && s.type !== f.type)
		for (const k of Object.keys(s)) if (!k.startsWith('.') && !KEEP.includes(k) && !(k in values)) remove.add(k);
	return { values, remove: [...remove] };
}

const isHost = v => isIPv4(v) || isIPv6(v) || isHostname(v);
const isPort = v => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
const isUint = v => /^\d+$/.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function base64Bytes(v) {
	try {
		if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return -1;
		const s = v.replace(/-/g, '+').replace(/_/g, '/');
		return atob(s + '='.repeat((4 - s.length % 4) % 4)).length;
	} catch { return -1; }
}

/**
 * 纯函数：节点表单校验。features 为 singbox_get_features 的结果。
 * @returns {{ msg: string, args?: (string | number)[], field: string }[]} msg 为英文 msgid，field 为选项名
 */
export function validateNode(f, features = {}) {
	const e = [], err = (field, msg, ...args) => e.push({ field, msg, args });
	const keys = supported(f.type) ? applicable(f) : new Set();
	const val = k => String(f[k] ?? '').trim();
	if (supported(f.type) && QUIC_TYPES.includes(f.type) && !features.with_quic) err('type', 'This sing-box build does not support %s', f.type);
	if (!val('address')) err('address', 'Enter the server address');
	else if (!isHost(val('address'))) err('address', 'Enter a domain name or IP address');
	if (!isPort(String(f.port).trim())) err('port', 'Port must be between 1 and 65535');
	if (keys.has('uuid')) {
		if (!val('uuid')) err('uuid', 'Enter the UUID');
		else if (!UUID.test(val('uuid'))) err('uuid', 'Enter a UUID such as 0b6a8c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d');
	}
	const passwordRequired = f.type === 'trojan' || (f.type === 'shadowsocks' && f.shadowsocks_encrypt_method !== 'none');
	if (keys.has('password') && passwordRequired && !val('password')) err('password', 'Enter the password');
	const keyBytes = SS_KEY_BYTES[f.shadowsocks_encrypt_method];
	if (f.type === 'shadowsocks' && keyBytes && val('password') && !val('password').split(':').every(p => base64Bytes(p) === keyBytes))
		err('password', 'This encryption method needs a %d-byte key in Base64', keyBytes);
	for (const k of ['vmess_alterid', 'hysteria_up_mbps', 'hysteria_down_mbps', 'hysteria_hop_interval', 'tuic_heartbeat', 'websocket_early_data'])
		if (keys.has(k) && val(k) && !isUint(val(k))) err(k, 'Enter a whole number');
	if (keys.has('hysteria_obfs_password') && !val('hysteria_obfs_password')) err('hysteria_obfs_password', 'Enter the obfuscation password');
	if (keys.has('hysteria_hopping_port') && !f.hysteria_hopping_port.every(p => /^\d{1,5}(:\d{1,5})?$/.test(String(p).trim())))
		err('hysteria_hopping_port', 'Enter ports or ranges such as 20000:30000');
	if (keys.has('tls_reality')) {
		if (f.tls_reality && !val('tls_reality_public_key')) err('tls_reality_public_key', 'Enter the REALITY public key');
		if (f.tls_reality && keys.has('tls_reality_short_id') && val('tls_reality_short_id') && !/^[0-9a-f]{0,16}$/i.test(val('tls_reality_short_id')))
			err('tls_reality_short_id', 'The short ID is up to 16 hexadecimal digits');
	}
	if (keys.has('tls_utls')) {
		const reality = f.type === 'vless' && f.tls_reality;
		if (reality && features.with_utls && !val('tls_utls')) err('tls_utls', 'REALITY needs a uTLS fingerprint');
		if ((reality || val('vless_flow')) && ['360', 'android'].includes(val('tls_utls'))) err('tls_utls', 'This fingerprint does not work with REALITY or flow control');
	}
	if (keys.has('vless_flow') && val('vless_flow') && (!f.tls || f.transport)) err('vless_flow', 'Flow control needs TLS without a transport');
	if (keys.has('tls_alpn') && !f.tls_alpn.every(a => /^\S+$/.test(String(a).trim()))) err('tls_alpn', 'ALPN values cannot contain spaces');
	if (keys.has('http_host') && !f.http_host.every(h => isHost(String(h).trim()))) err('http_host', 'Enter domain names or IP addresses');
	return e;
}
