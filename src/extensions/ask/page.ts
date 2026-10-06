/**
 * ask/page：全屏问卷页 + 问卷选择器
 *
 * QuestionnairePage：整屏 overlay（width 100% / maxHeight 100% / 左上锚点）——pi 的 overlay
 * 合成是逐行不透明替换（compositeTuiLine），组件每次 render 输出恰好 termHeight 行、
 * 每行空格补齐到全宽，即完全遮蔽聊天区 / HUD / 编辑器，形成独立的「问卷页面」。
 * （非 overlay 的 ctx.ui.custom 只替换编辑器区域，不满足「屏蔽其余显示」。）
 *
 * 焦点模型：全部可交互行（选项行 / 其他输入行 / 文本输入行 / 评分行）拍平成行列表，
 * ↑↓（或 Tab/Shift+Tab）跨题移动，页面滚动跟随焦点。长文本（标题/题干/选项/说明）
 * 经 wrapTextWithAnsi 按终端宽度折行完整展示（不截断），续行缩进对齐首行文本起点；
 * 输入行仍单行水平滚动（renderScrollingInput）。
 *
 * note 说明题：只读块（不产生焦点行、不进必答校验、不计入进度分母），正文经
 * shared/markdown 轻渲染后挂在「│ 」左边线下展示；超过 NOTE_FOLD_LINES 行默认折叠，
 * x 键展开/收起。长草稿审阅场景靠 Ctrl+↑/↓ 跳题 + PgUp/PgDn 翻页完成浏览。
 * 问卷级 context（AI 补充背景/上一条回复）：渲染为引用块放在**可滚动内容区**开头
 * （首帧 scroll=0 时即在顶部，视觉与原先固定头部一致），折叠与说明题共享 x 键
 * （CONTEXT_FOLD_LINES 阈值更严，辅助信息不喧宾夺主）。展开后随内容区滚动，
 * 不再受固定头部截断；鼠标滚轮直接滚动内容窗（handleMouse wheel，不挪焦点）。
 *
 * 键位（? 键可随时查看本表）：
 * - 空格：选择题选中（单选/判断选中后自动前进到下一行；多选切换勾选，受 max 限制）
 * - Enter：提交问卷（必答未完成时跳到第一题未完成项并提示）；多行文本聚焦时 Shift+Enter 换行
 * - 强制提交：被必答校验拦下后 1 秒内再按一次 Enter 即跳过未答直接提交（连按两次，不依赖终端；
 *   超时未按则自动复原并撤掉那条提示，中间夹其他按键同样解除）
 * - Esc：搁置（草稿写回文件，随时 /answer 继续）
 * - 判断题快捷 y/n；选择题数字键 1-9 直选；评分 ←→ 调档或数字键直选
 * - Ctrl+↑/↓ 上/下一题；PgUp/PgDn 按屏翻页；多行文本内 ↑↓ 行间移动（边界处才跳出本题）
 * - Ctrl+P 答案一览（C 复制答案到剪贴板）；x 展开/收起长说明
 * - Ctrl+D（或非输入行上的 D）删除问卷，按两次确认
 *
 * Focusable：focused 由 TUI 设置，文本行的反显光标经 renderScrollingInput 的
 * CURSOR_MARKER 透出（中文 IME 候选窗定位依赖它）。
 */
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderAnswer } from "../shared/markdown";
import { createBoxRenderer, editInput, ratingIndicator, renderChoiceList, renderScrollingInput, wrapIndented } from "../shared/ui";
import type { ListedQuestionnaire } from "./store";
import {
	answeredProgress,
	answerableQuestions,
	formatAnswersMessage,
	formatValue,
	isAnswered,
	TYPE_TAGS,
	type AnswerMap,
	type AnswerValue,
	type Question,
	type Questionnaire,
} from "./types";

export interface PageResult {
	action: "submit" | "shelve" | "delete";
	answers: AnswerMap;
}

/** 终端实际尺寸（由 overlayOptions.visible 回调每帧捕获，比 tui.terminal 更权威） */
export interface TermDims {
	w: number;
	h: number;
}

/** 页面钩子（tool/commands 注入；缺失时对应能力降级为提示） */
export interface PageHooks {
	/** 把文本写入系统剪贴板（pi 官方 copyToClipboard 包装） */
	copyText?: (text: string) => Promise<void>;
}

const OTHER_LABEL = "其他（自由输入）";
const MAX_TEXT_LENGTH = 4000;
/** 连按两次 Enter 强制提交的窗口：首次被拦下后这段时间内再按一次才生效（超时复原并撤提示） */
const FORCE_SUBMIT_WINDOW_MS = 1000;
const MULTILINE_WINDOW = 4;
/** 说明题正文折叠阈值（超过则默认只显示前 N 行，x 键展开） */
const NOTE_FOLD_LINES = 20;
/** 问卷级上下文块折叠阈值（比说明题更严：上下文是辅助信息，不能喧宾夺主） */
const CONTEXT_FOLD_LINES = 8;
/** 说明题左边线（含两侧空格） */
const NOTE_GUTTER = " │ ";

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

