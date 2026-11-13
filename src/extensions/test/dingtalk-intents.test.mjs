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
	idKindOf, isStableId,
	isoTime, priorityCode, dingTypeCode, toCells,
	buildMessage, recipientFlag, buildTodo, buildCalendar, buildApproval, buildFile, buildDoc,
	hasDetailColumns, filledTableLabels, parseFormSchema, composeFormValues, describeFormFields,
	attachmentValue, readForecast, asAttachmentRef, APPROVAL_SPACE_ID, approvalCardLink,
	ApprovalParams, MessageParams, TodoParams, CalendarParams, FileParams, DocParams,
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
	const people = [{ token: "王示例", userId: "0135091542301250234", openId: "d1", name: "王示例" }];
	const group = { token: "教研室", cid: "cidA", title: "教研室" };
	const msg = { msgId: "m1", conversationId: "cidA", preview: "原消息" };
	check("B: 单人单聊用 messages-send（userId 走 --to，不传姓名）", argv(buildMessage({ action: "send", to: ["王示例"], content: "hello" }, { people })) === "chat +messages-send --as user --user 0135091542301250234 --markdown hello --ai-tag");
	// 收件人按 ID 形态挑参数：+dm 的 --to 只认 userId，openDingTalkId 会被上游拒
	const oid = "DfiPsqEEep68BKVsuiizYyTVkiS3jiiutHEiPM";
	check("B: 收件人是 openDingTalkId → 走 --open-dingtalk-id", argv(buildMessage({ action: "send", to: [oid], content: "hi" }, { people: [{ token: oid, userId: oid }] })) === `chat +messages-send --as user --open-dingtalk-id ${oid} --markdown hi --ai-tag`);
	check("B: userId 不会被误判成 openId", recipientFlag({ token: "0135091542301250234", userId: "0135091542301250234" })?.flag === "--user");
	check("B: 多人单聊自动升级为群发", argv(buildMessage({ action: "send", to: ["王示例", "张示例"], content: "hi" }, { people: [...people, { token: "张示例", userId: "422726045429076267", name: "张示例" }] })).startsWith("chat +broadcast --to 王示例,张示例"));
	check("B: 发文件走 messages-send（用 userId，不塞正文）", argv(buildMessage({ action: "send", to: ["王示例"], file: "a.pdf" }, { people })) === "chat +messages-send --as user --user 0135091542301250234 --file a.pdf --ai-tag");
	check("B: 按 ID 解析出来的收件人（无 openDingTalkId）也能发文件", argv(buildMessage({ action: "send", to: ["0135091542301250234"], file: "a.pdf" }, { people: [{ token: "0135091542301250234", userId: "0135091542301250234" }] })) === "chat +messages-send --as user --user 0135091542301250234 --file a.pdf --ai-tag");
	check("B: 连 userId 都没有时发文件 → 明确报错", typeof buildMessage({ action: "send", to: ["王示例"], file: "a.pdf" }, { people: [{ token: "王示例", userId: "" }] }).error === "string");
	check("B: 群消息用 +send-to-group + cid", argv(buildMessage({ action: "sendGroup", group: "教研室", content: "通知" }, { group })) === "chat +send-to-group --group cidA --content 通知 --ai-tag");
	check("B: 群发按姓名(原 token)", argv(buildMessage({ action: "broadcast", to: ["王示例", "张示例"], content: "x" }, { people: [...people, { token: "张示例", userId: "422726045429076267" }] })).includes("--to 王示例,张示例"));
	check("B: 回复带 group + message-id（发送类统一带 AI 角标）", argv(buildMessage({ action: "reply", inGroup: "教研室", messageId: "m1", content: "收到" }, { message: msg })) === "chat +messages-reply --group cidA --message-id m1 --content 收到 --ai-tag");
	check("B: 转发用源/目标会话 + msg-id", argv(buildMessage({ action: "forward", destGroup: "x", messageId: "m1" }, { message: msg, destGroup: { token: "x", cid: "cidB" } })) === "chat +messages-forward --src-conversation-id cidA --dest-conversation-id cidB --msg-id m1");
	// 消息转 DING：提醒指向已存在的消息（收件人能看到原文）
	check("B: 消息转 DING 引用原消息 + openDingTalkId + 提醒方式", argv(buildMessage({ action: "dingByMessage", to: ["王示例"], messageId: "m1", dingType: "短信" }, { message: msg, people })) === "ding message send-by-message --group cidA --message-id m1 --users d1 --type sms");
	// 发送 DING：独立新提醒，不引用任何消息
	check("B: 发送 DING 用正文，不带会话/消息 ID", argv(buildMessage({ action: "ding", to: ["王示例"], content: "请尽快确认", dingType: "app" }, { people })) === "ding message send-personal --users d1 --content 请尽快确认 --type app");
	check("B: 发送 DING 缺正文 → 报错", !!buildMessage({ action: "ding", to: ["王示例"] }, { people }).error);
	check("B: 消息转 DING 缺原消息 → 报错", !!buildMessage({ action: "dingByMessage", to: ["王示例"] }, { people }).error);
	check("B: 拿不到 openDingTalkId → 说清缺什么", buildMessage({ action: "ding", to: ["王示例"], content: "x" }, { people: [{ token: "王示例", userId: "0135091542301250234" }] }).error.includes("openDingTalkId"));
	check("B: 撤回只要 msg-id", argv(buildMessage({ action: "recall", messageId: "m1" }, { message: msg })) === "chat +messages-recall --msg-id m1");
	check("B: 发送状态用 open-task-id", argv(buildMessage({ action: "sendStatus", taskId: "t1" }, {})) === "chat +messages-query-send-status --open-task-id t1");
	check("B: 查消息带会话/关键词/时间窗", (() => { const a = argv(buildMessage({ action: "read", inGroup: "教研室", keyword: "教研", days: 3 }, { inGroup: group })); return a.includes("+search-msg") && a.includes("--chat-id cidA") && a.includes("--query 教研") && a.includes("--days 3"); })());
	check("B: 查消息默认连附件一起落盘", (() => { const a = argv(buildMessage({ action: "read", sender: "王舒莹" }, {})); return a.includes("--download-resources") && a.includes("--output-dir .tmp/dingtalk-media"); })());
	check("B: 附件目录可改（相对路径原样传、尾部斜杠去掉）", argv(buildMessage({ action: "read", outDir: "收材料/图片/" }, {})).includes("--output-dir 收材料/图片"));
	check("B: downloadResources=false 时纯查消息", !argv(buildMessage({ action: "read", downloadResources: false }, {})).includes("--download-resources"));
	check("B: 附件目录用 .. 逃出工作目录 → 报错", (() => { const e = buildMessage({ action: "read", outDir: "../x" }, {}); return "error" in e && e.error.includes("相对路径"); })());
	check("B: 附件目录不许绝对路径/盘符", typeof buildMessage({ action: "read", outDir: "C:\\tmp" }, {}).error === "string" && typeof buildMessage({ action: "read", outDir: "/tmp" }, {}).error === "string" && typeof buildMessage({ action: "read", outDir: "/" }, {}).error === "string");
	check("B: 发文件多人 → 报错（不静默只发第一个）", (() => { const e = buildMessage({ action: "send", to: ["王示例", "张示例"], file: "a.pdf" }, { people: [...people, { token: "张示例", userId: "422726045429076267" }] }); return "error" in e && e.error.includes("一次只能给一个人"); })());
	check("B: 群发逐人个性化把变量表交给管线", (() => {
		const a = argv(buildMessage({ action: "broadcast", to: ["王示例"], content: "【{{称呼}}】开会", vars: { 王示例: { 称呼: "张老师" } } }, { people }));
		return a.includes('--vars {"王示例":{"称呼":"张老师"}}');
	})());
	check("B: 正文有占位符却没给变量表 → 报错", (() => { const e = buildMessage({ action: "broadcast", to: ["王示例"], content: "{{称呼}}你好" }, { people }); return "error" in e && e.error.includes("vars"); })());
	check("B: 建群用 +chat-create（成员传解析后的 userId）", argv(buildMessage({ action: "createGroup", name: "冲刺群", members: ["王示例", "张示例"] }, { people: [...people, { token: "张示例", userId: "422726045429076267", name: "张示例" }] })) === "chat +chat-create --name 冲刺群 --users 0135091542301250234,422726045429076267");
	check("B: 建群指定群主带 owner-open-dingtalk-id", argv(buildMessage({ action: "createGroup", name: "合作群", members: ["王示例"], owner: "王舒玉" }, { people, ids: { ownerOpenId: "d9" } })).includes("--owner-open-dingtalk-id d9"));
	check("B: 建群缺群名 / 缺成员 → 人话报错", (() => { const e1 = buildMessage({ action: "createGroup", members: ["王示例"] }, { people }); const e2 = buildMessage({ action: "createGroup", name: "x" }, {}); return "error" in e1 && e1.error.includes("name") && "error" in e2 && e2.error.includes("members"); })());
	check("B: 缺必填参数时给的是人话错误", (() => { const e = buildMessage({ action: "reply", content: "x" }, {}); return "error" in e && e.error.includes("inGroup"); })());
}

