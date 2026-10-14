/**
 * web-tool/fetch：抓取 + HTML → markdown（web-tool 多文件扩展的组成部分）
 *
 * 职责：
 * - 正文容器启发式（article/main/常见内容 class，文本足够多者优先，全无回退 body）
 * - domino 解析 DOM → turndown(+gfm) 转 markdown（turndown/domino/gfm 由 build.js 内联进产物）
 * - 双通道竞速：直连（含换 UA 重试）与降级（系统 curl 自动带代理 / 无 curl 退 Node CONNECT
 *   隧道）并行，谁先成功用谁；404 等确定性错误立即判死（任何传输方式结果相同）
 * - fetchAsMarkdown：校验协议 / 非 HTML 报错 / 字节上限 / 字符截断 / 正文极短提示
 *   成功率补救（不依赖外部服务）：GitHub blob URL 重写为 raw 直取（blob 页行号/按钮噪音大）；
 *   正文极短（JS 空壳判定）时用 Googlebot UA 重试一次——不少 SPA 只对搜索引擎爬虫做预渲染；
 *   仍极短且像未渲染的空壳时，用无头渲染兜一次（render-cdp.ts，零依赖 CDP）——
 *   渲染换来的结果只在新结果更长时才采用（可能渲染出 cookie 横幅/登录页）；渲染失败或
 *   机器上没有 Chromium 时静默回落，行为与以前一致；
 *   正文极短且命中 Cloudflare 等挑战特征时明确报「反爬验证页」（不误判为抓取成功，
 *   也不浪费一次渲染：挑战页要过 JS 校验，无头浏览器同样会被拦）。
 *   （Jina Reader 第三通道曾评估：2026-08 本机实测 r.jina.ai 直连与代理均不可达，放弃）
 *
 * 注意：本模块不注册任何 pi API，仅导出函数/常量，由入口（web_search/web_fetch 工具）驱动。
 */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
// @ts-ignore —— domino 自带 d.ts 模块名为 "domino"（与包名 @mixmark-io/domino 不一致），
// 类型层面 any 桥接；gfm 类型见 shared/turndown-gfm.d.ts；运行时 esbuild 按真实包名解析
import { createWindow as _createWindow } from "@mixmark-io/domino";
import { stripTags } from "./search";
import {
	FRes,
	UA_POOL,
	browserHeaders,
	directFetch,
	proxyFetch,
	getProxyUrl,
	isWalledFailure,
	resBytes,
	httpStatusHint,
	decodeBody,
	hasCurl,
	curlFetch,
} from "./http";
import { makeTimeoutSignal } from "../shared/net";
import { renderPage, rendererReady } from "./render-cdp";

/** domino 的 createWindow（any 桥接，见上方 @ts-ignore 说明） */
const createWindow = _createWindow as (html?: string) => any;

/** GitHub blob 页面重写为 raw 直取：blob HTML 页行号/按钮/面包屑噪音大，raw 是纯文本源码。
 *  （raw.githubusercontent.com 与 github.com 同网络栈，竞速/代理通道原样适用） */
function rewriteUrl(url: string): string {
	const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(url);
	if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
	return url;
}

/** Googlebot UA：JS 空壳页面（正文极短）的重试手段——不少 SPA 只对搜索引擎爬虫做预渲染/SSR */
const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

/** 反爬验证页特征（Cloudflare 等）：只在正文极短时才用作判定——正常文章也可能提及这些词，
 *  只扫首 8KB（挑战页的特征都在 <title>/<head> 附近） */
const ANTIBOT_MARKERS = ["just a moment", "/cdn-cgi/challenge-platform", "cf-chl-", "attention required! | cloudflare"];
function isAntibotPage(html: string): boolean {
	const head = html.slice(0, 8192).toLowerCase();
	return ANTIBOT_MARKERS.some((m) => head.includes(m));
}

/** 直连超时（毫秒）：被墙站点直连多为连接黑洞（挂到超时），短超时快速切降级；
 *  正常站 1-3s 足够，5s 已偏激进，误伤时 curl 兜底仍能拿到结果（降级不算失败） */
