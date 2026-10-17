<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, createPoller, useEditor, fmtBytes, Badge, Button, Icon, Select, SettingRow, FormSection, DescriptionList, Feedback, LogView } from '@sight/sdk';
	import { cpuPercent, memoryUsage, canUpdate, portLinks, RESTART_POLICIES } from './service.js';
	import { stateTone, stateLabel, policyLabel, short, date } from './format.js';
	import Terminal from './Terminal.svelte';

	/* 容器详情（抽屉正文）：状态与操作（打开网页、编辑、更新）、资源占用、终端、重启策略、挂载与日志。
	   启停、删除与更新需确认，交给页面（onrequest）；页面操作后重建本组件以重读全部内容。
	   Compose 项目里的容器以项目文件为准，不在这里编辑或更新。 */
	let { svc, container, memTotal = null, locked = false, onrequest, onstart, onedit } = $props();
	const links = $derived(portLinks(container.publish, window.location.hostname));
	let config = $state(undefined);   // undefined 加载中；null 读取失败
	let configError = $state('');
	let policy = $state('');
	let policyResult = $state(null);
	let saving = $state(false);
	let usage = $state(null);         // { cpu, memory }
	let usageError = $state('');
	let logs = $state(undefined);     // undefined 加载中；{ ok, text }
	let alive = true, logVersion = 0, prev = null;
	onDestroy(() => { alive = false; logVersion++; });
	useEditor(() => ({ dirty: !!config && policy !== config.restart, busy: saving }));

	const running = $derived(container.state === 'running');
	const busyAll = $derived(locked || saving);

	async function loadConfig() {
		try { const r = await svc.inspect(container.id); if (alive) { config = r; policy = r.restart; } }
		catch (e) { if (alive) { config = null; configError = errorText(e); } }
	}
	async function loadLogs() {
		const request = ++logVersion;
		logs = undefined;
		try { const r = await svc.logs(container.id); if (alive && request === logVersion) logs = r; }
		catch (e) { if (alive && request === logVersion) logs = { ok: false, text: errorText(e) }; }
	}
	/* 资源占用：每 2 秒一次即时采样，CPU 由相邻两次采样相减；首拍只有内存 */
	async function sample() {
		try {
			const s = await svc.stats(container.id);
			if (!alive) return;
			usage = { cpu: prev ? cpuPercent(prev, s) : null, memory: memoryUsage(s) };
			prev = s; usageError = '';
		} catch (e) { if (alive) usageError = errorText(e); }
	}
	const poller = createPoller(sample, 2000);
	$effect(() => { if (running) { poller.start(); return () => poller.stop(); } });
	loadConfig();
	loadLogs();

	async function savePolicy() {
		if (busyAll || !config) return;
		saving = true; policyResult = null;
		try {
			await svc.setRestartPolicy(container.id, policy);
			if (alive) { config = { ...config, restart: policy }; policyResult = { tone: 'success', text: t('Restart policy saved') }; }
		} catch (e) { if (alive) policyResult = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) saving = false; }
	}

	/* 匿名卷名为 64 位十六进制，只显示前 12 位 */
	const mountSource = m => (/^[a-f0-9]{64}$/.test(m.source || '') ? m.source.slice(0, 12) : m.source) || '-';
	/* 内存上限不小于整机内存即视为未限制 */
	const memoryText = m => !m ? t('Not available') : m.limit && (!memTotal || m.limit < memTotal) ? t('%s of %s', fmtBytes(m.used), fmtBytes(m.limit)) : t('%s (no limit)', fmtBytes(m.used));
	const usageItems = $derived([
		{ label: t('CPU'), value: usage?.cpu == null ? t('Measuring…') : `${usage.cpu.toFixed(1)}%` },
		{ label: t('Memory'), value: usage ? memoryText(usage.memory) : t('Measuring…') },
	]);
	const items = $derived([
		{ label: t('Image'), value: container.image, mono: true },
		{ label: t('Status'), value: container.status },
		{ label: t('Ports'), value: container.ports.join(', ') || t('None published'), mono: !!container.ports.length },
		{ label: t('Network'), value: config?.network || '-' },
		{ label: t('Created'), value: date(container.created) },
		{ label: 'ID', value: short(container.id), mono: true },
		{ label: t('Command'), value: container.command, mono: true, span: 2 },
	]);
</script>

