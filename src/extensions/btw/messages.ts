/**
 * btw/messages：消息清洗与组装（btw 多文件扩展的组成部分）
 *
 * 职责：把主会话上下文与面板线程清洗成喂给 LLM 的 user/assistant 纯文本消息序列：
 * - toolResult 降级为 user（标注工具名）、剥离 tool_use/thinking 块、合并连续同角色、
 *   保证以 user 结尾——兼容 OpenAI（role 'tool' 配对校验）与 Anthropic（tool_result
 *   紧跟 assistant tool_use）两类端点，任意截断点都安全；
 * - 主 agent 正在工作时上下文截止到最近一次用户输入（不含），避免把未完成的 turn 喂给 btw。
 *
 * 注意：本模块不注册任何 pi API，仅导出纯函数，由 run.ts 与入口驱动。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BTW_MAX_TOOL_RESULT_CHARS, BTW_MAX_CONTEXT_MESSAGES } from "./config";

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
export function mergeAdjacent(messages: Message[]): Message[] {
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
export function buildContextMessages(sessionMessages: AgentMessage[], ctx: ExtensionCommandContext): Message[] {
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
export function extractText(message: { content?: Array<{ type: string; text?: string }> }): string {
	return (message.content ?? [])
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && !!b.text)
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/** 标准消息直通转换：agentLoop 会话里只有 user/assistant/toolResult */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}
