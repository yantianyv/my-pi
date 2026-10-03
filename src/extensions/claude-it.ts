/**
 * claude-it: 让 pi 更像 Claude Code
 *
 * - /exit 命令（/quit 的别名）与直接输入 exit 退出
 * - 对话进行中按 Ctrl+C 取消当前 agent 操作；打断沉降完成后的窗口内再按一次 Ctrl+C
 *   直接执行 /rewind 回退到上一条用户消息（内容放回输入框）。窗口从沉降完成（agent_end）
 *   起算而非按键时刻：沉降期内按下的 Ctrl+C 会把回退意图排队，双击连按永远有效
 * - /rewind 命令：回退到上一条用户消息，消息内容放回输入框
 * - /init 命令：后台独立上下文中分析代码库并生成/更新 AGENTS.md
 *   （已有 CLAUDE.md 会被归并进来；主会话零污染，期间可继续对话；explore 扩展在场时
 *   子代理可派探索子代理并行摸底，缺席自动降级；产出按上下文分层纪律（L1 AGENTS.md /
 *   L2 .pi/skills / L3 README），完成后由全新上下文的审计子代理复核修正；不设轮数与
 *   墙钟上限（稀有长跑，成本按价值配比），无进展保护与完成度核对兜底、/init cancel 中止；
 *   进度经官方 ctx.ui.setStatus 通道推「init」状态，由 hud 在行 1 动态区显示）
 * - 启动清屏：pi 冷启动（TUI 模式）时清一遍屏，主界面从干净画面开始
 *   （借 setWidget 工厂同步拿到 TUI 实例：清视口 + 强制全量重绘，用完即删）
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadOnlyTools,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
	runAgentLoop,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, createPiStreamFn, systemMessage } from "./shared/agent";
import { CONTEXT_OVERFLOW_RE, estimateTokens, pruneOldToolResults } from "./shared/context-budget";
import { getExploreApi } from "./shared/explore-api";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 启动清屏：pi 冷启动（TUI 模式）时清一遍屏，主界面从干净画面开始
// ---------------------------------------------------------------------------

/** 启动清屏开关（Claude Code 风格；不需要时置 false 即可） */
const CLEAR_SCREEN_ON_STARTUP = true;
/** 占位 widget 的 key：借 setWidget 工厂同步拿到 TUI 实例，用完即删，不留痕迹 */
const STARTUP_CLEAR_WIDGET_KEY = "startup-clear";
/** 双击 Ctrl+C 回退窗口（ms）：打断沉降完成（agent_end）后此窗口内的 Ctrl+C 触发回退 */
const REWIND_WINDOW_MS = 2_000;
/** 回退排队保持窗口（ms）：沉降期内按下的 Ctrl+C 把回退意图排队，此后此窗口内再按一次即触发 */
const REWIND_ARMED_WINDOW_MS = 30_000;

function clearScreenOnStartup(ctx: ExtensionContext) {
	// setWidget 的工厂会同步收到 TUI 实例（interactive-mode 内即 this.ui）：
	// 1) clearScreen() 清视口（\x1b[2J\x1b[H，保留 scrollback 可向上翻阅）；
	// 2) requestRender(true) 重置差分渲染状态并立即全量重绘——
	//    清屏后若只做普通差分渲染，TUI 会以为旧帧还在、仅重绘变化行导致画面残缺。
	ctx.ui.setWidget(STARTUP_CLEAR_WIDGET_KEY, (tui) => {
		tui.terminal.clearScreen();
		tui.requestRender(true);
		return new Text("", 0, 0);
	});
	// 清屏 + 全量重绘都在工厂同步调用内完成，随即移除占位 widget，无视觉残留
	ctx.ui.setWidget(STARTUP_CLEAR_WIDGET_KEY, undefined);
}

/** 从消息 content（string 或 TextContent[]）提取纯文本 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(c): c is { type: "text"; text: string } =>
					!!c && typeof c === "object" && (c as { type?: string }).type === "text",
			)
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

// ---------------------------------------------------------------------------
// /init：后台独立上下文分析代码库，生成 AGENTS.md（对齐 Claude Code 的 /init）
// ---------------------------------------------------------------------------

/** 唯一的上下文文件目标：AGENTS.md（pi 原生读取；CLAUDE.md 只会被归并，不会被生成） */
const CONTEXT_FILE = "AGENTS.md";
/** init 子代理单次输出上限 */
const INIT_MAX_TOKENS = 8192;
/**
 * 无进展保护阈值：连续这么多轮既没写文件也没派 explore → 注入收尾指令（只提醒不做硬停）。
 * 不设轮数与墙钟上限：/init 是稀有大工程，成本按价值配比；要中断用 /init cancel。
 */
const NO_PROGRESS_TURNS = 8;
/** 上下文预算：超过这个占比（按模型窗口估）就把旧工具结果剪成占位文本 */
const CONTEXT_BUDGET_RATIO = 0.55;
/** 一次运行最多做几次「超限 → 压缩 → 继续」 */
const MAX_COMPACTIONS = 2;
/** 压缩时送入模型的记录上限（尾部截断） */
const COMPACT_RECORD_CHARS = 24_000;
/** 压缩记录兜底保留长度（模型压缩不可用时直接用记录尾巴） */
const COMPACT_FALLBACK_CHARS = 6_000;
/** 审计子代理单次输出上限 */
const AUDIT_MAX_TOKENS = 4096;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

