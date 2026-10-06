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
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import {
	runAgentLoop,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { registerModelConfigCommand, type AnyModel } from "./shared/model-select";
import { createModelSetting, type ModelSetting } from "./shared/model-setting";
import { modelHasVision } from "./shared/model-util";
import { convertToLlm, createPiStreamFn, systemMessage } from "./shared/agent";
import { setStatusWithTTL, clearStatusTimers } from "./shared/status";
import { EXPLORE_API_VERSION, publishExploreApi } from "./shared/explore-api";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** explore 模型设置持久化文件（键 model：auto = 交给 model-config，或本地固定 provider/modelId） */
const EXPLORE_MODEL_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "explore-model.json");

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

/** 子代理模型设置（用途 `explore.subagent`，默认策略 BATCH） */
const exploreModelSetting: ModelSetting = createModelSetting({
	purpose: "explore.subagent",
	plugin: "explore",
	label: "子代理",
	file: EXPLORE_MODEL_CONFIG_FILE,
	key: "model",
	defaultStrategy: "BATCH",
});

/** 解析当前子代理模型（每轮调用前重新解析，面板改完立即生效） */
function pickExploreModel(ctx: ExtensionContext): AnyModel | undefined {
	return exploreModelSetting.resolve(ctx).model;
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

/** 任务参数说明（不含缓存口径：口径随调用方策略不同，见下面两个常量） */
const TASK_PARAM_DESC =
	"每个任务派一个子代理（任务数 = 子代理数）。任务可按探索问题拆分，也可把大量文件/目录按批次分治，" +
	"只要各任务范围与目标互不重叠（避免子代理重复探索同一区域）、粒度尽量均匀（各任务耗时相近，" +
	"别让个别重型任务拖慢整批并行）。一次至少 2 个、最多 " +
	`${MAX_TASKS} 个任务` +
	"（超出上限的调用会被拒绝，任务过多可拆成多批调用）。";
/** 主会话口径：复用历史成果省 token */
const CACHE_REUSE_NOTE = "同一任务文本第二次调用会直接复用上次成果（不消耗 token）；要重跑传 fresh=true。";
/** alwaysFresh 口径（/init 要求结果反映当前代码） */
const ALWAYS_FRESH_NOTE = "每次调用都重新探索，不复用历史成果（中断过的任务会带着已有发现续跑）。";

/** 参数 schema 与视觉无关，静态定义；描述引导在下方 buildExploreToolDefinition */
const EXPLORE_PARAMS = Type.Object({
	tasks: Type.Array(Type.String(), {
		description: TASK_PARAM_DESC + CACHE_REUSE_NOTE,
		minItems: 2,
		maxItems: MAX_TASKS,
	}),
	/** 忽略已有成果缓存，强制重跑（默认 false：同任务文本复用上次成果，中断的任务带半成品续跑） */
	fresh: Type.Optional(Type.Boolean({ description: "强制重新探索（默认复用同任务文本的上次成果）" })),
});

/** alwaysFresh 变体：没有可复用的缓存，fresh 参数一并去掉（值由适配层强制） */
const EXPLORE_PARAMS_ALWAYS_FRESH = Type.Object({
	tasks: Type.Array(Type.String(), {
		description: TASK_PARAM_DESC + ALWAYS_FRESH_NOTE,
		minItems: 2,
		maxItems: MAX_TASKS,
	}),
});

function buildExploreToolDefinition(
	pi: ExtensionAPI,
	hasVision: boolean,
	alwaysFresh = false,
): ToolDefinition<any, ExploreDetails> {
	const visionNote = hasVision ? "子代理模型支持读图，可派发截图/图片/图表分析任务。" : "";
	return {
		name: "explore",
		label: "探索子代理",
		description:
			`并行派出 2~${MAX_TASKS} 个只读子代理探索代码库并返回结构化报告（一个任务 = 一个子代理）。` +
			"每个子代理拥有 read/ls/grep/find 工具，自主决定阅读哪些文件，你只负责分配任务；任务描述要具体可回答。" +
			visionNote +
			"适合：了解陌生模块结构、定位功能实现、梳理调用链——比主 agent 逐文件 read 更省上下文、更快、更便宜。" +
			"子代理不能修改文件。探索过程会边跑边写 .pi/explore/report.md（单任务成果在 .pi/explore/tasks/），" +
			"可随时重读；中断过的任务再次调用会带着已有发现续跑，不受重复消耗。",
		promptSnippet: "explore: 派只读子代理并行探索代码库并返回报告（省主上下文）",
		promptGuidelines: [
			"需要了解陌生代码结构或定位实现时，优先用 explore 派子代理，而不是自己逐文件 read；拿到报告后再对关键文件精读。",
			"explore 的任务描述要具体可回答，推荐格式：【目标】要查清的问题【范围】相关目录或关键词【期望产出】如『按目录分组的文件清单+行号』。",
			"explore 至少传 2 个任务才值得调用（任务数 = 子代理数）；任务可拆探索问题、也可把大批量文件按目录/列表切分分治，" +
			"各任务范围互不重叠、耗时尽量相近（并行批次等最慢者完成）即可；一批内全部提交，不要先派 1 个试探再补派。",
			"explore 报告抽样验证后再采信：关键路径可用 read 抽查是否真实存在，再据此派工修改。",
			"explore 成果会边跑边落盘：报告 .pi/explore/report.md、单任务 .pi/explore/tasks/<key>.md；" +
				"同一任务文本再次调用会复用上次成果（不花 token），中断的任务会带半成品续跑；要强制重跑传 fresh=true。",
			...(hasVision
				? ["explore 子代理支持读图（视觉模型）：涉及截图/图片/图表文件时，可直接让子代理读图分析。"]
				: []),
		],
		parameters: alwaysFresh ? EXPLORE_PARAMS_ALWAYS_FRESH : EXPLORE_PARAMS,
		executionMode: "parallel",
		execute: (_toolCallId, params: { tasks: string[]; fresh?: boolean }, signal, onUpdate, ctx): Promise<AgentToolResult<ExploreDetails>> => {
			// 兜底收敛：模型实际能力与已注册标注不一致时重注册（下个 turn 生效）
			registerExploreTool(pi, modelHasVision(pickExploreModel(ctx)));
			return executeExplore(ctx, params, signal, onUpdate);
		},
	};
}

/**
 * 适配成子代理循环可直接调用的 AgentTool：execute 收 4 参（ctx 与 fresh 策略在闭包里定死）。
 * ctx 按 ExtensionContext 使用即可（explore 只用 cwd / 模型注册表 / setStatus）。
 */
function toSubagentTool(
	definition: ToolDefinition<any, ExploreDetails>,
	ctx: ExtensionContext,
	alwaysFresh: boolean,
): AgentTool<any> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(
				toolCallId,
				alwaysFresh ? { ...(params as Record<string, unknown>), fresh: true } : params,
				signal,
				onUpdate,
				ctx as ExtensionToolContext,
			),
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

function buildSystemPrompt(cwd: string, priorNotes?: string): string {
	// 固定指令放开头、易变的 cwd 放末尾，利于 provider 端 prompt 缓存命中
	const lines = [
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
		"## 边探索边记录（重要）",
		"",
		"你的回答正文就是成果本身：**每确认一条结论就写进正文**（文件路径 + 行号 + 结论），再继续下一处。",
		"不要攒到最后一次性总结——超时、网络中断、上下文超限都可能随时打断你；",
		"正文里已经写下的结论会被保留下来继续使用，没写进正文的思考会丢。",
		"探索过半时回头看一遍：把已确认的事实用输出格式整理成小节，再补未完的部分。",
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
	];
	if (priorNotes) {
		lines.push(
			"",
			"## 这是一次续跑",
			"",
			"上次探索被中断（超时/网络/进程结束），下面是它已经确认的发现：",
			"",
			"```markdown",
			priorNotes,
			"```",
			"",
			"在它基础上继续：不要重复已验证的检索；不确定或可能过时的结论可以复核一次；",
			"补齐缺口后输出完整报告（包含已有结论 + 你的新增部分）。",
		);
	}
	lines.push("", `工作目录：${cwd}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 成果落盘（渐进式报告 + 断点续跑）
//
// 目录（项目内）：.pi/explore/
//   report.md              本次/最近一次探索的可读报告（每有进展就重写，可 tail 观察）
//   tasks/<key>.md         单任务最终成果（按任务文本哈希缓存，重跑同任务直接复用）
//   tasks/<key>.partial.md 中断时的半成品（续跑时作为起点交给子代理）
//   tasks/<key>.json       任务元数据（状态/工具调用数/时间/错误）
//
// 设计目标：探索的成果必须**渐进式落盘**——子代理每轮产出的正文随时写入 partial，
// 中断/超时/断电都不至于白烧 token；再次调用同一任务时直接复用已完成成果。
// ---------------------------------------------------------------------------

const EXPLORE_DIR = path.join(".pi", "explore");
/** 单任务最大轮数（超出即收尾出报告，避免无限深挖） */
const MAX_TURNS_PER_TASK = 40;
/** 单任务最多做几次「上下文压缩后续跑」 */
const MAX_COMPACTIONS = 2;
/** 上下文超限类错误特征（各家措辞不同，宽匹配；与 claude-it 共用一份，见 shared/context-budget） */
import { CONTEXT_OVERFLOW_RE } from "./shared/context-budget";
export { CONTEXT_OVERFLOW_RE };

interface TaskArtifacts {
	key: string;
	finalPath: string;
	partialPath: string;
	metaPath: string;
}

function exploreRoot(cwd: string): string {
	return path.join(cwd, EXPLORE_DIR);
}

export function artifactsFor(cwd: string, task: string): TaskArtifacts {
	const key = createHash("sha1").update(task.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 12);
	const dir = path.join(exploreRoot(cwd), "tasks");
	return {
		key,
		finalPath: path.join(dir, `${key}.md`),
		partialPath: path.join(dir, `${key}.partial.md`),
		metaPath: path.join(dir, `${key}.json`),
	};
}

/** 原子写（tmp + rename）：报告文件随时可能被用户打开，不能出现半截内容 */
export function writeAtomic(file: string, content: string): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, content, "utf8");
		fs.renameSync(tmp, file);
	} catch {
		/* 落盘失败不影响探索本身 */
	}
}

function readIfExists(file: string): string | null {
	try {
		const s = fs.readFileSync(file, "utf8");
		return s.trim() ? s : null;
	} catch {
		return null;
	}
}

/** 中断续跑用：上次跑该任务留下的半成品（没有则 null） */
export function readPartialNotes(a: TaskArtifacts): string | null {
	return readIfExists(a.partialPath);
}

/** 复用检查：该任务文本此前是否已有完整成果（fresh 由调用方控制） */
export function readCachedFinal(a: TaskArtifacts): string | null {
	return readIfExists(a.finalPath);
}

/** 去掉文件里为独立阅读而加的一级标题（报告内已有「## 任务 N：…」时避免重复） */
export function stripTitle(content: string, task: string): string {
	const lines = content.split("\n");
	if (lines[0]?.trim() === `# ${task}`.trim()) return lines.slice(1).join("\n").trim();
	return content.trim();
}

interface TaskMeta {
	task: string;
	status: "running" | "done" | "failed" | "interrupted";
	model?: string;
	tools?: number;
	updatedAt?: string;
	error?: string;
}

function writeMeta(a: TaskArtifacts, meta: TaskMeta): void {
	writeAtomic(a.metaPath, JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, "\t"));
}

/** 半成品 = 已确认正文 + 检索轨迹（工具调用越界/被 kill 也留下证据） */
export function renderPartial(task: string, texts: string[], trace: string[]): string {
	const body = texts.join("\n\n").trim();
	const tail = trace.length
		? `\n\n## 检索轨迹（自动记录）\n${trace.slice(-40).map((t) => `- ${t}`).join("\n")}`
		: "";
	return `# ${task}\n\n${body || "（尚无正文产出，仅有检索轨迹）"}${tail}\n`;
}

export interface ExploreTaskState {
	task: string;
	key: string;
	status: "pending" | "running" | "cached" | "done" | "failed" | "interrupted";
	content: string;
	tools: number;
	cached: boolean;
	error?: string;
}

/** 报告渲染：任务清单 + 每任务状态与正文（进行中也能看到已产出的正文） */
export function renderReport(runId: string, modelName: string, states: ExploreTaskState[]): string {
	const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
	const lines = [
		`# 探索报告（run ${runId} · ${modelName} · 更新于 ${stamp}）`,
		"",
		`> 本文件由 explore 子代理边跑边写：任务进行中也能看到已确认的结论与检索轨迹。`,
		"",
	];
	states.forEach((s, i) => {
		const tag =
			s.status === "done"
				? "✅ 完成"
				: s.status === "cached"
					? "♻️ 复用上次成果"
					: s.status === "running"
						? `⏳ 进行中（${s.tools} 次工具调用）`
						: s.status === "interrupted"
							? "⚠️ 中断（半成品已保留，可续跑）"
							: s.status === "failed"
								? `❌ 失败：${s.error ?? "未知错误"}`
								: "… 等待中";
		lines.push(`## 任务 ${i + 1}：${s.task}`, "", `**状态**：${tag}`, "");
		if (s.content.trim()) lines.push(s.content.trim(), "");
		else lines.push("（暂无正文产出）", "");
	});
	return lines.join("\n");
}

/** 可中止的写盘排空（保证返回前报告已落盘） */
/** 报告写入串行化：多任务并发推进时不互相覆盖，返回前用 drained() 排空 */
class RunReporter {
	private chain: Promise<void> = Promise.resolve();
	constructor(private readonly file: string) {}

	flush(content: string): void {
		this.chain = this.chain.then(() => writeAtomic(this.file, content)).catch(() => undefined);
	}

	async drained(): Promise<void> {
		await this.chain;
	}
}

/** 工具调用的人类可读摘要（写进检索轨迹，也用于进度展示） */
function describeToolCall(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
	switch (toolName) {
		case "read": {
			const p = str("path");
			const from = typeof a.from === "number" ? a.from : typeof a.offset === "number" ? a.offset : undefined;
			const to = typeof a.to === "number" ? a.to : undefined;
			const range = from != null ? `:${from}${to != null ? `-${to}` : ""}` : "";
			return `read ${p}${range}`;
		}
		case "grep": {
			const pat = str("pattern") || str("query");
			const pathArg = str("path") || str("dir");
			return `grep ${pat}${pathArg ? ` @ ${pathArg}` : ""}`;
		}
		case "ls":
			return `ls ${str("path") || "."}`;
		case "find":
			return `find ${str("pattern") || str("name") || str("path")}`;
		default:
			return toolName;
	}
}

/** 取一条消息里的正文文本（忽略工具调用块） */
function textOf(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/** 从消息数组里取最后一条有正文的 assistant 消息 */
function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const t = textOf(m);
		if (t) return t;
	}
	return "";
}

