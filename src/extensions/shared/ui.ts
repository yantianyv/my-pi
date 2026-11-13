/**
 * 通用 UI 渲染辅助（各 overlay 浮层共用）
 *
 * - renderInputWithCursor：输入框光标反显（CURSOR_MARKER 标记 + 当前字符反白）
 * - charIndexAtWidth / sliceByWidth：输入框水平滚动窗口定位
 * - renderScrollingInput：水平滚动输入框整段渲染；inputOffset 兼容各处输入行宽度差异
 * - createBoxRenderer：浮层边框行渲染原语（╭╮│╰╯ 全封闭行 + 统一 "…" 截断）
 * - editInput / pasteText：输入框编辑键统一（backspace/left/right/home/end/insert/粘贴 +
 *   ctrl+←→ 按词移动、ctrl+w 删词、grapheme 安全步进）
 */
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme, ThemeBg } from "@earendil-works/pi-coding-agent";

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
 * 光标反显。返回 { display: 带光标的窗口文本, cursorInWindow: 窗口内光标索引 }。
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
	/**
	 * 灰字提示行（键位提示、状态反馈）。**用这个而不是自己 push 一行**：
	 * 它在 row() 里包一层，底色与右留白才跟其它行一致——裸文本压进面板会在
	 * 底部露出一条没有底色的横带（「断层」）。
	 */
	hint(text: string): string;
}

/**
 * 浮层统一底色。用 pi 内置主题里已有的 `customMessageBg`（自定义消息块也用它），
 * 不新增主题键：换主题不会出现“少一个键就没底色”。`system` 主题在终端不报底色时
 * 该键为空，`theme.bg` 会原样返回，等同没有底色——不会报错。
 */
export const PANEL_BG: ThemeBg = "customMessageBg";

/**
 * 给整行铺底色并补齐到指定宽度（自绘边框的面板用；`createBoxRenderer` 已内建）。
 * 必须补到满宽：只给文字上底色会让行尾露白，叠在别的输出上反而更乱。
 */
export function paintSurface(
	theme: Theme,
	lines: string[],
	width: number,
	bg: ThemeBg | false = PANEL_BG,
): string[] {
	if (!bg) return lines;
	return lines.map((l) => {
		const body = truncateToWidth(l, width, "…", true);
		return theme.bg(bg, body + " ".repeat(Math.max(0, width - visibleWidth(body))));
	});
}

/**
 * 创建浮层边框渲染器：统一 ╭╮│╰╯ 全封闭单行边框 + "…" 截断；
 * color 可换 borderMuted（workflow-mgr 暗色浮窗用），**底色默认铺满**（传 `bg: false` 关闭）。
 */
export function createBoxRenderer(
	theme: Theme,
	innerW: number,
	opts?: { color?: "border" | "borderMuted"; bg?: ThemeBg | false },
): BoxRenderer {
	const color = opts?.color ?? "border";
	const bg = opts?.bg === undefined ? PANEL_BG : opts.bg;
	// 底色要盖满整行：边框字符与内容都包一层，否则只有文字有底、行尾露白，
	// 重叠时反而更像分区不清。theme.bg 会把 SGR 序列插在文字前后，
	// 所以这里统一在最后对整行再上一次底色。
	const paint = (s: string) => (bg ? theme.bg(bg, s) : s);
	const border = (s: string) => paint(theme.fg(color, s));
	const row = (content: string) => {
		const body = truncateToWidth(content, innerW, "…", true);
		const pad = " ".repeat(Math.max(0, innerW - visibleWidth(body)));
		return border("│") + paint(body + pad) + border("│");
	};
	// 分段上色：theme.fg 结尾会带 [39m 重置前景色，标题里自带的样式会把后面拼在同一
	// 字符串里的横线打回默认色（表现为顶边白、其余边框有色）。每段各自包边框色即可。
	const topBorder = (title?: string) => {
		const t = title ?? "";
		const rest = "─".repeat(Math.max(0, innerW - visibleWidth(t)));
		return border("╭") + (t ? border(t) : "") + border(`${rest}╮`);
	};
	const bottomBorder = () => border(`╰${"─".repeat(innerW)}╯`);
	const divider = () => border(`├${"─".repeat(innerW)}┤`);
	const hint = (text: string) => row(keyHintRow(theme, text));
	return { border, row, topBorder, bottomBorder, divider, hint };
}