/** 光标 index → (行号, 行内列)；供多行文本 ↑↓ 行间移动 */
function caretLineCol(text: string, cursor: number): { line: number; col: number } {
	let acc = 0;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const len = lines[i]!.length;
		if (cursor <= acc + len) return { line: i, col: cursor - acc };
		acc += len + 1;
	}
	const last = lines.length - 1;
	return { line: last, col: lines[last]!.length };
}

/** (行号, 行内列) → 光标 index（目标行较短时贴行尾） */
function lineColToCaret(text: string, line: number, col: number): number {
	const lines = text.split("\n");
	const l = Math.max(0, Math.min(line, lines.length - 1));
	let acc = 0;
	for (let i = 0; i < l; i++) acc += lines[i]!.length + 1;
	return acc + Math.min(col, lines[l]!.length);
}

export class QuestionnairePage {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private qn: Questionnaire;
	private done: (r: PageResult) => void;
	private hooks: PageHooks;

	private states = new Map<string, QState>();
	private focusIdx = 0;
	private scroll = 0;
	/** 提交校验失败 / 选择超限等提示（warning 色，下一次有效操作清除） */
	private hint = "";
	/** 操作成功短提示（复制完成 / 删除待确认，success 色，下一次有效操作清除） */
	private flash = "";
	/** 页面形态：form 作答 / help 键位表 / review 答案一览 */
	private mode: "form" | "help" | "review" = "form";
	/** 删除二次确认已就绪 */
	private deleteArmed = false;
	/** 强制提交已就绪：首次 Enter 被必答校验拦下后置位，FORCE_SUBMIT_WINDOW_MS 内再按一次 Enter 生效 */
	private forceArmed = false;
	/** 窗口计时器：到点自动复原 armed 并撤掉那条提示（盯着看几秒再按不算连按） */
	private forceTimer: ReturnType<typeof setTimeout> | undefined;
	/** armed 时的提示文本：超时复原时只撤这一条（提示可能已被别的消息替换） */
	private forceHint = "";
	/** 说明题正文展开态 */
	private expandNotes = false;
	/** 是否已按焦点自动滚动（首帧保持滚到顶部：说明题从头读，不被下方焦点行拽走） */
	private followFocus = false;
	/** 最近一次 render 的内容窗口行数（PgUp/PgDn 步长） */
	private lastBudget = 10;
	/** 答案一览的滚动位置（滚轮） */
	private reviewScroll = 0;
	private dims?: TermDims;

	constructor(tui: TUI, theme: Theme, qn: Questionnaire, done: (r: PageResult) => void, dims?: TermDims, hooks?: PageHooks) {
		this.tui = tui;
		this.theme = theme;
		this.qn = qn;
		this.done = done;
		this.hooks = hooks ?? {};
		this.dims = dims;
		this.initStates();
		this.initFocus();
	}

