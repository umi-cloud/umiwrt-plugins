/*
 * Docker（插件自带的 rpcd 后端）：sight.docker / sight.docker.container / sight.docker.image / sight.docker.network 移植自 dockerman 的 docker.*，
 * 把 Docker API 的 HTTP 响应包成 { code, headers, body }：code ≥ 300 视为失败，body.message 为原因；守护进程连不上时 code 为 500。
 * sight.docker 是本插件加的：logs 在设备端解开日志的多路复用流后返回纯文本（dockerd 在其它主机时同样可读）；
 * 拉取镜像、重建容器（更新镜像 / 修改配置 / 批量更新）、检查更新与 Compose 项目操作交给设备端后台任务（*_start，同一时间一个，
 * task_status 查询步骤与输出），浏览器关掉也会做完；usage 一次取全部运行中容器的资源采样；terminal_* 管理一次性的 ttyd 终端会话。
 * 启停、删除、新建、重启策略、网络与卷均为即时操作，操作后回读列表；dockerd 的 uci 设置走会话暂存 + 保存即生效。
 * 本文件只有客户端（createDocker）与错误转换；各领域的纯函数按页面拆在 containers / create / images / logs / resources /
 * compose / storage / settings，编辑重建在 recreate.js，docker run 命令导入在 dockerRun.js。
 */
import { probe } from '@sight/sdk/lib';
import { recreateBody, formFromInspect, buildEdit } from './recreate.js';
import { projectsOf } from './compose.js';
import { ACTIONS, RESTART_POLICIES, shape, detailOf } from './containers.js';
import { DEFAULT_LOG, logConfig, buildCreate } from './create.js';
import { isImageRef, normalizeImage, canUpdate, IMAGE_ID_RE, imageRefOf, isSearchTerm, sortResults } from './images.js';
import { LOG_LINES } from './logs.js';
import { networksOf, volumesOf, lanOf, buildNetwork } from './resources.js';
import { settingsOf, settingsPlan } from './settings.js';
import { storageOf, diskChoices, mountTargetFor, migrationNetworks } from './storage.js';

/* 启动项操作走宿主自带的 sight 对象（sight-ui ≥ 0.4.0，包依赖已约束） */
const initAction = (client, name, action) => client.call('sight', 'setInitAction', { name, action });

export class DockerError extends Error {
	constructor(message, code) { super(message); this.code = code; }
}

/** 纯函数：插件响应 → body；失败抛 DockerError */
export function unwrap(r) {
	if (!r || typeof r.code !== 'number') throw new DockerError('Unexpected response from the device', 0);
	if (r.code >= 300) throw new DockerError(r.body?.message || `HTTP ${r.code}`, r.code);
	return r.body;
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
