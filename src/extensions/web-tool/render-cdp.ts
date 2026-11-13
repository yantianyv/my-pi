/**
 * web-tool/render-cdp：无头渲染（web_fetch 的 JS 兜底通道）
 *
 * 为什么不用 playwright-core（2026-10 实测）：
 * - 内联进产物会让 web-tool.ts 从 615KB 涨到 5.2MB（esbuild 实测 4.62MB），且 chromium-bidi
 *   必须外部化否则 build 失败；每次 pi 启动都要让 jiti 解析这 5MB；
 * - 外置则破坏「零耦合单文件」约定，还要在扩展解析路径上另装 node_modules；
 * - 本机 playwright-core 1.58.2 期望 chromium-1208，而 ms-playwright 缓存是 1228，仍要
 *   executablePath 覆盖。
 * 改用 child_process.spawn 起 headless shell + Node 内置 WebSocket 直连 CDP，只碰
 * Target / Page / Runtime 三个域，零外部依赖；实测冷启动约 850ms、复用会话约 330ms。
 *
 * 三个必须守住的约束：
 * 1. headless shell 不拦同一 user-data-dir 的第二实例（两个进程共用一份 cookie 库会互相
 *    覆盖），所以持久化 profile 自己用 pid 锁互斥，被占用就本次退回临时 profile；
 * 2. 浏览器进程必须真正复用（`session = s` 别漏）——漏了会每次新起一个浏览器、旧进程还
 *    活着共用同一 profile，表现为导航从 5ms 劣化到 1470ms；
 * 3. 标签页必须一次渲染一个（各开各的 target，用完关掉）：共用一个页面时同一进程内的并发
 *    调用会互相抢导航，实测并发 A 请求会拿到 B 页面的正文（比报错更坏）。浏览器进程仍复用。
 *
 * 生命周期：factory 里不启动任何东西；首次兜底时才起浏览器，空闲 60s 自动关，
 * session_shutdown 调 shutdownRenderer() 兜底清理（幂等）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RenderResult {
	html: string;
	finalUrl: string;
	ms: number;
	/** 本次是否用了持久化 profile（false = 回退到临时 profile，可能没有登录态） */
	persistent: boolean;
	/** 分段耗时（毫秒）：定位「这次为什么慢」用；target = 建/挂标签页，出现 1s 以上的 navigate 先查残留浏览器进程 */
	phases: { launch: number; target: number; navigate: number; settle: number; grab: number };
}

export interface RenderOptions {
	/** 总预算，默认 15s */
	timeoutMs?: number;
	/** 正文稳定多久算渲染完成，默认 800ms */
	quietMs?: number;
	/** 渲染前滚动到底触发懒加载，默认关 */
	scroll?: boolean;
	/** 代理地址（复用 web-fetch-proxy.json），传给 --proxy-server */
	proxyUrl?: string | null;
	/** 本次强制用临时 profile（测试用） */
	freshProfile?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_QUIET_MS = 800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 持久化 profile：保留一次手动登录的会话（登录入口见 /web-render-login）；测试用环境变量隔离 */
export function profileDir(): string {
	return process.env.PI_WEB_RENDER_PROFILE || path.join(os.homedir(), ".pi", "agent", "web-render-profile");
}

/** 进程存活判定（Windows 下无权限探活报 EPERM，同样算活着） */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

const LOCK_NAME = ".pi-render.lock";
/** 锁过期上限：持锁方是 pi 进程（崩溃即 pid 失效），心跳只兜底 pid 重用 */
const LOCK_STALE_MS = 10 * 60_000;

/** 抢持久化 profile 的锁；false = 另一个 pi 会话正在用这份 profile */
function acquireProfileLock(profile: string): boolean {
	const lockFile = path.join(profile, LOCK_NAME);
	try {
		const prev = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number; at?: number };
		const fresh = typeof prev.at === "number" && Date.now() - prev.at < LOCK_STALE_MS;
		if (prev.pid && prev.pid !== process.pid && fresh && pidAlive(prev.pid)) return false;
	} catch {
		/* 无锁或残锁：下面直接改写 */
	}
	try {
		fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
		return true;
	} catch {
		return false;
	}
}

function releaseProfileLock(profile: string): void {
	try {
		const lockFile = path.join(profile, LOCK_NAME);
		const prev = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number };
		if (prev.pid === process.pid) fs.rmSync(lockFile, { force: true });
	} catch {
		/* 忽略 */
	}
}

