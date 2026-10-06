/**
 * time：时间感知——给 user 消息贴出生时间标签 + `now` 工具查绝对当前
 *
 * 让 AI 拥有相对时间感知：辨识会话历史里每条消息发生在大约什么时候，
 * 避免"隔了一天以为过了几小时"（或反方向）的失真判断。格式：首行 [YYYY-MM-DD HH:mm]，
 * 换行接正文——标签独立成行，正文首行自己长得像时间戳时也零歧义。
 *
 * 机制（对 pi 完全透明）：
 * - 上下文里的每条消息对象自带 `timestamp`（毫秒，常量），我们只做格式化，
 *   不需要任何对齐或读盘；toolResult 是独立 role，天然不会被误伤；
 * - `context` 事件每轮 LLM 调用前把上下文副本交给我们，pi 在 handler 返回后
 *   恢复原状——会话记录、TUI、压缩估算、其他扩展看到的上下文都不受影响；
 * - 时间戳是常量 → 每轮渲染逐字节相同 → provider 前缀缓存照常命中，历史只追加。
 *
 * 边界：
 * - 只给 user 消息贴（含文本块开头的图片消息）；custom/bashExecution/assistant
 *   等其他角色不贴（custom 在 convertToLlm 会变成 user 文本，但时间意义弱、先不做）；
 * - 带年月是因为 AI 判断"隔了多久"的误差几乎都发生在日期层；分钟级精度足够；
 * - 万一 chrono 推断不了（跨年场景模型算术易错），工具清单里有 now 按需查绝对当前。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 时间粒度到分钟：AI 的相对时间感误差主要在日期层，秒级纯属噪声 */
const STAMP_PAD = 2;

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 毫秒时间戳 → `2026-10-06 16:00`（本地时区，带年） */
export function stamp(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(STAMP_PAD, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 给 user 消息贴前缀；非 user / 非文本 / 空内容 / 已贴的，原样返回。
 * "已贴"必须精确匹配本条时间戳生成的前缀——不能只看"长得像前缀"：用户正文若以
 * 同格式时间开头（如贴一段会议纪要），按格式判定会误跳过，丢失真实时间且易被误读。
 */
export function tagUserMessage(m: AgentMessage): AgentMessage {
	if (m.role !== "user") return m;
	const prefix = `[${stamp(m.timestamp)}]\n`;
	if (typeof m.content === "string") {
		if (!m.content.trim() || m.content.startsWith(prefix)) return m;
		return { ...m, content: prefix + m.content };
	}
	if (Array.isArray(m.content)) {
		const firstText = m.content.findIndex((b) => b.type === "text");
		if (firstText === -1) return m;
		const block = m.content[firstText] as TextContent;
		if (!block.text.trim() || block.text.startsWith(prefix)) return m;
		const next = m.content.slice() as typeof m.content;
		next[firstText] = { ...block, text: prefix + block.text };
		return { ...m, content: next };
	}
	return m;
}

// ---------------------------------------------------------------------------
// 工具执行层（now）
// ---------------------------------------------------------------------------

/** 本地时间的星期几（中文） */
function weekdayCN(ts: number): string {
	return new Date(ts).toLocaleDateString("zh-CN", { weekday: "long" });
}

/** 本地时区偏移串，如 UTC+08:00 */
function tzOffset(ts: number): string {
	const d = new Date(ts);
	const total = -d.getTimezoneOffset();
	const sign = total >= 0 ? "+" : "-";
	const abs = Math.abs(total);
	const p = (n: number) => String(n).padStart(STAMP_PAD, "0");
	return `UTC${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** now 工具的输出组装 */
export function formatNow(ts: number): { text: string; structured: Record<string, unknown> } {
	const iso = new Date(ts).toISOString();
	const text = `${stamp(ts)}:${String(new Date(ts).getSeconds()).padStart(STAMP_PAD, "0")} ${weekdayCN(ts)} ${tzOffset(ts)}\nISO: ${iso}`;
	return { text, structured: { local: stamp(ts), weekday: weekdayCN(ts), iso, epochMs: ts } };
}

// ---------------------------------------------------------------------------
// 扩展装配
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event) => ({ messages: event.messages.map(tagUserMessage) }));

	pi.registerTool({
		name: "now",
		label: "查询当前时间",
		description:
			"获取当前本地时间（含星期、时区、ISO 串）。需要绝对的「现在」时调用：给输出落日期、「隔了多久」的换算基点、"
			+ "判断某天是星期几。会话历史里 user 消息开头的 [YYYY-MM-DD HH:mm] 是该条消息的发生时间。",
		promptSnippet: "查询当前时间：now() → 本地时间 + 星期 + 时区 + ISO",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const { text, structured } = formatNow(Date.now());
			return {
				content: [{ type: "text", text }],
				details: structured,
			};
		},
	});
}
