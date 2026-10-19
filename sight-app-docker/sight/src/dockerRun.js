/*
 * 「从 docker run 命令导入」：把应用说明里常见的 docker run 命令拆成新建容器表单。
 * 表单能表达的参数逐项填入；表单不支持的参数不丢弃也不猜，逐条列进 warnings（英文 msgid + args），由页面提示用户。
 */
import { splitCommand, normalizeImage, LOG_LIMITS, RESTART_POLICIES } from './service.js';
import { joinCommand } from './recreate.js';

/* 不带值的短选项（可合写，如 -dit） */
const SHORT_BOOL = new Set(['d', 'i', 't']);
/* 带值的短选项 → 长选项 */
const SHORT_VALUE = { p: 'publish', v: 'volume', e: 'env', h: 'hostname', m: 'memory', w: 'workdir', u: 'user', l: 'label' };
const IGNORED_BOOL = new Set(['detach', 'interactive', 'tty']);
/* 表单不支持、但要正确跳过取值的长选项 */
const UNSUPPORTED_VALUE = new Set(['env-file', 'workdir', 'user', 'entrypoint', 'label', 'label-file', 'dns', 'dns-search', 'dns-option', 'add-host', 'shm-size',
	'sysctl', 'ulimit', 'security-opt', 'gpus', 'pull', 'platform', 'health-cmd', 'health-interval', 'health-retries', 'health-timeout', 'health-start-period',
	'tmpfs', 'stop-signal', 'stop-timeout', 'pid', 'ipc', 'uts', 'userns', 'group-add', 'mac-address', 'link', 'cap-drop', 'memory-swap', 'memory-reservation',
	'cpu-shares', 'cpuset-cpus', 'blkio-weight', 'device-cgroup-rule', 'network-alias', 'ip6', 'expose', 'cgroupns', 'cgroup-parent', 'runtime', 'storage-opt', 'volumes-from', 'attach', 'cidfile', 'detach-keys', 'log-driver']);
const UNSUPPORTED_BOOL = new Set(['init', 'read-only', 'oom-kill-disable', 'publish-all', 'no-healthcheck', 'sig-proxy', 'disable-content-trust', 'quiet']);
/* 取值的已支持长选项 */
const SUPPORTED_VALUE = new Set(['name', 'hostname', 'restart', 'network', 'net', 'ip', 'publish', 'volume', 'mount', 'env', 'device', 'cap-add', 'memory', 'cpus', 'log-opt']);

/** 纯函数：内存写法（512m、1g、1024k、字节数）→ MB 字符串；认不出为 null */
export function memoryMb(text) {
	const m = /^(\d+(?:\.\d+)?)([bkmg]?)b?$/i.exec(String(text).trim());
	if (!m) return null;
	const n = +m[1], unit = m[2].toLowerCase();
	const mb = unit === 'g' ? n * 1024 : unit === 'm' ? n : unit === 'k' ? n / 1024 : n / 1048576;
	return mb >= 1 ? String(Math.round(mb)) : null;
}

/** 纯函数：-p 的值 → 端口行；不支持的写法（只写容器端口、端口段、IPv6 地址）为 null */
export function parsePublish(text) {
	const [spec, proto = 'tcp'] = String(text).split('/');
	if (!/^(tcp|udp)$/.test(proto) || spec.includes('[') || spec.includes('-')) return null;
	const parts = spec.split(':');
	if (parts.length === 2) return { host: parts[0], container: parts[1], proto, ip: '' };
	if (parts.length === 3 && parts[1]) return { host: parts[1], container: parts[2], proto, ip: parts[0] === '0.0.0.0' ? '' : parts[0] };
	return null;
}

/** 纯函数：-v 的值 → 目录行；只写容器路径的匿名卷为 null */
export function parseVolume(text) {
	const [host, container, opts = ''] = String(text).split(':');
	if (!host || !container) return null;
	return { host, container, readonly: opts.split(',').includes('ro') };
}

/** 纯函数：--mount 的值 → 目录行（bind / volume）；tmpfs 等为 null */
export function parseMount(text) {
	const kv = {};
	for (const part of String(text).split(',')) { const [k, v = 'true'] = part.split('='); kv[k.trim()] = v.trim(); }
	const type = kv.type || 'volume', host = kv.source || kv.src, container = kv.target || kv.destination || kv.dst;
	if (!['bind', 'volume'].includes(type) || !host || !container) return null;
	return { host, container, readonly: ['true', '1'].includes(kv.readonly || kv.ro || '') };
}

/**
 * 纯函数：docker run 命令 → { image, form（只含识别出的字段）, warnings: [{ message, args }] }；不是 docker run 命令时抛出（英文 msgid）。
 * 支持续行（行尾反斜杠）与 sudo 前缀。
 */
