/**
 * perm-gate：bash 命令权限门
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
 * 配置：~/.pi/agent/perm-gate.json（手动编辑；AI 允许的意图会自动写回）
 *   {
 *     "enabled": true,                          // 总开关
 *     "deny": ["\\brm\\s+-rf\\s+/(\\s|$)"],        // 硬拒绝正则（命中即拒，不询问）
 *     "watch": ["\\bdws\\s+chat\\s+send\\b"],      // 关注项正则（只提高审核严格度）
 *     "remembered": [{ "pattern": "...", "intent": "...", ... }],  // 已记住的操作
 *     "aiReview": true, "aiTimeoutMs": 15000, "sudoExec": true, "model": null,
 *   }
 *   旧配置（blacklist/whitelist）自动迁移：blacklist → watch，whitelist → remembered。
 *
 * 命令：/perm-gate 查看状态；on|off 开关；reload 重读配置；sudo on|off；prune 清理过期记忆；
 *       model 打开官方模型选择面板（shared/model-selector），model <provider>/<id>|auto 直接设置。
 * AI 审核进度经官方 setStatus 通道推「perm-gate」状态（含最长耗时与超时降级说明），由 hud 行 1 显示。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { loadJsonConfig, saveJsonConfig } from "./shared/config";
import { choiceKey, createBoxRenderer, dividerScrollNote, editInput, keyHintRow, renderChoiceList, renderScrollingInput, scrollByPage, wrapIndented } from "./shared/ui";
import { pickAuxModel, type AnyModel } from "./shared/model-pick";
import { pickModelViaSelector } from "./shared/model-selector";
import { splitShellSegments } from "./shared/shell-split";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 配置文件路径（~/.pi/agent/perm-gate.json） */
const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "perm-gate.json");

/** AI 审核优先选用的模型（provider/modelId）；不可用时自动选最便宜已认证模型 */
const PREFERRED_MODELS: Array<[string, string]> = [["deepseek", "deepseek-v4-flash"]];

/** 喂给 AI 审核的命令最大字符数（超出截断） */
const AI_CMD_MAX_CHARS = 4_000;

/** 记忆规则的保鲜期（天）：超过未命中自动清理（防无限膨胀；过期未清理前仍生效） */
const REMEMBER_EXPIRE_DAYS = 30;

/** 已记住的操作（意图缓存）：记忆保鲜期同 WHITELIST_EXPIRE_DAYS，过期自动清理 */
interface RememberedRule {
	pattern: string;
	/** 人类可读的操作意图（面板/通知展示；旧数据缺失时回落 pattern） */
	intent: string;
	addedAt: number;
	lastHit: number;
	hits: number;
}

