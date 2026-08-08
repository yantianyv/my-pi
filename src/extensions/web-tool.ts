/**
 * web-tool: 联网搜索 + 网页抓取转 markdown（给 agent 用的 web_search / web_fetch 两个工具）
 *
 * 多源搜索，零 API key 零费用（彻底去除对 kimi-coding 的依赖）：
 * - 通用网页：cn.bing.com RSS（主）+ 360 搜索 HTML（备），自动降级；
 * - 垂类包：npm registry JSON API（source: "npm"）；pypi.org 搜索页有 Client
 *   Challenge 反爬（实测 curl 只回挑战页），不做垂类源，Python 包让 agent 走
 *   普通网页搜索查；
 * - bing 免费接口限流特征：连续请求后只回 1 条 item，<2 条即视为被限流自动
 *   降级 360（实测 360 稳定、data-mdurl 带真实 URL、res-desc 带摘要）；
 * - 不依赖服务端 AI 总结：直接返回 标题+URL+摘要 列表由主 agent 自行判断，
 *   需要深读时用 web_fetch 抓取——成本从 kimi 时代每次 2 万+ token 降到 0。
 *
 * fetch：抓取 URL → @mixmark-io/domino 解析 DOM → 选正文容器（article/main/body）
 * → turndown(+gfm 表格) 转 markdown → 压缩空行/截断。turndown 与其依赖 domino、
 * turndown-plugin-gfm 由 build.js（esbuild）内联进单文件产物——build.js 的
 * external 白名单只保留 @earendil-works/* 与 typebox，产物仍是零外部依赖单文件。
 *
 * 抓不到的站点（GitHub 等被墙、反爬挑战页）如实报错，提示改用 web_search 查摘要。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
// @ts-ignore —— domino 自带 d.ts 模块名为 "domino"（与包名 @mixmark-io/domino 不一致），
// 类型层面 any 桥接；gfm 类型见 shared/turndown-gfm.d.ts；运行时 esbuild 按真实包名解析
import { createWindow as _createWindow } from "@mixmark-io/domino";
import { setStatusWithTTL, clearStatusTimers } from "./shared/status";

/** domino 的 createWindow（any 桥接，见上方 @ts-ignore 说明） */
const createWindow = _createWindow as (html?: string) => any;

// ---------------------------------------------------------------------------
// 可调配置（改这里后 node install.js 重装生效）
// ---------------------------------------------------------------------------

/** 浏览器 UA（bing/360 对默认 UA 会降级或返回挑战页） */
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
/** 通用网页搜索源顺序（bing 主 + 360 备；bing 被限流自动降级） */
const WEB_SOURCES_ORDER = ["bing", "so360"] as const;
/** 单次搜索返回给 agent 的结果条数上限 */
const MAX_RESULTS = 10;
/** 搜索单源超时（毫秒） */
const SEARCH_TIMEOUT_MS = 15_000;
/** fetch 整体超时（毫秒，含抓取 + 解析转换） */
const FETCH_TIMEOUT_MS = 20_000;
/** fetch 抓取 body 大小上限（超出截断，防超大页面撑爆内存） */
const FETCH_MAX_BYTES = 3 * 1024 * 1024;
/** fetch 返回 markdown 默认最大字符数 */
const DEFAULT_MAX_CHARS = 12_000;
/** fetch 返回 markdown 硬上限（防撑爆上下文） */
const MAX_CHARS_LIMIT = 60_000;
/** 搜索结果摘要返回给 agent 的最大长度 */
const SNIPPET_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

function decodeHtml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
	return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** GET 文本（带 UA / 中文语言头 / 超时），非 2xx 抛错 */
