/**
 * webui HTTP + SSE 服务器（Node 原生 http，零外部依赖）—— 主-从架构的主端
 *
 * 单端口多会话：第一个启动的 pi 进程成为主（host）监听端口，后续进程为从（relay），
 * 经内部通道接入（见 relay.ts）。浏览器统一访问主端口，按 pid 路由区分会话：
 *
 * 浏览器路由（token 校验：query ?token= 或 Authorization: Bearer）：
 * - GET  /                            → 会话列表页（index.html 列表视图）
 * - GET  /s/:pid/                     → 会话聊天页（同一 index.html，前端按 URL 分流）
 * - GET  /s/:pid/events               → 该会话的 SSE 事件流
 * - GET  /s/:pid/api/state|history    → 查询（本地会话直调 bridge；从进程经命令通道转发）
 * - POST /s/:pid/api/message|abort|model|thinking|git → 操作（同上）
 * - GET  /api/sessions                → 会话列表 JSON
 *
 * 内部通道（从进程接入，token 校验）：
 * - GET  /internal/ping               → { ok, role:"webui" }（探测占用者是否 webui 主）
 * - GET  /internal/attach?pid&cwd&name → 从进程长连接：注册会话 + 下行命令通道（SSE）
 * - POST /internal/event              → { pid, msg } 从进程事件上行 → 广播给该会话的浏览器
 * - POST /internal/result             → { pid, reqId, result } 命令结果 → resolve pending
 *
 * 旧无 pid 路由（/events、/api/*）301 重定向到本地会话，平滑过渡。
 * 安全：仅监听 127.0.0.1；所有路由校验共享 token（配置文件全会话共用）。
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Bridge, WebuiImage } from "./bridge";
import type { WebuiConfig } from "./config";

/** SSE 心跳间隔（浏览器连接与从进程 attach 共用） */
const SSE_HEARTBEAT_MS = 25_000;
/** 命令转发超时（从进程执行 + 回传上限） */
const CMD_TIMEOUT_MS = 30_000;
/** 静态前端安装目录（install.js 从仓库 static/webui/ 复制） */
const STATIC_DIR = path.join(os.homedir(), ".pi", "agent", "webui");

type SseClient = { res: http.ServerResponse; alive: boolean };

/** 已注册会话（本地 = 主进程自身；从进程 = attach 长连接） */
export interface SessionReg {
	pid: number;
	cwd: string;
	sessionName: string;
	startedAt: number;
	local: boolean;
	/** 从进程的下行命令通道（SSE 响应流）；本地会话为 null */
	relay: SseClient | null;
	/** 等待中的命令结果（reqId → resolve） */
	pending: Map<string, { resolve: (v: unknown) => void; timer: NodeJS.Timeout }>;
}

export class WebuiServer {
	private server: http.Server | null = null;
	/** 浏览器 SSE 订阅：pid → 客户端集合 */
	private viewers = new Map<number, Set<SseClient>>();
	/** 会话注册表：pid → 会话（含本地） */
	private sessions = new Map<number, SessionReg>();
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private actualPort = 0;

	constructor(
		private config: WebuiConfig,
		private localBridge: () => Bridge | null,
	) {}

	/** 实际监听端口（未启动为 0） */
	port(): number {
		return this.actualPort;
	}

	/** 注册主进程自身的本地会话 */
	registerLocal(pid: number, info: { cwd: string; sessionName: string }): void {
		this.sessions.set(pid, {
			pid,
			cwd: info.cwd,
			sessionName: info.sessionName,
			startedAt: Date.now(),
			local: true,
			relay: null,
			pending: new Map(),
		});
	}

	updateLocalInfo(pid: number, info: { cwd: string; sessionName: string }): void {
		const s = this.sessions.get(pid);
		if (s?.local) {
			s.cwd = info.cwd;
			s.sessionName = info.sessionName;
		}
	}

	unregisterLocal(pid: number): void {
		this.sessions.delete(pid);
		this.closeViewers(pid);
	}

