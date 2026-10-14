/**
 * keep: 停顿点续航——助手自然停下时旁支自检三选一，该续就续
 *
 * 机制（旁支自检，主记录零污染）：
 * 1. turn_end 边界：本轮 assistant 消息无 toolCall、运行正常完成、无排队消息且预算未用完 → 发起旁支自检：
 *    复刻主会话请求前缀（捕获的系统提示词 + 过滤后的会话消息 + 复刻的工具集），末尾追加自检问题，
 *    跑一次 agentLoop（限 1 轮）拿 A/B/C 判定——提问与回答都不进主记录，也不进后续请求。
 * 2. A：注入判定块（展示）+ keep-go（隐藏指令）并 continue 续跑；B/C：把判定块挂到本轮末尾后停下。
 *    三态判定与档位解耦：各档共用同一套问法与 schema，档位差异全在停点处理里。
 * 3. 介入等级（/keep 选择，存 keep.json 的 level 键）：
 *    - default：只做上面的就地续航（B 一律停，守住需人工这道闸）。
 *    - idle（挂机）：完成（C）时先弹一次在场探测——有回应即视为在场、按 default 停；无回应判定脱机，
 *      注入挂机指令续跑，只做**清账类**工作（判据与用法见 idleGoMessage）：清项目里已存在的文档/注释与代码现状的不一致，
 *      改的是描述而不是行为，无法客观判定的一律跳过。同一用户输入内只探一次，此后每个停点领一件。
 * 4. 判定块 keep-verdict 是自定义消息：带底色 + 判定配色，纯展示、永不进模型请求（过滤器一律滤掉）。
 *
 * 复刻前缀的目的与边界：
 * - provider 前缀缓存按「工具集 → 系统提示词 → 消息序列」逐字节匹配，三者齐了才命中；
 *   命中与否只影响花费（未命中则全量按非缓存计价），不影响判定正确性。
 * - 前缀取 `context_with_system` 事件捕获的主会话真实请求（该事件在所有 `context` 处理后触发，
 *   `messages` 含系统消息与工具声明）——比自拼（捕获 systemPrompt + 会话消息 + 重建工具）更准，
 *   因为其它扩展对请求的改写（如时间戳前缀）也已包含在内；工具集从捕获消息的工具声明里取
 *   （`getCurrentTools`），执行体换空实现——声明用于对齐缓存前缀，空实现保证自检期间无副作用。
 * - 捕获缺席时（如扩展刚加载）回退到自拼前缀，代价是未命中缓存，不影响正确性。
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
 * 命令：/keep 无参开等级选择面板，/keep off|default|idle 直设（全局持久于 ~/.pi/agent/keep.json，默认 default）。
 * 状态 key：keep（hud-core STATUS_STYLE 已登记）。自检模型：用途 keep-triage，默认 AUTO（跟随会话模型）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { Box, Text, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai/compat";
import { createPiStreamFn, systemMessage } from "./shared/agent";
import { loadJsonConfig, saveJsonConfig } from "./shared/config";
import { createModelSetting } from "./shared/model-setting";
import { clearStatusTimers, setStatusWithTTL, setWaiting } from "./shared/status";
import { createBoxRenderer, keyHintRow } from "./shared/ui";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 每次用户输入后的自检预算（一次三选一自检消耗 1；用完强制停） */
const MAX_CONTINUATIONS = 16;
/** 挂机（idle）专属预算：清账类是一件一件的细活，四件足以看出效果，也避免挂机段把转录撑长 */
const IDLE_MAX = 4;
/** 挂机产物落点（相对于项目根）：每件活追加一段，对话里只留一行指针 */
const IDLE_LOG = ".pi/keep-idle/<日期>.md";
/**
 * 挂机在场探测的超时：无回应即判定脱机（毫秒）。
 * 给到 3 分钟是「读完一轮回复再决定离开」的余量；探测期间 AI 是停住的，
 * 所以这个值直接等于一次探测的等待成本，不宜再长。
 */
