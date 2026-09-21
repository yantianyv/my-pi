#!/usr/bin/env node
/**
 * ask 扩展回归测试（复用 workflow-mgr 测试基建模式）
 *
 * 原理：esbuild（src/node_modules 构建依赖）把扩展 bundle 成单文件 ESM 再 import；
 * external 白名单与 build.js 一致（@earendil-works/*、typebox），运行时经本目录
 * node_modules junction（→ pi 全局）解析。theme mock 纯文本透传，不干扰宽度计算。
 *
 * 覆盖：
 * - 场景 A：六题型全流程作答 → 提交 → 工具结果含答案、问卷文件已删除
 * - 场景 B：必答未完成时 Enter → 不提交、焦点跳到首个未答题
 * - 场景 C：Esc 搁置 → 草稿写回文件（status:draft + answers）
 * - 场景 D：/answer 重开草稿 → 预填恢复 → 提交 → sendUserMessage 送达、文件删除
 * - 场景 E：/answer 多份 → 选择器 → 选中打开
 * - 场景 F：手写 JSON（缺省字段推断）+ 损坏文件（invalid 报告）
 * - 场景 G：action=cancel 作废搁置问卷（文件删除 + 状态清除 + 不存在报错）
 * - 场景 H：长题干/长选项说明折行完整展示（不截断，尾部标记可见）
 * - 场景 I：执行失败如实渲染真实原因（不误报「无 UI 降级」）
 * - 场景 J：title 缺省自动取第一题问句截断（不再报错）
 * - 场景 K：note 只读说明题（不进进度分母 / 不阻塞提交 / 回执不带正文 / 纯说明问卷 Enter 确认）
 * - 场景 L：多行简答内 ↑↓ 行间移动（边界处才跳出本题）+ Ctrl+W 删词
 * - 场景 M：Ctrl+↑/↓ 跳上一/下一题 + 状态行当前题号
 * - 场景 N：Ctrl+P 答案一览（含未答标记，可 C 复制——测试不按 C，避免真写系统剪贴板）
 * - 场景 O：D 键删除问卷（二次确认）→ 工具结果 deleted + 文件删除 + 状态清除
 * - 场景 P：/answer 选择器里 D 删除选中问卷（列表就地刷新）
 * - 场景 Q：滚动提示移出正文（状态行 ▲▼）+ x 展开超长说明
 * - 场景 R：问卷级上下文（context 参数 + includeLastMessage 自动提取上一条回复）渲染与折叠
 * - 渲染不变量：整屏页每次 render 恰好 termRows 行、每行恰好 width 列（全屏遮蔽前提）
 *
 * 用法：node src/extensions/ask/test/ask.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const EXT_DIR = join(TEST_DIR, ".."); // src/extensions/ask/
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

const themeMock = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const TERM_ROWS = 24;
const TERM_COLS = 80;
const makeTui = () => ({ terminal: { rows: TERM_ROWS, columns: TERM_COLS }, requestRender() {} });

/** 键位模拟（pi-tui matchesKey 的原始输入序列） */
const K = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	enter: "\r",
	escape: "\x1b",
	space: " ",
	ctrlUp: "\x1b[1;5A",
	ctrlDown: "\x1b[1;5B",
	ctrlLeft: "\x1b[1;5D",
	ctrlRight: "\x1b[1;5C",
	ctrlW: "\x17",
	ctrlP: "\x10",
	shiftEnter: "\x1b[13;2u",
};

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
		sendUserMessage(text, opts) {
			this.sent.push({ text, opts });
		},
	};
}

/** mock ctx：ui.custom 捕获 factory 与 overlay 参数，返回 promise 由测试驱动 done 解决 */
function makeCtx(cwd, captures, extra = {}) {
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: (key, text) => {
				captures.statuses[key] = text;
			},
			notify: (text, kind) => {
				captures.notifies.push({ text, kind });
			},
			custom: (factory, opts) =>
				new Promise((resolve) => {
					captures.customs.push({ factory, opts, resolve });
				}),
		},
		...extra,
	};
}

function makeCaptures() {
	return { customs: [], statuses: {}, notifies: [] };
}

/** 弹出当前捕获的组件实例（done 解决 custom promise） */
function openCaptured(captures, idx = captures.customs.length - 1) {
	const c = captures.customs[idx];
	const comp = c.factory(makeTui(), themeMock, {}, (r) => c.resolve(r));
	comp.focused = true;
	return comp;
}

/** 渲染不变量：恰好 TERM_ROWS 行、每行恰好 TERM_COLS 列 */
function assertFullscreen(comp, label) {
	let lines = [];
	try {
		lines = comp.render(TERM_COLS);
	} catch (e) {
		check(`${label}: render 不抛异常`, false);
		console.error("      →", e.message);
		return;
	}
	check(`${label}: 行数 === ${TERM_ROWS}（实际 ${lines.length}）`, lines.length === TERM_ROWS);
	let bad = 0;
	for (const line of lines) if (visibleWidth(line) !== TERM_COLS) bad++;
	check(`${label}: 每行恰好 ${TERM_COLS} 列（违例 ${bad} 行）`, bad === 0);
}

