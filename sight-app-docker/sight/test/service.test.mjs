import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrap, formatPorts, shape, createDocker, DockerError, isImageRef, normalizeImage, splitCommand, emptyCreate, validateCreate, buildCreate, cpuPercent, memoryUsage, detailOf, pullPercent, settingsOf, validateSettings, settingsPlan, sameDir, pendingRestart,
	portLinks, groupContainers, projectsOf, isProjectName, validateProject, networksOf, volumesOf, validateNetwork, buildNetwork, canUpdate, replyError, MIRROR_PRESETS } from '../src/service.js';

test('插件响应：code ≥ 300 抛出 body.message，否则返回 body', () => {
	assert.deepEqual(unwrap({ code: 200, body: [1] }), [1]);
	assert.throws(() => unwrap({ code: 500, body: { message: 'Failed to connect' } }), e => e instanceof DockerError && e.code === 500 && /Failed to connect/.test(e.message));
	assert.throws(() => unwrap(null), DockerError);
});

test('端口：只列发布到主机的映射，IPv4/IPv6 去重', () => {
	assert.deepEqual(formatPorts([{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8081, Type: 'tcp' }, { IP: '::', PrivatePort: 80, PublicPort: 8081, Type: 'tcp' }, { PrivatePort: 443, Type: 'tcp' }]), ['8081→80/tcp']);
});

test('整形：运行中的容器在前；镜像使用数按容器 ImageID 统计，无标签镜像去掉 <none>', () => {
	const { containers, images } = shape([
		{ Id: 'b'.repeat(64), Names: ['/job'], Image: 'busybox', ImageID: 'img1', State: 'exited', Status: 'Exited (3)', Ports: [] },
		{ Id: 'a'.repeat(64), Names: ['/web'], Image: 'busybox', ImageID: 'img1', State: 'running', Status: 'Up', Ports: [] },
	], [{ Id: 'img1', RepoTags: ['busybox:stable'], Size: 10, Created: 2 }, { Id: 'img2', RepoTags: ['<none>:<none>'], Size: 5, Created: 1 }]);
	assert.deepEqual(containers.map(c => c.name), ['web', 'job']);
	assert.deepEqual(images.map(i => [i.id, i.tags, i.containers]), [['img1', ['busybox:stable'], 2], ['img2', [], 0]]);
});

test('镜像引用：接受常见写法，拒绝含空白、shell 字符或大写路径的输入；未写标签补 :latest', () => {
	for (const ok of ['busybox', 'busybox:stable', 'library/nginx:1.27-alpine', 'ghcr.io/owner/app:v1', 'localhost:5000/a/b', `alpine@sha256:${'a'.repeat(64)}`])
		assert.ok(isImageRef(ok), ok);
	for (const bad of ['', 'busybox; rm -rf /', 'Busybox', 'a b', '$(id)', 'nginx:', `a:b@sha256:${'a'.repeat(64)}`, '-x', 'x'.repeat(256)])
		assert.ok(!isImageRef(bad), bad);
	assert.equal(normalizeImage(' nginx '), 'nginx:latest');
	assert.equal(normalizeImage('localhost:5000/app'), 'localhost:5000/app:latest');
	assert.equal(normalizeImage('busybox:stable'), 'busybox:stable');
	assert.equal(normalizeImage(`a@sha256:${'b'.repeat(64)}`), `a@sha256:${'b'.repeat(64)}`);
});

test('命令拆分：空白分隔，引号与转义保留空格；引号不配对为 null', () => {
	assert.deepEqual(splitCommand(`sh -c "echo 'a b'; sleep 1" x\\ y ''`), ['sh', '-c', "echo 'a b'; sleep 1", 'x y', '']);
	assert.deepEqual(splitCommand('  '), []);
	assert.equal(splitCommand('echo "x'), null);
});

