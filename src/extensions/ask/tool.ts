/**
 * ask/tool：ask 工具（AI 侧创建问卷）
 *
 * 流程：参数规范化 → 写问卷文件（.pi/questionnaires/<id>.json）→ TUI 整屏打开问卷页
 * （同批多次调用经 enqueueQuestionnaireUI 排队逐个打开）→ 提交则删文件并把答案
 * 作为工具结果返回；搁置（Esc）则草稿写回文件，提示 AI 结束本轮等用户 /answer。
 * 非 TUI 环境降级：文件保留待答，工具结果携带纯文本问卷让 AI 改在对话中提问。
 */
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { QuestionnairePage, type PageResult, type TermDims } from "./page";
import { enqueueQuestionnaireUI, refreshPendingStatus, rememberCtx } from "./state";
import { createQuestionnaire, initStore, removeQuestionnaire, saveQuestionnaire } from "./store";
import {
	answeredProgress,
	flattenQuestions,
	formatAnswersMessage,
	normalizeQuestionnaire,
	QUESTION_TYPES,
} from "./types";

/**
 * 整屏 overlay 参数工厂（commands.ts 复用）：每次调用创建独立 dims，
 * visible 回调每帧捕获真实终端尺寸——组件渲染以它为权威高度（tui.terminal 可能滞后）。
 */
export function makeFullscreenOverlay(dims: TermDims) {
	return {
		overlay: true,
		overlayOptions: {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			visible: (w: number, h: number) => {
				dims.w = w;
				dims.h = h;
				return true;
			},
		},
	} as const;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "选项显示文本（简洁，1~5 个词）" }),
	description: Type.Optional(Type.String({ description: "该选项的含义/后果说明（权衡、影响）" })),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "题目 id（缺省自动 q1/q2…）" })),
	type: StringEnum([...QUESTION_TYPES], {
		description: "题型：single 单选 / multi 多选 / text 简答 / confirm 是否 / rating 评分 / number 数字",
	}),
	question: Type.String({ description: "完整的问题文本（清晰、具体，以问号结尾）" }),
	description: Type.Optional(Type.String({ description: "补充说明（背景、权衡），帮助用户决策" })),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description: "single/multi 的选项（2~8 个）；confirm 可给两个自定义标签；不要加「其他」，会自动追加",
		}),
	),
	allowOther: Type.Optional(Type.Boolean({ description: "single/multi 是否允许自由输入（默认 true）" })),
	min: Type.Optional(Type.Number({ description: "multi 最少选择数 / rating·number 下限（rating 默认 1）" })),
	max: Type.Optional(Type.Number({ description: "multi 最多选择数 / rating·number 上限（rating 默认 5）" })),
	multiline: Type.Optional(Type.Boolean({ description: "text 是否多行输入（默认 false）" })),
	placeholder: Type.Optional(Type.String({ description: "text/number 的占位提示" })),
	required: Type.Optional(Type.Boolean({ description: "是否必答（默认 true）；选答题用户可跳过" })),
});

interface AskDetails {
	status: "submitted" | "shelved" | "text-fallback";
	title: string;
	total: number;
	answered?: number;
	file?: string;
}

