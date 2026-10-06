/**
 * claude-it: 让 pi 更像 Claude Code 的会话体验（文档生成已拆去 context-init）
 *
 * - /exit 命令（/quit 的别名）与直接输入 exit 退出
 * - 对话进行中按 Ctrl+C 取消当前 agent 操作；打断沉降完成后的窗口内再按一次 Ctrl+C
 *   直接执行 /rewind 回退到上一条用户消息（内容放回输入框）。窗口从沉降完成（agent_end）
 *   起算而非按键时刻：沉降期内按下的 Ctrl+C 会把回退意图排队，双击连按永远有效
 * - /rewind 命令：回退到上一条用户消息，消息内容放回输入框
 * - 启动清屏：pi 冷启动（TUI 模式）时清一遍屏，主界面从干净画面开始
 *   （借 setWidget 工厂同步拿到 TUI 实例：清视口 + 强制全量重绘，用完即删）
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 启动清屏开关（Claude Code 风格；不需要时置 false 即可） */
const CLEAR_SCREEN_ON_STARTUP = true;
/** 占位 widget 的 key：借 setWidget 工厂同步拿到 TUI 实例，用完即删，不留痕迹 */
const STARTUP_CLEAR_WIDGET_KEY = "startup-clear";
/** 双击 Ctrl+C 回退窗口（ms）：打断沉降完成（agent_end）后此窗口内的 Ctrl+C 触发回退 */
const REWIND_WINDOW_MS = 2_000;
/** 回退排队保持窗口（ms）：沉降期内按下的 Ctrl+C 把回退意图排队，此后此窗口内再按一次即触发 */
const REWIND_ARMED_WINDOW_MS = 30_000;

function clearScreenOnStartup(ctx: ExtensionContext) {
	// setWidget 的工厂会同步收到 TUI 实例（interactive-mode 内即 this.ui）：
	// 1) clearScreen() 清视口（\x1b[2J\x1b[H，保留 scrollback 可向上翻阅）；
	// 2) requestRender(true) 重置差分渲染状态并立即全量重绘——
	//    清屏后若只做普通差分渲染，TUI 会以为旧帧还在、仅重绘变化行导致画面残缺。
	ctx.ui.setWidget(STARTUP_CLEAR_WIDGET_KEY, (tui) => {
		tui.terminal.clearScreen();
		tui.requestRender(true);
		return new Text("", 0, 0);
	});
	// 清屏 + 全量重绘都在工厂同步调用内完成，随即移除占位 widget，无视觉残留
	ctx.ui.setWidget(STARTUP_CLEAR_WIDGET_KEY, undefined);
}

