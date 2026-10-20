<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, fmtBytes, Button, Card, Dialog, Feedback, Table, Toolbar } from '@sight/sdk';
	import { logOf, LOG_LIMITS, DEFAULT_LOG } from './create.js';

	/* 存储空间：镜像、容器可写层、卷与容器日志各占多少、能清理多少，并分别处理。
	   清理已停止的容器按确认框里列出的逐个删除（不删卷），其余用 Docker 的 prune；结束后回读（onreload）。
	   没有日志上限的容器（不含 Compose 项目里的，那些按项目文件）可一键补上：交给页面的批量重建任务（onlimitlogs） */
	let { svc, storage, root = '', locked = false, onreload, onlimitlogs } = $props();
	let logs = $state(null);         // [{ id, name, project, log, size }]；null 读取中或失败
	let logsVersion = 0;
	$effect(() => {
		storage;
		const request = ++logsVersion;
		svc.logsUsage().then(r => { if (alive && request === logsVersion) logs = r; }).catch(() => { if (alive && request === logsVersion) logs = null; });
	});
	const unlimited = $derived((logs || []).filter(c => !c.project && logOf(c.log) === ''));
	const logTotal = $derived(logs?.some(c => c.size != null) ? logs.reduce((n, c) => n + (c.size ?? 0), 0) : null);
	let busy = $state('');
	let notice = $state(null);
	let confirm = $state('');        // images | containers | volumes | logs
	let alive = true;
	onDestroy(() => { alive = false; });
	const disabled = $derived(locked || !!busy);

	/* Docker 对 0 字节常不返回大小（如容器可写层），按 0 显示 */
	const size = v => v == null ? t('Not available') : v > 0 ? fmtBytes(v) : '0 MB';
	/* 不足 1 MB 时按 MB 显示为 0，不写释放量 */
	const freed = n => n >= 524288;
	const rows = $derived([
		{ key: 'images', label: t('Images'), ...storage.images, unit: n => t('%d unused images', n) },
		{ key: 'containers', label: t('Containers'), ...storage.containers, unit: n => t('%d stopped containers', n) },
		{ key: 'volumes', label: t('Volumes'), ...storage.volumes, unit: n => t('%d unused volumes', n) },
		...(logs ? [{ key: 'logs', label: t('Container logs'), size: logTotal, count: unlimited.length, reclaimable: 0, unit: n => t('%d containers without a size limit', n) }] : []),
	]);
	const total = $derived(rows.some(r => r.size != null) ? rows.reduce((n, r) => n + (r.size ?? 0), 0) : null);
	const cells = r => [{ text: r.label, strong: true }, { text: size(r.size) }, { text: r.count ? [r.unit(r.count), r.reclaimable > 0 ? fmtBytes(r.reclaimable) : ''].filter(Boolean).join(' · ') : t('Nothing to clean up') }];

	async function clean(kind) {
		if (disabled) return;
		if (kind === 'logs') { confirm = ''; onlimitlogs?.(unlimited.map(c => c.id)); return; }
		busy = kind; notice = null;
		try {
			if (kind === 'images') {
				const before = storage.images.count, r = await svc.pruneImages();
				notice = { tone: 'success', text: freed(r.reclaimed) ? t('Removed %d unused images and freed %s', before, fmtBytes(r.reclaimed)) : t('Removed %d unused images', before) };
			} else if (kind === 'volumes') {
				const r = await svc.pruneVolumes();
				notice = { tone: 'success', text: freed(r.reclaimed) ? t('Deleted %d unused volumes and freed %s', r.count, fmtBytes(r.reclaimed)) : t('Deleted %d unused volumes', r.count) };
			} else {
				/* 逐个删除，失败的记下后继续 */
				const failed = [];
				for (const c of storage.containers.items) {
					try { await svc.removeContainer(c.id); } catch (e) { failed.push(`${c.name}: ${errorText(e)}`); }
				}
				const done = storage.containers.items.length - failed.length;
				notice = failed.length ? { tone: 'error', text: t('Deleted %d stopped containers. Could not delete: %s', done, failed.join('; ')) } : { tone: 'success', text: t('Deleted %d stopped containers', done) };
			}
		} catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { busy = ''; confirm = ''; await onreload?.(); } }
	}
	const TITLES = { images: () => t('Remove %d unused images?', storage.images.count), containers: () => t('Delete %d stopped containers?', storage.containers.count), volumes: () => t('Delete %d unused volumes?', storage.volumes.count),
		logs: () => t('Limit the logs of %d containers?', unlimited.length) };
	const LABELS = { images: 'Remove', containers: 'Delete', volumes: 'Delete', logs: 'Set limit' };
	const defaultTotal = LOG_LIMITS.find(o => o.value === DEFAULT_LOG).total;
	/* 确认框最多列出这么多个容器名 */
	const LIST_MAX = 10;
