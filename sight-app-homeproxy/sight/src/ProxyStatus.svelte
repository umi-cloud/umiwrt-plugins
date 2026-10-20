<script>
	import { onDestroy } from 'svelte';
	import { t, Card, StatusHero, Switch, Button, Badge, Callout } from '@sight/sdk';
	import { SITES, URLTEST } from './constants.js';
	import { modeLabel, outboundName, siteLabel, resourceLabel, diagnosisText, listText, nodesText } from './labels.js';

	/* 顶部状态卡：开关、当前节点、连通性检查；代理开着但 sing-box 没在运行时附上原因（诊断），当前模式缺少规则库时提醒下载。
	   resources 为页面创建的规则库状态（resources.svelte.js）。 */
	let { data, svc, locked = false, write, resources, onshowlog } = $props();
	let alive = true;
	onDestroy(() => { alive = false; });

	const isCustom = $derived(data.mode === 'custom');
	const mainNode = $derived(data.nodes.find(n => n.id === data.mainNode) || null);
	const state = $derived(!data.enabled ? 'off' : data.running === false ? 'warning' : 'on');
	const statusText = $derived.by(() => {
		if (!data.enabled) return t('Off. All traffic goes out directly.');
		if (data.running === false) return t('On, but sing-box is not running. Check the logs.');
		if (isCustom) return t('On. Custom routing; unmatched traffic goes to %s.', outboundName(data.custom, data.custom.defaultOutbound));
		if (data.mainNode === URLTEST) return t('On. Using the fastest of %s.', nodesText(data.urltestNodes.length));
		return t('On. Using %s.', mainNode?.label || data.mainNode);
	});
	/* 打开代理时沿用关闭前的主节点，没有则用第一个节点；关闭时记住主节点。自定义模式下开关对应默认出站 */
	function toggle(on) {
		if (isCustom) { const c = data.custom; write(() => svc.setCustomPower(on, c)); return; }
		if (on && !data.nodes.length) return;
		const { mainNode: current, lastNode, nodes } = data;
		write(() => on ? svc.useNode(lastNode || nodes[0].id) : svc.turnOff(current));
	}

	/* 连通性：经代理访问站点，结果只保留在本页 */
	let checks = $state({});        // site → undefined（检查中）| true | false | 'error'
	async function check(site) {
		checks = { ...checks, [site]: undefined };
		let result;
		try { result = await svc.checkSite(site); } catch { result = 'error'; }
		if (alive) checks = { ...checks, [site]: result };
	}

	/* 代理开着但 sing-box 没在运行：从服务日志与系统日志里找原因；找不到时只保留状态卡上的提示 */
	let diagnosis = $state(null);
	$effect(() => { if (data.enabled && data.running === false) loadDiagnosis(); else diagnosis = null; });
	async function loadDiagnosis() {
		let d = null;
		try { d = await svc.readDiagnosis(); } catch { /* 诊断只是辅助信息 */ }
		if (alive) diagnosis = d;
	}

	const missing = $derived(data.enabled ? resources.missing(data.mode) : []);
	async function downloadMissing() { for (const r of missing) await resources.update(r); }
</script>

<Card>
	<StatusHero data-state={state} data-homeproxy icon="proxy" tone={{ on: 'success', warning: 'warning' }[state] || 'muted'} title={t('Proxy')}
		status={statusText} hint={[modeLabel(data.mode), data.version ? `sing-box ${data.version}` : ''].filter(Boolean).join(' · ')}>
		{#snippet actions()}<Switch checked={data.enabled} disabled={locked || (!isCustom && !data.enabled && !data.nodes.length)} aria-label={t('Proxy')} onchange={toggle} />{/snippet}
		<div class="checks" role="group" aria-label={t('Connectivity')}>
			<span class="hp-muted">{t('Connectivity')}</span>
			{#each SITES as site}
				<span class="check" data-check={site}>
					<Button size="compact" onclick={() => check(site)} disabled={site in checks && checks[site] === undefined}>{siteLabel(site)}</Button>
					{#if site in checks}
						{#if checks[site] === undefined}<span class="hp-muted">{t('Checking…')}</span>
						{:else if checks[site] === true}<Badge tone="success">{t('Reachable')}</Badge>
						{:else if checks[site] === false}<Badge tone="danger">{t('Unreachable')}</Badge>
						{:else}<Badge>{t('Check failed')}</Badge>{/if}
					{/if}
				</span>
			{/each}
		</div>
	</StatusHero>
</Card>
{#if diagnosis}
	<Callout tone="danger" data-hp-diagnosis={diagnosis.reason} message={diagnosisText(diagnosis)}>
		<Button size="compact" onclick={() => onshowlog?.(diagnosis.log)}>{diagnosis.log === 'syslog' ? t('Open system log') : t('View log')}</Button>
	</Callout>
{/if}
{#if missing.length}
	<Callout data-hp-missing message={t('Rule data needed by the current routing mode has not been downloaded (%s), so traffic may not be routed correctly.', listText(missing.map(resourceLabel)))}>
		<Button size="compact" disabled={locked || !!resources.busy} onclick={downloadMissing}>{resources.busy ? t('Updating…') : t('Download now')}</Button>
	</Callout>
{/if}

<style>
	.checks { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); }
	.check { display: inline-flex; align-items: center; gap: var(--sp-2); }
</style>