/** 从消息 content（string 或 TextContent[]）提取纯文本 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(c): c is { type: "text"; text: string } =>
					!!c && typeof c === "object" && (c as { type?: string }).type === "text",
			)
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	// 1) /exit 斜杠命令别名
	pi.registerCommand("exit", {
		description: "退出 pi（立即结束当前会话；等同于直接输入 exit 或 /quit）",
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

	// 3) /rewind：回退到上一条用户消息（消息内容放回输入框）
	//      navigateTree 是命令 ctx 专属能力（事件 ctx 没有）：同一会话文件内把叶子切回
	//      该 user 消息的父节点（丢弃其后的全部内容），interactive-mode 会自动清屏重绘
	//      并在输入框为空时把消息文本填回输入框；双击 Ctrl+C 会预填本命令，回车即执行
	pi.registerCommand("rewind", {
		description: "回退到上一条用户消息，消息内容放回输入框",
		handler: async (_args, ctx) => {
			// 从根到叶遍历（getBranch 返回当前叶子路径，顺序为根→叶），找最后一条 user 消息
			const entries = ctx.sessionManager.getBranch();
			let targetId: string | null = null;
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e.type === "message" && e.message.role === "user") {
					targetId = e.id;
					break;
				}
			}
			if (!targetId) {
				ctx.ui.notify("没有可回退的用户消息", "warning");
				return;
			}
			// 叶子就是这条 user 消息（打断发生在回答生成前）：navigateTree 会 no-op，直接回填文本
			if (targetId === ctx.sessionManager.getLeafId()) {
				const entry = ctx.sessionManager.getEntry(targetId);
				const msg = entry && entry.type === "message" ? (entry.message as { content?: unknown }).content : undefined;
				const text = msg !== undefined ? extractText(msg) : "";
				if (text) ctx.ui.setEditorText(text);
				ctx.ui.notify("已把上一条消息放回输入框", "info");
				return;
			}
			const result = await ctx.navigateTree(targetId);
			if (result.cancelled) return;
			// interactive-mode 会在输入框为空时自动把被导航消息文本回填进输入框
			ctx.ui.notify("已回退到上一条消息，内容已在输入框", "info");
		},
	});

	// 4) Ctrl+C：第一次打断当前 turn；打断沉降完成后的窗口内再按一次 → 直接执行 /rewind 回退
	//    窗口起点是「沉降完成时刻」（agent_end）而非按键时刻：abort 有沉降期（isIdle 迟迟不变
	//    true），旧实现从按键起算会被沉降期吃掉大半窗口，且沉降期内误按会刷新起点，手感极差。
	//    现沉降期内按下的 Ctrl+C 只把回退意图排队（rewindArmed，不刷新窗口），空闲后的下一
	//    次 Ctrl+C 消费——双击连按永远有效，无需探准沉降结束的时机
	let currentCtx: ExtensionContext | null = null;
	// 注销函数（pi 返回的 unsubscribe）；同时充当「是否已注册」标志——shutdown 时注销并复位，
	// 新 session/reload 的新实例会重新注册，同一时刻只有一个活 handler（旧闭包不再幽灵残留）
	let ctrlCUnsubscribe: (() => void) | undefined;
	let abortPending = false; // 已发出 abort、尚未沉降完成（isIdle 仍 false）
	let settledAt = 0; // 打断沉降完成时刻（仅打断路径的 agent_end 会设置）；0 = 无打断历史
	let rewindArmed = false; // 沉降期内按过 Ctrl+C：回退意图已排队

	pi.on("session_start", async (event, ctx) => {
		// 启动清屏：仅 TUI 模式冷启动时执行（/reload、/new、/resume、/fork 不清屏）
		if (CLEAR_SCREEN_ON_STARTUP && event.reason === "startup" && ctx.mode === "tui") {
			clearScreenOnStartup(ctx);
		}

		currentCtx = ctx;
		abortPending = false;
		settledAt = 0;
		rewindArmed = false;
		if (ctx.mode !== "tui" || ctrlCUnsubscribe) return;
		ctrlCUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (data !== "\x03" || !currentCtx) return { consume: false };

			if (!currentCtx.isIdle()) {
				if (!abortPending) {
					// 第一次 Ctrl+C：中止当前 turn（打断后 agent_end 的最后一条 assistant 消息
					// stopReason=aborted，status-beacon 据此不触发完成提醒）
					abortPending = true;
					currentCtx.abort();
					currentCtx.ui.notify("已打断当前回合 · 打断完成后按 Ctrl+C 回退到上一条消息", "info");
				} else {
					// 沉降期内的 Ctrl+C：排队回退意图，不重复刷新窗口（abort 幂等重发一次保底）
					rewindArmed = true;
					currentCtx.abort();
					currentCtx.ui.notify("正在打断 · 稍后按 Ctrl+C 即回退到上一条消息", "info");
				}
				return { consume: true };
			}

			// 空闲时 Ctrl+C：消费回退意图（排队优先）或落在沉降后窗口内 → 执行 /rewind
			const now = Date.now();
			const hitRewind = rewindArmed
				? now - settledAt < REWIND_ARMED_WINDOW_MS
				: settledAt > 0 && now - settledAt < REWIND_WINDOW_MS;
			if (hitRewind) {
				rewindArmed = false;
				settledAt = 0;
				currentCtx.ui.setEditorText("/rewind");
				currentCtx.ui.notify("正在执行 /rewind：回退到上一条用户消息", "info");
				// 把当前按键替换成回车，让 /rewind 走正常命令提交流程
				return { consume: false, data: "\r" };
			}
			return { consume: false };
		});
	});

	// 打断沉降完成：窗口从此刻起算（仅打断路径；正常完成的 agent_end 不动 settledAt，
	// 避免正常回答结束后 2s 内按 Ctrl+C 误触发回退）
	pi.on("agent_end", async () => {
		if (abortPending) {
			abortPending = false;
			settledAt = Date.now();
		}
	});

	// 新回合开始：排队意图作废（用户已提交新消息继续对话，不再回退）
	pi.on("agent_start", async () => {
		rewindArmed = false;
	});

	pi.on("session_shutdown", async () => {
		currentCtx = null;
		abortPending = false;
		settledAt = 0;
		rewindArmed = false;
		ctrlCUnsubscribe?.();
		ctrlCUnsubscribe = undefined;
	});
}
