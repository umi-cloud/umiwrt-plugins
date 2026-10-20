import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { md5 } from '../src/md5.js';
import { subscriptionInfo, nodeGroups, sourceOf, filtered, validateFilter, planFilter, nodesInUse, nodeInUse, planRemoveGroup, parseStatus, failedSubscriptions, MANUAL, ORPHAN } from '../src/subscription.js';

const hex = s => createHash('md5').update(s).digest('hex');

test('md5 与 node:crypto 一致（含中文与跨块长度）', () => {
	for (const s of ['', 'abc', '订阅', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(200)]) assert.equal(md5(s), hex(s));
});

test('订阅：hash 取去掉 # 的地址，标题取 # 后名称或主机名', () => {
	const a = subscriptionInfo('https://sub.example/x?token=1#机场%20A');
	assert.deepEqual([a.hash, a.title], [hex('https://sub.example/x?token=1'), '机场 A']);
	assert.equal(subscriptionInfo('https://sub.example/x').title, 'sub.example');
	assert.equal(subscriptionInfo('not a url').title, 'not a url');
});

test('来源归组：手工、各订阅、已移除的订阅', () => {
	const urls = ['https://a.example/s#A'];
	const nodes = [{ grouphash: hex('https://a.example/s') }, { grouphash: 'gone' }, { grouphash: '' }];
	const g = nodeGroups(urls, nodes);
	assert.deepEqual([g.groups[0].count, g.manual, g.orphan], [1, 1, 1]);
	const hashes = new Set(g.groups.map(x => x.hash));
	assert.deepEqual(nodes.map(n => sourceOf(n, hashes)), [g.groups[0].hash, ORPHAN, MANUAL]);
});

test('过滤：黑名单丢弃命中、白名单只留命中；无效正则拦下；空关键字与空 UA 用 delete', () => {
	assert.ok(filtered('到期提醒', 'blacklist', ['到期']) && !filtered('HK 01', 'blacklist', ['到期']));
	assert.ok(!filtered('HK 01', 'whitelist', ['^HK']) && filtered('JP 01', 'whitelist', ['^HK']));
	assert.ok(!filtered('x', 'disabled', ['x']) && !filtered('x', 'blacklist', ['(']));
	assert.deepEqual(validateFilter({ mode: 'blacklist', keywords: ['('] }).map(e => e.msg), ['Keywords must be valid regular expressions']);
	assert.deepEqual(validateFilter({ mode: 'whitelist', keywords: [] }).map(e => e.field), ['keywords']);
	/* 脚本按 POSIX 扩展正则执行：只有 JS 才认的写法拦下 */
	for (const k of ['\\d+', '(?:a)', 'a*?', '\\bHK']) assert.match(validateFilter({ mode: 'blacklist', keywords: [k] })[0].msg, /plain regular expressions/, k);
	assert.deepEqual(validateFilter({ mode: 'blacklist', keywords: ['到期|剩余', '^HK.*$', '[0-9]+'] }), []);
	assert.deepEqual(validateFilter({ mode: 'disabled', keywords: [] }), []);
	assert.deepEqual(planFilter({ mode: 'disabled', keywords: [], userAgent: ' ' }), { values: { filter_nodes: 'disabled' }, remove: ['filter_keywords', 'user_agent'] });
	assert.deepEqual(planFilter({ mode: 'blacklist', keywords: ['a'], userAgent: 'UA' }), { values: { filter_nodes: 'blacklist', filter_keywords: ['a'], user_agent: 'UA' }, remove: [] });
});

test('使用中的节点：主节点、UDP 节点、自动选择列表、自定义出站；按订阅删除时保留', () => {
	const cfg = { config: { main_node: 'urltest', main_urltest_nodes: ['a', 'b'], main_udp_node: 'c' }, o1: { '.type': 'routing_node', node: 'd', enabled: '0' }, o2: { '.type': 'routing_node', node: 'urltest', urltest_nodes: ['e'] } };
	assert.deepEqual([...nodesInUse(cfg)].sort(), ['a', 'b', 'c', 'd', 'e']);
	assert.ok(nodeInUse({ mainNode: 'm', udpNode: 'u', used: ['x'] }, 'x') && nodeInUse({ mainNode: 'm', udpNode: 'u' }, 'u') && !nodeInUse({ mainNode: 'm', udpNode: 'u', used: [] }, 'z'));
	const nodes = [{ id: 'a', grouphash: 'h' }, { id: 'b', grouphash: 'h' }, { id: 'c', grouphash: '' }];
	assert.deepEqual(planRemoveGroup(nodes, 'h', new Set(['h']), new Set(['a'])), { remove: ['b'], kept: ['a'] });
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
