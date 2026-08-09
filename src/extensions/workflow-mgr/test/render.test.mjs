#!/usr/bin/env node
/**
 * workflow-mgr 渲染回归测试（需求第 5 条强烈建议项）
 *
 * 目的：抓「Box is not defined」这类 import 漏写、布局拆行、宽度溢出等问题
 * （真实踩过的坑）。覆盖三态渲染 + 核心工具流程：
 * - 场景 A：示例工作流（中文任务名）→ 常驻 widget + /workflow-config 完整面板
 * - 场景 B：空工作流 → 面板不崩溃、显示「无任务」引导
 * - 场景 C：全部任务 done → 面板显示完成态
 * - 流程：wf_start → wf_done 自动推进 → state.json 落盘可复查
 * - 开关：/workflow-config toggle → widget 移除 + config.json 持久化
 *
 * 原理：node 无法直接 import 无扩展名相对路径（"../shared/config"），故先用
 * esbuild（src/node_modules 构建依赖）把扩展 bundle 成单文件 ESM 再 import；
 * bundle 的 external 白名单与 build.js 一致（@earendil-works/*、typebox），
 * 运行时由 node 从本目录 node_modules junction（→ pi 全局）解析。
 * theme mock 用纯文本（(c,t)=>t）——样式 token 会干扰 visibleWidth 宽度计算。
 *
 * 用法：node src/extensions/workflow-mgr/test/render.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const EXT_DIR = join(TEST_DIR, ".."); // src/extensions/workflow-mgr/
const SRC_DIR = join(EXT_DIR, "../.."); // src/
const BUNDLE = join(TEST_DIR, ".tmp-bundle.mjs");

let failures = 0;
const check = (name, cond) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}`);
		failures++;
	}
};

/** 纯文本 theme mock：样式 token 全部透传，不干扰宽度计算 */
const themeMock = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };

/** mock pi：收集注册的工具/命令/事件 */
function makePi() {
	return {
		tools: [],
		commands: {},
		events: {},
		registerTool(t) {
			this.tools.push(t);
		},
		registerCommand(name, c) {
			this.commands[name] = c;
		},
		on(ev, cb) {
			this.events[ev] = cb;
		},
	};
}

/** mock ctx：cwd 指向 fixture 目录，ui 捕获 widget/status/notify/custom 到 captures */
function makeCtx(cwd, captures = {}) {
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			setWidget: (id, factory, opts) => {
				captures.widget = { id, factory, opts };
			},
			setStatus: (key, text) => {
				captures.status = { key, text };
			},
			notify: (text, kind) => {
				captures.notify = { text, kind };
			},
			custom: async (fn) => {
				captures.custom = fn;
			},
		},
	};
}

/** 写 fixture 工作目录 */
function makeFixture(workflowJson, stateJson = null, configJson = null) {
	const dir = mkdtempSync(join(tmpdir(), "wfmg-test-"));
	const wfDir = join(dir, ".pi", "workflow");
	mkdirSync(wfDir, { recursive: true });
	writeFileSync(join(wfDir, "workflow.json"), JSON.stringify(workflowJson, null, 2), "utf8");
	if (stateJson) writeFileSync(join(wfDir, "state.json"), JSON.stringify(stateJson, null, 2), "utf8");
	if (configJson) writeFileSync(join(wfDir, "config.json"), JSON.stringify(configJson, null, 2), "utf8");
	return dir;
}

/** 渲染 widget 并断言：不抛异常 + 每行不超宽 */
function assertWidget(pi, ctx, label, width = 80) {
	const captures = {};
	const ctx2 = makeCtx(ctx.cwd, captures);
	// 触发 session_start 重建缓存并推 widget
	await0(pi, ctx2, "session_start");
	const widget = captures.widget;
	if (!widget) {
		check(`${label}: session_start 推送了 widget`, false);
		return null;
	}
	check(`${label}: placement 为 belowEditor`, widget.opts?.placement === "belowEditor");
	let lines = [];
	try {
		const w = widget.factory(null, themeMock);
		lines = w.render(width);
	} catch (e) {
		check(`${label}: widget 渲染不抛异常`, false);
		console.error("      →", e.message);
		return null;
	}
	check(`${label}: widget 渲染不抛异常`, true);
	check(`${label}: 渲染行数 > 0（${lines.length}）`, lines.length > 0);
	for (const [i, line] of lines.entries()) {
		const w = visibleWidth(line);
		if (w > width) {
			check(`${label}: 第 ${i} 行宽度 ${w} ≤ ${width}`, false);
			console.error("      →", JSON.stringify(line.slice(0, 80)));
		}
	}
	return lines;
}

/** 触发 pi 事件（包装 async 回调） */
async function fireEvent(pi, ctx, ev) {
	const cb = pi.events[ev];
	if (cb) await cb({}, ctx);
}

async function await0(pi, ctx, ev) {
	await fireEvent(pi, ctx, ev);
}

