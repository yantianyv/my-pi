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
import { setWaiting } from "./status";
import { choiceKey, clampScroll, createBoxRenderer, dividerScrollNote, renderChoiceList, scrollByPage, wrapIndented } from "./ui";

/** 分区语气 → 主题颜色 */
const TONE = { text: "text", dim: "dim", warning: "warning", error: "error" } as const;

/**
 * 面板的信息分三层（设计目标：一眼扫过就能判断，且不假定操作是“发消息”）：
 *   head    —— 「动作 + 对象」合成一句话，加粗高亮（如 `创建群聊  人工智能奥赛辅导家长群`）
 *   body    —— 可选的多个区块，按声明顺序渲染：名单按列铺满、正文按引用样式、键值对逐行，
 *              每个区块自带小标题；没有区块时不留空白（面板高度跟随内容收缩到下限）
 *   bottom  —— 影响与可逆性（⚠ 不可恢复 之类），常驻不滚动
 * 面板内不放 argv、flag、JSON、ID。
 */
export interface ReviewSection {
	/** 区块小标题（可省；省的区块直接用内容） */
	label?: string;
	/**
	 * `text` 正文/多行文本；`list` 名单（可多列铺满，适合几十人的成员/收件人）；
	 * `kv` 键值对（每行一项，值沿左对齐）
	 */
	kind?: "text" | "list" | "kv";
	/** text: 每项一行；list: 每项一个条目；kv: "键：值" 或 [键, 值] */
	items: string[] | Array<[string, string]>;
}

export interface ReviewRequest {
	/** 外框标题（固定） */
	title: string;
	/** 动作（压缩到 2~4 字：发送消息 / 撤回消息 / 解散群聊） */
	verb: string;
	/** 对象（表头主角行；过长时由面板折行，不要在这里堆名单） */
	object: string;
	/**
	 * 主体区区块（旧字段优先兼容：objectItems → list、content → text）。
	 * 没正文也没名单时就不给 sections，面板自然收缩，不留空行。
	 */
	sections?: ReviewSection[];
	/** （兼容）对象是名单类时，按可用宽度展示名字 */
	objectItems?: { label: string; items: string[] };
	/** （兼容）要审阅的内容（正文预览） */
	content?: string[];
	/** 影响与可逆性（一行，前缀 ⚠） */
	impact: string[];
	/** 可选项；约定：第 1 项 = 允许一次，含 REVIEW_REMEMBER 则支持记住，末项 = 拒绝 */
	actions: string[];
	rememberNote?: string;
}

/** 旧字段 → 区块（统一在面板内收敛，调用方不必同时维护两套） */
export function sectionsOf(req: ReviewRequest): ReviewSection[] {
	if (req.sections) return req.sections;
	const out: ReviewSection[] = [];
	if (req.objectItems) out.push({ kind: "list", label: req.objectItems.label, items: req.objectItems.items });
	if (req.content?.length) out.push({ kind: "text", items: req.content });
	return out;
}


export type ReviewOutcome =
	| { kind: "allowed" }
	| { kind: "remembered" }
	| { kind: "rejected" }
	| { kind: "no-ui" };

export const REVIEW_ALLOW = "允许一次";
export const REVIEW_REMEMBER = "当前工作区不再询问";
export const REVIEW_REJECT = "拒绝";
/** 正文区固定行数：不足补空行（面板高度稳定），超出用 PgUp/PgDn 翻页（行数按折行后的行算） */
export const CONTENT_ROWS = 5;

/** 默认选项组：允许一次（/ 记住这类） / 拒绝 */
export const reviewActions = (canRemember: boolean): string[] =>
	canRemember ? [REVIEW_ALLOW, REVIEW_REMEMBER, REVIEW_REJECT] : [REVIEW_ALLOW, REVIEW_REJECT];

const outcomeOf = (choice: string | null): ReviewOutcome =>
	choice === REVIEW_ALLOW ? { kind: "allowed" } : choice === REVIEW_REMEMBER ? { kind: "remembered" } : { kind: "rejected" };

/** 面板串行链：并行工具批里多个待审请求依次弹，避免对话框打架 */
let panelChain: Promise<unknown> = Promise.resolve();

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