console.log("C、待办域");
{
	const people = [{ token: "王示例", userId: "0135091542301250234", name: "王示例" }];
	check("C: 新建待办带执行人/截止/优先级", argv(buildTodo({ action: "create", title: "交材料", executors: ["王示例"], due: "2026-10-08", priority: "紧急" }, { people })) === "todo task create --title 交材料 --executors 0135091542301250234 --due 2026-10-08T23:59:59+08:00 --priority 40");
	check("C: 不指定执行人时派给本人 userId（不是字面 me）", argv(buildTodo({ action: "create", title: "写周报" }, { ids: { selfUserId: "u9" } })).includes("--executors u9"));
	check("C: 取不到本人 userId 时不硬发", typeof buildTodo({ action: "create", title: "写周报" }, {}).error === "string");
	check("C: 列表默认只列未完成", argv(buildTodo({ action: "list" }, {})) === "todo task list --size 50 --status false");
	check("C: 列表带关键词改走服务端搜索（list 本身没有 --query）", argv(buildTodo({ action: "list", keyword: "教研" }, {})) === "todo +search --query 教研 --status false");
	check("C: 列表带关键词且含已完成", argv(buildTodo({ action: "list", keyword: "教研", includeDone: true }, {})).includes("--status true"));
	check("C: 列表可含已完成", argv(buildTodo({ action: "list", includeDone: true }, {})).includes("--status true"));
	check("C: 完成/重开走 task done", argv(buildTodo({ action: "complete" }, { ids: { taskId: "t1" } })) === "todo task done --task-id t1 --status true");
	check("C: 删除不可逆（带提示）", buildTodo({ action: "delete" }, { ids: { taskId: "t1" } }).note.includes("不可恢复"));
	check("C: 改期待办走 task update", argv(buildTodo({ action: "update", due: "明天 09:30" }, { ids: { taskId: "t1" } })).startsWith("todo task update --task-id t1 --due "));
	check("C: 改待办什么字段都不给 → 报错", typeof buildTodo({ action: "update" }, { ids: { taskId: "t1" } }).error === "string");
	check("C: 按关键词搜待办用 +search", argv(buildTodo({ action: "search", keyword: "教研" }, {})) === "todo +search --query 教研");
}

