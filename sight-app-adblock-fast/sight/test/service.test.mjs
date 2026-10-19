import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStatus, readConfig, validate, plan, createAdblock, readSchedule, buildSchedule } from '../src/service.js';

const CFG = {
	config: { '.type': 'adblock-fast', '.name': 'config', enabled: '1', force_dns: '1', allowed_domain: ['cdn.jsdelivr.net'] },
	l2: { '.type': 'file_url', '.name': 'l2', '.index': 2, name: 'OISD - Big', url: 'https://big.oisd.nl/', size: '6163363', enabled: '0' },
	l1: { '.type': 'file_url', '.name': 'l1', '.index': 1, name: 'Hagezi - Pro', url: 'https://x/pro.txt', size: '3476485', action: 'block' },
};

test('状态：状态码归为运行/停止/失败/处理中，错误与警告带附带信息', () => {
	const s = readStatus({ data: { status: 'statusFail', entries: 0, errors: [{ code: 'errorNothingToDo', info: '' }], warnings: [{ code: 'warningMissingRecommendedPackages', info: 'gawk' }] } });
	assert.equal(s.state, 'failed');
	assert.deepEqual(s.problems.map(p => [p.tone, p.code, p.info]), [['error', 'errorNothingToDo', ''], ['warning', 'warningMissingRecommendedPackages', 'gawk']]);
	assert.equal(readStatus({ data: { status: 'statusSuccess', entries: '123' } }).entries, 123);
	assert.equal(readStatus({ data: { status: 'statusDownloading' } }).state, 'working');
	assert.equal(readStatus(undefined).state, 'stopped');
});

test('配置：列表按顺序，未写 enabled 视为启用；域名列表', () => {
	const c = readConfig(CFG);
	assert.equal(c.enabled, true);
	assert.deepEqual(c.lists.map(l => [l.section, l.name, l.enabled, l.size]), [['l1', 'Hagezi - Pro', true, 3476485], ['l2', 'OISD - Big', false, 6163363]]);
	assert.deepEqual(c.allowed, ['cdn.jsdelivr.net']);
	assert.deepEqual(c.blocked, []);
});

test('计划：只写改动；清空域名列表走删除；校验域名格式', () => {
	const before = readConfig(CFG);
	const form = structuredClone(before);
	form.lists[1].enabled = true;
	form.allowed = [];
	form.blocked = ['ads.example.com', '*.tracker.net'];
	form.forceDns = false;
	assert.deepEqual(validate(form), []);
	assert.deepEqual(plan(before, form), [
		{ section: 'config', values: { force_dns: '0', blocked_domain: ['ads.example.com', '*.tracker.net'] }, remove: ['allowed_domain'] },
		{ section: 'l2', values: { enabled: '1' }, remove: [] },
	]);
	assert.deepEqual(plan(before, structuredClone(before)), []);
	assert.deepEqual(validate({ ...form, blocked: ['not a domain'] }), ['Enter domains like ads.example.com']);
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
