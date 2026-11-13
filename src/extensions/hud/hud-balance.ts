/**
 * hud-balance：HUD 供应商余额适配层（hud 多文件扩展的组成部分，仅被 hud/index.ts import）
 *
 * 职责：
 * - 统一 BalanceData/BalanceAdapter 接口，按供应商逐一适配（按量充值余额 vs 订阅 plan 余量 vs 订阅+加油包）
 * - 已适配：deepseek / kimi-coding / moonshotai / moonshotai-cn / xiaomi / xiaomi-token-plan-{cn,sgp,ams} / openrouter / volcengine-coding / sensenova / opencode-go / zai-coding-cn
 * - 消耗统计文本（rateText）复用 hud-cost 的按量付费实现（¥/min 或 $/min；zai-coding-cn 走积分轨，积分不换算 ¥/$）
 *
 * 窗口展示约定：多窗口额度条（quotas）统一按窗口周期**从大到小**排列（月 > 周 > 5h，
 * 与 Kimi 的「周 · 5h」风格一致）；detail 明细随 windows 数组同序，天然一致。
 *
 * 注意：本模块不注册任何 pi API，仅导出接口与注册表，由入口模块驱动。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CREDIT_SYMBOL,
	currencySymbol,
	detectGlmTier,
	fmtNum,
	getRateSource,
	getUsdCnyRate,
	goAllowance,
	goModelKey,
	goPool,
	isGoPlanDetected,
	meteredRateText,
	sampleZaiCredits,
	setGoPlan,
	sumSessionUsage,
	ZAI_QUOTA_URL,
	zai5hWindow,
	zaiWindowUsedCredits,
	type RateTextPart,
	type ZaiQuotaResponse,
	type ZaiTokenLimit,
} from "./hud-cost";
import { fmtAmount } from "../shared/ui";

// ---------------------------------------------------------------------------
// 供应商余额适配层
// ---------------------------------------------------------------------------

export type BalanceStatus = "ok" | "warning" | "error";

/** 上游额字段多为字符串（部分带千分位），统一转数字；非法值归零 */
const toNum = (v: unknown): number => {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
	return Number.isFinite(n) ? n : 0;
};

export interface BalanceQuota {
	label: string;
	used: number;
	limit: number;
	/** 百分比小数位数（缺省 0）；大额度（如年卡）需要更细的刻度时显式给 */
	pctDecimals?: number;
	/** 币种（如 "USD"）：有值则进度条旁显示金额用量 `Key USD 0.1/1.0`，缺省显示百分比 */
	currency?: string;
	/** 额度窗口重置倒计时（可选），如 "2时34分"、"3天" */
	reset?: string;
}

export interface BalanceLink {
	/** 跳转目标 URL */
	url: string;
	/** 超链接显示文本（缺省用「点击跳转官方查询页面」，渲染层兜底） */
	text?: string;
}

export interface BalanceData {
	status: BalanceStatus;
	/** 行首标签（「余额」「额度」「余量查询」…）：缺省不印，要什么由适配器自己给 */
	label?: string;
	/** 主金额，如 "CNY 110.00"；没有数字的供应商（只贴链接）不填 */
	amount?: string;
	/** 明细，如 "充值 100.00 · 赠送 10.00" */
	detail?: string;
	/** 多维度额度条（如 Kimi 的周额度 + 5 小时滚动窗口） */
	quotas?: BalanceQuota[];
	/** 带额度条时同时显示金额（缺省不显示：额度条已经表达了主信息） */
	showAmountWithQuotas?: boolean;
	/**
	 * 查询链接：无公开余额 API 的供应商（订阅 plan 等）贴控制台查询页。
	 * 渲染层用 OSC 8 超链接短文本展示（避免长 URL 显示不全），完整 URL 走 /balance notify。
	 */
	link?: BalanceLink;
}

export interface BalanceAdapter {
	providerId: string;
	/** 展示名，如 "DeepSeek" */
	label: string;
	/** 获取余额数据；抛错视为获取失败 */
	fetch(ctx: ExtensionContext): Promise<BalanceData>;
	/**
	 * HUD 右下角消耗统计（按 provider 单独适配）。
	 * 返回片段数组，渲染层拼接显示；返回 null 则不显示。
	 * 按量付费显示 ¥/min + 累计；订阅制可显示 token 消耗。
	 */
	rateText?(ctx: ExtensionContext, now: number): RateTextPart[] | null;
}

/**
 * DeepSeek：按量付费，无 plan。
 * 官方接口 GET https://api.deepseek.com/user/balance（Bearer 认证），
 * 返回 balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }]。
 */
