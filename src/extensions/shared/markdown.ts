/**
 * shared/markdown：回答/长文本的 markdown 渲染（共用模块）
 *
 * 渲染本身交给 pi-tui 的 Markdown 组件（与主会话、子代理面板同一套实现）：
 * 标题去 `#` 前缀、行内样式在折行前解析（粗体/行内代码跨行不裂开）、表格按列宽换行而不截断、
 * 代码块带高亮边框、列表续行缩进对齐。样式取自调用方传入的 theme，与面板配色一致。
 *
 * 本模块只做两件事：把 theme 映射成 MarkdownTheme（按 theme 缓存）；把渲染结果套上一层缩进
 * （btw 面板两空格；ask 说明块传空串，自行拼「│ 」左边线）。首尾空行会被去掉。
 *
 * 本模块不注册任何 pi API，仅导出纯函数；btw/render.ts 保留同名转发。
 */
import { Markdown, visibleWidth, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** 按显示宽度折行（词内不断行；中文按字断，行内样式带 ANSI 也安全） */
export function wrapText(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, width));
}

/** theme → MarkdownTheme：按 theme 实例缓存（每次渲染重建会让 Markdown 组件的缓存失效） */
const mdThemes = new WeakMap<Theme, MarkdownTheme>();
function markdownTheme(th: Theme): MarkdownTheme {
	const cached = mdThemes.get(th);
	if (cached) return cached;
	const theme: MarkdownTheme = {
		heading: (s) => th.fg("mdHeading", th.bold(s)),
		link: (s) => th.fg("mdLink", s),
		linkUrl: (s) => th.fg("mdLinkUrl", s),
		code: (s) => th.fg("mdCode", s),
		codeBlock: (s) => th.fg("mdCodeBlock", s),
		codeBlockBorder: (s) => th.fg("mdCodeBlockBorder", s),
		quote: (s) => th.fg("mdQuote", s),
		quoteBorder: (s) => th.fg("mdQuoteBorder", s),
		hr: (s) => th.fg("mdHr", s),
		listBullet: (s) => th.fg("mdListBullet", s),
		bold: (s) => th.bold(s),
		italic: (s) => th.italic(s),
		underline: (s) => th.underline(s),
		strikethrough: (s) => th.strikethrough(s),
	};
	mdThemes.set(th, theme);
	return theme;
}

/** 渲染缓存：面板每帧重渲染同一段文本时省去重新解析（流式时只有末段变化，历史段命中）；
 *  按 theme 实例分桶——换主题时旧配色不会残留。 */
const CACHE_LIMIT = 24;
const renderCaches = new WeakMap<Theme, Map<string, string[]>>();
function cachedRender(th: Theme, key: string, build: () => string[]): string[] {
	let cache = renderCaches.get(th);
	if (!cache) {
		cache = new Map();
		renderCaches.set(th, cache);
	}
	const hit = cache.get(key);
	if (hit) return hit;
	const lines = build();
	if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
	cache.set(key, lines);
	return lines;
}

/**
 * 渲染一段 markdown 为终端行，每行前缀 `opts.indent`（默认两空格）。
 * 空文本返回空数组（调用方不必再判空）。
 */
export function renderAnswer(
	text: string,
	th: Theme,
	contentWidth: number,
	opts?: { indent?: string },
): string[] {
	if (!text.trim()) return [];
	const indent = opts?.indent ?? "  ";
	const width = Math.max(8, contentWidth - visibleWidth(indent));

	return cachedRender(th, `${width}\u0000${indent}\u0000${text}`, () => {
		const lines: string[] = [];
		for (const raw of new Markdown(text, 0, 0, markdownTheme(th)).render(width)) {
			const body = raw.replace(/\s+$/, "");
			// 组件会为块间留空行，首尾的空行在面板里只是白占高度
			if (!body && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
			lines.push(body ? `${indent}${body}` : "");
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines;
	});
}