console.log("D、日程域");
{
	const people = [{ token: "王示例", userId: "0135091542301250234" }, { token: "张示例", userId: "422726045429076267" }];
	const ev = argv(buildCalendar({ action: "create", title: "教研会", start: "2026-10-08 15:00", end: "2026-10-08 16:00", attendees: ["王示例", "张示例"], location: "三楼", rooms: [] }, { people, ids: { roomIds: "r1" } }));
	check("D: 建日程带参会人/地点/会议室", ev.includes("calendar event create --title 教研会") && ev.includes("--attendees 0135091542301250234,422726045429076267") && ev.includes("--location 三楼") && ev.includes("--rooms r1"));
	check("D: 不传参会人时不带 --attendees", !argv(buildCalendar({ action: "create", title: "自己看", start: "明天 09:00", end: "明天 10:00" }, {})).includes("--attendees"));
	check("D: 缺 start/end 报错", (() => { const e = buildCalendar({ action: "create", title: "x" }, {}); return "error" in e; })());
	check("D: 查日程默认今天一整天", (() => { const a = argv(buildCalendar({ action: "list" }, { ids: { now: NOW.toISOString() } })); return a.includes("--start 2026-10-06T00:00:00+08:00") && a.includes("--end 2026-10-06T23:59:59+08:00"); })());
	check("D: 取消日程要 eventId 且提示同步取消", (() => { const b = buildCalendar({ action: "cancel" }, { ids: { eventId: "e1" } }); return argv(b) === "calendar event delete --id e1" && b.note.includes("同步取消"); })());
	check("D: 加参会人走 attendee add", argv(buildCalendar({ action: "invite", attendees: ["王示例"] }, { people: [{ token: "王示例", userId: "0135091542301250234" }], ids: { eventId: "e1" } })) === "calendar attendee add --event e1 --attendees 0135091542301250234");
	check("D: 查空闲会议室带时段与名字", (() => { const a = argv(buildCalendar({ action: "rooms", start: "2026-10-08 15:00", end: "2026-10-08 16:00", title: "会议室" }, {})); return a.includes("calendar room search") && a.includes("--room-name 会议室"); })());
}