const DIRECT_TIMEOUT_MS = 5_000;
/** 降级超时（毫秒，curl/代理兜底的最后手段，给足时间但不放纵） */
const FALLBACK_TIMEOUT_MS = 12_000;
/** fetch 抓取 body 大小上限（超出截断，防超大页面撑爆内存） */
const FETCH_MAX_BYTES = 3 * 1024 * 1024;
/** fetch 返回 markdown 默认最大字符数 */
export const DEFAULT_MAX_CHARS = 12_000;
/** fetch 返回 markdown 硬上限（防撑爆上下文） */
export const MAX_CHARS_LIMIT = 60_000;

/** SPA 挂载点特征：命中且正文很薄，基本可判定为未渲染的空壳 */
const SHELL_MARKERS = [
	"__NEXT_DATA__", "window.__INITIAL_STATE__", "window.__NUXT__", "window.__APOLLO_STATE__",
	'id="root"', "id='root'", 'id="app"', "id='app'", "ng-version",
];

/** 是否值得付出一次无头渲染（冷启动约 0.85s，复用会话约 0.33s） */
export function looksLikeUnrenderedShell(html: string, markdown: string): boolean {
	const text = markdown.trim();
	if (text.length < 80) return true; // 空壳/被墙/纯 JS 页
	if (text.length < 400 && html.length > 20_000) return true; // HTML 很厚、正文很薄
	return text.length < 600 && SHELL_MARKERS.some((m) => html.includes(m));
}

/** 按行边界截断（太靠前的行边界就硬切），与字节截断共同维护 truncated 标记 */
function cutToLimit(text: string, limit: number): { text: string; cut: boolean } {
	if (text.length <= limit) return { text, cut: false };
	let cut = text.lastIndexOf("\n", limit);
	if (cut < limit * 0.7) cut = limit;
	return { text: text.slice(0, cut).trimEnd(), cut: true };
}

/** 抓取进度回调（目前只在启用渲染兜底时回报一次，由入口推状态行） */
export type FetchProgress = (text: string, ttlMs: number) => void;

// ---------------------------------------------------------------------------
// HTML → markdown
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

/** 多信号合并：任一 aborted 即整体 aborted（用户取消 + 内部竞速指断） */
function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
	const c = new AbortController();
	for (const s of signals) {
		if (!s) continue;
		if (s.aborted) {
			c.abort();
			break;
		}
		s.addEventListener("abort", () => c.abort(), { once: true });
	}
	return c.signal;
}

/** 决定性失败：资源级裁决（404/410 等非墙类 4xx），任何传输方式结果相同，竞速时无需等另一条 */
class DecisiveError extends Error {}

/** 非墙类 HTTP 错误 → DecisiveError；其余（墙类/网络类）保持普通错误 */
function decisiveIfHttp(e: Error): Error {
	const m = /^HTTP (\d{3})/.exec(e.message);
	return m && !isWalledFailure(e, Number(m[1])) ? new DecisiveError(e.message) : e;
}

/** 竞速：第一个成功 resolve（带来源索引）；决定性失败立即 reject；全部失败才 reject（聚合各错误） */
async function raceFirstSuccess<T>(promises: Promise<T>[]): Promise<{ index: number; value: T }> {
	return new Promise((resolve, reject) => {
		let settled = 0;
		const errors: Error[] = [];
		promises.forEach((p, i) => {
			p.then(
				(value) => resolve({ index: i, value }),
				(e) => {
					if (e instanceof DecisiveError) {
						reject(e);
						return;
					}
					settled++;
					errors.push(e instanceof Error ? e : new Error(String(e)));
					if (settled === promises.length) reject(new Error(errors.map((x) => x.message).join("；")));
				},
			);
		});
	});
}

/** 抓取页面：直连（含换 UA）与降级（curl 自动带代理 / 无 curl 退 Node CONNECT 隧道）**并行竞速**，
 *  谁先成功用谁、另一条立即指断——被墙站点 curl 秒回，不再傻等直连连接黑洞超时；
 *  404 等确定性错误立即判死（任何传输方式结果相同，不等另一条）。 */
