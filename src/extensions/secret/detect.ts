/**
 * secret / detect.ts — 认出疑似凭证，并给出「收 / 只遮 / 不管」三档判断
 *
 * 判定不是二值的：形态、关键词、编码、熵、来源各有分量，再减去文档示例、配置词形、哈希语境
 * 这些反向信号，最后按分数落档。逐项得分与理由随结果返回，便于测试与排查。
 *
 * 三档语义：
 *   adopt  —— 值得收进库（模型能拿它当 ref 接着用）。只有用户主动粘贴才可能到这里。
 *   mask   —— 像但不够可信：出口换成不能执行的占位，不建档。
 *   ignore —— 不是凭证，原样放过。少了这一档，配置项、哈希、UUID 全会被遮成占位符。
 *
 * 工具输出侧永远不给 adopt：模型读文档和读真密钥是同一个动作，误收会让库里塞满不认识的东西。
 *
 * 认不出的值仍有两条出路：粘贴时的「高熵确认」（问一次，答不是就记住），以及用户手动录入。
 */
import { shapePlaceholder } from "./refs";

export type Tier = "adopt" | "mask" | "ignore";
export type Source = "paste" | "output";

export interface Finding {
	value: string;
	/** 人话标签，用于占位文案与回执。 */
	label: string;
	tier: Tier;
	score: number;
	/** 逐项得分说明，测试与排查用。 */
	reasons: string[];
	/** 该值在文本里出现的每一处起点（出口遮蔽按它替换，不会误伤子串）。 */
	spans: number[];
}

/** 带固定形态的凭证。整体匹配即是要处理的值。 */
const SHAPES: { label: string; re: RegExp }[] = [
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
	{ label: "连接串", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]{1,64}:[^\s/@]{6,}@[^\s/]+/gi },
];

/** 关键词 + 分隔符（含中文与全角冒号）。值至少 6 字符，否则多是 `secret: true` 这类代码。 */
const KEYWORD_NAMES =
	"password|passwd|passphrase|pwd|pass|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|signing[_-]?key|client[_-]?secret|webhook[_-]?secret|credential|bearer|pin|密码|口令|密钥|令牌|私钥|凭证|账号密码|支付密码";

// 关键词本身用非捕获组：捕获组 1/2/3 留给值的三种写法（双引号、单引号、裸写），
// 取值时才不会把关键词当成值。
const KEYWORD_RE = new RegExp(
	`(?:^|[^A-Za-z0-9])(?:${KEYWORD_NAMES})\\s*(?:=|:|：|是|为|设为|改为|is|are)\\s*(?:"([^"\\n]{6,})"|'([^'\\n]{6,})'|([^\\s"'\`]{6,}))`,
	"gi",
);

/**
 * 值写在关键词前面（值在前、连接词在后）。两个必要条件：值与关键词之间要有空白，
 * 且要有「是/为/即」这类连接词——否则 `SenseNova Token Plan`、`output token / turn` 这种
 * 普通词组会被读成「某值 的 token」。
 */
const KEYWORD_TAIL_RE = new RegExp(
	`(?:"([^"\\n]{6,})"|'([^'\\n]{6,})'|([\\w.+/=-]{6,}))[\\s　]+(?:是|为|即|就是)[\\s　]*(?:${KEYWORD_NAMES})`,
	"gi",
);

