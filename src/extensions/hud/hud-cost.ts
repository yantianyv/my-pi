/**
 * hud-cost：HUD 消耗统计模块（hud 多文件扩展的组成部分，仅被 hud/index.ts 与 hud/balance.ts import）
 *
 * 职责：
 * - 会话 usage 汇总（跨 turn 累加 assistant 消息）
 * - 消耗速率统计（costEvents 10 分钟滚动窗口 + 输出 token 速率 EMA 平滑）
 * - 成本口径**双轨**，按供应商区分，互不换算：
 *   - DeepSeek：官方人民币定价直算（CNY），**永不依赖汇率**，始终显示 ¥
 *   - 其余供应商：pi 原始 USD 成本；有汇率换算显示 ¥，无汇率显示 $（原始货币）
 *   - OpenCode Go：额度当量 USD（标价 × 池/月额度），不是真实花费，不换算成 ¥
 * - **积分轨**（第三种货币）：按订阅积分计费的计划（Z.AI Coding CN / MiMo Token Plan），
 *   积分是独立货币、不换算 ¥/$；消息 usage 不含积分无法本地定价直算，
 *   只能远端采样 plan 接口做差分（turn_end / 余额刷新时拉「本周期已用积分」）
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

/** 单条消息成本（原始货币）：DeepSeek/MiMo 按量恒为官方人民币价，Token Plan 为积分，其余为 pi 的 USD 成本。 */
type MsgCost = { cny: number } | { usd: number } | { cr: number };

/** 会话 usage 汇总（跨 turn 累加 assistant 消息；成本三轨：costTotalCny / costTotalUsd / costTotalCr） */
interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	costTotalCny: number; // DeepSeek / MiMo 按量：官方人民币价累计
	costTotalUsd: number; // 其余供应商 pi USD 成本累计
	costTotalCr: number; // 积分轨（MiMo Token Plan）本地估算累计
	turns: number;
}

export function sumSessionUsage(ctx: ExtensionContext): SessionUsageTotals {
	const t: SessionUsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		costTotalCny: 0,
		costTotalUsd: 0,
		costTotalCr: 0,
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
			else if ("cr" in c) t.costTotalCr += c.cr;
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
let costEvents: { ts: number; cny: number; usd: number; cr: number }[] = [];
let lastRecordedCny = 0;
let lastRecordedUsd = 0;
let lastRecordedCr = 0;
let startupTime = Date.now();

let lastRecordedOutputTotal = 0;
let turnStartTime: number | null = null;
let modelPhaseEnd: number | null = null; // 本轮 assistant 消息流式结束时刻（模型生成段的终点）
let smoothedTokenRate: number | null = null;
let lastTurnRate: number | null = null; // 最近一轮的原始速率（未平滑），供 HUD 与平滑值并显
let lastTurnOutput: number | null = null; // 最近一轮的输出 token 数，供 HUD 做柱状图视觉加权（越长越亮）

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
		const body = (await res.json()) as ZaiQuotaResponse;
		detectGlmTier(body);
		const w = zai5hWindow(body);
		const used = w ? zaiWindowUsedCredits(w) : null;
		if (used !== null) sampleZaiCredits(used, w?.nextResetTime ?? 0);
	} catch {
		/* 采样失败静默：rateText 在从未采样成功时自动回落 token 数 */
	}
}

const TOKEN_RATE_SMOOTH_FACTOR = 0.1; // 新 turn 速率权重（越小越平滑），历史权重 = 1 - 该值

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

/** 平均每分钟消耗（三轨：cny/min、usd/min、积分/min）。 */
function computeRate(now: number): { cny: number | null; usd: number | null; cr: number | null } {
	const elapsed = now - startupTime;
	if (elapsed < MIN_WINDOW_MS) return { cny: null, usd: null, cr: null };
	const windowMs = Math.min(elapsed, RATE_WINDOW_MS);
	const cutoff = now - windowMs;
	let cny = 0,
		usd = 0,
		cr = 0;
	for (const e of costEvents) {
		if (e.ts < cutoff) continue;
		cny += e.cny;
		usd += e.usd;
		cr += e.cr;
	}
	const div = windowMs / 60_000;
	return { cny: cny / div, usd: usd / div, cr: cr / div };
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
	lastRecordedCr = sums.cr;
	lastRecordedOutputTotal = sumOutputTokens(ctx);
	costEvents = [];
	turnStartTime = null;
	modelPhaseEnd = null;
	smoothedTokenRate = null;
	lastTurnRate = null;
	lastTurnOutput = null;
	resetZaiCreditTracking(); // Z.AI 积分轨同步清零（换会话/换供应商后旧采样无意义）
}

/** turn_start 时记录起始时刻（供输出 token 速率计算）。 */
export function startTurn(): void {
	turnStartTime = Date.now();
	modelPhaseEnd = null;
}

/**
 * assistant 消息流式结束（message_end）即本轮「模型生成段」的终点。
 * 速率只认这一段：pi 的一个 turn = 一次模型响应 + 该响应触发的所有工具调用，
 * 到 turn_end 时工具早跑完了——用 turn 全长当分母会把工具耗时算进模型速率。
 */
export function markModelPhaseEnd(): void {
	modelPhaseEnd = Date.now();
}

/**
 * 本轮模型生成段速率（tok/s）：分母 = turn_start → assistant message_end。
 * 含请求发送、网络延迟、首字延迟与思考（都是模型侧时间），不含工具执行。
 */
export function computeModelPhaseRate(outputDelta: number, startMs: number, endMs: number): number {
	const durationMs = Math.max(100, endMs - startMs);
	return outputDelta / (durationMs / 1000);
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
	const dcr = sums.cr - lastRecordedCr;
	lastRecordedCny = sums.cny;
	lastRecordedUsd = sums.usd;
	lastRecordedCr = sums.cr;
	if (dcny > 0 || dusd > 0 || dcr > 0) {
		costEvents.push({ ts: Date.now(), cny: dcny, usd: dusd, cr: dcr });
		const cutoff = Date.now() - RATE_WINDOW_MS;
		costEvents = costEvents.filter((e) => e.ts >= cutoff);
	}
	const outputTotal = sumOutputTokens(ctx);
	const outputDelta = outputTotal - lastRecordedOutputTotal;
	lastRecordedOutputTotal = outputTotal;
	lastTurnOutput = Math.max(0, outputDelta);
	if (outputDelta > 0 && turnStartTime != null) {
		// 分母优先用模型生成段终点（message_end）；没有 assistant 消息的异常轮退化为 turn 全长
		const turnRate = computeModelPhaseRate(outputDelta, turnStartTime, modelPhaseEnd ?? Date.now());
		lastTurnRate = turnRate;
		smoothedTokenRate =
			smoothedTokenRate == null
				? turnRate
				: smoothedTokenRate * (1 - TOKEN_RATE_SMOOTH_FACTOR) + turnRate * TOKEN_RATE_SMOOTH_FACTOR;
	}
	turnStartTime = null;
	modelPhaseEnd = null;
}

