/**
 * secure：执行授权 · 提权执行 · 凭据中转
 *
 * 三部分共用同一条执行管线（"需要凭据才能做的事"都在这里）：
 *   1. 审核层——bash 命令的名单与 AI 审核；
 *   2. 提权层——sudo_exec（用户输密授权，密码只经 stdin）；
 *   3. 凭据层——secret_run（{{sec:名字}} 执行时展开，值经环境变量不进 argv）。
 *
 * 合并为一个插件的实际收益：secret_run 的命令也走审核层（之前是独立通道、绕过全部拦截），
 * 审核面板能列出这条命令会用到哪些凭据，sudo_exec 里的 {{sec:名字}} 也能展开——
 * 这些都需要库与审核链同处一个进程。
 *
 * 三层名单（tool_call 事件拦截）：
 *   - 硬拒绝 deny：「绝不允许」的正则，命中即拒绝且不询问（如 rm -rf /、curl|sh、mkfs）；
 *   - 关注项 watch：命中只提高审核严格度（AI 被要求更谨慎），**不直接打断用户**；
 *   - 已记住 remembered：意图缓存，命中即放行（之前的「白名单」，现在带人类可读的意图标签）。
 *
 * 判定顺序：拆段（shared/shell-split：&&/||/;/|/换行/子 shell 递归）→ 硬拒绝（整串或任一段）
 *   → 已记住（每个子命令段都要命中）→ AI 审核（命中关注项时把命令标记为「关注」让 AI 从严）。
 *   AI 结论：allow（自动记住意图，下次同类直接放行）/ review（弹面板问人）/ reject（拒绝）。
 *   AI 不可用（超时/无模型/网络错误/输出无法解析）→ 降级为人工确认，文案说明是降级而非任务失败。
 *
 * 人工确认面板（ReviewPanel，自绘 overlay）：默认高亮「允许一次」，三个选项——
 *   允许一次 / 允许并永久记住这类操作（旁边写出将被记住的操作意图）/ 拒绝；
 *   面板展示：AI 一句话解读、影响面（写/删/联网/凭证等）、命中原因、命令全文（折行不截断，PgUp/PgDn 滚）。
 *   键位：↑↓ 选择 · Enter 确认 · 1-3 直选 · PgUp/PgDn 滚动 · Esc = 拒绝（不执行）。
 *   并行工具批里多个待确认命令经 Promise 链串行弹面板，避免对话框打架。
 *
 * sudo 专用授权通道（密码即授权，仅当次有效）：
 *   AI 在 bash 里直接写 sudo → 拦截打回，引导改用 sudo_exec 工具；sudo_exec 弹整屏授权面板
 *   （完整命令折行可滚动 + 掩码密码框，错误原地重试共 3 次，Esc=拒绝），扩展内 spawn sudo -kS 喂密
 *   执行——-k 使 sudo 忽略且不更新凭据缓存，每次调用必重新弹窗授权；密码只经扩展内存进 sudo stdin，
 *   不进会话历史/工具结果/磁盘；收尾补一发 sudo -k 双保险。NOPASSWD 免密账户退化为确认弹窗；
 *   sudoers requiretty / 无 sudo 时明确报错。
 *
 * 凭据中转（secret 部分）：模型与转录里只有 {{sec:名字}}，真值只存在于会话级内存库；
 *   执行前从库取值、经环境变量交给子进程（不进 argv），结果返回前按**已知值**逐字替换回占位符
 *   （不靠猜测识别，误报为零）。/secure 面板管条目与设置。
 *
 * 配置：~/.pi/agent/secure.json（手动编辑；AI 允许的意图会自动写回）
 *   {
 *     "enabled": true,                          // 总开关
 *     "deny": ["\\brm\\s+-rf\\s+/(\\s|$)"],        // 硬拒绝正则（命中即拒，不询问）
 *     "watch": ["\\bdws\\s+chat\\s+send\\b"],      // 关注项正则（只提高审核严格度）
 *     "remembered": [{ "pattern": "...", "intent": "...", ... }],  // 已记住的操作
 *     "aiReview": true, "sudoExec": true, "model": "auto",
 *   }
 *   model 键是本插件的本地模型设置（auto = 交给 model-config；或 provider/modelId 本地固定），
 *   由 shared/model-setting 维护。
 *
 * 命令：/secure 查看状态；on|off 开关；reload 重读配置；sudo on|off；prune 清理过期记忆；
 *       model [provider/id|auto] 直接设置，无参打开模型选择浮层（shared/model-select）。
 * AI 审核进度经官方 setStatus 通道推「secure」状态，由 hud 行 1 显示；审核不设人工超时，
 * 时间给足，要中断由用户 Esc（透传当前轮次中断信号）。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";
import { isCodemodeCall } from "../shared/codemode";
import { hasPasswordlessSudo, runCommand, runSudo, type RunResult } from "./runner";
import { expandRefs, maskKnown, refFor, refsIn } from "./refs";
import { dropVault, isValidName, nameFor, vaultFor, type Vault } from "./vault";
import { CredPanel } from "./cred-panel";
import { findShapes } from "./shapes";
import { shapePlaceholder } from "./refs";
import { askChoice } from "../shared/review-panel";
import { choiceKey, createBoxRenderer, dividerScrollNote, editInput, renderChoiceList, renderScrollingInput, scrollByPage, wrapIndented } from "../shared/ui";
import { resolveSettingArg, type AnyModel } from "../shared/model-select";
import { LOCAL_AUTO, createModelSetting, type ModelSetting } from "../shared/model-setting";
import { SecureConfigOverlay } from "./config-panel";
export { compilePatternError, patternHits } from "./config-panel";
import { splitShellSegments } from "../shared/shell-split";
import { setWaiting } from "../shared/status";
import { toolError, toolText } from "../shared/tool-result";
import { aiComplete, type AiModelChain } from "../shared/llm";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 配置文件路径（~/.pi/agent/secure.json） */
const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "secure.json");

/**
 * AI 审核模型设置（用途 `secure.review`，默认策略 LITE）：
 * 本地值 auto = 交给 model-config；或本地固定 provider/modelId（存同一配置文件的 model 键）
 */
const reviewModelSetting: ModelSetting = createModelSetting({
	purpose: "secure.review",
	plugin: "secure",
	label: "命令审核",
	file: CONFIG_FILE,
	key: "model",
	defaultStrategy: "LITE",
});

/** 喂给 AI 审核的命令最大字符数（超出截断） */
const AI_CMD_MAX_CHARS = 4_000;

/** 记忆规则的保鲜期（天）：超过未命中自动清理（防无限膨胀；过期未清理前仍生效） */
const REMEMBER_EXPIRE_DAYS = 30;

/** 已记住的操作（意图缓存），过期自动清理 */
interface RememberedRule {
	pattern: string;
	/** 人类可读的操作意图（面板/通知展示；旧数据缺失时回落 pattern） */
	intent: string;
	addedAt: number;
	lastHit: number;
	hits: number;
}

interface SecureConfig {
	enabled: boolean;
	/** 硬拒绝：命中即拒且不询问（只在「绝不执行」时加） */
	deny: string[];
	/** 关注项：命中只提高 AI 审核严格度，不打断用户 */
	watch: string[];
	/** 已记住的操作（意图缓存）：命中即放行 */
	remembered: RememberedRule[];
	aiReview: boolean;
	/** sudo 授权通道（sudo_exec 工具）开关；关 = sudo 命令退回名单审核流程 */
	sudoExec: boolean;
}

/** 默认硬拒绝：无需商量的破坏性操作（用户可在配置里增删） */
const DEFAULT_DENY: string[] = [
	"\\brm\\s+(?:-[a-zA-Z]+\\s+)*/(?:\\s|$)", // 删根目录
	"\\bmkfs(?:\\.\\w+)?\\b", // 格式化文件系统
	"\\bdd\\b[^\\n]*\\bof=/dev/(?:sd|nvme|disk|hd)", // dd 直写块设备
	"\\b(?:curl|wget)\\b[^\\n|]*\\|\\s*(?:sudo\\s+)?(?:ba|z)?sh\\b", // 远程脚本直接进 shell
	"\\bchmod\\s+-R\\s+(?:777|a\\+rwx)\\s+/(?:\\s|$)", // 递归放开根目录权限
];

/** 默认关注项：不直接拦，但让 AI 从严看一眼 */
const DEFAULT_WATCH: string[] = [
	"\\bdws\\s+chat\\s+send\\b", // 对外发送消息
	"\\bgit\\s+push\\b", // 推送到远端
];

