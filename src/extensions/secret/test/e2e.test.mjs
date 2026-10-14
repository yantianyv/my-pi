#!/usr/bin/env node
/**
 * secret 扩展端到端回归测试（假 pi / 假 ctx 驱动真实钩子链）
 *
 * 覆盖的是「密钥有没有可能漏出去」这条链路上的每一道网，所以断言都对着实际返回值写：
 *   1. 面板录入（唯一入口）→ secret_list 只给名字；
 *   2. 粘进对话的凭证在落盘前换成 ref；
 *   3. bash 工具真跑一次 shell：命令里是 ${PI_SEC_*}、真值从环境变量进子进程，process.env 不被污染；
 *   4. tool_result / context / before_provider_request 三道出口网都能把真值换回 ref；
 *   5. 名字不存在、两个名字撞成同一环境变量时阻断执行；
 *   6. 会话内首次使用的确认面板（记住后不再问）；
 *   7. 面板收口：一个 /secret 命令管录入、指纹表、设置与帮助；
 *   8. AI 主动索要密码（secret_prompt）；
 *   9. 跨会话的长期指纹：值没了仍能认出并遮住，但不能拿来执行；
 *  10. 会话生命周期（reload 保留、退出清空）。
 *
 * 用法：node src/extensions/secret/test/e2e.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../../..");
const BUNDLE = join(TEST_DIR, ".tmp-e2e.mjs");
const ESC = "\u001b";
const ENTER = "\r";

/** 每个实例一个独立配置目录（指纹表随之隔离）；显式传 dir 时共用，用于跨会话场景。 */
const DIRS = new Set();
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "secret-e2e-"));
DIRS.add(CONFIG_DIR);
process.env.SECRET_CONFIG_DIR = CONFIG_DIR;

const SECRET = "hunter2xyz-super-secret";
const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
/** 没有任何供应商前缀、周围也没有关键词，靠形态识别认不出来，只能靠长期指纹。 */
const PLAIN_PW = "Zq7-tR4mWp2xLb9Ns6Kd";

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
		failures++;
	}
};

const themeMock = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const makeTui = () => ({ terminal: { rows: 24, columns: 80 }, requestRender() {} });

function makePi(bundlePath) {
	const pi = {
		tools: [],
		commands: {},
		events: {},
		registerTool(tool) {
			pi.tools.push(tool);
		},
		registerCommand(name, command) {
			pi.commands[name] = command;
		},
		on(name, handler) {
			pi.events[name] = handler;
		},
		getAllTools() {
			return pi.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				sourceInfo: { path: bundlePath, source: "extension", scope: "global", origin: "extension" },
			}));
		},
	};
	return pi;
}

/** 每轮测试用新会话 id，互不共享会话内存库。 */
function makeCtx(sessionId) {
	const captures = { customs: [], statuses: {}, notifies: [], selects: [], confirms: [], confirmAnswer: true };
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			setStatus: (key, text) => {
				captures.statuses[key] = text;
			},
			notify: (text, kind) => {
				captures.notifies.push({ text, kind });
			},
			select: async (title, options) => {
				captures.selects.push({ title, options });
				return options[0];
			},
			confirm: async (title, message) => {
				captures.confirms.push({ title, message });
				return captures.confirmAnswer;
			},
			custom: (factory, options) =>
				new Promise((resolve) => {
					captures.customs.push({ component: factory(makeTui(), themeMock, {}, resolve), options });
				}),
		},
		sessionManager: { getSessionFile: () => `/tmp/${sessionId}.jsonl`, getSessionId: () => sessionId },
	};
	return { ctx, captures };
}

const textOf = (result) => result.content.map((block) => block.text ?? "").join("\n");
const listTool = (pi) => pi.tools.find((tool) => tool.name === "secret_list");
const bashTool = (pi) => pi.tools.find((tool) => tool.name === "bash");