/** 当前会话累计成本（三轨），供速率事件与 /hud 展示使用。 */
function sumCosts(ctx: ExtensionContext): { cny: number; usd: number; cr: number } {
	let cny = 0,
		usd = 0,
		cr = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const c = msgCost(e.message as AssistantMessage);
			if ("cny" in c) cny += c.cny;
			else if ("cr" in c) cr += c.cr;
			else usd += c.usd;
		}
	}
	return { cny, usd, cr };
}

/** 输出 token 速率（/s，80/10 EMA 平滑值），用于 HUD 显示。 */
export function getTokenRate(now: number): number | null {
	return computeTokenRate(now);
}

/** 最近一轮的原始输出速率（/s，未平滑）——与平滑值并显，看清"这一轮有多快 / 平时多快"。 */
export function getTurnRate(): number | null {
	return lastTurnRate;
}

/** 最近一轮的输出 token 数（未平滑）——HUD 速率柱按它做视觉加权（输出越长越亮）。 */
export function getTurnOutput(): number | null {
	return lastTurnOutput;
}

// ---------------------------------------------------------------------------
// DeepSeek 官方人民币定价（元 / 百万 tokens）
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// 峰谷定价：DEEPSEEK_PRICES 存「空闲时段」价，高峰时段 = 空闲 × 2
//   （高峰时段 = 北京时间周一至周五 9:00-12:00 / 14:00-18:00，周末全天空闲价；
//     官方口径还排除中国法定节假日，isDeepSeekPeakHour 未内置节假日表，节假日会按高峰价估算）：
//   deepseek-flash   ：缓存命中 ¥0.02，缓存未命中 ¥1，输出 ¥4（高峰 0.04 / 2 / 8）
//     （V4.1-Flash；旧模型名 deepseek-v4-flash 已下线，请求由 V4.1-Flash 承接并按此价计费）
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
	"deepseek-flash": { cacheHit: 0.02, cacheMiss: 1, output: 4 },
	"deepseek-v4-pro": { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
};


const DEEPSEEK_PEAK_HOURS: Array<[number, number]> = [
	[9, 12],
	[14, 18],
];

/** 当前是否处于 DeepSeek 官方高峰时段（北京时间周一至周五 9-12 / 14-18，周末全天空闲价）。 */
export function isDeepSeekPeakHour(ts: number): boolean {
	const bj = new Date(ts + 8 * 3_600_000); // 北京时间 = UTC+8（用 UTC 口径取星期/小时）
	const day = bj.getUTCDay();
	if (day === 0 || day === 6) return false; // 周末全天空闲
	const hour = bj.getUTCHours();
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
	// 官方仅两个计费档：pro 档（deepseek-v4-pro）与 flash 档（deepseek-flash，即 V4.1-Flash；
	// 旧名 deepseek-v4-flash 已下线由其承接，同价）
	return modelId.toLowerCase().includes("pro") ? "deepseek-v4-pro" : "deepseek-flash";
}

// ---------------------------------------------------------------------------
// MiMo 定价（元 / 百万 tokens，按量付费；Token Plan 的积分折算见 MIMO_CREDITS）
// 来源：https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go、/price/token-plan
//   V2.6 系列（2026-09-22 发布，Flash/Pro 与 V2.5 持平）：
//   mimo-v2.6-pro ：缓存命中 ¥0.025，缓存未命中 ¥3，输出 ¥6
//   mimo-v2.6-flash ：缓存命中 ¥0.02，缓存未命中 ¥1，输出 ¥2
//   mimo-v2.6-pro-ultraspeed ：缓存命中 ¥0.25，缓存未命中 ¥30，输出 ¥60（Pro 的 10 倍）
//   V2.5 系列：
//   mimo-v2.5-pro ：缓存命中 ¥0.025，缓存未命中 ¥3，输出 ¥6
//   mimo-v2.5-pro-ultraspeed ：缓存命中 ¥0.075，缓存未命中 ¥9，输出 ¥18（Pro 的 3 倍）
//   mimo-v2.5 ：缓存命中 ¥0.02，缓存未命中 ¥1，输出 ¥2
// ---------------------------------------------------------------------------

interface MimoPrice {
	cacheHit: number; // 缓存命中输入（元/百万 tokens）
	cacheMiss: number; // 缓存未命中输入
	output: number; // 输出
}

const MIMO_PRICES: Record<string, MimoPrice> = {
	"mimo-v2.6-pro": { cacheHit: 0.025, cacheMiss: 3, output: 6 },
	"mimo-v2.6-flash": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
	"mimo-v2.6-pro-ultraspeed": { cacheHit: 0.25, cacheMiss: 30, output: 60 },
	"mimo-v2.5-pro": { cacheHit: 0.025, cacheMiss: 3, output: 6 },
	"mimo-v2.5-pro-ultraspeed": { cacheHit: 0.075, cacheMiss: 9, output: 18 },
	"mimo-v2.5": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
};

// ---------------------------------------------------------------------------
// MiMo Token Plan 积分折算（Credits / 百万 tokens）
// 来源：https://mimo.mi.com/docs/zh-CN/price/token-plan（「额度消耗规则」）
//   mimo-v2.6-pro  ：缓存命中 2.5，缓存未命中 300，输出 600
//   mimo-v2.6-flash：缓存命中 2，  缓存未命中 100，输出 200
// 未登记型号落 Flash 档：按最低消耗估，宁可低估也不虚报进度。
// ---------------------------------------------------------------------------

const MIMO_CREDITS: Record<string, MimoPrice> = {
	"mimo-v2.6-pro": { cacheHit: 2.5, cacheMiss: 300, output: 600 },
	"mimo-v2.6-flash": { cacheHit: 2, cacheMiss: 100, output: 200 },
};

/**
 * MiMo Token Plan 单条消息的积分消耗。
 * 上游按 0.8x 夜间系数折算，这里只在请求确由 0.8x 窗口覆盖时同乘：
 * 接口回传的 used_credits 是实际扣减值，本地预估偏差只影响速率曲线形状，不影响余额绝对值。
 */
