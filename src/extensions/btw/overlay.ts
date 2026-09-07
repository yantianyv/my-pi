/**
 * btw/overlay：/btw 侧栏问答浮层组件（btw 多文件扩展的组成部分）
 *
 * 职责：
 * - BtwOverlay：问答面板 UI（历史问答对 + 当前问答 + 滚动窗口 + 输入模式）
 * - 流式回调（startQuestion/appendAnswer/finish/fail/showTool/hideTool）由 run.ts 驱动
 * - 状态行：待命/思考中/回答中（含当前工具）/回答完毕/错误；按键提示 Enter 提问/追问、m 转正、Esc 关闭、↑↓ 滚动
 * - m 转正素材由 getTranscript 生成（Q/A 打包），随下一条消息附带发送
 *
 * 注意：本模块不注册任何 pi API，仅导出组件类，由入口实例化。
 */
import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createBoxRenderer, editInput, renderScrollingInput } from "../shared/ui";
import { BTW_MAX_ROWS, BTW_MAX_QUESTION_LINES, BTW_MAX_INPUT_LENGTH } from "./config";
import { renderAnswer, wrapText } from "./render";

export type BtwStatus = "thinking" | "streaming" | "done" | "error";
type PanelMode = "viewing" | "input";

interface QaPair {
	q: string;
	a: string;
}

export class BtwOverlay {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private done: () => void;
	private onAsk: (question: string) => void;
	private onTransfer: () => void;

	/** 已完成的问答对（展示 + 转正素材） */
	private qaPairs: QaPair[] = [];
	/** 当前正在回答的问题 */
	private currentQuestion = "";
	/** 当前回答的已累积文本 */
	private answer = "";
	private status: BtwStatus = "thinking";
	private errorText = "";
	/** 正在执行的只读工具（如「read src/a.ts」），无则空串 */
	private toolLabel = "";
	private scrollOffset = 0;

