/**
 * crash-log：pi 崩溃黑匣子
 *
 * 背景：pi 本体对 uncaughtException 的处理是打印 stderr 后 process.exit(1)，
 * 且 ui.stop() 失败时终端残留鼠标上报模式（崩后冒 [555;x;yM 乱码）——
 * 崩溃堆栈随终端关闭永久丢失，无法定位死因。
 *
 * 本扩展用 prependListener 抢在 pi 的 uncaughtException 处理器之前执行
 * （pi 的处理器会同步 exit，普通 append 顺序的监听器永远轮不到），
 * 把崩溃堆栈同步落盘到 ~/.pi/agent/pi-crash.log：
 * - uncaughtException：记 stack，随后交还给 pi 的处理器正常退出；
 * - unhandledRejection：pi 本体未注册该监听（node 默认直接崩），记 stack 后
 *   rethrow 转成 uncaughtException，走 pi 的既有退出路径（行为与默认一致）；
 * - exit：记退出码，区分「异常崩」与「静默退」。
 *
 * 日志还记录每次加载时的环境信息（pi/node 版本、pid、cwd），
 * 崩溃条目可与 sessions/ 下的会话文件按时间精确配对。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ------------------------------------------------------------------
// 可调配置
// ------------------------------------------------------------------
/** 崩溃日志路径 */
const LOG_FILE = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
/** 日志滚动上限：超过则只保留尾部（防无限膨胀） */
const MAX_BYTES = 2 * 1024 * 1024;
/** 滚动后保留的尾部大小 */
const KEEP_BYTES = 1024 * 1024;

/** 同步追加一行日志（崩溃路径上不能用异步 IO） */
function logSync(line: string): void {
	try {
		fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
		// 滚动：超限时截头保尾
		try {
			const st = fs.statSync(LOG_FILE);
			if (st.size > MAX_BYTES) {
				const fd = fs.openSync(LOG_FILE, "r");
				const buf = Buffer.alloc(KEEP_BYTES);
				fs.readSync(fd, buf, 0, KEEP_BYTES, st.size - KEEP_BYTES);
				fs.closeSync(fd);
				fs.writeFileSync(LOG_FILE, `--- 日志滚动（截断前 ${st.size} 字节）---\n`);
				fs.appendFileSync(LOG_FILE, buf);
			}
		} catch {
			// 文件不存在等，忽略
		}
		fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
	} catch {
		// 黑匣子自身绝不成为崩溃源
	}
}

function fmtError(e: unknown): string {
	if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
	try {
		return typeof e === "string" ? e : JSON.stringify(e);
	} catch {
		return String(e);
	}
}

/** 读日志尾部（缺失/读失败返回空串） */
function readTail(): string {
	try {
		const st = fs.statSync(LOG_FILE);
		const bytes = Math.min(st.size, 64 * 1024);
		const fd = fs.openSync(LOG_FILE, "r");
		const buf = Buffer.alloc(bytes);
		fs.readSync(fd, buf, 0, bytes, st.size - bytes);
		fs.closeSync(fd);
		return buf.toString("utf8");
	} catch {
		return "";
	}
}

/** 本次进程启动时间戳（用于区分「上次会话的崩溃」与本次） */
const START_ISO = new Date().toISOString();

/** 最近一条崩溃/异常记录（时间 + 首行），无记录返回 null */
function lastCrashSummary(): string | null {
	const lines = readTail().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = lines[i]?.match(/^--- \[(.+?)\] (UNCAUGHT EXCEPTION|UNHANDLED REJECTION) /);
		if (m) {
			const detail = (lines[i + 1] ?? "").trim().split("\n")[0];
			return `${m[1]} · ${m[2] === "UNCAUGHT EXCEPTION" ? "未捕获异常" : "未处理的 Promise 拒绝"}\n${detail.slice(0, 300)}`;
		}
	}
	return null;
}

/** 本次启动之前的崩溃记录（用于启动时提示；本次启动写进日志的标记不算） */
function crashSinceLastStart(): string | null {
	const tail = readTail();
	const idx = tail.lastIndexOf(`=== [${START_ISO}]`);
	const before = idx > 0 ? tail.slice(0, idx) : tail;
	const lines = before.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = lines[i]?.match(/^--- \[(.+?)\] (UNCAUGHT EXCEPTION|UNHANDLED REJECTION) /);
		if (m) return m[1];
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	let piVersion = "unknown";
	try {
		piVersion = require("@earendil-works/pi-coding-agent/package.json").version ?? "unknown";
	} catch {
		// 拿不到就算了
	}
	logSync(`\n=== [${START_ISO}] pi ${piVersion} / node ${process.version} / pid ${process.pid} / cwd ${process.cwd()} ===`);

	// prepend：pi 的 uncaughtException 处理器会同步 process.exit(1)，
	// 普通注册顺序下本监听器永远执行不到，必须插队到最前
	process.prependListener("uncaughtException", (error) => {
		logSync(`--- [${new Date().toISOString()}] UNCAUGHT EXCEPTION (pid ${process.pid}) ---\n${fmtError(error)}`);
	});

	process.prependListener("unhandledRejection", (reason) => {
		logSync(`--- [${new Date().toISOString()}] UNHANDLED REJECTION (pid ${process.pid}) ---\n${fmtError(reason)}`);
		// 保持 node 默认崩溃语义：转成 uncaughtException，走 pi 的退出路径
		throw reason;
	});

	process.on("exit", (code) => {
		logSync(`--- [${new Date().toISOString()}] EXIT code=${code} (pid ${process.pid}) ---`);
	});

	// 会话标记：崩溃条目与会话文件配对用；上次会话有异常记录时告知用户去哪看
	pi.on("session_start", async (_event, ctx) => {
		logSync(`    [${new Date().toISOString()}] session_start cwd=${ctx.cwd}`);
		try {
			const prev = crashSinceLastStart();
			if (prev && ctx.hasUI) {
				ctx.ui.notify(`上次会话有崩溃记录（${prev}），详情见 ${LOG_FILE}\n（/crash-log 查看最近一条；stderr 与内存报告在 ~/.pi/agent/pi-stderr*.log、reports/）`, "warning");
			}
		} catch {
			// 黑匣子的提示绝不值得影响会话启动
		}
	});

	// /crash-log：无参报告最近的崩溃记录与文件位置（用户唯一的入口，否则不知道该去哪看）
	pi.registerCommand("crash-log", {
		description: "查看崩溃黑匣子：最近一条崩溃/异常记录与日志路径（无参数报告；clear 清空日志）",
		handler: async (args: string, ctx) => {
			if (args.trim().toLowerCase() === "clear") {
				try {
					fs.rmSync(LOG_FILE, { force: true });
					ctx.ui.notify(`已清空崩溃日志 ${LOG_FILE}`, "info");
				} catch (e) {
					ctx.ui.notify(`清空失败：${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}
			const recent = lastCrashSummary();
			ctx.ui.notify(
				[
					recent ? `最近一条崩溃记录：\n${recent}` : "没有崩溃记录（自上次清空以来）",
					``,
					`崩溃黑匣子：${LOG_FILE}`,
					`启动垫片取证：~/.pi/agent/pi-stderr*.log、~/.pi/agent/reports/`,
					`崩溃条目里的 pid/时间可与 sessions/ 里的会话文件按时间配对。`,
				].join("\n"),
				"info",
			);
		},
	});
}
