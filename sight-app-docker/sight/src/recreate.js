/*
 * 重建容器（更新镜像、修改配置）用的纯函数：inspect → docker.container.create 的参数。
 * 保留 Config / HostConfig / 网络 / 标签等全部原配置，去掉与旧镜像默认值相同的部分（新镜像的默认值随之生效）；
 * 匿名卷按名称接到新容器上，数据不丢。编辑时只替换表单负责的字段，其余原样保留。
 */
import { ownNetwork, isCustomNetwork, isAnonymousVolume } from './resources.js';
import { splitCommand, createImage, parseDevice, deviceText, logOf, logConfig, normalizeCap, memoryBytes, nanoCpus, deviceList, capList, filled } from './create.js';

const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/* Config 里不带回去的字段：主机名另行判断，Image 改用引用，其余为运行期或已弃用 */
const SKIP = new Set(['Hostname', 'Domainname', 'Image', 'ArgsEscaped', 'MacAddress', 'AttachStdin', 'AttachStdout', 'AttachStderr']);
/* 与镜像默认值相同即去掉的单值字段 */
const IMAGE_DEFAULTS = ['WorkingDir', 'User', 'StopSignal', 'Healthcheck', 'Shell', 'OnBuild'];

/** 绑定挂载 "源:目标[:选项]" 拆开；源为绝对路径时是设备目录，否则是卷名 */
export function parseBind(bind) {
	const parts = String(bind).split(':');
	return { source: parts[0], target: parts[1] || '', options: parts[2] ? parts[2].split(',') : [] };
}
const joinBind = b => `${b.source}:${b.target}${b.options.length ? ':' + b.options.join(',') : ''}`;
/* host 网络、共用其他容器网络时不能设主机名，也没有自己的网络端点 */
const sharedNetwork = mode => /^(host|container:)/.test(mode || '');

/**
 * 纯函数：容器 inspect（与其镜像 inspect）→ { name, body }。
 * image 缺失时不去除镜像默认值（全部保留，仍能正确重建）。
 */
export function recreateBody(c, image) {
	const cfg = c?.Config || {}, img = image?.Config || {};
	const host = clone(c?.HostConfig || {});
	const body = {};
	for (const [k, v] of Object.entries(cfg)) if (!SKIP.has(k)) body[k] = clone(v);
	body.Image = cfg.Image;
	const mode = host.NetworkMode || 'default';
	if (!sharedNetwork(mode)) {
		/* Docker 缺省主机名为容器 ID 前 12 位 */
		if (cfg.Hostname && cfg.Hostname !== String(c.Id || '').slice(0, 12)) body.Hostname = cfg.Hostname;
		if (cfg.Domainname) body.Domainname = cfg.Domainname;
	}

	if (image) {
		if (Array.isArray(body.Env) && img.Env) body.Env = body.Env.filter(e => !img.Env.includes(e));
		/* 改了入口点时 Docker 不合并镜像的 Cmd，两者都按原样保留 */
		if (same(body.Entrypoint, img.Entrypoint)) {
			delete body.Entrypoint;
			if (same(body.Cmd, img.Cmd)) delete body.Cmd;
		}
		for (const k of IMAGE_DEFAULTS) if (k in body && same(body[k], img[k])) delete body[k];
		for (const k of ['Labels', 'ExposedPorts', 'Volumes']) {
			if (!body[k] || !img[k]) continue;
			for (const key of Object.keys(body[k])) if (key in img[k] && (k !== 'Labels' || img[k][key] === body[k][key])) delete body[k][key];
		}
	}

	/* 链接在 inspect 里是 "/对方:/本容器/别名"，create 要 "对方:别名" */
	if (Array.isArray(host.Links)) host.Links = host.Links.map(l => { const [a, b] = l.split(':'); return `${a.replace(/^\//, '')}:${(b || a).split('/').pop()}`; });

	/* 匿名卷：配置里没有写明来源的卷挂载点，按卷名接到新容器上（--mount 写法直接补上 Source） */
	const covered = new Set();
	for (const b of host.Binds || []) covered.add(parseBind(b).target);
	for (const m of host.Mounts || []) if (m.Source || m.Type !== 'volume') covered.add(m.Target);
	if (!host.VolumesFrom?.length) {
		for (const m of c?.Mounts || []) {
			if (m.Type !== 'volume' || !m.Name || covered.has(m.Destination)) continue;
			const mount = (host.Mounts || []).find(x => x.Target === m.Destination && x.Type === 'volume' && !x.Source);
			if (mount) mount.Source = m.Name;
			else (host.Binds ||= []).push(`${m.Name}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
			covered.add(m.Destination);
		}
	}

	/* 网络端点：保留静态地址、别名、链接与驱动参数；Docker 自动加的短 ID 别名去掉 */
	const endpoints = {};
	if (!sharedNetwork(mode) && mode !== 'none') {
		const shortId = String(c?.Id || '').slice(0, 12);
		for (const [net, ep] of Object.entries(c?.NetworkSettings?.Networks || {})) {
			const out = {};
			if (ep?.IPAMConfig && Object.values(ep.IPAMConfig).some(v => v && (!Array.isArray(v) || v.length))) out.IPAMConfig = clone(ep.IPAMConfig);
			const aliases = (ep?.Aliases || []).filter(a => a !== shortId && a !== c.Id);
			if (aliases.length) out.Aliases = aliases;
			if (ep?.Links?.length) out.Links = clone(ep.Links);
			if (ep?.DriverOpts && Object.keys(ep.DriverOpts).length) out.DriverOpts = clone(ep.DriverOpts);
			if (ep?.GwPriority) out.GwPriority = ep.GwPriority;
			endpoints[net] = out;
		}
	}
	body.HostConfig = host;
	body.NetworkingConfig = { EndpointsConfig: endpoints };
	return { name: String(c?.Name || '').replace(/^\//, ''), body };
}

/** 纯函数：参数数组 → 命令文本（splitCommand 的逆操作，需要时加双引号） */
export function joinCommand(args) {
	return (args || []).map(a => {
		const s = String(a);
		if (s === '') return "''";
		return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `"${s.replace(/[\\"]/g, c => '\\' + c)}"`;
	}).join(' ');
}