console.log("E、审批域");
{
	const people = [{ token: "王示例", userId: "0135091542301250234" }];
	check("E: 同意审批带 instance + 插件查到的 task", argv(buildApproval({ action: "approve", instanceId: "i1" }, { ids: { instanceId: "i1", taskId: "t1" } })) === "oa approval approve --instance-id i1 --task-id t1");
	check("E: 没查到待办任务时不硬发", typeof buildApproval({ action: "approve", instanceId: "i1" }, { ids: { instanceId: "i1" } }).error === "string");
	check("E: 拒绝可带意见", argv(buildApproval({ action: "reject", instanceId: "i1", remark: "材料不全" }, { ids: { instanceId: "i1", taskId: "t1" } })).includes("--remark 材料不全"));
	check("E: 转交给姓名解析出的 userId", argv(buildApproval({ action: "transfer", instanceId: "i1" }, { ids: { taskId: "t1" }, people })) === "oa approval redirect-task --task-id t1 --to-actioner-id 0135091542301250234");
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
	check("G: 知识库列表不支持服务端搜索 → 带 --page-all 本地筛", (() => { const a = argv(buildDoc({ action: "wikiList", workspace: "w1", query: "教案" }, { ids: { workspace: "w1" } })); return a.includes("wiki +node-list --workspace w1") && a.includes("--page-all") && !a.includes("--query"); })());
	check("G: 知识库列表不带关键词时不加 --page-all", !argv(buildDoc({ action: "wikiList", workspace: "w1" }, { ids: { workspace: "w1" } })).includes("--page-all"));
	check("G: 追加行不带区域", argv(buildDoc({ action: "sheetAppend", sheetId: "s1", values: [["甲"]] }, { ids: { doc: "n1" } })).includes("sheet append --node n1 --sheet-id s1"));
	check("G: 多维表查询带 base/table", argv(buildDoc({ action: "tableQuery" }, { ids: { baseId: "b1", tableId: "t1" } })).includes("aitable +record-query --base-id b1 --table-id t1"));
	check("G: 多维表增/改/删", argv(buildDoc({ action: "tableAdd", records: [{ cells: { 姓名: "王示例" } }] }, { ids: { baseId: "b1", tableId: "t1" } })).includes('aitable record create --base-id b1 --table-id t1 --records [{"cells":{"姓名":"王示例"}}]')
		&& argv(buildDoc({ action: "tableUpdate", records: [{ recordId: "r1", cells: { 状态: "已完成" } }] }, { ids: { baseId: "b1", tableId: "t1" } })).includes("aitable +record-update")
		&& argv(buildDoc({ action: "tableDelete", recordIds: ["r1"] }, { ids: { baseId: "b1", tableId: "t1" } })).includes("aitable +record-delete --base-id b1 --table-id t1 --record-ids r1"));
	check("G: 缺 doc/base 时不猜", typeof buildDoc({ action: "read" }, {}).error === "string" && typeof buildDoc({ action: "tableQuery" }, {}).error === "string");
	// sheetCreate：在线表格创建（values 原始 JSON 协议，区别于 sheetWrite 的 cell object）
	check("G: 空表走 create", argv(buildDoc({ action: "sheetCreate", title: "空表" }, {})) === "sheet create --name 空表");
	check("G: 有数据走 create-with-data + 裸二维 JSON", (() => { const a = argv(buildDoc({ action: "sheetCreate", title: "意向表", values: [["姓名", "手机"], ["张三", "13800000000"]] }, {})); return a === 'sheet create-with-data --name 意向表 --values [["姓名","手机"],["张三","13800000000"]]'; })());
	check("G: sheetCreate 带文件夹", argv(buildDoc({ action: "sheetCreate", title: "t", values: [[1]] }, { ids: { folder: "f1" } })).endsWith("--folder f1"));
	check("G: 超安全整数按文本写、浮点保持数字", (() => { const a = argv(buildDoc({ action: "sheetCreate", title: "t", values: [[9007199254740993, 1.5, 42]] }, {})); return a.includes('--values [["9007199254740992",1.5,42]]'); })()); // 字面量入参即被 JSON 舍入为 …992，此处只保证不安全整数转文本、浮点不动
	check("G: sheetCreate 缺 title 报错", typeof buildDoc({ action: "sheetCreate" }, {}).error === "string");
	// 下拉列表：二选一、逗号坑、多选、sourceRange 校验
	check("G: Inline 下拉", (() => { const a = argv(buildDoc({ action: "sheetSetDropdown", range: "D2:D200", options: ["线下班", "网络班"] }, { ids: { doc: "n1", sheetId: "s1" } })); return a === 'sheet set-dropdown --node n1 --sheet-id s1 --range D2:D200 --options [{"value":"线下班"},{"value":"网络班"}]'; })());
	check("G: 多选下拉带 --multi-select", argv(buildDoc({ action: "sheetSetDropdown", range: "A1", options: ["x"], multiSelect: true }, { ids: { doc: "n1", sheetId: "s1" } })).endsWith("--multi-select"));
	check("G: SourceRange 下拉", (() => { const a = argv(buildDoc({ action: "sheetSetDropdown", range: "C2:C100", sourceRange: "T1:T3", sourceSheetId: "s2" }, { ids: { doc: "n1", sheetId: "s1" } })); return a === "sheet set-dropdown --node n1 --sheet-id s1 --range C2:C100 --source-sheet-id s2 --source-range T1:T3"; })());
	check("G: options 与 sourceRange 二选一", typeof buildDoc({ action: "sheetSetDropdown", range: "A1" }, { ids: { doc: "n1", sheetId: "s1" } }).error === "string" && typeof buildDoc({ action: "sheetSetDropdown", range: "A1", options: ["a"], sourceRange: "B1", sourceSheetId: "s2" }, { ids: { doc: "n1", sheetId: "s1" } }).error === "string");
	check("G: 选项含英文逗号拦截", typeof buildDoc({ action: "sheetSetDropdown", range: "A1", options: ["a,b"] }, { ids: { doc: "n1", sheetId: "s1" } }).error === "string");
	check("G: sourceRange 拒工作表前缀", typeof buildDoc({ action: "sheetSetDropdown", range: "A1", sourceRange: "Sheet2!T1:T3", sourceSheetId: "s2" }, { ids: { doc: "n1", sheetId: "s1" } }).error === "string");
	check("G: sourceRange 缺 sourceSheetId 报错", typeof buildDoc({ action: "sheetSetDropdown", range: "A1", sourceRange: "T1:T3" }, { ids: { doc: "n1", sheetId: "s1" } }).error === "string");
	check("G: 查/删下拉", argv(buildDoc({ action: "sheetGetDropdown", range: "D2:D200" }, { ids: { doc: "n1", sheetId: "s1" } })) === "sheet get-dropdown --node n1 --sheet-id s1 --range D2:D200" && argv(buildDoc({ action: "sheetDeleteDropdown", range: "D2:D200" }, { ids: { doc: "n1", sheetId: "s1" } })).startsWith("sheet delete-dropdown"));
	check("G: 下拉缺 sheetId 时不猜", typeof buildDoc({ action: "sheetSetDropdown", range: "A1", options: ["a"] }, { ids: { doc: "n1" } }).error === "string");
}

