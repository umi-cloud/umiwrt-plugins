import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latencyTone, sortByLatency, parsePing } from '../src/latency.js';

test('延迟分档与排序：快的在前，失败的其后，未测与不支持最后，同档保持原顺序', () => {
	assert.deepEqual([1, 150, 151, 350, 351, 'timeout', 'refused', 'unresolved', 'error', 'unsupported', 'testing', undefined].map(latencyTone),
		['fast', 'fast', 'fair', 'fair', 'slow', 'failed', 'failed', 'failed', 'failed', '', '', '']);
	const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({ id }));
	assert.deepEqual(sortByLatency(nodes, { a: 'timeout', b: 320, c: 'unsupported', d: 45, e: 'refused', f: 45 }).map(n => n.id), ['d', 'f', 'b', 'a', 'e', 'c', 'g']);
	assert.deepEqual(nodes.map(n => n.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('ping 输出：平均值取整；全丢包为 null', () => {
	assert.equal(parsePing('3 packets transmitted, 3 packets received\nround-trip min/avg/max = 20.1/23.6/30.2 ms'), 24);
	assert.equal(parsePing('rtt min/avg/max/mdev = 0.036/0.042/0.048/0.005 ms'), 1);
	assert.equal(parsePing('3 packets transmitted, 0 packets received, 100% packet loss'), null);
});
