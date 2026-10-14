#!/usr/bin/env node
/**
 * keep 扩展回归测试（无 runner，仓库根执行：node src/extensions/test/keep.test.mjs）
 *
 * 原理：esbuild 把扩展 bundle 成单文件 ESM 再 import（同 qr 测试模式），
 * 用假 pi/ctx 直接驱动 on("turn_end") / on("context") / 命令处理器断言行为。
 * 自检的模型调用经环境变量 PI_KEEP_TRIAGE 打桩（模块加载时读取，故每场景独立 import）。
 *
 * 覆盖：
 * - 状态机：默认开 → 工作型停点自检 → A 注入判定块 + 续跑指令并 continue；B/C 挂判定块后停下
 * - 门槛：零工具/只读工具停点不自检；内建与 readOnlyHint=false 工具视为工作
 * - 降级：无法解析、预算耗尽、排队消息、aborted、续跑空转
 * - 过滤：判定块任何位置都不进请求；续跑指令只在末尾活尾巴保留；旧版追问记录被滤掉
 * - 开关：默认开、切换写盘、跨 reload 持久化、带参提示
 * - 挂机（idle）：C 时探一次在场——有回应即停、无回应/按 c 转挂机；挂机轮不再重复探测
 */
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const OUT = path.join(import.meta.dirname, ".tmp-keep.bundle.mjs");

const results = [];
function check(name, ok) {
	results.push({ name, ok });
	console.log(`  ${ok ? "✓" : "✗"} ${name}`);
}

// ---- 测试桩与假环境 ----

const readOnlyTool = (name) => ({ name, description: "", parameters: {}, annotations: { readOnlyHint: true } });
const writeTool = (name) => ({ name, description: "", parameters: {}, annotations: { readOnlyHint: false } });

let importCount = 0;
/** 每个场景独立 import（模块级状态与 PI_KEEP_TRIAGE 不串场；URL 查询串绕过模块缓存） */
async function makeHarness({
	tools = [],
	configPath,
	stub = '{"class":"A","reason":"还差测试","next":"跑测试"}',
	pick,
	mode,
	probe = "stop",
} = {}) {
	process.env.PI_KEEP_CONFIG = configPath ?? path.join(os.tmpdir(), `keep-test-${process.pid}-${importCount}.json`);
	if (stub === null) delete process.env.PI_KEEP_TRIAGE;
	else process.env.PI_KEEP_TRIAGE = stub;
	const mod = await import(pathToFileURL(OUT).href + `?i=${importCount++}`);

	const handlers = {};
	const notifies = [];
	const commands = {};
	const renderers = {};
	const sent = [];
	const pi = {
		registerCommand: (name, def) => (commands[name] = def),
		on: (ev, fn) => (handlers[ev] = fn),
		getAllTools: () => tools,
		getActiveTools: () => tools.map((t) => t.name),
		registerMessageRenderer: (type, r) => (renderers[type] = r),
		sendMessage: (message, options) => sent.push({ message, options }),
	};
	const statuses = [];
	const selects = [];
	const probes = [];
	const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
	const ctx = {
		cwd: process.cwd(),
		mode,
		hasUI: Boolean(mode),
		ui: {
			notify: (text, level) => notifies.push([level, text]),
			setStatus: (key, text) => statuses.push([key, text]),
			// 面板：返回 pick 匹配项（测试预设）；未预设时模拟 Esc/非 TUI
			select: (title, items) => {
				selects.push({ title, items });
				return Promise.resolve(pick ? items.find((t) => t.includes(pick)) : undefined);
			},
			// 在场探测：probe=stop|idle 直接给定结果；key:<键> 走组件真实按键路径；timeout 只留最后 1 秒
			custom: (factory) =>
				new Promise((resolve) => {
					const comp = factory({ requestRender: () => {} }, theme, {}, resolve);
					probes.push(comp);
					if (probe === "timeout") comp.left = 1;
					else if (probe.startsWith("key:")) comp.handleInput(probe.slice(4));
					else resolve(probe);
				}),
		},
		sessionManager: { buildSessionContext: () => ({ messages: [] }) },
	};
	mod.default(pi);

	const answerText = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 5 });
	const turnEnd = (message, extra = {}) =>
		handlers["turn_end"]({ type: "turn_end", message, toolResults: [], outcome: "completed", context: {}, ...extra }, ctx);
	const filter = (messages) => handlers["context"]({ messages }, ctx).messages;
	const work = (toolName = "edit") => handlers["tool_execution_end"]({ toolName }, ctx);
	const newRun = (systemPrompt = "SYS") => handlers["before_agent_start"]({ systemPrompt }, ctx);
	return { handlers, commands, notifies, statuses, selects, probes, sent, ctx, turnEnd, filter, work, newRun, renderers, pi, theme };
}

