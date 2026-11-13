/**
 * ask/types：问卷数据模型、校验规范化、答案语义与格式化
 *
 * 题型：single 单选 / multi 多选 / text 简答（multiline 多行）/ confirm 是否 /
 * rating 评分 / number 数字 / note 只读说明（不参与作答，供 AI 插入背景材料或
 * 待审草稿原文——用户「先看内容再给意见」，不必搁置问卷去对话里翻）。
 * 问卷级 context：AI 的补充背景/上一条回复原文（问卷整屏弹出会遮住聊天记录，
 * 问题依赖刚说的内容时把它挂到问卷顶部展示），页面渲染为引用块。
 * 条件题 showIf：按**前面的题**的当前作答决定本题是否出现（只许引更早的题，故天然无环）；
 * 未出现的题不渲染、不计进度、不参与必答校验、答案回执里也不出现。
 * normalizeQuestionnaire 同时服务 AI 工具参数与手写 JSON
 * （「问卷即文件」：.pi/questionnaires/*.json 可被 /answer 直接扫描识别），
 * 因此校验是容错式的：缺省值补齐、题型可按 options/content 有无推断、题目 id 自动分配。
 */

export const QUESTION_TYPES = ["single", "multi", "text", "confirm", "rating", "number", "note"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** 题型中文标签（页面题头 [tag] 用） */
export const TYPE_TAGS: Record<QuestionType, string> = {
	single: "单选",
	multi: "多选",
	text: "简答",
	confirm: "判断",
	rating: "评分",
	number: "数字",
	note: "说明",
};

/** note 题型样式（页面左侧色条与标题取色） */
export const NOTE_STYLES = ["info", "warn", "quote"] as const;
export type NoteStyle = (typeof NOTE_STYLES)[number];

export interface QuestionOption {
	label: string;
	description?: string;
}

/** 条件题的判定算子（引用了题型不允许的算子时归一化报错） */
export const SHOW_OPS = ["equals", "notEquals", "includes", "notIncludes", "answered"] as const;
export type ShowOp = (typeof SHOW_OPS)[number];

/** 条件里参与比对的字面值（统一按字符串比对，布尔单独比） */
export type ShowValue = string | number | boolean;

export interface ShowCondition {
	/** 依赖的题 id（必须出现在本题之前） */
	questionId: string;
	/** 判定方式：equals/notEquals 等于（value 为数组时任一命中）/ includes·notIncludes 多选是否含该项 / answered 已作答 */
	op: ShowOp;
	/** 比对值；op=answered 时省略 */
	value?: ShowValue | ShowValue[];
}

export interface Question {
	id: string;
	type: QuestionType;
	question: string;
	description?: string;
	/** note 题正文（只读展示，保留换行；缺省时 question 标题即正文） */
	content?: string;
	/** note 题样式（缺省 info） */
	style?: NoteStyle;
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
	/** 条件展示：满足才出现（仅 single/multi/confirm/rating/number/text 均可设，只能引用本题之前的题） */
	showIf?: ShowCondition;
}

export type AnswerValue = string | string[] | boolean | number;
export type AnswerMap = Record<string, AnswerValue | undefined>;

export interface Questionnaire {
	version: 1;
	id: string;
	title: string;
	description?: string;
	/** 问卷级背景上下文（AI 的补充信息/上一条回复原文；页面顶部引用块展示，多行保留换行） */
	context?: string;
	createdAt: string;
	/** pending=未作答 / draft=搁置留草稿（answered 不留文件，提交即删） */
	status: "pending" | "draft";
	questions: Question[];
	answers: AnswerMap;
}

const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 8;
/** note 说明题标题缺省时取正文首行的截断长度 */
const NOTE_TITLE_MAX = 30;

type NormalizeResult = { ok: true; q: Questionnaire } | { ok: false; error: string };

/** showIf 归一化：校验依赖题存在且在本题之前；算子与依赖题型不匹配即报错（宁可爱错不静默失效） */
function normalizeShowIf(
	raw: unknown,
	idx: number,
	earlier: Question[],
): { ok: true; cond: ShowCondition } | { ok: false; error: string } {
	const at = `第 ${idx + 1} 题 showIf`;
	const r = raw as Record<string, unknown> | null;
	if (!r || typeof r !== "object") return { ok: false, error: `${at} 必须是对象：{questionId, op, value}` };
	const questionId = typeof r.questionId === "string" ? r.questionId.trim() : "";
	if (!questionId) return { ok: false, error: `${at} 缺少 questionId（依赖的题 id）` };
	const dep = earlier.find((q) => q.id === questionId);
	if (!dep) {
		const known = earlier.map((q) => q.id).join("、") || "（无）";
		return { ok: false, error: `${at} 引用的题「${questionId}」不存在或不在本题之前（此前各题：${known}）` };
	}
	if (dep.type === "note") return { ok: false, error: `${at} 不能依赖说明题「${questionId}」（它没有作答）` };
	const op = (typeof r.op === "string" ? r.op : "equals") as ShowOp;
	if (!(SHOW_OPS as readonly string[]).includes(op)) {
		return { ok: false, error: `${at} 的 op 无效：${String(r.op)}（可选 ${SHOW_OPS.join("/")}）` };
	}
	if (op === "answered") return { ok: true, cond: { questionId, op } };
	const isMultiDep = dep.type === "multi";
	if ((op === "includes" || op === "notIncludes") && !isMultiDep) {
		return { ok: false, error: `${at} 的 op=${op} 只能用于依赖多选（依赖题「${questionId}」是${TYPE_TAGS[dep.type]}）` };
	}
	if ((op === "equals" || op === "notEquals") && isMultiDep) {
		return { ok: false, error: `${at} 依赖的是多选，请改用 includes/notIncludes（或 answered）` };
	}
	const rawValue = r.value;
	let value: ShowValue | ShowValue[];
	if (Array.isArray(rawValue)) {
		const vals = rawValue.filter((v): v is ShowValue => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
		if (vals.length === 0) return { ok: false, error: `${at} 的 value 不能是空数组` };
		value = vals;
	} else if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
		value = rawValue;
	} else {
		return { ok: false, error: `${at} 缺少 value（op=${op} 需要的比对值）` };
	}
	// 选项题的值必须能对上某个选项标签（含自动追加的「其他」，允许自由文本，不校）
	if (dep.type === "single" || dep.type === "confirm") {
		const labels =
			dep.type === "confirm"
				? (dep.options && dep.options.length >= 2 ? dep.options.slice(0, 2) : [{ label: "是" }, { label: "否" }]).map((o) => o.label)
				: (dep.options ?? []).map((o) => o.label);
		const bad = (Array.isArray(value) ? value : [value])
			.filter((v) => typeof v === "string")
			.filter((v) => !labels.includes(v));
		if (bad.length > 0) {
			return {
				ok: false,
				error: `${at} 的 value「${bad.join("、")}」不是题「${questionId}」的选项（可用：${labels.join("、")}${dep.type === "confirm" ? "" : "，或自由输入的文本"}）`,
			};
		}
	}
	return { ok: true, cond: { questionId, op, value } };
}

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
		const content = typeof rq.content === "string" ? rq.content.replace(/\r\n?/g, "\n") : "";

		// 题型缺省推断：有 options 视为单选、有 content 视为说明，否则简答（手写 JSON 友好）
		let type = rq.type as QuestionType | undefined;
		if (type === undefined) type = Array.isArray(rq.options) ? "single" : content.trim() ? "note" : "text";
		if (!(QUESTION_TYPES as readonly string[]).includes(type)) {
			return err(`第 ${i + 1} 题题型无效：${String(rq.type)}（可选 ${QUESTION_TYPES.join("/")}）`);
		}
		// 说明题允许没有标题（正文即内容）；其余题型必须有 question
		if (!text && type !== "note") return err(`第 ${i + 1} 题缺少 question 文本`);
		if (!text && !content.trim()) return err(`第 ${i + 1} 题（说明）需要 question 标题或 content 正文`);

		// 题目 id：缺省 q1/q2…，重复加数字后缀
		let id = typeof rq.id === "string" && rq.id.trim() ? rq.id.trim() : `q${i + 1}`;
		for (let n = 2; usedIds.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
		usedIds.add(id);

		const q: Question = { id, type, question: text || "说明" };
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
		} else if (type === "note") {
			// 只读说明：正文 content 原样保留换行；缺省时把标题当正文用（短说明无需重复写两遍）
			const body = content.trim() ? content : text;
			if (body.trim()) q.content = body.replace(/^\n+|\n+$/g, "");
			// 标题缺省：取正文首行截断（免得只写 content 的说明题标题全是「说明」）
			if (!text) {
				const firstLine = (q.content ?? "").split("\n")[0]!.trim();
				const chars = Array.from(firstLine);
				q.question = chars.length > NOTE_TITLE_MAX ? `${chars.slice(0, NOTE_TITLE_MAX).join("")}…` : firstLine || "说明";
			}
			if (NOTE_STYLES.includes(rq.style as NoteStyle)) q.style = rq.style as NoteStyle;
			q.required = false; // 说明题永不参与必答校验
		} else if (type === "rating") {
			q.min = typeof rq.min === "number" ? Math.floor(rq.min) : 1;
			q.max = typeof rq.max === "number" ? Math.floor(rq.max) : 5;
			if (q.max <= q.min) return err(`第 ${i + 1} 题评分上限必须大于下限`);
		} else if (type === "number") {
			if (typeof rq.min === "number") q.min = rq.min;
			if (typeof rq.max === "number") q.max = rq.max;
			if (q.min !== undefined && q.max !== undefined && q.min > q.max) return err(`第 ${i + 1} 题 min 不能大于 max`);
		}
		// 条件题：只能引用前面的题（顺序即依赖，天然不会成环）
		if (rq.showIf !== undefined) {
			if (type === "note") return err(`第 ${i + 1} 题（说明）不能设 showIf`);
			const cond = normalizeShowIf(rq.showIf, i, questions);
			if (!cond.ok) return err(cond.error);
			q.showIf = cond.cond;
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
			context:
				typeof r.context === "string" && r.context.trim() ? r.context.replace(/\r\n?/g, "\n").trim() : undefined,
			createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
			status: r.status === "draft" ? "draft" : "pending",
			questions,
			answers,
		},
	};
}

