/**
 * 人工审核面板（通用 overlay 组件）：给「执行前必须由人点一下」的操作提供一个统一浮层。
 *
 * 内容纪律：面板只展示**人类判断需要的信息**——分区写人话（要做什么 / 对谁 / 内容预览 / 影响与可逆性），
 * 不放原始 argv、JSON、ID、错误码。调用方负责把「命令」翻译成分区文本（翻译逻辑放各扩展的纯函数里，可测）。
 *
 * 交互：↑↓ 选择 · Enter 确认 · 1-9 直选 · PgUp/PgDn 滚动 · Esc = 拒绝（不执行）。
 * 默认高亮第一项（高频路径回车即通过）。
 *
 * askReview 封装了三个易踩的坑：
 *   1. 无界面会话（print/RPC 等 hasUI=false）→ 返回 no-ui，由调用方拒绝执行（fail-closed）；
 *   2. 并行工具批里多个请求会同时要弹窗 → 模块级 Promise 链串行，避免浮层互相覆盖；
 *   3. 等待期间把状态行切成「正在等用户确认」（status-beacon 桥，缺席静默）。
 */
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { choiceKey, clampScroll, createBoxRenderer, dividerScrollNote, renderChoiceList, scrollByPage, wrapIndented } from "./ui";

/** 分区语气 → 主题颜色 */
const TONE = { text: "text", dim: "dim", warning: "warning", error: "error" } as const;

/**
 * 面板只讲三件事，且分好层级（设计目标：一眼扫过就能判断）：
 *   primary   —— 「操作 + 对象」合成一句话，**加粗高亮**，最长不超过一行多（如 `撤回  严天宇 的单聊消息`）
 *   secondary —— 次要细节（时间/条数/部门/人数），灰色小字，不抢眼
 *   content   —— 要审阅的内容（正文预览），左侧带引用竖线，与摘要区分
 *   底部       —— 影响与可逆性（⚠ 不可恢复 之类），常驻不滚动
 * 面板内不放 argv、flag、JSON、ID。
 */
export interface ReviewRequest {
	/** 外框标题（固定） */
	title: string;
	/** 动作（压缩到 2~4 字：发送消息 / 撤回消息 / 解散群聊） */
	verb: string;
	/** 对象（带前缀标签：收件人：… / 群：… / 撤回对象：…） */
	object: string;
	/** 对象是名单类时（收件人），由面板按可用宽度决定显示几个名字 */
	objectItems?: { label: string; items: string[] };
	/** 内容（正文等；整块展示，不滚动时用空行占位） */
	content: string[];
	/** 影响与可逆性（一行，前缀 ⚠） */
	impact: string[];
	/** 可选项；约定：第 1 项 = 允许一次，含 REVIEW_REMEMBER 则支持记住，末项 = 拒绝 */
	actions: string[];
	rememberNote?: string;
}


export type ReviewOutcome =
	| { kind: "allowed" }
	| { kind: "remembered" }
	| { kind: "rejected" }
	| { kind: "no-ui" };

export const REVIEW_ALLOW = "允许一次";
export const REVIEW_REMEMBER = "当前工作区不再询问";
export const REVIEW_REJECT = "拒绝";
/** 正文区固定行数：不足补空行（面板高度稳定），超出用 PgUp/PgDn 翻页 */
export const CONTENT_ROWS = 5;

/** 默认选项组：允许一次（/ 记住这类） / 拒绝 */
export const reviewActions = (canRemember: boolean): string[] =>
	canRemember ? [REVIEW_ALLOW, REVIEW_REMEMBER, REVIEW_REJECT] : [REVIEW_ALLOW, REVIEW_REJECT];

const outcomeOf = (choice: string | null): ReviewOutcome =>
	choice === REVIEW_ALLOW ? { kind: "allowed" } : choice === REVIEW_REMEMBER ? { kind: "remembered" } : { kind: "rejected" };

/** 面板串行链：并行工具批里多个待审请求依次弹，避免对话框打架 */
let panelChain: Promise<unknown> = Promise.resolve();

/** 状态行等待文本（status-beacon 桥；缺席静默）*/
const waitApi = (): { wait?: (t: string | null) => void } | undefined =>
	(globalThis as Record<string, unknown>).__PI_STATUS_BEACON_API__ as { wait?: (t: string | null) => void } | undefined;

/** 把名单排成 columns 列：返回若干整行（列宽按最长项自适应，纯函数便于测试） */
export function layoutList(items: string[], columns: number, maxWidth: number): string[] {
	if (!items.length) return [];
	const cols = Math.max(1, Math.min(columns, items.length));
	const rows = Math.ceil(items.length / cols);
	const width = Math.min(
		Math.max(...items.map((i) => [...i].length)) + 2,
		Math.max(8, Math.floor(maxWidth / cols)),
	);
	const lines: string[] = [];
	for (let r = 0; r < rows; r++) {
		const cells: string[] = [];
		for (let c = 0; c < cols; c++) {
			const item = items[c * rows + r];
			if (!item) continue;
			const w = [...item].length;
			cells.push(w > width - 2 ? `${[...item].slice(0, Math.max(1, width - 3)).join("")}…` : item + " ".repeat(Math.max(1, width - w)));
		}
		lines.push(cells.join("").trimEnd());
	}
	return lines;
}