/* ============================== 场景 A：示例工作流 ============================== */
async function scenarioA() {
	console.log("\n场景 A：示例工作流（中文任务名 + 宽度断言）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	// 写真实 workflow.json（同示例工作流：4 任务）——文件存在 → 面板显示
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	const caps = {};
	const ctx = makeCtx(dir, caps);

	const lines = assertWidget(pi, ctx, "常驻 widget");
	if (lines) {
		// Box 版无边框：行 0 是任务行（Box 上下无 padding）
		check("行 1 显示当前任务 0.1", lines[0].includes("0.1"));
		check("行 1 含进度条块元素", lines[0].includes("░"));
		check("待开始任务无前缀标记", !lines[0].includes("▶") && !lines[0].includes("· "));
		check("分工行含 你:/AI:", lines.some((l) => l.includes("你:")) && lines.some((l) => l.includes("AI:")));
	}

	// /workflow-config 统一功能菜单（TUI 浮窗，字符边框）
	const caps2 = {};
	const ctx2 = makeCtx(dir, caps2);
	let menuComp = null;
	await pi.commands["workflow-config"].handler("", ctx2);
	if (caps2.custom) menuComp = caps2.custom(null, themeMock, {}, () => {});
	const menuLines = menuComp?.render(100);
	check("/workflow-config 菜单浮窗渲染", !!menuLines);
	if (menuLines) {
		check("浮窗有边框（┌┐└┘）", menuLines[0].includes("┌") && menuLines[0].includes("┐") && menuLines[menuLines.length - 1].includes("└") && menuLines[menuLines.length - 1].includes("┘"));
		check("菜单收纳 2 项功能", menuLines.some((l) => l.includes("显示详细信息")) && menuLines.some((l) => l.includes("常驻面板")));
		const over = menuLines.map((l) => visibleWidth(l)).filter((w) => w > 100);
		check("菜单行宽 ≤ 100", over.length === 0);
	}
	check("未注册别名 /wfmg（只需 /workflow-config）", !pi.commands.wfmg);
	// 子命令已删除（0.4 拍板：只留无参）——任意子命令参数一律走无参浮窗逻辑，不产生状态变更
	const caps3 = {};
	const ctx3 = makeCtx(dir, caps3);
	await pi.commands["workflow-config"].handler("done 0.1", ctx3);
	check("子命令已删除：done 参数走无参浮窗（不弹子命令逻辑）", caps3.custom !== undefined);
	const stPath = join(dir, ".pi", "workflow", "state.json");
	const stAfter = existsSync(stPath) ? JSON.parse(readFile(stPath)) : null;
	check("子命令不产生状态变更（0.1 仍非 done）", !stAfter || stAfter.tasks["0.1"]?.status !== "done");

	// 工具流程：wf_switch 一次调用完成+推进（替代 start+done 两步）
	const s = pi.tools.find((t) => t.name === "wf_status");
	const sw = pi.tools.find((t) => t.name === "wf_switch");
	check("注册了 wf_status/wf_switch，wf_start/wf_done 已删除", !!s && !!sw && !pi.tools.find((t) => t.name === "wf_start") && !pi.tools.find((t) => t.name === "wf_done"));

	const r1 = await sw.execute("1", {}, undefined, undefined, ctx);
	check("wf_switch 无参：完成 0.1 并开始 0.2", r1.content[0].text.includes("已完成任务 0.1") && r1.content[0].text.includes("0.2"));
	const r2 = await sw.execute("2", {}, undefined, undefined, ctx);
	check("wf_switch 无参：完成 0.2 并开始 1.1（依赖 0.2）", r2.content[0].text.includes("已完成任务 0.2") && r2.content[0].text.includes("1.1"));
	const r3 = await sw.execute("3", {}, undefined, undefined, ctx);
	check("wf_switch 无参：完成 1.1 并开始 1.2", r3.content[0].text.includes("已完成任务 1.1") && r3.content[0].text.includes("1.2"));
	const r4 = await sw.execute("4", {}, undefined, undefined, ctx);
	check("wf_switch 无参：全部完成后提示收尾", r4.content[0].text.includes("全部任务完成"));
	const stateFile = join(dir, ".pi", "workflow", "state.json");
	check("state.json 已落盘", existsSync(stateFile));
	const saved = JSON.parse(readFile(stateFile));
	check("state.json 全部任务 done、currentTaskId null", saved.currentTaskId === null && Object.values(saved.tasks).every((t) => t.status === "done"));

	// wf_workflow add/edit/remove
	const wf = pi.tools.find((t) => t.name === "wf_workflow");
	const add = await wf.execute("5", { action: "add", stageId: "stage2", stageName: "维护", title: "写 README", humanTasks: ["校对"], aiTasks: ["起草"], deliverable: "README.md", doneSignal: "用户确认", deps: ["1.2"] }, undefined, undefined, ctx);
	check("wf_workflow add 新阶段新任务", add.content[0].text.includes("2.1") && add.content[0].text.includes("维护"));
	const add2 = await wf.execute("6", { action: "add", stageId: "stage2", title: "备份数据" }, undefined, undefined, ctx);
	check("add 自动生成 2.2", add2.content[0].text.includes("2.2"));
	const list = await wf.execute("7", { action: "list" }, undefined, undefined, ctx);
	const m = /共 (\d+) 个阶段、(\d+) 个任务/.exec(list.content[0].text);
	check("list 显示 3 阶段 6 任务（不依赖中文数字硬编码）", !!m && m[1] === "3" && m[2] === "6");
	const rm = await wf.execute("8", { action: "remove", taskId: "2.2" }, undefined, undefined, ctx);
	check("remove 删除 2.2", rm.content[0].text.includes("已删除任务 2.2"));
	const rmStage = await wf.execute("9", { action: "remove", taskId: "2.1" }, undefined, undefined, ctx);
	check("remove 空阶段自动移除", rmStage.content[0].text.includes("已清空并移除"));

	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 B：空工作流 ============================== */
async function scenarioB() {
	console.log("\n场景 B：空工作流（面板不崩溃 + 引导文案）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture({ schemaVersion: 1, stages: [] });
	const ctx = makeCtx(dir);

	const lines = assertWidget(pi, ctx, "空工作流 widget");
	if (lines) check("显示「无任务」引导", lines[0].includes("无任务"));
	const s = pi.tools.find((t) => t.name === "wf_status");
	const r = await s.execute("1", {}, undefined, undefined, ctx);
	check("wf_status 提示工作流为空", r.content[0].text.includes("工作流为空"));
	const sw = pi.tools.find((t) => t.name === "wf_switch");
	const rs = await sw.execute("2", {}, undefined, undefined, ctx);
	check("wf_switch 空工作流报错", rs.content[0].text.includes("工作流为空"));
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 C：全部完成 ============================== */
async function scenarioC() {
	console.log("\n场景 C：全部任务 done（完成态渲染）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	// 用默认工作流 + 全 done 的 state
	const dir = makeFixture({ schemaVersion: 1, stages: [] });
	rmSync(join(dir, ".pi", "workflow", "workflow.json")); // 回退默认
	const wf = { schemaVersion: 1, stages: [
		{ id: "s0", name: "阶段一", goal: "", tasks: [
			{ id: "1.1", title: "任务甲", desc: "", humanTasks: ["做甲"], aiTasks: ["辅助甲"], deliverable: "d", doneSignal: "s", deps: [] },
		] },
	] };
	writeFileSync(join(dir, ".pi", "workflow", "workflow.json"), JSON.stringify(wf, null, 2), "utf8");
	writeFileSync(
		join(dir, ".pi", "workflow", "state.json"),
		JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), currentTaskId: "1.1", tasks: { "1.1": { status: "done", doneAt: new Date().toISOString() } }, milestones: {}, notes: [], log: [] }, null, 2),
		"utf8",
	);
	const ctx = makeCtx(dir);
	const lines = assertWidget(pi, ctx, "完成态 widget");
	if (lines) check("显示全部任务已完成", lines.some((l) => l.includes("全部任务已完成")) || lines[0].includes("全部完成"));
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 D：从未创建工作流（组件隐藏） ============================== */
async function scenarioD() {
	console.log("\n场景 D：从未创建工作流 → 组件整体隐藏");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	// fixture 不写 workflow.json（无任何工作流）
	const dir = mkdtempSync(join(tmpdir(), "wfmg-test-"));
	const caps = {};
	const ctx = makeCtx(dir, caps);
	await fireEvent(pi, ctx, "session_start");
	check("无工作流时不推 widget", caps.widget === undefined || caps.widget.factory === undefined);
	// 工具仍可用：wf_status 返回示例工作流信息
	const s = pi.tools.find((t) => t.name === "wf_status");
	const r = await s.execute("1", {}, undefined, undefined, ctx);
	check("wf_status 仍可用（提示示例工作流）", r.content[0].text.includes("工作流"));
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 E：进行中状态渲染 ============================== */
async function scenarioE() {
	console.log("\n场景 E：进行中任务渲染（无前缀标记 + 徽章）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	writeFileSync(
		join(dir, ".pi", "workflow", "state.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				updatedAt: new Date().toISOString(),
				currentTaskId: "0.1",
				tasks: {
					"0.1": { status: "doing", startedAt: new Date().toISOString() },
					"0.2": { status: "todo" },
					"1.1": { status: "todo" },
					"1.2": { status: "todo" },
				},
				milestones: {},
				notes: [],
				log: [],
			},
			null,
			2,
		),
		"utf8",
	);
	const ctx = makeCtx(dir);
	const lines = assertWidget(pi, ctx, "进行中 widget");
	if (lines) {
		check("进行中任务无前缀标记", !lines[0].includes("▶"));
		check("显示 [进行中] 徽章", lines[0].includes("[进行中]"));
	}
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 F：/workflow-config 统一菜单交互 ============================== */
async function scenarioF() {
	console.log("\n场景 F：/workflow-config 统一菜单交互（详细信息→开关→Esc）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	const caps = {};
	const ctx = makeCtx(dir, caps);
	await pi.commands["workflow-config"].handler("", ctx);
	check("无参数 /workflow-config 打开统一菜单", !!caps.custom);
	let closed = false;
	const comp = caps.custom(null, themeMock, {}, () => { closed = true; });

	// Enter → 显示详细信息（index 0）
	comp.handleInput("\r");
	let lines = comp.render(80);
	check("显示详细信息含当前任务", lines.some((l) => l.includes("当前任务")) && lines.some((l) => l.includes("0.1")));
	// 任意键返回菜单
	comp.handleInput("\r");
	lines = comp.render(80);
	check("返回菜单", lines.some((l) => l.includes("显示详细信息")));

	// ↓ → 常驻面板开关（index 1）→ Enter → 关闭 + 持久化
	comp.handleInput("\x1b[B");
	comp.handleInput("\r");
	check("开关切换触发 notify", caps.notify?.text.includes("常驻面板已关闭"));
	const cfg = JSON.parse(readFile(join(dir, ".pi", "workflow", "config.json")));
	check("config.json 持久化 showPanel=false", cfg.showPanel === false);

	// Esc（\x1b）关闭浮窗
	comp.handleInput("\x1b");
	check("Esc 关闭浮窗", closed);
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 G：/workflow-config 非 TUI 文本回落 ============================== */
async function scenarioG() {
	console.log("\n场景 G：/workflow-config 非 TUI 文本面板");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	const caps = {};
	const ctx = makeCtx(dir, caps);
	ctx.mode = "print";
	await pi.commands["workflow-config"].handler("", ctx);
	check("非 TUI 不弹浮窗", caps.custom === undefined);
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 H：hud 通用接口接管底部行 ============================== */
async function scenarioH() {
	console.log("\n场景 H：hud 存在 → 经通用接口注册底部行（showPanel 联动）；hud 关闭 → 恢复自绘面板");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	// 模拟 hud：暴露通用底部行接口 + 开启标记（真实 hud 在模块加载/installFooter 时设置）
	let registered = null;
	let unregistered = 0;
	let updateEvents = 0;
	globalThis.__PI_HUD_API__ = {
		registerExtraRows: (p) => {
			registered = p;
			return () => {
				unregistered++;
				if (registered === p) registered = null;
			};
		},
		notifyExtraRowsUpdate: () => updateEvents++,
	};
	globalThis.__PI_HUD_ACTIVE__ = true;
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE, {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		currentTaskId: "0.1",
		tasks: { "0.1": { status: "todo" }, "0.2": { status: "todo" }, "1.1": { status: "todo" }, "1.2": { status: "todo" } },
		milestones: { 面板验收: { done: true }, 布局定稿: { done: false } },
		notes: [],
		log: [],
	});
	const caps = {};
	const ctx = makeCtx(dir, caps);
	await fireEvent(pi, ctx, "session_start");
	check("hud 存在时不推常驻 widget", caps.widget === undefined || caps.widget.factory === undefined);
	check("已注册底部行 provider", typeof registered === "function");
	check("notify 已请求重绘", updateEvents > 0);
	// 调用 provider 验证内容与样式（themeMock 透传 bg/fg）：任务/分工/里程碑/进度条/底色
	let lines = [];
	try {
		lines = registered(themeMock, 100);
	} catch (e) {
		check("provider 渲染不抛异常", false);
	}
	check("provider 渲染不抛异常", lines.length > 0);
	check("含当前任务 0.1", lines.some((l) => l.includes("0.1")));
	check("含分工行", lines.some((l) => l.includes("你:")) && lines.some((l) => l.includes("AI:")));
	check("含进度条块元素", lines[0].includes("░"));
	check("含里程碑（✓/▶ 三态）", lines.some((l) => l.includes("里程碑") && l.includes("✓") && l.includes("▶")));
	// 常驻面板开关联动：showPanel=false → provider 注销（hud 底部行隐藏）
	writeFileSync(
		join(dir, ".pi", "workflow", "config.json"),
		JSON.stringify({ schemaVersion: 1, showPanel: false }, null, 2),
		"utf8",
	);
	await fireEvent(pi, ctx, "session_start");
	check("showPanel=false → provider 注销", registered === null);
	// 重新开启 → 恢复注册
	writeFileSync(
		join(dir, ".pi", "workflow", "config.json"),
		JSON.stringify({ schemaVersion: 1, showPanel: true }, null, 2),
		"utf8",
	);
	await fireEvent(pi, ctx, "session_start");
	check("showPanel=true → 重新注册", typeof registered === "function");
	// 模拟 /hud 关闭：标记置 false + 派发 hud:state-change → workflow-mgr 注销底部行、恢复自绘面板
	globalThis.__PI_HUD_ACTIVE__ = false;
	process.emit("hud:state-change");
	check("hud 关闭后注销 provider", registered === null);
	check("hud 关闭后恢复常驻 widget", !!caps.widget?.factory);
	// 清理全局
	delete globalThis.__PI_HUD_API__;
	delete globalThis.__PI_HUD_ACTIVE__;
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 I：wf_workflow archive 归档 ============================== */
async function scenarioI() {
	console.log("\n场景 I：wf_workflow archive 归档（退出视野 + 数据留档）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	const caps = {};
	const ctx = makeCtx(dir, caps);
	await fireEvent(pi, ctx, "session_start");
	check("归档前推送常驻 widget", !!caps.widget?.factory);
	const t = pi.tools.find((x) => x.name === "wf_workflow");
	const r = await t.execute("1", { action: "archive" }, undefined, undefined, ctx);
	check("归档结果告知数据位置（对 AI 透明）", r.content[0].text.includes(".pi/workflow/archive/"));
	check("归档后当前区无 workflow.json", !existsSync(join(dir, ".pi", "workflow", "workflow.json")));
	const base = join(dir, ".pi", "workflow", "archive");
	check("归档目录留档（至少 workflow.json）", readdirSync(base).some((d) => readdirSync(join(base, d)).includes("workflow.json")));
	const archState = JSON.parse(readFile(join(base, readdirSync(base)[0], "state.json")));
	check("归档快照保留任务真实状态（不强制 done）", !Object.values(archState.tasks).every((t) => t.status === "done"));
	check("归档快照记录 archiveStatus（未描述时为空）", "archiveStatus" in archState);
	// 缓存清空 + 文件移走 → hasWorkflowFile false → 不再推 widget（退出用户视野）
	const caps2 = {};
	const ctx2 = makeCtx(dir, caps2);
	await fireEvent(pi, ctx2, "session_start");
	check("归档后不再推常驻 widget（退出视野）", !caps2.widget?.factory);
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 J：wf_switch 语义 ============================== */
async function scenarioJ() {
	console.log("\n场景 J：wf_switch 语义（显式切换/搁置/blocked 解除/报错）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	// 自定义工作流：1.2 依赖 0.2（不依赖 1.1），使搁置/切换语义自洽
	const wf = {
		schemaVersion: 1,
		stages: [
			{
				id: "s0",
				name: "阶段一",
				goal: "",
				tasks: [
					{ id: "0.1", title: "任务甲", desc: "", humanTasks: [], aiTasks: [], deliverable: "", doneSignal: "", deps: [] },
					{ id: "0.2", title: "任务乙", desc: "", humanTasks: [], aiTasks: [], deliverable: "", doneSignal: "", deps: ["0.1"] },
				],
			},
			{
				id: "s1",
				name: "阶段二",
				goal: "",
				tasks: [
					{ id: "1.1", title: "任务丙", desc: "", humanTasks: [], aiTasks: [], deliverable: "", doneSignal: "", deps: ["0.2"] },
					{ id: "1.2", title: "任务丁", desc: "", humanTasks: [], aiTasks: [], deliverable: "", doneSignal: "", deps: ["0.2"] },
				],
			},
		],
	};
	// 状态：0.1 done、0.2 doing（当前）、1.1 blocked、1.2 todo
	const dir = makeFixture(wf, {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		currentTaskId: "0.2",
		tasks: {
			"0.1": { status: "done", doneAt: new Date().toISOString() },
			"0.2": { status: "doing", startedAt: new Date().toISOString() },
			"1.1": { status: "blocked", blockReason: "等数据" },
			"1.2": { status: "todo" },
		},
		milestones: {},
		notes: [],
		log: [],
	});
	const ctx = makeCtx(dir);
	const sw = pi.tools.find((t) => t.name === "wf_switch");

	// 1. 显式切换到一个 blocked 任务：完成当前 0.2 + 解除 1.1 阻塞并开始（1.1 依赖 0.2，当前任务即将完成不算阻塞）
	const r1 = await sw.execute("1", { taskId: "1.1" }, undefined, undefined, ctx);
	check("switch 到 blocked 任务：完成 0.2 + 解除阻塞开始 1.1", r1.content[0].text.includes("已完成任务 0.2") && r1.content[0].text.includes("1.1"));
	let saved = JSON.parse(readFile(join(dir, ".pi", "workflow", "state.json")));
	check("0.2 完成、1.1 doing 且 blockReason 清除", saved.tasks["0.2"]?.status === "done" && saved.tasks["1.1"]?.status === "doing" && !saved.tasks["1.1"].blockReason);

	// 2. 搁置转移：complete=false 切到 1.2（依赖 0.2 已 done）→ 1.1 回 todo
	const r2 = await sw.execute("2", { taskId: "1.2", complete: false }, undefined, undefined, ctx);
	check("complete=false 搁置 1.1 并切到 1.2", r2.content[0].text.includes("搁置任务 1.1") && r2.content[0].text.includes("1.2"));
	saved = JSON.parse(readFile(join(dir, ".pi", "workflow", "state.json")));
	check("搁置后 1.1 回 todo、currentTaskId=1.2", saved.tasks["1.1"]?.status === "todo" && saved.currentTaskId === "1.2");

	// 3. 切回 1.1（依赖 0.2 done）：完成 1.2 + 开始 1.1
	const r3 = await sw.execute("3", { taskId: "1.1" }, undefined, undefined, ctx);
	check("切回 1.1：完成 1.2 + 开始 1.1", r3.content[0].text.includes("已完成任务 1.2") && r3.content[0].text.includes("1.1"));

	// 4. 已是当前任务 / 已完成任务的报错
	const r4 = await sw.execute("4", { taskId: "1.1" }, undefined, undefined, ctx);
	check("switch 当前任务报错", r4.details?.kind === "error" && r4.content[0].text.includes("已是当前任务"));
	const r5 = await sw.execute("5", { taskId: "0.1" }, undefined, undefined, ctx);
	check("switch 已完成任务报错", r5.details?.kind === "error" && r5.content[0].text.includes("已完成"));

	// 5. 无参 switch 推进到无下一个 → 全部完成收尾
	const r6 = await sw.execute("6", {}, undefined, undefined, ctx);
	check("无参 switch 全部完成后提示收尾", r6.content[0].text.includes("全部任务完成"));
	saved = JSON.parse(readFile(join(dir, ".pi", "workflow", "state.json")));
	check("全部任务 done、currentTaskId null", saved.currentTaskId === null && Object.values(saved.tasks).every((t) => t.status === "done"));
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 K：archive 记录收尾状态（放弃场景） ============================== */
async function scenarioK() {
	console.log("\n场景 K：archive 归档记录收尾状态（放弃场景，保留任务真实状态）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	// 未完成状态：0.1 doing、0.2 todo……直接归档（放弃场景）
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE, {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		currentTaskId: "0.1",
		tasks: {
			"0.1": { status: "doing", startedAt: new Date().toISOString() },
			"0.2": { status: "todo" },
			"1.1": { status: "todo" },
			"1.2": { status: "todo" },
		},
		milestones: {},
		notes: [],
		log: [],
	});
	const ctx = makeCtx(dir);
	await fireEvent(pi, ctx, "session_start");
	const t = pi.tools.find((x) => x.name === "wf_workflow");
	const r = await t.execute("1", { action: "archive", status: "放弃：方案 ROI 不足" }, undefined, undefined, ctx);
	check("归档返回含收尾状态描述", r.content[0].text.includes("放弃：方案 ROI 不足"));
	const base = join(dir, ".pi", "workflow", "archive");
	const archState = JSON.parse(readFile(join(base, readdirSync(base)[0], "state.json")));
	check("放弃场景：任务状态原样保留（doing/todo 不被强制 done）", archState.tasks["0.1"]?.status === "doing" && archState.tasks["0.2"]?.status === "todo");
	check("归档快照记录 archiveStatus", archState.archiveStatus === "放弃：方案 ROI 不足");
	check("归档快照 currentTaskId null", archState.currentTaskId === null);
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 L：里程碑删除/改名 + 分工多项渲染 ============================== */
async function scenarioL() {
	console.log("\n场景 L：wf_milestone 删除/改名 + 分工多项渲染");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE, {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		currentTaskId: "0.1",
		tasks: {
			"0.1": { status: "doing", startedAt: new Date().toISOString() },
			"0.2": { status: "todo" },
			"1.1": { status: "todo" },
			"1.2": { status: "todo" },
		},
		milestones: { 开题: { done: true }, 中期: { date: "2026-05-01" } },
		notes: [],
		log: [],
	});
	const ctx = makeCtx(dir);
	await fireEvent(pi, ctx, "session_start");
	const ms = pi.tools.find((t) => t.name === "wf_milestone");

	// 增（缺省行为）→ 改 → 改名 → 删除
	await ms.execute("1", { name: "答辩" }, undefined, undefined, ctx);
	await ms.execute("2", { name: "中期", done: true }, undefined, undefined, ctx);
	const r3 = await ms.execute("3", { name: "中期", newName: "中期答辩" }, undefined, undefined, ctx);
	check("里程碑改名（保留日期/完成态）", r3.content[0].text.includes("改名为") && r3.content[0].text.includes("中期答辩"));
	const r4 = await ms.execute("4", { name: "开题", remove: true }, undefined, undefined, ctx);
	check("里程碑删除", r4.content[0].text.includes("已删除"));
	const r5 = await ms.execute("5", { name: "不存在的里程碑", remove: true }, undefined, undefined, ctx);
	check("删除不存在里程碑报错", r5.details?.kind === "error");
	let saved = JSON.parse(readFile(join(dir, ".pi", "workflow", "state.json")));
	check("删除/改名后状态正确", !saved.milestones["开题"] && !saved.milestones["中期"] && saved.milestones["中期答辩"]?.done === true && saved.milestones["答辩"]);

	// 分工多项渲染：构造多项分工的任务，widget 分工行应「、」连接
	const wfMulti = {
		schemaVersion: 1,
		stages: [
			{
				id: "s0",
				name: "阶段一",
				goal: "",
				tasks: [
					{ id: "0.1", title: "任务甲", desc: "", humanTasks: ["做甲", "做乙", "做丙"], aiTasks: ["AI 一", "AI 二"], deliverable: "d", doneSignal: "s", deps: [] },
				],
			},
		],
	};
	const dir2 = makeFixture(wfMulti, {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		currentTaskId: "0.1",
		tasks: { "0.1": { status: "doing", startedAt: new Date().toISOString() } },
		milestones: {},
		notes: [],
		log: [],
	});
	const caps = {};
	const ctx2 = makeCtx(dir2, caps);
	const lines = assertWidget(pi, ctx2, "分工多项 widget");
	if (lines) {
		check("分工行多项「、」连接", lines.some((l) => l.includes("你:") && l.includes("、")) && lines.some((l) => l.includes("AI:") && l.includes("、")));
	}
	rmSync(dir, { recursive: true, force: true });
	rmSync(dir2, { recursive: true, force: true });
}

/* ============================== 场景 M：纯 agent 模式 ============================== */
async function scenarioM() {
	console.log("\n场景 M：纯 agent 模式（mode=agent：无分工行/无用户负责/自动驾驶语义）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	// 工作流级 mode=agent，任务不填 humanTasks
	const wf = {
		schemaVersion: 1,
		mode: "agent",
		stages: [
			{
				id: "s0",
				name: "研究",
				goal: "",
				tasks: [
					{ id: "0.1", title: "调研资料", desc: "搜集资料", humanTasks: [], aiTasks: ["搜索并整理"], deliverable: "资料清单", doneSignal: "清单产出", deps: [] },
					{ id: "0.2", title: "写报告", desc: "汇总成报告", humanTasks: [], aiTasks: ["起草报告"], deliverable: "报告.md", doneSignal: "报告完成", deps: ["0.1"] },
				],
			},
		],
	};
	const dir = makeFixture(wf, {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		currentTaskId: "0.1",
		tasks: { "0.1": { status: "doing", startedAt: new Date().toISOString() }, "0.2": { status: "todo" } },
		milestones: {},
		notes: [],
		log: [],
	});
	const ctx = makeCtx(dir);
	await fireEvent(pi, ctx, "session_start");

	// wf_status 简报无「用户负责」行
	const st = pi.tools.find((t) => t.name === "wf_status");
	const r = await st.execute("1", {}, undefined, undefined, ctx);
	check("wf_status 无「用户负责」行", !r.content[0].text.includes("用户负责") && r.content[0].text.includes("AI）负责"));

	// widget 渲染无「你:」行、有「AI:」行
	const caps = {};
	const ctx2 = makeCtx(dir, caps);
	await fireEvent(pi, ctx2, "session_start");
	const widget = caps.widget;
	if (widget?.factory) {
		const lines = widget.factory(null, themeMock).render(80);
		check("widget 无「你:」行、有「AI:」行", !lines.some((l) => l.includes("你:")) && lines.some((l) => l.includes("AI:")));
	} else {
		check("widget 已推送", false);
	}

	// 自动驾驶语义：无参 wf_switch 连续推进直到全部完成
	const sw = pi.tools.find((t) => t.name === "wf_switch");
	await sw.execute("2", {}, undefined, undefined, ctx);
	const r3 = await sw.execute("3", {}, undefined, undefined, ctx);
	check("agent 模式 switch 推进到全部完成", r3.content[0].text.includes("全部任务完成"));
	const saved = JSON.parse(readFile(join(dir, ".pi", "workflow", "state.json")));
	check("全部 done + currentTaskId null", saved.currentTaskId === null && Object.values(saved.tasks).every((t) => t.status === "done"));
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 N：注入条件化三态 ============================== */
async function scenarioN() {
	console.log("\n场景 N：注入条件化（无工作流零注入 / human-ai 指挥者 / agent 自动驾驶）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const fireInject = async (dir) => {
		const ctx = makeCtx(dir);
		await fireEvent(pi, ctx, "session_start");
		const cb = pi.events["before_agent_start"];
		return await cb({ systemPrompt: "BASE" }, ctx);
	};

	// 1. 无工作流（无 workflow.json）→ 零注入
	const dir1 = mkdtempSync(join(tmpdir(), "wfmg-test-"));
	const r1 = await fireInject(dir1);
	check("无工作流零注入", r1.systemPrompt === undefined || !r1.systemPrompt.includes("工作流"));

	// 2. human-ai 工作流 → 完整指挥者提示词
	const dir2 = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	const r2 = await fireInject(dir2);
	check("human-ai 注入完整指挥者提示词", r2.systemPrompt.includes("工作流指挥者") && r2.systemPrompt.includes("wf_switch"));

	// 3. agent 工作流 → 轻量自动驾驶提示词（无「指挥者」）
	const wfAgent = { schemaVersion: 1, mode: "agent", stages: DEFAULT_WORKFLOW_FIXTURE.stages };
	const dir3 = makeFixture(wfAgent);
	const r3 = await fireInject(dir3);
	check("agent 注入自动驾驶提示词（无指挥者）", r3.systemPrompt.includes("自动驾驶执行者") && !r3.systemPrompt.includes("工作流指挥者"));

	rmSync(dir1, { recursive: true, force: true });
	rmSync(dir2, { recursive: true, force: true });
	rmSync(dir3, { recursive: true, force: true });
}

/* ============================== 场景 O：wf_note 增删读改 ============================== */
async function scenarioO() {
	console.log("\n场景 O：wf_note 增删读改（AI 记录，对用户透明）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	const ctx = makeCtx(dir);
	await fireEvent(pi, ctx, "session_start");
	const note = pi.tools.find((t) => t.name === "wf_note");
	check("注册了 wf_note（wf_decision 已删除）", !!note && !pi.tools.find((t) => t.name === "wf_decision"));

	// add：自动 id n1/n2
	const r1 = await note.execute("1", { action: "add", content: "用户选择 X 方案" }, undefined, undefined, ctx);
	check("add 自动 id n1", r1.content[0].text.includes("n1"));
	await note.execute("2", { action: "add", content: "不要用 Redis" }, undefined, undefined, ctx);

	// list
	const r3 = await note.execute("3", { action: "list" }, undefined, undefined, ctx);
	const lm = /共 (\d+) 条/.exec(r3.content[0].text);
	check("list 含两条记录", !!lm && lm[1] === "2" && r3.content[0].text.includes("X 方案"));

	// edit / remove
	const r4 = await note.execute("4", { action: "edit", id: "n1", content: "用户最终选择 Y 方案" }, undefined, undefined, ctx);
	check("edit 修改 n1", r4.content[0].text.includes("已修改 n1"));
	const r5 = await note.execute("5", { action: "remove", id: "n2" }, undefined, undefined, ctx);
	check("remove 删除 n2", r5.content[0].text.includes("已删除 n2"));
	const saved = JSON.parse(readFile(join(dir, ".pi", "workflow", "state.json")));
	check("state notes 只剩 n1 且内容已更新", saved.notes.length === 1 && saved.notes[0].id === "n1" && saved.notes[0].content.includes("Y"));

	// 报错：删除不存在
	const r6 = await note.execute("6", { action: "remove", id: "n99" }, undefined, undefined, ctx);
	check("删除不存在记录报错", r6.details?.kind === "error");
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 工具：bundle + 加载 ============================== */
let bundleMod = null;
async function importBundle() {
	if (bundleMod) return bundleMod;
	await build({
		entryPoints: [join(EXT_DIR, "index.ts")],
		outfile: BUNDLE,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});
	bundleMod = await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}`);
	return bundleMod;
}

const readFile = (p) => readFileSync(p, "utf8");

/** 示例工作流 fixture：4 任务的示例工作流（真实落盘文件） */
const DEFAULT_WORKFLOW_FIXTURE = {
	schemaVersion: 1,
	stages: [
		{
			id: "stage0",
			name: "规划",
			goal: "确定博客主题、内容方向与技术方案，为开发定锚。",
			tasks: [
				{ id: "0.1", title: "确定主题与内容方向", desc: "把博客定位收敛为具体主题", humanTasks: ["拍板博客主题与面向读者"], aiTasks: ["给出 3 个主题候选"], deliverable: "主题一句话 + 内容方向清单", doneSignal: "用户明确确认主题", deps: [] },
				{ id: "0.2", title: "技术选型", desc: "对比静态站点方案", humanTasks: ["拍板技术栈"], aiTasks: ["对比 2-3 种方案"], deliverable: "技术选型决策", doneSignal: "用户拍板 + 决策已记录", deps: ["0.1"] },
			],
		},
		{
			id: "stage1",
			name: "开发与发布",
			goal: "搭建站点框架、撰写首批内容并发布上线。",
			tasks: [
				{ id: "1.1", title: "搭建框架与首批内容", desc: "初始化站点、配置主题", humanTasks: ["撰写内容初稿"], aiTasks: ["初始化框架、配置主题"], deliverable: "本地可运行的站点", doneSignal: "本地构建成功", deps: ["0.2"] },
				{ id: "1.2", title: "发布上线", desc: "部署到线上、绑定域名", humanTasks: ["购买/绑定域名（如需）"], aiTasks: ["执行部署、检查 HTTPS"], deliverable: "线上可访问的博客 URL", doneSignal: "线上访问正常", deps: ["1.1"] },
			],
		},
	],
};

/* ============================== 主流程 ============================== */
try {
	await scenarioA();
	await scenarioB();
	await scenarioC();
	await scenarioD();
	await scenarioE();
	await scenarioF();
	await scenarioG();
	await scenarioH();
	await scenarioI();
	await scenarioJ();
	await scenarioK();
	await scenarioL();
	await scenarioM();
	await scenarioN();
	await scenarioO();
	console.log(failures === 0 ? "\n✅ 全部通过" : `\n❌ ${failures} 项失败`);
	process.exit(failures === 0 ? 0 : 1);
} finally {
	try {
		rmSync(BUNDLE, { force: true });
	} catch {
		/* 忽略清理失败 */
	}
}