console.log("H、审批：列表分页与摘要补算");
{
	check("H: listSubmitted 带 --page（上游单页上限 20，插件不悄悄截断页码）", argv(buildApproval({ action: "listSubmitted", page: 3 }, {})) === "oa approval list-submitted --limit 20 --page 3");
	check("H: listSubmitted 超过 20 不 clamp（让上游原话报出 limit 限制）", argv(buildApproval({ action: "listSubmitted", limit: 50 }, {})).includes("--limit 50"));
	check("H: listPending 带 --page 与关键词", (() => { const a = argv(buildApproval({ action: "listPending", page: 2, keyword: "费用" }, { ids: { now: "2026-11-04T12:00:00+08:00" } })); return a.includes("--page 2") && a.includes("--query 费用"); })());
	check("H: 摘要有明细列时标记出来（这些单据的明细行不完整）", hasDetailColumns("申请事由:x<br>名称:培训费") && hasDetailColumns("数量:22") && !hasDetailColumns("学科:信息<br>获奖级别:国家级"));
}

console.log("J、审批：模板字段组装（发起）");
{
	const schema = parseFormSchema(JSON.stringify({
		title: "申请报告",
		items: [
			{ componentName: "TextNote", props: { id: "t0", content: "说明文字不收值" } },
			{ componentName: "TextareaField", props: { label: "申请事由", id: "t1", required: true } },
			{ componentName: "SelectField", props: { label: "工会组", id: "t2", options: [{ label: "中学", value: "中学" }, { label: "小学", value: "小学" }] } },
			{
				componentName: "TableField", props: { label: "采购明细", id: "t3" },
				children: [
					{ componentName: "TextField", props: { label: "名称", id: "c1", required: true } },
					{ componentName: "NumberField", props: { label: "数量", id: "c2", required: true } },
					{ componentName: "CalculateField", props: { label: "预估金额（元）", id: "c3" } },
				],
			},
			{ componentName: "CalculateField", props: { label: "合计金额", id: "t4", required: true } },
			{ componentName: "DDAttachment", props: { label: "附件", id: "t5" } },
		],
	}));
	check("J: 字段树解析去掉 TextNote、带上子控件与选项", Array.isArray(schema) && !schema.some((f) => f.label === "") && schema.find((f) => f.label === "采购明细").children.length === 3 && schema.find((f) => f.label === "工会组").options.join() === "中学,小学");
	check("J: content 不是合法 JSON → null（调用方降级不校验）", parseFormSchema("not json") === null);

	const composed = composeFormValues(schema, {
		申请事由: "培训费报销",
		工会组: "中学",
		采购明细: [{ 名称: "高中学段培训费", 数量: 22 }],
		合计金额: "999", // 公式列，用户填了也剔掉
	});
	check("J: 明细表按行序列化成 JSON 字符串（上游吃字符串不吃数组）", JSON.parse(composed.values.采购明细).length === 1 && JSON.parse(composed.values.采购明细)[0].名称 === "高中学段培训费" && composed.values.采购明细.startsWith("["));
	check("J: 公式列自动剔除（合计金额由钉钉算）", !("合计金额" in composed.values) && !composed.missing.some((f) => f.label === "合计金额"));
	check("J: 未填的可选字段进 missing（附件），必填项没有走漏", composed.missing.map((f) => f.label).join() === "附件" && !composed.missing.some((f) => f.required));
	const partial = composeFormValues(schema, { 工会组: "中学" });
	check("J: 缺必填字段能列出来（申请事由）", partial.missing.filter((f) => f.required).map((f) => f.label).includes("申请事由"));
	check("J: 字段名写错 → unknown 而不是静默丢掉", composeFormValues(schema, { 申请事由x: "a" }).unknown.join() === "申请事由x");
	check("J: 选项不在模板里 → 报错", composeFormValues(schema, { 工会组: "大学" }).errors.join().includes("只能是"));
	check("J: 明细列名写错 → 报错说明本模板的列", composeFormValues(schema, { 采购明细: [{ 名字: "a" }] }).errors.join().includes("没有「名字」这一列"));
	check("J: 明细表给了标量 → 提示按行给数组", composeFormValues(schema, { 采购明细: "名称:a" }).errors.join().includes("按行给数组"));
	check("J: 字段清单给人看（必填/自动计算/AI 不能填）", describeFormFields(schema).join(" / ").includes("申请事由（必填）") && describeFormFields(schema).join(" / ").includes("自动计算（不用填）") && describeFormFields(schema).join(" / ").includes("附件（用 attachments 传本地路径）"));
	// 附件：模板有附件控件就自己填，没有就说清楚
	const withAttach = composeFormValues(schema, { 申请事由: "带附件" }, [{ fileId: "f1", spaceId: 450684510, fileName: "材料.zip", fileSize: 31271893, fileType: "zip" }]);
	check("J: 附件被写进模板的附件控件（不用用户知道控件叫什么）", JSON.parse(withAttach.values["附件"])[0].fileId === "f1" && withAttach.filled.includes("附件"));
	check("J: spaceId 统一成字符串（上传接口回数字、detail 里存字符串）", JSON.parse(withAttach.values["附件"])[0].spaceId === "450684510");
	check("J: 字段清单把附件控件标成用 attachments 传", describeFormFields(schema).join(" / ").includes("附件（用 attachments 传本地路径）"));
	check("J: 多份附件进同一个数组", JSON.parse(composeFormValues(schema, { 申请事由: "x" }, [{ fileId: "a", spaceId: "1", fileName: "a.pdf" }, { fileId: "b", spaceId: "1", fileName: "b.pdf" }]).values["附件"]).length === 2);
	const noAttachSchema = parseFormSchema(JSON.stringify({ items: [{ componentName: "TextareaField", props: { label: "事由", id: "t1" } }] }));
	check("J: 模板没有附件控件时明确报错（不静默丢）", composeFormValues(noAttachSchema, { 事由: "x" }, [{ fileId: "f", spaceId: "1", fileName: "a" }]).errors.join().includes("没有附件控件"));
	check("J: 已上传对象 → 附件引用（spaceId 缺省用审批空间）", asAttachmentRef({ fileId: "f9" }).spaceId === APPROVAL_SPACE_ID && asAttachmentRef({ fileId: "f9" }).fileName.length > 0);
	check("J: 已上传对象保留给定的 spaceId/文件名/大小", (() => { const a = asAttachmentRef({ fileId: "f9", spaceId: "1", fileName: "最终版.zip", fileSize: 1024 }); return a.spaceId === "1" && a.fileName === "最终版.zip" && a.fileSize === 1024; })());
	check("J: 已上传对象写进表单值时与原单结构一致", (() => { const v = JSON.parse(attachmentValue([asAttachmentRef({ fileId: "241929726779", fileName: "x.zip", fileSize: 31271893, fileType: "zip", spaceId: "450684510" })]))[0]; return v.fileId === "241929726779" && v.spaceId === "450684510" && v.fileName === "x.zip" && v.fileType === "zip"; })());
	check("J: attachmentValue 不带 fileSize/fileType 时也不塞空值", !attachmentValue([{ fileId: "f", spaceId: "1", fileName: "a" }]).includes("fileSize"));

	check("J: create 用校验后的值、forecast 同源", argv(buildApproval({ action: "create", processCode: "P1", formValues: { 申请事由: "x" } }, { formValues: { 申请事由: "x", 采购明细: "[]" } })).includes('--form-values {"申请事由":"x","采购明细":"[]"}'));
	check("J: formSchema 走 form-schema 原文", argv(buildApproval({ action: "formSchema", processCode: "P1" }, {})) === "oa approval form-schema --process-code P1");
	check("J: forecast 带 dept-id 与表单值", (() => { const a = argv(buildApproval({ action: "forecast", processCode: "P1", formValues: { a: "1" } }, { formValues: { a: "1" } })); return a === 'oa approval forecast-process --process-code P1 --dept-id -1 --form-values {"a":"1"}'; })());
	check("J: 缺模板 code 时 forecast/create 都报错", typeof buildApproval({ action: "forecast" }, {}).error === "string" && typeof buildApproval({ action: "create", formValues: { a: "1" } }, {}).error === "string");
}

