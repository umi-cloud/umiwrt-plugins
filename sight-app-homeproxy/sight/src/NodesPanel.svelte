<script>
	import { onDestroy } from 'svelte';
	import { t, requestLeave, Card, Button, Badge, Select, Input, Table, Toolbar, Drawer, Dialog } from '@sight/sdk';
	import { nodeGroups, sourceOf, nodeInUse, MANUAL, ORPHAN } from './subscription.js';
	import { LATENCY_BATCH, PING_CONCURRENCY, latencyTone, sortByLatency } from './latency.js';
	import { latencyText, nodesText } from './labels.js';
	import NodeForm from './NodeForm.svelte';
	import ImportLinks from './ImportLinks.svelte';

	/* 节点分区：表格（按名称/地址/协议检索、按来源筛选、测过延迟后可按延迟排序）、选用、手工添加/编辑（抽屉）、
	   导入分享链接（抽屉）、删除。source 由页面绑定：订阅分区的「查看节点」切到这里并按订阅筛选。 */
	let { data, svc, locked = false, saving = false, write, drawerError = '', source = $bindable('all') } = $props();
	let alive = true;
	onDestroy(() => { alive = false; });

	const isCustom = $derived(data.mode === 'custom');
	/* 节点在当前配置里的角色（显示用）；在用的节点不能删 */
	const useLabel = n => isCustom ? (data.custom.outbounds.some(o => o.enabled && (o.node === n.id || o.urltest.includes(n.id))) ? t('Used by routing') : '')
		: n.id === data.mainNode && data.enabled ? t('Main node') : n.id === data.udpNode ? t('UDP node') : '';

	/* --- 列表 --- */
	let query = $state(''), sort = $state('default');
	/* 从订阅分区切过来时清掉检索词 */
	$effect(() => { source; query = ''; });
	const groups = $derived(nodeGroups(data.subscriptions, data.nodes));
	const hashes = $derived(new Set(groups.groups.map(g => g.hash)));
	const rows = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list = data.nodes.filter(n => (source === 'all' || sourceOf(n, hashes) === source) && (!q || `${n.label} ${n.type} ${n.address}`.toLowerCase().includes(q)));
		const byUse = [...list].sort((a, b) => !!useLabel(b) - !!useLabel(a));
		/* 测试进行中保持原顺序，避免行跳动 */
		return sort === 'latency' && !testing ? sortByLatency(byUse, latency) : byUse;
	});
	const sourceName = n => { const src = sourceOf(n, hashes); return src === MANUAL ? t('Added manually') : src === ORPHAN ? t('Removed subscription') : groups.groups.find(g => g.hash === src)?.title; };
	const cells = n => [{ text: n.label }, { text: n.type.toUpperCase(), nowrap: true }, { text: n.address ? `${n.address}:${n.port}` : '-', mono: true }, { text: '' }, { text: sourceName(n) }];
	const rowAttrs = n => ({ 'data-node': n.id, 'data-clickable': '', onclick: e => { if (!e.target.closest('button, a, input')) openNode(n); } });

	/* --- 延迟：按批测 TCP 握手；只走 UDP 的节点改为 ping。结果只保留在本页 --- */
	let latency = $state({});       // 节点 id → undefined | 'testing' | 毫秒 | 'timeout' | 'refused' | 'unresolved' | 'unsupported' | 'error'
	let testing = $state(false);
	const tested = $derived(Object.keys(latency).length > 0);
	async function testLatency() {
		if (testing) return;
		testing = true;
		const targets = [...rows], udp = [];
		latency = Object.fromEntries(targets.map(n => [n.id, 'testing']));
		for (let i = 0; i < targets.length && alive; i += LATENCY_BATCH) {
			const batch = targets.slice(i, i + LATENCY_BATCH);
			let r = {};
			try { r = await svc.measureLatency(batch.map(n => n.id)); } catch { /* 整批记为失败 */ }
			if (!alive) return;
			const next = { ...latency };
			for (const n of batch) { if (r[n.id] === 'udp') udp.push(n); else next[n.id] = r[n.id] ?? 'error'; }
			latency = next;
		}
		const worker = async () => {
			for (let n = udp.shift(); n && alive; n = udp.shift()) {
				let result;
				try { result = await svc.ping(n); } catch { result = 'error'; }
				if (alive) latency = { ...latency, [n.id]: result };
			}
		};
		await Promise.all(Array.from({ length: PING_CONCURRENCY }, worker));
		/* 测完直接按延迟排好，最快的在最前 */
		if (alive) { testing = false; sort = 'latency'; }
	}

	/* --- 添加 / 编辑（抽屉表单自己登记未保存改动，关闭前经 requestLeave 确认） --- */
	let editing = $state(null);     // { id, raw, subscribed, label }
	async function openNode(n = null) {
		if (locked || !await requestLeave()) return;
		editing = n ? { id: n.id, raw: n.raw, subscribed: !!n.grouphash, label: n.label } : { id: '', raw: null, subscribed: false, label: '' };
	}
	async function closeNode() { if (!await requestLeave()) return; editing = null; }
	async function saveNode(plan) {
		const id = editing.id;
		const ok = await write(() => svc.saveNode(id, plan, data), id ? t('Node %s saved.', plan.values.label) : t('Node %s added.', plan.values.label));
		if (ok && alive) editing = null;
	}

	/* --- 导入 --- */
	let importing = $state(false);
	async function openImport() { if (locked || !await requestLeave()) return; importing = true; }
	async function closeImport() { if (!await requestLeave()) return; importing = false; }
	async function doImport(nodes) {
		const ok = await write(() => svc.importNodes(nodes, data), t('Imported %s.', nodesText(nodes.length)));
		if (ok && alive) importing = false;
	}

	/* --- 删除 --- */
	let removing = $state(null);
	async function removeNode() {
		const n = removing;
		if (!n) return;
		await write(() => svc.removeNodes([n.id], data));
		if (alive) removing = null;
	}