// ---------------------------------------------------------------------------
// 输入框编辑键统一
// ---------------------------------------------------------------------------

/** 终端粘贴（bracketed paste `\x1b[200~…\x1b[201~` / 多字符文本）→ 规范化文本；非粘贴返回 null。
 *  换行压成空格（输入框单行语义）。 */
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
 * ctrl+left·ctrl+right（按词移动）/ ctrl+w·alt+backspace（删前一个词）/ 可打印字符插入 / 粘贴。
 * 光标移动按 grapheme 步进（emoji、组合符、ZWJ 序列不会被拆成半个），
 * 故左/右键一次跨过一个用户感知字符而不是一个 UTF-16 码元。
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
			const at = prevGraphemeStart(text, cursor);
			return { text: text.slice(0, at) + text.slice(cursor), cursor: at };
		}
		return { text, cursor };
	}
	if (matchesKey(data, "delete")) {
		if (cursor < text.length) {
			const at = nextGraphemeEnd(text, cursor);
			return { text: text.slice(0, cursor) + text.slice(at), cursor };
		}
		return { text, cursor };
	}
	if (matchesKey(data, Key.ctrl("u"))) {
		return { text: "", cursor: 0 };
	}
	// 按词移动 / 删词（多行简答长文本里按词跳比逐字挪快得多）
	if (matchesKey(data, "ctrl+left")) {
		return { text, cursor: prevWordStart(text, cursor) };
	}
	if (matchesKey(data, "ctrl+right")) {
		return { text, cursor: nextWordEnd(text, cursor) };
	}
	if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
		if (cursor > 0) {
			const at = prevWordStart(text, cursor);
			return { text: text.slice(0, at) + text.slice(cursor), cursor: at };
		}
		return { text, cursor };
	}
	if (matchesKey(data, "left")) {
		return { text, cursor: prevGraphemeStart(text, cursor) };
	}
	if (matchesKey(data, "right")) {
		return { text, cursor: nextGraphemeEnd(text, cursor) };
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

// ---------------------------------------------------------------------------
// grapheme / 词边界步进（编辑键共用）
// ---------------------------------------------------------------------------

/** Intl.Segmenter（Node 16+ 全局可用）；不可用时退化为代理对启发式 */
const SEGMENTER: Intl.Segmenter | null =
	typeof Intl !== "undefined" && typeof (Intl as { Segmenter?: unknown }).Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

/** 光标左侧一个 grapheme 的起始索引（emoji / 组合符 / ZWJ 序列整体跨过） */
function prevGraphemeStart(text: string, cursor: number): number {
	if (cursor <= 0) return 0;
	if (!SEGMENTER) {
		const c = text.charCodeAt(cursor - 1);
		return c >= 0xdc00 && c <= 0xdfff && cursor >= 2 ? cursor - 2 : cursor - 1;
	}
	const from = Math.max(0, cursor - 64); // 只需回看一小段，避免长文本每键全量分词
	let last = from;
	for (const seg of SEGMENTER.segment(text.slice(from, cursor))) last = from + seg.index;
	return last;
}

/** 光标右侧一个 grapheme 的结束索引 */
function nextGraphemeEnd(text: string, cursor: number): number {
	if (cursor >= text.length) return text.length;
	if (!SEGMENTER) {
		const c = text.charCodeAt(cursor);
		return c >= 0xd800 && c <= 0xdbff ? cursor + 2 : cursor + 1;
	}
	const to = Math.min(text.length, cursor + 64);
	for (const seg of SEGMENTER.segment(text.slice(cursor, to))) return cursor + seg.index + seg.segment.length;
	return to;
}

/** 词字符判定（字母/数字/下划线；含 CJK——中文按整段连续汉字当一个词） */
function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch);
}

