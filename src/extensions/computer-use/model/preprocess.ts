/**
 * computer-use/model/preprocess：截图 → 模型输入张量（纯 JS，零原生依赖）
 *
 * 三个约束都是实测踩出来的，改这里前先看清楚：
 *
 * 1) **输入边长必须是 32 的倍数**。OmniParser icon_detect 是 YOLOv8，下采样 stride 到 32；
 *    给 640×400 会直接崩（wasm 与原生 ONNX 都崩）。所以缩完还要补齐到 32 的倍数。
 * 2) **不能拉伸成正方形**。把 16:10 的屏幕硬压成 640×640 时检测准确率骤降（实测正文区全漏），
 *    必须等比缩放后左上对齐、右下补黑。
 * 3) **最长边就是 640**。模型训练时的最长边是 640；放大不会更准，只会更慢。
 *
 * 缩放用面积平均（box filter）而不是最近邻：UI 里大量 1px 细线（边框、文本笔画），
 * 最近邻会让它们整条消失或抖动，平均保留灰度、更接近训练分布。
 *
 * 输出是 NCHW float32、值域 0..1、RGB 顺序（模型 do_normalize=false，只做 rescale 1/255）。
 */
import * as fs from "node:fs";
import { PNG } from "pngjs";

/**
 * 模型输入的最长边。
 *
 * 训练配置是 640，但实测 640 对"小元素密集"的界面召回太差：桌面图标在 640 宽的
 * 缩图上只有十几像素，30 个图标只能检出 20 个（67%）。提到 1024 后同一张图检出
 * 37 个（含少量误检），耗时只从 72ms 涨到 92ms。
 *
 * 之所以能超训练值：YOLOv8 是全卷积网络，输入尺寸只需 32 对齐即可跑，
 * 大分辨率下小目标特征不会被下采样抹掉。
 */
export const MODEL_LONG_EDGE = 1024;
/** 输入边长对齐粒度：YOLOv8 的 stride */
export const MODEL_STRIDE = 32;

/** 一张图解码后的 RGB 像素缓冲（便于在中途做缩放） */
export interface RgbImage {
	w: number;
	h: number;
	/** RGB 交错，长度 w*h*3 */
	data: Uint8Array;
}

/** 模型输入张量与坐标映射信息 */
export interface ModelInput {
	/** CHW float32，已除以 255 */
	tensor: Float32Array;
	/** 张量宽（32 的倍数） */
	w: number;
	/** 张量高（32 的倍数） */
	h: number;
	/** 原始图宽高（截图物理像素） */
	srcW: number;
	srcH: number;
	/** 实际绘制的区域尺寸（其余部分为黑边）；用于把模型坐标映射回屏幕 */
	drawnW: number;
	drawnH: number;
	/** 缩放比：屏幕像素 / 模型像素 = srcW / drawnW */
	scale: number;
}

/** 读 PNG 成 RGB（去掉 alpha 通道：截图不透明，模型也不要 alpha） */
export function readPngRgb(file: string): RgbImage {
	const png = PNG.sync.read(fs.readFileSync(file));
	const { width, height, data } = png;
	const out = new Uint8Array(width * height * 3);
	for (let i = 0, n = width * height; i < n; i++) {
		out[i * 3] = data[i * 4]!;
		out[i * 3 + 1] = data[i * 4 + 1]!;
		out[i * 3 + 2] = data[i * 4 + 2]!;
	}
	return { w: width, h: height, data: out };
}

/**
 * 面积平均缩小到指定位图尺寸。
 * 对每个目标像素，取它在源图上覆盖的矩形，按覆盖面积加权平均——这是缩小（下采样）的正确做法，
 * 等效于 PIL 的 box 滤波。只有当源区域完全落在像素内时才退化为点采样。
 */
