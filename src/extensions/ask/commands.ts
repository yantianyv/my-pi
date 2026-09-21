/**
 * ask/commands：/answer 命令（人类侧回答问卷）
 *
 * 扫描 .pi/questionnaires/：0 份提示；1 份直接整屏打开；多份先弹选择器。
 * 提交 → 删文件 + 答案经 pi.sendUserMessage 发给 AI（agent 忙时 followUp 排队）；
 * 搁置（Esc）→ 草稿写回文件，随时 /answer 继续。
 * 手写 JSON 问卷（非 ask 工具创建）同样经此路径作答。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QuestionnairePage, QuestionnairePicker, type PageResult, type TermDims } from "./page";
import { refreshPendingStatus, rememberCtx, setWorkingWait } from "./state";
import { initStore, listQuestionnaires, removeQuestionnaire, saveQuestionnaire } from "./store";
import { makeFullscreenOverlay, makePageHooks } from "./tool";
import { answeredProgress, answerableQuestions, formatAnswersMessage } from "./types";

export function registerAnswerCommand(pi: ExtensionAPI): void {
	pi.registerCommand("answer", {
		description: "回答待处理的问卷（多份时先选择；Enter 提交 / Esc 搁置）",
		handler: async (_args, ctx) => {
			rememberCtx(ctx);
			initStore(ctx.cwd);

			const { items, invalid } = listQuestionnaires();
			if (invalid.length > 0) {
				ctx.ui.notify(`已忽略 ${invalid.length} 个无法解析的问卷文件：${invalid.join("、")}`, "warning");
			}
			if (items.length === 0) {
				ctx.ui.notify("没有待回答的问卷", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`有 ${items.length} 份待答问卷，但当前环境无交互 UI，无法作答`, "warning");
				return;
			}

			// 多份时先选（选择器里可直接删除过时问卷：D 按两次）
			let target = items[0]!;
			if (items.length > 1) {
				const picked = await ctx.ui.custom<string | null>(
					(_tui, theme, _kb, done) =>
						new QuestionnairePicker(theme, items, done, {
							onDelete: (file) => {
								removeQuestionnaire(file);
								void refreshPendingStatus();
							},
						}),
					{ overlay: true, overlayOptions: { width: "70%", minWidth: 50, maxHeight: "60%" } },
				);
				if (picked === null) return;
				target = items.find((i) => i.file === picked)!;
			}

			const dims: TermDims = { w: 0, h: 0 };
			setWorkingWait(`回答问卷「${target.q.title}」`);
			let result: PageResult;
			try {
				result = await ctx.ui.custom<PageResult>(
					(tui, theme, _kb, done) => new QuestionnairePage(tui, theme, target.q, done, dims, makePageHooks()),
					makeFullscreenOverlay(dims),
				);
			} finally {
				setWorkingWait(null);
			}

			if (result.action === "submit") {
				removeQuestionnaire(target.file);
				await refreshPendingStatus();
				// 答案作为用户消息送达（agent 忙时排为 followUp，闲时立即触发新一轮）
				pi.sendUserMessage(formatAnswersMessage(target.q, result.answers), { deliverAs: "followUp" });
				// 提交回执：用户自己也能看到「答了什么」，不必翻回上次的问卷
				ctx.ui.notify(
					`✓ 已提交「${target.q.title}」（${answeredProgress(target.q, result.answers)}/${answerableQuestions(target.q).length} 题已答），答案已发送给 AI`,
					"info",
				);
				return;
			}

			// 用户主动删除：删文件 + 告知（下次 /answer 不再看到）
			if (result.action === "delete") {
				removeQuestionnaire(target.file);
				await refreshPendingStatus();
				ctx.ui.notify(`已删除问卷「${target.q.title}」，不会再等待回答`, "info");
				return;
			}

			target.q.answers = result.answers;
			target.q.status = "draft";
			saveQuestionnaire(target.file, target.q);
			await refreshPendingStatus();
			ctx.ui.notify(`问卷「${target.q.title}」已搁置（草稿已保存），随时可用 /answer 继续`, "info");
		},
	});
}