	/** 向某会话的浏览器订阅者广播事件 */
	broadcastTo(pid: number, msg: Record<string, unknown>): void {
		const set = this.viewers.get(pid);
		if (!set) return;
		const line = `data: ${JSON.stringify(msg)}\n\n`;
		for (const c of set) {
			if (c.alive) c.res.write(line);
		}
	}

	/** 启动监听；返回实际端口，-1 = 端口被占（调用方探测/降级），0 = 其他失败。
	 *  lan=true 监听 0.0.0.0（局域网开放，会话级临时状态由调用方控制）；默认仅 127.0.0.1。 */
	start(portOverride?: number, lan = false): Promise<number> {
		const wantPort = portOverride ?? this.config.port;
		return new Promise((resolve) => {
			const server = http.createServer((req, res) => this.handleRequest(req, res));
			// SSE/attach 是长连接，禁用请求级超时（否则 300s 后被砍）
			server.requestTimeout = 0;
			server.headersTimeout = 0;
			this.server = server;

			const onError = (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") resolve(-1);
				else {
					console.error(`[webui] 服务器启动失败：${err.message}`);
					resolve(0);
				}
			};

			const onListening = () => {
				const addr = server.address();
				this.actualPort = typeof addr === "object" && addr ? addr.port : 0;
				this.heartbeatTimer = setInterval(() => this.heartbeat(), SSE_HEARTBEAT_MS);
				this.heartbeatTimer.unref?.();
				resolve(this.actualPort);
			};

			server.once("error", onError);
			// lan 模式监听全部网卡（跨设备访问，会话级临时状态）；默认仅本地回环
			server.listen(wantPort, lan ? "0.0.0.0" : "127.0.0.1", onListening);
		});
	}