/** 名单列数：按最长一项宽 + 2 间距估算能并几列（1~6 列，窄屏退到 1 列） */
export function columnsFor(items: string[], width: number): number {
	// 名字过长时不退化成 1 列：宁可截断单个名字，也要让几十人的名单能一屏看全
	const maxItem = Math.min(Math.max(...items.map((i) => dispWidth(i)), 1), 20);
	const cols = Math.floor(width / (maxItem + 2));
	return Math.max(1, Math.min(6, cols));
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
	/** 正文折行后的总行数（render 时更新）：翻页要按它算，不能按调用方给的原行数 */
	private bodyRows = CONTENT_ROWS;
	/** 当前可视窗口高度（主体区不足一页时等于实际行数，翻页按它算） */
	private bodyWindow = CONTENT_ROWS;

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
				this.scroll = scrollByPage(this.scroll, r.dir, this.bodyRows, this.bodyWindow);
				return;
			case "skip":
				return;
		}
	}

	/** 主体区块渲染：text 逐行折行 / list 按列铺满 / kv 键值对齐；区块间空一行 */
	private renderSections(innerW: number, th: Theme): string[] {
		const out: string[] = [];
		for (const sec of sectionsOf(this.req)) {
			const items = sec.items ?? [];
			if (!items.length) continue;
			if (out.length) out.push("");
			if (sec.label) out.push(th.fg("dim", sec.label));
			const kind = sec.kind ?? "text";
			if (kind === "list") {
				out.push(...layoutList(items as string[], columnsFor(items as string[], innerW), innerW - 2));
				continue;
			}
			if (kind === "kv") {
				const pairs = (items as Array<string | [string, string]>).map((it): [string, string] =>
					Array.isArray(it) ? it : [it, ""],
				);
				const keyW = Math.min(Math.max(...pairs.map(([k]) => dispWidth(k))) + 2, Math.floor(innerW / 2));
				for (const [k, v] of pairs) {
					const pad = " ".repeat(Math.max(1, keyW - dispWidth(k)));
					const line = `${th.fg("dim", k)}${pad}${v}`;
					out.push(...wrapIndented(line, innerW - 2, 0));
				}
				continue;
			}
			for (const l of items as string[]) {
				out.push(...(l.trim() ? wrapIndented(l, innerW - 2, 0) : [""]));
			}
		}
		return out;
	}

	render(width: number): string[] {
		const th = this.theme;
		const { row, topBorder, bottomBorder, border } = createBoxRenderer(th, Math.max(10, width - 2));
		const innerW = Math.max(10, width - 2);
		const wrap = (text: string, indent: number): string[] => wrapIndented(text, innerW, indent);
		// 标题只作外框说明，弱化处理（真正要看的是下面两行）
		const lines = [topBorder(` ${th.fg("dim", this.req.title)} `)];

		// 表头：动作 + 对象（名单不进表头，避免几十人挤成一行看不全——名单在主体区按列铺）
		const objText = this.req.object;
		const head = `${th.bold(th.fg("accent", this.req.verb))}${objText ? `  ${th.fg("dim", "|")}  ${objText}` : ""}`;
		// 表头上下各留一空行：标题/表头/分隔线不再贴在一起
		lines.push(row(""));
		const indent = 1 + [...this.req.verb].length + 5; // 折行对齐到对象列（动作 + "  |  "）
		wrap(head, 1).forEach((l, i) => lines.push(row(i === 0 ? l : " ".repeat(indent) + l.trimStart())));

		// 主体区：按区块顺序渲染。先折行/排版成行，再取滚动窗——
		// row() 只按宽度截断不折行，长单行直出会连尾部带翻页一起丢掉
		const body = this.renderSections(innerW, th);
		if (body.length) {
			lines.push(row(""));
			// 高度：不足一页时只占实际行数（没有内容的区块不占位）；超过一页才出现滚动指示
			const budget = Math.min(Math.max(body.length, 1), CONTENT_ROWS);
			this.bodyWindow = budget;
			const maxScroll = Math.max(0, body.length - budget);
			this.bodyRows = body.length;
			this.scroll = clampScroll(this.scroll, body.length, budget);
			const visible = body.slice(this.scroll, this.scroll + budget);
			for (const l of visible) lines.push(row(`  ${l}`));
			if (maxScroll > 0) {
				lines.push(dividerScrollNote(th, border, innerW, this.scroll, maxScroll - this.scroll));
			}
		}

		// 影响（一行，⚠ 开头；上方留一空行）
		lines.push(row(""));
		for (const l of wrap(`⚠ ${this.req.impact[0] ?? ""}`, 1)) lines.push(row(th.fg("warning", l)));

		// 选项：竖排（紧跟影响行，不再单独加分隔线）
		lines.push(
			...renderChoiceList(
				th,
				this.req.actions.map((a) => ({ label: a, note: a === REVIEW_REMEMBER ? this.req.rememberNote : undefined })),
				this.idx,
			).map((l) => row(l)),
		);
		lines.push(bottomBorder());
		return lines;
	}
}

/**
 * 弹面板请人选择，返回**原始选项文本**（取消返回 null）。
 *
 * 用于选项语义不是「允许/拒绝」的场合（如粘贴凭据时的「收进库 / 只遮住 / 原样发送」）——
 * 那些动作没有 allowed/rejected 的对应关系，硬套 outcomeOf 只会得到一个错误的语义。
 * 需要 allowed/remembered/rejected 三态时用 askReview。
 */
export async function askChoice(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	req: ReviewRequest,
): Promise<string | null> {
	if (!ctx.hasUI) return null;
	return new Promise<string | null>((resolve) => {
		panelChain = panelChain.catch(() => {}).then(async () => {
			setWaiting(`等待选择：${req.verb} ${req.object}`.slice(0, 40));
			let choice: string | null;
			try {
				choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => new ReviewPanel(tui, theme, req, done), {
					overlay: true,
					overlayOptions: { width: "78%", minWidth: 56, maxHeight: "72%" },
				});
			} catch {
				resolve(null);
				return;
			} finally {
				setWaiting(null);
			}
			resolve(choice);
		});
	});
}

/**
 * 弹面板请人审核。返回值语义：
 * allowed（本次允许）/ remembered（当前工作区不再询问）/ rejected（拒绝或 Esc）/ no-ui（弹不出窗，调用方应拒绝执行）。
 */
export async function askReview(ctx: Pick<ExtensionContext, "hasUI" | "ui">, req: ReviewRequest): Promise<ReviewOutcome> {
	if (!ctx.hasUI) return { kind: "no-ui" };
	return new Promise<ReviewOutcome>((resolve) => {
		panelChain = panelChain.catch(() => {}).then(async () => {
			setWaiting(`等待确认：${req.verb} ${req.object}`.slice(0, 40));
			let choice: string | null;
			try {
				choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => new ReviewPanel(tui, theme, req, done), {
					overlay: true,
					overlayOptions: { width: "78%", minWidth: 56, maxHeight: "72%" },
				});
			} catch {
				resolve({ kind: "rejected" });
				return;
			} finally {
				setWaiting(null);
			}
			resolve(outcomeOf(choice));
		});
	});
}
