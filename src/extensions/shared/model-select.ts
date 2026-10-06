/**
 * shared/model-select: 可搜索模型选择浮层 + 插件侧模型设置命令工厂
 *
 * 在源码层被多个扩展 import 复用；build.js 伪编译时内联进各扩展产物，
 * 产物保持零耦合单文件（不依赖本模块的运行时存在）。
 *
 * 词汇（与 shared/model-setting 一致）：插件侧设置只有 `auto`（交给 model-config 管理）
 * 与 `provider/modelId`（本地固定）两种取值；策略槽（MAX/FAST/LITE/BASE/BATCH）与
 * AUTO/FREE 只在管理侧 model-config 里选择，因此本模块列表里不出现策略。
 *
 * 纯查询工具（listAvailableModels / findConfiguredModel / formatModelPrice 等）在
 * shared/model-util，这里转出以便调用方只 import 一处。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import { createBoxRenderer, editInput, renderScrollingInput } from "./ui";
import { LOCAL_AUTO, type ModelSetting } from "./model-setting";
import {
	findConfiguredModel,
	formatContextWindow,
	formatModelPrice,
	listAvailableModels,
	modelHasVision,
	modelTotalCost,
	type AnyModel,
} from "./model-util";

export {
	findConfiguredModel,
	formatContextWindow,
	formatModelPrice,
	listAvailableModels,
	modelHasVision,
	modelRef,
	modelTotalCost,
	type AnyModel,
} from "./model-util";

/** 选择器列表里的 auto 项文案（含义：交给 model-config 按用途设置解析） */
export const AUTO_ITEM_LABEL = "auto（由 model-config 管理）";

export interface ModelSelectItem {
	/** 显示文本（纯文本，无 ANSI） */
	label: string;
	/** 选择后写入模型设置的值：'auto' | 'provider/modelId' */
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

	/** 当前过滤结果（供宿组件复用列表状态） */
	getFiltered(): ModelSelectItem[] {
		return this.filtered;
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
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
// 插件侧选择器（auto + 已认证模型）
// ---------------------------------------------------------------------------

/**
 * 构造插件侧选择项：auto 项 + 全部已认证可用模型（价格升序）。
 * requiresVision 时只列有读图能力的模型（用途声明了读图要求）。
 */
export function buildLocalModelItems(ctx: ExtensionContext, opts?: { requiresVision?: boolean }): ModelSelectItem[] {
	const items: ModelSelectItem[] = [
		{ label: AUTO_ITEM_LABEL, value: LOCAL_AUTO, search: "auto 交给 model-config 管理" },
	];
	for (const m of listAvailableModels(ctx)) {
		if (opts?.requiresVision && !modelHasVision(m)) continue;
		items.push({
			label: `${m.provider}/${m.id}（${formatModelPrice(m)} · ctx ${formatContextWindow(m.contextWindow)}）`,
			value: `${m.provider}/${m.id}`,
			search: `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase(),
		});
	}
	return items;
}

/** 打开插件侧模型选择浮层：返回 `auto` / `provider/modelId`，Esc 取消返回 null。 */
export async function openLocalModelPicker(
	ctx: ExtensionContext,
	opts: { current: string; title: string; requiresVision?: boolean },
): Promise<string | null> {
	const items = buildLocalModelItems(ctx, { requiresVision: opts.requiresVision });
	return ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => new ModelSelectOverlay(tui, theme, items, opts.current, done, { title: opts.title }),
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
}

/** 命令行参数 → 设置值：auto 原样；provider/modelId 或唯一命中的子串 → 规范化引用；否则 null（附候选提示） */
export function resolveSettingArg(
	ctx: ExtensionContext,
	arg: string,
): { value: string } | { error: string } {
	const a = arg.trim();
	if (a.toLowerCase() === LOCAL_AUTO) return { value: LOCAL_AUTO };
	const m = findConfiguredModel(ctx, a);
	if (m) return { value: `${m.provider}/${m.id}` };
	const matches = listAvailableModels(ctx).filter((x) =>
		`${x.provider}/${x.id}`.toLowerCase().includes(a.toLowerCase()),
	);
	if (matches.length > 0) {
		const list = matches
			.slice(0, 3)
			.map((x) => `${x.provider}/${x.id}`)
			.join("、");
		return { error: `「${a}」匹配 ${matches.length} 个模型（${list}${matches.length > 3 ? " 等" : ""}），请用完整 provider/modelId 指定` };
	}
	return { error: `未找到模型「${a}」` };
}

// ---------------------------------------------------------------------------
// 模型配置命令工厂（/btw-config、/explore-config 等同构交互收敛于此）
// ---------------------------------------------------------------------------

export interface ModelConfigCommandOptions {
	/** 命令名（如 "btw-config"） */
	command: string;
	/** 命令描述 */
	description: string;
	/** notify 文案中的名称（如 "btw 模型" / "explore 子模型"） */
	displayName: string;
	/** 该插件的模型设置（shared/model-setting 创建） */
	setting: ModelSetting;
	/** 设置变更后回调（ctx 可用，供调用方按新设置做后续动作，如重注册工具描述） */
	onSettingChanged?: (ctx: ExtensionContext) => void;
}

/**
 * 注册「模型配置命令」：带参数直接设置（auto / provider/modelId，未命中给候选），
 * 无参数打开可搜索选择浮层（auto + 全部已认证模型）。
 */
export function registerModelConfigCommand(pi: ExtensionAPI, opts: ModelConfigCommandOptions): void {
	const usage = `用法：/${opts.command} auto 或 /${opts.command} provider/modelId`;

	const handler = async (args: string, ctx: ExtensionContext) => {
		const arg = args?.trim() ?? "";
		const apply = (value: string) => {
			opts.setting.setLocal(value);
			opts.onSettingChanged?.(ctx);
		};

		if (arg) {
			const r = resolveSettingArg(ctx, arg);
			if ("error" in r) {
				ctx.ui.notify(`${r.error}。${usage}`, "warning");
				return;
			}
			apply(r.value);
			ctx.ui.notify(
				`${opts.displayName}：${r.value === LOCAL_AUTO ? "auto（由 model-config 管理）" : r.value}（已持久化）`,
				"info",
			);
			return;
		}

		if (!ctx.hasUI) {
			ctx.ui.notify(`当前${opts.displayName}：${opts.setting.getLocal()}。${usage}`, "info");
			return;
		}
		const picked = await openLocalModelPicker(ctx, {
			current: opts.setting.getLocal(),
			title: `选择${opts.displayName}`,
			requiresVision: opts.setting.decl.requiresVision,
		});
		if (picked) {
			apply(picked);
			ctx.ui.notify(
				`${opts.displayName}：${picked === LOCAL_AUTO ? "auto（由 model-config 管理）" : picked}（已持久化）`,
				"info",
			);
		}
	};

	pi.registerCommand(opts.command, { description: opts.description, handler });
}
