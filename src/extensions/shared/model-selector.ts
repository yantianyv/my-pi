/**
 * 通用模型选择面板（共享模块）
 *
 * 直接复用 pi 官方导出的 ModelSelectorComponent（与内置 /model 同一组件：
 * 搜索过滤 / scoped 切换 / 目录自动刷新，零自绘）。经 ctx.ui.custom() 以
 * overlay 形式挂载（与 hud-git 面板同一通道）。
 *
 * 实现要点：组件构造函数要求 ModelRuntime，扩展上下文只暴露 ModelRegistry——
 * 但 ModelRegistry 内部就持有 runtime（d.ts 标 private，JS 运行时是公开字段），
 * 一次类型断言直通即可。组件对 runtime 的实际使用面：getAvailableSnapshot /
 * getModel / getError / refresh（挂载后自动刷新目录）。
 *
 * 使用方：perm-gate（/perm-gate model 选 AI 审核模型）。
 * 伪编译时被 build.js 内联进各产物，@earendil-works/* 走 external 白名单零耦合。
 */
import {
	ModelSelectorComponent,
	type ExtensionContext,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AnyModel } from "./model-pick";

/**
 * 打开官方模型选择面板（overlay）：返回选中的模型，Esc 取消返回 undefined。
 * currentModel 缺省用当前会话模型（选择器高亮项）。
 */
export async function pickModelViaSelector(
	ctx: ExtensionContext,
	currentModel?: AnyModel,
): Promise<AnyModel | undefined> {
	// ModelRegistry.runtime：d.ts private、运行时公开（model-registry.js:7）
	const runtime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
	return ctx.ui.custom<AnyModel | undefined>(
		(tui, _theme, _keybindings, done) =>
			new ModelSelectorComponent(
				tui,
				currentModel ?? ctx.model,
				runtime,
				ctx.scopedModels.map((s) => ({ model: s.model, thinkingLevel: s.thinkingLevel })),
				(model) => done(model),
				() => done(undefined),
			),
		{ overlay: true },
	);
}
