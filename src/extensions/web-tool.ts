/**
 * web-tool: 联网搜索 + 网页抓取转 markdown（给 agent 用的 web_search / web_fetch 两个工具）
 *
 * 多源搜索，零 API key 零费用（彻底去除对 kimi-coding 的依赖）：
 * - 通用网页：cn.bing.com RSS + 360 搜索 HTML 双源并行，结果**逐条评分合并**：
 *   标题/URL/摘要按权重计分 + 完整查询短语命中强加成，跨源去重（URL 规范化 /
 *   标题归一化）后按分数降序取前 15 条——两个源的高质量条目都能入选，bing 泛化
 *   查询（地名+机构被吞长尾词）混入的低相关条目自然沉底；
 * - 垂类包：npm registry JSON API（source: "npm"）；pypi.org 搜索页有 Client
 *   Challenge 反爬（实测 curl 只回挑战页），不做垂类源，Python 包让 agent 走
 *   普通网页搜索查；
 * - bing 免费接口限流特征：连续请求后只回 1 条 item（实测 360 稳定、data-mdurl
 *   带真实 URL、res-desc 带摘要）；限流占位条目评分低，合并时自动被筛掉；
 * - 不依赖服务端 AI 总结：直接返回 标题+URL+摘要 列表由主 agent 自行判断，
 *   需要深读时用 web_fetch 抓取——成本从 kimi 时代每次 2 万+ token 降到 0。
 *
 * 差评降权（动态黑名单）：AI 发现低质量结果（内容与标题不符/灌水/死链）时调用
 * web_dislike 对域名记差评，持久化到 ~/.pi/agent/web-search-blacklist.json（跨会话）；
 * 搜索评分时按差评次数降权（×DECAY^count），累计到阈值直接滤除——无需维护域名白名单，
 * 降权对象由 AI 使用中自然沉淀。
 *
 * fetch：抓取 URL → @mixmark-io/domino 解析 DOM → 选正文容器（article/main/body）
 * → turndown(+gfm 表格) 转 markdown → 压缩空行/截断。turndown 与其依赖 domino、
 * turndown-plugin-gfm 由 build.js（esbuild）内联进单文件产物——build.js 的
 * external 白名单只保留 @earendil-works/* 与 typebox，产物仍是零外部依赖单文件。
 *
 * 抓不到的站点（GitHub 等被墙、反爬挑战页）如实报错，提示改用 web_search 查摘要。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
// @ts-ignore —— domino 自带 d.ts 模块名为 "domino"（与包名 @mixmark-io/domino 不一致），
// 类型层面 any 桥接；gfm 类型见 shared/turndown-gfm.d.ts；运行时 esbuild 按真实包名解析
import { createWindow as _createWindow } from "@mixmark-io/domino";
import { setStatusWithTTL, clearStatusTimers } from "./shared/status";
import { loadJsonConfig, saveJsonConfig } from "./shared/config";
import { renderInputWithCursor } from "./shared/ui";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import { execFile } from "node:child_process";

/** domino 的 createWindow（any 桥接，见上方 @ts-ignore 说明） */
const createWindow = _createWindow as (html?: string) => any;

// ---------------------------------------------------------------------------
// 可调配置（改这里后 node install.js 重装生效）
// ---------------------------------------------------------------------------

/** 浏览器标识池：常规浏览器变体（桌面 Chrome 默认；部分站点对不同标识的兼容性不同，被拒时轮换重试） */
const UA_POOL = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
] as const;

/** 按浏览器标识构建标准请求头（Accept / Accept-Language / Accept-Encoding 等常规字段） */
function browserHeaders(ua: string): Record<string, string> {
	return {
		"User-Agent": ua,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
		"Accept-Encoding": "gzip, deflate, br",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Upgrade-Insecure-Requests": "1",
	};
}

/** 按 HTTP 状态给出如实提示（告知 agent 换源或稍后再试，避免盲目重试） */
function httpStatusHint(status: number, retried: boolean): string {
	const reason: Record<number, string> = {
		401: "（站点要求身份验证，可能需登录）",
		403: "（站点拒绝本次访问——可能要求登录、地区限制或不同意程序化访问，建议改用 web_search 查摘要）",
		404: "（页面不存在，URL 可能已失效）",
		406: "（站点不接受当前请求特征）",
		429: "（请求过于频繁，建议稍后再试）",
	};
	return `HTTP ${status}${reason[status] ?? ""}${retried ? "，已换请求特征重试仍失败" : ""}`;
}

