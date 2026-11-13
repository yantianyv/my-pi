#!/usr/bin/env node
/**
 * hud-cost 定价路由回归测试：模型 id → 定价键
 *
 * 背景：hud-cost 的三张价目表（GO_PRICES / KIMI_PRICES / MIMO_PRICES）靠字符串匹配选键，
 * 匹配顺序或关键词粒度写错就会静默用错价（例如 "gpt-5.6-luna" 被 "6-luna" 抢先命中 gpt-6 档、
 * 高速版被兜底成普通版、免费模型被按付费价计）。本测试把已发现的几类陷阱钉住。
 *
 * 覆盖：
 * - gpt-5.6-luna 命中 gpt-5.6-luna（不被 6-luna 抢走），gpt-6-luna 命中 gpt-6-luna
 * - Space Bunny 走付费价（上游已不免费）、LongCat 2.5 Preview Free 命中免费档
 * - kimi-for-coding-highspeed 命中高速版（普通版 2 倍），kimi-for-coding 命中普通版
 * - K3.1 Pro 标准/高速版独立定价，k3 / k3-256k 仍命中 K3 档；未知 id 落 K2.7 Code
 * - OpenCode Go 额度权重：单池加权（占比 = Σ 标价花费 / 月额度），Go / Go Plus 两档
 *   $15/$30/$60/$80 档分别 ×4/×2/×1/×0.75，混用不超过整月额度
 * - OpenCode Go 相对价：模型每 token 价 ÷ DS V4.1 Flash 高峰价（硬编码基准），
 *   Go 通道含额度权重；缓存命中:未命中:输出 = 340:6:1
 *
 * 用法：node src/extensions/hud/test/price-keys.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const HUD_DIR = join(TEST_DIR, "..");
const SRC_DIR = join(HUD_DIR, "../..");
const BUNDLE = join(TEST_DIR, ".tmp-price-keys-bundle.mjs");

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
const { goModelKey, kimiModelKey, zaiModelKey, GO_PRICES, KIMI_PRICES, ZAI_PRICES, goWeight, goPool, goQuotaUsd, modelPriceIndex, setGlmTier, detectGlmTier } = mod;
rmSync(BUNDLE, { force: true });

check(
	"导出 goModelKey / kimiModelKey / zaiModelKey / 三张价目表",
	typeof goModelKey === "function" && typeof kimiModelKey === "function" && typeof zaiModelKey === "function" && !!GO_PRICES && !!KIMI_PRICES && !!ZAI_PRICES,
);
if (typeof goModelKey !== "function" || typeof kimiModelKey !== "function") process.exit(1);

// ---- OpenCode Go ----
check("gpt-5.6-luna → gpt-5.6-luna（不被 6-luna 抢走）", goModelKey("gpt-5.6-luna") === "gpt-5.6-luna", goModelKey("gpt-5.6-luna"));
check(
	"gpt-5.6-luna 取 5.6 档价（$0.20/$1.20）",
	GO_PRICES["gpt-5.6-luna"]?.cacheMiss === 0.2 && GO_PRICES["gpt-5.6-luna"]?.output === 1.2,
);
check("gpt-6-luna → gpt-6-luna", goModelKey("gpt-6-luna") === "gpt-6-luna", goModelKey("gpt-6-luna"));
check("space-bunny → space-bunny（付费档，非 0 价）", goModelKey("space-bunny") === "space-bunny" && GO_PRICES["space-bunny"]?.output === 0.6);
check("longcat-2.5-preview-free → 免费档", goModelKey("longcat-2.5-preview-free") === "longcat-2.5-preview-free" && GO_PRICES["longcat-2.5-preview-free"]?.output === 0);
check("longcat-2.0 → 付费档", goModelKey("longcat-2.0") === "longcat-2.0" && GO_PRICES["longcat-2.0"]?.output === 1.2);
check("glm-5.3-flash 优先于 glm-5.3", goModelKey("glm-5.3-flash") === "glm-5.3-flash");
check(
	"deepseek-v4.1-flash 与 deepseek-v4-flash 分开",
	goModelKey("deepseek-v4.1-flash") === "deepseek-v4.1-flash" && goModelKey("deepseek-v4-flash") === "deepseek-v4-flash",
);
check(
	"新增模型路由：Claude Haiku / Gemini / Step 5",
	goModelKey("claude-haiku-5-5") === "claude-haiku-5-5" &&
		goModelKey("gemini-4-argon-contributor") === "gemini-4-argon-contributor" &&
		goModelKey("step-5-preview") === "step-5-preview",
);
check(
	"新增模型有价（Haiku 有 100K 分档）",
	GO_PRICES["claude-haiku-5-5"]?.cacheMiss === 0.1 &&
		GO_PRICES["claude-haiku-5-5"]?.highTier?.threshold === 100_000 &&
		GO_PRICES["claude-haiku-5-5"]?.highTier?.cacheMiss === 0.5,
);
check(
	"Gemini 4 / Step 5 有价",
	GO_PRICES["gemini-4-argon-contributor"]?.output === 20 && GO_PRICES["step-5-preview"]?.output === 2.7,
);
check("Kimi K3.1 Pro 优先于 K3 通配", goModelKey("kimi-k3.1-pro") === "kimi-k3.1-pro" && goModelKey("k3-1-pro") === "kimi-k3.1-pro");
check(
	"Go Kimi K3.1 Pro 标价含缓存写入",
	GO_PRICES["kimi-k3.1-pro"]?.cacheMiss === 2 &&
		GO_PRICES["kimi-k3.1-pro"]?.cacheHit === 0.2 &&
		GO_PRICES["kimi-k3.1-pro"]?.output === 10 &&
		GO_PRICES["kimi-k3.1-pro"]?.cacheWrite === 2,
);

// ---- OpenCode Go 额度权重（单一额度池）----
check("Go 权重：$60 档 ×1", goWeight("glm-5.2", "go") === 1 && goWeight("kimi-k2.7-code", "go") === 1);
check(
	"Go 权重：$15 档 ×4",
	goWeight("glm-5.3", "go") === 4 &&
		goWeight("kimi-k3.1-pro", "go") === 4 &&
		goWeight("kimi-k3", "go") === 4 &&
		goWeight("claude-haiku-5-5", "go") === 4,
);
check("Go 权重：$30 档 ×2", goWeight("qwen3.8-flash", "go") === 2 && goWeight("hy4-preview", "go") === 2);
check("Go 权重：DS V4.1 Flash $80 档 ×0.75", goWeight("deepseek-v4.1-flash", "go") === 0.75);
check("Go 权重：免费模型 ×0", goWeight("longcat-2.5-preview-free", "go") === 0);
check("未知模型按 $60 档 ×1", goWeight("some-unknown-model", "go") === 1);
check(
	"Go Plus 权重：$240 档 ×1、$180 档 ×1.33、$160 档 ×1.5、$60 档 ×4",
	goWeight("longcat-2.0", "plus") === 1 &&
		Math.abs(goWeight("glm-5.2", "plus") - 4 / 3) < 1e-12 &&
		goWeight("deepseek-v4.1-flash", "plus") === 1.5 &&
		goWeight("kimi-k3.1-pro", "plus") === 4 &&
		goWeight("kimi-k3", "plus") === 4,
);
check("两档池大小", goPool("go") === 60 && goPool("plus") === 240);
check(
	"两档同权重的模型：Kimi K3 在两档都是 ×4",
	goWeight("kimi-k3", "go") === goWeight("kimi-k3", "plus"),
);
check(
	"混用不得超池：$30 GLM-5.3-Flash + $7.5 GLM-5.3 = 整月额度",
	30 * goWeight("glm-5.3-flash", "go") + 7.5 * goWeight("glm-5.3", "go") === 60,
);

// ---- 相对价 = 模型生效价 ÷ DS V4.1 Flash 高峰价（基准混合价 33.6 元/单位）----
// Plan 渠道已含订阅折扣：Go 月费/额度、GLM 档位积分价；峰谷/非高峰实时参与
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const DS_PEAK = Date.UTC(2026, 9, 14, 8); // 周三 16:00 北京：DS/Go 高峰、GLM 高峰
const OFF_PEAK = Date.UTC(2026, 9, 17, 12); // 周六 20:00 北京：全部非高峰
check(
	"相对价：DS V4.1 Flash 直连高峰 = 1.0×、非高峰 = 0.5×（基准自身）",
	modelPriceIndex({ provider: "deepseek", id: "deepseek-v4.1-flash" }, 7, DS_PEAK) === 1 &&
		modelPriceIndex({ provider: "deepseek", id: "deepseek-v4.1-flash" }, 7, OFF_PEAK) === 0.5,
);
check(
	"相对价：DS V4 Pro 高峰 = 5.45×",
	near(modelPriceIndex({ provider: "deepseek", id: "deepseek-v4-pro" }, 7, DS_PEAK), 183 / 33.6),
);
check(
	"相对价：Kimi K3 直连 = 26.79×、K2.7 Code = 15.12×（无折扣）",
	near(modelPriceIndex({ provider: "kimi-coding", id: "kimi-k3" }, 7, DS_PEAK), 900 / 33.6) &&
		near(modelPriceIndex({ provider: "kimi-coding", id: "kimi-k2.7-code" }, 7, DS_PEAK), 508 / 33.6),
);
check(
	"相对价：Kimi K3.1 Pro 直连 = 17.5×、高速版 = 21.85×",
	near(modelPriceIndex({ provider: "moonshotai-cn", id: "kimi-k3.1-pro" }, 7, DS_PEAK), 588 / 33.6) &&
		near(modelPriceIndex({ provider: "moonshotai-cn", id: "kimi-k3.1-pro-highspeed" }, 7, DS_PEAK), 734 / 33.6),
);
check(
	"相对价：MiMo 不折算套餐（V2.6 Flash = 0.44×）",
	near(modelPriceIndex({ provider: "xiaomi", id: "mimo-v2.6-flash" }, 7, DS_PEAK), 14.8 / 33.6),
);
check(
	"相对价：Go DS 含 1/6 折扣（汇率 7 高峰 = 0.13125×、非高峰 = 0.065625×）",
	near(modelPriceIndex({ provider: "opencode-go", id: "deepseek-v4.1-flash" }, 7, DS_PEAK), 0.13125) &&
		near(modelPriceIndex({ provider: "opencode-go", id: "deepseek-v4.1-flash" }, 7, OFF_PEAK), 0.065625),
);
check(
	"相对价：Go GLM-5.2 = 3.51×、Kimi K3.1 Pro = 12.5×、K3 = 18.75×（无峰谷）",
	near(modelPriceIndex({ provider: "opencode-go", id: "glm-5.2" }, 7, DS_PEAK), 118.06666666666666 / 33.6) &&
		near(modelPriceIndex({ provider: "opencode-go", id: "kimi-k3.1-pro" }, 7, DS_PEAK), 12.5) &&
		near(modelPriceIndex({ provider: "opencode-go", id: "kimi-k3" }, 7, DS_PEAK), 18.75),
);

// GLM Coding Plan：档位识别 + 生效价（Lite 高峰 5.21×、非高峰 2.61×；Flash 1.72×）
setGlmTier(null);
check(
	"GLM 档位：周积分上限识别 Lite/Pro/Max",
	detectGlmTier({ data: { limits: [{ type: "CREDIT_LIMIT", usage: 2000 }, { type: "CREDIT_LIMIT", usage: 10000 }] } }) === "lite" &&
		detectGlmTier({ data: { limits: [{ type: "CREDIT_LIMIT", usage: 60000 }] } }) === "pro" &&
		detectGlmTier({ data: { limits: [{ type: "CREDIT_LIMIT", usage: 140000 }] } }) === "max",
);
check("GLM 档位：level 字段优先", detectGlmTier({ data: { level: "pro" } }) === "pro");
setGlmTier("lite");
const glmFactor = (118 / ((10_000 * 52) / 12)) * 100; // Lite：¥/积分 × 100（每百万 token 的积分倍率）
const glm53Peak = ((1.7 * 340 + 6.9 * 6 + 24) * glmFactor) / 33.6;
const glmFlashPeak = ((0.56 * 340 + 2.3 * 6 + 8) * glmFactor) / 33.6;
check(
	"相对价：GLM Lite GLM-5.3 高峰 = 5.21×、非高峰 = 2.61×",
	near(modelPriceIndex({ provider: "zai-coding-cn", id: "glm-5.3" }, 7, DS_PEAK), glm53Peak) &&
		near(modelPriceIndex({ provider: "zai-coding-cn", id: "glm-5.3" }, 7, OFF_PEAK), glm53Peak / 2),
);
check(
	"相对价：GLM Lite GLM-5.3-Flash = 1.72×",
	near(modelPriceIndex({ provider: "zai-coding-cn", id: "glm-5.3-flash" }, 7, DS_PEAK), glmFlashPeak),
);
setGlmTier(null);
check(
	"相对价：GLM 未识别档位时回落官方标价",
	near(modelPriceIndex({ provider: "zai-coding-cn", id: "glm-5.3" }, 7, DS_PEAK), 756 / 33.6),
);
check(
	"相对价：pi 目录价通道（汇率 7：$0.10/$0.50/$0.01 → 0.9375×）",
	near(
		modelPriceIndex({ provider: "openrouter", id: "x", cost: { input: 0.1, output: 0.5, cacheRead: 0.01 } }, 7, DS_PEAK),
		31.5 / 33.6,
	),
);
check(
	"相对价：无汇率时美元通道隐藏、人民币通道不影响",
	modelPriceIndex({ provider: "opencode-go", id: "deepseek-v4.1-flash" }, null, DS_PEAK) === null &&
		modelPriceIndex({ provider: "deepseek", id: "deepseek-v4.1-flash" }, null, DS_PEAK) === 1,
);
check(
	"相对价：免费/动态定价模型返回 null",
	modelPriceIndex({ provider: "openrouter", id: "free", cost: { input: 0, output: 0, cacheRead: 0 } }, 7, DS_PEAK) === null &&
		modelPriceIndex({ provider: "openrouter", id: "auto", cost: { input: -1, output: -1 } }, 7, DS_PEAK) === null,
);

// 单条消息额度消耗 = 标价 × 权重（off-peak 用周六，避免峰值翻倍）
const usageOf = (input, cacheRead = 0, output = 0) => ({ input, cacheRead, output, cacheWrite: 0 });
const PEAK = Date.UTC(2026, 9, 14, 2); // 2026-10-14 周三 02:00 UTC（高峰）
check(
	"DS V4.1 Flash 1M 输入 off-peak：标价 $0.15 → 额度 $0.1125",
	Math.abs(goQuotaUsd(usageOf(1_000_000), "deepseek-v4.1-flash", OFF_PEAK) - 0.1125) < 1e-12,
);
check(
	"DS V4.1 Flash 高峰翻倍：额度 $0.225",
	Math.abs(goQuotaUsd(usageOf(1_000_000), "deepseek-v4.1-flash", PEAK) - 0.225) < 1e-12,
);
check(
	"Kimi K3 1M 输入 = 整月额度的 20%（$3 标价 ×4 = $12 / $60）",
	Math.abs(goQuotaUsd(usageOf(1_000_000), "kimi-k3", OFF_PEAK) - 12) < 1e-12,
);
check(
	"Kimi K3.1 Pro 输入与缓存写入各 1M：($2 + $2) ×4 = $16 额度",
	Math.abs(goQuotaUsd({ input: 1_000_000, cacheRead: 0, output: 0, cacheWrite: 1_000_000 }, "kimi-k3.1-pro", OFF_PEAK) - 16) < 1e-12,
);
check(
	"Kimi K3 缓存写入按 $3 计费：($3 + $3) ×4 = $24 额度",
	Math.abs(goQuotaUsd({ input: 1_000_000, cacheRead: 0, output: 0, cacheWrite: 1_000_000 }, "kimi-k3", OFF_PEAK) - 24) < 1e-12,
);
check(
	"GLM-5.2 1M 输入按面值计入（$1.40）",
	Math.abs(goQuotaUsd(usageOf(1_000_000), "glm-5.2", OFF_PEAK) - 1.4) < 1e-12,
);

// ---- Kimi ----
check("kimi-for-coding-highspeed → 高速版", kimiModelKey("kimi-for-coding-highspeed") === "kimi-k2.7-code-highspeed", kimiModelKey("kimi-for-coding-highspeed"));
check(
	"高速版价为普通版 2 倍",
	KIMI_PRICES["kimi-k2.7-code-highspeed"].cacheMiss === KIMI_PRICES["kimi-k2.7-code"].cacheMiss * 2 &&
		KIMI_PRICES["kimi-k2.7-code-highspeed"].output === KIMI_PRICES["kimi-k2.7-code"].output * 2,
);
check("kimi-for-coding → K2.7 Code 档（K2.8 无公开价，按此估算）", kimiModelKey("kimi-for-coding") === "kimi-k2.7-code", kimiModelKey("kimi-for-coding"));
check(
	"K3.1 Pro 标准/高速版与别名独立路由",
	kimiModelKey("kimi-k3.1-pro") === "kimi-k3.1-pro" &&
		kimiModelKey("k3-1-pro") === "kimi-k3.1-pro" &&
		kimiModelKey("KIMI-K3.1-PRO-HIGHSPEED") === "kimi-k3.1-pro-highspeed",
);
check(
	"K3.1 Pro 高速版仅缓存命中价不翻倍",
	KIMI_PRICES["kimi-k3.1-pro-highspeed"].cacheHit === KIMI_PRICES["kimi-k3.1-pro"].cacheHit &&
		KIMI_PRICES["kimi-k3.1-pro-highspeed"].cacheMiss === KIMI_PRICES["kimi-k3.1-pro"].cacheMiss * 2 &&
		KIMI_PRICES["kimi-k3.1-pro-highspeed"].output === KIMI_PRICES["kimi-k3.1-pro"].output * 2 &&
		KIMI_PRICES["kimi-k3.1-pro-highspeed"].cacheWrite === KIMI_PRICES["kimi-k3.1-pro"].cacheWrite * 2,
);
check("k3 / k3-256k → K3 档", kimiModelKey("k3") === "kimi-k3" && kimiModelKey("k3-256k") === "kimi-k3");
check("kimi-k2.7-code-highspeed 仍为高速版", kimiModelKey("kimi-k2.7-code-highspeed") === "kimi-k2.7-code-highspeed");
check("未知 id 落 K2.7 Code 兜底", kimiModelKey("some-unknown-model") === "kimi-k2.7-code");

// ---- Z.AI 国内（zai-coding-cn 通道）----
check("glm-5.3-highspeed 优先于 glm-5.3", zaiModelKey("glm-5.3-highspeed") === "glm-5.3-highspeed", String(zaiModelKey("glm-5.3-highspeed")));
check("glm-5.3-flash 优先于 glm-5.3", zaiModelKey("glm-5.3-flash") === "glm-5.3-flash", String(zaiModelKey("glm-5.3-flash")));
check("glm-5.3 → glm-5.3", zaiModelKey("glm-5.3") === "glm-5.3");
check("glm-5.2-highspeed 优先于 glm-5.2", zaiModelKey("glm-5.2-highspeed") === "glm-5.2-highspeed");
check("glm-4.6v → glm-4.6v", zaiModelKey("glm-4.6v") === "glm-4.6v");
check("未登记型号返回 null（回落 pi 目录价）", zaiModelKey("gpt-6-luna") === null);
check(
	"高速档不得为 0 价（0 会让 HUD 恒显示 0 成本）",
	(ZAI_PRICES["glm-5.3-highspeed"]?.input ?? 0) > 0 && (ZAI_PRICES["glm-5.3-highspeed"]?.output ?? 0) > 0,
);
check(
	"国内官方价口径：Flash 0.8/2.8、5.3 旗舰 8/28（元/百万 tokens）",
	ZAI_PRICES["glm-5.3-flash"].input === 0.8 && ZAI_PRICES["glm-5.3-flash"].output === 2.8 && ZAI_PRICES["glm-5.3"].input === 8 && ZAI_PRICES["glm-5.3"].output === 28,
);
check(
	"FlashX（highspeed）价为 Flash 的 2.5 倍",
	ZAI_PRICES["glm-5.3-highspeed"].input === ZAI_PRICES["glm-5.3-flash"].input * 2.5 && ZAI_PRICES["glm-5.3-highspeed"].output === ZAI_PRICES["glm-5.3-flash"].output * 2.5,
);
check(
	"glm-4.6v 有 32K 提示长度分档",
	ZAI_PRICES["glm-4.6v"].highTier?.threshold === 32_768 && ZAI_PRICES["glm-4.6v"].highTier?.input === 2,
);

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