async function main() {
	await build({
		entryPoints: [path.join(ROOT, "src/extensions/keep.ts")],
		bundle: true,
		format: "esm",
		platform: "node",
		outfile: OUT,
		tsconfig: path.join(ROOT, "src/config/tsconfig.build.json"),
		external: ["@earendil-works/*", "typebox"],
		logLevel: "silent",
	});

	// ---- 状态机 ----
	{
		const h = await makeHarness();
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "做到这里先停了" }], timestamp: 5 });
		const block = r?.entries?.[0];
		const go = r?.entries?.[1];
		check("A → 判定块（display:true）+ 续跑指令（display:false）并 continue",
			r?.continue === true
			&& block?.customType === "keep-verdict" && block.display === true
			&& go?.customType === "keep-go" && go.display === false);
		check("A → 判定块 details 带判定与续航计数",
			block?.details?.cls === "A" && block.details.used === 1 && block.details.next === "跑测试");
		check("A → 状态行显示续航计数", h.statuses.some(([, t]) => t?.includes("续航 1/16")));
	}
	{
		const h = await makeHarness({ stub: '{"class":"B","reason":"要用户选方案"}' });
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("B → 停下（无 continue）", r === undefined);
		check("B → 判定块经 sendMessage 挂出且不触发新轮",
			h.sent.length === 1 && h.sent[0].message.customType === "keep-verdict"
			&& h.sent[0].message.display === true && h.sent[0].options?.triggerTurn === false);
	}
	{
		const h = await makeHarness({ stub: '{"class":"C","reason":"全部完成"}' });
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "完了" }], timestamp: 5 });
		check("C → 停下并挂判定块",
			r === undefined && h.sent.length === 1 && h.sent[0].message.details.cls === "C");
	}
	{
		const h = await makeHarness({ stub: '分析一下：{"class":"A","reason":"剩收尾","next":"收尾"} 以上。' });
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("解析加固：散文裹 JSON → 捞出并续跑", r?.continue === true && r.entries[1].customType === "keep-go");
	}
	{
		const h = await makeHarness({ stub: "我觉得可能是 A 吧" });
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("回答无法解析 → 停下并通知",
			r === undefined && h.sent.length === 0 && h.notifies.some(([, t]) => t.includes("自检未判定")));
	}

	// ---- 触发门槛 ----
	{
		const h = await makeHarness();
		h.newRun();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "这是答案" }], timestamp: 5 });
		check("零工具轮（纯问答）不自检", r === undefined && h.sent.length === 0);
	}
	{
		const h = await makeHarness({ tools: [readOnlyTool("kb_search")] });
		h.newRun();
		h.work("kb_search");
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "调研结论" }], timestamp: 5 });
		check("只读工具轮不自检", r === undefined && h.sent.length === 0);
	}
	{
		const h = await makeHarness({ tools: [writeTool("kb_write")] });
		h.newRun();
		h.work("kb_write");
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("readOnlyHint=false 工具轮 → 自检", r?.continue === true);
	}
	{
		const h = await makeHarness({ tools: [{ name: "mcp_thing", description: "", parameters: {} }] });
		h.newRun();
		h.work("mcp_thing");
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("无注解工具按只读 → 不自检", r === undefined && h.sent.length === 0);
	}
	{
		const h = await makeHarness();
		h.newRun();
		h.work("bash");
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("内建 bash 视为工作 → 自检", r?.continue === true);
	}

	// ---- 降级与防护 ----
	{
		const h = await makeHarness();
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 }, { context: { pendingMessages: [{ role: "user" }] } });
		check("有排队消息不自检", r === undefined && h.sent.length === 0);
	}
	{
		const h = await makeHarness();
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 }, { outcome: "aborted" });
		check("aborted 不动作", r === undefined && h.sent.length === 0);
	}
	{
		const h = await makeHarness();
		h.newRun();
		h.work();
		const r1 = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("续跑注入成功（前置）", r1?.continue === true);
		const r2 = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "又停了" }], timestamp: 5 });
		check("续跑轮仍无 toolCall → 直接停（防死循环）",
			r2 === undefined && h.notifies.some(([, t]) => t.includes("无实际动作")));
	}
	{
		const h = await makeHarness();
		const withToolCall = () => ({ role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit", arguments: {} }], timestamp: 5 });
		const stop = () => ({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		h.newRun();
		let used = 0;
		for (let i = 0; i < 20; i++) {
			h.work();
			await h.turnEnd(withToolCall()); // 续跑轮干活（清 awaitingGo）
			h.work();
			const r = await h.turnEnd(stop()); // 自然停点 → 自检
			if (r?.continue !== true) break;
			used++;
		}
		check("预算 16 次内每次都能续跑", used === 16);
		h.work();
		await h.turnEnd(withToolCall());
		h.work();
		const last = await h.turnEnd(stop());
		check("预算用完后强制停并通知",
			last === undefined && h.notifies.some(([, t]) => t.includes("预算")));
	}

	// ---- 开关 ----
	{
		const h = await makeHarness();
		await h.commands["keep"].handler("off", h.ctx); // 直设等级：关闭
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("/keep 关闭后不自检", r === undefined && h.sent.length === 0);
		check("等级已写盘", JSON.parse(readFileSync(process.env.PI_KEEP_CONFIG, "utf8")).level === "off");
		const h2 = await makeHarness({ configPath: process.env.PI_KEEP_CONFIG });
		h2.newRun();
		h2.work();
		const r2 = await h2.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("持久化：reload 后仍为 off", r2 === undefined);
		await h2.commands["keep"].handler("default", h2.ctx);
		const h3 = await makeHarness({ configPath: process.env.PI_KEEP_CONFIG });
		h3.newRun();
		h3.work();
		const r3 = await h3.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("持久化：改回 default 后 reload 仍续航", r3?.continue === true);
	}
	{
		const h = await makeHarness();
		await h.commands["keep"].handler("多余的参数", h.ctx);
		check("非法等级给用法提示", h.notifies.some(([k]) => k === "warning"));
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("非法等级不改变当前档（仍为 default）", r?.continue === true);
	}

	// ---- 渲染 ----
	{
		const h = await makeHarness();
		check("判定块渲染器已注册", typeof h.renderers["keep-verdict"] === "function");
		const theme = { fg: (_c, t) => t, bg: (_c, t) => t };
		const comp = h.renderers["keep-verdict"](
			{ details: { cls: "B", reason: "要人拍板", used: 1, budget: 16 } },
			{ expanded: false, outputPad: 1 },
			theme,
		);
		check("渲染器返回组件（不抛错）", !!comp && typeof comp.render === "function");
	}

	// ---- 上下文过滤 ----
	{
		const h = await makeHarness();
		const user = () => ({ role: "user", content: "原始需求", timestamp: 1 });
		const assistant = () => ({ role: "assistant", content: [{ type: "text", text: "干活" }], timestamp: 2 });
		const verdict = () => ({ role: "custom", customType: "keep-verdict", content: "块", display: true, timestamp: 3 });
		const go = () => ({ role: "custom", customType: "keep-go", content: "指令", display: false, timestamp: 4 });
		const oldAsk = () => ({ role: "custom", customType: "keep-ask", content: "问", display: false, timestamp: 5 });
		const oldAnswer = () => ({ role: "assistant", content: [{ type: "text", text: '{"class":"A"}' }], timestamp: 6 });

		const done = h.filter([user(), assistant(), verdict(), go(), assistant()]);
		check("过滤：已完成的判定块与续跑指令都被滤掉",
			done.length === 3 && done.every((m) => m.role !== "custom"));
		const live = h.filter([user(), assistant(), verdict(), go()]);
		check("过滤：活尾巴保留续跑指令、滤掉判定块",
			live.length === 3 && live[2].customType === "keep-go");
		const plain = h.filter([user(), assistant()]);
		check("过滤：无 keep 消息原样通过", plain.length === 2);
		const legacy = h.filter([user(), oldAsk(), oldAnswer(), assistant()]);
		check("过滤：旧版追问记录被滤掉", legacy.length === 2);
	}

	// ---- 等级面板 ----
	{
		const h = await makeHarness({ pick: "空档" });
		await h.commands["keep"].handler("", h.ctx);
		check("面板列出三档", h.selects.length === 1 && h.selects[0].items.length === 3);
		check("面板选择写入 idle", JSON.parse(readFileSync(process.env.PI_KEEP_CONFIG, "utf8")).level === "idle");
	}
	{
		const h = await makeHarness(); // 未预设 pick = Esc / 非 TUI
		await h.commands["keep"].handler("", h.ctx);
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("面板取消不改档（仍是 default：续航生效）", r?.continue === true);
	}

	// ---- 挂机（idle）档：完成时探一次在场，脱机才推进挂机工作 ----
	{
		// 人工闸门各档一致：B 带 next 也停
		const h = await makeHarness({ stub: '{"class":"B","reason":"要用户选方案","next":"先补个测试"}' });
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("default 档：B 带 next 也停下（人工闸门）",
			r === undefined && h.sent.length === 1 && h.sent[0].message.details.idle === false);
	}
	{
		const h = await makeHarness({
			stub: '{"class":"B","reason":"要用户选方案","next":"先补个测试"}',
			mode: "tui",
			probe: "idle",
		});
		await h.commands["keep"].handler("idle", h.ctx);
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "停" }], timestamp: 5 });
		check("idle 档：B 也一律停（next 不再触发挂机，也不探测）",
			r === undefined && h.sent.length === 1 && h.probes.length === 0);
	}
	{
		// 在场回应（任意键）→ 视为在场，按 default 停
		const h = await makeHarness({ stub: '{"class":"C","reason":"全部完成"}', mode: "tui", probe: "key:x" });
		await h.commands["keep"].handler("idle", h.ctx);
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "完了" }], timestamp: 5 });
		check("idle 档：C + 在场回应 → 探测一次后停下",
			r === undefined && h.probes.length === 1 && h.sent.length === 1
			&& h.sent[0].message.details.cls === "C" && h.sent[0].message.details.idle === false);
	}
	{
		// 探测超时（脱机）→ 注入挂机指令续跑
		const h = await makeHarness({ stub: '{"class":"C","reason":"全部完成"}', mode: "tui", probe: "timeout" });
		await h.commands["keep"].handler("idle", h.ctx);
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "完了" }], timestamp: 5 });
		const go = r?.entries?.[1];
		check("idle 档：C + 探测超时 → 注入挂机指令并 continue",
			r?.continue === true && r.entries[0].details.idle === true && go?.customType === "keep-go");
		check("挂机指令：写死唯一判据（无需拍板 + 不产生后继任务）",
			go?.content.includes("唯一判据") && go?.content.includes("需要用户拍板")
			&& go?.content.includes("需要人工处理的后继任务") && go?.content.includes("反面清单"));
		check("挂机指令：示例项仍是清账类、无不一致可清就停",
			go?.content.includes("文档时效性") && go?.content.includes("没有可清的账")
			&& go?.content.includes("不改代码语义"));
		check("挂机：状态行显示挂机计数", h.statuses.some(([, t]) => t?.includes("挂机 1/4")));

		// 挂机轮再停（仍 C）：不再重复探测，直接续下一件
		h.work();
		await h.turnEnd({ role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit", arguments: {} }], timestamp: 5 }); // 挂机轮干活（清 awaitingGo）
		const r2 = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "这件做完了" }], timestamp: 5 });
		check("挂机阶段：再停不再探测，直接续下一件",
			r2?.continue === true && h.probes.length === 1 && r2.entries[0].details.idle === true);

		// 领满 IDLE_MAX 件后：不再续跑，停下并告知
		for (let i = 0; i < 3; i++) {
			h.work();
			await h.turnEnd({ role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "edit", arguments: {} }], timestamp: 5 });
			await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "这件也做完了" }], timestamp: 5 });
		}
		h.work();
		await h.turnEnd({ role: "assistant", content: [{ type: "toolCall", id: "t9", name: "edit", arguments: {} }], timestamp: 5 });
		const capped = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "又停下来了" }], timestamp: 5 });
		check("挂机：领满 4 件后停下（不再续跑）", capped === undefined || capped?.continue !== true);
		check("挂机：预算用完给出一句提醒", h.notifies.some(([, t]) => t?.includes("挂机已做满 4 件")));
	}
	{
		// 探测面板：倒计时按 PROBE_MS 起算（3 分钟），文案点明两种出口
		const h = await makeHarness({ stub: '{"class":"C","reason":"全部完成"}', mode: "tui", probe: "stop" });
		await h.commands["keep"].handler("idle", h.ctx);
		h.newRun();
		h.work();
		await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "完了" }], timestamp: 5 });
		const lines = h.probes[0].render(70).join("\n");
		check("探测面板：倒计时从 180 秒（3 分钟）起算", h.probes[0].left === 180);
		check("探测面板：文案点明自动挂机与 c 快捷键",
			lines.includes("秒后自动开始挂机工作") && lines.includes("c 立即开始挂机"));
	}
	{
		// c 键：离开前主动放行
		const h = await makeHarness({ stub: '{"class":"C","reason":"全部完成"}', mode: "tui", probe: "key:c" });
		await h.commands["keep"].handler("idle", h.ctx);
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "完了" }], timestamp: 5 });
		check("探测面板：c 键立即转挂机", r?.continue === true && r.entries[0].details.idle === true);
	}
	{
		// default 档：C 不探测，直接停
		const h = await makeHarness({ stub: '{"class":"C","reason":"全部完成"}', mode: "tui", probe: "idle" });
		h.newRun();
		h.work();
		const r = await h.turnEnd({ role: "assistant", content: [{ type: "text", text: "完了" }], timestamp: 5 });
		check("default 档：C 不探测，直接停", r === undefined && h.probes.length === 0);
	}
	{
		// 渲染器：C + 挂机标记 → 显示挂机计数
		const h = await makeHarness();
		const comp = h.renderers["keep-verdict"](
			{ details: { cls: "C", reason: "全部完成", next: "", used: 2, budget: 4, idle: true } },
			{ expanded: false, outputPad: 1 },
			h.theme,
		);
		const text = typeof comp?.render === "function" ? comp.render(80).join("\n") : "";
		check("渲染器：判定块显示「已完成 · 挂机 2/4」", text.includes("已完成") && text.includes("挂机 2/4"));
	}

	const failed = results.filter((r) => !r.ok);
	console.log(failed.length === 0 ? "\n全部通过 ✓" : `\n${failed.length} 项失败 ✗`);
	rmSync(OUT, { force: true });
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	rmSync(OUT, { force: true });
	process.exit(1);
});
