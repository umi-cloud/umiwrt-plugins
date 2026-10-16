#!/usr/bin/env node
/*
 * Docker 的 Sight 页面真实流程验收，需在装有 dockerd、sight-ui 与本插件（含 docker.* / sight.docker 后端）的专用容器运行。
 *   1. rpcd 接口签名逐字比对
 *   2. ACL：页面所需权限只来自本包的 sight-plugin-docker 组；新建/删除容器、重启策略、清理镜像与后台下载已放行，
 *      不再放行 docker CLI；exec 进容器、写容器文件、原始拉取/导入镜像、卷与网络的增删仍未授权；下载拒绝不合格的镜像引用
 *   3. 容器停止/启动/重启回读、详情与日志（设备端解复用）、资源占用、修改重启策略、使用中的镜像不可删除
 *   4. 新建容器（本地已有的 busybox:stable：端口、只读目录、环境变量、命令）并启动，再删除
 *   5. 下载镜像（后台任务；不能上外网时验证界面如实报错）与清理未使用的镜像
 *   6. 设置：镜像加速与数据目录写入 uci、经 reload 生效，再恢复
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

/* 需可用的守护进程，二选一，都要准备运行中的 sight-web 与已退出的 sight-job（busybox:stable，日志含 job done）：
   - DOCKER_LOCAL=1：专用容器内的 dockerd（与真机一致，容器需特权）；
   - 否则 dockerd.globals.hosts 指向隔离的 DinD
     （docker run -d --privileged --name sight-dind -e DOCKER_TLS_CERTDIR= docker:dind dockerd --host=tcp://0.0.0.0:2375）。
   都没有时跳过页面流程，并在报告中注明 */
