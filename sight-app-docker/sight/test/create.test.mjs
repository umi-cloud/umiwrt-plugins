import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inSubnet } from '../src/resources.js';
import { splitCommand, logOf, logConfig, appBaseOf, imageHints, emptyCreate, parseDevice, deviceText, validateCreate, buildCreate } from '../src/create.js';
import { recreateBody, formFromInspect, buildEdit } from '../src/recreate.js';
const container = (name, extra = {}) => ({ Id: name.padEnd(64, '0'), Names: ['/' + name], Image: 'busybox', ImageID: 'i', State: 'running', Status: 'Up', Ports: [], Labels: {}, NetworkSettings: { Networks: { bridge: {} } }, Mounts: [], ...extra });

const image = { Config: { Env: ['PATH=/usr/bin', 'APP_VERSION=1'], Cmd: ['httpd', '-f'], Entrypoint: null, WorkingDir: '/srv', ExposedPorts: { '80/tcp': {} }, Volumes: { '/cache': {} }, Labels: { maintainer: 'x', tier: 'base' } } };

test('命令拆分：空白分隔，引号与转义保留空格；引号不配对为 null', () => {
	assert.deepEqual(splitCommand(`sh -c "echo 'a b'; sleep 1" x\\ y ''`), ['sh', '-c', "echo 'a b'; sleep 1", 'x y', '']);
	assert.deepEqual(splitCommand('  '), []);
	assert.equal(splitCommand('echo "x'), null);
});

test('新建容器：校验各项并指向出错控件', () => {
	const form = { ...emptyCreate(), image: 'busybox:stable' };
	assert.deepEqual(validateCreate(form), []);
	const bad = { ...form, name: 'a', ports: [{ host: '0', container: '80', proto: 'tcp' }], mounts: [{ host: 'da:ta', container: '/d', readonly: false }], env: ['NOVALUE'], command: 'echo "x' };
	assert.deepEqual(validateCreate(bad).map(e => e.field), ['name', 'ports', 'mounts', 'env', 'command']);
	assert.deepEqual(validateCreate({ ...form, name: 'web' }, ['web']).map(e => e.message), ['A container with this name already exists']);
	/* 目录行可填命名卷；匿名卷名（64 位十六进制）不行 */
	assert.deepEqual(validateCreate({ ...form, mounts: [{ host: 'appdata', container: '/d' }] }), []);
	assert.deepEqual(validateCreate({ ...form, mounts: [{ host: 'f'.repeat(64), container: '/d' }] }).map(e => e.field), ['mounts']);
	assert.deepEqual(validateCreate({ ...form, caps: ['net_admin', 'CAP_SYS_TIME'] }), []);
	assert.deepEqual(validateCreate({ ...form, caps: ['NET ADMIN'] }).map(e => e.field), ['caps']);
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
			HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'bridge', PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8081' }] }, Binds: ['/mnt/a:/data:ro'], Privileged: true,
				LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } } },
		},
	});
	const host = buildCreate({ ...emptyCreate(), source: 'pull', pullRef: 'nginx', network: 'host', restart: 'no', log: '', ports: [{ host: '80', container: '80', proto: 'tcp' }] });
	assert.deepEqual(host, { query: {}, body: { Image: 'nginx:latest', HostConfig: { RestartPolicy: { Name: 'no' }, NetworkMode: 'host' } } });
	/* 仅本机监听、命名卷、额外权限 */
	const more = buildCreate({ ...emptyCreate(), image: 'busybox:stable', ports: [{ host: '8080', container: '80', proto: 'tcp', ip: '127.0.0.1' }], mounts: [{ host: 'appdata', container: '/data' }], caps: ['net_admin', 'NET_ADMIN'] }).body.HostConfig;
	assert.deepEqual([more.PortBindings, more.Binds, more.CapAdd], [{ '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] }, ['appdata:/data'], ['NET_ADMIN']]);
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
