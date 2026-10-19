<script>
	import { onDestroy, tick } from 'svelte';
	import { t, errorText, client, uci, activity, useEditor, requestLeave, createPoller, route, navigate, fmtBytes, Callout, Card, Tabs, Table, Toolbar, Badge, Button, Checkbox, Icon, StatusHero, Drawer, Dialog, Feedback, Field, Input, ErrorSummary, FormActions } from '@sight/sdk';
	import { createDocker, isImageRef, normalizeImage, portLinks, groupContainers, cpuPercent, memoryUsage, updateState, checkRefs, lastChecked, statesChanged, matchContainer, troubleOf, rootProblem } from './service.js';
	import { stateTone, stateLabel, short, date } from './format.js';
	import ContainerDetail from './ContainerDetail.svelte';
	import CreateContainer from './CreateContainer.svelte';
	import Compose from './Compose.svelte';
	import Resources from './Resources.svelte';
	import Settings from './Settings.svelte';
	import Storage from './Storage.svelte';
	import TaskProgress from './TaskProgress.svelte';
	import ImageSearch from './ImageSearch.svelte';

	/* 按日常任务：看哪些容器在跑、各占多少 CPU 与内存、启停重启、打开网页、看日志、进终端；新建、编辑、删除容器；
	   检查哪些容器有新版镜像并逐个或全部更新；Compose 项目；下载与清理镜像；网络与卷；存储空间与清理；镜像加速与数据目录在「设置」。
	   下载镜像、检查更新、更新/编辑（重建）容器与 Compose 操作是设备端后台任务，同一时间一个，进度显示在状态卡下方。 */
	const svc = createDocker(client, uci);
	let data = $state(undefined);   // undefined 加载中；null 未安装
	let error = $state('');
	let notice = $state(null);
	let busy = $state('');          // 正在操作的容器/镜像 ID，或 'service' / 'prune'
	/* 分区与地址 ?tab= 同步：刷新与后退时停在原分区 */
	const SECTIONS = ['containers', 'compose', 'images', 'resources', 'storage', 'settings'];
	const routeSection = () => SECTIONS.includes(route.params.tab) ? route.params.tab : 'containers';
	let section = $state(routeSection());
	$effect(() => { section = routeSection(); });
	/* 有未保存的改动时离开被拒，分区退回地址里的 */
	async function changeSection(next) { if (!await navigate(next === 'containers' ? '/docker' : `/docker?tab=${next}`)) section = routeSection(); }
	let query = $state('');
	const tabsId = $props.id();
	let detailId = $state(null);
	let detailVersion = $state(0);  // 操作后递增，重建详情以重读
	let confirm = $state(null);     // { kind: 'stop' | 'restart' | 'remove' | 'image' | 'prune' | 'update' | 'updateAll', item }
	let removeVolumes = $state(false);
	let creating = $state(false);
	let createFrom = $state('');    // 从镜像列表「新建容器」时预选的镜像
	let editing = $state(null);     // { id, name, base, form }；'loading' 读取中
	let pullOpen = $state(false);
	let pullRef = $state('');
	let pullErrors = $state([]);
	let pullSummary = $state();
	let task = $state(null);        // 设备端当前或最近一次后台任务
	let output = $state('');
	let taskShown = $state(false);  // 本页发起或进入时正在进行的任务，结束后保留到关闭
	let usage = $state({});         // 容器 ID → { cpu, memory }，只有运行中的
	let timezone = $state('');
	const taskRunning = $derived(task?.state === 'running');
	/* 后台任务进行中不做其它容器操作，避免与重建、Compose 冲突 */
	const locked = $derived(!!busy || activity.busy || taskRunning);
	/* 容器与镜像操作进行中阻止切页；后台任务在设备端进行，不阻止 */
	useEditor(() => ({ dirty: pullOpen && !!pullRef.trim(), busy: !!busy }));
	let alive = true, version = 0;
	onDestroy(() => { alive = false; version++; });

	async function load() {
		const request = ++version;
		error = '';
		try { const r = await svc.load(); if (alive && request === version) data = r; }
		catch (e) { if (alive && request === version) error = errorText(e); }
	}
	load();

	/* 后台任务：轮询设备端任务直到结束；同一时间只有一个轮询。结束后先回读列表，结果出现时列表已是新的 */
	let watching = null;
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	function watchTask() {
		watching ??= (async () => {
			try {
				while (alive) {
					let s;
					/* 读取失败（如网络抖动）稍后重试，不中断跟踪 */
					try { s = await svc.taskStatus(); } catch { await sleep(3000); continue; }
					if (!alive) return null;
					if (s.task?.state === 'running') { task = s.task; output = s.output; await sleep(1500); continue; }
					/* 结束：先回读列表再显示结果；回读期间页面又启动了新任务（task 被换成运行中的）则继续跟踪 */
					const started = task?.started;
					await load();
					if (!alive) return null;
					if (task?.state === 'running' && task.started !== started) continue;
					task = s.task; output = s.output;
					return task;
				}
				return null;
			} finally { watching = null; }
		})();
		return watching;
	}
	/** 启动任务并跟踪到结束：返回最终任务，启动失败直接抛出 */
	async function runTask(start) {
		const started = await start();
		if (!alive) return null;
		task = started; output = ''; taskShown = true; notice = null;
		return watchTask();
	}
	/** 新建容器时下载镜像：返回最终任务（state 为 done/failed） */
	const pull = ref => runTask(() => svc.pullStart(ref));
	/* 进入页面时设备上正有任务（例如刷新前发起的）：跟踪并显示 */
	svc.taskStatus().then(s => { if (alive && s.task?.state === 'running') { task = s.task; output = s.output; taskShown = true; watchTask(); } }).catch(() => { /* 只影响进度显示 */ });

	const detail = $derived(detailId && data?.containers?.find(c => c.id === detailId) || null);
	$effect(() => { if (detailId && data?.reachable && !detail) detailId = null; });
	const tabs = $derived([
		{ value: 'containers', label: t('Containers'), count: data?.containers?.length ?? 0 },
		{ value: 'compose', label: t('Compose'), count: data?.compose?.projects?.length ?? 0 },
		{ value: 'images', label: t('Images'), count: data?.images?.length ?? 0 },
		{ value: 'resources', label: t('Networks and volumes') },
		{ value: 'storage', label: t('Storage') },
		{ value: 'settings', label: t('Settings') },
	]);
	const unused = $derived(data?.images?.filter(i => !i.containers).length ?? 0);
	const allGroups = $derived(groupContainers(data?.containers || []));
	/* 列表按搜索过滤；「全部更新」不受过滤影响 */
	const groups = $derived(query.trim() ? groupContainers((data?.containers || []).filter(c => matchContainer(c, query))) : allGroups);
	const volumeNames = $derived(Array.isArray(data?.volumes) ? data.volumes.filter(v => !v.anonymous).map(v => v.name) : []);
	const userNetworks = $derived(Array.isArray(data?.networks) ? data.networks.filter(n => !n.builtin).map(n => ({ name: n.name, subnets: n.subnets })) : []);
	const hostname = window.location.hostname;
	svc.timezone().then(z => { if (alive) timezone = z; });

	/* 有新版镜像的容器：Compose 项目里的按项目更新，不进「全部更新」 */
	const updates = $derived(Object.fromEntries((data?.containers || []).map(c => [c.id, updateState(c, data.images, data.checks)])));
	const outdated = $derived(allGroups.standalone.filter(c => updates[c.id] === 'available'));
	const refs = $derived(checkRefs(data?.containers));
	/* 反复重启、健康检查失败的容器，在容器页顶部提醒 */
	const troubled = $derived((data?.containers || []).filter(c => troubleOf(c)));
	const checked = $derived(lastChecked(data?.containers, data?.checks));

	/* 资源占用：停在容器页时每 5 秒一次采样（一次取全部），CPU 由相邻两次相减；
	   容器增减或启停（包括在别处操作）时回读列表 */
	let samples = {};
	async function sampleUsage() {
		if (document.hidden || !data?.reachable) return;
		let r;
		try { r = await svc.usage(); } catch { return; }
		if (!alive) return;
		const next = {};
		for (const [id, s] of Object.entries(r.samples || {})) next[id] = { cpu: samples[id] ? cpuPercent(samples[id], s) : null, memory: memoryUsage(s) };
		samples = r.samples || {};
		usage = next;
		if (!locked && data?.reachable && statesChanged(r.states, data.containers)) load();
	}
	const usagePoller = createPoller(sampleUsage, 5000);
	const watchUsage = $derived(!!data?.reachable && section === 'containers');
	$effect(() => { if (watchUsage) { usagePoller.start(); return () => usagePoller.stop(); } });

	/* 即时操作：执行后回读列表并重建详情 */
	async function run(key, action, success) {
		if (locked) return false;
		busy = key; notice = null;
		let ok = false;
		try { await action(); ok = true; if (alive) notice = { tone: 'success', text: success }; }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { busy = ''; confirm = null; await load(); detailVersion++; } }
		return ok;
	}
	const act = (c, action) => run(c.id, () => svc.action(c.id, action), { start: t('Started %s', c.name), stop: t('Stopped %s', c.name), restart: t('Restarted %s', c.name) }[action]);
	async function removeContainer(c) {
		const volumes = removeVolumes;
		if (await run(c.id, () => svc.removeContainer(c.id, { force: c.state === 'running', volumes }), t('Deleted %s', c.name)) && detailId === c.id) detailId = null;
	}
	const removeImage = img => run(img.id, () => svc.removeImage(img.id), t('Removed image %s', img.tags[0] || short(img.id)));
	async function prune() {
		const before = data.images.length;
		let reclaimed = 0;
		const ok = await run('prune', async () => { reclaimed = (await svc.pruneImages()).reclaimed; }, '');
		if (!alive || !ok) return;
		/* 数量按清理前后的列表计；释放空间不足 1 MB（按 MB 显示为 0）或 Docker 未报告时不写 */
		const count = Math.max(0, before - (data?.images?.length ?? before));
		notice = { tone: 'success', text: reclaimed >= 524288 ? t('Removed %d unused images and freed %s', count, fmtBytes(reclaimed)) : t('Removed %d unused images', count) };
	}
	async function startService() {
		busy = 'service'; error = '';
		try { await svc.startService(); } catch (e) { if (alive) error = errorText(e); }
		finally { if (alive) { busy = ''; await load(); } }
	}
	/* 更新：设备端拉取镜像，有新版才重建；抽屉随即关闭（重建后容器 ID 会变），进度显示在状态卡下方 */
	async function update(c) {
		confirm = null;
		detailId = null;
		try { await runTask(() => svc.update(c.id)); }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
	}
	async function updateAll(list) {
		confirm = null;
		try { await runTask(() => svc.updateAll(list.map(c => c.id))); }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
	}
	/* 数据目录的问题：放在不支持的文件系统上、被新挂载的盘盖住、或在内存里 */
	const problem = $derived(data?.reachable ? rootProblem(data.rootStatus) : '');
	async function restartForDisk() {
		if (locked) return;
		busy = 'service'; notice = null;
		try { await svc.restartService(); } catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) { busy = ''; await load(); } }
	}
	/* 迁移到新数据目录（设置页保存后调用，Docker 仍在旧目录上）：由镜像 ID 创建的容器无法迁移，结果里说明 */
	let migrateSkipped = $state([]);
	async function migrateTo(oldRoot) {
		migrateSkipped = [];
		try { await runTask(async () => { const r = await svc.migrate(oldRoot); if (alive) migrateSkipped = r.skipped; return r.task; }); }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
	}
	/* 补日志上限：按原配置批量重建 */
	async function limitLogs(ids) {
		try { await runTask(() => svc.limitLogs(ids)); }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
	}
	/* 检查更新：设备端向仓库查询各镜像标签的摘要（不下载），结束后回读列表即显示哪些有新版 */
	async function checkUpdates() {
		if (locked) return;
		try { await runTask(() => svc.checkStart(refs)); }
		catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
	}
	function onconfirm() {
		const { kind, item } = confirm;
		if (kind === 'image') removeImage(item);
		else if (kind === 'remove') removeContainer(item);
		else if (kind === 'prune') prune();
		else if (kind === 'update') update(item);
		else if (kind === 'updateAll') updateAll(item);
		else act(item, kind);
	}
	function request(kind, item) { removeVolumes = false; confirm = { kind, item }; }

	async function openDetail(c) { if (!await requestLeave() || !alive) return; detailId = c.id; }
	async function closeDetail() { if (!await requestLeave() || !alive) return; detailId = null; }
	async function openCreate(image = '') { if (locked || !await requestLeave() || !alive) return; notice = null; createFrom = image; creating = true; }
	async function closeCreate() { if (!await requestLeave() || !alive) return; creating = false; }
	async function created({ name, image, started, startError }) {
		creating = false;
		const label = name || image;
		/* 内核或环境不支持内存/CPU 限制时 runc 报 cgroup 文件缺失，补一句怎么办 */
		const hint = startError && /cgroup|memory\.max|cpu\.max/.test(startError) ? ' ' + t('This device may not support memory or CPU limits. Edit the container and clear the limits.') : '';
		notice = startError ? { tone: 'error', text: t('Created %s, but it could not be started: %s', label, startError) + hint }
			: { tone: 'success', text: started ? t('Created and started %s', label) : t('Created %s', label) };
		await changeSection('containers');
		await load();
	}

	async function openEdit(c) {
		if (locked || !await requestLeave() || !alive) return;
		notice = null; editing = 'loading';
		try { const r = await svc.editForm(c.id); if (alive && editing === 'loading') editing = { id: c.id, name: r.base.name, ...r }; }
		catch (e) { if (alive) { editing = null; notice = { tone: 'error', text: errorText(e) }; } }
	}
	async function closeEdit() { if (!await requestLeave() || !alive) return; editing = null; }
	/* 保存编辑：交给设备端重建任务，关闭抽屉与详情 */
	async function saveEdit(form) {
		const { id, base } = editing;
		const started = await svc.edit(id, base, form);
		if (!alive) return;
		editing = null; detailId = null;
		runTask(async () => started).catch(e => { if (alive) notice = { tone: 'error', text: errorText(e) }; });
	}
	const composeStart = (name, action, volumes) => runTask(() => svc.composeStart(name, action, volumes));

	async function openPull() { if (!await requestLeave() || !alive) return; pullRef = ''; pullErrors = []; pullOpen = true; }
	async function closePull() { if (!await requestLeave() || !alive) return; pullOpen = false; }
	async function submitPull(e) {
		e.preventDefault();
		const ref = normalizeImage(pullRef);
		pullErrors = isImageRef(ref) ? [] : [{ text: t('Enter a valid image name, for example nginx:latest'), field: 'pull-image' }];
		if (!pullErrors.length) {
			try { const started = await svc.pullStart(ref); if (!alive) return; pullOpen = false; pullRef = ''; runTask(async () => started); return; }
			catch (err) { pullErrors = [{ text: errorText(err) }]; }
		}
		await tick(); pullSummary?.focus();
	}

	const containerAttrs = c => ({ 'data-container': c.name, 'data-clickable': '', onclick: e => { if (!e.target.closest('button, a, input')) openDetail(c); } });
	const usageText = c => {
		const u = usage[c.id];
		if (c.state !== 'running') return '-';
		if (!u) return '…';
		return [u.cpu == null ? '…' : `${u.cpu.toFixed(1)}%`, u.memory ? fmtBytes(u.memory.used) : ''].filter(Boolean).join(' · ');
	};
	const containerCells = c => [{ text: c.name }, { text: '' }, { text: usageText(c), nowrap: true }, { text: c.ports.join(', ') || '-', mono: !!c.ports.length }, { text: c.status }];
	const containerHeaders = $derived([t('Container'), t('State'), t('CPU · memory'), t('Ports'), t('Status')]);
	const linkOf = c => portLinks(c.publish, hostname)[0];
	const imageCells = i => [{ text: i.tags.join(', ') || t('(untagged)'), strong: true }, { text: short(i.id), mono: true }, { text: fmtBytes(i.size) }, { text: date(i.created) }, { text: i.containers ? t('%d containers', i.containers) : t('Unused') }];
	const TITLES = {
		image: c => t('Remove image %s?', c.item.tags[0] || short(c.item.id)), stop: c => t('Stop %s?', c.item.name), restart: c => t('Restart %s?', c.item.name),
		remove: c => t('Delete %s?', c.item.name), prune: () => t('Remove %d unused images?', unused), update: c => t('Update %s?', c.item.name),
		updateAll: c => t('Update %d containers?', c.item.length),
	};
	const LABELS = { image: 'Remove', stop: 'Stop', restart: 'Restart', remove: 'Delete', prune: 'Remove', update: 'Update', updateAll: 'Update' };
