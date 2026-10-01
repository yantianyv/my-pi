#!/usr/bin/env node
/**
 * pi 启动垫片补丁 v2：崩溃取证（报告 + stderr 落盘 + 退出码）
 *
 * 背景：教研室/成绩分析项目 pi 反复无声崩溃，签名一致——进程消失、无 JS 异常
 * （crash-log 扩展零记录）、无 V8 报告（--report-on-fatalerror 零报告）、无 WER 事件。
 * 实测本机 WER 对 node 的 abort 不产生事件、--report-on-fatalerror 也不触发（两者都被
 * 验证过），因此「abort 类原生死亡」（node 内部断言 / V8 CHECK / llhttp 崩溃）在本机
 * 原本完全零痕迹。唯一确定能抓到它的通道：abort 死前会往 stderr 打原生调用栈。
 *
 * 崩溃取证史（单台设备环境记录，与仓库解耦后自 2026-09 迁入此处留证）：
 * - 2026-09-02 曾捕获到退出码 0xC0000409 fastfail；当时机器为骁龙 X Elite（arm64 Windows）
 *   + arm64 node，彼时用 pi-x64.cmd/ps1 A/B 启动器（x64 node 模拟层跑同一 cli.js）做对照排查
 *   （未入库）；换 x64 机器后该问题未复现，A/B 启动器随之废弃
 * - 若在其他机器复现同类崩溃，按本补丁的 stderr 落盘通道取证，机器细节记在各自现场，不回填仓库文档
 *
 * 本补丁给 npm 生成的 pi 启动垫片（Windows 的 pi.cmd / pi.ps1；POSIX 的 pi sh 垫片，或
 * npm 11 起的符号链接目标 dist/bundle/cli.js）注入：
 * - --max-old-space-size=8192：排除 V8 堆上限 OOM
 * - --report-on-fatalerror：V8 致命错误诊断报告 → ~/.pi/agent/reports/
 * - stderr 追加落盘 → ~/.pi/agent/pi-stderr-<时间戳>.log（每次启动独立文件，避免多实例写锁；
 *   cmd/sh 用共享追加不受锁影响；ps1 保留 30 天，自动清理旧文件；abort 类死亡的原生栈会落在这里）
 * - pi.ps1 额外记录 [START]/[EXIT] 行（区分正常/异常退出）
 *
 * 旗标注入方式：pi.cmd 的 SETLOCAL 环境在 node 调用同行的 endLocal 时被回收，
 * SET NODE_OPTIONS 走不通，故 cmd 把 node 旗标内联在调用行；ps1/sh 用进程环境变量。
 *
 * POSIX 两种形态：
 * - 旧式 npm sh 垫片（npm ≤10）：脚本内 export NODE_OPTIONS + 调用行尾 2>> 重定向
 * - npm 11 起全局 bin 是符号链接（pi → 包内 dist/bundle/cli.js 的 ESM 垫片）：垫片
 *   自身无法改启动旗标，补丁把它改写为 spawn wrapper——用 node 旗标拉起 cli-runtime.js，
 *   子进程 stderr 落 pi-stderr.log，信号与退出码转发，NODE_COMPILE_CACHE 保留编译缓存
 *
 * 幂等（检测到 v2 标记跳过；自动清理 v1 注入行）。pi 升级（npm i -g）会重写垫片，
 * 届时需重跑本补丁（与其他 patches 同惯例）。
 *
 * 用法：node static/patches/apply-pi-launch-report.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const MARKER = "PI-CRASH-FORENSICS";
const DIR = join(homedir(), ".pi", "agent");
const REPORT_DIR = join(DIR, "reports");
const ERRLOG = join(DIR, "pi-stderr.log");
const NODE_OPTS = "--max-old-space-size=8192 --report-on-fatalerror";
/** cmd 调用行内联旗标段（含前导空格），stripOld 依赖此常量做定点摘除 */
const CMD_FLAGS = ` ${NODE_OPTS} "--report-directory=${REPORT_DIR}"`;

/** 清理历史注入（先摘调用行上的内联部分——整行过滤会误删 node 调用本身，再按行过滤独立注入行） */
function stripOld(s) {
	s = s.replaceAll(CMD_FLAGS, ""); // cmd 调用行内联旗标
	s = s.replace(/ 2>>"[^"]*pi-stderr\.log"/g, ""); // cmd/sh 行尾 stderr 重定向
	s = s.replace(/ 2>> \$piStderr/g, ""); // ps1 行尾 stderr 重定向
	return s
		.split(/\r?\n/)
		.filter(
			(l) =>
				!l.includes("PI-REPORT-PATCH") &&
				!l.includes("PI-CRASH-FORENSICS") &&
				!l.includes("--report-on-fatalerror") &&
				!l.includes("--report-directory") &&
				!l.includes("pi-stderr") &&
				!l.includes("$piStderr") &&
				!l.includes(".pi/agent/reports") &&
				!l.includes(".pi\\\\agent\\\\reports") &&
				!l.includes("agent\\reports"),
		)
		.join("\n");
}

