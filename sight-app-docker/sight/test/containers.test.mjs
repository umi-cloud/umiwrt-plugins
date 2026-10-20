import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPorts, healthOf, troubleOf, shape, portLinks, cpuPercent, memoryUsage, detailOf, statesChanged } from '../src/containers.js';
import { pullPercent } from '../src/images.js';
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
	const { imageRef, restart, network, mounts } = detailOf({ HostConfig: { RestartPolicy: { Name: '' }, NetworkMode: 'bridge' }, Mounts: [{ Type: 'bind', Source: '/mnt/a', Destination: '/a', RW: false }, { Type: 'volume', Name: 'v1', Source: '/x/_data', Destination: '/b', RW: true }] });
	assert.deepEqual({ imageRef, restart, network, mounts },
		{ imageRef: '', restart: 'no', network: 'bridge', mounts: [{ type: 'bind', source: '/mnt/a', destination: '/a', readonly: true }, { type: 'volume', source: 'v1', destination: '/b', readonly: false }] });
	assert.equal(pullPercent({ current: 50, total: 200 }), 25);
	assert.equal(pullPercent({ current: 0, total: 0 }), null);
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

test('自动回读：容器增减或状态变化才回读', () => {
	const list = [{ id: 'a', state: 'running' }, { id: 'b', state: 'exited' }];
	assert.equal(statesChanged({ a: 'running', b: 'exited' }, list), false);
	assert.equal(statesChanged({ a: 'running', b: 'running' }, list), true);
	assert.equal(statesChanged({ a: 'running' }, list), true);
	assert.equal(statesChanged({ a: 'running', c: 'exited' }, list), true);
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
