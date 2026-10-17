<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, client, Card, Button, Feedback, Badge } from '@sight/sdk';
	import { createTerminal } from './service.js';

	/* 路由器终端：设备端按需启动一次性的 ttyd 会话（只监听 LAN 侧地址、一次性路径、只接受一个连接），
	   在新标签页打开，以 root 登录。60 秒内没有连上或关掉标签页，会话自动结束。
	   本页启动的会话记在 sessionStorage，刷新后仍能查看状态与结束。 */
	const svc = createTerminal(client);
	const KEY = 'sight-ttyd-sessions';
	let sessions = $state([]);   // [{ id, url?, session }]
	let error = $state('');
	let busy = $state(false);
	let alive = true, timer = null;
	onDestroy(() => { alive = false; clearTimeout(timer); });

	function remember() {
		try { sessionStorage.setItem(KEY, JSON.stringify(sessions.filter(s => s.session?.state !== 'ended').map(s => s.id))); } catch { /* 只影响刷新后的恢复 */ }
	}
	function restore() {
		try { return JSON.parse(sessionStorage.getItem(KEY) || '[]').filter(id => /^[a-f0-9]{16}$/.test(id)); } catch { return []; }
	}

	/* 有进行中的会话时每 2 秒回读状态 */
	async function refresh() {
		clearTimeout(timer);
		const next = [];
		for (const s of sessions) {
			try { next.push({ ...s, session: await svc.status(s.id) }); }
			catch { next.push({ ...s, session: { ...s.session, state: 'ended', reason: s.session?.reason || 'gone' } }); }
		}
		if (!alive) return;
		sessions = next;
		remember();
		if (sessions.some(s => s.session?.state !== 'ended')) timer = setTimeout(refresh, 2000);
	}
	sessions = restore().map(id => ({ id, session: null }));
	if (sessions.length) refresh();

	async function open() {
		if (busy) return;
		/* 弹窗须在点击时同步打开，地址拿到后再导航，避免被浏览器拦截 */
		const win = window.open('', '_blank');
		if (win) win.opener = null;
		busy = true; error = '';
		try {
			const r = await svc.start(window.location);
			if (!alive) return;
			sessions = [{ id: r.session.id, url: r.url, session: r.session }, ...sessions.filter(s => s.session?.state !== 'ended')];
			if (win) win.location.href = r.url;
			remember();
			refresh();
		} catch (e) {
			win?.close();
			if (alive) error = errorText(e);
		} finally { if (alive) busy = false; }
	}

	async function stop(s) {
		busy = true; error = '';
		try { await svc.stop(s.id); await refresh(); }
		catch (e) { if (alive) error = errorText(e); }
		finally { if (alive) busy = false; }
	}

	const status = s => !s.session ? t('Checking…')
		: s.session.state === 'ended' ? (s.session.reason === 'timeout' ? t('Ended because nobody connected within %d seconds.', s.session.timeout) : t('Ended.'))
		: s.session.connected ? t('Connected. Closing the terminal tab ends the session.') : t('Waiting for the terminal tab to connect.');
	const time = sec => sec ? new Date(sec * 1000).toLocaleTimeString() : '';
</script>

<div class="stack">
	<Card icon="terminal" title={t('Terminal')}>
		<div class="intro">
			<p class="muted">{t('Opens a command line on the router as root in a new browser tab. Each session accepts one connection from this network and ends when you close its tab.')}</p>
			<Button variant="primary" disabled={busy} onclick={open} data-action="terminal">{busy ? t('Starting…') : t('Open terminal')}</Button>
		</div>
		{#if error}<Feedback tone="error" message={error} compact />{/if}
	</Card>

	{#if sessions.length}
		<Card icon="processes" title={t('Sessions')}>
			<ul class="sessions">
				{#each sessions as s (s.id)}
					{@const active = s.session && s.session.state !== 'ended'}
					<li data-session={s.id} data-state={s.session?.state || 'unknown'}>
						<div class="copy">
							<strong>{t('Started at %s', time(s.session?.created))}</strong>
							<span class="muted" role="status">{status(s)}</span>
						</div>
						{#if active}
							<Badge tone={s.session.connected ? 'success' : 'info'}>{s.session.connected ? t('Connected') : t('Waiting')}</Badge>
							{#if s.url && !s.session.connected}<Button size="compact" href={s.url} target="_blank" rel="noopener noreferrer">{t('Open the tab again')}</Button>{/if}
							<Button size="compact" disabled={busy} onclick={() => stop(s)}>{t('End session')}</Button>
						{:else}
							<Badge>{t('Ended')}</Badge>
						{/if}
					</li>
				{/each}
			</ul>
		</Card>
	{/if}
</div>

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-4); }
	.intro { display: flex; align-items: center; gap: var(--sp-4); flex-wrap: wrap; }
	.intro p { flex: 1 1 20rem; }
	.sessions { list-style: none; margin: 0; padding: 0; }
	.sessions li { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) 0; border-top: 1px solid var(--border-color); flex-wrap: wrap; }
	.sessions li:first-child { border-top: 0; padding-top: 0; }
	.copy { flex: 1 1 16rem; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.copy strong { color: var(--heading-color); font-weight: var(--fw-semibold); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
</style>
