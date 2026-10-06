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
 * - 场景 X：群发/批量/转发/回复/卡片更新均两阶段、姓名目标不拦（群发、转发目标群除外）、--dry-run 不进两阶段
 * - 场景 Y：群发预检解析表（resolved/skipped）解析与格式化
 * - 场景 Z：群发 --content 视为 Markdown，多行补硬换行
 * - 场景 AA：人员候选富化（meta 取名、部门/职务/工号、家长账号标注、CLI 结构化候选）
 * - 场景 AB/AC/AD/AE：命令分档（读/写/敏感）、元数据解析、人工审核文案（不出 argv/ID）、撤回对象识别
 *
 * 用法：node src/extensions/test/dingtalk-bridge.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const { decideExec, newExecState, annotateQuery, parsePeople, parseOrgInfo, parseCliCandidates, formatPersonLine, failingName, formatSchemaOutput, buildArgv, pruneLedger, normalizeContent, mediaKind, hasMultilineText, dingChannel, isMarkdownBody, isDryRun, parseBroadcastPreflight, formatBroadcastPreflight, targetNames, parseMessageDigest, parseConversationInfo, cliPathOf, parseCmdMeta, presumedRead, tierOf, tierFromTables, contentPreview, targetSummary, buildReview, parseSelf, parseGroups, parseDriveRefs, isFolderMessage, formatDriveRefs, ci, hasLowercaseDingtalkId, formatFieldSpellingNote, parseSkillDescription, formatSkillIndex, parseCmdParams, unknownFlags, __test__ } = mod;
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
	check("回执信息齐全：动作/影响 + 完整参数 + 确认协议 + 有效期（草稿面向执行者，不同于人看的面板）", d1.action === "pending" && d1.preview.includes("动作与对象：") && d1.preview.includes("--content") && d1.preview.includes(`confirm="${d1.token}"`) && d1.preview.includes("分钟有效") && d1.preview.includes("人工审核面板"), d1.preview);
	check("草稿列出未用的可用参数（schema 参数表传入时）", (() => { const d = decideExec(SEND, { tier: "sensitive", why: "会对外发出消息", flags: ["to", "content", "dry-run"] }, st, CFG, NOW); return d.action === "pending" && d.preview.includes("--content"); })(), (() => { const d = decideExec(SEND, { flags: ["to", "content"] }, st, CFG, NOW); return d.preview; })());
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
	check("首次撤回 → 草稿待确认", d1.action === "pending" && d1.preview.includes("撤回"));
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

console.log("X、群发两阶段与只读预演");
{
	const st = newExecState();
	const bc = ["chat", "+broadcast", "--to", "李娜,苗文硕", "--content", "【AI发送】今晚 8 点上线"];
	const d1 = decideExec(bc, {}, st, CFG, NOW);
	check("群发首次 → pending（不被 --yes 绕过）", d1.action === "pending" && d1.preview.includes("李娜,苗文硕"));
	const d2 = decideExec(bc, { confirm: d1.token }, st, CFG, NOW);
	check("确认 token → run", d2.action === "run");
	check("群发目标为中文姓名不拦（预检把关）", decideExec(bc, {}, newExecState(), CFG, NOW).action === "pending");
	check("群发缺【AI发送】标签仍拦", decideExec(["chat", "+broadcast", "--to", "李娜", "--content", "无标签"], {}, newExecState(), CFG, NOW).action === "block");
	check("--dry-run 不进两阶段（发送类）", isDryRun(["chat", "+broadcast", "--to", "李娜", "--dry-run"]) && decideExec(["chat", "+messages-send", "--as", "user", "--user", "u1", "--text", "【AI发送】x", "--dry-run"], {}, newExecState(), CFG, NOW).action === "run");
	check("--dry-run 不进两阶段（撤回类）", decideExec(["chat", "+messages-recall", "--msg-id", "m1", "--dry-run"], {}, newExecState(), CFG, NOW).action === "run");
	check("机器人批量单聊 → pending", decideExec(["chat", "+messages-batch-send-by-bot", "--robot-code", "rc", "--users", "u1", "--title", "周报", "--content", "【AI发送】周报"], {}, newExecState(), CFG, NOW).action === "pending");
	check("引用回复无标签 → block", decideExec(["chat", "+messages-reply", "--group", "cid1", "--content", "收到"], {}, newExecState(), CFG, NOW).action === "block");
	check("引用回复带标签 → pending", decideExec(["chat", "+messages-reply", "--group", "cid1", "--content", "【AI发送】收到"], {}, newExecState(), CFG, NOW).action === "pending");
	check("转发 → pending（无正文，豁免标签）", decideExec(["chat", "+messages-forward", "--msg-id", "m1", "--src-conversation-id", "cidA", "--dest-conversation-id", "cidB"], {}, newExecState(), CFG, NOW).action === "pending");
	check("转发目标群写中文名 → block", decideExec(["chat", "+messages-forward", "--msg-id", "m1", "--dest-conversation-id", "教研室群"], {}, newExecState(), CFG, NOW).action === "block");
	check("卡片更新 → pending（豁免标签）", decideExec(["chat", "+messages-update-card", "--biz-id", "b1", "--content", "卡片正文", "--flow-status", "3"], {}, newExecState(), CFG, NOW).action === "pending");
}

