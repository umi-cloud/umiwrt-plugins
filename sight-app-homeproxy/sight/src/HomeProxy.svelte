<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, client, route, navigate, activity, useEditor, uci, pending, saveFlow, Tabs, Feedback } from '@sight/sdk';
	import { createHomeProxy } from './service.js';
	import { CUSTOM } from './constants.js';
	import { createResources } from './resources.svelte.js';
	import ProxyStatus from './ProxyStatus.svelte';
	import NodesPanel from './NodesPanel.svelte';
	import RoutingForm from './RoutingForm.svelte';
	import DomainLists from './DomainLists.svelte';
	import CustomRouting from './CustomRouting.svelte';
	import RuleData from './RuleData.svelte';
	import DeviceAccess from './DeviceAccess.svelte';
	import SubscriptionsPanel from './SubscriptionsPanel.svelte';
	import CoreStatus from './CoreStatus.svelte';
	import LogsPanel from './LogsPanel.svelte';

	/* 页面只负责：加载数据、分区与地址同步、配置保存（write）与即时操作（run）、顶部提示。
	   顶部状态卡（ProxyStatus）常驻；其余按任务分区，各自成组件并接收同一组 props：data、svc、locked（页面锁定）、
	   saving（配置保存进行中）、write、run、notify、reload（后台任务结束后重读配置）、active（分区可见）。配置保存即生效（带失联回滚）。 */
	const svc = createHomeProxy(client, uci);
	const resources = createResources(svc);
	const SECTIONS = ['nodes', 'routing', 'rules', 'devices', 'subscriptions', 'core', 'logs'];
	const sectionOf = tab => SECTIONS.includes(tab) ? tab : 'nodes';
	const tabsId = $props.id();
	let section = $state(sectionOf(route.params.tab));
	/* 不带 tab 的地址（如从侧栏进入）回到节点分区 */
	$effect(() => { section = sectionOf(route.params.tab); });
	async function changeSection(next) { await navigate(next === 'nodes' ? '/homeproxy' : `/homeproxy?tab=${next}`); }

	let data = $state(undefined);   // undefined 加载中；null 未安装
	let error = $state('');
	let notice = $state(null);
	let saving = $state(false);
	let running = $state(0);        // 进行中的即时操作数
	let alive = true, version = 0;
	onDestroy(() => { alive = false; version++; resources.destroy(); });

	async function load() {
		const request = ++version;
		error = '';
		try {
			const r = await svc.load();
			if (alive && request === version) data = r;
		} catch (e) { if (alive && request === version) error = errorText(e); }
	}
	$effect(() => { pending.version; load(); });
	/* 代理开着时进页面就读规则库版本：当前模式缺少的要在顶部提醒 */
	$effect(() => { if (data && (data.enabled || section === 'rules') && !resources.versions && !resources.error) resources.load(); });

	useEditor(() => ({ busy: saving || running > 0 }));
	const locked = $derived(saving || running > 0 || activity.busy);
	const isCustom = $derived(data?.mode === CUSTOM);
	const tabs = $derived([
		{ value: 'nodes', label: t('Nodes'), count: data?.nodes.length ?? 0 },
		{ value: 'routing', label: t('Routing') },
		{ value: 'rules', label: t('Rules') },
		{ value: 'devices', label: t('Devices') },
		{ value: 'subscriptions', label: t('Subscriptions') },
		{ value: 'core', label: 'sing-box' },
		{ value: 'logs', label: t('Logs') },
	]);
	/* 抽屉为模态，页面顶部的错误被遮挡：抽屉里的写入失败经它说明 */
	const drawerError = $derived(error || (notice?.tone === 'error' ? notice.text : ''));
	const notify = n => { notice = n; };

	/** 配置保存：失败保留输入；成功后重载（草稿与新基线一致即视为已保存），可附成功提示。@returns {Promise<boolean>} */
	async function write(action, success) {
		if (locked) return false;
		return saveFlow(action, {
			busy: on => { saving = on; if (on) { error = ''; notice = null; } },
			fail: e => { error = errorText(e); },
			done: async () => { if (success) notice = { tone: 'success', text: success }; await load(); },
			alive: () => alive,
		});
	}
	/**
	 * 即时操作：进行中锁定页面；成功可附提示（文案或由结果算出）；失败默认在顶部提示，quiet 时交给调用方。
	 * @returns {Promise<{ ok: boolean, value?: any, error?: string }>}
	 */
	async function run(action, { success, quiet = false } = {}) {
		if (locked) return { ok: false, error: '' };
		running++; notice = null;
		try {
			const value = await action();
			if (alive && success) notice = { tone: 'success', text: typeof success === 'function' ? success(value) : success };
			return { ok: true, value };
		} catch (e) {
			const text = errorText(e);
			if (alive && !quiet) notice = { tone: 'error', text };
			return { ok: false, error: text };
		} finally { if (alive) running--; }
	}

	/* 订阅分区的「查看节点」：切到节点分区并按来源筛选 */
	let nodeSource = $state('all');
	function showSource(source) { nodeSource = source; changeSection('nodes'); }
	/* 诊断里的「查看日志」 */
	let logName = $state('homeproxy');
	async function showLog(name) {
		if (name === 'syslog') { await navigate('/logs'); return; }
		logName = name;
		await changeSection('logs');
	}
	const panel = $derived(Object.fromEntries(SECTIONS.map((s, i) => [s, { id: `${tabsId}-panel-${i}`, 'aria-labelledby': `${tabsId}-tab-${i}`, role: 'tabpanel', tabindex: '0', hidden: section !== s }])));
	const shared = $derived({ data, svc, locked, saving, write, run, notify, reload: load });
</script>

{#if error}<Feedback tone="error" message={error} onretry={load} />{/if}
{#if notice}<Feedback tone={notice.tone} message={notice.text} />{/if}
{#if data === undefined && !error}
	<Feedback tone="loading" message={t('Loading…')} />
{:else if data === null}
	<Feedback tone="info" message={t('The HomeProxy service is not available on this device. Reinstall sight-app-homeproxy.')} />
{:else if data}
	<div class="hp-stack">
		<ProxyStatus {...shared} {resources} onshowlog={showLog} />

		<div class="workspace-tabs"><Tabs id={tabsId} label={t('HomeProxy')} items={tabs} bind:value={section} variant="underline" onchange={changeSection} /></div>

		<div {...panel.nodes}>
			<NodesPanel {...shared} {drawerError} bind:source={nodeSource} />
		</div>

		<div {...panel.routing}>
			<div class="hp-stack">
				<RoutingForm {...shared} />
				{#if isCustom}
					<CustomRouting {...shared} error={drawerError} />
				{:else}
					<DomainLists {...shared} active={section === 'routing'} />
				{/if}
			</div>
		</div>

		<div {...panel.rules}>
			<RuleData {resources} {locked} />
		</div>

		<div {...panel.devices}>
			<DeviceAccess {...shared} active={section === 'devices'} />
		</div>

		<div {...panel.subscriptions}>
			<SubscriptionsPanel {...shared} active={section === 'subscriptions'} onshow={showSource} />
		</div>

		<div {...panel.core}>
			<CoreStatus {...shared} active={section === 'core'} />
		</div>

		<div {...panel.logs}>
			<LogsPanel {...shared} active={section === 'logs'} bind:logName />
		</div>
	</div>
{/if}
