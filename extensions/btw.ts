/**
 * btw: Claude Code 风格 /btw 临时旁支问答
 *
 * - /btw <问题>：在主任务进行中打开右侧浮层，做临时问答（by the way）
 * - 面板内可多轮追问（Enter 输入，最多 BTW_MAX_THREAD_TURNS 轮），
 *   上下文 = 主会话 + 面板内历次问答，仍独立于主会话、零污染
 * - m 一键转正：把全部 Q/A 打包，随下一条消息附带发送（不立即发出，界面提示已附带）
 * - 携带当前会话上下文（buildSessionContext，含压缩结果），能回答与当前
 *   任务相关的问题（如「刚才为什么选这个方案」「改了哪些文件」）
 * - /btw-config：配置 btw 使用的模型；默认 auto = 已认证可用模型中最便宜的，
 *   按价格顺序故障转移（便宜模型调用失败自动换下一个更贵的重试，全失败才报错）；
 *   另有 auto-not-free（忽略价格 ≤ 0 的免费模型）与任意 provider/modelId 可选，
 *   交互选择里支持关键词搜索模型
 * - 始终携带只读工具（read / ls / grep / find，无 bash）：问「xx 函数在哪
 *   定义」「这个配置是干嘛的」类问题可直接查证代码，只读不写
 * - 流式显示回答；Esc 关闭并中止请求；↑↓ 滚动查看完整回答
 *
 * 实现要点：
 * - 认证走 ctx.modelRegistry.getApiKeyAndHeaders()（与 init 子代理同一条链）；
 * - 消息序列全量降级清洗：toolResult 降级为 user、剥离 tool_use/thinking 块、
 *   合并连续同角色、保证以 user 结尾——兼容 OpenAI（role 'tool' 配对校验）与
 *   Anthropic（tool_result 紧跟 assistant tool_use）两类端点，截断也安全；
 * - 问答跑 pi-agent-core 官方 agentLoop（与 init 子代理同构）：每轮 LLM 调用
 *   经 streamFn 包装转发 text_delta 到面板实现流式；工具轮次的状态
 *   （tool_execution_start/end）在面板状态行显示当前工具；
 * - 浮层用 ctx.ui.custom + overlay 模式，组件持有 tui 引用，delta 时 requestRender。
 */
import {
	createReadOnlyTools,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Message, Model } from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentLoopConfig, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** btw 单次 LLM 调用最大输出 token（含工具轮次） */
const BTW_MAX_TOKENS = 4096;
/** btw 面板单轮问答最多跑几轮（一轮 = 一次 LLM 调用 + 可能的工具调用） */
const BTW_MAX_TURNS = 6;
/** 空回答自动重试次数：部分模型（如 deepseek-v4-flash）偶发返回空 assistant 消息（content 空数组、无流式、瞬时完成），重试可大概率恢复 */
const BTW_EMPTY_RETRY = 1;
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
/** 浮层渲染行数上限（render 按终端高度自适应，保证边框完整） */
const BTW_MAX_ROWS = 32;
/** 单条问题最多显示几行（超出截断） */
const BTW_MAX_QUESTION_LINES = 4;
/** 输入框最多多少个字符 */
const BTW_MAX_INPUT_LENGTH = 300;

/** btw 默认模型设置：auto = 已认证可用模型中最便宜的，按价格顺序故障转移；auto-not-free = 忽略免费模型 */
const BTW_DEFAULT_MODEL = "auto";

/** btw 助手的系统提示词（固定指令在前，利于 provider 端 prompt 缓存命中） */
const BTW_SYSTEM_PROMPT = [
	"你是 btw 助手（by the way），运行在用户正在进行的编码任务旁边的侧栏问答面板里。",
	"用户此刻就是在这个面板中与你对话——本面板独立于主会话，你的回答不会写入主会话。",
	"你的回答会以 markdown 轻量渲染显示（**粗体**、`行内代码`、`# 标题`、`- 列表`、markdown 表格），需要结构化时尽管使用。",
	"",
	"你可以使用只读工具（read / ls / grep / find）查证代码与文件内容来回答得更准确，",
	"但只读不写：不要修改任何文件，也不能执行命令（没有 bash 工具）。",
	"",
	"输入结构：",
	"- 前半部分是主会话的对话历史（用户消息、助手消息、工具输出），帮助你理解任务背景；",
	"- 后半部分是本面板内你与此用户的历次问答（user 是问题、assistant 是你的回答）；",
	"- 最后一条 user 消息是当前要回答的问题。",
	"",
	"要求：",
	"- 回答准确、简洁、直接：默认控制在几句话到一小段，像资深同事随口回答；用户明确要求详细时才展开",
	"- 专注当前问题本身：不要汇报/总结主会话的进度、状态或做了什么，除非用户明确要求",
	"- 开场直接给答案，不要「让我看看」「梳理一下」「我发现了问题」这类过渡语或复盘",
	"- 只回答当前问题本身，不要复述任务、不要列行动清单、不要建议下一步行动",
	"- 需要查证时先用只读工具看文件，再回答；工具调用轮次里不要长篇大论，最终回答才展开",
	"- 被问到关于你自己的问题（如「你知道自己在哪吗」「你能用工具吗」），如实说明：你是 btw 面板助手，",
	"  独立于主会话，只能读文件（read / ls / grep / find），不能修改文件或执行命令",
	"- 追问时结合前面的问答（例如「我刚才提到的 xx 具体指？」），不要重复已给过的内容",
	"- 不提及「对话历史」「上下文」等内部机制，直接回答问题",
	"- 如果依据现有信息无法判断，明确说明这一点",
].join("\n");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

