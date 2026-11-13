#!/usr/bin/env node
/**
 * MiMo 余额 / 套餐余量适配回归测试（hud-balance 的 xiaomi* 适配器 + Token Plan 积分轨）
 *
 * 背景：MiMo 官方 2026-11-03 起开放资产接口——
 * - 按量付费 GET https://api.xiaomimimo.com/v1/platform/balance（sk- Key）
 * - Token Plan GET {region}/v1/platform/token_plan（tp- Key，cn/sgp/ams 三区）
 * 两条与 pi 的 provider（xiaomi / xiaomi-token-plan-*）一一对应，因此各做适配。
 *
 * 覆盖：
 * - xiaomi（按量）：主金额取 total_available，现金/赠金/授信/冻结拆解进 detail；
 *   缺 total_available 时按 现金+赠金+可用授信 兜底；余额过低 / is_available=false 变色
 * - xiaomi-token-plan-*：quota 百分比额度条、档位与剩余积分进 detail、
 *   时段重置倒计时（UTC 字符串 → 本地换算）、≥80% warning / ≥100% error
 * - 积分轨：Token Plan 消息按官方 Credits 单价本地估算（夜间 0.8x），
 *   meteredRateText 输出 🪙/min + 🪙累计，且不进 ¥/$ 轨
 * - BALANCE_ADAPTERS：xiaomi / cn / sgp / ams 四个 provider 均已注册
 *
 * 原理：node 无法直接 import .ts，先用 esbuild 把 hud-cost.ts / hud-balance.ts
 * 各 bundle 成单文件 ESM 再 import（与 zai-credits.test.mjs 同款）。
 *
 * 用法：node src/extensions/hud/test/mimo-balance.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const HUD_DIR = join(TEST_DIR, "..");
const SRC_DIR = join(HUD_DIR, "../..");
const BUNDLE_COST = join(TEST_DIR, ".tmp-hud-cost-mimo.mjs");
const BUNDLE_BALANCE = join(TEST_DIR, ".tmp-hud-balance-mimo.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

const buildOpts = (entry, outfile) => ({
	entryPoints: [entry],
	outfile,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
await build(buildOpts(join(HUD_DIR, "hud-cost.ts"), BUNDLE_COST));
await build(buildOpts(join(HUD_DIR, "hud-balance.ts"), BUNDLE_BALANCE));
const cost = await import(pathToFileURL(BUNDLE_COST).href);
const balance = await import(pathToFileURL(BUNDLE_BALANCE).href);
rmSync(BUNDLE_COST, { force: true });
rmSync(BUNDLE_BALANCE, { force: true });

const mkCtx = (provider, branch = []) => ({
	model: { provider },
	sessionManager: { getBranch: () => branch },
	modelRegistry: { getApiKeyForProvider: async () => "dummy-key" },
});

/** 用给定 JSON 和 URL 记录跑一次 adapter.fetch */
const runFetch = async (provider, payload) => {
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
	};
	const d = await balance.BALANCE_ADAPTERS[provider].fetch(mkCtx(provider));
	return { d, url: calls[0] };
};

// ---- 场景 1：按量付费余额 ----
console.log("场景 1：xiaomi 按量付费余额");
const metered = await runFetch("xiaomi", {
	object: "balance",
	is_available: true,
	balance_infos: [
		{
			currency: "CNY",
			cash_balance: "100.50",
			gift_balance: "20.00",
			frozen_balance: "0.00",
			credit_limit: "500.00",
			credit_available: "0.00",
			total_available: "120.50",
		},
	],
});
check("按量付费打到 /v1/platform/balance", metered.url === "https://api.xiaomimimo.com/v1/platform/balance", metered.url);
check("主金额 = 现金余额（DeepSeek 口径）", metered.d.amount === "CNY 100.50", metered.d.amount);
check("赠金以 + X.XX 追加", metered.d.detail === "+ 20.00", metered.d.detail);
check("余额充足 → ok", metered.d.status === "ok", metered.d.status);

