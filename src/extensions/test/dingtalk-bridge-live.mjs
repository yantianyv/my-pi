#!/usr/bin/env node
/**
 * dingtalk-bridge 真实联调脚本（手动执行，不自动跑——会打真实 dws 进程与钉钉网络）
 *
 * 覆盖：L0 技能过滤、schema 三层下钻、人员解析、发送拦截链、只读执行。
 * 安全：发送只走到「草稿待确认」即停，绝不 confirm，不发送任何真实消息。
 *
 * 用法：node src/extensions/test/dingtalk-bridge-live.mjs [姓名]
 *   姓名缺省取「严天宇」；如需验证人员解析，传真实姓名。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const OUT = join(HERE, ".tmp-dingtalk-live-bundle.mjs");
const { build } = createRequire(join(ROOT, "src", "package.json"))("esbuild");

await build({
	entryPoints: [join(ROOT, "src", "extensions", "dingtalk-bridge.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: OUT,
	external: ["@earendil-works/*", "typebox"],
	logLevel: "silent",
	absWorkingDir: join(ROOT, "src"),
});
const mod = await import(pathToFileURL(OUT).href);

const tools = {};
let beforeAgentStart;
mod.default({
	registerTool: (t) => (tools[t.name] = t),
	registerCommand: () => {},
	on: (ev, cb) => {
		if (ev === "before_agent_start") beforeAgentStart = cb;
	},
});
console.log(`注册工具：${Object.keys(tools).join("、")}`);

const call = (name, params) => tools[name].execute("live", params, undefined, undefined, {});
const show = (label, r, max = 800) => {
	const t = r.content.map((c) => c.text).join("\n");
	console.log(`\n===== ${label} =====`);
	console.log(t.length > max ? `${t.slice(0, max)}\n……（截断，全长 ${t.length} 字符）` : t);
};

// L0：技能过滤 + 指引注入
const opts = { skills: [{ name: "dingtalk-chat" }, { name: "dingtalk-todo" }, { name: "markitdown" }], promptGuidelines: [] };
beforeAgentStart({ systemPromptOptions: opts }, {});
console.log(`\n===== L0 技能过滤 =====\n剩余技能：${opts.skills.map((s) => s.name).join("、") || "（空）"}｜指引 ${opts.promptGuidelines.length} 条`);

// L1：schema 三层下钻
await show("schema 产品概览", await call("dws_schema", {}), 1000);
await show("schema 产品工具清单（todo）", await call("dws_schema", { path: "todo" }), 600);
await show("schema 叶子参数（todo.get_user_todos_in_current_org）", await call("dws_schema", { path: "todo.get_user_todos_in_current_org" }), 500);

// L1：真实只读执行
await show("只读执行 todo task list", await call("dws_exec", { args: ["todo", "task", "list"] }), 400);

// L2：人员解析
const name = process.argv[2] ?? "严天宇";
const resolved = await call("dws_resolve_user", { name });
await show(`人员解析 ${name}`, resolved);
const uid = resolved.details?.userId ?? "u001";

// 逃生舱：技能索引 + 按需正文
await show("逃生舱：技能索引", await call("dws_skill", {}), 700);
await show("逃生舱：取 dingtalk-todo 正文", await call("dws_skill", { topic: "todo" }), 400);

// 字面反斜杠-n 归一：dry-run 发送（不真发）看载荷里的换行
const BS = String.fromCharCode(92);
const literalArgs = ["chat", "+messages-send", "--as", "user", "--user", uid, "--markdown", `【AI发送】归一化验证${BS}n第二行${BS}n第三行`, "--dry-run"];
const normDraft = await call("dws_exec", { args: literalArgs });
await show("字面反斜杠-n 自动归一（草稿回执）", normDraft, 500);
if (normDraft.details?.token) await show("confirm 执行（--dry-run，不真发）", await call("dws_exec", { args: literalArgs, confirm: normDraft.details.token }), 700);

// L2：发送拦截链（不真发）
await show("发送缺【AI发送】标签", await call("dws_exec", { args: ["chat", "+dm", "--to", "u001", "--content", "明天下午三点教研会"] }));
await show("发送目标为中文姓名", await call("dws_exec", { args: ["chat", "+dm", "--to", name, "--content", "【AI发送】测试"] }));
const draft = ["chat", "+dm", "--to", "u001", "--content", "【AI发送】联调草稿"];
await show("合规发送 → 草稿待确认", await call("dws_exec", { args: draft }));
await show("错误 confirm token", await call("dws_exec", { args: draft, confirm: "deadbeef00" }));

console.log("\n联调结束：未发送任何真实消息。");