console.log("Y、群发预检解析表");
{
	const raw = JSON.stringify({
		actionCount: 1,
		actions: [{ arguments: { receiverOpenDingTalkId: "Dbl2UHLkdwFi" }, recipient: "苗文硕", tool: "send_personal_message" }],
		dry_run: true,
		executed: false,
		failed: ["李娜（\"李娜\" 匹配到多个用户：李娜(016113645862842894)；请提供更精确的名称或直接传稳定 ID）"],
		sent: ["苗文硕"],
	});
	const p = parseBroadcastPreflight(raw);
	check("已解析收件人带 openDingTalkId", p.resolved.length === 1 && p.resolved[0].recipient === "苗文硕" && p.resolved[0].openId === "Dbl2UHLkdwFi");
	check("未唯一解析者原样透传（含候选 ID）", p.skipped.length === 1 && p.skipped[0].includes("016113645862842894"));
	check("坏输出不抛", parseBroadcastPreflight("nope").resolved.length === 0);
	const tbl = formatBroadcastPreflight(p);
	check("解析表列出收件人与人数", tbl.includes("苗文硕") && tbl.includes("1 人"));
}

console.log("Z、群发多行正文按 markdown 硬换行");
{
	const NL = String.fromCharCode(10);
	const n = normalizeContent(["chat", "+broadcast", "--to", "李娜", "--content", `【AI发送】第一行${NL}第二行`]);
	check("+broadcast 的 --content 视为 Markdown", isMarkdownBody(["chat", "+broadcast", "--content", "x"]) && !isMarkdownBody(["chat", "+send-to-group", "--content", "x"]));
	check("行尾补双空格硬换行", n.hardBreaks === 1);
}

