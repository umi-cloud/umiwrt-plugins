<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, client, uci, activity, useEditor, requestLeave, fmtBytes, Card, Tabs, Table, Toolbar, Badge, Button, Checkbox, StatusHero, Drawer, Dialog, Feedback, Field, Input, ErrorSummary, FormActions } from '@sight/sdk';
	import { createDocker, isImageRef, normalizeImage, pullPercent } from './service.js';
	import { stateTone, stateLabel, short, date } from './format.js';
	import ContainerDetail from './ContainerDetail.svelte';
	import CreateContainer from './CreateContainer.svelte';
	import Settings from './Settings.svelte';

	/* 按日常任务：看哪些容器在跑、启停重启、看日志与资源占用；新建、删除容器，下载与清理镜像；
	   镜像加速与数据目录在「设置」。 */
	const svc = createDocker(client, uci);
	let data = $state(undefined);   // undefined 加载中；null 未安装
	let error = $state('');
	let notice = $state(null);
	let busy = $state('');          // 正在操作的容器/镜像 ID，或 'service' / 'prune'
	let section = $state('containers');
	const tabsId = $props.id();
	let detailId = $state(null);
	let detailVersion = $state(0);  // 操作后递增，重建详情以重读
	let confirm = $state(null);     // { kind: 'stop' | 'restart' | 'remove' | 'image' | 'prune', item }
	let removeVolumes = $state(false);
	let creating = $state(false);
	let pullOpen = $state(false);
	let pullRef = $state('');
	let pullErrors = $state([]);
	let pullSummary = $state();
	let pullTask = $state(null);
	const locked = $derived(!!busy || activity.busy);
	/* 容器与镜像操作进行中阻止切页；下载在设备端后台进行，不阻止 */
	useEditor(() => ({ dirty: pullOpen && !!pullRef.trim(), busy: !!busy }));
	let alive = true, version = 0;
	onDestroy(() => { alive = false; version++; });

	async function load() {
		const request = ++version;
		error = '';
		try { const r = await svc.load(); if (alive && request === version) data = r; }
		catch (e) { if (alive && request === version) error = errorText(e); }
	}
	load();

	/* 后台下载：轮询设备端任务直到结束；同一时间只有一个轮询 */
	let watching = null;
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	function watchPull() {
		watching ??= (async () => {
			try {
				while (alive) {
					const task = await svc.pullStatus();
					if (!alive) return null;
					pullTask = task;
					if (task?.state !== 'running') return task;
					await sleep(1500);
				}
				return null;
			} finally { watching = null; }
		})();
		return watching;
	}
	/** 下载镜像并等到结束：返回最终任务（state 为 done/failed），启动失败直接抛出。新建容器时用 */
	async function pull(ref) {
		pullTask = await svc.pullStart(ref);
		const task = await watchPull();
		if (alive) await load();
		return task;
	}
	/* 从「下载镜像」发起或进入页面时设备上正有下载（例如刷新前发起的）：跟踪到结束并说明结果 */
	async function follow(task) {
		pullTask = task;
		const done = await watchPull();
		if (!alive || !done) return;
		/* 先回读列表再说明结果，提示出现时新镜像已在列表里 */
		await load();
		if (!alive) return;
		notice = done.state === 'done' ? { tone: 'success', text: t('Downloaded %s', done.image) }
			: { tone: 'error', text: t('Could not download %s: %s', done.image, errorText(done.error || 'unknown error')) };
	}
	svc.pullStatus().then(task => { if (alive && task?.state === 'running' && !watching) follow(task); }).catch(() => { /* 只影响进度显示 */ });

	const detail = $derived(detailId && data?.containers?.find(c => c.id === detailId) || null);
	$effect(() => { if (detailId && data?.reachable && !detail) detailId = null; });
	const tabs = $derived([
		{ value: 'containers', label: t('Containers'), count: data?.containers?.length ?? 0 },
		{ value: 'images', label: t('Images'), count: data?.images?.length ?? 0 },
		{ value: 'settings', label: t('Settings') },
	]);
	const unused = $derived(data?.images?.filter(i => !i.containers).length ?? 0);
	const pullRunning = $derived(pullTask?.state === 'running');
	const pullText = task => { const p = pullPercent(task); return t('Downloading %s… %s', task.image, p == null ? '' : `${p}%`); };

	/* 即时操作：执行后回读列表并重建详情 */
	async function run(key, action, success) {
		if (locked) return false;
		busy = key; notice = null;
		let ok = false;
		try { await action(); ok = true; if (alive) notice = { tone: 'success', text: success }; }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { busy = ''; confirm = null; await load(); detailVersion++; } }
		return ok;
	}
	const act = (c, action) => run(c.id, () => svc.action(c.id, action), { start: t('Started %s', c.name), stop: t('Stopped %s', c.name), restart: t('Restarted %s', c.name) }[action]);
	async function removeContainer(c) {
		const volumes = removeVolumes;
		if (await run(c.id, () => svc.removeContainer(c.id, { force: c.state === 'running', volumes }), t('Deleted %s', c.name)) && detailId === c.id) detailId = null;
	}
	const removeImage = img => run(img.id, () => svc.removeImage(img.id), t('Removed image %s', img.tags[0] || short(img.id)));
	async function prune() {
		const before = data.images.length;
		let reclaimed = 0;
		const ok = await run('prune', async () => { reclaimed = (await svc.pruneImages()).reclaimed; }, '');
		if (!alive || !ok) return;
		/* 数量按清理前后的列表计；释放空间不足 1 MB（按 MB 显示为 0）或 Docker 未报告时不写 */
		const count = Math.max(0, before - (data?.images?.length ?? before));
		notice = { tone: 'success', text: reclaimed >= 524288 ? t('Removed %d unused images and freed %s', count, fmtBytes(reclaimed)) : t('Removed %d unused images', count) };
	}
	async function startService() {
		busy = 'service'; error = '';
		try { await svc.startService(); } catch (e) { if (alive) error = errorText(e); }
		finally { if (alive) { busy = ''; await load(); } }
	}
	function onconfirm() {
		const { kind, item } = confirm;
		if (kind === 'image') removeImage(item);
		else if (kind === 'remove') removeContainer(item);
		else if (kind === 'prune') prune();
		else act(item, kind);
	}
	function request(kind, item) { removeVolumes = false; confirm = { kind, item }; }

	async function openDetail(c) { if (!await requestLeave() || !alive) return; detailId = c.id; }
	async function closeDetail() { if (!await requestLeave() || !alive) return; detailId = null; }
	async function openCreate() { if (locked || !await requestLeave() || !alive) return; notice = null; creating = true; }
	async function closeCreate() { if (!await requestLeave() || !alive) return; creating = false; }
	async function created({ name, image, started, startError }) {
		creating = false;
		const label = name || image;
		notice = startError ? { tone: 'error', text: t('Created %s, but it could not be started: %s', label, startError) }
			: { tone: 'success', text: started ? t('Created and started %s', label) : t('Created %s', label) };
		section = 'containers';
		await load();
	}

	async function openPull() { if (!await requestLeave() || !alive) return; pullRef = ''; pullErrors = []; pullOpen = true; }
	async function closePull() { if (!await requestLeave() || !alive) return; pullOpen = false; }
	async function submitPull(e) {
		e.preventDefault();
		const ref = normalizeImage(pullRef);
		pullErrors = isImageRef(ref) ? [] : [{ text: t('Enter a valid image name, for example nginx:latest'), field: 'pull-image' }];
		if (!pullErrors.length) {
			try { const task = await svc.pullStart(ref); if (!alive) return; pullOpen = false; pullRef = ''; notice = null; follow(task); return; }
			catch (err) { pullErrors = [{ text: errorText(err) }]; }
		}
		await tick(); pullSummary?.focus();
	}

	const containerAttrs = c => ({ 'data-container': c.name, 'data-clickable': '', onclick: e => { if (!e.target.closest('button, a, input')) openDetail(c); } });
	const containerCells = c => [{ text: c.name }, { text: '' }, { text: c.ports.join(', ') || '-', mono: !!c.ports.length }, { text: c.status }];
	const imageCells = i => [{ text: i.tags.join(', ') || t('(untagged)'), strong: true }, { text: short(i.id), mono: true }, { text: fmtBytes(i.size) }, { text: date(i.created) }, { text: i.containers ? t('%d containers', i.containers) : t('Unused') }];
	const TITLES = {
		image: c => t('Remove image %s?', c.item.tags[0] || short(c.item.id)), stop: c => t('Stop %s?', c.item.name), restart: c => t('Restart %s?', c.item.name),
		remove: c => t('Delete %s?', c.item.name), prune: () => t('Remove %d unused images?', unused),
	};
	const LABELS = { image: 'Remove', stop: 'Stop', restart: 'Restart', remove: 'Delete', prune: 'Remove' };
