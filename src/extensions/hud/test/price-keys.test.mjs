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
 * - k3 / k3-256k 命中 K3 档；未知 id 落 K2.7 Code（中间价位兜底）
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
const { goModelKey, kimiModelKey, zaiModelKey, GO_PRICES, KIMI_PRICES, ZAI_PRICES } = mod;
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
check("deepseek-v4.1-flash 与 deepseek-v4-flash 分开", goModelKey("deepseek-v4.1-flash") === "deepseek-v4.1-flash" && goModelKey("deepseek-v4-flash") === "deepseek-v4-flash");

// ---- Kimi ----
check("kimi-for-coding-highspeed → 高速版", kimiModelKey("kimi-for-coding-highspeed") === "kimi-k2.7-code-highspeed", kimiModelKey("kimi-for-coding-highspeed"));
check(
	"高速版价为普通版 2 倍",
	KIMI_PRICES["kimi-k2.7-code-highspeed"].cacheMiss === KIMI_PRICES["kimi-k2.7-code"].cacheMiss * 2 &&
		KIMI_PRICES["kimi-k2.7-code-highspeed"].output === KIMI_PRICES["kimi-k2.7-code"].output * 2,
);
check("kimi-for-coding → K2.7 Code 档（K2.8 无公开价，按此估算）", kimiModelKey("kimi-for-coding") === "kimi-k2.7-code", kimiModelKey("kimi-for-coding"));
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
