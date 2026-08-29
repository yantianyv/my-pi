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
 * 人工复核面板四操作：放行一次 / 放行并加白名单 / 驳回 / 驳回并加黑名单。
 * AI 判 allow 后按 autoWhitelist 策略自动加白（默认 smart 采纳 AI 最窄候选，exact 精确段规则），
 * 常用无害命令只在首次烧一次审核 token；每次自动加白发通知，透明可查。
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
 *     "aiTimeoutMs": 15000,            // AI 审核超时
 *     "autoWhitelist": "smart"         // allow 自动加白：off / exact（精确段规则）/ smart（AI 最窄候选）
 *   }
 *
 * 命令：/perm-gate 查看状态；/perm-gate on|off 开关（持久化）；/perm-gate reload 重读配置；
 *       /perm-gate model 打开官方模型选择面板（shared/model-selector 复用 ModelSelectorComponent，
 *       与内置 /model 同组件），/perm-gate model <provider>/<id>|auto 直接设置（仿 pi-btw 覆盖项）。
 * AI 审核进度经官方 setStatus 通道推「perm-gate」状态，由 hud 行 1 动态区显示。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
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

/** 复核面板中命令展示的最大字符数（超出截断） */
const PANEL_CMD_MAX_CHARS = 600;

/** 喂给 AI 审核的命令最大字符数（超出截断） */
const AI_CMD_MAX_CHARS = 4_000;

interface PermGateConfig {
	enabled: boolean;
	blacklist: string[];
	whitelist: string[];
	aiReview: boolean;
	aiTimeoutMs: number;
	/** AI 审核模型覆盖项（"provider/modelId"；null = 自动：优先列表 + 最便宜已认证兜底） */
	model: string | null;
	/**
	 * AI 判 allow 后的自动加白策略：
	 * off = 不自动加白；exact = 精确段规则入白（同一条命令以后零 token，但变体不覆盖）；
	 * smart = 采纳 AI 候选正则最窄一条入白（同类变体也覆盖，依赖提炼质量，跑偏退 exact，默认）
	 */
	autoWhitelist: "off" | "exact" | "smart";
}

/** 默认配置（首次运行写入，用户可手动编辑） */
const DEFAULT_CONFIG: PermGateConfig = {
	enabled: true,
	blacklist: [
		"\\brm\\s+(-[a-zA-Z]*r|--recursive)", // rm -r / rm -rf / rm --recursive
		"\\bsudo\\b",
		"\\bmkfs(\\.[a-z0-9]+)?\\b",
		"\\bdd\\b[^\\n]*\\bof=/dev/",
		">\\s*/dev/(sd|nvme|hd)", // 覆写磁盘设备
		"\\bchmod\\b[^\\n]*\\b777\\b",
		"\\b(shutdown|reboot|poweroff|halt)\\b",
		":\\(\\)\\s*\\{", // fork 炸弹 :(){ :|:& };:
	],
	whitelist: [],
	aiReview: true,
	aiTimeoutMs: 15_000,
	model: null,
	autoWhitelist: "smart",
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
	/** action=review 时提炼的候选正则（加入名单用；可能为空，回落精确匹配） */
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
		c.whitelist.every((s) => typeof s === "string") &&
		typeof c.aiReview === "boolean" &&
		typeof c.aiTimeoutMs === "number" &&
		// model 为后加字段：旧配置缺失时容错（缺省 null = 自动），避免校验不过回默认丢名单
		(c.model === undefined || c.model === null || typeof c.model === "string") &&
		// autoWhitelist 同为后加字段：缺失时归一化为默认 exact
		(c.autoWhitelist === undefined ||
			c.autoWhitelist === "off" ||
			c.autoWhitelist === "exact" ||
			c.autoWhitelist === "smart")
	);
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
	cfg.autoWhitelist ??= "smart";
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

/** 面板展示用：截断过长命令 */
function truncateCmd(command: string, max: number): string {
	return command.length > max ? command.slice(0, max) + "\n…(命令过长已截断)" : command;
}

// ---------------------------------------------------------------------------
// AI 审核
// ---------------------------------------------------------------------------

