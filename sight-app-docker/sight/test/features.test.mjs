import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocker, shape, imageRefOf, updateState, checkRefs, lastChecked, statesChanged, storageOf, parseLogs, sinceOf, appendLogs, filterLogs,
	emptyCreate, validateCreate, buildCreate, inSubnet, parseDevice, deviceText } from '../src/service.js';
import { recreateBody, formFromInspect, buildEdit, limitsOf } from '../src/recreate.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const D1 = 'sha256:' + '1'.repeat(64), D2 = 'sha256:' + '2'.repeat(64);

test('检查更新：镜像引用统一写法，镜像 ID 与摘要不参与', () => {
	assert.equal(imageRefOf('busybox'), 'busybox:latest');
	assert.equal(imageRefOf('docker.io/library/nginx:1.27'), 'nginx:1.27');
	assert.equal(imageRefOf('library/nginx'), 'nginx:latest');
	assert.equal(imageRefOf('ghcr.io/owner/app:v1'), 'ghcr.io/owner/app:v1');
	assert.equal(imageRefOf('docker.io/owner/app'), 'owner/app:latest');
	for (const id of ['sha256:' + B, '2002aed19b32', B, `alpine@${D1}`, '']) assert.equal(imageRefOf(id), '', id);
});

test('检查更新：本机标签已指向新镜像即有新版；否则按仓库摘要比对，没检查过为 unknown', () => {
	const { containers, images } = shape([
		{ Id: A, Names: ['/web'], Image: 'busybox:stable', ImageID: 'sha256:old', State: 'running', Ports: [] },
		{ Id: B, Names: ['/job'], Image: 'nginx', ImageID: 'sha256:ng', State: 'exited', Ports: [] },
	], [
		{ Id: 'sha256:new', RepoTags: ['busybox:stable'], RepoDigests: [`busybox@${D2}`], Created: 2 },
		{ Id: 'sha256:old', RepoTags: [], RepoDigests: [`busybox@${D1}`], Created: 1 },
		{ Id: 'sha256:ng', RepoTags: ['nginx:latest'], RepoDigests: [`nginx@${D1}`], Created: 1 },
	]);
	const [web, job] = containers;
	assert.equal(web.ref, 'busybox:stable');
	assert.deepEqual(images.find(i => i.id === 'sha256:old').digests, [D1]);
	assert.equal(updateState(web, images, {}), 'available');
	assert.equal(updateState(job, images, {}), 'unknown');
	assert.equal(updateState(job, images, { 'nginx:latest': { digest: D1 } }), 'latest');
	assert.equal(updateState(job, images, { 'nginx:latest': { digest: D2 } }), 'available');
	assert.equal(updateState(job, images, { 'nginx:latest': { error: 'timeout' } }), 'unknown');
	assert.equal(updateState({ ...job, ref: '' }, images, {}), 'none');
	assert.deepEqual(checkRefs([web, job, { ...web, id: 'x' }, { ref: '' }]), ['busybox:stable', 'nginx:latest']);
	assert.equal(lastChecked([web, job], { 'busybox:stable': { checked: 20 }, 'nginx:latest': { checked: 10 } }), 10);
	assert.equal(lastChecked([web], {}), null);
});

test('自动回读：容器增减或状态变化才回读', () => {
	const list = [{ id: 'a', state: 'running' }, { id: 'b', state: 'exited' }];
	assert.equal(statesChanged({ a: 'running', b: 'exited' }, list), false);
	assert.equal(statesChanged({ a: 'running', b: 'running' }, list), true);
	assert.equal(statesChanged({ a: 'running' }, list), true);
	assert.equal(statesChanged({ a: 'running', c: 'exited' }, list), true);
});

test('存储空间：镜像、容器可写层与卷的占用与可清理量', () => {
	const images = [{ id: 'i1', size: 100, containers: 1 }, { id: 'i2', size: 40, containers: 0 }];
	const containers = [{ id: 'c1', name: 'web', state: 'running' }, { id: 'c2', name: 'job', state: 'exited' }, { id: 'c3', name: 'new', state: 'created' }];
	const volumes = [{ name: 'v1', size: 5, containers: ['web'] }, { name: 'v2', size: 7, containers: [] }, { name: 'v3', size: null, containers: [] }];
	const s = storageOf({ LayersSize: 140, Containers: [{ Id: 'c1', SizeRw: 3 }, { Id: 'c2', SizeRw: 9 }, { Id: 'c3', SizeRw: 0 }] }, images, containers, volumes);
	assert.deepEqual(s.images, { size: 140, reclaimable: 40, count: 1 });
	assert.deepEqual([s.containers.size, s.containers.reclaimable, s.containers.count, s.containers.items.map(c => c.name)], [12, 9, 2, ['job', 'new']]);
	assert.deepEqual(s.volumes, { size: 12, reclaimable: 7, count: 2 });
	const none = storageOf(null, [], [], { error: 'x' });
	assert.deepEqual([none.images.size, none.containers.size, none.volumes.size], [null, null, null]);
});

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

