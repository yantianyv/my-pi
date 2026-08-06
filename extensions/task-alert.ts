/**
 * task-alert: 任务完成提醒（音频 + 标题栏动画 + HUD 动态区提示）
 *
 * 移植自 ClaudeCodeInit 的 hooks 提示音方案：
 * pi 完全空闲（agent_settled）时播放 task_complete.wav、动画终端标题，
 * 并通过官方 ctx.ui.setStatus 通道推送 "task-alert" 状态 —— hud 等展示层扩展
 * 按 key 映射样式渲染在行 1 动态区（替换「会话 Nmin」）。
 *
 * 实现要点：
 * - 触发时机用 agent_settled 而非 agent_end：保证 pi 不会自动重试/压缩/继续；
 * - 联动走官方 setStatus 通道：本插件只做「检测 + 声音 + 标题 + 闪烁帧」，
 *   不知道 hud 的存在；hud 被禁用时状态自动回落原生 footer 第 3 行；
 * - 音频跨平台播放：Windows 用 PowerShell SoundPlayer，macOS 用 afplay，
 *   Linux 依次尝试 paplay/aplay，全失败退到终端响铃；任何失败都静默。
 * - 撤销时机：用户按键（onTerminalInput 原始按键流，无需等到发送）/ 新任务开始 / 超时自动撤 / 会话结束。
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
const AUTO_DISMISS_MS = 600_000;
/** 标题栏动画帧 */
const TITLE_FRAMES = ["✅ 任务完成 — pi", "✨ 任务完成 — pi"];
/** HUD 动态区闪烁帧（官方 setStatus 通道，hud 按 key 映射样式渲染） */
const STATUS_FRAMES = ["✅ 任务完成", "✨ 任务完成"];

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let titleTimer: ReturnType<typeof setTimeout> | undefined;
	let dismissTimer: ReturnType<typeof setTimeout> | undefined;
	let statusTimer: ReturnType<typeof setTimeout> | undefined; // HUD 动态区闪烁
	let statusFrame = 0;
	let frame = 0;
	let alertActive = false;
	let currentCtx: ExtensionContext | null = null;
	let inputHookInstalled = false;

	function clearTimers() {
		if (titleTimer) clearInterval(titleTimer);
		if (dismissTimer) clearTimeout(dismissTimer);
		if (statusTimer) clearInterval(statusTimer);
		titleTimer = undefined;
		dismissTimer = undefined;
		statusTimer = undefined;
	}

	function stopAlert(ctx: ExtensionContext) {
		if (!alertActive) return;
		alertActive = false;
		clearTimers();
		// 撤掉 HUD 状态（官方 setStatus 通道，hud 行 1 动态区自动回落占位）
		ctx.ui.setStatus("task-alert", undefined);
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
		alertActive = true;
		playSound();

		// HUD 动态区闪烁：官方 setStatus 通道（setStatus 触发全局重绘，hud 零延迟可见）；
		// 帧切换由本扩展自管，stopAlert/超时自动撤时一并清掉
		if (ctx.hasUI) {
			statusFrame = 0;
			ctx.ui.setStatus("task-alert", STATUS_FRAMES[0]);
			statusTimer = setInterval(() => {
				statusFrame++;
				ctx.ui.setStatus("task-alert", STATUS_FRAMES[statusFrame % STATUS_FRAMES.length]);
			}, TITLE_INTERVAL_MS);
		}

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

	// 新任务开始 / 提交输入 → 立即撤掉提醒
	pi.on("agent_start", async (_event, ctx) => stopAlert(ctx));
	pi.on("input", async (_event, ctx) => {
		stopAlert(ctx);
		return { action: "continue" };
	});

	// 按键即撤：onTerminalInput 是原始终端按键流（input 事件要等提交才触发）
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.mode !== "tui" || inputHookInstalled) return;
		inputHookInstalled = true;
		ctx.ui.onTerminalInput(() => {
			if (alertActive && currentCtx) stopAlert(currentCtx);
			return { consume: false }; // 只观察，不拦截按键
		});
	});

	pi.on("session_shutdown", async () => clearTimers());
}
