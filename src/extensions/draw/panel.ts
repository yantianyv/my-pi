/**
 * draw/panel：生图配置浮层（人用）
 *
 * 一屏管完两件事：每档用哪条主备链、图往哪落。
 *   档位区：draft / final 各一行，显示完整链路与落盘目录
 *   链条编辑：进入某档后逐项调整（追加 / 移除 / 上移下移 / 换模型）
 *   模型选择：可搜索浮层，只列已注册的 image 模型
 *
 * 设计要点：
 * - **可选模型只来自 `ctx.modelRegistry`**，面板不写死任何 provider 名。哪个插件注册了
 *   生图模型（OpenRouter 的 seedream…）这里就自动出现。
 * - 链条顺序 = 尝试顺序，所以「上移」就是在调优先级；失败自动落到下一项由 draw.ts 负责。
 * - 面板里改完立即落盘，不设「保存」——配置只有几项，多一步确认反而是负担。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { choiceKey, createBoxRenderer, renderChoiceList, type ChoiceItem } from "../shared/ui";

/** 档位定义（与 draw.ts 保持一致；面板只认这两个） */
export const PANEL_TIERS = ["draft", "final"] as const;
export type PanelTier = (typeof PANEL_TIERS)[number];

export const PANEL_TIER_LABEL: Record<PanelTier, string> = {
	draft: "草稿",
	final: "成品",
};

export const PANEL_TIER_DESC: Record<PanelTier, string> = {
	draft: "内部查看、试配方",
	final: "进交付物的图",
};

/** 面板依赖（由入口注入，便于脱离 pi 运行时做渲染测试） */
export interface PanelDeps {
	/** 当前配置快照 */
	getConfig: () => {
		tiers: Record<PanelTier, string[]>;
		outDir: string;
		size: string;
	};
	/** 写回配置（每次改动立即调用） */
	saveConfig: (next: { tiers: Record<PanelTier, string[]>; outDir: string; size: string }) => void;
	/** 已注册的生图模型，返回 `provider/modelId` 列表 */
	listModels: () => string[];
	/** `provider/modelId` → 人类可读名（找不到就返回原串） */
	modelLabel: (ref: string) => string;
}

type Mode =
	/** 档位总览 */
	| { kind: "overview" }
	/** 某档的链条编辑 */
	| { kind: "chain"; tier: PanelTier; sel: number }
	/** 链中某项的动作菜单 */
	| { kind: "actions"; tier: PanelTier; index: number; sel: number }
	/** 追加/替换模型：从可用列表里挑 */
	| { kind: "pick"; tier: PanelTier; sel: number; query: string }
	/** 编辑落盘目录 */
	| { kind: "outDir"; value: string }
	/** 编辑默认尺寸 */
	| { kind: "size"; value: string };

/** 追加模型时的搜索过滤（空词 = 全部） */
function filterModels(list: string[], query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return list;
	return list.filter((ref) => ref.toLowerCase().includes(q));
}

export class DrawConfigOverlay implements Component {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private deps: PanelDeps;
	private done: () => void;
	private mode: Mode = { kind: "overview" };
	/** 总览光标：0 = 草稿档，1 = 成品档，2 = 落盘目录，3 = 默认尺寸 */
	private overviewSel = 0;
	/** 最近一次操作的反馈（渲染在提示行） */
	private status = "";
	private statusIsError = false;

	constructor(tui: TUI, theme: Theme, deps: PanelDeps, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.deps = deps;
		this.done = done;
	}

	// ---- 配置读写 ----

	private cfg() {
		return this.deps.getConfig();
	}

	private save(next: Partial<{ tiers: Record<PanelTier, string[]>; outDir: string; size: string }>): void {
		this.deps.saveConfig({ ...this.cfg(), ...next });
		this.tui.requestRender();
	}

	private setChain(tier: PanelTier, chain: string[]): void {
		const tiers = { ...this.cfg().tiers, [tier]: chain };
		this.save({ tiers: { draft: tiers.draft ?? [], final: tiers.final ?? [] } });
	}

