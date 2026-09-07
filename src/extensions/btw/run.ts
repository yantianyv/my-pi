/**
 * btw/run：后台流式问答（btw 多文件扩展的组成部分）
 *
 * 职责：单轮问答的核心执行（首问与追问共用）：
 * - 跑 pi-agent-core 官方 agentLoop（与 init 子代理同构）：每轮 LLM 调用经 streamFn
 *   包装转发 text_delta 到面板实现流式；工具轮次的状态在面板状态行显示当前工具
 * - 认证走 ctx.modelRegistry.getApiKeyAndHeaders()（与 init 子代理同一条链）
 * - 空回答重试（模型偶发空 assistant 消息）→ auto 模式故障转移（换下一个更贵的模型）
 *   → 全失败如实报错，避免「（无文字回答）」静默吞掉问题
 *
 * 注意：本模块不注册任何 pi API，仅导出函数，由入口驱动。
 */
import { createReadOnlyTools, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentLoopConfig, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AnyModel } from "../shared/model-select";
import {
	BTW_SYSTEM_PROMPT,
	BTW_MAX_TOKENS,
	BTW_MAX_TURNS,
	BTW_MAX_TOTAL_MESSAGES,
	BTW_EMPTY_RETRY,
} from "./config";
import { buildContextMessages, mergeAdjacent, convertToLlm, extractText } from "./messages";
import type { BtwOverlay } from "./overlay";

// 后台流式问答
// ---------------------------------------------------------------------------

export async function runBtwTurn(
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
		// 没有找到文字回答（预算用尽等）：先在同一模型重试（模型偶发空回答），
		// 重试用尽仍空则视为该模型不可用——auto 模式换下一个更贵的模型（failover），
		// 全部候选都空回答才如实报错，避免「（无文字回答）」静默吞掉问题。
		const fallback = overlay.getAnswer();
		if (!fallback) {
			if (retries < BTW_EMPTY_RETRY) {
				// 模型偶发空回答（如 deepseek-v4-flash 瞬时返回空 assistant 消息）：清空状态重试
				overlay.startQuestion(question); // 清空 answer/status，重新进入 thinking
				return runBtwTurn(ctx, model, thread, question, signal, overlay, onDone, failover, retries + 1);
			}
			// 同一模型重试用尽仍空（订阅套餐/0 价模型等可能实际不可用）：换下一个更贵的
			const next = failover?.();
			if (next) {
				overlay.setModel(`${next.provider}/${next.id}`); // 标题同步实际使用模型
				overlay.startQuestion(question);
				return runBtwTurn(ctx, next, thread, question, signal, overlay, onDone, failover, 0);
			}
			overlay.fail(`所有候选模型均无文字回答（最后尝试：${model.provider}/${model.id}）`);
			return;
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
