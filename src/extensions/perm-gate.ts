/**
 * perm-gate：bash 命令三级权限门
 *
 * 对 AI 发起的每个 bash 工具调用按名单三级管控（tool_call 事件拦截）：
 *   0. 复合命令先按 shell 语义拆段（shared/shell-split：&&/||/;/|/换行/子 shell 递归），
 *      白名单逐段判定——防止「git status && rm -rf x」被前半段白名单规则连带放行；
 *   1. 黑名单：整串或任一子命令段命中一律转人工复核，复核面板带 ⚠️ 警告（无 UI 时直接阻断）；
 *   2. 白名单：每个子命令段都命中才放行（黑名单优先于白名单，安全兜底）；
 *   3. 未命中：交给 AI 审核（辅助小模型，选模型逻辑复用 shared/model-pick，
 *      与 hud-git 同款「优先列表 + 最便宜已认证兜底」），AI 给出
 *      放行 / 人工复核 / 驳回 三类结论；AI 审核失败（超时/无模型/网络错误/
 *      输出无法解析）一律降级为人工复核。送审命令附「拆段分析」：逐段标注
 *      白名单命中情况（命中段视为用户预先认可），AI 聚焦未命中段审核，
 *      避免对白名单段落重复审查/误判。
 *
 * 人工复核面板五操作：放行一次 / 放行并加白名单 / 驳回 / 驳回并加黑名单。
 * 面板为自绘 overlay（ReviewPanel）：命令**全文折行展示不截断**（PgUp/PgDn 滚动，
 * 滚动余量在分隔行指示），↑↓ 选操作、Enter 确认、1-5 直选、Esc=驳回。
 * AI 判 allow 后自动加白：采纳 AI 提炼的单条语义白名单正则（whitelistPattern，AI 按语义自选粒度），
 * 缺失/跑偏退结构化兜底规则（^命令\s+子命令），最后才落精确段规则；
 * 常用无害命令只在首次烧一次审核 token；每次自动加白发通知（展示 AI 概括的命令意图而非规则原文），透明可查。
 * AI 审核为「需复核」时会同时提炼指令核心特征为 1~3 个候选正则（附说明、从窄到宽），
 * 加白/加黑时弹多选面板选用（空格勾选/Enter 提交，可多选；附「精确匹配原文」兜底项——
 * 只认一模一样的命令，同类变体仍需再审；Esc 或空选提交 = 不加名单只执行本次操作）；
 * 无候选时直接用精确匹配。
 * 并行工具批里多个待复核命令经 Promise 链串行弹面板，避免对话框打架。
 *
 * 配置：~/.pi/agent/perm-gate.json（手动编辑；面板「加名单」也会写回）
 *   {
 *     "enabled": true,                // 总开关
 *     "blacklist": ["\\bsudo\\b"],     // 正则字符串列表
 *     "whitelist": ["^git status$"],   // 正则字符串列表
 *     "aiReview": true,               // 未命中名单时是否启用 AI 审核（false = 一律转人工）
 *     "aiTimeoutMs": 15000             // AI 审核超时
 *   }
 *
 * 命令：/perm-gate 查看状态；/perm-gate on|off 开关（持久化）；/perm-gate reload 重读配置；
 *       /perm-gate model 打开官方模型选择面板（shared/model-selector 复用 ModelSelectorComponent，
 *       与内置 /model 同组件），/perm-gate model <provider>/<id>|auto 直接设置（仿 pi-btw 覆盖项）。
 * AI 审核进度经官方 setStatus 通道推「perm-gate」状态，由 hud 行 1 动态区显示。
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
import { loadJsonConfig, saveJsonConfig } from "./shared/config";
import { createBoxRenderer } from "./shared/ui";
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

/** 白名单规则保鲜期（天）：超过未命中自动清理（防无限膨胀） */
const WHITELIST_EXPIRE_DAYS = 30;

/**
 * 白名单规则（带保鲜元数据，防无限膨胀）：
 * - addedAt / lastHit：加白时刻 / 最近一次命中时刻（保鲜依据）
 * - hits：历史命中次数（/perm-gate 可查）
 * - 超过 WHITELIST_EXPIRE_DAYS 未命中的规则在启动/加白时自动清理，/perm-gate prune 手动清理
 */
interface WhitelistRule {
	pattern: string;
	addedAt: number;
	lastHit: number;
	hits: number;
}

interface PermGateConfig {
	enabled: boolean;
	blacklist: string[];
	whitelist: WhitelistRule[];
	aiReview: boolean;
	aiTimeoutMs: number;
	/** AI 审核模型覆盖项（"provider/modelId"；null = 自动：优先列表 + 最便宜已认证兜底） */
	model: string | null;
}

/** 默认配置（首次运行写入，用户可手动编辑） */
const DEFAULT_CONFIG: PermGateConfig = {
	enabled: true,
	blacklist: [
		"\\bdws\\s+chat\\s+send\\b", // dws 发送消息拦截
	],
	whitelist: [],
	aiReview: true,
	aiTimeoutMs: 15_000,
	model: null,
};

