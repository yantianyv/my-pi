#!/usr/bin/env node
/**
 * workflow-mgr 渲染回归测试（需求第 5 条强烈建议项）
 *
 * 目的：抓「Box is not defined」这类 import 漏写、布局拆行、宽度溢出等问题
 * （真实踩过的坑）。覆盖三态渲染 + 核心工具流程：
 * - 场景 A：示例工作流（中文任务名）→ 常驻 widget + /wf-config 完整面板
 * - 场景 B：空工作流 → 面板不崩溃、显示「无任务」引导
 * - 场景 C：全部任务 done → 面板显示完成态
 * - 流程：wf_switch 推进（完成当前 + 开始下一个）→ state.json 落盘可复查
 * - 开关：/wf-config toggle → widget 移除 + config.json 持久化
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
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const EXT_DIR = join(TEST_DIR, ".."); // src/extensions/workflow-mgr/
const SRC_DIR = join(EXT_DIR, "../.."); // src/
const BUNDLE = join(TEST_DIR, ".tmp-bundle.mjs");

/* ---------- 存储路径（与 store.ts 同一套规则，测试自算以便预置/复查文件） ---------- */
const WF_HOME = mkdtempSync(join(tmpdir(), "wfmg-home-"));
process.env.PI_WORKFLOW_HOME = WF_HOME;
const SID = "test-sid";

function projectKey(cwd) {
	const name = basename(cwd).replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "project";
	return `${name}-${createHash("sha1").update(cwd).digest("hex").slice(0, 8)}`;
}
function sessionDir(cwd, sid = SID) {
	return join(WF_HOME, projectKey(cwd), sid);
}
/** 会话数据文件路径（workflow.json / state.json） */
const wfFile = (cwd, name, sid = SID) => join(sessionDir(cwd, sid), name);
/** 面板开关配置（全局单份） */
const configFile = () => join(WF_HOME, "config.json");
/** 项目归档目录 */
const archiveRoot = (cwd) => join(WF_HOME, projectKey(cwd), "archive");

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
		sent: [],
		registerTool(t) {
			this.tools.push(t);
		},
		registerCommand(name, c) {
			this.commands[name] = c;
		},
		on(ev, cb) {
			this.events[ev] = cb;
		},
		sendUserMessage(content, options) {
			this.sent.push({ content, options });
		},
	};
}

/** mock ctx：cwd 指向 fixture 目录，ui 捕获 widget/status/notify/custom 到 captures */
function makeCtx(cwd, captures = {}) {
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => "test-sid" },
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
				// 未指定按键驱动时直接 resolve undefined（保持旧行为，兼容场景 F 的手动构造）
				if (!captures.customKeys) return undefined;
				return await new Promise((resolve) => {
					const comp = fn(null, themeMock, {}, resolve);
					for (const k of captures.customKeys) comp.handleInput(k);
				});
			},
			select: async (title, options) => {
				captures.select = { title, options };
				return captures.selectAnswer;
			},
			input: async (title, placeholder) => {
				captures.input = { title, placeholder };
				return captures.inputAnswer;
			},
		},
	};
}

