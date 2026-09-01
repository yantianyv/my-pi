/**
 * hud-cost：HUD 消耗统计模块（hud 多文件扩展的组成部分，仅被 hud/index.ts 与 hud/balance.ts import）
 *
 * 职责：
 * - 会话 usage 汇总（跨 turn 累加 assistant 消息）
 * - 消耗速率统计（costEvents 10 分钟滚动窗口 + 输出 token 速率 EMA 平滑）
 * - 成本口径**双轨**，按供应商区分，互不换算：
 *   - DeepSeek：官方人民币定价直算（CNY），**永不依赖汇率**，始终显示 ¥
 *   - 其余供应商：pi 原始 USD 成本；有汇率换算显示 ¥，无汇率显示 $（原始货币）
 * - **积分轨**（第三种货币）：Z.AI Coding CN（智谱 GLM Coding Plan）按订阅积分计费，
 *   积分是独立货币、不换算 ¥/$；消息 usage 不含积分无法本地定价直算，
 *   只能远端采样 quota 接口做差分（turn_end / 余额刷新时拉「5h 窗口已用积分」）
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

/**
 * 非货币计费统一符号（积分/点数等非 ¥/$ 计费单位通用）：
 * - currency 内部代码统一用 "CR"（credits），渲染层经 currencySymbol("CR") 转本符号；
 * - 未来新增非货币计费供应商直接复用，不另设符号；
 * - 🪙 宽度已实测：pi-tui visibleWidth 按 2 列计算，与 Windows Terminal emoji 渲染一致，不破布局。
 */
export const CREDIT_SYMBOL = "🪙";

