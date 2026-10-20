import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameDir } from '../src/storage.js';
import { settingsOf, validateSettings, settingsPlan, pendingRestart } from '../src/settings.js';
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

test('设置：运行值与配置不一致时提示重启（数据目录；镜像加速全部删除后 reload 不清除）', () => {
	const running = { root: '/tmp/docker', mirrors: ['https://a.example/'] };
	assert.deepEqual(pendingRestart({ dataRoot: '/tmp/docker/', mirrors: ['https://a.example'] }, running), []);
	assert.deepEqual(pendingRestart({ dataRoot: '/mnt/docker', mirrors: [] }, running), ['data-root', 'mirrors']);
	/* 未设置 data_root 时按 init 脚本缺省 /opt/docker/ 比较 */
	assert.deepEqual(pendingRestart({ dataRoot: '', mirrors: [] }, { root: '/opt/docker', mirrors: [] }), []);
	assert.deepEqual(pendingRestart({ dataRoot: '', mirrors: [] }, { root: '', mirrors: undefined }), []);
});
