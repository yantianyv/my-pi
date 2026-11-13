/**
 * computer-use/verify：动作之后确认它真的生效了
 *
 * 为什么必须是**全屏差分**而不是"目标框内比较"：实测踩过这个坑。
 * 往记事本输入一行中文，文字确实进去了，但工具报"画面基本没变（差异 0.0%）"——
 * 因为验证区域取了文本编辑器元素框（1896×894）外扩 24px，几乎整窗，降采样到 8×8 后
 * 那一行字的变化被稀释到千分位以下。**区域越大、变化越局部，平均法就越瞎。**
 *
 * 现在的做法：拿动作前后的两张全屏图逐块比对，直接找出"哪里变了"，只对变化区下结论。
 * - 全局无差异 → 明说"没变"；
 * - 有差异 → 报告变化区的位置与大小，让模型结合语义判断这是不是它想要的效果。
 *
 * 局限仍然要说清：**"画面变了"不等于"动作成功"**（时钟、视频、光标闪烁都会变），
 * **"画面没变"也不等于"动作失败"**（有的操作本就不改画面）。所以给的是差分事实，
 * 不是成功/失败判定。光标闪烁是主要噪音源，用 minChangedPixels 门槛压掉。
 *
 * 性能：全屏 2560×1600 → 按 32×32 分块共 4000 块，每块采样若干点，约 15~30ms，
 * 比一次抓屏（130ms）便宜得多，可以每个动作都做。
 */
import * as fs from "node:fs";
import { PNG } from "pngjs";
import type { ScreenGrid } from "./platform/types";

/** 差分块边长（像素）：越小定位越准、块数越多 */
const BLOCK = 32;
/** 一块被判为"变了"所需的平均亮度差（0..255）。低于它算渲染抖动/抗锯齿差异 */
const BLOCK_DIFF_THRESHOLD = 12;
/** 判定整体"有变化"的最少变化块数：单块变化多半是光标闪烁或时钟秒数 */
export const MIN_CHANGED_BLOCKS = 2;

/** 一张可比较的截图（RGB 已提取，便于快速差分） */
export interface Frame {
	w: number;
	h: number;
	/** 灰度值，长度 w*h */
	gray: Uint8Array;
}

/** 变化区域（物理像素） */
export interface ChangeRegion {
	x: number;
	y: number;
	w: number;
	h: number;
	/** 该区域内的变化块数 */
	blocks: number;
}

/** 差分结论 */
export interface DiffOutcome {
	/** 是否出现可辨变化（变化块数达到门槛） */
	changed: boolean;
	/** 变化块总数 */
	changedBlocks: number;
	/** 变化区域占全屏的百分比 */
	changedRatio: number;
	/** 变化区（有时是几个分散的块，给出它们的整体包围盒） */
	region: ChangeRegion | null;
	/** 给模型看的一句话结论 */
	summary: string;
}

/** 读 PNG 成灰度帧 */
export function readFrame(file: string): Frame {
	const png = PNG.sync.read(fs.readFileSync(file));
	const { width: w, height: h, data } = png;
	const gray = new Uint8Array(w * h);
	for (let i = 0, n = w * h; i < n; i++) {
		// BT.601 亮度权重：与视觉感知一致
		gray[i] = Math.round(data[i * 4]! * 0.299 + data[i * 4 + 1]! * 0.587 + data[i * 4 + 2]! * 0.114);
	}
	return { w, h, gray };
}

/**
 * 两张同尺寸帧的差分。
 *
 * 逐块比较（每块取均匀采样的若干点），块内平均差超阈值即记为"变了"。
 * 不用逐像素：全屏 400 万像素逐个比对在 JS 里要几十毫秒且对抖动过于敏感；
 * 分块平均正好把"一行字变了"这种局部变化保留下来（块足够小）。
 */
/**
 * 可选的比较范围。给了就只在窗口矩形内统计变化块。
 *
 * 为什么需要：全屏比较会稀释窗口内的变化。实测记事本窗口 1920×1118 占全屏
 * 2560×1600 的一半，滚动 3 格只改了窗口内一小块，全屏统计时变化块数不到门槛，
 * 于是报"画面没变"——而用户肉眼明明看到滚动了。窗口范围外的像素（桌面图标、
 * 其他窗口）本来就不该参与判断。
 */
export interface DiffScope {
	x: number;
	y: number;
	w: number;
	h: number;
}

