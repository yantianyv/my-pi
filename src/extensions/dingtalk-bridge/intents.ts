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

/** create-with-data 的 --values：原始二维 JSON；超安全整数的长整数按文本写（防精度丢失，浮点保持数字） */
export function toSheetValues(values: Array<Array<string | number | boolean | null>>): string {
	return JSON.stringify(
		values.map((row) => row.map((v) => (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v) ? String(v) : v))),
	);
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
	action: Action(["send", "sendGroup", "broadcast", "reply", "forward", "dingByMessage", "ding", "recall", "sendStatus", "read", "createGroup"], "dingByMessage=把某条已有消息转成 DING；ding=直接发一条新 DING。read=按会话/关键词查消息，createGroup=建群"),
	to: Type.Optional(Type.Array(Type.String(), { description: "收件人：姓名或 ID（send/broadcast/ding/dingByMessage 用）" })),
	name: Type.Optional(Type.String({ description: "（createGroup）群名称" })),
	members: Type.Optional(Type.Array(Type.String(), { description: "（createGroup）初始成员（群主自动入群）" })),
	owner: Type.Optional(Type.String({ description: "（createGroup）群主；缺省为发起人" })),
	group: Type.Optional(Type.String({ description: "目标会话：群名或会话 ID（sendGroup 用）" })),
	content: Type.Optional(Type.String({ description: "正文（Markdown）" })),
	vars: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Record(Type.String(), Type.String())]), {
			description: "（broadcast）正文 {{变量}} 的每人取值：{收件人: 值} 或 {收件人: {变量: 值}}",
		}),
	),
	file: Type.Optional(Type.String({ description: "要发的文件：工作目录内相对路径（与 content 互斥）" })),
	inGroup: Type.Optional(Type.String({ description: "（reply/forward/dingByMessage/recall）消息所在会话：群名、会话 ID 或对方姓名" })),
	destGroup: Type.Optional(Type.String({ description: "（forward）目标：群名、会话 ID 或对方姓名" })),
	messageId: Type.Optional(Type.String({ description: "（reply/forward/dingByMessage/recall）消息 ID；不知道则用 keyword+sender" })),
	keyword: Type.Optional(Type.String({ description: "（read）按关键词找消息" })),
	sender: Type.Optional(Type.String({ description: "找消息的发送人：姓名、me、对方姓名，默认 me" })),
	days: Type.Optional(Type.Number({ description: "找消息：最近 N 天，默认 7" })),
	limit: Type.Optional(Type.Number({ description: "（read）条数，默认 20" })),
	outDir: Type.Optional(Type.String({ description: `（read）附件保存目录（工作目录内），默认 ${MEDIA_OUT_DIR}` })),
	downloadResources: Type.Optional(Type.Boolean({ description: "（read）是否下载附件，默认 true" })),
	dingType: Type.Optional(Type.String({ description: "（ding/dingByMessage）应用内（默认）/短信/电话，后两者收费" })),
	taskId: Type.Optional(Type.String({ description: "（sendStatus）任务 ID" })),
});
export type MessageParamsT = Static<typeof MessageParams>;

export const TodoParams = Type.Object({
	action: Action(["list", "create", "update", "complete", "delete", "search"]),
	title: Type.Optional(Type.String({ description: "（create/update）标题" })),
	taskId: Type.Optional(Type.String({ description: "（update/complete/delete）待办 ID" })),
	executors: Type.Optional(Type.Array(Type.String(), { description: "（create/update）执行人：姓名或 userId；默认给发起人自己" })),
	participants: Type.Optional(Type.Array(Type.String(), { description: "（create）参与人：姓名或 ID（只关注不完成）" })),
	due: Type.Optional(Type.String({ description: "（create/update）截止时间：如「2026-10-08 15:00」「明天 09:30」" })),
	priority: Type.Optional(Type.String({ description: "（create/update）优先级：低/普通/较高/紧急" })),
	keyword: Type.Optional(Type.String({ description: "（list/search）按标题关键词筛：list 带 keyword 时改走服务端搜索" })),
	includeDone: Type.Optional(Type.Boolean({ description: "（list）是否连已完成的一起列，默认 false" })),
});
export type TodoParamsT = Static<typeof TodoParams>;

export const CalendarParams = Type.Object({
	action: Action(["list", "create", "update", "cancel", "detail", "invite", "rooms"]),
	eventId: Type.Optional(Type.String({ description: "（update/cancel/detail/invite）日程 ID" })),
	title: Type.Optional(Type.String({ description: "（create/update）日程主题" })),
	start: Type.Optional(Type.String({ description: "开始时间：如「明天 09:30」「15:00」" })),
	end: Type.Optional(Type.String({ description: "结束时间（写法同 start）" })),
	attendees: Type.Optional(Type.Array(Type.String(), { description: "参会人：姓名或 ID" })),
	location: Type.Optional(Type.String({ description: "地点（纯文字，订会议室用 rooms）" })),
	desc: Type.Optional(Type.String({ description: "日程描述/议程" })),
	rooms: Type.Optional(Type.Array(Type.String(), { description: "（create/invite）会议室名称（插件自取空房 ID）" })),
	remindMinutes: Type.Optional(Type.Number({ description: "提前几分钟提醒，默认 15" })),
});
export type CalendarParamsT = Static<typeof CalendarParams>;

