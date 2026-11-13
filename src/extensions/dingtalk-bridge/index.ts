/**
 * dingtalk-bridge：钉钉受控桥接（业务语义层 + 安全门禁）
 *
 * 背景：dingtalk-* 技能（dws npm postinstall 安装、升级即还原，不可改）以「冻结说明书 +
 * 凭记忆拼命令」驱动 dws，真实事故（误发/重发/记岔 ID/时间锚点漂移）证明文档约束对
 * 高风险操作不可靠。本扩展把 dws 的命名与参数彻底挡在模型之外，并把铁律做成工具层硬拦截。
 *
 * - L3 语义层（模型看到的只有这一层）：6 个业务工具 `dingtalk_msg` / `dingtalk_todo` /
 *   `dingtalk_calendar` / `dingtalk_approval` / `dingtalk_file` / `dingtalk_doc` + `dingtalk_confirm`——
 *   AI 只说业务话（收件人姓名、群名、「明天 09:30」），命令/flags/ID 由本文件解析
 *   （姓名→userId、群名→openConversationId、消息关键词→msgId、文档标题→nodeId、
 *   多维表名→baseId/tableId、手机号→账号）。`dws_skill` 不是逃生舱：它只把官方技能正文
 *   当知识读回来，供评估「这个操作插件到底支不支持」并回报用户，不给任何命令执行通道。
 *   同名/同名群不要求人工确认：把候选列回对话，
 *   由 AI 按部门/职务/工号自己挑（见 intents.ts 的场景→命令映射）。
 *   这些工具与 `dingtalk_confirm` 都 `defaultActive: false`：不装载就不声明、不占上下文，
 *   模型用到钉钉时先调 `dingtalk_help`，下一轮起可直接调用（`/dws unload` 可卸下）。
 * - L2 安全门禁（`decideExec` 纯函数 + `runGuarded` 管线，语义层唯一入口）：
 *   · 分档由 dws schema 元数据决定（缓存 + 手写表兜底）：读直通 / 写两阶段 / 敏感档弹人工面板
 *   · 发送类（+dm / +messages-send* / +messages-reply / +broadcast / ding send-*）与转发类
 *     （+messages-forward*）强制两阶段——首次返回执行计划不发送，用户在对话里确认后调
 *     `dingtalk_confirm(draftId)` 执行；转发、卡片更新、转 DING 无正文可加标签，豁免标签检查
 *   · 群发（chat +broadcast）草稿前先跑只读 dry-run 预检收件人：有人未唯一解析就整体拦下
 *   · 人工面板只写人话（动作/对象/正文/影响），不放 argv 与裸 ID；无界面会话直接拒绝
 *   · 本会话相同（目标+内容）重复发送 → 拒执（防「为验证重发」）；撤回同理防重复
 *   · 查询结果自动附当前时间锚点；正文里的字面「反斜杠-n」自动归一为真换行；
 *     文件/媒体消息回报「本条不含正文」（说明文字必须另发一条）
 *   · 查消息顺手把消息里的附件落盘（图片/语音/文件 → 工作目录，路径回显，可直接 read）
 *   · 转发/回复/撤回/查消息的会话可以写个人姓名（自动定位单聊会话），不限于群
 *   · 上游把能力标成对 AI 关闭（schema availability 非 available）或命令路径根本不存在时，
 *     直接说清原因，不让它伪装成内容错
 * - L0 技能过滤：before_agent_start 把 dingtalk-* 从系统提示词的技能清单摘掉（省上下文），
 *   需要时用 `dws_skill` 按需取回；业务工具未装载时连那五条操作规则也不注入。
 *
 * 配置 ~/.pi/agent/dingtalk-bridge.json：requireAiTag / blockedSkillPrefixes / dwsPath /
 * execTimeoutMs / maxOutputChars / dedupMinutes / skillsDir / remembered；/dws 查看状态与 forget/refresh。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";
import { isCodemodeCall } from "../shared/codemode";
import { removePath } from "../shared/fs-safe";
import { askReview, fitItems, layoutList, reviewActions, type ReviewSection } from "../shared/review-panel";
import {
	buildApproval,
	buildCalendar,
	buildDoc,
	buildFile,
	buildMessage,
	buildTodo,
	attachmentValue,
	composeFormValues,
	asAttachmentRef,
	describeFormFields,
	hasDetailColumns,
	approvalCardLink,
	filledTableLabels,
	hasCJK,
	idKindOf,
		isStableId,
	isoTime,
	parseFormSchema,
	readForecast,
	type AttachmentInput,
	type AttachmentRef,
	type Built,
	type FormInput,
	type Resolved,
	type ResolvedGroup,
	type ResolvedMessage,
	type ResolvedPerson,
	type SchemaField,
	// 参数 schema（单一真值源：既是工具签名，也是构建函数的入参类型）
	ApprovalParams,
	type ApprovalParamsT,
	CalendarParams,
	type CalendarParamsT,
	DocParams,
	type DocParamsT,
	FileParams,
	type FileParamsT,
	MessageParams,
	type MessageParamsT,
	MEDIA_OUT_DIR,
	TodoParams,
	type TodoParamsT,
} from "./intents";

/* ============================== 可调配置 ============================== */

const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "dingtalk-bridge.json");
/** 已发送台账：跨会话防重发（新进程/重开会话时内存状态清零，靠它拦住「重跑一遍」） */
const LEDGER_FILE = path.join(os.homedir(), ".pi", "agent", "dingtalk-bridge-sent.json");
/** 待确认草稿有效期：超时需重新走确认（防拿昨天的回执发今天的消息） */
const PENDING_TTL_MS = 10 * 60_000;
/** dws_skill 单次返回的技能正文上限 */
const SKILL_MAX_CHARS = 12_000;
/** 延迟装载的业务工具：首次会话不声明给模型，由 dingtalk_help 按需装载 */
const LAZY_TOOLS = [
	"dingtalk_msg",
	"dingtalk_todo",
	"dingtalk_calendar",
	"dingtalk_approval",
	"dingtalk_file",
	"dingtalk_doc",
	"dingtalk_confirm",
	"dws_skill",
] as const;
/** 落盘类命令的执行上限：下大文件/多附件比查询慢得多，60s 会误杀（仅下限，不覆盖更大的 execTimeoutMs） */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

interface BridgeConfig {
	/** 发送内容缺【AI发送】标签时拒执（formal=true 豁免） */
	requireAiTag: boolean;
	/** 启动时从注入清单过滤的技能名前缀 */
	blockedSkillPrefixes: string[];
	/** dws 二进制路径覆盖（缺省自动探测 npm 全局安装位置） */
	dwsPath?: string;
	execTimeoutMs: number;
	/** dws_exec 单次输出截断 */
	maxOutputChars: number;
	/** 已发送台账保留时长（分钟）：期间内同内容发送被视为重复（跨会话生效） */
	dedupMinutes: number;
	/** 技能目录（缺省 ~/.agents/skills，dws 官方技能的规范位置） */
	skillsDir?: string;
	/** 已记住「以后这类直接执行」的命令（cli_path，如 "chat +broadcast"）；destructive 不记 */
	remembered: string[];
}
const DEFAULT_CONFIG: BridgeConfig = {
	requireAiTag: true,
	blockedSkillPrefixes: ["dingtalk-"],
	execTimeoutMs: 60_000,
	maxOutputChars: 30_000,
	dedupMinutes: 60,
	remembered: [],
};
const isConfig = (v: unknown): v is BridgeConfig =>
	typeof v === "object" && v !== null &&
	((v as BridgeConfig).requireAiTag === undefined || typeof (v as BridgeConfig).requireAiTag === "boolean");

function loadConfig(): BridgeConfig {
	const cfg = loadJsonConfig(CONFIG_FILE, {}, (v): v is Partial<BridgeConfig> => typeof v === "object" && v !== null);
	return { ...DEFAULT_CONFIG, ...cfg };
}

/* ============================== 纯函数（策略层，测试直引） ============================== */

/**
 * 把已有消息转 DING（无正文，标签规则不适用）。
 * 只用 `ding message send-by-message`：短写 `ding +send-by-message` 的 schema availability=unavailable，
 * CLI 在 capability_gate 阶段就拒（execution_started:false，请求没发出去），两者参数完全相同。
 */
const DING_BY_MESSAGE_PREFIXES: string[][] = [["ding", "message", "send-by-message"]];
/** 发送 DING：本人身份发一条独立新提醒；机器人身份的 `ding message send` 要 robot-code */
const DING_SEND_PREFIXES: string[][] = [
	["ding", "message", "send-personal"],
	["ding", "+send-personal"],
];
/** 发送类命令前缀（argv 前几项匹配即命中）：命中即走两阶段 + 标签 + 防重发全套校验 */
const SEND_PREFIXES: string[][] = [
	["chat", "+dm"], // 按姓名/ID 发单聊
	["chat", "+send-to-group"], // 按群名/ID 发群消息
	["chat", "+messages-send"], // 统一发送入口（user/bot/webhook，含多群）
	["chat", "+messages-send-by-bot"], // 机器人发群
	["chat", "+messages-send-by-webhook"], // Webhook 机器人发群
	["chat", "+messages-send-card"], // 卡片消息
	["chat", "+messages-batch-send-by-bot"], // 机器人批量单聊（与 +broadcast 同类）
	["chat", "+messages-reply"], // 引用回复（发出文本）
	["chat", "+messages-forward"], // 转发已有消息到别的会话
	["chat", "+messages-forward-topic"], // 转发 Thread
	["chat", "+messages-combine-forward"], // 合并转发多条消息
	["chat", "+messages-update-card"], // 流式更新已发出的卡片
	["chat", "+broadcast"], // 按姓名群发同一条单聊（姓名目标，走预检）
	...DING_SEND_PREFIXES, // 发送 DING（独立新提醒）
	["ding", "message", "send"], // 机器人身份发 DING（需 robot-code）
	...DING_BY_MESSAGE_PREFIXES, // 消息转 DING（引用原消息）
];
/** 撤回类命令：破坏性但可再发；同样要过两阶段确认 + 防重复撤回 */
const RECALL_PREFIXES: string[][] = [
	["chat", "+messages-recall"],
	["chat", "+messages-recall-by-bot"],
	["chat", "+messages-batch-recall-by-bot"],
	["ding", "+recall-personal"],
];
/** 群发命令：--to 是姓名列表（dws 内部逐个解析），发送前必须过只读预检 */
const BROADCAST_PREFIXES: string[][] = [["chat", "+broadcast"]];
/** 群发预检未过时的消歧指引（实测：--to 里姓名与 userId 可混用） */
const BROADCAST_FIX_GUIDE =
	"处理方法：① 多候选——把重名的名字直接换成候选里的 userId，其余名字照旧（姓名与 userId 可混用）。" +
	"② 查无此人——核对姓名用字，或直接把这个人的完整手机号当收件人（插件会反查）。" +
	"③ 只发已解析的那批时，删掉未解析的名字重发（本轮一条都没发，不会重复）。";
/** 撤回目标 flag */
const RECALL_ID_FLAGS = new Set(["--msg-id", "--message-id", "--msg-ids", "--message-ids"]);
/** 查询类命令前缀：结果前自动附当前系统时间 */
const QUERY_PREFIXES: string[][] = [
	["chat", "+search-msg"],
	["chat", "+chat-messages"],
	["chat", "+messages-query-send-status"],
	["chat", "+conversation-list"],
];
/** 发送目标取值 flag（含中文姓名即拒执） */
const TARGET_FLAGS = new Set(["--to", "--user", "--users"]);
/** 无正文可加标签的命令：转发/合并转发、卡片更新、把已有消息转 DING（标签规则不适用，仍走两阶段与防重发） */
const TAG_EXEMPT_PREFIXES: string[][] = [
	["chat", "+messages-forward"],
	["chat", "+messages-forward-topic"],
	["chat", "+messages-combine-forward"],
	["chat", "+messages-update-card"],
	...DING_BY_MESSAGE_PREFIXES,
];
/** 群目标 flag：值可能是中文群名（同名群/改群名都会发错）——同样要求解析成 openConversationId */
const GROUP_FLAGS = new Set(["--group", "--chat-id", "--dest-conversation-id"]);
/** 写操作的对象名 flag：标题/名称/主题这类人能直接认出的值（面板的主角行用它） */
const SUBJECT_FLAGS = new Set(["--title", "--name", "--subject", "--room-name", "--new-name", "--file-name"]);
/** 正文类 flag（做字面 \n 归一） */
const CONTENT_FLAGS = new Set(["--content", "--text", "--markdown"]);
/** 表单值 flag（发起/预演审批等）：面板要把它拆成人读的字段表，而不是一串 JSON */
const FORM_VALUE_FLAGS = new Set(["--form-values", "--request"]);
/** 文件/媒体类 flag：命中则本条消息无正文（协议层与正文互斥） */
const MEDIA_FLAGS = new Set(["--file", "--file-path", "--media-id"]);
const MEDIA_TYPES = new Set(["file", "image", "audio", "video"]);
/** 签名计算时剔除的易变 flag（不影响「同一条消息」判定） */
const VOLATILE_FLAGS = new Set(["--format", "-f", "--yes", "-y", "--timeout", "--jq", "--fields"]);

/* ============================== 命令分档（读 / 写 / 敏感） ============================== */

/**
 * 分档决定「要不要拦、要不要弹窗」，不再靠手写名单硬撑：
 * · read   → 直通（无副作用）
 * · write  → 两阶段（草稿 + AI 二次确认）
 * · sensitive → 两阶段 + **人工弹窗**（破坏性，或会把内容发出去/影响他人）
 * 真相源是 `dws schema --cli-path <path> --compact` 的 effect/confirmation；手写表只做
 * 「本地宜判的补充」与「查不到元数据时的兜底」——outward 类（发送/撤回/转发）无论如何都算 sensitive。
 */
export type Tier = "read" | "write" | "sensitive";
export interface CmdMeta {
	effect: string;
	risk: string;
	confirmation: string;
	availability: string;
	/** schema 的 cli_path：可执行的命令写法（argv 前几项），canonical_path 不能当命令执行 */
	cliPath: string;
	/** schema 的 canonical_path：工具身份名，不能当命令执行 */
	canonicalPath: string;
	/** availability 非 available 时上游给的说明（interface_reason） */
	reason: string;
}

/** 命令元数据缓存（按 cli_path；schema 调用 ~2.5s，只对首次出现的新命令付一次） */
const SCHEMA_CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "dingtalk-bridge-schema.json");

/** 读语义词（命中且不含写语义词时才敢当读操作放行，否则老老实实查元数据） */
const READ_WORDS = new Set([
	"list", "get", "search", "query", "info", "read", "find", "status", "me", "lookup", "schema", "help", "preview", "members", "topics", "threads", "replies", "history", "stats", "inspect", "detail", "fields", "decode", "validate", "check", "message", "messages", "conversation", "conversations", "file", "files", "record", "records", "node", "nodes", "asset", "assets", "download", "export", "diff", "transcript", "summary",
]);
/** 写语义词（宁多列；漏判会把写命令当读放行，那是危险的） */
const WRITE_WORDS = new Set([
	"send", "create", "update", "delete", "remove", "add", "set", "unset", "cancel", "recall", "forward", "reply", "share", "invite", "dismiss", "quit", "clear", "transfer", "upgrade", "mute", "rename", "move", "copy", "publish", "upload", "import", "overwrite", "patch", "run", "start", "stop", "assign", "comment", "notice", "approve", "reject", "revoke", "redirect", "append", "revert", "submit", "done", "mark", "edit", "insert", "replace", "sync", "push", "pull", "enable", "disable", "grant", "bind", "unbind", "reset", "fill", "sort", "merge", "split", "convert", "restore", "exit", "join", "leave", "kick", "pin", "hide", "show", "refresh", "generate", "truncate", "clean", "expire", "delay",
]);

/** 命令行 → 命令词（取第一个 flag 前的部分：`chat +broadcast --to x` → `chat +broadcast`） */
export function cliPathOf(args: string[]): string {
	const words: string[] = [];
	for (const a of args) {
		if (a.startsWith("-")) break;
		words.push(a);
	}
	return words.join(" ");
}

/** 用语词把命令切成片段（`+chat-messages` → chat/messages；`send-by-bot` → send/by/bot） */
const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** 是不是“明显是读操作”（读词命中且无写词）；宁可多查一次元数据，不可放过写操作 */
export function presumedRead(args: string[]): boolean {
	const ws = wordsOf(cliPathOf(args));
	return ws.some((w) => READ_WORDS.has(w)) && !ws.some((w) => WRITE_WORDS.has(w));
}

/** canonical 形态（如 ding.shortcut_send_by_message）→ 产品 id + 尾段；非 canonical 返回 null */
export function parseCanonicalPath(p: string): { product: string; tail: string } | null {
	const m = /^([a-z0-9]+)\.([a-z0-9_]+)$/i.exec(p.trim());
	return m ? { product: m[1]!, tail: m[2]! } : null;
}

/** 路径归一化：只留小写字母数字——用于跨写法比对（ding +send-by-message ↔ ding message send-by-message） */
const pathKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** 去首段（产品 id）后的命令词，归一化；canonical/点分写法先剥首段 */
function pathTailKey(path: string): string {
	const t = path.trim();
	if (!/\s/.test(t) && t.includes(".")) return pathKey(t.slice(t.indexOf(".") + 1));
	return pathKey(t.split(/\s+/).slice(1).join(""));
}

/**
 * 在产品的工具表里按「归一化后互相包含」找唯一命中的工具（返回下标，未命中 -1）。
 * schema 的 cli_path 与技能文档/本地命令树里的写法只差分隔符与组名（+send-by-message vs message send-by-message），
 * 完全字面匹配找不到，故用归一化包含关系；完全相等优先，多个候选并列时宁可不猜。
 */
export function matchToolByPath(tools: Array<{ canonical_path?: string; cli_path?: string }>, query: string): number {
	const q = pathTailKey(query);
	if (!q) return -1;
	let best = -1;
	let bestScore = 0;
	let second = 0;
	tools.forEach((t, i) => {
		let score = 0;
		for (const c of [t.cli_path, t.canonical_path]) {
			if (typeof c !== "string" || !c) continue;
			const k = pathTailKey(c);
			if (!k) continue;
			if (k === q) score = Math.max(score, 1000 + q.length);
			else if (k.includes(q) || q.includes(k)) score = Math.max(score, Math.min(k.length, q.length));
		}
		if (score > bestScore) {
			second = bestScore;
			bestScore = score;
			best = i;
		} else if (score > second) second = score;
	});
	return bestScore >= 4 && bestScore > second ? best : -1;
}

/** 上游把某条 shortcut 命令标成不可用时，它的等价旧写法（同一命令的本地命令路径） */
export function localAliases(cliPath: string): string[] {
	const toks = cliPath.trim().split(/\s+/);
	const [prod, ...rest] = toks;
	if (!prod || rest.length !== 1) return [];
	const seg = rest[0]!;
	return seg.startsWith("+") ? [`${prod} message ${seg.slice(1)}`] : [];
}

