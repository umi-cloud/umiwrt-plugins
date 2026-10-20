<script>
	import { untrack } from 'svelte';
	import { t, useEditor, Input, Select, Checkbox, Field, FormSection, FormActions, ErrorSummary, Disclosure, DynamicList, Feedback } from '@sight/sdk';
	import { ruleForm, dnsRuleForm, planRule, planDnsRule, validateRule, validateDnsRule, conditions, BLOCK_TARGET, KEEP_TARGET, DIRECT, BUILTIN_DNS, NETWORKS } from './routing.js';
import { dnsName, listText } from './labels.js';
import { showErrors } from './draft.svelte.js';

	/* 分流规则 / DNS 规则表单（放在自定义分流的抽屉里）。raw 为原有节，新建为空；dns 为 true 时编辑 DNS 规则。
	   常用条件在前，精确域名、网络类型、反选等进「高级」；表单不管理的条件原样保留并提示。 */
	let { dns = false, raw = null, custom, locked = false, saving = false, onsubmit, oncancel } = $props();
	const prefix = untrack(() => dns ? 'hp-dnsrule' : 'hp-rule');
	const initial = () => {
		if (raw) return dns ? dnsRuleForm(raw) : ruleForm(raw);
		const f = dns ? dnsRuleForm() : ruleForm();
		/* 新规则默认交给第一个启用的出站（多半是代理）/ 第一个 DNS 服务器 */
		f.target = dns ? custom.dnsServers.find(d => d.enabled)?.id || 'default-dns' : custom.outbounds.find(o => o.enabled)?.id || DIRECT;
		return f;
	};
	const form = $state(untrack(initial));
	const baseline = JSON.stringify(form);
	const dirty = $derived(JSON.stringify(form) !== baseline);
	useEditor(() => ({ dirty }));
	let errors = $state([]), summary = $state(), advancedOpen = $state(false);
	const fid = k => `${prefix}-${k}`;
	/* 当前去向是否在选项里；不在时（引用的对象已删）仍列出，避免下拉框把它悄悄换掉 */
	const knownTarget = v => !v || [KEEP_TARGET, BLOCK_TARGET, DIRECT, ...BUILTIN_DNS].includes(v) || (dns ? custom.dnsServers : custom.outbounds).some(x => x.id === v);
	const err = k => errors.find(e => e.field === fid(k))?.text || '';
	/* 表单之外的条件（进程、端口范围、正则等）：保存时原样保留 */
	const { others, action } = untrack(() => {
		const managed = dns ? ['domain_suffix', 'domain', 'domain_keyword', 'source_ip_cidr', 'rule_set'] : ['domain_suffix', 'domain', 'domain_keyword', 'ip_cidr', 'source_ip_cidr', 'port', 'rule_set', 'network', 'ip_is_private'];
		return { others: raw ? conditions(raw, dns).filter(([k]) => !managed.includes(k)).map(([k]) => k) : [], action: raw?.action || 'route' };
	});

	async function submit(event) {
		event.preventDefault();
		if (locked) return;
		const list = dns ? validateDnsRule(form, custom, raw || {}) : validateRule(form, custom, raw || {});
		({ errors } = await showErrors(list, fid, { summary, openAdvanced: () => advancedOpen = true }));
		if (errors.length) return;
		await onsubmit(dns ? planDnsRule(form, raw || {}) : planRule(form, raw || {}));
	}
</script>