function npmBinDir() {
	try {
		const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
		return join(prefix, process.platform === "win32" ? "" : "bin");
	} catch {
		return process.env.APPDATA ? join(process.env.APPDATA, "npm") : join(homedir(), ".npm-global", "bin");
	}
}

const BIN = npmBinDir();
mkdirSync(REPORT_DIR, { recursive: true });
let patched = 0;

// --- pi.cmd ---
const cmdPath = join(BIN, "pi.cmd");
try {
	let s = stripOld(readFileSync(cmdPath, "utf8"));
	if (s.includes(MARKER)) {
		console.log(`[跳过] ${cmdPath} 已是 v2`);
	} else {
		const inject = [
			"SETLOCAL",
			`REM ${MARKER} v2: 崩溃取证（大堆+诊断报告+stderr落盘），pi 升级后重跑 static/patches/apply-pi-launch-report.mjs`,
			`IF NOT EXIST "${REPORT_DIR}" MD "${REPORT_DIR}"`,
		].join("\r\n");
		s = s.replace("SETLOCAL", inject);
		// node 旗标内联进调用行（SETLOCAL 的环境变量在同行 endLocal 时被回收，SET NODE_OPTIONS 走不通）
		// + 行尾挂 stderr 追加重定向 + 统一回 CRLF（批处理 LF-only 有 GOTO 标签风险）
		s = s.replace(/("%_prog%")([^&\r\n]*%*)(\r?\n)$/, `$1${CMD_FLAGS}$2 2>>"${ERRLOG}"$3`);
		if (!s.includes(CMD_FLAGS)) console.error(`[警告] ${cmdPath} 调用行注入失败，请人工核对`);
		if (!s.includes("\r\n")) s = s.replace(/\n/g, "\r\n");
		writeFileSync(cmdPath, s);
		patched++;
		console.log(`[完成] ${cmdPath}`);
	}
} catch (e) {
	if (e.code === "ENOENT") console.log(`[跳过] ${cmdPath} 不存在（非 Windows 环境）`);
	else console.error(`[失败] ${cmdPath}: ${e.message}`);
}

// --- pi.ps1 ---
const ps1Path = join(BIN, "pi.ps1");
try {
	let s = stripOld(readFileSync(ps1Path, "utf8"));
	if (s.includes(MARKER)) {
		console.log(`[跳过] ${ps1Path} 已是 v2`);
	} else {
		const rep = String(REPORT_DIR).replace(/\\/g, "\\\\");
		const log = String(ERRLOG).replace(/\\/g, "\\\\");
		const inject = [
			`# ${MARKER} v2: 崩溃取证（大堆+诊断报告+stderr落盘），pi 升级后重跑 static/patches/apply-pi-launch-report.mjs`,
			`if (-not (Test-Path "${rep}")) { New-Item -ItemType Directory -Path "${rep}" | Out-Null }`,
			`$env:NODE_OPTIONS = "${NODE_OPTS} --report-directory=${rep}"`,
			`$piStderr = "$env:USERPROFILE\\.pi\\agent\\pi-stderr-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date)  # 每次启动独立文件，避免多实例写锁冲突（cmd 的 2>> 是共享追加不受影响）`,
			`Get-ChildItem "$env:USERPROFILE\\.pi\\agent\\pi-stderr-*.log" -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item -ErrorAction SilentlyContinue`,
			`Add-Content -Path $piStderr -Value "[START $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') args=$args]"`,
		].join("\n");
		s = s.replace("$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent", "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n" + inject);
		// 逐行处理：含 cli.js" $args 的调用行尾挂重定向；$ret=$LASTEXITCODE 后插 EXIT 记录
		s = s
			.split("\n")
			.map((l) => (l.includes('cli.js" $args') && !l.includes("2>>") ? l + " 2>> $piStderr" : l))
			.flatMap((l) =>
				l.trim() === "$ret=$LASTEXITCODE"
					? [l, `  Add-Content -Path $piStderr -Value "[EXIT $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') code=$LASTEXITCODE]"`]
					: [l],
			)
			.join("\n");
		writeFileSync(ps1Path, s);
		patched++;
		console.log(`[完成] ${ps1Path}`);
	}
} catch (e) {
	if (e.code === "ENOENT") console.log(`[跳过] ${ps1Path} 不存在（非 Windows 环境）`);
	else console.error(`[失败] ${ps1Path}: ${e.message}`);
}

