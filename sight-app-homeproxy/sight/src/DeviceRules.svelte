<script>
	import { untrack } from 'svelte';
	import { t, useEditor, editing, Card, Button, Select, FormActions, Feedback } from '@sight/sdk';
	import { deviceRules, DEVICE_RULES } from './service.js';

	/* 设备分区的第二张卡：给个别设备单独的走代理方式（service.js 的 DEVICE_RULES）。这些设备仍要按上面的名单使用代理才生效。
	   devices 为页面的设备行（在线客户端与已保存的 MAC），write 为页面的保存流程。重载只更新基线，未保存的草稿保留，除非用户已确认放弃。 */
	let { data, svc, devices = [], loading = false, locked = false, saving = false, write } = $props();

	let rules = $state(untrack(() => deviceRules(data.access))), baseline = $state(untrack(() => JSON.stringify(deviceRules(data.access))));
	const dirty = $derived(JSON.stringify(rules) !== baseline);
	useEditor(() => ({ dirty }));
	let seen = editing.discarded;
	$effect(() => {
		const next = deviceRules(data.access);
		untrack(() => {
			const discarded = seen !== editing.discarded;
			seen = editing.discarded;
			if (!dirty || discarded) rules = next;
			baseline = JSON.stringify(next);
		});
	});

	let pick = $state('');
	const available = $derived(devices.filter(d => !rules.some(r => r.mac === d.mac)));
	const deviceOf = mac => devices.find(d => d.mac === mac);
	const nameOf = mac => { const d = deviceOf(mac); return d?.name || d?.ip || mac; };
	function add() {
		if (!pick) return;
		rules = [...rules, { mac: pick, rule: 'gaming' }];
		pick = '';
	}
	function remove(mac) { rules = rules.filter(r => r.mac !== mac); }
	async function save(event) {
		event.preventDefault();
		if (locked) return;
		const next = rules.map(r => ({ ...r }));
		await write(() => svc.saveDeviceRules(next));
	}
	const ruleLabel = r => ({ gaming: t('All ports through the proxy'), global: t('Everything through the proxy') }[r]);
</script>

<Card title={t('Per-device rules')}>
	<form class="form" onsubmit={save} aria-label={t('Per-device rules')} data-hp-device-rules>
		<p class="muted">{t('Give game consoles, TV boxes and similar devices their own way of using the proxy. They still need to use the proxy according to the setting above.')}</p>
		<ul class="hints muted">
			<li><strong>{ruleLabel('gaming')}</strong>: {t('Traffic from the device that goes through the proxy is not limited to the ports set under Routing. Use it for games and apps on unusual ports.')}</li>
			<li><strong>{ruleLabel('global')}</strong>: {t('The routing mode is ignored for the device, so all of its traffic uses the proxy. Not used with custom routing.')}</li>
		</ul>
		{#if rules.length}
			<ul class="rules">
				{#each rules as r (r.mac)}
					{@const d = deviceOf(r.mac)}
					<li data-rule-mac={r.mac}>
						<span class="device"><strong>{nameOf(r.mac)}</strong><span class="muted mono">{[d?.ip, nameOf(r.mac) === r.mac ? '' : r.mac, d && !d.online ? t('Offline') : ''].filter(Boolean).join(' · ')}</span></span>
						<span class="rule-actions">
							<Select size="compact" bind:value={r.rule} disabled={locked} aria-label={t('Rule for %s', nameOf(r.mac))}>
								{#each DEVICE_RULES as v}<option value={v}>{ruleLabel(v)}</option>{/each}
							</Select>
							<Button size="compact" disabled={locked} onclick={() => remove(r.mac)} aria-label={t('Remove %s', nameOf(r.mac))}>{t('Remove')}</Button>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
		{#if loading}<Feedback tone="loading" message={t('Loading…')} compact />
		{:else}
			<div class="add">
				<span class="grow"><Select bind:value={pick} disabled={locked || !available.length} aria-label={t('Device to add')} data-hp-rule-pick>
					<option value="">{available.length ? t('Choose a device…') : t('No other devices')}</option>
					{#each available as d (d.mac)}<option value={d.mac}>{d.name || d.ip || d.mac}{d.name && d.ip ? ` (${d.ip})` : ''}</option>{/each}
				</Select></span>
				<Button onclick={add} disabled={locked || !pick}>{t('Add')}</Button>
			</div>
		{/if}
		{#if data.mode === 'custom' && rules.some(r => r.rule === 'global')}<Feedback tone="info" message={t('Custom routing is in use, so “Everything through the proxy” has no effect.')} compact />{/if}
		{#if data.ports === 'all' && rules.some(r => r.rule === 'gaming')}<Feedback tone="info" message={t('All ports already go through the proxy, so “All ports through the proxy” makes no difference.')} compact />{/if}
		<FormActions busy={saving} disabled={locked || !dirty} description={t('Changes take effect when you save. If the device becomes unreachable, they roll back automatically.')} />
	</form>
</Card>

<style lang="less">
	.form { display: flex; flex-direction: column; gap: var(--sp-4); container-type: inline-size; }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	.hints { padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-1); }
	.hints strong { font-weight: var(--fw-medium); color: var(--default); }
	.rules { list-style: none; margin: 0; padding: 0; }
	.rules li { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; padding: var(--sp-3) 0; border-top: 1px solid var(--border-color); }
	.rules li:first-child { border-top: 0; padding-top: 0; }
	.device { display: flex; flex-direction: column; min-width: 0; }
	.device strong { color: var(--heading-color); font-weight: var(--fw-medium); }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-xs); overflow-wrap: anywhere; }
	.rule-actions { display: flex; align-items: center; gap: var(--sp-2); }
	.add { display: flex; gap: var(--sp-2); max-width: 28rem; }
	.grow { flex: 1; min-width: 0; display: grid; }
</style>