test('新建容器：校验各项并指向出错控件', () => {
	const form = { ...emptyCreate(), image: 'busybox:stable' };
	assert.deepEqual(validateCreate(form), []);
	const bad = { ...form, name: 'a', ports: [{ host: '0', container: '80', proto: 'tcp' }], mounts: [{ host: 'data', container: '/d', readonly: false }], env: ['NOVALUE'], command: 'echo "x' };
	assert.deepEqual(validateCreate(bad).map(e => e.field), ['name', 'ports', 'mounts', 'env', 'command']);
	assert.deepEqual(validateCreate({ ...form, name: 'web' }, ['web']).map(e => e.message), ['A container with this name already exists']);
	assert.deepEqual(validateCreate({ ...form, ports: [{ host: '80', container: '80', proto: 'tcp' }, { host: '80', container: '81', proto: 'tcp' }] }).map(e => e.field), ['ports']);
	/* 同一端口号 TCP/UDP 各一条不冲突；host 网络不校验端口；空行忽略 */
	assert.deepEqual(validateCreate({ ...form, ports: [{ host: '53', container: '53', proto: 'tcp' }, { host: '53', container: '53', proto: 'udp' }, { host: '', container: '', proto: 'tcp' }] }), []);
	assert.deepEqual(validateCreate({ ...form, network: 'host', ports: [{ host: 'x', container: '', proto: 'tcp' }] }), []);
	assert.deepEqual(validateCreate({ ...form, source: 'pull', pullRef: '' }).map(e => e.message), ['Enter the image to download, for example nginx:latest']);
	assert.deepEqual(validateCreate({ ...form, source: 'pull', pullRef: 'bad image' }).map(e => e.field), ['image']);
});

test('新建容器：表单 → create 参数（端口、目录、环境变量、命令、重启策略与网络）', () => {
	const r = buildCreate({ ...emptyCreate(), image: 'busybox:stable', name: ' web ', ports: [{ host: '8081', container: '80', proto: 'tcp' }, { host: '', container: '', proto: 'tcp' }], mounts: [{ host: '/mnt/a ', container: '/data', readonly: true }], env: ['TZ=Asia/Shanghai'], command: 'httpd -f -p 80', privileged: true });
	assert.deepEqual(r, {
		query: { name: 'web' },
		body: {
			Image: 'busybox:stable', Env: ['TZ=Asia/Shanghai'], Cmd: ['httpd', '-f', '-p', '80'], ExposedPorts: { '80/tcp': {} },
			HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'bridge', PortBindings: { '80/tcp': [{ HostPort: '8081' }] }, Binds: ['/mnt/a:/data:ro'], Privileged: true },
		},
	});
	const host = buildCreate({ ...emptyCreate(), source: 'pull', pullRef: 'nginx', network: 'host', restart: 'no', ports: [{ host: '80', container: '80', proto: 'tcp' }] });
	assert.deepEqual(host, { query: {}, body: { Image: 'nginx:latest', HostConfig: { RestartPolicy: { Name: 'no' }, NetworkMode: 'host' } } });
});

test('资源占用：CPU 取两次采样之差按核数折算，内存扣除 inactive_file；取不到为 null', () => {
	const at = (cpu, system) => ({ cpu_stats: { cpu_usage: { total_usage: cpu }, system_cpu_usage: system, online_cpus: 4 } });
	assert.equal(cpuPercent(at(100, 1000), at(150, 2000)), 20);
	assert.equal(cpuPercent(null, at(150, 2000)), null);
	assert.equal(cpuPercent(at(100, 1000), at(150, 1000)), null);
	assert.deepEqual(memoryUsage({ memory_stats: { usage: 1000, limit: 4000, stats: { inactive_file: 300 } } }), { used: 700, limit: 4000 });
	assert.deepEqual(memoryUsage({ memory_stats: { usage: 1000, limit: 4000, stats: { total_inactive_file: 200, inactive_file: 300 } } }), { used: 800, limit: 4000 });
	assert.equal(memoryUsage({ memory_stats: { stats: {} } }), null);
});

