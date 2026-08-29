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

export default function (pi: ExtensionAPI) {
	const t0 = new Date().toISOString();
	let piVersion = "unknown";
	try {
		piVersion = require("@earendil-works/pi-coding-agent/package.json").version ?? "unknown";
	} catch {
		// 拿不到就算了
	}
	logSync(`\n=== [${t0}] pi ${piVersion} / node ${process.version} / pid ${process.pid} / cwd ${process.cwd()} ===`);

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

	// 会话标记：崩溃条目与会话文件配对用
	pi.on("session_start", async (_event, ctx) => {
		logSync(`    [${new Date().toISOString()}] session_start cwd=${ctx.cwd}`);
	});
}