const AI_SYSTEM_PROMPT = [
	"你是 shell 命令安全审核员。AI 编码助手要在用户机器上执行一条 bash 命令，由你判断是否安全。",
	"给出三类结论之一：",
	'- "allow"：常规开发操作（构建、测试、查看文件、git 只读操作等），无不可逆/破坏性风险',
	'- "review"：可能有风险，需要人工确认——涉及删除/覆盖文件、修改系统配置、权限变更、',
	"  网络外发数据、安装/卸载软件、git 破坏性操作（push --force、reset --hard、clean -f）等",
	'- "reject"：明显危险或恶意——破坏系统、删除用户数据、窃取/外传密钥与隐私数据等',
	"命令可能是复合形式（&&、;、|、||、$()、反引号）：按风险最高的子命令给结论，candidates 针对风险子命令提炼；",
	"特别注意危险操作藏在无害命令后半段的情况（如 git status && rm -rf x）。",
	"输入可能附带「拆段分析」：标注 [白名单命中] 的段落是用户预先认可的安全命令，视为可信、不再审核；",
	"重点审核 [未命中] 段落，最终结论按未命中段的最高风险给出（candidates 也只针对未命中段提炼）。",
	"命令可能是多行（python -c \"...\" 内嵌脚本、heredoc 等）：提炼正则时保持命令原样，不要把多行美化成单行",
	"（如删去换行/缩进）；跨任意内容用 .*（匹配时自动加 s 标志，可跨换行）。",
	'当 action 为 "allow" 或 "review" 时，同时提炼该命令的核心特征，给出 1~3 个候选正则（candidates 字段）：',
	'- allow：候选用于自动加入白名单（避免同类无害命令反复审核）；review：供用户人工选用；reject：candidates 给空数组',
	'- 每个候选 {"pattern":"JavaScript 正则（不带标志，匹配时会自动加 i 和 s）","note":"一句话说明覆盖范围"}',
	"- 从窄到宽排列（如 ^git push --force → git push.*--force → --force），正则尽量锚定命令开头或关键旗标",
	"只输出一行 JSON，不要解释、不要代码块围栏：",
	'{"action":"allow|review|reject","reason":"一句话中文说明","candidates":[{"pattern":"...","note":"..."}]}',
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
				maxTokens: 400, // candidates 字段需要额外输出空间
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
		return {
			action: parsed.action,
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			candidates,
		};
	} catch {
		return null;
	} finally {
		ctx.ui.setStatus("perm-gate", undefined);
	}
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
	}

	/** AI 审核结论会话级缓存（精确命令 → 结论；review 不缓存，每次都让人工决定） */
	const aiCache = new Map<string, Verdict>();

	/** 面板串行链：并行工具批里多个待复核命令依次弹面板，避免对话框互相覆盖 */
	let panelChain: Promise<unknown> = Promise.resolve();

	function saveConfig(): void {
		saveJsonConfig(CONFIG_FILE, cfg);
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
	 * allow 结论自动加白（autoWhitelist 策略）：
	 * exact = 精确段规则；smart = AI 候选最窄一条（跑偏/无候选退 exact）。
	 * 护栏：去重、不覆盖黑名单已有规则、smart 候选匹配不到本命令时不采纳；每次加白发通知（透明可查）。
	 */
	function autoWhitelist(ctx: ExtensionContext, command: string, segments: string[], verdict: Verdict): void {
		if (cfg.autoWhitelist === "off") return;
		const exact = (segments.length > 0 ? segments : [command]).map(exactPattern);
		let patterns: string[] = exact;
		if (cfg.autoWhitelist === "smart" && verdict.candidates.length > 0) {
			const candidate = verdict.candidates[0].pattern; // 最窄候选
			try {
				const re = new RegExp(candidate, REGEX_FLAGS);
				if (re.test(command) || segments.some((s) => re.test(s))) patterns = [candidate];
				// else：候选跑偏，静默退回精确规则
			} catch {
				/* 不可编译退精确规则（解析阶段已过滤，双保险） */
			}
		}
		const fresh = patterns.filter((p) => !cfg.whitelist.includes(p) && !cfg.blacklist.includes(p));
		if (fresh.length === 0) return;
		cfg.whitelist.push(...fresh);
		saveConfig();
		ctx.ui.notify(`perm-gate 自动加白（${cfg.autoWhitelist}）：${fresh.join("、")}`, "info");
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
				const lines = [
					title,
					"",
					"命令：",
					truncateCmd(command, PANEL_CMD_MAX_CHARS),
					"",
					detail ? `说明：${detail}` : "",
					detail ? "" : "",
					"如何处理？",
				].filter((l) => l !== "");
				const choice = await ctx.ui.select(lines.join("\n"), [
					"放行一次",
					"放行并加白名单",
					"驳回",
					"驳回并加黑名单",
				]);
					switch (choice) {
					case "放行一次":
						resolve(undefined);
						break;
					case "放行并加白名单": {
						const patterns = await pickListPatterns(ctx, command, segments, candidates);
						if (patterns) {
							for (const p of patterns) warnIfNotMatch(ctx, p, command, segments);
							cfg.whitelist.push(...patterns);
							saveConfig();
							ctx.ui.notify(`perm-gate：已加入白名单：${patterns.join("、")}`, "info");
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
		const whitelist = compilePatterns(cfg.whitelist, invalid);

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
			const detail = segHit
				? `子命令段「${truncateCmd(segHit.seg, 100).replace(/\n/g, " ⏎ ")}」命中黑名单规则：${re.source}`
				: `命中黑名单规则：${re.source}`;
			return humanReview(ctx, command, segments, "blacklist", detail);
		}

		// 2. 白名单 → 放行（逐段：每个子命令段都要命中白名单，缺一段都不放）
		if (segments.length > 0 && segments.every((s) => whitelist.some((p) => p.test(s)))) return undefined;

		// 3. 未命中 → AI 审核（关闭时一律转人工）
		if (!cfg.aiReview) {
			return humanReview(ctx, command, segments, "ai", "AI 审核已关闭（aiReview=false），未命中名单的命令一律人工复核");
		}
		// 逐段白名单命中情况：有命中段时随命令一起标注给 AI——命中段视为用户预先认可，
		// AI 聚焦未命中段审核，避免对白名单段落重复审查/误判，candidates 也只针对未命中段
		const segInfo = segments.some((s) => whitelist.some((p) => p.test(s)))
			? segments
					.map((s) => {
						const re = whitelist.find((p) => p.test(s));
						const label = re ? "白名单命中" : "未命中";
						const rule = re ? `（规则：${truncateCmd(re.source, 80)}）` : "";
						return `- [${label}] ${truncateCmd(s, 120).replace(/\n/g, " ⏎ ")}${rule}`;
					})
					.join("\n")
			: "";
		let verdict = aiCache.get(command) ?? null;
		if (!verdict) {
			const model = resolveReviewModel(ctx);
			if (model) verdict = await aiReview(ctx, command, cfg.aiTimeoutMs, model, segInfo);
			if (verdict && verdict.action !== "review") aiCache.set(command, verdict);
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

	// /perm-gate 命令：状态查看 / 开关 / 重读配置 / 审核模型选择（名单编辑走配置文件，不提供管理面板）
	pi.registerCommand("perm-gate", {
		description: "bash 命令权限门：查看状态 / on / off / reload / model [provider/id|auto] / autowhite [off|exact|smart]",
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
			if (sub === "autowhite" || sub.startsWith("autowhite ")) {
				const mode = args.trim().slice(9).trim().toLowerCase();
				if (mode === "off" || mode === "exact" || mode === "smart") {
					cfg.autoWhitelist = mode;
					saveConfig();
					ctx.ui.notify(`perm-gate 自动加白：${mode}（已持久化）`, "info");
				} else {
					ctx.ui.notify(`当前自动加白策略：${cfg.autoWhitelist}（用法：/perm-gate autowhite off|exact|smart）`, "info");
				}
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
			compilePatterns(cfg.whitelist, invalid);
			ctx.ui.notify(
				[
					`perm-gate ${cfg.enabled ? "✅ 开启" : "❌ 关闭"}（AI 审核 ${cfg.aiReview ? "开" : "关"}，自动加白 ${cfg.autoWhitelist}）`,
					`审核模型：${cfg.model ?? "自动（优先列表 + 最便宜兜底）"}`,
					`白名单 ${cfg.whitelist.length} 条 / 黑名单 ${cfg.blacklist.length} 条`,
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