</script>

{#snippet actions(row)}
	<Button size="compact" disabled={disabled || !row.count} onclick={() => confirm = row.key} data-clean={row.key}>{row.key === 'logs' ? t('Set limit') : busy === row.key ? t('Cleaning up…') : t('Clean up')}</Button>
{/snippet}

<Dialog open={!!confirm} tone={confirm === 'logs' ? 'primary' : 'danger'} busy={!!busy} title={confirm ? TITLES[confirm]() : ''} confirmLabel={confirm ? t(LABELS[confirm]) : ''} cancelLabel={t('Cancel')}
	onconfirm={() => clean(confirm)} onclose={() => { if (!busy) confirm = ''; }}>
	{#if confirm === 'images'}{t('Images that no container uses are deleted from the device. Images used by any container, running or stopped, are kept.')}
	{:else if confirm === 'volumes'}<span data-prune-volumes>{t('Every volume that no container uses is deleted with its data, including named volumes of stopped Compose projects. This cannot be undone.')}</span>
	{:else if confirm === 'logs'}
		<div class="confirm-body" data-limit-logs>
			<p>{t('Each container below is recreated with a log limit of about %d MB; older log lines are dropped. Running containers stop briefly; volumes and folders are kept.', defaultTotal)}</p>
			<ul>
				{#each unlimited.slice(0, LIST_MAX) as c}<li class="mono">{c.name}{#if c.size} · {fmtBytes(c.size)}{/if}</li>{/each}
				{#if unlimited.length > LIST_MAX}<li>{t('and %d more', unlimited.length - LIST_MAX)}</li>{/if}
			</ul>
		</div>
	{:else if confirm === 'containers'}
		<div class="confirm-body" data-clean-containers>
			<p>{t('These containers are deleted along with any changes made inside them. Their volumes and folders shared from the device are kept.')}</p>
			<ul>
				{#each storage.containers.items.slice(0, LIST_MAX) as c}<li class="mono">{c.name}</li>{/each}
				{#if storage.containers.items.length > LIST_MAX}<li>{t('and %d more', storage.containers.items.length - LIST_MAX)}</li>{/if}
			</ul>
		</div>
	{/if}
</Dialog>

<div class="stack" data-storage>
	{#if notice}<Feedback tone={notice.tone} message={notice.text} />{/if}
	<Card icon="storage" flush>
		<Toolbar label={t('Storage')} count={total == null ? '' : t('%s in total', fmtBytes(total))} live={false} />
		<Table headers={[t('Type'), t('Size'), t('Can be cleaned up')]} rows={rows} {cells} rowKey={r => r.key} rowAttrs={r => ({ 'data-storage-row': r.key })} {actions} actionsLabel={t('Actions')} />
	</Card>
	{#if root}<p class="muted">{t('Docker keeps its data in %s. Change it in Settings.', root)}</p>{/if}
</div>

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-4); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-xs); }
	.confirm-body { display: flex; flex-direction: column; gap: var(--sp-3); }
	.confirm-body p, .confirm-body ul { margin: 0; }
	.confirm-body ul { padding-left: var(--sp-5); }
</style>
