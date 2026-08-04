/**
 * task-alert: 任务完成提醒（音频 + 标题栏动画 + HUD 动态区提示）
 *
 * 移植自 ClaudeCodeInit 的 hooks 提示音方案：
 * pi 完全空闲（agent_settled）时播放 task_complete.wav、动画终端标题，
 * 并通过 pi.events 事件总线广播 "task-alert:done" —— hud 等展示层扩展
 * 订阅该事件自行决定如何呈现（hud 显示在行 1 动态区，替换「会话 Nmin」）。
 *
 * 实现要点：
 * - 触发时机用 agent_settled 而非 agent_end：保证 pi 不会自动重试/压缩/继续；
 * - 联动走 pi.events 官方事件总线：本插件只做「检测 + 声音 + 标题」，
 *   不知道 hud 的存在；hud 被禁用时提示自然退化为标题栏动画；
 * - 音频跨平台播放：Windows 用 PowerShell SoundPlayer，macOS 用 afplay，
 *   Linux 依次尝试 paplay/aplay，全失败退到终端响铃；任何失败都静默。
 * - 撤销时机：用户开始输入 / 新任务开始 / 超时自动撤 / 会话结束。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 提示音文件（install.js 会部署到 ~/.pi/agent/sounds/） */
const SOUND_PATH = path.join(os.homedir(), ".pi", "agent", "sounds", "task_complete.wav");

/** 各平台的播放器候选，按优先级排列；全部不可用时退到终端响铃 */
const PLAYERS: Record<string, Array<{ cmd: string; args: (file: string) => string[] }>> = {
	win32: [
		{ cmd: "powershell", args: (f) => ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${f}').PlaySync()`] },
	],
	darwin: [
		{ cmd: "afplay", args: (f) => [f] }, // macOS 自带
	],
	linux: [
		{ cmd: "paplay", args: (f) => [f] }, // PulseAudio / PipeWire
		{ cmd: "aplay", args: (f) => [f] }, // ALSA
	],
};

/** 标题栏动画间隔 */
const TITLE_INTERVAL_MS = 500;
/** 超时自动撤销提醒（用户长时间没回来就不闪了） */
const AUTO_DISMISS_MS = 60_000;
/** 标题栏动画帧 */
const TITLE_FRAMES = ["✅ 任务完成 — pi", "✨ 任务完成 — pi"];

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let titleTimer: NodeJS.Timeout | undefined;
	let dismissTimer: NodeJS.Timeout | undefined;
	let frame = 0;

	function clearTimers() {
		if (titleTimer) clearInterval(titleTimer);
		if (dismissTimer) clearTimeout(dismissTimer);
		titleTimer = undefined;
		dismissTimer = undefined;
	}

	function stopAlert(ctx: ExtensionContext) {
		clearTimers();
		// 通知展示层（hud 等）撤掉提醒
		pi.events.emit("task-alert:clear", {});
		if (ctx.hasUI) ctx.ui.setTitle("");
	}

	function playSound() {
		// 依次尝试当前平台的播放器候选，全失败则终端响铃兜底；任何一步出错都静默
		const candidates = PLAYERS[process.platform] ?? [];
		const tryNext = (i: number) => {
			if (i >= candidates.length) {
				process.stdout.write("\x07"); // BEL，零依赖兜底
				return;
			}
			const { cmd, args } = candidates[i];
			pi.exec(cmd, args(SOUND_PATH))
				.then((r) => {
					if (r.code !== 0) tryNext(i + 1);
				})
				.catch(() => tryNext(i + 1));
		};
		tryNext(0);
	}

	pi.on("agent_settled", async (_event, ctx) => {
		playSound();

		// 通知展示层（hud 订阅后会在行 1 动态区闪烁）
		pi.events.emit("task-alert:done", {});

		if (ctx.hasUI) {
			// 标题栏动画（切到其他窗口也能看到；hud 被禁用时这是唯一的视觉提醒）
			frame = 0;
			titleTimer = setInterval(() => {
				frame++;
				ctx.ui.setTitle(TITLE_FRAMES[frame % TITLE_FRAMES.length]);
			}, TITLE_INTERVAL_MS);
		}

		// 超时自动撤
		dismissTimer = setTimeout(() => stopAlert(ctx), AUTO_DISMISS_MS);
	});

	// 新任务开始 / 用户输入 → 立即撤掉提醒
	pi.on("agent_start", async (_event, ctx) => stopAlert(ctx));
	pi.on("input", async (_event, ctx) => {
		stopAlert(ctx);
		return { action: "continue" };
	});
	pi.on("session_shutdown", async () => clearTimers());
}
