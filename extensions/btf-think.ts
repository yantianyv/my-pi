/**
 * btf-think：思考折叠标签动画
 *
 * turn_start 起把折叠的「Thinking」标签变成 Thinking. → Thinking.. → Thinking...
 * 逐帧动画（400ms/帧），turn_end / session_shutdown 时恢复默认标签。
 *
 * 实现要点：
 * - 原为 hud 的一部分，拆出为独立「UI 反馈」插件（与 task-alert 同类），
 *   不依赖 hud；关闭 HUD 也能保留动画。
 * - 走官方 ctx.ui.setHiddenThinkingLabel 通道，零耦合、无状态残留。
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

	pi.on("turn_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		stopAnimation(ctx); // 思考结束，停止动画、恢复默认标签
	});

	pi.on("session_shutdown", async () => {
		stopAnimation();
	});
}