/** 可答题（排除 note 只读说明 + 按当前作答隐藏的条件题）：进度分母、必答校验、答案回执都取它 */
export function answerableQuestions(qn: Questionnaire, answers: AnswerMap = qn.answers): Question[] {
	const vis = visibilityMap(qn, answers);
	return qn.questions.filter((q) => q.type !== "note" && vis.get(q.id) !== false);
}

/** 逐题可见性（依赖只能是更早的题，单遍就能推完；依赖题自己不可见时一律视为不满足） */
export function visibilityMap(qn: Questionnaire, answers: AnswerMap): Map<string, boolean> {
	const vis = new Map<string, boolean>();
	for (const q of qn.questions) vis.set(q.id, isShown(q, vis, answers));
	return vis;
}

/** 单题是否可见：vis 只需包含本题之前各题的结果 */
export function isShown(q: Question, vis: Map<string, boolean>, answers: AnswerMap): boolean {
	return q.showIf ? matchesShow(q.showIf, vis, answers) : true;
}

/** 单题是否可见（浅包装，供渲染/焦点这类逐题查询） */
export function isVisible(q: Question, vis: Map<string, boolean>): boolean {
	return vis.get(q.id) !== false;
}

function matchesShow(cond: ShowCondition, vis: Map<string, boolean>, answers: AnswerMap): boolean {
	if (vis.get(cond.questionId) === false) return false;
	const actual = answers[cond.questionId];
	if (cond.op === "answered") return hasContent(actual);
	if (actual === undefined) return false;
	const wants = Array.isArray(cond.value) ? cond.value : [cond.value!];
	if (cond.op === "includes" || cond.op === "notIncludes") {
		const hit = Array.isArray(actual) && actual.some((a) => wants.some((w) => sameScalar(a, w)));
		return cond.op === "includes" ? hit : !hit;
	}
	const hit = wants.some((w) => sameScalar(actual, w));
	return cond.op === "equals" ? hit : !hit;
}