/** 纯函数：网络模式统一成表单的取值（default 即 bridge） */
const formNetwork = mode => !mode || mode === 'default' ? 'bridge' : mode;

const decimal = v => String(+v.toFixed(2));
/** 纯函数：create 参数 → 表单的主机名、资源限制、设备与固定地址（CPU 上限也认 CpuQuota/CpuPeriod 的写法） */
export function limitsOf(body) {
	const host = body?.HostConfig || {};
	const network = formNetwork(host.NetworkMode);
	const cpus = host.NanoCpus > 0 ? host.NanoCpus / 1e9 : host.CpuQuota > 0 && host.CpuPeriod > 0 ? host.CpuQuota / host.CpuPeriod : 0;
	return {
		hostname: body?.Hostname || '',
		memory: host.Memory > 0 ? String(Math.round(host.Memory / 1048576)) : '',
		cpus: cpus ? decimal(cpus) : '',
		devices: (host.Devices || []).map(deviceText),
		ip: isCustomNetwork(network) ? body?.NetworkingConfig?.EndpointsConfig?.[network]?.IPAMConfig?.IPv4Address || '' : '',
		log: logOf(host.LogConfig),
		caps: (host.CapAdd || []).map(normalizeCap),
	};
}

/**
 * 纯函数：容器 inspect + 重建参数 → 编辑表单（与新建表单同形）。
 * 端口只取写明了设备端口的映射；目录只取设备目录（卷挂载不由表单管理，原样保留）。
 */
export function formFromInspect(c, base) {
	const host = c?.HostConfig || {}, body = base.body;
	const ports = [];
	for (const [key, list] of Object.entries(host.PortBindings || {})) {
		const [container, proto = 'tcp'] = key.split('/');
		for (const b of list || []) if (b?.HostPort) ports.push({ host: b.HostPort, container, proto, ip: b.HostIp || '' });
	}
	/* 设备目录与命名卷进表单；匿名卷不进 */
	const mounts = (host.Binds || []).map(parseBind).filter(b => !isAnonymousVolume(b.source))
		.map(b => ({ host: b.source, container: b.target, readonly: b.options.includes('ro'), options: b.options.filter(o => o !== 'ro' && o !== 'rw') }));
	return {
		source: 'local', image: c?.Config?.Image || '', pullRef: '', name: base.name,
		ports, mounts, env: [...(body.Env || [])],
		restart: host.RestartPolicy?.Name || 'no', network: formNetwork(host.NetworkMode),
		command: body.Cmd ? joinCommand(body.Cmd) : '', privileged: !!host.Privileged, start: true,
		...limitsOf(body),
	};
}


/**
 * 纯函数：重建参数 + 编辑后的表单（已校验）→ 新的 create 参数。
 * 表单负责：镜像、环境变量、命令、重启策略、特权、网络、写明设备端口的映射、设备目录挂载；
 * 主机名、资源限制、设备与固定地址只在改动时写入（原写法如非整 MB 的内存、CpuQuota 不被改掉）；其余字段保持 base 原样。
 */
