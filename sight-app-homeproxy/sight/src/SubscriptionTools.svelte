<script>
	import { untrack, tick } from 'svelte';
	import { t, useEditor, editing, Card, Table, Button, Dialog, Select, Field, DynamicList, Input, FormActions, SettingRow, Disclosure, ErrorSummary } from '@sight/sdk';
	import { nodeGroups, planRemoveGroup, filtered, validateFilter, subscriptionInfo, FILTER_MODES, ORPHAN } from './subscription.js';

	/* 订阅分区的两张卡：按订阅查看/删除节点（含上次更新结果）、订阅过滤设置。write 为页面的保存流程，svc 为页面的取数服务，
	   status 为 subscription.js 的 parseStatus 结果（还没更新过为 null）。 */
	let { data, svc, locked = false, write, onshow, status = null } = $props();

	/* --- 按订阅归组 --- */
	const groups = $derived(nodeGroups(data.subscriptions, data.nodes));
	const hashes = $derived(new Set(groups.groups.map(g => g.hash)));
	const rows = $derived([...groups.groups.map(g => ({ id: g.hash, title: g.title, url: g.url, count: g.count })),
		...(groups.orphan ? [{ id: ORPHAN, title: t('Removed subscriptions'), url: '', count: groups.orphan }] : [])]);
	const used = $derived(new Set([data.mainNode, data.udpNode, ...data.used]));
	let removing = $state(null);
	function askRemove(row) {
		removing = { ...row, plan: planRemoveGroup(data.nodes, row.id, hashes, used) };
	}
	async function confirmRemove() {
		const { plan } = removing;
		if (!plan.remove.length) { removing = null; return; }
		await write(() => svc.removeNodes(plan.remove, data), plan.kept.length ? t('Deleted %d nodes. %d nodes in use were kept.', plan.remove.length, plan.kept.length) : t('Deleted %d nodes.', plan.remove.length));
		removing = null;
	}
	/* 没取到节点时脚本保留该订阅原有的节点 */
	function lastUpdate(r) {
		if (r.id === ORPHAN) return { text: '' };
		const s = status?.subscriptions[r.id];
		if (!s) return { text: t('Not updated yet') };
		if (s.status === 'fetch_failed') return { text: t('Download failed'), badge: 'danger' };
		if (s.status !== 'ok') return { text: t('No usable nodes'), badge: 'danger' };
		return { text: t('Fetched %d nodes', s.nodes), muted: s.total > s.nodes ? t('%d skipped', s.total - s.nodes) : '' };
	}
	const cells = r => [{ text: r.title, strong: true }, { text: r.url || t('Nodes whose subscription address was removed. They are deleted at the next successful update.'), mono: !!r.url }, { text: String(r.count) }, lastUpdate(r)];

	/* --- 过滤设置：重载只更新基线，未保存的草稿保留，除非用户已确认放弃 --- */
	const snapshot = f => ({ mode: f.mode, keywords: [...f.keywords], userAgent: f.userAgent });
	let filter = $state(untrack(() => snapshot(data.filter))), keywordDraft = $state(''), baseline = $state(untrack(() => JSON.stringify(snapshot(data.filter))));
	let errors = $state([]), summary = $state();
	const dirty = $derived(JSON.stringify(filter) !== baseline || !!keywordDraft.trim());
	useEditor(() => ({ dirty }));
	let seen = editing.discarded;
	$effect(() => {
		const next = snapshot(data.filter);
		untrack(() => {
			const discarded = seen !== editing.discarded;
			seen = editing.discarded;
			if (!dirty || discarded) { filter = snapshot(next); keywordDraft = ''; errors = []; }
			baseline = JSON.stringify(next);
		});
	});
	const keywords = $derived(keywordDraft.trim() && !filter.keywords.includes(keywordDraft.trim()) ? [...filter.keywords, keywordDraft.trim()] : filter.keywords);
	const subscribed = $derived(data.nodes.filter(n => n.grouphash));
	const skipped = $derived(subscribed.filter(n => filtered(n.label, filter.mode, keywords)).length);
	const modeLabel = m => ({ disabled: t('Keep all nodes'), blacklist: t('Skip nodes whose names match'), whitelist: t('Keep only nodes whose names match') }[m]);
	async function saveFilter(event) {
		event.preventDefault();
		if (locked) return;
		const f = { mode: filter.mode, keywords, userAgent: filter.userAgent };
		errors = validateFilter(f).map(m => ({ text: t(m), field: m === 'Unknown filter mode' ? 'hp-filter-mode' : 'hp-filter-keywords' }));
		if (errors.length) { await tick(); summary?.focus(); return; }
		if (await write(() => svc.saveFilter(f))) keywordDraft = '';
	}
