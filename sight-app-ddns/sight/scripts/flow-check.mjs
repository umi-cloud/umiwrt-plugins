#!/usr/bin/env node
/*
 * DDNS 的 Sight 页面真实流程验收，需在装有 ddns-scripts、sight-ui 与本插件（含 sight.ddns 后端）的专用容器运行。
 *   1. rpcd 接口签名逐字比对
 *   2. ACL：页面所需权限只来自本包的 sight-plugin-ddns 组，helper 参数被篡改即拒绝
 *   3. 新增条目、整体启停、立即更新、日志、删除
 * 会修改并恢复配置。公共底座取自 sight-ui 工程：
 *   SIGHT_UI=/path/to/sight-ui LUCI_URL=http://127.0.0.1:8143 CONTAINER=<专用容器> node sight/scripts/flow-check.mjs
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIGHT_UI = process.env.SIGHT_UI?.trim();
if (!SIGHT_UI) { console.error('必须设置 SIGHT_UI，指向 sight-ui 工程目录。'); process.exit(2); }
const { createFlow } = await import(pathToFileURL(resolve(SIGHT_UI, 'scripts/lib/plugin-flow.mjs')).href);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { check, section, sleep, sh, ubus, denied, contract, withAclUser, browser, finish } = await createFlow({ id: 'ddns', outDir: join(ROOT, '.visual-out/flow') });

section('接口签名');
contract('sight.ddns', { get_services_log: { service_name: 'String' }, get_services_status: {}, get_ddns_state: {}, get_env: {} });

section('ACL：权限来自本包');
await withAclUser(['sight-ui'], async sid => {
	check(denied(await ubus(sid, 'sight.ddns', 'get_ddns_state')) && denied(await ubus(sid, 'uci', 'get', { config: 'ddns' })), '只有 sight-ui 组的账号不能访问 DDNS');
});
await withAclUser(['sight-ui', 'sight-plugin-ddns'], async sid => {
	for (const [o, m, p] of [['sight.ddns', 'get_ddns_state', {}], ['sight.ddns', 'get_services_status', {}], ['file', 'list', { path: '/usr/share/ddns/default' }], ['uci', 'get', { config: 'ddns' }]])
		check((await ubus(sid, o, m, p))?.[0] === 0, `加上本包权限组后可调用 ${o}.${m}`);
	const helper = params => ubus(sid, 'file', 'exec', { command: '/usr/lib/ddns/dynamic_dns_lucihelper.sh', params });
	check((await helper(['-S', 'no_such_entry', '--', 'stop']))?.[0] === 0, 'helper 声明的参数放行');
	check((await helper(['-S', 'x', '--', 'reload']))?.[0] === 6, 'helper 未声明的动作被拒绝');
});

try {
	await browser(async ({ page, waitFor, fill, clickText, go, apply, confirmDialog, screenshot }) => {
		section('DDNS');
		await go('#/ddns', `!!document.querySelector('.hero')`);
		await clickText('button', 'Add domain');
		await waitFor(`!!document.querySelector('dialog.drawer[open] .options')`, '服务商选择');
		check(await page.evaluate(`document.querySelector('.options .option').textContent.includes('duckdns.org')`), '常用服务商排在前面');
		await page.evaluate(`(() => { const i = document.querySelector('dialog.drawer[open] input[type=search]'); i.value = 'duck'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		await sleep(200);
		check(await page.evaluate(`document.querySelectorAll('.options .option').length`) === 2, '搜索过滤服务商（另保留自定义入口）');
		await page.evaluate(`document.querySelector('.options .option').click()`);
		await waitFor(`!!document.getElementById('ddns-domain')`, '填写域名');
		/* 服务商所需字段异步读取，等其生效再判断 */
		await waitFor(`!document.getElementById('ddns-username') && document.querySelector('label[for=ddns-password]')?.textContent.trim() === 'Token'`, '服务商字段');
		check(true, 'duckdns 只需令牌，不显示账号');
		await fill({ 'ddns-domain': 'sight.duckdns.org', 'ddns-password': 'secret-token' });
		await page.evaluate(`document.querySelector('dialog.drawer[open] form').requestSubmit()`);
		await apply('新增域名');
		const ddnsName = sh(`uci show ddns | grep "domain='sight.duckdns.org'" | cut -d. -f2`).trim();
		check(!!ddnsName && sh(`uci get ddns.${ddnsName}.service_name`).trim() === 'duckdns.org' && sh(`uci get ddns.${ddnsName}.password`).trim() === 'secret-token'
			&& sh(`uci get ddns.${ddnsName}.lookup_host`).trim() === 'sight.duckdns.org' && sh(`uci -q get ddns.${ddnsName}.username || echo none`).trim() === 'none', '设备侧写入条目（服务商、令牌、查询主机默认域名、不写空账号）', ddnsName);
		await waitFor(`!!document.querySelector('[data-ddns="${ddnsName}"]')`, '域名卡片');
		check(await page.evaluate(`document.querySelector('[data-ddns="${ddnsName}"]').dataset.state`) === 'paused', '自动更新关闭时卡片显示已暂停且不能立即更新');
		await page.evaluate(`document.querySelector('[role=switch][aria-label="Automatic updates"]').click()`);
		await waitFor(`/Automatic updates turned on/.test(document.querySelector('main').textContent)`, '开启自动更新');
		check(sh(`ubus call sight.ddns get_ddns_state | grep -c '"_enabled": true' || true`).trim() === '1', '自动更新开启并回读');
		await waitFor(`document.querySelector('[data-ddns="${ddnsName}"]')?.dataset.state !== 'paused'`, '回读后卡片解除暂停');
		await clickText(`[data-ddns="${ddnsName}"] button`, 'Update now');
		await waitFor(`/Update started for sight\.duckdns\.org|exit|failed/i.test(document.querySelector('main').textContent)`, '立即更新');
		check(await page.evaluate(`/Update started for sight\.duckdns\.org/.test(document.querySelector('main').textContent)`), '立即更新调用成功');
		await clickText(`[data-ddns="${ddnsName}"] button`, 'Log');
		await waitFor(`!!document.querySelector('dialog.drawer[open]') && !document.querySelector('dialog.drawer[open] .feedback[data-tone=loading]')`, '日志抽屉');
		check(await page.evaluate(`/Log: /.test(document.querySelector('dialog.drawer[open] h2').textContent)`), '日志在抽屉中显示');
		await page.evaluate(`document.querySelector('dialog.drawer[open] .close').click()`);
		await sleep(300);
		await page.evaluate(`document.querySelector('[role=switch][aria-label="Automatic updates"]').click()`);
		await waitFor(`/Automatic updates turned off/.test(document.querySelector('main').textContent)`, '关闭自动更新');
		await clickText(`[data-ddns="${ddnsName}"] button`, 'Edit');
		await waitFor(`!!document.querySelector('dialog.drawer[open] form')`, '编辑抽屉');
		await clickText('dialog.drawer[open] .form-actions button', 'Delete');
		await confirmDialog('Delete');
		await apply('删除域名');
		check(sh(`uci show ddns | grep -c "sight.duckdns.org" || true`).trim() === '0', '删除后设备侧已清除');

		await screenshot('ddns');
	});
} finally {
	sh(`for s in $(uci show ddns | grep "domain='sight.duckdns.org'" | cut -d. -f2); do uci delete ddns.$s; done; uci commit ddns; /etc/init.d/ddns disable; /etc/init.d/ddns stop; true`);
}
finish();