interface PermGateConfig {
	enabled: boolean;
	/** 硬拒绝：命中即拒且不询问（只在「绝不执行」时加） */
	deny: string[];
	/** 关注项：命中只提高 AI 审核严格度，不打断用户 */
	watch: string[];
	/** 已记住的操作（意图缓存）：命中即放行 */
	remembered: RememberedRule[];
	aiReview: boolean;
	aiTimeoutMs: number;
	/** sudo 授权通道（sudo_exec 工具）开关；关 = sudo 命令退回名单审核流程 */
	sudoExec: boolean;
	/** AI 审核模型覆盖项（"provider/modelId"；null = 自动：优先列表 + 最便宜已认证兜底） */
	model: string | null;
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
const DEFAULT_CONFIG: PermGateConfig = {
	enabled: true,
	deny: DEFAULT_DENY,
	watch: DEFAULT_WATCH,
	remembered: [],
	aiReview: true,
	aiTimeoutMs: 15_000,
	sudoExec: true,
	model: null,
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

/** 配置校验：新旧格式都接受（新：deny/watch/remembered；旧：blacklist/whitelist），迁移在 loadConfig 里做 */
function isConfig(v: unknown): v is PermGateConfig {
	const c = v as Partial<PermGateConfig> & { blacklist?: unknown; whitelist?: unknown } | null;
	const okList = (x: unknown) => x === undefined || (Array.isArray(x) && x.every((s) => typeof s === "string"));
	const okRules = (x: unknown) =>
		x === undefined ||
		(Array.isArray(x) &&
			x.every(
				(r) =>
					typeof r === "string" ||
					(typeof r === "object" && r !== null && typeof (r as { pattern?: unknown }).pattern === "string"),
			));
	return (
		!!c &&
		typeof c === "object" &&
		typeof c.enabled === "boolean" &&
		okList(c.deny) &&
		okList(c.watch) &&
		okRules(c.remembered) &&
		// 旧格式字段
		okList(c.blacklist) &&
		okRules(c.whitelist) &&
		typeof c.aiReview === "boolean" &&
		typeof c.aiTimeoutMs === "number" &&
		// model / sudoExec 为后加字段：旧配置缺失时容错（model 缺省 null = 自动，sudoExec 缺省 true）
		(c.model === undefined || c.model === null || typeof c.model === "string") &&
		(c.sudoExec === undefined || typeof c.sudoExec === "boolean")
	);
}

/** 旧格式兼容：string[] 或带字段的对象 → RememberedRule[]（缺字段补默认，非法项跳过） */
function toRememberedRules(list: unknown, now = Date.now()): RememberedRule[] {
	if (!Array.isArray(list)) return [];
	const out: RememberedRule[] = [];
	for (const item of list) {
		if (typeof item === "string") {
			if (item) out.push({ pattern: item, intent: item, addedAt: now, lastHit: now, hits: 0 });
		} else if (item && typeof item === "object") {
			const r = item as Partial<RememberedRule>;
			if (typeof r.pattern === "string" && r.pattern) {
				out.push({
					pattern: r.pattern,
					intent: typeof r.intent === "string" && r.intent ? r.intent : r.pattern,
					addedAt: typeof r.addedAt === "number" ? r.addedAt : now,
					lastHit: typeof r.lastHit === "number" ? r.lastHit : now,
					hits: typeof r.hits === "number" ? r.hits : 0,
				});
			}
		}
	}
	return out;
}

function loadConfig(): { cfg: PermGateConfig; isNew: boolean } {
	// 文件不存在视为新建：顺手写一份默认配置，方便用户手动编辑
	let isNew = false;
	try {
		isNew = !fs.existsSync(CONFIG_FILE);
	} catch {
		/* 忽略 */
	}
	const raw = loadJsonConfig(CONFIG_FILE, structuredClone(DEFAULT_CONFIG), isConfig) as PermGateConfig & {
		blacklist?: unknown;
		whitelist?: unknown;
	};
	const cfg: PermGateConfig = {
		enabled: raw.enabled,
		// 新字段缺失（旧配置）→ 默认；旧 blacklist/whitelist → watch/remembered
		deny: Array.isArray(raw.deny) ? raw.deny : structuredClone(DEFAULT_DENY),
		watch: Array.isArray(raw.watch) ? raw.watch : Array.isArray(raw.blacklist) ? (raw.blacklist as string[]) : structuredClone(DEFAULT_WATCH),
		remembered: toRememberedRules(Array.isArray(raw.remembered) ? raw.remembered : raw.whitelist),
		aiReview: raw.aiReview,
		aiTimeoutMs: raw.aiTimeoutMs,
		sudoExec: raw.sudoExec ?? true,
		model: raw.model ?? null,
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
 * 调辅助小模型审核命令；失败（超时/无模型/网络错误/输出无法解析）返回 null（调用方降级人工确认）。
 * segInfo 为逐段记忆命中标注；watched=true 表示命中关注项，要求 AI 从严判断（宁可 review 不 allow）。
 */
async function aiReview(
	ctx: ExtensionContext,
	command: string,
	timeoutMs: number,
	model: AnyModel,
	segInfo = "",
	watched = false,
): Promise<Verdict | null> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return null;

	const truncated = command.length > AI_CMD_MAX_CHARS ? command.slice(0, AI_CMD_MAX_CHARS) + "\n…(已截断)" : command;
	const prompt =
		`工作目录：${ctx.cwd}\n\n待审核命令：\n${truncated}` +
		(segInfo ? `\n\n拆段分析（[已记住] = 用户预先认可，可信；重点审核 [未命中] 段落）：\n${segInfo}` : "") +
		(watched ? "\n\n【关注项】：该命令命中了用户标记为需要留意的类别，请从严判断——宁可 review，不要 allow。" : "");
	const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];

	ctx.ui.setStatus("perm-gate", `🛡 正在审核命令…（≤${Math.round(timeoutMs / 1000)} 秒）`);
	try {
		const result = await completeSimple(
			model,
			{ systemPrompt: AI_SYSTEM_PROMPT, messages },
			{
				apiKey: auth.apiKey,
				headers: { ...auth.headers },
				maxTokens: 500, // reason + impact + pattern 三件事需要额外输出空间
				temperature: 0,
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		const text = result.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { type: "text"; text: string }).text)
			.join("")
			.trim();
		const m = text.match(/\{[\s\S]*\}/);
		if (!m) return null;
		const parsed = JSON.parse(m[0]) as Partial<Verdict>;
		if (parsed.action !== "allow" && parsed.action !== "review" && parsed.action !== "reject") return null;
		const impact = Array.isArray(parsed.impact)
			? parsed.impact.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 4)
			: [];
		return {
			action: parsed.action,
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			intent: typeof parsed.intent === "string" ? parsed.intent : "",
			impact,
			pattern: typeof parsed.pattern === "string" ? parsed.pattern : "",
		};
	} catch {
		return null;
	} finally {
		ctx.ui.setStatus("perm-gate", undefined);
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
		const { row, topBorder, bottomBorder, border } = createBoxRenderer(th, Math.max(10, width - 2));
		const innerW = Math.max(10, width - 2);
		const actions = this.actions();

		// 上部：人话信息区（不参与滚动，任何情况下都看得见）
		const head: string[] = [];
		const wrap = (s: string): string[] => wrapTextWithAnsi(s, Math.max(8, innerW - 1));
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
				actions,
				this.idx,
				actions.map((_, i) => (i === 1 && this.info.canRemember ? this.info.intent : undefined)),
			).map((l) => row(l)),
		);
		lines.push(
			row(keyHintRow(th, `↑↓ 选择 · Enter 确认 · 1-${actions.length} 直选 · PgUp/PgDn 滚动命令 · Esc 拒绝（不执行）`)),
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

/** sudo 认证失败输出特征（密码错误 / 未喂到密码）：命中可原地换密码重试 */
const SUDO_AUTH_FAIL_RE =
	/sorry, try again|incorrect password|authentication failure|a password is required|no password was provided/i;

/** sudoers 开了 requiretty 时 -S 也无法供密，只能请用户手动执行 */
const SUDO_REQUIRETTY_RE = /must have a tty|requires a tty|requiretty/i;

/** 单方向输出捕获上限（防失控输出撑爆内存与上下文） */
const SUDO_OUTPUT_CAP = 64_000;

/** 单次调用的密码尝试上限（浮层内原地重试，不占 AI 回合） */
const SUDO_MAX_ATTEMPTS = 3;

/** sudo 授权执行结果（密码绝不进结果文本） */
interface SudoRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** 认证类失败（可换密码重试） */
	authFailed: boolean;
	/** sudo 本体不可用（未安装 / requiretty / 启动失败）：重试无意义 */
	fatal: string | null;
	timedOut: boolean;
	truncated: boolean;
}

/**
 * 执行一次 sudo 提权命令：密码经管道喂给 sudo 的 stdin（-S），不落盘、不进命令行参数。
 * -k 关键语义：忽略且不更新凭据缓存——每次授权天然仅当次有效，下次调用必重新弹窗；
 * 收尾再补一发 sudo -k 双保险（兼容不遵守该语义的老 sudo）。
 * password=null 走免密路径（-n，NOPASSWD 账户）。
 */
function runSudoCommand(
	command: string,
	password: string | null,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<SudoRunResult> {
	return new Promise((resolve) => {
		const args =
			password == null
				? ["-kn", "--", "bash", "-c", command]
				: ["-kS", "-p", "", "--", "bash", "-c", command];
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("sudo", args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch (e) {
			resolve({
				code: null,
				stdout: "",
				stderr: "",
				authFailed: false,
				fatal: `sudo 启动失败：${e instanceof Error ? e.message : String(e)}`,
				timedOut: false,
				truncated: false,
			});
			return;
		}
		let stdout = "";
		let stderr = "";
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const onAbort = (): void => {
			child.kill("SIGTERM");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.();
		}, timeoutMs);
		const finish = (r: Omit<SudoRunResult, "truncated">): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...r, truncated });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (d: Buffer) => {
			if (stdout.length < SUDO_OUTPUT_CAP) stdout += d.toString("utf8");
			else truncated = true;
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < SUDO_OUTPUT_CAP) stderr += d.toString("utf8");
			else truncated = true;
		});
		child.on("error", (e) =>
			finish({
				code: null,
				stdout,
				stderr,
				authFailed: false,
				fatal: `sudo 不可用：${e.message}（目标机可能未安装 sudo）`,
				timedOut,
			}),
		);
		child.on("close", (code) => {
			// 双保险：作废可能残留的凭据缓存（不等结果，尽力而为）
			if (password != null) {
				try {
					spawn("sudo", ["-k"], { stdio: "ignore" }).on("error", () => {});
				} catch {
					/* 忽略 */
				}
			}
			if (SUDO_REQUIRETTY_RE.test(stderr)) {
				finish({
					code,
					stdout,
					stderr,
					authFailed: false,
					fatal: "目标机 sudoers 配置了 requiretty，非交互通道无法供密，只能请用户手动执行",
					timedOut,
				});
				return;
			}
			const authFailed = password != null && code !== 0 && SUDO_AUTH_FAIL_RE.test(stderr);
			finish({ code, stdout, stderr, authFailed, fatal: null, timedOut });
		});
		// 喂密码：只经管道进 sudo 的 stdin，不进会话历史 / 工具结果 / 磁盘
		if (password != null && child.stdin) {
			child.stdin.on("error", () => {}); // EPIPE（sudo 提前退出）静默
			child.stdin.write(`${password}\n`);
		}
		child.stdin?.end();
	});
}

