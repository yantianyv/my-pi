/**
 * keep: 停顿点续航——助手自然停下（本轮无工具调用）时，原地追问三选一，该续就续
 *
 * 机制（in-transcript 追问 + 上下文过滤）：
 * 1. turn_end 边界：本轮 assistant 消息无 toolCall、运行正常完成、无排队消息且预算未用完
 *    → 注入 custom_message（keep-ask，三选一自检问题）并 continue 一轮；
 * 2. 自检轮模型只回复 JSON（A 可自主继续 / B 需人工 / C 已完成），turn_end 解析：
 *    A → 再注入 custom_message（keep-go，下一步指示）continue；B/C → 停下（判定行即展示）；
 * 3. 问答留在会话记录里（用户可见、可审计），但 context 事件把它们从 LLM 请求里滤掉——
 *    模型后续看不到，既不污染上下文，两轮又都是主会话正常 turn、前缀缓存全命中。
 *
 * 设计约束：
 * - 不用侧路分类调用：provider 前缀缓存从第 0 个 token 起匹配，侧路调用系统提示词不同，
 *   对主会话缓存必然 0 命中（本会话 usage 实测：主会话每轮增量仅几百 tokens、其余全
 *   cacheRead）；in-transcript 是让分类也吃到缓存的唯一路线。
 * - 续跑必须注入消息：pi 的边界校验在 entries 落账后重算，注入 custom_message 后 transcript
 *   末尾为 user 角色才合法；自然停点（assistant 结尾）不带注入的 continue 会被拒。
 * - 过滤必须保留末尾「活尾巴」：正在等待回答的 keep-ask / 刚注入的 keep-go 是当前轮请求
 *   的输入，滤掉等于让模型对着空气回答。
 *
 * 触发门槛：仅「工作型停点」——本轮（自上次用户输入起）出现过改写类工具调用。
 * 判定三层：内建集合（bash/write/edit/codemode，内建工具无注解）→ readOnlyHint 注解
 * （MCP/扩展声明）→ 无注解按只读。零工具与只读工具的收尾是问答/调研的天然终点，
 * 不自检；判断消息意图不如判断动作后果可靠，漏判代价只是退回没有 keep 的原生行为。
 *
 * 防失控双保险：
 * 1. 续跑轮（keep-go 后）仍无 toolCall → 直接停，不再追问；
 * 2. 每次用户输入重置的续航预算 MAX_CONTINUATIONS（一次自检消耗 1），用完强制停。
 *
 * 命令：/keep 无参切换开关（全局持久于 ~/.pi/agent/keep.json，默认开）。状态 key：keep（hud-core STATUS_STYLE 已登记）。
 *
 * 展示：keep-ask 与 keep-go 都不占聊天流（display:false，靠 HUD 行提示）；自检回答经 message_end
 * 换成「图标 + 加粗判定 + 理由」，A 再把续航计数与下一步并进同一行。展示层不影响模型收到的内容。
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadJsonConfig, saveJsonConfig } from "./shared/config";
import { clearStatusTimers, setStatusWithTTL } from "./shared/status";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 每次用户输入后的自检预算（一次三选一自检消耗 1；用完强制停） */
const MAX_CONTINUATIONS = 16;
/** 状态 key（hud-core STATUS_STYLE 已登记） */
const STATUS_KEY = "keep";

/**
 * 内建改写类工具（内建工具无注解，硬编码兑底）。
 * 其余工具走三层判定：内建集合 → readOnlyHint 注解（MCP/扩展声明）→ 无注解按只读。
 * 未知倒向只读是刻意的：误判为工作 = 问答轮弹自检（烦）；误判为只读 = keep 不介入（安全）。
 */
const BUILTIN_WORK_TOOLS = new Set(["bash", "write", "edit", "codemode"]);

/** 三选一自检问题（注入后落地为 user 角色；回答格式要求写死便于解析） */
const ASK_TEXT =
	`[停顿自检] 只回复 JSON：{"class":"A|B|C","reason":"一句依据","next":"仅A：具体下一步"}。`
	+ `A=工作未完成且可自主继续推进；B=需要人类决策、信息或权限才能继续；C=工作已完成或已到合理交付点。`
	+ `不要输出 JSON 以外的内容。`;

// ---------------------------------------------------------------------------
// 消息识别（过滤与状态机共用；customType 持久化在消息上，/reload 后规则仍生效）
// ---------------------------------------------------------------------------

type Msg = AgentMessage & { customType?: string };

function isKeepAsk(m: Msg | undefined): boolean {
	return m?.role === "custom" && m.customType === "keep-ask";
}

