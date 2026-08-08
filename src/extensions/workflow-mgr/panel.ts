/**
 * workflow-mgr 展示层：常驻 widget + /workflow-config 统一功能菜单浮窗 + 非 TUI 文本回落
 *
 * - renderWidget：belowEditor 常驻面板（字符边框 + selectedBg 背景 + 进度条右对齐
 *   + 分工两行 + 阻塞警告 + 里程碑三态），宽度自适应用 pi-tui visibleWidth
 *   （中文=2、块元素=1），窗口 resize 按宽度变化才重建；
 * - updateWidget：把 store 当前状态推到 ctx.ui（widget + setStatus 摘要一行），
 *   面板开关（config.json showPanel）为 false 时移除 widget；非 TUI 自动跳过；
 * - WfmgMenuPanelComponent：/workflow-config 的轻量功能浮窗（overlay），只收两个高频功能：
 *   显示详细信息（进度总览）/ 常驻面板开关。↑↓ 选择、Enter 执行、Esc 关闭，overview 任意键返回菜单；
 * - configText / textPanel：非 TUI 模式的文本回落。
 *
 * 状态变更由组件内直接操作 store（commit + updateWidget 即时刷新）。
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, matchesKey, Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { WorkflowState } from "./types";
import type { Derived, WorkflowStore } from "./store";
import { nextPendingTask } from "./store";
import { blockedList, currentTask, summaryLine, truncate } from "./brief";

/** hud 的通用「额外底部行」接口（hud-core 暴露全局 __PI_HUD_API__，零 import 契约） */
interface HudExtraRowsApi {
	registerExtraRows: (provider: (theme: Theme, width: number) => string[] | null) => () => void;
	notifyExtraRowsUpdate: () => void;
}
const getHudApi = (): HudExtraRowsApi | null =>
	((globalThis as Record<string, unknown>).__PI_HUD_API__ as HudExtraRowsApi) ?? null;
/** 当前已注册的 provider 注销函数（hud 缺席/面板关闭时置 null） */
let unregisterRows: (() => void) | null = null;

/** 注销 hud 底部行（session 结束等场景调用；hud 缺席时无操作）。 */
export function unregisterHudRows(): void {
	unregisterRows?.();
	unregisterRows = null;
}

