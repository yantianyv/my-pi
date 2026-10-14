/**
 * secret / engine.ts — 脱敏与展开的核心
 *
 * 两个方向、四道用法：
 *   出口 maskText/maskDeep —— 把库里的值换成 {{sec:名字}}，把认得出形态的值换成 ref 或兜底占位；
 *   入口 expandText/expandDeep —— 把 ref 换回真值（只在工具执行前一刻，且 bash 不走这里）。
 *
 * 三条不可动摇的约束：
 *   1. 二进制与 provider 回放签名一律不碰 —— 改 base64 会让图片请求 400，改签名会让供应商拒绝重放；
 *   2. 短的已知值只在词边界替换，否则「test」会打掉「latest」；
 *   3. 认不出的形态用兜底占位而不是丢弃内容 —— 占位会告诉模型「这里被遮蔽了」，比静默保留原文安全。
 */
import type { Finding } from "./detect";
import { maskShapes, variants } from "./detect";
import { refFor } from "./refs";
import { MIN_MASK_LEN, WORD_BOUNDARY_LEN, type EntrySource, type Vault } from "./vault";

/** 不参与文本改写的键：图片/音频数据、供应商回放签名、不可见重放字段。签名是静默放行，不计入 skipped。 */
const OPAQUE_KEYS = new Set(["data", "thinkingSignature", "thoughtSignature", "textSignature"]);
/** 整个对象跳过改写的 type 值。 */
const OPAQUE_TYPES = new Set(["image", "audio", "binary"]);

export interface MaskOptions {
	/** 是否遮蔽认不出身份的凭证形态（tool_result / context / provider payload 打开）。 */
	shapes?: boolean;
	/** 最后一道自定义改写（长期指纹表用）：没有值的旧口令也在这里被认出来遮住。 */
	post?: (text: string) => { text: string; hits: number };
}

export interface MaskResult {
	text: string;
	hits: number;
}

const isAlnum = (ch: string): boolean => /[A-Za-z0-9]/.test(ch);

/**
 * 替换一处已知值。短值要求两侧不接字母数字（词边界），长值直接替换。
 * 返回新文本与命中次数。
 */
function replaceKnown(text: string, value: string, replacement: string): { text: string; hits: number } {
	const boundary = value.length < WORD_BOUNDARY_LEN;
	let out = "";
	let cursor = 0;
	let hits = 0;
	for (;;) {
		const at = text.indexOf(value, cursor);
		if (at < 0) break;
		const before = at > 0 ? text[at - 1] : "";
		const after = text[at + value.length] ?? "";
		const bounded = !boundary || (!isAlnum(before) && !isAlnum(after));
		out += text.slice(cursor, at);
		if (bounded) {
			out += replacement;
			hits++;
		} else {
			out += value;
		}
		cursor = at + value.length;
	}
	out += text.slice(cursor);
	return { text: out, hits };
}

/** 遮蔽一段文本：先按库里的值（含编码变体），再按凭证形态。 */
export function maskText(text: string, vault: Vault, options: MaskOptions = {}): MaskResult {
	let out = text;
	let hits = 0;
	for (const entry of vault.maskables()) {
		const direct = replaceKnown(out, entry.value, refFor(entry.name));
		out = direct.text;
		hits += direct.hits;
		if (direct.hits > 0) continue;
		// 原文不在，才值得试编码变体（变体匹配即整串换成同一个 ref，展开时回到原值）。
		for (const variant of variants(entry.value).slice(1)) {
			const alt = replaceKnown(out, variant, refFor(entry.name));
			if (alt.hits > 0) {
				out = alt.text;
				hits += alt.hits;
				break;
			}
		}
	}
	if (options.shapes) {
		// 出口只遮不收：工具输出侧的「像凭证」永远不建档（理由见 detect.ts 头注）。
		const shapes = maskShapes(out, "output");
		out = shapes.text;
		hits += shapes.hits;
	}
	if (options.post) {
		const tail = options.post(out);
		out = tail.text;
		hits += tail.hits;
	}
	return { text: out, hits };
}

export interface DeepMaskResult {
	value: unknown;
	hits: number;
	skipped: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 递归遮蔽：消息数组、工具结果、provider payload 都走它。 */
export function maskDeep(value: unknown, vault: Vault, options: MaskOptions = {}): DeepMaskResult {
	let hits = 0;
	let skipped = 0;

	const walk = (node: unknown, key: string | undefined): unknown => {
		if (typeof node === "string") {
			if (key !== undefined && OPAQUE_KEYS.has(key)) return node;
			const res = maskText(node, vault, options);
			hits += res.hits;
			return res.text;
		}
		if (Array.isArray(node)) return node.map((item) => walk(item, undefined));
		if (!isPlainObject(node)) return node;
		const type = node.type;
		if (typeof type === "string" && OPAQUE_TYPES.has(type)) {
			skipped++;
			return node;
		}
		const out: Record<string, unknown> = {};
		for (const [childKey, child] of Object.entries(node)) out[childKey] = walk(child, childKey);
		return out;
	};

	return { value: walk(value, undefined), hits, skipped };
}

export interface ExpandResult {
	text: string;
	used: string[];
	missing: string[];
	hits: number;
}

export interface ExpandDeepResult {
	value: unknown;
	used: string[];
	missing: string[];
	skipped: number;
}

/**
 * 递归展开：把 ref 换回真值。仅用于工具参数（bash 除外，它走 spawnHook 的按次环境变量，
 * 真值不进 argv）。跳过二进制与签名字段。
 */
export function expandDeep(value: unknown, resolve: (name: string) => string | undefined): ExpandDeepResult {
	const used: string[] = [];
	const missing: string[] = [];
	let skipped = 0;
	const track = (text: string): string =>
		text.replace(/\{\{sec:([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}/g, (raw: string, name: string) => {
			const real = resolve(name);
			if (real === undefined) {
				if (!missing.includes(name)) missing.push(name);
				return raw;
			}
			if (!used.includes(name)) used.push(name);
			return real;
		});

	const walk = (node: unknown, key: string | undefined): unknown => {
		if (typeof node === "string") {
			if (key !== undefined && OPAQUE_KEYS.has(key)) return node;
			return track(node);
		}
		if (Array.isArray(node)) return node.map((item) => walk(item, undefined));
		if (!isPlainObject(node)) return node;
		const type = node.type;
		if (typeof type === "string" && OPAQUE_TYPES.has(type)) {
			skipped++;
			return node;
		}
		const out: Record<string, unknown> = {};
		for (const [childKey, child] of Object.entries(node)) out[childKey] = walk(child, childKey);
		return out;
	};

	return { value: walk(value, undefined), used, missing, skipped };
}

// ---------------------------------------------------------------------------
// 自动收录：把工具输出里认出的凭证变成可引用的 ref
// ---------------------------------------------------------------------------

/** 生成一个不与现有条目冲突的自动名字。 */
function autoName(vault: Vault): string {
	for (let i = 1; ; i++) {
		const name = `auto_${i}`;
		if (!vault.has(name)) return name;
	}
}

/** 收录一个自动发现的凭证，返回新名字。同值已在库里则直接复用原名字。 */
export function adoptCandidate(vault: Vault, candidate: Pick<Finding, "value" | "label">, source: EntrySource = "output"): string {
	const existing = vault.list().find((entry) => entry.value === candidate.value);
	if (existing) return existing.name;
	const name = autoName(vault);
	vault.add({ name, value: candidate.value, kind: "secret", source, label: candidate.label });
	return name;
}

export { MIN_MASK_LEN };
