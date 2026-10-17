#!/usr/bin/env node
/*
 * 终端插件真实流程验收，需在装有 sight-ui 与本插件的专用容器运行。
 *   1. sight.ttyd 接口签名、ACL（只有本包权限组可用）、非 LAN 地址与非法 id 被拒
 *   2. 会话启动到就绪：一次性路径可访问、其它路径 404、系统日志不含一次性路径；结束后进程退出且记为手动结束
 *   3. 页面：进入工具分组，开启会话后列出状态，可结束
 * 浏览器所在的宿主连不到容器里的终端端口，终端页面在容器内用 uclient-fetch 验证。
 *   SIGHT_UI=/path/to/sight-ui LUCI_URL=http://127.0.0.1:8152 CONTAINER=<专用容器> node sight/scripts/flow-check.mjs
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIGHT_UI = process.env.SIGHT_UI?.trim();
if (!SIGHT_UI) { console.error('必须设置 SIGHT_UI，指向 sight-ui 工程目录。'); process.exit(2); }
const { createFlow } = await import(pathToFileURL(resolve(SIGHT_UI, 'scripts/lib/plugin-flow.mjs')).href);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { check, section, sleep, sh, ubus, denied, contract, withAclUser, browser, finish } = await createFlow({ id: 'ttyd', outDir: join(ROOT, '.visual-out/flow') });

const fetchCode = url => sh(`uclient-fetch -q -O /dev/null '${url}' >/dev/null 2>&1 && echo 200 || echo fail`).trim();
const state = id => JSON.parse(sh(`ubus call sight.ttyd status '{"id":"${id}"}'`)).session;
async function until(fn, ms = 15000) {
	for (let t = 0; t < ms; t += 500) { if (fn()) return true; await sleep(500); }
	return false;
}

section('接口签名');
contract('sight.ttyd', { start: { host: 'String', tls: 'Boolean' }, status: { id: 'String' }, stop: { id: 'String' } });

section('ACL 与参数');
await withAclUser(['sight-ui'], async sid => check(denied(await ubus(sid, 'sight.ttyd', 'start', { host: '127.0.0.1' })), '只有 sight-ui 组的账号不能开终端'));
await withAclUser(['sight-ui', 'sight-plugin-ttyd'], async sid => {
	check((await ubus(sid, 'sight.ttyd', 'start', { host: '8.8.8.8' }))?.[0] === 6, '非 LAN 地址拒绝开终端');
	check((await ubus(sid, 'sight.ttyd', 'status', { id: 'zzz' }))?.[0] === 2, '非法会话 id 拒绝');
	check((await ubus(sid, 'sight.ttyd', 'status', { id: '0123456789abcdef' }))?.[0] === 4, '不存在的会话返回 NOT_FOUND');
});

section('会话');
const r = JSON.parse(sh(`ubus call sight.ttyd start '{"host":"127.0.0.1"}'`)).session;
check(/^[a-f0-9]{16}$/.test(r.id) && /^\/[a-f0-9]{32}\/$/.test(r.path) && r.port >= 7782 && r.port < 7882, '返回会话 id、端口段与一次性路径', r);
check(await until(() => state(r.id).state === 'ready'), '会话启动到就绪');
check(fetchCode(`http://127.0.0.1:${r.port}${r.path}`) === '200' && fetchCode(`http://127.0.0.1:${r.port}/nope/`) === 'fail', '一次性路径可访问，其它路径不可');
check(!sh('logread').includes(r.path.slice(1, -1)), '系统日志不含一次性路径');
check(!('path' in state(r.id)), '查询状态不再返回一次性路径');
sh(`ubus call sight.ttyd stop '{"id":"${r.id}"}'`);
check(await until(() => state(r.id).state === 'ended') && state(r.id).reason === 'stopped', '结束后状态为手动结束', state(r.id));
check(!sh(`ps w | grep -v grep | grep "ttyd.*-p ${r.port} " || true`).trim(), 'ttyd 进程已退出');

try {
	await browser(async ({ page, waitFor, clickText, go, screenshot }) => {
		section('终端页');
		await go('#/ttyd', `!!document.querySelector('[data-action=terminal]')`);
		check(await page.evaluate(`document.querySelector('#sight-navigation a[href="#/ttyd"]')?.closest('[data-nav-group]')?.dataset.navGroup`) === 'tools', '页面在工具分组');
		/* 新标签页会导航到容器里的端口（宿主连不到），只核对会话与列表 */
		await page.evaluate(`window.open = () => null`);
		await page.evaluate(`document.querySelector('[data-action=terminal]').click()`);
		await waitFor(`!!document.querySelector('[data-session][data-state="ready"], [data-session][data-state="starting"]')`, '会话出现在列表');
		const id = await page.evaluate(`document.querySelector('[data-session]').dataset.session`);
		await screenshot('terminal');
		await clickText(`[data-session="${id}"] button`, 'End session');
		await waitFor(`document.querySelector('[data-session="${id}"]')?.dataset.state === 'ended'`, '结束会话');
		check(state(id).reason === 'stopped', '页面开启与结束会话');
	});
} finally {
	sh(`for f in /tmp/sight-ttyd/*.json; do id=$(basename "$f" .json); ubus call sight.ttyd stop "{\\"id\\":\\"$id\\"}" >/dev/null 2>&1; done; true`);
}
finish();
