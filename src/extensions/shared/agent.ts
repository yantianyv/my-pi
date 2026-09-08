/**
 * 子代理公共件：消息转换 + pi 认证通道 streamFn 工厂
 *
 * claude-it（/init 子代理）等子代理类扩展共用此模块：convertToLlm 与 streamFn
 * 的公共实现，由 build.js 内联进各产物。
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 标准消息直通转换：子代理会话里只有 user/assistant/toolResult，无需特殊处理 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

// ---------------------------------------------------------------------------
// 供应商归因/会话头（与主会话同一条头管道，不逐供应商硬编码）
// ---------------------------------------------------------------------------

// pi 主会话的请求头管道在 dist/core/provider-attribution.js 的 mergeProviderAttributionHeaders：
// 按供应商规则表统一注入（opencode/opencode-go 系的 x-opencode-session 是功能必需头，缺失直接
// 400 MissingSessionID；OpenRouter/NIM/Cloudflare 的归因头为遥测可选）。该函数未从包主入口
// 公开导出且 package.json exports 封锁深路径（动态 import 报 ERR_PACKAGE_PATH_NOT_EXPORTED，
// jiti 下已实测），故按「process.argv[1]（pi 入口 cli.js）向上定位包根 → 按文件路径 require」
// 绕过。pi 升级若移动该文件，任何一环失败都会降级为不带头（子代理退回旧行为，主会话不受影响），
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

/** 深加载 pi 内部的 mergeProviderAttributionHeaders；不可用返回 null（子代理不带该头）。 */
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

/**
 * 创建走 pi 已登录通道的 streamFn：每次 LLM 调用前从模型注册表取最新认证
 * （兼容 OAuth 刷新），请求由 pi-ai 的 provider 实现发出，支持任意 API 类型。
 *
 * 头语义与主会话对齐：会话/归因头（pi 按供应商规则统一生成）作基座，auth 头与调用方
 * options 头依次覆盖——与主通道 transformHeaders(mergeProviderAttributionHeaders(…)) 的
 * 合并顺序一致。
 */
export function createPiStreamFn(ctx: ExtensionContext): StreamFn {
	const sessionId = ctx.sessionManager.getSessionId();
	// 真实 settings（与主会话同源）：仅影响遥测门控的归因头（OpenRouter referer 等），
	// opencode 会话头不依赖它；加载失败也不影响认证头，故不额外兜底
	const settings = SettingsManager.create(ctx.cwd);
	return async (m, c, options) => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
		if (!auth.ok) throw new Error(`认证失败：${auth.error}`);
		const merge = loadMergeAttributionHeaders();
		const attribution = merge ? merge(m, settings, sessionId) : undefined;
		return streamSimple(m, c, {
			...options,
			apiKey: auth.apiKey ?? options?.apiKey,
			headers: { ...(attribution ?? {}), ...auth.headers, ...options?.headers },
		});
	};
}
