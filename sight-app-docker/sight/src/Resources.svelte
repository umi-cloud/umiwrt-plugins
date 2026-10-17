<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, useEditor, requestLeave, fmtBytes, Badge, Button, Card, Checkbox, Dialog, Disclosure, Drawer, ErrorSummary, Feedback, Field, FormActions, Input, Table, Toolbar } from '@sight/sdk';
	import { validateNetwork } from './service.js';
	import { date } from './format.js';

	/* 网络与卷：列出驱动、子网、连接的容器，卷的大小与使用者；新建、删除没有容器使用的，清理全部未使用的卷。
	   均为即时操作，结束后回读（onreload）。 */
	let { svc, networks, volumes, locked = false, onreload } = $props();
	let busy = $state('');
	let notice = $state(null);
	let confirm = $state(null);      // { kind: 'network' | 'volume' | 'prune', item }
	let drawer = $state('');         // network | volume
	let netForm = $state({ name: '', subnet: '', gateway: '', internal: false });
	let volName = $state('');
	let errors = $state([]);
	let summary = $state();
	let alive = true;
	onDestroy(() => { alive = false; });
	const disabled = $derived(locked || !!busy);
	useEditor(() => ({ dirty: (drawer === 'network' && !!(netForm.name || netForm.subnet || netForm.gateway)) || (drawer === 'volume' && !!volName.trim()), busy: !!busy }));

	const netList = $derived(Array.isArray(networks) ? networks : []);
	const volList = $derived(Array.isArray(volumes) ? volumes : []);
	const unusedVolumes = $derived(volList.filter(v => !v.containers.length));

	async function act(key, fn, success) {
		if (disabled) return false;
		busy = key; notice = null;
		let ok = false;
		try { const r = await fn(); ok = true; if (alive) notice = { tone: 'success', text: typeof success === 'function' ? success(r) : success }; }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { busy = ''; confirm = null; await onreload?.(); } }
		return ok;
	}
	function onconfirm() {
		const { kind, item } = confirm;
		if (kind === 'network') act(item.id, () => svc.removeNetwork(item.id), t('Deleted network %s', item.name));
		else if (kind === 'volume') act(item.name, () => svc.removeVolume(item.name), t('Deleted volume %s', item.name));
		else act('prune', () => svc.pruneVolumes(), r => r.reclaimed >= 524288 ? t('Deleted %d unused volumes and freed %s', r.count, fmtBytes(r.reclaimed)) : t('Deleted %d unused volumes', r.count));
	}

	async function openDrawer(kind) {
		if (disabled || !await requestLeave() || !alive) return;
		netForm = { name: '', subnet: '', gateway: '', internal: false }; volName = ''; errors = []; notice = null;
		drawer = kind;
	}
	async function closeDrawer() { if (!await requestLeave() || !alive) return; drawer = ''; }
	const fieldError = id => errors.filter(e => e.field === id).map(e => e.text).join(' ');

	async function submitNetwork(e) {
		e.preventDefault();
		errors = validateNetwork(netForm, netList.map(n => n.name)).map(x => ({ text: t(x.message), field: `network-${x.field}` }));
		if (errors.length) { await tick(); summary?.focus(); return; }
		const form = $state.snapshot(netForm);
		busy = 'network-new';
		try { await svc.createNetwork(form); if (!alive) return; drawer = ''; notice = { tone: 'success', text: t('Created network %s', form.name.trim()) }; await onreload?.(); }
		catch (err) { if (alive) { errors = [{ text: errorText(err) }]; await tick(); summary?.focus(); } }
		finally { if (alive) busy = ''; }
	}
	const VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
	async function submitVolume(e) {
		e.preventDefault();
		const name = volName.trim();
		errors = name && !VOLUME_RE.test(name) ? [{ text: t('Names use letters, digits, dots, dashes and underscores, at least 2 characters'), field: 'volume-name' }]
			: name && volList.some(v => v.name === name) ? [{ text: t('A volume with this name already exists'), field: 'volume-name' }] : [];
		if (errors.length) { await tick(); summary?.focus(); return; }
		busy = 'volume-new';
		try { await svc.createVolume(name); if (!alive) return; drawer = ''; notice = { tone: 'success', text: name ? t('Created volume %s', name) : t('Created a volume') }; await onreload?.(); }
		catch (err) { if (alive) { errors = [{ text: errorText(err) }]; await tick(); summary?.focus(); } }
		finally { if (alive) busy = ''; }
	}

	const netCells = n => [{ text: n.name, strong: true }, { text: n.driver }, { text: n.subnets.join(', ') || '-', mono: !!n.subnets.length }, { text: n.containers.join(', ') || t('None') }];
	const volCells = v => [{ text: v.name }, { text: v.size == null ? '-' : fmtBytes(v.size) }, { text: v.containers.join(', ') || t('Unused') }, { text: date(v.created) }];
	const TITLES = { network: c => t('Delete network %s?', c.item.name), volume: c => t('Delete volume %s?', c.item.name), prune: () => t('Delete %d unused volumes?', unusedVolumes.length) };
