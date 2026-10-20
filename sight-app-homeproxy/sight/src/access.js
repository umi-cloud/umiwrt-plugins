/*
 * 哪些设备走代理（按 MAC 的名单）与按设备规则的纯函数。按 IP 的名单页面不管理，原样保留。
 */
import { ACCESS } from './constants.js';

/** 纯函数：页面数据 → 名单表单草稿（当前模式对应名单的 MAC） */
export function accessForm(a) {
	return { mode: a.mode, macs: a.mode === 'except_listed' ? [...a.directMacs] : [...a.proxyMacs] };
}
/** 纯函数：切换名单类型时带出该名单已保存的设备 */
export function macsForMode(a, mode, current) {
	return mode === 'except_listed' ? [...a.directMacs] : mode === 'listed_only' ? [...a.proxyMacs] : current;
}

/** 纯函数：访问控制写入计划；另一种名单保持原样，按 IP 的名单不动 */
export function planAccess(mode, macs) {
	if (!ACCESS.includes(mode)) throw new Error('Unknown access mode');
	const values = { lan_proxy_mode: mode }, remove = [];
	const key = mode === 'listed_only' ? 'lan_proxy_mac_addrs' : mode === 'except_listed' ? 'lan_direct_mac_addrs' : null;
	if (key) { if (macs.length) values[key] = macs; else remove.push(key); }
	return { values, remove };
}

/** 纯函数：已保存的按设备规则（MAC 大写，全局代理优先） */
export function deviceRules(a) {
	const global = a.globalMacs || [];
	return [...global.map(mac => ({ mac, rule: 'global' })), ...(a.gamingMacs || []).filter(m => !global.includes(m)).map(mac => ({ mac, rule: 'gaming' }))];
}
/** 纯函数：按设备规则的写入计划；空名单用 delete */
export function planDeviceRules(rules) {
	const values = {}, remove = [];
	for (const [rule, key] of [['gaming', 'lan_gaming_mode_mac_addrs'], ['global', 'lan_global_proxy_mac_addrs']]) {
		const macs = rules.filter(r => r.rule === rule).map(r => r.mac.toUpperCase());
		if (macs.length) values[key] = macs; else remove.push(key);
	}
	return { values, remove };
}

/**
 * 纯函数：设备列表 = 在线客户端 + 已保存在任一名单里但当前不在线的 MAC（保存时不会悄悄丢掉）+ 草稿里新加的 MAC。
 * @param {{ mac?: string, name?: string, ip?: string, online?: boolean }[]} clients
 */
export function deviceRows(clients, a, draftMacs = []) {
	const online = clients.filter(c => c.mac).map(c => ({ mac: c.mac.toUpperCase(), name: c.name || '', ip: c.ip || '', online: !!c.online }));
	const known = new Set(online.map(d => d.mac));
	const saved = [...a.proxyMacs, ...a.directMacs, ...a.gamingMacs, ...a.globalMacs, ...draftMacs].filter(m => !known.has(m));
	return [...online, ...[...new Set(saved)].map(mac => ({ mac, name: '', ip: '', online: false }))];
}
