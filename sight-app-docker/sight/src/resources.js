/* 网络与卷：列表整形、新建网络（bridge / macvlan）的校验与参数、LAN 口信息，以及容器表单共用的名称与地址规则（纯函数） */
import { isCidr, isIPv4, isIPv6 } from '@sight/sdk/lib';
import { PROJECT_LABEL } from './compose.js';

export const BUILTIN_NETWORKS = ['bridge', 'host', 'none'];

/** 纯函数：网络列表 + 容器 → 展示数据（连接的容器取自容器列表，list 接口不带） */
export function networksOf(networks, containers) {
	return (networks || []).map(n => ({
		id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope, internal: !!n.Internal,
		subnets: (n.IPAM?.Config || []).map(c => c.Subnet).filter(Boolean),
		gateways: (n.IPAM?.Config || []).map(c => c.Gateway).filter(Boolean),
		builtin: BUILTIN_NETWORKS.includes(n.Name), project: n.Labels?.[PROJECT_LABEL] || '',
		containers: (containers || []).filter(c => c.networks.includes(n.Name)).map(c => c.name).sort(),
	})).sort((a, b) => (a.builtin ? 0 : 1) - (b.builtin ? 0 : 1) || a.name.localeCompare(b.name));
}

/** 纯函数：卷列表 + system/df（大小，可能取不到）+ 容器 → 展示数据 */
export function volumesOf(volumes, df, containers) {
	const sizes = {};
	for (const v of df?.Volumes || []) if (v.UsageData?.Size >= 0) sizes[v.Name] = v.UsageData.Size;
	return (volumes?.Volumes || []).map(v => ({
		name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, created: v.CreatedAt ? Math.floor(Date.parse(v.CreatedAt) / 1000) : null,
		size: sizes[v.Name] ?? null, project: v.Labels?.[PROJECT_LABEL] || '',
		anonymous: !!v.Labels?.['com.docker.volume.anonymous'] || isAnonymousVolume(v.Name),
		containers: (containers || []).filter(c => c.volumes.includes(v.Name)).map(c => c.name).sort(),
	})).sort((a, b) => (a.anonymous ? 1 : 0) - (b.anonymous ? 1 : 0) || a.name.localeCompare(b.name));
}

const ipNum = a => a.split('.').reduce((v, x) => v * 256 + +x, 0);

const ipStr = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');

/* 建议范围的大小（/27，32 个地址）与最多尝试的候选段数 */
const RANGE_SIZE = 32, RANGE_TRIES = 256;
/**
 * 纯函数：macvlan 网络给容器分配地址的建议范围（32 个地址），避开 DHCP 地址池与路由器自己的地址：
 * 优先取地址池之前最近的一段，否则取之后的一段；找不到为 ''。
 * lan：{ address, prefix }；dhcp：{ start, limit }（相对网段起点，缺省按 OpenWrt 的 100/150），null 表示没有地址池
 */
export function suggestMacvlanRange(lan, dhcp) {
	if (!isIPv4(lan?.address) || !(lan.prefix >= 8 && lan.prefix <= 27)) return '';
	const size = 2 ** (32 - lan.prefix), base = Math.floor(ipNum(lan.address) / size) * size, router = ipNum(lan.address);
	/* 没有地址池：当作空池放在网段起点，于是从路由器之后最低的一段开始找 */
	const poolStart = dhcp === null ? base : base + (+dhcp?.start || 100), poolEnd = dhcp === null ? base - 1 : poolStart + (+dhcp?.limit || 150) - 1;
	const last = b => b + RANGE_SIZE - 1;
	const ok = b => b > base && last(b) < base + size - 1 && (last(b) < poolStart || b > poolEnd) && !(router >= b && router <= last(b));
	const align = n => Math.floor(n / RANGE_SIZE) * RANGE_SIZE;
	for (let b = align(poolStart - RANGE_SIZE), i = 0; b > base && i < RANGE_TRIES; b -= RANGE_SIZE, i++) if (ok(b)) return `${ipStr(b)}/27`;
	for (let b = align(poolEnd + RANGE_SIZE), i = 0; last(b) < base + size && i < RANGE_TRIES; b += RANGE_SIZE, i++) if (ok(b)) return `${ipStr(b)}/27`;
	return '';
}

