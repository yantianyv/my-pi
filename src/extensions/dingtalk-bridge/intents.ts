/**
 * 语义层：把「业务动作 + 业务参数」映射成 dws 的 argv（纯函数，测试直引）。
 *
 * 定位：AI 只说业务话（收件人姓名、群名、正文、时间），本模块负责
 *   · 参数名与取值规范化（时间 → 带偏移 ISO、优先级 → 10/20/30/40、提醒方式 → app/sms/call）
 *   · 命令与 flag 的选择（这部分是 dws 的实现细节，不该出现在模型侧）
 * 名字→ID、群名→会话、消息定位等需要联网解析的事一律由 index.ts 做完后经 `Resolved` 传进来，
 * 本模块不碰进程、不发请求（因此可离线回归）。
 *
 * 一个动作一行映射，扩展新动作 = 加一行；映射不到的一律给人话错误，不猜（模型没有 dws 命令通道）。
 */
import { Type, type Static } from "typebox";

/* ============================== 值规范化（纯函数） ============================== */

/** 默认时区偏移：语义层只服务本地组织，未显式给偏移时按东八区补全 */
const DEFAULT_OFFSET = "+08:00";

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * 业务时间 → dws 要的 ISO-8601（必带偏移）。
 * 接受：完整 ISO（原样保留）、`2026-10-08`、`2026-10-08 15:00`、`15:00`、`今天|明天|后天 15:00`；
 * `end=true` 时只有日期（或今天/明天）默认补到当天 23:59:59（做时间窗的结束点）。
 */
