/**
 * dingtalk-bridge：钉钉受控桥接（业务语义层 + 安全门禁）
 *
 * 背景：dingtalk-* 技能（dws npm postinstall 安装、升级即还原，不可改）以「冻结说明书 +
 * 凭记忆拼命令」驱动 dws，真实事故（误发/重发/记岔 ID/时间锚点漂移）证明文档约束对
 * 高风险操作不可靠。本扩展把 dws 的命名与参数彻底挡在模型之外，并把铁律做成工具层硬拦截。
 *
 * - L3 语义层（模型看到的只有这一层，7 个工具）：`dingtalk_msg` / `dingtalk_todo` /
 *   `dingtalk_calendar` / `dingtalk_approval` / `dingtalk_file` / `dingtalk_doc`——
 *   AI 只说业务话（收件人姓名、群名、「明天 09:30」），命令/flags/ID 由本文件解析
 *   （姓名→userId、群名→openConversationId、消息关键词→msgId、文档标题→nodeId、
 *   多维表名→baseId/tableId、手机号→账号）；`dws_skill` 是唯一的逃生舱，只给官方技能
 *   正文当知识，不给任何命令执行通道。同名/同名群不要求人工确认：把候选列回对话，
 *   由 AI 按部门/职务/工号自己挑（见 intents.ts 的场景→命令映射）。
 * - L2 安全门禁（`decideExec` 纯函数 + `runGuarded` 管线，语义层唯一入口）：
 *   · 分档由 dws schema 元数据决定（缓存 + 手写表兜底）：读直通 / 写两阶段 / 敏感档弹人工面板
 *   · 发送类（+dm / +messages-send* / +messages-reply / +broadcast / ding send-*）与转发类
 *     （+messages-forward*）强制两阶段——首次返回执行计划不发送，用户在对话里确认后带 confirm
 *     重调才执行；转发、卡片更新、转 DING 无正文可加标签，豁免标签检查
 *   · 群发（chat +broadcast）草稿前先跑只读 dry-run 预检收件人：有人未唯一解析就整体拦下
 *   · 人工面板只写人话（动作/对象/正文/影响），不放 argv 与裸 ID；无界面会话直接拒绝
 *   · 本会话相同（目标+内容）重复发送 → 拒执（防「为验证重发」）；撤回同理防重复
 *   · 查询结果自动附当前时间锚点；正文里的字面「反斜杠-n」自动归一为真换行；
 *     文件/媒体消息回报「本条不含正文」（说明文字必须另发一条）
 *   · 查消息顺手把消息里的附件落盘（图片/语音/文件 → 工作目录，路径回显，可直接 read）
 *   · 上游把能力标成对 AI 关闭（schema availability 非 available）或命令路径根本不存在时，
 *     直接说清原因，不让它伪装成内容错
 * - L0 技能过滤：before_agent_start 把 dingtalk-* 从系统提示词的技能清单摘掉（省上下文），
 *   需要时用 `dws_skill` 按需取回。
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
import { askReview, fitItems, layoutList, reviewActions } from "../shared/review-panel";
import {
	buildApproval,
	buildCalendar,
	buildDoc,
	buildFile,
	buildMessage,
	buildTodo,
	isoTime,
	type Built,
	type Resolved,
	type ResolvedGroup,
	type ResolvedMessage,
	type ResolvedPerson,
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

/** 把已有消息转 DING（无正文，标签规则不适用；两版写法：schema 的 cli_path 与技能文档的本地命令） */
const DING_BY_MESSAGE_PREFIXES: string[][] = [
	["ding", "+send-by-message"],
	["ding", "message", "send-by-message"],
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
	["ding", "+send-personal"], // 本人身份发 DING（schema 的 cli_path）
	["ding", "message", "send-personal"], // 同上，dws 官方技能文档记的本地命令写法
	["ding", "message", "send"], // 机器人身份发 DING
	...DING_BY_MESSAGE_PREFIXES, // 把已有消息转 DING
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
/** 正文类 flag（做字面 \n 归一） */
const CONTENT_FLAGS = new Set(["--content", "--text", "--markdown"]);
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
	[["ding", "+send-personal"], "发DING"],
	[["ding", "message", "send-personal"], "发DING"],
	[["ding", "+send-by-message"], "转DING提醒"],
	[["ding", "message", "send-by-message"], "转DING提醒"],
	[["ding", "message", "send"], "发DING"],
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
	[["ding", "+send-personal"], "强打扰对方；短信/电话类型会产生费用"],
	[["ding", "message", "send-personal"], "强打扰对方；短信/电话类型会产生费用"],
	[["ding", "+send-by-message"], "把该消息转成 DING 强提醒收件人；短信/电话类型会产生费用"],
	[["ding", "message", "send-by-message"], "把该消息转成 DING 强提醒收件人；短信/电话类型会产生费用"],
	[["ding", "message", "send"], "强打扰对方；短信/电话类型会产生费用"],
	[["mail", "message", "send"], "对方邮箱会立即收到"],
	[["oa", "approval", "create-instance"], "审批流开启后无法撤回（除非自行撤销）"],
	[["calendar", "event", "create"], "会给参会人发邀请通知"],
	[["calendar", "event", "delete"], "⚠ 所有参会人的日程同步取消，不可恢复"],
	[["minutes", "+upload"], "会真实上传本地文件并在云端创建一条听记"],
];

