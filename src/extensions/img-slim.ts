/**
 * img-slim: 图片请求体预算（防 DeepSeek 等上游 48MiB 请求体 413）
 *
 * 背景（2026-09 实测取证）：
 * - DeepSeek《图像理解》限制表：请求体 48 MiB、单图 32 MiB、图片仅允许出现在 user 消息。
 *   越限实测：46.4MB 通过、52.6MB 失败；报错形态随链路——直连返回 openresty 的 413 HTML，
 *   opencode-go 中转返回 413 + "Upstream response was not valid JSON"；上传几十 MB 本身
 *   还很慢（46MB ≈ 40s），常表现为 Request timed out / Stream ended without finish_reason。
 * - pi 会把该分支内的历史图片**每一轮原样重发**（无淘汰）；而上下文 token 估算把每张图
 *   只记 4800 字符 ≈ 1200 tokens（estimateTextAndImageContentChars），DeepSeek-flash 窗口
 *   1M → 要 ~820 张图才可能触发自动压缩 ⇒ **请求体上限永远先到**。实测某会话 76 张/75.6MB
 *   起连续 413，全天涨到 186 张/186.5MB，纯文字追问也一起报错。
 * - 另一条独立故障：pi 对 ≤2000px 且 <4.5MB base64 的图**原样透传**，动图 WebP 会被
 *   DeepSeek 400 拒收（"You have uploaded an unsupported image…"），且历史重发导致后续每轮
 *   都失败。本扩展顺带修掉（强制转静态 PNG）。
 *
 * 四层防护（按代价从低到高）：
 * 1. tool_result / input 钩子：新进上下文的图片重编码。pi 的 resizeImage 是「PNG 优先、装不下才退
 *    JPEG」，本扩展把它变成「以体积决定格式」——同尺寸下 PNG 与 JPEG 取小者（这类渲染/照片源
 *    JPEG q86 通常只有 PNG 的 1/5），且未超预算时不接受任何降分辨率。
 * 2. turn_end 钩子：模型可见图片总量超 HIGH 时，一次性把最旧图片**永久**移出上下文（context_edit
 *    边界草稿）直到降到 LOW。用低水位而非「丢到刚好够」，是为了让之后的新图都是纯尾部追加：
 *    缓存前缀命中、零重付，而不是每来一张图就断裂一次前缀。
 * 3. context 钩子：轮内兜底——单轮塞进太多图时，只在本次请求里把最旧图片换成占位文本。
 * 4. /img-slim：报告用量与水位，on|off 本次会话开关。
 *
 * 已知限制：APNG（动图 PNG）在 pi 的图片嗅探层（detectSupportedImageMimeType）就被判为
 * 非图片、会被当文本读入，钩子层拿不到 ImageContent，无法在此修复。
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 重编码后的最大边长（与 pi 默认一致；1400 可把容量从 ~30 张抬到 ~113 张） */
const MAX_SIDE = 2000;
/** 重编码 JPEG 质量（pi 的 pipeline 优先 PNG，PNG 装不下才退 JPEG） */
const JPEG_QUALITY = 86;
/** 照片类（jpeg 源）单图预算，单位 base64 字节 */
const PHOTO_MAX_B64 = 900 * 1024;
/** 图形/截图类（png/gif/webp 源）单图预算 */
const GRAPHIC_MAX_B64 = 1600 * 1024;
/** 小于此体积且非动图 WebP 的图完全不碰（避免无意义重编码抖动） */
const SKIP_BELOW_B64 = 300 * 1024;
/** 模型可见图片总量超过此值，轮末永久移出最旧图片（base64 字节） */
const HIGH_B64 = 32 * 1024 * 1024;
/** 泄洪目标：一次降到此值以下，留下的余量按张数算足够后续十几张新图纯追加 */
const LOW_B64 = 20 * 1024 * 1024;
/** 最新的图片保留张数（当前轮/近几轮正在看的图不丢） */
const KEEP_RECENT_IMAGES = 4;
/** 请求级兜底：单次请求的图片总量预算（base64 字节）；上游 48MiB，留 16MB 给文本与工具定义 */
const REQ_BUDGET_B64 = 32 * 1024 * 1024;
/** 超过此体积开始推状态行提示 */
const WARN_AT_B64 = 24 * 1024 * 1024;
/** 会话已积累到此体积后，新图按半预算处理（温和降级，避免直接撞墙） */
const TIGHT_AT_B64 = 40 * 1024 * 1024;

