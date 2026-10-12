/**
 * keep: 停顿点续航——助手自然停下时旁支自检三选一，该续就续
 *
 * 机制（旁支自检，主记录零污染）：
 * 1. turn_end 边界：本轮 assistant 消息无 toolCall、运行正常完成、无排队消息且预算未用完 → 发起旁支自检：
 *    复刻主会话请求前缀（捕获的系统提示词 + 过滤后的会话消息 + 复刻的工具集），末尾追加自检问题，
 *    跑一次 agentLoop（限 1 轮）拿 A/B/C 判定——提问与回答都不进主记录，也不进后续请求。
 * 2. A：注入判定块（展示）+ keep-go（隐藏指令）并 continue 续跑；B/C：把判定块挂到本轮末尾后停下。
 * 3. 判定块 keep-verdict 是自定义消息：带底色 + 判定配色，纯展示、永不进模型请求（过滤器一律滤掉）。
 *
 * 复刻前缀的目的与边界：
 * - provider 前缀缓存按「工具集 → 系统提示词 → 消息序列」逐字节匹配，三者齐了才命中；
 *   命中与否只影响花费（未命中则全量按非缓存计价），不影响判定正确性。
 * - 系统提示词取自 before_agent_start 的 systemPrompt；工具集按 getActiveTools() 的顺序与集合复刻
 *   （声明内容取 getAllTools() 的 name/description/parameters），执行体换成空实现——
 *   定义用于对齐缓存前缀，空实现保证自检期间即使模型误调工具也无副作用。
 * - 是否命中由 .pi/keep-cache.log 的 cacheRead 观测（keep 每次自检追加一行）。
 *
 * 触发门槛：仅「工作型停点」——本轮（自上次用户输入起）出现过改写类工具调用。
 * 判定三层：内建集合（bash/write/edit/codemode，内建工具无注解）→ readOnlyHint 注解
 * （MCP/扩展声明）→ 无注解按只读。零工具与只读工具的收尾是问答/调研的天然终点，
 * 不自检；判断消息意图不如判断动作后果可靠，漏判代价只是退回没有 keep 的原生行为。
 *
 * 防失控双保险：
 * 1. 续跑轮（keep-go 后）仍无 toolCall → 直接停，不再自检；
 * 2. 每次用户输入重置的续航预算 MAX_CONTINUATIONS（一次自检消耗 1），用完强制停。
 *
 * 命令：/keep 无参切换开关（全局持久于 ~/.pi/agent/keep.json，默认开，走 shared/config 原子写）。
 * 状态 key：keep（hud-core STATUS_STYLE 已登记）。自检模型：用途 keep-triage，默认 AUTO（跟随会话模型）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createPiStreamFn, systemMessage } from "./shared/agent";
import { loadJsonConfig, saveJsonConfig } from "./shared/config";
import { createModelSetting } from "./shared/model-setting";
import { clearStatusTimers, setStatusWithTTL } from "./shared/status";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 每次用户输入后的自检预算（一次三选一自检消耗 1；用完强制停） */
const MAX_CONTINUATIONS = 16;
/** 状态 key（hud-core STATUS_STYLE 已登记） */
const STATUS_KEY = "keep";
/** 判定块（自定义消息，带底色展示）与续跑指令（隐藏消息）的 customType */
const VERDICT_TYPE = "keep-verdict";
const GO_TYPE = "keep-go";
/** 旧版 in-transcript 追问的消息类型（新会话不再产生，保留识别以过滤历史记录） */
const ASK_TYPE = "keep-ask";

/**
 * 内建改写类工具（内建工具无注解，硬编码兑底）。
 * 其余工具走三层判定：内建集合 → readOnlyHint 注解（MCP/扩展声明）→ 无注解按只读。
 * 未知倒向只读是刻意的：误判为工作 = 问答轮弹自检（烦）；误判为只读 = keep 不介入（安全）。
 */
const BUILTIN_WORK_TOOLS = new Set(["bash", "write", "edit", "codemode"]);

/** 三选一自检问题（旁支调用的 user 消息；回答格式要求写死便于解析） */
const ASK_TEXT =
	`[停顿自检] 主任务刚停在一个停顿点。只回复 JSON：{"class":"A|B|C","reason":"一句依据","next":"仅A：具体下一步"}。`
	+ `A=工作未完成且可自主继续推进；B=需要人类决策、信息或权限才能继续；C=工作已完成或已到合理交付点。`
	+ `不要输出 JSON 以外的内容。`;