function buildInitPrompt(mode: "create" | "merge" | "overwrite", hasExplore: boolean): string {
	const modeInstructions = {
		create: `当前目录不存在 ${CONTEXT_FILE}，请从头创建它。`,
		merge:
			`当前目录已存在 ${CONTEXT_FILE}。先完整读取它，保留其中仍然准确的内容（尤其是人工编写的约定），` +
			`只更新过时的部分、补充缺失的部分，不要整篇重写；同时按提示词纪律压缩冗余：重复条目合并、` +
			`变更史与解释性长句删掉——事实与约定一条不丢，只是表达变短。`,
		overwrite:
			`当前目录已存在 ${CONTEXT_FILE}，但用户要求完全重写：通读现有内容了解项目后，从零生成一份全新的 ${CONTEXT_FILE} 覆盖它。`,
	};
	const exploreStep = hasExplore
		? "大代码库先用 explore 并行摸底（见探索纪律），再精读 grep / find 定位到的关键片段"
		: "大代码库用 grep / find 定位关键文件后精读片段";
	return [
		`分析当前代码库并生成/更新上下文文件 ${CONTEXT_FILE}。`,
		"",
		modeInstructions[mode],
		"",
		"分析方法：",
		"1. 先看根目录清单（ls）、README、package.json / pyproject.toml / go.mod / Cargo.toml 等清单文件，确定项目用途、技术栈与包管理器",
		"2. 梳理目录结构，识别入口文件、核心模块、测试目录与配置文件",
		"3. 从脚本定义、Makefile、CI 配置中提取真实的构建 / 测试 / lint / 运行命令",
		`4. ${exploreStep}，配合 bash（如 git log 看提交风格）；不要逐文件通读`,
		"",
		`${CONTEXT_FILE} 应包含的章节（按需取舍，不需要的章节省略）：`,
		"- 项目概述：一句话说明这是什么、主要技术栈",
		"- 常用命令：构建、测试、lint、类型检查、运行/调试（必须真实存在，标注出处，如 package.json scripts）",
		"- 目录结构：关键目录与各自职责",
		"- 架构要点：核心模块如何组织、数据流/调用链概要",
		"- 代码风格与约定：命名、缩进、注释语言、提交信息等可观察到的约定",
		"- 测试说明：测试框架、如何跑单个测试",
		"- 注意事项：安全规则、不能动的文件/目录、其他容易出错的地方",
		"",
		"硬性要求：",
		"- 只写经过验证的信息，命令必须真实存在于项目配置中，禁止编造；不确定的内容标注「待确认」",
		"- 保持精炼：用路径引用代替粘贴代码原文，只写能改变 AI 行为的行",
		"- 内容使用中文（代码、命令、标识符除外）",
		"- 新建了 .pi/skills/ 下的技能时，总结里说明它首次会触发一次项目信任确认",
		`- 用 write 工具把结果写入 ${CONTEXT_FILE}；最后一条回复用一两句话总结写入了什么（会展示给用户）`,
	].join("\n");
}

/** 两者同时存在时：让 AI 合并为一份 AGENTS.md 并删除 CLAUDE.md */
function buildClaudeMergePrompt(): string {
	return [
		"当前目录同时存在 AGENTS.md 和 CLAUDE.md 两份上下文文件，将它们合并为一份 AGENTS.md（pi 原生读取 AGENTS.md，不再需要 CLAUDE.md）。",
		"",
		"合并步骤：",
		"1. 完整读取 AGENTS.md 和 CLAUDE.md",
		"2. 对比两份内容：保留仍然准确的信息（人工编写的约定优先），冲突处以更准确/更新者为准，去重",
		"3. 同时按 /init 的标准补全：分析代码库（清单文件、scripts、目录结构、CI 配置），更新过时内容、补充缺失章节（常用命令必须真实存在，禁止编造）；重复条目合并、变更史与解释性长句删掉，事实与约定不丢",
		"4. 用 write 工具把合并结果写入 AGENTS.md（中文，只写能改变 AI 行为的行）",
		"5. 用 bash 删除 CLAUDE.md（Windows 环境用 del 或 Remove-Item，按当前 shell 而定）",
		"6. 最后一条回复用一两句话总结：保留了什么、更新了什么、删除了 CLAUDE.md（会展示给用户）",
	].join("\n");
}

// ---------------------------------------------------------------------------
// init 子代理（独立上下文，后台运行）
// ---------------------------------------------------------------------------