	/** 初始焦点：草稿重开时直接落到第一个未答必答题（全部已答则最后一行，便于直接 Enter 提交） */
	private initFocus(): void {
		const answers = this.collect();
		const rows = this.buildRows();
		if (rows.length === 0) {
			this.focusIdx = 0;
			return;
		}
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

	/** 拍平全部可交互行（渲染与键盘共用同一份顺序，二者必须严格一致）；note 只读不产生行 */
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
			} else if (q.type === "rating") {
				rows.push({ qid: q.id, kind: "rating" });
			}
		}
		return rows;
	}

	/** 收集当前答案（语义值；未作答题为 undefined） */
	private collect(): AnswerMap {
		const answers: AnswerMap = {};
		for (const q of this.qn.questions) {
			if (q.type === "note") continue;
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

	/** 勾了「其他（自由输入）」却没填内容：单选/多选都会静默变成未作答，需专门提示 */
	private otherUnfilled(q: Question): boolean {
		if (q.type !== "single" && q.type !== "multi") return false;
		const st = this.stateOf(q);
		const idx = this.otherIndex(q);
		return idx >= 0 && st.sel.has(idx) && st.other.trim() === "";
	}

	/** 提交校验：必答完整性 + number 数值/范围；返回第一个未通过的题 */
	private firstInvalid(): { q: Question; reason: string } | null {
		const answers = this.collect();
		for (const q of this.qn.questions) {
			const v = answers[q.id];
			if (q.required !== false && !isAnswered(q, v))
				return {
					q,
					reason: this.otherUnfilled(q) ? "选了「其他」但未填写内容" : "尚未作答",
				};
			if (q.type === "number" && typeof v === "string" && v.trim()) {
				const n = Number(v);
				if (!Number.isFinite(n)) return { q, reason: "不是有效数字" };
				if (q.min !== undefined && n < q.min) return { q, reason: `不能小于 ${q.min}` };
				if (q.max !== undefined && n > q.max) return { q, reason: `不能大于 ${q.max}` };
			}
		}
		return null;
	}

	/** 提交：先按普通 Enter 校验；被拦下后再按一次 Enter（force）即跳过未答直接提交 */
	private trySubmit(force = false): void {
		const bad = this.firstInvalid();
		if (!bad || force) {
			this.done({ action: "submit", answers: this.collect() });
			return;
		}
		const idx = answerableQuestions(this.qn).indexOf(bad.q);
		const total = answerableQuestions(this.qn).length;
		this.hint = `第 ${idx + 1}/${total} 题：${bad.reason}${bad.q.required !== false ? "（必答）" : "（已填内容需合法，清空可跳过）"} · 再按 Enter 跳过`;
		this.forceArmed = true;
		this.forceHint = this.hint;
		clearTimeout(this.forceTimer);
		this.forceTimer = setTimeout(() => {
			this.forceArmed = false;
			if (this.hint === this.forceHint) this.hint = "";
			this.tui.requestRender();
		}, FORCE_SUBMIT_WINDOW_MS);
		this.flash = "";
		const rows = this.buildRows();
		const at = rows.findIndex((r) => r.qid === bad.q.id);
		if (at >= 0) this.focusIdx = at;
		this.tui.requestRender();
	}

	private moveFocus(rows: FocusRow[], delta: number): void {
		if (rows.length === 0) return;
		this.focusIdx = Math.max(0, Math.min(rows.length - 1, this.focusIdx + delta));
		this.tui.requestRender();
	}

	/** Ctrl+↑/↓：跳到上/下一题的首行（长问卷 + 长说明题里免逐行滚） */
	private jumpQuestion(rows: FocusRow[], dir: -1 | 1): void {
		if (rows.length === 0) return;
		const cur = rows[this.focusIdx]?.qid;
		if (cur === undefined) return;
		let first = this.focusIdx;
		while (first > 0 && rows[first - 1]!.qid === cur) first--;
		if (dir === 1) {
			let j = first;
			while (j < rows.length && rows[j]!.qid === cur) j++;
			if (j < rows.length) this.focusIdx = j;
		} else {
			let j = first - 1;
			if (j < 0) return;
			const prevQid = rows[j]!.qid;
			while (j > 0 && rows[j - 1]!.qid === prevQid) j--;
			this.focusIdx = j;
		}
		this.tui.requestRender();
	}

	/** 多行文本内 ↑↓：行间移动光标；已在首/末行则把焦点移出本题 */
	private moveMultiline(st: QState, dir: -1 | 1, rows: FocusRow[]): void {
		const { line, col } = caretLineCol(st.text, st.cursor);
		const total = st.text.split("\n").length;
		const target = line + dir;
		if (target < 0 || target >= total) {
			this.moveFocus(rows, dir);
			return;
		}
		st.cursor = lineColToCaret(st.text, target, col);
		this.hint = "";
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

	/** 答案一览数据：可答题逐条列出，说明题标为只读 */
	private reviewEntries(): { label: string; value: string; dim: boolean }[] {
		const answers = this.collect();
		const out: { label: string; value: string; dim: boolean }[] = [];
		let n = 0;
		for (const q of this.qn.questions) {
			if (q.type === "note") {
				out.push({ label: q.question, value: "（只读说明）", dim: true });
				continue;
			}
			n++;
			const v = answers[q.id];
			const empty =
				v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);
			out.push({
				label: `${n}. ${q.question}`,
				value: empty ? (q.required === false ? "（选填 · 已跳过）" : "（必答 · 未完成）") : formatValue(q, v!),
				dim: empty,
			});
		}
		return out;
	}

	/** 答案一览的纯文本（供复制；与回执同格式，说明题不占行） */
	private reviewPlainText(): string {
		return formatAnswersMessage(this.qn, this.collect());
	}

	// ---- 键盘 ----

	handleInput(data: string): void {
		// 帮助 / 答案一览是临时页面：任意键（或同一快捷键）返回作答页
		if (this.mode === "help") {
			this.mode = "form";
			this.tui.requestRender();
			return;
		}
		if (this.mode === "review") {
			if (matchesKey(data, "c") || data === "C") {
				void this.copyAnswers();
				return;
			}
			this.mode = "form";
			this.tui.requestRender();
			return;
		}

		const rows = this.buildRows();
		if (this.focusIdx >= rows.length) this.focusIdx = rows.length - 1;
		const row = this.focusIdx >= 0 ? rows[this.focusIdx] : undefined;
		const q = row ? this.qn.questions.find((x) => x.id === row.qid)! : undefined;
		const st = q ? this.stateOf(q) : undefined;
		/** 输入行里普通字符归输入法（?/x/D 等单字符快捷键必须让位） */
		const typing = row?.kind === "input" || row?.kind === "other";
		const wasArmed = this.deleteArmed;
		this.deleteArmed = false;
		const forceArmed = this.forceArmed;
		this.forceArmed = false;
		clearTimeout(this.forceTimer);
		this.flash = "";

		if (matchesKey(data, Key.escape)) {
			this.done({ action: "shelve", answers: this.collect() });
			return;
		}
		if (!typing && data === "?") {
			this.mode = "help";
			this.hint = "";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+p")) {
			this.mode = "review";
			this.reviewScroll = 0;
			this.hint = "";
			this.tui.requestRender();
			return;
		}
		// 删除问卷：Ctrl+D 任意位置可用；非输入行上也可直接按 D
		if (matchesKey(data, "ctrl+d") || (!typing && data === "D")) {
			if (wasArmed) {
				this.done({ action: "delete", answers: this.collect() });
				return;
			}
			this.deleteArmed = true;
			this.hint = "";
			this.flash = "再按一次确认删除（问卷作废、AI 不再等待，不可恢复；只想稍后答请按 Esc）";
			this.tui.requestRender();
			return;
		}
		if (!typing && data === "x") {
			this.expandNotes = !this.expandNotes;
			this.hint = "";
			this.tui.requestRender();
			return;
		}
		// 以下为作答/导航类按键：恢复「滚动跟随焦点」（初始帧停在顶部，先读说明再作答）
		this.followFocus = true;
		if (matchesKey(data, "ctrl+up")) {
			this.jumpQuestion(rows, -1);
			return;
		}
		if (matchesKey(data, "ctrl+down")) {
			this.jumpQuestion(rows, +1);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "shift+tab")) {
			if (row?.kind === "input" && q?.type === "text" && q.multiline === true && st) {
				this.moveMultiline(st, -1, rows);
				return;
			}
			this.moveFocus(rows, -1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
			if (row?.kind === "input" && q?.type === "text" && q.multiline === true && st) {
				this.moveMultiline(st, +1, rows);
				return;
			}
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

		// 纯说明问卷（无任何可交互行）：只需提交 / 删除 / 帮助
		if (!row || !q || !st) {
			if (matchesKey(data, Key.enter)) this.trySubmit(forceArmed);
			return;
		}

		// 文本输入行（含「其他」自由输入）
		if (row.kind === "input" || row.kind === "other") {
			const multiline = row.kind === "input" && q.type === "text" && q.multiline === true;
			if (matchesKey(data, Key.enter)) {
				this.trySubmit(forceArmed);
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
				} else {
					this.hint = `本评分范围是 ${min}-${max}`;
				}
				this.tui.requestRender();
			} else if (matchesKey(data, Key.enter)) {
				this.trySubmit(forceArmed);
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
				this.trySubmit(forceArmed);
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

	/** 鼠标滚轮：直接滚动内容窗（不挪焦点，下次方向键导航时视图再吸附焦点行）；
	 *  整屏 overlay 吞掉滚轮事件，避免穿透滚动底层聊天 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		if (this.mode === "review") {
			this.reviewScroll = Math.max(0, this.reviewScroll + event.wheelDelta);
			return { handled: true };
		}
		if (this.mode === "form") {
			this.scroll += event.wheelDelta; // 上界由 render 按 maxScroll 收敛
			return { handled: true };
		}
		return { handled: true };
	}

	/** Ctrl+P 答案一览里按 C：把答案文本写入系统剪贴板 */
	private async copyAnswers(): Promise<void> {
		const text = this.reviewPlainText();
		if (!this.hooks.copyText) {
			this.flash = "当前环境不支持复制；答案会在提交后发给 AI";
			this.tui.requestRender();
			return;
		}
		try {
			await this.hooks.copyText(text);
			this.flash = `✓ 答案已复制到剪贴板（${text.length} 字符）`;
		} catch (e) {
			this.flash = `复制失败：${e instanceof Error ? e.message : String(e)}`;
		}
		this.tui.requestRender();
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

	/** 多行文本输入块（最多 MULTILINE_WINDOW 行窗口，光标所在行反显；光标行随 ↑↓ 移动） */
	private renderMultilineRows(st: QState, focused: boolean, W: number): string[] {
		const th = this.theme;
		const all = st.text.split("\n");
		const { line: cursorLine, col } = caretLineCol(st.text, st.cursor);
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

	/** note 说明题正文块（│ 左边线 + markdown 轻渲染；超长默认折叠，提示置顶以免被窗口截在下方） */
	private renderNoteBlock(q: Question, W: number): string[] {
		const th = this.theme;
		const gutterColor = q.style === "warn" ? "warning" : q.style === "quote" ? "borderMuted" : "accent";
		const gutter = th.fg(gutterColor, NOTE_GUTTER);
		const bodyW = Math.max(8, W - visibleWidth(NOTE_GUTTER));
		const full = renderAnswer(q.content ?? "", th, bodyW, { indent: "" });
		const out: string[] = [];
		const long = full.length > NOTE_FOLD_LINES;
		if (long && !this.expandNotes) {
			const hidden = full.length - NOTE_FOLD_LINES;
			out.push(gutter + th.fg("dim", `共 ${full.length} 行说明 · 已折叠显示前 ${NOTE_FOLD_LINES} 行（x 展开全文）`));
			out.push(...full.slice(0, NOTE_FOLD_LINES).map((l) => gutter + l));
			out.push(gutter + th.fg("dim", `⋯ 还有 ${hidden} 行未显示（x 展开）`));
			return out;
		}
		if (long) out.push(gutter + th.fg("dim", `完整说明（${full.length} 行）· x 收起`));
		out.push(...full.map((l) => gutter + l));
		return out;
	}

	/** 问卷级上下文块（AI 的补充背景/上一条回复；引用样式 │ 左边线，超长折叠共享 x 键） */
	private renderContextBlock(W: number): string[] {
		const th = this.theme;
		const gutter = th.fg("borderMuted", NOTE_GUTTER);
		const bodyW = Math.max(8, W - visibleWidth(NOTE_GUTTER));
		const full = renderAnswer(this.qn.context ?? "", th, bodyW, { indent: "" });
		const long = full.length > CONTEXT_FOLD_LINES;
		const tag = long ? (this.expandNotes ? `（${full.length} 行 · x 收起）` : `（共 ${full.length} 行 · 已折叠，x 展开）`) : "";
		const out: string[] = [` ${th.fg("dim", "💬 上下文")}${th.fg("dim", tag)}`];
		const shown = long && !this.expandNotes ? full.slice(0, CONTEXT_FOLD_LINES) : full;
		out.push(...shown.map((l) => gutter + l));
		if (long && !this.expandNotes) {
			out.push(gutter + th.fg("dim", `⋯ 还有 ${full.length - CONTEXT_FOLD_LINES} 行（x 展开）`));
		}
		return out;
	}

	/** 头部：标题 + 进度条/进度 + 问卷说明 + 分隔线（上下文块在可滚动内容区开头，见 render） */
	private renderHeader(W: number): string[] {
		const th = this.theme;
		const answers = this.collect();
		const total = answerableQuestions(this.qn).length;
		const doneCount = answeredProgress(this.qn, answers);
		const header: string[] = [];
		const titleText = ` 📝 ${this.qn.title}`;
		let progressText: string;
		if (total === 0) {
			progressText = "仅说明 · Enter 确认 ";
		} else {
			const barW = Math.min(12, total);
			const filled = Math.min(barW, Math.round((doneCount / total) * barW));
			const bar = "▰".repeat(filled) + "▱".repeat(barW - filled);
			// 分母含选填题：必答已齐但选填未答时明说，避免与状态行「可以提交」打架
			const pending = answerableQuestions(this.qn).filter(
				(q) => q.required !== false && !isAnswered(q, answers[q.id]),
			).length;
			const tail = pending === 0 ? "（必答已齐，余为选填）" : "";
			progressText = `已答 ${doneCount}/${total} ${bar}${tail} `;
		}
		// 标题 + 进度一行放不下时折行完整展示（不截断）
		if (visibleWidth(titleText) + visibleWidth(progressText) + 1 <= W) {
			const gap = Math.max(1, W - visibleWidth(titleText) - visibleWidth(progressText));
			header.push(th.fg("accent", titleText) + " ".repeat(gap) + th.fg("dim", progressText));
		} else {
			header.push(...wrapTextWithAnsi(`${th.fg("accent", titleText)} ${th.fg("dim", progressText)}`, W));
		}
		if (this.qn.description) {
			for (const ln of wrapTextWithAnsi(th.fg("dim", this.qn.description), Math.max(8, W - 3))) {
				header.push(`   ${ln}`);
			}
		}
		header.push(th.fg("borderMuted", "─".repeat(W)));
		return header;
	}

	/** 帮助屏：完整键位表（任意键返回） */
	private renderHelp(W: number, H: number): string[] {
		const th = this.theme;
		const sections: [string, [string, string][]][] = [
			[
				"移动",
				[
					["↑ ↓ / Tab / Shift+Tab", "上/下一行（多行简答内为行间移动光标）"],
					["Ctrl+↑ / Ctrl+↓", "上一题 / 下一题"],
					["PgUp / PgDn / 滚轮", "按屏翻页 / 滚动页面（长上下文·长说明）"],
				],
			],
			[
				"作答",
				[
					["空格", "选中（单选/判断选中后自动前进；多选切换勾选）"],
					["1-9", "数字直选第 N 个选项 / 评分档位"],
					["y / n", "判断题快捷作答"],
					["← →", "评分调档"],
					["Enter", "提交（必答未完成会跳到该题）"],
					["Enter ×2", "1 秒内连按两次，跳过未完成的必答项直接提交"],
					["Shift+Enter", "多行简答内换行"],
				],
			],
			[
				"输入编辑",
				[
					["← → / Ctrl+← →", "光标移动（按字符 / 按词）"],
					["Ctrl+W", "删除前一个词"],
					["Ctrl+U", "清空当前输入"],
					["粘贴", "直接 Ctrl+V（含多行文本）"],
				],
			],
			[
				"其他",
				[
					["Ctrl+P", "答案一览（一览里按 C 复制答案到剪贴板）"],
					["x", "展开 / 收起超长说明与上下文"],
					["Ctrl+D / D", "删除这份问卷（按两次确认；问卷作废、AI 不再等待，不可恢复）"],
					["?", "本帮助"],
					["Esc", "搁置：存草稿退出，随时 /answer 续答（AI 会收到「已搁置」）"],
				],
			],
		];
		const build = (spacing: boolean): string[] => {
			const lines: string[] = [
				th.fg("accent", " ⌨ 问卷页键位表") + th.fg("dim", `（${this.qn.questions.length} 题 · 任意键返回）`),
			];
			if (spacing) lines.push("");
			for (const [title, rows] of sections) {
				lines.push(th.fg("dim", ` ${title}`));
				for (const [k, d] of rows) {
					const keyCol = `   ${th.fg("accent", k.padEnd(22))}`;
					const parts = wrapTextWithAnsi(th.fg("dim", d), Math.max(8, W - 25));
					parts.forEach((p, i) => lines.push(i === 0 ? keyCol + p : `   ${" ".repeat(22)}${p}`));
				}
				if (spacing) lines.push("");
			}
			return lines;
		};
		// 先试带空行的疏排版；终端太矮时改紧凑排版（键位表要能看到底，不能被截断）
		let out = build(true);
		if (out.length > H) out = build(false);
		while (out.length < H) out.push("");
		return out.slice(0, H);
	}

	/** 答案一览屏（Ctrl+P）：C 复制、滚轮滚动、其余键返回 */
	private renderReview(W: number, H: number): string[] {
		const th = this.theme;
		const lines: string[] = [
			th.fg("accent", " 📋 答案一览") + th.fg("dim", ` ·「${this.qn.title}」`),
			th.fg("borderMuted", "─".repeat(W)),
		];
		for (const e of this.reviewEntries()) {
			const label = e.dim ? th.fg("dim", e.label) : e.label;
			const value = e.dim ? th.fg("dim", e.value) : th.fg("success", e.value);
			lines.push(...wrapTextWithAnsi(` ${label} → ${value}`, Math.max(8, W - 1)).map((l, i) => (i === 0 ? l : `   ${l}`)));
		}
		const footer = [
			this.flash ? th.fg("success", ` ${this.flash}`) : "",
			th.fg("dim", " 此页不提交；必答未完成时 Enter 仍会跳到该题"),
			th.fg("dim", " C 复制答案到剪贴板 · 滚轮滚动 · 任意键返回作答"),
		].filter(Boolean);
		const budget = Math.max(1, H - footer.length);
		this.reviewScroll = Math.max(0, Math.min(this.reviewScroll, lines.length - budget));
		const above = this.reviewScroll;
		const below = lines.length - (this.reviewScroll + Math.min(budget, lines.length - this.reviewScroll));
		const body = lines.slice(this.reviewScroll, this.reviewScroll + budget);
		if (above > 0) body[0] = th.fg("dim", ` ▲ 上方还有 ${above} 行`);
		if (below > 0) body[body.length - 1] = th.fg("dim", ` ▼ 下方还有 ${below} 行`);
		while (body.length < budget) body.push("");
		return [...body, ...footer];
	}

	render(width: number): string[] {
		const th = this.theme;
		const W = Math.max(24, width);
		// 高度权威来源：overlay visible 回调捕获的真实终端高度 > tui.terminal > 兜底 24
		const H = Math.max(10, (this.dims?.h ?? 0) > 0 ? this.dims!.h : this.tui.terminal.rows || 24);
		// 每行补满全宽：overlay 合成只替换组件宽度内的列，右侧留白会透出下层内容
		const padLine = (s: string): string => {
			const w = visibleWidth(s);
			if (w <= W) return s + " ".repeat(W - w);
			const t = truncateToWidth(s, W); // 可能比 W 短 1 列（省略号）——补足到恰好 W
			const tw = visibleWidth(t);
			return tw < W ? t + " ".repeat(W - tw) : t;
		};

		if (this.mode === "help") return this.renderHelp(W, H).map(padLine);
		if (this.mode === "review") return this.renderReview(W, H).map(padLine);

		const header = this.renderHeader(W);

		// ---- 内容（rows 与渲染顺序严格一致，row 字段记录全局焦点行号） ----
		const rows = this.buildRows();
		if (this.focusIdx >= rows.length) this.focusIdx = rows.length - 1;
		const content: { text: string; row?: number }[] = [];
		// 问卷级上下文放内容区开头：展开后随窗口滚动可达全文，不被固定头部截断
		if (this.qn.context) {
			content.push(...this.renderContextBlock(W).map((text) => ({ text })));
		}
		let ri = 0;
		/** 长逻辑行折行推入 content：prefix（含 ANSI）定首行起点与续行缩进，body 折行不截断；row 焦点标记只挂在首行 */
		const pushWrapped = (prefix: string, body: string, row?: number): void => {
			const indent = visibleWidth(prefix);
			wrapIndented(body, W, indent).forEach((p, k) => content.push(k === 0 ? { text: prefix + p.trimStart(), row } : { text: p }));
		};
		const answerable = answerableQuestions(this.qn);
		this.qn.questions.forEach((q) => {
			const st = this.stateOf(q);
			content.push({ text: "" });
			const num = q.type === "note" ? "" : `${answerable.indexOf(q) + 1}. `;
			const tag = TYPE_TAGS[q.type] + (q.type === "note" ? "" : q.required === false ? "·选填" : "");
			const icon = q.type === "note" ? "🗒 " : "";
			pushWrapped(` ${th.fg("accent", num)}`, `${icon}${q.question} ${th.fg("dim", `[${tag}]`)}`);
			if (q.description) pushWrapped("    ", th.fg("dim", q.description));

			if (q.type === "note") {
				content.push(...this.renderNoteBlock(q, W).map((text) => ({ text })));
				return;
			}

			while (ri < rows.length && rows[ri]!.qid === q.id) {
				const row = rows[ri]!;
				const focused = ri === this.focusIdx;
				if (row.kind === "option") {
					const opts = this.optionsFor(q);
					const o = opts[row.opt!]!;
					const isMulti = q.type === "multi";
					const mark = isMulti ? (st.sel.has(row.opt!) ? "[x]" : "[ ]") : st.sel.has(row.opt!) ? "●" : "○";
				renderChoiceList(
					th,
					[{ label: o.label, note: o.description, index: `${row.opt! + 1}.` }],
					focused ? 0 : -1,
					{ boldSelected: false, mark: () => mark, noteFormat: "dash", width: W },
				).forEach((l, k) => content.push(k === 0 ? { text: l, row: ri } : { text: l }));
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
					content.push({ text: ratingIndicator(th, min, max, st.rating, focused), row: ri });
				}
				ri++;
			}

			// 多选计数提示
			if (q.type === "multi" && (q.max !== undefined || q.min !== undefined)) {
				const parts: string[] = [`已选 ${st.sel.size} 项`];
				if (q.min !== undefined) parts.push(`至少 ${q.min}`);
				if (q.max !== undefined) parts.push(`最多 ${q.max}`);
				parts.push(q.required === false ? "选填" : "必答");
				if (this.otherUnfilled(q)) parts.push("「其他」选了但未填写内容");
				pushWrapped("      ", th.fg("dim", `（${parts.join("，")}）`));
			}
		});

		// ---- 底部 ----
		const answers = this.collect();
		const missing = this.qn.questions.filter((q) => q.required !== false && !isAnswered(q, answers[q.id])).length;
		const focusedRow = this.focusIdx >= 0 ? rows[this.focusIdx] : undefined;
		const focusedQ = focusedRow ? this.qn.questions.find((x) => x.id === focusedRow.qid) : undefined;
		const onMultiline = focusedRow?.kind === "input" && focusedQ?.multiline === true;

		// 状态行：操作提示 > 短提示 > 必答缺项 > 就绪；追加当前题号 / 光标行 / 滚动指示
		const bits: string[] = [];
		if (this.hint) bits.push(th.fg("warning", `⚠ ${this.hint}`));
		else if (this.flash) bits.push(th.fg("success", `✓ ${this.flash}`));
		else if (missing > 0) bits.push(th.fg("dim", `还有 ${missing} 题必答未完成 · 连按两次 Enter 跳过`));
		else if (answerable.length === 0) bits.push(th.fg("dim", "纯说明问卷 · Enter 确认"));
		else bits.push(th.fg("success", "✓ 全部必答已完成，Enter 提交"));
		if (focusedQ && focusedQ.type !== "note") {
			const cur = answerable.indexOf(focusedQ) + 1;
			bits.push(th.fg("dim", `第 ${cur}/${answerable.length} 题`));
		}
		if (onMultiline && focusedQ) {
			const st = this.stateOf(focusedQ);
			const { line } = caretLineCol(st.text, st.cursor);
			bits.push(th.fg("dim", `第 ${line + 1}/${st.text.split("\n").length} 行`));
		}
		const statusLine = ` ${bits.join(th.fg("borderMuted", " · "))}`;

		const keysLine = th.fg(
			"dim",
			onMultiline
				? " ↑↓ 行间移动 · Shift+Enter 换行 · Enter 提交 · Ctrl+P 一览 · ? 帮助 · Esc 存草稿"
				: focusedRow?.kind === "input" || focusedRow?.kind === "other"
					? " ←→ 移动 · Ctrl+W 删词 · Enter 提交 · Ctrl+P 一览 · ? 帮助 · Esc 存草稿"
					: " ↑↓ 移动 · 空格 选择 · Enter 提交 · Ctrl+P 一览 · ? 帮助 · Esc 存草稿 · D 删除",
		);

		// ---- 组装：头 + 滚动内容窗 + 底，恰好 H 行 ----
		const budget = Math.max(1, H - header.length - 2);
		this.lastBudget = budget;
		const focusLine = content.findIndex((c) => c.row === this.focusIdx);
		if (this.followFocus && focusLine >= 0) {
			if (focusLine < this.scroll) this.scroll = focusLine;
			if (focusLine >= this.scroll + budget) this.scroll = focusLine - budget + 1;
		}
		const maxScroll = Math.max(0, content.length - budget);
		this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
		// 内容窗恒为纯内容（提示不顶掉正文）；滚动位置改由状态行右侧提示
		const visible = content.slice(this.scroll, this.scroll + budget);
		const below = content.length - (this.scroll + visible.length);
		const scrollBits: string[] = [];
		if (this.scroll > 0) scrollBits.push(`▲${this.scroll}`);
		if (below > 0) scrollBits.push(`▼${below}`);
		const statusWithScroll =
			scrollBits.length > 0
				? `${statusLine}${th.fg("dim", `  ${scrollBits.join(" ")}（滚轮/PgUp/PgDn）`)}`
				: statusLine;

		const lines = [...header, ...visible.map((c) => c.text)];
		while (lines.length < header.length + budget) lines.push("");
		lines.push(statusWithScroll, keysLine);
		return lines.slice(0, H).map(padLine);
	}

	invalidate(): void {}
	dispose(): void {
		clearTimeout(this.forceTimer);
	}
}

/**
 * 问卷选择器（/answer 多份待答时）：居中小浮层，↑↓ 选择、Enter 打开、Esc 取消、
 * D/Del 删除选中问卷（按两次确认）。done(null) 表示取消，否则为选中问卷的文件路径。
 */
export class QuestionnairePicker {
	focused = false;

	private theme: Theme;
	private items: ListedQuestionnaire[];
	private done: (file: string | null) => void;
	private onDelete?: (file: string) => void;
	private idx = 0;
	private deleteArmed = false;
	private flash = "";

	private static MAX_ROWS = 12;

	constructor(
		theme: Theme,
		items: ListedQuestionnaire[],
		done: (file: string | null) => void,
		opts?: { onDelete?: (file: string) => void },
	) {
		this.theme = theme;
		this.items = items;
		this.done = done;
		this.onDelete = opts?.onDelete;
	}

	handleInput(data: string): void {
		const wasArmed = this.deleteArmed;
		this.deleteArmed = false;
		this.flash = "";
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		const del = matchesKey(data, Key.delete) || data === "D" || matchesKey(data, "ctrl+d");
		if (del) {
			if (!this.onDelete) {
				this.flash = "当前环境不支持删除";
				return;
			}
			if (!wasArmed) {
				this.deleteArmed = true;
				this.flash = "再按一次删除选中问卷（不可恢复）";
				return;
			}
			const victim = this.items[this.idx];
			if (!victim) return;
			this.onDelete(victim.file);
			this.items = this.items.filter((i) => i.file !== victim.file);
			this.flash = `已删除「${victim.q.title}」`;
			if (this.items.length === 0) {
				this.done(null);
				return;
			}
			this.idx = Math.min(this.idx, this.items.length - 1);
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
		lines.push(
			...renderChoiceList(
				th,
				view.map((item) => {
					const q = item.q;
					const total = answerableQuestions(q).length;
					const answered = answeredProgress(q, q.answers);
					const when = q.createdAt.length >= 16 ? q.createdAt.slice(11, 16) : "";
					return {
						label: q.title,
						icon: "📝",
						note: `${q.id} · ${q.questions.length} 题${total !== q.questions.length ? ` · ${total} 可答` : ""}${answered > 0 ? ` · 已答 ${answered}` : ""}${q.status === "draft" ? " · 草稿" : ""}${when ? ` · ${when}` : ""}`,
					};
				}),
				this.idx - start,
				{ boldSelected: false },
			).map((l) => row(l)),
		);
		if (this.flash) lines.push(row(th.fg("warning", ` ${this.flash}`)));
		lines.push(row(th.fg("dim", " ↑↓ 选择 · Enter 打开 · D 删除（按两次） · Esc 取消选择")));
		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