/** 轮末永久省略时的占位文本（对模型可见；原图仍在会话记录，可重新 read） */
const OMIT_NOTE_PERSIST =
	"[img-slim] 该历史图片已移出上下文以控制请求体体积（原图仍在会话记录中；需要时重新 read 该文件即可）";

/** 请求级兜底省略时的占位文本（对模型可见） */
const OMIT_NOTE =
	"[img-slim] 为控制请求体大小，本张历史图片未随本次请求发送（原图仍在会话记录中；如确实需要请重新 read 该文件）";

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

const MB = (n: number) => `${(n / 1048576).toFixed(1)}MB`;

let enabled = true;
let lastStatus = "";
/** 本次会话是否已就「历史图片被省略」提醒过（只提醒一次，不刷屏） */
let omitNotified = false;

/** 模型可见图片的扫描结果（顺序 = 时间顺序） */
export interface ImageSpot {
	/** 承载该图片的会话条目 ID（context_edit 的作用目标） */
	entryId: string;
	/** base64 字节数 */
	bytes: number;
	/** 该消息的内容数组（replacement 以此为底稿） */
	blocks: (TextContent | ImageContent)[];
	/** 图片在该内容数组里的下标 */
	index: number;
}

/** 一条待提交的 context_edit */
export interface OmitEdit {
	entryId: string;
	replacement: { content: (TextContent | ImageContent)[] };
}

export interface OmitPlan {
	edits: OmitEdit[];
	/** 被移出的图片张数 */
	dropped: number;
	/** 移出后的图片总量（base64 字节） */
	remaining: number;
}

function bytesOf(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

/** 只解码头部：RIFF....WEBP + VP8X 特性位 bit1 = 动画（动图 WebP 会被上游 400 拒收） */
function isAnimatedWebp(base64: string): boolean {
	// 头部 64 字节足够（RIFF/WEBP/VP8X 都在前 32 字节内）
	const bytes = new Uint8Array(Buffer.from(base64.slice(0, 88), "base64"));
	if (bytes.length < 30) return false;
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
		return true;
	};
	if (!ascii(0, "RIFF") || !ascii(8, "WEBP")) return false;
	if (ascii(12, "VP8X")) return (bytes[20]! & 0x02) !== 0;
	return false;
}

function budgetFor(mimeType: string, tight: boolean): number {
	const isPhoto = mimeType === "image/jpeg" || mimeType === "image/jpg";
	const base = isPhoto ? PHOTO_MAX_B64 : GRAPHIC_MAX_B64;
	return tight ? Math.round(base / 2) : base;
}

/** 只按 MAX_SIDE 缩放后的宽度（用于识别 resizeImage 是否额外降了分辨率） */
function expectedWidth(width: number, height: number): number {
	let w = width;
	let h = height;
	if (w > MAX_SIDE) {
		h = Math.round((h * MAX_SIDE) / w);
		w = MAX_SIDE;
	}
	if (h > MAX_SIDE) w = Math.round((w * MAX_SIDE) / h);
	return w;
}

/**
 * 单张图片瘦身：动图 WebP 转静态 PNG；然后以体积决定格式——同尺寸下 PNG 与 JPEG 取小者
 * （pi 的 resizeImage 固定 PNG 优先，会把能压到 1/5 的渲染图原样留着）。
 */
