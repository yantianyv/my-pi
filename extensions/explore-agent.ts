/**
 * explore-agent: Claude Code 风格的只读探索子代理
 *
 * 注册 explore 工具：主 agent 只负责「分配任务」，每个任务派出一个子代理。
 * 子代理使用 pi 官方只读工具集（read / ls / grep / find）自主决定探索路径，
 * 完成后返回精炼报告，主上下文不加载原始文件内容。
 *
 * 实现要点：
 * - 子代理跑 pi-agent-core 的 agentLoop（官方 agent 循环，工具自主调用）；
 * - 模型调用走 pi 已登录的通道：认证来自 ctx.modelRegistry.getApiKeyAndHeaders()，
 *   请求由 pi-ai 自己的 provider 实现发出（streamSimple），支持任意 API 类型；
 * - 子模型选择：默认 auto（优先 PREFERRED_MODELS，兜底选「已认证且价格最低」的可用模型），
 *   /explore-model 可配置：auto-not-free（忽略免费模型）或固定 provider/modelId；
 *   无参数进入可搜索模型选择器（↑↓ 选择、Enter 确认、Esc 取消，顶部搜索框实时过滤、
 *   当前项 ✓ 标记），设置持久化到 ~/.pi/agent/explore-model.json；
 * - 预算保护：单任务最多 MAX_TURNS 轮、TASK_TIMEOUT_MS 超时、跟随主 agent abort。
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import {
	runAgentLoop,
	type AgentLoopConfig,
	type AgentMessage,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Message, Model } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 优先选用的子模型（provider/modelId），按顺序尝试；都不可用时自动选最便宜的可用模型 */
const PREFERRED_MODELS: Array<[string, string]> = [["deepseek", "deepseek-v4-flash"]];

/** explore 模型设置持久化文件（agent 目录下，/explore-model 修改后写入，/reload 重载扩展后恢复） */
const EXPLORE_MODEL_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "explore-model.json");
/** 默认设置：auto = 优先 PREFERRED_MODELS，不可用则选最便宜可用模型 */
const EXPLORE_DEFAULT_MODEL = "auto";

/** 单次最多并行派出的子代理数（超出部分截断并在结果里说明） */
const MAX_TASKS = 6;
/** 子代理并发数 */
const CONCURRENCY = 3;
/** 单个子代理最多多少轮（一轮 = 一次 LLM 调用 + 其工具调用） */
const MAX_TURNS = 12;
/** 单个子代理超时 */
const TASK_TIMEOUT_MS = 4 * 60_000;
/** 子模型单次输出上限 */
const SUBAGENT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// 子模型选择
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

/** 当前 explore 模型设置：'auto'（默认）/ 'auto-not-free'（忽略免费模型）或 'provider/modelId'；/explore-model 修改并持久化 */
let exploreModelSetting: string = loadExploreModelSetting();

/** 读取持久化的 explore 模型设置；文件缺失/损坏/内容非法时返回默认 auto */
function loadExploreModelSetting(): string {
	try {
		if (fs.existsSync(EXPLORE_MODEL_CONFIG_FILE)) {
			const d = JSON.parse(fs.readFileSync(EXPLORE_MODEL_CONFIG_FILE, "utf8")) as { model?: unknown };
			if (typeof d.model === "string" && d.model.trim()) return d.model;
		}
	} catch {
		/* 配置文件损坏视为默认 */
	}
	return EXPLORE_DEFAULT_MODEL;
}

/** 持久化 explore 模型设置到 ~/.pi/agent/explore-model.json；写失败静默（仅本次会话生效，reload 后回默认） */
function saveExploreModelSetting(value: string): void {
	try {
		fs.mkdirSync(path.dirname(EXPLORE_MODEL_CONFIG_FILE), { recursive: true });
		fs.writeFileSync(EXPLORE_MODEL_CONFIG_FILE, JSON.stringify({ model: value }, null, 2) + "\n", "utf8");
	} catch {
		/* 写配置失败不影响本次运行 */
	}
}

/** 设置 explore 模型并持久化（/explore-model 所有设置入口统一走这里，避免漏存） */
function setExploreModelSetting(value: string): void {
	exploreModelSetting = value;
	saveExploreModelSetting(value);
}

/**
 * 模型单价合计（input + output，$/M tokens）；动态定价模型用负数标记
 * （如 openrouter/auto 为 -1000000），视为价格未知排到最后，避免 auto 误选。
 */
function modelTotalCost(m: AnyModel): number {
	const c = m.cost;
	if (!c) return Infinity;
	const { input = 0, output = 0 } = c;
	if (input < 0 || output < 0) return Infinity;
	return input + output;
}

