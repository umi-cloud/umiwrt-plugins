#!/usr/bin/env node
/*
 * flow-check 用的 ttyd 探针：以 ttyd 的 websocket 协议连上终端，执行一条命令并打印输出。
 *   node ttyd-probe.mjs <ws://host:port/base/ws> <command> [origin]
 * 不依赖第三方包；在与设备同一网络命名空间的容器里运行（docker run --network container:<设备容器>）。
 * 退出码：0 输出里出现标记；1 连接被拒或超时。
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const [url, command, originArg] = process.argv.slice(2);
const u = new URL(url);
const secure = u.protocol === 'wss:';
const port = +u.port || (secure ? 443 : 80);
const origin = originArg ?? `${secure ? 'https' : 'http'}://${u.host}`;
const MARK = 'SIGHT_PROBE_' + randomBytes(4).toString('hex');
const sock = secure ? tls.connect({ host: u.hostname, port, rejectUnauthorized: false }) : net.connect({ host: u.hostname, port });
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);

/* 客户端帧必须加掩码 */
function frame(payload, opcode = 2) {
	const mask = randomBytes(4), len = payload.length;
	const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255]);
	const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
	return Buffer.concat([head, mask, body]);
}
let buf = Buffer.alloc(0), upgraded = false, output = '';
sock.on(secure ? 'secureConnect' : 'connect', () => {
	const extra = origin ? `Origin: ${origin}\r\n` : '';
	sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: tty\r\n${extra}\r\n`);
});
sock.on('data', d => {
	buf = Buffer.concat([buf, d]);
	if (!upgraded) {
		const end = buf.indexOf('\r\n\r\n');
		if (end < 0) return;
		const head = buf.subarray(0, end).toString();
		buf = buf.subarray(end + 4);
		if (!/^HTTP\/1\.1 101/.test(head)) { console.log('REJECTED ' + head.split('\r\n')[0]); process.exit(1); }
		upgraded = true;
		sock.write(frame([...Buffer.from(JSON.stringify({ AuthToken: '', columns: 120, rows: 30 }))]));
		setTimeout(() => sock.write(frame([...Buffer.from('0' + `${command}; echo ${MARK.slice(0, 6)}""${MARK.slice(6)}\r`)])), 800);
	}
	while (buf.length >= 2) {
		let len = buf[1] & 127, off = 2;
		if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
		else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
		if (buf.length < off + len) return;
		const payload = buf.subarray(off, off + len), opcode = buf[0] & 15;
		buf = buf.subarray(off + len);
		if (opcode === 8) { finish(); return; }
		if (payload[0] === 0x30) output += payload.subarray(1).toString();
		if (output.includes(MARK)) { finish(); return; }
	}
});
sock.on('error', e => { console.log('ERROR ' + e.message); process.exit(1); });
sock.on('close', () => finish());
function finish() {
	clearTimeout(timer);
	process.stdout.write(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
	process.exit(output.includes(MARK) ? 0 : 1);
}
