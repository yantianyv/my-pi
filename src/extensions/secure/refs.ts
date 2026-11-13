/**
 * secure / refs.ts — 引用语法与「按已知值精确替换」
 *
 * 两条通道，都不靠猜测：
 *   - 展开：命令里的 {{sec:名字}} → 库里的真值，执行瞬间完成；
 *   - 回遮：结果里出现的**本次实际展开过**的值 → «已隐藏:名字»。
 *
 * 回遮的判据是「我们刚才注入过这个字符串」，不是「它看起来像凭证」，所以误报恒为零、
 * 漏报也恒为零（值是我们自己放进去的）。代价是只能遮本次用过的值：命令若从未接触过
 * 某个凭证却把它打印出来（例如读了一个不在库里的 .env），那不在本模块的职责内。
 */

/** 引用语法：{{sec:名字}} */
const REF_RE = /\{\{sec:([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}/g;

/** 用于扫描文本里有没有引用（不消耗 lastIndex，供每次新调用） */
export function refsIn(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(new RegExp(REF_RE.source, "g"))) names.push(match[1]!);
	return [...new Set(names)];
}

export const refFor = (name: string): string => `{{sec:${name}}}`;

/** 占位文案：形状固定，便于测试与用户识别 */
export const shapePlaceholder = (label: string): string => `«已隐藏:${label}»`;

export interface ExpandResult {
	text: string;
	/** 本次真正展开过的名字（回遮要用它，顺序即首次出现顺序） */
	used: string[];
	/** 引用了但库里没有的名字 */
	missing: string[];
}

/**
 * 展开文本里的引用。缺名字的引用原样保留（让调用方决定是否报错），并记进 missing。
 * 同一次展开内不重复计入 used。
 */
export function expandRefs(text: string, resolve: (name: string) => string | undefined): ExpandResult {
	const used: string[] = [];
	const missing: string[] = [];
	const out = text.replace(new RegExp(REF_RE.source, "g"), (raw: string, name: string) => {
		const value = resolve(name);
		if (value === undefined) {
			if (!missing.includes(name)) missing.push(name);
			return raw;
		}
		if (!used.includes(name)) used.push(name);
		return value;
	});
	return { text: out, used, missing };
}

/**
 * 回遮：把文本里出现的已知值替换成占位符。
 *
 * 按长度降序替换——否则短值先替换会把长值切碎（`abc` 是 `abcdef` 的前缀时，
 * 先换短的会留下 `«已隐藏:x»def`）。
 */
export function maskKnown(text: string, known: { name: string; value: string }[]): { text: string; replaced: string[] } {
	const replaced: string[] = [];
	let out = text;
	const sorted = [...known].filter((entry) => entry.value.length > 0).sort((a, b) => b.value.length - a.value.length);
	for (const entry of sorted) {
		if (!out.includes(entry.value)) continue;
		out = out.split(entry.value).join(shapePlaceholder(entry.name));
		if (!replaced.includes(entry.name)) replaced.push(entry.name);
	}
	return { text: out, replaced };
}