/** 浏览器自己死掉时也要放锁，否则死 pid 会把 profile 占死 */
function releaseLockIfHeld(): void {
	if (!lockedProfile) return;
	releaseProfileLock(lockedProfile);
	lockedProfile = null;
}

/** 找可用的 Chromium：优先 headless shell（比 chrome.exe 快一个数量级），再退普通 chrome */
export function findChromePath(opts: { headed?: boolean } = {}): string | null {
	// 环境变量是逃生口：路径不存在就当作没有浏览器（rendererReady 不能在此撒谎，否则会白试一次启动）
	const override = process.env.PI_WEB_RENDER_CHROME;
	if (override) return fs.existsSync(override) ? override : null;
	const home = os.homedir();
	const roots = process.platform === "win32"
		? [path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright"), path.join(home, "AppData", "Local", "ms-playwright")]
		: process.platform === "darwin"
			? [path.join(home, "Library", "Caches", "ms-playwright")]
			: [path.join(home, ".cache", "ms-playwright"), "/opt/ms-playwright"];
	// 版本号不写死：扫目录取最大 revision（playwright 升级只改目录名）
	const dirs = roots.flatMap((root) => {
		try {
			return fs.readdirSync(root, { withFileTypes: true })
				.filter((d) => d.isDirectory() && d.name.startsWith("chromium"))
				.map((d) => ({ name: d.name, full: path.join(root, d.name) }));
		} catch {
			return [];
		}
	});
	const rev = (name: string) => Number(/(\d+)/.exec(name)?.[1] ?? 0);
	const shells = dirs.filter((d) => d.name.startsWith("chromium_headless_shell")).sort((a, b) => rev(b.name) - rev(a.name));
	const fulls = dirs.filter((d) => d.name.startsWith("chromium")).sort((a, b) => rev(b.name) - rev(a.name));
	const candidates = [
		// headed 登录窗口必须用完整 chromium（headless shell 没有界面）
		...(opts.headed ? fulls : [...shells, ...fulls]).flatMap((d) => [
			path.join(d.full, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
			path.join(d.full, "chrome-win64", "chrome.exe"),
			path.join(d.full, "chrome-linux", "headless_shell"),
			path.join(d.full, "chrome-linux", "chrome"),
			path.join(d.full, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
		]),
		"/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
	];
	return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

export function rendererReady(): boolean {
	return findChromePath() !== null;
}

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Cdp {
	private pending = new Map<number, Pending>();
	private seq = 0;

	private constructor(private ws: WebSocket) {
		ws.addEventListener("message", (ev: MessageEvent) => {
			let msg: any;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (msg.id && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				msg.error ? p.reject(new Error(`${msg.error.message ?? "CDP 错误"}`)) : p.resolve(msg.result);
			}
		});
		const fail = () => {
			for (const [, p] of this.pending) p.reject(new Error("CDP 连接已断开"));
			this.pending.clear();
		};
		ws.addEventListener("close", fail);
		ws.addEventListener("error", fail);
	}

	static connect(wsUrl: string, timeoutMs = 10_000): Promise<Cdp> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			const timer = setTimeout(() => {
				try {
					ws.close();
				} catch {
					/* 忽略 */
				}
				reject(new Error("CDP 连接超时"));
			}, timeoutMs);
			ws.addEventListener("open", () => {
				clearTimeout(timer);
				resolve(new Cdp(ws));
			});
			ws.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error("CDP 连接失败"));
			});
		});
	}

	send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const id = ++this.seq;
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			/* 忽略 */
		}
	}
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const FIRST_RUN_FLAGS = [
	"--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
	"--disable-background-networking", "--disable-sync", "--mute-audio", "--no-service-autorun",
	"--disable-features=Translate,BackForwardCache,AcceptCHFrame",
];

/** 启动参数（纯函数，便于不启浏览器就断言代理/profile 分支）：默认 headless，headless:false 用于登录窗口 */
export function buildLaunchArgs(opts: { profile: string; proxyUrl?: string | null; headless?: boolean }): string[] {
	return [
		...(opts.headless === false ? [] : ["--headless"]),
		...FIRST_RUN_FLAGS,
		...(opts.proxyUrl ? [`--proxy-server=${opts.proxyUrl}`] : []),
		"--remote-debugging-port=0", `--user-data-dir=${opts.profile}`, "about:blank",
	];
}

interface Session {
	child: ChildProcess;
	cdp: Cdp;
	persistent: boolean;
	profile: string;
	lastUsed: number;
}

