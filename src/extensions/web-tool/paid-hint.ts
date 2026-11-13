/**
 * web-tool/paid-hint：免费搜索结果的付费源引导（web-tool 多文件扩展的组成部分）
 *
 * 职责：
 * - 免费搜索成功时，在结果末尾附一行「结果不满意可换付费源」+ 具体调用方式
 * - **每个会话只提示一次**（内存集合按 sessionId 记账，session_shutdown 清空）——重复提示会
 *   成为每轮都要付 token 的噪音；付费源本身也不写进工具描述，免得模型默认就去花这笔钱
 *
 * 注意：本模块不注册任何 pi API，仅导出纯函数，由入口驱动。
 */
import { PAID_PROVIDERS, type PaidProvider } from "./providers";

/** 已提示过的会话（sessionId 集合；会话切换/重启后清空，各有各的第一条） */
const hintedSessions = new Set<string>();

/** 会话结束时清账（避免 sessionId 无限累积） */
export function resetPaidHint(sessionId: string): void {
	hintedSessions.delete(sessionId);
}

/**
 * 取本次应追加的引导文本；同一会话第二次及以后返回 undefined（不再提示）。
 * 没有可用的付费源时也返回 undefined（不提一个用不了的能力）。
 */
export function takePaidHint(sessionId: string, available: PaidProvider[]): string | undefined {
	if (!available.length) return undefined;
	if (hintedSessions.has(sessionId)) return undefined;
	hintedSessions.add(sessionId);
	const lines = available.map((p) => {
		const { label, costNote } = PAID_PROVIDERS[p];
		return `- ${label}：重试时传 provider="${p}"（${costNote}）`;
	});
	return ["如果对上面的结果不满意，可以换付费搜索源再搜一次：", ...lines].join("\n");
}
