<script>
	import { t, useEditor, requestLeave, Card, Table, Button, Badge, Switch, Select, Tabs, Toolbar, Drawer, Dialog, Feedback, Callout, SettingRow, Disclosure, FormActions, ErrorSummary } from '@sight/sdk';
	import { URLTEST } from './constants.js';
	import { problems as findProblems, referrers, missingDeps, find, moved, planOrder, conditions, settingsForm, validateSettings, BLOCK_TARGET, KEEP_TARGET, DIRECT, BLOCK, BUILTIN_DNS, STRATEGIES } from './routing.js';
	import { outboundName, dnsName, kindName, strategyName, listText, nodesText } from './labels.js';
	import { createDraft, showErrors } from './draft.svelte.js';
	import RuleForm from './RuleForm.svelte';
	import RoutingItemForm from './RoutingItemForm.svelte';

	/* 自定义分流：默认去向与 DNS、分流规则（有序）、出站、规则集、DNS 服务器与 DNS 规则（有序）。
	   增改在抽屉里进行；启停即时写入；排序先在列表里调好，再一次保存。 */
	let { data, svc, locked = false, saving = false, write, error = '' } = $props();
	const c = $derived(data.custom);
	const problemList = $derived(findProblems(c, data.nodes));
	const outName = o => outboundName(c, o);
	const dnsLabelOf = d => dnsName(c, d);

	/* --- 默认设置 --- */
	const draft = createDraft(() => settingsForm(data.custom));
	$effect(() => { data; draft.sync(); });
	const settings = $derived(draft.value);
	let settingsErrors = $state([]), settingsSummary = $state();
	const fid = k => `hp-custom-${k}`;
	const settingsError = id => settingsErrors.find(e => e.field === id)?.text || '';
	async function saveSettings(event) {
		event.preventDefault();
		if (locked) return;
		({ errors: settingsErrors } = await showErrors(validateSettings(settings, c), fid, { summary: settingsSummary }));
		if (settingsErrors.length) return;
		const f = { ...settings };
		await write(() => svc.saveCustomSettings(f, c));
	}
	const knownDns = $derived(new Set([...BUILTIN_DNS, ...c.dnsServers.map(d => d.id)]));

	/* --- 列表与排序草稿 --- */
	const tabsId = $props.id();
	const VIEWS = ['rules', 'outbounds', 'rulesets', 'dns'];
	let view = $state('rules');
	const views = $derived([
		{ value: 'rules', label: t('Rules'), count: c.rules.length },
		{ value: 'outbounds', label: t('Outbounds'), count: c.outbounds.length },
		{ value: 'rulesets', label: t('Rule sets'), count: c.rulesets.length },
		{ value: 'dns', label: t('DNS'), count: c.dnsServers.length + c.dnsRules.length },
	]);
	const panel = $derived(Object.fromEntries(VIEWS.map((v, i) => [v, { id: `${tabsId}-panel-${i}`, 'aria-labelledby': `${tabsId}-tab-${i}`, role: 'tabpanel', hidden: view !== v }])));
	let order = $state(null);   // { kind, ids } 未保存的排序
	const orderDirty = $derived(!!order && order.ids.join() !== (order.kind === 'rule' ? c.rules : c.dnsRules).map(x => x.id).join());
	let listError = $state('');
	const rowsOf = kind => {
		const list = kind === 'rule' ? c.rules : c.dnsRules;
		return order?.kind === kind ? order.ids.map(id => list.find(x => x.id === id)).filter(Boolean) : list;
	};
	const ruleRows = $derived(rowsOf('rule'));
	const dnsRuleRows = $derived(rowsOf('dnsRule'));
	function move(kind, rows, index, delta) { listError = ''; order = { kind, ids: moved(rows, index, delta) }; }
	async function saveOrder() {
		const ids = order.ids;
		if (await write(() => svc.reorder(planOrder(c.order, ids)), t('Order saved.'))) order = null;
	}

	/* --- 编辑抽屉 --- */
	let editingItem = $state(null);   // { kind, raw }
	useEditor(() => ({ dirty: draft.dirty || orderDirty }));
	async function open(kind, item = null) {
		if (locked || orderDirty || !await requestLeave()) return;
		listError = '';
		editingItem = { kind, raw: item?.raw || null };
	}
	async function close() {
		if (!await requestLeave()) return;
		editingItem = null;
	}
	async function saveItem(plan) {
		const { kind, raw } = editingItem;
		const ok = await write(() => svc.saveCustom(kind, raw?.['.name'] || null, plan, c), raw ? t('%s saved.', plan.values.label) : t('%s added.', plan.values.label));
		if (ok) editingItem = null;
	}
	const addTitle = k => ({ outbound: t('Add outbound'), rule: t('Add rule'), ruleset: t('Add rule set'), dns: t('Add DNS server'), dnsRule: t('Add DNS rule') }[k]);
	const drawerTitle = $derived(editingItem ? (editingItem.raw ? t('Edit %s', editingItem.raw.label || editingItem.raw['.name']) : addTitle(editingItem.kind)) : '');

	/* --- 启停与删除：引用关系不满足时说明原因，不写入 --- */
	async function toggle(kind, item, on) {
		listError = '';
		if (!on) {
			const refs = referrers(c, kind, item.id, { enabledOnly: true, t });
			if (refs.length) { listError = t('%s is used by %s. Change those first.', item.label, listText(refs)); return; }
		} else {
			const miss = missingDeps(c, kind, item.raw);
			if (miss.length) { listError = t('%s refers to %s, which is missing or turned off', item.label, listText(miss)); return; }
		}
		await write(() => svc.toggleCustom(kind, item.id, on, c));
	}
	let deleting = $state(null);   // { kind, item, refs }
	function askDelete(kind, item) { listError = ''; deleting = { kind, item, refs: referrers(c, kind, item.id, { t }) }; }
	async function confirmDelete() {
		const { kind, item } = deleting;
		await write(() => svc.removeCustom(kind, item.id, c), t('%s deleted.', item.label));
		deleting = null;
	}

	/* --- 摘要 --- */
	const COND = { domain: 'Exact domain', domain_suffix: 'Domain', domain_keyword: 'Keyword', domain_regex: 'Domain pattern', ip_cidr: 'IP', ip_is_private: 'Local network addresses',
		source_ip_cidr: 'Device', source_ip_is_private: 'Local devices', port: 'Port', port_range: 'Ports', source_port: 'Source port', source_port_range: 'Source ports',
		network: 'Network', protocol: 'Protocol', rule_set: 'Rule set', process_name: 'Process', process_path: 'Process', process_path_regex: 'Process', user: 'User', ip_version: 'IP version', query_type: 'Query type' };
	const SHOWN = 2;
	function matchText(raw, dns) {
		const parts = conditions(raw, dns).map(([k, v]) => {
			if (['ip_is_private', 'source_ip_is_private'].includes(k)) return t(COND[k]);
			const vals = k === 'rule_set' ? v.map(id => find(c, 'ruleset', id)?.label || id) : v;
			const shown = listText(vals.slice(0, SHOWN));
			return t('%s: %s', t(COND[k] || k), vals.length > SHOWN ? t('%s and %d more', shown, vals.length - SHOWN) : shown);
		});
		const text = parts.length ? parts.join(t('; ')) : t('Everything');
		return raw.invert === '1' ? t('Not %s', text) : text;
	}
	const targetText = (item, dns) => item.target === BLOCK_TARGET ? t('Block traffic') : item.target === KEEP_TARGET ? t('Other action (%s)', item.raw.action) : dns ? dnsLabelOf(item.target) : outName(item.target);
	const nodeName = id => data.nodes.find(n => n.id === id)?.label || id;
	const outboundVia = o => o.node === URLTEST ? t('Fastest of %s', nodesText(o.urltest.length)) : nodeName(o.node);
	const clickable = (kind, item) => ({ 'data-clickable': '', [`data-hp-${kind}`]: item.id, onclick: e => { if (!e.target.closest('button, a, input')) open(kind, item); } });
