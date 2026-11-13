/**
 * 速率柱状图（sparkline）：把最近若干次采样映射成块字符画成柱状。
 *
 * 供 HUD 行 2 中列用。纯函数、无主题、无状态：只出字符串与每格的「值 / 上下文权重」，
 * 着色交给调用方（颜色按速度分档，深浅表示该轮上下文轻重）。
 * 三档画法：单行 8 档（sparkline）、两行 16 档（sparklineBars，借上一行的高度）、
 * 盲文折线（brailleLine，备选）。
 */
const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** 0 档（最矮的柱）/ 无数据占位：最低一档块字符 */
export const SPARK_BASELINE = SPARK_BLOCKS[0];
/** 默认格数（调用方一般按可用宽度传 width） */
export const SPARK_WIDTH = 24;
/** 满格参考值（会话峰值）每采样衰减：0.5%/轮 —— 不因峰值滚出窗口而突然重缩放 */
export const RATE_REF_DECAY = 0.995;

/** 采样窗口与满格参考值：ref 取传入值与窗口峰值中较大者，保证窗口内最高采样刚好满格 */
function scale(values: number[], width: number, ref?: number): { win: number[]; ref: number } {
	const win = values.slice(-width);
	const windowPeak = win.length > 0 ? Math.max(...win) : 0;
	return { win, ref: Math.max(ref ?? 0, windowPeak) };
}

/** 权重数组与值数组并行：同样只取窗口内最近 width 个，与 win 一一对齐 */
const weightWindow = (weights: number[] | undefined, width: number): number[] => (weights ?? []).slice(-width);

/** 值 → 8 档块字符（ref ≤ 0 或 0 值都落最矮一档 ▁） */
function levelChar(value: number, ref: number): string {
	if (ref <= 0 || value <= 0) return SPARK_BASELINE;
	// floor：非零最低值落在最矮的 ▁（round 会让它变 ▂，看起来像"最低也有半格"）
	const level = Math.floor((value / ref) * (SPARK_BLOCKS.length - 1));
	return SPARK_BLOCKS[Math.min(SPARK_BLOCKS.length - 1, level)]!;
}

/* ---------------------------- 速率分档与视觉加权 ---------------------------- */

/** 速率档边界（token/s）：<20 慢 / 20–50 一般 / 50–100 顺畅 / ≥100 飞快 */
export const RATE_BAND_EDGES: readonly number[] = [20, 50, 100];

/** 速率档位下标（0~3）：调用方按下标取颜色（红/琥珀/绿/青） */
export function rateBand(rate: number): number {
	const v = Math.max(0, rate);
	let i = 0;
	while (i < RATE_BAND_EDGES.length && v >= RATE_BAND_EDGES[i]!) i++;
	return i;
}

/** 视觉加权的最大淡化量（向背景混色比例）：再淡就看不清了 */
export const FADE_MAX = 0.625;
/** 淡化量化步长（量化后相邻同色可合并成一段，少出 ANSI 序列） */
export const FADE_STEP = 0.125;
/** 指数映射的对数压缩系数：bright = log(1 + K·t) / log(1 + K)，t = 本轮输出 / 参考峰值。
 * 单轮输出是重尾分布（大量中等轮 + 少数巨轮），实测 K=10 时 6 个亮度档全铺满；
 * 幂映射（开方）会把 2/3 的柱子挤在一两档里。K 越大越“只有巨轮才亮”。 */
export const BRIGHT_LOG_K = 10;

/**
 * 视觉加权：out = 该轮输出 token 数，ref = 参考峰值（会话内单轮输出的粘性峰值）。
 * 返回向背景混色的比例：**输出越长越亮**（0 = 原色最亮，FADE_MAX = 最淡）。
 * 各档大致按输出量翻倍切分（对参考峰值：≤2.7% / 10% / 23% / 44% / 77% / 100%）。
 * 无数据（undefined/非正参考值）不淡化：宁可实，不要糊。
 */
export function outputFade(out?: number, ref?: number): number {
	if (out == null || !Number.isFinite(out) || !ref || !Number.isFinite(ref) || ref <= 0) return 0;
	const t = Math.max(0, Math.min(1, out / ref));
	const bright = Math.log(1 + BRIGHT_LOG_K * t) / Math.log(1 + BRIGHT_LOG_K);
	return Math.round(((1 - bright) * FADE_MAX) / FADE_STEP) * FADE_STEP;
}

export interface SparkCell {
	/** 该格字符（8 档块字符） */
	char: string;
	/** 该格采样值（0 = 该轮无输出或无采样） */
	value: number;
	/** 该格的视觉加权量（这里是该轮输出 token 数；无数据为 undefined） */
	weight?: number;
}

/** 单行 8 档逐格数据：返回长度恒为 width（采样不足左侧补占位格），供调用方逐格上色 */
export function sparklineCells(values: number[], width = SPARK_WIDTH, opts: { ref?: number; weights?: number[] } = {}): SparkCell[] {
	if (width <= 0) return [];
	const { win, ref } = scale(values, width, opts.ref);
	const weights = weightWindow(opts.weights, width);
	const cells: SparkCell[] = [];
	for (let i = width - win.length; i > 0; i--) cells.push({ char: SPARK_BASELINE, value: 0 });
	win.forEach((raw, i) => {
		const value = Math.max(0, raw);
		cells.push({ char: levelChar(value, ref), value, weight: weights[i] });
	});
	return cells;
}

