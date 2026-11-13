#!/usr/bin/env node
/**
 * crash-log 回归测试
 *
 * 原理：esbuild 把 crash-log.ts 打成**两份**独立 bundle（同一进程里两个模块实例 = 模拟
 * `/reload` 重新加载扩展），并用 `PI_CRASH_LOG_FILE` 把日志指向临时目录，不碰真实
 * ~/.pi/agent/pi-crash.log。
 *
 * 覆盖：
 * - 场景 A：启动头与 process 监听器只在进程首次加载时挂一次（/reload 不重复写、不重复挂）
 * - 场景 B：有崩溃记录时 session_start 提示一次；同一条不再重复提示；无 UI 不提示
 * - 场景 C：出现新崩溃后再提示一次
 * - 场景 D：/crash-log 视图视为已看、clear 清空日志与 ack
 *
 * 用法：node src/extensions/test/crash-log.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../..");
let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
		failures++;
	}
};

const tmp = mkdtempSync(join(tmpdir(), "crash-log-test-"));
const LOG = join(tmp, "pi-crash.log");
const ACK = join(tmp, "crash-log-ack.json");
process.env.PI_CRASH_LOG_FILE = LOG;

const BUNDLES = [join(TEST_DIR, ".tmp-crash-log-a.mjs"), join(TEST_DIR, ".tmp-crash-log-b.mjs")];

async function load(bundleFile) {
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "crash-log.ts")],
		outfile: bundleFile,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});
	return import(`${pathToFileURL(bundleFile).href}?t=${Date.now()}${Math.random()}`);
}

/** pi API mock：收集事件与命令处理器 */
function makePi() {
	const events = {};
	const commands = {};
	return {
		events,
		commands,
		on: (name, handler) => {
			events[name] = handler;
		},
		registerCommand: (name, def) => {
			commands[name] = def;
		},
	};
}

const makeCtx = (notices, hasUI = true) => ({
	cwd: process.cwd(),
	hasUI,
	ui: { notify: (message, kind) => notices.push({ message, kind }) },
});

const crashEntry = (ts) => `--- [${ts}] UNCAUGHT EXCEPTION (pid 4242) ---\nError: boom\n`;

const logText = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "");
const countHeaders = () => logText().split("\n").filter((l) => l.startsWith("=== [")).length;

async function main() {
	const before = process.listenerCount("uncaughtException");

	// ---- 场景 A：/reload 不重复挂监听器、不重复写启动头 ----
	console.log("场景 A：进程级守卫");
	const modA = (await load(BUNDLES[0])).default;
	const piA = makePi();
	modA(piA);
	check("A: 首次加载写了启动头", countHeaders() === 1, String(countHeaders()));
	check("A: 首次加载挂了 uncaughtException 监听器", process.listenerCount("uncaughtException") === before + 1);

	const modB = (await load(BUNDLES[1])).default;
	const piB = makePi();
	modB(piB);
	check("A: 再次加载（模拟 /reload）不重复写启动头", countHeaders() === 1, String(countHeaders()));
	check("A: 再次加载不重复挂监听器", process.listenerCount("uncaughtException") === before + 1, String(process.listenerCount("uncaughtException")));

	// ---- 场景 B：同一条崩溃只提示一次 ----
	console.log("场景 B：崩溃提示去重");
	writeFileSync(LOG, logText() + crashEntry("2026-01-01T00:00:00.000Z"), "utf8");
	const notices = [];
	await piA.events.session_start({}, makeCtx(notices));
	check("B: 有崩溃记录时提示一次", notices.length === 1 && notices[0].kind === "warning", JSON.stringify(notices));
	check("B: 提示里带崩溃时间", notices[0]?.message.includes("2026-01-01T00:00:00.000Z"));
	check("B: 提示后写了 ack", existsSync(ACK) && readFileSync(ACK, "utf8").includes("2026-01-01T00:00:00.000Z"));

	const again = [];
	await piA.events.session_start({}, makeCtx(again));
	check("B: 同一条崩溃不再重复提示", again.length === 0, JSON.stringify(again));

	// 会话标记照旧写入（与会话文件配对用）
	check("B: session_start 仍记进日志", (logText().match(/session_start cwd=/g) ?? []).length === 2);

	// ---- 场景 C：新崩溃再提示一次 ----
	console.log("场景 C：新崩溃");
	writeFileSync(LOG, logText() + crashEntry("2026-02-02T00:00:00.000Z"), "utf8");
	const fresh = [];
	await piA.events.session_start({}, makeCtx(fresh));
	check("C: 新崩溃再提示一次", fresh.length === 1 && fresh[0].message.includes("2026-02-02T00:00:00.000Z"), JSON.stringify(fresh));

	// ---- 场景 D：/crash-log 视图与 clear ----
	console.log("场景 D：/crash-log");
	const viewNotices = [];
	writeFileSync(LOG, logText() + crashEntry("2026-03-03T00:00:00.000Z"), "utf8");
	await piA.commands["crash-log"].handler("", makeCtx(viewNotices));
	check("D: 无参视图报告最近一条崩溃", viewNotices[0]?.message.includes("最近一条崩溃记录："), viewNotices[0]?.message?.slice(0, 40));
	check("D: 视图把最新崩溃标为已看", readFileSync(ACK, "utf8").includes("2026-03-03T00:00:00.000Z"));
	const afterView = [];
	await piA.events.session_start({}, makeCtx(afterView));
	check("D: 看过之后不再提示", afterView.length === 0, JSON.stringify(afterView));

	const clearNotices = [];
	await piA.commands["crash-log"].handler("clear", makeCtx(clearNotices));
	check("D: clear 后日志与 ack 都没了", !existsSync(LOG) && !existsSync(ACK));
	check("D: clear 有回执", clearNotices[0]?.message.includes("已清空"), JSON.stringify(clearNotices));

	// ---- 场景 E：无 UI 时不提示（也不崩） ----
	console.log("场景 E：无 UI 降级");
	writeFileSync(LOG, crashEntry("2026-04-04T00:00:00.000Z"), "utf8");
	const silent = [];
	await piA.events.session_start({}, makeCtx(silent, false));
	check("E: 无 UI 时不提示", silent.length === 0);
	check("E: 无 UI 时不写 ack（下次有 UI 仍会提醒）", !existsSync(ACK));
}

try {
	await main();
} finally {
	rmSync(tmp, { recursive: true, force: true });
	for (const b of BUNDLES) rmSync(b, { force: true });
}
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
