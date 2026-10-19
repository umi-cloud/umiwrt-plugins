<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, createPoller, Card, Button, Badge, Feedback, LogView, Dialog, DescriptionList, fmtBytes } from '@sight/sdk';
	import { CORE_FEATURES, localTime } from './service.js';

	/* sing-box 分区：核心运行状态、重启、经 apk 检查与更新（后台任务，进行中每 2 秒轮询）、编译特性。
	   active 为分区是否可见；busy 回传给页面锁定其它操作；onnotice 由页面在顶部显示结果，onreload 让页面重读配置与服务状态。 */
	let { data, svc, locked = false, active = false, busy = $bindable(false), onnotice, onreload } = $props();

	let alive = true;
	let core = $state(null), coreUpdate = $state(null), coreError = $state('');
	let confirmRestart = $state(false), confirmUpgrade = $state(false);

	async function loadCore() {
		coreError = '';
		try {
			const [status, update] = await Promise.all([svc.clientStatus(), svc.coreUpdate()]);
			if (!alive) return;
			const finished = coreUpdate?.kind === 'running' && update.kind !== 'running';
			core = status; coreUpdate = update;
			/* 更新完成后版本号与运行状态都变了 */
			if (finished) await onreload?.();
		} catch (e) { if (alive) coreError = errorText(e); }
	}
	/* 进入分区和配置重载（开关代理等）后都重读 */
	$effect(() => { if (active && data) loadCore(); });
	const poller = createPoller(loadCore, 2000);
	$effect(() => { if (active && coreUpdate?.kind === 'running') poller.start(); else poller.stop(); });
	onDestroy(() => { alive = false; poller.stop(); });

	async function startCore(action) {
		confirmUpgrade = false;
		if (locked) return;
		onnotice?.(null);
		try { if (!await svc.coreStart(action) && alive) onnotice?.({ tone: 'info', text: t('Another sing-box task is still running. Wait for it to finish.') }); }
		catch (e) { if (alive) onnotice?.({ tone: 'error', text: errorText(e) }); }
		if (alive) await loadCore();
	}
	async function restart() {
		if (locked) return;
		busy = true; onnotice?.(null);
		try { await svc.restart(); if (alive) onnotice?.({ tone: 'success', text: t('HomeProxy restarted.') }); }
		catch (e) { if (alive) onnotice?.({ tone: 'error', text: errorText(e) }); }
		finally { if (alive) { busy = false; confirmRestart = false; await onreload?.(); } }
	}

	const durationText = sec => {
		const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
		return d ? t('%d d %d h', d, h) : h ? t('%d h %d min', h, m) : t('%d min', Math.max(1, m));
	};
	const runText = () => !data.enabled ? t('Not running (proxy is off)') : core?.running ? t('Running') : t('Not running');
	const featureLabel = f => ({ with_quic: 'QUIC', with_utls: 'uTLS', with_wireguard: 'WireGuard', hp_has_tproxy: 'TProxy', hp_has_tun: 'TUN' }[f]);
	const featureText = (f, ok) => ok ? {
		with_quic: t('Needed by Hysteria2 and TUIC nodes.'), with_utls: t('Needed by VLESS Reality nodes and TLS fingerprints.'), with_wireguard: t('Needed by WireGuard nodes.'),
		hp_has_tproxy: t('Kernel support for sending UDP traffic through the proxy.'), hp_has_tun: t('Kernel support for TUN mode.'),
	}[f] : {
		with_quic: t('Hysteria2 and TUIC nodes cannot be used. Install a sing-box build with QUIC support.'), with_utls: t('VLESS Reality nodes and TLS fingerprints cannot be used. Install a sing-box build with uTLS support.'),
		with_wireguard: t('WireGuard nodes cannot be used. Install a sing-box build with WireGuard support.'), hp_has_tproxy: t('UDP traffic cannot go through the proxy. Install kmod-nft-tproxy.'), hp_has_tun: t('TUN mode cannot be used. Install kmod-tun.'),
	}[f];
	const updateText = u => ({
		idle: t('Not checked yet.'),
		running: u.action === 'upgrade' ? t('Updating sing-box…') : t('Checking for updates…'),
		available: t('Version %s is available (installed: %s).', u.version, u.current),
		latest: t('Up to date (checked %s).', localTime(u.time ?? 0)),
		upgraded: u.restarted ? t('Updated to %s. HomeProxy was restarted to use it.', u.version) : t('Updated to %s. It is used the next time the proxy starts.', u.version),
		failed: u.action === 'upgrade' ? t('The update failed.') : t('Checking for updates failed.'),
	}[u.kind]);
</script>

