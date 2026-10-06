/**
 * context-init：生成与维护项目的 AGENTS.md（唯一上下文文件）
 *
 * - /init 命令：后台独立上下文分析项目，产出/维护 AGENTS.md；主会话零污染，期间可继续对话
 * - 内容规范：写每一行前过两问（不写会不会做错事 / 换一年换项目还成立吗），信息按
 *   「多常被需要」分四处放——每轮要用的进 AGENTS.md、相关时才用的进 .pi/skills/、
 *   在办的进该目录 STATUS.md、跨项目的进知识库；子目录 AGENTS.md 一律合并删除
 * - 目录：顺手对齐（同类只住一处、一处只放一类），不做硬校验
 * - 收尾：审计子代理（全新上下文，只删减/合并/移出/修指针）+ 确定性结构检查（死指针 / 索引对应）
 * - 可选联动：explore 在场则派子代理并行摸底（缺席自读）；进度经官方 setStatus("init") 交 hud
 *   （hud 缺席回落 pi 原生 footer）；本插件只依赖 pi 的文件系统、模型与官方 setStatus
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
import { CONTEXT_OVERFLOW_RE, pruneOldToolResults } from "./shared/context-budget";
import { getExploreApi } from "./shared/explore-api";
import { CONTEXT_FILE, checkContextArtifacts, findContextFiles } from "./shared/context-files";
import { createModelSetting, type ModelSetting } from "./shared/model-setting";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 子代理单次输出上限 */
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
// 提示词：内容规范与去向
// ---------------------------------------------------------------------------

/** AGENTS.md 里必须出现的元规则板块（四条，逐字写进产物） */
const SELF_SECTION = [
	"## 关于 AGENTS.md 自身",
	"",
	"- **一个项目只有这一份 AGENTS.md**：子系统细节写进 `.pi/skills/`，不在子目录另建 AGENTS.md。",
	"- **只写每轮都要用的**：相关时才用的进 skill；在办的进度与待办写进对应目录的 `STATUS.md`。",
	"- **每条规则要能回答「不写会导致什么错误」**；口径类标注出处，拿不准标「待确认」，禁止凭推断写死。",
	"- **会过期的不留在这里**：不写变更史、不写自我说明、不把临时状态留成本文件的一部分。",
].join("\n");

function buildInitPrompt(mode: "create" | "merge" | "overwrite", hasExplore: boolean): string {
	const modeInstructions = {
		create: `当前目录还没有 ${CONTEXT_FILE}，请从头创建它。`,
		merge:
			`当前目录已存在 ${CONTEXT_FILE}。先完整读取它，保留其中仍然准确的内容（尤其是人工编写的约定），` +
			`只更新过时的部分、补充缺失的部分，不要整篇重写；同时压缩冗余：重复条目合并、` +
			`变更史与解释性长句删掉——事实与约定一条不丢，只是表达变短。`,
		overwrite:
			`当前目录已存在 ${CONTEXT_FILE}，但用户要求完全重写：通读现有内容了解项目后，从零生成一份全新的 ${CONTEXT_FILE} 覆盖它。`,
	};
	const exploreStep = hasExplore
		? "大目录先用 explore 并行摸底（见探索纪律），再精读 grep / find 定位到的关键片段"
		: "用 grep / find 定位关键文件后精读片段";
	return [
		`分析本项目并生成/更新上下文文件 ${CONTEXT_FILE}。`,
		"",
		modeInstructions[mode],
		"",
		"分析步骤：",
		"1. 先看根目录清单（ls）、README，以及项目自带的清单文件（package.json / pyproject.toml / go.mod / Cargo.toml 等）",
		"2. 梳理目录结构，识别入口、核心模块、数据目录、脚本与配置",
		"3. 从脚本定义、Makefile、CI 配置里提取真实存在的命令；没有构建/测试就直接写明「无」",
		`4. ${exploreStep}，配合 bash（如 git log 看提交风格）；不要逐文件通读`,
		"",
		"章节按项目类型取舍，不需要的整节省略：",
		"- 代码项目：项目概述 / 常用命令（构建、测试、lint、运行，标注出处） / 目录结构 / 架构要点 / 代码风格与约定 / 测试说明 / 注意事项",
		"- 工作资料项目：这是什么、服务谁 / 目录与职责（一行一项） / 操作入口（脚本、CLI、索引入口） / 口径与依据（对外口径的唯一出处） / 周期性事项（什么时候做什么） / 注意事项",
		"- 两类都有：都取各自需要的章节，不要硬凑",
		`- 两类都必写：${SELF_SECTION.split("\n")[0]}（内容见系统提示词给定的四条）`,
		"",
		"硬性要求：",
		"- 只写经过验证的信息，命令必须真实存在并标注出处，禁止编造；不确定的内容标「待确认」",
		"- 保持精炼：用路径引用代替粘贴原文，只写能改变 AI 行为的行",
		"- 内容使用中文（代码、命令、标识符除外）",
		"- 建了 `.pi/skills/` 时，在总结里说明它首次会触发一次项目信任确认",
		`- 用 write 工具把结果写入 ${CONTEXT_FILE}；最后一条回复用一两句话总结写入了什么（会展示给用户）`,
	].join("\n");
}

