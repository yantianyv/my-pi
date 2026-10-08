/**
 * shared/llm.ts：单次 LLM 调用公共服务（一次型调用，不占主会话上下文）
 *
 * 面向扩展里「AI 审核 / 概括 / 压缩 / 生成」这类一次成型的模型调用：内部统一完成
 * 认证获取（每次调用前从模型注册表取最新认证，兼容 OAuth 刷新）→ 请求头注入 →
 * completeSimple → 文本块抽取。失败不抛异常，返回结构化结果，降级/回退/静默语义
 * 由调用方决定。
 *
 * 请求头必须走本模块：pi 主会话的请求头管道按供应商规则表注入会话/归因头，其中
 * opencode/opencode-go 系的 x-opencode-session 是功能必需头，缺失直接 400
 * MissingSessionID（现象即「AI 审核/概括永远失败降级」）——扩展侧裸调 completeSimple
 * 不经此管道是该类故障的根因。
 *
 * 这里不提供输出上限（maxTokens）参数，也不得另开：推理模型的思考 token 计入该预算，
 * 小上限会把预算吃在思考阶段，导致正文为空或 JSON 被截断（现象是「解析失败→降级」）。
 * 成本用模型策略槽（LITE/BATCH…）控制，输出长度用提示词约束——与 pi 主会话同一口径。
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AnyModel } from "./model-util";
import { modelRef } from "./model-util";
import type { Message } from "@earendil-works/pi-ai";

export type AiCompleteResult = { ok: true; text: string } | { ok: false; error: string };

/** 模型候选链（`shared/model-setting` 的 resolve 结果即此形状）：首选 + 依次取下一个 */
export interface AiModelChain {
	model?: AnyModel;
	failover: () => AnyModel | undefined;
}

export interface AiCompleteOptions {
	/** 系统提示词 */
	systemPrompt: string;
	/** 用户消息正文（单条消息，调用方自行截断） */
	prompt: string;
	temperature?: number;
	/** 可选的额外超时（毫秒）：不设就是不给时间上限，由 ctx.signal（用户中断）決定何时停 */
	timeoutMs?: number;
	/** 多个文本块的拼接符（status-beacon 等 prefer ""，默认 "\n"） */
	textJoin?: "\n" | "";
	/** 输出验收：返回 false 则视为本次尝试不合格，换下一个候选模型重试（如要求可解析的 JSON） */
	validate?: (text: string) => boolean;
}

/** 从 result.content 抽纯文本；join 后 trim，全部为空返回 ""。独立导出便于离线测试。 */
export function extractAiText(blocks: unknown, join = "\n"): string {
	if (!Array.isArray(blocks)) return "";
	return blocks
		.filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
		.map((b) => b.text)
		.join(join)
		.trim();
}

// ---------------------------------------------------------------------------
// 供应商归因/会话头（与主会话同一条头管道，不逐供应商硬编码）
// ---------------------------------------------------------------------------

// pi 主会话的请求头管道在 dist/core/provider-attribution.js 的 mergeProviderAttributionHeaders：
// 按供应商规则表统一注入（opencode/opencode-go 系的 x-opencode-session 是功能必需头，缺失直接
// 400 MissingSessionID；OpenRouter/NIM/Cloudflare 的归因头为遥测可选）。该函数未从包主入口
// 公开导出且 package.json exports 封锁深路径（动态 import 报 ERR_PACKAGE_PATH_NOT_EXPORTED，
// jiti 下已实测），故按「process.argv[1]（pi 入口 cli.js）向上定位包根 → 按文件路径 require」
// 绕过。pi 升级若移动该文件，任何一环失败都会降级为不带头（单次调用退回旧行为，主会话不受影响），
// 届时对照 pi 新版源码更新路径即可。
type AttributionHeaders = Record<string, string> | undefined;
type MergeAttributionHeaders = (
	model: unknown,
	settingsManager: unknown,
	sessionId?: string,
	...headerSources: AttributionHeaders[]
) => AttributionHeaders;

let mergeAttributionHeaders: MergeAttributionHeaders | null | undefined; // undefined=未探测，null=不可用

