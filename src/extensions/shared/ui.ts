/**
 * 通用 UI 渲染辅助（各 overlay 浮层共用）
 *
 * - renderInputWithCursor：输入框光标反显（最初在 btw 与 shared/model-select.ts 中
 *   逐字重复，抽取至此）
 * - charIndexAtWidth / sliceByWidth：输入框水平滚动窗口定位（原在 shared/model-select.ts，
 *   与 web-tool/panel.ts 的本地实现逐字重复，聚合到输入框工具族）
 * - renderScrollingInput：水平滚动输入框整段渲染（ModelSelectOverlay / ProxyConfigOverlay /
 *   BtwOverlay 三处逐字重复，抽取统一；inputOffset 兼容各处输入行宽度差异）
 * - createBoxRenderer：浮层边框行渲染原语（╭╮│╰╯ 全封闭行 + 统一 "…" 截断），
 *   统一 ModelSelect / ProxyConfig / Btw 的单行边框风格，弃 webdav 系列的无右边界、
 *   Btw 的 "..." 三连点等分散实现
 * - editInput / pasteText：输入框编辑键统一（backspace/left/right/home/end/插入/粘贴），
 *   吸收 KbOverlay 的 bracketed paste 精华，弃 5 处逐字重复的手感不一实现
 */
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

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

// ---------------------------------------------------------------------------
// 浮层边框渲染原语
// ---------------------------------------------------------------------------

export interface BoxRenderer {
	/** 边角字符（╭/╮/╰/╯/│/├/┤）统一上色 */
	border(s: string): string;
	/** 单行内容（全封闭：`│内容│`，超出以 "…" 截断） */
	row(content: string): string;
	/** 顶部边框（可嵌标题，标题宽度按可见宽度计算） */
	topBorder(title?: string): string;
	/** 底部边框 */
	bottomBorder(): string;
	/** 分隔行（├──┤） */
	divider(): string;
}

/**
 * 创建浮层边框渲染器：统一 ╭╮│╰╯ 单行边框 + "…" 截断。
 * 此前 ModelSelect / ProxyConfig / Btw 各自手写 border/row（截断字符 "…" 与 "..." 不一），
 * webdav 系列甚至无右边界（`│内容` 不闭合）——统一为全封闭 + 单 "…"；
 * color 可换 borderMuted（workflow-mgr 暗色浮窗用）。
 */
export function createBoxRenderer(
	theme: Theme,
	innerW: number,
	opts?: { color?: "border" | "borderMuted" },
): BoxRenderer {
	const color = opts?.color ?? "border";
	const border = (s: string) => theme.fg(color, s);
	const row = (content: string) => border("│") + truncateToWidth(content, innerW, "…", true) + border("│");
	const topBorder = (title?: string) => {
		const t = title ?? "";
		return border(`╭${t}${"─".repeat(Math.max(0, innerW - visibleWidth(t)))}╮`);
	};
	const bottomBorder = () => border(`╰${"─".repeat(innerW)}╯`);
	const divider = () => border(`├${"─".repeat(innerW)}┤`);
	return { border, row, topBorder, bottomBorder, divider };
}

// ---------------------------------------------------------------------------
// 输入框编辑键统一
// ---------------------------------------------------------------------------

/** 终端粘贴（bracketed paste `\x1b[200~…\x1b[201~` / 多字符文本）→ 规范化文本；非粘贴返回 null。
 *  换行压成空格（输入框单行语义）。吸自 KbOverlay 的粘贴处理（原为全库唯一实现）。 */
export function pasteText(data: string): string | null {
	const isPaste = data.includes("\x1b[200~") || (data.length > 1 && !data.startsWith("\x1b"));
	if (!isPaste) return null;
	const text = data
		.replace(/\x1b\[200~/g, "")
		.replace(/\x1b\[201~/g, "")
		.replace(/\r\n?/g, " ")
		.replace(/\n/g, " ");
	return text || null;
}

export type EditInputResult = { text: string; cursor: number } | "skip";

/**
 * 统一输入框编辑键处理：backspace / left / right / home / end / delete（光标处删）/ ctrl+u（清空）/
 * 可打印字符插入 / 粘贴。
 * 命中编辑键返回新的 { text, cursor }（backspace 在光标 0 时也返回原值，表示「已消费」）；
 * 非编辑键（escape/enter/tab/↑↓ 等）返回 "skip"，由调用方继续处理特异键。
 */
export function editInput(
	text: string,
	cursor: number,
	data: string,
	opts?: { maxLength?: number },
): EditInputResult {
	// 粘贴（多字符整体插入；emoji 等 surrogate pair 也走这里，避免半码插入）
	const pasted = pasteText(data);
	if (pasted != null) {
		return { text: text.slice(0, cursor) + pasted + text.slice(cursor), cursor: cursor + pasted.length };
	}
	if (matchesKey(data, "backspace")) {
		if (cursor > 0) {
			return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
		}
		return { text, cursor };
	}
	if (matchesKey(data, "delete")) {
		if (cursor < text.length) {
			return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
		}
		return { text, cursor };
	}
	if (matchesKey(data, Key.ctrl("u"))) {
		return { text: "", cursor: 0 };
	}
	if (matchesKey(data, "left")) {
		return { text, cursor: Math.max(0, cursor - 1) };
	}
	if (matchesKey(data, "right")) {
		return { text, cursor: Math.min(text.length, cursor + 1) };
	}
	if (matchesKey(data, "home")) {
		return { text, cursor: 0 };
	}
	if (matchesKey(data, "end")) {
		return { text, cursor: text.length };
	}
	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		if (opts?.maxLength != null && text.length >= opts.maxLength) return { text, cursor };
		return { text: text.slice(0, cursor) + data + text.slice(cursor), cursor: cursor + 1 };
	}
	return "skip";
}
