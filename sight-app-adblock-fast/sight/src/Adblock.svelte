<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, client, useEditor, activity, uci, pending, saveFlow, fmtBytes, Card, StatusHero, SettingRow, Switch, Button, Checkbox, Field, DynamicList, FormActions, ErrorSummary, Feedback, Select, Input } from '@sight/sdk';
	import { createAdblock, validate, validTime, MESSAGES } from './service.js';

	/* 广告过滤：状态卡（开关、拦截条目数、问题、立即更新）、拦截列表、自定义域名与强制 DNS。
	   列表、域名与设置一起保存并带回滚应用；开关应用确认后再启用并启动（或停止并停用）服务。 */
	const svc = createAdblock(client, uci);
	const POLL_MS = 3000;
	let data = $state(undefined);   // undefined 读取中，null 未安装
	let form = $state(null), baseline = $state('');
	let error = $state(''), notice = $state(null), errors = $state([]), summary = $state(), busy = $state(false);
	const locked = $derived(busy || activity.busy);
	const dirty = $derived(!!form && JSON.stringify(form) !== baseline);
	useEditor(() => ({ dirty, busy }));
	let alive = true, version = 0, timer;
	onDestroy(() => { alive = false; version++; clearTimeout(timer); });

	async function load() {
		const request = ++version;
		clearTimeout(timer);
		error = '';
		try {
			const d = await svc.load();
			if (!alive || request !== version) return;
			data = d;
			if (d) {
				const next = { forceDns: d.config.forceDns, lists: d.config.lists.map(l => ({ section: l.section, enabled: l.enabled })), blocked: d.config.blocked, allowed: d.config.allowed };
				if (!dirty) form = structuredClone(next);
				baseline = JSON.stringify(next);
				/* 下载、处理拦截表期间定时回读状态 */
				if (d.status.state === 'working') timer = setTimeout(load, POLL_MS);
			}
		} catch (e) { if (alive && request === version) error = errorText(e); }
	}
	$effect(() => { pending.version; load(); });

	/* 自动更新：写 crontab 即时生效，不走暂存 */
	let sched = $state(null), schedBase = $state(''), schedNotice = $state(null), schedBusy = $state(false);
	const schedDirty = $derived(!!sched && JSON.stringify(sched) !== schedBase);
	const schedError = $derived(sched && sched.mode !== 'off' && sched.mode !== 'other' && !validTime(sched.time) ? t('Invalid time') : '');
	async function loadSchedule() {
		try { const s = await svc.loadSchedule(); if (alive) { sched = s; schedBase = JSON.stringify(s); } }
		catch (e) { if (alive) schedNotice = { tone: 'error', text: errorText(e) }; }
	}
	loadSchedule();
	async function saveSchedule(event) {
		event.preventDefault();
		if (schedBusy || schedError) return;
		schedBusy = true; schedNotice = null;
		try {
			await svc.saveSchedule(sched);
			if (alive) { schedBase = JSON.stringify(sched); schedNotice = { tone: 'success', text: sched.mode === 'off' ? t('Automatic updates turned off.') : t('Automatic updates saved.') }; }
		} catch (e) { if (alive) schedNotice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) schedBusy = false; }
	}
	const dayName = d => [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')][d];

	const stateText = s => ({ running: t('Blocking %d domains', s.entries), stopped: t('Off'), failed: t('Not blocking'), working: t('Updating block-lists…') }[s.state]);
	const tone = s => ({ running: 'success', stopped: 'muted', failed: 'warning', working: 'accent' }[s.state]);
	const problemText = p => MESSAGES[p.code] ? t(MESSAGES[p.code], p.info) : (p.info ? `${p.code}: ${p.info}` : p.code);
	/* 列表体积：不足 1 MB 时用 KB，避免显示成 0 MB */
	const sizeText = b => b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : fmtBytes(b);
	const listOf = section => data.config.lists.find(l => l.section === section);

	async function toggle(on) {
		if (locked) return;
		notice = null;
		const ok = await saveFlow(() => svc.setEnabled(on), {
			busy: v => { busy = v; if (v) error = ''; },
			fail: e => { error = errorText(e); },
			alive: () => alive,
		});
		if (!ok || !alive || pending.phase !== 'confirmed') return;
		busy = true;
		try { await svc.afterToggle(on); }
		catch (e) { if (alive) error = errorText(e); }
		finally { if (alive) { busy = false; await load(); } }
	}

	async function update() {
		busy = true; notice = null; error = '';
		try {
			await svc.update();
			if (alive) notice = { tone: 'success', text: t('Block-lists are being downloaded again.') };
		} catch (e) { if (alive) error = errorText(e); }
		finally { if (alive) { busy = false; await load(); } }
	}

	async function save(event) {
		event.preventDefault();
		if (locked) return;
		errors = validate(form).map(m => ({ text: t(m), field: 'adblock-blocked' }));
		if (errors.length) { await tick(); summary?.focus(); return; }
		const before = { ...data.config };
		const next = { ...form, lists: form.lists.map(l => ({ ...listOf(l.section), enabled: l.enabled })) };
		const ok = await saveFlow(() => svc.save(before, next), {
			busy: v => { busy = v; if (v) error = ''; },
			fail: e => { error = errorText(e); },
			alive: () => alive,
		});
		/* 正常运行时 adblock-fast 已注册配置触发器，应用后由 procd 自行重载；启动失败（如此前没有任何列表）时
		   没有触发器，须主动重启。两种情况只取其一，避免两次运行重叠 */
		if (ok && alive && pending.phase === 'confirmed' && data.config.enabled && data.status.state !== 'running') await update();
	}
</script>

<div class="stack">
	{#if error}<Feedback tone="error" message={error} onretry={load} />{/if}
	{#if data === undefined && !error}
		<Feedback tone="loading" message={t('Loading…')} />
	{:else if data === null}
		<Card icon="firewall" title={t('Ad blocking')}><p class="muted" data-adblock="missing">{t('adblock-fast is not installed. Reinstall sight-app-adblock-fast.')}</p></Card>
	{:else if data && form}
		<Card name="adblock">
			<StatusHero icon="firewall" tone={data.config.enabled ? tone(data.status) : 'muted'} title={t('Ad blocking')}
				status={data.config.enabled ? stateText(data.status) : t('Off')}
				hint={t('Blocks ads and trackers for every device that uses the router for DNS.')} data-state={data.config.enabled ? data.status.state : 'off'}>
				{#snippet actions()}
					<Switch checked={data.config.enabled} disabled={locked} aria-label={t('Ad blocking')} onchange={toggle} />
				{/snippet}
			</StatusHero>
			{#if data.config.enabled && data.status.problems.length}
				<ul class="problems">
					{#each data.status.problems as p}<li data-tone={p.tone}><Feedback tone={p.tone === 'error' ? 'error' : 'info'} message={problemText(p)} compact /></li>{/each}
				</ul>
			{/if}
			{#if notice}<Feedback tone={notice.tone} message={notice.text} compact />{/if}
			{#if data.config.enabled}
				<div class="row-actions"><Button size="compact" disabled={locked || data.status.state === 'working'} onclick={update}>{t('Update now')}</Button></div>
			{/if}
		</Card>

		{#if sched}
			<Card icon="startup" title={t('Automatic updates')} name="adblock-schedule">
				<form class="sched" onsubmit={saveSchedule} aria-label={t('Automatic updates')}>
					<p class="muted">{t('Download the block-lists again on a schedule so new ad and tracker domains are blocked. Runs only while ad blocking is on.')}</p>
					{#if sched.mode === 'other'}
						<p class="muted" data-schedule="other">{t('A custom schedule is set: %s. Choose a new one below to replace it.', sched.line)}</p>
					{/if}
					<div class="sched-fields">
						<Field id="adblock-sched-mode" label={t('Frequency')}>
							<Select id="adblock-sched-mode" bind:value={sched.mode} disabled={schedBusy}>
								<option value="off">{t('Off')}</option>
								<option value="daily">{t('Every day')}</option>
								<option value="weekly">{t('Every week')}</option>
								{#if sched.mode === 'other'}<option value="other">{t('Custom')}</option>{/if}
							</Select>
						</Field>
						{#if sched.mode === 'weekly'}
							<Field id="adblock-sched-day" label={t('Day')}>
								<Select id="adblock-sched-day" bind:value={sched.day} disabled={schedBusy}>
									{#each [1, 2, 3, 4, 5, 6, 0] as d}<option value={d}>{dayName(d)}</option>{/each}
								</Select>
							</Field>
						{/if}
						{#if sched.mode === 'daily' || sched.mode === 'weekly'}
							<Field id="adblock-sched-time" label={t('Time')} error={schedError}>
								<Input id="adblock-sched-time" type="time" bind:value={sched.time} disabled={schedBusy} />
							</Field>
						{/if}
					</div>
					{#if schedNotice}<Feedback tone={schedNotice.tone} message={schedNotice.text} compact />{/if}
					<FormActions busy={schedBusy} disabled={!schedDirty || !!schedError || sched.mode === 'other'} description={t('Takes effect immediately after saving.')} />
				</form>
			</Card>
		{/if}

		<form class="stack" onsubmit={save} aria-label={t('Ad blocking settings')}>
			<ErrorSummary {errors} bind:this={summary} />
			<Card icon="logs" title={t('Block-lists')}>
				<p class="muted">{t('Turn on one or two lists. Larger lists block more but need more memory.')}</p>
				<ul class="lists">
					{#each form.lists as l (l.section)}
						{@const info = listOf(l.section)}
						<li data-list={l.section}>
							<Checkbox bind:checked={l.enabled} disabled={locked}>
								<span class="list-name">{info.name}</span>
								{#if info.size}<span class="muted meta">{sizeText(info.size)}</span>{/if}
							</Checkbox>
						</li>
					{/each}
				</ul>
			</Card>

			<Card icon="dns" title={t('Your own rules')}>
				<div class="fields">
					<Field id="adblock-blocked" label={t('Always block')} help={t('One domain per entry, for example ads.example.com')}>
						<DynamicList id="adblock-blocked" bind:values={form.blocked} disabled={locked} placeholder="ads.example.com" />
					</Field>
					<Field id="adblock-allowed" label={t('Never block')} help={t('Use this when a site stops working because of ad blocking.')}>
						<DynamicList id="adblock-allowed" bind:values={form.allowed} disabled={locked} placeholder="example.com" />
					</Field>
				</div>
				<SettingRow id="adblock-force" label={t('Make devices use the router’s DNS')} description={t('Redirects DNS requests that bypass the router, so ad blocking also covers devices with their own DNS settings.')}>
					<Switch id="adblock-force" checked={form.forceDns} disabled={locked} onchange={on => form.forceDns = on} aria-describedby="adblock-force-description" />
				</SettingRow>
				<FormActions busy={locked} disabled={!dirty} description={t('Changes take effect when you save. If the device becomes unreachable, they roll back automatically.')} />
			</Card>
		</form>
	{/if}
</div>

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-4); }
	.problems { list-style: none; margin: var(--sp-3) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
	.row-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }
	.lists { list-style: none; margin: var(--sp-3) 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: var(--sp-2) var(--sp-4); }
	.list-name { color: var(--heading-color); }
	.fields { display: flex; flex-direction: column; gap: var(--sp-4); margin-bottom: var(--sp-4); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	.meta { margin-left: var(--sp-2); font-size: var(--fs-xs); }
	.sched { display: flex; flex-direction: column; gap: var(--sp-4); }
	.sched-fields { display: flex; flex-wrap: wrap; gap: var(--sp-4); }
	.sched-fields > :global(*) { flex: 1 1 12rem; }
</style>
