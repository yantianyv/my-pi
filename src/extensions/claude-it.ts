/**
 * claude-it: 让 pi 更像 Claude Code
 *
 * - /exit 命令（/quit 的别名）与直接输入 exit 退出
 * - 对话进行中按 Ctrl+C 取消当前 agent 操作；打断后窗口内再按一次 Ctrl+C
 *   直接执行 /rewind 回退到上一条用户消息（内容放回输入框）
 * - /rewind 命令：回退到上一条用户消息，消息内容放回输入框
 * - /init 命令：后台独立上下文中分析代码库并生成/更新 AGENTS.md
 *   （已有 CLAUDE.md 会被归并进来；主会话零污染，期间可继续对话；
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
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { convertToLlm, createPiStreamFn } from "./shared/agent";
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
/** 双击 Ctrl+C 回退窗口（ms）：第一次 Ctrl+C 打断后，此窗口内的第二次 Ctrl+C 触发回退 */
const REWIND_WINDOW_MS = 2_000;

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
/** init 子代理最多多少轮（一轮 = 一次 LLM 调用 + 其工具调用） */
const INIT_MAX_TURNS = 30;
/** init 子代理超时 */
const INIT_TIMEOUT_MS = 10 * 60_000;
/** init 子代理单次输出上限 */
const INIT_MAX_TOKENS = 8192;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

function buildInitPrompt(mode: "create" | "merge" | "overwrite"): string {
	const modeInstructions = {
		create: `当前目录不存在 ${CONTEXT_FILE}，请从头创建它。`,
		merge:
			`当前目录已存在 ${CONTEXT_FILE}。先完整读取它，保留其中仍然准确的内容（尤其是人工编写的约定），` +
			`只更新过时的部分、补充缺失的部分，不要整篇重写。`,
		overwrite:
			`当前目录已存在 ${CONTEXT_FILE}，但用户要求完全重写：通读现有内容了解项目后，从零生成一份全新的 ${CONTEXT_FILE} 覆盖它。`,
	};
	return [
		`分析当前代码库并生成/更新上下文文件 ${CONTEXT_FILE}。`,
		"",
		modeInstructions[mode],
		"",
		"分析方法：",
		"1. 先看根目录清单（ls）、README、package.json / pyproject.toml / go.mod / Cargo.toml 等清单文件，确定项目用途、技术栈与包管理器",
		"2. 梳理目录结构，识别入口文件、核心模块、测试目录与配置文件",
		"3. 从脚本定义、Makefile、CI 配置中提取真实的构建 / 测试 / lint / 运行命令",
		"4. 大代码库用 grep / find 定位关键文件后精读片段，配合 bash（如 git log 看提交风格）；不要逐文件通读",
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
		"- 保持精炼（一般不超过 150 行），用路径引用代替粘贴代码原文",
		"- 内容使用中文（代码、命令、标识符除外）",
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
		"3. 同时按 /init 的标准补全：分析代码库（清单文件、scripts、目录结构、CI 配置），更新过时内容、补充缺失章节（常用命令必须真实存在，禁止编造）",
		"4. 用 write 工具把合并结果写入 AGENTS.md（中文，精炼，一般不超过 150 行）",
		"5. 用 bash 删除 CLAUDE.md（Windows 环境用 del 或 Remove-Item，按当前 shell 而定）",
		"6. 最后一条回复用一两句话总结：保留了什么、更新了什么、删除了 CLAUDE.md（会展示给用户）",
	].join("\n");
}

// ---------------------------------------------------------------------------
// init 子代理（独立上下文，后台运行）
// ---------------------------------------------------------------------------

function buildInitSystemPrompt(cwd: string): string {
	// 固定指令在前、cwd 在后，利于 provider 端 prompt 缓存命中
	return [
		"你是 init 代理，负责分析代码库并生成/更新 AGENTS.md 上下文文件。",
		"你拥有工具：read / ls / grep / find（探索）、write / edit（写文件）、bash（辅助命令，如 git log、删除文件）。",
		"要求：高效探索（grep/find 定位 + 精读片段，不逐文件通读）；只写经过验证的信息；完成后的一两条总结要精炼。",
		"",
		`工作目录：${cwd}`,
	].join("\n");
}

interface InitRunResult {
	ok: boolean;
	summary: string;
}

async function runInitAgent(
	ctx: ExtensionContext,
	model: AnyModel,
	prompt: string,
	signal: AbortSignal,
	onToolCall: () => void,
): Promise<InitRunResult> {
	const tools = [
		...createReadOnlyTools(ctx.cwd),
		createWriteTool(ctx.cwd),
		createEditTool(ctx.cwd),
		createBashTool(ctx.cwd),
	];

	const streamFn = createPiStreamFn(ctx);

	let turns = 0;
	const config: AgentLoopConfig = {
		model,
		maxTokens: INIT_MAX_TOKENS,
		convertToLlm,
		shouldStopAfterTurn: () => ++turns >= INIT_MAX_TURNS,
	};

	try {
		const userMessage: AgentMessage = { role: "user", content: prompt, timestamp: Date.now() };
		const newMessages = await runAgentLoop(
			[userMessage],
			{ systemPrompt: buildInitSystemPrompt(ctx.cwd), messages: [], tools },
			config,
			(event) => {
				if (event.type === "tool_execution_start") onToolCall();
			},
			signal,
			streamFn,
		);

		for (let i = newMessages.length - 1; i >= 0; i--) {
			const m = newMessages[i];
			if (m.role !== "assistant") continue;
			const text = m.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { type: "text"; text: string }).text)
				.join("\n")
				.trim();
			if (text) return { ok: true, summary: text };
		}
		return { ok: false, summary: "init 代理未产出总结（可能预算用尽）" };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, summary: msg.includes("abort") ? "已中止（超时或会话结束）" : msg };
	}
}

