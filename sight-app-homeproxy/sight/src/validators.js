/*
 * 各表单共用的取值校验与 Base64 工具（纯函数）。
 */

export const isPort = v => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
export const isUint = v => /^\d+$/.test(v);

/** URL 安全与标准 Base64 均可，补齐填充后解码为字节；非法输入返回 null */
export function base64Bytes(text) {
	if (!text) return null;
	try {
		let s = String(text).trim().replace(/-/g, '+').replace(/_/g, '/');
		if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
		s += '='.repeat((4 - s.length % 4) % 4);
		return Uint8Array.from(atob(s), c => c.charCodeAt(0));
	} catch { return null; }
}
/** Base64 → UTF-8 文本；非法输入或不是 UTF-8 返回 null */
export function decodeBase64(text) {
	const bytes = base64Bytes(text);
	if (!bytes) return null;
	try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

/**
 * 纯函数：按字段种类（string / list / bool）把表单值整理成 uci 写入计划，只写表单管理的键，值为空时删除已有选项。
 * bool 为假时只删除原值为 '1' 的选项（原值 '0' 保留，避免无谓改动）。only 为本次适用的键：不适用的受管键一律删除。
 * @param {Record<string, 'string' | 'list' | 'bool'>} fields
 */
export function planOptions(fields, form, raw, values, remove, only = null) {
	const has = v => Array.isArray(v) ? v.length > 0 : v != null && v !== '';
	for (const [k, kind] of Object.entries(fields)) {
		const exists = has(raw[k]);
		if (only && !only.includes(k)) { if (exists) remove.add(k); continue; }
		if (kind === 'list') {
			const v = (form[k] || []).map(x => String(x).trim()).filter(Boolean);
			if (v.length) values[k] = v; else if (exists) remove.add(k);
		} else if (kind === 'bool') {
			if (form[k]) values[k] = '1'; else if (exists && raw[k] !== '0') remove.add(k);
		} else {
			const v = String(form[k] ?? '').trim();
			if (v) values[k] = v; else if (exists) remove.add(k);
		}
	}
}