test('详情与拉取进度整形', () => {
	assert.deepEqual(detailOf({ HostConfig: { RestartPolicy: { Name: '' }, NetworkMode: 'bridge' }, Mounts: [{ Type: 'bind', Source: '/mnt/a', Destination: '/a', RW: false }, { Type: 'volume', Name: 'v1', Source: '/x/_data', Destination: '/b', RW: true }] }),
		{ imageRef: '', restart: 'no', network: 'bridge', mounts: [{ type: 'bind', source: '/mnt/a', destination: '/a', readonly: true }, { type: 'volume', source: 'v1', destination: '/b', readonly: false }] });
	assert.equal(pullPercent({ current: 50, total: 200 }), 25);
	assert.equal(pullPercent({ current: 0, total: 0 }), null);
});

test('设置：读 globals 段，只写改动字段，清空用 delete；数据目录比较忽略末尾斜杠', () => {
	const base = settingsOf({ g: { '.type': 'globals', '.name': 'globals', data_root: '/opt/docker/', registry_mirrors: ['https://a.example'] } });
	assert.deepEqual(base, { section: 'globals', exists: true, mirrors: ['https://a.example'], dataRoot: '/opt/docker/' });
	assert.deepEqual(settingsPlan(base, { mirrors: ['https://a.example'], dataRoot: '/opt/docker/' }), { values: {}, remove: [] });
	assert.deepEqual(settingsPlan(base, { mirrors: [], dataRoot: ' /mnt/sda1/docker ' }), { values: { data_root: '/mnt/sda1/docker' }, remove: ['registry_mirrors'] });
	assert.deepEqual(settingsPlan(base, { mirrors: ['https://b.example'], dataRoot: '' }), { values: { registry_mirrors: ['https://b.example'] }, remove: ['data_root'] });
	assert.deepEqual(validateSettings({ mirrors: ['mirror.example'], dataRoot: 'docker' }).map(e => e.field), ['mirrors', 'data-root']);
	assert.deepEqual(validateSettings({ mirrors: ['https://m.example:5000/x'], dataRoot: '/mnt/data/docker' }), []);
	assert.ok(sameDir('/tmp/docker/', '/tmp/docker') && !sameDir('/opt/docker', '/tmp/docker'));
});

test('服务：删除容器、重启策略、清理镜像、日志与拉取的调用参数', async () => {
	const calls = [];
	const replies = {
		'sight.docker.logs': { code: 200, body: { text: 'a\nb\n' } },
		'sight.docker.pull_start': { task: { image: 'busybox:latest', state: 'running' } },
		'docker.image.prune': { code: 200, body: { ImagesDeleted: [{ Untagged: 'x' }], SpaceReclaimed: 1234 } },
		'docker.container.create': { code: 201, body: { Id: 'c1' } },
		'docker.container.start': { code: 500, body: { message: 'port is already allocated' } },
	};
	const svc = createDocker({ call: async (o, m, p) => { calls.push([o, m, p]); return replies[`${o}.${m}`] ?? { code: 204, body: '' }; } }, {});
	const id = 'f'.repeat(64);
	await svc.removeContainer(id, { force: true, volumes: false });
	assert.deepEqual(calls.at(-1), ['docker.container', 'remove', { id, query: { force: true, v: false } }]);
	await svc.setRestartPolicy(id, 'always');
	assert.deepEqual(calls.at(-1), ['docker.container', 'update', { id, body: { RestartPolicy: { Name: 'always' } } }]);
	await assert.rejects(svc.setRestartPolicy(id, 'sometimes'), /Unknown restart policy/);
	assert.deepEqual(await svc.pruneImages(), { reclaimed: 1234 });
	assert.deepEqual(calls.at(-1), ['docker.image', 'prune', { query: { filters: '{"dangling":["false"]}' } }]);
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
	assert.deepEqual(calls.at(-1), ['docker.container', 'stop', { id, query: { t: 10 } }]);
});