</script>

{#snippet containerContent(raw, row, colIndex)}
	{#if colIndex === 1}<span class="badges"><Badge tone={stateTone(row.state)}>{stateLabel(row.state)}</Badge>{#if row.health === 'unhealthy'}<Badge tone="danger" data-unhealthy>{t('Unhealthy')}</Badge>{/if}</span>
	{:else if colIndex === 0}<span class="name"><strong>{row.name}{#if updates[row.id] === 'available'} <Badge tone="info" data-update-available>{t('Update available')}</Badge>{/if}</strong><span class="muted mono">{row.ref || row.image}</span></span>
	{:else}{raw.text}{/if}
{/snippet}

{#snippet containerActions(row)}
	{@const link = linkOf(row)}
	{#if link}<Button size="compact" variant="ghost" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} data-open-link={link.port}><Icon name="external" />{t('Open')}</Button>{/if}
	{#if row.state === 'running'}
		<Button size="compact" disabled={locked} onclick={() => request('restart', row)}>{t('Restart')}</Button>
		<Button size="compact" disabled={locked} onclick={() => request('stop', row)}>{t('Stop')}</Button>
	{:else}
		<Button size="compact" disabled={locked} onclick={() => act(row, 'start')}>{busy === row.id ? t('Starting…') : t('Start')}</Button>
	{/if}
{/snippet}

{#snippet imageActions(row)}
	{#if row.tags.length}<Button size="compact" disabled={locked} onclick={() => openCreate(row.tags[0])} data-action="create-from">{t('New container')}</Button>{/if}
	<Button size="compact" disabled={locked || row.containers > 0} title={row.containers ? t('Used by containers') : undefined} onclick={() => request('image', row)}>{t('Remove')}</Button>
{/snippet}

<Dialog open={!!confirm} tone={confirm?.kind === 'restart' || confirm?.kind === 'update' || confirm?.kind === 'updateAll' ? 'primary' : 'danger'} busy={locked}
	title={confirm ? TITLES[confirm.kind](confirm) : ''} confirmLabel={confirm ? t(LABELS[confirm.kind]) : ''} cancelLabel={t('Cancel')}
	{onconfirm} onclose={() => { if (!busy) confirm = null; }}>
	{#if confirm?.kind === 'image'}{t('The image is deleted from the device. It can be downloaded again later.')}
	{:else if confirm?.kind === 'stop'}{t('Services provided by this container become unavailable until it is started again.')}
	{:else if confirm?.kind === 'restart'}{t('The container stops briefly and starts again.')}
	{:else if confirm?.kind === 'prune'}{t('Images that no container uses are deleted from the device. Images used by any container, running or stopped, are kept.')}
	{:else if confirm?.kind === 'updateAll'}
		<div class="confirm-body" data-update-all-dialog>
			<p>{t('The device downloads the newest image for each container below. Containers with a newer version are recreated with the same settings and stop briefly; volumes and folders are kept. If one fails, it is restored and the others continue.')}</p>
			<ul>{#each confirm.item as c}<li><span class="mono">{c.name}</span> <span class="muted">{c.ref}</span></li>{/each}</ul>
		</div>
	{:else if confirm?.kind === 'update'}<span data-update-dialog>{t('The device downloads the newest %s. If there is a newer version, the container is recreated with the same settings and stops briefly; volumes and folders are kept. If anything fails, the current container is restored.', confirm.item.image)}</span>
	{:else if confirm?.kind === 'remove'}
		<div class="confirm-body" data-remove-dialog>
			<p>{confirm.item.state === 'running' ? t('The container is running. It is stopped first, then deleted along with any changes made inside it. Folders shared from the device are kept.') : t('The container is deleted along with any changes made inside it. Folders shared from the device are kept.')}</p>
			<Checkbox bind:checked={removeVolumes} disabled={locked}>{t('Also delete its unnamed volumes')}</Checkbox>
		</div>
	{/if}
</Dialog>

{#if error}<Feedback tone="error" message={error} onretry={load} />{/if}
{#if notice}<Feedback tone={notice.tone} message={notice.text} />{/if}
{#if data === undefined && !error}
	<Feedback tone="loading" message={t('Loading…')} />
{:else if data === null}
	<Feedback tone="info" message={t('The Docker service is not available on this device. Reinstall sight-app-docker.')} />
{:else if data && !data.reachable}
	<Card>
		<StatusHero data-docker="down" icon="container" tone="muted" title={t('Docker is not running')} status={data.error || t('The Docker service cannot be reached.')}>
			{#snippet actions()}<Button variant="primary" disabled={!!busy} onclick={startService}>{busy === 'service' ? t('Starting…') : t('Start Docker')}</Button>{/snippet}
		</StatusHero>
	</Card>
{:else if data}
	<div class="stack">
		<Card>
			<StatusHero data-docker="up" icon="container" title={t('%d of %d containers running', data.info.running, data.info.total)}
				hint={[t('Docker %s', data.info.version), data.disk != null ? t('Images use %s', fmtBytes(data.disk)) : '', data.info.root].filter(Boolean).join(' · ')}>
				{#snippet actions()}<Button onclick={load} disabled={locked}>{t('Refresh')}</Button>{/snippet}
			</StatusHero>
		</Card>
		{#if problem === 'unsupported'}
			<Callout tone="danger" data-root-problem="unsupported" message={t('Docker keeps its data in %s, which is on %s. Containers cannot be created or started there. Move the data directory to a disk formatted as ext4.', data.rootStatus.root, data.rootStatus.fstype === 'overlay' ? t('the router’s internal storage') : data.rootStatus.fstype)}>
				<Button size="compact" variant="primary" onclick={() => changeSection('settings')}>{t('Change data directory')}</Button>
			</Callout>
		{:else if problem === 'shadowed'}
			<Callout tone="danger" data-root-problem="shadowed" message={t('A disk was mounted over %s while Docker was running, so Docker still uses the old location and containers fail with “blob not found”. Restart Docker to use the disk; images need to be downloaded again.', data.rootStatus.root)}>
				<Button size="compact" variant="primary" disabled={locked} onclick={restartForDisk}>{busy === 'service' ? t('Restarting…') : t('Restart Docker')}</Button>
			</Callout>
		{:else if problem === 'temporary'}
			<Callout tone="warning" data-root-problem="temporary" message={t('Docker keeps its data in memory (%s). Images and containers are lost when the router restarts.', data.rootStatus.root)}>
				<Button size="compact" onclick={() => changeSection('settings')}>{t('Change data directory')}</Button>
			</Callout>
		{/if}
		{#if task && taskShown}<Card name="docker-task"><div data-docker-task><TaskProgress {task} {output} ondismiss={() => taskShown = false} />
			{#if task.kind === 'migrate' && migrateSkipped.length}<p class="muted" data-migrate-skipped>{t('Not moved because they were created from an image ID: %s', migrateSkipped.join(', '))}</p>{/if}</div></Card>{/if}

		<div class="workspace-tabs"><Tabs id={tabsId} label={t('Docker')} items={tabs} bind:value={section} variant="underline" onchange={changeSection} /></div>
		<div id={`${tabsId}-panel-0`} role="tabpanel" aria-labelledby={`${tabsId}-tab-0`} hidden={section !== 'containers'} tabindex="0">
			<div class="stack">
				{#if troubled.length}
					<Callout tone="danger" data-trouble message={t('These containers keep restarting or fail their health check: %s. Open one to see its logs.', troubled.map(c => c.name).join(', '))}>
						{#each troubled.slice(0, 3) as c (c.id)}<Button size="compact" onclick={() => openDetail(c)}>{c.name}</Button>{/each}
					</Callout>
				{/if}
				<Card icon="container" flush>
					<Toolbar label={t('Containers')} count={[t('%d running', data.info.running), checked ? t('Checked for updates %s', date(checked)) : ''].filter(Boolean).join(' · ')} live={false}>
						{#snippet search()}<Input type="search" size="compact" placeholder={t('Search by name, image or port')} bind:value={query} aria-label={t('Search containers')} data-container-search />{/snippet}
						{#snippet actions()}
							<Button size="compact" disabled={locked || !refs.length} onclick={checkUpdates} data-action="check-updates">{task?.kind === 'check' && taskRunning ? t('Checking…') : t('Check for updates')}</Button>
							{#if outdated.length}<Button size="compact" disabled={locked} onclick={() => request('updateAll', outdated)} data-action="update-all">{t('Update all (%d)', outdated.length)}</Button>{/if}
							<Button variant="primary" size="compact" disabled={locked} onclick={() => openCreate()} data-action="create">{t('New container')}</Button>
						{/snippet}
					</Toolbar>
					<Table headers={containerHeaders} rows={groups.standalone} cells={containerCells} rowKey={c => c.id} rowAttrs={containerAttrs}
						cellContent={containerContent} actions={containerActions} actionsLabel={t('Actions')}
						empty={query.trim() ? (groups.projects.length ? t('Matching containers are in the Compose projects below.') : t('No containers match the search.')) : groups.projects.length ? t('All containers belong to Compose projects, listed below.') : t('No containers yet. Create one from an image.')} />
				</Card>
				{#each groups.projects as g (g.name)}
					<Card icon="container" title={t('Compose project %s', g.name)} name={`compose-${g.name}`} flush>
						{#snippet actions()}<Button size="compact" variant="ghost" onclick={() => changeSection('compose')}>{t('Manage')}</Button>{/snippet}
						<div data-compose-group={g.name}>
							<Table headers={containerHeaders} rows={g.containers} cells={containerCells} rowKey={c => c.id} rowAttrs={containerAttrs}
								cellContent={containerContent} actions={containerActions} actionsLabel={t('Actions')} empty="" />
						</div>
					</Card>
				{/each}
			</div>
		</div>
		<div id={`${tabsId}-panel-1`} role="tabpanel" aria-labelledby={`${tabsId}-tab-1`} hidden={section !== 'compose'} tabindex="0">
			{#if section === 'compose'}<Compose {svc} compose={data.compose} {task} {output} {locked} onstart={composeStart} onreload={load} />{/if}
		</div>
		<div id={`${tabsId}-panel-2`} role="tabpanel" aria-labelledby={`${tabsId}-tab-2`} hidden={section !== 'images'} tabindex="0">
			<Card icon="container" flush>
				<Toolbar label={t('Images')} count={t('%d unused', unused)} live={false}>
					{#snippet actions()}
						<Button size="compact" disabled={locked || !unused} onclick={() => request('prune')} data-action="prune">{busy === 'prune' ? t('Removing…') : t('Remove unused')}</Button>
						<Button variant="primary" size="compact" disabled={locked} onclick={openPull} data-action="pull">{t('Download image')}</Button>
					{/snippet}
				</Toolbar>
				<Table headers={[t('Image'), 'ID', t('Size'), t('Created'), t('Used by')]} rows={data.images} cells={imageCells} rowKey={i => i.id}
					rowAttrs={i => ({ 'data-image': i.tags[0] || short(i.id) })} actions={imageActions} actionsLabel={t('Actions')} empty={t('No images')} />
			</Card>
		</div>
		<div id={`${tabsId}-panel-3`} role="tabpanel" aria-labelledby={`${tabsId}-tab-3`} hidden={section !== 'resources'} tabindex="0">
			{#if section === 'resources'}<Resources {svc} networks={data.networks} volumes={data.volumes} {locked} onreload={load} />{/if}
		</div>
		<div id={`${tabsId}-panel-4`} role="tabpanel" aria-labelledby={`${tabsId}-tab-4`} hidden={section !== 'storage'} tabindex="0">
			{#if section === 'storage'}<Storage {svc} storage={data.storage} root={data.info.root} {locked} onreload={load} onlimitlogs={limitLogs} />{/if}
		</div>
		<div id={`${tabsId}-panel-5`} role="tabpanel" aria-labelledby={`${tabsId}-tab-5`} hidden={section !== 'settings'} tabindex="0">
			{#if section === 'settings'}<Settings {svc} root={data.info.root} mirrors={data.info.mirrors} rootStatus={data.rootStatus} hasData={!!(data.containers.length || data.volumes?.length)} onreload={load} onmigrate={migrateTo} />{/if}
		</div>

		<Drawer error={notice?.tone === 'error' ? notice.text : ''} open={!!detail} title={detail?.name || ''} onclose={closeDetail}>
			{#if detail}
				{#key `${detail.id}:${detailVersion}`}
					<ContainerDetail {svc} container={detail} memTotal={data.info.memory} {locked} updateAvailable={updates[detail.id] === 'available'} onrequest={kind => request(kind, detail)} onstart={() => act(detail, 'start')} onedit={() => openEdit(detail)} />
				{/key}
			{/if}
		</Drawer>

		<Drawer open={creating} title={t('New container')} onclose={closeCreate}>
			{#if creating}
				<CreateContainer {svc} images={data.images} image={createFrom} names={data.containers.map(c => c.name)} networks={userNetworks} volumes={volumeNames} cpus={data.info.cpus} dataRoot={data.info.root} {timezone} pullTask={task?.kind === 'pull' ? task : null} {pull} oncancel={closeCreate} oncreated={created} />
			{/if}
		</Drawer>

		<Drawer open={!!editing} title={editing?.name ? t('Edit %s', editing.name) : t('Edit container')} onclose={closeEdit}>
			{#if editing === 'loading'}<Feedback tone="loading" message={t('Loading…')} />
			{:else if editing}
				<CreateContainer {svc} images={data.images} names={data.containers.map(c => c.name)} networks={userNetworks} volumes={volumeNames} cpus={data.info.cpus} dataRoot={data.info.root} {timezone} edit={editing} onedit={saveEdit} oncancel={closeEdit} />
			{/if}
		</Drawer>

		<Drawer open={pullOpen} title={t('Download image')} onclose={closePull}>
			{#if pullOpen}
				<form class="form" onsubmit={submitPull} aria-label={t('Download image')} data-pull-form>
					<ErrorSummary errors={pullErrors} bind:this={pullSummary} />
					<ImageSearch {svc} selected={normalizeImage(pullRef)} onpick={ref => { pullRef = ref; pullErrors = []; }} />
					<Field id="pull-image" label={t('Image')} help={t('From Docker Hub unless a registry is given, for example ghcr.io/owner/app:tag. Without a tag, latest is used.')}>
						<Input id="pull-image" name="pullImage" bind:value={pullRef} placeholder="nginx:latest" spellcheck="false" autocomplete="off" aria-describedby="pull-image-help" />
					</Field>
					<p class="muted">{t('The download continues on the device in the background. You can leave this page; progress is shown at the top of this page.')}</p>
					<FormActions oncancel={closePull} saveLabel={t('Download')} />
				</form>
			{/if}
		</Drawer>
	</div>
{/if}

<style lang="less">
	.stack { display: flex; flex-direction: column; gap: var(--sp-4); }
	.form { display: flex; flex-direction: column; gap: var(--sp-5); }
	.name { display: flex; flex-direction: column; min-width: 0; }
	.badges { display: inline-flex; flex-wrap: wrap; gap: var(--sp-1); }
	.name strong { color: var(--heading-color); font-weight: var(--fw-semibold); }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
	.mono { font-family: var(--font-family-monospace); font-size: var(--fs-xs); }
	.confirm-body { display: flex; flex-direction: column; gap: var(--sp-3); }
	.confirm-body p, .confirm-body ul { margin: 0; }
	.confirm-body ul { padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-1); }
</style>