const meteredCredit = await runFetch("xiaomi", {
	is_available: true,
	balance_infos: [{ currency: "CNY", cash_balance: "3.00", gift_balance: "0", frozen_balance: "1.00", credit_available: "497.00" }],
});
check("授信非现金：主金额仍是现金", meteredCredit.d.amount === "CNY 3.00", meteredCredit.d.amount);
check("授信与冻结进 detail", meteredCredit.d.detail === "授信 497.00 · 冻结 1.00", meteredCredit.d.detail);

const meteredBlocked = await runFetch("xiaomi", {
	is_available: false,
	balance_infos: [{ currency: "CNY", cash_balance: "88.00", gift_balance: "0", total_available: "88.00" }],
});
check("is_available=false 判 error", meteredBlocked.d.status === "error", meteredBlocked.d.status);

// ---- 场景 2：Token Plan 套餐余量 ----
console.log("场景 2：xiaomi-token-plan-* 套餐余量");
// 额度只有一份：period 只是订阅有效期（月卡/年卡差异仅在此），不参与额度口径，也不显示
const plan = await runFetch("xiaomi-token-plan-cn", {
	object: "token_plan",
	plan_code: "pro",
	period: { start_at: "2026-09-21 23:59:59", end_at: "2026-10-21 23:59:59" },
	quota: { total_credits: 38_000_000_000, used_credits: 3_800_000_000, remaining_credits: 34_200_000_000 },
	auto_renew: false,
	claw_enabled: false,
});
check(
	"Token Plan 打到区域专属 Base URL",
	plan.url === "https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan",
	plan.url,
);
check("额度条 1 根，用量取 used/total", plan.d.quotas?.length === 1 && plan.d.quotas[0].used === 3_800_000_000 && plan.d.quotas[0].limit === 38_000_000_000, JSON.stringify(plan.d.quotas));
check("额度条不带周期标签", plan.d.quotas?.[0]?.label === "", JSON.stringify(plan.d.quotas));
check("左侧标签用「额度」不是「余额」", plan.d.label === "额度", plan.d.label);
check("年额度用两位小数百分比", plan.d.quotas?.[0]?.pctDecimals === 2, JSON.stringify(plan.d.quotas));
check("余额行不带额外明细", plan.d.detail === undefined, plan.d.detail);
check("用量 10% → ok", plan.d.status === "ok", plan.d.status);

// 年卡：quota 结构完全相同，只是 period 更长——显示必须一模一样
const planYearly = await runFetch("xiaomi-token-plan-cn", {
	plan_code: "max",
	period: { start_at: "2026-01-01 00:00:00", end_at: "2027-01-01 00:00:00" },
	quota: { total_credits: 82_000_000_000, used_credits: 16_400_000_000, remaining_credits: 65_600_000_000 },
});
check(
	"年卡与月卡同口径（同样一根额度条、无标签、同精度）",
	planYearly.d.quotas?.[0]?.label === "" &&
		planYearly.d.quotas[0].limit === 82_000_000_000 &&
		planYearly.d.quotas[0].pctDecimals === 2,
	JSON.stringify(planYearly.d.quotas),
);

const planLow = await runFetch("xiaomi-token-plan-sgp", {
	plan_code: "lite",
	quota: { total_credits: 1_000, used_credits: 850, remaining_credits: 150 },
});
check("sgp 走 sgp Base URL", planLow.url === "https://token-plan-sgp.xiaomimimo.com/v1/platform/token_plan", planLow.url);
check("用量 85% → warning", planLow.d.status === "warning", planLow.d.status);

const planExhausted = await runFetch("xiaomi-token-plan-ams", {
	plan_code: "max",
	quota: { total_credits: 1_000, used_credits: 1_000, remaining_credits: 0 },
});
check("ams 走 ams Base URL", planExhausted.url === "https://token-plan-ams.xiaomimimo.com/v1/platform/token_plan", planExhausted.url);
check("额度用尽 → error", planExhausted.d.status === "error", planExhausted.d.status);