function isKeepCustom(m: Msg | undefined): boolean {
	return m?.role === "custom" && (m.customType === "keep-ask" || m.customType === "keep-go");
}

/** content 块列表（AgentMessage 是联合体，部分变体无 content，统一收口取值） */
function contentBlocks(m: Msg | undefined): Array<{ type?: string; text?: string }> {
	const c = (m as { content?: unknown } | undefined)?.content;
	return Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>) : [];
}

function hasToolCalls(m: Msg | undefined): boolean {
	return contentBlocks(m).some((b) => b?.type === "toolCall");
}

/** 三选一回答：紧跟 keep-ask 的无工具调用 assistant 消息（带工具调用的是回去干活，必须保留配对） */
function isTriageAnswer(messages: Msg[], i: number): boolean {
	const m = messages[i];
	return m?.role === "assistant" && !hasToolCalls(m) && isKeepAsk(messages[i - 1]);
}

function isKeepRelated(messages: Msg[], i: number): boolean {
	return isKeepCustom(messages[i]) || isTriageAnswer(messages, i);
}

/** 滤掉已完成的 keep 问答；末尾连续 keep 消息是「活尾巴」（进行中的问答/刚注入的指令），必须保留 */
function filterKeepMessages(messages: AgentMessage[]): AgentMessage[] {
	const ms = messages as Msg[];
	let tail = ms.length;
	while (tail > 0 && isKeepRelated(ms, tail - 1)) tail--;
	if (tail === ms.length && !ms.some((_, i) => isKeepRelated(ms, i))) return messages;
	return ms.filter((_, i) => i >= tail || !isKeepRelated(ms, i)) as AgentMessage[];
}

// ---------------------------------------------------------------------------
// 三选一回答解析
// ---------------------------------------------------------------------------

interface Triage {
	cls: "A" | "B" | "C";
	reason: string;
	next: string;
}

