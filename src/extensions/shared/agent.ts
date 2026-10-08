/**
 * 子代理公共件：消息转换 + pi 认证通道 streamFn 工厂
 *
 * claude-it（/init 子代理）等子代理类扩展共用此模块：convertToLlm 与 streamFn
 * 的公共实现，由 build.js 内联进各产物。供应商会话/归因头管道在 shared/llm.ts。
 */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piAttributionHeaders } from "./llm";

/** 标准消息直通转换：子代理会话里只有 system/user/assistant/toolResult，无需特殊处理。
 * 0.86 起 system 必须放行：AgentContext 不再收 systemPrompt 字段，系统提示词以
 * 前导 system 消息的形式挂在 messages 里（TranscriptContext 归一化模型），过滤掉会丢提示词。 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) =>
			m.role === "system" ||
			m.role === "user" ||
			m.role === "assistant" ||
			m.role === "toolResult",
	) as Message[];
}

/**
 * 构造前导 system 消息（0.86 TranscriptContext 模型）：AgentContext 已无 systemPrompt 字段，
 * 子代理的系统提示词改为以 system 消息置于 context.messages 开头；工具仍走 context.tools，
 * 由 agent-loop 的 declareToolChanges 自动声明进系统消息（空 content 重放时被跳过，无副作用）。
 */
export function systemMessage(content: string): AgentMessage {
	return { role: "system", content, timestamp: Date.now() };
}

/**
 * 创建走 pi 已登录通道的 streamFn：每次 LLM 调用前从模型注册表取最新认证
 * （兼容 OAuth 刷新），请求由 pi-ai 的 provider 实现发出，支持任意 API 类型。
 *
 * 头语义与主会话对齐：会话/归因头（pi 按供应商规则统一生成）作基座，auth 头与调用方
 * options 头依次覆盖——与主通道 transformHeaders(mergeProviderAttributionHeaders(…)) 的
 * 合并顺序一致。
 */
export function createPiStreamFn(ctx: ExtensionContext): StreamFn {
	const sessionId = ctx.sessionManager.getSessionId();
	return async (m, c, options) => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
		if (!auth.ok) throw new Error(`认证失败：${auth.error}`);
		const attribution = piAttributionHeaders(m, ctx.cwd, sessionId);
		return streamSimple(m, c, {
			...options,
			apiKey: auth.apiKey ?? options?.apiKey,
			headers: { ...(attribution ?? {}), ...auth.headers, ...options?.headers },
		});
	};
}
