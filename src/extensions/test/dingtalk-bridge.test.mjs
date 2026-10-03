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
const { decideExec, newExecState, annotateQuery, parsePeople, formatSchemaOutput, buildArgv, pruneLedger, normalizeContent, mediaKind, hasMultilineText, dingChannel, parseSelf, parseGroups, parseDriveRefs, isFolderMessage, formatDriveRefs, ci, hasLowercaseDingtalkId, formatFieldSpellingNote, parseSkillDescription, formatSkillIndex, __test__ } = mod;
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

console.log("Q、markdown 硬换行（钉钉单换行会拼成一行）");
{
	const BS = String.fromCharCode(92), NL = String.fromCharCode(10);
	const md = (c) => ["chat", "+messages-send", "--as", "user", "--user", "u1", "--markdown", c];
	const r = normalizeContent(md("一" + BS + "n二" + BS + "n三"));
	check("单换行补行尾双空格", r.hardBreaks === 2 && r.args[7] === "一  " + NL + "二  " + NL + "三", JSON.stringify(r.args[7]));
	check("字面反斜杠-n 也先归一", r.fixed === 2);
	check("空行分段不动（不叠加硬换行）", normalizeContent(md("一" + BS + "n" + BS + "n二")).hardBreaks === 0);
	check("已有行尾双空格不重复补", normalizeContent(md("一  " + BS + "n二")).hardBreaks === 0);
	check("+dm 的 --content 同样按 markdown 处理", normalizeContent(["chat", "+dm", "--to", "u1", "--content", "一" + BS + "n二"]).hardBreaks === 1);
	const txt = normalizeContent(["chat", "+messages-send", "--as", "user", "--user", "u1", "--text", "一" + BS + "n二"]);
	check("--text 不做硬换行（但会提示）", txt.hardBreaks === 0 && hasMultilineText(txt.args));
	check("--text 单行不提示", !hasMultilineText(["chat", "+messages-send", "--text", "一行"]));
}

console.log("R、发送入口覆盖与群名拦截");
{
	const st = newExecState();
	const g1 = decideExec(["chat","+send-to-group","--group","教研组长群","--markdown","【AI发送】通知"], {}, st, CFG, NOW);
	check("+send-to-group 纳入两阶段（群名先拦）", g1.action === "block" && g1.reason.includes("+chat-search"));
	const g2 = decideExec(["chat","+send-to-group","--group","cid123","--markdown","通知没标签"], {}, st, CFG, NOW);
	check("群发同样受【AI发送】标签约束", g2.action === "block" && g2.reason.includes("【AI发送】"));
	const g3 = decideExec(["chat","+send-to-group","--group","cid123","--markdown","【AI发送】通知"], {}, st, CFG, NOW);
	check("cid + 标签 → 草稿待确认", g3.action === "pending");
	const b1 = decideExec(["chat","+messages-send-by-bot","--robot-code","rc","--groups","cidA","--text","没标签"], {}, st, CFG, NOW);
	check("机器人发群受标签约束", b1.action === "block");
	const d1 = decideExec(["ding","+send-personal","--to","u1","--content","没标签"], {}, st, CFG, NOW);
	check("ding +send-personal 纳入拦截", d1.action === "block");
	const w1 = decideExec(["chat","+messages-send-card","--as","user","--group","cidX","--markdown","【AI发送】卡片"], {}, st, CFG, NOW);
	check("卡片消息纳入拦截", w1.action === "pending");
}

console.log("S、DING 提醒方式警示");
{
	const st = newExecState();
	check("默认 app", dingChannel(["ding","+send-personal","--to","u1"]) === "app");
	check("识别短信", dingChannel(["ding","+send-personal","--type","sms"]) === "sms");
	check("识别电话（内联写法）", dingChannel(["ding","message","send-personal","--type=call"]) === "call");
	check("非 DING 命令不误判", dingChannel(["chat","+dm","--type","sms"]) === undefined);
	const d = decideExec(["ding","+send-personal","--to","u1","--type","sms","--content","【AI发送】催办"], {}, st, CFG, NOW);
	check("草稿预览含费用警示", d.action === "pending" && d.preview.includes("实际费用"));
}

