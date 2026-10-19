<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, createPoller, Card, Button, Switch, Select, Tabs, Feedback, LogView, Dialog } from '@sight/sdk';
	import { LOGS, LOG_LEVELS } from './service.js';

	/* 日志分区：服务日志与 sing-box 日志、跟随（每 5 秒刷新）、sing-box 日志级别、清空。
	   active 为分区是否可见；logName 可由页面指定（诊断里的「查看日志」）；busy 回传给页面锁定其它操作；
	   write 为页面的保存流程（日志级别随配置应用），onnotice 由页面在顶部显示结果。 */
	let { data, svc, locked = false, write, active = false, logName = $bindable('homeproxy'), busy = $bindable(false), onnotice } = $props();
	const tabsId = $props.id();

	let alive = true, request = 0;
	let logText = $state(undefined), logError = $state(''), confirmClean = $state(false), follow = $state(false);

	/* quiet：跟随时的定时刷新，不先清空成加载中 */
	async function loadLog(quiet = false) {
		const current = ++request, name = logName;
		if (!quiet) { logText = undefined; logError = ''; }
		try { const text = await svc.log(name); if (alive && current === request) { logText = text; logError = ''; } }
		catch (e) { if (alive && current === request) { logText = null; logError = errorText(e); } }
	}
	$effect(() => { if (active) { logName; loadLog(); } });
	const poller = createPoller(() => loadLog(true), 5000);
	$effect(() => { if (follow && active) poller.start(); else poller.stop(); });
	onDestroy(() => { alive = false; poller.stop(); });

	/* sing-box 日志级别：改动随配置应用重载 HomeProxy；应用失败或被放弃时选择框回到已保存的值 */
	const logLevelLabel = l => ({ error: t('Errors only'), warn: t('Warnings (default)'), info: t('Info'), debug: t('Debug') }[l]);
	let logLevel = $state('warn');
	$effect(() => { logLevel = data.logLevel; });
	async function setLogLevel(level) {
		if (level === data.logLevel) return;
		const ok = await write(() => svc.setLogLevel(level), t('Log level set to %s.', logLevelLabel(level)));
		if (!ok && alive) logLevel = data.logLevel;
	}

	/* 清空日志不可撤销：确认后执行，期间锁定其它操作 */
	async function cleanLog() {
		if (locked) return;
		busy = true;
		try { await svc.cleanLog(logName); } catch (e) { if (alive) onnotice?.({ tone: 'error', text: errorText(e) }); }
		finally { if (alive) { busy = false; confirmClean = false; loadLog(); } }
	}
</script>

<Dialog open={confirmClean} tone="danger" {busy} title={t('Clear the %s log?', logName === 'homeproxy' ? t('Service') : 'sing-box')} confirmLabel={t('Clear log')} cancelLabel={t('Cancel')}
	onconfirm={cleanLog} onclose={() => { if (!busy) confirmClean = false; }}>
	{t('The log contents are deleted and cannot be restored.')}
</Dialog>

<Card>
	<div class="log-tools">
		<Tabs id={tabsId} label={t('Logs')} size="compact" items={LOGS.map(l => ({ value: l, label: l === 'homeproxy' ? t('Service') : 'sing-box' }))} bind:value={logName} />
		<span class="log-actions">
			{#if logName === 'sing-box-c'}
				<Select size="compact" bind:value={logLevel} disabled={locked} aria-label={t('Log level')} title={t('Changing the level reloads HomeProxy. Use info or debug while troubleshooting, then set it back to warn.')}
					onchange={e => setLogLevel(e.currentTarget.value)} data-hp-log-level>
					{#each LOG_LEVELS as l}<option value={l}>{logLevelLabel(l)}</option>{/each}
					{#if !LOG_LEVELS.includes(data.logLevel)}<option value={data.logLevel}>{data.logLevel}</option>{/if}
				</Select>
			{/if}
			<span class="follow"><Switch checked={follow} aria-label={t('Follow')} onchange={on => follow = on} /><span aria-hidden="true">{t('Follow')}</span></span>
			<Button size="compact" onclick={() => confirmClean = true} disabled={locked || !logText}>{t('Clear log')}</Button>
			<Button size="compact" onclick={loadLog} disabled={logText === undefined}>{t('Refresh')}</Button>
		</span>
	</div>
	{#each LOGS as l, index (l)}
		<div id={`${tabsId}-panel-${index}`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${index}`} hidden={logName !== l}>
			{#if logName === l}
				{#if logError}<Feedback tone="error" message={t('Log could not be read: %s', logError)} onretry={loadLog} compact />
				{:else if logText === undefined}<Feedback tone="loading" message={t('Loading…')} compact />
				{:else if logText === null}<Feedback tone="empty" message={t('No log yet. It appears after the service has run.')} compact />
				{:else if !logText.trim()}<Feedback tone="empty" message={t('Log is empty')} compact />
				{:else}<LogView text={logText} label={t('Log contents')} tail />{/if}
			{/if}
		</div>
	{/each}
</Card>

<style lang="less">
	.log-tools { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-3); }
	.log-actions { display: flex; align-items: center; gap: var(--sp-2); }
	.follow { display: inline-flex; align-items: center; gap: var(--sp-1); margin-right: var(--sp-2); font-size: var(--fs-sm); }
</style>
