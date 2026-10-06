#!/usr/bin/env node
/**
 * dingtalk-bridge 联调（真实 dws 进程 + 钉钉网络；发送/写入只走到「执行计划」即停，绝不 confirm）
 *
 * 覆盖：L0 技能过滤、语义层六域（消息/待办/日程/审批/文件/文档表格）、门禁行为
 * （草稿两阶段、错 confirm、同内容防重发、无界面敏感档 fail-closed、群发逐人个性化）、
 * 逃生舱 dws_skill（索引 + 正文）。
 *
 * 用法：node src/extensions/test/dingtalk-bridge-live.mjs [姓名]
 * 默认姓名 = 严天宇（本机组织内的人）。需要本机已安装 dws 且已登录。
 */
import { build } from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const OUT = join(HERE, ".tmp-dingtalk-live.mjs");

await build({
	entryPoints: [join(ROOT, "src", "extensions", "dingtalk-bridge", "index.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: OUT,
	external: ["@earendil-works/*", "typebox"],
	logLevel: "silent",
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
const show = (label, r, max = 500) => {
	const t = r.content.map((c) => c.text).join("\n");
	console.log(`\n===== ${label} =====`);
	console.log(t.length > max ? `${t.slice(0, max)}\n……（截断，全长 ${t.length} 字符）` : t);
	return t;
};

// L0：技能过滤 + 指引注入
const opts = { skills: [{ name: "dingtalk-chat" }, { name: "dingtalk-todo" }, { name: "markitdown" }], promptGuidelines: [] };
beforeAgentStart({ systemPromptOptions: opts }, {});
console.log(`\n===== L0 技能过滤 =====\n剩余技能：${opts.skills.map((s) => s.name).join("、") || "（空）"}｜指引 ${opts.promptGuidelines.length} 条`);

const name = process.argv[2] ?? "严天宇";

// 语义层：消息（只到草稿，绝不 confirm 发送——正文故意不写【AI发送】，角标由插件带）
const stamp = new Date().toISOString().slice(11, 19);
const draftArgs = { action: "send", to: [name], content: `语义层联调草稿 ${stamp}` };
const d1 = await call("dingtalk_msg", draftArgs);
show("消息：发单聊 → 执行计划（正文无需 AI 标记）", d1);
show("消息：错误 confirm → 拒绝", await call("dingtalk_msg", { ...draftArgs, confirm: "deadbeef00" }), 200);
show("消息：不带 confirm 重调 → 仍是同一份草稿（未执行）", await call("dingtalk_msg", draftArgs), 160);
// 敏感档 + 无界面会话必须 fail-closed：用「取消日程」（destructive 永不可记住）且给不存在的 ID，即使门禁失效也不会伤到真实数据
const cancelArgs = { action: "cancel", eventId: "联调不存在的日程" };
const c1 = await call("dingtalk_calendar", cancelArgs);
show("日程：取消 → 执行计划", c1, 200);
if (c1.details?.token) show("日程：带正确 confirm → 无界面会话必须拒绝执行", await call("dingtalk_calendar", { ...cancelArgs, confirm: c1.details.token }), 200);
show("消息：查消息（sender=me，不必知道命令名）", await call("dingtalk_msg", { action: "read", sender: "me", days: 7, limit: 2 }), 260);
show("消息：同名候选交 AI 挑（不弹人工确认）", await call("dingtalk_msg", { action: "send", to: ["李娜"], content: "x" }), 400);

// 语义层：待办 / 日程 / 审批 / 文件 / 文档表格
show("待办：列表", await call("dingtalk_todo", { action: "list" }), 260);
show("待办：建（姓名 + 明天 09:30 + 较高）", await call("dingtalk_todo", { action: "create", title: "联调草稿", executors: [name], due: "明天 09:30", priority: "较高" }), 420);
show("日程：查今天", await call("dingtalk_calendar", { action: "list" }), 260);
show("日程：建（参会人姓名）", await call("dingtalk_calendar", { action: "create", title: "联调日程", start: "明天 14:00", end: "明天 15:00", attendees: [name] }), 420);
show("审批：待我审批", await call("dingtalk_approval", { action: "listPending", days: 7 }), 260);
show("审批：查模板", await call("dingtalk_approval", { action: "forms", keyword: "报销" }), 220);
show("文件：列我的文件", await call("dingtalk_file", { action: "list" }), 220);
show("文件：落地「[文件夹] xxx」这类无引用分享", await call("dingtalk_file", { action: "fetch", link: "[文件夹] 联调" }), 220);
show("文档：按标题搜", await call("dingtalk_doc", { action: "search", query: "教研" }), 260);

// 群发逐人个性化（正文占位符 + 每人一份变量表）：只到草稿
show("消息：群发逐人个性化草稿", await call("dingtalk_msg", { action: "broadcast", to: [name], content: "【{{称呼}}】联调个性化", vars: { [name]: { 称呼: "草稿" } } }), 500);

// 逃生舱：只有知识，没有执行通道
show("逃生舱：技能索引", await call("dws_skill", {}), 300);
show("逃生舱：取 dingtalk-todo 正文", await call("dws_skill", { topic: "todo" }), 200);

console.log("\n联调结束：未发送任何真实消息、未创建任何真实待办/日程。");