export function registerAskTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask",
		label: "问卷",
		description:
			"创建一份问卷向用户批量提问（单选/多选/简答/判断/评分/数字）。适用：需要用户在多个方案中决策、" +
			"或有多个问题堆积需要一次性确认。问卷会以整屏页面立即展示给用户作答：用户 Enter 提交（答案作为" +
			"工具结果返回），或 Esc 搁置（草稿保存，用户稍后可通过 /answer 命令继续回答，答案届时会以用户" +
			"消息形式送达）。一次只创建一份问卷，不要在同一批工具调用中多次使用本工具。",
		promptSnippet: "创建问卷向用户批量提问（单选/多选/简答/判断/评分/数字）",
		promptGuidelines: [
			"需要用户从多个方案中抉择、或有多个问题要确认时，用 ask 工具创建问卷，而不是在正文里罗列问题让用户逐条回复。",
			"ask 工具一次只创建一份问卷，不要与其他 ask 调用放在同一批；用户可能搁置问卷稍后回答，收到「已搁置」结果时不要追问，简要说明后结束本轮回复。",
		],
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "问卷标识（语义化英文 slug，用作文件名，缺省自动生成）" })),
			title: Type.String({ description: "问卷标题（一句话概括这份问卷要决定什么）" }),
			description: Type.Optional(Type.String({ description: "问卷整体背景说明" })),
			questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 12 }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberCtx(ctx);
			initStore(ctx.cwd);

			const fallbackId = params.id?.trim() || `survey-${Date.now().toString(36)}`;
			const norm = normalizeQuestionnaire({ ...params, createdAt: new Date().toISOString() }, { fallbackId });
			if (!norm.ok) throw new Error(`问卷参数无效：${norm.error}`);
			const q = norm.q;

			const file = createQuestionnaire(q);
			await refreshPendingStatus();
			const details: AskDetails = { status: "text-fallback", title: q.title, total: q.questions.length, file };

			// 非 TUI：无法弹整屏页，退化为文本提问（文件保留，TUI 侧 /answer 仍可作答）
			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text:
								`问卷「${q.title}」已创建（${path.relative(ctx.cwd, file)}），但当前环境无交互 UI，` +
								`无法弹出问卷页。请直接在对话中逐条向用户提问：\n\n${flattenQuestions(q)}`,
						},
					],
					details,
				};
			}

			// TUI：整屏打开问卷页（排队链保证同批多份逐个打开）
			const dims: TermDims = { w: 0, h: 0 };
			const result = await enqueueQuestionnaireUI(() =>
				ctx.ui.custom<PageResult>(
					(tui, theme, _kb, done) => new QuestionnairePage(tui, theme, q, done, dims),
					makeFullscreenOverlay(dims),
				),
			);

			if (result.action === "submit") {
				removeQuestionnaire(file);
				await refreshPendingStatus();
				return {
					content: [
						{ type: "text", text: `${formatAnswersMessage(q, result.answers)}\n\n请根据用户的回答继续工作。` },
					],
					details: { ...details, status: "submitted", answered: answeredProgress(q, result.answers) },
				};
			}

			// 搁置：草稿写回文件，等用户 /answer
			q.answers = result.answers;
			q.status = "draft";
			saveQuestionnaire(file, q);
			await refreshPendingStatus();
			return {
				content: [
					{
						type: "text",
						text:
							`用户暂时搁置了问卷「${q.title}」（已答 ${answeredProgress(q, result.answers)}/${q.questions.length}，` +
							`草稿已保存）。用户可随时通过 /answer 命令继续作答，答案会以用户消息送达。` +
							`请简要告知用户这一点后结束本轮回复，不要追问这些问题。`,
					},
				],
				details: { ...details, status: "shelved", answered: answeredProgress(q, result.answers) },
			};
		},

		renderCall(args, theme) {
			const a = args as { title?: string; questions?: unknown[] };
			const n = Array.isArray(a.questions) ? a.questions.length : 0;
			return new Text(`${theme.fg("accent", "📝 创建问卷")} 「${a.title ?? ""}」${theme.fg("dim", `（${n} 题）`)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as AskDetails | undefined;
			let msg: string;
			if (d?.status === "submitted") msg = theme.fg("success", `✓ 用户已提交（${d.answered}/${d.total}）`);
			else if (d?.status === "shelved")
				msg = theme.fg("warning", `⏸ 用户已搁置（已答 ${d.answered}/${d.total} · /answer 可继续）`);
			else msg = theme.fg("dim", "已创建（当前环境无 UI，转为文字提问）");
			return new Text(msg, 0, 0);
		},
	});
}
