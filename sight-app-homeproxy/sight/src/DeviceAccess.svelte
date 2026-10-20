<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, client, uci, createClients, isMac, useEditor, Card, RadioGroup, Checkbox, Field, Input, Button, Feedback, FormActions } from '@sight/sdk';
	import { ACCESS } from './constants.js';
	import { accessForm, macsForMode, deviceRows } from './access.js';
	import { accessLabel, accessHint, listText } from './labels.js';
	import { createDraft } from './draft.svelte.js';
	import DeviceRules from './DeviceRules.svelte';

	/* 设备分区：哪些设备走代理（按 MAC 的名单），下面是按设备规则（DeviceRules）。设备列表为在线客户端加已保存的 MAC。 */
	let { data, svc, locked = false, saving = false, write, active = false } = $props();
	const clientsSvc = createClients(client, uci);
	let alive = true;
	onDestroy(() => { alive = false; });

	const draft = createDraft(() => accessForm(data.access));
	$effect(() => { data; draft.sync(); });
	const form = $derived(draft.value);
	useEditor(() => ({ dirty: draft.dirty }));

	/* 读取失败单独提示并可重试，不显示成「没有设备」 */
	let clients = $state(null), clientsError = $state('');
	async function loadClients() {
		clientsError = '';
		try { const r = await clientsSvc.load(); if (alive) clients = r.clients; }
		catch (e) { if (alive) clientsError = errorText(e); }
	}
	$effect(() => { if (active && !clients && !clientsError) loadClients(); });
	const rows = $derived(deviceRows(clients || [], data.access, form.macs));

	let macDraft = $state(''), macError = $state('');
	function addMac() {
		const mac = macDraft.trim().toUpperCase();
		if (!isMac(mac)) { macError = t('Invalid MAC address'); return; }
		macError = ''; macDraft = '';
		if (!form.macs.includes(mac)) form.macs = [...form.macs, mac];
	}
	const toggleDevice = (mac, on) => { form.macs = on ? [...new Set([...form.macs, mac])] : form.macs.filter(m => m !== mac); };
	/* 切换名单类型时带出该名单已保存的设备 */
	const changeMode = mode => { form.macs = macsForMode(data.access, mode, form.macs); form.mode = mode; };
	async function save(event) {
		event.preventDefault();
		const { mode, macs } = form;
		await write(() => svc.saveAccess(mode, macs));
	}
	const deviceMeta = d => listText([d.ip, d.name || d.ip ? d.mac : '', d.online ? '' : t('Offline')].filter(Boolean));
</script>

<div class="hp-stack">
	<Card>
		<form class="hp-form" onsubmit={save} aria-label={t('Devices using the proxy')}>
			<RadioGroup name="hp-access" label={t('Which devices use the proxy')} value={form.mode} disabled={locked} onchange={changeMode} options={ACCESS.map(m => ({ value: m, label: accessLabel(m) }))} />
			<p class="hp-note">{accessHint(form.mode)}</p>
			{#if form.mode !== 'disabled'}
				<fieldset class="hp-fieldset" data-hp-devices>
					<legend>{form.mode === 'listed_only' ? t('Devices that use the proxy') : t('Devices that go out directly')}</legend>
					{#if clientsError}<Feedback tone="error" message={t('Devices could not be read: %s', clientsError)} onretry={loadClients} compact />
					{:else if clients === null}<Feedback tone="loading" message={t('Loading…')} compact />
					{:else if !rows.length}<Feedback tone="empty" message={t('No devices found')} compact />
					{:else}
						{#each rows as d (d.mac)}
							<Checkbox checked={form.macs.includes(d.mac)} disabled={locked} onchange={e => toggleDevice(d.mac, e.currentTarget.checked)}>
								<span class="hp-device"><strong>{d.name || d.ip || d.mac}</strong><span class="hp-muted hp-mono">{deviceMeta(d)}</span></span>
							</Checkbox>
						{/each}
					{/if}
				</fieldset>
				<Field id="hp-mac" label={t('Add a device by MAC address')} error={macError}>
					<div class="hp-add mac-add">
						<span class="hp-grow"><Input id="hp-mac" bind:value={macDraft} disabled={locked} placeholder="AA:BB:CC:DD:EE:FF" spellcheck="false" autocomplete="off" aria-invalid={!!macError}
							onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); addMac(); } }} /></span>
						<Button onclick={addMac} disabled={locked || !macDraft.trim()}>{t('Add')}</Button>
					</div>
				</Field>
			{/if}
			<FormActions busy={saving} disabled={locked || !draft.dirty} description={t('Rules by IP address already in the configuration are kept unchanged.')} />
		</form>
	</Card>
	<DeviceRules {data} {svc} {locked} {saving} {write} devices={rows} loading={clients === null && !clientsError} />
</div>
