/*
 * Docker（插件自带的 rpcd 后端）：sight.docker / sight.docker.container / sight.docker.image / sight.docker.network 移植自 dockerman 的 docker.*，
 * 把 Docker API 的 HTTP 响应包成 { code, headers, body }：code ≥ 300 视为失败，body.message 为原因；守护进程连不上时 code 为 500。
 * sight.docker 是本插件加的：logs 在设备端解开日志的多路复用流后返回纯文本（dockerd 在其它主机时同样可读）；
 * 拉取镜像、重建容器（更新镜像 / 修改配置 / 批量更新）、检查更新与 Compose 项目操作交给设备端后台任务（*_start，同一时间一个，
 * task_status 查询步骤与输出），浏览器关掉也会做完；usage 一次取全部运行中容器的资源采样；terminal_* 管理一次性的 ttyd 终端会话。
 * 启停、删除、新建、重启策略、网络与卷均为即时操作，操作后回读列表；dockerd 的 uci 设置走会话暂存 + 保存即生效。
 */
import { probe, isCidr, isIPv4, isIPv6, isHostname } from '@sight/sdk/lib';
import { recreateBody, formFromInspect, buildEdit } from './recreate.js';

/* 启动项操作走宿主自带的 sight 对象（sight-ui ≥ 0.4.0，包依赖已约束） */
const initAction = (client, name, action) => client.call('sight', 'setInitAction', { name, action });

export const ACTIONS = ['start', 'stop', 'restart'];
export const RESTART_POLICIES = ['unless-stopped', 'always', 'on-failure', 'no'];
/* dockerd 未设置 data_root 时 init 脚本的缺省值 */
export const DEFAULT_DATA_ROOT = '/opt/docker/';
export const LOG_LINES = [200, 1000, 5000];

export class DockerError extends Error {
	constructor(message, code) { super(message); this.code = code; }
}

/** 纯函数：插件响应 → body；失败抛 DockerError */
export function unwrap(r) {
	if (!r || typeof r.code !== 'number') throw new DockerError('Unexpected response from the device', 0);
	if (r.code >= 300) throw new DockerError(r.body?.message || `HTTP ${r.code}`, r.code);
	return r.body;
}

/** 纯函数：端口映射去重（IPv4/IPv6 各一条），只保留发布到主机的 */
export function formatPorts(ports) {
	const seen = new Set();
	const out = [];
	for (const p of ports || []) {
		if (!p.PublicPort) continue;
		const text = `${p.PublicPort}→${p.PrivatePort}/${p.Type}`;
		if (!seen.has(text)) { seen.add(text); out.push(text); }
	}
	return out;
}

export const PROJECT_LABEL = 'com.docker.compose.project';
/** 纯函数：列表的状态文字里的健康检查结果 → 'healthy' | 'unhealthy' | 'starting' | ''（没有健康检查） */
export function healthOf(status) {
	const m = /\((healthy|unhealthy|health: starting)\)/.exec(status || '');
	return m ? (m[1] === 'health: starting' ? 'starting' : m[1]) : '';
}
/** 纯函数：需要提醒的异常：反复重启、健康检查失败 */
export const troubleOf = c => c.state === 'restarting' ? 'restarting' : c.health === 'unhealthy' ? 'unhealthy' : '';
/** 纯函数：列表数据整形；镜像的使用数按容器的 ImageID 统计（list 接口的 Containers 字段常为 -1） */
export function shape(containers, images) {
	const list = (containers || []).map(c => ({
		id: c.Id, name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''), image: c.Image, imageId: c.ImageID, ref: imageRefOf(c.Image),
		state: c.State, status: c.Status, health: healthOf(c.Status), ports: formatPorts(c.Ports), publish: c.Ports || [], created: c.Created, command: c.Command || '',
		project: c.Labels?.[PROJECT_LABEL] || '', service: c.Labels?.['com.docker.compose.service'] || '',
		workingDir: c.Labels?.['com.docker.compose.project.working_dir'] || '',
		networks: Object.keys(c.NetworkSettings?.Networks || {}), volumes: (c.Mounts || []).filter(m => m.Type === 'volume' && m.Name).map(m => m.Name),
	})).sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name));
	const used = {};
	for (const c of list) used[c.imageId] = (used[c.imageId] || 0) + 1;
	const imgs = (images || []).map(i => ({
		id: i.Id, tags: (i.RepoTags || []).filter(tag => tag !== '<none>:<none>'), size: i.Size, created: i.Created, containers: used[i.Id] || 0,
		digests: (i.RepoDigests || []).map(d => d.slice(d.indexOf('@') + 1)).filter(d => d.startsWith('sha256:')),
	})).sort((a, b) => b.created - a.created);
	return { containers: list, images: imgs };
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);
/**
 * 纯函数：容器发布到设备的 TCP 端口 → 打开网页的地址，主机名用浏览器访问路由器时的主机名；
 * 只绑定回环地址的端口从别处打不开，不列。443/8443 用 https。
 */
export function portLinks(publish, hostname) {
	const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
	const seen = new Set(), out = [];
	for (const p of publish || []) {
		if (p.Type !== 'tcp' || !p.PublicPort || LOOPBACK.has(p.IP) || seen.has(p.PublicPort)) continue;
		seen.add(p.PublicPort);
		const https = p.PublicPort === 443 || p.PublicPort === 8443;
		const port = (https && p.PublicPort === 443) || (!https && p.PublicPort === 80) ? '' : `:${p.PublicPort}`;
		out.push({ port: p.PublicPort, url: `${https ? 'https' : 'http'}://${host}${port}/` });
	}
	return out.sort((a, b) => a.port - b.port);
}

/** 纯函数：按 Compose 项目标签归组；不属于项目的为 standalone */
export function groupContainers(containers) {
	const standalone = [], groups = new Map();
	for (const c of containers || []) {
		if (!c.project) { standalone.push(c); continue; }
		if (!groups.has(c.project)) groups.set(c.project, []);
		groups.get(c.project).push(c);
	}
	return { standalone, projects: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({ name, containers: list })) };
}

/**
 * 纯函数：本页保存的项目文件 + 容器标签 → 项目列表。
 * managed：文件在 /etc/sight-docker/compose（可编辑、启停、删除）；否则是别处创建的，只能停止（down）。
 */