console.log("AA、人员候选富化（重名消歧靠部门/职务/工号）");
{
	// 真实 aisearch 形状：名字在 author/title 与 meta.name，没有部门
	const aisearch = JSON.stringify({
		result: [
			{ author: "李娜", title: "李娜", userId: "016113645862842894", openDingTalkId: "DC6iPsiSXqXyhuQJpSFaiiAys", meta: { name: "李娜", jobNumber: "016113645862842894", position: "" } },
		],
	});
	const p = parsePeople(aisearch);
	check("名字取自 meta.name/author（不再“无名”）", p.length === 1 && p[0].name === "李娜", JSON.stringify(p));
	check("不带出无关 title 当附加信息", !p[0].extra.includes("李娜") && p[0].extra.includes("工号 016113645862842894"), p[0].extra);
	check("带出 openDingTalkId（用于对回预检结果）", p[0]?.openId === "DC6iPsiSXqXyhuQJpSFaiiAys");

	// 真实 contact user get 形状：部门路径 + 职务 + 工号
	const orgRaw = JSON.stringify({
		result: [
			{
				isAdmin: false,
				orgEmployeeModel: {
					depts: [
						{ deptId: 964992494, deptName: "诚毅校区班主任", deptPathName: "班主任-诚毅校区班主任" },
						{ deptId: 36962143, deptName: "办公室", deptPathName: "办公室" },
					],
					jobNumber: "016113645862842894",
					orgTitle: "班主任",
					orgUserId: "016113645862842894",
					orgUserName: "李娜",
				},
			},
			{ isAdmin: false, orgEmployeeModel: { depts: [], jobNumber: null, orgTitle: null, orgUserId: "1786188376900", orgUserName: "胡琰松妈妈" } },
		],
		success: true,
	});
	const orgs = parseOrgInfo(orgRaw);
	check("部门路径优先于单层部门名", orgs.get("016113645862842894")?.depts[0] === "班主任-诚毅校区班主任", JSON.stringify(orgs.get("016113645862842894")?.depts));
	check("职务/工号取到", orgs.get("016113645862842894")?.title === "班主任" && orgs.get("016113645862842894")?.jobNumber === "016113645862842894");
	check("无部门无工号的家长账号也入表", orgs.get("1786188376900")?.depts.length === 0);
	check("坏 JSON 不抛", parseOrgInfo("nope").size === 0);

	const line = formatPersonLine({ userId: "016113645862842894", name: "李娜", extra: "" }, orgs.get("016113645862842894"));
	check("人员行带部门/职务/工号与 userId", line.includes("班主任-诚毅校区班主任") && line.includes("工号") && line.endsWith("016113645862842894"), line);
	const parentLine = formatPersonLine({ userId: "1786188376900", name: "胡琰松妈妈", extra: "" }, orgs.get("1786188376900"));
	check("家长/外部账号被标注", parentLine.includes("无部门/工号") && parentLine.includes("家长", 0), parentLine);
	check("无组织详情时退回搜索附加信息", formatPersonLine({ userId: "u9", name: "张三", extra: "数学组" }).includes("数学组"));

	// 真实 CLI 歧义输出：结构化的 candidates（不必抠中文报错文案）
	const cli = JSON.stringify({ error: { details: { candidates: [{ userId: "016113645862842894", openDingTalkId: "DC6i", name: "李娜" }, { userId: "2131204145842894", openDingTalkId: "D63z", name: "李娜" }], subtype: "ambiguous" }, message: '"李娜" 匹配到多个用户：…' } });
	const cands = parseCliCandidates(cli);
	check("CLI 候选解析（带 openDingTalkId）", cands.length === 2 && cands[1].userId === "2131204145842894" && cands[0].openId === "DC6i");
	check("非候选 JSON 不误取", parseCliCandidates(JSON.stringify({ result: [{ userId: "u1" }] })).length === 0);
	check("从失败条目取输入名", failingName('李娜（"李娜" 匹配到多个用户：…）') === "李娜" && failingName("没有找到与 X") === "没有找到与 X");
	check("群发目标名去重保序", targetNames(["chat", "+broadcast", "--to", "李娜,苗文硕,李娜"]).join("|") === "李娜|苗文硕");
	check("重复 --to 与 --users 都收", targetNames(["x", "+broadcast", "--to", "a", "--to", "b,c", "--users", "u1"]).join("|") === "a|b|c|u1");
}

