/**
 * hud-balance：HUD 供应商余额适配层（hud 多文件扩展的组成部分，仅被 hud/index.ts import）
 *
 * 职责：
 * - 统一 BalanceData/BalanceAdapter 接口，按供应商逐一适配（按量充值余额 vs 订阅 plan 余量 vs 订阅+加油包）
 * - 已适配：deepseek / kimi-coding / moonshotai / moonshotai-cn / xiaomi / xiaomi-token-plan-cn / openrouter
 * - 消耗统计文本（rateText）复用 hud-cost 的按量付费实现（¥/min 或 $/min）
 *
 * 注意：本模块不注册任何 pi API，仅导出接口与注册表，由入口模块驱动。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	currencySymbol,
	fmtNum,
	getRateSource,
	getUsdCnyRate,
	meteredRateText,
	sumSessionUsage,
	type RateTextPart,
} from "./hud-cost";

// ---------------------------------------------------------------------------
// 供应商余额适配层
// ---------------------------------------------------------------------------

export type BalanceStatus = "ok" | "warning" | "error";

export interface BalanceQuota {
	label: string;
	used: number;
	limit: number;
	/** 币种（如 "USD"）：有值则进度条旁显示金额用量 `Key USD 0.1/1.0`，缺省显示百分比 */
	currency?: string;
}

export interface BalanceData {
	status: BalanceStatus;
	/** 主金额，如 "CNY 110.00" */
	amount: string;
	/** 明细，如 "充值 100.00 · 赠送 10.00" */
	detail?: string;
	/** 多维度额度条（如 Kimi 的周额度 + 5 小时滚动窗口） */
	quotas?: BalanceQuota[];
	/** 带额度条时仍显示金额（默认仅 CNY 金额在额度条旁显示，其他币种需显式开启） */
	showAmountWithQuotas?: boolean;
	/** 隐藏左侧 "余额" 标签（用于只显示链接等场景） */
	hideLabel?: boolean;
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
			// 精简格式：主金额 = 充值余额，赠送以 “+ X.XX” 追加（无赠送则省略）
			amount: `${currency} ${topped.toFixed(2)}`,
			detail: granted > 0 ? `+ ${granted.toFixed(2)}` : undefined,
		};
	},
};

/**
 * Kimi For Coding：订阅制 + 加油包（Extra Usage）混合计费。
 * 官方接口 GET https://api.kimi.com/coding/v1/usages（Bearer 认证），
 * 返回订阅额度（usage/limits）和加油包余额（boosterWallet）。
 */
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_FIXED_POINT_CENTS = 1_000_000; // 加油包金额固定点：1e6 单位 = 1 分

interface KimiUsageWindow {
	duration?: number;
	timeUnit?: "TIME_UNIT_MINUTE" | "TIME_UNIT_HOUR" | "TIME_UNIT_DAY" | "TIME_UNIT_WEEK" | string;
}

interface KimiUsageRow {
	used?: number;
	limit?: number;
	name?: string;
	resetTime?: string;
	window?: KimiUsageWindow;
}

