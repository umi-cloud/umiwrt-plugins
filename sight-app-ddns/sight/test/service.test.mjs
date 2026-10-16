import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDdns } from '../src/service.js';

const notFound = Object.assign(new Error('Object not found'), { kind: 'rpc', code: -32000 });

const BASE = {
	id: '', name: 'home', enabled: true, ipv6: false, provider: 'cloudflare.com-v4', updateUrl: '', domain: 'home.example.com', lookupHost: '', username: '', password: 'tok', network: 'wan',
	ipSource: 'network', ipSourceRaw: 'network', ipUrl: '', checkInterval: '', checkUnit: 'minutes', forceInterval: '', forceUnit: 'hours', https: false, insecure: false, cacert: '', dnsServer: '',
};
/* 计划里与地址来源、间隔、HTTPS、DNS 无关的默认删除项 */
const ADVANCED_REMOVE = ['check_interval', 'check_unit', 'force_interval', 'force_unit', 'use_https', 'dns_server'];

test('DDNS 校验与写入计划：服务商二选一、凭据为空走 delete、查询主机默认域名', () => {
	const d = createDdns({}, {});
	const s = { ...BASE };
	assert.deepEqual(d.validate(s, []), []);
	assert.deepEqual(d.validate({ ...s, name: 'bad-name' }, []), ['Name must be 1-32 letters, digits or underscores']);
	assert.deepEqual(d.validate(s, ['home']), ['A DDNS entry with this name already exists']);
	assert.deepEqual(d.validate({ ...s, provider: 'custom', updateUrl: 'ftp://x' }, []), ['Enter an update URL starting with http:// or https://']);
	assert.deepEqual(d.validate({ ...s, provider: '' }, []), ['Choose a provider']);
	assert.deepEqual(d.validate({ ...s, domain: 'a b' }, []), ['Invalid domain']);
	const { values, remove } = d.plan(s);
	assert.equal(values.lookup_host, 'home.example.com');
	assert.equal(values.service_name, 'cloudflare.com-v4');
	assert.deepEqual(remove, ['update_url', 'username', ...ADVANCED_REMOVE]);
	assert.deepEqual(d.plan({ ...s, provider: 'custom', updateUrl: 'https://x/?ip=[IP]' }).remove, ['service_name', 'username', ...ADVANCED_REMOVE]);
});

test('DDNS 地址来源：network/web 只写各自的键，其他来源整组不动', () => {
	const d = createDdns({}, {});
	const net = d.plan({ ...BASE, id: 'home', network: 'wan6' }).values;
	assert.deepEqual([net.ip_source, net.ip_network, net.interface], ['network', 'wan6', 'wan6']);
	const web = d.plan({ ...BASE, id: 'home', ipSource: 'web', ipUrl: ' http://ip.example/ ' });
	assert.equal(web.values.ip_source, 'web');
	assert.equal(web.values.ip_url, 'http://ip.example/');
	assert.ok(!('ip_network' in web.values) && !('interface' in web.values), '已有条目切到 web 不改 ip_network 与触发接口');
	const webEmpty = d.plan({ ...BASE, id: 'home', ipSource: 'web' });
	assert.ok(webEmpty.remove.includes('ip_url'), '检测地址留空走 delete，由 ddns-scripts 用默认地址');
	assert.equal(d.plan({ ...BASE, ipSource: 'web' }).values.interface, 'wan', '新条目仍写触发接口');
	const other = d.plan({ ...BASE, id: 'home', ipSource: 'other', ipSourceRaw: 'script' });
	for (const k of ['ip_source', 'ip_network', 'ip_url', 'interface', 'ip_script', 'ip_interface']) assert.ok(!(k in other.values) && !other.remove.includes(k), `其他来源不碰 ${k}`);
	assert.deepEqual(d.validate({ ...BASE, ipSource: 'web', ipUrl: 'checkip' }, []), ['Enter a detection URL starting with http:// or https://']);
	assert.deepEqual(d.validate({ ...BASE, ipSource: 'network', ipUrl: 'checkip' }, []), [], '非 web 来源不校验检测地址');
});