/** 可用（已认证）模型按价格升序排列，同价按 id 字典序保证列表稳定；excludeFree 时忽略价格 ≤ 0 的免费模型 */
function listAvailableModels(ctx: ExtensionContext, opts?: { excludeFree?: boolean }): AnyModel[] {
	const reg = ctx.modelRegistry;
	return reg
		.getAvailable()
		.filter((m) => reg.hasConfiguredAuth(m))
		.filter((m) => !opts?.excludeFree || modelTotalCost(m) > 0)
		.sort((a, b) => modelTotalCost(a) - modelTotalCost(b) || a.id.localeCompare(b.id));
}

/** 模型价格展示文本：`$0.14/$0.28 per M`（input/output，单位美元每百万 token）；负数价格（动态定价）标「动态定价」 */
function formatModelPrice(m: AnyModel): string {
	const c = m.cost;
	if (!c) return "价格未知";
	if (c.input < 0 || c.output < 0) return "动态定价";
	return `$${c.input}/${c.output} per M`;
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
	if (setting === "auto") return "优先指定模型，不可用则最便宜可用模型";
	if (setting === "auto-not-free") return "忽略免费模型，最便宜的非免费模型";
	return setting;
}

/**
 * 按设置串查找已认证模型：含 '/' 视为精确 provider/modelId；否则按模型 id
 * 子串匹配（不区分大小写，唯一命中才返回，多命中由调用方列出候选）
 */
function findConfiguredModel(ctx: ExtensionContext, setting: string): AnyModel | undefined {
	const reg = ctx.modelRegistry;
	if (setting.includes("/")) {
		const [provider, id] = setting.split("/", 2);
		const m = reg.find(provider.trim(), id?.trim() ?? "");
		return m && reg.hasConfiguredAuth(m) ? m : undefined;
	}
	const matches = listAvailableModels(ctx).filter((m) => m.id.toLowerCase().includes(setting.toLowerCase()));
	return matches.length === 1 ? matches[0] : undefined;
}

/** auto 模式：优先 PREFERRED_MODELS，不可用则已认证且价格最低 */
function cheapestAvailable(ctx: ExtensionContext, opts?: { excludeFree?: boolean }): AnyModel | undefined {
	return listAvailableModels(ctx, opts)[0];
}

/** 解析当前 explore 模型设置；固定模型不可用（认证被移除等）时静默回退 auto，保证探索尽量可用 */
function pickExploreModel(ctx: ExtensionContext): AnyModel | undefined {
	const reg = ctx.modelRegistry;
	if (exploreModelSetting === "auto") {
		for (const [provider, modelId] of PREFERRED_MODELS) {
			const m = reg.find(provider, modelId);
			if (m && reg.hasConfiguredAuth(m)) return m;
		}
		return cheapestAvailable(ctx);
	}
	if (exploreModelSetting === "auto-not-free") {
		return cheapestAvailable(ctx, { excludeFree: true });
	}
	return findConfiguredModel(ctx, exploreModelSetting) ?? cheapestAvailable(ctx);
}

// ---------------------------------------------------------------------------
// 模型选择器（/explore-model 无参数时弹出的可搜索浮层，与 /btw-config 同款）
// ---------------------------------------------------------------------------

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

interface ModelSelectItem {
	/** 显示文本（纯文本，无 ANSI） */
	label: string;
	/** 选择后写入 exploreModelSetting 的值：'auto' | 'auto-not-free' | 'provider/modelId' */
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
		const titleStr = ` ${th.fg("accent", "🔍 选择 explore 子模型")} `;
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

