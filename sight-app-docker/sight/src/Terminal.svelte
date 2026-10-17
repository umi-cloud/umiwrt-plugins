<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, Button, Feedback } from '@sight/sdk';

	/* 容器终端：设备端启动一次性的 ttyd 会话（只监听 LAN 侧地址、一次性路径、只接受一个连接），
	   在新标签页打开；60 秒内没有连上或关掉标签页，会话自动结束。 */
	let { svc, container, locked = false } = $props();
	let session = $state(null);      // 设备端会话（不含一次性路径）
	let url = $state('');            // 本页启动的会话地址
	let error = $state('');
	let busy = $state(false);
	let alive = true, timer = null;
	onDestroy(() => { alive = false; clearTimeout(timer); });

	const active = $derived(!!session && session.state !== 'ended');
	/* 会话进行中定时回读状态，结束后停止 */
	async function refresh() {
		clearTimeout(timer);
		try { const s = await svc.terminalStatus(container.id); if (alive) session = s; }
		catch { /* 只影响状态显示 */ }
		if (alive && session && session.state !== 'ended') timer = setTimeout(refresh, 2000);
	}
	refresh();

	async function open() {
		if (busy || locked) return;
		/* 弹窗须在点击时同步打开，地址拿到后再导航，避免被浏览器拦截 */
		const win = window.open('', '_blank');
		if (win) win.opener = null;
		busy = true; error = ''; url = '';
		try {
			const r = await svc.terminalStart(container.id, window.location);
			if (!alive) return;
			session = r.session; url = r.url;
			if (win) win.location.href = r.url;
			refresh();
		} catch (e) {
			win?.close();
			if (alive) error = errorText(e);
		} finally { if (alive) busy = false; }
	}
	async function stop() {
		busy = true; error = '';
		try { await svc.terminalStop(container.id); url = ''; await refresh(); }
		catch (e) { if (alive) error = errorText(e); }
		finally { if (alive) busy = false; }
	}
	const status = $derived(!session ? '' : session.state === 'ended'
		? (session.reason === 'timeout' ? t('The last session ended because nobody connected within %d seconds.', session.timeout) : t('The last session has ended.'))
		: session.connected ? t('A terminal is connected. Closing its tab ends the session.') : t('Waiting for the terminal tab to connect. The session ends if nobody connects within %d seconds.', session.timeout));
</script>

<div class="terminal" data-terminal={session?.state || 'none'}>
	{#if error}<Feedback tone="error" message={error} compact />{/if}
	{#if status}<p class="muted" role="status">{status}</p>{/if}
	<div class="actions">
		{#if active}
			{#if url && !session.connected}<Button href={url} target="_blank" rel="noopener noreferrer" data-terminal-link>{t('Open the terminal tab again')}</Button>{/if}
			<Button disabled={busy} onclick={stop}>{t('End session')}</Button>
		{:else}
			<Button disabled={busy || locked} onclick={open} data-action="terminal">{busy ? t('Starting…') : t('Open terminal')}</Button>
		{/if}
	</div>
</div>

<style lang="less">
	.terminal { display: flex; flex-direction: column; gap: var(--sp-3); }
	.actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
</style>