const deepseekAdapter: BalanceAdapter = {
	providerId: "deepseek",
	label: "DeepSeek",
	rateText: meteredRateText,
	async fetch(ctx) {
		const key = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
		if (!key) throw new Error("未配置 API key");

		const res = await fetch("https://api.deepseek.com/user/balance", {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const data = (await res.json()) as {
			is_available?: boolean;
			balance_infos?: {
				currency?: string;
				total_balance?: string;
				granted_balance?: string;
				topped_up_balance?: string;
			}[];
		};
		const info = data.balance_infos?.[0];
		if (!info?.total_balance) throw new Error("响应缺少 balance_infos");

		const total = parseFloat(info.total_balance) || 0;
		const granted = parseFloat(info.granted_balance || "0") || 0;
		const topped = parseFloat(info.topped_up_balance || "0") || 0;
		const currency = info.currency || "CNY";

		// 账户被禁用（如欠费）→ warning；余额过低 → error/warning
		const status: BalanceStatus =
			data.is_available === false ? "warning" : total <= 1 ? "error" : total < 5 ? "warning" : "ok";

		return {
			status,
			label: "余额",
			// 精简格式：主金额 = 充值余额，赠送以 “+ X.XX” 追加（无赠送则省略）
			amount: `${currency} ${topped.toFixed(2)}`,
			detail: granted > 0 ? `+ ${granted.toFixed(2)}` : undefined,
		};
	},
};

/**
 * Kimi For Coding：订阅制 + 加油包（Extra Usage）混合计费。
 * 官方接口 GET https://api.kimi.com/coding/v1/usages（Bearer 认证），
 * 返回订阅额度（usage/limits）和加油包余额（booster_wallet）。
 */
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_FIXED_POINT_CENTS = 1_000_000; // 加油包金额固定点：1e6 单位 = 1 分

interface KimiUsageWindow {
	duration?: number;
	timeUnit?: "TIME_UNIT_MINUTE" | "TIME_UNIT_HOUR" | "TIME_UNIT_DAY" | "TIME_UNIT_WEEK" | string;
}

interface KimiUsageRow {
	used?: number;
	/** 部分窗口只给剩余量（limit + remaining，无 used），需自行相减 */
	remaining?: number;
	limit?: number;
	name?: string;
	resetTime?: string;
	window?: KimiUsageWindow;
}

interface KimiBoosterWallet {
	/** STATUS_DISABLED = 未开通/已停用加油包，不当作可用余额展示 */
	status?: string;
	balance?: {
		type?: string;
		amount?: number;
		amountLeft?: number;
	};
	monthlyChargeLimit?: { priceInCents: number; currency: string };
	monthlyUsed?: { priceInCents: number; currency: string };
	monthlyChargeLimitEnabled?: boolean;
}

interface KimiUsagePayload {
	usage?: KimiUsageRow;
	limits?: Array<{
		name?: string;
		window?: KimiUsageWindow;
		detail?: KimiUsageRow;
	}>;
	/** 上游实际返回 snake_case；camelCase 为历史字段，兼容保留 */
	booster_wallet?: KimiBoosterWallet;
	boosterWallet?: KimiBoosterWallet;
}

function toInt(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
	if (typeof value === "string") {
		const n = Number(value);
		return Number.isFinite(n) ? Math.trunc(n) : null;
	}
	return null;
}

function fixedPointToCents(value: number): number {
	const cents = value / KIMI_FIXED_POINT_CENTS;
	if (cents > 0 && cents < 1) return 1;
	return Math.round(cents);
}

function formatMoney(cents: number, currency: string): string {
	const amount = (cents / 100).toFixed(2);
	return currency === "CNY" || currency === "" ? `CNY ${amount}` : `${currency} ${amount}`;
}

function formatWindow(window?: KimiUsageWindow): string {
	const duration = toInt(window?.duration);
	if (duration === null) return "";
	switch (window?.timeUnit) {
		case "TIME_UNIT_MINUTE":
			return `${duration}min`;
		case "TIME_UNIT_HOUR":
			return `${duration}h`;
		case "TIME_UNIT_DAY":
			return `${duration}d`;
		case "TIME_UNIT_WEEK":
			return duration === 1 ? "周" : `${duration}周`;
		default:
			return "";
	}
}

function formatWindowShort(window?: KimiUsageWindow): string {
	const duration = toInt(window?.duration);
	if (duration === null) return "";
	if (window?.timeUnit === "TIME_UNIT_MINUTE" && duration >= 60 && duration % 60 === 0) {
		return `${duration / 60}h`;
	}
	return formatWindow(window);
}

/** 行已用量：优先 used，否则由 limit − remaining 推得（部分窗口只回传剩余量）。 */
function rowUsed(row: KimiUsageRow): number {
	const used = toInt(row.used);
	if (used !== null) return used;
	const limit = toInt(row.limit);
	const remaining = toInt(row.remaining);
	if (limit !== null && remaining !== null) return Math.max(0, limit - remaining);
	return 0;
}

function formatUsageRow(row: KimiUsageRow): string {
	const name = row.name && row.name.length > 0 ? row.name : formatWindowShort(row.window);
	const limit = toInt(row.limit) ?? 0;
	const label = name || "额度";
	return `${label} ${rowUsed(row)}/${limit}`;
}

function rowLabel(row: KimiUsageRow): string {
	return (row.name && row.name.length > 0 ? row.name : formatWindowShort(row.window)) || "额度";
}

const kimiCodingAdapter: BalanceAdapter = {
	providerId: "kimi-coding",
	label: "Kimi For Coding",
	// 订阅制：按 K2.7 Code API 价估算等效消费（kimi-for-coding 现为 K2.8 Preview，无公开价）；¥/min + ¥累计
	rateText(ctx, now) {
		return meteredRateText(ctx, now);
	},
	async fetch(ctx) {
		const auth = await ctx.modelRegistry.getProviderAuth("kimi-coding");
		// API key 登录：auth.apiKey；OAuth 登录：auth.headers.Authorization = "Bearer <token>"
		const key = auth?.auth.apiKey ?? auth?.auth.headers?.Authorization?.replace(/^Bearer\s+/i, "");
		if (!key) throw new Error("未配置 API key 或 OAuth（请完成认证或执行 /login）");

		const res = await fetch(`${KIMI_CODING_BASE_URL}/usages`, {
			headers: {
				Authorization: `Bearer ${key}`,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
		}

		const data = (await res.json()) as KimiUsagePayload;

		// 主订阅额度：默认按周刷新
		let summary: KimiUsageRow | null = null;
		if (data.usage) {
			summary = {
				...data.usage,
				window: data.usage.window ?? { duration: 1, timeUnit: "TIME_UNIT_WEEK" },
			};
		}

		// 附加频限窗口（如 5 小时滚动窗口）
		const limits: KimiUsageRow[] = [];
		for (const item of data.limits ?? []) {
			if (item.detail) {
				limits.push({
					...item.detail,
					name: item.detail.name ?? item.name,
					window: item.detail.window ?? item.window,
				});
			}
		}

		// 加油包余额（可选）：上游字段为 booster_wallet；balance.status 非 ACTIVE（如 STATUS_DISABLED）
		// 或不再回传 amount/amountLeft 时视为无可用加油包，回落展示订阅额度
		let boosterCents: number | null = null;
		let boosterTotalCents: number | null = null;
		let boosterCurrency = "CNY";
		const booster = data.booster_wallet ?? data.boosterWallet;
		if (booster?.balance?.type === "BOOSTER" && booster.status !== "STATUS_DISABLED") {
			const amount = toInt(booster.balance.amount);
			const amountLeft = toInt(booster.balance.amountLeft);
			if (amount !== null && amount > 0) {
				boosterTotalCents = fixedPointToCents(amount);
				boosterCents = amountLeft !== null ? fixedPointToCents(amountLeft) : 0;
			}
			boosterCurrency =
				booster.monthlyChargeLimit?.currency ||
				booster.monthlyUsed?.currency ||
				"CNY";
		}

		// 状态判断：订阅额度耗尽 → error；额度/余额偏低 → warning
		let status: BalanceStatus = "ok";
		const summaryLimit = toInt(summary?.limit) ?? 0;
		const summaryUsed = summary ? rowUsed(summary) : 0;
		if (summaryLimit > 0) {
			const ratio = summaryUsed / summaryLimit;
			if (ratio >= 1) status = "error";
			else if (ratio >= 0.8) status = "warning";
		}
		if (boosterCents !== null && boosterTotalCents !== null && boosterTotalCents > 0) {
			if (boosterCents < 100) status = "error";
			else if (boosterCents / boosterTotalCents < 0.2) status = "warning";
		}

		// 主显示：优先展示加油包余额，没有则展示订阅额度
		const amount =
			boosterCents !== null
				? formatMoney(boosterCents, boosterCurrency)
				: summary
					? formatUsageRow(summary)
					: "-";

		// 明细：订阅额度 + 附加频限（文字版，兜底）
		const detailParts: string[] = [];
		if (boosterCents !== null && summary) {
			detailParts.push(`订阅 ${formatUsageRow(summary)}`);
		}
		for (const limit of limits) {
			detailParts.push(formatUsageRow(limit));
		}

		// 额度条：周额度 + 附加频限窗口，用于渲染进度条
		const quotas: BalanceQuota[] = [];
		if (summary) {
			quotas.push({ label: rowLabel(summary), used: rowUsed(summary), limit: toInt(summary.limit) ?? 0 });
		}
		for (const limit of limits) {
			quotas.push({ label: rowLabel(limit), used: rowUsed(limit), limit: toInt(limit.limit) ?? 0 });
		}

		return {
			status,
			// 订阅制为主、加油包偶有：主信息是订阅额度，不叫余额
			label: "额度",
			amount,
			detail: detailParts.join(" · ") || undefined,
			quotas,
		};
	},
};

/**
 * Kimi 开放平台（Moonshot）：按量付费 API key，与 Kimi For Coding 订阅是两套体系。
 * 官方接口 GET /v1/users/me/balance（Bearer 认证），
 * 返回 data.available_balance（元）/ vouchers_balance（赠金）/ cash_balance（现金）。
 */
function moonshotAdapter(providerId: string, baseUrl: string): BalanceAdapter {
	return {
		providerId,
		label: providerId === "moonshotai" ? "Kimi 开放平台" : "Kimi 开放平台(CN)",
		rateText: meteredRateText,
		async fetch(ctx) {
			const key = await ctx.modelRegistry.getApiKeyForProvider(providerId);
			if (!key) throw new Error(`未配置 API key（请设置 MOONSHOT_API_KEY 环境变量）`);

			const res = await fetch(`${baseUrl}/users/me/balance`, {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
			}

			const data = (await res.json()) as {
				code?: number;
				data?: {
					available_balance?: number | string;
					vouchers_balance?: number | string;
					cash_balance?: number | string;
				};
			};
			if (data.code !== 0 || !data.data) throw new Error("响应缺少 data");
			const toNum = (v: number | string | undefined) => {
				const n = typeof v === "number" ? v : parseFloat(v ?? "");
				return Number.isFinite(n) ? n : 0;
			};
			const available = toNum(data.data.available_balance);
			const cash = toNum(data.data.cash_balance);
			const vouchers = toNum(data.data.vouchers_balance);

			const status: BalanceStatus = available <= 1 ? "error" : available < 5 ? "warning" : "ok";
			return {
				status,
				label: "余额",
				// 与 DeepSeek 一致的精简格式：主金额 = 现金余额，赠金以 “+ X.XX” 追加
				amount: `CNY ${cash.toFixed(2)}`,
				detail: vouchers > 0 ? `+ ${vouchers.toFixed(2)}` : undefined,
			};
		},
	};
}

const moonshotaiAdapter = moonshotAdapter("moonshotai", "https://api.moonshot.ai/v1");
const moonshotaiCnAdapter = moonshotAdapter("moonshotai-cn", "https://api.moonshot.cn/v1");

/**
 * Xiaomi MiMo Token Plan（订阅制积分）：官方接口 GET {base}/v1/platform/token_plan，
 * 认证为 Token Plan 专属 Key（tp-），支持 Authorization: Bearer 或 api-key 头。
 * 三处区域各一个 Base URL（cn / sgp / ams），端点路径相同，按 providerId 映射。
 *
 * 响应：quota.total_credits / used_credits / remaining_credits（总额含补偿积分），
 * period.start_at / end_at 为订阅有效期——月卡/年卡差异全在这里，额度口径本身不变。
 * 展示：一条额度条（百分比），不标周期——额度条写的月/年只会让人以为是月额度。
 * 速率走积分轨（hud-cost 按官方 Credits 单价本地估算，不换算 ¥）。
 */
const MIMO_TOKEN_PLAN_BASE: Record<string, string> = {
	"xiaomi-token-plan-cn": "https://token-plan-cn.xiaomimimo.com",
	"xiaomi-token-plan-sgp": "https://token-plan-sgp.xiaomimimo.com",
	"xiaomi-token-plan-ams": "https://token-plan-ams.xiaomimimo.com",
};

function mimoTokenPlanAdapter(providerId: string, label: string): BalanceAdapter {
	return {
		providerId,
		label,
		rateText: meteredRateText, // 积分轨
		async fetch(ctx) {
			const key = await ctx.modelRegistry.getApiKeyForProvider(providerId);
			if (!key) throw new Error("未配置 API key（需 Token Plan 专属 Key）");

			const res = await fetch(`${MIMO_TOKEN_PLAN_BASE[providerId]}/v1/platform/token_plan`, {
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
			}

			const data = (await res.json()) as {
				quota?: { total_credits?: number; used_credits?: number; remaining_credits?: number };
			};
			const q = data.quota;
			if (!q || typeof q.remaining_credits !== "number") throw new Error("响应缺少 quota（请确认 Key 属于 Token Plan）");

			const total = q.total_credits ?? 0;
			const used = q.used_credits ?? Math.max(0, total - q.remaining_credits);
			const pct = total > 0 ? (used / total) * 100 : 0;
			const status: BalanceStatus = pct >= 100 ? "error" : pct >= 80 ? "warning" : "ok";

			// 额度条不标周期：额度就一份，写「月/年」只会被读成月额度。
			// 年卡额度以亿计，1% 粒度太粗（差 1% 就是上亿积分），百分比保留两位小数
			return {
				status,
				amount: "Token Plan",
				label: "额度",
				quotas: [{ label: "", used, limit: total, pctDecimals: 2 }],
			};
		},
	};
}

const xiaomiTokenPlanCnAdapter = mimoTokenPlanAdapter("xiaomi-token-plan-cn", "MiMo Token Plan");
const xiaomiTokenPlanSgpAdapter = mimoTokenPlanAdapter("xiaomi-token-plan-sgp", "MiMo Token Plan SGP");
const xiaomiTokenPlanAmsAdapter = mimoTokenPlanAdapter("xiaomi-token-plan-ams", "MiMo Token Plan AMS");

/**
 * Xiaomi MiMo 按量付费（预充值）：官方接口 GET https://api.xiaomimimo.com/v1/platform/balance，
 * 认证为普通 API Key（sk-）。响应 balance_infos[0]：cash_balance 现金、gift_balance 赠金、
 * frozen_balance 冻结、credit_available 可用授信，total_available = 现金 + 赠金 + 可用授信。
 * 主金额按账户实际可用的 total_available（与 DeepSeek「充值 + 赠金」同口径），
 * 现金/赠金/授信拆解收进 detail。
 */
const xiaomiMeteredCnAdapter: BalanceAdapter = {
	providerId: "xiaomi",
	label: "MiMo 按量付费",
	rateText: meteredRateText, // 人民币轨：¥/min + 累计
	async fetch(ctx) {
		const key = await ctx.modelRegistry.getApiKeyForProvider("xiaomi");
		if (!key) throw new Error("未配置 API key");

		const res = await fetch("https://api.xiaomimimo.com/v1/platform/balance", {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
		}

		const data = (await res.json()) as {
			is_available?: boolean;
			balance_infos?: {
				currency?: string;
				cash_balance?: string;
				gift_balance?: string;
				frozen_balance?: string;
				credit_available?: string;
				total_available?: string;
			}[];
		};
		const info = data.balance_infos?.[0];
		if (!info) throw new Error("响应缺少 balance_infos");

		const cash = toNum(info.cash_balance);
		const gift = toNum(info.gift_balance);
		const frozen = toNum(info.frozen_balance);
		const credit = toNum(info.credit_available);
		const available = info.total_available !== undefined ? toNum(info.total_available) : cash + gift + credit;
		const currency = info.currency || "CNY";

		// 变色看实际可支出总额（现金 + 赠金 + 授信）；显示只给现金与赠送（同 DeepSeek 口径）
		const status: BalanceStatus =
			data.is_available === false || available <= 1 ? "error" : available < 5 ? "warning" : "ok";

		const extras: string[] = [];
		const giftPart = gift > 0 ? `+ ${gift.toFixed(2)}` : undefined;
		if (giftPart) extras.push(giftPart);
		if (credit > 0) extras.push(`授信 ${credit.toFixed(2)}`);
		if (frozen > 0) extras.push(`冻结 ${frozen.toFixed(2)}`);

		return {
			status,
			label: "余额",
			// 与 DeepSeek 一致的精简格式：主金额 = 现金余额，赠送以 “+ X.XX” 追加（无赠送则省略）
			amount: `${currency} ${cash.toFixed(2)}`,
			detail: extras.length > 0 ? extras.join(" · ") : undefined,
		};
	},
};

/**
 * Volcengine Ark Coding（火山方舟 Coding）：订阅制，无公开余额 API，显示控制台查询链接。
 */
const volcengineCodingAdapter: BalanceAdapter = {
	providerId: "volcengine-coding",
	label: "火山方舟 Coding",
	// 订阅制且无等效单价：展示会话 token 消耗
	rateText(ctx, _now) {
		const t = sumSessionUsage(ctx);
		if (t.turns === 0) return null;
		return [{ text: `${fmtNum(t.input + t.output + t.cacheRead)} tokens`, color: "dim" }];
	},
	async fetch(_ctx) {
		return {
			status: "ok",
			label: "余量查询",
			link: {
				url: "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan",
			},
		};
	},
};

/**
 * OpenRouter：美元充值账户。
 * 官方接口 GET https://openrouter.ai/api/v1/credits（Bearer 认证：普通 key 亦可读，实测非 management key 返回 200），
 * 返回 total_credits（累计购买）与 total_usage（累计消耗），当前余额 ≈ total_credits - total_usage。
 * 注意：该接口有缓存，可能延迟最多约 60 秒，非实时数据。
 */
const openrouterAdapter: BalanceAdapter = {
	providerId: "openrouter",
	label: "OpenRouter",
	// 按量付费：¥/min + 累计（统一 RMB 计价）
	rateText: meteredRateText,
	async fetch(ctx) {
		const key = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
		if (!key) throw new Error("未配置 API key");

		const headers = { Authorization: `Bearer ${key}` };
		const signal = AbortSignal.timeout(10_000);

		// 账户总余额：GET /api/v1/credits
		const res = await fetch("https://openrouter.ai/api/v1/credits", { headers, signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as {
			data?: { total_credits?: number; total_usage?: number };
		};
		const d = data.data;
		if (typeof d?.total_credits !== "number" && typeof d?.total_usage !== "number") {
			throw new Error("响应缺少 total_credits/total_usage");
		}

		const total = d.total_credits || 0;
		const used = d.total_usage || 0;
		const remainingUsd = Math.max(total - used, 0); // 总余额 = 累计购买 - 累计消耗（USD）
		// 状态判断基于 USD 原值（阈值语义稳定，不随汇率波动）
		const status: BalanceStatus = remainingUsd <= 1 ? "error" : remainingUsd < 5 ? "warning" : "ok";

		// 单 Key 限额：GET /api/v1/key，limit 为 null（未设限）时不显示进度条；
		// 限额窗口由 limit_reset 给出（daily/weekly/monthly），用量取对应窗口（优先 limit_remaining，
		// 无则按窗口取 usage_*）；该查询可失败，仅降级去掉进度条，不阻塞账户余额显示。
		const keyQuota = (() => {
			try {
				return (async () => {
					const keyRes = await fetch("https://openrouter.ai/api/v1/key", { headers, signal });
					if (!keyRes.ok) return null;
					const kd = (await keyRes.json()) as {
						data?: {
							limit?: number | null;
							limit_remaining?: number | null;
							limit_reset?: string | null;
							usage?: number;
							usage_daily?: number | null;
							usage_weekly?: number | null;
							usage_monthly?: number | null;
						};
					};
					const k = kd.data;
					const limit = typeof k?.limit === "number" ? k.limit : 0;
					if (limit <= 0) return null;
					const windowUsage =
						k?.limit_reset === "daily"
							? k.usage_daily
							: k?.limit_reset === "weekly"
								? k.usage_weekly
								: k?.limit_reset === "monthly"
									? k.usage_monthly
									: (k?.usage_monthly ?? k?.usage);
					const used =
						typeof k?.limit_remaining === "number"
							? Math.max(limit - k.limit_remaining, 0)
							: typeof windowUsage === "number"
								? windowUsage
								: 0;
					// 窗口后缀进额度条标签，避免日限额被误读为月用量
					const suffix =
						k?.limit_reset === "daily" ? "日" : k?.limit_reset === "weekly" ? "周" : k?.limit_reset === "monthly" ? "月" : "";
					return { used, limit, label: suffix ? `Key·${suffix}` : "Key" } as const;
				})();
			} catch {
				return null; // 忽略：限额查询失败不阻塞余额显示
			}
		})();
		const kq = await keyQuota;

		// 汇率可用 → 统一 RMB 计价；不可用（无实时也无缓存）→ 显示原始货币 USD
		const rate = getUsdCnyRate();
		const rateSource = getRateSource();
		if (rate !== null) {
			const remainingCny = remainingUsd * rate;
			const quotas: BalanceQuota[] = kq
				? [{ label: kq.label, used: kq.used * rate, limit: kq.limit * rate, currency: "CNY" }]
				: [];
			return {
				status,
				label: "余额",
				// 主金额 = 账户总余额（RMB）；已用明细按需求隐藏
				amount: `CNY ${remainingCny.toFixed(2)}`,
				// 明细：原始 USD 金额 + 所用汇率（实时/磁盘缓存标注），货币缩写统一转符号
				detail: `${currencySymbol("USD")}${remainingUsd.toFixed(2)} · 汇率 ${rate.toFixed(4)}${rateSource === "live" ? "" : "(缓存)"}`,
				quotas: quotas.length > 0 ? quotas : undefined,
				showAmountWithQuotas: true,
			};
		}
		// 无汇率：直接显示原始货币（不猜近似值）
		const quotasUsd: BalanceQuota[] = kq
			? [{ label: kq.label, used: kq.used, limit: kq.limit, currency: "USD" }]
			: [];
		return {
			status,
			label: "余额",
			amount: `USD ${remainingUsd.toFixed(2)}`,
			detail: "汇率不可用（离线），显示原始货币",
			quotas: quotasUsd.length > 0 ? quotasUsd : undefined,
			showAmountWithQuotas: true,
		};
	},
};

/**
 * SenseNova Token Plan CN：免费公测，按请求次数限制（每5小时滚动窗口），无公开余额 API，显示控制台链接。
 * 已配置的模型见 static/models.json（sensenova-6.8-flash-lite / deepseek-v4-flash / deepseek-v4.1-flash /
 * deepseek-flash / glm-5.2 / deepseek-v4-pro / kimi-k3），以 /v1/models 实测列表为准。
 * sensenova-u1-fast / sensenova-u1.5-lite 未配置：前者输出图像，不属 openai-completions 对话模型。
 */
const sensenovaAdapter: BalanceAdapter = {
	providerId: "sensenova",
	label: "SenseNova Token Plan",
	// 免费公测：展示会话 token 消耗
	rateText(ctx, _now) {
		const t = sumSessionUsage(ctx);
		if (t.turns === 0) return null;
		return [{ text: `${fmtNum(t.input + t.output + t.cacheRead)} tokens`, color: "dim" }];
	},
	async fetch(_ctx) {
		return {
			status: "ok",
			label: "余量查询",
			link: { url: "https://platform.sensenova.cn/token-plan" },
		};
	},
};

/**
 * OpenCode Go：订阅制，单一额度池（Go $60/月，Go Plus $240/月），
 * 5h = 20% / 周 = 50% / 月 = 100%；各付费模型共用这一份池，
 * 每模型的官方 "Monthly limit" 是该池在该模型上的等值（权重 = 池 / 月额度）。
 * 接口：GET https://opencode.ai/zen/go/v1/usage（Bearer API key）
 * 返回 rolling / weekly / monthly 的 percent 与 resetsAt。
 *
 * HUD 行展示对齐 Kimi 风格（简化）：只画「额度条 + 窗口标签 + 百分比」，
 * 金额用量与重置倒计时收进 detail，由 /balance notify 查看。
 * 窗口顺序统一大周期在前：月 > 周 > 5h。
 *
 * 档位自动探测：官方无档位接口，用 console 的本月分模型标价花费分别按两档月额度
 * 折算，与 usage 百分比比对取更近的一档（每会话一次，失败保持 Go 档）。
 */
const GO_CONSOLE_USAGE_URL = "https://console.opencode.ai/api/usage/models";
const GO_PLAN_MIN_PERCENT = 3; // 月度用量低于 3% 时两档拟合无区分度，不探测
let goPlanAttempted = false;

function monthsBefore(ts: number): number {
	const d = new Date(ts);
	d.setUTCMonth(d.getUTCMonth() - 1);
	return d.getTime();
}

async function maybeDetectGoPlan(key: string, data: GoUsagePayload): Promise<void> {
	const monthly = data.usage.monthly;
	if (isGoPlanDetected() || goPlanAttempted || !monthly) return;
	const target = monthly.percent / 100;
	if (target < GO_PLAN_MIN_PERCENT / 100) return;
	const reset = Date.parse(monthly.resetsAt);
	if (!Number.isFinite(reset)) return;
	goPlanAttempted = true;
	try {
		const url = new URL(GO_CONSOLE_USAGE_URL);
		url.searchParams.set("pageSize", "100");
		url.searchParams.set("since", new Date(monthsBefore(reset)).toISOString());
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
			signal: AbortSignal.timeout(6000),
		});
		if (!res.ok) return;
		const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
		const items = (body.items ?? []).filter((item) => item.provider === "opencode-go");
		if (items.length === 0) return;
		// 接口若直接给出产品档位，优先采用
		const product = items.find((item) => typeof item.product === "string" && item.product)?.product;
		if (typeof product === "string") {
			setGoPlan(product.includes("plus") ? "plus" : "go");
			return;
		}
		// 否则用两档月额度分别拟合本月百分比（同一份额度按模型表达）
		let go = 0;
		let plus = 0;
		for (const item of items) {
			const cost = Number(item.totalCostMicroCents ?? 0) / 100_000_000;
			if (!(cost > 0)) continue;
			const modelKey = goModelKey(String(item.model ?? ""));
			go += cost / goAllowance(modelKey, "go");
			plus += cost / goAllowance(modelKey, "plus");
		}
		if (!(go > 0) || !(plus > 0)) return;
		const goErr = Math.abs(go - target) / target;
		const plusErr = Math.abs(plus - target) / target;
		// 两档都明显对不上：接口口径与本地价目/窗口边界不一致，保持默认
		if (Math.min(goErr, plusErr) > 0.35) return;
		setGoPlan(plusErr < goErr ? "plus" : "go");
	} catch {
		// 探测失败：保持默认 Go 档，不影响余额展示
	}
}

interface GoUsageWindow {
	status: "ok" | "warning" | "error";
	percent: number;
	resetsAt: string;
}

interface GoUsagePayload {
	usage: {
		rolling: GoUsageWindow;
		weekly: GoUsageWindow;
		monthly: GoUsageWindow;
	};
}

/** 将剩余毫秒格式化为紧凑倒计时（<1分 / Xm / XhYm / X天Yh）。 */
function formatGoReset(ms: number): string {
	if (ms <= 0) return "已重置";
	const m = Math.floor(ms / 60_000);
	if (m < 1) return "<1分";
	if (m < 60) return `${m}分`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	if (h < 24) return rm ? `${h}时${rm}分` : `${h}时`;
	const d = Math.floor(h / 24);
	const rh = h % 24;
	return rh ? `${d}天${rh}时` : `${d}天`;
}

const opencodeGoAdapter: BalanceAdapter = {
	providerId: "opencode-go",
	label: "OpenCode Go",
	// 订阅制：按 Go 订阅内官方 USD 计价估算等效消耗（$/min + $累计，hud-cost USD 轨；
	// msgCost 已为 opencode-go 接入 GO_PRICES，有汇率时显示 ¥）
	rateText(ctx, now) {
		return meteredRateText(ctx, now);
	},
	async fetch(ctx) {
		const auth = await ctx.modelRegistry.getProviderAuth("opencode-go");
		const key = auth?.auth.apiKey ?? auth?.auth.headers?.Authorization?.replace(/^Bearer\s+/i, "");
		if (!key) throw new Error("未配置 API key（请先执行 /login opencode-go）");

		const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
		}

		const data = (await res.json()) as GoUsagePayload;
		await maybeDetectGoPlan(key, data);
		const now = Date.now();
		const pool = goPool(); // 未探测到档位时按 Go 档（$60）
		// 大周期在前（月 > 周 > 5h），对齐 Kimi 风格；金额 = 池 × 100%/50%/20%
		const windows = [
			{ key: "monthly" as const, label: "月", limit: pool, w: data.usage.monthly },
			{ key: "weekly" as const, label: "周", limit: pool * 0.5, w: data.usage.weekly },
			{ key: "rolling" as const, label: "5h", limit: pool * 0.2, w: data.usage.rolling },
		];

		// 整体状态：任一窗口耗尽/报错 → error；任一窗口 ≥80% → warning
		let status: BalanceStatus = "ok";
		for (const { w, limit } of windows) {
			const usedUsd = (w.percent / 100) * limit;
			if (w.status === "error" || usedUsd >= limit) {
				status = "error";
				break;
			}
			if (w.percent >= 80) status = "warning";
		}

		// 额度条：Kimi 风格简化——HUD 行只画「额度条 + 标签 + 百分比」（不带金额与重置倒计时），
		// 完整明细（百分比 + 重置倒计时）保留在 detail 供 /balance 查看
		const quotas: BalanceQuota[] = windows.map(({ label, limit, w }) => ({
			label,
			used: (w.percent / 100) * limit,
			limit,
		}));

		const detail = windows
			.map(({ label, limit, w }) => {
				const usedUsd = ((w.percent / 100) * limit).toFixed(2);
				return `${label} $${usedUsd}/${limit.toFixed(2)}（${formatGoReset(Date.parse(w.resetsAt) - now)}）`;
			})
			.join(" · ");

		return {
			status,
			label: "额度",
			amount: "OpenCode Go",
			detail,
			quotas,
		};
	},
};

/**
 * Z.AI Coding CN（智谱 GLM Coding Plan 国内版，Coding 端点 open.bigmodel.cn）：订阅积分制。
 * 配额接口（官方未写入文档，社区监控通用）：GET /api/monitor/usage/quota/limit，
 * 认证 Authorization: <apiKey>（裸 key，无 Bearer 前缀）。
 * 响应 data.limits[]：积分窗口 type=CREDIT_LIMIT（新版透明积分制，实测 Lite 档两条：
 * 5h + 周；旧版为他档为 TOKENS_LIMIT）按 nextResetTime 升序 → [0]=5h、末条=周，
 * 另有 type=TIME_LIMIT 一条（MCP 月度，部分档位无）；
 * percentage=已用百分比，currentValue/usage（可选）=已用/总额度积分。
 * 来源：https://github.com/showlotus/glm-usage（VS Code 扩展，MIT）+ 本机实测校准。
 *
 * 展示：余额行画三窗口额度条（百分比，紧凑）；积分绝对值/套餐档位收进 detail 供 /balance 查看；
 * 消耗速率走 hud-cost 积分轨（fetch 顺带喏积分差分器，与 turn_end 采样共用同一状态）。
 */
const zaiCodingCnAdapter: BalanceAdapter = {
	providerId: "zai-coding-cn",
	label: "Z.AI Coding CN",
	// 积分轨：meteredRateText 内按 provider 分流（积分/min + 累计积分，不换算 ¥/$）
	rateText: meteredRateText,
	async fetch(ctx) {
		const key = await ctx.modelRegistry.getApiKeyForProvider("zai-coding-cn");
		if (!key) throw new Error("未配置 API key（请使用智谱开放平台 Coding Plan 专用 Key）");

		const res = await fetch(ZAI_QUOTA_URL, {
			headers: { Authorization: key, Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
		}
		const data = (await res.json()) as ZaiQuotaResponse;
		detectGlmTier(data);
		const limits = data.data?.limits ?? [];
		if (limits.length === 0) throw new Error("响应缺少 data.limits（请确认 Key 属于 Coding Plan 套餐）");

		// 窗口分类：积分窗口（CREDIT_LIMIT 新版 / TOKENS_LIMIT 旧版）按 nextResetTime 升序
		//（[0]=5h、末条=周）；TIME_LIMIT=MCP 月度（Lite 档实测无此条）
		const tokenLimits = limits
			.filter((l) => l.type === "CREDIT_LIMIT" || l.type === "TOKENS_LIMIT")
			.sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0));
		const mcp = limits.find((l) => l.type === "TIME_LIMIT");

		// 余额刷新顺带喏积分差分器（与 turn_end 采样共用同一状态，见 hud-cost 积分轨）
		const w5h = tokenLimits[0];
		if (w5h) {
			const used = zaiWindowUsedCredits(w5h);
			if (used !== null) sampleZaiCredits(used, w5h.nextResetTime ?? 0);
		}

		const now = Date.now();
		// 大周期在前（MCP月 > 周 > 5h），对齐 Kimi 风格
		const windows: Array<{ label: string; w: ZaiTokenLimit }> = [];
		if (mcp) windows.push({ label: "MCP月", w: mcp });
		if (tokenLimits.length > 1) windows.push({ label: "周", w: tokenLimits[tokenLimits.length - 1] });
		if (tokenLimits[0]) windows.push({ label: "5h", w: tokenLimits[0] });

		// 整体状态：任一窗口用满 → error；任一 ≥80% → warning
		let status: BalanceStatus = "ok";
		for (const { w } of windows) {
			const pct = typeof w.percentage === "number" ? w.percentage : 0;
			if (pct >= 100) {
				status = "error";
				break;
			}
			if (pct >= 80) status = "warning";
		}

		// 额度条：百分比模式（积分绝对值收进 detail，避免 HUD 行超宽截断）
		const describe = (label: string, w: ZaiTokenLimit): string => {
			const pct = typeof w.percentage === "number" ? w.percentage : 0;
			const used = zaiWindowUsedCredits(w);
			const total = typeof w.usage === "number" && w.usage > 0 ? w.usage : null;
			const reset =
				typeof w.nextResetTime === "number" && w.nextResetTime > now
					? formatGoReset(w.nextResetTime - now)
					: undefined;
			const usedText = used !== null ? fmtNum(Math.round(used)) : `${pct.toFixed(0)}%`;
			const totalText = total !== null ? `/${fmtNum(Math.round(total))}` : "";
			return `${label} ${CREDIT_SYMBOL}${usedText}${totalText}（${pct.toFixed(0)}%${reset ? ` · ${reset}后重置` : ""}）`;
		};
		// 额度条：纯百分比模式（积分绝对值/重置时间收进 detail），不带重置倒计时保持 HUD 行简洁
		const quotas: BalanceQuota[] = windows.map(({ label, w }) => ({
			label,
			used: typeof w.percentage === "number" ? w.percentage : 0,
			limit: 100,
		}));

		// 明细（/balance 查看）：套餐档位 + 各窗口积分用量（🪙 符号）+ 重置倒计时
		const level = data.data?.level;
		const detailParts = windows.map(({ label, w }) => describe(label, w));
		if (level) detailParts.unshift(`套餐 ${level}`);

		return {
			status,
			label: "额度",
			amount: "GLM Coding",
			detail: detailParts.join(" · ") || undefined,
			quotas,
		};
	},
};

/** 已适配的供应商注册表。新增供应商在这里追加一个 adapter 即可。 */
export const BALANCE_ADAPTERS: Record<string, BalanceAdapter> = {
	[deepseekAdapter.providerId]: deepseekAdapter,
	[xiaomiMeteredCnAdapter.providerId]: xiaomiMeteredCnAdapter,
	[kimiCodingAdapter.providerId]: kimiCodingAdapter,
	[moonshotaiAdapter.providerId]: moonshotaiAdapter,
	[moonshotaiCnAdapter.providerId]: moonshotaiCnAdapter,
	[xiaomiTokenPlanCnAdapter.providerId]: xiaomiTokenPlanCnAdapter,
	[xiaomiTokenPlanSgpAdapter.providerId]: xiaomiTokenPlanSgpAdapter,
	[xiaomiTokenPlanAmsAdapter.providerId]: xiaomiTokenPlanAmsAdapter,
	[openrouterAdapter.providerId]: openrouterAdapter,
	[volcengineCodingAdapter.providerId]: volcengineCodingAdapter,
	[sensenovaAdapter.providerId]: sensenovaAdapter,
	[opencodeGoAdapter.providerId]: opencodeGoAdapter,
	[zaiCodingCnAdapter.providerId]: zaiCodingCnAdapter,
};