/** 写 fixture 工作目录（工作流数据落在全局 WF_HOME 下，按 cwd + 会话 ID 隔离） */
function makeFixture(workflowJson, stateJson = null, configJson = null) {
	const dir = mkdtempSync(join(tmpdir(), "wfmg-test-"));
	const sd = sessionDir(dir);
	mkdirSync(sd, { recursive: true });
	writeFileSync(join(sd, "workflow.json"), JSON.stringify(workflowJson, null, 2), "utf8");
	if (stateJson) writeFileSync(join(sd, "state.json"), JSON.stringify(stateJson, null, 2), "utf8");
	if (configJson) writeFileSync(configFile(), JSON.stringify(configJson, null, 2), "utf8");
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

	// /wf-config 统一功能菜单（TUI 浮窗，字符边框）
	const caps2 = {};
	const ctx2 = makeCtx(dir, caps2);
	let menuComp = null;
	await pi.commands["wf-config"].handler("", ctx2);
	if (caps2.custom) menuComp = caps2.custom(null, themeMock, {}, () => {});
	const menuLines = menuComp?.render(100);
	check("/wf-config 菜单浮窗渲染", !!menuLines);
	if (menuLines) {
		check("浮窗有边框（╭╮╰╯）", menuLines[0].includes("╭") && menuLines[0].includes("╮") && menuLines[menuLines.length - 1].includes("╰") && menuLines[menuLines.length - 1].includes("╯"));
		check("菜单收纳 2 项功能", menuLines.some((l) => l.includes("显示详细信息")) && menuLines.some((l) => l.includes("常驻面板")));
		const over = menuLines.map((l) => visibleWidth(l)).filter((w) => w > 100);
		check("菜单行宽 ≤ 100", over.length === 0);
	}
	check("未注册别名 /wfmg（只需 /wf-config）", !pi.commands.wfmg);
	// 只留无参入口——任意子命令参数一律走无参浮窗逻辑，不产生状态变更
	const caps3 = {};
	const ctx3 = makeCtx(dir, caps3);
	await pi.commands["wf-config"].handler("done 0.1", ctx3);
	check("子命令已删除：done 参数走无参浮窗（不弹子命令逻辑）", caps3.custom !== undefined);
	const stPath = wfFile(dir, "state.json");
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
	const stateFile = wfFile(dir, "state.json");
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
	const wf = { schemaVersion: 1, stages: [
		{ id: "s0", name: "阶段一", goal: "", tasks: [
			{ id: "1.1", title: "任务甲", desc: "", humanTasks: ["做甲"], aiTasks: ["辅助甲"], deliverable: "d", doneSignal: "s", deps: [] },
		] },
	] };
	writeFileSync(wfFile(dir, "workflow.json"), JSON.stringify(wf, null, 2), "utf8");
	writeFileSync(
		wfFile(dir, "state.json"),
		JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), currentTaskId: "1.1", tasks: { "1.1": { status: "done", doneAt: new Date().toISOString() } }, log: [] }, null, 2),
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
	// 工具仍可用：wf_status 提示工作流为空
	const s = pi.tools.find((t) => t.name === "wf_status");
	const r = await s.execute("1", {}, undefined, undefined, ctx);
	check("wf_status 仍可用（提示工作流为空）", r.content[0].text.includes("工作流为空"));
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
		wfFile(dir, "state.json"),
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

/* ============================== 场景 F：/wf-config 统一菜单交互 ============================== */
async function scenarioF() {
	console.log("\n场景 F：/wf-config 统一菜单交互（详细信息→开关→Esc）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	const caps = {};
	const ctx = makeCtx(dir, caps);
	await fireEvent(pi, ctx, "session_start"); // 真实生命周期：session_start 先行（加载本会话工作流）
	await pi.commands["wf-config"].handler("", ctx);
	check("无参数 /wf-config 打开统一菜单", !!caps.custom);
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
	const cfg = JSON.parse(readFile(configFile()));
	check("config.json 持久化 showPanel=false", cfg.showPanel === false);

	// Esc（\x1b）关闭浮窗
	comp.handleInput("\x1b");
	check("Esc 关闭浮窗", closed);
	rmSync(configFile(), { force: true }); // 面板开关是全局单份：复位，避免影响后续场景
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 G：/wf-config 非 TUI 文本回落 ============================== */
async function scenarioG() {
	console.log("\n场景 G：/wf-config 非 TUI 文本面板");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	const caps = {};
	const ctx = makeCtx(dir, caps);
	ctx.mode = "print";
	await fireEvent(pi, ctx, "session_start");
	await pi.commands["wf-config"].handler("", ctx);
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
	// 常驻面板开关联动：showPanel=false → provider 注销（hud 底部行隐藏）
	writeFileSync(configFile(), JSON.stringify({ schemaVersion: 1, showPanel: false }, null, 2), "utf8");
	await fireEvent(pi, ctx, "session_start");
	check("showPanel=false → provider 注销", registered === null);
	// 重新开启 → 恢复注册
	writeFileSync(configFile(), JSON.stringify({ schemaVersion: 1, showPanel: true }, null, 2), "utf8");
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
	rmSync(configFile(), { force: true }); // 面板开关全局单份：复位
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
	check("归档结果告知数据位置（对 AI 透明）", r.content[0].text.includes("归档目录"));
	check("归档后当前区无 workflow.json", !existsSync(wfFile(dir, "workflow.json")));
	const base = archiveRoot(dir);
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
		log: [],
	});
	const ctx = makeCtx(dir);
	await fireEvent(pi, ctx, "session_start"); // 加载本会话工作流（真实生命周期）
	const sw = pi.tools.find((t) => t.name === "wf_switch");

	// 1. 显式切换到一个 blocked 任务：完成当前 0.2 + 解除 1.1 阻塞并开始（1.1 依赖 0.2，当前任务即将完成不算阻塞）
	const r1 = await sw.execute("1", { taskId: "1.1" }, undefined, undefined, ctx);
	check("switch 到 blocked 任务：完成 0.2 + 解除阻塞开始 1.1", r1.content[0].text.includes("已完成任务 0.2") && r1.content[0].text.includes("1.1"));
	let saved = JSON.parse(readFile(wfFile(dir, "state.json")));
	check("0.2 完成、1.1 doing 且 blockReason 清除", saved.tasks["0.2"]?.status === "done" && saved.tasks["1.1"]?.status === "doing" && !saved.tasks["1.1"].blockReason);

	// 2. 搁置转移：complete=false 切到 1.2（依赖 0.2 已 done）→ 1.1 回 todo
	const r2 = await sw.execute("2", { taskId: "1.2", complete: false }, undefined, undefined, ctx);
	check("complete=false 搁置 1.1 并切到 1.2", r2.content[0].text.includes("搁置任务 1.1") && r2.content[0].text.includes("1.2"));
	saved = JSON.parse(readFile(wfFile(dir, "state.json")));
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
	saved = JSON.parse(readFile(wfFile(dir, "state.json")));
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
		log: [],
	});
	const ctx = makeCtx(dir);
	await fireEvent(pi, ctx, "session_start");
	const t = pi.tools.find((x) => x.name === "wf_workflow");
	const r = await t.execute("1", { action: "archive", status: "放弃：方案 ROI 不足" }, undefined, undefined, ctx);
	check("归档返回含收尾状态描述", r.content[0].text.includes("放弃：方案 ROI 不足"));
	const base = archiveRoot(dir);
	const archState = JSON.parse(readFile(join(base, readdirSync(base)[0], "state.json")));
	check("放弃场景：任务状态原样保留（doing/todo 不被强制 done）", archState.tasks["0.1"]?.status === "doing" && archState.tasks["0.2"]?.status === "todo");
	check("归档快照记录 archiveStatus", archState.archiveStatus === "放弃：方案 ROI 不足");
	check("归档快照 currentTaskId null", archState.currentTaskId === null);
	rmSync(dir, { recursive: true, force: true });
}