/** 从 `dws schema --compact` 输出取安全语义（紧凑输出是带尾逗号的非严格 JSON，用正则取顶层字段） */
export function parseCmdMeta(text: string): CmdMeta | null {
	const pick = (k: string): string | undefined => new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`).exec(text)?.[1];
	const effect = pick("effect");
	if (!effect) return null;
	return {
		effect,
		risk: pick("risk") ?? "",
		confirmation: pick("confirmation") ?? "",
		availability: pick("availability") ?? "",
		cliPath: pick("cli_path") ?? "",
		canonicalPath: pick("canonical_path") ?? "",
		reason: pick("interface_reason") ?? "",
	};
}

/** 命令参数表（schema 的 parameters 键 = flag 名去横线的下划线形式，如 open-dingtalk-id） */
export interface CmdSchema {
	meta: CmdMeta;
	params: string[];
}

/** 手写补充：会"发出去/影响他人/不可逆"但未必被 dws 标成 destructive 的命令（弹窗档位用） */
/** 从 parameters 块提参数名（下划线形式）；非严格 JSON（尾逗号/内嵌引号）不能 json.parse，宽松扫块提取 */
export function parseCmdParams(text: string): string[] {
	const m = /"parameters"\s*:\s*\{/.exec(text);
	if (!m) return [];
	let depth = 0;
	const names: string[] = [];
	const re = /"([a-z0-9-]+)"\s*:\s*\{|\}/g;
	re.lastIndex = m.index + m[0].length;
	let mm: RegExpExecArray | null;
	while ((mm = re.exec(text))) {
		if (mm[1]) {
			if (depth === 0 && !names.includes(mm[1])) names.push(mm[1]);
			depth++;
		} else if (depth > 0) {
			depth--;
			if (depth < 0) break;
		}
	}
	return names;
}
const SENSITIVE_EXTRA: string[][] = [
	["mail", "message", "send"], ["mail", "message", "reply"], ["mail", "message", "reply-all"], ["mail", "message", "forward"], ["mail", "sent-message", "recall"], ["mail", "message", "batch-delete"],
	["oa", "approval", "create-instance"], ["oa", "approval", "approve"], ["oa", "approval", "reject"], ["oa", "approval", "revert-task"], ["oa", "approval", "append-task"], ["oa", "approval", "redirect-task"], ["oa", "approval", "revoke"],
	["calendar", "event", "delete"], ["calendar", "attendee", "add"], ["calendar", "attendee", "delete"], ["calendar", "room", "delete"], ["calendar", "event", "create"],
	["todo", "task", "delete"], ["todo", "task", "add-executor"], ["todo", "task", "remove-executor"], ["todo", "task", "add-participant"],
	["doc", "+access-grant"], ["doc", "+access-change"], ["doc", "+access-revoke"], ["doc", "+grant-and-share"], ["doc", "+share"], ["doc", "+version-revert"], ["doc", "block", "delete"],
	["wiki", "+member-add"], ["wiki", "+member-update"], ["wiki", "+member-remove"], ["wiki", "+delete-space"], ["wiki", "+node-delete"],
	["minutes", "+upload"], ["minutes", "+share"], ["minutes", "+unshare"], ["minutes", "+summary"], ["minutes", "+record-start"], ["minutes", "+record-stop"],
	["drive", "+delete"], ["drive", "+move"], ["drive", "+rename"], ["drive", "+publish-unset"], ["drive", "push"],
	["report", "entry", "submit"],
	["contact", "user", "invite"], ["contact", "dept", "create"], ["contact", "user", "update"],
	["aitable", "+base-delete"], ["aitable", "+field-delete"], ["aitable", "+record-delete"], ["aitable", "+record-bulk-patch"], ["aitable", "record", "delete"],
	["chat", "+chat-dismiss"], ["chat", "+conversation-clear-messages"], ["chat", "+chat-upgrade-to-external"], ["chat", "+chat-transfer-owner"], ["chat", "+chat-set-admin"], ["chat", "+chat-audit-join"], ["chat", "+chat-create"], ["chat", "+chat-quit"], ["chat", "+chat-update"], ["chat", "group", "members"], ["chat", "group", "notice"], ["chat", "group", "dismiss"], ["chat", "group", "quit"],
];

/** 分档：元数据优先（destructive 直接归 sensitive），，发送/撤回/转发类无论如何都归 sensitive */
export function tierOf(args: string[], meta: CmdMeta | null): { tier: Tier; why: string } {
	if (meta?.effect === "read") return { tier: "read", why: "只读" };
	if (meta?.effect === "destructive") return { tier: "sensitive", why: "破坏性操作（不可逆）" };
	if (matchPrefix(args, SEND_PREFIXES)) return { tier: "sensitive", why: "会对外发出消息" };
	if (matchPrefix(args, RECALL_PREFIXES)) return { tier: "sensitive", why: "撤回会改变双方可见内容" };
	if (matchPrefix(args, SENSITIVE_EXTRA)) return { tier: "sensitive", why: "会影响他人或不可恢复" };
	if (meta?.effect === "write") return { tier: "write", why: `写入操作（${meta.risk || "unknown"}）` };
	return { tier: "write", why: "无法确认是只读（按写入对待）" };
}

/** 不带元数据时的兜底分档（测试与离线场景）：只靠手写表 */
export const tierFromTables = (args: string[]): Tier => tierOf(args, null).tier;

/**
 * codemode 脚本里能否发起这一步：只读直通，写档与敏感档一律拒。
 * 两阶段的全部价值在于「执行计划直接暴露在对话里、确认是一次单独而刻意的调用」；
 * 脚本里计划被折进脚本输出、确认藏在循环里，用户实质上没审。
 */
export const codemodeBlocked = (toolCallId: string | undefined, tier: Tier): boolean =>
	isCodemodeCall(toolCallId) && tier !== "read";

/* ------------------------------ 人类语审核文案 ------------------------------ */

/** 动作短语：把命令前缀翻译成人话（面板标题；缺省退到命令词，而不是 argv） */
const ACTION_LABELS: Array<[string[], string]> = [
	[["chat", "+dm"], "发送消息"],
	[["chat", "+send-to-group"], "群发消息"],
	[["chat", "+broadcast"], "群发单聊"],
	[["chat", "+messages-send-by-bot"], "机器人发送"],
	[["chat", "+messages-batch-send-by-bot"], "批量单聊"],
	[["chat", "+messages-send-by-webhook"], "Webhook"],
	[["chat", "+messages-send"], "发送消息"],
	[["chat", "+messages-send-card"], "发送卡片"],
	[["chat", "+messages-update-card"], "更新卡片"],
	[["chat", "+messages-reply"], "引用回复"],
	[["chat", "+messages-forward"], "转发消息"],
	[["chat", "+messages-forward-topic"], "转发话题"],
	[["chat", "+messages-combine-forward"], "合并转发"],
	[["chat", "+messages-recall"], "撤回消息"],
	[["chat", "+chat-dismiss"], "解散群聊"],
	[["chat", "+conversation-clear-messages"], "清空记录"],
	[["chat", "+chat-create"], "创建群聊"],
	[["chat", "+chat-transfer-owner"], "转让群主"],
	[["chat", "+chat-quit"], "退出群聊"],
	[["todo", "task", "create"], "新建待办"],
	[["todo", "task", "update"], "修改待办"],
	[["todo", "task", "done"], "完成待办"],
	[["calendar", "attendee", "add"], "加参会人"],
	[["calendar", "event", "update"], "修改日程"],
	[["oa", "approval", "redirect-task"], "转交审批"],
	[["oa", "approval", "revoke"], "撤销审批"],
	[["doc", "+create"], "新建文档"],
	[["doc", "+update"], "编辑文档"],
	[["sheet", "create"], "新建表格"],
	[["sheet", "create-with-data"], "新建表格"],
	[["sheet", "range", "update"], "写入表格"],
	[["sheet", "append"], "追加表格"],
	[["sheet", "set-dropdown"], "设置下拉"],
	[["sheet", "get-dropdown"], "查下拉配置"],
	[["sheet", "delete-dropdown"], "删除下拉"],
	[["aitable", "record", "create"], "新增记录"],
	[["aitable", "+record-update"], "修改记录"],
	[["aitable", "+record-delete"], "删除记录"],
	[["drive", "+create-folder"], "新建文件夹"],
	[["drive", "+upload"], "上传文件"],
	[["drive", "+download"], "下载文件"],
	[["drive", "+move"], "移动文件"],
	[["drive", "+rename"], "重命名"],
	[["ding", "message", "send-personal"], "发送DING"],
	[["ding", "message", "send-by-message"], "消息转DING"],
	[["ding", "message", "send"], "发送DING（机器人）"],
	[["mail", "message", "send"], "发送邮件"],
	[["oa", "approval", "create-instance"], "发起审批"],
	[["oa", "approval", "approve"], "同意审批"],
	[["oa", "approval", "reject"], "拒绝审批"],
	[["calendar", "event", "create"], "新建日程"],
	[["calendar", "event", "delete"], "取消日程"],
	[["todo", "task", "delete"], "删除待办"],
	[["wiki", "+node-delete"], "删除节点"],
	[["drive", "+delete"], "删除文件"],
	[["minutes", "+upload"], "上传听记"],
];

/** 影响与可逆性（常驻底部；长正文滚动时也看得到） */
const IMPACT_HINTS: Array<[string[], string]> = [
	[["chat", "+dm"], "对方会立即收到这条消息"],
	[["chat", "+send-to-group"], "群成员会立即收到这条消息"],
	[["chat", "+broadcast"], "每人各收到一条单聊；发出即送达"],
	[["chat", "+messages-reply"], "群里会立即看到你的回复"],
	[["chat", "+messages-forward"], "目标会话会立即看到转发内容"],
	[["chat", "+messages-forward-topic"], "目标会话会立即看到转发内容"],
	[["chat", "+messages-combine-forward"], "目标会话会立即看到合并后的多条消息"],
	[["chat", "+messages-recall"], "⚠ 撤回后双方均不可见，不可恢复"],
	[["chat", "+chat-dismiss"], "⚠ 群及其历史不可恢复；所有成员都会失去该群"],
	[["chat", "+conversation-clear-messages"], "⚠ 仅影响你自己的视图，但不可恢复"],
	[["chat", "+chat-quit"], "你将不再收到该群消息（可被重新拉回）"],
	[["chat", "+chat-transfer-owner"], "⚠ 群主权限移交，不可自动恢复"],
	[["chat", "+chat-create"], "会立即建群并通知被拉进来的成员"],
	[["todo", "task", "create"], "执行人会收到一条待办提醒"],
	[["todo", "task", "update"], "执行人看到的待办会变"],
	[["todo", "task", "done"], "待办标记为已完成，执行人侧同步"],
	[["todo", "task", "delete"], "⚠ 待办及其进展不可恢复"],
	[["calendar", "attendee", "add"], "被加的人会收到邀请通知"],
	[["calendar", "event", "update"], "参会人看到的日程会同步更新"],
	[["oa", "approval", "redirect-task"], "审批责任转给他人，当前待办从你这消失"],
	[["oa", "approval", "revoke"], "⚠ 审批流终止，不可恢复"],
	[["doc", "+create"], "会在钉盘新建一篇文档"],
	[["doc", "+update"], "文档内容会立即改写，协作者看到的就是新版本"],
	[["sheet", "create"], "会新建一个空表格"],
	[["sheet", "create-with-data"], "会新建表格并写入数据"],
	[["sheet", "range", "update"], "⚠ 目标区域原有内容会被覆盖"],
	[["sheet", "append"], "新数据追加到表格末尾"],
	[["sheet", "set-dropdown"], "目标区域原有下拉配置会被覆盖"],
	[["sheet", "delete-dropdown"], "该区域的下拉选项会失效"],
	[["aitable", "record", "create"], "多维表会多出一条记录"],
	[["aitable", "+record-update"], "记录的字段值会立即变更"],
	[["aitable", "+record-delete"], "⚠ 删除记录不可逆"],
	[["drive", "+create-folder"], "会在钉盘新建文件夹"],
	[["drive", "+upload"], "文件会上传到钉盘（远端名带时间戳，不会覆盖已有同名文件）"],
	[["drive", "+download"], "会从钉盘取一份到本地工作目录"],
	[["drive", "+move"], "文件会换到目标文件夹"],
	[["drive", "+rename"], "文件名会变更，已有分享链接仍指向同一文件"],
	[["ding", "message", "send-personal"], "发一条新 DING，不引用消息；短信/电话类型产生费用"],
	[["ding", "message", "send-by-message"], "把该消息转成 DING，收件人能看到原消息；短信/电话类型产生费用"],
	[["ding", "message", "send"], "发一条新 DING；短信/电话类型产生费用"],
	[["mail", "message", "send"], "对方邮箱会立即收到"],
	[["oa", "approval", "create-instance"], "审批流开启后无法撤回（除非自行撤销）"],
	[["calendar", "event", "create"], "会给参会人发邀请通知"],
	[["calendar", "event", "delete"], "⚠ 所有参会人的日程同步取消，不可恢复"],
	[["minutes", "+upload"], "会真实上传本地文件并在云端创建一条听记"],
];

const labelOf = (args: string[], table: Array<[string[], string]>): string | undefined =>
	table.find(([p]) => matchPrefix(args, [p]))?.[1];

/**
 * 表单值 → 面板的键值行。
 * 发起审批时真正要人审的就是「每个字段填了什么」，直接摆 JSON 等于没展示——
 * 而只列字段名又等于没内容。明细表展开成一行一条（含列名），附件给文件名与大小。
 */
export function formValueRows(args: string[], maxRows = 14, truncValue = 80): Array<[string, string]> {
	const raw = flagValues(args, FORM_VALUE_FLAGS).at(-1);
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const clip = (s: string) => (s.length > truncValue ? `${s.slice(0, truncValue)}…` : s);
	const oneline = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
	const rows: Array<[string, string]> = [];
	const pushTable = (label: string, raw2: string) => {
		const arr = JSON.parse(raw2) as unknown[];
		rows.push([label, `${arr.length} 行明细`]);
		arr.forEach((row, i) => {
			if (!row || typeof row !== "object") return;
			const parts = Object.entries(row as Record<string, unknown>)
				.filter(([, v]) => v !== "" && v !== null && v !== undefined)
				.map(([k, v]) => `${k} ${String(v)}`);
			rows.push([`  第 ${i + 1} 行`, clip(parts.join(" · "))]);
		});
	};
	for (const [k, v] of Object.entries(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {})) {
		const text = typeof v === "string" ? v : JSON.stringify(v);
		// 附件：给文件名与大小，fileId/spaceId 对人没有意义
		if (text.trimStart().startsWith("[") && /"fileId"/.test(text)) {
			let arr: unknown;
			try {
				arr = JSON.parse(text);
			} catch {
				arr = null;
			}
			if (Array.isArray(arr)) {
				const names = arr.map((a) => {
					const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
					const size = Number(o.fileSize ?? 0);
					return `${String(o.fileName ?? "（无名）")}${size > 0 ? ` ${Math.round(size / 1024)} KB` : ""}`;
				});
				rows.push([k, names.join("、")]);
				continue;
			}
		}
		if (text.trimStart().startsWith("[{")) {
			pushTable(k, text);
			continue;
		}
		rows.push([k, clip(oneline(text))]);
	}
	return rows.slice(0, maxRows);
}

/** 正文预览：取正文类 flag 的值，按行截断（长文不糊满面板） */
export function contentPreview(args: string[], maxLines = 12, truncLine = 120): string[] {
	const raw = flagValues(args, CONTENT_FLAGS)[0];
	if (!raw) return [];
	const lines = raw.split("\n").filter((l) => l.trim());
	const shown = lines.slice(0, maxLines).map((l) => (l.length > truncLine ? `${l.slice(0, truncLine)}…` : l));
	if (lines.length > maxLines) shown.push(`…（共 ${lines.length} 行，全文请在对话中查看）`);
	return shown;
}

/**
 * 组装面板内容——**按操作类型给不同的重点**，而不是套一个通用模板：
 * · 发送类：重点是"发给谁"（headline）与"发什么"（body 主体），影响放底部；
 * · 破坏类/其他：动作 + 对象做 headline，影响与可逆性做底部。
 * 面板里只出现人能判断的信息，不含 argv、flag、JSON、ID。
 */
export function buildReview(
	args: string[],
	meta: CmdMeta | null,
	why: string,
	extra: { recipients?: string[]; note?: string; objects?: string[]; target?: string } = {},
): {
	title: string;
	verb: string;
	object: string;
	/** 主体区块：名单进 list（多列铺满）、正文进 text——建群这类无正文的操作不再留空区 */
	sections: ReviewSection[];
	impact: string[];
	canRemember: boolean;
} {
	const verb = labelOf(args, ACTION_LABELS) ?? (meta?.effect === "destructive" ? "破坏性操作" : "钉钉操作");
	const impact = labelOf(args, IMPACT_HINTS) ?? (meta?.effect === "destructive" ? "⚠ 破坏性操作，通常不可恢复" : "会按上面的内容执行");
	const content = flagValues(args, CONTENT_FLAGS).length ? contentPreview(args) : [];
	// 对象：带前缀标签（收件人 / 群 / 撤回对象 / 文件），人多时"前 3 个 + 等 N 人"
	const recipients = extra.recipients ?? [];
	let object = "";
	const isGroupCreate = matchPrefix(args, [["chat", "+chat-create"]]);
	if (recipients.length) {
		object = isGroupCreate
			? `群「${flagValues(args, new Set(["--name"]))[0] ?? ""}」`
			: `收件人：${recipients.length} 人`;
	} else {
		const named = flagValues(args, TARGET_FLAGS).filter((v) => hasCJK(v));
		const ids = flagValues(args, TARGET_FLAGS).flatMap((v) => v.split(",")).filter((v) => v.trim() && !hasCJK(v));
		const groups = flagPairs(args, GROUP_FLAGS).filter((g) => hasCJK(g.value)).map((g) => g.value);
		const files = flagValues(args, new Set(["--file", "--file-path"])).map((f) => path.basename(f));
		const subjects = [...(extra.objects ?? []), ...flagValues(args, SUBJECT_FLAGS)].filter((v) => v && !v.startsWith("-"));
		if (named.length) object = `收件人：${named.join("、")}`;
		else if (ids.length) object = `收件人：${ids.length} 个账号`;
		else if (groups.length) object = `群：${groups.join("、")}`;
		else if (extra.target) object = `群：${extra.target}`;
		else if (subjects.length) object = subjects.join("、");
		else if (files.length) object = `文件：${files.join("、")}`;
		else if (flagValues(args, RECALL_ID_FLAGS).length) object = `对象：${extra.note ?? "指定的那条消息"}`;
	}
	// 区块：表单字段（发起/预演审批）、名单（建群/群发/多人单聊）、正文预览、补充说明
	const sections: ReviewSection[] = [];
	const formRows = formValueRows(args);
	if (formRows.length) sections.push({ kind: "kv", label: "要提交的表单", items: formRows });
	if (recipients.length) sections.push({ kind: "list", label: `${isGroupCreate ? "成员" : "收件人"}（${recipients.length} 人）`, items: recipients });
	if (content.length) sections.push({ kind: "text", label: "内容", items: content });
	if (extra.note) sections.push({ kind: "text", label: "补充", items: extra.note.split("\n") });
	return {
		title: "agent请求操作钉钉",
		verb,
		object,
		sections,
		impact: [impact],
		canRemember: meta?.effect !== "destructive",
	};
}

const matchPrefix = (args: string[], prefixes: string[][]): boolean =>
	prefixes.some((p) => p.every((seg, i) => args[i] === seg));

/** 只读预演（dws 全局 flag）：不产生副作用，故不进两阶段门 */
export const isDryRun = (args: string[]): boolean =>
	args.some((a) => a === "--dry-run" || a === "--dry-run=true");

/** 取 flag 后的值（--flag value 形式；--flag=value 也认） */
function flagValues(args: string[], flags: Set<string>): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const eq = a.indexOf("=");
		const key = eq > 0 ? a.slice(0, eq) : a;
		if (!flags.has(key)) continue;
		if (eq > 0) out.push(a.slice(eq + 1));
		else if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) out.push(args[++i]!);
	}
	return out;
}

/** DING 提醒方式（app 免费应用内 / sms 短信 / call 电话——后者产生真实费用与打扰） */
export function dingChannel(args: string[]): string | undefined {
	const dingSendSub = args[1] === "message" ? args[2] : args[1];
	const isDingSend = args[0] === "ding" && (dingSendSub === "send-personal" || dingSendSub === "+send-personal" || dingSendSub === "send-by-message" || dingSendSub === "send");
	if (!isDingSend) return undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--type=")) return a.slice(7);
		if (a === "--type") return args[i + 1];
	}
	return "app";
}

/**
 * 字面 \n 归一 + markdown 硬换行：
 * · 模型常把换行写成两个字符（反斜杠+n），dws/钉钉会把它吃成空格；
 * · 钉钉客户端 markdown 单换行被当段落内空格拼成一行（--text 同样拼行），需行尾双空格硬换行
 *   （实测：markdown+行尾双空格分行且紧凑；空行分段也可但行距偏松）。
 * 两者意图都无歧义，直接改并回报处数。
 */
export function normalizeContent(args: string[]): { args: string[]; fixed: number; hardBreaks: number } {
	let fixed = 0;
	let hardBreaks = 0;
	const markdownBody = isMarkdownBody(args);
	const out = args.map((a, i) => {
		const eq = a.indexOf("=");
		const inlineKey = eq > 0 ? a.slice(0, eq) : undefined;
		const isInline = inlineKey !== undefined && CONTENT_FLAGS.has(inlineKey);
		// 值形式："--flag 值" 中的值是前一项为正文 flag 且自身不以 - 开头的参数
		const isValue = !a.startsWith("-") && i > 0 && CONTENT_FLAGS.has(args[i - 1]!);
		if (!isInline && !isValue) return a;
		const flag = isInline ? inlineKey! : args[i - 1]!;
		const head = isInline ? a.slice(0, eq + 1) : "";
		let value = isInline ? a.slice(eq + 1) : a;
		const replaced = value.replace(/(?<!\\)\\n/g, "\n");
		if (replaced !== value) {
			fixed += (value.match(/(?<!\\)\\n/g) ?? []).length;
			value = replaced;
		}
		// 硬换行只对 markdown 类正文（--markdown；+dm 的 --content）生效
		if (markdownBody && (flag === "--markdown" || flag === "--content") && value.includes("\n")) {
			const lines = value.split("\n");
			value = lines
				.map((line, k) => {
					if (k === lines.length - 1) return line;
					if (line === "" || lines[k + 1] === "") return line; // 已是段落分隔
					if (/\s\s$/.test(line)) return line; // 已有硬换行
					hardBreaks++;
					return `${line}  `;
				})
				.join("\n");
		}
		return head + value;
	});
	return { args: out, fixed, hardBreaks };
}

/** 本次发送是否 markdown 正文（--markdown 任意命令；+dm 与 +broadcast 的 --content 也是 Markdown） */
export function isMarkdownBody(args: string[]): boolean {
	const hasFlag = (f: string) => args.some((a) => a === f || a.startsWith(`${f}=`));
	if (hasFlag("--markdown")) return true;
	return args[0] === "chat" && ["+dm", "+broadcast"].includes(args[1] ?? "") && hasFlag("--content");
}

/** 纯文本 --text 多行会在钉钉客户端拼成一行（需改用 --markdown） */export function hasMultilineText(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const inline = a.startsWith("--text=");
		if (!inline && a !== "--text") continue;
		const v = inline ? a.slice(7) : (args[i + 1] ?? "");
		if (v.includes("\n")) return true;
	}
	return false;
}

/** 本条消息是否携带文件/媒体（与正文互斥：说明文字必须另发一条） */
export function mediaKind(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const key = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
		if (MEDIA_FLAGS.has(key)) return "file";
		if (key === "--msg-type") {
			const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
			if (v && MEDIA_TYPES.has(v)) return v;
		}
	}
	return undefined;
}


/** 取 flag→值 配对（报错文案需区分是姓名还是群名） */
function flagPairs(args: string[], flags: Set<string>): { flag: string; value: string }[] {
	const out: { flag: string; value: string }[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const eq = a.indexOf("=");
		const key = eq > 0 ? a.slice(0, eq) : a;
		if (!flags.has(key)) continue;
		if (eq > 0) out.push({ flag: key, value: a.slice(eq + 1) });
		else if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) out.push({ flag: key, value: args[++i]! });
	}
	return out;
}

export interface ExecState {
	/** 本会话经 dws_resolve_user 验证过的 userId */
	resolved: Set<string>;
	/** 本会话经 dws_resolve_group 解析过的 openConversationId */
	resolvedGroups: Set<string>;
	/** 待确认草稿：token → 签名/参数/过期时刻 + 分档与（敏感档）人工审核内容 */
	pending: Map<string, PendingDraft>;
	/** 已发送签名 → 首次发送时刻与摘要 */
	sent: Map<string, { at: number; snippet: string }>;
}

/** 草稿 token（确认工具的唯一入参） */
export type DraftToken = string;

/** 预检收件人 → 模型写的 token / userId：变量表按任一键取值，回执也对得回人 */
export type RecipientAliases = Record<string, { token?: string; userId?: string }>;

/** 待确认草稿：存的是「已解析的计划」，dingtalk_confirm 按计划执行，不再重新解析 */
export interface PendingDraft {
	sig: string;
	args: string[];
	expiresAt: number;
	/** 分档：read 不会进草稿；sensitive 在执行前额外弹人工审核 */
	tier: Tier;
	/** 是否允许在审核弹窗里选「记住这类操作」 */
	canRemember: boolean;
	/** 人类语审核内容（弹窗展示，不含 argv/ID） */
	review: ReturnType<typeof buildReview>;
	/** 逐人个性化：变量表（按收件人 token；仅正文含占位符时存在） */
	vars?: VarsMap;
	/** 逐人个性化：预检得到的收件人（含 openId）——确认时按这份名单逐一发送 */
	plan?: BroadcastPreflight;
	/** 逐人个性化：预检收件人 → token/userId（变量表按任一写法取值） */
	aliases?: RecipientAliases;
	/** 逐人个性化：渲染样例（草稿回执与发送回执都展示，人不用凭 argv 判断发出去的是什么） */
	varsSample?: { recipient: string; text: string }[];
}

/** 某人渲染正文时可用的变量行：显示名 / --to 里的 token / userId 任一命中即用 */
export function personalizedRow(vars: VarsMap, recipient: string, aliases?: RecipientAliases): Record<string, string> {
	const a = aliases?.[recipient];
	return varsRowOf(vars, [recipient, a?.token, a?.userId]) ?? {};
}

/**
 * 预检收件人（dws 回显的显示名）→ 模型写的 token 与 userId。
 * 优先按 openDingTalkId 对，预检没给 openId 时按姓名/token 对。
 */
export function matchRecipientAliases(plan: BroadcastPreflight, people: ResolvedPerson[]): RecipientAliases {
	const out: RecipientAliases = {};
	for (const r of plan.resolved) {
		const hit =
			(r.openId ? people.find((p) => p.openId && p.openId === r.openId) : undefined) ??
			people.find((p) => p.name === r.recipient || p.token === r.recipient);
		if (hit) out[r.recipient] = { token: hit.token, userId: hit.userId };
	}
	return out;
}
export const newExecState = (): ExecState => ({ resolved: new Set(), resolvedGroups: new Set(), pending: new Map(), sent: new Map() });

/**
 * 查一个待确认草稿（供 dingtalk_confirm 与测试复用）：不存在/已过期分别给出去向明确的理由。
 * 不在这里消费草稿——确认工具在真正执行前才删除，避免一次探询就把草稿吃掉。
 */
export function peekDraft(state: ExecState, token: DraftToken, now: number): PendingDraft | { error: string } {
	const d = state.pending.get(token);
	if (!d) return { error: "这个 token 没有对应的待确认草稿（可能已被确认、已过期，或会话已切换）。请重新发起该操作生成新草稿。" };
	if (d.expiresAt <= now) {
		state.pending.delete(token);
		return { error: "草稿已过期（10 分钟有效）。请重新发起该操作生成新草稿。" };
	}
	return d;
}

/** 已发送台账条目（跨会话防重发） */
export interface LedgerEntry {
	sig: string;
	at: number;
	snippet: string;
}

/** 剔除超出保留期的台账条目（纯函数，便于测试） */
export function pruneLedger(entries: LedgerEntry[], dedupMs: number, now: number): LedgerEntry[] {
	return entries.filter((e) => typeof e?.sig === "string" && now - e.at < dedupMs);
}

/** 载入台账并汇入本会话已发送集（新进程/重开会话由此恢复防重发记忆） */
function loadLedger(cfg: BridgeConfig, state: ExecState, now = Date.now()): void {
	const raw = loadJsonConfig<LedgerEntry[]>(LEDGER_FILE, [], (v): v is LedgerEntry[] => Array.isArray(v));
	for (const e of pruneLedger(raw, cfg.dedupMinutes * 60_000, now)) {
		state.sent.set(e.sig, { at: e.at, snippet: e.snippet });
	}
}

/** 落盘台账（先剔除过期条目，避免长期膨胀） */
function saveLedger(cfg: BridgeConfig, state: ExecState, now = Date.now()): void {
	const entries: LedgerEntry[] = [...state.sent.entries()]
		.map(([sig, v]) => ({ sig, at: v.at, snippet: v.snippet }))
		.filter((e) => now - e.at < cfg.dedupMinutes * 60_000)
		.sort((a, b) => b.at - a.at)
		.slice(0, 200);
	saveJsonConfig(LEDGER_FILE, entries);
}

/** dws 全局自愿 flag：不属于命令参数表，校验时豁免（桥自动附的 format/yes + 运行控制/调试类） */
const GLOBAL_FLAGS = new Set([
	...VOLATILE_FLAGS, "-y", "--dry-run", "--debug", "--verbose", "--mock", "--profile", "--help", "-h", "--client-id", "--client-secret", "--webhook-token", "--identity", "--profile",
]);

/** 报出参数表里没有的 flag：参数表为空（未取到 schema）→ 空数组（fail-open，交给 dws 自己拦） */
export function unknownFlags(args: string[], params: string[]): string[] {
	if (!params.length) return [];
	const known = new Set(params.map((p) => `--${p.replace(/_/g, "-")}`));
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!a.startsWith("-")) continue;
		const eq = a.indexOf("=");
		const key = eq > 0 ? a.slice(0, eq) : a;
		// 不带 = 的 flag，下一个词是它的值：值可以是任何串，包括以 - 开头的
		// （钉钉的 processInstanceId 就可能长成 -dGvs0kQT3KC…，当 flag 判会误报「参数表不符」）
		if (eq < 0) i++;
		if (!known.has(key) && !GLOBAL_FLAGS.has(key) && !out.includes(key)) out.push(key);
	}
	// 位置参数不拦：部分命令合法收位置参数（如 drive push 收路径）
	return out;
}

/** 文件类参数（内容指纹与时间戳命名只认这两个） */
const FILE_PATH_FLAGS = new Set(["--file", "--file-path"]);

/**
 * 文件参数的内容指纹（大小 + mtime）。文件类消息的 argv 里只有路径，
 * 内容改了而路径不变时签名不变，会被防重发台账误判为「重复发送」。
 */
function fileFingerprints(args: string[], baseDir: string): string[] {
	const out: string[] = [];
	for (const f of flagValues(args, FILE_PATH_FLAGS)) {
		const abs = path.isAbsolute(f) ? f : path.join(baseDir, f);
		try {
			const st = fs.statSync(abs);
			out.push(`${path.basename(f)}:${st.size}:${Math.trunc(st.mtimeMs)}`);
		} catch {
			out.push(`${path.basename(f)}:missing`);
		}
	}
	return out;
}

/** 远端文件名的时间戳：report.md → report-20261016-183012.md */
function stampedName(file: string, now: Date): string {
	const base = path.basename(file);
	const ext = path.extname(base);
	const stem = base.slice(0, base.length - ext.length) || "file";
	const p = (n: number) => String(n).padStart(2, "0");
	return `${stem}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${ext}`;
}

/**
 * 给外发文件套上时间戳命名（远端名始终唯一，避开钉盘同名自动改名）：
 * · drive +upload 有 --file-name，直接指定远端显示名，本地文件不动；
 * · 其他命令（文件消息）远端名只能取自本地文件名，在 baseDir 的 .tmp/ 下生成带时间戳副本，
 *   argv 回传相对路径（dws 硬性要求 --file 是当前工作目录内的相对路径，系统临时区的绝对路径会被拒）。
 * 返回执行用 argv、给人看的说明与收尾清理函数。
 */
function stampOutgoingFiles(args: string[], baseDir: string, now: Date): { args: string[]; notes: string[]; cleanup: () => void } {
	const out = [...args];
	const notes: string[] = [];
	const dirs: string[] = [];
	const isUpload = out[0] === "drive" && out[1] === "+upload";
	const used = new Set<string>();
	for (let i = 0; i < out.length; i++) {
		const a = out[i]!;
		const eq = a.indexOf("=");
		const key = eq > 0 ? a.slice(0, eq) : a;
		if (!FILE_PATH_FLAGS.has(key)) continue;
		const inline = eq > 0;
		const idx = inline ? i : i + 1;
		const rel = inline ? a.slice(eq + 1) : out[idx];
		if (!rel || rel.startsWith("-")) continue;
		const abs = path.isAbsolute(rel) ? rel : path.join(baseDir, rel);
		let name = stampedName(rel, now);
		if (used.has(name)) name = name.replace(/(\.[^.]*)$/, "-2$1");
		used.add(name);
		if (isUpload) {
			out.splice(idx + 1, 0, "--file-name", name);
			notes.push(`远端文件名：${name}`);
			continue;
		}
		// 副本必须落在 baseDir 内：dws 只接受工作目录内的相对路径，os.tmpdir() 的绝对路径必被拒
		const tmpParent = path.join(baseDir, ".tmp");
		fs.mkdirSync(tmpParent, { recursive: true });
		const dir = fs.mkdtempSync(path.join(tmpParent, "dingtalk-send-"));
		dirs.push(dir);
		const dest = path.join(dir, name);
		try {
			fs.copyFileSync(abs, dest);
		} catch {
			notes.push(`⚠ 复制带时间戳的副本失败，本条按原名发出：${path.basename(rel)}`);
			continue;
		}
		const relOut = path.relative(baseDir, dest).split(path.sep).join("/");
		out[idx] = inline ? `${key}=${relOut}` : relOut;
		notes.push(`远端文件名：${name}`);
	}
	return { args: out, notes, cleanup: () => { for (const d of dirs) removePath(d); } };
}

/** 消息签名：命令前缀 + 目标 + 内容相关 flag 值（剔除易变 flag）+ 文件内容指纹，判定「同一条消息」 */
function sendSignature(args: string[], fileSigs: readonly string[] = []): string {
	const kept: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const key = a.startsWith("-") ? (a.indexOf("=") > 0 ? a.slice(0, a.indexOf("=")) : a) : null;
		if (key && VOLATILE_FLAGS.has(key)) {
			if (!a.includes("=") && i + 1 < args.length && !args[i + 1]!.startsWith("-")) i++; // 跳过其值
			continue;
		}
		kept.push(a);
	}
	for (const s of fileSigs) kept.push(`(file)${s}`);
	return createHash("sha1").update(JSON.stringify(kept)).digest("hex").slice(0, 16);
}

export type ExecDecision =
	| { action: "run" }
	| { action: "block"; reason: string; kind?: "unavailable" | "formal" | "unknown-path" }
	| { action: "pending"; token: string; preview: string };

/**
 * --formal 不是命令参数：出现即拦下，避免模型原地打转。
 */
export function formalFlagError(args: string[]): string | null {
	const hit = args.find((a) => a === "--formal" || a.startsWith("--formal="));
	if (!hit) return null;
	return `没有 ${hit} 这个参数：AI 发送的角标由插件自动带上，直接去掉它重调即可。`;
}

/**
 * 发送/查询策略判定（纯函数）。args 为完整 dws 子命令 argv（不含 dws 本身、不含自动附加 flag）。
 * formal=true 表示用户明确要求的正式通知（豁免【AI发送】标签）。
 */
export function decideExec(
	args: string[],
	opts: {
		formal?: boolean;
		/** 分档（缺省用手写表兜底）；由调用方查元数据后传入 */
		tier?: Tier;
		/** 文件类参数的内容指纹（防重发签名用；由调用方读取文件系统后传入，保持本函数纯函数） */
		fileSigs?: readonly string[];
		/** 命令元数据（dws schema 的安全语义；缺省 null） */
		meta?: CmdMeta | null;
		/** 分档理由（写进草稿与弹窗，让人知道为什么被拦） */
		why?: string;
		/** 审核文案补充（如群发预检得到的收件人列表；target = 已解析的目标群名，argv 里只剩 ID 时面板靠它显示对象） */
		reviewExtra?: { recipients?: string[]; note?: string; objects?: string[]; target?: string };
		/** 本命令的 schema 参数名（去横线的下划线形式，由调用方从缓存带出；用于草稿里列“其余未用参数”） */
		flags?: string[];
	},
	state: ExecState,
	cfg: Pick<BridgeConfig, "requireAiTag">,
	now: number,
): ExecDecision {
	// 只读预演：直接放行（否则 Agent 拿不到发送前的解析结果，且预演本就不会发消息）
	if (isDryRun(args)) return { action: "run" };
	const formalIssue = formalFlagError(args);
	if (formalIssue) return { action: "block", kind: "formal", reason: formalIssue };

	const tier = opts.tier ?? tierFromTables(args);
	const why = opts.why ?? "写操作";
	const meta = opts.meta ?? null;
	// 只读：直通（无副作用，不弹窗也不草稿）
	if (tier === "read") return { action: "run" };

	// 上游把这能力对 AI 关了（schema availability）：先说清这件事，别让它伪装成内容错误
	if (meta?.availability && meta.availability !== "available") {
		return {
			action: "block",
			kind: "unavailable",
			reason:
				`该能力已被上游对 AI 关闭（dws schema 的 availability=${meta.availability}）${meta.reason ? `：${meta.reason}` : ""}\n\n` +
				"桥不代为绕过这道闸门。需要这个操作时：换成上游仍开放的等价命令，或请用户本人在钉钉客户端手动做。",
		};
	}

	// 撤回：同样两阶段 + 防重复撤回（msgId 决定撤回哪条，错一个字符就撤错消息）
	const recallIds = flagValues(args, RECALL_ID_FLAGS);
	if (matchPrefix(args, RECALL_PREFIXES) && recallIds.length) {
		const sig = `recall:${recallIds.join(",")}`;
		if (state.sent.has(sig)) {
			return { action: "block", reason: `消息 ${recallIds.join("、")} 已在本会话或近期撤回，未重复执行。` };
		}
		const token = createHash("sha1").update(`${sig}:${now}`).digest("hex").slice(0, 10);
		const review = buildReview(args, opts.meta ?? null, why, { ...opts.reviewExtra, note: opts.reviewExtra?.note ?? `撤回对象：${recallIds.join("、")}` });
		state.pending.set(token, { sig, args: [...args], expiresAt: now + PENDING_TTL_MS, tier, canRemember: review.canRemember, review });
		return { action: "pending", token, preview: formatDraft(token, args, { tier, why, review, hints: [] }) };
	}

	const isSend = matchPrefix(args, SEND_PREFIXES);
	const targets = flagValues(args, TARGET_FLAGS);
	if (isSend) {
		const labelOk =
			args.includes("--ai-tag") || args.some((a) => a.includes("【AI发送】"));
		// 转发无正文、卡片更新只是改已发卡片：无标签可加，仍走两阶段 + 防重发
		if (cfg.requireAiTag && !labelOk && !opts.formal && !matchPrefix(args, TAG_EXEMPT_PREFIXES)) {
			return {
				action: "block",
				kind: "formal",
				reason:
					"发送内容缺【AI发送】标记，已拦截。请在消息正文开头加上【AI发送】后重试。",
			};
		}
		// 群发目标本就是姓名（dws 内部逐个解析），改由 dry-run 预检把关
		const cjkTarget = matchPrefix(args, BROADCAST_PREFIXES) ? undefined : targets.find((t) => hasCJK(t));
		if (cjkTarget) {
			return {
				action: "block",
				reason:
					`发送目标「${cjkTarget}」是姓名而非账号 ID，已拦截（姓名必须先解析成账号）。` +
					"业务工具会自动做这一步，出现本提示说明插件解析缺口，请把这条操作回报用户。",
			};
		}
		const cjkGroup = flagPairs(args, GROUP_FLAGS).find((p) => hasCJK(p.value));
		if (cjkGroup) {
			return {
				action: "block",
				reason:
					`发送目标群「${cjkGroup.value}」是群名而非会话 ID，已拦截（同名群、改群名都会发错）。` +
					"业务工具会自动解析群名，出现本提示说明插件解析缺口，请把这条操作回报用户。",
			};
		}
	}

	const sig = sendSignature(args, opts.fileSigs);
	if (isSend && state.sent.has(sig)) {
		return {
			action: "block",
			reason:
				"本会话或近期已发送过相同目标与内容的消息（防重发台账），已拦截。绝不为验证而重发——" +
				"要核对请用只读查询（如 dingtalk_msg action=\"read\", sender=\"me\"）。",
		};
	}

	// 首次：登记待确认草稿（存分档与人类语审核内容），回执交模型在对话里请用户审核
	const token = createHash("sha1").update(`${sig}:${now}`).digest("hex").slice(0, 10);
	const review = buildReview(args, opts.meta ?? null, why, opts.reviewExtra);
	state.pending.set(token, { sig, args: [...args], expiresAt: now + PENDING_TTL_MS, tier, canRemember: review.canRemember, review });
	const media = mediaKind(args);
	const channel = dingChannel(args);
		const hints = [
			channel && channel !== "app" ? `⚠️ 本条为${channel === "sms" ? "短信" : "电话"} DING：会产生实际费用与强打断（默认 app 应用内 DING 免费）——确认前先与用户核对是否必要` : null,
			media ? `本条为${media === "file" ? "文件" : "图片/音视频"}消息：不含正文——解释文字必须另发一条文本消息` : null,
		].filter((h): h is string => Boolean(h));
	return { action: "pending", token, preview: formatDraft(token, args, { tier, why, review, hints, flags: opts.flags ?? [] }) };
	}

/**
 * 给 AI 的草稿回执（信息齐全版）。与给人看的面板分工：面板只写人话，草稿面向执行者写全协议——
 * 动作/对象/影响之外，还要让 AI 看得到：完整参数（含桥自动附加的）、确认的精确重调形态、有效期与失效后果、
 * 档位与理由、以及它可能不知道的解析行为（换行归一/DING 通道/媒体消息）。
 */
export function formatDraft(
	token: string,
	args: string[],
	opts: { tier: Tier; why: string; review: ReturnType<typeof buildReview>; hints: string[]; flags?: string[] },
): string {
	const { tier, why, review, hints, flags: schemaFlags } = opts;
	const ttlMin = Math.round(PENDING_TTL_MS / 60_000);
	const used = new Set<string>();
	for (const a of args) {
		const key = a.startsWith("-") ? (a.includes("=") ? a.slice(0, a.indexOf("=")) : a) : null;
		if (key) used.add(key.slice(key.startsWith("--") ? 2 : 1));
	}
	for (const g of ["format", "yes", "dry-run", "timeout", "jq", "fields"]) used.add(`(全局)${g}`);
	const label = (f: string): string => (f.startsWith("(全局)") ? f : `--${f}`);
	const unused = (schemaFlags ?? []).filter((f) => !used.has(f));
	const lines = [
		`📋 执行计划（未执行）。确认执行：调用 dingtalk_confirm(draftId="${token}")；草稿 ${ttlMin} 分钟有效，过期即作废（重发需重新生成草稿并重新确认）。`,
		"",
		`动作与对象：${[review.verb, review.object].filter(Boolean).join("  ") || "（见下）"}`,
		...review.sections.flatMap((sec) => {
			if (sec.kind === "list") return [`${sec.label ?? "名单"}：${(sec.items as string[]).join("、")}`];
			if (sec.kind === "kv") return [`${sec.label ?? "详情"}：`, ...(sec.items as Array<string | [string, string]>).map((it) => `  ${Array.isArray(it) ? `${it[0]}：${it[1]}` : it}`)];
			return sec.label ? [`${sec.label}：`, ...(sec.items as string[]).map((l) => `  ${l}`)] : (sec.items as string[]).map((l) => `  ${l}`);
		}),
		`影响：${review.impact[0] ?? "（见上）"}`,
		`档位：${tier === "sensitive" ? "敏感（执行前会弹人工审核面板，由用户拍板）" : tier === "write" ? "写入（两阶段：确认后直接执行，不弹窗）" : "读"}——${why}`,
		...hints.map((h) => `⚠ ${h}`),
		"",
		`完整参数（执行时实际下发，含桥自动附加的部分）：`,
		...buildArgv(args).map((a) => `  ${a}`),
	];
	if (unused.length) {
		lines.push("", `本命令其余可用参数（本次未用）：${schemaFlags!.map(label).join("、")}`); 
	}
	return lines.join("\n");
}

/** +list-sheets 结果 → 第一个工作表的 sheetId（有 index 按升序；禁止猜 Sheet1/0） */
export function parseFirstSheetId(text: string): string | null {
	try {
		const data: unknown = JSON.parse(text);
		const sheets: { id: string; index: number }[] = [];
		const walk = (v: unknown): void => {
			if (Array.isArray(v)) return v.forEach(walk);
			if (!v || typeof v !== "object") return;
			const o = v as Record<string, unknown>;
			const id = ci(o, "sheetId");
			if (typeof id === "string" && id) {
				const idx = ci(o, "index");
				sheets.push({ id, index: typeof idx === "number" ? idx : sheets.length });
				return;
			}
			Object.values(o).forEach(walk);
		};
		walk(data);
		if (!sheets.length) return null;
		sheets.sort((a, b) => a.index - b.index);
		return sheets[0]!.id;
	} catch {
		return null;
	}
}

/**
 * 表格创建（sheet create / create-with-data）非原子（创建→探活→写入→回读多步）：
 * 失败/超时后引导读回现状、只补失败步骤，绝不要整体重跑（会造出重复文档）。
 */
export function sheetCreateFailureNote(args: string[], output: string): string {
	if (args[0] !== "sheet" || (args[1] !== "create-with-data" && args[1] !== "create")) return "";
	const nodeId = /"nodeId"\s*:\s*"([^"]+)"/.exec(output)?.[1];
	if (nodeId) return `\n\n⚠️ 表格创建非原子，绝不要重跑 sheetCreate（会造重复文档）——文档已创建，先 dingtalk_doc action="sheetRead" doc="${nodeId}" 读回现状，缺的用 sheetWrite 补。`;
	return "\n\n⚠️ 表格创建非原子，绝不要直接重跑 sheetCreate（可能已建出文档）——先 dingtalk_doc action=\"search\" 查同名文档确认现状，再决定补救。";
}

/**
 * 审批列表的补充注释（只给 listPending / listSubmitted 加）。
 * 钉钉的 formMassage 摘要把明细表摊平后只留第一行，多明细的单据看起来像只填了一项，
 * 而合计金额与审批编号根本不在摘要里。这三样只有 detail 给，所以对摘要有明细痕迹的单据
 * 并发拉一次详情，把「几行明细 + 合计多少 + 审批编号」补成一张一览（不拿单价×数量去猜）。
 */
/** detail 输出末尾补单据链接：实例 ID 在 JSON 里，corpId 从 profile list 取 */
export function annotateApprovalDetail(stdout: string, corpId: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return stdout;
	}
	const data = parsed as { result?: { processInstanceId?: string } };
	const instanceId = data?.result?.processInstanceId;
	if (!instanceId || !corpId) return stdout;
	return `${stdout}

单据链接：
[查看审批单](${approvalCardLink(corpId, instanceId)})`;
}

export async function annotateApprovalList(
	args: string[],
	stdout: string,
	fetchDetail: (instanceId: string) => Promise<unknown | null>,
): Promise<string> {
	if (args[0] !== "oa" || args[1] !== "approval" || (args[2] !== "list-pending" && args[2] !== "list-submitted")) return stdout;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
	} catch {
		return stdout;
	}
	const rows: Array<Record<string, unknown>> = [];
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		const o = v as Record<string, unknown>;
		if (typeof o.formMassage === "string" && typeof o.processInstanceId === "string") rows.push(o);
		Object.values(o).forEach(walk);
	};
	walk(parsed);
	if (!rows.length) return stdout;
	// 只对摘要有明细痕迹的单据拉详情：每张约 1 秒，全拉会把一次列表查询拖成好几倍时间
	const targets = rows.filter((r) => hasDetailColumns(String(r.formMassage)));
	// 上限按「耗时」定：6 并发下 12 张约 2 秒；再多就把列表拖成十几秒，
	// 而用户并没有要逐单详情——超出的部分让他自己按单查
	const MAX_DETAIL = 12;
	const CONCURRENCY = 6;
	const picked = targets.slice(0, MAX_DETAIL);
	const lines: string[] = [];
	for (let i = 0; i < picked.length; i += CONCURRENCY) {
		const batch = picked.slice(i, i + CONCURRENCY);
		const details = await Promise.all(batch.map((r) => fetchDetail(String(r.processInstanceId))));
		batch.forEach((row, k) => {
			const info = summarizeDetail(details[k]);
			if (!info) return;
			const parts = [
				info.businessId ? `审批编号 ${info.businessId}` : "",
				info.rows !== null ? `${info.rows} 行明细` : "",
				info.total !== null ? `合计 ${info.total} 元` : "",
			].filter(Boolean);
			if (parts.length) lines.push(`· ${String(row.processInstanceId)}：${parts.join(" · ")}`);
		});
	}
	if (!lines.length) return stdout;
	const more = targets.length > picked.length ? `\n（共 ${targets.length} 张，只补前 ${picked.length} 张；单张完整明细用 action="detail"）` : "";
	return `${stdout}\n\n明细：\n${lines.join("\n")}${more}`;
}

/** forecast-process 结果的结论行：把「forecastSuccess=false + staticWorkflow=true」这类矛盾组合翻成人话 */
export function annotateForecast(stdout: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
	} catch {
		return stdout;
	}
	const reading = readForecast(parsed);
	if (reading.kind === "needsActioners") {
		const lines = reading.selects.map((s) => `· ${s.name}：${s.actorType === "notifier" ? "抄送人" : "审批人"}需选人（actionerKey ${s.actorKey || "（未给）"}，activityId ${s.activityId}）`);
		return `${stdout}\n\n（${reading.summary}\n${lines.join("\n")}）`;
	}
	return `${stdout}\n\n（${reading.summary}）`;
}

/**
 * detail 的关键数：明细行数、合计金额、审批编号。
 * 行数与合计都从 formValueVOS 里取：TableField 的 value 是 JSON 数组字符串（行数 = 数组长度），
 * 合计取标着「合计/总计/总额」的那个字段（公式列，金额字符串）。
 */
export function summarizeDetail(data: unknown): { rows: number | null; total: number | null; businessId: string } | null {
	if (!data || typeof data !== "object") return null;
	const root = data as Record<string, unknown>;
	const body = (root.result && typeof root.result === "object" ? root.result : root) as Record<string, unknown>;
	const businessId = typeof body.businessId === "string" ? body.businessId : "";
	const items = Array.isArray(body.formValueVOS) ? (body.formValueVOS as Array<Record<string, unknown>>) : [];
	if (!businessId && !items.length) return null;
	let rows: number | null = null;
	let total: number | null = null;
	for (const it of items) {
		const name = typeof it.name === "string" ? it.name : "";
		const value = it.value;
		if (it.componentType === "TableField" && typeof value === "string") {
			try {
				const arr = JSON.parse(value) as unknown;
				if (Array.isArray(arr)) rows = (rows ?? 0) + arr.length;
			} catch { /* 不是 JSON：当没有明细 */ }
		}
		if (total === null && /合计|总计|总额|金额/.test(name)) {
			const n = Number(String(value ?? "").replace(/[,，\s]/g, "").replace(/[余]?元$/, ""));
			if (Number.isFinite(n) && String(value ?? "").trim()) total = n;
		}
	}
	return { rows, total, businessId };
}

/** 查询类结果附当前系统时间（防沿用对话记忆中的旧日期锚点） */
export function annotateQuery(args: string[], stdout: string, now: Date): string {
	if (!matchPrefix(args, QUERY_PREFIXES)) return stdout;
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `⏱ 当前系统时间：${stamp}（时间窗一律相对此刻推算：start=此刻-N 小时、end=此刻；勿沿用对话记忆中的旧日期）\n\n${stdout}`;
}

/** 群发只读预检的收件人解析表：resolved = 已唯一解析，skipped = 多候选/零候选（dws 报错原文，含稳定 ID） */
export interface BroadcastPreflight {
	resolved: { recipient: string; openId: string }[];
	skipped: string[];
}

/** 解析 chat +broadcast 的输出（--dry-run 与真实发送走同一条解析链，故预检结果即实际收件人） */
export function parseBroadcastPreflight(stdout: string): BroadcastPreflight {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { resolved: [], skipped: [] };
	}
	const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
	const skipped = Array.isArray(obj.failed) ? obj.failed.filter((s): s is string => typeof s === "string") : [];
	const resolved: { recipient: string; openId: string }[] = [];
	if (Array.isArray(obj.actions)) {
		for (const a of obj.actions) {
			if (typeof a !== "object" || a === null) continue;
			const rec = (a as Record<string, unknown>).recipient;
			if (typeof rec !== "string") continue;
			const argObj = (a as Record<string, unknown>).arguments;
			const openId = typeof argObj === "object" && argObj !== null ? ci(argObj as Record<string, unknown>, "receiverOpenDingTalkId") : undefined;
			resolved.push({ recipient: rec, openId: typeof openId === "string" ? openId : "" });
		}
	}
	if (!resolved.length && Array.isArray(obj.sent)) {
		for (const s of obj.sent) if (typeof s === "string") resolved.push({ recipient: s, openId: "" });
	}
	return { resolved, skipped };
}

/** 群发草稿里的收件人解析表 */
export function formatBroadcastPreflight(pre: BroadcastPreflight): string {
	const lines = pre.resolved.map((r) => `- ${r.recipient}${r.openId ? ` → ${r.openId}` : ""}`);
	return `将发给（${pre.resolved.length} 人，每人各一条单聊）：\n${lines.join("\n") || "（无）"}`;
}

/* ===================== 逐人个性化：正文占位符 → 每人一份变量表 =====================
 * dws 的 +broadcast 只支持「所有人收到同一条」（content 是单值），所以正文一旦含占位符，
 * 就不能用它：预检拿到每人 openDingTalkId 后，逐人渲染正文、逐人 +messages-send。
 * 替换值完全由调用方给出（不做"姓/名"语义猜测），插件只负责：取占位符、按人对齐、补幂等键。
 */

/** 插件私有 flag：--vars（JSON 字符串）/ --vars-file（工作目录内相对路径）；不传给 dws */
const VARS_FLAGS = ["--vars", "--vars-file"];
const PLACEHOLDER_SRC = "\\{\\{\\s*([\\p{L}\\p{N}_]{1,24})\\s*\\}\\}";
const placeholderRe = () => new RegExp(PLACEHOLDER_SRC, "gu");

/** 每人一条：收件人 token（与 --to 里的写法逐字一致）→ 变量表 */
export type VarsMap = Record<string, Record<string, string>>;

/** 提取正文里的占位符（去重保序） */
export function extractPlaceholders(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(placeholderRe())) {
		const name = m[1];
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}

/** 剥离插件私有 flag（--vars / --vars-file），返回给 dws 用的 argv 与原始输入 */
export function stripVarsFlags(args: string[]): { args: string[]; varsRaw?: string; varsFile?: string } {
	const out: string[] = [];
	let varsRaw: string | undefined;
	let varsFile: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (VARS_FLAGS.includes(a)) {
			if (a === "--vars") varsRaw = args[i + 1];
			else varsFile = args[i + 1];
			i++;
			continue;
		}
		if (a.startsWith("--vars=")) {
			varsRaw = a.slice("--vars=".length);
			continue;
		}
		if (a.startsWith("--vars-file=")) {
			varsFile = a.slice("--vars-file=".length);
			continue;
		}
		out.push(a);
	}
	return { args: out, varsRaw, varsFile };
}

/** 变量表用法（报错时回给模型，照着改） */
export const VARS_GUIDE =
	'用法：--vars \'{"张三": {"称呼": "张老师"}, "李四": "李老师"}\'；正文只有一个占位符时值可简写为字符串。' +
	"key 写 --to 里的写法或这个人本人的姓名/账号 ID 都行（消歧后换了 ID、变量表没跟着改也能对上）；大表用 --vars-file <工作目录内相对路径.json>。";

/** 解析变量表：值可为字符串（单占位符简写）或「变量→字符串/数字/布尔」对象 */
export function parseVarsMap(raw: string, placeholders: string[]): { map: VarsMap } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return { error: `变量表不是合法 JSON：${String(e).slice(0, 120)}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: "变量表必须是对象：{ \"姓名\": { \"变量\": \"值\" }, … }" };
	}
	const map: VarsMap = {};
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		const key = k.trim();
		if (typeof v === "string") {
			if (placeholders.length !== 1) {
				return { error: `「${key}」用了字符串简写，但正文里有 ${placeholders.length} 个占位符（${placeholders.map((p) => `{{${p}}}`).join("、")}）——请改成对象逐个给值` };
			}
			map[key] = { [placeholders[0]!]: v };
			continue;
		}
		if (!v || typeof v !== "object" || Array.isArray(v)) {
			return { error: `「${key}」的值必须是字符串或对象` };
		}
		const row: Record<string, string> = {};
		for (const [vk, vv] of Object.entries(v as Record<string, unknown>)) {
			if (typeof vv === "string") row[vk] = vv;
			else if (typeof vv === "number" || typeof vv === "boolean") row[vk] = String(vv);
			else return { error: `「${key}」的变量「${vk}」值必须是字符串/数字/布尔` };
		}
		map[key] = row;
	}
	return { map };
}