export function projectsOf(files, containers) {
	const map = new Map();
	for (const f of files || []) map.set(f.name, { name: f.name, managed: true, modified: f.modified, containers: [], workingDir: '' });
	for (const c of containers || []) {
		if (!c.project) continue;
		if (!map.has(c.project)) map.set(c.project, { name: c.project, managed: false, modified: null, containers: [], workingDir: c.workingDir });
		map.get(c.project).containers.push(c);
	}
	return [...map.values()].map(p => {
		const running = p.containers.filter(c => c.state === 'running').length;
		return { ...p, running, state: !p.containers.length ? 'empty' : running === p.containers.length ? 'running' : running ? 'partial' : 'stopped' };
	}).sort((a, b) => a.name.localeCompare(b.name));
}

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const isProjectName = s => typeof s === 'string' && PROJECT_RE.test(s);
export const COMPOSE_LIMIT = 131072;
/** 纯函数：新建/编辑 Compose 项目校验 → [{ message, field }] */
export function validateProject({ name, content }, existing = [], creating = true) {
	const errors = [];
	if (creating) {
		if (!isProjectName(name)) errors.push({ message: 'Project names use lowercase letters, digits, dashes and underscores, and start with a letter or digit', field: 'name' });
		else if (existing.includes(name)) errors.push({ message: 'A project with this name already exists', field: 'name' });
	}
	if (!String(content || '').trim()) errors.push({ message: 'Paste the contents of compose.yaml', field: 'content' });
	else if (new TextEncoder().encode(content).length > COMPOSE_LIMIT) errors.push({ message: 'The file is larger than 128 KB', field: 'content' });
	else if (!/^\s*services\s*:/m.test(content)) errors.push({ message: 'A Compose file needs a services: section', field: 'content' });
	return errors;
}

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
		anonymous: !!v.Labels?.['com.docker.volume.anonymous'] || /^[a-f0-9]{64}$/.test(v.Name),
		containers: (containers || []).filter(c => c.volumes.includes(v.Name)).map(c => c.name).sort(),
	})).sort((a, b) => (a.anonymous ? 1 : 0) - (b.anonymous ? 1 : 0) || a.name.localeCompare(b.name));
}

/**
 * 纯函数：system/df + 整形后的列表 → 存储空间各项 { size, reclaimable, count }，size 取不到为 null。
 * 镜像的可清理量为没有容器使用的镜像大小之和（共享的层可能重复计入，只作估计）；
 * 容器为可写层大小，可清理的是已停止的容器；卷为没有容器使用的。
 */
export function storageOf(df, images, containers, volumes) {
	const unusedImages = (images || []).filter(i => !i.containers);
	const rw = {};
	for (const c of df?.Containers || []) if (c.SizeRw >= 0) rw[c.Id] = c.SizeRw;
	const stopped = (containers || []).filter(c => c.state !== 'running' && c.state !== 'restarting' && c.state !== 'paused');
	const vols = Array.isArray(volumes) ? volumes : [];
	const unusedVolumes = vols.filter(v => !v.containers.length);
	const sum = list => list.reduce((n, x) => n + (x ?? 0), 0);
	return {
		images: { size: df?.LayersSize ?? null, reclaimable: sum(unusedImages.map(i => i.size)), count: unusedImages.length },
		containers: { size: df?.Containers ? sum(Object.values(rw)) : null, reclaimable: sum(stopped.map(c => rw[c.id])), count: stopped.length, items: stopped },
		volumes: { size: vols.some(v => v.size != null) ? sum(vols.map(v => v.size)) : null, reclaimable: sum(unusedVolumes.map(v => v.size)), count: unusedVolumes.length },
	};
}

/* ---- 日志 ---- */

const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z\s?/;
/**
 * 纯函数：带时间戳的日志文本 → [{ ts, time, text }]。ts 为可比较的定长字符串（纳秒补齐），time 为毫秒；
 * 没有时间戳的行（截断处等）ts 为 ''。末尾的空行去掉。
 */
export function parseLogs(text) {
	const lines = String(text || '').split('\n');
	if (lines.length && lines[lines.length - 1] === '') lines.pop();
	return lines.map(line => {
		const m = TS_RE.exec(line);
		if (!m) return { ts: '', time: null, text: line };
		const frac = (m[2] || '').padEnd(9, '0');
		return { ts: `${m[1]}.${frac}`, time: Date.parse(`${m[1]}Z`) + Math.floor(+frac / 1e6), text: line.slice(m[0].length) };
	});
}

/** 纯函数：最后一条记录 → logs 的 since 参数（UNIX 秒.纳秒）；没有时间戳为 '' */
export function sinceOf(lines) {
	for (let i = (lines || []).length - 1; i >= 0; i--) {
		const ts = lines[i].ts;
		if (ts) return `${Math.floor(Date.parse(`${ts.slice(0, 19)}Z`) / 1000)}.${ts.slice(20)}`;
	}
	return '';
}

/** 纯函数：跟随时追加增量记录：since 会包含时间相同的记录，只追加比已有最后一条更晚的；超出 limit 行时去掉最早的 */
export function appendLogs(lines, more, limit) {
	let last = '';
	for (let i = lines.length - 1; i >= 0 && !last; i--) last = lines[i].ts;
	const fresh = last ? more.filter(l => l.ts > last) : more;
	const all = fresh.length ? [...lines, ...fresh] : lines;
	return all.length > limit ? all.slice(all.length - limit) : all;
}

/** 纯函数：按关键字过滤（不区分大小写）；不显示时间时只匹配正文 */
export function filterLogs(lines, query, withTime, formatTime) {
	const q = String(query || '').trim().toLowerCase();
	return q ? lines.filter(l => (withTime && l.time != null ? `${formatTime(l.time)} ${l.text}` : l.text).toLowerCase().includes(q)) : lines;
}

const ipNum = a => a.split('.').reduce((v, x) => v * 256 + +x, 0);
const ipStr = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');

/**
 * 纯函数：macvlan 网络给容器分配地址的建议范围（32 个地址），避开 DHCP 地址池与路由器自己的地址：
 * 优先取地址池之前最近的一段，否则取之后的一段；找不到为 ''。lan：{ address, prefix }；dhcp：{ start, limit }（相对网段起点）
 */
export function suggestMacvlanRange(lan, dhcp) {
	if (!isIPv4(lan?.address) || !(lan.prefix >= 8 && lan.prefix <= 27)) return '';
	const size = 2 ** (32 - lan.prefix), base = Math.floor(ipNum(lan.address) / size) * size, router = ipNum(lan.address);
	const poolStart = base + (+dhcp?.start || 100), poolEnd = poolStart + (+dhcp?.limit || 150) - 1;
	const ok = b => b > base && b + 31 < base + size - 1 && (b + 31 < poolStart || b > poolEnd) && !(router >= b && router <= b + 31);
	for (let b = Math.floor((poolStart - 32) / 32) * 32; b > base; b -= 32) if (ok(b)) return `${ipStr(b)}/27`;
	for (let b = Math.ceil((poolEnd + 1) / 32) * 32; b + 31 < base + size; b += 32) if (ok(b)) return `${ipStr(b)}/27`;
	return '';
}