/** AI 提炼的候选名单规则（正则 + 说明） */
interface Candidate {
	pattern: string;
	note: string;
}

/** AI 审核结论 */
interface Verdict {
	action: "allow" | "review" | "reject";
	reason: string;
	/** 命令意图的一句话概括（自动加白通知展示用；AI 可能漏给，兜底空串） */
	intent: string;
	/** action=allow 时提炼的单条语义白名单正则（自动加白用；空串 = 无法泛化，退结构化兜底） */
	whitelistPattern: string;
	/** action=review 时提炼的候选正则（人工面板选粒度用；可能为空，回落精确匹配） */
	candidates: Candidate[];
}

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

function isConfig(v: unknown): v is PermGateConfig {
	const c = v as Partial<PermGateConfig> | null;
	return (
		!!c &&
		typeof c === "object" &&
		typeof c.enabled === "boolean" &&
		Array.isArray(c.blacklist) &&
		c.blacklist.every((s) => typeof s === "string") &&
		Array.isArray(c.whitelist) &&
		// 兼容旧格式纯字符串列表（toWhitelistRules 归一化）；新格式为带保鲜元数据的对象
		c.whitelist.every(
			(r) =>
				typeof r === "string" || (typeof r === "object" && r !== null && typeof r.pattern === "string"),
		) &&
		typeof c.aiReview === "boolean" &&
		typeof c.aiTimeoutMs === "number" &&
		// model 为后加字段：旧配置缺失时容错（缺省 null = 自动），避免校验不过回默认丢名单
		(c.model === undefined || c.model === null || typeof c.model === "string")
	);
}

