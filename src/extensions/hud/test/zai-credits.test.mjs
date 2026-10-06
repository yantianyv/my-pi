#!/usr/bin/env node
/**
 * Z.AI Coding CN 积分轨回归测试（hud-cost 积分差分 + hud-balance 注册表 smoke）
 *
 * 背景：Z.AI Coding CN（智谱 GLM Coding Plan）按订阅积分计费，积分是独立货币、
 * 不换算 ¥/$；消息 usage 不含积分，无法本地定价直算，只能远端采样 quota 接口做差分。
 * 本测试锁定差分核心逻辑（负增量/窗口滚动不产生假增量）与适配器注册。
 *
 * 覆盖：
 * - zai5hWindow：多条 TOKENS_LIMIT 取 nextResetTime 最小（5h 窗口）、TIME_LIMIT/缺时间戳忽略
 * - zaiWindowUsedCredits：currentValue 优先 → percentage×usage 推算 → 均无返回 null
 * - sampleZaiCredits：首采建基线、正增量入事件+累计、负增量仅换基线、窗口滚动仅换基线
 * - meteredRateText 积分分支：未采样回落 tokens、采样后显示 积分/min + 累计积分、颜色阈值
 * - BALANCE_ADAPTERS：zai-coding-cn 已注册且 rateText 指向 meteredRateText
 *
 * 原理：node 无法直接 import .ts，先用 esbuild（src/node_modules 构建依赖）把
 * hud-cost.ts / hud-balance.ts 各 bundle 成单文件 ESM 再 import；external 白名单与
 * build.js 一致（@earendil-works/*、typebox），类型 import 擦除后无需 pi mock。
 *
 * 用法：node src/extensions/hud/test/zai-credits.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const HUD_DIR = join(TEST_DIR, ".."); // src/extensions/hud/
const SRC_DIR = join(HUD_DIR, "../.."); // src/
const BUNDLE_COST = join(tmpdir(), `hud-cost-zai-${process.pid}.mjs`);
const BUNDLE_BALANCE = join(tmpdir(), `hud-balance-zai-${process.pid}.mjs`);

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

// ---- bundle：hud-cost.ts / hud-balance.ts（类型 import 擦除，无顶层副作用） ----
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

// ---- 测试夹具：mock ctx（provider=zai-coding-cn + 一条 assistant 消息） ----
// costTotal 是 pi 目录 USD 成本（只在未登记型号的回落路径上生效）；tokens 可覆盖 token 数
const mkMsg = (costTotal = 0, tokens = {}, modelId = "glm-5.2") => ({
	role: "assistant",
	provider: "zai-coding-cn",
	model: modelId,
	timestamp: Date.now(),
	usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, ...tokens, cost: { total: costTotal } },
});
const mkCtx = (costTotal = 0, tokens = {}, modelId) => ({
	model: { provider: "zai-coding-cn" },
	sessionManager: { getBranch: () => [{ type: "message", message: mkMsg(costTotal, tokens, modelId) }] },
});

// ---- 场景 1：zai5hWindow 窗口选择 ----
console.log("场景 1：zai5hWindow 取 5h 窗口");
const quotaResp = {
	code: 200,
	data: {
		level: "glm-coding-pro",
		limits: [
			{ type: "TOKENS_LIMIT", percentage: 20, nextResetTime: 3000 }, // 周窗口（重置最晚，旧版 type）
			{ type: "TOKENS_LIMIT", percentage: 65, nextResetTime: 1000 }, // 5h 窗口（重置最早，旧版 type）
			{ type: "TIME_LIMIT", percentage: 3, nextResetTime: 2000 }, // MCP 月度（忽略）
			{ type: "TOKENS_LIMIT", percentage: 0 }, // 缺 nextResetTime（忽略）
		],
	},
};
const w = cost.zai5hWindow(quotaResp);
check("取 nextResetTime 最小的积分窗口（5h 窗口）", w?.nextResetTime === 1000, JSON.stringify(w));
// 新版透明积分制（实测 Lite 档）：type=CREDIT_LIMIT，无 TIME_LIMIT
const quotaRespNew = {
	code: 200,
	data: {
		level: "lite",
		limits: [
			{ type: "CREDIT_LIMIT", percentage: 8, nextResetTime: 1788169291225, currentValue: 174, usage: 2000 },
			{ type: "CREDIT_LIMIT", percentage: 1, nextResetTime: 1788755895998, currentValue: 174, usage: 10000 },
		],
	},
};
const wNew = cost.zai5hWindow(quotaRespNew);
check("新版 CREDIT_LIMIT 同样取 nextResetTime 最小者", wNew?.usage === 2000, JSON.stringify(wNew));
check("新版响应提取已用积分 174", cost.zaiWindowUsedCredits(wNew) === 174);
check("空 limits → null", cost.zai5hWindow({ data: { limits: [] } }) === null);
check("缺 data → null", cost.zai5hWindow({}) === null);

// ---- 场景 2：zaiWindowUsedCredits 积分值提取 ----
console.log("场景 2：zaiWindowUsedCredits 积分值提取");
check("currentValue 优先", cost.zaiWindowUsedCredits({ currentValue: 390, percentage: 65, usage: 600 }) === 390);
check("currentValue 缺失时 percentage×usage 推算", cost.zaiWindowUsedCredits({ percentage: 65, usage: 600 }) === 390);
check("均无 → null", cost.zaiWindowUsedCredits({ percentage: 65 }) === null);

// ---- 场景 3：sampleZaiCredits 差分 ----
console.log("场景 3：sampleZaiCredits 差分采样");
cost.resetCostTracking(mkCtx()); // startupTime 对齐当前时间 + 积分状态清零
const t0 = Date.now();
cost.sampleZaiCredits(100, 5000, t0); // 首次采样：仅建基线
check("首次采样即视为已采样过", cost.zaiCreditsSampled() === true);
cost.sampleZaiCredits(150, 5000, t0 + 30_000); // +50
cost.sampleZaiCredits(170, 5000, t0 + 60_000); // +20
check("正增量累计（100→170 差 70）", cost.meteredRateText(mkCtx(), t0 + 61_000)?.[1]?.text === "🪙70",
	`实际 ${JSON.stringify(cost.meteredRateText(mkCtx(), t0 + 61_000))}`);

// 负增量（接口数据回退）：仅换基线，不记增量
cost.sampleZaiCredits(160, 5000, t0 + 62_000); // 170→160 回退
check("负增量不记累计（仍 70）", cost.meteredRateText(mkCtx(), t0 + 63_000)?.[1]?.text === "🪙70");
cost.sampleZaiCredits(180, 5000, t0 + 64_000); // 160→180 +20（新基线 160）
check("回退后从新基线正常累计（70+20=90）", cost.meteredRateText(mkCtx(), t0 + 65_000)?.[1]?.text === "🪙90");

// 窗口滚动（nextResetTime 变化，5h 窗口清零）：仅换基线，不把清零当负增量、不把新窗口增长当跨窗口续算
cost.sampleZaiCredits(0, 6000, t0 + 70_000); // 窗口滚动清零
check("窗口滚动不记增量（仍 90）", cost.meteredRateText(mkCtx(), t0 + 71_000)?.[1]?.text === "🪙90");
cost.sampleZaiCredits(30, 6000, t0 + 72_000); // 新窗口 +30
check("新窗口增量正常累计（90+30=120）", cost.meteredRateText(mkCtx(), t0 + 73_000)?.[1]?.text === "🪙120");

// ---- 场景 4：meteredRateText 积分分支 ----
console.log("场景 4：meteredRateText 积分分支");
cost.resetZaiCreditTracking();
cost.resetCostTracking(mkCtx());
const tb = Date.now();
const fallback = cost.meteredRateText(mkCtx(), tb + 120_000);
check("从未采样成功 → 回落 token 数（100+50+10）", fallback?.[0]?.text === "160 tokens", JSON.stringify(fallback));

cost.sampleZaiCredits(100, 5000, tb);
cost.sampleZaiCredits(250, 5000, tb + 60_000); // 2 分钟内 +150 → 75/min
const parts = cost.meteredRateText(mkCtx(), tb + 120_000);
check("速率文本 = 150/(2min) = 🪙75.00/min（统一符号）", parts?.[0]?.text === "🪙75.00/min", JSON.stringify(parts));
check("积分速率高但零等效成本 → success（颜色与积分数字解耦）", parts?.[0]?.color === "success", JSON.stringify(parts));
check("累计文本 = 🪙150", parts?.[1]?.text === "🪙150");
check("累计染色 dim", parts?.[1]?.color === "dim");

// 「贵不贵」按成本信号染色：zai-coding-cn 的成本轨走国内官方人民币价（ZAI_PRICES 直算），
// turn_end 钩子经 recordTurnCosts 把增量推入 costEvents（真实链路），此处模拟之。
// 阈值仍是 ¥/min：< 0.01 绿 / < 0.1 橙 / ≥ 0.1 红
cost.recordTurnCosts(mkCtx(1.0)); // 小 token 量（glm-5.2 100/50/10）→ ¥ 成本信号极低
const partsCheap = cost.meteredRateText(mkCtx(1.0), tb + 120_000);
check(
	"小 token 量 → success（颜色由国内价信号决定，与积分数字无关）",
	partsCheap?.[0]?.color === "success",
	JSON.stringify(partsCheap),
);

// 大 token 量：glm-5.2 输出 200k → ¥5.6 ÷ 2min = ¥2.8/min ≥ ¥0.1 → error
const bigTokens = { input: 1_000, output: 200_000, cacheRead: 0 };
cost.resetCostTracking(mkCtx());
cost.sampleZaiCredits(100, 5000, tb + 130_000);
cost.sampleZaiCredits(250, 5000, tb + 190_000); // 2 分钟内 +150 → 75/min
cost.recordTurnCosts(mkCtx(1.0, bigTokens));
const partsCostly = cost.meteredRateText(mkCtx(1.0, bigTokens), tb + 250_000);
check("高消耗（¥2.8/min ≥ ¥0.1）染色 error", partsCostly?.[0]?.color === "error", JSON.stringify(partsCostly));

// 未登记型号（如别人家的模型混在同一会话）→ 回落 pi 目录 USD 价：
// $1 ÷ 2min = $0.5/min，无论按 USD 阈值还是折 ¥ 都在红档
cost.resetCostTracking(mkCtx());
cost.sampleZaiCredits(100, 5000, tb + 260_000);
cost.sampleZaiCredits(250, 5000, tb + 320_000);
cost.recordTurnCosts(mkCtx(1.0, {}, "some-other-model"));
const partsFallback = cost.meteredRateText(mkCtx(1.0, {}, "some-other-model"), tb + 380_000);
check("未登记型号回落 USD 价 → error", partsFallback?.[0]?.color === "error", JSON.stringify(partsFallback));

// 复位本场景的状态，后续断言依赖「累计 🪙150 + 窗口内无新样本、无成本事件」
cost.resetCostTracking(mkCtx());
cost.resetZaiCreditTracking();
cost.sampleZaiCredits(100, 5000, tb);
cost.sampleZaiCredits(250, 5000, tb + 60_000);

// 零速率染色：事件滑出 10 分钟滚动窗口（cutoff = now-600s 需晚于事件 ts=tb+60s）+ 零等效成本 → success
const low = cost.meteredRateText(mkCtx(), tb + 661_000);
check("零速率 + 零成本 → success", low?.[0]?.color === "success" && low?.[0]?.text === "🪙0.00/min", JSON.stringify(low));
check("事件滑出窗口后累计仍在", low?.[1]?.text === "🪙150");

// turns=0（无 assistant 消息）→ null
const emptyCtx = { model: { provider: "zai-coding-cn" }, sessionManager: { getBranch: () => [] } };
check("无对话时返回 null", cost.meteredRateText(emptyCtx, tb) === null);

// ---- 场景 5：BALANCE_ADAPTERS 注册表 smoke ----
console.log("场景 5：zai-coding-cn 适配器注册");
const adapter = balance.BALANCE_ADAPTERS["zai-coding-cn"];
check("BALANCE_ADAPTERS 已注册 zai-coding-cn", !!adapter);
check("label = Z.AI Coding CN", adapter?.label === "Z.AI Coding CN");
check("rateText 接线 meteredRateText（未采样时回落 token 数，证明 provider 分流生效）", (() => {
	// 两个独立 bundle 各持一份积分状态：balance bundle 未被 sampleZaiCredits 喂过 →
	// 应走「未采样回落」分支返回 token 数（而非积分或 USD 文本），以此验证接线正确
	const a = adapter?.rateText?.(mkCtx(), tb + 661_000);
	return Array.isArray(a) && a[0]?.text === "160 tokens";
})());
check("currencySymbol(CR) = 🪙（非货币计费统一符号）", cost.currencySymbol("CR") === cost.CREDIT_SYMBOL && cost.CREDIT_SYMBOL === "🪙");

// ---- 清理 ----
rmSync(BUNDLE_COST, { force: true });
rmSync(BUNDLE_BALANCE, { force: true });

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 个断言失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
