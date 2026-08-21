/**
 * ask/types：问卷数据模型、校验规范化、答案语义与格式化
 *
 * 题型：single 单选 / multi 多选 / text 简答（multiline 多行）/ confirm 是否 /
 * rating 评分 / number 数字。normalizeQuestionnaire 同时服务 AI 工具参数与手写 JSON
 * （「问卷即文件」：.pi/questionnaires/*.json 可被 /answer 直接扫描识别），
 * 因此校验是容错式的：缺省值补齐、题型可按 options 有无推断、题目 id 自动分配。
 */

export const QUESTION_TYPES = ["single", "multi", "text", "confirm", "rating", "number"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** 题型中文标签（页面题头 [tag] 用） */
export const TYPE_TAGS: Record<QuestionType, string> = {
	single: "单选",
	multi: "多选",
	text: "简答",
	confirm: "判断",
	rating: "评分",
	number: "数字",
};

export interface QuestionOption {
	label: string;
	description?: string;
}

export interface Question {
	id: string;
	type: QuestionType;
	question: string;
	description?: string;
	/** single/multi 的选项（confirm 可选两个自定义标签，[0]=肯定 [1]=否定） */
	options?: QuestionOption[];
	/** single/multi 是否自动追加「其他（自由输入）」选项，默认 true */
	allowOther?: boolean;
	/** multi 最少选择数 / rating·number 下限（rating 默认 1） */
	min?: number;
	/** multi 最多选择数 / rating·number 上限（rating 默认 5） */
	max?: number;
	/** text 是否多行（默认 false） */
	multiline?: boolean;
	/** text/number 占位提示 */
	placeholder?: string;
	/** 是否必答（默认 true），选答题可跳过 */
	required?: boolean;
}

export type AnswerValue = string | string[] | boolean | number;
export type AnswerMap = Record<string, AnswerValue | undefined>;

export interface Questionnaire {
	version: 1;
	id: string;
	title: string;
	description?: string;
	createdAt: string;
	/** pending=未作答 / draft=搁置留草稿（answered 不留文件，提交即删） */
	status: "pending" | "draft";
	questions: Question[];
	answers: AnswerMap;
}

const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 8;

type NormalizeResult = { ok: true; q: Questionnaire } | { ok: false; error: string };

/** 容错规范化：AI 工具参数 / 手写 JSON 统一入口。失败返回人类可读错误（给 AI 或 notify） */
export function normalizeQuestionnaire(raw: unknown, opts: { fallbackId: string }): NormalizeResult {
	const err = (error: string): NormalizeResult => ({ ok: false, error });
	if (!raw || typeof raw !== "object") return err("问卷必须是 JSON 对象");
	const r = raw as Record<string, unknown>;

	const rawQuestions = r.questions;
	if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return err("questions 必须是非空数组");
	if (rawQuestions.length > MAX_QUESTIONS) return err(`题目数量超过上限 ${MAX_QUESTIONS}`);

	const usedIds = new Set<string>();
	const questions: Question[] = [];
	for (let i = 0; i < rawQuestions.length; i++) {
		const rq = rawQuestions[i] as Record<string, unknown> | null;
		if (!rq || typeof rq !== "object") return err(`第 ${i + 1} 题不是对象`);
		const text = typeof rq.question === "string" ? rq.question.trim() : "";
		if (!text) return err(`第 ${i + 1} 题缺少 question 文本`);

		// 题型缺省推断：有 options 视为单选，否则简答（手写 JSON 友好）
		let type = rq.type as QuestionType | undefined;
		if (type === undefined) type = Array.isArray(rq.options) ? "single" : "text";
		if (!(QUESTION_TYPES as readonly string[]).includes(type)) {
			return err(`第 ${i + 1} 题题型无效：${String(rq.type)}（可选 ${QUESTION_TYPES.join("/")}）`);
		}

		// 题目 id：缺省 q1/q2…，重复加数字后缀
		let id = typeof rq.id === "string" && rq.id.trim() ? rq.id.trim() : `q${i + 1}`;
		for (let n = 2; usedIds.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
		usedIds.add(id);

		const q: Question = { id, type, question: text };
		if (typeof rq.description === "string" && rq.description.trim()) q.description = rq.description.trim();
		if (typeof rq.placeholder === "string" && rq.placeholder) q.placeholder = rq.placeholder;
		if (typeof rq.multiline === "boolean") q.multiline = rq.multiline;
		q.required = typeof rq.required === "boolean" ? rq.required : true;

		if (type === "single" || type === "multi") {
			if (!Array.isArray(rq.options)) return err(`第 ${i + 1} 题（${TYPE_TAGS[type]}）缺少 options 数组`);
			const options: QuestionOption[] = [];
			for (const ro of rq.options) {
				const o = ro as Record<string, unknown> | null;
				const label = typeof o?.label === "string" ? o.label.trim() : "";
				if (!label) continue;
				const opt: QuestionOption = { label };
				if (typeof o?.description === "string" && o.description.trim()) opt.description = o.description.trim();
				options.push(opt);
			}
			if (options.length < 2) return err(`第 ${i + 1} 题有效选项不足 2 个`);
			if (options.length > MAX_OPTIONS) return err(`第 ${i + 1} 题选项超过上限 ${MAX_OPTIONS}`);
			q.options = options;
			q.allowOther = typeof rq.allowOther === "boolean" ? rq.allowOther : true;
			if (type === "multi") {
				if (typeof rq.min === "number") q.min = Math.max(0, Math.floor(rq.min));
				if (typeof rq.max === "number") q.max = Math.max(1, Math.floor(rq.max));
				if (q.min !== undefined && q.max !== undefined && q.min > q.max) {
					return err(`第 ${i + 1} 题 min 不能大于 max`);
				}
			}
		} else if (type === "confirm") {
			// 可选自定义两个标签（如 启用/禁用）
			if (Array.isArray(rq.options) && rq.options.length >= 2) {
				const pair: QuestionOption[] = [];
				for (const ro of rq.options.slice(0, 2)) {
					const o = ro as Record<string, unknown> | null;
					const label = typeof o?.label === "string" ? o.label.trim() : "";
					if (label) pair.push({ label });
				}
				if (pair.length === 2) q.options = pair;
			}
		} else if (type === "rating") {
			q.min = typeof rq.min === "number" ? Math.floor(rq.min) : 1;
			q.max = typeof rq.max === "number" ? Math.floor(rq.max) : 5;
			if (q.max <= q.min) return err(`第 ${i + 1} 题评分上限必须大于下限`);
		} else if (type === "number") {
			if (typeof rq.min === "number") q.min = rq.min;
			if (typeof rq.max === "number") q.max = rq.max;
			if (q.min !== undefined && q.max !== undefined && q.min > q.max) return err(`第 ${i + 1} 题 min 不能大于 max`);
		}
		questions.push(q);
	}

	// answers：仅保留已知题 id 的合法标量（草稿恢复用）
	const answers: AnswerMap = {};
	if (r.answers && typeof r.answers === "object") {
		for (const [k, v] of Object.entries(r.answers as Record<string, unknown>)) {
			if (!questions.some((q) => q.id === k)) continue;
			if (typeof v === "string" || typeof v === "boolean" || typeof v === "number" || Array.isArray(v)) {
				answers[k] = v as AnswerValue;
			}
		}
	}

	return {
		ok: true,
		q: {
			version: 1,
			id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : opts.fallbackId,
			title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : "未命名问卷",
			description: typeof r.description === "string" && r.description.trim() ? r.description.trim() : undefined,
			createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
			status: r.status === "draft" ? "draft" : "pending",
			questions,
			answers,
		},
	};
}

/** 必答完整性判定（提交校验用；选答题跳过不算未答，由调用方先判 required） */
export function isAnswered(q: Question, v: AnswerValue | undefined): boolean {
	if (v === undefined) return false;
	switch (q.type) {
		case "single":
			return typeof v === "string" && v.trim().length > 0;
		case "confirm":
			return typeof v === "boolean";
		case "multi":
			return Array.isArray(v) && v.length >= Math.max(1, q.min ?? 1);
		case "text":
		case "number":
			return typeof v === "string" && v.trim().length > 0;
		case "rating":
			return typeof v === "number";
	}
}

/** 进度计数：有任何实质内容即算「已答」（含选答题） */
export function answeredProgress(qn: Questionnaire, answers: AnswerMap): number {
	return qn.questions.filter((q) => {
		const v = answers[q.id];
		if (v === undefined) return false;
		if (typeof v === "string") return v.trim().length > 0;
		if (Array.isArray(v)) return v.length > 0;
		return true;
	}).length;
}

/** 答案值 → 显示文本 */
export function formatValue(q: Question, v: AnswerValue): string {
	if (q.type === "confirm" && typeof v === "boolean") {
		if (q.options && q.options.length >= 2) return v ? q.options[0]!.label : q.options[1]!.label;
		return v ? "是" : "否";
	}
	if (Array.isArray(v)) return v.join("、");
	return String(v);
}

/** 提交后回传给 AI 的消息文本（工具结果 / sendUserMessage 共用） */
export function formatAnswersMessage(qn: Questionnaire, answers: AnswerMap): string {
	const lines = [`[问卷回答] ${qn.title}`];
	qn.questions.forEach((q, i) => {
		const v = answers[q.id];
		const empty =
			v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);
		lines.push(`${i + 1}. ${q.question} → ${empty ? "（跳过）" : formatValue(q, v!)}`);
	});
	return lines.join("\n");
}

/** 非 TUI 环境降级：把问卷铺成纯文本，让 AI 转而在对话中逐条提问 */
export function flattenQuestions(qn: Questionnaire): string {
	const lines: string[] = [];
	qn.questions.forEach((q, i) => {
		const req = q.required === false ? "（选答）" : "";
		lines.push(`${i + 1}. [${TYPE_TAGS[q.type]}]${req} ${q.question}`);
		if (q.options) {
			for (const o of q.options) lines.push(`   - ${o.label}${o.description ? `：${o.description}` : ""}`);
		}
		if ((q.type === "single" || q.type === "multi") && q.allowOther !== false) {
			lines.push("   - 其他（自由输入）");
		}
		if (q.type === "rating") lines.push(`   （${q.min ?? 1} ~ ${q.max ?? 5} 分）`);
	});
	return lines.join("\n");
}