function buildInitSystemPrompt(cwd: string, hasExplore: boolean): string {
	const lines = [
		"你是 init 代理，负责分析代码库并生成/更新 AGENTS.md 上下文文件。",
		hasExplore
			? "你拥有工具：read / ls / grep / find（探索）、explore（派只读子代理并行摸底）、write / edit（写文件）、bash（辅助命令，如 git log、删除文件）。"
			: "你拥有工具：read / ls / grep / find（探索）、write / edit（写文件）、bash（辅助命令，如 git log、删除文件）。",
	];
	if (hasExplore) {
		lines.push(
			"大仓库（目录/文件多）先用 explore 并行摸底（目录结构与入口、构建/测试/lint 命令、架构要点、代码约定），拿到报告后用 read 抽查关键路径再动笔；小仓库直接读。一批摸不透就再派第二批，基于首批报告收窄范围。",
		);
	}
	lines.push(
		"要求：高效探索（grep/find 定位 + 精读片段，不逐文件通读）；只写经过验证的信息；随时把已确认的结论落盘（别攒到最后——上下文超限被压缩时，没落盘的会丢）；完成后的一两条总结要精炼。",
		"提示词纪律（AGENTS.md 每轮对话都会加载，字数即成本）：",
		"- 只写能改变 AI 行为的「不写就会做错」的信息；显而易见的常识、README/清单文件里能自行读到的内容不写",
		"- 不写变更史、自我说明、实现解释；不粘贴代码原文（用路径引用）；常用命令一条一行、不写解释性长句",
		"- 写完逐行自检：删掉它会不会让 AI 做错事？答不上来就删",
		"上下文分层（决定内容放哪一层；同一事实只出现在一层）：",
		"- L1 AGENTS.md（每轮都加载）：常用命令、目录与职责（一行一项）、架构不变量、代码风格、注意事项与坑",
		"- L2 .pi/skills/<项目名>-dev/（按需加载，默认不建）：仅当子系统细节成段、L1 放不下时才建——SKILL.md 写概览与 references 索引（何时读哪个），references/<主题>.md 放子系统细节与长流程；frontmatter 的 description 必须写明「何时该用」",
		"- L3 README / docs：给人看，L1 只留一行指路，不复制内容",
		"- 命令、坑、不变量、跨子系统约定永不搬（必须自动在眼前）；已下沉的细节不要在 L1 重复",
		"- L1 指向 L2 的写法：写清「细节见 skill <名> 的 references/<文件>.md，改它之前先读」",
		"- 项目已有子目录 AGENTS.md（各目录自己的约定）时沿用该结构继续维护（子文件放各自的细节、根文件只留一行指路），不要把子文件内容上提到根文件或 skill",
		"重跑：先盘点现有 AGENTS.md 与 .pi/skills，人工内容只搬不删（原文事实保留），搬移与删除在最终总结里报告；L2 要跟着一起维护——过时内容更新或删除、新细节写进对应 references、文件增删后同步 SKILL.md 的索引与 description，不留孤儿文件与死指针",
		"",
		`工作目录：${cwd}`,
	);
	// 固定指令在前、cwd 在后，利于 provider 端 prompt 缓存命中
	return lines.join("\n");
}

interface InitRunResult {
	ok: boolean;
	summary: string;
}

/** 末句像「我将要做…」的意图陈述（而非已完成的总结）——出现它多半意味着 loop 提前结束 */
const UNFINISHED_RE = /^(?:now\s+i|next,?\s+i|i'?ll\b|i will\b|let me\b|接下来|下一步|我将|我会|让我)/i;
function looksUnfinished(summary: string): boolean {
	return UNFINISHED_RE.test(summary.trim().split("\n")[0]?.trim() ?? "");
}

/** 从消息列表倒序找第一条带正文文本的 assistant 消息（无则 null）。 */
function findAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const text = m.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { type: "text"; text: string }).text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return null;
}

/** 找最后一条模型调用错误（stopReason=error）的 assistant 消息，取其 errorMessage（v1 缺陷：
 *  agentLoop 对流式错误不抛异常而是静默返回带 stopReason=error 的 assistant 消息，
 *  错误详情在 errorMessage 字段而非 text 块，扫描文本找不到就误报「预算用尽」）。 */
function findLlmError(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
		if (m.role === "assistant" && m.stopReason === "error" && m.errorMessage) return m.errorMessage;
	}
	return null;
}

/** init 运行期间的回调（状态行 / 探索进度 / 审计进度 / 压缩） */
interface InitHooks {
	onToolCall: () => void;
	onExploreProgress: (done: number, total: number) => void;
	onAudit: (steps: number | null) => void;
	onCompact: (n: number) => void;
}

/** 把消息列表渲染成「过程记录」文本（压缩与兜底总结用；单条截尾） */
function renderProcessRecord(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "user" || role === "assistant") {
			const t = extractText((m as { content?: unknown }).content).trim();
			if (t) parts.push(`【${role === "user" ? "指令" : "产出"}】${t.slice(0, 4_000)}`);
		} else if (role === "toolResult") {
			const tm = m as { toolName?: string; content?: unknown };
			const t = extractText(tm.content).trim();
			if (t) parts.push(`【工具 ${tm.toolName ?? "?"}】${t.slice(0, 1_500)}`);
		}
	}
	return parts.join("\n\n");
}

/**
 * 上下文超限时把过程记录压成要点（供重启继续）。压缩模型或认证不可用时回退到记录尾部——
 * 宁可带一份粗糙的起点重跑，也不要让整轮工作白费。
 */
async function compactInitNotes(
	ctx: ExtensionContext,
	model: AnyModel,
	record: string,
	previous: string | null,
): Promise<string> {
	const merged = [previous ? `（更早的压缩记录）\n${previous}` : "", record].filter(Boolean).join("\n\n");
	const fallback = merged.trim().slice(-COMPACT_FALLBACK_CHARS);
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return fallback;
		const res = await completeSimple(
			model,
			{
				systemPrompt:
					"你在压缩一次 /init（生成/维护项目上下文文件）的过程记录。保留：已确认的项目事实（命令、目录职责、不变量、约定、坑、子系统细节要点与出处）、已写入文件的内容摘要与位置、未完成的待办。丢弃：冗余叙述、重复内容、工具调用外壳、已被压缩过的内容。输出纯文本要点清单，不要客套。",
				messages: [
					{
						role: "user",
						content: `--- 过程记录 ---\n${merged.slice(-COMPACT_RECORD_CHARS)}`,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: { ...auth.headers },
				maxTokens: 2_000,
				temperature: 0,
				signal: AbortSignal.timeout(60_000),
			},
		);
		const text = res.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { type: "text"; text: string }).text)
			.join("\n")
			.trim();
		return text || fallback;
	} catch {
		return fallback;
	}
}

/**
 * 找出项目里的上下文文件（根 + 子目录的 AGENTS.md / CLAUDE.md，跳过依赖/构建/隐藏目录）。
 * 很多仓库用子目录 AGENTS.md 做分层，审计与结构检查必须看得见它们。
 */