test('DDNS 高级选项：间隔与单位、HTTPS 证书、DNS 服务器，空值 delete', () => {
	const d = createDdns({}, {});
	const p = d.plan({ ...BASE, id: 'home', checkInterval: '30', checkUnit: 'minutes', forceInterval: '1', forceUnit: 'days', https: true, dnsServer: ' 1.1.1.1:53 ' });
	assert.deepEqual([p.values.check_interval, p.values.check_unit, p.values.force_interval, p.values.force_unit, p.values.use_https, p.values.dns_server], ['30', 'minutes', '1', 'days', '1', '1.1.1.1:53']);
	assert.ok(!('cacert' in p.values) && !p.remove.includes('cacert'), '校验证书时不写 cacert，用系统证书库');
	/* 单位不是默认值时即使间隔为空也保留，否则 ddns-scripts 按「默认间隔 × 单位」计算 */
	const unitOnly = d.plan({ ...BASE, id: 'home', checkUnit: 'hours' });
	assert.equal(unitOnly.values.check_unit, 'hours');
	assert.ok(unitOnly.remove.includes('check_interval'));
	assert.equal(d.plan({ ...BASE, https: true, insecure: true }).values.cacert, 'IGNORE');
	assert.ok(d.plan({ ...BASE, https: true, cacert: 'IGNORE' }).remove.includes('cacert'), '关闭「不校验」时删除 IGNORE');
	const custom = d.plan({ ...BASE, https: true, cacert: '/etc/my-ca.pem' });
	assert.ok(!('cacert' in custom.values) && !custom.remove.includes('cacert'), '自定义证书路径保持原样');
	const off = d.plan({ ...BASE, https: false, cacert: 'IGNORE' });
	assert.ok(off.remove.includes('use_https') && !off.remove.includes('cacert'));
	const v = s => d.validate({ ...BASE, ...s }, []);
	assert.deepEqual(v({ checkInterval: '4' }), ['Check interval must be at least 5 minutes']);
	assert.deepEqual(v({ checkInterval: 'x' }), ['Check interval must be at least 5 minutes']);
	assert.deepEqual(v({ checkInterval: '1', checkUnit: 'hours' }), []);
	assert.deepEqual(v({ forceInterval: '0' }), [], '0 表示只运行一次');
	assert.deepEqual(v({ forceInterval: '5', forceUnit: 'minutes' }), ['Forced update interval must be 0 or not shorter than the check interval']);
	assert.deepEqual(v({ checkInterval: '2', checkUnit: 'hours', forceInterval: '1', forceUnit: 'hours' }), ['Forced update interval must be 0 or not shorter than the check interval']);
	assert.deepEqual(v({ dnsServer: '1.1.1.1 ' }), []);
	assert.deepEqual(v({ dnsServer: '1.1.1.1;reboot' }), ['Invalid DNS server']);
});

test('DDNS 地址比较、下次检查与当前地址读取', async () => {
	const { addressMatch, normalizeIp, nextCheck, entryState } = await import('../src/service.js');
	assert.equal(normalizeIp('2001:DB8::0001'), '2001:db8:0:0:0:0:0:1');
	assert.equal(normalizeIp('::ffff:1.2.3.4'), '0:0:0:0:0:ffff:102:304');
	assert.equal(normalizeIp('nope'), '');
	assert.equal(addressMatch('1.2.3.4', '1.2.3.4'), 'match');
	assert.equal(addressMatch('1.2.3.4', '5.6.7.8<br/>1.2.3.4'), 'match', '多条解析结果任一一致即可');
	assert.equal(addressMatch('2001:db8::1', '2001:0db8:0:0::1'), 'match');
	assert.equal(addressMatch('1.2.3.4', '5.6.7.8'), 'mismatch');
	assert.equal(addressMatch(null, '1.2.3.4'), 'unknown');
	assert.equal(addressMatch('1.2.3.4', ''), 'unknown');
	assert.equal(entryState({ enabled: true, status: { ip: '1.2.3.4' } }, true, 'mismatch'), 'outdated');
	assert.equal(entryState({ enabled: true, status: { ip: '1.2.3.4' } }, true, 'unknown'), 'synced', '比较不了时不判为过期');
	assert.deepEqual(nextCheck({ pid: 9, next_check: '2026-10-16 12:00', next_update: '2026-10-19 12:00' }), { value: '2026-10-16 12:00' });
	assert.deepEqual(nextCheck({ pid: null, next_update: 'Stopped' }), { text: 'Not running' });
	assert.deepEqual(nextCheck({ pid: 9, next_update: 'Verify' }), { text: 'Checking now' });
	assert.deepEqual(nextCheck(null), { value: '' });
	const calls = [];
	const d = createDdns({ call: async (...a) => { calls.push(a); return { ip: '1.2.3.4' }; } }, {});
	assert.equal(await d.currentIp('home'), '1.2.3.4');
	assert.deepEqual(calls[0], ['sight.ddns', 'get_current_ip', { service_name: 'home' }]);
	assert.equal(await createDdns({ call: async () => ({ ip: null }) }, {}).currentIp('home'), null);
	await assert.rejects(createDdns({ call: async () => ({ error: 'No such DDNS entry' }) }, {}).currentIp('x'), /No such DDNS entry/);
});

