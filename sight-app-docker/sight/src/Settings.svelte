<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, useEditor, activity, pending, saveFlow, Button, Callout, Card, Dialog, DynamicList, ErrorSummary, Feedback, FormActions, Input, SettingRow, SettingsGroup } from '@sight/sdk';
	import { fmtBytes } from '@sight/sdk/lib';
	import { validateSettings, pendingRestart, sameDir, diskOf, DEFAULT_DATA_ROOT, MIRROR_PRESETS } from './service.js';

	/* Docker 设置（dockerd 的 uci globals 段）：镜像加速与数据目录。保存即生效：写入会话暂存后带回滚应用，
	   dockerd 的 reload 重读镜像加速，但不换数据目录、也不清掉全部删除的加速地址；运行值与配置不一致时提示重启。 */
	let { svc, root = '', mirrors = [], onreload } = $props();
	let base = $state(null);
	let draft = $state(null);
	let mirrorDraft = $state('');
	let loadError = $state('');
	let errors = $state([]);
	let errorSummary = $state();
	let busy = $state(false);
	let restarting = $state(false);
	let confirmRestart = $state(false);
	let restartError = $state('');
	let alive = true, version = 0;
	onDestroy(() => { alive = false; version++; });
	const locked = $derived(busy || restarting || activity.busy);
	const dirty = $derived(!!draft && (JSON.stringify(draft) !== JSON.stringify({ mirrors: base.mirrors, dataRoot: base.dataRoot }) || !!mirrorDraft.trim()));
	useEditor(() => ({ dirty, busy: busy || restarting }));

	async function load() {
		const request = ++version;
		loadError = '';
		try {
			const s = await svc.loadSettings();
			if (alive && request === version) { base = s; draft = { mirrors: [...s.mirrors], dataRoot: s.dataRoot }; mirrorDraft = ''; errors = []; }
		} catch (e) { if (alive && request === version) loadError = errorText(e); }
	}
	$effect(() => { pending.version; load(); });

	/* 数据盘建议：列出可放 Docker 数据的已挂载盘，一键填入 <挂载点>/docker；数据目录不在任何数据盘上时提示 */
	let disks = $state(null);
	svc.loadDisks().then(d => { if (alive) disks = d; });
	const size = b => b >= 1099511627776 ? (b / 1099511627776).toFixed(1) + ' TB' : fmtBytes(b);
	const draftDisk = $derived(disks && draft ? diskOf(draft.dataRoot.trim(), disks.usable) : null);
	function useDisk(d) { if (!locked) draft.dataRoot = d.mount.replace(/\/+$/, '') + '/docker'; }

	const configuredRoot = $derived(base ? base.dataRoot || DEFAULT_DATA_ROOT : '');
	const rootChanged = $derived(!!draft && !sameDir(draft.dataRoot.trim() || DEFAULT_DATA_ROOT, root));
	const restart = $derived(base ? pendingRestart(base, { root, mirrors }) : []);
	const restartText = $derived(restart.includes('data-root') ? t('Docker is still using %s. Restart Docker to switch to %s.', root, configuredRoot)
		: t('Docker is still using the previous registry mirrors. Restart Docker to apply the change.'));
	const fieldError = id => errors.filter(e => e.field === id).map(e => e.text).join(' ');

	/* 国内镜像加速：未配置时一键填入预设并保存（同样走暂存 + 保存即生效）；已有地址时可逐个加入 */
	const presetsMissing = $derived(draft ? MIRROR_PRESETS.filter(m => !draft.mirrors.includes(m.url)) : []);
	function addPreset(url) { if (!locked && !draft.mirrors.includes(url)) draft.mirrors = [...draft.mirrors, url]; }
	function usePresets() {
		if (!draft || locked) return;
		draft.mirrors = [...draft.mirrors, ...presetsMissing.map(m => m.url)];
		save();
	}

	async function save(e) {
		e?.preventDefault();
		if (!draft || locked) return;
		if (mirrorDraft.trim()) { draft.mirrors = [...draft.mirrors, mirrorDraft.trim()]; mirrorDraft = ''; }
		errors = validateSettings(draft).map(x => ({ text: t(x.message), field: `docker-${x.field}` }));
		if (errors.length) { await tick(); errorSummary?.focus(); return; }
		const next = $state.snapshot(draft), current = $state.snapshot(base);
		const ok = await saveFlow(() => svc.saveSettings(current, next), {
			busy: on => { busy = on; },
			fail: async err => { errors = [{ text: errorText(err) }]; await tick(); errorSummary?.focus(); },
			done: load,
			alive: () => alive,
		});
		if (ok && alive) await recheck();
	}
	/* 应用后 dockerd 由 procd 异步 reload：重读运行值，几秒内仍不一致才提示重启 */
	let checking = $state(false);
	async function recheck() {
		checking = true;
		try {
			for (let i = 0; i < 5 && alive; i++) {
				await onreload?.();
				if (!restart.length) break;
				await new Promise(done => setTimeout(done, 1000));
			}
		} finally { if (alive) checking = false; }
	}
	function reset() { if (!base || locked) return; draft = { mirrors: [...base.mirrors], dataRoot: base.dataRoot }; mirrorDraft = ''; errors = []; }

	async function restartDocker() {
		if (locked) return;
		restarting = true; restartError = '';
		try { await svc.restartService(); }
		catch (e) { if (alive) restartError = errorText(e); }
		finally { if (alive) { restarting = false; confirmRestart = false; await onreload?.(); } }
	}
