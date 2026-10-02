/**
 * dingtalk-bridge：钉钉（dws CLI）受控桥接
 *
 * 背景：dingtalk-* 技能（dws npm postinstall 安装、升级即还原，不可改）以「冻结说明书 +
 * 凭记忆拼命令」的方式驱动 dws，教研室项目事故史（误发/重发/记岔 ID/时间锚点漂移）证明
 * 文档约束对高风险操作不可靠。本扩展把机械可判的铁律变成工具层硬拦截：
 *
 * - L0 技能过滤：before_agent_start 把 dingtalk-* 从注入清单摘掉（配置化前缀），
 *   /skill:dingtalk-* 手动加载不受影响（逃生舱）
 * - L1 执行底座：dws_schema（包 dws schema --compact 活内省，分层下钻防大块 schema 糊脸）、
 *   dws_exec（argv 数组直传 spawn，不过 shell，自动补 --format json -y）
 * - L2 安全拦截（decideExec 纯函数）：
 *   · 发送类（chat +dm / +messages-send / ding message send-*）强制两阶段——首次返回草稿
 *     回执不发送，对话内经用户确认后带 confirm token 重调才执行（项目铁律：审核在对话里）
 *   · 发送缺【AI发送】标签 → 拒执（正式通知经用户明确要求时传 formal=true 豁免）
 *   · 发送目标含中文姓名 → 拒执，强制先 dws_resolve_user 实时解析（禁凭记忆硬编码 ID）；
 *     未经本会话解析的 userId 放行但附软警告
 *   · 本会话相同（目标+内容）重复发送 → 拒执，提示改用只读查询验证（防「为验证重发」事故）
 *   · 查询类结果自动附当前系统时间（时间窗一律相对此刻，防沿用对话旧日期锚点）
 *   · 正文里的字面「反斜杠-n」自动归一为真换行（模型常把换行写成两个字符，dws 会
 *     吃成空格导致分行静默粘连）；文件/媒体消息发出后明确回报「本条不含正文」
 *     （--title 不显示给收件人，说明文字必须另发一条）
 * - dws_skill（逃生舱）：消息收发之外的复杂管理操作（表格/文档/日历/审批/组织/听记等）
 *   按需拉取官方技能正文（无参给技能索引）——技能文件不动，只是不再常驻系统提示词
 * - dws_resolve_user：包 aisearch person，单候选自动记入本会话已验证集，多候选列出并要求
 *   pick 参数确认，零候选给换维度/手机号反查的指引 *
 * 配置 ~/.pi/agent/dingtalk-bridge.json：requireAiTag（默认 true）/ blockedSkillPrefixes /
 * dwsPath / execTimeoutMs / maxOutputChars。/dws-bridge 查看状态。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadJsonConfig, saveJsonConfig } from "./shared/config";

/* ============================== 可调配置 ============================== */

const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "dingtalk-bridge.json");
/** 已发送台账：跨会话防重发（新进程/重开会话时内存状态清零，靠它拦住「重跑一遍」） */
const LEDGER_FILE = path.join(os.homedir(), ".pi", "agent", "dingtalk-bridge-sent.json");
/** 待确认草稿有效期：超时需重新走确认（防拿昨天的回执发今天的消息） */
const PENDING_TTL_MS = 10 * 60_000;
/** dws schema 摘要单层输出预算（超出提示继续下钻） */
const SCHEMA_MAX_CHARS = 12_000;
/** dws_skill 单次返回的技能正文上限 */
const SKILL_MAX_CHARS = 12_000;

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
}
const DEFAULT_CONFIG: BridgeConfig = {
	requireAiTag: true,
	blockedSkillPrefixes: ["dingtalk-"],
	execTimeoutMs: 60_000,
	maxOutputChars: 30_000,
	dedupMinutes: 60,
};
const isConfig = (v: unknown): v is BridgeConfig =>
	typeof v === "object" && v !== null &&
	((v as BridgeConfig).requireAiTag === undefined || typeof (v as BridgeConfig).requireAiTag === "boolean");

