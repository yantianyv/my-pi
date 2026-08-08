/**
 * web-search: Kimi Code 联网搜索工具（给 agent 用的 web_search 自定义工具）
 *
 * 注册 web_search 工具：主 agent 需要查实时信息（GitHub issue、文档、新闻、
 * 价格等）时调用，返回 Kimi 总结的中文文字 + 结果标题/URL 列表。
 *
 * 实现要点：
 * - 后端固定用 kimi-coding 供应商（订阅可用的 Anthropic 兼容端点 +
 *   web_search_20250305 服务端工具），与 pi 当前用哪个模型/供应商无关；
 * - 认证走 ctx.modelRegistry.getProviderAuth("kimi-coding")——与 pi 其他
 *   OAuth 通道同一条解析链，快过期时自动刷新，不存在脚本版 token 过期问题；
 * - 两段式流程（实测必要）：请求 1 发起搜索，kimi 服务端执行并返回结果
 *   （正文是 encrypted_content，客户端无法解密）；请求 2 把请求 1 的
 *   assistant 内容原样塞回历史，让 kimi 基于结果总结成文字——否则 kimi
 *   一轮就 end_turn，只回原始结果，agent 读不到正文；
 * - 成本：一次搜索 = 2 次 API 调用（各约 1 万+ token）+ 按次搜索费，别滥用；
 * - kimi-coding 登出后工具报错并提示重新 /login。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setStatusWithTTL } from "./shared/status";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 搜索后端供应商（需要 kimi 订阅 + 已登录） */
const KIMI_PROVIDER = "kimi-coding";
/** Kimi Code Anthropic 兼容端点 */
const ENDPOINT = "https://api.kimi.com/coding/v1/messages";
/** 搜索用模型（k3 支持服务端 web_search） */
const SEARCH_MODEL = "k3";
/** 单次请求最大输出 token */
const MAX_TOKENS = 6000;
/** 返回给 agent 的结果条数上限 */
const MAX_RESULTS_RETURN = 12;
/** 单次请求超时 */
const REQUEST_TIMEOUT_MS = 120_000;

interface Block {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
	content?: unknown;
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

function extractText(blocks: Block[]): string {
	return blocks
		.filter((b) => b.type === "text" && b.text)
		.map((b) => b.text as string)
		.join("\n")
		.trim();
}

/** 两段式：搜索 → 把结果塞回历史要总结。返回 { summary, results } */
async function searchAndSummarize(ctx: ExtensionContext, query: string, language: string): Promise<{ summary: string; results: Array<{ title: string; url: string }> }> {
	const auth = await ctx.modelRegistry.getProviderAuth(KIMI_PROVIDER);
	const bearer = auth?.auth?.headers?.Authorization;
	if (!bearer) {
		throw new Error("kimi-coding 未登录（或凭据已失效）。请在 pi 里执行 /login 重新登录后再用 web_search。");
	}

	const headers = {
		Authorization: bearer,
		"anthropic-version": "2023-06-01",
		"Content-Type": "application/json",
	};
	const tools = [{ type: "web_search_20250305", name: "web_search" }];
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	async function call(messages: unknown[]): Promise<Block[]> {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers,
			signal: controller.signal,
			body: JSON.stringify({
				model: SEARCH_MODEL,
				max_tokens: MAX_TOKENS,
				messages,
				tools,
			}),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			const msg = (data as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
			throw new Error(`搜索请求失败：${msg}`);
		}
		return (data as { content: Block[] }).content ?? [];
	}

	try {
		// 请求 1：发起搜索
		const first = await call([{ role: "user", content: query }]);
		const assistantBlocks = first.filter((b) => b.type !== "thinking");
		const resultBlocks = first.filter((b) => b.type === "web_search_tool_result");
		const results: Array<{ title: string; url: string }> = [];
		for (const rb of resultBlocks) {
			if (!Array.isArray(rb.content)) continue;
			for (const r of rb.content as Array<{ title?: string; url?: string }>) {
				if (r?.url) results.push({ title: r.title ?? r.url, url: r.url });
			}
		}

		// 请求 2：把结果塞回历史，要 kimi 基于结果总结
		const summaryBlocks = await call([
			{ role: "user", content: query },
			{ role: "assistant", content: assistantBlocks },
			{
				role: "user",
				content: `请基于上面的搜索结果，用${language}总结。要点：有哪些相关条目、各自的关键信息与结论。`
					+ `不要只罗列链接。如果搜索结果不足以回答问题，如实说明。`,
			},
		]);
		const summary = extractText(summaryBlocks) || "(kimi 未产出总结文本)";
		return { summary, results };
	} finally {
		clearTimeout(timer);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "联网搜索",
		description:
			"搜索互联网（Kimi Code 联网搜索，服务端执行），返回文字总结 + 结果标题/URL 列表。"
			+ "用于查询 GitHub issue、文档、新闻、价格等实时信息。一次搜索成本约 1~2 万 token + 按次搜索费，避免频繁调用。",
		promptSnippet: "搜索互联网：web_search(查询词) → 文字总结 + 来源链接",
		promptGuidelines: [
			"Use web_search to look up real-time or external information (GitHub issues, docs, news, prices) instead of guessing or relying on stale memory.",
			"Pass a concrete search query; if the first result set is unsatisfying, call web_search again with a refined query.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "搜索查询词（可含站点限定，如 site:github.com）" }),
			language: Type.Optional(Type.String({ description: "总结输出语言，默认「中文」" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			// 状态广播：官方 setStatus 通道推给 hud 行 1 动态区（🔍 搜索中）；TTL 由 shared/status 管理（同 key 重复调用自动重置）
			const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "web-search", text, ttlMs);
			push("🔍 搜索中", 30_000); // 30s 兜底：即使下方漏发 done 也会自动消失，不悬挂
			onUpdate?.({ content: [{ type: "text", text: `正在搜索：${params.query}` }], details: { progress: 10 } });
			try {
				const { summary, results } = await searchAndSummarize(ctx, params.query, params.language ?? "中文");
				push(`🔍 ${results.length} 条`, 6_000);
				const lines = [summary, "", `共 ${results.length} 条结果：`];
				for (const r of results.slice(0, MAX_RESULTS_RETURN)) {
					lines.push(`- ${r.title}\n  ${r.url}`);
				}
				if (results.length > MAX_RESULTS_RETURN) {
					lines.push(`…（另 ${results.length - MAX_RESULTS_RETURN} 条未列出）`);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { results: results.length },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				push("🔍 失败", 6_000);
				return {
					content: [{ type: "text", text: `搜索失败：${msg}` }],
					details: { error: msg },
				};
			}
		},
	});
}
