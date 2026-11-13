/**
 * computer-use/platform/win32：Windows 平台实现（常驻 PowerShell 宿主 + 行协议）
 *
 * 宿主是 platform/win32-host.ps1：启动一次、之后每次调用只付真实工作成本
 * （实测 ping 1ms、抓屏 ~130ms、UIA 热调 ~23ms；冷启动 ~330ms 只付一次）。
 * 每次动作重开进程会把延迟堆到秒级，这是"常驻"的全部理由。
 *
 * 协议：stdin 写一行 JSON 请求，stdout 读一行 "@@CU@@<json>" 响应。用行前缀而非纯 JSON
 * 是因为 PowerShell 会往同一个 stdout 吐警告/错误，前缀让解析可以对无关输出免疫。
 *
 * 崩溃恢复：宿主进程退出时把实例置空，下一次调用重新拉起（用户可能手动结束了它，
 * 或系统休眠/切换用户导致会话失效）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import {
	PlatformUnavailableError,
	type ActionResult,
	type CaptureResult,
	type MouseButton,
	type Platform,
	type ScreenBounds,
	type WindowInfo,
	type UiaSnapshot,
	type ScreenGrid,
	type FileDialog,
	type DialogFillResult,
} from "./types";

/** 响应行前缀（与脚本里的 Emit 保持一致） */
const PREFIX = "@@CU@@";
/** 单次请求超时：UIA 遍历大型应用可能到秒级，给足余量 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 宿主冷启动就绪等待（PowerShell 加载程序集 + 编译 C#） */
const STARTUP_TIMEOUT_MS = 30_000;

interface Pending {
	resolve: (v: Record<string, unknown>) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * 解码宿主回传的 Base64 字符串。
 *
 * 宿主不能直接经 stdout 传中文：实测窗口标题/控件名会被控制台代码页破坏成 U+FFFD
 * （"⠸ ⌨️ bash — my_pi" → "?? ?? bash �� my_pi"），而同一字符串写文件或转 Base64 都完好。
 * 所以凡是可能含非 ASCII 的字段一律走 Base64，这里统一解码。
 */
function decodeB64(v: unknown): string {
	if (typeof v !== "string" || !v) return "";
	try {
		return Buffer.from(v, "base64").toString("utf8");
	} catch {
		return "";
	}
}

export class Win32Platform implements Platform {
	readonly name = "win32";
	private proc: ChildProcess | null = null;
	private stdoutBuf = "";
	private pending: Pending[] = [];
	private startPromise: Promise<void> | null = null;
	private stderrTail: string[] = [];
	/** 宿主脚本路径（install.js 会把 platform 目录整体复制到扩展产物旁边） */
	private readonly scriptPath: string;

	constructor(scriptPath: string) {
		this.scriptPath = scriptPath;
	}