function assistantText(m: Msg): string {
	return contentBlocks(m)
		.filter((b) => b?.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
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
// 扩展本体
// ---------------------------------------------------------------------------

/** 开关持久化文件（全局粒度，默认开；测试用 PI_KEEP_CONFIG 指向临时文件隔离） */
const CONFIG_FILE = process.env.PI_KEEP_CONFIG ?? path.join(os.homedir(), ".pi", "agent", "keep.json");

function loadEnabled(): boolean {
	return loadJsonConfig(CONFIG_FILE, { enabled: true }, (v): v is { enabled: boolean } =>
		typeof v === "object" && v !== null && typeof (v as { enabled?: unknown }).enabled === "boolean").enabled;
}

let enabled = loadEnabled();
let budgetLeft = MAX_CONTINUATIONS; // 本次用户输入还剩几次自检额度
let awaitingTriage = false; // 已注入 keep-ask，等自检轮收尾
let pendingTriage: Triage | null | undefined; // message_end 预解析的自检结果（替换显示后原文已毁，turn_end 必须复用）
let awaitingGo = false; // 已注入 keep-go，等续跑轮验证有没有实际动作
let runDidWork = false; // 本轮（自上次用户输入起）出现过改写类工具调用
let hintCache: Map<string, boolean | undefined> | null = null; // 工具注解缓存（随 before_agent_start 重建）

function clearStatus(ctx: ExtensionContext): void {
	setStatusWithTTL(ctx, STATUS_KEY, undefined, 0);
}

function keepMessage(customType: string, content: string, details?: Record<string, unknown>, display = true) {
	return { type: "custom_message" as const, customType, display, content, ...(details ? { details } : {}) };
}

/** 自检回答的展示版（message_end 替换生 JSON；固定前缀不入展示，A 的续航计数与下一步并进来） */
function triageDisplay(t: Triage, used: number): string {
	const icon = t.cls === "A" ? "↻" : t.cls === "B" ? "⚠" : "✓";
	const label = t.cls === "A" ? "可继续" : t.cls === "B" ? "需要人工" : "已完成";
	const counter = t.cls === "A" ? ` · 续航 ${used}/${MAX_CONTINUATIONS}` : "";
	const reason = t.reason ? ` —— ${t.reason}` : "";
	const next = t.cls === "A" && t.next ? `\n· 下一步：${t.next}` : "";
	return `${icon} **${label}**${counter}${reason}${next}`;
}

export default function (pi: ExtensionAPI) {
	// 自检回答（生 JSON）替换成一行人话；仅换显示，角色不变、context 过滤规则不受影响
	pi.on("message_end", (event) => {
		if (!awaitingTriage) return;
		const msg = event.message as Msg;
		if (msg.role !== "assistant" || hasToolCalls(msg)) return;
		const t = parseTriage(assistantText(msg));
		pendingTriage = t; // 替换会破坏原文，把解析结果带给紧随其后的 turn_end
		if (!t) return; // 无法解析的回答是面向用户的自然语言，原样保留
		const replaced = { ...msg, content: [{ type: "text", text: triageDisplay(t, MAX_CONTINUATIONS - budgetLeft) }] } as AgentMessage;
		return { message: replaced };
	});

	pi.registerCommand("keep", {
		description: "停顿点续航开关（无参切换，默认关）",
		handler: async (args, ctx) => {
			if (args?.trim()) {
				ctx.ui.notify("用法：/keep（输一次开、再输一次关）", "warning");
				return;
			}
			enabled = !enabled;
			saveJsonConfig(CONFIG_FILE, { enabled });
			awaitingTriage = false;
			pendingTriage = undefined;
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

	// 每次新的用户输入：重置预算与状态机
	pi.on("before_agent_start", () => {
		budgetLeft = MAX_CONTINUATIONS;
		awaitingTriage = false;
		pendingTriage = undefined;
		awaitingGo = false;
		runDidWork = false;
		hintCache = null;
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

	pi.on("turn_end", (event: TurnEndEvent, ctx): TurnEndEventResult | void => {
		if (!enabled || event.outcome !== "completed") return;
		if (!runDidWork && !awaitingTriage && !awaitingGo) return; // 问答/调研型停点不自检
		const msg = event.message as Msg;
		if (hasToolCalls(msg)) {
			// 有实际动作：自检轮带工具调用 = 模型直接回去干活（视同 A）；续跑轮干活 = 正常
			awaitingTriage = false;
			awaitingGo = false;
			return;
		}

		// 以下都是「无 toolCall」的收尾轮
		if (awaitingTriage) {
			awaitingTriage = false;
			// message_end 已把消息替换为展示行，原文 JSON 不存在了，用预解析结果；
			// 未经过 message_end（如历史消息收尾）才回退到原文解析
			const t = pendingTriage !== undefined ? pendingTriage : parseTriage(assistantText(msg));
			pendingTriage = undefined;
			if (!t) {
				clearStatus(ctx);
				ctx.ui.notify("keep：自检回答无法解析，保持停下（需要时手动指示）", "warning");
				return;
			}
			if (t.cls === "A") {
				awaitingGo = true;
				const used = MAX_CONTINUATIONS - budgetLeft;
				setStatusWithTTL(ctx, STATUS_KEY, `🔁 续航 ${used}/${MAX_CONTINUATIONS}`, 600_000);
				return {
					continue: true,
					entries: [
						keepMessage(
							"keep-go",
							`[继续] 判定可自主继续（${t.reason || "工作未完成"}）。下一步：${t.next || "按你的判断推进"}。`
							+ `立即执行，不要停下等待确认；若实际受阻需要人工，直接说明需要什么。`,
							undefined,
							false,
						),
					],
				};
			}
			clearStatus(ctx);
			return; // B/C 都保持停下：展示已由 message_end 替换的人话行承担（C 的完成提醒由 status-beacon 负责）
		}

		if (awaitingGo) {
			// 续跑轮仍无实际动作：判 A 失误，直接停（防空转死循环）
			awaitingGo = false;
			clearStatus(ctx);
			ctx.ui.notify("keep：续跑后仍无实际动作，保持停下（需要时手动指示）", "info");
			return;
		}

		// 自然停顿点 → 发起三选一自检（续跑必带注入：keep-ask 落账后 transcript 末尾为 user 角色，边界校验才合法）
		if ((event.context?.pendingMessages?.length ?? 0) > 0) return; // 有排队消息，循环自会继续
		if (budgetLeft <= 0) {
			clearStatus(ctx);
			ctx.ui.notify(`keep：本轮自检预算（${MAX_CONTINUATIONS} 次）已用完，保持停下`, "info");
			return;
		}
		budgetLeft--;
		awaitingTriage = true;
		setStatusWithTTL(ctx, STATUS_KEY, "🔁 停顿自检中", 300_000);
		return { continue: true, entries: [keepMessage("keep-ask", ASK_TEXT, undefined, false)] };
	});

	// 模型上下文过滤：已完成的 keep 问答不进 LLM 请求（会话记录保留，用户可见可审计）
	pi.on("context", (event) => ({ messages: filterKeepMessages(event.messages) }));

	pi.on("session_shutdown", () => {
		clearStatusTimers();
	});
}
