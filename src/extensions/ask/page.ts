/**
 * ask/page：全屏问卷页 + 问卷选择器
 *
 * QuestionnairePage：整屏 overlay（width 100% / maxHeight 100% / 左上锚点）——pi 的 overlay
 * 合成是逐行不透明替换（compositeTuiLine），组件每次 render 输出恰好 termHeight 行、
 * 每行空格补齐到全宽，即完全遮蔽聊天区 / HUD / 编辑器，形成独立的「问卷页面」。
 * （非 overlay 的 ctx.ui.custom 只替换编辑器区域，不满足「屏蔽其余显示」。）
 *
 * 焦点模型：全部可交互行（选项行 / 其他输入行 / 文本输入行 / 评分行）拍平成行列表，
 * ↑↓（或 Tab/Shift+Tab）跨题移动，页面滚动跟随焦点。键位（与用户拍板一致）：
 * - 空格：选择题选中（单选/判断选中后自动前进到下一行；多选切换勾选，受 max 限制）
 * - Enter：提交问卷（必答未完成时跳到第一题未完成项并提示）；多行文本聚焦时 Shift+Enter 换行
 * - Esc：搁置（草稿写回文件，随时 /answer 继续）
 * - 判断题快捷 y/n；选择题数字键 1-9 直选；评分 ←→ 调档或数字键直选
 *
 * Focusable：focused 由 TUI 设置，文本行的反显光标经 renderScrollingInput 的
 * CURSOR_MARKER 透出（中文 IME 候选窗定位依赖它）。
 */
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createBoxRenderer, editInput, renderScrollingInput } from "../shared/ui";
import type { ListedQuestionnaire } from "./store";
import {
	answeredProgress,
	isAnswered,
	TYPE_TAGS,
	type AnswerMap,
	type AnswerValue,
	type Question,
	type Questionnaire,
} from "./types";

export interface PageResult {
	action: "submit" | "shelve";
	answers: AnswerMap;
}

/** 终端实际尺寸（由 overlayOptions.visible 回调每帧捕获，比 tui.terminal 更权威） */
export interface TermDims {
	w: number;
	h: number;
}

const OTHER_LABEL = "其他（自由输入）";
const MAX_TEXT_LENGTH = 4000;
const MULTILINE_WINDOW = 4;

/** 拍平后的可交互行 */
interface FocusRow {
	qid: string;
	kind: "option" | "other" | "input" | "rating";
	/** kind=option 时的选项下标 */
	opt?: number;
}

/** 每题的作答中状态（草稿恢复即从此初始化） */
interface QState {
	/** single/confirm 至多 1 个；multi 多个；元素为选项下标 */
	sel: Set<number>;
	other: string;
	otherCursor: number;
	text: string;
	cursor: number;
	rating: number | undefined;
}

export class QuestionnairePage {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private qn: Questionnaire;
	private done: (r: PageResult) => void;

	private states = new Map<string, QState>();
	private focusIdx = 0;
	private scroll = 0;
	/** 提交校验失败 / 选择超限等提示（warning 色，下一次有效操作清除） */
	private hint = "";
	/** 最近一次 render 的内容窗口行数（PgUp/PgDn 步长） */
	private lastBudget = 10;
	private dims?: TermDims;

	constructor(tui: TUI, theme: Theme, qn: Questionnaire, done: (r: PageResult) => void, dims?: TermDims) {
		this.tui = tui;
		this.theme = theme;
		this.qn = qn;
		this.done = done;
		this.dims = dims;
		this.initStates();
		this.initFocus();
	}

	/** 初始焦点：草稿重开时直接落到第一个未答必答题（全部已答则最后一行，便于直接 Enter 提交） */
	private initFocus(): void {
		const answers = this.collect();
		const rows = this.buildRows();
		for (const q of this.qn.questions) {
			if (q.required === false || isAnswered(q, answers[q.id])) continue;
			const at = rows.findIndex((r) => r.qid === q.id);
			if (at >= 0) {
				this.focusIdx = at;
				return;
			}
		}
		this.focusIdx = rows.length - 1;
	}

	// ---- 数据辅助 ----

	private stateOf(q: Question): QState {
		return this.states.get(q.id)!;
	}

