import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape } from '../src/containers.js';
import { networksOf, volumesOf, suggestMacvlanRange, lanOf, validateNetwork, buildNetwork } from '../src/resources.js';
const container = (name, extra = {}) => ({ Id: name.padEnd(64, '0'), Names: ['/' + name], Image: 'busybox', ImageID: 'i', State: 'running', Status: 'Up', Ports: [], Labels: {}, NetworkSettings: { Networks: { bridge: {} } }, Mounts: [], ...extra });

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

test('macvlan：按 LAN 口与 DHCP 地址池建议分配范围，校验必填项并生成网络参数', () => {
	assert.equal(suggestMacvlanRange({ address: '192.168.1.1', prefix: 24 }, { start: 100, limit: 150 }), '192.168.1.64/27');
	assert.equal(suggestMacvlanRange({ address: '192.168.1.1', prefix: 24 }, { start: 10, limit: 100 }), '192.168.1.128/27');
	assert.equal(suggestMacvlanRange({ address: '192.168.1.70', prefix: 24 }, { start: 100, limit: 150 }), '192.168.1.32/27', '避开路由器自己的地址');
	assert.equal(suggestMacvlanRange({ address: '192.168.1.1', prefix: 24 }, { start: 2, limit: 253 }), '');
	assert.equal(suggestMacvlanRange({ address: '10.0.0.1', prefix: 28 }, {}), '');
	/* 没有 DHCP 地址池（dhcp 为 null）：取网段里路由器之后的第一段 */
	assert.equal(suggestMacvlanRange({ address: '192.168.1.1', prefix: 24 }, null), '192.168.1.32/27');
	assert.equal(lanOf({ interface: [{ interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }] }] }, { cfg01: { '.type': 'dhcp', interface: 'lan', ignore: '1' } }).range, '192.168.1.32/27');
	const lan = lanOf({ interface: [{ interface: 'wan', up: true }, { interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [{ address: '10.0.0.1', mask: 24 }] }] },
		{ cfg01: { '.type': 'dhcp', interface: 'lan', start: '100', limit: '150' } });
	assert.deepEqual(lan, { device: 'br-lan', address: '10.0.0.1', prefix: 24, subnet: '10.0.0.0/24', range: '10.0.0.64/27' });
	assert.equal(lanOf({ interface: [{ interface: 'lan', up: false }] }, {}), null);
	const form = { name: 'lan', driver: 'macvlan', parent: 'br-lan', subnet: '10.0.0.0/24', gateway: '10.0.0.1', range: '10.0.0.64/27', internal: true };
	assert.deepEqual(validateNetwork(form), []);
	assert.deepEqual(validateNetwork({ ...form, parent: 'br lan', range: '10.1.0.0/27' }).map(e => e.field), ['parent', 'range']);
	assert.deepEqual(validateNetwork({ ...form, gateway: '' }).map(e => e.field), ['gateway']);
	assert.deepEqual(buildNetwork(form), { Name: 'lan', Driver: 'macvlan', CheckDuplicate: true, Options: { parent: 'br-lan' },
		IPAM: { Driver: 'default', Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.1', IPRange: '10.0.0.64/27' }] } });
});