async function fetchPageWithFallback(url: string, outerSignal?: AbortSignal): Promise<FRes> {
	const directAbort = new AbortController();
	const fallbackAbort = new AbortController();
	const sig = (s: AbortSignal) => mergeSignals(outerSignal, s);

	// 直连分支：默认 UA；HTTP 拒绝类换 UA 重试一次；失败 throw
	const directPath = (async (): Promise<FRes> => {
		const d0 = await directFetch(url, { headers: browserHeaders(UA_POOL[0]), redirect: "follow" }, DIRECT_TIMEOUT_MS, sig(directAbort.signal)).catch((e) => e as Error);
		if (!(d0 instanceof Error)) return d0;
		const s0 = Number(/^HTTP (\d{3})/.exec(d0.message)?.[1] ?? 0);
		if (s0 >= 500 || s0 === 403 || s0 === 406 || s0 === 429) {
			const d1 = await directFetch(url, { headers: browserHeaders(UA_POOL[1] ?? UA_POOL[0]), redirect: "follow" }, DIRECT_TIMEOUT_MS, sig(directAbort.signal)).catch((e) => e as Error);
			if (!(d1 instanceof Error)) return d1;
			const s1 = Number(/^HTTP (\d{3})/.exec(d1.message)?.[1] ?? 0);
			if (!isWalledFailure(d1, s1)) throw new DecisiveError(httpStatusHint(s1, true));
		} else if (!isWalledFailure(d0, s0)) {
			throw new DecisiveError(d0.message); // 404 等确定性错误：不等另一条
		}
		throw d0;
	})();

	// 降级分支：curl 一步到位（自动带代理）；无 curl 退 Node CONNECT 隧道；两者皆无 throw
	const fallbackPath = (async (): Promise<FRes> => {
		const proxyUrl = getProxyUrl();
		try {
			if (await hasCurl()) return await curlFetch(url, FALLBACK_TIMEOUT_MS, FETCH_MAX_BYTES, sig(fallbackAbort.signal));
			if (proxyUrl) return await proxyFetch(url, { headers: browserHeaders(UA_POOL[0]), redirect: "follow" }, FALLBACK_TIMEOUT_MS, sig(fallbackAbort.signal));
			throw new Error("未配置代理且系统无 curl");
		} catch (e) {
			throw decisiveIfHttp(e instanceof Error ? e : new Error(String(e)));
		}
	})();

	// 任何结局（成功 / DecisiveError 判死 / 全部失败）都掐断两条分支的在途请求，
	// 避免幽灵连接与超时定时器残留（abort 已完成的分支是无害 no-op）
	try {
		const { value } = await raceFirstSuccess([directPath, fallbackPath]);
		return value;
	} finally {
		directAbort.abort();
		fallbackAbort.abort();
	}
}

