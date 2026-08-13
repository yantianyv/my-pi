/**
 * web-tool/search：多源搜索 + 条目级评分合并（web-tool 多文件扩展的组成部分）
 *
 * 职责：
 * - 三源：bing.cn RSS / 360 搜索 HTML（通用网页，双源并行）/ npm registry JSON（垂类包）
 * - 结果**逐条评分合并**：标题/URL/摘要按权重计分 + 完整查询短语命中强加成，
 *   跨源去重（URL 规范化 / 标题归一化）后按分数降序取前 MAX_RESULTS
 * - 差评降权（动态黑名单）：评分时按 dislikePenalty 降权，达封禁阈值直接滤除
 * - formatSearchResults：按来源分组输出文本（组标题 [bing]/[so360]），供 web_search 工具返回
 *
 * 注意：本模块不注册任何 pi API，仅导出纯函数/类型，由本目录其它模块与入口驱动。
 */
import { httpGet, SEARCH_TIMEOUT_MS } from "./http";
import { loadDislikeData, dislikePenalty, hostnameOf } from "./dislike";

/** 单次搜索返回给 agent 的结果条数上限（多源合并去重后取分数最高的这么多条） */
const MAX_RESULTS = 15;
/** 搜索结果摘要返回给 agent 的最大长度 */
const SNIPPET_MAX_CHARS = 200;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** 来源标识（bing/so360/npm），合并搜索结果时标注用 */
	src?: string;
}

/** HTML 实体解码（搜索结果解析用） */
export function decodeHtml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, "&");
}

