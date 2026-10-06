#!/usr/bin/env node
/**
 * Kimi For Coding 余额适配回归测试（hud-balance 的 kimi-coding adapter）
 *
 * 背景：上游 /coding/v1/usages 的字段形状改过两次，解析写死会让「5h 额度条恒为 0」「加油包永不显示」
 * 这类错误静默存在（HUD 只显示数字，不报错）。本测试用实测响应体（结构照抄）钉住三条路径：
 * - limits[].detail 只回传 limit/remaining（无 used）→ 需由 limit − remaining 推得已用量
 * - booster_wallet 为 snake_case，且 STATUS_DISABLED 时不得当作可用加油包
 * - 加油包启用（camelCase 历史字段 + amount/amountLeft）时，主金额显示加油包余额
 *
 * 用法：node src/extensions/hud/test/kimi-balance.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const HUD_DIR = join(TEST_DIR, "..");
const SRC_DIR = join(HUD_DIR, "../..");
const BUNDLE = join(TEST_DIR, ".tmp-kimi-balance-bundle.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

await build({
	entryPoints: [join(HUD_DIR, "hud-balance.ts")],
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
rmSync(BUNDLE, { force: true });

const ctx = {
	model: { provider: "kimi-coding", id: "kimi-for-coding" },
	sessionManager: { getBranch: () => [] },
	modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "dummy" } }) },
};

const run = async (payload) => {
	globalThis.fetch = async () =>
		new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
	const d = await mod.BALANCE_ADAPTERS["kimi-coding"].fetch(ctx);
	return {
		status: d.status,
		amount: d.amount,
		detail: d.detail,
		quotas: (d.quotas ?? []).map((q) => `${q.label} ${q.used}/${q.limit}`).join(" | "),
	};
};

// 实测结构：周额度 99/100、5h 窗口只给 limit/remaining、加油包 STATUS_DISABLED
const disabledBooster = await run({
	usage: { limit: "100", used: "99", remaining: "1", resetTime: "2026-10-08T09:11:21Z" },
	limits: [
		{
			window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
			detail: { limit: "100", remaining: "75", resetTime: "2026-10-06T14:11:21Z" },
		},
	],
	booster_wallet: {
		status: "STATUS_DISABLED",
		balance: { type: "BOOSTER" },
		monthlyChargeLimit: { currency: "CNY", priceInCents: "10000" },
		monthlyUsed: { currency: "CNY", priceInCents: "0" },
	},
});
check("未用尽额度不误判 warning", disabledBooster.status === "warning", disabledBooster.status);
check("主金额显示周额度（加油包已停用不顶替）", disabledBooster.amount === "周 99/100", disabledBooster.amount);
check("5h 窗口已用量由 limit − remaining 推得", disabledBooster.detail === "5h 25/100", disabledBooster.detail);
check("额度条同步显示 5h 25/100", disabledBooster.quotas === "周 99/100 | 5h 25/100", disabledBooster.quotas);

// 加油包启用：历史 camelCase 字段 + amount/amountLeft（固定点 1e6 单位 = 1 分）
const enabledBooster = await run({
	usage: { limit: "100", used: "10" },
	boosterWallet: { balance: { type: "BOOSTER", amount: 20_000_000_000, amountLeft: 12_500_000_000 } },
});
check("加油包启用时主金额显示余额", enabledBooster.amount === "CNY 125.00", enabledBooster.amount);
check("加油包启用时明细补订阅额度", enabledBooster.detail === "订阅 周 10/100", enabledBooster.detail);

// 额度耗尽 → error
const exhausted = await run({ usage: { limit: "100", used: "100", remaining: "0" } });
check("额度用满判 error", exhausted.status === "error", exhausted.status);

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
