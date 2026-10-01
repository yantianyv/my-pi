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
 * 三层防护：
 * 1. tool_result 钩子：工具（read 等）新进上下文的图片按类型重编码到单图预算内；
 * 2. input 钩子：用户粘贴/附带的图片同策略处理；
 * 3. context 钩子：每次请求前统计历史图片总体积，超预算就从**最旧**开始把图片换成占位文本
 *    （只改本次请求，非破坏性；会话记录不动，需要时重新 read 即可）。
 *
 * 取舍实测（2000px 上限，见对话记录）：
 * - 无损重编码对 JPEG 源无解：7.43MB 照片 → 无损 WebP 11.44MB（1.5 倍膨胀，87s/张）；
 * - PNG 截图转无损 WebP 只省 ~20-30%，且"无损"不能降分辨率，所以打不过现状的降采样；
 * - 真杠杆是分辨率：1400px+JPEG q90 平均 433KB（48MiB ≈113 张）、1024px+q85 平均 198KB
 *   （≈248 张）、现状（pi 2000px）1618KB（≈30 张）。本扩展保守取 2000px（与 pi 默认一致），
 *   想更狠直接改下面 MAX_SIDE / *_MAX_B64。
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
/** 单次请求的图片总量预算（base64 字节）；上游 48MiB，留 16MB 给文本与工具定义 */
const REQ_BUDGET_B64 = 32 * 1024 * 1024;
/** 超过此体积开始推状态行提示 */
const WARN_AT_B64 = 24 * 1024 * 1024;
/** 会话已积累到此体积后，新图按半预算处理（温和降级，避免直接撞墙） */
const TIGHT_AT_B64 = 40 * 1024 * 1024;

/** 超预算时被省略图片的占位文本（对模型可见） */
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
/** 分支图片体积缓存：按分支长度失效，避免每次工具结果都全量扫分支 */
let branchCache = { len: -1, bytes: 0 };

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

/** 单张图片瘦身：动图 WebP 转静态 PNG；超预算则重编码（PNG 优先、退 JPEG） */
async function slimBlock(block: ImageContent, tight: boolean): Promise<ImageContent> {
	const animated = isAnimatedWebp(block.data);
	if (!animated && block.data.length <= budgetFor(block.mimeType, tight)) return block;

	let data = block.data;
	let mimeType = block.mimeType;
	let force = animated;
	if (animated) {
		// 取首帧转静态 PNG（上游拒收动图 WebP；视觉模型对动图本来也只看第一帧）
		const png = await convertToPng(block.data, block.mimeType).catch(() => null);
		if (png) {
			data = png.data;
			mimeType = png.mimeType;
		} else {
			force = false; // 转码失败就退回原图（宁可上游报错也不破坏内容）
		}
	}

	const budget = budgetFor(mimeType, tight);
	if (!force && data.length <= budget) return { type: "image", data, mimeType };

	const resized = await resizeImage(bytesOf(data), mimeType, {
		maxWidth: MAX_SIDE,
		maxHeight: MAX_SIDE,
		maxBytes: budget,
		jpegQuality: JPEG_QUALITY,
	}).catch(() => null);
	if (!resized) return { type: "image", data, mimeType };
	return { type: "image", data: resized.data, mimeType: resized.mimeType };
}

/** 统计分支内仍在上下文的图片总字节（base64） */
function branchImageBytes(ctx: ExtensionContext): number {
	let len = -1;
	try {
		const branch = ctx.sessionManager.getBranch();
		len = branch.length;
		if (branchCache.len === len) return branchCache.bytes;
		let bytes = 0;
		for (const entry of branch) {
			const content = (entry as { message?: { content?: unknown } }).message?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if ((block as { type?: string }).type === "image") bytes += String((block as { data?: string }).data ?? "").length;
			}
		}
		branchCache = { len, bytes };
		return bytes;
	} catch {
		branchCache = { len, bytes: branchCache.bytes };
		return branchCache.bytes;
	}
}