<Dialog open={confirmRestart} {busy} title={t('Restart HomeProxy?')} confirmLabel={t('Restart')} cancelLabel={t('Cancel')}
	onconfirm={restart} onclose={() => { if (!busy) confirmRestart = false; }}>
	{t('The proxy stops for a few seconds and open connections are dropped.')}
</Dialog>

<Dialog open={confirmUpgrade} title={t('Update sing-box to %s?', coreUpdate?.version ?? '')} confirmLabel={t('Update')} cancelLabel={t('Cancel')}
	onconfirm={() => startCore('upgrade')} onclose={() => confirmUpgrade = false}>
	{data.enabled ? t('The new version is downloaded and installed, then HomeProxy restarts. The proxy stops for a few seconds.') : t('The new version is downloaded and installed. It is used the next time the proxy is turned on.')}
</Dialog>

<div class="stack">
	<Card title="sing-box">
		{#if coreError}<Feedback tone="error" message={t('sing-box status could not be read: %s', coreError)} onretry={loadCore} compact />{/if}
		<div class="core" data-hp-core={core?.running ? 'running' : 'stopped'}>
			<DescriptionList columns={4} items={[
				{ label: t('Version'), value: data.version || '-' },
				{ label: t('Status'), value: runText() },
				{ label: t('Running for'), value: core?.running && core.uptime != null ? durationText(core.uptime) : '-' },
				{ label: t('Memory'), value: core?.running && core.memory ? fmtBytes(core.memory) : '-' },
			]} />
			<Button disabled={locked || !data.enabled || coreUpdate?.kind === 'running'} onclick={() => confirmRestart = true}>{busy ? t('Restarting…') : t('Restart')}</Button>
		</div>
	</Card>
	<Card title={t('Updates')}>
		{#if !coreUpdate}<Feedback tone="loading" message={t('Loading…')} compact />
		{:else if coreUpdate.kind === 'unsupported'}<Feedback tone="info" message={t('This device does not use apk, so sing-box cannot be updated here.')} compact />
		{:else}
			<div class="core-update" data-hp-core-update={coreUpdate.kind}>
				<span class={coreUpdate.kind === 'failed' ? 'danger' : coreUpdate.kind === 'available' || coreUpdate.kind === 'upgraded' ? 'strong' : 'muted'}>{updateText(coreUpdate)}</span>
				<span class="actions">
					<Button size="compact" disabled={locked || coreUpdate.kind === 'running'} onclick={() => startCore('check')}>{coreUpdate.kind === 'running' && coreUpdate.action === 'check' ? t('Checking…') : t('Check for updates')}</Button>
					{#if coreUpdate.kind === 'available'}<Button variant="primary" size="compact" disabled={locked} onclick={() => confirmUpgrade = true}>{t('Update to %s', coreUpdate.version)}</Button>{/if}
				</span>
			</div>
			{#if coreUpdate.kind === 'failed' && coreUpdate.output.trim()}<LogView text={coreUpdate.output} label={t('Output')} tail maxHeight="16rem" />{/if}
			<p class="muted core-note">{t('Updates come from the device’s package sources. If the proxy stops working after an update, the reason is shown at the top of this page.')}</p>
		{/if}
	</Card>
	<Card title={t('Supported features')}>
		<ul class="resources">
			{#each CORE_FEATURES as f}
				{@const ok = !!data.features[f]}
				<li data-feature={f} data-ok={ok ? 'yes' : 'no'}>
					<div class="resource-copy"><strong>{featureLabel(f)}</strong><span class="muted">{featureText(f, ok)}</span></div>
					<Badge tone={ok ? 'success' : 'danger'}>{ok ? t('Available') : t('Missing')}</Badge>
				</li>
			{/each}
		</ul>
	</Card>
</div>

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-4); }
	.muted { color: var(--text-muted); font-size: var(--fs-sm); }
	.core { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; }
	.core :global(.dl) { flex: 1; min-width: min(100%, 28rem); }
	.core-update { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-3); font-size: var(--fs-sm); }
	.core-update .strong { font-weight: var(--fw-medium); color: var(--heading-color); }
	.core-update .danger { color: var(--status-danger-text); }
	.core-note { margin: var(--sp-3) 0 0; }
	.actions { display: flex; align-items: center; gap: var(--sp-2); }
	.resources { list-style: none; margin: 0; padding: 0; }
	.resources li { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3) 0; border-top: 1px solid var(--border-color); }
	.resources li:first-child { border-top: 0; padding-top: 0; }
	.resource-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.resource-copy strong { font-weight: var(--fw-medium); color: var(--heading-color); }
</style>
