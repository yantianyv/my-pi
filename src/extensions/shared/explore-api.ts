/**
 * explore 能力的跨扩展契约：explore-agent 把探索引擎挂到 globalThis，其他扩展
 * （claude-it 的 /init 子代理）在不能 import 对方产物（dist 是零耦合单文件）的前提下取用。
 *
 * 生产者挂载、消费方探测、缺席静默降级——同 hud 的 __PI_HUD_API__ 约定；契约的键名、
 * 版本与类型在本模块单点定义，两侧各自 import（各自内联一份，运行时无依赖）。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** globalThis 挂载键 */
export const EXPLORE_API_KEY = "__PI_EXPLORE_API__";

/** 契约版本：语义不兼容时递增，消费方比对一致才使用 */
export const EXPLORE_API_VERSION = 1;

export interface ExploreApi {
	version: number;
	/**
	 * 造一个「供子代理循环直接调用」的 explore 工具：execute 只收 4 参（ctx 由实现绑定），
	 * 与 pi-agent-core 的 AgentTool 签名一致，可原样塞进 runAgentLoop 的 tools。
	 *
	 * @param alwaysFresh 忽略历史成果复用、每次现跑（调用方要求结果必须反映当前代码时用）
	 */
	createSubagentTool(ctx: ExtensionContext, options?: { alwaysFresh?: boolean }): AgentTool<any>;
}

export function publishExploreApi(api: ExploreApi): void {
	(globalThis as Record<string, unknown>)[EXPLORE_API_KEY] = api;
}

/** 取用：explore 扩展未加载（未安装/被禁用/加载失败）或版本不匹配时返回 null。 */
export function getExploreApi(): ExploreApi | null {
	const api = (globalThis as Record<string, unknown>)[EXPLORE_API_KEY] as ExploreApi | undefined;
	if (!api || api.version !== EXPLORE_API_VERSION) return null;
	return typeof api.createSubagentTool === "function" ? api : null;
}
