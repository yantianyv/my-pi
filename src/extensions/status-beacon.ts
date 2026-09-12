/**
 * status-beacon: 全链路状态感知（执行中标题进度 + 完成/出错/等待提醒：音频 + 标题栏动画 + HUD 动态区）
 *
 * 前身是 task-alert（多状态提醒），2026-09 扩展为「全链路」：不只任务收尾时提醒，
 * agent 工作全程都在终端标题上反映进展，用户切到其他窗口也能从任务栏/标签页看到：
 *
 *   执行中（agent_start → agent_settled）
 *     → 标题 spinner（200ms 转帧）+ 当前活动（工具执行时显示工具图标+名称，生成时显示「思考中」）+ 目录名
 *     → 如「⠋ ⌨️ bash — my_pi」；ui_prompt 阻塞时让位给等待人工提醒，应答后自动恢复
 *   任务完成（agent_settled 正常结束）→ task_complete.wav + ✅ 标题/状态栏闪烁
 *   出错终止（末条 assistant stopReason="error"）→ error.wav + ❌ 闪烁
 *   等待人工（ui_prompt_start；perm-gate 人工复核 / ask 问卷等阻塞提示）→ attention.wav + ⏳ 闪烁，
 *     应答（ui_prompt_end）自动撤；agent 仍在运行时恢复执行中标题
 *   空闲提醒（完成提醒后 60s 无操作）→ idle_prompt.wav（仅补一声不闪烁）
 *   子代理完成（subagent 工具成功结束）→ subagent_complete.wav（仅提示音无视觉，中间事件）
 *
 * 音源与提示音语义沿用 ClaudeCodeInit hooks 方案（wav/piano），出错语义收紧为
 * 「turn 以错误终止」才播，不做每个工具失败都响（grep 无匹配之类的常规失败太吵）。
 *
 * 实现要点：
 * - 完成/出错触发时机用 agent_settled 而非 agent_end：保证 pi 不会自动重试/压缩/继续；
 * - 等待人工只在 agent 运行中被阻塞时提醒（ctx.isIdle() 守卫）——用户空闲时主动 /answer
 *   打开问卷不算「等待人工」；按键不撤等待提醒（用户需要按键回答提示），由 ui_prompt_end 撤；
 * - 标题单通道所有权全在本扩展：执行中标题与提醒标题互斥（startAlert 停执行标题，
 *   stopAlert 在 agent 仍运行时恢复执行标题），避免两个动画互相覆盖；
 * - 联动走官方 setStatus 通道：三种提醒状态各用独立 key（沿用 task-alert / task-alert-wait /
 *   task-alert-error 旧 key 名，hud STATUS_STYLE 映射不变、零改动），hud 缺席自动回落原生 footer；
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

/** 提醒的标题栏/状态栏闪烁间隔 */
const TITLE_INTERVAL_MS = 500;
/** 完成提醒后无操作多久补一声空闲提醒（对齐 Claude idle_prompt 语义） */
const IDLE_REMIND_MS = 60_000;
/** 超时自动撤销提醒（用户长时间没回来就不闪了） */
const AUTO_DISMISS_MS = 600_000;

// ---------------------------------------------------------------------------
// 执行中标题（全链路「进行中」段）
// ---------------------------------------------------------------------------

/** spinner 转帧（braille，终端标题宽度友好） */
const WORK_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** 执行中标题转帧间隔（比提醒闪烁快，一眼看出「在跑」） */
const WORK_TITLE_INTERVAL_MS = 200;

/** 常见工具的标题图标映射（未命中退 🔧）；只装饰，活动文本仍以工具名为准 */
const TOOL_ICON: Record<string, string> = {
	bash: "⌨️",
	read: "📖",
	write: "✏️",
	edit: "✏️",
	web_search: "🌐",
	web_fetch: "🌐",
	explore: "🤖",
	subagent: "🤖",
	ask: "❓",
	wf_workflow: "📋",
	wf_switch: "📋",
	kb_search: "📚",
	kb_read: "📚",
	kb_write: "📚",
};