function loadConfig(): BridgeConfig {
	const cfg = loadJsonConfig(CONFIG_FILE, {}, (v): v is Partial<BridgeConfig> => typeof v === "object" && v !== null);
	return { ...DEFAULT_CONFIG, ...cfg };
}

/* ============================== 纯函数（策略层，测试直引） ============================== */

/** 发送类命令前缀（argv 前几项匹配即命中）：命中即走两阶段 + 标签 + 防重发全套校验 */
const SEND_PREFIXES: string[][] = [
	["chat", "+dm"], // 按姓名/ID 发单聊
	["chat", "+send-to-group"], // 按群名/ID 发群消息
	["chat", "+messages-send"], // 统一发送入口（user/bot/webhook，含多群）
	["chat", "+messages-send-by-bot"], // 机器人发群
	["chat", "+messages-send-by-webhook"], // Webhook 机器人发群
	["chat", "+messages-send-card"], // 卡片消息
	["ding", "+send-personal"], // 本人身份发 DING
	["ding", "message", "send-by-message"], // 转原消息为 DING
	["ding", "message", "send-personal"], // 新写内容发 DING
];
/** 查询类命令前缀：结果前自动附当前系统时间 */
const QUERY_PREFIXES: string[][] = [
	["chat", "+search-msg"],
	["chat", "+chat-messages"],
	["chat", "+messages-query-send-status"],
	["chat", "+conversation-list"],
];
/** 发送目标取值 flag（含中文姓名即拒执） */
const TARGET_FLAGS = new Set(["--to", "--user", "--users"]);
/** 群目标 flag：值可能是中文群名（同名群/改群名都会发错）——同样要求解析成 openConversationId */
const GROUP_FLAGS = new Set(["--group", "--chat-id"]);
/** 正文类 flag（做字面 \n 归一） */
const CONTENT_FLAGS = new Set(["--content", "--text", "--markdown"]);
/** 文件/媒体类 flag：命中则本条消息无正文（协议层与正文互斥） */
const MEDIA_FLAGS = new Set(["--file", "--file-path", "--media-id"]);
const MEDIA_TYPES = new Set(["file", "image", "audio", "video"]);
/** 签名计算时剔除的易变 flag（不影响「同一条消息」判定） */
const VOLATILE_FLAGS = new Set(["--format", "-f", "--yes", "-y", "--timeout", "--jq", "--fields"]);

const matchPrefix = (args: string[], prefixes: string[][]): boolean =>
	prefixes.some((p) => p.every((seg, i) => args[i] === seg));

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
	if (!(args[0] === "ding" && (args[1] === "+send-personal" || (args[1] === "message" && args[2] === "send-personal")))) return undefined;
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

/** 本次发送是否 markdown 正文（--markdown 任意命令；+dm 的 --content 也支持 Markdown） */
export function isMarkdownBody(args: string[]): boolean {
	const hasFlag = (f: string) => args.some((a) => a === f || a.startsWith(`${f}=`));
	if (hasFlag("--markdown")) return true;
	return args[0] === "chat" && args[1] === "+dm" && hasFlag("--content");
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
	/** 待确认草稿：token → 签名/参数/过期时刻 */
	pending: Map<string, { sig: string; args: string[]; expiresAt: number }>;
	/** 已发送签名 → 首次发送时刻与摘要 */
	sent: Map<string, { at: number; snippet: string }>;
}
export const newExecState = (): ExecState => ({ resolved: new Set(), pending: new Map(), sent: new Map() });

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
	| { action: "block"; reason: string }
	| { action: "pending"; token: string; preview: string };

/**
 * 发送/查询策略判定（纯函数）。args 为完整 dws 子命令 argv（不含 dws 本身、不含自动附加 flag）。
 * formal=true 表示用户明确要求的正式通知（豁免【AI发送】标签）；confirm 为两阶段确认 token。
 */
