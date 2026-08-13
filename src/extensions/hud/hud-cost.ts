/**
 * hud-cost：HUD 消耗统计模块（hud 多文件扩展的组成部分，仅被 hud/index.ts 与 hud/balance.ts import）
 *
 * 职责：
 * - 会话 usage 汇总（跨 turn 累加 assistant 消息）
 * - 消耗速率统计（costEvents 10 分钟滚动窗口 + 输出 token 速率 EMA 平滑）
 * - 成本口径**双轨**，按供应商区分，互不换算：
 *   - DeepSeek：官方人民币定价直算（CNY），**永不依赖汇率**，始终显示 ¥
 *   - 其余供应商：pi 原始 USD 成本；有汇率换算显示 ¥，无汇率显示 $（原始货币）
 * - 实时汇率：多源拉取（frankfurter → open.er-api，每日快照）→ 磁盘缓存 → 无汇率（显示原始货币）
 *   失败时不使用任何固定近似汇率，保证数值不被猜测值污染
 * - 按量付费文本生成（¥/min 或 $/min），供 balance adapter 的 rateText 使用
 *
 * 注意：本模块不注册任何 pi API，仅导出纯函数/常量，由入口模块驱动。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as os from "node:os";
import * as path from "node:path";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";

// ---------------------------------------------------------------------------
// 实时汇率（USD→CNY）：多源拉取 → 磁盘缓存 → 无（显示原始货币）
// 三态：live（本次会话实时拉取）/ cached（磁盘缓存）/ none（无汇率）
// ---------------------------------------------------------------------------

export type RateSource = "live" | "cached" | "none";

let usdCnyRate: number | null = null; // 内存中的汇率（live 或 cached）
let rateSource: RateSource = "none";

const RATE_CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "tmp", "exchange-rate.json");

function loadRateCache(): number | null {
	const d = loadJsonConfig<{ rate: number }>(
		RATE_CACHE_FILE,
		{ rate: 0 },
		(v): v is { rate: number } => {
			const r = (v as { rate?: unknown } | null)?.rate;
			return typeof r === "number" && r > 0;
		},
	);
	return d.rate > 0 ? d.rate : null;
}

function saveRateCache(rate: number): void {
	saveJsonConfig(RATE_CACHE_FILE, { rate, fetchedAt: Date.now() });
}

/** 当前可用的 USD→CNY 汇率；null = 无汇率（调用方应显示原始货币）。 */
export function getUsdCnyRate(): number | null {
	return usdCnyRate;
}

/** 汇率来源状态：live（实时）/ cached（磁盘缓存）/ none（无，显示原始货币）。 */
export function getRateSource(): RateSource {
	return rateSource;
}

/**
 * 刷新实时汇率：
 * - 拉取成功（frankfurter(ECB) → open.er-api 任一源）：更新内存并写入磁盘缓存，source=live
 * - 拉取失败：读磁盘缓存，source=cached；无缓存则 source=none（保持 null，不猜近似值）
 * 免费汇率均为每日快照，对 HUD 展示足够；调用方应节流（如 1h 一次）。
 */
export async function refreshExchangeRate(): Promise<void> {
	const sources: Array<() => Promise<number | null>> = [
		async () => {
			const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY", {
				signal: AbortSignal.timeout(8_000),
			});
			if (!res.ok) return null;
			const d = (await res.json()) as { rates?: { CNY?: number } };
			const v = d.rates?.CNY;
			return typeof v === "number" && v > 0 ? v : null;
		},
		async () => {
			const res = await fetch("https://open.er-api.com/v6/latest/USD", {
				signal: AbortSignal.timeout(8_000),
			});
			if (!res.ok) return null;
			const d = (await res.json()) as { result?: string; rates?: Record<string, number> };
			const v = d.result === "success" ? d.rates?.CNY : undefined;
			return typeof v === "number" && v > 0 ? v : null;
		},
	];
	for (const src of sources) {
		try {
			const rate = await src();
			if (rate !== null) {
				usdCnyRate = rate;
				rateSource = "live";
				saveRateCache(rate);
				return;
			}
		} catch {
			/* 尝试下一源 */
		}
	}
	// 双源失败：回退磁盘缓存；再无则放弃换算（显示原始货币）
	const cached = loadRateCache();
	usdCnyRate = cached;
	rateSource = cached !== null ? "cached" : "none";
}

export interface RateTextPart {
	text: string;
	color?: string;
}