	async start(): Promise<void> {
		if (this.proc) return;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.spawnHost().finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	private async spawnHost(): Promise<void> {
		const child = spawn(
			"powershell",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		this.proc = child;
		this.stdoutBuf = "";
		this.stderrTail = [];

		// 两端编码都要显式 UTF-8：子进程侧已设 InputEncoding/OutputEncoding，
		// Node 侧不设会用系统代码页读写，中文 JSON 字段（如 setvalue 的文本）会变乱码。
		child.stdin?.setDefaultEncoding("utf8");
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			// 只留尾巴：PowerShell 的报错动辄几十行，全部转给模型是噪音
			this.stderrTail.push(chunk.trim());
			if (this.stderrTail.length > 6) this.stderrTail.shift();
		});
		child.on("exit", (code) => {
			this.proc = null;
			const detail = this.stderrTail.filter(Boolean).slice(-2).join(" / ");
			const err = new PlatformUnavailableError(
				`桌面宿主已退出（退出码 ${code ?? "?"}）${detail ? `：${detail}` : ""}；下次调用会自动重新启动。`,
			);
			for (const p of this.pending) {
				clearTimeout(p.timer);
				p.reject(err);
			}
			this.pending = [];
		});
		child.on("error", (e) => {
			this.proc = null;
			for (const p of this.pending) {
				clearTimeout(p.timer);
				p.reject(new PlatformUnavailableError(`启动桌面宿主失败：${e.message}`));
			}
			this.pending = [];
		});

		// 就绪探针：宿主程序集加载完才能应答 ping
		await this.request({ op: "ping" }, STARTUP_TIMEOUT_MS);
	}

	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		let idx: number;
		while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
			const line = this.stdoutBuf.slice(0, idx).trim();
			this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
			if (!line.startsWith(PREFIX)) continue;
			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>;
			} catch {
				continue;
			}
			const waiter = this.pending.shift();
			if (!waiter) continue;
			clearTimeout(waiter.timer);
			waiter.resolve(payload);
		}
	}

	/** 发一条请求并等对应响应；宿主未启动时自动拉起 */
	private async request(msg: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
		if (!this.proc) {
			if (msg.op !== "ping") {
				await this.start();
			} else {
				throw new PlatformUnavailableError("桌面宿主未启动");
			}
		}
		const proc = this.proc;
		if (!proc?.stdin?.writable) throw new PlatformUnavailableError("桌面宿主的标准输入不可用");
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				const i = this.pending.findIndex((p) => p.timer === timer);
				if (i >= 0) this.pending.splice(i, 1);
				reject(new PlatformUnavailableError(`桌面操作超时（${timeoutMs}ms）：${String(msg.op)}`));
			}, timeoutMs);
			this.pending.push({ resolve, reject, timer });
			proc.stdin!.write(JSON.stringify(msg) + "\n");
		});
	}

	/** 统一把 {ok:false,error} 转成异常，避免调用方漏判 */
	private async call(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
		const res = await this.request(msg, timeoutMs);
		if (res.ok !== true) throw new Error(typeof res.error === "string" ? res.error : "桌面操作失败（未给出原因）");
		return res;
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		try {
			proc.stdin?.write(JSON.stringify({ op: "exit" }) + "\n");
		} catch {
			/* 宿主可能已经没了 */
		}
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				try {
					proc.kill();
				} catch {}
				resolve();
			}, 1500);
			proc.once("exit", () => {
				clearTimeout(t);
				resolve();
			});
		});
		this.proc = null;
	}

	async bounds(): Promise<ScreenBounds> {
		const r = await this.call({ op: "bounds" });
		return { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h), dpi: String(r.dpi ?? "unknown") };
	}

	async focus(): Promise<WindowInfo> {
		const r = await this.call({ op: "focus" });
		const rect = (r.rect ?? {}) as Record<string, number>;
		return {
				hwnd: String(r.hwnd ?? ""),
			proc: String(r.proc ?? "?"),
			title: decodeB64(r.titleB64),
			cls: String(r.cls ?? ""),
			pid: Number(r.pid ?? 0),
			rect: { x: Number(rect.x ?? 0), y: Number(rect.y ?? 0), w: Number(rect.w ?? 0), h: Number(rect.h ?? 0) },
			modal: r.modal === true,
			owner: String(r.owner ?? "0"),
		};
	}

	async activate(hwnd: string): Promise<boolean> {
		const r = await this.call({ op: "activate", hwnd });
		return r.reached === true;
	}

	async listWindows(): Promise<WindowInfo[]> {
		const r = await this.call({ op: "windows" }, 20_000);
		const list = Array.isArray(r.windows) ? (r.windows as Record<string, unknown>[]) : [];
		return list.map((x) => {
			const rect = (x.rect ?? {}) as Record<string, number>;
			return {
				hwnd: String(x.hwnd ?? ""),
				proc: String(x.proc ?? "?"),
				title: decodeB64(x.titleB64),
				cls: String(x.cls ?? ""),
				pid: Number(x.pid ?? 0),
				rect: { x: Number(rect.x ?? 0), y: Number(rect.y ?? 0), w: Number(rect.w ?? 0), h: Number(rect.h ?? 0) },
				modal: x.modal === true,
				owner: String(x.owner ?? "0"),
			};
		});
	}

	async capture(outPath: string): Promise<CaptureResult> {
		const r = await this.call({ op: "capture", path: outPath }, 20_000);
		return { path: String(r.path), w: Number(r.w), h: Number(r.h), capMs: Number(r.cap ?? 0), ms: Number(r.ms ?? 0) };
	}

	async uia(opts: { maxNodes?: number; maxDepth?: number } = {}): Promise<UiaSnapshot> {
		const r = await this.call({ op: "uia", maxNodes: opts.maxNodes, maxDepth: opts.maxDepth }, 40_000);
		const rawItems = Array.isArray(r.items) ? (r.items as Record<string, unknown>[]) : [];
		// 控件名基本都是中文，宿主按 Base64 传回（见 decodeB64 的注释）
		const items = rawItems.map((it) => ({ ...it, name: decodeB64(it.nameB64) })) as unknown as UiaSnapshot["items"];
		return {
			title: decodeB64(r.titleB64),
			cls: String(r.cls ?? ""),
			proc: Number(r.proc ?? 0),
			rect: (r.rect as UiaSnapshot["rect"]) ?? { x: 0, y: 0, w: 0, h: 0 },
			count: Number(r.count ?? items.length),
			items,
			ms: Number(r.ms ?? 0),
		};
	}

	async move(x: number, y: number): Promise<ActionResult> {
		const r = await this.call({ op: "move", x, y });
		return { via: "mouse", ms: Number(r.ms ?? 0) };
	}

	async click(x: number, y: number, opts: { button?: MouseButton; count?: number; preferUia?: boolean } = {}): Promise<ActionResult> {
		const r = await this.call({
			op: "click",
			x,
			y,
			button: opts.button ?? "left",
			count: opts.count ?? 1,
			preferUia: opts.preferUia ?? true,
		});
		const detail = (r.detail ?? {}) as { target?: string; type?: string };
		return { via: String(r.via ?? "mouse"), target: detail.target, type: detail.type, ms: Number(r.ms ?? 0) };
	}

	async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<ActionResult> {
		const r = await this.call({ op: "drag", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }, 20_000);
		return { via: "mouse", ms: Number(r.ms ?? 0) };
	}

	async scroll(amount: number, at?: { x: number; y: number }): Promise<ActionResult> {
		const r = await this.call({ op: "scroll", amount, ...(at ? { x: at.x, y: at.y } : {}) });
		return { via: "mouse", ms: Number(r.ms ?? 0) };
	}

	async key(keys: string[]): Promise<ActionResult> {
		const r = await this.call({ op: "key", keys });
		return { via: "sendinput", ms: Number(r.ms ?? 0) };
	}

	async typeAscii(text: string): Promise<ActionResult> {
		const r = await this.call({ op: "type", text }, 20_000);
		return { via: "sendinput", ms: Number(r.ms ?? 0) };
	}

	async setValue(x: number, y: number, value: string): Promise<ActionResult> {
		const r = await this.call({ op: "setvalue", x, y, value });
		return { via: String(r.via ?? "uia-value"), target: r.target as string | undefined, type: r.type as string | undefined, ms: Number(r.ms ?? 0) };
	}

	async grid(): Promise<ScreenGrid> {
		const r = await this.call({ op: "capture" }, 20_000);
		const raw = Array.isArray(r.grid) ? (r.grid as number[]) : [];
		const cols = Number(r.cols ?? 0);
		const w = Number(r.w ?? 0);
		const h = Number(r.h ?? 0);
		const rows = cols > 0 ? Math.ceil(h / 32) : 0;
		return { w, h, cols, rows, cells: Float32Array.from(raw, (v) => Number(v) || 0) };
	}

	async listDialogs(): Promise<FileDialog[]> {
		const r = await this.call({ op: "dialogs" }, 20_000);
		const list = Array.isArray(r.dialogs) ? (r.dialogs as Record<string, unknown>[]) : [];
		return list.map((x) => {
			const rect = (x.rect ?? {}) as Record<string, number>;
			return {
				hwnd: String(x.hwnd ?? ""),
				title: decodeB64(x.titleB64),
				modal: x.modal === true,
				foreground: x.foreground === true,
				fileName: String(x.fileName ?? ""),
				rect: { x: Number(rect.x ?? 0), y: Number(rect.y ?? 0), w: Number(rect.w ?? 0), h: Number(rect.h ?? 0) },
			};
		});
	}

	async fillFileDialog(opts: {
		hwnd?: string;
		path?: string;
		submit?: boolean;
		cancel?: boolean;
	}): Promise<DialogFillResult> {
		// 提交尝试三种方式，最坏 1.5+1.2+1.2 秒，留足余量
		const r = await this.request(
			{
				op: "dialog",
				hwnd: opts.hwnd,
				path: opts.path,
				submit: opts.submit !== false,
				action: opts.cancel ? "cancel" : undefined,
			},
			15_000,
		);
		const steps = Array.isArray(r.steps) ? (r.steps as string[]).map(String) : [];
		if (r.ok !== true) {
			return {
				ok: false,
				closed: false,
				via: String(r.action ?? ""),
				steps,
				error: typeof r.error === "string" ? r.error : "对话框操作失败（未给出原因）",
				fileName: typeof r.fileName === "string" ? r.fileName : undefined,
			};
		}
		return {
			ok: true,
			closed: r.closed === true,
			via: String(r.via ?? ""),
			steps,
			fileName: typeof r.fileName === "string" ? r.fileName : undefined,
		};
	}

	async getClipboard(): Promise<string> {
		const r = await this.call({ op: "clipget" });
		return decodeB64(r.textB64);
	}

	async setClipboard(text: string): Promise<void> {
		// 走宿主内的 P/Invoke：实测写入 7ms。早先用 clip.exe（独立进程，37ms），
		// 更早的 Get-Clipboard 备份要 965ms——而这条通道是中文路径输入的主路，每输一次都要写。
		const r = await this.request({ op: "clipset", text }, 10_000);
		if (r.ok !== true) throw new Error(typeof r.error === "string" ? r.error : "写剪贴板失败");
	}
}

/** 宿主脚本路径：与扩展产物同目录的 platform/ 下（由 install.js 复制） */
export function hostScriptPath(extensionDir: string): string {
	return path.join(extensionDir, "platform", "win32-host.ps1");
}