export function findContextFiles(cwd: string, limit = 25): string[] {
	const names = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.MD"]);
	const skip = new Set(["node_modules", ".git", "dist", ".tmp", "vendor"]);
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 6 || found.length >= limit) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (found.length >= limit) return;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (skip.has(e.name) || e.name.startsWith(".")) continue;
				walk(p, depth + 1);
			} else if (names.has(e.name)) {
				found.push(p);
			}
		}
	};
	const rootFile = path.join(cwd, CONTEXT_FILE);
	if (fs.existsSync(rootFile)) found.push(rootFile);
	walk(cwd, 1);
	return [...new Set(found)];
}

/**
 * 产物的确定性结构检查（不依赖模型）：上下文文件指针可解析、SKILL.md 索引与 references
 * 一一对应、frontmatter 有 name/description、不留空文件。返回人话问题清单（空 = 通过）。
 */
export function checkContextArtifacts(cwd: string): string[] {
	const issues: string[] = [];
	const skillRoot = path.join(cwd, ".pi", "skills");
	const skills = fs.existsSync(skillRoot)
		? fs.readdirSync(skillRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
		: [];
	const allRefs = new Set<string>();
	for (const s of skills) {
		const dir = path.join(skillRoot, s.name);
		const skillFile = path.join(dir, "SKILL.md");
		if (!fs.existsSync(skillFile)) {
			issues.push(`skill ${s.name}：缺 SKILL.md`);
			continue;
		}
		const skillText = fs.readFileSync(skillFile, "utf8");
		const fm = skillText.match(/^---\n([\s\S]*?)\n---/);
		if (!fm || !/^name:\s*\S/m.test(fm[1]) || !/^description:\s*\S/m.test(fm[1])) {
			issues.push(`skill ${s.name}：frontmatter 缺 name 或 description`);
		}
		const refDir = path.join(dir, "references");
		const files = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter((f) => f.endsWith(".md")) : [];
		for (const f of files) {
			allRefs.add(f);
			if (fs.statSync(path.join(refDir, f)).size < 80) issues.push(`skill ${s.name}：references/${f} 近乎空文件`);
			if (!skillText.includes(f)) issues.push(`skill ${s.name}：references/${f} 未写进 SKILL.md 索引`);
		}
		for (const m of skillText.matchAll(/references\/([\w.-]+\.md)/g)) {
			if (!files.includes(m[1])) issues.push(`skill ${s.name}：SKILL.md 指向不存在的 references/${m[1]}`);
		}
	}
	for (const file of findContextFiles(cwd)) {
		const rel = path.relative(cwd, file) || file;
		const text = fs.readFileSync(file, "utf8");
		for (const m of text.matchAll(/references\/([\w.-]+\.md)/g)) {
			if (!allRefs.has(m[1])) issues.push(`${rel} 指向不存在的 references/${m[1]}`);
		}
	}
	return issues;
}

// ---------------------------------------------------------------------------
// 产物审计：全新上下文按纪律复核并直接修正（审计自身故障只报告，不影响产物）
// ---------------------------------------------------------------------------

function buildAuditSystemPrompt(cwd: string): string {
	return [
		"你是 init 审计代理：复核刚生成的上下文文件是否符合下面的纪律。",
		"你拥有工具：read / ls / grep / find（核对）、write / edit（修正）。",
		"",
		"验收清单：",
		"1. AGENTS.md 每一行都值得每轮付钱：常用命令、目录与职责、架构不变量、代码风格、注意事项与坑；不该有的：变更史与自我说明、实现细节的长篇解释、README/清单文件里能自行读到的内容、显而易见的常识、粘贴的代码原文",
		"2. 同一事实只出现在一层；已下沉到 skill 的细节不在 AGENTS.md 重复；AGENTS.md 指向的 skill / references 文件必须真实存在",
		"3. 不该丢的没丢：命令、坑、不变量、跨子系统约定仍在 AGENTS.md；skill 的 description 写明「何时该用」",
		"4. 修正只做删减、合并、搬移与指针修复：不新增事实、不改变项目的技术结论；人工编写的约定只搬不删（原文事实保留）",
		"",
		"最后用一两句话报告改了什么（没改也说明）。",
		"",
		`工作目录：${cwd}`,
	].join("\n");
}

async function runInitAudit(
	ctx: ExtensionContext,
	model: AnyModel,
	signal: AbortSignal,
	onAudit: (steps: number | null) => void,
	issues?: string[],
): Promise<{ ok: boolean; summary: string }> {
	const skillsDir = path.join(ctx.cwd, ".pi", "skills");
	// 把具体文件列给审计（子目录 AGENTS.md 也是产物，不能靠它自己去找）
	const files = findContextFiles(ctx.cwd).map((f) => path.relative(ctx.cwd, f) || f);
	const target = [files.length ? `项目上下文文件（${files.join("、")}）` : CONTEXT_FILE, fs.existsSync(skillsDir) ? ".pi/skills/" : ""]
		.filter(Boolean)
		.join(" 与 ");
	const task =
		`复核并修正 ${target}：只保留值得每轮付钱的内容，按纪律删减、合并、下沉并修好指针。` +
		(issues?.length ? `\n\n结构检查发现这些问题，请一并修正：\n- ${issues.join("\n- ")}` : "");
	const tools: AgentTool<any>[] = [
		...createReadOnlyTools(ctx.cwd),
		createWriteTool(ctx.cwd),
		createEditTool(ctx.cwd),
	];
	// 与 init 主体同口径：不设轮数/时间上限（审计同样是大工程的收尾；挂在看门狗上只会把修到一半的产物丢下）
	const streamFn = createPiStreamFn(ctx);
	const auditSystem = systemMessage(buildAuditSystemPrompt(ctx.cwd));
	let steps = 0;
	let follows = 0;
	let lastText = "";
	onAudit(null);
	const nudge = (content: string): AgentMessage => ({ role: "user", content, timestamp: Date.now() });
	try {
		const messages = await runAgentLoop(
			[
				{
					role: "user",
					content: task,
					timestamp: Date.now(),
				},
			],
			{ messages: [auditSystem], tools },
			{
				model,
				maxTokens: AUDIT_MAX_TOKENS,
				convertToLlm,
				// 打算停下却没干活 / 末句是意图陈述 → 顶回去做完（最多两次）；审计也不能空手交报告
				getFollowUpMessages: async () => {
					if (follows >= 2) return [];
					if (steps === 0) {
						follows++;
						return [nudge("你还没有开始复核：现在读上述文件，按验收清单修正，然后用一两句话给出结论。")];
					}
					if (looksUnfinished(lastText)) {
						follows++;
						return [nudge("你最后一条是意图陈述而非结论：把要做的改动做完，然后用一两句话说明改了什么（没改也说明）。")];
					}
					return [];
				},
			},
			(event) => {
				if (event.type === "tool_execution_start") onAudit(++steps);
				else if (event.type === "message_end") {
					const m = event.message as { role?: string; content?: unknown };
					if (m.role === "assistant") lastText = extractText(m.content).trim() || lastText;
				}
			},
			signal,
			streamFn,
		);
		let text = findAssistantText(messages);
		if (text && !looksUnfinished(text)) return { ok: true, summary: text };
		if (!signal.aborted) {
			// 没结论就补问一次（无上限，但必须交回报告）
			const more = await runAgentLoop(
				[{ role: "user", content: "请用一两句话给出审计结论：改了什么（没改也说明）。", timestamp: Date.now() }],
				{ messages: [auditSystem, ...messages], tools: [] },
				{ model, maxTokens: AUDIT_MAX_TOKENS, convertToLlm },
				() => {},
				signal,
				streamFn,
			);
			text = findAssistantText(more);
		}
		if (text && !looksUnfinished(text)) return { ok: true, summary: text };
		if (text) return { ok: false, summary: `末句是意图陈述而非结论（未动手 ${steps} 步）：${text}` };
		return { ok: false, summary: findLlmError(messages) ?? "无结论" };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, summary: signal.aborted ? "已中止" : msg };
	}
}