/** 剥标签（搜索结果解析与 fetch 标题提取共用） */
export function stripTags(s: string): string {
	return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 搜索源实现
// ---------------------------------------------------------------------------

/** bing.cn RSS：<item> 内 title/link/description，纯正则解析（不引入 XML 库） */
async function searchBing(query: string): Promise<SearchResult[]> {
	const html = await httpGet(
		`https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss`,
		SEARCH_TIMEOUT_MS,
	);
	const items = html.match(/<item>[\s\S]*?<\/item>/g) ?? [];
	const results: SearchResult[] = [];
	for (const it of items) {
		const title = decodeHtml(stripTags(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""));
		const link = (it.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim();
		const snippet = decodeHtml(stripTags(it.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ""));
		if (link && /^https?:\/\//.test(link)) results.push({ title: title || link, url: link, snippet });
	}
	return results;
}

/** 360 搜索 HTML：res-list 块内 data-mdurl 为真实 URL、res-title 为标题、res-desc 为摘要 */
async function searchSo360(query: string): Promise<SearchResult[]> {
	const html = await httpGet(
		`https://www.so.com/s?q=${encodeURIComponent(query)}`,
		SEARCH_TIMEOUT_MS,
	);
	const blocks = html.match(/<li class="res-list[^>]*>[\s\S]*?<\/li>/g) ?? [];
	const results: SearchResult[] = [];
	for (const b of blocks) {
		if (!/res-title/.test(b)) continue;
		const title = decodeHtml(
			stripTags(b.match(/<h3[^>]*class="[^"]*res-title[^"]*"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""),
		);
		// data-mdurl 是真实 URL（href 是 so.com 跳转链，避免给 agent 多余一跳）
		const url = (
			b.match(/data-mdurl="([^"]*)"/)?.[1] ??
			b.match(/<a[^>]*href="(https?:\/\/[^"]*)"/)?.[1] ??
			""
		).trim();
		const snippet = decodeHtml(
			stripTags(b.match(/<div class="res-desc">([\s\S]*?)<\/div>/)?.[1] ?? ""),
		);
		if (url && /^https?:\/\//.test(url)) results.push({ title: title || url, url, snippet });
	}
	return results;
}

/** npm registry search JSON API（垂类：查包名/版本/描述/主页） */
export async function searchNpm(query: string): Promise<SearchResult[]> {
	const text = await httpGet(
		`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${MAX_RESULTS}`,
		SEARCH_TIMEOUT_MS,
	);
	let data: { objects?: Array<{ package?: Record<string, unknown> }> };
	try {
		data = JSON.parse(text) as { objects?: Array<{ package?: Record<string, unknown> }> };
	} catch {
		throw new Error("npm registry 返回非 JSON（可能被限流）");
	}
	const results: SearchResult[] = [];
	for (const o of data.objects ?? []) {
		const pkg = o.package ?? {};
		const name = typeof pkg.name === "string" ? pkg.name : "";
		const version = typeof pkg.version === "string" ? pkg.version : "";
		const desc = typeof pkg.description === "string" ? pkg.description : "";
		if (!name) continue;
		results.push({
			title: version ? `${name}@${version}` : name,
			url: (pkg.links as { npm?: string } | undefined)?.npm ?? `https://www.npmjs.com/package/${name}`,
			snippet: desc,
		});
	}
	return results;
}

// ---------------------------------------------------------------------------
// 评分与合并
// ---------------------------------------------------------------------------

/** 提取查询中的有效特征词：按空白/标点切分，保留 ≥2 字且非停用词（中英停用词都滤；
 *  中文长词组如「陕西师范大学」整体保留作强信号词，英文词按整词匹配防子串误报） */
function queryKeywords(q: string): string[] {
	const stops = new Set([
		"的", "了", "和", "与", "或", "在", "是", "有", "等", "及", "为", "中", "以", "之", "于",
		"a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "with", "at", "by", "from",
		"vs", "is", "are", "was", "were", "be", "do", "does", "how", "what", "why", "when", "where",
	]);
	return q.split(/[\s,，。、;；:：]+/).filter((w) => w.length >= 2 && !stops.has(w.toLowerCase()));
}

/** 关键词命中判定：纯 ASCII 关键词需词边界（防子串误报，如搜 cat 误中 concatenate）；
 *  含中文等非 ASCII 的关键词用子串匹配（中文无词边界概念） */
function containsKeyword(hay: string, kw: string): boolean {
	const lower = hay.toLowerCase();
	const k = kw.toLowerCase();
	if (!lower.includes(k)) return false;
	if (/^[\x20-\x7e]+$/.test(k)) {
		const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(lower);
	}
	return true;
}

/** 评分用 URL 文本：只取 hostname+pathname（query 参数常是搜索词的 echo——如限流占位页
 *  ?q=查询词——不是页面真实内容信号，不应计入相关度） */
function urlTextForScoring(url: string): string {
	try {
		const u = new URL(url);
		return `${u.hostname}${u.pathname}`;
	} catch {
		return url;
	}
}

/** 单条结果相关度评分（0 起，无上限；标题/URL/摘要按权重逐词计分 + 强信号加成）：
 *  - 标题命中 30/词、URL 命中 12/词（仅 hostname+pathname）、摘要命中 8/词——标题是最强相关信号，URL 次之；
 *  - 完整查询短语（去空白）命中任一字段 +40：bing 把「地名+机构」泛化成地域搜索时，
 *    只有真正相关的结果才含完整短语，泛化结果分低自然沉底；
 *  - 标题覆盖全部关键词 +15（多关键词查询的强相关信号） */
function scoreResult(r: SearchResult, keywords: string[], query: string): number {
	const urlText = urlTextForScoring(r.url);
	const titleHits = keywords.filter((k) => containsKeyword(r.title, k)).length;
	const urlHits = keywords.filter((k) => containsKeyword(urlText, k)).length;
	const snipHits = keywords.filter((k) => containsKeyword(r.snippet, k)).length;
	let score = titleHits * 30 + urlHits * 12 + snipHits * 8;
	if (keywords.length > 1) {
		const phrase = query.toLowerCase().replace(/\s+/g, "");
		const hay = `${r.title} ${r.snippet} ${urlText}`.toLowerCase().replace(/\s+/g, "");
		if (phrase && hay.includes(phrase)) score += 40;
		if (titleHits === keywords.length) score += 15;
	}
	return score;
}

/** URL 规范化去重键：去掉跟踪参数（utm 系列/fbclid/gclid/ref/source/spm 等）、www.、尾部斜杠、协议，保留有意义的 query */
function urlDedupKey(url: string): string {
	try {
		const u = new URL(url);
		for (const p of [...u.searchParams.keys()]) {
			if (/^(utm_|fbclid|gclid|yclid|igshid|ref|source|spm|from|traceid)/i.test(p)) u.searchParams.delete(p);
		}
		const host = u.hostname.replace(/^www\./i, "").toLowerCase();
		return `${host}${u.pathname.replace(/\/+$/, "").toLowerCase()}${u.search}`;
	} catch {
		return url.toLowerCase();
	}
}

/** 标题归一化去重键：去空白/标点/大小写，用于不同 URL 转发同一文章的近似去重 */
function titleDedupKey(title: string): string {
	return title.toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

/** 多源结果合并：逐条评分 → 差评降权（动态黑名单）→ 分数降序（同分按源内原排位，搜索引擎自身排序作 tie-breaker）→
 *  跨源去重（URL 规范化相同 / 标题归一化相同即重复）→ 取前 MAX_RESULTS。
 *  旧「整源择优」只留一个源，且命中率按比例算——bing 泛化时结果多反而凑出高命中率；
 *  条目级评分让两个源的高质量条目都能浮上来，零命中（score 0）的垃圾条目沉底被滤掉 */
function mergeRankResults(sources: Array<{ src: string; results: SearchResult[] }>, query: string): SearchResult[] {
	const keywords = queryKeywords(query);
	const dislike = loadDislikeData(); // 读一次差评表，供全批降权
	const scored = sources.flatMap(({ src, results }) =>
		results.map((r, i) => {
			let score = scoreResult(r, keywords, query);
			if (score > 0) score = Math.round(score * dislikePenalty(hostnameOf(r.url), dislike));
			return { r: { ...r, src } as SearchResult, score, rank: i };
		}),
	);
	scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
	const seenUrls = new Set<string>();
	const seenTitles = new Set<string>();
	const out: SearchResult[] = [];
	for (const item of scored) {
		if (item.score <= 0) break; // 已降序，其后都是零命中条目
		const urlKey = urlDedupKey(item.r.url);
		const titleKey = titleDedupKey(item.r.title);
		if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) continue;
		seenUrls.add(urlKey);
		seenTitles.add(titleKey);
		out.push(item.r);
		if (out.length >= MAX_RESULTS) break;
	}
	return out;
}

/** 通用网页搜索：双源并行 → 条目级评分合并 → 去重取前 MAX_RESULTS。
 *  根因（历史）：cn.bing.com（中国版）查询理解会把「地名+机构名」组合（如“陕西师范大学”）
 *  降级成地域搜索丢弃长尾词（已实测：含“陕西师范大学”的查询全泛化成“陕西省”；裸请求/参数/
 *  编码均无法影响），360 对这类中文查询正常；限流时 bing 只回 1 条占位。合并评分下这些
 *  低相关条目分数低自然被滤掉，无需再特判限流/泛化 */
export async function searchWeb(query: string): Promise<{ results: SearchResult[]; source: string }> {
	const attempts = await Promise.allSettled([
		searchBing(query).then((results) => ({ src: "bing" as const, results })),
		searchSo360(query).then((results) => ({ src: "so360" as const, results })),
	]);
	const sources: Array<{ src: string; results: SearchResult[] }> = [];
	const errors: string[] = [];
	for (const a of attempts) {
		if (a.status === "rejected") {
			errors.push(`${a.reason instanceof Error ? a.reason.message : String(a.reason)}`);
			continue;
		}
		if (!a.value.results.length) {
			errors.push(`${a.value.src}: 无结果`);
			continue;
		}
		sources.push(a.value);
	}
	if (!sources.length) throw new Error(`所有搜索源失败：${errors.join("；")}`);
	const results = mergeRankResults(sources, query);
	if (!results.length) {
		const detail = errors.length ? errors.join("；") : "结果均不相关（关键词过泛或查询有误）";
		throw new Error(`所有搜索源失败：${detail}`);
	}
	return {
		results,
		source: sources.length > 1 ? sources.map((s) => s.src).join("+") : sources[0]!.src,
	};
}

/** 结果展示：按来源分组（组标题行 [bing]/[so360]），组内保持分数降序，序号全局连续；
 *  来源标注只在混合源需要区分时出现（组标题），单源不分组也无来源——省 token */
export function formatSearchResults(results: SearchResult[], source: string): string {
	// 分组：保持源首次出现顺序（全局数组已按分数降序，故组序即组内最高分降序）
	const groups: Array<{ src: string; items: SearchResult[] }> = [];
	const groupMap = new Map<string, SearchResult[]>();
	for (const r of results) {
		const key = r.src ?? source;
		if (!groupMap.has(key)) {
			groupMap.set(key, []);
			groups.push({ src: key, items: groupMap.get(key)! });
		}
		groupMap.get(key)!.push(r);
	}
	const lines = [`共 ${results.length} 条结果：`];
	let index = 0;
	for (const g of groups) {
		if (groups.length > 1) lines.push(`[${g.src}]`);
		for (const r of g.items) {
			index++;
			const snippet = r.snippet.length > SNIPPET_MAX_CHARS ? `${r.snippet.slice(0, SNIPPET_MAX_CHARS)}…` : r.snippet;
			lines.push(`${index}. ${r.title}`);
			lines.push(`   ${r.url}`);
			if (snippet) lines.push(`   ${snippet}`);
		}
	}
	lines.push("", "需要深读某条结果时，用 web_fetch 抓取对应 URL 转为 markdown。");
	return lines.join("\n");
}