export function isoTime(input: string, opts: { end?: boolean; now?: Date } = {}): string | { error: string } {
	const raw = input.trim();
	if (!raw) return { error: "时间为空" };
	const tz = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? "" : DEFAULT_OFFSET;
	if (!tz) return raw; // 已带偏移/时区，原样用
	const now = opts.now ?? new Date();
	const clock = opts.end ? "23:59:59" : "00:00:00";
	const shiftDay = (days: number): string => {
		const d = new Date(now.getTime() + days * 86_400_000);
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	};
	let m = /^(今天|明天|后天|大后天)\s*(\d{1,2})[:：](\d{2})$/.exec(raw);
	if (m) {
		const off = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[m[1] as "今天"];
		return `${shiftDay(off)}T${pad(Number(m[2]))}:${m[3]}:00${DEFAULT_OFFSET}`;
	}
	m = /^(今天|明天|后天|大后天)$/.exec(raw);
	if (m) {
		const off = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[m[1] as "今天"];
		return `${shiftDay(off)}T${clock}${DEFAULT_OFFSET}`;
	}
	m = /^(\d{1,2})[:：](\d{2})$/.exec(raw);
	if (m) return `${shiftDay(0)}T${pad(Number(m[1]))}:${m[2]}:00${DEFAULT_OFFSET}`;
	m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
	if (m) {
		const date = `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
		if (!m[4]) return `${date}T${clock}${DEFAULT_OFFSET}`;
		return `${date}T${pad(Number(m[4]))}:${m[5]}:${m[6] ?? "00"}${DEFAULT_OFFSET}`;
	}
	return { error: `看不懂的时间写法「${input}」——请给「2026-10-08 15:00」或「明天 09:30」这类写法` };
}

/** 优先级：业务词 → dws 的 10/20/30/40 */
export function priorityCode(input: string | number): string | { error: string } {
	if (typeof input === "number") return String(input);
	const v = input.trim();
	if (/^(10|20|30|40)$/.test(v)) return v;
	const map: Record<string, string> = { 低: "10", 普通: "20", 中: "20", 一般: "20", 较高: "30", 高: "30", 重要: "30", 紧急: "40", 最高: "40", low: "10", normal: "20", medium: "20", high: "30", urgent: "40" };
	return map[v.toLowerCase()] ?? { error: `看不懂的优先级「${input}」——可用 低/普通/较高/紧急` };
}

/** DING 提醒方式：业务词 → app/sms/call（短信与电话有费用，面板会提示） */
export function dingTypeCode(input: string): string | { error: string } {
	const v = input.trim().toLowerCase();
	const map: Record<string, string> = { 应用内: "app", 应用: "app", 默认: "app", app: "app", 短信: "sms", sms: "sms", 电话: "call", 打电话: "call", call: "call" };
	return map[v] ?? { error: `看不懂的提醒方式「${input}」——可用 应用内/短信/电话` };
}

/** 表格单元格：业务值 → dws 的 cell object（null 用 {} 表示跳过该格） */
export function toCells(values: Array<Array<string | number | boolean | null>>): string {
	const cells = values.map((row) =>
		row.map((v) => {
			if (v === null || v === undefined) return {};
			if (typeof v === "number") return { type: "number", number: v };
			if (typeof v === "boolean") return { type: "checkbox", checked: v };
			return { type: "text", text: String(v) };
		}),
	);
	return JSON.stringify(cells);
}

/* ============================== 消息附件落盘 ============================== */

/** 消息附件（图片/语音/文件）默认落盘目录：工作目录内相对路径 */
export const MEDIA_OUT_DIR = ".tmp/dingtalk-media";

/** 附件目录规范化：dws 只收工作目录内的相对路径（拒绝盘符/前导斜杠/.. 逃逸），这里先拦给人话 */
export function mediaOutDir(input?: string): string | { error: string } {
	const raw = (input ?? "").trim().replace(/\\/g, "/");
	if (!raw || raw === "." || raw === "./") return MEDIA_OUT_DIR;
	if (/^([a-zA-Z]:|\/)/.test(raw) || raw.split("/").includes("..")) {
		return { error: `附件目录得是工作目录内的相对路径（不带盘符、前导斜杠或 ..）：${input}` };
	}
	return raw.replace(/\/+$/, "");
}

/* ============================== 参数形状（工具 schema，单一真值源） ============================== */

const Action = (values: readonly string[], extra?: string) =>
	Type.String({ description: `动作：${values.join(" | ")}${extra ? `。${extra}` : ""}` });

export const MessageParams = Type.Object({
	action: Action(["send", "sendGroup", "broadcast", "reply", "forward", "ding", "recall", "sendStatus", "read"], "read=按会话/关键词查消息"),
	to: Type.Optional(Type.Array(Type.String(), { description: "收件人：姓名或账号 ID（send/broadcast/ding 用；多个即多人）" })),
	group: Type.Optional(Type.String({ description: "目标会话：群名或会话 ID（sendGroup 用）" })),
	content: Type.Optional(Type.String({ description: "正文（Markdown；多行直接写换行）" })),
	vars: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Record(Type.String(), Type.String())]), {
			description: "（broadcast 逐人个性化）正文里 {{变量}} 的每人取值：{收件人: 值} 或 {收件人: {变量: 值}}",
		}),
	),
	file: Type.Optional(Type.String({ description: "要发的文件：工作目录内相对路径（与 content 不能同时用于同一条）" })),
	inGroup: Type.Optional(Type.String({ description: "（reply/forward/ding/recall）待操作消息所在会话：群名、会话 ID 或单聊对方姓名" })),
	destGroup: Type.Optional(Type.String({ description: "（forward）转发目标：群名、会话 ID 或单聊对方姓名（写人名即转发给他）" })),
	messageId: Type.Optional(Type.String({ description: "（reply/forward/ding/recall）消息 ID；不知道时改用 keyword+sender，由插件定位" })),
	keyword: Type.Optional(Type.String({ description: "（read，或没有 messageId 时）按关键词找消息" })),
	sender: Type.Optional(Type.String({ description: "找消息时的发送人：姓名、me、对方姓名；默认 me" })),
	days: Type.Optional(Type.Number({ description: "找消息的时间范围：最近 N 天，默认 7" })),
	limit: Type.Optional(Type.Number({ description: "read 返回条数，默认 20" })),
	outDir: Type.Optional(Type.String({ description: `（read）消息附件的保存目录：工作目录内相对路径，默认 ${MEDIA_OUT_DIR}` })),
	downloadResources: Type.Optional(Type.Boolean({ description: "（read）是否把消息里的附件（图片/语音/文件）一并下载，默认 true" })),
	dingType: Type.Optional(Type.String({ description: "（ding）提醒方式：应用内（默认）/短信/电话，后两者有费用" })),
	taskId: Type.Optional(Type.String({ description: "（sendStatus）发送任务 ID" })),
	confirm: Type.Optional(Type.String({ description: "两阶段确认 token（首次调用的回执里给出）" })),
});
export type MessageParamsT = Static<typeof MessageParams>;

export const TodoParams = Type.Object({
	action: Action(["list", "create", "update", "complete", "delete", "search"]),
	title: Type.Optional(Type.String({ description: "（create/update）待办标题" })),
	taskId: Type.Optional(Type.String({ description: "（update/complete/delete）待办 ID" })),
	executors: Type.Optional(Type.Array(Type.String(), { description: "（create/update）执行人：姓名或 userId；默认给发起人自己" })),
	participants: Type.Optional(Type.Array(Type.String(), { description: "（create）参与人：姓名或 userId（只关注不负责完成）" })),
	due: Type.Optional(Type.String({ description: "（create/update）截止时间：如「2026-10-08 15:00」「明天 09:30」" })),
	priority: Type.Optional(Type.String({ description: "（create/update）优先级：低/普通/较高/紧急" })),
	keyword: Type.Optional(Type.String({ description: "（list/search）按标题或内容过滤" })),
	includeDone: Type.Optional(Type.Boolean({ description: "（list）是否连已完成的一起列，默认 false" })),
	confirm: Type.Optional(Type.String({ description: "两阶段确认 token" })),
});
export type TodoParamsT = Static<typeof TodoParams>;

export const CalendarParams = Type.Object({
	action: Action(["list", "create", "update", "cancel", "detail", "invite", "rooms"]),
	eventId: Type.Optional(Type.String({ description: "（update/cancel/detail/invite）日程 ID" })),
	title: Type.Optional(Type.String({ description: "（create/update）日程主题" })),
	start: Type.Optional(Type.String({ description: "开始时间：如「2026-10-08 15:00」「明天 09:30」「15:00」" })),
	end: Type.Optional(Type.String({ description: "结束时间（写法同 start）" })),
	attendees: Type.Optional(Type.Array(Type.String(), { description: "参会人：姓名或 userId" })),
	location: Type.Optional(Type.String({ description: "地点（纯文字，订会议室用 rooms）" })),
	desc: Type.Optional(Type.String({ description: "日程描述/议程" })),
	rooms: Type.Optional(Type.Array(Type.String(), { description: "（create/invite）会议室名称（插件自己搜空房拿 ID）" })),
	remindMinutes: Type.Optional(Type.Number({ description: "提前几分钟提醒，默认 15" })),
	confirm: Type.Optional(Type.String({ description: "两阶段确认 token" })),
});
export type CalendarParamsT = Static<typeof CalendarParams>;

/* ============================== dws 调用所需的外部解析结果 ============================== */

export interface ResolvedPerson {
	/** 模型给的原始 token（姓名或 ID），用于错误信息与面板 */
	token: string;
	userId: string;
	/** openDingTalkId：DING 与部分发送命令要它 */
	openId?: string;
	/** 解析出的姓名（ID 输入时由插件补） */
	name?: string;
}
export interface ResolvedGroup {
	token: string;
	cid: string;
	title?: string;
}
export interface ResolvedMessage {
	msgId: string;
	conversationId: string;
	preview?: string;
	time?: string;
}
export interface Resolved {
	people?: ResolvedPerson[];
	/** group 参数的解析结果 */
	group?: ResolvedGroup;
	/** inGroup / destGroup 的解析结果 */
	inGroup?: ResolvedGroup;
	destGroup?: ResolvedGroup;
	message?: ResolvedMessage;
	/** 日程/待办里 id 型 token 的解析结果（如任务标题 → taskId） */
	ids?: Record<string, string>;
}

export type Built = { args: string[]; note?: string } | { error: string };
const err = (msg: string): Built => ({ error: msg });

const personIds = (people: ResolvedPerson[] | undefined, kind: "userId" | "openId"): string[] =>
	(people ?? []).map((p) => (kind === "openId" ? p.openId ?? "" : p.userId)).filter(Boolean);

/* ============================== 消息域 ============================== */

export function buildMessage(p: MessageParamsT, r: Resolved): Built {
	const content = p.content?.trim() ?? "";
	const people = r.people ?? [];
	switch (p.action) {
		case "send": {
			if (!people.length) return err("send 需要 to（收件人姓名或账号）");
			if (!content && !p.file) return err("send 需要 content 或 file");
			if (p.file) {
				const who = people[0]!;
				if (!who.openId) return err(`没取到「${who.token}」的 openDingTalkId，无法发文件——请改用逃生舱或让对方先发一条消息`);
				return { args: ["chat", "+messages-send", "--as", "user", "--open-dingtalk-id", who.openId, "--file", p.file, "--ai-tag"], note: `文件消息：本条不含说明正文，说明文字要另发一条` };
			}
			// 单人走 +dm；多人自动升级为群发（每人一条单聊）
			if (people.length === 1) return { args: ["chat", "+dm", "--to", people[0]!.userId, "--content", content, "--ai-tag"] };
			return { args: ["chat", "+broadcast", "--to", people.map((x) => x.token).join(","), "--content", content, "--ai-tag"], note: "多人单聊：按姓名群发，发送前会预检收件人" };
		}
		case "sendGroup": {
			if (!r.group) return err("sendGroup 需要 group（群名或会话 ID）");
			if (!content && !p.file) return err("sendGroup 需要 content 或 file");
			if (p.file) return { args: ["chat", "+messages-send", "--as", "user", "--group", r.group.cid, "--file", p.file, "--ai-tag"], note: "文件消息：本条不含说明正文" };
			return { args: ["chat", "+send-to-group", "--group", r.group.cid, "--content", content, "--ai-tag"] };
		}
		case "broadcast": {
			if (!people.length && !p.to?.length) return err("broadcast 需要 to（收件人姓名列表）");
			if (!content) return err("broadcast 需要 content");
			const tokens = people.length ? people.map((x) => x.token) : p.to!;
			const args = ["chat", "+broadcast", "--to", tokens.join(","), "--content", content, "--ai-tag"];
			// 逐人个性化：正文含占位符时把变量表交给管线的私有 flag（--vars），由它逐人渲染发送
			if (content.includes("{{")) {
				if (!p.vars) return err("正文含 {{变量}}：请用 vars 给每位收件人的取值");
				args.push("--vars", JSON.stringify(p.vars));
			}
			return { args };
		}
		case "reply": {
			if (!r.message) return err("reply 需要 inGroup + messageId（或 keyword 让插件先找消息）");
			if (!content) return err("reply 需要 content");
			return { args: ["chat", "+messages-reply", "--group", r.message.conversationId, "--message-id", r.message.msgId, "--content", content, "--ai-tag"] };
		}
		case "forward": {
			if (!r.message) return err("forward 需要 inGroup + messageId（或 keyword 让插件先找消息）");
			if (!r.destGroup) return err("forward 需要 destGroup（转发目标会话）");
			return { args: ["chat", "+messages-forward", "--src-conversation-id", r.message.conversationId, "--dest-conversation-id", r.destGroup.cid, "--msg-id", r.message.msgId] };
		}
		case "ding": {
			if (!r.message) return err("ding 需要 inGroup + messageId（或 keyword 让插件先找消息）");
			const openIds = personIds(people, "openId");
			if (!openIds.length) return err("ding 需要 to（收件人姓名或账号），且要能取到 openDingTalkId");
			const args = ["ding", "+send-by-message", "--group", r.message.conversationId, "--message-id", r.message.msgId, "--users", openIds.join(",")];
			if (p.dingType) {
				const t = dingTypeCode(p.dingType);
				if (typeof t !== "string") return err(t.error);
				args.push("--type", t);
			}
			return { args, note: "消息转 DING：强打扰，短信/电话类型有费用" };
		}
		case "recall": {
			if (!r.message) return err("recall 需要 inGroup + messageId（或 keyword 让插件先找消息）");
			return { args: ["chat", "+messages-recall", "--msg-id", r.message.msgId], note: "撤回后双方均不可见" };
		}
		case "sendStatus": {
			if (!p.taskId) return err("sendStatus 需要 taskId");
			return { args: ["chat", "+messages-query-send-status", "--open-task-id", p.taskId] };
		}
		case "read": {
			const args = ["chat", "+search-msg", "--limit", String(Math.min(p.limit ?? 20, 100)), "--order", "desc"];
			if (p.group || p.inGroup) {
				const g = r.group ?? r.inGroup;
				args.push("--chat-id", g ? g.cid : (p.group ?? p.inGroup)!);
			}
			// 「我/me」不是合法查询值：能拿到本人姓名就用姓名，拿不到就不限发送人
			const senderRaw = p.sender?.trim();
			const sender = senderRaw && /^(me|我|自己|本人)$/i.test(senderRaw) ? r.ids?.selfName : senderRaw;
			if (sender) args.push("--sender-query", sender);
			if (p.keyword) args.push("--query", p.keyword);
			args.push("--days", String(Math.max(1, Math.min(p.days ?? 7, 30))));
			// 查消息顺手落盘附件：dws 自带 --download-resources，省一轮「先看有什么再单独下载」
			if (p.downloadResources !== false) {
				const dir = mediaOutDir(p.outDir);
				if (typeof dir !== "string") return err(dir.error);
				args.push("--download-resources", "--output-dir", dir);
			}
			return { args };
		}
	}
	return err(`不支持的消息动作「${String(p.action)}」`);
}

/* ============================== 待办域 ============================== */

export function buildTodo(p: TodoParamsT, r: Resolved): Built {
	const executors = personIds(r.people, "userId");
	switch (p.action) {
		case "list": {
			const args = ["todo", "task", "list", "--size", "50", "--status", p.includeDone ? "true" : "false"];
			if (p.keyword) args.push("--query-all");
			return { args, note: p.keyword ? `列表按状态/角色取回后，插件已按「${p.keyword}」过滤标题` : undefined };
		}
		case "search": {
			if (!p.keyword) return err("search 需要 keyword");
			return { args: ["todo", "+search", "--query", p.keyword] };
		}
		case "create": {
			if (!p.title) return err("create 需要 title");
			const args = ["todo", "task", "create", "--title", p.title];
			// 执行人必须是真的 userId（dws 不认 "me"）；没指定时用插件查到的本人 userId
			const who = executors.length ? executors.join(",") : r.ids?.selfUserId;
			if (!who) return err("create 需要 executors（姓名或 userId），或先让插件取到本人 userId");
			args.push("--executors", who);
			if (p.due) {
				const t = isoTime(p.due, { end: true });
				if (typeof t !== "string") return err(t.error);
				args.push("--due", t);
			}
			if (p.priority) {
				const c = priorityCode(p.priority);
				if (typeof c !== "string") return err(c.error);
				args.push("--priority", c);
			}
			return { args, note: r.ids?.participantsNote };
		}
		case "update": {
			const taskId = r.ids?.taskId ?? p.taskId;
			if (!taskId) return err("update 需要 taskId（或先用 action=list 找到待办）");
			const args = ["todo", "task", "update", "--task-id", taskId];
			const before = args.length;
			if (p.title) args.push("--title", p.title);
			if (p.due) {
				const t = isoTime(p.due, { end: true });
				if (typeof t !== "string") return err(t.error);
				args.push("--due", t);
			}
			if (p.priority) {
				const c = priorityCode(p.priority);
				if (typeof c !== "string") return err(c.error);
				args.push("--priority", c);
			}
			if (args.length === before) return err("update 至少要给 title / due / priority 之一");
			return { args };
		}
		case "complete": {
			const taskId = r.ids?.taskId ?? p.taskId;
			if (!taskId) return err("complete 需要 taskId");
			return { args: ["todo", "task", "done", "--task-id", taskId, "--status", "true"] };
		}
		case "delete": {
			const taskId = r.ids?.taskId ?? p.taskId;
			if (!taskId) return err("delete 需要 taskId");
			return { args: ["todo", "task", "delete", "--task-id", taskId], note: "删除待办不可恢复" };
		}
	}
	return err(`不支持的待办动作「${String(p.action)}」`);
}

/* ============================== 日程域 ============================== */

export function buildCalendar(p: CalendarParamsT, r: Resolved): Built {
	const attendees = personIds(r.people, "userId");
	const eventId = r.ids?.eventId ?? p.eventId;
	switch (p.action) {
		case "list": {
			const args = ["calendar", "event", "list", "--limit", "50"];
			const start = p.start ? isoTime(p.start) : isoTime("今天", { now: r.ids?.now ? new Date(r.ids.now) : undefined });
			const end = p.end ? isoTime(p.end, { end: true }) : null;
			if (typeof start !== "string") return err(start.error);
			args.push("--start", start);
			if (end && typeof end !== "string") return err(end.error);
			args.push("--end", end ? (end as string) : start.replace(/T00:00:00/, "T23:59:59"));
			return { args };
		}
		case "create": {
			if (!p.title) return err("create 需要 title");
			if (!p.start || !p.end) return err("create 需要 start 与 end");
			const s = isoTime(p.start);
			const e = isoTime(p.end, { end: true });
			if (typeof s !== "string") return err(s.error);
			if (typeof e !== "string") return err(e.error);
			const args = ["calendar", "event", "create", "--title", p.title, "--start", s, "--end", e];
			if (attendees.length) args.push("--attendees", attendees.join(","));
			if (p.location) args.push("--location", p.location);
			if (p.desc) args.push("--desc", p.desc);
			if (p.remindMinutes !== undefined) args.push("--remind-minutes", String(p.remindMinutes));
			if (r.ids?.roomIds) args.push("--rooms", r.ids.roomIds);
			return { args, note: attendees.length ? `${attendees.length} 位参会人会收到邀请通知` : undefined };
		}
		case "update": {
			if (!eventId) return err("update 需要 eventId");
			const args = ["calendar", "event", "update", "--id", eventId];
			const before = args.length;
			if (p.title) args.push("--title", p.title);
			if (p.start) {
				const s = isoTime(p.start);
				if (typeof s !== "string") return err(s.error);
				args.push("--start", s);
			}
			if (p.end) {
				const e = isoTime(p.end, { end: true });
				if (typeof e !== "string") return err(e.error);
				args.push("--end", e);
			}
			if (p.location) args.push("--location", p.location);
			if (p.desc) args.push("--desc", p.desc);
			if (args.length === before) return err("update 至少要给 title / start / end / location / desc 之一");
			return { args };
		}
		case "cancel": {
			if (!eventId) return err("cancel 需要 eventId");
			return { args: ["calendar", "event", "delete", "--id", eventId], note: "所有参会人的日程会同步取消" };
		}
		case "detail": {
			if (!eventId) return err("detail 需要 eventId");
			return { args: ["calendar", "event", "get", "--id", eventId] };
		}
		case "invite": {
			if (!eventId) return err("invite 需要 eventId");
			if (!attendees.length) return err("invite 需要 attendees（参会人姓名）");
			return { args: ["calendar", "attendee", "add", "--event", eventId, "--attendees", attendees.join(",")], note: "被加的人会收到邀请通知" };
		}
		case "rooms": {
			const args = ["calendar", "room", "search", "--limit", "20"];
			if (p.start) {
				const s = isoTime(p.start);
				if (typeof s !== "string") return err(s.error);
				args.push("--start", s);
			}
			if (p.end) {
				const e = isoTime(p.end, { end: true });
				if (typeof e !== "string") return err(e.error);
				args.push("--end", e);
			}
			if (p.title) args.push("--room-name", p.title);
			return { args };
		}
	}
	return err(`不支持的日程动作「${String(p.action)}」`);
}

/* ============================== 审批域 ============================== */

export const ApprovalParams = Type.Object({
	action: Action(["listPending", "listSubmitted", "detail", "approve", "reject", "transfer", "revoke", "forms", "create"], "approve/reject/transfer 只需给 instanceId，任务 ID 由插件自动查"),
	instanceId: Type.Optional(Type.String({ description: "审批实例 ID（listPending/listSubmitted 的结果里有）" })),
	keyword: Type.Optional(Type.String({ description: "按关键词找审批（forms=找模板；listPending/listSubmitted/detail 定位单据）" })),
	to: Type.Optional(Type.String({ description: "（transfer）转交给谁：姓名或 userId" })),
	remark: Type.Optional(Type.String({ description: "（approve/reject/transfer/revoke）审批意见" })),
	processCode: Type.Optional(Type.String({ description: "（create）审批模板 code（先用 action=forms 按关键词查）；forms+processCode 会返回该模板的字段清单" })),
	formValues: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "（create）表单字段：{字段名: 值}，字段名照 action=forms 给出的模板字段" })),
	approvers: Type.Optional(Type.Array(Type.String(), { description: "（create）审批人：姓名或 userId" })),
	days: Type.Optional(Type.Number({ description: "（listPending）回看天数，默认 30" })),
	limit: Type.Optional(Type.Number({ description: "返回条数，默认 20" })),
	confirm: Type.Optional(Type.String({ description: "两阶段确认 token" })),
});
export type ApprovalParamsT = Static<typeof ApprovalParams>;

export function buildApproval(p: ApprovalParamsT, r: Resolved): Built {
	const limit = String(Math.min(p.limit ?? 20, 100));
	const instanceId = r.ids?.instanceId ?? p.instanceId;
	switch (p.action) {
		case "listPending": {
			const now = r.ids?.now ? new Date(r.ids.now) : new Date();
			const days = Math.max(1, Math.min(p.days ?? 30, 365));
			const start = new Date(now.getTime() - days * 86_400_000);
			const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
			return { args: ["oa", "approval", "list-pending", "--start", `${fmt(start)}T00:00:00${DEFAULT_OFFSET}`, "--end", `${fmt(now)}T23:59:59${DEFAULT_OFFSET}`, "--limit", limit] };
		}
		case "listSubmitted": {
			const args = ["oa", "approval", "list-submitted", "--limit", limit];
			if (p.keyword) args.push("--query", p.keyword);
			return { args };
		}
		case "detail": {
			if (!instanceId) return err("detail 需要 instanceId（可先用 action=listPending/listSubmitted 查）");
			return { args: ["oa", "approval", "detail", "--instance-id", instanceId] };
		}
		case "approve":
		case "reject": {
			if (!instanceId) return err(`${p.action} 需要 instanceId`);
			if (!r.ids?.taskId) return err(`没查到该审批单里待你处理的任务（可能已被处理或不是你的任务）`);
			const args = ["oa", "approval", p.action, "--instance-id", instanceId, "--task-id", r.ids.taskId];
			if (p.remark) args.push("--remark", p.remark);
			return { args, note: "审批决定发出后不可撤回" };
		}
		case "transfer": {
			if (!r.ids?.taskId) return err("transfer 需要 instanceId，且该单据要有待你处理的任务");
			const to = r.people?.[0];
			if (!to) return err("transfer 需要 to（转交给谁）");
			const args = ["oa", "approval", "redirect-task", "--task-id", r.ids.taskId, "--to-actioner-id", to.userId];
			if (p.remark) args.push("--remark", p.remark);
			return { args };
		}
		case "revoke": {
			if (!instanceId) return err("revoke 需要 instanceId");
			const args = ["oa", "approval", "revoke", "--instance-id", instanceId];
			if (p.remark) args.push("--remark", p.remark);
			return { args };
		}
		case "forms": {
			// 给了模板 code 就返回该模板的字段清单（发起前必须按它填 formValues）
			if (p.processCode) return { args: ["oa", "approval", "form-schema", "--process-code", p.processCode] };
			return p.keyword ? { args: ["oa", "+search-forms", "--query", p.keyword] } : { args: ["oa", "+list-forms"] };
		}
		case "create": {
			if (!p.processCode) return err("create 需要 processCode（先用 action=forms 查模板）");
			if (!p.formValues || !Object.keys(p.formValues).length) return err("create 需要 formValues（模板字段与值）");
			const args = ["oa", "approval", "create-instance", "--process-code", p.processCode, "--form-values", JSON.stringify(p.formValues)];
			const approvers = personIds(r.people, "userId");
			if (approvers.length) args.push("--approvers", approvers.join(","));
			return { args };
		}
	}
	return err(`不支持的审批动作「${String(p.action)}」`);
}

/* ============================== 文件 / 钉盘域 ============================== */

export const FileParams = Type.Object({
	action: Action(["list", "search", "info", "upload", "download", "mkdir", "move", "rename", "delete", "spaces", "fetch"], "fetch=把消息里分享的钉盘/云盘链接镜像到本地"),
	node: Type.Optional(Type.String({ description: "文件/文件夹：名称、链接或 ID（info/download/move/rename/delete 用）" })),
	folder: Type.Optional(Type.String({ description: "所在文件夹：名称、链接或 ID（list/upload/mkdir 用；缺省=我的文件）" })),
	space: Type.Optional(Type.String({ description: "空间名称（缺省=我的文件；list/spaces 用）" })),
	name: Type.Optional(Type.String({ description: "（mkdir/rename）新名称" })),
	dest: Type.Optional(Type.String({ description: "（move）目标文件夹：名称或 ID" })),
	file: Type.Optional(Type.String({ description: "（upload）本地文件：工作目录内相对路径" })),
	out: Type.Optional(Type.String({ description: "（download）保存到工作目录内的相对路径" })),
	query: Type.Optional(Type.String({ description: "（search）关键词" })),
	link: Type.Optional(Type.String({ description: "（fetch）消息原文或分享链接" })),
	spaceId: Type.Optional(Type.String({ description: "（fetch）分享链接里的 spaceId（link 里已含时不用给）" })),
	nodeId: Type.Optional(Type.String({ description: "（fetch）分享链接里的 fileId（link 里已含时不用给）" })),
	limit: Type.Optional(Type.Number({ description: "（list/search）条数，默认 30" })),
	confirm: Type.Optional(Type.String({ description: "两阶段确认 token" })),
});
export type FileParamsT = Static<typeof FileParams>;

export function buildFile(p: FileParamsT, r: Resolved): Built {
	const limit = String(Math.min(p.limit ?? 30, 50));
	const node = r.ids?.node ?? p.node;
	const folder = r.ids?.folder ?? p.folder;
	switch (p.action) {
		case "list": {
			const args = ["drive", "+list", "--limit", limit];
			if (folder) args.push("--folder", folder);
			if (r.ids?.spaceId) args.push("--space-id", r.ids.spaceId);
			return { args };
		}
		case "search": {
			if (!p.query) return err("search 需要 query");
			return { args: ["drive", "+search", "--query", p.query, "--limit", limit] };
		}
		case "info": {
			if (!node) return err("info 需要 node（文件名/链接/ID）");
			const args = ["drive", "+inspect", "--node", node];
			if (r.ids?.spaceId) args.push("--space-id", r.ids.spaceId);
			return { args };
		}
		case "upload": {
			if (!p.file) return err("upload 需要 file（工作目录内相对路径）");
			const args = ["drive", "+upload", "--file", p.file];
			if (folder) args.push("--folder", folder);
			if (r.ids?.spaceId) args.push("--space-id", r.ids.spaceId);
			return { args };
		}
		case "download": {
			if (!node) return err("download 需要 node（文件名/链接/ID）");
			if (!p.out) return err("download 需要 out（保存到工作目录内的相对路径）");
			const args = ["drive", "+download", "--node", node, "--output", p.out];
			if (r.ids?.spaceId) args.push("--space-id", r.ids.spaceId);
			return { args };
		}
		case "mkdir": {
			if (!p.name) return err("mkdir 需要 name");
			const args = ["drive", "+create-folder", "--name", p.name];
			if (folder) args.push("--folder", folder);
			if (r.ids?.spaceId) args.push("--space-id", r.ids.spaceId);
			return { args };
		}
		case "move": {
			if (!node) return err("move 需要 node");
			if (!r.ids?.dest) return err("move 需要 dest（目标文件夹，插件没解析出唯一目标）");
			return { args: ["drive", "+move", "--node", node, "--folder", r.ids.dest] };
		}
		case "rename": {
			if (!node) return err("rename 需要 node");
			if (!p.name) return err("rename 需要 name");
			return { args: ["drive", "+rename", "--node", node, "--name", p.name] };
		}
		case "delete": {
			if (!node) return err("delete 需要 node");
			return { args: ["drive", "+delete", "--node", node], note: "文件会进回收站" };
		}
		case "spaces": {
			return { args: ["wiki", "space", "list", "--type", p.space === "知识库" ? "orgSpace" : "mySpace"] };
		}
	}
	return err(`不支持的文件动作「${String(p.action)}」`);
}

/* ============================== 文档 / 表格域 ============================== */

export const DocParams = Type.Object({
	action: Action(["read", "search", "create", "append", "replace", "wikiList", "sheetRead", "sheetWrite", "sheetAppend", "tableQuery", "tableAdd", "tableUpdate", "tableDelete"]),
	doc: Type.Optional(Type.String({ description: "文档/表格：标题、链接或节点 ID（read/append/replace/sheet* 用；只给标题时插件先搜索）" })),
	title: Type.Optional(Type.String({ description: "（create）新文档标题" })),
	content: Type.Optional(Type.String({ description: "（create/append/replace）正文（Markdown）" })),
	old: Type.Optional(Type.String({ description: "（replace）只替换掉这段原文，而不是整篇覆盖" })),
	query: Type.Optional(Type.String({ description: "（search/wikiList/tableQuery）关键词" })),
	workspace: Type.Optional(Type.String({ description: "知识库名称或 ID（wikiList 用）" })),
	sheetId: Type.Optional(Type.String({ description: "工作表 ID 或名称（sheet* 用；不给则由插件取第一个工作表）" })),
	range: Type.Optional(Type.String({ description: "（sheetRead/sheetWrite）区域，如 A1:C3" })),
	values: Type.Optional(
		Type.Array(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])), {
			description: "（sheetWrite/sheetAppend）二维数据，按行给；单元格里数字会自动按数字写",
		}),
	),
	base: Type.Optional(Type.String({ description: "多维表 base 名称或 ID（table* 用）" })),
	table: Type.Optional(Type.String({ description: "多维表里数据表名称或 ID（table* 用）" })),
	records: Type.Optional(
		Type.Array(
			Type.Object({
				recordId: Type.Optional(Type.String({ description: "（tableUpdate）要改哪条记录；新增时不填" })),
				cells: Type.Record(Type.String(), Type.Unknown(), { description: "字段名 → 值" }),
			}),
		),
	),
	recordIds: Type.Optional(Type.Array(Type.String(), { description: "（tableDelete）要删的记录 ID" })),
	limit: Type.Optional(Type.Number({ description: "返回条数，默认 20" })),
	confirm: Type.Optional(Type.String({ description: "两阶段确认 token" })),
});
export type DocParamsT = Static<typeof DocParams>;

export function buildDoc(p: DocParamsT, r: Resolved): Built {
	const doc = r.ids?.doc ?? p.doc;
	const limit = String(Math.min(p.limit ?? 20, 100));
	switch (p.action) {
		case "read": {
			if (!doc) return err("read 需要 doc（标题/链接/节点 ID）");
			return { args: ["doc", "+fetch", "--node", doc] };
		}
		case "search": {
			if (!p.query) return err("search 需要 query");
			return { args: ["doc", "+search", "--query", p.query, "--limit", limit] };
		}
		case "create": {
			if (!p.title) return err("create 需要 title");
			const args = ["doc", "+create", "--name", p.title];
			if (p.content) args.push("--content", p.content);
			if (r.ids?.workspace) args.push("--workspace", r.ids.workspace);
			return { args };
		}
		case "append":
		case "replace": {
			if (!doc) return err(`${p.action} 需要 doc（标题/链接/节点 ID）`);
			const args = ["doc", "+update", "--node", doc, "--command", p.action === "append" ? "append" : "overwrite"];
			if (p.old) {
				if (!p.content) return err("精确替换需要 content（替换成什么）");
				args[args.indexOf("--command") + 1] = "str_replace";
				args.push("--old", p.old, "--new", p.content);
				return { args };
			}
			if (!p.content) return err(`${p.action} 需要 content`);
			args.push("--content", p.content);
			return { args, note: p.action === "replace" ? "覆盖会丢掉原有内容，长文建议用 append 分次写" : undefined };
		}
		case "wikiList": {
			if (!r.ids?.workspace) return err("wikiList 需要 workspace（知识库名称或 ID）");
			const args = ["wiki", "+node-list", "--workspace", r.ids.workspace, "--limit", limit];
			if (p.query) args.push("--query", p.query);
			return { args };
		}
		case "sheetRead": {
			if (!doc) return err("sheetRead 需要 doc（表格：标题/链接/节点 ID）");
			const args = ["sheet", "csv-get", "--node", doc];
			if (p.sheetId) args.push("--sheet-id", p.sheetId);
			if (p.range) args.push("--range", p.range);
			return { args };
		}
		case "sheetWrite": {
			if (!doc || !p.sheetId || !p.range) return err("sheetWrite 需要 doc + sheetId + range");
			if (!p.values?.length) return err("sheetWrite 需要 values（二维数据）");
			return {
				args: ["sheet", "range", "update", "--node", doc, "--sheet-id", p.sheetId, "--range", p.range, "--values", toCells(p.values as Array<Array<string | number | null>>)],
				note: "会覆盖目标区域内已有内容",
			};
		}
		case "sheetAppend": {
			if (!doc || !p.sheetId) return err("sheetAppend 需要 doc + sheetId");
			if (!p.values?.length) return err("sheetAppend 需要 values（二维数据）");
			return { args: ["sheet", "append", "--node", doc, "--sheet-id", p.sheetId, "--values", toCells(p.values as Array<Array<string | number | null>>)] };
		}
		case "tableQuery": {
			if (!r.ids?.baseId || !r.ids?.tableId) return err("tableQuery 需要 base + table（插件没解析出唯一的多维表）");
			const args = ["aitable", "+record-query", "--base-id", r.ids.baseId, "--table-id", r.ids.tableId, "--limit", limit];
			if (p.query) args.push("--query", p.query);
			return { args };
		}
		case "tableAdd":
		case "tableUpdate": {
			if (!r.ids?.baseId || !r.ids?.tableId) return err(`${p.action} 需要 base + table`);
			if (!p.records?.length) return err(`${p.action} 需要 records（cells 的 key 是字段名）`);
			const records = JSON.stringify(p.records.map((x) => (x.recordId ? { recordId: x.recordId, cells: x.cells } : { cells: x.cells })));
			const prefix = p.action === "tableAdd" ? ["aitable", "record", "create"] : ["aitable", "+record-update"];
			return { args: [...prefix, "--base-id", r.ids.baseId, "--table-id", r.ids.tableId, "--records", records] };
		}
		case "tableDelete": {
			if (!r.ids?.baseId || !r.ids?.tableId) return err("tableDelete 需要 base + table");
			if (!p.recordIds?.length) return err("tableDelete 需要 recordIds");
			return { args: ["aitable", "+record-delete", "--base-id", r.ids.baseId, "--table-id", r.ids.tableId, "--record-ids", p.recordIds.join(",")], note: "删除记录不可逆" };
		}
	}
	return err(`不支持的文档动作「${String(p.action)}」`);
}

