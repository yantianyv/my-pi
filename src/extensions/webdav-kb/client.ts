/**
 * webdav-kb / client.ts — 零依赖 WebDAV 客户端（纯传输层）
 *
 * 只负责与 WebDAV 服务器的 HTTP 交互（列目录/下载/上传/建目录/删除/移动），
 * 不做缓存、索引、加密等业务逻辑——上层（sync/search/crypto）各司其职。
 * 基于 Node 全局 fetch + 正则解析 multistatus XML（不引入任何 XML 库，产物零外部依赖）。
 *
 * 设计要点：
 * - 路径约定：所有对外方法接受「相对 base 的路径」——"/" 表示根目录，其余以 "/" 开头、
 *   不带尾斜杠（如 "/notes/a.md"）。服务器返回的 href（通常带 base 前缀，如 "/dav/notes/a.md"）
 *   会剥离 base 前缀统一成相对路径，上层（sync/search）无需感知 baseUrl 长什么样。
 * - PROPFIND 用 Depth 0/1（单文件 stat / 单目录 list），递归遍历整树由 sync 层自己驱动——
 *   不依赖服务器的 Depth: infinity 支持（各家实现差异大，国产盘经常不支持或返回异常）。
 * - 认证：Basic（base64(user:password)），覆盖绝大多数 WebDAV 服务（含 123 云盘）。
 * - 重试：网络错误 / 5xx / 429 自动重试（指数退避，默认 2 次）；4xx（除 429）不重试直接抛错。
 * - 代理：可选 HTTP 代理（CONNECT 隧道，复用 shared/net 的 makeProxyConnection）——
 *   直连失败且判定为网络不可达时经代理重试一次；未配置代理则纯直连。
 * - 错误：统一抛 DavError（含 HTTP status / method / path），调用方按 status 分类处理。
 * - 时间：lastModified 保留服务器原文（HTTP date 串），比较由 sync 层做（优先 etag）。
 */
import * as http from "node:http";
import * as https from "node:https";
import { makeProxyConnection, makeTimeoutSignal } from "../shared/net";

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';
const PROPFIND_BODY = `${XML_HEADER}<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>`;
/** PROPFIND 响应体大小上限（防超大目录响应撑爆内存） */
const PROPFIND_MAX_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface DavFile {
	/** 相对 base 的路径（服务器 href 剥离 base 前缀）："/" 表示根目录 */
	path: string;
	isDir: boolean;
	/** 服务端 etag（已去引号）；目录通常无 etag */
	etag?: string;
	/** 最后修改时间（HTTP date 原文，如 "Fri, 01 Jan 2024 00:00:00 GMT"） */
	lastModified?: string;
	/** 字节数（目录无） */
	size?: number;
}

export interface DavPutResult {
	/** 写入后服务端返回的新 etag（部分服务器不回，此时 undefined） */
	etag?: string;
}

export interface DavClientOptions {
	/** 单请求超时（毫秒），默认 30_000；get/put 可单独传更大的值 */
	timeoutMs?: number;
	/** 网络错误/5xx/429 的重试次数，默认 2 */
	retries?: number;
	/** HTTP 代理地址（如 http://127.0.0.1:7890），未配置则纯直连 */
	proxyUrl?: string;
}

/** WebDAV 操作失败（含 HTTP status；网络层失败 status 为 undefined） */
export class DavError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly method?: string,
		readonly path?: string,
	) {
		super(message);
		this.name = "DavError";
	}
}

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

/** 相对路径归一化：保证以 "/" 开头、无尾斜杠（根为 "/"） */
function normalizePath(p: string): string {
	if (!p) return "/";
	let s = p.trim();
	if (!s.startsWith("/")) s = "/" + s;
	while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
	return s;
}

