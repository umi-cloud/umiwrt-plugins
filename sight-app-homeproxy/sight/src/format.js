/*
 * 显示格式的纯函数（不需要翻译的部分）。
 */
const pad = n => String(n).padStart(2, '0');

/** Unix 秒 → 浏览器本地时间 YYYY-MM-DD hh:mm */
export function localTime(sec) {
	const d = new Date(sec * 1000);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 规则库版本是时间戳（YYYYMMDDhhmm，部分带秒），按日期时间显示；其它原样返回 */
export function versionText(v) {
	return /^\d{12}(\d{2})?$/.test(v || '') ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)} ${v.slice(8, 10)}:${v.slice(10, 12)}` : v;
}

/** 秒 → { days, hours, minutes }，分钟至少为 1 */
export function durationParts(sec) {
	return { days: Math.floor(sec / 86400), hours: Math.floor(sec % 86400 / 3600), minutes: Math.max(1, Math.floor(sec % 3600 / 60)) };
}
