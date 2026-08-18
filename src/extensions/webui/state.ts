/**
 * webui 状态快照：浏览器端状态栏的数据源
 *
 * 复用 hud 子模块（build.js 内联进产物，运行时零耦合）：
 * - hud-balance 的 BALANCE_ADAPTERS：按 provider 查余额（fetch 需 ctx，调用方在事件处理器里）
 * - hud-cost 的消耗统计（sumSessionUsage / meteredRateText / 汇率三态）
 * - hud-git 的 git 状态解析（getDetailedGitStatus，纯 cwd 级）
 *
 * git / 余额带模块级节流缓存（避免高频轮询打爆 API），成本统计直接透传 hud-cost
 * 的计算结果——webui 产物内联的是 hud-cost 独立实例，但事件源相同（turn_start/end
 * 全局事件），统计结果与 hud 一致。
 */
import { BALANCE_ADAPTERS, type BalanceData } from "../hud/hud-balance";
import {
	sumSessionUsage,
	meteredRateText,
	getUsdCnyRate,
	getRateSource,
	type RateSource,
	type RateTextPart,
} from "../hud/hud-cost";
import { getDetailedGitStatus, type GitDetailedStatus } from "../hud/hud-git";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 浏览器端展示的成本统计（hud-cost SessionUsageTotals 的镜像，字段名对齐） */
export interface WebuiCost {
	input: number;
	output: number;
	cacheRead: number;
	costTotalCny: number;
	costTotalUsd: number;
	turns: number;
	/** 按量付费文本（meteredRateText 的纯文本拼接） */
	rateText: string;
	usdCny: number | null;
	rateSource: RateSource;
	uptimeSec: number;
}

/** 浏览器端状态快照（GET /api/state 与 SSE snapshot 事件的载荷） */
export interface WebuiSnapshot {
	cwd: string;
	sessionName: string;
	sessionFile: string | null;
	model: { provider: string; id: string } | null;
	thinkingLevel: string;
	idle: boolean;
	git: GitDetailedStatus | null;
	balance: { provider: string; data: BalanceData | null; error: string | null } | null;
	cost: WebuiCost;
	uptimeSec: number;
}

const GIT_REFRESH_MS = 30_000; // git 状态刷新节流
const BALANCE_REFRESH_MS = 60_000; // 余额查询节流（各家 API 免费但避免高频）

let gitCache: { at: number; data: GitDetailedStatus | null } = { at: 0, data: null };
// 余额缓存记录 provider：切换模型（provider 变化）时立即失效重查，避免显示旧 provider 的余额
let balanceCache: { at: number; provider: string; data: BalanceData | null; error: string | null } = { at: 0, provider: "", data: null, error: null };

/** 构造状态快照；git/余额走节流缓存，成本实时计算 */
export async function buildSnapshot(ctx: ExtensionContext, pi: ExtensionAPI): Promise<WebuiSnapshot> {
	const now = Date.now();

	// git（30s 节流；非 git 仓库返回 null）
	if (now - gitCache.at > GIT_REFRESH_MS) {
		gitCache = { at: now, data: await getDetailedGitStatus(ctx.cwd) };
	}

	// 余额（60s 节流；无适配器的 provider 返回 null）
	const provider = ctx.model?.provider ?? "";
	let balance: WebuiSnapshot["balance"] = null;
	if (provider) {
		const adapter = BALANCE_ADAPTERS[provider];
		if (adapter) {
			if (now - balanceCache.at > BALANCE_REFRESH_MS || balanceCache.provider !== provider) {
				try {
					const data = await adapter.fetch(ctx);
					balanceCache = { at: now, provider, data, error: null };
				} catch (e) {
					balanceCache = { at: now, provider, data: null, error: e instanceof Error ? e.message : String(e) };
				}
			}
			balance = { provider, data: balanceCache.data, error: balanceCache.error };
		} else {
			balance = { provider, data: null, error: null }; // 无适配器：显示「无余额接口」
		}
	}

	// 成本（hud-cost 计算，含 DeepSeek 官方人民币价直算与汇率三态）
	const t = sumSessionUsage(ctx);
	const parts: RateTextPart[] | null = meteredRateText(ctx, Date.now());
	const rateText = parts ? parts.map((p) => p.text).join(" ") : "";

	return {
		cwd: ctx.cwd,
		sessionName: ctx.sessionManager.getSessionName() ?? "",
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
		thinkingLevel: String(ctx.thinkingLevel ?? "off"),
		idle: ctx.isIdle(),
		git: gitCache.data,
		balance,
		cost: {
			input: t.input,
			output: t.output,
			cacheRead: t.cacheRead,
			costTotalCny: t.costTotalCny,
			costTotalUsd: t.costTotalUsd,
			turns: t.turns,
			rateText,
			usdCny: getUsdCnyRate(),
			rateSource: getRateSource(),
			uptimeSec: Math.round((Date.now() - getStartup()) / 1000),
		},
		uptimeSec: Math.round((Date.now() - getStartup()) / 1000),
	};
}

let startup = Date.now();

/** 扩展启动时间（供状态栏显示会话时长；reload 会重置，可接受） */
export function getStartup(): number {
	return startup;
}