/** 常驻 widget：Box 背景区块 + 任务行/分工两行/阻塞警告/里程碑三态；进度条右对齐 */
function renderWidget(state: WorkflowState, derived: Derived, theme: Theme) {
	const cur = currentTask(state, derived);
	const curStage = cur ? derived.stageOf.get(cur.id) : null;
	const next = nextPendingTask(state, derived);
	const blocked = blockedList(state, derived);
	const doneCount = derived.all.filter((t) => state.tasks[t.id]?.status === "done").length;
	const empty = derived.all.length === 0;

	const container = new Container();
	let lastWidth = 0;

	const build = (width: number) => {
		container.clear();
		// Box(1,0)：左右 1 内边距（缩进 2 列），垂直 0——紧凑；背景 selectedBg
		// （7 个固定背景 token 中最亮的，matrix 主题 #0f2e1a），与 hud 一眼可辨
		const box = new Box(1, 0, (t) => theme.bg("selectedBg", t));
		const availW = Math.max(50, width - 6);

		// ── 进度条（12 格）──
		const stageDone = curStage
			? curStage.tasks.filter((t) => state.tasks[t.id]?.status === "done").length
			: 0;
		const BARS = 12;
		const filled = Math.min(BARS, Math.round((doneCount / Math.max(1, derived.all.length)) * BARS));
		let bar = "";
		for (let i = 0; i < BARS; i++) {
			bar += i < filled ? theme.fg("accent", "▓") : theme.fg("dim", "░");
		}

		// ── 行 1：左侧 = 当前任务（最显眼）；中间 = 阶段（dim）；右侧 = 进度条（右对齐）──
		let taskPart: string;
		if (empty) {
			taskPart = theme.fg("muted", "无任务，请先让 AI 用 wf_workflow 规划");
		} else if (cur) {
			const st = state.tasks[cur.id]?.status ?? "todo";
			// 状态完全由徽章承担（[进行中]/[待开始]/[已阻塞]），不加前缀标记
			const badge =
				st === "doing"
					? theme.fg("success", "[进行中]")
					: theme.fg("dim", `[${st === "blocked" ? "已阻塞" : "待开始"}]`);
			taskPart = theme.fg("text", `${cur.id} ${truncate(cur.title, 32)}`) + " " + badge;
		} else if (next) {
			taskPart = theme.fg("text", `${next.id} ${truncate(next.title, 32)}`);
		} else {
			taskPart = theme.fg("success", "全部任务已完成");
		}
		const stagePart = curStage
			? theme.fg("dim", `${curStage.name} ${stageDone}/${curStage.tasks.length}`)
			: theme.fg("dim", "—");
		const left = taskPart + theme.fg("dim", "  ┃  ") + stagePart;
		const right = bar + theme.fg("dim", ` ${doneCount}/${derived.all.length}`);
		const pad = Math.max(2, availW - visibleWidth(left) - visibleWidth(right));
		box.addChild(new Text(left + " ".repeat(pad) + right, 1, 0));

		// ── 分工两行 ──
		if (cur) {
			box.addChild(
				new Text(theme.fg("muted", "你: ") + theme.fg("text", truncate(cur.humanTasks[0] ?? "", 44)), 1, 0),
			);
			box.addChild(
				new Text(theme.fg("muted", "AI: ") + theme.fg("text", truncate(cur.aiTasks[0] ?? "", 44)), 1, 0),
			);
		}

		if (blocked.length) {
			box.addChild(
				new Text(
					theme.fg("warning", `阻塞 ${blocked.map((t) => `${t.id} ${truncate(t.title, 16)}`).join("；")}`),
					1,
					0,
				),
			);
		}

		// ── 里程碑行：✓已完成 / ▶当前目标 / ○未完成 三态（无里程碑则省略整行；不带日期）──
		const msEntries = Object.entries(state.milestones);
		if (msEntries.length) {
			const curMsIdx = msEntries.findIndex(([, m]) => !m.done);
			box.addChild(
				new Text(
					theme.fg("muted", "里程碑 ") +
						msEntries
							.map(([n, m], i) => {
								if (m.done) return theme.fg("success", `✓ ${n}`);
								if (i === curMsIdx) return theme.fg("accent", `▶ ${n}`);
								return theme.fg("dim", `○ ${n}`);
							})
							.join("   "),
					1,
					0,
				),
			);
		}

		container.addChild(box);
	};

	build(0);
	return {
		render: (w: number) => {
			if (w !== lastWidth) {
				build(w);
				lastWidth = w;
			}
			return container.render(w);
		},
		invalidate: () => {
			container.invalidate();
			lastWidth = 0;
		},
	};
}

/**
 * hud 底部行的渲染（由 workflow 决定内容与样式，确保与常驻面板体验一致）：
 * 与 renderWidget 同款——12 格 ▓/░ 进度条、状态徽章、┃ 阶段分隔、selectedBg 满宽底色。
 * hud 只负责把返回的行追加到 footer 底部（通用接口 __PI_HUD_API__），不加工内容。
 */
