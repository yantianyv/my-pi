/**
 * status-beacon: 全链路状态感知（执行中标题进度 + 完成/出错/等待提醒：音频 + 标题栏动画 + HUD 动态区）
 *
 * 前身是 task-alert（多状态提醒），2026-09 扩展为「全链路」：不只任务收尾时提醒，
 * agent 工作全程都在终端标题上反映进展，用户切到其他窗口也能从任务栏/标签页看到：
 *
 *   执行中（agent_start → agent_settled）
 *     → 标题 spinner（200ms 转帧）+ 当前活动（工具执行时显示工具图标+名称，生成时显示「思考中」）+ 目录名
 *     → 如「⠋ ⌨️ bash — my_pi」；ui_prompt 阻塞时让位给等待人工提醒，应答后自动恢复
 *     → 同时接管执行中 Working 行（pi setWorkingMessage，本扩展独占写入），按「在等什么」分层：
 *       等人工（ui_prompt 阻塞：ask 问卷/perm-gate 复核，文本可由扩展经 __PI_STATUS_BEACON_API__ 登记）
 *       > 等工具/子代理完成 > 生成中显廉价 AI 概括的当前动作短语（message_end 触发后台异步概括，
 *       仿 perm-gate 审核的 pickAuxModel 路线；无则退注册表 work，再退 pi 默认「Working」）；
 *       run 开局重置，防上一 run 文案残留
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
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import { pickAuxModel, type AnyModel } from "./shared/model-pick";
import { pickModelViaSelector } from "./shared/model-selector";
import {
	claimSoundSlot,
	computeActive,
	computeAway,
	disposeIdleProbe,
	disposePresence,
	getOsIdleMs,
	initPresence,
	markUserInput,
	recentPiInputMs,
} from "./shared/presence";
import * as fs from "node:fs";
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
/** 视为「子代理」的工具名（内置 explore 与第三方 subagent 插件），完成后补一声提示音 */
const SUBAGENT_TOOLS = new Set(["subagent", "explore", "Task"]);
/** 完成提醒后无操作多久补一声空闲提醒（对齐 Claude idle_prompt 语义） */
const IDLE_REMIND_MS = 60_000;
/** 超时自动撤销提醒（用户长时间没回来就不闪了） */
const AUTO_DISMISS_MS = 600_000;

/**
 * 提示音的「在场门控」（跨实例协调，详见 shared/presence）：
 * - ACTIVE_IDLE_MS：手还在键盘/鼠标上（系统级空闲小于此值）→ 只闪标题不出声，不打断当前操作；
 * - AWAY_IDLE_MS：判定「人不在」的阀值（所有 pi 实例都超过这么久无输入），
 *   补第二声空闲提醒只在人真的不在时才响；
 * - SOUND_DEDUPE_MS：全局去重窗口——多实例同时收尾时只有第一个出声，不再「交响乐」。
 * 都可在 status-beacon.json 里覆盖（见 loadPresenceConfig）。
 */
const ACTIVE_IDLE_MS = 20_000;
const AWAY_IDLE_MS = 5 * 60_000;
const SOUND_DEDUPE_MS = 2_500;

// ---------------------------------------------------------------------------
// 执行中标题（全链路「进行中」段）
// ---------------------------------------------------------------------------

/** spinner 转帧（braille，终端标题宽度友好） */
const WORK_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** 执行中标题转帧间隔（比提醒闪烁快，一眼看出「在跑」） */
const WORK_TITLE_INTERVAL_MS = 200;

/** Working 行：廉价 AI 概括「正在干什么」短语的超时与节流（概括是增强，失败静默保留旧短语） */
const STEP_PHRASE_MAX_CHARS = 16;
const STEP_PHRASE_TIMEOUT_MS = 15_000;
const STEP_PHRASE_MIN_INTERVAL_MS = 12_000;
const STEP_PHRASE_MAX_CHARS_INPUT = 1500;

/** 概括模型覆盖项配置（/beacon model 写入；缺省 = 自动：最便宜已认证模型） */
const BEACON_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "status-beacon.json");