</script>

{#snippet netContent(raw, row, colIndex)}
	{#if colIndex === 0}<span class="name"><strong>{row.name}</strong>{#if row.builtin} <Badge>{t('Built-in')}</Badge>{/if}{#if row.project} <Badge tone="info">{row.project}</Badge>{/if}{#if row.internal} <Badge>{t('No internet')}</Badge>{/if}</span>
	{:else}{raw.text}{/if}
{/snippet}
{#snippet netActions(row)}
	{#if !row.builtin}<Button size="compact" disabled={disabled || row.containers.length > 0} title={row.containers.length ? t('Used by containers') : undefined} onclick={() => confirm = { kind: 'network', item: row }}>{t('Delete')}</Button>{/if}
{/snippet}
{#snippet volContent(raw, row, colIndex)}
	{#if colIndex === 0}<span class="name"><strong class="mono">{row.anonymous ? row.name.slice(0, 12) : row.name}</strong>{#if row.anonymous} <Badge>{t('Unnamed')}</Badge>{/if}{#if row.project} <Badge tone="info">{row.project}</Badge>{/if}</span>
	{:else}{raw.text}{/if}
{/snippet}
{#snippet volActions(row)}
	<Button size="compact" disabled={disabled || row.containers.length > 0} title={row.containers.length ? t('Used by containers') : undefined} onclick={() => confirm = { kind: 'volume', item: row }}>{t('Delete')}</Button>
{/snippet}

<Dialog open={!!confirm} tone="danger" busy={!!busy} title={confirm ? TITLES[confirm.kind](confirm) : ''} confirmLabel={t('Delete')} cancelLabel={t('Cancel')}
	{onconfirm} onclose={() => { if (!busy) confirm = null; }}>
	{#if confirm?.kind === 'network'}{t('Containers can no longer be connected to this network.')}
	{:else if confirm?.kind === 'volume'}{t('The data in this volume is deleted and cannot be recovered.')}
	{:else if confirm?.kind === 'prune'}<span data-prune-volumes>{t('Every volume that no container uses is deleted with its data, including named volumes of stopped Compose projects. This cannot be undone.')}</span>{/if}
</Dialog>

<div class="stack">
	{#if notice}<Feedback tone={notice.tone} message={notice.text} />{/if}
	<Card icon="globe" flush>
		<Toolbar label={t('Networks')} count={t('%d networks', netList.length)} live={false}>
			{#snippet actions()}<Button variant="primary" size="compact" disabled={disabled} onclick={() => openDrawer('network')} data-action="network-new">{t('New network')}</Button>{/snippet}
		</Toolbar>
		{#if networks?.error}<Feedback tone="error" message={t('Networks could not be read: %s', networks.error)} onretry={onreload} inset />
		{:else}
			<Table headers={[t('Network'), t('Driver'), t('Subnet'), t('Containers')]} rows={netList} cells={netCells} rowKey={n => n.id} rowAttrs={n => ({ 'data-network': n.name })}
				cellContent={netContent} actions={netActions} actionsLabel={t('Actions')} empty={t('No networks')} />
		{/if}
	</Card>
	<Card icon="storage" flush>
		<Toolbar label={t('Volumes')} count={t('%d unused', unusedVolumes.length)} live={false}>
			{#snippet actions()}
				<Button size="compact" disabled={disabled || !unusedVolumes.length} onclick={() => confirm = { kind: 'prune' }} data-action="prune-volumes">{busy === 'prune' ? t('Removing…') : t('Remove unused')}</Button>
				<Button variant="primary" size="compact" disabled={disabled} onclick={() => openDrawer('volume')} data-action="volume-new">{t('New volume')}</Button>
			{/snippet}
		</Toolbar>
		{#if volumes?.error}<Feedback tone="error" message={t('Volumes could not be read: %s', volumes.error)} onretry={onreload} inset />
		{:else}
			<Table headers={[t('Volume'), t('Size'), t('Used by'), t('Created')]} rows={volList} cells={volCells} rowKey={v => v.name} rowAttrs={v => ({ 'data-volume': v.name })}
				cellContent={volContent} actions={volActions} actionsLabel={t('Actions')} empty={t('No volumes. Containers store data in volumes or in folders shared from the device.')} />
		{/if}
	</Card>
</div>

<Drawer open={drawer === 'network'} title={t('New network')} onclose={closeDrawer}>
	{#if drawer === 'network'}
		<form class="form" onsubmit={submitNetwork} aria-label={t('New network')} data-network-form>
			<ErrorSummary {errors} bind:this={summary} />
			<Field id="network-name" label={t('Name')} help={t('Containers on the same network reach each other by container name.')} error={fieldError('network-name')}>
				<Input id="network-name" bind:value={netForm.name} disabled={!!busy} spellcheck="false" autocomplete="off" aria-describedby="network-name-help" aria-invalid={!!fieldError('network-name')} />
			</Field>
			<Disclosure title={t('Advanced')} description={t('Subnet, gateway and internet access')}>
				<div class="form">
					<Field id="network-subnet" label={t('Subnet')} help={t('Leave empty to let Docker choose a free one.')} error={fieldError('network-subnet')}>
						<Input id="network-subnet" bind:value={netForm.subnet} disabled={!!busy} placeholder="172.30.0.0/16" spellcheck="false" aria-describedby="network-subnet-help" />
					</Field>
					<Field id="network-gateway" label={t('Gateway')} error={fieldError('network-gateway')}>
						<Input id="network-gateway" bind:value={netForm.gateway} disabled={!!busy} placeholder="172.30.0.1" spellcheck="false" />
					</Field>
					<Checkbox bind:checked={netForm.internal} disabled={!!busy}>{t('No internet access: containers on this network only reach each other')}</Checkbox>
				</div>
			</Disclosure>
			<FormActions busy={!!busy} oncancel={closeDrawer} saveLabel={t('Create')} />
		</form>
	{/if}
</Drawer>

<Drawer open={drawer === 'volume'} title={t('New volume')} onclose={closeDrawer}>
	{#if drawer === 'volume'}
		<form class="form" onsubmit={submitVolume} aria-label={t('New volume')} data-volume-form>
			<ErrorSummary {errors} bind:this={summary} />
			<Field id="volume-name" label={t('Name')} help={t('Leave empty to let Docker choose one. Volumes are stored in the Docker data directory.')} error={fieldError('volume-name')}>
				<Input id="volume-name" bind:value={volName} disabled={!!busy} spellcheck="false" autocomplete="off" aria-describedby="volume-name-help" />
			</Field>
			<FormActions busy={!!busy} oncancel={closeDrawer} saveLabel={t('Create')} />
		</form>
	{/if}
</Drawer>

<style lang="less">
	.stack, .form { display: flex; flex-direction: column; gap: var(--sp-4); }
	.form { gap: var(--sp-5); }
	.name { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); min-width: 0; overflow-wrap: anywhere; }
	.name strong { color: var(--heading-color); font-weight: var(--fw-semibold); }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-xs); }
</style>