</script>

<Dialog open={confirmRestart} tone="danger" busy={restarting} title={t('Restart Docker?')} confirmLabel={t('Restart')} cancelLabel={t('Cancel')}
	onconfirm={restartDocker} onclose={() => { if (!restarting) confirmRestart = false; }}>
	{restart.includes('data-root') ? t('All containers stop. Containers with a restart policy start again in the new data directory if their images are there.') : t('All containers stop briefly. Containers set to restart automatically start again.')}
</Dialog>

<Card name="docker-settings">
	{#if loadError}<Feedback tone="error" message={loadError} onretry={load} />
	{:else if !draft}<Feedback tone="loading" message={t('Loading…')} />
	{:else}
		<form class="form" onsubmit={save} aria-label={t('Docker settings')} data-docker-settings>
			<ErrorSummary {errors} bind:this={errorSummary} />
			{#if restart.length && !checking}
				<Callout tone="warning" message={restartText} data-restart-needed>
					<Button size="compact" disabled={locked} onclick={() => confirmRestart = true}>{restarting ? t('Restarting…') : t('Restart Docker')}</Button>
				</Callout>
			{/if}
			{#if restartError}<Feedback tone="error" message={restartError} compact />{/if}
			{#if !base.mirrors.length && !draft.mirrors.length}
				<Callout tone="warning" message={t('No registry mirror is set. In mainland China, downloads from Docker Hub are often slow or fail.')} data-mirror-suggest>
					<Button size="compact" variant="primary" disabled={locked} onclick={usePresets} data-action="use-mirrors">{t('Use mirrors in China')}</Button>
				</Callout>
			{/if}
			<SettingsGroup title={t('Downloads')}>
				<SettingRow id="docker-mirrors" label={t('Registry mirrors')} description={t('Images from Docker Hub are downloaded through these addresses first. Takes effect without restarting containers.')} error={fieldError('docker-mirrors')}>
					<div class="mirrors">
						<DynamicList id="docker-mirrors" bind:values={draft.mirrors} bind:draft={mirrorDraft} disabled={locked} placeholder="https://mirror.example.com" spellcheck="false" autocomplete="off" aria-label={t('Registry mirrors')} />
						{#if presetsMissing.length}
							<div class="presets" data-mirror-presets>
								<span class="muted">{t('Suggested in China:')}</span>
								{#each presetsMissing as m}<Button size="compact" disabled={locked} title={m.url} onclick={() => addPreset(m.url)}>{t('Add %s (%s)', m.url.replace(/^https:\/\//, ''), m.source)}</Button>{/each}
							</div>
						{/if}
						<p class="muted">{t('Public mirrors are run by third parties and may stop working at any time. If downloads fail, try another mirror or remove them.')}</p>
					</div>
				</SettingRow>
			</SettingsGroup>
			<SettingsGroup title={t('Storage')}>
				<SettingRow id="docker-data-root" label={t('Data directory')} description={t('Where images, containers and volumes are stored. Use a disk with enough space.')} error={fieldError('docker-data-root')}>
					<Input id="docker-data-root" name="dockerDataRoot" bind:value={draft.dataRoot} disabled={locked} placeholder={DEFAULT_DATA_ROOT} spellcheck="false" autocomplete="off"
						aria-describedby="docker-data-root-description" aria-invalid={!!fieldError('docker-data-root')} />
				</SettingRow>
				{#if disks?.usable.length}
					<div class="disks" data-docker-disks>
						{#each disks.usable as d (d.mount)}
							<Button size="compact" disabled={locked || draftDisk?.mount === d.mount} onclick={() => useDisk(d)} data-disk={d.mount}>{t('Use %s (%s free)', d.title, size(d.free))}</Button>
						{/each}
					</div>
					{#if !draftDisk}<Callout tone="warning" message={t('The data directory is on the router’s internal storage, which is small. Use one of the disks above.')} />{/if}
				{:else if disks?.unsupported.length}
					<p class="muted" data-docker-disks="unsupported">{t('Disks formatted as %s cannot hold Docker data. Format one as ext4 on the Storage page.', [...new Set(disks.unsupported.map(d => d.fstype))].join(', '))} <a href="#/storage">{t('Open Storage')}</a></p>
				{/if}
				{#if rootChanged && draft.dataRoot.trim() !== base.dataRoot}
					<Callout tone="warning" message={t('After the change and a restart of Docker, existing images and containers are no longer shown. They stay in %s and come back if you switch back.', root)} />
				{/if}
			</SettingsGroup>
			<FormActions busy={locked} disabled={!dirty} oncancel={reset} description={t('Changes take effect when you save. If the device becomes unreachable, they roll back automatically.')} />
		</form>
	{/if}
</Card>

<style lang="less">
	.form { display: flex; flex-direction: column; gap: var(--sp-5); }
	.mirrors { display: flex; flex-direction: column; gap: var(--sp-2); }
	.presets, .disks { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); }
</style>