test('服务：设置写入只动改过的字段', async () => {
	const ops = [];
	const uci = { set: async (...a) => ops.push(['set', ...a]), remove: async (...a) => ops.push(['delete', ...a]), add: async (...a) => ops.push(['add', ...a]) };
	const svc = createDocker({ call: async () => ({}) }, uci);
	const base = { section: 'globals', exists: true, mirrors: ['https://a.example'], dataRoot: '/opt/docker/' };
	await svc.saveSettings(base, { mirrors: [], dataRoot: '/mnt/docker' });
	assert.deepEqual(ops, [['set', 'dockerd', 'globals', { data_root: '/mnt/docker' }], ['delete', 'dockerd', 'globals', ['registry_mirrors']]]);
});

test('设置：运行值与配置不一致时提示重启（数据目录；镜像加速全部删除后 reload 不清除）', () => {
	const running = { root: '/tmp/docker', mirrors: ['https://a.example/'] };
	assert.deepEqual(pendingRestart({ dataRoot: '/tmp/docker/', mirrors: ['https://a.example'] }, running), []);
	assert.deepEqual(pendingRestart({ dataRoot: '/mnt/docker', mirrors: [] }, running), ['data-root', 'mirrors']);
	/* 未设置 data_root 时按 init 脚本缺省 /opt/docker/ 比较 */
	assert.deepEqual(pendingRestart({ dataRoot: '', mirrors: [] }, { root: '/opt/docker', mirrors: [] }), []);
	assert.deepEqual(pendingRestart({ dataRoot: '', mirrors: [] }, { root: '', mirrors: undefined }), []);
});

test('打开网页：发布到设备的 TCP 端口，主机名取浏览器访问路由器时的；443/8443 用 https，回环与 UDP 不列', () => {
	const ports = [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }, { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
		{ IP: '0.0.0.0', PrivatePort: 443, PublicPort: 8443, Type: 'tcp' }, { IP: '0.0.0.0', PrivatePort: 443, PublicPort: 443, Type: 'tcp' },
		{ IP: '127.0.0.1', PrivatePort: 9000, PublicPort: 9000, Type: 'tcp' }, { IP: '0.0.0.0', PrivatePort: 53, PublicPort: 53, Type: 'udp' }, { PrivatePort: 81, Type: 'tcp' },
		{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 80, Type: 'tcp' }];
	assert.deepEqual(portLinks(ports, '192.168.1.1'), [
		{ port: 80, url: 'http://192.168.1.1/' }, { port: 443, url: 'https://192.168.1.1/' }, { port: 8080, url: 'http://192.168.1.1:8080/' }, { port: 8443, url: 'https://192.168.1.1:8443/' }]);
	assert.equal(portLinks(ports.slice(0, 1), '[fd00::1]')[0].url, 'http://[fd00::1]:8080/');
	assert.equal(portLinks(ports.slice(0, 1), 'fd00::1')[0].url, 'http://[fd00::1]:8080/');
	assert.deepEqual(portLinks([], 'router.lan'), []);
});

const container = (name, extra = {}) => ({ Id: name.padEnd(64, '0'), Names: ['/' + name], Image: 'busybox', ImageID: 'i', State: 'running', Status: 'Up', Ports: [], Labels: {}, NetworkSettings: { Networks: { bridge: {} } }, Mounts: [], ...extra });