/** 货币缩写 → 符号（CNY→¥、USD→$；其他保持 `XXX ` 带空格前缀）。 */
export function currencySymbol(currency: string): string {
	switch (currency) {
		case "CNY":
			return "¥";
		case "USD":
			return "$";
		default:
			return `${currency} `;
	}
}

/** 单条消息成本（原始货币）：DeepSeek 恒为官方人民币价，其余为 pi 的 USD 成本。 */
type MsgCost = { cny: number } | { usd: number };

/** 会话 usage 汇总（跨 turn 累加 assistant 消息；成本双轨：costTotalCny / costTotalUsd） */
interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	costTotalCny: number; // DeepSeek 官方人民币价累计
	costTotalUsd: number; // 其余供应商 pi USD 成本累计
	turns: number;
}

export function sumSessionUsage(ctx: ExtensionContext): SessionUsageTotals {
	const t: SessionUsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		costTotalCny: 0,
		costTotalUsd: 0,
		turns: 0,
	};
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			const u = m.usage;
			t.input += u.input;
			t.output += u.output;
			t.cacheRead += u.cacheRead;
			const c = msgCost(m);
			if ("cny" in c) t.costTotalCny += c.cny;
			else t.costTotalUsd += c.usd;
			t.turns++;
		}
	}
	return t;
}

// ---------------------------------------------------------------------------
// 消耗速率统计（模块级状态，供各 provider 的 rateText 使用）
// costEvents 双轨记录：DeepSeek 会话记 CNY 增量，其余记 USD 增量（按会话 provider 判断）
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 10 * 60 * 1000; // 消耗速率统计窗口：最近 10 分钟
const MIN_WINDOW_MS = 60 * 1000; // 启动至少 1 分钟才显示速率（数据太少不准确）
let costEvents: { ts: number; cny: number; usd: number }[] = [];
let lastRecordedCny = 0;
let lastRecordedUsd = 0;
let startupTime = Date.now();

let lastRecordedOutputTotal = 0;
let turnStartTime: number | null = null;
let smoothedTokenRate: number | null = null;

/** 会话启动时刻（供 HUD 行 1 动态区占位“会话时长”显示）。 */
export function getStartupTime(): number {
	return startupTime;
}

const TOKEN_RATE_SMOOTH_FACTOR = 0.2; // 新 turn 速率权重，历史速率权重 = 1 - 0.2

export const fmtNum = (n: number) => {
	if (n >= 1_000_000) {
		const v = n / 1_000_000;
		return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}m`;
	}
	if (n >= 1000) {
		const v = n / 1000;
		return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}k`;
	}
	return `${n}`;
};

/** 平均每分钟消耗（双轨，cny/min 与 usd/min）。 */
function computeRate(now: number): { cny: number | null; usd: number | null } {
	const elapsed = now - startupTime;
	if (elapsed < MIN_WINDOW_MS) return { cny: null, usd: null };
	const windowMs = Math.min(elapsed, RATE_WINDOW_MS);
	const cutoff = now - windowMs;
	let cny = 0,
		usd = 0;
	for (const e of costEvents) {
		if (e.ts < cutoff) continue;
		cny += e.cny;
		usd += e.usd;
	}
	const div = windowMs / 60_000;
	return { cny: cny / div, usd: usd / div };
}

// 输出 token 速率统计（output tokens / sec，基于 turn_start ~ turn_end 做 EMA 平滑）
// ---------------------------------------------------------------------------

function sumOutputTokens(ctx: ExtensionContext): number {
	let total = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			total += (e.message as AssistantMessage).usage.output;
		}
	}
	return total;
}

function computeTokenRate(_now: number): number | null {
	return smoothedTokenRate;
}

/** 会话开始时重置速率统计（避免 resume 旧会话时把历史成本当成首轮增量）。 */
export function resetCostTracking(ctx: ExtensionContext): void {
	startupTime = Date.now();
	const sums = sumCosts(ctx);
	lastRecordedCny = sums.cny;
	lastRecordedUsd = sums.usd;
	lastRecordedOutputTotal = sumOutputTokens(ctx);
	costEvents = [];
	turnStartTime = null;
	smoothedTokenRate = null;
}

/** turn_start 时记录起始时刻（供输出 token 速率计算）。 */
export function startTurn(): void {
	turnStartTime = Date.now();
}

