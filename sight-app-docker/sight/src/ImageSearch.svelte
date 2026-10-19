<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, Badge, Button, Feedback, Input } from '@sight/sdk';
	import { normalizeImage, isSearchTerm } from './service.js';

	/* 在 Docker Hub 搜索镜像：按回车或点「搜索」才发请求（设备端经 dockerd 查询，连外网可能慢，不逐字搜）。
	   点一条结果即选用「名称:latest」（onpick），标签可在镜像框里再改。放在表单里，回车不提交外层表单 */
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
</script>

<div class="search" data-image-search>
	<div class="bar">
		<Input type="search" bind:value={term} {onkeydown} disabled={disabled || busy} placeholder={t('Search Docker Hub, for example nginx')} aria-label={t('Search Docker Hub')} spellcheck="false" autocomplete="off" data-search-term />
		<Button disabled={disabled || busy || !term.trim()} onclick={search} data-action="search">{busy ? t('Searching…') : t('Search')}</Button>
	</div>
	{#if error}<Feedback tone="error" message={error} compact />
	{:else if results && !results.length}<Feedback tone="empty" message={t('No images found on Docker Hub')} compact />
	{:else if results}
		<ul class="results" aria-label={t('Search results')}>
			{#each results as r (r.name)}
				{@const ref = normalizeImage(r.name)}
				<li>
					<button type="button" class="result" class:selected={selected === ref} aria-pressed={selected === ref} {disabled} onclick={() => onpick?.(ref)} data-result={r.name}>
						<span class="head">
							<strong class="mono">{r.name}</strong>
							{#if r.official}<Badge tone="success">{t('Official')}</Badge>{/if}
							<span class="stars" title={t('%d stars', r.stars)}>★ {stars(r.stars)}</span>
						</span>
						{#if r.description}<span class="desc">{r.description}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style lang="less">
	.search { display: flex; flex-direction: column; gap: var(--sp-3); }
	.bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--sp-2); }
	.results { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-1); max-height: 22rem; overflow: auto; }
	.result {
		display: flex; flex-direction: column; gap: var(--sp-1); width: 100%; padding: var(--sp-2) var(--sp-3); text-align: left;
		border: 1px solid var(--border-color); border-radius: var(--radius); background: var(--surface-color); color: inherit; font: inherit; cursor: pointer;
		&:hover:not(:disabled) { border-color: var(--primary); }
		&:focus-visible { outline: none; box-shadow: var(--focus-ring); }
		&.selected { border-color: var(--primary); background: var(--surface-muted); }
	}
	.head { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
	.head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--heading-color); }
	.stars { margin-left: auto; color: var(--text-muted); font-size: var(--fs-xs); white-space: nowrap; }
	.desc { color: var(--text-muted); font-size: var(--fs-sm); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-sm); }
</style>
