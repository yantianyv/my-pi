/**
 * web-tool/http：HTTP 网络层（web-tool 多文件扩展的组成部分，仅被本目录模块 import）
 *
 * 职责：
 * - 浏览器标识池 + 标准请求头 + HTTP 状态如实提示（换 UA 重试 / 告知换源）
 * - 代理配置（/web-tool-config 写入，持久化到 ~/.pi/agent/web-fetch-proxy.json，reload 后恢复）
 * - 双路径 fetch：global fetch 直连 + Node http/https 经 HTTP 代理建 CONNECT 隧道
 *   （被墙/网络不可达时自动经代理重试一次）；统一 FRes 响应类型（含 gzip/br/deflate 解码）
 * - 字符编码探测与解码（兼容 gbk/big5 等常见非 utf-8 站点）
 * - httpGet：GET 文本（浏览器标准请求头），供搜索源使用
 *
 * 注意：本模块不注册任何 pi API，仅导出纯函数/常量，由本目录其它模块与入口驱动。
 */
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";

// ---------------------------------------------------------------------------
// 可调配置（改这里后 node install.js 重装生效）
// ---------------------------------------------------------------------------

/** 浏览器标识池：常规浏览器变体（桌面 Chrome 默认；部分站点对不同标识的兼容性不同，被拒时轮换重试） */
export const UA_POOL = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
] as const;

/** 按浏览器标识构建标准请求头（Accept / Accept-Language / Accept-Encoding 等常规字段） */
export function browserHeaders(ua: string): Record<string, string> {
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
export function httpStatusHint(status: number, retried: boolean): string {
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
export interface FRes {
	ok: boolean;
	status: number;
	url: string;
	headers: { get(name: string): string | null };
	arrayBuffer(): Promise<ArrayBuffer | Uint8Array>;
}

/** web-tool 代理设置持久化文件（/web-tool-config 写入，reload 后恢复；不读环境变量） */
const PROXY_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "web-fetch-proxy.json");

/** 代理配置校验：{ proxy?: string }（空串 = 未设置） */
function isProxyConfig(v: unknown): v is { proxy?: string } {
	return (
		v !== null &&
		typeof v === "object" &&
		((v as { proxy?: unknown }).proxy === undefined || typeof (v as { proxy?: unknown }).proxy === "string")
	);
}

/** 当前代理地址（/web-tool-config 设置，持久化到 PROXY_CONFIG_FILE；空/未设置 = 不走代理） */
export function getProxyUrl(): string | undefined {
	const p = loadJsonConfig<{ proxy?: string }>(PROXY_CONFIG_FILE, {}, isProxyConfig).proxy?.trim();
	return p || undefined;
}

/** 保存/清除代理设置（空串 = 清除，恢复直连） */
export function setProxySetting(value: string): void {
	saveJsonConfig(PROXY_CONFIG_FILE, { proxy: value.trim() });
}

/** 代理地址合法性：http:// 协议 + 非空主机（仅支持 HTTP 代理，Clash/V2Ray 等本地代理常见形态） */
export function validateProxy(v: string): boolean {
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
export function isWalledFailure(e: unknown, httpStatus?: number): boolean {
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
export function makeTimeoutSignal(timeoutMs: number, outerSignal?: AbortSignal): { controller: AbortController; cleanup: () => void } {
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
export async function resBytes(res: FRes): Promise<Uint8Array> {
	const raw = await res.arrayBuffer();
	return raw instanceof ArrayBuffer ? new Uint8Array(raw) : (raw as Uint8Array);
}

/** 直接 fetch（global fetch + 超时） */
export async function directFetch(url: string, init: any, timeoutMs: number, outerSignal?: AbortSignal): Promise<FRes> {
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
export async function proxyFetch(url: string, init: any, timeoutMs: number, outerSignal?: AbortSignal): Promise<FRes> {
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
export async function fetchWithRetry(url: string, init: any, timeoutMs: number, outerSignal?: AbortSignal): Promise<FRes> {
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

/** 搜索单源超时（毫秒） */
export const SEARCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// 字符编码探测与解码（httpGet 与 fetch 共用；GBK/Big5 等常见非 utf-8 站点）
// ---------------------------------------------------------------------------

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
export function decodeBody(bytes: Uint8Array, ctypeHeader: string): string {
	return new TextDecoder(detectCharset(bytes, ctypeHeader)).decode(bytes);
}

/** GET 文本（浏览器标准请求头 / 超时），非 2xx 抛错；直接失败且被墙/网络不可达时自动经代理重试 */
export async function httpGet(url: string, timeoutMs: number): Promise<string> {
	const res = await fetchWithRetry(url, { headers: browserHeaders(UA_POOL[0]), redirect: "follow" }, timeoutMs);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const buf = await resBytes(res);
	return decodeBody(buf, res.headers.get("content-type") ?? "");
}