// ---------------------------------------------------------------------------
// btw 模型选择
// ---------------------------------------------------------------------------

/** 当前 btw 模型设置：'auto'（默认）/ 'auto-not-free'（忽略免费模型）或 'provider/modelId'；/btw-config 修改，模块级跨命令持久 */
let btwModelSetting: string = BTW_DEFAULT_MODEL;

/** 模型单价合计（input + output，$/M tokens；价格缺失按 0 计） */
function modelTotalCost(m: AnyModel): number {
	return (m.cost?.input ?? 0) + (m.cost?.output ?? 0);
}

/** 可用（已认证）模型按价格升序排列，同价按 id 字典序保证列表稳定；excludeFree 时忽略价格 ≤ 0 的免费模型 */
function listAvailableModels(ctx: ExtensionCommandContext, opts?: { excludeFree?: boolean }): AnyModel[] {
	const reg = ctx.modelRegistry;
	return reg
		.getAvailable()
		.filter((m) => reg.hasConfiguredAuth(m))
		.filter((m) => !opts?.excludeFree || modelTotalCost(m) > 0)
		.sort((a, b) => modelTotalCost(a) - modelTotalCost(b) || a.id.localeCompare(b.id));
}

/** 模型价格展示文本，如 `$0.14/$0.28 per M`（input/output，单位美元每百万 token） */
function formatModelPrice(m: AnyModel): string {
	const c = m.cost;
	return c ? `$${c.input}/${c.output} per M` : "价格未知";
}

/** 上下文窗口可读化：1048576 → 1M、262144 → 256K */
function formatContextWindow(n: number | undefined): string {
	if (!n || n <= 0) return "?";
	if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
	return String(n);
}

/** 模型设置的人话说明（notify 文案用）：auto / auto-not-free 给策略描述，固定模型给 provider/id */
function modelSettingLabel(setting: string): string {
	if (setting === "auto") return "最便宜可用模型，按价格顺序故障转移";
	if (setting === "auto-not-free") return "忽略免费模型，最便宜的非免费模型按价格顺序故障转移";
	return setting;
}

/**
 * 按设置串查找已认证模型：含 '/' 视为精确 provider/modelId；否则按模型 id
 * 子串匹配（不区分大小写，唯一命中才返回，多命中由调用方列出候选）
 */
function findConfiguredModel(ctx: ExtensionCommandContext, setting: string): AnyModel | undefined {
	const reg = ctx.modelRegistry;
	if (setting.includes("/")) {
		const [provider, id] = setting.split("/", 2);
		const m = reg.find(provider.trim(), id?.trim() ?? "");
		return m && reg.hasConfiguredAuth(m) ? m : undefined;
	}
	const matches = listAvailableModels(ctx).filter((m) => m.id.toLowerCase().includes(setting.toLowerCase()));
	return matches.length === 1 ? matches[0] : undefined;
}

interface BtwModelPlan {
	mode: "auto" | "fixed";
	/** 当前要使用的模型；没有已认证可用模型时为 undefined */
	model: AnyModel | undefined;
	/** auto 模式：返回下一个更贵的模型（故障转移链），耗尽返回 undefined；fixed 模式恒为 undefined */
	failover: (() => AnyModel | undefined) | undefined;
}

/**
 * 解析当前 btw 模型设置：auto = 最便宜可用模型，auto-not-free = 最便宜的非免费
 * 模型（忽略价格 ≤ 0 的免费模型），均含按价格升序的故障转移链；固定模型不可用
 * （认证被移除等）时静默回退 auto，保证问答尽量可用。
 */