/** 工具名 → 标题活动文案（图标 + 截断工具名） */
function toolLabel(name: string): string {
	const icon = TOOL_ICON[name] ?? "🔧";
	const short = name.length > 16 ? name.slice(0, 16) + "…" : name;
	return `${icon} ${short}`;
}

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
	let workTimer: ReturnType<typeof setTimeout> | undefined; // 执行中标题转帧
	let statusFrame = 0;
	let frame = 0;
	let workFrame = 0;
	let alertKind: AlertKind | null = null;
	let currentCtx: ExtensionContext | null = null;
	let inputHookUnsubscribe: (() => void) | undefined; // pi 返回的注销函数，兼作「已注册」标志
	/** 上一次 agent_end 末条 assistant 的 stopReason（aborted 不提醒、error 播出错音） */
	let lastEndStopReason: string | undefined;
	/** 嵌套 UI 提示深度（连续多个提示只撤最后一次） */
	let waitingDepth = 0;
	/** agent 是否在运行（agent_start → agent_settled）：决定 stopAlert 后是否恢复执行中标题 */
	let agentRunning = false;
	/** 当前正在执行的工具活动文案（null = 模型生成中，显示「思考中」） */
	let currentTool: string | null = null;

	function clearTimers() {
		if (titleTimer) clearInterval(titleTimer);
		if (dismissTimer) clearTimeout(dismissTimer);
		if (statusTimer) clearInterval(statusTimer);
		if (idleTimer) clearTimeout(idleTimer);
		if (workTimer) clearInterval(workTimer);
		titleTimer = undefined;
		dismissTimer = undefined;
		statusTimer = undefined;
		idleTimer = undefined;
		workTimer = undefined;
	}

	// ---- 执行中标题 ---------------------------------------------------------

	function workTitleText(): string {
		const spinner = WORK_SPINNER_FRAMES[workFrame % WORK_SPINNER_FRAMES.length];
		return `${spinner} ${currentTool ?? "思考中"} — ${path.basename(process.cwd())}`;
	}

	/** 启动执行中标题（agent_running 且无提醒时）；重复调用幂等 */
	function startWorkTitle(ctx: ExtensionContext) {
		if (!ctx.hasUI || workTimer || alertKind) return;
		workFrame = 0;
		ctx.ui.setTitle(workTitleText());
		workTimer = setInterval(() => {
			workFrame++;
			ctx.ui.setTitle(workTitleText());
		}, WORK_TITLE_INTERVAL_MS);
	}

	/** 停止执行中标题；restore=true 时把标题还给 pi 默认（π - 目录名） */
	function stopWorkTitle(ctx: ExtensionContext, restore: boolean) {
		if (workTimer) clearInterval(workTimer);
		workTimer = undefined;
		currentTool = null;
		if (restore && ctx.hasUI) ctx.ui.setTitle("");
	}

	// ---- 提醒（完成 / 出错 / 等待人工） -------------------------------------

	function stopAlert(ctx: ExtensionContext) {
		if (!alertKind) return;
		const key = ALERT_STYLE[alertKind].statusKey;
		alertKind = null;
		clearTimers();
		// 撤掉 HUD 状态（官方 setStatus 通道，hud 行 1 动态区自动回落占位）
		ctx.ui.setStatus(key, undefined);
		if (!ctx.hasUI) return;
		// agent 仍在跑（如等待人工应答后）→ 恢复执行中标题；否则还给 pi 默认标题
		if (agentRunning) startWorkTitle(ctx);
		else ctx.ui.setTitle("");
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
		stopWorkTitle(ctx, false); // 标题单通道：提醒期间执行中标题让位
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

	// ---- 事件钩子 -----------------------------------------------------------

	// 记录本 turn 末条 assistant 的 stopReason：
	// aborted → agent_settled 视为「打断完成」不提醒；error → 出错提醒；其余 → 完成提醒
	pi.on("agent_end", async (event) => {
		lastEndStopReason = lastStopReason(event.messages);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		agentRunning = false;
		const reason = lastEndStopReason;
		lastEndStopReason = undefined;
		if (reason === "aborted") {
			// Ctrl+C 打断：不触发提醒，执行中标题还给 pi 默认
			stopWorkTitle(ctx, true);
			return;
		}
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

	// 工具执行开始 → 执行中标题显示当前工具活动（提醒期间让位，不抢标题）
	pi.on("tool_execution_start", async (event) => {
		currentTool = toolLabel(event.toolName);
		if (workTimer && currentCtx?.hasUI) currentCtx.ui.setTitle(workTitleText());
	});

	// 工具执行结束 → 回到「思考中」；子代理完成补一声提示音（中间事件，不动标题/状态），
	// 失败交给 turn 级 error 统一收尾
	pi.on("tool_execution_end", async (event) => {
		currentTool = null;
		if (event.toolName === "subagent" && !event.isError) playSound(SOUNDS.subagent);
	});

	// 新任务开始 → 撤掉上一提醒 + 启动执行中标题
	pi.on("agent_start", async (_event, ctx) => {
		lastEndStopReason = undefined; // 防残留：新 turn 开始时重置
		waitingDepth = 0;
		stopAlert(ctx);
		agentRunning = true;
		currentCtx = ctx;
		startWorkTitle(ctx);
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
		agentRunning = false;
		clearTimers();
		inputHookUnsubscribe?.();
		inputHookUnsubscribe = undefined;
	});
}