interface KimiBoosterWallet {
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

function formatUsageRow(row: KimiUsageRow): string {
	const name = row.name && row.name.length > 0 ? row.name : formatWindowShort(row.window);
	const used = toInt(row.used) ?? 0;
	const limit = toInt(row.limit) ?? 0;
	const label = name || "额度";
	return `${label} ${used}/${limit}`;
}

function rowLabel(row: KimiUsageRow): string {
	return (row.name && row.name.length > 0 ? row.name : formatWindowShort(row.window)) || "额度";
}

const kimiCodingAdapter: BalanceAdapter = {
	providerId: "kimi-coding",
	label: "Kimi For Coding",
	// 订阅制：不显示 ¥/min，展示会话 token 消耗
	rateText(ctx, _now) {
		const t = sumSessionUsage(ctx);
		if (t.turns === 0) return null;
		return [{ text: `${fmtNum(t.input + t.output + t.cacheRead)} tokens`, color: "dim" }];
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

		// 加油包余额（可选）
		let boosterCents: number | null = null;
		let boosterTotalCents: number | null = null;
		let boosterCurrency = "CNY";
		const booster = data.boosterWallet;
		if (booster?.balance?.type === "BOOSTER") {
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
		const summaryLimit = summary?.limit ?? 0;
		const summaryUsed = summary?.used ?? 0;
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
			quotas.push({ label: rowLabel(summary), used: toInt(summary.used) ?? 0, limit: toInt(summary.limit) ?? 0 });
		}
		for (const limit of limits) {
			quotas.push({ label: rowLabel(limit), used: toInt(limit.used) ?? 0, limit: toInt(limit.limit) ?? 0 });
		}

		return {
			status,
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
 * Xiaomi MiMo Token Plan CN：订阅制，Token Plan 无公开余额 API，显示控制台链接。
 */
const xiaomiTokenPlanCnAdapter: BalanceAdapter = {
	providerId: "xiaomi-token-plan-cn",
	label: "MiMo Token Plan",
	// 订阅制且无等效单价：展示会话 token 消耗
	rateText(ctx, _now) {
		const t = sumSessionUsage(ctx);
		if (t.turns === 0) return null;
		return [{ text: `${fmtNum(t.input + t.output + t.cacheRead)} tokens`, color: "dim" }];
	},
	async fetch(_ctx) {
		return {
			status: "ok",
			amount: "余量查询",
			detail: "https://platform.xiaomimimo.com/console/plan-manage",
			hideLabel: true,
		};
	},
};

/**
 * Xiaomi MiMo 按量付费 CN：按量付费，无公开余额 API，显示控制台链接。
 * 与 Token Plan 共享同一平台，使用 usage 页面。
 */
const xiaomiMeteredCnAdapter: BalanceAdapter = {
	providerId: "xiaomi",
	label: "MiMo 按量付费",
	// 按量付费：¥/min + 累计（统一 RMB 计价）
	rateText: meteredRateText,
	async fetch(_ctx) {
		return {
			status: "ok",
			amount: "余额查询",
			detail: "https://platform.xiaomimimo.com/console/balance",
			hideLabel: true,
		};
	},
};

/**
 * OpenRouter：美元充值账户。
 * 官方接口 GET https://openrouter.ai/api/v1/credits（Bearer 认证，需 management key），
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

		// 账户总余额：GET /api/v1/credits（management key）
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
		// 该查询可失败，仅降级去掉进度条，不阻塞账户余额显示。
		const keyQuota = (() => {
			try {
				return (async () => {
					const keyRes = await fetch("https://openrouter.ai/api/v1/key", { headers, signal });
					if (!keyRes.ok) return null;
					const kd = (await keyRes.json()) as {
						data?: { limit?: number | null; usage?: number; usage_monthly?: number | null };
					};
					const k = kd.data;
					const limit = typeof k?.limit === "number" ? k.limit : 0;
					if (limit <= 0) return null;
					// 限额按周期重置（limit_reset 多为 monthly），优先用当月用量；无则退回累计用量
					const kused =
						(typeof k?.usage_monthly === "number" ? k.usage_monthly : 0) ||
						(typeof k?.usage === "number" ? k.usage : 0) ||
						0;
					return { used: kused, limit } as const;
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
				? [{ label: "Key", used: kq.used * rate, limit: kq.limit * rate, currency: "CNY" }]
				: [];
			return {
				status,
				// 主金额 = 账户总余额（RMB）；已用明细按需求隐藏
				amount: `CNY ${remainingCny.toFixed(2)}`,
				// 明细：原始 USD 金额 + 所用汇率（实时/磁盘缓存标注），货币缩写统一转符号
				detail: `${currencySymbol("USD")}${remainingUsd.toFixed(2)} · 汇率 ${rate.toFixed(4)}${rateSource === "live" ? "" : "(缓存)"}`,
				quotas: quotas.length > 0 ? quotas : undefined,
				showAmountWithQuotas: true,
			};
		}
		// 无汇率：直接显示原始货币（不猜近似值）
		const quotasUsd: BalanceQuota[] = kq ? [{ label: "Key", used: kq.used, limit: kq.limit, currency: "USD" }] : [];
		return {
			status,
			amount: `USD ${remainingUsd.toFixed(2)}`,
			detail: "汇率不可用（离线），显示原始货币",
			quotas: quotasUsd.length > 0 ? quotasUsd : undefined,
			showAmountWithQuotas: true,
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
	[openrouterAdapter.providerId]: openrouterAdapter,
};