</script>

{#snippet actions(r)}
	<Button size="compact" disabled={!r.count} onclick={() => onshow(r.id)}>{t('Show nodes')}</Button>
	<Button size="compact" disabled={locked || !r.count} onclick={() => askRemove(r)} aria-label={t('Delete nodes from %s', r.title)}>{t('Delete nodes')}</Button>
{/snippet}

<Dialog open={!!removing} tone="danger" busy={locked} title={t('Delete nodes from %s?', removing?.title ?? '')} confirmLabel={removing?.plan.remove.length ? t('Delete %d nodes', removing.plan.remove.length) : t('OK')}
	cancelLabel={t('Cancel')} onconfirm={confirmRemove} onclose={() => { if (!locked) removing = null; }}>
	{#if removing}
		{#if removing.plan.kept.length}<p>{t('%d nodes are in use (main node, UDP node or a custom routing outbound) and will be kept.', removing.plan.kept.length)}</p>{/if}
		{#if !removing.plan.remove.length}<p>{t('There is nothing to delete.')}</p>
		{:else if removing.id !== ORPHAN}<p>{t('They come back at the next subscription update unless you also remove the subscription address.')}</p>{/if}
	{/if}
</Dialog>

<Card title={t('Nodes by subscription')} flush>
	<Table headers={[t('Subscription'), t('Address'), t('Nodes'), t('Last update')]} rate={[2]} {rows} {cells} rowKey={r => r.id} rowAttrs={r => ({ 'data-hp-group': r.id })}
		{actions} actionsLabel={t('Actions')} empty={t('No subscriptions yet. Add a subscription address above, save, then update.')} />
</Card>

<Card title={t('Subscription filter')}>
	<form class="form" onsubmit={saveFilter} aria-label={t('Subscription filter')} data-hp-filter>
		<ErrorSummary {errors} bind:this={summary} />
		<SettingRow id="hp-filter-mode" label={t('Nodes to keep')} description={t('Applied by name each time subscriptions are updated.')}>
			<Select id="hp-filter-mode" bind:value={filter.mode} disabled={locked} aria-describedby="hp-filter-mode-description">
				{#each FILTER_MODES as m}<option value={m}>{modeLabel(m)}</option>{/each}
			</Select>
		</SettingRow>
		{#if filter.mode !== 'disabled'}
			<Field id="hp-filter-keywords" label={t('Keywords')} help={t('Regular expressions are allowed, for example 到期|剩余 or ^HK.')} error={errors.find(e => e.field === 'hp-filter-keywords')?.text || ''}>
				<DynamicList id="hp-filter-keywords" bind:values={filter.keywords} bind:draft={keywordDraft} disabled={locked} spellcheck="false" autocomplete="off" aria-describedby="hp-filter-keywords-help" />
			</Field>
			{#if subscribed.length}<p class="muted" data-hp-filter-preview>{t('With these settings, %d of the %d current subscription nodes would be skipped.', skipped, subscribed.length)}</p>{/if}
		{/if}
		<Disclosure title={t('Advanced')}>
			<Field id="hp-filter-ua" label="User-Agent" help={t('Some providers return different formats depending on the client name.')}>
				<Input id="hp-filter-ua" bind:value={filter.userAgent} disabled={locked} placeholder="Wget/1.21 (HomeProxy, like v2rayN)" spellcheck="false" autocomplete="off" aria-describedby="hp-filter-ua-help" />
			</Field>
		</Disclosure>
		<FormActions busy={locked} disabled={!dirty} description={t('Takes effect at the next subscription update.')} />
	</form>
</Card>

<style lang="less">
	.form { display: flex; flex-direction: column; gap: var(--sp-4); container-type: inline-size; }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
</style>
