/*
 * Docker（dockerman 的 rpcd 插件 docker / docker.container / docker.image）。
 * 插件把 Docker API 的 HTTP 响应包成 { code, headers, body }：code ≥ 300 视为失败，body.message 为原因；
 * 守护进程连不上时 code 为 500。容器日志经 ubus 取不到（多路复用流含 NUL 字节，JSON 在此截断），
 * 改用 docker CLI 的 logs（固定参数，ACL 逐字声明）。rpcd 拒绝带 env 的 exec，CLI 只能连本机默认套接字；
 * dockerman 配置了其它主机（dockerd.globals.hosts）时不取日志，界面说明原因。
 * 启停等均为即时操作，操作后回读列表。
 */
import { probe } from '@sight/sdk/lib';

export const ACTIONS = ['start', 'stop', 'restart'];
const LOG_LINES = '200';
const LOCAL_SOCKET = 'unix:///var/run/docker.sock';

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

/** 纯函数：dockerd.globals.hosts 首项 → DOCKER_HOST；未配置时用 CLI 默认套接字 */
export function dockerHost(dockerd) {
	const globals = Object.values(dockerd || {}).find(s => s['.type'] === 'globals');
	const first = [].concat(globals?.hosts || [])[0];
	if (!first) return null;
	return first.startsWith('/') ? `unix://${first}` : first;
}

export function createDocker(client, uci) {
	const call = async (object, method, params) => unwrap(await client.call(object, method, params));
	return {
		/**
		 * @returns {Promise<null | { reachable: false, error: string } | { reachable: true, info, containers, images, disk }>}
		 * null = 未安装 dockerman
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
				info: { version: info.ServerVersion || version.body?.Version || '', running: info.ContainersRunning ?? 0, total: info.Containers ?? 0, cpus: info.NCPU ?? null, memory: info.MemTotal ?? null, root: info.DockerRootDir || '' },
				disk: df?.LayersSize ?? null,
				...shape(containers, images),
			};
		},
		async action(id, action) {
			if (!ACTIONS.includes(action)) throw new Error('Unknown action');
			await call('docker.container', action, { id, query: action === 'start' ? {} : { t: 10 } });
		},
		async inspect(id) { return call('docker.container', 'inspect', { id, query: {} }); },
		async removeImage(id) { await call('docker.image', 'remove', { id, query: {} }); },
		/** @returns {Promise<{ ok: boolean, text: string, remote?: boolean }>} CLI 不存在或连不上时 ok 为 false */
		async logs(id) {
			if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error('Invalid container id');
			const host = dockerHost(await uci.load('dockerd').catch(() => null));
			if (host && host !== LOCAL_SOCKET) return { ok: false, text: '', remote: true };
			const r = await client.call('file', 'exec', { command: '/usr/bin/docker', params: ['logs', '--tail', LOG_LINES, '--timestamps', id] });
			/* docker logs 把容器的 stdout/stderr 原样写到自己的两个流，合并按时间戳排序 */
			const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').filter(Boolean).sort();
			return { ok: (r.code ?? 0) === 0, text: lines.join('\n') };
		},
		/** 守护进程未运行时通过启动项启动 dockerd */
		async startService() { await client.call('luci', 'setInitAction', { name: 'dockerd', action: 'start' }); },
	};
}