/** 两者同时存在时：让 AI 合并为一份 AGENTS.md 并删除 CLAUDE.md */
function buildClaudeMergePrompt(): string {
	return [
		`当前目录同时存在 ${CONTEXT_FILE} 和 CLAUDE.md 两份上下文文件，将它们合并为一份 ${CONTEXT_FILE}（pi 原生读取 ${CONTEXT_FILE}，不再需要 CLAUDE.md）。`,
		"",
		"合并步骤：",
		`1. 完整读取 ${CONTEXT_FILE} 和 CLAUDE.md`,
		"2. 对比两份内容：保留仍然准确的信息（人工编写的约定优先），冲突处以更准确/更新者为准，去重",
		"3. 同时按 /init 的标准补全：分析项目（清单文件、脚本、目录结构），更新过时内容、补上缺的章节；命令必须真实存在，禁止编造；重复条目合并、变更史与解释性长句删掉，事实与约定不丢",
		"4. 按信息去向分流：子系统细节进 `.pi/skills/`、在办状态进对应目录的 `STATUS.md`，不要全堆进 AGENTS.md",
		`5. 用 write 工具把结果写入 ${CONTEXT_FILE}（中文，只写能改变 AI 行为的行），并确保含「## 关于 AGENTS.md 自身」一节`,
		"6. 用 bash 删除 CLAUDE.md（Windows 用 del 或 Remove-Item，按当前 shell 而定）",
		"7. 最后一条回复用一两句话总结：保留了什么、更新了什么、删除了 CLAUDE.md（会展示给用户）",
	].join("\n");
}