function mimoCreditCost(u: AssistantMessage["usage"], modelId: string, ts: number): number {
	const p = MIMO_CREDITS[mimoModelKey(modelId)] ?? MIMO_CREDITS["mimo-v2.6-flash"];
	const factor = isMimoOffpeakHour(ts) ? 0.8 : 1;
	return ((p.cacheMiss * u.input + p.cacheHit * u.cacheRead + p.output * u.output) / 1_000_000) * factor;
}

function mimoModelKey(modelId: string): string {
	const id = modelId.toLowerCase();
	// V2.6 与 V2.5 的 Flash/Pro 同价，但 UltraSpeed 档倍率不同（V2.6 = 10×Pro，V2.5 = 3×Pro），须分开
	const v26 = id.includes("2.6") || id.includes("2-6");
	if (id.includes("ultraspeed")) return v26 ? "mimo-v2.6-pro-ultraspeed" : "mimo-v2.5-pro-ultraspeed";
	if (id.includes("pro")) return v26 ? "mimo-v2.6-pro" : "mimo-v2.5-pro";
	return v26 ? "mimo-v2.6-flash" : "mimo-v2.5";
}

// ---------------------------------------------------------------------------
// Kimi 官方人民币定价（元 / 百万 tokens）
// 来源：https://platform.kimi.com/docs/pricing/chat
//   kimi-k3.1-pro  ：缓存命中 ¥1.30，缓存未命中 ¥13.00，输出 ¥68.00；缓存写入 5min ¥13.00、1h ¥26.00
//   kimi-k3.1-pro-highspeed：缓存命中 ¥1.30，缓存未命中 ¥26.00，输出 ¥136.00；缓存写入 5min ¥26.00、1h ¥52.00
//   kimi-k3          ：缓存命中 ¥2.00，缓存未命中 ¥20.00，输出 ¥100.00；
//                      另有缓存写入费（按 TTL 档）：5min ¥20.00、1h ¥40.00（不指定 TTL 默认 5min 档）
//   kimi-k2.7-code   ：缓存命中 ¥1.30，缓存未命中 ¥6.50， 输出 ¥27.00
//   kimi-k2.7-code-highspeed（高速版，官方模型 ID 同名）：缓存命中 ¥2.60，缓存未命中 ¥13.00，输出 ¥54.00（普通版 2 倍）
//   kimi-k2.6        ：缓存命中 ¥1.10，缓存未命中 ¥6.50， 输出 ¥27.00
// Kimi For Coding 订阅（provider `kimi-coding`）的模型 id 与开放平台不同名：
//   kimi-for-coding           = K2.8 Preview（2026-09 起该 id 原地换芯，1M 上下文）；无公开 API 单价，按 K2.7 Code 估算
//   kimi-for-coding-highspeed = K2.7 Code 高速版（未随换芯，256K 上下文），按高速版价（普通版 2 倍）
//   k3 / k3-256k              = K3；k3-256k 无单独公开价，按 K3 全价估算
// ---------------------------------------------------------------------------

interface KimiPrice {
	cacheHit: number; // 缓存命中输入（元/百万 tokens）
	cacheMiss: number; // 缓存未命中输入
	output: number; // 输出
	cacheWrite?: number; // 缓存写入（元/百万 tokens，仅 K3 系列计费；按 5min TTL 档，1h 档为其 2 倍）
}

export const KIMI_PRICES: Record<string, KimiPrice> = {
	"kimi-k3.1-pro": { cacheHit: 1.3, cacheMiss: 13.0, output: 68.0, cacheWrite: 13.0 },
	"kimi-k3.1-pro-highspeed": { cacheHit: 1.3, cacheMiss: 26.0, output: 136.0, cacheWrite: 26.0 },
	"kimi-k3": { cacheHit: 2.0, cacheMiss: 20.0, output: 100.0, cacheWrite: 20.0 },
	"kimi-k2.7-code": { cacheHit: 1.3, cacheMiss: 6.5, output: 27.0 },
	"kimi-k2.7-code-highspeed": { cacheHit: 2.6, cacheMiss: 13.0, output: 54.0 },
	"kimi-k2.6": { cacheHit: 1.1, cacheMiss: 6.5, output: 27.0 },
};

/** 模型 id → 定价键（未知 id 落 K2.7 Code：中间价位，避免低估）。新增模型需同步登记 KIMI_PRICES。 */
export function kimiModelKey(modelId: string): string {
	const id = modelId.toLowerCase();
	// 高速档关键词也可能不带 k2.7 前缀（如 kimi-for-coding-highspeed），故先统一识别
	const highspeed = id.includes("high") || id.includes("ultra") || id.includes("fast");
	if (id.includes("k3.1") || id.includes("k3-1")) return highspeed ? "kimi-k3.1-pro-highspeed" : "kimi-k3.1-pro";
	if (id.includes("k3")) return "kimi-k3";
	if (id.includes("k2.7") || id.includes("k2-7")) {
		return highspeed ? "kimi-k2.7-code-highspeed" : "kimi-k2.7-code";
	}
	if (id.includes("k2.6") || id.includes("k2-6")) return "kimi-k2.6";
	return highspeed ? "kimi-k2.7-code-highspeed" : "kimi-k2.7-code";
}

/**
 * Kimi 消耗成本（人民币元），按官方定价直算。
 * Kimi For Coding 订阅（kimi-for-coding = K2.8 Preview，无公开单价）按 K2.7 Code API 价估算等效消费。
 */
function kimiCostCny(u: AssistantMessage["usage"], modelId: string): number {
	const p = KIMI_PRICES[kimiModelKey(modelId)] ?? KIMI_PRICES["kimi-k2.7-code"];
	// K3 系列的缓存写入按 TTL 档单独计费（此处按默认 5min 档）；上游未上报 cacheWrite 时该项为 0
	return (
		(p.cacheMiss * u.input +
			p.cacheHit * u.cacheRead +
			p.output * u.output +
			(p.cacheWrite ?? 0) * u.cacheWrite) /
		1_000_000
	);
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
	const p = DEEPSEEK_PRICES[deepseekModelKey(modelId)] ?? DEEPSEEK_PRICES["deepseek-flash"];
	const peak = isDeepSeekPeakHour(ts) ? 2 : 1;
	return ((p.cacheMiss * u.input + p.cacheHit * u.cacheRead + p.output * u.output) * peak) / 1_000_000;
}