export function diffFrames(before: Frame, after: Frame, scope?: DiffScope): DiffOutcome {
	if (before.w !== after.w || before.h !== after.h) {
		return {
			changed: true,
			changedBlocks: 0,
			changedRatio: 1,
			region: null,
			summary: "截图尺寸发生变化（分辨率或缩放改动），无法比对",
		};
	}
	const { w, h } = before;
	// 限定范围时只扫窗口覆盖到的块；范围裁剪到画面内，避免越界
	const sx0 = scope ? Math.max(0, Math.floor(scope.x)) : 0;
	const sy0 = scope ? Math.max(0, Math.floor(scope.y)) : 0;
	const sx1 = scope ? Math.min(w, Math.ceil(scope.x + scope.w)) : w;
	const sy1 = scope ? Math.min(h, Math.ceil(scope.y + scope.h)) : h;
	const cols = Math.ceil((sx1 - sx0) / BLOCK);
	const rows = Math.ceil((sy1 - sy0) / BLOCK);
	let changedBlocks = 0;
	let minX = w, minY = h, maxX = -1, maxY = -1;

	for (let by = 0; by < rows; by++) {
		const y0 = sy0 + by * BLOCK;
		const y1 = Math.min(sy1, y0 + BLOCK);
		for (let bx = 0; bx < cols; bx++) {
			const x0 = sx0 + bx * BLOCK;
			const x1 = Math.min(sx1, x0 + BLOCK);
			// 每块采样 4×4 个点，足以反映块内平均变化
			const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
			const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
			let sum = 0, n = 0;
			for (let y = y0; y < y1; y += stepY) {
				for (let x = x0; x < x1; x += stepX) {
					const i = y * w + x;
					sum += Math.abs(before.gray[i]! - after.gray[i]!);
					n++;
				}
			}
			if (n > 0 && sum / n >= BLOCK_DIFF_THRESHOLD) {
				changedBlocks++;
				if (x0 < minX) minX = x0;
				if (y0 < minY) minY = y0;
				if (x1 > maxX) maxX = x1;
				if (y1 > maxY) maxY = y1;
			}
		}
	}

	const changed = changedBlocks >= MIN_CHANGED_BLOCKS;
	const totalBlocks = cols * rows;
	const region: ChangeRegion | null =
		changed && maxX > minX
			? { x: minX, y: minY, w: maxX - minX, h: maxY - minY, blocks: changedBlocks }
			: null;

	return {
		changed,
		changedBlocks,
		changedRatio: totalBlocks > 0 ? changedBlocks / totalBlocks : 0,
		region,
		summary: changed
			? `画面有变化：${changedBlocks} 块（约占 ${((changedBlocks / totalBlocks) * 100).toFixed(1)}%${
					scope ? "，统计范围限定在目标窗口内" : ""
				}）` + (region ? `，变化区 (${region.x},${region.y}) ${region.w}×${region.h}` : "")
			: `画面没有可辨变化${scope ? "（目标窗口内）" : ""}——操作可能未生效（也可能是该操作本就不改变画面）`,
	};
}

/**
 * 直接从宿主回传的块网格出结论（不落盘、不解码 PNG）。
 *
 * 这条路径替代了「抓屏存 PNG → 这里 readFrame 解码」的旧实现：旧路径实测
 * 抓屏+PNG 约 200ms + 解码约 150ms，而动作前后各要一次，等于每个动作白付 600ms。
 * 网格由宿主在同一份位图上采样（21~29ms 含抓屏），且采样点与 diffFrames 完全一致
 * （同 32px 块、同 4×4 采样、同 BT.601），所以两种输入的结论可直接互换。
 */
export function diffGrids(before: ScreenGrid, after: ScreenGrid, scope?: DiffScope): DiffOutcome {
	if (before.w !== after.w || before.h !== after.h) {
		return {
			changed: true,
			changedBlocks: 0,
			changedRatio: 1,
			region: null,
			summary: "截图尺寸发生变化（分辨率或缩放改动），无法比对",
		};
	}
	const { w, h, cols } = before;
	const rows = before.rows;
	// 限定范围时只统计窗口覆盖到的块
	const bx0 = scope ? Math.max(0, Math.floor(scope.x / BLOCK)) : 0;
	const by0 = scope ? Math.max(0, Math.floor(scope.y / BLOCK)) : 0;
	const bx1 = scope ? Math.min(cols, Math.ceil((scope.x + scope.w) / BLOCK)) : cols;
	const by1 = scope ? Math.min(rows, Math.ceil((scope.y + scope.h) / BLOCK)) : rows;

	let changedBlocks = 0;
	let minX = w, minY = h, maxX = -1, maxY = -1;
	for (let by = by0; by < by1; by++) {
		for (let bx = bx0; bx < bx1; bx++) {
			const i = by * cols + bx;
			const a = before.cells[i] ?? 0;
			const b = after.cells[i] ?? 0;
			if (Math.abs(a - b) >= BLOCK_DIFF_THRESHOLD) {
				changedBlocks++;
				const x0 = bx * BLOCK;
				const y0 = by * BLOCK;
				if (x0 < minX) minX = x0;
				if (y0 < minY) minY = y0;
				if (x0 + BLOCK > maxX) maxX = x0 + BLOCK;
				if (y0 + BLOCK > maxY) maxY = y0 + BLOCK;
			}
		}
	}
	const changed = changedBlocks >= MIN_CHANGED_BLOCKS;
	const totalBlocks = Math.max(1, (bx1 - bx0) * (by1 - by0));
	const region: ChangeRegion | null =
		changed && maxX > minX ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY, blocks: changedBlocks } : null;
	return {
		changed,
		changedBlocks,
		changedRatio: changedBlocks / totalBlocks,
		region,
		summary: changed
			? `画面有变化：${changedBlocks} 块（约占 ${((changedBlocks / totalBlocks) * 100).toFixed(1)}%${
					scope ? "，统计范围限定在目标窗口内" : ""
				}）` + (region ? `，变化区 (${region.x},${region.y}) ${region.w}×${region.h}` : "")
			: `画面没有可辨变化${scope ? "（目标窗口内）" : ""}——操作可能未生效（也可能是该操作本就不改变画面）`,
	};
}