/** 纯函数：network.interface dump + dhcp 配置 → LAN 口信息 { device, address, prefix, subnet, range }；LAN 口没起来为 null */
export function lanOf(dump, dhcp) {
	const lan = (dump?.interface || []).find(i => i.interface === 'lan' && i.up);
	const a = lan?.['ipv4-address']?.[0];
	if (!lan || !a) return null;
	const size = 2 ** (32 - a.mask), base = Math.floor(ipNum(a.address) / size) * size;
	const sec = Object.values(dhcp || {}).find(s => s['.type'] === 'dhcp' && s.interface === 'lan');
	const pool = sec && sec.ignore !== '1' ? { start: sec.start, limit: sec.limit } : null;
	return { device: lan.l3_device || lan.device || '', address: a.address, prefix: a.mask, subnet: `${ipStr(base)}/${a.mask}`, range: suggestMacvlanRange({ address: a.address, prefix: a.mask }, pool) };
}

const PARENT_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,14}$/;

/** 纯函数：新建网络校验 → [{ message, field }]；macvlan 必须有父接口、子网与网关，分配范围须在子网内 */
export function validateNetwork(form, names = []) {
	const errors = [];
	const name = form.name.trim(), subnet = form.subnet.trim(), gateway = form.gateway.trim();
	if (!NAME_RE.test(name)) errors.push({ message: 'Names use letters, digits, dots, dashes and underscores, at least 2 characters', field: 'name' });
	else if (names.includes(name)) errors.push({ message: 'A network with this name already exists', field: 'name' });
	if (form.driver === 'macvlan') {
		const parent = String(form.parent || '').trim(), range = String(form.range || '').trim();
		if (!PARENT_RE.test(parent)) errors.push({ message: 'Enter the router interface to attach to, for example br-lan', field: 'parent' });
		if (!subnet || !gateway) errors.push({ message: 'A LAN network needs the LAN subnet and the router address as gateway', field: subnet ? 'gateway' : 'subnet' });
		if (range && !(isCidr(range) && subnet && isCidr(subnet) && inSubnet(range.split('/')[0], subnet) && +range.split('/')[1] >= +subnet.split('/')[1]))
			errors.push({ message: 'The address range must be a part of the subnet, for example 192.168.1.64/27', field: 'range' });
	}
	if (subnet && !(subnet.includes('/') && (isCidr(subnet) || isCidr(subnet, 6)))) errors.push({ message: 'Enter the subnet as an address with a prefix length, for example 172.30.0.0/16', field: 'subnet' });
	if (gateway && !(isIPv4(gateway) || isIPv6(gateway))) errors.push({ message: 'Enter a valid IP address', field: 'gateway' });
	else if (gateway && !subnet) errors.push({ message: 'Set the subnet together with the gateway', field: 'gateway' });
	return errors;
}

/** 纯函数：新建网络表单 → docker.network.create 的 body */
export function buildNetwork(form) {
	const macvlan = form.driver === 'macvlan';
	const body = { Name: form.name.trim(), Driver: macvlan ? 'macvlan' : 'bridge', CheckDuplicate: true };
	const subnet = form.subnet.trim(), gateway = form.gateway.trim(), range = String(form.range || '').trim();
	if (subnet) body.IPAM = { Driver: 'default', Config: [{ Subnet: subnet, ...(gateway ? { Gateway: gateway } : {}), ...(macvlan && range ? { IPRange: range } : {}) }] };
	if (macvlan) body.Options = { parent: String(form.parent).trim() };
	if (form.internal && !macvlan) body.Internal = true;
	return body;
}

export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

/* 命名卷与容器、网络同一套名称规则；64 位十六进制为匿名卷，不由表单管理 */
export const VOLUME_RE = NAME_RE;

export const isAnonymousVolume = name => /^[a-f0-9]{64}$/.test(name || '');

/* 主机名与固定地址只在容器有自己的网络时可设 */
export const ownNetwork = network => !/^(host|none|container:)/.test(network || '');

/** 纯函数：IPv4 地址是否在 IPv4 子网内 */
export function inSubnet(ip, cidr) {
	const [net, len] = String(cidr).split('/');
	if (!isIPv4(ip) || !isIPv4(net) || !(+len >= 0 && +len <= 32)) return false;
	const mask = +len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
	return ((ipNum(ip) & mask) >>> 0) === ((ipNum(net) & mask) >>> 0);
}

/* 自定义网络（不是内置的 bridge/host/none，也不共用其他容器的网络）才能指定固定地址 */
export const isCustomNetwork = network => !!network && !BUILTIN_NETWORKS.includes(network) && !network.startsWith('container:');