const PROBE_MS = 3 * 60_000;
/** 探测时长的展示文案（整分钟用分钟） */
const PROBE_LABEL = PROBE_MS % 60_000 === 0 ? `${PROBE_MS / 60_000} 分钟` : `${PROBE_MS / 1000} 秒`;
/** 挂机工作清单（示例项）：判据与用法见 idleGoMessage */
const IDLE_WORK = [
	"文档时效性：AGENTS.md / README / skill references 里写的命令、目录、文件名、工具名、命令名、状态 key、测试文件数等，与仓库现状逐条对照，过期就按现状更正（只动描述）",
	"死指针与索引：文内引用的脚本、测试文件、路径是否都还在；skill references 的索引与实际文件是否互相覆盖；断链就修",
	"跨文件一致性：同一事实在几处写法是否冲突（术语、阈值、文件路径、状态 key 名），以代码现状为准统一",
	"注释时效性：是否残留变更史叙述（「改为」「之前是」「本次新增」类），按约定删成现状描述",
];
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

/**
 * 介入等级：off 不介入 / default 停顿点就地续航 / idle 在 default 之上加「脱机挂机」。
 * 等级只影响停点处理，不影响自检问法与三态判定（各档同一套 schema）。
 */
type Level = "off" | "default" | "idle";
const LEVELS: Level[] = ["off", "default", "idle"];
const LEVEL_LABEL: Record<Level, string> = { off: "关闭", default: "默认", idle: "空档" };
const LEVEL_DESC: Record<Level, string> = {
	off: "不介入停顿点",
	default: "停顿点就地续航：可自主继续就继续，需人工就停",
	idle: "在默认之上：完成后探一次在场，脱机就做安全的挂机工作",
};

function isLevel(v: unknown): v is Level {
	return v === "off" || v === "default" || v === "idle";
}

/**
 * 三选一自检问题（旁支调用的 user 消息；回答格式写死便于解析）。
 * 各档共用同一套：档位差异在停点处理里，提问不随档位变（切档也不会改动这段前缀）。
 */
const ASK_TEXT = `[harness 自检] pi 的例行停顿判定，你是被提问方，直接给出 JSON 结论即可：`
	+ `{"class":"A|B|C","reason":"一句依据","next":"仅A：具体下一步"}。`
	+ `A=工作未完成且可自主继续推进；B=需要人类决策、信息或权限；C=工作已完成或已到合理交付点。`;

/** 等级持久化文件（全局粒度，默认 default；测试用 PI_KEEP_CONFIG 指向临时文件隔离） */
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

/** 回答正文 / 思维链 / 块类型（思维链仅作诊断与兜底：部分推理模型把内容全写进 thinking） */
function assistantParts(m: Msg): { text: string; thinking: string; types: string } {
	const blocks = contentBlocks(m) as Array<{ type?: string; text?: string; thinking?: string }>;
	return {
		text: blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n").trim(),
		thinking: blocks.filter((b) => b?.type === "thinking").map((b) => b.thinking ?? "").join("\n").trim(),
		types: blocks.map((b) => b?.type ?? "?").join("+"),
	};
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

/** 空实现：自检期间模型即使误调工具也不产生副作用 */
const stubExecute = async (): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined; isError: true }> => ({
	content: [{ type: "text", text: "自检期间不执行工具。" }],
	details: undefined,
	isError: true,
});

/**
 * 复刻主会话声明的工具集（回退路径）：集合与顺序取 getActiveTools()，声明内容取 getAllTools()，
 * 执行体换空实现（对齐缓存前缀用，模型若误调也不产生副作用）。
 */
function requestTools(pi: ExtensionAPI): AgentTool[] {
	const infos = new Map(pi.getAllTools().map((t) => [t.name, t]));
	return pi.getActiveTools()
		.map((name) => infos.get(name))
		.filter((t): t is NonNullable<typeof t> => !!t)
		.map((t) => ({
			name: t.name,
			label: t.name,
			description: t.description,
			parameters: t.parameters,
			execute: stubExecute,
		}));
}