// ---------------------------------------------------------------------------
// OpenCode Go 官方 USD 计价（美元 / 百万 tokens）
// 来源：https://opencode.ai/v2/docs/console/go （各模型标价 + 月额度表）
//   额度机制：所有付费模型共用一份额度池（Go $60/月、Go Plus $240/月），每个模型的
//   「月额度」M 是这份池在该模型上的等值——用量占比 = Σ(标价花费 / M)，
//   故每 $1 标价消耗的额度当量 = 池 / M（Go：$60 档 ×1、$30 档 ×2、$15 档 ×4、$80 档 ×0.75）。
//   DeepSeek 系列：高峰 = 平峰 ×2。高峰时段 = 周一~周五 01:00-04:00 / 06:00-10:00 UTC
//     （即北京时间周一~周五 09:00-12:00 / 14:00-18:00），周末全天平峰。
//   分档价（≤/> 上下文阈值两档）只在有高低两档的模型上启用：按单条消息 token 总量判定。
// 表内 glm-5.1 / qwen3.7-max / qwen3.6-plus / minimax-m2.5 / kimi-k2.6 上游当前已不在 Go
// 模型列表（保留作回退，重新上架前数值不保证仍准）；glm-5.3-flashx 官方尚未上架，按 2.5×
// GLM-5.3-Flash 折算预留。未知模型落 kimi-k2.7-code（中间价位，避免低估额度消耗）。
// ---------------------------------------------------------------------------

interface GoPrice {
	cacheMiss: number; // 缓存未命中输入（USD/百万 tokens）
	cacheHit: number; // 缓存读取
	output: number; // 输出
	cacheWrite?: number; // 缓存写入（官方表中标 "-" 的模型不计）
	highTier?: {
		// 超过上下文阈值后的高价档（可选）
		threshold: number;
		cacheMiss: number;
		cacheHit: number;
		output: number;
		cacheWrite?: number;
	};
}

export const GO_PRICES: Record<string, GoPrice> = {
	"claude-haiku-5-5": {
		cacheMiss: 0.1,
		cacheHit: 0.01,
		output: 0.5,
		cacheWrite: 0.125,
		highTier: { threshold: 100_000, cacheMiss: 0.5, cacheHit: 0.05, output: 2.5, cacheWrite: 0.625 },
	},
	"gemini-4-argon-contributor": { cacheMiss: 4.0, cacheHit: 0.2, output: 20.0 },
	"grok-4.7": {
		cacheMiss: 2.0,
		cacheHit: 0.5,
		output: 6.0,
		highTier: { threshold: 200_000, cacheMiss: 4.0, cacheHit: 1.0, output: 12.0 },
	},
	"grok-4.6": {
		cacheMiss: 2.0,
		cacheHit: 0.5,
		output: 6.0,
		highTier: { threshold: 200_000, cacheMiss: 4.0, cacheHit: 1.0, output: 12.0 },
	},
	"gpt-6-luna": {
		cacheMiss: 0.1,
		cacheHit: 0.01,
		output: 0.5,
		cacheWrite: 0.125,
		highTier: { threshold: 272_000, cacheMiss: 0.2, cacheHit: 0.02, output: 0.75, cacheWrite: 0.25 },
	},
	"gpt-5.6-luna": {
		cacheMiss: 0.2,
		cacheHit: 0.02,
		output: 1.2,
		cacheWrite: 0.25,
		highTier: { threshold: 272_000, cacheMiss: 0.4, cacheHit: 0.04, output: 1.8, cacheWrite: 0.5 },
	},
	// GLM-5.3-FlashX：OpenCode Go 尚未上架，按官方 2.5× GLM-5.3-Flash 折算预留（上架后以官网价为准）
	"glm-5.3-flashx": { cacheMiss: 0.375, cacheHit: 0.075, output: 1.25 },
	"glm-5.3-flash": { cacheMiss: 0.15, cacheHit: 0.03, output: 0.5 },
	"glm-5.3": { cacheMiss: 1.4, cacheHit: 0.26, output: 4.4 },
	"glm-5.2": { cacheMiss: 1.4, cacheHit: 0.26, output: 4.4 },
	"glm-5.1": { cacheMiss: 1.4, cacheHit: 0.26, output: 4.4 },
	"kimi-k3.1-pro": { cacheMiss: 2.0, cacheHit: 0.2, output: 10.0, cacheWrite: 2.0 },
	"kimi-k3": { cacheMiss: 3.0, cacheHit: 0.3, output: 15.0, cacheWrite: 3.0 },
	"kimi-k2.7-code": { cacheMiss: 0.95, cacheHit: 0.19, output: 4.0 },
	"kimi-k2.6": { cacheMiss: 0.95, cacheHit: 0.16, output: 4.0 },
	"longcat-2.0": { cacheMiss: 0.3, cacheHit: 0.006, output: 1.2 },
	"mimo-v2.6-flash": { cacheMiss: 0.14, cacheHit: 0.0028, output: 0.28 },
	"mimo-v2.6-pro": { cacheMiss: 0.435, cacheHit: 0.003625, output: 0.87 },
	"mimo-v2.5": { cacheMiss: 0.14, cacheHit: 0.0028, output: 0.28 },
	"mimo-v2.5-pro": { cacheMiss: 0.435, cacheHit: 0.003625, output: 0.87 },
	"minimax-m3": { cacheMiss: 0.3, cacheHit: 0.06, output: 1.2 },
	"minimax-m2.7": { cacheMiss: 0.3, cacheHit: 0.06, output: 1.2, cacheWrite: 0.375 },
	"minimax-m2.5": { cacheMiss: 0.3, cacheHit: 0.06, output: 1.2, cacheWrite: 0.375 },
	"muse-spark-1.3-contributor": { cacheMiss: 0.1, cacheHit: 0.002, output: 0.2 },
	"muse-spark-1.2-contributor": { cacheMiss: 0.1, cacheHit: 0.002, output: 0.2 },
	"qwen3.8-max": { cacheMiss: 2.0, cacheHit: 0.25, output: 6.0, cacheWrite: 2.5 },
	"qwen3.8-flash": { cacheMiss: 0.15, cacheHit: 0.016, output: 0.47, cacheWrite: 0.2 },
	"qwen3.7-max": { cacheMiss: 2.5, cacheHit: 0.5, output: 7.5, cacheWrite: 3.125 },
	"qwen3.7-plus": {
		cacheMiss: 0.4,
		cacheHit: 0.04,
		output: 1.6,
		cacheWrite: 0.5,
		highTier: { threshold: 256_000, cacheMiss: 1.2, cacheHit: 0.12, output: 4.8, cacheWrite: 1.5 },
	},
	"qwen3.6-plus": {
		cacheMiss: 0.5,
		cacheHit: 0.05,
		output: 3.0,
		cacheWrite: 0.625,
		highTier: { threshold: 256_000, cacheMiss: 2.0, cacheHit: 0.2, output: 6.0, cacheWrite: 2.5 },
	},
	"deepseek-v4-pro": { cacheMiss: 0.66, cacheHit: 0.022, output: 1.98 },
	// V4.1 Flash 与旧 V4 Flash 同价：空闲 $0.15/$0.60/$0.003，高峰 ×2
	// 月额度：V4.1 Flash $80（Go）/ $160（Plus）；旧 V4 Flash $30、Vision Exp $15
	"deepseek-v4.1-flash": { cacheMiss: 0.15, cacheHit: 0.003, output: 0.6 },
	"deepseek-v4-flash": { cacheMiss: 0.15, cacheHit: 0.003, output: 0.6 },
	"deepseek-v4-flash-vision-exp": { cacheMiss: 0.15, cacheHit: 0.003, output: 0.6 },
	"step-5-preview": { cacheMiss: 1.0, cacheHit: 0.1, output: 2.7 },
	"space-bunny": { cacheMiss: 0.15, cacheHit: 0.03, output: 0.6 },
	"longcat-2.5-preview-free": { cacheMiss: 0, cacheHit: 0, output: 0 }, // 限时免费
	"hy4-preview": { cacheMiss: 0.834, cacheHit: 0.042, output: 2.501 },
	"hy3": { cacheMiss: 0.14, cacheHit: 0.035, output: 0.58 },
};

