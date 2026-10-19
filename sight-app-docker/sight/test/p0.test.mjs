import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDockerRun, memoryMb, parsePublish, parseVolume, parseMount } from '../src/dockerRun.js';
import { emptyCreate, validateCreate, buildCreate, logOf, logConfig, imageHints, appBaseOf, createDocker,
	healthOf, troubleOf, detailOf, suggestMacvlanRange, lanOf, validateNetwork, buildNetwork, diskChoices, mountTargetFor, rootProblem, migrationNetworks } from '../src/service.js';
import { recreateBody, formFromInspect, buildEdit } from '../src/recreate.js';

test('docker run 导入：常见写法拆成表单，续行、合写短选项、= 写法与 sudo 前缀', () => {
	const r = parseDockerRun(`sudo docker run -dit --name=qb \\
		-p 8080:8080 -p 6881:6881/udp -p 127.0.0.1:9000:9000 \\
		-v /mnt/data/qb/config:/config -v downloads:/downloads:ro --mount type=bind,source=/mnt/media,target=/media,readonly \\
		-e PUID=1000 -e TZ=Asia/Shanghai --restart unless-stopped --network host --hostname qb.lan \\
		--device /dev/dri:/dev/dri --cap-add NET_ADMIN -m 1g --cpus 1.5 --log-opt max-size=10m --log-opt max-file=3 --privileged \\
		lscr.io/linuxserver/qbittorrent:latest sh -c "echo hi; sleep 1"`);
	assert.equal(r.image, 'lscr.io/linuxserver/qbittorrent:latest');
	assert.deepEqual(r.form, {
		name: 'qb', ports: [{ host: '8080', container: '8080', proto: 'tcp', ip: '' }, { host: '6881', container: '6881', proto: 'udp', ip: '' }, { host: '9000', container: '9000', proto: 'tcp', ip: '127.0.0.1' }],
		mounts: [{ host: '/mnt/data/qb/config', container: '/config', readonly: false }, { host: 'downloads', container: '/downloads', readonly: true }, { host: '/mnt/media', container: '/media', readonly: true }],
		env: ['PUID=1000', 'TZ=Asia/Shanghai'], restart: 'unless-stopped', network: 'host', hostname: 'qb.lan', devices: ['/dev/dri:/dev/dri'], caps: ['NET_ADMIN'],
		memory: '1024', cpus: '1.5', log: '10m:3', privileged: true, command: 'sh -c "echo hi; sleep 1"',
	});
	assert.deepEqual(r.warnings, []);
	/* 导入后的表单可直接通过校验并生成参数 */
	const form = { ...emptyCreate(), ...r.form, source: 'pull', pullRef: r.image };
	assert.deepEqual(validateCreate(form), []);
	assert.equal(buildCreate(form).body.HostConfig.Memory, 1024 * 1048576);
});

test('docker run 导入：不支持的参数逐条说明，不丢弃也不猜；不是 docker run 时报错', () => {
	const r = parseDockerRun('docker container run --rm -p 80 -v /data -e HOME --env-file .env -w /app --init -x --restart=on-failure:3 nginx');
	assert.equal(r.image, 'nginx:latest');
	assert.equal(r.form.restart, 'on-failure');
	const msgs = r.warnings.map(w => w.message);
	assert.ok(msgs.includes('--rm is not supported: the container is kept after it stops'));
	assert.ok(msgs.some(m => /^Port %s/.test(m)) && msgs.some(m => /^Volume %s/.test(m)) && msgs.some(m => /^Environment variable %s/.test(m)));
	assert.deepEqual(r.warnings.find(w => /were skipped/.test(w.message)).args, ['--env-file, -w, --init, -x']);
	assert.throws(() => parseDockerRun('podman run nginx'), /starts with docker run/);
	assert.throws(() => parseDockerRun('docker pull nginx'), /starts with docker run/);
	assert.throws(() => parseDockerRun('docker run -d --name x'), /No image/);
	assert.throws(() => parseDockerRun('docker run "nginx'), /unmatched quote/);
	assert.equal(parseDockerRun('docker run --log-opt max-size=5m nginx').warnings[0].message.startsWith('Log size'), true);
});