/** 旧格式兼容：string[] 或带字段的对象 → WhitelistRule[]（缺字段补默认，非法项跳过） */
function toWhitelistRules(list: unknown, now = Date.now()): WhitelistRule[] {
	if (!Array.isArray(list)) return [];
	const out: WhitelistRule[] = [];
	for (const item of list) {
		if (typeof item === "string") {
			if (item) out.push({ pattern: item, addedAt: now, lastHit: now, hits: 0 });
		} else if (item && typeof item === "object") {
			const r = item as Partial<WhitelistRule>;
			if (typeof r.pattern === "string" && r.pattern) {
				out.push({
					pattern: r.pattern,
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
	const cfg = loadJsonConfig(CONFIG_FILE, structuredClone(DEFAULT_CONFIG), isConfig);
	cfg.model ??= null; // 旧配置无该字段时归一化
	cfg.whitelist = toWhitelistRules(cfg.whitelist); // 旧纯字符串列表归一化为带保鲜元数据
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

/** 送审摘要用：截断过长文本（仅 AI 侧 segInfo，人看的面板一律全文折行） */
function truncateCmd(command: string, max: number): string {
	return command.length > max ? command.slice(0, max) + "\n…(已截断)" : command;
}

/**
 * 精炼 AI 候选正则：过滤、评分、排序、补充兜底
 *
 * AI 直出的候选常有两类毛病：
 * 1. 过窄：包含具体参数值（如 ^git push origin main --force$），几乎不可复用
 * 2. 过宽：仅旗标无命令锚定（如 --force），会误匹配无关命令
 *
 * 策略：
 * - 过滤：不可编译 / 不匹配原命令或任何段 → 淘汰
 * - 评分：命令锚定加分、子命令加分、过短扣分、纯旗标扣分
 * - 补充：无合格候选时，自动从命令结构派生兜底规则
 */
function refineCandidates(candidates: Candidate[], command: string, segments: string[]): Candidate[] {
	const scored: Array<{ c: Candidate; score: number }> = [];
	const cmdName = command.trim().split(/\s+/)[0] || "";
	const subcmd = command.trim().split(/\s+/)[1] || "";

	for (const c of candidates) {
		// 可编译性
		let re: RegExp;
		try {
			re = new RegExp(c.pattern, REGEX_FLAGS);
		} catch {
			continue;
		}
		// 必须匹配原命令或至少一个段
		if (!re.test(command) && !segments.some((s) => re.test(s))) continue;

		let score = 50;
		// 命令锚定加分
		if (/^\^/.test(c.pattern)) score += 15;
		if (/^\^[a-zA-Z]/.test(c.pattern)) score += 10;
		// 包含命令名加分
		if (cmdName && c.pattern.includes(cmdName)) score += 12;
		// 包含子命令加分
		if (subcmd && !subcmd.startsWith("-") && c.pattern.includes(subcmd)) score += 10;
		// 过短扣分（< 8 字符的模式太宽）
		if (c.pattern.length < 8) score -= 30;
		else if (c.pattern.length < 12) score -= 10;
		// 刚性精确规则扣分（$ 结尾且无 .* 通配 = 只认原文、变体不覆盖，与 smart 目标相悖）
		if (/\$$/.test(c.pattern) && !c.pattern.includes(".*")) score -= 15;
		// 仅旗标无命令名扣分
		if (cmdName && !c.pattern.includes(cmdName) && /^--?\w+/.test(c.pattern)) score -= 25;
		// 字母数字过少扣分
		if (c.pattern.replace(/[^a-zA-Z0-9]/g, "").length < 6) score -= 20;

		scored.push({ c, score });
	}

	scored.sort((a, b) => b.score - a.score);
	const refined = scored.slice(0, 3).map((s) => s.c);

	// 全部不合格 → 自动从命令结构派生兜底规则
	if (refined.length === 0) {
		refined.push(...generateFallbackPatterns(command, segments));
	}
	return refined;
}

/**
 * 从命令结构自动生成语义化兜底规则（^命令\s+子命令）
 * 用途：review 候选全部不合格时补充（refineCandidates）、allow 未给 whitelistPattern 时兜底（autoWhitelist）；
 * 精确原文规则不在此生成——人工面板有独立「精确匹配原文」兜底项，autoWhitelist 有逐段精确兜底。
 */
function generateFallbackPatterns(command: string, segments: string[]): Candidate[] {
	const patterns: Candidate[] = [];
	const src = segments.length > 0 ? segments : [command];

	for (const seg of src) {
		const parts = seg.trim().split(/\s+/);
		const cmdName = parts[0];
		if (!cmdName) continue;
		const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

		// 命令 + 子命令（如果有且不是旗标）
		if (parts.length >= 2 && !parts[1]!.startsWith("-")) {
			const subcmd = parts[1]!;
			patterns.push({
				pattern: `^${esc(cmdName)}\\s+${esc(subcmd)}`,
				note: `${cmdName} ${subcmd} 及其所有参数`,
			});
		}
	}
	return patterns.slice(0, 3);
}

// ---------------------------------------------------------------------------
// AI 审核
// ---------------------------------------------------------------------------

const AI_SYSTEM_PROMPT = [
	"你是 shell 命令安全审核员。AI 编码助手要在用户机器上执行一条 bash 命令，由你判断是否安全。",
	"你的审核标准非常宽松：只拦截明显恶意的指令，绝大多数常规开发操作都应放行。",
	"\n===== 结论 =====",
	"给出三类结论之一：",
	'- "allow"：绝大多数命令都应放行',
	'- "review"：仅当命令具有明显风险且无法判断意图时才需人工确认',
	'- "reject"：仅拦截明显恶意的指令',
	"\n===== 复合命令 =====",
	"\n===== 加白规则提炼 =====",
	"设计原则（allow 与 review 共用）：",
	"1. 命令锚定：正则必须包含命令名（如 git/npm/python/docker），优先用 ^ 锚定起始位置，防误匹配其他命令；",
	"2. 操作语义：包含子命令或关键旗标，捕获「做什么」而非「具体怎么做」；",
	"3. 适当宽松：允许参数顺序变化、路径/URL 等参数值不同、额外旗标存在；",
	"4. 避免过窄：不要包含具体文件路径、分支名、URL 等会变化的参数值；",
	"5. 避免过宽：不要只给旗标（如 --force）而不含命令名——会误匹配无关命令。",
	"\n命令可能是多行（python -c \"...\" 内嵌脚本、heredoc 等）：",
	"正则保持命令原样（不要美化成单行），跨任意内容用 .* （匹配时自动加 s 标志，可跨换行）。",
	'\n- action 为 "allow" 时：给 whitelistPattern——一条语义化白名单正则，覆盖这类操作的合理变体；',
	"  无法安全泛化时给空字符串。",
	'\n- action 为 "review" 时：给 candidates——1~3 条候选正则供人工选择加白/加黑粒度，从窄到宽：',
	"  窄：^命令\\s+子命令\\s+.*关键旗标（如 ^git\\s+push\\s+.*--force）",
	"  中：^命令\\s+子命令（如 ^git\\s+push）",
	"  宽：^命令.*关键旗标（仅当旗标是核心风险标识时）",
	'  每个候选格式：{"pattern":"JavaScript 正则（不带标志）","note":"一句话说明覆盖范围"}',
	'\n- action 为 "reject" 时：whitelistPattern 与 candidates 都不给。',
	"\n===== 命令意图概括（intent）=====",
	"用一句话概括这条命令在做什么（面向用户的自然语言，如「查看 git 提交历史」「安装项目依赖」），",
	"不复述命令原文、不含正则、不含参数细节；三种结论都要给。",
	"\n只输出一行 JSON，不要解释、不要代码块围栏：",
	'allow：{"action":"allow","reason":"一句话中文说明","intent":"...","whitelistPattern":"..."}',
	'review：{"action":"review","reason":"...","intent":"...","candidates":[{"pattern":"...","note":"..."}]}',
	'reject：{"action":"reject","reason":"...","intent":"..."}',
].join("\n");

/** 调辅助小模型审核命令；失败（超时/无模型/网络错误/输出无法解析）返回 null（调用方降级人工复核）。segInfo 为逐段白名单命中标注（无命中段时传空串） */
async function aiReview(
	ctx: ExtensionContext,
	command: string,
	timeoutMs: number,
	model: AnyModel,
	segInfo = "",
): Promise<Verdict | null> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return null;

	const truncated = command.length > AI_CMD_MAX_CHARS ? command.slice(0, AI_CMD_MAX_CHARS) + "\n…(已截断)" : command;
	const prompt =
		`工作目录：${ctx.cwd}\n\n待审核命令：\n${truncated}` +
		(segInfo ? `\n\n拆段分析（[白名单命中] = 用户预先认可，可信；重点审核 [未命中] 段落）：\n${segInfo}` : "");
	const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];

	ctx.ui.setStatus("perm-gate", "🛡 perm-gate AI 审核中…");
	try {
		const result = await completeSimple(
			model,
			{ systemPrompt: AI_SYSTEM_PROMPT, messages },
			{
				apiKey: auth.apiKey,
				headers: { ...auth.headers },
				maxTokens: 500, // candidates + intent 字段需要额外输出空间
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
		// 候选正则：逐条校验可编译才采纳（AI 可能产出非法正则），封顶 5 条
		const candidates: Candidate[] = [];
		if (Array.isArray(parsed.candidates)) {
			for (const c of parsed.candidates.slice(0, 5)) {
				const p = (c as Partial<Candidate> | null)?.pattern;
				if (typeof p !== "string" || !p.trim()) continue;
				try {
					new RegExp(p, REGEX_FLAGS);
				} catch {
					continue;
				}
				const note = (c as Partial<Candidate>).note;
				candidates.push({ pattern: p, note: typeof note === "string" ? note : "" });
			}
		}
		// allow 的单条语义白名单规则：可编译才采纳
		let whitelistPattern = "";
		if (typeof parsed.whitelistPattern === "string" && parsed.whitelistPattern.trim()) {
			try {
				new RegExp(parsed.whitelistPattern, REGEX_FLAGS);
				whitelistPattern = parsed.whitelistPattern;
			} catch {
				/* 非法正则丢弃 */
			}
		}
		return {
			action: parsed.action,
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			intent: typeof parsed.intent === "string" ? parsed.intent : "",
			whitelistPattern,
			candidates,
		};
	} catch {
		return null;
	} finally {
		ctx.ui.setStatus("perm-gate", undefined);
	}
}

/**
 * 人工复核面板（overlay 组件）：命令全文折行展示（不截断），PgUp/PgDn 滚动文本区
 * （滚动余量在分隔行指示，不吃内容行）；↑↓ 移动、Enter 确认、1-5 直选、Esc = 驳回（done(null)）。
 * 模块级导出供回归测试直接实例化（不走 tool_call 事件链路，避免触碰真实配置文件）。
 */
export class ReviewPanel {
	focused = false;

	private static ACTIONS = ["放行一次", "放行并加白名单", "放行并加黑名单", "驳回", "驳回并加黑名单"];
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
		private detail: string,
		private done: (choice: string | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.idx = Math.max(0, this.idx - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.idx = Math.min(ReviewPanel.ACTIONS.length - 1, this.idx + 1);
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
		if (matchesKey(data, Key.enter)) {
			this.done(ReviewPanel.ACTIONS[this.idx]!);
			return;
		}
		if (/^[1-5]$/.test(data)) {
			this.done(ReviewPanel.ACTIONS[Number(data) - 1]!);
			return;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const { row, topBorder, bottomBorder, border } = createBoxRenderer(th, Math.max(10, width - 2));
		const innerW = Math.max(10, width - 2);

		// 文本区逻辑行：AI 说明在顶部（固定可见），命令在下方（可滚动）
		const textLines: string[] = [];
		if (this.detail) {
			for (const w of wrapTextWithAnsi(th.fg("dim", this.detail), Math.max(8, innerW - 2))) textLines.push(w);
			textLines.push("");
		}
		for (const ln of this.command.split("\n")) {
			for (const w of wrapTextWithAnsi(ln, Math.max(8, innerW - 4))) textLines.push(`  ${w}`);
		}

		// 高度预算：终端 80% 减去固定行（顶/底框 + 分隔 + 操作标题 + 5 操作 + 提示行 = 10）
		const termRows = this.tui.terminal.rows || 24;
		const budget = Math.max(3, Math.min(textLines.length, Math.floor(termRows * 0.8) - 9));
		this.lastBudget = budget;
		this.lastMaxScroll = Math.max(0, textLines.length - budget);
		this.scroll = Math.max(0, Math.min(this.scroll, this.lastMaxScroll));
		const visible = textLines.slice(this.scroll, this.scroll + budget);

		// 分隔行兼滚动指示（不吃内容行）
		const below = textLines.length - (this.scroll + visible.length);
		const scrollNote =
			this.scroll > 0 && below > 0
				? ` ▲${this.scroll} 行 ▼${below} 行（PgUp/PgDn） `
				: this.scroll > 0
					? ` ▲ 上方还有 ${this.scroll} 行（PgUp） `
					: below > 0
						? ` ▼ 下方还有 ${below} 行（PgDn） `
						: "";
		const dividerLine = border(`├${th.fg("dim", scrollNote)}${"─".repeat(Math.max(0, innerW - visibleWidth(scrollNote)))}┤`);

		const lines: string[] = [topBorder(` ${this.title} `)];
		for (const ln of visible) lines.push(row(ln));
		lines.push(dividerLine);
		lines.push(row(th.fg("accent", " 如何处理？")));
		ReviewPanel.ACTIONS.forEach((a, i) => {
			const prefix = i === this.idx ? th.fg("accent", " › ") : "   ";
			lines.push(row(`${prefix}${i === this.idx ? th.fg("accent", a) : a}`));
		});
		lines.push(row(th.fg("dim", " ↑↓ 选择 · Enter 确认 · 1-5 直选 · PgUp/PgDn 滚动命令 · Esc 驳回")));
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
		if (pruneWhitelist() > 0) saveJsonConfig(CONFIG_FILE, cfg);
	}

	/** AI 审核结论会话级缓存（精确命令 → 结论；review 不缓存，每次都让人工决定） */
	const aiCache = new Map<string, Verdict>();

	/** 面板串行链：并行工具批里多个待复核命令依次弹面板，避免对话框互相覆盖 */
	let panelChain: Promise<unknown> = Promise.resolve();

	function saveConfig(): void {
		saveJsonConfig(CONFIG_FILE, cfg);
	}

	// 白名单保鲜：命中时刷新规则内存元数据，落盘 throttle（避免高频 bash 调用频繁写配置）
	let whitelistTouchDirty = false;
	let lastWhitelistPersist = 0;
	const WHITELIST_PERSIST_MIN_MS = 60_000;

	/** 命中白名单规则：刷新保鲜期与计数（内存记录，落盘见 maybePersistWhitelist） */
	function touchWhitelist(rule: WhitelistRule, now: number): void {
		rule.hits++;
		rule.lastHit = now;
		whitelistTouchDirty = true;
	}

	/** 落盘未持久化的命中刷新（throttle，最短间隔 60s） */
	function maybePersistWhitelist(): void {
		if (!whitelistTouchDirty) return;
		const now = Date.now();
		if (now - lastWhitelistPersist < WHITELIST_PERSIST_MIN_MS) return;
		lastWhitelistPersist = now;
		whitelistTouchDirty = false;
		saveConfig();
	}

	/** 白名单规则工厂（新规则保鲜期从加白时刻起算） */
	function newWhitelistRule(pattern: string, now = Date.now()): WhitelistRule {
		return { pattern, addedAt: now, lastHit: now, hits: 0 };
	}

	/** 清理超过保鲜期未命中的白名单规则；返回清理条数 */
	function pruneWhitelist(): number {
		const cutoff = Date.now() - WHITELIST_EXPIRE_DAYS * 86_400_000;
		const before = cfg.whitelist.length;
		cfg.whitelist = cfg.whitelist.filter((r) => r.lastHit >= cutoff);
		return before - cfg.whitelist.length;
	}

	/** 白名单编译（携带规则对象供命中保鲜）；无效正则收集进 invalid */
	function compileWhitelist(invalid: string[]): Array<{ re: RegExp; rule: WhitelistRule }> {
		const out: Array<{ re: RegExp; rule: WhitelistRule }> = [];
		for (const r of cfg.whitelist) {
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

	/** 加入名单前校验：AI 给的正则既不匹配整串也不匹配任何子命令段时警告（可能提炼有误），但不阻止加入 */
	function warnIfNotMatch(ctx: ExtensionContext, pattern: string, command: string, segments: string[]): void {
		try {
			const re = new RegExp(pattern, REGEX_FLAGS);
			if (!re.test(command) && !segments.some((s) => re.test(s))) {
				ctx.ui.notify(`⚠️ 正则「${pattern}」不匹配当前命令，AI 提炼可能有误`, "warning");
			}
		} catch {
			/* 不可编译的候选已在解析时过滤 */
		}
	}

	/**
	 * allow 结论自动加白：采纳 AI 提炼的单条语义白名单正则（whitelistPattern）；
	 * 缺失/跑偏时退结构化兜底规则（^命令\s+子命令），最后才落每段精确规则。
	 * 护栏：去重、不覆盖黑名单已有规则；每次加白发通知（透明可查）。
	 */
	function autoWhitelist(ctx: ExtensionContext, command: string, segments: string[], verdict: Verdict): void {
		let patterns: string[] = (segments.length > 0 ? segments : [command]).map(exactPattern); // 最后兜底
		// 依次尝试：AI 语义规则 → 结构化语义兜底，取第一条可编译且命中原命令/段的
		const tryList = [verdict.whitelistPattern, ...generateFallbackPatterns(command, segments).map((c) => c.pattern)];
		for (const p of tryList) {
			if (!p) continue;
			try {
				const re = new RegExp(p, REGEX_FLAGS);
				if (re.test(command) || segments.some((s) => re.test(s))) {
					patterns = [p];
					break;
				}
			} catch {
				/* 不可编译跳过（解析阶段已过滤，双保险） */
			}
		}
		const fresh = patterns.filter(
			(p) => !cfg.whitelist.some((r) => r.pattern === p) && !cfg.blacklist.includes(p),
		);
		if (fresh.length === 0) return;
		pruneWhitelist(); // 先清过期规则（与新增同批落盘）
		cfg.whitelist.push(...fresh.map((pattern) => newWhitelistRule(pattern)));
		saveConfig();
		// 通知展示 AI 概括的命令意图（不暴露具体正则/指令），AI 漏给时回落 reason，再兜底规则原文
		const desc = verdict.intent || verdict.reason || fresh.join("、");
		ctx.ui.notify(`perm-gate 自动加白：${desc}`, "info");
	}

	/**
	 * 名单规则多选面板（overlay 组件，模式仿 ask/page.ts QuestionnairePicker）：
	 * pi 原生 ctx.ui.select 只有单选，多选需自绘。↑↓ 移动，空格 勾选/取消，
	 * Enter 提交（返回选中下标数组），Esc 取消（返回 null）。
	 */
	class PatternMultiPicker {
		focused = false;

		private static MAX_ROWS = 12;
		private idx = 0;
		private checked = new Set<number>();

		constructor(
			private theme: Theme,
			private title: string,
			private options: string[],
			private done: (idxs: number[] | null) => void,
		) {}

		handleInput(data: string): void {
			if (matchesKey(data, Key.escape)) {
				this.done(null);
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.idx = Math.max(0, this.idx - 1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.idx = Math.min(this.options.length - 1, this.idx + 1);
				return;
			}
			if (matchesKey(data, Key.space)) {
				if (this.checked.has(this.idx)) this.checked.delete(this.idx);
				else this.checked.add(this.idx);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.done([...this.checked].sort((a, b) => a - b));
				return;
			}
		}

		render(width: number): string[] {
			const th = this.theme;
			const { row, topBorder, bottomBorder } = createBoxRenderer(th, Math.max(10, width - 2));
			const lines: string[] = [topBorder(` ${this.title} `)];
			// 窗口跟随焦点
			const budget = PatternMultiPicker.MAX_ROWS;
			const start = Math.max(0, Math.min(this.idx - Math.floor(budget / 2), this.options.length - budget));
			const view = this.options.slice(start, start + budget);
			view.forEach((opt, k) => {
				const i = start + k;
				const box = this.checked.has(i) ? th.fg("accent", "[x]") : "[ ]";
				const prefix = i === this.idx ? th.fg("accent", " › ") : "   ";
				const text = i === this.idx ? th.fg("accent", opt) : opt;
				lines.push(row(`${prefix}${box} ${text}`));
			});
			lines.push(row(th.fg("dim", ` 已选 ${this.checked.size} 项 · ↑↓ 移动 · 空格 勾选 · Enter 提交 · Esc 取消`)));
			lines.push(bottomBorder());
			return lines;
		}

		invalidate(): void {}
		dispose(): void {}
	}

	/**
	 * 选择要加入名单的正则（返回数组：复合命令的「精确匹配」= 每子命令段各一条精确规则，
	 * 与逐段判定的白名单语义对齐）：无候选 → 精确匹配；有候选 → 多选面板（空格勾选/Enter 提交，
	 * 可多选；附「精确匹配原文」兜底项；Esc 或空选提交 = 不加名单）
	 */
	async function pickListPatterns(
		ctx: ExtensionContext,
		command: string,
		segments: string[],
		candidates: Candidate[],
	): Promise<string[] | undefined> {
		const exactPatterns = () => (segments.length > 0 ? segments : [command]).map(exactPattern);
		if (candidates.length === 0) return exactPatterns();
		const exactIdx = candidates.length;
		const exactLabel =
			segments.length > 1
				? `只精确匹配这条命令原文（${segments.length} 个子命令段各加一条，只认一模一样的命令）`
				: "只精确匹配这条命令原文（只认一模一样的命令，同类变体仍需再审）";
		const options = [...candidates.map((c) => `${c.pattern}　— ${c.note || "（无说明）"}`), exactLabel];
		const picked = await ctx.ui.custom<number[] | null>(
			(_tui, theme, _kb, done) => new PatternMultiPicker(theme, "选择要加入名单的规则（可多选）", options, done),
			{ overlay: true, overlayOptions: { width: "90%", minWidth: 60, maxHeight: "70%" } },
		);
		if (picked === null || picked.length === 0) return undefined; // Esc 或空选提交：不加名单（主操作仍生效）
		const out: string[] = [];
		for (const i of picked) {
			if (i === exactIdx) out.push(...exactPatterns());
			else out.push(candidates[i]!.pattern);
		}
		return [...new Set(out)];
	}

	/** 人工复核面板：返回 undefined = 放行；{ block } = 驳回 */
	async function humanReview(
		ctx: ExtensionContext,
		command: string,
		segments: string[],
		source: "blacklist" | "ai",
		detail: string,
		candidates: Candidate[] = [],
	): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `perm-gate：命令需人工复核（${source === "blacklist" ? "命中黑名单" : "AI 建议复核"}），当前无 UI 无法确认，已阻断`,
			};
		}
		// 串行化面板
		const result = new Promise<{ block: true; reason: string } | undefined>((resolve) => {
			panelChain = panelChain.then(async () => {
				const title = source === "blacklist" ? "⚠️ 命中黑名单，需人工复核" : "🛡 AI 建议人工复核";
				// 自绘复核面板：命令全文折行展示不截断（PgUp/PgDn 滚动），Esc/「驳回」= 驳回；
				// 登记 Working 行等待文本（status-beacon 桥，缺席静默）
				const waitApi = (globalThis as Record<string, unknown>).__PI_STATUS_BEACON_API__ as
					| { wait?: (t: string | null) => void }
					| undefined;
				waitApi?.wait?.(`复核 bash 命令：${command.trim().split("\n")[0].slice(0, 40)}`);
				let choice: string | null;
				try {
					choice = await ctx.ui.custom<string | null>(
						(tui, theme, _kb, done) => new ReviewPanel(tui, theme, title, command, detail, done),
						{ overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "80%" } },
					);
				} finally {
					waitApi?.wait?.(null);
				}
				switch (choice) {
					case "放行一次":
						resolve(undefined);
						break;
					case "放行并加白名单": {
						const patterns = await pickListPatterns(ctx, command, segments, candidates);
						if (patterns) {
							for (const p of patterns) warnIfNotMatch(ctx, p, command, segments);
							cfg.whitelist.push(...patterns.map((p) => newWhitelistRule(p)));
							saveConfig();
							ctx.ui.notify(`perm-gate：已加入白名单：${patterns.join("、")}`, "info");
						}
						resolve(undefined);
						break;
					}
					case "放行并加黑名单": {
						const patterns = await pickListPatterns(ctx, command, segments, candidates);
						if (patterns) {
							for (const p of patterns) warnIfNotMatch(ctx, p, command, segments);
							cfg.blacklist.push(...patterns);
							saveConfig();
							ctx.ui.notify(`perm-gate：已加入黑名单：${patterns.join("、")}`, "info");
						}
						resolve(undefined);
						break;
					}
					case "驳回并加黑名单": {
						const patterns = await pickListPatterns(ctx, command, segments, candidates);
						if (patterns) {
							for (const p of patterns) warnIfNotMatch(ctx, p, command, segments);
							cfg.blacklist.push(...patterns);
							saveConfig();
							ctx.ui.notify(`perm-gate：已加入黑名单：${patterns.join("、")}`, "info");
						}
						resolve({ block: true, reason: "perm-gate：用户驳回该命令" });
						break;
					}
					default: // "驳回" 或 Esc 取消
						resolve({ block: true, reason: "perm-gate：用户驳回该命令" });
						break;
				}
			});
		});
		return result;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!cfg.enabled) return undefined;
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input.command;

		// 编译名单（bash 调用频率低，每次现编译开销可忽略；无效正则跳过）
		const invalid: string[] = [];
		const blacklist = compilePatterns(cfg.blacklist, invalid);
		const whitelist = compileWhitelist(invalid);

		// 复合命令拆段（&& / || / ; / | / 换行 / $() / `...`）：白名单逐段判定，
		// 防止「git status && rm -rf x」被前半段的白名单规则连带放行
		const segments = splitShellSegments(command);

		// 1. 黑名单优先（安全兜底）：整串 + 逐段，任一命中 → 人工复核
		const wholeHit = blacklist.find((p) => p.test(command));
		const segHit = !wholeHit
			? segments.map((s) => ({ seg: s, re: blacklist.find((p) => p.test(s)) })).find((x) => x.re)
			: undefined;
		if (wholeHit || segHit) {
			const re = wholeHit ?? segHit!.re!;
			// detail 随面板全文折行展示，不再截断
			const detail = segHit
				? `子命令段「${segHit.seg}」命中黑名单规则：${re.source}`
				: `命中黑名单规则：${re.source}`;
			return humanReview(ctx, command, segments, "blacklist", detail);
		}

		// 2. 白名单 → 放行（逐段：每个子命令段都要命中白名单，缺一段都不放）；命中规则刷新保鲜
		if (segments.length > 0) {
			const hitNow = Date.now();
			let allHit = true;
			for (const s of segments) {
				const hit = whitelist.find((w) => w.re.test(s));
				if (!hit) {
					allHit = false;
					break;
				}
				touchWhitelist(hit.rule, hitNow);
			}
			if (allHit) {
				maybePersistWhitelist(); // 允许时落盘保鲜（throttle）
				return undefined;
			}
		}

		// 3. 未命中 → AI 审核（关闭时一律转人工）
		if (!cfg.aiReview) {
			return humanReview(ctx, command, segments, "ai", "AI 审核已关闭（aiReview=false），未命中名单的命令一律人工复核");
		}
		// 逐段白名单命中情况：有命中段时随命令一起标注给 AI——命中段视为用户预先认可，
		// AI 聚焦未命中段审核，避免对白名单段落重复审查/误判，candidates 也只针对未命中段
		const hitNow = Date.now();
		const segHits = segments
			.map((s) => whitelist.find((w) => w.re.test(s)))
			.filter((w): w is NonNullable<typeof w> => !!w);
		for (const h of segHits) touchWhitelist(h.rule, hitNow);
		const segInfo = segHits.length > 0
			? segments
					.map((s) => {
						const hit = whitelist.find((w) => w.re.test(s));
						const label = hit ? "白名单命中" : "未命中";
						const rule = hit ? `（规则：${truncateCmd(hit.re.source, 80)}）` : "";
						return `- [${label}] ${truncateCmd(s, 120).replace(/\n/g, " ⏎ ")}${rule}`;
					})
					.join("\n")
			: "";
		let verdict = aiCache.get(command) ?? null;
		if (!verdict) {
			const model = resolveReviewModel(ctx);
			if (model) verdict = await aiReview(ctx, command, cfg.aiTimeoutMs, model, segInfo);
			if (verdict) {
				// 仅 review 需要候选数组（人工面板选粒度）：过滤不合格、评分排序、兜底补充；
				// allow 走 whitelistPattern 单条规则，无需精炼
				if (verdict.action === "review") {
					verdict = { ...verdict, candidates: refineCandidates(verdict.candidates, command, segments) };
				}
				if (verdict.action !== "review") aiCache.set(command, verdict);
			}
		}
		if (!verdict) {
			return humanReview(ctx, command, segments, "ai", "AI 审核失败（超时/无可用模型/网络错误/输出无法解析），转人工复核");
		}
		if (verdict.action === "review") {
			return humanReview(ctx, command, segments, "ai", verdict.reason ? `AI 说明：${verdict.reason}` : "", verdict.candidates);
		}
		if (verdict.action === "reject") {
			return { block: true, reason: `perm-gate AI 审核驳回：${verdict.reason || "命令被判定为危险"}` };
		}
		autoWhitelist(ctx, command, segments, verdict); // allow：按策略自动加白，以后同类命令零审核成本
		return undefined; // allow
	});

	// /perm-gate 命令：状态查看 / 开关 / 重读配置 / 审核模型选择 / 清理过期白名单
	// （名单编辑走配置文件，不提供管理面板）
	pi.registerCommand("perm-gate", {
		description:
			"bash 命令权限门：查看状态 / on / off / reload / model [provider/id|auto] / prune",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "on" || sub === "off") {
				cfg.enabled = sub === "on";
				saveConfig();
				ctx.ui.notify(`perm-gate 已${cfg.enabled ? "开启" : "关闭"}（已持久化）`, "info");
				return;
			}
			if (sub === "reload") {
				cfg = loadConfig().cfg;
				aiCache.clear();
				ctx.ui.notify("perm-gate 配置已重读", "info");
				return;
			}
			if (sub === "prune") {
				const pruned = pruneWhitelist();
				if (pruned > 0) saveConfig();
				ctx.ui.notify(
					`perm-gate：已清理 ${pruned} 条超过 ${WHITELIST_EXPIRE_DAYS} 天未命中的白名单规则，剩 ${cfg.whitelist.length} 条`,
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
			compilePatterns(cfg.blacklist, invalid);
			compileWhitelist(invalid);
			maybePersistWhitelist(); // 查询前落盘未持久化的命中刷新
			const expiredCut = Date.now() - WHITELIST_EXPIRE_DAYS * 86_400_000;
			const expired = cfg.whitelist.filter((r) => r.lastHit < expiredCut).length;
			ctx.ui.notify(
				[
					`perm-gate ${cfg.enabled ? "✅ 开启" : "❌ 关闭"}（AI 审核 ${cfg.aiReview ? "开" : "关"}，自动加白 smart）`,
					`审核模型：${cfg.model ?? "自动（优先列表 + 最便宜兜底）"}`,
					`白名单 ${cfg.whitelist.length} 条${expired ? `（${expired} 条超过 ${WHITELIST_EXPIRE_DAYS} 天未命中，/perm-gate prune 清理）` : ""} / 黑名单 ${cfg.blacklist.length} 条`,
					invalid.length ? `⚠️ 无效正则 ${invalid.length} 条：${invalid.join("、")}` : "",
					`配置文件：${CONFIG_FILE}`,
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});
}