console.log("AB、命令分档（读 / 写 / 敏感）");
{
	check("cliPathOf 只取第一个 flag 前的命令词", cliPathOf(["chat", "+broadcast", "--to", "李娜"]) === "chat +broadcast", cliPathOf(["chat", "+broadcast", "--to", "李娜"]));
	check("cliPathOf 认 --flag=value", cliPathOf(["todo", "task", "list", "--status=false"]) === "todo task list");
	check("cliPathOf 全 flag 时为空", cliPathOf(["--help"]) === "");

	check("读命令识别：list/get/search/me 类", presumedRead(["todo", "task", "list"]) && presumedRead(["chat", "+chat-messages"]) && presumedRead(["chat", "+search-msg"]) && presumedRead(["chat", "+at-me"]));
	check("写命令不误判为读", !presumedRead(["chat", "+broadcast"]) && !presumedRead(["chat", "+messages-send"]) && !presumedRead(["chat", "+messages-recall"]) && !presumedRead(["chat", "+chat-create"]) && !presumedRead(["chat", "+messages-set-pin"]));

	const compact = '{ "effect": "write", "risk": "medium", "confirmation": "user_required", "availability": "available", }';
	const meta = parseCmdMeta(compact);
	check("元数据解析（容忍紧凑输出的尾逗号）", meta && meta.effect === "write" && meta.confirmation === "user_required", JSON.stringify(meta));
	check("元数据缺失时返回 null（不瞎猜）", parseCmdMeta("{ \"risk\": \"low\" }") === null);

	check("元数据说只读 → read", tierOf(["todo", "task", "list"], { effect: "read", risk: "low", confirmation: "not_required", availability: "available" }).tier === "read");
	check("元数据说破坏性 → sensitive", tierOf(["chat", "+chat-dismiss"], { effect: "destructive", risk: "high", confirmation: "user_required", availability: "available" }).tier === "sensitive");
	check("发送类无元数据也 sensitive", tierOf(["chat", "+dm", "--to", "u1"], null).tier === "sensitive" && tierFromTables(["chat", "+broadcast"]) === "sensitive");
	check("普通写入 → write（只两阶段，不弹窗）", tierOf(["todo", "task", "create"], { effect: "write", risk: "low", confirmation: "not_required", availability: "available" }).tier === "write");
	check("取不到元数据 → 当写入处理", tierOf(["unknown", "thing"], null).tier === "write");
}

// 场景 AG：草稿前 flag 校验（unknownFlags / parseCmdParams）
{
	const compact = [
		'{ \n  "cli_path": "chat +messages-send", "effect": "write", "risk": "medium", "confirmation": "user_required", "availability": "available",',
		'  "parameters": {',
		'    "ai-tag": { "type": "boolean" },',
		'    "as": { "type": "string" },',
		'    "at-open-dingtalk-ids": { "type": "array" },',
		'    "markdown": { "type": "string", "required": false, "description": "正文，内嵌 \\"引号\\" 也没事" },',
		'    "open-dingtalk-id": { "type": "string", "required": false },',
		'    "open-dingtalk-ids": { "type": "array" },',
		'    "user": { "type": "string" },',
		'  },',
		'  "risk2": 1,',
		'}',
	].join("\n");
	const params = parseCmdParams(compact);
	check("参数名提取（限 parameters 块，容忍内嵌引号与尾逗号）", params.includes("markdown") && params.includes("open-dingtalk-id") && !params.includes("risk2"), JSON.stringify(params));
	check("flag 拦截：群发参数用到单发命令", (() => { const bad = unknownFlags(["chat", "+messages-send", "--to", "u1", "--content", "【AI发送】x", "--open-dingtalk-id", "d1"], params); return bad.includes("--to") && bad.includes("--content") && !bad.includes("--open-dingtalk-id"); })(), JSON.stringify(unknownFlags(["--to"], params)));
	check("合法 flag 全放行", unknownFlags(["chat", "+messages-send", "--open-dingtalk-id", "d1", "--markdown", "【AI发送】x", "--ai-tag=false"], params).length === 0, JSON.stringify(unknownFlags(["--open-dingtalk-id", "d1", "--markdown", "x"], params)));
	check("= 形式也认", unknownFlags(["--markdown=x", "--open-dingtalk-id=y"], params).length === 0, JSON.stringify(unknownFlags(["--open-dingtalk-id=y", "--markdown=x"], params)));
	check("全局 flag 豁免（dry-run/timeout/format 等）", unknownFlags(["--dry-run", "--timeout", "90", "--format", "json", "--unknown-x"], params).join() === "--unknown-x", JSON.stringify(unknownFlags(["--dry-run", "--unknown-x"], params)));
	check("参数表为空 → 不拦（fail-open，交给 dws）", unknownFlags(["chat", "+messages-send", "--to", "x"], []).length === 0);
}

