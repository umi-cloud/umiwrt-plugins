#!/usr/bin/env node
/*
 * HomeProxy 的 Sight 页面真实流程验收，需在装有 HomeProxy 后端、sight-ui 与本插件页的专用容器运行。
 *   1. rpcd 接口签名逐字比对（后端升级后如有变化需复核 src/service.js）
 *   2. ACL：页面所需权限只来自本包的 sight-plugin-homeproxy 组，仅有 sight-ui 组的账号不可用
 *   3. 开关与主节点、延迟、导入分享链接与删除节点、手工添加/编辑节点（未管理选项保留）、分流/UDP/DNS、自定义域名、设备名单、
 *      订阅与规则库、按订阅归组与删除、订阅过滤、自定义分流（模板、出站/规则/规则集/DNS 增删改、排序、启停与引用保护，
 *      生成的配置经 generate_client.uc + sing-box check 校验）、连通性检查、日志与清空
 * 会修改配置，结束时整份恢复 /etc/config/homeproxy。公共底座取自 sight-ui 工程：
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
	/* 规则排序用 uci order（只暂存在这个临时会话里，会话随账号删除） */
	const order = sh(`uci -X show homeproxy | grep -E '^homeproxy\\.[^.]+=' | cut -d. -f2 | cut -d= -f1`).trim().split('\n');
	check((await ubus(sid, 'uci', 'order', { config: 'homeproxy', sections: order }))?.[0] === 0, '加上本包权限组后可调整 homeproxy 段顺序（uci order）');
});

/* 固定的测试前提：有一个本地节点且代理关闭 */
const hpMode = sh('uci -q get homeproxy.config.routing_mode || echo bypass_mainland_china').trim();
sh(`uci set homeproxy.sighttest=node; uci set homeproxy.sighttest.label='Sight test node'; uci set homeproxy.sighttest.type=socks; uci set homeproxy.sighttest.address=127.0.0.1; uci set homeproxy.sighttest.port=1080;
	uci set homeproxy.config.main_node=nil; uci -q delete homeproxy.subscription.subscription_url; uci commit homeproxy`);
/* 结束时整份恢复：自定义分流、过滤等改动较多，逐项还原容易漏 */
const BACKUP = '/tmp/sight-homeproxy-flow.bak';
sh(`cp /etc/config/homeproxy ${BACKUP}`);
/* 用 HomeProxy 自己的脚本生成客户端配置并让 sing-box 检查 */
const singboxCheck = () => { try { return sh('ucode -S /etc/homeproxy/scripts/generate_client.uc && sing-box check -c /var/run/homeproxy/sing-box-c.json && echo SIGHT_CHECK_OK 2>&1'); } catch (e) { return String(e.stdout || '') + String(e.stderr || e.message); } };
const uget = key => sh(`uci -q get homeproxy.${key} || true`).trim();
const bySection = (type, label) => sh(`uci -X show homeproxy | grep -E "^homeproxy\\.[^.]+\\.label='${label}'" | cut -d. -f2 | while read s; do [ "$(uci -q get homeproxy.$s)" = ${type} ] && echo $s; done | head -1`).trim();

