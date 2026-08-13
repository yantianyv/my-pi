/**
 * 通用 UI 渲染辅助（各 overlay 浮层共用）
 *
 * - renderInputWithCursor：输入框光标反显（最初在 btw 与 shared/model-select.ts 中
 *   逐字重复（`${before}${CURSOR_MARKER}\x1b[7m${cursorChar}\x1b[27m${after}`），抽取至此）
 * - charIndexAtWidth / sliceByWidth：输入框水平滚动窗口定位（原在 shared/model-select.ts，
 *   与 web-tool/panel.ts 的本地实现逐字重复，聚合到输入框工具族）
 * - renderScrollingInput：水平滚动输入框整段渲染（ModelSelectOverlay / ProxyConfigOverlay /
 *   BtwOverlay 三处逐字重复，抽取统一；inputOffset 兼容各处输入行宽度差异）
 */
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

/** 在输入框可见窗口文本上叠加反显光标：CURSOR_MARKER 标记 + 当前字符反白 */
export function renderInputWithCursor(inputDisplay: string, cursorInWindow: number): string {
	const before = inputDisplay.slice(0, cursorInWindow);
	const cursorChar = cursorInWindow < inputDisplay.length ? inputDisplay[cursorInWindow] : " ";
	const after = inputDisplay.slice(cursorInWindow + 1);
	return `${before}${CURSOR_MARKER}\x1b[7m${cursorChar}\x1b[27m${after}`;
}

/** 返回文本显示宽度达到 targetW 时的字符索引（供输入框水平滚动窗口定位） */
export function charIndexAtWidth(text: string, targetW: number): number {
	let w = 0;
	for (let i = 0; i < text.length; i++) {
		const chW = visibleWidth(text[i]!);
		if (w + chW > targetW) return i;
		w += chW;
	}
	return text.length;
}

/** 从 startChar 起按显示宽度截取最多 maxW 宽的文本（不截断字符） */
export function sliceByWidth(text: string, startChar: number, maxW: number): string {
	let out = "";
	let w = 0;
	for (let i = startChar; i < text.length; i++) {
		const chW = visibleWidth(text[i]!);
		if (w + chW > maxW) break;
		out += text[i];
		w += chW;
	}
	return out;
}

/**
 * 水平滚动输入框整段渲染：计算滚动窗口起点（光标前留 60% 宽度）+ 窗口内光标位置 +
 * 光标反显。ModelSelectOverlay / ProxyConfigOverlay / BtwOverlay 三处此前逐字重复，
 * 抽取统一。返回 { display: 带光标的窗口文本, cursorInWindow: 窗口内光标索引 }。
 */
export function renderScrollingInput(
	text: string,
	cursor: number,
	innerW: number,
	opts?: { inputOffset?: number; showCursor?: boolean },
): { display: string; cursorInWindow: number } {
	const inputW = Math.max(8, innerW - (opts?.inputOffset ?? 3));
	const totalW = visibleWidth(text);
	let startChar = 0;
	if (totalW > inputW) {
		const cursorW = visibleWidth(text.slice(0, cursor));
		startChar = charIndexAtWidth(text, Math.max(0, cursorW - Math.floor(inputW * 0.6)));
	}
	const windowText = sliceByWidth(text, startChar, inputW);
	const cursorInWindow = Math.min(Math.max(0, cursor - startChar), windowText.length);
	const display = opts?.showCursor === false ? windowText : renderInputWithCursor(windowText, cursorInWindow);
	return { display, cursorInWindow };
}