{#snippet many(key, label, placeholder, help = '')}
	<Field id={fid(key)} {label} {help} error={err(key)}>
		<DynamicList id={fid(key)} bind:values={form[key]} disabled={locked} {placeholder} spellcheck="false" autocomplete="off" aria-invalid={!!err(key)} aria-describedby={help ? `${fid(key)}-help` : undefined} />
	</Field>
{/snippet}

<form class="hp-form" onsubmit={submit} aria-label={dns ? t('DNS rule') : t('Routing rule')} data-hp-rule-form>
	<ErrorSummary {errors} bind:this={summary} />
	<Field id={fid('label')} label={t('Name')} error={err('label')}>
		<Input id={fid('label')} bind:value={form.label} disabled={locked} autocomplete="off" aria-invalid={!!err('label')} />
	</Field>

	<FormSection title={t('Match')} description={t('Within one kind of condition any entry matches; different kinds must all match.')}>
		{@render many('domain_suffix', t('Domains'), 'example.com', t('Matches the domain and all its subdomains.'))}
		{@render many('domain_keyword', t('Domain keywords'), 'google')}
		{#if !dns}{@render many('ip_cidr', t('Destination IP addresses'), '192.0.2.0/24')}{/if}
		{@render many('source_ip_cidr', t('From devices (IP)'), '192.168.1.10', t('Addresses or ranges of devices on your network.'))}
		{#if !dns}{@render many('port', t('Destination ports'), '443')}{/if}
		<fieldset class="hp-fieldset" id={fid('rule_set')} tabindex="-1">
			<legend>{t('Rule sets')}</legend>
			{#each custom.rulesets as r (r.id)}
				<Checkbox checked={form.rule_set.includes(r.id)} disabled={locked || (!r.enabled && !form.rule_set.includes(r.id))}
					onchange={e => form.rule_set = e.currentTarget.checked ? [...form.rule_set, r.id] : form.rule_set.filter(x => x !== r.id)}>
					{r.enabled ? r.label : t('%s (off)', r.label)}
				</Checkbox>
			{:else}<p class="hp-note">{t('No rule sets yet. Add them under Rule sets.')}</p>{/each}
			{#if err('rule_set')}<small class="hp-error">{err('rule_set')}</small>{/if}
		</fieldset>
		{#if others.length}<Feedback tone="info" message={t('This rule also matches on %s. Those conditions are kept as they are.', listText(others))} compact />{/if}
	</FormSection>

	<Field id={fid('target')} label={dns ? t('Resolve with') : t('Send to')} error={err('target')}>
		<Select id={fid('target')} bind:value={form.target} disabled={locked} aria-invalid={!!err('target')}>
			{#if dns}
				{#each BUILTIN_DNS as d}<option value={d}>{dnsName(custom, d)}</option>{/each}
				{#each custom.dnsServers as d (d.id)}<option value={d.id} disabled={!d.enabled}>{d.enabled ? d.label : t('%s (off)', d.label)}</option>{/each}
				<option value={BLOCK_TARGET}>{t('Block (refuse the query)')}</option>
			{:else}
				<option value={DIRECT}>{t('Direct')}</option>
				{#each custom.outbounds as o (o.id)}<option value={o.id} disabled={!o.enabled}>{o.enabled ? o.label : t('%s (off)', o.label)}</option>{/each}
				<option value={BLOCK_TARGET}>{t('Block traffic')}</option>
			{/if}
			{#if form.target === KEEP_TARGET}<option value={KEEP_TARGET}>{t('Keep the current action (%s)', action)}</option>{/if}
			{#if !knownTarget(form.target)}
				<option value={form.target}>{form.target}</option>
			{/if}
		</Select>
	</Field>

	<Disclosure title={t('Advanced')} bind:open={advancedOpen}>
		<div class="hp-advanced">
			{@render many('domain', t('Exact domains'), 'www.example.com', t('Matches only these names, not their subdomains.'))}
			{#if !dns}
				<Field id={fid('network')} label={t('Network')}>
					<Select id={fid('network')} bind:value={form.network} disabled={locked}>
						{#each NETWORKS as n}<option value={n}>{n ? n.toUpperCase() : t('TCP and UDP')}</option>{/each}
					</Select>
				</Field>
				<Checkbox bind:checked={form.ip_is_private} disabled={locked}>{t('Match local network addresses')}</Checkbox>
			{/if}
			<Checkbox bind:checked={form.invert} disabled={locked}>{t('Invert: apply to traffic that does not match')}</Checkbox>
		</div>
	</Disclosure>
	<Checkbox bind:checked={form.enabled} disabled={locked}>{t('Turned on')}</Checkbox>

	<FormActions busy={saving} disabled={locked || (!dirty && !!raw)} {oncancel} saveLabel={raw ? t('Save') : t('Add rule')}
		description={t('Rules are checked from top to bottom; the first match wins.')} />
</form>

