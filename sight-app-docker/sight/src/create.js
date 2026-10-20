/* 新建容器表单：初值、校验、镜像建议、日志上限与 → docker.container.create 参数（纯函数；编辑见 recreate.js，命令导入见 dockerRun.js） */
import { isIPv4, isHostname } from '@sight/sdk/lib';
import { isImageRef, normalizeImage } from './images.js';
import { NAME_RE, inSubnet, ownNetwork, isCustomNetwork, VOLUME_RE, isAnonymousVolume } from './resources.js';
import { DEFAULT_DATA_ROOT } from './storage.js';

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

const CAP_RE = /^[A-Z][A-Z_]*$/;

/** 纯函数：权限名统一成大写、去掉 CAP_ 前缀 */
export const normalizeCap = s => String(s || '').trim().toUpperCase().replace(/^CAP_/, '');

const ENV_RE = /^[^=\s]+=/;

const port = v => /^\d+$/.test(String(v).trim()) && +v >= 1 && +v <= 65535;

/* 端口/目录行：两栏都空的行视为未填，忽略 */
export const filled = row => String(row.host ?? '').trim() !== '' || String(row.container ?? '').trim() !== '';

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