/** 纯函数：network.interface dump + dhcp 配置 → LAN 口信息 { device, address, prefix, subnet, range }；LAN 口没起来为 null */
export function lanOf(dump, dhcp) {
	const lan = (dump?.interface || []).find(i => i.interface === 'lan' && i.up);
	const a = lan?.['ipv4-address']?.[0];
	if (!lan || !a) return null;
	const size = 2 ** (32 - a.mask), base = Math.floor(ipNum(a.address) / size) * size;
	const sec = Object.values(dhcp || {}).find(s => s['.type'] === 'dhcp' && s.interface === 'lan');
	const pool = sec && sec.ignore !== '1' ? { start: sec.start, limit: sec.limit } : { start: 0, limit: 0 };
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

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
/* 镜像引用：[仓库主机[:端口]/]路径[:标签 | @sha256:摘要]，与设备端 sight.docker 的校验一致 */
const IMAGE_RE = /^([A-Za-z0-9.-]+(:[0-9]+)?\/)?[a-z0-9]+([._-]+[a-z0-9]+)*(\/[a-z0-9]+([._-]+[a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})?$/;
export const isImageRef = s => typeof s === 'string' && s.length <= 255 && IMAGE_RE.test(s);

/** 纯函数：未写标签的引用补 :latest（与 Docker 拉取时的缺省一致），便于和本地标签比对 */
export function normalizeImage(ref) {
	const s = String(ref || '').trim();
	if (!s || s.includes('@')) return s;
	return s.lastIndexOf(':') > s.lastIndexOf('/') ? s : `${s}:latest`;
}

/** 纯函数：按 shell 习惯拆分命令（空白分隔，支持单双引号与反斜杠转义）；引号不配对时返回 null */
export function splitCommand(text) {
	const out = [];
	let cur = '', has = false, quote = '';
	const s = String(text || '');
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === quote) quote = '';
			else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
			else cur += c;
		} else if (c === '"' || c === "'") { quote = c; has = true; }
		else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; }
		else if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } }
		else { cur += c; has = true; }
	}
	if (quote) return null;
	if (has) out.push(cur);
	return out;
}

const PATH_RE = /^\/[^:]*$/;
/* 命名卷：Docker 的卷名规则；64 位十六进制为匿名卷，不由表单管理 */
export const VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
export const isAnonymousVolume = name => /^[a-f0-9]{64}$/.test(name || '');
const CAP_RE = /^[A-Z][A-Z_]*$/;
/** 纯函数：权限名统一成大写、去掉 CAP_ 前缀 */
export const normalizeCap = s => String(s || '').trim().toUpperCase().replace(/^CAP_/, '');
const ENV_RE = /^[^=\s]+=/;
const port = v => /^\d+$/.test(String(v).trim()) && +v >= 1 && +v <= 65535;
/* 端口/目录行：两栏都空的行视为未填，忽略 */
const filled = row => String(row.host ?? '').trim() !== '' || String(row.container ?? '').trim() !== '';

/* 日志上限：单个文件大小:文件数（json-file 驱动的 max-size / max-file）；total 为大约占用的 MB */
export const LOG_LIMITS = [{ value: '10m:3', total: 30 }, { value: '20m:5', total: 100 }, { value: '50m:4', total: 200 }];
export const DEFAULT_LOG = '10m:3';
/** 纯函数：HostConfig.LogConfig → 表单取值：选项之一、''（json-file 不限制或用守护进程缺省）、'custom'（其它驱动或其它数值，表单不改） */
export function logOf(cfg) {
	const type = cfg?.Type || '', c = cfg?.Config || {};
	if (type && type !== 'json-file') return 'custom';
	if (!c['max-size']) return '';
	const key = `${c['max-size']}:${c['max-file'] || '1'}`;
	return LOG_LIMITS.some(o => o.value === key) ? key : 'custom';
}
/** 纯函数：表单取值 → HostConfig.LogConfig */
export function logConfig(key) {
	const [size, files] = String(key || '').split(':');
	return { Type: 'json-file', Config: size ? { 'max-size': size, 'max-file': files || '1' } : {} };
}

/** 纯函数：Docker 数据目录 → 应用数据的建议存放处（同一块盘上的 appdata，如 /opt/docker → /opt/appdata） */
export function appBaseOf(dataRoot) {
	const dir = String(dataRoot || DEFAULT_DATA_ROOT).replace(/\/+$/, '');
	const parent = dir.slice(0, dir.lastIndexOf('/')) || '';
	return `${parent}/appdata`;
}

/**
 * 纯函数：镜像自带的 EXPOSE 端口与 VOLUME 路径 → 建议的端口行与目录行（表单里已有的跳过）。
 * 设备端口：1024 以下的加 8000（80 → 8080），避开路由器自己的服务；目录放在 <appBase>/<容器名或镜像名><路径>。
 */
export function imageHints(config, form, appBase) {
	const ports = [], mounts = [];
	for (const key of Object.keys(config?.ExposedPorts || {})) {
		const [port, proto = 'tcp'] = key.split('/');
		if (!/^\d+$/.test(port) || !['tcp', 'udp'].includes(proto) || form.ports.some(p => String(p.container).trim() === port && p.proto === proto)) continue;
		ports.push({ host: String(+port < 1024 ? +port + 8000 : +port), container: port, proto, ip: '' });
	}
	const image = createImage(form);
	const slug = form.name.trim() || image.split('/').pop().replace(/[:@].*$/, '') || 'app';
	for (const path of Object.keys(config?.Volumes || {})) {
		if (!path.startsWith('/') || path.includes(':') || form.mounts.some(m => m.container.trim() === path)) continue;
		mounts.push({ host: `${appBase}/${slug}${path}`, container: path, readonly: false });
	}
	return { ports, mounts };
}

/** 新建容器表单的初值 */
export function emptyCreate() {
	return { source: 'local', image: '', pullRef: '', name: '', ports: [], mounts: [], env: [], restart: 'unless-stopped', network: 'bridge', ip: '', command: '', privileged: false,
		hostname: '', memory: '', cpus: '', devices: [], caps: [], log: DEFAULT_LOG, start: true };
}

/** 纯函数：表单选择的镜像引用 */
export const createImage = form => form.source === 'pull' ? normalizeImage(form.pullRef) : form.image;

/* 设备直通：设备路径[:容器内路径]，都在 /dev 下 */
const DEVICE_RE = /^\/dev\/[^\s:]+(:\/dev\/[^\s:]+)?$/;
/** 纯函数：设备直通的一项 → HostConfig.Devices 的一项 */
export function parseDevice(text) {
	const [host, inner] = String(text).trim().split(':');
	return { PathOnHost: host, PathInContainer: inner || host, CgroupPermissions: 'rwm' };
}
/** 纯函数：HostConfig.Devices 的一项 → 表单写法 */
export const deviceText = d => d.PathInContainer && d.PathInContainer !== d.PathOnHost ? `${d.PathOnHost}:${d.PathInContainer}` : d.PathOnHost;
/* 主机名与固定地址只在容器有自己的网络时可设 */
export const ownNetwork = network => !/^(host|none|container:)/.test(network || '');

/** 纯函数：IPv4 地址是否在 IPv4 子网内 */
export function inSubnet(ip, cidr) {
	const [net, len] = String(cidr).split('/');
	if (!isIPv4(ip) || !isIPv4(net) || !(+len >= 0 && +len <= 32)) return false;
	const mask = +len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
	return ((ipNum(ip) & mask) >>> 0) === ((ipNum(net) & mask) >>> 0);
}

