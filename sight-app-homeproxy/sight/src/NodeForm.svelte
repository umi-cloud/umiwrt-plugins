<script>
	import { tick, untrack } from 'svelte';
	import { t, useEditor, Input, Select, Checkbox, Field, FormSection, FormActions, ErrorSummary, Disclosure, DynamicList, Callout, Feedback } from '@sight/sdk';
	import { NODE_TYPES, QUIC_TYPES, SS_METHODS, VMESS_SECURITY, VLESS_FLOWS, UTLS, PACKET_ENCODINGS, SS_PLUGINS, SOCKS_VERSIONS, TUIC_CONGESTION, TUIC_RELAY, HY2_OBFS,
		TRANSPORTS, nodeForm, planNode, validateNode, supported, hasTls, tlsRequired, hasTransport } from './node.js';

	/* 节点编辑表单（放在页面的抽屉里）：常用项在前，其余进「高级」。target 为 { id, raw, subscribed }，新建时 id 与 raw 为空。
	   onsubmit(plan) 写入并应用，成功由页面关闭抽屉；未保存的改动经 useEditor 参与离开确认。 */
	let { target, features = {}, locked = false, onsubmit, oncancel } = $props();
	/* 打开抽屉时取一次初值，之后页面数据重载不影响正在编辑的表单 */
	const form = $state(untrack(() => nodeForm(target.raw)));
	const baseline = JSON.stringify(form);
	const dirty = $derived(JSON.stringify(form) !== baseline);
	useEditor(() => ({ dirty }));
	let errors = $state([]), summary = $state();
	const fid = k => `hp-node-${k}`;
	const err = k => errors.find(e => e.field === fid(k))?.text || '';
	const known = supported(form.type);
	let advancedOpen = $state(false);

	const TYPE_LABELS = { shadowsocks: 'Shadowsocks', vmess: 'VMess', vless: 'VLESS', trojan: 'Trojan', hysteria2: 'Hysteria2', tuic: 'TUIC', socks: 'SOCKS', http: 'HTTP' };
	const TRANSPORT_LABELS = { ws: 'WebSocket', grpc: 'gRPC', http: 'HTTP/2', httpupgrade: 'HTTPUpgrade' };
	/* 当前值不在预设里时（旧配置、订阅来的少见取值）仍列出，避免下拉框把它悄悄换掉 */
	const withCurrent = (values, v) => values.includes(v) ? values : [...values, v];
	const tls = $derived(tlsRequired(form.type) || form.tls);
	const reality = $derived(form.type === 'vless' && tls && form.tls_reality);

	async function submit(event) {
		event.preventDefault();
		if (locked) return;
		errors = validateNode(form, features).map(e => ({ text: t(e.msg, ...(e.args || [])), field: fid(e.field) }));
		/* 出错的字段在「高级」里时先展开 */
		if (errors.some(e => document.getElementById(e.field)?.closest('details:not([open])'))) advancedOpen = true;
		if (errors.length) { await tick(); summary?.focus(); return; }
		await onsubmit(planNode(form, target.raw));
	}
</script>