test('DDNS 读取：地址来源与高级选项映射到表单', async () => {
	const cfg = {
		a: { '.name': 'a', '.type': 'service', enabled: '1', domain: 'a.example', service_name: 'x', ip_source: 'script', ip_script: '/bin/ip.sh', use_https: '1', cacert: 'IGNORE', check_interval: '30', dns_server: '1.1.1.1' },
		b: { '.name': 'b', '.type': 'service', enabled: '1', domain: 'b.example', service_name: 'x', ip_source: 'web', ip_url: 'http://ip/' },
		c: { '.name': 'c', '.type': 'service', domain: 'c.example', service_name: 'x' },
	};
	const client = { call: async (o, m) => m === 'get_ddns_state' ? { _enabled: true } : m === 'list' ? { entries: [] } : {} };
	const uci = { load: async c => c === 'ddns' ? cfg : {} };
	const r = await createDdns(client, uci).load();
	const [a, b, c] = r.services;
	assert.deepEqual([a.ipSource, a.ipSourceRaw, a.https, a.insecure, a.checkInterval, a.checkUnit, a.dnsServer], ['other', 'script', true, true, '30', 'minutes', '1.1.1.1']);
	assert.deepEqual([b.ipSource, b.ipUrl], ['web', 'http://ip/']);
	assert.deepEqual([c.ipSource, c.forceUnit, c.https], ['network', 'hours', false], 'ip_source 缺省按 network');
});

test('DDNS 即时操作：helper 参数固定，非零退出抛错；未安装返回 null', async () => {
	const calls = [];
	const d = createDdns({ call: async (...a) => { calls.push(a); return { code: 1, stderr: 'boom' }; } }, {});
	await assert.rejects(d.run('home', 'start'), /boom/);
	assert.deepEqual(calls[0], ['file', 'exec', { command: '/usr/lib/ddns/dynamic_dns_lucihelper.sh', params: ['-S', 'home', '--', 'start'] }]);
	await assert.rejects(d.run('home', 'rm'), /Unknown action/);
	assert.equal(await createDdns({ call: async () => { throw notFound; } }, {}).load(), null);
});

test('DDNS 状态归纳与服务商凭据需求', async () => {
	const { entryState } = await import('../src/service.js');
	assert.equal(entryState({ enabled: false }, true), 'off');
	assert.equal(entryState({ enabled: true }, false), 'paused');
	assert.equal(entryState({ enabled: true, status: { ip: '1.2.3.4' } }, true), 'synced');
	assert.equal(entryState({ enabled: true, status: { pid: 12 } }, true), 'running');
	assert.equal(entryState({ enabled: true, status: {} }, true), 'waiting');
	const d = createDdns({ call: async () => ({ data: JSON.stringify({ ipv4: { url: 'http://x/?domains=[DOMAIN]&token=[PASSWORD]' } }) }) }, {});
	assert.deepEqual(await d.providerInfo('duckdns.org'), { username: false, password: true, ipv6: false });
	assert.deepEqual(await createDdns({ call: async () => { throw new Error('x'); } }, {}).providerInfo('a'), { username: true, password: true, ipv6: true });
	assert.deepEqual(await d.providerInfo('custom'), { username: true, password: true, ipv6: true });
});

test('DDNS 状态读不到时域名为未知，不当作等待首次更新', async () => {
	const { entryState } = await import('../src/service.js');
	assert.equal(entryState({ enabled: true, status: undefined }, true), 'unknown');
	assert.equal(entryState({ enabled: true, status: null }, true), 'waiting');
});
