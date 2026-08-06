/**
 * btw: Claude Code 风格 /btw 临时旁支问答
 *
 * - /btw <问题>：在主任务进行中打开右侧浮层，做临时问答（by the way）
 * - 面板内可多轮追问（Enter 输入，最多 BTW_MAX_THREAD_TURNS 轮），
 *   上下文 = 主会话 + 面板内历次问答，仍独立于主会话、零污染
 * - m 一键转正：把全部 Q/A 打包成 [btw 转交] 消息发给主 agent 继续处理
 * - 携带当前会话上下文（buildSessionContext，含压缩结果），能回答与当前
 *   任务相关的问题（如「刚才为什么选这个方案」「改了哪些文件」）
 * - 流式显示回答；Esc 关闭并中止请求；↑↓ 滚动查看完整回答
 *
 * 实现要点：
 * - 认证走 ctx.modelRegistry.getApiKeyAndHeaders()（与 init 子代理同一条链）；
 * - 消息序列全量降级清洗：toolResult 降级为 user、剥离 tool_use/thinking 块、
 *   合并连续同角色、保证以 user 结尾——兼容 OpenAI（role 'tool' 配对校验）与
 *   Anthropic（tool_result 紧跟 assistant tool_use）两类端点，截断也安全；
 * - 流式用 streamSimple（无工具 Context），text_delta 累积，done 的最终消息为准；
 * - 浮层用 ctx.ui.custom + overlay 模式，组件持有 tui 引用，delta 时 requestRender。
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** btw 单次回答最大输出 token */
const BTW_MAX_TOKENS = 2048;
/** 请求超时 */
const BTW_TIMEOUT_MS = 5 * 60_000;
/** 携带的主会话上下文消息条数上限（超出从最早丢弃，保留最近） */
const BTW_MAX_CONTEXT_MESSAGES = 60;
/** btw 面板内最多追问轮数（一轮 = 一问一答） */
const BTW_MAX_THREAD_TURNS = 8;
/** 最终请求消息总数上限（主会话 + 面板线程） */
const BTW_MAX_TOTAL_MESSAGES = 80;
/** 单条 toolResult 消息文本最多保留字符数（控制 token 成本） */
const BTW_MAX_TOOL_RESULT_CHARS = 1500;
/** 浮层宽度（终端宽度百分比） */
const BTW_OVERLAY_WIDTH = "42%";
/** 浮层最小宽度（列） */
const BTW_OVERLAY_MIN_WIDTH = 46;
/** 浮层最大高度（终端高度百分比） */
const BTW_OVERLAY_MAX_HEIGHT = "80%";
/** 浮层渲染行数上限（render 自行控制在 maxHeight 内，保证边框完整） */
const BTW_MAX_ROWS = 32;
/** 单条问题最多显示几行（超出截断） */
const BTW_MAX_QUESTION_LINES = 4;
/** 输入框最多多少个字符 */
const BTW_MAX_INPUT_LENGTH = 300;

/** btw 助手的系统提示词（固定指令在前，利于 provider 端 prompt 缓存命中） */
const BTW_SYSTEM_PROMPT = [
	"你是 btw 助手（by the way），运行在用户正在进行的编码任务旁边的侧栏问答面板里。",
	"用户此刻就是在这个面板中与你对话——本面板独立于主会话，你的回答不会写入主会话。",
	"",
	"输入结构：",
	"- 前半部分是主会话的对话历史（用户消息、助手消息、工具输出），帮助你理解任务背景；",
	"- 后半部分是本面板内你与此用户的历次问答（user 是问题、assistant 是你的回答）；",
	"- 最后一条 user 消息是当前要回答的问题。",
	"",
	"要求：",
	"- 回答准确、简洁、直接：默认控制在几句话到一小段，像资深同事随口回答；用户明确要求详细时才展开",
	"- 只回答当前问题本身，不要复述任务、不要列行动清单、不要建议下一步行动",
	"- 被问到关于你自己的问题（如「你知道自己在哪吗」「你能用工具吗」），如实说明：你是 btw 面板助手，",
	"  独立于主会话，不能使用任何工具",
	"- 追问时结合前面的问答（例如「我刚才提到的 xx 具体指？」），不要重复已给过的内容",
	"- 不提及「对话历史」「上下文」等内部机制，直接回答问题",
	"- 如果依据现有信息无法判断，明确说明这一点",
].join("\n");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

