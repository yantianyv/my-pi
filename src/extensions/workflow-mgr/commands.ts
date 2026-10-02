/**
 * workflow-mgr 命令注册层：/workflow-config（人用查看入口）+ /wf-resume（恢复会话入口）。
 *
 * 0.4 拍板：人无需管理工作流（管理是 AI 的事），/workflow-config 只留无参入口——
 * TUI 弹功能浮窗（显示详细信息/常驻面板开关），非 TUI 打印文本面板。
 * 子命令（toggle/done/start/block）已全部删除。
 *
 * /wf-resume：打开 pi 官方会话选择器（SessionSelectorComponent 全屏浮层），
 * 选定后经命令上下文 switchSession 切换。工作流选择弹窗「从 resume 中加载」
 * 经 pi.sendUserMessage 派发到本命令（事件处理器拿不到 switchSession 所在的
 * 命令上下文）；也可手动输入重试恢复。恢复后 pi 重发 session_start，
 * 按被恢复会话自己的绑定加载其工作流空间。
 */
import {
	SessionManager,
	SessionSelectorComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getStore } from "./store";
import { textPanel, WfmgMenuPanelComponent } from "./panel";

/** 注册 /workflow-config 命令 */
export function registerCommand(pi: ExtensionAPI) {
	const workflowConfigHandler = async (args: string, ctx: ExtensionContext) => {
		const s = getStore(ctx);
		if (s.blocked) {
			ctx.ui.notify(
				s.blocked === "none"
					? "本会话已明确不使用工作流（如需启用，让 AI 执行 wf_workflow action=bind）"
					: s.blocked === "auto"
						? "本会话暂不启用工作流（是否使用由 AI 依任务判断；也可让 AI 用 wf_workflow bind 指定）"
						: "本会话尚未选择工作流（多工作流并发场景，让 AI 用 wf_workflow bind 选定）",
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

	/* ---------- /wf-resume：官方会话选择器 + switchSession 恢复（工作流弹窗「从 resume 中加载」入口） ---------- */
	const resumeHandler = async (_args: string, ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("恢复会话需要在交互界面（TUI）中使用", "info");
			return;
		}
		const sessionManager = ctx.sessionManager;
		let picked: string | null | undefined;
		try {
			picked = await ctx.ui.custom<string | null>(
				(tui, _theme, keybindings, done) =>
					new SessionSelectorComponent(
						(onProgress, signal) => SessionManager.list(ctx.cwd, sessionManager.getSessionDir(), onProgress, signal),
						(onProgress, signal) =>
							// 默认会话目录下官方不传参（扫默认全局目录）；显式传 sessionDir 与其等价，
							// 自定义目录时则与官方行为一致只扫该目录——无需探测 usesDefaultSessionDir
							SessionManager.listAll(sessionManager.getSessionDir(), onProgress, signal),
						(sessionPath) => done(sessionPath),
						() => done(null), // 取消（Esc）
						() => done(null), // 退出选择器：按取消处理（本进程仍需继续跑）
						() => tui.requestRender(),
						{ showRenameHint: false, keybindings },
						sessionManager.getSessionFile(),
					),
				{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } },
			);
		} catch {
			picked = undefined; // 选择器基础设施异常：按取消处理
		}
		if (!picked) {
			ctx.ui.notify("已取消恢复会话。本会话尚未选择工作流：可让 AI 用 wf_workflow bind 指定，或再次输入 /wf-resume 重试", "info");
			return;
		}
		await ctx.switchSession(picked);
	};
	pi.registerCommand("wf-resume", {
		description: "恢复历史会话（官方会话选择器，等价手动 /resume）；工作流选择弹窗「从 resume 中加载」的内部入口",
		handler: resumeHandler,
	});
}
