/*
 * 订阅管理的纯函数：节点来源归组、关键字过滤设置、按订阅删除节点。
 * update_subscriptions.uc 给订阅来的节点写 grouphash = md5(订阅地址去掉 # 之后的部分)，手工添加的节点没有 grouphash；
 * 订阅地址删掉后，它的节点在下一次成功更新时被删除，在此之前归为「已移除的订阅」。
 * 过滤（filter_nodes + filter_keywords）在更新订阅时按节点名称逐个正则匹配：黑名单丢弃命中的，白名单只留命中的。
 */
import { toList } from '@sight/sdk/lib';
import { md5 } from './md5.js';

export const FILTER_MODES = ['disabled', 'blacklist', 'whitelist'];
export const MANUAL = 'manual', ORPHAN = 'orphan';

/** 订阅地址 → { url, hash, title }；标题取地址里 # 后的名称，没有则用主机名 */
export function subscriptionInfo(url) {
	const bare = String(url).replace(/#.*$/, '');
	let title = '';
	try {
		const u = new URL(url);
		title = u.hash ? decodeURIComponent(u.hash.slice(1)) : u.hostname;
	} catch { /* 非法地址按原文显示 */ }
	return { url, hash: md5(bare), title: title || bare };
}

/** 纯函数：节点的来源：MANUAL、某个订阅的 hash，或 ORPHAN（订阅地址已删除） */
export function sourceOf(node, hashes) {
	if (!node.grouphash) return MANUAL;
	return hashes.has(node.grouphash) ? node.grouphash : ORPHAN;
}

/** 纯函数：各来源的节点数。groups 按订阅地址的顺序 */
export function nodeGroups(urls, nodes) {
	const groups = urls.map(subscriptionInfo).map(g => ({ ...g, count: 0 }));
	const byHash = new Map(groups.map(g => [g.hash, g]));
	let manual = 0, orphan = 0;
	for (const n of nodes) {
		const src = sourceOf(n, byHash);
		if (src === MANUAL) manual++;
		else if (src === ORPHAN) orphan++;
		else byHash.get(src).count++;
	}
	return { groups, manual, orphan };
}

/** 纯函数：更新订阅时这个名称会不会被过滤掉（与 filter_check 一致；关键字无效时视为不命中） */
export function filtered(label, mode, keywords) {
	if (!label || mode === 'disabled' || !keywords.length) return false;
	const hit = keywords.some(k => { try { return new RegExp(k).test(label); } catch { return false; } });
	return mode === 'whitelist' ? !hit : hit;
}

/** 关键字按正则使用；脚本遇到无效正则会中止整次更新，必须先拦下 */
export function validateFilter({ mode, keywords }) {
	const e = [];
	if (!FILTER_MODES.includes(mode)) e.push('Unknown filter mode');
	if (mode !== 'disabled' && !keywords.length) e.push('Add at least one keyword');
	for (const k of keywords) { try { new RegExp(k); } catch { e.push('Keywords must be valid regular expressions'); break; } }
	return e;
}

/** 纯函数：订阅设置写入计划；空关键字与空 User-Agent 用 delete */
export function planFilter({ mode, keywords, userAgent }) {
	const values = { filter_nodes: mode }, remove = [];
	if (keywords.length) values.filter_keywords = keywords; else remove.push('filter_keywords');
	const ua = String(userAgent || '').trim();
	if (ua) values.user_agent = ua; else remove.push('user_agent');
	return { values, remove };
}

/** 纯函数：配置里引用到的节点（主节点、UDP 节点、自动选择列表、自定义分流的出站） */
export function nodesInUse(cfg) {
	const used = new Set(), c = cfg.config || {};
	/* 自定义模式下主节点不生效，但切回其他模式时仍会用到，同样保留 */
	for (const k of ['main_node', 'main_udp_node']) if (c[k] && !['nil', 'same', 'urltest'].includes(c[k])) used.add(c[k]);
	if (c.main_node === 'urltest') toList(c.main_urltest_nodes).forEach(n => used.add(n));
	if (c.main_udp_node === 'urltest') toList(c.main_udp_urltest_nodes).forEach(n => used.add(n));
	/* 出站节即使停用也引用节点：删掉节点后再启用会生成坏配置 */
	for (const s of Object.values(cfg)) if (s['.type'] === 'routing_node') {
		if (s.node && s.node !== 'urltest') used.add(s.node);
		toList(s.urltest_nodes).forEach(n => used.add(n));
	}
	return used;
}

/** 纯函数：删除某来源的全部节点，正在使用的保留 */
export function planRemoveGroup(nodes, source, hashes, used) {
	const own = nodes.filter(n => sourceOf(n, hashes) === source);
	return { remove: own.filter(n => !used.has(n.id)).map(n => n.id), kept: own.filter(n => used.has(n.id)).map(n => n.id) };
}
