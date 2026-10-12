<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, client, uci, activity, useEditor, fmtBytes, Card, Tabs, Table, Badge, Button, StatusHero, LogView, Drawer, Dialog, Feedback, FormSection, DescriptionList } from '@sight/sdk';
	import { createDocker } from './service.js';

	/* 按日常任务：看哪些容器在跑、启停重启、看日志、清理不用的镜像；
	   新建容器、网络与卷等保留在 LuCI 的 Docker 管理。 */
	const svc = createDocker(client, uci);
	let data = $state(undefined);   // undefined 加载中；null 未安装
	let error = $state('');
	let notice = $state(null);
	let busy = $state('');          // 正在操作的容器/镜像 ID
	let section = $state('containers');
	const tabsId = $props.id();
	let detailId = $state(null);
	let logs = $state(null);        // undefined 加载中；{ ok, text }
	let confirm = $state(null);     // { kind: 'stop' | 'restart' | 'image', item }
	const locked = $derived(!!busy || activity.busy);
	/* 容器与镜像操作进行中阻止切页；本页没有草稿 */
	useEditor(() => ({ dirty: false, busy: !!busy }));
	let alive = true, version = 0, logVersion = 0;
	onDestroy(() => { alive = false; version++; logVersion++; });

	async function load() {
		const request = ++version;
		error = '';
		try { const r = await svc.load(); if (alive && request === version) data = r; }
		catch (e) { if (alive && request === version) error = errorText(e); }
	}
	load();

	const detail = $derived(detailId && data?.containers?.find(c => c.id === detailId) || null);
	$effect(() => { if (detailId && data?.reachable && !detail) detailId = null; });
	const tabs = $derived([
		{ value: 'containers', label: t('Containers'), count: data?.containers?.length ?? 0 },
		{ value: 'images', label: t('Images'), count: data?.images?.length ?? 0 },
	]);
	const stateTone = s => s === 'running' ? 'success' : s === 'exited' || s === 'dead' ? 'neutral' : 'info';
	const stateLabel = s => ({ running: t('Running'), exited: t('Stopped'), paused: t('Paused'), restarting: t('Restarting'), created: t('Created'), dead: t('Dead') }[s] || s);
	const short = id => id.replace(/^sha256:/, '').slice(0, 12);
	/* Docker 给出 UTC 秒数，按浏览器时区显示为固定格式 */
	const pad = n => String(n).padStart(2, '0');
	const date = sec => { if (!sec) return '-'; const d = new Date(sec * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

	async function act(c, action) {
		if (locked) return;
		busy = c.id; notice = null; confirm = null;
		try {
			await svc.action(c.id, action);
			if (alive) notice = { tone: 'success', text: { start: t('Started %s', c.name), stop: t('Stopped %s', c.name), restart: t('Restarted %s', c.name) }[action] };
		} catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { busy = ''; await load(); if (detailId === c.id) loadLogs(c.id); } }
	}
	async function removeImage(img) {
		if (locked) return;
		busy = img.id; notice = null; confirm = null;
		try { await svc.removeImage(img.id); if (alive) notice = { tone: 'success', text: t('Removed image %s', img.tags[0] || short(img.id)) }; }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { busy = ''; await load(); } }
	}
	async function startService() {
		busy = 'service'; error = '';
		try { await svc.startService(); } catch (e) { if (alive) error = errorText(e); }
		finally { if (alive) { busy = ''; await load(); } }
	}
	async function loadLogs(id) {
		const request = ++logVersion;
		logs = undefined;
		try { const r = await svc.logs(id); if (alive && request === logVersion) logs = r; }
		catch (e) { if (alive && request === logVersion) logs = { ok: false, text: errorText(e) }; }
	}
	function openDetail(c) { detailId = c.id; loadLogs(c.id); }
	function closeDetail() { detailId = null; logVersion++; }

	const containerAttrs = c => ({ 'data-container': c.name, 'data-clickable': '', onclick: e => { if (!e.target.closest('button, a, input')) openDetail(c); } });
	const containerCells = c => [{ text: c.name }, { text: '' }, { text: c.ports.join(', ') || '-', mono: !!c.ports.length }, { text: c.status }];
	const imageCells = i => [{ text: i.tags.join(', ') || t('(untagged)'), strong: true }, { text: short(i.id), mono: true }, { text: fmtBytes(i.size) }, { text: date(i.created) }, { text: i.containers ? t('%d containers', i.containers) : t('Unused') }];
	const detailItems = $derived(detail ? [
		{ label: t('Image'), value: detail.image, mono: true },
		{ label: t('Status'), value: detail.status },
		{ label: t('Ports'), value: detail.ports.join(', ') || t('None published'), mono: !!detail.ports.length },
		{ label: t('Created'), value: date(detail.created) },
		{ label: t('Command'), value: detail.command, mono: true, span: 2 },
		{ label: 'ID', value: short(detail.id), mono: true },
	] : []);
