/**
 * shared/model-select: 可搜索模型选择器 + 模型工具函数（btw / explore 等扩展共用）
 *
 * 在源码层被多个扩展 import 复用；build.js 伪编译时内联进各扩展产物，
 * 产物保持零耦合单文件（不依赖本模块的运行时存在）。
 *
 * 提供：
 * - ModelSelectOverlay：可搜索模型选择浮层（顶部搜索框实时过滤、↑↓ 选择、
 *   Enter 确认、Esc 取消、当前项 ✓ 标记），经 ctx.ui.custom 挂载；
 * - listAvailableModels / findConfiguredModel / modelTotalCost 等：按价格排序、
 *   查找已认证模型（负数价格=动态定价，视为价格未知排最后）；
 * - formatModelPrice / formatContextWindow / modelSettingLabel：展示文案。
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { renderInputWithCursor } from "./ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModel = Model<any>;

/**
 * 模型单价合计（input + output，$/M tokens）；动态定价模型用负数标记
 * （如 openrouter/auto 为 -1000000），视为价格未知排到最后，避免 auto 误选。
 */
export function modelTotalCost(m: AnyModel): number {
	const c = m.cost;
	if (!c) return Infinity;
	const { input = 0, output = 0 } = c;
	if (input < 0 || output < 0) return Infinity;
	return input + output;
}

/** 可用（已认证）模型按价格升序排列，同价按 id 字典序保证列表稳定；excludeFree 时忽略价格 ≤ 0 的免费模型 */
export function listAvailableModels(
	ctx: ExtensionContext,
	opts?: { excludeFree?: boolean },
): AnyModel[] {
	const reg = ctx.modelRegistry;
	return reg
		.getAvailable()
		.filter((m) => reg.hasConfiguredAuth(m))
		.filter((m) => !opts?.excludeFree || modelTotalCost(m) > 0)
		.sort((a, b) => modelTotalCost(a) - modelTotalCost(b) || a.id.localeCompare(b.id));
}

/** 模型价格展示文本：`$0.14/$0.28 per M`（input/output，单位美元每百万 token）；负数价格（动态定价）标「动态定价」 */
export function formatModelPrice(m: AnyModel): string {
	const c = m.cost;
	if (!c) return "价格未知";
	if (c.input < 0 || c.output < 0) return "动态定价";
	return `$${c.input}/${c.output} per M`;
}

/** 上下文窗口可读化：1048576 → 1M、262144 → 256K */
export function formatContextWindow(n: number | undefined): string {
	if (!n || n <= 0) return "?";
	if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
	return String(n);
}

/** 模型设置的人话说明（notify 文案用）：auto / auto-not-free 给策略描述（可自定义），固定模型给 provider/id */
export function modelSettingLabel(
	setting: string,
	opts?: { auto?: string; autoNotFree?: string },
): string {
	if (setting === "auto") return opts?.auto ?? "自动选择（最便宜可用模型）";
	if (setting === "auto-not-free") return opts?.autoNotFree ?? "忽略免费模型，最便宜的非免费模型";
	return setting;
}

/**
 * 按设置串查找已认证模型：含 '/' 视为精确 provider/modelId；否则按模型 id
 * 子串匹配（不区分大小写，唯一命中才返回，多命中由调用方列出候选）
 */
