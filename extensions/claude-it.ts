/**
 * claude-it: 让 pi 更像 Claude Code
 *
 * - /exit 命令（/quit 的别名）与直接输入 exit 退出
 * - 对话进行中按 Ctrl+C 取消当前 agent 操作
 * - /init 命令：分析代码库并生成/更新 AGENTS.md（已有 CLAUDE.md 会被归并进来）
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// /init：分析代码库，生成上下文文件（对齐 Claude Code 的 /init）
// ---------------------------------------------------------------------------

/** 唯一的上下文文件目标：AGENTS.md（pi 原生读取；CLAUDE.md 只会被归并，不会被生成） */
const CONTEXT_FILE = "AGENTS.md";

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
		`请分析当前代码库并生成上下文文件 ${CONTEXT_FILE}（对齐 Claude Code /init 的行为）。`,
		"",
		modeInstructions[mode],
		"",
		"分析方法：",
		"1. 先看根目录清单、README、package.json / pyproject.toml / go.mod / Cargo.toml 等清单文件，确定项目用途、技术栈与包管理器",
		"2. 梳理目录结构，识别入口文件、核心模块、测试目录与配置文件",
		"3. 从脚本定义、Makefile、CI 配置中提取真实的构建 / 测试 / lint / 运行命令",
		"4. 代码库较大时，优先用 explore 工具派子代理并行探索，不要自己逐文件读",
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
		`- 最后用 write 工具把结果写入 ${CONTEXT_FILE}，并用一两句话总结写入了什么`,
	].join("\n");
}

/** 两者同时存在时：让 AI 合并为一份 AGENTS.md 并删除 CLAUDE.md */
function buildClaudeMergePrompt(): string {
	return [
		"当前目录同时存在 AGENTS.md 和 CLAUDE.md 两份上下文文件，请将它们合并为一份 AGENTS.md（pi 原生读取 AGENTS.md，不再需要 CLAUDE.md）。",
		"",
		"合并步骤：",
		"1. 完整读取 AGENTS.md 和 CLAUDE.md",
		"2. 对比两份内容：保留仍然准确的信息（人工编写的约定优先），冲突处以更准确/更新者为准，去重",
		"3. 同时按 /init 的标准补全：分析代码库（清单文件、scripts、目录结构、CI 配置），更新过时内容、补充缺失章节（常用命令必须真实存在，禁止编造；大项目优先用 explore 子代理探索）",
		"4. 用 write 工具把合并结果写入 AGENTS.md（中文，精炼，一般不超过 150 行）",
		"5. 用 bash 删除 CLAUDE.md（Windows 环境用 del 或 Remove-Item，按当前 shell 而定）",
		"6. 用一两句话总结：保留了什么、更新了什么、删除了 CLAUDE.md",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	// /init：分析代码库并生成/更新 AGENTS.md
	pi.registerCommand("init", {
		description: "分析代码库，生成或更新 AGENTS.md（已有 CLAUDE.md 会被合并进来）",
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
					ctx.ui.notify("检测到 AGENTS.md 与 CLAUDE.md 并存，开始 AI 合并 …", "info");
					pi.sendUserMessage(buildClaudeMergePrompt());
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

			ctx.ui.notify(
				`开始分析代码库并${mode === "create" ? "生成" : mode === "merge" ? "更新" : "重写"} ${CONTEXT_FILE} …`,
				"info",
			);
			pi.sendUserMessage(buildInitPrompt(mode));
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

	// 3) Ctrl+C 取消当前 turn（Claude Code 风格）
	let currentCtx: ExtensionContext | null = null;
	let ctrlCHandlerInstalled = false;

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.mode !== "tui" || ctrlCHandlerInstalled) return;
		ctrlCHandlerInstalled = true;
		ctx.ui.onTerminalInput((data) => {
			if (data === "\x03" && currentCtx && !currentCtx.isIdle()) {
				currentCtx.abort();
				return { consume: true };
			}
			return { consume: false };
		});
	});

	pi.on("session_shutdown", async () => {
		currentCtx = null;
	});
}