export function parseDockerRun(text) {
	const tokens = splitCommand(String(text || '').replace(/\\\r?\n/g, ' '));
	if (tokens === null) throw new Error('The command has an unmatched quote');
	let i = tokens[0] === 'sudo' ? 1 : 0;
	if (tokens[i] !== 'docker') throw new Error('Paste a command that starts with docker run');
	i++;
	if (tokens[i] === 'container') i++;
	if (tokens[i] !== 'run') throw new Error('Paste a command that starts with docker run');
	i++;

	const form = { ports: [], mounts: [], env: [], devices: [], caps: [] };
	const warnings = [];
	const warn = (message, ...args) => warnings.push({ message, args });
	const skipped = new Set();
	const apply = (name, value) => {
		switch (name) {
			case 'name': form.name = value; break;
			case 'hostname': form.hostname = value; break;
			case 'restart': {
				const policy = value.split(':')[0];
				if (RESTART_POLICIES.includes(policy)) form.restart = policy;
				else warn('Unknown restart policy %s', value);
				break;
			}
			case 'network': case 'net': form.network = value === 'default' ? 'bridge' : value; break;
			case 'ip': form.ip = value; break;
			case 'publish': { const p = parsePublish(value); if (p) form.ports.push(p); else warn('Port %s is not supported here; add it after importing', value); break; }
			case 'volume': { const m = parseVolume(value); if (m) form.mounts.push(m); else warn('Volume %s without a folder on the device is skipped; the image keeps its data in an unnamed volume', value); break; }
			case 'mount': { const m = parseMount(value); if (m) form.mounts.push(m); else warn('Mount %s is not supported here', value); break; }
			case 'env': if (value.includes('=')) form.env.push(value); else warn('Environment variable %s has no value; add it after importing', value); break;
			case 'device': { const [host, inner] = value.split(':'); form.devices.push(inner && inner.startsWith('/') ? `${host}:${inner}` : host); break; }
			case 'cap-add': form.caps.push(value); break;
			case 'memory': { const mb = memoryMb(value); if (mb) form.memory = mb; else warn('Memory limit %s is not understood', value); break; }
			case 'cpus': form.cpus = value; break;
			case 'log-opt': {
				const [k, v] = value.split('=');
				if (k === 'max-size') form.logSize = v; else if (k === 'max-file') form.logFiles = v; else warn('Log option %s is not supported here', value);
				break;
			}
		}
	};

	let image = '';
	while (i < tokens.length) {
		const tok = tokens[i++];
		if (tok === '--') { image = tokens[i++] || ''; break; }
		if (!tok.startsWith('-') || tok === '-') { image = tok; break; }
		if (tok.startsWith('--')) {
			const eq = tok.indexOf('='), name = eq > 0 ? tok.slice(2, eq) : tok.slice(2);
			const inline = eq > 0 ? tok.slice(eq + 1) : null;
			const take = () => inline ?? tokens[i++] ?? '';
			if (IGNORED_BOOL.has(name)) continue;
			if (name === 'rm') { warn('--rm is not supported: the container is kept after it stops'); continue; }
			if (name === 'privileged') { form.privileged = true; continue; }
			if (SUPPORTED_VALUE.has(name)) { apply(name, take()); continue; }
			if (UNSUPPORTED_VALUE.has(name)) { take(); skipped.add(`--${name}`); continue; }
			if (UNSUPPORTED_BOOL.has(name)) { skipped.add(`--${name}`); continue; }
			skipped.add(`--${name}`);
			continue;
		}
		/* 短选项：可合写（-dit），带值的可紧跟（-p80:80）或另起一个 */
		for (let k = 1; k < tok.length; k++) {
			const c = tok[k];
			if (SHORT_BOOL.has(c)) continue;
			const long = SHORT_VALUE[c];
			if (!long) { skipped.add(`-${c}`); continue; }
			const value = k + 1 < tok.length ? tok.slice(k + 1) : tokens[i++] ?? '';
			if (SUPPORTED_VALUE.has(long)) apply(long, value); else skipped.add(`-${c}`);
			break;
		}
	}
	if (!image) throw new Error('No image was found in the command');
	if (skipped.size) warn('These options are not supported here and were skipped: %s', [...skipped].join(', '));

	/* 日志选项：与预设之一相同才采用 */
	if (form.logSize || form.logFiles) {
		const key = `${form.logSize || ''}:${form.logFiles || '1'}`;
		if (LOG_LIMITS.some(o => o.value === key)) form.log = key;
		else warn('Log size %s is not one of the choices here; the recommended limit is used', `${form.logSize || '-'} × ${form.logFiles || '1'}`);
	}
	delete form.logSize; delete form.logFiles;
	const command = tokens.slice(i);
	if (command.length) form.command = joinCommand(command);
	return { image: normalizeImage(image), form, warnings };
}
