/*
 * 代理开着但 sing-box 没在运行时找原因（纯函数）。
 */

const ANSI = /\x1b\[[0-9;]*m/g;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');

/** 纯函数：日志行开头的设备本地时间 → 可比较的 YYYYMMDDhhmmss；服务日志为 "2026-10-19 14:08:11 …"，系统日志为 "Mon Oct 19 14:08:11 2026 …" */
export function logTime(line) {
	let m = String(line).match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) /);
	if (m) return m.slice(1).join('');
	m = String(line).match(/^\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4}) /);
	return m && MONTHS.includes(m[1]) ? `${m[6]}${pad(MONTHS.indexOf(m[1]) + 1)}${pad(m[2])}${m[3]}${m[4]}${m[5]}` : '';
}

/** 去掉 sing-box 日志行的时间与级别前缀，只留错误内容 */
export const fatalMessage = line => line.replace(ANSI, '').replace(/^.*?\b(?:FATAL|ERROR)\[\d+\]\s*/, '').trim();

/**
 * 纯函数：服务日志（homeproxy.log）里最近一次启动失败（[DAEMON] Error: …，紧挨着的前几行是 generate_client.uc 或 sing-box check 的错误输出）
 * 晚于最近一次成功启动时，原因是配置生成或检查失败；否则取系统日志里这次启动之后 sing-box 的最后一条 FATAL（启动后退出，
 * procd 重试几次后放弃）。服务日志被清空、找不到启动记录时不比较时间。
 * @param {string | null} serviceLog @param {string[]} fatalLines sight.homeproxy client_errors 的返回
 * @returns {{ reason: 'generate' | 'check' | 'exited', detail: string, log: 'homeproxy' | 'syslog' } | null}
 */
export function diagnose(serviceLog, fatalLines = []) {
	const lines = String(serviceLog || '').replace(ANSI, '').split('\n');
	const failed = lines.findLastIndex(l => /\[DAEMON\] Error: .*client configuration/.test(l));
	const started = lines.findLastIndex(l => /\[DAEMON\] sing-box .* started\./.test(l));
	if (failed > started) {
		let i = failed;
		while (i > 0 && !logTime(lines[i - 1])) i--;
		const detail = lines.slice(i, failed).map(fatalMessage).find(Boolean) || '';
		return { reason: /failed to generate/.test(lines[failed]) ? 'generate' : 'check', detail, log: 'homeproxy' };
	}
	const since = started >= 0 ? logTime(lines[started]) : '';
	const fatal = fatalLines.filter(l => / sing-box\[\d+\]: /.test(l) && /FATAL/.test(l) && logTime(l) >= since).at(-1);
	return fatal ? { reason: 'exited', detail: fatalMessage(fatal), log: 'syslog' } : null;
}
