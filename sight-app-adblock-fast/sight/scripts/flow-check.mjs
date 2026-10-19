#!/usr/bin/env node
/*
 * 广告过滤插件真实流程验收，需在装有 sight-ui、adblock-fast 与本插件的专用容器运行（需能联网下载拦截列表）。
 *   1. ACL：页面所需权限来自本包；sight-ui 组不能读写 adblock-fast 配置
 *   2. 开启后没有任何列表时如实说明原因；开启一个小列表、加一条自定义拦截并自加一个列表（容器内 uhttpd 提供），
 *      保存应用后状态为拦截中，路由器的 DNS 对自定义域名不再返回真实地址；强制 DNS 开关写入配置
 *   3. 域名检查：子域名按上级规则判为拦截、自加列表里的域名被拦截、未拦截的域名可一键加入「始终拦截」草稿
 *   4. 限时暂停：服务停止并显示暂停，立即恢复后重新拦截；移除自加列表后配置里删掉该段
 *   5. 自动更新：每周计划写入 crontab（与 luci-app-adblock-fast 同格式），关闭后删除，其它任务保留
 *   6. 结束时恢复原配置与 crontab、停止服务
 *   SIGHT_UI=/path/to/sight-ui LUCI_URL=http://127.0.0.1:8152 CONTAINER=<专用容器> node sight/scripts/flow-check.mjs
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIGHT_UI = process.env.SIGHT_UI?.trim();
if (!SIGHT_UI) { console.error('必须设置 SIGHT_UI，指向 sight-ui 工程目录。'); process.exit(2); }
const { createFlow } = await import(pathToFileURL(resolve(SIGHT_UI, 'scripts/lib/plugin-flow.mjs')).href);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { check, section, sleep, sh, ubus, denied, withAclUser, browser, finish } = await createFlow({ id: 'adblock-fast', outDir: join(ROOT, '.visual-out/flow') });

/* 小列表：体积约 0.5 MB，下载与处理都快 */
const SMALL = 'Kboghdady - YouTube Ads DNS';
const DOMAIN = 'sight-check-ads.example.com';
/* 自加列表：由容器内 uhttpd 提供 */
const LIST_URL = 'http://127.0.0.1/sight-flow-list.txt', LIST_DOMAIN = 'sight-flow-list.example.com';
/* 清掉以前运行留下的缓存，否则没有列表时也会恢复出旧的拦截表 */
sh(`echo ${LIST_DOMAIN} > /www/sight-flow-list.txt`);
sh('mkdir -p /etc/crontabs; touch /etc/crontabs/root; cp /etc/crontabs/root /root/crontab.bak; echo "*/5 * * * * /usr/bin/hand-written.sh" >> /etc/crontabs/root; cp /etc/config/adblock-fast /root/adblock-fast.bak; /etc/init.d/adblock-fast stop >/dev/null 2>&1; /etc/init.d/adblock-fast killcache >/dev/null 2>&1; uci set adblock-fast.config.enabled=0; uci commit adblock-fast; /etc/init.d/dnsmasq start >/dev/null 2>&1; true');
const listSection = sh(`uci -X show adblock-fast | sed -n "s/^adblock-fast\\.\\([^.]*\\)\\.name='${SMALL}'$/\\1/p"`).trim();

section('ACL');
await withAclUser(['sight-ui'], async sid => check(denied(await ubus(sid, 'uci', 'get', { config: 'adblock-fast' })), '只有 sight-ui 组的账号不能读取广告过滤配置'));
await withAclUser(['sight-ui', 'sight-plugin-adblock-fast'], async sid => check((await ubus(sid, 'uci', 'get', { config: 'adblock-fast' }))?.[0] === 0, '加上本包权限组后可读取配置'));

