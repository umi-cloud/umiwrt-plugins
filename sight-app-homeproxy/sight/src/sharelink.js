/*
 * 代理分享链接解析：vless / vmess / trojan / ss / hysteria2(hy2) / tuic / anytls / socks / http(s)。
 * 输出 HomeProxy 节点（uci 'node' 节）的选项；字段名与 HomeProxy 一致，未给出的选项不出现。
 * 不支持的协议或传输方式（如 kcp）、缺少必需字段的链接返回 null，不猜测补全。
 * features 为 luci.homeproxy singbox_get_features 的结果，用于判断 QUIC、uTLS 是否可用。
 */

export const SS_METHODS = ['none', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
	'2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305'];

/** URL 安全与标准 Base64 均可，补齐填充后按 UTF-8 解码；非法输入返回 null */
export function decodeBase64(text) {
	if (!text) return null;
	try {
		let s = text.trim().replace(/-/g, '+').replace(/_/g, '/');
		s += '='.repeat((4 - s.length % 4) % 4);
		const bin = atob(s);
		return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
	} catch { return null; }
}

const dec = v => { if (v == null || v === '') return null; try { return decodeURIComponent(v); } catch { return v; } };
const list = v => v ? v.split(',').map(s => s.trim()).filter(Boolean) : null;

/** 把 scheme://rest 按 http URL 解析，便于统一取用户信息、主机、端口与参数。
 *  http 的默认端口 80 会被 URL 规范化为空串，与 HomeProxy 一致按 80 处理 */
function asUrl(rest) {
	try { return new URL('http://' + rest); } catch { return null; }
}

/* ws 路径里的 ?ed=N 表示早期数据长度，HomeProxy 用单独选项承载 */
function wsOptions(host, path) {
	const o = { ws_host: host || null, ws_path: path || null };
	if (o.ws_path?.includes('?ed=')) {
		const [p, ed] = o.ws_path.split('?ed=');
		o.ws_path = p; o.websocket_early_data = ed; o.websocket_early_data_header = 'Sec-WebSocket-Protocol';
	}
	return o;
}

/* 各传输方式的附加选项（vless / trojan 的查询参数写法） */
function transportOptions(type, q, { withHeaderHttp = false } = {}) {
	switch (type) {
		case 'grpc': return { grpc_servicename: q.get('serviceName') };
		case 'ws': return wsOptions(dec(q.get('host')), dec(q.get('path')));
		case 'httpupgrade': return { httpupgrade_host: dec(q.get('host')), http_path: dec(q.get('path')) };
		case 'http': return { http_host: list(dec(q.get('host'))), http_path: dec(q.get('path')) };
		case 'tcp': return withHeaderHttp && q.get('headerType') === 'http' ? { transport: 'http', http_host: list(dec(q.get('host'))), http_path: dec(q.get('path')) } : {};
		default: return {};
	}
}