export function goModelKey(modelId: string): string {
	const id = modelId.toLowerCase();
	if (id.includes("grok-4.7") || id.includes("grok-4-7")) return "grok-4.7";
	if (id.includes("grok")) return "grok-4.6";
	if (id.includes("gpt-5.6")) return "gpt-5.6-luna";
	if (id.includes("gpt-6") || id.includes("6-luna") || id.includes("luna")) return "gpt-6-luna";
	if (id.includes("glm-5.3-flashx") || id.includes("glm-5.3-flash-x")) return "glm-5.3-flashx";
	if (id.includes("glm-5.3-flash")) return "glm-5.3-flash";
	if (id.includes("glm-5.3")) return "glm-5.3";
	if (id.includes("glm-5.2")) return "glm-5.2";
	if (id.includes("glm-5.1")) return "glm-5.1";
	if (id.includes("k3.1") || id.includes("k3-1")) return "kimi-k3.1-pro";
	if (id.includes("kimi-k3") || id.includes("k3")) return "kimi-k3";
	if (id.includes("k2.7") || id.includes("k2-7")) return "kimi-k2.7-code";
	if (id.includes("k2.6") || id.includes("k2-6")) return "kimi-k2.6";
	if (id.includes("longcat-2.5") || id.includes("longcat-2-5")) return "longcat-2.5-preview-free";
	if (id.includes("longcat")) return "longcat-2.0";
	if (id.includes("deepseek") && id.includes("vision")) return "deepseek-v4-flash-vision-exp";
	if (id.includes("deepseek") && id.includes("pro")) return "deepseek-v4-pro";
	if (id.includes("deepseek") && (id.includes("4.1") || id.includes("4-1"))) return "deepseek-v4.1-flash";
	if (id.includes("deepseek")) return "deepseek-v4-flash";
	if (id.includes("mimo")) {
		const v26 = id.includes("2.6") || id.includes("2-6");
		if (id.includes("pro")) return v26 ? "mimo-v2.6-pro" : "mimo-v2.5-pro";
		return v26 ? "mimo-v2.6-flash" : "mimo-v2.5";
	}
	if (id.includes("minimax-m3")) return "minimax-m3";
	if (id.includes("minimax-m2.5") || id.includes("minimax-m2-5")) return "minimax-m2.5";
	if (id.includes("minimax")) return "minimax-m2.7"; // M2.7 同价
	if (id.includes("muse") && id.includes("1.3")) return "muse-spark-1.3-contributor";
	if (id.includes("muse")) return "muse-spark-1.2-contributor";
	if (id.includes("bunny")) return "space-bunny";
	if (id.includes("qwen3.8-max")) return "qwen3.8-max";
	if (id.includes("qwen3.8-flash")) return "qwen3.8-flash";
	if (id.includes("qwen3.7-max")) return "qwen3.7-max";
	if (id.includes("qwen3.7")) return "qwen3.7-plus";
	if (id.includes("qwen3.6")) return "qwen3.6-plus";
	if (id.includes("qwen")) return "qwen3.6-plus"; // 其他 Qwen 兜底
	if (id.includes("hy4")) return "hy4-preview";
	if (id.includes("hy3")) return "hy3";
	if (id.includes("haiku")) return "claude-haiku-5-5";
	if (id.includes("gemini")) return "gemini-4-argon-contributor";
	if (id.includes("step-5") || id.includes("step5") || id.includes("step 5")) return "step-5-preview";
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
 * OpenCode Go 单条消息的标价花费（USD），按官方 token 价直算（不走 pi 的 USD 成本）。
 * - 有高低两档的模型按本条消息 token 总量（input+output+cacheRead+cacheWrite）判定档位
 * - DeepSeek 系列高峰 ×2（周末/平峰保持平峰价）
 */
function goListCostUsd(u: AssistantMessage["usage"], modelId: string, ts: number): number {
	const key = goModelKey(modelId);
	const p = GO_PRICES[key] ?? GO_PRICES["kimi-k2.7-code"];
	const total = u.input + u.output + u.cacheRead + u.cacheWrite;
	const hi = p.highTier && total > p.highTier.threshold ? p.highTier : null;
	const miss = hi?.cacheMiss ?? p.cacheMiss;
	const hit = hi?.cacheHit ?? p.cacheHit;
	const out = hi?.output ?? p.output;
	const write = hi?.cacheWrite ?? p.cacheWrite ?? 0;
	const peak = key.startsWith("deepseek") && isGoPeakHour(ts) ? 2 : 1;
	return ((miss * u.input + hit * u.cacheRead + out * u.output + write * u.cacheWrite) * peak) / 1_000_000;
}

/**
 * 各模型月额度（USD，Go 档）：同一份池在该模型上的等值，不是独立预算。
 * 数值即官方 per-model 表 "Monthly limit"；已下架型号保留旧值作回退。
 */
export const GO_ALLOWANCE: Record<string, number> = {
	"claude-haiku-5-5": 15,
	"gemini-4-argon-contributor": 60,
	"grok-4.7": 15,
	"grok-4.6": 15,
	"gpt-6-luna": 15,
	"gpt-5.6-luna": 15,
	"glm-5.3-flashx": 60,
	"glm-5.3-flash": 60,
	"glm-5.3": 15,
	"glm-5.2": 60,
	"glm-5.1": 60,
	"kimi-k3.1-pro": 15,
	"kimi-k3": 15,
	"kimi-k2.7-code": 60,
	"kimi-k2.6": 60,
	"longcat-2.0": 60,
	"mimo-v2.6-flash": 60,
	"mimo-v2.6-pro": 15,
	"mimo-v2.5": 60,
	"mimo-v2.5-pro": 15,
	"minimax-m3": 60,
	"minimax-m2.7": 60,
	"minimax-m2.5": 60,
	"muse-spark-1.3-contributor": 60,
	"muse-spark-1.2-contributor": 60,
	"qwen3.8-max": 15,
	"qwen3.8-flash": 30,
	"qwen3.7-max": 15,
	"qwen3.7-plus": 60,
	"qwen3.6-plus": 60,
	"deepseek-v4-pro": 15,
	"deepseek-v4.1-flash": 80,
	"deepseek-v4-flash": 30,
	"deepseek-v4-flash-vision-exp": 15,
	"step-5-preview": 60,
	"space-bunny": 30,
	"longcat-2.5-preview-free": Number.POSITIVE_INFINITY,
	"hy4-preview": 30,
	"hy3": 60,
};

/** 各模型月额度（USD，Go Plus 档）。 */
export const GO_ALLOWANCE_PLUS: Record<string, number> = {
	"claude-haiku-5-5": 60,
	"gemini-4-argon-contributor": 240,
	"grok-4.7": 60,
	"grok-4.6": 60,
	"gpt-6-luna": 60,
	"gpt-5.6-luna": 60,
	"glm-5.3-flashx": 180,
	"glm-5.3-flash": 180,
	"glm-5.3": 120,
	"glm-5.2": 180,
	"glm-5.1": 180,
	"kimi-k3.1-pro": 60,
	"kimi-k3": 60,
	"kimi-k2.7-code": 180,
	"kimi-k2.6": 180,
	"longcat-2.0": 240,
	"mimo-v2.6-flash": 120,
	"mimo-v2.6-pro": 60,
	"mimo-v2.5": 120,
	"mimo-v2.5-pro": 60,
	"minimax-m3": 180,
	"minimax-m2.7": 180,
	"minimax-m2.5": 180,
	"muse-spark-1.3-contributor": 120,
	"muse-spark-1.2-contributor": 120,
	"qwen3.8-max": 60,
	"qwen3.8-flash": 90,
	"qwen3.7-max": 60,
	"qwen3.7-plus": 180,
	"qwen3.6-plus": 180,
	"deepseek-v4-pro": 60,
	"deepseek-v4.1-flash": 160,
	"deepseek-v4-flash": 120,
	"deepseek-v4-flash-vision-exp": 60,
	"step-5-preview": 240,
	"space-bunny": 120,
	"longcat-2.5-preview-free": Number.POSITIVE_INFINITY,
	"hy4-preview": 120,
	"hy3": 240,
};

export type GoPlan = "go" | "plus";

const GO_FALLBACK_KEY = "kimi-k2.7-code"; // 与 goModelKey 的兜底价同档（权重 ×1）
const GO_POOL_USD: Record<GoPlan, number> = { go: 60, plus: 240 };
/** Go / Go Plus 月费（USD）：渠道折扣系数 = 月费 / 月额度（Go、Plus 都是 1/6）。 */
const GO_PRICE_USD: Record<GoPlan, number> = { go: 10, plus: 40 };
let goPlan: GoPlan = "go";
let goPlanDetected = false;

/** 档位由余额适配器探测后写入；未探测时按 Go 档。 */
export function setGoPlan(plan: GoPlan): void {
	goPlan = plan;
	goPlanDetected = true;
}

export function getGoPlan(): GoPlan {
	return goPlan;
}

export function isGoPlanDetected(): boolean {
	return goPlanDetected;
}

export function goPool(plan: GoPlan = goPlan): number {
	return GO_POOL_USD[plan];
}

export function goAllowance(key: string, plan: GoPlan = goPlan): number {
	const table = plan === "plus" ? GO_ALLOWANCE_PLUS : GO_ALLOWANCE;
	return table[key] ?? table[GO_FALLBACK_KEY];
}

/** 每 $1 标价消耗的额度当量（Go：$15 档 4、$60 档 1、$80 档 0.75）。 */
export function goWeight(key: string, plan: GoPlan = goPlan): number {
	const m = goAllowance(key, plan);
	return Number.isFinite(m) && m > 0 ? goPool(plan) / m : 0;
}

/**
 * GLM Coding Plan（国内版）档位：月费与周积分上限。
 * 来源：https://docs.bigmodel.cn/cn/coding-plan/overview（2026-09 调价）。
 */
const GLM_PLANS = {
	lite: { priceCny: 118, weekCredits: 10_000 },
	pro: { priceCny: 538, weekCredits: 60_000 },
	max: { priceCny: 1078, weekCredits: 140_000 },
} as const;

export type GlmTier = keyof typeof GLM_PLANS;

let glmTier: GlmTier | null = null;

/** 从 quota/limit 响应识别 GLM 档位：优先级 level 字段 → 周/5h 积分上限（1万/6万/14万）。 */
export function detectGlmTier(data: ZaiQuotaResponse): GlmTier | null {
	const level = String(data.data?.level ?? "").toLowerCase();
	if (level === "lite" || level === "pro" || level === "max") {
		glmTier = level;
		return glmTier;
	}
	const caps = (data.data?.limits ?? [])
		.filter(zaiIsCreditWindow)
		.map((l) => l.usage)
		.filter((n): n is number => typeof n === "number" && n > 0);
	for (const name of Object.keys(GLM_PLANS) as GlmTier[]) {
		const plan = GLM_PLANS[name];
		const hit = caps.some(
			(cap) =>
				Math.abs(cap - plan.weekCredits) <= plan.weekCredits * 0.02 ||
				Math.abs(cap - plan.weekCredits * 0.2) <= plan.weekCredits * 0.02,
		);
		if (hit) {
			glmTier = name;
			break;
		}
	}
	return glmTier;
}

export function getGlmTier(): GlmTier | null {
	return glmTier;
}

/** 测试/调试用：直接指定档位。 */
export function setGlmTier(tier: GlmTier | null): void {
	glmTier = tier;
}

/** GLM 积分抵扣系数（每 token ×10000）：GLM-5.3 / GLM-5.3-Flash。 */
const GLM_CREDIT_COEF = {
	glm53: { input: 6.9, cached: 1.7, output: 24 },
	flash: { input: 2.3, cached: 0.56, output: 8 },
} as const;

/** GLM 高峰时段：周一~周五 14:00–18:00（UTC+8）；其余时段积分消耗 ×0.5。 */
export function isGlmPeakHour(ts: number): boolean {
	const bj = new Date(ts + 8 * 3_600_000);
	const day = bj.getUTCDay();
	if (day === 0 || day === 6) return false;
	const hour = bj.getUTCHours();
	return hour >= 14 && hour < 18;
}

/** GLM 套餐生效价：按档位积分单价 × 抵扣系数（非高峰 ×0.5）折算每百万 token 的人民币价。 */
function glmPlanRates(m: PriceableModel, now: number): BlendRates | null {
	if (!glmTier) return null;
	const key = zaiModelKey(m.id ?? "");
	if (!key) return null;
	const plan = GLM_PLANS[glmTier];
	const cnyPerCredit = plan.priceCny / (plan.weekCredits * (52 / 12)); // 月积分 ≈ 周积分 × 52/12
	const coef = key.includes("flash") ? GLM_CREDIT_COEF.flash : GLM_CREDIT_COEF.glm53;
	const factor = cnyPerCredit * 100 * (isGlmPeakHour(now) ? 1 : 0.5); // ×100：积分/百万 token
	return {
		cacheHit: coef.cached * factor,
		cacheMiss: coef.input * factor,
		output: coef.output * factor,
	};
}

/**
 * 相对价基准：DeepSeek V4.1 Flash 官方高峰价（¥/百万 tokens）。
 * 硬编码，不跟随模型目录或价格表更新（基准变了所有历史倍率就没法比）。
 */
const PRICE_BASELINE_CNY = { cacheHit: 0.04, cacheMiss: 2, output: 8 };

/** 典型 agent 用量结构：缓存命中 : 缓存未命中 : 输出 = 340 : 6 : 1（约 98% 走缓存）。 */
const PRICE_BLEND = { cacheHit: 340, cacheMiss: 6, output: 1 } as const;

const PRICE_BASELINE = blendRates(PRICE_BASELINE_CNY);

interface BlendRates {
	cacheHit: number;
	cacheMiss: number;
	output: number;
}

function blendRates(p: BlendRates): number {
	return p.cacheHit * PRICE_BLEND.cacheHit + p.cacheMiss * PRICE_BLEND.cacheMiss + p.output * PRICE_BLEND.output;
}

/** 模型相对价所需字段（pi 的 Model 结构直接可用） */
export interface PriceableModel {
	provider?: string;
	id?: string;
	cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
}

/** 按通道取该模型每百万 token 的人民币价格（缓存命中/未命中/输出）及是否用了通道实价。 */
function channelRatesCny(m: PriceableModel, usdCny: number, now: number): BlendRates | null {
	const provider = m.provider ?? "";
	const id = m.id ?? "";
	if (provider === "opencode-go") {
		const key = goModelKey(id);
		const p = GO_PRICES[key] ?? GO_PRICES["kimi-k2.7-code"];
		const allowance = goAllowance(key);
		if (!(usdCny > 0) || !Number.isFinite(allowance) || allowance <= 0) return null;
		// 渠道折扣：月费 / 该模型月额度（每 $1 额度实付）；DeepSeek 系列按时段峰谷
		const peak = key.startsWith("deepseek") && isGoPeakHour(now) ? 2 : 1;
		const k = usdCny * peak * (GO_PRICE_USD[goPlan] / allowance);
		return { cacheHit: p.cacheHit * k, cacheMiss: p.cacheMiss * k, output: p.output * k };
	}
	if (provider === "deepseek") {
		const p = DEEPSEEK_PRICES[deepseekModelKey(id)] ?? DEEPSEEK_PRICES["deepseek-flash"];
		const peak = isDeepSeekPeakHour(now) ? 2 : 1;
		return { cacheHit: p.cacheHit * peak, cacheMiss: p.cacheMiss * peak, output: p.output * peak };
	}
	if (provider === "xiaomi" || provider.startsWith("xiaomi-token-plan-")) {
		const p = MIMO_PRICES[mimoModelKey(id)] ?? MIMO_PRICES["mimo-v2.5"];
		return { cacheHit: p.cacheHit, cacheMiss: p.cacheMiss, output: p.output };
	}
	if (provider === "kimi-coding" || provider === "moonshotai" || provider === "moonshotai-cn") {
		const p = KIMI_PRICES[kimiModelKey(id)] ?? KIMI_PRICES["kimi-k2.7-code"];
		return { cacheHit: p.cacheHit, cacheMiss: p.cacheMiss, output: p.output };
	}
	if (provider === "zai-coding-cn") {
		const planRates = glmPlanRates(m, now);
		if (planRates) return planRates;
		const key = zaiModelKey(id);
		const p = key ? ZAI_PRICES[key] : undefined;
		// 档位未识别时只有标价（未打折）
		if (p) return { cacheHit: p.cacheHit, cacheMiss: p.input, output: p.output };
	}
	// 其余走 pi 目录价（USD/百万 tokens，按实时汇率折人民币）
	const c = m.cost;
	if (!c || c.input < 0 || c.output < 0 || !(usdCny > 0)) return null;
	return {
		cacheHit: (c.cacheRead ?? 0) * usdCny,
		cacheMiss: c.input * usdCny,
		output: c.output * usdCny,
	};
}

/**
 * 模型相对价（以 DS V4.1 Flash 高峰价为 1.0）——越大越贵，所有通道通用。
 * Plan 渠道按「官方定价 ÷ 套餐额度」折算生效价（Go 1/6；GLM 按档位积分价；
 * 汇率与时段（峰谷/非高峰半价）实时参与）；无汇率（仅美元通道）或模型无价目时返回 null。
 */
export function modelPriceIndex(
	m: PriceableModel,
	usdCny: number | null = getUsdCnyRate(),
	now = Date.now(),
): number | null {
	const rates = channelRatesCny(m, usdCny ?? 0, now);
	if (!rates) return null;
	const ratio = blendRates(rates) / PRICE_BASELINE;
	return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/** 单条消息的额度消耗（额度当量 USD）= 标价 × 权重。 */
export function goQuotaUsd(u: AssistantMessage["usage"], modelId: string, ts: number): number {
	return goListCostUsd(u, modelId, ts) * goWeight(goModelKey(modelId));
}

// ---------------------------------------------------------------------------
// Z.AI 国内（open.bigmodel.cn）官方人民币定价（元/百万 tokens）
// 来源：https://docs.bigmodel.cn/cn/guide/start/pricing（缓存存储列官方标「限时免费」，不计）
//   国际站 api.z.ai 的同款 GLM 是 USD 价目（pi 目录里 zai / zai-coding-cn 的 cost 即该口径），
//   两站价差明显，故只给国内通道套本表；国际通道仍用 pi 目录价。
//   高速档：pi 目录 id 为 glm-5.3-highspeed / glm-5.2-highspeed 且三项价格写 0；国内在售的对应
//   型号是 GLM-5.3-FlashX（2/7），5.2 高速档国内未上架，按旗舰价 1/4 折算预留。
// 用途：zai-coding-cn 的成本轨（颜色信号与累计）。该通道按订阅积分计费，积分只反映额度消耗，
//   价格信号得用真实单价，否则高速档会恒显示 0 成本、恒绿灯。
// ---------------------------------------------------------------------------

interface ZaiPrice {
	input: number; // 输入（缓存未命中）
	cacheHit: number; // 缓存命中
	output: number;
	highTier?: {
		// 官方分档按单次请求的提示长度（输入 + 缓存命中）判定
		threshold: number;
		input: number;
		cacheHit: number;
		output: number;
	};
}

export const ZAI_PRICES: Record<string, ZaiPrice> = {
	"glm-5.3": { input: 8, cacheHit: 2, output: 28 },
	"glm-5.3-flash": { input: 0.8, cacheHit: 0.23, output: 2.8 },
	"glm-5.3-highspeed": { input: 2, cacheHit: 0.57, output: 7 }, // 国内在售名：GLM-5.3-FlashX
	"glm-5.2": { input: 8, cacheHit: 2, output: 28 },
	"glm-5.2-highspeed": { input: 2, cacheHit: 0.57, output: 7 }, // 国内未上架，按旗舰 1/4 折算预留
	"glm-4.6v": {
		input: 1,
		cacheHit: 0.2,
		output: 3,
		highTier: { threshold: 32_768, input: 2, cacheHit: 0.4, output: 6 },
	},
};

/** 模型 id → ZAI_PRICES 键；未登记型号返回 null（调用方回落 pi 目录价） */
export function zaiModelKey(id: string): string | null {
	const s = id.toLowerCase();
	if (s.includes("glm-5.3-highspeed") || s.includes("glm-5.3-flashx")) return "glm-5.3-highspeed";
	if (s.includes("glm-5.3-flash")) return "glm-5.3-flash";
	if (s.includes("glm-5.3")) return "glm-5.3";
	if (s.includes("glm-5.2-highspeed") || s.includes("glm-5.2-flashx")) return "glm-5.2-highspeed";
	if (s.includes("glm-5.2")) return "glm-5.2";
	if (s.includes("glm-4.6v")) return "glm-4.6v";
	return null;
}

/** Z.AI 国内单条消息成本（元）；未登记型号返回 null，由调用方回落 pi 目录价 */
function zaiCostCny(u: AssistantMessage["usage"], modelId: string): number | null {
	const key = zaiModelKey(modelId);
	const p = key ? ZAI_PRICES[key] : undefined;
	if (!p) return null;
	const promptTokens = u.input + u.cacheRead;
	const tier = p.highTier && promptTokens > p.highTier.threshold ? p.highTier : p;
	return (tier.input * u.input + tier.cacheHit * u.cacheRead + tier.output * u.output) / 1_000_000;
}

/**
 * 单条 assistant 消息的消耗成本（原始货币，双轨）：
 * - DeepSeek / Kimi（含 Kimi For Coding）/ MiMo → { cny }：官方人民币定价直算，永不依赖汇率
 * - OpenCode Go → { usd }：额度当量（标价 × 池/月额度，见 goQuotaUsd）
 * - 其余供应商 → { usd }：pi 原始 USD 成本
 */
function msgCost(m: AssistantMessage): MsgCost {
	if (m.provider === "deepseek") return { cny: deepseekCostCny(m.usage, m.model, m.timestamp) };
	if (m.provider === "xiaomi") return { cny: mimoCostCny(m.usage, m.model) };
	if (m.provider.startsWith("xiaomi-token-plan-")) return { cr: mimoCreditCost(m.usage, m.model, m.timestamp) };
	if (
		m.provider === "kimi-coding" ||
		m.provider === "moonshotai" ||
		m.provider === "moonshotai-cn"
	) {
		return { cny: kimiCostCny(m.usage, m.model) };
	}
	if (m.provider === "opencode-go") return { usd: goQuotaUsd(m.usage, m.model, m.timestamp) };
	if (m.provider === "zai-coding-cn") {
		const cny = zaiCostCny(m.usage, m.model);
		if (cny !== null) return { cny };
	}
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
		const { cny: cnyPerMin, usd: usdPerMin } = computeRate(now);
		// 价格信号优先用人民币轨（ZAI_PRICES 直算），无人民币事件时回落 USD × 汇率
		const color =
			cnyPerMin !== null && cnyPerMin > 0
				? rateColor(cnyPerMin, true)
				: usdCnyRate !== null && usdCnyRate > 0
					? rateColor((usdPerMin ?? 0) * usdCnyRate, true)
					: rateColor(usdPerMin ?? 0, false);
		return [
			{ text: `${CREDIT_SYMBOL}${perMin.toFixed(2)}/min`, color },
			{ text: `${CREDIT_SYMBOL}${fmtNum(zaiCreditSessionTotal)}`, color: "dim" },
		];
	}
	// 人民币直算供应商：DeepSeek、MiMo 按量、Kimi（含 Kimi For Coding / 开放平台）
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
	// MiMo Token Plan：积分轨（积分 = 独立货币、不换算 ¥/$），与 Z.AI 同口径。
	// 数字与颜色解耦：颜色按人民币轨（MIMO_PRICES 直算）判断「贵不贵」
	if (ctx.model?.provider?.startsWith("xiaomi-token-plan-")) {
		const perMinCr = computeRate(now).cr ?? 0;
		const perMinCny = computeRate(now).cny ?? 0;
		return [
			{ text: `${CREDIT_SYMBOL}${fmtNum(Math.round(perMinCr))}/min`, color: rateColor(perMinCny, true) },
			{ text: `${CREDIT_SYMBOL}${fmtNum(Math.round(t.costTotalCr))}`, color: "dim" },
		];
	}
	// OpenCode Go：数字是额度当量（标价 × 池/月额度），不是真花钱，不换算成人民币
	if (ctx.model?.provider === "opencode-go") {
		const perMinUsd = computeRate(now).usd ?? 0;
		return [
			{ text: `$${perMinUsd.toFixed(3)}/min`, color: rateColor(perMinUsd, false) },
			{ text: `$${t.costTotalUsd.toFixed(2)}`, color: "dim" },
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