/**
 * 过程记录压缩：上下文超限 / 轮数用尽 / 无正文产出时，用一次廉价调用把已有记录
 * 压成「可继续的要点」或「最终报告」。压缩失败退尾部截断——绝不因压缩失败而丢成果。
 */
async function compactNotes(
	ctx: ExtensionContext,
	model: AnyModel,
	task: string,
	notes: string,
	mode: "continue" | "report",
): Promise<string> {
	const fallback = notes.trim().slice(-6_000);
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return fallback;
		const system =
			mode === "continue"
				? "你在压缩一次探索子代理的过程记录。保留：已确认的事实（文件路径 + 行号 + 结论）、数据流、" +
					"已排除的路径及原因、尚未验证的线索。丢弃：冗余叙述、重复内容、工具调用外壳。输出纯文本要点，不要客套。"
				: "把探索过程整理成最终报告（markdown：检索到的文件 / 关键代码 / 架构说明 / 下一步建议）。" +
					"只写记录里确实有的内容，不确定的明确标注「待验证」，不要编造。";
		const messages: Message[] = [
			{
				role: "user",
				content: `任务：${task}\n\n--- 过程记录 ---\n${notes.slice(-24_000)}`,
				timestamp: Date.now(),
			},
		];
		const res = await completeSimple(
			model,
			{ systemPrompt: system, messages },
			{
				apiKey: auth.apiKey,
				headers: { ...auth.headers },
				maxTokens: 2_000,
				temperature: 0,
				signal: AbortSignal.timeout(60_000),
			},
		);
		const text = res.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { type: "text"; text: string }).text)
			.join("\n")
			.trim();
		return text || fallback;
	} catch {
		return fallback;
	}
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
	/** 最终报告（ok=true 时必有；ok=false 且中断时可能是半成品正文） */
	report?: string;
	error?: string;
	/** 复用上次已完成成果 */
	cached?: boolean;
	/** 上下文压缩次数 */
	compactions?: number;
}