/**
 * turn_end 时记录本 turn 消耗（双轨增量）：
 * - 成本增量推入 10 分钟滚动窗口（供 computeRate）；
 * - 输出 token 增量与耗时做 EMA 平滑（供行 2 的 output tok/s）。
 */
export function recordTurnCosts(ctx: ExtensionContext): void {
	const sums = sumCosts(ctx);
	const dcny = sums.cny - lastRecordedCny;
	const dusd = sums.usd - lastRecordedUsd;
	lastRecordedCny = sums.cny;
	lastRecordedUsd = sums.usd;
	if (dcny > 0 || dusd > 0) {
		costEvents.push({ ts: Date.now(), cny: dcny, usd: dusd });
		const cutoff = Date.now() - RATE_WINDOW_MS;
		costEvents = costEvents.filter((e) => e.ts >= cutoff);
	}
	const outputTotal = sumOutputTokens(ctx);
	const outputDelta = outputTotal - lastRecordedOutputTotal;
	lastRecordedOutputTotal = outputTotal;
	if (outputDelta > 0 && turnStartTime != null) {
		const durationMs = Math.max(100, Date.now() - turnStartTime);
		const turnRate = outputDelta / (durationMs / 1000);
		smoothedTokenRate =
			smoothedTokenRate == null
				? turnRate
				: smoothedTokenRate * (1 - TOKEN_RATE_SMOOTH_FACTOR) + turnRate * TOKEN_RATE_SMOOTH_FACTOR;
	}
	turnStartTime = null;
}

/** 当前会话累计成本（双轨），供速率事件与 /hud 展示使用。 */
function sumCosts(ctx: ExtensionContext): { cny: number; usd: number } {
	let cny = 0,
		usd = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const c = msgCost(e.message as AssistantMessage);
			if ("cny" in c) cny += c.cny;
			else usd += c.usd;
		}
	}
	return { cny, usd };
}

/** 输出 token 速率（/s），用于行 2 渲染。 */
export function getTokenRate(now: number): number | null {
	return computeTokenRate(now);
}

// ---------------------------------------------------------------------------
// DeepSeek 官方人民币定价（元 / 百万 tokens）
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// 峰谷定价（2026-08-17 00:00 北京时间生效，官方公告）：DEEPSEEK_PRICES 存「空闲时段」价，
//   高峰时段 = 空闲 × 2（高峰时段 = 北京时间每日 9:00-12:00 / 14:00-18:00）：
//   deepseek-v4-flash：缓存命中 ¥0.05，缓存未命中 ¥1.5，输出 ¥4.5（高峰 0.10 / 3.0 / 9.0）
//   deepseek-v4-pro ：缓存命中 ¥0.15，缓存未命中 ¥4.5，输出 ¥13.5（高峰 0.30 / 9.0 / 27.0）
// 生效前的旧价（DEEPSEEK_PRICES_OLD，平时基准）：flash 0.02 / 1 / 2；pro 0.025 / 3 / 6。
//   旧价同样带峰谷：以旧代码实现为准（DEEPSEEK_PEAK_PRICING 开关 + 高峰 ×2）。
// 生效切换由 DEEPSEEK_PRICE_EFFECTIVE_TS 按消息时间戳自动判定（历史消息按当时价格核算）；
//   若官方推迟/调整生效，改时间戳或置 null 回退旧价即可，无需改表。
// 扣费规则：扣减费用 = token 消耗量 × 模型单价（命中/未命中/输出分别计价）。
// ---------------------------------------------------------------------------

interface DeepSeekPrice {
	cacheHit: number; // 缓存命中输入（元/百万 tokens）
	cacheMiss: number; // 缓存未命中输入
	output: number; // 输出
}

