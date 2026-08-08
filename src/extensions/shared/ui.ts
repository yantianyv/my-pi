/**
 * 通用 UI 渲染辅助（各 overlay 浮层共用）
 *
 * 目前只有一个：输入框光标反显渲染。最初在 btw.ts 与 shared/model-select.ts 中
 * 逐字重复（`${before}${CURSOR_MARKER}\x1b[7m${cursorChar}\x1b[27m${after}`），
 * 抽取至此统一实现。
 */
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

/** 在输入框可见窗口文本上叠加反显光标：CURSOR_MARKER 标记 + 当前字符反白 */
export function renderInputWithCursor(inputDisplay: string, cursorInWindow: number): string {
	const before = inputDisplay.slice(0, cursorInWindow);
	const cursorChar = cursorInWindow < inputDisplay.length ? inputDisplay[cursorInWindow] : " ";
	const after = inputDisplay.slice(cursorInWindow + 1);
	return `${before}${CURSOR_MARKER}\x1b[7m${cursorChar}\x1b[27m${after}`;
}
