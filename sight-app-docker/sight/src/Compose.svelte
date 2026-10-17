<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, useEditor, requestLeave, Badge, Button, Card, Checkbox, DescriptionList, Dialog, Drawer, ErrorSummary, Feedback, Field, FormActions, Input, Table, Textarea, Toolbar } from '@sight/sdk';
	import { validateProject } from './service.js';
	import { stateLabel, date } from './format.js';
	import TaskProgress from './TaskProgress.svelte';

	/* Compose 项目：本页保存的项目文件（/etc/sight-docker/compose/<名称>/compose.yaml）可编辑、启动、停止、拉取更新、删除；
	   别处创建的项目（只有容器标签）只读，可以停止。启停等操作是设备端后台任务（onstart 由页面执行并跟踪），抽屉内显示进度与输出。 */
	let { svc, compose, task = null, output = '', locked = false, onstart, onreload } = $props();
	const projects = $derived(compose?.projects || []);
	let openName = $state(null);
	let creating = $state(false);
	let confirm = $state(null);      // { kind: 'down' | 'remove', project }
	let removeVolumes = $state(false);
	let error = $state('');
	let alive = true;
	onDestroy(() => { alive = false; });
	const running = $derived(task?.state === 'running');
	const busy = $derived(locked || running);
	const current = $derived(openName ? projects.find(p => p.name === openName) || null : null);
	const projectTask = name => task?.kind === 'compose' && task.project === name ? task : null;

	/* 项目文件编辑 */
	let content = $state('');
	let baseline = $state('');
	let fileState = $state('idle');  // idle | loading | ready | error
	let fileError = $state('');
	let saving = $state(false);
	let applyAfterSave = $state(true);
	let errors = $state([]);
	let summary = $state();
	/* 新建 */
	let draft = $state({ name: '', content: '', start: true });
	useEditor(() => ({ dirty: (fileState === 'ready' && content !== baseline) || (creating && !!(draft.name || draft.content)), busy: saving }));

	async function openProject(p) {
		if (!await requestLeave() || !alive) return;
		openName = p.name; error = ''; errors = [];
		fileState = p.managed ? 'loading' : 'idle';
		if (!p.managed) return;
		try { const text = await svc.composeRead(p.name); if (alive && openName === p.name) { content = baseline = text; fileState = 'ready'; } }
		catch (e) { if (alive && openName === p.name) { fileState = 'error'; fileError = errorText(e); } }
	}
	async function closeProject() { if (!await requestLeave() || !alive) return; openName = null; fileState = 'idle'; }
	async function openCreate() { if (busy || !await requestLeave() || !alive) return; draft = { name: '', content: '', start: true }; errors = []; creating = true; }
	async function closeCreate() { if (!await requestLeave() || !alive) return; creating = false; }

	async function run(name, action, volumes = false) {
		error = '';
		try { await onstart(name, action, volumes); }
		catch (e) { if (alive) error = errorText(e); }
	}
	async function save(e) {
		e.preventDefault();
		if (saving || busy || !current) return;
		errors = validateProject({ name: current.name, content }, [], false).map(x => ({ text: t(x.message), field: 'compose-content' }));
		if (errors.length) { await tick(); summary?.focus(); return; }
		saving = true;
		const name = current.name, text = content;
		try {
			await svc.composeWrite(name, text, false);
			if (!alive) return;
			baseline = text;
			if (applyAfterSave) await run(name, 'up');
		} catch (err) { if (alive) { errors = [{ text: errorText(err) }]; await tick(); summary?.focus(); } }
		finally { if (alive) saving = false; }
	}
	async function create(e) {
		e.preventDefault();
		if (saving || busy) return;
		const name = draft.name.trim();
		errors = validateProject({ name, content: draft.content }, projects.map(p => p.name)).map(x => ({ text: t(x.message), field: `compose-new-${x.field}` }));
		if (errors.length) { await tick(); summary?.focus(); return; }
		saving = true;
		try {
			await svc.composeWrite(name, draft.content, true);
			if (!alive) return;
			const start = draft.start, text = draft.content;
			draft = { name: '', content: '', start: true };
			creating = false;
			await onreload?.();
			if (!alive) return;
			openName = name; content = baseline = text; fileState = 'ready'; errors = [];
			if (start) await run(name, 'up');
		} catch (err) { if (alive) { errors = [{ text: errorText(err) }]; await tick(); summary?.focus(); } }
		finally { if (alive) saving = false; }
	}
	function request(kind, project) { removeVolumes = false; confirm = { kind, project }; }
	async function onconfirm() {
		const { kind, project } = confirm, volumes = removeVolumes;
		confirm = null;
		if (kind === 'remove') { openName = null; fileState = 'idle'; }
		await run(project.name, kind, volumes);
	}

	const stateBadge = p => ({ running: ['success', t('Running')], partial: ['info', t('Partly running')], stopped: ['neutral', t('Stopped')], empty: ['neutral', t('Not started')] }[p.state]);
	const cells = p => [{ text: p.name }, { text: '' }, { text: p.containers.length ? t('%d of %d running', p.running, p.containers.length) : '-' }, { text: p.managed ? t('Saved in Sight') : p.workingDir || t('Created elsewhere') }];
	const rowAttrs = p => ({ 'data-project': p.name, 'data-clickable': '', onclick: e => { if (!e.target.closest('button, a, input')) openProject(p); } });
	const containerItems = p => p.containers.map(c => ({ label: c.service || c.name, value: `${c.name} · ${stateLabel(c.state)}` }));
	const EXAMPLE = 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n    restart: unless-stopped\n';
