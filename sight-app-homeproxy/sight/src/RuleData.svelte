<script>
	import { t, Card, Button, Feedback, SettingRow } from '@sight/sdk';
	import { RESOURCES } from './constants.js';
	import { versionText } from './format.js';
	import { resourceLabel, updateResultLabel } from './labels.js';

	/* 规则分区：规则库（地址与域名列表）的版本与更新。resources 为页面创建的规则库状态（resources.svelte.js）。 */
	let { resources, locked = false } = $props();
	const status = r => [
		resources.error ? t('Unknown') : resources.versions === null ? t('Loading…') : resources.versions[r] ? t('Version %s', versionText(resources.versions[r])) : t('Not downloaded'),
		resources.results[r] ? updateResultLabel(resources.results[r]) : '',
	].filter(Boolean).join(' · ');
</script>

<Card title={t('Routing rule data')}>
	<p class="hp-note lead">{t('Address and domain lists that decide what goes direct. Updating downloads the latest lists.')}</p>
	{#if resources.error}<Feedback tone="error" message={t('Rule data versions could not be read: %s', resources.error)} onretry={() => resources.load()} compact />{/if}
	{#each RESOURCES as r}
		<div data-resource={r}>
			<SettingRow id="hp-resource-{r}" label={resourceLabel(r)} description={status(r)}>
				<Button size="compact" disabled={locked || !!resources.busy} onclick={() => resources.update(r)}>{resources.busy === r ? t('Updating…') : t('Update')}</Button>
			</SettingRow>
		</div>
	{/each}
</Card>

<style>
	.lead { margin-bottom: var(--sp-3); }
</style>