console.log("T、撤回两阶段与防重复");
{
	const st = newExecState();
	const rec = ["chat", "+messages-recall", "--msg-id", "msgABC"];
	const d1 = decideExec(rec, {}, st, CFG, NOW);
	check("首次撤回 → 草稿待确认", d1.action === "pending" && d1.preview.includes("msgABC"));
	check("预览含不可恢复提示", d1.action === "pending" && d1.preview.includes("不可恢复"));
	const d2 = decideExec(rec, { confirm: d1.token }, st, CFG, NOW);
	check("正确 token → run", d2.action === "run");
	st.sent.set("recall:msgABC", { at: NOW, snippet: "" });
	check("重复撤回 → block", decideExec(rec, {}, st, CFG, NOW).action === "block");
	check("撤回不受【AI发送】标签约束", decideExec(["ding","+recall-personal","--msg-id","m2"], {}, newExecState(), CFG, NOW).action === "pending");
}

console.log("U、群与本人解析");
{
	const g = parseGroups(JSON.stringify({ chats: [{ name: "教研室", openConversationId: "cidA", memberCount: 7 }, { title: "教研组", openConversationId: "cidB" }] }));
	check("群候选提取", g.length === 2 && g[0].cid === "cidA" && g[0].extra.includes("7"));
	const me = parseSelf(JSON.stringify({ ok: true, data: { name: "严天宇", userId: "u1", dept: "教研室" } }));
	check("本人身份提取", me && me.name === "严天宇" && me.userId === "u1");
	check("坏输入不抛", parseSelf("nope") === null && parseGroups("nope").length === 0);
}

console.log("V、钉盘/云盘分享解析");
{
	const NL = String.fromCharCode(10);
	const real = "王应明材料.zip" + NL + "4.1MB" + NL + "[dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=26810061928&fileId=238322429838&type=file](dingtalk://x)";
	const r1 = parseDriveRefs(real);
	check("完整链接解析出 spaceId+fileId", r1.length === 1 && r1[0].spaceId === "26810061928" && r1[0].fileId === "238322429838" && r1[0].type === "file");
	const r2 = parseDriveRefs(JSON.stringify({ resourceId: "238322429838&type=file" }));
	check("裸 dentryId 能识别但无 spaceId", r2.length === 1 && r2[0].spaceId === "" && r2[0].type === "file");
	const r3 = parseDriveRefs(real + NL + real);
	check("重复链接去重", r3.length === 1);
	const r4 = parseDriveRefs("[dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=26810061928&fileId=238322429838&type=folder](x)");
	check("文件夹链接识别为 folder", r4[0].type === "folder");
	check("无链接不误报", parseDriveRefs("普通消息没有分享").length === 0);
	const f = "【AI发送】马老师好，您发的材料是「文件夹」形式" + NL + JSON.stringify({text:"[文件夹] 马晓玉"});
	check("[文件夹] 消息识别", isFolderMessage(f));
	check("普通消息不误判为文件夹消息", !isFolderMessage("文件夹里的文件我看了"));
	const tips = formatDriveRefs(r1);
	check("下载指引含 spaceId 与命令名", tips.includes("drive download") && tips.includes("26810061928"));
	check("裸 id 指引提示换 drive 或让对方重发", formatDriveRefs(r2).includes("重发"));
	check("文件夹指引用 pull", formatDriveRefs(r4).includes("pull"));
}

console.log("W、字段拼写不一致（群成员小写 t / 消息大写 T）");
{
	const memberApi = JSON.stringify({ users: [{ name: "马晓玉", openDingtalkId: "DHZxOiPQtiP3gz" }], bots: [{ name: "小钉", openDingtalkId: "X1" }] });
	check("小写变体被识别", hasLowercaseDingtalkId(memberApi));
	check("大写变体不误报", !hasLowercaseDingtalkId(JSON.stringify({ senderId: "x", openDingTalkId: "y" })));
	check("自解释提示只在小写接口出现", formatFieldSpellingNote(memberApi).includes("两种拼写都要认") && formatFieldSpellingNote(String.fromCharCode(123)+String.fromCharCode(34)+"openDingTalkId"+String.fromCharCode(34)+":1"+String.fromCharCode(125)) === "");
	const o = { openDingtalkId: "lower", openDingTalkId_T: 1 };
	check("ci 大小写不敏感取值", ci(o, "openDingTalkId") === "lower");
	check("ci 精确优先", ci({ name: "a", Name: "b" }, "name") === "a");
	check("ci 缺失返回 undefined", ci({}, "nope") === undefined);
	const people = parsePeople(JSON.stringify({ data: { items: [{ userId: "u1", name: "张三", Department: "数学组" }] } }));
	check("解析对字段大小写容错", people.length === 1 && people[0].extra === "数学组");
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过 ✓");
process.exit(failed.length ? 1 : 0);