export function renderHudRows(state: WorkflowState, derived: Derived, theme: Theme, width: number): string[] {
	const cur = currentTask(state, derived);
	const curStage = cur ? derived.stageOf.get(cur.id) : null;
	const blocked = blockedList(state, derived);
	const doneCount = derived.all.filter((t) => state.tasks[t.id]?.status === "done").length;
	const empty = derived.all.length === 0;
	const rows: string[] = [];

	// 行 1：任务 + 阶段 + 进度条（右侧进度条右对齐，与面板一致）
	let taskPart: string;
	if (empty) {
		taskPart = theme.fg("muted", "无任务，请先让 AI 用 wf_workflow 规划");
	} else if (cur) {
		const st = state.tasks[cur.id]?.status ?? "todo";
		const badge =
			st === "doing" ? theme.fg("success", "[进行中]") : theme.fg("dim", `[${st === "blocked" ? "已阻塞" : "待开始"}]`);
		taskPart = theme.fg("text", `${cur.id} ${truncate(cur.title, 32)}`) + " " + badge;
	} else if (nextPendingTask(state, derived)) {
		const next = nextPendingTask(state, derived)!;
		taskPart = theme.fg("text", `${next.id} ${truncate(next.title, 32)}`);
	} else {
		taskPart = theme.fg("success", "全部任务已完成");
	}
	const stageDone = curStage ? curStage.tasks.filter((t) => state.tasks[t.id]?.status === "done").length : 0;
	const stagePart = curStage
		? theme.fg("dim", `${curStage.name} ${stageDone}/${curStage.tasks.length}`)
		: theme.fg("dim", "—");
	const BARS = 12;
	const filled = Math.min(BARS, Math.round((doneCount / Math.max(1, derived.all.length)) * BARS));
	let bar = "";
	for (let i = 0; i < BARS; i++) bar += i < filled ? theme.fg("accent", "▓") : theme.fg("dim", "░");
	const left = taskPart + theme.fg("dim", "  ┃  ") + stagePart;
	const right = bar + theme.fg("dim", ` ${doneCount}/${derived.all.length}`);
	const pad = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
	rows.push(left + " ".repeat(pad) + right);

	// 分工两行
	if (cur) {
		rows.push(theme.fg("muted", "你: ") + theme.fg("text", truncate(cur.humanTasks[0] ?? "", 44)));
		rows.push(theme.fg("muted", "AI: ") + theme.fg("text", truncate(cur.aiTasks[0] ?? "", 44)));
	}

	// 阻塞警告
	if (blocked.length) {
		rows.push(theme.fg("warning", `阻塞 ${blocked.map((t) => `${t.id} ${truncate(t.title, 16)}`).join("；")}`));
	}

	// 里程碑行：✓已完成 / ▶当前目标 / ○未完成 三态（无里程碑则省略整行）
	const msEntries = Object.entries(state.milestones);
	if (msEntries.length) {
		const curMsIdx = msEntries.findIndex(([, m]) => !m.done);
		rows.push(
			theme.fg("muted", "里程碑 ") +
				msEntries
					.map(([n, m], i) => {
						if (m.done) return theme.fg("success", `✓ ${n}`);
						if (i === curMsIdx) return theme.fg("accent", `▶ ${n}`);
						return theme.fg("dim", `○ ${n}`);
					})
					.join("   "),
		);
	}

	// 满宽铺 selectedBg 底色（与常驻面板同款）：行截断后 pad 到 width 再包背景，形成整块面板
	return rows.map((r) => {
		const t = truncateToWidth(r, width);
		return theme.bg("selectedBg", t + " ".repeat(Math.max(0, width - visibleWidth(t))));
	});
}

/**
 * 更新常驻 UI：hud 存在且开启 → 经通用接口注册底部行渲染（面板隐藏，内容/样式由本扩展决定）；
 * 否则面板开启 → widget + setStatus 一行摘要；关闭 → 移除 widget。
 * provider 注册状态在入口统一维护（hud 关闭/面板关闭/无工作流 → 一律注销），与分支解耦。
 * 非 TUI 模式自动跳过（setWidget/setStatus 仅在 hasUI 时可用）。
 */
export function updateWidget(ctx: ExtensionContext, store: WorkflowStore) {
	if (!ctx.hasUI) return;
	try {
		const g = globalThis as Record<string, unknown>;
		const state = store.getState();
		const derived = store.getDerived();
		const api = getHudApi();

		// hud 底部行 provider 状态：hud 存在且开启 && 有工作流 && 面板开关开
		const hudShow = Boolean(g.__PI_HUD_ACTIVE__ && api && store.hasWorkflowFile() && store.getPanelConfig().showPanel);
		if (hudShow) {
			unregisterRows?.();
			// hudShow 为真时 api 必非空（布尔链已含 api）
			unregisterRows = api!.registerExtraRows((theme, width) => renderHudRows(state, derived, theme, width));
		} else {
			unregisterRows?.();
			unregisterRows = null;
		}
		api?.notifyExtraRowsUpdate();

		// hud 存在且开启：常驻面板隐藏（内容在 hud 底部渲染）
		if (g.__PI_HUD_ACTIVE__) {
			ctx.ui.setWidget("workflow-mgr", undefined, { placement: "belowEditor" });
			ctx.ui.setStatus("workflow-mgr", undefined);
			return;
		}
		// 从未创建工作流（无 workflow.json）→ 组件整体隐藏，不推 widget 也不推状态摘要
		if (!store.hasWorkflowFile()) {
			ctx.ui.setWidget("workflow-mgr", undefined, { placement: "belowEditor" });
			ctx.ui.setStatus("workflow-mgr", undefined);
			return;
		}
		const cfg = store.getPanelConfig();
		if (cfg.showPanel) {
			ctx.ui.setWidget("workflow-mgr", (_tui, theme) => renderWidget(state, derived, theme), {
				placement: "belowEditor",
			});
			ctx.ui.setStatus("workflow-mgr", summaryLine(state, derived));
		} else {
			ctx.ui.setWidget("workflow-mgr", undefined, { placement: "belowEditor" });
			ctx.ui.setStatus("workflow-mgr", undefined);
		}
	} catch (e) {
		console.error("[workflow-mgr] widget update failed:", e);
	}
}

