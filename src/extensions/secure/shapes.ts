/**
 * secure / shapes.ts — 高置信凭证形态识别
 *
 * 只认**有固定前缀/结构**的凭证（`sk-`、`ghp_`、`AKIA…`、`-----BEGIN … PRIVATE KEY-----` 等）：
 * 这些形态误报率接近零，认出来可以直接问用户要不要处理。
 *
 * 刻意不做的三件事（都曾造成误报）：
 *   - 不按关键词猜（`password: xxx` 那类）；
 *   - 不算熵、不打分、不按批量降权；
 *   - 不看语境排除（"这是文档示例"一类需要判断力的场景）。
 * 认不出就不认——漏掉一个凭证的代价，低于每天几十次误遮打断工作。
 */

export interface ShapeHit {
	/** 人话名称（面板标题用） */
	label: string;
	value: string;
	/** 在原文里的起止（供替换） */
	start: number;
	end: number;
}

interface Shape {
	label: string;
	re: RegExp;
}

/** 固定形态。顺序无意义（每个都独立扫描），但同一个值可能被多条命中，取最长者。 */
const SHAPES: Shape[] = [
	{ label: "GitHub 令牌", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
	{ label: "API 密钥", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
	{ label: "Stripe 密钥", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
	{ label: "AWS 访问密钥", re: /\b(?:AKIA|ASIA|AIDA)[0-9A-Z]{16}\b/g },
	{ label: "Google 密钥", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ label: "Slack 令牌", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ label: "GitLab 令牌", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
	{ label: "npm 令牌", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{ label: "HuggingFace 令牌", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
	{ label: "SendGrid 密钥", re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
	{ label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
	{ label: "私钥", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
	// 连接串：scheme://user:pass@host[/path]。尾部用 [^\s] 而非 [^\s/]，否则 `…:5432/app` 会截在端口处
	{ label: "连接串", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]{1,64}:[^\s/@]{6,}@[^\s]+/gi },
];

/**
 * 找出文本里所有高置信凭证。重叠时保留最长的一段（`sk-` 与连接串可能同时命中同一处）。
 * 返回按起点排序；已被更长的命中完全覆盖的短命中去掉。
 */
export function findShapes(text: string): ShapeHit[] {
	const hits: ShapeHit[] = [];
	for (const shape of SHAPES) {
		for (const match of text.matchAll(new RegExp(shape.re.source, shape.re.flags))) {
			const value = match[0];
			if (!value) continue;
			const start = match.index ?? 0;
			hits.push({ label: shape.label, value, start, end: start + value.length });
		}
	}
	hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
	const out: ShapeHit[] = [];
	for (const hit of hits) {
		const covered = out.some((kept) => hit.start >= kept.start && hit.end <= kept.end);
		if (!covered) out.push(hit);
	}
	return out;
}

/** 输入里是否含高置信凭证（只判断有无，不返回内容） */
export const hasShape = (text: string): boolean => findShapes(text).length > 0;
