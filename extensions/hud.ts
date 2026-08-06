/**
 * 3 行 HUD 状态栏
 *
 * 行 1  git：分支 / 暂存(+N) / 工作区(~N) / 未跟踪(?N) / 领先落后 / 项目名
 * 行 2  模型：供应商 / 模型 / 思考级别 + 用量：token / 成本 / 上下文进度条
 * 行 3  账户：余额 / plan 余量 + 消耗速率（固定此行）
 *
 * 行 3 计费适配说明：
 *   不同供应商计费方式差异很大（按量充值余额 vs 订阅 plan 余量 vs 订阅+加油包余额），
 *   无法用通用模板，因此按供应商逐一适配。
 *   适配器统一返回 BalanceData，未适配的供应商显示占位提示。
 *   目前已适配：
 *     - deepseek（GET /user/balance，充值 + 赠送余额；消耗按官方人民币定价直算，见 DEEPSEEK_PRICES）
 *     - kimi-coding（GET /v1/usages，订阅额度 + 加油包余额）
 *     - moonshotai / moonshotai-cn（GET /v1/users/me/balance，按量付费余额）
 *     - xiaomi-token-plan-cn（无公开余额 API，显示控制台链接）
 *
 * 命令：
 *   /balance  立即刷新余额并通知
 *   /hud      切换 3 行 HUD 开/关
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 供应商余额适配层
// ---------------------------------------------------------------------------

export type BalanceStatus = "ok" | "warning" | "error";

export interface BalanceQuota {
	label: string;
	used: number;
	limit: number;
}

export interface BalanceData {
	status: BalanceStatus;
	/** 主金额，如 "CNY 110.00" */
	amount: string;
	/** 明细，如 "充值 100.00 · 赠送 10.00" */
	detail?: string;
	/** 多维度额度条（如 Kimi 的周额度 + 5 小时滚动窗口） */
	quotas?: BalanceQuota[];
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

export interface RateTextPart {
	text: string;
	color?: string;
}

/** 会话 usage 汇总（跨 turn 累加 assistant 消息） */
interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	costTotalCny: number;
	turns: number;
}

function sumSessionUsage(ctx: ExtensionContext): SessionUsageTotals {
	const t: SessionUsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		costTotalCny: 0,
		turns: 0,
	};
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			const u = m.usage;
			t.input += u.input;
			t.output += u.output;
			t.cacheRead += u.cacheRead;
			t.costTotalCny += msgCostCny(m);
			t.turns++;
		}
	}
	return t;
}

// ---------------------------------------------------------------------------
// 消耗速率统计（模块级状态，供各 provider 的 rateText 使用）
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 10 * 60 * 1000; // 消耗速率统计窗口：最近 10 分钟
const MIN_WINDOW_MS = 60 * 1000; // 启动至少 1 分钟才显示速率（数据太少不准确）
let costEvents: { ts: number; cost: number }[] = [];
let lastRecordedTotal = 0;
let startupTime = Date.now();

let lastRecordedOutputTotal = 0;
let turnStartTime: number | null = null;
let smoothedTokenRate: number | null = null;

const TOKEN_RATE_SMOOTH_FACTOR = 0.2; // 新 turn 速率权重，历史速率权重 = 1 - 0.2

