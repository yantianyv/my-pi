/**
 * 输出速率曲线（sparkline）：把最近若干次采样映射成 8 档块字符，画成一行小图。
 *
 * 供 HUD 行 2 中列用（速率数字旁边的一行小图，比单个数字更看得出节奏）。
 * 纯函数、无主题、无状态：只回每格的字符与「是否高于均值基准」，着色交给调用方
 * （HUD 用亮色画高于均值、暗色画低于——这就是曲线里体现 EMA 位置的办法）。
 */
/** 8 档块字符：0 档与冷启动占位都用最低档 ▁（块字符纵向只有 8 个定义好的档位） */
const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
/** 0 档（最矮的柱）/ 无数据占位：最低一档块字符 */
export const SPARK_BASELINE = SPARK_BLOCKS[0];

/** 曲线默认格数：一格 = 一轮，24 格 = 最近 24 轮 */
export const SPARK_WIDTH = 24;
/** 满格参考值（会话峰值）每采样衰减：0.5%/5s ≈ 6%/分钟——不因峰值滚出窗口而突然重缩放 */
export const RATE_REF_DECAY = 0.995;

export interface SparkCell {
	/** 该格字符（8 档块字符或空格） */
	char: string;
	/** 该采样是否 ≥ 均值基准（供调用方上色区分） */
	aboveBaseline: boolean;
}

/**
 * 速率曲线格子：窗口内最近 width 个采样，按参考值归一化到 8 档块字符。
 * 无采样（冷启动补位）与 0 值（该轮没有输出）画最低档 ▁ —— 既是占位也是 0 高度的柱。
 * - ref：满格参考值（HUD 传「会话峰值 × 缓慢衰减」；缺省用窗口峰值）。取两者较大者，
 *   保证窗口内最高采样也顶多刚好满格；
 * - baseline：均值基准（HUD 传 EMA），只用于标记 aboveBaseline，不参与高度计算；
 * - 采样不足左侧补空格、参考值 ≤ 0（全程空闲）整格空格——返回格数恒为 width，
 *   调用方不必再补齐（否则右边数字会随采样数抖动）。
 */
export function sparklineCells(
	values: number[],
	width = SPARK_WIDTH,
	opts: { ref?: number; baseline?: number } = {},
): SparkCell[] {
	if (width <= 0) return [];
	const win = values.slice(-width);
	const windowPeak = win.length > 0 ? Math.max(...win) : 0;
	const ref = Math.max(opts.ref ?? 0, windowPeak);
	const baseline = opts.baseline ?? 0;
	const cells: SparkCell[] = [];
	for (let i = 0; i < width - win.length; i++) cells.push({ char: SPARK_BASELINE, aboveBaseline: false });
	for (const raw of win) {
		const value = Math.max(0, raw);
		if (ref <= 0 || value <= 0) {
			cells.push({ char: SPARK_BASELINE, aboveBaseline: false });
			continue;
		}
		// floor：非零最低值落在最矮的 ▁（round 会让它变 ▂，看起来像"最低也有半格"）
		const level = Math.floor((value / ref) * (SPARK_BLOCKS.length - 1));
		cells.push({
			char: SPARK_BLOCKS[Math.min(SPARK_BLOCKS.length - 1, level)],
			aboveBaseline: baseline > 0 && value >= baseline,
		});
	}
	return cells;
}

/** 只要字符串形态（不需要分档着色时用）；参数同 sparklineCells */
export function sparkline(values: number[], width = SPARK_WIDTH, opts: { ref?: number } = {}): string {
	return sparklineCells(values, width, opts)
		.map((c) => c.char)
		.join("");
}

// ---------------------------------------------------------------------------
// 折线模式（盲文）：同一行里用 2×4 点阵画真折线
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
 * - 横向密度是同宽柱状图的 2 倍（每格 2 个点列），纵向只有 4 档（盲文点行数所限）；
 * - ref 同上（缺省窗口峰值）；返回的每格字符长度恒等于 width（采样不足左侧补空格）。
 * 视觉上比柱状更"细"、像折线图；代价是纵向精度低于 8 档块字符。
 */
export function brailleLine(values: number[], width = SPARK_WIDTH, opts: { ref?: number } = {}): string {
	if (width <= 0) return "";
	const win = values.slice(-width);
	const pad = " ".repeat(Math.max(0, width - win.length));
	const ref = Math.max(opts.ref ?? 0, win.length > 0 ? Math.max(...win) : 0);
	if (ref <= 0 || win.length === 0) return pad + " ".repeat(win.length);
	// 每格 2 个点列：把采样值映射到点行（0 = 顶行）
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
		// 本格两个点列：左列接上一采样（补连线），右列放本采样
		const dots: Array<[number, number]> = [];
		if (i === 0) dots.push([0, y], [1, y]);
		else {
			// 从上一采样到本采样线性插值，逐点列落点，形成连续折线
			const from = yPrev;
			const to = y;
			const steps = Math.max(1, Math.abs(to - from));
			for (let s = 0; s <= steps; s++) {
				const t = s / steps;
				const yy = Math.round(from + (to - from) * t);
				const col = t < 0.5 ? 0 : 1;
				dots.push([col, yy]);
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

// ---------------------------------------------------------------------------
// 两行柱状（16 档）：借上一行的高度，上面那行要用时就退回单行
// ---------------------------------------------------------------------------

export interface SparkBars {
	/** 下行（贴着自己那一行） */
	lower: SparkCell[];
	/** 上行（借用上一行的空间；值为空格的格表示这采样还没到上半段） */
	upper: SparkCell[];
}

/**
 * 两行柱状：把 0~15 共 **16 档**拆到上下两行——k<8 时只有下行（`▁…█`），
 * k≥8 时下行满格 █、上行从 `▁` 起（k=15 上行满格 █）。
 * 行布局由调用方决定：上一行有空位就画 upper，否则只画 lower（8 档单行）。
 * 无采样/0 值同样画 ▁ 占位（上行留空格）。
 */
export function sparklineBars(
	values: number[],
	width = SPARK_WIDTH,
	opts: { ref?: number; baseline?: number } = {},
): SparkBars {
	const lower: SparkCell[] = [];
	const upper: SparkCell[] = [];
	if (width <= 0) return { lower, upper };
	const win = values.slice(-width);
	const windowPeak = win.length > 0 ? Math.max(...win) : 0;
	const ref = Math.max(opts.ref ?? 0, windowPeak);
	const baseline = opts.baseline ?? 0;
	for (let i = 0; i < width - win.length; i++) {
		lower.push({ char: SPARK_BASELINE, aboveBaseline: false });
		upper.push({ char: " ", aboveBaseline: false });
	}
	for (const raw of win) {
		const value = Math.max(0, raw);
		if (ref <= 0 || value <= 0) {
			lower.push({ char: SPARK_BASELINE, aboveBaseline: false });
			upper.push({ char: " ", aboveBaseline: false });
			continue;
		}
		const k = Math.min(15, Math.round((value / ref) * 15));
		const aboveBaseline = baseline > 0 && value >= baseline;
		lower.push({ char: k < 8 ? SPARK_BLOCKS[k] : SPARK_BLOCKS[7], aboveBaseline });
		upper.push({ char: k < 8 ? " " : SPARK_BLOCKS[k - 8], aboveBaseline });
	}
	return { lower, upper };
}
