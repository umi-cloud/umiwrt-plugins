import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminal, terminalUrl, explain } from '../src/service.js';

const status = s => Object.assign(new Error('status ' + s), { kind: 'status', status: s });

test('终端地址：主机名与协议随浏览器访问方式，IPv6 加方括号', () => {
	const session = { port: 7790, path: '/abcd/', tls: false };
	assert.equal(terminalUrl({ hostname: '192.168.1.1' }, session), 'http://192.168.1.1:7790/abcd/');
	assert.equal(terminalUrl({ hostname: 'fd00::1' }, { ...session, tls: true }), 'https://[fd00::1]:7790/abcd/');
});

test('状态码译成说明：非 LAN、缺证书或 ttyd、会话不存在', () => {
	assert.match(explain(status(6)).message, /LAN address/);
	assert.match(explain(status(8), true).message, /certificate/);
	assert.match(explain(status(8), false).message, /ttyd is not installed/);
	assert.match(explain(status(4)).message, /no longer exists/);
	const other = new Error('x');
	assert.equal(explain(other), other);
});

test('启动：按访问方式传 host 与 tls，返回会话与一次性地址', async () => {
	const calls = [];
	const svc = createTerminal({ call: async (o, m, p) => {
		calls.push([o, m, p]);
		if (m === 'start') return { session: { id: '0123456789abcdef', port: 7800, path: '/x/', tls: p.tls } };
		if (m === 'stop') throw status(4);
		return { session: { id: p.id, state: 'ready' } };
	} });
	const r = await svc.start({ hostname: '192.168.1.1', protocol: 'https:' });
	assert.equal(r.url, 'https://192.168.1.1:7800/x/');
	assert.deepEqual(calls[0], ['sight.ttyd', 'start', { host: '192.168.1.1', tls: true }]);
	assert.equal((await svc.status('0123456789abcdef')).state, 'ready');
	await assert.rejects(svc.stop('0123456789abcdef'), /no longer exists/);
});
