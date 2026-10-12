#!/usr/bin/env node
/*
 * Docker 的 Sight 页面真实流程验收，需在装有 luci-app-dockerman、sight-ui 与本插件页的专用容器运行。
 *   1. rpcd 接口签名逐字比对
 *   2. ACL：页面所需权限只来自本包的 sight-plugin-docker 组，CLI 只放行固定参数的日志读取，删除/新建容器未授权
 *   3. 容器停止/启动/重启回读、详情与日志、使用中的镜像不可删除
 * 会修改并恢复配置。公共底座取自 sight-ui 工程：
 *   SIGHT_UI=/path/to/sight-ui LUCI_URL=http://127.0.0.1:8143 CONTAINER=<专用容器> node sight/scripts/flow-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIGHT_UI = process.env.SIGHT_UI?.trim();
if (!SIGHT_UI) { console.error('必须设置 SIGHT_UI，指向 sight-ui 工程目录。'); process.exit(2); }
const { createFlow } = await import(pathToFileURL(resolve(SIGHT_UI, 'scripts/lib/plugin-flow.mjs')).href);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { check, section, sleep, sh, ubus, denied, contract, withAclUser, browser, finish } = await createFlow({ id: 'docker', outDir: join(ROOT, '.visual-out/flow') });

/* 需可用的守护进程：容器内 dockerd 无法运行时，dockerd.globals.hosts 指向隔离的 DinD
   （docker run -d --privileged --name sight-dind -e DOCKER_TLS_CERTDIR= docker:dind dockerd --host=tcp://0.0.0.0:2375，
   并准备运行中的 sight-web 与已退出的 sight-job 两个容器）；没有时跳过页面流程，并在报告中注明 */
const DIND = cmd => execFileSync('docker', ['exec', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', 'sight-dind', 'sh', '-c', cmd], { encoding: 'utf8' });

section('接口签名');
contract('docker', { version: {}, info: {}, df: {} });
contract('docker.container', { list: { query: 'Table' }, inspect: { id: 'String', query: 'Table' }, start: { id: 'String', query: 'Table' }, stop: { id: 'String', query: 'Table' }, restart: { id: 'String', query: 'Table' } });
contract('docker.image', { list: { query: 'Table' }, remove: { id: 'String', query: 'Table' } });

section('ACL：权限来自本包');
await withAclUser(['sight-ui'], async sid => {
	check(denied(await ubus(sid, 'docker', 'version')) && denied(await ubus(sid, 'uci', 'get', { config: 'dockerd' })), '只有 sight-ui 组的账号不能访问 Docker');
});
await withAclUser(['sight-ui', 'sight-plugin-docker'], async sid => {
	for (const [o, m, p] of [['docker', 'version', {}], ['docker.container', 'list', { query: { all: true } }], ['docker.image', 'list', {}], ['uci', 'get', { config: 'dockerd' }]])
		check((await ubus(sid, o, m, p))?.[0] === 0, `加上本包权限组后可调用 ${o}.${m}`);
	const cli = params => ubus(sid, 'file', 'exec', { command: '/usr/bin/docker', params });
	check((await cli(['logs', '--tail', '200', '--timestamps', 'f'.repeat(64)]))?.[0] === 0 && (await cli(['rm', '-f', 'f'.repeat(64)]))?.[0] === 6, 'docker CLI 只放行固定参数的日志读取');
	const removeResult = await ubus(sid, 'docker.container', 'remove', { id: 'x', query: {} }), createResult = await ubus(sid, 'docker.container', 'create', { query: {}, body: {} });
	check(denied(removeResult) && denied(createResult), '删除/新建容器未授权', { removeResult, createResult });
});

let dockerReady = false;
try { DIND('docker start sight-web >/dev/null; docker inspect sight-job >/dev/null'); dockerReady = /"code":\s*200/.test(sh('ubus call docker version')); } catch { dockerReady = false; }

try {
	await browser(async ({ page, waitFor, clickText, go, confirmDialog, screenshot }) => {
		section('Docker');
		if (!dockerReady) {
			/* 没有可用的守护进程时只验证页面能加载并如实说明状态，其余流程跳过 */
			await go('#/docker', `!!document.querySelector('[data-docker]') || !!document.querySelector('main .feedback:not([data-tone=loading])')`);
			check(await page.evaluate(`document.querySelector('[data-docker]')?.dataset.docker !== 'up'`), 'Docker 后端（sight-dind）不可用：页面加载并显示守护进程未运行，其余流程跳过');
			await screenshot('docker-down');
			return;
		}
		const containerRunning = name => DIND(`docker inspect -f '{{.State.Running}}' ${name}`).trim() === 'true';
		await go('#/docker', `!!document.querySelector('[data-docker="up"]')`);
		check(await page.evaluate(`/1 of 2 containers running/.test(document.querySelector('[data-docker]').textContent)`), '状态卡显示运行数量');
		await clickText('tr[data-container="sight-web"] .actions button', 'Stop');
		await confirmDialog('Stop');
		await waitFor(`/Stopped sight-web/.test(document.querySelector('main').textContent) && /Stopped/.test(document.querySelector('tr[data-container="sight-web"]')?.textContent || '')`, '停止容器', 40000);
		check(!containerRunning('sight-web') && await page.evaluate(`/Stopped/.test(document.querySelector('tr[data-container="sight-web"]').textContent)`), '停止后设备侧与界面一致');
		await clickText('tr[data-container="sight-web"] .actions button', 'Start');
		await waitFor(`/Started sight-web/.test(document.querySelector('main').textContent) && /Running/.test(document.querySelector('tr[data-container="sight-web"]')?.textContent || '')`, '启动容器');
		check(containerRunning('sight-web'), '启动后运行');
		await clickText('tr[data-container="sight-web"] .actions button', 'Restart');
		await confirmDialog('Restart');
		await waitFor(`/Restarted sight-web/.test(document.querySelector('main').textContent)`, '重启容器', 40000);
		check(containerRunning('sight-web'), '重启后运行');
		await page.evaluate(`document.querySelector('tr[data-container="sight-job"] td').click()`);
		await waitFor(`!!document.querySelector('dialog.drawer[open] [data-container-detail="sight-job"]') && !document.querySelector('dialog.drawer[open] .feedback[data-tone=loading]')`, '容器详情');
		const socket = sh('[ -S /var/run/docker.sock ] && echo yes || echo no').trim() === 'yes';
		const logText = await page.evaluate(`document.querySelector('dialog.drawer[open]').textContent`);
		check(socket ? /job done/.test(logText) : /Logs (could not be read|are only available)/.test(logText), socket ? '详情显示容器日志' : '无本机 Docker 套接字时如实说明日志不可读', logText.slice(-200));
		await screenshot('docker');
		await page.evaluate(`document.querySelector('dialog.drawer[open] .close').click()`);
		await sleep(300);
		await page.evaluate(`document.querySelectorAll('.workspace-tabs [role=tab]')[1].click()`);
		check(await page.evaluate(`[...document.querySelectorAll('tr[data-image="busybox:stable"] .actions button')].find(b => b.textContent.trim() === 'Remove')?.disabled === true`), '使用中的镜像不可删除');
	});
} finally {
	if (dockerReady) try { DIND('docker start sight-web >/dev/null'); } catch { /* 忽略 */ }
}
finish();