// --- pi (sh：旧式垫片 / npm 11 符号链接) ---
const shPath = join(BIN, "pi");
try {
	const raw = readFileSync(shPath, "utf8");
	if (raw.includes(MARKER)) {
		console.log(`[跳过] ${shPath} 已是 v2`);
	} else if (raw.includes("case `uname` in")) {
		// 旧式 npm sh 垫片（npm ≤10 POSIX）：在脚本内注入环境变量与 stderr 重定向
		let s = stripOld(raw);
		const inject = [
			`# ${MARKER} v2: 崩溃取证（大堆+诊断报告+stderr落盘），pi 升级后重跑 static/patches/apply-pi-launch-report.mjs`,
			`mkdir -p "${REPORT_DIR}" 2>/dev/null`,
			`export NODE_OPTIONS="${NODE_OPTS} --report-directory=${REPORT_DIR}"`,
		].join("\n");
		s = s.replace("case `uname` in", inject + "\ncase `uname` in");
		s = s.replaceAll(/(exec "?\$basedir\/node"?|exec node)(\s+"\$basedir\/node_modules\/.*?cli\.js" "\$@")/g, "$1$2 2>>\"" + ERRLOG + '"');
		if (!s.includes("pi-stderr.log")) console.error(`[警告] ${shPath} 调用行注入失败，请人工核对`);
		writeFileSync(shPath, s);
		patched++;
		console.log(`[完成] ${shPath}`);
	} else {
		// npm 11 起 POSIX 全局 bin 是符号链接（pi → 包内 dist/bundle/cli.js 的 ESM 垫片）。
		// 垫片自身无法改启动旗标，故改写为 spawn wrapper：用 node 旗标拉起 cli-runtime.js，
		// 并把子进程 stderr 落到 pi-stderr.log（abort 类原生栈会写在这里）。
		const target = realpathSync(shPath);
		const tRaw = readFileSync(target, "utf8");
		if (tRaw.includes(MARKER)) {
			console.log(`[跳过] ${target} 已是 v2`);
		} else if (tRaw.includes("cli-runtime.js")) {
			const wrapper = [
				"#!/usr/bin/env node",
				`// ${MARKER} v2: 崩溃取证（大堆+诊断报告+stderr落盘），pi 升级后重跑 static/patches/apply-pi-launch-report.mjs`,
				"// 本文件是 pi 包内 bin 垫片（npm 11 POSIX 符号链接的目标），已由补丁改写为取证 wrapper。",
				'import { spawn } from "node:child_process";',
				'import { openSync, mkdirSync } from "node:fs";',
				'import { homedir, tmpdir } from "node:os";',
				'import { join } from "node:path";',
				'import { fileURLToPath } from "node:url";',
				"",
				'const __pfRoot = join(homedir(), ".pi", "agent");',
				'mkdirSync(join(__pfRoot, "reports"), { recursive: true });',
				'const __pfErr = openSync(join(__pfRoot, "pi-stderr.log"), "a");',
				"const __pfChild = spawn(",
				"\tprocess.execPath,",
				"\t[",
				'\t\t"--max-old-space-size=8192",',
				'\t\t"--report-on-fatalerror",',
				'\t\t"--report-directory=" + join(__pfRoot, "reports"),',
				'\t\tfileURLToPath(new URL("./cli-runtime.js", import.meta.url)),',
				"\t\t...process.argv.slice(2),",
				"\t],",
				"\t{",
				'\t\tstdio: ["inherit", "inherit", __pfErr],',
				'\t\tenv: { ...process.env, NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? join(tmpdir(), "node-compile-cache") },',
				"\t},",
				");",
				'for (const __pfSig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(__pfSig, () => __pfChild.kill(__pfSig));',
				'__pfChild.on("exit", (code, signal) => {',
				"\tif (signal) process.kill(process.pid, signal);",
				"\telse process.exit(code ?? 0);",
				"});",
				"",
			].join("\n");
			writeFileSync(target, wrapper);
			patched++;
			console.log(`[完成] ${target}（经符号链接 ${shPath}）`);
		} else {
			console.error(`[警告] ${shPath} 无法识别（既非旧式 sh 垫片也非 npm 11 符号链接），请人工核对`);
		}
	}
} catch (e) {
	if (e.code === "ENOENT") console.log(`[跳过] ${shPath} 不存在`);
	else console.error(`[失败] ${shPath}: ${e.message}`);
}

console.log(`\n共补丁 ${patched} 个垫片。诊断报告：${REPORT_DIR}；stderr 日志：${ERRLOG}`);
console.log("下次无声崩溃后：优先看 pi-stderr.log 尾部（abort 类原生栈会落在这）。");
