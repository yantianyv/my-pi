/**
 * claude-it: 让 pi 更像 Claude Code
 *
 * - /exit 命令（/quit 的别名）与直接输入 exit 退出
 * - 对话进行中按 Ctrl+C 取消当前 agent 操作
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

	// 3) Ctrl+C 取消当前 turn（Claude Code 风格）
	let currentCtx: ExtensionContext | null = null;
	let ctrlCHandlerInstalled = false;

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.mode !== "tui" || ctrlCHandlerInstalled) return;
		ctrlCHandlerInstalled = true;
		ctx.ui.onTerminalInput((data) => {
			if (data === "\x03" && currentCtx && !currentCtx.isIdle()) {
				currentCtx.abort();
				return { consume: true };
			}
			return { consume: false };
		});
	});

	pi.on("session_shutdown", async () => {
		currentCtx = null;
	});
}
