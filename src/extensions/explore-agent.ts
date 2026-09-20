/**
 * explore-agent: 只读探索子代理（从 pi-subagents scout 借鉴优化）
 *
 * 注册 explore 工具：主 agent 只负责「分配任务」，每个任务派出一个子代理。
 * 子代理使用 pi 官方只读工具集（read / ls / grep / find）自主决定探索路径，
 * 完成后返回结构化报告，主上下文不加载原始文件内容。
 *
 * 相比旧版改进（借鉴 pi-subagents scout）：
 * - 低思考等级：探索任务不需要深度推理，用 low thinking 节省 token
 * - 结构化输出：Files Retrieved → Key Code → Architecture → Start Here
 * - 探索纪律：先路径发现再定向搜索，避免无范围 grep 和大文件全读
 *
 * 实现要点：
 * - 子代理跑 pi-agent-core 的 agentLoop（官方 agent 循环，工具自主调用）；
 * - 模型调用走 pi 已登录的通道：认证来自 ctx.modelRegistry.getApiKeyAndHeaders()，
 *   请求由 pi-ai 自己的 provider 实现发出（streamSimple），支持任意 API 类型；
 * - 子模型选择：默认 auto（最便宜可用模型），/explore-config 可配置；
 * - 预算保护：单任务 TASK_TIMEOUT_MS 超时、跟随主 agent abort；
 * - 自适应并发：供应商并发配额无公开 API，乐观起步（CONCURRENCY）动态探测——
 *   限流/5xx/网络错误收并发 + 指数退避重试（限次数），成功后逐步升回上限；
 * - 进度展示：活跃任务在前（工具调用次数/重试中），已完成折叠成汇总行。
 *
 * 工具说明引导：任务数 = 子代理数，一次调用至少 2 个任务（含拒绝引导，避免
 * 主 agent 先派 1 个试探失败再补派）；描述保持简洁，不含过程性说明。
 * 视觉能力动态标注：子模型支持读图（Model.input 含 "image"）时，在工具描述/
 * 指南中标出「可派发截图/图片分析任务」。判定依赖模型注册表（注册时拿不到 ctx），
 * 故在拿到 ctx 的时机（session_start / /explore-config 变更后 / execute 内）
 * 重新注册同名工具覆盖描述（同扩展 tools Map.set 覆盖 + refreshTools 下 turn 生效），
 * 幂等防抖避免无意义刷新。
 */
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import {
	runAgentLoop,
	type AgentLoopConfig,
	type AgentMessage,
} from "@earendil-works/pi-agent-core";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import {
	type AnyModel,
	findConfiguredModel,
	listAvailableModels,
	registerModelConfigCommand,
} from "./shared/model-select";
import { convertToLlm, createPiStreamFn, systemMessage } from "./shared/agent";
import { isModelConfig, loadJsonConfig, saveJsonConfig } from "./shared/config";
import { setStatusWithTTL, clearStatusTimers } from "./shared/status";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** explore 模型设置持久化文件 */
const EXPLORE_MODEL_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "explore-model.json");
/** 默认设置：auto = 最便宜可用模型 */
const EXPLORE_DEFAULT_MODEL = "auto";

/** 单次最多并行派出的子代理数 */
const MAX_TASKS = 32;
/** 子代理并行数上限（自适应并发的恢复上限：出错退避收并发，成功后逐步升回这里） */
const CONCURRENCY = 8;
/** 单个子代理超时 */
const TASK_TIMEOUT_MS = 15 * 60_000;
/** 单任务最大重试次数（仅限可重试错误：限流/5xx/网络抖动/超时） */
const TASK_RETRIES = 2;
/** 重试退避基数（指数递增：2s → 4s → …） */
const BACKOFF_BASE_MS = 2_000;
/** 重试退避上限 */
const BACKOFF_MAX_MS = 30_000;
/** 可重试错误特征：限流/服务端错误/网络抖动/子代理超时；用户取消不在此列 */
const RETRYABLE_RE =
	/\b(429|500|502|503|504)\b|rate.?limit|too many requests|overloaded|capacity|econnreset|econnrefused|epipe|etimedout|enotfound|eai_again|socket hang up|fetch failed|network|子代理超时/i;