/** 单行 8 档：返回可见宽度恒为 width 的字符串（无采样/0 值画最低档 ▁ 占位） */
export function sparkline(values: number[], width = SPARK_WIDTH, opts: { ref?: number } = {}): string {
	return sparklineCells(values, width, opts)
		.map((c) => c.char)
		.join("");
}

export interface SparkBars {
	/** 下行（贴着自己那一行） */
	lower: string;
	/** 上行（借用上一行的空间；为空格处表示这采样还没到上半段） */
	upper: string;
}

export interface SparkBarCell {
	lower: string;
	upper: string;
	/** 该列采样值（0 = 该轮无输出或无采样） */
	value: number;
	/** 该列的视觉加权量（该轮输出 token 数；无数据为 undefined） */
	weight?: number;
}

/**
 * 两行 16 档逐列数据：k<8 时只有下行（`▁…█`），k≥8 时下行满格 █、上行从 `▁` 起（k=15 上行满格）。
 * 行布局由调用方决定：上一行有空位就画 upper，否则改用单行 sparkline（8 档）。
 */
export function sparkBarsCells(values: number[], width = SPARK_WIDTH, opts: { ref?: number; weights?: number[] } = {}): SparkBarCell[] {
	if (width <= 0) return [];
	const { win, ref } = scale(values, width, opts.ref);
	const weights = weightWindow(opts.weights, width);
	const blank = (): SparkBarCell => ({ lower: SPARK_BASELINE, upper: " ", value: 0 });
	if (ref <= 0) return Array.from({ length: width }, blank);
	const cells: SparkBarCell[] = Array.from({ length: width - win.length }, blank);
	win.forEach((raw, i) => {
		const value = Math.max(0, raw);
		if (value <= 0) {
			cells.push({ ...blank(), weight: weights[i] });
			return;
		}
		const k = Math.min(15, Math.round((value / ref) * 15));
		cells.push({
			lower: k < 8 ? SPARK_BLOCKS[k]! : SPARK_BLOCKS[7]!,
			upper: k < 8 ? " " : SPARK_BLOCKS[k - 8]!,
			value,
			weight: weights[i],
		});
	});
	return cells;
}

/** 两行 16 档：只要字符串形态时用（参数同 sparkBarsCells） */
export function sparklineBars(values: number[], width = SPARK_WIDTH, opts: { ref?: number } = {}): SparkBars {
	const cells = sparkBarsCells(values, width, opts);
	return {
		lower: cells.map((c) => c.lower).join(""),
		upper: cells.map((c) => c.upper).join(""),
	};
}

// ---------------------------------------------------------------------------
// 折线模式（盲文，备选）：同一行里用 2×4 点阵画真折线
// ---------------------------------------------------------------------------

/** 盲文点阵：每格 2 点列 × 4 点行，位掩码按 Unicode 盲文标准排列 */
const BRAILLE_BASE = 0x2800;
const DOT_BITS: number[][] = [
	[0x01, 0x02, 0x04, 0x40], // 左列：点 1 / 2 / 3 / 7
	[0x08, 0x10, 0x20, 0x80], // 右列：点 4 / 5 / 6 / 8
];
/** 折线纵向档数（每格 4 个点行） */
const LINE_ROWS = 4;

/**
 * 折线模式：把采样按参考值映射到 2×4 点阵并**连接相邻点**（真折线，不是柱状）。
 * 横向密度是同宽柱状图的 2 倍，纵向只有 4 档（盲文点行数所限）；返回长度恒为 width。
 */
export function brailleLine(values: number[], width = SPARK_WIDTH, opts: { ref?: number } = {}): string {
	if (width <= 0) return "";
	const { win, ref } = scale(values, width, opts.ref);
	const pad = " ".repeat(width - win.length);
	if (ref <= 0 || win.length === 0) return " ".repeat(width);
	const level = (v: number): number => {
		const ratio = Math.max(0, Math.min(1, Math.max(0, v) / ref));
		return Math.round((1 - ratio) * (LINE_ROWS - 1));
	};
	const glyphs: string[] = [];
	for (let i = 0; i < win.length; i++) {
		if (win[i] <= 0 && (i === 0 || win[i - 1] <= 0)) {
			glyphs.push(" "); // 空轮（没有输出）不留点，折线自然断开
			continue;
		}
		const y = level(Math.max(0, win[i]));
		const yPrev = i === 0 ? y : level(win[i - 1]);
		const mask = [0, 0];
		const dots: Array<[number, number]> = [];
		if (i === 0) {
			dots.push([0, y], [1, y]);
		} else {
			const steps = Math.max(1, Math.abs(y - yPrev));
			for (let s = 0; s <= steps; s++) {
				const t = s / steps;
				dots.push([t < 0.5 ? 0 : 1, Math.round(yPrev + (y - yPrev) * t)]);
			}
			dots.push([1, y]);
		}
		for (const [col, row] of dots) {
			if (row >= 0 && row < LINE_ROWS) mask[col] |= DOT_BITS[col][row];
		}
		glyphs.push(String.fromCodePoint(BRAILLE_BASE + (mask[0] | mask[1])));
	}
	return pad + glyphs.join("");
}
