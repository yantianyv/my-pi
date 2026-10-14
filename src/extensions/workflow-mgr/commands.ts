/**
 * workflow-mgr 命令注册层：`/wf`（状态摘要）+ `/wf-config`（配置面板）。
 *
 * 人无需管理工作流（管理是 AI 的事）：`/wf-config` 只留无参入口——
 * TUI 弹功能浮窗（显示详细信息/常驻面板开关），非 TUI 打印文本面板。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getStore } from "./store";
import { textPanel, WfmgMenuPanelComponent } from "./panel";
import { summaryLine } from "./brief";

/** 注册 /wf 与 /wf-config 命令 */
export function registerCommand(pi: ExtensionAPI) {
	const workflowConfigHandler = async (_args: string, ctx: ExtensionCommandContext) => {
		const s = getStore(ctx);
		// 无参：TUI 弹统一功能浮窗（menu）；非 TUI 输出文本面板
		if (ctx.mode === "tui") {
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const comp = new WfmgMenuPanelComponent(s, ctx, theme, () => done());
					comp.setTui(tui);
					return comp;
				},
				{
					overlay: true,
					overlayOptions: { width: "60%", maxHeight: "60%" },
				},
			);
			return;
		}
		console.log(textPanel(s.getState(), s.getDerived()).join("\n"));
	};

	pi.registerCommand("wf-config", {
		description: "工作流面板：进度总览与常驻面板开关",
		handler: workflowConfigHandler,
	});

	const wfHandler = async (args: string, ctx: ExtensionCommandContext) => {
		if (args.trim()) {
			ctx.ui.notify("用法：/wf（状态摘要）｜ /wf-config（功能浮窗）", "warning");
			return;
		}
		const s = getStore(ctx);
		if (!s.hasWorkflowFile()) {
			ctx.ui.notify("本会话暂无工作流（需要时让 AI 用 wf_workflow 规划）", "info");
			return;
		}
		ctx.ui.notify(`${summaryLine(s.getState(), s.getDerived())}\n详情用 /wf-config`, "info");
	};
	pi.registerCommand("wf", {
		description: "工作流：查看本会话状态摘要",
		handler: wfHandler,
	});
}
