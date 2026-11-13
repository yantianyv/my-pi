/**
 * shared/qr-code：二维码编码 + TUI 显示组件
 *
 * 供需要「把文本变成可扫的码」的扩展复用（qr 工具的二维码显示、扫码登录类界面）：
 * - 编码：`buildQrMatrix`（同步矩阵）、`encodeQrPngBase64`（同步 PNG，图形协议终端用）；
 * - 显示：`QrCodeView` 组件——kitty/iTerm2 用 pi-tui 的 Image 显示真图，其余终端用
 *   Unicode 半块字符绘制（▀ 前景/背景分别为上下两个像素，暗=黑/亮=白，含 4 模块静区；
 *   普通终端里 1 cell 宽 × 半行高恰好近似正方形，可直接扫码）；
 *   半块依赖终端字体有 ▀ 字形，缺字形的终端会被回退字体渲染成小符号、行列错位扫不出——
 *   宿主转发 Tab 键调 `toggleMode()` 切到纯背景色渲染（每模块两个空格 + 24bit 背景色，
 *   零字形依赖，宽度翻倍），再按 Tab 切回。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Image } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getCapabilities } from "@earendil-works/pi-tui";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import { wrapText } from "./markdown";

/** 四周静区宽度（模块数，规范建议 ≥4） */
export const QR_QUIET_ZONE = 4;
/** 图形协议显示时 PNG 的最大宽度（cell 数） */
const QR_IMAGE_MAX_WIDTH_CELLS = 64;
/** PNG 放大倍数（每个模块的像素边长，仅用于显示） */
const QR_PNG_SCALE = 8;
const ANSI_RESET = "\x1b[0m";

/** 文本 → 模块矩阵（true=暗模块，不含静区）；内容超出容量时抛错 */
export function buildQrMatrix(text: string, ecc: string): boolean[][] {
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

/** 半块绘制用的全尺寸矩阵（含四周静区） */
export function withQuietZone(matrix: boolean[][]): boolean[][] {
	const n = matrix.length + QR_QUIET_ZONE * 2;
	const out: boolean[][] = [];
	for (let y = 0; y < n; y++) {
		const row: boolean[] = [];
		for (let x = 0; x < n; x++) {
			const my = y - QR_QUIET_ZONE;
			const mx = x - QR_QUIET_ZONE;
			row.push(my >= 0 && my < matrix.length && mx >= 0 && mx < matrix.length ? matrix[my][mx] : false);
		}
		out.push(row);
	}
	return out;
}

/**
 * 同步生成 PNG（base64）。qrcode 的 create 同步、toBuffer 异步，
 * 而 TUI 渲染路径是同步的，因此用 pngjs 手工放大绘制。
 */
export function encodeQrPngBase64(text: string, ecc: string): string {
	const matrix = buildQrMatrix(text, ecc);
	const n = (matrix.length + QR_QUIET_ZONE * 2) * QR_PNG_SCALE;
	const png = new PNG({ width: n, height: n });
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const my = Math.floor(y / QR_PNG_SCALE) - QR_QUIET_ZONE;
			const mx = Math.floor(x / QR_PNG_SCALE) - QR_QUIET_ZONE;
			const dark = my >= 0 && my < matrix.length && mx >= 0 && mx < matrix.length ? matrix[my][mx] : false;
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

export interface QrCodeViewOptions {
	/** 终端太窄放不下时的补充提示（如「可改用链接在浏览器打开」） */
	narrowHint?: string;
}

/** 字符绘制模式：half=半块（省行高，依赖 ▀ 字形）；bg=纯背景色空格（零字形依赖，宽度翻倍） */
export type QrDrawMode = "half" | "bg";

/** 二维码显示组件：图形协议终端显示 PNG 真图，其余终端字符绘制（Tab 可切兼容模式） */
export class QrCodeView implements Component {
	private img: Image | undefined;
	private lines: string[] | undefined;
	private cachedWidth = 0;
	private mode: QrDrawMode = "half";

	constructor(
		private readonly full: boolean[][], // 含静区
		private readonly pngBase64: string | undefined,
		private readonly theme: Theme,
		private readonly options: QrCodeViewOptions = {},
	) {}

	/** 切换字符绘制模式（半块 ↔ 纯背景色）；返回切换后的模式 */
	toggleMode(): QrDrawMode {
		this.mode = this.mode === "half" ? "bg" : "half";
		this.lines = undefined;
		return this.mode;
	}

	invalidate(): void {
		this.lines = undefined;
		this.img?.invalidate();
	}

	render(width: number): string[] {
		if (this.lines && this.cachedWidth === width) return this.lines;
		let lines: string[];
		if (getCapabilities().images && this.pngBase64) {
			this.img ??= new Image(this.pngBase64, "image/png", { fallbackColor: (t) => this.theme.fg("dim", t) }, {
				maxWidthCells: QR_IMAGE_MAX_WIDTH_CELLS,
				filename: "qrcode.png",
			});
			lines = this.img.render(width);
		} else {
			lines = this.mode === "half" ? this.renderHalfBlocks(width) : this.renderBgBlocks(width);
		}
		this.lines = lines;
		this.cachedWidth = width;
		return lines;
	}

	/** 终端宽度不足时的统一提示（二维码不能缩小，缩了扫不出） */
	private renderTooNarrow(width: number): string[] {
		const n = this.full.length;
		const hint = this.options.narrowHint ? `；${this.options.narrowHint}` : "";
		const warning = `（终端宽度不足，无法显示 ${n}×${n} 模块的二维码${hint}）`;
		return wrapText(warning, Math.max(8, width - 2)).map((t) => this.theme.fg("warning", t));
	}

	private renderHalfBlocks(width: number): string[] {
		const n = this.full.length;
		if (n > width - 2) return this.renderTooNarrow(width);
		const pad = " ".repeat(Math.max(0, Math.floor((width - n) / 2)));
		const lines: string[] = [];
		for (let y = 0; y < n; y += 2) {
			let line = pad;
			for (let x = 0; x < n; x++) {
				const fr = this.full[y][x] ? 0 : 255;
				const bg = y + 1 < n && this.full[y + 1][x] ? 0 : 255;
				line += `\x1b[38;2;${fr};${fr};${fr};48;2;${bg};${bg};${bg}m▀`;
			}
			lines.push(line + ANSI_RESET);
		}
		return lines;
	}

	/** 纯背景色渲染：每模块两个空格 + 24bit 背景色，零字形依赖（缺字体的终端也能扫）；宽度为半块模式的两倍 */
	private renderBgBlocks(width: number): string[] {
		const n = this.full.length;
		if (n * 2 > width - 2) return this.renderTooNarrow(width);
		const pad = " ".repeat(Math.max(0, Math.floor((width - n * 2) / 2)));
		const lines: string[] = [];
		for (let y = 0; y < n; y++) {
			let line = pad;
			for (let x = 0; x < n; x++) {
				const v = this.full[y][x] ? 0 : 255;
				line += `\x1b[48;2;${v};${v};${v}m  `;
			}
			lines.push(line + ANSI_RESET);
		}
		return lines;
	}
}

/** 文本 → 可直接渲染的组件（矩阵 + PNG 各算一次） */
export function createQrView(text: string, ecc: string, theme: Theme, options?: QrCodeViewOptions): QrCodeView {
	return new QrCodeView(withQuietZone(buildQrMatrix(text, ecc)), encodeQrPngBase64(text, ecc), theme, options);
}
