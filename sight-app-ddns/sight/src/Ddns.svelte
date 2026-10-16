<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, client, useEditor, requestLeave, activity, uci, pending, saveFlow, Card, Disclosure, SettingRow, Button, Badge, StatusHero, PageSection, OptionList, LogView, Switch, Drawer, Dialog, Field, Input, Select, RadioGroup, FormActions, ErrorSummary, Feedback } from '@sight/sdk';
	import { createDdns, entryState, addressMatch, nextCheck, registeredList, FEATURED, UNITS } from './service.js';

	/* 任务导向：「我的域名是否指向家里」为主；新增按「选服务商 → 填域名与凭据」两步，底层选项收进高级 */
	const svc = createDdns(client, uci);
	let data = $state(undefined);   // undefined 加载中；null 未安装
	let error = $state('');
	let notice = $state(null);
	let editing = $state(null);
	let baseline = $state('');
	let step = $state('details');   // provider | details
	let providerQuery = $state('');
	const ALL_FIELDS = { username: true, password: true, ipv6: true };
	let needs = $state(ALL_FIELDS);
	let errors = $state([]);
	let errorSummary = $state();
	let busy = $state(false);
	let running = $state('');       // 正在执行即时操作的条目名或 'service'
	let deleting = $state(null);
	let logView = $state(null);     // { name, text, loading }
	let current = $state({});       // 条目名 → { ip, loading, error }：本机当前公网地址
	const locked = $derived(busy || activity.busy);
	const dirty = $derived(!!editing && JSON.stringify(editing) !== baseline);
	useEditor(() => ({ dirty, busy: busy || !!running }));
	let alive = true, version = 0;
	onDestroy(() => { alive = false; version++; });

	async function load() {
		const request = ++version;
		error = '';
		try {
			const result = await svc.load();
			if (alive && request === version) { data = result; if (result) detect(result.services, request); }
		} catch (e) { if (alive && request === version) error = errorText(e); }
	}
	/* 本机当前地址逐条检测（rpcd 串行执行，web 来源每条最多约 3 秒），检测中保留上次读数 */
	async function detect(services, request) {
		const list = services.filter(s => s.enabled);
		current = Object.fromEntries(list.map(s => [s.name, { ...current[s.name], loading: true }]));
		for (const s of list) {
			let r;
			try { r = { ip: await svc.currentIp(s.name) }; } catch { r = { ip: null, error: true }; }
			if (!alive || request !== version) return;
			current = { ...current, [s.name]: r };
		}
	}
	const matchOf = s => addressMatch(current[s.name]?.ip, s.status?.ip);
	$effect(() => { pending.version; editing = null; errors = []; load(); });

	const isExample = s => /(^|\.)example\.(com|org|net)$/i.test(s.domain || '');
	const STATES = {
		off: ['neutral', 'Off'], paused: ['neutral', 'Paused'], synced: ['success', 'Up to date'],
		running: ['info', 'Updating'], waiting: ['neutral', 'Waiting for first update'], unknown: ['neutral', 'Unknown'],
		outdated: ['neutral', 'Out of date'],
	};
	const MATCHES = { match: ['success', 'Matches'], mismatch: ['neutral', 'Differs'], unknown: ['neutral', 'Unknown'] };
	const sourceText = e => e.ipSource === 'web' ? t('Detected from the internet') : e.ipSource === 'other' ? t('Other source: %s', e.ipSourceRaw) : t('Address of %s', e.network.toUpperCase());
	const summary = $derived.by(() => {
		if (!data) return '';
		if (!data.services.length) return t('No domains yet.');
		if (!data.enabled) return t('Automatic updates are off. %d domains are not being updated.', data.services.length);
		const synced = data.services.filter(s => entryState(s, true, matchOf(s)) === 'synced').length;
		return t('%d of %d domains are up to date.', synced, data.services.filter(s => s.enabled).length);
	});
	const providers = $derived.by(() => {
		const q = providerQuery.trim().toLowerCase();
		const list = data?.providers || [];
		const featured = FEATURED.filter(p => list.includes(p));
		return q ? list.filter(p => p.includes(q)) : [...featured, ...list.filter(p => !featured.includes(p))];
	});

	/* 服务商所需字段按最后一次选择为准；读取失败时按全部字段显示，不阻塞填写 */
	let needsVersion = 0;
	async function refreshNeeds(provider) {
		const request = ++needsVersion;
		needs = ALL_FIELDS;
		try { const r = await svc.providerInfo(provider); if (alive && request === needsVersion) needs = r; }
		catch { if (alive && request === needsVersion) needs = ALL_FIELDS; }
	}
	async function openNew() {
		if (!await requestLeave() || !alive || locked) return;
		editing = {
			id: '', name: '', enabled: true, ipv6: false, provider: '', updateUrl: '', domain: '', lookupHost: '', username: '', password: '',
			network: data.networks.includes('wan') ? 'wan' : (data.networks[0] || ''), ipSource: 'network', ipSourceRaw: 'network', ipUrl: '',
			checkInterval: '', checkUnit: 'minutes', forceInterval: '', forceUnit: 'hours', https: false, insecure: false, cacert: '', dnsServer: '', status: null,
		};
		baseline = JSON.stringify(editing); errors = []; step = 'provider'; providerQuery = '';
	}
	async function edit(s) {
		if (!await requestLeave() || !alive || locked) return;
		editing = { ...s }; baseline = JSON.stringify(editing); errors = []; step = 'details';
		refreshNeeds(s.provider);
	}
	function pick(provider) {
		editing.provider = provider;
		/* 名称默认取自域名，此处先按服务商预填，保存前可修改 */
		if (!editing.id && !editing.name) editing.name = provider === 'custom' ? 'custom' : provider.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '');
		refreshNeeds(provider);
		step = 'details';
	}
	async function cancelEdit() {
		if (!await requestLeave() || !alive || locked) return;
		editing = null; errors = [];
	}
	const fields = {
		'Name must be 1-32 letters, digits or underscores': 'ddns-name', 'A DDNS entry with this name already exists': 'ddns-name',
		'Enter an update URL starting with http:// or https://': 'ddns-url', 'Choose a provider': 'ddns-domain', 'Invalid domain': 'ddns-domain', 'Invalid lookup host': 'ddns-lookup',
		'Enter a detection URL starting with http:// or https://': 'ddns-ip-url', 'Check interval must be at least 5 minutes': 'ddns-check',
		'Forced update interval must be 0 or not shorter than the check interval': 'ddns-force', 'Invalid DNS server': 'ddns-dns',
	};
	const fieldError = id => errors.find(e => e.field === id)?.text || '';
	/* form：错误进表单摘要并聚焦，成功后关闭编辑；否则错误显示在页面顶部 */
	async function write(action, form = false) {
		if (locked) return false;
		return saveFlow(action, {
			busy: on => { busy = on; if (on) error = ''; },
			fail: async e => { const text = errorText(e); if (form) { errors = [{ text }]; await tick(); errorSummary?.focus(); } else error = text; },
			done: async () => { if (form) { editing = null; errors = []; } await load(); },
			alive: () => alive,
		});
	}
	async function save(e) {
		e.preventDefault();
		if (!editing || locked) return;
		errors = svc.validate(editing, data.services.map(s => s.name)).map(message => ({ text: t(message), field: fields[message] }));
		if (errors.length) { await tick(); errorSummary?.focus(); return; }
		const submitted = { ...editing };
		await write(() => svc.save(submitted), true);
	}
	async function remove() {
		if (!deleting || locked) return;
		const id = deleting.id;
		editing = null;
		await write(() => svc.remove(id));
		if (alive) deleting = null;
	}
	/* 即时操作：执行后回读状态，说明实际结果 */
	async function immediate(key, action, done) {
		if (running) return;
		running = key; notice = null;
		try { await action(); if (alive) notice = { tone: 'success', text: done }; }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { running = ''; await load(); } }
	}
	async function openLog(s) {
		logView = { name: s.name, text: '', error: '', loading: true };
		try { const text = await svc.log(s.name); if (alive && logView?.name === s.name) logView = { name: s.name, text, error: '', loading: false }; }
		catch (e) { if (alive && logView?.name === s.name) logView = { name: s.name, text: '', error: errorText(e), loading: false }; }
	}