/** CLI 旗标形式：`--token xxx`。 */
const FLAG_RE = /--?(?:password|passwd|passphrase|token|secret|api[-_]?key|credential)[=\s]+["'`]?([^\s"'`]{6,})/gi;

/** 授权头里的裸凭证（不是 JWT 也能认）。 */
const BEARER_RE = /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/g;

/** 明显不是值的词形（配置枚举）。 */
const CONFIG_VALUE =
	/^(?:true|false|null|none|yes|no|on|off|enabled|disabled|default|changeme|required|optional|undefined|empty|auto|testing|test|example|sample|dummy|placeholder|password|secret|token)$/i;
/** 值里出现中文散文：密钥可以带中文，但一整句话显然不是。 */
const CJK_VALUE = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * 示例/占位词，看值前面一小段与值本身。不加 \b：`YOUR_TOKEN_HERE` 里的 your 后面是下划线，
 * 字形边界卡不到，而它正是最该被挡下来的那种值。
 */
const EXAMPLE_WORDS = /example|sample|dummy|fake|placeholder|changeme|redacted|your|demo|notareal|not_a_real|foobar/i;
/** 占位符语法：`<TOKEN>`、`${VAR}`、`{{sec:名字}}`、`[PLACEHOLDER]`、`xxxx`、`…`。 */
const PLACEHOLDER_SHAPE = /(?:x{3,}|X{4,}|<[^>\n]{0,40}>|\{\{[^}\n]{0,40}\}\}|\$\{?[A-Za-z_]|\$[A-Z_]{2,}|\[[A-Z_ ]{3,}\]|\.\.\.|…)/;
/** 值本身写着 sha 前缀。 */
const CHECKSUM_PREFIX = /^(?:sha\d{1,3}|md5|blake2|integrity)[-_]/i;
/** 前面的语境是哈希/校验和/提交号。 */
const HASH_CONTEXT = /\b(?:integrity|sha\d*|hash|checksum|digest|etag|commit|revision|build|uuid|guid)\b[\s"':=#-]*$/i;

const PREFIX_WINDOW = 24;
/** 一次命中超过这个数就整批降权：一屏里冒出十几个凭证，多半是在读文档或测试夹具。 */
const BATCH_THRESHOLD = 4;
/** 单词符边界（编码形式检测时切候选片段用）。 */
const TOKEN_SPLIT = /[\s"'`´+,;()[\]{}<>|]+/;

const hasLower = (s: string): boolean => /[a-z]/.test(s);
const hasUpper = (s: string): boolean => /[A-Z]/.test(s);
const hasDigit = (s: string): boolean => /[0-9]/.test(s);

/** 剥掉值尾部的中英文标点：`密码：<值>。` 里值是括号里那段，不带句号。 */
const TRAILING_PUNCT = /[.,;:!?，。；：！？、）)】」』]+$/;
const trimTail = (value: string): string => value.replace(TRAILING_PUNCT, "");

/** 字符分布的香农熵（每字符比特）。 */
function shannon(text: string): number {
	const counts = new Map<string, number>();
	for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / text.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

interface RawHit {
	value: string;
	label: string;
	index: number;
	kind: "shape" | "context" | "encoded";
}

/** 长候选片段（≥16 字符的字母数字与 base64 符号），供编码形式检测用。 */
const TOKEN_RE = /[A-Za-z0-9+/=_-]{16,1024}/g;
/** 单次扫描内最多反解多少个片段（大输出不把 UI 卡住）。 */
const MAX_DECODE_ATTEMPTS = 4000;

function collectHits(text: string): RawHit[] {
	const hits: RawHit[] = [];
	for (const { label, re } of SHAPES) {
		for (const m of text.matchAll(re)) hits.push({ value: m[0], label, index: m.index ?? 0, kind: "shape" });
	}
	const fromMatch = (m: RegExpExecArray, label: (matched: string, value: string) => string): RawHit | undefined => {
		const raw = m[1] ?? m[2] ?? m[3];
		if (typeof raw !== "string") return undefined;
		const value = trimTail(raw);
		if (value.length < 6) return undefined;
		const offset = m[0].indexOf(raw);
		if (offset < 0) return undefined;
		return { value, label: label(m[0], value), index: (m.index ?? 0) + offset, kind: "context" };
	};
	for (const m of text.matchAll(KEYWORD_RE)) {
		const hit = fromMatch(m, (matched, value) => `${matched.slice(0, matched.indexOf(value)).trim().replace(/["'`:=：\s]+$/, "")} 的值`);
		if (hit) hits.push(hit);
	}
	for (const m of text.matchAll(KEYWORD_TAIL_RE)) {
		const hit = fromMatch(m, () => "关键词前的值");
		if (hit) hits.push(hit);
	}
	for (const m of text.matchAll(FLAG_RE)) {
		const hit = fromMatch(m, () => "命令行参数");
		if (hit) hits.push(hit);
	}
	for (const m of text.matchAll(BEARER_RE)) {
		const raw = m[1];
		if (typeof raw !== "string") continue;
		const value = trimTail(raw);
		if (value.length < 6) continue;
		hits.push({ value, label: "Bearer 令牌", index: (m.index ?? 0) + m[0].indexOf(raw), kind: "context" });
	}
	// 编码形式：把长片段反解一次，解开后能认出形态的才算。
	// 只对含数字的片段做（base64/hex 令牌几乎总带数字），路径与普通单词因此大多被跳过。
	let attempts = 0;
	for (const m of text.matchAll(TOKEN_RE)) {
		if (attempts >= MAX_DECODE_ATTEMPTS) break;
		const piece = m[0];
		if (!hasDigit(piece)) continue;
		attempts++;
		if (decodeOnce(piece) === undefined) continue;
		hits.push({ value: piece, label: "编码后的令牌", index: m.index ?? 0, kind: "encoded" });
	}
	return hits;
}

/**
 * 打分：形态 3 / 关键词 2 / 编码命中 2 / 高熵 1 / 主动粘贴 2，
 * 减去示例词、占位符语法、配置词形、哈希语境、含空白、批量命中。
 */
function scoreOf(value: string, text: string, index: number, kinds: Set<RawHit["kind"]>, source: Source, batch: number): { score: number; reasons: string[] } {
	const reasons: string[] = [];
	let score = 0;
	if (kinds.has("shape")) {
		score += 3;
		reasons.push("形态 +3");
	}
	if (kinds.has("context")) {
		score += 2;
		reasons.push("关键词 +2");
	}
	const prefix = text.slice(Math.max(0, index - PREFIX_WINDOW), index);

	// 编码形式：值本身不是凭证，但解开后能认出形态——编码往往意味着有人刻意隐藏。
	if (kinds.has("encoded")) {
		score += 3;
		reasons.push("编码命中 +3");
	}
	if (value.length >= 16 && shannon(value) >= 3.0 && (hasLower(value) || hasUpper(value)) && hasDigit(value)) {
		score += 1;
		reasons.push("高熵 +1");
	}
	if (source === "paste") {
		score += 2;
		reasons.push("主动粘贴 +2");
	}

	if (EXAMPLE_WORDS.test(value) || EXAMPLE_WORDS.test(prefix)) {
		score -= 3;
		reasons.push("示例词 −3");
	}
	if (PLACEHOLDER_SHAPE.test(value) || PLACEHOLDER_SHAPE.test(prefix)) {
		score -= 4;
		reasons.push("占位符语法 −4");
	}
	if (CONFIG_VALUE.test(value)) {
		score -= 4;
		reasons.push("配置词形 −4");
	}
	if (CJK_VALUE.test(value)) {
		score -= 3;
		reasons.push("含中文 −3");
	}
	if (CHECKSUM_PREFIX.test(value) || HASH_CONTEXT.test(prefix)) {
		score -= 2;
		reasons.push("哈希语境 −2");
	}
	if (/\s/.test(value)) {
		score -= 2;
		reasons.push("含空白 −2");
	}
	if (batch > BATCH_THRESHOLD) {
		score -= 2;
		reasons.push(`批量命中(${batch}) −2`);
	}
	return { score, reasons };
}

/** 值是不是某个已知形态的编码形式（base64 / hex / URL 编码）。 */
function decodeOnce(value: string): string | undefined {
	const candidates: string[] = [];
	if (/^[A-Za-z0-9+/]{16,}={0,2}$/.test(value) && value.length % 4 === 0) candidates.push(Buffer.from(value, "base64").toString("utf8"));
	if (/^[0-9a-fA-F]{16,}$/.test(value) && value.length % 2 === 0) candidates.push(Buffer.from(value, "hex").toString("utf8"));
	if (/%[0-9A-Fa-f]{2}/.test(value)) {
		try {
			candidates.push(decodeURIComponent(value));
		} catch {
			/* 非法百分号编码，忽略 */
		}
	}
	for (const decoded of candidates) {
		if (decoded.length < 8) continue;
		for (const { re } of SHAPES) {
			re.lastIndex = 0;
			if (re.test(decoded)) return decoded;
		}
	}
	return undefined;
}

const tierOf = (score: number, source: Source): Tier => {
	if (score >= 4 && source === "paste") return "adopt";
	if (score >= 1) return "mask";
	return "ignore";
};

export interface ScoutOptions {
	source: Source;
}

/** 扫一遍文本，给出每个可疑值的档位、得分与出现位置（按首次出现排序）。 */
export function scout(text: string, options: ScoutOptions): Finding[] {
	if (text.length === 0) return [];
	const raw = collectHits(text);
	if (raw.length === 0) return [];
	const grouped = new Map<string, { label: string; kinds: Set<RawHit["kind"]>; spans: number[]; first: number }>();
	for (const hit of raw) {
		const existing = grouped.get(hit.value);
		if (!existing) {
			grouped.set(hit.value, { label: hit.label, kinds: new Set([hit.kind]), spans: [hit.index], first: hit.index });
			continue;
		}
		existing.kinds.add(hit.kind);
		if (!existing.spans.includes(hit.index)) existing.spans.push(hit.index);
		if (hit.index < existing.first) existing.first = hit.index;
	}
	const findings: Finding[] = [];
	for (const [value, group] of grouped) {
		const scored = scoreOf(value, text, group.first, group.kinds, options.source, grouped.size);
		findings.push({
			value,
			label: group.label,
			tier: tierOf(scored.score, options.source),
			score: scored.score,
			reasons: scored.reasons,
			spans: group.spans,
		});
	}
	return findings.sort((a, b) => a.spans[0] - b.spans[0]);
}

/**
 * 出口遮蔽：ignore 档原样留下，其余换成占位；decide 给出替换文本，返回 undefined 表示放过。
 * 按记录的位置从后往前替换，不会误伤更长的串。
 */
export function maskShapes(text: string, source: Source, decide?: (finding: Finding) => string | undefined): { text: string; hits: number } {
	const findings = scout(text, { source });
	const spans: { index: number; length: number; replacement: string }[] = [];
	for (const finding of findings) {
		const replacement = decide ? decide(finding) : finding.tier === "ignore" ? undefined : shapePlaceholder(finding.label);
		if (replacement === undefined) continue;
		for (const index of finding.spans) spans.push({ index, length: finding.value.length, replacement });
	}
	spans.sort((a, b) => b.index - a.index);
	let out = text;
	for (const span of spans) out = out.slice(0, span.index) + span.replacement + out.slice(span.index + span.length);
	return { text: out, hits: spans.length };
}

/**
 * 没有关键词、也不匹配任何形态的高熵串 —— 粘贴时的「这像密钥」确认用。
 * 路径、URL、域名、纯词一律排除：它们比 base64 形态的密钥常见得多。
 */
export function highEntropySpans(text: string): string[] {
	const out: string[] = [];
	for (const piece of text.split(TOKEN_SPLIT)) {
		if (piece.length < 16 || piece.length > 256) continue;
		if (/[/\\]/.test(piece) || (piece.match(/\./g) ?? []).length >= 2) continue;
		if (!hasDigit(piece)) continue;
		// 经典摘要长度的纯 hex（32/40/64/128）几乎总是 hash 或提交号，不是密钥。
		if (/^[0-9a-f]+$/i.test(piece) && [32, 40, 64, 128].includes(piece.length)) continue;
		const classes = [hasLower(piece), hasUpper(piece), hasDigit(piece)].filter(Boolean).length;
		if (classes < 2) continue;
		if (shannon(piece) < 3.2) continue;
		if (CONFIG_VALUE.test(piece) || EXAMPLE_WORDS.test(piece) || PLACEHOLDER_SHAPE.test(piece)) continue;
		out.push(piece);
	}
	return [...new Set(out)];
}

/**
 * 一个值的等价写法：直接值、base64、base64url、hex（大小写）、URL 编码。
 * 只留 ≥ 8 字符的，短的替换等于误伤。顺序稳定，便于测试。
 */
export function variants(value: string): string[] {
	if (value.length === 0) return [];
	const buf = Buffer.from(value, "utf8");
	const b64 = buf.toString("base64");
	const all = [
		value,
		b64,
		b64.replace(/=+$/, ""),
		buf.toString("base64url"),
		buf.toString("hex"),
		buf.toString("hex").toUpperCase(),
		encodeURIComponent(value),
	];
	return [...new Set(all)].filter((v) => v.length >= 8);
}