const fmtNum = (n: number) => {
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

/**
 * 平均每分钟消耗（人民币元）。
 * - 启动不足 1 分钟：返回 null（界面显示“正在计算”）。
 * - 1 分钟后：分母 = 实际经过的分钟数（封顶 10 分钟），即启动以来的平均速率；
 *   10 分钟后自然过渡为最近 10 分钟的滚动平均，无需再等满窗口。
 */
function computeRate(now: number): number | null {
	const elapsed = now - startupTime;
	if (elapsed < MIN_WINDOW_MS) return null;
	const windowMs = Math.min(elapsed, RATE_WINDOW_MS);
	const cutoff = now - windowMs;
	let sum = 0;
	for (const e of costEvents) if (e.ts >= cutoff) sum += e.cost;
	return sum / (windowMs / 60_000);
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

// ---------------------------------------------------------------------------
// DeepSeek 官方人民币定价（元 / 百万 tokens）
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
//   deepseek-v4-flash：缓存命中 ¥0.02，缓存未命中 ¥1，输出 ¥2
//   deepseek-v4-pro ：缓存命中 ¥0.025，缓存未命中 ¥3，输出 ¥6
// 扣费规则：扣减费用 = token 消耗量 × 模型单价（命中/未命中/输出分别计价）。
// ---------------------------------------------------------------------------

interface DeepSeekPrice {
	cacheHit: number; // 缓存命中输入（元/百万 tokens）
	cacheMiss: number; // 缓存未命中输入
	output: number; // 输出
}

const DEEPSEEK_PRICES: Record<string, DeepSeekPrice> = {
	"deepseek-v4-flash": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
	"deepseek-v4-pro": { cacheHit: 0.025, cacheMiss: 3, output: 6 },
};

// 峰谷定价：官方「即将采用」高峰时段价格 = 平时 2 倍（北京时间每日 9:00-12:00 / 14:00-18:00）。
// 正式生效前保持 false（避免高估），官方通知上线后改为 true。
const DEEPSEEK_PEAK_PRICING = false;
const DEEPSEEK_PEAK_HOURS: Array<[number, number]> = [
	[9, 12],
	[14, 18],
];

function isDeepSeekPeakHour(ts: number): boolean {
	const hour = new Date(ts + 8 * 3_600_000).getUTCHours(); // 北京时间 = UTC+8
	return DEEPSEEK_PEAK_HOURS.some(([start, end]) => hour >= start && hour < end);
}

function deepseekModelKey(modelId: string): string {
	return modelId.toLowerCase().includes("pro") ? "deepseek-v4-pro" : "deepseek-v4-flash";
}

/**
 * DeepSeek 消耗成本（人民币元），按官方定价直算。
 * pi 已将 prompt_cache_miss_tokens → usage.input、prompt_cache_hit_tokens → usage.cacheRead
 * 映射，因此直接用 token 数 × 官方单价即可，不再走 pi 的 USD 成本 × 近似汇率。
 */
function deepseekCostCny(u: AssistantMessage["usage"], modelId: string, ts: number): number {
	const p = DEEPSEEK_PRICES[deepseekModelKey(modelId)] ?? DEEPSEEK_PRICES["deepseek-v4-flash"];
	const peak = DEEPSEEK_PEAK_PRICING && isDeepSeekPeakHour(ts) ? 2 : 1;
	return ((p.cacheMiss * u.input + p.cacheHit * u.cacheRead + p.output * u.output) * peak) / 1_000_000;
}

/** 单条 assistant 消息的消耗成本（人民币元）。DeepSeek 用官方人民币定价直算；其余供应商用 pi 成本(USD)×汇率。 */
function msgCostCny(m: AssistantMessage): number {
	if (m.provider === "deepseek") return deepseekCostCny(m.usage, m.model, m.timestamp);
	return m.usage.cost.total * EXCHANGE_RATE;
}

/** 按量付费：¥/min + 累计（成本均为人民币元：DeepSeek 官方定价直算，其余 USD×EXCHANGE_RATE） */
function meteredRateText(ctx: ExtensionContext, now: number): RateTextPart[] | null {
	const t = sumSessionUsage(ctx);
	if (t.turns === 0) return null;
	const rate = computeRate(now);
	const perMin = rate ?? 0; // 人民币元/分钟（costEvents 记录的是人民币成本增量）
	const total = t.costTotalCny;
	return [
		{ text: `¥${perMin.toFixed(3)}/min`, color: "muted" },
		{ text: `¥${total.toFixed(2)}`, color: "dim" },
	];
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
const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
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
		if (!key) throw new Error("未配置 API key 或 OAuth（请设置 KIMI_API_KEY 环境变量或执行 /login kimi-coding）");

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
		if (summary && summary.limit > 0) {
			const ratio = summary.used / summary.limit;
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

/** 已适配的供应商注册表。新增供应商在这里追加一个 adapter 即可。 */
const BALANCE_ADAPTERS: Record<string, BalanceAdapter> = {
	[deepseekAdapter.providerId]: deepseekAdapter,
	[kimiCodingAdapter.providerId]: kimiCodingAdapter,
	[moonshotaiAdapter.providerId]: moonshotaiAdapter,
	[moonshotaiCnAdapter.providerId]: moonshotaiCnAdapter,
	[xiaomiTokenPlanCnAdapter.providerId]: xiaomiTokenPlanCnAdapter,
};

// ---------------------------------------------------------------------------
// git 状态
// ---------------------------------------------------------------------------

interface GitStats {
	branch: string | null;
	staged: number; // 暂存区
	unstaged: number; // 工作区（已修改未暂存）
	untracked: number; // 未跟踪
	ahead: number; // 领先远程
	behind: number; // 落后远程
}

/** 解析 `git status --porcelain=v1 --branch` 输出。 */
function parseGitStatus(stdout: string): GitStats {
	const lines = stdout.split(/\r?\n/);
	const first = lines[0] ?? "";
	let branch: string | null = null;
	const branchM = first.match(/^## (.+?)(?:\.\.\.|$)/);
	if (branchM) {
		const raw = branchM[1];
		// 尚未提交的仓库：git 输出 "No commits yet on <branch>" / "Initial commit on <branch>"
		const noCommit = raw.match(/^(?:No commits yet|Initial commit) on (.+)$/);
		branch = noCommit ? noCommit[1] : raw === "HEAD (no branch)" ? "HEAD" : raw;
	}
	let staged = 0,
		unstaged = 0,
		untracked = 0;
	for (const line of lines.slice(1)) {
		if (!line) continue;
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked++;
			continue;
		}
		if (x !== " " && x !== "?") staged++;
		if (y !== " " && y !== "?") unstaged++;
	}
	const ahead = first.match(/ahead (\d+)/);
	const behind = first.match(/behind (\d+)/);
	return {
		branch,
		staged,
		unstaged,
		untracked,
		ahead: ahead ? Number(ahead[1]) : 0,
		behind: behind ? Number(behind[1]) : 0,
	};
}

// ---------------------------------------------------------------------------
// HUD 状态与渲染
// ---------------------------------------------------------------------------

type BalanceState =
	| { loading: boolean; providerId?: string; data?: BalanceData; error?: string; unsupported?: boolean; fetchedAt?: number };

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 定时刷新
const TURN_REFRESH_THROTTLE_MS = 60 * 1000; // turn 结束后的刷新节流
const EXCHANGE_RATE = 7.2; // USD → CNY 近似汇率（pi 成本为 USD，余额为 CNY），可自行校准
const GIT_REFRESH_INTERVAL_MS = 5_000; // git 状态刷新间隔
const LEFT_LABEL_W = 15; // 左侧标签栏固定宽度（⎇ master / [DeepSeek] / 余额 ¥x.xx）
const RIGHT_SEG1 = 22; // 右侧分栏：第一个分隔符前的固定宽度
const RIGHT_SEG2 = 16; // 右侧分栏：第二个分隔符前的固定宽度
const RIGHT_TOTAL = 41; // 右侧区域总宽度（三行分隔符垂直对齐）
const THINKING_LABEL: Record<string, string> = {
	off: "off",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

export default function (pi: ExtensionAPI) {
	let footerInstalled = false;
	// setFooter 工厂参数（首次渲染时注入），用于异步刷新后请求重绘
	let tuiRef: { requestRender(): void } | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let gitTimer: ReturnType<typeof setInterval> | undefined;
	let gitStats: GitStats | null = null;
	let gitInflight = false;
	// 动态区样式表（官方 setStatus 通道的呈现层约定）：
	// 扩展经 ctx.ui.setStatus(key, text) 推送状态，hud 渲染行 1 动态区时按 key 查样式
	// （颜色 + 优先级，数字大者胜出）；TTL/闪烁由各推送方自管（setStatus 触发全局重绘，零延迟可见）。
	// 未登记 key 默认灰字、priority 0（基本不显示）。
	const STATUS_STYLE: Record<string, { color: string; priority: number }> = {
		"hud-bash": { color: "warning", priority: 100 }, // 指令模式提示（输入以 ! 开头）
		"balance-error": { color: "error", priority: 95 }, // 余额查询失败
		"task-alert": { color: "success", priority: 90 }, // 任务完成（task-alert 自管闪烁帧）
		"explore": { color: "accent", priority: 85 }, // explore 子代理进度
		"init": { color: "warning", priority: 80 }, // claude-it /init 进度
		"web-search": { color: "accent", priority: 75 }, // 联网搜索状态
		"token-saver": { color: "muted", priority: 70 }, // 节省量反馈
		"model-switch": { color: "accent", priority: 70 }, // 模型切换
	};
	/** 短时状态推送 + TTL 自动清除（hud 内部自用；各扩展的 TTL 由扩展自己管）。 */
	const statusClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
	function pushStatus(ctx: ExtensionContext, key: string, text: string, ttlMs: number) {
		ctx.ui.setStatus(key, text);
		const old = statusClearTimers.get(key);
		if (old) clearTimeout(old);
		statusClearTimers.set(
			key,
			setTimeout(() => ctx.ui.setStatus(key, undefined), ttlMs),
		);
	}
	let lastBalanceError = ""; // 上次余额查询错误（变化时才推送动态区警告，防刷屏）
	let balance: BalanceState = { loading: false };
	let inflight = false;
	let lastAutoRefresh = 0;
	const fmtTime = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
	const fmtDuration = (ms: number): string => {
		const m = Math.floor(ms / 60_000);
		if (m < 1) return "<1min";
		if (m < 60) return `${m}min`;
		const h = Math.floor(m / 60);
		const rm = m % 60;
		if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
		return `${Math.floor(h / 24)}d`;
	};

	/** 当前会话累计成本（人民币元），供速率事件与 /hud 展示使用。 */
	function sumCost(ctx: ExtensionContext): number {
		let total = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				total += msgCostCny(e.message as AssistantMessage);
			}
		}
		return total;
	}

	/** 拉取当前供应商的余额（含节流与并发保护）。 */
	async function refreshBalance(ctx: ExtensionContext) {
		const provider = ctx.model?.provider;
		if (inflight) return;
		if (!provider) {
			balance = { loading: false, unsupported: true, providerId: undefined };
			lastAutoRefresh = Date.now();
			tuiRef?.requestRender();
			return;
		}

		const adapter = BALANCE_ADAPTERS[provider];
		if (!adapter) {
			balance = { loading: false, providerId: provider, unsupported: true };
			lastAutoRefresh = Date.now();
			tuiRef?.requestRender();
			return;
		}

		inflight = true;
		balance = { loading: true, providerId: provider };
		tuiRef?.requestRender();
		try {
			const data = await adapter.fetch(ctx);
			balance = { loading: false, providerId: provider, data, fetchedAt: Date.now() };
			lastBalanceError = ""; // 查询成功，重置错误记忆
		} catch (err) {
			balance = {
				loading: false,
				providerId: provider,
				error: err instanceof Error ? err.message : String(err),
				fetchedAt: Date.now(),
			};
			// 动态区警告：错误内容变化时才推送，避免持续失败刷屏（TTL 15s 自动消失）
			const msg = err instanceof Error ? err.message : String(err);
			if (lastBalanceError !== msg) {
				lastBalanceError = msg;
				pushStatus(ctx, "balance-error", "⚠ 余额查询失败", 15_000);
			}
		} finally {
			inflight = false;
			lastAutoRefresh = Date.now();
			tuiRef?.requestRender();
		}
	}

	/** 采集当前 git 状态（分支 + 暂存/工作区/未跟踪文件数）。 */
	async function refreshGitStats(ctx: ExtensionContext) {
		if (gitInflight) return;
		gitInflight = true;
		try {
			const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], {
				cwd: ctx.cwd,
				timeout: 5000,
				windowsHide: true,
			});
			gitStats = parseGitStatus(stdout);
		} catch {
			gitStats = null; // 非 git 仓库或 git 不可用
		} finally {
			gitInflight = false;
			tuiRef?.requestRender();
		}
	}

	// （setDynamic/clearDynamic 已随动态区迁移移除：短时消息统一走 ctx.ui.setStatus + pushStatus）

	/** 余额行的纯文本描述（用于 /balance 的 notify）。 */
	function describeBalance(): string {
		const b = balance;
		if (b.loading) return "余额：查询中…";
		if (b.unsupported) return `余额：${b.providerId ?? "?"} 未适配（已适配: ${Object.keys(BALANCE_ADAPTERS).join(", ")}）`;
		if (b.error) return `余额：获取失败（${b.error}）`;
		if (b.data) {
			const amount = b.data.amount.startsWith("CNY ") ? `¥${b.data.amount.slice(4)}` : b.data.amount;
			const prefix = b.data.hideLabel ? "" : "余额：";
			return `${prefix}${amount}${b.data.detail ? `（${b.data.detail}）` : ""}`;
		}
		return "余额：-";
	}

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			footerInstalled = true;
			const unsubBranch = footerData.onBranchChange(() => {
				void refreshGitStats(ctx);
				tui.requestRender();
			});

			// 指令模式提示（近似 Claude Code）：输入以 ! 开头时在 HUD 高亮提醒。
			// 通过原始终端输入流近似跟踪输入内容（对英文命令准确，IME 组合输入期间可能滞后）。
			let inputBuffer = "";
			let bashModeHint = false;
			const unsubInput = ctx.ui.onTerminalInput((data) => {
				if (data === "\r" || data === "\n") {
					inputBuffer = ""; // 回车提交
				} else if (data === "\x7f" || data === "\b") {
					inputBuffer = inputBuffer.slice(0, -1); // 退格
				} else if (data === "\x03" || data === "\x15" || data === "\x17") {
					inputBuffer = ""; // ctrl+c / ctrl+u / ctrl+w
				} else if (data.length === 1 && data >= " " && data <= "~") {
					inputBuffer += data; // 可见 ASCII 字符
				}
				const isBash = inputBuffer.trimStart().startsWith("!");
				if (isBash !== bashModeHint) {
					bashModeHint = isBash;
					if (isBash) ctx.ui.setStatus("hud-bash", "⚡ 指令模式");
					else ctx.ui.setStatus("hud-bash", undefined);
				}
			});

			// 首次安装立即拉取，之后定时刷新
			void refreshBalance(ctx);
			if (refreshTimer) clearInterval(refreshTimer);
			refreshTimer = setInterval(() => void refreshBalance(ctx), REFRESH_INTERVAL_MS);
			void refreshGitStats(ctx);
			if (gitTimer) clearInterval(gitTimer);
			gitTimer = setInterval(() => void refreshGitStats(ctx), GIT_REFRESH_INTERVAL_MS);

			const layout = (left: string, right: string, width: number): string => {
				if (!right) return left;
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
				return left + pad + right;
			};
			const padTo = (str: string, w: number): string => str + " ".repeat(Math.max(0, w - visibleWidth(str)));
			// 右对齐：内容紧贴分隔线
			const padLeft = (str: string, w: number): string => " ".repeat(Math.max(0, w - visibleWidth(str))) + str;

			// 上下文进度条：1/8 精度块字符，颜色随占用率渐变，空位用空格保持固定宽度
			const BAR_BLOCKS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"];
			const pctColor = (pct: number): "success" | "accent" | "warning" | "error" =>
				pct > 90 ? "error" : pct > 75 ? "warning" : pct > 50 ? "accent" : "success";
			const progressBar = (pct: number, width = 10): string => {
				const total = width * 8; // 每格 8 细分
				const filled = Math.max(0, Math.min(total, Math.round((pct / 100) * total)));
				const full = Math.floor(filled / 8);
				const part = filled % 8;
				const empty = Math.max(0, width - full - (part ? 1 : 0)); // 剩余整块用空格占位
				const color = pctColor(pct);
				let s = theme.fg(color, "█".repeat(full));
				if (part) s += theme.fg(color, BAR_BLOCKS[part - 1]);
				s += " ".repeat(empty);
				return s;
			};

			const renderBalanceLine = (): string => {
				const b = balance;
				const label = theme.fg("dim", "余额");
				if (b.loading) return `${label} 查询中…`;
				if (b.unsupported) return `${label} ${b.providerId ?? "?"} 未适配（余额/plan 查询）`;
				if (b.error) return `${label} 获取失败（${b.error}）`;
				if (b.data) {
					const color = b.data.status === "ok" ? "success" : b.data.status === "warning" ? "warning" : "error";
					// 多维度额度条（如 Kimi 的周额度 + 5 小时频限）用抽象 gauge 展示
					if (b.data.quotas && b.data.quotas.length > 0) {
						const amountText = b.data.amount.startsWith("CNY ") ? `¥${b.data.amount.slice(4)}` : b.data.amount;
						// 只有加油包余额才额外显示金额；否则 quotas 自身已包含额度信息
						const amountPart = amountText.startsWith("¥") ? `${theme.fg(color, amountText)}` : "";
						const pct = (used: number, limit: number) => (limit > 0 ? Math.round((used / limit) * 100) : 0);
						const gauge = (used: number, limit: number, width = 5) => {
							if (limit <= 0) return theme.fg("dim", "▱".repeat(width));
							const p = pct(used, limit);
							const filled = Math.max(0, Math.min(width, Math.round((used / limit) * width)));
							const c = pctColor(p);
							return theme.fg(c, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(width - filled));
						};
						const qText = b.data.quotas
							.map((q) => {
								const p = pct(q.used, q.limit);
								const c = pctColor(p);
								return `${gauge(q.used, q.limit)} ${theme.fg("dim", q.label)} ${theme.fg(c, `${p}%`)}`;
							})
							.join(` ${theme.fg("dim", "·")} `);
						const parts = [label, amountPart, qText].filter(Boolean);
						return parts.join(" ");
					}
					// 币种友好显示：CNY → ¥
					const amountText = b.data.amount.startsWith("CNY ") ? `¥${b.data.amount.slice(4)}` : b.data.amount;
					const amount = theme.fg(color, amountText);
					const detail = b.data.detail ? ` ${theme.fg("dim", b.data.detail)}` : "";
					const prefix = b.data.hideLabel ? "" : `${label} `;
					return `${prefix}${amount}${detail}`;
				}
				return `${label} -`;
			};

			const renderGitLine = (): string => {
				if (!gitStats) return theme.fg("dim", "⎇ -");
				const g = gitStats;
				const badge = theme.fg("accent", `⎇ ${g.branch ?? "HEAD"}`);
				const parts: string[] = [];
				if (g.ahead || g.behind) parts.push(theme.fg("dim", `领先${g.ahead} 落后${g.behind}`));
				if (g.staged) parts.push(theme.fg("success", `暂存${g.staged}`));
				if (g.unstaged) parts.push(theme.fg("warning", `修改${g.unstaged}`));
				if (g.untracked) parts.push(theme.fg("muted", `未跟踪${g.untracked}`));
				return parts.length
					? `${badge}${theme.fg("dim", " ・ ")}${parts.join(theme.fg("dim", " ・ "))}`
					: badge;
			};

			// 动态区（信息屏B）：读官方 setStatus 通道的状态，按样式表取优先级最高者；
			// 固定宽度，空闲时显示会话时长占位。TTL 由各推送方自管，无需本处清理。
			const renderStatuses = (): string => {
				let best: { text: string; color?: string; priority: number } | null = null;
				for (const [key, text] of footerData.getExtensionStatuses()) {
					if (!text) continue;
					const style = STATUS_STYLE[key];
					const priority = style?.priority ?? 0;
					if (!best || priority > best.priority) best = { text, color: style?.color, priority };
				}
				if (!best) {
					const tip = truncateToWidth(`会话 ${fmtDuration(Date.now() - startupTime)}`, RIGHT_SEG2, "");
					return theme.fg("muted", tip) + " ".repeat(RIGHT_SEG2 - visibleWidth(tip));
				}
				const truncated = truncateToWidth(best.text, RIGHT_SEG2, "");
				const content = best.color ? theme.fg(best.color as never, truncated) : truncated;
				return content + " ".repeat(RIGHT_SEG2 - visibleWidth(truncated));
			};

			return {
				dispose() {
					unsubBranch();
					unsubInput();
					footerInstalled = false;
					if (refreshTimer) {
						clearInterval(refreshTimer);
						refreshTimer = undefined;
					}
					if (gitTimer) {
						clearInterval(gitTimer);
						gitTimer = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model;

					// ---- 行 1：git 状态 + 项目名 + 动态区 ----
					const left1 = renderGitLine();
					const project = ctx.cwd.split(/[\\/]/).filter(Boolean).pop() || ctx.cwd;
					const right1 = `${padLeft(project ? theme.fg("dim", `📁 ${project}`) : "", RIGHT_SEG1)}${theme.fg("dim", " │ ")}${renderStatuses()}`;

					// ---- 行 2：模型 + 用量 + 上下文 ----
					const providerDisplay = model
						? ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider
						: "no-model";
					const thinkingTag = ctx.thinkingLevel
						? theme.fg("dim", `(${THINKING_LABEL[ctx.thinkingLevel] ?? ctx.thinkingLevel})`)
						: "";
					const left2 =
						theme.fg("accent", `[${providerDisplay}]`) +
						" " +
						theme.fg("text", model?.id ?? "未选择模型") +
						(thinkingTag ? ` ${thinkingTag}` : "");

					let input = 0,
						output = 0,
						cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cost += msgCostCny(m);
						}
					}
					const tokensSeg = (() => {
						const tokenRate = computeTokenRate(Date.now()) ?? 0;
						const rateStr =
							tokenRate >= 1000
								? `${fmtNum(tokenRate)}/s`
								: tokenRate >= 100
									? `${tokenRate.toFixed(1)}/s`
									: `${tokenRate.toFixed(2)}/s`;
						return `${theme.fg("muted", `↑${fmtNum(input)}`)} ${theme.fg("muted", `↓${fmtNum(output)}`)} ${theme.fg("muted", rateStr)}`;
					})();

					const usage = ctx.getContextUsage();
					// ctx 段固定总宽：`[bar] tail` 恒为 16 格，分割线不偏移。
					// 百分比自适应位置：进度条空白够时嵌入空白最左侧（`[██ 20%    ] 1m`），
					// 空白不足（进度快满）时替换尾部上下文大小（`[█████████▏] 90%`）。
					const ctxSeg = (() => {
						const pctRaw = usage?.percent;
						const pct = pctRaw != null ? Math.round(pctRaw) : 0;
						const pctText = `${pct}%`;
						const pctWidth = visibleWidth(pctText);
						const windowText = usage?.contextWindow != null ? fmtNum(usage.contextWindow) : null;

						// 无上下文窗口大小时退化为原逻辑：尾部显示百分比或 0
						if (windowText == null) {
							const numText = pctRaw != null ? pctText : "0";
							const barWidth = Math.max(3, RIGHT_SEG2 - 3 - visibleWidth(numText));
							return `[${progressBar(pct, barWidth)}] ${numText}`;
						}
						// 未返回百分比：空条 + 上下文大小（原样）
						if (pctRaw == null) {
							const barWidth = Math.max(3, RIGHT_SEG2 - 3 - visibleWidth(windowText));
							return `[${progressBar(0, barWidth)}] ${windowText}`;
						}

						const barWidth = Math.max(3, RIGHT_SEG2 - 3 - visibleWidth(windowText));
						// 已占用格数（满格 + 半格），与 progressBar 内部计算一致
						const total = barWidth * 8;
						const filledCells = Math.round((pct / 100) * total);
						const used = Math.floor(filledCells / 8) + (filledCells % 8 ? 1 : 0);
						const empty = Math.max(0, barWidth - used);

						if (empty >= pctWidth + 1) {
							// 方案 A：百分比嵌入进度条空白最左侧，尾部保留上下文大小
							const bar = progressBar(pct, barWidth);
							const core = bar.slice(0, bar.length - empty); // 去掉尾部空白（实体部分）
							const rest = " ".repeat(empty - (pctWidth + 1));
							return `[${core}${theme.fg("dim", ` ${pctText}`)}${rest}] ${windowText}`;
						}
						// 方案 B：进度条占满可用宽度，百分比替换尾部上下文大小
						const barWidthB = Math.max(3, RIGHT_SEG2 - 3 - pctWidth);
						return `[${progressBar(pct, barWidthB)}] ${pctText}`;
					})();
					const right2 = `${padLeft(tokensSeg, RIGHT_SEG1)}${theme.fg("dim", " │ ")}${padTo(ctxSeg, RIGHT_SEG2)}`;

					// ---- 行 3：账户（余额 / plan）+ 消耗统计 ----
					const left3 = renderBalanceLine();
					// 消耗统计按 provider 单独适配（adapter.rateText）
					const adapter = ctx.model?.provider ? BALANCE_ADAPTERS[ctx.model.provider] : undefined;
					const rateText = adapter?.rateText
						? (adapter.rateText(ctx, Date.now()) ?? [])
								.map((p) => theme.fg((p.color ?? "muted") as never, p.text))
								.join(" ")
						: "";
					const timeText = balance.fetchedAt ? theme.fg("dim", fmtTime(balance.fetchedAt)) : "";
					const right3 = timeText
						? `${padLeft(rateText, RIGHT_SEG1)}${theme.fg("dim", " │ ")}${padTo(timeText, RIGHT_TOTAL - RIGHT_SEG1 - 3)}`
						: padLeft(rateText, RIGHT_TOTAL);

					const line1 = layout(left1, right1, width);
					const line2 = layout(left2, right2, width);
					const line3 = layout(left3, right3, width);
					return [line1, line2, line3].map((l) => truncateToWidth(l, width));
				},
			};
		});
	}

	// ---- thinking 折叠标签动画 ----
	let thinkingAnimTimer: ReturnType<typeof setInterval> | undefined;
	let thinkingDots = 0;

	function startThinkingAnimation(ctx: ExtensionContext) {
		stopThinkingAnimation();
		const tick = () => {
			thinkingDots = (thinkingDots % 4) + 1;
			ctx.ui.setHiddenThinkingLabel(`Thinking${".".repeat(thinkingDots)}`);
		};
		tick();
		thinkingAnimTimer = setInterval(tick, 400);
	}

	function stopThinkingAnimation(ctx?: ExtensionContext) {
		if (thinkingAnimTimer) {
			clearInterval(thinkingAnimTimer);
			thinkingAnimTimer = undefined;
		}
		if (ctx) ctx.ui.setHiddenThinkingLabel(); // 恢复默认标签
	}

	// ---- 生命周期 ----
	pi.on("session_start", async (_event, ctx) => {
		// 重置速率统计（避免 resume 旧会话时把历史成本当成首轮增量）
		startupTime = Date.now();
		lastRecordedTotal = sumCost(ctx);
		lastRecordedOutputTotal = sumOutputTokens(ctx);
		costEvents = [];
		turnStartTime = null;
		smoothedTokenRate = null;
		if (ctx.mode !== "tui") return;
		installFooter(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnStartTime = Date.now();
		startThinkingAnimation(ctx);
	});

pi.on("turn_end", async (_event, ctx) => {
		stopThinkingAnimation(ctx); // 思考结束，停止动画、恢复默认标签
		// 记录本 turn 消耗，滚动维护 10 分钟窗口
		const total = sumCost(ctx);
		const delta = total - lastRecordedTotal;
		lastRecordedTotal = total;
		if (delta > 0) {
			costEvents.push({ ts: Date.now(), cost: delta });
			const cutoff = Date.now() - RATE_WINDOW_MS;
			costEvents = costEvents.filter((e) => e.ts >= cutoff);
		}
		// 记录本 turn 输出 token 与耗时，用 EMA 平滑得到第 2 行 output tok/s 速率
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
		if (!footerInstalled) return;
		if (Date.now() - lastAutoRefresh > TURN_REFRESH_THROTTLE_MS) void refreshBalance(ctx);
		void refreshGitStats(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		balance = { loading: false }; // 供应商可能变化，丢弃旧缓存
		tuiRef?.requestRender();
		// 动态区提示模型切换（3 秒 TTL 自动消失）
		if (ctx.model?.id) pushStatus(ctx, "model-switch", `⇄ ${ctx.model.id}`, 3_000);
		if (footerInstalled) void refreshBalance(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopThinkingAnimation();
		for (const t of statusClearTimers.values()) clearTimeout(t);
		statusClearTimers.clear();
		if (gitTimer) {
			clearInterval(gitTimer);
			gitTimer = undefined;
		}
	});

	// ---- 命令 ----
	pi.registerCommand("balance", {
		description: "立即刷新账户余额 / plan 余量并通知",
		handler: async (_args, ctx) => {
			await refreshBalance(ctx);
			ctx.ui.notify(
				describeBalance(),
				balance.data?.status === "error" ? "error" : balance.data?.status === "warning" ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("hud", {
		description: "切换 3 行 HUD 状态栏",
		handler: async (_args, ctx) => {
			if (footerInstalled) {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("3 行 HUD 已关闭", "info");
			} else {
				installFooter(ctx);
				ctx.ui.notify("3 行 HUD 已开启", "info");
			}
		},
	});

	pi.registerCommand("balance-debug", {
		description: "调试当前供应商余额接口（打印原始响应）",
		handler: async (_args, ctx) => {
			const provider = ctx.model?.provider;
			if (!provider || !BALANCE_ADAPTERS[provider]) {
				ctx.ui.notify(`当前 provider ${provider ?? "unknown"} 未适配，无法调试`, "warning");
				return;
			}
			// 余额接口定义：kimi-coding 走订阅 /v1/usages；moonshot 走按量 /v1/users/me/balance
			const endpoint =
				provider === "kimi-coding"
					? `${KIMI_CODING_BASE_URL}/usages`
					: provider === "moonshotai"
						? "https://api.moonshot.ai/v1/users/me/balance"
						: provider === "moonshotai-cn"
							? "https://api.moonshot.cn/v1/users/me/balance"
							: undefined;
			if (!endpoint) {
				ctx.ui.notify(`${provider} 暂无调试端点`, "warning");
				return;
			}
			const auth = await ctx.modelRegistry.getProviderAuth(provider);
			const key = auth?.auth.apiKey ?? auth?.auth.headers?.Authorization?.replace(/^Bearer\s+/i, "");
			if (!key) {
				ctx.ui.notify(
					`认证来源 ${auth?.source ?? "无"}，但没有 bearer token（未配置 API key 或 OAuth）`,
					"error",
				);
				return;
			}
			ctx.ui.notify(`认证来源: ${auth?.source ?? "未知"}，准备请求 ${endpoint}...`, "info");
			try {
				const res = await fetch(endpoint, {
					headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
					signal: AbortSignal.timeout(10_000),
				});
				const text = await res.text();
				ctx.ui.notify(`HTTP ${res.status}: ${text.slice(0, 400)}`, res.ok ? "info" : "error");
			} catch (err) {
				ctx.ui.notify(`请求失败: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