// ---------------------------------------------------------------------------
// 消息清洗与组装
// ---------------------------------------------------------------------------

/** 从消息中提取纯文本（剥离 tool_use / thinking 等非文本块） */
function extractTextBlocks(m: AgentMessage): string {
	if (typeof m.content === "string") return m.content.trim();
	if (Array.isArray(m.content)) {
		return m.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n")
			.trim();
	}
	return "";
}

/** 把消息内容转成文本块数组（供合并） */
function asTextBlocks(content: Message["content"]): Array<{ type: "text"; text: string }> {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string");
}

/** 合并连续同角色（部分端点要求 user/assistant 严格交替） */
function mergeAdjacent(messages: Message[]): Message[] {
	const out: Message[] = [];
	for (const msg of messages) {
		const blocks = asTextBlocks(msg.content);
		if (blocks.length === 0) continue; // 丢弃无文本消息
		const last = out[out.length - 1];
		if (last && last.role === msg.role) {
			const sep = msg.role === "user" ? [{ type: "text", text: "\n\n" }] : [];
			last.content = [...asTextBlocks(last.content), ...sep, ...blocks];
		} else {
			out.push({ ...msg, content: blocks });
		}
	}
	return out;
}

/**
 * 清洗主会话上下文：toolResult 降级为 user 消息（标注工具名）、剥离
 * tool_use/thinking 块、限制条数。清洗后全是 user/assistant 纯文本，
 * 任意截断点都安全。
 */
function buildContextMessages(sessionMessages: AgentMessage[]): Message[] {
	const cleaned: Message[] = [];
	for (const m of sessionMessages) {
		if (m.role === "user" || m.role === "assistant") {
			const text = extractTextBlocks(m);
			if (text) cleaned.push({ role: m.role, content: [{ type: "text", text }] });
		} else if (m.role === "toolResult") {
			const text = extractTextBlocks(m).slice(0, BTW_MAX_TOOL_RESULT_CHARS);
			if (text) {
				cleaned.push({ role: "user", content: [{ type: "text", text: `[工具 ${m.toolName} 输出]\n${text}` }] });
			}
		}
	}
	return cleaned.slice(-BTW_MAX_CONTEXT_MESSAGES);
}

/** 从最终 AssistantMessage 中提取纯文本回答 */
function extractText(message: { content?: Array<{ type: string; text?: string }> }): string {
	return (message.content ?? [])
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && !!b.text)
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/** 按显示宽度换行（考虑中文/全角字符，\n 保留为空行） */
function wrapText(text: string, width: number): string[] {
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine === "") {
			out.push("");
			continue;
		}
		let current = "";
		let currentW = 0;
		for (const ch of rawLine) {
			const w = visibleWidth(ch);
			if (currentW + w > width && current !== "") {
				out.push(current);
				current = ch;
				currentW = w;
			} else {
				current += ch;
				currentW += w;
			}
		}
		out.push(current);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 浮层组件
// ---------------------------------------------------------------------------

type BtwStatus = "thinking" | "streaming" | "done" | "error";
type PanelMode = "viewing" | "input";

interface QaPair {
	q: string;
	a: string;
}

class BtwOverlay {
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

