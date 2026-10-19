import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diskChoices, diskOf } from '../src/service.js';

const storage = { disks: [
	{ name: 'mmcblk0', volumes: [
		{ name: 'mmcblk0p5', partname: 'production', fstype: 'squashfs', system: true, mounts: ['/rom'], usage: { avail: 0, size: 1 } },
		{ name: 'mmcblk0p6', label: 'data', fstype: 'ext4', system: false, mounts: ['/mnt/data'], usage: { avail: 30e9, size: 56e9 } },
	] },
	{ name: 'sda', volumes: [
		{ name: 'sda1', label: 'USB', fstype: 'vfat', system: false, mounts: ['/mnt/sda1'], usage: { avail: 8e9, size: 16e9 } },
		{ name: 'sda2', fstype: 'ext4', system: false, mounts: [], usage: null },
	] },
] };

test('数据盘：只取已挂载的非系统卷，按文件系统分出可用与不可用，可用的按剩余空间排序', () => {
	const r = diskChoices(storage);
	assert.deepEqual(r.usable.map(d => [d.mount, d.title, d.fstype]), [['/mnt/data', 'data', 'ext4']]);
	assert.deepEqual(r.unsupported.map(d => [d.mount, d.fstype]), [['/mnt/sda1', 'vfat']]);
	assert.deepEqual(diskChoices(null), { usable: [], unmounted: [], unsupported: [] });
});

test('数据目录落在哪块盘：取最长挂载点前缀；默认目录在内部存储上', () => {
	const usable = [{ mount: '/mnt' }, { mount: '/mnt/data' }];
	assert.equal(diskOf('/mnt/data/docker', usable).mount, '/mnt/data');
	assert.equal(diskOf('/mnt/data', usable).mount, '/mnt/data');
	assert.equal(diskOf('/mnt/database', usable).mount, '/mnt');
	assert.equal(diskOf('', usable), null);
	assert.equal(diskOf('/opt/docker/', usable), null);
});
