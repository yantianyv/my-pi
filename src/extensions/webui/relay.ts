/**
 * webui 从进程中继（relay）：探测到主服务已占用端口时，本进程不监听，
 * 作为 HTTP 客户端接入主服务——事件上行（POST /internal/event）、
 * 命令下行（GET /internal/attach 长连接接收 SSE 命令并执行回传）。
 *
 * 故障转移：attach 断开后指数退避重连；连续失败达到阈值回调 onMasterGone()，
 * 由 index.ts 尝试抢占端口升级为主（谁抢到谁是主，其余继续 relay）。
 */
import * as http from "node:http";
import type { Bridge } from "./bridge";
import type { WebuiConfig } from "./config";

/** attach 重连退避：起步 2s，封顶 30s */
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** 连续失败多少次后判定主已下线（触发升级尝试） */
const MAX_FAILURES = 3;

/** 会话元信息提供者（attach 注册时上报 cwd/sessionName） */
export type SessionInfoFn = () => { cwd: string; sessionName: string };

export class Relay {
	private pid = process.pid;
	private stopped = false;
	private failures = 0;
	private reconnectDelay = RECONNECT_MIN_MS;
	private activeReq: http.ClientRequest | null = null;
	private retryTimer: NodeJS.Timeout | null = null;

	/** 主服务断线达到阈值时回调（index.ts 据此尝试升级为主） */
	onMasterGone: (() => void) | null = null;

	constructor(
		private config: WebuiConfig,
		private bridge: () => Bridge | null,
		private sessionInfo: SessionInfoFn,
	) {}

	private masterBase(): string {
		return `http://127.0.0.1:${this.config.port}`;
	}

	/** 事件上行：pi 事件 → 主服务广播给该会话的浏览器订阅者 */
	postEvent(msg: Record<string, unknown>): void {
		this.post("/internal/event", { pid: this.pid, msg }).catch(() => {
			/* 上行失败静默：主可能刚挂，重连逻辑会处理 */
		});
	}

	/** 建立 attach 长连接（下行命令通道），断线自动重连 */
	connect(): void {
		if (this.stopped) return;
		let info: { cwd: string; sessionName: string };
		try {
			info = this.sessionInfo();
		} catch {
			// session 替换后旧 ctx 已失效，停止重连避免崩溃
			this.stop();
			return;
		}
		const url =
			`${this.masterBase()}/internal/attach?pid=${this.pid}` +
			`&token=${encodeURIComponent(this.config.token)}` +
			`&cwd=${encodeURIComponent(info.cwd)}&name=${encodeURIComponent(info.sessionName)}`;

		const req = http.get(url, { headers: { Accept: "text/event-stream" } }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				this.scheduleReconnect();
				return;
			}
			res.socket.setTimeout(0);
			res.setEncoding("utf8");
			let buf = "";
			res.on("data", (chunk: string) => {
				buf += chunk;
				// SSE 按空行分帧解析
				let idx: number;
				while ((idx = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					this.handleFrame(frame);
				}
			});
			res.on("close", () => this.scheduleReconnect());
			res.on("end", () => this.scheduleReconnect());
			// 连接成功：重置退避
			this.failures = 0;
			this.reconnectDelay = RECONNECT_MIN_MS;
		});
		req.on("error", () => this.scheduleReconnect());
		req.setTimeout(10_000, () => req.destroy());
		this.activeReq = req;
	}

	stop(): void {
		this.stopped = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.activeReq?.destroy();
		this.activeReq = null;
	}

	// ------------------------------------------------------------------
	// 内部
	// ------------------------------------------------------------------

	private scheduleReconnect(): void {
		if (this.stopped) return;
		this.activeReq = null;
		this.failures++;
		if (this.failures >= MAX_FAILURES && this.onMasterGone) {
			const cb = this.onMasterGone;
			this.failures = 0;
			cb(); // 升级为主后 stop() 会使 stopped=true，后续重连不再发生
			if (this.stopped) return;
		}
		this.retryTimer = setTimeout(() => this.connect(), this.reconnectDelay);
		this.retryTimer.unref?.();
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
	}

	/** 解析 attach SSE 帧：{ type:"cmd", reqId, method, params } → 执行并回传结果 */
	private handleFrame(frame: string): void {
		for (const line of frame.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			let msg: { type?: string; reqId?: string; method?: string; params?: unknown[] };
			try {
				msg = JSON.parse(line.slice(6));
			} catch {
				continue;
			}
			if (msg.type === "cmd" && msg.reqId && msg.method) {
				void this.execCmd(msg.method, msg.params ?? []).then((result) => {
					this.post("/internal/result", { pid: this.pid, reqId: msg.reqId, result }).catch(() => {});
				});
			}
		}
	}

	/** 执行主服务下发的命令（与 server.ts execLocal 同方法表） */
	private async execCmd(method: string, params: unknown[]): Promise<unknown> {
		const b = this.bridge();
		if (!b) return { ok: false, error: "本地桥未就绪" };
		try {
			switch (method) {
				case "sendMessage": return await b.sendMessage(params[0] as string, params[1] as "steer" | "followUp" | undefined, params[2] as never);
				case "abort": b.abort(); return { ok: true };
				case "setModel": return await b.setModel(params[0] as string, params[1] as string);
				case "setThinking": return b.setThinking(params[0] as string);
				case "gitOp": return await b.gitOp(params[0] as string, (params[1] ?? {}) as never);
				case "fork": return await b.fork(params[0] as string);
				case "getHistory": return b.getHistory();
				case "getSnapshot": return await b.getSnapshot();
				case "getCommands": return b.getCommands();
				case "getModels": return b.getModels();
				default: return { ok: false, error: `未知方法：${method}` };
			}
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	/** POST JSON 到主服务（5s 超时） */
	private post(path: string, body: unknown): Promise<void> {
		return new Promise((resolve, reject) => {
			const data = JSON.stringify(body);
			const req = http.request(
				`${this.masterBase()}${path}`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.config.token}`,
						"Content-Length": Buffer.byteLength(data),
					},
				},
				(res) => {
					res.resume();
					res.on("end", resolve);
				},
			);
			req.on("error", reject);
			req.setTimeout(5_000, () => req.destroy(new Error("上行超时")));
			req.write(data);
			req.end();
		});
	}
}