</script>

{#snippet status(kind, item)}
	<Switch checked={item.enabled} disabled={locked || orderDirty} aria-label={t('Turn on %s', item.label)} onchange={on => toggle(kind, item, on)} />
{/snippet}
{#snippet rowActions(kind, item)}
	<Button size="compact" disabled={locked || orderDirty} onclick={() => open(kind, item)}>{t('Edit')}</Button>
	<Button size="compact" disabled={locked || orderDirty} onclick={() => askDelete(kind, item)} aria-label={t('Delete %s', item.label)}>{t('Delete')}</Button>
{/snippet}
{#snippet orderedActions(kind, rows, item, index)}
	<Button size="compact" variant="ghost" disabled={locked || index === 0 || (order && order.kind !== kind)} onclick={() => move(kind, rows, index, -1)} aria-label={t('Move %s up', item.label)}>↑</Button>
	<Button size="compact" variant="ghost" disabled={locked || index === rows.length - 1 || (order && order.kind !== kind)} onclick={() => move(kind, rows, index, 1)} aria-label={t('Move %s down', item.label)}>↓</Button>
	{@render rowActions(kind, item)}
{/snippet}
{#snippet orderTools(kind)}
	{#if orderDirty && order.kind === kind}
		<Button size="compact" disabled={locked} onclick={() => order = null}>{t('Cancel')}</Button>
		<Button size="compact" variant="primary" disabled={locked} onclick={saveOrder}>{t('Save order')}</Button>
	{/if}
{/snippet}
{#snippet orderedCell(kind, raw, item, col, row)}
	{#if col === 0}<span class="hp-muted num">{row + 1}</span>
	{:else if col === 1}<strong class="hp-name">{item.label}</strong>
	{:else if col === 4}{@render status(kind, item)}
	{:else}{raw.text}{/if}
{/snippet}
{#snippet ruleCell(raw, item, col, row)}{@render orderedCell('rule', raw, item, col, row)}{/snippet}
{#snippet dnsRuleCell(raw, item, col, row)}{@render orderedCell('dnsRule', raw, item, col, row)}{/snippet}
{#snippet ruleActions(r, i)}{@render orderedActions('rule', ruleRows, r, i)}{/snippet}
{#snippet dnsRuleActions(r, i)}{@render orderedActions('dnsRule', dnsRuleRows, r, i)}{/snippet}
{#snippet outboundActions(o)}{@render rowActions('outbound', o)}{/snippet}
{#snippet rulesetActions(r)}{@render rowActions('ruleset', r)}{/snippet}
{#snippet dnsActions(d)}{@render rowActions('dns', d)}{/snippet}
{#snippet outboundCell(raw, item, col)}
	{#if col === 0}<span class="hp-name"><strong>{item.label}</strong>{#if c.defaultOutbound === item.id}<Badge tone="success">{t('Default')}</Badge>{/if}</span>
	{:else if col === 3}{@render status('outbound', item)}
	{:else}{raw.text}{/if}
{/snippet}
{#snippet rulesetCell(raw, item, col)}
	{#if col === 0}<strong class="hp-name">{item.label}</strong>
	{:else if col === 3}{@render status('ruleset', item)}
	{:else}<span class={col === 2 ? 'hp-mono' : ''}>{raw.text}</span>{/if}
{/snippet}
{#snippet dnsCell(raw, item, col)}
	{#if col === 0}<span class="hp-name"><strong>{item.label}</strong>{#if c.defaultDns === item.id}<Badge tone="success">{t('Default')}</Badge>{/if}</span>
	{:else if col === 3}{@render status('dns', item)}
	{:else}<span class={col === 1 ? 'hp-mono' : ''}>{raw.text}</span>{/if}
{/snippet}
{#snippet dnsOptions(current)}
	{#each BUILTIN_DNS as d}<option value={d}>{dnsLabelOf(d)}</option>{/each}
	{#each c.dnsServers as d (d.id)}<option value={d.id} disabled={!d.enabled}>{d.label}</option>{/each}
	{#if !knownDns.has(current)}<option value={current}>{t('%s (missing)', current)}</option>{/if}
{/snippet}

<Dialog open={!!deleting} tone="danger" busy={saving} title={deleting?.refs.length ? t('%s is in use', deleting.item.label) : t('Delete %s?', deleting?.item.label ?? '')}
	confirmLabel={deleting?.refs.length ? '' : t('Delete')} cancelLabel={t('Cancel')} onconfirm={confirmDelete} onclose={() => { if (!saving) deleting = null; }}>
	{#if deleting?.refs.length}{t('It is used by %s. Change those first, then delete it.', listText(deleting.refs))}
	{:else}{t('This cannot be undone.')}{/if}
</Dialog>

<div class="hp-stack" data-hp-custom>
	{#if problemList.length}
		<Callout tone="danger" data-hp-problems message={t('HomeProxy cannot start with the current custom routing: %s', problemList.map(p => t(p.msg, ...(p.args || []))).join(t('; ')))} />
	{/if}

	<Card title={t('Defaults')}>
		<form class="hp-form" onsubmit={saveSettings} aria-label={t('Defaults')} data-hp-custom-settings>
			<ErrorSummary errors={settingsErrors} bind:this={settingsSummary} />
			<SettingRow id={fid('defaultOutbound')} label={t('Traffic no rule matches')} error={settingsError(fid('defaultOutbound'))}
				description={data.enabled ? t('Where traffic goes when no routing rule matches. Only traffic to the ports chosen under Routing reaches these rules.') : t('Where traffic goes when no routing rule matches. Takes effect when the proxy is turned on.')}>
				<Select id={fid('defaultOutbound')} bind:value={settings.defaultOutbound} disabled={locked} aria-describedby="{fid('defaultOutbound')}-description">
					<option value={DIRECT}>{t('Direct')}</option>
					{#each c.outbounds as o (o.id)}<option value={o.id} disabled={!o.enabled}>{o.label}</option>{/each}
					<option value={BLOCK}>{t('Block traffic')}</option>
				</Select>
			</SettingRow>
			<SettingRow id={fid('defaultDns')} label={t('Default DNS server')} description={t('Answers queries no DNS rule matches.')} error={settingsError(fid('defaultDns'))}>
				<Select id={fid('defaultDns')} bind:value={settings.defaultDns} disabled={locked} aria-describedby="{fid('defaultDns')}-description">{@render dnsOptions(settings.defaultDns)}</Select>
			</SettingRow>
			<Disclosure title={t('Advanced')}>
				<SettingRow id={fid('outboundDns')} label={t('DNS for node addresses')} description={t('Resolves the domain names of proxy servers.')} error={settingsError(fid('outboundDns'))}>
					<Select id={fid('outboundDns')} bind:value={settings.outboundDns} disabled={locked} aria-describedby="{fid('outboundDns')}-description">{@render dnsOptions(settings.outboundDns)}</Select>
				</SettingRow>
				<SettingRow id={fid('strategy')} label={t('Address preference')} description={data.ipv6 ? t('Which kind of address DNS answers by default.') : t('Which kind of address DNS answers by default. IPv6 is not proxied, so choose “IPv4 only” to keep IPv6 traffic from bypassing the proxy.')}>
					<Select id={fid('strategy')} bind:value={settings.strategy} disabled={locked} aria-describedby="{fid('strategy')}-description">
						{#each STRATEGIES as s}<option value={s}>{strategyName(s)}</option>{/each}
					</Select>
				</SettingRow>
			</Disclosure>
			<FormActions busy={saving} disabled={locked || !draft.dirty} />
		</form>
	</Card>

	<div class="views"><Tabs id={tabsId} label={t('Custom routing')} items={views} bind:value={view} size="compact" /></div>
	{#if listError}<Feedback tone="error" message={listError} />{/if}

	<div {...panel.rules}>
		<p class="hp-note lead">{t('Checked from top to bottom; the first match wins.')}</p>
		<Card flush>
			<Toolbar label={t('Rule tools')}>
				{#snippet actions()}
					{@render orderTools('rule')}
					<Button variant="primary" size="compact" disabled={locked || orderDirty} onclick={() => open('rule')}>{t('Add rule')}</Button>
				{/snippet}
			</Toolbar>
			<Table headers={['#', t('Name'), t('Match'), t('Send to'), t('On')]} rows={ruleRows} rowKey={r => r.id} rowAttrs={r => clickable('rule', r)}
				cells={r => [{ text: '' }, { text: r.label }, { text: matchText(r.raw, false) }, { text: targetText(r, false), nowrap: true }, { text: '' }]}
				cellContent={ruleCell} actions={ruleActions} actionsLabel={t('Actions')} empty={t('No rules yet. Everything follows the default outbound.')} />
		</Card>
	</div>

	<div {...panel.outbounds}>
		<p class="hp-note lead">{t('Nodes that rules can send traffic to.')}</p>
		<Card flush>
			<Toolbar label={t('Outbound tools')}>
				{#snippet actions()}<Button variant="primary" size="compact" disabled={locked || orderDirty || !data.nodes.length} onclick={() => open('outbound')}>{t('Add outbound')}</Button>{/snippet}
			</Toolbar>
			<Table headers={[t('Name'), t('Node'), t('Connect through'), t('On')]} rows={c.outbounds} rowKey={o => o.id} rowAttrs={o => clickable('outbound', o)}
				cells={o => [{ text: o.label }, { text: outboundVia(o) }, { text: o.node === URLTEST ? '-' : o.detour ? outName(o.detour) : t('Directly') }, { text: '' }]}
				cellContent={outboundCell} actions={outboundActions} actionsLabel={t('Actions')} empty={t('No outbounds yet. Add one to send traffic through a node.')} />
		</Card>
	</div>

	<div {...panel.rulesets}>
		<p class="hp-note lead">{t('Lists of domains or addresses that rules can match.')}</p>
		<Card flush>
			<Toolbar label={t('Rule set tools')}>
				{#snippet actions()}<Button variant="primary" size="compact" disabled={locked || orderDirty} onclick={() => open('ruleset')}>{t('Add rule set')}</Button>{/snippet}
			</Toolbar>
			<Table headers={[t('Name'), t('Source'), t('Address'), t('On')]} rows={c.rulesets} rowKey={r => r.id} rowAttrs={r => clickable('ruleset', r)}
				cells={r => [{ text: r.label }, { text: r.type === 'local' ? t('File on the router') : t('Download'), nowrap: true }, { text: r.source || '-' }, { text: '' }]}
				cellContent={rulesetCell} actions={rulesetActions} actionsLabel={t('Actions')} empty={t('No rule sets yet.')} />
		</Card>
	</div>

	<div {...panel.dns}>
		<div class="hp-stack">
			<Card title={t('DNS servers')} flush>
				<Toolbar label={t('DNS server tools')}>
					{#snippet actions()}<Button variant="primary" size="compact" disabled={locked || orderDirty} onclick={() => open('dns')}>{t('Add DNS server')}</Button>{/snippet}
				</Toolbar>
				<Table headers={[t('Name'), t('Address'), t('Query through'), t('On')]} rows={c.dnsServers} rowKey={d => d.id} rowAttrs={d => clickable('dns', d)}
					cells={d => [{ text: d.label }, { text: d.address || '-' }, { text: outName(d.outbound || DIRECT) }, { text: '' }]}
					cellContent={dnsCell} actions={dnsActions} actionsLabel={t('Actions')} empty={t('No DNS servers yet. The uplink DNS is used.')} />
			</Card>
			<Card title={t('DNS rules')} flush>
				<Toolbar label={t('DNS rule tools')} count={t('Checked from top to bottom; the first match wins.')} live={false}>
					{#snippet actions()}
						{@render orderTools('dnsRule')}
						<Button variant="primary" size="compact" disabled={locked || orderDirty} onclick={() => open('dnsRule')}>{t('Add DNS rule')}</Button>
					{/snippet}
				</Toolbar>
				<Table headers={['#', t('Name'), t('Match'), t('Resolve with'), t('On')]} rows={dnsRuleRows} rowKey={r => r.id} rowAttrs={r => clickable('dnsRule', r)}
					cells={r => [{ text: '' }, { text: r.label }, { text: matchText(r.raw, true) }, { text: targetText(r, true), nowrap: true }, { text: '' }]}
					cellContent={dnsRuleCell} actions={dnsRuleActions} actionsLabel={t('Actions')} empty={t('No DNS rules yet. All queries go to the default DNS server.')} />
			</Card>
		</div>
	</div>

	<Drawer open={!!editingItem} title={drawerTitle} {error} onclose={close}>
		{#if editingItem}
			{#if editingItem.kind === 'rule' || editingItem.kind === 'dnsRule'}
				<RuleForm dns={editingItem.kind === 'dnsRule'} raw={editingItem.raw} custom={c} {locked} {saving} onsubmit={saveItem} oncancel={close} />
			{:else}
				<RoutingItemForm kind={editingItem.kind} raw={editingItem.raw} custom={c} nodes={data.nodes} {locked} {saving} onsubmit={saveItem} oncancel={close} />
			{/if}
		{/if}
	</Drawer>
</div>

<style>
	.num { font-variant-numeric: tabular-nums; }
	.lead { margin-bottom: var(--sp-3); }
</style>
