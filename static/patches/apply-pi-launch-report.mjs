#!/usr/bin/env node
/**
 * pi 启动垫片补丁：崩溃取证增强（报告级黑匣子）
 *
 * 背景：教研室项目 pi 反复无声崩溃（进程消失、无 JS 异常、无 WER 记录、无 exit 事件），
 * crash-log 扩展只能抓 JS 层异常。本补丁给 npm 生成的 pi 启动垫片注入 NODE_OPTIONS：
 * - --max-old-space-size=8192：排除 V8 堆上限 OOM 类死因（若真是 OOM 顺便直接治好）
 * - --report-on-fatalerror：V8 致命错误（OOM abort / CHECK 失败等，不触发 JS 回调的层级）
 *   自动生成完整诊断报告（JSON：堆统计 + 原生栈 + JS 栈）到 ~/.pi/agent/reports/
 *
 * 打补丁对象：npm 全局 bin 下的 pi.cmd / pi.ps1 / pi（sh）三个垫片；幂等（带标记跳过）。
 * pi 升级（npm i -g）会重写垫片，届时需重跑本补丁（与其他 patches 同惯例）。
 *
 * 用法：node static/patches/apply-pi-launch-report.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const MARKER = "PI-REPORT-PATCH";
const REPORT_DIR = join(homedir(), ".pi", "agent", "reports");
const NODE_OPTS = "--max-old-space-size=8192 --report-on-fatalerror";

// npm 全局 bin 目录（与 pi 同级）
function npmBinDir() {
	try {
		const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
		return join(prefix, process.platform === "win32" ? "" : "bin");
	} catch {
		// 兜底：从本补丁位置推不出，退回 npm 全局默认
		return process.env.APPDATA ? join(process.env.APPDATA, "npm") : join(homedir(), ".npm-global", "bin");
	}
}

const BIN = npmBinDir();
mkdirSync(REPORT_DIR, { recursive: true });
let patched = 0;

// --- pi.cmd：SETLOCAL 后注入 NODE_OPTIONS ---
const cmdPath = join(BIN, "pi.cmd");
try {
	let s = readFileSync(cmdPath, "utf8");
	if (s.includes(MARKER)) {
		console.log(`[跳过] ${cmdPath} 已打补丁`);
	} else {
		const inject = `SETLOCAL\r\nREM ${MARKER}: 崩溃取证（大堆 + 致命错误诊断报告），pi 升级后重跑 static/patches/apply-pi-launch-report.mjs\r\nIF NOT EXIST "${REPORT_DIR}" MD "${REPORT_DIR}"\r\nSET "NODE_OPTIONS=${NODE_OPTS} --report-directory=${REPORT_DIR}"\r\n`;
		if (!s.includes("SETLOCAL")) throw new Error("pi.cmd 结构不符合预期（无 SETLOCAL）");
		s = s.replace("SETLOCAL", inject);
		writeFileSync(cmdPath, s);
		patched++;
		console.log(`[完成] ${cmdPath}`);
	}
} catch (e) {
	console.error(`[失败] ${cmdPath}: ${e.message}`);
}

// --- pi.ps1：$basedir 赋值后注入 ---
const ps1Path = join(BIN, "pi.ps1");
try {
	let s = readFileSync(ps1Path, "utf8");
	if (s.includes(MARKER)) {
		console.log(`[跳过] ${ps1Path} 已打补丁`);
	} else {
		const inject = `\n# ${MARKER}: 崩溃取证（大堆 + 致命错误诊断报告），pi 升级后重跑 static/patches/apply-pi-launch-report.mjs\nif (-not (Test-Path "${REPORT_DIR.replace(/\\/g, "\\\\")}")) { New-Item -ItemType Directory -Path "${REPORT_DIR.replace(/\\/g, "\\\\")}" | Out-Null }\n$env:NODE_OPTIONS = "${NODE_OPTS} --report-directory=${REPORT_DIR.replace(/\\/g, "\\\\")}"\n`;
		s = s.replace("$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent", "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent" + inject);
		writeFileSync(ps1Path, s);
		patched++;
		console.log(`[完成] ${ps1Path}`);
	}
} catch (e) {
	console.error(`[失败] ${ps1Path}: ${e.message}`);
}

// --- pi（sh）：basedir 计算后注入 export ---
const shPath = join(BIN, "pi");
try {
	let s = readFileSync(shPath, "utf8");
	if (s.includes(MARKER)) {
		console.log(`[跳过] ${shPath} 已打补丁`);
	} else {
		const inject = `\n# ${MARKER}: 崩溃取证（大堆 + 致命错误诊断报告），pi 升级后重跑 static/patches/apply-pi-launch-report.mjs\nmkdir -p "${REPORT_DIR}" 2>/dev/null\nexport NODE_OPTIONS="${NODE_OPTS} --report-directory=${REPORT_DIR}"\n`;
		s = s.replace('case `uname` in', inject + "case `uname` in");
		writeFileSync(shPath, s);
		patched++;
		console.log(`[完成] ${shPath}`);
	}
} catch (e) {
	console.error(`[失败] ${shPath}: ${e.message}`);
}

console.log(`\n共补丁 ${patched} 个垫片。诊断报告目录：${REPORT_DIR}`);
console.log("下次若再无声崩溃，查看该目录下的 report-*.json（含堆统计与原生/JS 栈）。");