/** 默认配置（首次运行写入，用户可手动编辑） */
const DEFAULT_CONFIG: SecureConfig = {
	enabled: true,
	deny: DEFAULT_DENY,
	watch: DEFAULT_WATCH,
	remembered: [],
	aiReview: true,
	sudoExec: true,
};

/** AI 审核结论 */
interface Verdict {
	action: "allow" | "review" | "reject";
	reason: string;
	/** 命令意图的一句话概括（面向用户；自动记住的操作名与面板标题都用它） */
	intent: string;
	/** 影响面要点（AI 给的短句列表，如「写文件：build/」「联网：registry.npmjs.org」） */
	impact: string[];
	/** 可泛化的操作正则（AI 用 <*> 占位可变参数）；空串 = 无法泛化（落库时退结构化兜底） */
	pattern: string;
}

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

/** 配置校验：只认当前字段（enabled/deny/watch/remembered/aiReview/sudoExec），缺字段/多余字段放行 */
function isConfig(v: unknown): v is SecureConfig {
	const c = v as Partial<SecureConfig> | null;
	// 新键缺省视为开（旧配置文件没有这个键时不该悄悄丢掉持久化）
	const okList = (x: unknown) => x === undefined || (Array.isArray(x) && x.every((s) => typeof s === "string"));
	const okRules = (x: unknown) =>
		x === undefined ||
		(Array.isArray(x) &&
			x.every((r) => typeof r === "object" && r !== null && typeof (r as { pattern?: unknown }).pattern === "string"));
	return (
		!!c &&
		typeof c === "object" &&
		typeof c.enabled === "boolean" &&
		okList(c.deny) &&
		okList(c.watch) &&
		okRules(c.remembered) &&
		typeof c.aiReview === "boolean" &&
		(c.sudoExec === undefined || typeof c.sudoExec === "boolean")
	);
}

/** 已记住规则列表：缺时间/计数补默认，缺 pattern 的非法项跳过（条目由面板与 AI 落库写入） */
function toRememberedRules(list: unknown, now = Date.now()): RememberedRule[] {
	if (!Array.isArray(list)) return [];
	const out: RememberedRule[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const r = item as Partial<RememberedRule>;
		if (typeof r.pattern !== "string" || !r.pattern) continue;
		out.push({
			pattern: r.pattern,
			intent: typeof r.intent === "string" && r.intent ? r.intent : r.pattern,
			addedAt: typeof r.addedAt === "number" ? r.addedAt : now,
			lastHit: typeof r.lastHit === "number" ? r.lastHit : now,
			hits: typeof r.hits === "number" ? r.hits : 0,
		});
	}
	return out;
}

function loadConfig(): { cfg: SecureConfig; isNew: boolean } {
	// 文件不存在视为新建：顺手写一份默认配置，方便用户手动编辑
	let isNew = false;
	try {
		isNew = !fs.existsSync(CONFIG_FILE);
	} catch {
		/* 忽略 */
	}
	const raw = loadJsonConfig(CONFIG_FILE, structuredClone(DEFAULT_CONFIG), isConfig) as SecureConfig;
	const cfg: SecureConfig = {
		enabled: raw.enabled,
		deny: Array.isArray(raw.deny) ? raw.deny : structuredClone(DEFAULT_DENY),
		watch: Array.isArray(raw.watch) ? raw.watch : structuredClone(DEFAULT_WATCH),
		remembered: toRememberedRules(raw.remembered),
		aiReview: raw.aiReview,
		sudoExec: raw.sudoExec ?? true,
	};
	return { cfg, isNew };
}

/** 名单/候选正则统一标志：i 大小写不敏感 + s dotAll（. 跨换行——多行命令如 python -c "..." 内嵌脚本场景，AI 提炼的 .* 才能跨行命中） */
const REGEX_FLAGS = "is";

/** 把正则字符串列表编译成正则，无效条目收集到 invalid（跳过不阻断） */
function compilePatterns(patterns: string[], invalid: string[]): RegExp[] {
	const out: RegExp[] = [];
	for (const p of patterns) {
		try {
			out.push(new RegExp(p, REGEX_FLAGS));
		} catch {
			invalid.push(p);
		}
	}
	return out;
}

/** 精确匹配正则：^ + 转义后的完整命令 + $（面板「加名单」用，只命中同一条命令） */
function exactPattern(command: string): string {
	return "^" + command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
}

/**
 * AI 给的操作正则 → 可编译正则：<*> 占位符转成 [^\n]+（匹配任意参数值、不跨行）。
 * 返回 null = 空串或不可编译。
 */
function compileSkeleton(pattern: string): RegExp | null {
	if (!pattern.trim()) return null;
	const body = pattern.replace(/<\*>/g, '[^\\n]+');
	try {
		return new RegExp(body, REGEX_FLAGS);
	} catch {
		return null;
	}
}

/**
 * 结构化兜底规则：单段命令用 `^命令\s+子命令`（覆盖同类变体又不误伤其他子命令）；
 * 多段命令一条规则做不到，退整串精确匹配（宁可再问一次，也不放宽）。
 */
function fallbackPattern(command: string, segments: string[]): string {
	const src = segments.length > 0 ? segments : [command];
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const parts = src.map((seg) => {
		const tokens = seg.trim().split(/\s+/);
		const cmdName = tokens[0] ?? '';
		if (!cmdName) return '';
		const sub = tokens[1] && !tokens[1].startsWith('-') ? `\\s+${esc(tokens[1])}` : '';
		return `^${esc(cmdName)}${sub}`;
	});
	const valid = parts.filter(Boolean);
	return valid.length === 1 && valid.length === src.length ? valid[0]! : exactPattern(command);
}

/**
 * 选出实际要记住的操作规则（意图缓存）：优先 AI 提炼的可泛化正则
 * （需能命中当前命令或某一子段，否则形同虚设），否则退结构化兜底。
 */
function decideRememberedPattern(command: string, segments: string[], verdict: Verdict): string {
	const ai = compileSkeleton(verdict.pattern);
	if (ai && (ai.test(command) || segments.some((s) => ai.test(s)))) return ai.source;
	return fallbackPattern(command, segments);
}

/** 送审摘要用：截断过长文本（仅 AI 侧 segInfo，人看的面板一律全文折行） */
function truncateCmd(command: string, max: number): string {
	return command.length > max ? command.slice(0, max) + "\n…(已截断)" : command;
}

// ---------------------------------------------------------------------------
// AI 审核
// ---------------------------------------------------------------------------

const AI_SYSTEM_PROMPT = [
	"你是 shell 命令安全审核员。AI 编码助手要在用户机器上执行一条 bash 命令，由你判断是否安全。",
	"审核标准宽松：只拦明显恶意的指令，绝大多数常规开发操作都应放行。",
	"\n===== 结论 =====",
	'"allow"：绝大多数命令都应放行；',
	'"review"：命令有明显风险或意图不明，值得让用户看一眼；',
	'"reject"：仅拦截明显恶意的指令。',
	"用户标记为【关注项】的命令请从严判断：宁可 review，不要 allow。",
	"\n===== 三件事都要说清 =====",
	"1. reason：一句话（面向用户、人话）说为什么值得警惕或为何安全；",
	"2. impact：影响面要点，0~3 条短句，只写事实，如「删除文件：build/」「联网：registry.npmjs.org」",
	"   「读取凭证：~/.pi/agent/auth.json」「修改系统配置」「无副作用」；拿不准就写「影响面：未知」；",
	"3. pattern：可泛化的操作正则（用 <*> 占位可变参数），覆盖「这类操作」而不是「这一条命令」。",
	"   例：`^git\\s+push\\s+<*>`、`^npm\\s+(install|ci)\\s+<*>`、`^dws\\s+chat\\s+send\\s+<*>`。",
	"   写作要求：命令锚定（含命令名、优先 ^ 开头）；包含子命令/关键旗标；",
	"   参数值用 <*> 不复现；不要包含具体路径/分支名/URL；不要只给旗标；无法安全泛化时给空字符串。",
	"   命令可能是多行（python -c \"...\" / heredoc）：正则保持命令原样，跨任意内容用 .*。",
	"\n只输出一行 JSON，不要解释、不要代码块围栏：",
	'{"action":"allow|review|reject","reason":"...","impact":["..."],"pattern":"..."}',
].join("\n");

/**
 * 调辅助小模型审核命令；失败（超时/无模型/网络错误/输出无法解析）返回 {verdict:null, error}，
 * 由调用方降级人工确认并把原因写进文案（原因可用于定位到底坏在哪一环）。
 * segInfo 为逐段记忆命中标注；watched=true 表示命中关注项，要求 AI 从严判断（宁可 review 不 allow）。
 */