/** 从捕获的请求里取当前工具声明（与 provider 收到的工具参数一致），执行体换空实现 */
function declaredTools(messages: AgentMessage[]): AgentTool[] | null {
	try {
		const declared = getCurrentTools(messages as never) as Array<{ name: string; description?: string; parameters?: unknown }>;
		if (declared.length === 0) return null;
		return declared.map((t) => ({
			name: t.name,
			label: t.name,
			description: t.description ?? "",
			parameters: t.parameters as never,
			execute: stubExecute,
		}));
	} catch {
		return null;
	}
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
 * 跑一次旁支自检：复刻前缀（优先用捕获的主会话真实请求）+ 追加停点消息与自检问题，
 * 限 1 轮（模型若发起工具调用也会在空实现上终止，拿不到文本即视为未判定）。
 * 观测数据（cacheRead、回答片段等）追加到 .pi/keep-cache.log。
 */
async function runTriage(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	systemPrompt: string,
	stopMessage: AgentMessage | undefined,
): Promise<TriageRun> {
	if (TRIAGE_STUB !== undefined) return { triage: parseTriage(TRIAGE_STUB), note: "测试桩" };
	const resolved = triageModel.resolve(ctx);
	if (!resolved.model) return { triage: null, note: "无可用模型" };
	const base = requestMessages;
	const history = base ?? [
		...(systemPrompt ? [systemMessage(systemPrompt)] : []),
		...filterKeepMessages(sessionMessages(ctx)),
	];
	const ask: AgentMessage = { role: "user", content: ASK_TEXT, timestamp: Date.now() };
	const messages = [...history, ...(stopMessage ? [stopMessage] : []), ask];
	const tools = (base ? declaredTools(base) : null) ?? requestTools(pi);
	const started = Date.now();
	try {
		const out = await runAgentLoop(
			[],
			{ messages, tools },
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
		let thinking = "";
		let types = "";
		let stopReason = "";
		let usage: { input?: number; cacheRead?: number } | undefined;
		for (let i = out.length - 1; i >= 0; i--) {
			const m = out[i] as Msg;
			if (m.role !== "assistant") continue;
			const u = (m as { usage?: { input?: number; cacheRead?: number } }).usage;
			if (!types) {
				const parts = assistantParts(m);
				text = parts.text;
				thinking = parts.thinking;
				types = parts.types;
				stopReason = (m as { stopReason?: string }).stopReason ?? "";
			}
			if (!usage && u) usage = u;
			if (types && usage) break;
		}
		// 正文为空时回退用思维链解析：部分推理模型（实测 deepseek-v4.1-flash）把内容全写在 thinking 里
		const triage = parseTriage(text || thinking);
		logTriage(ctx, {
			model: `${resolved.model.provider}/${resolved.model.id}`,
			ms: Date.now() - started,
			src: base ? "stash" : "fallback",
			msgs: messages.length,
			tools: tools.length,
			active: pi.getActiveTools().length,
			gap: requestCapturedAt ? Math.round((started - requestCapturedAt) / 1000) : -1,
			blocks: types || "-",
			stop: stopReason || "-",
			cls: triage?.cls ?? "-",
			input: usage?.input,
			cacheRead: usage?.cacheRead,
			ans: (text || thinking).slice(0, 120).replace(/\s+/g, " "),
		});
		return { triage, note: triage ? "" : text ? "回答无法解析" : thinking ? "回答仅在思维链里" : "回答为空" };
	} catch (e) {
		logTriage(ctx, {
			model: `${resolved.model.provider}/${resolved.model.id}`,
			ms: Date.now() - started,
			src: base ? "stash" : "fallback",
			msgs: messages.length,
			active: pi.getActiveTools().length,
			gap: requestCapturedAt ? Math.round((started - requestCapturedAt) / 1000) : -1,
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
// 挂机在场探测
// ---------------------------------------------------------------------------

type ProbeResult = "stop" | "idle";

/**
 * 在场探测面板：任意键回应 = 在场（返回 stop，按 default 停）；c = 立即挂机（离开前主动放行）；
 * 倒计时归零无回应 = 脱机（返回 idle，转挂机工作）。
 */
class ProbePanel {
	focused = false;

	private left: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private decided = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (r: ProbeResult) => void,
		ms: number,
	) {
		this.left = Math.ceil(ms / 1000);
		this.timer = setInterval(() => {
			this.left--;
			this.tui.requestRender();
			if (this.left <= 0) this.finish("idle");
		}, 1000);
	}

	/** 组件接口要求；本面板无缓存，重绘即最新 */
	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
	}

	handleInput(data: string): void {
		this.finish(data.toLowerCase() === "c" ? "idle" : "stop");
	}

	render(width: number): string[] {
		const th = this.theme;
		const { row, topBorder, bottomBorder } = createBoxRenderer(th, Math.max(10, width - 2));
		return [
			topBorder(` ${th.fg("dim", "停顿点")} `),
			row(`${th.fg("success", "✓ 已完成")}   ${th.fg("muted", `${this.left} 秒后自动开始挂机工作`)}`),
			row(keyHintRow(th, "任意键 保持停下 · c 立即开始挂机")),
			bottomBorder(),
		];
	}

	private finish(r: ProbeResult): void {
		if (this.decided) return;
		this.decided = true;
		if (this.timer) clearInterval(this.timer);
		this.done(r);
	}
}

/**
 * 弹一次在场探测。只有 TUI 能弹自绘面板，其余模式（print/json/rpc）按在场处理（返回 stop），
 * 避免“探测不到人”就成了擅自进入挂机的理由。
 */
async function probePresence(ctx: ExtensionContext): Promise<ProbeResult> {
	if (ctx.mode !== "tui") return "stop";
	setWaiting(`停顿点：${PROBE_LABEL}内无回应就转挂机工作`);
	try {
		return await ctx.ui.custom<ProbeResult>((tui, theme, _kb, done) => new ProbePanel(tui, theme, done, PROBE_MS), {
			overlay: true,
			overlayOptions: { width: "62%", minWidth: 48 },
		});
	} finally {
		setWaiting(null);
	}
}

// ---------------------------------------------------------------------------
// 扩展本体
// ---------------------------------------------------------------------------

function loadLevel(): Level {
	const cfg = loadJsonConfig<{ level?: unknown }>(CONFIG_FILE, {}, (v): v is { level?: unknown } =>
		typeof v === "object" && v !== null);
	return isLevel(cfg.level) ? cfg.level : "default";
}

function saveLevel(l: Level): void {
	saveJsonConfig(CONFIG_FILE, { level: l });
}

let level = loadLevel();
let budgetLeft = MAX_CONTINUATIONS; // 本次用户输入还剩几次自检额度
let idleUsed = 0; // 本次用户输入已经领了几件挂机工作（上限 IDLE_MAX）
let away = false; // 本次用户输入内是否已判定用户脱机（进入挂机阶段）
let awaitingGo = false; // 已注入 keep-go，等续跑轮验证有没有实际动作
let runDidWork = false; // 本轮（自上次用户输入起）出现过改写类工具调用
let capturedPrompt = ""; // 主会话系统提示词（before_agent_start 捕获，回退路径拼前缀用）
let requestMessages: AgentMessage[] | null = null; // 主会话真实请求（context_with_system 捕获：含系统消息与工具声明）
let requestCapturedAt = 0; // 捕获时刻（诊断缓存冷热：与自检发起的间隔）
let hintCache: Map<string, boolean | undefined> | null = null; // 工具注解缓存（随 before_agent_start 重建）

function clearStatus(ctx: ExtensionContext): void {
	setStatusWithTTL(ctx, STATUS_KEY, undefined, 0);
}

/** 判定块（自定义消息）：内容仅供记录，展示完全由渲染器按 details 重绘 */
function verdictMessage(t: Triage, used: number, idle: boolean) {
	const tail = t.cls === "A" && t.next ? `｜下一步：${t.next}` : "";
	return {
		type: "custom_message" as const,
		customType: VERDICT_TYPE,
		display: true,
		content: `[harness 自检] ${t.cls}｜${t.reason}${tail}`,
		details: { cls: t.cls, reason: t.reason, next: t.next, used, budget: idle ? IDLE_MAX : MAX_CONTINUATIONS, idle },
	};
}

/** 续跑指令（隐藏消息）：内容给模型，展示层不出现 */
function goMessage(t: Triage) {
	const content = `[harness 续跑] 判定可自主继续（${t.reason || "工作未完成"}）。下一步：${t.next || "按你的判断推进"}。`
		+ `做法：直接执行到底；确实受阻需要人工时，说明需要什么即可。`;
	return { type: "custom_message" as const, customType: GO_TYPE, display: false, content };
}

/** 挂机指令（判定脱机后注入）：只领过了唯一判据的活，没有就停 */
function idleGoMessage(t: Triage) {
	const work = IDLE_WORK.map((w, i) => `${i + 1}) ${w}`).join("；");
	const content = `[harness 挂机] 用户不在场（判定：${t.reason || "已到交付点"}）。这段时间做的是「清账」：把项目里**已经存在的不一致**清掉。`
		+ `唯一判据（动手前问两问，任一为「是」就不做）：一、这件事需要用户拍板吗？二、做完会给用户留下需要人工处理的后继任务吗`
		+ `（待审阅的新东西、要回答的清单、要确认的改动…）？两问都否，才是挂机的活。`
		+ `常见的合规项（示例；列外的事用同一判据自查）：${work}。`
		+ `反面清单（明确不合规）：新增文档/方案/测试/清单、把发现的问题列出来、记录待拍板项。`
		+ `其余约束：① 只改描述与索引，不改代码语义与对外约定；② 一件活尽量一次做完（合并读取与修改，能用一条命令跑完就不要分步）；`
		+ `③ 做完把改了什么追加到 ${IDLE_LOG}，回复里只留一行指针，然后停下等下一件；`
		+ `④ 没有合规的活就直接说明「没有可清的账」停下，不要为找活而发散、也不要自己发明新工作；`
		+ `⑤ 不执行需要人工确认的命令、也不发起需要回应的提问。`;
	return { type: "custom_message" as const, customType: GO_TYPE, display: false, content };
}

export default function (pi: ExtensionAPI) {
	// 判定块的定制渲染：自定义消息才有底色（customMessageBg），配色按判定分档
	pi.registerMessageRenderer(VERDICT_TYPE, (m, { outputPad }, theme) => {
		type Details = { cls?: string; reason?: string; next?: string; used?: number; budget?: number; idle?: boolean };
		const d = (m.details ?? {}) as Details;
		const cls = d.cls === "A" || d.cls === "B" || d.cls === "C" ? d.cls : "C";
		const idle = cls === "C" && d.idle === true; // 已完成，转去挂机工作
		const icon = cls === "A" ? "↻" : cls === "B" ? "⚠" : "✓";
		const label = cls === "A" ? "可继续" : cls === "B" ? "需要人工" : "已完成";
		const color = cls === "A" ? "accent" : cls === "B" ? "warning" : "success";
		const counter = (cls === "A" || idle) && d.used
			? theme.fg("muted", ` · ${idle ? "挂机" : "续航"} ${d.used}/${d.budget ?? MAX_CONTINUATIONS}`)
			: "";
		const reason = d.reason ? theme.fg("muted", ` —— ${d.reason}`) : "";
		const next = cls === "A" && d.next ? `\n${theme.fg("dim", `  下一步：${d.next}`)}` : "";
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg(color, `${icon} ${label}`) + counter + reason + next, 0, 0));
		return box;
	});

	// 捕获主会话真实请求（在所有 context 处理后触发）：旁支自检的前缀直接取它，逐字节一致
	pi.on("context_with_system", (event) => {
		requestMessages = [...event.messages];
		requestCapturedAt = Date.now();
	});

	/** 切等级：写盘 + 复位续跑状态（非 off 时重置续航预算） */
	const applyLevel = (next: Level, ctx: ExtensionContext): void => {
		level = next;
		saveLevel(next);
		awaitingGo = false;
		away = false;
		if (next === "off") clearStatus(ctx);
		else budgetLeft = MAX_CONTINUATIONS;
		idleUsed = 0;
		ctx.ui.notify(`keep：${LEVEL_LABEL[next]}（${LEVEL_DESC[next]}）`, "info");
	};

	pi.registerCommand("keep", {
		description: "keep 介入等级（无参选择：关闭/默认/空档）",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg) {
				if (!isLevel(arg)) {
					ctx.ui.notify(
						`keep：未知等级「${arg}」。用法：/keep 打开选择，或 /keep off|default|idle（当前：${LEVEL_LABEL[level]}）`,
						"warning",
					);
					return;
				}
				applyLevel(arg, ctx);
				return;
			}
			const items = LEVELS.map((l) => `${l === level ? "✓ " : "  "}${LEVEL_LABEL[l]}（${LEVEL_DESC[l]}）`);
			const pick = await ctx.ui.select("keep 介入等级", items);
			const chosen = pick ? LEVELS[items.indexOf(pick)] : undefined;
			if (chosen) applyLevel(chosen, ctx);
		},
	});

	// 每次新的用户输入：重置预算与状态机，并捕获本轮系统提示词（复刻前缀用）
	pi.on("before_agent_start", (event) => {
		budgetLeft = MAX_CONTINUATIONS;
		awaitingGo = false;
		away = false;
		idleUsed = 0;
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

	/** 停：判定块挂到本轮末尾（triggerTurn:false = 不触发新轮），并清掉状态行 */
	const stopHere = (ctx: ExtensionContext, triage: Triage, used: number, idle: boolean): void => {
		clearStatus(ctx);
		const block = verdictMessage(triage, used, idle);
		pi.sendMessage({ customType: block.customType, content: block.content, display: true, details: block.details }, {
			triggerTurn: false,
		});
	};

	pi.on("turn_end", async (event: TurnEndEvent, ctx): Promise<TurnEndEventResult | void> => {
		if (level === "off" || event.outcome !== "completed") return;
		const msg = event.message as Msg;
		if (hasToolCalls(msg)) {
			awaitingGo = false; // 有实际动作：续跑轮干活 = 正常
			return;
		}
		if (awaitingGo) {
			// 续跑轮仍无实际动作：判 A 失误（或挂机时没有合适的活），直接停
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
		const { triage, note } = await runTriage(ctx, pi, capturedPrompt, msg);
		if (!triage) {
			clearStatus(ctx);
			ctx.ui.notify(`keep：自检未判定（${note}），保持停下（需要时手动指示）`, "warning");
			return;
		}
		const used = MAX_CONTINUATIONS - budgetLeft;

		// B 一律停（各档一致）：需要人工决策/权限时不去动别的活，守住这道闸
		if (triage.cls === "B") {
			stopHere(ctx, triage, used, false);
			return;
		}
		// A 就地续航
		if (triage.cls === "A") {
			awaitingGo = true;
			setStatusWithTTL(ctx, STATUS_KEY, `🔁 续航 ${used}/${MAX_CONTINUATIONS}`, 600_000);
			return { continue: true, entries: [verdictMessage(triage, used, false), goMessage(triage)] };
		}
		// C 已完成：default 直接停；idle 先探一次在场（同一用户输入内只探一次），脱机才转挂机
		if (level !== "idle") {
			stopHere(ctx, triage, used, false);
			return;
		}
		if (!away) {
			setStatusWithTTL(ctx, STATUS_KEY, "⏳ 探测在场中", PROBE_MS + 60_000);
			if ((await probePresence(ctx)) === "stop") {
				stopHere(ctx, triage, used, false);
				return;
			}
			away = true;
		}
		if (idleUsed >= IDLE_MAX) {
			stopHere(ctx, triage, IDLE_MAX, true);
			ctx.ui.notify(`keep：挂机已做满 ${IDLE_MAX} 件，保持停下（需要时手动叫起来）`, "info");
			return;
		}
		idleUsed++;
		awaitingGo = true;
		setStatusWithTTL(ctx, STATUS_KEY, `⏳ 挂机 ${idleUsed}/${IDLE_MAX}`, 600_000);
		return { continue: true, entries: [verdictMessage(triage, idleUsed, true), idleGoMessage(triage)] };
	});

	// 模型上下文过滤：keep 的消息不进 LLM 请求（会话记录保留，判定块在界面上可见）
	pi.on("context", (event) => ({ messages: filterKeepMessages(event.messages) }));

	pi.on("session_shutdown", () => {
		clearStatusTimers();
	});
}
