#!/usr/bin/env node
/**
 * hud-cost 速率口径回归测试：分母只算「模型生成段」
 *
 * 背景：pi 的一个 turn = 一次模型响应 + 该响应触发的所有工具调用，turn_end 时工具
 * 已经跑完。若用 turn 全长当分母，工具耗时会被算进模型速率（跑一次 30s 的 bash，
 * 速率就被拉低一大截）。正确口径：turn_start（请求发出）→ assistant message_end
 * （文本/思考输出完毕），含网络与首字延迟，不含工具执行。
 *
 * 原理：esbuild 把 hud-cost.ts bundle 成单文件 ESM（pi 包全部 external 且只用到类型，
 * 运行时不需要），直接调纯函数断言。
 *
 * 用法：node src/extensions/hud/test/token-rate.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const HUD_DIR = join(TEST_DIR, "..");
const SRC_DIR = join(HUD_DIR, "../..");
const BUNDLE = join(TEST_DIR, ".tmp-rate-bundle.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

await build({
	entryPoints: [join(HUD_DIR, "hud-cost.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
const mod = await import(pathToFileURL(BUNDLE).href);
const { computeModelPhaseRate } = mod;

if (typeof computeModelPhaseRate !== "function") {
	console.error("  ✗ 未导出 computeModelPhaseRate");
	process.exit(1);
}

console.log("模型生成段速率（tok/s）");
check("正常段：10s 出 500 token → 50/s", computeModelPhaseRate(500, 1_000, 11_000) === 50, String(computeModelPhaseRate(500, 1_000, 11_000)));
check("极短段按 100ms 兜底（避免除极小值）", computeModelPhaseRate(10, 1_000, 1_010) === 100, String(computeModelPhaseRate(10, 1_000, 1_010)));
check("零耗时同样按 100ms 兜底", computeModelPhaseRate(5, 1_000, 1_000) === 50, String(computeModelPhaseRate(5, 1_000, 1_000)));
check("含首字延迟：1s 才开始出字仍然按整段算（网络时间在内）", computeModelPhaseRate(300, 0, 6_000) === 50, String(computeModelPhaseRate(300, 0, 6_000)));
// 对照：同样 500 token —— 分母取模型生成段是 50/s；若误用 turn 全长（含 30s 工具）会掉到 12.5/s
check(
	"对照：含工具的全长口径会把速率拉到 1/4（这正是本次要修的口径）",
	computeModelPhaseRate(500, 0, 10_000) === 50 && computeModelPhaseRate(500, 0, 40_000) === 12.5,
	`模型段 ${computeModelPhaseRate(500, 0, 10_000)}/s vs 全长 ${computeModelPhaseRate(500, 0, 40_000)}/s`,
);
check("返回值为正数且有限", Number.isFinite(computeModelPhaseRate(1, 0, 1_000)));
check("零输出 → 0/s", computeModelPhaseRate(0, 0, 10_000) === 0);

rmSync(BUNDLE, { force: true });

console.log(`
${failures === 0 ? "全部通过 ✓" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