async function aiReview(
	ctx: ExtensionContext,
	command: string,
	chain: AiModelChain,
	segInfo = "",
	watched = false,
): Promise<{ verdict: Verdict | null; error: string }> {
	const truncated = command.length > AI_CMD_MAX_CHARS ? command.slice(0, AI_CMD_MAX_CHARS) + "\n…(已截断)" : command;
	const prompt =
		`工作目录：${ctx.cwd}\n\n待审核命令：\n${truncated}` +
		(segInfo ? `\n\n拆段分析（[已记住] = 用户预先认可，可信；重点审核 [未命中] 段落）：\n${segInfo}` : "") +
		(watched ? "\n\n【关注项】：该命令命中了用户标记为需要留意的类别，请从严判断——宁可 review，不要 allow。" : "");

	ctx.ui.setStatus("secure", "🛡 正在审核命令…");
	try {
		const r = await aiComplete(ctx, chain, {
			systemPrompt: AI_SYSTEM_PROMPT,
			prompt,
			temperature: 0,
			textJoin: "",
			// 审核要求可解析的结论；不合格（模型回散文/坏 JSON）换下一个候选重试
			validate: (text) => {
				const m = text.match(/\{[\s\S]*\}/);
				if (!m) return false;
				try {
					const a = (JSON.parse(m[0]) as { action?: string }).action;
					return a === "allow" || a === "review" || a === "reject";
				} catch {
					return false;
				}
			},
		});
		if (!r.ok) return { verdict: null, error: r.error };
		const m = r.text.match(/\{[\s\S]*\}/);
		if (!m) return { verdict: null, error: "输出无法解析" };
		const parsed = JSON.parse(m[0]) as Partial<Verdict>;
		if (parsed.action !== "allow" && parsed.action !== "review" && parsed.action !== "reject") {
			return { verdict: null, error: "输出无法解析" };
		}
		const impact = Array.isArray(parsed.impact)
			? parsed.impact.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 4)
			: [];
		return {
			verdict: {
				action: parsed.action,
				reason: typeof parsed.reason === "string" ? parsed.reason : "",
				intent: typeof parsed.intent === "string" ? parsed.intent : "",
				impact,
				pattern: typeof parsed.pattern === "string" ? parsed.pattern : "",
			},
			error: "",
		};
	} catch (e) {
		return { verdict: null, error: e instanceof Error ? e.message : String(e) };
	} finally {
		ctx.ui.setStatus("secure", undefined);
	}
}

/**
 * 人工确认面板（overlay 组件）：命令全文折行展示（不截断，PgUp/PgDn 滚动），
 * 默认高亮第一项「允许一次」（回车即允许，符合高频路径）；Esc = 拒绝（不执行）。
 * 面板上方是人话信息区：一句话解读 / 影响面 / 命中原因——用户不必读正则也能判断。
 * 模块级导出供回归测试直接实例化（不走 tool_call 事件链路，避免触碰真实配置文件）。
 */
export class ReviewPanel {
	focused = false;

