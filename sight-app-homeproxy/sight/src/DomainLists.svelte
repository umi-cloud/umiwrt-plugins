<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, useEditor, Card, Field, DynamicList, Feedback, FormActions } from '@sight/sdk';
	import { DOMAIN_LISTS } from './constants.js';
	import { collectDomains, validDomains } from './resources.js';

	/* 自定义域名（强制走代理 / 强制直连）：存在文件里，保存即写入并重载服务，不走暂存；自定义分流模式下不生效，页面不显示。
	   active 为分区可见，首次可见时读取。 */
	let { data, svc, locked = false, run, active = false } = $props();
	let alive = true;
	onDestroy(() => { alive = false; });

	let lists = $state(null), base = $state(null), loadError = $state(''), error = $state(''), busy = $state(false);
	let drafts = $state({ proxy_list: '', direct_list: '' });
	const dirty = $derived(!!lists && (JSON.stringify(lists) !== JSON.stringify(base) || DOMAIN_LISTS.some(k => drafts[k].trim())));
	useEditor(() => ({ dirty, busy }));

	async function load() {
		loadError = '';
		try { const d = await svc.domainLists(); if (alive) { base = d; lists = structuredClone(d); } }
		catch (e) { if (alive) loadError = errorText(e); }
	}
	$effect(() => { if (active && !lists && !loadError) load(); });

	async function save(event) {
		event.preventDefault();
		if (locked) return;
		/* 输入框里还没点「添加」的内容一并收入 */
		const next = collectDomains(lists, drafts);
		error = DOMAIN_LISTS.every(k => validDomains(next[k])) ? '' : t('Enter domain names such as example.com, one per entry.');
		if (error) return;
		busy = true;
		const enabled = data.enabled;
		const r = await run(() => svc.saveDomainLists(next, base, enabled), { quiet: true, success: enabled ? t('Domain lists saved. HomeProxy was reloaded to apply them.') : t('Domain lists saved.') });
		if (!alive) return;
		busy = false;
		if (r.ok) { drafts = { proxy_list: '', direct_list: '' }; await load(); } else error = r.error;
	}
</script>

<Card title={t('Custom domains')}>
	{#if loadError}<Feedback tone="error" message={t('Domain lists could not be read: %s', loadError)} onretry={load} compact />
	{:else if !lists}<Feedback tone="loading" message={t('Loading…')} compact />
	{:else}
		<form class="hp-form" onsubmit={save} aria-label={t('Custom domains')} data-hp-domains>
			<Field id="hp-proxy-domains" label={t('Always use the proxy')} help={t('Domains containing this text go through the proxy even when the rules would send them direct. example.com also matches example.com.cn.')}>
				<DynamicList id="hp-proxy-domains" bind:values={lists.proxy_list} bind:draft={drafts.proxy_list} disabled={locked} placeholder="example.com" spellcheck="false" autocomplete="off" aria-describedby="hp-proxy-domains-help" />
			</Field>
			<Field id="hp-direct-domains" label={t('Always go direct')} help={t('Domains containing this text never use the proxy.')}>
				<DynamicList id="hp-direct-domains" bind:values={lists.direct_list} bind:draft={drafts.direct_list} disabled={locked} placeholder="example.com" spellcheck="false" autocomplete="off" aria-describedby="hp-direct-domains-help" />
			</Field>
			{#if error}<Feedback tone="error" message={error} compact />{/if}
			<FormActions {busy} disabled={locked || !dirty} description={data.enabled ? t('Saving reloads HomeProxy, which interrupts the proxy for a few seconds.') : t('Takes effect the next time the proxy is turned on.')} />
		</form>
	{/if}
</Card>