interface SubAgentHooks {
	/** 工具有调用（进度展示用） */
	onToolCall: (line: string) => void;
	/** 正文有新增（渐进落盘：把当前正文与轨迹写进 partial + 刷新报告） */
	onProgress: (texts: string[], trace: string[]) => void;
}

/** 跑一轮子代理：返回正文与轨迹；上下文超限/中断/异常分别归类，便于外层决定续跑 */
async function runSubAgentOnce(
	ctx: ExtensionContext,
	model: AnyModel,
	task: string,
	priorNotes: string | undefined,
	signal: AbortSignal,
	hooks: SubAgentHooks,
): Promise<{
	kind: "done" | "overflow" | "aborted" | "error";
	text: string;
	texts: string[];
	trace: string[];
	error?: string;
	hitTurnCap?: boolean;
}> {
	const tools = createReadOnlyTools(ctx.cwd);
	const streamFn = createPiStreamFn(ctx);
	let turns = 0;
	let hitTurnCap = false;
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		// 轮数上限：到顶就正常收尾（外层会基于记录整理报告，不会白跑）
		finishTurn: () => {
			if (++turns >= MAX_TURNS_PER_TASK) {
				hitTurnCap = true;
				return { action: "end" as const };
			}
			return undefined;
		},
	};
	const userMessage: AgentMessage = { role: "user", content: task, timestamp: Date.now() };
	const texts: string[] = [];
	const trace: string[] = [];
	try {
		const messages = await runAgentLoop(
			[userMessage],
			{ messages: [systemMessage(buildSystemPrompt(ctx.cwd, priorNotes))], tools },
			config,
			(event) => {
				if (event.type === "tool_execution_start") {
					const line = describeToolCall(event.toolName, event.args);
					trace.push(line);
					hooks.onToolCall(line);
				} else if (event.type === "turn_end" || event.type === "message_end") {
					const t = textOf(event.message);
					if (t && texts[texts.length - 1] !== t) {
						texts.push(t);
						hooks.onProgress(texts, trace);
					}
				}
			},
			signal,
			streamFn,
		);
		const finalText = lastAssistantText(messages) || texts.join("\n\n");
		return { kind: "done", text: finalText, texts, trace, hitTurnCap };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (signal.aborted) return { kind: "aborted", text: texts.join("\n\n"), texts, trace, error: msg };
		if (CONTEXT_OVERFLOW_RE.test(msg))
			return { kind: "overflow", text: texts.join("\n\n"), texts, trace, error: msg };
		return { kind: "error", text: texts.join("\n\n"), texts, trace, error: msg };
	}
}