/** 作答值里有实质内容（条件题的「已作答」口径；页面/回执也用它判选答题是否填了） */
export function hasContent(v: AnswerValue | undefined): boolean {
	if (v === undefined) return false;
	if (typeof v === "string") return v.trim().length > 0;
	if (Array.isArray(v)) return v.length > 0;
	return true;
}

/** 标量比较：布尔容许「是/否、true/false」互相书写，数字容许字符串写法 */
function sameScalar(actual: AnswerValue, want: ShowValue): boolean {
	if (typeof actual === "boolean") {
		if (typeof want === "boolean") return actual === want;
		const s = String(want).trim().toLowerCase();
		return actual ? ["true", "1", "是", "yes", "y"].includes(s) : ["false", "0", "否", "no", "n"].includes(s);
	}
	if (typeof actual === "number") {
		if (typeof want === "number") return actual === want;
		const n = Number(String(want).trim());
		return Number.isFinite(n) ? actual === n : String(actual) === String(want).trim();
	}
	if (typeof want === "number") return String(actual).trim() === String(want);
	return String(actual).trim() === String(want).trim();
}

/** 问卷文案里的人称词命中（「你/我/您/咱们」：问卷里指向不明，应省略或改用「AI」「用户」） */
export interface PersonWordHit {
	/** 出现位置（如「3. 题题干」） */
	where: string;
	/** 命中处上下文片段 */
	snippet: string;
}