try {
	await browser(async ({ page, waitFor, fill, clickText, go, apply, confirmDialog, screenshot }) => {
		section('HomeProxy');
		const hpTab = async tab => { await go(`#/homeproxy?tab=${tab}`, `!!document.querySelector('[data-homeproxy]') && document.querySelector('.workspace-tabs [aria-selected=true]')?.id.endsWith('-tab-${['nodes', 'routing', 'devices', 'subscriptions', 'logs'].indexOf(tab)}')`); };
		/* 在容器里直接改过配置后重载页面，让页面读到新配置 */
		const reloadPage = async tab => { await page.evaluate(`location.reload()`); await new Promise(r => setTimeout(r, 1500)); await waitFor(`!!document.querySelector('[data-homeproxy]')`, '重载页面'); await hpTab(tab); };
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

		/* 手工添加节点：按协议显示字段，校验拦下非法 UUID */
		const drawer = `dialog.drawer[open]`;
		const tick = (label, on = true) => page.evaluate(`(() => { const i = [...document.querySelectorAll('${drawer} label')].find(l => l.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input'); if (!i) throw new Error('找不到勾选项 ' + ${JSON.stringify(label)}); if (i.checked !== ${on}) i.click(); })()`);
		const submitDrawer = () => page.evaluate(`document.querySelector('${drawer} form').requestSubmit()`);
		await clickText('.toolbar button', 'Add node');
		await waitFor(`!!document.getElementById('hp-node-type')`, '新建节点抽屉');
		await fill({ 'hp-node-type': 'vmess' });
		await waitFor(`!!document.getElementById('hp-node-uuid')`, 'VMess 字段');
		await fill({ 'hp-node-label': 'Sight Manual', 'hp-node-address': 'vm.example.com', 'hp-node-port': '443', 'hp-node-uuid': 'not-a-uuid' });
		await tick('Use TLS');
		await waitFor(`!!document.getElementById('hp-node-tls_sni')`, 'TLS 字段');
		await fill({ 'hp-node-tls_sni': 'cdn.example.com', 'hp-node-transport': 'ws' });
		await waitFor(`!!document.getElementById('hp-node-ws_path')`, 'WebSocket 字段');
		await fill({ 'hp-node-ws_path': '/ray', 'hp-node-ws_host': 'cdn.example.com' });
		await submitDrawer();
		await waitFor(`document.getElementById('hp-node-uuid')?.getAttribute('aria-invalid') === 'true'`, 'UUID 校验');
		check(true, '非法 UUID 被拦下，不写入');
		await fill({ 'hp-node-uuid': '0b6a8c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d' });
		await screenshot('homeproxy-node');
		await submitDrawer();
		await apply('手工添加节点');
		const manual = hpNode('Sight Manual');
		const nodeOpt = k => uget(`${manual}.${k}`);
		check(!!manual && nodeOpt('type') === 'vmess' && nodeOpt('uuid') === '0b6a8c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d' && nodeOpt('tls') === '1' && nodeOpt('tls_sni') === 'cdn.example.com'
			&& nodeOpt('transport') === 'ws' && nodeOpt('ws_path') === '/ray' && nodeOpt('vmess_encrypt') === 'auto' && !nodeOpt('grouphash'), '手工添加的 VMess 节点按表单写入', sh(`uci show homeproxy.${manual}`));

		/* 编辑：换传输方式，不再适用的受管键删除，表单之外的选项原样保留 */
		sh(`uci set homeproxy.${manual}.tcp_fast_open=1; uci set homeproxy.${manual}.tls_min_version=1.2; uci commit homeproxy`);
		await reloadPage('nodes');
		await waitFor(`!!document.querySelector('[data-node="${manual}"]')`, '手工节点行');
		await page.evaluate(`document.querySelector('[data-node="${manual}"] td').click()`);
		await waitFor(`document.getElementById('hp-node-label')?.value === 'Sight Manual'`, '整行点开编辑');
		check(await page.evaluate(`!document.querySelector('${drawer} .callout')`), '手工节点编辑时没有订阅覆盖提示');
		await fill({ 'hp-node-transport': 'grpc' });
		await waitFor(`!!document.getElementById('hp-node-grpc_servicename')`, 'gRPC 字段');
		await fill({ 'hp-node-grpc_servicename': 'sight', 'hp-node-label': 'Sight Manual 2' });
		await submitDrawer();
		await apply('编辑节点');
		check(nodeOpt('label') === 'Sight Manual 2' && nodeOpt('transport') === 'grpc' && nodeOpt('grpc_servicename') === 'sight' && !nodeOpt('ws_path') && !nodeOpt('ws_host')
			&& nodeOpt('tcp_fast_open') === '1' && nodeOpt('tls_min_version') === '1.2' && nodeOpt('uuid') === '0b6a8c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d', '编辑只改受管键：WebSocket 选项删除，未管理的选项保留', sh(`uci show homeproxy.${manual}`));
		/* 订阅来的节点：编辑时提示下次更新会覆盖 */
		sh(`uci set homeproxy.${tokyo}.grouphash=0123456789abcdef0123456789abcdef; uci commit homeproxy`);
		await reloadPage('nodes');
		await waitFor(`!!document.querySelector('[data-node="${tokyo}"]')`, '订阅节点行');
		await page.evaluate(`[...document.querySelectorAll('[data-node="${tokyo}"] button')].find(b => b.textContent.trim() === 'Edit').click()`);
		await waitFor(`/overwritten at the next subscription update/.test(document.querySelector('${drawer}')?.textContent || '')`, '订阅覆盖提示');
		check(await page.evaluate(`document.getElementById('hp-node-tls_reality_public_key')?.value === 'PUB'`), '订阅节点编辑时提示下次更新会覆盖，表单带出 Reality 参数');
		await page.evaluate(`document.querySelector('${drawer} .form-actions button:not([type=submit])').click()`);
		await waitFor(`!document.querySelector('${drawer}')`, '关闭抽屉');

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

		/* 按订阅归组：grouphash = md5(订阅地址)；删除某订阅的节点时保留使用中的 */
		const subHash = sh(`printf %s 'https://sub.example/sight' | md5sum | cut -d' ' -f1`).trim();
		sh(`for n in a b; do uci set homeproxy.sightsub_$n=node; uci set homeproxy.sightsub_$n.label="Sight Sub $n"; uci set homeproxy.sightsub_$n.type=socks; uci set homeproxy.sightsub_$n.address=127.0.0.1; uci set homeproxy.sightsub_$n.port=108$n; uci set homeproxy.sightsub_$n.grouphash=${subHash}; done;
			uci set homeproxy.sightsub_b.port=1082; uci set homeproxy.sightsub_a.port=1081; uci set homeproxy.config.main_udp_node=sightsub_a; uci commit homeproxy`);
		await reloadPage('subscriptions');
		await waitFor(`/^2$/.test(document.querySelector('[data-hp-group="${subHash}"] td:nth-child(3)')?.textContent.trim() || '')`, '订阅分组');
		check(true, '订阅节点按订阅地址归组计数');
		await screenshot('homeproxy-subscriptions');
		await page.evaluate(`[...document.querySelectorAll('[data-hp-group="${subHash}"] button')].find(b => b.textContent.trim() === 'Show nodes').click()`);
		await waitFor(`document.querySelectorAll('[data-node]').length === 2 && !!document.querySelector('[data-node="sightsub_a"]') && document.querySelector('[data-hp-source]')?.value === '${subHash}'`, '按来源筛选节点');
		check(true, '「查看节点」切到节点列表并按该订阅筛选');
		await hpTab('subscriptions');
		await page.evaluate(`[...document.querySelectorAll('[data-hp-group="${subHash}"] button')].find(b => b.textContent.trim() === 'Delete nodes').click()`);
		await waitFor(`/1 nodes are in use/.test(document.querySelector('dialog[role=alertdialog][open]')?.textContent || '')`, '删除订阅节点确认');
		await confirmDialog('Delete 1 nodes');
		await apply('删除订阅节点');
		check(!uget('sightsub_b') && uget('sightsub_a') === 'node', '删除某订阅的节点：使用中的（UDP 节点）保留，其余删除');
		sh('uci set homeproxy.config.main_udp_node=nil; uci delete homeproxy.sightsub_a; uci commit homeproxy');

		/* 订阅过滤：无效正则拦下；白名单 + 关键字 + User-Agent 写入 */
		const clearKeywords = () => page.evaluate(`(async () => { for (let i = 0; i < 20; i++) { const b = document.querySelector('form[data-hp-filter] .dynlist li button'); if (!b) return; b.click(); await new Promise(r => setTimeout(r, 60)); } })()`);
		await reloadPage('subscriptions');
		await waitFor(`!!document.getElementById('hp-filter-mode')`, '过滤设置');
		await fill({ 'hp-filter-mode': 'whitelist' });
		await clearKeywords();
		await fill({ 'hp-filter-keywords': '(bad' });
		await page.evaluate(`document.querySelector('form[data-hp-filter]').requestSubmit()`);
		await waitFor(`/valid regular expressions/.test(document.querySelector('form[data-hp-filter]').textContent)`, '正则校验');
		check(uget('subscription.filter_nodes') === 'blacklist', '无效正则被拦下，不写入');
		await clearKeywords();
		await fill({ 'hp-filter-keywords': '^Sight' });
		await page.evaluate(`document.querySelector('form[data-hp-filter] details summary').click()`);
		await fill({ 'hp-filter-ua': 'SightTest/1.0' });
		await page.evaluate(`document.querySelector('form[data-hp-filter]').requestSubmit()`);
		await apply('订阅过滤');
		check(uget('subscription.filter_nodes') === 'whitelist' && uget('subscription.filter_keywords') === '^Sight' && uget('subscription.user_agent') === 'SightTest/1.0', '订阅过滤方式、关键字与 User-Agent 写入', sh('uci show homeproxy.subscription'));

		/* 自定义分流：从「全部走代理」切过去，按「国内直连」模板建立初始配置 */
		await hpTab('routing');
		await fill({ 'hp-mode': 'custom' });
		await waitFor(`!!document.querySelector('input[name=hp-template][value=bypass_china]')`, '模板选择');
		await page.evaluate(`document.querySelector('input[name=hp-template][value=bypass_china]').click()`);
		await page.evaluate(`document.querySelector('form[aria-label="Routing & DNS"]').requestSubmit()`);
		await apply('切换到自定义分流');
		check(uget('config.routing_mode') === 'custom' && uget('routing.default_outbound') === 'sight_proxy' && uget('sight_proxy.node') === 'sighttest' && uget('dns.default_server') === 'sight_dns_remote'
			&& uget('sight_cn_sites.rule_set') === 'sight_geosite_cn' && uget('sight_dns_cn.server') === 'sight_dns_china', '切到自定义：出站、规则集、规则、DNS 按模板建立，默认出站沿用主节点', sh('uci show homeproxy | grep -E "sight_|routing\\.|dns\\."'));
		check(singboxCheck().includes('SIGHT_CHECK_OK'), '模板生成的配置通过 sing-box check', singboxCheck());
		await waitFor(`!!document.querySelector('[data-hp-custom]') && !document.querySelector('[data-hp-problems]')`, '自定义分流界面');
		const customTab = name => page.evaluate(`[...document.querySelectorAll('[data-hp-custom] [role=tab]')].find(b => b.textContent.trim().startsWith(${JSON.stringify(name)})).click()`);
		const addIn = text => clickText('[data-hp-custom] [role=tabpanel]:not([hidden]) .toolbar button', text);

		/* 出站：用手工节点、经模板的代理出站做链式代理 */
		await customTab('Outbounds');
		await addIn('Add outbound');
		await waitFor(`!!document.getElementById('hp-outbound-node')`, '出站表单');
		await fill({ 'hp-outbound-label': 'Sight Chain', 'hp-outbound-node': manual });
		await fill({ 'hp-outbound-detour': 'sight_proxy' });
		await submitDrawer();
		await apply('添加出站');
		const chain = bySection('routing_node', 'Sight Chain');
		check(!!chain && uget(`${chain}.node`) === manual && uget(`${chain}.outbound`) === 'sight_proxy' && uget(`${chain}.enabled`) === '1', '出站写入节点与链式代理上游', chain);

		/* 规则：无条件被拦下；按域名后缀发往新出站 */
		await customTab('Rules');
		await addIn('Add rule');
		await waitFor(`!!document.getElementById('hp-rule-domain_suffix')`, '规则表单');
		await fill({ 'hp-rule-label': 'Sight Rule' });
		await submitDrawer();
		await waitFor(`/Add at least one condition/.test(document.querySelector('${drawer}').textContent)`, '条件校验');
		check(true, '没有任何条件的规则被拦下');
		await fill({ 'hp-rule-domain_suffix': 'sight.example.org', 'hp-rule-domain_keyword': 'sightkw', 'hp-rule-port': '8443', 'hp-rule-target': chain });
		await submitDrawer();
		await apply('添加规则');
		const rule = bySection('routing_rule', 'Sight Rule');
		check(!!rule && uget(`${rule}.domain_suffix`) === 'sight.example.org' && uget(`${rule}.port`) === '8443' && uget(`${rule}.action`) === 'route' && uget(`${rule}.outbound`) === chain, '规则写入条件、动作与出站', sh(`uci show homeproxy.${rule}`));
		check(singboxCheck().includes('SIGHT_CHECK_OK'), '加入链式出站与规则后仍通过 sing-box check', singboxCheck());
		await screenshot('homeproxy-custom');

		/* 编辑规则：改成阻断，删掉出站；表单之外的条件（进程名）保留 */
		sh(`uci add_list homeproxy.${rule}.process_name=curl; uci commit homeproxy`);
		await reloadPage('routing'); await customTab('Rules');
		await waitFor(`!!document.querySelector('[data-hp-rule="${rule}"]')`, '规则行');
		await page.evaluate(`document.querySelector('[data-hp-rule="${rule}"] td:nth-child(2)').click()`);
		await waitFor(`document.getElementById('hp-rule-label')?.value === 'Sight Rule' && /process_name/.test(document.querySelector('${drawer}').textContent)`, '编辑规则（提示保留的条件）');
		await fill({ 'hp-rule-target': 'block' });
		await submitDrawer();
		await apply('规则改为阻断');
		check(uget(`${rule}.action`) === 'reject' && !uget(`${rule}.outbound`) && uget(`${rule}.process_name`) === 'curl', '改为阻断：动作写 reject、删除出站，未管理的进程条件保留', sh(`uci show homeproxy.${rule}`));

		/* 排序：新规则移到第一条，保存后段顺序随之改变 */
		const ruleOrder = () => sh(`uci -X show homeproxy | grep -E '=routing_rule$' | cut -d. -f2 | cut -d= -f1`).trim().split('\n');
		const before = ruleOrder();
		for (let i = before.indexOf(rule); i > 0; i--) await page.evaluate(`document.querySelector('[data-hp-rule="${rule}"] button[aria-label="Move Sight Rule up"]').click()`);
		await waitFor(`document.querySelector('[data-hp-custom] [role=tabpanel]:not([hidden]) tbody tr')?.dataset.hpRule === '${rule}'`, '列表内调整顺序');
		await addIn('Save order');
		await apply('保存规则顺序');
		check(ruleOrder()[0] === rule && ruleOrder().length === before.length, '规则顺序写入（只在规则之间调换）', ruleOrder());

		/* 启停：停用规则；被默认出站引用的出站不能停用 */
		await page.evaluate(`document.querySelector('[data-hp-rule="${rule}"] [role=switch]').click()`);
		await apply('停用规则');
		check(uget(`${rule}.enabled`) === '0', '规则停用写入 enabled=0');
		await customTab('Outbounds');
		await page.evaluate(`document.querySelector('[data-hp-outbound="sight_proxy"] [role=switch]').click()`);
		await waitFor(`/is used by/.test(document.querySelector('[data-hp-custom]').textContent)`, '引用保护');
		check(uget('sight_proxy.enabled') === '1', '被引用的出站不能停用，并说明被谁使用');

		/* 规则集：远程 .json 自动识别为源文件；再改成本地文件，远程选项删除 */
		await customTab('Rule sets');
		await addIn('Add rule set');
		await waitFor(`!!document.getElementById('hp-ruleset-url')`, '规则集表单');
		await fill({ 'hp-ruleset-label': 'Sight Set' });
		await page.evaluate(`(() => { const e = document.getElementById('hp-ruleset-url'); e.value = 'https://rules.example.com/sight.json'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		await waitFor(`document.getElementById('hp-ruleset-format')?.value === 'source'`, '格式按后缀推断');
		await submitDrawer();
		await apply('添加规则集');
		const set = bySection('ruleset', 'Sight Set');
		check(!!set && uget(`${set}.type`) === 'remote' && uget(`${set}.format`) === 'source' && uget(`${set}.url`) === 'https://rules.example.com/sight.json', '远程规则集写入，格式按 .json 识别为源文件');
		await page.evaluate(`document.querySelector('[data-hp-ruleset="${set}"] td').click()`);
		await waitFor(`!!document.querySelector('input[name=hp-ruleset-type][value=local]')`, '编辑规则集');
		await page.evaluate(`document.querySelector('input[name=hp-ruleset-type][value=local]').click()`);
		await waitFor(`!!document.getElementById('hp-ruleset-path')`, '本地路径');
		await fill({ 'hp-ruleset-path': '/etc/homeproxy/ruleset/sight.json' });
		await submitDrawer();
		await apply('规则集改为本地');
		check(uget(`${set}.type`) === 'local' && uget(`${set}.path`) === '/etc/homeproxy/ruleset/sight.json' && !uget(`${set}.url`), '改为本地文件：写入路径，删除远程地址');
		/* 删除：被规则引用的规则集给出说明不删；未引用的删除 */
		await page.evaluate(`[...document.querySelectorAll('[data-hp-ruleset="sight_geosite_cn"] button')].find(b => b.textContent.trim() === 'Delete').click()`);
		await waitFor(`/is in use/.test(document.querySelector('dialog[open]')?.textContent || '')`, '引用中的规则集');
		await page.evaluate(`document.querySelector('dialog[open] .close').click()`);
		await waitFor(`!document.querySelector('dialog[open]')`, '关闭说明');
		check(uget('sight_geosite_cn') === 'ruleset', '被规则引用的规则集不能删除');
		await page.evaluate(`[...document.querySelectorAll('[data-hp-ruleset="${set}"] button')].find(b => b.textContent.trim() === 'Delete').click()`);
		await confirmDialog('Delete');
		await apply('删除规则集');
		check(!uget(set), '删除未被引用的规则集');

		/* DNS：添加 DoH 服务器与 DNS 规则，并设为默认 DNS */
		await customTab('DNS');
		await addIn('Add DNS server');
		await waitFor(`!!document.getElementById('hp-dns-address')`, 'DNS 服务器表单');
		await fill({ 'hp-dns-label': 'Sight DoH', 'hp-dns-address': 'https://dns.google/dns-query', 'hp-dns-outbound': 'sight_proxy' });
		await submitDrawer();
		await apply('添加 DNS 服务器');
		const doh = bySection('dns_server', 'Sight DoH');
		check(!!doh && uget(`${doh}.type`) === 'https' && uget(`${doh}.server`) === 'dns.google' && uget(`${doh}.path`) === '/dns-query' && uget(`${doh}.outbound`) === 'sight_proxy', 'DNS 地址拆成类型、服务器与路径写入');
		await clickText('[data-hp-custom] [role=tabpanel]:not([hidden]) .toolbar button', 'Add DNS rule');
		await waitFor(`!!document.getElementById('hp-dnsrule-domain_suffix')`, 'DNS 规则表单');
		await fill({ 'hp-dnsrule-label': 'Sight DNS Rule', 'hp-dnsrule-domain_suffix': 'sight.example.org', 'hp-dnsrule-target': doh });
		await submitDrawer();
		await apply('添加 DNS 规则');
		const dnsRule = bySection('dns_rule', 'Sight DNS Rule');
		check(!!dnsRule && uget(`${dnsRule}.server`) === doh && uget(`${dnsRule}.action`) === 'route', 'DNS 规则写入');
		await fill({ 'hp-custom-defaultDns': doh });
		await page.evaluate(`document.querySelector('form[data-hp-custom-settings]').requestSubmit()`);
		await apply('默认 DNS');
		check(uget('dns.default_server') === doh, '默认 DNS 服务器写入');
		await customTab('Rules');
		await page.evaluate(`document.querySelector('[data-hp-rule="${rule}"] [role=switch]').click()`);
		await apply('重新启用规则');
		check(singboxCheck().includes('SIGHT_CHECK_OK'), '出站、规则、规则集、DNS 改动后生成的配置通过 sing-box check', singboxCheck());
		await customTab('DNS');
		await screenshot('homeproxy-custom-dns');

		/* 切回预设模式：主节点取默认出站使用的节点，自定义配置原样保留 */
		await fill({ 'hp-mode': 'global' });
		await page.evaluate(`document.querySelector('form[aria-label="Routing & DNS"]').requestSubmit()`);
		await apply('切回全部走代理');
		check(uget('config.routing_mode') === 'global' && uget('config.main_node') === 'sighttest' && uget(`${chain}.node`) === manual, '切回预设模式：主节点沿用，自定义配置保留');

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
	sh(`cp ${BACKUP} /etc/config/homeproxy; rm -f ${BACKUP}`);
	sh(`uci set homeproxy.config.main_node=nil; uci set homeproxy.config.routing_mode=${hpMode}; uci set homeproxy.config.main_udp_node=same; uci set homeproxy.config.dns_server=8.8.8.8;
		uci -q delete homeproxy.subscription.subscription_url; uci set homeproxy.subscription.update_via_proxy=0; uci set homeproxy.control.lan_proxy_mode=disabled; uci -q delete homeproxy.control.lan_proxy_mac_addrs;
		for s in $(uci -X show homeproxy | grep -E "label='Sight (Tokyo|HK)'" | cut -d. -f2); do uci delete homeproxy.$s; done; uci commit homeproxy; /etc/init.d/homeproxy stop 2>/dev/null; true`);
}
finish();
