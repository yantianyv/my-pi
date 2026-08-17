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
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import { createBoxRenderer, editInput, renderScrollingInput } from "./ui";

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
// 已移至 shared/ui.ts（charIndexAtWidth / sliceByWidth 与 renderScrollingInput 聚合），此处不再重复定义

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
		// 编辑键（backspace/left/right/home/end/可打印字符/粘贴）统一走 shared/ui editInput
		const r = editInput(this.query, this.queryCursor, data);
		if (r !== "skip") {
			this.query = r.text;
			this.queryCursor = r.cursor;
			this.applyFilter();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const { row, topBorder, bottomBorder } = createBoxRenderer(th, innerW);
		const lines: string[] = [];

		// 顶部边框 + 标题
		const titleStr = ` ${th.fg("accent", `🔍 ${this.title}`)} `;
		lines.push(topBorder(titleStr));

		// 搜索框：水平滚动窗口跟随光标（❯ 前缀占 4 个显示宽度），不截断内容
		const { display: inputDisplay } = renderScrollingInput(this.query, this.queryCursor, innerW, {
			showCursor: this.focused,
		});
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
		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ---------------------------------------------------------------------------
// 模型配置命令工厂（/btw-config 与 /explore-model 的同构交互收敛于此）
// ---------------------------------------------------------------------------

export interface ModelConfigCommandOptions {
	/** 命令名（如 "btw-config"） */
	command: string;
	/** 命令描述 */
	description: string;
	/** notify 文案中的名称（如 "btw 模型" / "explore 子模型"） */
	displayName: string;
	getSetting: () => string;
	/** 设置并持久化（实现方保证所有设置入口统一走这里） */
	setSetting: (value: string) => void;
	/** 设置值的人话说明（notify 用） */
	settingLabel: (setting: string) => string;
	/** 选择器中 auto / auto-not-free 两个策略项的文案 */
	autoItemLabel: string;
	autoNotFreeItemLabel: string;
}

/**
 * 注册「模型配置命令」：带参数直接设置（auto / auto-not-free / provider/modelId，
 * 未命中时子串匹配给候选），无参数打开可搜索 ModelSelectOverlay。
 * /btw-config 与 /explore-model 原先各自维护约 80 行同构逻辑，现共用本工厂。
 */
export function registerModelConfigCommand(pi: ExtensionAPI, opts: ModelConfigCommandOptions): void {
	pi.registerCommand(opts.command, {
		description: opts.description,
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";
			const usage = `用法：/${opts.command} auto、auto-not-free 或 /${opts.command} provider/modelId`;

			// 带参数：直接设置
			if (arg) {
				if (arg === "auto" || arg === "auto-not-free") {
					opts.setSetting(arg);
					ctx.ui.notify(`${opts.displayName}已设为 ${arg}（${opts.settingLabel(arg)}）`, "info");
					return;
				}
				const m = findConfiguredModel(ctx, arg);
				if (m) {
					opts.setSetting(`${m.provider}/${m.id}`);
					ctx.ui.notify(`${opts.displayName}已设为 ${opts.getSetting()}`, "info");
					return;
				}
				// 未命中：子串匹配到多个时列出部分候选，没有时给用法提示
				const matches = listAvailableModels(ctx).filter((x) =>
					`${x.provider}/${x.id}`.toLowerCase().includes(arg.toLowerCase()),
				);
				ctx.ui.notify(
					matches.length > 0
						? `「${arg}」匹配 ${matches.length} 个模型（${matches
								.slice(0, 3)
								.map((x) => `${x.provider}/${x.id}`)
								.join("、")}${matches.length > 3 ? " 等" : ""}），请用完整 provider/modelId 指定`
						: `未找到「${arg}」。${usage}`,
					"warning",
				);
				return;
			}

			// 无参数：打开可搜索模型选择器（非交互模式只展示当前设置与用法）
			if (!ctx.hasUI) {
				ctx.ui.notify(`当前${opts.displayName}：${opts.getSetting()}。${usage}`, "info");
				return;
			}
			// 列表 = 两个 auto 策略 + 全部已认证可用模型（价格升序）；顶部搜索框实时过滤
			const models = listAvailableModels(ctx);
			const items: ModelSelectItem[] = [
				{ label: opts.autoItemLabel, value: "auto", search: "auto 默认" },
				{ label: opts.autoNotFreeItemLabel, value: "auto-not-free", search: "auto-not-free 忽略免费" },
				...models.map((m) => ({
					label: `${m.provider}/${m.id}（${formatModelPrice(m)} · ctx ${formatContextWindow(m.contextWindow)}）`,
					value: `${m.provider}/${m.id}`,
					search: `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase(),
				})),
			];
			const result = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => new ModelSelectOverlay(tui, theme, items, opts.getSetting(), done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "58%",
						minWidth: 58,
						maxHeight: "90%",
						margin: { right: 1 },
					},
				},
			);
			if (result) {
				opts.setSetting(result);
				ctx.ui.notify(`${opts.displayName}已设为 ${result}（${opts.settingLabel(result)}）`, "info");
			}
		},
	});
}