<div class="detail" data-container-detail={container.name}>
	<div class="detail-head">
		<Badge tone={stateTone(container.state)}>{stateLabel(container.state)}</Badge>
		<span class="detail-actions">
			{#if running}
				<Button disabled={busyAll} onclick={() => onrequest('restart')}>{t('Restart')}</Button>
				<Button disabled={busyAll} onclick={() => onrequest('stop')}>{t('Stop')}</Button>
			{:else}
				<Button variant="primary" disabled={busyAll} onclick={onstart}>{t('Start')}</Button>
			{/if}
			{#if !container.project}
				<Button disabled={busyAll} onclick={onedit} data-action="edit">{t('Edit')}</Button>
				<Button disabled={busyAll || !canUpdate(config?.imageRef)} title={config && !canUpdate(config.imageRef) ? t('Created from an image ID') : undefined} onclick={() => onrequest('update')} data-action="update">{t('Update')}</Button>
			{/if}
			<Button variant="danger" disabled={busyAll} onclick={() => onrequest('remove')}>{t('Delete')}</Button>
		</span>
	</div>
	{#if container.project}<p class="muted">{t('Part of the Compose project %s. Change it by editing the project file.', container.project)}</p>{/if}
	{#if links.length}
		<div class="links" data-links>
			{#each links as l}<Button size="compact" href={l.url} target="_blank" rel="noopener noreferrer"><Icon name="external" />{t('Open port %d', l.port)}</Button>{/each}
		</div>
	{/if}

	{#if running}
		<FormSection title={t('Resource usage')}>
			<div data-usage>
				{#if usageError}<Feedback tone="error" message={t('Usage could not be read: %s', usageError)} compact />
				{:else}<DescriptionList items={usageItems} columns={2} emphasis />{/if}
			</div>
		</FormSection>
	{/if}

	<FormSection title={t('Container')}><DescriptionList items={items} /></FormSection>

	{#if running}
		<FormSection title={t('Terminal')} description={t('Opens a shell inside the container in a new tab. Only reachable from the LAN; the session ends when the tab is closed.')}>
			<Terminal {svc} {container} locked={busyAll} />
		</FormSection>
	{/if}

	<FormSection title={t('Restart policy')} description={t('Whether Docker starts the container again after it exits or the device restarts.')}>
		{#if config === undefined}<Feedback tone="loading" message={t('Loading…')} compact />
		{:else if config === null}<Feedback tone="error" message={configError} onretry={loadConfig} compact />
		{:else}
			<SettingRow id="docker-restart-policy" label={t('Restart automatically')}>
				<Select id="docker-restart-policy" bind:value={policy} disabled={busyAll}>
					{#each RESTART_POLICIES as p}<option value={p}>{policyLabel(p)}</option>{/each}
				</Select>
			</SettingRow>
			{#if policy !== config.restart || saving}
				<div><Button variant="primary" size="compact" disabled={busyAll} onclick={savePolicy}>{saving ? t('Saving…') : t('Save restart policy')}</Button></div>
			{/if}
			{#if policyResult}<Feedback tone={policyResult.tone} message={policyResult.text} compact />{/if}
		{/if}
	</FormSection>

	{#if config?.mounts?.length}
		<FormSection title={t('Folders')}>
			<ul class="mounts">
				{#each config.mounts as m}
					<li><span class="mono">{mountSource(m)}</span> → <span class="mono">{m.destination}</span>{#if m.type === 'volume'} <Badge>{t('Volume')}</Badge>{/if}{#if m.readonly} <Badge>{t('Read-only')}</Badge>{/if}</li>
				{/each}
			</ul>
		</FormSection>
	{/if}

	<FormSection title={t('Logs')} description={t('Last 200 lines, oldest first.')}>
		{#if logs === undefined}<Feedback tone="loading" message={t('Loading…')} compact />
		{:else if !logs.ok}<Feedback tone="error" message={t('Logs could not be read: %s', logs.text || t('unknown error'))} compact />
		{:else if !logs.text}<Feedback tone="empty" message={t('No log output')} compact />
		{:else}<LogView text={logs.text} label={t('Log contents')} tail maxHeight="50vh" />{/if}
		<div><Button size="compact" onclick={loadLogs} disabled={logs === undefined}>{t('Refresh logs')}</Button></div>
	</FormSection>
</div>

<style lang="less">
	.detail { display: flex; flex-direction: column; gap: var(--sp-6); }
	.detail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
	.detail-actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
	.mounts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); overflow-wrap: anywhere; }
	.links { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-xs); }
</style>
