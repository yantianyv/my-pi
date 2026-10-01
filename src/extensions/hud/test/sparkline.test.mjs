#!/usr/bin/env node
/**
 * HUD 速率曲线（sparkline）回归测试
 *
 * 背景：速率以前只有一个数字，看不出节奏（刚在猛输出 / 一直空转）。改成数字旁
 * 一行 8 档块字符小图后，两个不变量必须锁住：①返回宽度恒等于 width（否则右边的
 * 数字与分隔符会随采样数抖动）；②峰值归一化（否则速率量级变化时曲线形状会乱）。
 *
 * 原理：node 直接 import 不了 .ts，先用 esbuild（src/node_modules）把 hud-spark.ts
 * bundle 成单文件 ESM 再 import；该模块无 pi 依赖，不需 mock。
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
const { sparkline, sparklineCells, brailleLine, SPARK_WIDTH, RATE_REF_DECAY } = await import(pathToFileURL(BUNDLE).href);
// 与 pi-tui 的 visibleWidth 同口径：块字符与空格都是 1 格
const w = (s) => [...s].length;

console.log("速率曲线");
check("默认宽度 == SPARK_WIDTH", w(sparkline([1, 2, 3])) === SPARK_WIDTH, String(w(sparkline([1, 2, 3]))));
for (const width of [1, 4, 8, 10, 12, 20]) {
	check(`w=${width}: 采样充足时宽度精确`, w(sparkline([1, 5, 9, 3, 7, 2, 8, 4, 6, 10, 1, 2, 3], width)) === width);
	check(`w=${width}: 采样不足时左侧补 ▁ 占位`, w(sparkline([3, 6], width)) === width && sparkline([3, 6], width).startsWith("▁".repeat(Math.max(0, width - 2))));
}
check("峰值映射到最高块 █", sparkline([1, 2, 9, 3], 4).includes("█"));
check("最低值映射到 ▁（非空格）", sparkline([1, 9], 2).startsWith("▁"));
check("全零（空闲）画 0 档 ▁", sparkline([0, 0, 0, 0], 4) === "▁▁▁▁", sparkline([0, 0, 0, 0], 4));
check("冷启动无采样画 ▁ 占位", sparkline([], 5) === "▁▁▁▁▁", sparkline([], 5));
check("负值按 0 档处理（▁）", sparkline([-5, 10], 2) === "▁█", sparkline([-5, 10], 2));
check("只取窗口内最近 width 个采样", sparkline([100, 1, 2, 3], 3) === sparkline([1, 2, 3], 3));
check("宽度 0 返回空串（不崩）", sparkline([1, 2], 0) === "");
check("宽度为负返回空串（不崩）", sparkline([1, 2], -3) === "");
check("归一化：整体放大不改变形状", sparkline([1, 2, 4], 3) === sparkline([100, 200, 400], 3));

console.log("曲线格子（均值分档 + 满格参考值）");
const cells = sparklineCells([10, 90, 50, 5], 4, { ref: 100, baseline: 50 });
check("格数恒为 width", cells.length === 4);
check("高于等于均值的格标记 aboveBaseline", cells[1].aboveBaseline === true && cells[2].aboveBaseline === true);
check("低于均值的格不标记", cells[0].aboveBaseline === false && cells[3].aboveBaseline === false);
check("高度按传入参考值归一（ref=100 → 90 为 ▇、10 为 ▁）", cells[1].char === "▇" && cells[0].char === "▁", cells.map((c) => c.char).join(""));
check("ref 小于窗口峰值时按窗口峰值归一（不小于峰值）", sparkline([100], 1, { ref: 10 }) === "█");
check("ref 大于窗口峰值时曲线整体偏低（会话峰值衰减的效果）", sparkline([10, 20], 2, { ref: 1000 }) === "▁▁");
check("无 ref 时退化为窗口峰值归一（10/20 → 第 4 档 ▄）", sparkline([10, 20], 2) === "▄█", sparkline([10, 20], 2));
check("参考值 ≤ 0（全程空闲）整格 ▁ 且不标均值", sparklineCells([0, 0], 2, { ref: 0, baseline: 5 }).every((c) => c.char === "▁" && !c.aboveBaseline));
check("默认衰减系数在 (0,1) 内（缓慢衰减）", RATE_REF_DECAY > 0 && RATE_REF_DECAY < 1, String(RATE_REF_DECAY));
check("宽度 0 返回空数组（cells）", sparklineCells([1, 2], 0).length === 0);
check("空闲轮落 0 档 ▁（占位与最矮的柱同档）", sparkline([50, 0, 50], 3, { ref: 50 }) === "█▁█", sparkline([50, 0, 50], 3, { ref: 50 }));

console.log("折线模式（盲文 2×4 点阵）");
check("折线长度恒为 width", w(brailleLine([10, 20, 30], 8)) === 8);
check("折线采样不足左侧补空格", brailleLine([30], 4).startsWith("   "));
check("折线全零整格空格", brailleLine([0, 0, 0, 0], 4) === "    ");
check("折线空采样整格空格", brailleLine([], 3) === "   ");
check("折线峰值落在顶行（含最上点）", [...brailleLine([100, 100], 2, { ref: 100 })].every((c) => c !== " "));
check("折线字符全在盲文区（U+2800–U+28FF 或空格）", [...brailleLine([10, 50, 100, 20], 4, { ref: 100 })].every((c) => c === " " || (c.codePointAt(0) >= 0x2800 && c.codePointAt(0) <= 0x28ff)));
check("折线宽度 0 返回空串", brailleLine([1, 2], 0) === "");

rmSync(BUNDLE, { force: true });

console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