/** 开关持久化文件（全局粒度，默认开；测试用 PI_KEEP_CONFIG 指向临时文件隔离） */
const CONFIG_FILE = process.env.PI_KEEP_CONFIG ?? path.join(os.homedir(), ".pi", "agent", "keep.json");

/** 自检模型用途（默认 AUTO 跟随会话模型；可在 /model-config 改指其它模型或策略） */
const triageModel = createModelSetting({
	purpose: "keep-triage",
	plugin: "keep",
	label: "停顿自检",
	defaultStrategy: "AUTO",
});

// ---------------------------------------------------------------------------
// 消息识别与上下文过滤（customType 持久化在消息上，/reload 后规则仍生效）
// ---------------------------------------------------------------------------

type Msg = AgentMessage & { customType?: string };

function isVerdict(m: Msg | undefined): boolean {
	return m?.role === "custom" && m.customType === VERDICT_TYPE;
}

function isGo(m: Msg | undefined): boolean {
	return m?.role === "custom" && m.customType === GO_TYPE;
}

function isKeepCustom(m: Msg | undefined): boolean {
	return m?.role === "custom" && (m.customType === VERDICT_TYPE || m.customType === GO_TYPE || m.customType === ASK_TYPE);
}

/** content 块列表（AgentMessage 是联合体，部分变体无 content，统一收口取值） */
function contentBlocks(m: Msg | undefined): Array<{ type?: string; text?: string }> {
	const c = (m as { content?: unknown } | undefined)?.content;
	return Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>) : [];
}

function hasToolCalls(m: Msg | undefined): boolean {
	return contentBlocks(m).some((b) => b?.type === "toolCall");
}

function assistantText(m: Msg): string {
	return contentBlocks(m)
		.filter((b) => b?.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

/** 旧版追问的回答：紧跟 keep-ask 的无工具调用 assistant 消息（历史记录专用） */
function isOldAnswer(messages: Msg[], i: number): boolean {
	const m = messages[i];
	return m?.role === "assistant" && !hasToolCalls(m)
		&& messages[i - 1]?.role === "custom" && (messages[i - 1] as Msg).customType === ASK_TYPE;
}

/**
 * 上下文过滤：keep 的消息一律不进模型请求，唯一例外是末尾「活尾巴」里的 keep-go
 * （刚注入的续跑指令，模型还没回应，滤掉等于让模型对着空气干活）。
 * 判定块 keep-verdict 任何位置都不进请求——它只承担展示。
 */
function filterKeepMessages(messages: AgentMessage[]): AgentMessage[] {
	const ms = messages as Msg[];
	let tail = ms.length;
	while (tail > 0 && isKeepCustom(ms[tail - 1])) tail--;
	if (tail === ms.length && !ms.some((m, i) => isKeepCustom(m) || isOldAnswer(ms, i))) return messages;
	return ms.filter((m, i) => {
		if (isVerdict(m) || isOldAnswer(ms, i)) return false;
		if (isGo(m) || (m.role === "custom" && m.customType === ASK_TYPE)) return i >= tail;
		return true;
	}) as AgentMessage[];
}

// ---------------------------------------------------------------------------
// 三选一回答解析
// ---------------------------------------------------------------------------

interface Triage {
	cls: "A" | "B" | "C";
	reason: string;
	next: string;
}

/** 按平衡括号切出全部 {...} 候选（字符串内的花括号不计），逐个试解析 */
function* jsonCandidates(text: string): Generator<string> {
	let depth = 0;
	let start = -1;
	let inStr = false;
	let esc = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start >= 0) {
				yield text.slice(start, i + 1);
				start = -1;
			}
		}
	}
}

/**
 * 从回答里捞出第一个 class 合法的 JSON；裹散文/代码围栏/多段花括号都能兜住。
 * 捞不到 = 回答是面向用户的自然语言（总结≈C / 求助≈B），语义自洽的兑底就是停下，
 * 不为弱遵从模型在提示词或状态机上打补丁。
 */