const labelOf = (args: string[], table: Array<[string[], string]>): string | undefined =>
	table.find(([p]) => matchPrefix(args, [p]))?.[1];

/** 正文预览：取正文类 flag 的值，按行截断（长文不糊满面板） */
export function contentPreview(args: string[], maxLines = 12, truncLine = 120): string[] {
	const raw = flagValues(args, CONTENT_FLAGS)[0];
	if (!raw) return [];
	const lines = raw.split("\n").filter((l) => l.trim());
	const shown = lines.slice(0, maxLines).map((l) => (l.length > truncLine ? `${l.slice(0, truncLine)}…` : l));
	if (lines.length > maxLines) shown.push(`…（共 ${lines.length} 行，全文请在对话中查看）`);
	return shown;
}

/** 目标对象：只给人能认出来的东西（姓名/群名/文件名/人数），绝不出现裸 ID 与 flag */
export function targetSummary(args: string[], extra: { recipients?: string[]; note?: string } = {}): string[] {
	const out: string[] = [];
	if (extra.recipients?.length) {
		const show = extra.recipients.slice(0, 8).join("、");
		out.push(`发给 ${extra.recipients.length} 人：${show}${extra.recipients.length > 8 ? ` 等` : ""}`);
	} else {
		const named = flagValues(args, TARGET_FLAGS).filter((v) => hasCJK(v));
		const ids = flagValues(args, TARGET_FLAGS).flatMap((v) => v.split(",")).filter((v) => v.trim() && !hasCJK(v));
		if (named.length) out.push(`发给：${named.join("、")}`);
		else if (ids.length) out.push(`发给 ${ids.length} 个账号（未能解析出姓名）`);
	}
	const groups = flagPairs(args, GROUP_FLAGS);
	if (groups.length) out.push(`目标会话：${groups.map((g) => (hasCJK(g.value) ? g.value : "指定的会话")).join("、")}`);
	if (flagValues(args, RECALL_ID_FLAGS).length) out.push("对象：你指定的那条消息");
	for (const f of flagValues(args, new Set(["--file", "--file-path"]))) out.push(`文件：${path.basename(f)}`);
	if (extra.note) out.push(extra.note);
	return out;
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
	extra: { recipients?: string[]; note?: string } = {},
): { title: string; verb: string; object: string; objectItems?: { label: string; items: string[] }; content: string[]; impact: string[]; canRemember: boolean } {
	const verb = labelOf(args, ACTION_LABELS) ?? (meta?.effect === "destructive" ? "破坏性操作" : "钉钉操作");
	const impact = labelOf(args, IMPACT_HINTS) ?? (meta?.effect === "destructive" ? "⚠ 破坏性操作，通常不可恢复" : "会按上面的内容执行");
	const content = flagValues(args, CONTENT_FLAGS).length ? contentPreview(args) : [];
	// 对象：带前缀标签（收件人 / 群 / 撤回对象 / 文件），人多时"前 3 个 + 等 N 人"
	const recipients = extra.recipients ?? [];
	let object = "";
	if (recipients.length) {
		object = `收件人：${recipients.slice(0, 3).join("、")}${recipients.length > 3 ? ` 等 ${recipients.length} 人` : ""}`;
	} else {
		const named = flagValues(args, TARGET_FLAGS).filter((v) => hasCJK(v));
		const ids = flagValues(args, TARGET_FLAGS).flatMap((v) => v.split(",")).filter((v) => v.trim() && !hasCJK(v));
		const groups = flagPairs(args, GROUP_FLAGS).filter((g) => hasCJK(g.value)).map((g) => g.value);
		const files = flagValues(args, new Set(["--file", "--file-path"])).map((f) => path.basename(f));
		if (named.length) object = `收件人：${named.join("、")}`;
		else if (ids.length) object = `收件人：${ids.length} 个账号`;
		else if (groups.length) object = `群：${groups.join("、")}`;
		else if (files.length) object = `文件：${files.join("、")}`;
		else if (flagValues(args, RECALL_ID_FLAGS).length) object = `对象：${extra.note ?? "指定的那条消息"}`;
	}
	return {
		title: "agent请求操作钉钉",
		verb,
		object,
		objectItems: recipients.length ? { label: "收件人", items: recipients } : undefined,
		content,
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
	const isDingSend = args[0] === "ding" && (dingSendSub === "+send-personal" || dingSendSub === "+send-by-message" || dingSendSub === "send-personal" || dingSendSub === "send-by-message");
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

const hasCJK = (s: string): boolean => /[㐀-鿿豈-﫿]/.test(s);

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

/** 待确认草稿：存的是「已解析的计划」，confirm 时按计划执行，不再重新解析 */
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
	/** 逐人个性化：预检得到的收件人（含 openId）——confirm 时按这份名单逐一发送 */
	plan?: BroadcastPreflight;
}
export const newExecState = (): ExecState => ({ resolved: new Set(), resolvedGroups: new Set(), pending: new Map(), sent: new Map() });

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
	for (const a of args) {
		const key = a.startsWith("-") ? (a.indexOf("=") > 0 ? a.slice(0, a.indexOf("=")) : a) : null;
		if (key && !known.has(key) && !GLOBAL_FLAGS.has(key) && !out.includes(key)) out.push(key);
	}
	// 位置参数（非 flag 开头）不拦：部分命令合法收位置参数（如 contact user get --ids 无位置参数，但 drive push 有路径）
	return out;
}

