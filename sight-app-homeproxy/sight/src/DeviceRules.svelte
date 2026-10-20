<script>
	import { t, useEditor, Card, Button, Select, FormActions, Feedback } from '@sight/sdk';
	import { DEVICE_RULES } from './constants.js';
	import { deviceRules } from './access.js';
	import { deviceRuleLabel, deviceRuleHint, listText } from './labels.js';
	import { createDraft } from './draft.svelte.js';

	/* 设备分区的第二张卡：给个别设备单独的走代理方式（constants.js 的 DEVICE_RULES）。这些设备仍要按上面的名单使用代理才生效。
	   devices 为设备分区算好的设备行（在线客户端与已保存的 MAC）。 */
	let { data, svc, locked = false, saving = false, write, devices = [], loading = false } = $props();
	const draft = createDraft(() => deviceRules(data.access));
	$effect(() => { data; draft.sync(); });
	const rules = $derived(draft.value);
	useEditor(() => ({ dirty: draft.dirty }));

	let pick = $state('');
	const byMac = $derived(new Map(devices.map(d => [d.mac, d])));
	const available = $derived(devices.filter(d => !rules.some(r => r.mac === d.mac)));
	const nameOf = mac => { const d = byMac.get(mac); return d?.name || d?.ip || mac; };
	const metaOf = mac => { const d = byMac.get(mac); return listText([d?.ip, nameOf(mac) === mac ? '' : mac, d && !d.online ? t('Offline') : ''].filter(Boolean)); };
	function add() {
		if (!pick) return;
		draft.value = [...rules, { mac: pick, rule: 'gaming' }];
		pick = '';
	}
	const remove = mac => { draft.value = rules.filter(r => r.mac !== mac); };
	const setRule = (mac, rule) => { draft.value = rules.map(r => r.mac === mac ? { ...r, rule } : r); };
	async function save(event) {
		event.preventDefault();
		if (locked) return;
		const next = rules.map(r => ({ ...r }));
		await write(() => svc.saveDeviceRules(next));
	}
</script>

<Card title={t('Per-device rules')}>
	<form class="hp-form" onsubmit={save} aria-label={t('Per-device rules')} data-hp-device-rules>
		<p class="hp-note">{t('Give game consoles, TV boxes and similar devices their own way of using the proxy. They still need to use the proxy according to the setting above.')}</p>
		<ul class="hints hp-note">
			{#each DEVICE_RULES as r}<li>{t('%s: %s', deviceRuleLabel(r), deviceRuleHint(r))}</li>{/each}
		</ul>
		{#if rules.length}
			<ul class="rules">
				{#each rules as r (r.mac)}
					<li data-rule-mac={r.mac}>
						<span class="hp-device"><strong>{nameOf(r.mac)}</strong><span class="hp-muted hp-mono">{metaOf(r.mac)}</span></span>
						<span class="hp-actions">
							<Select size="compact" value={r.rule} disabled={locked} aria-label={t('Rule for %s', nameOf(r.mac))} onchange={e => setRule(r.mac, e.currentTarget.value)}>
								{#each DEVICE_RULES as v}<option value={v}>{deviceRuleLabel(v)}</option>{/each}
							</Select>
							<Button size="compact" disabled={locked} onclick={() => remove(r.mac)} aria-label={t('Remove %s', nameOf(r.mac))}>{t('Remove')}</Button>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
		{#if loading}<Feedback tone="loading" message={t('Loading…')} compact />
		{:else}
			<div class="hp-add">
				<span class="hp-grow"><Select bind:value={pick} disabled={locked || !available.length} aria-label={t('Device to add')} data-hp-rule-pick>
					<option value="">{available.length ? t('Choose a device…') : t('No other devices')}</option>
					{#each available as d (d.mac)}<option value={d.mac}>{d.name || d.ip || d.mac}{d.name && d.ip ? ` (${d.ip})` : ''}</option>{/each}
				</Select></span>
				<Button onclick={add} disabled={locked || !pick}>{t('Add')}</Button>
			</div>
		{/if}
		{#if data.mode === 'custom' && rules.some(r => r.rule === 'global')}<Feedback tone="info" message={t('Custom routing is in use, so “Everything through the proxy” has no effect.')} compact />{/if}
		{#if data.ports === 'all' && rules.some(r => r.rule === 'gaming')}<Feedback tone="info" message={t('All ports already go through the proxy, so “All ports through the proxy” makes no difference.')} compact />{/if}
		{#if data.udpNode === 'nil' && rules.some(r => r.rule === 'gaming')}<Feedback tone="info" message={t('UDP traffic goes out directly, so “All ports through the proxy” only affects TCP. Most games use UDP.')} compact />{/if}
		<FormActions busy={saving} disabled={locked || !draft.dirty} description={t('Changes take effect when you save. If the device becomes unreachable, they roll back automatically.')} />
	</form>
</Card>

<style>
	.hints { padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-1); }
	.rules { list-style: none; margin: 0; padding: 0; }
	.rules li { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; padding: var(--sp-3) 0; border-top: 1px solid var(--border-color); }
	.rules li:first-child { border-top: 0; padding-top: 0; }
</style>
