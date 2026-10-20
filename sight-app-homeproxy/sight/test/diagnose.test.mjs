import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logTime, fatalMessage, diagnose } from '../src/diagnose.js';

test('日志时间统一成可比较的本地时间', () => {
	assert.equal(logTime('2026-10-19 14:08:11 [DAEMON] sing-box 1.12.25 started.'), '20261019140811');
	assert.equal(logTime('Mon Oct 19 14:09:16 2026 daemon.err sing-box[1]: FATAL'), '20261019140916');
	assert.equal(logTime('Sun Oct  5 03:00:01 2026 daemon.err sing-box[1]: FATAL'), '20261005030001');
	assert.equal(logTime('\x1b[31mFATAL\x1b[0m[0000] decode config'), '');
	assert.equal(fatalMessage('Mon Oct 19 14:09:16 2026 daemon.err sing-box[2]: \x1b[31mFATAL\x1b[0m[0005] start service: x'), 'start service: x');
});

test('诊断：启动时生成或检查配置失败、启动后退出、找不到原因', () => {
	const checkFailed = [
		'2026-10-19 14:06:00 [DAEMON] sing-box 1.12.25 started.',
		'2026-10-19 14:06:42 [DAEMON] Service stopped.',
		'\x1b[31mFATAL\x1b[0m[0000] decode config at /var/run/homeproxy/sing-box-c.json: outbounds[2].uuid: json: unknown field "uuid"',
		'2026-10-19 14:06:42 [DAEMON] Error: wrong client configuration detected.',
	].join('\n');
	assert.deepEqual(diagnose(checkFailed, []), { reason: 'check', detail: 'decode config at /var/run/homeproxy/sing-box-c.json: outbounds[2].uuid: json: unknown field "uuid"', log: 'homeproxy' });
	/* ucode 报错的第一行是原因，后面是调用位置 */
	const generateFailed = ['2026-10-19 14:06:42 [DAEMON] Service stopped.', 'Reference error: access to undeclared variable x', 'In main(), file generate_client.uc, line 10, byte 5:', '2026-10-19 14:06:42 [DAEMON] Error: failed to generate client configuration.'].join('\n');
	assert.deepEqual(diagnose(generateFailed, []), { reason: 'generate', detail: 'Reference error: access to undeclared variable x', log: 'homeproxy' });

	const started = '2026-10-19 14:06:42 [DAEMON] Error: wrong client configuration detected.\n2026-10-19 14:08:11 [DAEMON] sing-box 1.12.25 started.\n';
	const fatal = [
		'Mon Oct 19 14:06:44 2026 daemon.err sing-box[1]: \x1b[31mFATAL\x1b[0m[0002] start service: context canceled',
		'Mon Oct 19 14:09:16 2026 daemon.err sing-box[2]: \x1b[31mFATAL\x1b[0m[0005] start service: initialize rule-set[0]: EOF',
		'Mon Oct 19 14:09:16 2026 daemon.info procd: Instance homeproxy::sing-box-c s in a crash loop 6 crashes, 5 seconds since last crash',
	];
	assert.deepEqual(diagnose(started, fatal), { reason: 'exited', detail: 'start service: initialize rule-set[0]: EOF', log: 'syslog' });
	/* 这次启动之前的 FATAL 不算；服务日志被清空时不比较时间 */
	assert.equal(diagnose(started, fatal.slice(0, 1)), null);
	assert.equal(diagnose('', fatal.slice(0, 1)).detail, 'start service: context canceled');
	assert.equal(diagnose(null, []), null);
});