	/** 总览页的四个入口项（顺序即光标序号） */
	private overviewItems(): ChoiceItem[] {
		const cfg = this.cfg();
		const th = this.theme;
		const items: ChoiceItem[] = [];
		for (const tier of PANEL_TIERS) {
			const chain = cfg.tiers[tier] ?? [];
			items.push({
				label: `${PANEL_TIER_LABEL[tier]}（${tier}）`,
				note: chain.length > 0 ? chain.join(" → ") : "（空：该档无法出图）",
			});
		}
		items.push({ label: "落盘目录", note: cfg.outDir });
		items.push({ label: "默认尺寸", note: cfg.size });
		void th;
		return items;
	}

	// ---- 输入 ----

	handleInput(data: string): void {
		if (this.mode.kind === "overview") return this.handleOverview(data);
		if (this.mode.kind === "chain") return this.handleChain(data);
		if (this.mode.kind === "actions") return this.handleActions(data);
		if (this.mode.kind === "pick") return this.handlePick(data);
		if (this.mode.kind === "outDir") return this.handleEdit(data, "outDir");
		if (this.mode.kind === "size") return this.handleEdit(data, "size");
	}

	private handleOverview(data: string): void {
		const count = this.overviewItems().length;
		const r = choiceKey(data, this.overviewSel, count);
		if (r.kind === "cancel") {
			this.done();
			return;
		}
		if (r.kind === "move" || r.kind === "page") {
			const next = r.kind === "move" ? r.index : this.overviewSel + r.dir * 2;
			this.overviewSel = Math.min(Math.max(0, next), count - 1);
		} else if (r.kind === "select") {
			this.overviewSel = r.index;
			if (r.index < PANEL_TIERS.length) {
				const tier = PANEL_TIERS[r.index]!;
				this.mode = { kind: "chain", tier, sel: 0 };
			} else if (r.index === PANEL_TIERS.length) {
				this.mode = { kind: "outDir", value: this.cfg().outDir };
			} else {
				this.mode = { kind: "size", value: this.cfg().size };
			}
		}
		this.tui.requestRender();
	}

	private handleChain(data: string): void {
		if (this.mode.kind !== "chain") return;
		const { tier } = this.mode;
		const chain = this.cfg().tiers[tier] ?? [];
		// 链条末尾多一个「＋ 添加模型」项
		const count = chain.length + 1;
		const r = choiceKey(data, this.mode.sel, count);
		if (r.kind === "cancel") {
			this.mode = { kind: "overview" };
			this.tui.requestRender();
			return;
		}
		if (r.kind === "move" || r.kind === "page") {
			const next = r.kind === "move" ? r.index : this.mode.sel + r.dir * 3;
			this.mode.sel = Math.min(Math.max(0, next), count - 1);
			this.tui.requestRender();
			return;
		}
		if (r.kind !== "select") return;
		this.mode.sel = r.index;
		// 选中「添加模型」项
		if (r.index === chain.length) {
			const models = this.deps.listModels().filter((ref) => !chain.includes(ref));
			if (models.length === 0) {
				this.flash("没有可追加的生图模型（都已在链中，或没有插件注册生图模型）", true);
				return;
			}
			this.mode = { kind: "pick", tier, sel: 0, query: "" };
			this.tui.requestRender();
			return;
		}
		// 选中链中某项
		this.openChainActions(tier, r.index);
	}

	/** 选中链中某个模型后进入动作菜单（自绘，不借用官方弹层） */
	private openChainActions(tier: PanelTier, index: number): void {
		if (!(this.cfg().tiers[tier] ?? [])[index]) return;
		this.mode = { kind: "actions", tier, index, sel: 0 };
		this.status = "";
		this.tui.requestRender();
	}

	/** 动作菜单里的四个动作（顺序即光标序号） */
	private actionItems(): string[] {
		return ["替换模型", "上移", "下移", "移除"];
	}

