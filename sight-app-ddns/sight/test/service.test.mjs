import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDdns } from '../src/service.js';

const notFound = Object.assign(new Error('Object not found'), { kind: 'rpc', code: -32000 });

test('DDNS 校验与写入计划：服务商二选一、凭据为空走 delete、查询主机默认域名', () => {
	const d = createDdns({}, {});
	const s = { id: '', name: 'home', enabled: true, ipv6: false, provider: 'cloudflare.com-v4', updateUrl: '', domain: 'home.example.com', lookupHost: '', username: '', password: 'tok', network: 'wan' };
	assert.deepEqual(d.validate(s, []), []);
	assert.deepEqual(d.validate({ ...s, name: 'bad-name' }, []), ['Name must be 1-32 letters, digits or underscores']);
	assert.deepEqual(d.validate(s, ['home']), ['A DDNS entry with this name already exists']);
	assert.deepEqual(d.validate({ ...s, provider: 'custom', updateUrl: 'ftp://x' }, []), ['Enter an update URL starting with http:// or https://']);
	assert.deepEqual(d.validate({ ...s, provider: '' }, []), ['Choose a provider']);
	assert.deepEqual(d.validate({ ...s, domain: 'a b' }, []), ['Invalid domain']);
	const { values, remove } = d.plan(s);
	assert.equal(values.lookup_host, 'home.example.com');
	assert.equal(values.service_name, 'cloudflare.com-v4');
	assert.deepEqual(remove, ['update_url', 'username']);
	assert.deepEqual(d.plan({ ...s, provider: 'custom', updateUrl: 'https://x/?ip=[IP]' }).remove, ['service_name', 'username']);
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