try {
	await browser(async ({ page, waitFor, fill, go, apply, screenshot, clickText }) => {
		section('广告过滤');
		const hero = `document.querySelector('[data-card=adblock] [data-state]')`;
		await go('#/adblock-fast', `!!${hero}`);
		check(await page.evaluate(`${hero}.dataset.state`) === 'off', '关闭时状态为已关闭');

		await page.evaluate(`document.querySelector('[data-card=adblock] [role=switch]').click()`);
		await apply('开启');
		await waitFor(`${hero}?.dataset.state === 'failed'`, '开启后状态', 90000);
		check(sh('uci get adblock-fast.config.enabled').trim() === '1' && sh('ls /etc/rc.d | grep -c adblock-fast || true').trim() !== '0', '开启后写入配置并设为开机自启');
		check(await page.evaluate(`/No block-list or blocked domain is turned on/.test(document.querySelector('[data-card=adblock]').textContent)`), '没有任何列表时说明原因');

		await page.evaluate(`document.querySelector('[data-list="${listSection}"] input').click()`);
		await page.evaluate(`(() => { const i = document.getElementById('adblock-blocked'); i.value = '${DOMAIN}'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
		await page.evaluate(`document.getElementById('adblock-force').click()`);
		await clickText('[data-card=logs] button', 'Add list');
		await waitFor(`!!document.getElementById('adblock-list-url')`, '添加列表对话框');
		await fill({ 'adblock-list-url': 'ftp://bad' });
		await clickText('dialog[open] .actions button', 'Add');
		await waitFor(`!!document.getElementById('adblock-list-url-error')`, '地址校验');
		await fill({ 'adblock-list-url': LIST_URL, 'adblock-list-name': 'Sight flow list' });
		await clickText('dialog[open] .actions button', 'Add');
		await waitFor(`!document.querySelector('dialog[open]') && !!document.querySelector('[data-list=new]')`, '新列表出现在列表里');
		await page.evaluate(`document.querySelector('form[aria-label="Ad blocking settings"]').requestSubmit()`);
		await apply('保存列表与规则');
		const added = sh(`uci -X show adblock-fast | sed -n "s/^adblock-fast\\.\\([^.]*\\)\\.url='${LIST_URL.replace(/\//g, '\\/')}'$/\\1/p"`).trim();
		check(sh(`uci get adblock-fast.${listSection}.enabled`).trim() === '1' && sh('uci get adblock-fast.config.blocked_domain').includes(DOMAIN) && sh('uci get adblock-fast.config.force_dns').trim() === '0', '列表、自定义拦截与强制 DNS 写入配置');
		check(!!added && sh(`uci get adblock-fast.${added}.name`).trim() === 'Sight flow list' && sh(`uci get adblock-fast.${added}.action`).trim() === 'block', '自加列表写入为新的 file_url 段', added);
		await go('#/adblock-fast', `${hero}?.dataset.state === 'running'`);
		await waitFor(`${hero}?.dataset.state === 'running'`, '拦截中', 120000);
		check(await page.evaluate(`/Blocking \\d+ domains/.test(${hero}.textContent)`), '状态卡显示拦截条目数');
		const answer = sh(`nslookup ${DOMAIN} 127.0.0.1 2>&1 || true`);
		check(!/Address: (?!127\.0\.0\.1)\d+\.\d+\.\d+\.\d+/.test(answer.split('Name:')[1] || ''), '路由器的 DNS 拦截自定义域名', answer);
		await screenshot('adblock');

		section('域名检查');
		const result = `document.querySelector('[data-card=adblock-check] [data-result]')`;
		const checkDomain = async d => {
			await page.evaluate(`${result}?.remove()`);
			await fill({ 'adblock-check-domain': d });
			await page.evaluate(`document.querySelector('form[aria-label="Check a domain"]').requestSubmit()`);
			await waitFor(`!!${result}`, '检查结果 ' + d);
			return page.evaluate(`[${result}.dataset.result, ${result}.textContent.trim()]`);
		};
		let [kind, text] = await checkDomain(`x.${DOMAIN}`);
		check(kind === 'blocked' && text.includes(`because ${DOMAIN} is on the block-list`), '子域名按上级的自定义拦截判为拦截', text);
		[kind, text] = await checkDomain(LIST_DOMAIN);
		check(kind === 'blocked', '自加列表里的域名被拦截', text);
		[kind, text] = await checkDomain('sight-not-blocked.example.org');
		check(kind === 'allowed' && /is not blocked/.test(text), '未拦截的域名如实说明', text);
		await clickText('[data-card=adblock-check] button', 'Always block sight-not-blocked.example.org');
		check(await page.evaluate(`/Added to your rules/.test(${result}.textContent) && document.querySelector('[data-card=dns]').textContent.includes('sight-not-blocked.example.org')`), '一键加入「始终拦截」草稿');
		/* 放弃草稿：去掉刚加的那条 */
		await page.evaluate(`[...document.querySelectorAll('button')].find(b => /sight-not-blocked\.example\.org/.test(b.getAttribute('aria-label') || ''))?.click()`);

		section('限时暂停');
		await page.evaluate(`(() => { const s = document.querySelector('[data-adblock=pause] select'); s.value = '5'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		await clickText('[data-adblock=pause] button', 'Pause');
		await waitFor(`${hero}?.dataset.state === 'paused'`, '暂停', 30000);
		check(await page.evaluate(`/Paused, turns back on in 5 min/.test(${hero}.textContent)`), '状态卡显示暂停与剩余时间');
		/* 后台进程停服务要几秒 */
		const svcState = sh(`for i in $(seq 20); do s=$(ubus call service list '{"name":"adblock-fast"}'); echo "$s" | grep -q statusSuccess || break; sleep 1; done; echo "$s"`);
		check(!svcState.includes('statusSuccess') && sh('cat /var/run/sight-adblock-fast/until 2>/dev/null').trim() !== '', '暂停期间服务已停止，记录了恢复时刻', svcState);
		await clickText('[data-card=adblock] button', 'Turn back on now');
		await waitFor(`${hero}?.dataset.state === 'running'`, '立即恢复', 120000);
		check(!sh('ls /var/run/sight-adblock-fast 2>/dev/null').trim(), '恢复后不留暂停记录');

		section('移除自加列表');
		await page.evaluate(`[...document.querySelectorAll('[data-card=logs] button')].find(b => b.getAttribute('aria-label') === 'Remove Sight flow list').click()`);
		await page.evaluate(`document.querySelector('form[aria-label="Ad blocking settings"]').requestSubmit()`);
		await apply('移除列表');
		check(!sh('uci -X show adblock-fast').includes(LIST_URL), '移除后配置里删掉该段');

		section('自动更新');
		const sched = `document.querySelector('form[aria-label="Automatic updates"]')`;
		await waitFor(`!!${sched}`, '自动更新卡片');
		await fill({ 'adblock-sched-mode': 'weekly' });
		await waitFor(`!!document.getElementById('adblock-sched-day')`, '星期');
		await fill({ 'adblock-sched-day': '6', 'adblock-sched-time': '03:30' });
		await page.evaluate(`${sched}.requestSubmit()`);
		await waitFor(`/Automatic updates saved/.test(${sched}.textContent)`, '保存自动更新');
		const cron = sh('cat /etc/crontabs/root');
		check(cron.includes('30 3 * * 6 /etc/init.d/adblock-fast dl # adblock-fast-auto') && cron.includes('/usr/bin/hand-written.sh'), '每周计划写入 crontab，其它任务保留', cron);
		await fill({ 'adblock-sched-mode': 'off' });
		await page.evaluate(`${sched}.requestSubmit()`);
		await waitFor(`/Automatic updates turned off/.test(${sched}.textContent)`, '关闭自动更新');
		check(!sh('cat /etc/crontabs/root').includes('adblock-fast-auto') && sh('cat /etc/crontabs/root').includes('/usr/bin/hand-written.sh'), '关闭后删除计划行');
	});
} finally {
	sh('/etc/init.d/adblock-fast stop >/dev/null 2>&1; rm -rf /var/run/sight-adblock-fast /www/sight-flow-list.txt; /etc/init.d/adblock-fast killcache >/dev/null 2>&1; /etc/init.d/adblock-fast disable >/dev/null 2>&1; cp /root/adblock-fast.bak /etc/config/adblock-fast; rm -f /root/adblock-fast.bak; cp /root/crontab.bak /etc/crontabs/root; rm -f /root/crontab.bak; /etc/init.d/cron restart >/dev/null 2>&1; /etc/init.d/dnsmasq stop >/dev/null 2>&1; true');
}
finish();
