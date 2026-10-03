/**
 * 上下文预算：token 粗估、超限措辞识别、旧工具结果剪枝。
 *
 * 子代理循环（claude-it 的 /init、explore-agent 的子代理）没有 pi 主会话的自动压缩，
 * 长跑会撞模型上下文上限。这里放三个通用件，供两类循环共用一份实现：
 * - estimateTokens：粗估文本 token（中文按 1 字 1 token、ASCII 按 3.5 字符 1 token，宁可高估）；
 * - pruneOldToolResults：超预算时从最旧开始把工具结果换成占位文本（工具结果都可由 read 重新取得），
 *   按「重读代价」排序——read/grep/find/ls/bash 先剪、explore 报告次之、write/edit 结果不剪；
 *   只影响本次请求的消息副本，会话记录不动；
 * - CONTEXT_OVERFLOW_RE：各家供应商超限措辞，供错误分支识别（命中后走压缩续跑）。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** 各家上下文超限措辞（限流/网络类不算，避免误判为超限） */
export const CONTEXT_OVERFLOW_RE =
	/context (length|window|limit)|maximum context|too many tokens|token.{0,16}(limit|exceed)|\b413\b|request entity too large|prompt is too long|input is too long|超过.{0,6}(长度|上限)|reduce the length|tokens in the messages/i;

/** 大字符计数（CJK、全角标点等按 1 字 1 token 计） */
const WIDE_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g;

/** 粗估 token（宁可高估，用于剪枝阈值判断） */
export function estimateTokens(text: string): number {
	const wide = (text.match(WIDE_RE) ?? []).length;
	return wide + (text.length - wide) / 3.5;
}

/** 工具结果剪枝代价：越小越先剪（能廉价重读的先剪）；未登记的工具按 2 处理 */
const TOOL_COST: Record<string, number> = { read: 0, grep: 0, find: 0, ls: 0, bash: 0, explore: 1 };
/** 不剪的工具：写文件的结果是当前状态的确认，剪了没有收益 */
const NEVER_PRUNE = new Set(["write", "edit"]);
/** 最近这么多条消息不动（近期上下文是当前工作台） */
const KEEP_RECENT = 10;
const PLACEHOLDER = "（此处早期工具结果已省略以控制上下文；需要时用 read / grep 重新获取）";

function messageText(m: unknown): string {
	const content = (m as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("\n");
}

function totalTokens(messages: AgentMessage[]): number {
	let sum = 0;
	for (const m of messages) sum += estimateTokens(messageText(m));
	return sum;
}

/**
 * 超预算时从最旧开始把工具结果剪成占位文本（返回新数组；未超预算原样返回）。
 * 系统/用户/助手消息一律保留——过程结论都在正文里，工具结果只是可通过 read 再取的原料。
 */
export function pruneOldToolResults(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
	const keepFrom = Math.max(0, messages.length - KEEP_RECENT);
	const candidates: Array<{ index: number; cost: number }> = [];
	for (let i = 0; i < keepFrom; i++) {
		const m = messages[i] as { role?: string; toolName?: string };
		if (m.role !== "toolResult" || NEVER_PRUNE.has(m.toolName ?? "")) continue;
		candidates.push({ index: i, cost: TOOL_COST[m.toolName ?? ""] ?? 2 });
	}
	let total = totalTokens(messages);
	if (total <= budgetTokens) return messages;
	candidates.sort((a, b) => a.cost - b.cost || a.index - b.index);
	const out = messages.slice();
	for (const c of candidates) {
		if (total <= budgetTokens) break;
		const before = estimateTokens(messageText(out[c.index]));
		if (before <= estimateTokens(PLACEHOLDER)) continue;
		out[c.index] = { ...(out[c.index] as object), content: [{ type: "text", text: PLACEHOLDER }] } as AgentMessage;
		total -= before - estimateTokens(PLACEHOLDER);
	}
	return out;
}