/** 一次渲染独占的标签页（并发调用各持一个，互不抢导航） */
interface Target {
	targetId: string;
	sessionId: string;
}

let session: Session | null = null;
let launching: Promise<Session> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let lockedProfile: string | null = null;

/** 起浏览器并等 DevTools 端点；persistent=false 时用临时目录（关掉即删）
 *  标签页不在这里建：每次 renderPage 自己开一个，用完关掉（见 openTarget） */
async function launch(persistent: boolean, opts: RenderOptions = {}): Promise<Session> {
	const exe = findChromePath();
	if (!exe) throw new Error("未找到可用的 Chromium（可用 PI_WEB_RENDER_CHROME 指定）");
	if (persistent) {
		fs.mkdirSync(profileDir(), { recursive: true });
		// 另一个 pi 会话正在用这份 profile：本次改用临时 profile，不拖垮调用方
		if (!acquireProfileLock(profileDir())) return await launch(false, opts);
		lockedProfile = profileDir();
	}
	const profile = persistent ? profileDir() : fs.mkdtempSync(path.join(os.tmpdir(), "pi-render-"));

	const child = spawn(exe, buildLaunchArgs({ profile, proxyUrl: opts.proxyUrl }), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

	let stderr = "";
	const wsUrl = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("浏览器启动超时"));
		}, 10_000);
		child.stderr!.on("data", (d: Buffer) => {
			stderr += d.toString();
			const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
			if (m) {
				clearTimeout(timer);
				resolve(m[1]);
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`浏览器退出（code=${code}）${stderr ? "：" + stderr.split("\n")[0] : ""}`));
		});
		child.once("error", (e: Error) => {
			clearTimeout(timer);
			reject(e);
		});
	});

	const cdp = await Cdp.connect(wsUrl);
	const s: Session = { child, cdp, persistent, profile, lastUsed: Date.now() };
	session = s;
	if (process.env.PI_WEB_RENDER_DEBUG) {
		console.error(`[web-render] 启动浏览器 pid=${child.pid} profile=${persistent ? "持久化" : "临时"}`);
	}
	child.once("exit", (code, signal) => {
		if (process.env.PI_WEB_RENDER_DEBUG) {
			console.error(`[web-render] 浏览器退出 pid=${child.pid} code=${code} signal=${signal}`);
		}
		if (session === s) session = null;
		releaseLockIfHeld();
	});
	return s;
}

async function getSession(opts: RenderOptions): Promise<Session> {
	if (opts.freshProfile) return await launch(false, opts);
	if (session && session.child.exitCode === null) return session;
	if (launching) return await launching;
	launching = (async () => {
		try {
			return await launch(true, opts);
		} catch {
			// 持久化 profile 起不来（被占用/损坏/权限）：退临时 profile，别让整次抓取失败
			return await launch(false, opts);
		} finally {
			launching = null;
		}
	})();
	return await launching;
}

/** 开一个独占标签页（about:blank → 挂上 flatten 会话 → 开 Page/Runtime 域） */
async function openTarget(s: Session): Promise<Target> {
	const { targetId } = await s.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await s.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
	await s.cdp.send("Page.enable", {}, sessionId);
	await s.cdp.send("Runtime.enable", {}, sessionId);
	return { targetId, sessionId };
}

/** 关标签页（页面可能已经自己没了，失败忽略） */
async function closeTarget(s: Session, t: Target): Promise<void> {
	await s.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
}

/** 等页面安静下来：readyState=complete 且正文长度连续 quietMs 不变（超时返回当前 DOM） */
async function waitForSettle(s: Session, sessionId: string, timeoutMs: number, quietMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastLen = -1;
	let stableSince = Date.now();
	for (;;) {
		const { result } = await s.cdp.send<{ result: { value?: string } }>("Runtime.evaluate", {
			expression: 'document.readyState + "|" + (document.body ? document.body.innerText.length : 0)',
			returnByValue: true,
		}, sessionId);
		const [state, lenRaw] = String(result.value ?? "").split("|");
		const len = Number(lenRaw) || 0;
		if (len !== lastLen) {
			lastLen = len;
			stableSince = Date.now();
		}
		if (state === "complete" && Date.now() - stableSince >= quietMs && len > 0) return;
		if (Date.now() > deadline) return;
		await sleep(150);
	}
}