/** 货币缩写 → 符号（CNY→¥、USD→$、CR→非货币计费统一符号；其他保持 `XXX ` 带空格前缀）。 */
export function currencySymbol(currency: string): string {
	switch (currency) {
		case "CNY":
			return "¥";
		case "USD":
			return "$";
		case "CR":
			return CREDIT_SYMBOL;
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

// ---------------------------------------------------------------------------
// Z.AI Coding CN（智谱 GLM Coding Plan 国内版）积分轨：积分 = 独立货币，不换算 ¥/$
// 数据来源（官方未写入文档，社区监控通用）：
//   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
//   认证：Authorization: <apiKey>（裸 key，无 Bearer 前缀）
//   响应 data.limits[]：积分窗口 type=CREDIT_LIMIT（新版透明积分制；旧版/他档为
//   TOKENS_LIMIT）按 nextResetTime 升序 → [0]=5h 窗口、末条=周窗口，
//   另有 type=TIME_LIMIT 一条（MCP 月度，部分档位无）；
//   percentage=已用百分比，currentValue/usage（可选）=已用/总额度积分
// 采样差分：turn_end / 余额刷新时取「5h 窗口已用积分」与上次采样做差——
//   正增量入 10 分钟滚动窗口 + 会话累计；负增量（接口回退）与窗口滚动
//   （nextResetTime 变化，5h 窗口到期清零）仅换基线不记增量，避免假峰值。
// 数字与颜色解耦：🪙 数字只反映额度消耗速率；「贵不贵」的颜色信号按 pi 内置
//   provider 价格（usage.cost.total，USD 等效成本，走 costEvents 的 usd 轨）判断
// ---------------------------------------------------------------------------

export const ZAI_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

/** quota/limit 响应中的单条窗口限制。 */
export interface ZaiTokenLimit {
	type?: string;
	percentage?: number;
	nextResetTime?: number;
	currentValue?: number;
	usage?: number;
}

/** quota/limit 响应结构（code 非 200 视为失败）。 */
export interface ZaiQuotaResponse {
	code?: number;
	data?: { level?: string; limits?: ZaiTokenLimit[] };
}

/**
 * 是否为积分窗口：透明积分制实测（2026-02，Lite 档）返回 type=CREDIT_LIMIT 两条
 * （5h 窗口 + 周窗口，currentValue/usage 为积分值）；旧版/他档（社区 glm-usage 项目）
 * 为 TOKENS_LIMIT。两者均按积分窗口处理；TIME_LIMIT（MCP 月度）另行归类。
 */
function zaiIsCreditWindow(l: ZaiTokenLimit): boolean {
	return l.type === "CREDIT_LIMIT" || l.type === "TOKENS_LIMIT";
}

const ZAI_CREDITS_FETCH_THROTTLE_MS = 30_000; // turn_end 采样节流（余额刷新另有 5min 周期，两者共用同一差分状态）

let zaiCreditEvents: { ts: number; credits: number }[] = []; // 会话积分增量事件（10 分钟滚动窗口）
let zaiCreditSessionTotal = 0; // 会话累计积分（Σ正增量；窗口滚动不丢已有事件）
let zaiCreditLastUsed: number | null = null; // 上次采样：5h 窗口已用积分（null = 从未采样成功）
let zaiCreditLastResetAt = 0; // 上次采样：窗口重置时刻（变化 = 窗口滚动，差分作废）
let zaiCreditLastFetch = 0; // 上次发起采样请求时刻（节流）

/** 从 quota/limit 响应取「5 小时窗口」（积分窗口中 nextResetTime 最小的一条）。 */
export function zai5hWindow(data: ZaiQuotaResponse): ZaiTokenLimit | null {
	const rows = (data.data?.limits ?? []).filter(
		(l): l is ZaiTokenLimit & { nextResetTime: number } =>
			zaiIsCreditWindow(l) && typeof l.nextResetTime === "number",
	);
	if (rows.length === 0) return null;
	rows.sort((a, b) => a.nextResetTime - b.nextResetTime);
	return rows[0];
}

/** 窗口已用积分：优先 currentValue（精确值），缺失时 percentage×usage 推算；均无 → null。 */
export function zaiWindowUsedCredits(w: ZaiTokenLimit): number | null {
	if (typeof w.currentValue === "number" && Number.isFinite(w.currentValue)) return w.currentValue;
	if (typeof w.percentage === "number" && typeof w.usage === "number") {
		return (w.percentage / 100) * w.usage;
	}
	return null;
}

/** 差分一次积分采样：窗口未滚动时正增量入事件；负增量/窗口滚动仅换基线。 */
export function sampleZaiCredits(used: number, resetAt: number, ts = Date.now()): void {
	if (zaiCreditLastUsed !== null && resetAt === zaiCreditLastResetAt) {
		const delta = used - zaiCreditLastUsed;
		if (delta > 0) {
			zaiCreditEvents.push({ ts, credits: delta });
			const cutoff = ts - RATE_WINDOW_MS;
			zaiCreditEvents = zaiCreditEvents.filter((e) => e.ts >= cutoff);
			zaiCreditSessionTotal += delta;
		}
	}
	zaiCreditLastUsed = used;
	zaiCreditLastResetAt = resetAt;
}

/** 是否已成功采样过积分（未采样过时 rateText 回落显示 token 数）。 */
export function zaiCreditsSampled(): boolean {
	return zaiCreditLastUsed !== null;
}

/** 会话重置时清空积分轨（供 resetCostTracking 调用）。 */
export function resetZaiCreditTracking(): void {
	zaiCreditEvents = [];
	zaiCreditSessionTotal = 0;
	zaiCreditLastUsed = null;
	zaiCreditLastResetAt = 0;
	zaiCreditLastFetch = 0;
}

/** 积分消耗速率（积分/min，10 分钟滚动窗口；会话不足 1 分钟时返回 0）。 */
function computeZaiCreditRate(now: number): number {
	const elapsed = now - startupTime;
	if (elapsed < MIN_WINDOW_MS) return 0;
	const windowMs = Math.min(elapsed, RATE_WINDOW_MS);
	const cutoff = now - windowMs;
	let sum = 0;
	for (const e of zaiCreditEvents) {
		if (e.ts >= cutoff) sum += e.credits;
	}
	return sum / (windowMs / 60_000);
}

/**
 * turn_end 采样 Z.AI 积分（fire-and-forget，失败静默下次再试；30s 节流）：
 * 拉 quota/limit → 取 5h 窗口已用积分 → sampleZaiCredits 差分。
 */
export async function recordZaiCreditUsage(ctx: ExtensionContext): Promise<void> {
	const now = Date.now();
	if (now - zaiCreditLastFetch < ZAI_CREDITS_FETCH_THROTTLE_MS) return;
	zaiCreditLastFetch = now;
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider("zai-coding-cn");
		if (!key) return;
		const res = await fetch(ZAI_QUOTA_URL, {
			headers: { Authorization: key, Accept: "application/json" },
			signal: AbortSignal.timeout(8_000),
		});
		if (!res.ok) return;
		const w = zai5hWindow((await res.json()) as ZaiQuotaResponse);
		const used = w ? zaiWindowUsedCredits(w) : null;
		if (used !== null) sampleZaiCredits(used, w?.nextResetTime ?? 0);
	} catch {
		/* 采样失败静默：rateText 在从未采样成功时自动回落 token 数 */
	}
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
	resetZaiCreditTracking(); // Z.AI 积分轨同步清零（换会话/换供应商后旧采样无意义）
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
// 峰谷定价：DEEPSEEK_PRICES 存「空闲时段」价，高峰时段 = 空闲 × 2
//   （高峰时段 = 北京时间每日 9:00-12:00 / 14:00-18:00）：
//   deepseek-v4-flash：缓存命中 ¥0.05，缓存未命中 ¥1.5，输出 ¥4.5（高峰 0.10 / 3.0 / 9.0）
//   deepseek-v4-pro ：缓存命中 ¥0.15，缓存未命中 ¥4.5，输出 ¥13.5（高峰 0.30 / 9.0 / 27.0）
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


const DEEPSEEK_PEAK_HOURS: Array<[number, number]> = [
	[9, 12],
	[14, 18],
];

/** 当前是否处于 DeepSeek 官方高峰时段（北京时间）。 */
export function isDeepSeekPeakHour(ts: number): boolean {
	const hour = new Date(ts + 8 * 3_600_000).getUTCHours(); // 北京时间 = UTC+8
	return DEEPSEEK_PEAK_HOURS.some(([start, end]) => hour >= start && hour < end);
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

// ---------------------------------------------------------------------------
// Kimi 官方人民币定价（元 / 百万 tokens）
// 来源：https://www.kimi.com/membership/pricing?tab=api
//   kimi-k3          ：缓存命中 ¥2.00，缓存未命中 ¥20.00，输出 ¥100.00
//   kimi-k2.7-code   ：缓存命中 ¥1.30，缓存未命中 ¥6.50， 输出 ¥27.00
//   kimi-k2.7-code-high（高速版）：缓存命中 ¥3.90，缓存未命中 ¥19.50，输出 ¥81.00
//   kimi-k2.6        ：缓存命中 ¥1.10，缓存未命中 ¥6.50， 输出 ¥27.00
// 说明：Kimi For Coding 订阅制也按 K2.7 Code API 价估算等效消费。
// ---------------------------------------------------------------------------

interface KimiPrice {
	cacheHit: number; // 缓存命中输入（元/百万 tokens）
	cacheMiss: number; // 缓存未命中输入
	output: number; // 输出
}

const KIMI_PRICES: Record<string, KimiPrice> = {
	"kimi-k3": { cacheHit: 2.0, cacheMiss: 20.0, output: 100.0 },
	"kimi-k2.7-code": { cacheHit: 1.3, cacheMiss: 6.5, output: 27.0 },
	"kimi-k2.7-code-high": { cacheHit: 3.9, cacheMiss: 19.5, output: 81.0 },
	"kimi-k2.6": { cacheHit: 1.1, cacheMiss: 6.5, output: 27.0 },
};

function kimiModelKey(modelId: string): string {
	const id = modelId.toLowerCase();
	if (id.includes("k3")) return "kimi-k3";
	if (id.includes("k2.7") || id.includes("k2-7")) {
		if (id.includes("high") || id.includes("ultra") || id.includes("fast")) return "kimi-k2.7-code-high";
		return "kimi-k2.7-code";
	}
	if (id.includes("k2.6") || id.includes("k2-6")) return "kimi-k2.6";
	return "kimi-k2.7-code"; // Kimi For Coding 默认按 K2.7 Code 估算
}

/**
 * Kimi 消耗成本（人民币元），按官方定价直算。
 * 对 Kimi For Coding 订阅制也按 K2.7 Code API 价估算等效消费。
 */
function kimiCostCny(u: AssistantMessage["usage"], modelId: string): number {
	const p = KIMI_PRICES[kimiModelKey(modelId)] ?? KIMI_PRICES["kimi-k2.7-code"];
	return (p.cacheMiss * u.input + p.cacheHit * u.cacheRead + p.output * u.output) / 1_000_000;
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
	const p = DEEPSEEK_PRICES[deepseekModelKey(modelId)] ?? DEEPSEEK_PRICES["deepseek-v4-flash"];
	const peak = isDeepSeekPeakHour(ts) ? 2 : 1;
	return ((p.cacheMiss * u.input + p.cacheHit * u.cacheRead + p.output * u.output) * peak) / 1_000_000;
}

// ---------------------------------------------------------------------------
// OpenCode Go 官方 USD 计价（美元 / 百万 tokens）
// 来源：https://opencode.ai/docs/zh-cn/go （Go 订阅内额度消耗折算价）
//   注意：这是 Go 订阅内各模型的「额度消耗价」，与 Zen 按量付费价不同——
//   Go 对多数模型有 6x 乘数补贴（批量折扣 + 预留 GPU），部分是平价。
//   DeepSeek 系列：高峰 = 平峰 ×2。高峰时段 = 周一~周五 01:00-04:00 / 06:00-10:00 UTC
//     （即北京时间周一~周五 09:00-12:00 / 14:00-18:00），周末全天平峰。
//   分档价（≤/> 上下文阈值两档）只在有高低两档的模型上启用：按单条消息 token 总量判定。
// ---------------------------------------------------------------------------

interface GoPrice {
	cacheMiss: number; // 缓存未命中输入（USD/百万 tokens）
	cacheHit: number; // 缓存读取
	output: number; // 输出
	highTier?: {
		// 超过上下文阈值后的高价档（可选）
		threshold: number;
		cacheMiss: number;
		cacheHit: number;
		output: number;
	};
}

const GO_PRICES: Record<string, GoPrice> = {
	"grok-4.6": {
		cacheMiss: 2.0,
		cacheHit: 0.5,
		output: 6.0,
		highTier: { threshold: 200_000, cacheMiss: 4.0, cacheHit: 1.0, output: 12.0 },
	},
	"gpt-5.6-luna": {
		cacheMiss: 0.2,
		cacheHit: 0.02,
		output: 1.2,
		highTier: { threshold: 272_000, cacheMiss: 0.4, cacheHit: 0.04, output: 1.8 },
	},
	"glm-5.3-flash": { cacheMiss: 0.15, cacheHit: 0.03, output: 0.5 },
	"glm-5.3": { cacheMiss: 1.4, cacheHit: 0.26, output: 4.4 },
	"glm-5.2": { cacheMiss: 1.4, cacheHit: 0.26, output: 4.4 },
	"glm-5.1": { cacheMiss: 1.4, cacheHit: 0.26, output: 4.4 },
	"kimi-k3": { cacheMiss: 3.0, cacheHit: 0.3, output: 15.0 },
	"kimi-k2.7-code": { cacheMiss: 0.95, cacheHit: 0.19, output: 4.0 },
	"kimi-k2.6": { cacheMiss: 0.95, cacheHit: 0.16, output: 4.0 },
	"longcat-2.0": { cacheMiss: 0.3, cacheHit: 0.006, output: 1.2 },
	"mimo-v2.5": { cacheMiss: 0.14, cacheHit: 0.0028, output: 0.28 },
	"mimo-v2.5-pro": { cacheMiss: 0.435, cacheHit: 0.003625, output: 0.87 },
	"minimax-m3": { cacheMiss: 0.3, cacheHit: 0.06, output: 1.2 },
	"minimax-m2.7": { cacheMiss: 0.3, cacheHit: 0.06, output: 1.2 },
	"muse-spark-1.2-contributor": { cacheMiss: 0.1, cacheHit: 0.002, output: 0.2 },
	"qwen3.8-max": { cacheMiss: 2.0, cacheHit: 0.25, output: 6.0 },
	"qwen3.8-flash": { cacheMiss: 0.15, cacheHit: 0.016, output: 0.47 },
	"qwen3.7-max": { cacheMiss: 2.5, cacheHit: 0.5, output: 7.5 },
	"qwen3.7-plus": {
		cacheMiss: 0.4,
		cacheHit: 0.04,
		output: 1.6,
		highTier: { threshold: 256_000, cacheMiss: 1.2, cacheHit: 0.12, output: 4.8 },
	},
	"qwen3.6-plus": {
		cacheMiss: 0.5,
		cacheHit: 0.05,
		output: 3.0,
		highTier: { threshold: 256_000, cacheMiss: 2.0, cacheHit: 0.2, output: 6.0 },
	},
	"deepseek-v4-pro": { cacheMiss: 0.66, cacheHit: 0.022, output: 1.98 },
	"deepseek-v4-flash": { cacheMiss: 0.22, cacheHit: 0.007, output: 0.66 },
	"deepseek-v4-flash-vision-exp": { cacheMiss: 0.22, cacheHit: 0.007, output: 0.66 },
	"hy4-preview": { cacheMiss: 0.834, cacheHit: 0.042, output: 2.501 },
	"hy3": { cacheMiss: 0.14, cacheHit: 0.035, output: 0.58 },
};

function goModelKey(modelId: string): string {
	const id = modelId.toLowerCase();
	if (id.includes("grok")) return "grok-4.6";
	if (id.includes("gpt-5.6") || id.includes("luna")) return "gpt-5.6-luna";
	if (id.includes("glm-5.3-flash")) return "glm-5.3-flash";
	if (id.includes("glm-5.3")) return "glm-5.3";
	if (id.includes("glm-5.2")) return "glm-5.2";
	if (id.includes("glm-5.1")) return "glm-5.1";
	if (id.includes("kimi-k3") || id.includes("k3")) return "kimi-k3";
	if (id.includes("k2.7") || id.includes("k2-7")) return "kimi-k2.7-code";
	if (id.includes("k2.6") || id.includes("k2-6")) return "kimi-k2.6";
	if (id.includes("longcat")) return "longcat-2.0";
	if (id.includes("deepseek") && id.includes("vision")) return "deepseek-v4-flash-vision-exp";
	if (id.includes("deepseek") && id.includes("pro")) return "deepseek-v4-pro";
	if (id.includes("deepseek")) return "deepseek-v4-flash";
	if (id.includes("mimo") && id.includes("pro")) return "mimo-v2.5-pro";
	if (id.includes("mimo")) return "mimo-v2.5";
	if (id.includes("minimax-m3")) return "minimax-m3";
	if (id.includes("minimax")) return "minimax-m2.7"; // M2.7 / M2.5 同价
	if (id.includes("muse")) return "muse-spark-1.2-contributor";
	if (id.includes("qwen3.8-max")) return "qwen3.8-max";
	if (id.includes("qwen3.8-flash")) return "qwen3.8-flash";
	if (id.includes("qwen3.7-max")) return "qwen3.7-max";
	if (id.includes("qwen3.7")) return "qwen3.7-plus";
	if (id.includes("qwen3.6")) return "qwen3.6-plus";
	if (id.includes("qwen")) return "qwen3.6-plus"; // 其他 Qwen 兜底
	if (id.includes("hy4")) return "hy4-preview";
	if (id.includes("hy3")) return "hy3";
	return "kimi-k2.7-code"; // 未知模型兜底：取中间价位，避免低估额度消耗
}

/**
 * OpenCode Go 内 DeepSeek 系列高峰时段（周一~周五 01:00-04:00 / 06:00-10:00 UTC，
 * 即北京时间 09:00-12:00 / 14:00-18:00，周末全天平峰）。
 */
export function isGoPeakHour(ts: number): boolean {
	const d = new Date(ts);
	const day = d.getUTCDay();
	if (day === 0 || day === 6) return false; // 周末全天平峰
	const h = d.getUTCHours();
	return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/**
 * OpenCode Go 单条消息消耗（USD），按 Go 订阅内官方 USD 计价直算（不走 pi 的 USD 成本）。
 * - 有高低两档的模型按本条消息 token 总量（input+output+cacheRead+cacheWrite）判定档位
 * - DeepSeek 系列高峰 ×2（周末/平峰保持平峰价）
 */
function goCostUsd(u: AssistantMessage["usage"], modelId: string, ts: number): number {
	const key = goModelKey(modelId);
	const p = GO_PRICES[key] ?? GO_PRICES["kimi-k2.7-code"];
	const total = u.input + u.output + u.cacheRead + u.cacheWrite;
	const hi = p.highTier && total > p.highTier.threshold ? p.highTier : null;
	const miss = hi?.cacheMiss ?? p.cacheMiss;
	const hit = hi?.cacheHit ?? p.cacheHit;
	const out = hi?.output ?? p.output;
	const peak = key.startsWith("deepseek") && isGoPeakHour(ts) ? 2 : 1;
	return ((miss * u.input + hit * u.cacheRead + out * u.output) * peak) / 1_000_000;
}

/**
 * 单条 assistant 消息的消耗成本（原始货币，双轨）：
 * - DeepSeek / Kimi（含 Kimi For Coding）/ MiMo → { cny }：官方人民币定价直算，永不依赖汇率
 * - OpenCode Go → { usd }：按 Go 订阅内官方 USD 计价直算（见 GO_PRICES）
 * - 其余供应商 → { usd }：pi 原始 USD 成本
 */
function msgCost(m: AssistantMessage): MsgCost {
	if (m.provider === "deepseek") return { cny: deepseekCostCny(m.usage, m.model, m.timestamp) };
	if (m.provider === "xiaomi") return { cny: mimoCostCny(m.usage, m.model) };
	if (
		m.provider === "kimi-coding" ||
		m.provider === "moonshotai" ||
		m.provider === "moonshotai-cn"
	) {
		return { cny: kimiCostCny(m.usage, m.model) };
	}
	if (m.provider === "opencode-go") return { usd: goCostUsd(m.usage, m.model, m.timestamp) };
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
	// Z.AI Coding CN：积分轨（积分 = 独立货币，不换算 ¥/$，统一用 🪙 符号）；
	// 从未采样成功（Key 缺失/接口失败）时回落 token 数。
	// 数字与颜色解耦：🪙/min 只反映订阅额度消耗速率，颜色按 pi 内置 provider 价格
	//（usage.cost.total，USD 等效成本，recordTurnCosts 已入 usd 轨）判断「贵不贵」——
	// 积分/min 高 ≠ 花钱多（各模型积分折算不同），成本速率才是价格信号
	if (ctx.model?.provider === "zai-coding-cn") {
		if (!zaiCreditsSampled()) {
			return [{ text: `${fmtNum(t.input + t.output + t.cacheRead)} tokens`, color: "dim" }];
		}
		const perMin = computeZaiCreditRate(now);
		const usdPerMin = computeRate(now).usd ?? 0;
		const rate = usdCnyRate;
		const color =
			rate !== null && rate > 0 ? rateColor(usdPerMin * rate, true) : rateColor(usdPerMin, false);
		return [
			{ text: `${CREDIT_SYMBOL}${perMin.toFixed(2)}/min`, color },
			{ text: `${CREDIT_SYMBOL}${fmtNum(zaiCreditSessionTotal)}`, color: "dim" },
		];
	}
	// 人民币直算供应商：DeepSeek、MiMo、Kimi（含 Kimi For Coding / 开放平台）
	if (
		ctx.model?.provider === "deepseek" ||
		ctx.model?.provider === "xiaomi" ||
		ctx.model?.provider === "kimi-coding" ||
		ctx.model?.provider === "moonshotai" ||
		ctx.model?.provider === "moonshotai-cn"
	) {
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