/** 抓取 URL → markdown（校验协议 / 非 HTML 报错 / 字节上限 / 字符截断） */
export async function fetchAsMarkdown(
	url: string,
	maxChars: number,
	signal?: AbortSignal,
	onProgress?: FetchProgress,
): Promise<{
	markdown: string;
	title: string;
	finalUrl: string;
	bytes: number;
	truncated: boolean;
	/** 本次正文是否来自无头渲染（true 时正文可能含登录页/横幅，已按长度比对筛过） */
	rendered: boolean;
	/** 渲染说明（供回执展示，如「持久化 profile，840ms」），未渲染时为空串 */
	renderNote: string;
}> {
	let u: URL;
	try {
		u = new URL(rewriteUrl(url));
	} catch {
		throw new Error(`无效 URL：${url}`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error(`仅支持 http/https URL，收到 ${u.protocol}//`);
	}
	let res: FRes;
	try {
		res = await fetchPageWithFallback(u.href, signal);
	} catch (e) {
		throw new Error(e instanceof Error ? e.message : String(e));
	}
	const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
	if (ctype && !ctype.includes("html") && !ctype.includes("text/") && !ctype.includes("xml")) {
		throw new Error(`非 HTML 内容（${ctype}），无法转 markdown`);
	}
	const buf = await resBytes(res);
	const bytes = Math.min(buf.byteLength, FETCH_MAX_BYTES);
	const html = decodeBody(buf.subarray(0, bytes), res.headers.get("content-type") ?? "");
	// text/plain（如 GitHub raw 直取的源码）不能走 HTML→markdown：源码里的 <...> 会被当标签吞掉，原文直出
	const isPlainText = ctype.includes("text/plain");
	let { markdown, title } = isPlainText
		? { markdown: html, title: u.pathname.split("/").pop() ?? "" }
		: htmlToMarkdown(html, u.href);
	let out = markdown;
	let truncated = bytes < buf.byteLength; // 字节被截断
	const clipped = cutToLimit(out, maxChars);
	out = clipped.text;
	truncated = truncated || clipped.cut;
	// 正文极短：先判反爬验证页（Cloudflare 等——不是抓取成功，也无重试价值）；
	// 再按 JS 空壳处理：用 Googlebot UA 重试一次（不少 SPA 只对搜索引擎爬虫预渲染）；
	// 仍极短才如实提示，避免误判为抓取成功
	if (out.trim().length < 80 && isAntibotPage(html)) {
		throw new Error(
			"目标站点返回反爬验证页（Cloudflare 等），零依赖抓取无法绕过：可换源搜索同类内容，" +
				"或对需要登录的站点用 /web-render-login 登录后重试",
		);
	}
	if (out.trim().length < 80) {
		const retry = await directFetch(
			u.href,
			{ headers: browserHeaders(GOOGLEBOT_UA), redirect: "follow" },
			DIRECT_TIMEOUT_MS,
			signal,
		).catch(() => null);
		if (retry && !(retry instanceof Error) && !isPlainText) {
			const rbuf = await resBytes(retry);
			const rhtml = decodeBody(rbuf.subarray(0, Math.min(rbuf.byteLength, FETCH_MAX_BYTES)), retry.headers.get("content-type") ?? "");
			const rmd = htmlToMarkdown(rhtml, u.href);
			if (rmd.markdown.trim().length > out.trim().length) {
				out = rmd.markdown;
				const rc = cutToLimit(out, maxChars);
				out = rc.text;
				truncated = truncated || rc.cut;
			}
		}
	}

	// 正文仍极短且像未渲染的空壳：用无头浏览器渲染一次。
	// 这是最后一道兜底，任何失败（无 Chromium、启动超时、页面被拦）都静默回落。
	let rendered = false;
	let renderNote = "";
	if (!isPlainText && out.trim().length < 80 && looksLikeUnrenderedShell(html, out) && rendererReady()) {
		onProgress?.("🖥 渲染中", 30_000);
		try {
			const r = await renderPage(u.href, { timeoutMs: 15_000, quietMs: 800, proxyUrl: getProxyUrl() });
			const rmd = htmlToMarkdown(r.html, r.finalUrl);
			// 只在新结果更长时才替换：渲染可能换来 cookie 横幅或登录页，别把好结果换坏
			if (rmd.markdown.trim().length > out.trim().length) {
				out = rmd.markdown;
				const rc = cutToLimit(out, maxChars);
				out = rc.text;
				truncated = truncated || rc.cut;
				rendered = true;
				renderNote = `${r.persistent ? "持久化" : "临时"} profile，${r.ms}ms`;
				if (title.trim().length < 2) title = rmd.title;
			}
		} catch {
			/* 渲染不可用不是抓取失败：按原逻辑走短正文提示 */
		}
	}
	if (out.trim().length < 80) {
		out += rendered
			? "\n\n> ⚠️ 已用浏览器渲染，正文仍极短——可能需登录或页面已失效。"
			: "\n\n> ⚠️ 页面正文极短——可能需登录、JS 渲染或页面已失效，内容可信度有限。";
	}
	return { markdown: out, title, finalUrl: res.url || u.href, bytes: buf.byteLength, truncated, rendered, renderNote };
}