/** 光标前一个词的起点（先跳过空白/标点，再跳过词） */
function prevWordStart(text: string, cursor: number): number {
	let p = cursor;
	while (p > 0 && !isWordChar(text[p - 1]!)) p--;
	while (p > 0 && isWordChar(text[p - 1]!)) p--;
	return p;
}

/** 光标后一个词的终点 */
function nextWordEnd(text: string, cursor: number): number {
	let p = cursor;
	while (p < text.length && !isWordChar(text[p]!)) p++;
	while (p < text.length && isWordChar(text[p]!)) p++;
	return p;
}

/** 选项列表项（label 之外都可选） */
export interface ChoiceItem {
	label: string;
	/** 尾部灰字括注（说明 / 将被记住的意图） */
	note?: string;
	/** label 前图标（如 📝） */
	icon?: string;
	/** 显式序号前缀（需要非 1 起序号时给，如「3.」） */
	index?: string;
}

export interface ChoiceStyle {
	/** 选中行文字加粗（默认 true） */
	boldSelected?: boolean;
	/** 自动显示 1 起序号（item.index 优先） */
	numbers?: boolean;
	/** 每项状态标记（单选 ●/○、多选 [x]/[ ]）——焦点(›)与已选是两件事，标记对所有行都画 */
	mark?: (i: number) => string;
	/** 括注样式：paren 全角括号（默认）/ dash 破折号 */
	noteFormat?: "paren" | "dash";
	/** 传宽度即折行，续行缩进对齐到项首 */
	width?: number;
}

/**
 * 选项列表竖排渲染（浮层共用一套样式）：选中行 accent + 「› 」，括注灰字。
 * 覆盖单选/多选标记、序号、图标、括注样式、折行；键位提示与分页由调用方处理。
 */
export function renderChoiceList(th: Theme, items: ChoiceItem[], selected: number, style: ChoiceStyle = {}): string[] {
	const { boldSelected = true, numbers = false, mark, noteFormat = "paren", width } = style;
	const out: string[] = [];
	items.forEach((it, i) => {
		const focused = i === selected;
		const numText = it.index ?? (numbers ? `${i + 1}.` : "");
		const prefix =
			(focused ? th.fg("accent", " › ") : "   ") +
			(numText ? `${th.fg("dim", numText)} ` : "") +
			(mark ? `${mark(i)} ` : "") +
			(it.icon ? `${it.icon} ` : "");
		const label = focused ? th.fg("accent", boldSelected ? th.bold(it.label) : it.label) : it.label;
		const note = it.note ? th.fg("dim", noteFormat === "dash" ? ` — ${it.note}` : `（${it.note}）`) : "";
		const body = `${label}${note}`;
		if (!width) {
			out.push(prefix + body);
			return;
		}
		const indent = visibleWidth(prefix);
		wrapTextWithAnsi(body, Math.max(8, width - indent)).forEach((p, k) =>
			out.push(k === 0 ? prefix + p : " ".repeat(indent) + p),
		);
	});
	return out;
}

/** 评分行（‹ ●●○○○ 3/5 ›；焦点行尾附键位提示） */
export function ratingIndicator(th: Theme, min: number, max: number, value: number | undefined, focused: boolean): string {
	const filled = value === undefined ? 0 : value - min + 1;
	const dots = Array.from({ length: max - min + 1 }, (_, k) => (k < filled ? "●" : "○")).join(" ");
	const prefix = focused ? th.fg("accent", " › ") : "   ";
	return (
		`${prefix} ${th.fg("dim", "‹")} ${dots} ${value ?? "–"}/${max} ${th.fg("dim", "›")}` +
		(focused ? th.fg("dim", `   ←→ 调整 · 数字直选 ${min}-${max}`) : "")
	);
}

