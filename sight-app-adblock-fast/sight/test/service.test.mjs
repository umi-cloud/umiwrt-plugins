import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStatus, readConfig, validate, plan, createAdblock, readSchedule, buildSchedule, validateList, newList, listUsage } from '../src/service.js';

const CFG = {
	config: { '.type': 'adblock-fast', '.name': 'config', enabled: '1', force_dns: '1', allowed_domain: ['cdn.jsdelivr.net'] },
	l2: { '.type': 'file_url', '.name': 'l2', '.index': 2, name: 'OISD - Big', url: 'https://big.oisd.nl/', size: '6163363', enabled: '0' },
	l1: { '.type': 'file_url', '.name': 'l1', '.index': 1, name: 'Hagezi - Pro', url: 'https://x/pro.txt', size: '3476485', action: 'block' },
	l3: { '.type': 'file_url', '.name': 'l3', '.index': 3, name: 'Mine', url: 'https://x/mine.txt', enabled: '0' },
	l4: { '.type': 'file_url', '.name': 'l4', '.index': 4, name: 'Allow', url: 'https://x/allow.txt', size: '100', action: 'allow' },
};

test('状态：状态码归为运行/停止/失败/处理中，错误与警告带附带信息', () => {
	const s = readStatus({ data: { status: 'statusFail', entries: 0, errors: [{ code: 'errorNothingToDo', info: '' }], warnings: [{ code: 'warningMissingRecommendedPackages', info: 'gawk' }, { code: 'warningDownloadTimeout', info: 'x' }] } });
	assert.equal(s.state, 'failed');
	/* 缺少推荐软件包在界面上无法处理，不显示 */
	assert.deepEqual(s.problems.map(p => [p.tone, p.code, p.info]), [['error', 'errorNothingToDo', ''], ['warning', 'warningDownloadTimeout', 'x']]);
	assert.equal(readStatus({ data: { status: 'statusSuccess', entries: '123' } }).entries, 123);
	assert.equal(readStatus({ data: { status: 'statusDownloading' } }).state, 'working');
	assert.equal(readStatus(undefined).state, 'stopped');
	const paused = readStatus(undefined, { paused: true, remaining: 290, mem_available: 52428800 });
	assert.deepEqual([paused.state, paused.paused, paused.remaining, paused.memAvailable], ['stopped', true, 290, 52428800]);
});

test('配置：已开启的在前，同组内拦截列表按体积从大到小、体积未知的在后、放行列表最后；未写 enabled 视为启用；域名列表', () => {
	const c = readConfig(CFG);
	assert.equal(c.enabled, true);
	assert.deepEqual(c.lists.map(l => [l.section, l.name, l.enabled, l.size, l.action]), [
		['l1', 'Hagezi - Pro', true, 3476485, 'block'], ['l4', 'Allow', true, 100, 'allow'], ['l2', 'OISD - Big', false, 6163363, 'block'], ['l3', 'Mine', false, 0, 'block'],
	]);
	assert.deepEqual(c.allowed, ['cdn.jsdelivr.net']);
	assert.deepEqual(c.blocked, []);
});

test('计划：只写改动；清空域名列表走删除；校验域名格式', () => {
	const before = readConfig(CFG);
	const form = structuredClone(before);
	form.lists[2].enabled = true;
	form.allowed = [];
	form.blocked = ['ads.example.com', '*.tracker.net'];
	form.forceDns = false;
	assert.deepEqual(validate(form), []);
	assert.deepEqual(plan(before, form), [
		{ op: 'set', section: 'config', values: { force_dns: '0', blocked_domain: ['ads.example.com', '*.tracker.net'] }, remove: ['allowed_domain'] },
		{ op: 'set', section: 'l2', values: { enabled: '1' }, remove: [] },
	]);
	assert.deepEqual(plan(before, structuredClone(before)), []);
	assert.deepEqual(validate({ ...form, blocked: ['not a domain'] }), ['Enter domains like ads.example.com']);
});

