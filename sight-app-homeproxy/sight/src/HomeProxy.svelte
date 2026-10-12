<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, client, route, navigate, activity, useEditor, requestLeave, editing, uci, pending, saveFlow, createClients, isMac, Card, Switch, Button, Badge, StatusHero, Callout, LogView, Select, Input, Textarea, Checkbox, RadioGroup, SettingRow, DynamicList, Field, Tabs, Drawer, Dialog, FormActions, ErrorSummary, Feedback, Table, Toolbar } from '@sight/sdk';
	import { createHomeProxy, MODES, LOGS, SITES, RESOURCES, ACCESS, DNS_PRESETS, CHINA_DNS_PRESETS, validateSubscriptions, validateRouting, previewLinks, missingResources, DOMAIN_LISTS, parseDomains, validateDomains } from './service.js';

	/* 顶部状态卡（开关、当前节点、连通性）常驻；其余按任务分区：节点、分流与 DNS、设备、订阅与规则库、日志。
	   配置保存即生效（带失联回滚）；订阅/规则库更新、连通性检查、清空日志为即时操作。 */
	const svc = createHomeProxy(client, uci);
	const clientsSvc = createClients(client, uci);
	const SECTIONS = ['nodes', 'routing', 'devices', 'subscriptions', 'logs'];
	const tabsId = $props.id();
	let section = $state(SECTIONS.includes(route.params.tab) ? route.params.tab : 'nodes');
	$effect(() => { if (SECTIONS.includes(route.params.tab)) section = route.params.tab; });

	let data = $state(undefined);   // undefined 加载中；null 未安装
	let error = $state('');
	let notice = $state(null);
	let busy = $state(false);
	let alive = true, version = 0, seenDiscard = editing.discarded;
	onDestroy(() => { alive = false; version++; });

	/* 各分区的编辑草稿；load 后按配置重置 */
	let subs = $state([]), subsDraft = $state(''), subsBaseline = $state('[]'), subsError = $state('');
	let routing = $state(null), routingBaseline = $state(''), routingErrors = $state([]), routingSummary = $state();
	let access = $state(null), accessBaseline = $state('');
	let importing = $state(null);   // { text } 打开导入抽屉时
	let removing = $state(null);
	let devices = $state(null);     // 在线客户端；null 加载中
	let devicesError = $state('');
	let checks = $state({});        // site → undefined（检查中）| true | false | 'error'
	let updating = $state(false);
	let resources = $state(null), resourcesError = $state(''), resourceBusy = $state(''), resourceResult = $state({});
	let logName = $state('homeproxy'), logText = $state(undefined), logError = $state(''), logBusy = $state(false), confirmClean = $state(false);
	const logTabsId = `${tabsId}-log`;

	const dnsChoice = v => DNS_PRESETS.includes(v) ? v : 'custom';
	const chinaChoice = v => CHINA_DNS_PRESETS.includes(v) ? v : 'custom';
	/* 重载只更新各分区基线；未保存的草稿保留，除非用户已确认放弃（editing.discarded 递增） */
	function resetDrafts(r) {
		const discarded = seenDiscard !== editing.discarded;
		seenDiscard = editing.discarded;
		const nextSubs = [...r.subscriptions];
		if (!subsDirty || discarded) { subs = [...nextSubs]; subsDraft = ''; subsError = ''; }
		subsBaseline = JSON.stringify(nextSubs);
		const nextRouting = { mode: r.mode, udpNode: r.udpNode, dns: dnsChoice(r.dnsServer), dnsCustom: dnsChoice(r.dnsServer) === 'custom' ? r.dnsServer : '',
			china: chinaChoice(r.chinaDnsServer), chinaCustom: chinaChoice(r.chinaDnsServer) === 'custom' ? r.chinaDnsServer : '' };
		if (!routingDirty || discarded) { routing = nextRouting; routingErrors = []; }
		routingBaseline = JSON.stringify(nextRouting);
		const nextAccess = { mode: r.access.mode, macs: r.access.mode === 'except_listed' ? [...r.access.directMacs] : [...r.access.proxyMacs] };
		if (!accessDirty || discarded) access = nextAccess;
		accessBaseline = JSON.stringify(nextAccess);
	}
	async function load() {
		const request = ++version;
		error = '';
		try {
			const r = await svc.load();
			if (!alive || request !== version) return;
			data = r;
			if (r) resetDrafts(r);
		} catch (e) { if (alive && request === version) error = errorText(e); }
	}
	$effect(() => { pending.version; load(); });

	const subsDirty = $derived(JSON.stringify(subs) !== subsBaseline || !!subsDraft.trim());
	const routingDirty = $derived(!!routing && JSON.stringify(routing) !== routingBaseline);
	const accessDirty = $derived(!!access && JSON.stringify(access) !== accessBaseline);
	const importDirty = $derived(!!importing?.text.trim());
	/* 订阅更新、规则库更新、清空日志都是即时操作：进行中阻止切页 */
	useEditor(() => ({ dirty: subsDirty || routingDirty || accessDirty || importDirty || domainsDirty, busy: busy || updating || !!resourceBusy || logBusy || domainsBusy }));
	const locked = $derived(busy || updating || !!resourceBusy || logBusy || domainsBusy || activity.busy);

	const modeLabel = m => ({ bypass_mainland_china: t('Proxy sites outside mainland China'), gfwlist: t('Proxy blocked sites only (GFWList)'), proxy_mainland_china: t('Proxy mainland China sites only'), global: t('Proxy everything'), custom: t('Custom routing') }[m] || m);
	const current = $derived(data?.nodes.find(n => n.id === data.mainNode) || null);
	const custom = $derived(data?.mode === 'custom');
	const heroState = $derived(!data ? '' : !data.enabled ? 'off' : data.running === false ? 'warning' : 'on');
	const heroText = $derived.by(() => {
		if (!data) return '';
		if (!data.enabled) return t('Off. All traffic goes out directly.');
		if (data.running === false) return t('On, but sing-box is not running. Check the logs.');
		return t('On. Using %s.', current?.label || data.mainNode);
	});
	const tabs = $derived([
		{ value: 'nodes', label: t('Nodes'), count: data?.nodes.length ?? 0 },
		{ value: 'routing', label: t('Routing & DNS') },
		{ value: 'devices', label: t('Devices') },
		{ value: 'subscriptions', label: t('Subscriptions & rules') },
		{ value: 'logs', label: t('Logs') },
	]);
	async function changeSection(next) { await navigate(next === 'nodes' ? '/homeproxy' : `/homeproxy?tab=${next}`); }

	/* 失败保留输入；成功后重载（草稿与新基线一致即视为已保存），可附成功提示 */
	async function write(action, success) {
		if (locked) return false;
		return saveFlow(action, {
			busy: on => { busy = on; if (on) { error = ''; notice = null; } },
			fail: e => { error = errorText(e); },
			done: async () => { if (success) notice = { tone: 'success', text: success }; await load(); },
			alive: () => alive,
		});
	}
	/* 打开代理时沿用上次的主节点，没有则用第一个节点 */
	function toggle(on) {
		if (on && !data.nodes.length) return;
		write(() => on ? svc.useNode(data.mainNode || data.nodes[0].id) : svc.turnOff());
	}
	async function check(site) {
		checks = { ...checks, [site]: undefined };
		let result;
		try { result = await svc.check(site); } catch { result = 'error'; }
		if (alive) checks = { ...checks, [site]: result };
	}
	const siteLabel = s => ({ google: 'Google', baidu: t('Baidu') }[s]);

	/* --- 节点：导入与删除 --- */
	const preview = $derived(importing && data ? previewLinks(importing.text, data.features) : []);
	const valid = $derived(preview.filter(r => r.node));
	async function openImport() { if (!await requestLeave() || locked) return; importing = { text: '' }; }
	async function closeImport() { if (importDirty && !await requestLeave()) return; importing = null; }
	async function doImport(event) {
		event.preventDefault();
		if (!valid.length) return;
		const nodes = valid.map(r => r.node);
		const ok = await write(() => svc.importNodes(nodes, data), t('Imported %d nodes.', nodes.length));
		if (ok && alive) importing = null;
	}
	async function removeNode() {
		const n = removing;
		if (!n) return;
		await write(() => svc.removeNode(n.id, data));
		if (alive) removing = null;
	}
	const nodeUse = n => n.id === data.mainNode && data.enabled ? t('Main node') : n.id === data.udpNode ? t('UDP node') : '';
	/* 订阅常带来几十上百个节点：表格列出，按名称、地址或协议检索；使用中的节点排在最前 */
	let nodeQuery = $state('');
	const nodeRows = $derived.by(() => {
		const q = nodeQuery.trim().toLowerCase();
		const list = (data?.nodes || []).filter(n => !q || `${n.label} ${n.type} ${n.address}`.toLowerCase().includes(q));
		return [...list].sort((a, b) => !!nodeUse(b) - !!nodeUse(a));
	});
	const nodeCells = n => [{ text: n.label }, { text: n.type.toUpperCase(), nowrap: true }, { text: n.address ? `${n.address}:${n.port}` : '-', mono: true }, { text: '' }, { text: n.subscribed ? t('Subscription') : t('Added manually') }];
	/* 延迟：路由器直接 ping 各节点服务器，最多 4 个同时进行；结果只保留在本页 */
	let latency = $state({});       // 节点 id → undefined | 'testing' | 毫秒 | 'timeout' | 'unsupported' | 'error'
	let testing = $state(false);
	async function testLatency() {
		if (testing) return;
		testing = true;
		const queue = [...nodeRows];
		latency = Object.fromEntries(queue.map(n => [n.id, 'testing']));
		const worker = async () => {
			for (let n = queue.shift(); n && alive; n = queue.shift()) {
				let result;
				try { result = await svc.latency(n); } catch { result = 'error'; }
				if (alive) latency = { ...latency, [n.id]: result };
			}
		};
		await Promise.all(Array.from({ length: 4 }, worker));
		if (alive) testing = false;
	}

	/* --- 自定义域名（文件，保存即写入并重载服务，不走暂存） --- */
	let domains = $state(null), domainsBase = $state(null), domainsError = $state(''), domainsLoadError = $state(''), domainsBusy = $state(false);
	let domainDrafts = $state({ proxy_list: '', direct_list: '' });
	const domainsDirty = $derived(!!domains && (JSON.stringify(domains) !== JSON.stringify(domainsBase) || DOMAIN_LISTS.some(k => domainDrafts[k].trim())));
	async function loadDomains() {
		domainsLoadError = '';
		try { const d = await svc.domainLists(); if (alive) { domainsBase = d; domains = JSON.parse(JSON.stringify(d)); } }
		catch (e) { if (alive) domainsLoadError = errorText(e); }
	}
	$effect(() => { if (section === 'routing' && data && !domains && !domainsLoadError) loadDomains(); });
	async function saveDomains(event) {
		event.preventDefault();
		if (locked) return;
		/* 输入框里还没点「添加」的内容一并收入 */
		const next = Object.fromEntries(DOMAIN_LISTS.map(k => [k, parseDomains([...domains[k], domainDrafts[k]].join('\n'))]));
		domainsError = DOMAIN_LISTS.some(k => validateDomains(next[k]).length) ? t('Enter domain names such as example.com, one per entry.') : '';
		if (domainsError) return;
		domainsBusy = true; notice = null;
		try {
			await svc.saveDomainLists(next, domainsBase, data.enabled);
			if (alive) { domainDrafts = { proxy_list: '', direct_list: '' }; notice = { tone: 'success', text: data.enabled ? t('Domain lists saved. HomeProxy was reloaded to apply them.') : t('Domain lists saved.') }; await loadDomains(); }
		} catch (e) { if (alive) domainsError = errorText(e); }
		finally { if (alive) domainsBusy = false; }
	}

	/* --- 分流与 DNS --- */
	const routingFields = { 'Choose a UDP node': 'hp-udp', 'Invalid DNS server': 'hp-dns-custom', 'Invalid China DNS server': 'hp-china-custom' };
	const routingError = id => routingErrors.find(e => e.field === id)?.text || '';
	async function saveRouting(event) {
		event.preventDefault();
		const r = { mode: routing.mode, udpNode: routing.udpNode, dnsServer: routing.dns === 'custom' ? routing.dnsCustom : routing.dns, chinaDnsServer: routing.china === 'custom' ? routing.chinaCustom : routing.china };
		routingErrors = validateRouting(r, data.nodes).map(m => ({ text: t(m), field: routingFields[m] }));
		if (routingErrors.length) { await tick(); routingSummary?.focus(); return; }
		await write(() => svc.saveRouting(r));
	}
	const dnsLabel = v => v === 'wan' ? t('Uplink DNS (from WAN)') : { '1.1.1.1': 'Cloudflare (1.1.1.1)', '8.8.8.8': 'Google (8.8.8.8)', '208.67.222.222': 'Cisco OpenDNS (208.67.222.222)', '223.5.5.5': t('Aliyun (223.5.5.5)'), '119.29.29.29': t('Tencent (119.29.29.29)'), '210.2.4.8': 'CNNIC (210.2.4.8)' }[v] || v;

	/* --- 设备 --- */
	/* 读取失败单独提示并可重试，不显示成「没有设备」 */
	async function loadDevices() {
		devicesError = '';
		try { const r = await clientsSvc.load(); if (alive) devices = r.clients; }
		catch (e) { if (alive) devicesError = errorText(e); }
	}
	$effect(() => { if (section === 'devices' && !devices && !devicesError) loadDevices(); });
	/* 在线客户端加上已保存但当前不在线的 MAC，保存时不会悄悄丢掉 */
	const deviceRows = $derived.by(() => {
		if (!access) return [];
		const online = (devices || []).filter(c => c.mac).map(c => ({ mac: c.mac.toUpperCase(), name: c.name, ip: c.ip, online: c.online }));
		const known = new Set(online.map(d => d.mac));
		const saved = [...(data?.access.proxyMacs || []), ...(data?.access.directMacs || []), ...access.macs].filter(m => !known.has(m));
		return [...online, ...[...new Set(saved)].map(mac => ({ mac, name: '', ip: '', online: false }))];
	});
	let macDraft = $state(''), macError = $state('');
	function addMac() {
		const mac = macDraft.trim().toUpperCase();
		if (!isMac(mac)) { macError = t('Invalid MAC address'); return; }
		macError = ''; macDraft = '';
		if (!access.macs.includes(mac)) access.macs = [...access.macs, mac];
	}
	function toggleDevice(mac, on) { access.macs = on ? [...new Set([...access.macs, mac])] : access.macs.filter(m => m !== mac); }
	function changeAccessMode(mode) {
		access.mode = mode;
		/* 切换名单类型时带出该名单已保存的设备 */
		access.macs = mode === 'except_listed' ? [...data.access.directMacs] : mode === 'listed_only' ? [...data.access.proxyMacs] : access.macs;
	}
	async function saveAccess(event) {
		event.preventDefault();
		const { mode, macs } = access;
		await write(() => svc.saveAccess(mode, macs));
	}
	const accessHint = m => ({ disabled: t('Every device on your network uses the proxy rules above.'), listed_only: t('Only the selected devices use the proxy; everything else goes out directly.'), except_listed: t('Selected devices always go out directly; all others use the proxy.') }[m]);

	/* --- 订阅与规则库 --- */
	function commitSubs() { const d = subsDraft.trim(); return d && !subs.includes(d) ? [...subs, d] : subs; }
	async function saveSubs(event) {
		event.preventDefault();
		const next = commitSubs();
		const errs = validateSubscriptions(next);
		subsError = errs.length ? t(errs[0]) : '';
		if (!errs.length) await write(() => svc.saveSubscriptions(next));
	}
	async function updateSubs() {
		if (locked) return;
		updating = true; notice = null;
		try {
			const r = await svc.updateSubscriptions();
			if (alive) notice = r.ok ? { tone: 'success', text: t('Subscriptions updated. Nodes are refreshed from the saved subscription addresses.') } : { tone: 'error', text: t('Subscription update failed: %s', r.output || t('unknown error')) };
		} catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { updating = false; await load(); } }
	}
	/* 代理开着时进页面就读版本：当前模式依赖的规则库缺失要在顶部提醒 */
	$effect(() => { if (data && (data.enabled || section === 'subscriptions') && !resources && !resourcesError) loadResources(); });
	const missing = $derived(data?.enabled ? missingResources(data.mode, resources) : []);
	async function downloadMissing() { for (const r of missing) await updateResource(r); }
	/* 版本读取失败不显示成「未下载」 */
	async function loadResources() {
		resourcesError = '';
		try { const r = await svc.resourceVersions(); if (alive) resources = r; } catch (e) { if (alive) resourcesError = errorText(e); }
	}
	async function updateResource(type) {
		if (locked) return;
		resourceBusy = type;
		let result;
		try { result = await svc.updateResource(type); } catch { result = 'failed'; }
		if (!alive) return;
		resourceBusy = ''; resourceResult = { ...resourceResult, [type]: result };
		await loadResources();
	}
	const resourceLabel = r => ({ china_ip4: t('China IPv4 addresses'), china_ip6: t('China IPv6 addresses'), china_list: t('China domain list'), gfw_list: t('GFWList') }[r]);
	const resultText = r => ({ updated: t('Updated'), latest: t('Already up to date'), busy: t('An update is already running'), failed: t('Update failed') }[r]);
	/* 规则库版本是时间戳（YYYYMMDDhhmm，部分带秒），按日期时间显示 */
	const versionText = v => /^\d{12}(\d{2})?$/.test(v || '') ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)} ${v.slice(8, 10)}:${v.slice(10, 12)}` : v;

	/* --- 日志 --- */
	let logRequest = 0;
	async function loadLog() {
		const request = ++logRequest, name = logName;
		logText = undefined; logError = '';
		try { const text = await svc.log(name); if (alive && request === logRequest) logText = text; }
		catch (e) { if (alive && request === logRequest) { logText = null; logError = errorText(e); } }
	}
	$effect(() => { if (section === 'logs') { logName; loadLog(); } });
	/* 清空日志不可撤销：确认后执行，期间锁定其它操作 */
	async function cleanLog() {
		if (locked) return;
		logBusy = true;
		try { await svc.cleanLog(logName); } catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { logBusy = false; confirmClean = false; loadLog(); } }
	}
</script>

{#snippet nodeContent(raw, n, colIndex)}
	{#if colIndex === 0}
		{@const use = nodeUse(n)}
		<span class="node-name"><strong>{raw.text}</strong>{#if use}<Badge tone="success">{use}</Badge>{/if}</span>
	{:else if colIndex === 3}
		{@const l = latency[n.id]}
		<span data-latency={typeof l === 'number' ? 'ok' : l || 'none'}>{l === undefined ? '-' : l === 'testing' ? t('Testing…') : l === 'timeout' ? t('No reply') : l === 'unsupported' ? t('Not supported') : l === 'error' ? t('Failed') : t('%d ms', l)}</span>
	{:else}{raw.text}{/if}
{/snippet}

{#snippet nodeActions(n)}
	{#if !nodeUse(n)}
		<Button size="compact" disabled={locked || custom} onclick={() => write(() => svc.useNode(n.id))}>{t('Use')}</Button>
		<Button size="compact" disabled={locked} onclick={() => removing = n} aria-label={t('Delete node %s', n.label)}>{t('Delete')}</Button>
	{:else}<span class="muted">{t('In use')}</span>{/if}
{/snippet}

<Dialog open={confirmClean} tone="danger" busy={logBusy} title={t('Clear the %s log?', logName === 'homeproxy' ? t('Service') : 'sing-box')} confirmLabel={t('Clear log')} cancelLabel={t('Cancel')}
	onconfirm={cleanLog} onclose={() => { if (!logBusy) confirmClean = false; }}>
	{t('The log contents are deleted and cannot be restored.')}
</Dialog>

<Dialog open={!!removing} tone="danger" busy={locked} title={t('Delete node %s?', removing?.label ?? '')} confirmLabel={t('Delete')} cancelLabel={t('Cancel')}
	onconfirm={removeNode} onclose={() => { if (!busy) removing = null; }}>
	{removing?.subscribed ? t('This node came from a subscription and may come back at the next subscription update.') : t('The node will be removed.')}
</Dialog>

{#if error}<Feedback tone="error" message={error} onretry={load} />{/if}
{#if notice}<Feedback tone={notice.tone} message={notice.text} />{/if}
{#if data === undefined && !error}
	<Feedback tone="loading" message={t('Loading…')} />
{:else if data === null}
	<Feedback tone="info" message={t('The HomeProxy service is not available on this device. Reinstall sight-app-homeproxy.')} />
{:else if data}
	<div class="stack">
		<Card>
			<StatusHero data-state={heroState} data-homeproxy icon="proxy" tone={{ on: 'success', warning: 'warning' }[heroState] || 'muted'} title={t('Proxy')}
				status={heroText} hint={[modeLabel(data.mode), data.version ? `sing-box ${data.version}` : ''].filter(Boolean).join(' · ')}>
				{#snippet actions()}<Switch checked={data.enabled} disabled={locked || (!data.enabled && !data.nodes.length)} aria-label={t('Proxy')} onchange={toggle} />{/snippet}
				<div class="checks" role="group" aria-label={t('Connectivity')}>
					<span class="muted">{t('Connectivity')}</span>
					{#each SITES as site}
						<span class="check" data-check={site}>
							<Button size="compact" onclick={() => check(site)} disabled={site in checks && checks[site] === undefined}>{siteLabel(site)}</Button>
							{#if site in checks}
								{#if checks[site] === undefined}<span class="muted">{t('Checking…')}</span>
								{:else if checks[site] === true}<Badge tone="success">{t('Reachable')}</Badge>
								{:else if checks[site] === false}<Badge tone="danger">{t('Unreachable')}</Badge>
								{:else}<Badge>{t('Check failed')}</Badge>{/if}
							{/if}
						</span>
					{/each}
				</div>
			</StatusHero>
		</Card>
		{#if missing.length}
			<Callout data-hp-missing message={t('Rule data needed by the current routing mode has not been downloaded (%s), so traffic may not be routed correctly.', missing.map(resourceLabel).join(', '))}>
				<Button size="compact" disabled={locked} onclick={downloadMissing}>{resourceBusy ? t('Updating…') : t('Download now')}</Button>
			</Callout>
		{/if}

		<div class="workspace-tabs"><Tabs id={tabsId} label={t('HomeProxy')} items={tabs} bind:value={section} variant="underline" onchange={changeSection} /></div>

		<!-- 节点 -->
		<div id={`${tabsId}-panel-0`} role="tabpanel" aria-labelledby={`${tabsId}-tab-0`} hidden={section !== 'nodes'} tabindex="0">
			<p class="note muted">{custom ? t('Custom routing is in use; the main node is not used in this mode.') : t('Choose the node the proxy uses. Add nodes by importing share links.')}</p>
			<Card icon="proxy" flush>
				<Toolbar label={t('Node tools')} count={t('%d of %d nodes', nodeRows.length, data.nodes.length)}>
					{#snippet search()}<Input type="search" size="compact" bind:value={nodeQuery} placeholder={t('Name, address or protocol')} aria-label={t('Search nodes')} />{/snippet}
					{#snippet actions()}
						<Button size="compact" onclick={testLatency} disabled={testing || !nodeRows.length} title={t('Pings each node’s server from the router. It shows how far the server is, not how fast the proxy is; servers that block ping show “No reply”.')}>{testing ? t('Testing…') : t('Test latency')}</Button>
						<Button variant="primary" size="compact" onclick={openImport} disabled={locked}>{t('Import links')}</Button>
					{/snippet}
				</Toolbar>
				<Table headers={[t('Node'), t('Protocol'), t('Address'), t('Latency'), t('Source')]} rate={[3]} rows={nodeRows} cells={nodeCells} rowKey={n => n.id}
					rowAttrs={n => ({ 'data-node': n.id })} cellContent={nodeContent} actions={nodeActions} actionsLabel={t('Actions')}
					empty={data.nodes.length ? t('No matching nodes') : t('No nodes yet. Import share links or add a subscription to get nodes.')} />
			</Card>
		</div>

		<!-- 分流与 DNS -->
		<div id={`${tabsId}-panel-1`} role="tabpanel" aria-labelledby={`${tabsId}-tab-1`} hidden={section !== 'routing'} tabindex="0">
			{#if routing}
				<Card>
					<form class="form" onsubmit={saveRouting} aria-label={t('Routing & DNS')}>
						<ErrorSummary errors={routingErrors} bind:this={routingSummary} />
						<SettingRow id="hp-mode" label={t('What goes through the proxy')} description={custom ? t('Custom routing rules were set up outside this page and are kept as they are. Choose another mode to manage routing here.') : t('Traffic not covered goes out directly.')}>
							<Select id="hp-mode" aria-describedby="hp-mode-description" bind:value={routing.mode} disabled={locked || custom} aria-label={t('What goes through the proxy')}>
								{#each MODES as m}<option value={m}>{modeLabel(m)}</option>{/each}
								{#if custom}<option value="custom">{modeLabel('custom')}</option>{/if}
							</Select>
						</SettingRow>
						<SettingRow id="hp-udp" label={t('UDP traffic')} description={t('Games and voice calls use UDP. Send it through the main node, a different node, or directly.')}>
							<Select id="hp-udp" aria-describedby="hp-udp-description" bind:value={routing.udpNode} disabled={locked} aria-label={t('UDP traffic')} aria-invalid={!!routingError('hp-udp')}>
								<option value="same">{t('Same as main node')}</option>
								<option value="nil">{t('Go out directly')}</option>
								{#each data.nodes as n (n.id)}<option value={n.id}>{n.label}</option>{/each}
								{#if !['same', 'nil'].includes(routing.udpNode) && !data.nodes.some(n => n.id === routing.udpNode)}<option value={routing.udpNode}>{routing.udpNode}</option>{/if}
							</Select>
						</SettingRow>
						<SettingRow id="hp-dns" label={t('DNS server')} description={t('Resolves names for proxied traffic. Plain addresses use UDP; tcp://, tls:// and https:// addresses are also accepted.')}>
							<div class="dns">
								<Select id="hp-dns" aria-describedby="hp-dns-description" bind:value={routing.dns} disabled={locked} aria-label={t('DNS server')}>
									{#each DNS_PRESETS as v}<option value={v}>{dnsLabel(v)}</option>{/each}
									<option value="custom">{t('Custom…')}</option>
								</Select>
								{#if routing.dns === 'custom'}
									<Input id="hp-dns-custom" bind:value={routing.dnsCustom} disabled={locked} placeholder="tls://dns.google" spellcheck="false" aria-label={t('Custom DNS server')} aria-invalid={!!routingError('hp-dns-custom')} />
								{/if}
							</div>
						</SettingRow>
						{#if routing.mode === 'bypass_mainland_china'}
							<SettingRow id="hp-china" label={t('China DNS server')} description={t('Resolves mainland China domains so they go out directly.')}>
								<div class="dns">
									<Select id="hp-china" aria-describedby="hp-china-description" bind:value={routing.china} disabled={locked} aria-label={t('China DNS server')}>
										{#each CHINA_DNS_PRESETS as v}<option value={v}>{dnsLabel(v)}</option>{/each}
										<option value="custom">{t('Custom…')}</option>
									</Select>
									{#if routing.china === 'custom'}
										<Input id="hp-china-custom" bind:value={routing.chinaCustom} disabled={locked} placeholder="223.5.5.5" spellcheck="false" aria-label={t('Custom China DNS server')} aria-invalid={!!routingError('hp-china-custom')} />
									{/if}
								</div>
							</SettingRow>
						{/if}
						<FormActions busy={locked} disabled={!routingDirty} description={t('Changes take effect when you save. If the device becomes unreachable, they roll back automatically.')} />
					</form>
				</Card>
			{/if}
			{#if !custom}
				<div class="domains">
					<Card title={t('Custom domains')}>
						{#if domainsLoadError}<Feedback tone="error" message={t('Domain lists could not be read: %s', domainsLoadError)} onretry={loadDomains} compact />
						{:else if !domains}<Feedback tone="loading" message={t('Loading…')} compact />
						{:else}
							<form class="form" onsubmit={saveDomains} aria-label={t('Custom domains')} data-hp-domains>
								<Field id="hp-proxy-domains" label={t('Always use the proxy')} help={t('These domains and their subdomains go through the proxy in every routing mode.')}>
									<DynamicList id="hp-proxy-domains" bind:values={domains.proxy_list} bind:draft={domainDrafts.proxy_list} disabled={locked} placeholder="example.com" spellcheck="false" autocomplete="off" aria-describedby="hp-proxy-domains-help" />
								</Field>
								<Field id="hp-direct-domains" label={t('Always go direct')} help={t('These domains and their subdomains never use the proxy.')}>
									<DynamicList id="hp-direct-domains" bind:values={domains.direct_list} bind:draft={domainDrafts.direct_list} disabled={locked} placeholder="example.com" spellcheck="false" autocomplete="off" aria-describedby="hp-direct-domains-help" />
								</Field>
								{#if domainsError}<Feedback tone="error" message={domainsError} compact />{/if}
								<FormActions busy={locked} disabled={!domainsDirty} description={data.enabled ? t('Saving reloads HomeProxy, which interrupts the proxy for a few seconds.') : t('Takes effect the next time the proxy is turned on.')} />
							</form>
						{/if}
					</Card>
				</div>
			{/if}
		</div>

		<!-- 设备 -->
		<div id={`${tabsId}-panel-2`} role="tabpanel" aria-labelledby={`${tabsId}-tab-2`} hidden={section !== 'devices'} tabindex="0">
			{#if access}
				<Card>
					<form class="form" onsubmit={saveAccess} aria-label={t('Devices using the proxy')}>
						<RadioGroup name="hp-access" label={t('Which devices use the proxy')} value={access.mode} disabled={locked} onchange={changeAccessMode}
							options={ACCESS.map(m => ({ value: m, label: { disabled: t('All devices'), listed_only: t('Only selected'), except_listed: t('All except selected') }[m] }))} />
						<p class="muted">{accessHint(access.mode)}</p>
						{#if access.mode !== 'disabled'}
							<fieldset class="devices" data-hp-devices>
								<legend>{access.mode === 'listed_only' ? t('Devices that use the proxy') : t('Devices that go out directly')}</legend>
								{#if devicesError}<Feedback tone="error" message={t('Devices could not be read: %s', devicesError)} onretry={loadDevices} compact />
								{:else if devices === null}<Feedback tone="loading" message={t('Loading…')} compact />
								{:else if !deviceRows.length}<Feedback tone="empty" message={t('No devices found')} compact />
								{:else}
									{#each deviceRows as d (d.mac)}
										<Checkbox checked={access.macs.includes(d.mac)} disabled={locked} onchange={e => toggleDevice(d.mac, e.currentTarget.checked)}>
											<span class="device"><strong>{d.name || d.ip || d.mac}</strong><span class="muted mono">{[d.ip, d.mac, d.online ? '' : t('Offline')].filter(Boolean).join(' · ')}</span></span>
										</Checkbox>
									{/each}
								{/if}
							</fieldset>
							<Field id="hp-mac" label={t('Add a device by MAC address')} error={macError}>
								<div class="mac-add">
									<span class="grow"><Input id="hp-mac" bind:value={macDraft} disabled={locked} placeholder="AA:BB:CC:DD:EE:FF" spellcheck="false" autocomplete="off" aria-invalid={!!macError}
										onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); addMac(); } }} /></span>
									<Button onclick={addMac} disabled={locked || !macDraft.trim()}>{t('Add')}</Button>
								</div>
							</Field>
						{/if}
						<FormActions busy={locked} disabled={!accessDirty} description={t('Rules by IP address already in the configuration are kept unchanged.')} />
					</form>
				</Card>
			{/if}
		</div>

		<!-- 订阅与规则库 -->
		<div id={`${tabsId}-panel-3`} role="tabpanel" aria-labelledby={`${tabsId}-tab-3`} hidden={section !== 'subscriptions'} tabindex="0">
			<div class="stack">
				<Card title={t('Subscriptions')}>
					<form class="form" onsubmit={saveSubs} aria-label={t('Subscriptions')}>
						<Field id="hp-subs" label={t('Subscription addresses')} help={t('Addresses from your provider. Save, then update to fetch nodes.')} error={subsError}>
							<DynamicList id="hp-subs" bind:values={subs} bind:draft={subsDraft} disabled={locked} placeholder="https://" aria-describedby={subsError ? 'hp-subs-help hp-subs-error' : 'hp-subs-help'} />
						</Field>
						<FormActions busy={locked} disabled={!subsDirty}>
							<Button onclick={updateSubs} disabled={locked || !data.subscriptions.length || subsDirty}>{updating ? t('Updating…') : t('Update now')}</Button>
						</FormActions>
					</form>
					<!-- 开关即时生效，放在表单外，不与未保存的订阅地址混在一起 -->
					<div class="options">
						<SettingRow id="homeproxy-update-automatically" label={t('Update automatically')} description={t('Fetch nodes from the subscriptions on a schedule.')}>
							<Switch id="homeproxy-update-automatically" aria-describedby="homeproxy-update-automatically-description" checked={data.autoUpdate} disabled={locked} aria-label={t('Update automatically')} onchange={on => write(() => svc.saveSubscriptionOptions({ autoUpdate: on, viaProxy: data.viaProxy }))} />
						</SettingRow>
						<SettingRow id="homeproxy-update-through-the-proxy" label={t('Update through the proxy')} description={t('Use when the subscription address cannot be reached directly.')}>
							<Switch id="homeproxy-update-through-the-proxy" aria-describedby="homeproxy-update-through-the-proxy-description" checked={data.viaProxy} disabled={locked} aria-label={t('Update through the proxy')} onchange={on => write(() => svc.saveSubscriptionOptions({ autoUpdate: data.autoUpdate, viaProxy: on }))} />
						</SettingRow>
					</div>
				</Card>
				<Card title={t('Routing rule data')}>
					<p class="muted lead">{t('Address and domain lists that decide what goes direct. Updating downloads the latest lists.')}</p>
					{#if resourcesError}<Feedback tone="error" message={t('Rule data versions could not be read: %s', resourcesError)} onretry={loadResources} compact />{/if}
					<ul class="resources">
						{#each RESOURCES as r}
							<li data-resource={r}>
								<div class="resource-copy">
									<strong>{resourceLabel(r)}</strong>
									<span class="muted">{[resourcesError ? t('Unknown') : resources === null ? t('Loading…') : resources[r] ? t('Version %s', versionText(resources[r])) : t('Not downloaded'), resourceResult[r] ? resultText(resourceResult[r]) : ''].filter(Boolean).join(' · ')}</span>
								</div>
								<Button size="compact" disabled={locked} onclick={() => updateResource(r)}>{resourceBusy === r ? t('Updating…') : t('Update')}</Button>
							</li>
						{/each}
					</ul>
				</Card>
			</div>
		</div>

		<!-- 日志 -->
		<div id={`${tabsId}-panel-4`} role="tabpanel" aria-labelledby={`${tabsId}-tab-4`} hidden={section !== 'logs'} tabindex="0">
			<Card>
				<div class="log-tools">
					<Tabs id={logTabsId} label={t('Logs')} size="compact" items={LOGS.map(l => ({ value: l, label: l === 'homeproxy' ? t('Service') : 'sing-box' }))} bind:value={logName} />
					<span class="log-actions">
						<Button size="compact" onclick={() => confirmClean = true} disabled={locked || !logText}>{t('Clear log')}</Button>
						<Button size="compact" onclick={loadLog} disabled={logText === undefined}>{t('Refresh')}</Button>
					</span>
				</div>
				{#each LOGS as l, index (l)}
					<div id={`${logTabsId}-panel-${index}`} role="tabpanel" aria-labelledby={`${logTabsId}-tab-${index}`} hidden={logName !== l}>
						{#if logName === l}
							{#if logError}<Feedback tone="error" message={t('Log could not be read: %s', logError)} onretry={loadLog} compact />
							{:else if logText === undefined}<Feedback tone="loading" message={t('Loading…')} compact />
							{:else if logText === null}<Feedback tone="empty" message={t('No log yet. It appears after the service has run.')} compact />
							{:else if !logText.trim()}<Feedback tone="empty" message={t('Log is empty')} compact />
							{:else}<LogView text={logText} label={t('Log contents')} tail />{/if}
						{/if}
					</div>
				{/each}
			</Card>
		</div>

		<Drawer error={error || (notice?.tone === 'error' ? notice.text : '')} open={!!importing} title={t('Import share links')} onclose={closeImport}>
			{#if importing}
				<form class="form" onsubmit={doImport} aria-label={t('Import share links')}>
					<Field id="hp-links" label={t('Share links')} help={t('One link per line: vless://, vmess://, trojan://, ss://, hysteria2://, tuic://, anytls://, socks5://, http(s)://')}>
						<Textarea id="hp-links" rows="7" bind:value={importing.text} disabled={locked} spellcheck="false" aria-describedby="hp-links-help" />
					</Field>
					{#if preview.length}
						<ul class="preview" aria-label={t('Recognized links')}>
							{#each preview as row}
								<li data-valid={row.node ? 'yes' : 'no'}>
									{#if row.node}<Badge tone="success">{row.node.type}</Badge><span><strong>{row.node.label}</strong> <span class="muted mono">{row.node.address}:{row.node.port}</span></span>
									{:else}<Badge tone="danger">{t('Not recognized')}</Badge><span class="muted mono clip">{row.link}</span>{/if}
								</li>
							{/each}
						</ul>
					{/if}
					<FormActions busy={locked} disabled={!valid.length} oncancel={closeImport} saveLabel={valid.length ? t('Import %d nodes', valid.length) : t('Import')}
						description={t('Imported nodes are added when you save.')} />
				</form>
			{/if}
		</Drawer>
	</div>
{/if}

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-4); }
	.domains { margin-top: var(--sp-4); }
	.checks { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); }
	.check { display: inline-flex; align-items: center; gap: var(--sp-2); }
	.note { margin: 0 0 var(--sp-3); }
	.node-name { display: inline-flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); }
	.node-name strong { color: var(--heading-color); overflow-wrap: anywhere; }
	.muted { color: var(--text-muted); font-size: var(--fs-sm); }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-xs); overflow-wrap: anywhere; }
	.form { display: flex; flex-direction: column; gap: var(--sp-5); container-type: inline-size; }
	.form > p { margin: calc(-1 * var(--sp-3)) 0 0; }
	.dns { display: flex; flex-direction: column; gap: var(--sp-2); min-width: min(100%, 16rem); }
	.devices { display: flex; flex-direction: column; gap: var(--sp-2); margin: 0; padding: 0; border: 0; }
	.devices legend { margin-bottom: var(--sp-2); padding: 0; font-weight: var(--fw-semibold); color: var(--heading-color); font-size: var(--fs-sm); }
	.device { display: flex; flex-direction: column; min-width: 0; }
	.mac-add { display: flex; gap: var(--sp-2); max-width: 28rem; }
	.grow { flex: 1; min-width: 0; display: grid; }
	.options { margin-top: var(--sp-5); }
	.lead { margin: 0 0 var(--sp-3); }
	.resources { list-style: none; margin: 0; padding: 0; }
	.resources li { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3) 0; border-top: 1px solid var(--border-color); }
	.resources li:first-child { border-top: 0; padding-top: 0; }
	.resource-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.resource-copy strong { font-weight: var(--fw-medium); color: var(--heading-color); }
	.log-tools { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-3); }
	.log-actions { display: flex; gap: var(--sp-2); }
	.preview { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); max-height: 40vh; overflow: auto; }
	.preview li { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; font-size: var(--fs-sm); }
	.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
</style>
