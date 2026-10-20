/* Docker 设置（dockerd 的 uci globals 段）：镜像加速与数据目录的读取、校验、写入计划与重启判断（纯函数） */
import { DEFAULT_DATA_ROOT, sameDir } from './storage.js';

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