		// 状态行：选中项在列表里已反显 + ✓ 标记当前设置，这里只提示数量与操作
		const currentItem = this.filtered[this.selectedIndex];
		const status = currentItem ? `${this.filtered.length} 个匹配` : "无匹配（Esc 取消）";
		lines.push(row(th.fg("dim", `${status} · ↑↓ 选择 · Enter 确认 · Esc 取消`)));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ---------------------------------------------------------------------------
// 子代理
// ---------------------------------------------------------------------------

function buildSystemPrompt(cwd: string): string {
	// 注意：固定指令放开头、易变的 cwd 放末尾，利于 provider 端 prompt 缓存命中
	return [
		"你是「探索子代理」，在代码仓库中完成上级 agent 分配的探索任务。",
		"你拥有只读工具：read（读文件）、ls（列目录）、grep（内容搜索）、find（按文件名查找）。",
		"",
		"工作要求：",
		"1. 自主决定探索路径：先用 ls / find / grep 定位相关文件，再用 read 精读关键片段",
		"2. 高效：尽量控制在 10 次工具调用以内，不要读无关文件",
		"3. 报告要精炼：不要客套话，不要粘贴代码原文（一律用『路径:行号』引用代替），结论必须自己归纳，不能用工具输出代替思考",
		"4. 不要尝试「顺手改进」任何文件——你只读，发现问题记录在报告里即可",
		"",
		"输出格式（严格遵守）：",
		"- 文件清单/定位类任务：按目录分组列出文件路径，每条带行号范围与一句摘要（涉及什么函数/调用上下文），例如：",
		"  src/auth/jwt.ts:45-78 — parseToken，核心解析逻辑",
		"- 简单问答类任务：直接回答，不必套清单格式",
		"- 不确定或没找到的地方：标注置信度（确定/推测），不要猜测不存在的路径",
		"- 如果报告包含「没有/不存在/所有/只有这些」这类完备性结论，必须在结论旁注明搜索范围（搜了哪些目录/关键词）——否则上级无法判断是确实没有还是没搜到",
		"",
		`工作目录：${cwd}`,
	].join("\n");
}

/** 标准消息直通转换：子代理会话里只有 user/assistant/toolResult，无需特殊处理 */
function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

function linkSignals(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("子代理超时")), timeoutMs);
	const onAbort = () => controller.abort(parent?.reason);
	if (parent) {
		if (parent.aborted) controller.abort(parent.reason);
		else parent.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

interface TaskResult {
	task: string;
	ok: boolean;
	report?: string;
	error?: string;
}

async function runSubAgent(
	ctx: ExtensionContext,
	model: AnyModel,
	task: string,
	parentSignal: AbortSignal | undefined,
	onToolCall: () => void,
): Promise<TaskResult> {
	const { signal, dispose } = linkSignals(parentSignal, TASK_TIMEOUT_MS);
	try {
		const tools = createReadOnlyTools(ctx.cwd);

		// 每次 LLM 调用前从 pi 的模型注册表取最新认证（兼容 OAuth 刷新），
		// 请求本身由 pi-ai 的 provider 实现发出——即「pi 中登录好的 API」。
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
			maxTokens: SUBAGENT_MAX_TOKENS,
			convertToLlm,
			shouldStopAfterTurn: () => ++turns >= MAX_TURNS,
		};

		const userMessage: AgentMessage = { role: "user", content: task, timestamp: Date.now() };
		const newMessages = await runAgentLoop(
			[userMessage],
			{ systemPrompt: buildSystemPrompt(ctx.cwd), messages: [], tools },
			config,
			(event) => {
				if (event.type === "tool_execution_start") onToolCall();
			},
			signal,
			streamFn,
		);

		// 取最后一条 assistant 消息的文本作为报告
		for (let i = newMessages.length - 1; i >= 0; i--) {
			const m = newMessages[i];
			if (m.role !== "assistant") continue;
			const text = m.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { type: "text"; text: string }).text)
				.join("\n")
				.trim();
			if (text) return { task, ok: true, report: text };
		}
		return { task, ok: false, error: "子代理未产出报告（可能预算用尽）" };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { task, ok: false, error: msg.includes("abort") ? "已中止（超时或用户取消）" : msg };
	} finally {
		dispose();
	}
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

