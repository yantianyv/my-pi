/**
 * model-config/panel：/model-config 管理面板（两个页签：用途 / 策略槽）
 *
 * 版式纪律：**每行只占一行**（左侧名称 + 右侧设置摘要，超宽先截摘要再截名称，绝不折行）——
 * 折行会让行数与滚动预算对不上，面板就会顶穿边框。
 *
 * 页签（Tab / ←→ 切换）：
 *   用途     按插件分组，每行 = `[插件] 用途名   本地设置 · 解析到的模型`
 *   策略槽   7 行 = `AUTO 跟随会话   当前会话模型`，AUTO/FREE 标「固定语义」不可改
 * 层级：主页 → 动作层（选策略 / 选具体模型 / 清除设置 / 取消本地固定）→ 策略列表或模型列表。
 * 本地固定的用途改由中心接管时先过确认页，确认后写回 auto。
 *
 * 写入落在 ~/.pi/agent/model-config.json 与各插件自己的配置文件（文件通道）；插件每次解析都会
 * 重读，因此面板改完立即生效，无需 /reload。
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createBoxRenderer, choiceKey, renderChoiceList, type ChoiceItem } from "../shared/ui";
import { ModelSelectOverlay, listAvailableModels, modelHasVision } from "../shared/model-select";
import {
	LOCAL_AUTO,
	STRATEGIES,
	STRATEGY_LABEL,
	listPurposeDecls,
	loadModelConfigState,
	readLocalSetting,
	resolveSetting,
	setPurposeSetting,
	setStrategyMapping,
	writeLocalSetting,
	isStrategy,
	type PurposeDecl,
	type ResolvedChain,
	type Strategy,
} from "../shared/model-setting";
import { findConfiguredModel, modelRef } from "../shared/model-util";

type Tab = "purposes" | "strategies";

interface ActionItem {
	label: string;
	note?: string;
	run: () => void | Promise<void>;
}

interface PendingConfirm {
	text: string;
	onYes: () => void | Promise<void>;
}

/** 主页可见行数（按终端高度自适应，留出边框/提示/状态行） */
function mainBudget(termRows: number): number {
	return Math.max(6, Math.min(20, Math.floor((termRows || 24) * 0.7) - 4));
}

export class ModelConfigOverlay {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private ctx: ExtensionContext;
	private done: () => void;

	private tab: Tab = "purposes";
	private purposes: PurposeDecl[] = [];
	private purposeSel = 0;
	private purposeScroll = 0;
	private strategySel = 0;
	private actions: ActionItem[] | null = null;
	private actionSel = 0;
	private pending: PendingConfirm | null = null;
	private confirmSel = 0;
	private picker: ModelSelectOverlay | null = null;
	private pickerDone: ((v: string | null) => void) | null = null;
	private strategyPickFor: PurposeDecl | null = null;
	private strategyPickSel = 0;
	private status = "";

	constructor(tui: TUI, theme: Theme, ctx: ExtensionContext, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.done = done;
		this.refresh();
	}

	private refresh(): void {
		this.purposes = listPurposeDecls();
		this.purposeSel = Math.min(Math.max(0, this.purposeSel), Math.max(0, this.purposes.length - 1));
		this.tui.requestRender();
	}

	// ---- 解析 ----

	private tryResolve(setting: string): ResolvedChain | null {
		try {
			return resolveSetting(setting, this.ctx);
		} catch {
			return null;
		}
	}

	private resolvedRef(setting: string): string {
		const chain = this.tryResolve(setting);
		return chain?.model ? modelRef(chain.model) : "（无可用模型）";
	}

	/** 用途行右侧摘要：`auto · FAST → 模型` / `[本地] 模型` */
	private purposeSummary(d: PurposeDecl): string {
		const local = readLocalSetting(d);
		if (local !== LOCAL_AUTO) return `[本地固定] ${local}`;
		const center = loadModelConfigState().purposes[d.purpose];
		const setting = center ?? d.defaultStrategy;
		if (setting.toUpperCase() === "AUTO") return `auto → 跟随会话（${this.resolvedRef(setting)}）`;
		const tag = center ? center : `${d.defaultStrategy}（默认）`;
		return `auto · ${tag} → ${this.resolvedRef(setting)}`;
	}