/** 消息签名：命令前缀 + 目标 + 内容相关 flag 值（剔除易变 flag），判定「同一条消息」 */
function sendSignature(args: string[]): string {
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
	return createHash("sha1").update(JSON.stringify(kept)).digest("hex").slice(0, 16);
}

export type ExecDecision =
	| { action: "run" }
	| { action: "block"; reason: string; kind?: "unavailable" | "formal" | "unknown-path" }
	| { action: "pending"; token: string; preview: string };

/**
 * --formal 不是命令参数（旧版提示曾引导模型往参数里加它）：出现即拦下，避免模型原地打转。
 */
export function formalFlagError(args: string[]): string | null {
	const hit = args.find((a) => a === "--formal" || a.startsWith("--formal="));
	if (!hit) return null;
	return `没有 ${hit} 这个参数：AI 发送的角标由插件自动带上，直接去掉它重调即可。`;
}

/**
 * 发送/查询策略判定（纯函数）。args 为完整 dws 子命令 argv（不含 dws 本身、不含自动附加 flag）。
 * formal=true 表示用户明确要求的正式通知（豁免【AI发送】标签）；confirm 为两阶段确认 token。
 */
export function decideExec(
	args: string[],
	opts: {
		confirm?: string;
		formal?: boolean;
		/** 分档（缺省用手写表兜底）；由调用方查元数据后传入 */
		tier?: Tier;
		/** 命令元数据（dws schema 的安全语义；缺省 null） */
		meta?: CmdMeta | null;
		/** 分档理由（写进草稿与弹窗，让人知道为什么被拦） */
		why?: string;
		/** 审核文案补充（如群发预检得到的收件人列表） */
		reviewExtra?: { recipients?: string[]; note?: string };
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
		if (opts.confirm) {
			const p = state.pending.get(opts.confirm);
			if (p && p.sig === sig && p.expiresAt > now) {
				state.pending.delete(opts.confirm);
				return { action: "run" };
			}
			return { action: "block", reason: "确认标记无效或已过期（草稿 10 分钟有效）。请重新发起并让用户再次确认。" };
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

	const sig = sendSignature(args);
	if (isSend && state.sent.has(sig)) {
		return {
			action: "block",
			reason:
				"本会话或近期已发送过相同目标与内容的消息（防重发台账），已拦截。绝不为验证而重发——" +
				"要核对请用只读查询（如 dingtalk_msg action=\"read\", sender=\"me\"）。",
		};
	}

	if (opts.confirm) {
		const p = state.pending.get(opts.confirm);
		if (p && p.sig === sig && p.expiresAt > now) {
			state.pending.delete(opts.confirm);
			return { action: "run" };
		}
		return {
			action: "block",
			reason: "确认标记无效或已过期（草稿 10 分钟有效）。请重新发起并让用户再次确认草稿。",
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
		`📋 执行计划（未执行）。确认执行：带 confirm="${token}" 用同一个工具、同一组业务参数重调；草稿 ${ttlMin} 分钟有效，过期即作废（重发需重新生成草稿并重新确认）。`,
		"",
		`动作与对象：${[review.verb, review.object].filter(Boolean).join("  ") || "（见下）"}`,
		...(review.content.length ? ["内容：", ...review.content.map((l) => `  ${l}`)] : []),
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
 * 就不能用它：改为预检拿到每人 openDingTalkId 后，逐人渲染正文、逐人 +messages-send。
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
	"key 与 --to 里的写法逐字一致（用 userId 消歧的就写 userId）；大表用 --vars-file <工作目录内相对路径.json>。";

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

/** 校验变量表覆盖全部收件人与占位符；返回问题清单（空 = 通过） */
export function validateVars(recipients: string[], placeholders: string[], map: VarsMap): string[] {
	const problems: string[] = [];
	for (const r of recipients) {
		const row = map[r];
		if (!row) {
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
		const body = renderVars(content, vars[rec.recipient] ?? {});
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
	/** 部门全路径名（如 班主任-诚毅校区班主任） */
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
 * 人员行：`- 李娜｜班主任-诚毅校区班主任｜工号 0161… → 016113645862842894`。
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

/** 从群发失败条目里取输入的那个名字（`李娜（"李娜" 匹配到多个用户…）` → `李娜`） */
export function failingName(raw: string): string {
	const cut = raw.search(/[（(]/);
	return (cut > 0 ? raw.slice(0, cut) : raw).trim();
}

/** 从 contact +me 输出取本人身份（发后核验命令需要「自己姓名」作 --sender） */
export function parseSelf(text: string): { name: string; userId: string } | null {
	try {
		const found = parsePeopleLike(JSON.parse(text), (o) => typeof ci(o, "userId") === "string" && typeof ci(o, "name") === "string");
		return found.length ? { name: String(ci(found[0]!, "name")), userId: String(ci(found[0]!, "userId")) } : null;
	} catch {
		return null;
	}
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
			return `- ${r.fileId}（type=${r.type}）：仅数字 dentryId、缺 spaceId，不能用 +messages-resource-download 下载；spaceId 在正文的 yunpan 链接里，或让对方重发。`;
		}
		if (r.type === "folder") {
			return `- 文件夹 spaceId=${r.spaceId} fileId=${r.fileId}：用 dingtalk_file（action="fetch", link="<消息原文>"）镜像到本地`;
		}
		return `- 文件 spaceId=${r.spaceId} fileId=${r.fileId}：用 dingtalk_file（action="fetch", link="<消息原文>"）下载`;
	});
	return `\n\n🔗 钉盘/云盘分享资源（这类消息用 +messages-resource-download 会报 TABLE_NOT_FOUND，需走 drive）：\n${lines.join("\n")}`;
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

/* ============================== 技能逃生舱（复杂管理操作走原生技能） ============================== */

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

/** 技能索引文本（一行一个）；逃生舱的无参形态，替代被过滤的系统提示词技能清单 */
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
			if (/\.part-\d+$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
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
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

/** 用户是否显式要求覆盖（决定搬回时是否覆盖同名文件） */
function wantsOverwrite(args: string[]): boolean {
	return args.some((a) => a === "--overwrite" || a.startsWith("--overwrite="));
}

let cachedSelf: { name: string; userId: string } | null | undefined;
/** 本人身份（惰性获取并缓存）：发后核验命令需要自己的姓名作 --sender */
async function whoAmI(cfg: BridgeConfig): Promise<{ name: string; userId: string } | null> {
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
export function parseConversationInfo(text: string): { title: string; singleChat: boolean; memberCount: number } | null {
	try {
		const info = (JSON.parse(text) as { result?: { conversationInfo?: Record<string, unknown> } }).result?.conversationInfo;
		if (!info) return null;
		return {
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
				content: digest.map((d) => d.preview || "（图片/文件等无文字消息）"),
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
				content: digest.map((d) => d.preview || "（图片/文件等无文字消息）"),
			};
		}
	}
	// 发送：把裸 userId 换成"姓名（部门）"，让主角行直接写人名
	const ids = [
		...new Set(
			flagValues(args, TARGET_FLAGS)
				.flatMap((v) => v.split(","))
				.map((x) => x.trim())
				.filter((v) => v && !hasCJK(v)),
		),
	];
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
	return { ...review, object: `收件人：${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${names.length} 人` : ""}`, objectItems: { label: "收件人", items: names } };
}

/**
 * 工具结果：details.kind 为 error/blocked 时置 isError（pi 侧模型与 UI 才识别为失败），
 * 其余（ok/列表/预演）为正常结果。
 */
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
			bad.push(`- 「${n}」有 ${p.cands.length} 个候选（把重名的名字换成候选里的 userId 重发）`);
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
		lines.push(`- 「${name}」有 ${cands.length} 个候选（把重名的名字换成候选里的 userId 重发）：`);
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
		const g1 =
			"钉钉操作一律用 dingtalk_* 业务工具：命令与账号 ID 由插件解析，AI 没有直接执行 dws 命令的通道。";
		const g2 =
			"写操作首次只回执行计划：用户在对话里确认后，带 confirm（同一个工具、同一组业务参数）重调才执行；破坏性与对外发送类还会弹人工确认，无界面会话直接拒绝。";
		const g3 =
			"同名或同名群会返回候选（带部门/职务/工号与账号 ID）：由 AI 自己挑定后，把该项换成候选里的 ID 重调——不要重复猜姓名，也不必转问用户。";
		const g4 =
			"业务工具覆盖不到的长尾钉钉操作，用 dws_skill 读官方文档判断可行性，再把结论回报用户。";
		if (!guidelines.includes(g1)) guidelines.push(g1, g2, g3, g4);
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
			_id: string,
			params: { args: string[]; confirm?: string; view?: { receivers?: string[]; note?: string } },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const view = params.view;
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
			for (const f of flagValues(args, /* @__PURE__ */ new Set(["--file", "--file-path"]))) {
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
			if (!params.confirm) {
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
			const peek = params.confirm ? state.pending.get(params.confirm) : void 0;
			const placeholders = extractPlaceholders(flagValues(args, CONTENT_FLAGS).at(-1) ?? "");
			let varsMap;
			if (placeholders.length) {
				if (!matchPrefix(args, BROADCAST_PREFIXES)) {
					stats.blocked++;
					return text(`🚫 正文里的 {{${placeholders[0]}}} 是按人替换的占位符，目前只在群发（chat +broadcast）下生效；其他命令请直接把正文写好。`, { kind: "blocked" });
				}
				const input = readVarsInput(baseDir, varsRaw, varsFile);
				const parsed = input.error ? { error: input.error } : input.raw === void 0 ? void 0 : parseVarsMap(input.raw, placeholders);
				if (parsed && "error" in parsed) {
					stats.blocked++;
					return text(`🚫 ${parsed.error}

${VARS_GUIDE}`, { kind: "blocked" });
				}
				if (parsed) varsMap = parsed.map;
				else if (!isDryRun(args)) {
					stats.blocked++;
					return text(`🚫 正文里有占位符 ${placeholders.map((p) => `{{${p}}}`).join("、")}，但没有给变量表。

${VARS_GUIDE}`, { kind: "blocked" });
				}
			}
			const decision = decideExec(args, { confirm: params.confirm, tier, meta, why, flags: schema?.params, reviewExtra: view ? { recipients: view.receivers, note: view.note } : void 0 }, state, cfg, Date.now());
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
					if (varsMap) {
						const problems = validateVars(plan.resolved.map((r2) => r2.recipient), placeholders, varsMap);
						if (problems.length) {
							state.pending.delete(decision.token);
							stats.blocked++;
							return text(`🚫 变量表不齐（未生成草稿、未发送任何消息）：
${problems.map((p) => `- ${p}`).join("\n")}

${VARS_GUIDE}`, { kind: "blocked" });
						}
						const content = flagValues(args, CONTENT_FLAGS).at(-1) ?? "";
						sampleLines = plan.resolved.slice(0, 3).map((r2) => `- ${r2.recipient} → ${renderVars(content, varsMap[r2.recipient] ?? {}).replace(/\s*\n\s*/g, " ⏎ ").slice(0, 70)}`);
					}
					const draft = state.pending.get(decision.token);
					if (draft) {
						draft.review = buildReview(args, meta, why, { recipients: plan.resolved.map((r2) => r2.recipient) });
						if (varsMap) {
							draft.vars = varsMap;
							draft.plan = plan;
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
					`📋 执行计划（未执行）。带 confirm="${decision.token}" 重调即可执行：

${pathNote ? `${pathNote}

` : ""}${decision.preview}${broadcastTable}${fixedNote}`,
					{ kind: "pending", token: decision.token }
				);
			}
			if (peek?.tier === "sensitive" && !isRemembered(cfg, args)) {
				const outcome = await askReview(ctx, {
					...await enrichReviewTargets(cfg, args, peek.review),
					actions: reviewActions(peek.canRemember),
					rememberNote: rememberedKey(args)
				});
				if (outcome.kind === "no-ui") {
					stats.blocked++;
					return text("🚫 这条操作需要你本人确认，但当前会话弹不出确认窗（无界面模式），已拒绝执行。请在带界面的会话里重试。", { kind: "blocked" });
				}
				if (outcome.kind === "rejected") {
					stats.blocked++;
					return text("🚫 你拒绝了这条操作，未执行。", { kind: "blocked" });
				}
				if (outcome.kind === "remembered") {
					rememberCommand(cfg, args);
					ctx.ui.notify(`dingtalk-bridge：已记住「${rememberedKey(args)}」，以后这类操作不再弹窗（可用 /dws forget 取消）`, "info");
				}
			}
			if (peek?.vars && peek.plan && matchPrefix(args, BROADCAST_PREFIXES)) {
				const res = await sendPersonalized(cfg, args, peek.plan, peek.vars, state);
				saveLedger(cfg, state);
				stats.sent += res.sent.length;
				const failLines = res.failed.length ? `

失败 ${res.failed.length} 人（未发出，可修好后重发这些人）：
${res.failed.map((f) => `- ${f.name}：${f.why}`).join("\n")}` : "";
				const skipLines = res.skipped.length ? `

已发过、本次跳过 ${res.skipped.length} 人：${res.skipped.join("、")}（同一人同一正文有固定幂等键）` : "";
				return text(
					`✓ 逐人发送完成（共 ${peek.plan.resolved.length} 人）：成功 ${res.sent.length} 人${failLines}${skipLines}`,
					{ kind: "ok", sent: res.sent, skipped: res.skipped, failed: res.failed.map((f) => f.name) }
				);
			}
			let r = await runDws(cfg, buildArgv(args), { timeoutMs: execTimeoutOf(cfg, args) });
			let redirectNote = "";
			// 硬链接失败可能以 exit 0 + 结果里 failedCount 的形式回来（查消息附带下载就是这种），
			// 所以不靠退出码判断，只看错误文本；重试幂等（第一次失败不落任何文件）
			if (await shouldRetryRedirect(cfg, args, r.stderr + r.stdout)) {
				const redirected = await runDwsRedirected(cfg, buildArgv(args), baseDir, wantsOverwrite(args));
				if (redirected) {
					r = redirected.result;
					redirectNote = `

（本机工作目录所在磁盘不支持硬链接，已自动改在系统临时区下载并搬回：${redirected.copied} 个文件${redirected.skipped.length ? `，${redirected.skipped.length} 个因已存在未覆盖` : ""}）`;
				}
			}
			if (r.timedOut)
				return text(
					`dws 执行超时（${Math.round(execTimeoutOf(cfg, args) / 1e3)}s）${isDownloadCommand(args) ? "：下载可能只是没跑完，目标目录里已落盘的文件仍然有效，别整条重跑" : "，命令可能未生效——如涉及发送，先用只读查询确认，绝不要直接重跑"}`,
					{ kind: "error" },
				);
			let out = r.stdout.trim();
			const errTail = r.stderr.trim();
			if (r.code !== 0) {
				if (dryRun && matchPrefix(args, BROADCAST_PREFIXES)) {
					return text(await broadcastProbeReport(cfg, args, "没有一位收件人解析成功"), { kind: "blocked" });
				}
				return text(`dws 失败（exit ${r.code}）：${errTail || out}`, { kind: "error" });
			}
			if (dryRun && matchPrefix(args, BROADCAST_PREFIXES)) {
				const plan = parseBroadcastPreflight(out);
				const body = [formatBroadcastPreflight(plan)];
				if (placeholders.length && varsMap) {
					const content = flagValues(args, CONTENT_FLAGS).at(-1) ?? "";
					body.push(
						"",
						`逐人个性化（${placeholders.map((p) => `{{${p}}}`).join("、")}）渲染样例：`,
						...plan.resolved.slice(0, 3).map((r2) => `- ${r2.recipient} → ${renderVars(content, varsMap[r2.recipient] ?? {}).replace(/\s*\n\s*/g, " ⏎ ").slice(0, 70)}`),
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
				return text(`🧪 群发预演（未发送任何消息）

${body.join("\n")}`, { kind: "ok", resolved: plan.resolved, skipped: plan.skipped });
			}
			if (!dryRun && matchPrefix(args, RECALL_PREFIXES)) {
				const ids = flagValues(args, RECALL_ID_FLAGS);
				state.sent.set(`recall:${ids.join(",")}`, { at: Date.now(), snippet: args.join(" ").slice(0, 80) });
				saveLedger(cfg, state);
				stats.sent++;
				out += `

（已记录撤回：${ids.join("、")}——同一消息不会重复撤回）`;
			} else if (!dryRun && matchPrefix(args, SEND_PREFIXES)) {
				state.sent.set(sendSignature(args), { at: Date.now(), snippet: args.join(" ").slice(0, 80) });
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

⚠️ 本条是${media === "file" ? "文件" : "媒体"}消息，已发出但**不含任何说明正文**（--title 只作文件卡标题，不在消息里显示）。如用户需要说明文字，请现在另发一条文本消息（--text/--markdown 或 +dm --content）；不要以为说明已随本条发出。`;
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
			if (!matchPrefix(args, SEND_PREFIXES) && !matchPrefix(args, RECALL_PREFIXES)) {
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
			if (pathNote) out = `${pathNote}

${out}`;
			return text(truncateOut(out, cfg.maxOutputChars) || "（无输出）", { kind: "ok" });
		}
	};
	/** 语义层复用同一条受控管线（换行归一 → 分档 → 参数自检 → 两阶段 → 人工面板 → 台账 → 结果注解） */
	const runGuarded = (
		args: string[],
		opts: { confirm?: string; view?: { receivers?: string[]; note?: string } },
		ctx: ExtensionContext,
	) => execTool.execute("semantic", { args, confirm: opts.confirm, view: opts.view } as never, undefined, undefined, ctx);

	// 唯一逃生舱：只给知识（官方技能正文），不给执行通道
	pi.registerTool({
		name: "dws_skill",
		label: "读钉钉技能文档",
		description:
			"查钉钉官方技能文档（dingtalk-* 技能）：无 topic 时列出全部技能及一句话说明，传 topic（短名如 sheet/todo，或全名 dingtalk-chat）返回该技能正文。",
		promptSnippet: "查钉钉技能文档：dws_skill([topic]) → 技能索引 / 技能正文",
		parameters: Type.Object({
			topic: Type.Optional(Type.String({ description: "技能短名（如 chat、sheet、todo）或全名（dingtalk-chat）；缺省列出全部技能" })),
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

	/** 某个 token 像稳定 ID（无中文且够长）还是像姓名 */
	const isIdLike = (s: string): boolean => !hasCJK(s) && /^[0-9A-Za-z_+-]{6,}$/.test(s.trim());

	/** 调 dws 并解析 JSON（失败 / 非 JSON 返回 null） */
	const callJson = async (args: string[]): Promise<unknown | null> => {
		try {
			const r = await runDws(cfg, [...args, "--format", "json"]);
			if (r.code !== 0 || r.timedOut) return null;
			const raw = r.stdout.trim() || r.stderr.trim();
			const i = raw.indexOf("{");
			return i >= 0 ? (JSON.parse(raw.slice(i)) as unknown) : null;
		} catch {
			return null;
		}
	};

	/** 人员解析：姓名走 aisearch；已是稳定 ID 时只补姓名用于面板展示 */
const resolvePeople = async (tokens: string[]): Promise<{ ok: ResolvedPerson[] } | { error: string } | { choice: string }> => {
		const ok: ResolvedPerson[] = [];
		for (const token of [...new Set(tokens.map((t) => t.trim()).filter(Boolean))]) {
			// 完整手机号：通讯录反查（唯一命中才放行）
			if (/^1[3-9]\d{9}$/.test(token)) {
				const data = await callJson(["contact", "user", "search-mobile", "--mobile", token]);
				const uid = data ? findScalar(data, ["userId"]) : undefined;
				if (!uid) return { error: `手机号 ${token} 没反查到账号` };
				const orgs = await orgInfoOf(cfg, [uid]);
				ok.push({ token, userId: uid, name: orgs.get(uid)?.name || undefined });
				continue;
			}
			if (!isIdLike(token)) {
				const data = await callJson(["aisearch", "person", "--query", token, "--dimension", "name"]);
				const hits = data ? parsePeople(JSON.stringify(data)) : [];
				if (!hits.length) return { error: `没找到「${token}」：核对用字，或直接给这个人的完整手机号` };
				if (hits.length > 1) {
					const lines = await personLines(cfg, hits);
					return {
						choice: `「${token}」有 ${hits.length} 个同名：按部门/职务/工号挑定，把该项收件人换成箭头后的 ID 后重调（其余收件人照旧）：\n${lines.join("\n")}`,
					};
				}
				const hit = hits[0]!;
				ok.push({ token, userId: hit.userId, openId: hit.openId, name: hit.name || token });
				continue;
			}
			// 已是 ID：补姓名（面板要写人名，不写 ID）
			const orgs = await orgInfoOf(cfg, [token]);
			ok.push({ token, userId: token, name: orgs.get(token)?.name || undefined });
		}
		return { ok };
	};

	/** 已知姓名时补 openDingTalkId（DING 必须用它）；顺带把 userId 换成 openId */
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
			const hits = parsePeople(JSON.stringify(await callJson(["aisearch", "person", "--query", name, "--dimension", "name"])));
			const hit = hits.find((h) => h.userId === p.userId) ?? hits.find((h) => h.openId);
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
		if (isIdLike(token) && token.startsWith("cid")) return { ok: { token, cid: token } };
		const data = await callJson(["chat", "+chat-search", "--query", token]);
		const list = data ? parseGroups(JSON.stringify(data)) : [];
		const hits = list.filter((g) => ci(g, "title") === token || ci(g, "openConversationId"));
		const named = hits.filter((g) => pickStr(ci(g, "title")) === token);
		const cands = named.length ? named : hits;
		if (!cands.length) return { error: `没找到群「${token}」（可先用逃生舱 chat +chat-search 核对群名）` };
		if (cands.length > 1) {
			const lines = cands.map((g) => `· ${pickStr(ci(g, "title"))}（${pickStr(ci(g, "openConversationId"))}）`);
			return { error: `群名「${token}」匹配到 ${cands.length} 个会话，请让用户确认：\n${lines.join("\n")}\n（确认后把 group 改成对应的 openConversationId）` };
		}
		const g = cands[0]!;
		const cid = pickStr(ci(g, "openConversationId"));
		if (!cid) return { error: `群「${token}」没解析出会话 ID` };
		return { ok: { token, cid, title: pickStr(ci(g, "title")) || token } };
	};

	/** 消息定位：直接给 messageId 时补会话；否则按会话+发送人+关键词搜一条 */
	const resolveMessage = async (p: { messageId?: string; inGroup?: string; group?: string; keyword?: string; sender?: string; days?: number }): Promise<{ ok: ResolvedMessage } | { error: string }> => {
		let cid: string | undefined;
		let groupTitle: string | undefined;
		const gToken = p.inGroup ?? p.group;
		if (gToken) {
			const g = await resolveGroup(gToken);
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
		if (!msgId) return { error: `在「${groupTitle ?? cid}」里没找到符合条件的消息——把关键词说得更准，或用逃生舱 chat +search-msg 自己查一条` };
		const conv = data ? findScalar(data, ["openConversationId", "conversationId"]) : undefined;
		return { ok: { msgId, conversationId: conv ?? cid } };
	};

	/** 搜索结果里挑真正的文档（docType=folder 的是文件夹，别把它当初文档） */
	const pickDocNode = (data: unknown): string | undefined => {
		let folder: string | undefined;
		let hit: string | undefined;
		const walk = (v: unknown): void => {
			if (hit) return;
			if (Array.isArray(v)) return v.forEach(walk);
			if (!v || typeof v !== "object") return;
			const o = v as Record<string, unknown>;
			const id = [o.nodeId, o.dentryUuid, o.docId].find((x) => typeof x === "string" && x);
			if (typeof id === "string") {
				const kind = String(o.docType ?? o.type ?? o.nodeType ?? "");
				if (kind === "folder") folder ??= id;
				else {
					hit = id;
					return;
				}
			}
			Object.values(o).forEach(walk);
		};
		walk(data);
		return hit ?? folder;
	};

	/** 文档/表格定位：链接与 ID 直接用，标题先搜 */
	const resolveDocNode = async (token: string): Promise<{ ok: string } | { error: string }> => {
		if (/^https?:\/\//.test(token) || isIdLike(token)) return { ok: token };
		const data = await callJson(["doc", "+search", "--query", token, "--limit", "10"]);
		const node = data ? pickDocNode(data) : undefined;
		if (!node) return { error: `没搜到名为「${token}」的文档/表格（可按链接或节点 ID 直接给）` };
		return { ok: node };
	};

	/** 钉盘节点/文件夹定位：名称、链接或 ID → 稳定 ID */
	const resolveDriveNode = async (token: string): Promise<{ ok: string } | { error: string }> => {
		if (/^https?:\/\//.test(token)) {
			const info = await callJson(["drive", "info", "--node", token]);
			const id = info ? findScalar(info, ["nodeId", "dentryUuid", "dentryId"]) : undefined;
			if (!id) return { error: `没解析出链接里的节点 ID：${token}` };
			return { ok: id };
		}
		if (isIdLike(token)) return { ok: token };
		const data = await callJson(["drive", "+search", "--query", token, "--limit", "10"]);
		const id = data ? findScalar(data, ["nodeId", "dentryUuid"]) : undefined;
		if (!id) return { error: `钉盘里没找到「${token}」` };
		return { ok: id };
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
			label: def.label,
			description: def.description,
			promptSnippet: `${def.label}：${def.name}(action, …) → 结果`,
			parameters: def.params as never,
			async execute(
			_id: string,
			params: { args: string[]; confirm?: string; view?: { receivers?: string[]; note?: string } },
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
						confirm: (p as { confirm?: string }).confirm,
						view: { receivers: r.people?.map((x) => x.name ?? x.token), note: [built.note, r.group?.title ? `目标会话：${r.group.title}` : ""].filter(Boolean).join("；") || undefined },
					},
					ctx,
				);
			},
		});
	};

	registerSemanticTool({
		name: "dingtalk_msg",
		label: "收发钉钉消息",
		description:
			"钉钉消息：单聊/群消息/多人单聊/引用回复/转发/转 DING/撤回/查消息。收件人写姓名或账号 ID，会话写群名或会话 ID。" +
			"发文件时本条不含说明正文，说明要另发一条文本。" +
			"查消息默认把消息里的图片/语音/文件下载到工作目录（路径见结果，可直接 read；outDir 改目录、downloadResources=false 关闭）。",
		params: MessageParams,
		async resolve(p: MessageParamsT) {
			const r: Resolved = {};
			if (p.action === "read" && p.sender && /^(me|我|自己|本人)$/i.test(p.sender.trim())) {
				const self = await whoAmI(cfg);
				if (self?.name) r.ids = { ...r.ids, selfName: self.name };
			}
			if (["send", "broadcast", "ding"].includes(p.action) && p.to?.length) {
				const people = await resolvePeople(p.to);
				if (!("ok" in people)) return people;
				if (p.action === "ding") {
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
				const g = await resolveGroup(p.destGroup);
				if (!("ok" in g)) return g;
				r.destGroup = g.ok;
			}
			if (["reply", "forward", "ding", "recall"].includes(p.action) || (p.action === "read" && p.inGroup)) {
				if (p.action === "read") {
					const g = await resolveGroup(p.inGroup!);
					if (!("ok" in g)) return g;
					return { ...r, inGroup: g.ok, ids: { now: new Date().toISOString() } };
				}
				const m = await resolveMessage(p);
				if (!("ok" in m)) return m;
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
		description: "钉钉待办：列表/新建/改期改标题/标记完成/删除/搜索。执行人写姓名，截止时间写「明天 09:30」这类自然写法。",
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
			if (p.taskId && isIdLike(p.taskId)) r.ids = { ...r.ids, taskId: p.taskId };
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
		description: "钉钉日程：查/建/改/取消/加参会人/查空闲会议室。参会人写姓名；地点只是文字，订会议室用 rooms。",
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
		description: "钉钉审批：看待我审批/我发起的/详情/同意/拒绝/转交/撤销/查模板/发起。发起前先用 forms 拿模板与字段名。",
		params: ApprovalParams,
		async resolve(p: ApprovalParamsT) {
			const r: Resolved = { ids: { now: new Date().toISOString() } };
			if (p.to) {
				const people = await resolvePeople([p.to]);
				if (!("ok" in people)) return people;
				r.people = people.ok;
			}
			if (["approve", "reject", "transfer", "detail", "revoke"].includes(p.action) && !p.instanceId) return { error: `${p.action} 需要 instanceId（可先 action=listPending 查一条）` };
			if (p.instanceId) r.ids = { ...r.ids, instanceId: p.instanceId };
			if (["approve", "reject", "transfer"].includes(p.action) && p.instanceId) {
				const data = await callJson(["oa", "approval", "tasks", "--instance-id", p.instanceId]);
				const taskId = data ? findScalar(data, ["taskId"]) : undefined;
				if (taskId) r.ids = { ...r.ids, taskId };
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
		description: "钉盘文件：列目录/搜/看信息/上传/下载/新建文件夹/移动/重命名/删除/落地消息里的分享链接。位置写文件夹名、链接或 ID。",
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
		description: "钉钉文档/知识库/表格/多维表：读/搜/新建/追加/覆盖或精确替换/表格区域读写/多维表记录增删改查。文档与表格可用标题、链接或 ID 指定。",
		params: DocParams,
		async resolve(p: DocParamsT) {
			const r: Resolved = { ids: { now: new Date().toISOString() } };
			const ids: Record<string, string> = { ...r.ids };
			if (p.doc) {
				const d = await resolveDocNode(p.doc);
				if (!("ok" in d)) return d;
				ids.doc = d.ok;
			}
			if (p.action === "wikiList" && p.workspace) {
				const data = await callJson(["wiki", "space", "list", "--type", "orgWikiSpace"]);
				const ws = isIdLike(p.workspace) ? p.workspace : data ? findByField(data, ["name", "spaceName", "title", "workspaceName"], ["workspaceId"], p.workspace) : undefined;
				if (!ws) return { error: `没找到知识库「${p.workspace}」（可先用逃生舱 wiki +space-list 看清单）` };
				ids.workspace = ws;
			}
			if (["tableQuery", "tableAdd", "tableUpdate", "tableDelete"].includes(p.action)) {
				if (!p.base || !p.table) return { error: `${p.action} 需要 base（多维表名）+ table（数据表名）` };
				const data = await callJson(["aitable", "base", "search", "--query", p.base]);
				const baseId = isIdLike(p.base) ? p.base : data ? findScalar(data, ["baseId"]) : undefined;
				if (!baseId) return { error: `没找到多维表「${p.base}」` };
				const info = await callJson(["aitable", "base", "get", "--base-id", baseId]);
				const tableId = isIdLike(p.table) ? p.table : info ? findByField(info, ["tableName", "name", "title"], ["tableId"], p.table) ?? findScalar(info, ["tableId"]) : undefined;
				ids.baseId = baseId;
				if (tableId) ids.tableId = tableId;
				else return { error: `多维表「${p.base}」里没找到数据表「${p.table}」` };
			}
			r.ids = ids;
			return r;
		},
		build(p: DocParamsT, r: Resolved) {
			return buildDoc(p, r);
		},
	});

	pi.registerCommand("dws", {
		description: "钉钉桥：状态（配置/统计/技能屏蔽/已记住）｜ forget <命令|all> ｜ refresh",
		handler: async (cmdArgs, ctx) => {
			const arg = (cmdArgs ?? "").trim();
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
export const __test__ = {
	layoutList,
	fitItems,
	SEND_PREFIXES,
	QUERY_PREFIXES,
	sendSignature,
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
	renderVars,
	personalKey,
};