export const hasCJK = (s: string): boolean => /[㐀-鿿豈-﫿]/.test(s);

/* ============================== 标识符兼容层 ==============================
 * 钉钉同一个「对象」有多种标识写法，上游各接口只认其中一种，且报错格式互不相同：
 *   · 人：userId（数字）· openDingTalkId（base64）· 姓名 · 手机号 · 自指词
 *   · 会话：openConversationId（cid…）· 群名
 *   · 其它：PROC- 模板 code · 15~22 位审批编号 · 钉盘 nodeId / docId
 * 判定散在各处时，「哪种写法算 ID」会被各自重新定义一遍，出问题的地方也就各不相同。
 * 这里收拢为一处：调用方只声明「我需要什么」，形态判定与后续反查都走这张表。
 */

/** 标识符形态 —— 判定只看写法，不问存在性 */
export type IdKind = "self" | "conversation" | "openId" | "userId" | "mobile" | "processCode" | "opaque" | "name";

/** 各形态的写法特征（顺序即优先级：先窄后宽，避免 cid 被宽规则先吞掉） */
const ID_PATTERNS: Array<[IdKind, RegExp]> = [
	["self", /^(我|自己|本人|me|myself|self)$/i],
	["conversation", /^cid[A-Za-z0-9+/_-]+=*$/],
	["processCode", /^PROC-[0-9A-Za-z-]+$/],
	// 手机号：通讯录反查用（写法与其他形态不重叠）
	["mobile", /^1[3-9]\d{9}$/],
	// userId：钉钉账号 ID 都是纯数字
	["userId", /^\d{6,25}$/],
	// openDingTalkId：base64 串，必然含大写或 = 填充（只由小写字母数字组成时归 opaque）
	["openId", /^[A-Za-z0-9_-]{20,}={0,2}$/],
];

/**
 * 判定一个 token 的形态。
 * 未命中具体形态时：无中文且够长 → opaque（可能是 nodeId/docId 这类只在本接口有意义的值）；
 * 否则当姓名。故意不收 `.`：文档标题常是纯 ASCII 带点（`report.docx`），
 * 当成 ID 直发就不会去搜索了。
 *
 * 审批编号（businessId，21 位）不在表里：它与人 userId（18~19 位）的写法完全一样，
 * 只看字符串分不出来，只能按「这个参数位置收的是什么」判断。
 */
export function idKindOf(token: string): IdKind {
	const t = token.trim();
	if (!t) return "name";
	for (const [kind, re] of ID_PATTERNS) {
		if (!re.test(t)) continue;
		// openId 要求含大写或 = 填充，纯小写长串留给 opaque
		if (kind === "openId" && !/[A-Z]|=/.test(t)) continue;
		return kind;
	}
	if (!hasCJK(t) && /^[0-9A-Za-z_+\-=/]{6,}$/.test(t)) return "opaque";
	return "name";
}

/**
 * 是否已是稳定标识（不必再去搜索解析）。
 * 自指词（我/本人）虽然也不是姓名，但要走 contact +me 解析，不算。
 */
export const isStableId = (token: string): boolean => {
	const k = idKindOf(token);
	return k !== "name" && k !== "self";
};

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
	/** 人能认出的操作对象名（多维表/数据表/工作表等，审核文案的主角行用） */
	objects?: string[];
	/** 已按 formSchema 校验并序列化的表单值（create/forecast 用这份而不是原始输入） */
	formValues?: Record<string, string>;
	/** 已上传到审批钉盘的表单附件（create/forecast 的 attachments 参数） */
	attachments?: AttachmentRef[];
}

export type Built = { args: string[]; note?: string } | { error: string };
const err = (msg: string): Built => ({ error: msg });

const personIds = (people: ResolvedPerson[] | undefined, kind: "userId" | "openId"): string[] =>
	(people ?? []).map((p) => (kind === "openId" ? p.openId ?? "" : p.userId)).filter(Boolean);

/**
 * 单人收件人参数：不同接口认不同写法，映射固定在这里，不在构建函数里各猜一遍。
 * · --chat-id          会话 ID（单聊/群会话都能直发）
 * · --open-dingtalk-id openDingTalkId
 * · --user             userId
 * 把 userId 塞进 --open-dingtalk-id 会被上游按格式拒掉（这是「按提示换成 ID 反而失败」的根源）。
 */
export function recipientFlag(
	person: ResolvedPerson | undefined,
): { flag: "--user" | "--open-dingtalk-id" | "--chat-id"; value: string } | null {
	if (!person) return null;
	// 优先按用户实际给的那串的形态来：他给什么就按什么发，不必反查成另一种
	const given = idKindOf(person.token);
	if (given === "conversation") return { flag: "--chat-id", value: person.token };
	if (given === "openId") return { flag: "--open-dingtalk-id", value: person.token };
	if (given === "userId") return { flag: "--user", value: person.token };
	// 给的是姓名/手机号：用解析出来的标识，userId 优先（兼容面最广）
	if (person.userId && idKindOf(person.userId) === "userId") return { flag: "--user", value: person.userId };
	if (person.openId) return { flag: "--open-dingtalk-id", value: person.openId };
	return null;
}