// ---------------------------------------------------------------------------
// 代理配置（被墙/网络不可达时自动经代理重试）
// ---------------------------------------------------------------------------

/** 统一响应类型（global fetch 与 Node http/https 代理路径的兼容层） */
interface FRes {
	ok: boolean;
	status: number;
	url: string;
	headers: { get(name: string): string | null };
	arrayBuffer(): Promise<ArrayBuffer | Uint8Array>;
}

/** web-tool 代理设置持久化文件（/web-tool-config 写入，reload 后恢复；不读环境变量） */
const PROXY_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "web-fetch-proxy.json");

/** 搜索结果差评（动态黑名单）持久化文件（web_dislike 写入，跨会话生效；/web-tool-config 面板查看，Delete 清空） */
const DISLIKE_FILE = path.join(os.homedir(), ".pi", "agent", "web-search-blacklist.json");

/** 差评数据结构：{ 域名: { count: 差评次数, reasons: 差评原因追踪 } } */
function isDislikeData(v: unknown): v is Record<string, { count: number; reasons: string[] }> {
	if (v === null || typeof v !== "object") return false;
	return Object.values(v as Record<string, unknown>).every((d) => {
		if (d === null || typeof d !== "object") return false;
		const o = d as { count?: unknown; reasons?: unknown };
		return typeof o.count === "number" && Array.isArray(o.reasons) && o.reasons.every((r) => typeof r === "string");
	});
}

/** 读取差评数据（文件缺失/损坏返回空表） */
function loadDislikeData(): Record<string, { count: number; reasons: string[] }> {
	return loadJsonConfig<Record<string, { count: number; reasons: string[] }>>(DISLIKE_FILE, {}, isDislikeData);
}

/** 保存差评数据 */
function saveDislikeData(data: Record<string, { count: number; reasons: string[] }>): void {
	saveJsonConfig(DISLIKE_FILE, data);
}