async function slimBlock(block: ImageContent, tight: boolean): Promise<ImageContent> {
	const animated = isAnimatedWebp(block.data);
	let data = block.data;
	let mimeType = block.mimeType;
	let converted = false;

	if (animated) {
		// 取首帧转静态 PNG（上游拒收动图 WebP；视觉模型对动图本来也只看第一帧）
		const png = await convertToPng(block.data, block.mimeType).catch(() => null);
		if (png) {
			data = png.data;
			mimeType = png.mimeType;
			converted = true;
		}
		// 转码失败就退回原图（宁可上游报错也不破坏内容）
	}

	const budget = budgetFor(mimeType, tight);
	const size = data.length;
	// JPEG 已是有损编码的最优解，未超预算时重编码只会二次损失
	if (!converted && (mimeType === "image/jpeg" || mimeType === "image/jpg") && size <= budget) return block;
	if (!converted && size <= SKIP_BELOW_B64) return block;

	const overBudget = size > budget;
	// 未超预算时以「不变大」为上限重编码，让体积而不是 mime 决定格式
	const maxBytes = overBudget ? budget : size;
	const resized = await resizeImage(bytesOf(data), mimeType, {
		maxWidth: MAX_SIDE,
		maxHeight: MAX_SIDE,
		maxBytes,
		jpegQuality: JPEG_QUALITY,
	}).catch(() => null);
	if (!resized) return { type: "image", data, mimeType };
	// 未超预算就不接受任何降分辨率（宁可保留原图，也不偷偷丢细节）
	if (!overBudget && resized.width < expectedWidth(resized.originalWidth, resized.originalHeight)) {
		return { type: "image", data, mimeType };
	}
	if (!converted && resized.data.length >= size) return { type: "image", data, mimeType };
	return { type: "image", data: resized.data, mimeType: resized.mimeType };
}

/** 遍历一个 content 块数组里的图片（索引 + 字节数）；两套扫描（投影/请求）共用 */
function eachImageIn(content: unknown, fn: (index: number, bytes: number) => void): void {
	if (!Array.isArray(content)) return;
	for (let index = 0; index < content.length; index++) {
		const block = content[index] as { type?: string; data?: string };
		if (block?.type === "image") fn(index, String(block.data ?? "").length);
	}
}

/** 扫描模型当前可见的图片（投影已应用历史上的 context_edit，省略过的图不会再出现） */
function collectSpots(ctx: ExtensionContext): ImageSpot[] {
	const spots: ImageSpot[] = [];
	const projection = ctx.sessionManager.buildSessionProjection();
	for (const entry of projection.entries) {
		const source = entry.sourceEntry;
		if (source.type !== "message" && source.type !== "custom_message") continue;
		for (const message of entry.messages) {
			const content = (message as { content?: unknown }).content;
			eachImageIn(content, (index, bytes) => {
				spots.push({
					entryId: source.id,
					bytes,
					blocks: content as (TextContent | ImageContent)[],
					index,
				});
			});
		}
	}
	return spots;
}

/** 按叶子缓存扫描结果：新消息、context_edit 提交都会换叶子，缓存自然失效 */
let spotCache: { leaf: string | null; spots: ImageSpot[] } | null = null;

function imageSpots(ctx: ExtensionContext): ImageSpot[] {
	let leaf: string | null = null;
	try {
		leaf = ctx.sessionManager.getLeafId();
		if (spotCache && spotCache.leaf === leaf) return spotCache.spots;
	} catch {
		/* 无会话环境的调用按未缓存处理 */
	}
	let spots: ImageSpot[] = [];
	try {
		spots = collectSpots(ctx);
	} catch {
		return spotCache?.spots ?? [];
	}
	spotCache = { leaf, spots };
	return spots;
}

const totalBytes = (spots: ImageSpot[]) => spots.reduce((sum, spot) => sum + spot.bytes, 0);

/**
 * 计划一次泄洪：总量超 high 才动手，从最旧开始永久移出，直到降到 low 以下；
 * 最新 keepRecent 张永不移动（那是当前正在看的图）。
 */