export function findConfiguredModel(ctx: ExtensionContext, setting: string): AnyModel | undefined {
	const reg = ctx.modelRegistry;
	if (setting.includes("/")) {
		const [provider, id] = setting.split("/", 2);
		const m = reg.find(provider.trim(), id?.trim() ?? "");
		return m && reg.hasConfiguredAuth(m) ? m : undefined;
	}
	const matches = listAvailableModels(ctx).filter((m) => m.id.toLowerCase().includes(setting.toLowerCase()));
	return matches.length === 1 ? matches[0] : undefined;
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

export interface ModelSelectItem {
	/** 显示文本（纯文本，无 ANSI） */
	label: string;
	/** 选择后写入模型设置的值：'auto' | 'auto-not-free' | 'provider/modelId' */
	value: string;
	/** 搜索用归一化文本（小写），命中 provider / id / 显示名任意部分即可 */
	search: string;
}

/**
 * 可搜索模型选择器：顶部搜索框实时过滤（打字即搜），下方列表展示全部可选模型，
 * ↑↓ 移动选择、Enter 确认、Esc 取消。输入框聚焦态直接接收字符（无需先按 Enter）。
 */
export class ModelSelectOverlay {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private done: (result: string | null) => void;
	private items: ModelSelectItem[];
	/** 当前生效设置（列表里带 ✓ 标记） */
	private current: string;
	/** 浮层标题（调用方自定义，如「选择 btw 模型」） */
	private title: string;

	private query = "";
	private queryCursor = 0;
	private filtered: ModelSelectItem[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		items: ModelSelectItem[],
		current: string,
		done: (result: string | null) => void,
		opts?: { title?: string },
	) {
		this.tui = tui;
		this.theme = theme;
		this.items = items;
		this.current = current;
		this.done = done;
		this.title = opts?.title ?? "选择模型";
		// 初始定位到当前设置项（找不到则第一项）
		const idx = items.findIndex((it) => it.value === current);
		this.selectedIndex = idx >= 0 ? idx : 0;
		this.applyFilter();
		this.clampScroll();
	}

	/** 重新过滤并钳制选中项 */
	private applyFilter(): void {
		const q = this.query.trim().toLowerCase();
		this.filtered = q ? this.items.filter((it) => it.search.includes(q)) : this.items;
		if (this.selectedIndex >= this.filtered.length) {
			this.selectedIndex = Math.max(0, this.filtered.length - 1);
		}
		this.tui.requestRender();
	}

	/** 列表可见行数（按终端高度自适应） */
	private getListRows(): number {
		const termRows = this.tui.terminal.rows;
		if (!termRows || termRows <= 0) return 20;
		return Math.max(6, Math.min(24, Math.floor(termRows * 0.6)));
	}

	/** 滚动窗口跟随选中项：上超窗顶对齐，下超窗底留一行 */
	private clampScroll(): void {
		const rows = this.getListRows();
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + rows - 1) {
			this.scrollOffset = this.selectedIndex - rows + 2;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "return")) {
			const item = this.filtered[this.selectedIndex];
			if (item) this.done(item.value);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.queryCursor > 0) {
				this.query = this.query.slice(0, this.queryCursor - 1) + this.query.slice(this.queryCursor);
				this.queryCursor--;
				this.applyFilter();
			}
			return;
		}
		if (matchesKey(data, "left")) {
			this.queryCursor = Math.max(0, this.queryCursor - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.queryCursor = Math.min(this.query.length, this.queryCursor + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.clampScroll();
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.selectedIndex < this.filtered.length - 1) {
				this.selectedIndex++;
				this.clampScroll();
				this.tui.requestRender();
			}
			return;
		}
		// 可打印字符：插入搜索词并实时过滤
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query = this.query.slice(0, this.queryCursor) + data + this.query.slice(this.queryCursor);
			this.queryCursor++;
			this.applyFilter();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const border = (s: string) => th.fg("border", s);
		const row = (content: string) => border("│") + truncateToWidth(content, innerW, "…", true) + border("│");
		const lines: string[] = [];

		// 顶部边框 + 标题
		const titleStr = ` ${th.fg("accent", `🔍 ${this.title}`)} `;
		lines.push(border(`╭${titleStr}${"─".repeat(Math.max(0, innerW - visibleWidth(titleStr)))}╮`));

		// 搜索框：水平滚动窗口跟随光标（❯ 前缀占 4 个显示宽度），不截断内容
		const inputW = Math.max(8, innerW - 3);
		const full = this.query;
		const totalW = visibleWidth(full);
		let startChar = 0;
		if (totalW > inputW) {
			const cursorW = visibleWidth(full.slice(0, this.queryCursor));
			startChar = charIndexAtWidth(full, Math.max(0, cursorW - Math.floor(inputW * 0.6)));
		}
		const windowText = sliceByWidth(full, startChar, inputW);
		const cursorInWindow = Math.min(Math.max(0, this.queryCursor - startChar), windowText.length);
		let inputDisplay = windowText;
		if (this.focused) {
			inputDisplay = renderInputWithCursor(inputDisplay, cursorInWindow);
		}
		lines.push(row(` ${th.fg("accent", "❯")} ${inputDisplay}`));

		// 列表：滚动窗口 + 当前项 ✓ 标记 + 选中项反显
		const listRows = this.getListRows();
		this.clampScroll();
		const visible = this.filtered.slice(this.scrollOffset, this.scrollOffset + listRows);
		for (let i = 0; i < visible.length; i++) {
			const item = visible[i]!;
			const isCurrent = item.value === this.current;
			const isSelected = this.scrollOffset + i === this.selectedIndex;
			let text = `${isCurrent ? "✓ " : "  "}${item.label}`;
			if (isSelected) text = `\x1b[7m${text}\x1b[27m`;
			lines.push(row(` ${text}`));
		}
		for (let i = visible.length; i < listRows; i++) lines.push(row(""));

		// 状态行：选中项在列表里已反显 + ✓ 标记当前设置，这里只提示数量与操作
		const currentItem = this.filtered[this.selectedIndex];
		const status = currentItem ? `${this.filtered.length} 个匹配` : "无匹配（Esc 取消）";
		lines.push(row(th.fg("dim", `${status} · ↑↓ 选择 · Enter 确认 · Esc 取消`)));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