/**
 * 一份变量表可能用的键：预检回显的显示名 / --to 里的原始 token / userId。
 * 三者都认，因为同名消歧后人会被换成 userId，变量表往往还照名字写。
 */
export function varsRowOf(map: VarsMap, keys: (string | undefined)[]): Record<string, string> | undefined {
	for (const k of keys) {
		if (k && map[k]) return map[k];
	}
	return undefined;
}

/** 校验变量表覆盖全部收件人与占位符；返回问题清单（空 = 通过） */
export function validateVars(recipients: string[], placeholders: string[], map: VarsMap, aliases?: RecipientAliases): string[] {
	const problems: string[] = [];
	for (const r of recipients) {
		// 空对象也算“没给”（任一写法都没命中），不能因为 personalizedRow 返回 {} 就当成已给
		const row = personalizedRow(map, r, aliases);
		if (!Object.keys(row).length) {
			problems.push(`「${r}」没有给变量`);
			continue;
		}
		const miss = placeholders.filter((p) => !(p in row));
		if (miss.length) problems.push(`「${r}」缺变量：${miss.map((p) => `{{${p}}}`).join("、")}`);
	}
	return problems;
}

/** 用某人的变量渲染正文（未给的占位符原样保留，调用前应先过 validateVars） */
export function renderVars(text: string, row: Record<string, string>): string {
	return text.replace(placeholderRe(), (whole, name: string) => (name in row ? row[name]! : whole));
}

/** 确定性幂等键（UUID 形状）：同一人 + 同一正文 → 同一键，重跑不会重复发 */
export function personalKey(openId: string, body: string): string {
	const h = createHash("sha1").update(`${openId}\n${body}`).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 读变量表输入：--vars 直给 JSON，--vars-file 读工作目录内相对路径 */
function readVarsInput(baseDir: string, varsRaw?: string, varsFile?: string): { raw?: string; error?: string } {
	if (varsRaw !== undefined) return { raw: varsRaw };
	if (varsFile === undefined) return {};
	const abs = path.isAbsolute(varsFile) ? varsFile : path.join(baseDir, varsFile);
	const rel = path.relative(baseDir, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: `--vars-file 只接受工作目录内相对路径（当前目录 ${baseDir}）` };
	try {
		return { raw: fs.readFileSync(abs, "utf8") };
	} catch {
		return { error: `读不到变量表文件：${varsFile}` };
	}
}

/** 逐人渲染样例压成一行（草稿回执 / 预演 / 发送回执共用同一形状） */
export function sampleLine(recipient: string, text: string): string {
	const oneLine = text.split("\n").map((x) => x.trim()).filter(Boolean).join(" ⏎ ");
	return `- ${recipient} → ${oneLine.slice(0, 70)}`;
}

/**
 * 定下本次要用的变量表。
 * 草稿里带来的优先：--vars 在入口就被剥离（草稿 argv 里没有它），确认时不可能再从 argv 解析出来。
 */
export function resolveRunVars(input: {
	draftVars?: VarsMap;
	placeholders: string[];
	varsRaw?: string;
	varsFile?: string;
	baseDir: string;
}): { vars?: VarsMap; error?: string } {
	if (input.draftVars) return { vars: input.draftVars };
	const read = readVarsInput(input.baseDir, input.varsRaw, input.varsFile);
	if (read.error) return { error: read.error };
	if (read.raw === void 0) return {};
	const parsed = parseVarsMap(read.raw, input.placeholders);
	return "error" in parsed ? { error: parsed.error } : { vars: parsed.map };
}

/**
 * 逐人个性化发送：预检已给出每人 openDingTalkId，对每人渲染正文后单独发一条单聊。
 * 逐人失败不阻断其余（最后汇总「成功/失败」名单）；幂等键随人随正文固定，重跑不会重复发。
 */
async function sendPersonalized(
	cfg: BridgeConfig,
	baseArgs: string[],
	plan: BroadcastPreflight,
	vars: VarsMap,
	state: ExecState,
	aliases?: RecipientAliases,
): Promise<{ sent: string[]; failed: { name: string; why: string }[]; skipped: string[] }> {
	const content = flagValues(baseArgs, CONTENT_FLAGS).at(-1) ?? "";
	const sent: string[] = [];
	const skipped: string[] = [];
	const failed: { name: string; why: string }[] = [];
	for (const rec of plan.resolved) {
		if (!rec.openId) {
			failed.push({ name: rec.recipient, why: "预检未返回 openDingTalkId" });
			continue;
		}
		const body = renderVars(content, personalizedRow(vars, rec.recipient, aliases));
		const sig = `send:${rec.openId}:${createHash("sha1").update(body).digest("hex").slice(0, 16)}`;
		if (state.sent.has(sig)) {
			skipped.push(rec.recipient);
			continue;
		}
		const argv = ["chat", "+messages-send", "--as", "user", "--open-dingtalk-id", rec.openId, "--markdown", body, "--ai-tag", "--idempotency-key", personalKey(rec.openId, body)];
		const r = await runDws(cfg, buildArgv(argv));
		if (r.code === 0 && !r.timedOut) {
			state.sent.set(sig, { at: Date.now(), snippet: `逐人个性化：${rec.recipient}` });
			sent.push(rec.recipient);
		} else {
			failed.push({ name: rec.recipient, why: r.timedOut ? "超时" : (r.stderr.trim() || r.stdout.trim()).split("\n")[0]!.slice(0, 120) });
		}
	}
	return { sent, failed, skipped };
}

export interface PersonHit {
	userId: string;
	name: string;
	/** 搜索接口自带的附加信息（aisearch 只给职务/工号，部门靠 parseOrgInfo 补） */
	extra: string;
	/** 单聊 ID（aisearch 与 CLI 候选都给；用于把预检结果对回人） */
	openId?: string;
}

/** 从候选对象里取人名：aisearch 把名字放在 meta.name / author / title，通讯录接口放在 name */
const pickStr = (...vals: unknown[]): string => {
	for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
	return "";
};

/** 从 aisearch person 输出宽松提取人员候选（兼容字段层级变化）：收集所有含 userId 的对象 */
export function parsePeople(text: string): PersonHit[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return [];
	}
	const found = new Map<string, PersonHit>();
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (typeof v !== "object" || v === null) return;
		const o = v as Record<string, unknown>;
		const uid = ci(o, "userId");
		if (typeof uid === "string" && uid) {
			const meta = ci(o, "meta");
			const m = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
			const jobNumber = pickStr(ci(m, "jobNumber"));
			const extra = [pickStr(ci(m, "position"), ci(o, "position"), ci(o, "department"), ci(o, "dept")), jobNumber ? `工号 ${jobNumber}` : ""]
				.filter(Boolean)
				.join("｜");
			if (!found.has(uid)) {
				found.set(uid, {
					userId: uid,
					name: pickStr(ci(m, "name"), ci(o, "name"), ci(o, "userName"), ci(o, "author"), ci(o, "title")),
					extra,
					openId: pickStr(ci(o, "openDingTalkId"), ci(o, "openDingtalkId")) || undefined,
				});
			}
		}
		Object.values(o).forEach(walk);
	};
	walk(data);
	return [...found.values()];
}

