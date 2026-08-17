/**
 * 子代理公共件：消息转换 + pi 认证通道 streamFn 工厂
 *
 * claude-it（/init 子代理）与 explore（探索子代理）原先各自维护逐字相同的
 * convertToLlm 与 streamFn 实现，现收敛到此模块，由 build.js 内联进各产物。
 */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 标准消息直通转换：子代理会话里只有 user/assistant/toolResult，无需特殊处理 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

/**
 * 创建走 pi 已登录通道的 streamFn：每次 LLM 调用前从模型注册表取最新认证
 * （兼容 OAuth 刷新），请求由 pi-ai 的 provider 实现发出，支持任意 API 类型。
 */
export function createPiStreamFn(ctx: ExtensionContext): StreamFn {
	return async (m, c, options) => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
		if (!auth.ok) throw new Error(`认证失败：${auth.error}`);
		return streamSimple(m, c, {
			...options,
			apiKey: auth.apiKey ?? options?.apiKey,
			headers: { ...auth.headers, ...options?.headers },
		});
	};
}
