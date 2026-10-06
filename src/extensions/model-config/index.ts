/**
 * model-config：模型管理插件（唯一入口 /model-config）
 *
 * 管两件事，都落在 ~/.pi/agent/model-config.json（原子写）：
 * - 策略槽：AUTO（跟随当前会话模型）与 FREE（免费模型池 + 故障转移）语义固定、只能被选不能改；
 *   MAX / FAST / LITE / BASE / BATCH 可由用户重指到具体模型，一处改动影响所有引用该槽的用途
 * - 用途设置：按插件分组的每个模型用途，可设为某个策略或某个具体模型
 *
 * 各插件经 shared/model-setting 声明用途并自行解析（本地设置 → 中心设置 → 默认策略 → AUTO），
 * 中心缺席时仍读本配置文件，因此管理插件不在场也不影响用户已做的设置。
 *
 * 面板（panel.ts）集成全部操作；非交互环境退化为文本摘要（便于随手查看）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelConfigOverlay } from "./panel";
import {
	MODEL_CONFIG_FILE,
	STRATEGIES,
	STRATEGY_DESC,
	STRATEGY_LABEL,
	listPurposeDecls,
	loadModelConfigState,
	readLocalSetting,
	resolveSetting,
	type PurposeDecl,
} from "../shared/model-setting";
import { modelRef } from "../shared/model-util";

/** 非交互环境的纯文本摘要（面板不可用时查看当前全部设置） */
export function renderTextSummary(ctx: ExtensionContext): string {
	const state = loadModelConfigState();
	const lines: string[] = [`模型配置（${MODEL_CONFIG_FILE}）`, "", "策略槽："];
	for (const s of STRATEGIES) {
		const mapped = state.strategies[s];
		const fixed = s === "AUTO" || s === "FREE";
		const target = fixed ? "" : mapped ? ` → ${mapped}` : " → 默认（跟随会话）";
		const resolved = (() => {
			try {
				return `（当前 ${modelRef(resolveSetting(s, ctx).model)}）`;
			} catch {
				return "";
			}
		})();
		lines.push(`  ${s.padEnd(6)} ${STRATEGY_LABEL[s]}（${STRATEGY_DESC[s]}）${target}${resolved}`);
	}
	lines.push("", "用途：");
	const decls: PurposeDecl[] = listPurposeDecls();
	if (decls.length === 0) lines.push("  （暂无插件注册模型用途）");
	for (const d of decls) {
		const local = readLocalSetting(d);
		const center = state.purposes[d.purpose] ?? `=默认 ${d.defaultStrategy}`;
		const resolved = (() => {
			try {
				return modelRef(resolveSetting(local === "auto" ? center.replace(/^=默认\s*/, "") : local, ctx).model);
			} catch {
				return "（无法解析）";
			}
		})();
		lines.push(
			`  [${d.plugin}] ${d.label}：本地 ${local} · 中心 ${center} · 用 ${resolved}${d.requiresVision ? " · 需读图" : ""}`,
		);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("model-config", {
		description:
			"模型配置面板：策略槽（AUTO/FREE 固定，MAX/FAST/LITE/BASE/BATCH 可重指）+ 各插件用途的模型设置",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(renderTextSummary(ctx), "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new ModelConfigOverlay(tui, theme, ctx, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "82%",
						minWidth: 72,
						maxHeight: "88%",
					},
				},
			);
		},
	});
}