	/** 开始回答新问题：清空当前回答并滚到最新 */
	startQuestion(question: string): void {
		this.currentQuestion = question;
		this.answer = "";
		this.status = "thinking";
		this.errorText = "";
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
			if (matchesKey(data, "backspace")) {
				if (this.inputCursor > 0) {
					this.inputText = this.inputText.slice(0, this.inputCursor - 1) + this.inputText.slice(this.inputCursor);
					this.inputCursor--;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, "left")) {
				this.inputCursor = Math.max(0, this.inputCursor - 1);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "right")) {
				this.inputCursor = Math.min(this.inputText.length, this.inputCursor + 1);
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32 && this.inputText.length < BTW_MAX_INPUT_LENGTH) {
				this.inputText = this.inputText.slice(0, this.inputCursor) + data + this.inputText.slice(this.inputCursor);
				this.inputCursor++;
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
		const border = (s: string) => th.fg("border", s);
		const row = (content: string) => border("│") + truncateToWidth(content, innerW, "...", true) + border("│");
		const blank = () => row("");
		const lines: string[] = [];

		// 顶部边框 + 标题
		const titleStr = ` ${th.fg("accent", "💬 btw")} `;
		const titleW = visibleWidth(titleStr);
		lines.push(border(`╭${titleStr}${"─".repeat(Math.max(0, innerW - titleW))}╮`));

		// 对话内容区：历史问答对 + 当前问答，统一成行供滚动
		const contentWidth = innerW - 2;
		const contentLines: string[] = [];
		for (const { q, a } of this.qaPairs) {
			for (const ql of wrapText(q, contentWidth).slice(0, BTW_MAX_QUESTION_LINES)) {
				contentLines.push(th.fg("muted", `Q ${ql}`));
			}
			for (const al of wrapText(a, contentWidth)) contentLines.push(th.fg("text", `  ${al}`));
			contentLines.push("");
		}
		if (this.currentQuestion) {
			for (const ql of wrapText(this.currentQuestion, contentWidth).slice(0, BTW_MAX_QUESTION_LINES)) {
				contentLines.push(th.fg("accent", `Q ${ql}`));
			}
			if (this.status === "thinking") {
				contentLines.push(th.fg("dim", "  思考中…"));
			} else {
				for (const al of wrapText(this.answer, contentWidth)) contentLines.push(th.fg("text", `  ${al}`));
			}
			if (this.status === "error") contentLines.push(th.fg("error", `  ✗ ${this.errorText}`));
		}

		// 滚动窗口
		const budget = Math.max(1, BTW_MAX_ROWS - lines.length - 3);
		const maxOffset = Math.max(0, contentLines.length - budget);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
		const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + budget);
		for (const cl of visible) lines.push(row(` ${cl}`));
		for (let i = visible.length; i < budget; i++) lines.push(blank());