test('Compose：按项目标签归组；本页保存的项目与别处创建的合并，统计运行状态', () => {
	const { containers } = shape([
		container('solo'),
		container('app-web-1', { Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' } }),
		container('app-db-1', { State: 'exited', Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'db' } }),
		container('cli-x-1', { Labels: { 'com.docker.compose.project': 'cli', 'com.docker.compose.project.working_dir': '/root/cli' } }),
	], []);
	const g = groupContainers(containers);
	assert.deepEqual(g.standalone.map(c => c.name), ['solo']);
	assert.deepEqual(g.projects.map(p => [p.name, p.containers.map(c => c.service)]), [['app', ['web', 'db']], ['cli', ['']]]);
	const projects = projectsOf([{ name: 'app', modified: 1 }, { name: 'empty', modified: 2 }], containers);
	assert.deepEqual(projects.map(p => [p.name, p.managed, p.state, p.running, p.containers.length]),
		[['app', true, 'partial', 1, 2], ['cli', false, 'running', 1, 1], ['empty', true, 'empty', 0, 0]]);
	assert.equal(projects[1].workingDir, '/root/cli');
});

test('Compose：项目名与文件校验', () => {
	for (const ok of ['app', 'my-app_2', '0x']) assert.ok(isProjectName(ok), ok);
	for (const bad of ['', 'App', '-x', 'a b', 'a/b', '../x', 'x'.repeat(64), 'a;id']) assert.ok(!isProjectName(bad), bad);
	const yaml = 'services:\n  web:\n    image: busybox\n';
	assert.deepEqual(validateProject({ name: 'app', content: yaml }), []);
	assert.deepEqual(validateProject({ name: 'App', content: '' }).map(e => e.field), ['name', 'content']);
	assert.deepEqual(validateProject({ name: 'app', content: yaml }, ['app']).map(e => e.message), ['A project with this name already exists']);
	assert.deepEqual(validateProject({ name: 'app', content: 'version: 3' }).map(e => e.field), ['content']);
	assert.deepEqual(validateProject({ name: '', content: yaml }, [], false), [], '编辑已有项目时不校验名称');
	assert.deepEqual(validateProject({ name: 'app', content: 'services:\n' + 'x'.repeat(131072) }).map(e => e.message), ['The file is larger than 128 KB']);
});

test('网络与卷：连接的容器与使用者取自容器列表，卷大小取自 system/df', () => {
	const { containers } = shape([
		container('web', { NetworkSettings: { Networks: { appnet: {}, bridge: {} } }, Mounts: [{ Type: 'volume', Name: 'data' }, { Type: 'bind', Source: '/x' }] }),
		container('job', { State: 'exited', NetworkSettings: { Networks: { appnet: {} } } }),
	], []);
	const nets = networksOf([
		{ Id: 'n1', Name: 'appnet', Driver: 'bridge', Scope: 'local', IPAM: { Config: [{ Subnet: '172.30.0.0/16', Gateway: '172.30.0.1' }] }, Labels: { 'com.docker.compose.project': 'app' } },
		{ Id: 'n0', Name: 'bridge', Driver: 'bridge', Scope: 'local', IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } },
		{ Id: 'n2', Name: 'host', Driver: 'host', Scope: 'local', IPAM: { Config: [] } },
	], containers);
	assert.deepEqual(nets.map(n => [n.name, n.builtin, n.containers]), [['bridge', true, ['web']], ['host', true, []], ['appnet', false, ['job', 'web']]]);
	assert.deepEqual([nets[2].subnets, nets[2].gateways, nets[2].project], [['172.30.0.0/16'], ['172.30.0.1'], 'app']);
	const vols = volumesOf({ Volumes: [
		{ Name: 'f'.repeat(64), Driver: 'local', Labels: { 'com.docker.volume.anonymous': '' }, CreatedAt: '2026-10-16T08:00:00Z' },
		{ Name: 'data', Driver: 'local', Labels: null, Mountpoint: '/opt/docker/volumes/data/_data' },
	] }, { Volumes: [{ Name: 'data', UsageData: { Size: 4096, RefCount: 1 } }, { Name: 'f'.repeat(64), UsageData: { Size: -1 } }] }, containers);
	assert.deepEqual(vols.map(v => [v.name.slice(0, 4), v.anonymous, v.size, v.containers]), [['data', false, 4096, ['web']], ['ffff', true, null, []]]);
	assert.equal(vols[1].created, Date.parse('2026-10-16T08:00:00Z') / 1000);
	assert.deepEqual(volumesOf({ Volumes: null }, null, []), []);
});

