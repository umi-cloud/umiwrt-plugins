<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, Card, Field, Input, Button, Feedback } from '@sight/sdk';
	import { DOMAIN } from './service.js';

	/* 域名检查：查当前生效的拦截表；拦截了就给「始终放行」，没拦截就给「始终拦截」，加进页面的规则草稿随表单保存 */
	let { svc, allowed, blocked, disabled = false, onadd } = $props();
	let domain = $state(''), error = $state(''), result = $state(null), busy = $state(false), alive = true;
	onDestroy(() => { alive = false; });

	async function check(event) {
		event.preventDefault();
		const d = domain.trim().toLowerCase().replace(/\.$/, '');
		result = null;
		error = DOMAIN.test(d) ? '' : t('Enter a domain like ads.example.com');
		if (error || busy) return;
		busy = true;
		try {
			const r = await svc.check(d);
			if (alive) result = { domain: d, blocked: !!r.blocked, match: r.match || null };
		} catch (e) {
			if (alive) result = { domain: d, error: e?.status === 5 ? t('No block-list is loaded right now, so nothing is blocked.') : errorText(e) };
		} finally { if (alive) busy = false; }
	}
	const text = r => r.blocked
		? (r.match === r.domain ? t('%s is blocked.', r.domain) : t('%s is blocked because %s is on the block-list.', r.domain, r.match))
		: (r.match ? t('%s is not blocked: %s is on the allow list.', r.domain, r.match) : t('%s is not blocked.', r.domain));
	const added = r => (r.blocked ? allowed : blocked).includes(r.domain);
</script>

<Card icon="diagnostics" title={t('Check a domain')} name="adblock-check">
	<form class="check" onsubmit={check} aria-label={t('Check a domain')}>
		<p class="muted">{t('See whether a site is blocked, for example when it stops loading. Checks the block-list in use now.')}</p>
		<Field id="adblock-check-domain" label={t('Domain')} {error}>
			<div class="run">
				<span class="grow"><Input id="adblock-check-domain" bind:value={domain} placeholder="ads.example.com" autocomplete="off" spellcheck="false"
					aria-invalid={!!error} aria-describedby={error ? 'adblock-check-domain-error' : undefined} /></span>
				<Button type="submit" disabled={busy}>{t('Check')}</Button>
			</div>
		</Field>
		{#if result}
			<div class="result" data-result={result.error ? 'error' : result.blocked ? 'blocked' : 'allowed'}>
				<Feedback tone="info" message={result.error || text(result)} compact />
				{#if !result.error}
					{#if added(result)}
						<p class="muted">{t('Added to your rules. Save the settings below to apply.')}</p>
					{:else}
						<Button size="compact" {disabled} onclick={() => onadd(result.blocked ? 'allowed' : 'blocked', result.domain)}>
							{result.blocked ? t('Never block %s', result.domain) : t('Always block %s', result.domain)}
						</Button>
					{/if}
				{/if}
			</div>
		{/if}
	</form>
</Card>

<style lang="less">
	.check { display: flex; flex-direction: column; gap: var(--sp-4); }
	.run { display: flex; gap: var(--sp-2); max-width: 36rem; }
	.grow { flex: 1; min-width: 0; display: grid; }
	.result { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	/* 纵向排列时 flex: 1 会把输入框高度压扁，恢复自然高度 */
	@media (max-width: 480px) { .run { flex-direction: column; } .grow { flex: none; } }
</style>
