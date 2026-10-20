import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreUpdateState } from '../src/core.js';
import { localTime, versionText, durationParts } from '../src/format.js';

test('核心更新状态：不支持、未检查、进行中、有新版、已是最新、已更新、失败', () => {
	assert.deepEqual(coreUpdateState({ supported: false, task: null }), { kind: 'unsupported' });
	assert.deepEqual(coreUpdateState({ supported: true, task: null }), { kind: 'idle' });
	assert.deepEqual(coreUpdateState({ supported: true, task: { action: 'check', state: 'running' } }), { kind: 'running', action: 'check' });
	assert.deepEqual(coreUpdateState({ supported: true, task: { action: 'check', state: 'done', finished: 9, current: '1.12.25-r1', latest: '1.12.26-r1', update_code: 0 } }), { kind: 'available', version: '1.12.26-r1', current: '1.12.25-r1', time: 9, stale: false });
	assert.deepEqual(coreUpdateState({ supported: true, task: { action: 'check', state: 'done', finished: 9, current: '1.12.25-r1', latest: '', update_code: 1 } }), { kind: 'latest', time: 9, stale: true });
	assert.deepEqual(coreUpdateState({ supported: true, task: { action: 'upgrade', state: 'done', finished: 9, from: 'a', current: 'b', restarted: false, restart_failed: true } }), { kind: 'upgraded', version: 'b', from: 'a', restarted: false, restartFailed: true, time: 9 });
	assert.equal(coreUpdateState({ supported: true, task: { action: 'upgrade', state: 'done', finished: 9, from: 'a', current: 'a' } }).kind, 'latest');
	assert.deepEqual(coreUpdateState({ supported: true, task: { action: 'upgrade', state: 'failed', code: 1 }, output: 'ERROR: x' }), { kind: 'failed', action: 'upgrade', output: 'ERROR: x' });
});

test('格式：本地时间、规则库版本时间戳、时长拆分', () => {
	assert.match(localTime(0), /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
	assert.equal(versionText('202610182205'), '2026-10-18 22:05');
	assert.equal(versionText('20261018220544'), '2026-10-18 22:05');
	assert.equal(versionText('v1'), 'v1');
	assert.deepEqual(durationParts(90061), { days: 1, hours: 1, minutes: 1 });
	assert.deepEqual(durationParts(5), { days: 0, hours: 0, minutes: 1 });
});
