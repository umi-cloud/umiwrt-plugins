<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, client, useEditor, activity, uci, pending, saveFlow, fmtBytes, Card, StatusHero, SettingRow, Switch, Button, Checkbox, Field, DynamicList, FormActions, ErrorSummary, Feedback, Select, Input, Badge, Dialog, RadioGroup, Icon } from '@sight/sdk';
	import { createAdblock, validate, validateList, newList, listUsage, MESSAGES } from './service.js';
	import DomainCheck from './DomainCheck.svelte';
	import Schedule from './Schedule.svelte';

	/* 广告过滤：状态卡（开关、拦截条目数、问题、立即更新、限时暂停）、域名检查、拦截列表（含自加列表）、自定义域名与强制 DNS、自动更新。
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

	const STATE_TONES = { running: 'success', stopped: 'muted', failed: 'warning', working: 'accent' };
	const stateText = s => s.paused ? t('Paused, turns back on in %d min', Math.max(1, Math.ceil(s.remaining / 60)))
		: ({ running: t('Blocking %d domains', s.entries), stopped: t('Off'), failed: t('Not blocking'), working: t('Updating block-lists…') }[s.state]);
	const heroTone = () => !data.config.enabled ? 'muted' : data.status.paused ? 'warning' : STATE_TONES[data.status.state];
	const heroState = () => !data.config.enabled ? 'off' : data.status.paused ? 'paused' : data.status.state;
	const problemText = p => MESSAGES[p.code] ? t(MESSAGES[p.code], p.info) : (p.info ? `${p.code}: ${p.info}` : p.code);
	/* 列表体积：不足 1 MB 时用 KB，避免显示成 0 MB */
	const sizeText = b => b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : fmtBytes(b);
	const usage = $derived(form ? listUsage(form.lists) : null);
	const tooBig = $derived(!!usage?.need && !!data?.status.memAvailable && usage.need > data.status.memAvailable);

	/* 服务操作：结果由状态行体现（正在更新、已暂停…），不另给成功提示；结束后回读状态 */
	async function runAction(action) {
		busy = true; error = '';
		try { await action(); }
		catch (e) { if (alive) error = errorText(e); }
		finally { if (alive) { busy = false; await load(); } }
	}
	const update = () => runAction(() => svc.update());
	const resumeNow = () => runAction(() => svc.resumeNow());

	/* 限时暂停：网站打不开时临时关掉过滤，到时自动恢复；记住上次选的时长（仅本浏览器） */
	const PAUSE_OPTIONS = [5, 15, 30, 60, 120];
	const PAUSE_KEY = 'sight-adblock-pause';
	const storedPause = (() => { try { return Number(localStorage.getItem(PAUSE_KEY)); } catch { return 0; } })();
	let pauseMinutes = $state(PAUSE_OPTIONS.includes(storedPause) ? storedPause : 15);
	const pauseLabel = m => m < 60 ? t('%d min', m) : t('%d h', m / 60);
	function pause() {
		try { localStorage.setItem(PAUSE_KEY, String(pauseMinutes)); } catch { /* 记不住只影响下次的默认值 */ }
		return runAction(() => svc.pause(pauseMinutes));
	}

	/* 域名检查给出的规则加进草稿，随表单保存 */
	function addRule(key, domain) {
		if (!form[key].includes(domain)) form[key] = [...form[key], domain];
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

	/* 写入暂存并带回滚应用，返回是否已确认生效 */
	async function apply(write) {
		const ok = await saveFlow(write, {
			busy: v => { busy = v; if (v) error = ''; },
			fail: e => { error = errorText(e); },
			alive: () => alive,
		});
		return ok && alive && pending.phase === 'confirmed';
	}

	async function toggle(on) {
		if (locked) return;
		if (await apply(() => svc.setEnabled(on))) await runAction(() => svc.afterToggle(on));
	}

	async function save(event) {
		event.preventDefault();
		if (locked) return;
		errors = validate(form).map(e => ({ ...e, text: t(e.text) }));
		if (errors.length) { await tick(); summary?.focus(); return; }
		const { paused, state } = data.status;
		if (!await apply(() => svc.save(data.config, form)) || !data.config.enabled) return;
		/* 正常运行时 adblock-fast 已注册配置触发器，应用后由 procd 自行重载；启动失败（如此前没有任何列表）时
		   没有触发器，须主动重启；暂停中先取消暂停再按新配置重新生成。只取其一，避免两次运行重叠 */
		if (paused) await runAction(async () => { await svc.resume(); await svc.update(); });
		else if (state !== 'running') await update();
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
			<StatusHero icon="firewall" tone={heroTone()} title={t('Ad blocking')}
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
				<div class="actions">
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
			<DomainCheck {svc} allowed={form.allowed} blocked={form.blocked} disabled={locked} onadd={addRule} />
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
							<Button class="remove" variant="ghost" size="compact" disabled={locked} aria-label={t('Remove %s', l.name)} title={t('Remove')} onclick={() => removeList(l)}><Icon name="close" /></Button>
						</li>
					{/each}
				</ul>
			</Card>

			<Card icon="dns" title={t('Your own rules')}>
				<div class="fields">
					<Field id="adblock-blocked" label={t('Always block')} help={t('One domain per entry, for example ads.example.com. Its subdomains are blocked too.')}>
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

		<Schedule />

		{#if adding}
			<Dialog open title={t('Add a list')} confirmLabel={t('Add')} cancelLabel={t('Cancel')} onconfirm={addList} onclose={() => adding = null}>
				<form class="add" onsubmit={addList} aria-label={t('Add a list')}>
					<p class="muted">{t('Use a list of domains, one per line, or a hosts file. The list is downloaded when you save.')}</p>
					<Field id="adblock-list-url" label={t('Address')} error={addErrors.url ? t(addErrors.url) : ''}>
						<Input id="adblock-list-url" type="url" bind:value={adding.url} placeholder="https://example.com/list.txt" autocomplete="off" spellcheck="false"
							aria-invalid={!!addErrors.url} aria-describedby={addErrors.url ? 'adblock-list-url-error' : undefined} />
					</Field>
					<Field id="adblock-list-name" label={t('Name (optional)')} error={addErrors.name ? t(addErrors.name) : ''}>
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
	.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); }
	.pause { display: inline-flex; align-items: center; gap: var(--sp-2); }
	.add { display: flex; flex-direction: column; gap: var(--sp-4); }
	.usage { margin-top: var(--sp-2); }
	.lists { list-style: none; margin: var(--sp-3) 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr)); gap: var(--sp-2) var(--sp-4); }
	.lists li { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
	.lists li > :global(:first-child) { min-width: 0; }
	.lists :global(.remove) { margin-left: auto; flex: none; --icon-size: 1rem; --icon-color: var(--text-muted); }
	.list-name { color: var(--heading-color); }
	.meta { margin-left: var(--sp-2); font-size: var(--fs-xs); }
	.fields { display: flex; flex-direction: column; gap: var(--sp-4); margin-bottom: var(--sp-4); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
</style>
