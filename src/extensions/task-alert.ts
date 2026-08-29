/**
 * task-alert: 多状态提醒（音频 + 标题栏动画 + HUD 动态区提示）
 *
 * 移植自 ClaudeCodeInit 的 hooks 提示音方案，语义对齐原 Claude Code hooks 映射：
 * - 任务完成（agent_settled 正常结束）→ task_complete.wav（原 Stop）
 * - 出错终止（agent_settled 且末条 assistant stopReason="error"）→ error.wav（原 PostToolUseFailure；
 *   语义收紧为「turn 以错误终止」才播，不做每个工具失败都响——grep 无匹配之类的常规失败太吵）
 * - 等待人工干预（ui_prompt_start，0.84.4 新增事件；perm-gate 人工复核 / ask 问卷等阻塞提示）
 *   → attention.wav（原 PermissionRequest）；应答（ui_prompt_end）自动撤
 * - 空闲提醒（完成提醒后 60s 无任何操作）→ idle_prompt.wav（原 Notification/idle_prompt，仅补一声不闪烁）
 * - 子代理完成（subagent 工具成功结束）→ subagent_complete.wav（原 SubagentStop，仅提示音无视觉，
 *   属中间事件，不打断标题/状态）
 *
 * 实现要点：
 * - 完成/出错触发时机用 agent_settled 而非 agent_end：保证 pi 不会自动重试/压缩/继续；
 * - 等待人工只在 agent 运行中被阻塞时提醒（ctx.isIdle() 守卫）——用户空闲时主动 /answer
 *   打开问卷不算「等待人工」；按键不撤等待提醒（用户需要按键回答提示），由 ui_prompt_end 撤；
 * - 联动走官方 setStatus 通道：三种状态各用独立 key（task-alert / task-alert-wait /
 *   task-alert-error），hud STATUS_STYLE 按 key 映射不同颜色；hud 缺席自动回落原生 footer；
 * - 音频跨平台播放：Windows 用 PowerShell SoundPlayer，macOS 用 afplay，
 *   Linux 依次尝试 paplay/aplay，全失败退到终端响铃；任何失败都静默；
 * - 撤销时机（完成/出错）：用户按键（onTerminalInput 原始按键流）/ 新任务开始 / 超时自动撤 / 会话结束。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 提示音目录（install.js 把 static/sounds/ 部署到这里）；音源：ClaudeCodeInit wav/piano/ */
const SOUND_DIR = path.join(os.homedir(), ".pi", "agent", "sounds");
const SOUNDS = {
	complete: "task_complete.wav",
	error: "error.wav",
	waiting: "attention.wav",
	idle: "idle_prompt.wav",
	subagent: "subagent_complete.wav",
} as const;

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

/** 提醒种类（完成 / 出错 / 等待人工），各配独立 setStatus key 供 hud 映射不同颜色 */
type AlertKind = "complete" | "error" | "waiting";

const ALERT_STYLE: Record<AlertKind, { statusKey: string; titleFrames: string[]; statusFrames: string[] }> = {
	complete: {
		statusKey: "task-alert",
		titleFrames: ["✅ 任务完成 — pi", "✨ 任务完成 — pi"],
		statusFrames: ["✅ 任务完成", "✨ 任务完成"],
	},
	error: {
		statusKey: "task-alert-error",
		titleFrames: ["❌ 任务出错 — pi", "⚠️ 任务出错 — pi"],
		statusFrames: ["❌ 任务出错", "⚠️ 任务出错"],
	},
	waiting: {
		statusKey: "task-alert-wait",
		titleFrames: ["⏳ 等待人工 — pi", "🔔 等待人工 — pi"],
		statusFrames: ["⏳ 等待人工", "🔔 等待人工"],
	},
};

/** 标题栏/状态动画间隔 */
const TITLE_INTERVAL_MS = 500;
/** 完成提醒后无操作多久补一声空闲提醒（对齐 Claude idle_prompt 语义） */
const IDLE_REMIND_MS = 60_000;
/** 超时自动撤销提醒（用户长时间没回来就不闪了） */
const AUTO_DISMISS_MS = 600_000;

