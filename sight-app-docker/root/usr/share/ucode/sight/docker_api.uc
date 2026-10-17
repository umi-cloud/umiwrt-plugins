// Docker 引擎 HTTP 客户端，供本包的后台任务（/usr/libexec/sight-docker-task）使用：
// 一次请求读完整个响应；带 on_line 时按行回调逐行 JSON（拉取镜像的进度流）。
// 套接字地址沿用 sight.docker_socket（dockerd.globals.hosts）。

'use strict';

import * as socket from 'socket';
import { cursor } from 'uci';
import * as ds from 'sight.docker_socket';

/* 守护进程超过这么久没有任何输出视为卡住（毫秒） */
const IDLE_TIMEOUT = 300000;

function urlencode(value) {
	return replace('' + value, /[^A-Za-z0-9_.~-]/g, (c) => sprintf('%%%02X', ord(c)));
}

function api_prefix() {
	const ctx = cursor();
	const v = ctx.get('dockerd', 'globals', 'api_version') || '';
	ctx.unload();
	return v ? '/' + v : '';
}

// 请求：返回 { code, body }；连接失败 code 为 0、body.message 为原因。
// opts: { query: {}, body: 对象（JSON）, on_line: fn(msg)（逐行 JSON，此时 body 为 null）, timeout: 毫秒 }
export function request(method, path, opts) {
	opts ??= {};
	let qs = [];
	for (let k, v in opts.query)
		push(qs, urlencode(k) + '=' + urlencode(type(v) == 'bool' ? (v ? 'true' : 'false') : v));
	const url = api_prefix() + path + (length(qs) ? '?' + join('&', qs) : '');
	const payload = opts.body != null ? sprintf('%J', opts.body) : '';

	const dest = ds.get_socket_dest_compat();
	const sock = socket.create(dest.family, socket.SOCK_STREAM);
	if (!sock || !sock.connect(dest))
		return { code: 0, body: { message: 'Failed to connect to Docker' } };
	const head = [`${method} ${url} HTTP/1.1`, 'Host: docker', 'User-Agent: sight-docker-task/1', 'Connection: close'];
	if (opts.body != null) push(head, 'Content-Type: application/json');
	push(head, 'Content-Length: ' + length(payload), '', '');
	sock.send(join('\r\n', head) + payload);

	const timeout = opts.timeout || IDLE_TIMEOUT;
	let buf = '', header = null, code = 0, chunked = false, ended = false, body = '';
	const lines = [];

	/* 逐行处理已解出的正文；不完整的末行留到下次 */
	function feed_lines(final) {
		let nl;
		while ((nl = index(body, '\n')) >= 0 || (final && length(body))) {
			const line = trim(nl >= 0 ? substr(body, 0, nl) : body);
			body = nl >= 0 ? substr(body, nl + 1) : '';
			if (!line) continue;
			let msg;
			try { msg = json(line); } catch { continue; }
			if (code < 300) opts.on_line(msg);
			else push(lines, msg);
		}
	}
	/* 分块编码：从 buf 解出完整的块追加到 body */
	function dechunk() {
		while (true) {
			const m = match(buf, /^([0-9a-fA-F]+)[^\r\n]*\r\n/);
			if (!m) return;
			const size = int(m[1], 16);
			if (size == 0) { ended = true; return; }
			if (length(buf) < length(m[0]) + size + 2) return;
			body += substr(buf, length(m[0]), size);
			buf = substr(buf, length(m[0]) + size + 2);
		}
	}

	let clen = null;
	while (!ended) {
		const ready = socket.poll(timeout, [sock, socket.POLLIN]);
		if (!ready || !length(ready)) { sock.close(); return { code: 0, body: { message: 'Docker stopped responding' } }; }
		const data = sock.recv(8192);
		if (!data) break;
		buf += data;
		if (!header) {
			const end = index(buf, '\r\n\r\n');
			if (end < 0) continue;
			header = substr(buf, 0, end);
			buf = substr(buf, end + 4);
			code = int(match(header, /^HTTP\/\S+\s+(\d+)/)?.[1] || 0);
			chunked = !!match(lc(header), /\r\ntransfer-encoding:\s*chunked/);
			const cl = match(lc(header), /\r\ncontent-length:\s*(\d+)/);
			if (cl) clen = int(cl[1]);
		}
		if (chunked) dechunk();
		else { body += buf; buf = ''; if (clen != null && length(body) >= clen) ended = true; }
		if (opts.on_line) feed_lines(false);
	}
	sock.close();
	if (!header) return { code: 0, body: { message: 'No response from Docker' } };
	if (chunked && !ended) return { code: 0, body: { message: 'The connection to Docker was interrupted' } };

	if (opts.on_line) {
		feed_lines(true);
		return { code: code, body: code < 300 ? null : (lines[0] || { message: `HTTP ${code}` }) };
	}
	let parsed = body;
	if (length(body) && match(lc(header), /\r\ncontent-type:\s*application\/json/)) {
		try { parsed = json(body); } catch { parsed = body; }
	}
	return { code: code, body: parsed };
};

// 失败原因：Docker 的 message，或 HTTP 状态
export function reason(r) {
	return (type(r.body) == 'object' && r.body.message) || (r.code ? `HTTP ${r.code}` : 'Failed to connect to Docker');
};

// docker CLI / docker-compose 要连接的守护进程：本机默认套接字时为 null，否则为 DOCKER_HOST 的值
export function cli_host() {
	const ctx = cursor();
	let h = ctx.get_first('dockerd', 'globals', 'hosts')?.[0] || '';
	ctx.unload();
	if (!h || h == '/var/run/docker.sock' || h == 'unix:///var/run/docker.sock') return null;
	if (substr(h, 0, 1) == '/') h = 'unix://' + h;
	return match(h, /^(unix|tcp|ssh|fd):\/\/[A-Za-z0-9._:\/\[\]@%-]+$/) ? h : null;
};