// ---------------------------------------------------------------------------
// 子模型选择
// ---------------------------------------------------------------------------

let exploreModelSetting: string = loadExploreModelSetting();

function loadExploreModelSetting(): string {
	return loadJsonConfig<{ model: string }>(EXPLORE_MODEL_CONFIG_FILE, { model: EXPLORE_DEFAULT_MODEL }, isModelConfig).model;
}

function saveExploreModelSetting(value: string): void {
	saveJsonConfig(EXPLORE_MODEL_CONFIG_FILE, { model: value });
}

function setExploreModelSetting(value: string): void {
	exploreModelSetting = value;
	saveExploreModelSetting(value);
}

function cheapestAvailable(ctx: ExtensionContext, opts?: { excludeFree?: boolean }): AnyModel | undefined {
	return listAvailableModels(ctx, opts)[0];
}

function pickExploreModel(ctx: ExtensionContext): AnyModel | undefined {
	if (exploreModelSetting === "auto") return cheapestAvailable(ctx);
	if (exploreModelSetting === "auto-not-free") return cheapestAvailable(ctx, { excludeFree: true });
	return findConfiguredModel(ctx, exploreModelSetting) ?? cheapestAvailable(ctx);
}

/** 模型是否具备读图能力（input 声明含 "image"） */
function modelHasVision(model: AnyModel | undefined): boolean {
	return !!model?.input?.includes("image");
}

/** 当前子模型（按设置解析后）是否支持读图 */
function detectExploreVision(ctx: ExtensionContext): boolean {
	return modelHasVision(pickExploreModel(ctx));
}

// ---------------------------------------------------------------------------
// 自适应并发 + 退避重试（供应商并发配额无公开 API 可查，采用乐观起步动态探测：
// 初始按 CONCURRENCY 跑，可重试错误出现时收并发 + 指数退避，任务成功逐步升回上限）
// ---------------------------------------------------------------------------

/** 可动态升降的并发闸门：acquire 占坑，release 还坑，limit 随成功/失败自适应 */
class AdaptiveLimiter {
	limit: number;
	private active = 0;
	private waiters: Array<() => void> = [];

	constructor(initial: number) {
		this.limit = initial;
	}

	async acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active++;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		this.active--;
		this.pump();
	}

	/** 出错退避：收并发（下限 1，已占坑的不回收） */
	lower(): void {
		this.limit = Math.max(1, this.limit - 1);
	}

	/** 任务成功：逐步恢复并发（封顶 CONCURRENCY） */
	raise(): void {
		this.limit = Math.min(CONCURRENCY, this.limit + 1);
		this.pump();
	}

	/** 有余坑时唤醒等待者（唤醒即占坑，防重复唤醒超发） */
	private pump(): void {
		while (this.active < this.limit && this.waiters.length) {
			this.active++;
			this.waiters.shift()!();
		}
	}
}

/** 可中止的退避休眠：parent signal 取消时提前抛出 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("abort"));
			},
			{ once: true },
		);
	});
}

function isRetryable(error: string | undefined): boolean {
	return !!error && RETRYABLE_RE.test(error);
}

// ---------------------------------------------------------------------------
// 工具定义（描述按视觉能力动态拼装）
// ---------------------------------------------------------------------------

/** 已注册的工具定义是否带视觉标注（幂等防抖） */
let registeredWithVision = false;