/** 从域名或结果 URL 提取差评键（去 www.；URL 则取 hostname） */
function dislikeKey(input: string): string {
	const s = input.trim();
	try {
		if (/^https?:\/\//i.test(s)) return new URL(s).hostname.replace(/^www\./i, "").toLowerCase();
	} catch { /* 非法 URL 按域名处理 */ }
	return s.replace(/^www\./i, "").toLowerCase().replace(/[\/?#].*$/, "");
}

/** 结果的 hostname（降权匹配用） */
function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

/** 差评降权系数：按 hostname 与差评域名的后缀匹配取最大差评次数（差评 blog.csdn.net 同样作用于
 *  sub.blog.csdn.net）；达到封禁阈值返回 0（滤除） */
function dislikePenalty(host: string, data: Record<string, { count: number; reasons: string[] }>): number {
	const key = host.replace(/^www\./i, "").toLowerCase();
	let maxCount = 0;
	for (const domain of Object.keys(data)) {
		if (key === domain || key.endsWith("." + domain)) maxCount = Math.max(maxCount, data[domain]!.count);
	}
	if (maxCount >= DISLIKE_BAN_THRESHOLD) return 0;
	return Math.pow(DISLIKE_DECAY, maxCount);
}

/** 代理配置校验：{ proxy?: string }（空串 = 未设置） */
function isProxyConfig(v: unknown): v is { proxy?: string } {
	return (
		v !== null &&
		typeof v === "object" &&
		((v as { proxy?: unknown }).proxy === undefined || typeof (v as { proxy?: unknown }).proxy === "string")
	);
}

/** 当前代理地址（/web-tool-config 设置，持久化到 PROXY_CONFIG_FILE；空/未设置 = 不走代理） */
function getProxyUrl(): string | undefined {
	const p = loadJsonConfig<{ proxy?: string }>(PROXY_CONFIG_FILE, {}, isProxyConfig).proxy?.trim();
	return p || undefined;
}

/** 保存/清除代理设置（空串 = 清除，恢复直连） */
function setProxySetting(value: string): void {
	saveJsonConfig(PROXY_CONFIG_FILE, { proxy: value.trim() });
}

/** 代理地址合法性：http:// 协议 + 非空主机（仅支持 HTTP 代理，Clash/V2Ray 等本地代理常见形态） */
function validateProxy(v: string): boolean {
	try {
		const u = new URL(v);
		return u.protocol === "http:" && u.hostname.length > 0;
	} catch {
		return false;
	}
}

/** 为 http/https.request 提供 createConnection：经 HTTP 代理建 CONNECT 隧道（TLS 目标再套 tls） */
function makeProxyConnection(
	targetUrl: string,
	proxyUrl: string,
): (opts: any, cb: (err: Error | null, socket?: any) => void) => undefined {
	const target = new URL(targetUrl);
	const proxy = new URL(proxyUrl);
	if (proxy.protocol !== "http:") throw new Error(`仅支持 http:// 代理，收到 ${proxy.protocol}//`);
	const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
	const proxyPort = Number(proxy.port || 80);
	return (_opts, cb) => {
		const socket = net.connect(proxyPort, proxy.hostname);
		const onError = (e: Error) => {
			socket.removeListener("data", onData);
			cb(e);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			socket.write(`CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n\r\n`);
		});
		let buf = "";
		const onData = (chunk: Buffer) => {
			buf += chunk.toString("latin1");
			const idx = buf.indexOf("\r\n\r\n");
			if (idx < 0) return;
			socket.removeListener("data", onData);
			socket.removeListener("error", onError);
			const head = buf.slice(0, idx);
			const m = /^HTTP\/\d+\.\d+\s+(\d+)/.exec(head);
			if (!m || Number(m[1]) !== 200) {
				socket.destroy();
				cb(new Error(`代理 CONNECT 失败：${m ? `HTTP ${m[1]}` : "响应无法解析"}`));
				return undefined;
			}
			if (target.protocol === "https:") {
				const tlsSocket = tls.connect({ socket, servername: target.hostname });
				tlsSocket.once("secureConnect", () => cb(null, tlsSocket));
				tlsSocket.once("error", (e) => {
					socket.removeListener("error", onError);
					cb(e);
				});
			} else {
				cb(null, socket);
			}
			return undefined;
		};
		socket.on("data", onData);
		return undefined;
	};
}

/** 判断失败是否属于“被墙/网络不可达”类，适合触发代理重试 */
function isWalledFailure(e: unknown, httpStatus?: number): boolean {
	if (httpStatus != null && httpStatus > 0) {
		if (httpStatus === 403 || httpStatus === 451 || httpStatus === 429 || httpStatus >= 500) return true;
	}
	if (e instanceof Error) {
		const name = e.name;
		const msg = e.message.toLowerCase();
		if (name === "AbortError" || name === "TimeoutError" || name === "TypeError") return true;
		if (
			msg.includes("fetch failed") ||
			msg.includes("getaddrinfo") ||
			msg.includes("econnrefused") ||
			msg.includes("econnreset") ||
			msg.includes("etimedout") ||
			msg.includes("enotfound") ||
			msg.includes("socket") ||
			msg.includes("timeout") ||
			msg.includes("network") ||
			msg.includes("blocked") ||
			msg.includes("reset") ||
			msg.includes("refused") ||
			msg.includes("unreachable")
		) return true;
	}
	return false;
}

/** 创建本地超时控制器，并监听外部取消信号 */
function makeTimeoutSignal(timeoutMs: number, outerSignal?: AbortSignal): { controller: AbortController; cleanup: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	outerSignal?.addEventListener("abort", onAbort);
	const cleanup = () => {
		clearTimeout(timer);
		outerSignal?.removeEventListener("abort", onAbort);
	};
	return { controller, cleanup };
}

/** 读取响应体为 Uint8Array（兼容 global fetch 的 ArrayBuffer 与 Node http/https 的 Buffer） */
async function resBytes(res: FRes): Promise<Uint8Array> {
	const raw = await res.arrayBuffer();
	return raw instanceof ArrayBuffer ? new Uint8Array(raw) : (raw as Uint8Array);
}

/** 直接 fetch（global fetch + 超时） */
async function directFetch(url: string, init: any, timeoutMs: number, outerSignal?: AbortSignal): Promise<FRes> {
	const { controller, cleanup } = makeTimeoutSignal(timeoutMs, outerSignal);
	try {
		return (await fetch(url, { ...init, signal: controller.signal })) as unknown as FRes;
	} finally {
		cleanup();
	}
}

/** 底层单次请求：Node http/https + createConnection（代理隧道），返回统一 FRes（响应体已解码 gzip/br/deflate） */
function nodeHttpRequest(
	targetUrl: string,
	headers: Record<string, string>,
	createConnection: (opts: any, cb: (err: Error | null, socket?: any) => void) => undefined,
	signal: AbortSignal,
): Promise<FRes> {
	return new Promise((resolve, reject) => {
		const mod = targetUrl.startsWith("https:") ? https : http;
		const req = mod.get(
			targetUrl,
			{ headers, createConnection, signal },
			(res) => {
				const status = res.statusCode ?? 0;
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const raw = Buffer.concat(chunks);
					const hs = res.headers as Record<string, string | string[] | undefined>;
					resolve({
						ok: status >= 200 && status < 300,
						status,
						url: targetUrl,
						headers: {
							get: (name: string) => {
								const v = hs[name.toLowerCase()];
								return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
							},
						},
						arrayBuffer: async () => {
							const enc = (hs["content-encoding"] ?? "").toString().toLowerCase();
							if (enc.includes("gzip")) return zlib.gunzipSync(raw);
							if (enc.includes("br")) return zlib.brotliDecompressSync(raw);
							if (enc.includes("deflate")) return zlib.inflateSync(raw);
							return raw;
						},
					});
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
}

/** 经代理 fetch（内置 CONNECT 隧道，跟随重定向 + 超时） */
async function proxyFetch(url: string, init: any, timeoutMs: number, outerSignal?: AbortSignal): Promise<FRes> {
	const proxyUrl = getProxyUrl();
	if (!proxyUrl) throw new Error("未配置代理");
	const { controller, cleanup } = makeTimeoutSignal(timeoutMs, outerSignal);
	try {
		// 跟随重定向（最多 5 跳），每跳重建 CONNECT 隧道
		let cur = url;
		for (let i = 0; i <= 5; i++) {
			const conn = makeProxyConnection(cur, proxyUrl);
			const res = await nodeHttpRequest(cur, init.headers ?? browserHeaders(UA_POOL[0]), conn, controller.signal);
			if (res.status >= 300 && res.status < 400) {
				const loc = res.headers.get("location");
				if (loc) {
					cur = new URL(loc, cur).href;
					continue;
				}
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res;
		}
		throw new Error("重定向次数过多");
	} finally {
		cleanup();
	}
}

/** 通用 fetch 包装：直接失败且被墙/网络不可达时，自动经代理重试一次 */
async function fetchWithRetry(url: string, init: any, timeoutMs: number, outerSignal?: AbortSignal): Promise<FRes> {
	const direct = await directFetch(url, init, timeoutMs, outerSignal).catch((e) => e as Error);
	if (!(direct instanceof Error)) return direct;
	const status = Number(/^HTTP (\d{3})/.exec(direct.message)?.[1] ?? 0);
	if (isWalledFailure(direct, status)) {
		const proxyUrl = getProxyUrl();
		if (proxyUrl) {
			const proxy = await proxyFetch(url, init, timeoutMs, outerSignal).catch((e) => e as Error);
			if (!(proxy instanceof Error)) return proxy;
			throw new Error(`直接访问失败，经代理 ${proxyUrl} 重试仍失败：${proxy.message}（原始错误：${direct.message}）`);
		}
	}
	throw direct;
}

/** 单次搜索返回给 agent 的结果条数上限（多源合并去重后取分数最高的这么多条） */
const MAX_RESULTS = 15;
/** 差评降权衰减系数：score × DISLIKE_DECAY^count（1 次 ×0.6，2 次 ×0.36，3 次 ×0.22…） */
const DISLIKE_DECAY = 0.6;
/** 差评累计达到该次数：直接滤除该域名条目（评分归 0，不再出现在结果中） */
const DISLIKE_BAN_THRESHOLD = 5;
/** 搜索单源超时（毫秒） */
const SEARCH_TIMEOUT_MS = 15_000;
/** 直连超时（毫秒）：被墙站点直连多为连接黑洞（挂到超时），短超时快速切降级；
 *  正常站 1-3s 足够，5s 已偏激进，误伤时 curl 兜底仍能拿到结果（降级不算失败） */
const DIRECT_TIMEOUT_MS = 5_000;
/** 降级超时（毫秒，curl/代理兜底的最后手段，给足时间但不放纵） */
const FALLBACK_TIMEOUT_MS = 12_000;
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
	/** 来源标识（bing/so360/npm），合并搜索结果时标注用 */
	src?: string;
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

/** 从 Content-Type 头或 HTML <meta> 提取字符编码（缺失/不识别 → utf-8），兼容 gbk/big5 等常见非 utf-8 站点 */
function detectCharset(bytes: Uint8Array, ctypeHeader: string): string {
	const norm = (cs: string): string => {
		const c = cs.trim().toLowerCase();
		if (/^gbk$|^gb2312$|^gb18030$/.test(c)) return "gb18030";
		if (/^big5/.test(c)) return "big5";
		return "utf-8";
	};
	const m = /charset\s*=\s*["']?([\w.-]+)/i.exec(ctypeHeader);
	if (m) return norm(m[1]);
	// HTML 前 4KB 找 <meta charset=...> / http-equiv Content-Type（用 ascii 解码找标签即可，乱码无碍）
	const head = new TextDecoder("ascii").decode(bytes.slice(0, 4096));
	const m2 = /<meta[^>]+charset\s*=\s*["']?\s*([\w.-]+)/i.exec(head);
	if (m2) return norm(m2[1]);
	return "utf-8";
}

/** 按检测出的字符编码解码响应体（避免非 utf-8 页面乱码） */
function decodeBody(bytes: Uint8Array, ctypeHeader: string): string {
	return new TextDecoder(detectCharset(bytes, ctypeHeader)).decode(bytes);
}

/** GET 文本（浏览器标准请求头 / 超时），非 2xx 抛错；直接失败且被墙/网络不可达时自动经代理重试 */
async function httpGet(url: string, timeoutMs: number): Promise<string> {
	const res = await fetchWithRetry(url, { headers: browserHeaders(UA_POOL[0]), redirect: "follow" }, timeoutMs);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const buf = await resBytes(res);
	return decodeBody(buf, res.headers.get("content-type") ?? "");
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
async function searchWeb(query: string): Promise<{ results: SearchResult[]; source: string }> {
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

/** 结果展示：按来源分组（组标题行 [bing]/[so360]），组内保持分数降序，序号全局连续；
 *  来源标注只在混合源需要区分时出现（组标题），单源不分组也无来源——省 token */
function formatSearchResults(results: SearchResult[], source: string): string {
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

// ---------------------------------------------------------------------------
// /web-tool-config 设置面板（代理地址输入）
// ---------------------------------------------------------------------------

/** 返回文本显示宽度达到 targetW 时的字符索引（输入框水平滚动窗口定位用） */
function charIndexAtWidth(text: string, targetW: number): number {
	let w = 0;
	for (let i = 0; i < text.length; i++) {
		const chW = visibleWidth(text[i]!);
		if (w + chW > targetW) return i;
		w += chW;
	}
	return text.length;
}

/** 从 startChar 起按显示宽度截取最多 maxW 宽的文本（不截断字符） */
function sliceByWidth(text: string, startChar: number, maxW: number): string {
	let out = "";
	let w = 0;
	for (let i = startChar; i < text.length; i++) {
		const chW = visibleWidth(text[i]!);
		if (w + chW > maxW) break;
		out += text[i];
		w += chW;
	}
	return out;
}

/**
 * /web-tool-config 设置面板：输入代理地址（Enter 保存 / Esc 取消 / 清空回车 = 清除代理）。
 * 手写输入框（与 ModelSelectOverlay 同款：水平滚动 + 光标反显），非法地址回车时不关闭面板、提示修改。
 */
class ProxyConfigOverlay {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private done: (result: string | null) => void;
	private value = "";
	private cursor = 0;
	private error = "";
	private statusMsg = ""; // 操作反馈（如「已删除差评：blog.csdn.net」）
	// 焦点模型：input = 代理输入框；dislike = 差评列表（↑↓ 选择、Delete 删除选中项）——Tab/方向键在两区自由切换
	private focus: "input" | "dislike" = "input";
	private selected = 0;

	constructor(tui: TUI, theme: Theme, current: string, done: (result: string | null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.value = current;
		this.cursor = current.length;
	}

	/** 差评键按次数降序（与面板显示一致，selected 索引基于此序） */
	private sortedDislikeKeys(data: Record<string, { count: number; reasons: string[] }>): string[] {
		return Object.keys(data).sort((a, b) => data[b]!.count - data[a]!.count);
	}

	handleInput(data: string): void {
		// Esc：任意焦点态都关闭面板
		if (matchesKey(data, "escape")) {
			this.done(null);
			return;
		}

		// ---- 差评列表焦点：↑↓ 选择（到顶/到底自然回输入框）、Enter/Tab 回输入框、Delete/Backspace 删除选中项 ----
		if (this.focus === "dislike") {
			const keys = this.sortedDislikeKeys(loadDislikeData());
			if (matchesKey(data, "up")) {
				if (this.selected === 0) {
					this.focus = "input"; // 顶部再按 ↑：自然出口
					this.tui.requestRender();
					return;
				}
				this.selected--;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				if (this.selected === keys.length - 1) {
					this.focus = "input"; // 底部再按 ↓：自然出口
					this.tui.requestRender();
					return;
				}
				this.selected++;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, "enter")) {
				this.focus = "input";
				this.tui.requestRender();
				return;
			}
			// d / Backspace：删除选中项（单条精细管理）
			if (data === "d" || data === "D" || matchesKey(data, "backspace")) {
				const key = keys[this.selected];
				if (key) {
					const d = loadDislikeData();
					delete d[key];
					saveDislikeData(d);
					this.statusMsg = `✅ 已删除差评：${key}`;
					this.selected = Math.max(0, Math.min(this.selected, keys.length - 2));
					if (!Object.keys(d).length) this.focus = "input"; // 删空了自动回输入框
					this.tui.requestRender();
				}
				return;
			}
			// Delete：清空全部差评（差评区焦点下的明确操作，不与输入框语义混淆）
			if (matchesKey(data, "delete")) {
				const d = loadDislikeData();
				const n = Object.keys(d).length;
				if (n) {
					saveDislikeData({});
					this.statusMsg = `✅ 已清空全部搜索差评（共 ${n} 个域名）`;
					this.focus = "input";
					this.tui.requestRender();
				}
				return;
			}
			return; // 列表焦点下其余按键忽略
		}

		// ---- 输入框焦点：Tab/方向键切到差评区；其余为代理编辑（Delete 无操作，避免与差评区语义混淆） ----
		if (matchesKey(data, "tab") || matchesKey(data, "up") || matchesKey(data, "down")) {
			if (Object.keys(loadDislikeData()).length) {
				this.focus = "dislike";
				this.selected = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "return")) {
			const v = this.value.trim();
			if (v && !validateProxy(v)) {
				this.error = `非法代理地址「${v}」，需 http://host:port 形式`;
				this.tui.requestRender();
				return;
			}
			this.done(v);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.cursor > 0) {
				this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor--;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "left")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.cursor = Math.min(this.value.length, this.cursor + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.cursor = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.cursor = this.value.length;
			this.tui.requestRender();
			return;
		}
		// 可打印字符：插入光标处
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
			this.cursor++;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const border = (s: string) => th.fg("border", s);
		const row = (content: string) => border("│") + truncateToWidth(content, innerW, "…", true) + border("│");
		const lines: string[] = [];

		const titleStr = ` ${th.fg("accent", "⚙️ web-tool 配置")} `;
		lines.push(border(`╭${titleStr}${"─".repeat(Math.max(0, innerW - visibleWidth(titleStr)))}╮`));

		// 搜索差评（拉黑管理，面板唯一入口）：↑↓/Tab 切换焦点、列表焦点下 Delete 删除选中项、输入框焦点下 Delete 清空全部；不显示 reason（那是给 AI 追踪的，人看只会添乱）
		const dislike = loadDislikeData();
		const dislikeKeys = this.sortedDislikeKeys(dislike);
		if (dislikeKeys.length) {
			lines.push(row(` ${th.fg("warning", "🔨 搜索差评")} ${th.fg("dim", `(${dislikeKeys.length} 个)`)}`));
			for (let i = 0; i < dislikeKeys.length; i++) {
				const k = dislikeKeys[i]!;
				const rec = dislike[k]!;
				const state =
					rec.count >= DISLIKE_BAN_THRESHOLD
						? th.fg("warning", "已滤除")
						: th.fg("dim", `降权×${Math.pow(DISLIKE_DECAY, rec.count).toFixed(2)}`);
				let text = `   ${k} ${th.fg("accent", `×${rec.count}`)} ${state}`;
				if (this.focus === "dislike" && i === this.selected) text = `\x1b[7m${text}\x1b[27m`; // 选中项反显
				lines.push(row(text));
			}
		} else {
			lines.push(row(` ${th.fg("dim", "🔨 搜索差评：无记录")}`));
		}
		if (this.statusMsg) lines.push(row(` ${th.fg("accent", this.statusMsg)}`));
		lines.push(border(`├${"─".repeat(innerW)}┤`)); // 差评区与代理输入区分隔

		// 输入框：水平滚动窗口跟随光标（❯ 前缀占 4 个显示宽度），不截断内容
		const inputW = Math.max(8, innerW - 3);
		const full = this.value;
		const totalW = visibleWidth(full);
		let startChar = 0;
		if (totalW > inputW) {
			const cursorW = visibleWidth(full.slice(0, this.cursor));
			startChar = charIndexAtWidth(full, Math.max(0, cursorW - Math.floor(inputW * 0.6)));
		}
		const windowText = sliceByWidth(full, startChar, inputW);
		const cursorInWindow = Math.min(Math.max(0, this.cursor - startChar), windowText.length);
		let inputDisplay = windowText;
		if (this.focus === "input") inputDisplay = renderInputWithCursor(inputDisplay, cursorInWindow); // 光标只在输入框焦点时显示
		lines.push(row(` ${th.fg("accent", "❯")} ${inputDisplay}`));

		// 错误提示或操作提示（按焦点态区分，只列按键动作不解释）
		if (this.error) {
			lines.push(row(th.fg("warning", ` ⚠ ${this.error}`)));
		} else if (this.focus === "dislike") {
			lines.push(row(th.fg("dim", ` ↑↓ 选择 · d 删除 · Del 清空 · Esc 取消`)));
		} else {
			lines.push(row(th.fg("dim", ` 回车保存 · 清空回车 = 清除代理 · Esc 取消`)));
		}

		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function (pi: ExtensionAPI) {
	// reload / session 替换前清掉 TTL 定时器（旧 ctx 已失效，到期回调会抛 stale 错误）
	pi.on("session_shutdown", async () => clearStatusTimers());
	pi.registerTool({
		name: "web_search",
		label: "联网搜索",
		description:
			"搜索互联网，返回标题 + URL + 摘要列表。需要深读某条结果时用 web_fetch 抓取该 URL。"
			+ "查 npm 包用 source=\"npm\"。Python 包请走默认网页搜索（如 site:pypi.org/project/）。"
			+ "发现低质量结果（内容与标题不符/灌水/死链）时，可调用 web_dislike 对其域名记差评，累计差评会降权该域名。",
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
						Type.Literal("web", { description: "通用网页搜索（bing + 360 双源合并，条目级评分排序）" }),
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
			+ "适合深读 web_search 找到的链接、官方文档、README。抓取失败时改用 web_search 查摘要。"
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

	// ---- web_dislike：搜索结果差评（动态黑名单，持久化降权） ----
	pi.registerTool({
		name: "web_dislike",
		label: "搜索差评",
		description:
			"给搜索结果中的低质量域名记差评（持久化到本地，跨会话生效）：累计差评会使该域名在后续搜索结果中降权"
			+ "（排名靠后，x0.6/次），差评累计 5 次直接滤除。用于深读某条结果后发现内容与标题不符/灌水/死链时，"
			+ "对其所在域名记差评。用 /web-tool-config 面板查看、Delete 键清空。",
		promptSnippet: "搜索差评：web_dislike(域名/URL[, reason]) → 累计差评降权该域名",
		renderCall: (args, theme) => {
			const domains = Array.isArray(args?.domains) ? (args.domains as string[]).slice(0, 3).join(", ") : "";
			return renderToolCall("👎", domains || undefined, theme, "web_dislike");
		},
		parameters: Type.Object({
			domains: Type.Array(Type.String({ description: "要差评的域名（如 blog.csdn.net）或结果 URL（自动提取域名）" })),
			reason: Type.Optional(Type.String({ description: "差评原因（如：内容与标题不符 / 灌水 / 死链），仅用于追踪" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const data = loadDislikeData();
			const added: Array<{ key: string; count: number }> = [];
			for (const d of params.domains ?? []) {
				const key = dislikeKey(d);
				if (!key) continue;
				const rec = data[key] ?? { count: 0, reasons: [] as string[] };
				rec.count++;
				if (params.reason && !rec.reasons.includes(params.reason)) rec.reasons.push(params.reason);
				data[key] = rec;
				added.push({ key, count: rec.count });
			}
			if (added.length) saveDislikeData(data);
			const detail = added.length
				? added.map((a) => `${a.key}×${a.count}`).join("、")
				: "没有有效的域名/URL";
			const hint =
				added.some((a) => a.count >= DISLIKE_BAN_THRESHOLD)
					? "；已达封禁阈值，该域名条目将被滤除"
					: added.length
						? "；后续搜索该域名将按次数降权（/web-tool-config 面板可查看）"
						: "";
			return {
				content: [{ type: "text", text: `已差评：${detail}${hint}` }],
				details: { disliked: added.map((a) => a.key), counts: Object.fromEntries(added.map((a) => [a.key, a.count])) },
			};
		},
	});

	// ---- /web-tool-config：配置 web_fetch/web_search 被墙自动重试的代理地址；搜索差评管理在面板内（Delete 清空） ----
	pi.registerCommand("web-tool-config", {
		description:
			"配置 web_fetch/web_search 被墙自动重试的代理：无参数打开设置面板输入 http:// 代理地址（面板内同时展示搜索差评列表，Delete 键清空）；`/web-tool-config <url>` 直接设置；`/web-tool-config off` 清除",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			// 带参数：直接设置 / 清除 / 查看
			if (arg) {
				if (arg === "off" || arg === "clear" || arg === "none") {
					setProxySetting("");
					ctx.ui.notify("已清除代理设置，web_fetch/web_search 恢复直连", "info");
					return;
				}
				if (arg === "show" || arg === "status" || arg === "?") {
					ctx.ui.notify(`当前代理：${getProxyUrl() ?? "未设置"}`, "info");
					return;
				}
				if (!validateProxy(arg)) {
					ctx.ui.notify(`非法代理地址「${arg}」，需 http://host:port 形式（如 http://127.0.0.1:7890）`, "warning");
					return;
				}
				setProxySetting(arg);
				ctx.ui.notify(`代理已设为 ${arg}（被墙时自动经此重试）`, "info");
				return;
			}

			// 无参数：打开设置面板（非 TUI 回落为文本提示）
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`当前代理：${getProxyUrl() ?? "未设置"}。用法：/web-tool-config（面板）、/web-tool-config <url> 直接设置、/web-tool-config off 清除`,
					"info",
				);
				return;
			}
			const result = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => new ProxyConfigOverlay(tui, theme, getProxyUrl() ?? "", done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "46%",
						minWidth: 44,
						maxHeight: "90%",
						margin: { right: 1 },
					},
				},
			);
			if (result === null) return; // 取消
			setProxySetting(result);
			ctx.ui.notify(result ? `代理已设为 ${result}（被墙时自动经此重试）` : "已清除代理设置，web_fetch/web_search 恢复直连", "info");
		},
	});
}