test('自加列表：校验地址与重复，名称缺省取主机名；计划里新增与删除', () => {
	const before = readConfig(CFG);
	assert.deepEqual(validateList({ url: 'ftp://x/list', name: '' }, before.lists), { url: 'Enter an address starting with http:// or https://' });
	assert.deepEqual(validateList({ url: ' https://x/pro.txt ', name: '' }, before.lists), { url: 'This list is already added' });
	assert.deepEqual(validateList({ url: 'https://lists.example.org/a.txt', name: 'x'.repeat(65) }, before.lists), { name: 'Use at most 64 characters' });
	const added = newList({ url: ' https://lists.example.org/a.txt ', name: '', action: 'allow' });
	assert.deepEqual(added, { section: null, name: 'lists.example.org', url: 'https://lists.example.org/a.txt', size: 0, enabled: true, action: 'allow' });
	const form = structuredClone(before);
	form.lists = [...form.lists.filter(l => l.section !== 'l3'), added];
	assert.deepEqual(plan(before, form), [
		{ op: 'delete', section: 'l3' },
		{ op: 'add', type: 'file_url', values: { name: 'lists.example.org', url: 'https://lists.example.org/a.txt', action: 'allow', enabled: '1' } },
	]);
});

test('内存估算：已开启列表体积的两倍加一个下载任务，体积未知的单独计数', () => {
	const lists = readConfig(CFG).lists;
	assert.deepEqual(listUsage(lists), { count: 2, total: 3476585, need: 3476585 * 2 + 4194304, unknown: 0 });
	assert.deepEqual(listUsage([...lists, newList({ url: 'https://n/x', name: '' })]).unknown, 1);
	assert.deepEqual(listUsage([]), { count: 0, total: 0, need: 0, unknown: 0 });
});

test('检查与暂停经 sight.adblock-fast；关闭时先取消暂停，提前恢复后启动服务', async () => {
	const calls = [];
	const client = { call: async (o, m, p) => { calls.push([o, m, p]); return m === 'check' ? { blocked: true, match: 'example.com' } : {}; } };
	const svc = createAdblock(client, {});
	assert.deepEqual(await svc.check('ads.example.com'), { blocked: true, match: 'example.com' });
	await svc.pause(15);
	await svc.resumeNow();
	await svc.afterToggle(false);
	assert.deepEqual(calls.map(c => [c[0], c[1], c[2]?.action ?? c[2]?.minutes ?? c[2]?.domain]), [
		['sight.adblock-fast', 'check', 'ads.example.com'], ['sight.adblock-fast', 'pause', 15],
		['sight.adblock-fast', 'resume', undefined], ['sight', 'setInitAction', 'start'],
		['sight.adblock-fast', 'resume', undefined], ['sight', 'setInitAction', 'disable'], ['sight', 'setInitAction', 'stop'],
	]);
});

test('启停与更新经宿主的 sight.setInitAction；未安装时返回 null', async () => {
	const calls = [];
	const client = { call: async (o, m, p) => { calls.push([o, m, p]); return {}; } };
	const missing = Object.assign(new Error('nf'), { kind: 'status', status: 4 });
	const svc = createAdblock(client, { load: async () => { throw missing; } });
	assert.equal(await svc.load(), null);
	await svc.afterToggle(true);
	await svc.update();
	assert.deepEqual(calls.filter(c => c[0] === 'sight').map(c => c[2].action), ['enable', 'start', 'restart']);
});

test('自动更新：读写与 LuCI 同格式的 crontab 行，其它任务原样保留', () => {
	const base = '*/5 * * * * /usr/bin/x.sh\n';
	assert.deepEqual(readSchedule(base), { mode: 'off', time: '04:00', day: 0 });
	const daily = buildSchedule(base, { mode: 'daily', time: '03:30', day: 0 });
	assert.equal(daily, base + '30 3 * * * /etc/init.d/adblock-fast dl # adblock-fast-auto\n');
	assert.deepEqual(readSchedule(daily), { mode: 'daily', time: '03:30', day: 0 });
	const weekly = buildSchedule(daily, { mode: 'weekly', time: '04:05', day: 6 });
	assert.equal(weekly, base + '5 4 * * 6 /etc/init.d/adblock-fast dl # adblock-fast-auto\n');
	assert.deepEqual(readSchedule(weekly), { mode: 'weekly', time: '04:05', day: 6 });
	assert.equal(buildSchedule(weekly, { mode: 'off' }), base);
	/* LuCI 的停用行与其它频率 */
	assert.equal(buildSchedule(base + '# 0 4 * * * /etc/init.d/adblock-fast dl # adblock-fast-auto-disabled\n', { mode: 'off' }), base);
	assert.equal(readSchedule('0 */6 * * * /etc/init.d/adblock-fast dl # adblock-fast-auto\n').mode, 'other');
});
