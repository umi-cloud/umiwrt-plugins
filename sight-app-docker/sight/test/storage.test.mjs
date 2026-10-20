import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocker } from '../src/service.js';
import { storageOf, diskChoices, mountTargetFor, rootProblem, migrationNetworks, diskOf } from '../src/storage.js';
const A = 'a'.repeat(64), B = 'b'.repeat(64);

const ID = 'abcdef0123456789'.repeat(4);

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

const storage = { disks: [
	{ name: 'mmcblk0', volumes: [
		{ name: 'mmcblk0p5', partname: 'production', fstype: 'squashfs', system: true, mounts: ['/rom'], usage: { avail: 0, size: 1 } },
		{ name: 'mmcblk0p6', label: 'data', fstype: 'ext4', system: false, mounts: ['/mnt/data'], usage: { avail: 30e9, size: 56e9 } },
	] },
	{ name: 'sda', volumes: [
		{ name: 'sda1', label: 'USB', fstype: 'vfat', system: false, mounts: ['/mnt/sda1'], usage: { avail: 8e9, size: 16e9 } },
		{ name: 'sda2', fstype: 'ext4', system: false, mounts: [], usage: null },
	] },
] };

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

test('数据目录：分区分为已挂载、可挂载使用与格式不合适；挂载点取卷标；文件系统问题与被盖住的判断', () => {
	const choices = diskChoices({ disks: [{ volumes: [
		{ name: 'sda1', device: '/dev/sda1', fstype: 'ext4', label: 'data', mounts: ['/mnt/data'], usage: { avail: 10, size: 20 } },
		{ name: 'sda2', device: '/dev/sda2', fstype: 'ext4', label: 'my disk', size: 50, mounts: [] },
		{ name: 'sda3', device: '/dev/sda3', fstype: 'vfat', label: 'usb', mounts: ['/mnt/usb'], usage: { avail: 1, size: 2 } },
		{ name: 'mmcblk0p5', device: '/dev/mmcblk0p5', fstype: 'ext4', system: true, mounts: [] },
		{ name: 'sdb1', device: '/dev/sdb1', fstype: 'swap', mounts: [] },
	] }] });
	assert.deepEqual(choices.usable.map(d => d.mount), ['/mnt/data']);
	assert.deepEqual(choices.unmounted, [{ device: '/dev/sda2', name: 'sda2', title: 'my disk', fstype: 'ext4', size: 50 }]);
	assert.deepEqual(choices.unsupported.map(d => d.fstype), ['vfat']);
	assert.equal(mountTargetFor(choices.unmounted[0]), '/mnt/my-disk');
	assert.equal(mountTargetFor({ title: 'data', name: 'sdc1' }, ['/mnt/data']), '/mnt/sdc1');
	assert.equal(mountTargetFor({ title: '../..', name: 'sdc1' }), '/mnt/sdc1');
	assert.equal(rootProblem({ root: '/opt/docker', driver: 'overlayfs', fstype: 'overlay' }), 'unsupported');
	assert.equal(rootProblem({ root: '/opt/docker', driver: 'native', fstype: 'overlay' }), '');
	assert.equal(rootProblem({ root: '/mnt/data/docker', driver: 'overlayfs', fstype: 'ext4' }), '');
	assert.equal(rootProblem({ root: '/opt/docker', driver: 'overlayfs', fstype: 'ext4', shadowed: true }), 'shadowed');
	assert.equal(rootProblem({ root: '/tmp/docker', driver: 'overlayfs', fstype: 'tmpfs' }), 'temporary');
	assert.equal(rootProblem(null), '');
});

