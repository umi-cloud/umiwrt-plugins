import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DockerError, unwrap, replyError, createDocker } from '../src/service.js';
import { canUpdate, updateState } from '../src/images.js';
import { emptyCreate } from '../src/create.js';
import { MIRROR_PRESETS, validateSettings } from '../src/settings.js';
const container = (name, extra = {}) => ({ Id: name.padEnd(64, '0'), Names: ['/' + name], Image: 'busybox', ImageID: 'i', State: 'running', Status: 'Up', Ports: [], Labels: {}, NetworkSettings: { Networks: { bridge: {} } }, Mounts: [], ...extra });

const A = 'a'.repeat(64), B = 'b'.repeat(64);

const D1 = 'sha256:' + '1'.repeat(64), D2 = 'sha256:' + '2'.repeat(64);

const ID = 'abcdef0123456789'.repeat(4);

const image = { Config: { Env: ['PATH=/usr/bin', 'APP_VERSION=1'], Cmd: ['httpd', '-f'], Entrypoint: null, WorkingDir: '/srv', ExposedPorts: { '80/tcp': {} }, Volumes: { '/cache': {} }, Labels: { maintainer: 'x', tier: 'base' } } };

const inspect = () => ({
	Id: ID, Name: '/web', Image: 'sha256:old',
	Config: {
		Hostname: ID.slice(0, 12), Domainname: '', User: '', AttachStdout: true, Tty: false, OpenStdin: false,
		Env: ['PATH=/usr/bin', 'APP_VERSION=1', 'TZ=Asia/Shanghai'], Cmd: ['httpd', '-f'], Entrypoint: null, WorkingDir: '/srv',
		Image: 'nginx:latest', ExposedPorts: { '80/tcp': {}, '9000/tcp': {} }, Volumes: { '/cache': {} },
		Labels: { maintainer: 'x', tier: 'web', 'com.example.keep': 'yes' }, StopSignal: 'SIGQUIT',
	},
	HostConfig: {
		NetworkMode: 'appnet', RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 }, Privileged: false,
		PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }, { HostIp: '127.0.0.1', HostPort: '8081' }], '9000/tcp': [{ HostIp: '', HostPort: '' }] },
		Binds: ['/mnt/data:/data:ro,rslave', 'named:/named'], Links: ['/db:/web/database'], CapAdd: ['NET_ADMIN'], Memory: 268435456, Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
	},
	Mounts: [
		{ Type: 'bind', Source: '/mnt/data', Destination: '/data', RW: false },
		{ Type: 'volume', Name: 'named', Source: '/x/named/_data', Destination: '/named', RW: true },
		{ Type: 'volume', Name: VOL, Source: `/x/${VOL}/_data`, Destination: '/cache', RW: true },
	],
	NetworkSettings: { Networks: {
		appnet: { IPAMConfig: { IPv4Address: '172.30.0.5' }, Aliases: ['web-alias', ID.slice(0, 12)], Links: null, DriverOpts: null },
		backend: { IPAMConfig: null, Aliases: null, Links: null, DriverOpts: null },
	} },
});

test('插件响应：code ≥ 300 抛出 body.message，否则返回 body', () => {
	assert.deepEqual(unwrap({ code: 200, body: [1] }), [1]);
	assert.throws(() => unwrap({ code: 500, body: { message: 'Failed to connect' } }), e => e instanceof DockerError && e.code === 500 && /Failed to connect/.test(e.message));
	assert.throws(() => unwrap(null), DockerError);
});

