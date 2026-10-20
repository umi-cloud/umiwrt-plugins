/* 容器：列表整形、分组与搜索、打开网页的地址、详情与资源占用（纯函数） */
import { PROJECT_LABEL } from './compose.js';
import { imageRefOf } from './images.js';

export const ACTIONS = ['start', 'stop', 'restart'];

export const RESTART_POLICIES = ['unless-stopped', 'always', 'on-failure', 'no'];

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