</script>

{#snippet containerContent(raw, row, colIndex)}
	{#if colIndex === 1}<Badge tone={stateTone(row.state)}>{stateLabel(row.state)}</Badge>
	{:else if colIndex === 0}<span class="name"><strong>{row.name}</strong><span class="muted mono">{row.image}</span></span>
	{:else}{raw.text}{/if}
{/snippet}

{#snippet containerActions(row)}
	{#if row.state === 'running'}
		<Button size="compact" disabled={locked} onclick={() => request('restart', row)}>{t('Restart')}</Button>
		<Button size="compact" disabled={locked} onclick={() => request('stop', row)}>{t('Stop')}</Button>
	{:else}
		<Button size="compact" disabled={locked} onclick={() => act(row, 'start')}>{busy === row.id ? t('Starting…') : t('Start')}</Button>
	{/if}
{/snippet}

{#snippet imageActions(row)}
	<Button size="compact" disabled={locked || row.containers > 0} title={row.containers ? t('Used by containers') : undefined} onclick={() => request('image', row)}>{t('Remove')}</Button>
{/snippet}

<Dialog open={!!confirm} tone={confirm?.kind === 'restart' ? 'primary' : 'danger'} busy={locked}
	title={confirm ? TITLES[confirm.kind](confirm) : ''} confirmLabel={confirm ? t(LABELS[confirm.kind]) : ''} cancelLabel={t('Cancel')}
	{onconfirm} onclose={() => { if (!busy) confirm = null; }}>
	{#if confirm?.kind === 'image'}{t('The image is deleted from the device. It can be downloaded again later.')}
	{:else if confirm?.kind === 'stop'}{t('Services provided by this container become unavailable until it is started again.')}
	{:else if confirm?.kind === 'restart'}{t('The container stops briefly and starts again.')}
	{:else if confirm?.kind === 'prune'}{t('Images that no container uses are deleted from the device. Images used by any container, running or stopped, are kept.')}
	{:else if confirm?.kind === 'remove'}
		<div class="confirm-body" data-remove-dialog>
			<p>{confirm.item.state === 'running' ? t('The container is running. It is stopped first, then deleted along with any changes made inside it. Folders shared from the device are kept.') : t('The container is deleted along with any changes made inside it. Folders shared from the device are kept.')}</p>
			<Checkbox bind:checked={removeVolumes} disabled={locked}>{t('Also delete its unnamed volumes')}</Checkbox>
		</div>
	{/if}
</Dialog>

{#if error}<Feedback tone="error" message={error} onretry={load} />{/if}
{#if notice}<Feedback tone={notice.tone} message={notice.text} />{/if}
{#if data === undefined && !error}
	<Feedback tone="loading" message={t('Loading…')} />
{:else if data === null}
	<Feedback tone="info" message={t('The Docker service is not available on this device. Reinstall sight-app-docker.')} />
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
				<Toolbar label={t('Containers')} count={t('%d running', data.info.running)} live={false}>
					{#snippet actions()}<Button variant="primary" size="compact" disabled={locked} onclick={openCreate} data-action="create">{t('New container')}</Button>{/snippet}
				</Toolbar>
				<Table headers={[t('Container'), t('State'), t('Ports'), t('Status')]} rows={data.containers} cells={containerCells} rowKey={c => c.id} rowAttrs={containerAttrs}
					cellContent={containerContent} actions={containerActions} actionsLabel={t('Actions')} empty={t('No containers yet. Create one from an image.')} />
			</Card>
		</div>
		<div id={`${tabsId}-panel-1`} role="tabpanel" aria-labelledby={`${tabsId}-tab-1`} hidden={section !== 'images'} tabindex="0">
			<Card icon="container" flush>
				<Toolbar label={t('Images')} count={t('%d unused', unused)} live={false}>
					{#snippet actions()}
						<Button size="compact" disabled={locked || !unused} onclick={() => request('prune')} data-action="prune">{busy === 'prune' ? t('Removing…') : t('Remove unused')}</Button>
						<Button variant="primary" size="compact" disabled={locked || pullRunning} onclick={openPull} data-action="pull">{t('Download image')}</Button>
					{/snippet}
				</Toolbar>
				{#if pullRunning}<div data-pull="running"><Feedback tone="loading" message={pullText(pullTask)} inset /></div>{/if}
				<Table headers={[t('Image'), 'ID', t('Size'), t('Created'), t('Used by')]} rows={data.images} cells={imageCells} rowKey={i => i.id}
					rowAttrs={i => ({ 'data-image': i.tags[0] || short(i.id) })} actions={imageActions} actionsLabel={t('Actions')} empty={t('No images')} />
			</Card>
		</div>
		<div id={`${tabsId}-panel-2`} role="tabpanel" aria-labelledby={`${tabsId}-tab-2`} hidden={section !== 'settings'} tabindex="0">
			{#if section === 'settings'}<Settings {svc} root={data.info.root} mirrors={data.info.mirrors} onreload={load} />{/if}
		</div>

		<Drawer error={notice?.tone === 'error' ? notice.text : ''} open={!!detail} title={detail?.name || ''} onclose={closeDetail}>
			{#if detail}
				{#key `${detail.id}:${detailVersion}`}
					<ContainerDetail {svc} container={detail} memTotal={data.info.memory} {locked} onrequest={kind => request(kind, detail)} onstart={() => act(detail, 'start')} />
				{/key}
			{/if}
		</Drawer>

		<Drawer open={creating} title={t('New container')} onclose={closeCreate}>
			{#if creating}
				<CreateContainer {svc} images={data.images} names={data.containers.map(c => c.name)} {pullTask} {pull} oncancel={closeCreate} oncreated={created} />
			{/if}
		</Drawer>

		<Drawer open={pullOpen} title={t('Download image')} onclose={closePull}>
			{#if pullOpen}
				<form class="form" onsubmit={submitPull} aria-label={t('Download image')} data-pull-form>
					<ErrorSummary errors={pullErrors} bind:this={pullSummary} />
					<Field id="pull-image" label={t('Image')} help={t('From Docker Hub unless a registry is given, for example ghcr.io/owner/app:tag. Without a tag, latest is used.')}>
						<Input id="pull-image" name="pullImage" bind:value={pullRef} placeholder="nginx:latest" spellcheck="false" autocomplete="off" aria-describedby="pull-image-help" />
					</Field>
					<p class="muted">{t('The download continues on the device in the background. You can leave this page; progress is shown on the Images tab.')}</p>
					<FormActions oncancel={closePull} saveLabel={t('Download')} />
				</form>
			{/if}
		</Drawer>
	</div>
{/if}

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-4); }
	.form { display: flex; flex-direction: column; gap: var(--sp-5); }
	.name { display: flex; flex-direction: column; min-width: 0; }
	.name strong { color: var(--heading-color); font-weight: var(--fw-semibold); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-xs); }
	.confirm-body { display: flex; flex-direction: column; gap: var(--sp-3); }
	.confirm-body p { margin: 0; }
</style>