export function resizeArea(src: RgbImage, dw: number, dh: number): RgbImage {
	const { w: sw, h: sh, data } = src;
	if (sw === dw && sh === dh) return src;
	const out = new Uint8Array(dw * dh * 3);
	const xRatio = sw / dw;
	const yRatio = sh / dh;
	for (let dy = 0; dy < dh; dy++) {
		const sy0 = dy * yRatio;
		const sy1 = Math.min(sh, (dy + 1) * yRatio);
		const y0 = Math.floor(sy0);
		const y1 = Math.min(sh, Math.ceil(sy1));
		for (let dx = 0; dx < dw; dx++) {
			const sx0 = dx * xRatio;
			const sx1 = Math.min(sw, (dx + 1) * xRatio);
			const x0 = Math.floor(sx0);
			const x1 = Math.min(sw, Math.ceil(sx1));
			let r = 0, g = 0, b = 0, wsum = 0;
			for (let sy = y0; sy < y1; sy++) {
				// 该源行与目标像素在 y 方向的覆盖高度
				const wy = Math.min(sy1, sy + 1) - Math.max(sy0, sy);
				if (wy <= 0) continue;
				for (let sx = x0; sx < x1; sx++) {
					const wx = Math.min(sx1, sx + 1) - Math.max(sx0, sx);
					if (wx <= 0) continue;
					const weight = wx * wy;
					const si = (sy * sw + sx) * 3;
					r += data[si]! * weight;
					g += data[si + 1]! * weight;
					b += data[si + 2]! * weight;
					wsum += weight;
				}
			}
			const di = (dy * dw + dx) * 3;
			if (wsum > 0) {
				out[di] = Math.round(r / wsum);
				out[di + 1] = Math.round(g / wsum);
				out[di + 2] = Math.round(b / wsum);
			}
		}
	}
	return { w: dw, h: dh, data: out };
}

/** 计算缩放后的绘制尺寸与补齐后的张量尺寸（两者都对齐到 32 的倍数） */
export function planInputSize(srcW: number, srcH: number, longEdge = MODEL_LONG_EDGE): { drawnW: number; drawnH: number; w: number; h: number; scale: number } {
	const scale = longEdge / Math.max(srcW, srcH);
	const drawnW = Math.max(MODEL_STRIDE, Math.round(srcW * scale));
	const drawnH = Math.max(MODEL_STRIDE, Math.round(srcH * scale));
	const align = (n: number) => Math.ceil(n / MODEL_STRIDE) * MODEL_STRIDE;
	return { drawnW, drawnH, w: align(drawnW), h: align(drawnH), scale: srcW / drawnW };
}

/** 把 RGB 图铺到 NCHW float32 画布左上角，其余留 0（黑边） */
export function toTensor(img: RgbImage, w: number, h: number): Float32Array {
	const n = w * h;
	const out = new Float32Array(3 * n);
	const { w: iw, h: ih, data } = img;
	for (let y = 0; y < ih && y < h; y++) {
		for (let x = 0; x < iw && x < w; x++) {
			const si = (y * iw + x) * 3;
			const di = y * w + x;
			out[di] = data[si]! / 255;
			out[n + di] = data[si + 1]! / 255;
			out[2 * n + di] = data[si + 2]! / 255;
		}
	}
	return out;
}

/** 一步到位：截图文件 → 模型输入（含坐标映射信息） */
export function prepareInput(pngPath: string, longEdge = MODEL_LONG_EDGE): ModelInput {
	const src = readPngRgb(pngPath);
	const { drawnW, drawnH, w, h, scale } = planInputSize(src.w, src.h, longEdge);
	const small = resizeArea(src, drawnW, drawnH);
	return { tensor: toTensor(small, w, h), w, h, srcW: src.w, srcH: src.h, drawnW, drawnH, scale };
}

/**
 * 模型坐标 → 屏幕物理像素。
 * 模型在 640×H 的缩小图上给框，乘 scale 即回到截图坐标；截图坐标就是屏幕物理像素
 * （宿主以 PerMonitorV2 抓屏），所以不需要再叠任何额外偏移。
 */
export function mapBox(
	b: { x: number; y: number; w: number; h: number },
	input: Pick<ModelInput, "scale" | "srcW" | "srcH">,
): { x: number; y: number; w: number; h: number } {
	const x = Math.max(0, Math.round(b.x * input.scale));
	const y = Math.max(0, Math.round(b.y * input.scale));
	const w = Math.round(b.w * input.scale);
	const h = Math.round(b.h * input.scale);
	// 夹到屏幕内：模型偶尔会在黑边上给出越界的框
	return {
		x: Math.min(x, Math.max(0, input.srcW - 1)),
		y: Math.min(y, Math.max(0, input.srcH - 1)),
		w: Math.max(1, Math.min(w, input.srcW - x)),
		h: Math.max(1, Math.min(h, input.srcH - y)),
	};
}
