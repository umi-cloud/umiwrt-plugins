<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, Button, Feedback, Input, OptionList } from '@sight/sdk';
	import { normalizeImage, isSearchTerm } from './images.js';

	/* 在 Docker Hub 搜索镜像：按回车或点「搜索」才发请求（设备端经 dockerd 查询，连外网可能慢，不逐字搜）。
	   点一条结果即选用「名称:latest」（onpick），标签可在镜像框里再改。放在表单里，回车不提交外层表单。
	   结果用宿主的 OptionList：值为仓库里的名称，选中态按规范化后的引用与 selected 比对 */
	let { svc, selected = '', disabled = false, onpick } = $props();
	let term = $state('');
	let results = $state(null);      // null 未搜索；[] 无结果
	let error = $state('');
	let busy = $state(false);
	let alive = true, version = 0;
	onDestroy(() => { alive = false; version++; });

	async function search() {
		if (busy || disabled) return;
		if (!isSearchTerm(term)) { error = t('Search with letters, digits, dots, dashes and slashes'); results = null; return; }
		const request = ++version;
		busy = true; error = '';
		try { const r = await svc.search(term); if (alive && request === version) results = r; }
		catch (e) { if (alive && request === version) { results = null; error = errorText(e); } }
		finally { if (alive && request === version) busy = false; }
	}
	const onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
	const stars = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
	const items = $derived((results || []).map(r => ({ value: r.name, label: r.name, badge: r.official ? t('Official') : undefined, meta: `★ ${stars(r.stars)}`, description: r.description || undefined })));
	const selectedName = $derived(results?.find(r => normalizeImage(r.name) === selected)?.name ?? '');
</script>

<div class="search" data-image-search>
	<div class="bar">
		<Input type="search" bind:value={term} {onkeydown} disabled={disabled || busy} placeholder={t('Search Docker Hub, for example nginx')} aria-label={t('Search Docker Hub')} spellcheck="false" autocomplete="off" data-search-term />
		<Button disabled={disabled || busy || !term.trim()} onclick={search} data-action="search">{busy ? t('Searching…') : t('Search')}</Button>
	</div>
	{#if error}<Feedback tone="error" message={error} compact />
	{:else if results && !results.length}<Feedback tone="empty" message={t('No images found on Docker Hub')} compact />
	{:else if results}
		<div class="results"><OptionList {items} label={t('Search results')} selected={selectedName} {disabled} onselect={name => onpick?.(normalizeImage(name))} /></div>
	{/if}
</div>

<style lang="less">
	.search { display: flex; flex-direction: column; gap: var(--sp-3); }
	.bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--sp-2); }
	.results { max-height: 22rem; overflow: auto; }
</style>
