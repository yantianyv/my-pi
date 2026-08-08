/**
 * btf-think：思考折叠标签动画
 *
 * assistant 消息流式输出期间，把折叠的「Thinking」标签变成 Thinking. →
 * Thinking.. → Thinking... 逐帧动画（400ms/帧）；流式结束即恢复默认标签。
 *
 * 实现要点：
 * - **消息级绑定**：仅在 assistant 消息流式期间（message_start → message_end）
 *   显示动画。比 turn 级绑定更精确——工具执行期间没有模型输出，不再空转动画。
 * - **多层兜底停止**：message_end / turn_end / agent_settled 任一触发即恢复默认
 *   标签，杜绝「思考结束后动画残留」（turn_end 偶发不触发时由 agent_settled 兜底）。
 * - 原为 hud 的一部分，拆出为独立「UI 反馈」插件（与 task-alert 同类），
 *   不依赖 hud；关闭 HUD 也能保留动画。
 * - 走官方 ctx.ui.setHiddenThinkingLabel 通道，零耦合。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FRAME_INTERVAL_MS = 400; // 动画帧间隔（可调）

export default function (pi: ExtensionAPI) {
	let thinkingAnimTimer: ReturnType<typeof setInterval> | undefined;
	let thinkingDots = 0;

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation();
		const tick = () => {
			thinkingDots = (thinkingDots % 4) + 1;
			ctx.ui.setHiddenThinkingLabel(`Thinking${".".repeat(thinkingDots)}`);
		};
		tick();
		thinkingAnimTimer = setInterval(tick, FRAME_INTERVAL_MS);
	}

	function stopAnimation(ctx?: ExtensionContext) {
		if (thinkingAnimTimer) {
			clearInterval(thinkingAnimTimer);
			thinkingAnimTimer = undefined;
		}
		if (ctx) ctx.ui.setHiddenThinkingLabel(); // 恢复默认标签
	}

	// 仅在 assistant 消息流式期间显示动画（工具执行 / 用户消息不触发）
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "assistant") startAnimation(ctx);
	});

	// 多层兜底停止，任一触发即恢复默认标签
	pi.on("message_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		stopAnimation(ctx); // pi 完全空闲，最终兜底
	});
	pi.on("session_shutdown", async () => {
		stopAnimation();
	});
}