/* ============================== /workflow-config 轻量功能浮窗 ============================== */

type MenuMode = "menu" | "overview";

/**
 * /workflow-config 轻量功能浮窗（overlay，字符边框）：只收两个高频功能。
 * - menu：↑↓ 选择、Enter 执行、Esc 关闭；
 * - overview：当前任务+分工+进度+里程碑（任意键返回菜单）。
 * 操作即时生效（commit + updateWidget）并持久化；持有 tui 引用，变更后 requestRender。
 */
export class WfmgMenuPanelComponent {
	private store: WorkflowStore;
	private ctx: ExtensionContext;
	private theme: Theme;
	private tui: TUI | null = null;
	private onClose: () => void;
	private mode: MenuMode;
	private selected = 0;

	constructor(
		store: WorkflowStore,
		ctx: ExtensionContext,
		theme: Theme,
		onClose: () => void,
		initialMode: MenuMode = "menu",
	) {
		this.store = store;
		this.ctx = ctx;
		this.theme = theme;
		this.onClose = onClose;
		this.mode = initialMode;
	}

	setTui(tui: TUI): void {
		this.tui = tui;
	}

	private menuItems(): Array<{ label: string; desc: string; run: () => void }> {
		const cfg = this.store.getPanelConfig();
		return [
			{ label: "显示详细信息", desc: "当前任务、分工、进度、里程碑", run: () => { this.mode = "overview"; } },
			{
				label: "常驻面板",
				desc: `输入框下方进度面板（当前${cfg.showPanel ? "开" : "关"}）`,
				run: () => this.togglePanel(),
			},
		];
	}

	private togglePanel(): void {
		const cfg = this.store.getPanelConfig();
		cfg.showPanel = !cfg.showPanel;
		this.store.commitPanelConfig();
		updateWidget(this.ctx, this.store);
		this.ctx.ui.notify(`常驻面板已${cfg.showPanel ? "开启" : "关闭"}（/workflow-config toggle 可再切换）`, "info");
	}

	handleInput(data: string): void {
		if (this.mode === "overview") {
			// 任意键返回菜单（Esc 亦先回菜单，再按一次关闭）
			this.mode = "menu";
			this.tui?.requestRender();
		} else {
			this.handleMenuInput(data);
		}
	}