console.log("L、明细表带值时的提前拦截判定");
{
	// 拦不拦由「模板有 TableField 且用户给了非空数组」决定
	const table = { componentName: "TableField", label: "采购明细", required: false, children: [] };
	const text = { componentName: "TextareaField", label: "申请事由", required: true };
	check("L: 明细带非空数组 → 拦", filledTableLabels([text, table], { 采购明细: [{ 名称: "a" }] }).length === 1);
	check("L: 明细给空数组 → 不拦（此时上游报的是必填错误，能说清）", filledTableLabels([text, table], { 采购明细: [] }).length === 0);
	check("L: 不给明细 → 不拦", filledTableLabels([text, table], { 申请事由: "x" }).length === 0);
	check("L: 模板没有明细表 → 永远不拦", filledTableLabels([text], { 申请事由: "x" }).length === 0);
	check("L: 报出的是字段标签", filledTableLabels([table], { 采购明细: [{ 名称: "a" }] })[0] === "采购明细");
}

console.log("M、标识符兼容层（形态判定只有一处）");
{
	const cases = [
		["我", "self"],
		["cid2IuUX0QX0stdfedtWgG2qd4AbDa8pMjXNgavNGL1Swo=", "conversation"],
		["PROC-EF6Y1NYRN2-NRNK3TNVR7ZAQORSK5MU1-7NLFCF2J-KC", "processCode"],
		["DfiPsqEEep68BKVsuiizYyTVkiS3jiiutHEiPM", "openId"],
		["0135091542301250234", "userId"],
		["422726045429076267", "userId"],
		["13800138000", "mobile"],
		["王示例", "name"],
		["report.docx", "name"],
	];
	for (const [token, want] of cases) check(`M: ${token.slice(0, 24)} → ${want}`, idKindOf(token) === want, idKindOf(token));
	// isStableId 与 idKindOf 的差别只在两类：自指词要走去 +me、姓名要搜索
	check("M: 姓名与自指词都不算稳定 ID", !isStableId("王示例") && !isStableId("我"));
	// 收件人参数按用户给的那串走，不反查成别的形态
	check("M: 给 userId → --user", recipientFlag({ token: "0135091542301250234", userId: "0135091542301250234" })?.flag === "--user");
	check("M: 给 openId → --open-dingtalk-id", recipientFlag({ token: "DfiPsqEEep68BKVsuiizYyTVkiS3jiiutHEiPM", userId: "" })?.flag === "--open-dingtalk-id");
	check("M: 给 cid → --chat-id", recipientFlag({ token: "cid2IuUX0QX0stdfedtWgG2qd4AbDa8pMjXNgavNGL1Swo=", userId: "" })?.flag === "--chat-id");
	check("M: 给姓名 → 用解析出的 userId", recipientFlag({ token: "王示例", userId: "0135091542301250234" })?.flag === "--user");
}