/** 相对路径 → URL pathname：逐段 encodeURIComponent（保留 "/" 分隔，兼容中文/空格） */
function encodePath(p: string): string {
	return p.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/** 解码服务器 href 的 pathname（%xx → 原文 + XML 实体还原；失败时原样返回） */
function decodeHref(p: string): string {
	let s = p;
	try {
		s = decodeURIComponent(s);
	} catch {
		/* 非法 %xx 保持原样 */
	}
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

/** etag 去引号（部分服务器带引号，部分不带） */
function stripQuotes(etag: string): string {
	const m = /^"([\s\S]*)"$/.exec(etag);
	return m ? m[1] : etag;
}

/** 判断失败是否属「网络不可达」类（触发代理重试），与 web-tool.isWalledFailure 同逻辑 */
function isNetworkFailure(e: unknown, status?: number): boolean {
	if (status != null && (status === 429 || status >= 500)) return true;
	if (e instanceof Error) {
		const name = e.name;
		const msg = e.message.toLowerCase();
		if (name === "AbortError" || name === "TimeoutError" || name === "TypeError") return true;
		return (
			msg.includes("fetch failed") ||
			msg.includes("getaddrinfo") ||
			msg.includes("econnrefused") ||
			msg.includes("econnreset") ||
			msg.includes("etimedout") ||
			msg.includes("enotfound") ||
			msg.includes("socket") ||
			msg.includes("timeout") ||
			msg.includes("network") ||
			msg.includes("reset") ||
			msg.includes("refused")
		);
	}
	return false;
}


/** 经代理发任意方法请求（CONNECT 隧道 + 完整 body 收发），返回统一响应 */
function proxyRequest(
	fullUrl: string,
	method: string,
	headers: Record<string, string>,
	body: Uint8Array | undefined,
	signal: AbortSignal,
	proxyUrl: string,
): Promise<{ status: number; getHeader(name: string): string | null; body: Uint8Array; arrayBuffer(): Promise<Uint8Array> }> {
	return new Promise<{ status: number; getHeader(name: string): string | null; body: Uint8Array; arrayBuffer(): Promise<Uint8Array> }>(
		(resolve, reject) => {
		const target = new URL(fullUrl);
		const mod = target.protocol === "https:" ? https : http;
		const conn = makeProxyConnection(fullUrl, proxyUrl);
		const req = mod.request(
			fullUrl,
			{ method, headers, createConnection: conn, signal },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const hs = res.headers as Record<string, string | string[] | undefined>;
					const body = new Uint8Array(Buffer.concat(chunks));
					resolve({
						status: res.statusCode ?? 0,
						getHeader: (name: string) => {
							const v = hs[name.toLowerCase()];
							return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
						},
						body,
						arrayBuffer: async () => body,
					});
				});
			},
		);
		req.on("error", reject);
		if (body) req.write(Buffer.from(body));
		req.end();
	});
}