/* 内存上限的最小值（MB，Docker 不接受更小的） */
const MIN_MEMORY = 6;
/**
 * 纯函数：校验新建容器表单。
 * subnets：所选自定义网络的 IPv4 子网（固定地址须在其中）；cpus：设备 CPU 核数（CPU 上限不超过它）
 * @returns {{ message: string, field: string }[]} field 为出错控件的 id 后缀
 */
export function validateCreate(form, names = [], { subnets = [], cpus = null } = {}) {
	const errors = [];
	const image = createImage(form);
	if (!image) errors.push({ message: form.source === 'pull' ? 'Enter the image to download, for example nginx:latest' : 'Choose an image', field: 'image' });
	else if (!isImageRef(image)) errors.push({ message: 'Enter a valid image name, for example nginx:latest', field: 'image' });
	const name = form.name.trim();
	if (name && !NAME_RE.test(name)) errors.push({ message: 'Names use letters, digits, dots, dashes and underscores, at least 2 characters', field: 'name' });
	else if (name && names.includes(name)) errors.push({ message: 'A container with this name already exists', field: 'name' });
	if (form.network !== 'host') {
		const ports = form.ports.filter(filled);
		if (ports.some(p => !port(p.host) || !port(p.container))) errors.push({ message: 'Ports must be numbers from 1 to 65535', field: 'ports' });
		else {
			const seen = new Set();
			for (const p of ports) {
				const key = `${+p.host}/${p.proto}`;
				if (seen.has(key)) { errors.push({ message: 'Each device port can only be used once', field: 'ports' }); break; }
				seen.add(key);
			}
		}
	}
	if (form.mounts.filter(filled).some(m => { const h = m.host.trim(); return !(PATH_RE.test(h) || (VOLUME_RE.test(h) && !isAnonymousVolume(h))) || !PATH_RE.test(m.container.trim()); }))
		errors.push({ message: 'Use a folder on the device (starting with /) or a volume name; paths in the container start with /, and neither can contain a colon', field: 'mounts' });
	if (form.env.some(e => !ENV_RE.test(e))) errors.push({ message: 'Environment variables look like NAME=value', field: 'env' });
	const ip = String(form.ip || '').trim();
	if (ip && isCustomNetwork(form.network)) {
		if (!isIPv4(ip)) errors.push({ message: 'Enter a valid IPv4 address', field: 'ip' });
		else if (subnets.length && !subnets.some(s => inSubnet(ip, s))) errors.push({ message: 'The address must be in the network’s subnet %s', args: [subnets.join(', ')], field: 'ip' });
	}
	const hostname = String(form.hostname || '').trim();
	if (hostname && ownNetwork(form.network) && !isHostname(hostname)) errors.push({ message: 'Hostnames use letters, digits and dashes, separated by dots', field: 'hostname' });
	const memory = String(form.memory ?? '').trim();
	if (memory && !(/^\d+$/.test(memory) && +memory >= MIN_MEMORY)) errors.push({ message: 'Enter the memory limit in MB, at least %d', args: [MIN_MEMORY], field: 'memory' });
	const cpu = String(form.cpus ?? '').trim();
	if (cpu && !(/^\d+(\.\d{1,2})?$/.test(cpu) && +cpu > 0 && (!cpus || +cpu <= cpus))) errors.push(cpus ? { message: 'Enter a number of CPU cores from 0.01 to %d', args: [cpus], field: 'cpus' } : { message: 'Enter a number of CPU cores, for example 1.5', field: 'cpus' });
	if ((form.caps || []).some(c => !CAP_RE.test(normalizeCap(c)))) errors.push({ message: 'Permissions are names such as NET_ADMIN', field: 'caps' });
	if ((form.devices || []).some(d => !DEVICE_RE.test(String(d).trim()))) errors.push({ message: 'Devices are paths under /dev, for example /dev/dri or /dev/ttyUSB0:/dev/ttyACM0', field: 'devices' });
	if (splitCommand(form.command) === null) errors.push({ message: 'The command has an unmatched quote', field: 'command' });
	return errors;
}

/* 自定义网络（不是内置的 bridge/host/none，也不共用其他容器的网络）才能指定固定地址 */
export const isCustomNetwork = network => !!network && !BUILTIN_NETWORKS.includes(network) && !network.startsWith('container:');

/* 纯函数：表单的资源限制、设备与权限 → create 参数里的写法（新建与编辑共用）；空值为 0 / [] 即不限制 */
const trimmed = v => String(v ?? '').trim();
export const memoryBytes = v => trimmed(v) ? +trimmed(v) * 1048576 : 0;
export const nanoCpus = v => trimmed(v) ? Math.round(+trimmed(v) * 1e9) : 0;
export const deviceList = list => (list || []).map(trimmed).filter(Boolean);
export const capList = list => [...new Set((list || []).map(normalizeCap).filter(Boolean))];

/** 纯函数：表单（已校验）→ docker.container.create 的参数；空行忽略，host 网络不发布端口 */
export function buildCreate(form) {
	const host = { RestartPolicy: { Name: form.restart }, NetworkMode: form.network || 'bridge' };
	const body = { Image: createImage(form), HostConfig: host };
	if (form.env.length) body.Env = [...form.env];
	const cmd = splitCommand(form.command);
	if (cmd?.length) body.Cmd = cmd;
	const ports = form.network === 'host' ? [] : form.ports.filter(filled);
	if (ports.length) {
		body.ExposedPorts = {};
		host.PortBindings = {};
		for (const p of ports) {
			const key = `${+p.container}/${p.proto}`;
			body.ExposedPorts[key] = {};
			(host.PortBindings[key] ||= []).push({ HostIp: p.ip || '', HostPort: String(+p.host) });
		}
	}
	const mounts = form.mounts.filter(filled);
	if (mounts.length) host.Binds = mounts.map(m => `${m.host.trim()}:${m.container.trim()}${m.readonly ? ':ro' : ''}`);
	if (form.privileged) host.Privileged = true;
	const memory = memoryBytes(form.memory), cpus = nanoCpus(form.cpus), devices = deviceList(form.devices), caps = capList(form.caps);
	if (memory) host.Memory = memory;
	if (cpus) host.NanoCpus = cpus;
	if (devices.length) host.Devices = devices.map(parseDevice);
	if (caps.length) host.CapAdd = caps;
	if (form.log && form.log !== 'custom') host.LogConfig = logConfig(form.log);
	const hostname = trimmed(form.hostname);
	if (hostname && ownNetwork(form.network)) body.Hostname = hostname;
	const ip = String(form.ip || '').trim();
	if (ip && isCustomNetwork(form.network)) body.NetworkingConfig = { EndpointsConfig: { [form.network]: { IPAMConfig: { IPv4Address: ip } } } };
	const name = form.name.trim();
	return { query: name ? { name } : {}, body };
}

/** 纯函数：两次采样之间的 CPU 占用（100% = 一个核跑满，与 docker stats 一致）；无法计算时为 null */
export function cpuPercent(prev, cur) {
	const p = prev?.cpu_stats, c = cur?.cpu_stats;
	const cpu = c?.cpu_usage?.total_usage - p?.cpu_usage?.total_usage;
	const system = c?.system_cpu_usage - p?.system_cpu_usage;
	if (!(system > 0) || !(cpu >= 0)) return null;
	const cpus = c.online_cpus || c.cpu_usage.percpu_usage?.length || 1;
	return cpu / system * cpus * 100;
}