	/** 策略槽行右侧摘要 */
	private strategySummary(s: Strategy): string {
		if (s === "AUTO") return "当前会话模型";
		if (s === "FREE") {
			const chain = this.tryResolve("FREE");
			const n = chain?.chain.length ?? 0;
			return n > 1 ? `免费池 ${n} 个，顺序回退` : "免费池";
		}
		const mapped = loadModelConfigState().strategies[s];
		if (!mapped) return "默认（跟随会话）";
		return findConfiguredModel(this.ctx, mapped) ? mapped : `${mapped}（不可用，回落跟随会话）`;
	}

	// ---- 单行渲染（左名称 + 右摘要，右先截） ----

	/**
	 * 单行「左名称 + 右摘要」：右列从 colStart 列起（调用方按本页最宽的左名称算，保证纵向对齐），
	 * 超宽先截摘要、再截名称，两侧都走 visibleWidth / truncateToWidth（ANSI 安全），永远只占一行。
	 */
	private line(left: string, right: string, selected: boolean, innerW: number, colStart: number): string {
		const th = this.theme;
		const cursor = selected ? th.fg("accent", " › ") : "   ";
		const avail = Math.max(16, innerW - 3);
		const leftBudget = Math.max(6, colStart - 2);
		const leftText = visibleWidth(left) > leftBudget ? truncateToWidth(left, leftBudget, "…") : left;
		const rightBudget = Math.max(8, avail - colStart);
		const rightText = truncateToWidth(right, rightBudget, "…");
		const pad = Math.max(1, colStart - 2 - visibleWidth(leftText));
		const l = selected ? th.fg("accent", th.bold(leftText)) : leftText;
		return `${cursor}${l}${" ".repeat(pad)}${th.fg("dim", rightText)}`;
	}

	/** 右列起点：本页最宽左名称 + 2，最多占到内容区 60%（避免摘要被挤没） */
	private columnStart(leftPlain: string[], innerW: number): number {
		const avail = Math.max(16, innerW - 3);
		const maxLeft = Math.max(0, ...leftPlain.map((x) => visibleWidth(x)));
		return Math.min(maxLeft + 2, Math.floor(avail * 0.6));
	}

	// ---- 输入 ----

	handleInput(data: string): void {
		if (this.picker) {
			this.picker.handleInput(data);
			return;
		}
		if (this.pending) {
			const r = choiceKey(data, this.confirmSel, 2);
			if (r.kind === "cancel") {
				this.pending = null;
				this.confirmSel = 0;
			} else if (r.kind === "move") {
				this.confirmSel = r.index;
			} else if (r.kind === "select") {
				const p = this.pending;
				this.pending = null;
				this.confirmSel = 0;
				if (r.index === 0 && p) void p.onYes();
			}
			this.tui.requestRender();
			return;
		}
		if (this.strategyPickFor) {
			const r = choiceKey(data, this.strategyPickSel, STRATEGIES.length);
			if (r.kind === "cancel") {
				this.strategyPickFor = null;
			} else if (r.kind === "move" || r.kind === "page") {
				const next = r.kind === "move" ? r.index : this.strategyPickSel + r.dir * 5;
				this.strategyPickSel = Math.min(Math.max(0, next), STRATEGIES.length - 1);
			} else if (r.kind === "select") {
				const decl = this.strategyPickFor;
				this.strategyPickFor = null;
				if (decl) void this.applyStrategyToPurpose(decl, STRATEGIES[r.index]!);
			}
			this.tui.requestRender();
			return;
		}
		if (this.actions) {
			const r = choiceKey(data, this.actionSel, this.actions.length);
			if (r.kind === "cancel") {
				this.actions = null;
				this.actionSel = 0;
			} else if (r.kind === "move" || r.kind === "page") {
				const next = r.kind === "move" ? r.index : this.actionSel + r.dir * 5;
				this.actionSel = Math.min(Math.max(0, next), this.actions.length - 1);
			} else if (r.kind === "select") {
				const a = this.actions[r.index];
				this.actions = null;
				this.actionSel = 0;
				if (a) void a.run();
			}
			this.tui.requestRender();
			return;
		}

		// 主页：Tab / ←→ 切页签
		if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
			this.tab = this.tab === "purposes" ? "strategies" : "purposes";
			this.status = "";
			this.tui.requestRender();
			return;
		}