	/** 题的展示选项：confirm 固定两项（可自定义标签）；single/multi 按 allowOther 追加「其他」 */
	private optionsFor(q: Question): { label: string; description?: string }[] {
		if (q.type === "confirm") {
			if (q.options && q.options.length >= 2) return q.options.slice(0, 2);
			return [{ label: "是" }, { label: "否" }];
		}
		const opts = [...(q.options ?? [])];
		if ((q.type === "single" || q.type === "multi") && q.allowOther !== false) {
			opts.push({ label: OTHER_LABEL, description: "自由输入" });
		}
		return opts;
	}

	/** 「其他」选项下标（无则 -1） */
	private otherIndex(q: Question): number {
		if (q.type !== "single" && q.type !== "multi") return -1;
		return q.allowOther !== false ? (q.options?.length ?? 0) : -1;
	}

	/** 从草稿答案恢复作答状态 */
	private initStates(): void {
		for (const q of this.qn.questions) {
			const st: QState = { sel: new Set(), other: "", otherCursor: 0, text: "", cursor: 0, rating: undefined };
			const v = this.qn.answers[q.id];
			if (v !== undefined) {
				const opts = this.optionsFor(q);
				const otherIdx = this.otherIndex(q);
				if (q.type === "single" && typeof v === "string") {
					const i = opts.findIndex((o) => o.label === v);
					if (i >= 0) st.sel.add(i);
					else if (otherIdx >= 0) {
						st.sel.add(otherIdx);
						st.other = v;
						st.otherCursor = v.length;
					}
				} else if (q.type === "confirm" && typeof v === "boolean") {
					st.sel.add(v ? 0 : 1);
				} else if (q.type === "multi" && Array.isArray(v)) {
					for (const item of v) {
						const i = opts.findIndex((o) => o.label === item);
						if (i >= 0) st.sel.add(i);
						else if (otherIdx >= 0 && typeof item === "string") {
							st.sel.add(otherIdx);
							st.other = item;
							st.otherCursor = item.length;
						}
					}
				} else if ((q.type === "text" || q.type === "number") && typeof v === "string") {
					st.text = v;
					st.cursor = v.length;
				} else if (q.type === "rating" && typeof v === "number") {
					st.rating = v;
				}
			}
			this.states.set(q.id, st);
		}
	}

	/** 拍平全部可交互行（渲染与键盘共用同一份顺序，二者必须严格一致） */
	private buildRows(): FocusRow[] {
		const rows: FocusRow[] = [];
		for (const q of this.qn.questions) {
			const st = this.stateOf(q);
			if (q.type === "single" || q.type === "confirm" || q.type === "multi") {
				const opts = this.optionsFor(q);
				for (let i = 0; i < opts.length; i++) rows.push({ qid: q.id, kind: "option", opt: i });
				const otherIdx = this.otherIndex(q);
				if (otherIdx >= 0 && st.sel.has(otherIdx)) rows.push({ qid: q.id, kind: "other" });
			} else if (q.type === "text" || q.type === "number") {
				rows.push({ qid: q.id, kind: "input" });
			} else {
				rows.push({ qid: q.id, kind: "rating" });
			}
		}
		return rows;
	}

	/** 收集当前答案（语义值；未作答题为 undefined） */
	private collect(): AnswerMap {
		const answers: AnswerMap = {};
		for (const q of this.qn.questions) {
			const st = this.stateOf(q);
			const opts = this.optionsFor(q);
			const otherIdx = this.otherIndex(q);
			let v: AnswerValue | undefined;
			if (q.type === "single") {
				const i = [...st.sel][0];
				if (i !== undefined) v = i === otherIdx ? st.other.trim() || undefined : opts[i]!.label;
			} else if (q.type === "confirm") {
				const i = [...st.sel][0];
				if (i !== undefined) v = i === 0;
			} else if (q.type === "multi") {
				const picked: string[] = [];
				for (const i of [...st.sel].sort((a, b) => a - b)) {
					if (i === otherIdx) {
						if (st.other.trim()) picked.push(st.other.trim());
					} else {
						picked.push(opts[i]!.label);
					}
				}
				if (picked.length > 0) v = picked;
			} else if (q.type === "text" || q.type === "number") {
				v = st.text;
			} else if (q.type === "rating") {
				v = st.rating;
			}
			answers[q.id] = v;
		}
		return answers;
	}

