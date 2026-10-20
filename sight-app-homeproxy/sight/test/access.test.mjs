import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessForm, macsForMode, planAccess, deviceRules, planDeviceRules, deviceRows } from '../src/access.js';

const a = { mode: 'listed_only', proxyMacs: ['AA:00:00:00:00:01'], directMacs: ['AA:00:00:00:00:02'], gamingMacs: ['AA:00:00:00:00:03'], globalMacs: ['AA:00:00:00:00:03', 'AA:00:00:00:00:04'] };

test('名单表单与切换名单类型', () => {
	assert.deepEqual(accessForm(a), { mode: 'listed_only', macs: ['AA:00:00:00:00:01'] });
	assert.deepEqual(accessForm({ ...a, mode: 'except_listed' }).macs, ['AA:00:00:00:00:02']);
	assert.deepEqual(macsForMode(a, 'except_listed', ['X']), ['AA:00:00:00:00:02']);
	assert.deepEqual(macsForMode(a, 'disabled', ['X']), ['X']);
});

test('写入计划：名单为空用 delete；全部设备只写模式；未知模式拒绝', () => {
	assert.deepEqual(planAccess('listed_only', ['A']), { values: { lan_proxy_mode: 'listed_only', lan_proxy_mac_addrs: ['A'] }, remove: [] });
	assert.deepEqual(planAccess('except_listed', []), { values: { lan_proxy_mode: 'except_listed' }, remove: ['lan_direct_mac_addrs'] });
	assert.deepEqual(planAccess('disabled', ['A']), { values: { lan_proxy_mode: 'disabled' }, remove: [] });
	assert.throws(() => planAccess('weird', []), /Unknown access mode/);
});

test('按设备规则：全局代理优先；写入只动按 MAC 的两个名单，空名单用 delete', () => {
	assert.deepEqual(deviceRules(a), [{ mac: 'AA:00:00:00:00:03', rule: 'global' }, { mac: 'AA:00:00:00:00:04', rule: 'global' }]);
	assert.deepEqual(deviceRules({ gamingMacs: ['A', 'B'], globalMacs: ['B'] }), [{ mac: 'B', rule: 'global' }, { mac: 'A', rule: 'gaming' }]);
	assert.deepEqual(planDeviceRules([{ mac: 'aa:bb:cc:dd:ee:01', rule: 'gaming' }]), { values: { lan_gaming_mode_mac_addrs: ['AA:BB:CC:DD:EE:01'] }, remove: ['lan_global_proxy_mac_addrs'] });
	assert.deepEqual(planDeviceRules([]), { values: {}, remove: ['lan_gaming_mode_mac_addrs', 'lan_global_proxy_mac_addrs'] });
});

test('设备列表：在线客户端在前，已保存但不在线的 MAC 与草稿里的 MAC 补在后面且不重复', () => {
	const rows = deviceRows([{ mac: 'aa:00:00:00:00:01', name: 'Phone', ip: '10.0.0.2', online: true }, { name: 'no-mac' }], a, ['AA:00:00:00:00:09', 'AA:00:00:00:00:02']);
	assert.deepEqual(rows.map(r => r.mac), ['AA:00:00:00:00:01', 'AA:00:00:00:00:02', 'AA:00:00:00:00:03', 'AA:00:00:00:00:04', 'AA:00:00:00:00:09']);
	assert.deepEqual(rows[0], { mac: 'AA:00:00:00:00:01', name: 'Phone', ip: '10.0.0.2', online: true });
	assert.equal(rows[1].online, false);
});