test('新建网络：名称、子网与网关校验，表单 → create 参数', () => {
	const form = { name: 'appnet', subnet: '', gateway: '', internal: false };
	assert.deepEqual(validateNetwork(form, ['bridge']), []);
	assert.deepEqual(validateNetwork({ ...form, name: 'bridge' }, ['bridge']).map(e => e.field), ['name']);
	assert.deepEqual(validateNetwork({ ...form, subnet: '172.30.0.0', gateway: 'x' }).map(e => e.field), ['subnet', 'gateway']);
	assert.deepEqual(validateNetwork({ ...form, gateway: '172.30.0.1' }).map(e => e.message), ['Set the subnet together with the gateway']);
	assert.deepEqual(buildNetwork(form), { Name: 'appnet', Driver: 'bridge', CheckDuplicate: true });
	assert.deepEqual(buildNetwork({ name: ' n ', subnet: '172.30.0.0/16', gateway: '172.30.0.1', internal: true }),
		{ Name: 'n', Driver: 'bridge', CheckDuplicate: true, IPAM: { Driver: 'default', Config: [{ Subnet: '172.30.0.0/16', Gateway: '172.30.0.1' }] }, Internal: true });
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
		'docker.container.inspect': { code: 200, body: c },
		'docker.image.inspect': { code: 200, body: { Config: { Env: [] } } },
		'sight.docker.recreate_start': { task: { kind: 'recreate', state: 'running' } },
		'sight.docker.compose_start': { task: { kind: 'compose', state: 'running' } },
		'sight.docker.compose_write': { error: 'invalid_compose' },
		'sight.docker.terminal_start': { session: { port: 7700, path: '/0123456789abcdef0123456789abcdef/', tls: false } },
		'docker.volume.prune': { code: 200, body: { VolumesDeleted: ['a', 'b'], SpaceReclaimed: 10 } },
	};
	const svc = createDocker({ call: async (o, m, p) => { calls.push([o, m, p]); return replies[`${o}.${m}`] ?? { code: 204, body: '' }; } }, {});
	assert.deepEqual(await svc.update(c.Id), { kind: 'recreate', state: 'running' });
	const [, , upd] = calls.at(-1);
	assert.equal(upd.mode, 'update');
	assert.equal(upd.body.Image, 'busybox:stable');
	assert.deepEqual(calls.find(x => x[1] === 'inspect' && x[0] === 'docker.image')[2], { id: 'sha256:old' });
	const { base, form } = await svc.editForm(c.Id);
	form.env = ['A=2'];
	form.name = 'web2';
	await svc.edit(c.Id, base, form);
	assert.deepEqual([calls.at(-1)[2].mode, calls.at(-1)[2].name, calls.at(-1)[2].body.Env], ['edit', 'web2', ['A=2']]);
	replies['docker.container.inspect'] = { code: 200, body: { ...c, Config: { ...c.Config, Image: 'sha256:' + 'b'.repeat(64) } } };
	await assert.rejects(svc.update(c.Id), /image ID/);

	await svc.composeStart('app', 'remove', true);
	assert.deepEqual(calls.at(-1), ['sight.docker', 'compose_start', { name: 'app', action: 'remove', volumes: true }]);
	await assert.rejects(svc.composeWrite('app', 'x', true), e => e.reason === 'invalid_compose');
	assert.deepEqual(calls.at(-1), ['sight.docker', 'compose_write', { name: 'app', content: 'x', create: true }]);
	assert.deepEqual(await svc.pruneVolumes(), { count: 2, reclaimed: 10 });
	assert.deepEqual(calls.at(-1), ['docker.volume', 'prune', { query: { filters: '{"all":["true"]}' } }]);
	await svc.createVolume('');
	assert.deepEqual(calls.at(-1), ['docker.volume', 'create', { opts: {} }]);

	const r = await svc.terminalStart(c.Id, { protocol: 'http:', hostname: '192.168.1.1' });
	assert.deepEqual(calls.at(-1), ['sight.docker', 'terminal_start', { id: c.Id, host: '192.168.1.1', tls: false }]);
	assert.equal(r.url, 'http://192.168.1.1:7700/0123456789abcdef0123456789abcdef/');
	replies['sight.docker.terminal_start'].session.tls = true;
	assert.equal((await svc.terminalStart(c.Id, { protocol: 'https:', hostname: 'fd00::1' })).url, 'https://[fd00::1]:7700/0123456789abcdef0123456789abcdef/');
	assert.equal(calls.at(-1)[2].tls, true);
});