/** 参数 schema 与视觉无关，静态定义；描述引导在下方 buildExploreToolDefinition */
const EXPLORE_PARAMS = Type.Object({
	tasks: Type.Array(Type.String(), {
		description:
			"每个任务派一个子代理（任务数 = 子代理数）。任务可按探索问题拆分，也可把大量文件/目录按批次分治，" +
			"只要各任务范围与目标互不重叠（避免子代理重复探索同一区域）、粒度尽量均匀（各任务耗时相近，" +
			"别让个别重型任务拖慢整批并行）。一次至少 2 个、最多 ${MAX_TASKS} 个任务" +
			"（超出上限的调用会被拒绝，任务过多可拆成多批调用）。",
		minItems: 2,
		maxItems: MAX_TASKS,
	}),
});

function buildExploreToolDefinition(
	pi: ExtensionAPI,
	hasVision: boolean,
): ToolDefinition<typeof EXPLORE_PARAMS, ExploreDetails> {
	const visionNote = hasVision ? "子代理模型支持读图，可派发截图/图片/图表分析任务。" : "";
	return {
		name: "explore",
		label: "探索子代理",
		description:
			"并行派出 2~${MAX_TASKS} 个只读子代理探索代码库并返回结构化报告（一个任务 = 一个子代理）。" +
			"每个子代理拥有 read/ls/grep/find 工具，自主决定阅读哪些文件，你只负责分配任务；任务描述要具体可回答。" +
			visionNote +
			"适合：了解陌生模块结构、定位功能实现、梳理调用链——比主 agent 逐文件 read 更省上下文、更快、更便宜。" +
			"子代理不能修改文件。",
		promptSnippet: "explore: 派只读子代理并行探索代码库并返回报告（省主上下文）",
		promptGuidelines: [
			"需要了解陌生代码结构或定位实现时，优先用 explore 派子代理，而不是自己逐文件 read；拿到报告后再对关键文件精读。",
			"explore 的任务描述要具体可回答，推荐格式：【目标】要查清的问题【范围】相关目录或关键词【期望产出】如『按目录分组的文件清单+行号』。",
			"explore 至少传 2 个任务才值得调用（任务数 = 子代理数）；任务可拆探索问题、也可把大批量文件按目录/列表切分分治，" +
			"各任务范围互不重叠、耗时尽量相近（并行批次等最慢者完成）即可；一批内全部提交，不要先派 1 个试探再补派。",
			"explore 报告抽样验证后再采信：关键路径可用 read 抽查是否真实存在，再据此派工修改。",
			...(hasVision
				? ["explore 子代理支持读图（视觉模型）：涉及截图/图片/图表文件时，可直接让子代理读图分析。"]
				: []),
		],
		parameters: EXPLORE_PARAMS,
		executionMode: "parallel",
		execute: (_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ExploreDetails>> => {
			// 兜底收敛：模型实际能力与已注册标注不一致时重注册（下个 turn 生效）
			registerExploreTool(pi, modelHasVision(pickExploreModel(ctx)));
			return executeExplore(ctx, params, signal, onUpdate);
		},
	};
}

/**
 * 注册/重注册 explore 工具：同名 Map.set 覆盖 + refreshTools（下个 turn 起描述生效）。
 * 幂等：标注状态未变时不重复刷新。
 */
function registerExploreTool(pi: ExtensionAPI, hasVision: boolean): void {
	if (hasVision === registeredWithVision) return;
	registeredWithVision = hasVision;
	pi.registerTool(buildExploreToolDefinition(pi, hasVision));
}

// ---------------------------------------------------------------------------
// 子代理系统提示（借鉴 pi-subagents scout：结构化输出 + 探索纪律）
// ---------------------------------------------------------------------------

function buildSystemPrompt(cwd: string): string {
	// 固定指令放开头、易变的 cwd 放末尾，利于 provider 端 prompt 缓存命中
	return [
		"你是「探索子代理」，在代码仓库中完成上级分配的探索任务。",
		"你拥有只读工具：read（读文件）、ls（列目录）、grep（内容搜索）、find（按文件名查找）。",
		"",
		"## 探索纪律（必须遵守）",
		"",
		"1. **先定位再精读**：用 find / ls / grep 定位相关文件路径，再用 read 精读关键片段。不要一上来就读大文件。",
		"2. **定向搜索优先**：先按路径/文件名缩小范围，再在范围内 grep。无范围 grep 只用于穷举精确字面量验证。",
		"3. **高效阅读**：read 时指定行号范围（如 `path:100-150`），不要读整个文件除非文件很小（<100行）。",
		"4. **不要猜测**：不确定的路径/函数/变量用工具验证，不要凭印象推测。",
		"5. **不要修改文件**：你只读，发现问题记录在报告里即可。",
		"",
		"## 输出格式（严格遵守）",
		"",
		"```markdown",
		"# 探索报告",
		"",
		"## 检索到的文件",
		"列出实际查看的文件、行号范围、以及为什么重要：",
		"1. `path/to/file.ts` (行 10-50) — 为什么重要",
		"2. `path/to/other.ts` (行 100-150) — 为什么重要",
		"",
		"## 关键代码",
		"关键的类型、接口、函数签名、数据流（精简，不要大段粘贴）。",
		"",
		"## 架构说明",
		"这些组件如何连接，数据如何流转。",
		"",
		"## 下一步建议",
		"如果上级要基于这些信息行动，应该先打开哪个文件、从哪里入手。",
		"```",
		"",
		"如果任务是简单问答（不需要文件清单），可以直接回答，不必套模板格式。",
		"如果报告包含「没有/不存在/所有/只有这些」这类完备性结论，必须注明搜索范围（搜了哪些目录/关键词）。",
		"",
		`工作目录：${cwd}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// 子代理运行
// ---------------------------------------------------------------------------

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
		const streamFn = createPiStreamFn(ctx);

		const config: AgentLoopConfig = {
			model,
			convertToLlm,
		};

		const userMessage: AgentMessage = { role: "user", content: task, timestamp: Date.now() };
		const newMessages = await runAgentLoop(
			[userMessage],
			{ messages: [systemMessage(buildSystemPrompt(ctx.cwd))], tools },
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
		return { task, ok: false, error: "子代理未产出报告" };
	} catch (e) {
		if (signal.aborted) {
			// 区分超时（可重试，RETRYABLE_RE 命中）与用户取消（不可重试）
			const isTimeout = signal.reason instanceof Error && signal.reason.message.includes("超时");
			return {
				task,
				ok: false,
				error: isTimeout ? `子代理超时（${Math.round(TASK_TIMEOUT_MS / 60_000)} 分钟）` : "已中止（用户取消）",
			};
		}
		return { task, ok: false, error: e instanceof Error ? e.message : String(e) };
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
	pi.on("session_shutdown", async () => clearStatusTimers());
	// 初始注册（未知视觉能力时不标注）；有 ctx 的时机再收敛
	registerExploreTool(pi, false);
	// 会话开始时探测当前子模型视觉能力并重注册标注（下个 turn 生效）
	pi.on("session_start", async (_event, ctx) => {
		registerExploreTool(pi, detectExploreVision(ctx));
	});

	// /explore-config：配置 explore 子代理使用的模型
	registerModelConfigCommand(pi, {
		command: "explore-config",
		description:
			"配置 explore 子模型：auto（默认，最便宜可用模型）、auto-not-free（忽略免费模型）或 provider/modelId；不带参数进入交互选择（含搜索）",
		displayName: "explore 子模型",
		getSetting: () => exploreModelSetting,
		setSetting: setExploreModelSetting,
		// 设置变更后立即按新模型重注册视觉标注
		onSettingChanged: (ctx) => registerExploreTool(pi, detectExploreVision(ctx)),
	});
}

/**
 * explore 执行主体：解析子模型 → 并行派子代理 → 汇总结构化报告。
 * 由 buildExploreToolDefinition 的 execute 闭包调用。
 */
async function executeExplore(
	ctx: ExtensionContext,
	params: { tasks: string[] },
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ExploreDetails> | undefined,
): Promise<AgentToolResult<ExploreDetails>> {
	const fail = (text: string): AgentToolResult<ExploreDetails> => ({
		content: [{ type: "text", text }],
		details: { model: "", total: 0, succeeded: 0, tasks: [] },
	});

	const model = pickExploreModel(ctx);
	if (!model) {
		return fail("explore：找不到可用的子模型（没有任何已配置认证的模型）。请改用 read/grep 自行探索。");
	}

	// 防御：schema 已用 maxItems 硬拦（超出直接校验失败回给 AI），此处仅防非校验路径
	const truncatedNote =
		params.tasks.length > MAX_TASKS ? `\n（注意：只执行了前 ${MAX_TASKS} 个任务，其余已忽略）` : "";
	const tasks = params.tasks.slice(0, MAX_TASKS);
	const modelName = `${model.provider}/${model.id}`;

	const toolCallCounts = new Array<number>(tasks.length).fill(0);
	const retryCounts = new Array<number>(tasks.length).fill(0);
	const doneFlags = new Array<boolean>(tasks.length).fill(false);
	const taskResults = new Array<TaskResult | undefined>(tasks.length).fill(undefined);
	const doneCount = () => doneFlags.filter(Boolean).length;
	const limiter = new AdaptiveLimiter(CONCURRENCY);
	/** 进度展示：活跃任务在前（含工具调用次数/重试中），已完成的折叠成一行汇总 */
	const report = () => {
		const active: string[] = [];
		let doneOk = 0;
		let doneFail = 0;
		tasks.forEach((t, i) => {
			const label = t.length > 24 ? t.slice(0, 24) + "…" : t;
			if (!doneFlags[i]) {
				const retryNote = retryCounts[i] > 0 ? ` · ↻重试${retryCounts[i]}/${TASK_RETRIES}` : "";
				active.push(`  ${i + 1}. [${toolCallCounts[i]} 次工具调用${retryNote}] ${label}`);
			} else if (taskResults[i]?.ok) {
				doneOk++;
			} else {
				doneFail++;
			}
		});
		const perTask = [
			...active,
			...(doneOk + doneFail > 0 ? [`  · 已完成 ${doneOk} 个${doneFail ? `（✗ 失败 ${doneFail}）` : ""}`] : []),
		].join("\n");
		onUpdate?.({
			content: [{ type: "text", text: `子代理探索中（${modelName} · 并发 ${limiter.limit}/${CONCURRENCY}）：\n${perTask}` }],
			details: { model: modelName, total: tasks.length, succeeded: 0, tasks: [] },
		});
		ctx.ui.setStatus("explore", `🔎 ${doneCount()}/${tasks.length} · ⚙${limiter.limit}`);
	};
	report();

	// 动态并发执行：pool 只做调度（无固定上限），实际并发由 limiter 自适应控制——
	// 可重试错误 → lower() 收并发 + 指数退避后重试；成功 → raise() 逐步升回上限
	const results = await pool(tasks, tasks.length, async (task: string, i: number) => {
		await limiter.acquire();
		try {
			for (let attempt = 0; ; attempt++) {
				const r = await runSubAgent(ctx, model, task, signal, () => {
					toolCallCounts[i]++;
					report();
				});
				taskResults[i] = r;
				if (r.ok || !isRetryable(r.error) || attempt >= TASK_RETRIES || signal?.aborted) return r;
				retryCounts[i] = attempt + 1;
				limiter.lower();
				report();
				try {
					await sleep(Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS), signal);
				} catch {
					return { task, ok: false, error: "已中止（用户取消）" };
				}
			}
		} finally {
			if (taskResults[i]?.ok) limiter.raise();
			limiter.release();
			doneFlags[i] = true;
			report();
		}
	});

	const succeeded = results.filter((r) => r.ok).length;
	setStatusWithTTL(ctx, "explore", `🔎 ✓ ${succeeded}/${results.length}`, 6_000);
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
}