/** 取 turn 末条 assistant 消息的 stopReason（无 assistant 消息返回 undefined） */
function lastStopReason(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string } | null;
		if (!m || typeof m !== "object") continue;
		if (m.role === "assistant") return m.stopReason;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let titleTimer: ReturnType<typeof setTimeout> | undefined;
	let dismissTimer: ReturnType<typeof setTimeout> | undefined;
	let statusTimer: ReturnType<typeof setTimeout> | undefined; // HUD 动态区闪烁
	let idleTimer: ReturnType<typeof setTimeout> | undefined; // 完成后 60s 无操作补空闲提醒
	let statusFrame = 0;
	let frame = 0;
	let alertKind: AlertKind | null = null;
	let currentCtx: ExtensionContext | null = null;
	let inputHookUnsubscribe: (() => void) | undefined; // pi 返回的注销函数，兼作「已注册」标志
	/** 上一次 agent_end 末条 assistant 的 stopReason（aborted 不提醒、error 播出错音） */
	let lastEndStopReason: string | undefined;
	/** 嵌套 UI 提示深度（连续多个提示只撤最后一次） */
	let waitingDepth = 0;

	function clearTimers() {
		if (titleTimer) clearInterval(titleTimer);
		if (dismissTimer) clearTimeout(dismissTimer);
		if (statusTimer) clearInterval(statusTimer);
		if (idleTimer) clearTimeout(idleTimer);
		titleTimer = undefined;
		dismissTimer = undefined;
		statusTimer = undefined;
		idleTimer = undefined;
	}

	function stopAlert(ctx: ExtensionContext) {
		if (!alertKind) return;
		const key = ALERT_STYLE[alertKind].statusKey;
		alertKind = null;
		clearTimers();
		// 撤掉 HUD 状态（官方 setStatus 通道，hud 行 1 动态区自动回落占位）
		ctx.ui.setStatus(key, undefined);
		if (ctx.hasUI) ctx.ui.setTitle("");
	}

	function playSound(file: string) {
		// 依次尝试当前平台的播放器候选，全失败则终端响铃兜底；任何一步出错都静默
		const candidates = PLAYERS[process.platform] ?? [];
		const target = path.join(SOUND_DIR, file);
		const tryNext = (i: number) => {
			if (i >= candidates.length) {
				process.stdout.write("\x07"); // BEL，零依赖兜底
				return;
			}
			const { cmd, args } = candidates[i];
			pi.exec(cmd, args(target))
				.then((r) => {
					if (r.code !== 0) tryNext(i + 1);
				})
				.catch(() => tryNext(i + 1));
		};
		tryNext(0);
	}

	/** 启动（或替换）一个提醒：声音 + HUD 状态闪烁 + 标题动画 + 超时自动撤 */
	function startAlert(kind: AlertKind, ctx: ExtensionContext, statusSuffix?: string) {
		stopAlert(ctx);
		alertKind = kind;
		const style = ALERT_STYLE[kind];
		playSound(SOUNDS[kind]);

		const statusText = (i: number) => style.statusFrames[i % style.statusFrames.length] + (statusSuffix ?? "");

		if (ctx.hasUI) {
			// HUD 动态区闪烁：官方 setStatus 通道（setStatus 触发全局重绘，hud 零延迟可见）；
			// 帧切换由本扩展自管，stopAlert/超时自动撤时一并清掉
			statusFrame = 0;
			ctx.ui.setStatus(style.statusKey, statusText(0));
			statusTimer = setInterval(() => {
				statusFrame++;
				ctx.ui.setStatus(style.statusKey, statusText(statusFrame));
			}, TITLE_INTERVAL_MS);

			// 标题栏动画（切到其他窗口也能看到；hud 被禁用时这是唯一的视觉提醒）
			frame = 0;
			titleTimer = setInterval(() => {
				frame++;
				ctx.ui.setTitle(style.titleFrames[frame % style.titleFrames.length]);
			}, TITLE_INTERVAL_MS);
		}

		// 完成提醒 60s 无操作 → 补一声空闲提醒（仅声音一次，不动视觉）
		if (kind === "complete") {
			idleTimer = setTimeout(() => {
				if (alertKind === "complete") playSound(SOUNDS.idle);
			}, IDLE_REMIND_MS);
		}

		// 超时自动撤
		dismissTimer = setTimeout(() => stopAlert(ctx), AUTO_DISMISS_MS);
	}

	// 记录本 turn 末条 assistant 的 stopReason：
	// aborted → agent_settled 视为「打断完成」不提醒；error → 出错提醒；其余 → 完成提醒
	pi.on("agent_end", async (event) => {
		lastEndStopReason = lastStopReason(event.messages);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const reason = lastEndStopReason;
		lastEndStopReason = undefined;
		if (reason === "aborted") return; // Ctrl+C 打断：不触发提醒
		startAlert(reason === "error" ? "error" : "complete", ctx);
	});

	// 等待人工干预：agent 运行中被阻塞的 UI 提示（perm-gate 复核 / ask 问卷等）。
	// 用户空闲时主动开的提示（如 /answer）不算——isIdle 守卫挡掉。
	pi.on("ui_prompt_start", async (event, ctx) => {
		if (ctx.isIdle()) return;
		waitingDepth++;
		// 提示标题截断进状态文案（如「⏳ 等待人工：权限复核」）
		const title = event.title?.replace(/\s+/g, " ").trim();
		const suffix = title ? `：${title.length > 12 ? title.slice(0, 12) + "…" : title}` : "";
		startAlert("waiting", ctx, suffix);
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		waitingDepth = Math.max(0, waitingDepth - 1);
		if (waitingDepth === 0 && alertKind === "waiting") stopAlert(ctx);
	});

	// 子代理完成：仅提示音（中间事件，不动标题/状态）；失败交给 turn 级 error 统一收尾
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "subagent" && !event.isError) playSound(SOUNDS.subagent);
	});

	// 新任务开始 / 提交输入 → 立即撤掉提醒
	pi.on("agent_start", async (_event, ctx) => {
		lastEndStopReason = undefined; // 防残留：新 turn 开始时重置
		waitingDepth = 0;
		stopAlert(ctx);
	});
	pi.on("input", async (_event, ctx) => {
		stopAlert(ctx);
		return { action: "continue" };
	});

	// 按键即撤：onTerminalInput 是原始终端按键流（input 事件要等提交才触发）。
	// 例外：等待人工提醒不按键盘撤——用户需要按键回答提示本身，由 ui_prompt_end 撤。
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.mode !== "tui" || inputHookUnsubscribe) return;
		inputHookUnsubscribe = ctx.ui.onTerminalInput(() => {
			if (alertKind && alertKind !== "waiting" && currentCtx) stopAlert(currentCtx);
			return { consume: false }; // 只观察，不拦截按键
		});
	});

	pi.on("session_shutdown", async () => {
		clearTimers();
		inputHookUnsubscribe?.();
		inputHookUnsubscribe = undefined;
	});
}
