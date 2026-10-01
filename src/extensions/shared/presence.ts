/**
 * shared/presence：跨 pi 实例的「用户在场」判定（status-beacon 提示音门控用）
 *
 * 问题：多个 pi 实例同时跑任务时，提示音会叠加成「交响乐」；用户正坐在电脑前
 * （哪怕在别的窗口/别的实例里工作）时，完成提示音也会打断他，而真正需要提醒的
 * 场景恰恰是「人不在」。所以提示音不该由单个实例说了算，要看全局的在场状态。
 *
 * 两级信号：
 * 1. 系统级空闲 `getOsIdleMs()`——最准的「手有没有在键盘/鼠标上」：Windows 用
 *    GetLastInputInfo（PowerShell 常驻进程每 2s 上报，零重复启动开销）、macOS 用
 *    ioreg HIDIdleTime、Linux 用 xprintidle（未安装则不可用）。取不到时返回 null。
 * 2. 跨实例输入：每个 pi 实例把自己的「最后一次用户输入时刻」写进
 *    ~/.pi/agent/presence/<sessionId>.json（一实例一文件，天然无写冲突），
 *    读时取所有活实例里最近的一次；用于系统级空闲不可用时的兜底。
 *
 * 提示音去重：`claimSoundSlot()` 用独占创建 + 超龄回收实现的跨进程「谁先谁响」——
 * 同一时刻多个实例收尾，只有第一个拿到槽位的实例出声。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** 在场状态文件目录（一实例一文件；PI_PRESENCE_DIR 可覆盖，测试用） */
function presenceDir(): string {
	return process.env.PI_PRESENCE_DIR ?? path.join(os.homedir(), ".pi", "agent", "presence");
}

/** 超过该时长未更新的实例文件视为陈旧（进程异常退出后的残档） */
const INSTANCE_STALE_MS = 12 * 3600_000;
/** 本实例写盘节流：按键级输入最多每 5s 落盘一次 */
const SELF_WRITE_THROTTLE_MS = 5_000;
/** 系统级空闲读数缓存时长（macOS/Linux 每次探测要起进程） */
const OS_IDLE_TTL_MS = 15_000;

interface InstanceFile {
	pid: number;
	project?: string;
	lastInputAt: number;
	updatedAt: number;
}

let selfPath: string | null = null;
let selfState: { pid: number; project: string; lastInputAt: number } | null = null;
let lastSelfWrite = 0;