/* ============================== 场景 L：分工多项渲染 ============================== */
async function scenarioL() {
	console.log("\n场景 L：分工多项渲染（human-ai 模式）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
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
	const dir = makeFixture(wfMulti, {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		currentTaskId: "0.1",
		tasks: { "0.1": { status: "doing", startedAt: new Date().toISOString() } },
		log: [],
	});
	const caps = {};
	const ctx = makeCtx(dir, caps);
	const lines = assertWidget(pi, ctx, "分工多项 widget");
	if (lines) {
		check("分工行多项「、」连接", lines.some((l) => l.includes("你:") && l.includes("、")) && lines.some((l) => l.includes("AI:") && l.includes("、")));
	}
	rmSync(dir, { recursive: true, force: true });
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
		log: [],
	});
	const ctx = makeCtx(dir);
	await fireEvent(pi, ctx, "session_start");

	// wf_status 简报无「用户负责」行
	const st = pi.tools.find((t) => t.name === "wf_status");
	const r = await st.execute("1", {}, undefined, undefined, ctx);
	check("wf_status 无「用户负责」行", !r.content[0].text.includes("用户负责") && r.content[0].text.includes("AI 负责："));

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
	const saved = JSON.parse(readFile(wfFile(dir, "state.json")));
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

/* ============================== 场景 O：工具面（旧工具已移除） ============================== */
async function scenarioO() {
	console.log("\n场景 O：工具面（5 个 wf_* 工具，记录/里程碑/绑定已移除）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const names = pi.tools.map((x) => x.name).sort();
	check("恰好注册 5 个工具：" + names.join(","), names.length === 5);
	check(
		"工具清单正确",
		JSON.stringify(names) === JSON.stringify(["wf_block", "wf_rollback", "wf_status", "wf_switch", "wf_workflow"]),
	);
	for (const gone of ["wf_note", "wf_milestone", "wf_decision"]) {
		check(`已移除 ${gone}`, !pi.tools.find((x) => x.name === gone));
	}
	const wf = pi.tools.find((x) => x.name === "wf_workflow");
	const actionSchema = JSON.stringify(wf.parameters.properties.action);
	check("wf_workflow 无 bind/reset 动作", actionSchema.includes("list") && !actionSchema.includes("bind") && !actionSchema.includes("reset"));
	check("命令面：/wf 与 /wf-config（无 /wf resume 子命令）", !!pi.commands["wf"] && !!pi.commands["wf-config"]);
}

/* ============================== 场景 Q：wf_workflow import 一次性导入 ============================== */
async function scenarioQ() {
	console.log("\n场景 Q：wf_workflow import 一次性导入（草稿 json → 整份工作流）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const t = pi.tools.find((x) => x.name === "wf_workflow");
	const dir = makeFixture({ schemaVersion: 1, stages: [] });
	const ctx = makeCtx(dir);
	await fireEvent(pi, ctx, "session_start");

	// 1. 成功导入：2 阶段 3 任务（批内依赖 0.2→0.1、跨阶段 1.1→0.2；mode agent）
	const draftPath = join(dir, "draft.json");
	writeFileSync(
		draftPath,
		JSON.stringify({
			mode: "agent",
			stages: [
				{
					id: "design",
					name: "拍板",
					goal: "定稿",
					tasks: [{ title: "0.1 数据模型", desc: "确定结构", doneSignal: "拍板" }, { title: "0.2 工具语义", deps: ["0.1"] }],
				},
				{ id: "impl", name: "实现", tasks: [{ title: "1.1 数据层", deps: ["0.2"] }] },
			],
		}),
	);
	const r1 = await t.execute("1", { action: "import", path: draftPath }, undefined, undefined, ctx);
	check("导入返回阶段/任务摘要", r1.content[0].text.includes("2 个阶段") && r1.content[0].text.includes("3 个任务") && r1.content[0].text.includes("纯 agent"));
	const wf = JSON.parse(readFile(wfFile(dir, "workflow.json")));
	check("导入生成 workflow.json：阶段与 id 正确", wf.stages.length === 2 && wf.stages[0].tasks[0].id === "0.1" && wf.stages[1].tasks[0].id === "1.1");
	check("导入 mode 生效", wf.mode === "agent");
	check("批内未来 id 依赖解析正确", wf.stages[0].tasks[1].deps[0] === "0.1" && wf.stages[1].tasks[0].deps[0] === "0.2");
	const st = JSON.parse(readFile(wfFile(dir, "state.json")));
	check("导入后当前任务 = 第一步 0.1", st.currentTaskId === "0.1");

	// 2. 非空拒绝：已导入（非空）后再 import → 报错并提示先 archive
	const r2 = await t.execute("2", { action: "import", path: draftPath }, undefined, undefined, ctx);
	check("非空时拒绝导入", r2.details?.kind === "error" && r2.content[0].text.includes("非空") && r2.content[0].text.includes("archive"));

	// 3. 空工作流上的坏 JSON → 行号定位
	const dirBad = makeFixture({ schemaVersion: 1, stages: [] });
	const ctxBad = makeCtx(dirBad);
	const badPath = join(dirBad, "bad.json");
	writeFileSync(badPath, '{\n  "stages": [\n    {"name": "x", "tasks": [}\n  ]\n}');
	const r3 = await t.execute("3", { action: "import", path: badPath }, undefined, undefined, ctxBad);
	check("坏 JSON 报解析失败（含行号）", r3.details?.kind === "error" && r3.content[0].text.includes("解析失败") && /\d+ 行/.test(r3.content[0].text));

	// 4. 缺 title → 定位到阶段/任务
	const dirMiss = makeFixture({ schemaVersion: 1, stages: [] });
	const ctxMiss = makeCtx(dirMiss);
	const missPath = join(dirMiss, "miss.json");
	writeFileSync(missPath, JSON.stringify({ stages: [{ name: "A", tasks: [{ title: "ok" }, { desc: "缺 title" }] }] }));
	const r4 = await t.execute("4", { action: "import", path: missPath }, undefined, undefined, ctxMiss);
	check("缺 title 校验定位到任务", r4.details?.kind === "error" && r4.content[0].text.includes("第 1 个阶段的第 2 个任务缺 title"));

	// 5. 依赖不存在 → 报可用 id
	const dirDep = makeFixture({ schemaVersion: 1, stages: [] });
	const ctxDep = makeCtx(dirDep);
	const depPath = join(dirDep, "dep.json");
	writeFileSync(depPath, JSON.stringify({ stages: [{ name: "A", tasks: [{ title: "x", deps: ["9.9"] }] }] }));
	const r5 = await t.execute("5", { action: "import", path: depPath }, undefined, undefined, ctxDep);
	check("依赖不存在报错（含可用 id）", r5.details?.kind === "error" && r5.content[0].text.includes("9.9") && r5.content[0].text.includes("0.1"));

	// 6. 依赖环 → 带链路
	const dirCyc = makeFixture({ schemaVersion: 1, stages: [] });
	const ctxCyc = makeCtx(dirCyc);
	const cycPath = join(dirCyc, "cyc.json");
	writeFileSync(cycPath, JSON.stringify({ stages: [{ name: "A", tasks: [{ title: "a", deps: ["0.2"] }, { title: "b", deps: ["0.1"] }] }] }));
	const r6 = await t.execute("6", { action: "import", path: cycPath }, undefined, undefined, ctxCyc);
	check("依赖环报错带链路", r6.details?.kind === "error" && r6.content[0].text.includes("0.1 → 0.2"));

	for (const d of [dir, dirBad, dirMiss, dirDep, dirCyc]) rmSync(d, { recursive: true, force: true });
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

/* ============================== 场景 R：工作流按会话隔离 ============================== */
async function scenarioR() {
	console.log("\n场景 R：工作流按会话隔离（同项目多会话互不干扰 + resume 带回）");
	const mod = await importBundle();
	const pi = makePi();
	mod.default(pi);
	const dir = makeFixture(DEFAULT_WORKFLOW_FIXTURE);
	const wf = pi.tools.find((x) => x.name === "wf_workflow");
	const st = pi.tools.find((x) => x.name === "wf_status");
	const sw = pi.tools.find((x) => x.name === "wf_switch");

	// 会话 A：自己的 4 任务工作流，推进一次
	const ctxA = makeCtx(dir);
	await fireEvent(pi, ctxA, "session_start");
	await sw.execute("1", {}, undefined, undefined, ctxA);
	const savedA = JSON.parse(readFile(wfFile(dir, "state.json")));
	check("会话 A 状态落盘（0.1 done）", savedA.tasks["0.1"]?.status === "done");

	// 会话 B（同项目、另一个会话 ID）：读不到 A 的数据，面板隐藏
	const capsB = {};
	const ctxB = makeCtx(dir, capsB);
	ctxB.sessionManager = { getSessionId: () => "sid-b" };
	await fireEvent(pi, ctxB, "session_start");
	const rB = await st.execute("2", {}, undefined, undefined, ctxB);
	check("会话 B 读不到会话 A 的工作流（工作流为空）", rB.content[0].text.includes("工作流为空"));
	check("会话 B 无工作流时不推面板", capsB.widget?.factory === undefined);
	// 会话 B 规划自己的任务 → 独立落盘，不影响 A
	await wf.execute("3", { action: "add", stageId: "s0", stageName: "B 阶段", title: "B 任务" }, undefined, undefined, ctxB);
	const savedB = JSON.parse(readFile(wfFile(dir, "workflow.json", "sid-b")));
	check("会话 B 独立落盘自己的 workflow.json", savedB.stages[0].tasks[0].title === "B 任务");
	const savedA2 = JSON.parse(readFile(wfFile(dir, "state.json")));
	check("会话 A 数据未被会话 B 干扰", savedA2.tasks["0.1"]?.status === "done");

	// resume：同会话 ID 再次 session_start → 数据从磁盘重载带回
	const ctxA2 = makeCtx(dir);
	ctxA2.sessionManager = { getSessionId: () => "test-sid" };
	await fireEvent(pi, ctxA2, "session_start");
	const rA2 = await st.execute("4", {}, undefined, undefined, ctxA2);
	check("resume 回原会话：工作流随之恢复（非空且含当前任务）", !rA2.content[0].text.includes("工作流为空") && rA2.content[0].text.includes("当前任务"));

	rmSync(dir, { recursive: true, force: true });
}

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
	await scenarioQ();
	await scenarioR();
	console.log(failures === 0 ? "\n✅ 全部通过" : `\n❌ ${failures} 项失败`);
	process.exit(failures === 0 ? 0 : 1);
} finally {
	try {
		rmSync(BUNDLE, { force: true });
	} catch {
		/* 忽略清理失败 */
	}
}