/** DING 的两个动作共用：收件人只认 openDingTalkId，提醒方式转 --type。 */
function dingTargets(people: ResolvedPerson[] | undefined, type: string | undefined): { users: string; type: string[] } | { error: string } {
	const ids = personIds(people, "openId");
	if (!ids.length) return { error: "收件人没有 openDingTalkId：DING 只收这个 ID，请给姓名或账号让插件解析" };
	const extra: string[] = [];
	if (type) {
		const t = dingTypeCode(type);
		if (typeof t !== "string") return { error: t.error };
		extra.push("--type", t);
	}
	return { users: ids.join(","), type: extra };
}

/* ============================== 消息域 ============================== */

export function buildMessage(p: MessageParamsT, r: Resolved): Built {
	const content = p.content?.trim() ?? "";
	const people = r.people ?? [];
	switch (p.action) {
		case "send": {
			if (!people.length) return err("send 需要 to（收件人姓名或账号）");
			if (!content && !p.file) return err("send 需要 content 或 file");
			if (p.file) {
				// 文件消息只要 userId：管线自己会把 userId 换成 openDingTalkId（--open-dingtalk-id 也能用，
				// 但按 ID 解析出来的收件人本来就没有 openId，强制要求它等于把「按面板挑定 ID 再重调」这条路堵死）
				// 文件消息只有一个收件人：多人时不能静默只发给第一个
				if (people.length > 1) return err(`发文件一次只能给一个人（本次给了 ${people.map((x) => x.name ?? x.token).join("、")}）——每人单独发一次，或改用钉盘分享链接`);
				const who = people[0]!;
				const one = recipientFlag(who);
				if (!one) return err(`没解析出「${who.token}」的账号 ID，无法发文件——请确认这个人还在通讯录里`);
				return { args: ["chat", "+messages-send", "--as", "user", one.flag, one.value, "--file", p.file, "--ai-tag"], note: `文件消息：本条不含说明正文，说明文字要另发一条` };
			}
			// 单人也走 +messages-send：+dm 的 --to 只认 userId，而收件人常常是 openDingTalkId（客服/外部账号），
			// +messages-send 两种形态都能接，参数由 recipientFlag 按 token 形态挑
			if (people.length === 1) {
				const one = recipientFlag(people[0]);
				if (!one) return err(`没解析出「${people[0]!.token}」可用的收件人标识`);
				return { args: ["chat", "+messages-send", "--as", "user", one.flag, one.value, "--markdown", content, "--ai-tag"] };
			}
			return { args: ["chat", "+broadcast", "--to", people.map((x) => x.token).join(","), "--content", content, "--ai-tag"], note: "多人单聊：按姓名群发，发送前会预检收件人" };
		}
		case "sendGroup": {
			if (!r.group) return err("sendGroup 需要 group（群名或会话 ID）");
			if (!content && !p.file) return err("sendGroup 需要 content 或 file");
			if (p.file) return { args: ["chat", "+messages-send", "--as", "user", "--group", r.group.cid, "--file", p.file, "--ai-tag"], note: "文件消息：本条不含说明正文" };
			return { args: ["chat", "+send-to-group", "--group", r.group.cid, "--content", content, "--ai-tag"] };
		}
		case "createGroup": {
			const name = p.name?.trim();
			if (!name) return err("createGroup 需要 name（群名称）");
			const userIds = personIds(people, "userId");
			if (!userIds.length) return err("createGroup 需要 members（初始成员的姓名或账号 ID）");
			const args = ["chat", "+chat-create", "--name", name, "--users", userIds.join(",")];
			if (r.ids?.ownerOpenId) args.push("--owner-open-dingtalk-id", r.ids.ownerOpenId);
			return { args, note: "成员会收到入群通知" };
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
		case "dingByMessage": {
			// 消息转 DING：提醒指向一条已存在的消息，收件人看得到原文
			if (!r.message) return err("dingByMessage 需要 inGroup + messageId（或 keyword 让插件先找消息）");
			// 单聊的消息，收件人已由解析层补成对话对方；仍缺才说明必须指定
			const d = dingTargets(people, p.dingType);
			if ("error" in d) return err(d.error);
			return {
				args: ["ding", "message", "send-by-message", "--group", r.message.conversationId, "--message-id", r.message.msgId, "--users", d.users, ...d.type],
				note: "提醒指向原消息；短信/电话类型有费用",
			};
		}
		case "ding": {
			// 发送 DING：一条独立的新提醒，不引用任何消息
			if (!content) return err("ding 需要 content（DING 正文）");
			const d = dingTargets(people, p.dingType);
			if ("error" in d) return err(d.error);
			return {
				args: ["ding", "message", "send-personal", "--users", d.users, "--content", content, ...d.type],
				note: "独立新提醒，不引用消息；短信/电话类型有费用",
			};
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
			if (p.keyword) return { args: ["todo", "+search", "--query", p.keyword, "--status", p.includeDone ? "true" : "false"] };
			return { args: ["todo", "task", "list", "--size", "50", "--status", p.includeDone ? "true" : "false"] };
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
			return { args };
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

/**
 * 审批单跳转链接：pcLink/mobileLink 分别对应桌面与手机端。
 * 实测：缺 dd_progress/back/swfrom/dtaction 会退到 OA 主页而不是单据页，这些参数不能省。
 * taskId 留空——流程推进后旧节点失效，留空则链接长期有效。
 */
export function approvalCardLink(corpId: string, instanceId: string): string {
	// 实测：dd_share/showmenu/dd_progress/swfrom/taskId 可省；dtaction 电脑端必需；
	// back=native 保证返回体验；#/approval 与 #approval 缺了会进 OA 主页
	const q = (host: string, tail: string) =>
		`https://aflow.dingtalk.com/dingtalk/${host}?` +
		`corpid=${corpId}&procInstId=${encodeURIComponent(instanceId)}&dinghash=approval&dtaction=os&back=native${tail}`;
	return `dingtalk://dingtalkclient/action/open_platform_link?pcLink=${encodeURIComponent(q("pc/query/pchomepage.htm", "#/approval"))}&mobileLink=${encodeURIComponent(q("mobile/homepage.htm", "#approval"))}`;
}

/* ============================== 审批域 ============================== */

export const ApprovalParams = Type.Object({
	action: Action(["listPending", "listSubmitted", "detail", "approve", "reject", "transfer", "revoke", "forms", "formSchema", "forecast", "create"], "approve/reject/transfer 只需给 instanceId，任务 ID 由插件自动查"),
	instanceId: Type.Optional(Type.String({ description: "审批实例 ID 或审批编号（纯数字）；给审批编号时插件先反查实例 ID" })),
	keyword: Type.Optional(Type.String({ description: "找审批关键词（forms=找模板；list*/forecast=定位单据；create=按模板名定模板）" })),
	to: Type.Optional(Type.String({ description: "（transfer）转交给谁：姓名或 ID" })),
	remark: Type.Optional(Type.String({ description: "（approve/reject/transfer/revoke）审批意见" })),
	processCode: Type.Optional(Type.String({ description: "审批模板 code（可用模板名代替，插件自动查）；配 forms/formSchema/forecast/create 使用" })),
	formValues: Type.Optional(
		Type.Record(
			Type.String(),
			Type.Union([
				Type.String(),
				Type.Number(),
				Type.Boolean(),
				// 明细表（TableField）通过数组按行给，插件序列化成上游要的 JSON 字符串
				Type.Array(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])), {
					description: "明细表的逐行数据（每项是 {列名: 值}）",
				}),
			]),
			{ description: "（forecast/create）表单字段 {字段名: 值}；明细表给数组（每项是 {列名: 值}），字段名照 formSchema 给出的清单" },
		),
	),
	approvers: Type.Optional(Type.Array(Type.String(), { description: "（create）审批人：姓名或 ID" })),
	attachments: Type.Optional(
		Type.Array(
			Type.Union([
				// 新文件：本地路径，插件先上传
				Type.String(),
				// 已上传过的：直接写回表单，不再传一份（重提/改金额/重试场景靠这个避开 (1)(2) 累积）
				Type.Object({
					fileId: Type.String({ description: "上传接口返回的 fileId" }),
					fileName: Type.Optional(Type.String({ description: "文件名；缺省按 fileId 写" })),
					fileSize: Type.Optional(Type.Number()),
					fileType: Type.Optional(Type.String()),
					spaceId: Type.Optional(Type.String({ description: "缺省用 450684510（审批附件空间）" })),
				}),
			]),
			{
				description: "（create/forecast）表单附件：给本地路径（插件上传）或已上传的附件对象 {fileId, fileName, fileSize, fileType, spaceId}（直接写入、不重传）",
			},
		),
	),
	days: Type.Optional(Type.Number({ description: "（listPending）回看天数，默认 30" })),
	limit: Type.Optional(Type.Number({ description: "返回条数，默认 20；我发起的列表上游单页硬上限 20，超过会直接报错需自行分页" })),
	page: Type.Optional(Type.Number({ description: "（listPending/listSubmitted）页码，默认 1" })),
});
export type ApprovalParamsT = Static<typeof ApprovalParams>;

/** 摘要里有没有明细表痕迹（数量/单价/名称这类列名）：有就说明这单可能多行，而摘要只给了第一行 */
/**
 * 带非空明细表值的字段标签。上游对这类提交只回「系统错误」（不解明细内容），
 * 所以发起前就要拦下，别白传附件。
 */
export function filledTableLabels(fields: SchemaField[], values: FormInput): string[] {
	return fields
		.filter((f) => f.componentName === "TableField" && Array.isArray(values[f.label]) && (values[f.label] as unknown[]).length > 0)
		.map((f) => f.label);
}

export function hasDetailColumns(formMassage: string): boolean {
	return /(?:^|<br\s*\/?>)\s*(?:数量|单价|名称)\s*[:：]/i.test(formMassage);
}

export function buildApproval(p: ApprovalParamsT, r: Resolved): Built {
	const limit = String(Math.min(p.limit ?? 20, 100));
	const page = String(Math.max(1, p.page ?? 1));
	const instanceId = r.ids?.instanceId ?? p.instanceId;
	switch (p.action) {
		case "listPending": {
			const now = r.ids?.now ? new Date(r.ids.now) : new Date();
			const days = Math.max(1, Math.min(p.days ?? 30, 365));
			const start = new Date(now.getTime() - days * 86_400_000);
			const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
			const args = ["oa", "approval", "list-pending", "--start", `${fmt(start)}T00:00:00${DEFAULT_OFFSET}`, "--end", `${fmt(now)}T23:59:59${DEFAULT_OFFSET}`, "--limit", limit, "--page", page];
			if (p.keyword) args.push("--query", p.keyword);
			return { args };
		}
		case "listSubmitted": {
			const args = ["oa", "approval", "list-submitted", "--limit", limit, "--page", page];
			if (p.keyword) args.push("--query", p.keyword);
			return { args };
		}
		case "detail": {
			if (!instanceId) return err("detail 需要 instanceId（审批实例 ID 或审批编号）");
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
			// 模板 code 可写模板名（resolve 阶段已换成 code）；给了 code 就返回字段清单
			if (p.processCode) return { args: ["oa", "approval", "form-schema", "--process-code", p.processCode] };
			return p.keyword ? { args: ["oa", "+search-forms", "--query", p.keyword] } : { args: ["oa", "+list-forms"] };
		}
		case "formSchema": {
			if (!p.processCode) return err("formSchema 需要 processCode 或模板名（先用 action=forms 查模板）");
			return { args: ["oa", "approval", "form-schema", "--process-code", p.processCode] };
		}
		case "forecast": {
			if (!p.processCode) return err("forecast 需要 processCode 或模板名");
			const args = ["oa", "approval", "forecast-process", "--process-code", p.processCode, "--dept-id", "-1"];
			if (p.formValues && Object.keys(p.formValues).length) args.push("--form-values", JSON.stringify(r.formValues ?? p.formValues));
			return { args };
		}
		case "create": {
			if (!p.processCode) return err("create 需要 processCode 或模板名（先用 action=forms 查模板）");
			if (!p.formValues || !Object.keys(p.formValues).length) return err("create 需要 formValues（模板字段与值，字段名照 formSchema 给出的清单）");
			const args = ["oa", "approval", "create-instance", "--process-code", p.processCode, "--form-values", JSON.stringify(r.formValues ?? p.formValues)];
			const approvers = personIds(r.people, "userId");
			if (approvers.length) args.push("--approvers", approvers.join(","));
			return { args };
		}
	}
	return err(`不支持的审批动作「${String(p.action)}」`);
}

/* ============================== 表单字段组装（发起审批） ============================== */

/** form-schema 的 content 解出来的一层控件；children 只出现在明细表里 */
export interface SchemaField {
	componentName: string;
	label: string;
	required: boolean;
	placeholder?: string;
	disabled?: boolean;
	options?: string[];
	children?: SchemaField[];
}

/** 把 form-schema 的 content（JSON 字符串）解成控件树；解不开返回 null（调用方降级为不校验） */
export function parseFormSchema(content: unknown): SchemaField[] | null {
	const walk = (items: unknown): SchemaField[] | null => {
		if (!Array.isArray(items)) return null;
		const out: SchemaField[] = [];
		for (const raw of items) {
			if (typeof raw !== "object" || raw === null) continue;
			const item = raw as Record<string, unknown>;
			const props = (typeof item.props === "object" && item.props !== null ? item.props : {}) as Record<string, unknown>;
			const name = String(item.componentName ?? props.componentName ?? "");
			const label = String(props.label ?? "");
			// TextNote 是说明文字，不收值
			if (!label || name === "TextNote") continue;
			const options = Array.isArray(props.options)
				? props.options.map((o) => (typeof o === "string" ? o : String((o as Record<string, unknown>).value ?? (o as Record<string, unknown>).label ?? ""))).filter(Boolean)
				: undefined;
			out.push({
				componentName: name,
				label,
				required: props.required === true,
				...(props.placeholder ? { placeholder: String(props.placeholder) } : {}),
				...(props.disabled === true ? { disabled: true } : {}),
				...(options?.length ? { options } : {}),
				...(Array.isArray(item.children) ? { children: walk(item.children) ?? [] } : {}),
			});
		}
		return out;
	};
	try {
		const root = JSON.parse(typeof content === "string" ? content : JSON.stringify(content)) as unknown;
		// 模板根对象是 { title, items: [...] }；也容忍直接给控件数组
		const items = Array.isArray(root) ? root : (root as Record<string, unknown> | null)?.items;
		return walk(items);
	} catch {
		return null;
	}
}

/** 能自动算的字段：公式列（填了也不被接受）与只读列 */
const isDerived = (f: SchemaField): boolean => f.componentName === "CalculateField" || f.disabled === true;
/** 需要非文本值的控件：这里只做到「能识别并说清楚」，不伪装支持 */
const UNSUPPORTED = new Set(["DDPhotoField", "DDMultiSelectField", "AddressField", "DDDeptField", "DDDateField", "DDDateRangeField", "MoneyField"]);

/** 上传到审批钉盘后的附件引用（attachment upload 的返回，与表单 DDAttachment 的 value 结构一致） */
export interface AttachmentRef {
	fileId: string;
	fileName: string;
	fileSize?: number;
	fileType?: string;
	spaceId: string;
}

/** 审批附件所在的钉盘空间（上传接口固定回这个值；已知可省略） */
export const APPROVAL_SPACE_ID = "450684510";

/** attachments 参数的两种形态：本地路径（要上传）或已上传对象（直接写） */
export type AttachmentInput = string | { fileId: string; fileName?: string; fileSize?: number; fileType?: string; spaceId?: string };

/** 已上传对象 → 附件引用（补默认 spaceId 与文件名） */
export function asAttachmentRef(input: Exclude<AttachmentInput, string>): AttachmentRef {
	return {
		fileId: input.fileId,
		fileName: input.fileName || `attachment-${input.fileId}`,
		spaceId: input.spaceId || APPROVAL_SPACE_ID,
		...(input.fileSize !== undefined ? { fileSize: input.fileSize } : {}),
		...(input.fileType ? { fileType: input.fileType } : {}),
	};
}

/**
 * 附件控件的值：数组 → JSON 字符串（上游就吃这个形状）。
 * spaceId 统一成字符串：上传接口回的是数字，而同一类控件在 detail 里存的是字符串，
 * 两边混着来最容易在后续比对/重写时出问题。
 */
export function attachmentValue(refs: AttachmentRef[]): string {
	return JSON.stringify(
		refs.map((r) => ({
			spaceId: String(r.spaceId),
			fileName: r.fileName,
			...(r.fileSize !== undefined ? { fileSize: r.fileSize } : {}),
			...(r.fileType ? { fileType: r.fileType } : {}),
			fileId: String(r.fileId),
		})),
	);
}

/** 表单输入：文本/数字/布尔，或明细表的逐行对象 */
export type FormInput = Record<string, string | number | boolean | Array<Record<string, string | number | boolean>>>;

export interface ComposedForm {
	values: Record<string, string>;
	/** 已补齐、已按控件类型序列化的字段名 */
	filled: string[];
	/** 用户没给值、也不是自动列的字段（必填时由调用方拦下） */
	missing: SchemaField[];
	/** 用户给了值、但不是这个模板的字段（通常是记错了列名） */
	unknown: string[];
	errors: string[];
}

/**
 * 表单值 → create-instance 的 --form-values。
 * dws 简单模式只收「字段名 → 字符串」，所以这里做四件事：
 *   1. 明细表（TableField）从数组序列化成 JSON 字符串（上游就是吃字符串，不是数组）；
 *   2. 公式/只读列自动剔掉（合计金额之类由钉钉自己算，填了反而被拒）；
 *   3. 附件控件由 attachments 参数指定的文件填（一份还是多份由模板定，不从字段里猜）；
 *   4. 名字对不上的字段、选项不属于本模板的字段都在发起前说出来。
 */
export function composeFormValues(
	fields: SchemaField[],
	input: FormInput,
	attachments?: AttachmentRef[],
): ComposedForm {
	const byLabel = new Map(fields.map((f) => [f.label, f]));
	const values: Record<string, string> = {};
	const filled: string[] = [];
	const unknown: string[] = [];
	const errors: string[] = [];
	const used = new Set<string>();
	for (const [name, raw] of Object.entries(input)) {
		const field = byLabel.get(name);
		if (!field) {
			unknown.push(name);
			continue;
		}
		used.add(name);
		if (isDerived(field)) continue;
		if (Array.isArray(raw)) {
			const rows = raw as Array<Record<string, unknown>>;
			const cols = field.children ?? [];
			const colByLabel = new Map(cols.filter((c) => !isDerived(c)).map((c) => [c.label, c]));
			const clean = rows.map((row, i) => {
				const out: Record<string, string> = {};
				for (const [k, v] of Object.entries(row)) {
					const col = colByLabel.get(k);
					if (!col) {
						errors.push(`明细第 ${i + 1} 行没有「${k}」这一列（本模板的列：${[...colByLabel.keys()].join("、")}）`);
						continue;
					}
					out[k] = String(v);
				}
				return out;
			});
			values[name] = JSON.stringify(clean);
			filled.push(name);
			continue;
		}
		if (field.componentName === "TableField") {
			errors.push(`「${name}」是明细表，要按行给数组：[{${(field.children ?? []).filter((c) => !isDerived(c)).map((c) => `${c.label}: "…"`).join(", ")}}]`);
			continue;
		}
		const text = String(raw);
		if (field.options?.length && !field.options.includes(text)) {
			errors.push(`「${name}」只能是：${field.options.join("、")}（给的是「${text}」）`);
			continue;
		}
		values[name] = text;
		filled.push(name);
	}
	// 附件：参数给的是本地路径（已上传成引用了），落到模板里的附件控件。
	// 模板有就自己填（用户不必知道控件叫什么）；模板没有则说明这份模板不收附件
	const attachFields = fields.filter((f) => f.componentName === "DDAttachment");
	if (attachments?.length) {
		if (!attachFields.length) {
			errors.push("这份模板没有附件控件：attachments 无处可放（去掉 attachments 或换带附件的模板）");
		} else {
			// 多个附件控件时填第一个；其余留空（多数模板只有一个）
			const target = attachFields[0]!;
			values[target.label] = attachmentValue(attachments);
			filled.push(target.label);
			used.add(target.label);
		}
	}
	const missing = fields.filter((f) => !used.has(f.label) && !isDerived(f));
	return { values, filled, missing, unknown, errors };
}

/** 明细表里的自动列（预估金额之类）与明细组控件备注一下，供面板/回执展示 */
export function describeFormFields(fields: SchemaField[]): string[] {
	return fields.map((f) => {
		const tags = [
			f.required ? "必填" : "",
			isDerived(f) ? (f.componentName === "CalculateField" ? "自动计算（不用填）" : "只读") : "",
			f.componentName === "DDAttachment" ? "附件（用 attachments 传本地路径）" : "",
			UNSUPPORTED.has(f.componentName) && !f.children ? `${f.componentName}（AI 无法填写）` : "",
		].filter(Boolean);
		const head = `· ${f.label}${tags.length ? `（${tags.join("；")}）` : ""}`;
		if (!f.children?.length) return head + (f.options?.length ? ` 可选：${f.options.join("、")}` : "");
		const cols = f.children.filter((c) => !isDerived(c)).map((c) => c.label + (c.required ? "*" : ""));
		return `${head} 按行给数组，列：${cols.join("、")}`;
	});
}

/**
 * forecast-process 的返回 → 人话结论。
 *
 * 上游的两个字段各自独立，组合起来有三种意思，调用方无法直接分辨：
 *   · forecastSuccess=false + staticWorkflow=true  → 静态流程本来就不预测（实测：表单值完全合法时也是 false）
 *   · forecastSuccess=false + staticWorkflow=false → 真·预测失败（上游报错，不是参数错）
 *   · forecastSuccess=true  + 某节点 targetSelect=true → 需要选人，否则发起时会卡在自选节点
 * 所以不能只看 forecastSuccess。
 */
export interface ForecastReading {
	/** ok=可继续；needsActioners=有节点需选人；failed=真预测失败 */
	kind: "ok" | "needsActioners" | "failed";
	/** 一句话结论（直接给模型/用户看） */
	summary: string;
	/** 需选人的节点（kind=needsActioners 时非空） */
	selects: Array<{ activityId: string; name: string; actorType: string; actorKey: string }>;
	/** 已固定的审批路径（节点名，按返回顺序） */
	path: string[];
}

export function readForecast(data: unknown): ForecastReading {
	const root = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
	const body = (root.result && typeof root.result === "object" ? root.result : root) as Record<string, unknown>;
	const success = body.forecastSuccess === true;
	const isStatic = body.staticWorkflow === true;
	const rules = Array.isArray(body.workflowActivityRuleVOs) ? (body.workflowActivityRuleVOs as Array<Record<string, unknown>>) : [];
	const path = rules.map((r) => String(r.activityName ?? r.activityId ?? "")).filter(Boolean);
	const selects: ForecastReading["selects"] = [];
	for (const r of rules) {
		if (r.targetSelect !== true) continue;
		const actor = (r.workflowActor && typeof r.workflowActor === "object" ? r.workflowActor : {}) as Record<string, unknown>;
		selects.push({
			activityId: String(r.activityId ?? ""),
			name: String(r.activityName ?? r.activityId ?? ""),
			actorType: String(actor.actorType ?? "approver"),
			actorKey: String(actor.actorKey ?? ""),
		});
	}
	if (!success && !isStatic) {
		return {
			kind: "failed",
			summary: "流程预测失败（上游未返回预测结果，且不是静态流程）。用 formSchema 核对字段名与必填项，再试；发起本身不受影响。",
			selects: [],
			path,
		};
	}
	if (selects.length) {
		const label = (s: (typeof selects)[number]) => `${s.actorType === "notifier" ? "抄送" : "审批"}节点「${s.name}」`;
		return {
			kind: "needsActioners",
			summary: `流程预演：${selects.length} 个节点要手动选人（${selects.map(label).join("、")}）。不选就发起会卡在这些节点上。`,
			selects,
			path,
		};
	}
	const pathNote = path.length ? `路径：${path.join(" → ")}` : "";
	const staticNote = isStatic ? "静态流程：审批人由模板固定，无需选人" : "动态流程：本次表单值未触发自选节点";
	return { kind: "ok", summary: `流程预演：${staticNote}${pathNote ? `；${pathNote}` : ""}。`, selects: [], path };
}

/* ============================== 文件 / 钉盘域 ============================== */

export const FileParams = Type.Object({
	action: Action(["list", "search", "info", "upload", "download", "mkdir", "move", "rename", "delete", "spaces", "fetch"], "fetch=把消息里分享的钉盘/云盘链接镜像到本地"),
	node: Type.Optional(Type.String({ description: "文件/文件夹：名称、链接或 ID（info/download/move/rename/delete）" })),
	folder: Type.Optional(Type.String({ description: "所在文件夹（list/upload/mkdir）" })),
	space: Type.Optional(Type.String({ description: "空间名称（list/spaces；缺省我的文件）" })),
	name: Type.Optional(Type.String({ description: "（mkdir/rename）新名称" })),
	dest: Type.Optional(Type.String({ description: "（move）目标文件夹：名称或 ID" })),
	file: Type.Optional(Type.String({ description: "（upload）本地文件：工作目录内相对路径" })),
	out: Type.Optional(Type.String({ description: "（download）保存到工作目录内的相对路径" })),
	query: Type.Optional(Type.String({ description: "（search）关键词" })),
	link: Type.Optional(Type.String({ description: "（fetch）消息原文或分享链接" })),
	spaceId: Type.Optional(Type.String({ description: "（fetch）链接里的 spaceId（link 含时不给）" })),
	nodeId: Type.Optional(Type.String({ description: "（fetch）链接里的 fileId（link 含时不给）" })),
	limit: Type.Optional(Type.Number({ description: "（list/search）条数，默认 30" })),
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
	action: Action(["read", "search", "create", "append", "replace", "wikiList", "sheetCreate", "sheetRead", "sheetWrite", "sheetAppend", "sheetSetDropdown", "sheetGetDropdown", "sheetDeleteDropdown", "tableQuery", "tableAdd", "tableUpdate", "tableDelete"]),
	doc: Type.Optional(Type.String({ description: "文档/表格：标题、链接或节点 ID（只给标题时插件先搜）" })),
	title: Type.Optional(Type.String({ description: "（create/sheetCreate）新标题" })),
	content: Type.Optional(Type.String({ description: "（create/append/replace）正文（Markdown）" })),
	old: Type.Optional(Type.String({ description: "（replace）只换这段原文，而不是整篇覆盖" })),
	query: Type.Optional(Type.String({ description: "（search/wikiList/tableQuery）关键词" })),
	workspace: Type.Optional(Type.String({ description: "知识库名称或 ID（wikiList）" })),
	sheetId: Type.Optional(Type.String({ description: "工作表 ID 或名称（sheet*；缺省取第一个）" })),
	folder: Type.Optional(Type.String({ description: "（sheetCreate）目标文件夹：名称、链接或 ID" })),
	range: Type.Optional(Type.String({ description: "（sheetRead/sheetWrite/sheet*Dropdown）区域，如 A1:C3" })),
	options: Type.Optional(Type.Array(Type.String(), { description: "（sheetSetDropdown）Inline 候选项（与 sourceRange 二选一；单项不能含逗号）" })),
	sourceRange: Type.Optional(Type.String({ description: "（sheetSetDropdown）引用区域如 T1:T3（与 options 二选一，配 sourceSheetId）" })),
	sourceSheetId: Type.Optional(Type.String({ description: "（sheetSetDropdown）sourceRange 的来源工作表 ID" })),
	multiSelect: Type.Optional(Type.Boolean({ description: "（sheetSetDropdown）允许多选，默认单选" })),
	values: Type.Optional(
		Type.Array(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])), {
			description: "（sheetCreate/sheetWrite/sheetAppend）二维数据按行给；手机号/身份证号等长数字按字符串传（防精度丢失）",
		}),
	),
	base: Type.Optional(Type.String({ description: "多维表 base 名称或 ID（table*）" })),
	table: Type.Optional(Type.String({ description: "多维表内数据表名称或 ID（table*）" })),
	records: Type.Optional(
		Type.Array(
			Type.Object({
				recordId: Type.Optional(Type.String({ description: "（tableUpdate）要改的 recordId；新增不填" })),
				cells: Type.Record(Type.String(), Type.Unknown(), { description: "字段名 → 值" }),
			}),
		),
	),
	recordIds: Type.Optional(Type.Array(Type.String(), { description: "（tableDelete）要删的 recordId" })),
	limit: Type.Optional(Type.Number({ description: "返回条数，默认 20" })),
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
			// 上游没有 --query：关键词只能本地过滤，条数给够再筛（--page-all 上限 20 页 × 50 条）
			if (!p.query) return { args };
			return { args: [...args, "--page-all"], note: `知识库节点不支持服务端搜索：取回后按「${p.query}」过滤名称` };
		}
		case "sheetCreate": {
			if (!p.title) return err("sheetCreate 需要 title（表名）");
			// 有初始数据走 create-with-data（创建+写入+回读一体）；空表才用 create
			const args = p.values?.length
				? ["sheet", "create-with-data", "--name", p.title, "--values", toSheetValues(p.values as Array<Array<string | number | boolean | null>>)]
				: ["sheet", "create", "--name", p.title];
			if (r.ids?.folder) args.push("--folder", r.ids.folder);
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
		case "sheetSetDropdown": {
			if (!doc || !p.range) return err("sheetSetDropdown 需要 doc + range");
			const sid = r.ids?.sheetId ?? p.sheetId;
			if (!sid) return err("sheetSetDropdown 需要 sheetId（插件没解析出工作表）");
			const hasOptions = !!p.options?.length;
			const hasSource = !!p.sourceRange;
			if (hasOptions === hasSource) return err("options 与 sourceRange 必须且只能二选一");
			if (hasOptions && p.options!.some((o) => o.includes(","))) return err("下拉选项不能含英文逗号（dws 解析坑）");
			if (hasSource) {
				if (!p.sourceSheetId) return err("sourceRange 模式需要 sourceSheetId");
				if (/[!,=]/.test(p.sourceRange!)) return err("sourceRange 只接受 A1 区域（如 T1:T3），不带工作表前缀/公式/多区域");
			}
			const args = ["sheet", "set-dropdown", "--node", doc, "--sheet-id", sid, "--range", p.range];
			if (hasOptions) args.push("--options", JSON.stringify(p.options!.map((v) => ({ value: v }))));
			else args.push("--source-sheet-id", p.sourceSheetId!, "--source-range", p.sourceRange!);
			if (p.multiSelect) args.push("--multi-select");
			return { args, note: "会覆盖目标范围内已有下拉配置；结构操作后 sourceRange 需回读 sourceRangeStatus" };
		}
		case "sheetGetDropdown":
		case "sheetDeleteDropdown": {
			if (!doc || !p.range) return err(`${p.action} 需要 doc + range`);
			const sid = r.ids?.sheetId ?? p.sheetId;
			if (!sid) return err(`${p.action} 需要 sheetId（插件没解析出工作表）`);
			return { args: ["sheet", p.action === "sheetGetDropdown" ? "get-dropdown" : "delete-dropdown", "--node", doc, "--sheet-id", sid, "--range", p.range] };
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