</script>

<Dialog open={!!deleting} tone="danger" busy={locked} title={t('Delete %s?', deleting?.domain || deleting?.name || '')} confirmLabel={t('Delete')} cancelLabel={t('Cancel')}
	onconfirm={remove} onclose={() => { if (!busy) deleting = null; }}>
	{t('The router stops updating this domain. The record at the provider is not deleted.')}
</Dialog>
<Drawer open={!!logView} title={t('Log: %s', logView?.name || '')} onclose={() => logView = null}>
	{#if logView?.loading}<Feedback tone="loading" message={t('Loading…')} compact />
	{:else if logView?.error}<Feedback tone="error" message={t('Log could not be read: %s', logView.error)} compact />
	{:else if logView?.text}<LogView text={logView.text} label={t('Log contents')} tail maxHeight="none" />
	{:else}<Feedback tone="empty" message={t('No log entries yet. Logs appear after the entry has run.')} compact />{/if}
</Drawer>

{#if error}<Feedback tone="error" message={error} onretry={load} />{/if}
{#if notice}<Feedback tone={notice.tone} message={notice.text} />{/if}
{#if data === undefined && !error}
	<Feedback tone="loading" message={t('Loading…')} />
{:else if data === null}
	<Feedback tone="info" message={t('The DDNS service is not available on this device. Reinstall sight-app-ddns.')} />
{:else if data}
	<div class="stack">
		<Card icon="dns">
			<StatusHero data-state={data.enabled ? 'on' : 'off'} icon="dns" tone={data.enabled ? 'success' : 'muted'} title={t('Automatic updates')} status={summary}>
				{#snippet actions()}
					<Switch checked={data.enabled} disabled={!!running} aria-label={t('Automatic updates')}
						onchange={on => immediate('service', () => svc.toggleService(on), on ? t('Automatic updates turned on') : t('Automatic updates turned off'))} />
				{/snippet}
			</StatusHero>
		</Card>

		<PageSection title={t('Domains')}>
			{#snippet actions()}
				<Button size="compact" onclick={load} disabled={locked}>{t('Refresh')}</Button>
				<Button variant="primary" size="compact" disabled={locked} onclick={openNew}>{t('Add domain')}</Button>
			{/snippet}
			{#if !data.services.length}
				<Card><Feedback tone="empty" message={t('Add a domain to keep it pointing at your home network when your public address changes.')} compact /></Card>
			{:else}
				<!-- 出厂自带的示例条目不会生效，容易被当成真实域名 -->
				{#if data.services.some(isExample)}<Feedback tone="info" message={t('Entries for example.com are factory samples and do nothing. Edit them to use your own domain, or delete them.')} compact />{/if}
				<div class="domains">
					{#each data.services as s (s.id)}
						{@const match = matchOf(s)}
						{@const state = entryState(s, data.enabled, match)}
						{@const here = current[s.name]}
						{@const next = nextCheck(s.status)}
						<Card flush>
							<div class="domain" data-ddns={s.name} data-state={state}>
								<div class="domain-head">
									<div class="domain-title">
										<strong>{s.domain || s.name}</strong>
										<span class="muted">{s.provider === 'custom' ? t('Custom provider') : s.provider}{s.ipv6 ? ' · IPv6' : ''}</span>
									</div>
									<Badge tone={STATES[state][0]}>{t(STATES[state][1])}</Badge>
								</div>
								<dl class="facts">
									<div><dt>{t('Current public address')}</dt><dd class="mono" data-current>{here?.ip || (here?.loading ? t('Detecting…') : '-')}</dd></div>
									<div><dt>{t('Domain points to')}</dt><dd class="points"><span class="mono">{registeredList(s.status?.ip).join(', ') || '-'}</span>
										{#if s.enabled}<Badge tone={MATCHES[match][0]} data-match={match}>{t(MATCHES[match][1])}</Badge>{/if}</dd></div>
									<div><dt>{t('Last update')}</dt><dd>{s.status?.last_update || t('Never')}</dd></div>
									<div><dt>{t('Next check')}</dt><dd data-next>{next.text ? t(next.text) : (next.value || '-')}</dd></div>
								</dl>
								<div class="domain-actions">
									<Button size="compact" variant="primary" disabled={!!running || state === 'off' || state === 'paused'}
										title={state === 'paused' ? t('Turn on automatic updates first') : state === 'off' ? t('This domain is turned off') : undefined}
										onclick={() => immediate(s.name, () => svc.run(s.name, 'start'), t('Update started for %s', s.domain || s.name))}>{running === s.name ? t('Updating…') : t('Update now')}</Button>
									{#if s.status?.pid}
										<Button size="compact" disabled={!!running} onclick={() => immediate(`${s.name}:stop`, () => svc.run(s.name, 'stop'), t('Stopped updating %s. It resumes after a restart or a configuration change.', s.domain || s.name))}>{running === `${s.name}:stop` ? t('Stopping…') : t('Stop')}</Button>
									{/if}
									<Button size="compact" disabled={locked} onclick={() => edit(s)}>{t('Edit')}</Button>
									<Button size="compact" variant="ghost" onclick={() => openLog(s)}>{t('Log')}</Button>
								</div>
							</div>
						</Card>
					{/each}
				</div>
			{/if}
		</PageSection>

		<Drawer error={error || (notice?.tone === 'error' ? notice.text : '')} open={!!editing} title={editing?.id ? (editing.domain || editing.name) : step === 'provider' ? t('Choose a provider') : t('Add domain')} onclose={cancelEdit}>
			{#if editing && step === 'provider'}
				<div class="picker">
					<Input type="search" bind:value={providerQuery} placeholder={t('Search providers')} aria-label={t('Search providers')} />
					{#if data.providersError}<Feedback tone="error" message={t('The provider list could not be read. You can still use a custom update URL.')} onretry={load} compact />{/if}
					<OptionList label={t('Providers')} onselect={pick}
						items={[...providers.map(p => ({ value: p, label: p, badge: FEATURED.includes(p) && !providerQuery ? t('Popular') : '' })), { value: 'custom', label: t('Other provider (custom update URL)') }]} />
				</div>
			{:else if editing}
				{#snippet every(id, key, unitKey, label, help, placeholder)}
					<Field {id} {label} {help} error={fieldError(id)}>
						<div class="every">
							<Input {id} name={id} inputmode="numeric" bind:value={editing[key]} disabled={locked} {placeholder} autocomplete="off" aria-invalid={!!fieldError(id)} aria-describedby={fieldError(id) ? `${id}-help ${id}-error` : `${id}-help`} />
							<Select id="{id}-unit" name="{id}-unit" bind:value={editing[unitKey]} disabled={locked} aria-label={t('Unit')}>
								{#each UNITS as u}<option value={u}>{t(u)}</option>{/each}
								{#if !UNITS.includes(editing[unitKey])}<option value={editing[unitKey]}>{editing[unitKey]}</option>{/if}
							</Select>
						</div>
					</Field>
				{/snippet}
				<form class="form" onsubmit={save} aria-label={t('DDNS entry')}>
					<ErrorSummary {errors} bind:this={errorSummary} />
					<div class="chosen">
						<span><span class="muted">{t('Provider')}</span> <strong>{editing.provider === 'custom' ? t('Custom update URL') : editing.provider}</strong></span>
						<Button size="compact" variant="ghost" disabled={locked} onclick={() => { step = 'provider'; providerQuery = ''; }}>{t('Change')}</Button>
					</div>
					<Field id="ddns-domain" label={t('Domain')} help={t('The name that should point to your home, for example home.example.com')} error={fieldError('ddns-domain')}>
						<Input id="ddns-domain" name="ddnsDomain" bind:value={editing.domain} disabled={locked} placeholder="home.example.com" spellcheck="false" autocomplete="off" aria-invalid={!!fieldError('ddns-domain')} aria-describedby={fieldError('ddns-domain') ? 'ddns-domain-help ddns-domain-error' : 'ddns-domain-help'} />
					</Field>
					{#if editing.provider === 'custom'}
						<Field id="ddns-url" label={t('Update URL')} help={t('Placeholders: [USERNAME] [PASSWORD] [DOMAIN] [IP]')} error={fieldError('ddns-url')}>
							<Input id="ddns-url" name="ddnsUrl" bind:value={editing.updateUrl} disabled={locked} spellcheck="false" autocomplete="off" aria-invalid={!!fieldError('ddns-url')} aria-describedby={fieldError('ddns-url') ? 'ddns-url-help ddns-url-error' : 'ddns-url-help'} />
						</Field>
					{/if}
					{#if needs.username}
						<Field id="ddns-username" label={t('Account')}>
							<Input id="ddns-username" name="ddnsUsername" bind:value={editing.username} disabled={locked} autocomplete="off" spellcheck="false" />
						</Field>
					{/if}
					{#if needs.password}
						<Field id="ddns-password" label={needs.username ? t('Password') : t('Token')}>
							<Input id="ddns-password" name="ddnsPassword" type="password" bind:value={editing.password} disabled={locked} autocomplete="new-password" />
						</Field>
					{/if}
					<Disclosure title={t('Public address')} description={sourceText(editing)}>
						<div class="advanced">
							{#if needs.ipv6}
								<RadioGroup name="ddns-family" label={t('Address family')} bind:value={editing.ipv6} disabled={locked} options={[{ value: false, label: 'IPv4' }, { value: true, label: 'IPv6' }]} />
							{/if}
							<div class="source">
								<RadioGroup name="ddns-source" label={t('Get the public address from')} bind:value={editing.ipSource} disabled={locked}
									options={[{ value: 'network', label: t('Interface address') }, { value: 'web', label: t('Internet detection') }, ...(editing.ipSourceRaw !== 'network' && editing.ipSourceRaw !== 'web' ? [{ value: 'other', label: t('Other (unchanged)') }] : [])]} />
								<p class="hint">{editing.ipSource === 'web' ? t('Ask a web service which address your connection appears from. Use this when the router sits behind an optical modem that dials up, or behind carrier NAT, so its WAN address is private.')
									: editing.ipSource === 'other' ? t('This entry uses the source “%s”, which is managed elsewhere. Its settings are kept unchanged when you save.', editing.ipSourceRaw)
									: t('Use the address the router got on one of its interfaces. Works when the router dials up or gets a public address itself.')}</p>
							</div>
							{#if editing.ipSource === 'network'}
								<Field id="ddns-network" label={t('Use the address of')}>
									<Select id="ddns-network" name="ddnsNetwork" bind:value={editing.network} disabled={locked}>
										{#each data.networks as n}<option value={n}>{n.toUpperCase()}</option>{/each}
										{#if editing.network && !data.networks.includes(editing.network)}<option value={editing.network}>{t('%s (not found)', editing.network.toUpperCase())}</option>{/if}
									</Select>
								</Field>
							{:else if editing.ipSource === 'web'}
								<Field id="ddns-ip-url" label={t('Detection URL')} help={t('Optional. Leave empty to use %s', editing.ipv6 ? 'http://checkipv6.dyndns.com' : 'http://checkip.dyndns.com')} error={fieldError('ddns-ip-url')}>
									<Input id="ddns-ip-url" name="ddnsIpUrl" bind:value={editing.ipUrl} disabled={locked} spellcheck="false" autocomplete="off" placeholder={editing.ipv6 ? 'http://checkipv6.dyndns.com' : 'http://checkip.dyndns.com'} aria-invalid={!!fieldError('ddns-ip-url')} aria-describedby={fieldError('ddns-ip-url') ? 'ddns-ip-url-help ddns-ip-url-error' : 'ddns-ip-url-help'} />
								</Field>
							{/if}
						</div>
					</Disclosure>
					<Disclosure title={t('Advanced')} description={t('Entry name, checking schedule, HTTPS and DNS')}>
						<div class="advanced">
							{#if !editing.id}
								<Field id="ddns-name" label={t('Entry name')} help={t('Letters, digits and underscores')} error={fieldError('ddns-name')}>
									<Input id="ddns-name" name="ddnsName" bind:value={editing.name} disabled={locked} spellcheck="false" autocomplete="off" aria-invalid={!!fieldError('ddns-name')} aria-describedby={fieldError('ddns-name') ? 'ddns-name-help ddns-name-error' : 'ddns-name-help'} />
								</Field>
							{/if}
							<Field id="ddns-lookup" label={t('Lookup host')} help={t('Host name used to check the current record; defaults to the domain')} error={fieldError('ddns-lookup')}>
								<Input id="ddns-lookup" name="ddnsLookup" bind:value={editing.lookupHost} disabled={locked} spellcheck="false" autocomplete="off" aria-invalid={!!fieldError('ddns-lookup')} aria-describedby={fieldError('ddns-lookup') ? 'ddns-lookup-help ddns-lookup-error' : 'ddns-lookup-help'} />
							</Field>
							<Field id="ddns-dns" label={t('DNS server')} help={t('Server used for that lookup, such as 1.1.1.1 or 1.1.1.1:53; empty uses the system resolver')} error={fieldError('ddns-dns')}>
								<Input id="ddns-dns" name="ddnsDns" bind:value={editing.dnsServer} disabled={locked} spellcheck="false" autocomplete="off" aria-invalid={!!fieldError('ddns-dns')} aria-describedby={fieldError('ddns-dns') ? 'ddns-dns-help ddns-dns-error' : 'ddns-dns-help'} />
							</Field>
							{@render every('ddns-check', 'checkInterval', 'checkUnit', t('Check for changes every'), t('Default 10 minutes, at least 5 minutes'), '10')}
							{@render every('ddns-force', 'forceInterval', 'forceUnit', t('Update anyway every'), t('Sends the address even if it has not changed. Default 72 hours; 0 updates once and stops'), '72')}
							<SettingRow id="ddns-https" label={t('Use HTTPS')} description={t('Send updates over HTTPS. Certificates are checked against the system store in /etc/ssl/certs.')}>
								<Switch id="ddns-https" checked={editing.https} disabled={locked} aria-label={t('Use HTTPS')} onchange={on => editing.https = on} />
							</SettingRow>
							{#if editing.https}
								<SettingRow id="ddns-insecure" label={t('Skip certificate check')} description={t('Only for providers with self-signed certificates. The connection is no longer protected against impersonation.')}>
									<Switch id="ddns-insecure" checked={editing.insecure} disabled={locked} aria-label={t('Skip certificate check')} onchange={on => editing.insecure = on} />
								</SettingRow>
							{/if}
							<SettingRow id="ddns-update-this-domain" label={t('Update this domain')}>
								<Switch id="ddns-update-this-domain" checked={editing.enabled} disabled={locked} aria-label={t('Update this domain')} onchange={on => editing.enabled = on} />
							</SettingRow>
						</div>
					</Disclosure>
					<FormActions busy={locked} oncancel={cancelEdit} description={t('Changes take effect when you save. If the device becomes unreachable, they roll back automatically.')}>
						{#if editing.id}<Button variant="danger" disabled={locked} onclick={() => deleting = editing}>{t('Delete')}</Button>{/if}
					</FormActions>
				</form>
			{/if}
		</Drawer>
	</div>
{/if}

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-5); }
	.domains { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr)); gap: var(--sp-4); }
	.domain { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-5); }
	.domain-head { display: flex; align-items: flex-start; gap: var(--sp-3); }
	.domain-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.domain-title strong { font-size: var(--fs-lg); color: var(--heading-color); overflow-wrap: anywhere; }
	.facts { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); margin: 0; }
	.facts dt { font-size: var(--fs-xs); color: var(--text-muted); }
	.facts dd { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--default); overflow-wrap: anywhere; }
	.points { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); }
	.source { display: flex; flex-direction: column; gap: var(--sp-2); }
	.hint { margin: 0; font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text-muted); }
	.every { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 9rem); gap: var(--sp-2); }
	.domain-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
	.picker { display: flex; flex-direction: column; gap: var(--sp-3); }
	.chosen { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border-radius: var(--radius-lg); background: var(--surface-muted); font-size: var(--fs-sm); }
	.form { display: flex; flex-direction: column; gap: var(--sp-5); }
	.advanced { display: flex; flex-direction: column; gap: var(--sp-4); }
	.muted { color: var(--text-muted); font-size: var(--fs-sm); }
	.mono { font-family: var(--font-family-monospace); }
</style>