test('新建容器：主机名、内存与 CPU 上限、设备直通与固定地址的校验', () => {
	const f = { ...emptyCreate(), image: 'busybox:stable' };
	const fields = (form, opts) => validateCreate(form, [], opts).map(e => e.field);
	assert.deepEqual(fields({ ...f, hostname: 'web-1.lan', memory: '512', cpus: '1.5', devices: ['/dev/dri', '/dev/ttyUSB0:/dev/ttyACM0'] }, { cpus: 4 }), []);
	assert.deepEqual(fields({ ...f, hostname: 'bad_host', memory: '5', cpus: '0', devices: ['/tmp/x'] }, { cpus: 4 }), ['hostname', 'memory', 'cpus', 'devices']);
	assert.deepEqual(fields({ ...f, cpus: '8' }, { cpus: 4 }), ['cpus']);
	assert.deepEqual(fields({ ...f, cpus: '1.255' }), ['cpus']);
	/* host 网络不设主机名；固定地址只对自定义网络，须在子网内 */
	assert.deepEqual(fields({ ...f, network: 'host', hostname: 'bad_host', ip: 'x' }), []);
	assert.deepEqual(fields({ ...f, network: 'appnet', ip: '172.30.0.10' }, { subnets: ['172.30.0.0/16'] }), []);
	const out = validateCreate({ ...f, network: 'appnet', ip: '10.0.0.1' }, [], { subnets: ['172.30.0.0/16'] });
	assert.deepEqual([out[0].field, out[0].args], ['ip', ['172.30.0.0/16']]);
	assert.deepEqual(fields({ ...f, network: 'appnet', ip: '1.2.3' }), ['ip']);
	assert.ok(inSubnet('172.30.255.1', '172.30.0.0/16') && !inSubnet('172.31.0.1', '172.30.0.0/16') && inSubnet('8.8.8.8', '0.0.0.0/0') && !inSubnet('x', '1.0.0.0/8'));
	assert.deepEqual(parseDevice('/dev/ttyUSB0:/dev/ttyACM0'), { PathOnHost: '/dev/ttyUSB0', PathInContainer: '/dev/ttyACM0', CgroupPermissions: 'rwm' });
	assert.equal(deviceText(parseDevice('/dev/dri')), '/dev/dri');
});

test('新建容器：资源限制、设备、主机名与固定地址写入 create 参数；空着不写', () => {
	const f = { ...emptyCreate(), image: 'busybox:stable', network: 'appnet', ip: '172.30.0.10', hostname: 'web', memory: '256', cpus: '0.5', devices: ['/dev/dri'] };
	const { body } = buildCreate(f);
	assert.deepEqual([body.Hostname, body.HostConfig.Memory, body.HostConfig.NanoCpus, body.HostConfig.Devices], ['web', 268435456, 5e8, [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' }]]);
	assert.deepEqual(body.NetworkingConfig, { EndpointsConfig: { appnet: { IPAMConfig: { IPv4Address: '172.30.0.10' } } } });
	const plain = buildCreate({ ...emptyCreate(), image: 'busybox:stable', hostname: 'x', ip: '172.30.0.10' }).body;
	assert.ok(!('Memory' in plain.HostConfig) && !('NanoCpus' in plain.HostConfig) && !('Devices' in plain.HostConfig) && !plain.NetworkingConfig && plain.Hostname === 'x');
	assert.ok(!('Hostname' in buildCreate({ ...emptyCreate(), image: 'busybox:stable', network: 'host', hostname: 'x' }).body));
});

const inspect = () => ({
	Id: A, Name: '/web', Image: 'sha256:old',
	Config: { Hostname: 'myhost', Image: 'busybox:stable', Env: [], Cmd: ['sleep', '1'] },
	HostConfig: { NetworkMode: 'appnet', RestartPolicy: { Name: 'no' }, Memory: 300000000, MemorySwap: 600000000, CpuQuota: 150000, CpuPeriod: 100000,
		Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }] },
	Mounts: [],
	NetworkSettings: { Networks: { appnet: { IPAMConfig: { IPv4Address: '172.30.0.5' }, Aliases: null } } },
});

test('编辑：预填主机名、资源限制、设备与固定地址；不改时原写法保留', () => {
	const c = inspect(), base = recreateBody(c, null);
	assert.deepEqual(limitsOf(base.body), { hostname: 'myhost', memory: '286', cpus: '1.5', devices: ['/dev/net/tun'], ip: '172.30.0.5' });
	const body = buildEdit(base, formFromInspect(c, base));
	const pick = b => [b.Hostname, b.HostConfig.Memory, b.HostConfig.MemorySwap, b.HostConfig.NanoCpus, b.HostConfig.CpuQuota, b.HostConfig.CpuPeriod, b.HostConfig.Devices, b.NetworkingConfig];
	assert.deepEqual(pick(body), pick(base.body));
});

test('编辑：改动的资源限制换成新写法，清空即取消；改固定地址与主机名', () => {
	const c = inspect(), base = recreateBody(c, null);
	const form = { ...formFromInspect(c, base), memory: '512', cpus: '', devices: ['/dev/dri'], ip: '172.30.0.9', hostname: '' };
	const body = buildEdit(base, form), host = body.HostConfig;
	assert.deepEqual([host.Memory, host.MemorySwap, host.NanoCpus, host.CpuQuota, host.CpuPeriod], [536870912, 0, 0, 0, 0]);
	assert.deepEqual(host.Devices, [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' }]);
	assert.deepEqual(body.NetworkingConfig.EndpointsConfig.appnet.IPAMConfig, { IPv4Address: '172.30.0.9' });
	assert.ok(!('Hostname' in body));
	const cleared = buildEdit(base, { ...formFromInspect(c, base), ip: '' });
	assert.ok(!cleared.NetworkingConfig.EndpointsConfig.appnet.IPAMConfig);
	/* 换到另一个自定义网络时地址写在新网络上 */
	const moved = buildEdit(base, { ...formFromInspect(c, base), network: 'other', ip: '10.9.0.2' });
	assert.deepEqual(moved.NetworkingConfig.EndpointsConfig, { other: { IPAMConfig: { IPv4Address: '10.9.0.2' } } });
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
