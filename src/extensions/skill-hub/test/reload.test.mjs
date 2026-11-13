#!/usr/bin/env node
/**
 * skill-hub 重载调度回归测试（纯逻辑，离线）
 *
 * 覆盖 reload.ts 的调度决策：
 * - A 空闲入口：立即派发重载子命令（expandPromptTemplates），不发 steer
 * - B 轮中入口：先 steer 收尾、不立即派发；agent_settled 后补发重载子命令
 * - C 去重：轮中多次 schedule 只 steer 一次；settled 只派发一次
 * - D 中断：settled 时 aborted=true 仍重载，但清掉续跑标记
 * - E 续跑：session_start(reason=reload) 按 globalThis 标记发续跑消息；其他原因只清标记
 * - F 面板闸门：面板开着时不立即重载；面板关闭后（空闲）补发；仍忙则留给 settled
 *
 * 用法：node src/extensions/skill-hub/test/reload.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, ".tmp-reload-bundle.mjs");
await build({
	entryPoints: [join(here, "../reload.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	outfile: bundlePath,
	external: ["@earendil-works/*"],
});

const { createReloadScheduler, RELOAD_DISPATCH, RESUME_KEY, STEER_TEXT } = await import(pathToFileURL(bundlePath).href);

let passed = 0;
let failed = 0;
function check(name, cond) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}`);
	}
}

function setup() {
	delete globalThis[RESUME_KEY];
	const sent = [];
	const pi = { sendUserMessage: (text, options) => sent.push({ text, options }) };
	const scheduler = createReloadScheduler(pi);
	const ctxOf = (idle) => ({ isIdle: () => idle });
	return { sent, scheduler, ctxOf };
}
const isDispatch = (m) => m.text === RELOAD_DISPATCH && m.options?.expandPromptTemplates === true;
const isSteer = (m) => m.text === STEER_TEXT && m.options?.deliverAs === "steer";
const tick = () => new Promise((r) => setTimeout(r, 20));

console.log("A 空闲入口：立即派发重载命令");
{
	const { sent, scheduler, ctxOf } = setup();
	scheduler.schedule(ctxOf(true), null);
	check("A1 立即派发重载命令", sent.length === 1 && isDispatch(sent[0]));
	check("A2 不发 steer", !sent.some(isSteer));
}

console.log("B 轮中入口：steer 收尾，settled 后重载");
{
	const { sent, scheduler, ctxOf } = setup();
	scheduler.schedule(ctxOf(false), "继续任务");
	check("B1 只发 steer，不立即派发", sent.length === 1 && isSteer(sent[0]));
	check("B2 续跑标记已写", globalThis[RESUME_KEY] === "继续任务");
	scheduler.settled(false);
	check("B3 settled 后派发重载命令", sent.length === 2 && isDispatch(sent[1]));
	check("B4 settled 后再次 settled 不重复派发", (scheduler.settled(false), sent.length === 2));
}

console.log("C 去重");
{
	const { sent, scheduler, ctxOf } = setup();
	scheduler.schedule(ctxOf(false), null);
	scheduler.schedule(ctxOf(false), null);
	check("C1 轮中多次 schedule 只 steer 一次", sent.filter(isSteer).length === 1);
	scheduler.settled(false);
	check("C2 settled 只派发一次", sent.filter(isDispatch).length === 1);
}

console.log("D 中断：仍重载但不续跑");
{
	const { sent, scheduler, ctxOf } = setup();
	scheduler.schedule(ctxOf(false), "继续任务");
	scheduler.settled(true);
	check("D1 仍派发重载", sent.some(isDispatch));
	check("D2 续跑标记被清", globalThis[RESUME_KEY] === undefined);
}

console.log("E 续跑");
{
	const { sent, scheduler, ctxOf } = setup();
	scheduler.schedule(ctxOf(false), "继续任务");
	scheduler.settled(false);
	scheduler.sessionStarted("reload");
	await tick();
	check("E1 reload 后发出续跑消息", sent.some((m) => m.text === "继续任务" && !m.options));
	check("E2 标记已消费", globalThis[RESUME_KEY] === undefined);
}
{
	const { sent, scheduler, ctxOf } = setup();
	scheduler.schedule(ctxOf(false), "继续任务");
	scheduler.sessionStarted("new");
	await tick();
	check("E3 非 reload 的 session_start 只清标记不续跑", !sent.some((m) => m.text === "继续任务") && globalThis[RESUME_KEY] === undefined);
}

console.log("F 面板闸门");
{
	const { sent, scheduler, ctxOf } = setup();
	scheduler.panelOpened();
	scheduler.schedule(ctxOf(true), null);
	check("F1 面板开着、空闲也不立即派发", sent.length === 0);
	scheduler.panelClosed(ctxOf(true));
	check("F2 面板关闭后补发重载", sent.length === 1 && isDispatch(sent[0]));
}
{
	const { sent, scheduler, ctxOf } = setup();
	scheduler.panelOpened();
	scheduler.schedule(ctxOf(false), null);
	check("F3 面板开着且轮中：steer 已发、未派发", sent.length === 1 && isSteer(sent[0]));
	scheduler.panelClosed(ctxOf(false));
	check("F4 面板关闭但仍忙：不派发", sent.filter(isDispatch).length === 0);
	scheduler.settled(false);
	check("F5 settled 兜底派发", sent.filter(isDispatch).length === 1);
}

fs.rmSync(bundlePath, { force: true });
console.log(failed ? `\n${failed} 个失败` : "\n全部通过 ✓");
process.exit(failed ? 1 : 0);
