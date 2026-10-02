#!/usr/bin/env node
/**
 * dingtalk-bridge 回归测试（复用 mimo-omni 测试基建：esbuild bundle + node_modules junction）
 *
 * 只测纯函数策略层（不真实起 dws 进程）：
 * - 场景 A：buildArgv 自动补 --format json / --yes，已有则不重复
 * - 场景 B：发送缺【AI发送】标签 → 拦截
 * - 场景 C：两阶段——首次 pending 不执行、带正确 confirm → run、错 token → 拦截
 * - 场景 D：已发送签名重复 → 拦截（防重发）
 * - 场景 E：目标是中文姓名 → 拦截（强制 resolve）
 * - 场景 F：formal=true 豁免标签检查
 * - 场景 G：parsePeople 单候选/多候选/零候选/坏 JSON
 * - 场景 H：annotateQuery 查询类附时间锚点、非查询原样
 * - 场景 I：formatSchemaOutput 产品层/工具层/叶子层截断
 * - 场景 J：草稿 token 过期 → 拦截
 * - 场景 K：requireAiTag=false 时无标签放行（仍走两阶段）
 * - 场景 L：签名剔除易变 flag（--format/--yes 不影响「同一条消息」判定）
 *
 * 用法：node src/extensions/test/dingtalk-bridge.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "dingtalk-bridge.ts");
const OUT = join(HERE, ".tmp-dingtalk-bridge-bundle.mjs");

const results = [];
function check(label, ok, extra) {
	results.push({ label, ok });
	console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || extra === undefined ? "" : ` :: ${extra}`}`);
}

await build({
	entryPoints: [EXT],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: OUT,
	external: ["@earendil-works/*", "typebox"],
	logLevel: "silent",
});
const mod = await import(pathToFileURL(OUT).href);
const { decideExec, newExecState, annotateQuery, parsePeople, formatSchemaOutput, buildArgv, pruneLedger, normalizeContent, mediaKind, parseSkillDescription, formatSkillIndex, __test__ } = mod;
const CFG = { requireAiTag: true };
const NOW = Date.parse("2026-10-02T22:00:00+08:00");
const SEND = ["chat", "+dm", "--to", "u001", "--content", "【AI发送】明天下午三点教研会"];

console.log("A、buildArgv 自动附加");
{
	const a = buildArgv(["todo", "task", "list"]);
	check("补 --format json 与 --yes", a.join(" ").includes("--format json") && a.includes("--yes"));
	const b = buildArgv(["todo", "task", "list", "-f", "ndjson"]);
	check("已有 -f 不重复附加", b.filter((x) => x === "--format").length === 0 && b.includes("ndjson"));
	const c = buildArgv(["chat", "+messages-send", "--file", "a.pdf", "--dry-run"]);
	check("--dry-run 时不附加 --yes（dws 要求二选一）", !c.includes("--yes") && !c.includes("-y"));
}

console.log("B、发送缺标签拦截");
{
	const d = decideExec(["chat", "+dm", "--to", "u001", "--content", "明天下午三点教研会"], {}, newExecState(), CFG, NOW);
	check("缺【AI发送】→ block", d.action === "block" && d.reason.includes("【AI发送】"));
}

console.log("C、两阶段确认");
{
	const st = newExecState();
	const d1 = decideExec(SEND, {}, st, CFG, NOW);
	check("首次 → pending（不执行）", d1.action === "pending" && d1.token.length === 10);
	check("回执含命令预览", d1.action === "pending" && d1.preview.includes("+dm"));
	const d2 = decideExec(SEND, { confirm: d1.token }, st, CFG, NOW);
	check("正确 token → run", d2.action === "run");
	const d3 = decideExec(SEND, { confirm: "deadbeef00" }, newExecState(), CFG, NOW);
	check("错 token → block", d3.action === "block");
}

console.log("D、防重发");
{
	const st = newExecState();
	const p = decideExec(SEND, {}, st, CFG, NOW);
	decideExec(SEND, { confirm: p.token }, st, CFG, NOW);
	// 执行层成功后记录签名（此处模拟）
	st.sent.set(__test__.sendSignature(SEND), { at: NOW, snippet: "" });
	const d = decideExec(SEND, {}, st, CFG, NOW);
	check("同目标同内容 → block", d.action === "block" && d.reason.includes("台账防重发"));
	const other = ["chat", "+dm", "--to", "u001", "--content", "【AI发送】改到四点"];
	check("不同内容放行", decideExec(other, {}, st, CFG, NOW).action === "pending");
}

console.log("E、中文姓名目标拦截");
{
	const d = decideExec(["chat", "+dm", "--to", "张艳", "--content", "【AI发送】x"], {}, newExecState(), CFG, NOW);
	check("姓名作目标 → block 并引导 resolve", d.action === "block" && d.reason.includes("dws_resolve_user"));
}

console.log("F、formal 豁免");
{
	const d = decideExec(["chat", "+dm", "--to", "u001", "--content", "正式通知正文"], { formal: true }, newExecState(), CFG, NOW);
	check("formal=true 免标签 → pending", d.action === "pending");
}

console.log("G、parsePeople 解析");
{
	const one = parsePeople(JSON.stringify({ data: { items: [{ userId: "u1", name: "张三", department: "数学组" }] } }));
	check("单候选提取", one.length === 1 && one[0].userId === "u1" && one[0].extra === "数学组");
	const many = parsePeople(JSON.stringify({ results: [{ userId: "u1", name: "张艳" }, { userId: "u2", name: "张艳" }] }));
	check("多候选提取且按 userId 去重", many.length === 2);
	check("零候选/坏 JSON → 空数组", parsePeople("{}").length === 0 && parsePeople("not json").length === 0);
}

console.log("H、查询时间锚点");
{
	const q = annotateQuery(["chat", "+search-msg"], "[]", new Date(NOW));
	check("查询类附当前时间", q.includes("当前系统时间") && q.includes("2026-10-02"));
	check("非查询类原样", annotateQuery(["todo", "task", "list"], "[]", new Date(NOW)) === "[]");
}

console.log("I、schema 输出摘要");
{
	const products = formatSchemaOutput(JSON.stringify({
		level: "products",
		products: [{ id: "todo", agent_summary: "待办任务管理" }, { id: "chat", description: "群聊/消息" }],
	}), 12_000);
	check("产品层一行一个", products.includes("todo｜待办任务管理") && products.includes("chat｜群聊/消息"));
	const tools = formatSchemaOutput(JSON.stringify({
		tools: [{ canonical_path: "todo.add_task", agent_summary: "创建待办", effect: "write", risk: "low" }],
	}), 12_000);
	check("工具层带路径与读写标注", tools.includes("todo.add_task") && tools.includes("[write/low]"));
	const big = formatSchemaOutput(JSON.stringify({ level: "tool", blob: "x".repeat(20_000) }), 12_000);
	check("叶子/未识别层超长截断", big.length < 13_500 && big.includes("截断"));
}

console.log("J、草稿过期");
{
	const st = newExecState();
	const p = decideExec(SEND, {}, st, CFG, NOW);
	const d = decideExec(SEND, { confirm: p.token }, st, CFG, NOW + 11 * 60_000);
	check("超 10 分钟 → block", d.action === "block" && d.reason.includes("过期"));
}

console.log("K、标签检查可配置关闭");
{
	const d = decideExec(["chat", "+dm", "--to", "u001", "--content", "无标签"], {}, newExecState(), { requireAiTag: false }, NOW);
	check("requireAiTag=false → 仍 pending 不拦标签", d.action === "pending");
}

console.log("L、签名剔除易变 flag");
{
	const a = __test__.sendSignature(SEND);
	const b = __test__.sendSignature([...SEND, "--format", "json", "--yes"]);
	const c = __test__.sendSignature(["chat", "+dm", "--to", "u001", "--content", "【AI发送】明天下午三点教研会", "--timeout", "30"]);
	check("--format/--yes/--timeout 不改变签名", a === b && a === c);
}

console.log("M、跨会话台账防重发");
{
	const now = NOW;
	const entries = [
		{ sig: "aaa", at: now - 10 * 60_000, snippet: "10 分钟前" },
		{ sig: "bbb", at: now - 90 * 60_000, snippet: "90 分钟前" },
	];
	const kept = pruneLedger(entries, 60 * 60_000, now);
	check("保留期内条目留下、过期剔除", kept.length === 1 && kept[0].sig === "aaa");
	// 模拟新进程：台账汇入 state.sent 后，同内容发送应被拦（不依赖内存历史）
	const st = newExecState();
	for (const e of kept) st.sent.set(e.sig, { at: e.at, snippet: e.snippet });
	st.sent.set(__test__.sendSignature(SEND), { at: now, snippet: "" });
	const d = decideExec(SEND, {}, st, CFG, now);
	check("新会话同内容 → block", d.action === "block" && d.reason.includes("台账"));
}

console.log("N、字面反斜杠-n 归一");
{
	const BS = String.fromCharCode(92);
	const r = normalizeContent(["chat", "+messages-send", "--markdown", `第一行${BS}n第二行${BS}n第三行`]);
	check("字面 \\n 转为真换行", r.fixed === 2 && r.args[3].includes("\n") && !r.args[3].includes(`${BS}n`));
	check("--markdown=x 内联形式也归一", normalizeContent([`chat`, `+dm`, `--content=a${BS}nb`]).fixed === 1);
	const keep = normalizeContent(["chat", "+dm", "--content", "已经是真\n换行"]);
	check("真换行不动", keep.fixed === 0);
	const esc = normalizeContent(["chat", "+dm", "--content", `写代码里的${BS}${BS}n`]);
	check("转义反斜杠（\\\\n）不动", esc.fixed === 0);
}

console.log("O、文件/媒体消息识别");
{
	check("--file → file", mediaKind(["chat", "+messages-send", "--file", "a.pdf"]) === "file");
	check("--msg-type image → image", mediaKind(["chat", "+messages-send", "--msg-type", "image", "--media-id", "x"]) === "image");
	check("纯文本 → undefined", mediaKind(["chat", "+dm", "--content", "hi"]) === undefined);
	const d = decideExec(["chat", "+messages-send", "--as", "user", "--user", "u1", "--msg-type", "file", "--file", "a.pdf", "--content", "【AI发送】说明"], {}, newExecState(), CFG, NOW);
	check("文件发送的草稿预览注明「不含正文」", d.action === "pending" && d.preview.includes("不含正文"));
}

console.log("P、技能逃生舱（纯函数）");
{
	const md = `---\nname: dingtalk-chat\ndescription: 钉钉群聊与消息。Use when 发消息。\nmetadata:\n  category: product\n---\n\n# 正文\n`;
	check("frontmatter description 提取", parseSkillDescription(md).startsWith("钉钉群聊与消息"));
	check("无 frontmatter 回落首个正文行", parseSkillDescription("# 标题\n这是一行说明\n") === "这是一行说明");
	const idx = formatSkillIndex([{ name: "dingtalk-chat", description: "x".repeat(300) }, { name: "dingtalk-todo", description: "待办" }]);
	check("索引列出技能并截断超长描述", idx.includes("dingtalk-chat") && idx.includes("dingtalk-todo") && idx.includes("…"));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过 ✓");
process.exit(failed.length ? 1 : 0);