/** 把 args 里已是 JSON 的对象掏出来（缺省兜底空对象） */
const asObj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/** 组织详情（contact user get）：区别重名靠的就是部门路径 / 职务 / 工号 */
export interface OrgInfo {
	/** 部门全路径名（如 班主任-示例校区班主任） */
	depts: string[];
	title: string;
	jobNumber: string;
	name: string;
}

/** 解析 contact user get 输出（orgEmployeeModel 列表）；参数错/无权限时返回空 Map（富化失败不影响解析主流程） */
export function parseOrgInfo(text: string): Map<string, OrgInfo> {
	const out = new Map<string, OrgInfo>();
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return out;
	}
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (typeof v !== "object" || v === null) return;
		const o = v as Record<string, unknown>;
		const m = asObj(ci(o, "orgEmployeeModel"));
		const uid = pickStr(ci(m, "orgUserId"), ci(o, "orgUserId"));
		if (uid && (ci(m, "depts") !== undefined || ci(m, "orgUserName") !== undefined)) {
			const rawDepts = ci(m, "depts");
			const depts = (Array.isArray(rawDepts) ? rawDepts : [])
				.map((d) => pickStr(ci(asObj(d), "deptPathName"), ci(asObj(d), "deptName")))
				.filter(Boolean);
			out.set(uid, { depts, title: pickStr(ci(m, "orgTitle")), jobNumber: pickStr(ci(m, "jobNumber")), name: pickStr(ci(m, "orgUserName")) });
			return;
		}
		Object.values(o).forEach(walk);
	};
	walk(data);
	return out;
}

/**
 * 人员行：`- 王示例｜班主任-示例校区班主任｜工号 0161… → 016100000000000001`。
 * 无部门且无工号是家长/外部联系人账号的典型特征（实测：家长账号 depts 为空、jobNumber 为 null），
 * 标注出来避免把“唯一匹配”当成本单位教职工。
 */
export function formatPersonLine(p: PersonHit, org?: OrgInfo): string {
	const tag = org
		? [org.depts.join("/"), org.title, org.jobNumber ? `工号 ${org.jobNumber}` : ""].filter(Boolean).join("｜") || "⚠ 无部门/工号（可能是家长或外部联系人账号）"
		: p.extra;
	return `- ${p.name || "（无名）"}${tag ? `｜${tag}` : ""} → ${p.userId}`;
}

/** 从 CLI 解析失败的 JSON 里取出结构化候选（dws 自带的解析链，字段比 aisearch 干净） */
export function parseCliCandidates(text: string): PersonHit[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return [];
	}
	const out: PersonHit[] = [];
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (typeof v !== "object" || v === null) return;
		const o = v as Record<string, unknown>;
		const cands = ci(o, "candidates");
		if (Array.isArray(cands)) {
			for (const c of cands) {
				const cc = asObj(c);
				const uid = pickStr(ci(cc, "userId"));
				if (uid) out.push({ userId: uid, name: pickStr(ci(cc, "name")), extra: "", openId: pickStr(ci(cc, "openDingTalkId")) || undefined });
			}
			return;
		}
		Object.values(o).forEach(walk);
	};
	walk(data);
	return out;
}

/** 从群发失败条目里取输入的那个名字（`王示例（"王示例" 匹配到多个用户…）` → `王示例`） */
export function failingName(raw: string): string {
	const cut = raw.search(/[（(]/);
	return (cut > 0 ? raw.slice(0, cut) : raw).trim();
}

/**
 * 从 contact +me 输出取本人身份：发后核验用姓名，自指收件人（我/自己）用 userId 与 openDingTalkId。
 * openDingTalkId 只在本人那个对象及其子树里找——旁支（部门/主管等）的 openDingTalkId 是别人的，
 * 拿错就等于把消息发给别人；找不到就留空，调用方退回按姓名解析。
 */
export function parseSelf(text: string): { name: string; userId: string; openId?: string } | null {
	try {
		const found = parsePeopleLike(JSON.parse(text), (o) => typeof ci(o, "userId") === "string" && typeof ci(o, "name") === "string");
		if (!found.length) return null;
		const me = found[0]!;
		const open = parsePeopleLike(me, (o) => pickStr(ci(o, "openDingTalkId")) !== "")[0];
		return {
			name: String(ci(me, "name")),
			userId: String(ci(me, "userId")),
			openId: open ? pickStr(ci(open, "openDingTalkId")) || undefined : undefined,
		};
	} catch {
		return null;
	}
}

/** 自指词（本人）：这些不是合法查询值，走 contact +me 直接拿本人身份 */
export const isSelfToken = (token: string): boolean => idKindOf(token) === "self";

/** 长数字：既可能是审批编号，也可能是实例 ID——两者写法一样，只能先试反查 */
const isLongDigits = (v: string): boolean => /^\d{15,25}$/.test(v.trim());

/**
 * 名字解析失败（≠ 查无此人）的回报文案：给出真实原因，并说明「原样重试」才是对的下一步，
 * 免得把上游超时读成「名字写错了」而改字或换人。
 */
export function searchFailedNote(scope: string, why: string): string {
	return `搜索「${scope}」失败——这不是查无此人，是查询本身没成功：${why}\n稍后原样重试即可（名字不用改）；连续失败说明 dws 或网络有问题，回报用户，别改名字去猜。`;
}

/** 从 chat +chat-search 输出提取群候选（openConversationId 为稳定 ID） */
export function parseGroups(text: string): { cid: string; name: string; extra: string }[] {
	try {
		const out = parsePeopleLike(JSON.parse(text), (o) => typeof ci(o, "openConversationId") === "string");
		return out.map((o) => {
			const rawName = ci(o, "name") ?? ci(o, "title");
			const mc = ci(o, "memberCount");
			const gt = ci(o, "groupType");
			return {
				cid: String(ci(o, "openConversationId")),
				name: typeof rawName === "string" ? rawName : "",
				extra: [mc !== undefined ? `${mc} 人` : "", typeof gt === "string" ? gt : ""].filter(Boolean).join("/"),
			};
		});
	} catch {
		return [];
	}
}

/** 搜索结果里名字全等的候选（不按模糊匹配挑：按「教案」搜会先返回「项目六 教案」之类） */
export function pickNameMatches(data: unknown, token: string): { id: string; kind: string; url: string }[] {
	const want = token.trim();
	const out: { id: string; kind: string; url: string }[] = [];
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		const o = v as Record<string, unknown>;
		const id = [o.nodeId, o.dentryUuid, o.docId].find((x) => typeof x === "string" && x);
		const name = [o.name, o.fileName, o.title].find((x) => typeof x === "string" && x);
		if (typeof id === "string" && typeof name === "string" && name.trim() === want) {
			out.push({ id, kind: String(o.docType ?? o.type ?? o.nodeType ?? ""), url: String(o.url ?? "") });
		}
		Object.values(o).forEach(walk);
	};
	walk(data);
	return out;
}

/** 同名候选的消歧清单：文档/表格/文件都可能在多个文件夹里重名，取第一个就是改错对象 */
export function formatAmbiguous(token: string, cands: { id: string; kind: string; url: string }[]): string {
	const lines = cands.map((c) => `\n- ${c.kind || "对象"}｜${c.url || "（无链接）"} → ${c.id}`);
	return `「${token}」有 ${cands.length} 个同名对象：按类型/链接确认是哪一个，把该项换成对应的 ID 重调：${lines.join("")}`;
}

/** 群名精确匹配（chat-search 结果经 parseGroups 后按 name 全等过滤） */
export function matchGroupsByName(list: { cid: string; name: string; extra: string }[], token: string): { cid: string; name: string; extra: string }[] {
	return list.filter((g) => g.name === token.trim());
}

/**
 * 解析消息文本里的钉盘/云盘分享引用。
 * 这类消息（老师转发的钉盘文件/文件夹）resourceRefs 给的是 `238322429838&type=file`
 * （数字 dentryId、缺 spaceId），走 +messages-resource-download 报 TABLE_NOT_FOUND；
 * 真正能下载的 spaceId 藏在正文的 yunpan 链接里。
 */
