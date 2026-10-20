import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocker } from '../src/service.js';
import { shape } from '../src/containers.js';
import { isImageRef, normalizeImage, imageRefOf, updateState, checkRefs, lastChecked, isSearchTerm, sortResults } from '../src/images.js';
const A = 'a'.repeat(64), B = 'b'.repeat(64);

const D1 = 'sha256:' + '1'.repeat(64), D2 = 'sha256:' + '2'.repeat(64);

const ID = 'abcdef0123456789'.repeat(4);

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

test('搜索 Docker Hub：关键词校验、官方在前按星数排序；连不上时给出可操作的说明', async () => {
	for (const ok of ['nginx', 'linuxserver/qbittorrent', 'home assistant', 'a.b_c-d']) assert.ok(isSearchTerm(ok), ok);
	for (const bad of ['', ' ', '-x', 'a;id', '$(id)', 'x'.repeat(101)]) assert.ok(!isSearchTerm(bad), bad);
	assert.deepEqual(sortResults([{ name: 'b', stars: 5 }, { name: 'z', stars: 1, official: true }, { name: 'a', stars: 5 }, { name: 'c', stars: 50 }]).map(r => r.name), ['z', 'c', 'a', 'b']);
	const calls = [];
	let reply = { results: [{ name: 'x/nginx', stars: 1, official: false }, { name: 'nginx', stars: 9, official: true }] };
	const svc = createDocker({ call: async (o, m, p) => { calls.push([o, m, p]); return reply; } }, {});
	assert.deepEqual((await svc.search(' nginx ')).map(r => r.name), ['nginx', 'x/nginx']);
	assert.deepEqual(calls.at(-1), ['sight.docker', 'search', { term: 'nginx' }]);
	await assert.rejects(svc.search('a;id'), /letters, digits/);
	reply = { error: 'timeout' };
	await assert.rejects(svc.search('nginx'), e => e.reason === 'timeout' && /could not be reached/.test(e.message));
});