{#snippet text(key, label, opts = {})}
	<Field id={fid(key)} {label} help={opts.help || ''} error={err(key)}>
		<Input id={fid(key)} bind:value={form[key]} disabled={locked} type={opts.type || 'text'} placeholder={opts.placeholder || ''} inputmode={opts.inputmode}
			spellcheck="false" autocomplete="off" aria-invalid={!!err(key)} aria-describedby={opts.help ? `${fid(key)}-help` : undefined} />
	</Field>
{/snippet}
{#snippet choice(key, label, values, labels = {}, help = '')}
	<Field id={fid(key)} {label} {help} error={err(key)}>
		<Select id={fid(key)} bind:value={form[key]} disabled={locked} aria-invalid={!!err(key)} aria-describedby={help ? `${fid(key)}-help` : undefined}>
			{#each withCurrent(values, form[key]) as v}<option value={v}>{labels[v] ?? (v || t('None'))}</option>{/each}
		</Select>
	</Field>
{/snippet}
{#snippet many(key, label, placeholder, help = '')}
	<Field id={fid(key)} {label} {help} error={err(key)}>
		<DynamicList id={fid(key)} bind:values={form[key]} disabled={locked} {placeholder} spellcheck="false" autocomplete="off" aria-describedby={help ? `${fid(key)}-help` : undefined} />
	</Field>
{/snippet}

<form class="form" onsubmit={submit} aria-label={t('Node')} data-hp-node-form>
	{#if target.subscribed}<Callout tone="warning" message={t('This node came from a subscription. Your changes will be overwritten at the next subscription update.')} />{/if}
	<ErrorSummary {errors} bind:this={summary} />

	<FormSection title={t('Server')}>
		{@render text('label', t('Name'), { placeholder: form.address ? `${form.address}:${form.port}` : '' })}
		{#if known}
			<Field id={fid('type')} label={t('Protocol')} error={err('type')}>
				<Select id={fid('type')} bind:value={form.type} disabled={locked} aria-invalid={!!err('type')}>
					{#each NODE_TYPES as v}<option value={v} disabled={QUIC_TYPES.includes(v) && !features.with_quic && form.type !== v}>{TYPE_LABELS[v]}</option>{/each}
				</Select>
			</Field>
		{:else}
			<Feedback tone="info" message={t('%s nodes can only have their name, address and port changed here. Other settings are kept as they are.', form.type.toUpperCase())} compact />
		{/if}
		<div class="pair">
			{@render text('address', t('Server address'), { placeholder: 'example.com' })}
			{@render text('port', t('Port'), { inputmode: 'numeric', placeholder: '443' })}
		</div>
	</FormSection>

	{#if known}
		<FormSection title={t('Account')}>
			{#if form.type === 'shadowsocks'}
				{@render choice('shadowsocks_encrypt_method', t('Encryption method'), SS_METHODS)}
				{@render text('password', t('Password'), { type: 'password' })}
			{:else if form.type === 'vmess'}
				{@render text('uuid', 'UUID')}
				{@render choice('vmess_encrypt', t('Encryption method'), VMESS_SECURITY)}
			{:else if form.type === 'vless'}
				{@render text('uuid', 'UUID')}
				{@render choice('vless_flow', t('Flow control'), VLESS_FLOWS)}
			{:else if form.type === 'trojan'}
				{@render text('password', t('Password'), { type: 'password' })}
			{:else if form.type === 'hysteria2'}
				{@render text('password', t('Password'), { type: 'password' })}
				{@render choice('hysteria_obfs_type', t('Obfuscation'), HY2_OBFS, { salamander: 'Salamander' })}
				{#if form.hysteria_obfs_type}{@render text('hysteria_obfs_password', t('Obfuscation password'), { type: 'password' })}{/if}
			{:else if form.type === 'tuic'}
				{@render text('uuid', 'UUID')}
				{@render text('password', t('Password'), { type: 'password' })}
				{@render choice('tuic_congestion_control', t('Congestion control'), TUIC_CONGESTION, { cubic: 'CUBIC', new_reno: 'New Reno', bbr: 'BBR' })}
			{:else if form.type === 'socks'}
				{@render choice('socks_version', t('Version'), SOCKS_VERSIONS, { 5: 'SOCKS5', '4a': 'SOCKS4A', 4: 'SOCKS4' })}
				{@render text('username', t('Username'), { help: t('Leave empty if the server needs no sign-in.') })}
				{#if form.socks_version === '5'}{@render text('password', t('Password'), { type: 'password' })}{/if}
			{:else if form.type === 'http'}
				{@render text('username', t('Username'), { help: t('Leave empty if the server needs no sign-in.') })}
				{@render text('password', t('Password'), { type: 'password' })}
			{/if}
		</FormSection>

		{#if hasTls(form.type)}
			<FormSection title={t('Encryption')} description={tlsRequired(form.type) ? t('This protocol always uses TLS.') : ''}>
				{#if !tlsRequired(form.type)}<Checkbox bind:checked={form.tls} disabled={locked}>{t('Use TLS')}</Checkbox>{/if}
				{#if tls}
					{@render text('tls_sni', t('Server name (SNI)'), { placeholder: form.address, help: t('Leave empty to use the server address.') })}
					{#if form.type === 'vless'}
						<Checkbox bind:checked={form.tls_reality} disabled={locked}>REALITY</Checkbox>
						{#if reality}
							{@render text('tls_reality_public_key', t('REALITY public key'))}
							{@render text('tls_reality_short_id', t('REALITY short ID'))}
							{#if features.with_utls}{@render choice('tls_utls', t('uTLS fingerprint'), UTLS)}{/if}
						{/if}
					{/if}
				{/if}
			</FormSection>
		{/if}

		{#if hasTransport(form.type)}
			<FormSection title={t('Transport')}>
				{@render choice('transport', t('Type'), TRANSPORTS, { '': 'TCP', ...TRANSPORT_LABELS })}
				{#if form.transport === 'ws'}
					{@render text('ws_host', t('Host'), { placeholder: form.tls_sni || form.address })}
					{@render text('ws_path', t('Path'), { placeholder: '/' })}
				{:else if form.transport === 'grpc'}
					{@render text('grpc_servicename', t('Service name'))}
				{:else if form.transport === 'http'}
					{@render many('http_host', t('Host'), 'example.com')}
					{@render text('http_path', t('Path'), { placeholder: '/' })}
				{:else if form.transport === 'httpupgrade'}
					{@render text('httpupgrade_host', t('Host'), { placeholder: form.address })}
					{@render text('http_path', t('Path'), { placeholder: '/' })}
				{/if}
			</FormSection>
		{/if}

		<Disclosure title={t('Advanced')} description={t('Usually filled in by share links and subscriptions.')} bind:open={advancedOpen}>
			<div class="advanced">
				{#if form.type === 'shadowsocks'}
					{@render choice('shadowsocks_plugin', t('Plugin'), SS_PLUGINS)}
					{#if form.shadowsocks_plugin}{@render text('shadowsocks_plugin_opts', t('Plugin options'))}{/if}
				{/if}
				{#if ['shadowsocks', 'socks'].includes(form.type)}<Checkbox bind:checked={form.udp_over_tcp} disabled={locked}>{t('UDP over TCP')}</Checkbox>{/if}
				{#if form.type === 'vmess'}{@render text('vmess_alterid', t('Alter ID'), { inputmode: 'numeric', placeholder: '0' })}{/if}
				{#if ['vmess', 'vless'].includes(form.type)}{@render choice('packet_encoding', t('Packet encoding'), PACKET_ENCODINGS, { xudp: 'XUDP', packetaddr: 'packetaddr' })}{/if}
				{#if form.type === 'hysteria2'}
					<div class="pair">
						{@render text('hysteria_up_mbps', t('Upload (Mbps)'), { inputmode: 'numeric' })}
						{@render text('hysteria_down_mbps', t('Download (Mbps)'), { inputmode: 'numeric' })}
					</div>
					{@render many('hysteria_hopping_port', t('Port hopping'), '20000:30000')}
					{#if form.hysteria_hopping_port.length}{@render text('hysteria_hop_interval', t('Hop interval (seconds)'), { inputmode: 'numeric', placeholder: '30' })}{/if}
				{/if}
				{#if form.type === 'tuic'}
					{@render choice('tuic_udp_relay_mode', t('UDP relay mode'), TUIC_RELAY, { '': t('Default'), native: 'native', quic: 'QUIC' })}
					<Checkbox bind:checked={form.tuic_enable_zero_rtt} disabled={locked}>{t('0-RTT handshake')}</Checkbox>
					{@render text('tuic_heartbeat', t('Heartbeat interval (seconds)'), { inputmode: 'numeric', placeholder: '10' })}
				{/if}
				{#if hasTls(form.type) && tls}
					{@render many('tls_alpn', 'ALPN', 'h2')}
					{#if !reality && !tlsRequired(form.type) && features.with_utls}{@render choice('tls_utls', t('uTLS fingerprint'), UTLS)}{/if}
					<Checkbox bind:checked={form.tls_insecure} disabled={locked}>{t('Skip certificate verification (insecure)')}</Checkbox>
				{/if}
				{#if hasTransport(form.type) && form.transport === 'ws'}
					<div class="pair">
						{@render text('websocket_early_data', t('Early data (bytes)'), { inputmode: 'numeric', placeholder: '2048' })}
						{@render text('websocket_early_data_header', t('Early data header'), { placeholder: 'Sec-WebSocket-Protocol' })}
					</div>
				{/if}
			</div>
		</Disclosure>
	{/if}

	<FormActions busy={locked} disabled={!dirty && !!target.id} {oncancel} saveLabel={target.id ? t('Save') : t('Add node')}
		description={t('Changes take effect when you save. If the device becomes unreachable, they roll back automatically.')} />
</form>

<style lang="less">
	.form { display: flex; flex-direction: column; gap: var(--sp-5); }
	.pair { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: var(--sp-3); }
	.advanced { display: flex; flex-direction: column; gap: var(--sp-4); }
</style>
