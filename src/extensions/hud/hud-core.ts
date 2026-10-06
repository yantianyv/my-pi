/**
 * hud-core：3 行 HUD 状态栏核心（hud 多文件扩展）
 *
 * 三行三列（竖线分中列与右列）：
 * 行 1  左 git 状态 │ 中 动态区（扩展状态；空闲时是会话时长） │ 右 目录名
 * 行 2  左 模型·思考级别 │ 中 速率曲线 + 当前速率 │ 右 上下文进度条
 * 行 3  左 余额 / plan 余量 │ 中 消耗（token 进出 + 计价与花费） │ 右 余额刷新时刻
 *
 * 目录结构（hud 多文件扩展，pi 只加载 index.ts 作为入口；本文件为真正的核心实现，
 * index.ts 仅做 re-export）：
 *   index.ts        入口（pi 加载约定），re-export 本文件
 *   hud-core.ts     核心：渲染 + 生命周期 + 命令（本文件）
 *   hud-balance.ts  供应商余额适配层（hud-balance）
 *   hud-cost.ts     消耗统计与成本换算（hud-cost）
 *   hud-git.ts      git 状态解析（hud-git）
 *
 * 子模块**可选加载**：任一子模块文件缺失时，对应功能降级显示（不拖垮整个 HUD）：
 *   - hud-balance 缺失 → 行 3 显示「余额模块缺失」、/balance 命令提示不可用
 *   - hud-cost 缺失     → 行 2 隐藏 token 速率/上下文条、行 3 隐藏消耗统计
 *   - hud-git 缺失      → 行 1 恒显示「⎇ -」
 *
 * 行 3 计费适配说明：
 *   不同供应商计费方式差异很大（按量充值余额 vs 订阅 plan 余量 vs 订阅+加油包余额），
 *   无法用通用模板，因此按供应商逐一适配（见 hud-balance.ts）。
 *   适配器统一返回 BalanceData，未适配的供应商显示占位提示。
 *   目前已适配：deepseek / kimi-coding / moonshotai / moonshotai-cn / xiaomi / xiaomi-token-plan-cn / openrouter / volcengine-coding / sensenova / opencode-go / zai-coding-cn
 *
 * 命令：
 *   /balance  立即刷新余额并通知
 *   /hud      切换 3 行 HUD 开/关
 *
 * 动态区：经官方 ctx.ui.setStatus(key, text) 通道读状态（pi 原生接口），
 * 各插件推状态**不依赖 hud**（hud 缺席时原生 footer 自动展示）；hud 加载时仍置
 * globalThis.__PI_HUD_ACTIVE__：hud 存在且开启时置 true（/hud 关闭或 footer 卸载时置 false），
 * 供依赖 hud 特有功能的扩展校验——当前 workflow-mgr 据此决定「hud 接管底部行 vs 自绘常驻面板」；
 * globalThis.__PI_HUD_API__：通用「额外底部行」接口，扩展注册渲染函数（内容与样式自决），
 * hud 只 append 到 footer 底部；注册方经 notifyExtraRowsUpdate 请求重绘（零耦合，无 import）。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, mixColors, parseColor, rgbColor, truncateToWidth, visibleWidth, type Color } from "@earendil-works/pi-tui";
import path from "node:path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { clearStatusTimers, setStatusWithTTL } from "../shared/status";
import { FADE_STEP, RATE_REF_DECAY, outputFade, rateBand, sparkBarsCells, sparklineCells } from "./hud-spark";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// HUD 状态与渲染
// ---------------------------------------------------------------------------

type BalanceState = {
	loading: boolean;
	providerId?: string;
	data?: import("./hud-balance").BalanceData;
	error?: string;
	unsupported?: boolean;
	moduleMissing?: boolean; // hud-balance 子模块缺失
	fetchedAt?: number;
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 定时刷新
const TURN_REFRESH_THROTTLE_MS = 60 * 1000; // turn 结束后的刷新节流
const RATE_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 实时汇率刷新间隔（免费汇率每日快照，1h 足够）
let lastRateRefresh = 0;
const GIT_REFRESH_INTERVAL_MS = 5_000; // git 状态刷新间隔
const LEFT_LABEL_W = 15; // 左侧标签栏固定宽度（⎇ master / [DeepSeek] / 余额 ¥x.xx）
/** 速率柱配色（按速度分档，下标同 rateBand）：红 <20 / 琥珀 20–50 / 绿 50–100 / 青 ≥100 */
const RATE_BAND_COLORS = ["#ff5470", "#ffe066", "#00ff41", "#00ffd5"];
const THINKING_LABEL: Record<string, string> = {
	off: "off",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** 查询链接缺省显示文本（adapter 未指定 BalanceLink.text 时） */
const DEFAULT_LINK_TEXT = `${process.platform === "darwin" ? "按住⌘" : "按住Ctrl"}点击此处跳转官方查询页面`;
/** 终端是否支持 OSC 8 超链接 */
const HYPERLINK_SUPPORTED = getCapabilities().hyperlinks;

/**
 * 通用「额外底部行」接口：workflow-mgr 等扩展经全局 __PI_HUD_API__.registerExtraRows 注册
 * 渲染函数（内容与样式由注册方决定），hud 只把返回的行追加到 footer 底部（屏幕最底）。
 */
type HudExtraRowsProvider = (theme: Theme, width: number) => string[] | null;
const extraRowProviders = new Set<HudExtraRowsProvider>();

/** node @types 的 process 事件签名只认 Signals，自定义事件名需类型断言（运行时无影响） */
const proc = process as unknown as {
	on: (e: string, fn: () => void) => unknown;
	off: (e: string, fn: () => void) => unknown;
	emit: (e: string) => boolean;
};

export default async function (pi: ExtensionAPI) {
	// 存在性标志 + 通用底部行接口：workflow-mgr 等扩展注册渲染函数（内容与样式自决），
	// hud 只负责 append 到 footer 底部；notifyExtraRowsUpdate 通知重绘（footer 已装时）
	(globalThis as Record<string, unknown>).__PI_HUD_ACTIVE__ = true;
	(globalThis as Record<string, unknown>).__PI_HUD_API__ = {
		registerExtraRows: (provider: HudExtraRowsProvider) => {
			extraRowProviders.add(provider);
			return () => {
				extraRowProviders.delete(provider);
			};
		},
		notifyExtraRowsUpdate: () => tuiRef?.requestRender(),
	};

	// ---- 子模块可选加载：任一缺失时对应功能降级，不拖垮整个 HUD ----
	let balanceMod: typeof import("./hud-balance") | null = null;
	let costMod: typeof import("./hud-cost") | null = null;
	let gitMod: typeof import("./hud-git") | null = null;
	try {
		balanceMod = await import("./hud-balance");
	} catch {
		console.warn("[hud] 子模块 hud-balance.ts 缺失：余额行将降级显示");
	}
	try {
		costMod = await import("./hud-cost");
	} catch {
		console.warn("[hud] 子模块 hud-cost.ts 缺失：消耗统计将隐藏");
	}
	try {
		gitMod = await import("./hud-git");
	} catch {
		console.warn("[hud] 子模块 hud-git.ts 缺失：git 状态将隐藏");
	}

	/** "CUR value" → 货币符号 + 数值（CNY→¥、USD→$）；非该格式原样返回。 */
	function formatAmount(amount: string): string {
		const m = amount.match(/^([A-Z]{3})\s+(.+)$/);
		if (!m) return amount;
		const sym = costMod?.currencySymbol(m[1]);
		return sym ? `${sym}${m[2]}` : amount;
	}

	let footerInstalled = false;
	// setFooter 工厂参数（首次渲染时注入），用于异步刷新后请求重绘
	let tuiRef: { requestRender(): void } | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let gitTimer: ReturnType<typeof setInterval> | undefined;
	let gitStats: import("./hud-git").GitStats | null = null;
	let gitInflight = false;
	// 动态区样式表（官方 setStatus 通道的呈现层约定）：
	// 扩展经 ctx.ui.setStatus(key, text) 推送状态，hud 渲染行 1 动态区时按 key 查样式
	// （颜色 + 优先级，数字大者胜出）；TTL/闪烁由各推送方自管（setStatus 触发全局重绘，零延迟可见）。
	// 未登记 key 默认灰字、priority 0（基本不显示）。
	const STATUS_STYLE: Record<string, { color: string; priority: number }> = {
		// 一根轴：谁更该被一眼看到，谁的数字大。分五层——输入态 > 结果提醒 > 阻塞等人 >
		// 进行中·具体活动 > 进行中·通用兜底 > 环境信息；未登记的 key 缺省灰字 priority 0。
		// 输入态
		"hud-bash": { color: "warning", priority: 100 }, // 指令模式提示（输入以 ! 开头）
		// 结果提醒（status-beacon 自管闪烁帧）
		"task-alert-error": { color: "error", priority: 92 }, // 任务出错
		"task-alert-wait": { color: "warning", priority: 91 }, // 等待人工干预
		"task-alert": { color: "success", priority: 90 }, // 任务完成
		// 阻塞等人（要你立刻响应）
		"perm-gate": { color: "warning", priority: 86 }, // 命令审核中（perm-gate）
		"ask": { color: "accent", priority: 84 }, // 待答问卷数（ask；常年挂着，不能被活动盖掉）
		// 进行中·具体活动（各自说清楚在干什么，短时）
		"mimo-omni": { color: "accent", priority: 70 }, // 媒体解析/语音合成状态（mimo-omni）
		"init": { color: "warning", priority: 80 }, // /init 进度（claude-it）
		"balance-error": { color: "error", priority: 78 }, // 余额查询失败（后台周期探测、自行恢复，不压任务提醒）
		"img-slim": { color: "warning", priority: 76 }, // 图片预算：本轮已省略 N 张旧图（img-slim）
		"web-search": { color: "accent", priority: 75 }, // 联网搜索状态（web-tool）
		"web-fetch": { color: "accent", priority: 74 }, // 网页抓取状态（web-tool）
		"kb-sync": { color: "accent", priority: 73 }, // 知识库同步进度（webdav-kb；后台自动同步，低于前台 web 活动）
		"workflow-mgr": { color: "accent", priority: 72 }, // 人机协作任务摘要 / 完成信号审计（workflow-mgr）
		"model-switch": { color: "accent", priority: 70 }, // 模型切换
		"explore": { color: "accent", priority: 68 }, // 探索子代理进度（explore-agent；高于通用运行态）
		"qr": { color: "accent", priority: 64 }, // 二维码生成/解码状态（qr）
		"kb-vault": { color: "muted", priority: 62 }, // vault 解锁/锁定状态（webdav-kb）
		"clipboard": { color: "accent", priority: 61 }, // 剪贴板读写状态（clipboard）
		"kb-op": { color: "accent", priority: 61 }, // kb 工具回执（webdav-kb；一个键承载读/写/删/移等动作）
		"btw-transfer": { color: "muted", priority: 60 }, // btw 问答已附带提示（btw）
		// 进行中·通用兜底（说不出具体在干什么时的活动态）
		"task-alert-run": { color: "accent", priority: 58 }, // 思考中 / 输出中 / 当前工具（status-beacon）
		// 环境信息（常态存在，不需要抢格子）
		"pair-guard": { color: "muted", priority: 56 }, // 并发会话数（pair-guard）
	};
	/** 检测 ctx 是否仍有效：session 替换 / reload 后旧 ctx 的所有 getter 都会抛 stale 错误。 */
	function ctxAlive(ctx: ExtensionContext): boolean {
		try {
			void ctx.cwd;
			return true;
		} catch {
			return false;
		}
	}
	let lastBalanceError = ""; // 上次余额查询错误（变化时才推送动态区警告，防刷屏）
	let balance: BalanceState = { loading: false };
	let inflight = false;
	let lastAutoRefresh = 0;
	const fmtTime = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
	const fmtDuration = (ms: number): string => {
		const m = Math.floor(ms / 60_000);
		if (m < 1) return "<1min";
		if (m < 60) return `${m}min`;
		const h = Math.floor(m / 60);
		const rm = m % 60;
		if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
		return `${Math.floor(h / 24)}d`;
	};

	/** 拉取当前供应商的余额（含节流与并发保护）。 */
	async function refreshBalance(ctx: ExtensionContext) {
		// session 替换 / reload 后定时器与异步续跑仍持旧 ctx，直接放弃（新 session_start 会重新安装）
		if (!ctxAlive(ctx)) return;
		const provider = ctx.model?.provider;
		if (inflight) return;
		if (!balanceMod) {
			// hud-balance 子模块缺失：降级外观（行 3 提示模块缺失），不做网络请求
			balance = { loading: false, moduleMissing: true };
			lastAutoRefresh = Date.now();
			tuiRef?.requestRender();
			return;
		}
		// 确保余额换算用上实时汇率（免费汇率每日快照，1h 拉取一次足够）
		if (costMod && Date.now() - lastRateRefresh > RATE_REFRESH_INTERVAL_MS) {
			lastRateRefresh = Date.now();
			await costMod.refreshExchangeRate();
		}
		if (!provider) {
			balance = { loading: false, unsupported: true, providerId: undefined };
			lastAutoRefresh = Date.now();
			tuiRef?.requestRender();
			return;
		}

		const adapter = balanceMod.BALANCE_ADAPTERS[provider];
		if (!adapter) {
			balance = { loading: false, providerId: provider, unsupported: true };
			lastAutoRefresh = Date.now();
			tuiRef?.requestRender();
			return;
		}

		inflight = true;
		balance = { loading: true, providerId: provider };
		tuiRef?.requestRender();
		try {
			const data = await adapter.fetch(ctx);
			balance = { loading: false, providerId: provider, data, fetchedAt: Date.now() };
			lastBalanceError = ""; // 查询成功，重置错误记忆
		} catch (err) {
			balance = {
				loading: false,
				providerId: provider,
				error: err instanceof Error ? err.message : String(err),
				fetchedAt: Date.now(),
			};
			// 动态区警告：错误内容变化时才推送，避免持续失败刷屏（TTL 15s 自动消失）
			const msg = err instanceof Error ? err.message : String(err);
			if (lastBalanceError !== msg) {
				lastBalanceError = msg;
				setStatusWithTTL(ctx, "balance-error", "⚠ 余额查询失败", 15_000);
			}
		} finally {
			inflight = false;
			lastAutoRefresh = Date.now();
			tuiRef?.requestRender();
		}
	}

	/** 采集当前 git 状态（分支 + 暂存/工作区/未跟踪文件数）。 */
	let lastGitProbe = 0; // 上次真开子进程探测的时间（非 git 目录降频 + turn_end 节流共用）
	async function refreshGitStats(ctx: ExtensionContext) {
		if (!ctxAlive(ctx)) return; // 同 refreshBalance：旧 ctx 异步续跑直接放弃
		if (!gitMod) return; // hud-git 子模块缺失：恒显示「⎇ -」
		if (gitInflight) return;
		// 非 git 目录降频探测：5s 定时器照跑但不开子进程，60s 才真探一次（兼顾 git init 后恢复显示）
		if (gitStats === null && Date.now() - lastGitProbe < 60_000) return;
		lastGitProbe = Date.now();
		gitInflight = true;
		try {
			const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], {
				cwd: ctx.cwd,
				timeout: 5000,
				windowsHide: true,
			});
			gitStats = gitMod.parseGitStatus(stdout);
		} catch {
			gitStats = null; // 非 git 仓库或 git 不可用
		} finally {
			gitInflight = false;
			tuiRef?.requestRender();
		}
	}

	// （setDynamic/clearDynamic 已随动态区迁移移除：短时消息统一走 ctx.ui.setStatus + setStatusWithTTL）

	/** 余额行的纯文本描述（用于 /balance 的 notify）。 */
	function describeBalance(): string {
		const b = balance;
		if (b.loading) return "余额：查询中…";
		if (b.moduleMissing) return "余额：余额模块未加载";
		if (b.unsupported) return `余额：${b.providerId ?? "?"} 暂无余额接口（可在供应商控制台查看）`;
		if (b.error) return `余额：获取失败（${b.error}）`;
		if (b.data) {
			const amount = formatAmount(b.data.amount);
			const prefix = b.data.hideLabel ? "" : "余额：";
			// 查询链接型（无余额 API）：notify 纯文本里给出完整 URL 供复制（HUD 行只显示超链接短文本）
			const tail = b.data.link ? `（${b.data.link.url}）` : b.data.detail ? `（${b.data.detail}）` : "";
			return `${prefix}${amount}${tail}`;
		}
		return "余额：-";
	}

	// 速率采样环：**每轮记一次**（turn_end，此时本轮原始速率与 EMA 都已更新），一格 = 一轮。
	// 曲线画本轮原始速率（起伏真实），颜色按速度分档（红/琥珀/绿/青），亮度按本轮输出 token 数
	// （越亮 = 输出越长）。rateRef 是曲线的满格参考值 = 会话峰值随时间缓慢衰减（不因峰值滚出
	// 窗口而突然重缩放）；turnOutputs 与 rateHistory 逐轮并行（该轮输出 token 数，亮度依据），
	// outputRef 同理取粘性峰值——按峰值归一才能把亮度档真正拉开。
	const RATE_TURNS = 40; // 采样窗口（远大于图表格数，保证曲线宽度变化时都有数据）
	const rateHistory: number[] = [];
	const turnOutputs: number[] = [];
	let rateRef = 0;
	let outputRef = 0;
	const sampleRate = (ctx: ExtensionContext): void => {
		if (!costMod) return;
		try {
			const v = Math.max(0, costMod.getTurnRate() ?? costMod.getTokenRate(Date.now()) ?? 0);
			const out = Math.max(0, costMod.getTurnOutput() ?? 0);
			rateHistory.push(v);
			turnOutputs.push(out);
			if (rateHistory.length > RATE_TURNS) {
				rateHistory.splice(0, rateHistory.length - RATE_TURNS);
				turnOutputs.splice(0, turnOutputs.length - RATE_TURNS);
			}
			rateRef = Math.max(v, rateRef * RATE_REF_DECAY);
			outputRef = Math.max(out, outputRef * RATE_REF_DECAY);
		} catch {
			/* 采样失败不影响 HUD */
		}
	};

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			// 存在且开启标记 + 通知依赖 hud 的扩展（workflow-mgr 等）立即接管/切换展示
			(globalThis as Record<string, unknown>).__PI_HUD_ACTIVE__ = true;
			// 通知依赖 hud 的扩展接管底部行。reload 收尾期间监听器（如 workflow-mgr）可能因 ctx
			// stale 抛错，try/catch 保证 emit 失败不反噬 hud 自身的 footer 安装/卸载流程。
			try {
				proc.emit("hud:state-change");
			} catch {
				// 消费者异常不影响 hud
			}
			tuiRef = tui;
			footerInstalled = true;
			const unsubBranch = footerData.onBranchChange(() => {
				void refreshGitStats(ctx);
				tui.requestRender();
			});

			// 指令模式提示（近似 Claude Code）：输入以 ! 开头时在 HUD 高亮提醒。
			// 通过原始终端输入流近似跟踪输入内容（对英文命令准确，IME 组合输入期间可能滞后）。
			let inputBuffer = "";
			let bashModeHint = false;
			const unsubInput = ctx.ui.onTerminalInput((data) => {
				if (!ctxAlive(ctx)) return; // ctx 失效后的残留输入事件直接忽略
				if (data === "\r" || data === "\n") {
					inputBuffer = ""; // 回车提交
				} else if (data === "\x7f" || data === "\b") {
					inputBuffer = inputBuffer.slice(0, -1);
				} else if (data.length === 1) {
					inputBuffer += data;
				}
				const isBash = inputBuffer.trimStart().startsWith("!");
				if (isBash !== bashModeHint) {
					bashModeHint = isBash;
					if (isBash) ctx.ui.setStatus("hud-bash", "⚡ 指令模式");
					else ctx.ui.setStatus("hud-bash", undefined);
				}
			});


	// 首次安装立即拉取，之后定时刷新（余额 5min / git 5s）
			void refreshBalance(ctx);
			if (refreshTimer) clearInterval(refreshTimer);
			refreshTimer = setInterval(() => void refreshBalance(ctx), REFRESH_INTERVAL_MS);
			void refreshGitStats(ctx);
			if (gitTimer) clearInterval(gitTimer);
			gitTimer = setInterval(() => void refreshGitStats(ctx), GIT_REFRESH_INTERVAL_MS);

			const padTo = (str: string, w: number): string => str + " ".repeat(Math.max(0, w - visibleWidth(str)));
			// 居中：右列里的刷新时刻按列宽居中（两端留白尽量均等，余数给右侧）
			const padCenter = (str: string, w: number): string => {
				const len = visibleWidth(str);
				if (len >= w) return str;
				const left = Math.floor((w - len) / 2);
				return " ".repeat(left) + str + " ".repeat(w - len - left);
			};
			// 右对齐：内容紧贴分隔线
			const padLeft = (str: string, w: number): string => " ".repeat(Math.max(0, w - visibleWidth(str))) + str;

			// 上下文进度条：1/8 精度块字符，颜色随占用率渐变，空位用空格保持固定宽度
			const BAR_BLOCKS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"];
			const pctColor = (pct: number): "success" | "accent" | "warning" | "error" =>
				pct > 90 ? "error" : pct > 75 ? "warning" : pct > 50 ? "accent" : "success";
			const progressBar = (pct: number, width = 10): string => {
				const total = width * 8; // 每格 8 细分
				const filled = Math.max(0, Math.min(total, Math.round((pct / 100) * total)));
				const full = Math.floor(filled / 8);
				const part = filled % 8;
				const empty = Math.max(0, width - full - (part ? 1 : 0)); // 剩余整块用空格占位
				const color = pctColor(pct);
				let s = theme.fg(color, "█".repeat(full));
				if (part) s += theme.fg(color, BAR_BLOCKS[part - 1]);
				s += " ".repeat(empty);
				return s;
			};

			const renderBalanceLine = (): string => {
				const b = balance;
				const label = theme.fg("dim", "余额");
				if (b.loading) return `${label} 查询中…`;
				if (b.moduleMissing) return `${label} ${theme.fg("warning", "模块未加载")}`;
				if (b.unsupported) return `${label} ${b.providerId ?? "?"} 暂无接口`;
				if (b.error) return `${label} 获取失败（${b.error}）`;
				if (b.data) {
					const color = b.data.status === "ok" ? "success" : b.data.status === "warning" ? "warning" : "error";
					// 多维度额度条（如 Kimi 的周额度 + 5 小时频限）用抽象 gauge 展示
					if (b.data.quotas && b.data.quotas.length > 0) {
						const amountText = formatAmount(b.data.amount);
						// 默认仅加油包余额等 CNY 金额在额度条旁额外显示；其他币种（如 OpenRouter USD）经
						// showAmountWithQuotas 显式开启后同栏显示总余额
						const showMoney = b.data.showAmountWithQuotas || amountText.startsWith("¥");
						const amountPart = showMoney ? `${theme.fg(color, amountText)}` : "";
						const pct = (used: number, limit: number) => (limit > 0 ? Math.round((used / limit) * 100) : 0);
						const gauge = (used: number, limit: number, width = 5) => {
							if (limit <= 0) return theme.fg("dim", "▱".repeat(width));
							const p = pct(used, limit);
							const filled = Math.max(0, Math.min(width, Math.round((used / limit) * width)));
							const c = pctColor(p);
							return theme.fg(c, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(width - filled));
						};
						const qText = b.data.quotas
							.map((q) => {
								const p = pct(q.used, q.limit);
								const c = pctColor(p);
								// 带币种的额度条显示金额用量（如 OpenRouter `Key ¥0.72/7.20`）；缺省保持百分比
								const val = q.currency
									? `${costMod?.currencySymbol(q.currency) ?? `${q.currency} `}${q.used.toFixed(2)}/${q.limit.toFixed(2)}`
									: theme.fg(c, `${p}%`);
								const resetText = q.reset ? ` ${theme.fg("dim", `· ${q.reset}`)}` : "";
								return `${gauge(q.used, q.limit)} ${theme.fg("dim", q.label)} ${q.currency ? theme.fg(c, val) : val}${resetText}`;
							})
							.join(` ${theme.fg("dim", "·")} `);
						const parts = [label, amountPart, qText].filter(Boolean);
						return parts.join(" ");
					}
					// 币种友好显示：CNY → ¥、USD → $（货币缩写统一转符号）
					const amountText = formatAmount(b.data.amount);
					const amount = theme.fg(color, amountText);
					// 查询链接：OSC 8 超链接短文本（dim 灰色低调）。下划线来源：Windows Terminal 对 OSC 8
					// 链接强制默认下划线（平时虚线/hover 实线），应用侧 SGR（24 / 4:0 等）均无法改变——
					// 这是终端渲染层的硬限制。插件不叠加任何手动下划线，让终端用其默认（最低调）样式。
					const linkText = b.data.link?.text ?? DEFAULT_LINK_TEXT;
					const linkLabel = `🔗 ${linkText}`;
					const linkPart = b.data.link
						? HYPERLINK_SUPPORTED
							? hyperlink(theme.fg("dim", linkLabel), b.data.link.url)
							: theme.fg("dim", linkLabel)
						: "";
					const detail = !b.data.link && b.data.detail ? ` ${theme.fg("dim", b.data.detail)}` : "";
					const prefix = b.data.hideLabel ? "" : `${label} `;
					return `${prefix}${amount}${linkPart ? ` ${linkPart}` : ""}${detail}`;
				}
				return `${label} -`;
			};

			const renderGitLine = (): string => {
				// hud-git 子模块缺失：与「非 git 仓库」区分开，否则用户无法判断是坏了还是本来就不是仓库
				if (!gitMod) return theme.fg("warning", "⎇ git模块未加载");
				if (!gitStats) return theme.fg("dim", "⎇ -（非 git 仓库）");
				const g = gitStats;
				const badge = theme.fg("accent", `⎇ ${g.branch ?? "HEAD"}`);
				const parts: string[] = [];
				// 计数符号制（与 /git 面板一致）：↑领先 ↓落后 +暂存 ~修改 ?未跟踪；
				// 紧凑显示：零值不显示、计数间只留空格（⎇ master ↑1 ~2 ?1）
				if (g.ahead) parts.push(theme.fg("dim", `↑${g.ahead}`));
				if (g.behind) parts.push(theme.fg("dim", `↓${g.behind}`));
				if (g.staged) parts.push(theme.fg("success", `+${g.staged}`));
				if (g.unstaged) parts.push(theme.fg("warning", `~${g.unstaged}`));
				if (g.untracked) parts.push(theme.fg("muted", `?${g.untracked}`));
				return parts.length ? `${badge} ${parts.join(" ")}` : badge;
			};

			// 动态区（信息屏B）：读官方 setStatus 通道的状态，按样式表取优先级最高者；
			// 空闲时退回会话时长占位。只出内容不裁剪——状态占行 1 中段，宽度由行布局按
			// 终端宽度给（超长由调用方裁 `…`）。TTL 由各推送方自管，无需本处清理。
			const renderStatuses = (): string => {
				let best: { text: string; color?: string; priority: number } | null = null;
				for (const [key, text] of footerData.getExtensionStatuses()) {
					if (!text) continue;
					const style = STATUS_STYLE[key];
					const priority = style?.priority ?? 0;
					if (!best || priority > best.priority) best = { text, color: style?.color, priority };
				}
				if (!best) return theme.fg("muted", `会话 ${fmtDuration(Date.now() - (costMod?.getStartupTime() ?? Date.now()))}`);
				return best.color ? theme.fg(best.color as never, best.text) : best.text;
			};

			return {
				dispose() {
					(globalThis as Record<string, unknown>).__PI_HUD_ACTIVE__ = false;
					// 通知依赖 hud 的扩展（workflow-mgr）恢复自绘面板。reload 收尾期间消费者可能因 ctx
					// stale 抛错，try/catch 避免中断 pi 的 reload/卸载流程。
					try {
						proc.emit("hud:state-change");
					} catch {
						// 消费者异常不影响 hud dispose
					}
					unsubBranch();
					unsubInput();
					footerInstalled = false;
					if (refreshTimer) {
						clearInterval(refreshTimer);
						refreshTimer = undefined;
					}
					if (gitTimer) {
						clearInterval(gitTimer);
						gitTimer = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					// ctx 失效（session 替换 / reload）后新 footer 安装前的过渡帧：空渲染避免拖垮 TUI
					if (!ctxAlive(ctx)) return [];
					const model = ctx.model;

					// ---- 行 1：左列 git 状态 · 中列 动态区（状态）· 右列 目录名 ----
					const left1 = renderGitLine();
					// 用 path.basename 取目录名（Windows 上同时认 `\` 和 `/`，且能吃掉结尾分隔符；
					// 手写 split 正则曾因转义丢字符类，把完整路径显示到了这一格）
					const project = path.basename(ctx.cwd);

					// ---- 行 2：模型 + 用量 + 上下文 ----
					const providerDisplay = model
						? ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider
						: "no-model";
					const thinkingTag = ctx.thinkingLevel
						? theme.fg("dim", `(${THINKING_LABEL[ctx.thinkingLevel] ?? ctx.thinkingLevel})`)
						: "";
					const left2 =
						theme.fg("accent", `[${providerDisplay}]`) +
						" " +
						theme.fg("text", model?.id ?? "未选择模型") +
						(thinkingTag ? ` ${thinkingTag}` : "");

					// hud-cost 缺失时隐藏右侧用量/上下文段
					let input = 0,
						output = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
						}
					}
					// 速率双口径：🔥 本轮（未平滑，看清"这一轮多快"）+ 📊 均值（EMA，看清"平时多快"），
					// 一律取整（小值区间两位小数太长；曲线已有形状精度）
					const fmtRate = (r: number): string =>
						r >= 1000 ? `${costMod?.fmtNum(r) ?? ""}/s` : `${Math.round(r)}/s`;
					const emaRate = costMod ? (costMod.getTokenRate(Date.now()) ?? 0) : 0;
					const turnRateNow = costMod ? (costMod.getTurnRate() ?? emaRate) : 0;
					const rateStr = fmtRate(emaRate);
					const tokensSeg = costMod
						? `${theme.fg("muted", `↑${costMod.fmtNum(input)}`)} ${theme.fg("muted", `↓${costMod.fmtNum(output)}`)}`
						: "";

					const usage = ctx.getContextUsage();
					// ctx 段固定总宽：`[bar] tail` 恒为 16 格，分割线不偏移。
					// 上下文段：宽度 segW 由调用方给（= 右列宽度，跟着目录名/刷新时刻自动缩放，视觉更整齐）。
					// 百分比自适应位置：空白够时嵌在进度条空白最左侧（`[██ 20%    ] 1m`），不够时替换尾部大小。
					const buildCtxCell = (segW: number): string => {
						if (!costMod) return theme.fg("warning", "用量 模块缺失");
						const pctRaw = usage?.percent;
						const pct = pctRaw != null ? Math.round(pctRaw) : 0;
						const pctText = `${pct}%`;
						const pctWidth = visibleWidth(pctText);
						const windowText = usage?.contextWindow != null ? costMod.fmtNum(usage.contextWindow) : null;

						// 无上下文窗口大小时退化为原逻辑：尾部显示百分比或 0
						if (windowText == null) {
							const numText = pctRaw != null ? pctText : "0";
							const barWidth = Math.max(3, segW - 3 - visibleWidth(numText));
							return `[${progressBar(pct, barWidth)}] ${numText}`;
						}
						// 未返回百分比：空条 + 上下文大小（原样）
						if (pctRaw == null) {
							const barWidth = Math.max(3, segW - 3 - visibleWidth(windowText));
							return `[${progressBar(0, barWidth)}] ${windowText}`;
						}

						const barWidth = Math.max(3, segW - 3 - visibleWidth(windowText));
						// 已占用格数（满格 + 半格），与 progressBar 内部计算一致
						const total = barWidth * 8;
						const filledCells = Math.round((pct / 100) * total);
						const used = Math.floor(filledCells / 8) + (filledCells % 8 ? 1 : 0);
						const empty = Math.max(0, barWidth - used);

						if (empty >= pctWidth + 1) {
							// 方案 A：百分比嵌入进度条空白最左侧，尾部保留上下文大小
							const bar = progressBar(pct, barWidth);
							const core = bar.slice(0, bar.length - empty); // 去掉尾部空白（实体部分）
							const rest = " ".repeat(empty - (pctWidth + 1));
							return `[${core}${theme.fg("dim", ` ${pctText}`)}${rest}] ${windowText}`;
						}
						// 方案 B：进度条占满可用宽度，百分比替换尾部上下文大小
						const barWidthB = Math.max(3, segW - 3 - pctWidth);
						return `[${progressBar(pct, barWidthB)}] ${pctText}`;
					};
					const peakTag = (() => {
						if (model?.provider === "deepseek" && costMod) {
							const isPeak = costMod.isDeepSeekPeakHour(Date.now());
							return `${theme.fg("dim", " ・ ")}${theme.fg(isPeak ? "warning" : "success", isPeak ? "高峰" : "低峰")}`;
						}
						if (model?.provider === "xiaomi-token-plan-cn" && costMod) {
							const isOffpeak = costMod.isMimoOffpeakHour(Date.now());
							return `${theme.fg("dim", " ・ ")}${theme.fg(isOffpeak ? "success" : "warning", isOffpeak ? "夜间优惠" : "高峰")}`;
						}
						// OpenCode Go：仅 DeepSeek 系列模型有峰谷价（高峰 = 周一~周五北京 09-12 / 14-18，周末全天平峰）；
						// 其余 Go 模型（GLM/Kimi/Qwen/MiniMax…）平价无峰谷，不显示徽章
						if (model?.provider === "opencode-go" && /deepseek/i.test(model.id ?? "") && costMod) {
							const isPeak = costMod.isGoPeakHour(Date.now());
							return `${theme.fg("dim", " ・ ")}${theme.fg(isPeak ? "warning" : "success", isPeak ? "高峰" : "低峰")}`;
						}
						return "";
					})();
					const left3 = renderBalanceLine() + peakTag;
					// 消耗统计按 provider 单独适配（adapter.rateText）；
					// 适配器缺失/未定义 rateText 时兑底用通用按量付费统计（USD 轨，有汇率显 ¥、无汇率显 $）
					const adapter =
						ctx.model?.provider && balanceMod ? balanceMod.BALANCE_ADAPTERS[ctx.model.provider] : undefined;
					const rateFn = adapter?.rateText ?? costMod?.meteredRateText;
					const rateText = rateFn
						? (rateFn(ctx, Date.now()) ?? [])
								.map((p) => theme.fg((p.color ?? "muted") as never, p.text))
								.join(" ")
						: "";
					const timeText = balance.fetchedAt ? theme.fg("dim", `↻ ${fmtTime(balance.fetchedAt)}`) : "";
					// 行 3 中列：消耗（本会话 token 进出 + 计价与花费）
					const costCell = costMod ? `${tokensSeg}${rateText ? ` ${rateText}` : ""}` : "";

					// ---- 三行三列：左列 git/模型/余额 · 中列 状态/速率柱+速率/消耗 · 右列 目录/上下文/刷新时刻 ----
					// 三行共用同一组栏宽（列起止对齐）：左列左对齐、中列右对齐贴住竖线、右列左对齐紧跟竖线。
					// 行 1 中列特殊：先放速率图借来的上半行（可能为空），再右对齐状态。
					const GAP = 2;
					const statusText = renderStatuses();
					// 左列宽度按内容取最大值，上限 45%（给长余额行留够——OpenCode Go 那种「月/周/5h」
					// 三段额度能到 40+ 格；上限太紧会把余额截成 `5h 1…`）。
					const colLeftW = Math.min(
						Math.max(visibleWidth(left1), visibleWidth(left2), visibleWidth(left3)),
						Math.max(24, Math.floor(width * 0.45)),
					);
					// 右列宽度按目录名 / 刷新时刻自动缩放（上限 40，避免长目录名吃掉中列）；
					// 上下文条**跟着这个宽度**生成——三者同宽时右列看起来是一条整齐的竖带。
					const colRightW = Math.min(
						Math.max(12, visibleWidth(project ? `📁 ${project}` : ""), visibleWidth(timeText)),
						Math.max(10, Math.floor(width * 0.34)),
						40,
					);
					const midW = Math.max(6, width - colLeftW - GAP - 3 - colRightW);
					const ctxCell = buildCtxCell(colRightW);

					// 行 2 中列：速率柱状图（一格 = 一轮）+ 🔥本轮速率。
					// 宽度与下面那一行（消耗）等宽——两行的左边缘因此对齐（整块右对齐到竖线）。
					// **自适应两行**：行 1 的状态右对齐、柱子贴中列左端，状态不长时柱子正上方是空的，
					// 就把那块借来画上半行（16 档）；状态长到压过来时把位置还回去，退回单行（8 档）。
					// 速率柱配色：速度档决定色相（红/琥珀/绿/青），亮度 = 该轮输出 token 数
					// （越长越亮：开方映射 + 最多向背景混 62.5%）；每轮输出起伏大，亮度档才拉得开。
					// 淡化量量化到 1/8 档，相邻同色合并成一段，少出 ANSI 序列。
					const bgTarget = theme.appearance === "light" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0);
					const colorCache = new Map<string, Color>();
					const cellKey = (value: number, out?: number): string =>
						value > 0 ? `${rateBand(value)}:${Math.round(outputFade(out, outputRef) / FADE_STEP)}` : "dim";
					const colorOf = (key: string): Color => {
						const hit = colorCache.get(key);
						if (hit) return hit;
						let color: Color;
						if (key === "dim") color = theme.colors.dim;
						else {
							const [band, fade] = key.split(":");
							const base = parseColor(RATE_BAND_COLORS[Number(band)] ?? RATE_BAND_COLORS[0]!);
							const amount = Number(fade) * FADE_STEP;
							color = amount > 0 ? mixColors(base, bgTarget, amount, "oklch") : base;
						}
						colorCache.set(key, color);
						return color;
					};
					/** 逐格上色：同色相邻合并成一段，纯空格段不上色 */
					const paintCells = (chars: string[], keys: string[]): string => {
						let out = "";
						for (let i = 0; i < chars.length; ) {
							let j = i + 1;
							while (j < chars.length && keys[j] === keys[i]) j++;
							const seg = chars.slice(i, j).join("");
							out += seg.trim() ? theme.style(seg, { fg: colorOf(keys[i]!) }) : seg;
							i = j;
						}
						return out;
					};
					const rateChart = ((): { bottom: string; top: string | null } => {
						if (!costMod) return { bottom: "", top: null };
						// 双口径数字：🔥 本轮（未平滑，颜色跟速度档）+ 📊 均值（EMA）
						const nums = `${theme.style(`🔥${fmtRate(turnRateNow)}`, { fg: colorOf(cellKey(turnRateNow)) })} ${theme.fg("dim", `📊${fmtRate(emaRate)}`)}`;
						const costW = visibleWidth(costCell);
						const chartW = Math.max(8, Math.min(40, costW - visibleWidth(nums) - 1));
						const cols = sparkBarsCells(rateHistory, chartW, { ref: rateRef, weights: turnOutputs });
						const keys = cols.map((c) => cellKey(c.value, c.weight));
						const two = {
							bottom: paintCells(cols.map((c) => c.lower), keys),
							top: paintCells(cols.map((c) => c.upper), keys),
						};
						const bottom2 = `${two.bottom} ${nums}`;
						// 柱子上方是否放得下上半行：状态左端（中列内偏移）要在柱子右侧留出 1 格
						const chartCol = midW - visibleWidth(bottom2);
						if (chartCol >= 0 && midW - visibleWidth(statusText) >= chartCol + chartW + 1) {
							return { bottom: bottom2, top: " ".repeat(chartCol) + two.top };
						}
						// 还位置：单行 8 档（按同一参考值重新归一）
						const single = sparklineCells(rateHistory, chartW, { ref: rateRef, weights: turnOutputs });
						return {
							bottom: `${paintCells(single.map((c) => c.char), single.map((c) => cellKey(c.value, c.weight)))} ${nums}`,
							top: null,
						};
					})();
					// 有上半行就把它放在柱子正上方，状态仍右对齐；没有就退回纯状态右对齐
					const statusCell = rateChart.top
						? rateChart.top + " ".repeat(Math.max(0, midW - visibleWidth(rateChart.top) - visibleWidth(statusText))) + statusText
						: padLeft(statusText, midW);
					const projectCell = project ? padTo(theme.fg("dim", `📁 ${project}`), colRightW) : "";
					const base = [
						{ left: left1, middle: statusCell, right: projectCell },
						{ left: left2, middle: rateChart.bottom, right: ctxCell },
						{ left: left3, middle: costCell, right: padCenter(timeText, colRightW) },
					].map((c) => {
						const l = padTo(truncateToWidth(c.left, colLeftW, "…"), colLeftW);
						const m = padLeft(truncateToWidth(c.middle, midW, "…"), midW);
						const rt = padTo(truncateToWidth(c.right, colRightW, "…"), colRightW);
						return truncateToWidth(l + " ".repeat(GAP) + m + theme.fg("dim", " │ ") + rt, width);
					});
					// 额外底部行：遍历注册方（workflow-mgr 等），把各自渲染的行追加到最底
					const extra: string[] = [];
					for (const p of extraRowProviders) {
						const rows = p(theme, width);
						if (rows) extra.push(...rows);
					}
					return base.concat(extra);
				},
			};
		});
	}

	// ---- 生命周期 ----
	pi.on("session_start", async (_event, ctx) => {
		// 重置速率统计（避免 resume 旧会话时把历史成本当成首轮增量）
		if (costMod) costMod.resetCostTracking(ctx);
		lastRateRefresh = 0; // 新 session 允许立即拉汇率（节流计时跨 session 无意义）
		if (ctx.mode !== "tui") return;
		installFooter(ctx);
	});

	pi.on("turn_start", async () => {
		if (costMod) costMod.startTurn();
	});

	// assistant 消息流式结束 = 本轮模型生成段终点（速率分母只算这一段，不含工具执行）
	pi.on("message_end", async (event) => {
		if (costMod && event.message.role === "assistant") costMod.markModelPhaseEnd();
	});

	pi.on("turn_end", async (_event, ctx) => {
		// 记录本 turn 消耗（成本增量入 10 分钟窗口 + 输出 token 速率 EMA 平滑）
		if (costMod) {
			costMod.recordTurnCosts(ctx);
			sampleRate(ctx); // 本轮速率与输出 token 数入曲线（一格 = 一轮）
			// Z.AI Coding CN：积分轨只能远端采样（消息 usage 不含积分），
			// turn_end 拉一次 quota 接口做差分（fire-and-forget，内部 30s 节流）
			if (ctx.model?.provider === "zai-coding-cn") void costMod.recordZaiCreditUsage(ctx);
		}
		if (!footerInstalled) return;
		if (Date.now() - lastAutoRefresh > TURN_REFRESH_THROTTLE_MS) void refreshBalance(ctx);
		// git 状态：5s 定时器在跑，turn_end 只补「距上次探测超 2s」的即时刷新（防快速连续 turn 重复开子进程）
		if (Date.now() - lastGitProbe > 2_000) void refreshGitStats(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		balance = { loading: false }; // 供应商可能变化，丢弃旧缓存
		tuiRef?.requestRender();
		// 动态区提示模型切换（3 秒 TTL 自动消失）
		if (ctx.model?.id) setStatusWithTTL(ctx, "model-switch", `⇄ ${ctx.model.id}`, 3_000);
		if (footerInstalled) void refreshBalance(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearStatusTimers();
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		if (gitTimer) {
			clearInterval(gitTimer);
			gitTimer = undefined;
		}
		// 存在性标志复位：shutdown 后 hud 不再活跃（installFooter 会重新置 true），
		// 防止 workflow-mgr 等下游在非 dispose 路径的 session 替换后误判 hud 仍可用
		(globalThis as Record<string, unknown>).__PI_HUD_ACTIVE__ = false;
	});

	// ---- 命令 ----
	pi.registerCommand("balance", {
		description: "立即刷新账户余额 / plan 余量并通知",
		handler: async (_args, ctx) => {
			await refreshBalance(ctx);
			ctx.ui.notify(
				describeBalance(),
				balance.data?.status === "error" ? "error" : balance.data?.status === "warning" ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("git", {
		description: "打开可视化 Git 面板（stage / unstage / discard / commit / refresh）",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/git 仅在交互模式下可用", "warning");
				return;
			}
			if (!gitMod) {
				ctx.ui.notify("Git 模块未加载，无法打开面板", "error");
				return;
			}
			if (!(await gitMod.isGitRepo(ctx.cwd))) {
				ctx.ui.notify("当前目录不是 git 仓库", "warning");
				return;
			}
			await gitMod.openGitPanel(ctx, () => void refreshGitStats(ctx));
		},
	});

	pi.registerCommand("hud", {
		description: "切换 3 行 HUD 状态栏",
		handler: async (_args, ctx) => {
			if (footerInstalled) {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("3 行 HUD 已关闭", "info");
			} else {
				installFooter(ctx);
				ctx.ui.notify("3 行 HUD 已开启", "info");
			}
		},
	});
}
