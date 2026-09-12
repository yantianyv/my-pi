/**
 * ask/tool：ask 工具（AI 侧创建问卷）
 *
 * 流程：参数规范化 → 写问卷文件（.pi/questionnaires/<id>.json）→ TUI 整屏打开问卷页
 * （同批多次调用经 enqueueQuestionnaireUI 排队逐个打开）→ 提交则删文件并把答案
 * 作为工具结果返回；搁置（Esc）则草稿写回文件，提示 AI 结束本轮等用户 /answer。
 * 非 TUI 环境降级：文件保留待答，工具结果携带纯文本问卷让 AI 改在对话中提问。
 * action=cancel：AI 侧作废问卷（发现问错/搁置草稿过时时）——「问卷即文件」，按 id
 * 找到文件删除即撤回；正在整屏作答中的问卷无法作废（彼时本工具调用正挂起等待）。
 */
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { QuestionnairePage, type PageHooks, type PageResult, type TermDims } from "./page";
import { enqueueQuestionnaireUI, refreshPendingStatus, rememberCtx } from "./state";
import { createQuestionnaire, initStore, listQuestionnaires, removeQuestionnaire, saveQuestionnaire } from "./store";
import {
	answeredProgress,
	answerableQuestions,
	flattenQuestions,
	formatAnswersMessage,
	NOTE_STYLES,
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

/**
 * 页面钩子工厂（commands.ts 复用）：把 pi 官方 copyToClipboard 接进问卷页（Ctrl+P 一览里 C 键复制）。
 * pi 根导出已含跨平台 clip 读写，不自造实现；失败由页面捕获后提示。
 */
export function makePageHooks(): PageHooks {
	return { copyText: (text: string) => copyToClipboard(text) };
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "选项显示文本（简洁，1~5 个词）" }),
	description: Type.Optional(Type.String({ description: "该选项的含义/后果说明（权衡、影响）" })),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "题目 id（缺省自动 q1/q2…）" })),
	// type 不强制：漏传时由 normalizeQuestionnaire 容错推断（有 options → single，否则 → text），
	// schema 层必填会让 pi 校验直接拦下本可救回的调用（容错推断形同虚设）
	type: Type.Optional(
		StringEnum([...QUESTION_TYPES], {
			description:
				"题型：single 单选 / multi 多选 / text 简答 / confirm 是否 / rating 评分 / number 数字 / note 只读说明" +
				"（漏传时自动推断：有 options → single、有 content → note，否则 → text）。" +
				"note 只读说明（不参与作答与必答校验，用来把背景材料或待审草稿原文放进问卷；也占 12 题额度）",
		}),
	),
	question: Type.String({ description: "完整的问题文本（清晰、具体，以问号结尾）；note 题作小标题，可省（省时取 content 正文首行截断）" }),
	description: Type.Optional(Type.String({ description: "补充说明（背景、权衡），帮助用户决策" })),
	content: Type.Optional(
		Type.String({
			description:
				"note 说明题的正文（多行保留换行，支持 markdown 轻渲染；超长默认折叠、x 展开）。" +
				"典型用途：把待用户审阅的草稿/方案原文放进问卷，让用户边看边给意见",
		}),
	),
	style: Type.Optional(StringEnum([...NOTE_STYLES], { description: "note 说明题样式：info 普通（缺省）/ warn 警示 / quote 引用" })),
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

/** 自动标题最大长度（取第一题问句首行截断） */
const AUTO_TITLE_MAX = 30;

/** title 缺省兜底：取第一题问句首行截断做标题（模型偶尔漏传 title，不因小失误让整次创建失败） */
function deriveTitle(questions: unknown[]): string {
	for (const q of questions) {
		const raw = (q as { question?: unknown })?.question;
		const text = typeof raw === "string" ? raw.trim() : "";
		if (!text) continue;
		const oneLine = text.split(/\r?\n/)[0]!.trim();
		const chars = Array.from(oneLine);
		return chars.length > AUTO_TITLE_MAX ? `${chars.slice(0, AUTO_TITLE_MAX).join("")}…` : oneLine;
	}
	return "未命名问卷";
}