console.log("AC、人工审核文案（只给人看的信息）");
{
	const args = ["chat", "+broadcast", "--to", "李娜,苗文硕", "--content", "【AI发送】今晚 8 点线上教研"];
	const review = buildReview(args, { effect: "write", risk: "medium", confirmation: "user_required", availability: "available" }, "会对外发出消息", { recipients: ["李娜（诚毅校区班主任）", "苗文硕"] });
	const text = JSON.stringify(review);
	check("外框标题固定、动作压到 2~4 字", review.title === "agent请求操作钉钉" && review.verb === "群发单聊", review.verb);
	check("对象带前缀且一眼看到收件人", review.object.startsWith("收件人：") && review.object.includes("苗文硕"), review.object);
	check("正文进内容区", review.content.join(" ").includes("今晚 8 点"));
	check("影响常驻底部且是事实", review.impact.join(" ").includes("每人各收到一条单聊") && !review.impact.join(" ").includes("无法撤回"));
	check("不带 argv / flag / ID", !text.includes("--to") && !text.includes("--content") && !text.includes("dws "), text.slice(0, 120));
	check("普通发送可记住、破坏性不可记住", review.canRemember === true && buildReview(["chat", "+chat-dismiss"], { effect: "destructive", risk: "high", confirmation: "user_required", availability: "available" }, "破坏性").canRemember === false);
	check("破坏类：动作与对象做 highlight、不可恢复进底部", (() => {
		const r = buildReview(["chat", "+chat-dismiss"], { effect: "destructive", risk: "high", confirmation: "user_required", availability: "available" }, "破坏性操作（不可逆）");
		return r.verb === "解散群聊" && r.impact.join(" ").includes("不可恢复") && r.content.length === 0;
	})());
	check("撤回也走敏感档并写明不可恢复", buildReview(["chat", "+messages-recall", "--msg-id", "m1"], null, "撤回会改变双方可见内容").impact.join(" ").includes("不可恢复"));

	check("正文预览截行并给全文字数提示", (() => {
		const long = Array.from({ length: 14 }, (_, i) => `第${i}行`).join(String.fromCharCode(10));
		const p = contentPreview(["chat", "+dm", "--to", "u1", "--content", long], 10);
		return p.length === 11 && p[10].includes("共 14 行");
	})());
	check("只有 userId 时不展示裸 ID", (() => {
		const t = targetSummary(["chat", "+dm", "--to", "016113645862842894"]).join(" ");
		return !t.includes("016113645862842894") && t.includes("1 个账号");
	})());
}

console.log("AD、撤回对象识别（弹窗要能看出撤的是哪条）");
{
	const digest = parseMessageDigest(JSON.stringify({ messages: [{ conversationId: "cidX", createTime: "2026-10-03 23:43:11", sender: "严天宇", text: "【AI发送】新版审核面板测试\n\n第二行" }] }));
	check("取到会话/时间/正文预览", digest.length === 1 && digest[0].conversationId === "cidX" && digest[0].preview.startsWith("【AI发送】") && digest[0].createTime === "2026-10-03 23:43:11");
	check("正文折成一行（预览不散成多行）", !digest[0].preview.includes(String.fromCharCode(10)));
	check("长正文截断到 90 字", (() => { const d = parseMessageDigest(JSON.stringify({ messages: [{ text: "啊".repeat(200) }] })); return d[0].preview.length <= 91; })());
	check("无文字消息不报错", parseMessageDigest(JSON.stringify({ messages: [{ conversationId: "c" }] }))[0].preview === "");
	check("坏输入返回空", parseMessageDigest("nope").length === 0);
	const single = parseConversationInfo(JSON.stringify({ result: { conversationInfo: { title: "严天宇", singleChat: true, memberCount: 2 } } }));
	const group = parseConversationInfo(JSON.stringify({ result: { conversationInfo: { title: "教研室", singleChat: false, memberCount: 8 } } }));
	check("单聊认得出对方姓名", single && single.title === "严天宇" && single.singleChat === true);
	check("群聊给群名与人数", group && group.title === "教研室" && group.memberCount === 8 && group.singleChat === false);
	check("坏输入返回 null", parseConversationInfo("nope") === null);
}