	/** 提交校验：必答完整性 + number 数值/范围；返回第一个未通过的题 */
	private firstInvalid(): { q: Question; reason: string } | null {
		const answers = this.collect();
		for (const q of this.qn.questions) {
			const v = answers[q.id];
			if (q.required !== false && !isAnswered(q, v)) return { q, reason: "尚未作答" };
			if (q.type === "number" && typeof v === "string" && v.trim()) {
				const n = Number(v);
				if (!Number.isFinite(n)) return { q, reason: "不是有效数字" };
				if (q.min !== undefined && n < q.min) return { q, reason: `不能小于 ${q.min}` };
				if (q.max !== undefined && n > q.max) return { q, reason: `不能大于 ${q.max}` };
			}
		}
		return null;
	}

	private trySubmit(): void {
		const bad = this.firstInvalid();
		if (!bad) {
			this.done({ action: "submit", answers: this.collect() });
			return;
		}
		const idx = this.qn.questions.indexOf(bad.q);
		this.hint = `第 ${idx + 1} 题${bad.reason}${bad.q.required !== false ? "（必答）" : ""}`;
		const rows = this.buildRows();
		const at = rows.findIndex((r) => r.qid === bad.q.id);
		if (at >= 0) this.focusIdx = at;
		this.tui.requestRender();
	}

	private moveFocus(rows: FocusRow[], delta: number): void {
		this.focusIdx = Math.max(0, Math.min(rows.length - 1, this.focusIdx + delta));
		this.tui.requestRender();
	}

	/** 单选/判断选中后的焦点移动：选「其他」→ 紧随的输入行；否则跳到下一题首行（末题则原地不动） */
	private advanceAfterSelect(rows: FocusRow[], q: Question, selectedIdx: number): void {
		if (selectedIdx === this.otherIndex(q)) {
			this.focusIdx = Math.min(rows.length - 1, this.focusIdx + 1);
			return;
		}
		let i = this.focusIdx + 1;
		while (i < rows.length && rows[i]!.qid === q.id) i++;
		if (i < rows.length) this.focusIdx = i;
	}

	// ---- 键盘 ----

