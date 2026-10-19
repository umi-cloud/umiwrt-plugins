import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recreateBody, formFromInspect, buildEdit, joinCommand, parseBind } from '../src/recreate.js';
import { splitCommand, emptyCreate, validateCreate } from '../src/service.js';

const ID = 'abcdef0123456789'.repeat(4);
const VOL = 'f'.repeat(64);
/* 镜像：ENV PATH、CMD、EXPOSE 80、VOLUME /cache、标签 maintainer */
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

test('重建参数：保留全部原配置，去掉与旧镜像相同的默认值', () => {
	const { name, body } = recreateBody(inspect(), image);
	assert.equal(name, 'web');
	assert.equal(body.Image, 'nginx:latest');
	assert.deepEqual(body.Env, ['TZ=Asia/Shanghai']);
	assert.ok(!('Cmd' in body) && !('Entrypoint' in body) && !('WorkingDir' in body), '与镜像相同的 Cmd/Entrypoint/WorkingDir 交给新镜像');
	assert.deepEqual(body.Labels, { tier: 'web', 'com.example.keep': 'yes' }, '与镜像值不同的标签保留');
	assert.deepEqual(body.ExposedPorts, { '9000/tcp': {} });
	assert.deepEqual(body.Volumes, {});
	assert.equal(body.StopSignal, 'SIGQUIT');
	assert.ok(!('Hostname' in body) && !('AttachStdout' in body), '缺省主机名与运行期字段不带回去');
	assert.equal(body.Tty, false);
	/* HostConfig 原样保留（非表单字段：能力、内存、设备） */
	assert.deepEqual(body.HostConfig.CapAdd, ['NET_ADMIN']);
	assert.equal(body.HostConfig.Memory, 268435456);
	assert.equal(body.HostConfig.Devices.length, 1);
	assert.deepEqual(body.HostConfig.RestartPolicy, { Name: 'on-failure', MaximumRetryCount: 3 });
	assert.deepEqual(body.HostConfig.Links, ['db:database']);
	/* 匿名卷按卷名接上，已写明来源的不重复 */
	assert.deepEqual(body.HostConfig.Binds, ['/mnt/data:/data:ro,rslave', 'named:/named', `${VOL}:/cache`]);
	/* 网络端点：静态地址与自定义别名保留，自动加的短 ID 别名去掉 */
	assert.deepEqual(body.NetworkingConfig, { EndpointsConfig: { appnet: { IPAMConfig: { IPv4Address: '172.30.0.5' }, Aliases: ['web-alias'] }, backend: {} } });
	/* 不修改输入 */
	assert.equal(inspect().HostConfig.Binds.length, 2);
});

test('重建参数：自定义主机名保留；host 网络不带主机名与端点；改了入口点时 Cmd 原样保留；--mount 写法的匿名卷补上 Source', () => {
	const c = inspect();
	c.Config.Hostname = 'myhost';
	c.Config.Entrypoint = ['/entry.sh'];
	assert.equal(recreateBody(c, image).body.Hostname, 'myhost');
	assert.deepEqual(recreateBody(c, image).body.Cmd, ['httpd', '-f']);
	assert.deepEqual(recreateBody(c, image).body.Entrypoint, ['/entry.sh']);
	c.HostConfig.NetworkMode = 'host';
	const host = recreateBody(c, image).body;
	assert.ok(!('Hostname' in host));
	assert.deepEqual(host.NetworkingConfig, { EndpointsConfig: {} });
	const m = inspect();
	m.HostConfig.Binds = null;
	m.HostConfig.Mounts = [{ Type: 'volume', Target: '/cache' }, { Type: 'bind', Source: '/mnt/data', Target: '/data', ReadOnly: true }];
	m.Mounts = m.Mounts.filter(x => x.Destination !== '/named');
	const r = recreateBody(m, image).body.HostConfig;
	assert.deepEqual(r.Mounts[0], { Type: 'volume', Target: '/cache', Source: VOL });
	assert.equal(r.Binds, null);
	/* 没有镜像信息时全部保留 */
	assert.deepEqual(recreateBody(inspect(), null).body.Env, ['PATH=/usr/bin', 'APP_VERSION=1', 'TZ=Asia/Shanghai']);
});

