/**
 * ask：问卷扩展（「问卷即文件」的 AI→人 批量提问通道）
 *
 * 动机：AI 需要人类决策/补充信息时，正文罗列问题容易漏答、难回答。本扩展让 AI
 * 创建结构化问卷（单选/多选/简答/判断/评分/数字），立即整屏弹出问卷页请用户作答；
 * 用户可 Enter 提交 / Esc 搁置（草稿保留），也可随时用 /answer 主动打开待答问卷。
 *
 * 组成：
 * - types.ts   数据模型 + 容错规范化（手写 JSON 同样可识别）+ 答案格式化
 * - store.ts   .pi/questionnaires/*.json 读写（提交即删，搁置存草稿）
 * - page.ts    整屏问卷页组件（overlay 全屏遮蔽）+ 问卷选择器
 * - tool.ts    ask 工具（AI 侧；同批多份排队逐个打开；非 TUI 降级为文字提问）
 * - commands.ts /answer 命令（人类侧；多份选择、提交后发答案给 AI）
 * - state.ts   待答状态推送（setStatus("ask") hud 通道）+ 问卷页排队链
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAnswerCommand } from "./commands";
import { refreshPendingStatus, rememberCtx } from "./state";
import { initStore } from "./store";
import { registerAskTool } from "./tool";

export default function (pi: ExtensionAPI): void {
	registerAskTool(pi);
	registerAnswerCommand(pi);

	// 会话开始：固定项目根 + 恢复待答状态提示（含上次会话搁置/手写的问卷）
	pi.on("session_start", async (_event, ctx) => {
		rememberCtx(ctx);
		initStore(ctx.cwd);
		await refreshPendingStatus();
	});
}