test('迁移：网络只迁自建的；计划含卷、单独的容器（按重建参数）与在运行的本页 Compose 项目，镜像 ID 创建的跳过', async () => {
	assert.deepEqual(migrationNetworks([{ Name: 'bridge' }, { Name: 'app_default', Labels: { 'com.docker.compose.project': 'app' } },
		{ Name: 'lan', Driver: 'macvlan', Options: { parent: 'br-lan' }, IPAM: { Driver: 'default', Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.1', IPRange: '10.0.0.64/27', AuxiliaryAddresses: {} }] }, Labels: {} }]),
	[{ Name: 'lan', Driver: 'macvlan', CheckDuplicate: true, Options: { parent: 'br-lan' }, IPAM: { Driver: 'default', Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.1', IPRange: '10.0.0.64/27' }] } }]);
	const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
	const inspect = { [A]: { Id: A, Name: '/web', Config: { Image: 'nginx:latest', Env: [] }, HostConfig: { NetworkMode: 'bridge' }, Mounts: [], NetworkSettings: { Networks: { bridge: {} } } },
		[B]: { Id: B, Name: '/raw', Config: { Image: 'sha256:' + 'f'.repeat(64), Env: [] }, HostConfig: {}, Mounts: [], NetworkSettings: { Networks: {} } } };
	const calls = [];
	const replies = {
		'sight.docker.container.list': { code: 200, body: [
			{ Id: A, Names: ['/web'], Image: 'nginx:latest', State: 'running', Ports: [] }, { Id: B, Names: ['/raw'], Image: 'x', State: 'exited', Ports: [] },
			{ Id: C, Names: ['/app-web-1'], Image: 'x', State: 'running', Ports: [], Labels: { 'com.docker.compose.project': 'app' } }] },
		'sight.docker.network.list': { code: 200, body: [{ Name: 'bridge' }] },
		'sight.docker.volume.list': { code: 200, body: { Volumes: [{ Name: 'data', Driver: 'local', Labels: { x: '1' } }, { Name: 'nfs', Driver: 'nfs' }] } },
		'sight.docker.compose_list': { projects: [{ name: 'app' }, { name: 'idle' }] },
		'sight.docker.migrate_start': { task: { kind: 'migrate' } },
	};
	const svc = createDocker({ call: async (o, m, p) => {
		calls.push([o, m, p]);
		if (`${o}.${m}` === 'sight.docker.container.inspect') return { code: 200, body: inspect[p.id] };
		if (`${o}.${m}` === 'sight.docker.image.inspect') return { code: 404, body: {} };
		return replies[`${o}.${m}`] ?? { code: 204, body: '' };
	} }, {});
	const r = await svc.migrate('/opt/docker/');
	assert.deepEqual(r.skipped, ['raw']);
	const plan = calls.find(c => c[1] === 'migrate_start')[2];
	assert.equal(plan.old_root, '/opt/docker');
	assert.deepEqual(plan.volumes, [{ name: 'data', labels: { x: '1' } }]);
	assert.deepEqual(plan.containers.map(c => [c.name, c.running, c.body.Image]), [['web', true, 'nginx:latest']]);
	assert.deepEqual(plan.projects, ['app']);
	assert.deepEqual(plan.networks, []);
});

test('数据盘：只取已挂载的非系统卷，按文件系统分出可用与不可用，可用的按剩余空间排序', () => {
	const r = diskChoices(storage);
	assert.deepEqual(r.usable.map(d => [d.mount, d.title, d.fstype]), [['/mnt/data', 'data', 'ext4']]);
	assert.deepEqual(r.unsupported.map(d => [d.mount, d.fstype]), [['/mnt/sda1', 'vfat']]);
	assert.deepEqual(diskChoices(null), { usable: [], unmounted: [], unsupported: [] });
});

test('数据目录落在哪块盘：取最长挂载点前缀；默认目录在内部存储上', () => {
	const usable = [{ mount: '/mnt' }, { mount: '/mnt/data' }];
	assert.equal(diskOf('/mnt/data/docker', usable).mount, '/mnt/data');
	assert.equal(diskOf('/mnt/data', usable).mount, '/mnt/data');
	assert.equal(diskOf('/mnt/database', usable).mount, '/mnt');
	assert.equal(diskOf('', usable), null);
	assert.equal(diskOf('/opt/docker/', usable), null);
});
