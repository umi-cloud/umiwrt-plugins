#!/usr/bin/env node
/*
 * HomeProxy 的 Sight 页面真实流程验收，需在装有 HomeProxy 后端、sight-ui 与本插件页的专用容器运行。
 *   1. rpcd 接口签名逐字比对（后端升级后如有变化需复核 src/service.js）
 *   2. ACL：页面所需权限只来自本包的 sight-plugin-homeproxy 组，仅有 sight-ui 组的账号不可用
 *   3. 开关与主节点、延迟、导入分享链接与删除节点、分流/UDP/DNS、自定义域名、设备名单、订阅与规则库、连通性检查、日志与清空
 * 会修改并恢复配置。公共底座取自 sight-ui 工程：
 *   SIGHT_UI=/path/to/sight-ui LUCI_URL=http://127.0.0.1:8143 CONTAINER=<专用容器> node sight/scripts/flow-check.mjs
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIGHT_UI = process.env.SIGHT_UI?.trim();
if (!SIGHT_UI) { console.error('必须设置 SIGHT_UI，指向 sight-ui 工程目录。'); process.exit(2); }
const { createFlow } = await import(pathToFileURL(resolve(SIGHT_UI, 'scripts/lib/plugin-flow.mjs')).href);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { check, section, sh, ubus, denied, contract, withAclUser, browser, finish } = await createFlow({ id: 'homeproxy', outDir: join(ROOT, '.visual-out/flow') });

section('接口签名');
contract('luci.homeproxy', { singbox_get_features: {}, connection_check: { site: 'String' }, resources_get_version: { type: 'String' }, resources_update: { type: 'String' }, log_clean: { type: 'String' }, acllist_read: { type: 'String' }, acllist_write: { type: 'String', content: 'String' } });

section('ACL：权限来自本包');
await withAclUser(['sight-ui'], async sid => {
	check(denied(await ubus(sid, 'luci.homeproxy', 'singbox_get_features')) && denied(await ubus(sid, 'uci', 'get', { config: 'homeproxy' })), '只有 sight-ui 组的账号不能访问 HomeProxy');
});
await withAclUser(['sight-ui', 'sight-plugin-homeproxy'], async sid => {
	for (const [o, m, p] of [['luci.homeproxy', 'singbox_get_features', {}], ['luci.homeproxy', 'acllist_read', { type: 'proxy_list' }], ['uci', 'get', { config: 'homeproxy' }]])
		check((await ubus(sid, o, m, p))?.[0] === 0, `加上本包权限组后可调用 ${o}.${m}`);
	const ping = params => ubus(sid, 'file', 'exec', { command: '/bin/ping', params });
	check((await ping(['-4', '-c', '3', '-W', '1', '127.0.0.1']))?.[0] === 0 && denied(await ping(['-4', '-c', '300', '-W', '1', '127.0.0.1'])), '延迟测试只放行固定参数的 ping');
});

/* 固定的测试前提：有一个本地节点且代理关闭 */
const hpMode = sh('uci -q get homeproxy.config.routing_mode || echo bypass_mainland_china').trim();
sh(`uci set homeproxy.sighttest=node; uci set homeproxy.sighttest.label='Sight test node'; uci set homeproxy.sighttest.type=socks; uci set homeproxy.sighttest.address=127.0.0.1; uci set homeproxy.sighttest.port=1080;
	uci set homeproxy.config.main_node=nil; uci -q delete homeproxy.subscription.subscription_url; uci commit homeproxy`);