/** 一次「直连或经代理」的请求尝试（不重试），统一返回 fetch 风格响应 */
async function attempt(
	fullUrl: string,
	method: string,
	headers: Record<string, string>,
	body: Uint8Array | undefined,
	timeoutMs: number,
	outer: AbortSignal | undefined,
	proxyUrl?: string,
): Promise<{ status: number; getHeader(name: string): string | null; arrayBuffer(): Promise<Uint8Array> }> {
	const { controller, cleanup } = makeTimeoutSignal(timeoutMs, outer);
	try {
		if (proxyUrl) {
			return await proxyRequest(fullUrl, method, headers, body, controller.signal, proxyUrl);
		}
		const res = await fetch(fullUrl, { method, headers, body: body as BodyInit, signal: controller.signal });
		return {
			status: res.status,
			getHeader: (name: string) => res.headers.get(name),
			arrayBuffer: async () => new Uint8Array(await res.arrayBuffer()),
		};
	} finally {
		cleanup();
	}
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class WebDavClient {
	private readonly base: URL;
	/** base 的 pathname（"" 或 "/dav" 这类前缀，无尾斜杠） */
	private readonly basePath: string;
	private readonly auth: string;
	private readonly timeoutMs: number;
	private readonly retries: number;
	private readonly proxyUrl?: string;

	constructor(
		baseUrl: string,
		username: string,
		password: string,
		opts: DavClientOptions = {},
	) {
		const u = new URL(baseUrl);
		// 去掉尾斜杠，统一由 urlFor 拼接
		let pathname = u.pathname;
		while (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
		u.pathname = pathname;
		this.base = u;
		this.basePath = pathname === "/" ? "" : pathname;
		this.auth = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.retries = opts.retries ?? 2;
		this.proxyUrl = opts.proxyUrl?.trim() || undefined;
	}

	/** 相对路径 → 完整 URL（逐段编码） */
	urlFor(path: string): string {
		const rel = normalizePath(path);
		return rel === "/"
			? this.base.href.replace(/\/$/, "") + "/"
			: this.base.href + encodePath(rel);
	}

	/** 服务器 href（可能带 base 前缀、尾斜杠）→ 相对路径 */
	private toRelative(serverPath: string): string {
		let p = decodeHref(serverPath);
		while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
		if (!p.startsWith("/")) p = "/" + p;
		if (this.basePath) {
			if (p === this.basePath) return "/";
			if (p.startsWith(this.basePath + "/")) return p.slice(this.basePath.length);
		}
		return p || "/";
	}

	/** 核心请求：重试循环（网络错误/5xx/429 指数退避；4xx 除 429 直接抛 DavError） */
	private async request(
		method: string,
		path: string,
		opts: { body?: Uint8Array | string; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<{ status: number; getHeader(name: string): string | null; arrayBuffer(): Promise<Uint8Array> }> {
		const fullUrl = this.urlFor(path);
		const body = typeof opts.body === "string" ? new TextEncoder().encode(opts.body) : opts.body;
		const headers: Record<string, string> = {
			Authorization: this.auth,
			...(opts.headers ?? {}),
		};
		const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
		const signal = opts.signal;
		let lastErr: unknown;
		for (let attemptNo = 0; attemptNo <= this.retries; attemptNo++) {
			// 直连
			let direct: { status: number; getHeader(name: string): string | null; arrayBuffer(): Promise<Uint8Array> } | Error | undefined;
			try {
				direct = await attempt(fullUrl, method, headers, body, timeoutMs, signal, undefined);
			} catch (e) {
				direct = e as Error;
			}
			if (!(direct instanceof Error)) return direct;
			const status = Number(/^HTTP (\d{3})/.exec(direct.message)?.[1] ?? 0);
			lastErr = direct;
			// 网络不可达且配了代理 → 经代理再试一次（同一次重试预算内）
			if (this.proxyUrl && isNetworkFailure(direct, status)) {
				try {
					const proxied = await attempt(fullUrl, method, headers, body, timeoutMs, signal, this.proxyUrl);
					return proxied;
				} catch (e) {
					lastErr = new Error(`直连失败且经代理 ${this.proxyUrl} 重试仍失败：${e instanceof Error ? e.message : String(e)}（原始：${direct.message}）`);
					break;
				}
			}
			if (attemptNo < this.retries) {
				await new Promise((r) => setTimeout(r, 400 * 2 ** attemptNo));
			}
		}
		throw new DavError(
			`${method} ${path} 失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
			undefined,
			method,
			path,
		);
	}

	/** 解析 multistatus XML → DavFile[]（响应可能来自 Depth 0/1） */
	private parseMultistatus(xml: string, reqPath: string): DavFile[] {
		const files: DavFile[] = [];
		const respRe = /<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response\s*>/g;
		let m: RegExpExecArray | null;
		while ((m = respRe.exec(xml))) {
			const block = m[0];
			const hrefM = /<(?:[A-Za-z0-9_-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?href\s*>/.exec(block);
			if (!hrefM) continue;
			let href = hrefM[1].trim();
			// 服务器可能返回相对 href（相对请求路径）——补成绝对 pathname
			if (href.startsWith("http://") || href.startsWith("https://")) {
				try {
					href = new URL(href).pathname;
				} catch {
					continue;
				}
			} else if (!href.startsWith("/")) {
				href = reqPath.replace(/\/[^/]*$/, "") + "/" + href;
			}
			const isDir =
				/<(?:[A-Za-z0-9_-]+:)?collection\s*\/?>/.test(block) || href.endsWith("/");
			const etagM = /<(?:[A-Za-z0-9_-]+:)?getetag\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?getetag\s*>/.exec(block);
			const lmM = /<(?:[A-Za-z0-9_-]+:)?getlastmodified\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?getlastmodified\s*>/.exec(block);
			const sizeM = /<(?:[A-Za-z0-9_-]+:)?getcontentlength\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?getcontentlength\s*>/.exec(block);
			files.push({
				path: this.toRelative(href),
				isDir,
				...(etagM ? { etag: stripQuotes(etagM[1].trim()) } : {}),
				...(lmM ? { lastModified: lmM[1].trim() } : {}),
				...(sizeM && !isDir ? { size: Number(sizeM[1].trim()) || undefined } : {}),
			});
		}
		return files;
	}

	/** 列目录（Depth 1）：返回子项（不含自身）。目录不存在返回 [] */
	async list(path: string): Promise<DavFile[]> {
		const rel = normalizePath(path);
		const res = await this.request("PROPFIND", rel, {
			headers: { Depth: "1", "Content-Type": "application/xml" },
			body: PROPFIND_BODY,
		});
		if (res.status === 404) return [];
		if (res.status !== 207) {
			throw new DavError(`PROPFIND ${rel} 返回 HTTP ${res.status}（期望 207）`, res.status, "PROPFIND", rel);
		}
		const xml = new TextDecoder().decode(await res.arrayBuffer());
		const files = this.parseMultistatus(xml, rel);
		// Depth 1 按规范返回「自身 + 子项」，调用方只要子项，剔除自身（根目录 list 同理）
		return files.filter((f) => f.path !== rel);
	}

	/** 单文件/目录 stat（Depth 0）。不存在返回 null */
	async stat(path: string): Promise<DavFile | null> {
		const rel = normalizePath(path);
		const res = await this.request("PROPFIND", rel, {
			headers: { Depth: "0", "Content-Type": "application/xml" },
			body: PROPFIND_BODY,
		});
		if (res.status === 404) return null;
		if (res.status !== 207) {
			throw new DavError(`PROPFIND ${rel} 返回 HTTP ${res.status}（期望 207）`, res.status, "PROPFIND", rel);
		}
		const xml = new TextDecoder().decode(await res.arrayBuffer());
		const files = this.parseMultistatus(xml, rel);
		// Depth 0 只回自身；个别服务器仍回子项，取 href 等于请求路径的那条
		const self = files.find((f) => f.path === rel) ?? files.find((f) => !f.isDir) ?? files[0];
		return self ?? null;
	}

	/** 下载文件 → { data, etag }。404 抛 DavError */
	async get(
		path: string,
		opts: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<{ data: Uint8Array; etag?: string; lastModified?: string }> {
		const rel = normalizePath(path);
		const res = await this.request("GET", rel, { timeoutMs: opts.timeoutMs, signal: opts.signal });
		if (res.status === 404) {
			throw new DavError(`GET ${rel}：文件不存在（HTTP 404）`, 404, "GET", rel);
		}
		if (!(res.status >= 200 && res.status < 300)) {
			throw new DavError(`GET ${rel} 返回 HTTP ${res.status}`, res.status, "GET", rel);
		}
		const etagH = res.getHeader("etag");
		const lmH = res.getHeader("last-modified");
		return {
			data: await res.arrayBuffer(),
			...(etagH ? { etag: stripQuotes(etagH) } : {}),
			...(lmH ? { lastModified: lmH } : {}),
		};
	}

	/**
	 * 上传文件（覆盖写）。etag 传入时带 If-Match：服务端 etag 不匹配则 412 拒绝（防并发覆盖）。
	 * 返回写入后的新 etag（服务器支持才返回）。
	 */
	async put(
		path: string,
		data: Uint8Array | string,
		opts: { etag?: string; signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<DavPutResult> {
		const rel = normalizePath(path);
		const headers: Record<string, string> = {};
		if (opts.etag) headers["If-Match"] = `"${opts.etag}"`;
		const res = await this.request("PUT", rel, {
			body: typeof data === "string" ? new TextEncoder().encode(data) : data,
			headers,
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
		});
		if (res.status === 404) {
			throw new DavError(`PUT ${rel}：父目录不存在（HTTP 404），请先 mkdir`, 404, "PUT", rel);
		}
		if (res.status === 412) {
			throw new DavError(`PUT ${rel}：并发冲突（HTTP 412，远端已变更）`, 412, "PUT", rel);
		}
		if (!(res.status >= 200 && res.status < 300)) {
			throw new DavError(`PUT ${rel} 返回 HTTP ${res.status}`, res.status, "PUT", rel);
		}
		const etagH = res.getHeader("etag");
		return { ...(etagH ? { etag: stripQuotes(etagH) } : {}) };
	}

	/** 建目录。已存在时抛 DavError(405) */
	async mkdir(path: string): Promise<void> {
		const rel = normalizePath(path);
		const res = await this.request("MKCOL", rel);
		if (res.status === 405) {
			throw new DavError(`MKCOL ${rel}：目录已存在（HTTP 405）`, 405, "MKCOL", rel);
		}
		if (!(res.status >= 200 && res.status < 300)) {
			throw new DavError(`MKCOL ${rel} 返回 HTTP ${res.status}`, res.status, "MKCOL", rel);
		}
	}

	/** 删除文件或目录（目录递归删除由服务端处理，多数实现支持） */
	async delete(path: string): Promise<void> {
		const rel = normalizePath(path);
		const res = await this.request("DELETE", rel);
		if (res.status === 404) return; // 不存在视为成功（幂等）
		if (!(res.status >= 200 && res.status < 300)) {
			throw new DavError(`DELETE ${rel} 返回 HTTP ${res.status}`, res.status, "DELETE", rel);
		}
	}

	/** 移动/重命名（Overwrite: T 允许覆盖目标） */
	async move(src: string, dest: string): Promise<void> {
		const srcRel = normalizePath(src);
		const destRel = normalizePath(dest);
		const res = await this.request("MOVE", srcRel, {
			headers: { Destination: this.urlFor(destRel), Overwrite: "T" },
		});
		if (!(res.status >= 200 && res.status < 300)) {
			throw new DavError(`MOVE ${srcRel} → ${destRel} 返回 HTTP ${res.status}`, res.status, "MOVE", srcRel);
		}
	}

	/** 连通性测试（/kb-config 用）：list 根目录，失败抛 DavError */
	async ping(timeoutMs = 10_000): Promise<void> {
		await this.list("/");
	}
}
