/*
 * 路由器终端：经 sight.ttyd 启动、查询、结束一次性的 ttyd 会话（设备端见 root/usr/share/rpcd/ucode/sight.ttyd）。
 * 会话在新标签页打开：地址的主机名与浏览器访问 Sight 时相同，https 访问时终端同样走 https。
 * 设备端失败用 ubus 状态码，这里译成可处理的说明。
 */
const NOT_LAN = 'The terminal is only available when Sight is opened through a LAN address of the router';
const NO_CERT = 'Sight is opened over HTTPS, but the router’s certificate was not found, so the terminal cannot use HTTPS';
const NO_TTYD = 'ttyd is not installed. Reinstall sight-app-ttyd.';
const GONE = 'This terminal session no longer exists.';

/** 状态码 → 说明；其余错误原样抛出 */
export function explain(e, tls = false) {
	if (e?.kind !== 'status') return e;
	const text = { 6: NOT_LAN, 8: tls ? NO_CERT : NO_TTYD, 4: GONE }[e.status];
	return text ? new Error(text) : e;
}

/** 一次性地址：IPv6 主机名加方括号 */
export function terminalUrl(location, session) {
	const host = location.hostname.includes(':') && !location.hostname.startsWith('[') ? `[${location.hostname}]` : location.hostname;
	return `${session.tls ? 'https' : 'http'}://${host}:${session.port}${session.path}`;
}

export function createTerminal(client) {
	const call = async (method, params, tls) => {
		try { return await client.call('sight.ttyd', method, params); }
		catch (e) { throw explain(e, tls); }
	};
	return {
		/** @returns {Promise<{ session, url }>} */
		async start(location) {
			const tls = location.protocol === 'https:';
			const r = await call('start', { host: location.hostname, tls }, tls);
			return { session: r.session, url: terminalUrl(location, r.session) };
		},
		async status(id) { return (await call('status', { id })).session; },
		async stop(id) { await call('stop', { id }); },
	};
}