		// 输入模式：输入行 + 提示；浏览模式：状态行 + 提示
		if (this.mode === "input") {
			let inputDisplay = this.inputText;
			if (this.focused) {
				const before = inputDisplay.slice(0, this.inputCursor);
				const cursorChar = this.inputCursor < inputDisplay.length ? inputDisplay[this.inputCursor] : " ";
				const after = inputDisplay.slice(this.inputCursor + 1);
				inputDisplay = `${before}${CURSOR_MARKER}\x1b[7m${cursorChar}\x1b[27m${after}`;
			}
			lines.push(row(` ${th.fg("accent", "❯")} ${inputDisplay}`));
			lines.push(row(th.fg("dim", "Enter 发送 · Esc 取消")));
		} else {
			let statusStr: string;
			if (!this.currentQuestion) statusStr = th.fg("success", "✓ 待命 · Enter 提问");
			else if (this.status === "thinking") statusStr = th.fg("dim", "⏳ 思考中…");
			else if (this.status === "streaming") statusStr = th.fg("accent", "⏳ 回答中…");
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
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ---------------------------------------------------------------------------
// 后台流式问答
// ---------------------------------------------------------------------------

async function runBtwTurn(
	ctx: ExtensionCommandContext,
	model: AnyModel,
	thread: Message[],
	question: string,
	signal: AbortSignal,
	overlay: BtwOverlay,
	onDone: (answer: string) => void,
): Promise<void> {
	let auth;
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch (e) {
		overlay.fail(e instanceof Error ? e.message : String(e));
		return;
	}
	if (!auth.ok || !auth.apiKey) {
		overlay.fail(auth.ok ? `无 ${model.provider} 的 API key` : auth.error);
		return;
	}

	// 组装：主会话上下文（清洗）+ 面板内历次问答 + 当前问题
	const sessionMessages = ctx.sessionManager.buildSessionContext().messages;
	const context = buildContextMessages(sessionMessages);
	const messages = mergeAdjacent([
		...context,
		...thread,
		{ role: "user", content: [{ type: "text", text: question }] },
	]).slice(-BTW_MAX_TOTAL_MESSAGES);

	const stream = streamSimple(
		model,
		{ systemPrompt: BTW_SYSTEM_PROMPT, messages },
		{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: BTW_MAX_TOKENS, signal },
	);

	try {
		for await (const event of stream) {
			if (event.type === "text_delta") {
				overlay.appendAnswer(event.delta);
			} else if (event.type === "done") {
				const text = extractText(event.message);
				overlay.finish(text);
				onDone(text || overlay.getAnswer());
				return;
			} else if (event.type === "error") {
				overlay.fail(event.error.errorMessage ?? `请求失败（${event.reason}）`);
				return;
			}
		}
		// 流正常结束但无 done 事件：用已累积文本收尾
		if (overlay.isStreaming()) {
			const text = overlay.getAnswer();
			overlay.finish(text);
			onDone(text);
		}
	} catch (e) {
		if (signal.aborted) return; // 用户已 Esc 关闭面板，无需再更新
		overlay.fail(e instanceof Error ? e.message : String(e));
	}
}

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// 同时只允许一个 btw 面板
	let activeBtw: { abort: () => void } | null = null;

	pi.registerCommand("btw", {
		description: "临时旁支问答（by the way）：侧栏问答，不写入会话历史；Enter 追问、m 转正",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw 需要交互模式", "error");
				return;
			}
			const firstQuestion = args?.trim();
			if (!firstQuestion) {
				ctx.ui.notify("用法：/btw <问题>", "warning");
				return;
			}
			const model = ctx.model as AnyModel | undefined;
			if (!model) {
				ctx.ui.notify("当前没有可用模型，无法启动 btw", "error");
				return;
			}
			if (activeBtw) {
				ctx.ui.notify("已有 btw 面板打开，先按 Esc 关闭再提问", "warning");
				return;
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new Error("btw 超时")), BTW_TIMEOUT_MS);
			activeBtw = { abort: () => controller.abort() };

			// btw 面板内对话线程（user/assistant 交替，不写主会话）
			const thread: Message[] = [];
			let overlayRef: BtwOverlay | null = null;
			let closePanel: (() => void) | null = null;

			/** 发起一轮问答（首问与追问共用） */
			const ask = (question: string) => {
				if (controller.signal.aborted) return;
				overlayRef?.startQuestion(question);
				void runBtwTurn(ctx, model, thread, question, controller.signal, overlayRef!, (answer) => {
					thread.push({ role: "user", content: [{ type: "text", text: question }] });
					thread.push({ role: "assistant", content: [{ type: "text", text: answer }] });
					// 控制面板线程长度：超过上限丢弃最早轮次
					if (thread.length > BTW_MAX_THREAD_TURNS * 2) {
						thread.splice(0, thread.length - BTW_MAX_THREAD_TURNS * 2);
					}
					overlayRef?.commit();
				});
			};

			/** m 转正：把 btw 问答打包给主 agent 继续处理，然后关闭面板 */
			const transfer = () => {
				if (controller.signal.aborted) return;
				const transcript = overlayRef?.getTranscript() ?? "";
				if (!transcript) return;
				const message =
					`[btw 转交] 以下是我在侧栏用 /btw 的临时问答（未写入本会话历史），` +
					`其中值得继续跟进，请基于此继续处理：\n\n${transcript}\n\n` +
					`（直接按内容继续即可，无需回应此来源标记本身）`;
				pi.sendUserMessage(message, { deliverAs: "followUp" });
				ctx.ui.notify("已把 btw 问答转交主 agent 处理", "info");
				closePanel?.();
			};

			try {
				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						closePanel = () => done();
						const overlay = new BtwOverlay(tui, theme, ask, transfer, done);
						overlayRef = overlay;
						ask(firstQuestion);
						return overlay;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "right-center",
							width: BTW_OVERLAY_WIDTH,
							minWidth: BTW_OVERLAY_MIN_WIDTH,
							maxHeight: BTW_OVERLAY_MAX_HEIGHT,
							margin: { right: 1 },
						},
					},
				);
			} finally {
				clearTimeout(timer);
				activeBtw = null;
				// 面板关闭（Esc/转正/超时/会话切换）后中止仍在跑的流式请求
				controller.abort();
			}
		},
	});

	// 会话切换/关闭时中止后台流
	pi.on("session_shutdown", async () => {
		activeBtw?.abort();
		activeBtw = null;
	});
}