/** 正文区滚动提示行：嵌在分隔线里的 ▲/▼ 余量说明（面板滚动窗共用；宽度走 visibleWidth，中文算 2 列） */
export function dividerScrollNote(th: Theme, border: (s: string) => string, innerW: number, above: number, below: number): string {
	// 横线用与其它分隔行一致的制表符，破折号「—」在这里既窄又不同色，看起来像另一条线
	// 宽度口径与 createBoxRenderer 的分隔行一致：两端边框各占 1 列，横线补满 innerW
	if (above <= 0 && below <= 0) return border(`├${"─".repeat(Math.max(0, innerW))}┤`);
	const label = above > 0 && below > 0 ? ` ▲${above} ▼${below}（PgUp/PgDn） ` : above > 0 ? ` ▲${above}（PgUp） ` : ` ▼${below}（PgDn） `;
	// 同 topBorder：label 自带 dim 样式并以 [39m 收尾，横线必须单独上边框色
	return border("├") + th.fg("dim", label) + border(`${"─".repeat(Math.max(0, innerW - visibleWidth(label)))}┤`);
}

/**
 * 底部键位提示行（整行 dim；文案由各面板给，避免把业务文案固化进公共层）。
 * 单独用它只是一行裸文本——**面板里请用 `createBoxRenderer(...).hint(text)`**，
 * 那条路径才会铺底、补满宽度并带边框；这里保留导出只为已有调用方与测试。
 */
export function keyHintRow(th: Theme, text: string): string {
	return th.fg("dim", ` ${text}`);
}

/** 按显示宽度折行并统一左缩进（面板正文/表头共用） */
export function wrapIndented(text: string, width: number, indent = 1): string[] {
	const out: string[] = [];
	for (const w of wrapTextWithAnsi(text, Math.max(8, width - indent))) out.push(`${" ".repeat(indent)}${w}`);
	return out;
}

/** 滚动窗位置：夹到 [0, 行数-窗口高]；scrollByPage 按整页移动（面板共用一套） */
export function clampScroll(scroll: number, lineCount: number, budget: number): number {
	return Math.max(0, Math.min(Math.max(0, scroll), Math.max(0, lineCount - budget)));
}

export function scrollByPage(scroll: number, dir: -1 | 1, lineCount: number, budget: number): number {
	return clampScroll(scroll + dir * budget, lineCount, budget);
}

/** 选项面板按键语义（Esc/↑↓/Enter/1-9 + PgUp/PgDn 翻页）：只解析意图，业务回调由调用方处理 */
export type ChoiceKeyResult =
	/** dir 是按键方向：调用方靠它区分「顶到头」是往上还是往下（边的意义不一样） */
	| { kind: "move"; index: number; dir: -1 | 1 }
	| { kind: "select"; index: number }
	| { kind: "cancel" }
	| { kind: "page"; dir: -1 | 1 }
	| { kind: "skip" };

export function choiceKey(data: string, index: number, count: number): ChoiceKeyResult {
	if (matchesKey(data, Key.escape)) return { kind: "cancel" };
	if (matchesKey(data, Key.up)) return { kind: "move", index: Math.max(0, index - 1), dir: -1 };
	if (matchesKey(data, Key.down)) return { kind: "move", index: Math.min(count - 1, index + 1), dir: 1 };
	if (matchesKey(data, Key.pageUp)) return { kind: "page", dir: -1 };
	if (matchesKey(data, Key.pageDown)) return { kind: "page", dir: 1 };
	if (matchesKey(data, Key.enter)) return { kind: "select", index: Math.min(Math.max(0, index), count - 1) };
	if (/^[1-9]$/.test(data)) {
		const i = Number(data) - 1;
		if (i < count) return { kind: "select", index: i };
	}
	return { kind: "skip" };
}

// ---------------------------------------------------------------------------
// 数字格式化
// ---------------------------------------------------------------------------

/**
 * 积分/额度数字：最多两位小数，去掉无意义的尾零（1124.00 → 1124，1.500 → 1.5）。
 * 不缩写（不换算 k/m），余额这类数字要能直接对账。
 */
export function fmtAmount(n: number): string {
	const fixed = n.toFixed(2);
	const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
	return trimmed === "-0" ? "0" : trimmed;
}