	private applyAction(tier: PanelTier, index: number, choice: string): void {
		const cur = this.cfg().tiers[tier] ?? [];
		const ref = cur[index];
		if (!ref) {
			this.mode = { kind: "chain", tier, sel: 0 };
			return;
		}
		if (choice === "上移") {
			if (index === 0) return this.flash("已经是首选（第一位）", true);
			const next = [...cur];
			[next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
			this.setChain(tier, next);
			this.mode = { kind: "chain", tier, sel: index - 1 };
			return this.flash(`已上移：${ref}`);
		}
		if (choice === "下移") {
			if (index === cur.length - 1) return this.flash("已经在最后一位", true);
			const next = [...cur];
			[next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
			this.setChain(tier, next);
			this.mode = { kind: "chain", tier, sel: index + 1 };
			return this.flash(`已下移：${ref}`);
		}
		if (choice === "移除") {
			if (cur.length === 1) return this.flash("每档至少要留一个模型", true);
			this.setChain(tier, cur.filter((x) => x !== ref));
			this.mode = { kind: "chain", tier, sel: Math.max(0, index - 1) };
			return this.flash(`已移除：${ref}`);
		}
		if (choice === "替换模型") {
			const others = this.deps.listModels().filter((x) => !cur.includes(x) || x === ref);
			if (others.length === 0) return this.flash("没有其它可选模型", true);
			this.replacingAt = index;
			this.mode = { kind: "pick", tier, sel: 0, query: "" };
			return this.tui.requestRender();
		}
	}

	/** 替换模式下的目标下标（追加时为 undefined） */
	private replacingAt: number | undefined;

	private handleActions(data: string): void {
		if (this.mode.kind !== "actions") return;
		const { tier, index } = this.mode;
		const items = this.actionItems();
		const r = choiceKey(data, this.mode.sel, items.length);
		if (r.kind === "cancel") {
			this.mode = { kind: "chain", tier, sel: index };
			this.tui.requestRender();
			return;
		}
		if (r.kind === "move" || r.kind === "page") {
			const next = r.kind === "move" ? r.index : this.mode.sel + r.dir * 2;
			this.mode = { ...this.mode, sel: Math.min(Math.max(0, next), items.length - 1) };
			this.tui.requestRender();
			return;
		}
		if (r.kind === "select") this.applyAction(tier, index, items[r.index]!);
	}

	private handlePick(data: string): void {
		if (this.mode.kind !== "pick") return;
		const { tier } = this.mode;
		const chain = this.cfg().tiers[tier] ?? [];
		const available = filterModels(
			this.deps.listModels().filter((ref) => !chain.includes(ref) || ref === chain[this.replacingAt ?? -1]),
			this.mode.query,
		);
		if (matchesKey(data, Key.escape)) {
			// 搜索词非空时先清空，再按一次 Esc 才退出（避免误关丢掉已输入的词）
			if (this.mode.query) {
				this.mode.query = "";
				this.mode.sel = 0;
			} else {
				this.replacingAt = undefined;
				this.mode = { kind: "chain", tier, sel: 0 };
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const chosen = available[this.mode.sel];
			if (!chosen) return;
			const cur = [...(this.cfg().tiers[tier] ?? [])];
			if (this.replacingAt !== undefined && cur[this.replacingAt]) {
				const old = cur[this.replacingAt]!;
				cur[this.replacingAt] = chosen;
				this.setChain(tier, cur);
				this.flash(`已替换：${old} → ${chosen}`);
			} else {
				cur.push(chosen);
				this.setChain(tier, cur);
				this.flash(`已追加：${chosen}`);
			}
			this.replacingAt = undefined;
			this.mode = { kind: "chain", tier, sel: 0 };
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.mode.sel = Math.max(0, this.mode.sel - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.mode.sel = Math.min(Math.max(0, available.length - 1), this.mode.sel + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.mode.query = this.mode.query.slice(0, -1);
			this.mode.sel = 0;
			this.tui.requestRender();
			return;
		}
		// 可打印字符进搜索词
		if (data.length >= 1 && !data.startsWith("\x1b") && data >= " ") {
			this.mode.query += data;
			this.mode.sel = 0;
			this.tui.requestRender();
		}
	}

	private handleEdit(data: string, field: "outDir" | "size"): void {
		if (this.mode.kind !== "outDir" && this.mode.kind !== "size") return;
		const st = this.mode;
		if (matchesKey(data, Key.escape)) {
			this.mode = { kind: "overview" };
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const value = st.value.trim();
			if (!value) {
				this.flash("不能为空", true);
				return;
			}
			if (field === "size" && !/^\d+x\d+$/.test(value)) {
				this.flash("尺寸写成 宽x高，如 1024x1024", true);
				return;
			}
			this.save(field === "outDir" ? { outDir: value } : { size: value });
			this.mode = { kind: "overview" };
			this.flash(`已保存：${value}`);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.mode = { ...st, value: st.value.slice(0, -1) };
			this.tui.requestRender();
			return;
		}
		if (data.length >= 1 && !data.startsWith("\x1b") && data >= " ") {
			this.mode = { ...st, value: st.value + data };
			this.tui.requestRender();
		}
	}

	private flash(text: string, isError = false): void {
		this.status = text;
		this.statusIsError = isError;
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {}

	// ---- 渲染 ----

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(30, width - 2);
		const { row, topBorder, bottomBorder, divider } = createBoxRenderer(th, innerW);
		const out: string[] = [];
		const title = this.mode.kind === "overview" ? "生图配置" : `生图配置 · ${this.modeTierName()}`;
		out.push(topBorder(` ${th.fg("accent", "🎨")} ${th.fg("accent", title)} `));

		if (this.mode.kind === "overview") {
			out.push(...this.renderOverview(innerW, row));
		} else if (this.mode.kind === "chain") {
			out.push(...this.renderChain(innerW, row, divider));
		} else if (this.mode.kind === "actions") {
			out.push(...this.renderActions(innerW, row, divider));
		} else if (this.mode.kind === "pick") {
			out.push(...this.renderPick(innerW, row));
		} else {
			out.push(...this.renderEdit(innerW, row));
		}

		if (this.status) {
			const color = this.statusIsError ? "warning" : "success";
			out.push(row(` ${th.fg(color, truncateToWidth(this.status, innerW - 2, "…", true))}`));
		}
		out.push(bottomBorder());
		return out;
	}

	private modeTierName(): string {
		if (this.mode.kind === "chain" || this.mode.kind === "pick") return PANEL_TIER_LABEL[this.mode.tier];
		if (this.mode.kind === "actions") return `${PANEL_TIER_LABEL[this.mode.tier]} · 调整`;
		if (this.mode.kind === "outDir") return "落盘目录";
		if (this.mode.kind === "size") return "默认尺寸";
		return "";
	}

	private renderOverview(innerW: number, row: (s: string) => string): string[] {
		const th = this.theme;
		const out: string[] = [];
		const items = this.overviewItems();
		// 前两项是档位，带档位说明；后两项是普通设置
		const rows: ChoiceItem[] = items.map((it, i) => {
			if (i < PANEL_TIERS.length) {
				const tier = PANEL_TIERS[i]!;
				return { ...it, note: `${PANEL_TIER_DESC[tier]}${it.note ? ` · ${it.note}` : ""}` };
			}
			return it;
		});
		out.push(row(""));
		out.push(...renderChoiceList(th, rows, this.overviewSel, { width: innerW - 2 }).map((l: string) => row(` ${l}`)));
		out.push(row(""));
		const models = this.deps.listModels();
		out.push(row(th.fg("dim", ` 已注册生图模型 ${models.length} 个`)));
		out.push(row(th.fg("dim", " ↑↓ 选择 · Enter 进入 · Esc 关闭")));
		return out;
	}

	private renderChain(innerW: number, row: (s: string) => string, divider: () => string): string[] {
		const th = this.theme;
		const out: string[] = [];
		if (this.mode.kind !== "chain") return out;
		const { tier } = this.mode;
		const chain = this.cfg().tiers[tier] ?? [];
		out.push(row(` ${th.fg("dim", `${PANEL_TIER_DESC[tier]} · 按顺序尝试，失败自动换下一个`)}`));
		out.push(divider());
		const items: ChoiceItem[] = chain.map((ref, i) => ({
			label: this.deps.modelLabel(ref),
			note: `${i === 0 ? "首选" : `备选 ${i}`} · ${ref}`,
		}));
		items.push({ label: th.fg("accent", "＋ 添加模型") });
		out.push(...renderChoiceList(th, items, this.mode.sel, { width: innerW - 2 }).map((l: string) => row(` ${l}`)));
		out.push(row(""));
		out.push(row(th.fg("dim", " ↑↓ 选择 · Enter 调整（替换/上移/下移/移除）· Esc 返回")));
		return out;
	}

	private renderActions(innerW: number, row: (s: string) => string, divider: () => string): string[] {
		const th = this.theme;
		const out: string[] = [];
		if (this.mode.kind !== "actions") return out;
		const { tier, index } = this.mode;
		const chain = this.cfg().tiers[tier] ?? [];
		const ref = chain[index] ?? "";
		out.push(row(` ${th.fg("dim", "调整")} ${th.fg("accent", this.deps.modelLabel(ref))} ${th.fg("dim", `（${index === 0 ? "首选" : `第 ${index + 1} 位`}）`)}`));
		out.push(divider());
		const items: ChoiceItem[] = this.actionItems().map((label) => {
			// 不可执行的动作标灰并注明原因，避免按下去才发现
			if (label === "上移" && index === 0) return { label, note: "已是首选" };
			if (label === "下移" && index === chain.length - 1) return { label, note: "末位" };
			if (label === "移除" && chain.length === 1) return { label, note: "需保留一个" };
			return { label };
		});
		out.push(...renderChoiceList(th, items, this.mode.sel, { width: innerW - 2 }).map((l: string) => row(` ${l}`)));
		out.push(row(""));
		out.push(row(th.fg("dim", " ↑↓ 选择 · Enter 执行 · Esc 返回")));
		return out;
	}

	private renderPick(innerW: number, row: (s: string) => string): string[] {
		const th = this.theme;
		const out: string[] = [];
		if (this.mode.kind !== "pick") return out;
		const { tier } = this.mode;
		const chain = this.cfg().tiers[tier] ?? [];
		const available = filterModels(
			this.deps.listModels().filter((ref) => !chain.includes(ref) || ref === chain[this.replacingAt ?? -1]),
			this.mode.query,
		);
		const purpose = this.replacingAt !== undefined ? "替换为" : "追加到";
		out.push(row(` ${th.fg("dim", `${purpose}「${PANEL_TIER_LABEL[tier]}」档`)}`));
		out.push(row(` ${th.fg("accent", " / ")}${th.fg("text", this.mode.query)}${this.mode.query ? "" : th.fg("dim", "输入关键词过滤")}`));
		out.push(row(""));
		if (available.length === 0) {
			out.push(row(th.fg("dim", " （没有匹配的模型）")));
		} else {
			const items: ChoiceItem[] = available.map((ref) => ({
				label: this.deps.modelLabel(ref),
				note: ref,
			}));
			// 列表可能很长：以光标为中心截一段
			const WINDOW = 10;
			const start = Math.max(0, Math.min(this.mode.sel - Math.floor(WINDOW / 2), available.length - WINDOW));
			const view = items.slice(start, start + WINDOW);
			out.push(...renderChoiceList(th, view, this.mode.sel - start, { width: innerW - 2 }).map((l: string) => row(` ${l}`)));
		}
		out.push(row(""));
		out.push(row(th.fg("dim", " 输入过滤 · ↑↓ 选择 · Enter 确认 · Esc 返回")));
		return out;
	}

	private renderEdit(innerW: number, row: (s: string) => string): string[] {
		const th = this.theme;
		const out: string[] = [];
		if (this.mode.kind !== "outDir" && this.mode.kind !== "size") return out;
		const field = this.mode.kind;
		out.push(row(` ${th.fg("dim", field === "outDir" ? "图片保存目录（相对项目根；绝对路径也接受）" : "默认尺寸，如 1024x1024")}`));
		out.push(row(""));
		out.push(row(` ${th.fg("accent", " › ")}${th.fg("text", this.mode.value)}`));
		out.push(row(""));
		out.push(row(th.fg("dim", " Enter 保存 · Esc 取消")));
		return out;
	}
}

/** 浮层参数（与其他自绘面板保持一致）；类型交给 pi 的 custom() 推断 */
export const OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: {
		anchor: "center",
		width: "80%",
		minWidth: 64,
		maxHeight: "85%",
	},
} as const;
