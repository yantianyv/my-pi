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
 * - 预算保护：单任务 TASK_TIMEOUT_MS 超时、跟随主 agent abort。
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { convertToLlm, createPiStreamFn } from "./shared/agent";
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
const MAX_TASKS = 16;
/** 子代理最大并行数 */
const CONCURRENCY = 4;
/** 单个子代理超时 */
const TASK_TIMEOUT_MS = 15 * 60_000;

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
		return { task, ok: false, error: "子代理未产出报告" };
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
	pi.on("session_shutdown", async () => clearStatusTimers());
	pi.registerTool({
		name: "explore",
		label: "探索子代理",
		description:
			"派出一个或多个只读子代理并行探索代码库并返回结构化报告。每个子代理拥有 read/ls/grep/find 工具，会自主决定阅读哪些文件，你只负责分配任务。" +
			"适合：了解陌生模块结构、定位功能实现、梳理调用链等——比主 agent 逐文件 read 更省上下文、更快、更便宜。" +
			"任务描述要具体可回答；多个相互独立的任务一次派出。子代理不能修改文件。",
		promptSnippet: "explore: 派只读子代理并行探索代码库并返回报告（省主上下文）",
		promptGuidelines: [
			"需要了解陌生代码结构或定位实现时，优先用 explore 派子代理，而不是自己逐文件 read；拿到报告后再对关键文件精读。",
			"explore 的任务描述要具体可回答，推荐格式：【目标】要查清的问题【范围】相关目录或关键词【期望产出】如『按目录分组的文件清单+行号』；多个相互独立的任务放在一次调用里并行执行。",
			"explore 报告抽样验证后再采信：关键路径可用 read 抽查是否真实存在，再据此派工修改。",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.String(), {
				description: `分配给子代理的探索任务列表，每个任务派一个子代理，2~${MAX_TASKS} 个（至少 2 个保证并行度，超出 ${MAX_TASKS} 截断）`,
				minItems: 2,
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
		},
	});

	// /explore-config：配置 explore 子代理使用的模型
	registerModelConfigCommand(pi, {
		command: "explore-config",
		description:
			"配置 explore 子模型：auto（默认，最便宜可用模型）、auto-not-free（忽略免费模型）或 provider/modelId；不带参数进入交互选择（含搜索）",
		displayName: "explore 子模型",
		getSetting: () => exploreModelSetting,
		setSetting: setExploreModelSetting,
	});
}