console.log("O、审批单跳转链接");
{
	const link = approvalCardLink("ding0ff4281487a9507135c2f4657eb6378f", "-dGvs0kQT3KCpqdSPVHk8Q07271793773849");
	check("O: 含实例 ID", link.includes("procInstId%3D-dGvs0kQT3KCpqdSPVHk8Q07271793773849"));
	check("O: 桌面与手机端都给", link.includes("pcLink=") && link.includes("mobileLink="));
	check("O: taskId 留空（长期有效）", !link.includes("taskId%3D"));
	check("O: 含必要参数（back/dtaction/dinghash）", ["back", "dtaction", "dinghash"].every((k) => link.includes(k)));
	check("O: 不含可省略参数（dd_share/showmenu/dd_progress/swfrom/taskId）", !["dd_share", "showmenu", "dd_progress", "swfrom", "taskId"].some((k) => link.includes(k)));
}

console.log("Z、工具参数 schema 能被供应商接受");
{
	// 供应商按 JSON Schema 校验函数定义：union 必须是 anyOf/oneOf，type 携带数组会被整包拒掉
	// （曾把 Type.Record 的第二参写成数组，全工具 400 invalid_request_error）
	const illegal = [];
	const walk = (v, path) => {
		if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
		if (!v || typeof v !== "object") return;
		const o = v;
		if (Array.isArray(o.type)) illegal.push(`${path}.type=${JSON.stringify(o.type)}`);
		if (Array.isArray(o.items) && !o.items.some((x) => x && typeof x === "object" && "type" in x)) {
			// 数组式 tuple items 合法但少见，仅记录以便目视
		}
		Object.entries(o).forEach(([k, x]) => walk(x, `${path}.${k}`));
	};
	const schemas = { ApprovalParams, MessageParams, TodoParams, CalendarParams, FileParams, DocParams };
	for (const [name, schema] of Object.entries(schemas)) {
		const json = JSON.parse(JSON.stringify(schema));
		check(`Z: ${name} 可序列化成 JSON（无循环/非法值）`, !!json);
		walk(json, name);
	}
	check("Z: 所有工具 schema 的 type 都不是数组", illegal.length === 0, illegal.join("; "));
	// 值类型的联合落在 patternProperties."^.*$".anyOf（Record 的值位）
	const fv = JSON.parse(JSON.stringify(ApprovalParams)).properties.formValues;
	const branches = fv?.patternProperties?.["^.*$"]?.anyOf ?? [];
	check("Z: formValues 的联合类型走 anyOf（字符串/数字/布尔/明细数组）", Array.isArray(branches) && branches.length === 4 && branches.some((x) => x.type === "array"), JSON.stringify(fv)?.slice(0, 300));
}