export function buildEdit(base, form) {
	const was = limitsOf(base.body);
	const body = clone(base.body);
	const host = body.HostConfig ||= {};
	body.Image = createImage(form);
	body.Env = [...form.env];
	const cmd = splitCommand(form.command);
	if (cmd?.length) body.Cmd = cmd; else delete body.Cmd;
	host.RestartPolicy = { Name: form.restart, MaximumRetryCount: form.restart === 'on-failure' ? host.RestartPolicy?.MaximumRetryCount || 0 : 0 };
	host.Privileged = !!form.privileged;

	const before = formNetwork(host.NetworkMode);
	if (form.network !== before) {
		host.NetworkMode = form.network;
		const endpoints = body.NetworkingConfig?.EndpointsConfig || {};
		delete endpoints[before];
		if (sharedNetwork(form.network) || form.network === 'none') {
			body.NetworkingConfig = { EndpointsConfig: {} };
			delete body.Hostname; delete body.Domainname;
		} else body.NetworkingConfig = { EndpointsConfig: { ...endpoints, [form.network]: {} } };
	}
	const ip = isCustomNetwork(form.network) ? String(form.ip || '').trim() : '';
	if (form.network !== before || ip !== was.ip) {
		const ep = body.NetworkingConfig?.EndpointsConfig?.[form.network];
		if (ep) {
			const ipam = { ...(ep.IPAMConfig || {}) };
			if (ip) ipam.IPv4Address = ip; else delete ipam.IPv4Address;
			if (Object.keys(ipam).length) ep.IPAMConfig = ipam; else delete ep.IPAMConfig;
		}
	}

	/* 主机名与资源限制：只写改动过的；改内存时交还 Docker 决定交换区上限，避免与旧值冲突 */
	const hostname = ownNetwork(form.network) ? String(form.hostname || '').trim() : '';
	if (hostname !== was.hostname) { if (hostname) body.Hostname = hostname; else delete body.Hostname; }
	if (String(form.memory ?? '').trim() !== was.memory) { host.Memory = memoryBytes(form.memory); host.MemorySwap = 0; }
	if (String(form.cpus ?? '').trim() !== was.cpus) { host.NanoCpus = nanoCpus(form.cpus); host.CpuQuota = 0; host.CpuPeriod = 0; }
	const devices = deviceList(form.devices), caps = capList(form.caps);
	if (JSON.stringify(devices) !== JSON.stringify(was.devices)) host.Devices = devices.map(parseDevice);
	if (JSON.stringify(caps) !== JSON.stringify(was.caps)) host.CapAdd = caps.length ? caps : null;
	if (form.log !== was.log && form.log !== 'custom') host.LogConfig = logConfig(form.log);

	/* 端口：未写设备端口的映射（随机端口）不由表单管理，保留 */
	const bindings = {}, oldKeys = new Set();
	for (const [key, list] of Object.entries(host.PortBindings || {})) {
		const kept = (list || []).filter(b => !b?.HostPort);
		if (kept.length < (list || []).length) oldKeys.add(key);
		if (kept.length) bindings[key] = kept;
	}
	const ports = form.network === 'host' ? [] : form.ports.filter(filled);
	for (const p of ports) (bindings[`${+p.container}/${p.proto}`] ||= []).push({ HostIp: p.ip || '', HostPort: String(+p.host) });
	host.PortBindings = form.network === 'host' ? {} : bindings;
	const exposed = { ...(body.ExposedPorts || {}) };
	for (const key of oldKeys) if (!bindings[key]) delete exposed[key];
	for (const key of Object.keys(host.PortBindings)) exposed[key] = {};
	if (Object.keys(exposed).length) body.ExposedPorts = exposed; else delete body.ExposedPorts;

	/* 目录：设备目录与命名卷由表单替换；匿名卷保留，挂载点与表单重复的让位 */
	const dirs = form.mounts.filter(filled).map(m => ({ source: m.host.trim(), target: m.container.trim(), options: [...(m.readonly ? ['ro'] : []), ...(m.options || [])] }));
	const targets = new Set(dirs.map(d => d.target));
	const binds = (host.Binds || []).map(parseBind).filter(b => isAnonymousVolume(b.source) && !targets.has(b.target));
	const all = [...binds, ...dirs].map(joinBind);
	host.Binds = all.length ? all : null;
	return body;
}