const FULL_PARAMS = {
	id: "test-survey",
	title: "技术选型确认",
	description: "覆盖全部题型",
	questions: [
		{ id: "q1", type: "single", question: "用哪个日期库？", options: [{ label: "dayjs", description: "小" }, { label: "date-fns" }] },
		{ id: "q2", type: "multi", question: "需要哪些功能？", options: [{ label: "时区" }, { label: "相对时间" }, { label: "格式化" }], max: 2 },
		{ id: "q3", type: "text", question: "字段命名风格？", placeholder: "如 snake_case" },
		{ id: "q4", type: "confirm", question: "需要缓存吗？" },
		{ id: "q5", type: "rating", question: "紧急程度？" },
		{ id: "q6", type: "number", question: "有效期小时数？", min: 1, max: 24 },
		{ id: "q7", type: "text", question: "备注（选答）", required: false },
	],
};

function typeText(comp, text) {
	for (const ch of text) comp.handleInput(ch);
}

async function main() {
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
	const mod = await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}`);

	// ---- 场景 A：六题型全流程提交 ----
	console.log("场景 A：全流程作答提交");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		check("A: ask 工具已注册", !!tool);
		check("A: /answer 命令已注册", !!pi.commands.answer);

		const execP = tool.execute("tc1", FULL_PARAMS, null, null, ctx);
		// execute 内先写文件再进 custom（排队链首个立即执行），让出微任务
		await new Promise((r) => setTimeout(r, 10));
		check("A: execute 打开了整屏 overlay", captures.customs.length === 1 && captures.customs[0].opts?.overlay === true);
		const ov = captures.customs[0].opts?.overlayOptions;
		check("A: overlay 全屏参数（100% 宽 / 100% 高 / 左上）", ov?.width === "100%" && ov?.maxHeight === "100%" && ov?.anchor === "top-left");

		const comp = openCaptured(captures);
		assertFullscreen(comp, "A: 初始渲染");

		// q1 单选：空格选 dayjs → 焦点自动跳到 q2 首行
		comp.handleInput(K.space);
		// q2 多选：空格选「时区」→ 下移 → 空格选「相对时间」→ 下移再空格触发 max=2 限制
		comp.handleInput(K.space);
		comp.handleInput(K.down);
		comp.handleInput(K.space);
		comp.handleInput(K.down);
		comp.handleInput(K.space); // 超限提示，不选中
		// 移到 q3 输入行（当前在 q2 第 3 选项，down×2 经「其他」到 q3）
		comp.handleInput(K.down);
		comp.handleInput(K.down);
		typeText(comp, "snake_case");
		// Enter：必答未完成 → 不提交，焦点跳到 q4
		comp.handleInput(K.enter);
		check("A: 必答未完成时 Enter 不提交", captures.customs.length === 1);
		assertFullscreen(comp, "A: 校验提示后渲染");
		// q4 判断：y 快捷选「是」→ 自动跳到 q5 评分
		comp.handleInput("y");
		// q5 评分：→ 得最低分，数字键直选 5
		comp.handleInput(K.right);
		comp.handleInput("5");
		// q6 数字
		comp.handleInput(K.down);
		typeText(comp, "12");
		// q7 选答跳过：下移后 Enter 提交
		comp.handleInput(K.down);
		comp.handleInput(K.enter);

		const result = await execP;
		check("A: 提交后 details.status === submitted", result.details?.status === "submitted");
		const text = result.content?.[0]?.text ?? "";
		check("A: 答案含单选 dayjs", text.includes("dayjs"));
		check("A: 答案含多选两项", text.includes("时区、相对时间"));
		check("A: 答案含文本 snake_case", text.includes("snake_case"));
		check("A: 答案含判断「是」与评分 5 与数字 12", /→ 是/.test(text) && /→ 5/.test(text) && /→ 12/.test(text));
		check("A: 选答题显示（跳过）", text.includes("（跳过）"));
		check("A: 问卷文件已删除", !existsSync(join(dir, ".pi", "questionnaires", "test-survey.json")));
		check("A: 待答状态已清除", captures.statuses.ask === undefined);
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 B/C：搁置 + 草稿 ----
	console.log("场景 B：Esc 搁置保存草稿");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const execP = tool.execute("tc2", FULL_PARAMS, null, null, ctx);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		comp.handleInput(K.space); // q1 选 dayjs
		comp.handleInput(K.escape); // 搁置
		const result = await execP;
		check("B: details.status === shelved", result.details?.status === "shelved");
		check("B: 结果提示 /answer 可继续", (result.content?.[0]?.text ?? "").includes("/answer"));
		const file = join(dir, ".pi", "questionnaires", "test-survey.json");
		check("B: 问卷文件保留", existsSync(file));
		const saved = JSON.parse(readFileSync(file, "utf8"));
		check("B: 草稿 status=draft 且含 q1 答案", saved.status === "draft" && saved.answers?.q1 === "dayjs");
		check("B: 待答状态提示已推送", typeof captures.statuses.ask === "string" && captures.statuses.ask.includes("1 份"));

		// ---- 场景 D：/answer 重开草稿提交 ----
		console.log("场景 D：/answer 重开草稿并提交");
		const captures2 = makeCaptures();
		const ctx2 = makeCtx(dir, captures2);
		const cmdP = pi.commands.answer.handler("", ctx2);
		await new Promise((r) => setTimeout(r, 10));
		check("D: 单份问卷直接打开（无选择器）", captures2.customs.length === 1);
		const comp2 = openCaptured(captures2);
		assertFullscreen(comp2, "D: 草稿重开渲染");
		// q1 已预填 dayjs（焦点 0 在 q1 首项）；q2 选两项
		comp2.handleInput(K.down); // q1 opt1 —— 注意 q1 已选，直接 down 到 q2？不行，逐行移动
		// 用 trySubmit 的跳转快速定位：先 Enter 让焦点跳到第一个未答必答题（q2）
		comp2.handleInput(K.enter);
		comp2.handleInput(K.space);
		comp2.handleInput(K.down);
		comp2.handleInput(K.space);
		// q3
		comp2.handleInput(K.enter); // 又跳到 q3（下一个未答必答）
		typeText(comp2, "camelCase");
		comp2.handleInput(K.enter); // 跳到 q4
		comp2.handleInput("n"); // 否
		comp2.handleInput(K.enter); // q4 已答 → 跳到 q5
		comp2.handleInput("3");
		comp2.handleInput(K.enter); // 跳到 q6
		typeText(comp2, "8");
		comp2.handleInput(K.enter); // 全部必答完成 → 提交
		await cmdP;
		check("D: 答案经 sendUserMessage 送达", pi.sent.length === 1);
		check("D: 送达含草稿预填的 dayjs 与新答案", (pi.sent[0]?.text ?? "").includes("dayjs") && (pi.sent[0]?.text ?? "").includes("camelCase"));
		check("D: followUp 投递模式", pi.sent[0]?.opts?.deliverAs === "followUp");
		check("D: 提交后文件已删除", !existsSync(file));
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 E：多份选择器 ----
	console.log("场景 E：/answer 多份选择");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		// 手写两份问卷文件
		const qDir = join(dir, ".pi", "questionnaires");
		mkdirSync(qDir, { recursive: true });
		writeFileSync(
			join(qDir, "a-first.json"),
			JSON.stringify({ id: "a-first", title: "第一份", createdAt: "2026-01-01T00:00:00Z", questions: [{ question: "选 a 还是 b？", options: [{ label: "a" }, { label: "b" }] }] }),
		);
		writeFileSync(
			join(qDir, "b-second.json"),
			JSON.stringify({ id: "b-second", title: "第二份", createdAt: "2026-01-02T00:00:00Z", questions: [{ type: "text", question: "随便说点？" }] }),
		);
		writeFileSync(join(qDir, "broken.json"), "{ 这不是合法 JSON");
		const cmdP = pi.commands.answer.handler("", ctx);
		await new Promise((r) => setTimeout(r, 10));
		check("E: 多份时先弹选择器", captures.customs.length === 1);
		check("E: 损坏文件被 warning 提示", captures.notifies.some((n) => n.kind === "warning" && n.text.includes("broken.json")));
		const picker = openCaptured(captures, 0);
		const pickerLines = picker.render(60);
		check("E: 选择器渲染包含两份问卷", pickerLines.join("\n").includes("第一份") && pickerLines.join("\n").includes("第二份"));
		check("E: 手写问卷题型推断为 single", pickerLines.join("\n").includes("a-first"));
		picker.handleInput(K.down); // 选第二份
		picker.handleInput(K.enter);
		await new Promise((r) => setTimeout(r, 10));
		check("E: 选中后打开问卷页", captures.customs.length === 2);
		const page = openCaptured(captures, 1);
		assertFullscreen(page, "E: 第二份渲染");
		page.handleInput(K.escape); // 搁置不写答案
		await cmdP;
		const saved = JSON.parse(readFileSync(join(qDir, "b-second.json"), "utf8"));
		check("E: 搁置后 status=draft", saved.status === "draft");
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 F：非法参数报错 ----
	console.log("场景 F：非法问卷参数报错");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		let errMsg = "";
		try {
			await tool.execute("tc3", { title: "坏问卷", questions: [{ type: "single", question: "没选项" }] }, null, null, ctx);
		} catch (e) {
			errMsg = e.message;
		}
		check("F: single 缺 options 抛错", errMsg.includes("options"));
		check("F: 不打开 UI", captures.customs.length === 0);
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 G：action=cancel 作废问卷 ----
	console.log("场景 G：ask cancel 作废问卷");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		// 先创建并搁置一份
		const execP = tool.execute("tc4", FULL_PARAMS, null, null, ctx);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		comp.handleInput(K.escape);
		await execP;
		const file = join(dir, ".pi", "questionnaires", "test-survey.json");
		check("G: 搁置后文件存在", existsSync(file));
		check("G: 待答状态提示 1 份", typeof captures.statuses.ask === "string" && captures.statuses.ask.includes("1 份"));
		// cancel 作废
		const res = await tool.execute("tc5", { action: "cancel", id: "test-survey" }, null, null, ctx);
		check("G: details.status === cancelled", res.details?.status === "cancelled");
		check("G: 文件已删除", !existsSync(file));
		check("G: 待答状态已清除", captures.statuses.ask === undefined);
		check("G: 不打开 UI", captures.customs.length === 1);
		// cancel 不存在的问卷 → 报错且列出提示
		let errMsg = "";
		try {
			await tool.execute("tc6", { action: "cancel", id: "no-such" }, null, null, ctx);
		} catch (e) {
			errMsg = e.message;
		}
		check("G: 作废不存在的问卷报错", errMsg.includes("no-such"));
		// cancel 缺 id → 报错
		errMsg = "";
		try {
			await tool.execute("tc7", { action: "cancel" }, null, null, ctx);
		} catch (e) {
			errMsg = e.message;
		}
		check("G: cancel 缺 id 报错", errMsg.includes("id"));
		// create 缺 questions → 报错（title 缺省已改为自动取第一题问句，不再报错，见场景 J）
		errMsg = "";
		try {
			await tool.execute("tc8", { id: "x" }, null, null, ctx);
		} catch (e) {
			errMsg = e.message;
		}
		check("G: create 缺 questions 报错", errMsg.includes("questions"));
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 H：长内容折行不截断 ----
	console.log("场景 H：长题干/长选项折行展示");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const qTail = "结尾标记甲乙丙丁戊己庚辛";
		const dTail = "描述尾部子丑寅卯辰巳午未";
		const execP = tool.execute(
			"tc9",
			{
				title: "长内容问卷",
				questions: [
					{
						id: "q1",
						type: "single",
						question: "这是一段用于验证折行展示的超长题干。".repeat(8) + qTail,
						options: [
							{ label: "短选项" },
							{ label: "长选项", description: "这是一段很长的选项说明文字。".repeat(8) + dTail },
						],
					},
				],
			},
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		assertFullscreen(comp, "H: 长内容渲染");
		// 折行点会拆开标记串：续行有缩进、行尾有补位，逐行 trim 后拼接还原原始文本再断言
		const text = comp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("H: 长题干尾部完整可见（未截断）", text.includes(qTail));
		check("H: 长选项说明尾部完整可见（未截断）", text.includes(dTail));
		check("H: 折行后无截断省略号", !text.includes("…") && !text.includes("..."));
		comp.handleInput(K.escape);
		await execP;
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 I：执行失败如实渲染（不误报「无 UI 降级」）----
	console.log("场景 I：执行失败如实渲染错误原因");
	{
		const pi = makePi();
		mod.default(pi);
		const tool = pi.tools.find((t) => t.name === "ask");
		// 缺 questions 抛错：模拟 agent-loop 的 createErrorToolResult 传给 renderResult（details 为空）
		const errText = "ask 创建问卷需要 questions（至少 1 题，每题含完整问句 question 与题型 type）";
		const errComp = tool.renderResult(
			{ content: [{ type: "text", text: errText }], details: undefined },
			{},
			themeMock,
			{ isError: true, args: {} },
		);
		const errLine = errComp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("I: 失败显示真实原因", errLine.includes("需要 questions"));
		check("I: 失败不再误报「无 UI 降级」", !errLine.includes("无 UI") && !errLine.includes("无交互 UI"));
		// 非错误路径（真·无 UI 降级）仍显示降级文案
		const okComp = tool.renderResult(
			{ content: [{ type: "text", text: "x" }], details: { status: "text-fallback", title: "t", total: 1 } },
			{},
			themeMock,
			{ isError: false, args: {} },
		);
		check("I: 真降级仍显示降级文案", okComp.render(TERM_COLS).map((l) => l.trim()).join("").includes("转为文字提问"));
	}

	// ---- 场景 J：title 缺省自动取第一题问句（模型偶尔漏传 title，不再让整次创建失败）----
	console.log("场景 J：title 缺省自动取第一题问句");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const longQ = "这是一个超过三十个字符的超长问题，用来验证自动标题会在合适的位置截断并带上省略号结尾标记XYZ";
		const execP = tool.execute(
			"tc10",
			{ id: "auto-title", questions: [{ type: "single", question: longQ, options: [{ label: "a" }, { label: "b" }] }] },
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		const text = comp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("J: 页面标题取第一题问句", text.includes("这是一个超过三十个字符的超长问题"));
		comp.handleInput(K.escape);
		const result = await execP;
		check("J: details.title 为自动标题（带截断省略号）", typeof result.details?.title === "string" && result.details.title.endsWith("…"));
		const file = join(dir, ".pi", "questionnaires", "auto-title.json");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		check("J: 自动标题已落盘且长度受控", typeof saved.title === "string" && saved.title.endsWith("…") && Array.from(saved.title).length === 31);
		// renderCall：title 缺省时显示自动标题 + 标记
		const callComp = tool.renderCall({ questions: [{ question: longQ }] }, themeMock);
		const callText = callComp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("J: renderCall 显示自动标题与标记", callText.includes("创建问卷") && callText.includes("自动标题"));
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 K：note 只读说明题 ----
	console.log("场景 K：note 只读说明题");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const execP = tool.execute(
			"tc11",
			{
				id: "note-survey",
				title: "草稿审阅",
				questions: [
					{ id: "n1", type: "note", question: "待发消息草稿", content: "草稿第一行内容\n第二行**重点**内容" },
					{ id: "q1", type: "single", question: "这样发可以吗？", options: [{ label: "可以" }, { label: "要改" }] },
					{ id: "q2", type: "text", question: "修改意见", required: false },
				],
			},
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		assertFullscreen(comp, "K: 说明题渲染");
		const text = comp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("K: 说明题正文完整可见", text.includes("草稿第一行内容") && text.includes("第二行重点内容"));
		check("K: 说明题带 [说明] 标签", text.includes("[说明]"));
		check("K: 进度分母排除说明题（0/2）", text.includes("已答 0/2"));
		// 说明题不可聚焦：初始焦点就在 q1 首选项，空格直接选中
		comp.handleInput(K.space);
		comp.handleInput(K.enter);
		const result = await execP;
		check("K: 说明题不阻塞提交", result.details?.status === "submitted");
		const msg = result.content?.[0]?.text ?? "";
		check("K: 回执含作答项", msg.includes("可以"));
		check("K: 回执不重复携带说明正文", !msg.includes("草稿第一行内容"));
		check("K: details.total 只计可答题", result.details?.total === 2);
		// 纯说明问卷：Enter 即确认
		const execP2 = tool.execute(
			"tc12",
			{ id: "note-only", title: "仅说明", questions: [{ type: "note", content: "只是告知一段背景，无需作答。" }] },
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp2 = openCaptured(captures);
		assertFullscreen(comp2, "K: 纯说明问卷渲染");
		check("K: 纯说明问卷提示进入确认态", comp2.render(TERM_COLS).map((l) => l.trim()).join("").includes("仅说明"));
		comp2.handleInput(K.enter);
		const result2 = await execP2;
		check("K: 纯说明问卷 Enter 提交", result2.details?.status === "submitted");
		check("K: 纯说明回执标明仅含说明", (result2.content?.[0]?.text ?? "").includes("仅含只读说明"));
		// 说明题只有 content 时：标题取正文首行截断（schema 描述与实现必须一致）
		const execP3 = tool.execute(
			"tc18",
			{
				id: "note-title",
				title: "标题容错",
				questions: [{ type: "note", content: "这是一行超过三十个字符的说明正文首行内容用于验证自动标题截断XYZ" }],
			},
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp3 = openCaptured(captures);
		comp3.handleInput(K.escape);
		await execP3;
		const noteSaved = JSON.parse(readFileSync(join(dir, ".pi", "questionnaires", "note-title.json"), "utf8"));
		check(
			"K: 说明题缺标题时取正文首行截断",
			typeof noteSaved.questions[0].question === "string" &&
				noteSaved.questions[0].question.startsWith("这是一行超过三十个字符的说明正文首行") &&
				noteSaved.questions[0].question.endsWith("…"),
		);
		// 12 题上限：note 同样占额度
		let overMsg = "";
		try {
			await tool.execute(
				"tc19",
				{
					id: "over-limit",
					questions: [
						...Array.from({ length: 3 }, (_, i) => ({ type: "note", content: `说明 ${i + 1}` })),
						...Array.from({ length: 10 }, (_, i) => ({ type: "text", question: `问题 ${i + 1}` })),
					],
				},
				null,
				null,
				ctx,
			);
		} catch (e) {
			overMsg = e.message;
		}
		check("K: note 计入 12 题上限", overMsg.includes("上限 12"));
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 L：多行简答内 ↑↓ 行间移动 + Ctrl+W 删词 ----
	console.log("场景 L：多行简答行间移动与删词");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const execP = tool.execute(
			"tc13",
			{
				id: "multi-survey",
				title: "多行作答",
				questions: [
					{ id: "q1", type: "text", question: "详细描述", multiline: true },
					{ id: "q2", type: "single", question: "确认？", options: [{ label: "好" }, { label: "不" }] },
				],
			},
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		const statusText = () => comp.render(TERM_COLS).map((l) => l.trim()).join(" ");
		check("L: 初始焦点在 q1（第 1/2 题）", statusText().includes("第 1/2 题"));
		typeText(comp, "hello world");
		comp.handleInput(K.ctrlW); // 删掉 world
		comp.handleInput(K.shiftEnter); // 换行
		typeText(comp, "第二行");
		check("L: 光标在第 2 行", statusText().includes("第 2/2 行"));
		comp.handleInput(K.up);
		check("L: ↑ 回到上一行（未跳出本题）", statusText().includes("第 1/2 行") && statusText().includes("第 1/2 题"));
		comp.handleInput(K.down);
		comp.handleInput(K.down); // 末行再 ↓ → 跳出本题，落到 q2 首选项
		check("L: 末行 ↓ 跳出本题到 q2", statusText().includes("第 2/2 题"));
		comp.handleInput(K.up); // 回到 q1 输入行
		check("L: ↑ 回到 q1 输入行", statusText().includes("第 1/2 题"));
		comp.handleInput(K.enter); // q2 未答 → 跳转并提示
		check("L: 必答未完成时 Enter 不提交", captures.customs.length === 1);
		check("L: 提示指向第 2 题", statusText().includes("第 2 题尚未作答"));
		comp.handleInput(K.space);
		comp.handleInput(K.enter);
		const result = await execP;
		const msg = result.content?.[0]?.text ?? "";
		check("L: Ctrl+W 删除的 world 未进入答案", !msg.includes("world"));
		check("L: 多行答案完整送达（含换行后的第二行）", msg.includes("hello") && msg.includes("第二行"));
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 M：Ctrl+↑/↓ 跳题 ----
	console.log("场景 M：Ctrl+↑/↓ 题间跳转");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const execP = tool.execute(
			"tc14",
			{
				id: "jump-survey",
				title: "跳题",
				questions: [
					{ id: "q1", type: "single", question: "A？", options: [{ label: "a1" }, { label: "a2" }, { label: "a3" }] },
					{ id: "q2", type: "single", question: "B？", options: [{ label: "b1" }, { label: "b2" }] },
					{ id: "q3", type: "single", question: "C？", options: [{ label: "c1" }, { label: "c2" }] },
				],
			},
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		const statusText = () => comp.render(TERM_COLS).map((l) => l.trim()).join(" ");
		check("M: 起始在第 1/3 题", statusText().includes("第 1/3 题"));
		comp.handleInput(K.ctrlDown);
		check("M: Ctrl+↓ 到第 2/3 题", statusText().includes("第 2/3 题"));
		comp.handleInput(K.ctrlDown);
		check("M: Ctrl+↓ 到第 3/3 题", statusText().includes("第 3/3 题"));
		comp.handleInput(K.ctrlDown);
		check("M: 末题再 Ctrl+↓ 停在原地", statusText().includes("第 3/3 题"));
		comp.handleInput(K.ctrlUp);
		check("M: Ctrl+↑ 回第 2/3 题", statusText().includes("第 2/3 题"));
		comp.handleInput(K.escape);
		await execP;
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 N：Ctrl+P 答案一览 ----
	console.log("场景 N：Ctrl+P 答案一览");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const execP = tool.execute(
			"tc15",
			{
				id: "review-survey",
				title: "答案预览",
				questions: [
					{ id: "q1", type: "single", question: "选哪个方案？", options: [{ label: "方案甲" }, { label: "方案乙" }] },
					{ id: "q2", type: "single", question: "第二问？", options: [{ label: "是" }, { label: "否" }] },
				],
			},
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		comp.handleInput(K.space); // q1 选方案甲
		comp.handleInput(K.ctrlP);
		const text = comp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("N: 一览屏标题可见", text.includes("答案一览"));
		check("N: 一览屏含已答项", text.includes("方案甲"));
		check("N: 一览屏标出未答项", text.includes("未答") || text.includes("跳过"));
		check("N: 一览屏提示 C 复制", text.includes("C 复制答案"));
		assertFullscreen(comp, "N: 一览屏渲染");
		comp.handleInput(K.escape); // 返回作答页
		const backText = comp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("N: 返回作答页（选中后焦点已到第 2 题）", backText.includes("第 2/2 题") && !backText.includes("答案一览"));
		// 帮助屏
		comp.handleInput("?");
		const helpText = comp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("N: ? 打开键位表", helpText.includes("键位表"));
		check("N: 键位表含 Ctrl+P / x / Ctrl+D 说明", helpText.includes("Ctrl+P") && helpText.includes("Ctrl+D"));
		assertFullscreen(comp, "N: 帮助屏渲染");
		comp.handleInput(K.up); // 任意键返回
		check("N: 任意键返回作答页", !comp.render(TERM_COLS).map((l) => l.trim()).join("").includes("键位表"));
		comp.handleInput(K.escape);
		await execP;
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 O：D 键删除问卷（二次确认）----
	console.log("场景 O：D 键删除问卷");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const execP = tool.execute("tc16", FULL_PARAMS, null, null, ctx);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		comp.handleInput("D");
		const armText = comp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("O: 第一次 D 仅进入确认态", armText.includes("再按一次") && captures.customs.length === 1);
		comp.handleInput(K.up); // 其他键取消确认
		check("O: 其他键取消确认态", !comp.render(TERM_COLS).map((l) => l.trim()).join("").includes("再按一次"));
		comp.handleInput("D");
		comp.handleInput("D");
		const result = await execP;
		check("O: details.status === deleted", result.details?.status === "deleted");
		check("O: 工具结果告知不再追问", (result.content?.[0]?.text ?? "").includes("不要追问"));
		check("O: 问卷文件已删除", !existsSync(join(dir, ".pi", "questionnaires", "test-survey.json")));
		check("O: 待答状态已清除", captures.statuses.ask === undefined);
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 P：选择器里删除问卷 ----
	console.log("场景 P：选择器删除问卷");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const qDir = join(dir, ".pi", "questionnaires");
		mkdirSync(qDir, { recursive: true });
		writeFileSync(
			join(qDir, "a-first.json"),
			JSON.stringify({ id: "a-first", title: "第一份", createdAt: "2026-01-01T00:00:00Z", questions: [{ type: "text", question: "随便说说" }] }),
		);
		writeFileSync(
			join(qDir, "b-second.json"),
			JSON.stringify({ id: "b-second", title: "第二份", createdAt: "2026-01-02T00:00:00Z", questions: [{ type: "text", question: "随便说说" }] }),
		);
		const cmdP = pi.commands.answer.handler("", ctx);
		await new Promise((r) => setTimeout(r, 10));
		const picker = openCaptured(captures, 0);
		check("P: 选择器显示创建时间", picker.render(60).join("\n").includes("00:00"));
		picker.handleInput("D");
		check("P: 第一次 D 进入确认态", picker.render(60).join("\n").includes("再按一次"));
		picker.handleInput("D");
		check("P: 选中项文件已删除", !existsSync(join(qDir, "a-first.json")));
		picker.handleInput(K.up); // 任意其他键清除操作提示
		const afterDel = picker.render(60).join("\n");
		check("P: 剩余项仍在列表", afterDel.includes("第二份") && !afterDel.includes("第一份"));
		picker.handleInput(K.escape);
		await cmdP;
		check("P: 全部取消后不打开回答页", captures.customs.length === 1);
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 Q：滚动提示不遮正文 + x 展开说明 ----
	console.log("场景 Q：滚动提示移出正文与说明展开");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const noteLines = Array.from({ length: 40 }, (_, i) => `草稿第${i + 1}行内容`).join("\n");
		const execP = tool.execute(
			"tc17",
			{
				id: "scroll-survey",
				title: "滚动与折叠",
				questions: [
					{ id: "n1", type: "note", question: "长草稿", content: noteLines },
					{ id: "q1", type: "single", question: "审阅通过？", options: [{ label: "通过" }, { label: "驳回" }] },
				],
			},
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		const lines = comp.render(TERM_COLS);
		const text = lines.map((l) => l.trim()).join("");
		check("Q: 首帧停在顶部（说明正文首行可见）", text.includes("草稿第1行内容"));
		check("Q: 旧式覆盖正文的滚动提示已移除", !text.includes("上方还有") && !text.includes("下方还有"));
		check("Q: 折叠提示带行数与 x 展开入口", /已折叠显示前 \d+ 行（x 展开全文）/.test(text));
		check("Q: 滚动指示在状态行（▼）", /▼\d+/.test(text));
		comp.handleInput("x"); // 展开
		const expanded = comp.render(TERM_COLS).map((l) => l.trim()).join("");
		check("Q: x 展开后显示收起提示", expanded.includes("x 收起"));
		check("Q: x 展开后折叠提示消失", !/还有 \d+ 行未显示/.test(expanded));
		check("Q: x 展开后仍停在顶部", expanded.includes("草稿第1行内容"));
		comp.handleInput(K.escape);
		await execP;
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 R：问卷级上下文（context 参数 + includeLastMessage 自动提取） ----
	console.log("场景 R：问卷级上下文展示与上一条回复自动附带");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		// 会话条目：user → assistant（带文本）→ assistant（纯工具调用，无文本）
		// 提取应跳过无文本的当前消息，捞到上一条 assistant 文本，且不越过 user 边界
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我看看选哪个方案" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "我倾向方案 A：成本最低，但扩展性差。" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ask" }] } },
		];
		const ctx = makeCtx(dir, captures, { sessionManager: { getEntries: () => entries } });
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const execP = tool.execute(
			"tc18",
			{
				id: "ctx-survey",
				title: "方案确认",
				context: "补充：预算上限 5 万。",
				includeLastMessage: true,
				questions: [
					{ id: "q1", type: "single", question: "按上面的分析，选哪个方案？", options: [{ label: "方案 A" }, { label: "方案 B" }] },
				],
			},
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const saved = JSON.parse(readFileSync(join(dir, ".pi", "questionnaires", "ctx-survey.json"), "utf8"));
		check(
			"R: context 合并上一条回复与手动背景（自动在前）",
			typeof saved.context === "string" &&
				saved.context.includes("我倾向方案 A") &&
				saved.context.includes("预算上限 5 万") &&
				saved.context.indexOf("我倾向方案 A") < saved.context.indexOf("预算上限 5 万"),
		);
		const comp = openCaptured(captures);
		const text = comp.render(TERM_COLS).map((l) => l.trim()).join("\n");
		check("R: 页面顶部渲染上下文块", text.includes("💬 上下文") && text.includes("我倾向方案 A"));
		check("R: 手动 context 也在页面上", text.includes("预算上限 5 万"));
		assertFullscreen(comp, "R");
		comp.handleInput(K.escape);
		await execP;

		// 长上下文：默认折叠 + x 展开（与说明题共享 expandNotes）
		const longCtx = Array.from({ length: 15 }, (_, i) => `背景第${i + 1}行`).join("\n");
		const captures2 = makeCaptures();
		const ctx2 = makeCtx(dir, captures2);
		const execP2 = tool.execute(
			"tc19",
			{
				id: "ctx-long",
				title: "长上下文",
				context: longCtx,
				questions: [{ id: "q1", type: "confirm", question: "继续吗？" }],
			},
			null,
			null,
			ctx2,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp2 = openCaptured(captures2);
		const folded = comp2.render(TERM_COLS).map((l) => l.trim()).join("\n");
		check("R: 长上下文默认折叠", folded.includes("已折叠") && folded.includes("背景第1行") && !folded.includes("背景第15行"));
		comp2.handleInput("x");
		const expanded = comp2.render(TERM_COLS).map((l) => l.trim()).join("\n");
		check("R: x 展开后可见全部上下文", expanded.includes("背景第15行"));
		assertFullscreen(comp2, "R-long");
		comp2.handleInput(K.escape);
		await execP2;
		rmSync(dir, { recursive: true, force: true });
	}

	// ---- 场景 S：超长上下文展开后滚轮滚动可达全文（不截断、可回滚） ----
	console.log("场景 S：超长上下文滚轮滚动");
	{
		const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
		const pi = makePi();
		mod.default(pi);
		const captures = makeCaptures();
		const ctx = makeCtx(dir, captures);
		await pi.events.session_start({}, ctx);
		const tool = pi.tools.find((t) => t.name === "ask");
		const longCtx = Array.from({ length: 40 }, (_, i) => `背景第${i + 1}行`).join("\n");
		const execP = tool.execute(
			"tc20",
			{
				id: "ctx-wheel",
				title: "超长上下文",
				context: longCtx,
				questions: [{ id: "q1", type: "confirm", question: "继续吗？" }],
			},
			null,
			null,
			ctx,
		);
		await new Promise((r) => setTimeout(r, 10));
		const comp = openCaptured(captures);
		const text = () => comp.render(TERM_COLS).map((l) => l.trim()).join("\n");
		const wheel = (delta) => comp.handleMouse({
			type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0,
			width: TERM_COLS, height: TERM_ROWS, shift: false, alt: false, ctrl: false, wheelDelta: delta,
		});
		comp.handleInput("x"); // 展开全部 40 行上下文（超出一屏）
		const top = text();
		check("S: 展开后首帧在顶部（背景第1行可见）", top.includes("背景第1行"));
		check("S: 展开后尾部不在首屏（未被截断进画面）", !top.includes("背景第40行"));
		check("S: 滚轮事件被页面消费", wheel(30)?.handled === true);
		const scrolled = text();
		check("S: 滚轮下滑后可见上下文尾部", scrolled.includes("背景第40行"));
		check("S: 状态行出现上滚指示（▲）", /▲\d+/.test(scrolled));
		wheel(-30);
		check("S: 滚轮回滚后重返顶部", text().includes("背景第1行"));
		assertFullscreen(comp, "S");
		comp.handleInput(K.escape);
		await execP;
		rmSync(dir, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
