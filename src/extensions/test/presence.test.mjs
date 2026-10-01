#!/usr/bin/env node
/**
 * shared/presence 与 status-beacon 提示音门控回归测试
 *
 * 覆盖：
 * - 场景 A：跨实例在场判定——computeActive / computeAway 三态（有/无系统空闲读数）
 * - 场景 B：在场文件——initPresence 写自身、markUserInput/dispose、死进程与陈旧档不算在场
 * - 场景 C：全局提示音去重——第一个拿到名额、窗口期内第二个让位、超龄回收后可再拿
 * - 场景 D：status-beacon 接线——人不在时收尾出声；人在键盘上时只闪不出声；第二声只在人不在时响
 *
 * 用法：node src/extensions/shared/test/presence.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "presence-test-"));
const presenceDir = join(tmp, "presence");
process.env.PI_PRESENCE_DIR = presenceDir;

async function bundle(entry, name) {
	// bundle 落在本目录（src/extensions/test/ 有指向 pi 全局包的 node_modules junction），
	// 这样 node 才能解析 external 的 @earendil-works/* 依赖
	const outfile = join(TEST_DIR, `.tmp-${name}`);
	await build({
		entryPoints: [join(SRC_DIR, "extensions", entry)],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});
	return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

// ---------------------------------------------------------------------------
// 场景 A：判定纯函数
// ---------------------------------------------------------------------------
{
	console.log("场景 A：在场判定");
	const P = await bundle("shared/presence.ts", "presence-bundle.mjs");
	check("A: 系统空闲 < 阈值 → 人在操作", P.computeActive(5_000, Number.POSITIVE_INFINITY, 20_000) === true);
	check("A: 系统空闲 ≥ 阈值 → 人不在操作", P.computeActive(60_000, 0, 20_000) === false);
	check(
		"A: 无系统读数时退「任一实例近期有输入」",
		P.computeActive(null, 3_000, 20_000) === true && P.computeActive(null, 60_000, 20_000) === false,
	);
	check("A: 系统空闲 ≥ away → 已离开", P.computeAway(300_000, 0, 300_000) === true);
	check("A: 系统空闲 < away → 未离开", P.computeAway(10_000, 0, 300_000) === false);
	check(
		"A: 无系统读数时退「所有实例都久无输入」",
		P.computeAway(null, 400_000, 300_000) === true && P.computeAway(null, 60_000, 300_000) === false,
	);

	// -------------------------------------------------------------------------
	// 场景 B：在场文件
	// -------------------------------------------------------------------------
	console.log("场景 B：在场文件");
	mkdirSync(presenceDir, { recursive: true });
	P.initPresence("test-sid", "my_pi");
	check("B: 自身文件已写", existsSync(join(presenceDir, "test-sid.json")));
	const selfRec = JSON.parse(readFileSync(join(presenceDir, "test-sid.json"), "utf8"));
	check("B: 文件含 pid 与项目名", selfRec.pid === process.pid && selfRec.project === "my_pi");
	check("B: 刚启动即视为近期有输入", P.recentPiInputMs() < 5_000);

	// 死进程的实例不算在场
	writeFileSync(
		join(presenceDir, "dead.json"),
		JSON.stringify({ pid: 999_999, project: "x", lastInputAt: Date.now(), updatedAt: Date.now() }),
	);
	check("B: 死进程实例被忽略（不影响判定）", P.recentPiInputMs() < 5_000);

	// 另一个活着的实例（用当前 pid 冒充）久无输入 → 取最近的输入仍以自身为准
	writeFileSync(
		join(presenceDir, "peer.json"),
		JSON.stringify({ pid: process.pid, project: "y", lastInputAt: Date.now() - 900_000, updatedAt: Date.now() }),
	);
	check("B: 取所有实例里最近的一次输入", P.recentPiInputMs() < 5_000);

	P.disposePresence();
	check("B: 退出后自身文件被清理", !existsSync(join(presenceDir, "test-sid.json")));
	P.initPresence("test-sid", "my_pi"); // 场景 D 还要用

	// -------------------------------------------------------------------------
	// 场景 C：全局去重
	// -------------------------------------------------------------------------
	console.log("场景 C：提示音全局去重");
	rmSync(join(presenceDir, ".sound-claim"), { force: true });
	check("C: 第一个调用拿到名额", P.claimSoundSlot(80) === true);
	check("C: 窗口期内第二个让位", P.claimSoundSlot(80) === false);
	await sleep(120);
	check("C: 超龄回收后可以再拿", P.claimSoundSlot(80) === true);

	// -------------------------------------------------------------------------
	// 场景 D：status-beacon 接线
	// -------------------------------------------------------------------------
	console.log("场景 D：status-beacon 提示音门控");
	const execCalls = [];
	const titles = [];
	const workingMessages = [];
	const hiddenLabelCalls = [];
	const statuses = new Map();
	const ui = {
		setStatus: (k, v) => (v === undefined ? statuses.delete(k) : statuses.set(k, v)),
		setTitle: (t) => titles.push(t),
		setWidget() {},
		setWorkingMessage: (t) => workingMessages.push(t),
		setHiddenThinkingLabel: (t) => hiddenLabelCalls.push(t),
		onTerminalInput: () => () => {},
		notify() {},
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: join(tmp, "proj"),
		ui,
		isIdle: () => false,
		getContextUsage: () => undefined,
		sessionManager: { getSessionId: () => "sb-sid" },
		model: undefined,
		modelRegistry: { getProviderDisplayName: () => "", find: () => undefined, hasConfiguredAuth: () => false },
	};
	const handlers = {};
	const pi = {
		on: (name, fn) => {
			(handlers[name] ??= []).push(fn);
		},
		registerCommand() {},
		exec: async (cmd, args) => {
			execCalls.push({ cmd, args });
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	const SB = await bundle("status-beacon.ts", "beacon-bundle.mjs");
	SB.default(pi);
	const fire = async (name, event) => {
		for (const fn of handlers[name] ?? []) await fn(event ?? {}, ctx);
	};

	const settleNormal = async () => {
		await fire("agent_end", {
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
		});
		await fire("agent_settled");
	};

	// 人不在（系统空闲 10 分钟）→ 应当出声
	process.env.PI_OS_IDLE_MS = String(600_000);
	execCalls.length = 0;
	rmSync(join(presenceDir, ".sound-claim"), { force: true });
	P.initPresence("sb-sid", "proj"); // 自身实例：lastInputAt 刚写过，但系统空闲优先
	await fire("session_start");
	await fire("agent_start");
	await settleNormal();
	check("D: 人不在时收尾出声", execCalls.length === 1, JSON.stringify(execCalls));

	// 人在键盘上（系统空闲 1s）→ 只闪不出声
	process.env.PI_OS_IDLE_MS = "1000";
	execCalls.length = 0;
	rmSync(join(presenceDir, ".sound-claim"), { force: true });
	await fire("agent_start");
	await settleNormal();
	check("D: 人在键盘上时只闪不出声", execCalls.length === 0, JSON.stringify(execCalls));

	// 20s 内刚有输入（系统读数不可用，退跨实例信号）→ 也不出声
	delete process.env.PI_OS_IDLE_MS;
	P.disposeIdleProbe(); // 关掉后台空闲探测（win32 会起常驻 PowerShell），别留孤儿进程
	execCalls.length = 0;
	rmSync(join(presenceDir, ".sound-claim"), { force: true });
	P.initPresence("peer-live", "proj");
	await fire("agent_start");
	await settleNormal();
	check("D: 无系统读数时，跨实例近期输入同样抑制出声", execCalls.length === 0, JSON.stringify(execCalls));

	// ---- 场景 E：执行中动画在 Working 行，折叠思考标签交回 pi 默认 ----
	console.log("场景 E：Working 行动画 / 思考标签不干预");
	{
		await fire("agent_start");
		await fire("tool_execution_start", { toolName: "bash", args: {} });
		const last = workingMessages[workingMessages.length - 1];
		check("E: Working 行保留「在等什么」信息", typeof last === "string" && last.includes("bash"), JSON.stringify(last));
		check("E: Working 行不自带 spinner（行首交给 pi 的指示器）", typeof last === "string" && !/^[⠀-⣿]/.test(last), JSON.stringify(last));
		check("E: 工具执行时 HUD 行 1 显示当前工具", (statuses.get("task-alert-run") ?? "").includes("bash"), JSON.stringify(statuses.get("task-alert-run")));
		check("E: 不再改写折叠思考标签", hiddenLabelCalls.length === 0);
		await fire("tool_execution_end", { toolName: "bash" });
		check("E: 工具收尾后不再冒充思考（思考块之外的间隙）", !(statuses.get("task-alert-run") ?? "").includes("思考"), JSON.stringify(statuses.get("task-alert-run")));

		// 思考块边界：思考只覆盖 thinking_start → thinking_end 这段时间
		await fire("message_update", { assistantMessageEvent: { type: "thinking_start" } });
		check("E: 标题栏同步显「思考中」", String(titles[titles.length - 1]).includes("思考中"), JSON.stringify(titles[titles.length - 1]));
		check("E: 思考块开始 → HUD 显「思考中」", statuses.get("task-alert-run") === "💭 思考中", JSON.stringify(statuses.get("task-alert-run")));
		check("E: 思考块开始 → Working 行显「思考中」", String(workingMessages[workingMessages.length - 1]).startsWith("思考中"), JSON.stringify(workingMessages[workingMessages.length - 1]));
		await fire("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
		check("E: 思考块内多帧 delta 不改变状态", statuses.get("task-alert-run") === "💭 思考中");
		await fire("message_update", { assistantMessageEvent: { type: "thinking_end" } });
		check("E: 思考块结束 → 不再显「思考中」", !(statuses.get("task-alert-run") ?? "").includes("思考"), JSON.stringify(statuses.get("task-alert-run")));
		check("E: 标题栏不再显「思考中」", !String(titles[titles.length - 1]).includes("思考中"), JSON.stringify(titles[titles.length - 1]));
		await fire("message_update", { assistantMessageEvent: { type: "text_start" } });
		check("E: 正文流式 → HUD 显「输出中」", statuses.get("task-alert-run") === "✍️ 输出中", JSON.stringify(statuses.get("task-alert-run")));
		check("E: 标题栏同步显「输出中」", String(titles[titles.length - 1]).includes("输出中"), JSON.stringify(titles[titles.length - 1]));
		await fire("message_update", { assistantMessageEvent: { type: "toolcall_start" } });
		check("E: 工具调用块 → 撤下输出状态", statuses.get("task-alert-run") === undefined, JSON.stringify(statuses.get("task-alert-run")));

		await fire("agent_settled");
		check("E: 收尾撤下执行中状态", !statuses.has("task-alert-run"));
		check("E: 收尾后仍不碰折叠思考标签", hiddenLabelCalls.length === 0);
	}

	await fire("session_shutdown"); // 走扩展清理路径（停探测进程 / 删在场文件）
	P.disposeIdleProbe();
}

rmSync(tmp, { recursive: true, force: true });


delete process.env.PI_PRESENCE_DIR;
delete process.env.PI_OS_IDLE_MS;
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