test('服务：删除容器、重启策略、清理镜像、日志与拉取的调用参数', async () => {
	const calls = [];
	const replies = {
		'sight.docker.logs': { code: 200, body: { text: 'a\nb\n' } },
		'sight.docker.pull_start': { task: { image: 'busybox:latest', state: 'running' } },
		'sight.docker.image.prune': { code: 200, body: { ImagesDeleted: [{ Untagged: 'x' }], SpaceReclaimed: 1234 } },
		'sight.docker.container.create': { code: 201, body: { Id: 'c1' } },
		'sight.docker.container.start': { code: 500, body: { message: 'port is already allocated' } },
	};
	const svc = createDocker({ call: async (o, m, p) => { calls.push([o, m, p]); return replies[`${o}.${m}`] ?? { code: 204, body: '' }; } }, {});
	const id = 'f'.repeat(64);
	await svc.removeContainer(id, { force: true, volumes: false });
	assert.deepEqual(calls.at(-1), ['sight.docker.container', 'remove', { id, query: { force: true, v: false } }]);
	await svc.setRestartPolicy(id, 'always');
	assert.deepEqual(calls.at(-1), ['sight.docker.container', 'update', { id, body: { RestartPolicy: { Name: 'always' } } }]);
	await assert.rejects(svc.setRestartPolicy(id, 'sometimes'), /Unknown restart policy/);
	assert.deepEqual(await svc.pruneImages(), { reclaimed: 1234 });
	assert.deepEqual(calls.at(-1), ['sight.docker.image', 'prune', { query: { filters: '{"dangling":["false"]}' } }]);
	assert.deepEqual(await svc.logs(id), { ok: true, text: 'a\nb\n' });
	assert.deepEqual(calls.at(-1), ['sight.docker', 'logs', { id, tail: 200 }]);
	replies['sight.docker.logs'] = { code: 404, body: { message: 'No such container' } };
	assert.deepEqual(await svc.logs(id), { ok: false, text: 'No such container' });
	await assert.rejects(svc.pullStart('bad image'), /valid image name/);
	assert.deepEqual(await svc.pullStart('busybox'), { image: 'busybox:latest', state: 'running' });
	assert.deepEqual(calls.at(-1), ['sight.docker', 'pull_start', { image: 'busybox:latest' }]);
	replies['sight.docker.pull_start'] = { error: 'busy' };
	await assert.rejects(svc.pullStart('busybox'), e => e.reason === 'busy' && /Another task is running/.test(e.message));
	/* 建好但启动失败：错误带上已建容器的 ID */
	await assert.rejects(svc.create({ ...emptyCreate(), image: 'busybox:stable' }), e => e.created === 'c1' && /already allocated/.test(e.message));
	await assert.rejects(svc.action(id, 'remove'), /Unknown action/);
	await svc.action(id, 'stop');
	assert.deepEqual(calls.at(-1), ['sight.docker.container', 'stop', { id, query: { t: 10 } }]);
});

test('服务：设置写入只动改过的字段', async () => {
	const ops = [];
	const uci = { set: async (...a) => ops.push(['set', ...a]), remove: async (...a) => ops.push(['delete', ...a]), add: async (...a) => ops.push(['add', ...a]) };
	const svc = createDocker({ call: async () => ({}) }, uci);
	const base = { section: 'globals', exists: true, mirrors: ['https://a.example'], dataRoot: '/opt/docker/' };
	await svc.saveSettings(base, { mirrors: [], dataRoot: '/mnt/docker' });
	assert.deepEqual(ops, [['set', 'dockerd', 'globals', { data_root: '/mnt/docker' }], ['delete', 'dockerd', 'globals', ['registry_mirrors']]]);
});

test('更新与错误码：只有带标签的镜像引用能找新版；设备端错误码转成说明', () => {
	assert.ok(canUpdate('nginx') && canUpdate('ghcr.io/a/b:v1'));
	assert.ok(!canUpdate(`sha256:${'a'.repeat(64)}`) && !canUpdate(`nginx@sha256:${'a'.repeat(64)}`) && !canUpdate(''));
	assert.equal(replyError({ task: {} }), null);
	const e = replyError({ error: 'not_lan' });
	assert.equal(e.reason, 'not_lan');
	assert.match(e.message, /LAN address/);
	assert.equal(replyError({ error: 'weird' }).message, 'weird');
	assert.ok(MIRROR_PRESETS.length >= 1 && MIRROR_PRESETS.every(m => /^https:\/\/[a-z0-9.-]+$/.test(m.url) && m.source));
	assert.deepEqual(validateSettings({ mirrors: MIRROR_PRESETS.map(m => m.url), dataRoot: '' }), []);
});