function resolveBtwModel(ctx: ExtensionCommandContext): BtwModelPlan {
	if (btwModelSetting !== "auto" && btwModelSetting !== "auto-not-free") {
		const fixed = findConfiguredModel(ctx, btwModelSetting);
		if (fixed) return { mode: "fixed", model: fixed, failover: undefined };
		btwModelSetting = BTW_DEFAULT_MODEL;
	}
	const excludeFree = btwModelSetting === "auto-not-free";
	let sorted = listAvailableModels(ctx, { excludeFree });
	// auto-not-free 但当前没有非免费模型：回退到全部可用模型，避免完全不可用
	if (sorted.length === 0 && excludeFree) sorted = listAvailableModels(ctx);
	if (sorted.length === 0) return { mode: "auto", model: undefined, failover: undefined };
	let idx = 0;
	return {
		mode: "auto",
		model: sorted[0],
		failover: () => sorted[++idx],
	};
}

// ---------------------------------------------------------------------------
// 消息清洗与组装
// ---------------------------------------------------------------------------

/** 从消息中提取纯文本（剥离 tool_use / thinking 等非文本块） */
function extractTextBlocks(m: AgentMessage): string {
	// AgentMessage 联合中部分变体（如 BashExecutionMessage）无 content，类型上断言访问
	const content = (m as { content?: string | unknown[] }).content;
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: "text"; text: string } => {
				const block = b as { type?: unknown; text?: unknown };
				return block.type === "text" && typeof block.text === "string";
			})
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
			const sep = msg.role === "user" ? [{ type: "text" as const, text: "\n\n" }] : [];
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
 *
 * 主 agent 正在工作时（ctx.isIdle() 为 false），上下文截止到最近一次
 * 用户输入（不含）——避免把未完成的 turn（partial assistant 消息、
 * 中间工具结果）喂给 btw，让面板聚焦于任务开始前的稳定历史。
 */
function buildContextMessages(sessionMessages: AgentMessage[], ctx: ExtensionCommandContext): Message[] {
	if (!ctx.isIdle()) {
		let lastUser = -1;
		for (let i = sessionMessages.length - 1; i >= 0; i--) {
			if (sessionMessages[i]!.role === "user") {
				lastUser = i;
				break;
			}
		}
		if (lastUser >= 0) sessionMessages = sessionMessages.slice(0, lastUser);
	}

	const cleaned: Message[] = [];
	for (const m of sessionMessages) {
		if (m.role === "user" || m.role === "assistant") {
			const text = extractTextBlocks(m);
			if (text) cleaned.push({ role: m.role, content: [{ type: "text", text }], timestamp: m.timestamp } as Message);
		} else if (m.role === "toolResult") {
			const text = extractTextBlocks(m).slice(0, BTW_MAX_TOOL_RESULT_CHARS);
			if (text) {
				cleaned.push({ role: "user", content: [{ type: "text", text: `[工具 ${m.toolName} 输出]\n${text}` }], timestamp: Date.now() } as Message);
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

/** 标准消息直通转换：agentLoop 会话里只有 user/assistant/toolResult */
function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
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

/** 返回文本显示宽度达到 targetW 时的字符索引（供输入框水平滚动窗口定位） */
function charIndexAtWidth(text: string, targetW: number): number {
	let w = 0;
	for (let i = 0; i < text.length; i++) {
		const chW = visibleWidth(text[i]!);
		if (w + chW > targetW) return i;
		w += chW;
	}
	return text.length;
}

/** 从 startChar 起按显示宽度截取最多 maxW 宽的文本（不截断字符） */
function sliceByWidth(text: string, startChar: number, maxW: number): string {
	let out = "";
	let w = 0;
	for (let i = startChar; i < text.length; i++) {
		const chW = visibleWidth(text[i]!);
		if (w + chW > maxW) break;
		out += text[i];
		w += chW;
	}
	return out;
}

/** 行内 markdown 轻量渲染：行内代码 / 粗体 / 斜体（在 wrap 之后调用，ANSI 不参与宽度计算） */
function renderInline(text: string, th: Theme): string {
	// 行内代码 `code`（先处理，避免与粗体/斜体标记混淆）
	text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => th.fg("accent", code));
	// 粗体 **bold**
	text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, bold: string) => th.bold(bold));
	// 斜体 *italic*（单个星号，粗体已被替换不会误伤）
	text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, italic: string) => `${pre}${th.italic(italic)}`);
	return text;
}

