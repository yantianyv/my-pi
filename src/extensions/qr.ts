/**
 * qr: 二维码工具（qr_encode / qr_decode）+ /qr 命令
 *
 * 为 AI 提供二维码的编码与解码能力，并把 AI 生成的二维码直接显示在用户界面：
 * - qr_encode：把文本编码成二维码——内容直接渲染到 TUI（优先 kitty/iTerm2 图形
 *   协议显示 PNG 真图；不支持的终端回落 Unicode 半块字符 ANSI 绘制，任何终端可扫），
 *   同时可选落盘 PNG 文件（默认开，方便用户直接打开/分享）；
 * - qr_decode：从本地图片文件或 http(s) URL 解码二维码（PNG/JPEG，纯 JS 解码），
 *   返回码内文本与版本/尺寸元信息；
 * - /qr <文本>：用户侧快速生成二维码并显示，按任意键关闭。
 *
 * 显示策略（QrDisplay 组件）：
 * - getCapabilities().images 非 null（kitty/iterm2）→ 用 pi-tui 的 Image 组件渲染
 *   PNG 真图（清晰、易扫）；
 * - 否则半块字符绘制：每个字符 cell 用 ▀ 上半块，前景/背景 24bit 色分别对应上下
 *   两个像素（暗模块=黑、亮模块=白，含 4 模块静区），逐字符显式着色、不依赖终端
 *   主题背景色——普通终端里 1 cell 宽 × 半行高的模块恰好近似正方形，可直接扫码。
 *
 * 依赖：qrcode（编码，含 pngjs）/ jsqr + pngjs + jpeg-js（解码，纯 JS），
 * 由 build.js 全部内联进产物——产物保持零外部依赖单文件。
 * 会话回放安全：renderResult 只依赖 details 里的原文（重新编码），不依赖内存状态，
 * 历史会话重新打开时二维码照样能渲染。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getCapabilities } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setStatusWithTTL, clearStatusTimers } from "./shared/status";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 编码纠错级别缺省值（L 低 ~7% / M 中 ~15% / Q 四分 ~25% / H 高 ~30% 容错） */
const DEFAULT_ECC = "M";
/** PNG 文件边长（像素）缺省值 / 范围 */
const DEFAULT_PNG_WIDTH = 512;
const MIN_PNG_WIDTH = 128;
const MAX_PNG_WIDTH = 2048;
/** 半块绘制四周静区宽度（模块数，规范建议 ≥4） */
const QUIET_ZONE = 4;
/** 终端图形显示时 PNG 的最大宽度（cell 数） */
const IMAGE_MAX_WIDTH_CELLS = 64;
/** 结果文本里解码内容的展示上限（超长截断，完整内容已给 AI） */
const DECODE_PREVIEW_CHARS = 400;
/** 调用卡片参数展示上限 */
const MAX_CALL_ARG_CHARS = 64;

// ---------------------------------------------------------------------------
// 编码：文本 → 模块矩阵 + PNG
// ---------------------------------------------------------------------------

/** 编码结果：原始模块矩阵（不含静区）+ PNG 字节 + 元信息 */
interface QrBuild {
	/** 二维码版本（1~40） */
	version: number;
	/** 模块矩阵边长（不含静区） */
	size: number;
	/** 纠错级别 */
	ecc: string;
	/** 模块矩阵（true=暗模块） */
	matrix: boolean[][];
	/** PNG 字节（含静区）；pngWidth ≤ 0 时不生成 */
	png?: Buffer;
}

/** 把文本编码成二维码（同步出矩阵；pngWidth > 0 时用 toBuffer 生成 PNG） */
async function buildQr(text: string, ecc: string, pngWidth: number): Promise<QrBuild> {
	const qr = QRCode.create(text, { errorCorrectionLevel: ecc as never });
	const size = qr.modules.size;
	const matrix: boolean[][] = [];
	for (let row = 0; row < size; row++) {
		const line: boolean[] = [];
		for (let col = 0; col < size; col++) line.push(qr.modules.get(row, col) === 1);
		matrix.push(line);
	}
	if (pngWidth <= 0) return { version: qr.version, size, ecc, matrix };
	const png = await QRCode.toBuffer(text, {
		errorCorrectionLevel: ecc as never,
		margin: QUIET_ZONE,
		width: pngWidth,
		color: { dark: "#000000ff", light: "#ffffffff" },
	});
	return { version: qr.version, size, ecc, matrix, png };
}