/** 取第 index 个浮层的组件（同一测试会先后弹多次，所以按绝对下标定位）。 */
const panelAt = (captures, index) => captures.customs.at(index).component;

/** 往指定浮层敲键：先整串喂文本，再敲 key。 */
function typeIntoAt(captures, index, text, key = ENTER) {
	const component = panelAt(captures, index);
	for (const ch of text) component.handleInput(ch);
	component.handleInput(key);
}

/** 等一个条件成立（驱动多步浮层时不必去数微任务）。 */
const waitFor = async (predicate, tries = 40) => {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return true;
		await Promise.resolve();
	}
	return false;
};

await build({
	entryPoints: [join(SRC_DIR, "extensions", "secret", "index.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	logLevel: "silent",
});

const BUNDLE_PATH = fileURLToPath(new URL(".tmp-e2e.mjs", import.meta.url));
const mod = await import(pathToFileURL(BUNDLE));

/** 起一个独立的扩展实例：写配置 → 建假 pi/ctx → 调 default(pi)。 */
function boot(config, sessionId, dir) {
	const target = dir ?? mkdtempSync(join(tmpdir(), "secret-e2e-"));
	DIRS.add(target);
	process.env.SECRET_CONFIG_DIR = target;
	writeFileSync(join(target, "secret-config.json"), JSON.stringify(config), "utf8");
	const pi = makePi(BUNDLE_PATH);
	const { ctx, captures } = makeCtx(sessionId);
	mod.default(pi);
	return { pi, ctx, captures, dir: target };
}

/** 走一遍面板录入：/secret 开面板 → a（或 t）→ 填名字 → 掩码填值 → 回面板 → esc 关。 */
async function addSecret(booted, name, value, options = {}) {
	const base = booted.captures.customs.length;
	const panelDone = booted.pi.commands.secret.handler("", booted.ctx);
	if (!(await waitFor(() => booted.captures.customs.length >= base + 1))) throw new Error("面板没弹出来");
	panelAt(booted.captures, base).handleInput(options.text ? "t" : "a");
	if (!(await waitFor(() => booted.captures.customs.length >= base + 2))) throw new Error("名字输入框没弹出来");
	typeIntoAt(booted.captures, base + 1, name);
	if (!(await waitFor(() => booted.captures.customs.length >= base + 3))) throw new Error("掩码框没弹出来");
	typeIntoAt(booted.captures, base + 2, value);
	if (!(await waitFor(() => booted.captures.customs.length >= base + 4))) throw new Error("录入后没回到面板");
	typeIntoAt(booted.captures, base + 3, "", ESC);
	await panelDone;
}

try {
	// ── 场景 1：面板录入 + secret_list ────────────────────────────────────
	console.log("场景 1：面板录入与名字清单");
	const s1 = boot({ enabled: true, confirm: "never" }, "s1");
	await s1.pi.events.session_start({ type: "session_start", reason: "startup" }, s1.ctx);
	await addSecret(s1, "db_pass", SECRET);
	const list1 = await listTool(s1.pi).execute(undefined, {}, undefined, undefined, s1.ctx);
	check("库里能查到名字", textOf(list1).includes("{{sec:db_pass}}"), textOf(list1));
	check("清单不含值", !textOf(list1).includes(SECRET));
	check("清单不含值的任何片段", !textOf(list1).includes(SECRET.slice(0, 8)));
	check("状态行已推送条数", s1.captures.statuses.secret === "🔐 secret 1 条", s1.captures.statuses.secret);
	check("bash 归属检查通过（无告警）", !s1.captures.notifies.some((n) => n.kind === "error"));

	// ── 场景 2：粘贴即捕获 ────────────────────────────────────────────────
	console.log("场景 2：粘进对话的凭证在落盘前变成 ref");
	const in2 = await s1.pi.events.input({ type: "input", text: `帮我拿 ${TOKEN} 调接口`, source: "interactive" }, s1.ctx);
	check("返回 transform", in2?.action === "transform", JSON.stringify(in2));
	check("文本里已无明文", !in2.text.includes(TOKEN), in2.text);
	check("明文换成 ref", /\{\{sec:auto_\d+\}\}/.test(in2.text), in2.text);
	check("有回执告知用户", s1.captures.notifies.some((n) => n.text.includes("已收进本次会话")));

	// ── 场景 3：bash 真跑一次，验证环境变量注入 ──────────────────────────
	console.log("场景 3：bash 的按次环境变量注入");
	const bashEvent = { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: `printf '%s' "{{sec:db_pass}}"` } };
	const verdict = await s1.pi.events.tool_call(bashEvent, s1.ctx);
	check("tool_call 放行（不阻断）", verdict === undefined, JSON.stringify(verdict));
	check("命令参数保持 ref（转录里没有明文）", bashEvent.input.command.includes("{{sec:db_pass}}"));
	const ran = await bashTool(s1.pi).execute("t1", { command: `printf '%s' "{{sec:db_pass}}"` }, undefined, undefined, s1.ctx);
	check("子进程拿到真值", textOf(ran).includes(SECRET), textOf(ran));
	check("process.env 没被污染", Object.keys(process.env).every((k) => !k.startsWith("PI_SEC_")));

	// ── 场景 4：三道出口网 ────────────────────────────────────────────────
	console.log("场景 4：出口脱敏");
	const out4 = await s1.pi.events.tool_result(
		{
			type: "tool_result",
			toolCallId: "t2",
			input: {},
			content: [{ type: "text", text: `token=${TOKEN}` }],
			details: { raw: TOKEN },
			structuredContent: { output: TOKEN },
			isError: false,
		},
		s1.ctx,
	);
	check("tool_result 正文脱敏", out4.content[0].text.includes("{{sec:") && !out4.content[0].text.includes(TOKEN), out4.content[0].text);
	check("tool_result details 脱敏", !JSON.stringify(out4.details).includes(TOKEN));
	check("structuredContent 一并改写（否则会被 pi 丢弃）", !JSON.stringify(out4.structuredContent).includes(TOKEN), JSON.stringify(out4.structuredContent));

	const ctx4 = await s1.pi.events.context(
		{ type: "context", messages: [{ role: "user", content: [{ type: "text", text: `密码 ${SECRET} 拿去` }] }] },
		s1.ctx,
	);
	check("context 脱敏", !JSON.stringify(ctx4.messages).includes(SECRET), JSON.stringify(ctx4.messages));

	const pay4 = await s1.pi.events.before_provider_request({ type: "before_provider_request", payload: { messages: [{ content: SECRET }] } }, s1.ctx);
	check("请求体脱敏", !JSON.stringify(pay4).includes(SECRET), JSON.stringify(pay4));
	await s1.pi.events.turn_end({ type: "turn_end" }, s1.ctx);
	check("请求体钩子生效时不告警", !s1.captures.notifies.some((n) => n.text.includes("最后一道网缺席")));

	// ── 场景 5：缺名字 / 撞名阻断 ─────────────────────────────────────────
	console.log("场景 5：名字校验");
	const missing = await s1.pi.events.tool_call({ type: "tool_call", toolCallId: "t3", toolName: "bash", input: { command: "echo {{sec:nope}}" } }, s1.ctx);
	check("缺名字阻断", missing?.block === true && missing.reason.includes("{{sec:nope}}"), JSON.stringify(missing));
	await addSecret(s1, "a-b", "0123456789");
	await addSecret(s1, "a.b", "0123456789");
	const collide = await s1.pi.events.tool_call(
		{ type: "tool_call", toolCallId: "t5", toolName: "bash", input: { command: "echo {{sec:a-b}} {{sec:a.b}}" } },
		s1.ctx,
	);
	check("撞名阻断（a-b 与 a.b 都会变成 A_B）", collide?.block === true && collide.reason.includes("撞"), JSON.stringify(collide));

	// ── 场景 6：会话内首次确认 ────────────────────────────────────────────
	console.log("场景 6：使用确认面板");
	const s6 = boot({ enabled: true, confirm: "session" }, "s6");
	await s6.pi.events.session_start({ type: "session_start", reason: "startup" }, s6.ctx);
	await addSecret(s6, "api_key", SECRET);
	const panelsBefore = s6.captures.customs.length;
	const first = s6.pi.events.tool_call({ type: "tool_call", toolCallId: "t6", toolName: "bash", input: { command: "echo {{sec:api_key}}" } }, s6.ctx);
	await waitFor(() => s6.captures.customs.length > panelsBefore);
	check("首次使用弹确认面板", s6.captures.customs.length === panelsBefore + 1);
	typeIntoAt(s6.captures, panelsBefore, "", "2"); // 2 = 本次会话不再询问
	check("记住后放行", (await first) === undefined);
	const panelsAfter = s6.captures.customs.length;
	const second = await s6.pi.events.tool_call({ type: "tool_call", toolCallId: "t7", toolName: "bash", input: { command: "echo {{sec:api_key}}" } }, s6.ctx);
	check("同会话第二次不再问", second === undefined && s6.captures.customs.length === panelsAfter);

	// ── 场景 7：关掉总开关后一切放行，且不做捕获与脱敏 ────────────────────
	console.log("场景 7：关闭开关");
	const s7 = boot({ enabled: false }, "s7");
	await s7.pi.events.session_start({ type: "session_start", reason: "startup" }, s7.ctx);
	check("关闭时不做捕获", (await s7.pi.events.input({ type: "input", text: `裸值 ${TOKEN}`, source: "interactive" }, s7.ctx)) === undefined);
	const off2 = await s7.pi.events.tool_result(
		{ type: "tool_result", toolCallId: "t8", input: {}, content: [{ type: "text", text: TOKEN }], details: {}, isError: false },
		s7.ctx,
	);
	check("关闭时不做脱敏", off2 === undefined);

	// ── 场景 8：会话生命周期 ──────────────────────────────────────────────
	console.log("场景 8：会话生命周期");
	await s1.pi.events.session_shutdown({ type: "session_shutdown", reason: "quit" }, s1.ctx);
	const afterQuit = await listTool(s1.pi).execute(undefined, {}, undefined, undefined, s1.ctx);
	check("退出后库为空", textOf(afterQuit).includes("还没有录入"), textOf(afterQuit));
	const s8 = boot({ enabled: true }, "s8");
	await s8.pi.events.session_start({ type: "session_start", reason: "startup" }, s8.ctx);
	await addSecret(s8, "keep_me", SECRET);
	await s8.pi.events.session_shutdown({ type: "session_shutdown", reason: "reload" }, s8.ctx);
	const afterReload = await listTool(s8.pi).execute(undefined, {}, undefined, undefined, s8.ctx);
	check("reload 保留库", textOf(afterReload).includes("{{sec:keep_me}}"), textOf(afterReload));

	// ── 场景 9：非 bash 工具的 ref 参数展开 ───────────────────────────────
	console.log("场景 9：工具参数展开");
	const s9 = boot({ enabled: true, confirm: "never" }, "s9");
	await s9.pi.events.session_start({ type: "session_start", reason: "startup" }, s9.ctx);
	await addSecret(s9, "db_pass", SECRET);
	const writeEvent = { type: "tool_call", toolCallId: "t9", toolName: "write", input: { path: "/tmp/x.env", content: `DB_PASSWORD={{sec:db_pass}}` } };
	const writeVerdict = await s9.pi.events.tool_call(writeEvent, s9.ctx);
	check("write 放行", writeVerdict === undefined);
	check("write 内容已换成真值", writeEvent.input.content === `DB_PASSWORD=${SECRET}`, writeEvent.input.content);
	const readEvent = { type: "tool_call", toolCallId: "t10", toolName: "read", input: { path: "{{sec:db_pass}}" } };
	await s9.pi.events.tool_call(readEvent, s9.ctx);
	check("read 这类工具不展开（ref 在那里没有意义）", readEvent.input.path === "{{sec:db_pass}}", readEvent.input.path);

	// ── 场景 10：给模型的说明 ─────────────────────────────────────────────
	console.log("场景 10：提示词注入");
	const started = await s9.pi.events.before_agent_start({ type: "before_agent_start", systemPrompt: "BASE" }, s9.ctx);
	check("提示词追加了用法说明", started.systemPrompt.startsWith("BASE") && started.systemPrompt.includes("{{sec:名字}}"));
	const s10 = boot({ enabled: false }, "s10");
	check("关闭时不注入说明", (await s10.pi.events.before_agent_start({ type: "before_agent_start", systemPrompt: "BASE" }, s10.ctx)) === undefined);

	// ── 场景 11：AI 主动索要密码 ──────────────────────────────────────────
	console.log("场景 11：AI 索要密码");
	const s11 = boot({ enabled: true, confirm: "never" }, "s11");
	await s11.pi.events.session_start({ type: "session_start", reason: "startup" }, s11.ctx);
	const promptTool = s11.pi.tools.find((t) => t.name === "secret_prompt");
	check("secret_prompt 已注册", !!promptTool);
	const asked = promptTool.execute("t11", { name: "db_pass", why: "连接生产库" }, undefined, undefined, s11.ctx);
	typeIntoAt(s11.captures, 0, SECRET);
	const askedResult = await asked;
	check("只把名字交回给 AI", textOf(askedResult).includes("{{sec:db_pass}}") && !textOf(askedResult).includes(SECRET), textOf(askedResult));
	check("值确实进了库", textOf(await listTool(s11.pi).execute(undefined, {}, undefined, undefined, s11.ctx)).includes("{{sec:db_pass}}"));
	check("同名已存在时不再索要", (await promptTool.execute("t12", { name: "db_pass", why: "x" }, undefined, undefined, s11.ctx)).isError === true);
	check("非法名字直接失败", (await promptTool.execute("t13", { name: "1bad", why: "x" }, undefined, undefined, s11.ctx)).isError === true);
	const cancelling = promptTool.execute("t14", { name: "other", why: "x" }, undefined, undefined, s11.ctx);
	typeIntoAt(s11.captures, s11.captures.customs.length - 1, "", ESC);
	const cancelled = await cancelling;
	check("用户取消时不录入、明确失败", cancelled.isError === true && !textOf(await listTool(s11.pi).execute(undefined, {}, undefined, undefined, s11.ctx)).includes("other"));

	// ── 场景 12：跨会话的长期指纹 ────────────────────────────────────────
	console.log("场景 12：跨会话的长期指纹");
	const sharedDir = mkdtempSync(join(tmpdir(), "secret-shared-"));
	DIRS.add(sharedDir);
	const s12a = boot({ enabled: true, confirm: "never" }, "s12a", sharedDir);
	await s12a.pi.events.session_start({ type: "session_start", reason: "startup" }, s12a.ctx);
	// 裸口令形态与关键词都认不出：入口会问一次「这像密钥吗」。
	s12a.captures.confirmAnswer = false;
	check(
		"裸口令先问一句，答不是就原样放过",
		(await s12a.pi.events.input({ type: "input", text: `值 ${PLAIN_PW}`, source: "interactive" }, s12a.ctx)) === undefined &&
			s12a.captures.confirms.length === 1,
	);
	const askedTimes = s12a.captures.confirms.length;
	check(
		"答过不是之后不再问第二次",
		(await s12a.pi.events.input({ type: "input", text: `还是 ${PLAIN_PW}`, source: "interactive" }, s12a.ctx)) === undefined &&
			s12a.captures.confirms.length === askedTimes,
	);
	check("没确认就不入库", !textOf(await listTool(s12a.pi).execute(undefined, {}, undefined, undefined, s12a.ctx)).includes("{{sec:"));
	await addSecret(s12a, "prod_pw", PLAIN_PW);
	await s12a.pi.events.session_shutdown({ type: "session_shutdown", reason: "quit" }, s12a.ctx);
	const s12b = boot({ enabled: true, confirm: "never" }, "s12b", sharedDir);
	await s12b.pi.events.session_start({ type: "session_start", reason: "startup" }, s12b.ctx);
	const recalled = await s12b.pi.events.input({ type: "input", text: `接着用 ${PLAIN_PW}`, source: "interactive" }, s12b.ctx);
	check("新会话里认出旧口令并遮住", recalled?.action === "transform" && !recalled.text.includes(PLAIN_PW), JSON.stringify(recalled));
	check("占位写明本会话没有值", recalled.text.includes("本会话没有值"), recalled.text);
	const cannotRun = await s12b.pi.events.tool_call(
		{ type: "tool_call", toolCallId: "t15", toolName: "bash", input: { command: "echo {{sec:prod_pw}}" } },
		s12b.ctx,
	);
	check("指纹不能代替值去执行", cannotRun?.block === true, JSON.stringify(cannotRun));

	// ── 场景 13：面板收口（一个命令管全部） ──────────────────────────────
	console.log("场景 13：/secret 面板");
	const s13 = boot({ enabled: true, confirm: "session" }, "s13");
	await s13.pi.events.session_start({ type: "session_start", reason: "startup" }, s13.ctx);
	const base13 = s13.captures.customs.length;
	const panelDone = s13.pi.commands.secret.handler("", s13.ctx);
	check("无参打开面板", s13.captures.customs.length === base13 + 1);
	const panel = panelAt(s13.captures, base13);
	const listFrame = panel.render(80).join("\n");
	check("列表页给出全部入口", ["新增密钥", "长期指纹表", "设置", "帮助"].every((k) => listFrame.includes(k)), listFrame);
	check("空库时给出提示", listFrame.includes("（空）"), listFrame);
	let narrowOk = true;
	try {
		panel.render(30);
		panel.render(120);
	} catch (err) {
		narrowOk = false;
	}
	check("窄/宽终端下渲染不抛错", narrowOk);
	panel.handleInput("?");
	check("帮助页可进", panel.render(80).join("\n").includes("怎么用"));
	panel.handleInput(ESC);
	panel.handleInput("s");
	check("设置页可进", panel.render(80).join("\n").includes("使用确认"));
	panel.handleInput(" ");
	check(
		"面板改设置立即落盘（不必记 /secret-config 参数）",
		JSON.parse(readFileSync(join(s13.dir, "secret-config.json"), "utf8")).confirm === "never",
	);
	panel.handleInput(ESC);
	panel.handleInput("a");
	check("按 a 进入新增流程", await waitFor(() => s13.captures.customs.length >= base13 + 2));
	typeIntoAt(s13.captures, base13 + 1, "panel_key");
	check("接着弹掩码框", await waitFor(() => s13.captures.customs.length >= base13 + 3));
	typeIntoAt(s13.captures, base13 + 2, SECRET);
	check("录入后回到面板", await waitFor(() => s13.captures.customs.length >= base13 + 4));
	check("新条目出现在列表里", panelAt(s13.captures, base13 + 3).render(80).join("\n").includes("panel_key"));
	typeIntoAt(s13.captures, base13 + 3, "", ESC);
	await panelDone;
	check("面板录入的值可以正常引用", textOf(await listTool(s13.pi).execute(undefined, {}, undefined, undefined, s13.ctx)).includes("{{sec:panel_key}}"));
} finally {
	rmSync(BUNDLE, { force: true });
	for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
	delete process.env.SECRET_CONFIG_DIR;
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
