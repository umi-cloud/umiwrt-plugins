<script>
	import { onDestroy } from 'svelte';
	import { t, createPoller, useEditor, Card, Field, DynamicList, Button, Switch, SettingRow, FormActions } from '@sight/sdk';
	import { validateSubscriptions } from './service.js';
	import { failedSubscriptions } from './subscription.js';
	import { localTime } from './format.js';
	import { nodesText, listText } from './labels.js';
	import { createDraft } from './draft.svelte.js';
	import SubscriptionTools from './SubscriptionTools.svelte';

	/* 订阅分区：订阅地址（保存后「立即更新」拉取节点）、自动更新与经代理更新的开关、上次更新结果；
	   按订阅查看/删除节点与过滤设置在 SubscriptionTools。更新为后台任务，进行中每 2 秒轮询。 */
	let { data, svc, locked = false, saving = false, write, run, notify, reload, active = false, onshow } = $props();
	let alive = true;
	onDestroy(() => { alive = false; poller.stop(); });

	const draft = createDraft(() => [...data.subscriptions]);
	$effect(() => { data; draft.sync(); });
	let input = $state(''), error = $state('');
	const dirty = $derived(draft.dirty || !!input.trim());
	let updating = $state(false);
	useEditor(() => ({ dirty, busy: updating }));

	async function save(event) {
		event.preventDefault();
		/* 输入框里还没点「添加」的地址一并收入 */
		const d = input.trim();
		const next = d && !draft.value.includes(d) ? [...draft.value, d] : [...draft.value];
		const errs = validateSubscriptions(next);
		error = errs.length ? t(errs[0].msg) : '';
		if (!errs.length && await write(() => svc.saveSubscriptions(next))) input = '';
	}

	/* 上次更新（含定时更新）的结果；undefined 未读取，null 还没更新过或读不到 */
	let status = $state(undefined);
	async function loadStatus() {
		let s = null;
		try { s = await svc.subscriptionStatus(); } catch { /* 读不到时不显示更新结果 */ }
		if (alive) status = s;
		return s;
	}
	$effect(() => { if (active && status === undefined) loadStatus(); });

	/* 更新结果以脚本写的状态文件为准，按时间戳判断是不是本次写的 */
	function updateNotice(s) {
		if (!s) return { tone: 'error', text: t('The update finished without recording a result. Check the service log.') };
		if (s.result === 'error') return { tone: 'error', text: t('Subscription update failed: %s', s.error || t('unknown error')) };
		if (s.result === 'no_nodes') return { tone: 'error', text: t('No usable nodes were fetched from any subscription. Existing nodes were kept.') };
		const failed = failedSubscriptions(s, data.subscriptions);
		const counts = t('%s added, %s removed', nodesText(s.added), nodesText(s.removed));
		if (failed.length) return { tone: 'error', text: t('Subscriptions updated: %s. Nothing usable was fetched from %s, so its existing nodes were kept.', counts, listText(failed.map(g => g.title))) };
		return { tone: 'success', text: t('Subscriptions updated: %s.', counts) };
	}
	let before = null;
	const poller = createPoller(async () => {
		let running = true;
		try { running = await svc.subscriptionUpdating(); } catch { /* 下次再查 */ }
		if (!alive || running) return;
		poller.stop();
		const s = await loadStatus();
		if (!alive) return;
		updating = false;
		/* 脚本改了节点配置：先重读，再给出结果 */
		await reload();
		if (alive) notify(updateNotice(s && s.time !== before ? s : null));
	}, 2000);
	async function update() {
		if (locked || updating) return;
		before = status?.time ?? null;
		const r = await run(() => svc.startSubscriptionUpdate());
		if (!r.ok || !alive) return;
		if (r.value === false) { notify({ tone: 'info', text: t('A subscription update is already running.') }); return; }
		updating = true;
		poller.start();
	}
	const statusText = s => s.result === 'error' ? t('Last update (%s) failed: %s', localTime(s.time), s.error || t('unknown error'))
		: s.result === 'no_nodes' ? t('Last update (%s) fetched no usable nodes; existing nodes were kept.', localTime(s.time))
		: t('Last updated %s: %s added, %s removed.', localTime(s.time), nodesText(s.added), nodesText(s.removed));
	const saveOptions = patch => write(() => svc.saveSubscriptionOptions({ autoUpdate: data.autoUpdate, viaProxy: data.viaProxy, ...patch }));
</script>

<div class="hp-stack">
	<Card title={t('Subscriptions')}>
		<form class="hp-form" onsubmit={save} aria-label={t('Subscriptions')}>
			<Field id="hp-subs" label={t('Subscription addresses')} help={t('Addresses from your provider. Save, then update to fetch nodes.')} {error}>
				<DynamicList id="hp-subs" bind:values={draft.value} bind:draft={input} disabled={locked} placeholder="https://" aria-describedby={error ? 'hp-subs-help hp-subs-error' : 'hp-subs-help'} />
			</Field>
			<FormActions busy={saving} disabled={locked || !dirty} description={data.viaProxy ? t('Updating fetches nodes through the proxy; the service keeps running.') : t('Updating stops the proxy while nodes are fetched, then starts it again.')}>
				<Button onclick={update} disabled={locked || updating || !data.subscriptions.length || dirty}>{updating ? t('Updating…') : t('Update now')}</Button>
			</FormActions>
		</form>
		{#if status && data.subscriptions.length}<p class="hp-note status" data-hp-sub-status={status.result}>{statusText(status)}</p>{/if}
		<!-- 开关即时生效，放在表单外，不与未保存的订阅地址混在一起 -->
		<div class="options">
			<SettingRow id="homeproxy-update-automatically" label={t('Update automatically')} description={t('Fetch nodes from the subscriptions every day at 2:00, while the proxy is on.')}>
				<Switch id="homeproxy-update-automatically" aria-describedby="homeproxy-update-automatically-description" checked={data.autoUpdate} disabled={locked} aria-label={t('Update automatically')} onchange={on => saveOptions({ autoUpdate: on })} />
			</SettingRow>
			<SettingRow id="homeproxy-update-through-the-proxy" label={t('Update through the proxy')} description={t('Use when the subscription address cannot be reached directly. New nodes are used after the next restart of the proxy.')}>
				<Switch id="homeproxy-update-through-the-proxy" aria-describedby="homeproxy-update-through-the-proxy-description" checked={data.viaProxy} disabled={locked} aria-label={t('Update through the proxy')} onchange={on => saveOptions({ viaProxy: on })} />
			</SettingRow>
		</div>
	</Card>
	<SubscriptionTools {data} {svc} {locked} {saving} {write} {status} onshow={onshow} />
</div>

<style>
	.status { margin-top: var(--sp-3); }
	.options { margin-top: var(--sp-5); }
</style>
