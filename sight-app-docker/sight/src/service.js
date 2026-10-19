/*
 * Docker（插件自带的 rpcd 后端）：sight.docker / sight.docker.container / sight.docker.image / sight.docker.network 移植自 dockerman 的 docker.*，
 * 把 Docker API 的 HTTP 响应包成 { code, headers, body }：code ≥ 300 视为失败，body.message 为原因；守护进程连不上时 code 为 500。
 * sight.docker 是本插件加的：logs 在设备端解开日志的多路复用流后返回纯文本（dockerd 在其它主机时同样可读）；
 * 拉取镜像、重建容器（更新镜像 / 修改配置）与 Compose 项目操作交给设备端后台任务（*_start，同一时间一个，
 * task_status 查询步骤与输出），浏览器关掉也会做完；terminal_* 管理一次性的 ttyd 终端会话。
 * 启停、删除、新建、重启策略、网络与卷均为即时操作，操作后回读列表；dockerd 的 uci 设置走会话暂存 + 保存即生效。
 */
import { probe, isCidr, isIPv4, isIPv6 } from '@sight/sdk/lib';
import { recreateBody, formFromInspect, buildEdit } from './recreate.js';

/* 启动项操作走宿主自带的 sight 对象（sight-ui ≥ 0.4.0，包依赖已约束） */
const initAction = (client, name, action) => client.call('sight', 'setInitAction', { name, action });