/** 纯函数：内存用量扣除可回收的页缓存（cgroup v1 total_inactive_file / v2 inactive_file，同 docker stats）；取不到时为 null */
export function memoryUsage(sample) {
	const m = sample?.memory_stats;
	if (!m || typeof m.usage !== 'number') return null;
	const cache = m.stats?.total_inactive_file ?? m.stats?.inactive_file ?? 0;
	return { used: cache < m.usage ? m.usage - cache : m.usage, limit: m.limit || null };
}

/** 纯函数：inspect → 详情里用到的配置与运行状况 */
export function detailOf(inspect) {
	const host = inspect?.HostConfig || {}, state = inspect?.State || {};
	const healthLog = state.Health?.Log || [];
	return {
		addresses: Object.entries(inspect?.NetworkSettings?.Networks || {}).map(([network, ep]) => ({ network, ip: ep?.IPAddress || '', ip6: ep?.GlobalIPv6Address || '' })).filter(a => a.ip || a.ip6),
		env: inspect?.Config?.Env || [],
		health: state.Health?.Status || '', healthOutput: String(healthLog[healthLog.length - 1]?.Output || '').trim(),
		restartCount: inspect?.RestartCount || 0, exitCode: state.ExitCode ?? null, oom: !!state.OOMKilled, error: state.Error || '',
		imageRef: inspect?.Config?.Image || '',
		restart: host.RestartPolicy?.Name || 'no',
		network: host.NetworkMode || '',
		mounts: (inspect?.Mounts || []).map(m => ({ type: m.Type, source: m.Type === 'volume' ? m.Name : m.Source, destination: m.Destination, readonly: m.RW === false })),
	};
}

/** 纯函数：容器能否「更新到新版镜像」：须由带标签的镜像引用创建（不是镜像 ID 或摘要） */
export const canUpdate = ref => isImageRef(ref) && !ref.includes('@') && !/^sha256:/.test(ref);

/* 列表接口在容器所用的标签已移到别的镜像时给出镜像 ID（sha256:… 或十六进制） */
const IMAGE_ID_RE = /^(sha256:)?[a-f0-9]{12,64}$/;
/** 纯函数：镜像引用 → 与本机标签一致的写法（补 :latest，去掉 Docker Hub 的 docker.io/ 与 library/ 前缀）；镜像 ID 或摘要返回 '' */
export function imageRefOf(image) {
	const s = normalizeImage(image);
	if (!s || IMAGE_ID_RE.test(String(image).trim()) || !canUpdate(s)) return '';
	return s.replace(/^(docker\.io|index\.docker\.io)\//, '').replace(/^library\/(?=[^/]+$)/, '');
}

/**
 * 纯函数：容器是否有新版镜像 → 'available' | 'latest' | 'unknown' | 'none'。
 * 本机标签已指向别的镜像即有新版（无需联网）；否则用最近一次检查得到的仓库摘要与容器所用镜像的摘要比对。
 * checks：check_list 的结果 { 引用: { digest } | { error } }
 */
export function updateState(c, images, checks) {
	if (!c.ref) return 'none';
	const tagged = (images || []).find(i => i.tags.includes(c.ref));
	if (tagged && tagged.id !== c.imageId) return 'available';
	const digest = checks?.[c.ref]?.digest;
	const mine = (images || []).find(i => i.id === c.imageId);
	if (!digest || !mine?.digests?.length) return 'unknown';
	return mine.digests.includes(digest) ? 'latest' : 'available';
}

/** 纯函数：usage 返回的容器状态与当前列表不一致（有增减或启停）时为 true */
export function statesChanged(states, containers) {
	const ids = Object.keys(states || {});
	return ids.length !== (containers || []).length || (containers || []).some(c => states[c.id] !== c.state);
}

/** 纯函数：容器是否符合搜索（名称、镜像、端口、Compose 项目，不区分大小写） */
export function matchContainer(c, query) {
	const q = String(query || '').trim().toLowerCase();
	return !q || [c.name, c.image, c.ref, c.project, ...c.ports].some(v => String(v || '').toLowerCase().includes(q));
}

/** 纯函数：要检查的镜像引用（去重、排序） */
export const checkRefs = containers => [...new Set((containers || []).map(c => c.ref).filter(Boolean))].sort();

/** 纯函数：最近一次检查的时间（各镜像中最早的）；从未检查为 null */
export function lastChecked(containers, checks) {
	const times = checkRefs(containers).map(r => checks?.[r]?.checked).filter(Boolean);
	return times.length ? Math.min(...times) : null;
}

/* 设备端返回的错误码 → 说明（英文 msgid） */
const ERRORS = {
	busy: 'Another task is running on the device. Try again when it finishes.',
	'invalid image': 'Enter a valid image name, for example nginx:latest',
	invalid: 'The request was not accepted by the device',
	not_found: 'The container or project no longer exists',
	not_running: 'Start the container first',
	not_lan: 'The terminal is only available when Sight is opened through a LAN address of the router',
	no_certificate: 'Sight is opened over HTTPS, but the router’s certificate was not found, so the terminal cannot use HTTPS',
	in_use: 'A terminal for this container is already open. End it first.',
	not_installed: 'A required program is missing on the device. Reinstall sight-app-docker.',
	exists: 'A project with this name already exists',
	timeout: 'Docker Hub could not be reached. Check the internet connection, or type the image name directly.',
	invalid_compose: 'Compose could not read this file. Check the indentation, keys and values.',
};
/** 纯函数：sight.docker 返回体里的 error → Error（英文 msgid） */
export function replyError(r) {
	if (!r?.error) return null;
	const e = new Error(ERRORS[r.error] || r.error);
	e.reason = r.error;
	return e;
}

/* 搜索关键词：字母数字开头，只含字母数字与 . _ - / 空格，与设备端一致 */
const TERM_RE = /^[A-Za-z0-9][A-Za-z0-9._/ -]*$/;
export const isSearchTerm = s => typeof s === 'string' && s.trim().length <= 100 && TERM_RE.test(s.trim());

/** 纯函数：搜索结果排序：官方镜像在前，其余按星数从多到少 */
export function sortResults(results) {
	return [...(results || [])].sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0) || b.stars - a.stars || a.name.localeCompare(b.name));
}

/** 纯函数：拉取进度百分比；层大小未知时为 null */
export function pullPercent(task) {
	return task?.total > 0 ? Math.min(100, Math.floor(task.current / task.total * 100)) : null;
}

/* 国内可用的公共镜像加速（2026-10 实测可拉取 Docker Hub 镜像）；第三方运营，可能随时失效 */
export const MIRROR_PRESETS = [
	{ url: 'https://docker.1ms.run', source: '1ms.run' },
	{ url: 'https://docker.m.daocloud.io', source: 'DaoCloud' },
];