</script>

{#snippet content_(raw, row, colIndex)}
	{#if colIndex === 1}{@const b = stateBadge(row)}<Badge tone={b[0]}>{b[1]}</Badge>
	{:else if colIndex === 0}<strong class="name">{row.name}</strong>
	{:else}{raw.text}{/if}
{/snippet}

{#snippet actions(row)}
	{#if row.state === 'running' || row.state === 'partial'}
		<Button size="compact" disabled={busy} onclick={() => request('down', row)}>{t('Stop')}</Button>
	{:else if row.managed}
		<Button size="compact" disabled={busy} onclick={() => run(row.name, 'up')}>{t('Start')}</Button>
	{/if}
{/snippet}

<Dialog open={!!confirm} tone="danger" busy={false} title={confirm ? (confirm.kind === 'remove' ? t('Delete project %s?', confirm.project.name) : t('Stop project %s?', confirm.project.name)) : ''}
	confirmLabel={confirm?.kind === 'remove' ? t('Delete') : t('Stop')} cancelLabel={t('Cancel')} {onconfirm} onclose={() => confirm = null}>
	{#if confirm?.kind === 'remove'}
		<div class="confirm-body" data-compose-remove>
			<p>{t('Its containers and networks are removed and the project file is deleted from the device.')}</p>
			<Checkbox bind:checked={removeVolumes}>{t('Also delete the project’s volumes. Their data cannot be recovered.')}</Checkbox>
		</div>
	{:else if confirm}
		{confirm.project.managed ? t('Its containers and networks are removed. Volumes and the project file are kept, so it can be started again.') : t('Its containers and networks are removed. Volumes are kept. This project was created elsewhere; start it again from where it was created.')}
	{/if}
</Dialog>

<Card icon="container" flush>
	<Toolbar label={t('Compose projects')} count={t('%d projects', projects.length)} live={false}>
		{#snippet actions()}<Button variant="primary" size="compact" disabled={busy || compose?.available === false || !!compose?.error} onclick={openCreate} data-action="compose-new">{t('New project')}</Button>{/snippet}
	</Toolbar>
	{#if error && !openName}<Feedback tone="error" message={error} inset />{/if}
	{#if compose?.error}<Feedback tone="error" message={t('Compose projects could not be read: %s', compose.error)} onretry={onreload} inset />
	{:else}
		{#if compose?.available === false}<Feedback tone="info" message={t('docker-compose is not installed on the device. Reinstall sight-app-docker.')} inset />{/if}
		<Table headers={[t('Project'), t('State'), t('Containers'), t('Source')]} rows={projects} {cells} rowKey={p => p.name} {rowAttrs}
			cellContent={content_} {actions} actionsLabel={t('Actions')} empty={t('No Compose projects yet. Create one by pasting a compose.yaml.')} />
	{/if}
</Card>

<Drawer open={!!current} title={current?.name || ''} error={openName ? error : ''} onclose={closeProject}>
	{#if current}
		{@const pt = projectTask(current.name)}
		{@const b = stateBadge(current)}
		<div class="detail" data-project-detail={current.name}>
			<div class="head">
				<Badge tone={b[0]}>{b[1]}</Badge>
				<span class="head-actions">
					{#if current.managed}
						<Button variant="primary" disabled={busy} onclick={() => run(current.name, 'up')} data-action="compose-up">{t('Start')}</Button>
						<Button disabled={busy} onclick={() => run(current.name, 'pull')} data-action="compose-pull">{t('Update images')}</Button>
					{/if}
					{#if current.containers.length}<Button disabled={busy} onclick={() => request('down', current)} data-action="compose-down">{t('Stop')}</Button>{/if}
					{#if current.managed}<Button variant="danger" disabled={busy} onclick={() => request('remove', current)} data-action="compose-remove">{t('Delete')}</Button>{/if}
				</span>
			</div>
			{#if pt}<TaskProgress task={pt} {output} />{/if}
			{#if current.containers.length}<DescriptionList items={containerItems(current)} columns={1} />{/if}

			{#if !current.managed}
				<p class="muted">{t('This project was created outside this page, for example with docker compose on the command line. It is shown here read-only; you can stop it.')}</p>
				{#if current.workingDir}<DescriptionList items={[{ label: t('Project folder'), value: current.workingDir, mono: true }]} columns={1} />{/if}
			{:else if fileState === 'loading'}<Feedback tone="loading" message={t('Loading…')} compact />
			{:else if fileState === 'error'}<Feedback tone="error" message={fileError} compact />
			{:else if fileState === 'ready'}
				<form class="form" onsubmit={save} aria-label={t('Project file')} data-compose-form>
					<ErrorSummary {errors} bind:this={summary} />
					<Field id="compose-content" label="compose.yaml" help={t('Saved on the device. Changes take effect when the project is started again.')}>
						<Textarea id="compose-content" bind:value={content} rows="18" spellcheck="false" disabled={saving || busy} aria-describedby="compose-content-help" />
					</Field>
					<Checkbox bind:checked={applyAfterSave} disabled={saving || busy}>{t('Start the project with the saved file')}</Checkbox>
					<FormActions busy={saving} disabled={busy || content === baseline} oncancel={() => { content = baseline; errors = []; }} description={current.modified ? t('Last saved %s', date(current.modified)) : ''} />
				</form>
			{/if}
		</div>
	{/if}
</Drawer>

<Drawer open={creating} title={t('New project')} onclose={closeCreate}>
	{#if creating}
		<form class="form" onsubmit={create} aria-label={t('New project')} data-compose-new>
			<ErrorSummary {errors} bind:this={summary} />
			<Field id="compose-new-name" label={t('Project name')} help={t('Lowercase letters, digits, dashes and underscores. Containers are named after it.')}>
				<Input id="compose-new-name" bind:value={draft.name} disabled={saving} spellcheck="false" autocomplete="off" placeholder="myapp" aria-describedby="compose-new-name-help" />
			</Field>
			<Field id="compose-new-content" label="compose.yaml" help={t('Paste the contents of the project’s compose.yaml. Compose checks it before it is saved.')}>
				<Textarea id="compose-new-content" bind:value={draft.content} rows="18" spellcheck="false" disabled={saving} placeholder={EXAMPLE} aria-describedby="compose-new-content-help" />
			</Field>
			<Checkbox bind:checked={draft.start} disabled={saving}>{t('Start the project after saving')}</Checkbox>
			<FormActions busy={saving} oncancel={closeCreate} saveLabel={t('Save')} />
		</form>
	{/if}
</Drawer>

<style lang="less">
	.form, .detail { display: flex; flex-direction: column; gap: var(--sp-5); }
	.head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
	.head-actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
	.name { color: var(--heading-color); font-weight: var(--fw-semibold); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	.confirm-body { display: flex; flex-direction: column; gap: var(--sp-3); }
	.confirm-body p { margin: 0; }
	.form :global(textarea) { width: 100%; }
</style>
