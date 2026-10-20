/*
 * 自动更新：root crontab 里带 # adblock-fast-auto 标记的一行，格式与 luci-app-adblock-fast 相同（互认），
 * 命令 /etc/init.d/adblock-fast dl 重新下载全部列表；写入即生效（写文件后重启 cron），不走暂存。
 */
import { readFile } from '@sight/sdk/lib';

export const CRONTAB = '/etc/crontabs/root';
const AUTO = '# adblock-fast-auto';
const LINE = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6]) \/etc\/init\.d\/adblock-fast dl # adblock-fast-auto$/;
const pad = n => String(n).padStart(2, '0');

/** 纯函数：crontab → { mode: 'off'|'daily'|'weekly'|'other', time, day }；other 为 LuCI 写的其它频率，保留不改 */
export function readSchedule(text) {
	const lines = String(text || '').split('\n').filter(l => l.includes(AUTO));
	const active = lines.find(l => !l.trimStart().startsWith('#'));
	if (!active) return { mode: 'off', time: '04:00', day: 0 };
	const m = LINE.exec(active.trim());
	if (!m) return { mode: 'other', time: '04:00', day: 0, line: active.trim() };
	return { mode: m[3] === '*' ? 'daily' : 'weekly', time: `${pad(m[2])}:${pad(m[1])}`, day: m[3] === '*' ? 0 : Number(m[3]) };
}

/** 纯函数：去掉旧的自动更新行（含 LuCI 注释掉的停用行），开启时追加新行；其它内容原样保留 */
export function buildSchedule(text, s) {
	const lines = String(text || '').split('\n').filter(l => !l.includes(AUTO));
	while (lines.length && lines[lines.length - 1] === '') lines.pop();
	if (s.mode === 'daily' || s.mode === 'weekly') {
		const [h, m] = s.time.split(':').map(Number);
		lines.push(`${m} ${h} * * ${s.mode === 'weekly' ? s.day : '*'} /etc/init.d/adblock-fast dl ${AUTO}`);
	}
	return lines.length ? lines.join('\n') + '\n' : '';
}

export const validTime = t => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t || '');

export function createSchedule(client) {
	/* 读不到（无权限）时不能当成空文件写回 */
	const read = async () => {
		const f = await readFile(client, CRONTAB);
		if (f.state === 'denied') throw new Error('Permission denied');
		return f.state === 'ok' ? f.data : '';
	};
	return {
		load: async () => readSchedule(await read()),
		/** 读最新内容再改，避免覆盖其他程序刚写入的任务 */
		async save(s) {
			await client.call('file', 'write', { path: CRONTAB, data: buildSchedule(await read(), s), mode: 0o600 });
			await client.call('sight', 'setInitAction', { name: 'cron', action: 'restart' });
		},
	};
}
