/* 容器日志：带时间戳文本的解析、增量读取、追加与筛选（纯函数） */

export const LOG_LINES = [200, 1000, 5000];

const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z\s?/;

/**
 * 纯函数：带时间戳的日志文本 → [{ ts, time, text }]。ts 为可比较的定长字符串（纳秒补齐），time 为毫秒；
 * 没有时间戳的行（截断处等）ts 为 ''。末尾的空行去掉。
 */
export function parseLogs(text) {
	const lines = String(text || '').split('\n');
	if (lines.length && lines[lines.length - 1] === '') lines.pop();
	return lines.map(line => {
		const m = TS_RE.exec(line);
		if (!m) return { ts: '', time: null, text: line };
		const frac = (m[2] || '').padEnd(9, '0');
		return { ts: `${m[1]}.${frac}`, time: Date.parse(`${m[1]}Z`) + Math.floor(+frac / 1e6), text: line.slice(m[0].length) };
	});
}

/** 纯函数：最后一条记录 → logs 的 since 参数（UNIX 秒.纳秒）；没有时间戳为 '' */
export function sinceOf(lines) {
	for (let i = (lines || []).length - 1; i >= 0; i--) {
		const ts = lines[i].ts;
		if (ts) return `${Math.floor(Date.parse(`${ts.slice(0, 19)}Z`) / 1000)}.${ts.slice(20)}`;
	}
	return '';
}

/** 纯函数：跟随时追加增量记录：since 会包含时间相同的记录，只追加比已有最后一条更晚的；超出 limit 行时去掉最早的 */
export function appendLogs(lines, more, limit) {
	let last = '';
	for (let i = lines.length - 1; i >= 0 && !last; i--) last = lines[i].ts;
	const fresh = last ? more.filter(l => l.ts > last) : more;
	const all = fresh.length ? [...lines, ...fresh] : lines;
	return all.length > limit ? all.slice(all.length - limit) : all;
}

/** 纯函数：按关键字过滤（不区分大小写）；不显示时间时只匹配正文 */
export function filterLogs(lines, query, withTime, formatTime) {
	const q = String(query || '').trim().toLowerCase();
	return q ? lines.filter(l => (withTime && l.time != null ? `${formatTime(l.time)} ${l.text}` : l.text).toLowerCase().includes(q)) : lines;
}