try {
	await browser(async ({ page, waitFor, fill, clickText, go, apply, confirmDialog, screenshot }) => {
		section('HomeProxy');
		const hpTab = async tab => { await go(`#/homeproxy?tab=${tab}`, `!!document.querySelector('[data-homeproxy]') && document.querySelector('.workspace-tabs [aria-selected=true]')?.id.endsWith('-tab-${['nodes', 'routing', 'devices', 'subscriptions', 'logs'].indexOf(tab)}')`); };
		await go('#/homeproxy', `!!document.querySelector('[data-homeproxy]')`);
		const hpSwitch = `document.querySelector('[role=switch][aria-label="Proxy"]')`;
		check(await page.evaluate(`document.querySelector('[data-homeproxy]').dataset.state === 'off' && !!document.querySelector('[data-node="sighttest"] button')`), '关闭状态显示，节点可选用');
		await page.evaluate(`${hpSwitch}.click()`);
		await apply('开启代理');
		check(sh('uci get homeproxy.config.main_node').trim() === 'sighttest', '打开代理即以节点为主节点写入并应用');
		await waitFor(`/Main node/.test(document.querySelector('[data-node="sighttest"]')?.textContent || '')`, '节点标记为主节点');
		check(await page.evaluate(`![...document.querySelectorAll('[data-node="sighttest"] button')].some(b => b.textContent.trim() === 'Delete')`), '使用中的节点不提供删除');

		/* 延迟：路由器 ping 节点服务器（测试节点地址为 127.0.0.1，必然有响应） */
		await clickText('.toolbar button', 'Test latency');
		await waitFor(`document.querySelector('[data-node="sighttest"] [data-latency]')?.dataset.latency === 'ok'`, '延迟结果', 20000);
		check(await page.evaluate(`/^\\d+ ms$/.test(document.querySelector('[data-node="sighttest"] [data-latency]').textContent.trim())`), '测试延迟后在节点行显示毫秒数');

		/* 导入分享链接：预览识别结果，只导入有效链接 */
		await clickText('.toolbar button', 'Import links');
		await waitFor(`!!document.getElementById('hp-links')`, '导入抽屉');
		await fill({ 'hp-links': 'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?type=tcp&security=reality&pbk=PUB&sid=ab&sni=a.example#Sight%20Tokyo\nss://YWVzLTI1Ni1nY206cGFzcw@5.6.7.8:8388#Sight%20HK\nbad://link' });
		await waitFor(`document.querySelectorAll('.preview li').length === 3`, '预览');
		check(await page.evaluate(`document.querySelectorAll('.preview li[data-valid=yes]').length === 2 && /Import 2 nodes/.test(document.querySelector('dialog.drawer[open] .form-actions').textContent)`), '预览区分可识别与无法识别的链接');
		await page.evaluate(`document.querySelector('dialog.drawer[open] form').requestSubmit()`);
		await apply('导入节点');
		const hpNode = label => sh(`uci -X show homeproxy | grep "label='${label}'" | cut -d. -f2 | head -1`).trim();
		const tokyo = hpNode('Sight Tokyo'), hk = hpNode('Sight HK');
		check(!!tokyo && sh(`uci get homeproxy.${tokyo}.tls_reality`).trim() === '1' && sh(`uci get homeproxy.${tokyo}.tls_reality_public_key`).trim() === 'PUB' && !!hk && sh(`uci get homeproxy.${hk}.shadowsocks_encrypt_method`).trim() === 'aes-256-gcm',
			'设备侧写入导入的节点（Reality 参数、Shadowsocks 加密方式）', { tokyo, hk });
		await waitFor(`!!document.querySelector('[data-node="${hk}"]')`, '节点卡片');
		await page.evaluate(`[...document.querySelectorAll('[data-node="${hk}"] button')].find(b => b.textContent.trim() === 'Delete').click()`);
		await confirmDialog('Delete');
		await apply('删除节点');
		check(!sh('uci show homeproxy').includes("label='Sight HK'"), '删除未使用的节点');

		/* 分流与 DNS：UDP 直连、自定义 DNS 校验 */
		await hpTab('routing');
		await waitFor(`!!document.getElementById('hp-udp')`, '分流表单');
		await fill({ 'hp-mode': 'global', 'hp-udp': 'nil', 'hp-dns': 'custom' });
		await waitFor(`!!document.getElementById('hp-dns-custom')`, '自定义 DNS 输入');
		await fill({ 'hp-dns-custom': 'dns.google' });
		await page.evaluate(`document.querySelector('form[aria-label="Routing & DNS"]').requestSubmit()`);
		await waitFor(`document.getElementById('hp-dns-custom')?.getAttribute('aria-invalid') === 'true'`, 'DNS 校验');
		check(true, '不带协议前缀的主机名 DNS 被拦截');
		await fill({ 'hp-dns-custom': 'tls://dns.google' });
		await page.evaluate(`document.querySelector('form[aria-label="Routing & DNS"]').requestSubmit()`);
		await apply('分流与 DNS');
		check(sh('uci get homeproxy.config.routing_mode').trim() === 'global' && sh('uci get homeproxy.config.main_udp_node').trim() === 'nil' && sh('uci get homeproxy.config.dns_server').trim() === 'tls://dns.google', '分流模式、UDP 直连与自定义 DNS 写入');

		/* 自定义域名：写入列表文件；非法域名被拦截；未点「添加」的输入一并保存 */
		const listFile = name => sh(`cat /etc/homeproxy/resources/${name}.txt 2>/dev/null || true`).trim();
		const listBackup = { proxy_list: listFile('proxy_list'), direct_list: listFile('direct_list') };
		await waitFor(`!!document.querySelector('form[data-hp-domains] #hp-proxy-domains')`, '域名列表');
		await fill({ 'hp-proxy-domains': 'bad domain' });
		await page.evaluate(`document.querySelector('form[data-hp-domains]').requestSubmit()`);
		await waitFor(`!!document.querySelector('form[data-hp-domains] .feedback[data-tone=error]')`, '域名校验');
		check(listFile('proxy_list') === listBackup.proxy_list, '非法域名被拦截，不写入文件');
		/* 失焦时非法条目已进入列表：删掉它再继续 */
		await page.evaluate(`[...document.querySelectorAll('form[data-hp-domains] li')].filter(l => /bad domain/.test(l.textContent)).forEach(l => l.querySelector('button').click())`);
		await fill({ 'hp-proxy-domains': 'Sight-Proxy.example', 'hp-direct-domains': 'sight-direct.example' });
		await page.evaluate(`document.querySelector('form[data-hp-domains]').requestSubmit()`);
		await waitFor(`/Domain lists saved/.test(document.querySelector('main').textContent)`, '域名列表保存', 30000);
		check(listFile('proxy_list').split('\n').includes('sight-proxy.example') && listFile('direct_list').split('\n').includes('sight-direct.example'), '域名写入对应列表文件（统一小写）', { proxy: listFile('proxy_list'), direct: listFile('direct_list') });
		check(await page.evaluate(`[...document.querySelectorAll('form[data-hp-domains] .dynlist li, form[data-hp-domains] li')].some(l => /sight-proxy\\.example/.test(l.textContent))`), '保存后列表显示新域名');
		/* 还原：容器里原本没有这两个文件时删除，否则写回原内容 */
		for (const [name, content] of Object.entries(listBackup)) sh(content ? `cat > /etc/homeproxy/resources/${name}.txt <<'SIGHTEOF'\n${content}\nSIGHTEOF` : `rm -f /etc/homeproxy/resources/${name}.txt`);

		/* 设备：仅所选设备走代理，按 MAC 名单保存 */
		await hpTab('devices');
		await page.evaluate(`document.querySelector('input[name=hp-access][value=listed_only]').click()`);
		await waitFor(`!!document.getElementById('hp-mac')`, 'MAC 输入');
		await fill({ 'hp-mac': 'not-a-mac' });
		await clickText('.mac-add button', 'Add');
		await waitFor(`document.getElementById('hp-mac')?.getAttribute('aria-invalid') === 'true'`, 'MAC 校验');
		await fill({ 'hp-mac': 'aa:bb:cc:dd:ee:10' });
		await clickText('.mac-add button', 'Add');
		await waitFor(`[...document.querySelectorAll('[data-hp-devices] label')].some(l => /AA:BB:CC:DD:EE:10/.test(l.textContent) && l.querySelector('input').checked)`, '设备加入名单');
		await page.evaluate(`document.querySelector('form[aria-label="Devices using the proxy"]').requestSubmit()`);
		await apply('设备名单');
		check(sh('uci get homeproxy.control.lan_proxy_mode').trim() === 'listed_only' && sh('uci get homeproxy.control.lan_proxy_mac_addrs').trim() === 'AA:BB:CC:DD:EE:10', '仅所选设备走代理，MAC 名单写入');

		/* 订阅与规则库 */
		await hpTab('subscriptions');
		await fill({ 'hp-subs': 'ftp://bad.example/sub' });
		await page.evaluate(`document.querySelector('form[aria-label="Subscriptions"]').requestSubmit()`);
		await waitFor(`!!document.getElementById('hp-subs-error')`, '订阅地址校验');
		check(true, '非 http(s) 订阅地址被拦截');
		await page.evaluate(`document.querySelector('form[aria-label="Subscriptions"] .dynlist li button')?.click()`);
		await fill({ 'hp-subs': 'https://sub.example/sight' });
		await page.evaluate(`document.querySelector('form[aria-label="Subscriptions"]').requestSubmit()`);
		await apply('订阅地址');
		check(sh('uci get homeproxy.subscription.subscription_url').trim() === 'https://sub.example/sight', '订阅地址写入');
		await page.evaluate(`document.querySelector('[role=switch][aria-label="Update through the proxy"]').click()`);
		await apply('经代理更新');
		check(sh('uci get homeproxy.subscription.update_via_proxy').trim() === '1', '经代理更新订阅开关写入');
		await waitFor(`!!document.querySelector('[data-resource="gfw_list"]') && !/Loading/.test(document.querySelector('[data-resource="gfw_list"]').textContent)`, '规则库版本');
		await clickText('[data-resource="gfw_list"] button', 'Update');
		await waitFor(`/Updated|Already up to date|An update is already running|Update failed/.test(document.querySelector('[data-resource="gfw_list"]').textContent)`, '规则库更新', 180000);
		check(true, '规则库更新给出结果（取决于容器网络）');

		/* 连通性与日志 */
		await clickText('[data-check="google"] button', 'Google');
		await waitFor(`!!document.querySelector('[data-check="google"] .badge')`, '连通性结果', 30000);
		check(true, '连通性检查返回结果（容器无真实代理，只验证调用与呈现）');
		await hpTab('logs');
		await waitFor(`!!document.querySelector('[role=tabpanel]:not([hidden]) [role=tabpanel]:not([hidden]) :is(pre, .feedback:not([data-tone=loading]))')`, '日志');
		sh('echo sight-log-line >> /var/run/homeproxy/homeproxy.log');
		await clickText('.log-actions button', 'Refresh');
		await waitFor(`/sight-log-line/.test(document.querySelector('pre.log')?.textContent || '')`, '日志刷新');
		await clickText('.log-actions button', 'Clear log');
		await confirmDialog('Clear log');
		await waitFor(`!/sight-log-line/.test(document.querySelector('main').textContent)`, '清空日志');
		check(!sh('cat /var/run/homeproxy/homeproxy.log 2>/dev/null || true').includes('sight-log-line'), '清空日志后文件被清空');
		await screenshot('homeproxy');
		await hpTab('nodes');
		await page.evaluate(`${hpSwitch}.click()`);
		await apply('关闭代理');
		check(sh('uci get homeproxy.config.main_node').trim() === 'nil', '关闭代理写回 nil');
	});
} finally {
	sh(`uci set homeproxy.config.main_node=nil; uci set homeproxy.config.routing_mode=${hpMode}; uci set homeproxy.config.main_udp_node=same; uci set homeproxy.config.dns_server=8.8.8.8;
		uci -q delete homeproxy.subscription.subscription_url; uci set homeproxy.subscription.update_via_proxy=0; uci set homeproxy.control.lan_proxy_mode=disabled; uci -q delete homeproxy.control.lan_proxy_mac_addrs;
		for s in $(uci -X show homeproxy | grep -E "label='Sight (Tokyo|HK)'" | cut -d. -f2); do uci delete homeproxy.$s; done; uci commit homeproxy; /etc/init.d/homeproxy stop 2>/dev/null; true`);
}
finish();
