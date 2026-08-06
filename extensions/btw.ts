/**
 * btw: Claude Code 风格 /btw 临时旁支问答
 *
 * - /btw <问题>：在主任务进行中打开右侧浮层，做一次单轮问答（by the way）
 * - 携带当前会话上下文（ctx.sessionManager.buildSessionContext()，含压缩结果），
 *   能回答与当前任务相关的问题（如「刚才为什么选这个方案」「改了哪些文件」）
 * - 回答不写入会话历史：主会话零污染，主 agent 并行运行不受影响，可随时提问
 * - 单轮问答、无工具，对齐 Claude Code /btw 的能力边界（对照表见 README）
 * - 流式显示回答；Esc 关闭并中止请求；↑↓ 滚动查看完整回答
 *
 * 实现要点：
 * - 认证走 ctx.modelRegistry.getApiKeyAndHeaders()（与 init 子代理同一条链）；
 * - 上下文经 buildSessionContext() 解析（自动处理压缩/分支摘要），toolResult
 *   截断控制 token 成本，条数上限丢弃最旧消息；
 * - 流式用 streamSimple（无工具 Context），事件 text_delta 累积文本，
 *   done 事件携带的最终消息为准覆盖；
 * - 浮层用 ctx.ui.custom + overlay 模式，组件持有 tui 引用，
 *   收到 delta 时 tui.requestRender() 触发重绘。
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** btw 回答最大输出 token */
const BTW_MAX_TOKENS = 2048;
/** 请求超时 */
const BTW_TIMEOUT_MS = 5 * 60_000;
/** 携带的上下文消息条数上限（超出从最早开始丢弃，保留最近） */
const BTW_MAX_CONTEXT_MESSAGES = 60;
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
/** 问题区最多显示几行（超出截断） */
const BTW_MAX_QUESTION_LINES = 4;

/** btw 助手的系统提示词（固定指令在前，利于 provider 端 prompt 缓存命中） */
const BTW_SYSTEM_PROMPT = [
	"你是 btw 助手（by the way）。用户在正在进行的编码任务中，在侧栏向你提一个临时问题。",
	"",
	"输入中附上了当前会话的对话历史（用户消息、助手回复、工具输出），帮助你理解任务背景。",
	"最后一条用户消息就是要回答的问题本身。",
	"",
	"要求：",
	"- 回答准确、简洁、直接，像资深同事随口回答一样给出要点，不写长篇大论",
	"- 只回答这个问题本身，不要复述任务，不要主动建议下一步行动或继续做任务",
	"- 不提及「对话历史」「上下文」等内部机制，直接回答问题",
	"- 你不拥有任何工具，只能基于已知信息回答",
	"- 如果依据现有信息无法判断，明确说明这一点",
].join("\n");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

// ---------------------------------------------------------------------------
// 上下文构建
// ---------------------------------------------------------------------------

/** 从会话上下文提取可转发消息，截断超长 toolResult，并限制总条数 */
function buildBtwMessages(sessionMessages: AgentMessage[], question: string): Message[] {
	const kept: AgentMessage[] = [];
	for (const m of sessionMessages) {
		if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
			kept.push(m);
		}
	}

	const trimmed: AgentMessage[] = kept.slice(-BTW_MAX_CONTEXT_MESSAGES).map((m) => {
		if (m.role !== "toolResult" || !Array.isArray(m.content)) return m;
		const content = m.content.map((block) => {
			if (
				block.type === "text" &&
				typeof (block as { text?: unknown }).text === "string" &&
				(block as { text: string }).text.length > BTW_MAX_TOOL_RESULT_CHARS
			) {
				return { ...block, text: (block as { text: string }).text.slice(0, BTW_MAX_TOOL_RESULT_CHARS) + "\n…[btw 截断]" };
			}
			return block;
		});
		return { ...m, content };
	});

	// 问题作为最后一条 user 消息
	trimmed.push({ role: "user", content: [{ type: "text", text: question }] });
	return trimmed as Message[];
}

/** 从最终 AssistantMessage 中提取纯文本回答 */
function extractText(message: { content?: Array<{ type: string; text?: string }> }): string {
	return (message.content ?? [])
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && !!b.text)
		.map((b) => b.text)
		.join("\n")
		.trim();
}

