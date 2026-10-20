/* Compose 项目：按标签归组、项目列表与项目文件校验（纯函数） */

export const PROJECT_LABEL = 'com.docker.compose.project';

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

const COMPOSE_LIMIT = 131072;

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