function parseTriage(text: string): Triage | null {
	for (const candidate of jsonCandidates(text)) {
		try {
			const o = JSON.parse(candidate) as Record<string, unknown>;
			const cls = String(o.class ?? "").trim().toUpperCase();
			if (cls !== "A" && cls !== "B" && cls !== "C") continue;
			return { cls, reason: String(o.reason ?? "").trim(), next: String(o.next ?? "").trim() };
		} catch {
			/* 候选不是合法 JSON，试下一个 */
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// 旁支自检
// ---------------------------------------------------------------------------

/** 测试钩子：设置后跳过模型调用，直接把该文本当作自检回答（离线回归测试用，生产不设） */
const TRIAGE_STUB = process.env.PI_KEEP_TRIAGE;

interface TriageRun {
	triage: Triage | null;
	/** 未判定原因（无模型/调用失败），用于降级通知文案 */
	note: string;
}

/**
 * 复刻主会话声明的工具集：集合与顺序取 getActiveTools()，声明内容取 getAllTools()，
 * 执行体换空实现（对齐缓存前缀用，模型若误调也不产生副作用）。
 */
function requestTools(pi: ExtensionAPI): AgentTool[] {
	const infos = new Map(pi.getAllTools().map((t) => [t.name, t]));
	const stub = async (): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined; isError: true }> => ({
		content: [{ type: "text", text: "自检期间不执行工具。" }],
		details: undefined,
		isError: true,
	});
	return pi.getActiveTools()
		.map((name) => infos.get(name))
		.filter((t): t is NonNullable<typeof t> => !!t)
		.map((t) => ({
			name: t.name,
			label: t.name,
			description: t.description,
			parameters: t.parameters,
			execute: stub,
		}));
}

/** 会话消息（与主会话请求同源：SessionManager 的投影，含压缩结果） */
function sessionMessages(ctx: ExtensionContext): AgentMessage[] {
	try {
		const sm = ctx.sessionManager as unknown as { buildSessionContext?: () => { messages: AgentMessage[] } };
		return sm.buildSessionContext?.().messages ?? [];
	} catch {
		return [];
	}
}

/**
 * 跑一次旁支自检：复刻前缀 + 追加问题，限 1 轮（模型若发起工具调用也会在空实现上终止，
 * 拿不到文本即视为未判定）。观测数据（cacheRead 等）追加到 .pi/keep-cache.log。
 */
async function runTriage(ctx: ExtensionContext, pi: ExtensionAPI, systemPrompt: string): Promise<TriageRun> {
	if (TRIAGE_STUB !== undefined) return { triage: parseTriage(TRIAGE_STUB), note: "测试桩" };
	const resolved = triageModel.resolve(ctx);
	if (!resolved.model) return { triage: null, note: "无可用模型" };
	const history = filterKeepMessages(sessionMessages(ctx));
	const ask: AgentMessage = { role: "user", content: ASK_TEXT, timestamp: Date.now() };
	const started = Date.now();
	try {
		const out = await runAgentLoop(
			[ask],
			{ messages: [...(systemPrompt ? [systemMessage(systemPrompt)] : []), ...history], tools: requestTools(pi) },
			{
				model: resolved.model,
				convertToLlm,
				finishTurn: () => ({ action: "end" as const }),
			},
			() => {},
			readSignal(ctx),
			createPiStreamFn(ctx),
		);
		let text = "";
		let usage: { input?: number; cacheRead?: number } | undefined;
		for (let i = out.length - 1; i >= 0; i--) {
			const m = out[i] as Msg;
			if (m.role !== "assistant") continue;
			const u = (m as { usage?: { input?: number; cacheRead?: number } }).usage;
			if (!text) text = assistantText(m);
			if (!usage && u) usage = u;
			if (text && usage) break;
		}
		const triage = parseTriage(text);
		logTriage(ctx, {
			model: `${resolved.model.provider}/${resolved.model.id}`,
			ms: Date.now() - started,
			msgs: history.length,
			sys: systemPrompt ? systemPrompt.length : 0,
			cls: triage?.cls ?? "-",
			input: usage?.input,
			cacheRead: usage?.cacheRead,
		});
		return { triage, note: triage ? "" : "回答无法解析" };
	} catch (e) {
		logTriage(ctx, {
			model: `${resolved.model.provider}/${resolved.model.id}`,
			ms: Date.now() - started,
			msgs: history.length,
			cls: "err",
			error: e instanceof Error ? e.message : String(e),
		});
		return { triage: null, note: "自检调用失败" };
	}
}

function readSignal(ctx: ExtensionContext): AbortSignal | undefined {
	try {
		return ctx.signal;
	} catch {
		return undefined;
	}
}

/** 观测日志（.pi/ 下运行时数据，已 gitignore）：用于确认前缀缓存是否真的命中 */
function logTriage(ctx: ExtensionContext, row: Record<string, unknown>): void {
	try {
		const dir = path.join(ctx.cwd, ".pi");
		fs.mkdirSync(dir, { recursive: true });
		const line = Object.entries({ ts: new Date().toISOString(), ...row })
			.map(([k, v]) => `${k}=${v === undefined ? "-" : String(v)}`)
			.join(" ");
		fs.appendFileSync(path.join(dir, "keep-cache.log"), `${line}\n`);
	} catch {
		/* 观测失败不影响自检 */
	}
}

// ---------------------------------------------------------------------------
// 扩展本体
// ---------------------------------------------------------------------------

function loadEnabled(): boolean {
	return loadJsonConfig(CONFIG_FILE, { enabled: true }, (v): v is { enabled: boolean } =>
		typeof v === "object" && v !== null && typeof (v as { enabled?: unknown }).enabled === "boolean").enabled;
}

let enabled = loadEnabled();
let budgetLeft = MAX_CONTINUATIONS; // 本次用户输入还剩几次自检额度
let awaitingGo = false; // 已注入 keep-go，等续跑轮验证有没有实际动作
let runDidWork = false; // 本轮（自上次用户输入起）出现过改写类工具调用
let capturedPrompt = ""; // 主会话系统提示词（before_agent_start 捕获，复刻前缀用）
let hintCache: Map<string, boolean | undefined> | null = null; // 工具注解缓存（随 before_agent_start 重建）

function clearStatus(ctx: ExtensionContext): void {
	setStatusWithTTL(ctx, STATUS_KEY, undefined, 0);
}

/** 判定块（自定义消息）：内容仅供记录，展示完全由渲染器按 details 重绘 */
function verdictMessage(t: Triage, used: number) {
	return {
		type: "custom_message" as const,
		customType: VERDICT_TYPE,
		display: true,
		content: `[停顿自检] ${t.cls}｜${t.reason}${t.next ? `｜下一步：${t.next}` : ""}`,
		details: { cls: t.cls, reason: t.reason, next: t.next, used, budget: MAX_CONTINUATIONS },
	};
}

/** 续跑指令（隐藏消息）：内容给模型，展示层不出现 */
function goMessage(t: Triage) {
	return {
		type: "custom_message" as const,
		customType: GO_TYPE,
		display: false,
		content: `[继续] 判定可自主继续（${t.reason || "工作未完成"}）。下一步：${t.next || "按你的判断推进"}。`
			+ `立即执行，不要停下等待确认；若实际受阻需要人工，直接说明需要什么。`,
	};
}

export default function (pi: ExtensionAPI) {
	// 判定块的定制渲染：自定义消息才有底色（customMessageBg），配色按判定分档
	pi.registerMessageRenderer(VERDICT_TYPE, (m, { outputPad }, theme) => {
		const d = (m.details ?? {}) as { cls?: string; reason?: string; next?: string; used?: number; budget?: number };
		const cls = d.cls === "A" || d.cls === "B" || d.cls === "C" ? d.cls : "C";
		const icon = cls === "A" ? "↻" : cls === "B" ? "⚠" : "✓";
		const label = cls === "A" ? "可继续" : cls === "B" ? "需要人工" : "已完成";
		const color = cls === "A" ? "accent" : cls === "B" ? "warning" : "success";
		const counter = cls === "A" && d.used ? theme.fg("muted", ` · 续航 ${d.used}/${d.budget ?? MAX_CONTINUATIONS}`) : "";
		const reason = d.reason ? theme.fg("muted", ` —— ${d.reason}`) : "";
		const next = cls === "A" && d.next ? `\n${theme.fg("dim", `  下一步：${d.next}`)}` : "";
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg(color, `${icon} ${label}`) + counter + reason + next, 0, 0));
		return box;
	});

	pi.registerCommand("keep", {
		description: "停顿点续航开关（无参切换，默认开）",
		handler: async (args, ctx) => {
			if (args?.trim()) {
				ctx.ui.notify("用法：/keep（输一次开、再输一次关）", "warning");
				return;
			}
			enabled = !enabled;
			saveJsonConfig(CONFIG_FILE, { enabled });
			awaitingGo = false;
			if (enabled) budgetLeft = MAX_CONTINUATIONS;
			else clearStatus(ctx);
			ctx.ui.notify(
				enabled
					? `keep 已开启：停顿点自动三选一自检（预算 ${MAX_CONTINUATIONS} 次/轮）`
					: "keep 已关闭",
				"info",
			);
		},
	});

	// 每次新的用户输入：重置预算与状态机，并捕获本轮系统提示词（复刻前缀用）
	pi.on("before_agent_start", (event) => {
		budgetLeft = MAX_CONTINUATIONS;
		awaitingGo = false;
		runDidWork = false;
		hintCache = null;
		if (event?.systemPrompt) capturedPrompt = event.systemPrompt;
	});

	/** 工具 readOnlyHint 注解表（getAllTools 构建；缓存随每轮用户输入重建，兼顾 MCP 后连上的工具） */
	const readOnlyHints = (): Map<string, boolean | undefined> => {
		if (!hintCache) {
			hintCache = new Map();
			for (const t of pi.getAllTools()) hintCache.set(t.name, t.annotations?.readOnlyHint);
		}
		return hintCache;
	};

	pi.on("tool_execution_end", (event) => {
		const name = (event as { toolName?: string }).toolName ?? "";
		if (BUILTIN_WORK_TOOLS.has(name) || readOnlyHints().get(name) === false) runDidWork = true;
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx): Promise<TurnEndEventResult | void> => {
		if (!enabled || event.outcome !== "completed") return;
		const msg = event.message as Msg;
		if (hasToolCalls(msg)) {
			awaitingGo = false; // 有实际动作：续跑轮干活 = 正常
			return;
		}
		if (awaitingGo) {
			// 续跑轮仍无实际动作：判 A 失误，直接停（防空转死循环）
			awaitingGo = false;
			clearStatus(ctx);
			ctx.ui.notify("keep：续跑后仍无实际动作，保持停下（需要时手动指示）", "info");
			return;
		}
		if (!runDidWork) return; // 问答/调研型停点不自检
		if ((event.context?.pendingMessages?.length ?? 0) > 0) return; // 有排队消息，循环自会继续
		if (budgetLeft <= 0) {
			clearStatus(ctx);
			ctx.ui.notify(`keep：本轮自检预算（${MAX_CONTINUATIONS} 次）已用完，保持停下`, "info");
			return;
		}

		budgetLeft--;
		setStatusWithTTL(ctx, STATUS_KEY, "🔁 停顿自检中", 300_000);
		const { triage, note } = await runTriage(ctx, pi, capturedPrompt);
		if (!triage) {
			clearStatus(ctx);
			ctx.ui.notify(`keep：自检未判定（${note}），保持停下（需要时手动指示）`, "warning");
			return;
		}
		const used = MAX_CONTINUATIONS - budgetLeft;

		if (triage.cls !== "A") {
			// B/C 都停下：判定块挂到本轮末尾（triggerTurn:false = 不触发新轮）
			clearStatus(ctx);
			const block = verdictMessage(triage, used);
			pi.sendMessage({ customType: block.customType, content: block.content, display: true, details: block.details }, {
				triggerTurn: false,
			});
			return;
		}

		awaitingGo = true;
		setStatusWithTTL(ctx, STATUS_KEY, `🔁 续航 ${used}/${MAX_CONTINUATIONS}`, 600_000);
		return { continue: true, entries: [verdictMessage(triage, used), goMessage(triage)] };
	});

	// 模型上下文过滤：keep 的消息不进 LLM 请求（会话记录保留，判定块在界面上可见）
	pi.on("context", (event) => ({ messages: filterKeepMessages(event.messages) }));

	pi.on("session_shutdown", () => {
		clearStatusTimers();
	});
}