const DIND = cmd => process.env.DOCKER_LOCAL === '1' ? sh(cmd)
	: execFileSync('docker', ['exec', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', 'sight-dind', 'sh', '-c', cmd], { encoding: 'utf8' });
const NEW = 'sight-flow-new', PULL = 'hello-world:latest', MIRROR = 'https://mirror.sight-flow.example';
const FLOW_ROOT = '/tmp/docker-flow/';

section('接口签名');
contract('docker', { version: {}, info: {}, df: {} });
contract('docker.container', {
	list: { query: 'Table' }, inspect: { id: 'String', query: 'Table' }, stats: { id: 'String', query: 'Table' },
	start: { id: 'String', query: 'Table' }, stop: { id: 'String', query: 'Table' }, restart: { id: 'String', query: 'Table' },
	create: { query: 'Table', body: 'Table' }, remove: { id: 'String', query: 'Table' }, update: { id: 'String', body: 'Table' },
});
contract('docker.image', { list: { query: 'Table' }, remove: { id: 'String', query: 'Table' }, prune: { query: 'Table' } });
contract('docker.network', { list: { query: 'Table' } });
contract('sight.docker', { logs: { id: 'String', tail: 'Integer' }, pull_start: { image: 'String' }, pull_status: {} });

section('ACL：权限来自本包');
await withAclUser(['sight-ui'], async sid => {
	check(denied(await ubus(sid, 'docker', 'version')) && denied(await ubus(sid, 'sight.docker', 'pull_status')) && denied(await ubus(sid, 'uci', 'get', { config: 'dockerd' })), '只有 sight-ui 组的账号不能访问 Docker');
});
await withAclUser(['sight-ui', 'sight-plugin-docker'], async sid => {
	for (const [o, m, p] of [['docker', 'version', {}], ['docker.container', 'list', { query: { all: true } }], ['docker.image', 'list', {}], ['docker.network', 'list', { query: {} }],
		['sight.docker', 'pull_status', {}], ['sight.docker', 'logs', { id: 'sight-job', tail: 5 }], ['uci', 'get', { config: 'dockerd' }]])
		check((await ubus(sid, o, m, p))?.[0] === 0, `加上本包权限组后可调用 ${o}.${m}`);
	/* 写操作用不存在的对象试探：放行时由 Docker 回 4xx，而不是被 ACL 拒绝 */
	const missing = 'sight-flow-missing';
	const allowed = [
		await ubus(sid, 'docker.container', 'remove', { id: missing, query: {} }), await ubus(sid, 'docker.container', 'update', { id: missing, body: {} }),
		await ubus(sid, 'docker.container', 'create', { query: { name: missing }, body: { Image: 'sight-flow-missing-image:none' } }),
	];
	check(allowed.every(r => r?.[0] === 0 && r[1]?.code >= 400), '新建/删除容器与修改重启策略已放行（不存在的对象由 Docker 报错）', allowed);
	const injected = await ubus(sid, 'sight.docker', 'pull_start', { image: 'busybox; touch /tmp/sight-flow-pwned' });
	check(injected?.[1]?.error === 'invalid image' && sh('[ -e /tmp/sight-flow-pwned ] && echo yes || echo no').trim() === 'no', '下载拒绝不合格的镜像引用', injected);
	const cli = await ubus(sid, 'file', 'exec', { command: '/usr/bin/docker', params: ['logs', '--tail', '200', '--timestamps', 'f'.repeat(64)] });
	check(cli?.[0] === 6, '不再放行 docker CLI（日志改由 sight.docker 在设备端读取）', cli);
	const rejected = [
		await ubus(sid, 'docker.container', 'exec', { id: missing, opts: {} }), await ubus(sid, 'docker.container', 'put_archive', { id: missing, query: {}, body: '' }),
		await ubus(sid, 'docker.exec', 'start', { id: missing, body: '' }), await ubus(sid, 'docker.image', 'create', { query: {}, headers: {} }),
		await ubus(sid, 'docker.image', 'load', { query: {} }), await ubus(sid, 'docker.volume', 'remove', { id: missing, query: {} }),
		await ubus(sid, 'docker.network', 'create', { body: {} }), await ubus(sid, 'docker.container', 'prune', { query: {} }),
	];
	check(rejected.every(denied), 'exec、写容器文件、原始拉取/导入镜像、卷与网络增删、批量清理容器仍未授权', rejected);
});

let dockerReady = false;
try { DIND('docker start sight-web >/dev/null; docker inspect sight-job >/dev/null'); dockerReady = /"code":\s*200/.test(sh('ubus call docker version')); } catch { dockerReady = false; }
const original = {};
if (dockerReady) {
	original.policy = DIND(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' sight-web`).trim() || 'no';
	original.root = sh('uci -q get dockerd.globals.data_root || true').trim();
	original.mirrors = sh('uci -q get dockerd.globals.registry_mirrors || true').trim();
	original.hadPull = DIND(`docker image inspect ${PULL} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'yes';
}

try {
	await browser(async ({ page, waitFor, fill, clickText, go, apply, confirmDialog, screenshot }) => {
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
		const tab = async i => { await page.evaluate(`document.querySelectorAll('.workspace-tabs [role=tab]')[${i}].click()`); await sleep(300); };
		const hasButton = (scope, text) => `[...(${scope}?.querySelectorAll('button') || [])].some(b => b.textContent.trim() === ${JSON.stringify(text)})`;
		/* 无 id 的控件（端口/目录行）按选择器逐个赋值 */
		const setAll = (selector, values) => page.evaluate(`(() => { const els = document.querySelectorAll(${JSON.stringify(selector)}); ${JSON.stringify(values)}.forEach((v, i) => { els[i].value = v; els[i].dispatchEvent(new Event('input', { bubbles: true })); els[i].dispatchEvent(new Event('change', { bubbles: true })); }); })()`);

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

		section('详情：日志、资源占用、重启策略');
		await page.evaluate(`document.querySelector('tr[data-container="sight-job"] td').click()`);
		await waitFor(`!!${drawer}?.querySelector('[data-container-detail="sight-job"]') && !${drawer}.querySelector('.feedback[data-tone=loading]')`, '容器详情');
		const logText = await page.evaluate(`${drawer}.querySelector('pre, [role=log], .log')?.textContent || ${drawer}.textContent`);
		check(/job done/.test(logText) && !/[\u0000-\u0008]/.test(logText), '详情显示容器日志（设备端解开多路复用流，无帧头残留）', logText.slice(-200));
		await screenshot('docker');
		await closeDrawer();

		await page.evaluate(`document.querySelector('tr[data-container="sight-web"] td').click()`);
		await waitFor(`!!${drawer}?.querySelector('[data-container-detail="sight-web"] [data-usage]')`, '运行中容器的资源占用');
		await waitFor(`/\\d+\\.\\d%/.test(${drawer}.querySelector('[data-usage]').textContent)`, 'CPU 占用', 15000);
		const usageText = await page.evaluate(`${drawer}.querySelector('[data-usage]').textContent`);
		check(/CPU\s*\d+\.\d%/.test(usageText) && /Memory/.test(usageText), '资源占用显示 CPU 百分比与内存（嵌套容器取不到内存时显示不可用）', usageText);
		await screenshot('docker-usage');
		const target = original.policy === 'always' ? 'on-failure' : 'always';
		for (const [policy, label] of [[target, `重启策略写入容器（${target}）`], [original.policy, '重启策略经界面恢复']]) {
			await fill({ 'docker-restart-policy': policy });
			await clickText('dialog.drawer[open] button', 'Save restart policy');
			await waitFor(`!${hasButton(drawer, 'Save restart policy')} && /Restart policy saved/.test(${drawer}.textContent)`, '保存重启策略');
			check(inspect('sight-web', '{{.HostConfig.RestartPolicy.Name}}') === policy, label);
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
		await page.evaluate(`document.querySelector('tr[data-container="${NEW}"] td').click()`);
		await waitFor(`!!${drawer}?.querySelector('[data-container-detail="${NEW}"]') && /flow ready/.test(${drawer}.textContent)`, '新容器详情与日志');
		await clickText('dialog.drawer[open] [data-container-detail] button', 'Delete');
		await waitFor(`!!document.querySelector('dialog[role=alertdialog][open] [data-remove-dialog]')`, '删除确认');
		check(await page.evaluate(`/It is stopped first/.test(document.querySelector('dialog[role=alertdialog][open]').textContent)`), '删除运行中的容器时说明会先停止');
		await page.evaluate(`document.querySelector('[data-remove-dialog] input[type=checkbox]').click()`);
		await confirmDialog('Delete');
		await waitFor(`/Deleted ${NEW}/.test(${main}) && !document.querySelector('tr[data-container="${NEW}"]') && !document.querySelector('dialog.drawer[open]')`, '删除容器', 40000);
		check(DIND(`docker inspect ${NEW} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'no', '设备上的容器已删除');

		section('下载与清理镜像');
		await tab(1);
		check(await page.evaluate(`[...document.querySelectorAll('tr[data-image="busybox:stable"] .actions button')].find(b => b.textContent.trim() === 'Remove')?.disabled === true`), '使用中的镜像不可删除');
		await page.evaluate(`document.querySelector('[data-action=pull]').click()`);
		await waitFor(`!!document.querySelector('[data-pull-form]')`, '下载表单');
		await fill({ 'pull-image': 'Bad Image' });
		await page.evaluate(`document.querySelector('[data-pull-form]').requestSubmit()`);
		await waitFor(`!!document.querySelector('[data-pull-form] .error-summary')`, '引用校验');
		check(true, '不合格的镜像引用在表单内说明，不发起下载');
		await fill({ 'pull-image': 'hello-world' });
		await page.evaluate(`document.querySelector('[data-pull-form]').requestSubmit()`);
		await waitFor(`!document.querySelector('[data-pull-form]')`, '开始下载');
		await screenshot('docker-pull');
		await waitFor(`/Downloaded ${PULL}|Could not download ${PULL}/.test(${main})`, '下载结束', 240000);
		const pulled = await page.evaluate(`/Downloaded ${PULL}/.test(${main})`);
		const task = JSON.parse(sh('ubus call sight.docker pull_status')).task;
		if (pulled) {
			check(task?.state === 'done' && await page.evaluate(`!!document.querySelector('tr[data-image="${PULL}"]')`), '后台下载完成，镜像出现在列表中', task);
			await page.evaluate(`document.querySelector('[data-action=prune]').click()`);
			await confirmDialog('Remove');
			await waitFor(`/Removed \\d+ unused images/.test(${main})`, '清理未使用的镜像', 60000);
			check(DIND(`docker image inspect ${PULL} >/dev/null 2>&1 && echo yes || echo no`).trim() === 'no' && DIND('docker image inspect busybox:stable >/dev/null 2>&1 && echo yes || echo no').trim() === 'yes',
				'清理删除未使用的镜像，保留容器在用的', await page.evaluate(`document.querySelector('main .feedback')?.textContent`));
			await screenshot('docker-images');
		} else {
			/* 容器不能上外网：界面如实报告 Docker 给出的原因 */
			check(task?.state === 'failed' && !!task.error && await page.evaluate(`${main}.includes(${JSON.stringify(task?.error || '?')})`), '无法下载时界面如实说明原因（外网不可用）', task);
		}

		section('设置');
		await tab(2);
		await waitFor(`!!document.querySelector('[data-docker-settings]')`, '设置表单');
		await fill({ 'docker-mirrors': MIRROR, 'docker-data-root': FLOW_ROOT });
		await waitFor(`/are no longer shown/.test(document.querySelector('[data-docker-settings]').textContent)`, '数据目录提示');
		check(true, '改数据目录前提示原有镜像与容器不可见');
		await screenshot('docker-settings');
		await page.evaluate(`document.querySelector('[data-docker-settings]').requestSubmit()`);
		await apply('Docker 设置');
		check(sh('uci -q get dockerd.globals.registry_mirrors').trim() === MIRROR && sh('uci -q get dockerd.globals.data_root').trim() === FLOW_ROOT, '设置写入 dockerd 配置');
		let mirrors = [];
		for (let i = 0; i < 20 && !mirrors.includes(MIRROR + '/'); i++) { await sleep(500); mirrors = JSON.parse(sh('ubus call docker info')).body.RegistryConfig?.Mirrors || []; }
		check(mirrors.includes(MIRROR + '/'), '镜像加速经 reload 生效，无需重启 Docker', mirrors);
		await waitFor(`/Docker is still using/.test(document.querySelector('[data-docker-settings]')?.textContent || '')`, '重启提示');
		check(true, '数据目录与运行中的不一致时提示重启 Docker');
		await screenshot('docker-settings-restart');
		await page.evaluate(`document.querySelector('[data-docker-settings] button[aria-label="Remove ${MIRROR}"]').click()`);
		await fill({ 'docker-data-root': original.root });
		await page.evaluate(`document.querySelector('[data-docker-settings]').requestSubmit()`);
		await apply('恢复 Docker 设置');
		check(sh('uci -q get dockerd.globals.registry_mirrors || echo none').trim() === (original.mirrors || 'none') && sh('uci -q get dockerd.globals.data_root || true').trim() === original.root, '设置经界面恢复');
		/* 加速地址全部删掉后 dockerd 的 reload 不会清掉它，页面应提示重启；经界面重启后运行值与配置一致 */
		await waitFor(`/previous registry mirrors/.test(document.querySelector('[data-docker-settings]')?.textContent || '')`, '删除加速地址后提示重启');
		check(true, '加速地址全部删除后提示需重启 Docker');
		await clickText('[data-restart-needed] button', 'Restart Docker');
		await confirmDialog('Restart');
		await waitFor(`!!document.querySelector('[data-docker="up"]') && !!document.querySelector('[data-docker-settings]') && !document.querySelector('[data-restart-needed]')`, '重启 Docker', 90000);
		const after = JSON.parse(sh('ubus call docker info')).body.RegistryConfig?.Mirrors || [];
		check(!after.includes(MIRROR + '/'), '经界面重启 Docker 后加速地址清除、不再提示重启', after);
	});
} finally {
	if (dockerReady) {
		/* 无论成败都恢复：删除流程容器与下载的镜像、恢复重启策略与 dockerd 设置 */
		for (const cmd of [`docker rm -f ${NEW} >/dev/null 2>&1; true`, `docker update --restart=${original.policy} sight-web >/dev/null`, 'docker start sight-web >/dev/null',
			original.hadPull ? 'true' : `docker rmi ${PULL} >/dev/null 2>&1; true`])
			try { DIND(cmd); } catch { /* 忽略 */ }
		try {
			const mirrors = original.mirrors ? original.mirrors.split(/\s+/).map(m => `uci add_list dockerd.globals.registry_mirrors='${m}';`).join(' ') : '';
			const root = original.root ? `uci set dockerd.globals.data_root='${original.root}';` : 'uci -q delete dockerd.globals.data_root;';
			sh(`uci -q delete dockerd.globals.registry_mirrors; ${mirrors} ${root} uci commit dockerd; /etc/init.d/dockerd reload; rm -rf /tmp/sight-flow`);
		} catch { /* 忽略 */ }
	}
}
finish();