console.log("AE、人多时的名单排版");
{
	const { layoutList } = __test__;
	const names = ["李娜（诚毅校区班主任）", "苗文硕", "王明睿妈妈", "胡琰松妈妈", "李梓钰家长妈妈", "张伟", "刘洋", "陈晨", "赵磊", "孙倩", "周洋", "吴敏", "郑昊"];
	const lines3 = layoutList(names, 3, 96);
	check("13 人排成 5 行（3 列）", lines3.length === 5, String(lines3.length));
	check("每行不超过面板宽度", lines3.every((l) => [...l].length <= 96), JSON.stringify(lines3[0]));
	check("名单不丢项（拼起来含每个人名首字）", names.map((n) => [...n].slice(0, 2).join("")).every((h) => lines3.join(" ").includes(h)));
	check("空名单返回空", layoutList([], 3, 80).length === 0);
	check("两人时不硬凑三列", layoutList(["甲", "乙"], 3, 80).length === 1);
	const review = buildReview(["chat", "+broadcast", "--to", "x", "--content", "【AI发送】今晚 8 点线上教研"], { effect: "write", risk: "medium", confirmation: "user_required", availability: "available" }, "会对外发出消息", { recipients: names });
	check("名单交给面板按宽度排版（不在构造期截断）", review.objectItems && review.objectItems.items.length === 13 && review.objectItems.label === "收件人");
	check("窄宽度下只显示能塞下的几个 + 等 N 人", (() => { const t = __test__.fitItems("收件人", review.objectItems.items, 40); return t.includes("等 13 人") && [...t].length <= 40; })(), __test__.fitItems("收件人", review.objectItems.items, 40));
	check("正文仍在内容区", review.content.join(" ").includes("今晚 8 点"));
	const few = buildReview(["chat", "+dm", "--to", "x", "--content", "【AI发送】在吗"], null, "会对外发出消息", { recipients: ["李娜（诚毅校区班主任）", "苗文硕"] });
	check("宽宽度下人少时全部列出（不出现等 N 人）", (() => { const t = __test__.fitItems("收件人", few.objectItems.items, 100); return t.includes("李娜") && t.includes("苗文硕") && !t.includes("等 "); })());
}