</script>

{#snippet containerContent(raw, row, colIndex)}
	{#if colIndex === 1}<Badge tone={stateTone(row.state)}>{stateLabel(row.state)}</Badge>
	{:else if colIndex === 0}<span class="name"><strong>{row.name}</strong><span class="muted mono">{row.image}</span></span>
	{:else}{raw.text}{/if}
{/snippet}

{#snippet containerActions(row)}
	{#if row.state === 'running'}
		<Button size="compact" disabled={locked} onclick={() => confirm = { kind: 'restart', item: row }}>{t('Restart')}</Button>
		<Button size="compact" disabled={locked} onclick={() => confirm = { kind: 'stop', item: row }}>{t('Stop')}</Button>
	{:else}
		<Button size="compact" disabled={locked} onclick={() => act(row, 'start')}>{busy === row.id ? t('Starting…') : t('Start')}</Button>
	{/if}
{/snippet}

{#snippet imageActions(row)}
	<Button size="compact" disabled={locked || row.containers > 0} title={row.containers ? t('Used by containers') : undefined} onclick={() => confirm = { kind: 'image', item: row }}>{t('Remove')}</Button>
{/snippet}

<Dialog open={!!confirm} tone={confirm?.kind === 'restart' ? 'primary' : 'danger'} busy={locked}
	title={confirm?.kind === 'image' ? t('Remove image %s?', confirm.item.tags[0] || short(confirm.item.id)) : confirm?.kind === 'stop' ? t('Stop %s?', confirm?.item.name) : t('Restart %s?', confirm?.item.name ?? '')}
	confirmLabel={confirm?.kind === 'image' ? t('Remove') : confirm?.kind === 'stop' ? t('Stop') : t('Restart')} cancelLabel={t('Cancel')}
	onconfirm={() => confirm.kind === 'image' ? removeImage(confirm.item) : act(confirm.item, confirm.kind)} onclose={() => { if (!busy) confirm = null; }}>
	{#if confirm?.kind === 'image'}{t('The image is deleted from the device. It can be pulled again later.')}
	{:else if confirm?.kind === 'stop'}{t('Services provided by this container become unavailable until it is started again.')}
	{:else}{t('The container stops briefly and starts again.')}{/if}
</Dialog>

{#if error}<Feedback tone="error" message={error} onretry={load} />{/if}
{#if notice}<Feedback tone={notice.tone} message={notice.text} />{/if}
{#if data === undefined && !error}
	<Feedback tone="loading" message={t('Loading…')} />
{:else if data === null}
	<Feedback tone="info" message={t('Docker is not installed on this device. Install luci-app-dockerman to manage containers here.')} />
{:else if data && !data.reachable}
	<Card>
		<StatusHero data-docker="down" icon="container" tone="muted" title={t('Docker is not running')} status={data.error || t('The Docker service cannot be reached.')}>
			{#snippet actions()}<Button variant="primary" disabled={!!busy} onclick={startService}>{busy === 'service' ? t('Starting…') : t('Start Docker')}</Button>{/snippet}
		</StatusHero>
	</Card>
{:else if data}
	<div class="stack">
		<Card>
			<StatusHero data-docker="up" icon="container" title={t('%d of %d containers running', data.info.running, data.info.total)}
				hint={[t('Docker %s', data.info.version), data.disk != null ? t('Images use %s', fmtBytes(data.disk)) : '', data.info.root].filter(Boolean).join(' · ')}>
				{#snippet actions()}<Button onclick={load} disabled={locked}>{t('Refresh')}</Button>{/snippet}
			</StatusHero>
		</Card>

		<div class="workspace-tabs"><Tabs id={tabsId} label={t('Docker')} items={tabs} bind:value={section} variant="underline" /></div>
		<div id={`${tabsId}-panel-0`} role="tabpanel" aria-labelledby={`${tabsId}-tab-0`} hidden={section !== 'containers'} tabindex="0">
			<Card icon="container" flush>
				<Table headers={[t('Container'), t('State'), t('Ports'), t('Status')]} rows={data.containers} cells={containerCells} rowKey={c => c.id} rowAttrs={containerAttrs}
					cellContent={containerContent} actions={containerActions} actionsLabel={t('Actions')} empty={t('No containers. Create containers in LuCI advanced settings.')} />
			</Card>
		</div>
		<div id={`${tabsId}-panel-1`} role="tabpanel" aria-labelledby={`${tabsId}-tab-1`} hidden={section !== 'images'} tabindex="0">
			<Card icon="container" flush>
				<Table headers={[t('Image'), 'ID', t('Size'), t('Created'), t('Used by')]} rows={data.images} cells={imageCells} rowKey={i => i.id}
					rowAttrs={i => ({ 'data-image': i.tags[0] || short(i.id) })} actions={imageActions} actionsLabel={t('Actions')} empty={t('No images')} />
			</Card>
		</div>

		<Drawer error={error || (notice?.tone === 'error' ? notice.text : '')} open={!!detail} title={detail?.name || ''} onclose={closeDetail}>
			{#if detail}
				<div class="detail" data-container-detail={detail.name}>
					<div class="detail-head">
						<Badge tone={stateTone(detail.state)}>{stateLabel(detail.state)}</Badge>
						<span class="detail-actions">
							{#if detail.state === 'running'}
								<Button disabled={locked} onclick={() => confirm = { kind: 'restart', item: detail }}>{t('Restart')}</Button>
								<Button disabled={locked} onclick={() => confirm = { kind: 'stop', item: detail }}>{t('Stop')}</Button>
							{:else}
								<Button variant="primary" disabled={locked} onclick={() => act(detail, 'start')}>{t('Start')}</Button>
							{/if}
						</span>
					</div>
					<FormSection title={t('Container')}><DescriptionList items={detailItems} /></FormSection>
					<FormSection title={t('Logs')} description={t('Last 200 lines, oldest first.')}>
						{#if logs === undefined}<Feedback tone="loading" message={t('Loading…')} compact />
						{:else if logs?.remote}<Feedback tone="info" message={t('Logs are only available when Docker runs on this device. Read them in LuCI advanced settings.')} compact />
						{:else if logs && !logs.ok}<Feedback tone="error" message={t('Logs could not be read: %s', logs.text || t('unknown error'))} compact />
						{:else if logs && !logs.text}<Feedback tone="empty" message={t('No log output')} compact />
						{:else if logs}<LogView text={logs.text} label={t('Log contents')} tail maxHeight="50vh" />{/if}
						<div><Button size="compact" onclick={() => loadLogs(detail.id)} disabled={logs === undefined}>{t('Refresh logs')}</Button></div>
					</FormSection>
				</div>
			{/if}
		</Drawer>
	</div>
{/if}

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-4); }
	.name { display: flex; flex-direction: column; min-width: 0; }
	.name strong { color: var(--heading-color); font-weight: var(--fw-semibold); }
	.muted { color: var(--text-muted); font-size: var(--fs-sm); }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-xs); }
	.detail { display: flex; flex-direction: column; gap: var(--sp-6); }
	.detail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
	.detail-actions { display: flex; gap: var(--sp-2); }
</style>