export const ACTIONS = ['start', 'stop', 'restart'];
export const RESTART_POLICIES = ['unless-stopped', 'always', 'on-failure', 'no'];
/* dockerd 未设置 data_root 时 init 脚本的缺省值 */
export const DEFAULT_DATA_ROOT = '/opt/docker/';
const LOG_LINES = 200;

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
/** 纯函数：列表数据整形；镜像的使用数按容器的 ImageID 统计（list 接口的 Containers 字段常为 -1） */
export function shape(containers, images) {
	const list = (containers || []).map(c => ({
		id: c.Id, name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''), image: c.Image, imageId: c.ImageID,
		state: c.State, status: c.Status, ports: formatPorts(c.Ports), publish: c.Ports || [], created: c.Created, command: c.Command || '',
		project: c.Labels?.[PROJECT_LABEL] || '', service: c.Labels?.['com.docker.compose.service'] || '',
		workingDir: c.Labels?.['com.docker.compose.project.working_dir'] || '',
		networks: Object.keys(c.NetworkSettings?.Networks || {}), volumes: (c.Mounts || []).filter(m => m.Type === 'volume' && m.Name).map(m => m.Name),
	})).sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name));
	const used = {};
	for (const c of list) used[c.imageId] = (used[c.imageId] || 0) + 1;
	const imgs = (images || []).map(i => ({
		id: i.Id, tags: (i.RepoTags || []).filter(tag => tag !== '<none>:<none>'), size: i.Size, created: i.Created, containers: used[i.Id] || 0,
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

/** 纯函数：新建网络校验 → [{ message, field }] */
export function validateNetwork(form, names = []) {
	const errors = [];
	const name = form.name.trim(), subnet = form.subnet.trim(), gateway = form.gateway.trim();
	if (!NAME_RE.test(name)) errors.push({ message: 'Names use letters, digits, dots, dashes and underscores, at least 2 characters', field: 'name' });
	else if (names.includes(name)) errors.push({ message: 'A network with this name already exists', field: 'name' });
	if (subnet && !(subnet.includes('/') && (isCidr(subnet) || isCidr(subnet, 6)))) errors.push({ message: 'Enter the subnet as an address with a prefix length, for example 172.30.0.0/16', field: 'subnet' });
	if (gateway && !(isIPv4(gateway) || isIPv6(gateway))) errors.push({ message: 'Enter a valid IP address', field: 'gateway' });
	else if (gateway && !subnet) errors.push({ message: 'Set the subnet together with the gateway', field: 'gateway' });
	return errors;
}

/** 纯函数：新建网络表单 → docker.network.create 的 body */
export function buildNetwork(form) {
	const body = { Name: form.name.trim(), Driver: 'bridge', CheckDuplicate: true };
	const subnet = form.subnet.trim(), gateway = form.gateway.trim();
	if (subnet) body.IPAM = { Driver: 'default', Config: [{ Subnet: subnet, ...(gateway ? { Gateway: gateway } : {}) }] };
	if (form.internal) body.Internal = true;
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
const ENV_RE = /^[^=\s]+=/;
const port = v => /^\d+$/.test(String(v).trim()) && +v >= 1 && +v <= 65535;
/* 端口/目录行：两栏都空的行视为未填，忽略 */
const filled = row => String(row.host ?? '').trim() !== '' || String(row.container ?? '').trim() !== '';

/** 新建容器表单的初值 */
export function emptyCreate() {
	return { source: 'local', image: '', pullRef: '', name: '', ports: [], mounts: [], env: [], restart: 'unless-stopped', network: 'bridge', command: '', privileged: false, start: true };
}

/** 纯函数：表单选择的镜像引用 */
export const createImage = form => form.source === 'pull' ? normalizeImage(form.pullRef) : form.image;

/**
 * 纯函数：校验新建容器表单。
 * @returns {{ message: string, field: string }[]} field 为出错控件的 id 后缀
 */
export function validateCreate(form, names = []) {
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
	if (form.mounts.filter(filled).some(m => !PATH_RE.test(m.host.trim()) || !PATH_RE.test(m.container.trim())))
		errors.push({ message: 'Folder paths must start with / and cannot contain a colon', field: 'mounts' });
	if (form.env.some(e => !ENV_RE.test(e))) errors.push({ message: 'Environment variables look like NAME=value', field: 'env' });
	if (splitCommand(form.command) === null) errors.push({ message: 'The command has an unmatched quote', field: 'command' });
	return errors;
}

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
			(host.PortBindings[key] ||= []).push({ HostPort: String(+p.host) });
		}
	}
	const mounts = form.mounts.filter(filled);
	if (mounts.length) host.Binds = mounts.map(m => `${m.host.trim()}:${m.container.trim()}${m.readonly ? ':ro' : ''}`);
	if (form.privileged) host.Privileged = true;
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

/** 纯函数：inspect → 详情里用到的配置 */
export function detailOf(inspect) {
	const host = inspect?.HostConfig || {};
	return {
		imageRef: inspect?.Config?.Image || '',
		restart: host.RestartPolicy?.Name || 'no',
		network: host.NetworkMode || '',
		mounts: (inspect?.Mounts || []).map(m => ({ type: m.Type, source: m.Type === 'volume' ? m.Name : m.Source, destination: m.Destination, readonly: m.RW === false })),
	};
}

/** 纯函数：容器能否「更新到新版镜像」：须由带标签的镜像引用创建（不是镜像 ID 或摘要） */
export const canUpdate = ref => isImageRef(ref) && !ref.includes('@') && !/^sha256:/.test(ref);

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
	invalid_compose: 'Compose could not read this file. Check the indentation, keys and values.',
};
/** 纯函数：sight.docker 返回体里的 error → Error（英文 msgid） */
export function replyError(r) {
	if (!r?.error) return null;
	const e = new Error(ERRORS[r.error] || r.error);
	e.reason = r.error;
	return e;
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

/** 纯函数：宿主 sight.storage.list → 可放 Docker 数据的盘（已挂载、非系统卷）与放不了的盘 */
export function diskChoices(storage) {
	const usable = [], unsupported = [];
	for (const d of storage?.disks || []) for (const v of d.volumes || []) {
		if (v.system || !v.mounts?.length || !v.usage) continue;
		const item = { mount: v.mounts[0], title: v.label || v.partname || v.name, fstype: v.fstype, free: v.usage.avail, size: v.usage.size };
		(DOCKER_FS.includes(v.fstype) ? usable : unsupported).push(item);
	}
	usable.sort((a, b) => b.free - a.free);
	return { usable, unsupported };
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
	return {
		/**
		 * @returns {Promise<null | { reachable: false, error: string } | { reachable: true, info, containers, images, disk, networks, volumes, compose }>}
		 * null = 后端对象不存在（插件不完整）；网络、卷、Compose 读取失败时对应字段为 { error }
		 */
		async load() {
			const version = await probe(client, 'sight.docker', 'version');
			if (!version) return null;
			if (version.code >= 300) return { reachable: false, error: version.body?.message || '' };
			const soft = p => p.catch(e => ({ error: e?.message || String(e) }));
			const [info, containers, images, df, networks, volumes, compose] = await Promise.all([
				call('sight.docker', 'info'),
				call('sight.docker.container', 'list', { query: { all: true } }),
				call('sight.docker.image', 'list', {}),
				call('sight.docker', 'df').catch(() => null),
				soft(call('sight.docker.network', 'list', { query: {} })),
				soft(call('sight.docker.volume', 'list', { query: {} })),
				soft(sight('compose_list')),
			]);
			const shaped = shape(containers, images);
			return {
				reachable: true,
				info: { version: info.ServerVersion || version.body?.Version || '', running: info.ContainersRunning ?? 0, total: info.Containers ?? 0, cpus: info.NCPU ?? null, memory: info.MemTotal ?? null, root: info.DockerRootDir || '', mirrors: info.RegistryConfig?.Mirrors || [] },
				disk: df?.LayersSize ?? null,
				...shaped,
				networks: networks.error ? networks : networksOf(networks, shaped.containers),
				volumes: volumes.error ? volumes : volumesOf(volumes, df, shaped.containers),
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
		/** @returns {Promise<{ ok: boolean, text: string }>} Docker 报错时 ok 为 false、text 为原因 */
		async logs(id) {
			try { return { ok: true, text: unwrap(await client.call('sight.docker', 'logs', { id, tail: LOG_LINES }))?.text || '' }; }
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
		/** 用编辑后的表单重建（不拉取，镜像不在本机时设备端先下载） */
		async edit(id, base, form) {
			return (await sight('recreate_start', { id, mode: 'edit', name: form.name.trim(), body: buildEdit(base, form) })).task;
		},

		/* ---- 网络与卷 ---- */
		async createNetwork(form) { await call('sight.docker.network', 'create', { body: buildNetwork(form) }); },
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