// ---------------------------------------------------------------------------
// 浮层组件
// ---------------------------------------------------------------------------

type BtwStatus = "thinking" | "streaming" | "done" | "error";

class BtwOverlay {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private done: () => void;
	private question: string;
	private answer = "";
	private status: BtwStatus = "thinking";
	private errorText = "";
	private scrollOffset = 0;

	constructor(tui: TUI, theme: Theme, question: string, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.question = question;
		this.done = done;
	}

	// ---- 流式回调（runBtwStream 调用） ----

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
		this.errorText = error;
		this.tui.requestRender();
	}

	isStreaming(): boolean {
		return this.status === "streaming" || this.status === "thinking";
	}

	getAnswer(): string {
		return this.answer;
	}

	// ---- 组件接口 ----

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done();
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

		// 问题区（最多 BTW_MAX_QUESTION_LINES 行）
		const qLines = wrapText(this.question, innerW - 2).slice(0, BTW_MAX_QUESTION_LINES);
		for (const ql of qLines) lines.push(row(` ${th.fg("muted", "Q")} ${th.fg("text", ql)}`));
		lines.push(blank());

		// 回答窗口：预算剩余行数，支持 ↑↓ 滚动
		const budget = Math.max(1, BTW_MAX_ROWS - lines.length - 3);
		const answerLines = this.answer ? wrapText(this.answer, innerW - 2) : [];
		const maxOffset = Math.max(0, answerLines.length - budget);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

		if (this.status === "thinking") {
			lines.push(row(` ${th.fg("dim", "思考中…")}`));
			for (let i = 1; i < budget; i++) lines.push(blank());
		} else if (answerLines.length === 0 && this.status === "done") {
			lines.push(row(` ${th.fg("dim", "（无文字回答）")}`));
			for (let i = 1; i < budget; i++) lines.push(blank());
		} else {
			const visible = answerLines.slice(this.scrollOffset, this.scrollOffset + budget);
			for (const al of visible) lines.push(row(` ${th.fg("text", al)}`));
			for (let i = visible.length; i < budget; i++) lines.push(blank());
		}

		// 状态行
		let statusStr: string;
		if (this.status === "thinking") statusStr = th.fg("dim", "⏳ 思考中…");
		else if (this.status === "streaming") statusStr = th.fg("accent", "⏳ 回答中…");
		else if (this.status === "done") statusStr = th.fg("success", "✓ 回答完毕");
		else statusStr = th.fg("error", `✗ ${this.errorText}`);

		// 提示行（含滚动指示）
		const hints = ["Esc 关闭"];
		if (answerLines.length > budget) {
			const end = Math.min(answerLines.length, this.scrollOffset + budget);
			hints.push(`↑↓ 滚动 ${this.scrollOffset + 1}-${end}/${answerLines.length} 行`);
		}
		lines.push(row(statusStr));
		lines.push(row(th.fg("dim", hints.join(" · "))));

		// 底部边框
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
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
// 后台流式问答
// ---------------------------------------------------------------------------

async function runBtwStream(
	ctx: ExtensionCommandContext,
	model: AnyModel,
	question: string,
	signal: AbortSignal,
	overlay: BtwOverlay,
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

	const sessionMessages = ctx.sessionManager.buildSessionContext().messages;
	const messages = buildBtwMessages(sessionMessages, question);

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
				overlay.finish(extractText(event.message));
				return;
			} else if (event.type === "error") {
				overlay.fail(event.error.errorMessage ?? `请求失败（${event.reason}）`);
				return;
			}
		}
		// 流正常结束但无 done 事件：用已累积文本收尾
		if (overlay.isStreaming()) overlay.finish(overlay.getAnswer());
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
		description: "临时旁支问答（by the way）：侧栏单轮问答，不写入会话历史",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw 需要交互模式", "error");
				return;
			}
			const question = args?.trim();
			if (!question) {
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

			try {
				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						const overlay = new BtwOverlay(tui, theme, question, done);
						void runBtwStream(ctx, model, question, controller.signal, overlay);
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
				// 面板关闭（Esc/超时/会话切换）后中止仍在跑的流式请求
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