	private handleMenuInput(data: string): void {
		const items = this.menuItems();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selected = (this.selected - 1 + items.length) % items.length;
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selected = (this.selected + 1) % items.length;
		} else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			items[this.selected].run();
		}
		this.tui?.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		// 浮窗边框：内容行 pad 到 innerW，左右包 │；顶/底横线 ┌─┐└┘（borderMuted 暗色）
		const innerW = Math.max(30, width - 4);
		const b = (s: string) => th.fg("borderMuted", s);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const titles: Record<MenuMode, string> = { menu: "工作流面板", overview: "进度总览" };

		const content: string[] = [];
		content.push(pad(th.fg("accent", th.bold(` ${titles[this.mode]} `))));
		content.push(pad(""));

		if (this.mode === "menu") {
			for (const [i, item] of this.menuItems().entries()) {
				const selected = i === this.selected;
				const prefix = selected ? th.fg("accent", "▶ ") : th.fg("dim", "  ");
				const label = selected ? th.fg("text", item.label) : th.fg("muted", item.label);
				content.push(pad("  " + prefix + label));
				content.push(pad(th.fg("dim", "    " + item.desc)));
			}
			content.push(pad(""));
			content.push(pad(th.fg("dim", " ↑↓ 选择　Enter 执行　Esc 关闭")));
		} else {
			// overview：当前任务+分工+进度+里程碑（widget 里被精简掉的信息在这里完整呈现）
			for (const line of this.overviewLines()) content.push(pad(line));
			content.push(pad(""));
			content.push(pad(th.fg("dim", " 按任意键返回菜单")));
		}

		// 包边框
		return [
			b("┌" + "─".repeat(innerW) + "┐"),
			...content.map((l) => b("│ ") + l + b(" │")),
			b("└" + "─".repeat(innerW) + "┘"),
		];
	}

	/** 进度总览内容：当前任务 + 分工 + 进度条 + 里程碑（widget 里被精简掉的信息在这里完整呈现） */
	private overviewLines(): string[] {
		const th = this.theme;
		const state = this.store.getState();
		const derived = this.store.getDerived();
		const lines: string[] = [];
		if (derived.all.length === 0) {
			lines.push(th.fg("muted", " 工作流为空：让 AI 用 wf_workflow 规划阶段/任务"));
			return lines;
		}
		const cur = currentTask(state, derived);
		if (cur) {
			const st = state.tasks[cur.id]?.status ?? "todo";
			const badge =
				st === "doing"
					? th.fg("success", "[进行中]")
					: st === "blocked"
						? th.fg("warning", "[已阻塞]")
						: th.fg("dim", "[待开始]");
			lines.push(th.fg("text", ` 当前任务：${cur.id} ${cur.title}`) + " " + badge);
			lines.push(th.fg("muted", " 你: ") + th.fg("text", cur.humanTasks.join("；") || "—"));
			lines.push(th.fg("muted", " AI: ") + th.fg("text", cur.aiTasks.join("；") || "—"));
		} else {
			lines.push(th.fg("success", " 全部任务已完成"));
		}
		const doneCount = derived.all.filter((t) => state.tasks[t.id]?.status === "done").length;
		const BARS = 12;
		const filled = Math.min(BARS, Math.round((doneCount / Math.max(1, derived.all.length)) * BARS));
		let bar = "";
		for (let i = 0; i < BARS; i++) bar += i < filled ? th.fg("accent", "▓") : th.fg("dim", "░");
		lines.push(` 进度：${bar} ${doneCount}/${derived.all.length}`);
		const msEntries = Object.entries(state.milestones);
		if (msEntries.length) {
			const curMsIdx = msEntries.findIndex(([, m]) => !m.done);
			lines.push(
				th.fg("muted", " 里程碑 ") +
					msEntries
						.map(([n, m], i) => {
							if (m.done) return th.fg("success", `✓ ${n}`);
							if (i === curMsIdx) return th.fg("accent", `▶ ${n}`);
							return th.fg("dim", `○ ${n}`);
						})
						.join("  "),
			);
		}
		return lines;
	}

	invalidate(): void {
		/* 渲染无缓存，每次现算 */
	}
}

/** 非 TUI 模式 /workflow-config 的文本面板 */
export function textPanel(state: WorkflowState, derived: Derived): string[] {
	const lines: string[] = [summaryLine(state, derived), ""];
	if (derived.all.length === 0) {
		lines.push("工作流为空：让 AI 用 wf_workflow 规划阶段/任务");
		return lines;
	}
	const seen = new Set<string>();
	for (const t of derived.all) {
		const stage = derived.stageOf.get(t.id)!;
		if (!seen.has(stage.id)) {
			seen.add(stage.id);
			const doneIn = stage.tasks.filter((x) => state.tasks[x.id]?.status === "done").length;
			lines.push(`▎${stage.name} ${doneIn}/${stage.tasks.length}`);
		}
		const st = state.tasks[t.id]?.status ?? "todo";
		const mark = st === "done" ? "✓" : st === "doing" ? "▶" : st === "blocked" ? "⛔" : "○";
		lines.push(
			`  ${mark} ${t.id} ${t.title}${st === "blocked" && state.tasks[t.id]?.blockReason ? `（${state.tasks[t.id].blockReason}）` : ""}`,
		);
	}
	const msEntries = Object.entries(state.milestones);
	if (msEntries.length) {
		lines.push("");
		lines.push(`里程碑：${msEntries.map(([n, m]) => `${n}${m.done ? "✓" : ""}`).join("  ")}`);
	}
	lines.push(`决策记录：${state.decisions.length} 条`);
	return lines;
}