/** 免密判定：sudo -kn true 成功 = NOPASSWD 账户（-k 忽略既有凭据缓存，防止用户终端的缓存造成误判） */
function checkSudoNopasswd(): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("sudo", ["-kn", "true"], { stdio: "ignore" });
		} catch {
			resolve(false);
			return;
		}
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}

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
	let cfg: PermGateConfig;
	{
		const loaded = loadConfig();
		cfg = loaded.cfg;
		if (loaded.isNew) saveJsonConfig(CONFIG_FILE, cfg); // 首次运行写默认配置，方便用户编辑
		// 启动时清理超过保鲜期的白名单规则（历史残留不堆积）
		if (pruneRemembered() > 0) saveJsonConfig(CONFIG_FILE, cfg);
	}

	/** AI 审核结论会话级缓存（精确命令 → 结论；review 不缓存，每次都让人工决定） */
	const aiCache = new Map<string, Verdict>();

	/** 面板串行链：并行工具批里多个待复核命令依次弹面板，避免对话框互相覆盖 */
	let panelChain: Promise<unknown> = Promise.resolve();

	function saveConfig(): void {
		saveJsonConfig(CONFIG_FILE, cfg);
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
	function newRememberedRule(pattern: string, intent: string, now = Date.now()): RememberedRule {
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

	/**
	 * 解析 AI 审核模型（仿 pi-btw 覆盖项语义）：
	 * 配置了覆盖模型且可用（存在 + 已认证）→ 用覆盖模型；否则回落自动（优先列表 + 最便宜兜底）。
	 */
	function resolveReviewModel(ctx: ExtensionContext): AnyModel | undefined {
		if (cfg.model) {
			const slash = cfg.model.indexOf("/");
			const m = ctx.modelRegistry.find(cfg.model.slice(0, slash), cfg.model.slice(slash + 1));
			if (m && ctx.modelRegistry.hasConfiguredAuth(m)) return m;
		}
		return pickAuxModel(ctx, PREFERRED_MODELS);
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
		ctx.ui.notify(`perm-gate 已记住「${intent || pattern}」，以后同类命令直接放行`, "info");
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
					`perm-gate：${why}，可是当前是无界面会话、无法请你确认，已拒绝执行本条命令。
` +
					`如需执行，请在带界面的会话重试；如确认该类操作总是安全，可在 ${CONFIG_FILE} 里加入 remembered 记忆规则。`,
			};
		}
		const info = buildReviewInfo(command, verdict, source, hitLabel);
		const title =
			source === "watch" ? "⚠ 需要你确认：命中关注项" : source === "degraded" ? "⚠ 需要你确认（AI 暂不可用）" : "⚠ 需要你确认这条命令";
		// 串行化面板
		return new Promise<{ block: true; reason: string } | undefined>((resolve) => {
			panelChain = panelChain.then(async () => {
				// 登记 Working 行等待文本（status-beacon 桥，缺席静默）
				const waitApi = (globalThis as Record<string, unknown>).__PI_STATUS_BEACON_API__ as
					| { wait?: (t: string | null) => void }
					| undefined;
				waitApi?.wait?.(`确认命令：${command.trim().split("\n")[0]!.slice(0, 40)}`);
				let choice: string | null;
				try {
					choice = await ctx.ui.custom<string | null>(
						(tui, theme, _kb, done) => new ReviewPanel(tui, theme, title, command, info, done),
						{ overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "80%" } },
					);
				} finally {
					waitApi?.wait?.(null);
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
						resolve({ block: true, reason: "perm-gate：用户拒绝了该命令，未执行。请换方案，或向用户说明后再试。" });
						break;
				}
			});
		});
	}

	/** 组装 sudo 执行结果文本（绝不包含密码；认证失败不走这里，由调用方单独报错） */
	function sudoResultContent(
		command: string,
		r: SudoRunResult,
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
			return fail("perm-gate sudo 授权通道已关闭（/perm-gate sudo on 开启），无法代为执行；请改用普通命令，或请用户手动执行。");
		}
		if (!ctx.hasUI) {
			return fail(`当前无 UI，无法弹窗请求 sudo 授权。请用户手动执行：sudo bash -c '${command.replace(/'/g, "'\\''")}'`);
		}

		const waitApi = (globalThis as Record<string, unknown>).__PI_STATUS_BEACON_API__ as
			| { wait?: (t: string | null) => void }
			| undefined;
		const waitText = `sudo 授权：${command.trim().split("\n")[0]!.slice(0, 40)}`;

		// 免密账户：确认弹窗即授权（仍满足「每次调用都需用户确认」）
		if (await checkSudoNopasswd()) {
			waitApi?.wait?.(waitText);
			let ok = false;
			try {
				ok = await ctx.ui.confirm("🔐 sudo 授权（免密账户）", `AI 请求以 root 身份执行：\n${command}\n\n本次授权仅对这一次执行有效。`);
			} finally {
				waitApi?.wait?.(null);
			}
			if (!ok) return fail("用户拒绝了本次 sudo 授权，命令未执行。如需提权，请与用户确认能否换一种做法。");
			const r = await runSudoCommand(command, null, timeoutMs, signal);
			return sudoResultContent(command, r);
		}

		for (let attempt = 1; attempt <= SUDO_MAX_ATTEMPTS; attempt++) {
			waitApi?.wait?.(waitText);
			let password: string | null;
			try {
				password = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) => new SudoPanel(tui, theme, command, attempt, SUDO_MAX_ATTEMPTS, done),
					{ overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "80%" } },
				);
			} finally {
				waitApi?.wait?.(null);
			}
			if (password == null) return fail("用户拒绝了本次 sudo 授权，命令未执行。如需提权，请与用户确认能否换一种做法。");
			const r = await runSudoCommand(command, password, timeoutMs, signal);
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
		label: "sudo 提权执行",
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const command = params.command.trim();
			if (!command) {
				return { content: [{ type: "text" as const, text: "命令为空" }], isError: true, details: {} };
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
					"perm-gate：检测到 sudo 提权命令，bash 的非交互通道无法处理密码输入。" +
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
					`perm-gate：${label}命中硬拒绝规则（属于绝不自动执行的一类），已拒绝。
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
		if (!verdict) {
			const model = resolveReviewModel(ctx);
			if (model) verdict = await aiReview(ctx, command, cfg.aiTimeoutMs, model, segInfo, Boolean(hitLabel));
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
				hitLabel ?? "AI 审核暂时不可用（超时或网络问题）",
			);
		}
		if (verdict.action === "review") {
			return humanReview(ctx, command, segments, hitLabel ? "watch" : "ai", verdict, hitLabel);
		}
		if (verdict.action === "reject") {
			return {
				block: true,
				reason:
					`perm-gate：AI 判定这条命令危险，已拒绝${verdict.intent ? `（意图：${verdict.intent}）` : ""}：${verdict.reason || "命令被判定为危险"}
` +
					`请换更安全的方式，或先向用户说明风险再试。`,
			};
		}
		// allow：把「这类操作」写进记忆（意图缓存），以后同类命令零审核成本
		rememberIntent(ctx, command, segments, decideRememberedPattern(command, segments, verdict), verdict.intent);
		return undefined;
	});

	// /perm-gate 命令：状态查看 / 开关 / 重读配置 / 审核模型选择 / 清理过期白名单
	// （名单编辑走配置文件，不提供管理面板）
	pi.registerCommand("perm-gate", {
		description:
			"bash 命令权限门：查看状态 / on / off / sudo on|off / reload / model [provider/id|auto] / prune",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			// 未知子命令不静默当「查状态」——拼错时给用法，避免用户以为已生效
			const KNOWN_SUBS = new Set(["", "on", "off", "sudo on", "sudo off", "reload", "prune"]);
			if (!KNOWN_SUBS.has(sub) && sub !== "model" && !sub.startsWith("model ")) {
				ctx.ui.notify(
					`perm-gate：未知子命令「${args.trim()}」\n用法：/perm-gate（查看状态）｜ on ｜ off ｜ sudo on|off ｜ reload ｜ prune ｜ model <provider>/<modelId>|auto`,
					"warning",
				);
				return;
			}
			if (sub === "on" || sub === "off") {
				cfg.enabled = sub === "on";
				saveConfig();
				ctx.ui.notify(`perm-gate 已${cfg.enabled ? "开启" : "关闭"}（已持久化）`, "info");
				return;
			}
			if (sub === "sudo on" || sub === "sudo off") {
				cfg.sudoExec = sub === "sudo on";
				saveConfig();
				ctx.ui.notify(`perm-gate sudo 授权通道已${cfg.sudoExec ? "开启" : "关闭"}（已持久化）`, "info");
				return;
			}
			if (sub === "reload") {
				cfg = loadConfig().cfg;
				aiCache.clear();
				ctx.ui.notify("perm-gate 配置已重读", "info");
				return;
			}
			if (sub === "prune") {
				const pruned = pruneRemembered();
				if (pruned > 0) saveConfig();
				ctx.ui.notify(
					`perm-gate：已清理 ${pruned} 条超过 ${REMEMBER_EXPIRE_DAYS} 天未命中的记忆，剩 ${cfg.remembered.length} 条`,
					"info",
				);
				return;
			}
			if (sub === "model" || sub.startsWith("model ")) {
				const arg = args.trim().slice(5).trim();
				// 带参数：直接设置（仿 pi-btw 的 /btw:model，无面板）
				if (arg) {
					if (arg.toLowerCase() === "auto" || arg.toLowerCase() === "clear") {
						cfg.model = null;
					} else {
						const slash = arg.indexOf("/");
						const m = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
						if (!m) {
							ctx.ui.notify(`perm-gate：找不到模型 ${arg}（格式 provider/modelId）`, "error");
							return;
						}
						cfg.model = `${m.provider}/${m.id}`;
					}
					saveConfig();
					ctx.ui.notify(`perm-gate 审核模型：${cfg.model ?? "自动（优先列表 + 最便宜兜底）"}（已持久化）`, "info");
					return;
				}
				// 无参数：官方模型选择面板（shared/model-selector 复用 ModelSelectorComponent，与内置 /model 同组件）
				if (!ctx.hasUI) {
					ctx.ui.notify("用法：/perm-gate model <provider>/<modelId> ｜ /perm-gate model auto", "info");
					return;
				}
				const picked = await pickModelViaSelector(ctx);
				if (!picked) return; // Esc 取消
				cfg.model = `${picked.provider}/${picked.id}`;
				saveConfig();
				ctx.ui.notify(`perm-gate 审核模型：${cfg.model}（已持久化；/perm-gate model auto 恢复自动）`, "info");
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
					`perm-gate ${cfg.enabled ? "✅ 开启" : "❌ 关闭"}（AI 审核 ${cfg.aiReview ? "开" : "关"}）`,
					`审核模型：${cfg.model ?? "自动（优先列表 + 最便宜兜底）"}`,
					`sudo 授权通道：${cfg.sudoExec ? "开（密码即授权，仅当次有效）" : "关"}`,
					`已记住的操作 ${cfg.remembered.length} 条${expired ? `（${expired} 条超过 ${REMEMBER_EXPIRE_DAYS} 天未命中（仍生效），/perm-gate prune 清理）` : ""} ／ 关注项 ${cfg.watch.length} 条（只提高审核严格度） ／ 硬拒绝 ${cfg.deny.length} 条`,
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
