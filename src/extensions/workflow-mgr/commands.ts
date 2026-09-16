/**
 * workflow-mgr 命令注册层：/workflow-config（人用查看入口）。
 *
 * 0.4 拍板：人无需管理工作流（管理是 AI 的事），命令层只留无参入口——
 * TUI 弹功能浮窗（显示详细信息/常驻面板开关），非 TUI 打印文本面板。
 * 子命令（toggle/done/start/block）已全部删除。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getStore } from "./store";
import { textPanel, WfmgMenuPanelComponent } from "./panel";

/** 注册 /workflow-config 命令 */
export function registerCommand(pi: ExtensionAPI) {
	const workflowConfigHandler = async (args: string, ctx: ExtensionContext) => {
		const s = getStore(ctx);
		if (s.blocked) {
			ctx.ui.notify(
				s.blocked === "none"
					? "本会话未使用工作流（如需启用，让 AI 执行 wf_workflow action=bind）"
					: "本会话尚未绑定工作流（多工作流并发场景，让 AI 用 wf_workflow bind 绑定）",
				"info",
			);
			return;
		}
		const state = s.getState();
		const derived = s.getDerived();

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
		console.log(textPanel(state, derived).join("\n"));
	};

	const wfmgDesc =
		"人机协作任务面板：/workflow-config 打开轻量功能浮窗（显示详细信息/常驻面板开关，↑↓ 选择 Enter 执行 Esc 关闭）；" +
		"非 TUI 环境打印文本面板。";
	pi.registerCommand("workflow-config", { description: wfmgDesc, handler: workflowConfigHandler });
}