export function parseDriveRefs(text: string): { spaceId: string; fileId: string; type: string }[] {
	const seen = new Set<string>();
	const out: { spaceId: string; fileId: string; type: string }[] = [];
	const push = (spaceId: string, fileId: string, type: string) => {
		const k = `${spaceId}|${fileId}|${type}`;
		if (seen.has(k)) return;
		seen.add(k);
		out.push({ spaceId, fileId, type });
	};
	// ① 完整链接：spaceId=..&fileId=..&type=file|folder
	const full = /spaceId=(\d+)&(?:amp;)?fileId=(\d+)&(?:amp;)?type=(file|folder)/g;
	for (const m of text.matchAll(full)) push(m[1]!, m[2]!, m[3]!);
	// ② 裸 resource id："238322429838&type=file"（缺 spaceId，只能识别、不可下载）
	const bare = /["'](\d{6,})&type=(file|folder)["']/g;
	for (const m of text.matchAll(bare)) push("", m[1]!, m[2]!);
	return out;
}

/** 大小写不敏感地取字段（dws 上游拼写不一致：群成员 openDingtalkId / 消息 openDingTalkId，同一标识） */
export function ci(o: Record<string, unknown>, name: string): unknown {
	if (name in o) return o[name];
	const lower = name.toLowerCase();
	for (const k of Object.keys(o)) {
		if (k.toLowerCase() === lower) return o[k];
	}
	return undefined;
}

/** 结果中是否出现小写 t 变体 */
export function hasLowercaseDingtalkId(text: string): boolean {
	return /openDingtalkId/.test(text);
}

/** 字段拼写自解释提示（实测：群成员接口小写 t、消息接口大写 T；上游不一致，插件不擅自改写数据） */
export function formatFieldSpellingNote(text: string): string {
	if (!hasLowercaseDingtalkId(text)) return "";
	return (
		"\n\nℹ️ 字段拼写：本结果所在接口返回 openDingtalkId（小写 t），消息等接口返回 openDingTalkId（大写 T）——" +
		"同一标识，读取时两种拼写都要认（dws 上游命名不一致，插件不擅自改写返回数据）。"
	);
}

/** 消息是否为「文件夹」形式（钉钉只给一句 display text，无任何引用字段，无法读取） */
export function isFolderMessage(text: string): boolean {
	return /\[文件夹\]/.test(text);
}

/** 钉盘引用的下载指引（附加在只读查询结果尾部） */
export function formatDriveRefs(refs: { spaceId: string; fileId: string; type: string }[]): string {
	if (!refs.length) return "";
	const lines = refs.map((r) => {
		if (!r.spaceId) {
			return `- ${r.fileId}（type=${r.type}）：只有数字 dentryId、缺 spaceId，插件下载不了；spaceId 在正文的 yunpan 链接里，或让对方重发。`;
		}
		if (r.type === "folder") {
			return `- 文件夹 spaceId=${r.spaceId} fileId=${r.fileId}：用 dingtalk_file（action="fetch", link="<消息原文>"）镜像到本地`;
		}
		return `- 文件 spaceId=${r.spaceId} fileId=${r.fileId}：用 dingtalk_file（action="fetch", link="<消息原文>"）下载`;
	});
	return `\n\n🔗 钉盘/云盘分享资源（这类消息要走钉盘下载，不能当消息附件下）：\n${lines.join("\n")}`;
}

/** 查消息附带下载（--download-resources）的落地情况：告诉模型文件在哪，没下下来的别再试 */
export function formatResourceDownloads(stdout: string, dir: string): string {
	const count = (re: RegExp) => Number(re.exec(stdout)?.[1] ?? 0);
	const ok = count(/"downloadedCount"\s*:\s*(\d+)/);
	const lost = count(/"failedCount"\s*:\s*(\d+)/);
	if (ok && lost) return `\n\n📎 消息附件：${ok} 个已下载到 ${dir}（JSON 里的 localPath 即文件路径，可直接 read），${lost} 个没下下来——失败的那些不要反复重试。`;
	if (ok) return `\n\n📎 消息里的图片/语音/文件已下载到 ${dir}（JSON 里的 localPath 即文件路径，可直接用 read 工具读）。`;
	if (lost) return `\n\n⚠️ 消息里有 ${lost} 个附件没下下来（本地磁盘不支持硬链接时 dws 的原子落盘会失败，临时区重试也没成）——本地没有这些文件，别反复重试，如实告诉用户。`;
	return "\n\n📎 本次消息里没有可下载的附件。";
}

/** 递归收集满足谓词的对象（仅取 userId/name 等稳定字段，不猜层级） */
function parsePeopleLike(v: unknown, pred: (o: Record<string, unknown>) => boolean): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	const walk = (x: unknown): void => {
		if (Array.isArray(x)) return x.forEach(walk);
		if (typeof x !== "object" || x === null) return;
		const o = x as Record<string, unknown>;
		if (pred(o)) out.push(o);
		Object.values(o).forEach(walk);
	};
	walk(v);
	// 按 openConversationId/userId 去重（拼写不敏感）
	const seen = new Set<string>();
	return out.filter((o) => {
		const k = String(ci(o, "openConversationId") ?? ci(o, "userId") ?? "");
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/** 自动附加 --format json 与 -y（调用方未显式给出时；--dry-run 与 --yes 互斥，预览时不加 -y） */
export function buildArgv(args: string[]): string[] {
	const has = (...flags: string[]) => args.some((a) => flags.includes(a) || flags.some((f) => a.startsWith(`${f}=`)));
	const out = [...args];
	if (!has("--format", "-f")) out.push("--format", "json");
	if (!has("--yes", "-y") && !has("--dry-run")) out.push("--yes");
	return out;
}

/* ============================== 官方技能文档（只读知识，非执行通道） ============================== */

/** 从 SKILL.md frontmatter 取 description（缺失时回落到首个非空正文行） */
export function parseSkillDescription(md: string): string {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
	if (m) {
		const d = /^description:\s*(.+)$/m.exec(m[1]!);
		if (d) return d[1]!.trim().replace(/^["']|["']$/g, "");
	}
	for (const line of md.split(/\r?\n/)) {
		const t = line.trim();
		if (t && !t.startsWith("#") && !t.startsWith("---")) return t;
	}
	return "";
}

/** 技能索引文本（一行一个）；dws_skill 的无参形态，替代被过滤的系统提示词技能清单 */
export function formatSkillIndex(entries: { name: string; description: string }[], maxPerDesc = 160): string {
	if (!entries.length) return "（未发现可用技能）";
	const lines = entries.map((e) => {
		const d = e.description.length > maxPerDesc ? `${e.description.slice(0, maxPerDesc)}…` : e.description;
		return `- ${e.name}：${d || "（无描述）"}`;
	});
	return `可用技能 ${entries.length} 个（完整正文按需加载：dws_skill topic=\"<短名>\"）：\n${lines.join("\n")}`;
}

/* ============================== dws 进程执行 ============================== */

let cachedBin: { path: string; shell: boolean } | null = null;

/** 解析 dws 二进制：配置覆盖 → npm 全局常见位置 → PATH（Windows 的 .cmd 垫片需走 shell） */
function resolveDws(cfg: BridgeConfig): { path: string; shell: boolean } {
	if (cachedBin) return cachedBin;
	const candidates: string[] = [];
	if (cfg.dwsPath) candidates.push(cfg.dwsPath);
	const nm = ["npm", "node_modules", "dingtalk-workspace-cli", "vendor", process.platform === "win32" ? "dws.exe" : "dws"];
	if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, ...nm));
	candidates.push(path.join("/usr/local/lib", ...nm), path.join("/opt/homebrew/lib", ...nm));
	for (const c of candidates) {
		try {
			if (fs.existsSync(c)) return (cachedBin = { path: c, shell: false });
		} catch { /* 下一个 */ }
	}
	return (cachedBin = { path: "dws", shell: process.platform === "win32" });
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** 本地命令树探测：dws <路径> --help（只读、不触服务调用）——判断某个 CLI 路径是否真实存在 */
async function cliPathExists(cfg: BridgeConfig, cliPath: string): Promise<boolean> {
	const toks = cliPath.trim().split(/\s+/).filter(Boolean);
	if (!toks.length) return false;
	try {
		const r = await runDws(cfg, [...toks, "--help"]);
		const out = (r.stdout || r.stderr).trim();
		if (r.timedOut || !out) return false;
		return !/"category"\s*:\s*"validation"/.test(out) && !/unknown command/i.test(out);
	} catch {
		return false;
	}
}

/** 产品的工具表（canonical_path / cli_path 对照）——schema 路径容错与报错时的映射表都用它 */
async function productTools(cfg: BridgeConfig, product: string): Promise<Array<Record<string, unknown>>> {
	try {
		const r = await runDws(cfg, ["schema", product, "--compact", "--format", "json"]);
		if (r.timedOut || r.code !== 0) return [];
		const doc = JSON.parse(r.stdout) as Record<string, unknown>;
		const tools = (doc.tools ?? (doc.product as Record<string, unknown> | undefined)?.tools) as unknown;
		return Array.isArray(tools) ? (tools as Array<Record<string, unknown>>) : [];
	} catch {
		return [];
	}
}


/**
 * 把「像路径的」写法解析成可执行的 cli_path：先 schema 直查（canonical 与 cli_path 都认），
 * 再拿同产品的工具表归一（技能文档的旧写法与 schema 的 cli_path 只差分隔符与组名）。
 */
async function resolveCliPath(cfg: BridgeConfig, pathSpec: string): Promise<{ cliPath: string; canonical: string } | null> {
	const direct = await runDws(cfg, ["schema", pathSpec, "--compact", "--format", "json"]);
	if (direct.code === 0) {
		const meta = parseCmdMeta(direct.stdout || direct.stderr);
		if (meta?.cliPath) return { cliPath: meta.cliPath, canonical: meta.canonicalPath };
	}
	const product = (parseCanonicalPath(pathSpec)?.product ?? pathSpec.split(/[\s.]+/)[0] ?? "").trim();
	const tools = product ? await productTools(cfg, product) : [];
	const idx = tools.length ? matchToolByPath(tools, pathSpec) : -1;
	if (idx < 0) return null;
	const hit = tools[idx]!;
	const cliPath = String(hit.cli_path ?? "");
	return cliPath ? { cliPath, canonical: String(hit.canonical_path ?? "") } : null;
}

function runDws(cfg: BridgeConfig, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResult> {
	const bin = resolveDws(cfg);
	return new Promise((resolveP, reject) => {
		const child = spawn(bin.path, args, { shell: bin.shell, windowsHide: true, cwd: opts?.cwd });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, opts?.timeoutMs ?? cfg.execTimeoutMs);
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new Error(`dws 启动失败：${e.message}（可设 ~/.pi/agent/dingtalk-bridge.json 的 dwsPath 覆盖路径）`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveP({ code: code ?? -1, stdout, stderr, timedOut });
		});
	});
}

// ---------------------------------------------------------------------------
// 落盘类命令在非 NTFS 卷（exFAT / 某些网络盘）上的自动重试
//
// dws 下载资源用「写 .part 临时文件 → 硬链接到正式名」做原子发布（link 天然实现
// “不覆盖同名文件”）；硬链接需要 NTFS，exFAT 上必然报 `link …: Incorrect function`。
// 这里不改正常路径：只有命中「硬链接发布失败 + 该命令确实会往本地写文件」时，才改在
// 系统临时区（os.tmpdir()，通常在 NTFS 主盘）重跑一次，再把产物搬回用户原本要的位置。
// 属于落盘类的判定不靠手写命令清单：argv 带输出类 flag + schema 参数表确认 + 只读命令
// （写命令宁可漏重试，也不自动重放）。
// ---------------------------------------------------------------------------

/** 落盘类命令白名单：自动重试只对这些命令开放（下载幂等，重试不会重复发送） */
const DOWNLOAD_PREFIXES: string[][] = [
	["chat", "+messages-resource-download"],
	["chat", "+messages-mget"],
	["chat", "+messages-mdownload"],
	["drive", "+download"],
	["drive", "download"],
	["drive", "pull"],
];

/** 是否为落盘（下载）类命令（快路径；schema 确认不了时也用它兼底） */
export function isDownloadCommand(args: string[]): boolean {
	if (args.includes("--download-resources")) return true;
	return DOWNLOAD_PREFIXES.some((p) => p.every((v, i) => args[i] === v));
}

/** 输出类 flag（argv 形态）：带上任一即说明命令会往本地磁盘写文件 */
const OUTPUT_FLAGS = ["--output", "--output-dir", "--local-folder", "--transcript-output"];

/** argv 里是否带输出类 flag */
export function hasOutputFlag(args: string[]): boolean {
	return args.some((a) => OUTPUT_FLAGS.includes(a.split("=")[0] ?? ""));
}

/** schema 参数表是否坐实了它往本地写文件（只读命令才允许自动重放） */
export function schemaSaysLocalOutput(schema: { params?: string[]; meta?: { effect?: string } } | null): boolean {
	if (!schema || !Array.isArray(schema.params)) return false;
	if (schema.meta?.effect && schema.meta.effect !== "read") return false;
	return schema.params.some((p) => OUTPUT_FLAGS.includes(`--${p}`));
}

/** 按命令性质选超时：落盘类抬高上限 */
const execTimeoutOf = (cfg: BridgeConfig, args: string[]): number =>
	isDownloadCommand(args) || hasOutputFlag(args) ? Math.max(cfg.execTimeoutMs, DOWNLOAD_TIMEOUT_MS) : cfg.execTimeoutMs;

/** dws 本地发布失败（.part 硬链接到正式名）：exFAT/网络盘等不支持硬链接的卷上必然出现 */
export function isLinkPublishFailure(output: string): boolean {
	return /Incorrect function/i.test(output) && /(link|发布消息资源失败)/i.test(output);
}

/**
 * 是否该改到系统临时区重试：输出里出现硬链接发布失败 且 该命令确实会往本地写文件。
 * 不看退出码：查消息附带下载（--download-resources）把失败写进结果 JSON（exit 0），
 * 只有单独调 +messages-resource-download 才返回非 0。重试幂等（失败那次不落任何文件）。
 */
export async function shouldRetryRedirect(cfg: BridgeConfig, args: string[], output: string): Promise<boolean> {
	if (!isLinkPublishFailure(output)) return false;
	if (isDownloadCommand(args)) return true;
	if (!hasOutputFlag(args)) return false;
	return schemaSaysLocalOutput(await commandSchema(cfg, args));
}

/** 输出目标：rel = 保留的相对路径（换 cwd 执行后产出落在临时区同一位置）；undefined = 已改写成临时区绝对值 */
export interface RedirectTarget {
	flag: string;
	rel?: string;
	/** 用户视角的落盘目标（文件或目录，按原值解析） */
	targetAbs: string;
}

/**
 * 把输出 flag 指向临时区：相对路径原样保留（靠换 cwd 落到临时区），绝对路径与
 * --local-folder 改成临时区绝对值。不猜「文件还是目录」——搬回时按产出物本身判断。
 */
export function redirectOutputFlags(
	args: string[],
	tempRoot: string,
	baseDir: string,
): { argv: string[]; targets: RedirectTarget[] } {
	const argv = [...args];
	const targets: RedirectTarget[] = [];
	const note = (flag: string, v: string) => {
		const moved = path.isAbsolute(v) || flag === "--local-folder";
		targets.push({ flag, ...(moved ? {} : { rel: v }), targetAbs: path.resolve(baseDir, v) });
		return moved;
	};
	for (let i = 0; i < argv.length; i++) {
		for (const f of OUTPUT_FLAGS) {
			const eq = `${f}=`;
			if (argv[i] === f) {
				if (note(f, argv[i + 1] ?? ".")) argv[i + 1] = tempRoot;
			} else if (argv[i].startsWith(eq)) {
				const v = argv[i].slice(eq.length);
				if (note(f, v)) argv[i] = eq + tempRoot;
			}
		}
	}
	return { argv, targets };
}

/** 递归复制目录内容（目标已存在且不许覆盖时跳过；dws 的 .part 残留不搬） */
function copyTree(src: string, dest: string, overwrite: boolean): { copied: number; skipped: string[] } {
	const skipped: string[] = [];
	let copied = 0;
	const walk = (s: string, d: string) => {
		fs.mkdirSync(d, { recursive: true });
		for (const e of fs.readdirSync(s, { withFileTypes: true })) {
			const sp = path.join(s, e.name);
			const dp = path.join(d, e.name);
			if (e.isDirectory()) walk(sp, dp);
			else if (e.isFile()) {
				if (/\.part-\d+$/.test(e.name)) continue;
				if (fs.existsSync(dp) && !overwrite) {
					skipped.push(dp);
					continue;
				}
				fs.copyFileSync(sp, dp);
				copied++;
			}
		}
	};
	walk(src, dest);
	return { copied, skipped };
}

/** 把一处产出搬回目标：按产出物本身是文件还是目录决定落法（不猜用户给的是文件还是目录） */
function copyEntry(src: string, dest: string, overwrite: boolean): { copied: number; skipped: string[] } {
	let st: fs.Stats;
	try {
		st = fs.statSync(src);
	} catch {
		return { copied: 0, skipped: [] }; // dws 没产出（该 flag 本次没用到）
	}
	if (st.isDirectory()) return copyTree(src, dest, overwrite);
	// 文件：目标是既有目录时放进目录里（与 dws 把 --output 当目录用的行为一致）
	const to = fs.existsSync(dest) && fs.statSync(dest).isDirectory() ? path.join(dest, path.basename(src)) : dest;
	if (fs.existsSync(to) && !overwrite) return { copied: 0, skipped: [to] };
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.copyFileSync(src, to);
	return { copied: 1, skipped: [] };
}

/** p 是否在 dir 之下（含自身） */
const isUnder = (p: string, dir: string): boolean => {
	const rel = path.relative(dir, p);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** 需要改写成用户视角的本地路径键（dws 两个家族各用各的名字） */
const LOCAL_PATH_KEYS = new Set(["localPath", "savedPath"]);

/**
 * 把结果 JSON 里的本地路径从「临时区视角」改写成「用户视角（相对工作目录）」：
 * 保留相对路径的 flag 与工作目录同构（原样保留）；绝对目标（含 --local-folder）按目标目录换算。
 */
export function relocateLocalPaths(stdout: string, tempRoot: string, targets: RedirectTarget[], baseDir: string): string {
	const pick = (abs: string): RedirectTarget | undefined =>
		targets.find((t) => t.rel !== undefined && isUnder(abs, path.resolve(tempRoot, t.rel))) ??
		targets.find((t) => t.rel === undefined) ??
		targets[targets.length - 1];
	try {
		const parsed: unknown = JSON.parse(stdout);
		const fix = (o: unknown): void => {
			if (Array.isArray(o)) {
				for (const v of o) fix(v);
				return;
			}
			if (!o || typeof o !== "object") return;
			for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
				if (LOCAL_PATH_KEYS.has(k) && typeof v === "string") {
					const abs = path.resolve(tempRoot, v);
					const t = pick(abs);
					const user = !t
						? abs
						: t.rel === undefined
							? path.join(t.targetAbs, path.relative(tempRoot, abs))
							: path.resolve(baseDir, path.relative(tempRoot, abs));
					(o as Record<string, unknown>)[k] = path.relative(baseDir, user).split(path.sep).join("/");
				} else fix(v);
			}
		};
		fix(parsed);
		return JSON.stringify(parsed, null, 2);
	} catch {
		return stdout; // 非 JSON 输出原样返回（搬回来的文件仍在目标目录里）
	}
}

/** 清理 dws 失败时要留下的 `.part-<随机数>` 残留（仅限目标目录顶层） */
function cleanPartFiles(dir: string): void {
	try {
		for (const f of fs.readdirSync(dir)) {
			if (/\.part-\d+$/.test(f)) removePath(path.join(dir, f));
		}
	} catch {
		/* 目录不可读就算了 */
	}
}

/**
 * 重跑落盘命令：输出改到系统临时区并搬回目标目录。
 * 调用方负责把门：只对下载类命令、且已确认是硬链接失败时才调。返回 null = 重试也没成。
 */
async function runDwsRedirected(
	cfg: BridgeConfig,
	args: string[],
	baseDir: string,
	overwrite: boolean,
): Promise<{ result: RunResult; copied: number; skipped: string[]; targets: string[] } | null> {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dws-dl-"));
	try {
		const { argv, targets } = redirectOutputFlags(args, tempRoot, baseDir);
		if (!targets.length) targets.push({ flag: "--output", rel: ".", targetAbs: baseDir });
		const result = await runDws(cfg, argv, { cwd: tempRoot, timeoutMs: execTimeoutOf(cfg, argv) });
		// 临时区也不支持硬链接时（软失败也可能 exit 0）就当重试失败，保留原输出与失败明细
		if (result.code !== 0 || isLinkPublishFailure(result.stdout + result.stderr)) return null;
		let copied = 0;
		const skipped: string[] = [];
		const dirs = new Set<string>();
		try {
			for (const t of targets) {
				const src = t.rel === undefined ? tempRoot : path.resolve(tempRoot, t.rel);
				const r = copyEntry(src, t.targetAbs, overwrite);
				copied += r.copied;
				skipped.push(...r.skipped);
				dirs.add(fs.existsSync(t.targetAbs) && fs.statSync(t.targetAbs).isDirectory() ? t.targetAbs : path.dirname(t.targetAbs));
			}
		} catch {
			return null; // 搬回失败（盘满/只读/单文件超目标文件系统上限）：保留原输出，别假装已搬回
		}
		for (const d of dirs) cleanPartFiles(d);
		const stdout = relocateLocalPaths(result.stdout, tempRoot, targets, baseDir);
		return { result: { ...result, stdout }, copied, skipped, targets: targets.map((t) => t.targetAbs) };
	} finally {
		removePath(tempRoot);
	}
}

/** 用户是否显式要求覆盖（决定搬回时是否覆盖同名文件） */
function wantsOverwrite(args: string[]): boolean {
	return args.some((a) => a === "--overwrite" || a.startsWith("--overwrite="));
}

let cachedSelf: ReturnType<typeof parseSelf> | undefined;
/** 本人身份（惰性获取并缓存）：发后核验用姓名，自指收件人（我/自己）用 userId 与 openDingTalkId */
/** 当前账号所在企业的 corpId；读不到给空串，由调用方决定要不要报错 */
let cachedCorpId: string | undefined;
async function corpIdOf(cfg: BridgeConfig): Promise<string> {
	if (cachedCorpId !== undefined) return cachedCorpId;
	try {
		const r = await runDws(cfg, ["profile", "list", "--format", "json"]);
		const data = r.code === 0 ? (JSON.parse(r.stdout) as { currentProfile?: string }) : null;
		// currentProfile 形如「corpId:userId」
		cachedCorpId = data?.currentProfile?.split(":")[0] ?? "";
	} catch {
		cachedCorpId = "";
	}
	return cachedCorpId;
}

async function whoAmI(cfg: BridgeConfig): Promise<ReturnType<typeof parseSelf>> {
	if (cachedSelf !== undefined) return cachedSelf;
	try {
		const r = await runDws(cfg, ["contact", "+me", "--format", "json"]);
		cachedSelf = r.code === 0 ? parseSelf(r.stdout) : null;
	} catch {
		cachedSelf = null;
	}
	return cachedSelf;
}

/** 命令元数据：本地缓存优先，未命中再问 CLI（~2.5s，只对首次出现的新命令付一次）；缓存值兼容旧版（旧值只存 meta，无参数表则不校验 flag） */
async function commandSchema(cfg: BridgeConfig, args: string[]): Promise<CmdSchema | null> {
	const key = cliPathOf(args);
	if (!key) return null;
	const cache = loadJsonConfig<Record<string, CmdSchema>>(SCHEMA_CACHE_FILE, {}, (v): v is Record<string, CmdSchema> => typeof v === "object" && v !== null);
	const hit = cache[key];
	if (hit && Array.isArray(hit.params)) return hit;
	try {
		const r = await runDws(cfg, ["schema", "--cli-path", key, "--compact", "--format", "json"]);
		if (r.timedOut || r.code !== 0) {
			// 旧缓存尚存 meta 时沿用，别让一次网络抖动丢掉已知的分档
			return hit && hit.meta ? { ...hit, params: [] } : null;
		}
		const text = r.stdout || r.stderr;
		const meta = parseCmdMeta(text);
		if (!meta) return hit && hit.meta ? { ...hit, params: hit.params ?? [] } : null;
		const schema: CmdSchema = { meta, params: parseCmdParams(text) };
		cache[key] = schema;
		saveJsonConfig(SCHEMA_CACHE_FILE, cache);
		return schema;
	} catch {
		return hit && hit.meta ? { ...hit, params: hit.params ?? [] } : null;
	}
}

/** 分档：明显只读的直接放行，其余问元数据（取不到就当写入，宁多一次确认不放过写操作） */
async function classifyCommand(
	cfg: BridgeConfig,
	args: string[],
): Promise<{ tier: Tier; why: string; meta: CmdMeta | null; schema: CmdSchema | null; unknownPath: boolean }> {
	if (presumedRead(args)) return { tier: "read", why: "只读", meta: null, schema: null, unknownPath: false };
	const schema = await commandSchema(cfg, args);
	const meta = schema?.meta ?? null;
	const { tier, why } = tierOf(args, meta);
	if (meta) return { tier, why, meta, schema, unknownPath: false };
	// 不在 schema 身份集里的路径（技能文档记的本地命令写法）与根本不存在的路径要分开：
	// 后者不能伪装成发送类，否则会在标签/防重发一堆与命令无关的校验上报错
	if (!(await cliPathExists(cfg, cliPathOf(args)))) return { tier, why, meta, schema, unknownPath: true };
	return { tier, why: `${why}（不在 dws 的 schema 身份集里：参数表与可用性元数据未知）`, meta, schema, unknownPath: false };
}

/** 「记住这类操作」按 cli_path 记（稳定、可解释，比正则好维护） */
const rememberedKey = (args: string[]): string => cliPathOf(args);
const isRemembered = (cfg: BridgeConfig, args: string[]): boolean => cfg.remembered.includes(rememberedKey(args));
function rememberCommand(cfg: BridgeConfig, args: string[]): void {
	const key = rememberedKey(args);
	if (!key || cfg.remembered.includes(key)) return;
	cfg.remembered.push(key);
	saveJsonConfig(CONFIG_FILE, cfg);
}

/** 从 +messages-mget 输出取"撤回对象摘要"（会话/时间/发送者/正文预览） */
export function parseMessageDigest(text: string): { conversationId: string; preview: string; createTime: string; sender: string }[] {
	try {
		const data = JSON.parse(text) as { messages?: Array<Record<string, unknown>> };
		return (data.messages ?? []).map((m) => ({
			conversationId: typeof m.conversationId === "string" ? m.conversationId : "",
			preview: typeof m.text === "string" ? m.text.replace(/\s+/g, " ").trim().slice(0, 90) : "",
			createTime: typeof m.createTime === "string" ? m.createTime : "",
			sender: typeof m.sender === "string" ? m.sender : "",
		}));
	} catch {
		return [];
	}
}

/** 从 conversation-info 输出取会话名与类型（单聊标题就是对方姓名） */
export function parseConversationInfo(text: string): { cid: string; title: string; singleChat: boolean; memberCount: number } | null {
	try {
		const info = (JSON.parse(text) as { result?: { conversationInfo?: Record<string, unknown> } }).result?.conversationInfo;
		if (!info) return null;
		return {
			cid: typeof info.openConversationId === "string" ? info.openConversationId : "",
			title: typeof info.title === "string" ? info.title : "",
			singleChat: info.singleChat === true,
			memberCount: typeof info.memberCount === "number" ? info.memberCount : 0,
		};
	} catch {
		return null;
	}
}

/** 消息上下文（会话名 + 摘要）：撤回与转 DING 的面板都要说清“动的是哪条” */
async function messageContext(
	cfg: BridgeConfig,
	msgIds: string[],
): Promise<{ where: string; digest: ReturnType<typeof parseMessageDigest> }> {
	try {
		const r = await runDws(cfg, ["chat", "+messages-mget", "--msg-ids", msgIds.join(","), "--format", "json"]);
		const digest = r.code === 0 ? parseMessageDigest(r.stdout) : [];
		const cid = digest[0]?.conversationId;
		let where = "该会话";
		if (cid) {
			const c = await runDws(cfg, ["chat", "conversation-info", "--group", cid, "--format", "json"]);
			const info = c.code === 0 ? parseConversationInfo(c.stdout) : null;
			if (info?.title) where = `${info.title}${info.singleChat ? " 的单聊" : `（${info.memberCount} 人群）`}`;
		}
		return { where, digest };
	} catch {
		return { where: "该会话", digest: [] };
	}
}

/** 弹窗富化走哪条路：转 DING 与撤回都带消息 ID，但面板要说的对象不一样 */
export function reviewKind(args: string[]): "ding" | "recall" | "send" {
	if (matchPrefix(args, DING_BY_MESSAGE_PREFIXES)) return "ding";
	if (matchPrefix(args, RECALL_PREFIXES)) return "recall";
	return "send";
}

/** 审阅前把裸 userId 换成"姓名（部门）"——弹窗里人只认得出名字，认不出 ID（一个都查不到时保留原来的「N 个账号」，不摆裸 ID） */
async function enrichReviewTargets(cfg: BridgeConfig, args: string[], review: PendingDraft["review"]): Promise<PendingDraft["review"]> {
	const msgIds = flagValues(args, RECALL_ID_FLAGS);
	const kind = reviewKind(args);
	// 转 DING：面板要写清“把哪条消息转成了 DING”，对象区不能是消息 ID
	if (msgIds.length && kind === "ding") {
		const { where, digest } = await messageContext(cfg, msgIds);
		if (digest.length) {
			const when = digest[0]!.createTime ? digest[0]!.createTime.slice(5, 16) : "";
			return {
				...review,
				object: `转 DING：${where}${digest.length > 1 ? ` 等 ${digest.length} 条` : ""}${when ? `（${when}）` : ""}的这条消息`,
				sections: [{ kind: "text", label: "原消息", items: digest.map((d) => d.preview || "（图片/文件等无文字消息）") }],
			};
		}
	}
	// 撤回：把“撤的是哪条”写进面板（会话名做主角，时间/条数做次要行，正文进内容区）
	if (msgIds.length && kind === "recall") {
		const { where, digest } = await messageContext(cfg, msgIds);
		if (digest.length) {
			const when = digest[0]!.createTime ? digest[0]!.createTime.slice(5, 16) : "";
			return {
				...review,
				verb: "撤回消息",
				object: `撤回对象：${where}${digest.length > 1 ? ` 等 ${digest.length} 条` : ""}${when ? `（${when}）` : ""}`,
				sections: [{ kind: "text", label: "消息内容", items: digest.map((d) => d.preview || "（图片/文件等无文字消息）") }],
			};
		}
	}
	// 发送：把裸 userId 换成"姓名（部门）"，让主角行直接写人名
	// 收件人里混着姓名（中文）时保持原样：姓名已经是人话，不需要反查，
	// 而且反查只覆盖 ID 项，会把姓名项整个丢掉（实测 38 人混合名单只剩 4 个 ID）
	const all = flagValues(args, TARGET_FLAGS).flatMap((v) => v.split(",")).map((x) => x.trim()).filter(Boolean);
	if (all.some((v) => hasCJK(v))) return review;
	const ids = [...new Set(all)];
	if (!ids.length) return review;
	const orgs = await orgInfoOf(cfg, ids);
	const base = ids.map((id) => orgs.get(id)?.name ?? id);
	// 一个名字都查不到（例如收件人填的是 openDingTalkId）：保留原来的「N 个账号」写法，不把裸 ID 摆进面板
	if (!base.some((n, i) => n !== ids[i])) return review;
	// 部门只在重名时才补（无歧义的名字不占宽度）
	const dup = new Set(base.filter((n, i) => base.indexOf(n) !== i));
	const names = ids.map((id, i) => {
		const o = orgs.get(id);
		const n = base[i]!;
		if (n === id) return "未解析出姓名的账号";
		const dept = o?.depts[0] ? (o.depts[0].split("-").pop() ?? o.depts[0]) : "";
		const short = dept.length > 8 ? `${dept.slice(0, 8)}…` : dept;
		return short && dup.has(n) ? `${n}（${short}）` : n;
	});
	// 名单进主体区块（多列铺满），表头只写人数摘要——几十人不再挤成一行
	const others = review.sections.filter((sec) => sec.kind !== "list");
	return {
		...review,
		object: `收件人：${names.length} 人`,
		sections: [{ kind: "list", label: `收件人（${names.length} 人）`, items: names }, ...others],
	};
}

/**
 * 工具结果：details.kind 为 error/blocked 时置 isError（pi 侧模型与 UI 才识别为失败），
 * 其余（ok/列表/预演）为正常结果。
 */
/** 工具结果是不是失败态（只认 isError / kind=error，blocked 属于「不该做」不重试） */
const isErrored = (out: unknown): boolean => {
	const o = out as { isError?: unknown; details?: { kind?: unknown } } | null;
	return !!o && (o.isError === true || o.details?.kind === "error");
};

const text = (t: string, details: Record<string, unknown> = {}) => {
	const kind = details.kind;
	const failed = kind === "error" || kind === "blocked";
	return {
		content: [{ type: "text" as const, text: t }],
		details,
		...(failed ? { isError: true as const } : {}),
	};
};

/**
 * 用通讯录详情富化候选（部门路径/职务/工号）——重名消歧的关键信息，aisearch 不返回。
 * 富化失败（无权限/超时/参数错）就返回空 Map：不阻断解析主流程，只是少一行信息。
 */
async function orgInfoOf(cfg: BridgeConfig, userIds: string[]): Promise<Map<string, OrgInfo>> {
	const ids = [...new Set(userIds.filter(Boolean))].slice(0, 20);
	if (!ids.length) return new Map();
	try {
		const r = await runDws(cfg, ["contact", "user", "get", "--ids", ids.join(","), "--format", "json"]);
		return r.timedOut || r.code !== 0 ? new Map() : parseOrgInfo(r.stdout);
	} catch {
		return new Map();
	}
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** dws 非零退出的原因行（stderr 优先，退到 stdout）——报错要说清是「执行失败」而不是「没有这个东西」 */
function dwsErrorLine(r: RunResult): string {
	const line = (r.stderr.trim() || r.stdout.trim()).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	return line.slice(0, 160) || `dws 退出码 ${r.code}`;
}

/**
 * 调用链失败的完整说明：dws 的报错是结构化 JSON（category/message/technical_detail/trace_id），
 * 只取第一行往往只剩一个「{」，看不出是上游拒绝还是本地参数错。这里把 message 与
 * technical_detail 摘出来，再附上游原话。
 */
export function dwsFailureNote(r: RunResult, args: string[] = []): string {
	const raw = (r.stderr.trim() || r.stdout.trim());
	let parsed: Record<string, unknown> | null = null;
	const i = raw.indexOf("{");
	if (i >= 0) {
		try {
			const v = JSON.parse(raw.slice(i)) as unknown;
			if (v && typeof v === "object") {
				const outer = v as Record<string, unknown>;
				const err = outer.error && typeof outer.error === "object" ? (outer.error as Record<string, unknown>) : outer;
				parsed = err;
			}
		} catch { /* 不是 JSON：退回文本 */ }
	}
	if (!parsed) return `dws 退出码 ${r.code}：${dwsErrorLine(r)}`;
	const str = (k: string) => (typeof parsed?.[k] === "string" ? (parsed[k] as string) : undefined);
	const parts: string[] = [];
	if (str("category")) parts.push(`[${str("category")}]`);
	parts.push(str("message") ?? str("errorMsg") ?? `dws 退出码 ${r.code}`);
	// 上游业务错的外壳（如 MCP_TOOL_ERROR {...}）藏在 technical_detail 里，没有它无法对症
	if (str("technical_detail")) parts.push(`〔上游原文：${str("technical_detail")}〕`);
	if (str("trace_id")) parts.push(`trace_id=${str("trace_id")}`);
	return parts.join(" ").slice(0, 700);
}

/**
 * 走 CLI 自己的解析链探一个名字（+messages-send --user-query 与 +broadcast 同源，且 API 直接给
 * candidates 数组，不必抠中文报错文案）。只读（--dry-run），不真发。
 */
type TargetProbe = { kind: "ok"; openId: string } | { kind: "ambiguous"; cands: PersonHit[] } | { kind: "none" } | { kind: "unknown" };
async function probeTarget(cfg: BridgeConfig, name: string): Promise<TargetProbe> {
	try {
		const r = await runDws(cfg, ["chat", "+messages-send", "--as", "user", "--user-query", name, "--text", "x", "--dry-run", "--format", "json"]);
		if (r.timedOut) return { kind: "unknown" };
		// 解析失败的 JSON 走 stderr（exit 3），成功计划走 stdout——两边都要认
		const raw = r.stdout.includes("{") ? r.stdout : r.stderr;
		const cands = parseCliCandidates(raw);
		if (cands.length) return { kind: "ambiguous", cands };
		if (r.code === 0) {
			const plan = parseBroadcastPreflight(raw);
			return plan.resolved.length ? { kind: "ok", openId: plan.resolved[0]!.openId } : { kind: "unknown" };
		}
		return /not_found|没有找到/.test(raw) ? { kind: "none" } : { kind: "unknown" };
	} catch {
		return { kind: "unknown" };
	}
}

/** 群发目标里的名字（--to 是逗号分隔，可重复传；去重保序） */
export function targetNames(args: string[]): string[] {
	return [...new Set(flagValues(args, TARGET_FLAGS).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean))];
}

/**
 * dws 在「一个人都没解析出来」时直接 exit 3 且不给计划（只有一句「请检查姓名是否正确」），
 * 这时退回逐名自探：照样出「可发 / 未唯一解析（含候选与部门）」两栏，不把笼统报错用给模型。
 */
async function broadcastProbeReport(cfg: BridgeConfig, args: string[], note: string): Promise<string> {
	const names = targetNames(args);
	const ok: string[] = [];
	const bad: string[] = [];
	let okCount = 0;
	let badCount = 0;
	for (const n of names) {
		if (!hasCJK(n)) {
			okCount++;
			ok.push(`- ${n}（稳定 ID，直接可发）`);
			continue;
		}
		const p = await probeTarget(cfg, n);
		if (p.kind === "ok") {
			okCount++;
			ok.push(`- ${n}（唯一解析 → ${p.openId}）`);
		} else if (p.kind === "ambiguous") {
			badCount++;
			bad.push(`- 「${n}」有 ${p.cands.length} 个同名，需确认是哪一位：`);
			for (const l of await personLines(cfg, p.cands)) bad.push(`  ${l}`);
		} else if (p.kind === "none") {
			badCount++;
			bad.push(`- 「${n}」查无此人（核对用字，或直接把完整手机号当收件人）`);
		} else {
			badCount++;
			bad.push(`- 「${n}」无法确认（解析请求未返回可读结果）`);
		}
	}
	const parts = [
		`🚫 群发预检未通过（未发送任何消息）：${note}`,
		okCount ? `\n可发（${okCount} 人）：\n${ok.join("\n")}` : "",
		badCount ? `\n有问题（${badCount} 人）：\n${bad.join("\n")}` : "",
		`\n${BROADCAST_FIX_GUIDE}`,
	];
	return parts.filter(Boolean).join("\n");
}

/**
 * 多条歧义合并成一次返回。逐个返回会让调用方每个重名试一轮，
 * 一份 38 人名单实测连卡四次；整批扫完一次列全，换 ID 重调一轮就能过。
 */
export function joinAmbiguous(items: string[]): string {
	return items.join("\n\n");
}

/**
 * 同名候选的统一说法。候选行末尾给的是 userId，可直接当收件人重新调用
 * （recipientFlag 会映射成 --user，上游自己换成 openDingTalkId）。
 */
export function formatAmbiguousName(token: string, lines: string[]): string {
	return `「${token}」有 ${lines.length} 个同名，需确认是哪一位：\n${lines.join("\n")}\n用选定的那一位的 ID 作收件人重调。`;
}

/** 候选 + 组织详情 → 行文本列表（解析与群发预检共用） */
async function personLines(cfg: BridgeConfig, people: PersonHit[]): Promise<string[]> {
	const orgs = await orgInfoOf(cfg, people.map((p) => p.userId));
	return people.map((p) => formatPersonLine(p, orgs.get(p.userId)));
}

/**
 * 群发「未能唯一解析」→ 可操作的候选行：多候选的用 CLI 自己的解析链拿候选（与真实发送同源），
 * 再补部门/工号——原来只转 dws 那句笼统报错，看不出该选谁。
 */
async function unresolvedLines(cfg: BridgeConfig, skipped: string[]): Promise<string[]> {
	const lines: string[] = [];
	for (const raw of skipped) {
		const name = failingName(raw);
		const p = name ? await probeTarget(cfg, name) : { kind: "unknown" as const };
		const cands = p.kind === "ambiguous" ? p.cands : [];
		if (!cands.length) {
			lines.push(`- ${raw}`);
			continue;
		}
		lines.push(`- 「${name}」有 ${cands.length} 个同名，需确认是哪一位：`);
		for (const l of await personLines(cfg, cands)) lines.push(`  ${l}`);
	}
	return lines;
}

/** 同名多人的已解析行补部门：光看名字无法确认发给了哪一个，用 openDingTalkId 反查回 userId */
async function dupNameNotes(cfg: BridgeConfig, plan: BroadcastPreflight): Promise<string[]> {
	const counts = new Map<string, number>();
	for (const r of plan.resolved) counts.set(r.recipient, (counts.get(r.recipient) ?? 0) + 1);
	const out: string[] = [];
	for (const [name, n] of counts) {
		if (n < 2) continue;
		const p = await probeTarget(cfg, name);
		if (p.kind !== "ambiguous") continue;
		const want = new Set(plan.resolved.filter((r) => r.recipient === name).map((r) => r.openId));
		const hits = p.cands.filter((c) => c.openId && want.has(c.openId));
		if (!hits.length) continue;
		const orgs = await orgInfoOf(cfg, hits.map((h) => h.userId));
		out.push(`「${name}」重名，本次实际发给：`, ...hits.map((h) => `  ${formatPersonLine(h, orgs.get(h.userId)).replace(/^- /, "")}`));
	}
	return out;
}

function truncateOut(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}\n\n……（输出过长已截断；大结果请用 --jq 过滤或 --fields 选字段）`;
}

/* ============================== 扩展入口 ============================== */

/**
 * 审批附件内容缓存：sha256 → 上传后的引用。
 * 同一个文件反复发起（改金额重提、失败重试、撤稿重报）时靠它复用已上传的那份，
 * 不在钉盘里堆 xxx(1).zip、xxx(2).zip。按「内容 + 文件名」双键匹配：
 * 内容同而名字不同是用户在区分版本，那时应当重传。
 */
const ATTACH_CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "dingtalk-attachments.json");

/** 缓存条目：附件引用 + 上传时的本地文件名（判等只看它，上游会把重名改成 xxx(1).zip） */
type CachedAttachment = AttachmentRef & { localName?: string };

function loadAttachmentCache(): Record<string, CachedAttachment> {
	return loadJsonConfig<Record<string, CachedAttachment>>(ATTACH_CACHE_FILE, {}, (v): v is Record<string, CachedAttachment> => typeof v === "object" && v !== null);
}

function saveAttachmentCache(cache: Record<string, CachedAttachment>): void {
// 只留最近 200 条：这是加速用的缓存，丢了只是多传一次
const keys = Object.keys(cache);
if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete cache[k];
saveJsonConfig(ATTACH_CACHE_FILE, cache);
}

/**
 * 同一份内容要不要重传。判等基准是**本地文件名**而非上游返回名：上游遇重名会自动改名
 * （本地 a.zip → 返回 a(1).zip），拿上游名比永远不相等，缓存会完全失效、每传一次多一份。
 */
export function decideAttachmentReuse(
	name: string,
	prev: (AttachmentRef & { localName?: string }) | undefined,
): { kind: "reuse"; ref: AttachmentRef } | { kind: "upload" } {
	if (prev && (prev.localName ?? prev.fileName) === name) return { kind: "reuse", ref: prev };
	return { kind: "upload" };
}

/** 文件内容指纹（sha256）；读不出来返回 null */
async function sha256File(abs: string): Promise<string | null> {
	try {
		const buf = await fs.promises.readFile(abs);
		return createHash("sha256").update(buf).digest("hex");
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	const state = newExecState();
	const stats = { sent: 0, blocked: 0, resolved: 0 };
	// 启动即恢复台账（新进程/重开会话靠它拦住「重跑一遍发送」）
	loadLedger(cfg, state);

	// L0：从系统提示词注入清单过滤 dingtalk-* 技能（文件不动，/skill:dingtalk-* 仍可手动加载）
	pi.on("before_agent_start", (event) => {
		const opts = event.systemPromptOptions as {
			skills?: { name: string }[];
			promptGuidelines?: string[];
		};
		if (opts.skills?.length) {
			opts.skills = opts.skills.filter(
				(s) => !cfg.blockedSkillPrefixes.some((p) => s.name.startsWith(p)),
			);
		}
		const guidelines = (opts.promptGuidelines ??= []);
		// 业务工具尚未装载：其余规则不注入（由 dingtalk_help 的 promptGuidelines 引导装载）
		if (!pi.getActiveTools().includes("dingtalk_msg")) return;
		const g1 =
			"钉钉操作一律用 dingtalk_* 业务工具：命令与账号 ID 由插件解析，AI 没有直接执行 dws 命令的通道。";
		const g2 =
			"写操作首次只回执行计划：用户在对话里确认后，调用 dingtalk_confirm(draftId) 执行；破坏性与对外发送类还会弹人工确认，无界面会话直接拒绝。";
		const g2b =
			"钉钉写操作不能放在 codemode 脚本里（只读可以）：执行计划必须在对话里直接可见、确认必须是单独的一次调用，脚本里会被拒。";
		const g3 =
			"同名或同名群会返回候选（带部门/职务/工号与账号 ID）：由 AI 自己挑定后，把该项换成候选里的 ID 重调——不要重复猜姓名，也不必转问用户。";
		const g4 =
			"业务工具做不到的钉钉操作：先回报用户（缺什么能力、常用的话建议补进插件），不得照技能文档自行换参数继续试。";
		const g3b =
			"同一份正文发给多人用 action=\"broadcast\" + vars 一次成稿：确认时调 dingtalk_confirm 即可，不要重写正文或变量表，也不要拆成逐人 send（每条都要单独确认）。";
		if (!guidelines.includes(g1)) guidelines.push(g1, g2, g2b, g3, g3b, g4);
	});

	pi.on("session_start", () => {
		state.resolved.clear();
		state.pending.clear();
		state.sent.clear();
		loadLedger(cfg, state);
	});

	// L1：schema 活内省（分层下钻）
/** 消息里分享的钉盘/云盘资源落地（文件直下、文件夹递归镜像）；dingtalk_file action="fetch" 用 */
const fetchDriveShare = async (params: { link?: string; spaceId?: string; nodeId?: string; outDir?: string }, ctx: ExtensionContext) => {
	const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const refs = params.link ? parseDriveRefs(params.link) : [];
	const spaceId = params.spaceId?.trim() || refs.find((r) => r.spaceId)?.spaceId || "";
	const nodeId = params.nodeId?.trim() || refs[0]?.fileId || "";
	if (!nodeId) {
		const hint = isFolderMessage(params.link ?? "")
			? "这是「[文件夹] 名字」形式的分享——钉钉不提供引用，无法下载，请让对方打包 zip 或逐个文件重发。"
			: "请传 link（消息原文/链接）或 spaceId + nodeId。";
		return text(`🚫 ${hint}`, { kind: "error" });
	}
	const rel = params.outDir?.trim() || ".tmp/dingtalk-fetch";
	const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
	if (!abs.startsWith(cwd)) return text(`🚫 outDir 必须在工作目录内：${cwd}`, { kind: "error" });
	fs.mkdirSync(abs, { recursive: true });

	// 元信息：判文件/文件夹（数字 dentryId 需配合 spaceId）
	const infoArgs = ["drive", "+info", "--node", nodeId, ...(spaceId ? ["--space-id", spaceId] : []), "--format", "json"];
	const info = await runDws(cfg, infoArgs);
	let kind = refs[0]?.type ?? "";
	let name = "";
	const infoText = info.stdout || "";
	if (/"type"\s*:\s*"FOLDER"/.test(infoText) || /"isFolder"\s*:\s*true/.test(infoText)) kind = "folder";
	if (kind !== "folder" && /"type"\s*:\s*"(FILE|DOC)"/.test(infoText)) kind = "file";
	const nm = /"name"\s*:\s*"([^"]+)"/.exec(infoText);
	if (nm) name = nm[1]!;

	if (kind === "folder") {
		const pullArgs = ["drive", "pull", "--remote-folder", nodeId, ...(spaceId ? ["--space-id", spaceId] : []), "--local-folder", abs, "--if-exists", "skip", "--yes", "--format", "json"];
		let r = await runDws(cfg, pullArgs, { timeoutMs: execTimeoutOf(cfg, pullArgs) });
		let pullNote = "";
		if (await shouldRetryRedirect(cfg, pullArgs, r.stderr + r.stdout)) {
			const redirected = await runDwsRedirected(cfg, pullArgs, cwd, false);
			if (redirected) {
				r = redirected.result;
				pullNote = `\n\n（本机工作目录所在磁盘不支持硬链接，已自动改在系统临时区镜像并搬回：${redirected.copied} 个文件）`;
			}
		}
		if (r.code !== 0) return text(`文件夹镜像失败（exit ${r.code}）：${(r.stderr || r.stdout).trim().slice(0, 400)}`, { kind: "error" });
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else files.push(p);
			}
		};
		try {
			walk(abs);
		} catch { /* 目录不存在则视为空 */ }
		const list = files.length ? files.map((f) => `  ${f}`).join("\n") : "  （文件夹为空）";
		return text(`✓ 文件夹已镜像${name ? `「${name}」` : ""}到 ${abs}（${files.length} 个文件）：\n${list}\n\n（可直接用 read 工具读这些绝对路径）${pullNote}`, {
			kind: "ok",
			localDir: abs,
			files,
		});
	}

	const dlArgs = ["drive", "download", "--node", nodeId, ...(spaceId ? ["--space-id", spaceId] : []), "--output", abs, "--format", "json"];
	let r = await runDws(cfg, dlArgs, { timeoutMs: execTimeoutOf(cfg, dlArgs) });
	let dlNote = "";
	if (await shouldRetryRedirect(cfg, dlArgs, r.stderr + r.stdout)) {
		// `--output` 这里是绝对路径，重定向执行器按 baseDir 解析后原样返回
		const redirected = await runDwsRedirected(cfg, dlArgs, cwd, true);
		if (redirected) {
			r = redirected.result;
			dlNote = "（本机工作目录所在磁盘不支持硬链接，已自动改在系统临时区下载并搬回）";
		}
	}
	if (r.code !== 0) {
		return text(`下载失败（exit ${r.code}）：${(r.stderr || r.stdout).trim().slice(0, 400)}\n如消息是「[文件夹] 名字」形式，钉钉不提供引用，只能让对方重发。`, { kind: "error" });
	}
	const saved = /"savedPath"\s*:\s*"([^"]+)"/.exec(r.stdout)?.[1] ?? name ?? nodeId;
	const size = /"sizeBytes"\s*:\s*(\d+)/.exec(r.stdout)?.[1];
	const localPath = path.isAbsolute(saved) ? saved : path.join(abs, path.basename(saved));
	return text(`✓ 已下载${name ? `「${name}」` : ""}：${localPath}${size ? `（${Math.round(Number(size) / 1024)} KB）` : ""}\n\n（可直接用 read 工具读此绝对路径）${dlNote}`, {
		kind: "ok",
		localPath,
	});
	};

	const execTool = {
		name: "dws_exec",
		async execute(
			id: string,
			params: { args: string[]; view?: { receivers?: string[]; note?: string; objects?: string[]; target?: string; people?: ResolvedPerson[] }; draft?: PendingDraft },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const view = params.view;
			// 确认模式：dingtalk_confirm 带着草稿复用同一条管线（草稿已完成策略判定与预检，不重跑）
			const draft = params.draft;
			const norm = normalizeContent(params.args);
			const stripped = stripVarsFlags(norm.args);
			const { varsRaw, varsFile } = stripped;
			let args = stripped.args;
			let pathNote = "";
			if (args[0]?.includes(".")) {
				const written = args[0];
				const resolved = await resolveCliPath(cfg, written);
				if (!resolved) {
					stats.blocked++;
					return text(
						`🚫 「${written}」不是插件认识的操作，请把这条操作回报用户。`,
						{ kind: "blocked" }
					);
				}
				args = [...resolved.cliPath.split(" "), ...args.slice(1)];
				pathNote = `（命令路径「${written}」不是可执行的写法，已换成 dws 的 cli_path「${resolved.cliPath}」执行）`;
			}
			const formalIssue = formalFlagError(args);
			if (formalIssue) {
				stats.blocked++;
				return text(`🚫 ${formalIssue}`, { kind: "blocked" });
			}
			const baseDir = ctx?.cwd ?? process.cwd();
			const fileSigs = fileFingerprints(args, baseDir);
			for (const f of flagValues(args, FILE_PATH_FLAGS)) {
				const abs = path.isAbsolute(f) ? f : path.join(baseDir, f);
				if (!fs.existsSync(abs)) {
					return text(`🚫 待发文件不存在：${f}（--file 需为工作目录内相对路径；当前目录 ${baseDir}）`, { kind: "blocked" });
				}
			}
			const { tier, why, meta, schema, unknownPath } = await classifyCommand(cfg, args);
			if (unknownPath) {
				stats.blocked++;
				return text(
					`🚫 插件不认识这个操作（${cliPathOf(args)}）：不在当前覆盖范围内，请把这条操作回报用户。`,
					{ kind: "blocked" }
				);
			}
			// 写档与敏感档的草稿/确认都只能在对话里直接调用：脚本里执行计划被折进脚本输出，
			// 两阶段「人看得见、确认是刻意动作」的设计就失效了；只读不受影响
			if (!draft && codemodeBlocked(id, tier)) {
				stats.blocked++;
				return text(
					"🚫 钉钉写操作不能在 codemode 脚本里发起：执行计划必须在对话里直接可见，确认也必须是单独的工具调用。请把这一步拿到脚本外，直接调用对应工具。",
					{ kind: "blocked" }
				);
			}
			if (!draft) {
				const bad = tier === "read" ? [] : unknownFlags(args, schema?.params ?? []);
				if (bad.length) {
					stats.blocked++;
					return text(
						`🚫 flag 与参数表不符（未生成草稿、未执行）：${bad.join("、")}

本命令可用参数：${schema?.params.map((p) => `--${p}`).join("、") || "（未取到）"}

这是插件覆盖范围内的参数映射问题：请把该操作回报用户，不要自行改参数。`,
						{ kind: "blocked" }
					);
				}
			}
			const placeholders = extractPlaceholders(flagValues(args, CONTENT_FLAGS).at(-1) ?? "");
			// 确认模式带上草稿里的变量表（--vars 在入口就被剥离，草稿 argv 里没有它）
			const runVars = resolveRunVars({ draftVars: draft?.vars, placeholders, varsRaw, varsFile, baseDir });
			let varsMap = runVars.vars;
			if (placeholders.length) {
				// 逐人个性化只对群发生效：其它命令的正文里出现 {{}} 就说明写错了
				const isBroadcast = matchPrefix(args, BROADCAST_PREFIXES);
				if (!isBroadcast && !varsMap) {
					stats.blocked++;
					return text(`🚫 正文里的 {{${placeholders[0]}}} 是按人替换的占位符，目前只在群发（chat +broadcast）下生效；其他命令请直接把正文写好。`, { kind: "blocked" });
				}
				if (runVars.error) {
					stats.blocked++;
					return text(`🚫 ${runVars.error}

${VARS_GUIDE}`, { kind: "blocked" });
				}
				if (draft && !varsMap) {
					stats.blocked++;
					return text(`🚫 这份草稿里没有变量表（正文含占位符 ${placeholders.map((p) => `{{${p}}}`).join("、")}），无法逐人渲染。请重新发起群发并带上 vars。`, { kind: "blocked" });
				}
				if (!varsMap && !isDryRun(args)) {
					stats.blocked++;
					return text(`🚫 正文里有占位符 ${placeholders.map((p) => `{{${p}}}`).join("、")}，但没有给变量表。

${VARS_GUIDE}`, { kind: "blocked" });
				}
			}
			// 确认模式：草稿已过策略判定，只补一次防重发核对（草稿生成后用户可能已直接发过同样内容）
			if (draft && matchPrefix(args, SEND_PREFIXES) && state.sent.has(sendSignature(args, fileSigs))) {
				stats.blocked++;
				return text("🚫 该内容在本会话或近期已发送过（防重发台账），本次不再重复执行。", { kind: "blocked" });
			}
			const decision = draft
				? ({ action: "run" } as ExecDecision)
				: decideExec(args, { tier, meta, why, flags: schema?.params, fileSigs, reviewExtra: view ? { recipients: view.receivers, note: view.note, objects: view.objects, target: view.target } : void 0 }, state, cfg, Date.now());
			const dryRun = isDryRun(args);
			if (decision.action === "block") {
				stats.blocked++;
				let extra = "";
				if (decision.kind === "unavailable" && meta?.cliPath) {
					for (const alias of localAliases(meta.cliPath)) {
						if (await cliPathExists(cfg, alias)) {
							extra = `

另：本地命令树里仍有同一命令的写法「${alias}」，可用它重调（仍走两阶段与执行前确认）。`;
							break;
						}
					}
				}
				return text(`${pathNote ? `${pathNote}

` : ""}🚫 ${decision.reason}${extra}`, { kind: "blocked" });
			}
			if (decision.action === "pending") {
				let broadcastTable = "";
				if (matchPrefix(args, BROADCAST_PREFIXES)) {
					const pre = await runDws(cfg, buildArgv([...args, "--dry-run"]));
					if (pre.timedOut || pre.code !== 0) {
						state.pending.delete(decision.token);
						stats.blocked++;
						const note = pre.timedOut ? "预检超时" : /没有任何人收到消息/.test(pre.stdout) ? "没有一位收件人解析成功" : "dws 未返回可发送计划";
						return text(await broadcastProbeReport(cfg, args, note), { kind: "blocked" });
					}
					const plan = parseBroadcastPreflight(pre.stdout);
					if (!plan.resolved.length || plan.skipped.length) {
						state.pending.delete(decision.token);
						stats.blocked++;
						const skippedLines = (await unresolvedLines(cfg, plan.skipped)).join("\n") || "（dws 未返回可解析的收件人）";
						return text(
							`🚫 群发预检未通过：收件人未全部唯一解析，未生成草稿、未发送任何消息。

${formatBroadcastPreflight(plan)}

未能唯一解析：
${skippedLines}

${BROADCAST_FIX_GUIDE}`,
							{ kind: "blocked" }
						);
					}
					const dupNotes = await dupNameNotes(cfg, plan);
					let sampleLines: string[] = [];
					// 变量表可能写的是 --to 里的 token/姓名（同名消歧后人会变成 userId），先对回人再校验
					const aliases = matchRecipientAliases(plan, view?.people ?? []);
					let varsSample: { recipient: string; text: string }[] = [];
					if (varsMap) {
						const problems = validateVars(plan.resolved.map((r2) => r2.recipient), placeholders, varsMap, aliases);
						if (problems.length) {
							state.pending.delete(decision.token);
							stats.blocked++;
							return text(`🚫 变量表不齐（未生成草稿、未发送任何消息）：
${problems.map((p) => `- ${p}`).join("\n")}

${VARS_GUIDE}`, { kind: "blocked" });
						}
						const content = flagValues(args, CONTENT_FLAGS).at(-1) ?? "";
						varsSample = plan.resolved.map((r2) => ({ recipient: r2.recipient, text: renderVars(content, personalizedRow(varsMap!, r2.recipient, aliases)) }));
						sampleLines = varsSample.slice(0, 3).map((v) => sampleLine(v.recipient, v.text));
					}
					const draft = state.pending.get(decision.token);
					if (draft) {
						draft.review = buildReview(args, meta, why, { recipients: plan.resolved.map((r2) => r2.recipient) });
						if (varsMap) {
							draft.vars = varsMap;
							draft.plan = plan;
							draft.aliases = aliases;
							draft.varsSample = varsSample;
						}
					}
					broadcastTable = varsMap ? `

（逐人个性化：共 ${plan.resolved.length} 条单聊，正文按变量表逐人渲染）
${sampleLines.join("\n")}${plan.resolved.length > sampleLines.length ? `
…（其余 ${plan.resolved.length - sampleLines.length} 人同理）` : ""}${dupNotes.length ? `
${dupNotes.join("\n")}` : ""}` : `

${formatBroadcastPreflight(plan)}${dupNotes.length ? `
${dupNotes.join("\n")}` : ""}
（预检已通过：以上每人各收到一条单聊）`;
				}
				const notes = [
					norm.fixed ? `正文里的 ${norm.fixed} 处字面反斜杠-n 已转为真换行` : "",
					norm.hardBreaks ? `${norm.hardBreaks} 处换行已补 markdown 行尾双空格（钉钉单换行会拼成一行）` : "",
					hasMultilineText(args) ? "纯文本 --text 的多行在钉钉会拼成一行，建议改用 --markdown" : ""
				].filter(Boolean);
				const fixedNote = notes.length ? `

（${notes.join("；")}）` : "";
				return text(
					`${pathNote ? `${pathNote}

` : ""}${decision.preview}${broadcastTable}${fixedNote}`,
					{ kind: "pending", token: decision.token }
				);
			}
			// 确认模式：把草稿里存好的逐人渲染样例再展示一次（确认时人看不到 argv，只看得到这句）
			const varsNote = draft?.varsSample?.length
				? `

（逐人个性化：共 ${draft.varsSample.length} 条单聊，正文按变量表逐人渲染）
${draft.varsSample.slice(0, 3).map((v) => sampleLine(v.recipient, v.text)).join("\n")}${draft.varsSample.length > 3 ? `
…（其余 ${draft.varsSample.length - 3} 人同理）` : ""}`
				: "";
			if (draft?.tier === "sensitive" && !isRemembered(cfg, args)) {
				const outcome = await askReview(ctx, {
					...await enrichReviewTargets(cfg, args, draft.review),
					actions: reviewActions(draft.canRemember),
					// 旁标写人话：记住的仍是 cli_path（rememberedKey），但面板里只出现动作名
					rememberNote: draft.review.verb
				});
				if (outcome.kind === "no-ui") {
					stats.blocked++;
					return text("🚫 这条操作需要你本人确认，但当前会话弹不出确认窗（无界面模式），已拒绝执行。请在带界面的会话里重试。", { kind: "blocked" });
				}
				if (outcome.kind === "rejected") {
					stats.blocked++;
					return text("🚫 用户拒绝了这条操作，未执行。", { kind: "blocked" });
				}
				if (outcome.kind === "remembered") {
					rememberCommand(cfg, args);
					ctx.ui.notify(`dingtalk-bridge：已记住「${rememberedKey(args)}」，以后这类操作不再弹窗（可用 /dws forget 取消）`, "info");
				}
			}
			if (draft?.vars && draft.plan && matchPrefix(args, BROADCAST_PREFIXES)) {
				const res = await sendPersonalized(cfg, args, draft.plan, draft.vars, state, draft.aliases);
				saveLedger(cfg, state);
				stats.sent += res.sent.length;
				const failLines = res.failed.length ? `

失败 ${res.failed.length} 人（未发出，可修好后重发这些人）：
${res.failed.map((f) => `- ${f.name}：${f.why}`).join("\n")}` : "";
				const skipLines = res.skipped.length ? `

已发过、本次跳过 ${res.skipped.length} 人：${res.skipped.join("、")}（同一人同一正文有固定幂等键）` : "";
				return text(
					`✓ 逐人发送完成（共 ${draft.plan.resolved.length} 人）：成功 ${res.sent.length} 人${failLines}${skipLines}${varsNote}`,
					{ kind: "ok", sent: res.sent, skipped: res.skipped, failed: res.failed.map((f) => f.name) }
				);
			}
			// 外发文件统一带时间戳命名（远端名唯一，避开钉盘同名自动改名）；执行用 argv 与签名用 argv 分开
			const stamped = stampOutgoingFiles(args, baseDir, /* @__PURE__ */ new Date());
			const done = <T,>(value: T): T => {
				stamped.cleanup();
				return value;
			};
			let r = await runDws(cfg, buildArgv(stamped.args), { cwd: baseDir, timeoutMs: execTimeoutOf(cfg, args) });
			let redirectNote = "";
			// 硬链接失败可能以 exit 0 + 结果里 failedCount 的形式回来（查消息附带下载就是这种），
			// 所以不靠退出码判断，只看错误文本；重试幂等（第一次失败不落任何文件）
			if (await shouldRetryRedirect(cfg, args, r.stderr + r.stdout)) {
				const redirected = await runDwsRedirected(cfg, buildArgv(stamped.args), baseDir, wantsOverwrite(args));
				if (redirected) {
					r = redirected.result;
					redirectNote = `

（本机工作目录所在磁盘不支持硬链接，已自动改在系统临时区下载并搬回：${redirected.copied} 个文件${redirected.skipped.length ? `，${redirected.skipped.length} 个因已存在未覆盖` : ""}）`;
				}
			}
			if (r.timedOut)
				return done(text(
					`dws 执行超时（${Math.round(execTimeoutOf(cfg, args) / 1e3)}s）${isDownloadCommand(args) ? "：下载可能只是没跑完，目标目录里已落盘的文件仍然有效，别整条重跑" : "，命令可能未生效——如涉及发送，先用只读查询确认，绝不要直接重跑"}${sheetCreateFailureNote(args, r.stdout + r.stderr)}`,
					{ kind: "error" },
				));
			let out = r.stdout.trim();
			const errTail = r.stderr.trim();
			if (r.code !== 0) {
				if (dryRun && matchPrefix(args, BROADCAST_PREFIXES)) {
					return done(text(await broadcastProbeReport(cfg, args, "没有一位收件人解析成功"), { kind: "blocked" }));
				}
				return done(text(`dws 失败（exit ${r.code}）：${dwsFailureNote(r, args)}${sheetCreateFailureNote(args, errTail + out)}`, { kind: "error" }));
			}
			if (dryRun && matchPrefix(args, BROADCAST_PREFIXES)) {
				const plan = parseBroadcastPreflight(out);
				const body = [formatBroadcastPreflight(plan)];
				if (placeholders.length && varsMap) {
					const content = flagValues(args, CONTENT_FLAGS).at(-1) ?? "";
					body.push(
						"",
						`逐人个性化（${placeholders.map((p) => `{{${p}}}`).join("、")}）渲染样例：`,
						...plan.resolved.slice(0, 3).map((r2) => sampleLine(r2.recipient, renderVars(content, personalizedRow(varsMap!, r2.recipient, matchRecipientAliases(plan, view?.people ?? []))))),
						`（共 ${plan.resolved.length} 条单聊，每人正文不同）`
					);
				} else if (placeholders.length) {
					body.push("", `⚠️ 正文含占位符 ${placeholders.map((p) => `{{${p}}}`).join("、")}，正式发送必须带变量表：${VARS_GUIDE}`);
				}
				if (plan.skipped.length) {
					body.push("", "未能唯一解析：", ...await unresolvedLines(cfg, plan.skipped), "", BROADCAST_FIX_GUIDE);
				} else if (plan.resolved.length) {
					body.push("", "（预检通过：以上每人各收到一条单聊；确认后去掉 --dry-run 正式发送）");
				} else {
					body.push("", "（dws 未返回可解析的收件人——检查 --to 是否填了名字）");
				}
				return done(text(`🧪 群发预演（未发送任何消息）

${body.join("\n")}`, { kind: "ok", resolved: plan.resolved, skipped: plan.skipped }));
			}
			if (!dryRun && matchPrefix(args, RECALL_PREFIXES)) {
				const ids = flagValues(args, RECALL_ID_FLAGS);
				state.sent.set(`recall:${ids.join(",")}`, { at: Date.now(), snippet: args.join(" ").slice(0, 80) });
				saveLedger(cfg, state);
				stats.sent++;
				out += `

（已记录撤回：${ids.join("、")}——同一消息不会重复撤回）`;
			} else if (!dryRun && matchPrefix(args, SEND_PREFIXES)) {
				state.sent.set(sendSignature(args, fileSigs), { at: Date.now(), snippet: args.join(" ").slice(0, 80) });
				saveLedger(cfg, state);
				stats.sent++;
				const sentNotes = [
					norm.fixed ? `正文里的 ${norm.fixed} 处字面反斜杠-n 已转为真换行` : "",
					norm.hardBreaks ? `${norm.hardBreaks} 处换行已补 markdown 行尾双空格（钉钉单换行会拼成一行）` : "",
					hasMultilineText(args) ? "纯文本 --text 的多行在钉钉会拼成一行——本次可能已粘连，需要多行请改用 --markdown" : ""
				].filter(Boolean);
				if (sentNotes.length) out += `

（${sentNotes.join("；")}）`;
				const unverified = flagValues(args, TARGET_FLAGS).filter((t) => !state.resolved.has(t) && !hasCJK(t));
				if (unverified.length) {
					out += `

⚠️ 提醒：目标 ${unverified.join("、")} 未经本会话实时解析（可能来自记忆），发送前请核对收件人。`;
				}
				const media = mediaKind(args);
				if (media) {
					out += `

⚠️ 本条是${media === "file" ? "文件" : "媒体"}消息，已发出但**不含任何说明正文**（--title 只作文件卡标题，不在消息里显示）。如用户需要说明文字，请现在另发一条文本消息（action="send" 或发到对应会话）；不要以为说明已随本条发出。`;
				}
				const unverifiedGroup = flagPairs(args, GROUP_FLAGS).filter((p) => !state.resolvedGroups.has(p.value));
				if (unverifiedGroup.length) {
					out += `

⚠️ 提醒：目标群 ${unverifiedGroup.map((p) => p.value).join("、")} 未经本会话实时解析，发送前请核对。`;
				}
				const taskId = /"openTaskId"\s*:\s*"([^"]+)"/.exec(out)?.[1];
				if (taskId) {
					out += `

openTaskId：${taskId}（要用它时可交给 dingtalk_msg action="sendStatus"）`;
				}
				const self = await whoAmI(cfg);
				if (self && (args[1] === "+dm" || args.includes("--as") && args[args.indexOf("--as") + 1] === "user")) {
					out += `

核验（只读）：dingtalk_msg action="read" sender="me" limit=3`;
				}
			}
			if (dryRun) out += "\n\n（--dry-run 预演：未发送任何消息，也未记入防重发台账）";
			out = annotateQuery(args, out, /* @__PURE__ */ new Date());
			// 审批列表：摘要只含第一行明细，这里把行数与可算的金额补上（annotation 只对审批两列表生效）
			if (args[0] === "oa" && args[1] === "approval") out = await annotateApprovalList(args, out, (iid) => callJson(["oa", "approval", "detail", "--instance-id", iid]));
			// forecast 的 forecastSuccess 与 staticWorkflow 组合起来才有意义，原样给模型只会被误读
			if (args[0] === "oa" && args[1] === "approval" && args[2] === "forecast-process") out = annotateForecast(out);
			// 详情输出自带单据链接：taskId 留空（流程推进会换节点，留空长期有效）
			if (args[0] === "oa" && args[1] === "approval" && args[2] === "detail") out = annotateApprovalDetail(out, await corpIdOf(cfg));
			if (!matchPrefix(args, SEND_PREFIXES) && !matchPrefix(args, RECALL_PREFIXES)) {
				if (args[0] === "sheet" && args[1] === "set-dropdown") {
					const fv = (n: string) => flagValues(args, new Set([n]))[0] ?? "";
					out += `\n\n核验（只读）：dingtalk_doc action=\"sheetGetDropdown\" doc=\"${fv("--node")}\" sheetId=\"${fv("--sheet-id")}\" range=\"${fv("--range")}\"`;
				}
				out += formatDriveRefs(parseDriveRefs(out));
				out += formatFieldSpellingNote(out);
				// 附件的落地情况回给模型：省一轮「先看有什么、再单独下」，也避免拿不到文件时反复重试
				if (args.includes("--download-resources")) {
					out += formatResourceDownloads(out, flagValues(args, new Set(["--output-dir"]))[0] ?? MEDIA_OUT_DIR);
				}
				if (isFolderMessage(out)) {
					out += "\n\n⚠️ 上述含「[文件夹] xxx」的消息：钉钉不提供任何可下载引用（实测：无 resourceRefs、无 id、无 mediaId，连 download-media 也无从下手），插件无法读取。请让对方打包成 zip 或逐个文件重发——不要反复尝试下载。";
				}
			}
			if (redirectNote) out = `${out}${redirectNote}`;
			if (stamped.notes.length) out = `${out}\n\n（时间戳命名：${stamped.notes.join("；")}）`;
			if (pathNote) out = `${pathNote}

${out}`;
			return done(text(truncateOut(out, cfg.maxOutputChars) || "（无输出）", { kind: "ok" }));
		}
	};
	/** 语义层复用同一条受控管线（换行归一 → 分档 → 参数自检 → 两阶段 → 人工面板 → 台账 → 结果注解） */
	const runGuarded = async (
		args: string[],
		opts: { view?: { receivers?: string[]; note?: string; objects?: string[]; target?: string; people?: ResolvedPerson[] } },
		ctx: ExtensionContext,
		id?: string,
	) => execTool.execute(id ?? "semantic", { args, view: opts.view } as never, undefined, undefined, ctx);

	// 二次确认：确认只给 token，参数取自草稿——长正文/表格数据不必重写一遍
	pi.registerTool({
		name: "dingtalk_confirm",
		annotations: { readOnlyHint: false },
		defaultActive: false,
		label: "确认钉钉操作",
		description:
			"执行此前生成的钉钉操作草稿：draftId 取自草稿回执，参数按草稿执行，无需重写。10 分钟内有效；敏感档先弹人工审核。",
		promptSnippet: "确认钉钉操作：dingtalk_confirm(draftId) → 执行对应草稿并返回结果",
		parameters: Type.Object({
			draftId: Type.String({ description: "草稿回执里的 draftId" }),
		}),
		async execute(id, params, _signal, _onUpdate, ctx) {
			const draftId = (params as { draftId: string }).draftId.trim();
			const got = peekDraft(state, draftId, Date.now());
			if ("error" in got) {
				stats.blocked++;
				return text(`🚫 ${got.error}`, { kind: "blocked" });
			}
			if (codemodeBlocked(id, got.tier)) {
				stats.blocked++;
				return text("🚫 确认不能在 codemode 脚本里调用：两阶段确认要求它是对话里的一次单独调用。请把 dingtalk_confirm 拿到脚本外直接调用。", { kind: "blocked" });
			}
			state.pending.delete(draftId);
			const out = await execTool.execute(`confirm:${draftId}`, { args: got.args, draft: got } as never, undefined, undefined, ctx);
			// 执行失败（上游拒绝/超时）时把草稿放回去：用户修不了上游，但能直接重试，
			// 不必重新 create——重新 create 会重新上传附件，在钉盘里又堆一份 (n)
			if (isErrored(out)) state.pending.set(draftId, got);
			return out;
		},
	});

	// 只读知识入口：官方技能正文用来评估可行性并回报用户，不能当绕行手册
	pi.registerTool({
		name: "dws_skill",
		annotations: { readOnlyHint: true },
		defaultActive: false,
		label: "读钉钉技能文档",
		description:
			"查钉钉官方技能文档（dingtalk-*）：无 topic 列出全部技能，传 topic（短名如 sheet，或全名 dingtalk-chat）返回正文。只在要向用户回报「插件做不到的事」时评估可行性，不作失败后的绕行手册。",
		promptSnippet: "查钉钉技能文档：dws_skill([topic]) → 技能索引 / 技能正文",
		parameters: Type.Object({
			topic: Type.Optional(Type.String({ description: "技能短名或全名（如 sheet、dingtalk-chat）；缺省列全部" })),
		}),
		async execute(_id, params) {
			const dir = cfg.skillsDir ?? path.join(os.homedir(), ".agents", "skills");
			let names: string[];
			try {
				names = fs
					.readdirSync(dir, { withFileTypes: true })
					.filter((e) => e.isDirectory() || e.isSymbolicLink())
					.map((e) => e.name)
					.filter((n) => n.startsWith("dingtalk-"))
					.sort();
			} catch {
				return text(`技能目录不可读：${dir}（可在 ~/.pi/agent/dingtalk-bridge.json 配置 skillsDir）`, { kind: "error" });
			}
			if (!params.topic) {
				const entries = names.map((n) => {
					try {
						return { name: n, description: parseSkillDescription(fs.readFileSync(path.join(dir, n, "SKILL.md"), "utf8")) };
					} catch {
						return { name: n, description: "" };
					}
				});
				return text(formatSkillIndex(entries));
			}
			const want = params.topic.trim();
			const full = want.startsWith("dingtalk-") ? want : `dingtalk-${want}`;
			if (!names.includes(full)) {
				return text(`没有技能「${params.topic}」。可用：${names.map((n) => n.replace("dingtalk-", "")).join("、") || "（无）"}`, { kind: "error" });
			}
			const skillDir = path.join(dir, full);
			try {
				const md = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
				const body = md.length > SKILL_MAX_CHARS ? `${md.slice(0, SKILL_MAX_CHARS)}\n\n……（正文过长已截断）` : md;
				return text(`${body}\n\n（技能目录：${skillDir}；references/ 下的细化文档可用 read 工具按需读取）`, { kind: "ok" });
			} catch (e) {
				return text(`读取技能失败：${(e as Error).message}`, { kind: "error" });
			}
		},
	});

	// 按需装载：业务工具默认不声明（零 token），模型用到钉钉时先调本工具装载，下一轮即可直接调用
	pi.registerTool({
		name: "dingtalk_help",
		annotations: { readOnlyHint: true },
		label: "装载钉钉工具",
		description:
			"钉钉业务工具（消息/待办/日程/审批/钉盘/文档表格）默认不加载，不占上下文。要做任何钉钉操作先调本工具（无参数），返回的工具在下一轮可直接调用。",
		promptSnippet: "装载钉钉业务工具：dingtalk_help() → 工具清单（下一轮可用）",
		promptGuidelines: [
			"钉钉操作前先调 dingtalk_help（无参数）装载业务工具，装载后下一轮才能调用它们；同一轮里紧接着调 dingtalk_* 会失败。",
		],
		parameters: Type.Object({}),
		async execute() {
			const active = pi.getActiveTools();
			const add = LAZY_TOOLS.filter((n) => !active.includes(n));
			if (add.length) pi.setActiveTools([...active, ...add]);
			const tips = [
				"消息 dingtalk_msg：action=send/sendGroup/read/reply/forward/ding/recall/createGroup",
				"待办 dingtalk_todo：list/create/update/complete/delete/search",
				"日程 dingtalk_calendar：list/create/update/cancel/detail/invite/rooms",
				"审批 dingtalk_approval：listPending/listSubmitted/detail/approve/reject/transfer/revoke/forms/formSchema/forecast/create",
				"钉盘 dingtalk_file：list/search/info/upload/download/mkdir/move/rename/delete/spaces/fetch",
				"文档表格 dingtalk_doc：read/search/create/append/replace/sheet*/table*",
				"写操作先回执行计划，用户确认后调 dingtalk_confirm(draftId)",
			];
			return text(
				add.length
					? `已装载钉钉业务工具（本轮不可调，下一轮起可用）：\n${tips.join("\n")}`
					: `钉钉业务工具已装载：\n${tips.join("\n")}`,
				{ kind: "ok" },
			);
		},
	});

	// ============================================================
	// L3 语义层：AI 只说业务话，命令/flag/ID 全由这里包办（场景→dws 的映射在 intents.ts）
	// ============================================================

	/** 在嵌套 JSON 里按 key（大小写不敏感）找第一个非空标量 */
	const findScalar = (data: unknown, keys: string[]): string | undefined => {
		let hit: string | undefined;
		const walk = (v: unknown): void => {
			if (hit !== undefined) return;
			if (Array.isArray(v)) return v.forEach(walk);
			if (!v || typeof v !== "object") return;
			for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
				if (typeof vv === "string" || typeof vv === "number") {
					if (keys.some((q) => q.toLowerCase() === k.toLowerCase())) {
						hit = String(vv);
						return;
					}
				} else walk(vv);
			}
		};
		walk(data);
		return hit;
	};

	/**
	 * 调 dws 并解析 JSON：拿不到可读结果时把失败原因交回来，
	 * 由调用方区分「查询失败」与「确实没有这样的人/群」。
	 */
	const callJsonOr = async (args: string[]): Promise<{ data: unknown } | { error: string }> => {
		try {
			const r = await runDws(cfg, [...args, "--format", "json"]);
			if (r.timedOut) return { error: "请求超时（dws 没在限定时间内返回）" };
			if (r.code !== 0) return { error: dwsFailureNote(r, args) };
			const raw = r.stdout.trim() || r.stderr.trim();
			const i = raw.indexOf("{");
			if (i < 0) return { error: `dws 没有返回可读结果：${raw.split("\n")[0]?.trim().slice(0, 120) || "（空输出）"}` };
			try {
				return { data: JSON.parse(raw.slice(i)) as unknown };
			} catch (e) {
				return { error: `dws 返回的不是合法 JSON：${String(e).slice(0, 100)}` };
			}
		} catch (e) {
			return { error: `dws 进程启动失败：${String((e as Error).message ?? e).slice(0, 120)}` };
		}
	};

	/** 调 dws 并解析 JSON（失败 / 非 JSON 返回 null） */
	const callJson = async (args: string[]): Promise<unknown | null> => {
		const r = await callJsonOr(args);
		return "data" in r ? r.data : null;
	};

	/**
	 * 搜人（aisearch person）：CLI 给这条接口的预算只有 ~3 秒，网关偶发 request_timeout
	 * 是常态（审计日志里这类超时每天都有），所以失败重试一次（只读幂等）；
	 * 两次都失败才把原因交上去。零命中是成功的响应，不在这里重试。
	 */
	const searchPeople = async (query: string): Promise<{ hits: PersonHit[] } | { error: string }> => {
		let why = "";
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt) await sleep(600);
			const r = await callJsonOr(["aisearch", "person", "--query", query, "--dimension", "name"]);
			if ("data" in r) return { hits: parsePeople(JSON.stringify(r.data)) };
			why = r.error;
		}
		return { error: why };
	};


	/** openDingTalkId → userId（通讯录按 openId 反查；查不到返回 null，交给调用方按原值兜底） */
	const userIdOfOpenId = async (openId: string): Promise<string | null> => {
		const r = await callJsonOr(["contact", "user", "get", "--open-dingtalk-id", openId]);
		if ("error" in r) return null;
		return findScalar(r.data, ["userId"]) ?? null;
	};

	/**
	 * 单聊会话的对方：从会话消息里找一个「不是自己发的」senderId，那就是对方 openDingTalkId。
	 * 不经姓名（单聊标题常重名，按姓名搜根本定不到人），也不猜。
	 */
	const singleChatPeer = async (cid: string): Promise<ResolvedPerson | undefined> => {
		const conv = await conversationOf(cid);
		if (!conv?.single) return undefined;
		// contact +me 只给 userId，消息里的 senderId 是 openDingTalkId，两者没法直接比；
		// 但 sender 字段是自己那一方时，名字与 +me 的姓名相同——用名字排除自己
		const me = await whoAmI(cfg);
		const r = await callJsonOr(["chat", "+messages-list", "--group", cid, "--limit", "20", "--time", "2000-01-01 00:00:00"]);
		if ("error" in r) return undefined;
		const data = r.data as { messages?: Array<Record<string, unknown>> };
		const rows = Array.isArray(data.messages) ? data.messages : [];
		for (const row of rows) {
			const senderId = pickStr(ci(row, "senderId"));
			const sender = pickStr(ci(row, "sender"));
			if (!senderId || !sender) continue;
			if (me?.name && sender === me.name) continue;
			return { token: senderId, userId: senderId, openId: senderId, name: sender };
		}
		return undefined;
	};

	/**
	 * 会话 ID（cid...）反查：拿到标题与是否单聊。
	 * cid 只该出现在群/会话目标位上，但模型常把上一步查到的 cid 当收件人传回来——
	 * 单聊会话能反查出对方姓名，于是可以顺着它继续解析成人，不必报错重来。
	 */
	const conversationOf = async (cid: string): Promise<{ title: string; single: boolean } | null> => {
		const r = await callJsonOr(["chat", "conversation-info", "--conversation-id", cid]);
		if ("error" in r) return null;
		const title = findScalar(r.data, ["title"]);
		if (!title) return null;
		return { title, single: /"singleChat"\s*:\s*true/.test(JSON.stringify(r.data)) };
	};

	/**
	 * 人员解析：姓名走 aisearch，自指词与本人姓名/ID 直连 contact +me。
	 * 稳定 ID 先归位再当姓名用：userId 直接可用；openDingTalkId 是另一种格式（含大小写、以 = 结尾），
	 * 塞进只用 userId 的参数会被上游拒；cid 是会话 ID，单聊会话能反查出对方姓名。
	 */
	const resolvePeople = async (tokens: string[]): Promise<{ ok: ResolvedPerson[] } | { error: string } | { choice: string }> => {
		const ok: ResolvedPerson[] = [];
		// 重名不立刻返回：先把整批解析完，把所有歧义一次列全。
		// 逐个返回会让名单里的人要试 N 轮才知道全部歧义（38 人名单实测连卡 4 次）。
		const ambiguous: string[] = [];
		// 并发解析：几十人的名单串行查要几十秒，并发后约等于最慢那一次
		const results = await Promise.all([...new Set(tokens.map((t) => t.trim()).filter(Boolean))].map(async (token) => {
			// 完整手机号：通讯录反查（唯一命中才放行）
			if (idKindOf(token) === "mobile") {
				const r = await callJsonOr(["contact", "user", "search-mobile", "--mobile", token]);
				if ("error" in r) return { error: searchFailedNote(token, r.error) };
				const uid = findScalar(r.data, ["userId"]);
				if (!uid) return { error: `手机号 ${token} 没反查到账号` };
				const orgs = await orgInfoOf(cfg, [uid]);
				return { ok: { token, userId: uid, name: orgs.get(uid)?.name || undefined } };
			}
			// 本人：自指词（我/自己/本人/me）与本人的姓名、userId 一律直连 contact +me——
			// 搜索接口是语义检索，本人不一定被排进结果，直连才确定
			const self = await whoAmI(cfg);
			if (isSelfToken(token) && !self) return { error: `「${token}」需要本人身份，但 contact +me 没返回；请直接给本人的姓名或账号 ID` };
			if (self && (isSelfToken(token) || token === self.name || token === self.userId)) {
				return { ok: { token, userId: self.userId, openId: self.openId, name: self.name } };
			}
			if (!isStableId(token)) {
				const found = await searchPeople(token);
				if ("error" in found) return { error: searchFailedNote(token, found.error) };
				const hits = found.hits;
				if (!hits.length) return { error: `没找到「${token}」：核对用字，或直接给这个人的完整手机号` };
				if (hits.length > 1) {
					return { ambiguous: formatAmbiguousName(token, await personLines(cfg, hits)) };
				}
				const hit = hits[0]!;
				return { ok: { token, userId: hit.userId, openId: hit.openId, name: hit.name || token } };
			}
			// cid 是会话 ID，不是人。消息类接口直接认它当会话目标（所以 token 原样保留），
			// 但 DING 要的是人的 openDingTalkId——单聊会话能反查出对方姓名，再顺着姓名取 openId。
			// 取不到就留空，由需要 openId 的动作自己报缺什么，不拿 cid 冒充。
			if (idKindOf(token) === "conversation") {
				const conv = await conversationOf(token);
				if (!conv) return { error: `「${token}」是会话 ID，但反查不到这个会话（可能已解散或无权访问）` };
				// 消息类接口直接认 cid 当会话目标；DING 要的 openDingTalkId 由 singleChatPeer 从会话消息里取
				return { ok: { token, userId: token, name: conv.title } };
			}
			// openDingTalkId 是另一种格式（含大小写、常以 = 结尾），不能当 userId 塞进只用 userId 的参数：
			// 先按 userId 查，查不到再当成 openId 反查回 userId
			const orgs = await orgInfoOf(cfg, [token]);
			if (orgs.get(token)) {
				return { ok: { token, userId: token, name: orgs.get(token)?.name || undefined } };
			}
			const byOpen = await userIdOfOpenId(token);
			if (byOpen) {
				return { ok: { token, userId: byOpen, openId: token, name: (await orgInfoOf(cfg, [byOpen])).get(byOpen)?.name || undefined } };
			}
			return { ok: { token, userId: token, name: orgs.get(token)?.name || undefined } };
		}));
		// 汇总结果：error / ambiguous / ok 分开处理
		for (const r of results as Array<{ ok?: ResolvedPerson; error?: string; ambiguous?: string }>) {
			if (r.error) return { error: r.error };
			if (r.ambiguous) ambiguous.push(r.ambiguous);
			else if (r.ok) ok.push(r.ok);
		}
		// 整批扫完再报歧义：一次列全，选中后换 ID 重调一轮就能过
		if (ambiguous.length) return { choice: joinAmbiguous(ambiguous) };
		return { ok };
	};

	/**
	 * 审批编号（businessId，钉钉审批单上直接显示给用户的那串）→ 实例 ID。
	 * 编号只在 detail 的返回里，两个列表接口都不给，所以只能反查：先查「我发起的」
	 * 再查「待我审批」——别人发起、抄送给你的单据只在后者里找得到。
	 * 两路都空时按编号前 8 位（提交日期）再搜一次，把同一天的候选列出来：
	 * 「抄错一位」与「根本不在可见范围」是两种完全不同的错，得让用户自己看得出来。
	 */

	/**
	 * 审批编号 → 实例 ID。
	 * 反查不到时不算失败：长数字也可能是上游的实例 ID（格式一样，形态分不出），
	 * 交回「当作实例 ID 直接试」比报错更可能成功。
	 */
	const lookupByApprovalNo = async (no: string): Promise<{ hit: string } | { ambiguous: string } | { none: true }> => {
		// list-pending 必须带时间窗（不带 start/end 上游直接拒）：编号是提交时间的固化编码，
		// 这里给一个足够宽的窗口，不拿对话里的当前时间做锚点，否则老单永远搜不到
		const lists: Array<{ label: string; args: string[] }> = [
			{ label: "我发起的", args: ["oa", "approval", "list-submitted", "--query", no, "--limit", "20"] },
			{ label: "待我审批", args: ["oa", "approval", "list-pending", "--query", no, "--limit", "20", "--start", "2020-01-01T00:00:00+08:00", "--end", "2099-12-31T23:59:59+08:00"] },
		];
		const results = await Promise.all(lists.map((list) => callJson(list.args)));
		const hits: Array<{ label: string; id: string }> = [];
		results.forEach((data, i) => {
			if (data === null) return;
			const id = findScalar(data, ["processInstanceId"]);
			if (id) hits.push({ label: lists[i]!.label, id });
		});
		if (hits.length === 1) return { hit: hits[0]!.id };
		if (hits.length > 1) {
			return { ambiguous: `${no} 在「${hits.map((x) => x.label).join("」「")}」里都能命中（${hits.map((x) => x.id).join("、")}）——改用 instanceId 直接指定` };
		}
		return { none: true };
	};

	/** 编号前 8 位 = 提交日期：搜同一天的单据当候选（用户抄错一位时能在里头找到真身） */
	const sameDayCandidates = async (no: string): Promise<string> => {
		if (no.length < 8) return "";
		const data = await callJson(["oa", "approval", "list-submitted", "--query", no.slice(0, 8), "--limit", "20"]);
		if (!data) return "";
		const rows: Array<{ id: string; title: string; at: string }> = [];
		const walk = (v: unknown): void => {
			if (Array.isArray(v)) return v.forEach(walk);
			if (!v || typeof v !== "object") return;
			const o = v as Record<string, unknown>;
			if (typeof o.processInstanceId === "string" && typeof o.title === "string") {
				const ms = Number(o.processCreateTime ?? 0);
				const at = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "";
				rows.push({ id: o.processInstanceId, title: o.title, at });
			}
			Object.values(o).forEach(walk);
		};
		walk(data);
		if (!rows.length) return "";
		const shown = rows.slice(0, 8).map((r) => `· ${r.at ? `${r.at} ` : ""}${r.title}（${r.id}）`);
		return `\n编号前 8 位（${no.slice(0, 8)}）能搜到 ${rows.length} 张单据，看是不是其中一张：\n${shown.join("\n")}` +
			(rows.length > shown.length ? `\n（只列前 ${shown.length} 张）` : "");
	};


	/** 模板列表（+list-forms / +search-forms 两种输出都认）：只认「模板名 + processCode」成对的项 */
	const parseFormList = (stdout: string): Array<{ name: string; code: string }> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
		} catch {
			return [];
		}
		const out: Array<{ name: string; code: string }> = [];
		const walk = (v: unknown): void => {
			if (Array.isArray(v)) return v.forEach(walk);
			if (!v || typeof v !== "object") return;
			const o = v as Record<string, unknown>;
			const code = o.processCode ?? o.process_code;
			const name = o.name ?? o.processName;
			if (typeof code === "string" && /^PROC-/.test(code) && typeof name === "string") out.push({ name, code });
			Object.values(o).forEach(walk);
		};
		walk(parsed);
		return out;
	};

	/** 模板名 → processCode（同名多份时交回对话，不猜） */
	const resolveProcessCode = async (token: string): Promise<{ code: string; name?: string } | { error: string }> => {
		const q = token.trim();
		const data = await callJson(["oa", "+search-forms", "--query", q]);
		const forms = data ? parseFormList(JSON.stringify(data)) : [];
		const exact = forms.filter((f) => f.name === q);
		const pool = exact.length ? exact : forms;
		if (pool.length === 1) return { code: pool[0]!.code, name: pool[0]!.name };
		if (pool.length > 1) {
			return { error: `有 ${pool.length} 个模板叫「${q}」或包含这个词：\n${pool.slice(0, 12).map((f) => `· ${f.name}：${f.code}`).join("\n")}\n用 formSchema 配 processCode 指定其中一个` };
		}
		return { error: `没找到审批模板「${q}」：用 action=forms（配 keyword）看可用模板` };
	};

	/** 模板字段清单（label / 类型 / 子控件）。发起前必须走这一步，否则字段名与明细结构全靠猜 */
	const readFormSchema = async (code: string): Promise<{ fields: SchemaField[]; name: string } | { error: string }> => {
		const r = await callJsonOr(["oa", "approval", "form-schema", "--process-code", code]);
		if ("error" in r) return { error: `取模板字段失败：${r.error}` };
		const doc = r.data as Record<string, unknown> | null;
		const body = doc && typeof doc.result === "object" && doc.result !== null ? (doc.result as Record<string, unknown>) : doc ?? {};
		const fields = parseFormSchema(body.content);
		if (!fields) return { error: `模板 ${code} 的字段结构解不开（content 不是预期 JSON）——先把 action=formSchema 的输出发给用户看` };
		return { fields, name: String(body.processName ?? body.name ?? code) };
	};

	/**
	 * 表单附件 → 审批钉盘的 {fileId, spaceId, …}。
	 *
	 * 三种来源区别对待：
	 *   · 已上传对象（带 fileId）：直接拿来用，不重传——重提/改金额/重试时钉盘里该是同一份，
	 *     而不是 xxx(1).zip、xxx(2).zip 一路累积（实测同名文件上游会自动加序号）；
	 *   · 本地路径且内容与上传过的一致（sha256 命中缓存）：复用旧的 fileId，不重传；
	 *   · 其余：真上传。若这份内容之前以**旧文件名**传过，就按新文件名重传一份
	 *     （上传接口会改名成 xxx(1)，而 detail 里显示的是接口返回的 fileName，所以
	 *     「换名重传」本身就是把新版本摆在明面上、与旧版区分开的正确做法）。
	 *
	 * 任一份失败就整份拦下：发起时缺一份附件的单子比不发起更糟（用户以为传了）。
	 */
	const uploadApprovalAttachments = async (inputs: AttachmentInput[]): Promise<{ ok: AttachmentRef[] } | { error: string }> => {
		const baseDir = process.cwd();
		const resolved = inputs.map((x) => (typeof x === "string" ? { kind: "path" as const, file: x } : { kind: "ref" as const, ref: x }));
		const missing = resolved.filter((x) => x.kind === "path" && !fs.existsSync(path.isAbsolute(x.file) ? x.file : path.join(baseDir, x.file)));
		if (missing.length) return { error: `待上传的附件不存在：${missing.map((x) => (x.kind === "path" ? x.file : "")).join("、")}（给工作目录内的相对路径或绝对路径）` };
		const cache = loadAttachmentCache();
		const refs: AttachmentRef[] = [];
		let dirty = false;
		for (const item of resolved) {
			if (item.kind === "ref") {
				refs.push(asAttachmentRef(item.ref));
				continue;
			}
			const abs = path.isAbsolute(item.file) ? item.file : path.join(baseDir, item.file);
			const name = path.basename(abs);
			const hash = await sha256File(abs);
			if (!hash) return { error: `附件「${name}」读不出来（路径或权限问题）` };
			const verdict = decideAttachmentReuse(name, cache[hash]);
			if (verdict.kind === "reuse") {
				refs.push(verdict.ref);
				continue;
			}
			const r = await callJsonOr(["oa", "approval", "attachment", "upload", "--file", abs, "--file-name", name]);
			if ("error" in r) return { error: `附件「${name}」上传失败：${r.error}` };
			const body = (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
			const inner = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
			const fileId = findScalar(inner, ["fileId"]);
			const spaceId = findScalar(inner, ["spaceId"]);
			if (!fileId || !spaceId) {
				return { error: `附件「${name}」上传后没拿到 fileId/spaceId——上传可能只走了一半，先把 action=detail 看原单附件格式再试` };
			}
			const size = Number(inner.fileSize ?? inner.file_size ?? 0);
			const ref: AttachmentRef = {
				fileId,
				spaceId,
				fileName: String(inner.fileName ?? inner.file_name ?? name),
				...(Number.isFinite(size) && size > 0 ? { fileSize: size } : {}),
				...(inner.fileType || inner.file_type ? { fileType: String(inner.fileType ?? inner.file_type) } : {}),
			};
			refs.push(ref);
			// localName 是判等的锚：上游会把重名文件改成 xxx(1).zip，不能拿它跟本地名比
			cache[hash] = { ...ref, localName: name } as AttachmentRef & { localName: string };
			dirty = true;
		}
		if (dirty) saveAttachmentCache(cache);
		return { ok: refs };
	};


	const withOpenIds = async (people: ResolvedPerson[]): Promise<{ ok: ResolvedPerson[] } | { error: string }> => {
		const out: ResolvedPerson[] = [];
		for (const p of people) {
			if (p.openId) {
				out.push(p);
				continue;
			}
			let name = p.name;
			if (!name) {
				const orgs = await orgInfoOf(cfg, [p.userId]);
				name = orgs.get(p.userId)?.name;
			}
			if (!name) return { error: `没查到 ${p.token} 对应的姓名，无法取 DING 所需的 openDingTalkId` };
			const found = await searchPeople(name);
			if ("error" in found) return { error: searchFailedNote(name, found.error) };
			const hit = found.hits.find((h) => h.userId === p.userId) ?? found.hits.find((h) => h.openId);
			if (!hit?.openId) return { error: `没取到「${name}」的 openDingTalkId，DING 发不出去` };
			out.push({ ...p, name, openId: hit.openId });
		}
		return { ok: out };
	};

	/** 在列表里按名称找对象并取其目标字段（如 知识库名 → workspaceId、表名 → tableId） */
	const findByField = (data: unknown, nameKeys: string[], wantKeys: string[], value: string): string | undefined => {
		let hit: string | undefined;
		const walk = (v: unknown): void => {
			if (hit) return;
			if (Array.isArray(v)) return v.forEach(walk);
			if (!v || typeof v !== "object") return;
			const o = v as Record<string, unknown>;
			const name = nameKeys.map((k) => o[k]).find((x) => typeof x === "string");
			if (typeof name === "string" && name.trim() === value.trim()) {
				const want = wantKeys.map((k) => o[k]).find((x) => typeof x === "string" && x);
				if (typeof want === "string") {
					hit = want;
					return;
				}
			}
			Object.values(o).forEach(walk);
		};
		walk(data);
		return hit;
	};

	/** 会话解析：群名 → openConversationId（同名群强制让用户选） */
	const resolveGroup = async (token: string): Promise<{ ok: ResolvedGroup } | { error: string }> => {
		if (idKindOf(token) === "conversation") return { ok: { token, cid: token } };
		const data = await callJson(["chat", "+chat-search", "--query", token]);
		const cands = data ? matchGroupsByName(parseGroups(JSON.stringify(data)), token) : [];
		if (!cands.length) return { error: `没找到群「${token}」——核对群名用字，或直接给会话 ID` };
		if (cands.length > 1) {
			const lines = cands.map((g) => `· ${g.name}（${g.cid}）`);
			return { error: `群名「${token}」匹配到 ${cands.length} 个会话，请让用户确认：\n${lines.join("\n")}\n（确认后把 group 改成对应的 openConversationId）` };
		}
		const g = cands[0]!;
		if (!g.cid) return { error: `群「${token}」没解析出会话 ID` };
		return { ok: { token, cid: g.cid, title: g.name || token } };
	};

	/** 单聊会话定位：姓名 → 对方 openDingTalkId → 单聊会话 ID（转发/回复/撤回的目标也可能是个人） */
	const resolveSingleChat = async (token: string): Promise<{ ok: ResolvedGroup } | { error: string } | { choice: string }> => {
		const people = await resolvePeople([token]);
		if (!("ok" in people)) return people;
		const withIds = await withOpenIds(people.ok);
		if (!("ok" in withIds)) return withIds;
		const person = withIds.ok[0]!;
		const data = await callJson(["chat", "+conversation-info", "--open-dingtalk-id", person.openId!]);
		const info = data ? parseConversationInfo(JSON.stringify(data)) : null;
		const name = person.name || token;
		if (!info?.cid) {
			return {
				error: `没找到与「${name}」的单聊会话（对方可能还没与你聊过）——要把内容发给对方，用 action="send" to=["${token}"]；要转发这条消息，可先让对方发一条消息再试`,
			};
		}
		return { ok: { token, cid: info.cid, title: info.title || name } };
	};

	/**
	 * 会话定位：先当群找，再当个人找单聊——转发/回复/撤回/查消息的目标都可以写人名。
	 * 已经是会话 ID 的不再猜人。
	 */
	const resolveConversation = async (token: string): Promise<{ ok: ResolvedGroup } | { error: string } | { choice: string }> => {
		const g = await resolveGroup(token);
		if ("ok" in g || token.startsWith("cid")) return g;
		const person = await resolveSingleChat(token);
		if ("ok" in person || "choice" in person) return person;
		return { error: `没找到会话「${token}」：群名对不上，按人名也没找到单聊（${person.error}）` };
	};

	/** 消息定位：直接给 messageId 时补会话；否则按会话+发送人+关键词搜一条 */
	const resolveMessage = async (p: { messageId?: string; inGroup?: string; group?: string; keyword?: string; sender?: string; days?: number }): Promise<{ ok: ResolvedMessage } | { error: string } | { choice: string }> => {
		let cid: string | undefined;
		let groupTitle: string | undefined;
		const gToken = p.inGroup ?? p.group;
		if (gToken) {
			const g = await resolveConversation(gToken);
			if (!("ok" in g)) return g;
			cid = g.ok.cid;
			groupTitle = g.ok.title;
		}
		if (p.messageId) {
			const data = await callJson(["chat", "+messages-mget", "--msg-ids", p.messageId]);
			const [d] = parseMessageDigest(JSON.stringify(data ?? {}));
			if (!d?.conversationId) return { error: `没查到消息 ${p.messageId}（可能不在你可见的会话里）` };
			return { ok: { msgId: p.messageId, conversationId: cid ?? d.conversationId, preview: d.preview, time: d.createTime } };
		}
		if (!cid) return { error: "要找消息的话，需要给 inGroup（消息在哪个会话）+ keyword（消息里的关键词）" };
		const args = ["chat", "+search-msg", "--chat-id", cid, "--limit", "5", "--order", "desc", "--days", String(Math.max(1, Math.min(p.days ?? 7, 30)))];
		if (p.sender) args.push("--sender-query", p.sender);
		if (p.keyword) args.push("--query", p.keyword);
		const data = await callJson(args);
		const msgId = data ? findScalar(data, ["openMessageId", "msgId", "messageId"]) : undefined;
		if (!msgId) return { error: `在「${groupTitle ?? cid}」里没找到符合条件的消息——把关键词说得更准，或直接给 messageId` };
		const conv = data ? findScalar(data, ["openConversationId", "conversationId"]) : undefined;
		return { ok: { msgId, conversationId: conv ?? cid } };
	};

	/** 文档/表格定位：链接与 ID 直接用，标题先搜（同名多份交回对话，不猜） */
	const resolveDocNode = async (token: string): Promise<{ ok: string } | { error: string } | { choice: string }> => {
		if (/^https?:\/\//.test(token) || isStableId(token)) return { ok: token };
		// 要判定「唯一」就得读完：只读一页会把第二页的同名对象当成不存在
		const data = await callJson(["doc", "+search", "--query", token, "--page-all"]);
		const cands = data ? pickNameMatches(data, token) : [];
		if (!cands.length) return { error: `没搜到名为「${token}」的文档/表格（可按链接或节点 ID 直接给）` };
		const files = cands.filter((c) => c.kind !== "folder");
		if (files.length > 1) return { choice: formatAmbiguous(token, files) };
		if (files.length === 1) return { ok: files[0]!.id };
		if (cands.length > 1) return { choice: formatAmbiguous(token, cands) };
		return { ok: cands[0]!.id };
	};

	/**
	 * 钉盘搜索翻到底：同名判定要看全量，只读一页会把第二页的同名文件漏判成「唯一」。
	 * 翻到没有 nextCursor 才算完整；翻满 10 页仍有剩余时如实返回 incomplete（由调用方拒绝自动挑）。
	 */
	const searchAllPages = async (query: string): Promise<{ files: unknown[]; complete: boolean }> => {
		const all: unknown[] = [];
		let cursor = "";
		for (let page = 0; page < 10; page++) {
			const args = ["drive", "+search", "--query", query, "--limit", "30"];
			if (cursor) args.push("--cursor", cursor);
			const data = await callJson(args);
			if (!data) return { files: all, complete: false };
			const body = asObj(ci(asObj(data), "data") ?? data);
			const files = body.files;
			if (Array.isArray(files)) all.push(...files);
			const next = pickStr(ci(body, "nextCursor"));
			if (!next || next === cursor) return { files: all, complete: true };
			cursor = next;
		}
		return { files: all, complete: false };
	};

	/** 钉盘节点/文件夹定位：名称、链接或 ID → 稳定 ID（同名多份交回对话，不猜） */
	const resolveDriveNode = async (token: string): Promise<{ ok: string } | { error: string } | { choice: string }> => {
		if (/^https?:\/\//.test(token)) {
			const info = await callJson(["drive", "info", "--node", token]);
			const id = info ? findScalar(info, ["nodeId", "dentryUuid", "dentryId"]) : undefined;
			if (!id) return { error: `没解析出链接里的节点 ID：${token}` };
			return { ok: id };
		}
		if (isStableId(token)) return { ok: token };
		// drive +search 没有 --page-all：按游标翻到底，否则第二页的同名文件会被漏判成唯一
		const found = await searchAllPages(token);
		if (!found.complete) return { error: `钉盘里搜「${token}」的结果没读完（同名判定不可靠）——这次请直接给链接或文件 ID` };
		const cands = pickNameMatches({ files: found.files }, token);
		if (!cands.length) return { error: `钉盘里没找到「${token}」（名字要写全；或给链接/ID）` };
		if (cands.length > 1) return { choice: formatAmbiguous(token, cands) };
		return { ok: cands[0]!.id };
	};

	/** 已解析结果 → 带上本次调用的时间锚点（时间窗类参数一律相对它算） */
	const withExtras = (base: Resolved, msg: ResolvedMessage | undefined): Resolved => ({ ...base, ...(msg ? { message: msg } : {}), ids: { ...base.ids, now: new Date().toISOString() } });

	/** 注册一个语义工具：解析 → 生成 argv → 走同一条受控管线 */
	const registerSemanticTool = <P>(def: {
		name: string;
		label: string;
		description: string;
		params: unknown;
		resolve: (p: P) => Promise<Resolved | { error: string } | { choice: string }>;
		build: (p: P, r: Resolved) => Built;
		/** 不走命令管线、直接实现的动作（如纯下载）；返回 null 表示交给常规流程 */
		direct?: (p: P, ctx: ExtensionContext) => Promise<ReturnType<typeof text> | null>;
	}) => {
		pi.registerTool({
			name: def.name,
			annotations: { readOnlyHint: false }, // 钉钉工具组都能产生外部副作用（发送/写入），按能力标注
			defaultActive: false,
			label: def.label,
			description: def.description,
			promptSnippet: `${def.label}：${def.name}(action, …) → 结果`,
			parameters: def.params as never,
			async execute(
			id: string,
			params: { args: string[]; view?: { receivers?: string[]; note?: string; objects?: string[]; target?: string; people?: ResolvedPerson[] } },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
				const p = params as P;
				if (def.direct) {
					const out = await def.direct(p, ctx);
					if (out) return out;
				}
				const resolved = await def.resolve(p);
				// 同名/同名群：不做人工确认，直接把候选交给 AI 挑（挑定后换成候选 ID 重调）
				if ("choice" in resolved) return text((resolved as { choice: string }).choice, { kind: "choice" });
				if ("error" in resolved && typeof (resolved as { error: unknown }).error === "string") {
					stats.blocked++;
					return text(`🚫 ${(resolved as { error: string }).error}`, { kind: "blocked" });
				}
				const r = resolved as Resolved;
				// 解析得到的账号登记为「本会话已验证」，发送类就不会再报「未经解析」
				for (const x of r.people ?? []) if (x.userId) state.resolved.add(x.userId);
				if (r.group?.cid) state.resolvedGroups.add(r.group.cid);
				if (r.message?.conversationId) state.resolvedGroups.add(r.message.conversationId);
				const built = def.build(p, r);
				if ("error" in built) {
					stats.blocked++;
					return text(`🚫 ${built.error}`, { kind: "blocked" });
				}
				return runGuarded(
					built.args,
					{
						view: {
							receivers: r.people?.map((x) => x.name ?? x.token),
							note: built.note,
							objects: r.objects,
							target: r.group?.title,
							people: r.people,
						},
					},
					ctx,
					id,
				);
			},
		});
	};

	registerSemanticTool({
		name: "dingtalk_msg",
		label: "收发钉钉消息",
		description:
			"钉钉消息：单聊/群/多人单聊/引用回复/转发/转 DING/撤回/查消息/建群。收件人写姓名或会话 ID（写「我」即本人），会话写群名或对方姓名。" +
			"发文件时本条不含说明正文，需另发一条文本。查消息默认把附件下载到工作目录。",
		params: MessageParams,
		async resolve(p: MessageParamsT) {
			const r: Resolved = {};
			if (p.action === "read" && p.sender && /^(me|我|自己|本人)$/i.test(p.sender.trim())) {
				const self = await whoAmI(cfg);
				if (self?.name) r.ids = { ...r.ids, selfName: self.name };
			}
			if (p.action === "createGroup") {
				if (p.members?.length) {
					const people = await resolvePeople(p.members);
					if (!("ok" in people)) return people;
					r.people = people.ok;
				}
				if (p.owner) {
					const own = await resolvePeople([p.owner]);
					if (!("ok" in own)) return own;
					const withIds = await withOpenIds(own.ok);
					if (!("ok" in withIds)) return withIds;
					r.ids = { ...r.ids, ownerOpenId: withIds.ok[0]!.openId! };
				}
			}
			if (["send", "broadcast", "ding", "dingByMessage"].includes(p.action) && p.to?.length) {
				const people = await resolvePeople(p.to);
				if (!("ok" in people)) return people;
				// 两类 DING 都只收 openDingTalkId：先补齐，缺了在构建参数时说清
				if (p.action === "ding" || p.action === "dingByMessage") {
					const withIds = await withOpenIds(people.ok);
					if (!("ok" in withIds)) return withIds;
					r.people = withIds.ok;
				} else r.people = people.ok;
			}
			if (p.group) {
				const g = await resolveGroup(p.group);
				if (!("ok" in g)) return g;
				r.group = g.ok;
			}
			if (p.destGroup) {
				const g = await resolveConversation(p.destGroup);
				if (!("ok" in g)) return g;
				r.destGroup = g.ok;
			}
			if (["reply", "forward", "dingByMessage", "recall"].includes(p.action) || (p.action === "read" && p.inGroup)) {
				if (p.action === "read") {
					const g = await resolveConversation(p.inGroup!);
					if (!("ok" in g)) return g;
					return { ...r, inGroup: g.ok, ids: { now: new Date().toISOString() } };
				}
				const m = await resolveMessage(p);
				if (!("ok" in m)) return m;
				// 单聊里的消息转 DING：收件人就是对话对方，这是唯一确定的答案，不必再让调用方给一遍
				if (p.action === "dingByMessage" && !r.people?.length) {
					const peer = await singleChatPeer(m.ok.conversationId);
					if (peer) r.people = [peer];
				}
				return { ...r, message: m.ok, ids: { now: new Date().toISOString() } };
			}
			return withExtras(r, undefined);
		},
		build(p: MessageParamsT, r: Resolved) {
			return buildMessage(p, r);
		},
	});

	registerSemanticTool({
		name: "dingtalk_todo",
		label: "管理钉钉待办",
		description: "钉钉待办：列表/新建/改期改标题/标记完成/删除/搜索。执行人写姓名，截止时间可写「明天 09:30」。",
		params: TodoParams,
		async resolve(p: TodoParamsT) {
			const r: Resolved = { ids: { now: new Date().toISOString() } };
			if (p.executors?.length) {
				const people = await resolvePeople(p.executors);
				if (!("ok" in people)) return people;
				r.people = people.ok;
			} else if (p.action === "create") {
				// 不指定执行人 = 派给自己：先把本人 userId 查出来（dws 不认 "me"）
				const self = await whoAmI(cfg);
				if (self?.userId) r.ids = { ...r.ids, selfUserId: self.userId };
			}
			if (p.taskId && isStableId(p.taskId)) r.ids = { ...r.ids, taskId: p.taskId };
			else if (["update", "complete", "delete"].includes(p.action)) {
				const title = p.taskId ?? p.title;
				if (!title) return { error: `${p.action} 需要 taskId，或给 title 让插件先按标题找` };
				const data = await callJson(["todo", "+search", "--query", title]);
				const id = data ? findScalar(data, ["taskId", "todoTaskId", "id"]) : undefined;
				if (!id) return { error: `没找到名为「${title}」的待办` };
				r.ids = { ...r.ids, taskId: id };
			}
			return r;
		},
		build(p: TodoParamsT, r: Resolved) {
			return buildTodo(p, r);
		},
	});

	registerSemanticTool({
		name: "dingtalk_calendar",
		label: "安排钉钉日程",
		description: "钉钉日程：查/建/改/取消/加参会人/查空闲会议室。参会人写姓名；订会议室用 rooms。",
		params: CalendarParams,
		async resolve(p: CalendarParamsT) {
			const r: Resolved = { ids: { now: new Date().toISOString() } };
			if (p.attendees?.length) {
				const people = await resolvePeople(p.attendees);
				if (!("ok" in people)) return people;
				r.people = people.ok;
			}
			if (p.eventId) r.ids = { ...r.ids, eventId: p.eventId };
			if (p.rooms?.length) {
				const args = ["calendar", "room", "search", "--limit", "20"];
				const s = p.start ? isoTime(p.start) : undefined;
				const e = p.end ? isoTime(p.end, { end: true }) : undefined;
				if (s && typeof s !== "string") return { error: s.error };
				if (e && typeof e !== "string") return { error: e.error };
				if (typeof s === "string") args.push("--start", s);
				if (typeof e === "string") args.push("--end", e);
				const ids: string[] = [];
				for (const name of p.rooms) {
					const data = await callJson([...args, "--room-name", name]);
					const id = data ? findScalar(data, ["roomId"]) : undefined;
					if (!id) return { error: `没搜到空闲会议室「${name}」（换个名字或时段再试）` };
					ids.push(id);
				}
				r.ids = { ...r.ids, roomIds: ids.join(",") };
			}
			return r;
		},
		build(p: CalendarParamsT, r: Resolved) {
			return buildCalendar(p, r);
		},
	});

	registerSemanticTool({
		name: "dingtalk_approval",
		label: "处理钉钉审批",
		description: "钉钉审批：看我审批/我发起/详情/同意/拒绝/转交/撤销/查模板/发起。instanceId 可写审批实例 ID 或审批编号（纯数字）。发起前先 formSchema 拿字段。",
		params: ApprovalParams,
		async resolve(p: ApprovalParamsT) {
			const r: Resolved = { ids: { now: new Date().toISOString() } };
			if (p.to) {
				const people = await resolvePeople([p.to]);
				if (!("ok" in people)) return people;
				r.people = people.ok;
			}
			if (["approve", "reject", "transfer", "detail", "revoke"].includes(p.action) && !p.instanceId) return { error: `${p.action} 需要 instanceId（审批实例 ID 或审批编号；可先 action=listPending 查一条）` };
			// 审批编号（纯数字 businessId）不能直接当实例 ID：先反查，查不到就当场说清而不是让上游报 400002
			// instanceId 位置收到纯数字：审批编号与实例 ID 的写法无法用形态区分（都是长数字），
			// 先按审批编号反查（用户手头只有单子上的编号），反查不到再当实例 ID 直发
			let instanceId = p.instanceId?.trim();
			if (instanceId && isLongDigits(instanceId)) {
				const hit = await lookupByApprovalNo(instanceId);
				if ("hit" in hit) instanceId = hit.hit;
				else if ("ambiguous" in hit) return { error: hit.ambiguous };
				// none：当作实例 ID 直接试（上传的实例 ID 与编号同为长数字，无法用形态区分）
			}
			if (instanceId) r.ids = { ...r.ids, instanceId };
			if (["approve", "reject", "transfer"].includes(p.action) && instanceId) {
				const data = await callJson(["oa", "approval", "tasks", "--instance-id", instanceId]);
				const taskId = data ? findScalar(data, ["taskId"]) : undefined;
				if (taskId) r.ids = { ...r.ids, taskId };
			}
			// 模板可以用名字给（「申请报告」），字段清单要拿 content 才有 label/子控件结构
			if (["forms", "formSchema", "forecast", "create"].includes(p.action) && p.processCode && idKindOf(p.processCode) !== "processCode") {
				const found = await resolveProcessCode(p.processCode);
				if (!("code" in found)) return { error: found.error };
				p = { ...p, processCode: found.code };
				if (found.name) r.objects = [found.name];
			}
			if (["formSchema", "forecast", "create"].includes(p.action)) {
				if (!p.processCode) return { error: `需要模板：给 processCode，或用 keyword 按模板名查（action=forms）` };
				const schema = await readFormSchema(p.processCode);
				if (!("fields" in schema)) return { error: schema.error };
				// formSchema 直接跑 form-schema 命令把原文交给模型看，不在这里拦
				if (p.action === "formSchema") return r;
				// 附件先传：模板不收附件时先拦下来，不为一个注定失败的发起白传一份上去
				if (p.attachments?.length) {
					if (!schema.fields.some((f) => f.componentName === "DDAttachment")) {
						return { error: `模板「${schema.name}」没有附件控件，attachments 无处可放（去掉 attachments 或换带附件的模板）` };
					}
					const up = await uploadApprovalAttachments(p.attachments as AttachmentInput[]);
					if (!("ok" in up)) return { error: up.error };
					r.attachments = up.ok;
					r.objects = [...(r.objects ?? []), ...up.ok.map((a) => `${a.fileName}（${Math.round((a.fileSize ?? 0) / 1024)} KB）`)].slice(0, 6);
				}
				// 明细表带值必然在上游退化成无字段名的「系统错误」（多模板实测），
				// 在这里拦下：不要生成草稿、更不要白传附件，直接给可行的替代路径
				const filled = filledTableLabels(schema.fields, (p.formValues ?? {}) as FormInput);
				if (filled.length) {
					return { error: `模板「${schema.name}」含明细表，钉钉 API 不支持带明细发起（上游只回「系统错误」）。请到钉钉客户端填写。` };
				}
				if (p.formValues && Object.keys(p.formValues).length) {
					const composed = composeFormValues(schema.fields, p.formValues as FormInput, r.attachments);
					const requiredMissing = composed.missing.filter((f) => f.required).map((f) => f.label);
					const problems = [...composed.errors];
					if (composed.unknown.length) problems.push(`模板里没有这些字段：${composed.unknown.join("、")}（本模板的字段：${schema.fields.map((f) => f.label).join("、")}）`);
					if (requiredMissing.length) problems.push(`缺必填字段：${requiredMissing.join("、")}`);
					if (problems.length) return { error: `表单值不合模板「${schema.name}」：\n${problems.map((x) => `· ${x}`).join("\n")}` };
					r.formValues = composed.values;
					r.objects = [schema.name, ...composed.filled].filter(Boolean).slice(0, 6);
					if (composed.missing.length) r.ids = { ...r.ids, skippedFields: composed.missing.map((f) => f.label).join("、") };
				} else if (p.action === "create") {
					return { error: `create 需要 formValues。模板「${schema.name}」的字段（* 必填）：\n${describeFormFields(schema.fields).join("\n")}` };
				}
			}
			return r;
		},
		build(p: ApprovalParamsT, r: Resolved) {
			return buildApproval(p, r);
		},
	});

	registerSemanticTool({
		name: "dingtalk_file",
		label: "管理钉盘文件",
		description: "钉盘文件：列目录/搜/看信息/上传/下载/新建文件夹/移动/重命名/删除/落地分享链接。位置写文件夹名、链接或 ID。",
		params: FileParams,
		// 分享落地是纯下载，不走两阶段：直接交给落地实现
		direct: async (p: FileParamsT, ctx: ExtensionContext) =>
			p.action === "fetch" ? fetchDriveShare({ link: p.link, spaceId: p.spaceId, nodeId: p.nodeId, outDir: p.out }, ctx) : null,
		async resolve(p: FileParamsT) {
			const r: Resolved = { ids: { now: new Date().toISOString() } };
			const ids: Record<string, string> = { ...r.ids };
			if (p.node) {
				const n = await resolveDriveNode(p.node);
				if (!("ok" in n)) return n;
				ids.node = n.ok;
			}
			if (p.folder) {
				const f = await resolveDriveNode(p.folder);
				if (!("ok" in f)) return f;
				ids.folder = f.ok;
			}
			if (p.dest) {
				const d = await resolveDriveNode(p.dest);
				if (!("ok" in d)) return d;
				ids.dest = d.ok;
			}
			if (p.file) {
				const abs = path.isAbsolute(p.file) ? p.file : path.join(process.cwd(), p.file);
				if (!fs.existsSync(abs)) return { error: `待上传的文件不存在：${p.file}（给工作目录内的相对路径）` };
			}
			r.ids = ids;
			return r;
		},
		build(p: FileParamsT, r: Resolved) {
			return buildFile(p, r);
		},
	});

	registerSemanticTool({
		name: "dingtalk_doc",
		label: "编辑钉钉文档表格",
		description: "钉钉文档/知识库/表格/多维表：读/搜/新建（文档或在线表格）/追加/覆盖或精确替换/表格区域读写/多维表记录增删改查。文档与表格可用标题、链接或 ID 指定。",
		params: DocParams,
		async resolve(p: DocParamsT) {
			const r: Resolved = { ids: { now: new Date().toISOString() } };
			const ids: Record<string, string> = { ...r.ids };
			if (p.doc) {
				const d = await resolveDocNode(p.doc);
				if (!("ok" in d)) return d;
				ids.doc = d.ok;
				// 表格/文档写操作的对象就用户写的那份名字（ID 不上面板）
				if (!isStableId(p.doc)) r.objects = [p.doc];
			}
			if (p.action === "sheetCreate" && p.folder) {
				const f = await resolveDriveNode(p.folder);
				if (!("ok" in f)) return f;
				ids.folder = f.ok;
			}
			if (["sheetSetDropdown", "sheetGetDropdown", "sheetDeleteDropdown"].includes(p.action) && !p.sheetId && ids.doc) {
				const data = await callJson(["sheet", "+list-sheets", "--node", ids.doc]);
				const sid = data ? parseFirstSheetId(JSON.stringify(data)) : null;
				if (!sid) return { error: "没取到工作表清单——sheetId 请显式给出（可用 sheetRead 确认）" };
				ids.sheetId = sid;
			}
			if (p.action === "wikiList" && p.workspace) {
				const data = await callJson(["wiki", "space", "list", "--type", "orgWikiSpace"]);
				const ws = isStableId(p.workspace) ? p.workspace : data ? findByField(data, ["name", "spaceName", "title", "workspaceName"], ["workspaceId"], p.workspace) : undefined;
				if (!ws) return { error: `没找到知识库「${p.workspace}」（可用 dingtalk_doc action="wikiList" 看清单）` };
				ids.workspace = ws;
			}
			if (["tableQuery", "tableAdd", "tableUpdate", "tableDelete"].includes(p.action)) {
				if (!p.base || !p.table) return { error: `${p.action} 需要 base（多维表名）+ table（数据表名）` };
				const data = await callJson(["aitable", "base", "search", "--query", p.base]);
				const baseId = isStableId(p.base) ? p.base : data ? findScalar(data, ["baseId"]) : undefined;
				if (!baseId) return { error: `没找到多维表「${p.base}」` };
				const info = await callJson(["aitable", "base", "get", "--base-id", baseId]);
				const tableId = isStableId(p.table) ? p.table : info ? findByField(info, ["tableName", "name", "title"], ["tableId"], p.table) ?? findScalar(info, ["tableId"]) : undefined;
				ids.baseId = baseId;
				if (tableId) ids.tableId = tableId;
				else return { error: `多维表「${p.base}」里没找到数据表「${p.table}」` };
				r.objects = [p.base, p.table].filter((v) => v && !isStableId(v));
			}
			r.ids = ids;
			return r;
		},
		build(p: DocParamsT, r: Resolved) {
			return buildDoc(p, r);
		},
	});

	pi.registerCommand("dws", {
		description: "钉钉桥：状态 ｜ unload 卸下工具 ｜ forget ｜ refresh",
		handler: async (cmdArgs, ctx) => {
			const arg = (cmdArgs ?? "").trim();
			if (arg === "unload") {
				pi.setActiveTools(pi.getActiveTools().filter((n) => !(LAZY_TOOLS as readonly string[]).includes(n)));
				if (ctx.hasUI) ctx.ui.notify("已卸下钉钉业务工具（下次用到时调 dingtalk_help 重新装载）", "info");
				return;
			}
			if (arg.startsWith("forget")) {
				const what = arg.slice(6).trim();
				if (!what) {
					if (ctx.hasUI) ctx.ui.notify(`已记住（以后不再弹窗）：\n${cfg.remembered.map((r) => `· ${r}`).join("\n") || "（空）"}\n用法：/dws forget <命令> 或 /dws forget all`, "info");
					return;
				}
				cfg.remembered = what === "all" ? [] : cfg.remembered.filter((r) => r !== what);
				saveJsonConfig(CONFIG_FILE, cfg);
				if (ctx.hasUI) ctx.ui.notify(`已更新记忆：${cfg.remembered.length} 条（以后这些操作会重新弹窗确认）`, "info");
				return;
			}
			if (arg === "refresh") {
				saveJsonConfig(SCHEMA_CACHE_FILE, {});
				if (ctx.hasUI) ctx.ui.notify("命令元数据缓存已清空（下次执行时会重新向 dws 查询）", "info");
				return;
			}
			const bin = resolveDws(cfg);
			const lines = [
				`dws 二进制：${bin.path}${bin.shell ? "（PATH 垫片）" : ""}`,
				`技能屏蔽前缀：${cfg.blockedSkillPrefixes.join("、")}`,
				`【AI发送】标签强制：${cfg.requireAiTag ? "开" : "关"}`,
				`本会话：已发 ${stats.sent} 条 / 拦截 ${stats.blocked} 次 / 已验证人员 ${state.resolved.size} 个 / 待确认草稿 ${state.pending.size} 份`,
				`已记住（以后不再弹窗）：${cfg.remembered.length} 条${cfg.remembered.length ? `：${cfg.remembered.slice(0, 6).join("、")}${cfg.remembered.length > 6 ? " 等" : ""}` : ""}`,
				`配置：${CONFIG_FILE}`,
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/* 测试直引 */
export { idKindOf, isStableId } from "./intents.js";

export const __test__ = {
	layoutList,
	enrichReviewTargets,
	dwsFailureNote,
	annotateApprovalList,
	annotateForecast,
	decideAttachmentReuse,
	summarizeDetail,
	fitItems,
	SEND_PREFIXES,
	QUERY_PREFIXES,
	sendSignature,
	fileFingerprints,
	stampedName,
	stampOutgoingFiles,
	flagValues,
	parseCmdParams,
	unknownFlags,
	isDownloadCommand,
	isLinkPublishFailure,
	shouldRetryRedirect,
	hasOutputFlag,
	schemaSaysLocalOutput,
	formatResourceDownloads,
	redirectOutputFlags,
	relocateLocalPaths,
	copyTree,
	copyEntry,
	extractPlaceholders,
	stripVarsFlags,
	parseVarsMap,
	validateVars,
	resolveRunVars,
	renderVars,
	personalKey,
	varsRowOf,
	personalizedRow,
	matchRecipientAliases,
	newExecState,
};
