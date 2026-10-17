<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, useEditor, Button, Checkbox, Disclosure, DynamicList, ErrorSummary, Field, FormActions, FormSection, Icon, Input, RadioGroup, Select } from '@sight/sdk';
	import { emptyCreate, validateCreate, createImage, pullPercent, RESTART_POLICIES } from './service.js';
	import { policyLabel } from './format.js';

	/* 新建容器（抽屉正文）：选镜像（本机已有，或填写后先下载）→ 名称 → 网络与端口 → 目录 → 环境变量 → 重启策略；
	   命令与特权模式收进「高级」。镜像不在本机时先经页面的后台拉取任务下载，完成后再创建。
	   edit（{ form, name }）时为修改已有容器：表单预填，保存交给 onedit 走设备端的重建任务，表单不管理的配置原样保留。 */
	let { svc, images = [], names = [], networks = [], pullTask = null, pull, oncancel, oncreated, edit = null, onedit } = $props();
	const tags = $derived([...new Set([...images.flatMap(i => i.tags), ...(edit?.form.image ? [edit.form.image] : [])])]);
	/* 本机没有镜像时直接从「下载」开始 */
	function initial() {
		if (edit) return JSON.parse(JSON.stringify(edit.form));
		const f = emptyCreate(), first = images.flatMap(i => i.tags)[0];
		if (first) f.image = first; else f.source = 'pull';
		return f;
	}
	const form = $state(initial());
	const baseline = JSON.stringify(form);
	let envDraft = $state('');
	/* 当前网络不在列表里（如 none、共用其他容器的网络）时也列出，避免编辑时被改掉 */
	const extraNetwork = $derived(edit && !['bridge', 'host', ...networks].includes(edit.form.network) ? edit.form.network : '');
	let errors = $state([]);
	let errorSummary = $state();
	let busy = $state(false);
	let phase = $state('');          // pull | create
	let alive = true;
	onDestroy(() => { alive = false; });
	const dirty = $derived(JSON.stringify(form) !== baseline || !!envDraft.trim());
	useEditor(() => ({ dirty, busy }));

	const fieldError = id => errors.filter(e => e.field === id).map(e => e.text).join(' ');
	const addPort = () => form.ports.push({ host: '', container: '', proto: 'tcp' });
	const addMount = () => form.mounts.push({ host: '', container: '', readonly: false });

	async function submit(e) {
		e.preventDefault();
		if (busy) return;
		if (envDraft.trim()) { form.env = [...form.env, envDraft.trim()]; envDraft = ''; }
		errors = validateCreate(form, edit ? names.filter(n => n !== edit.name) : names).map(x => ({ text: t(x.message), field: `create-${x.field}` }));
		if (errors.length) { await tick(); errorSummary?.focus(); return; }
		const submitted = $state.snapshot(form);
		const image = createImage(submitted);
		busy = true;
		if (edit) {
			/* 下载（如需要）与重建都在设备端任务里完成 */
			phase = 'create';
			try { await onedit(submitted); }
			catch (err) { if (alive) { errors = [{ text: errorText(err) }]; await tick(); errorSummary?.focus(); } }
			finally { if (alive) { busy = false; phase = ''; } }
			return;
		}
		try {
			if (!tags.includes(image)) {
				phase = 'pull';
				const task = await pull(image);
				if (!alive) return;
				if (task?.state !== 'done') throw new Error(t('Could not download %s: %s', image, errorText(task?.error || 'unknown error')));
			}
			phase = 'create';
			await svc.create(submitted);
			if (alive) oncreated({ name: submitted.name.trim(), image, started: submitted.start });
		} catch (err) {
			if (!alive) return;
			if (err?.created) { oncreated({ name: submitted.name.trim(), image, startError: errorText(err) }); return; }
			errors = [{ text: errorText(err) }];
			await tick(); errorSummary?.focus();
		} finally { if (alive) { busy = false; phase = ''; } }
	}

	/* 进度显示在吸底的操作栏里 */
	const progress = $derived.by(() => {
		if (phase === 'create') return edit ? t('Starting…') : t('Creating…');
		if (edit) return t('Saving recreates the container with these settings. It stops briefly; volumes and folders are kept.');
		if (phase !== 'pull') return '';
		const p = pullTask?.state === 'running' ? pullPercent(pullTask) : null;
		return t('Downloading %s… %s', createImage(form), p == null ? '' : `${p}%`);
	});
