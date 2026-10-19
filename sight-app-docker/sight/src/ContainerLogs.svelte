<script>
	import { onDestroy, untrack } from 'svelte';
	import { t, errorText, createPoller, Button, Checkbox, Feedback, Input, LogView, Select, Switch } from '@sight/sdk';
	import { LOG_LINES, parseLogs, sinceOf, appendLogs, filterLogs } from './service.js';

	/* 容器日志：最近 N 行，可跟随（每 3 秒按最后一条的时间增量读取）、显示时间、按关键字筛选、下载当前显示的内容 */
	let { svc, container } = $props();
	let lines = $state(undefined);   // undefined 加载中；[{ ts, time, text }]
	let error = $state('');
	let limit = $state(LOG_LINES[0]);
	let follow = $state(false);
	let withTime = $state(false);
	let query = $state('');
	let alive = true, version = 0;
	onDestroy(() => { alive = false; version++; });

	const pad = n => String(n).padStart(2, '0');
	const timeText = ms => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
	const lineText = l => withTime && l.time != null ? `${timeText(l.time)}  ${l.text}` : l.text;
	const shown = $derived(lines ? filterLogs(lines, query, withTime, timeText) : []);
	const text = $derived(shown.map(lineText).join('\n'));

	async function load() {
		const request = ++version;
		lines = undefined; error = '';
		try {
			const r = await svc.logs(container.id, { tail: limit });
			if (!alive || request !== version) return;
			if (r.ok) lines = parseLogs(r.text); else { lines = []; error = r.text || t('unknown error'); }
		} catch (e) { if (alive && request === version) { lines = []; error = errorText(e); } }
	}
	/* 跟随：只取最后一条之后的记录；读取失败下一拍再试，不清空已有内容 */
	async function more() {
		if (!lines || document.hidden) return;
		const request = version, since = sinceOf(lines);
		try {
			const r = await svc.logs(container.id, { tail: limit, since });
			if (!alive || request !== version || !r.ok) return;
			const add = parseLogs(r.text);
			lines = since ? appendLogs(lines, add, limit) : add.slice(-limit);
		} catch { /* 下一拍再试 */ }
	}
	const poller = createPoller(more, 3000);
	$effect(() => { if (follow) { poller.start(); return () => poller.stop(); } });
	/* 首次与改行数时重读 */
	$effect(() => { limit; untrack(load); });

	function download() {
		const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = `${container.name}-${new Date().toISOString().replaceAll(':', '-')}.log`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
</script>

<div class="logs" data-logs>
	<div class="tools" role="group" aria-label={t('Log tools')}>
		<span class="search"><Input type="search" size="compact" placeholder={t('Search log messages')} bind:value={query} aria-label={t('Search log messages')} data-log-search /></span>
		<Select size="compact" bind:value={limit} aria-label={t('Number of lines')} data-log-lines>
			{#each LOG_LINES as n}<option value={n}>{t('Last %d lines', n)}</option>{/each}
		</Select>
		<Checkbox bind:checked={withTime}>{t('Show time')}</Checkbox>
		<span class="follow"><Switch checked={follow} aria-label={t('Follow')} onchange={on => follow = on} data-log-follow /><span aria-hidden="true">{t('Follow')}</span></span>
	</div>
	{#if lines === undefined}<Feedback tone="loading" message={t('Loading…')} compact />
	{:else if error}<Feedback tone="error" message={t('Logs could not be read: %s', error)} compact />
	{:else if !lines.length}<Feedback tone="empty" message={t('No log output')} compact />
	{:else if !shown.length}<Feedback tone="empty" message={t('No lines match the search')} compact />
	{:else}<LogView {text} label={t('Log contents')} tail maxHeight="50vh" />{/if}
	<div class="tools">
		{#if lines?.length}<span class="count">{query.trim() ? t('%d of %d lines', shown.length, lines.length) : lines.length === 1 ? t('1 line') : t('%d lines', lines.length)}</span>{/if}
		<Button size="compact" onclick={load} disabled={lines === undefined}>{t('Refresh logs')}</Button>
		<Button size="compact" onclick={download} disabled={!shown.length} data-log-download>{t('Download')}</Button>
	</div>
</div>

<style lang="less">
	.logs { display: flex; flex-direction: column; gap: var(--sp-3); }
	.tools { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); }
	.search { display: grid; flex: 1 1 12rem; min-width: 0; }
	.follow { display: inline-flex; align-items: center; gap: var(--sp-1); }
	.count { color: var(--text-muted); font-variant-numeric: tabular-nums; margin-right: auto; }
</style>