async function runInitAgent(
	ctx: ExtensionContext,
	model: AnyModel,
	prompt: string,
	signal: AbortSignal,
	hooks: InitHooks,
): Promise<InitRunResult> {
	const tools: AgentTool<any>[] = [
		...createReadOnlyTools(ctx.cwd),
		createWriteTool(ctx.cwd),
		createEditTool(ctx.cwd),
		createBashTool(ctx.cwd),
	];
	// explore 扩展在场则一并挂上（缺席静默降级）：大仓库交给子代理并行摸底，
	// 省下 init 自己逐文件读的上下文与轮数；alwaysFresh——AGENTS.md 必须反映当前代码
	const exploreTool = getExploreApi()?.createSubagentTool(ctx, { alwaysFresh: true });
	if (exploreTool) tools.push(exploreTool);

	const streamFn = createPiStreamFn(ctx);
	const systemMsg = () => systemMessage(buildInitSystemPrompt(ctx.cwd, !!exploreTool));
	// 记录上下文文件写入前的 mtime：判断代理是否实际完成了写入
	const contextFile = path.join(ctx.cwd, CONTEXT_FILE);
	const mtimeBefore = fs.existsSync(contextFile) ? fs.statSync(contextFile).mtimeMs : 0;
	const written = () => fs.existsSync(contextFile) && fs.statSync(contextFile).mtimeMs > mtimeBefore + 1;
	// 上下文预算：超了就把旧工具结果剪成占位文本（工具结果都能 read 重取），防长跑撞天花板
	const contextBudget = Math.floor((model.contextWindow ?? 200_000) * CONTEXT_BUDGET_RATIO);

	// 无进展保护 +「没写完不许停」（跨压缩重启保留计数）
	let idleTurns = 0;
	let turnHadProgress = false;
	let wrapUpRequested = false;
	let followUps = 0;
	let lastAssistantText = "";
	let record: AgentMessage[] = []; // 过程记录（message_end 累积；压缩与兜底总结用）
	const userNudge = (content: string): AgentMessage => ({ role: "user", content, timestamp: Date.now() });
	const config: AgentLoopConfig = {
		model,
		maxTokens: INIT_MAX_TOKENS,
		convertToLlm,
		transformContext: async (messages) => pruneOldToolResults(messages, contextBudget),
		// 连续多轮没有产出（既没写文件也没派 explore）→ 注入收尾指令，让它落盘而不是空转
		getSteeringMessages: async () => {
			if (!wrapUpRequested) return [];
			wrapUpRequested = false;
			return [
				userNudge(
					`已连续 ${NO_PROGRESS_TURNS} 轮没有产出：立即把已确认的结论写入 ${CONTEXT_FILE} 并收尾；确实还需要探索就说明还缺什么。`,
				),
			];
		},
		// 打算停下但没写完（文件没被写过 / 末句是意图陈述）→ 顶回去做完（最多两次）
		getFollowUpMessages: async () => {
			if (followUps >= 2) return [];
			if (!written()) {
				followUps++;
				return [
					userNudge(`你还没有写入 ${CONTEXT_FILE}：立即把当前成果写入并给出一两句总结；确实无法完成就说明原因。`),
				];
			}
			if (looksUnfinished(lastAssistantText)) {
				followUps++;
				return [
					userNudge("你最后一条回复是意图陈述而非总结：还有要应用的改动就现在做完；否则用一两句话总结结果。"),
				];
			}
			return [];
		},
	};

	const onEvent = (event: { type: string; [k: string]: unknown }) => {
		switch (event.type) {
			case "tool_execution_start": {
				hooks.onToolCall();
				// 「有产出」= 写文件或派子代理摸底（纯读取不算，防陷在无限翻阅里）
				const t = event.toolName as string;
				if (t === "write" || t === "edit" || t === "explore") turnHadProgress = true;
				break;
			}
			case "turn_end": {
				idleTurns = turnHadProgress ? 0 : idleTurns + 1;
				turnHadProgress = false;
				if (idleTurns >= NO_PROGRESS_TURNS) {
					idleTurns = 0;
					wrapUpRequested = true;
				}
				break;
			}
			case "message_end": {
				const m = event.message as AgentMessage;
				record.push(m);
				if ((m as { role?: string }).role === "assistant") {
					lastAssistantText = extractText((m as { content?: unknown }).content).trim() || lastAssistantText;
				}
				break;
			}
			case "tool_execution_update": {
				// explore 的进度增量（details.total/succeeded）转成 init 状态行的探索计数
				const d = (event.partialResult as { details?: { total?: number; succeeded?: number } } | undefined)?.details;
				if (typeof d?.total === "number" && d.total > 0) hooks.onExploreProgress(d.succeeded ?? 0, d.total);
				break;
			}
		}
	};

	let compactions = 0;
	let notes: string | null = null; // 上次压缩后的要点（重启后作为起点）
	try {
		for (;;) {
			try {
				record = [];
				// prompts 会被追加到 context.messages 之后，系统提示只放 context（否则重复）
				const initial: AgentMessage[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
				if (notes) {
					initial.push(
						userNudge(
							`上下文超限，已把此前工作压缩成下面的记录。先读当前 ${CONTEXT_FILE} 与 .pi/skills 现状，再据此继续（需要原文时用 read 重读，不要凭空补写）：\n\n${notes}`,
						),
					);
				}
				const newMessages = await runAgentLoop(
					initial,
					{ messages: [systemMsg()], tools },
					config,
					onEvent,
					signal,
					streamFn,
				);
				record = newMessages;

				// 有文本不等于写完了：文件必须真被写过（半途而废的意图陈述会只留文本）
				const summary = findAssistantText(newMessages);
				if (summary) {
					if (!written()) {
						return { ok: false, summary: `${summary}（未检测到 ${CONTEXT_FILE} 写入，可能只是中途说明）` };
					}
					const blockers = looksUnfinished(summary) ? ["最后一条消息像未完成的意图陈述"] : [];
					const base = blockers.length ? `${summary}（${blockers.join("；")}）` : summary;
					// 半成品不让审计动手（改一份没写完的产物只会更乱）
					if (blockers.length || signal.aborted) return { ok: false, summary: base };
					// 审计 → 结构检查 → 还有问题就带问题再审计一轮（最多两轮），形成闭环
					const auditNotes: string[] = [];
					let issues: string[] = [];
					for (let round = 0; round < 2; round++) {
						const audit = await runInitAudit(ctx, model, signal, hooks.onAudit, issues.length ? issues : undefined);
						auditNotes.push(audit.ok ? audit.summary : `未完成（${audit.summary}）`);
						issues = checkContextArtifacts(ctx.cwd);
						if (!issues.length) break;
					}
					const structureNote = issues.length
						? `结构检查仍有 ${issues.length} 项：${issues.join("；")}`
						: "结构检查通过";
					return { ok: true, summary: `${base}；审计：${auditNotes.join(" / ")}；${structureNote}` };
				}

				// 没有任何文本输出：先取真实原因（模型错误 vs 其他），再兜底续问一轮拿总结
				const llmError = findLlmError(newMessages);
				if (!signal.aborted) {
					try {
						const nudge: AgentMessage = {
							role: "user",
							content: llmError
								? "刚才的模型调用出现了错误。请用一两句话向用户说明：AGENTS.md 写到哪一步、遇到了什么问题。"
								: "请立即停止工具调用，用一两句话总结你完成的工作（AGENTS.md / skill 写入了或更新了什么；若未完成也请说明当前进度）。",
							timestamp: Date.now(),
						};
						const more = await runAgentLoop(
							[nudge],
							{ messages: [systemMsg(), ...newMessages], tools: [] },
							{ model, maxTokens: INIT_MAX_TOKENS, convertToLlm },
							() => {},
							signal,
							streamFn,
						);
						const text = findAssistantText(more);
						if (text) {
							if (llmError) return { ok: false, summary: `${text}（模型调用出错：${llmError}）` };
							if (written()) return { ok: true, summary: text };
							return { ok: false, summary: `${text}（未检测到 ${CONTEXT_FILE} 写入，可重跑 /init）` };
						}
					} catch {
						// 兜底续问失败不掩盖主因，落到下面的如实上报
					}
				}
				return {
					ok: false,
					summary: llmError ? `模型调用出错：${llmError}` : `未产出总结，${CONTEXT_FILE} 可能未写完（可重跑 /init）`,
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				// 上下文超限 → 把过程记录压成要点后重启继续（不设轮数上限，这里是唯一的天花板）
				if (
					CONTEXT_OVERFLOW_RE.test(msg) &&
					compactions < MAX_COMPACTIONS &&
					record.length > 0 &&
					!signal.aborted
				) {
					const compacted = await compactInitNotes(ctx, model, renderProcessRecord(record), notes);
					// 压不出东西（如首轮就超限）就不重启：同一条提示重试只会白烧 token
					if (compacted.trim()) {
						compactions++;
						hooks.onCompact(compactions);
						notes = compacted;
						continue;
					}
				}
				return { ok: false, summary: msg.includes("abort") ? "已中止（会话结束或 /init cancel）" : msg };
			}
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, summary: msg.includes("abort") ? "已中止（会话结束或 /init cancel）" : msg };
	}
}

export default function (pi: ExtensionAPI) {
	// 同时只允许一个后台 init；会话关闭时中止
	let initAbort: AbortController | null = null;

	function launchBackgroundInit(ctx: ExtensionContext, prompt: string, label: string) {
		if (initAbort) {
			ctx.ui.notify("已有后台 init 进行中（/init cancel 可中止）", "warning");
			return;
		}
		const model = ctx.model as AnyModel | undefined;
		if (!model) {
			ctx.ui.notify("当前没有可用模型，无法启动后台 init", "error");
			return;
		}

		const controller = new AbortController();
		initAbort = controller;

		let toolCalls = 0;
		const modelName = `${model.provider}/${model.id}`;
		// 进度经官方 setStatus 通道推给 hud 行 1 动态区（与任务完成提醒同一通道，hud 按 key 映射样式）
		const setProgress = (text: string) => ctx.ui.setStatus("init", text);
		setProgress(`⚙ 初始化 · ${toolCalls} 步`);

		void (async () => {
			try {
				const result = await runInitAgent(ctx, model, prompt, controller.signal, {
					onToolCall: () => {
						toolCalls++;
						setProgress(`⚙ 初始化 · ${toolCalls} 步`);
					},
					onExploreProgress: (done, total) => setProgress(`⚙ 初始化 · 探索 ${done}/${total}`),
					onAudit: (steps) =>
						setProgress(steps === null ? "⚙ 初始化 · 审计中" : `⚙ 初始化 · 审计 ${steps} 步`),
					onCompact: (n) => setProgress(`⚙ 初始化 · 压缩上下文 ${n}/${MAX_COMPACTIONS}`),
				});
				ctx.ui.notify(
					result.ok
						? `init 完成：${result.summary}（/reload 后生效）`
						: `init 未完成：${result.summary}`,
					result.ok ? "info" : "warning",
				);
			} finally {
				ctx.ui.setStatus("init", undefined); // init 结束，清除进度状态
				initAbort = null;
			}
		})();

		ctx.ui.notify(`已在后台开始 init（${label}，${modelName}；/init cancel 可中止）`, "info");
	}

	// /init：分析代码库并生成/更新 AGENTS.md（后台独立上下文）
	pi.registerCommand("init", {
		description: "后台分析代码库，生成或更新 AGENTS.md（已有 CLAUDE.md 会被合并进来；/init cancel 中止）",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";
			if (arg) {
				// 不设轮数/时间上限，所以给一个显式的中断通道（已写入的内容保留在磁盘）
				if (arg === "cancel" || arg === "stop") {
					if (initAbort) {
						initAbort.abort(new Error("用户取消 /init"));
						ctx.ui.notify("已中止正在进行的 init（已写入的内容保留）", "info");
					} else {
						ctx.ui.notify("当前没有正在进行的 init", "info");
					}
					return;
				}
				ctx.ui.notify("/init 不接受参数（/init cancel 可中止进行中的任务）", "warning");
				return;
			}

			const filePath = path.join(ctx.cwd, CONTEXT_FILE);
			const claudePath = path.join(ctx.cwd, "CLAUDE.md");

			// 兼容 Claude Code 项目：先处理 CLAUDE.md
			if (fs.existsSync(claudePath)) {
				if (fs.existsSync(filePath)) {
					// 两者都存在：交给 AI 合并
					launchBackgroundInit(ctx, buildClaudeMergePrompt(), "合并 AGENTS.md 与 CLAUDE.md");
					return;
				}
				// 只有 CLAUDE.md：直接重命名为 AGENTS.md，再走常规更新流程
				try {
					fs.renameSync(claudePath, filePath);
					ctx.ui.notify("已将 CLAUDE.md 重命名为 AGENTS.md", "info");
				} catch (e) {
					ctx.ui.notify(`重命名失败：${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
			}

			const exists = fs.existsSync(filePath);
			let mode: "create" | "merge" | "overwrite" = "create";

			if (exists) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`${CONTEXT_FILE} 已存在，非交互模式下不覆盖。请先删除或改用交互模式。`, "warning");
					return;
				}
				const choice = await ctx.ui.select(`${CONTEXT_FILE} 已存在，如何处理？`, [
					"合并更新（保留现有内容，修正过时部分）",
					"完全重写（从零生成，覆盖现有文件）",
					"取消",
				]);
				if (!choice || choice.startsWith("取消")) return;
				mode = choice.startsWith("完全重写") ? "overwrite" : "merge";
			}

			const label = `${mode === "create" ? "生成" : mode === "merge" ? "更新" : "重写"} ${CONTEXT_FILE}`;
			// 与 runInitAgent 同一处探测（同一契约，同一结果）：决定提示词里要不要提 explore
			launchBackgroundInit(ctx, buildInitPrompt(mode, getExploreApi() !== null), label);
		},
	});

	// 1) /exit 斜杠命令别名
	pi.registerCommand("exit", {
		description: "退出 pi（立即结束当前会话；等同于直接输入 exit 或 /quit）",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	// 2) 不带 / 的 exit 也退出
	pi.on("input", async (event, ctx) => {
		if (event.text.trim() === "exit") {
			ctx.shutdown();
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	// 3.5) /rewind：回退到上一条用户消息（消息内容放回输入框）
	//      navigateTree 是命令 ctx 专属能力（事件 ctx 没有）：同一会话文件内把叶子切回
	//      该 user 消息的父节点（丢弃其后的全部内容），interactive-mode 会自动清屏重绘
	//      并在输入框为空时把消息文本填回输入框；双击 Ctrl+C 会预填本命令，回车即执行
	pi.registerCommand("rewind", {
		description: "回退到上一条用户消息，消息内容放回输入框",
		handler: async (_args, ctx) => {
			// 从根到叶遍历（getBranch 返回当前叶子路径，顺序为根→叶），找最后一条 user 消息
			const entries = ctx.sessionManager.getBranch();
			let targetId: string | null = null;
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e.type === "message" && e.message.role === "user") {
					targetId = e.id;
					break;
				}
			}
			if (!targetId) {
				ctx.ui.notify("没有可回退的用户消息", "warning");
				return;
			}
			// 叶子就是这条 user 消息（打断发生在回答生成前）：navigateTree 会 no-op，直接回填文本
			if (targetId === ctx.sessionManager.getLeafId()) {
				const entry = ctx.sessionManager.getEntry(targetId);
				const msg = entry && entry.type === "message" ? (entry.message as { content?: unknown }).content : undefined;
				const text = msg !== undefined ? extractText(msg) : "";
				if (text) ctx.ui.setEditorText(text);
				ctx.ui.notify("已把上一条消息放回输入框", "info");
				return;
			}
			const result = await ctx.navigateTree(targetId);
			if (result.cancelled) return;
			// interactive-mode 会在输入框为空时自动把被导航消息文本回填进输入框
			ctx.ui.notify("已回退到上一条消息，内容已在输入框", "info");
		},
	});

	// 3) Ctrl+C：第一次打断当前 turn；打断沉降完成后的窗口内再按一次 → 直接执行 /rewind 回退
	//    窗口起点是「沉降完成时刻」（agent_end）而非按键时刻：abort 有沉降期（isIdle 迟迟不变
	//    true），旧实现从按键起算会被沉降期吃掉大半窗口，且沉降期内误按会刷新起点，手感极差。
	//    现沉降期内按下的 Ctrl+C 只把回退意图排队（rewindArmed，不刷新窗口），空闲后的下一
	//    次 Ctrl+C 消费——双击连按永远有效，无需探准沉降结束的时机
	let currentCtx: ExtensionContext | null = null;
	// 注销函数（pi 返回的 unsubscribe）；同时充当「是否已注册」标志——shutdown 时注销并复位，
	// 新 session/reload 的新实例会重新注册，同一时刻只有一个活 handler（旧闭包不再幽灵残留）
	let ctrlCUnsubscribe: (() => void) | undefined;
	let abortPending = false; // 已发出 abort、尚未沉降完成（isIdle 仍 false）
	let settledAt = 0; // 打断沉降完成时刻（仅打断路径的 agent_end 会设置）；0 = 无打断历史
	let rewindArmed = false; // 沉降期内按过 Ctrl+C：回退意图已排队

	pi.on("session_start", async (event, ctx) => {
		// 启动清屏：仅 TUI 模式冷启动时执行（/reload、/new、/resume、/fork 不清屏）
		if (CLEAR_SCREEN_ON_STARTUP && event.reason === "startup" && ctx.mode === "tui") {
			clearScreenOnStartup(ctx);
		}

		currentCtx = ctx;
		abortPending = false;
		settledAt = 0;
		rewindArmed = false;
		if (ctx.mode !== "tui" || ctrlCUnsubscribe) return;
		ctrlCUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (data !== "\x03" || !currentCtx) return { consume: false };

			if (!currentCtx.isIdle()) {
				if (!abortPending) {
					// 第一次 Ctrl+C：中止当前 turn（打断后 agent_end 的最后一条 assistant 消息
					// stopReason=aborted，status-beacon 据此不触发完成提醒）
					abortPending = true;
					currentCtx.abort();
					currentCtx.ui.notify("已打断当前回合 · 打断完成后按 Ctrl+C 回退到上一条消息", "info");
				} else {
					// 沉降期内的 Ctrl+C：排队回退意图，不重复刷新窗口（abort 幂等重发一次保底）
					rewindArmed = true;
					currentCtx.abort();
					currentCtx.ui.notify("正在打断 · 稍后按 Ctrl+C 即回退到上一条消息", "info");
				}
				return { consume: true };
			}

			// 空闲时 Ctrl+C：消费回退意图（排队优先）或落在沉降后窗口内 → 执行 /rewind
			const now = Date.now();
			const hitRewind = rewindArmed
				? now - settledAt < REWIND_ARMED_WINDOW_MS
				: settledAt > 0 && now - settledAt < REWIND_WINDOW_MS;
			if (hitRewind) {
				rewindArmed = false;
				settledAt = 0;
				currentCtx.ui.setEditorText("/rewind");
				currentCtx.ui.notify("正在执行 /rewind：回退到上一条用户消息", "info");
				// 把当前按键替换成回车，让 /rewind 走正常命令提交流程
				return { consume: false, data: "\r" };
			}
			return { consume: false };
		});
	});

	// 打断沉降完成：窗口从此刻起算（仅打断路径；正常完成的 agent_end 不动 settledAt，
	// 避免正常回答结束后 2s 内按 Ctrl+C 误触发回退）
	pi.on("agent_end", async () => {
		if (abortPending) {
			abortPending = false;
			settledAt = Date.now();
		}
	});

	// 新回合开始：排队意图作废（用户已提交新消息继续对话，不再回退）
	pi.on("agent_start", async () => {
		rewindArmed = false;
	});

	pi.on("session_shutdown", async () => {
		currentCtx = null;
		abortPending = false;
		settledAt = 0;
		rewindArmed = false;
		ctrlCUnsubscribe?.();
		ctrlCUnsubscribe = undefined;
		// 中止后台 init；runInitAgent 会捕获 abort 并走失败收尾，此时 notify 对已关闭的会话是 no-op
		initAbort?.abort(new Error("会话结束"));
		initAbort = null;
	});
}
