<script>
	import { t, Card, Select, Input, Switch, SettingRow, SettingsGroup, RadioGroup, Disclosure, Feedback, FormActions, ErrorSummary } from '@sight/sdk';
	import { MODES, CUSTOM, SAME, OFF, DNS_PRESETS, CHINA_DNS_PRESETS, PORT_CHOICES, TEMPLATE_BY_MODE } from './constants.js';
	import { TEMPLATES } from './routing.js';
	import { routingForm, routingValues, routingKey, validateRouting } from './traffic.js';
	import { modeLabel, templateLabel, templateHint, dnsLabel, udpLabel, portsLabel, listText } from './labels.js';
	import { createDraft, showErrors } from './draft.svelte.js';

	/* 分流表单：分流模式（含切到自定义时的初始模板）、DNS，「高级」里是 UDP、走代理的端口与 IPv6。
	   自定义分流模式下只剩端口与 IPv6，出站与规则在下方的自定义分流里管理。 */
	let { data, svc, locked = false, saving = false, write } = $props();
	const draft = createDraft(() => routingForm(data), { key: routingKey });
	$effect(() => { data; draft.sync(); });
	const form = $derived(draft.value);
	const isCustom = $derived(data.mode === CUSTOM);
	/* 切到自定义时的初始配置，按当前模式给出最接近的一种；只在选了自定义时有意义，不计入草稿 */
	let template = $state('blank');
	$effect(() => { template = TEMPLATE_BY_MODE[data.mode] || 'blank'; });

	let errors = $state([]), summary = $state();
	const FIELD_IDS = { mode: 'hp-mode', udpNode: 'hp-udp', dnsCustom: 'hp-dns-custom', chinaCustom: 'hp-china-custom', portsCustom: 'hp-ports-custom' };
	const fid = k => FIELD_IDS[k] || k;
	const err = id => errors.find(e => e.field === id)?.text || '';
	/* 「高级」默认收起；用着非默认值或其中有校验错误时展开，不让生效中的设置藏起来 */
	let advancedOpen = $state(false);
	$effect(() => { if (data.udpNode !== SAME || data.ports !== 'common' || !data.ipv6) advancedOpen = true; });

	async function submit(event) {
		event.preventDefault();
		if (locked) return;
		const r = routingValues(form);
		({ errors } = await showErrors(validateRouting(r, data.nodes), fid, { summary, openAdvanced: () => advancedOpen = true }));
		if (errors.length) return;
		/* 切到自定义：没有自定义配置时按所选模板建立；切回预设模式：主节点按代理开关状态确定 */
		if (r.mode === CUSTOM && !isCustom) { const tpl = template; await write(async () => { await svc.enterCustom(data, tpl, t); await svc.saveTraffic(r); }, t('Switched to custom routing.')); }
		else if (r.mode !== CUSTOM && isCustom) await write(() => svc.leaveCustom(data, r));
		else if (r.mode !== CUSTOM) await write(() => svc.saveRouting(r));
		else await write(() => svc.saveTraffic(r));
	}
	const portsHint = p => p === 'common' ? t('Only traffic to common ports (%s) goes through the proxy; other ports go out directly. If games or apps on other ports are not proxied, choose all ports.', listText(data.commonPorts.split(',')))
		: p === 'all' ? t('Traffic to any port can go through the proxy.') : t('Only traffic to these ports goes through the proxy; other ports go out directly. Separate ports with commas; ranges such as 8000-9000 are allowed.');
	const templateNode = $derived(data.nodes.find(n => n.id === data.mainNode) || data.nodes[0]);
</script>