/**
 * 跑一个任务（含上下文压缩续跑）：断点续跑用 priorNotes 作起点；
 * 上下文超限 → 压缩记录后继续；中断/异常 → 保留半成品作为成果。
 */
async function runSubAgent(
	ctx: ExtensionContext,
	model: AnyModel,
	task: string,
	parentSignal: AbortSignal | undefined,
	hooks: SubAgentHooks,
	priorNotes?: string,
): Promise<TaskResult> {
	const { signal, dispose } = linkSignals(parentSignal, TASK_TIMEOUT_MS);
	let notes = priorNotes?.trim() ?? "";
	let compactions = 0;
	let texts: string[] = [];
	let trace: string[] = [];
	try {
		for (;;) {
			const out = await runSubAgentOnce(ctx, model, task, notes || undefined, signal, {
				onToolCall: hooks.onToolCall,
				onProgress: (t, tr) => {
					texts = t;
					trace = tr;
					hooks.onProgress(t, tr);
				},
			});
			texts = out.texts;
			trace = out.trace;
			// 把本轮记录并入 notes（压缩续跑与最终整理都用它）
			const merged = [notes, out.texts.join("\n\n"), trace.length ? `检索轨迹：\n${trace.map((t) => `- ${t}`).join("\n")}` : ""]
				.filter(Boolean)
				.join("\n\n");
			if (out.kind === "done") {
				// 正常收尾：正文可用就直接用；轮数到顶或没正文 → 用过程记录整理成报告（不白跑）
				const report =
					out.text.trim() && !out.hitTurnCap
						? out.text.trim()
						: await compactNotes(ctx, model, task, merged, "report");
				return { task, ok: true, report, compactions };
			}
			if (out.kind === "overflow" && compactions < MAX_COMPACTIONS && !signal.aborted) {
				compactions++;
				notes = await compactNotes(ctx, model, task, merged, "continue");
				continue; // 用压缩后的要点重新起一轮
			}
			// 中断 / 超限次数用尽 / 其他异常：保留已有正文当成果（白烧 token 最不能接受）
			const partial = out.text.trim();
			const report = partial || (notes ? await compactNotes(ctx, model, task, merged, "report") : "");
			const why =
				out.kind === "aborted"
					? signal.reason instanceof Error && signal.reason.message.includes("超时")
						? `子代理超时（${Math.round(TASK_TIMEOUT_MS / 60_000)} 分钟）`
						: signal.reason instanceof Error && signal.reason.message.includes("abort")
							? "已中止（用户取消）"
							: "已中止"
					: out.kind === "overflow"
						? `上下文超限（已压缩 ${compactions} 次仍不足）`
						: (out.error ?? "未知错误");
			return { task, ok: false, report: report || undefined, error: why, compactions };
		}
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
	// 跨扩展契约：让 /init 子代理（claude-it）能以工具形式调用 explore。零 import 耦合——
	// 消费方只认 shared/explore-api 定义的键与形状，explore 缺席时它自行降级。
	publishExploreApi({
		version: EXPLORE_API_VERSION,
		createSubagentTool: (ctx, options) =>
			toSubagentTool(
				buildExploreToolDefinition(pi, modelHasVision(pickExploreModel(ctx)), options?.alwaysFresh === true),
				ctx,
				options?.alwaysFresh === true,
			),
	});

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
			"explore 子模型：auto（由 model-config 管理）或 provider/modelId（无参开浮层）",
		displayName: "explore 子模型",
		setting: exploreModelSetting,
		// 设置变更后立即按新模型重注册视觉标注
		onSettingChanged: (ctx) => registerExploreTool(pi, detectExploreVision(ctx)),
	});
}

