#!/usr/bin/env node
/**
 * dingtalk-bridge 语义层（src/extensions/dingtalk-bridge/intents.ts）回归测试
 *
 * 只测纯映射：业务参数 → dws argv。不联网、不起 dws 进程（名字→ID、群名→会话由 index.ts 做完再传进来）。
 * 场景 A：值规范化（时间/优先级/提醒方式/表格单元格）
 * 场景 B：消息域（单聊/多人单聊/群/回复/转发/转 DING/撤回/发送状态/查消息）
 * 场景 C：待办域（列表/新建/改/完成/删除/搜索）
 * 场景 D：日程域（列表/新建/取消/详情/加人/查会议室）
 * 场景 E：审批域（待办/详情/同意/拒绝/转交/撤销/模板/发起）
 * 场景 F：文件域（列目录/搜/信息/上传/下载/建目录/移动/重命名/删除/空间）
 * 场景 G：文档表格域（读/搜/新建/追加/精确替换/表格读写/多维表增删改查）
 *
 * 用法：node src/extensions/test/dingtalk-intents.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, ".tmp-dingtalk-intents.mjs");

const results = [];
function check(label, ok, extra) {
	results.push({ label, ok });
	console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || extra === undefined ? "" : ` :: ${extra}`}`);
}

await build({
	entryPoints: [join(HERE, "..", "dingtalk-bridge", "intents.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: OUT,
	external: ["@earendil-works/*", "typebox"],
	logLevel: "silent",
});
const mod = await import(pathToFileURL(OUT).href);
const {
	isoTime, priorityCode, dingTypeCode, toCells,
	buildMessage, buildTodo, buildCalendar, buildApproval, buildFile, buildDoc,
} = mod;

const argv = (built) => ("error" in built ? `ERR:${built.error}` : built.args.join(" "));
const NOW = new Date("2026-10-06T22:00:00+08:00");

console.log("A、值规范化");
{
	check("A: 完整 ISO 原样保留", isoTime("2026-10-08T15:00:00+08:00") === "2026-10-08T15:00:00+08:00");
	check("A: 日期补零点（东八区）", isoTime("2026-10-08") === "2026-10-08T00:00:00+08:00");
	check("A: end=true 补到当天 23:59:59", isoTime("2026-10-08", { end: true }) === "2026-10-08T23:59:59+08:00");
	check("A: 空格分隔时间补秒与偏移", isoTime("2026-10-08 15:30") === "2026-10-08T15:30:00+08:00");
	check("A: 只有时间 = 今天", isoTime("15:30", { now: NOW }) === "2026-10-06T15:30:00+08:00");
	check("A: 明天 09:30", isoTime("明天 09:30", { now: NOW }) === "2026-10-07T09:30:00+08:00");
	check("A: 看不出时间写法 → 报错", typeof isoTime("下周三", { now: NOW }) !== "string");
	check("A: 优先级中文/英文/数字", priorityCode("紧急") === "40" && priorityCode("normal") === "20" && priorityCode("30") === "30" && typeof priorityCode("特别急") !== "string");
	check("A: 提醒方式中文 → app/sms/call", dingTypeCode("短信") === "sms" && dingTypeCode("app") === "app" && dingTypeCode("电话") === "call");
	check("A: 单元格协议（文本/数字/布尔/null 跳过）", toCells([["a", 1, true, null]]) === '[[{"type":"text","text":"a"},{"type":"number","number":1},{"type":"checkbox","checked":true},{}]]');
}

console.log("B、消息域");
{
	const people = [{ token: "李娜", userId: "u1", openId: "d1", name: "李娜" }];
	const group = { token: "教研室", cid: "cidA", title: "教研室" };
	const msg = { msgId: "m1", conversationId: "cidA", preview: "原消息" };
	check("B: 单人单聊用 +dm（传 userId，不传姓名）", argv(buildMessage({ action: "send", to: ["李娜"], content: "hello" }, { people })) === "chat +dm --to u1 --content hello --ai-tag");
	check("B: 多人单聊自动升级为群发", argv(buildMessage({ action: "send", to: ["李娜", "苗文硕"], content: "hi" }, { people: [...people, { token: "苗文硕", userId: "u2", name: "苗文硕" }] })).startsWith("chat +broadcast --to 李娜,苗文硕"));
	check("B: 发文件走 messages-send（用 openDingTalkId，不塞正文）", argv(buildMessage({ action: "send", to: ["李娜"], file: "a.pdf" }, { people })) === "chat +messages-send --as user --open-dingtalk-id d1 --file a.pdf --ai-tag");
	check("B: 没有 openDingTalkId 时发文件 → 明确报错", typeof buildMessage({ action: "send", to: ["李娜"], file: "a.pdf" }, { people: [{ token: "李娜", userId: "u1" }] }).error === "string");
	check("B: 群消息用 +send-to-group + cid", argv(buildMessage({ action: "sendGroup", group: "教研室", content: "通知" }, { group })) === "chat +send-to-group --group cidA --content 通知 --ai-tag");
	check("B: 群发按姓名(原 token)", argv(buildMessage({ action: "broadcast", to: ["李娜", "苗文硕"], content: "x" }, { people: [...people, { token: "苗文硕", userId: "u2" }] })).includes("--to 李娜,苗文硕"));
	check("B: 回复带 group + message-id（发送类统一带 AI 角标）", argv(buildMessage({ action: "reply", inGroup: "教研室", messageId: "m1", content: "收到" }, { message: msg })) === "chat +messages-reply --group cidA --message-id m1 --content 收到 --ai-tag");
	check("B: 转发用源/目标会话 + msg-id", argv(buildMessage({ action: "forward", destGroup: "x", messageId: "m1" }, { message: msg, destGroup: { token: "x", cid: "cidB" } })) === "chat +messages-forward --src-conversation-id cidA --dest-conversation-id cidB --msg-id m1");
	check("B: 转 DING 用 openDingTalkId + 提醒方式", argv(buildMessage({ action: "ding", to: ["李娜"], messageId: "m1", dingType: "短信" }, { message: msg, people })) === "ding +send-by-message --group cidA --message-id m1 --users d1 --type sms");
	check("B: 撤回只要 msg-id", argv(buildMessage({ action: "recall", messageId: "m1" }, { message: msg })) === "chat +messages-recall --msg-id m1");
	check("B: 发送状态用 open-task-id", argv(buildMessage({ action: "sendStatus", taskId: "t1" }, {})) === "chat +messages-query-send-status --open-task-id t1");
	check("B: 查消息带会话/关键词/时间窗", (() => { const a = argv(buildMessage({ action: "read", inGroup: "教研室", keyword: "教研", days: 3 }, { inGroup: group })); return a.includes("+search-msg") && a.includes("--chat-id cidA") && a.includes("--query 教研") && a.includes("--days 3"); })());
	check("B: 群发逐人个性化把变量表交给管线", (() => {
		const a = argv(buildMessage({ action: "broadcast", to: ["李娜"], content: "【{{称呼}}】开会", vars: { 李娜: { 称呼: "张老师" } } }, { people }));
		return a.includes('--vars {"李娜":{"称呼":"张老师"}}');
	})());
	check("B: 正文有占位符却没给变量表 → 报错", (() => { const e = buildMessage({ action: "broadcast", to: ["李娜"], content: "{{称呼}}你好" }, { people }); return "error" in e && e.error.includes("vars"); })());
	check("B: 缺必填参数时给的是人话错误", (() => { const e = buildMessage({ action: "reply", content: "x" }, {}); return "error" in e && e.error.includes("inGroup"); })());
}

console.log("C、待办域");
{
	const people = [{ token: "李娜", userId: "u1", name: "李娜" }];
	check("C: 新建待办带执行人/截止/优先级", argv(buildTodo({ action: "create", title: "交材料", executors: ["李娜"], due: "2026-10-08", priority: "紧急" }, { people })) === "todo task create --title 交材料 --executors u1 --due 2026-10-08T23:59:59+08:00 --priority 40");
	check("C: 不指定执行人时派给本人 userId（不是字面 me）", argv(buildTodo({ action: "create", title: "写周报" }, { ids: { selfUserId: "u9" } })).includes("--executors u9"));
	check("C: 取不到本人 userId 时不硬发", typeof buildTodo({ action: "create", title: "写周报" }, {}).error === "string");
	check("C: 列表默认只列未完成", argv(buildTodo({ action: "list" }, {})) === "todo task list --size 50 --status false");
	check("C: 列表可含已完成", argv(buildTodo({ action: "list", includeDone: true }, {})).includes("--status true"));
	check("C: 完成/重开走 task done", argv(buildTodo({ action: "complete" }, { ids: { taskId: "t1" } })) === "todo task done --task-id t1 --status true");
	check("C: 删除不可逆（带提示）", buildTodo({ action: "delete" }, { ids: { taskId: "t1" } }).note.includes("不可恢复"));
	check("C: 改期待办走 task update", argv(buildTodo({ action: "update", due: "明天 09:30" }, { ids: { taskId: "t1" } })).startsWith("todo task update --task-id t1 --due "));
	check("C: 改待办什么字段都不给 → 报错", typeof buildTodo({ action: "update" }, { ids: { taskId: "t1" } }).error === "string");
	check("C: 按关键词搜待办用 +search", argv(buildTodo({ action: "search", keyword: "教研" }, {})) === "todo +search --query 教研");
}

console.log("D、日程域");
{
	const people = [{ token: "李娜", userId: "u1" }, { token: "苗文硕", userId: "u2" }];
	const ev = argv(buildCalendar({ action: "create", title: "教研会", start: "2026-10-08 15:00", end: "2026-10-08 16:00", attendees: ["李娜", "苗文硕"], location: "三楼", rooms: [] }, { people, ids: { roomIds: "r1" } }));
	check("D: 建日程带参会人/地点/会议室", ev.includes("calendar event create --title 教研会") && ev.includes("--attendees u1,u2") && ev.includes("--location 三楼") && ev.includes("--rooms r1"));
	check("D: 不传参会人时不带 --attendees", !argv(buildCalendar({ action: "create", title: "自己看", start: "明天 09:00", end: "明天 10:00" }, {})).includes("--attendees"));
	check("D: 缺 start/end 报错", (() => { const e = buildCalendar({ action: "create", title: "x" }, {}); return "error" in e; })());
	check("D: 查日程默认今天一整天", (() => { const a = argv(buildCalendar({ action: "list" }, { ids: { now: NOW.toISOString() } })); return a.includes("--start 2026-10-06T00:00:00+08:00") && a.includes("--end 2026-10-06T23:59:59+08:00"); })());
	check("D: 取消日程要 eventId 且提示同步取消", (() => { const b = buildCalendar({ action: "cancel" }, { ids: { eventId: "e1" } }); return argv(b) === "calendar event delete --id e1" && b.note.includes("同步取消"); })());
	check("D: 加参会人走 attendee add", argv(buildCalendar({ action: "invite", attendees: ["李娜"] }, { people: [{ token: "李娜", userId: "u1" }], ids: { eventId: "e1" } })) === "calendar attendee add --event e1 --attendees u1");
	check("D: 查空闲会议室带时段与名字", (() => { const a = argv(buildCalendar({ action: "rooms", start: "2026-10-08 15:00", end: "2026-10-08 16:00", title: "会议室" }, {})); return a.includes("calendar room search") && a.includes("--room-name 会议室"); })());
}

console.log("E、审批域");
{
	const people = [{ token: "李娜", userId: "u1" }];
	check("E: 同意审批带 instance + 插件查到的 task", argv(buildApproval({ action: "approve", instanceId: "i1" }, { ids: { instanceId: "i1", taskId: "t1" } })) === "oa approval approve --instance-id i1 --task-id t1");
	check("E: 没查到待办任务时不硬发", typeof buildApproval({ action: "approve", instanceId: "i1" }, { ids: { instanceId: "i1" } }).error === "string");
	check("E: 拒绝可带意见", argv(buildApproval({ action: "reject", instanceId: "i1", remark: "材料不全" }, { ids: { instanceId: "i1", taskId: "t1" } })).includes("--remark 材料不全"));
	check("E: 转交给姓名解析出的 userId", argv(buildApproval({ action: "transfer", instanceId: "i1" }, { ids: { taskId: "t1" }, people })) === "oa approval redirect-task --task-id t1 --to-actioner-id u1");
	check("E: 撤销用 instance-id", argv(buildApproval({ action: "revoke", instanceId: "i1" }, {})) === "oa approval revoke --instance-id i1");
	check("E: 查模板（有关键词走搜索）", argv(buildApproval({ action: "forms", keyword: "报销" }, {})) === "oa +search-forms --query 报销" && argv(buildApproval({ action: "forms" }, {})) === "oa +list-forms");
	check("E: 给了模板 code 就返回字段清单", argv(buildApproval({ action: "forms", processCode: "P1" }, {})) === "oa approval form-schema --process-code P1");
	check("E: 发起审批要模板 + 表单值", argv(buildApproval({ action: "create", processCode: "P1", formValues: { 金额: "100" } }, {})) === 'oa approval create-instance --process-code P1 --form-values {"金额":"100"}');
	check("E: 发起审批缺模板/表单值 → 报错", typeof buildApproval({ action: "create", formValues: { a: "b" } }, {}).error === "string" && typeof buildApproval({ action: "create", processCode: "P1" }, {}).error === "string");
}

console.log("F、文件域");
{
	check("F: 列目录默认我的文件", argv(buildFile({ action: "list" }, {})) === "drive +list --limit 30");
	check("F: 列指定文件夹", argv(buildFile({ action: "list", folder: "材料" }, { ids: { folder: "f1" } })).includes("--folder f1"));
	check("F: 上传要本地相对路径", argv(buildFile({ action: "upload", file: "a.pdf" }, { ids: { folder: "f1" } })) === "drive +upload --file a.pdf --folder f1");
	check("F: 下载要 out", (() => { const e = buildFile({ action: "download", node: "a.pdf" }, { ids: { node: "n1" } }); return "error" in e && e.error.includes("out"); })());
	check("F: 重命名/删除/移动用稳定 ID", argv(buildFile({ action: "rename", node: "a.pdf", name: "b.pdf" }, { ids: { node: "n1" } })) === "drive +rename --node n1 --name b.pdf"
		&& argv(buildFile({ action: "delete", node: "a.pdf" }, { ids: { node: "n1" } })) === "drive +delete --node n1"
		&& argv(buildFile({ action: "move", node: "a.pdf" }, { ids: { node: "n1", dest: "f2" } })) === "drive +move --node n1 --folder f2");
	check("F: 目标文件夹没解析出来时不猜", typeof buildFile({ action: "move", node: "a.pdf" }, { ids: { node: "n1" } }).error === "string");
	check("F: 搜文件/建目录", argv(buildFile({ action: "search", query: "周报" }, {})).includes("drive +search --query 周报") && argv(buildFile({ action: "mkdir", name: "新材料" }, {})).includes("drive +create-folder --name 新材料"));
}

console.log("G、文档表格域");
{
	check("G: 读文档用 +fetch", argv(buildDoc({ action: "read" }, { ids: { doc: "n1" } })) === "doc +fetch --node n1");
	check("G: 按标题搜文档", argv(buildDoc({ action: "search", query: "教研计划" }, {})).includes("doc +search --query 教研计划"));
	check("G: 新建文档", argv(buildDoc({ action: "create", title: "周报", content: "# 本周" }, {})) === "doc +create --name 周报 --content # 本周");
	check("G: 追加正文", argv(buildDoc({ action: "append", content: "补充" }, { ids: { doc: "n1" } })) === "doc +update --node n1 --command append --content 补充");
	check("G: 整篇覆盖", argv(buildDoc({ action: "replace", content: "重写" }, { ids: { doc: "n1" } })).includes("--command overwrite"));
	check("G: 给了 old 就走精确替换", argv(buildDoc({ action: "replace", old: "旧文", content: "新文" }, { ids: { doc: "n1" } })) === "doc +update --node n1 --command str_replace --old 旧文 --new 新文");
	check("G: 读表格区域", (() => { const a = argv(buildDoc({ action: "sheetRead", sheetId: "s1", range: "A1:C3" }, { ids: { doc: "n1" } })); return a === "sheet csv-get --node n1 --sheet-id s1 --range A1:C3"; })());
	check("G: 写表格区域用 cell object 协议", (() => { const a = argv(buildDoc({ action: "sheetWrite", sheetId: "s1", range: "A1:B1", values: [["甲", 2]] }, { ids: { doc: "n1" } })); return a.includes('--values [[{"type":"text","text":"甲"},{"type":"number","number":2}]]'); })());
	check("G: 追加行不带区域", argv(buildDoc({ action: "sheetAppend", sheetId: "s1", values: [["甲"]] }, { ids: { doc: "n1" } })).includes("sheet append --node n1 --sheet-id s1"));
	check("G: 多维表查询带 base/table", argv(buildDoc({ action: "tableQuery" }, { ids: { baseId: "b1", tableId: "t1" } })).includes("aitable +record-query --base-id b1 --table-id t1"));
	check("G: 多维表增/改/删", argv(buildDoc({ action: "tableAdd", records: [{ cells: { 姓名: "李娜" } }] }, { ids: { baseId: "b1", tableId: "t1" } })).includes('aitable record create --base-id b1 --table-id t1 --records [{"cells":{"姓名":"李娜"}}]')
		&& argv(buildDoc({ action: "tableUpdate", records: [{ recordId: "r1", cells: { 状态: "已完成" } }] }, { ids: { baseId: "b1", tableId: "t1" } })).includes("aitable +record-update")
		&& argv(buildDoc({ action: "tableDelete", recordIds: ["r1"] }, { ids: { baseId: "b1", tableId: "t1" } })).includes("aitable +record-delete --base-id b1 --table-id t1 --record-ids r1"));
	check("G: 缺 doc/base 时不猜", typeof buildDoc({ action: "read" }, {}).error === "string" && typeof buildDoc({ action: "tableQuery" }, {}).error === "string");
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过 ✓");
process.exit(failed.length ? 1 : 0);