// ---- 场景 AA：非 NTFS 卷（exFAT）上 dws 下载的自动重定向 ----
{
	const { isDownloadCommand, isLinkPublishFailure, redirectOutputFlags, relocateLocalPaths } = __test__;

	check("AA: 下载命令被识别", isDownloadCommand(["chat", "+messages-resource-download", "--resource-id", "x"]) === true);
	check("AA: --download-resources 被识别", isDownloadCommand(["chat", "+messages-mget", "--msg-ids", "m", "--download-resources"]) === true);
	check("AA: drive pull / download 被识别", isDownloadCommand(["drive", "pull", "--remote-folder", "n"]) && isDownloadCommand(["drive", "download", "--node", "n"]));
	check("AA: 发送/查询命令不识别（不会触发重试）", !isDownloadCommand(["chat", "+dm", "--to", "x"]) && !isDownloadCommand(["chat", "+messages-list"]));

	const realErr = 'dws 失败（exit 5）：{"message":"发布消息资源失败: link D:\\a\\.x.part-123 D:\\a\\x.pdf: Incorrect function."}';
	check("AA: 真实硬链接失败被识别", isLinkPublishFailure(realErr) === true);
	check("AA: 普通错误不误判", isLinkPublishFailure("dws 失败（exit 3）：permission denied") === false);

	const base = join(HERE, "fake-project");
	const temp = join(HERE, "fake-temp");

	const r1 = redirectOutputFlags(["chat", "+messages-resource-download", "--resource-id", "x", "--output", "收材料1006"], temp, base);
	check("AA: --output 改成临时区相对路径", r1.argv[r1.argv.indexOf("--output") + 1] === ".", JSON.stringify(r1.argv));
	check("AA: 目标目录按工作目录解析", r1.targets[0]?.targetAbs === join(base, "收材料1006"), r1.targets[0]?.targetAbs);

	const absOut = join(HERE, "abs-out");
	const r2 = redirectOutputFlags(["drive", "download", "--node", "n", "--output", absOut], temp, base);
	check("AA: 绝对 --output 原样作为目标", r2.targets[0]?.targetAbs === absOut, r2.targets[0]?.targetAbs);
	check("AA: --output=xxx 形式也重写", redirectOutputFlags(["chat", "+messages-mget", "--output-dir=./dl"], temp, base).argv.includes("--output-dir=."));

	const r3 = redirectOutputFlags(["drive", "pull", "--local-folder", absOut], temp, base);
	check("AA: --local-folder 指向临时区绝对值", r3.argv[r3.argv.indexOf("--local-folder") + 1] === temp);
	check("AA: 无输出 flag 时不给目标（调用方兜底工作目录）", redirectOutputFlags(["chat", "+messages-mget"], temp, base).targets.length === 0);

	const json = JSON.stringify({ resourceDownloads: { downloads: [{ localPath: "a.pdf", resourceId: "r" }] } });
	const fixed = JSON.parse(relocateLocalPaths(json, temp, join(base, "收材料1006"), base));
	check("AA: localPath 改写为用户视角路径", fixed.resourceDownloads.downloads[0].localPath === "收材料1006/a.pdf", fixed.resourceDownloads.downloads[0].localPath);
	check("AA: 非 JSON 输出原样返回", relocateLocalPaths("not json", temp, base, base) === "not json");

	// 搬回：递归复制 + 默认不覆盖
	const { copyTree } = __test__;
	const src = mkdtempSync(join(tmpdir(), "ct-src-"));
	const dst = mkdtempSync(join(tmpdir(), "ct-dst-"));
	mkdirSync(join(src, "sub"));
	writeFileSync(join(src, "a.txt"), "A");
	writeFileSync(join(src, "sub", "b.txt"), "B");
	writeFileSync(join(dst, "a.txt"), "OLD");
	const m1 = copyTree(src, dst, false);
	check("AA: 不覆盖时同名跳过、其余照拷", m1.copied === 1 && m1.skipped.length === 1, JSON.stringify(m1));
	check("AA: 跳过的文件内容未变", readFileSync(join(dst, "a.txt"), "utf8") === "OLD");
	check("AA: 子目录结构与文件保留", existsSync(join(dst, "sub", "b.txt")));
	const m2 = copyTree(src, dst, true);
	check("AA: --overwrite 时全部复制且内容更新", m2.copied === 2 && readFileSync(join(dst, "a.txt"), "utf8") === "A");
}

