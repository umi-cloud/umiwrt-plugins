import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrap, formatPorts, shape, dockerHost, createDocker, DockerError } from '../src/service.js';

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

test('DOCKER_HOST 取 dockerd.globals.hosts 首项；套接字路径补 unix://，未配置为 null', () => {
	assert.equal(dockerHost({ g: { '.type': 'globals', hosts: ['tcp://10.0.0.2:2375'] } }), 'tcp://10.0.0.2:2375');
	assert.equal(dockerHost({ g: { '.type': 'globals', hosts: ['/var/run/docker.sock'] } }), 'unix:///var/run/docker.sock');
	assert.equal(dockerHost({ g: { '.type': 'globals' } }), null);
});

test('日志：命令行与 ACL 一致，只接受容器 ID；远程 Docker 主机不取日志；拒绝未知动作', async () => {
	const calls = [];
	let hosts = ['/var/run/docker.sock'];
	const svc = createDocker({ call: async (o, m, p) => { calls.push([o, m, p]); return m === 'exec' ? { code: 0, stdout: '2026-01-01T00:00:02Z b\n', stderr: '2026-01-01T00:00:01Z a\n' } : { code: 204, body: '' }; } },
		{ load: async () => ({ g: { '.type': 'globals', hosts } }) });
	await assert.rejects(svc.logs('--help'), /Invalid container id/);
	const id = 'f'.repeat(64);
	const r = await svc.logs(id);
	assert.deepEqual(calls[0], ['file', 'exec', { command: '/usr/bin/docker', params: ['logs', '--tail', '200', '--timestamps', id] }]);
	assert.deepEqual(r, { ok: true, text: '2026-01-01T00:00:01Z a\n2026-01-01T00:00:02Z b' });
	hosts = ['tcp://h:2375'];
	assert.deepEqual(await svc.logs(id), { ok: false, text: '', remote: true });
	assert.equal(calls.length, 1);
	await assert.rejects(svc.action(id, 'remove'), /Unknown action/);
	await svc.action(id, 'stop');
	assert.deepEqual(calls.at(-1), ['docker.container', 'stop', { id, query: { t: 10 } }]);
});
