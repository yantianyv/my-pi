#!/usr/bin/env node
/**
 * hud-spark（速率柱状图 / 折线）回归测试
 *
 * 锁住的不变量：
 * - 宽度恒等：返回的可见宽度必须精确等于 width（否则右侧数字与竖线会随采样数抖动）；
 * - 0 档与无数据占位：一律最低档 ▁（块字符纵向只有 8 个标准档位）；
 * - 归一化：按参考值（缺省窗口峰值、可传会话峰值衰减值）映射，峰值满格 █；
 * - 两行柱（16 档）：k<8 只有下行；k≥8 下行满格 █、上行从 ▁ 起；k=15 上行满格；
 * - 折线（盲文 2×4 点阵，备选）：长度恒等、空轮断开、字符落在盲文区。
 *
 * 原理：node 直接 import 不了 .ts，先用 esbuild（src/node_modules）bundle 成单文件 ESM。
 *
 * 用法：node src/extensions/hud/test/sparkline.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const HUD_DIR = join(TEST_DIR, "..");
const SRC_DIR = join(HUD_DIR, "../..");
const BUNDLE = join(TEST_DIR, ".tmp-spark-bundle.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

await build({
	entryPoints: [join(HUD_DIR, "hud-spark.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
const { sparkline, sparklineBars, brailleLine, SPARK_WIDTH, RATE_REF_DECAY } = await import(pathToFileURL(BUNDLE).href);
// 块字符与空格都是 1 格，与 pi-tui 的 visibleWidth 同口径
const w = (s) => [...s].length;

console.log("单行柱状（8 档）");
check("默认宽度 == SPARK_WIDTH", w(sparkline([1, 2, 3])) === SPARK_WIDTH, String(w(sparkline([1, 2, 3]))));
for (const width of [1, 4, 8, 10, 24, 26, 40]) {
	check(`w=${width}: 采样充足时宽度精确`, w(sparkline([1, 5, 9, 3, 7, 2, 8, 4, 6, 10, 1, 2, 3], width)) === width);
	check(
		`w=${width}: 采样不足时左侧补 ▁ 占位`,
		w(sparkline([3, 6], width)) === width && sparkline([3, 6], width).startsWith("▁".repeat(Math.max(0, width - 2))),
	);
}
check("峰值映射到最高块 █", sparkline([1, 2, 9, 3], 4).includes("█"));
check("最低值映射到 ▁（非空格）", sparkline([1, 9], 2).startsWith("▁"));
check("全零（空闲）画 0 档 ▁", sparkline([0, 0, 0, 0], 4) === "▁▁▁▁", sparkline([0, 0, 0, 0], 4));
check("冷启动无采样画 ▁ 占位", sparkline([], 5) === "▁▁▁▁▁", sparkline([], 5));
check("负值按 0 档处理（▁）", sparkline([-5, 10], 2) === "▁█", sparkline([-5, 10], 2));
check("空闲轮落 0 档 ▁", sparkline([50, 0, 50], 3, { ref: 50 }) === "█▁█", sparkline([50, 0, 50], 3, { ref: 50 }));
check("只取窗口内最近 width 个采样", sparkline([100, 1, 2, 3], 3) === sparkline([1, 2, 3], 3));
check("宽度 0 返回空串（不崩）", sparkline([1, 2], 0) === "");
check("宽度为负返回空串（不崩）", sparkline([1, 2], -3) === "");
check("归一化：整体放大不改变形状", sparkline([1, 2, 4], 3) === sparkline([100, 200, 400], 3));

console.log("满格参考值（会话峰值衰减）");
check("ref 小于窗口峰值时按窗口峰值归一（不小于峰值）", sparkline([100], 1, { ref: 10 }) === "█");
check("ref 大于窗口峰值时曲线整体偏低（峰值已衰减的效果）", sparkline([10, 20], 2, { ref: 1000 }) === "▁▁");
check("无 ref 时退化为窗口峰值归一（10/20 → 第 4 档 ▄）", sparkline([10, 20], 2) === "▄█", sparkline([10, 20], 2));
check("参考值 ≤ 0（全程空闲）整格 ▁", sparkline([0, 0], 2, { ref: 0 }) === "▁▁");
check("衰减系数在 (0,1) 内（缓慢衰减）", RATE_REF_DECAY > 0 && RATE_REF_DECAY < 1, String(RATE_REF_DECAY));

console.log("两行柱状（16 档）");
for (const width of [1, 8, 24, 26, 40]) {
	const bars = sparklineBars([10, 50, 100], width);
	check(`w=${width}: 上下行长度都精确等于 width`, w(bars.lower) === width && w(bars.upper) === width, `${w(bars.lower)}/${w(bars.upper)}`);
}
{
	// 60/100 在 16 档下是 k=9（已进上半段），要用 k<8 的值看"上行空"
	const bars = sparklineBars([0, 40, 100], 3, { ref: 100 });
	check("k<8：只有下行有柱、上行空", bars.lower[1] === "▇" && bars.upper[1] === " ", `${bars.lower[1]}/${bars.upper[1]}`);
	check("0 值：下行 ▁ 占位、上行空", bars.lower[0] === "▁" && bars.upper[0] === " ");
	check("k=8：下行满格 █、上行起 ▁", sparklineBars([50], 1, { ref: 100 }).lower === "█" && sparklineBars([50], 1, { ref: 100 }).upper === "▁");
	check("k=15：上下都满格 █", sparklineBars([100], 1, { ref: 100 }).lower === "█" && sparklineBars([100], 1, { ref: 100 }).upper === "█");
	check("冷启动：下行 ▁ 占位、上行空", sparklineBars([], 2).lower === "▁▁" && sparklineBars([], 2).upper === "  ");
	check("宽度 0 返回空串", sparklineBars([1], 0).lower === "" && sparklineBars([1], 0).upper === "");
	check("两行柱与单行柱同宽（可对齐）", w(sparkline([1, 2, 3], 5)) === w(sparklineBars([1, 2, 3], 5).lower));
	check("两行柱的下行不低于单行柱的对应档（16 档更细）", sparklineBars([50], 1, { ref: 100 }).lower === "█" && sparkline([50], 1, { ref: 100 }) === "▄");
}

console.log("折线模式（盲文 2×4 点阵，备选）");
check("折线长度恒为 width", w(brailleLine([10, 20, 30], 8)) === 8);
check("折线采样不足左侧补空格", brailleLine([30], 4).startsWith("   "));
check("折线全零整格空格", brailleLine([0, 0, 0, 0], 4) === "    ");
check("折线空采样整格空格", brailleLine([], 3) === "   ");
check("折线峰值行不留空（有笔画）", [...brailleLine([100, 100], 2, { ref: 100 })].every((c) => c !== " "));
check(
	"折线字符全在盲文区（U+2800–U+28FF 或空格）",
	[...brailleLine([10, 50, 100, 20], 4, { ref: 100 })].every((c) => c === " " || (c.codePointAt(0) >= 0x2800 && c.codePointAt(0) <= 0x28ff)),
);
check("折线宽度 0 返回空串", brailleLine([1, 2], 0) === "");

rmSync(BUNDLE, { force: true });

console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
