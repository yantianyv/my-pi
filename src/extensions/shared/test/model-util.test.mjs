#!/usr/bin/env node
/**
 * shared/model-util 回归测试：价格口径与模型筛选
 *
 * 锁住的不变量：
 * - 目录价缺失（写 0）但实为付费的型号（*-highspeed）不被判为免费——否则 FREE 策略会选中它们
 * - 价格排序按覆盖后的有效价（0 价的高速档不会排在最前被「挑便宜」
 * - 动态定价（负值）仍视为价格未知排到最后；无 cost 字段同样最后
 *
 * 用法：node src/extensions/shared/test/model-util.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SHARED_DIR = join(TEST_DIR, "..");
const SRC_DIR = join(SHARED_DIR, "../..");
const BUNDLE = join(TEST_DIR, ".tmp-model-util-bundle.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

await build({
	entryPoints: [join(SHARED_DIR, "model-util.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
const { isFreeModel, modelTotalCost, listAvailableModels } = await import(pathToFileURL(BUNDLE).href);
rmSync(BUNDLE, { force: true });

check("导出 isFreeModel / modelTotalCost / listAvailableModels", typeof isFreeModel === "function" && typeof modelTotalCost === "function" && typeof listAvailableModels === "function");

const model = (id, cost) => ({ id, provider: "zai-coding-cn", cost });

// ---- 目录零价的高速档：不算免费，且不排在最前 ----
const highspeed = model("glm-5.3-highspeed", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const highspeed52 = model("glm-5.2-highspeed", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
check("glm-5.3-highspeed 不判为免费（目录写 0 实为高速档）", !isFreeModel(highspeed), String(isFreeModel(highspeed)));
check("glm-5.2-highspeed 不判为免费", !isFreeModel(highspeed52));
check("高速档有效价 > 0（排序不吃 0 价便宜）", modelTotalCost(highspeed) > 0, String(modelTotalCost(highspeed)));
check(
	"高速档价与 Flash 档同量级（0.375 + 1.25）",
	modelTotalCost(highspeed) === 1.625,
	String(modelTotalCost(highspeed)),
);
check(
	"高速档比同系列低价位模型贵（排序不会把它当最便宜）",
	modelTotalCost(highspeed) > modelTotalCost(model("glm-5.3-flash", { input: 0.15, output: 0.5 })),
);

// ---- 真免费 / 未知价 / 普通付费 ----
check("真 0 价仍判免费", isFreeModel(model("some-free-model", { input: 0, output: 0 })));
check("常规付费模型不判免费", !isFreeModel(model("glm-5.3", { input: 1.4, output: 4.4 })));
check("无 cost 字段不判免费且排最后", !isFreeModel(model("no-cost", undefined)) && modelTotalCost(model("no-cost", undefined)) === Infinity);
check(
	"动态定价（负值）排最后",
	modelTotalCost(model("openrouter/auto", { input: -1_000_000, output: -1_000_000 })) === Infinity,
);

// ---- listAvailableModels：excludeFree 不吃高速档 ----
const fakeCtx = {
	modelRegistry: {
		getAvailable: () => [highspeed, model("glm-5.3-flash", { input: 0.15, output: 0.5 })],
		hasConfiguredAuth: () => true,
	},
};
const kept = listAvailableModels(fakeCtx, { excludeFree: true }).map((m) => m.id);
check("excludeFree 时高速档保留在候选里", kept.includes("glm-5.3-highspeed"), kept.join(", "));
check("候选按价格升序（flash 在 highspeed 前）", kept[0] === "glm-5.3-flash", kept.join(", "));

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