/** 半块绘制用的全尺寸矩阵（含四周静区） */
function withQuietZone(matrix: boolean[][]): boolean[][] {
	const n = matrix.length + QUIET_ZONE * 2;
	const out: boolean[][] = [];
	for (let y = 0; y < n; y++) {
		const row: boolean[] = [];
		for (let x = 0; x < n; x++) {
			const my = y - QUIET_ZONE;
			const mx = x - QUIET_ZONE;
			row.push(my >= 0 && my < matrix.length && mx >= 0 && mx < matrix.length ? matrix[my][mx] : false);
		}
		out.push(row);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 解码：图片字节 → 文本
// ---------------------------------------------------------------------------

/** PNG 魔数（89 50 4E 47） */
function isPng(bytes: Buffer): boolean {
	return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/** JPEG 魔数（FF D8 FF） */
function isJpeg(bytes: Buffer): boolean {
	return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** 解码输入解析：本地路径或 http(s) URL → 图片字节 */
async function readImageBytes(image: string, signal?: AbortSignal): Promise<Buffer> {
	if (/^https?:\/\//i.test(image)) {
		const res = await fetch(image, { signal });
		if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	}
	const p = path.resolve(image.replace(/^["']|["']$/g, ""));
	if (!fs.existsSync(p)) throw new Error(`文件不存在：${p}`);
	return fs.readFileSync(p);
}

// ---------------------------------------------------------------------------
// 显示组件：图形协议真图 / 半块字符回落
// ---------------------------------------------------------------------------

const ANSI_RESET = "\x1b[0m";

/** QR 显示组件：kitty/iTerm2 终端显示 PNG 真图，其余终端半块字符绘制（显式黑白着色） */
class QrDisplay implements Component {
	private img: Image | undefined;
	private lines: string[] | undefined;
	private cachedWidth = 0;

	constructor(
		private readonly full: boolean[][], // 含静区
		private readonly pngBase64: string | undefined,
		private readonly theme: Theme,
	) {}

	invalidate(): void {
		this.lines = undefined;
		this.img?.invalidate();
	}

	render(width: number): string[] {
		if (this.lines && this.cachedWidth === width) return this.lines;
		let lines: string[];
		if (getCapabilities().images && this.pngBase64) {
			this.img ??= new Image(this.pngBase64, "image/png", { fallbackColor: (t) => this.theme.fg("dim", t) }, {
				maxWidthCells: IMAGE_MAX_WIDTH_CELLS,
				filename: "qrcode.png",
			});
			lines = this.img.render(width);
		} else {
			lines = this.renderHalfBlocks(width);
		}
		this.lines = lines;
		this.cachedWidth = width;
		return lines;
	}

	/** 半块字符绘制：▀ 上半块前景=上像素色、背景=下像素色（暗=黑/亮=白，水平居中） */
	private renderHalfBlocks(width: number): string[] {
		const n = this.full.length;
		if (n > width - 2) {
			// 终端太窄放不下（模块数 > 可用列数）：二维码无法缩小（会扫不出），如实提示
			return [this.theme.fg("warning", `（终端宽度不足，无法显示 ${n}×${n} 模块的二维码，请使用 PNG 文件）`)];
		}
		const left = Math.max(0, Math.floor((width - n) / 2));
		const pad = " ".repeat(left);
		const lines: string[] = [];
		for (let y = 0; y < n; y += 2) {
			let line = pad;
			for (let x = 0; x < n; x++) {
				const topDark = this.full[y][x];
				const bottomDark = y + 1 < n ? this.full[y + 1][x] : false;
				const fr = topDark ? 0 : 255;
				const bg = bottomDark ? 0 : 255;
				line += `\x1b[38;2;${fr};${fr};${fr};48;2;${bg};${bg};${bg}m▀`;
			}
			lines.push(line + ANSI_RESET);
		}
		return lines;
	}
}

/** 组合渲染：元信息一行 + 二维码本体 */
function qrResultComponent(details: QrEncodeDetails, theme: Theme): Container {
	const c = new Container();
	c.addChild(new Text(
		theme.fg("success", `✓ 二维码（版本 ${details.version}，${details.size}×${details.size} 模块，纠错 ${details.ecc}）`),
		0, 0,
	));
	// PNG 与矩阵不进 details（避免会话文件膨胀）：renderResult 从原文同步重新编码。
	// qrcode 的 create 同步、toBuffer 异步——渲染路径需要同步出 PNG，这里用 pngjs
	// 手工生成（模块放大 8px + 静区，与 toBuffer 视觉一致，仅用于显示，不落盘）。
	const png = encodePngSync(details.text, details.ecc);
	const full = withQuietZone(buildMatrixSync(details.text, details.ecc));
	c.addChild(new QrDisplay(full, png, theme));
	if (details.pngPath) {
		c.addChild(new Text(theme.fg("dim", `PNG：${details.pngPath}`), 0, 0));
	}
	return c;
}
function buildMatrixSync(text: string, ecc: string): boolean[][] {
	const qr = QRCode.create(text, { errorCorrectionLevel: ecc as never });
	const size = qr.modules.size;
	const matrix: boolean[][] = [];
	for (let row = 0; row < size; row++) {
		const line: boolean[] = [];
		for (let col = 0; col < size; col++) line.push(qr.modules.get(row, col) === 1);
		matrix.push(line);
	}
	return matrix;
}

function encodePngSync(text: string, ecc: string): string {
	const matrix = buildMatrixSync(text, ecc);
	const scale = 8;
	const n = (matrix.length + QUIET_ZONE * 2) * scale;
	const png = new PNG({ width: n, height: n });
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const my = Math.floor(y / scale) - QUIET_ZONE;
			const mx = Math.floor(x / scale) - QUIET_ZONE;
			const dark =
				my >= 0 && my < matrix.length && mx >= 0 && mx < matrix.length ? matrix[my][mx] : false;
			const v = dark ? 0 : 255;
			const idx = (y * n + x) * 4;
			png.data[idx] = v;
			png.data[idx + 1] = v;
			png.data[idx + 2] = v;
			png.data[idx + 3] = 255;
		}
	}
	return PNG.sync.write(png).toString("base64");
}

// ---------------------------------------------------------------------------
// details 类型
// ---------------------------------------------------------------------------

interface QrEncodeDetails {
	text: string;
	version: number;
	size: number;
	ecc: string;
	pngPath?: string;
}

interface QrDecodeDetails {
	source: string;
	text: string;
	version?: number;
	width?: number;
	height?: number;
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// reload / session 替换前清掉 TTL 定时器（旧 ctx 已失效）
	pi.on("session_shutdown", async () => clearStatusTimers());

	// ---- qr_encode：文本 → 二维码（显示到 UI + 可选 PNG 落盘） ----
	pi.registerTool({
		name: "qr_encode",
		label: "生成二维码",
		description:
			"把文本（URL/Wi-Fi 配置/名片等）编码成二维码并显示到用户界面（图形终端 PNG 真图、普通终端字符绘制，可直接扫码），可选保存 PNG。",
		promptSnippet: "生成二维码：qr_encode(text) → 显示在用户界面 + PNG 路径",
		promptGuidelines: [
			"需要给用户二维码时用 qr_encode（直接显示在终端，可扫）；需要图片文件时用 save 参数",
		],
		renderCall: (args, theme) => {
			const a = args as { text?: string };
			const t = a.text ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`🔳 生成二维码 ${t.length > MAX_CALL_ARG_CHARS ? `${t.slice(0, MAX_CALL_ARG_CHARS)}…` : t}`)),
				0, 0,
			);
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) {
				const text = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();
				return new Text(theme.fg("error", `✗ ${text || "二维码生成失败"}`), 0, 0);
			}
			const d = result.details as QrEncodeDetails | undefined;
			if (!d?.text) return new Text(theme.fg("dim", "已生成"), 0, 0);
			return qrResultComponent(d, theme);
		},
		parameters: Type.Object({
			text: Type.String({ description: "要编码成二维码的文本（URL、Wi-Fi 配置、名片、任意文字）" }),
			ecc: Type.Optional(
				StringEnum(["L", "M", "Q", "H"], {
					description: `纠错级别：L 低 / M 中（默认 ${DEFAULT_ECC}）/ Q / H（容错递增，容量递减）`,
				}),
			),
			save: Type.Optional(Type.Boolean({ description: "是否保存 PNG 文件（默认 true，路径随结果返回）" })),
			pngWidth: Type.Optional(
				Type.Integer({ description: `PNG 边长（像素），默认 ${DEFAULT_PNG_WIDTH}，范围 ${MIN_PNG_WIDTH}~${MAX_PNG_WIDTH}` }),
			),
		}),

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) return { content: [{ type: "text", text: "已取消" }], details: {} };
			const ecc = params.ecc ?? DEFAULT_ECC;
			const pngWidth = Math.min(Math.max(params.pngWidth ?? DEFAULT_PNG_WIDTH, MIN_PNG_WIDTH), MAX_PNG_WIDTH);
			const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "qr", text, ttlMs);
			push("🔳 生成中", 30_000);
			try {
				const built = await buildQr(params.text, ecc, params.save !== false ? pngWidth : 0);
				// 落盘路径：系统临时目录 pi-qr-<时间戳>.png
				let pngPath: string | undefined;
				if (built.png) {
					pngPath = path.join(os.tmpdir(), `pi-qr-${Date.now()}.png`);
					fs.writeFileSync(pngPath, built.png);
				}
				push("🔳 已显示", 6_000);
				const details: QrEncodeDetails = {
					text: params.text,
					version: built.version,
					size: built.size,
					ecc,
					pngPath,
				};
				const textParts = [
					`二维码已生成并显示在用户界面（版本 ${built.version}，${built.size}×${built.size} 模块，纠错 ${ecc}），用户可直接扫码。`,
				];
				if (pngPath && built.png) textParts.push(`PNG 已保存：${pngPath}（${built.png.length} 字节，${pngWidth}px）`);
				return { content: [{ type: "text", text: textParts.join("\n") }], details };
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				push("🔳 生成失败", 6_000);
				return {
					content: [{ type: "text", text: `生成二维码失败：${msg}${/too long|big/i.test(msg) ? "（文本过长超出二维码容量，可换 ecc=L 或精简文本）" : ""}` }],
					details: { error: msg },
				};
			}
		},
	});

	// ---- qr_decode：图片 → 二维码文本 ----
	pi.registerTool({
		name: "qr_decode",
		label: "解码二维码",
		description:
			"从图片解码二维码：本地路径或 http(s) URL，PNG/JPEG（自动尝试正反色）。返回码内文本与版本/尺寸元信息。",
		promptSnippet: "解码二维码：qr_decode(image) → 码内文本",
		renderCall: (args, theme) => {
			const a = args as { image?: string };
			const s = a.image ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`🔳 解码二维码 ${s.length > MAX_CALL_ARG_CHARS ? `${s.slice(0, MAX_CALL_ARG_CHARS)}…` : s}`)),
				0, 0,
			);
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) {
				const text = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();
				return new Text(theme.fg("error", `✗ ${text || "二维码解码失败"}`), 0, 0);
			}
			const d = result.details as QrDecodeDetails | undefined;
			if (!d) return new Text(theme.fg("dim", "已解码"), 0, 0);
			const preview = d.text.length > DECODE_PREVIEW_CHARS ? `${d.text.slice(0, DECODE_PREVIEW_CHARS)}…` : d.text;
			const meta = [d.version ? `版本 ${d.version}` : "", d.width && d.height ? `${d.width}×${d.height}px` : ""]
				.filter(Boolean)
				.join("，");
			return new Text(
				theme.fg("success", `✓ 解码成功${meta ? `（${meta}）` : ""}\n`)
					+ theme.fg("toolTitle", preview),
				0, 0,
			);
		},
		parameters: Type.Object({
			image: Type.String({ description: "二维码图片：本地文件路径（推荐 PNG）或 http(s) URL" }),
		}),

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) return { content: [{ type: "text", text: "已取消" }], details: {} };
			const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "qr", text, ttlMs);
			push("🔳 解码中", 30_000);
			try {
				const bytes = await readImageBytes(params.image, signal);
				let rgba: { width: number; height: number; data: Uint8Array };
				if (isPng(bytes)) {
					const png = PNG.sync.read(bytes);
					rgba = { width: png.width, height: png.height, data: png.data };
				} else if (isJpeg(bytes)) {
					const img = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 512 });
					rgba = { width: img.width, height: img.height, data: img.data };
				} else {
					throw new Error("仅支持 PNG / JPEG 图片（请提供 .png/.jpg/.jpeg 文件或对应 URL）");
				}
				const decoded = decodeQrRgba(rgba);
				push("🔳 已解码", 6_000);
				const details: QrDecodeDetails = {
					source: params.image,
					text: decoded.text,
					version: decoded.version,
					width: rgba.width,
					height: rgba.height,
				};
				const preview =
					decoded.text.length > DECODE_PREVIEW_CHARS
						? `${decoded.text.slice(0, DECODE_PREVIEW_CHARS)}…（共 ${decoded.text.length} 字符）`
						: decoded.text;
				return {
					content: [{ type: "text", text: `解码成功（图片 ${rgba.width}×${rgba.height}px${decoded.version ? `，二维码版本 ${decoded.version}` : ""}）：\n${preview}` }],
					details,
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				push("🔳 解码失败", 6_000);
				return { content: [{ type: "text", text: `解码二维码失败：${msg}` }], details: { error: msg, source: params.image } };
			}
		},
	});

	// ---- /qr：用户侧快速生成（按任意键关闭） ----
	pi.registerCommand("qr", {
		description: "生成二维码并显示：/qr <文本>（按任意键关闭）",
		handler: async (args, ctx: ExtensionContext) => {
			const text = (args ?? "").trim();
			if (!text) {
				ctx.ui.notify("用法：/qr <文本>——把文本编码成二维码并显示，按任意键关闭", "info");
				return;
			}
			try {
				const built = await buildQr(text, DEFAULT_ECC, DEFAULT_PNG_WIDTH);
				const full = withQuietZone(built.matrix);
				const pngBase64 = built.png ? built.png.toString("base64") : encodePngSync(text, DEFAULT_ECC);
				if (typeof ctx.ui.custom !== "function") {
					ctx.ui.notify(`当前环境无 UI，无法显示二维码（文本：${text}）`, "warning");
					return;
				}
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
					const c = new Container();
					c.addChild(new Text(theme.fg("accent", `🔳 ${text}`), 0, 0));
					c.addChild(new QrDisplay(full, pngBase64, theme));
					c.addChild(new Text(theme.fg("dim", "按任意键关闭"), 0, 0));
					return {
						handleInput() {
							done();
						},
						render(width: number) {
							return c.render(width);
						},
						invalidate() {
							c.invalidate();
						},
					};
				});
			} catch (e) {
				ctx.ui.notify(`生成二维码失败：${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});
}

/** RGBA → jsQR 解码（含小图最近邻放大） */
function decodeQrRgba(rgba: { width: number; height: number; data: Uint8Array }): { text: string; version?: number } {
	let { width, height, data } = rgba;
	if (width < 200 || height < 200) {
		const scale = Math.max(2, Math.ceil(400 / Math.min(width, height)));
		const scaled = new Uint8Array(width * scale * height * scale * 4);
		for (let y = 0; y < height * scale; y++) {
			for (let x = 0; x < width * scale; x++) {
				const si = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
				const di = (y * width * scale + x) * 4;
				scaled[di] = data[si];
				scaled[di + 1] = data[si + 1];
				scaled[di + 2] = data[si + 2];
				scaled[di + 3] = 255;
			}
		}
		data = scaled;
		width *= scale;
		height *= scale;
	}
	const res = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height, {
		inversionAttempts: "attemptBoth",
	});
	if (!res) throw new Error("图中未找到二维码（图片需完整包含二维码与四周留白，且清晰无遮挡）");
	return { text: res.data, version: res.version };
}