/** 纯函数：dockerd 配置里本页负责的字段 */
export function settingsOf(dockerd) {
	const g = Object.values(dockerd || {}).find(s => s['.type'] === 'globals');
	return { section: g?.['.name'] || 'globals', exists: !!g, mirrors: [].concat(g?.registry_mirrors || []), dataRoot: g?.data_root || '' };
}

const MIRROR_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/\S*)?$/;
const DIR_RE = /^\/[^\s"'\\]+$/;
/* Docker 的 overlay2 需要支持 d_type 的 Linux 文件系统；vfat、exFAT、NTFS 放不了数据 */
const DOCKER_FS = ['ext4', 'xfs', 'btrfs', 'f2fs'];

/**
 * 纯函数：宿主 sight.storage.list → 可放 Docker 数据的盘：已挂载的（usable）、文件系统合适但未挂载的（unmounted，可挂载后使用），
 * 以及文件系统不合适的（unsupported）；系统卷不列。
 */
export function diskChoices(storage) {
	const usable = [], unmounted = [], unsupported = [];
	for (const d of storage?.disks || []) for (const v of d.volumes || []) {
		if (v.system || !v.fstype || v.fstype === 'swap') continue;
		const title = v.label || v.partname || v.name;
		if (!v.mounts?.length) {
			if (DOCKER_FS.includes(v.fstype)) unmounted.push({ device: v.device, name: v.name, title, fstype: v.fstype, size: v.size });
			continue;
		}
		if (!v.usage) continue;
		const item = { mount: v.mounts[0], device: v.device, title, fstype: v.fstype, free: v.usage.avail, size: v.usage.size };
		(DOCKER_FS.includes(v.fstype) ? usable : unsupported).push(item);
	}
	usable.sort((a, b) => b.free - a.free);
	unmounted.sort((a, b) => b.size - a.size);
	return { usable, unmounted, unsupported };
}

/** 纯函数：给未挂载的盘取挂载点 /mnt/<卷标或分区名>（只留安全字符）；与已有挂载点重名时用设备名 */
export function mountTargetFor(disk, used = []) {
	const slug = s => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 32);
	const first = `/mnt/${slug(disk.title) || slug(disk.name) || 'data'}`;
	return used.includes(first) ? `/mnt/${slug(disk.name) || 'data'}` : first;
}

/* 放不了 overlay 存储的文件系统：overlay 不能叠在 overlay 上（OpenWrt 根目录即 overlay），FAT/exFAT/NTFS 不支持所需特性 */
const OVERLAY_UNSUPPORTED = ['overlay', 'aufs', 'vfat', 'msdos', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'squashfs', 'jffs2'];
/**
 * 纯函数：root_status → 数据目录的问题：'shadowed'（运行中被新挂载的盘盖住，需重启）、'unsupported'（文件系统放不了，容器建不起来）、
 * 'temporary'（在内存里，重启路由器后丢失）或 ''
 */
export function rootProblem(s) {
	if (!s?.root) return '';
	if (s.shadowed) return 'shadowed';
	if (/overlay/.test(s.driver || '') && OVERLAY_UNSUPPORTED.includes(s.fstype)) return 'unsupported';
	if (s.fstype === 'tmpfs') return 'temporary';
	return '';
}

/** 纯函数：网络列表的原始数据 → 迁移时新建用的参数；内置网络与 Compose 项目的网络（由 compose 重建）不迁 */
export function migrationNetworks(networks) {
	return (networks || []).filter(n => !BUILTIN_NETWORKS.includes(n.Name) && !n.Labels?.[PROJECT_LABEL]).map(n => ({
		Name: n.Name, Driver: n.Driver || 'bridge', CheckDuplicate: true,
		...(n.Options && Object.keys(n.Options).length ? { Options: n.Options } : {}),
		...(n.IPAM?.Config?.length ? { IPAM: { Driver: n.IPAM.Driver || 'default', Config: n.IPAM.Config.map(c => Object.fromEntries(['Subnet', 'Gateway', 'IPRange'].filter(k => c[k]).map(k => [k, c[k]]))) } } : {}),
		...(n.Internal ? { Internal: true } : {}), ...(n.Labels && Object.keys(n.Labels).length ? { Labels: n.Labels } : {}),
	}));
}

/** 纯函数：目录落在哪块盘上（取最长的挂载点前缀）；不在任何数据盘上返回 null */
export function diskOf(dir, usable) {
	const path = (dir || DEFAULT_DATA_ROOT).replace(/\/+$/, '');
	return usable.filter(d => path === d.mount || path.startsWith(d.mount + '/')).sort((a, b) => b.mount.length - a.mount.length)[0] || null;
}

/** 纯函数：设置校验 → [{ message, field }] */
export function validateSettings(s) {
	const errors = [];
	if (s.mirrors.some(m => !MIRROR_RE.test(m))) errors.push({ message: 'Mirror addresses start with http:// or https://', field: 'mirrors' });
	if (s.dataRoot.trim() && !DIR_RE.test(s.dataRoot.trim())) errors.push({ message: 'The data directory must be a full path such as /opt/docker', field: 'data-root' });
	return errors;
}

/** 纯函数：只写改动过的字段；清空用 delete（uci set 不接受空串与空数组） */
export function settingsPlan(base, next) {
	const values = {}, remove = [];
	const mirrors = next.mirrors.map(m => m.trim()).filter(Boolean);
	if (JSON.stringify(mirrors) !== JSON.stringify(base.mirrors)) {
		if (mirrors.length) values.registry_mirrors = mirrors; else remove.push('registry_mirrors');
	}
	const dir = next.dataRoot.trim();
	if (dir !== base.dataRoot) { if (dir) values.data_root = dir; else remove.push('data_root'); }
	return { values, remove };
}

/** 纯函数：两个目录是否相同（忽略末尾的 /） */
export const sameDir = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

/**
 * 纯函数：已保存的设置中哪些要重启 Docker 才生效（与 docker info 的运行值比较）。
 * dockerd 的 reload（SIGHUP）不换数据目录；镜像加速只在配置里仍有该项时才重读，全部删掉后要重启。
 * @returns {('data-root' | 'mirrors')[]}
 */
export function pendingRestart(settings, running) {
	const out = [];
	if (running?.root && !sameDir(settings.dataRoot || DEFAULT_DATA_ROOT, running.root)) out.push('data-root');
	const norm = list => [...new Set((list || []).map(m => m.replace(/\/+$/, '')))].sort().join(' ');
	if (running?.mirrors && norm(settings.mirrors) !== norm(running.mirrors)) out.push('mirrors');
	return out;
}

