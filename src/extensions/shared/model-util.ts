/**
 * shared/model-util：模型注册表的纯查询工具（无 UI 依赖）
 *
 * 从原 shared/model-select 里拆出：这些函数只读 ctx.modelRegistry，不涉及渲染，
 * 供 model-setting（解析链）与 model-select（选择浮层）共用；拆开是为了让不弹面板的
 * 插件（hud-git / status-beacon / perm-gate 等）不必把浮层代码内联进产物。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModel = Model<any>;

/**
 * 目录价缺失（写 0）但实为付费的模型：价格覆盖，只用于「是否免费」与价格排序。
 * 按 0 价判免费会让 FREE 策略选中这些高速档，也会让 HUD 恒显示 0 成本。
 * 单位与用途无关（只要非 0）；数值取对应高速档价（glm-5.3-highspeed 即国内 GLM-5.3-FlashX）。
 */
const COST_OVERRIDES: Record<string, { input: number; output: number }> = {
	"glm-5.3-highspeed": { input: 0.375, output: 1.25 },
	"glm-5.2-highspeed": { input: 0.375, output: 1.25 },
};

/** 有效价格（覆盖表优先，其次目录）；无价格信息返回 null */
function effectiveCost(m: AnyModel): { input: number; output: number } | null {
	const o = COST_OVERRIDES[m.id];
	if (o) return o;
	const c = m.cost;
	if (!c) return null;
	return { input: c.input ?? 0, output: c.output ?? 0 };
}

/**
 * 模型单价合计（input + output，$/M tokens）；动态定价模型用负数标记
 * （如 openrouter/auto 为 -1000000），视为价格未知排到最后，避免 auto 误选。
 */
export function modelTotalCost(m: AnyModel): number {
	const c = effectiveCost(m);
	if (!c) return Infinity;
	if (c.input < 0 || c.output < 0) return Infinity;
	return c.input + c.output;
}

/** 是否免费模型（价格 ≤ 0；FREE 策略的候选池口径） */
export function isFreeModel(m: AnyModel): boolean {
	const c = effectiveCost(m);
	if (!c) return false;
	return c.input <= 0 && c.output <= 0;
}

/** 可用（已认证）模型按价格升序排列，同价按 id 字典序保证列表稳定；excludeFree 时忽略免费模型 */
export function listAvailableModels(ctx: ExtensionContext, opts?: { excludeFree?: boolean }): AnyModel[] {
	const reg = ctx.modelRegistry;
	return reg
		.getAvailable()
		.filter((m) => reg.hasConfiguredAuth(m))
		.filter((m) => !opts?.excludeFree || !isFreeModel(m))
		.sort((a, b) => modelTotalCost(a) - modelTotalCost(b) || a.id.localeCompare(b.id));
}

/**
 * 按设置串查找已认证模型：含 '/' 视为精确 provider/modelId；否则按模型 id
 * 子串匹配（不区分大小写，唯一命中才返回，多命中由调用方列出候选）
 */
export function findConfiguredModel(ctx: ExtensionContext, setting: string): AnyModel | undefined {
	const reg = ctx.modelRegistry;
	if (setting.includes("/")) {
		const [provider, id] = setting.split("/", 2);
		const m = reg.find(provider.trim(), id?.trim() ?? "");
		return m && reg.hasConfiguredAuth(m) ? m : undefined;
	}
	const needle = setting.trim().toLowerCase();
	if (!needle) return undefined;
	const matches = listAvailableModels(ctx).filter((m) => m.id.toLowerCase().includes(needle));
	return matches.length === 1 ? matches[0] : undefined;
}

/** 模型价格展示文本：`$0.14/$0.28 per M`（input/output，单位美元每百万 token）；负数价格（动态定价）标「动态定价」 */
export function formatModelPrice(m: AnyModel): string {
	const c = m.cost;
	if (!c) return "价格未知";
	if (c.input < 0 || c.output < 0) return "动态定价";
	return `$${c.input}/${c.output} per M`;
}

/** 上下文窗口可读化：1048576 → 1M、262144 → 256K */
export function formatContextWindow(n: number | undefined): string {
	if (!n || n <= 0) return "?";
	if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
	return String(n);
}

/** 模型是否具备读图能力（input 声明含 "image"） */
export function modelHasVision(m: AnyModel | undefined): boolean {
	return !!m?.input?.includes("image");
}

/** 模型短标签：provider/id（面板与通知统一用这个格式） */
export function modelRef(m: AnyModel | undefined): string {
	return m ? `${m.provider}/${m.id}` : "（无可用模型）";
}