</script>

{#snippet cell(raw, n, col)}
	{#if col === 0}
		{@const use = useLabel(n)}
		<span class="hp-name"><strong>{raw.text}</strong>{#if use}<Badge tone="success">{use}</Badge>{/if}</span>
	{:else if col === 3}
		{@const l = latency[n.id]}
		<span class="latency" data-latency={typeof l === 'number' ? 'ok' : l || 'none'} data-tone={latencyTone(l) || undefined}>{latencyText(l)}</span>
	{:else}{raw.text}{/if}
{/snippet}

{#snippet actions(n)}
	{#if !useLabel(n) && !isCustom}<Button size="compact" disabled={locked} onclick={() => write(() => svc.useNode(n.id))}>{t('Use')}</Button>{/if}
	<Button size="compact" disabled={locked} onclick={() => openNode(n)} aria-label={t('Edit node %s', n.label)}>{t('Edit')}</Button>
	{#if useLabel(n)}<span class="hp-muted">{t('In use')}</span>
	{:else if !nodeInUse(data, n.id)}<Button size="compact" disabled={locked} onclick={() => removing = n} aria-label={t('Delete node %s', n.label)}>{t('Delete')}</Button>{/if}
{/snippet}

<Dialog open={!!removing} tone="danger" busy={saving} title={t('Delete node %s?', removing?.label ?? '')} confirmLabel={t('Delete')} cancelLabel={t('Cancel')}
	onconfirm={removeNode} onclose={() => { if (!saving) removing = null; }}>
	{removing?.grouphash ? t('This node came from a subscription and may come back at the next subscription update.') : t('The node will be removed.')}
</Dialog>

<p class="hp-note note">{isCustom ? t('Custom routing is in use: rules send traffic to outbounds, which use these nodes.') : t('Choose the node the proxy uses. Add nodes by hand, import share links, or add a subscription.')}</p>
<Card icon="proxy" flush>
	<Toolbar label={t('Node tools')} count={t('%d of %d nodes', rows.length, data.nodes.length)}>
		{#snippet search()}<Input type="search" size="compact" bind:value={query} placeholder={t('Name, address or protocol')} aria-label={t('Search nodes')} />{/snippet}
		{#if groups.groups.length || groups.orphan}
			<Select size="compact" bind:value={source} aria-label={t('Source')} data-hp-source>
				<option value="all">{t('All sources')}</option>
				<option value={MANUAL}>{t('Added manually')} ({groups.manual})</option>
				{#each groups.groups as g (g.hash)}<option value={g.hash}>{g.title} ({g.count})</option>{/each}
				{#if groups.orphan}<option value={ORPHAN}>{t('Removed subscription')} ({groups.orphan})</option>{/if}
			</Select>
		{/if}
		{#if tested}
			<Select size="compact" bind:value={sort} disabled={testing} aria-label={t('Sort nodes')} data-hp-sort>
				<option value="default">{t('In use first')}</option>
				<option value="latency">{t('Fastest first')}</option>
			</Select>
		{/if}
		{#snippet actions()}
			<Button size="compact" onclick={testLatency} disabled={testing || !rows.length} title={t('Connects from the router to each node’s server port and measures the TCP handshake. It shows whether the server is online and how far it is, not how fast the proxy is. UDP-only nodes (Hysteria2, TUIC) are pinged instead.')}>{testing ? t('Testing…') : t('Test latency')}</Button>
			<Button size="compact" onclick={openImport} disabled={locked}>{t('Import links')}</Button>
			<Button variant="primary" size="compact" onclick={() => openNode()} disabled={locked}>{t('Add node')}</Button>
		{/snippet}
	</Toolbar>
	<Table headers={[t('Node'), t('Protocol'), t('Address'), t('Latency'), t('Source')]} rate={[3]} {rows} {cells} rowKey={n => n.id}
		{rowAttrs} cellContent={cell} {actions} actionsLabel={t('Actions')}
		empty={data.nodes.length ? t('No matching nodes') : t('No nodes yet. Add a node, import share links or add a subscription.')} />
</Card>

<Drawer error={drawerError} open={!!editing} title={editing?.id ? t('Edit node %s', editing.label) : t('Add node')} onclose={closeNode}>
	{#if editing}<NodeForm target={editing} features={data.features} {locked} {saving} onsubmit={saveNode} oncancel={closeNode} />{/if}
</Drawer>

<Drawer error={drawerError} open={importing} title={t('Import share links')} onclose={closeImport}>
	{#if importing}<ImportLinks features={data.features} {locked} {saving} onsubmit={doImport} oncancel={closeImport} />{/if}
</Drawer>

<style>
	.note { margin-bottom: var(--sp-3); }
	.latency { font-variant-numeric: tabular-nums; white-space: nowrap; }
	.latency[data-tone="fast"] { color: var(--status-success-text); }
	.latency[data-tone="fair"] { color: var(--status-warning-text); }
	.latency[data-tone="slow"], .latency[data-tone="failed"] { color: var(--status-danger-text); }
</style>