export function planOmissions(
	spots: ImageSpot[],
	high: number,
	low: number,
	keepRecent: number,
	note: string,
): OmitPlan {
	const total = totalBytes(spots);
	if (total <= high) return { edits: [], dropped: 0, remaining: total };

	let remaining = total;
	let dropped = 0;
	const byEntry = new Map<string, Set<number>>();
	const droppable = Math.max(0, spots.length - keepRecent);
	for (const spot of spots.slice(0, droppable)) {
		if (remaining <= low) break;
		remaining -= spot.bytes;
		dropped++;
		const indexes = byEntry.get(spot.entryId) ?? new Set<number>();
		indexes.add(spot.index);
		byEntry.set(spot.entryId, indexes);
	}

	const edits: OmitEdit[] = [];
	for (const [entryId, indexes] of byEntry) {
		const sample = spots.find((spot) => spot.entryId === entryId);
		if (!sample) continue;
		const content = sample.blocks.map((block, index) =>
			indexes.has(index) ? ({ type: "text", text: note } as TextContent) : block,
		);
		edits.push({ entryId, replacement: { content } });
	}
	return { edits, dropped, remaining };
}

function setStatus(ctx: ExtensionContext, bytes: number, dropped: number): void {
	const text = bytes >= WARN_AT_B64 ? `🖼 ${MB(bytes)}${dropped > 0 ? ` · 已移出 ${dropped} 张` : ""}` : undefined;
	const key = text ?? "";
	if (key === lastStatus) return;
	lastStatus = key;
	try {
		ctx.ui.setStatus("img-slim", text);
	} catch {
		/* 无 UI 环境忽略 */
	}
}

/** 扫描请求消息里的图片位置（从旧到新），供请求级兜底裁剪 */
function scanRequestImageSpots(messages: AgentMessage[]): { mi: number; bi: number; bytes: number }[] {
	const spots: { mi: number; bi: number; bytes: number }[] = [];
	for (let mi = 0; mi < messages.length; mi++) {
		eachImageIn((messages[mi] as { content?: unknown }).content, (bi, bytes) => {
			spots.push({ mi, bi, bytes });
		});
	}
	return spots;
}

