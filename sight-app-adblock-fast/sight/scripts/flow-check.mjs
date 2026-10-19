#!/usr/bin/env node
/*
 * 广告过滤插件真实流程验收，需在装有 sight-ui、adblock-fast 与本插件的专用容器运行（需能联网下载拦截列表）。
 *   1. ACL：页面所需权限来自本包；sight-ui 组不能读写 adblock-fast 配置
 *   2. 开启后没有任何列表时如实说明原因；开启一个小列表并加一条自定义拦截，保存应用后状态为拦截中，
 *      路由器的 DNS 对自定义域名不再返回真实地址；强制 DNS 开关写入配置
 *   3. 自动更新：每周计划写入 crontab（与 luci-app-adblock-fast 同格式），关闭后删除，其它任务保留
 *   4. 结束时恢复原配置与 crontab、停止服务
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
/* 清掉以前运行留下的缓存，否则没有列表时也会恢复出旧的拦截表 */
sh('mkdir -p /etc/crontabs; touch /etc/crontabs/root; cp /etc/crontabs/root /root/crontab.bak; echo "*/5 * * * * /usr/bin/hand-written.sh" >> /etc/crontabs/root; cp /etc/config/adblock-fast /root/adblock-fast.bak; /etc/init.d/adblock-fast stop >/dev/null 2>&1; /etc/init.d/adblock-fast killcache >/dev/null 2>&1; uci set adblock-fast.config.enabled=0; uci commit adblock-fast; /etc/init.d/dnsmasq start >/dev/null 2>&1; true');
const listSection = sh(`uci -X show adblock-fast | sed -n "s/^adblock-fast\\.\\([^.]*\\)\\.name='${SMALL}'$/\\1/p"`).trim();

section('ACL');
await withAclUser(['sight-ui'], async sid => check(denied(await ubus(sid, 'uci', 'get', { config: 'adblock-fast' })), '只有 sight-ui 组的账号不能读取广告过滤配置'));
await withAclUser(['sight-ui', 'sight-plugin-adblock-fast'], async sid => check((await ubus(sid, 'uci', 'get', { config: 'adblock-fast' }))?.[0] === 0, '加上本包权限组后可读取配置'));

try {
	await browser(async ({ page, waitFor, fill, go, apply, screenshot }) => {
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
		await page.evaluate(`document.querySelector('form[aria-label="Ad blocking settings"]').requestSubmit()`);
		await apply('保存列表与规则');
		check(sh(`uci get adblock-fast.${listSection}.enabled`).trim() === '1' && sh('uci get adblock-fast.config.blocked_domain').includes(DOMAIN) && sh('uci get adblock-fast.config.force_dns').trim() === '0', '列表、自定义拦截与强制 DNS 写入配置');
		await go('#/adblock-fast', `${hero}?.dataset.state === 'running'`);
		await waitFor(`${hero}?.dataset.state === 'running'`, '拦截中', 120000);
		check(await page.evaluate(`/Blocking \\d+ domains/.test(${hero}.textContent)`), '状态卡显示拦截条目数');
		const answer = sh(`nslookup ${DOMAIN} 127.0.0.1 2>&1 || true`);
		check(!/Address: (?!127\.0\.0\.1)\d+\.\d+\.\d+\.\d+/.test(answer.split('Name:')[1] || ''), '路由器的 DNS 拦截自定义域名', answer);
		await screenshot('adblock');

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
	sh('/etc/init.d/adblock-fast stop >/dev/null 2>&1; /etc/init.d/adblock-fast killcache >/dev/null 2>&1; /etc/init.d/adblock-fast disable >/dev/null 2>&1; cp /root/adblock-fast.bak /etc/config/adblock-fast; rm -f /root/adblock-fast.bak; cp /root/crontab.bak /etc/crontabs/root; rm -f /root/crontab.bak; /etc/init.d/cron restart >/dev/null 2>&1; /etc/init.d/dnsmasq stop >/dev/null 2>&1; true');
}
finish();
