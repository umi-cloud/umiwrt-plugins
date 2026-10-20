<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, useEditor, Button, Checkbox, Disclosure, DynamicList, ErrorSummary, Feedback, Field, FormActions, FormSection, Icon, Input, RadioGroup, Select, Textarea } from '@sight/sdk';
	import { RESTART_POLICIES } from './containers.js';
	import { isCustomNetwork, ownNetwork } from './resources.js';
	import { pullPercent } from './images.js';
	import { emptyCreate, validateCreate, createImage, imageHints, appBaseOf, LOG_LIMITS } from './create.js';
	import { parseDockerRun } from './dockerRun.js';
	import { policyLabel } from './format.js';
	import ImageSearch from './ImageSearch.svelte';

	/* 新建容器（抽屉正文）：选镜像（本机已有，或填写后先下载）→ 名称 → 网络（自定义网络可设固定地址）与端口 → 目录 → 环境变量 → 重启策略；
	   主机名、内存与 CPU 上限、设备直通、命令与特权模式收进「高级」。镜像不在本机时先经页面的后台拉取任务下载，完成后再创建。
	   edit（{ form, name }）时为修改已有容器：表单预填，保存交给 onedit 走设备端的重建任务，表单不管理的配置原样保留。
	   image：预选的本机镜像（从镜像列表新建时）；volumes：已有的命名卷（目录行可直接选）；networks：自定义网络 [{ name, subnets }]；cpus：设备 CPU 核数；timezone：路由器时区（可一键加为 TZ）；
	   dataRoot：Docker 数据目录，镜像建议的目录放在同一块盘的 appdata 下。
	   新建时可粘贴 docker run 命令填表（不支持的参数逐条说明）；选本机镜像时按镜像的 EXPOSE / VOLUME 给出端口与目录建议 */
	let { svc, images = [], image = '', names = [], networks = [], volumes = [], cpus = null, timezone = '', dataRoot = '', pullTask = null, pull, oncancel, oncreated, edit = null, onedit } = $props();
	const tags = $derived([...new Set([...images.flatMap(i => i.tags), ...(edit?.form.image ? [edit.form.image] : [])])]);
	/* 本机没有镜像时直接从「下载」开始 */
	function initial() {
		if (edit) return JSON.parse(JSON.stringify(edit.form));
		const f = emptyCreate(), first = image || images.flatMap(i => i.tags)[0];
		if (first) f.image = first; else f.source = 'pull';
		return f;
	}
	const form = $state(initial());
	const baseline = JSON.stringify(form);
	let envDraft = $state('');
	let deviceDraft = $state('');
	let capDraft = $state('');
	const formId = $props.id();
	/* 当前网络不在列表里（如 none、共用其他容器的网络）时也列出，避免编辑时被改掉 */
	const extraNetwork = $derived(edit && !['bridge', 'host', ...networks.map(n => n.name)].includes(edit.form.network) ? edit.form.network : '');
	const subnets = $derived((networks.find(n => n.name === form.network)?.subnets || []).filter(s => !s.includes(':')));
	const hasTz = $derived([...form.env, envDraft].some(e => e.trim().startsWith('TZ=')));
	let errors = $state([]);
	let errorSummary = $state();
	let busy = $state(false);
	let phase = $state('');          // pull | create
	let alive = true;
	onDestroy(() => { alive = false; });
	const dirty = $derived(JSON.stringify(form) !== baseline || !!envDraft.trim() || !!deviceDraft.trim() || !!capDraft.trim());
	/* VPN 类容器（Tailscale、ZeroTier、WireGuard 等）常用：网络管理权限 + TUN 设备 */
	const vpnReady = $derived(form.caps.includes('NET_ADMIN') && form.devices.includes('/dev/net/tun'));
	function addVpn() {
		if (!form.caps.includes('NET_ADMIN')) form.caps.push('NET_ADMIN');
		if (!form.devices.includes('/dev/net/tun')) form.devices.push('/dev/net/tun');
	}
	useEditor(() => ({ dirty, busy }));

	const fieldError = id => errors.filter(e => e.field === id).map(e => e.text).join(' ');
	const addPort = () => form.ports.push({ host: '', container: '', proto: 'tcp', ip: '' });
	const addMount = () => form.mounts.push({ host: '', container: '', readonly: false });

	/* 从 docker run 命令导入：替换整张表单（未写的项回到初值），镜像在本机就选本机，否则改为下载 */
	let importOpen = $state(false);
	let importText = $state('');
	let importError = $state('');
	let importNotes = $state(null);  // null 未导入；[] 全部识别；[{ message, args }]
	function doImport() {
		importError = '';
		try {
			const r = parseDockerRun(importText);
			const next = { ...emptyCreate(), ...r.form };
			if (tags.includes(r.image)) { next.source = 'local'; next.image = r.image; } else { next.source = 'pull'; next.pullRef = r.image; }
			Object.assign(form, next);
			envDraft = ''; deviceDraft = ''; capDraft = '';
			importNotes = r.warnings;
			importOpen = false;
		} catch (e) { importError = t(e.message); importNotes = null; }
	}

	/* 镜像建议：本机镜像自带的端口与数据目录，未填入的才列出 */
	let imageConfig = $state(null);
	$effect(() => {
		const ref = !edit && form.source === 'local' ? form.image : '';
		imageConfig = null;
		if (ref) svc.imageConfig(ref).then(c => { if (alive && form.image === ref) imageConfig = c; });
	});
	const hints = $derived(imageConfig ? imageHints(imageConfig, form, appBaseOf(dataRoot)) : { ports: [], mounts: [] });
	function useHints() {
		if (form.network !== 'host') form.ports.push(...hints.ports.map(p => ({ ...p })));
		form.mounts.push(...hints.mounts.map(m => ({ ...m })));
	}

	async function submit(e) {
		e.preventDefault();
		if (busy) return;
		if (envDraft.trim()) { form.env = [...form.env, envDraft.trim()]; envDraft = ''; }
		if (deviceDraft.trim()) { form.devices = [...form.devices, deviceDraft.trim()]; deviceDraft = ''; }
		if (capDraft.trim()) { form.caps = [...form.caps, capDraft.trim()]; capDraft = ''; }
		errors = validateCreate(form, edit ? names.filter(n => n !== edit.name) : names, { subnets, cpus })
			.map(x => ({ text: t(x.message, ...(x.args || [])), field: `create-${x.field}` }));
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

	{#if !edit}
		<Disclosure title={t('Import a docker run command')} description={t('Paste the command from the app’s instructions to fill in this form.')} bind:open={importOpen}>
			<div class="group" data-import>
				<Textarea id="create-import" bind:value={importText} rows="4" disabled={busy} placeholder="docker run -d --name app -p 8080:80 -v /mnt/data/app:/data nginx" spellcheck="false" autocomplete="off" aria-label={t('docker run command')} />
				{#if importError}<p class="error" data-import-error>{importError}</p>{/if}
				<div><Button size="compact" disabled={busy || !importText.trim()} onclick={doImport} data-action="import">{t('Fill in the form')}</Button></div>
			</div>
		</Disclosure>
		{#if importNotes}
			<div class="notes" data-import-notes>
				<Feedback tone={importNotes.length ? 'info' : 'success'} message={importNotes.length ? t('The form was filled from the command. Check these points before creating:') : t('The form was filled from the command. Check it before creating.')} compact />
				{#if importNotes.length}<ul>{#each importNotes as n}<li>{t(n.message, ...(n.args || []))}</li>{/each}</ul>{/if}
			</div>
		{/if}
	{/if}

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
				{#if hints.ports.length || hints.mounts.length}
					<div class="hints" data-image-hints>
						<span>{t('This image uses:')}
							{[...hints.ports.map(p => `${p.container}/${p.proto}`), ...hints.mounts.map(m => m.container)].join(', ')}</span>
						<Button size="compact" disabled={busy} onclick={useHints} data-action="use-hints">{t('Add them below')}</Button>
					</div>
				{/if}
			{:else}
				<ImageSearch {svc} selected={createImage(form)} disabled={busy} onpick={ref => form.pullRef = ref} />
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
					{#each networks as n}<option value={n.name}>{n.name}</option>{/each}
					{#if extraNetwork}<option value={extraNetwork}>{extraNetwork}</option>{/if}
				</Select>
			</Field>
			{#if isCustomNetwork(form.network)}
				<Field id="create-ip" label={t('Fixed IP address')} help={subnets.length ? t('Leave empty to assign one automatically. Subnet of this network: %s', subnets.join(', ')) : t('Leave empty to assign one automatically. Only works on networks created with a subnet.')} error={fieldError('create-ip')}>
					<Input id="create-ip" name="createIp" bind:value={form.ip} disabled={busy} placeholder={subnets.length ? subnets[0].replace(/\.\d+\/\d+$/, '.10') : '172.30.0.10'} spellcheck="false" autocomplete="off" inputmode="decimal"
						aria-invalid={!!fieldError('create-ip')} aria-describedby={fieldError('create-ip') ? 'create-ip-help create-ip-error' : 'create-ip-help'} />
				</Field>
			{/if}
			{#if form.network === 'host'}
				<p class="hint">{t('The container uses the device ports directly. Make sure they are not used by other services.')}</p>
			{:else}
				<div class="rows" id="create-ports" tabindex="-1" role="group" aria-label={t('Port mappings')}>
					<span class="rows-label">{t('Port mappings')}</span>
					{#if form.ports.length}<div class="row head" aria-hidden="true"><span>{t('Device port')}</span><span></span><span>{t('Container port')}</span><span></span><span>{t('Reachable from')}</span><span></span></div>{/if}
					{#each form.ports as p, i}
						<div class="row" data-port-row>
							<Input bind:value={p.host} disabled={busy} inputmode="numeric" placeholder="8080" aria-label={t('Device port')} />
							<span class="arrow" aria-hidden="true">→</span>
							<Input bind:value={p.container} disabled={busy} inputmode="numeric" placeholder="80" aria-label={t('Container port')} />
							<Select bind:value={p.proto} disabled={busy} aria-label={t('Protocol')}><option value="tcp">TCP</option><option value="udp">UDP</option></Select>
							<Select bind:value={p.ip} disabled={busy} aria-label={t('Reachable from')}>
								<option value="">{t('LAN')}</option><option value="127.0.0.1">{t('This device only')}</option>
								{#if p.ip && p.ip !== '127.0.0.1'}<option value={p.ip}>{p.ip}</option>{/if}
							</Select>
							<Button variant="ghost" disabled={busy} aria-label={t('Remove')} onclick={() => form.ports.splice(i, 1)}><Icon name="close" /></Button>
						</div>
					{/each}
					{#if fieldError('create-ports')}<p class="error">{fieldError('create-ports')}</p>{/if}
					<div><Button size="compact" disabled={busy} onclick={addPort}>{t('Add port')}</Button></div>
				</div>
			{/if}
		</div>
	</FormSection>

	<FormSection title={t('Folders')} description={t('Share a folder on the device (missing folders are created), or keep data in a Docker volume by entering a volume name.')}>
		<datalist id={`${formId}-volumes`}>{#each volumes as v}<option value={v}></option>{/each}</datalist>
		<div class="rows" id="create-mounts" tabindex="-1" role="group" aria-label={t('Folders')}>
			{#if form.mounts.length}<div class="row mount head" aria-hidden="true"><span>{t('Folder on device or volume')}</span><span></span><span>{t('Path in container')}</span><span></span><span></span></div>{/if}
			{#each form.mounts as m, i}
				<div class="row mount" data-mount-row>
					<Input bind:value={m.host} disabled={busy} placeholder="/mnt/data/app" spellcheck="false" list={`${formId}-volumes`} aria-label={t('Folder on device or volume')} />
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
	{#if timezone && !hasTz}
		<div><Button size="compact" disabled={busy} onclick={() => form.env.push(`TZ=${timezone}`)} data-action="add-tz">{t('Use the router’s time zone (%s)', timezone)}</Button></div>
	{/if}

	<Field id="create-restart" label={t('Restart automatically')}>
		<Select id="create-restart" name="createRestart" bind:value={form.restart} disabled={busy}>
			{#each RESTART_POLICIES as p}<option value={p}>{policyLabel(p)}</option>{/each}
		</Select>
	</Field>

	<Field id="create-log" label={t('Log size limit')} help={t('Old log lines are dropped when the limit is reached, so logs cannot fill up the storage.')}>
		<Select id="create-log" name="createLog" bind:value={form.log} disabled={busy}>
			{#each LOG_LIMITS as o, i}<option value={o.value}>{i ? t('Up to about %d MB', o.total) : t('Up to about %d MB (recommended)', o.total)}</option>{/each}
			<option value="">{t('No limit')}</option>
			{#if form.log === 'custom'}<option value="custom">{t('Keep the current setting')}</option>{/if}
		</Select>
	</Field>

	<Disclosure title={t('Advanced')} description={t('Hostname, resource limits, permissions, devices, command and privileged mode')}>
		<div class="group">
			{#if ownNetwork(form.network)}
				<Field id="create-hostname" label={t('Hostname')} help={t('Leave empty to use the container ID.')} error={fieldError('create-hostname')}>
					<Input id="create-hostname" name="createHostname" bind:value={form.hostname} disabled={busy} spellcheck="false" autocomplete="off"
						aria-invalid={!!fieldError('create-hostname')} aria-describedby={fieldError('create-hostname') ? 'create-hostname-help create-hostname-error' : 'create-hostname-help'} />
				</Field>
			{/if}
			<div class="pair">
				<Field id="create-memory" label={t('Memory limit (MB)')} help={t('Leave empty for no limit.')} error={fieldError('create-memory')}>
					<Input id="create-memory" name="createMemory" bind:value={form.memory} disabled={busy} inputmode="numeric" placeholder="512" autocomplete="off"
						aria-invalid={!!fieldError('create-memory')} aria-describedby={fieldError('create-memory') ? 'create-memory-help create-memory-error' : 'create-memory-help'} />
				</Field>
				<Field id="create-cpus" label={t('CPU limit (cores)')} help={cpus ? t('Leave empty for no limit. This device has %d cores.', cpus) : t('Leave empty for no limit.')} error={fieldError('create-cpus')}>
					<Input id="create-cpus" name="createCpus" bind:value={form.cpus} disabled={busy} inputmode="decimal" placeholder="1.5" autocomplete="off"
						aria-invalid={!!fieldError('create-cpus')} aria-describedby={fieldError('create-cpus') ? 'create-cpus-help create-cpus-error' : 'create-cpus-help'} />
				</Field>
			</div>
			<Field id="create-caps" label={t('Extra permissions')} help={t('Linux capabilities such as NET_ADMIN. Safer than privileged mode when a container only needs a few permissions.')} error={fieldError('create-caps')}>
				<DynamicList id="create-caps" bind:values={form.caps} bind:draft={capDraft} disabled={busy} placeholder="NET_ADMIN" spellcheck="false" autocomplete="off" />
			</Field>
			{#if !vpnReady}<div><Button size="compact" disabled={busy} onclick={addVpn} data-action="add-vpn">{t('Add what VPN containers need (NET_ADMIN and /dev/net/tun)')}</Button></div>{/if}
			<Field id="create-devices" label={t('Devices')} help={t('Give the container access to a device, for example /dev/dri for video decoding or /dev/ttyUSB0 for a USB dongle. Write /dev/a:/dev/b to use another path inside the container.')} error={fieldError('create-devices')}>
				<DynamicList id="create-devices" bind:values={form.devices} bind:draft={deviceDraft} disabled={busy} placeholder="/dev/dri" spellcheck="false" autocomplete="off" />
			</Field>
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
	.row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) 5.5rem 7.5rem auto; align-items: center; gap: var(--sp-2); }
	.row.mount { grid-template-columns: minmax(0, 1.3fr) auto minmax(0, 1fr) auto auto; }
	.pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
	.row.head { font-size: var(--fs-xs); color: var(--text-muted); }
	.arrow { color: var(--text-muted); }
	.hint { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
	.hints { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
	.notes { display: flex; flex-direction: column; gap: var(--sp-2); }
	.notes ul { margin: 0; padding-left: var(--sp-5); font-size: var(--fs-sm); color: var(--text-muted); }
	.error { margin: 0; font-size: var(--fs-xs); color: var(--status-danger-text); }
	@container (max-width: 30rem) {
		.row, .row.mount { grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto; }
		/* 端口行：协议与监听地址换到第二行；目录行：只读勾选占满第二行 */
		.row:not(.mount) > :global(:nth-child(4)) { grid-column: 1 / 2; }
		.row:not(.mount) > :global(:nth-child(5)) { grid-column: 2 / 4; }
		.row.mount > :global(:nth-child(4)) { grid-column: 1 / 4; }
		.row.head { display: none; }
		.pair { grid-template-columns: minmax(0, 1fr); }
	}
</style>