</script>

<form class="form" onsubmit={submit} aria-label={edit ? t('Edit container') : t('New container')} data-create-form={edit ? 'edit' : 'create'}>
	<ErrorSummary {errors} bind:this={errorSummary} />

	<FormSection title={t('Image')}>
		<div class="group">
			<RadioGroup name="create-source" label={t('Image source')} bind:value={form.source} disabled={busy}
				options={[{ value: 'local', label: t('On this device') }, { value: 'pull', label: t('Download') }]} />
			{#if form.source === 'local'}
				<Field id="create-image" label={t('Image')} error={fieldError('create-image')}>
					<Select id="create-image" name="createImage" bind:value={form.image} disabled={busy || !tags.length}>
						{#each tags as tag}<option value={tag}>{tag}</option>{/each}
						{#if !tags.length}<option value="">{t('No images on this device')}</option>{/if}
					</Select>
				</Field>
			{:else}
				<Field id="create-image" label={t('Image to download')} help={t('From Docker Hub unless a registry is given, for example ghcr.io/owner/app:tag. Downloading can take several minutes.')} error={fieldError('create-image')}>
					<Input id="create-image" name="createPull" bind:value={form.pullRef} disabled={busy} placeholder="nginx:latest" spellcheck="false" autocomplete="off"
						aria-invalid={!!fieldError('create-image')} aria-describedby={fieldError('create-image') ? 'create-image-help create-image-error' : 'create-image-help'} />
				</Field>
			{/if}
		</div>
	</FormSection>

	<Field id="create-name" label={t('Name')} help={t('Leave empty to let Docker choose one.')} error={fieldError('create-name')}>
		<Input id="create-name" name="createName" bind:value={form.name} disabled={busy} spellcheck="false" autocomplete="off"
			aria-invalid={!!fieldError('create-name')} aria-describedby={fieldError('create-name') ? 'create-name-help create-name-error' : 'create-name-help'} />
	</Field>

	<FormSection title={t('Network and ports')}>
		<div class="group">
			<Field id="create-network" label={t('Network')}>
				<Select id="create-network" name="createNetwork" bind:value={form.network} disabled={busy}>
					<option value="bridge">{t('Default (separate address, publish ports below)')}</option>
					<option value="host">{t('Same as the device (no port mapping needed)')}</option>
					{#each networks as n}<option value={n}>{n}</option>{/each}
					{#if extraNetwork}<option value={extraNetwork}>{extraNetwork}</option>{/if}
				</Select>
			</Field>
			{#if form.network === 'host'}
				<p class="hint">{t('The container uses the device ports directly. Make sure they are not used by other services.')}</p>
			{:else}
				<div class="rows" id="create-ports" tabindex="-1" role="group" aria-label={t('Port mappings')}>
					<span class="rows-label">{t('Port mappings')}</span>
					{#if form.ports.length}<div class="row head" aria-hidden="true"><span>{t('Device port')}</span><span></span><span>{t('Container port')}</span><span></span><span></span></div>{/if}
					{#each form.ports as p, i}
						<div class="row" data-port-row>
							<Input bind:value={p.host} disabled={busy} inputmode="numeric" placeholder="8080" aria-label={t('Device port')} />
							<span class="arrow" aria-hidden="true">→</span>
							<Input bind:value={p.container} disabled={busy} inputmode="numeric" placeholder="80" aria-label={t('Container port')} />
							<Select bind:value={p.proto} disabled={busy} aria-label={t('Protocol')}><option value="tcp">TCP</option><option value="udp">UDP</option></Select>
							<Button variant="ghost" disabled={busy} aria-label={t('Remove')} onclick={() => form.ports.splice(i, 1)}><Icon name="close" /></Button>
						</div>
					{/each}
					{#if fieldError('create-ports')}<p class="error">{fieldError('create-ports')}</p>{/if}
					<div><Button size="compact" disabled={busy} onclick={addPort}>{t('Add port')}</Button></div>
				</div>
			{/if}
		</div>
	</FormSection>

	<FormSection title={t('Folders')} description={t('Share a folder on the device with the container. Missing folders are created.')}>
		<div class="rows" id="create-mounts" tabindex="-1" role="group" aria-label={t('Folders')}>
			{#if form.mounts.length}<div class="row mount head" aria-hidden="true"><span>{t('Folder on device')}</span><span></span><span>{t('Path in container')}</span><span></span><span></span></div>{/if}
			{#each form.mounts as m, i}
				<div class="row mount" data-mount-row>
					<Input bind:value={m.host} disabled={busy} placeholder="/mnt/data/app" spellcheck="false" aria-label={t('Folder on device')} />
					<span class="arrow" aria-hidden="true">→</span>
					<Input bind:value={m.container} disabled={busy} placeholder="/data" spellcheck="false" aria-label={t('Path in container')} />
					<Checkbox bind:checked={m.readonly} disabled={busy}>{t('Read-only')}</Checkbox>
					<Button variant="ghost" disabled={busy} aria-label={t('Remove')} onclick={() => form.mounts.splice(i, 1)}><Icon name="close" /></Button>
				</div>
			{/each}
			{#if fieldError('create-mounts')}<p class="error">{fieldError('create-mounts')}</p>{/if}
			<div><Button size="compact" disabled={busy} onclick={addMount}>{t('Add folder')}</Button></div>
		</div>
	</FormSection>

	<Field id="create-env" label={t('Environment variables')} help={t('One per entry, for example TZ=Asia/Shanghai')} error={fieldError('create-env')}>
		<DynamicList id="create-env" bind:values={form.env} bind:draft={envDraft} disabled={busy} placeholder="TZ=Asia/Shanghai" spellcheck="false" autocomplete="off" />
	</Field>

	<Field id="create-restart" label={t('Restart automatically')}>
		<Select id="create-restart" name="createRestart" bind:value={form.restart} disabled={busy}>
			{#each RESTART_POLICIES as p}<option value={p}>{policyLabel(p)}</option>{/each}
		</Select>
	</Field>

	<Disclosure title={t('Advanced')} description={t('Command and privileged mode')}>
		<div class="group">
			<Field id="create-command" label={t('Command')} help={t('Replaces the image’s default command. Leave empty to keep it.')} error={fieldError('create-command')}>
				<Input id="create-command" name="createCommand" bind:value={form.command} disabled={busy} spellcheck="false" autocomplete="off"
					aria-invalid={!!fieldError('create-command')} aria-describedby={fieldError('create-command') ? 'create-command-help create-command-error' : 'create-command-help'} />
			</Field>
			<Checkbox bind:checked={form.privileged} disabled={busy}>{t('Privileged mode: full access to the device. Only for images you trust.')}</Checkbox>
		</div>
	</Disclosure>

	{#if !edit}<Checkbox bind:checked={form.start} disabled={busy}>{t('Start the container after creating it')}</Checkbox>{/if}

	<FormActions {busy} {oncancel} saveLabel={edit ? t('Save and recreate') : t('Create')} description={progress} />
</form>

<style lang="less">
	.form, .group { display: flex; flex-direction: column; gap: var(--sp-4); }
	.form { gap: var(--sp-5); }
	.rows { display: flex; flex-direction: column; gap: var(--sp-2); outline: none; }
	.rows-label { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--heading-color); }
	.row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) 6rem auto; align-items: center; gap: var(--sp-2); }
	.row.mount { grid-template-columns: minmax(0, 1.3fr) auto minmax(0, 1fr) auto auto; }
	.row.head { font-size: var(--fs-xs); color: var(--text-muted); }
	.arrow { color: var(--text-muted); }
	.hint { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
	.error { margin: 0; font-size: var(--fs-xs); color: var(--status-danger-text); }
	@container (max-width: 30rem) {
		.row, .row.mount { grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto; }
		.row > :global(:nth-child(4)) { grid-column: 1 / 4; }
		.row.head { display: none; }
	}
</style>
