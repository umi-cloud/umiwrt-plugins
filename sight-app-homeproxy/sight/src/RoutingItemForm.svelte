<script>
	import { untrack } from 'svelte';
	import { t, useEditor, Input, Select, Checkbox, Field, FormActions, ErrorSummary, Disclosure, RadioGroup } from '@sight/sdk';
	import { URLTEST } from './constants.js';
import { outboundForm, rulesetForm, dnsForm, planOutbound, planRuleset, planDns, validateOutbound, validateRuleset, validateDns, parseDnsAddress, guessFormat, DIRECT, BUILTIN_DNS } from './routing.js';
import { dnsName, kindName } from './labels.js';
import { showErrors } from './draft.svelte.js';

	/* 出站 / 规则集 / DNS 服务器表单（放在自定义分流的抽屉里）。kind 为 outbound | ruleset | dns，raw 为原有节，新建为空。 */
	let { kind, raw = null, custom, nodes, locked = false, saving = false, onsubmit, oncancel } = $props();
	/* 打开抽屉时取一次初值，之后页面数据重载不影响正在编辑的表单；新出站默认选还没有出站使用的节点 */
	const id = untrack(() => raw?.['.name'] || '');
	const form = $state(untrack(() => {
		const f = { outbound: outboundForm, ruleset: rulesetForm, dns: dnsForm }[kind](raw || {});
		if (!raw && kind === 'outbound') f.node = nodes.find(n => !custom.outbounds.some(o => o.node === n.id))?.id || '';
		return f;
	}));
	const baseline = JSON.stringify(form);
	const dirty = $derived(JSON.stringify(form) !== baseline);
	useEditor(() => ({ dirty }));
	let errors = $state([]), summary = $state(), advancedOpen = $state(false);
	const fid = k => `hp-${kind}-${k}`;
	const err = k => errors.find(e => e.field === fid(k))?.text || '';
	/* 可选的上游：启用的出站，不含自己 */
	const outbounds = $derived(custom.outbounds.filter(o => o.id !== id));
	/* 规则集格式随地址后缀推断，用户改过格式后不再自动改 */
	let formatTouched = untrack(() => !!raw);
	function urlInput() { if (!formatTouched) form.format = guessFormat(form.url); }
	const dnsType = $derived(parseDnsAddress(form.address)?.type || '');

	async function submit(event) {
		event.preventDefault();
		if (locked) return;
		const list = kind === 'outbound' ? validateOutbound(form, custom, nodes, id) : kind === 'ruleset' ? validateRuleset(form, custom) : validateDns(form, custom, id);
		({ errors } = await showErrors(list, fid, { summary, openAdvanced: () => advancedOpen = true }));
		if (errors.length) return;
		const plan = kind === 'outbound' ? planOutbound : kind === 'ruleset' ? planRuleset : planDns;
		await onsubmit(plan(form, raw || {}));
	}
</script>