function buildInitSystemPrompt(cwd: string, hasExplore: boolean): string {
	const lines = [
		`你是 init 代理：生成/更新本项目的 ${CONTEXT_FILE}——项目唯一的上下文文件，每轮对话都会加载，字数即成本。`,
		hasExplore
			? "工具：read / ls / grep / find（探索）、explore（派只读子代理并行摸底）、write / edit（写文件）、bash（辅助命令，如 git log、移动或删除文件）。"
			: "工具：read / ls / grep / find（探索）、write / edit（写文件）、bash（辅助命令，如 git log、移动或删除文件）。",
		"",
		"写每一行前问两遍：",
		"- 不写它，AI 会不会做错事？答不上来就删。",
		"- 换一年、换个项目还成立吗？不成立说明它是局部信息或时效信息，换个地方放。",
		"",
		"信息按「多常被需要」分四处放，同一件事只出现一次：",
		"- 每轮都要用（不变量、命令、纪律）→ AGENTS.md",
		"- 相关时才用（子系统流程、口径、长清单、坑）→ `.pi/skills/<前缀>-<领域>/SKILL.md`（正文写概览与 references 索引，description 写明「何时该用」）",
		"- 在办的事（进度、待办、当前批次、截止）→ 该工作目录下的 `STATUS.md`；禁止写进 AGENTS.md 或 skill",
		"- 跨项目可复用的经验 → 在总结里建议沉淀到知识库",
		"禁止写进 AGENTS.md：子目录 AGENTS.md（一个项目只允许一份上下文文件）、进度与待办、变更史与自我说明、插件已经强制的规则（如钉钉发送纪律由插件拦截）、README 里能读到的内容、代码原文。",
		"",
		"目录对齐（顺手做，不要为它专门调研）：判据是「同类只住一处，一处只放一类」——脚本进 `tools/`、共享基准数据进 `data/`、可再生的大产物进 `output/`、临时文件进 `.tmp/`、旧批次进归档目录。发现同一类东西有两个名字的目录（如 `工具/` 与 `tools/`）→ 归并为一个并在总结里说明；明显缺失的机制目录可顺手创建。把本项目的目录约定写进 AGENTS.md 的一小段（至多 5 行）。",
		"",
		"已有子目录 AGENTS.md 的处理：把内容分流到上面四处（长期规则→skill、在办状态→STATUS.md、跨目录通用→根 AGENTS.md），然后删除源文件——内容不丢，源文件必删；最终总结里给出「哪个文件 → 去了哪里」的映射表。",
		"发现 CLAUDE.md：内容合并进 AGENTS.md 后删除它。",
		"",
		`${CONTEXT_FILE} 必写下面这一节（正文照抄，可微调措辞）：`,
		SELF_SECTION,
		"",
		"工作方法：先看目录结构与清单文件，再 grep/find 定位关键内容；大项目先派 explore；只写验证过的信息，命令必须有出处；随时把已确认的结论落盘（上下文被压缩时未落盘的会丢）；完成后的一两条总结要精炼。",
		"",
		`工作目录：${cwd}`,
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 子代理公共件
// ---------------------------------------------------------------------------

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

/** 找最后一条模型调用错误（stopReason=error）的 assistant 消息（v1 缺陷：
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


// ---------------------------------------------------------------------------
// 产物审计：全新上下文按纪律复核并直接修正（审计自身故障只报告，不影响产物）
// ---------------------------------------------------------------------------

function buildAuditSystemPrompt(cwd: string): string {
	return [
		"你是 init 审计代理：复核刚生成的上下文产物是否符合下面的纪律，并直接修正。",
		"你拥有工具：read / ls / grep / find（核对）、write / edit（修正）。",
		"",
		"验收清单：",
		"1. AGENTS.md 每一行都过两问：不写它 AI 会做错事吗？换一年、换个项目还成立吗？该删的删——变更史与自我说明、实现细节的长篇解释、README/清单文件里能自行读到的内容、插件已经强制的规则、粘贴的代码原文",
		"2. 分级正确：子系统细节在 `.pi/skills/`（description 写明「何时该用」）、在办状态在对应目录的 `STATUS.md`，都没有堆在 AGENTS.md；同一件事只出现一处；子目录不应再有 AGENTS.md",
		"3. 该留的没丢：不变量、真实存在的命令、坑、跨子系统约定仍在 AGENTS.md",
		"4. 有「## 关于 AGENTS.md 自身」一节，且内容与项目实际相符（目录约定、skill 前缀等）",
		"5. 修正只做删减、合并、移出、修指针：不新增事实、不改变项目的技术结论；人工编写的约定只搬不删（原文事实保留）",
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
	// 把具体文件列给审计（子目录上下文文件也是产物，不能靠它自己去找）
	const files = findContextFiles(ctx.cwd).map((f) => path.relative(ctx.cwd, f) || f);
	const target = [files.length ? `项目上下文文件（${files.join("、")}）` : CONTEXT_FILE, fs.existsSync(skillsDir) ? ".pi/skills/" : ""]
		.filter(Boolean)
		.join(" 与 ");
	const task =
		`复核并修正 ${target}：只保留值得每轮付钱的内容，按纪律删减、合并、移出并修好指针。` +
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

// ---------------------------------------------------------------------------
// init 主体
// ---------------------------------------------------------------------------

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
	// explore 扩展在场则一并挂上（缺席静默降级）：大仓库交给子代理并行摸底
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
								? `刚才的模型调用出现了错误。请用一两句话向用户说明：${CONTEXT_FILE} 写到哪一步、遇到了什么问题。`
								: `请立即停止工具调用，用一两句话总结你完成的工作（${CONTEXT_FILE} / skill 写入了或更新了什么；若未完成也请说明当前进度）。`,
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

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * /init 子代理模型（用途 `init`，默认策略 AUTO = 跟随当前会话模型）：
 * 默认跟随会话是为了与主会话共享同一模型能力与上下文口径；
 * 需要更省钱或更强时可在 /model-config 里把该用途指到别的策略或具体模型。
 */
const initModelSetting: ModelSetting = createModelSetting({
	purpose: "init",
	plugin: "context-init",
	label: "/init 子代理",
	defaultStrategy: "AUTO",
});

export default function (pi: ExtensionAPI) {
	// 同时只允许一个后台 init；会话关闭时中止
	let initAbort: AbortController | null = null;

	function launchBackgroundInit(ctx: ExtensionContext, prompt: string, label: string) {
		if (initAbort) {
			ctx.ui.notify("已有后台 init 进行中（/init cancel 可中止）", "warning");
			return;
		}
		const model = initModelSetting.resolve(ctx).model ?? (ctx.model as AnyModel | undefined);
		if (!model) {
			ctx.ui.notify("当前没有可用模型，无法启动后台 init", "error");
			return;
		}

		const controller = new AbortController();
		initAbort = controller;

		let toolCalls = 0;
		const modelName = `${model.provider}/${model.id}`;
		// 进度经官方 setStatus 通道推给 hud 行 1（hud 缺席回落 pi 原生 footer）
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

	// /init：分析项目并生成/维护 AGENTS.md（后台独立上下文）
	pi.registerCommand("init", {
		description: "后台生成/维护项目 AGENTS.md（cancel 中止）",
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

	pi.on("session_shutdown", async () => {
		// 中止后台 init；runInitAgent 会捕获 abort 并走失败收尾，此时 notify 对已关闭的会话是 no-op
		initAbort?.abort(new Error("会话结束"));
		initAbort = null;
	});
}