		const count = this.tab === "purposes" ? this.purposes.length : STRATEGIES.length;
		if (count === 0) {
			if (matchesKey(data, "escape")) this.done();
			return;
		}
		if (this.tab === "purposes") {
			const r = choiceKey(data, this.purposeSel, count);
			if (r.kind === "cancel") this.done();
			else if (r.kind === "move" || r.kind === "page") {
				const next = r.kind === "move" ? r.index : this.purposeSel + r.dir * 5;
				this.purposeSel = Math.min(Math.max(0, next), count - 1);
			} else if (r.kind === "select") void this.openPurposeActions(this.purposes[r.index]!);
		} else {
			const r = choiceKey(data, this.strategySel, count);
			if (r.kind === "cancel") this.done();
			else if (r.kind === "move" || r.kind === "page") {
				const next = r.kind === "move" ? r.index : this.strategySel + r.dir * 5;
				this.strategySel = Math.min(Math.max(0, next), count - 1);
			} else if (r.kind === "select") void this.openStrategyActions(STRATEGIES[r.index]!);
		}
		this.tui.requestRender();
	}

	// ---- 动作 ----

	private async openStrategyActions(s: Strategy): Promise<void> {
		this.status = "";
		if (s === "AUTO" || s === "FREE") {
			this.status = `${s} 只能被用途选用，不能改指模型`;
			this.tui.requestRender();
			return;
		}
		this.actions = [
			{ label: "指定具体模型…", note: "所有引用该槽的用途一起生效", run: () => this.pickModelForStrategy(s) },
			{
				label: "清除映射",
				note: "回到跟随会话",
				run: () => {
					setStrategyMapping(s, null);
					this.status = `${s} 已恢复默认`;
					this.refresh();
				},
			},
		];
		this.actionSel = 0;
	}

	private async openPurposeActions(decl: PurposeDecl): Promise<void> {
		this.status = "";
		const local = readLocalSetting(decl);
		const actions: ActionItem[] = [
			{
				label: "中心：按策略…",
				note: "AUTO / MAX / FAST / LITE / BASE / BATCH / FREE",
				run: () => {
					this.strategyPickFor = decl;
					const center = loadModelConfigState().purposes[decl.purpose];
					const upper = center?.toUpperCase() ?? "";
					this.strategyPickSel = Math.max(0, STRATEGIES.indexOf(isStrategy(upper) ? upper : decl.defaultStrategy));
				},
			},
			{ label: "中心：指定具体模型…", note: "该用途固定用某个模型", run: () => this.pickModelForPurpose(decl) },
			{
				label: "清除中心设置",
				note: `回到默认策略 ${decl.defaultStrategy}`,
				run: () => {
					setPurposeSetting(decl.purpose, null);
					this.status = `${decl.label} 已回到默认策略`;
					this.refresh();
				},
			},
		];
		if (local !== LOCAL_AUTO) {
			actions.push({
				label: "取消本地固定",
				note: `当前 ${local}，改为 auto 后由中心决定`,
				run: () => {
					this.pending = {
						text: `${decl.label} 当前被本地固定（${local}）覆盖。继续会写回 auto，之后由中心设置决定。`,
						onYes: () => {
							writeLocalSetting(decl, LOCAL_AUTO);
							this.status = `${decl.label} 已改为 auto`;
							this.refresh();
						},
					};
					this.confirmSel = 0;
				},
			});
		}
		this.actions = actions;
		this.actionSel = 0;
	}

	private async applyStrategyToPurpose(decl: PurposeDecl, s: Strategy): Promise<void> {
		const local = readLocalSetting(decl);
		const apply = (): void => {
			setPurposeSetting(decl.purpose, s);
			this.status = `${decl.label} 已设为 ${s}`;
			this.refresh();
		};
		if (local !== LOCAL_AUTO) {
			this.pending = {
				text: `${decl.label} 当前被本地固定（${local}）覆盖。继续会写回 auto，并按中心策略 ${s} 解析。`,
				onYes: () => {
					writeLocalSetting(decl, LOCAL_AUTO);
					apply();
				},
			};
			this.confirmSel = 0;
			return;
		}
		apply();
	}

	private async pickModelForStrategy(s: Strategy): Promise<void> {
		const picked = await this.pickModel({
			requiresVision: false,
			current: loadModelConfigState().strategies[s],
		});
		if (!picked) return;
		setStrategyMapping(s, picked);
		this.status = `${s} 已映射到 ${picked}`;
		this.refresh();
	}

	private async pickModelForPurpose(decl: PurposeDecl): Promise<void> {
		const picked = await this.pickModel({
			requiresVision: decl.requiresVision === true,
			current: loadModelConfigState().purposes[decl.purpose],
		});
		if (!picked) return;
		const local = readLocalSetting(decl);
		const apply = (): void => {
			setPurposeSetting(decl.purpose, picked);
			this.status = `${decl.label} 已设为 ${picked}`;
			this.refresh();
		};
		if (local !== LOCAL_AUTO) {
			this.pending = {
				text: `${decl.label} 当前被本地固定（${local}）覆盖。继续会写回 auto，并由中心使用 ${picked}。`,
				onYes: () => {
					writeLocalSetting(decl, LOCAL_AUTO);
					apply();
				},
			};
			this.confirmSel = 0;
			return;
		}
		apply();
	}

	/** 内嵌模型选择浮层（不叠 ctx.ui.custom，避免嵌套弹层） */
	private pickModel(opts: { requiresVision: boolean; current?: string }): Promise<string | null> {
		const items = listAvailableModels(this.ctx)
			.filter((m) => !opts.requiresVision || modelHasVision(m))
			.map((m) => ({
				label: `${m.provider}/${m.id}`,
				value: `${m.provider}/${m.id}`,
				search: `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase(),
			}));
		if (items.length === 0) {
			this.status = opts.requiresVision ? "没有具备读图能力的已认证模型" : "没有已认证的可用模型";
			return Promise.resolve(null);
		}
		return new Promise<string | null>((resolve) => {
			this.pickerDone = (v) => {
				this.picker = null;
				this.pickerDone = null;
				resolve(v);
				this.tui.requestRender();
			};
			this.picker = new ModelSelectOverlay(
				this.tui,
				this.theme,
				items,
				opts.current ?? "",
				(v) => this.pickerDone?.(v),
				{ title: opts.requiresVision ? "选择模型（需读图）" : "选择模型" },
			);
		});
	}

	// ---- 渲染 ----

	render(width: number): string[] {
		if (this.picker) return this.picker.render(width);
		const th = this.theme;
		const innerW = Math.max(30, width - 2);
		const { row, topBorder, bottomBorder } = createBoxRenderer(th, innerW);
		const lines: string[] = [];
		const tabName = this.tab === "purposes" ? "用途" : "策略槽";
		lines.push(topBorder(` ${th.fg("accent", "⚙ 模型配置")} ${th.fg("dim", `· ${tabName}`)} `));

		if (this.pending) {
			lines.push(row(""));
			for (const l of wrapText(this.pending?.text ?? "", innerW - 4)) lines.push(row(`  ${l}`));
			lines.push(row(""));
			lines.push(
				...renderChoiceList(
					th,
					[{ label: "继续（改为 auto 并由中心接管）" }, { label: "取消" }],
					this.confirmSel,
					{ width: innerW - 2 },
				).map((l) => row(`  ${l}`)),
			);
			lines.push(row(th.fg("dim", `  ↑↓ 选择 · Enter 确认 · Esc 返回`)));
			lines.push(bottomBorder());
			return lines;
		}

		if (this.strategyPickFor) {
			lines.push(row(th.fg("dim", `  为「${this.strategyPickFor.label}」选择策略`)));
			lines.push(row(""));
			const items: ChoiceItem[] = STRATEGIES.map((s) => ({
				label: `${s.padEnd(6)} ${STRATEGY_LABEL[s]}`,
				note: this.strategySummary(s).slice(0, 40),
			}));
			for (const l of renderChoiceList(th, items, this.strategyPickSel, { width: innerW - 2 })) lines.push(row(`  ${l}`));
			lines.push(row(th.fg("dim", "  ↑↓ 选择 · Enter 确认 · Esc 返回")));
			lines.push(bottomBorder());
			return lines;
		}

		if (this.actions) {
			const items: ChoiceItem[] = this.actions.map((a) => ({ label: a.label, note: a.note }));
			for (const l of renderChoiceList(th, items, this.actionSel, { width: innerW - 2 })) lines.push(row(`  ${l}`));
			lines.push(row(th.fg("dim", "  ↑↓ 选择 · Enter 执行 · Esc 返回")));
			lines.push(bottomBorder());
			return lines;
		}

		if (this.tab === "purposes") {
			if (this.purposes.length === 0) {
				lines.push(row(""));
				lines.push(row(th.fg("dim", "  暂无插件注册模型用途")));
			} else {
				const budget = mainBudget(this.tui.terminal.rows);
				if (this.purposeSel < this.purposeScroll) this.purposeScroll = this.purposeSel;
				else if (this.purposeSel >= this.purposeScroll + budget) this.purposeScroll = this.purposeSel - budget + 1;
				this.purposeScroll = Math.min(Math.max(0, this.purposeScroll), Math.max(0, this.purposes.length - budget));
				const visible = this.purposes.slice(this.purposeScroll, this.purposeScroll + budget);
				const leftPlain = visible.map((d) => `[${d.plugin}] ${d.label}${d.requiresVision ? " *" : ""}`);
				const colStart = this.columnStart(leftPlain, innerW);
				for (let i = 0; i < visible.length; i++) {
					const d = visible[i]!;
					const idx = this.purposeScroll + i;
					const left = `${th.fg("dim", `[${d.plugin}]`)} ${d.label}${d.requiresVision ? th.fg("warning", " *") : ""}`;
					lines.push(row(this.line(left, this.purposeSummary(d), idx === this.purposeSel, innerW, colStart)));
				}
				if (this.purposeScroll > 0) lines.push(row(th.fg("dim", `  ▲ 上方还有 ${this.purposeScroll} 行`)));
				const below = this.purposes.length - this.purposeScroll - visible.length;
				if (below > 0) lines.push(row(th.fg("dim", `  ▼ 下方还有 ${below} 行`)));
			}
		} else {
			const leftPlain = STRATEGIES.map((s) => `${s.padEnd(6)} ${STRATEGY_LABEL[s]}${s === "AUTO" || s === "FREE" ? "（固定语义）" : ""}`);
			const colStart = this.columnStart(leftPlain, innerW);
			for (let i = 0; i < STRATEGIES.length; i++) {
				const s = STRATEGIES[i]!;
				const fixed = s === "AUTO" || s === "FREE";
				const left = `${s.padEnd(6)} ${STRATEGY_LABEL[s]}${fixed ? th.fg("dim", "（固定语义）") : ""}`;
				lines.push(row(this.line(left, this.strategySummary(s), i === this.strategySel, innerW, colStart)));
			}
			lines.push(row(th.fg("dim", "  用途引用策略槽：改一次，所有引用该槽的用途一起生效")));
		}

		if (this.status) lines.push(row(th.fg("warning", `  ${this.status}`)));
		lines.push(
			row(
				th.fg(
					"dim",
					this.tab === "purposes"
						? "  ↑↓ 选择 · Tab 策略槽 · Enter 修改 · Esc 关闭 · 写入立即生效"
						: "  ↑↓ 选择 · Tab 用途 · Enter 修改 · Esc 关闭 · 写入立即生效",
				),
			),
		);
		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

/** 按显示宽度折行（确认页正文用；主页每行严禁折行） */
function wrapText(text: string, width: number): string[] {
	const out: string[] = [];
	let line = "";
	for (const ch of text) {
		if (ch === "\n") {
			out.push(line);
			line = "";
			continue;
		}
		if (visibleWidth(line + ch) > width) {
			out.push(line);
			line = ch;
			continue;
		}
		line += ch;
	}
	if (line) out.push(line);
	return out;
}