{#snippet text(key, label, opts = {})}
	<Field id={fid(key)} {label} help={opts.help || ''} error={err(key)}>
		<Input id={fid(key)} bind:value={form[key]} disabled={locked} placeholder={opts.placeholder || ''} inputmode={opts.inputmode} oninput={opts.oninput}
			spellcheck="false" autocomplete="off" aria-invalid={!!err(key)} aria-describedby={opts.help ? `${fid(key)}-help` : undefined} />
	</Field>
{/snippet}
{#snippet outboundOptions(direct)}
	{#if direct}<option value={DIRECT}>{direct}</option>{/if}
	{#each outbounds as o (o.id)}<option value={o.id} disabled={!o.enabled}>{o.enabled ? o.label : t('%s (off)', o.label)}</option>{/each}
{/snippet}

<form class="hp-form" onsubmit={submit} aria-label={kindName(kind)} data-hp-item-form={kind}>
	<ErrorSummary {errors} bind:this={summary} />
	{@render text('label', t('Name'))}

	{#if kind === 'outbound'}
		<Field id={fid('node')} label={t('Node')} error={err('node')}>
			<Select id={fid('node')} bind:value={form.node} disabled={locked} aria-invalid={!!err('node')}>
				{#if !form.node}<option value="" disabled>{t('Choose a node')}</option>{/if}
				{#each nodes as n (n.id)}<option value={n.id}>{n.label}</option>{/each}
				<option value={URLTEST}>{t('Fastest of several nodes (auto)')}</option>
				{#if form.node && form.node !== URLTEST && !nodes.some(n => n.id === form.node)}<option value={form.node}>{form.node}</option>{/if}
			</Select>
		</Field>
		{#if form.node === URLTEST}
			<fieldset class="hp-fieldset" id={fid('urltest_nodes')} tabindex="-1">
				<legend>{t('Nodes to choose from')}</legend>
				<div class="scroll">
					{#each nodes as n (n.id)}
						<Checkbox checked={form.urltest_nodes.includes(n.id)} disabled={locked}
							onchange={e => form.urltest_nodes = e.currentTarget.checked ? [...form.urltest_nodes, n.id] : form.urltest_nodes.filter(x => x !== n.id)}>{n.label}</Checkbox>
					{/each}
				</div>
				{#if err('urltest_nodes')}<small class="hp-error">{err('urltest_nodes')}</small>{/if}
			</fieldset>
			<Disclosure title={t('Advanced')} bind:open={advancedOpen}>
				<div class="hp-advanced">
					{@render text('urltest_url', t('Test address'), { placeholder: 'https://www.gstatic.com/generate_204' })}
					{@render text('urltest_interval', t('Test interval (seconds)'), { inputmode: 'numeric', placeholder: '180' })}
					{@render text('urltest_tolerance', t('Tolerance (ms)'), { inputmode: 'numeric', placeholder: '50', help: t('Switch only when another node is faster by more than this.') })}
				</div>
			</Disclosure>
		{:else}
			<Field id={fid('detour')} label={t('Connect through')} help={t('Chain proxy: reach this node through another outbound first.')} error={err('detour')}>
				<Select id={fid('detour')} bind:value={form.detour} disabled={locked} aria-invalid={!!err('detour')} aria-describedby={`${fid('detour')}-help`}>
					<option value="">{t('Directly')}</option>
					{@render outboundOptions('')}
				</Select>
			</Field>
		{/if}

	{:else if kind === 'ruleset'}
		<RadioGroup name="hp-ruleset-type" label={t('Source')} bind:value={form.type} disabled={locked} options={[{ value: 'remote', label: t('Download') }, { value: 'local', label: t('File on the router') }]} />
		{#if form.type === 'remote'}
			{@render text('url', t('Address'), { placeholder: 'https://example.com/geosite-cn.srs', oninput: urlInput })}
		{:else}
			{@render text('path', t('File path'), { placeholder: '/etc/homeproxy/ruleset/example.json' })}
		{/if}
		<Field id={fid('format')} label={t('Format')}>
			<Select id={fid('format')} bind:value={form.format} disabled={locked} onchange={() => formatTouched = true}>
				<option value="binary">{t('Binary (.srs)')}</option>
				<option value="source">{t('Source (.json)')}</option>
			</Select>
		</Field>
		{#if form.type === 'remote'}
			<Disclosure title={t('Advanced')} bind:open={advancedOpen}>
				<div class="hp-advanced">
					<Field id={fid('outbound')} label={t('Download through')} error={err('outbound')}>
						<Select id={fid('outbound')} bind:value={form.outbound} disabled={locked} aria-invalid={!!err('outbound')}>
							<option value="">{t('Default outbound')}</option>
							{@render outboundOptions(t('Direct'))}
						</Select>
					</Field>
					{@render text('update_interval', t('Update interval'), { placeholder: '1d' })}
				</div>
			</Disclosure>
		{/if}

	{:else}
		{@render text('address', t('Address'), { placeholder: 'tls://1.1.1.1', help: t('Plain addresses use UDP. tcp://, tls://, https://, h3:// and quic:// are also accepted.') })}
		<Field id={fid('outbound')} label={t('Query through')} error={err('outbound')}>
			<Select id={fid('outbound')} bind:value={form.outbound} disabled={locked} aria-invalid={!!err('outbound')}>
				{@render outboundOptions(t('Direct'))}
			</Select>
		</Field>
		<Disclosure title={t('Advanced')} bind:open={advancedOpen}>
			<div class="hp-advanced">
				<Field id={fid('resolver')} label={t('Resolve the server name with')} help={t('Needed when the address is a domain name.')} error={err('resolver')}>
					<Select id={fid('resolver')} bind:value={form.resolver} disabled={locked} aria-invalid={!!err('resolver')} aria-describedby={`${fid('resolver')}-help`}>
						<option value="">{t('Default')}</option>
						{#each BUILTIN_DNS as d}<option value={d}>{dnsName(custom, d)}</option>{/each}
						{#each custom.dnsServers.filter(d => d.id !== id) as d (d.id)}<option value={d.id} disabled={!d.enabled}>{d.label}</option>{/each}
					</Select>
				</Field>
				{#if dnsType && !['udp', 'tcp'].includes(dnsType)}{@render text('tls_sni', t('Server name (SNI)'))}{/if}
			</div>
		</Disclosure>
	{/if}

	<Checkbox bind:checked={form.enabled} disabled={locked}>{t('Turned on')}</Checkbox>
	<FormActions busy={saving} disabled={locked || (!dirty && !!raw)} {oncancel} saveLabel={raw ? t('Save') : t('Add')}
		description={t('Changes take effect when you save. If the device becomes unreachable, they roll back automatically.')} />
</form>

<style>
	.scroll { display: flex; flex-direction: column; gap: var(--sp-2); max-height: 16rem; overflow: auto; }
</style>