test('docker run 导入：内存、端口、卷与 --mount 的写法', () => {
	assert.deepEqual(['512m', '1g', '1.5G', '2048k', '1048576', 'x', '10k'].map(memoryMb), ['512', '1024', '1536', '2', '1', null, null]);
	assert.equal(parsePublish('8000-8010:8000-8010'), null);
	assert.equal(parsePublish('[::1]:80:80'), null);
	assert.deepEqual(parsePublish('0.0.0.0:53:53/udp'), { host: '53', container: '53', proto: 'udp', ip: '' });
	assert.equal(parseVolume('/data'), null);
	assert.equal(parseMount('type=tmpfs,target=/run'), null);
	assert.deepEqual(parseMount('source=vol,target=/v'), { host: 'vol', container: '/v', readonly: false });
});

test('日志上限：读出现有配置（预设、不限、其它）并只在改动时写回', () => {
	assert.equal(logOf(undefined), '');
	assert.equal(logOf({ Type: 'json-file', Config: {} }), '');
	assert.equal(logOf({ Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } }), '10m:3');
	assert.equal(logOf({ Type: 'json-file', Config: { 'max-size': '7m' } }), 'custom');
	assert.equal(logOf({ Type: 'syslog', Config: {} }), 'custom');
	assert.deepEqual(logConfig('20m:5'), { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } });
	assert.deepEqual(logConfig(''), { Type: 'json-file', Config: {} });
	const c = { Id: 'a'.repeat(64), Name: '/web', Config: { Image: 'busybox:stable', Env: [] }, Mounts: [], NetworkSettings: { Networks: { bridge: {} } },
		HostConfig: { NetworkMode: 'bridge', RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'syslog', Config: { tag: 'x' } }, CapAdd: ['NET_ADMIN'] } };
	const base = recreateBody(c, null), form = formFromInspect(c, base);
	assert.equal(form.log, 'custom');
	assert.deepEqual(buildEdit(base, form).HostConfig.LogConfig, { Type: 'syslog', Config: { tag: 'x' } }, '其它驱动不改');
	assert.deepEqual(buildEdit(base, { ...form, log: '10m:3' }).HostConfig.LogConfig.Config, { 'max-size': '10m', 'max-file': '3' });
	assert.deepEqual(buildEdit(base, form).HostConfig.CapAdd, ['NET_ADMIN']);
	assert.equal(buildEdit(base, { ...form, caps: [] }).HostConfig.CapAdd, null);
});

