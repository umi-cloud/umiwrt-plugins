<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, useEditor, fmtBytes, Badge, Button, Callout, Disclosure, Icon, Select, SettingRow, FormSection, DescriptionList, Feedback } from '@sight/sdk';
	import { portLinks, RESTART_POLICIES } from './containers.js';
	import { isAnonymousVolume } from './resources.js';
	import { canUpdate } from './images.js';
	import { stateTone, stateLabel, policyLabel, short, date } from './format.js';
	import Terminal from './Terminal.svelte';
	import ContainerLogs from './ContainerLogs.svelte';

	/* 容器详情（抽屉正文）：状态与操作（打开网页、编辑、更新）、资源占用、终端、重启策略、挂载与日志。
	   启停、删除与更新需确认，交给页面（onrequest）；页面操作后重建本组件以重读全部内容。
	   Compose 项目里的容器以项目文件为准，不在这里编辑或更新。usage 为页面统一采样的 { cpu, memory }，首拍 cpu 为 null */
	let { svc, container, memTotal = null, locked = false, updateAvailable = false, usage = null, onrequest, onstart, onedit } = $props();
	const links = $derived(portLinks(container.publish, window.location.hostname));
	let config = $state(undefined);   // undefined 加载中；null 读取失败
	let configError = $state('');
	let policy = $state('');
	let policyResult = $state(null);
	let saving = $state(false);
	let alive = true;
	onDestroy(() => { alive = false; });
	useEditor(() => ({ dirty: !!config && policy !== config.restart, busy: saving }));

	const running = $derived(container.state === 'running');
	const busyAll = $derived(locked || saving);

	async function loadConfig() {
		try { const r = await svc.inspect(container.id); if (alive) { config = r; policy = r.restart; } }
		catch (e) { if (alive) { config = null; configError = errorText(e); } }
	}
	loadConfig();

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
	const mountSource = m => (isAnonymousVolume(m.source) ? m.source.slice(0, 12) : m.source) || '-';
	/* 内存上限不小于整机内存即视为未限制 */
	const memoryText = m => !m ? t('Not available') : m.limit && (!memTotal || m.limit < memTotal) ? t('%s of %s', fmtBytes(m.used), fmtBytes(m.limit)) : t('%s (no limit)', fmtBytes(m.used));
	const usageItems = $derived([
		{ label: t('CPU'), value: usage?.cpu == null ? t('Measuring…') : `${usage.cpu.toFixed(1)}%` },
		{ label: t('Memory'), value: usage ? memoryText(usage.memory) : t('Measuring…') },
	]);
	const HEALTH = { healthy: () => t('Healthy'), unhealthy: () => t('Unhealthy'), starting: () => t('Starting') };
	/* 异常说明：反复重启（附退出码）、内存不足被结束、健康检查失败 */
	const trouble = $derived.by(() => {
		if (!config) return '';
		const parts = [];
		if (container.state === 'restarting' || (config.restartCount > 0 && container.state !== 'running'))
			parts.push(t('It has restarted %d times; the last exit code was %d.', config.restartCount, config.exitCode ?? -1));
		if (config.oom) parts.push(t('It was stopped because it ran out of memory. Raise or remove the memory limit.'));
		if (config.health === 'unhealthy') parts.push(config.healthOutput ? t('The health check fails: %s', config.healthOutput.slice(0, 200)) : t('The health check fails.'));
		if (config.error) parts.push(config.error);
		return parts.join(' ');
	});
	const items = $derived([
		{ label: t('Image'), value: container.image, mono: true },
		{ label: t('Status'), value: container.status },
		...(config?.health ? [{ label: t('Health'), value: HEALTH[config.health]?.() || config.health }] : []),
		{ label: t('Ports'), value: container.ports.join(', ') || t('None published'), mono: !!container.ports.length },
		{ label: t('Network'), value: config?.network || '-' },
		...(config?.addresses?.length ? [{ label: t('IP address'), value: config.addresses.map(a => [a.ip, a.ip6].filter(Boolean).join(' / ') + (config.addresses.length > 1 ? ` (${a.network})` : '')).join(', '), mono: true }] : []),
		...(config?.restartCount ? [{ label: t('Restarts'), value: String(config.restartCount) }] : []),
		{ label: t('Created'), value: date(container.created) },
		{ label: 'ID', value: short(container.id), mono: true },
		{ label: t('Command'), value: container.command, mono: true, span: 2 },
	]);
</script>

<div class="detail" data-container-detail={container.name}>
	<div class="detail-head">
		<span class="badges"><Badge tone={stateTone(container.state)}>{stateLabel(container.state)}</Badge>{#if updateAvailable}<Badge tone="info">{t('Update available')}</Badge>{/if}</span>
		<span class="detail-actions">
			{#if running}
				<Button disabled={busyAll} onclick={() => onrequest('restart')}>{t('Restart')}</Button>
				<Button disabled={busyAll} onclick={() => onrequest('stop')}>{t('Stop')}</Button>
			{:else}
				<Button variant="primary" disabled={busyAll} onclick={onstart}>{t('Start')}</Button>
			{/if}
			{#if !container.project}
				<Button disabled={busyAll} onclick={onedit} data-action="edit">{t('Edit')}</Button>
				<Button variant={updateAvailable ? 'primary' : undefined} disabled={busyAll || !canUpdate(config?.imageRef)} title={config && !canUpdate(config.imageRef) ? t('Created from an image ID') : undefined} onclick={() => onrequest('update')} data-action="update">{t('Update')}</Button>
			{/if}
			<Button variant="danger" disabled={busyAll} onclick={() => onrequest('remove')}>{t('Delete')}</Button>
		</span>
	</div>
	{#if trouble}<Callout tone="danger" message={trouble} data-container-trouble />{/if}
	{#if container.project}<p class="muted">{t('Part of the Compose project %s. Change it by editing the project file.', container.project)}</p>{/if}
	{#if links.length}
		<div class="links" data-links>
			{#each links as l}<Button size="compact" href={l.url} target="_blank" rel="noopener noreferrer"><Icon name="external" />{t('Open port %d', l.port)}</Button>{/each}
		</div>
	{/if}

	{#if running}
		<FormSection title={t('Resource usage')}>
			<div data-usage><DescriptionList items={usageItems} columns={2} emphasis /></div>
		</FormSection>
	{/if}

	<FormSection title={t('Container')}>
		<DescriptionList items={items} />
		{#if config?.env?.length}
			<Disclosure title={t('Environment variables (%d)', config.env.length)}>
				<ul class="env" data-env>{#each config.env as e}<li class="mono">{e}</li>{/each}</ul>
			</Disclosure>
		{/if}
	</FormSection>

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

	<FormSection title={t('Logs')}>
		<ContainerLogs {svc} {container} />
	</FormSection>
</div>

<style lang="less">
	.detail { display: flex; flex-direction: column; gap: var(--sp-6); }
	.detail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
	.detail-actions, .badges { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
	.mounts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); overflow-wrap: anywhere; }
	.links { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
	.env { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-1); overflow-wrap: anywhere; }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-xs); }
</style>
