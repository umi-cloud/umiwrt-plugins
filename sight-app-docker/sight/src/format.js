/* 页面共用的展示文案与格式 */
import { t } from '@sight/sdk';

export const stateTone = s => s === 'running' ? 'success' : s === 'exited' || s === 'dead' ? 'neutral' : 'info';
export const stateLabel = s => ({ running: t('Running'), exited: t('Stopped'), paused: t('Paused'), restarting: t('Restarting'), created: t('Created'), dead: t('Dead') }[s] || s);
export const policyLabel = p => ({ 'unless-stopped': t('Always, unless I stop it'), always: t('Always'), 'on-failure': t('Only when it exits with an error'), no: t('Never') }[p] || p);
export const short = id => id.replace(/^sha256:/, '').slice(0, 12);
/* Docker 给出 UTC 秒数，按浏览器时区显示为固定格式 */
const pad = n => String(n).padStart(2, '0');
export const date = sec => { if (!sec) return '-'; const d = new Date(sec * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/* 后台任务的标题、步骤与结果说明 */
const COMPOSE_TITLES = { up: 'Starting project %s…', pull: 'Updating project %s…', down: 'Stopping project %s…', remove: 'Deleting project %s…' };
export function taskTitle(task) {
	if (task.kind === 'pull') return t('Downloading %s…', task.image);
	if (task.kind === 'recreate') return t(task.mode === 'update' ? 'Updating %s…' : 'Applying changes to %s…', task.name);
	if (task.kind === 'compose') return t(COMPOSE_TITLES[task.action] || '%s', task.project);
	return '';
}
const STEPS = {
	recreate: { pull: 'Download the image', stop: 'Stop the current container and keep it aside', create: 'Create the new container', start: 'Start the new container', cleanup: 'Delete the previous container' },
	compose: { pull: 'Download the images', up: 'Create and start the containers', down: 'Stop and remove the containers', files: 'Delete the project file' },
	pull: { pull: 'Download the image' },
};
export const stepLabel = (task, name) => t(STEPS[task.kind]?.[name] || name);
const COMPOSE_DONE = { up: 'Started project %s', pull: 'Updated project %s', down: 'Stopped project %s', remove: 'Deleted project %s' };
/** 结束的任务 → { tone, text } */
export function taskResult(task) {
	const error = task.error ? t(task.error, ...(task.error_args || [])) : t('unknown error');
	if (task.kind === 'pull')
		return task.state === 'done' ? { tone: 'success', text: t('Downloaded %s', task.image) } : { tone: 'error', text: t('Could not download %s: %s', task.image, error) };
	if (task.kind === 'recreate') {
		if (task.state === 'done' && task.result === 'latest') return { tone: 'success', text: t('%s is already using the latest version of %s', task.name, task.image) };
		if (task.state === 'done') {
			const text = task.mode === 'update' ? t('Updated %s to the latest version of %s', task.name, task.image) : t('Applied the changes to %s', task.new_name || task.name);
			return { tone: 'success', text: task.warning ? `${text} ${t('The previous container could not be deleted: %s', task.warning)}` : text };
		}
		const what = task.mode === 'update' ? t('Could not update %s: %s', task.name, error) : t('Could not apply the changes to %s: %s', task.name, error);
		if (task.rollback === 'done') return { tone: 'error', text: `${what} ${t('The previous container was restored.')}` };
		if (task.rollback === 'failed') return { tone: 'error', text: `${what} ${t('Restoring the previous container also failed: %s', task.rollback_error || '')}` };
		return { tone: 'error', text: what };
	}
	if (task.kind === 'compose')
		return task.state === 'done' ? { tone: 'success', text: t(COMPOSE_DONE[task.action] || '%s', task.project) } : { tone: 'error', text: t('Project %s: %s', task.project, error) };
	return { tone: task.state === 'done' ? 'success' : 'error', text: task.state === 'done' ? t('Done') : error };
}