/** 新峰谷定价（空闲时段基准价；高峰 = ×2）。 */
const DEEPSEEK_PRICES: Record<string, DeepSeekPrice> = {
	"deepseek-v4-flash": { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
	"deepseek-v4-pro": { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
};

/** 生效前旧价（平时基准；高峰 ×2，与旧代码峰谷实现一致）。 */
const DEEPSEEK_PRICES_OLD: Record<string, DeepSeekPrice> = {
	"deepseek-v4-flash": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
	"deepseek-v4-pro": { cacheHit: 0.025, cacheMiss: 3, output: 6 },
};

/** 峰谷定价生效时刻：2026-08-17 00:00 北京时间 = 2026-08-16 16:00 UTC；置 null 则永不生效（回退旧价）。 */
const DEEPSEEK_PRICE_EFFECTIVE_TS: number | null = Date.UTC(2026, 7, 16, 16, 0, 0);
// 峰谷计价总开关（旧代码实现，保留不删）：官方已公布峰谷方案，旧价与新价同按高峰 ×2 计费。
const DEEPSEEK_PEAK_PRICING = true;
// 时段判断（isDeepSeekPeakHour）与价格切换独立：无论新价是否生效，都如实反映当前所处时段，供 HUD 展示提醒。
const DEEPSEEK_PEAK_HOURS: Array<[number, number]> = [
	[9, 12],
	[14, 18],
];

/** 当前是否处于 DeepSeek 官方高峰时段（北京时间；纯时段判断，与价格切换 DEEPSEEK_PRICE_EFFECTIVE_TS 无关）。 */
export function isDeepSeekPeakHour(ts: number): boolean {
	const hour = new Date(ts + 8 * 3_600_000).getUTCHours(); // 北京时间 = UTC+8
	return DEEPSEEK_PEAK_HOURS.some(([start, end]) => hour >= start && hour < end);
}

/**
 * 距 DeepSeek 新峰谷价生效的剩余毫秒；已生效（或时间戳为 null 未启用）返回 null。
 * 供 HUD 在旧价期间显示涨价倒计时（与高峰/低峰时段标签共存）；生效后不再显示。
 */
export function deepseekPriceCountdownMs(now: number): number | null {
	if (DEEPSEEK_PRICE_EFFECTIVE_TS == null) return null;
	const remain = DEEPSEEK_PRICE_EFFECTIVE_TS - now;
	return remain > 0 ? remain : null;
}

// ---------------------------------------------------------------------------
// MiMo Token Plan 夜间优惠（北京时间 0:00-8:00，0.8x 消耗系数）
// 来源：https://mimo.mi.com/docs/zh-CN/tokenplan/Token Plan/subscription
// ---------------------------------------------------------------------------

const MIMO_OFFPEAK_HOURS: [number, number] = [0, 8]; // 北京时间 0:00-8:00

/** 当前是否处于 MiMo Token Plan 夜间优惠时段（北京时间 0:00-8:00）。 */
export function isMimoOffpeakHour(ts: number): boolean {
	const hour = new Date(ts + 8 * 3_600_000).getUTCHours(); // 北京时间 = UTC+8
	return hour >= MIMO_OFFPEAK_HOURS[0] && hour < MIMO_OFFPEAK_HOURS[1];
}

function deepseekModelKey(modelId: string): string {
	return modelId.toLowerCase().includes("pro") ? "deepseek-v4-pro" : "deepseek-v4-flash";
}

// ---------------------------------------------------------------------------
// MiMo 按量付费人民币定价（元 / 百万 tokens）
// 来源：https://mimo.mi.com/
//   mimo-v2.5-pro ：缓存命中 ¥0.025，缓存未命中 ¥3，输出 ¥6
//   mimo-v2.5-pro-ultraspeed ：缓存命中 ¥0.075，缓存未命中 ¥9，输出 ¥18
//   mimo-v2.5 ：缓存命中 ¥0.02，缓存未命中 ¥1，输出 ¥2
// ---------------------------------------------------------------------------

interface MimoPrice {
	cacheHit: number; // 缓存命中输入（元/百万 tokens）
	cacheMiss: number; // 缓存未命中输入
	output: number; // 输出
}

const MIMO_PRICES: Record<string, MimoPrice> = {
	"mimo-v2.5-pro": { cacheHit: 0.025, cacheMiss: 3, output: 6 },
	"mimo-v2.5-pro-ultraspeed": { cacheHit: 0.075, cacheMiss: 9, output: 18 },
	"mimo-v2.5": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
};

function mimoModelKey(modelId: string): string {
	const id = modelId.toLowerCase();
	if (id.includes("ultraspeed")) return "mimo-v2.5-pro-ultraspeed";
	if (id.includes("pro")) return "mimo-v2.5-pro";
	return "mimo-v2.5";
}

/**
 * MiMo 消耗成本（人民币元），按官方定价直算。
 * 与 DeepSeek 同理，不走 pi 的 USD 成本、不依赖汇率。
 */
function mimoCostCny(u: AssistantMessage["usage"], modelId: string): number {
	const p = MIMO_PRICES[mimoModelKey(modelId)] ?? MIMO_PRICES["mimo-v2.5"];
	return (p.cacheMiss * u.input + p.cacheHit * u.cacheRead + p.output * u.output) / 1_000_000;
}

/**
 * DeepSeek 消耗成本（人民币元），按官方定价直算。
 * pi 已将 prompt_cache_miss_tokens → usage.input、prompt_cache_hit_tokens → usage.cacheRead
 * 映射，因此直接用 token 数 × 官方单价即可，不走 pi 的 USD 成本、不依赖汇率。
 */
function deepseekCostCny(u: AssistantMessage["usage"], modelId: string, ts: number): number {
	// 按消息时间戳选择价格表：生效前旧价、生效后新价；两档价均带峰谷（高峰 ×2，空闲 ×1，以旧代码实现为准）
	const effective = DEEPSEEK_PRICE_EFFECTIVE_TS != null && ts >= DEEPSEEK_PRICE_EFFECTIVE_TS;
	const table = effective ? DEEPSEEK_PRICES : DEEPSEEK_PRICES_OLD;
	const p = table[deepseekModelKey(modelId)] ?? table["deepseek-v4-flash"];
	const peak = DEEPSEEK_PEAK_PRICING && isDeepSeekPeakHour(ts) ? 2 : 1;
	return ((p.cacheMiss * u.input + p.cacheHit * u.cacheRead + p.output * u.output) * peak) / 1_000_000;
}

/**
 * 单条 assistant 消息的消耗成本（原始货币，双轨）：
 * - DeepSeek → { cny }：官方人民币定价直算，永不依赖汇率
 * - 其余供应商 → { usd }：pi 原始 USD 成本
 */
function msgCost(m: AssistantMessage): MsgCost {
	if (m.provider === "deepseek") return { cny: deepseekCostCny(m.usage, m.model, m.timestamp) };
	if (m.provider === "xiaomi") return { cny: mimoCostCny(m.usage, m.model) };
	return { usd: m.usage.cost.total };
}

/**
 * 按量付费消耗统计，按会话供应商选择口径：
 * - DeepSeek：恒显示 ¥/min + ¥累计（官方人民币价，不依赖汇率）
 * - 其余：有汇率显示 ¥/min + ¥累计（USD × 汇率）；无汇率显示 $/min + $累计（原始货币）
 *
 * 速率颜色阈值：
 *   < 0.01 ¥/min (或 < $0.002/min) → 绿色（低消耗）
 *   0.01~0.1 ¥/min (或 $0.002~0.02/min) → 橙色（中等）
 *   > 0.1 ¥/min (或 > $0.02/min) → 红色（高消耗）
 */
function rateColor(perMin: number, isCny: boolean): string {
	// 阈值：人民币 / 美元
	const low = isCny ? 0.01 : 0.002;
	const high = isCny ? 0.1 : 0.02;
	if (perMin < low) return "success"; // 绿
	if (perMin < high) return "warning"; // 橙
	return "error"; // 红
}

export function meteredRateText(ctx: ExtensionContext, now: number): RateTextPart[] | null {
	const t = sumSessionUsage(ctx);
	if (t.turns === 0) return null;
	// 人民币直算供应商：DeepSeek、MiMo
	if (ctx.model?.provider === "deepseek" || ctx.model?.provider === "xiaomi") {
		const perMinCny = computeRate(now).cny ?? 0; // cny/min（costEvents 的 cny 轨）
		return [
			{ text: `¥${perMinCny.toFixed(3)}/min`, color: rateColor(perMinCny, true) },
			{ text: `¥${t.costTotalCny.toFixed(2)}`, color: "dim" },
		];
	}
	// 其余供应商：USD 轨，有汇率换 ¥、无汇率显示 $
	const perMinUsd = computeRate(now).usd ?? 0; // usd/min
	const totalUsd = t.costTotalUsd;
	const rate = usdCnyRate;
	if (rate !== null && rate > 0) {
		const perMinCny = perMinUsd * rate;
		return [
			{ text: `¥${perMinCny.toFixed(3)}/min`, color: rateColor(perMinCny, true) },
			{ text: `¥${(totalUsd * rate).toFixed(2)}`, color: "dim" },
		];
	}
	return [
		{ text: `$${perMinUsd.toFixed(3)}/min`, color: rateColor(perMinUsd, false) },
		{ text: `$${totalUsd.toFixed(2)}`, color: "dim" },
	];
}
