/**
 * web-tool/fetch：抓取 + HTML → markdown（web-tool 多文件扩展的组成部分）
 *
 * 职责：
 * - 正文容器启发式（article/main/常见内容 class，文本足够多者优先，全无回退 body）
 * - domino 解析 DOM → turndown(+gfm) 转 markdown（turndown/domino/gfm 由 build.js 内联进产物）
 * - 双通道竞速：直连（含换 UA 重试）与降级（系统 curl 自动带代理 / 无 curl 退 Node CONNECT
 *   隧道）并行，谁先成功用谁；404 等确定性错误立即判死（任何传输方式结果相同）
 * - fetchAsMarkdown：校验协议 / 非 HTML 报错 / 字节上限 / 字符截断 / 正文极短提示
 *
 * 注意：本模块不注册任何 pi API，仅导出函数/常量，由入口（web_search/web_fetch 工具）驱动。
 */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
// @ts-ignore —— domino 自带 d.ts 模块名为 "domino"（与包名 @mixmark-io/domino 不一致），
// 类型层面 any 桥接；gfm 类型见 shared/turndown-gfm.d.ts；运行时 esbuild 按真实包名解析
import { createWindow as _createWindow } from "@mixmark-io/domino";
import { execFile } from "node:child_process";
import { stripTags } from "./search";
import {
	FRes,
	UA_POOL,
	browserHeaders,
	directFetch,
	proxyFetch,
	getProxyUrl,
	isWalledFailure,
	makeTimeoutSignal,
	resBytes,
	httpStatusHint,
	decodeBody,
} from "./http";

/** domino 的 createWindow（any 桥接，见上方 @ts-ignore 说明） */
const createWindow = _createWindow as (html?: string) => any;

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

/** 系统 curl 是否可用（Windows 10+ / macOS / 多数 Linux 自带；探测结果缓存） */
let curlAvailable: boolean | undefined;
function hasCurl(): Promise<boolean> {
	if (curlAvailable !== undefined) return Promise.resolve(curlAvailable);
	return new Promise((resolve) => {
		execFile("curl", ["--version"], { timeout: 5000, windowsHide: true }, (err) => {
			curlAvailable = !err;
			resolve(curlAvailable);
		});
	});
}

/**
 * 用系统 curl 抓取：-f 非 2xx 报错、-L 跟随重定向（≤10 跳）、超时；有代理则走代理；
 * 输出原始字节交 charset 检测解码。curl 的 TLS 指纹（Windows schannel / 可响应 renegotiation）
 * 与 Node OpenSSL 不同，可绕过 GitHub 等站点对 Node TLS 指纹的 301 挑战循环。
 */
async function curlFetch(url: string, timeoutMs: number, outerSignal?: AbortSignal): Promise<FRes> {
	const args = [
		"-sS", "-f", "-L", "--max-redirs", "10",
		"--max-time", String(Math.max(5, Math.ceil(timeoutMs / 1000))),
		"--connect-timeout", "5",
		"-A", UA_POOL[0],
		"-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	];
	const proxy = getProxyUrl();
	if (proxy) args.push("-x", proxy);
	args.push("--", url); // -- 防止 URL 以 - 开头被当作选项
	const buf = await new Promise<Buffer>((resolve, reject) => {
		execFile(
			"curl",
			args,
			{
				timeout: timeoutMs + 3000,
				maxBuffer: FETCH_MAX_BYTES + 1024 * 1024,
				windowsHide: true,
				encoding: "buffer",
				signal: outerSignal,
			},
			(err, stdout, stderr) => {
				if (err) {
					// curl -f：HTTP 错误退出码 22，详情在 stderr（"The requested URL returned error: 4xx/5xx"）
					const errText = stderr instanceof Buffer ? stderr.toString("utf8") : String(stderr ?? "");
					const m = /returned error: (\d{3})/.exec(errText);
					if (m) {
						reject(new Error(`HTTP ${m[1]}`));
						return;
					}
					reject(new Error(errText.trim() || err.message));
					return;
				}
				resolve(stdout as Buffer);
			},
		);
	});
	return {
		ok: true,
		status: 200,
		url,
		headers: { get: () => null }, // 无 content-type 头，charset 由调用方从 HTML <meta> 探测
		arrayBuffer: async () => buf,
	};
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
			if (await hasCurl()) return await curlFetch(url, FALLBACK_TIMEOUT_MS, sig(fallbackAbort.signal));
			if (proxyUrl) return await proxyFetch(url, { headers: browserHeaders(UA_POOL[0]), redirect: "follow" }, FALLBACK_TIMEOUT_MS, sig(fallbackAbort.signal));
			throw new Error("未配置代理且系统无 curl");
		} catch (e) {
			throw decisiveIfHttp(e instanceof Error ? e : new Error(String(e)));
		}
	})();

	const { index, value } = await raceFirstSuccess([directPath, fallbackPath]);
	// 已有一条成功：掐掉另一条在途请求，避免幽灵连接/定时器残留
	if (index === 0) fallbackAbort.abort();
	else directAbort.abort();
	return value;
}

/** 抓取 URL → markdown（校验协议 / 非 HTML 报错 / 字节上限 / 字符截断） */
export async function fetchAsMarkdown(
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
	let res: FRes;
	try {
		res = await fetchPageWithFallback(u.href, signal);
	} catch (e) {
		throw new Error(e instanceof Error ? e.message : String(e));
	}
	const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
	if (ctype && !ctype.includes("html") && !ctype.includes("text/") && !ctype.includes("xml")) {
		throw new Error(`非 HTML 内容（${ctype}），无法转 markdown；请改用 web_search 查摘要`);
	}
	const buf = await resBytes(res);
	const bytes = Math.min(buf.byteLength, FETCH_MAX_BYTES);
	const html = decodeBody(buf.subarray(0, bytes), res.headers.get("content-type") ?? "");
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
	// 正文极短：可能是需登录 / JS 渲染 / 空壳页面，如实提示避免误判为抓取成功
	if (out.trim().length < 80) {
		out += "\n\n> ⚠️ 页面正文极短——可能需登录、JS 渲染或页面已失效，内容可信度有限，建议用 web_search 核对。";
	}
	return { markdown: out, title, finalUrl: res.url || u.href, bytes: buf.byteLength, truncated };
}