/** 从进程入口脚本（argv[1]，如 …/dist/bundle/cli.js）向上找 package.json 定位 pi 包根。 */
function findPiPackageRoot(): string | null {
	const entry = process.argv[1];
	if (!entry) return null;
	let dir = path.dirname(path.resolve(entry));
	for (let i = 0; i < 6; i++) {
		try {
			if (
				JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name ===
				"@earendil-works/pi-coding-agent"
			) {
				return dir;
			}
		} catch {
			/* 目录无 package.json，继续向上 */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/** 深加载 pi 内部的 mergeProviderAttributionHeaders；不可用返回 null（不带该头）。 */
function loadMergeAttributionHeaders(): MergeAttributionHeaders | null {
	if (mergeAttributionHeaders !== undefined) return mergeAttributionHeaders;
	mergeAttributionHeaders = null;
	try {
		const entry = process.argv[1];
		const root = findPiPackageRoot();
		if (entry && root) {
			const req = createRequire(entry);
			const mod = req(path.join(root, "dist", "core", "provider-attribution.js")) as {
				mergeProviderAttributionHeaders?: MergeAttributionHeaders;
			};
			if (typeof mod?.mergeProviderAttributionHeaders === "function") {
				mergeAttributionHeaders = mod.mergeProviderAttributionHeaders;
			}
		}
	} catch {
		/* pi 升级移动文件 → 降级为不带头 */
	}
	return mergeAttributionHeaders;
}

/** SettingsManager 只做只读加载，按 cwd 缓存避免每次调用重读 */
const settingsCache = new Map<string, SettingsManager>();

/**
 * 取某次请求应带的供应商头（会话/归因），与主会话的注入端完全同源；
 * pi 内部管道不可用时返回 undefined（调用方带头基座为空，仅 opencode 系供应商会因此落回旧行为）。
 */
export function piAttributionHeaders(model: unknown, cwd: string, sessionId?: string): AttributionHeaders {
	const merge = loadMergeAttributionHeaders();
	if (!merge) return undefined;
	try {
		let settings = settingsCache.get(cwd);
		if (!settings) {
			settings = SettingsManager.create(cwd);
			settingsCache.set(cwd, settings);
		}
		return merge(model, settings, sessionId);
	} catch {
		/* 管道对个别模型形态不适用（如缺 baseUrl）→ 不带头，不让头部问题毁掉整次调用 */
		return undefined;
	}
}

/** 故障转移上限（含首选）：候选链再长也不无限试，避免审核长时间挂起 */
const MAX_ATTEMPTS = 2;
/** 剩余时间低于这个值就不开新一轮尝试（开了也必然超时） */
const MIN_ATTEMPT_MS = 2_000;

/** 单次尝试：认证 → 头注入 → completeSimple → 文本抽取 → 验收 */
async function attemptOnce(
	ctx: ExtensionContext,
	model: AnyModel,
	opts: AiCompleteOptions,
	timeoutMs: number | undefined,
	external: AbortSignal | undefined,
): Promise<AiCompleteResult> {
	const ref = modelRef(model);
	let timedOut = false;
	const own = new AbortController();
	const timer = timeoutMs ? setTimeout(() => {
		timedOut = true;
		own.abort();
	}, timeoutMs) : undefined;
	// 用户中断（ctx.signal）与本次超时任一触发都能停：不给时间上限时，中断就是唯一出口
	const onExternalAbort = () => own.abort();
	if (external) {
		if (external.aborted) own.abort();
		else external.addEventListener("abort", onExternalAbort, { once: true });
	}
	const timeoutLabel = () => (external?.aborted ? `已中断 · ${ref}` : `超时 ${Math.round((timeoutMs ?? 0) / 1000)}s · ${ref}`);
	const attribution = piAttributionHeaders(model, ctx.cwd, ctx.sessionManager.getSessionId());
	const messages: Message[] = [{ role: "user", content: opts.prompt, timestamp: Date.now() }];
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return { ok: false, error: `认证失败 · ${ref}：${auth.error}` };
		const result = await completeSimple(
			model,
			{ systemPrompt: opts.systemPrompt, messages },
			{
				apiKey: auth.apiKey,
				headers: { ...(attribution ?? {}), ...auth.headers },
				temperature: opts.temperature,
				signal: own.signal,
			},
		);
		// stopReason=aborted 只看自己传的 signal：超时或用户中断（pi-ai 仅在 signal.aborted 时置 aborted）
		if (timedOut || own.signal.aborted || result.stopReason === "aborted") {
			return { ok: false, error: timeoutLabel() };
		}
		if (result.stopReason === "error") {
			return { ok: false, error: `请求失败 · ${ref}：${result.errorMessage || "未知错误"}` };
		}
		const text = extractAiText(result.content, opts.textJoin ?? "\n");
		if (!text) return { ok: false, error: `模型无输出 · ${ref}（${result.stopReason}）` };
		if (opts.validate && !opts.validate(text)) return { ok: false, error: `输出无法解析 · ${ref}` };
		return { ok: true, text };
	} catch (e) {
		if (timedOut || own.signal.aborted) return { ok: false, error: timeoutLabel() };
		return { ok: false, error: `${e instanceof Error ? e.message : String(e)} · ${ref}` };
	} finally {
		if (timer) clearTimeout(timer);
		external?.removeEventListener("abort", onExternalAbort);
	}
}

/** 当前轮次的中断信号（agent 未运行时不存在）：撞不上就返回 undefined（无中断出口） */
function turnSignal(ctx: ExtensionContext): AbortSignal | undefined {
	try {
		return ctx.signal;
	} catch {
		return undefined;
	}
}

/**
 * 一次成型调用：认证 + 头注入 + completeSimple + 文本抽取；候选链里还有下一个就换一个重试
 * （只有 FREE 免费池是多候选，其余解析结果天然单模型）。永不抛异常。
 *
 * 超时：默认不设（时间给足），中断靠透传 `ctx.signal`（用户 Esc）；调用方只在
 * 「失败代价小于等待代价」时才传 timeoutMs——传了就用满、不切分（失败代价高的场景
 * 本来就不该设超时），回退尝试只吃前一次剩下的时间。
 *
 * 失败原因会回给调用方（含模型与耗时，如「超时 5s · opencode-go/glm-5.3-flash」
 * 「已中断 · …」），让上层降级文案能说清到底坏在哪。
 */
export async function aiComplete(
	ctx: ExtensionContext,
	chain: AiModelChain,
	opts: AiCompleteOptions,
): Promise<AiCompleteResult> {
	const external = turnSignal(ctx);
	const deadline = opts.timeoutMs && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : undefined;
	let candidate = chain.model;
	let lastError = "无可用模型";
	let attempts = 0;
	while (candidate && attempts < MAX_ATTEMPTS) {
		const remaining = deadline ? deadline - Date.now() : undefined;
		if (remaining !== undefined && remaining < MIN_ATTEMPT_MS) break;
		attempts++;
		const r = await attemptOnce(ctx, candidate, opts, remaining, external);
		if (r.ok) return r;
		lastError = r.error;
		if (external?.aborted) break; // 用户中断：不再换候选
		candidate = chain.failover();
	}
	return { ok: false, error: lastError };
}
