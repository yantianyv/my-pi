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
 * - 子模型选择：优先 PREFERRED_MODELS，兜底选「已认证且价格最低」的可用模型；
 * - 预算保护：单任务最多 MAX_TURNS 轮、TASK_TIMEOUT_MS 超时、跟随主 agent abort。
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import {
	runAgentLoop,
	type AgentLoopConfig,
	type AgentMessage,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Message, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 优先选用的子模型（provider/modelId），按顺序尝试；都不可用时自动选最便宜的可用模型 */
const PREFERRED_MODELS: Array<[string, string]> = [["deepseek", "deepseek-v4-flash"]];

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

function pickExploreModel(ctx: ExtensionContext): AnyModel | undefined {
	const reg = ctx.modelRegistry;
	for (const [provider, modelId] of PREFERRED_MODELS) {
		const m = reg.find(provider, modelId);
		if (m && reg.hasConfiguredAuth(m)) return m;
	}
	// 兜底：已配置认证的模型里选 input+output 最便宜的
	let best: AnyModel | undefined;
	let bestCost = Infinity;
	for (const m of reg.getAvailable()) {
		if (!reg.hasConfiguredAuth(m)) continue;
		const c = (m.cost?.input ?? Infinity) + (m.cost?.output ?? Infinity);
		if (c < bestCost) {
			best = m;
			bestCost = c;
		}
	}
	return best;
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
			};
			report();

			const results = await pool(tasks, CONCURRENCY, async (task, i) => {
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

	// 调试用：查看当前会被选中的子模型
	pi.registerCommand("explore-model", {
		description: "查看 explore 子代理将使用的子模型",
		handler: async (_args, ctx) => {
			const m = pickExploreModel(ctx);
			ctx.ui.notify(
				m ? `explore 子模型：${m.provider}/${m.id}` : "explore 子模型：无可用模型（没有任何已认证的模型）",
				m ? "info" : "warning",
			);
		},
	});
}