	private mode: PanelMode = "viewing";
	private inputText = "";
	private inputCursor = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		onAsk: (question: string) => void,
		onTransfer: () => void,
		done: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.onAsk = onAsk;
		this.onTransfer = onTransfer;
		this.done = done;
	}

	// ---- 流式回调（runBtwTurn 调用） ----

	/** 当前实际使用的模型（provider/id），问答开始时由 ask / 故障转移更新 */
	private modelLabel = "";

	/** 设置当前实际使用的模型名并重绘（auto 故障转移换模型时也会调用） */
	setModel(label: string): void {
		this.modelLabel = label;
		this.tui.requestRender();
	}

	/** 开始回答新问题：清空当前回答并滚到最新 */
	startQuestion(question: string): void {
		this.currentQuestion = question;
		this.answer = "";
		this.status = "thinking";
		this.errorText = "";
		this.toolLabel = ""; // 新问题/故障转移重试开始时清掉残留的工具标签
		this.scrollOffset = Number.MAX_SAFE_INTEGER; // render 时 clamp 到底部
		this.tui.requestRender();
	}

	appendAnswer(delta: string): void {
		if (this.status === "thinking") this.status = "streaming";
		this.answer += delta;
		this.tui.requestRender();
	}

	finish(message: string): void {
		if (message) this.answer = message;
		this.status = "done";
		this.tui.requestRender();
	}

	fail(error: string): void {
		this.status = "error";
		// 错误消息（如 API 返回的 JSON）可能很长，截断避免占满面板
		this.errorText = error.length > 300 ? error.slice(0, 300) + "…" : error;
		this.tui.requestRender();
	}

	/** 当前问答完成，压入历史并进入待命状态 */
	commit(): void {
		this.qaPairs.push({ q: this.currentQuestion, a: this.answer || "（无文字回答）" });
		this.currentQuestion = "";
		this.answer = "";
		this.status = "thinking";
		this.scrollOffset = Number.MAX_SAFE_INTEGER;
		this.tui.requestRender();
	}

	isStreaming(): boolean {
		return this.status === "streaming" || this.status === "thinking";
	}

	/** 工具开始执行：在状态行显示当前工具与目标 */
	showTool(toolName: string, args: unknown): void {
		const raw =
			(args as { path?: string })?.path ??
			(args as { pattern?: string })?.pattern ??
			(args as { query?: string })?.query ??
			(args as { command?: string })?.command ??
			"";
		// 窄面板下路径尾部（文件名/模式）比前缀更有用，超长保留尾部
		const target = raw.length > 48 ? `…${raw.slice(-48)}` : raw;
		this.toolLabel = `🔧 ${toolName}${target ? ` ${target}` : ""}`;
		this.tui.requestRender();
	}

	hideTool(): void {
		this.toolLabel = "";
		this.tui.requestRender();
	}

	getAnswer(): string {
		return this.answer;
	}

	/** 生成转正用的完整问答记录 */
	getTranscript(): string {
		const lines: string[] = [];
		for (const { q, a } of this.qaPairs) lines.push(`Q: ${q}`, `A: ${a}`);
		if (this.currentQuestion) {
			lines.push(`Q: ${this.currentQuestion}`, `A: ${this.answer || "（无文字回答）"}`);
		}
		return lines.join("\n");
	}

	/** 当前是否处于可交互状态（回答完成或出错，可追问/转正） */
	private isSettled(): boolean {
		return this.status === "done" || this.status === "error";
	}

	/** 按终端高度自适应面板最大行数：小终端收缩到 80% 高度内，避免底部被 maxHeight 截掉 */
	private getMaxRows(): number {
		const termRows = this.tui.terminal.rows;
		if (!termRows || termRows <= 0) return BTW_MAX_ROWS;
		return Math.max(12, Math.min(BTW_MAX_ROWS, Math.floor(termRows * 0.8)));
	}

	// ---- 组件接口 ----

	handleInput(data: string): void {
		// 输入模式：编辑追问内容
		if (this.mode === "input") {
			if (matchesKey(data, "escape")) {
				this.mode = "viewing";
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "return")) {
				const q = this.inputText.trim();
				this.mode = "viewing";
				this.inputText = "";
				this.inputCursor = 0;
				if (q) this.onAsk(q);
				else this.tui.requestRender();
				return;
			}
			// 编辑键（backspace/left/right/home/end/粘贴）统一走 shared/ui editInput
			const r = editInput(this.inputText, this.inputCursor, data, { maxLength: BTW_MAX_INPUT_LENGTH });
			if (r !== "skip") {
				this.inputText = r.text;
				this.inputCursor = r.cursor;
				this.tui.requestRender();
			}
			return;
		}

		// 浏览模式
		if (matchesKey(data, "escape")) {
			this.done();
			return;
		}
		if (matchesKey(data, "return")) {
			// 待命（无活动问题）或当前问答已结束时可进入输入模式
			if (!this.currentQuestion || this.isSettled()) {
				this.mode = "input";
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "m") && (!this.currentQuestion || this.isSettled())) {
			this.onTransfer();
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down")) {
			this.scrollOffset++;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const { row, topBorder, bottomBorder } = createBoxRenderer(th, innerW);
		const blank = () => row("");
		const lines: string[] = [];

		// 顶部边框 + 标题（含实际使用模型，随 ask / 故障转移更新）
		const titleStr = ` ${th.fg("accent", "💬 btw")}${this.modelLabel ? `${th.fg("dim", " · ")}${th.fg("dim", this.modelLabel)}` : ""} `;
		lines.push(topBorder(titleStr));

		// 对话内容区：历史问答对 + 当前问答，统一成行供滚动
		const contentWidth = innerW - 2;
		const contentLines: string[] = [];
		for (const { q, a } of this.qaPairs) {
			for (const ql of wrapText(q, contentWidth).slice(0, BTW_MAX_QUESTION_LINES)) {
				contentLines.push(th.fg("muted", `Q ${ql}`));
			}
			contentLines.push(...renderAnswer(a, th, contentWidth));
			contentLines.push("");
		}
		if (this.currentQuestion) {
			for (const ql of wrapText(this.currentQuestion, contentWidth).slice(0, BTW_MAX_QUESTION_LINES)) {
				contentLines.push(th.fg("accent", `Q ${ql}`));
			}
			if (this.status === "thinking") {
				contentLines.push(th.fg("dim", "  思考中…"));
			} else {
				contentLines.push(...renderAnswer(this.answer, th, contentWidth));
			}
			if (this.status === "error") contentLines.push(th.fg("error", `  ✗ ${this.errorText}`));
		}

		// 滚动窗口：行数按终端高度自适应（小终端自动收缩，大终端保持 BTW_MAX_ROWS）
		const budget = Math.max(1, this.getMaxRows() - lines.length - 3);
		const maxOffset = Math.max(0, contentLines.length - budget);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
		const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + budget);
		for (const cl of visible) lines.push(row(` ${cl}`));
		for (let i = visible.length; i < budget; i++) lines.push(blank());

		// 输入模式：输入行 + 提示；浏览模式：状态行 + 提示
		if (this.mode === "input") {
			// 输入框用水平滚动窗口跟随光标（❯ 前缀占 4 个显示宽度），不截断内容
			const { display: inputDisplay } = renderScrollingInput(this.inputText, this.inputCursor, innerW, {
				inputOffset: 5, // btw 输入行 ❯ 后多一个空格（其余浮层为 3）
				showCursor: this.focused,
			});
			lines.push(row(` ${th.fg("accent", "❯")} ${inputDisplay}`));
			lines.push(row(th.fg("dim", "Enter 发送 · Esc 取消")));
		} else {
			let statusStr: string;
			if (!this.currentQuestion) statusStr = th.fg("success", "✓ 待命 · Enter 提问");
			else if (this.status === "thinking") statusStr = th.fg("dim", "⏳ 思考中…");
			else if (this.status === "streaming")
				statusStr = th.fg("accent", this.toolLabel ? `⏳ ${this.toolLabel}` : "⏳ 回答中…");
			else if (this.status === "done") statusStr = th.fg("success", "✓ 回答完毕");
			else statusStr = th.fg("error", `✗ ${this.errorText}`);

			const hints: string[] = [];
			if (!this.currentQuestion) hints.push("Enter 提问", "m 转正");
			else if (this.isSettled()) hints.push("Enter 追问", "m 转正");
			hints.push("Esc 关闭");
			if (contentLines.length > budget) hints.push("↑↓ 滚动");
			lines.push(row(statusStr));
			lines.push(row(th.fg("dim", hints.join(" · "))));
		}

		// 底部边框
		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