	stop(): void {
		this.heartbeatTimer && clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		for (const set of this.viewers.values()) for (const c of set) { c.alive = false; c.res.end(); }
		this.viewers.clear();
		for (const s of this.sessions.values()) {
			if (s.relay) { s.relay.alive = false; s.relay.res.end(); }
			for (const p of s.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: "会话已断开" }); }
		}
		this.sessions.clear();
		this.server?.close();
		this.server = null;
		this.actualPort = 0;
	}

	// ------------------------------------------------------------------
	// 内部
	// ------------------------------------------------------------------

	private heartbeat(): void {
		for (const set of this.viewers.values()) for (const c of set) if (c.alive) c.res.write(": ping\n\n");
		for (const s of this.sessions.values()) if (s.relay?.alive) s.relay.res.write(": ping\n\n");
	}

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.actualPort}`);
		const pathname = url.pathname;

		// 内部通道
		if (pathname.startsWith("/internal/")) {
			if (!this.checkToken(url, req, res)) return;
			this.handleInternal(pathname, url, req, res);
			return;
		}

		// 会话级路由 /s/:pid/...（静态页免 token；数据路由在分支内校验）
		const m = pathname.match(/^\/s\/(\d+)(\/.*)?$/);
		if (m) {
			const pid = Number(m[1]);
			const sub = m[2] ?? "/";
			if (sub === "/" || sub === "/index.html") {
				this.serveIndex(res);
				return;
			}
			if (!this.checkToken(url, req, res)) return;
			this.handleSessionRoute(pid, sub, req, res);
			return;
		}

		// 全局 API
		if (pathname === "/api/sessions") {
			if (!this.checkToken(url, req, res)) return;
			this.json(res, {
				sessions: [...this.sessions.values()]
					.map((s) => ({ pid: s.pid, cwd: s.cwd, sessionName: s.sessionName, startedAt: s.startedAt, local: s.local }))
					.sort((a, b) => a.startedAt - b.startedAt),
			});
			return;
		}

		// 旧无 pid 路由：301 到本地会话（向后兼容老书签）
		if (pathname === "/events" || pathname.startsWith("/api/")) {
			const local = [...this.sessions.values()].find((s) => s.local) ?? [...this.sessions.values()][0];
			if (local) {
				res.writeHead(301, { Location: `/s/${local.pid}${pathname}${url.search}` });
				res.end();
				return;
			}
		}

		// 首页：会话列表页（index.html 列表视图）
		if (pathname === "/" || pathname === "/index.html") {
			this.serveIndex(res);
			return;
		}

		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not Found");
	}

	/** token 校验：query ?token= 或 Authorization: Bearer */
	private checkToken(url: URL, req: http.IncomingMessage, res: http.ServerResponse): boolean {
		const fromQuery = url.searchParams.get("token");
		const fromHeader = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
		if (fromQuery !== this.config.token && fromHeader !== this.config.token) {
			res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Unauthorized");
			return false;
		}
		return true;
	}

	// ------------------------------------------------------------------
	// 会话级路由
	// ------------------------------------------------------------------

	private handleSessionRoute(pid: number, sub: string, req: http.IncomingMessage, res: http.ServerResponse): void {
		const sess = this.sessions.get(pid);
		if (!sess) {
			this.json(res, { ok: false, error: "会话不存在或已下线" }, 404);
			return;
		}
		if (sub === "/events") {
			this.handleViewerSSE(pid, res);
			return;
		}
		if (sub.startsWith("/api/")) {
			void this.handleSessionApi(sess, sub.slice(5), req, res);
			return;
		}
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not Found");
	}

	/** 浏览器 SSE：订阅某会话的事件流 */
	private handleViewerSSE(pid: number, res: http.ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write("retry: 3000\n\n");
		res.req.socket.setTimeout(0);

		const client: SseClient = { res, alive: true };
		let set = this.viewers.get(pid);
		if (!set) {
			set = new Set();
			this.viewers.set(pid, set);
		}
		set.add(client);
		res.on("close", () => {
			client.alive = false;
			set.delete(client);
		});
		// 连接建立即推快照，前端无需等待
		void this.execOnSession(this.sessions.get(pid), "getSnapshot", []).then((snapshot) => {
			if (client.alive && snapshot) this.broadcastTo(pid, { type: "snapshot", snapshot });
		});
	}

	private closeViewers(pid: number): void {
		const set = this.viewers.get(pid);
		if (set) for (const c of set) { c.alive = false; c.res.end(); }
		this.viewers.delete(pid);
	}

	/** 会话级 API：本地直调 bridge；从进程经命令通道转发 */
	private async handleSessionApi(sess: SessionReg, api: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			switch (api) {
				case "history": {
					this.json(res, { entries: await this.execOnSession(sess, "getHistory", []) });
					return;
				}
				case "state": {
					this.json(res, { snapshot: await this.execOnSession(sess, "getSnapshot", []) });
					return;
				}
				case "commands": {
					this.json(res, { commands: await this.execOnSession(sess, "getCommands", []) });
					return;
				}
				case "models": {
					this.json(res, { models: await this.execOnSession(sess, "getModels", []) });
					return;
				}
				case "message": {
					const body = (await this.readBody(req)) as { text?: string; deliverAs?: "steer" | "followUp"; images?: WebuiImage[] };
					const text = typeof body.text === "string" ? body.text : "";
					const images = Array.isArray(body.images)
						? body.images.filter((i) => i && typeof i.mediaType === "string" && typeof i.data === "string")
						: undefined;
					if (!text.trim() && !images?.length) {
						this.json(res, { ok: false, error: "消息不能为空" }, 400);
						return;
					}
					this.json(res, await this.execOnSession(sess, "sendMessage", [text, body.deliverAs, images]));
					return;
				}
				case "abort":
					this.json(res, await this.execOnSession(sess, "abort", []));
					return;
				case "model": {
					const body = (await this.readBody(req)) as { provider?: string; id?: string };
					if (!body.provider || !body.id) {
						this.json(res, { ok: false, error: "缺少 provider/id" }, 400);
						return;
					}
					this.json(res, await this.execOnSession(sess, "setModel", [body.provider, body.id]));
					return;
				}
				case "thinking": {
					const body = (await this.readBody(req)) as { level?: string };
					this.json(res, await this.execOnSession(sess, "setThinking", [String(body.level ?? "")]));
					return;
				}
				case "fork": {
					const body = (await this.readBody(req)) as { entryId?: string };
					if (!body.entryId) {
						this.json(res, { ok: false, error: "缺少 entryId" }, 400);
						return;
					}
					this.json(res, await this.execOnSession(sess, "fork", [body.entryId]));
					return;
				}
				case "git": {
					const body = (await this.readBody(req)) as { op?: string; paths?: string[]; message?: string; branch?: string; create?: boolean };
					if (!body.op) {
						this.json(res, { ok: false, error: "缺少 op" }, 400);
						return;
					}
					this.json(res, await this.execOnSession(sess, "gitOp", [body.op, { paths: body.paths, message: body.message, branch: body.branch, create: body.create }]));
					return;
				}
				default:
					this.json(res, { ok: false, error: "Not Found" }, 404);
			}
		} catch (e) {
			this.json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
		}
	}

	/** 在指定会话上执行操作：本地直调 / 从进程命令转发 */
	private execOnSession(sess: SessionReg | undefined, method: string, params: unknown[]): Promise<unknown> {
		if (!sess) return Promise.resolve({ ok: false, error: "会话已下线" });
		if (sess.local) {
			const b = this.localBridge();
			if (!b) return Promise.resolve({ ok: false, error: "本地桥未就绪" });
			return this.execLocal(b, method, params);
		}
		return this.forwardCommand(sess, method, params);
	}

	private async execLocal(b: Bridge, method: string, params: unknown[]): Promise<unknown> {
		switch (method) {
			case "sendMessage": return b.sendMessage(params[0] as string, params[1] as "steer" | "followUp" | undefined, params[2] as WebuiImage[] | undefined);
			case "abort": b.abort(); return { ok: true };
			case "setModel": return b.setModel(params[0] as string, params[1] as string);
			case "setThinking": return b.setThinking(params[0] as string);
			case "gitOp": return b.gitOp(params[0] as string, (params[1] ?? {}) as { paths?: string[]; message?: string; branch?: string; create?: boolean });
			case "fork": return b.fork(params[0] as string);
			case "getHistory": return b.getHistory();
			case "getSnapshot": return b.getSnapshot();
			case "getCommands": return b.getCommands();
			case "getModels": return b.getModels();
			default: return { ok: false, error: `未知方法：${method}` };
		}
	}

	/** 命令下行到从进程：attach SSE 写入 + 等待 /internal/result 回传 */
	private forwardCommand(sess: SessionReg, method: string, params: unknown[]): Promise<unknown> {
		return new Promise((resolve) => {
			if (!sess.relay?.alive) {
				resolve({ ok: false, error: "从进程连接已断开" });
				return;
			}
			const reqId = crypto.randomUUID();
			const timer = setTimeout(() => {
				sess.pending.delete(reqId);
				resolve({ ok: false, error: "命令超时" });
			}, CMD_TIMEOUT_MS);
			timer.unref?.();
			sess.pending.set(reqId, {
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				timer,
			});
			sess.relay.res.write(`data: ${JSON.stringify({ type: "cmd", reqId, method, params })}\n\n`);
		});
	}

	// ------------------------------------------------------------------
	// 内部通道（从进程）
	// ------------------------------------------------------------------

	private handleInternal(pathname: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse): void {
		switch (pathname) {
			case "/internal/ping":
				this.json(res, { ok: true, role: "webui", pid: process.pid });
				return;

			case "/internal/attach": {
				const pid = Number(url.searchParams.get("pid"));
				if (!Number.isInteger(pid) || pid <= 0) {
					this.json(res, { ok: false, error: "非法 pid" }, 400);
					return;
				}
				// 同 pid 重复接入：踢掉旧连接
				const old = this.sessions.get(pid);
				if (old?.relay) { old.relay.alive = false; old.relay.res.end(); }
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
				res.req.socket.setTimeout(0);
				const relay: SseClient = { res, alive: true };
				this.sessions.set(pid, {
					pid,
					cwd: decodeURIComponent(url.searchParams.get("cwd") ?? ""),
					sessionName: decodeURIComponent(url.searchParams.get("name") ?? ""),
					startedAt: Date.now(),
					local: false,
					relay,
					pending: new Map(),
				});
				res.on("close", () => {
					relay.alive = false;
					const s = this.sessions.get(pid);
					if (s?.relay === relay) {
						for (const p of s.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: "会话已断开" }); }
						this.sessions.delete(pid);
						this.closeViewers(pid);
					}
				});
				return;
			}

			case "/internal/event": {
				void this.readBody(req).then((body) => {
					const { pid, msg } = body as { pid?: number; msg?: Record<string, unknown> };
					const sess = typeof pid === "number" ? this.sessions.get(pid) : undefined;
					if (!sess || !msg) {
						this.json(res, { ok: false, error: "未知会话" }, 404);
						return;
					}
					// 事件顺带刷新会话元信息（session_start 的 snapshot 含 cwd/sessionName）
					if (msg.type === "session_start" && msg.snapshot) {
						const snap = msg.snapshot as { cwd?: string; sessionName?: string };
						if (snap.cwd) sess.cwd = snap.cwd;
						if (snap.sessionName !== undefined) sess.sessionName = snap.sessionName ?? "";
					}
					this.broadcastTo(pid as number, msg);
					this.json(res, { ok: true });
				}).catch((e) => this.json(res, { ok: false, error: String(e) }, 400));
				return;
			}

			case "/internal/result": {
				void this.readBody(req).then((body) => {
					const { pid, reqId, result } = body as { pid?: number; reqId?: string; result?: unknown };
					const sess = typeof pid === "number" ? this.sessions.get(pid) : undefined;
					const pending = sess && typeof reqId === "string" ? sess.pending.get(reqId) : undefined;
					if (!pending) {
						this.json(res, { ok: false, error: "未知 reqId" }, 404);
						return;
					}
					sess!.pending.delete(reqId!);
					pending.resolve(result);
					this.json(res, { ok: true });
				}).catch((e) => this.json(res, { ok: false, error: String(e) }, 400));
				return;
			}

			default:
				this.json(res, { ok: false, error: "Not Found" }, 404);
		}
	}

	/** 读取请求体（JSON，限制 20MB 以容纳粘贴图片的 base64） */
	private readBody(req: http.IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let data = "";
			req.setEncoding("utf8");
			req.on("data", (chunk: string) => {
				data += chunk;
				if (data.length > 20_000_000) {
					reject(new Error("请求体过大"));
					req.destroy();
				}
			});
			req.on("end", () => {
				try {
					resolve(data ? JSON.parse(data) : {});
				} catch {
					reject(new Error("JSON 解析失败"));
				}
			});
			req.on("error", reject);
		});
	}

	private json(res: http.ServerResponse, data: unknown, status = 200): void {
		const body = JSON.stringify(data);
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
		res.end(body);
	}

	/** 前端 HTML：每次请求实时读盘——静态文件部署（cp/install）后无需重启 pi 即可生效。
	 *  50KB 文件读取开销可忽略，避免缓存导致「新功能看不到」的困惑。 */
	private serveIndex(res: http.ServerResponse): void {
		let html: string;
		try {
			html = fs.readFileSync(path.join(STATIC_DIR, "index.html"), "utf8");
		} catch {
			html = "";
		}
		if (!html) {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(`前端文件缺失：${path.join(STATIC_DIR, "index.html")}\n请先在仓库根目录运行 node install.js 安装 static/webui/`);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(html);
	}
}
