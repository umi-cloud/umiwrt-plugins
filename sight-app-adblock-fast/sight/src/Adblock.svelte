<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, client, useEditor, activity, uci, pending, saveFlow, fmtBytes, Card, StatusHero, SettingRow, Switch, Button, Checkbox, Field, DynamicList, FormActions, ErrorSummary, Feedback, Select, Input, Badge, Dialog, RadioGroup, Icon } from '@sight/sdk';
	import { createAdblock, validate, validTime, validateList, newList, listUsage, DOMAIN, MESSAGES } from './service.js';

	/* 广告过滤：状态卡（开关、拦截条目数、问题、立即更新、限时暂停）、域名检查、拦截列表（含自加列表）、自定义域名与强制 DNS。
	   列表、域名与设置一起保存并带回滚应用；开关应用确认后再启用并启动（或停止并停用）服务。 */
	const svc = createAdblock(client, uci);
	const POLL_MS = 3000;
	let data = $state(undefined);   // undefined 读取中，null 未安装
	let form = $state(null), baseline = $state('');
	let error = $state(''), errors = $state([]), summary = $state(), busy = $state(false);
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
				const next = { forceDns: d.config.forceDns, lists: d.config.lists, blocked: d.config.blocked, allowed: d.config.allowed };
				if (!dirty) form = structuredClone(next);
				baseline = JSON.stringify(next);
				/* 下载、处理拦截表期间定时回读状态；暂停中到时（最迟 30 秒）回读 */
				if (d.status.paused) timer = setTimeout(load, Math.min(30000, d.status.remaining * 1000 + POLL_MS));
				else if (d.status.state === 'working') timer = setTimeout(load, POLL_MS);
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

	const stateText = s => s.paused ? t('Paused, turns back on in %d min', Math.max(1, Math.ceil(s.remaining / 60)))
		: ({ running: t('Blocking %d domains', s.entries), stopped: t('Off'), failed: t('Not blocking'), working: t('Updating block-lists…') }[s.state]);
	const tone = s => s.paused ? 'warning' : ({ running: 'success', stopped: 'muted', failed: 'warning', working: 'accent' }[s.state]);
	const heroState = () => !data.config.enabled ? 'off' : data.status.paused ? 'paused' : data.status.state;
	const problemText = p => MESSAGES[p.code] ? t(MESSAGES[p.code], p.info) : (p.info ? `${p.code}: ${p.info}` : p.code);
	/* 列表体积：不足 1 MB 时用 KB，避免显示成 0 MB */
	const sizeText = b => b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : fmtBytes(b);
	const usage = $derived(form ? listUsage(form.lists) : null);
	const tooBig = $derived(!!usage?.need && !!data?.status.memAvailable && usage.need > data.status.memAvailable);

	/* 限时暂停：网站打不开时临时关掉过滤，到时自动恢复；记住上次选的时长（仅本浏览器） */
	const PAUSE_OPTIONS = [5, 15, 30, 60, 120];
	const PAUSE_KEY = 'sight-adblock-pause';
	const storedPause = () => { try { return Number(localStorage.getItem(PAUSE_KEY)); } catch { return 0; } };
	let pauseMinutes = $state(PAUSE_OPTIONS.includes(storedPause()) ? storedPause() : 15);
	const pauseLabel = m => m < 60 ? t('%d min', m) : t('%d h', m / 60);
	/* 操作结果由状态行体现（正在更新、已暂停…），不另给成功提示 */
	async function runAction(action) {
		busy = true; error = '';
		try { await action(); }
		catch (e) { if (alive) error = errorText(e); }
		finally { if (alive) { busy = false; await load(); } }
	}
	function pause() {
		try { localStorage.setItem(PAUSE_KEY, String(pauseMinutes)); } catch { /* 记不住只影响下次的默认值 */ }
		return runAction(() => svc.pause(pauseMinutes));
	}
	const resumeNow = () => runAction(() => svc.resumeNow());

	/* 域名检查：查当前生效的拦截表，可顺手把结果加进自定义规则（随表单保存） */
	let checkDomain = $state(''), checkError = $state(''), checkResult = $state(null), checkBusy = $state(false);
	async function check(event) {
		event.preventDefault();
		const domain = checkDomain.trim().toLowerCase().replace(/\.$/, '');
		checkResult = null;
		checkError = DOMAIN.test(domain) && !domain.startsWith('*.') ? '' : t('Enter a domain like ads.example.com');
		if (checkError || checkBusy) return;
		checkBusy = true;
		try {
			const r = await svc.check(domain);
			if (alive) checkResult = { domain, blocked: !!r.blocked, match: r.match || null };
		} catch (e) {
			if (alive) checkResult = { domain, error: e?.status === 5 ? t('No block-list is loaded right now, so nothing is blocked.') : errorText(e) };
		} finally { if (alive) checkBusy = false; }
	}
	const checkText = r => r.blocked
		? (r.match === r.domain ? t('%s is blocked.', r.domain) : t('%s is blocked because %s is on the block-list.', r.domain, r.match))
		: (r.match ? t('%s is not blocked: %s is on the allow list.', r.domain, r.match) : t('%s is not blocked.', r.domain));
	/* 拦截了就给「始终放行」，没拦截就给「始终拦截」；已在对应规则里则不再提供 */
	const checkTarget = r => r.blocked ? 'allowed' : 'blocked';
	function addRule(r) {
		const key = checkTarget(r);
		if (!form[key].includes(r.domain)) form[key] = [...form[key], r.domain];
	}

	/* 新加列表：在对话框里填写，加进表单后随保存写入 */
	let adding = $state(null), addErrors = $state({});
	const openAdd = () => { adding = { url: '', name: '', action: 'block' }; addErrors = {}; };
	function addList(event) {
		event?.preventDefault();
		addErrors = validateList(adding, form.lists);
		if (Object.keys(addErrors).length) return;
		form.lists = [...form.lists, newList(adding)];
		adding = null;
	}
	const removeList = l => { form.lists = form.lists.filter(x => x !== l); };
	const listKey = l => l.section || `new:${l.url}`;

	async function toggle(on) {
		if (locked) return;
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

	const update = () => runAction(() => svc.update());

	async function save(event) {
		event.preventDefault();
		if (locked) return;
		errors = validate(form).map(m => ({ text: t(m), field: 'adblock-blocked' }));
		if (errors.length) { await tick(); summary?.focus(); return; }
		const paused = data.status.paused;
		const ok = await saveFlow(() => svc.save(data.config, form), {
			busy: v => { busy = v; if (v) error = ''; },
			fail: e => { error = errorText(e); },
			alive: () => alive,
		});
		/* 正常运行时 adblock-fast 已注册配置触发器，应用后由 procd 自行重载；启动失败（如此前没有任何列表）时
		   没有触发器，须主动重启。两种情况只取其一，避免两次运行重叠 */
		if (!ok || !alive || pending.phase !== 'confirmed' || !data.config.enabled) return;
		/* 暂停中保存：取消暂停后按新配置重新生成 */
		if (paused) await runAction(async () => { await svc.resume(); await svc.update(); });
		else if (data.status.state !== 'running') await update();
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
				hint={t('Blocks ads and trackers for every device that uses the router for DNS.')} data-state={heroState()}>
				{#snippet actions()}
					<Switch checked={data.config.enabled} disabled={locked} aria-label={t('Ad blocking')} onchange={toggle} />
				{/snippet}
			</StatusHero>
			{#if data.config.enabled && !data.status.paused && data.status.problems.length}
				<ul class="problems">
					{#each data.status.problems as p}<li data-tone={p.tone}><Feedback tone={p.tone === 'error' ? 'error' : 'info'} message={problemText(p)} compact /></li>{/each}
				</ul>
			{/if}
			{#if data.config.enabled}
				<div class="row-actions">
					{#if data.status.paused}
						<Button size="compact" variant="primary" disabled={locked} onclick={resumeNow}>{t('Turn back on now')}</Button>
					{:else}
						<Button size="compact" disabled={locked || data.status.state === 'working'} onclick={update}>{t('Update now')}</Button>
						{#if data.status.state === 'running'}
							<span class="pause" data-adblock="pause">
								<label class="muted" for="adblock-pause-minutes">{t('Pause for')}</label>
								<Select id="adblock-pause-minutes" size="compact" bind:value={pauseMinutes} disabled={locked}>
									{#each PAUSE_OPTIONS as m}<option value={m}>{pauseLabel(m)}</option>{/each}
								</Select>
								<Button size="compact" disabled={locked} onclick={pause}>{t('Pause')}</Button>
							</span>
						{/if}
					{/if}
				</div>
			{/if}
		</Card>

		{#if data.config.enabled}
			<Card icon="diagnostics" title={t('Check a domain')} name="adblock-check">
				<form class="check" onsubmit={check} aria-label={t('Check a domain')}>
					<p class="muted">{t('See whether a site is blocked, for example when it stops loading. Checks the block-list in use now.')}</p>
					<div class="check-row">
						<Field id="adblock-check-domain" label={t('Domain')} error={checkError}>
							<Input id="adblock-check-domain" bind:value={checkDomain} placeholder="ads.example.com" autocomplete="off" spellcheck="false"
								aria-invalid={!!checkError} aria-describedby={checkError ? 'adblock-check-domain-error' : undefined} />
						</Field>
						<Button type="submit" disabled={checkBusy}>{t('Check')}</Button>
					</div>
					{#if checkResult}
						<div class="check-result" data-result={checkResult.error ? 'error' : checkResult.blocked ? 'blocked' : 'allowed'}>
							{#if checkResult.error}
								<Feedback tone="info" message={checkResult.error} compact />
							{:else}
								<Feedback tone="info" message={checkText(checkResult)} compact />
								{#if form[checkTarget(checkResult)].includes(checkResult.domain)}
									<p class="muted">{t('Added to your rules. Save the settings below to apply.')}</p>
								{:else}
									<Button size="compact" disabled={locked} onclick={() => addRule(checkResult)}>{checkResult.blocked ? t('Never block %s', checkResult.domain) : t('Always block %s', checkResult.domain)}</Button>
								{/if}
							{/if}
						</div>
					{/if}
				</form>
			</Card>
		{/if}

		<form class="stack" onsubmit={save} aria-label={t('Ad blocking settings')}>
			<ErrorSummary {errors} bind:this={summary} />
			<Card icon="logs" title={t('Block-lists')}>
				{#snippet actions()}<Button size="compact" disabled={locked} onclick={openAdd}>{t('Add list')}</Button>{/snippet}
				<p class="muted">{t('Turn on one or two lists. Larger lists block more but need more memory.')}</p>
				{#if usage.count}
					<p class="muted usage" data-adblock="usage">
						{usage.total ? t('%d on, %s in total.', usage.count, sizeText(usage.total)) : t('%d on.', usage.count)}
						{#if usage.need && data.status.memAvailable}{t('Updating needs about %s of memory; %s is free.', fmtBytes(usage.need), fmtBytes(data.status.memAvailable))}{/if}
						{#if usage.unknown}{t('Lists not downloaded yet are not counted.')}{/if}
					</p>
					{#if tooBig}<Feedback tone="error" message={t('The router may not have enough memory for these lists. Turn off a large list.')} compact />{/if}
				{/if}
				<ul class="lists">
					{#each form.lists as l (listKey(l))}
						<li data-list={l.section || 'new'}>
							<Checkbox bind:checked={l.enabled} disabled={locked}>
								<span class="list-name">{l.name}</span>
								{#if l.size}<span class="muted meta">{sizeText(l.size)}</span>{/if}
							</Checkbox>
							{#if l.action === 'allow'}<Badge tone="success">{t('Allow list')}</Badge>{/if}
							{#if !l.section}<Badge tone="info">{t('New')}</Badge>{/if}
							<button type="button" class="remove" disabled={locked} aria-label={t('Remove %s', l.name)} title={t('Remove')} onclick={() => removeList(l)}><Icon name="close" /></button>
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

		{#if adding}
			<Dialog open title={t('Add a list')} confirmLabel={t('Add')} cancelLabel={t('Cancel')} onconfirm={addList} onclose={() => adding = null}>
				<form class="add" onsubmit={addList} aria-label={t('Add a list')}>
					<p class="muted">{t('Use a list of domains, one per line, or a hosts file. The list is downloaded when you save.')}</p>
					<Field id="adblock-list-url" label={t('Address')} error={t(addErrors.url || '')}>
						<Input id="adblock-list-url" type="url" bind:value={adding.url} placeholder="https://example.com/list.txt" autocomplete="off" spellcheck="false"
							aria-invalid={!!addErrors.url} aria-describedby={addErrors.url ? 'adblock-list-url-error' : undefined} />
					</Field>
					<Field id="adblock-list-name" label={t('Name (optional)')} error={t(addErrors.name || '')}>
						<Input id="adblock-list-name" bind:value={adding.name} autocomplete="off" aria-invalid={!!addErrors.name} />
					</Field>
					<RadioGroup name="adblock-list-action" label={t('Type')} bind:value={adding.action}
						options={[{ value: 'block', label: t('Block these domains') }, { value: 'allow', label: t('Never block these domains') }]} />
				</form>
			</Dialog>
		{/if}
	{/if}
</div>

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-4); }
	.problems { list-style: none; margin: var(--sp-3) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
	.row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); }
	.pause { display: inline-flex; align-items: center; gap: var(--sp-2); margin-left: var(--sp-2); }
	.check, .add { display: flex; flex-direction: column; gap: var(--sp-4); }
	.check-row { display: flex; align-items: flex-end; gap: var(--sp-2); }
	.check-row > :global(:first-child) { flex: 1 1 auto; max-width: 28rem; }
	.check-result { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
	.usage { margin-top: var(--sp-2); }
	.lists { list-style: none; margin: var(--sp-3) 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: var(--sp-2) var(--sp-4); }
	.lists li { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
	.lists li > :global(:first-child) { flex: 0 1 auto; min-width: 0; }
	.remove {
		display: inline-flex; align-items: center; justify-content: center; margin-left: auto; flex: 0 0 auto;
		width: 2rem; height: 2rem; padding: 0; border: 0; border-radius: var(--radius-lg); background: transparent; cursor: pointer;
		--icon-size: 1rem; --icon-color: var(--text-muted);
		&:hover:not(:disabled) { background: var(--surface-muted); --icon-color: var(--heading-color); }
		&:focus-visible { outline: none; box-shadow: var(--focus-ring); }
		&:disabled { cursor: default; opacity: .5; }
	}
	.list-name { color: var(--heading-color); }
	.fields { display: flex; flex-direction: column; gap: var(--sp-4); margin-bottom: var(--sp-4); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	.meta { margin-left: var(--sp-2); font-size: var(--fs-xs); }
	.sched { display: flex; flex-direction: column; gap: var(--sp-4); }
	.sched-fields { display: flex; flex-wrap: wrap; gap: var(--sp-4); }
	.sched-fields > :global(*) { flex: 1 1 12rem; }
</style>