export function decideExec(
	args: string[],
	opts: { confirm?: string; formal?: boolean },
	state: ExecState,
	cfg: Pick<BridgeConfig, "requireAiTag">,
	now: number,
): ExecDecision {
	if (!matchPrefix(args, SEND_PREFIXES)) return { action: "run" };

	const labelOk =
		args.includes("--ai-tag") || args.some((a) => a.includes("【AI发送】"));
	if (cfg.requireAiTag && !labelOk && !opts.formal) {
		return {
			action: "block",
			reason:
				"发送内容缺【AI发送】标记，已拦截。请在消息正文开头加上【AI发送】后重试；" +
				"若这是用户明确要求的正式通知，以 formal=true 重新调用。",
		};
	}

	const targets = flagValues(args, TARGET_FLAGS);
	const cjkTarget = targets.find((t) => hasCJK(t));
	if (cjkTarget) {
		return {
			action: "block",
			reason:
				`发送目标「${cjkTarget}」是姓名而非 userId，已拦截。严禁凭记忆硬编码 ID——` +
				"请先用 dws_resolve_user 实时解析，多候选时与用户确认后再发。",
		};
	}
	const cjkGroup = flagPairs(args, GROUP_FLAGS).find((p) => hasCJK(p.value));
	if (cjkGroup) {
		return {
			action: "block",
			reason:
				`发送目标群「${cjkGroup.value}」是群名而非 openConversationId，已拦截（同名群、改群名都会发错）。` +
				"请先解析成稳定 ID：dws_exec [\"chat\", \"+chat-search\", \"--query\", \"<群名>\"]，再用 --group <openConversationId> 发送。",
		};
	}

	const sig = sendSignature(args);
	if (state.sent.has(sig)) {
		return {
			action: "block",
			reason:
				"本会话或近期已发送过相同目标与内容的消息（台账防重发），已拦截。发送命令绝不为验证而重发——" +
				"请改用只读查询确认：dws_exec [\"chat\", \"+search-msg\", \"--sender\", \"<自己姓名>\", ...]。",
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
			reason: "确认标记无效或已过期（草稿 10 分钟有效）。请重新发起发送并让用户再次确认草稿。",
		};
	}

	// 首次发送：登记待确认草稿，回执交模型在对话里请用户审核
	const token = createHash("sha1").update(`${sig}:${now}`).digest("hex").slice(0, 10);
	state.pending.set(token, { sig, args: [...args], expiresAt: now + PENDING_TTL_MS });
	const media = mediaKind(args);
	const channel = dingChannel(args);
	const preview = [
		`命令：dws ${args.join(" ")}`,
		targets.length ? `目标：${targets.join("、")}` : null,
		channel && channel !== "app" ? `⚠️ 本条为${channel === "sms" ? "短信" : "电话"} DING：会产生实际费用与强打扰（默认 app 应用内 DING 免费）——确认前先与用户核对是否必要` : null,
		media ? `本条为${media === "file" ? "文件" : "图片/音视频"}消息：不含正文——解释文字必须另发一条文本消息（--text/--markdown/--content）` : null,
	].filter(Boolean).join("\n");
	return { action: "pending", token, preview };
}

/** 查询类结果附当前系统时间（防沿用对话记忆中的旧日期锚点） */
export function annotateQuery(args: string[], stdout: string, now: Date): string {
	if (!matchPrefix(args, QUERY_PREFIXES)) return stdout;
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `⏱ 当前系统时间：${stamp}（时间窗一律相对此刻推算：start=此刻-N 小时、end=此刻；勿沿用对话记忆中的旧日期）\n\n${stdout}`;
}

