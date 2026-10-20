<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, createPoller, Card, Button, Switch, Select, Tabs, Feedback, LogView, Dialog } from '@sight/sdk';
	import { LOGS, LOG_LEVELS } from './constants.js';
	import { logLabel, logLevelLabel } from './labels.js';

	/* 日志分区：服务日志与 sing-box 日志、跟随（每 5 秒刷新）、sing-box 日志级别、清空。
	   logName 可由页面指定（诊断里的「查看日志」）。 */
	let { data, svc, locked = false, write, run, active = false, logName = $bindable('homeproxy') } = $props();
	const tabsId = $props.id();
	const POLL_MS = 5000;
	let alive = true, request = 0;
	let text = $state(undefined), error = $state(''), confirmClear = $state(false), clearing = $state(false), follow = $state(false);

	/* quiet：跟随时的定时刷新，不先清空成加载中 */
	async function load(quiet = false) {
		const current = ++request, name = logName;
		if (!quiet) { text = undefined; error = ''; }
		try { const r = await svc.readLog(name); if (alive && current === request) { text = r; error = ''; } }
		catch (e) { if (alive && current === request) { text = null; error = errorText(e); } }
	}
	$effect(() => { if (active) { logName; load(); } });
	const poller = createPoller(() => load(true), POLL_MS);
	$effect(() => { if (follow && active) poller.start(); else poller.stop(); });
	onDestroy(() => { alive = false; poller.stop(); });

	/* sing-box 日志级别：改动随配置应用重载 HomeProxy；应用失败或被放弃时选择框回到已保存的值 */
	let level = $state('warn');
	$effect(() => { level = data.logLevel; });
	async function setLevel(next) {
		if (next === data.logLevel) return;
		const ok = await write(() => svc.setLogLevel(next), t('Log level set to %s.', logLevelLabel(next)));
		if (!ok && alive) level = data.logLevel;
	}
	/* 清空日志不可撤销：确认后执行 */
	async function clear() {
		clearing = true;
		await run(() => svc.clearLog(logName));
		if (alive) { clearing = false; confirmClear = false; load(); }
	}
</script>

<Dialog open={confirmClear} tone="danger" busy={clearing} title={t('Clear the %s log?', logLabel(logName))} confirmLabel={t('Clear log')} cancelLabel={t('Cancel')}
	onconfirm={clear} onclose={() => { if (!clearing) confirmClear = false; }}>
	{t('The log contents are deleted and cannot be restored.')}
</Dialog>

<Card>
	<div class="log-tools">
		<Tabs id={tabsId} label={t('Logs')} size="compact" items={LOGS.map(l => ({ value: l, label: logLabel(l) }))} bind:value={logName} />
		<span class="log-actions hp-actions">
			{#if logName === 'sing-box-c'}
				<Select size="compact" bind:value={level} disabled={locked} aria-label={t('Log level')} title={t('Changing the level reloads HomeProxy. Use info or debug while troubleshooting, then set it back to warn. The log is trimmed at 50 KB.')}
					onchange={e => setLevel(e.currentTarget.value)} data-hp-log-level>
					{#each LOG_LEVELS as l}<option value={l}>{logLevelLabel(l)}</option>{/each}
					{#if !LOG_LEVELS.includes(data.logLevel)}<option value={data.logLevel}>{data.logLevel}</option>{/if}
				</Select>
			{/if}
			<span class="follow"><Switch checked={follow} aria-label={t('Follow')} onchange={on => follow = on} /><span aria-hidden="true">{t('Follow')}</span></span>
			<Button size="compact" onclick={() => confirmClear = true} disabled={locked || !text}>{t('Clear log')}</Button>
			<Button size="compact" onclick={() => load()} disabled={text === undefined}>{t('Refresh')}</Button>
		</span>
	</div>
	{#each LOGS as l, index (l)}
		<div id={`${tabsId}-panel-${index}`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${index}`} hidden={logName !== l}>
			{#if logName === l}
				{#if error}<Feedback tone="error" message={t('Log could not be read: %s', error)} onretry={() => load()} compact />
				{:else if text === undefined}<Feedback tone="loading" message={t('Loading…')} compact />
				{:else if text === null}<Feedback tone="empty" message={t('No log yet. It appears after the service has run.')} compact />
				{:else if !text.trim()}<Feedback tone="empty" message={t('Log is empty')} compact />
				{:else}<LogView {text} label={t('Log contents')} tail />{/if}
			{/if}
		</div>
	{/each}
</Card>

<style>
	.log-tools { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-3); }
	.follow { display: inline-flex; align-items: center; gap: var(--sp-1); margin-right: var(--sp-2); font-size: var(--fs-sm); }
</style>
