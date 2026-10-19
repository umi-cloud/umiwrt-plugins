#!/usr/bin/env node
/*
 * Docker 的 Sight 页面真实流程验收，需在装有 dockerd、docker CLI、docker-compose、ttyd、sight-ui 与本插件的专用容器运行。
 *   1. rpcd 接口签名逐字比对
 *   2. ACL：页面所需权限只来自本包的 sight-plugin-docker 组；不放行 docker CLI、exec 进容器、写容器文件、原始拉取/导入镜像；
 *      sight.docker 的方法拒绝不合格的参数（镜像引用、项目名、终端监听地址）
 *   3. 容器停止/启动/重启回读、列表的 CPU 与内存、在别处启停后列表自动回读、详情与日志（设备端解复用；行数、筛选、时间、跟随、下载）、
 *      资源占用、修改重启策略、使用中的镜像不可删除
 *   4. 终端：一次性 ttyd 会话（页面启动/结束；监听地址、一次性路径、来源校验、单连接、无人连接超时、HTTPS）；
 *      经 websocket 在容器里执行命令（宿主需有 node:22-alpine 镜像，在设备容器的网络命名空间里运行探针）
 *   5. 新建容器（端口、只读目录、环境变量、命令）并启动，列表与详情的「打开」链接，再删除
 *   6. 下载镜像（后台任务）与清理未使用的镜像
 *   7. 更新容器：有新版时用原配置重建（配置、标签、匿名卷数据保留），再次更新提示「已是最新」
 *   8. 编辑容器重建；端口冲突时重建失败并恢复原容器；批量更新（失败的跳过、其余照常更新）与检查更新（只查仓库摘要，不下载）
 *   9. 网络与卷的新建、删除，清理未使用的卷；在自定义网络上新建带固定地址、主机名、内存/CPU 上限、设备与时区的容器，编辑后重建
 *  9b. 存储空间：各项占用，删除已停止的容器（测试前提 sight-job 删除后按原命令重建）
 *  10. Compose：新建项目、启动、编辑后重建、拉取更新、停止、删除（连同卷）；别处创建的项目只读显示并可停止
 *  11. 设置：镜像加速与数据目录写入 uci、经 reload 生效再恢复；未配置加速时一键使用国内镜像；窄屏截图；
 *      宿主有 sight.storage 时挂一块 ext4 的 loop 盘，核对数据盘建议与一键填入（只在有调试容器标记时做）
 *  12. 装包预置国内镜像加速只做一次
 * 会修改并恢复配置。公共底座取自 sight-ui 工程：
 *   DOCKER_LOCAL=1 SIGHT_UI=/path/to/sight-ui LUCI_URL=http://127.0.0.1:8148 CONTAINER=<专用容器> node sight/scripts/flow-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIGHT_UI = process.env.SIGHT_UI?.trim();
if (!SIGHT_UI) { console.error('必须设置 SIGHT_UI，指向 sight-ui 工程目录。'); process.exit(2); }
const { createFlow } = await import(pathToFileURL(resolve(SIGHT_UI, 'scripts/lib/plugin-flow.mjs')).href);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = resolve(ROOT, '..');
const { BASE, CONTAINER, check, section, sleep, sh, ubus, denied, contract, withAclUser, browser, finish } = await createFlow({ id: 'docker', outDir: join(ROOT, '.visual-out/flow') });

/* 需可用的守护进程，二选一，都要准备运行中的 sight-web 与已退出的 sight-job（busybox:stable，日志含 job done）：
   - DOCKER_LOCAL=1：专用容器内的 dockerd（与真机一致，容器需特权）；
   - 否则 dockerd.globals.hosts 指向隔离的 DinD
     （docker run -d --privileged --name sight-dind -e DOCKER_TLS_CERTDIR= docker:dind dockerd --host=tcp://0.0.0.0:2375）。
   都没有时跳过页面流程，并在报告中注明。终端、更新、编辑与 Compose 只在 DOCKER_LOCAL=1 时验收 */