/**
 * explore 执行主体：解析子模型 → 复用/续跑 → 并行派子代理 → 渐进落盘 → 汇总报告。
 *
 * 抗打断三件事（用户诉求：别白烧 token）：
 * 1. 渐进落盘：子代理每轮正文 + 检索轨迹实时写进 .pi/explore/tasks/<key>.partial.md，
 *    报告文件 report.md 同步刷新（可 tail 观察）；
 * 2. 断点续跑：中断（超时/网络/进程结束）留下的半成品，下次同一任务自动作为起点，
 *    已完成任务按文本哈希直接复用（除非传 fresh:true）；
 * 3. 上下文兜底：超限时压缩过程记录后继续跑（最多 MAX_COMPACTIONS 次），
 *    轮数用尽/无正文产出时用记录整理成报告——任何路径都尽量有成果交回。
 */
async function executeExplore(
	ctx: ExtensionContext,
	params: { tasks: string[]; fresh?: boolean },
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ExploreDetails> | undefined,
): Promise<AgentToolResult<ExploreDetails>> {
	/** 整体失败（无可用模型/重复运行/参数错）：带 isError，pi 侧模型与 UI 才识别为失败 */
	const fail = (text: string): AgentToolResult<ExploreDetails> => ({
		content: [{ type: "text", text }],
		details: { model: "", total: 0, succeeded: 0, tasks: [] },
		isError: true,
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
	const fresh = params.fresh === true;
	const root = exploreRoot(ctx.cwd);
	const reportPath = path.join(root, "report.md");
	const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

	// 每个任务的落盘位置 + 状态（复用/续跑/新跑）
	const artifacts = tasks.map((t) => artifactsFor(ctx.cwd, t));
	const states: ExploreTaskState[] = tasks.map((t, i) => {
		const raw = fresh ? null : readCachedFinal(artifacts[i]!);
		return {
			task: t,
			key: artifacts[i]!.key,
			status: raw ? "cached" : "pending",
			content: raw ? stripTitle(raw, t) : "",
			tools: 0,
			cached: !!raw,
		};
	});
	const reporter = new RunReporter(reportPath);
	const flushReport = () => reporter.flush(renderReport(runId, modelName, states));
	flushReport(); // 一开始就落盘：用户可立即打开报告文件看着它长

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
		let doneCached = 0;
		tasks.forEach((t, i) => {
			const label = t.length > 24 ? t.slice(0, 24) + "…" : t;
			if (!doneFlags[i]) {
				const retryNote = retryCounts[i] > 0 ? ` · ↻重试${retryCounts[i]}/${TASK_RETRIES}` : "";
				const stateNote = states[i]!.status === "cached" ? " · ♻️复用" : ` · [${toolCallCounts[i]} 次工具调用${retryNote}]`;
				active.push(`  ${i + 1}.${stateNote} ${label}`);
			} else if (taskResults[i]?.ok) {
				if (taskResults[i]?.cached) doneCached++;
				else doneOk++;
			} else {
				doneFail++;
			}
		});
		const perTask = [
			...active,
			...(doneOk + doneFail + doneCached > 0
				? [
						`  · 已完成 ${doneOk + doneCached} 个${doneCached ? `（其中复用 ${doneCached}）` : ""}${
							doneFail ? `（✗ 失败 ${doneFail}）` : ""
						}`,
					]
				: []),
		].join("\n");
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `子代理探索中（${modelName} · 并发 ${limiter.limit}/${CONCURRENCY}）：\n${perTask}\n报告文件：${path.relative(ctx.cwd, reportPath)}`,
				},
			],
			details: { model: modelName, total: tasks.length, succeeded: doneCount(), tasks: [] },
		});
		ctx.ui.setStatus("explore", `🔎 探索 ${doneCount()}/${tasks.length} · 并发 ${limiter.limit}`);
	};
	report();

	// 动态并发执行：pool 只做调度（无固定上限），实际并发由 limiter 自适应控制——
	// 可重试错误 → lower() 收并发 + 指数退避后重试；成功 → raise() 逐步升回上限
	const results = await pool(tasks, tasks.length, async (task: string, i: number) => {
		const a = artifacts[i]!;
		const state = states[i]!;
		// 复用：此前同一任务文本已完成 → 不派子代理（除非 fresh）
		if (state.status === "cached") {
			const r: TaskResult = { task, ok: true, report: state.content, cached: true };
			taskResults[i] = r;
			doneFlags[i] = true;
			report();
			return r;
		}
		const priorNotes = readPartialNotes(a) ?? undefined;
		state.status = "running";
		writeMeta(a, { task, status: "running", model: modelName });
		flushReport();

		await limiter.acquire();
		try {
			for (let attempt = 0; ; attempt++) {
				const r = await runSubAgent(
					ctx,
					model,
					task,
					signal,
					{
						onToolCall: () => {
							toolCallCounts[i]++;
							state.tools = toolCallCounts[i];
							report();
						},
						// 渐进落盘：子代理每轮正文/每次工具调用都刷新半成品与报告
						onProgress: (texts, trace) => {
							state.content = texts.join("\n\n");
							state.status = "running";
							writeAtomic(a.partialPath, renderPartial(task, texts, trace));
							writeMeta(a, { task, status: "running", model: modelName, tools: toolCallCounts[i] });
							flushReport();
						},
					},
					priorNotes,
				);
				taskResults[i] = r;
				if (r.ok) {
					const reportText = r.report ?? "";
					state.content = reportText;
					state.status = "done";
					writeAtomic(a.finalPath, `# ${task}\n\n${reportText}\n`);
					writeMeta(a, { task, status: "done", model: modelName, tools: toolCallCounts[i] });
					try {
						fs.rmSync(a.partialPath, { force: true }); // 完整成果已落盘，半成品退役
					} catch {
						/* 忽略 */
					}
					return r;
				}
				// 失败/中断：保留半成品（下次续跑的起点），报告里标状态
				state.content = r.report ?? state.content;
				state.status = r.error?.includes("中止") || r.error?.includes("中断") ? "interrupted" : "failed";
				state.error = r.error;
				writeMeta(a, { task, status: state.status, model: modelName, tools: toolCallCounts[i], error: r.error });
				flushReport();
				// 只在有意义的场景重试：可重试错误、上下文超限（已压缩过）、子代理超时
				const retriable = isRetryable(r.error) || !!r.error?.includes("上下文超限");
				if (!retriable || attempt >= TASK_RETRIES || signal?.aborted) return r;
				retryCounts[i] = attempt + 1;
				limiter.lower();
				report();
				try {
					await sleep(Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS), signal);
				} catch {
					return { task, ok: false, error: "已中止（用户取消）", report: r.report };
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
	const cachedCount = results.filter((r) => r.cached).length;
	const failed = results.filter((r) => !r.ok);
	setStatusWithTTL(ctx, "explore", `✓ 探索 ${succeeded}/${results.length}`, 6_000);
	flushReport();
	await reporter.drained(); // 返回前确保报告落盘（用户可能立刻打开读）

	const sections = results.map((r, i) => {
		const head = `## 任务 ${i + 1}：${r.task}`;
		if (r.ok) return `${head}${r.cached ? "（♻️ 复用上次完成的成果）" : ""}\n${r.report ?? ""}`;
		const partial = r.report ? `\n**中断前已确认的部分**（半成品已保留在 ${path.relative(ctx.cwd, artifacts[i]!.partialPath)}）：\n${r.report}` : "";
		return `${head}\n⚠ ${r.error ?? "未完成"}${partial}`;
	});
	const summaryBits = [
		`探索完成：${succeeded}/${results.length} 个任务成功`,
		cachedCount ? `其中 ${cachedCount} 个复用了上次成果（未消耗 token）` : "",
		failed.length ? `失败 ${failed.length} 个（可再调 explore 续跑：已完成的会自动复用，中断的会带半成品继续）` : "",
	]
		.filter(Boolean)
		.join("，");
	const text = [
		`${summaryBits}（子模型 ${modelName}）${truncatedNote}`,
		`报告文件：${path.relative(ctx.cwd, reportPath)}（单任务成果在 .pi/explore/tasks/，可随时重读）`,
		"",
		...sections,
	].join("\n\n");

	return {
		content: [{ type: "text", text }],
		details: { model: modelName, total: results.length, succeeded, tasks: results },
	};
}
