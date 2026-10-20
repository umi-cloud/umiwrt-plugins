import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogs, sinceOf, appendLogs, filterLogs } from '../src/logs.js';
test('日志：解析时间戳、增量读取的 since、去重追加、限行与筛选', () => {
	const lines = parseLogs('2026-10-19T05:54:27.5Z hello\n2026-10-19T05:54:28.123456789Z world\npartial\n');
	assert.deepEqual(lines.map(l => [l.ts, l.text]), [['2026-10-19T05:54:27.500000000', 'hello'], ['2026-10-19T05:54:28.123456789', 'world'], ['', 'partial']]);
	assert.equal(lines[0].time, Date.UTC(2026, 9, 19, 5, 54, 27, 500));
	assert.equal(sinceOf(lines), `${Date.UTC(2026, 9, 19, 5, 54, 28) / 1000}.123456789`);
	assert.equal(sinceOf(parseLogs('no time')), '');
	/* since 含同一时刻的记录：只追加更晚的 */
	const more = parseLogs('2026-10-19T05:54:28.123456789Z world\n2026-10-19T05:54:29Z next\n');
	const merged = appendLogs(lines.slice(0, 2), more, 10);
	assert.deepEqual(merged.map(l => l.text), ['hello', 'world', 'next']);
	assert.deepEqual(appendLogs(merged, [], 2).map(l => l.text), ['world', 'next']);
	const fmt = () => '10-19 13:54:27';
	assert.deepEqual(filterLogs(merged, 'WOR', false, fmt).map(l => l.text), ['world']);
	assert.deepEqual(filterLogs(merged, '13:54', false, fmt), []);
	assert.equal(filterLogs(merged, '13:54', true, fmt).length, 3);
	assert.equal(filterLogs(merged, ' ', false, fmt).length, 3);
});