// ---- 场景 AB：群发逐人个性化（正文占位符 + 每人一份变量表）----
{
	const { extractPlaceholders, stripVarsFlags, parseVarsMap, validateVars, renderVars, personalKey } = __test__;

	check("AB: 提取单个占位符", JSON.stringify(extractPlaceholders("【AI发送】{{称呼}}老师您好")) === '["称呼"]');
	check("AB: 多占位符去重保序", JSON.stringify(extractPlaceholders("{{姓名}}的课表：{{课程}}，{{姓名}}老师")) === '["姓名","课程"]');
	check("AB: 占位符允许内部空格", JSON.stringify(extractPlaceholders("{{ 称呼 }}")) === '["称呼"]');
	check("AB: 普通花括号不误判", extractPlaceholders("JSON 里 {a: 1} 不是占位符").length === 0);
	check("AB: 超长变量名不算占位符", extractPlaceholders("{{" + "x".repeat(30) + "}}").length === 0);

	const rawArgs = ["chat", "+broadcast", "--to", "张三,李四", "--content", "【AI发送】{{称呼}}老师", "--vars", '{"张三":{"称呼":"张老师"}}'];
	const st = stripVarsFlags(rawArgs);
	check("AB: --vars 从 dws argv 剥离", !st.args.includes("--vars") && st.args.length === rawArgs.length - 2, JSON.stringify(st.args));
	check("AB: 剥离后仍是 broadcast 命令", st.args[0] === "chat" && st.args[1] === "+broadcast");
	check("AB: --vars 原值带出、vars-file 为空", st.varsRaw === '{"张三":{"称呼":"张老师"}}' && st.varsFile === undefined);
	check("AB: --vars= 等号形式也识别", stripVarsFlags(["chat", "+broadcast", "--vars={}"]).varsRaw === "{}");
	check("AB: --vars-file 形式识别", stripVarsFlags(["chat", "+broadcast", "--vars-file", "vars.json"]).varsFile === "vars.json");

	const ok = parseVarsMap('{"张三":{"称呼":"张老师"},"李四":"李老师"}', ["称呼"]);
	check("AB: 对象与单占位符字符串简写都支持", !("error" in ok) && ok.map.张三.称呼 === "张老师" && ok.map.李四.称呼 === "李老师");
	const num = parseVarsMap('{"甲":{"n":1,"b":true}}', ["n", "b"]);
	check("AB: 数字/布尔自动转字符串", !("error" in num) && num.map.甲.n === "1" && num.map.甲.b === "true");
	check("AB: 多占位符时字符串简写报错", "error" in parseVarsMap('{"张三":"张老师"}', ["称呼", "课程"]));
	check("AB: 顶层非对象报错", "error" in parseVarsMap("[1,2]", ["x"]));
	check("AB: 变量值非标量报错", "error" in parseVarsMap('{"张三":{"称呼":{"a":1}}}', ["称呼"]));
	check("AB: 非法 JSON 报错", "error" in parseVarsMap("{oops", ["x"]));

	check("AB: 变量表齐全时无问题", validateVars(["张三", "李四"], ["称呼"], { 张三: { 称呼: "张老师" }, 李四: { 称呼: "李老师" } }).length === 0);
	const miss = validateVars(["张三", "王五"], ["称呼", "课程"], { 张三: { 称呼: "x" } });
	check("AB: 缺人与缺变量都报出", miss.length === 2 && miss[0].includes("课程") && miss[1].includes("王五"), JSON.stringify(miss));

	check("AB: 逐人渲染正文", renderVars("{{称呼}}老师：课表已更新", { 称呼: "张" }) === "张老师：课表已更新");
	check("AB: 未给的占位符原样保留", renderVars("{{a}}{{b}}", { a: "1" }) === "1{{b}}");
	check("AB: 渲染不误伤普通花括号", renderVars("保留 {x} 原样", { x: "1" }) === "保留 {x} 原样");

	const k1 = personalKey("abc", "你好");
	check("AB: 幂等键确定且为 UUID 形状", k1 === personalKey("abc", "你好") && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/.test(k1), k1);
	check("AB: 人不同/正文不同则幂等键不同", k1 !== personalKey("abc", "你好！") && k1 !== personalKey("abd", "你好"));
}

const failed = results.filter((r) => !r.ok);

console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过 ✓");
process.exit(failed.length ? 1 : 0);