test('服务：更新、编辑、Compose、网络/卷与终端的调用参数', async () => {
	const calls = [];
	const c = { Id: 'a'.repeat(64), Name: '/web', Image: 'sha256:old', Config: { Image: 'busybox:stable', Env: ['A=1'], Hostname: 'aaaaaaaaaaaa' }, HostConfig: { NetworkMode: 'bridge', RestartPolicy: { Name: 'no' } }, Mounts: [], NetworkSettings: { Networks: { bridge: {} } } };
	const replies = {
		'sight.docker.container.inspect': { code: 200, body: c },
		'sight.docker.image.inspect': { code: 200, body: { Config: { Env: [] } } },
		'sight.docker.recreate_start': { task: { kind: 'recreate', state: 'running' } },
		'sight.docker.compose_start': { task: { kind: 'compose', state: 'running' } },
		'sight.docker.compose_write': { error: 'invalid_compose' },
		'sight.docker.terminal_start': { session: { port: 7700, path: '/0123456789abcdef0123456789abcdef/', tls: false } },
		'sight.docker.volume.prune': { code: 200, body: { VolumesDeleted: ['a', 'b'], SpaceReclaimed: 10 } },
	};
	const svc = createDocker({ call: async (o, m, p) => { calls.push([o, m, p]); return replies[`${o}.${m}`] ?? { code: 204, body: '' }; } }, {});
	assert.deepEqual(await svc.update(c.Id), { kind: 'recreate', state: 'running' });
	const [, , upd] = calls.at(-1);
	assert.equal(upd.mode, 'update');
	assert.equal(upd.body.Image, 'busybox:stable');
	assert.deepEqual(calls.find(x => x[1] === 'inspect' && x[0] === 'sight.docker.image')[2], { id: 'sha256:old' });
	const { base, form } = await svc.editForm(c.Id);
	form.env = ['A=2'];
	form.name = 'web2';
	await svc.edit(c.Id, base, form);
	assert.deepEqual([calls.at(-1)[2].mode, calls.at(-1)[2].name, calls.at(-1)[2].body.Env], ['edit', 'web2', ['A=2']]);
	replies['sight.docker.container.inspect'] = { code: 200, body: { ...c, Config: { ...c.Config, Image: 'sha256:' + 'b'.repeat(64) } } };
	await assert.rejects(svc.update(c.Id), /image ID/);

	await svc.composeStart('app', 'remove', true);
	assert.deepEqual(calls.at(-1), ['sight.docker', 'compose_start', { name: 'app', action: 'remove', volumes: true }]);
	await assert.rejects(svc.composeWrite('app', 'x', true), e => e.reason === 'invalid_compose');
	assert.deepEqual(calls.at(-1), ['sight.docker', 'compose_write', { name: 'app', content: 'x', create: true }]);
	assert.deepEqual(await svc.pruneVolumes(), { count: 2, reclaimed: 10 });
	assert.deepEqual(calls.at(-1), ['sight.docker.volume', 'prune', { query: { filters: '{"all":["true"]}' } }]);
	await svc.createVolume('');
	assert.deepEqual(calls.at(-1), ['sight.docker.volume', 'create', { opts: {} }]);

	const r = await svc.terminalStart(c.Id, { protocol: 'http:', hostname: '192.168.1.1' });
	assert.deepEqual(calls.at(-1), ['sight.docker', 'terminal_start', { id: c.Id, host: '192.168.1.1', tls: false }]);
	assert.equal(r.url, 'http://192.168.1.1:7700/0123456789abcdef0123456789abcdef/');
	replies['sight.docker.terminal_start'].session.tls = true;
	assert.equal((await svc.terminalStart(c.Id, { protocol: 'https:', hostname: 'fd00::1' })).url, 'https://[fd00::1]:7700/0123456789abcdef0123456789abcdef/');
	assert.equal(calls.at(-1)[2].tls, true);
});