	private idx = 0;
	private scroll = 0;
	/** 最近一次 render 的文本区窗口行数（PgUp/PgDn 步长）与最大滚动 */
	private lastBudget = 5;
	private lastMaxScroll = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private title: string,
		private command: string,
		private info: ReviewInfo,
		private done: (choice: string | null) => void,
	) {}

	/** 可选操作：永久允许只在能给出可泛化规则时出现 */
	private actions(): string[] {
		return this.info.canRemember ? ["允许一次", "允许并永久记住这类操作", "拒绝"] : ["允许一次", "拒绝"];
	}

	handleInput(data: string): void {
		const actions = this.actions();
		const r = choiceKey(data, this.idx, actions.length);
		switch (r.kind) {
			case "move":
				this.idx = r.index;
				return;
			case "select":
				this.done(actions[r.index] ?? actions[0]!);
				return;
			case "cancel":
				this.done(null); // Esc = 拒绝（不执行）
				return;
			case "page":
				this.scroll = scrollByPage(this.scroll, r.dir, this.lastMaxScroll + this.lastBudget, this.lastBudget);
				return;
			case "skip":
				return;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const { row, topBorder, bottomBorder, border, hint } = createBoxRenderer(th, Math.max(10, width - 2));
		const innerW = Math.max(10, width - 2);
		const actions = this.actions();

		// 上部：人话信息区（不参与滚动，任何情况下都看得见）
		const head: string[] = [];
		const wrap = (s: string): string[] => wrapIndented(s.trimStart(), innerW, 1);
		if (this.info.summary) head.push(...wrap(` ${th.fg("text", this.info.summary)}`));
		if (this.info.impact.length > 0)
			head.push(...wrap(` ${th.fg("dim", `影响面：${this.info.impact.join("；")}`)}`));
		if (this.info.hitLabel) head.push(...wrap(` ${th.fg("warning", this.info.hitLabel)}`));

		// 下部：命令全文（可滚动）
		const cmdLines: string[] = [];
		for (const ln of this.command.split("\n")) cmdLines.push(...wrapIndented(ln, innerW - 2, 2));

		// 高度预算：终端 80% 减去固定行（框/分隔/标题/选项/提示）与信息区
		const termRows = this.tui.terminal.rows || 24;
		const fixed = 7 + head.length + actions.length;
		const budget = Math.max(3, Math.min(cmdLines.length, Math.floor(termRows * 0.8) - fixed));
		this.lastBudget = budget;
		this.lastMaxScroll = Math.max(0, cmdLines.length - budget);
		this.scroll = Math.max(0, Math.min(this.scroll, this.lastMaxScroll));
		const visible = cmdLines.slice(this.scroll, this.scroll + budget);

		// 分隔行兼滚动指示（不吃内容行）
		const below = cmdLines.length - (this.scroll + visible.length);
		const dividerLine = dividerScrollNote(th, border, innerW, this.scroll, below);

		const lines: string[] = [topBorder(` ${this.title} `)];
		lines.push(...head.map((l) => row(l)));
		lines.push(dividerLine);
		for (const ln of visible) lines.push(row(ln));
		lines.push(row(th.fg("accent", " 如何处理？")));
		lines.push(
			...renderChoiceList(
				th,
				actions.map((a, i) => ({ label: a, note: i === 1 && this.info.canRemember ? this.info.intent : undefined })),
				this.idx,
			).map((l) => row(l)),
		);
		lines.push(
			hint(`↑↓ 选择 · Enter 确认 · 1-${actions.length} 直选 · PgUp/PgDn 滚动命令 · Esc 拒绝（不执行）`),
		);
		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

/** 人工确认面板的人话信息（由调用方组装） */
export interface ReviewInfo {
	/** 一句话解读（为何被拦 / AI 怎么看） */
	summary: string;
	/** 影响面要点（写/删/联网/凭证等） */
	impact: string[];
	/** 被拦原因标签（如「命中关注项：对外发消息」） */
	hitLabel?: string;
	/** 是否提供「永久允许」选项（能给出可泛化规则时为 true） */
	canRemember: boolean;
	/** 将被记住的操作意图（显示在「永久允许」选项旁） */
	intent?: string;
}

// ---------------------------------------------------------------------------
// sudo 授权通道（密码即授权，仅当次有效）
// ---------------------------------------------------------------------------

/** 段首 sudo 判定：允许前导环境变量赋值与常见包装命令（env/nohup/time/command）；sudoedit 同族同待遇。
 *  只看段首：「echo sudo」「man sudo」不误伤；「sh -c 'sudo x'」这类深藏的不拦——非交互通道下 sudo 问不出密码，
 *  命令自己会失败，不构成绕过（拿不到权限）。 */
const SUDO_SEGMENT_RE = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+|env\s+|nohup\s+|time\s+|command\s+)*sudo(?:edit)?(?:\s|$)/;

/** 单次调用的密码尝试上限（浮层内原地重试，不占 AI 回合） */
const SUDO_MAX_ATTEMPTS = 3;

/**
 * sudo 授权面板（overlay）：完整展示待授权命令（授权的前提是看得到完整命令——折行不截断，
 * PgUp/PgDn 滚动）+ 掩码密码输入。Enter 提交密码授权执行；Esc = 拒绝（done(null)）；
 * 重试时以 error 色显示第 N/MAX 次提示。
 */
export class SudoPanel {
	focused = false;

	private password = "";
	private cursor = 0;
	private scroll = 0;
	/** 最近一次 render 的命令区窗口行数（PgUp/PgDn 步长）与最大滚动 */
	private lastBudget = 5;
	private lastMaxScroll = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private command: string,
		private attempt: number,
		private maxAttempts: number,
		private done: (password: string | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done(this.password);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scroll = Math.max(0, this.scroll - this.lastBudget);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scroll = Math.min(this.lastMaxScroll, this.scroll + this.lastBudget);
			return;
		}
		const r = editInput(this.password, this.cursor, data, { maxLength: 256 });
		if (r !== "skip") {
			this.password = r.text;
			this.cursor = r.cursor;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const { row, topBorder, bottomBorder, border } = createBoxRenderer(th, Math.max(10, width - 2));
		const innerW = Math.max(10, width - 2);

		// 命令全文折行（不截断，PgUp/PgDn 滚动，滚动余量在分隔行指示）
		const cmdLines: string[] = [];
		for (const ln of this.command.split("\n")) cmdLines.push(...wrapIndented(ln, innerW - 2, 2));
		const termRows = this.tui.terminal.rows || 24;
		const budget = Math.max(3, Math.min(cmdLines.length, Math.floor(termRows * 0.8) - 10));
		this.lastBudget = budget;
		this.lastMaxScroll = Math.max(0, cmdLines.length - budget);
		this.scroll = Math.max(0, Math.min(this.scroll, this.lastMaxScroll));
		const visible = cmdLines.slice(this.scroll, this.scroll + budget);

		const below = cmdLines.length - (this.scroll + visible.length);
		const dividerLine = dividerScrollNote(th, border, innerW, this.scroll, below);

		// 掩码输入行（• 与密码等长，光标位置经水平滚动窗口换算）
		const masked = "•".repeat(this.password.length);
		const { display } = renderScrollingInput(masked, this.cursor, innerW - 10);

		const lines: string[] = [topBorder(" 🔐 sudo 授权（仅当次有效） ")];
		lines.push(row(th.fg("dim", " AI 请求以 root 身份执行以下命令：")));
		for (const ln of visible) lines.push(row(ln));
		lines.push(dividerLine);
		if (this.attempt > 1) {
			lines.push(row(` ${th.fg("error", `密码错误，请重试（第 ${this.attempt}/${this.maxAttempts} 次）`)}`));
		}
		lines.push(row(` ${th.fg("accent", "密码：")}${display}`));
		lines.push(row(th.fg("dim", " Enter 授权执行 · Esc 拒绝 · 密码仅用于本次执行（不保存、不显示） ，每次提权都需重新输入")));
		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let cfg: SecureConfig;
	{
		const loaded = loadConfig();
		cfg = loaded.cfg;
		if (loaded.isNew) saveJsonConfig(CONFIG_FILE, cfg); // 首次运行写默认配置，方便用户编辑
		// 启动时清理超过保鲜期的白名单规则（历史残留不堆积）
		if (pruneRemembered() > 0) saveJsonConfig(CONFIG_FILE, cfg);
	}

	/** AI 审核结论会话级缓存（精确命令 → 结论；review 不缓存，每次都让人工决定） */
	const aiCache = new Map<string, Verdict>();

	/** 粘贴确认面板的三个选项（文案即返回值，改文案要同步改判断） */
	const PICK_STORE = "收进本会话";
	const PICK_MASK = "只遮住";
	const PICK_RAW = "原样发送";

	/** 凭据库的会话槽位：session_start 时确定（会话文件或会话 ID），/reload 保留 */
	let vaultScope = "default";

	/** 面板串行链：并行工具批里多个待复核命令依次弹面板，避免对话框互相覆盖 */
	let panelChain: Promise<unknown> = Promise.resolve();

	function saveConfig(): void {
		// 模型设置（同文件的 model 键）由 shared/model-setting 维护，写回时原样带上，避免被 cfg 覆盖掉
		saveJsonConfig(CONFIG_FILE, { ...cfg, model: reviewModelSetting.getLocal() });
	}

	// 记忆保鲜：命中时刷新规则内存元数据，落盘 throttle（避免高频 bash 调用频繁写配置）
	let rememberedTouchDirty = false;
	let lastRememberedPersist = 0;
	const REMEMBERED_PERSIST_MIN_MS = 60_000;

	/** 命中已记住的操作：刷新保鲜期与计数（内存记录，落盘见 maybePersistRemembered） */
	function touchRemembered(rule: RememberedRule, now: number): void {
		rule.hits++;
		rule.lastHit = now;
		rememberedTouchDirty = true;
	}

	/** 落盘未持久化的命中刷新（throttle，最短间隔 60s） */
	function maybePersistRemembered(): void {
		if (!rememberedTouchDirty) return;
		const now = Date.now();
		if (now - lastRememberedPersist < REMEMBERED_PERSIST_MIN_MS) return;
		lastRememberedPersist = now;
		rememberedTouchDirty = false;
		saveConfig();
	}

	/** 已记住规则的工厂（保鲜期从记住时刻起算） */
	function newRememberedRule(pattern: string, intent: string): RememberedRule {
		const now = Date.now();
		return { pattern, intent: intent || pattern, addedAt: now, lastHit: now, hits: 0 };
	}

	/** 清理超过保鲜期未命中的记忆（过期≠失效：未清理前仍生效）；返回清理条数 */
	function pruneRemembered(): number {
		const cutoff = Date.now() - REMEMBER_EXPIRE_DAYS * 86_400_000;
		const before = cfg.remembered.length;
		cfg.remembered = cfg.remembered.filter((r) => r.lastHit >= cutoff);
		return before - cfg.remembered.length;
	}

	/** 已记住规则编译（携带规则对象供命中保鲜）；无效正则收集进 invalid */
	function compileRemembered(invalid: string[]): Array<{ re: RegExp; rule: RememberedRule }> {
		const out: Array<{ re: RegExp; rule: RememberedRule }> = [];
		for (const r of cfg.remembered) {
			try {
				out.push({ re: new RegExp(r.pattern, REGEX_FLAGS), rule: r });
			} catch {
				invalid.push(r.pattern);
			}
		}
		return out;
	}

	/** 解析 AI 审核模型链（本地设置 → 中心设置 → 默认策略 LITE → AUTO，见 shared/model-setting） */
	function resolveReviewModel(ctx: ExtensionContext): AiModelChain {
		return reviewModelSetting.resolve(ctx);
	}

	/**
	 * 组装人工确认面板的人话信息：AI 一句话解读 + 影响面 + 命中原因。
	 * 面板不再让用户读正则：命中说明只写「哪一类规则」（关注项/硬拒绝/未知），不贴正则原文。
	 */
	function buildReviewInfo(
		command: string,
		verdict: Verdict | null,
		source: "watch" | "ai" | "degraded",
		hitLabel?: string,
	): ReviewInfo {
		const canRemember = Boolean(decideRememberedPattern(command, splitShellSegments(command), verdict ?? emptyVerdict()));
		const summary =
			verdict?.reason ||
			(source === "degraded" ? "AI 审核暂时不可用，已转为人工确认。" : "这条命令没命中已知规则，请你确认是否执行。");
		const impact = verdict?.impact ?? [];
		const intent = verdict?.intent || command.trim().split("\n")[0]!.slice(0, 40);
		return { summary, impact, hitLabel, canRemember, intent };
	}

	/** 空结论（AI 失败/无结论时的占位，pattern 为空 → 只能退结构化兜底） */
	function emptyVerdict(): Verdict {
		return { action: "review", reason: "", intent: "", impact: [], pattern: "" };
	}

	/**
	 * AI 判 allow 时把「这类操作」写进记忆（意图缓存）：下次同类命令直接放行，零审核成本。
	 * 规则优先采用 AI 提炼的语义正则，缺失/跑偏时退结构化兜底（命令+子命令）。
	 * 护栏：不覆盖硬拒绝/关注项已有规则、去重；每次记住都发通知（展示意图而非正则）。
	 */
	function rememberIntent(
		ctx: ExtensionContext,
		command: string,
		segments: string[],
		pattern: string,
		intent: string,
	): void {
		if (cfg.deny.includes(pattern) || cfg.watch.includes(pattern)) return;
		if (cfg.remembered.some((r) => r.pattern === pattern)) return;
		pruneRemembered(); // 先清过期（与新增同批落盘）
		cfg.remembered.push(newRememberedRule(pattern, intent));
		saveConfig();
		ctx.ui.notify(`secure 已记住「${intent || pattern}」，以后同类命令直接放行`, "info");
	}

	/**
	 * 人工确认：返回 undefined = 放行；{ block } = 拒绝（命令不执行）。
	 * 面板默认高亮「允许一次」；「允许并永久记住这类操作」会把可泛化规则写进记忆。
	 */
	async function humanReview(
		ctx: ExtensionContext,
		command: string,
		segments: string[],
		source: "watch" | "ai" | "degraded",
		verdict: Verdict | null,
		hitLabel?: string,
	): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) {
			const why =
				source === "watch"
					? `命中关注项${hitLabel ? `（${hitLabel}）` : ""}`
					: source === "degraded"
						? "AI 审核暂不可用"
						: "AI 建议人工确认";
			return {
				block: true,
				reason:
					`secure：${why}，可是当前是无界面会话、无法请你确认，已拒绝执行本条命令。
` +
					`如需执行，请在带界面的会话重试；如确认该类操作总是安全，可在 ${CONFIG_FILE} 里加入 remembered 记忆规则。`,
			};
		}
		const info = buildReviewInfo(command, verdict, source, hitLabel);
		const title =
			source === "watch" ? "⚠ 需要你确认：命中关注项" : source === "degraded" ? "⚠ 需要你确认（AI 暂不可用）" : "⚠ 需要你确认这条命令";
		// 串行化面板
		return new Promise<{ block: true; reason: string } | undefined>((resolve) => {
			panelChain = panelChain.catch(() => {}).then(async () => {
				setWaiting(`确认命令：${command.trim().split("\n")[0]!.slice(0, 40)}`);
				let choice: string | null;
				try {
					choice = await ctx.ui.custom<string | null>(
						(tui, theme, _kb, done) => new ReviewPanel(tui, theme, title, command, info, done),
						{ overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "80%" } },
					);
				} catch {
					resolve({ block: true, reason: "secure：确认面板未能打开，命令未执行。请重试。" });
					return;
				} finally {
					setWaiting(null);
				}
				switch (choice) {
					case "允许一次":
						resolve(undefined);
						break;
					case "允许并永久记住这类操作": {
						const pattern = decideRememberedPattern(command, segments, verdict ?? emptyVerdict());
						rememberIntent(ctx, command, segments, pattern, verdict?.intent ?? "");
						resolve(undefined);
						break;
					}
					default: // "拒绝" 或 Esc
						resolve({ block: true, reason: "secure：用户拒绝了该命令，未执行。请换方案，或向用户说明后再试。" });
						break;
				}
			});
		});
	}

	/** 组装 sudo 执行结果文本（绝不包含密码；认证失败不走这里，由调用方单独报错） */
	function sudoResultContent(
		command: string,
		r: RunResult,
	): { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: Record<string, never> } {
		if (r.fatal) {
			return {
				content: [
					{
						type: "text" as const,
						text: `sudo 执行失败：${r.fatal}\n可请用户手动执行：sudo bash -c '${command.replace(/'/g, "'\\''")}'`,
					},
				],
				isError: true,
				details: {},
			};
		}
		const parts: string[] = [];
		if (r.timedOut) parts.push("（命令超时，已被终止）");
		if (r.stdout.trim()) parts.push(`[stdout]\n${r.stdout.trimEnd()}`);
		if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
		if (!r.stdout.trim() && !r.stderr.trim()) parts.push("（无输出）");
		if (r.truncated) parts.push("（输出过长已截断）");
		parts.push(`exit code: ${r.code ?? "未知"}`);
		return { content: [{ type: "text" as const, text: parts.join("\n\n") }], isError: r.code !== 0, details: {} };
	}

	/**
	 * sudo 授权通道主流程（sudo_exec 工具体）：
	 * NOPASSWD 免密账户 → confirm 弹窗授权；否则弹密码浮层（密码错误原地重试，共 3 次）。
	 * 密码只经扩展内存喂给 sudo 的 stdin：不进会话历史、不进工具结果、不落盘。
	 */
	async function sudoAuthorizeAndRun(
		ctx: ExtensionContext,
		command: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; details: Record<string, never> }> {
		const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: {} });
		if (!cfg.enabled || !cfg.sudoExec) {
			return fail("secure sudo 授权通道已关闭（/secure sudo on 开启），无法代为执行；请改用普通命令，或请用户手动执行。");
		}
		if (!ctx.hasUI) {
			return fail(`当前无 UI，无法弹窗请求 sudo 授权。请用户手动执行：sudo bash -c '${command.replace(/'/g, "'\\''")}'`);
		}

		const waitText = `sudo 授权：${command.trim().split("\n")[0]!.slice(0, 40)}`;

		// 免密账户：确认弹窗即授权（仍满足「每次调用都需用户确认」）
		if (await hasPasswordlessSudo()) {
			setWaiting(waitText);
			let ok = false;
			try {
				ok = await ctx.ui.confirm("🔐 sudo 授权（免密账户）", `AI 请求以 root 身份执行：\n${command}\n\n本次授权仅对这一次执行有效。`);
			} finally {
				setWaiting(null);
			}
			if (!ok) return fail("用户拒绝了本次 sudo 授权，命令未执行。如需提权，请与用户确认能否换一种做法。");
			const r = await runSudo(command, null, { timeoutMs, signal });
			return sudoResultContent(command, r);
		}

		for (let attempt = 1; attempt <= SUDO_MAX_ATTEMPTS; attempt++) {
			setWaiting(waitText);
			let password: string | null;
			try {
				password = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) => new SudoPanel(tui, theme, command, attempt, SUDO_MAX_ATTEMPTS, done),
					{ overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "80%" } },
				);
			} finally {
				setWaiting(null);
			}
			if (password == null) return fail("用户拒绝了本次 sudo 授权，命令未执行。如需提权，请与用户确认能否换一种做法。");
			const r = await runSudo(command, password, { timeoutMs, signal });
			password = null; // 即刻脱手：密码引用不再留存
			if (r.authFailed && attempt < SUDO_MAX_ATTEMPTS) continue; // 浮层内原地重试，不占 AI 回合
			if (r.authFailed) return fail(`sudo 认证失败（${SUDO_MAX_ATTEMPTS} 次密码均不正确），命令未执行。`);
			return sudoResultContent(command, r);
		}
		return fail("sudo 授权未完成。"); // 不可达，兜底
	}

	// sudo_exec 工具：AI 需要 root 权限时的唯一通道（bash 里直接写 sudo 会被下方拦截打回）
	pi.registerTool({
		name: "sudo_exec",
		annotations: { readOnlyHint: false },
		label: "提权执行命令",
		description:
			"以 root 权限执行 bash 命令（等价 sudo bash -c '<command>'）。每次调用都会向用户弹窗请求授权（用户直接输入 sudo 密码），授权仅当次有效、下次调用需重新授权。" +
			"需要 sudo 权限时必须使用本工具——不要在 bash 工具命令里写 sudo（会被拦截打回）。command 不要带 sudo 前缀，整条命令将以 root 执行。" +
			"不要向用户索要密码：密码由用户在弹窗中直接输入，你看不到也不需要看到。",
		promptSnippet:
			"sudo 提权执行：sudo_exec(command 不带 sudo 前缀) → 用户弹窗输密授权（仅当次），返回 stdout/stderr/退出码",
		parameters: Type.Object({
			command: Type.String({ description: "要以 root 身份执行的 bash 命令（不要带 sudo 前缀）" }),
			timeout: Type.Optional(Type.Integer({ description: "超时毫秒数，默认 120000，上限 600000", minimum: 1000 })),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const command = params.command.trim();
			if (!command) {
				return { content: [{ type: "text" as const, text: "命令为空" }], isError: true, details: {} };
			}
			// 授权弹窗在脚本里同步阻塞：等待计入脚本超时，超时重试还会堆积
			if (isCodemodeCall(toolCallId)) {
				return {
					content: [{ type: "text" as const, text: "sudo_exec 需要用户当场输密授权，不能在 codemode 脚本里调用（脚本内等待会一直计入超时）。请直接调用 sudo_exec。" }],
					isError: true,
					details: {},
				};
			}
			const timeoutMs = Math.min(Math.max(params.timeout ?? 120_000, 1_000), 600_000);
			// 与人工复核面板共用串行链：并行工具批里多个授权请求依次弹窗，避免浮层互相覆盖
			let result!: Awaited<ReturnType<typeof sudoAuthorizeAndRun>>;
			panelChain = panelChain.catch(() => {}).then(async () => {
				result = await sudoAuthorizeAndRun(ctx, command, timeoutMs, signal);
			});
			await panelChain;
			return result;
		},
	});

	/* ---------- 入口：粘贴里的高置信凭证，问一句再决定怎么处理 ---------- */

	/**
	 * 粘进对话的凭证不该直接进上下文与请求体。识别的只有固定形态（shapes.ts），不做打分猜测；
	 * 命中后弹面板让用户三选一，**默认高亮「遮住」**（最保守的那项）。
	 *
	 * 只处理用户粘贴的输入（source=extension 的注入内容不碰：那可能是别的扩展在传数据）。
	 */
	pi.on("input", async (event, ctx) => {
		if (!cfg.enabled) return undefined;
		if (event.source === "extension") return undefined;
		// 已经是引用形态：用户或工具明确要求，不必再问
		if (event.text.includes("{{sec:")) return undefined;

		const hits = findShapes(event.text);
		if (hits.length === 0) return undefined;

		// 已收录的值不再问：用户当初选「收进本会话」就是它的决定，重复粘贴只是再用一次。
		// 直接换回已有的引用，零打扰。
		const known = new Map<string, string>(); // value → name
		for (const hit of hits) {
			const existing = vaultOf().nameOfValue(hit.value);
			if (existing) known.set(hit.value, existing);
		}
		if (known.size === hits.length) {
			let text = event.text;
			for (const hit of [...hits].sort((a, b) => b.start - a.start)) {
				text = text.slice(0, hit.start) + refFor(known.get(hit.value)!) + text.slice(hit.end);
			}
			ctx.ui.notify(`已换成已有的引用：${[...new Set(known.values())].map((n) => `{{sec:${n}}}`).join("、")}`, "info");
			return { action: "transform" as const, text };
		}
		// 部分已收录：只问没收录的那些，已收录的照旧静默换引用（下面按 hit 逐个判断）
		const unknownHits = hits.filter((hit) => !known.has(hit.value));

		// 无界面会话：没有用户可以问，保持原样（不擅自改写用户输入）
		if (!ctx.hasUI) return undefined;

		const action = await askChoice(ctx, {
			title: "输入里有凭证",
			verb: "处理",
			object: unknownHits.length === 1 ? unknownHits[0]!.label : `${unknownHits.length} 处新凭证`,
			sections: [
				{
					kind: "list",
					label: "识别到",
					items: unknownHits.map((h) => `${h.label}：${h.value.slice(0, 6)}…${h.value.slice(-4)}（${h.value.length} 字符）`),
				},
				...(known.size > 0
					? [{ kind: "text" as const, label: "已收录（自动换引用）", items: [...known.values()].map((n) => `{{sec:${n}}}`) }]
					: []),
			],
			impact: [
				"选「收进库」后可用 {{sec:名字}} 在命令里引用，鼠标原文里不会留值",
				"选「遮住」只把原文换成占位符，本会话没有值可用",
			],
			actions: [PICK_STORE, PICK_MASK, PICK_RAW],
		});

		if (action === PICK_RAW || action === null) return undefined;

		let text = event.text;
		const added: string[] = [];
		const reused: string[] = [];
		// 从后往前替换，避免偏移量被前一次替换带偏
		for (const hit of [...hits].sort((a, b) => b.start - a.start)) {
			// 已收录的值：不管本次选了什么，都换回已有引用（它的处理方式早已由用户定过）
			const existing = known.get(hit.value);
			if (existing) {
				text = text.slice(0, hit.start) + refFor(existing) + text.slice(hit.end);
				if (!reused.includes(existing)) reused.push(existing);
				continue;
			}
			if (action === PICK_STORE) {
				const name = nameFor(hit.label, hit.value);
				vaultOf().add({ name, value: hit.value, kind: "secret", label: hit.label });
				if (!added.includes(name)) added.push(name);
				text = text.slice(0, hit.start) + refFor(name) + text.slice(hit.end);
			} else {
				text = text.slice(0, hit.start) + shapePlaceholder(hit.label) + text.slice(hit.end);
			}
		}

		if (action === PICK_STORE) {
			pushCredStatus(ctx);
			const parts: string[] = [];
			if (added.length > 0) parts.push(`新收进 ${added.map((n) => `{{sec:${n}}}`).join("、")}`);
			if (reused.length > 0) parts.push(`复用已有 ${reused.map((n) => `{{sec:${n}}}`).join("、")}`);
			ctx.ui.notify(`本会话凭证：${parts.join("；")}（值不会进入对话）`, "info");
		} else {
			ctx.ui.notify(`已遮住 ${unknownHits.length} 处新凭证（本会话没有值，要用来执行请按 n 在面板里录入）`, "info");
		}
		return { action: "transform" as const, text };
	});

	/* ---------- 生命周期：确定凭据库槽位、清理 ---------- */

	pi.on("session_start", async (event, ctx) => {
		vaultScope = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		vault = vaultFor(vaultScope);
		// /reload 保留库（同一会话槽位）；新会话从空库开始
		if (event.reason !== "reload") pushCredStatus(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// reload 不动库：用户重载扩展不该丢掉刚录入的凭据
		if (event.reason !== "reload") dropVault(vaultScope);
		if (ctx.hasUI) { ctx.ui.setStatus("secure", undefined); ctx.ui.setStatus("secret", undefined); }
	});

	/** 状态栏：本会话已录入的凭据条数（与审核状态共用 secure 这个 key，审核时优先级更高） */
	function pushCredStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const size = vaultOf().size();
		ctx.ui.setStatus("secret", size > 0 ? `🔐 ${size} 条凭据` : undefined);
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!cfg.enabled) return undefined;
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input.command;

		// 编译三层名单（bash 调用频率低，每次现编译开销可忽略；无效正则跳过并计入 invalid）
		const invalid: string[] = [];
		const deny = compilePatterns(cfg.deny, invalid);
		const watch = compilePatterns(cfg.watch, invalid);
		const remembered = compileRemembered(invalid);

		// 复合命令拆段（&& / || / ; / | / 换行 / $() / `...`）：记忆逐段判定，
		// 防止「git status && rm -rf x」被前半段的记忆规则连带放行
		const segments = splitShellSegments(command);

		// 0. sudo 专用通道（密码即授权，仅当次有效）：bash 里直接写 sudo 一律打回引导改用 sudo_exec——
		// 名单审核不接管提权命令，授权动作必须发生在用户输密那一刻
		if (cfg.sudoExec && segments.some((s) => SUDO_SEGMENT_RE.test(s))) {
			return {
				block: true,
				reason:
					"secure：检测到 sudo 提权命令，bash 的非交互通道无法处理密码输入。" +
					"需要 root 权限请改用 sudo_exec 工具（command 参数不要带 sudo 前缀），用户会在弹窗中输入密码授权（仅当次有效）。" +
					"不要向用户索要密码，也不要让用户手动执行（除非 sudo_exec 明确报错无法使用）。",
			};
		}

		// 1. 硬拒绝（整串 + 逐段）：命中即拒，不询问、不可放行
		const denyWhole = deny.find((p) => p.test(command));
		const denySeg = !denyWhole
			? segments.map((s) => ({ seg: s, re: deny.find((p) => p.test(s)) })).find((x) => x.re)
			: undefined;
		if (denyWhole || denySeg) {
			const label = denySeg ? `子命令段「${denySeg.seg.trim()}」` : "整条命令";
			return {
				block: true,
				reason:
					`secure：${label}命中硬拒绝规则（属于绝不自动执行的一类），已拒绝。
` +
					`如确认本次确实需要执行，请用户手动执行，或先编辑 ${CONFIG_FILE} 的 deny 列表。`,
			};
		}

		// 2. 已记住的操作 → 放行（逐段：每个子命令段都要命中，缺一段都不放）；命中规则刷新保鲜
		if (segments.length > 0) {
			const hitNow = Date.now();
			let allHit = true;
			for (const s of segments) {
				const hit = remembered.find((w) => w.re.test(s));
				if (!hit) {
					allHit = false;
					break;
				}
				touchRemembered(hit.rule, hitNow);
			}
			if (allHit) {
				maybePersistRemembered(); // 允许时落盘保鲜（throttle）
				return undefined;
			}
		}

		// 3. 关注项（整串 + 逐段）：不直接打断，只把命令标记给 AI 让它从严
		const watchWhole = watch.find((p) => p.test(command));
		const watchSeg = !watchWhole
			? segments.map((s) => ({ seg: s, re: watch.find((p) => p.test(s)) })).find((x) => x.re)
			: undefined;
		const hitLabel = watchWhole
			? "命中关注项（整条命令）"
			: watchSeg
				? `命中关注项（子命令段「${watchSeg.seg.trim()}」）`
				: undefined;

		// 4. 未命中 → AI 审核（关闭时一律转人工确认）
		if (!cfg.aiReview) {
			return humanReview(ctx, command, segments, "ai", null, hitLabel ?? "AI 审核已关闭（aiReview=false），未命中名单的命令由你确认");
		}
		// 逐段记忆命中情况：有命中段时随命令一起标注给 AI——命中段视为用户预先认可，
		// AI 聚焦未命中段审核，避免对已记住的部分重复审查/误判
		const hitNow = Date.now();
		const segHits = segments
			.map((s) => remembered.find((w) => w.re.test(s)))
			.filter((w): w is NonNullable<typeof w> => !!w);
		for (const h of segHits) touchRemembered(h.rule, hitNow);
		const segInfo = segHits.length > 0
			? segments
					.map((s) => {
						const hit = remembered.find((w) => w.re.test(s));
						return `- [${hit ? `已记住：${hit.rule.intent}` : "未命中"}] ${truncateCmd(s, 120).replace(/\n/g, " ⏎ ")}`;
					})
					.join("\n")
			: "";
		let verdict = aiCache.get(command) ?? null;
		let failure = "";
		if (!verdict) {
			const chain = resolveReviewModel(ctx);
			if (chain.model) {
			const r = await aiReview(ctx, command, chain, segInfo, Boolean(hitLabel));
				verdict = r.verdict;
				failure = r.error;
			} else {
				failure = "没有已认证的可用模型";
			}
			// allow / reject 可缓存（review 不缓存：每次都该由人决定）
			if (verdict && verdict.action !== "review") aiCache.set(command, verdict);
		}
		if (!verdict) {
			return humanReview(
				ctx,
				command,
				segments,
				"degraded",
				null,
				hitLabel ?? `AI 审核暂不可用（${failure || "未知原因"}）`,
			);
		}
		if (verdict.action === "review") {
			return humanReview(ctx, command, segments, hitLabel ? "watch" : "ai", verdict, hitLabel);
		}
		if (verdict.action === "reject") {
			return {
				block: true,
				reason:
					`secure：AI 判定这条命令危险，已拒绝${verdict.intent ? `（意图：${verdict.intent}）` : ""}：${verdict.reason || "命令被判定为危险"}
` +
					`请换更安全的方式，或先向用户说明风险再试。`,
			};
		}
		// allow：把「这类操作」写进记忆（意图缓存），以后同类命令零审核成本
		rememberIntent(ctx, command, segments, decideRememberedPattern(command, segments, verdict), verdict.intent);
		return undefined;
	});


	/* ---------- 凭据中转：secret_exec / secret_list / secret_prompt ---------- */

	/** 本会话的凭证库（懒建，scope 在 session_start 时确定） */
	let vault: Vault | undefined;
	const vaultOf = (): Vault => {
		if (!vault) vault = vaultFor(vaultScope);
		return vault;
	};

	/** 把已知值回遮成占位符：只替换本次实际注入过的值，不靠猜测 */
	function maskUsed(text: string, used: string[]): string {
		if (used.length === 0) return text;
		const known = used.map((name) => ({ name, value: vaultOf().get(name) ?? "" })).filter((e) => e.value.length > 0);
		return maskKnown(text, known).text;
	}

	pi.registerTool({
		name: "secret_exec",
		annotations: { readOnlyHint: false },
		label: "用凭据执行命令",
		description:
			"执行 shell 命令，命令里的 {{sec:名字}} 在执行的瞬间换成真值（经环境变量，不进命令行参数）。" +
			"真值不会进入对话；结果里若出现本次用到的真值，会被替换成 «已隐藏:名字»。" +
			"凭证在会话内有效：用户退出 pi 后旧名字会失效，需要重新向用户要（同名复用，命令不用改）。" +
			"先调用 secret_list 看有哪些可用的，没有需要的就问用户（secret_prompt）。" +
			"不要试图把凭证打印出来看：你看不到它，也不需要看到。",
		promptSnippet: "中文用途：secret_exec(command) → 用本会话凭证执行，{{sec:名字}} 在执行瞬间展开",
		parameters: Type.Object({
			command: Type.String({ description: "要执行的 shell 命令；凭证处写 {{sec:名字}}" }),
			timeout: Type.Optional(Type.Integer({ description: "超时秒数，默认 120，上限 600", minimum: 1 })),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const raw = String(params.command ?? "").trim();
			if (!raw) return toolError("命令为空。");
			if (isCodemodeCall(toolCallId)) return toolError("secret_exec 需要交互式会话，不能在 codemode 脚本里调用。请直接调用。");

			const expanded = expandRefs(raw, (name) => vaultOf().get(name));
			if (expanded.missing.length > 0) {
				// 绝大多数缺失是「上次会话录的，本次已失效」——说清这一点，别让它读成名字拼错
				return toolError(
					`这些凭据在本会话已失效：${expanded.missing.join("、")}。
` +
						`凭据只在会话内有效，退出 pi 后需要用户重新提供。
` +
						`接下来：先 secret_list 看本会话还有哪些可用；没有需要的就用 secret_prompt 请用户重新提供。
` +
						`用户重新提供同一个值会自动沿用原来的名字，已有的命令不必改。`,
				);
			}
			if (expanded.used.length === 0) {
				return toolError("命令里没有 {{sec:名字}} 引用，不需要用 secret_exec——直接用 bash 即可。");
			}

			// 引用名 → 环境变量，子进程用 $PI_SEC_x 取值；真值不进 argv
			const env: NodeJS.ProcessEnv = {};
			for (const name of expanded.used) env[`PI_SEC_${name}`] = vaultOf().get(name)!;
			const executable = expanded.text.replace(/\{\{sec:[^}]*\}\}/g, "{{sec:缺失}}");

			const timeoutMs = Math.min(Math.max((params.timeout ?? 120) * 1000, 1_000), 600_000);
			setWaiting(`执行（用 ${expanded.used.length} 个凭据）`);
			let r: RunResult;
			try {
				r = await runCommand(executable, { cwd: ctx.cwd, timeoutMs, signal, env });
			} finally {
				setWaiting(null);
			}

			const parts: string[] = [];
			if (r.fatal) return toolError(`执行失败：${r.fatal}`);
			if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
			if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
			if (!r.stdout.trim() && !r.stderr.trim()) parts.push("（无输出）");
			if (r.timedOut) parts.push("（命令超时，已被终止）");
			if (r.truncated) parts.push("（输出过长已截断）");
			parts.push(`exit code: ${r.code ?? "未知"}`);

			// 回遮：本次注入过的真值若出现在结果里，换成占位符
			const text = maskUsed(parts.join("\n\n"), expanded.used);
			return { content: [{ type: "text" as const, text }], isError: r.code !== 0, details: { used: expanded.used } };
		},
	});

	pi.registerTool({
		name: "secret_list",
		annotations: { readOnlyHint: true },
		label: "列出可用凭据名",
		description: "列出本会话已录入的凭据名字与长度。不含值，也不要向用户索要值。",
		promptSnippet: "中文用途：secret_list() → 本会话可用的 {{sec:名字}} 清单（不含值）",
		parameters: Type.Object({}),
		outputSchema: Type.Object({
			count: Type.Integer({ description: "凭据条数" }),
			entries: Type.Array(
				Type.Object({
					name: Type.String({ description: "凭据名（引用时写 {{sec:名字}}）" }),
					label: Type.Optional(Type.String({ description: "用途标签" })),
					length: Type.Integer({ description: "值的字符数（不含值本身）" }),
				}),
			),
		}),
		async execute() {
			const entries = vaultOf().list();
			const structured = {
				count: entries.length,
				entries: entries.map((e) => ({ name: e.name, ...(e.label ? { label: e.label } : {}), length: e.length })),
			};
			if (entries.length === 0) {
				return toolText(
					"本会话还没有可用凭据（历史凭据在会话结束后失效）。\n" +
						"需要凭证时用 secret_prompt 请用户提供；用户也会主动粘贴，届时会提示是否收录。",
					{ entries },
					structured,
				);
			}
			const lines = entries.map((e) => `· ${refFor(e.name)}（${e.length} 字符${e.label ? `，${e.label}` : ""}）`);
			return toolText(`本会话可用凭据：\n${lines.join("\n")}`, { entries }, structured);
		},
	});

	pi.registerTool({
		name: "secret_prompt",
		annotations: { readOnlyHint: false },
		label: "向用户索要凭据",
		description:
			"弹一个掩码输入框请用户录入凭据或敏感文本。值直接进入本会话的库，调用方只拿到名字，永远拿不到值。" +
			"用户取消时返回失败，此时不要再重复索要。",
		promptSnippet: "中文用途：secret_prompt(name, why) → 请用户掩码录入，返回可引用的 {{sec:名字}}",
		parameters: Type.Object({
			name: Type.String({ description: "给这个凭据起的名字：字母开头，可含字母数字与 . _ -" }),
			why: Type.String({ description: "一句话说明用途，会显示给用户看（不要写值本身）" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (isCodemodeCall(toolCallId)) {
				return toolError("secret_prompt 需要用户在掩码框里录入，不能在 codemode 脚本里调用。请直接调用本工具。");
			}
			const name = String(params.name ?? "").trim();
			const why = String(params.why ?? "").trim();
			if (!isValidName(name)) {
				return toolError(`名字不合法：只能用字母开头，可含字母数字与 . _ -（收到「${name}」）`);
			}
			if (vaultOf().has(name)) {
				return toolError(`{{sec:${name}}} 本会话已有值，直接用它即可；要换值请在 /secure 面板里重新录入。`);
			}
			setWaiting(`等你录入凭据：${name}`);
			let value: string | null;
			try {
				value = (await ctx.ui.input(`录入 ${name}（${why.slice(0, 60)}）`, "值不会进入对话，只保存在本会话内存")) ?? null;
			} catch {
				value = null;
			} finally {
				setWaiting(null);
			}
			if (!value) return toolError("用户取消了录入。不要重复索要，除非用户主动要求。");
			vaultOf().add({ name, value, kind: "secret", label: why.slice(0, 80) });
			return toolText(`已录入 {{sec:${name}}}（${value.length} 字符）。用 secret_exec 引用它。`, { name, length: value.length });
		},
	});

	/* ---------- /secure-config：配置面板（AI 审核 / 模型 / 超时 / sudo / 名单） ---------- */
	pi.registerCommand("secure-config", {
		description: "安全配置：AI 审核·sudo·名单；aiReview|sudo、model 可直设",
		handler: async (args, ctx) => {
			const raw = args.trim();
			const [key, ...rest] = raw.split(/\s+/);
			const value = rest.join(" ").trim();
			const summary = [
				`secure 配置（${CONFIG_FILE}）`,
				`· AI 审核：${cfg.aiReview ? "开" : "关"}`,
				`· 审核模型：${reviewModelSetting.getLocal() === LOCAL_AUTO ? "auto（由 model-config 管理）" : reviewModelSetting.getLocal()}`,
				`· sudo 授权通道：${cfg.sudoExec ? "开" : "关"}`,
				`· 硬拒绝名单：${cfg.deny.length} 条 ｜ 关注项名单：${cfg.watch.length} 条`,
			].join("\n");

			if (!raw) {
				if (!ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify(summary, "info");
					return;
				}
				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) =>
						new SecureConfigOverlay(
							tui,
							theme,
							ctx,
							{ cfg, persist: () => saveConfig(), reviewModel: reviewModelSetting },
							done,
						),
					{ overlay: true, overlayOptions: { width: "76%", minWidth: 68, maxHeight: "80%" } },
				);
				return;
			}

			if (key === "aiReview" || key === "sudo") {
				if (value !== "on" && value !== "off") {
					ctx.ui.notify(`用法：/secure-config ${key} on|off`, "warning");
					return;
				}
				if (key === "aiReview") cfg.aiReview = value === "on";
				else cfg.sudoExec = value === "on";
				saveConfig();
				ctx.ui.notify(`secure ${key === "aiReview" ? "AI 审核" : "sudo 授权通道"}：${value}（已持久化）`, "info");
				return;
			}
			if (key === "model") {
				const r = resolveSettingArg(ctx, value);
				if ("error" in r) {
					ctx.ui.notify(`secure：${r.error}。用法：/secure-config model <auto|provider/modelId>`, "error");
					return;
				}
				reviewModelSetting.setLocal(r.value);
				ctx.ui.notify(
					`secure 审核模型：${r.value === LOCAL_AUTO ? "auto（由 model-config 管理）" : r.value}（已持久化）`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				"用法：/secure-config（面板）｜ aiReview on|off ｜ sudo on|off ｜ model <auto|provider/modelId>",
				"warning",
			);
		},
	});

	// /secure 主命令：状态查看 / 开关 / 重读配置 / 清理记忆（配置项与名单在 /secure-config）
	pi.registerCommand("secure", {
		description: "安全控制：凭据面板与审核状态（on|off/sudo/reload）",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			// 无参 + TUI：打开凭据面板（看/新增/删除）。子命令与状态文本仍走下面。
			if (sub === "" && ctx.hasUI && ctx.mode === "tui") {
				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) =>
						new CredPanel(tui, theme, {
							entries: () => vaultOf().list(),
							add: ({ name, label, value }) => {
								if (!isValidName(name)) return "名字不合法";
								if (vaultOf().has(name)) return `已有 {{sec:${name}}}`;
								vaultOf().add({ name, value, kind: "secret", ...(label ? { label } : {}) });
								pushCredStatus(ctx);
								return null;
							},
							remove: (name) => {
								const ok = vaultOf().remove(name);
								pushCredStatus(ctx);
								return ok;
							},
						}, done),
					{ overlay: true, overlayOptions: { width: "80%", minWidth: 64, maxHeight: "80%" } },
				);
				return;
			}
			// 未知子命令不静默当「查状态」——拼错时给用法，避免用户以为已生效
			const KNOWN_SUBS = new Set(["", "on", "off", "sudo on", "sudo off", "reload", "prune"]);
			if (!KNOWN_SUBS.has(sub)) {
				ctx.ui.notify(
					`secure：未知子命令「${args.trim()}」\n用法：/secure（查看状态）｜ on ｜ off ｜ sudo on|off ｜ reload ｜ prune\n配置项与名单：/secure-config`,
					"warning",
				);
				return;
			}
			if (sub === "on" || sub === "off") {
				cfg.enabled = sub === "on";
				saveConfig();
				ctx.ui.notify(`secure 已${cfg.enabled ? "开启" : "关闭"}（已持久化）`, "info");
				return;
			}
			if (sub === "sudo on" || sub === "sudo off") {
				cfg.sudoExec = sub === "sudo on";
				saveConfig();
				ctx.ui.notify(`secure sudo 授权通道已${cfg.sudoExec ? "开启" : "关闭"}（已持久化）`, "info");
				return;
			}
			if (sub === "reload") {
				cfg = loadConfig().cfg;
				aiCache.clear();
				ctx.ui.notify("secure 配置已重读", "info");
				return;
			}
			if (sub === "prune") {
				const pruned = pruneRemembered();
				if (pruned > 0) saveConfig();
				ctx.ui.notify(
					`secure：已清理 ${pruned} 条超过 ${REMEMBER_EXPIRE_DAYS} 天未命中的记忆，剩 ${cfg.remembered.length} 条`,
					"info",
				);
				return;
			}
			const invalid: string[] = [];
			compilePatterns(cfg.deny, invalid);
			compilePatterns(cfg.watch, invalid);
			compileRemembered(invalid);
			maybePersistRemembered(); // 查询前落盘未持久化的命中刷新
			const expiredCut = Date.now() - REMEMBER_EXPIRE_DAYS * 86_400_000;
			const expired = cfg.remembered.filter((r) => r.lastHit < expiredCut).length;
			ctx.ui.notify(
				[
					`secure ${cfg.enabled ? "✅ 开启" : "❌ 关闭"}（AI 审核 ${cfg.aiReview ? "开" : "关"}）`,
					`本会话凭据：${vaultOf().size()} 条${vaultOf().size() > 0 ? `（${vaultOf().list().map((e) => e.name).slice(0, 8).join("、")}${vaultOf().size() > 8 ? " …" : ""}）` : ""}`,
					`审核模型：${reviewModelSetting.getLocal() === LOCAL_AUTO ? "auto（由 model-config 管理）" : reviewModelSetting.getLocal()}`,
					`sudo 授权通道：${cfg.sudoExec ? "开（密码即授权，仅当次有效）" : "关"}`,
					`已记住的操作 ${cfg.remembered.length} 条${expired ? `（${expired} 条超过 ${REMEMBER_EXPIRE_DAYS} 天未命中（仍生效），/secure prune 清理）` : ""} ／ 关注项 ${cfg.watch.length} 条（只提高审核严格度） ／ 硬拒绝 ${cfg.deny.length} 条`,
					invalid.length ? `⚠️ 无效正则 ${invalid.length} 条：${invalid.slice(0, 3).join("、")}${invalid.length > 3 ? ` 等 ${invalid.length} 条` : ""}（编辑 ${CONFIG_FILE} 修复）` : "",
					`配置文件：${CONFIG_FILE}`,
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});
}
