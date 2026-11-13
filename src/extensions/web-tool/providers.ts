/**
 * web-tool/providers：搜索供应商（web-tool 多文件扩展的组成部分）
 *
 * 两个参数正交，互不重叠：
 * - `provider`（本模块）：由谁来搜索——`free` 走本目录 search.ts 的三源 HTML 抓取，
 *   `deepseek` 走 DeepSeek 官方 Search API（结构化 JSON + 服务端 rerank）
 * - `source`（入口）：搜哪类资源——web / npm / github；npm registry 与 GitHub API 本身免费，
 *   所以这两个 source 恒走免费通道，provider 不适用
 *
 * 认证复用 pi 已配置的供应商 key（ctx.modelRegistry），插件不另存凭证。
 *
 * 注意：本模块不注册任何 pi API，仅导出纯函数/类型，由入口驱动。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { httpPostJson, SEARCH_TIMEOUT_MS } from "../shared/http";
import { dislikePenalty, hostnameOf, loadDislikeData } from "./dislike";
import type { SearchResult } from "./search";

/** 免费 provider（三源 HTML 抓取，零成本零 key） */
export const FREE_PROVIDER = "free";

/** 付费 provider 标识 */
export type PaidProvider = "deepseek";

/** 单个付费 provider 的描述 */
export interface PaidProviderSpec {
	/** 展示名（提示文案用） */
	label: string;
	/** 计费说明（提示文案用） */
	costNote: string;
	/** 对应的 pi 供应商 id（取 API key 用） */
	piProvider: string;
}

/** 付费 provider 清单：provider 取值 → 描述 */
export const PAID_PROVIDERS: Record<PaidProvider, PaidProviderSpec> = {
	deepseek: { label: "DeepSeek", costNote: "每 1000 次成功搜索 5 元", piProvider: "deepseek" },
};

/** provider 参数的全部合法取值（从清单派生，两者不会不同步） */
export const PROVIDER_VALUES: readonly string[] = [FREE_PROVIDER, ...Object.keys(PAID_PROVIDERS)];

/** 是否为受支持的付费 provider（入口据此区分「合法付费源」与「未知取值」） */
export function isPaidProvider(v: string): v is PaidProvider {
	return v in PAID_PROVIDERS;
}

/**
 * 从 pi 的供应商配置取 API key。DeepSeek Search 的 base URL 是 api.deepseek.com，
 * 与 pi 里 deepseek 供应商同源，直接复用其 key（未配置返回 undefined）。
 */
export async function providerApiKey(ctx: ExtensionContext, spec: PaidProviderSpec): Promise<string | undefined> {
	try {
		const cred = await ctx.modelRegistry.getApiKeyForProvider(spec.piProvider);
		return cred || undefined;
	} catch {
		return undefined;
	}
}

/** DeepSeek Search API 响应（只声明用到的字段） */
interface DeepseekSearchResponse {
	results?: Array<{
		title?: string;
		url?: string;
		snippet?: string;
		summary?: string;
		rerank_score?: number;
		authority?: number;
		date?: string | null;
	}>;
	error?: { message?: string };
}

/** 摘要取长摘要（600~800 字，专给模型读），过长截断——整条塞进来会挤掉其它结果 */
const SUMMARY_MAX_CHARS = 400;

async function searchDeepseek(query: string, cred: string, signal?: AbortSignal): Promise<SearchResult[]> {
	const data = await httpPostJson<DeepseekSearchResponse>(
		"https://api.deepseek.com/v1/tools/search",
		{ query, count: 15 },
		{ Authorization: `Bearer ${cred}` },
		SEARCH_TIMEOUT_MS,
	);
	if (signal?.aborted) throw new Error("已取消");
	const raw: Array<{ result: SearchResult; score: number }> = [];
	for (const r of data.results ?? []) {
		const url = (r.url ?? "").trim();
		if (!url || !/^https?:\/\//.test(url)) continue;
		const summary = (r.summary || r.snippet || "").replace(/\s+/g, " ").trim();
		const snippet = summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary;
		// 权威度与发布日期放**摘要开头**：结果展示层会再按 200 字截断一次，追加在 400 字摘要尾部必然被切掉
		const meta: string[] = [];
		if (typeof r.authority === "number" && r.authority >= 0) meta.push(`权威 ${r.authority}`);
		if (r.date) meta.push(r.date.slice(0, 10));
		raw.push({
			score: typeof r.rerank_score === "number" ? r.rerank_score : 0,
			result: {
				title: (r.title ?? "").trim() || url,
				url,
				snippet: meta.length ? `（${meta.join(" · ")}）${snippet}` : snippet,
				src: "deepseek",
			},
		});
	}
	// 差评降权与免费源共用同一份黑名单：不重算关键词分（服务端语义排序比词面匹配准），
	// 只把 rerank_score 与差评系数相乘；封禁阈值命中即滤除
	const dislike = loadDislikeData();
	const kept = raw
		.map(({ result, score }) => ({ result, score: score * dislikePenalty(hostnameOf(result.url), dislike) }))
		.filter((x) => x.score > 0);
	kept.sort((a, b) => b.score - a.score);
	return kept.map((x) => x.result);
}

/** 付费 provider 派发：目前只有 DeepSeek，新增时在这里加一个分支 */
export async function searchPaid(
	provider: PaidProvider,
	query: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const spec = PAID_PROVIDERS[provider];
	if (!spec) throw new Error(`未知付费源：${provider}`);
	const cred = await providerApiKey(ctx, spec);
	if (!cred) throw new Error(`未配置 ${spec.label} 的 API key`);
	if (provider === "deepseek") return searchDeepseek(query, cred, signal);
	throw new Error(`付费源未实现：${provider}`);
}