test('服务：检查更新、批量更新、资源采样与增量日志的调用参数；镜像 ID 的容器从 inspect 取引用', async () => {
	const calls = [];
	const c = { Id: A, Name: '/web', Image: 'sha256:old', Config: { Image: 'busybox:stable', Env: [] }, HostConfig: { NetworkMode: 'bridge', RestartPolicy: { Name: 'no' } }, Mounts: [], NetworkSettings: { Networks: { bridge: {} } } };
	const replies = {
		'sight.docker.version': { code: 200, body: { Version: '29' } },
		'sight.docker.info': { code: 200, body: { ServerVersion: '29', NCPU: 4 } },
		'sight.docker.container.list': { code: 200, body: [{ Id: A, Names: ['/web'], Image: 'sha256:' + B, ImageID: 'sha256:old', State: 'running', Ports: [] }] },
		'sight.docker.image.list': { code: 200, body: [{ Id: 'sha256:new', RepoTags: ['busybox:stable'], RepoDigests: [], Created: 1 }] },
		'sight.docker.df': { code: 200, body: { LayersSize: 10 } },
		'sight.docker.network.list': { code: 200, body: [] }, 'sight.docker.volume.list': { code: 200, body: { Volumes: [] } },
		'sight.docker.compose_list': { projects: [], available: true },
		'sight.docker.check_list': { images: { 'busybox:stable': { digest: D1, checked: 5 } } },
		'sight.docker.container.inspect': { code: 200, body: c },
		'sight.docker.image.inspect': { code: 404, body: { message: 'gone' } },
		'sight.docker.check_start': { task: { kind: 'check', state: 'running' } },
		'sight.docker.update_start': { task: { kind: 'update', state: 'running' } },
		'sight.docker.usage': { code: 200, body: { states: { [A]: 'running' }, samples: {} } },
		'sight.docker.logs': { code: 200, body: { text: 'x' } },
	};
	const svc = createDocker({ call: async (o, m, p) => { calls.push([o, m, p]); return replies[`${o}.${m}`] ?? { code: 204, body: '' }; } }, {});
	const data = await svc.load();
	assert.equal(data.containers[0].ref, 'busybox:stable');
	assert.deepEqual(data.checks, { 'busybox:stable': { digest: D1, checked: 5 } });
	assert.equal(updateState(data.containers[0], data.images, data.checks), 'available');
	assert.equal(data.storage.images.size, 10);

	await svc.checkStart(['busybox:stable']);
	assert.deepEqual(calls.at(-1), ['sight.docker', 'check_start', { images: ['busybox:stable'] }]);
	await svc.updateAll([A]);
	const [, , upd] = calls.at(-1);
	assert.equal(upd.items.length, 1);
	assert.equal(upd.items[0].id, A);
	assert.equal(upd.items[0].body.Image, 'busybox:stable');
	assert.deepEqual(await svc.usage(), { states: { [A]: 'running' }, samples: {} });
	await svc.logs(A, { tail: 1000, since: '1.5' });
	assert.deepEqual(calls.at(-1), ['sight.docker', 'logs', { id: A, tail: 1000, since: '1.5' }]);
	await svc.logs(A);
	assert.deepEqual(calls.at(-1), ['sight.docker', 'logs', { id: A, tail: 200 }]);
	/* 读不到 check_list（旧版后端）时视为未检查 */
	delete replies['sight.docker.check_list'];
	replies['sight.docker.container.list'].body[0].Image = 'busybox:stable';
	assert.deepEqual((await svc.load()).checks, {});
});

test('服务：补日志上限按原配置以 edit 模式批量重建', async () => {
	const calls = [];
	const c = { Id: 'a'.repeat(64), Name: '/web', Image: 'sha256:x', Config: { Image: 'busybox:stable', Env: [] }, HostConfig: { NetworkMode: 'bridge', RestartPolicy: { Name: 'no' } }, Mounts: [], NetworkSettings: { Networks: { bridge: {} } } };
	const replies = { 'sight.docker.container.inspect': { code: 200, body: c }, 'sight.docker.image.inspect': { code: 404, body: {} }, 'sight.docker.update_start': { task: { kind: 'update' } },
		'sight.docker.logs_usage': { containers: [{ id: 'a', log: {}, size: 5 }] } };
	const svc = createDocker({ call: async (o, m, p) => { calls.push([o, m, p]); return replies[`${o}.${m}`] ?? { code: 204, body: '' }; } }, {});
	assert.deepEqual(await svc.logsUsage(), [{ id: 'a', log: {}, size: 5 }]);
	await svc.limitLogs([c.Id]);
	const [, , args] = calls.at(-1);
	assert.equal(args.mode, 'edit');
	assert.deepEqual(args.items[0].body.HostConfig.LogConfig, { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } });
	assert.equal(args.items[0].body.HostConfig.RestartPolicy.Name, 'no');
});