/** 名单按可用宽度塞名字：塞满为止，剩余用「等 N 人」收口（纯函数，便于测试） */
export function dispWidth(s: string): number {
	return visibleWidth(s);
}

export function fitItems(label: string, items: string[], maxWidth: number, maxItems = Number.MAX_SAFE_INTEGER): string {
	if (!items.length) return "";
	const head = `${label}：`;
	let line = head;
	let used = 0;
	const limit = Math.min(items.length, maxItems);
	for (const it of items.slice(0, limit)) {
		const seg = (used ? "、" : "") + it;
		if (dispWidth(line) + dispWidth(seg) + 9 > maxWidth) break;
		line += seg;
		used++;
	}
	if (used === 0) {
		const room = Math.max(4, maxWidth - dispWidth(head) - 9);
		line += `${[...items[0]!].slice(0, room).join("")}…`;
		used = 1;
	}
	if (used < items.length) line += ` 等 ${items.length} 人`;
	return line;
}

export class ReviewPanel {
	focused = false;

	private idx = 0;
	private scroll = 0;
	private lastBudget = 5;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private req: ReviewRequest,
		private done: (choice: string | null) => void,
	) {}

	/** 组件接口要求；本面板无缓存，重绘即最新 */
	invalidate(): void {}

	handleInput(data: string): void {
		const r = choiceKey(data, this.idx, this.req.actions.length);
		switch (r.kind) {
			case "move":
				this.idx = r.index;
				return;
			case "select":
				return this.done(this.req.actions[r.index] ?? this.req.actions[0]!);
			case "cancel":
				return this.done(null);
			case "page":
				this.scroll = scrollByPage(this.scroll, r.dir, this.req.content.length, CONTENT_ROWS);
				return;
			case "skip":
				return;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const { row, topBorder, bottomBorder, border } = createBoxRenderer(th, Math.max(10, width - 2));
		const innerW = Math.max(10, width - 2);
		const wrap = (text: string, indent: number): string[] => wrapIndented(text, innerW, indent);
		// 标题只作外框说明，弱化处理（真正要看的是下面两行）
		const lines = [topBorder(` ${th.fg("dim", this.req.title)} `)];

		// 表头一行：动作（2~4 字）| 对象
		let objText = this.req.object;
		if (this.req.objectItems) {
			const { label, items } = this.req.objectItems;
			const objBudget = Math.max(4, innerW - dispWidth(this.req.verb) - 6);
			for (let cap = items.length; cap >= 1; cap--) {
				const cand = fitItems(label, items, objBudget, cap);
				if (dispWidth(cand) <= objBudget) { objText = cand; break; }
			}
		}
		const head = `${th.bold(th.fg("accent", this.req.verb))}${objText ? `  ${th.fg("dim", "|")}  ${objText}` : ""}`;
		// 表头上下各留一空行：标题/表头/分隔线不再贴在一起
		lines.push(row(""));
		const indent = 1 + [...this.req.verb].length + 5; // 折行对齐到对象列（动作 + "  |  "）
		wrap(head, 1).forEach((l, i) => lines.push(row(i === 0 ? l : " ".repeat(indent) + l.trimStart())));
		lines.push(row(""));

		// 正文区：固定 CONTENT_ROWS 行；超出时 PgUp/PgDn 翻页
		const body = this.req.content;
		const maxScroll = Math.max(0, body.length - CONTENT_ROWS);
		this.scroll = clampScroll(this.scroll, body.length, CONTENT_ROWS);
		const visible = body.slice(this.scroll, this.scroll + CONTENT_ROWS);
		while (visible.length < CONTENT_ROWS) visible.push("");
		for (const l of visible) lines.push(row(`  ${l}`));
		if (maxScroll > 0) {
			lines.push(dividerScrollNote(th, border, innerW, this.scroll, maxScroll - this.scroll));
		}

		// 影响（一行，⚠ 开头；上方留一空行）
		lines.push(row(""));
		for (const l of wrap(`⚠ ${this.req.impact[0] ?? ""}`, 1)) lines.push(row(th.fg("warning", l)));

		// 选项：竖排（紧跟影响行，不再单独加分隔线）
		lines.push(
			...renderChoiceList(
				th,
				this.req.actions,
				this.idx,
				this.req.actions.map((a) => (a === REVIEW_REMEMBER ? this.req.rememberNote : undefined)),
			).map((l) => row(l)),
		);
		lines.push(bottomBorder());
		return lines;
	}
}

/**
 * 弹面板请人审核。返回值语义：
 * allowed（本次允许）/ remembered（当前工作区不再询问）/ rejected（拒绝或 Esc）/ no-ui（弹不出窗，调用方应拒绝执行）。
 */
export async function askReview(ctx: Pick<ExtensionContext, "hasUI" | "ui">, req: ReviewRequest): Promise<ReviewOutcome> {
	if (!ctx.hasUI) return { kind: "no-ui" };
	return new Promise<ReviewOutcome>((resolve) => {
		panelChain = panelChain.then(async () => {
			waitApi()?.wait?.(`等待确认：${req.verb} ${req.object}`.slice(0, 40));
			let choice: string | null;
			try {
				choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => new ReviewPanel(tui, theme, req, done), {
					overlay: true,
					overlayOptions: { width: "78%", minWidth: 56, maxHeight: "72%" },
				});
			} finally {
				waitApi()?.wait?.(null);
			}
			resolve(outcomeOf(choice));
		});
	});
}