async function httpGet(url: string, timeoutMs: number): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
			signal: controller.signal,
			redirect: "follow",
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.text();
	} finally {
		clearTimeout(timer);
	}
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
async function searchNpm(query: string): Promise<SearchResult[]> {
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

/** 通用网页搜索降级链：按 WEB_SOURCES_ORDER 依次尝试，bing 被限流（<2 条）自动降级，全失败抛错附各源原因 */
async function searchWeb(query: string): Promise<{ results: SearchResult[]; source: string }> {
	const errors: string[] = [];
	for (const src of WEB_SOURCES_ORDER) {
		try {
			const results = src === "bing" ? await searchBing(query) : await searchSo360(query);
			if (src === "bing" && results.length < 2) {
				errors.push("bing: 被限流（<2 条）");
				continue;
			}
			if (results.length > 0) return { results: results.slice(0, MAX_RESULTS), source: src };
			errors.push(`${src}: 无结果`);
		} catch (e) {
			errors.push(`${src}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	throw new Error(`所有搜索源失败：${errors.join("；")}`);
}

// ---------------------------------------------------------------------------
// fetch：抓取 + HTML → markdown
// ---------------------------------------------------------------------------

/** 正文容器启发式：按优先级试语义化标签/常见内容 class，取第一个文本足够多者，全无回退 body */
function pickContainer(doc: any): any {
	const candidates = [
		"article", "main", "[role=main]",
		".entry-content", ".post-content", ".article-content", ".article-body",
		".markdown-body", ".article", ".post", ".content", "#content", "#main-content",
	];
	for (const sel of candidates) {
		const el = doc.querySelector(sel);
		if (el && (el.textContent ?? "").trim().length > 300) return el;
	}
	return doc.body;
}

/** domino 解析 → 选正文容器 → turndown(+gfm) 转 markdown → 压缩空行/相对链接补全 */
function htmlToMarkdown(html: string, baseUrl: string): { markdown: string; title: string } {
	const win = createWindow(html);
	const doc = win.document;
	// 预移除 svg（turndown 的 remove 类型不含 svg；不剥离会干扰正文提取；domino 的 NodeList 仅 length+索引，无 forEach/迭代器）
	const svgs = doc.querySelectorAll("svg") as unknown as ArrayLike<any>;
	for (let i = 0; i < svgs.length; i++) svgs[i].parentNode?.removeChild(svgs[i]);
	const container = pickContainer(doc);
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		hr: "---",
		emDelimiter: "*",
	});
	td.use(gfm);
	td.remove([
		"script", "style", "nav", "header", "footer", "aside", "form", "iframe",
		"noscript", "button", "dialog",
	]);
	let markdown = td.turndown(container?.innerHTML ?? "");
	markdown = markdown
		.replace(/[ \t]+\n/g, "\n") // 行尾空白
		.replace(/\n{3,}/g, "\n\n") // 压缩连续空行
		.trim();
	// 相对链接补全为绝对（基于页面 URL）；排除 http/https 与协议相对 //host
	let origin = "";
	try {
		origin = new URL(baseUrl).origin;
	} catch { /* 忽略非法 baseUrl */ }
	if (origin) {
		markdown = markdown.replace(/\(](?!https?:|\/\/)(\/[^)]*)\)/g, (_m, p: string) => `](${origin}${p})`);
	}
	return { markdown, title: stripTags(doc.title ?? "") };
}

/** 抓取 URL → markdown（校验协议 / 非 HTML 报错 / 字节上限 / 字符截断） */
async function fetchAsMarkdown(
	url: string,
	maxChars: number,
	signal?: AbortSignal,
): Promise<{ markdown: string; title: string; finalUrl: string; bytes: number; truncated: boolean }> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new Error(`无效 URL：${url}`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error(`仅支持 http/https URL，收到 ${u.protocol}//`);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);
	try {
		const res = await fetch(u.href, {
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
				"Accept-Language": "zh-CN,zh;q=0.9",
			},
			signal: controller.signal,
			redirect: "follow",
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
		if (ctype && !ctype.includes("html") && !ctype.includes("text/") && !ctype.includes("xml")) {
			throw new Error(`非 HTML 内容（${ctype}），无法转 markdown；请改用 web_search 查摘要`);
		}
		const buf = await res.arrayBuffer();
		const bytes = Math.min(buf.byteLength, FETCH_MAX_BYTES);
		const html = new TextDecoder().decode(new Uint8Array(buf, 0, bytes));
		const { markdown, title } = htmlToMarkdown(html, u.href);
		let out = markdown;
		let truncated = bytes < buf.byteLength; // 字节被截断
		if (out.length > maxChars) {
			// 尽量在 maxChars 附近的行边界截断（太靠前的行边界就硬切）
			let cut = out.lastIndexOf("\n", maxChars);
			if (cut < maxChars * 0.7) cut = maxChars;
			out = out.slice(0, cut).trimEnd();
			truncated = true;
		}
		return { markdown: out, title, finalUrl: res.url || u.href, bytes: buf.byteLength, truncated };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

/** 调用卡片参数展示上限（超长截断，防 URL/查询词撑爆卡片） */
const MAX_CALL_ARG_CHARS = 72;

/** 工具调用卡片渲染：粗体「图标+参数」，风格对齐内置工具（bash 显示 `$ 命令`）；参数缺失（流式未到）时用工具名兜底 */
function renderToolCall(icon: string, arg: string | undefined, theme: Theme, fallback: string): Text {
	const label = arg ?? fallback;
	const text = theme.fg(
		"toolTitle",
		theme.bold(`${icon} ${label.length > MAX_CALL_ARG_CHARS ? label.slice(0, MAX_CALL_ARG_CHARS) + "…" : label}`),
	);
	return new Text(text, 0, 0);
}

function formatSearchResults(results: SearchResult[], source: string): string {
	const lines = [`共 ${results.length} 条结果（来源：${source}）：`];
	results.forEach((r, i) => {
		const snippet = r.snippet.length > SNIPPET_MAX_CHARS ? `${r.snippet.slice(0, SNIPPET_MAX_CHARS)}…` : r.snippet;
		lines.push(`${i + 1}. ${r.title}`);
		lines.push(`   ${r.url}`);
		if (snippet) lines.push(`   ${snippet}`);
	});
	lines.push("", "需要深读某条结果时，用 web_fetch 抓取对应 URL 转为 markdown。");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	// reload / session 替换前清掉 TTL 定时器（旧 ctx 已失效，到期回调会抛 stale 错误）
	pi.on("session_shutdown", async () => clearStatusTimers());
	pi.registerTool({
		name: "web_search",
		label: "联网搜索",
		description:
			"搜索互联网（多源：bing.cn 主 + 360 备 + npm 垂类，零费用零 API key，无 AI 总结）。"
			+ "返回标题 + URL + 摘要列表；需要深读某条结果时用 web_fetch 抓取该 URL。"
			+ "查 npm 包用 source=\"npm\"。pypi 搜索页有反爬，查 Python 包请走默认网页搜索（如 site:pypi.org/project/）。",
		promptSnippet: "搜索互联网：web_search(查询词[, source]) → 标题+URL+摘要列表",
		renderCall: (args, theme) => {
			const query = typeof args?.query === "string" ? args.query.trim() : "";
			const source = args?.source && args.source !== "web" ? ` [${args.source}]` : "";
			return renderToolCall("🔍", query ? `${query}${source}` : undefined, theme, "web_search");
		},
		promptGuidelines: [
			"Use web_search to look up real-time or external information (GitHub issues, docs, news, prices) instead of guessing or relying on stale memory.",
			"Pass a concrete search query; if the first result set is unsatisfying, call web_search again with a refined query.",
			"web_search returns title + snippet only; use web_fetch to read a result URL in depth.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "搜索查询词（可含站点限定，如 site:github.com）" }),
			source: Type.Optional(
				Type.Union(
					[
						Type.Literal("web", { description: "通用网页搜索（bing.cn 主 + 360 备，自动降级）" }),
						Type.Literal("npm", { description: "npm 包搜索（npm registry JSON API）" }),
					],
					{ description: "搜索源类型，默认 web" },
				),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "web-search", text, ttlMs);
			push("🔍 搜索中", 30_000);
			onUpdate?.({ content: [{ type: "text", text: `正在搜索：${params.query}` }], details: { progress: 10 } });
			try {
					let results: SearchResult[];
					let src: string;
					if ((params.source ?? "web") === "npm") {
						results = await searchNpm(params.query);
						src = "npm";
					} else {
						const r = await searchWeb(params.query);
						results = r.results;
						src = r.source;
					}
				push(`🔍 ${results.length} 条`, 6_000);
				return {
					content: [{ type: "text", text: formatSearchResults(results, src) }],
					details: { results: results.length, source: src },
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

	pi.registerTool({
		name: "web_fetch",
		label: "抓取网页",
		description:
			"抓取网页 URL 并自动转换为 markdown（正文提取 + 去导航广告 + 截断，节约 tokens）。"
			+ "适合深读 web_search 找到的链接、官方文档、README。"
			+ "被墙/反爬站点（如 GitHub 直连）会失败，此时改用 web_search 查摘要。"
			+ `默认返回前 ${DEFAULT_MAX_CHARS} 字符，上限 ${MAX_CHARS_LIMIT} 字符。`,
		promptSnippet: "抓取网页转 markdown：web_fetch(URL[, maxChars]) → 正文",
		renderCall: (args, theme) =>
			renderToolCall("🌐", typeof args?.url === "string" ? args.url : undefined, theme, "web_fetch"),
		parameters: Type.Object({
			url: Type.String({ description: "要抓取的完整 URL（http/https）" }),
			maxChars: Type.Optional(
				Type.Integer({
					description: `返回 markdown 最大字符数，默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_CHARS_LIMIT}`,
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "web-fetch", text, ttlMs);
			push("🌐 抓取中", 30_000);
			onUpdate?.({ content: [{ type: "text", text: `正在抓取：${params.url}` }], details: { progress: 10 } });
			try {
				const maxChars = Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT);
				const { markdown, title, finalUrl, bytes, truncated } = await fetchAsMarkdown(params.url, maxChars, signal);
				push("🌐 完成", 6_000);
				const header: string[] = [];
				if (title) header.push(`标题: ${title}`);
				header.push(`源: ${finalUrl}`);
				header.push(`（HTML 约 ${(bytes / 1024).toFixed(0)} KB，正文 ${markdown.length} 字符${truncated ? "，已截断" : ""}）`);
				return {
					content: [{ type: "text", text: `${header.join("\n")}\n---\n${markdown}` }],
					details: { bytes, chars: markdown.length, truncated },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				push("🌐 失败", 6_000);
				return {
					content: [
						{
							type: "text",
							text: `抓取失败：${msg}\n提示：目标站点可能被墙或反爬；可改用 web_search 搜该页面关键词查摘要。`,
						},
					],
					details: { error: msg },
				};
			}
		},
	});
}
