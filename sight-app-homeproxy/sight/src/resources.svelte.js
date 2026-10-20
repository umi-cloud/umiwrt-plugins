/*
 * 规则库的版本与更新状态：状态卡（当前模式缺少的规则库）与「规则」分区共用，由页面创建一份。
 */
import { errorText } from '@sight/sdk';
import { missingResources } from './resources.js';

export function createResources(svc) {
	let versions = $state(null);   // null 未读取
	let error = $state('');
	let busy = $state('');         // 正在更新的类型
	let results = $state({});      // 类型 → 'updated' | 'latest' | 'busy' | 'failed'
	let alive = true, loading = false;
	return {
		get versions() { return versions; },
		get error() { return error; },
		get busy() { return busy; },
		get results() { return results; },
		/** 当前模式依赖但未下载的规则库 */
		missing(mode) { return missingResources(mode, versions); },
		/* 版本读取失败单独记录，不显示成「未下载」 */
		async load() {
			if (loading) return;
			loading = true; error = '';
			try { const r = await svc.resourceVersions(); if (alive) versions = r; }
			catch (e) { if (alive) error = errorText(e); }
			finally { loading = false; }
		},
		async update(type) {
			if (busy) return;
			busy = type;
			let result;
			try { result = await svc.updateResource(type); } catch { result = 'failed'; }
			if (!alive) return;
			busy = ''; results = { ...results, [type]: result };
			await this.load();
		},
		destroy() { alive = false; },
	};
}
