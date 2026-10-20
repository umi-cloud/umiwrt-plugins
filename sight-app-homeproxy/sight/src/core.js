/*
 * sing-box 核心的检查与更新（sight.homeproxy core_task / core_start，后台任务）的纯函数。
 */

/**
 * 纯函数：core_task 的返回 → 更新区的状态。
 * kind：unsupported 设备不用 apk；idle 还没检查过；running 检查或更新进行中；available 有新版 version；
 * latest 已是最新；upgraded 已从 from 更新到 version（restarted 表示随后重启了 HomeProxy，restartFailed 表示重启失败）；
 * failed 失败，output 为 apk 输出。stale：有软件源没能刷新，结果可能过时
 */
export function coreUpdateState(r) {
	if (!r?.supported) return { kind: 'unsupported' };
	const task = r.task;
	if (!task) return { kind: 'idle' };
	if (task.state === 'running') return { kind: 'running', action: task.action };
	if (task.state !== 'done') return { kind: 'failed', action: task.action, output: r.output || '' };
	const stale = task.update_code != null && task.update_code !== 0;
	if (task.action === 'upgrade')
		return task.current && task.current !== task.from ? { kind: 'upgraded', version: task.current, from: task.from, restarted: !!task.restarted, restartFailed: !!task.restart_failed, time: task.finished } : { kind: 'latest', time: task.finished };
	return task.latest ? { kind: 'available', version: task.latest, current: task.current, time: task.finished, stale } : { kind: 'latest', time: task.finished, stale };
}
