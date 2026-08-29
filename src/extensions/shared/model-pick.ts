/**
 * 辅助 AI 任务选模型（共享模块）
 *
 * 扩展内的小型 AI 调用（生成提交信息、命令安全审核等）不应占用主会话模型，
 * 统一走「优先列表 + 最便宜已认证兜底」策略：
 *   1. 按 preferred 优先列表（[provider, modelId]）逐一找已配置认证的模型；
 *   2. 都不可用时，在已认证模型里选 input+output 价格最便宜的；
 *   3. 找不到返回 undefined，调用方自行降级（跳过 AI 功能或转人工）。
 *
 * 使用方：hud-git（AI 提交信息/冲突消解）、perm-gate（bash 命令 AI 审核）。
 * 伪编译时被 build.js 内联进各产物，运行时零依赖。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModel = Model<any>;

/**
 * 辅助 AI 任务选模型：按优先列表（provider/modelId）找已认证的，
 * 兜底选 input+output 价格最便宜的已认证模型；都没有返回 undefined。
 */
export function pickAuxModel(ctx: ExtensionContext, preferred: Array<[string, string]>): AnyModel | undefined {
	const reg = ctx.modelRegistry;
	for (const [provider, modelId] of preferred) {
		const m = reg.find(provider, modelId);
		if (m && reg.hasConfiguredAuth(m)) return m;
	}
	// 兜底：已配置认证的模型里选 input+output 最便宜的
	let best: AnyModel | undefined;
	let bestCost = Infinity;
	for (const m of reg.getAvailable()) {
		if (!reg.hasConfiguredAuth(m)) continue;
		const c = (m.cost?.input ?? Infinity) + (m.cost?.output ?? Infinity);
		if (c < bestCost) {
			best = m;
			bestCost = c;
		}
	}
	return best;
}