	handleInput(data: string): void {
		const rows = this.buildRows();
		if (rows.length === 0) {
			if (matchesKey(data, Key.escape)) this.done({ action: "shelve", answers: {} });
			return;
		}
		if (this.focusIdx >= rows.length) this.focusIdx = rows.length - 1;
		const row = rows[this.focusIdx]!;
		const q = this.qn.questions.find((x) => x.id === row.qid)!;
		const st = this.stateOf(q);

		if (matchesKey(data, Key.escape)) {
			this.done({ action: "shelve", answers: this.collect() });
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "shift+tab")) {
			this.moveFocus(rows, -1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
			this.moveFocus(rows, +1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.moveFocus(rows, -this.lastBudget);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.moveFocus(rows, +this.lastBudget);
			return;
		}

		// 文本输入行（含「其他」自由输入）
		if (row.kind === "input" || row.kind === "other") {
			const multiline = row.kind === "input" && q.type === "text" && q.multiline === true;
			if (matchesKey(data, Key.enter)) {
				this.trySubmit();
				return;
			}
			if (multiline && matchesKey(data, "shift+enter")) {
				st.text = `${st.text.slice(0, st.cursor)}\n${st.text.slice(st.cursor)}`;
				st.cursor += 1;
				this.hint = "";
				this.tui.requestRender();
				return;
			}
			const cur = row.kind === "other" ? { text: st.other, cursor: st.otherCursor } : { text: st.text, cursor: st.cursor };
			const r = editInput(cur.text, cur.cursor, data, { maxLength: MAX_TEXT_LENGTH });
			if (r !== "skip") {
				if (row.kind === "other") {
					st.other = r.text;
					st.otherCursor = r.cursor;
				} else {
					st.text = r.text;
					st.cursor = r.cursor;
				}
				this.hint = "";
				this.tui.requestRender();
			}
			return; // 输入行消费其余所有键（防 y/n、数字键误触发）
		}

		// 评分行
		if (row.kind === "rating") {
			const min = q.min ?? 1;
			const max = q.max ?? 5;
			if (matchesKey(data, Key.left)) {
				st.rating = st.rating === undefined ? max : Math.max(min, st.rating - 1);
				this.hint = "";
				this.tui.requestRender();
			} else if (matchesKey(data, Key.right)) {
				st.rating = st.rating === undefined ? min : Math.min(max, st.rating + 1);
				this.hint = "";
				this.tui.requestRender();
			} else if (/^[0-9]$/.test(data)) {
				const n = Number(data);
				if (n >= min && n <= max) {
					st.rating = n;
					this.hint = "";
					this.tui.requestRender();
				}
			} else if (matchesKey(data, Key.enter)) {
				this.trySubmit();
			}
			return;
		}

		// 选项行
		if (row.kind === "option") {
			const opts = this.optionsFor(q);
			const select = (i: number) => {
				let adv = false;
				if (q.type === "single" || q.type === "confirm") {
					st.sel = new Set([i]);
					this.hint = "";
					adv = true;
				} else if (st.sel.has(i)) {
					st.sel.delete(i);
					this.hint = "";
				} else if (q.max !== undefined && st.sel.size >= q.max) {
					this.hint = `本题最多选 ${q.max} 项`;
				} else {
					st.sel.add(i);
					this.hint = "";
				}
				// 选择改变了行结构（「其他」输入行出现/消失），重建后再定位焦点
				if (adv) this.advanceAfterSelect(this.buildRows(), q, i);
				this.tui.requestRender();
			};
			if (matchesKey(data, Key.space)) {
				select(row.opt!);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.trySubmit();
				return;
			}
			// 判断题 y/n 快捷
			if (q.type === "confirm" && (data === "y" || data === "Y")) {
				select(0);
				return;
			}
			if (q.type === "confirm" && (data === "n" || data === "N")) {
				select(1);
				return;
			}
			// 数字键直选第 N 个选项
			if (/^[1-9]$/.test(data)) {
				const i = Number(data) - 1;
				if (i < opts.length) select(i);
				return;
			}
			return;
		}
	}

	// ---- 渲染 ----

	/** 单行文本输入行（单行简答/数字/其他输入） */
	private renderInputRow(
		text: string,
		cursor: number,
		placeholder: string | undefined,
		focused: boolean,
		W: number,
	): string {
		const th = this.theme;
		const prefix = focused ? th.fg("accent", " › ") : "   ";
		const showCursor = focused && this.focused;
		let display: string;
		if (text === "" && !showCursor) {
			display = th.fg("dim", placeholder ?? "（输入回答）");
		} else {
			display = renderScrollingInput(text, cursor, W - 6, { showCursor, inputOffset: 5 }).display;
		}
		return `${prefix} ✎ ${display}`;
	}

	/** 多行文本输入块（最多 MULTILINE_WINDOW 行窗口，光标所在行反显） */
	private renderMultilineRows(st: QState, focused: boolean, W: number): string[] {
		const th = this.theme;
		const all = st.text.split("\n");
		// 光标 → (行, 列)
		let cursorLine = all.length - 1;
		let col = 0;
		let acc = 0;
		for (let i = 0; i < all.length; i++) {
			const len = all[i]!.length;
			if (st.cursor <= acc + len) {
				cursorLine = i;
				col = st.cursor - acc;
				break;
			}
			acc += len + 1;
		}
		const start = Math.max(0, Math.min(cursorLine - 1, all.length - MULTILINE_WINDOW));
		const lines: string[] = [];
		if (st.text === "" && !(focused && this.focused)) {
			lines.push(`${focused ? th.fg("accent", " › ") : "   "} ${th.fg("dim", "│ （输入回答，Shift+Enter 换行）")}`);
			return lines;
		}
		for (let k = 0; k < Math.min(MULTILINE_WINDOW, all.length - start); k++) {
			const idx = start + k;
			const ln = all[idx]!;
			const isCursorLine = idx === cursorLine;
			const showCursor = focused && this.focused && isCursorLine;
			const { display } = renderScrollingInput(ln, isCursorLine ? col : 0, W - 8, {
				showCursor,
				inputOffset: 3,
			});
			const arrow = k === 0 ? (focused ? th.fg("accent", " › ") : "   ") : "   ";
			lines.push(`${arrow} ${th.fg("dim", "│")} ${display}`);
		}
		return lines;
	}

	render(width: number): string[] {
		const th = this.theme;
		const W = Math.max(24, width);
		// 高度权威来源：overlay visible 回调捕获的真实终端高度 > tui.terminal > 兜底 24
		const H = Math.max(10, (this.dims?.h ?? 0) > 0 ? this.dims!.h : this.tui.terminal.rows || 24);
		// 每行补满全宽：overlay 合成只替换组件宽度内的列，右侧留白会透出下层内容
		const padLine = (s: string): string => {
			const w = visibleWidth(s);
			return w >= W ? truncateToWidth(s, W) : s + " ".repeat(W - w);
		};

		// ---- 头部 ----
		const answers = this.collect();
		const doneCount = answeredProgress(this.qn, answers);
		const header: string[] = [];
		const titleText = ` 📝 ${this.qn.title}`;
		const progressText = `已答 ${doneCount}/${this.qn.questions.length} `;
		const gap = Math.max(1, W - visibleWidth(titleText) - visibleWidth(progressText));
		header.push(th.fg("accent", titleText) + " ".repeat(gap) + th.fg("dim", progressText));
		if (this.qn.description) header.push(th.fg("dim", `   ${this.qn.description}`));
		header.push(th.fg("borderMuted", "─".repeat(W)));

		// ---- 内容（rows 与渲染顺序严格一致，row 字段记录全局焦点行号） ----
		const rows = this.buildRows();
		if (this.focusIdx >= rows.length) this.focusIdx = rows.length - 1;
		const content: { text: string; row?: number }[] = [];
		let ri = 0;
		this.qn.questions.forEach((q, qi) => {
			const st = this.stateOf(q);
			content.push({ text: "" });
			const tag = TYPE_TAGS[q.type] + (q.required === false ? "·选填" : "");
			content.push({
				text: ` ${th.fg("accent", `${qi + 1}.`)} ${q.question} ${th.fg("dim", `[${tag}]`)}`,
			});
			if (q.description) content.push({ text: th.fg("dim", `    ${q.description}`) });

			while (ri < rows.length && rows[ri]!.qid === q.id) {
				const row = rows[ri]!;
				const focused = ri === this.focusIdx;
				if (row.kind === "option") {
					const opts = this.optionsFor(q);
					const o = opts[row.opt!]!;
					const isMulti = q.type === "multi";
					const mark = isMulti ? (st.sel.has(row.opt!) ? "[x]" : "[ ]") : st.sel.has(row.opt!) ? "●" : "○";
					const prefix = focused ? th.fg("accent", " › ") : "   ";
					const label = focused ? th.fg("accent", o.label) : o.label;
					const num = th.fg("dim", `${row.opt! + 1}.`);
					content.push({
						text: `${prefix}${num} ${mark} ${label}${o.description ? th.fg("dim", ` — ${o.description}`) : ""}`,
						row: ri,
					});
				} else if (row.kind === "other") {
					content.push({ text: this.renderInputRow(st.other, st.otherCursor, "填写其他内容…", focused, W), row: ri });
				} else if (row.kind === "input") {
					if (q.type === "text" && q.multiline) {
						const ml = this.renderMultilineRows(st, focused, W);
						ml.forEach((text, k) => content.push(k === 0 ? { text, row: ri } : { text }));
					} else {
						content.push({
							text: this.renderInputRow(st.text, st.cursor, q.placeholder, focused, W),
							row: ri,
						});
					}
				} else {
					const min = q.min ?? 1;
					const max = q.max ?? 5;
					const filled = st.rating === undefined ? 0 : st.rating - min + 1;
					const dots = Array.from({ length: max - min + 1 }, (_, k) => (k < filled ? "●" : "○")).join(" ");
					const prefix = focused ? th.fg("accent", " › ") : "   ";
					content.push({
						text:
							`${prefix} ${th.fg("dim", "‹")} ${dots} ${st.rating ?? "–"}/${max} ${th.fg("dim", "›")}` +
							(focused ? th.fg("dim", "   ←→ 调整 · 数字直选") : ""),
						row: ri,
					});
				}
				ri++;
			}

			// 多选计数提示
			if (q.type === "multi" && (q.max !== undefined || q.min !== undefined)) {
				const parts: string[] = [`已选 ${st.sel.size} 项`];
				if (q.min !== undefined) parts.push(`至少 ${q.min}`);
				if (q.max !== undefined) parts.push(`最多 ${q.max}`);
				content.push({ text: th.fg("dim", `      （${parts.join("，")}）`) });
			}
		});

		// ---- 底部 ----
		const missing = this.qn.questions.filter(
			(q) => q.required !== false && !isAnswered(q, answers[q.id]),
		).length;
		const statusLine = this.hint
			? th.fg("warning", ` ⚠ ${this.hint}`)
			: missing > 0
				? th.fg("dim", ` 还有 ${missing} 题必答未完成`)
				: th.fg("success", " ✓ 全部必答已完成，Enter 提交");
		const focusedRow = rows[this.focusIdx];
		const onMultiline =
			focusedRow?.kind === "input" &&
			this.qn.questions.find((x) => x.id === focusedRow.qid)?.multiline === true;
		const keysLine = th.fg(
			"dim",
			onMultiline
				? " ↑↓ 移动 · 空格 选择 · Enter 提交 · Shift+Enter 换行 · Esc 搁置"
				: " ↑↓ 移动 · 空格 选择 · Enter 提交 · Esc 搁置",
		);

		// ---- 组装：头 + 滚动内容窗 + 底，恰好 H 行 ----
		const budget = Math.max(1, H - header.length - 2);
		this.lastBudget = budget;
		const focusLine = content.findIndex((c) => c.row === this.focusIdx);
		if (focusLine >= 0) {
			if (focusLine < this.scroll) this.scroll = focusLine;
			if (focusLine >= this.scroll + budget) this.scroll = focusLine - budget + 1;
		}
		const maxScroll = Math.max(0, content.length - budget);
		this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
		const visible = content.slice(this.scroll, this.scroll + budget);
		// 滚动指示：窗口外还有内容时在边界行提示（否则用户会以为题目缺失）
		if (this.scroll > 0 && visible.length > 0) {
			visible[0] = { text: th.fg("dim", `   ▲ 上方还有 ${this.scroll} 行（PgUp 翻页）`) };
		}
		const below = content.length - (this.scroll + visible.length);
		if (below > 0 && visible.length > 1) {
			visible[visible.length - 1] = { text: th.fg("dim", `   ▼ 下方还有 ${below} 行（PgDn 翻页）`) };
		}

		const lines = [...header, ...visible.map((c) => c.text)];
		while (lines.length < header.length + budget) lines.push("");
		lines.push(statusLine, keysLine);
		return lines.slice(0, H).map(padLine);
	}

	invalidate(): void {}
	dispose(): void {}
}

/**
 * 问卷选择器（/answer 多份待答时）：居中小浮层，↑↓ 选择、Enter 打开、Esc 取消。
 * done(null) 表示取消，否则为选中问卷的文件路径。
 */
export class QuestionnairePicker {
	focused = false;