function loadBeaconModel(): string | undefined {
	try {
		const j = JSON.parse(fs.readFileSync(BEACON_CONFIG_FILE, "utf8")) as { model?: string };
		return typeof j.model === "string" && j.model.trim() ? j.model : undefined;
	} catch {
		return undefined;
	}
}

/** 在场门控配置（status-beacon.json 可覆盖；presenceGate:false 则完全按单实例行为发声） */
interface PresenceConfig {
	enabled: boolean;
	/** status-beacon.json 里用 presenceGate:false 关闭门控 */
	presenceGate?: boolean;
	activeIdleMs: number;
	awayIdleMs: number;
	dedupeMs: number;
}

function loadPresenceConfig(): PresenceConfig {
	const fallback: PresenceConfig = {
		enabled: true,
		activeIdleMs: ACTIVE_IDLE_MS,
		awayIdleMs: AWAY_IDLE_MS,
		dedupeMs: SOUND_DEDUPE_MS,
	};
	try {
		const j = JSON.parse(fs.readFileSync(BEACON_CONFIG_FILE, "utf8")) as Partial<PresenceConfig> & { presenceGate?: boolean };
		return {
			enabled: j.presenceGate !== false,
			activeIdleMs: typeof j.activeIdleMs === "number" && j.activeIdleMs >= 0 ? j.activeIdleMs : ACTIVE_IDLE_MS,
			awayIdleMs: typeof j.awayIdleMs === "number" && j.awayIdleMs >= 0 ? j.awayIdleMs : AWAY_IDLE_MS,
			dedupeMs: typeof j.dedupeMs === "number" && j.dedupeMs >= 0 ? j.dedupeMs : SOUND_DEDUPE_MS,
		};
	} catch {
		return fallback;
	}
}

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

/** 工具名 → 标题图标+短名（未命中退 🔧） */
function toolLabel(name: string): string {
	const icon = TOOL_ICON[name] ?? "🔧";
	const short = name.length > 16 ? name.slice(0, 16) + "…" : name;
	return `${icon} ${short}`;
}

/** ui_prompt kind → 人话（扩展未登记等待文本、事件也无 title 时兜底） */
function promptKindLabel(kind: string): string {
	switch (kind) {
		case "select":
			return "选择";
		case "confirm":
			return "确认";
		case "input":
			return "输入";
		case "editor":
			return "编辑";
		default:
			return "处理交互提示";
	}
}