export function createDocker(client, uci) {
	const call = async (object, method, params) => unwrap(await client.call(object, method, params));
	/* sight.docker 的方法以 { error } 说明拒绝原因 */
	const sight = async (method, params = {}) => {
		const r = await client.call('sight.docker', method, params);
		const e = replyError(r);
		if (e) throw e;
		return r || {};
	};
	/* 列表接口给出镜像 ID 的容器（所用标签已移到新镜像）：从 inspect 取创建时的镜像引用 */
	const resolveRefs = containers => Promise.all(containers.filter(c => !c.ref && IMAGE_ID_RE.test(c.image)).map(async c => {
		const r = await call('sight.docker.container', 'inspect', { id: c.id, query: {} }).catch(() => null);
		c.ref = imageRefOf(r?.Config?.Image);
	}));
	return {
		/**
		 * @returns {Promise<null | { reachable: false, error: string } | { reachable: true, info, containers, images, disk, storage, checks, networks, volumes, compose }>}
		 * null = 后端对象不存在（插件不完整）；网络、卷、Compose 读取失败时对应字段为 { error }；checks 为最近一次检查更新的结果
		 */
		async load() {
			const version = await probe(client, 'sight.docker', 'version');
			if (!version) return null;
			if (version.code >= 300) return { reachable: false, error: version.body?.message || '' };
			const soft = p => p.catch(e => ({ error: e?.message || String(e) }));
			const [info, containers, images, df, networks, volumes, compose, checks, rootStatus] = await Promise.all([
				call('sight.docker', 'info'),
				call('sight.docker.container', 'list', { query: { all: true } }),
				call('sight.docker.image', 'list', {}),
				call('sight.docker', 'df').catch(() => null),
				soft(call('sight.docker.network', 'list', { query: {} })),
				soft(call('sight.docker.volume', 'list', { query: {} })),
				soft(sight('compose_list')),
				sight('check_list').then(r => r.images || {}).catch(() => ({})),
				sight('root_status').catch(() => null),
			]);
			const shaped = shape(containers, images);
			await resolveRefs(shaped.containers);
			const vols = volumes.error ? volumes : volumesOf(volumes, df, shaped.containers);
			return {
				reachable: true,
				info: { version: info.ServerVersion || version.body?.Version || '', running: info.ContainersRunning ?? 0, total: info.Containers ?? 0, cpus: info.NCPU ?? null, memory: info.MemTotal ?? null, root: info.DockerRootDir || '', mirrors: info.RegistryConfig?.Mirrors || [] },
				disk: df?.LayersSize ?? null,
				storage: storageOf(df, shaped.images, shaped.containers, vols),
				checks, rootStatus,
				...shaped,
				networks: networks.error ? networks : networksOf(networks, shaped.containers),
				volumes: vols,
				compose: compose.error ? compose : { available: compose.available, projects: projectsOf(compose.projects, shaped.containers) },
			};
		},
		async action(id, action) {
			if (!ACTIONS.includes(action)) throw new Error('Unknown action');
			await call('sight.docker.container', action, { id, query: action === 'start' ? {} : { t: 10 } });
		},
		async inspect(id) { return detailOf(await call('sight.docker.container', 'inspect', { id, query: {} })); },
		/** 运行中的容器须 force（Docker 先停再删）；volumes 同时删除匿名卷 */
		async removeContainer(id, { force = false, volumes = false } = {}) {
			await call('sight.docker.container', 'remove', { id, query: { force, v: volumes } });
		},
		async setRestartPolicy(id, policy) {
			if (!RESTART_POLICIES.includes(policy)) throw new Error('Unknown restart policy');
			await call('sight.docker.container', 'update', { id, body: { RestartPolicy: { Name: policy } } });
		},
		/* 一次即时采样（one-shot：rpcd 在进程内同步调用，不让它等 Docker 隔一秒的两次采样）；CPU 占用由页面前后两次采样相减 */
		async stats(id) { return call('sight.docker.container', 'stats', { id, query: { stream: false, 'one-shot': true } }); },
		/** @returns {Promise<{ states: Record<string, string>, samples: Record<string, object> }>} 全部容器的状态与运行中容器的采样（结构同 stats，只含计算所需字段） */
		async usage() { return call('sight.docker', 'usage'); },
		async removeImage(id) { await call('sight.docker.image', 'remove', { id, query: {} }); },
		/** 删除所有没有容器使用的镜像（含有标签的），返回释放的字节数 */
		async pruneImages() {
			const r = await call('sight.docker.image', 'prune', { query: { filters: JSON.stringify({ dangling: ['false'] }) } });
			return { reclaimed: r?.SpaceReclaimed || 0 };
		},
		/** @returns {Promise<string>} 新容器 ID；start 为 true 时随后启动，启动失败抛出的错误带 created（已建好的容器 ID） */
		async create(form) {
			const { query, body } = buildCreate(form);
			const r = await call('sight.docker.container', 'create', { query, body });
			if (form.start) {
				try { await call('sight.docker.container', 'start', { id: r.Id, query: {} }); }
				catch (e) { e.created = r.Id; throw e; }
			}
			return r.Id;
		},
		/** @returns {Promise<{ ok: boolean, text: string }>} Docker 报错时 ok 为 false、text 为原因；since 只取此后的记录 */
		async logs(id, { tail = LOG_LINES[0], since = '' } = {}) {
			try { return { ok: true, text: unwrap(await client.call('sight.docker', 'logs', { id, tail, ...(since ? { since } : {}) }))?.text || '' }; }
			catch (e) { if (e instanceof DockerError) return { ok: false, text: e.message }; throw e; }
		},

		/* ---- 后台任务 ---- */
		async pullStart(ref) {
			const image = normalizeImage(ref);
			if (!isImageRef(image)) throw new Error('Enter a valid image name, for example nginx:latest');
			return (await sight('pull_start', { image })).task;
		},
		/** @returns {Promise<{ task: object | null, output: string }>} */
		async taskStatus() { const r = await sight('task_status'); return { task: r.task || null, output: r.output || '' }; },
		/** 重建用的原配置：容器与其镜像的 inspect（镜像已删时不去除镜像默认值） */
		async recreateBase(id) {
			const c = await call('sight.docker.container', 'inspect', { id, query: {} });
			const image = await call('sight.docker.image', 'inspect', { id: c.Image }).catch(() => null);
			return { inspect: c, base: recreateBody(c, image) };
		},
		/** 编辑：预填表单与重建参数 */
		async editForm(id) {
			const { inspect, base } = await this.recreateBase(id);
			return { base, form: formFromInspect(inspect, base) };
		},
		/** 拉取容器镜像引用的最新版，有新版才用原配置重建 */
		async update(id) {
			const { inspect, base } = await this.recreateBase(id);
			if (!canUpdate(inspect.Config?.Image)) throw new Error('This container was created from an image ID, so there is no newer version to look for');
			return (await sight('recreate_start', { id, mode: 'update', name: '', body: base.body })).task;
		},
		/** 本机镜像的 Config（取 EXPOSE 端口与 VOLUME 路径）；读不到为 null */
		async imageConfig(ref) { return (await call('sight.docker.image', 'inspect', { id: ref }).catch(() => null))?.Config || null; },
		/** 在 Docker Hub 搜索镜像 → [{ name, description, stars, official }]（已排序） */
		async search(term) {
			if (!isSearchTerm(term)) throw new Error('Search with letters, digits, dots, dashes and slashes');
			return sortResults((await sight('search', { term: term.trim() })).results);
		},
		/** 检查这些镜像在仓库里是否有新版（不下载） */
		async checkStart(images) { return (await sight('check_start', { images })).task; },
		/** 批量更新：逐个拉取，有新版才重建 */
		async updateAll(ids) {
			const items = [];
			for (const id of ids) items.push({ id, body: (await this.recreateBase(id)).base.body });
			return (await sight('update_start', { items })).task;
		},
		/** 各容器的日志配置与日志文件大小 → [{ id, name, project, log, size }] */
		async logsUsage() { return (await sight('logs_usage')).containers || []; },
		/** 给这些容器设日志上限：按原配置重建（批量编辑任务） */
		async limitLogs(ids, key = DEFAULT_LOG) {
			const items = [];
			for (const id of ids) {
				const { body } = (await this.recreateBase(id)).base;
				body.HostConfig = { ...body.HostConfig, LogConfig: logConfig(key) };
				items.push({ id, body });
			}
			return (await sight('update_start', { items, mode: 'edit' })).task;
		},
		/** 用编辑后的表单重建（不拉取，镜像不在本机时设备端先下载） */
		async edit(id, base, form) {
			return (await sight('recreate_start', { id, mode: 'edit', name: form.name.trim(), body: buildEdit(base, form) })).task;
		},

		/* ---- 网络与卷 ---- */
		async createNetwork(form) { await call('sight.docker.network', 'create', { body: buildNetwork(form) }); },
		/** LAN 口信息（macvlan 的父接口、子网、网关与建议范围）；读不到为 null */
		async lan() {
			const [dump, dhcp] = await Promise.all([client.call('network.interface', 'dump').catch(() => null), uci.load('dhcp').catch(() => null)]);
			return lanOf(dump, dhcp);
		},
		async removeNetwork(id) { await call('sight.docker.network', 'remove', { id }); },
		async createVolume(name) { await call('sight.docker.volume', 'create', { opts: name ? { Name: name } : {} }); },
		async removeVolume(name) { await call('sight.docker.volume', 'remove', { id: name, query: {} }); },
		/** 删除没有容器使用的卷（含有名字的，all=true），返回删除数与释放的字节数 */
		async pruneVolumes() {
			const r = await call('sight.docker.volume', 'prune', { query: { filters: JSON.stringify({ all: ['true'] }) } });
			return { count: r?.VolumesDeleted?.length || 0, reclaimed: r?.SpaceReclaimed || 0 };
		},

		/* ---- Compose ---- */
		async composeRead(name) { return (await sight('compose_read', { name })).content || ''; },
		async composeWrite(name, content, create) { await sight('compose_write', { name, content, create: !!create }); },
		/** action：up / pull / down / remove；remove 时 volumes 一并删除项目的卷 */
		async composeStart(name, action, volumes = false) { return (await sight('compose_start', { name, action, volumes: !!volumes })).task; },

		/* ---- 终端 ---- */
		/** @returns {Promise<{ session, url }>} url 为一次性地址：主机名同浏览器访问 Sight 时的，https 访问时同样走 https */
		async terminalStart(id, location) {
			const tls = location.protocol === 'https:';
			const r = await sight('terminal_start', { id, host: location.hostname, tls });
			const host = location.hostname.includes(':') && !location.hostname.startsWith('[') ? `[${location.hostname}]` : location.hostname;
			return { session: r.session, url: `${tls ? 'https' : 'http'}://${host}:${r.session.port}${r.session.path}` };
		},
		async terminalStatus(id) { return (await sight('terminal_status', { id })).session || null; },
		async terminalStop(id) { return !!(await sight('terminal_stop', { id })).stopped; },

		async loadSettings() { return settingsOf(await uci.load('dockerd')); },
		/** 路由器时区（如 Asia/Shanghai），新建容器时可一键加为 TZ；读不到为 '' */
		async timezone() {
			const sys = await uci.load('system').catch(() => null);
			return Object.values(sys || {}).find(s => s['.type'] === 'system')?.zonename || '';
		},
		/** 用宿主的存储接口挂载一块盘（开机自动挂载，fstab 按 UUID）；返回挂载点 */
		async mountDisk(disk, used = []) {
			const target = mountTargetFor(disk, used);
			await client.call('sight.storage', 'mount', { device: disk.device, target, auto: true });
			return target;
		},
		/**
		 * 迁移到新数据目录：趁 Docker 仍在旧目录上，整理网络、卷、单独的容器（按重建参数）与本页管理且在运行的 Compose 项目，交给设备端任务。
		 * 由镜像 ID 创建、无法重新下载的容器不迁，返回在 skipped 里
		 */
		async migrate(oldRoot) {
			const [containers, networks, volumes, compose] = await Promise.all([
				call('sight.docker.container', 'list', { query: { all: true } }), call('sight.docker.network', 'list', { query: {} }),
				call('sight.docker.volume', 'list', { query: {} }), sight('compose_list'),
			]);
			const items = [], skipped = [];
			for (const c of shape(containers, []).containers) {
				if (c.project) continue;
				const { body } = (await this.recreateBase(c.id)).base;
				if (!canUpdate(body.Image)) { skipped.push(c.name); continue; }
				items.push({ name: c.name, running: c.state === 'running' || c.state === 'restarting', body });
			}
			const files = new Set((compose.projects || []).map(p => p.name));
			const projects = [...new Set(shape(containers, []).containers.filter(c => c.project && files.has(c.project) && c.state === 'running').map(c => c.project))];
			const plan = { old_root: String(oldRoot).replace(/\/+$/, ''), networks: migrationNetworks(networks),
				volumes: (volumes?.Volumes || []).filter(v => (v.Driver || 'local') === 'local').map(v => ({ name: v.Name, labels: v.Labels || {} })), containers: items, projects };
			return { task: (await sight('migrate_start', plan)).task, skipped };
		},
		/** 宿主的存储信息（sight-ui 0.6.0 起有 sight.storage）；没有时返回 null，页面不显示数据盘建议 */
		async loadDisks() {
			const r = await probe(client, 'sight.storage', 'list').catch(() => null);
			return r ? diskChoices(r) : null;
		},
		/** 写入会话暂存；由页面经 saveFlow 应用 */
		async saveSettings(base, next) {
			const { values, remove } = settingsPlan(base, next);
			if (!base.exists) { if (Object.keys(values).length) await uci.add('dockerd', 'globals', base.section, values); return; }
			if (Object.keys(values).length) await uci.set('dockerd', base.section, values);
			if (remove.length) await uci.remove('dockerd', base.section, remove);
		},
		/** 守护进程未运行时通过启动项启动 dockerd；改数据目录后须重启才生效 */
		async startService() { await initAction(client, 'dockerd', 'start'); },
		/** 重启后等守护进程重新可连（最多约 30 秒），避免页面先显示「未运行」 */
		async restartService() {
			await initAction(client, 'dockerd', 'restart');
			for (let i = 0; i < 30; i++) {
				const r = await probe(client, 'sight.docker', 'version').catch(() => null);
				if (r && r.code < 300) return;
				await new Promise(done => setTimeout(done, 1000));
			}
		},
	};
}