	private theme: Theme;
	private items: ListedQuestionnaire[];
	private done: (file: string | null) => void;
	private idx = 0;

	private static MAX_ROWS = 12;

	constructor(theme: Theme, items: ListedQuestionnaire[], done: (file: string | null) => void) {
		this.theme = theme;
		this.items = items;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.idx = Math.max(0, this.idx - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.idx = Math.min(this.items.length - 1, this.idx + 1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done(this.items[this.idx]!.file);
			return;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const { row, topBorder, bottomBorder } = createBoxRenderer(th, Math.max(10, width - 2));
		const lines: string[] = [topBorder(" 选择要回答的问卷 ")];
		// 窗口跟随选中项
		const budget = QuestionnairePicker.MAX_ROWS;
		const start = Math.max(0, Math.min(this.idx - Math.floor(budget / 2), this.items.length - budget));
		const view = this.items.slice(start, start + budget);
		view.forEach((item, k) => {
			const i = start + k;
			const q = item.q;
			const answered = answeredProgress(q, q.answers);
			const meta = th.fg(
				"dim",
				`（${q.id} · ${q.questions.length} 题${answered > 0 ? ` · 已答 ${answered}` : ""}${q.status === "draft" ? " · 草稿" : ""}）`,
			);
			const prefix = i === this.idx ? th.fg("accent", " › ") : "   ";
			const title = i === this.idx ? th.fg("accent", q.title) : q.title;
			lines.push(row(`${prefix}📝 ${title} ${meta}`));
		});
		lines.push(row(th.fg("dim", " ↑↓ 选择 · Enter 打开 · Esc 取消")));
		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