/** 单行 markdown 轻量渲染：代码块分隔 / 标题 / 列表前缀 + 行内样式 */
function renderLine(line: string, th: Theme): string {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("```")) return th.fg("muted", line);
	if (/^#{1,6}\s/.test(trimmed)) return th.fg("accent", th.bold(line));
	const listMatch = /^[-*]\s+/.exec(trimmed);
	if (listMatch) return "• " + renderInline(trimmed.slice(listMatch[0].length), th);
	return renderInline(line, th);
}

// ---- markdown 表格（在 wrap 之前识别整块，避免换行拆散对齐） ----

/** 表格行判定：以 | 开头且结尾，且中间还有 | */
function isTableRow(line: string): boolean {
	return line.startsWith("|") && line.endsWith("|") && line.includes("|", 1);
}

/** 拆分成单元格（去首尾 |，按 | 切分并 trim） */
function splitTableRow(line: string): string[] {
	return line.slice(1, -1).split("|").map((s) => s.trim());
}

/** 分隔行判定：如 |---|---|、|:--:| */
function isTableSeparator(line: string): boolean {
	if (!isTableRow(line)) return false;
	return splitTableRow(line).every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** 渲染 markdown 表格：列宽按内容自适应，超宽时压缩最宽列，表头高亮 */
function renderTable(rows: string[][], th: Theme, maxW: number): string[] {
	const colCount = Math.max(1, ...rows.map((r) => r.length));

	// 列宽 = 该列单元格的最大可见宽度
	const widths: number[] = [];
	for (let c = 0; c < colCount; c++) {
		let w = 0;
		for (const r of rows) {
			if (c < r.length) w = Math.max(w, visibleWidth(r[c]!));
		}
		widths.push(w);
	}

	// 总宽 = 边框 + 各列（内容 + 两侧 padding）+ 列分隔
	const totalW = () => widths.reduce((a, b) => a + b, 0) + colCount * 3 + 1;
	// 超宽压缩：反复削减当前最宽且可减的列，每列至少 1 宽
	let guard = 0;
	while (totalW() > maxW && guard < colCount * 50) {
		guard++;
		let widest = -1;
		let widestW = 0;
		for (let c = 0; c < colCount; c++) {
			if (widths[c]! > 1 && widths[c]! > widestW) {
				widestW = widths[c]!;
				widest = c;
			}
		}
		if (widest < 0) break; // 全部已到最小宽度
		widths[widest] = widestW - 1;
	}

	const cells = (row: string[], isHeader: boolean): string => {
		let line = "│";
		for (let c = 0; c < colCount; c++) {
			const cell = c < row.length ? row[c]! : "";
			const display = truncateToWidth(cell, widths[c]!, "…", false);
			const pad = Math.max(0, widths[c]! - visibleWidth(display));
			const styled = isHeader ? th.bold(display) : display;
			line += ` ${styled}${' '.repeat(pad)} │`;
		}
		return isHeader ? th.fg("accent", line) : th.fg("text", line);
	};
	const separator = (): string => {
		let line = "├";
		for (let c = 0; c < colCount; c++) {
			line += "─".repeat(widths[c]! + 2) + (c < colCount - 1 ? "┼" : "┤");
		}
		return th.fg("muted", line);
	};

	const out: string[] = [];
	out.push(`  ${cells(rows[0]!, true)}`);
	out.push(`  ${separator()}`);
	for (const r of rows.slice(1)) out.push(`  ${cells(r, false)}`);
	return out;
}

/** 渲染一段回答：识别表格块整体渲染，其余按行 wrap + 行内样式（含代码块状态） */
function renderAnswer(text: string, th: Theme, contentWidth: number): string[] {
	const rawLines = text.split("\n");
	const out: string[] = [];
	let inCode = false;
	let i = 0;
	while (i < rawLines.length) {
		const line = rawLines[i]!;
		const trimmed = line.trim();

		if (trimmed.startsWith("```")) {
			out.push(`  ${th.fg("muted", line)}`);
			inCode = !inCode;
			i++;
			continue;
		}
		if (inCode) {
			for (const l of wrapText(line, contentWidth)) out.push(`  ${l}`);
			i++;
			continue;
		}
		// 表格块：当前行是表格行且下一行是分隔行
		if (isTableRow(trimmed) && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1]!.trim())) {
			const rows: string[][] = [splitTableRow(trimmed)];
			i += 2; // 跳过表头行与分隔行
			while (i < rawLines.length && isTableRow(rawLines[i]!.trim())) {
				rows.push(splitTableRow(rawLines[i]!.trim()));
				i++;
			}
			out.push(...renderTable(rows, th, contentWidth));
			continue;
		}
		for (const l of wrapText(line, contentWidth)) out.push(`  ${renderLine(l, th)}`);
		i++;
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

		// 顶部边框 + 标题（含实际使用模型，随 ask / 故障转移更新）
		const titleStr = ` ${th.fg("accent", "💬 btw")}${this.modelLabel ? `${th.fg("dim", " · ")}${th.fg("dim", this.modelLabel)}` : ""} `;
		const titleW = visibleWidth(titleStr);
		lines.push(border(`╭${titleStr}${"─".repeat(Math.max(0, innerW - titleW))}╮`));

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
			const inputW = Math.max(8, innerW - 5);
			const full = this.inputText;
			const totalW = visibleWidth(full);
			let startChar = 0;
			if (totalW > inputW) {
				// 光标在窗口 60% 处：窗口起点 = 光标前留 60% 宽度的位置
				const cursorW = visibleWidth(full.slice(0, this.inputCursor));
				startChar = charIndexAtWidth(full, Math.max(0, cursorW - Math.floor(inputW * 0.6)));
			}
			const windowText = sliceByWidth(full, startChar, inputW);
			const cursorInWindow = Math.min(Math.max(0, this.inputCursor - startChar), windowText.length);

			let inputDisplay = windowText;
			if (this.focused) {
				const before = inputDisplay.slice(0, cursorInWindow);
				const cursorChar = cursorInWindow < inputDisplay.length ? inputDisplay[cursorInWindow] : " ";
				const after = inputDisplay.slice(cursorInWindow + 1);
				inputDisplay = `${before}${CURSOR_MARKER}\x1b[7m${cursorChar}\x1b[27m${after}`;
			}
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
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ---------------------------------------------------------------------------
// btw 模型选择器（可搜索列表组件）
// ---------------------------------------------------------------------------

interface ModelSelectItem {
	/** 显示文本（纯文本，无 ANSI） */
	label: string;
	/** 选择后写入 btwModelSetting 的值：'auto' | 'auto-not-free' | 'provider/modelId' */
	value: string;
	/** 搜索用归一化文本（小写），命中 provider / id / 显示名任意部分即可 */
	search: string;
}

/**
 * 可搜索模型选择器：顶部搜索框实时过滤（打字即搜），下方列表展示全部可选模型，
 * ↑↓ 移动选择、Enter 确认、Esc 取消。输入框聚焦态直接接收字符（无需先按 Enter）。
 */
class ModelSelectOverlay {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private done: (result: string | null) => void;
	private items: ModelSelectItem[];
	/** 当前生效设置（列表里带 ✓ 标记） */
	private current: string;

	private query = "";
	private queryCursor = 0;
	private filtered: ModelSelectItem[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		items: ModelSelectItem[],
		current: string,
		done: (result: string | null) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.items = items;
		this.current = current;
		this.done = done;
		// 初始定位到当前设置项（找不到则第一项）
		const idx = items.findIndex((it) => it.value === current);
		this.selectedIndex = idx >= 0 ? idx : 0;
		this.applyFilter();
		this.clampScroll();
	}

	/** 重新过滤并钳制选中项 */
	private applyFilter(): void {
		const q = this.query.trim().toLowerCase();
		this.filtered = q ? this.items.filter((it) => it.search.includes(q)) : this.items;
		if (this.selectedIndex >= this.filtered.length) {
			this.selectedIndex = Math.max(0, this.filtered.length - 1);
		}
		this.tui.requestRender();
	}

	/** 列表可见行数（按终端高度自适应） */
	private getListRows(): number {
		const termRows = this.tui.terminal.rows;
		if (!termRows || termRows <= 0) return 20;
		return Math.max(6, Math.min(24, Math.floor(termRows * 0.6)));
	}

	/** 滚动窗口跟随选中项：上超窗顶对齐，下超窗底留一行 */
	private clampScroll(): void {
		const rows = this.getListRows();
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + rows - 1) {
			this.scrollOffset = this.selectedIndex - rows + 2;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "return")) {
			const item = this.filtered[this.selectedIndex];
			if (item) this.done(item.value);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.queryCursor > 0) {
				this.query = this.query.slice(0, this.queryCursor - 1) + this.query.slice(this.queryCursor);
				this.queryCursor--;
				this.applyFilter();
			}
			return;
		}
		if (matchesKey(data, "left")) {
			this.queryCursor = Math.max(0, this.queryCursor - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.queryCursor = Math.min(this.query.length, this.queryCursor + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.clampScroll();
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.selectedIndex < this.filtered.length - 1) {
				this.selectedIndex++;
				this.clampScroll();
				this.tui.requestRender();
			}
			return;
		}
		// 可打印字符：插入搜索词并实时过滤
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query = this.query.slice(0, this.queryCursor) + data + this.query.slice(this.queryCursor);
			this.queryCursor++;
			this.applyFilter();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const border = (s: string) => th.fg("border", s);
		const row = (content: string) => border("│") + truncateToWidth(content, innerW, "…", true) + border("│");
		const lines: string[] = [];

		// 顶部边框 + 标题
		const titleStr = ` ${th.fg("accent", "🔍 选择 btw 模型")} `;
		lines.push(border(`╭${titleStr}${"─".repeat(Math.max(0, innerW - visibleWidth(titleStr)))}╮`));

		// 搜索框：水平滚动窗口跟随光标（❯ 前缀占 4 个显示宽度），不截断内容
		const inputW = Math.max(8, innerW - 3);
		const full = this.query;
		const totalW = visibleWidth(full);
		let startChar = 0;
		if (totalW > inputW) {
			const cursorW = visibleWidth(full.slice(0, this.queryCursor));
			startChar = charIndexAtWidth(full, Math.max(0, cursorW - Math.floor(inputW * 0.6)));
		}
		const windowText = sliceByWidth(full, startChar, inputW);
		const cursorInWindow = Math.min(Math.max(0, this.queryCursor - startChar), windowText.length);
		let inputDisplay = windowText;
		if (this.focused) {
			const before = inputDisplay.slice(0, cursorInWindow);
			const cursorChar = cursorInWindow < inputDisplay.length ? inputDisplay[cursorInWindow] : " ";
			const after = inputDisplay.slice(cursorInWindow + 1);
			inputDisplay = `${before}${CURSOR_MARKER}\x1b[7m${cursorChar}\x1b[27m${after}`;
		}
		lines.push(row(` ${th.fg("accent", "❯")} ${inputDisplay}`));

		// 列表：滚动窗口 + 当前项 ✓ 标记 + 选中项反显
		const listRows = this.getListRows();
		this.clampScroll();
		const visible = this.filtered.slice(this.scrollOffset, this.scrollOffset + listRows);
		for (let i = 0; i < visible.length; i++) {
			const item = visible[i]!;
			const isCurrent = item.value === this.current;
			const isSelected = this.scrollOffset + i === this.selectedIndex;
			let text = `${isCurrent ? "✓ " : "  "}${item.label}`;
			if (isSelected) text = `\x1b[7m${text}\x1b[27m`;
			lines.push(row(` ${text}`));
		}
		for (let i = visible.length; i < listRows; i++) lines.push(row(""));

		// 状态行
		const currentItem = this.filtered[this.selectedIndex];
		const status = currentItem ? `${this.filtered.length} 个匹配 · 当前：${currentItem.value}` : "无匹配";
		lines.push(row(th.fg("dim", `${status} · ↑↓ 选择 · Enter 确认 · Esc 取消`)));
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
	failover?: () => AnyModel | undefined,
	retries = 0,
): Promise<void> {
	// 只读工具集：read / ls / grep / find（无 bash，只读不写）
	const tools = createReadOnlyTools(ctx.cwd);

	// 历史 = 主会话上下文（清洗）+ 面板内历次问答；当前问题作为本次 prompts
	// buildSessionContext 运行时存在（agent-session 内部调用），仅类型未在 ReadonlySessionManager 暴露
	const sessionMessages = (
		ctx.sessionManager as unknown as { buildSessionContext(): { messages: AgentMessage[] } }
	).buildSessionContext().messages;
	const context = buildContextMessages(sessionMessages, ctx);
	const history = mergeAdjacent([...context, ...thread]).slice(-BTW_MAX_TOTAL_MESSAGES);
	const userMessage: AgentMessage = { role: "user", content: question, timestamp: Date.now() };

	// 每次 LLM 调用前从模型注册表取最新认证（兼容 OAuth 刷新）；流对象保持原生
	const streamFn: StreamFn = async (m, c, options) => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
		if (!auth.ok) throw new Error(`认证失败：${auth.error}`);
		return streamSimple(m, c, {
			...options,
			apiKey: auth.apiKey ?? options?.apiKey,
			headers: { ...auth.headers, ...options?.headers },
		});
	};

	let turns = 0;
	const config: AgentLoopConfig = {
		model,
		maxTokens: BTW_MAX_TOKENS,
		convertToLlm,
		shouldStopAfterTurn: () => ++turns >= BTW_MAX_TURNS,
	};

	try {
		const newMessages = await runAgentLoop(
			[userMessage],
			{ systemPrompt: BTW_SYSTEM_PROMPT, messages: history, tools },
			config,
			(event) => {
				if (event.type === "tool_execution_start") {
					overlay.showTool(event.toolName, event.args);
				} else if (event.type === "tool_execution_end") {
					overlay.hideTool();
				} else if (event.type === "message_update") {
					// agentLoop 官方事件通道携带原始流事件：转发 text_delta 实现流式显示
					const s = event.assistantMessageEvent;
					if (s.type === "text_delta") overlay.appendAnswer(s.delta);
				}
			},
			signal,
			streamFn,
		);

		// 最终回答 = 最后一条含文本的 assistant 消息；优先于流式累积（后者含中间轮次文本）
		for (let i = newMessages.length - 1; i >= 0; i--) {
			const m = newMessages[i];
			if (m.role !== "assistant") continue;
			const text = extractText(m as { content?: Array<{ type: string; text?: string }> });
			if (text) {
				overlay.finish(text);
				onDone(text);
				return;
			}
		}
		// 没有找到文字回答（预算用尽等）：用累积文本兜底
		const fallback = overlay.getAnswer();
		if (!fallback && retries < BTW_EMPTY_RETRY) {
			// 模型偶发空回答（如 deepseek-v4-flash 瞬时返回空 assistant 消息）：清空状态重试
			overlay.startQuestion(question); // 清空 answer/status，重新进入 thinking
			return runBtwTurn(ctx, model, thread, question, signal, overlay, onDone, failover, retries + 1);
		}
		overlay.finish(fallback);
		onDone(fallback);
	} catch (e) {
		if (signal.aborted) return; // 用户已 Esc 关闭面板，无需再更新
		// auto 模式故障转移：本次调用失败（认证/网络/API 错误）换下一个更贵的模型重试
		const next = failover?.();
		if (next) {
			overlay.setModel(`${next.provider}/${next.id}`); // 标题同步实际使用模型
			overlay.startQuestion(question);
			return runBtwTurn(ctx, next, thread, question, signal, overlay, onDone, failover, retries);
		}
		overlay.fail(e instanceof Error ? e.message : String(e));
	}
}

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// 同时只允许一个 btw 面板
	let activeBtw: { abort: () => void } | null = null;

	// ---- m 转正：暂存待附带的问答，等用户下一条交互消息随附发送 ----
	// 按 m 不立即 sendUserMessage，而是记入 pendingTransfer；用户在 input 事件提交
	// 下一条消息时（source === "interactive"）通过 transform 把问答拼到消息末尾，
	// 输入框里用户只看到自己的文本 + "📎 已附带"提示，不出现原始问答内容。
	let pendingTransfer: string | null = null;

	pi.on("input", async (event, ctx) => {
		if (pendingTransfer && event.source === "interactive") {
			const attach = pendingTransfer;
			pendingTransfer = null;
			ctx.ui.setStatus("btw-transfer", undefined); // 提示随发送消失（hud 行 1 / 原生 footer 第 3 行）
			return { action: "transform", text: `${event.text}\n\n---\n\n${attach}` };
		}
		return { action: "continue" };
	});

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
			const plan = resolveBtwModel(ctx);
			if (!plan.model) {
				ctx.ui.notify("没有可用的已认证模型，无法启动 btw（请先配置 provider 认证）", "error");
				return;
			}
			const autoHint =
				btwModelSetting === "auto-not-free"
					? "（auto-not-free，最便宜非免费模型，按价格顺序故障转移）"
					: "（auto，最便宜可用，按价格顺序故障转移）";
			ctx.ui.notify(`btw 使用模型：${plan.model.provider}/${plan.model.id}${plan.mode === "auto" ? autoHint : ""}`, "info");
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
				// 每次提问重新解析：auto 实时选当前最便宜模型；固定模型失效自动回退 auto
				const p = resolveBtwModel(ctx);
				if (!p.model) {
					overlayRef?.fail("没有可用的已认证模型");
					return;
				}
				overlayRef?.setModel(`${p.model.provider}/${p.model.id}`); // 标题栏显示实际使用模型
				overlayRef?.startQuestion(question);
				void runBtwTurn(ctx, p.model, thread, question, controller.signal, overlayRef!, (answer) => {
					thread.push({ role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() } as Message);
					thread.push({ role: "assistant", content: [{ type: "text", text: answer }], timestamp: Date.now() } as Message);
					// 控制面板线程长度：超过上限丢弃最早轮次
					if (thread.length > BTW_MAX_THREAD_TURNS * 2) {
						thread.splice(0, thread.length - BTW_MAX_THREAD_TURNS * 2);
					}
					overlayRef?.commit();
				}, p.failover);
			};

			/** m 转正：把 btw 问答打包，随下一条消息附带发送（不立即发出），然后关闭面板 */
			const transfer = () => {
				if (controller.signal.aborted) return;
				const transcript = overlayRef?.getTranscript() ?? "";
				if (!transcript) return;
				pendingTransfer =
					`[btw 转交] 以下是我在侧栏用 /btw 的临时问答（未写入本会话历史），` +
					`其中值得继续跟进，请基于此继续处理：\n\n${transcript}\n\n` +
					`（直接按内容继续即可，无需回应此来源标记本身）`;
				// 常驻提示直到随附发送（hud 开着显示在行 1 动态区，关着回落原生 footer 第 3 行）
				ctx.ui.setStatus("btw-transfer", "📎 已附带 btw 问答");
				ctx.ui.notify("📎 已附带 btw 问答，下一条消息将随附发送", "info");
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

	// ---- /btw-config：配置 btw 问答使用的模型 ----
	pi.registerCommand("btw-config", {
		description: "配置 btw 使用的模型：auto（默认，最便宜可用模型）、auto-not-free（忽略免费模型）或 provider/modelId；不带参数进入交互选择（含搜索）",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";

			// 带参数：直接设置
			if (arg) {
				if (arg === "auto" || arg === "auto-not-free") {
					btwModelSetting = arg;
					ctx.ui.notify(`btw 模型已设为 ${arg}（${modelSettingLabel(arg)}）`, "info");
					return;
				}
				const m = findConfiguredModel(ctx, arg);
				if (m) {
					btwModelSetting = `${m.provider}/${m.id}`;
					ctx.ui.notify(`btw 模型已设为 ${btwModelSetting}`, "info");
					return;
				}
				// 未命中：子串匹配到多个时列出部分候选，没有时给用法提示
				const matches = listAvailableModels(ctx).filter((x) =>
					`${x.provider}/${x.id}`.toLowerCase().includes(arg.toLowerCase()),
				);
				ctx.ui.notify(
					matches.length > 0
						? `「${arg}」匹配 ${matches.length} 个模型（${matches
								.slice(0, 3)
								.map((x) => `${x.provider}/${x.id}`)
								.join("、")}${matches.length > 3 ? " 等" : ""}），请用完整 provider/modelId 指定`
						: `未找到「${arg}」。用法：/btw-config auto、auto-not-free 或 /btw-config provider/modelId`,
					"warning",
				);
				return;
			}

			// 无参数：打开可搜索模型选择器（非交互模式只展示当前设置与用法）
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`当前 btw 模型：${btwModelSetting}。用法：/btw-config auto、auto-not-free 或 /btw-config provider/modelId`,
					"info",
				);
				return;
			}
			// 列表 = 两个 auto 策略 + 全部已认证可用模型（价格升序）；顶部搜索框实时过滤
			const models = listAvailableModels(ctx);
			const items: ModelSelectItem[] = [
				{
					label: "auto（默认）：最便宜可用模型，按价格顺序故障转移",
					value: "auto",
					search: "auto 默认",
				},
				{
					label: "auto-not-free：忽略免费模型，最便宜的非免费模型按价格顺序故障转移",
					value: "auto-not-free",
					search: "auto-not-free 忽略免费",
				},
				...models.map((m) => ({
					label: `${m.provider}/${m.id}（${formatModelPrice(m)} · ctx ${formatContextWindow(m.contextWindow)}）`,
					value: `${m.provider}/${m.id}`,
					search: `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase(),
				})),
			];
			const result = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => new ModelSelectOverlay(tui, theme, items, btwModelSetting, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "58%",
						minWidth: 58,
						maxHeight: "90%",
						margin: { right: 1 },
					},
				},
			);
			if (result) {
				btwModelSetting = result;
				ctx.ui.notify(`btw 模型已设为 ${result}（${modelSettingLabel(result)}）`, "info");
			}
		},
	});

	// 会话切换/关闭时中止后台流、清掉未发送的转交内容
	pi.on("session_shutdown", async () => {
		activeBtw?.abort();
		activeBtw = null;
		pendingTransfer = null;
	});
}