const parsers = {
	vless(rest, f) {
		const u = asUrl(rest); if (!u) return null;
		const q = u.searchParams, type = q.get('type');
		if (!u.username || !type || type === 'kcp') return null;
		if (type === 'quic' && (!f.with_quic || (q.get('quicSecurity') && q.get('quicSecurity') !== 'none'))) return null;
		const security = q.get('security');
		return {
			label: dec(u.hash.slice(1)), type: 'vless', address: u.hostname, port: u.port || '80', uuid: dec(u.username),
			transport: type !== 'tcp' ? type : null,
			tls: ['tls', 'xtls', 'reality'].includes(security) ? '1' : '0', tls_sni: q.get('sni'), tls_alpn: list(dec(q.get('alpn'))),
			tls_reality: security === 'reality' ? '1' : '0', tls_reality_public_key: dec(q.get('pbk')), tls_reality_short_id: q.get('sid'),
			tls_utls: f.with_utls ? q.get('fp') : null, vless_flow: ['tls', 'reality'].includes(security) ? q.get('flow') : null,
			...transportOptions(type, q, { withHeaderHttp: true }),
		};
	},
	vmess(rest, f) {
		let v;
		try { v = JSON.parse(decodeBase64(rest) || ''); } catch { return null; }
		if (!v || String(v.v) !== '2' || v.net === 'kcp') return null;
		if (v.net === 'quic' && (!f.with_quic || (v.type && v.type !== 'none'))) return null;
		const node = {
			label: v.ps || null, type: 'vmess', address: v.add, port: v.port != null ? String(v.port) : '', uuid: v.id,
			vmess_alterid: v.aid != null ? String(v.aid) : null, vmess_encrypt: v.scy || 'auto',
			transport: v.net && v.net !== 'tcp' ? v.net : null,
			tls: v.tls === 'tls' ? '1' : '0', tls_sni: v.sni || v.host || null, tls_alpn: list(v.alpn), tls_utls: f.with_utls ? (v.fp || null) : null,
		};
		if (v.net === 'grpc') node.grpc_servicename = v.path || null;
		else if (v.net === 'ws') Object.assign(node, wsOptions(v.host, v.path));
		else if (v.net === 'httpupgrade') Object.assign(node, { httpupgrade_host: v.host || null, http_path: v.path || null });
		else if (v.net === 'h2' || (v.net === 'tcp' && v.type === 'http')) Object.assign(node, { transport: 'http', http_host: list(v.host), http_path: v.path || null });
		return node;
	},
	trojan(rest) {
		const u = asUrl(rest); if (!u || !u.username) return null;
		const q = u.searchParams, type = q.get('type');
		return {
			label: dec(u.hash.slice(1)), type: 'trojan', address: u.hostname, port: u.port || '80', password: dec(u.username),
			transport: type && type !== 'tcp' ? type : null, tls: '1', tls_sni: q.get('sni'),
			...(type === 'grpc' || type === 'ws' ? transportOptions(type, q) : {}),
		};
	},
	ss(rest) {
		/* SIP002：ss://base64(method:password)@host:port#label；旧格式：ss://base64(method:password@host:port)#label */
		const [body, hash = ''] = rest.split('#');
		const label = hash ? `#${hash}` : '';
		let u = body.includes('@') ? asUrl(body + label) : null;
		if (!u) { const whole = decodeBase64(body.split('?')[0]); if (!whole) return null; u = asUrl(whole + label); }
		if (!u || !u.username) return null;
		let method, password;
		if (u.password) { method = dec(u.username); password = dec(u.password); }
		else {
			const info = decodeBase64(dec(u.username)); if (!info || !info.includes(':')) return null;
			method = info.slice(0, info.indexOf(':')); password = info.slice(info.indexOf(':') + 1);
		}
		if (!SS_METHODS.includes(method)) return null;
		const plugin = u.searchParams.get('plugin')?.split(';');
		return {
			label: dec(u.hash.slice(1)), type: 'shadowsocks', address: u.hostname, port: u.port || '80', shadowsocks_encrypt_method: method, password,
			shadowsocks_plugin: plugin?.[0] || null, shadowsocks_plugin_opts: plugin && plugin.length > 1 ? plugin.slice(1).join(';') : null,
		};
	},
	hysteria2(rest, f) {
		if (!f.with_quic) return null;
		const u = asUrl(rest); if (!u) return null;
		const q = u.searchParams;
		return {
			label: dec(u.hash.slice(1)), type: 'hysteria2', address: u.hostname, port: u.port || '80',
			password: u.username ? dec(u.username + (u.password ? ':' + u.password : '')) : null,
			hysteria_obfs_type: q.get('obfs'), hysteria_obfs_password: q.get('obfs-password'),
			tls: '1', tls_sni: q.get('sni'), tls_insecure: q.get('insecure') && q.get('insecure') !== '0' ? '1' : '0',
		};
	},
	tuic(rest, f) {
		if (!f.with_quic) return null;
		const u = asUrl(rest); if (!u || !u.username) return null;
		const q = u.searchParams;
		return {
			label: dec(u.hash.slice(1)), type: 'tuic', address: u.hostname, port: u.port || '80', uuid: dec(u.username), password: dec(u.password),
			tuic_congestion_control: q.get('congestion_control'), tuic_udp_relay_mode: q.get('udp_relay_mode'),
			tls: '1', tls_sni: q.get('sni'), tls_alpn: list(dec(q.get('alpn'))),
		};
	},
	anytls(rest) {
		const u = asUrl(rest); if (!u || !u.username) return null;
		const q = u.searchParams;
		return { label: dec(u.hash.slice(1)), type: 'anytls', address: u.hostname, port: u.port || '80', password: dec(u.username), tls: '1', tls_sni: q.get('sni'), tls_insecure: q.get('insecure') === '1' ? '1' : '0' };
	},
	socks(rest, f, scheme) {
		const u = asUrl(rest); if (!u) return null;
		return { label: dec(u.hash.slice(1)), type: 'socks', address: u.hostname, port: u.port || '80', username: dec(u.username), password: dec(u.password), socks_version: scheme.includes('4') ? '4' : '5' };
	},
	http(rest, f, scheme) {
		const u = asUrl(rest); if (!u) return null;
		return { label: dec(u.hash.slice(1)), type: 'http', address: u.hostname, port: u.port || '80', username: dec(u.username), password: dec(u.password), tls: scheme === 'https' ? '1' : '0' };
	},
};
const ALIASES = { hy2: 'hysteria2', https: 'http', socks4: 'socks', socks4a: 'socks', socks5: 'socks', socks5h: 'socks' };

/**
 * @param {string} link
 * @param {{ with_quic?: boolean, with_utls?: boolean }} [features]
 * @returns {Record<string, string | string[]> | null} 仅含非空选项；无标签时以 地址:端口 命名
 */
export function parseShareLink(link, features = {}) {
	const m = String(link || '').trim().match(/^([a-z0-9]+):\/\/(.+)$/i);
	if (!m) return null;
	const scheme = m[1].toLowerCase(), parse = parsers[ALIASES[scheme] || scheme];
	if (!parse) return null;
	let node;
	try { node = parse(m[2], features, scheme); } catch { return null; }
	if (!node || !node.address || !node.port) return null;
	node.address = node.address.replace(/^\[|\]$/g, '');
	if (!/^\d{1,5}$/.test(node.port) || Number(node.port) < 1 || Number(node.port) > 65535) return null;
	if (!node.label) node.label = `${node.address}:${node.port}`;
	return Object.fromEntries(Object.entries(node).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)));
}