export default function (pi: ExtensionAPI): void {
	// ---- 1. 新图瘦身：工具结果里的图片（read 等） ----
	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		if (!event.content.some((b) => b.type === "image")) return;
		const tight = totalBytes(imageSpots(ctx)) > TIGHT_AT_B64;
		const out: (TextContent | ImageContent)[] = [];
		let changed = false;
		for (const block of event.content) {
			if (block.type !== "image") {
				out.push(block);
				continue;
			}
			const slim = await slimBlock(block, tight).catch(() => block);
			if (slim !== block) changed = true;
			out.push(slim);
		}
		if (!changed) return;
		// structuredContent 必须随 content 一起返回：runner 见到 content 替换而未带 structuredContent 时会丢弃它
		return { content: out, structuredContent: event.structuredContent };
	});

	// ---- 1. 新图瘦身：用户粘贴/附带的图片 ----
	pi.on("input", async (event, ctx) => {
		if (!enabled || !event.images?.length) return;
		const tight = totalBytes(imageSpots(ctx)) > TIGHT_AT_B64;
		const images: ImageContent[] = [];
		for (const img of event.images) images.push(await slimBlock(img, tight).catch(() => img));
		return { action: "transform", text: event.text, images };
	});

	// ---- 2. 轮末泄洪：一次性把最旧图片永久移出上下文 ----
	pi.on("turn_end", (_event, ctx) => {
		if (!enabled) return;
		const spots = imageSpots(ctx);
		const plan = planOmissions(spots, HIGH_B64, LOW_B64, KEEP_RECENT_IMAGES, OMIT_NOTE_PERSIST);
		if (plan.edits.length === 0) {
			setStatus(ctx, totalBytes(spots), 0);
			return;
		}
		spotCache = null; // 提交后叶子会变，主动失效
		setStatus(ctx, plan.remaining, plan.dropped);
		// 移出的是「模型再看也看不到的历史图」，用户容易误以为图丢了：首次发生时解释一次
		if (!omitNotified) {
			omitNotified = true;
			ctx.ui.notify(
				`img-slim：图片总量超 ${MB(HIGH_B64)}，已把最旧的 ${plan.dropped} 张移出上下文（降到 ${MB(plan.remaining)}；原图仍在会话记录中，需要时可重新 read；/img-slim 查看详情）`,
				"warning",
			);
		}
		return {
			entries: plan.edits.map((edit) => ({
				type: "context_edit" as const,
				targetId: edit.entryId,
				replacement: edit.replacement,
			})),
		};
	});

	// ---- 3. 请求级兜底：轮内塞进太多图时只在本次请求里省略 ----
	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		const spots = scanRequestImageSpots(event.messages);
		if (spots.length === 0) {
			setStatus(ctx, 0, 0);
			return;
		}
		let total = 0;
		for (const s of spots) total += s.bytes;
		if (total <= REQ_BUDGET_B64) {
			setStatus(ctx, total, 0);
			return;
		}

		// 从最旧开始省略，直到落进预算（最新的图=本轮要看的图，最后才动）
		const need = total - REQ_BUDGET_B64;
		let freed = 0;
		let dropped = 0;
		for (const spot of spots) {
			if (freed >= need) break;
			const content = (event.messages[spot.mi] as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			content[spot.bi] = { type: "text", text: OMIT_NOTE } as TextContent;
			freed += spot.bytes;
			dropped++;
		}
		setStatus(ctx, total - freed, dropped);
		if (dropped > 0 && !omitNotified) {
			omitNotified = true;
			ctx.ui.notify(
				`img-slim：本轮请求体超出预算，已只对本轮省略最旧的 ${dropped} 张（原图仍在会话记录中；/img-slim 查看详情）`,
				"warning",
			);
		}
	});

	// ---- 4. 命令：/img-slim [on|off] ----
	pi.registerCommand("img-slim", {
		description: "图片请求体预算：报告当前用量 / on|off 开关",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off" || arg === "on") {
				enabled = arg === "on";
				if (!enabled) {
					lastStatus = "";
					try {
						ctx.ui.setStatus("img-slim", undefined);
					} catch {
						/* 无 UI 环境忽略 */
					}
				}
				omitNotified = false; // 重新开启后允许再提醒一次
				ctx.ui.notify(
					enabled ? "img-slim 已开启（本次会话）" : "img-slim 已关闭（本次会话；关闭期间不防上游请求体超限，慎用）",
					"info",
				);
				return;
			}
			if (arg) {
				ctx.ui.notify("用法：/img-slim 或 /img-slim on|off", "warning");
				return;
			}
			const spots = imageSpots(ctx);
			const bytes = totalBytes(spots);
			const lines = [
				`状态：${enabled ? "开启" : "关闭"}`,
				`模型可见图片：${spots.length} 张 / ${MB(bytes)}（泄洪 ${MB(HIGH_B64)} → ${MB(LOW_B64)}，保留最新 ${KEEP_RECENT_IMAGES} 张）`,
				`单图上限：照片 ${(PHOTO_MAX_B64 / 1048576).toFixed(1)}MB / 图形 ${(GRAPHIC_MAX_B64 / 1048576).toFixed(1)}MB · 最长边 ${MAX_SIDE}px`,
				!enabled
					? `已关闭：图片不做任何预算处理`
					: bytes > HIGH_B64
						? `⚠️ 已超泄洪水位：下一轮结束时会把最旧图片移出上下文（原图仍在会话记录；可 /compact 彻底清掉）`
						: `未超水位，图片按原样发送`,
			];
			ctx.ui.notify(lines.join("\n"), bytes > WARN_AT_B64 ? "warning" : "info");
		},
	});
}
