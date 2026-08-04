/**
 * /exit 别名与无斜杠 exit 退出
 *
 * - 注册 /exit 命令，行为与内置 /quit 相同。
 * - 监听 input 事件：当用户直接输入 "exit"（不带 /）时立即优雅退出 pi，
 *   避免把该文本当作普通消息发送给模型。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// 1) /exit 斜杠命令别名
	pi.registerCommand("exit", {
		description: "退出 pi（/quit 的别名）",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	// 2) 不带 / 的 exit 也退出
	pi.on("input", async (event, ctx) => {
		if (event.text.trim() === "exit") {
			ctx.shutdown();
			return { action: "handled" };
		}
		return { action: "continue" };
	});
}