let threw = false;
try {
	await runFetch("xiaomi-token-plan-cn", { object: "token_plan" });
} catch (e) {
	threw = /缺少 quota/.test(String(e.message));
}
check("缺 quota → 报错提示确认 Key 归属", threw);

// ---- 场景 3：Token Plan 积分轨（本地估算） ----
console.log("场景 3：Token Plan 积分轨");
// 白天（UTC 04:00 = 北京 12:00，非夜间优惠）：Pro 档 1M 未命中输入 = 300 积分
const dayTs = Date.UTC(2026, 10, 9, 4, 0, 0);
const nightTs = Date.UTC(2026, 10, 9, 20, 0, 0); // 北京次日 04:00 → 0.8x
const mkMsg = (model, tokens, ts) => ({
	role: "assistant",
	provider: "xiaomi-token-plan-cn",
	model,
	timestamp: ts,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, ...tokens },
});
const msgDay = mkMsg("mimo-v2.6-pro", { input: 1_000_000 }, dayTs);
const msgNight = mkMsg("mimo-v2.6-pro", { input: 1_000_000 }, nightTs);
check("白天 Pro 未命中 1M = 300 积分", cost.sumSessionUsage(mkCtx("xiaomi-token-plan-cn", [{ type: "message", message: msgDay }])).costTotalCr === 300);
check("夜间同量 = 240 积分（0.8x）", cost.sumSessionUsage(mkCtx("xiaomi-token-plan-cn", [{ type: "message", message: msgNight }])).costTotalCr === 240);
check(
	"Token Plan 不计入 ¥ / $ 轨",
	cost.sumSessionUsage(mkCtx("xiaomi-token-plan-cn", [{ type: "message", message: msgDay }])).costTotalCny === 0,
);

const t0 = Date.now() - 120_000;
cost.resetCostTracking(mkCtx("xiaomi-token-plan-cn", []));
cost.recordTurnCosts(mkCtx("xiaomi-token-plan-cn", [{ type: "message", message: msgDay }]));
const parts = cost.meteredRateText(mkCtx("xiaomi-token-plan-cn", [{ type: "message", message: msgDay }]), t0 + 120_000);
check("速率走积分轨（🪙/min）", parts?.[0]?.text.startsWith("🪙") && parts[0].text.endsWith("/min"), JSON.stringify(parts));
check("累计显示积分", parts?.[1]?.text === "🪙300", JSON.stringify(parts));

const meteredParts = cost.meteredRateText(
	mkCtx("xiaomi", [{ type: "message", message: { ...msgDay, provider: "xiaomi" } }]),
	t0 + 120_000,
);
check("按量付费仍走人民币轨（¥/min）", meteredParts?.[0]?.text.startsWith("¥"), JSON.stringify(meteredParts));

// ---- 场景 4：注册表 ----
console.log("场景 4：BALANCE_ADAPTERS 注册");
for (const p of ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams"]) {
	const a = balance.BALANCE_ADAPTERS[p];
	check(`${p} 已注册且带 rateText`, !!a && typeof a.rateText === "function");
}

// ---- 场景 5：行首标签是适配器给的普通文字段（不存在默认值） ----
console.log("场景 5：行首标签语义");
check("按量付费行首是「余额」", metered.d.label === "余额", metered.d.label);
check("Token Plan 行首是「额度」", plan.d.label === "额度", plan.d.label);
const linkOnly = await balance.BALANCE_ADAPTERS["volcengine-coding"].fetch(mkCtx("volcengine-coding"));
check("无数字的供应商不给 amount", linkOnly.amount === undefined && !!linkOnly.link, JSON.stringify(linkOnly));
check("无数字的供应商把说明放行首标签", linkOnly.label === "余量查询", linkOnly.label);

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