interface AskDetails {
	status: "submitted" | "shelved" | "deleted" | "text-fallback" | "cancelled";
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
			"创建一份问卷向用户批量提问（单选/多选/简答/判断/评分/数字/只读说明），或作废（action=cancel）待答问卷。" +
			"questions 必填（1~12 题；type 漏传自动推断：有 options→单选、有 content→说明、否则→简答；" +
			"note 说明题占 12 题额度，用 content 装待审草稿/背景原文，不参与作答与必答校验）。" +
			"问卷立即整屏弹出：Enter 提交（答案作工具结果返回）、Esc 搁置（可 /answer 续答，答案以用户消息送达）。" +
			"作废用 action=cancel + id（问卷即文件，删除即撤回；作答中的无法作废）。一次只创建一份。",
		promptSnippet: "创建问卷向用户批量提问（单选/多选/简答/判断/评分/数字/说明），或作废待答问卷",
		promptGuidelines: [
			"需要用户从多个方案中抉择、或有多个问题要确认时，用 ask 工具创建问卷，而不是在正文里罗列问题让用户逐条回复。",
			"需要用户审阅一段原文（待发草稿/方案/长说明）再给意见时，用 type=note 的说明题把原文放进问卷（content 装全文），后面跟 single/text 题收意见——用户在问卷里能直接看到内容，不必搁置问卷去对话里翻。",
			"single/multi 必带 options 2~8 个，不要加「其他」（会自动追加）。",
			"用户可能搁置问卷稍后回答：收到「已搁置」结果时不要追问，简要说明后结束本轮回复。",
			"用户在问卷页 Ctrl+D 删除问卷后会得到 status=deleted 的工具结果：说明这些信息已不再需要，不要追问、不要重建同一份问卷；确实还需要时先向用户确认。",
		],
		parameters: Type.Object({
			action: Type.Optional(
				StringEnum(["create", "cancel"], {
					description: "操作类型：create 创建问卷（默认）/ cancel 作废待答问卷（需 id，标题与题目不需要）",
				}),
			),
			id: Type.Optional(
				Type.String({ description: "问卷标识：create 时为语义化英文 slug（用作文件名，缺省自动生成）；cancel 时必填（要作废的问卷 id）" }),
			),
			title: Type.Optional(
				Type.String({ description: "问卷标题（一句话概括这份问卷要决定什么；建议提供，缺省时自动取第一题问句截断）" }),
			),
			description: Type.Optional(Type.String({ description: "问卷整体背景说明" })),
			questions: Type.Optional(
				Type.Array(QuestionSchema, {
					minItems: 1,
					maxItems: 12,
					description: "题目列表（create 必填，1~12 题；每题必须含 question 与 type；note 说明题同样占 12 题额度）",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberCtx(ctx);
			initStore(ctx.cwd);

			// ---- cancel：作废待答/搁置问卷（问卷即文件，删文件即撤回）----
			if (params.action === "cancel") {
				if (!params.id?.trim()) throw new Error("ask cancel 需要 id（要作废的问卷标识）");
				const want = params.id.trim().toLowerCase();
				const { items } = listQuestionnaires();
				const target = items.find(
					(i) => i.q.id.toLowerCase() === want || path.basename(i.file, ".json").toLowerCase() === want,
				);
				if (!target) {
					throw new Error(
						`问卷「${params.id}」不存在` +
							(items.length ? `（当前待答问卷：${items.map((i) => i.q.id).join("、")}）` : "（当前没有待答问卷）"),
					);
				}
				removeQuestionnaire(target.file);
				await refreshPendingStatus();
				return {
					content: [
						{
							type: "text",
							text: `已作废问卷「${target.q.title}」（${target.q.id}）——问卷文件已删除，用户不会再看到它。`,
						},
					],
					details: { status: "cancelled", title: target.q.title, total: answerableQuestions(target.q).length } satisfies AskDetails,
				};
			}

			// ---- create（默认）----
			if (!params.questions?.length) {
				throw new Error("ask 创建问卷需要 questions（至少 1 题，每题含完整问句 question 与题型 type）");
			}
			// title 容错：模型偶尔漏传，自动取第一题问句截断，不让整次创建失败
			const title = params.title?.trim() || deriveTitle(params.questions);

			const fallbackId = params.id?.trim() || `survey-${Date.now().toString(36)}`;
			const norm = normalizeQuestionnaire({ ...params, title, questions: params.questions, createdAt: new Date().toISOString() }, { fallbackId });
			if (!norm.ok) throw new Error(`问卷参数无效：${norm.error}`);
			const q = norm.q;

			const file = createQuestionnaire(q);
			await refreshPendingStatus();
			const total = answerableQuestions(q).length;
			const details: AskDetails = { status: "text-fallback", title: q.title, total, file };

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
					(tui, theme, _kb, done) => new QuestionnairePage(tui, theme, q, done, dims, makePageHooks()),
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

			// 用户主动删除：文件删掉、不再等待回答
			if (result.action === "delete") {
				removeQuestionnaire(file);
				await refreshPendingStatus();
				return {
					content: [
						{
							type: "text",
							text:
								`用户删除了问卷「${q.title}」（问卷文件已删除）。这通常意味着这些问题已不再需要——` +
								`请不要追问，也不要把同一份问卷重新创建一遍；若确实还需要这些信息，先向用户确认。`,
						},
					],
					details: { ...details, status: "deleted" },
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
							`用户暂时搁置了问卷「${q.title}」（已答 ${answeredProgress(q, result.answers)}/${total}，` +
							`草稿已保存）。用户可随时通过 /answer 命令继续作答，答案会以用户消息送达。` +
							`请简要告知用户这一点后结束本轮回复，不要追问这些问题。`,
					},
				],
				details: { ...details, status: "shelved", answered: answeredProgress(q, result.answers) },
			};
		},

		renderCall(args, theme) {
			const a = args as { action?: string; id?: string; title?: string; questions?: unknown[] };
			if (a.action === "cancel") return new Text(`${theme.fg("warning", "🗑 作废问卷")} 「${a.id ?? ""}」`, 0, 0);
			const n = Array.isArray(a.questions) ? a.questions.length : 0;
			const title = a.title?.trim() || (Array.isArray(a.questions) ? deriveTitle(a.questions) : "");
			return new Text(
				`${theme.fg("accent", "📝 创建问卷")} 「${title}」${a.title?.trim() ? "" : theme.fg("dim", "（自动标题）")}${theme.fg("dim", `（${n} 题）`)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, context) {
			// 执行失败（缺 title/questions/参数无效/问卷不存在等）时 details 为空，
			// 必须如实展示错误原因；否则所有失败都会被下面的 else 分支误报成「无 UI 降级」。
			if (context.isError) {
				const text = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();
				return new Text(theme.fg("error", `✗ ${text || "问卷操作失败"}`), 0, 0);
			}
			const d = result.details as AskDetails | undefined;
			let msg: string;
			if (d?.status === "submitted") msg = theme.fg("success", `✓ 用户已提交（${d.answered}/${d.total}）`);
			else if (d?.status === "shelved")
				msg = theme.fg("warning", `⏸ 用户已搁置（已答 ${d.answered}/${d.total} · /answer 可继续）`);
			else if (d?.status === "deleted") msg = theme.fg("warning", `🗑 用户已删除「${d.title}」`);
			else if (d?.status === "cancelled") msg = theme.fg("dim", `已作废「${d.title}」`);
			else msg = theme.fg("dim", "已创建（当前环境无 UI，转为文字提问）");
			return new Text(msg, 0, 0);
		},
	});
}