console.log("K、forecast 结论");
{
	const base = { result: { processCode: "P", processId: 1, userId: "u", forecastSuccess: false, staticWorkflow: false, workflowActivityRuleVOs: [], workflowForecastNodes: [] } };
	// 实测：静态流程即使表单值完全合法也回 forecastSuccess=false —— 不能当成失败
	const stat = { result: { ...base.result, staticWorkflow: true, workflowForecastNodes: [{ activityId: "sid-startevent", outIds: ["x"] }] } };
	const r1 = readForecast(stat);
	check("K: 静态流程 + forecastSuccess=false → 可继续（说明审批人由模板固定）", r1.kind === "ok" && r1.summary.includes("静态流程") && r1.summary.includes("模板固定"), r1.summary);
	const r2 = readForecast(base);
	check("K: 非静态 + forecastSuccess=false → 才算真预测失败", r2.kind === "failed" && r2.summary.includes("预测失败"), r2.summary);
	const sel = { result: { ...base.result, forecastSuccess: true, staticWorkflow: false, workflowActivityRuleVOs: [
		{ activityId: "a1", activityName: "审批人", activityType: "target_select", targetSelect: true, workflowActor: { actorKey: "manual_x", actorType: "approver" } },
		{ activityId: "a2", activityName: "抄送", activityType: "target_notifier", targetSelect: false, workflowActor: { actorKey: "k2", actorType: "notifier" } },
	] } };
	const r3 = readForecast(sel);
	check("K: 有 targetSelect 节点 → 要选人（列出节点与 actorKey）", r3.kind === "needsActioners" && r3.selects.length === 1 && r3.selects[0].actorKey === "manual_x" && r3.summary.includes("审批节点「审批人」"), r3.summary);
	check("K: 已固定的节点进路径、不进待选清单", r3.path.join() === "审批人,抄送" && !r3.selects.some((x) => x.activityId === "a2"));
	const plain = { result: { ...base.result, forecastSuccess: true, staticWorkflow: false, workflowActivityRuleVOs: [{ activityId: "a1", activityName: "主管", targetSelect: false }] } };
	const r4 = readForecast(plain);
	check("K: 动态流程无自选节点 → 可继续，并给出路径", r4.kind === "ok" && r4.summary.includes("主管"), r4.summary);
	check("K: 坏数据不崩", readForecast(null).kind === "failed" && readForecast({}).kind === "failed");
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过 ✓");
process.exit(failed.length ? 1 : 0);