export default function (pi: ExtensionAPI) {
	// 同时只允许一个后台 init；会话关闭时中止
	let initAbort: AbortController | null = null;

	function launchBackgroundInit(ctx: ExtensionContext, prompt: string, label: string) {
		if (initAbort) {
			ctx.ui.notify("已有后台 init 进行中，请等待完成", "warning");
			return;
		}
		const model = ctx.model as AnyModel | undefined;
		if (!model) {
			ctx.ui.notify("当前没有可用模型，无法启动后台 init", "error");
			return;
		}

		const controller = new AbortController();
		initAbort = controller;
		const timer = setTimeout(() => controller.abort(new Error("init 超时")), INIT_TIMEOUT_MS);

		let toolCalls = 0;
		const modelName = `${model.provider}/${model.id}`;
		// 进度经官方 setStatus 通道推给 hud 行 1 动态区（与任务完成提醒同一通道，hud 按 key 映射样式）
		ctx.ui.setStatus("init", `⚙ init · ${toolCalls}`);

		void (async () => {
			try {
				const result = await runInitAgent(ctx, model, prompt, controller.signal, () => {
					toolCalls++;
					ctx.ui.setStatus("init", `⚙ init · ${toolCalls}`);
				});
				ctx.ui.notify(
					result.ok
						? `init 完成：${result.summary}（/reload 后生效）`
						: `init 未完成：${result.summary}`,
					result.ok ? "info" : "warning",
				);
			} finally {
				clearTimeout(timer);
				ctx.ui.setStatus("init", undefined); // init 结束，清除进度状态
				initAbort = null;
			}
		})();

		ctx.ui.notify(`已在后台开始 init（${label}，${modelName}）`, "info");
	}

	// /init：分析代码库并生成/更新 AGENTS.md（后台独立上下文）
	pi.registerCommand("init", {
		description: "后台分析代码库，生成或更新 AGENTS.md（已有 CLAUDE.md 会被合并进来）",
		handler: async (args, ctx) => {
			if (args?.trim()) {
				ctx.ui.notify("/init 不接受参数，固定生成 AGENTS.md", "warning");
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
			launchBackgroundInit(ctx, buildInitPrompt(mode), label);
		},
	});

	// 1) /exit 斜杠命令别名
	pi.registerCommand("exit", {
		description: "退出 pi（/quit 的别名）",
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
			const result = (await ctx.navigateTree(targetId)) as { cancelled: boolean; editorText?: string };
			if (result.cancelled) return;
			// interactive-mode 已在输入框为空时自动回填 editorText；此处仅兜底（RPC 模式等）
			if (result.editorText && !ctx.ui.getEditorText().trim()) {
				ctx.ui.setEditorText(result.editorText);
			}
			ctx.ui.notify("已回退到上一条消息，内容已在输入框", "info");
		},
	});

	// 3) Ctrl+C：第一次打断当前 turn；打断后窗口内再按一次 → 直接执行 /rewind 回退
	let currentCtx: ExtensionContext | null = null;
	// 注销函数（pi 返回的 unsubscribe）；同时充当「是否已注册」标志——shutdown 时注销并复位，
	// 新 session/reload 的新实例会重新注册，同一时刻只有一个活 handler（旧闭包不再幽灵残留）
	let ctrlCUnsubscribe: (() => void) | undefined;
	let lastAbortAt = 0;

	pi.on("session_start", async (event, ctx) => {
		// 启动清屏：仅 TUI 模式冷启动时执行（/reload、/new、/resume、/fork 不清屏）
		if (CLEAR_SCREEN_ON_STARTUP && event.reason === "startup" && ctx.mode === "tui") {
			clearScreenOnStartup(ctx);
		}

		currentCtx = ctx;
		if (ctx.mode !== "tui" || ctrlCUnsubscribe) return;
		ctrlCUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (data !== "\x03" || !currentCtx) return { consume: false };

			if (!currentCtx.isIdle()) {
				// 第一次 Ctrl+C：中止当前 turn（打断后 agent_end 的最后一条 assistant 消息
				// stopReason=aborted，task-alert 据此不触发完成提醒）
				lastAbortAt = Date.now();
				currentCtx.abort();
				return { consume: true };
			}

			// 空闲时再按 Ctrl+C：打断窗口内 → 直接执行 /rewind 回退到上一条消息
			if (lastAbortAt > 0 && Date.now() - lastAbortAt < REWIND_WINDOW_MS) {
				lastAbortAt = 0;
				currentCtx.ui.setEditorText("/rewind");
				currentCtx.ui.notify("正在执行 /rewind：回退到上一条用户消息", "info");
				// 把当前按键替换成回车，让 /rewind 走正常命令提交流程
				return { consume: false, data: "\r" };
			}
			return { consume: false };
		});
	});

	pi.on("session_shutdown", async () => {
		currentCtx = null;
		ctrlCUnsubscribe?.();
		ctrlCUnsubscribe = undefined;
		// 中止后台 init；runInitAgent 会捕获 abort 并走失败收尾，此时 notify 对已关闭的会话是 no-op
		initAbort?.abort(new Error("会话结束"));
		initAbort = null;
	});
}
