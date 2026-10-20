<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, createPoller, Card, Button, Badge, Feedback, LogView, Dialog, DescriptionList, SettingRow, fmtBytes } from '@sight/sdk';
	import { CORE_FEATURES } from './constants.js';
	import { localTime } from './format.js';
	import { featureLabel, featureHint, durationText } from './labels.js';

	/* sing-box 分区：核心运行状态、重启、经 apk 检查与更新（后台任务，进行中每 2 秒轮询）、编译特性。 */
	let { data, svc, locked = false, run, notify, reload, active = false } = $props();
	const POLL_MS = 2000;
	let alive = true;
	let status = $state(null), task = $state(null), error = $state('');
	let confirmRestart = $state(false), confirmUpgrade = $state(false), restarting = $state(false);

	async function load() {
		error = '';
		try {
			const [s, u] = await Promise.all([svc.clientStatus(), svc.readCoreTask()]);
			if (!alive) return;
			const finished = task?.kind === 'running' && u.kind !== 'running';
			status = s; task = u;
			/* 更新完成后版本号与运行状态都变了：让页面重读 */
			if (finished) await reload();
		} catch (e) { if (alive) error = errorText(e); }
	}
	/* 进入分区和配置重载（开关代理等）后都重读 */
	$effect(() => { if (active && data) load(); });
	const poller = createPoller(load, POLL_MS);
	$effect(() => { if (active && task?.kind === 'running') poller.start(); else poller.stop(); });
	onDestroy(() => { alive = false; poller.stop(); });

	async function start(action) {
		confirmUpgrade = false;
		const r = await run(() => svc.startCoreTask(action));
		if (r.ok && r.value === false) notify({ tone: 'info', text: t('Another sing-box task is still running. Wait for it to finish.') });
		if (alive) await load();
	}
	async function restart() {
		restarting = true;
		await run(() => svc.restart(), { success: t('HomeProxy restarted.') });
		if (alive) { restarting = false; confirmRestart = false; }
	}
	const runText = () => !data.enabled ? t('Not running (proxy is off)') : status?.running ? t('Running') : t('Not running');
	const updateText = u => ({
		idle: t('Not checked yet.'),
		running: u.action === 'upgrade' ? t('Updating sing-box…') : t('Checking for updates…'),
		available: t('Version %s is available (installed: %s).', u.version, u.current),
		latest: t('Up to date (checked %s).', localTime(u.time ?? 0)),
		upgraded: u.restartFailed ? t('Updated to %s, but HomeProxy failed to restart. Check the logs.', u.version) : u.restarted ? t('Updated to %s. HomeProxy was restarted to use it.', u.version) : t('Updated to %s. It is used the next time the proxy starts.', u.version),
		failed: u.action === 'upgrade' ? t('The update failed.') : t('Checking for updates failed.'),
	}[u.kind] + (u.stale ? ' ' + t('Some package sources could not be refreshed, so the result may be out of date.') : ''));
	const updateTone = u => u.kind === 'failed' || u.restartFailed ? 'danger' : u.kind === 'available' || u.kind === 'upgraded' ? 'strong' : 'muted';
</script>

<Dialog open={confirmRestart} busy={restarting} title={t('Restart HomeProxy?')} confirmLabel={t('Restart')} cancelLabel={t('Cancel')}
	onconfirm={restart} onclose={() => { if (!restarting) confirmRestart = false; }}>
	{t('The proxy stops for a few seconds and open connections are dropped.')}
</Dialog>

<Dialog open={confirmUpgrade} title={t('Update sing-box to %s?', task?.version ?? '')} confirmLabel={t('Update')} cancelLabel={t('Cancel')}
	onconfirm={() => start('upgrade')} onclose={() => confirmUpgrade = false}>
	{data.enabled ? t('The new version is downloaded and installed, then HomeProxy restarts. The proxy stops for a few seconds.') : t('The new version is downloaded and installed. It is used the next time the proxy is turned on.')}
</Dialog>

<div class="hp-stack">
	<Card title="sing-box">
		{#if error}<Feedback tone="error" message={t('sing-box status could not be read: %s', error)} onretry={load} compact />{/if}
		<div class="core" data-hp-core={status?.running ? 'running' : 'stopped'}>
			<DescriptionList columns={4} items={[
				{ label: t('Version'), value: data.version || '-' },
				{ label: t('Status'), value: runText() },
				{ label: t('Running for'), value: status?.running && status.uptime != null ? durationText(status.uptime) : '-' },
				{ label: t('Memory'), value: status?.running && status.memory ? fmtBytes(status.memory) : '-' },
			]} />
			<Button disabled={locked || !data.enabled || task?.kind === 'running'} onclick={() => confirmRestart = true}>{restarting ? t('Restarting…') : t('Restart')}</Button>
		</div>
	</Card>
	<Card title={t('Updates')}>
		{#if !task}<Feedback tone="loading" message={t('Loading…')} compact />
		{:else if task.kind === 'unsupported'}<Feedback tone="info" message={t('This device does not use apk, so sing-box cannot be updated here.')} compact />
		{:else}
			<div class="update" data-hp-core-update={task.kind}>
				<span class={updateTone(task)}>{updateText(task)}</span>
				<span class="hp-actions">
					<Button size="compact" disabled={locked || task.kind === 'running'} onclick={() => start('check')}>{task.kind === 'running' && task.action === 'check' ? t('Checking…') : t('Check for updates')}</Button>
					{#if task.kind === 'available'}<Button variant="primary" size="compact" disabled={locked} onclick={() => confirmUpgrade = true}>{t('Update to %s', task.version)}</Button>{/if}
				</span>
			</div>
			{#if task.kind === 'failed' && task.output.trim()}<LogView text={task.output} label={t('Output')} tail maxHeight="16rem" />{/if}
			<p class="hp-note note">{t('Updates come from the device’s package sources. If the proxy stops working after an update, the reason is shown at the top of this page.')}</p>
		{/if}
	</Card>
	<Card title={t('Supported features')}>
		{#each CORE_FEATURES as f}
			{@const ok = !!data.features[f]}
			<div data-feature={f} data-ok={ok ? 'yes' : 'no'}>
				<SettingRow id="hp-feature-{f}" label={featureLabel(f)} description={featureHint(f, ok)}>
					<span class="feature"><Badge tone={ok ? 'success' : 'danger'}>{ok ? t('Available') : t('Missing')}</Badge></span>
				</SettingRow>
			</div>
		{/each}
	</Card>
</div>

<style>
	.core { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; }
	.core > :global(dl) { flex: 1; min-width: min(100%, 28rem); }
	.update { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-3); font-size: var(--fs-sm); }
	.strong { font-weight: var(--fw-medium); color: var(--heading-color); }
	.muted { color: var(--text-muted); }
	.danger { color: var(--status-danger-text); }
	.note { margin-top: var(--sp-3); }
	.feature { display: flex; justify-content: flex-end; }
</style>
