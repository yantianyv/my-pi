/**
 * computer-use/model/annotate：把检测框画到截图上，产出"带编号的标注图"
 *
 * 为什么要有这一步：给模型一堆 JSON 坐标（"conf=0.74 @31,426 561x73"）它不知道那是什么，
 * 给一张标了号的图它一眼就能对上"3 号是亮度卡片"。元素表只负责让模型能把编号映射成
 * 可执行动作（点击 3 号 = 点 289,462），语义理解交给它的视觉能力。
 *
 * 编号规则与元素表严格一致：同一个 idx 在两处指同一个框。编号从 1 开始（模型对 1 起数更自然）。
 *
 * 绘制用纯 JS 直接改像素（pngjs），不引任何图形库：只需要矩形框和数字位图，
 * 引一个 canvas 实现要多几 MB 原生依赖，而这里两种图形都是几十行能写完的。
 */
import * as fs from "node:fs";
import { PNG } from "pngjs";

/** 输入给标注的框（屏幕坐标；标注图上按同一坐标绘制） */
export interface AnnotateBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 5×7 点阵字模：只覆盖 0-9 与少量符号，够画编号 */
const GLYPHS: Record<string, string[]> = {
	"0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
	"1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
	"2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
	"3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
	"4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
	"5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
	"6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
	"7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
	"8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
	"9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
	"?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
};

/** 标注主色（高饱和青绿：在深色与浅色 UI 上都够醒目） */
const COLOR_BOX = { r: 0, g: 230, b: 140 };
/** 编号标签底色 */
const COLOR_LABEL_BG = { r: 0, g: 230, b: 140 };
/** 编号文字色 */
const COLOR_LABEL_FG = { r: 0, g: 0, b: 0 };
/** 数字缩放倍数：1 个点 = scale×scale 像素 */
const GLYPH_SCALE = 2;

/** 在图上画一个实心矩形（带边界裁剪） */
function fillRect(
	img: { width: number; height: number; data: Buffer },
	x: number,
	y: number,
	w: number,
	h: number,
	c: { r: number; g: number; b: number },
): void {
	const x0 = Math.max(0, Math.floor(x));
	const y0 = Math.max(0, Math.floor(y));
	const x1 = Math.min(img.width, Math.floor(x + w));
	const y1 = Math.min(img.height, Math.floor(y + h));
	for (let yy = y0; yy < y1; yy++) {
		for (let xx = x0; xx < x1; xx++) {
			const i = (yy * img.width + xx) * 4;
			img.data[i] = c.r;
			img.data[i + 1] = c.g;
			img.data[i + 2] = c.b;
			img.data[i + 3] = 255;
		}
	}
}

/** 画空心矩形边框 */
function strokeRect(
	img: { width: number; height: number; data: Buffer },
	x: number,
	y: number,
	w: number,
	h: number,
	c: { r: number; g: number; b: number },
	thickness = 2,
): void {
	fillRect(img, x, y, w, thickness, c);
	fillRect(img, x, y + h - thickness, w, thickness, c);
	fillRect(img, x, y, thickness, h, c);
	fillRect(img, x + w - thickness, y, thickness, h, c);
}

/** 用点阵字模画一段文字 */
function drawText(
	img: { width: number; height: number; data: Buffer },
	text: string,
	x: number,
	y: number,
	c: { r: number; g: number; b: number },
	scale = GLYPH_SCALE,
): number {
	let cursor = x;
	for (const ch of text) {
		const glyph = GLYPHS[ch];
		if (!glyph) {
			cursor += 6 * scale;
			continue;
		}
		for (let row = 0; row < glyph.length; row++) {
			const line = glyph[row]!;
			for (let col = 0; col < line.length; col++) {
				if (line[col] === "1") fillRect(img, cursor + col * scale, y + row * scale, scale, scale, c);
			}
		}
		cursor += 6 * scale;
	}
	return cursor - x;
}

/** 数字标签的像素尺寸 */
function labelSize(label: string): { w: number; h: number } {
	return { w: label.length * 6 * GLYPH_SCALE + 4, h: 7 * GLYPH_SCALE + 4 };
}

/**
 * 把编号框画到 PNG 上并另存。
 * 标签默认放在框的左上角外侧；顶到画面边缘时翻到框内，避免编号被裁掉。
 */
export function annotatePng(srcPath: string, outPath: string, boxes: AnnotateBox[]): void {
	const png = PNG.sync.read(fs.readFileSync(srcPath));
	for (let i = 0; i < boxes.length; i++) {
		const b = boxes[i]!;
		const label = String(i + 1);
		strokeRect(png, b.x, b.y, b.w, b.h, COLOR_BOX, 2);
		const { w: lw, h: lh } = labelSize(label);
		// 标签贴框左上：上方放不下就塞进框内顶部
		const outside = b.y - lh >= 0;
		const ty = outside ? b.y - lh : b.y;
		const tx = Math.min(b.x, png.width - lw);
		fillRect(png, tx, ty, lw, lh, COLOR_LABEL_BG);
		drawText(png, label, tx + 2, ty + 2, COLOR_LABEL_FG);
	}
	fs.writeFileSync(outPath, PNG.sync.write(png));
}
