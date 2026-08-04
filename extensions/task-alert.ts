/**
 * task-alert: 任务完成提醒（音频 + 闪烁状态 + 标题栏动画）
 *
 * 移植自 ClaudeCodeInit 的 hooks 提示音方案：
 * pi 完全空闲（agent_settled）时播放 task_complete.wav，同时在状态栏贴一条
 * 闪烁的「✅ 任务完成」并动画终端标题，便于用户及时回来发下一步指令。
 *
 * 实现要点：
 * - 触发时机用 agent_settled 而非 agent_end：保证 pi 不会自动重试/压缩/继续；
 * - 状态提示走 pi 官方 setStatus 通道：hud.ts 的行 2「扩展状态集锦」会自动
 *   显示它，本插件与 hud 零耦合；hud 被禁用时默认 footer 也能显示；
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
/** 状态栏闪烁间隔 */
const FLASH_INTERVAL_MS = 500;
/** 超时自动撤销提醒（用户长时间没回来就不闪了） */
const AUTO_DISMISS_MS = 60_000;
/** 闪烁帧（交替显示形成闪烁） */
const FRAMES = ["✅ 任务完成", "✨ 任务完成"];

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let flashTimer: NodeJS.Timeout | undefined;
	let dismissTimer: NodeJS.Timeout | undefined;
	let frame = 0;

	function stopAlert(ctx: ExtensionContext) {
		if (flashTimer) clearInterval(flashTimer);
		if (dismissTimer) clearTimeout(dismissTimer);
		flashTimer = undefined;
		dismissTimer = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus("task-alert", undefined);
			ctx.ui.setTitle("");
		}
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
		if (!ctx.hasUI) return;

		// 闪烁状态 + 标题栏动画
		frame = 0;
		flashTimer = setInterval(() => {
			frame++;
			const text = FRAMES[frame % FRAMES.length];
			ctx.ui.setStatus("task-alert", ctx.ui.theme.fg("success", text));
			ctx.ui.setTitle(`${text} — pi`);
		}, FLASH_INTERVAL_MS);

		// 超时自动撤
		dismissTimer = setTimeout(() => stopAlert(ctx), AUTO_DISMISS_MS);
	});

	// 新任务开始 / 用户输入 → 立即撤掉提醒
	pi.on("agent_start", async (_event, ctx) => stopAlert(ctx));
	pi.on("input", async (_event, ctx) => {
		stopAlert(ctx);
		return { action: "continue" };
	});
	pi.on("session_shutdown", async () => {
		if (flashTimer) clearInterval(flashTimer);
		if (dismissTimer) clearTimeout(dismissTimer);
	});
}
