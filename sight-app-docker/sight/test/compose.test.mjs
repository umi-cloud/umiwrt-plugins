import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, groupContainers } from '../src/containers.js';
import { projectsOf, isProjectName, validateProject } from '../src/compose.js';
const container = (name, extra = {}) => ({ Id: name.padEnd(64, '0'), Names: ['/' + name], Image: 'busybox', ImageID: 'i', State: 'running', Status: 'Up', Ports: [], Labels: {}, NetworkSettings: { Networks: { bridge: {} } }, Mounts: [], ...extra });

const image = { Config: { Env: ['PATH=/usr/bin', 'APP_VERSION=1'], Cmd: ['httpd', '-f'], Entrypoint: null, WorkingDir: '/srv', ExposedPorts: { '80/tcp': {} }, Volumes: { '/cache': {} }, Labels: { maintainer: 'x', tier: 'base' } } };

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