interface ExploreDetails {
	model: string;
	total: number;
	succeeded: number;
	tasks: TaskResult[];
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "explore",
		label: "探索子代理",
		description:
			"派出一个或多个只读子代理并行探索代码库并返回报告。每个子代理拥有 read/ls/grep/find 工具，会自主决定阅读哪些文件，你只负责分配任务。" +
			"适合：了解陌生模块结构、定位功能实现、梳理调用链等——比主 agent 逐文件 read 更省上下文、更快、更便宜（子代理默认用廉价模型）。" +
			"任务描述要具体可回答；多个相互独立的任务一次派出。子代理不能修改文件。",
		promptSnippet: "explore: 派只读子代理并行探索代码库并返回报告（省主上下文）",
		promptGuidelines: [
			"需要了解陌生代码结构或定位实现时，优先用 explore 派子代理，而不是自己逐文件 read；拿到报告后再对关键文件精读。",
			"explore 的任务描述要具体可回答，推荐格式：【目标】要查清的问题【范围】相关目录或关键词【期望产出】如『按目录分组的文件清单+行号』；多个相互独立的任务放在一次调用里并行执行。",
			"explore 报告抽样验证后再采信：关键路径可用 read 抽查是否真实存在，再据此派工修改。",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.String(), {
				description: `分配给子代理的探索任务列表，每个任务派一个子代理，一次最多 ${MAX_TASKS} 个`,
				minItems: 1,
			}),
		}),
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ExploreDetails>> => {
			const fail = (text: string): AgentToolResult<ExploreDetails> => ({
				content: [{ type: "text", text }],
				details: { model: "", total: 0, succeeded: 0, tasks: [] },
			});

			const model = pickExploreModel(ctx);
			if (!model) {
				return fail("explore：找不到可用的子模型（没有任何已配置认证的模型）。请改用 read/grep 自行探索。");
			}

			const truncatedNote =
				params.tasks.length > MAX_TASKS ? `\n（注意：只执行了前 ${MAX_TASKS} 个任务，其余已忽略）` : "";
			const tasks = params.tasks.slice(0, MAX_TASKS);
			const modelName = `${model.provider}/${model.id}`;

			const toolCallCounts = new Array<number>(tasks.length).fill(0);
			const doneFlags = new Array<boolean>(tasks.length).fill(false);
			const doneCount = () => doneFlags.filter(Boolean).length;
			const report = () => {
				const perTask = tasks
					.map((t, i) => {
						const status = doneFlags[i] ? "✓" : `${toolCallCounts[i]} 次工具调用`;
						const label = t.length > 24 ? t.slice(0, 24) + "…" : t;
						return `  ${i + 1}. [${status}] ${label}`;
					})
					.join("\n");
				onUpdate?.({
					content: [{ type: "text", text: `子代理探索中（${modelName}）：\n${perTask}` }],
					details: { model: modelName, total: tasks.length, succeeded: 0, tasks: [] },
				});
				// 进度广播：官方 setStatus 通道推给 hud 行 1 动态区（如「🔎 2/3」），与主 agent 输出解耦
				ctx.ui.setStatus("explore", `🔎 ${doneCount()}/${tasks.length}`);
			};
			report();

			const results = await pool(tasks, CONCURRENCY, async (task: string, i) => {
				try {
					return await runSubAgent(ctx, model, task, signal, () => {
						toolCallCounts[i]++;
						report();
					});
				} finally {
					doneFlags[i] = true;
					report();
				}
			});

			const succeeded = results.filter((r) => r.ok).length;
			// 完成广播：官方 setStatus 通道，hud 显示「🔎 ✓ 2/3」6 秒后自动消失（TTL 由本扩展自管）
			ctx.ui.setStatus("explore", `🔎 ✓ ${succeeded}/${results.length}`);
			setTimeout(() => ctx.ui.setStatus("explore", undefined), 6_000);
			const sections = results.map((r) =>
				r.ok ? `## 任务：${r.task}\n${r.report}` : `## 任务：${r.task}\n⚠ ${r.error}`,
			);
			const text = [
				`探索完成：${succeeded}/${results.length} 个任务成功（子模型 ${modelName}）${truncatedNote}`,
				"",
				...sections,
			].join("\n\n");

			return {
				content: [{ type: "text", text }],
				details: { model: modelName, total: results.length, succeeded, tasks: results },
			};
		},
	});

	// /explore-model：配置 explore 子代理使用的模型（与 /btw-config 同款交互）
	//   带参数：auto / auto-not-free / provider/modelId 直接设置；不带参数：打开可搜索选择器
	pi.registerCommand("explore-model", {
		description:
			"配置 explore 子模型：auto（默认，优先指定模型否则最便宜）、auto-not-free（忽略免费模型）或 provider/modelId；不带参数进入交互选择（含搜索）",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";

			// 带参数：直接设置
			if (arg) {
				if (arg === "auto" || arg === "auto-not-free") {
					setExploreModelSetting(arg);
					ctx.ui.notify(`explore 子模型已设为 ${arg}（${modelSettingLabel(arg)}）`, "info");
					return;
				}
				const m = findConfiguredModel(ctx, arg);
				if (m) {
					setExploreModelSetting(`${m.provider}/${m.id}`);
					ctx.ui.notify(`explore 子模型已设为 ${exploreModelSetting}`, "info");
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
						: `未找到「${arg}」。用法：/explore-model auto、auto-not-free 或 /explore-model provider/modelId`,
					"warning",
				);
				return;
			}

			// 无参数：打开可搜索模型选择器（非交互模式只展示当前设置与用法）
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`当前 explore 子模型：${exploreModelSetting}。用法：/explore-model auto、auto-not-free 或 /explore-model provider/modelId`,
					"info",
				);
				return;
			}
			// 列表 = 两个 auto 策略 + 全部已认证可用模型（价格升序）；顶部搜索框实时过滤
			const models = listAvailableModels(ctx);
			const items: ModelSelectItem[] = [
				{
					label: "auto（默认）：优先指定模型（deepseek/deepseek-v4-flash），不可用则最便宜",
					value: "auto",
					search: "auto 默认",
				},
				{
					label: "auto-not-free：忽略免费模型，最便宜的非免费模型",
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
				(tui, theme, _kb, done) => new ModelSelectOverlay(tui, theme, items, exploreModelSetting, done),
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
				setExploreModelSetting(result);
				ctx.ui.notify(`explore 子模型已设为 ${result}（${modelSettingLabel(result)}）`, "info");
			}
		},
	});
}