test('命令拼接：与 splitCommand 互逆', () => {
	for (const args of [['sh', '-c', 'echo "a b"; sleep 1'], ['x y', '', 'a\\b'], ['httpd', '-f', '-p', '80']])
		assert.deepEqual(splitCommand(joinCommand(args)), args, JSON.stringify(args));
	assert.equal(joinCommand(['httpd', '-f']), 'httpd -f');
	assert.deepEqual(parseBind('/a:/b:ro,z'), { source: '/a', target: '/b', options: ['ro', 'z'] });
});

test('编辑：表单预填只含表单负责的部分，原样保存时参数不变', () => {
	const c = inspect(), base = recreateBody(c, image);
	const form = formFromInspect(c, base);
	assert.equal(form.name, 'web');
	assert.equal(form.image, 'nginx:latest');
	assert.deepEqual(form.ports, [{ host: '8080', container: '80', proto: 'tcp', ip: '' }, { host: '8081', container: '80', proto: 'tcp', ip: '127.0.0.1' }]);
	assert.deepEqual(form.mounts, [{ host: '/mnt/data', container: '/data', readonly: true, options: ['rslave'] }, { host: 'named', container: '/named', readonly: false, options: [] }]);
	assert.deepEqual(form.env, ['TZ=Asia/Shanghai']);
	assert.equal(form.restart, 'on-failure');
	assert.equal(form.network, 'appnet');
	assert.equal(form.command, '');
	assert.deepEqual(validateCreate(form, ['other']), []);
	const body = buildEdit(base, form);
	assert.deepEqual(body.HostConfig.PortBindings, {
		'9000/tcp': [{ HostIp: '', HostPort: '' }], '80/tcp': [{ HostIp: '', HostPort: '8080' }, { HostIp: '127.0.0.1', HostPort: '8081' }],
	});
	assert.deepEqual(body.HostConfig.Binds.sort(), [...base.body.HostConfig.Binds].sort());
	assert.deepEqual(body.HostConfig.RestartPolicy, { Name: 'on-failure', MaximumRetryCount: 3 });
	assert.deepEqual(body.NetworkingConfig, base.body.NetworkingConfig);
	assert.deepEqual(body.Labels, base.body.Labels);
	assert.ok(!('Cmd' in body));
});

test('编辑：改端口、目录、环境变量、命令、网络与重启策略，其余保留', () => {
	const c = inspect(), base = recreateBody(c, image);
	const form = formFromInspect(c, base);
	form.ports = [{ host: '9090', container: '8080', proto: 'tcp' }];
	form.mounts = [form.mounts.find(m => m.host === 'named'), { host: '/mnt/new', container: '/cache', readonly: false }];
	form.env = ['TZ=UTC'];
	form.command = 'httpd -f -p 8080';
	form.network = 'bridge';
	form.restart = 'always';
	form.privileged = true;
	form.image = 'nginx:1.27';
	const body = buildEdit(base, form);
	assert.equal(body.Image, 'nginx:1.27');
	assert.deepEqual(body.Env, ['TZ=UTC']);
	assert.deepEqual(body.Cmd, ['httpd', '-f', '-p', '8080']);
	assert.deepEqual(body.HostConfig.PortBindings, { '9000/tcp': [{ HostIp: '', HostPort: '' }], '8080/tcp': [{ HostIp: '', HostPort: '9090' }] });
	assert.deepEqual(body.ExposedPorts, { '9000/tcp': {}, '8080/tcp': {} }, '去掉不再映射的 80，补上新映射的端口');
	/* 表单管理设备目录与命名卷；新目录占了匿名卷的挂载点：匿名卷让位 */
	assert.deepEqual(body.HostConfig.Binds, ['named:/named', '/mnt/new:/cache']);
	assert.deepEqual(body.HostConfig.RestartPolicy, { Name: 'always', MaximumRetryCount: 0 });
	assert.equal(body.HostConfig.Privileged, true);
	assert.equal(body.HostConfig.NetworkMode, 'bridge');
	assert.deepEqual(body.NetworkingConfig, { EndpointsConfig: { backend: {}, bridge: {} } });
	assert.deepEqual(body.HostConfig.CapAdd, ['NET_ADMIN']);
	/* 改成 host 网络：不发布端口、不带端点 */
	const hostBody = buildEdit(base, { ...form, network: 'host' });
	assert.deepEqual(hostBody.HostConfig.PortBindings, {});
	assert.deepEqual(hostBody.NetworkingConfig, { EndpointsConfig: {} });
	/* 清空命令回到镜像默认 */
	assert.ok(!('Cmd' in buildEdit(base, { ...form, command: '' })));
	assert.deepEqual(emptyCreate().ports, []);
});
