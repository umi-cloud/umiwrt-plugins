/*
 * Docker（插件自带的 rpcd 后端）：docker / docker.container / docker.image / docker.network 移植自 dockerman，
 * 把 Docker API 的 HTTP 响应包成 { code, headers, body }：code ≥ 300 视为失败，body.message 为原因；守护进程连不上时 code 为 500。
 * sight.docker 是本插件加的：logs 在设备端解开日志的多路复用流后返回纯文本（dockerd 在其它主机时同样可读）；
 * pull_start / pull_status 把拉取镜像交给设备端后台任务（可能要几分钟，超过 rpcd 调用超时），同一时间一个。
 * 启停、删除、新建、重启策略均为即时操作，操作后回读列表；dockerd 的 uci 设置走会话暂存 + 保存即生效。
 */
import { probe } from '@sight/sdk/lib';

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

/** 纯函数：列表数据整形；镜像的使用数按容器的 ImageID 统计（list 接口的 Containers 字段常为 -1） */
export function shape(containers, images) {
	const list = (containers || []).map(c => ({
		id: c.Id, name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''), image: c.Image, imageId: c.ImageID,
		state: c.State, status: c.Status, ports: formatPorts(c.Ports), created: c.Created, command: c.Command || '',
	})).sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name));
	const used = {};
	for (const c of list) used[c.imageId] = (used[c.imageId] || 0) + 1;
	const imgs = (images || []).map(i => ({
		id: i.Id, tags: (i.RepoTags || []).filter(tag => tag !== '<none>:<none>'), size: i.Size, created: i.Created, containers: used[i.Id] || 0,
	})).sort((a, b) => b.created - a.created);
	return { containers: list, images: imgs };
}

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

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
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
		restart: host.RestartPolicy?.Name || 'no',
		network: host.NetworkMode || '',
		mounts: (inspect?.Mounts || []).map(m => ({ type: m.Type, source: m.Type === 'volume' ? m.Name : m.Source, destination: m.Destination, readonly: m.RW === false })),
	};
}

/** 纯函数：拉取进度百分比；层大小未知时为 null */
export function pullPercent(task) {
	return task?.total > 0 ? Math.min(100, Math.floor(task.current / task.total * 100)) : null;
}

/** 纯函数：dockerd 配置里本页负责的字段 */
export function settingsOf(dockerd) {
	const g = Object.values(dockerd || {}).find(s => s['.type'] === 'globals');
	return { section: g?.['.name'] || 'globals', exists: !!g, mirrors: [].concat(g?.registry_mirrors || []), dataRoot: g?.data_root || '' };
}

const MIRROR_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/\S*)?$/;
const DIR_RE = /^\/[^\s"'\\]+$/;
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
	return {
		/**
		 * @returns {Promise<null | { reachable: false, error: string } | { reachable: true, info, containers, images, disk }>}
		 * null = 后端对象不存在（插件不完整）
		 */
		async load() {
			const version = await probe(client, 'docker', 'version');
			if (!version) return null;
			if (version.code >= 300) return { reachable: false, error: version.body?.message || '' };
			const [info, containers, images, df] = await Promise.all([
				call('docker', 'info'),
				call('docker.container', 'list', { query: { all: true } }),
				call('docker.image', 'list', {}),
				call('docker', 'df').catch(() => null),
			]);
			return {
				reachable: true,
				info: { version: info.ServerVersion || version.body?.Version || '', running: info.ContainersRunning ?? 0, total: info.Containers ?? 0, cpus: info.NCPU ?? null, memory: info.MemTotal ?? null, root: info.DockerRootDir || '', mirrors: info.RegistryConfig?.Mirrors || [] },
				disk: df?.LayersSize ?? null,
				...shape(containers, images),
			};
		},
		async action(id, action) {
			if (!ACTIONS.includes(action)) throw new Error('Unknown action');
			await call('docker.container', action, { id, query: action === 'start' ? {} : { t: 10 } });
		},
		async inspect(id) { return detailOf(await call('docker.container', 'inspect', { id, query: {} })); },
		/** 运行中的容器须 force（Docker 先停再删）；volumes 同时删除匿名卷 */
		async removeContainer(id, { force = false, volumes = false } = {}) {
			await call('docker.container', 'remove', { id, query: { force, v: volumes } });
		},
		async setRestartPolicy(id, policy) {
			if (!RESTART_POLICIES.includes(policy)) throw new Error('Unknown restart policy');
			await call('docker.container', 'update', { id, body: { RestartPolicy: { Name: policy } } });
		},
		/* 一次即时采样（one-shot：rpcd 在进程内同步调用，不让它等 Docker 隔一秒的两次采样）；CPU 占用由页面前后两次采样相减 */
		async stats(id) { return call('docker.container', 'stats', { id, query: { stream: false, 'one-shot': true } }); },
		async removeImage(id) { await call('docker.image', 'remove', { id, query: {} }); },
		/** 删除所有没有容器使用的镜像（含有标签的），返回释放的字节数 */
		async pruneImages() {
			const r = await call('docker.image', 'prune', { query: { filters: JSON.stringify({ dangling: ['false'] }) } });
			return { reclaimed: r?.SpaceReclaimed || 0 };
		},
		/** 用户自建网络（bridge/host/none 为内置，表单单列） */
		async networks() {
			const list = await call('docker.network', 'list', { query: {} });
			return (list || []).map(n => n.Name).filter(n => !['bridge', 'host', 'none'].includes(n)).sort();
		},
		/** @returns {Promise<string>} 新容器 ID；start 为 true 时随后启动，启动失败抛出的错误带 created（已建好的容器 ID） */
		async create(form) {
			const { query, body } = buildCreate(form);
			const r = await call('docker.container', 'create', { query, body });
			if (form.start) {
				try { await call('docker.container', 'start', { id: r.Id, query: {} }); }
				catch (e) { e.created = r.Id; throw e; }
			}
			return r.Id;
		},
		/** @returns {Promise<{ ok: boolean, text: string }>} Docker 报错时 ok 为 false、text 为原因 */
		async logs(id) {
			try { return { ok: true, text: unwrap(await client.call('sight.docker', 'logs', { id, tail: LOG_LINES }))?.text || '' }; }
			catch (e) { if (e instanceof DockerError) return { ok: false, text: e.message }; throw e; }
		},
		async pullStart(ref) {
			const image = normalizeImage(ref);
			if (!isImageRef(image)) throw new Error('Enter a valid image name, for example nginx:latest');
			const r = await client.call('sight.docker', 'pull_start', { image });
			if (r?.error === 'busy') throw new Error('Another image is being downloaded. Try again when it finishes.');
			if (r?.error || !r?.task) throw new Error('Enter a valid image name, for example nginx:latest');
			return r.task;
		},
		async pullStatus() { return (await client.call('sight.docker', 'pull_status', {}))?.task || null; },
		async loadSettings() { return settingsOf(await uci.load('dockerd')); },
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
				const r = await probe(client, 'docker', 'version').catch(() => null);
				if (r && r.code < 300) return;
				await new Promise(done => setTimeout(done, 1000));
			}
		},
	};
}
