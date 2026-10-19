import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { md5 } from '../src/md5.js';
import { subscriptionInfo, nodeGroups, sourceOf, filtered, validateFilter, planFilter, nodesInUse, planRemoveGroup, parseStatus, failedSubscriptions, MANUAL, ORPHAN } from '../src/subscription.js';

const hex = s => createHash('md5').update(s).digest('hex');

test('md5 与 node:crypto 一致（含中文与跨块长度）', () => {
	for (const s of ['', 'abc', '订阅', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(200)]) assert.equal(md5(s), hex(s));
});

test('订阅：hash 取去掉 # 的地址，标题取 # 后名称或主机名', () => {
	assert.deepEqual(subscriptionInfo('https://a.example/sub?t=1#%E6%9C%BA%E5%9C%BA'), { url: 'https://a.example/sub?t=1#%E6%9C%BA%E5%9C%BA', hash: hex('https://a.example/sub?t=1'), title: '机场' });
	assert.equal(subscriptionInfo('https://b.example/x').title, 'b.example');
});

test('来源归组：手工、各订阅、已移除的订阅', () => {
	const a = 'https://a.example/s', h = hex(a);
	const nodes = [{ id: '1', grouphash: h }, { id: '2', grouphash: h }, { id: '3' }, { id: '4', grouphash: 'gone' }];
	const g = nodeGroups([a], nodes);
	assert.deepEqual([g.groups[0].count, g.manual, g.orphan], [2, 1, 1]);
	const hashes = new Set([h]);
	assert.deepEqual(nodes.map(n => sourceOf(n, hashes)), [h, h, MANUAL, ORPHAN]);
});

test('过滤：黑名单丢弃命中、白名单只留命中；无效正则拦下；空关键字与空 UA 用 delete', () => {
	assert.equal(filtered('香港 01', 'blacklist', ['香港']), true);
	assert.equal(filtered('香港 01', 'whitelist', ['日本|香港']), false);
	assert.equal(filtered('美国', 'whitelist', ['日本|香港']), true);
	assert.equal(filtered('美国', 'disabled', ['美国']), false);
	assert.deepEqual(validateFilter({ mode: 'blacklist', keywords: [] }), ['Add at least one keyword']);
	assert.deepEqual(validateFilter({ mode: 'whitelist', keywords: ['(bad'] }), ['Keywords must be valid regular expressions']);
	assert.deepEqual(planFilter({ mode: 'disabled', keywords: [], userAgent: ' ' }), { values: { filter_nodes: 'disabled' }, remove: ['filter_keywords', 'user_agent'] });
	assert.deepEqual(planFilter({ mode: 'blacklist', keywords: ['到期'], userAgent: 'clash' }), { values: { filter_nodes: 'blacklist', filter_keywords: ['到期'], user_agent: 'clash' }, remove: [] });
});

test('使用中的节点：主节点、UDP 节点、自动选择列表、自定义出站；按订阅删除时保留', () => {
	const cfg = { config: { main_node: 'urltest', main_urltest_nodes: ['a', 'b'], main_udp_node: 'c' },
		r1: { '.type': 'routing_node', node: 'd' }, r2: { '.type': 'routing_node', node: 'urltest', urltest_nodes: ['e'] } };
	assert.deepEqual([...nodesInUse(cfg)].sort(), ['a', 'b', 'c', 'd', 'e']);
	const nodes = [{ id: 'a', grouphash: 'h' }, { id: 'x', grouphash: 'h' }, { id: 'y' }];
	assert.deepEqual(planRemoveGroup(nodes, 'h', new Set(['h']), new Set(['a'])), { remove: ['x'], kept: ['a'] });
});

test('更新结果：解析状态文件；损坏为 null；没取到节点的订阅按地址顺序列出', () => {
	assert.equal(parseStatus('not json'), null);
	assert.equal(parseStatus('{}'), null);
	const a = 'https://a.example/sub#Alpha', b = 'https://b.example/sub', c = 'https://c.example/new';
	const s = parseStatus(JSON.stringify({ time: 1792389955, result: 'ok', added: 2, removed: 1, subscriptions: [
		{ hash: md5('https://a.example/sub'), status: 'ok', nodes: 2, total: 3 }, { hash: md5(b), status: 'fetch_failed' }] }));
	assert.deepEqual([s.time, s.result, s.added, s.removed], [1792389955, 'ok', 2, 1]);
	assert.deepEqual(s.subscriptions[md5('https://a.example/sub')], { status: 'ok', nodes: 2, total: 3 });
	assert.deepEqual(failedSubscriptions(s, [a, b, c]).map(g => g.title), ['b.example']);
	assert.equal(parseStatus(JSON.stringify({ time: 1, result: 'boom' })).result, 'error');
	assert.deepEqual(failedSubscriptions(null, [a]), []);
});