/** 进程是否还活着（判死残档；无权限等异常按「活着」处理，宁保守不漏判） */
function pidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function writeSelf(force = false): void {
	if (!selfPath || !selfState) return;
	const now = Date.now();
	if (!force && now - lastSelfWrite < SELF_WRITE_THROTTLE_MS) return;
	lastSelfWrite = now;
	try {
		fs.mkdirSync(path.dirname(selfPath), { recursive: true });
		const tmp = `${selfPath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...selfState, updatedAt: now }), "utf8");
		fs.renameSync(tmp, selfPath); // 原子替换：读方永远看到完整 JSON
	} catch {
		/* 在场信息丢了也不影响主流程 */
	}
}

/** 注册本实例（session_start 调用）；顺带清理陈旧残档 */
export function initPresence(sessionId: string, project = ""): void {
	const safe = (sessionId || `pid-${process.pid}`).replace(/[^\w.-]/g, "_");
	selfPath = path.join(presenceDir(), `${safe}.json`);
	selfState = { pid: process.pid, project, lastInputAt: Date.now() };
	lastSelfWrite = 0;
	writeSelf(true);
	pruneStale();
}

/** 记录一次用户输入（按键/提交消息/回答提示都算） */
export function markUserInput(): void {
	if (!selfState) return;
	selfState.lastInputAt = Date.now();
	writeSelf();
}

/** 本实例退出时删除自己的在场文件 */
export function disposePresence(): void {
	if (!selfPath) return;
	try {
		fs.rmSync(selfPath, { force: true });
	} catch {
		/* 忽略 */
	}
	selfPath = null;
	selfState = null;
}

/** 清理陈旧残档（进程已死且超过保鲜期；或太久没更新） */
function pruneStale(): void {
	let names: string[];
	try {
		names = fs.readdirSync(presenceDir());
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of names) {
		if (!name.endsWith(".json")) continue; // 跳过 .sound-claim 等
		const full = path.join(presenceDir(), name);
		try {
			const rec = JSON.parse(fs.readFileSync(full, "utf8")) as InstanceFile;
			const stale = now - (rec.updatedAt ?? 0) > INSTANCE_STALE_MS;
			const dead = !pidAlive(rec.pid ?? 0) && now - (rec.updatedAt ?? 0) > 60_000;
			if (stale || dead) fs.rmSync(full, { force: true });
		} catch {
			/* 半个文件（写入中被读）→ 下次再清 */
		}
	}
}

/** 所有活实例里「距最近一次用户输入」的毫秒数；没有任何实例时返回 Infinity */
export function recentPiInputMs(): number {
	let names: string[];
	try {
		names = fs.readdirSync(presenceDir());
	} catch {
		return Number.POSITIVE_INFINITY;
	}
	const now = Date.now();
	let best = Number.POSITIVE_INFINITY;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const rec = JSON.parse(fs.readFileSync(path.join(presenceDir(), name), "utf8")) as InstanceFile;
			if (now - (rec.updatedAt ?? 0) > INSTANCE_STALE_MS) continue;
			if (!pidAlive(rec.pid ?? 0)) continue;
			const idle = Math.max(0, now - (rec.lastInputAt ?? 0));
			if (idle < best) best = idle;
		} catch {
			/* 忽略坏文件 */
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// 系统级空闲（OS idle）
// ---------------------------------------------------------------------------

let osIdleMs: number | null = null;
let osIdleAt = 0;
let osProbe: ChildProcessByStdio<null, Readable, null> | null = null;
let osProbeFailed = false;

/** Windows：常驻 PowerShell 进程每 2s 上报一次 GetLastInputInfo（避免每次现起进程） */
function startWindowsProbe(): void {
	const script = [
		"Add-Type -Namespace PiPresence -Name Idle -MemberDefinition '",
		'[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
		"[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
		"public static uint GetIdle() {",
		"  LASTINPUTINFO li = new LASTINPUTINFO();",
		"  li.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(li);",
		"  GetLastInputInfo(ref li);",
		"  return (uint)Environment.TickCount - li.dwTime;",
		"}';",
		// 父进程（pi）消失就自尽：pi 崩溃/被杀时不留孤儿 PowerShell 进程
		`$parent = ${process.pid};`,
		"while ($true) {",
		"  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }",
		"  [PiPresence.Idle]::GetIdle()",
		"  Start-Sleep -Milliseconds 2000",
		"}",
	].join("\n");
	let child: ChildProcessByStdio<null, Readable, null>;
	try {
		child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
	} catch {
		osProbeFailed = true;
		return;
	}
	osProbe = child;
	let buf = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buf += chunk;
		const lines = buf.split(/\r?\n/);
		buf = lines.pop() ?? "";
		for (const line of lines) {
			const n = Number(line.trim());
			if (Number.isFinite(n) && n >= 0) {
				osIdleMs = n;
				osIdleAt = Date.now();
			}
		}
	});
	child.on("error", () => {
		osProbeFailed = true;
		osProbe = null;
	});
	child.on("exit", () => {
		osProbe = null;
		if (!osIdleMs) osProbeFailed = true; // 从未拿到读数 → 判定不可用，不重试
	});
}

function probeOnce(cmd: string, args: string[], parse: (out: string) => number | null): void {
	try {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		let out = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (c: string) => (out += c));
		child.on("error", () => {
			osProbeFailed = true;
		});
		child.on("exit", () => {
			const v = parse(out);
			if (v != null) {
				osIdleMs = v;
				osIdleAt = Date.now();
			} else {
				osProbeFailed = true;
			}
		});
	} catch {
		osProbeFailed = true;
	}
}

/**
 * 系统级空闲毫秒数（用户最后一次键鼠输入至今）；无法探测时返回 null。
 * 内部节流 15s，调用方可以随便调。
 */
export function getOsIdleMs(): number | null {
	// 内部测试/调参入口：PI_OS_IDLE_MS 存在时直接采用（不走平台探测）
	if (process.env.PI_OS_IDLE_MS !== undefined) {
		const n = Number(process.env.PI_OS_IDLE_MS);
		if (Number.isFinite(n)) return n;
	}
	const now = Date.now();
	if (osIdleMs != null && now - osIdleAt < OS_IDLE_TTL_MS) return osIdleMs;
	if (osProbeFailed && process.platform !== "win32") return osIdleMs; // 探测不可用，不再反复尝试
	if (process.platform === "win32") {
		if (!osProbe && !osProbeFailed) startWindowsProbe();
		return osIdleMs;
	}
	if (osIdleMs != null && now - osIdleAt < OS_IDLE_TTL_MS * 4) {
		// 上次读数虽过 TTL，但还在可接受范围内：先返回旧值，同时异步刷新
		if (process.platform === "darwin") {
			probeOnce("ioreg", ["-c", "IOHIDSystem", "-d", "1"], (out) => {
				const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
				return m ? Math.round(Number(m[1]) / 1_000_000) : null;
			});
		} else {
			probeOnce("xprintidle", [], (out) => {
				const n = Number(out.trim());
				return Number.isFinite(n) ? n : null;
			});
		}
		return osIdleMs;
	}
	if (process.platform === "darwin") {
		probeOnce("ioreg", ["-c", "IOHIDSystem", "-d", "1"], (out) => {
			const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
			return m ? Math.round(Number(m[1]) / 1_000_000) : null;
		});
	} else if (process.platform === "linux") {
		probeOnce("xprintidle", [], (out) => {
			const n = Number(out.trim());
			return Number.isFinite(n) ? n : null;
		});
	} else {
		osProbeFailed = true;
	}
	return osIdleMs;
}

/** 停止后台探测进程（session_shutdown 调用） */
export function disposeIdleProbe(): void {
	try {
		osProbe?.kill();
	} catch {
		/* 忽略 */
	}
	osProbe = null;
}

// ---------------------------------------------------------------------------
// 判定（纯函数便于回归测试）
// ---------------------------------------------------------------------------

/**
 * 用户此刻是否「手在键盘上」：系统级空闲小于 activeMs；取不到系统读数时，
 * 用「任一 pi 实例在 activeMs 内有输入」兜底。
 */
export function computeActive(
	osIdleMs: number | null,
	recentPiInputMillis: number,
	activeMs: number,
): boolean {
	if (osIdleMs != null) return osIdleMs < activeMs;
	return recentPiInputMillis < activeMs;
}

/**
 * 用户是否「已经离开」：系统级空闲超过 awayMs；取不到系统读数时，
 * 用「所有 pi 实例都超过 awayMs 无输入」兜底。
 */
export function computeAway(
	osIdleMs: number | null,
	recentPiInputMillis: number,
	awayMs: number,
): boolean {
	if (osIdleMs != null) return osIdleMs >= awayMs;
	return recentPiInputMillis >= awayMs;
}

// ---------------------------------------------------------------------------
// 全局提示音去重
// ---------------------------------------------------------------------------

function claimPath(): string {
	return path.join(presenceDir(), ".sound-claim");
}

/**
 * 抢一次提示音播放名额：同一进程群内只有第一个调用者拿到 true（跨进程独占创建 + 超龄回收）。
 * 抢到后窗口期内其他实例一律静音，避免多实例同时收尾的「交响乐」。
 */
export function claimSoundSlot(dedupeMs: number): boolean {
	const file = claimPath();
	const now = Date.now();
	const tryClaim = (): boolean => {
		try {
			const fd = fs.openSync(file, "wx");
			fs.writeSync(fd, String(now));
			fs.closeSync(fd);
			return true;
		} catch {
			return false;
		}
	};
	try {
		fs.mkdirSync(presenceDir(), { recursive: true });
	} catch {
		/* 目录建不出来 → 下面会失败，按「允许发声」处理以免完全不响 */
		return true;
	}
	if (tryClaim()) return true;
	// 已被占用：超龄（上一次已经超过窗口期）则回收再抢，否则让位
	try {
		const prev = Number(fs.readFileSync(file, "utf8").trim());
		if (Number.isFinite(prev) && now - prev < dedupeMs) return false;
		fs.rmSync(file, { force: true });
		return tryClaim();
	} catch {
		return false;
	}
}
