/**
 * 速率柱状图（sparkline）：把最近若干次采样映射成块字符画成柱状。
 *
 * 供 HUD 行 2 中列用。纯函数、无主题、无状态：只出字符串，着色交给调用方。
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

/** 单行 8 档：返回可见宽度恒为 width 的字符串（无采样/0 值画最低档 ▁ 占位） */
export function sparkline(values: number[], width = SPARK_WIDTH, opts: { ref?: number } = {}): string {
	if (width <= 0) return "";
	const { win, ref } = scale(values, width, opts.ref);
	const pad = SPARK_BASELINE.repeat(width - win.length);
	if (ref <= 0) return SPARK_BASELINE.repeat(width);
	return (
		pad +
		win
			.map((raw) => {
				const value = Math.max(0, raw);
				if (value <= 0) return SPARK_BASELINE;
				// floor：非零最低值落在最矮的 ▁（round 会让它变 ▂，看起来像"最低也有半格"）
				const level = Math.floor((value / ref) * (SPARK_BLOCKS.length - 1));
				return SPARK_BLOCKS[Math.min(SPARK_BLOCKS.length - 1, level)];
			})
			.join("")
	);
}

export interface SparkBars {
	/** 下行（贴着自己那一行） */
	lower: string;
	/** 上行（借用上一行的空间；为空格处表示这采样还没到上半段） */
	upper: string;
}

/**
 * 两行 16 档：k<8 时只有下行（`▁…█`），k≥8 时下行满格 █、上行从 `▁` 起（k=15 上行满格）。
 * 行布局由调用方决定：上一行有空位就画 upper，否则改用单行 sparkline（8 档）。
 */
export function sparklineBars(values: number[], width = SPARK_WIDTH, opts: { ref?: number } = {}): SparkBars {
	if (width <= 0) return { lower: "", upper: "" };
	const { win, ref } = scale(values, width, opts.ref);
	const padLen = width - win.length;
	if (ref <= 0) return { lower: SPARK_BASELINE.repeat(width), upper: " ".repeat(width) };
	const lower: string[] = [SPARK_BASELINE.repeat(padLen)];
	const upper: string[] = [" ".repeat(padLen)];
	for (const raw of win) {
		const value = Math.max(0, raw);
		if (value <= 0) {
			lower.push(SPARK_BASELINE);
			upper.push(" ");
			continue;
		}
		const k = Math.min(15, Math.round((value / ref) * 15));
		lower.push(k < 8 ? SPARK_BLOCKS[k] : SPARK_BLOCKS[7]);
		upper.push(k < 8 ? " " : SPARK_BLOCKS[k - 8]);
	}
	return { lower: lower.join(""), upper: upper.join("") };
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
