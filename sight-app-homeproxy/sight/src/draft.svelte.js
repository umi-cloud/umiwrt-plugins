/*
 * 表单草稿的公共件。
 * createDraft：草稿与基线。页面数据重载时只更新基线，未保存的草稿保留，除非用户已确认放弃（editing.discarded 递增）。
 * showErrors：校验结果 → 表单错误项，出错字段在收起的「高级」里时先展开，再把焦点移到错误汇总。
 */
import { tick, untrack } from 'svelte';
import { t, editing } from '@sight/sdk';

/**
 * @template T
 * @param {() => T} next 由当前页面数据算出的草稿初值
 * @param {{ key?: (v: T) => string }} [opts] 比较草稿用的键，默认 JSON
 * @returns {{ value: T, dirty: boolean, baseline: string, sync: () => void, reset: () => void }}
 *   在组件里：`const d = createDraft(() => form(data))`，然后 `$effect(() => { data; d.sync(); })`
 */
export function createDraft(next, { key = v => JSON.stringify(v) } = {}) {
	const initial = untrack(next);
	let value = $state(initial);
	let baseline = $state(key(initial));
	let seen = editing.discarded;
	const dirty = $derived(key(value) !== baseline);
	return {
		get value() { return value; },
		set value(v) { value = v; },
		get dirty() { return dirty; },
		get baseline() { return baseline; },
		/* 页面数据变化后调用：更新基线；没有未保存改动或用户已放弃时同步草稿 */
		sync() {
			const n = next();
			untrack(() => {
				const discarded = seen !== editing.discarded;
				seen = editing.discarded;
				if (!dirty || discarded) value = n;
				baseline = key(n);
			});
		},
		reset() { value = next(); baseline = key(value); },
	};
}

/**
 * 校验结果 → [{ text, field }]；有错误时展开含出错字段的「高级」并聚焦汇总，返回 true。
 * @param {{ msg: string, args?: any[], field: string }[]} list
 * @param {(field: string) => string} fid 字段 → 元素 id
 * @param {{ summary?: { focus(): void }, openAdvanced?: () => void }} target
 */
export async function showErrors(list, fid, { summary, openAdvanced } = {}) {
	const errors = list.map(e => ({ text: t(e.msg, ...(e.args || [])), field: fid(e.field) }));
	if (!errors.length) return { errors, failed: false };
	if (openAdvanced && errors.some(e => document.getElementById(e.field)?.closest('details:not([open])'))) openAdvanced();
	await tick();
	summary?.focus();
	return { errors, failed: true };
}
