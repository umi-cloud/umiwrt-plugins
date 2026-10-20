/*
 * 规则库（中国 IP、中国域名、GFWList）与自定义域名列表的纯函数。
 */
import { isHostname } from '@sight/sdk/lib';
import { MODE_RESOURCES, DOMAIN_LISTS } from './constants.js';

/* resources_update 的状态码 */
const UPDATE_RESULT = { 0: 'updated', 1: 'failed', 2: 'busy', 3: 'latest' };
/** 纯函数：resources_update 的返回 → 'updated' | 'failed' | 'busy' | 'latest' */
export const updateResult = r => UPDATE_RESULT[r?.status] || 'failed';

/** 纯函数：当前模式依赖、但还没下载的规则库；versions 未知（null）时返回空 */
export function missingResources(mode, versions) {
	return versions ? (MODE_RESOURCES[mode] || []).filter(r => !versions[r]) : [];
}

/** 纯函数：列表文件内容 → 域名数组（去空行、去重、转小写） */
export function parseDomains(text) {
	return [...new Set(String(text || '').split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(Boolean))];
}
export const validDomains = domains => domains.every(isHostname);

/** 纯函数：各列表草稿（已添加的项加输入框里的内容）→ 整理后的列表 */
export function collectDomains(lists, drafts) {
	return Object.fromEntries(DOMAIN_LISTS.map(k => [k, parseDomains([...lists[k], drafts[k] || ''].join('\n'))]));
}
/** 纯函数：与当前内容不同、需要写入的列表 */
export function changedLists(next, current) {
	return DOMAIN_LISTS.filter(k => next[k].join('\n') !== current[k].join('\n'));
}
