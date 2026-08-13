/**
 * web-tool/dislike：搜索结果差评（动态黑名单）（web-tool 多文件扩展的组成部分）
 *
 * 职责：
 * - 差评数据持久化（~/.pi/agent/web-search-blacklist.json，web_dislike 写入、跨会话生效）
 * - 降权系数计算（×DECAY^count，达封禁阈值直接滤除）、域名后缀匹配（差评 blog.csdn.net
 *   同样作用于 sub.blog.csdn.net）
 *
 * 注意：本模块不注册任何 pi API，仅导出纯函数/常量，由本目录其它模块与入口驱动。
 */
import * as os from "node:os";
import * as path from "node:path";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";

/** 搜索结果差评（动态黑名单）持久化文件（web_dislike 写入，跨会话生效；/web-tool-config 面板查看，Delete 清空） */
const DISLIKE_FILE = path.join(os.homedir(), ".pi", "agent", "web-search-blacklist.json");

/** 差评降权衰减系数：score × DISLIKE_DECAY^count（1 次 ×0.6，2 次 ×0.36，3 次 ×0.22…） */
export const DISLIKE_DECAY = 0.6;
/** 差评累计达到该次数：直接滤除该域名条目（评分归 0，不再出现在结果中） */
export const DISLIKE_BAN_THRESHOLD = 5;

/** 差评数据结构：{ 域名: { count: 差评次数, reasons: 差评原因追踪 } } */
function isDislikeData(v: unknown): v is Record<string, { count: number; reasons: string[] }> {
	if (v === null || typeof v !== "object") return false;
	return Object.values(v as Record<string, unknown>).every((d) => {
		if (d === null || typeof d !== "object") return false;
		const o = d as { count?: unknown; reasons?: unknown };
		return typeof o.count === "number" && Array.isArray(o.reasons) && o.reasons.every((r) => typeof r === "string");
	});
}

/** 读取差评数据（文件缺失/损坏返回空表） */
export function loadDislikeData(): Record<string, { count: number; reasons: string[] }> {
	return loadJsonConfig<Record<string, { count: number; reasons: string[] }>>(DISLIKE_FILE, {}, isDislikeData);
}

/** 保存差评数据 */
export function saveDislikeData(data: Record<string, { count: number; reasons: string[] }>): void {
	saveJsonConfig(DISLIKE_FILE, data);
}

/** 从域名或结果 URL 提取差评键（去 www.；URL 则取 hostname） */
export function dislikeKey(input: string): string {
	const s = input.trim();
	try {
		if (/^https?:\/\//i.test(s)) return new URL(s).hostname.replace(/^www\./i, "").toLowerCase();
	} catch { /* 非法 URL 按域名处理 */ }
	return s.replace(/^www\./i, "").toLowerCase().replace(/[\/?#].*$/, "");
}

/** 结果的 hostname（降权匹配用） */
export function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

/** 差评降权系数：按 hostname 与差评域名的后缀匹配取最大差评次数（差评 blog.csdn.net 同样作用于
 *  sub.blog.csdn.net）；达到封禁阈值返回 0（滤除） */
export function dislikePenalty(host: string, data: Record<string, { count: number; reasons: string[] }>): number {
	const key = host.replace(/^www\./i, "").toLowerCase();
	let maxCount = 0;
	for (const domain of Object.keys(data)) {
		if (key === domain || key.endsWith("." + domain)) maxCount = Math.max(maxCount, data[domain]!.count);
	}
	if (maxCount >= DISLIKE_BAN_THRESHOLD) return 0;
	return Math.pow(DISLIKE_DECAY, maxCount);
}