{#snippet presetPicker(id, key, customKey, presets, placeholder, label)}
	<div class="picker">
		<Select {id} aria-describedby="{id}-description" bind:value={form[key]} disabled={locked} aria-label={label}>
			{#each presets as v}<option value={v}>{dnsLabel(v)}</option>{/each}
			<option value="custom">{t('Custom…')}</option>
		</Select>
		{#if form[key] === 'custom'}
			<Input id="{id}-custom" bind:value={form[customKey]} disabled={locked} {placeholder} spellcheck="false" aria-label={t('Custom %s', label)} aria-invalid={!!err(`${id}-custom`)} />
		{/if}
	</div>
{/snippet}

<Card>
	<form class="hp-form" onsubmit={submit} aria-label={t('Routing')}>
		<ErrorSummary {errors} bind:this={summary} />
		<SettingsGroup title={t('Routing')}>
			<SettingRow id="hp-mode" label={t('What goes through the proxy')} description={form.mode === CUSTOM ? t('Your own rules decide where each kind of traffic goes. Set them up below.') : t('Traffic not covered goes out directly.')}>
				<Select id="hp-mode" aria-describedby="hp-mode-description" bind:value={form.mode} disabled={locked} aria-label={t('What goes through the proxy')}>
					{#each [...MODES, CUSTOM] as m}<option value={m}>{modeLabel(m)}</option>{/each}
				</Select>
			</SettingRow>
			{#if form.mode === CUSTOM && !isCustom}
				{#if data.custom.outbounds.length}
					<p class="hp-note" data-hp-template="existing">{t('Your previous custom routing setup will be used again.')}</p>
				{:else if !data.nodes.length}
					<Feedback tone="info" message={t('Add a node first. Custom routing sends traffic to outbounds that use your nodes.')} compact />
				{:else}
					<RadioGroup name="hp-template" label={t('Start with')} bind:value={template} disabled={locked} options={TEMPLATES.map(v => ({ value: v, label: templateLabel(v) }))} />
					<p class="hp-note" data-hp-template-hint>{templateHint(template)} {t('The proxy uses %s. You can change every rule afterwards.', templateNode.label)}</p>
				{/if}
			{/if}
		</SettingsGroup>
		{#if form.mode !== CUSTOM}
			<SettingsGroup title={t('DNS')}>
				<SettingRow id="hp-dns" label={t('DNS server')} description={t('Resolves names for proxied traffic, through the proxy. Plain addresses use TCP; udp://, tls:// and https:// addresses are also accepted.')}>
					{@render presetPicker('hp-dns', 'dns', 'dnsCustom', DNS_PRESETS, 'tls://dns.google', t('DNS server'))}
				</SettingRow>
				{#if form.mode === 'bypass_mainland_china'}
					<SettingRow id="hp-china" label={t('China DNS server')} description={t('Resolves mainland China domains so they go out directly. Plain addresses use UDP.')}>
						{@render presetPicker('hp-china', 'china', 'chinaCustom', CHINA_DNS_PRESETS, '223.5.5.5', t('China DNS server'))}
					</SettingRow>
				{/if}
			</SettingsGroup>
		{/if}
		<Disclosure title={t('Advanced')} description={t('UDP traffic, ports and IPv6')} bind:open={advancedOpen}>
			<div class="hp-advanced" data-hp-advanced>
				{#if form.mode !== CUSTOM}
					<SettingRow id="hp-udp" label={t('UDP traffic')} description={t('Games and voice calls use UDP. Send it through the main node, a different node, or directly.')}>
						<Select id="hp-udp" aria-describedby="hp-udp-description" bind:value={form.udpNode} disabled={locked} aria-label={t('UDP traffic')} aria-invalid={!!err('hp-udp')}>
							{#each [SAME, OFF] as v}<option value={v}>{udpLabel(v)}</option>{/each}
							{#each data.nodes as n (n.id)}<option value={n.id}>{n.label}</option>{/each}
							{#if ![SAME, OFF].includes(form.udpNode) && !data.nodes.some(n => n.id === form.udpNode)}<option value={form.udpNode}>{form.udpNode}</option>{/if}
						</Select>
					</SettingRow>
				{/if}
				<SettingRow id="hp-ports" label={t('Ports that use the proxy')} description={portsHint(form.ports)}>
					<div class="picker">
						<Select id="hp-ports" aria-describedby="hp-ports-description" bind:value={form.ports} disabled={locked} aria-label={t('Ports that use the proxy')}>
							{#each PORT_CHOICES as p}<option value={p}>{portsLabel(p)}</option>{/each}
						</Select>
						{#if form.ports === 'custom'}
							<Input id="hp-ports-custom" bind:value={form.portsCustom} disabled={locked} placeholder="80,443,8000-9000" spellcheck="false" autocomplete="off" aria-label={t('Custom ports')} aria-invalid={!!err('hp-ports-custom')} />
						{/if}
					</div>
				</SettingRow>
				<SettingRow id="hp-ipv6" label={t('Proxy IPv6 traffic')} description={form.ipv6 ? t('IPv6 traffic follows the same routing rules as IPv4.') : isCustom ? t('Only IPv4 traffic is proxied. With custom routing, also set “Address preference” to IPv4 only under Defaults so DNS does not hand out IPv6 addresses that bypass the proxy.') : t('Only IPv4 traffic is proxied, and DNS answers for proxied lookups contain only IPv4 addresses. Turn this off if your uplink has no IPv6 or IPv6 connections fail.')}>
					<Switch id="hp-ipv6" aria-describedby="hp-ipv6-description" checked={form.ipv6} disabled={locked} aria-label={t('Proxy IPv6 traffic')} onchange={on => form.ipv6 = on} />
				</SettingRow>
			</div>
		</Disclosure>
		<FormActions busy={saving} disabled={locked || !draft.dirty} description={t('Changes take effect when you save. If the device becomes unreachable, they roll back automatically.')} />
	</form>
</Card>

<style>
	.picker { display: flex; flex-direction: column; gap: var(--sp-2); min-width: min(100%, 16rem); }
</style>
