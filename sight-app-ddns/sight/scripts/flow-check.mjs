#!/usr/bin/env node
/*
 * DDNS 的 Sight 页面真实流程验收，需在装有 ddns-scripts、sight-ui 与本插件（含 sight.ddns 后端）的专用容器运行。
 *   1. rpcd 接口签名逐字比对
 *   2. ACL：页面所需权限只来自本包的 sight-plugin-ddns 组，helper 参数被篡改即拒绝
 *   3. 新增条目；地址来源 web / network / 其他来源（保持原样）切换后 uci 回读；高级选项写入、校验与清空；
 *      本机地址与解析地址比较；整体启停、立即更新、停止、日志、删除
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
contract('sight.ddns', { get_current_ip: { service_name: 'String' }, get_services_log: { service_name: 'String' }, get_services_status: {}, get_ddns_state: {}, get_env: {} });

section('ACL：权限来自本包');
await withAclUser(['sight-ui'], async sid => {
	check(denied(await ubus(sid, 'sight.ddns', 'get_ddns_state')) && denied(await ubus(sid, 'uci', 'get', { config: 'ddns' })), '只有 sight-ui 组的账号不能访问 DDNS');
});
await withAclUser(['sight-ui', 'sight-plugin-ddns'], async sid => {
	for (const [o, m, p] of [['sight.ddns', 'get_ddns_state', {}], ['sight.ddns', 'get_services_status', {}], ['sight.ddns', 'get_current_ip', { service_name: 'no_such_entry' }], ['file', 'list', { path: '/usr/share/ddns/default' }], ['uci', 'get', { config: 'ddns' }]])
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
		const uget = k => sh(`uci -q get ddns.${ddnsName}.${k} || echo none`).trim();
		const card = `[data-ddns="${ddnsName}"]`;
		check(uget('ip_source') === 'network' && uget('ip_network') === uget('interface'), '新条目写入接口地址来源', [uget('ip_source'), uget('ip_network'), uget('interface')]);
		/* 之前运行残留的状态文件会冒充解析结果 */
		sh(`rm -f /var/run/ddns/${ddnsName}.*`);
		const openEdit = async () => {
			await clickText(`${card} button`, 'Edit');
			await waitFor(`!!document.querySelector('dialog.drawer[open] form')`, '编辑抽屉');
			await page.evaluate(`document.querySelectorAll('dialog.drawer[open] details').forEach(d => d.open = true)`);
			await sleep(300);
		};
		const pickSource = v => page.evaluate(`document.querySelector('dialog.drawer[open] input[name=ddns-source][value=${v}]').click()`);
		const toggle = label => page.evaluate(`document.querySelector('dialog.drawer[open] [role=switch][aria-label="${label}"]').click()`);
		const submit = () => page.evaluate(`document.querySelector('dialog.drawer[open] form').requestSubmit()`);
		const refresh = async () => { await clickText('button', 'Refresh'); await sleep(1500); };
		const network = uget('ip_network');

		section('地址来源');
		await openEdit();
		await pickSource('web');
		await waitFor(`!!document.getElementById('ddns-ip-url')`, '检测地址输入框');
		await fill({ 'ddns-ip-url': 'http://checkip.dyndns.com/' });
		await submit();
		await apply('切换到从互联网检测');
		check(uget('ip_source') === 'web' && uget('ip_url') === 'http://checkip.dyndns.com/' && uget('ip_network') === network && uget('interface') === network,
			'切到 web：写 ip_source/ip_url，不改 ip_network 与触发接口', [uget('ip_source'), uget('ip_url'), uget('ip_network'), uget('interface')]);

		section('高级选项');
		await openEdit();
		check(await page.evaluate(`document.querySelector('dialog.drawer[open] input[name=ddns-source][value=web]').checked && document.getElementById('ddns-ip-url').value === 'http://checkip.dyndns.com/'`), '回读后表单显示 web 来源与检测地址');
		await pickSource('network');
		await waitFor(`!!document.getElementById('ddns-network')`, '接口选择');
		await fill({ 'ddns-network': 'lan', 'ddns-check': '2' });
		await submit();
		await waitFor(`/Check interval must be at least 5 minutes/.test(document.querySelector('dialog.drawer[open] form').textContent)`, '检查间隔校验');
		check(true, '检查间隔低于 5 分钟被拒绝');
		await fill({ 'ddns-check': '30', 'ddns-force': '1', 'ddns-force-unit': 'days', 'ddns-dns': '1.1.1.1' });
		await toggle('Use HTTPS');
		await waitFor(`!!document.querySelector('dialog.drawer[open] [role=switch][aria-label="Skip certificate check"]')`, '证书校验开关');
		await toggle('Skip certificate check');
		await submit();
		await apply('切回接口地址并设置高级选项');
		const advanced = ['ip_source', 'ip_network', 'interface', 'check_interval', 'check_unit', 'force_interval', 'force_unit', 'use_https', 'cacert', 'dns_server'].map(uget);
		check(JSON.stringify(advanced) === JSON.stringify(['network', 'lan', 'lan', '30', 'minutes', '1', 'days', '1', 'IGNORE', '1.1.1.1']), '切回 network 并写入间隔、HTTPS、不校验证书与 DNS 服务器', advanced);

		section('地址比较');
		check(JSON.parse(sh(`ubus call sight.ddns get_current_ip '{"service_name":"${ddnsName}"}'`)).ip === '192.168.1.1', 'get_current_ip 按条目来源取到 LAN 地址');
		sh(`echo 192.168.1.1 > /var/run/ddns/${ddnsName}.ip`);
		await refresh();
		await waitFor(`document.querySelector('${card} [data-current]')?.textContent.trim() === '192.168.1.1' && document.querySelector('${card} [data-match]')?.dataset.match === 'match'`, '地址一致');
		check(true, '卡片显示本机地址且与解析一致');
		sh(`echo 10.9.9.9 > /var/run/ddns/${ddnsName}.ip`);
		await refresh();
		await waitFor(`document.querySelector('${card} [data-match]')?.dataset.match === 'mismatch'`, '地址不一致');
		check(await page.evaluate(`document.querySelector('${card}').textContent.includes('10.9.9.9')`), '解析地址不同时标为不一致');
		await screenshot('ddns-compare');

		section('清空高级选项');
		await openEdit();
		check(await page.evaluate(`document.getElementById('ddns-check').value === '30' && document.getElementById('ddns-force-unit').value === 'days' && document.querySelector('dialog.drawer[open] [role=switch][aria-label="Skip certificate check"]').getAttribute('aria-checked') === 'true'`), '高级选项回读到表单');
		await screenshot('ddns-edit');
		await fill({ 'ddns-check': '', 'ddns-force': '', 'ddns-force-unit': 'hours', 'ddns-dns': '' });
		await toggle('Skip certificate check');
		await submit();
		await apply('清空高级选项');
		const cleared = ['check_interval', 'check_unit', 'force_interval', 'force_unit', 'dns_server', 'cacert', 'use_https'].map(uget);
		check(JSON.stringify(cleared) === JSON.stringify(['none', 'none', 'none', 'none', 'none', 'none', '1']), '清空即删除选项，关闭「不校验证书」删除 cacert', cleared);

		section('其他地址来源保持原样');
		sh(`uci set ddns.${ddnsName}.ip_source=script; uci set ddns.${ddnsName}.ip_script=/bin/true; uci commit ddns`);
		await refresh();
		await openEdit();
		check(await page.evaluate(`document.querySelector('dialog.drawer[open] input[name=ddns-source][value=other]')?.checked && /script/.test(document.querySelector('dialog.drawer[open] form').textContent)`), '界面不管理的来源显示为其他（保持原样）');
		await toggle('Use HTTPS');
		await submit();
		await apply('其他来源下保存');
		const other = ['ip_source', 'ip_script', 'ip_network', 'interface', 'use_https'].map(uget);
		check(JSON.stringify(other) === JSON.stringify(['script', '/bin/true', 'lan', 'lan', 'none']), '保存不改动其他来源的设置', other);
		sh(`uci set ddns.${ddnsName}.ip_source=network; uci delete ddns.${ddnsName}.ip_script; uci commit ddns; rm -f /var/run/ddns/${ddnsName}.*`);
		await refresh();
		await page.evaluate(`document.querySelector('[role=switch][aria-label="Automatic updates"]').click()`);
		await waitFor(`/Automatic updates turned on/.test(document.querySelector('main').textContent)`, '开启自动更新');
		check(sh(`ubus call sight.ddns get_ddns_state | grep -c '"_enabled": true' || true`).trim() === '1', '自动更新开启并回读');
		await waitFor(`document.querySelector('[data-ddns="${ddnsName}"]')?.dataset.state !== 'paused'`, '回读后卡片解除暂停');
		await clickText(`[data-ddns="${ddnsName}"] button`, 'Update now');
		await waitFor(`/Update started for sight\.duckdns\.org|exit|failed/i.test(document.querySelector('main').textContent)`, '立即更新');
		check(await page.evaluate(`/Update started for sight\.duckdns\.org/.test(document.querySelector('main').textContent)`), '立即更新调用成功');
		/* 更新进程起来后才有 pid，刷新几次等「停止」出现 */
		let stoppable = false;
		for (let i = 0; i < 8 && !stoppable; i++) {
			await refresh();
			stoppable = await page.evaluate(`[...document.querySelectorAll('${card} button')].some(b => b.textContent.trim() === 'Stop')`);
		}
		check(stoppable, '运行中的条目显示停止按钮');
		if (stoppable) {
			check(await page.evaluate(`!['', '-'].includes(document.querySelector('${card} [data-next]').textContent.trim())`), '运行中显示下次检查', await page.evaluate(`document.querySelector('${card} [data-next]').textContent`));
			await clickText(`${card} button`, 'Stop');
			await waitFor(`/Stopped updating sight\.duckdns\.org/.test(document.querySelector('main').textContent)`, '停止');
			const pid = sh(`ubus call sight.ddns get_services_status | jsonfilter -e '@.${ddnsName}.pid' || true`).trim();
			check(!pid, '停止后更新进程退出', pid);
			await waitFor(`![...document.querySelectorAll('${card} button')].some(b => b.textContent.trim() === 'Stop')`, '停止按钮消失');
			check(true, '停止后不再显示停止按钮');
		}
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
		sh(`rm -f /var/run/ddns/${ddnsName}.*`);

		await screenshot('ddns');
	});
} finally {
	sh(`for s in $(uci show ddns | grep "domain='sight.duckdns.org'" | cut -d. -f2); do uci delete ddns.$s; rm -f /var/run/ddns/$s.*; done; uci commit ddns; /etc/init.d/ddns disable; /etc/init.d/ddns stop; rm -f /var/run/ddns/sight_ip.*; true`);
}
finish();