const LOCAL = process.env.DOCKER_LOCAL === '1';
const DIND = cmd => LOCAL ? sh(cmd)
	: execFileSync('docker', ['exec', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', 'sight-dind', 'sh', '-c', cmd], { encoding: 'utf8' });
const shIn = (cmd, input) => execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', cmd], { encoding: 'utf8', input });
const NEW = 'sight-flow-new', UPD = 'sight-flow-upd', PULL = 'hello-world:latest', MIRROR = 'https://mirror.sight-flow.example';
const NET = 'sight-flow-net', VOL = 'sight-flow-vol', PRUNE_VOL = 'sight-flow-prune', PROJECT = 'sightflow', EXT = 'sightext';
const LIM = 'sight-flow-lim', UPD2 = 'sight-flow-upd2', BAD = 'sight-flow-bad', BAD_REF = 'sightflow/nonexistent:latest', STOPPED = 'sight-flow-stopped';
const UPDATES = '/tmp/sight-docker/updates.json';
const FLOW_ROOT = '/tmp/docker-flow/';
const PRESETS = ['https://docker.1ms.run', 'https://docker.m.daocloud.io'];
const LAN = '192.168.1.1';
const PROBE = join(ROOT, 'scripts/ttyd-probe.mjs');
const exists = name => DIND(`docker inspect ${name} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'yes';
const json = cmd => JSON.parse(sh(cmd));
/* 设备上以 root 直调 sight.docker（CLI 不经 ACL） */
const sd = (method, args = {}) => json(`ubus call sight.docker ${method} '${JSON.stringify(args)}'`);
/* 在设备容器的网络命名空间里跑 websocket 探针 */
let probeImage = false;
try { execFileSync('docker', ['image', 'inspect', 'node:22-alpine'], { stdio: 'ignore' }); probeImage = true; } catch { /* 没有探针镜像 */ }
const probe = (url, command, origin) => {
	try { return { ok: true, out: execFileSync('docker', ['run', '--rm', '--network', `container:${CONTAINER}`, '-v', `${PROBE}:/probe.mjs:ro`, 'node:22-alpine', 'node', '/probe.mjs', url, command, ...(origin != null ? [origin] : [])], { encoding: 'utf8', timeout: 30000 }) }; }
	catch (e) { return { ok: false, out: String(e.stdout || e.message) }; }
};
const httpStatus = url => {
	try { return execFileSync('docker', ['run', '--rm', '--network', `container:${CONTAINER}`, 'node:22-alpine', 'node', '-e', `process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';fetch(${JSON.stringify(url)},{redirect:'manual'}).then(r=>console.log(r.status)).catch(()=>console.log(0))`], { encoding: 'utf8', timeout: 30000 }).trim(); }
	catch { return '0'; }
};
const listening = port => sh(`netstat -ltn 2>/dev/null | awk '{print $4}' | grep -E ':${port}$' || true`).trim();
const waitListen = async port => { for (let i = 0; i < 20 && !listening(port); i++) await sleep(300); return listening(port); };

section('接口签名');
contract('sight.docker', { version: {}, info: {}, df: {} });
contract('sight.docker.container', {
	list: { query: 'Table' }, inspect: { id: 'String', query: 'Table' }, stats: { id: 'String', query: 'Table' },
	start: { id: 'String', query: 'Table' }, stop: { id: 'String', query: 'Table' }, restart: { id: 'String', query: 'Table' },
	create: { query: 'Table', body: 'Table' }, remove: { id: 'String', query: 'Table' }, update: { id: 'String', body: 'Table' },
});
contract('sight.docker.image', { list: { query: 'Table' }, inspect: { id: 'String' }, remove: { id: 'String', query: 'Table' }, prune: { query: 'Table' } });
contract('sight.docker.network', { list: { query: 'Table' }, create: { body: 'Table' }, remove: { id: 'String' } });
contract('sight.docker.volume', { list: { query: 'Table' }, create: { opts: 'Table' }, remove: { id: 'String', query: 'Table' }, prune: { query: 'Table' } });
contract('sight.docker', {
	logs: { id: 'String', tail: 'Integer', since: 'String' }, usage: {}, task_status: {}, pull_start: { image: 'String' },
	recreate_start: { id: 'String', mode: 'String', name: 'String', body: 'Table' },
	check_start: { images: 'Array' }, check_list: {}, update_start: { items: 'Array' },
	compose_list: {}, compose_read: { name: 'String' }, compose_write: { name: 'String', content: 'String', create: 'Boolean' }, compose_start: { name: 'String', action: 'String', volumes: 'Boolean' },
	terminal_start: { id: 'String', host: 'String', tls: 'Boolean' }, terminal_status: { id: 'String' }, terminal_stop: { id: 'String' },
});

section('ACL：权限来自本包');
await withAclUser(['sight-ui'], async sid => {
	check(denied(await ubus(sid, 'sight.docker', 'version')) && denied(await ubus(sid, 'sight.docker', 'task_status')) && denied(await ubus(sid, 'uci', 'get', { config: 'dockerd' })), '只有 sight-ui 组的账号不能访问 Docker');
});
await withAclUser(['sight-ui', 'sight-plugin-docker'], async sid => {
	for (const [o, m, p] of [['sight.docker', 'version', {}], ['sight.docker.container', 'list', { query: { all: true } }], ['sight.docker.image', 'list', {}], ['sight.docker.network', 'list', { query: {} }],
		['sight.docker.volume', 'list', { query: {} }], ['sight.docker', 'task_status', {}], ['sight.docker', 'compose_list', {}], ['sight.docker', 'terminal_status', { id: 'sight-web' }],
		['sight.docker', 'logs', { id: 'sight-job', tail: 5 }], ['sight.docker', 'usage', {}], ['sight.docker', 'check_list', {}], ['uci', 'get', { config: 'dockerd' }]])
		check((await ubus(sid, o, m, p))?.[0] === 0, `加上本包权限组后可调用 ${o}.${m}`);
	/* 写操作用不存在的对象试探：放行时由 Docker 回 4xx，而不是被 ACL 拒绝 */
	const missing = 'sight-flow-missing';
	const allowed = [
		await ubus(sid, 'sight.docker.container', 'remove', { id: missing, query: {} }), await ubus(sid, 'sight.docker.container', 'update', { id: missing, body: {} }),
		await ubus(sid, 'sight.docker.container', 'create', { query: { name: missing }, body: { Image: 'sight-flow-missing-image:none' } }),
		await ubus(sid, 'sight.docker.network', 'remove', { id: missing }), await ubus(sid, 'sight.docker.volume', 'remove', { id: missing, query: {} }),
	];
	check(allowed.every(r => r?.[0] === 0 && r[1]?.code >= 400), '新建/删除容器、重启策略、网络与卷的删除已放行（不存在的对象由 Docker 报错）', allowed);
	const injected = await ubus(sid, 'sight.docker', 'pull_start', { image: 'busybox; touch /tmp/sight-flow-pwned' });
	const badRecreate = await ubus(sid, 'sight.docker', 'recreate_start', { id: 'sight-web', mode: 'edit', name: 'xy', body: { Image: 'busybox:stable; id' } });
	const badMode = await ubus(sid, 'sight.docker', 'recreate_start', { id: 'sight-web', mode: 'rm', name: '', body: {} });
	const badProject = await ubus(sid, 'sight.docker', 'compose_write', { name: '../etc', content: 'services: {}', create: true });
	const badAction = await ubus(sid, 'sight.docker', 'compose_start', { name: 'x;id', action: 'up', volumes: false });
	const badHost = await ubus(sid, 'sight.docker', 'terminal_start', { id: 'sight-web', host: '8.8.8.8', tls: false });
	const badId = await ubus(sid, 'sight.docker', 'terminal_start', { id: '-it', host: LAN, tls: false });
	const badCheck = await ubus(sid, 'sight.docker', 'check_start', { images: ['busybox; touch /tmp/sight-flow-pwned'] });
	const badDigest = await ubus(sid, 'sight.docker', 'check_start', { images: [`alpine@sha256:${'a'.repeat(64)}`] });
	const badItems = await ubus(sid, 'sight.docker', 'update_start', { items: [{ id: '-x', body: {} }] });
	const badSince = await ubus(sid, 'sight.docker', 'logs', { id: 'sight-job', tail: 5, since: '1; id' });
	check(injected?.[1]?.error === 'invalid image' && badRecreate?.[1]?.error === 'invalid image' && badMode?.[1]?.error === 'invalid' && badProject?.[1]?.error === 'invalid'
		&& badAction?.[1]?.error === 'invalid' && badHost?.[1]?.error === 'not_lan' && badId?.[1]?.error === 'invalid'
		&& badCheck?.[1]?.error === 'invalid image' && badDigest?.[1]?.error === 'invalid image' && badItems?.[1]?.error === 'invalid' && badSince?.[1]?.code === 400
		&& sh('[ -e /tmp/sight-flow-pwned ] && echo yes || echo no').trim() === 'no', 'sight.docker 拒绝不合格的镜像引用（含检查更新）、模式、项目名、终端监听地址、容器 ID 与日志起始时间',
	{ injected, badRecreate, badMode, badProject, badAction, badHost, badId, badCheck, badDigest, badItems, badSince });
	const cli = await ubus(sid, 'file', 'exec', { command: '/usr/bin/docker', params: ['logs', '--tail', '200', '--timestamps', 'f'.repeat(64)] });
	check(cli?.[0] === 6, '不放行 docker CLI', cli);
	const rejected = [
		await ubus(sid, 'sight.docker.container', 'exec', { id: missing, opts: {} }), await ubus(sid, 'sight.docker.container', 'put_archive', { id: missing, query: {}, body: '' }),
		await ubus(sid, 'sight.docker.exec', 'start', { id: missing, body: '' }), await ubus(sid, 'sight.docker.image', 'create', { query: {}, headers: {} }),
		await ubus(sid, 'sight.docker.image', 'load', { query: {} }), await ubus(sid, 'sight.docker.container', 'prune', { query: {} }),
		await ubus(sid, 'sight.docker.network', 'connect', { id: missing, body: {} }), await ubus(sid, 'sight.docker.container', 'rename', { id: missing, query: {} }),
		await ubus(sid, 'file', 'write', { path: '/etc/sight-docker/compose/x/compose.yaml', data: 'x' }),
	];
	check(rejected.every(denied), 'exec、写容器文件、原始拉取/导入镜像、批量清理容器、网络连接、改名与直接写文件仍未授权', rejected);
});

/* 测试前提 sight-job（已退出、日志含 job done）被清理删除后按原镜像与命令重建 */
const quote = a => `'${String(a).replace(/'/g, `'\\''`)}'`;
function restoreJob() {
	if (!original.job || exists('sight-job')) return;
	const entry = original.job.Entrypoint?.length ? `--entrypoint ${quote(original.job.Entrypoint[0])} ` : '';
	DIND(`docker run --name sight-job ${entry}${quote(original.job.Image)} ${[...(original.job.Entrypoint || []).slice(1), ...(original.job.Cmd || [])].map(quote).join(' ')} >/dev/null 2>&1; true`);
}

let dockerReady = false;
try { DIND('docker start sight-web >/dev/null; docker inspect sight-job >/dev/null'); dockerReady = /"code":\s*200/.test(sh('ubus call sight.docker version')); } catch { dockerReady = false; }
const original = {};
const flowVolumes = [];
let certAdded = false;
/* 数据盘建议：调试容器（有 /etc/sight-dev-container 标记、能用 losetup）里临时挂一块 ext4 盘 */
const DISK_IMG = '/root/sight-docker-disk.img', DISK_MNT = '/mnt/sight-docker-check';
let diskLoop = '';
if (sh('[ -f /etc/sight-dev-container ] && ubus list sight.storage >/dev/null 2>&1 && command -v losetup >/dev/null && echo yes || echo no').trim() === 'yes') {
	diskLoop = sh(`dd if=/dev/zero of=${DISK_IMG} bs=1M count=64 2>/dev/null; l=$(losetup -f --show ${DISK_IMG}); mkfs.ext4 -q -F $l >/dev/null 2>&1; mkdir -p ${DISK_MNT}; mount -t ext4 $l ${DISK_MNT}; echo $l`).trim();
}
if (dockerReady) {
	original.policy = DIND(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' sight-web`).trim() || 'no';
	original.root = sh('uci -q get dockerd.globals.data_root || true').trim();
	original.mirrors = sh('uci -q get dockerd.globals.registry_mirrors || true').trim();
	original.seeded = sh('uci -q get dockerd.globals.sight_mirrors_seeded || true').trim();
	original.hadPull = DIND(`docker image inspect ${PULL} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'yes';
	original.hadLatest = DIND('docker image inspect busybox:latest >/dev/null 2>&1 && echo yes || echo no').trim() === 'yes';
	original.hadMusl = DIND('docker image inspect busybox:musl >/dev/null 2>&1 && echo yes || echo no').trim() === 'yes';
	original.updates = sh(`cat ${UPDATES} 2>/dev/null || true`);
	original.job = JSON.parse(DIND('docker inspect sight-job'))[0].Config;
}

try {
	await browser(async ({ page, cdp, waitFor, fill, clickText, go, apply, confirmDialog, screenshot }) => {
		section('Docker');
		if (!dockerReady) {
			/* 没有可用的守护进程时只验证页面能加载并如实说明状态，其余流程跳过 */
			await go('#/docker', `!!document.querySelector('[data-docker]') || !!document.querySelector('main .feedback:not([data-tone=loading])')`);
			check(await page.evaluate(`document.querySelector('[data-docker]')?.dataset.docker !== 'up'`), 'Docker 后端不可用：页面加载并显示守护进程未运行，其余流程跳过');
			await screenshot('docker-down');
			return;
		}
		const main = `document.querySelector('main').textContent`;
		const drawer = `document.querySelector('dialog.drawer[open]')`;
		const inspect = (name, fmt) => DIND(`docker inspect -f '${fmt}' ${name}`).trim();
		const containerRunning = name => inspect(name, '{{.State.Running}}') === 'true';
		const closeDrawer = async () => { await page.evaluate(`${drawer}?.querySelector('.close').click()`); await sleep(400); };
		const tab = async label => { await page.evaluate(`[...document.querySelectorAll('.workspace-tabs [role=tab]')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`); await sleep(300); };
		const refresh = async () => { await page.evaluate(`document.querySelector('[data-docker] button').click()`); await sleep(800); };
		const hasButton = (scope, text) => `[...(${scope}?.querySelectorAll('button') || [])].some(b => b.textContent.trim() === ${JSON.stringify(text)})`;
		/* 无 id 的控件（端口/目录行）按选择器逐个赋值 */
		const setAll = (selector, values) => page.evaluate(`(() => { const els = document.querySelectorAll(${JSON.stringify(selector)}); ${JSON.stringify(values)}.forEach((v, i) => { els[i].value = v; els[i].dispatchEvent(new Event('input', { bubbles: true })); els[i].dispatchEvent(new Event('change', { bubbles: true })); }); })()`);
		const openContainer = async name => {
			await page.evaluate(`document.querySelector('tr[data-container="${name}"] td').click()`);
			await waitFor(`!!${drawer}?.querySelector('[data-container-detail="${name}"]')`, `${name} 详情`);
		};
		/* 后台任务：等设备上出现比 since 新的任务并结束，再等页面显示结果；返回 { state, text, task } */
		const taskStatus = () => sd('task_status').task;
		const lastStarted = () => taskStatus()?.started || 0;
		const taskDone = async (label, since, scope = '', ms = 240000) => {
			const t0 = Date.now();
			let t;
			while (Date.now() - t0 < ms) { t = taskStatus(); if (t && t.started >= since && t.state !== 'running') break; await sleep(1000); }
			if (!t || t.state === 'running') throw new Error('任务超时：' + label);
			const sel = `${scope} [data-task]`.trim();
			await waitFor(`document.querySelector(${JSON.stringify(sel)})?.dataset.taskState === ${JSON.stringify(t.state)} && document.querySelector(${JSON.stringify(sel)})?.dataset.taskStarted === '${t.started}'`, label, 15000);
			return { state: t.state, task: t, text: await page.evaluate(`document.querySelector(${JSON.stringify(sel)}).textContent`) };
		};
		const dismissTask = async () => { await page.evaluate(`[...document.querySelectorAll('[data-docker-task] [data-task] button')].find(b => b.textContent.trim() === 'Dismiss')?.click()`); await sleep(300); };
		const now = () => Math.floor(Date.now() / 1000) - 1;

		await go('#/docker', `!!document.querySelector('[data-docker="up"]')`);
		check(await page.evaluate(`/1 of 2 containers running/.test(document.querySelector('[data-docker]').textContent)`), '状态卡显示运行数量');
		check(await page.evaluate(`!/LuCI/.test(document.querySelector('main').textContent)`), '页面不再指向 LuCI');
		await clickText('tr[data-container="sight-web"] .actions button', 'Stop');
		await confirmDialog('Stop');
		await waitFor(`/Stopped sight-web/.test(${main}) && /Stopped/.test(document.querySelector('tr[data-container="sight-web"]')?.textContent || '')`, '停止容器', 40000);
		check(!containerRunning('sight-web') && await page.evaluate(`/Stopped/.test(document.querySelector('tr[data-container="sight-web"]').textContent)`), '停止后设备侧与界面一致');
		await clickText('tr[data-container="sight-web"] .actions button', 'Start');
		await waitFor(`/Started sight-web/.test(${main}) && /Running/.test(document.querySelector('tr[data-container="sight-web"]')?.textContent || '')`, '启动容器');
		check(containerRunning('sight-web'), '启动后运行');
		await clickText('tr[data-container="sight-web"] .actions button', 'Restart');
		await confirmDialog('Restart');
		await waitFor(`/Restarted sight-web/.test(${main})`, '重启容器', 40000);
		check(containerRunning('sight-web'), '重启后运行');
		const row = name => `(document.querySelector('tr[data-container="${name}"]')?.textContent || '')`;
		await waitFor(`/\\d+\\.\\d%/.test(${row('sight-web')})`, '列表显示 CPU 占用', 20000);
		check(await page.evaluate(`!/%/.test(${row('sight-job')})`), '列表显示运行中容器的 CPU 与内存，已停止的不显示');
		/* 在设备上直接启停：列表随资源采样发现变化后自动回读 */
		DIND('docker stop -t 1 sight-web >/dev/null');
		await waitFor(`/Stopped/.test(${row('sight-web')})`, '别处停止后列表自动更新', 20000);
		DIND('docker start sight-web >/dev/null');
		await waitFor(`/Running/.test(${row('sight-web')})`, '别处启动后列表自动更新', 20000);
		check(true, '在设备上启停容器后，列表无需刷新即自动更新');
		await setAll('[data-container-search]', ['JOB']);
		await waitFor(`!document.querySelector('tr[data-container="sight-web"]') && !!document.querySelector('tr[data-container="sight-job"]')`, '容器搜索');
		await setAll('[data-container-search]', ['zzz-none']);
		await waitFor(`/No containers match the search/.test(${main})`, '搜索无结果');
		await setAll('[data-container-search]', ['']);
		await waitFor(`!!document.querySelector('tr[data-container="sight-web"]')`, '清空搜索');
		check(true, '容器列表按名称等搜索（不区分大小写），无结果时说明');

		section('详情：日志、资源占用、重启策略');
		await openContainer('sight-job');
		await waitFor(`!${drawer}.querySelector('.feedback[data-tone=loading]')`, '容器详情加载');
		const logText = await page.evaluate(`${drawer}.querySelector('pre, [role=log], .log')?.textContent || ${drawer}.textContent`);
		check(/job done/.test(logText) && !/[\u0000-\u0008]/.test(logText), '详情显示容器日志（设备端解开多路复用流，无帧头残留）', logText.slice(-200));
		check(await page.evaluate(`!${drawer}.querySelector('[data-terminal]')`), '已停止的容器不提供终端');
		await screenshot('docker');
		await closeDrawer();

		await openContainer('sight-web');
		await waitFor(`!!${drawer}.querySelector('[data-usage]')`, '运行中容器的资源占用');
		await waitFor(`/\\d+\\.\\d%/.test(${drawer}.querySelector('[data-usage]').textContent)`, 'CPU 占用', 15000);
		const usageText = await page.evaluate(`${drawer}.querySelector('[data-usage]').textContent`);
		check(/CPU\s*\d+\.\d%/.test(usageText) && /Memory/.test(usageText), '资源占用显示 CPU 百分比与内存（嵌套容器取不到内存时显示不可用）', usageText);
		await screenshot('docker-usage');

		/* 日志工具：往容器主进程的标准输出写入记录 */
		const emit = text => DIND(`docker exec sight-web sh -c 'echo ${text} > /proc/1/fd/1'`);
		const logView = `(${drawer}.querySelector('[data-logs] pre')?.textContent || '')`;
		emit('flow-log-1');
		await page.evaluate(`[...${drawer}.querySelectorAll('[data-logs] button')].find(b => b.textContent.trim() === 'Refresh logs').click()`);
		await waitFor(`/flow-log-1/.test(${logView})`, '日志读到新记录');
		await setAll('dialog.drawer[open] [data-log-search]', ['zzz-no-match']);
		await waitFor(`/No lines match the search/.test(${drawer}.querySelector('[data-logs]').textContent)`, '日志筛选无结果');
		await setAll('dialog.drawer[open] [data-log-search]', ['FLOW-LOG']);
		await waitFor(`/flow-log-1/.test(${logView}) && /\\d+ of \\d+ lines/.test(${drawer}.querySelector('[data-logs]').textContent)`, '日志按关键字筛选（不区分大小写）');
		check(true, '日志按关键字筛选，无结果时说明');
		await setAll('dialog.drawer[open] [data-log-search]', ['']);
		await page.evaluate(`[...${drawer}.querySelectorAll('[data-logs] label')].find(l => l.textContent.trim() === 'Show time').querySelector('input').click()`);
		await waitFor(`/^\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d  flow-log-1$/m.test(${logView})`, '日志显示时间');
		check(true, '日志可显示每行的时间（浏览器时区）');
		await setAll('dialog.drawer[open] [data-log-lines]', ['1000']);
		await sleep(1500);
		await screenshot('docker-logs-lines');
		await waitFor(`/flow-log-1/.test(${logView})`, '改行数后重读');
		check(await page.evaluate(`${drawer}.querySelector('[data-log-lines]').value`) === '1000', '日志行数可选 200/1000/5000');
		await page.evaluate(`${drawer}.querySelector('[data-log-follow]').click()`);
		await sleep(500);
		emit('flow-follow-2');
		await waitFor(`/flow-follow-2/.test(${logView})`, '跟随：新记录自动出现', 15000);
		emit('flow-follow-3');
		await waitFor(`/flow-follow-3/.test(${logView})`, '跟随：继续追加', 15000);
		check(await page.evaluate(`${logView}.split('\\n').filter(l => /flow-follow-2/.test(l)).length === 1`), '跟随时只追加新记录，不重复');
		await page.evaluate(`${drawer}.querySelector('[data-log-follow]').click()`);
		/* 下载：截住生成的文件 */
		await page.evaluate(`(() => { window.__flowBlob = null; const create = URL.createObjectURL; URL.createObjectURL = b => { window.__flowBlob = b; return create.call(URL, b); };
			const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__flowName = this.download; return; } return click.call(this); }; })()`);
		await page.evaluate(`${drawer}.querySelector('[data-log-download]').click()`);
		const dl = await page.evaluate(`(async () => ({ name: window.__flowName, text: await window.__flowBlob?.text() }))()`);
		check(/^sight-web-.+\.log$/.test(dl.name || '') && /flow-follow-3/.test(dl.text || ''), '下载当前显示的日志', dl.name);
		await screenshot('docker-logs');
		const target = original.policy === 'always' ? 'on-failure' : 'always';
		for (const [policy, label] of [[target, `重启策略写入容器（${target}）`], [original.policy, '重启策略经界面恢复']]) {
			await fill({ 'docker-restart-policy': policy });
			await clickText('dialog.drawer[open] button', 'Save restart policy');
			await waitFor(`!${hasButton(drawer, 'Save restart policy')} && /Restart policy saved/.test(${drawer}.textContent)`, '保存重启策略');
			check(inspect('sight-web', '{{.HostConfig.RestartPolicy.Name}}') === policy, label);
		}

		let idle = null, idleStarted = 0;
		if (LOCAL) {
			section('终端');
			/* 页面启动会话：浏览器以 127.0.0.1 访问 Sight（端口映射），会话只绑定回环地址；弹窗替换为记录地址 */
			await page.evaluate(`(() => { window.__opened = []; window.open = () => { const w = { opener: 1, close() { w.closed = true; }, location: { set href(v) { window.__opened.push(v); } } }; return w; }; })()`);
			await waitFor(`!!${drawer}.querySelector('[data-action=terminal]')`, '终端分区');
			await page.evaluate(`${drawer}.querySelector('[data-action=terminal]').click()`);
			await waitFor(`window.__opened.length > 0 && /Waiting for the terminal tab/.test(${drawer}.textContent)`, '启动终端会话', 15000);
			const opened = await page.evaluate(`window.__opened[0]`);
			const m = /^http:\/\/127\.0\.0\.1:(\d+)(\/[a-f0-9]{32}\/)$/.exec(opened || '');
			check(!!m, '页面以浏览器访问的主机名、随机端口与一次性路径打开终端', opened);
			if (m) {
				await waitFor(`${drawer}.querySelector('[data-terminal]')?.dataset.terminal === 'ready'`, '会话就绪', 10000);
				const addr = await waitListen(m[1]);
				check(addr === `127.0.0.1:${m[1]}`, 'ttyd 只监听浏览器访问的本机地址（此处为回环）', addr);
				const cmdline = sh(`for p in $(pidof ttyd); do tr '\\0' ' ' < /proc/$p/cmdline; echo; done | grep -- '${m[2].slice(0, -1)}' || true`).trim();
				check(/--once/.test(cmdline) && /--check-origin/.test(cmdline) && /\/usr\/bin\/docker exec -it [a-f0-9]{64} \/bin\/sh -c /.test(cmdline) && !/ -c \S+:\S+ /.test(cmdline.split(' /usr/bin/docker')[0]),
					'ttyd 以参数数组启动：一次性、校验来源、docker exec 进容器，不带基本认证口令', cmdline);
				await screenshot('docker-terminal');
				await clickText('dialog.drawer[open] [data-terminal] button', 'End session');
				await waitFor(`!['ready', 'starting'].includes(${drawer}.querySelector('[data-terminal]')?.dataset.terminal)`, '结束会话', 10000);
				await sleep(1000);
				check(!listening(m[1]), '结束会话后端口关闭');
			}
			/* 接口直接启动（LAN 地址），经 websocket 执行命令 */
			const s = sd('terminal_start', { id: 'sight-web', host: LAN, tls: false }).session;
			check(!!s?.path && /^\/[a-f0-9]{32}\/$/.test(s.path) && s.port >= 7682 && s.port < 7782, 'LAN 地址启动会话：端口在固定范围、路径为 128 位随机值', s);
			const notRunning = sd('terminal_start', { id: 'sight-job', host: LAN, tls: false });
			const mgmt = sd('terminal_start', { id: 'sight-web', host: '172.17.0.10', tls: false });
			check(notRunning.error === 'not_running' && mgmt.error === 'not_lan', '已停止的容器、不在放行入站区域的接口地址都不能启动终端', { notRunning, mgmt });
			if (s?.path) {
				check(await waitListen(s.port) === `${LAN}:${s.port}`, 'ttyd 只监听 LAN 地址', listening(s.port));
				check(!sh('logread 2>/dev/null || true').includes(s.path.slice(1, -1)), '一次性路径不写进系统日志');
				if (probeImage) {
					const base = `http://${LAN}:${s.port}`;
					const codes = [httpStatus(`${base}/`), httpStatus(`${base}/${'0'.repeat(32)}/`), httpStatus(`${base}${s.path}`)];
					check(codes.join() === '404,404,200', '只有一次性路径可访问，其余 404', codes);
					const cross = probe(`ws://${LAN}:${s.port}${s.path}ws`, 'id', 'http://evil.example');
					check(!cross.ok, '来源不同的 websocket 被拒绝', cross.out);
					const run = probe(`ws://${LAN}:${s.port}${s.path}ws`, 'echo "in:$(hostname)"');
					const short = inspect('sight-web', '{{.Id}}').slice(0, 12);
					check(run.ok && run.out.includes(`in:${short}`), '经 websocket 在容器内执行命令', run.out.slice(-300));
					await sleep(1500);
					check(!listening(s.port), '连接断开后会话结束（只接受一个连接）');
					const st = sd('terminal_status', { id: 'sight-web' }).session;
					check(st?.state === 'ended' && !!st.connected && !st.path, '会话状态为已结束且不再返回一次性路径', st);
				} else check(true, '宿主没有 node:22-alpine 镜像，跳过 websocket 探针');
			}
			/* HTTPS：Sight 以 https 访问时终端同样用 TLS（复用 uhttpd 证书；测试容器没有证书时临时生成） */
			const certPath = sh('uci -q get uhttpd.main.cert || echo /etc/uhttpd.crt').trim(), keyPath = sh('uci -q get uhttpd.main.key || echo /etc/uhttpd.key').trim();
			if (sh(`[ -e ${certPath} ] && echo yes || echo no`).trim() === 'no') {
				const noCert = sd('terminal_start', { id: 'sight-web', host: LAN, tls: true });
				check(noCert.error === 'no_certificate', '没有证书时 HTTPS 终端如实拒绝', noCert);
				const dir = mkdtempSync(join(tmpdir(), 'sight-flow-cert-'));
				execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=sight-flow', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { stdio: 'ignore' });
				shIn(`cat > ${certPath}`, readFileSync(join(dir, 'c')));
				shIn(`cat > ${keyPath}`, readFileSync(join(dir, 'k')));
				rmSync(dir, { recursive: true });
				certAdded = true;
			}
			const tls = sd('terminal_start', { id: 'sight-web', host: LAN, tls: true }).session;
			check(tls?.tls === true, 'HTTPS 访问时以 TLS 启动终端', tls);
			if (tls && probeImage) {
				await waitListen(tls.port);
				const run = probe(`wss://${LAN}:${tls.port}${tls.path}ws`, 'echo tls-ok');
				check(run.ok && /tls-ok/.test(run.out), '经 wss 执行命令', run.out.slice(-200));
				await sleep(1500);
			}
			/* 无人连接超时：60 秒后自动结束，流程末尾检查 */
			idle = sd('terminal_start', { id: 'sight-web', host: LAN, tls: false }).session;
			idleStarted = Date.now();
		}
		await closeDrawer();

		section('新建与删除容器');
		await page.evaluate(`document.querySelector('[data-action=create]').click()`);
		await waitFor(`!!document.querySelector('[data-create-form]')`, '新建容器表单');
		await fill({ 'create-name': 'x' });
		await page.evaluate(`document.querySelector('[data-create-form]').requestSubmit()`);
		await waitFor(`!!document.querySelector('[data-create-form] .error-summary')`, '表单校验');
		check(await page.evaluate(`/at least 2 characters/.test(document.querySelector('[data-create-form] .error-summary').textContent)`), '名称不合格时表单摘要说明原因，不提交');
		await fill({ 'create-image': 'busybox:stable', 'create-name': NEW, 'create-command': 'sh -c "echo flow ready; sleep 3600"' });
		await clickText('[data-create-form] button', 'Add port');
		await clickText('[data-create-form] button', 'Add folder');
		await sleep(200);
		await setAll('[data-port-row] input', ['8089', '80']);
		await setAll('[data-mount-row] input:not([type=checkbox])', ['/tmp/sight-flow', '/data']);
		await page.evaluate(`document.querySelector('[data-mount-row] input[type=checkbox]').click()`);
		await fill({ 'create-env': 'FOO=bar' });
		await screenshot('docker-create');
		await page.evaluate(`document.querySelector('[data-create-form]').requestSubmit()`);
		await waitFor(`/Created and started ${NEW}/.test(${main}) && !!document.querySelector('tr[data-container="${NEW}"]')`, '新建容器', 40000);
		const created = JSON.parse(DIND(`docker inspect ${NEW}`))[0];
		check(created.State.Running && created.HostConfig.PortBindings?.['80/tcp']?.[0]?.HostPort === '8089' && created.HostConfig.Binds?.[0] === '/tmp/sight-flow:/data:ro'
			&& created.Config.Env.includes('FOO=bar') && created.HostConfig.RestartPolicy.Name === 'unless-stopped' && created.Config.Cmd.join('|') === 'sh|-c|echo flow ready; sleep 3600',
		'新建的容器已运行，端口、只读目录、环境变量、命令与重启策略与表单一致', { binds: created.HostConfig.Binds, ports: created.HostConfig.PortBindings, cmd: created.Config.Cmd, env: created.Config.Env });
		const expectLink = `${new URL(BASE).protocol}//${new URL(BASE).hostname}:8089/`;
		const link = await page.evaluate(`(() => { const a = document.querySelector('tr[data-container="${NEW}"] a[data-open-link]'); return a && { href: a.getAttribute('href'), target: a.target, rel: a.rel }; })()`);
		check(link?.href === expectLink && link.target === '_blank' && /noopener/.test(link.rel), '发布了 TCP 端口的容器在列表给「打开」链接（浏览器访问的主机名 + 设备端口，新标签页）', link);
		check(await page.evaluate(`!document.querySelector('tr[data-container="sight-web"] a[data-open-link]')`), '没有发布端口的容器不给链接');
		await openContainer(NEW);
		await waitFor(`/flow ready/.test(${drawer}.textContent)`, '新容器日志');
		check(await page.evaluate(`[...${drawer}.querySelectorAll('[data-links] a')].map(a => a.getAttribute('href')).join() === ${JSON.stringify(expectLink)}`), '详情同样给出打开链接');
		await clickText('dialog.drawer[open] [data-container-detail] button', 'Delete');
		await waitFor(`!!document.querySelector('dialog[role=alertdialog][open] [data-remove-dialog]')`, '删除确认');
		check(await page.evaluate(`/It is stopped first/.test(document.querySelector('dialog[role=alertdialog][open]').textContent)`), '删除运行中的容器时说明会先停止');
		await page.evaluate(`document.querySelector('[data-remove-dialog] input[type=checkbox]').click()`);
		await confirmDialog('Delete');
		await waitFor(`/Deleted ${NEW}/.test(${main}) && !document.querySelector('tr[data-container="${NEW}"]') && !document.querySelector('dialog.drawer[open]')`, '删除容器', 40000);
		check(!exists(NEW), '设备上的容器已删除');

		section('下载与清理镜像');
		await tab('Images');
		check(await page.evaluate(`location.hash`) === '#/docker?tab=images', '分区写进地址（?tab=）', await page.evaluate(`location.hash`));
		await go('#/docker?tab=storage', `!!document.querySelector('[data-storage]')`);
		await go('#/docker?tab=images', `!!document.querySelector('tr[data-image="busybox:stable"]')`);
		check(true, '按地址打开对应分区（刷新、后退时停在原分区）');
		await page.evaluate(`document.querySelector('tr[data-image="busybox:stable"] [data-action=create-from]').click()`);
		await waitFor(`!!document.querySelector('[data-create-form]')`, '从镜像新建');
		check(await page.evaluate(`document.getElementById('create-image').value`) === 'busybox:stable', '镜像列表可直接用该镜像新建容器');
		await closeDrawer();
		check(await page.evaluate(`[...document.querySelectorAll('tr[data-image="busybox:stable"] .actions button')].find(b => b.textContent.trim() === 'Remove')?.disabled === true`), '使用中的镜像不可删除');
		await page.evaluate(`document.querySelector('[data-action=pull]').click()`);
		await waitFor(`!!document.querySelector('[data-pull-form]')`, '下载表单');
		await fill({ 'pull-image': 'Bad Image' });
		await page.evaluate(`document.querySelector('[data-pull-form]').requestSubmit()`);
		await waitFor(`!!document.querySelector('[data-pull-form] .error-summary')`, '引用校验');
		check(true, '不合格的镜像引用在表单内说明，不发起下载');
		let since = now();
		await fill({ 'pull-image': 'hello-world' });
		await page.evaluate(`document.querySelector('[data-pull-form]').requestSubmit()`);
		await waitFor(`!document.querySelector('[data-pull-form]')`, '开始下载');
		await screenshot('docker-pull');
		const pulled = await taskDone('下载结束', since, '[data-docker-task]');
		if (pulled.state === 'done') {
			check(pulled.task.kind === 'pull' && /Downloaded hello-world:latest/.test(pulled.text) && await page.evaluate(`!!document.querySelector('tr[data-image="${PULL}"]')`), '后台下载完成，镜像出现在列表中', pulled.task);
			await dismissTask();
			await page.evaluate(`document.querySelector('[data-action=prune]').click()`);
			await confirmDialog('Remove');
			await waitFor(`/Removed \\d+ unused images/.test(${main})`, '清理未使用的镜像', 60000);
			check(DIND(`docker image inspect ${PULL} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'no' && DIND('docker image inspect busybox:stable >/dev/null 2>&1 && echo yes || echo no').trim() === 'yes',
				'清理删除未使用的镜像，保留容器在用的', await page.evaluate(`document.querySelector('main .feedback')?.textContent`));
			await screenshot('docker-images');
		} else {
			/* 容器不能上外网：界面如实报告 Docker 给出的原因 */
			check(!!pulled.task.error && pulled.text.includes(pulled.task.error), '无法下载时界面如实说明原因（外网不可用）', pulled.task);
			await dismissTask();
		}

		if (LOCAL) {
			section('更新容器');
			/* 本机的 busybox:latest 换成另一个镜像（busybox:musl）冒充旧版，更新时从 Docker Hub 拉到真正的最新版 */
			DIND('docker pull -q busybox:musl >/dev/null && docker tag busybox:musl busybox:latest');
			DIND(`docker run -d --name ${UPD} -p 8091:80 -e KEEP=1 -l sight.flow=keep --restart unless-stopped --cap-add NET_ADMIN -v /cache busybox:latest sh -c "sleep 3600" >/dev/null && docker exec ${UPD} sh -c "echo kept > /cache/f"`);
			const before = JSON.parse(DIND(`docker inspect ${UPD}`))[0];
			const anon = before.Mounts.find(x => x.Destination === '/cache')?.Name;
			flowVolumes.push(anon);
			await tab('Containers');
			await refresh();
			await waitFor(`!!document.querySelector('tr[data-container="${UPD}"]')`, '更新用容器出现');
			await openContainer(UPD);
			await waitFor(`${drawer}.querySelector('[data-action=update]') && !${drawer}.querySelector('[data-action=update]').disabled`, '更新按钮可用');
			since = now();
			await page.evaluate(`${drawer}.querySelector('[data-action=update]').click()`);
			await waitFor(`!!document.querySelector('dialog[role=alertdialog][open] [data-update-dialog]')`, '更新确认');
			await confirmDialog('Update');
			await waitFor(`!document.querySelector('dialog.drawer[open]') && !!document.querySelector('[data-docker-task] [data-task]')`, '更新开始后关闭抽屉、显示进度');
			const upd = await taskDone('更新容器', since, '[data-docker-task]', 300000);
			if (upd.state === 'done') {
				const after = JSON.parse(DIND(`docker inspect ${UPD}`))[0];
				const latest = DIND(`docker image inspect -f '{{.Id}}' busybox:latest`).trim();
				check(/Updated sight-flow-upd to the latest version of busybox:latest/.test(upd.text) && upd.task.result === 'recreated' && after.Id !== before.Id && after.Image === latest && after.Image !== before.Image,
					'有新版时拉取并重建，容器换成新镜像', { text: upd.text, task: upd.task });
				check(after.State.Running && after.Config.Env.includes('KEEP=1') && after.Config.Labels['sight.flow'] === 'keep' && after.HostConfig.PortBindings['80/tcp'][0].HostPort === '8091'
					&& after.HostConfig.RestartPolicy.Name === 'unless-stopped' && after.HostConfig.CapAdd?.some(c => /NET_ADMIN/.test(c)) && after.Config.Cmd.join('|') === 'sh|-c|sleep 3600',
				'重建后环境变量、标签、端口、重启策略、能力与命令都保留', { env: after.Config.Env, labels: after.Config.Labels, cap: after.HostConfig.CapAdd });
				check(after.Mounts.find(x => x.Destination === '/cache')?.Name === anon && DIND(`docker exec ${UPD} cat /cache/f`).trim() === 'kept' && !exists(`${UPD}-sight-old`),
					'匿名卷接到新容器上，数据保留；旧容器已删除', after.Mounts);
				check(await page.evaluate(`[...document.querySelectorAll('[data-docker-task] [data-step]')].map(e => e.dataset.stepState).join() === 'done,done,done,done,done'`), '进度列出各步骤并全部完成');
				await screenshot('docker-update');
				await dismissTask();
				await openContainer(UPD);
				await waitFor(`${drawer}.querySelector('[data-action=update]') && !${drawer}.querySelector('[data-action=update]').disabled`, '更新按钮可用');
				since = now();
				await page.evaluate(`${drawer}.querySelector('[data-action=update]').click()`);
				await confirmDialog('Update');
				const again = await taskDone('再次更新', since, '[data-docker-task]', 300000);
				check(again.state === 'done' && /already using the latest version/.test(again.text) && again.task.result === 'latest' && JSON.parse(DIND(`docker inspect ${UPD}`))[0].Id === after.Id, '已是最新时说明且不重建', again.text);
				await dismissTask();
			} else check(false, '更新容器（需要外网拉取 busybox:latest）', { text: upd.text, task: upd.task });

			section('编辑容器');
			const editBefore = JSON.parse(DIND(`docker inspect ${UPD}`))[0];
			await openContainer(UPD);
			await page.evaluate(`${drawer}.querySelector('[data-action=edit]').click()`);
			await waitFor(`!!document.querySelector('[data-create-form="edit"]')`, '编辑表单');
			const prefill = await page.evaluate(`({ name: document.getElementById('create-name').value, image: document.getElementById('create-image').value, ports: [...document.querySelectorAll('[data-port-row] input')].map(i => i.value), env: document.querySelector('[data-create-form]').textContent.includes('KEEP=1'), path: document.querySelector('[data-create-form]').textContent.includes('PATH='), cmd: document.getElementById('create-command').value })`);
			check(prefill.name === UPD && prefill.image === 'busybox:latest' && prefill.ports.join() === '8091,80' && prefill.env && !prefill.path && prefill.cmd === 'sh -c "sleep 3600"', '编辑表单按现有配置预填（不含镜像自带的环境变量）', prefill);
			await screenshot('docker-edit');
			await setAll('[data-port-row] input', ['8092', '80']);
			await fill({ 'create-env': 'EDITED=1' });
			since = now();
			await page.evaluate(`document.querySelector('[data-create-form]').requestSubmit()`);
			const ed = await taskDone('编辑重建', since, '[data-docker-task]', 120000);
			const edited = JSON.parse(DIND(`docker inspect ${UPD}`))[0];
			check(ed.state === 'done' && /Applied the changes to sight-flow-upd/.test(ed.text) && edited.Id !== editBefore.Id && edited.HostConfig.PortBindings['80/tcp'][0].HostPort === '8092'
				&& edited.Config.Env.includes('EDITED=1') && edited.Config.Env.includes('KEEP=1') && edited.Config.Labels['sight.flow'] === 'keep' && edited.HostConfig.CapAdd?.some(c => /NET_ADMIN/.test(c))
				&& DIND(`docker exec ${UPD} cat /cache/f`).trim() === 'kept', '编辑后重建：改动生效，表单不管理的配置与卷数据保留', { text: ed.text, env: edited.Config.Env });
			await dismissTask();

			section('重建失败回滚');
			/* 设备端口 80 已被 uhttpd 占用：新容器启动失败，恢复原容器 */
			await openContainer(UPD);
			await page.evaluate(`${drawer}.querySelector('[data-action=edit]').click()`);
			await waitFor(`!!document.querySelector('[data-create-form="edit"]')`, '编辑表单');
			await setAll('[data-port-row] input', ['80', '80']);
			since = now();
			await page.evaluate(`document.querySelector('[data-create-form]').requestSubmit()`);
			const rb = await taskDone('回滚', since, '[data-docker-task]', 120000);
			const restored = JSON.parse(DIND(`docker inspect ${UPD}`))[0];
			check(rb.state === 'failed' && rb.task.rollback === 'done' && /The previous container was restored/.test(rb.text) && restored.Id === edited.Id && restored.State.Running
				&& restored.HostConfig.PortBindings['80/tcp'][0].HostPort === '8092' && !exists(`${UPD}-sight-old`) && DIND(`docker ps -a --format '{{.Names}}' | grep -c '^${UPD}' || true`).trim() === '1',
			'端口冲突时重建失败：删掉新容器、恢复原容器的名字与运行状态', { text: rb.text, task: rb.task });
			await screenshot('docker-rollback');
			await dismissTask();

			section('批量更新与检查更新');
			const real = DIND(`docker image inspect -f '{{.Id}}' busybox:latest`).trim();
			if (real && real !== DIND(`docker image inspect -f '{{.Id}}' busybox:musl`).trim()) {
				/* 只让流程自建的容器出现在「全部更新」里：清掉检查结果，有新版只靠本机标签判断。
				   UPD2 跑在旧镜像上、标签已指向新版；BAD 的标签指向新版，但仓库里没有这个镜像，更新时拉取失败 */
				sh(`rm -f ${UPDATES}`);
				DIND(`docker tag busybox:musl busybox:latest && docker run -d --name ${UPD2} busybox:latest sleep 3600 >/dev/null && docker tag ${real} busybox:latest`);
				DIND(`docker tag busybox:musl ${BAD_REF} && docker run -d --name ${BAD} ${BAD_REF} sleep 3600 >/dev/null && docker tag ${real} ${BAD_REF}`);
				const badBefore = JSON.parse(DIND(`docker inspect ${BAD}`))[0];
				await refresh();
				const badge = name => `!!document.querySelector('tr[data-container="${name}"] [data-update-available]')`;
				await waitFor(`${badge(UPD2)} && ${badge(BAD)}`, '本机标签已指向新镜像的容器标为可更新');
				check(await page.evaluate(`!${badge(UPD)} && !${badge('sight-web')}`), '本机标签已指向新镜像的容器标为可更新，其余不标');
				await page.evaluate(`document.querySelector('[data-action=update-all]').click()`);
				await waitFor(`!!document.querySelector('dialog[role=alertdialog][open] [data-update-all-dialog]')`, '全部更新确认');
				const listed = await page.evaluate(`[...document.querySelectorAll('[data-update-all-dialog] li .mono')].map(e => e.textContent.trim())`);
				check(listed.join() === [BAD, UPD2].join(), '全部更新的确认框列出要更新的容器', listed);
				since = now();
				await confirmDialog('Update');
				const all = await taskDone('批量更新', since, '[data-docker-task]', 300000);
				const upd2 = JSON.parse(DIND(`docker inspect ${UPD2}`))[0];
				const bad = JSON.parse(DIND(`docker inspect ${BAD}`))[0];
				const steps = await page.evaluate(`[...document.querySelectorAll('[data-docker-task] [data-step]')].map(e => e.dataset.step + ':' + e.dataset.stepState).join()`);
				check(all.task.kind === 'update' && steps === `${BAD}:failed,${UPD2}:done` && upd2.Image === real && upd2.State.Running
					&& bad.Id === badBefore.Id && bad.State.Running && !exists(`${BAD}-sight-old`) && !exists(`${UPD2}-sight-old`),
				'批量更新逐个进行：拉取失败的保持原样，其余照常重建到新版', { steps, task: all.task });
				check(all.state === 'failed' && /Updated 1 containers\./.test(all.text) && all.text.includes(`Could not update ${BAD}`), '结果说明更新了几个、哪个失败及原因', all.text);
				await screenshot('docker-update-all');
				await dismissTask();

				const imagesBefore = DIND(`docker images -q --no-trunc | sort`).trim();
				since = now();
				await page.evaluate(`document.querySelector('[data-action=check-updates]').click()`);
				const chk = await taskDone('检查更新', since, '[data-docker-task]', 180000);
				const results = sd('check_list').images || {};
				check(chk.task.kind === 'check' && ['busybox:stable', 'busybox:latest', BAD_REF].every(r => chk.task.images.includes(r)) && results[BAD_REF]?.error
					&& DIND(`docker images -q --no-trunc | sort`).trim() === imagesBefore, '检查更新逐个查询仓库（不下载镜像），查不到的如实记下', { task: chk.task, results });
				if (results['busybox:latest']?.digest) {
					check(chk.state === 'done' && /could not be checked/.test(chk.text) && await page.evaluate(`/Checked for updates/.test(document.querySelector('[data-docker] ~ * [role=group], main').textContent)`),
						'结果说明有几个未能检查，列表显示最近一次检查时间', chk.text);
					check(await page.evaluate(`!${badge(UPD2)} && ${badge(BAD)}`), '仓库摘要与本机一致的不标可更新', results['busybox:latest']);
				} else check(false, '检查更新（需要外网访问 Docker Hub 或镜像加速）', results);
				await screenshot('docker-check');
				await dismissTask();
				DIND(`docker rm -f ${UPD2} ${BAD} >/dev/null; docker rmi ${BAD_REF} >/dev/null 2>&1; true`);
			} else check(false, '批量更新（需要前面的更新流程拉到新版 busybox:latest）');
		}

		section('网络与卷');
		await tab('Networks and volumes');
		await waitFor(`!!document.querySelector('tr[data-network="bridge"]')`, '网络列表');
		check(await page.evaluate(`!document.querySelector('tr[data-network="bridge"] .actions button') && /sight-web/.test(document.querySelector('tr[data-network="bridge"]').textContent)`), '内置网络不可删除，列出连接的容器');
		await page.evaluate(`document.querySelector('[data-action=network-new]').click()`);
		await waitFor(`!!document.querySelector('[data-network-form]')`, '新建网络表单');
		await page.evaluate(`document.querySelector('[data-network-form] details summary')?.click()`);
		await fill({ 'network-name': NET, 'network-subnet': '172.31.250.0', 'network-gateway': '' });
		await page.evaluate(`document.querySelector('[data-network-form]').requestSubmit()`);
		await waitFor(`!!document.querySelector('[data-network-form] .error-summary')`, '子网校验');
		await fill({ 'network-subnet': '172.31.250.0/24', 'network-gateway': '172.31.250.1' });
		await page.evaluate(`document.querySelector('[data-network-form]').requestSubmit()`);
		await waitFor(`!!document.querySelector('tr[data-network="${NET}"]')`, '新建网络', 30000);
		const net = JSON.parse(DIND(`docker network inspect ${NET}`))[0];
		check(net.IPAM.Config[0].Subnet === '172.31.250.0/24' && net.IPAM.Config[0].Gateway === '172.31.250.1' && net.Driver === 'bridge', '新建网络：子网与网关写入 Docker', net.IPAM);

		section('新建容器：固定地址、主机名、资源限制、设备与时区');
		const zone = sh('uci -q get system.@system[0].zonename || true').trim();
		/* 嵌套容器可能没有下放 memory/cpu 控制器，带限制的容器起不来：此时只新建不启动，按写入的配置核对 */
		const limitsWork = DIND('docker run --rm --memory 64m --cpus 0.5 busybox:stable true >/dev/null 2>&1 && echo yes || echo no').trim() === 'yes';
		if (!limitsWork) check(true, '本环境不支持内存/CPU 限制（cgroup 控制器未下放），带限制的容器只新建不启动');
		await tab('Containers');
		await page.evaluate(`document.querySelector('[data-action=create]').click()`);
		await waitFor(`!!document.querySelector('[data-create-form]')`, '新建容器表单');
		await fill({ 'create-image': 'busybox:stable', 'create-name': LIM, 'create-network': NET });
		await waitFor(`!!document.getElementById('create-ip')`, '自定义网络显示固定地址');
		check(await page.evaluate(`document.getElementById('create-ip-help').textContent.includes('172.31.250.0/24')`), '选自定义网络时可填固定地址，并给出网络的子网');
		await fill({ 'create-ip': '10.1.1.1', 'create-memory': '3', 'create-cpus': '999' });
		await page.evaluate(`document.querySelector('[data-create-form]').requestSubmit()`);
		await waitFor(`!!document.querySelector('[data-create-form] .error-summary')`, '新字段校验');
		const errText = await page.evaluate(`document.querySelector('[data-create-form] .error-summary').textContent`);
		check(/subnet 172\.31\.250\.0\/24/.test(errText) && /at least 6/.test(errText) && /CPU cores from 0\.01/.test(errText), '固定地址不在子网内、内存过小、CPU 超过核数时说明原因', errText);
		await fill({ 'create-ip': '172.31.250.10', 'create-hostname': 'flow-host', 'create-memory': '64', 'create-cpus': '0.5', 'create-devices': '/dev/full', 'create-command': 'sleep 3600' });
		if (zone) {
			await page.evaluate(`document.querySelector('[data-action=add-tz]').click()`);
			await waitFor(`document.querySelector('[data-create-form]').textContent.includes('TZ=${zone}') && !document.querySelector('[data-action=add-tz]')`, '一键加入路由器时区');
		}
		await page.evaluate(`document.querySelector('[data-create-form] details').open = true`);
		if (!limitsWork) await page.evaluate(`[...document.querySelectorAll('[data-create-form] label')].find(l => /Start the container after creating it/.test(l.textContent)).querySelector('input').click()`);
		await screenshot('docker-create-limits');
		await page.evaluate(`document.querySelector('[data-create-form]').requestSubmit()`);
		await waitFor(limitsWork ? `/Created and started ${LIM}/.test(${main})` : `/Created ${LIM}/.test(${main}) && !!document.querySelector('tr[data-container="${LIM}"]')`, '新建带限制的容器', 40000);
		const lim = JSON.parse(DIND(`docker inspect ${LIM}`))[0];
		const ipOf = c => limitsWork ? c.NetworkSettings.Networks[NET]?.IPAddress : c.NetworkSettings.Networks[NET]?.IPAMConfig?.IPv4Address;
		check(lim.State.Running === limitsWork && ipOf(lim) === '172.31.250.10' && lim.Config.Hostname === 'flow-host'
			&& lim.HostConfig.Memory === 64 * 1048576 && lim.HostConfig.NanoCpus === 5e8 && lim.HostConfig.Devices?.[0]?.PathOnHost === '/dev/full'
			&& (!zone || lim.Config.Env.includes(`TZ=${zone}`)), '新建的容器使用固定地址、主机名、内存/CPU 上限、设备直通与路由器时区',
		{ ip: ipOf(lim), host: lim.Config.Hostname, mem: lim.HostConfig.Memory, cpu: lim.HostConfig.NanoCpus, dev: lim.HostConfig.Devices, env: lim.Config.Env });
		if (LOCAL) {
			await openContainer(LIM);
			await page.evaluate(`${drawer}.querySelector('[data-action=edit]').click()`);
			await waitFor(`!!document.querySelector('[data-create-form="edit"]')`, '编辑表单');
			const pre = await page.evaluate(`({ ip: document.getElementById('create-ip')?.value, host: document.getElementById('create-hostname').value, mem: document.getElementById('create-memory').value, cpu: document.getElementById('create-cpus').value, dev: document.querySelector('[data-create-form]').textContent.includes('/dev/full') })`);
			check(pre.ip === '172.31.250.10' && pre.host === 'flow-host' && pre.mem === '64' && pre.cpu === '0.5' && pre.dev, '编辑表单预填固定地址、主机名、资源限制与设备', pre);
			await fill({ 'create-memory': '96', 'create-ip': '172.31.250.11' });
			since = now();
			await page.evaluate(`document.querySelector('[data-create-form]').requestSubmit()`);
			const le = await taskDone('编辑资源限制', since, '[data-docker-task]', 120000);
			const limEdited = JSON.parse(DIND(`docker inspect ${LIM}`))[0];
			check(le.state === 'done' && limEdited.HostConfig.Memory === 96 * 1048576 && ipOf(limEdited) === '172.31.250.11'
				&& limEdited.HostConfig.NanoCpus === 5e8 && limEdited.HostConfig.Devices?.[0]?.PathOnHost === '/dev/full' && limEdited.Config.Hostname === 'flow-host',
			'编辑后重建：改动的内存上限与地址生效，其余限制保留', { text: le.text, mem: limEdited.HostConfig.Memory, ip: ipOf(limEdited) });
			await dismissTask();
		}
		DIND(`docker rm -f ${LIM} >/dev/null`);
		await refresh();
		await tab('Networks and volumes');
		await waitFor(`!!document.querySelector('tr[data-network="${NET}"]')`, '回到网络列表');
		await page.evaluate(`document.querySelector('[data-action=volume-new]').click()`);
		await waitFor(`!!document.querySelector('[data-volume-form]')`, '新建卷表单');
		await fill({ 'volume-name': VOL });
		await page.evaluate(`document.querySelector('[data-volume-form]').requestSubmit()`);
		await waitFor(`!!document.querySelector('tr[data-volume="${VOL}"]')`, '新建卷', 30000);
		check(DIND(`docker volume inspect ${VOL} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'yes', '新建卷');
		if (LOCAL) check(await page.evaluate(`[...document.querySelectorAll('tr[data-volume]')].some(r => r.textContent.includes('${UPD}'))`), '卷列表列出使用它的容器（更新流程的匿名卷）');
		await screenshot('docker-resources');
		await clickText(`tr[data-network="${NET}"] .actions button`, 'Delete');
		await confirmDialog('Delete');
		await waitFor(`!document.querySelector('tr[data-network="${NET}"]')`, '删除网络', 30000);
		check(DIND(`docker network inspect ${NET} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'no', '删除网络');
		await clickText(`tr[data-volume="${VOL}"] .actions button`, 'Delete');
		await confirmDialog('Delete');
		await waitFor(`!document.querySelector('tr[data-volume="${VOL}"]')`, '删除卷', 30000);
		check(DIND(`docker volume inspect ${VOL} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'no', '删除卷');
		/* 清理未使用的卷会删掉设备上所有未使用的卷：只有流程自己的卷未使用时才验收 */
		DIND(`docker volume create ${PRUNE_VOL} >/dev/null`);
		const unusedBefore = DIND(`docker volume ls -q -f dangling=true`).trim().split('\n').filter(Boolean);
		if (unusedBefore.length === 1 && unusedBefore[0] === PRUNE_VOL) {
			await refresh();
			await waitFor(`!!document.querySelector('tr[data-volume="${PRUNE_VOL}"]')`, '未使用的卷');
			await page.evaluate(`document.querySelector('[data-action=prune-volumes]').click()`);
			await waitFor(`!!document.querySelector('dialog[role=alertdialog][open] [data-prune-volumes]')`, '清理确认');
			check(await page.evaluate(`/deleted with its data/.test(document.querySelector('dialog[role=alertdialog][open]').textContent)`), '清理前说明会删除数据');
			await confirmDialog('Delete');
			await waitFor(`/Deleted 1 unused volumes/.test(${main})`, '清理未使用的卷', 30000);
			check(DIND(`docker volume inspect ${PRUNE_VOL} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'no' && (!LOCAL || DIND(`docker exec ${UPD} cat /cache/f`).trim() === 'kept'), '清理删除未使用的卷，保留在用的');
		} else {
			DIND(`docker volume rm ${PRUNE_VOL} >/dev/null`);
			check(true, '设备上还有别的未使用卷，跳过清理验收', unusedBefore);
		}

		if (LOCAL) {
			section('Compose');
			/* 用流程自己拉取的 busybox:musl：「更新镜像」不会改动测试前提 sight-web 所用的 busybox:stable */
			const yaml = n => `services:\n  web:\n    image: busybox:musl\n    command: ["sh", "-c", "echo compose-${n}; sleep 3600"]\n    ports:\n      - "8093:80"\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n`;
			const ps = () => DIND(`docker ps -a --filter label=com.docker.compose.project=${PROJECT} --format '{{.Names}} {{.State}}'`).trim();
			const projectDrawer = `[data-project-detail="${PROJECT}"]`;
			await tab('Compose');
			await waitFor(`!!document.querySelector('[data-action=compose-new]')`, 'Compose 分页');
			await page.evaluate(`document.querySelector('[data-action=compose-new]').click()`);
			await waitFor(`!!document.querySelector('[data-compose-new]')`, '新建项目表单');
			await fill({ 'compose-new-name': 'Bad Name', 'compose-new-content': 'version: "3"' });
			await page.evaluate(`document.querySelector('[data-compose-new]').requestSubmit()`);
			await waitFor(`!!document.querySelector('[data-compose-new] .error-summary')`, '项目校验');
			check(await page.evaluate(`/lowercase letters/.test(document.querySelector('[data-compose-new] .error-summary').textContent) && /services:/.test(document.querySelector('[data-compose-new] .error-summary').textContent)`), '项目名与文件不合格时说明原因');
			await fill({ 'compose-new-name': PROJECT, 'compose-new-content': 'services:\n  web:\n    image: busybox:stable\n    ports: "x"\n' });
			await page.evaluate(`document.querySelector('[data-compose-new]').requestSubmit()`);
			await waitFor(`/Compose could not read this file/.test(document.querySelector('[data-compose-new] .error-summary')?.textContent || '')`, '设备端校验', 30000);
			check(sh(`[ -e /etc/sight-docker/compose/${PROJECT} ] && echo yes || echo no`).trim() === 'no', 'Compose 校验不通过时不保存');
			await fill({ 'compose-new-content': yaml(1) });
			await screenshot('docker-compose-new');
			since = now();
			await page.evaluate(`document.querySelector('[data-compose-new]').requestSubmit()`);
			await waitFor(`!!document.querySelector('${projectDrawer}')`, '新项目详情', 30000);
			const up = await taskDone('启动项目', since, projectDrawer, 120000);
			check(up.state === 'done' && sh(`cat /etc/sight-docker/compose/${PROJECT}/compose.yaml`) === yaml(1) && /sightflow-web-1 running/.test(ps()) && /compose-1/.test(DIND(`docker logs ${PROJECT}-web-1`)),
				'项目文件保存到 /etc/sight-docker/compose，up -d 启动容器', { ps: ps(), task: up.task });
			await page.evaluate(`document.querySelector('${projectDrawer} details summary')?.click()`);
			await sleep(300);
			check(await page.evaluate(`/Container sightflow-web-1\\s+Started/.test(document.querySelector('${projectDrawer}').textContent)`), '抽屉内显示 docker-compose 的输出');
			await screenshot('docker-compose');
			await fill({ 'compose-content': yaml(2) });
			since = now();
			await page.evaluate(`document.querySelector('[data-compose-form]').requestSubmit()`);
			const re = await taskDone('编辑后重建', since, projectDrawer, 120000);
			check(re.state === 'done' && /compose-2/.test(DIND(`docker logs ${PROJECT}-web-1`)), '编辑项目文件后按新文件重建容器', re.task);
			since = now();
			await page.evaluate(`document.querySelector('[data-action=compose-pull]').click()`);
			const pl = await taskDone('拉取更新', since, projectDrawer, 240000);
			check(pl.state === 'done' && pl.task.action === 'pull' && pl.task.steps.map(x => x.name).join() === 'pull,up', '拉取更新：pull 后 up -d', pl.task);
			since = now();
			await page.evaluate(`document.querySelector('[data-action=compose-down]').click()`);
			await confirmDialog('Stop');
			const dn = await taskDone('停止项目', since, projectDrawer, 120000);
			check(dn.state === 'done' && !ps() && DIND(`docker volume inspect ${PROJECT}_data >/dev/null 2>&1 && echo yes || echo no`).trim() === 'yes', '停止（down）移除容器，保留卷与项目文件');
			await closeDrawer();
			/* 别处创建的项目：只读显示，可以停止 */
			shIn(`mkdir -p /root/${EXT} && cat > /root/${EXT}/compose.yaml`, 'services:\n  app:\n    image: busybox:stable\n    command: ["sleep", "3600"]\n');
			sh(`cd /root/${EXT} && docker-compose -p ${EXT} up -d >/dev/null 2>&1`);
			await tab('Containers');
			await refresh();
			await waitFor(`!!document.querySelector('[data-compose-group="${EXT}"] tr[data-container="${EXT}-app-1"]')`, '容器按项目归组');
			check(await page.evaluate(`!document.querySelector('[data-compose-group] tr[data-container="sight-web"]')`), '不属于项目的容器不进项目分组');
			await page.evaluate(`document.querySelector('tr[data-container="${EXT}-app-1"] td').click()`);
			await waitFor(`!!${drawer}?.querySelector('[data-container-detail]')`, '项目容器详情');
			check(await page.evaluate(`!${drawer}.querySelector('[data-action=edit]') && !${drawer}.querySelector('[data-action=update]') && /Compose project sightext/.test(${drawer}.textContent)`), 'Compose 容器不在详情里编辑或更新，说明属于哪个项目');
			await closeDrawer();
			await screenshot('docker-groups');
			await tab('Compose');
			await page.evaluate(`document.querySelector('tr[data-project="${EXT}"] td').click()`);
			await waitFor(`!!document.querySelector('[data-project-detail="${EXT}"]')`, '外部项目详情');
			check(await page.evaluate(`!document.querySelector('[data-project-detail] [data-compose-form]') && !document.querySelector('[data-action=compose-remove]') && document.querySelector('[data-project-detail]').textContent.includes('/root/${EXT}')`), '别处创建的项目只读显示（含项目目录），不可编辑或删除');
			since = now();
			await page.evaluate(`document.querySelector('[data-action=compose-down]').click()`);
			await confirmDialog('Stop');
			for (let i = 0; i < 60 && !(taskStatus()?.started >= since && taskStatus()?.state !== 'running'); i++) await sleep(1000);
			check(taskStatus()?.state === 'done' && !DIND(`docker ps -a --filter label=com.docker.compose.project=${EXT} -q`).trim(), '别处创建的项目可以停止（按项目名 down）', taskStatus());
			await sleep(1500);
			if (await page.evaluate(`!!document.querySelector('dialog.drawer[open]')`)) await closeDrawer();
			/* 删除项目连同卷 */
			await page.evaluate(`document.querySelector('tr[data-project="${PROJECT}"] td').click()`);
			await waitFor(`!!document.querySelector('[data-action=compose-remove]')`, '项目详情');
			await page.evaluate(`document.querySelector('[data-action=compose-remove]').click()`);
			await waitFor(`!!document.querySelector('dialog[role=alertdialog][open] [data-compose-remove]')`, '删除确认');
			await page.evaluate(`document.querySelector('[data-compose-remove] input[type=checkbox]').click()`);
			since = now();
			await confirmDialog('Delete');
			const rm = await taskDone('删除项目', since, '[data-docker-task]', 120000);
			await waitFor(`!document.querySelector('tr[data-project="${PROJECT}"]')`, '项目从列表消失', 20000);
			check(rm.state === 'done' && /Deleted project sightflow/.test(rm.text) && sh(`[ -e /etc/sight-docker/compose/${PROJECT} ] && echo yes || echo no`).trim() === 'no'
				&& DIND(`docker volume inspect ${PROJECT}_data >/dev/null 2>&1 && echo yes || echo no`).trim() === 'no', '删除项目：down -v 删卷并删除项目文件', rm.text);
			await dismissTask();
		}

		section('存储空间');
		DIND(`docker create --name ${STOPPED} busybox:stable true >/dev/null`);
		await refresh();
		await tab('Storage');
		await waitFor(`!!document.querySelector('[data-storage-row="containers"]')`, '存储空间');
		const rows = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-storage-row]')].map(r => [r.dataset.storageRow, r.textContent]))`);
		check(/\d+(\.\d+)? [KMG]?B/.test(rows.images) && /stopped containers/.test(rows.containers) && 'volumes' in rows, '列出镜像、容器与卷的占用与可清理量', rows);
		await screenshot('docker-storage');
		await page.evaluate(`document.querySelector('[data-clean=containers]').click()`);
		await waitFor(`!!document.querySelector('dialog[role=alertdialog][open] [data-clean-containers]')`, '清理确认');
		const toDelete = await page.evaluate(`[...document.querySelectorAll('[data-clean-containers] li')].map(l => l.textContent.trim())`);
		check(toDelete.includes(STOPPED) && toDelete.includes('sight-job') && !toDelete.includes('sight-web'), '确认框列出要删除的已停止容器，不含运行中的', toDelete);
		const stoppedNow = DIND(`docker ps -a --filter status=exited --filter status=created --format '{{.Names}}'`).trim().split('\n').filter(Boolean);
		if (stoppedNow.every(n => [STOPPED, 'sight-job'].includes(n))) {
			await confirmDialog('Delete');
			await waitFor(`/Deleted 2 stopped containers/.test(${main})`, '删除已停止的容器', 30000);
			check(!exists(STOPPED) && !exists('sight-job') && containerRunning('sight-web') && DIND('docker volume ls -q').includes(flowVolumes[0] || ''), '删除已停止的容器，运行中的与卷保留');
		} else {
			await clickText('dialog[role=alertdialog][open] .actions button', 'Cancel');
			DIND(`docker rm ${STOPPED} >/dev/null`);
			check(true, '设备上还有别的已停止容器，跳过删除验收', stoppedNow);
		}
		restoreJob();

		section('设置');
		await tab('Settings');
		await waitFor(`!!document.querySelector('[data-docker-settings]')`, '设置表单');
		if (diskLoop) {
			const disk = `document.querySelector('[data-docker-disks] [data-disk="${DISK_MNT}"]')`;
			await waitFor(`!!${disk}`, '数据盘建议');
			const onInternal = !original.root || !original.root.startsWith('/mnt/');
			if (onInternal) check(await page.evaluate(`/internal storage/.test(document.querySelector('[data-docker-settings]').textContent)`), '数据目录在内部存储上时提示改用数据盘');
			await page.evaluate(`${disk}.click()`);
			check(await page.evaluate(`document.getElementById('docker-data-root').value`) === `${DISK_MNT}/docker` && await page.evaluate(`${disk}.disabled`), '列出已挂载的 ext4 数据盘，一键填入 <挂载点>/docker');
		}
		await fill({ 'docker-mirrors': MIRROR, 'docker-data-root': FLOW_ROOT });
		await waitFor(`/are no longer shown/.test(document.querySelector('[data-docker-settings]').textContent)`, '数据目录提示');
		check(true, '改数据目录前提示原有镜像与容器不可见');
		await screenshot('docker-settings');
		await page.evaluate(`document.querySelector('[data-docker-settings]').requestSubmit()`);
		await apply('Docker 设置');
		check(sh('uci -q get dockerd.globals.registry_mirrors').trim() === MIRROR && sh('uci -q get dockerd.globals.data_root').trim() === FLOW_ROOT, '设置写入 dockerd 配置');
		let mirrors = [];
		for (let i = 0; i < 20 && !mirrors.includes(MIRROR + '/'); i++) { await sleep(500); mirrors = json('ubus call sight.docker info').body.RegistryConfig?.Mirrors || []; }
		check(mirrors.includes(MIRROR + '/'), '镜像加速经 reload 生效，无需重启 Docker', mirrors);
		await waitFor(`/Docker is still using/.test(document.querySelector('[data-docker-settings]')?.textContent || '')`, '重启提示');
		check(true, '数据目录与运行中的不一致时提示重启 Docker');
		await screenshot('docker-settings-restart');
		await page.evaluate(`document.querySelector('[data-docker-settings] button[aria-label="Remove ${MIRROR}"]').click()`);
		await fill({ 'docker-data-root': original.root });
		await page.evaluate(`document.querySelector('[data-docker-settings]').requestSubmit()`);
		await apply('恢复 Docker 设置');
		check(sh('uci -q get dockerd.globals.registry_mirrors || echo none').trim() === 'none' && sh('uci -q get dockerd.globals.data_root || true').trim() === original.root, '设置经界面恢复');
		/* 加速地址全部删掉后 dockerd 的 reload 不会清掉它，页面应提示重启；经界面重启后运行值与配置一致 */
		await waitFor(`/previous registry mirrors/.test(document.querySelector('[data-docker-settings]')?.textContent || '')`, '删除加速地址后提示重启');
		check(true, '加速地址全部删除后提示需重启 Docker');
		await clickText('[data-restart-needed] button', 'Restart Docker');
		await confirmDialog('Restart');
		await waitFor(`!!document.querySelector('[data-docker="up"]') && !!document.querySelector('[data-docker-settings]') && !document.querySelector('[data-restart-needed]')`, '重启 Docker', 90000);
		const after = json('ubus call sight.docker info').body.RegistryConfig?.Mirrors || [];
		check(!after.includes(MIRROR + '/'), '经界面重启 Docker 后加速地址清除、不再提示重启', after);
		/* 没有加速地址：显著提示，一键使用国内镜像（暂存 + 保存即生效） */
		await waitFor(`!!document.querySelector('[data-mirror-suggest]')`, '国内镜像提示');
		check(await page.evaluate(`document.querySelectorAll('[data-mirror-presets] button').length === ${PRESETS.length} && /may stop working/.test(document.querySelector('[data-docker-settings]').textContent)`), '列出国内预设并说明公共镜像可能失效');
		await screenshot('docker-settings-mirrors');
		await page.evaluate(`document.querySelector('[data-action=use-mirrors]').click()`);
		await apply('使用国内镜像');
		check(sh('uci -q get dockerd.globals.registry_mirrors || true').trim() === PRESETS.join(' '), '一键写入国内镜像加速', sh('uci -q get dockerd.globals.registry_mirrors || true'));
		let presetMirrors = [];
		for (let i = 0; i < 20 && presetMirrors.length < PRESETS.length; i++) { await sleep(500); presetMirrors = json('ubus call sight.docker info').body.RegistryConfig?.Mirrors || []; }
		check(PRESETS.every(p => presetMirrors.includes(p + '/')), '国内镜像加速经 reload 生效', presetMirrors);
		await waitFor(`!document.querySelector('[data-mirror-suggest]')`, '提示消失', 10000);
		check(true, '已配置加速后不再提示');
		/* 经加速地址真实下载一个小镜像 */
		since = now();
		const viaMirror = sd('pull_start', { image: PULL });
		if (viaMirror.task) {
			for (let i = 0; i < 180 && !(taskStatus()?.started >= since && taskStatus()?.state !== 'running'); i++) await sleep(1000);
			check(taskStatus()?.state === 'done', '配置国内加速后下载镜像成功', taskStatus());
			try { DIND(`docker rmi ${PULL} >/dev/null 2>&1`); } catch { /* 忽略 */ }
		}

		section('窄屏');
		await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, page.sessionId);
		await sleep(800);
		const fits = () => page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
		let narrow = await fits();
		await screenshot('docker-settings-narrow');
		await tab('Containers');
		narrow &&= await fits();
		await screenshot('docker-narrow');
		if (LOCAL) { await openContainer(UPD); await sleep(600); await screenshot('docker-detail-narrow'); await closeDrawer(); }
		await tab('Networks and volumes');
		narrow &&= await fits();
		await screenshot('docker-resources-narrow');
		await tab('Compose');
		narrow &&= await fits();
		await screenshot('docker-compose-narrow');
		await tab('Storage');
		narrow &&= await fits();
		await screenshot('docker-storage-narrow');
		check(narrow, '窄屏无横向滚动');
		await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);

		/* 前面启动的无人连接会话：60 秒后自动结束 */
		if (idle?.port) {
			const wait = 66000 - (Date.now() - idleStarted);
			if (wait > 0) await sleep(wait);
			const st = sd('terminal_status', { id: 'sight-web' }).session;
			check(st?.state === 'ended' && st.reason === 'timeout' && !listening(idle.port), '无人连接的终端会话 60 秒后自动结束', st);
		}
	});

	if (dockerReady) {
		section('装包预置国内镜像加速');
		const seed = readFileSync(join(PKG, 'root/etc/uci-defaults/90-sight-docker-mirrors'), 'utf8');
		sh('uci -q delete dockerd.globals.registry_mirrors; uci -q delete dockerd.globals.sight_mirrors_seeded; uci commit dockerd');
		shIn('sh -s', seed);
		const first = sh('uci -q get dockerd.globals.registry_mirrors || true').trim(), mark = sh('uci -q get dockerd.globals.sight_mirrors_seeded || true').trim();
		sh('uci -q delete dockerd.globals.registry_mirrors; uci commit dockerd');
		shIn('sh -s', seed);
		const second = sh('uci -q get dockerd.globals.registry_mirrors || true').trim();
		sh('uci -q delete dockerd.globals.sight_mirrors_seeded; uci add_list dockerd.globals.registry_mirrors=https://own.example; uci commit dockerd');
		shIn('sh -s', seed);
		const own = sh('uci -q get dockerd.globals.registry_mirrors || true').trim();
		check(first === PRESETS.join(' ') && mark === '1' && second === '' && own === 'https://own.example', '未设置过时预置国内加速并打标记；删光后不再加回；已有地址不覆盖', { first, mark, second, own });
	}
} finally {
	if (diskLoop) sh(`umount ${DISK_MNT}; losetup -d ${diskLoop}; rm -f ${DISK_IMG}; rmdir ${DISK_MNT}; true`);
	if (dockerReady) {
		/* 无论成败都恢复：删除流程容器、项目、网络、卷与下载的镜像，恢复重启策略、证书与 dockerd 设置 */
		const cleanup = [`docker rm -f ${NEW} ${UPD} ${UPD}-sight-old ${LIM} ${UPD2} ${UPD2}-sight-old ${BAD} ${BAD}-sight-old ${STOPPED} >/dev/null 2>&1; true`, `docker rmi ${BAD_REF} >/dev/null 2>&1; true`,
			`docker update --restart=${original.policy} sight-web >/dev/null`,
			original.hadPull ? 'true' : `docker rmi ${PULL} >/dev/null 2>&1; true`, `docker network rm ${NET} >/dev/null 2>&1; true`,
			`docker volume rm ${[VOL, PRUNE_VOL, `${PROJECT}_data`, ...flowVolumes].filter(Boolean).join(' ')} >/dev/null 2>&1; true`];
		if (LOCAL) cleanup.push(original.hadLatest ? 'true' : 'docker rmi busybox:latest >/dev/null 2>&1; true', original.hadMusl ? 'true' : 'docker rmi busybox:musl >/dev/null 2>&1; true');
		for (const cmd of cleanup) try { DIND(cmd); } catch { /* 忽略 */ }
		try { restoreJob(); } catch { /* 忽略 */ }
		try { if (original.updates) shIn(`cat > ${UPDATES}`, original.updates); else sh(`rm -f ${UPDATES}`); } catch { /* 忽略 */ }
		try {
			if (LOCAL) sh(`for p in ${PROJECT} ${EXT}; do docker-compose -p $p down -v >/dev/null 2>&1; done; rm -rf /etc/sight-docker/compose/${PROJECT} /root/${EXT}; for p in $(pidof ttyd); do grep -q /usr/bin/docker /proc/$p/cmdline && kill $p; done; true`);
			if (certAdded) sh('rm -f "$(uci -q get uhttpd.main.cert || echo /etc/uhttpd.crt)" "$(uci -q get uhttpd.main.key || echo /etc/uhttpd.key)"');
			const mirrors = original.mirrors ? original.mirrors.split(/\s+/).map(m => `uci add_list dockerd.globals.registry_mirrors='${m}';`).join(' ') : '';
			const root = original.root ? `uci set dockerd.globals.data_root='${original.root}';` : 'uci -q delete dockerd.globals.data_root;';
			const seeded = original.seeded ? `uci set dockerd.globals.sight_mirrors_seeded='${original.seeded}';` : 'uci -q delete dockerd.globals.sight_mirrors_seeded;';
			sh(`uci -q delete dockerd.globals.registry_mirrors; ${mirrors} ${root} ${seeded} uci commit dockerd; rm -rf /tmp/sight-flow`);
			/* 运行中的加速地址与配置不一致时重启 dockerd（reload 清不掉），再拉起 sight-web */
			const running = JSON.stringify((json('ubus call sight.docker info').body.RegistryConfig?.Mirrors || []).map(m => m.replace(/\/$/, '')).sort());
			const wanted = JSON.stringify(original.mirrors ? original.mirrors.split(/\s+/).sort() : []);
			sh(running === wanted ? '/etc/init.d/dockerd reload' : '/etc/init.d/dockerd restart');
			for (let i = 0; i < 30; i++) { try { if (/"code":\s*200/.test(sh('ubus call sight.docker version'))) break; } catch { /* 等待 */ } await sleep(1000); }
			DIND('docker start sight-web >/dev/null');
		} catch { /* 忽略 */ }
	}
}
finish();