/** 从 pair-guard 注册表读本会话 work（AI 自报的工作标题）；注册表缺席/损坏返回 undefined */
function readWork(ctx: ExtensionContext): string | undefined {
	try {
		const sid = ctx.sessionManager.getSessionId();
		const raw = fs.readFileSync(path.join(ctx.cwd, ".pi", "sessions", `${sid}.json`), "utf8");
		const w = (JSON.parse(raw) as { work?: string }).work;
		return typeof w === "string" && w.trim() ? w : undefined;
	} catch {
		return undefined;
	}
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

	// ---- Working 行「在等什么」（本扩展独占 setWorkingMessage 写入） ----------------
	let promptKind: string | null = null; // ui_prompt 阻塞中的 kind（等人工层级用）
	let promptTitle: string | undefined; // ui_prompt 事件的 title（custom 类通常缺失）
	let promptWaitText: string | undefined; // 阻塞 UI 的扩展登记的具体等待文本（ask/perm-gate）
	let stepPhrase: string | undefined; // 廉价 AI 概括的「正在干什么」短语（生成中显示）
	let stepInFlight = false;
	let stepLastAt = 0;
	let beaconModel = loadBeaconModel(); // 概括模型覆盖项（provider/id）；undefined = 自动最便宜
	let presenceCfg = loadPresenceConfig(); // 提示音在场门控（session_start 重读，便于手改配置后重启会话生效）

	/** 概括用模型：手动覆盖优先（不可用时静默退自动），自动 = 最便宜已认证模型 */
	function resolveStepModel(ctx: ExtensionContext): AnyModel | undefined {
		if (beaconModel) {
			const slash = beaconModel.indexOf("/");
			const m = slash > 0 ? ctx.modelRegistry.find(beaconModel.slice(0, slash), beaconModel.slice(slash + 1)) : undefined;
			if (m && ctx.modelRegistry.hasConfiguredAuth(m)) return m;
		}
		return pickAuxModel(ctx, []);
	}

	/**
	 * Working 行文案分层：等你 X > 等 X 完成 > 正在（廉价 AI 短语 > work > pi 默认）。
	 * 只给文案、不自带 spinner：pi 的 Working 指示器本身就在行首转（默认盲文帧 80ms），
	 * 再拼一个帧就是两支并排转圈。
	 */
	function workingLineText(ctx: ExtensionContext): string | undefined {
		if (promptKind) {
			const detail = promptWaitText ?? promptTitle ?? promptKindLabel(promptKind);
			return `等你：${detail}`;
		}
		if (currentTool) return `等 ${currentTool} 完成…`;
		if (stepPhrase) return `正在${stepPhrase}…`;
		const work = readWork(ctx);
		return work ? `正在${work}…` : `工作中…`;
	}

	/** 把当前分层文案推到 Working 行（agent 未运行/无 UI 时不写） */
	function applyWorking(ctx: ExtensionContext): void {
		if (!agentRunning || !ctx.hasUI) return;
		ctx.ui.setWorkingMessage(workingLineText(ctx));
	}

	/** 廉价 AI 概括「正在干什么」：最新 assistant 回复 → ≤16 字动词短语（异步、节流、失败静默） */
	function summarizeStep(ctx: ExtensionContext, assistantText: string): void {
		if (stepInFlight || Date.now() - stepLastAt < STEP_PHRASE_MIN_INTERVAL_MS) return;
		const model = resolveStepModel(ctx);
		if (!model) return;
		void (async () => {
			stepInFlight = true;
			stepLastAt = Date.now();
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) return;
				const work = readWork(ctx);
				const truncated =
					assistantText.length > STEP_PHRASE_MAX_CHARS_INPUT
						? assistantText.slice(0, STEP_PHRASE_MAX_CHARS_INPUT) + "\n…(已截断)"
						: assistantText;
				const messages: Message[] = [
					{
						role: "user",
						content: `工作标题：${work ?? "（未设）"}\n\nAI 助手最新回复：\n${truncated}`,
						timestamp: Date.now(),
					},
				];
				const result = await completeSimple(
					model,
					{
						systemPrompt:
							"你是实时进度观察员。根据 AI 助手的最新回复，用一个不超过 16 字的动词短语概括它当前正在执行的步骤（如「排查图片超限问题」「重构锁等待逻辑」）。只输出短语本身，不要主语、句号或任何解释。",
						messages,
					},
					{
						apiKey: auth.apiKey,
						headers: { ...auth.headers },
						maxTokens: 64,
						temperature: 0,
						signal: AbortSignal.timeout(STEP_PHRASE_TIMEOUT_MS),
					},
				);
				const text = result.content
					.filter((b) => b.type === "text")
					.map((b) => (b as { type: "text"; text: string }).text)
					.join("")
					.trim()
					.split("\n")[0]
					.trim()
					.slice(0, STEP_PHRASE_MAX_CHARS);
				if (text && text !== stepPhrase) {
					stepPhrase = text;
					applyWorking(ctx); // 生成中/空闲工具态立即热更
				}
			} catch {
				/* 概括是增强：失败静默，保留旧短语 */
			} finally {
				stepInFlight = false;
			}
		})();
	}

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

	/**
	 * 带在场门控的提示音：手在键盘上（或本实例刚有输入）→ 只闪不出声；
	 * 抢不到全局名额（别的实例刚响过）→ 也不出声。visual 提醒不受影响。
	 * requireAway=true 用于「补第二声」：只有人真的不在时才响。
	 */
	function playSoundGated(file: string, opts: { requireAway?: boolean } = {}) {
		if (presenceCfg.enabled) {
			const osIdle = getOsIdleMs();
			const piIdle = recentPiInputMs();
			if (opts.requireAway) {
				if (!computeAway(osIdle, piIdle, presenceCfg.awayIdleMs)) return;
			} else if (computeActive(osIdle, piIdle, presenceCfg.activeIdleMs)) {
				return; // 人正在操作：默认不打扰
			}
			if (!claimSoundSlot(presenceCfg.dedupeMs)) return; // 多实例同时收尾：只响第一声
		}
		playSound(file);
	}

	/** 启动（或替换）一个提醒：声音 + HUD 状态闪烁 + 标题动画 + 超时自动撤 */
	function startAlert(kind: AlertKind, ctx: ExtensionContext, statusSuffix?: string) {
		stopAlert(ctx);
		stopWorkTitle(ctx, false); // 标题单通道：提醒期间执行中标题让位
		alertKind = kind;
		const style = ALERT_STYLE[kind];
		playSoundGated(SOUNDS[kind]);

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

		// 完成提醒 60s 后仍无人应答 → 补一声空闲提醒（仅声音一次，不动视觉；
		// 只有人真的不在时才响，免得在场用户被打扰两次）
		if (kind === "complete") {
			idleTimer = setTimeout(() => {
				if (alertKind === "complete") playSoundGated(SOUNDS.idle, { requireAway: true });
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
		// 提示标题截断进状态文案（如「⏳ 等待人工：权限复核」）；扩展登记的等待文本优先
		const title = (promptWaitText ?? event.title)?.replace(/\s+/g, " ").trim();
		const suffix = title ? `：${title.length > 12 ? title.slice(0, 12) + "…" : title}` : "";
		startAlert("waiting", ctx, suffix);
		promptKind = event.kind;
		promptTitle = event.title;
		applyWorking(ctx);
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		waitingDepth = Math.max(0, waitingDepth - 1);
		if (waitingDepth === 0 && alertKind === "waiting") stopAlert(ctx);
		if (waitingDepth === 0) {
			promptKind = null;
			promptTitle = undefined;
			applyWorking(ctx);
		}
	});

	// 工具执行开始 → 执行中标题显示当前工具活动（提醒期间让位，不抢标题）；
	// Working 行切换到「等 X 完成…」层级
	pi.on("tool_execution_start", async (event, ctx) => {
		currentTool = toolLabel(event.toolName);
		if (workTimer && currentCtx?.hasUI) currentCtx.ui.setTitle(workTitleText());
		applyWorking(ctx);
	});

	// 工具执行结束 → 回到「思考中」；子代理完成补一声提示音（中间事件，不动标题/状态），
	// 失败交给 turn 级 error 统一收尾。子代理工具名随实现而异（内置 explore / 第三方 subagent）
	pi.on("tool_execution_end", async (event, ctx) => {
		currentTool = null;
		applyWorking(ctx);
		if (SUBAGENT_TOOLS.has(event.toolName) && !event.isError) playSoundGated(SOUNDS.subagent);
	});

	// assistant 消息完结 → 触发廉价 AI 异步概括「正在干什么」（节流，静默失败）
	pi.on("message_end", async (event, ctx) => {
		if (!agentRunning) return;
		const m = event.message;
		if (m.role !== "assistant") return;
		const text = m.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { type: "text"; text: string }).text)
			.join("\n")
			.trim();
		if (text) summarizeStep(ctx, text);
	});

	// 新任务开始 → 撤掉上一提醒 + 启动执行中标题
	pi.on("agent_start", async (_event, ctx) => {
		lastEndStopReason = undefined; // 防残留：新 turn 开始时重置
		waitingDepth = 0;
		stopAlert(ctx);
		agentRunning = true;
		currentCtx = ctx;
		startWorkTitle(ctx);
		// Working 行 run 开局重置：清上一 run 的工具/短语残留，先显 work 兑底
		currentTool = null;
		stepPhrase = undefined;
		applyWorking(ctx);
	});
	pi.on("input", async (_event, ctx) => {
		markUserInput(); // 用户提交消息：本实例在场信号
		stopAlert(ctx);
		return { action: "continue" };
	});

	// 按键即撤：onTerminalInput 是原始终端按键流（input 事件要等提交才触发）。
	// 例外：等待人工提醒不按键盘撤——用户需要按键回答提示本身，由 ui_prompt_end 撤。
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		presenceCfg = loadPresenceConfig();
		const sid = ctx.sessionManager?.getSessionId?.() ?? `pid-${process.pid}`;
		const project = ctx.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
		initPresence(sid, project);
		if (ctx.mode !== "tui" || inputHookUnsubscribe) return;
		inputHookUnsubscribe = ctx.ui.onTerminalInput(() => {
			markUserInput(); // 任何按键都算「人在」（写盘内部节流 5s）
			if (alertKind && alertKind !== "waiting" && currentCtx) stopAlert(currentCtx);
			return { consume: false }; // 只观察，不拦截按键
		});
	});

	pi.on("ui_prompt_end", async () => markUserInput());

	pi.on("session_shutdown", async () => {
		agentRunning = false;
		clearTimers();
		inputHookUnsubscribe?.();
		inputHookUnsubscribe = undefined;
		disposeIdleProbe();
		disposePresence();
		delete (globalThis as Record<string, unknown>).__PI_STATUS_BEACON_API__;
	});

	// /beacon 命令：概括模型选择（无参官方面板 / auto / provider/id）+ status 查看在场门控
	pi.registerCommand("beacon", {
		description: "status-beacon：Working 行概括模型（无参选面板 / auto / provider/id）；/beacon status 查看提示音在场门控状态",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "status" || arg === "presence") {
				const osIdle = getOsIdleMs();
				const piIdle = recentPiInputMs();
				const fmt = (ms: number) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : "无");
				const verdict = !presenceCfg.enabled
					? "已关闭（全部提示音照常播放）"
					: computeActive(osIdle, piIdle, presenceCfg.activeIdleMs)
						? `人在操作（系统空闲 < ${Math.round(presenceCfg.activeIdleMs / 1000)}s）→ 只闪不出声`
						: computeAway(osIdle, piIdle, presenceCfg.awayIdleMs)
							? `已离开（> ${Math.round(presenceCfg.awayIdleMs / 60_000)} 分钟无输入）→ 出声提醒（含第二声）`
							: "普通状态 → 出声提醒（第二声仅在「已离开」时补）";
				ctx.ui.notify(
					[
						`在场门控：${presenceCfg.enabled ? "开" : "关"}｜当前判定：${verdict}`,
						`系统级空闲：${osIdle == null ? "不可用（退用 pi 实例信号）" : fmt(osIdle)}｜跨实例最近输入：${fmt(piIdle)}`,
						`提示音全局去重窗口：${presenceCfg.dedupeMs}ms（多实例同时完成只响第一声）`,
						`阈值可在 ${BEACON_CONFIG_FILE} 改：activeIdleMs / awayIdleMs / dedupeMs / presenceGate`,
					].join("\n"),
					"info",
				);
				return;
			}
			if (arg === "auto") {
				beaconModel = undefined;
			} else if (arg) {
				const slash = arg.indexOf("/");
				const m = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
				if (!m) {
					ctx.ui.notify(`status-beacon：找不到模型 ${arg}（格式 provider/modelId）`, "error");
					return;
				}
				beaconModel = `${m.provider}/${m.id}`;
			} else {
				if (!ctx.hasUI) {
					ctx.ui.notify("用法：/beacon（面板选模型）｜ /beacon auto ｜ /beacon <provider>/<modelId> ｜ /beacon status", "info");
					return;
				}
				const picked = await pickModelViaSelector(ctx);
				if (!picked) return; // Esc 取消
				beaconModel = `${picked.provider}/${picked.id}`;
			}
			try {
				fs.writeFileSync(BEACON_CONFIG_FILE, JSON.stringify({ model: beaconModel }, null, "\t"));
			} catch {
				/* 持久化失败不阻断 */
			}
			ctx.ui.notify(`status-beacon 概括模型：${beaconModel ?? "自动（最便宜已认证兜底）"}（已持久化）`, "info");
		},
	});

	/** 跨扩展登记桥：阻塞 UI 的扩展（ask/perm-gate）在弹窗时登记具体等待文本，
	 *  Working 行「等你：X」层级优先显示（仿 __PI_HUD_API__ 模式） */
	(globalThis as Record<string, unknown>).__PI_STATUS_BEACON_API__ = {
		wait: (text: string | null): void => {
			promptWaitText = text || undefined;
			if (currentCtx) applyWorking(currentCtx);
		},
	};
}
