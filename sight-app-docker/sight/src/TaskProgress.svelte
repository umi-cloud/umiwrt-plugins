<script>
	import { t, Badge, Button, Disclosure, Feedback, LogView } from '@sight/sdk';
	import { pullPercent } from './service.js';
	import { taskTitle, taskResult, stepLabel } from './format.js';

	/* 设备端后台任务的进度：步骤、结果与输出。任务在设备上进行，关掉页面也会做完 */
	let { task, output = '', ondismiss } = $props();
	const running = $derived(task.state === 'running');
	const result = $derived(running ? null : taskResult(task));
	const percent = $derived(task.step === 'pull' && running ? pullPercent(task) : null);
	const tone = s => ({ done: 'success', failed: 'danger', running: 'info' }[s] || 'neutral');
	/* 批量更新里跳过的是已是最新的容器 */
	const stateText = s => task.kind === 'update' && s === 'skipped' ? t('Up to date')
		: ({ done: t('Done'), failed: t('Failed'), running: t('In progress'), skipped: t('Skipped'), pending: t('Waiting') }[s] || s);
	let open = $state(false);
</script>

<div class="task" data-task={task.kind} data-task-state={task.state} data-task-started={task.started}>
	{#if running}<Feedback tone="loading" message={percent == null ? taskTitle(task) : `${taskTitle(task)} ${percent}%`} compact />
	{:else}<Feedback tone={result.tone} message={result.text} compact />{/if}
	{#if task.steps?.length > 1}
		<ol class="steps">
			{#each task.steps as s}
				<li data-step={s.name} data-step-state={s.state}><span>{stepLabel(task, s.name)}</span><Badge tone={tone(s.state)}>{stateText(s.state)}</Badge></li>
			{/each}
		</ol>
	{/if}
	{#if output}
		<Disclosure title={t('Command output')} bind:open>
			<LogView text={output} label={t('Task output')} tail maxHeight="40vh" />
		</Disclosure>
	{/if}
	{#if !running && ondismiss}<div><Button size="compact" onclick={ondismiss}>{t('Dismiss')}</Button></div>{/if}
</div>

<style lang="less">
	.task { display: flex; flex-direction: column; gap: var(--sp-3); }
	.steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); }
	.steps li { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
</style>