export function findPersonWords(qn: Questionnaire): PersonWordHit[] {
	const hits: PersonWordHit[] = [];
	const scan = (where: string, text?: string): void => {
		if (!text) return;
		const re = /(你|您|咱们|我们|我)/g;
		for (let m = re.exec(text); m; m = re.exec(text)) {
			hits.push({ where, snippet: text.slice(Math.max(0, m.index - 6), m.index + 9).replace(/\s+/g, " ").trim() });
		}
	};
	scan("标题", qn.title);
	scan("问卷说明", qn.description);
	scan("上下文", qn.context);
	qn.questions.forEach((q, i) => {
		const tag = `${i + 1}. ${q.type === "note" ? "说明" : "题"}`;
		scan(`${tag}题干`, q.question);
		scan(`${tag}描述`, q.description);
		scan(`${tag}正文`, q.content);
		q.options?.forEach((o, j) => {
			scan(`${tag}选项 ${j + 1}`, o.label);
			scan(`${tag}选项 ${j + 1}描述`, o.description);
		});
	});
	return hits;
}

/** 必答完整性判定（提交校验用；选答题跳过不算未答，由调用方先判 required） */
export function isAnswered(q: Question, v: AnswerValue | undefined): boolean {
	if (q.type === "note") return true; // 说明题无需作答（不阻塞提交）
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

/** 进度计数：note 与未出现的条件题不计入分母。
 *  必答题按 isAnswered 计（多选只勾 1 项而 min=2 不算已答，否则进度条说「已答」、状态行说「未完成」），
 *  选答题按「填了内容」计（选填项不因未达 min 永远欠着进度）。 */
export function answeredProgress(qn: Questionnaire, answers: AnswerMap): number {
	return answerableQuestions(qn, answers).filter((q) =>
		q.required !== false ? isAnswered(q, answers[q.id]) : hasContent(answers[q.id]),
	).length;
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

/** 提交后回传给 AI 的消息文本（工具结果 / sendUserMessage 共用）；说明题不占行（AI 已知其内容） */
export function formatAnswersMessage(qn: Questionnaire, answers: AnswerMap): string {
	const lines = [`[问卷回答] ${qn.title}`];
	const answerable = answerableQuestions(qn, answers);
	if (answerable.length === 0) lines.push("（本问卷仅含只读说明，用户已确认）");
	answerable.forEach((q, i) => {
		const v = answers[q.id];
		lines.push(`${i + 1}. ${q.question} → ${hasContent(v) ? formatValue(q, v!) : "（跳过）"}`);
	});
	return lines.join("\n");
}

/** 非 TUI 环境降级：把问卷铺成纯文本，让 AI 转而在对话中逐条提问（说明题内容原样附上） */
export function flattenQuestions(qn: Questionnaire): string {
	const lines: string[] = [];
	if (qn.context) {
		lines.push("[上下文]");
		for (const ln of qn.context.split("\n")) lines.push(` │ ${ln}`);
		lines.push("");
	}
	const vis = visibilityMap(qn, qn.answers);
	qn.questions.forEach((q, i) => {
		const cond = q.showIf ? `（仅当${describeShow(q.showIf, qn)}）` : "";
		if (q.type === "note") {
			lines.push(`${i + 1}. [${TYPE_TAGS.note}·只读] ${q.question}`);
			for (const ln of (q.content ?? "").split("\n")) lines.push(`   │ ${ln}`);
			return;
		}
		if (!isVisible(q, vis)) {
			lines.push(`${i + 1}. [${TYPE_TAGS[q.type]}] ${q.question}${cond} —— 当前作答下无需提问`);
			return;
		}
		const req = q.required === false ? "（选答）" : "";
		lines.push(`${i + 1}. [${TYPE_TAGS[q.type]}]${req} ${q.question}${cond}`);
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

/** 条件的人话描述（回执/降级文本里说明该题为何不出现） */
export function describeShow(cond: ShowCondition, qn: Questionnaire): string {
	const dep = qn.questions.find((q) => q.id === cond.questionId);
	const name = dep ? `「${dep.question}」` : cond.questionId;
	if (cond.op === "answered") return `${name}已作答`;
	// 判断题的 true/false 要说成「是/否」（与页面/回执里的选项标签一致），否则用户看到 raw true
	const label = (v: ShowValue): string => {
		if (dep?.type === "confirm" && typeof v === "boolean") {
			if (dep.options && dep.options.length >= 2) return dep.options[v ? 0 : 1]!.label;
			return v ? "是" : "否";
		}
		return String(v);
	};
	const vals = (Array.isArray(cond.value) ? cond.value : [cond.value ?? ""]).map((v) => `「${label(v)}」`).join("或");
	const verbs: Record<Exclude<ShowOp, "answered">, string> = {
		equals: "等于",
		notEquals: "不等于",
		includes: "包含",
		notIncludes: "不包含",
	};
	return `${name}${verbs[cond.op as Exclude<ShowOp, "answered">]}${vals}`;
}