function setStatus(ctx: ExtensionContext, bytes: number, dropped: number): void {
	const text = bytes >= WARN_AT_B64 ? `🖼 ${MB(bytes)}${dropped > 0 ? ` · 已省略${dropped}张旧图` : ""}` : undefined;
	const key = text ?? "";
	if (key === lastStatus) return;
	lastStatus = key;
	try {
		ctx.ui.setStatus("img-slim", text);
	} catch {
		/* 无 UI 环境忽略 */
	}
}

/** 扫描消息里的图片位置（从旧到新），供预算裁剪 */
function scanImageSpots(messages: AgentMessage[]): { mi: number; bi: number; bytes: number }[] {
	const spots: { mi: number; bi: number; bytes: number }[] = [];
	for (let mi = 0; mi < messages.length; mi++) {
		const content = (messages[mi] as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (let bi = 0; bi < content.length; bi++) {
			const block = content[bi] as { type?: string; data?: string };
			if (block?.type === "image") spots.push({ mi, bi, bytes: String(block.data ?? "").length });
		}
	}
	return spots;
}

export default function (pi: ExtensionAPI): void {
	// ---- 1. 工具结果里的图片（read 等） ----
	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		if (!event.content.some((b) => b.type === "image")) return;
		const tight = branchImageBytes(ctx) > TIGHT_AT_B64;
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

	// ---- 2. 用户粘贴/附带的图片 ----
	pi.on("input", async (event, ctx) => {
		if (!enabled || !event.images?.length) return;
		const tight = branchImageBytes(ctx) > TIGHT_AT_B64;
		const images: ImageContent[] = [];
		for (const img of event.images) images.push(await slimBlock(img, tight).catch(() => img));
		return { action: "transform", text: event.text, images };
	});

	// ---- 3. 每轮请求前的总量预算（保底，永不 413） ----
	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		const spots = scanImageSpots(event.messages);
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
		branchCache = { len: -1, bytes: 0 }; // 分支长度未变，手动失效
		setStatus(ctx, total - freed, dropped);
		// 省略的是「不给本轮模型看的历史图」，用户容易误以为图丢了：首次发生时解释一次
		if (dropped > 0 && !omitNotified) {
			omitNotified = true;
			ctx.ui.notify(
				`img-slim：历史图片超出本轮请求体预算，已省略最旧的 ${dropped} 张（原图仍在会话记录中，需要时可重新 read；/img-slim 查看详情）`,
				"warning",
			);
		}
	});

	// ---- 命令：/img-slim [on|off] ----
	pi.registerCommand("img-slim", {
		description: "图片请求体预算：报告当前用量 / on|off 开关",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off" || arg === "on") {
				enabled = arg === "on";
				if (!enabled) setStatus(ctx, 0, 0);
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
			const bytes = branchImageBytes(ctx);
			let count = 0;
			try {
				const messages = ctx.sessionManager
					.getBranch()
					.map((entry) => (entry as { message?: AgentMessage }).message)
					.filter((m): m is AgentMessage => Boolean(m));
				count = scanImageSpots(messages).length;
			} catch {
				/* 统计失败不影响其他输出 */
			}
			const lines = [
				`状态：${enabled ? "开启" : "关闭"}`,
				`分支内图片：${count} 张 / 请求体体积约 ${MB(bytes)}（预算 ${MB(REQ_BUDGET_B64)}）`,
				`单图上限：照片 ${(PHOTO_MAX_B64 / 1048576).toFixed(1)}MB / 图形 ${(GRAPHIC_MAX_B64 / 1048576).toFixed(1)}MB · 最长边 ${MAX_SIDE}px`,
				!enabled
					? `已关闭：图片不做任何预算处理`
					: bytes > REQ_BUDGET_B64
						? `⚠️ 已超预算：本轮请求已从最旧图片开始省略（省略的图对模型不可见，原图仍在会话记录；可 /compact 彻底清掉）`
						: `未超预算，图片按原样发送`,
			];
			ctx.ui.notify(lines.join("\n"), bytes > WARN_AT_B64 ? "warning" : "info");
		},
	});
}