/** 滚动到底再回顶，触发懒加载内容（无限列表/懒图站点） */
async function scrollToBottom(s: Session, sessionId: string): Promise<void> {
	await s.cdp.send("Runtime.evaluate", {
		expression: `(async () => {
			const step = Math.max(300, window.innerHeight * 0.9);
			for (let y = 0; y < document.body.scrollHeight; y += step) {
				window.scrollTo(0, y);
				await new Promise((r) => setTimeout(r, 120));
			}
			window.scrollTo(0, 0);
		})()`,
		awaitPromise: true,
		returnByValue: true,
	}, sessionId);
}

/** 渲染 URL 并取回渲染后的 HTML；失败抛错，由调用方决定是否降级。
 *  每次调用独占一个标签页（并发调用不会互相抢导航），用完即关；浏览器进程仍然复用。 */
export async function renderPage(url: string, opts: RenderOptions = {}): Promise<RenderResult> {
	const t0 = Date.now();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;

	const tLaunch = Date.now();
	const s = await getSession(opts);
	s.lastUsed = Date.now();
	const launchMs = Date.now() - tLaunch;

	const tTarget = Date.now();
	const target = await openTarget(s);
	const targetMs = Date.now() - tTarget;

	try {
		const tNav = Date.now();
		await s.cdp.send("Page.navigate", { url }, target.sessionId);
		const navigateMs = Date.now() - tNav;

		const tSettle = Date.now();
		await waitForSettle(s, target.sessionId, timeoutMs, quietMs);
		const settleMs = Date.now() - tSettle;
		if (opts.scroll) await scrollToBottom(s, target.sessionId);

		const tGrab = Date.now();
		const [html, href] = await Promise.all([
			s.cdp.send<{ result: { value?: string } }>("Runtime.evaluate", {
				expression: "document.documentElement.outerHTML", returnByValue: true,
			}, target.sessionId).then((r) => String(r.result.value ?? "")),
			s.cdp.send<{ result: { value?: string } }>("Runtime.evaluate", {
				expression: "location.href", returnByValue: true,
			}, target.sessionId).then((r) => String(r.result.value ?? url)),
		]);
		const grabMs = Date.now() - tGrab;
		const phases = { launch: launchMs, target: targetMs, navigate: navigateMs, settle: settleMs, grab: grabMs };
		if (process.env.PI_WEB_RENDER_DEBUG) {
			console.error(`[web-render] ${url} → launch ${launchMs}ms / target ${targetMs}ms / navigate ${navigateMs}ms / settle ${settleMs}ms / grab ${grabMs}ms`);
		}
		return { html, finalUrl: href, ms: Date.now() - t0, persistent: s.persistent, phases };
	} finally {
		await closeTarget(s, target);
	}
}

/** 空闲回收：默认 60s 无新任务即关浏览器（每次渲染后由调用方续期） */
export function scheduleIdleClose(ms = 60_000): void {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		void shutdownRenderer();
	}, ms);
	idleTimer.unref?.();
}

/** 关闭浏览器并清理临时 profile；幂等，session_shutdown 与空闲回收都走它 */
export async function shutdownRenderer(): Promise<void> {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
	const s = session;
	session = null;
	releaseLockIfHeld();
	if (!s) return;
	s.cdp.close();
	const exited = new Promise<void>((resolve) => s.child.once("exit", () => resolve()));
	s.child.kill();
	await Promise.race([exited, sleep(2000)]);
	if (s.child.exitCode === null) s.child.kill("SIGKILL");
	if (!s.persistent) {
		try {
			fs.rmSync(s.profile, { recursive: true, force: true });
		} catch {
			/* 临时目录残留无害 */
		}
	}
}

/** 清空持久化 profile（连带登录态）：先关浏览器放锁，再删目录 */
export async function clearProfile(): Promise<string> {
	await shutdownRenderer();
	const dir = profileDir();
	fs.rmSync(dir, { recursive: true, force: true });
	return dir;
}

/** 用有界面的窗口打开目标站点供人工登录，profile 与渲染共用；用户关窗后会话即留存 */
export function openLoginWindow(url: string): { pid: number | undefined; profile: string } {
	const exe = findChromePath({ headed: true });
	if (!exe) throw new Error("未找到带界面的 Chromium（headless shell 无法登录，可用 PI_WEB_RENDER_CHROME 指定 chrome.exe）");
	const profile = profileDir();
	fs.mkdirSync(profile, { recursive: true });
	const child = spawn(exe, [url, ...FIRST_RUN_FLAGS, `--user-data-dir=${profile}`], {
		stdio: "ignore", detached: true, windowsHide: false,
	});
	child.unref();
	return { pid: child.pid, profile };
}