test('镜像建议：EXPOSE 端口（1024 以下加 8000）与 VOLUME 目录放到同盘 appdata，已填的不重复', () => {
	assert.equal(appBaseOf('/opt/docker/'), '/opt/appdata');
	assert.equal(appBaseOf('/mnt/sda1/docker'), '/mnt/sda1/appdata');
	assert.equal(appBaseOf(''), '/opt/appdata');
	const form = { ...emptyCreate(), image: 'linuxserver/jellyfin:latest', ports: [{ host: '8096', container: '8096', proto: 'tcp' }] };
	const h = imageHints({ ExposedPorts: { '8096/tcp': {}, '80/tcp': {}, '1900/udp': {} }, Volumes: { '/config': {}, '/x:y': {} } }, form, '/mnt/sda1/appdata');
	assert.deepEqual(h.ports, [{ host: '8080', container: '80', proto: 'tcp', ip: '' }, { host: '1900', container: '1900', proto: 'udp', ip: '' }]);
	assert.deepEqual(h.mounts, [{ host: '/mnt/sda1/appdata/jellyfin/config', container: '/config', readonly: false }]);
	assert.equal(imageHints({ Volumes: { '/config': {} } }, { ...form, name: 'media' }, '/opt/appdata').mounts[0].host, '/opt/appdata/media/config');
	assert.deepEqual(imageHints(null, form, '/x'), { ports: [], mounts: [] });
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

test('异常：列表状态里的健康检查结果，反复重启与健康检查失败要提醒；详情取 IP、环境变量、重启与退出信息', () => {
	assert.deepEqual(['Up 1 hour (healthy)', 'Up 2 minutes (unhealthy)', 'Up 3 seconds (health: starting)', 'Up 1 hour', ''].map(healthOf), ['healthy', 'unhealthy', 'starting', '', '']);
	assert.equal(troubleOf({ state: 'restarting' }), 'restarting');
	assert.equal(troubleOf({ state: 'running', health: 'unhealthy' }), 'unhealthy');
	assert.equal(troubleOf({ state: 'running', health: 'healthy' }), '');
	const d = detailOf({ RestartCount: 7, Config: { Env: ['A=1'] }, HostConfig: {},
		State: { ExitCode: 137, OOMKilled: true, Health: { Status: 'unhealthy', Log: [{ Output: 'old' }, { Output: ' curl: refused \n' }] } },
		NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.2', GlobalIPv6Address: '' }, none: { IPAddress: '' } } } });
	assert.deepEqual([d.addresses, d.env, d.health, d.healthOutput, d.restartCount, d.exitCode, d.oom], [[{ network: 'bridge', ip: '172.17.0.2', ip6: '' }], ['A=1'], 'unhealthy', 'curl: refused', 7, 137, true]);
});

test('macvlan：按 LAN 口与 DHCP 地址池建议分配范围，校验必填项并生成网络参数', () => {
	assert.equal(suggestMacvlanRange({ address: '192.168.1.1', prefix: 24 }, { start: 100, limit: 150 }), '192.168.1.64/27');
	assert.equal(suggestMacvlanRange({ address: '192.168.1.1', prefix: 24 }, { start: 10, limit: 100 }), '192.168.1.128/27');
	assert.equal(suggestMacvlanRange({ address: '192.168.1.70', prefix: 24 }, { start: 100, limit: 150 }), '192.168.1.32/27', '避开路由器自己的地址');
	assert.equal(suggestMacvlanRange({ address: '192.168.1.1', prefix: 24 }, { start: 2, limit: 253 }), '');
	assert.equal(suggestMacvlanRange({ address: '10.0.0.1', prefix: 28 }, {}), '');
	const lan = lanOf({ interface: [{ interface: 'wan', up: true }, { interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [{ address: '10.0.0.1', mask: 24 }] }] },
		{ cfg01: { '.type': 'dhcp', interface: 'lan', start: '100', limit: '150' } });
	assert.deepEqual(lan, { device: 'br-lan', address: '10.0.0.1', prefix: 24, subnet: '10.0.0.0/24', range: '10.0.0.64/27' });
	assert.equal(lanOf({ interface: [{ interface: 'lan', up: false }] }, {}), null);
	const form = { name: 'lan', driver: 'macvlan', parent: 'br-lan', subnet: '10.0.0.0/24', gateway: '10.0.0.1', range: '10.0.0.64/27', internal: true };
	assert.deepEqual(validateNetwork(form), []);
	assert.deepEqual(validateNetwork({ ...form, parent: 'br lan', range: '10.1.0.0/27' }).map(e => e.field), ['parent', 'range']);
	assert.deepEqual(validateNetwork({ ...form, gateway: '' }).map(e => e.field), ['gateway']);
	assert.deepEqual(buildNetwork(form), { Name: 'lan', Driver: 'macvlan', CheckDuplicate: true, Options: { parent: 'br-lan' },
		IPAM: { Driver: 'default', Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.1', IPRange: '10.0.0.64/27' }] } });
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