/** 从 aisearch person 输出宽松提取人员候选（兼容字段层级变化）：收集所有含 userId 的对象 */
export function parsePeople(text: string): { userId: string; name: string; extra: string }[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return [];
	}
	const found = new Map<string, { userId: string; name: string; extra: string }>();
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (typeof v !== "object" || v === null) return;
		const o = v as Record<string, unknown>;
		if (typeof o.userId === "string" && o.userId) {
			const name = typeof o.name === "string" ? o.name : typeof o.userName === "string" ? o.userName : "";
			const extra = [o.department, o.dept, o.title, o.jobNumber]
				.filter((x): x is string => typeof x === "string" && Boolean(x))
				.join("/");
			if (!found.has(o.userId)) found.set(o.userId, { userId: o.userId, name, extra });
		}
		Object.values(o).forEach(walk);
	};
	walk(data);
	return [...found.values()];
}

/** dws schema --compact 输出整层摘要：产品层列产品一句话，产品详情层列工具一行一个，叶子层原样 */
export function formatSchemaOutput(raw: string, maxChars: number): string {
	const truncate = (s: string, why: string) =>
		s.length <= maxChars ? s : `${s.slice(0, maxChars)}\n\n……（输出过长已截断：${why}，请传更具体的 path 逐层下钻）`;
	let doc: Record<string, unknown>;
	try {
		doc = JSON.parse(raw);
	} catch {
		return truncate(raw, "非 JSON");
	}
	const line = (parts: (string | undefined)[]) => parts.filter(Boolean).join("｜");
	// 产品总览层：{ level: "products", products/groups: [...] }
	const products = (doc.products ?? doc.groups ?? doc.items) as unknown;
	if (doc.level === "products" && Array.isArray(products)) {
		const lines = products.map((p) => {
			const o = p as Record<string, unknown>;
			return line([String(o.id ?? o.name ?? "?"), (o.agent_summary ?? o.description) as string]);
		});
		return truncate(`共 ${products.length} 个产品。下钻：dws_schema path=\"<产品id>\"；查参数：dws_schema path=\"<canonical_path>\"\n\n${lines.join("\n")}`, "产品过多");
	}
	// 产品/分组层：{ product: { tools: [...] } } 或 { tools: [...] }
	const tools = (doc.tools ?? (doc.product as Record<string, unknown> | undefined)?.tools ?? (doc.group as Record<string, unknown> | undefined)?.tools) as unknown;
	if (Array.isArray(tools)) {
		const list = tools as Record<string, unknown>[];
		const lines = list.map((t) =>
			line([
				String(t.canonical_path ?? t.cli_path ?? t.id ?? "?"),
				(t.agent_summary ?? t.description) as string,
				t.effect ? `[${t.effect}${t.risk ? `/${t.risk}` : ""}]` : undefined,
			]),
		);
		return truncate(
			`共 ${list.length} 个工具。查参数：dws_schema path=\"<canonical_path>\"\n\n${lines.join("\n")}`,
			"工具过多",
		);
	}
	return truncate(raw, "已到叶子或结构未识别");
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

function runDws(cfg: BridgeConfig, args: string[]): Promise<RunResult> {
	const bin = resolveDws(cfg);
	return new Promise((resolveP, reject) => {
		const child = spawn(bin.path, args, { shell: bin.shell, windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, cfg.execTimeoutMs);
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

const text = (t: string, details: Record<string, unknown> = {}) => ({
	content: [{ type: "text" as const, text: t }],
	details,
});

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
			"钉钉操作（消息/日历/文档/待办/审批/表格等）已由 dingtalk-bridge 接管：dws_schema 查命令用法（无参看产品概览、逐层下钻）、dws_exec 执行（args 数组直传免转义）、dws_resolve_user 按姓名解析 userId；无需加载 dingtalk-* 技能。";
		const g2 =
			"dws_exec 的发送类命令（+dm/+messages-send/ding）强制两阶段：首次调用只返回草稿回执不发送，须把草稿展示给用户、经明确同意后带 confirm 重调才真发；缺【AI发送】标签或目标是中文姓名都会被拦截。";
		const g3 =
			"消息收发之外的复杂钉钉操作（表格/文档/日历/审批/组织/听记等）先 dws_skill 拉取对应官方技能正文再照做——技能已移出系统提示词，需要时按需加载。";
		const g4 =
			"发钉钉消息：多行正文用真换行（写在字符串里就是换行，勿写两个字面反斜杠-n）；文件/图片消息不含正文（--title 不显示给收件人），说明文字必须另发一条文本——文件与说明分开发。";
		if (!guidelines.includes(g1)) guidelines.push(g1, g2, g3, g4);
	});

	pi.on("session_start", () => {
		state.resolved.clear();
		state.pending.clear();
		state.sent.clear();
		loadLedger(cfg, state);
	});

	// L1：schema 活内省（分层下钻）
	pi.registerTool({
		name: "dws_schema",
		label: "钉钉命令查询",
		description:
			"查询钉钉 dws CLI 的实时命令 schema（随 CLI 版本更新，永不漂移）。无参返回产品概览（29 个产品线）；" +
			"path 传产品 id（如 todo/chat/sheet）返回该产品工具清单；path 传工具 canonical_path（如 todo.add_task）返回参数 schema。" +
			"不确定命令用法时先查这里，不要凭记忆拼 dws 命令。",
		promptSnippet: "钉钉命令查询：dws_schema(path?) → 产品概览/工具清单/参数 schema",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "产品 id（如 chat）或工具 canonical_path（如 chat.send_dm）；缺省返回产品概览" })),
		}),
		async execute(_id, params) {
			const args = ["schema", ...(params.path ? [params.path] : []), "--compact", "--format", "json"];
			const r = await runDws(cfg, args);
			if (r.timedOut) return text(`dws schema 超时（${cfg.execTimeoutMs / 1000}s）`, { kind: "error" });
			if (r.code !== 0) return text(`dws schema 失败：${r.stderr.trim() || r.stdout.trim()}`, { kind: "error" });
			return text(formatSchemaOutput(r.stdout.trim(), SCHEMA_MAX_CHARS));
		},
	});

	// L1+L2：受控执行（argv 直传 + 安全拦截）
	pi.registerTool({
		name: "dws_exec",
		label: "钉钉执行",
		description:
			"执行钉钉 dws CLI 命令。args 为完整子命令的 argv 数组（不含 dws 本身），如 [\"chat\", \"+dm\", \"--to\", \"<userId>\", \"--content\", \"【AI发送】…\"]；" +
			"数组直传不过 shell，内容含空格/引号/换行都安全。自动附加 --format json 与 --yes。命令用法先用 dws_schema 查。" +
			"发送类命令强制两阶段：首次返回草稿回执（不发送），把草稿展示给用户确认后，带 confirm 重调才真发。" +
			"发送缺【AI发送】标签会被拒（用户明确要求的正式通知传 formal=true）；目标是中文姓名会被拒（先 dws_resolve_user 解析）；同内容重复发送会被拒。",
		promptSnippet: "执行钉钉命令：dws_exec(args 数组[, confirm][, formal]) → JSON 结果",
		parameters: Type.Object({
			args: Type.Array(Type.String(), { description: "dws 子命令 argv 数组（不含 dws 本身），如 [\"todo\", \"task\", \"list\"]", minItems: 1 }),
			confirm: Type.Optional(Type.String({ description: "两阶段确认的草稿 token（首次发送调用的回执里给出）；仅在用户于对话中明确同意草稿后携带" })),
			formal: Type.Optional(Type.Boolean({ description: "用户明确要求的正式通知时传 true，豁免【AI发送】标签检查" })),
		}),
		async execute(_id, params) {
			// 字面 反斜杠-n 先归一：模型常把换行写成两个字符，dws 会吃成空格导致静默粘连
			const norm = normalizeContent(params.args);
			const args = norm.args;
			const decision = decideExec(args, { confirm: params.confirm, formal: params.formal }, state, cfg, Date.now());
			if (decision.action === "block") {
				stats.blocked++;
				return text(`🚫 ${decision.reason}`, { kind: "blocked" });
			}
			if (decision.action === "pending") {
				const notes = [
					norm.fixed ? `正文里的 ${norm.fixed} 处字面反斜杠-n 已转为真换行` : "",
					norm.hardBreaks ? `${norm.hardBreaks} 处换行已补 markdown 行尾双空格（钉钉单换行会拼成一行）` : "",
					hasMultilineText(args) ? "纯文本 --text 的多行在钉钉会拼成一行，建议改用 --markdown" : "",
				].filter(Boolean);
				const fixedNote = notes.length ? `

（${notes.join("；")}）` : "";
				return text(
					`📋 草稿待确认（尚未发送）。请把以下草稿展示给用户，经明确同意后用 confirm=\"${decision.token}\" 重新调用：\n\n${decision.preview}${fixedNote}`,
					{ kind: "pending", token: decision.token },
				);
			}
			const r = await runDws(cfg, buildArgv(args));
			if (r.timedOut) return text(`dws 执行超时（${cfg.execTimeoutMs / 1000}s），命令可能未生效——如涉及发送，先用只读查询确认，绝不要直接重跑`, { kind: "error" });
			let out = r.stdout.trim();
			const errTail = r.stderr.trim();
			if (r.code !== 0) {
				return text(`dws 失败（exit ${r.code}）：${errTail || out}`, { kind: "error" });
			}
			if (matchPrefix(args, SEND_PREFIXES)) {
				state.sent.set(sendSignature(args), { at: Date.now(), snippet: args.join(" ").slice(0, 80) });
				saveLedger(cfg, state);
				stats.sent++;
				const sentNotes = [
					norm.fixed ? `正文里的 ${norm.fixed} 处字面反斜杠-n 已转为真换行` : "",
					norm.hardBreaks ? `${norm.hardBreaks} 处换行已补 markdown 行尾双空格（钉钉单换行会拼成一行）` : "",
					hasMultilineText(args) ? "纯文本 --text 的多行在钉钉会拼成一行——本次可能已粘连，需要多行请改用 --markdown" : "",
				].filter(Boolean);
				if (sentNotes.length) out += `

（${sentNotes.join("；")}）`;
				const unverified = flagValues(args, TARGET_FLAGS).filter((t) => !state.resolved.has(t) && !hasCJK(t));
				if (unverified.length) {
					out += `\n\n⚠️ 提醒：目标 ${unverified.join("、")} 未在本会话经 dws_resolve_user 验证——若 ID 来自记忆而非实时查询，请用 +search-msg 核对收件人。`;
				}
				const media = mediaKind(args);
				if (media) {
					out +=
						`\n\n⚠️ 本条是${media === "file" ? "文件" : "媒体"}消息，已发出但**不含任何说明正文**（--title 只作文件卡标题，不在消息里显示）。` +
						`如用户需要说明文字，请现在另发一条文本消息（--text/--markdown 或 +dm --content）；不要以为说明已随本条发出。`;
				}
			}
			out = annotateQuery(args, out, new Date());
			return text(truncateOut(out, cfg.maxOutputChars) || "（无输出）", { kind: "ok" });
		},
	});

	// L2：人员解析（强制实时查证，多候选必须确认）
	pi.registerTool({
		name: "dws_resolve_user",
		label: "钉钉人员解析",
		description:
			"按姓名实时解析钉钉 userId（发消息前的强制步骤）。单候选自动确认；多候选返回候选列表，与用户确认人选后带 pick=<userId> 再调一次完成确认；" +
			"零候选可换 keyword 更精确的值重试，或改用完整手机号反查：dws_exec [\"contact\", \"user\", \"search-mobile\", \"--mobile\", \"<手机号>\"。",
		promptSnippet: "解析钉钉人员：dws_resolve_user(姓名[, pick=userId]) → userId",
		parameters: Type.Object({
			name: Type.String({ description: "完整姓名（按原文保真，不截断不改写）" }),
			pick: Type.Optional(Type.String({ description: "多候选时用户选定人选的 userId（须出现在候选列表中）" })),
		}),
		async execute(_id, params) {
			const r = await runDws(cfg, ["aisearch", "person", "--query", params.name, "--dimension", "name", "--format", "json"]);
			if (r.timedOut) return text("人员搜索超时", { kind: "error" });
			if (r.code !== 0) return text(`人员搜索失败：${r.stderr.trim() || r.stdout.trim()}`, { kind: "error" });
			const people = parsePeople(r.stdout);
			if (params.pick) {
				const hit = people.find((p) => p.userId === params.pick);
				if (!hit) {
					return text(`pick 的 userId「${params.pick}」不在「${params.name}」的候选列表中，未确认。候选：${people.map((p) => `${p.name}(${p.userId})`).join("、") || "（空）"}`, { kind: "error" });
				}
				state.resolved.add(hit.userId);
				return text(`✓ 已确认：${hit.name}（userId: ${hit.userId}）`, { kind: "ok", userId: hit.userId });
			}
			if (people.length === 0) {
				return text(
					`未找到「${params.name}」。可检查姓名用字，或用完整手机号反查：dws_exec ["contact", "user", "search-mobile", "--mobile", "<手机号>"]`,
					{ kind: "error" },
				);
			}
			if (people.length > 1) {
				const list = people.map((p) => `- ${p.name || "（无名）"}${p.extra ? `（${p.extra}）` : ""}：${p.userId}`).join("\n");
				return text(
					`「${params.name}」有 ${people.length} 个候选，请与用户确认人选后带 pick=<userId> 重新调用：\n${list}`,
					{ kind: "ambiguous", candidates: people },
				);
			}
			const p = people[0]!;
			state.resolved.add(p.userId);
			stats.resolved++;
			return text(`✓ ${p.name || params.name}（userId: ${p.userId}）${p.extra ? `｜${p.extra}` : ""}`, { kind: "ok", userId: p.userId });
		},
	});

	// 逃生舱：消息收发之外的复杂操作（表格/文档/日历/审批/组织等）按需拉官方技能正文
	pi.registerTool({
		name: "dws_skill",
		label: "钉钉技能文档",
		description:
			"按需读取钉钉官方技能文档（dws postinstall 安装的 dingtalk-* 技能；插件默认把它们移出系统提示词以省上下文，这里是按需拿回的正道）。" +
			"无 topic 时列出全部技能及一句话说明；传 topic（短名如 chat/sheet/todo，或全名 dingtalk-chat）返回该技能完整正文。" +
			"复杂钉钉操作（表格/文档/日历/审批/组织/听记等）先拉取对应技能再照做——里面有完整命令路由与踩坑。",
		promptSnippet: "钉钉技能文档：dws_skill([topic]) → 技能索引 / 技能正文",
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

	pi.registerCommand("dws-bridge", {
		description: "dingtalk-bridge 状态（配置/本会话统计/技能屏蔽）",
		handler: async (_args, ctx) => {
			const bin = resolveDws(cfg);
			const lines = [
				`dws 二进制：${bin.path}${bin.shell ? "（PATH 垫片）" : ""}`,
				`技能屏蔽前缀：${cfg.blockedSkillPrefixes.join("、")}`,
				`【AI发送】标签强制：${cfg.requireAiTag ? "开" : "关"}`,
				`本会话：已发 ${stats.sent} 条 / 拦截 ${stats.blocked} 次 / 已验证人员 ${state.resolved.size} 个 / 待确认草稿 ${state.pending.size} 份`,
				`配置：${CONFIG_FILE}`,
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/* 测试直引 */
export const __test__ = {
	SEND_PREFIXES,
	QUERY_PREFIXES,
	sendSignature,
	flagValues,
};
