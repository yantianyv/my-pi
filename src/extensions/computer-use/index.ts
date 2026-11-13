/**
 * computer-use：把真实桌面交给 AI 操作（Windows）
 *
 * 双通道感知：UIA 给结构化控件（精确、带类型与名字、可 Invoke 不动物理鼠标），
 * OmniParser 视觉检测补 UIA 看不见的地方（Canvas、游戏、远程桌面、未开无障碍的应用）。
 * 动作执行优先走 UIA，走不通才发真实鼠标键盘。
 *
 * ## 为什么有「激活」这一层
 *
 * 七个工具常驻注册（动态注册会让 prompt cache 失效，代价比省下的 token 大得多），
 * 但**在激活之前一律拒绝执行**。激活时一次性确认授权，并在返回文本里给出完整用法、
 * 屏幕信息、当前焦点窗口与边界条件——这样工具描述本身可以压到最短，
 * 把长文本挪到"真的要用的时候才付"的位置。
 *
 * ## 每个动作都报告作用窗口
 *
 * 实测踩过的坑：授权弹窗把焦点抢回 pi 自己，用户在弹窗上点完后焦点留在 pi，
 * 紧接着的输入全打在 pi 的输入框里，而工具只回"ok"。现在每个动作都会取一次焦点窗口
 * （约 9ms），把"实际作用在谁身上"写进结果；与感知时的窗口不一致就明确警示。
 *
 * ## 动作后全屏差分
 *
 * 不按元素框比较——实测往记事本输入一行字，元素框接近整窗，降采样后差异被稀释到
 * 0.0%，工具报"画面没变"而实际文字已经进去。改为前后两张全屏图分块比对，
 * 直接报"哪里变了 / 多大范围"，不再给假阴性。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";
import { setWaiting } from "../shared/status";
import { isCodemodeCall } from "../shared/codemode";
import { annotatePng } from "./model/annotate";
import { IconDetector, ModelUnavailableError } from "./model/detector";
import { prepareInput } from "./model/preprocess";
import { mergeElements, formatElements, findByIndex, type Element } from "./elements";
import { typeText } from "./typing";
import { diffGrids, type DiffOutcome, type DiffScope } from "./verify";
import { describeWindow, isDesktopUnavailable, sameWindow, toWindowRef, type WindowRef } from "./focus";
import { hostScriptPath, Win32Platform } from "./platform/win32";
import { PlatformUnavailableError, type Platform, type ScreenGrid } from "./platform/types";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "computer-use.json");
/** 检测模型文件名（与本扩展产物同目录的 model/ 下） */
const MODEL_FILE = "omniparser-icon-detect.onnx";
/** 截图与标注图的落盘目录 */
const SHOT_DIR = path.join(os.tmpdir(), "pi-computer-use");
/** 保留的历史截图数量 */
const KEEP_SHOTS = 12;
/**
 * 视觉检测置信度阈值。
 *
 * 这个任务要的是"发现界面上有哪些可操作的东西"，不是"精准识别图标"。
 * OmniParser 论文建议 0.25，那是图标识别场景（少而准）；用在界面元素发现上
 * 会漏掉三分之二：实测同一张桌面 0.25 出 33 个框、0.08 出 103 个。
 *
 * 宁可多给几个框——模型看标注图能分辨哪个是真控件，漏掉的它却无法补回来。
 * 唯一的代价是元素表更长，所以用 maxNodes / 分层排序控制可读性。
 */
const DEFAULT_CONF = 0.08;
/** 单次快照的 UIA 元素上限 */
const MAX_UIA_NODES = 300;

interface CuConfig {
	/** 是否启用视觉检测（关闭则只走 UIA） */
	vision?: boolean;
	/** 检测置信度阈值 */
	conf?: number;
}

const isCuConfig = (v: unknown): v is CuConfig => {
	const c = v as { vision?: unknown; conf?: unknown } | null;
	if (!c || typeof c !== "object") return false;
	return (c.vision === undefined || typeof c.vision === "boolean") && (c.conf === undefined || typeof c.conf === "number");
};

// ---------------------------------------------------------------------------
// 运行时状态（进程内，随 /reload 与会话结束重置）
// ---------------------------------------------------------------------------

let platform: Platform | null = null;
let detector: IconDetector | null = null;
/** 是否已激活：false 时所有 cu_* 工具拒绝执行 */
let activated = false;
/**
 * 激活状态落盘路径。
 *
 * 只在内存里记是不够的：/reload 会触发 session_shutdown 把 activated 清掉，
 * 而用户视角"我刚授权过"——实测 AI 在任务中途遇到 reload，随后所有 cu_*
 * 都被拒绝，它只好反复重新激活，整个流程就散了。
 * 按 sessionId 存一份，reload 后同一会话接着用（用户授权的是这个会话）。
 */
let consentFile: string | null = null;

function saveConsent(): void {
	if (!consentFile) return;
	try {
		fs.mkdirSync(path.dirname(consentFile), { recursive: true });
		fs.writeFileSync(consentFile, JSON.stringify({ activatedAt: Date.now() }), "utf8");
	} catch {
		/* 落盘失败不影响本次会话内使用 */
	}
}

function loadConsent(): boolean {
	if (!consentFile) return false;
	try {
		const d = JSON.parse(fs.readFileSync(consentFile, "utf8")) as { activatedAt?: number };
		return typeof d.activatedAt === "number";
	} catch {
		return false;
	}
}
/** 最近一次感知时看到的焦点窗口（动作时用来对比） */
let perceivedWindow: WindowRef | null = null;
/**
 * pi 自己的窗口句柄。
 *
 * 激活时前台就是 pi（用户刚点了确认框），借此记下"pi 长什么样"。
 * 之后感知/动作若发现前台是它，就说明焦点被 pi 抢走了，需要切回目标窗口——
 * 而不是把 pi 自己的窗口当成"用户正对着的窗口"去读。
 */
let piWindowHwnd: string | null = null;
/** 最近一次快照的元素 */
let lastElements: Element[] = [];
/** 动作前的块网格（动作差分的基准） */
let lastGrid: ScreenGrid | null = null;

/**
 * 扩展资源目录：产物是 extensions/computer-use.ts，附属资源在同名的
 * extensions/computer-use/ 目录里（install.js 的 installExtAssets 放的）。
 *
 * 自己按分隔符剥，不经过 path.dirname：产物由 jiti 加载（CJS 包装），
 * 路径分隔符字面量在不同加载路径下会被二次转义，剥出来的位置会静默错一层
 * （实测表现为宿主脚本路径变成 .../extensions/platform/...，启动即失败）。
 */
function extensionDir(): string {
	const SEP = String.fromCharCode(92);
	const file = realpathOf(import.meta.url);
	const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf(SEP));
	const dir = cut > 0 ? file.slice(0, cut) : file;
	const base = cut > 0 ? file.slice(cut + 1) : file;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? dir + SEP + base.slice(0, dot) : dir;
}

/**
 * import.meta.url → 本机文件路径。
 *
 * 优先 fileURLToPath（正确处理盘符、百分号编码、UNC）；它失败时自己剥协议，
 * **并且必须去掉盘符前的斜杠**：剥完得到 "/C:/Users/..." 这种半成品，
 * 再拼下级目录就成了不存在的路径（实测宿主启动即退出）。
 */
function realpathOf(url: string): string {
	if (!url.startsWith("file:")) return url;
	try {
		return fileURLToPath(url);
	} catch {
		const stripped = decodeURIComponent(url.replace(/^file:\/\//, ""));
		// POSIX 绝对路径保留前导斜杠；Windows 盘符路径（/C:/...）去掉它
		const driveAtOne = stripped.length > 2 && stripped[0] === "/" && /[A-Za-z]/.test(stripped[1] ?? "") && stripped[2] === ":";
		return driveAtOne ? stripped.slice(1) : stripped;
	}
}

function loadConfig(): CuConfig {
	return loadJsonConfig<CuConfig>(CONFIG_PATH, {}, isCuConfig);
}

function getPlatform(): Platform {
	if (process.platform !== "win32") {
		throw new PlatformUnavailableError(`当前只实现了 Windows 桌面控制（本机是 ${process.platform}）`);
	}
	if (!platform) platform = new Win32Platform(hostScriptPath(extensionDir()));
	return platform;
}

function getDetector(): IconDetector {
	if (!detector) detector = new IconDetector(path.join(extensionDir(), "model", MODEL_FILE));
	return detector;
}

/** 截图落盘路径（带时间戳），并清理过旧文件 */
function shotPath(tag: string): string {
	fs.mkdirSync(SHOT_DIR, { recursive: true });
	const file = path.join(SHOT_DIR, `${tag}-${Date.now()}.png`);
	try {
		const old = fs
			.readdirSync(SHOT_DIR)
			.filter((f) => f.endsWith(".png"))
			.map((f) => path.join(SHOT_DIR, f))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
			.slice(KEEP_SHOTS);
		for (const f of old) {
			try {
				fs.unlinkSync(f);
			} catch {}
		}
	} catch {}
	return file;
}

/** 统一的工具失败返回（人话 + 下一步，不 throw） */
function fail(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details, isError: true };
}

/** 未激活时的统一拒绝：告诉模型怎么激活，而不是让它猜 */
function notActivated() {
	return fail("桌面操作尚未激活。先调用 cu_activate 申请激活（用户确认后可用，并获得完整用法）。");
}

/**
 * 桌面场景下排除任务栏区域的视觉框。
 *
 * 桌面截图包含任务栏（它没在窗口枚举里出现，但确实画在画面上）。不排除的话，
 * 开始按钮、任务栏图标会被当成"桌面图标"混进元素表——实测按"左上角第一个"
 * 筛选时选中了开始按钮，点出了开始菜单。
 *
 * 任务栏位置不固定（上/下/左/右），这里用"贴边且厚度小于屏幕 12%"识别。
 */
function excludeTaskbar<T extends { x: number; y: number; w: number; h: number }>(
	items: T[],
	screen: { w: number; h: number },
): T[] {
	// 常见位置：底部（Windows 默认）
	const trayH = Math.round(screen.h * 0.06);
	const inBottomTray = (d: T) => d.y + d.h / 2 > screen.h - trayH;
	const inTopTray = (d: T) => d.y + d.h / 2 < trayH;
	return items.filter((d) => !inBottomTray(d) && !inTopTray(d));
}

/**
 * 把视觉框裁到指定窗口范围内：中心点落在窗口外的直接丢弃。
 *
 * 视觉检测跑全屏截图，而 UIA 只返回焦点窗口。两者范围不同会导致其他窗口里的
 * 图标被混进"当前界面的元素表"——实测纸牌窗口只占屏幕左上角，右侧终端的控件
 * 却出现在了纸牌的元素表里。
 *
 * 用中心点判定而非完整包含：控件常贴在窗口边缘，整框包含会误杀。
 */
function clipDetections<T extends { x: number; y: number; w: number; h: number }>(
	items: T[],
	rect: { x: number; y: number; w: number; h: number },
): T[] {
	return items.filter((d) => {
		const cx = d.x + d.w / 2;
		const cy = d.y + d.h / 2;
		return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
	});
}

/**
 * 动作前的焦点准备：把焦点归还给上次感知到的窗口，并确认桌面可操作。
 *
 * 这是本扩展最关键的适应机制。pi 的问卷、确认框、任何 UI 交互都会把焦点抢回 pi，
 * AI 每次调工具也可能改变焦点——所以**焦点不在目标窗口是常态**。这里在每次动作前：
 * 1) 若焦点不在感知窗口 → 调 activate 主动切回去（AttachThreadInput 绕过前台锁，实测可用）；
 * 2) 切不过去 → 如实报告"会打在哪个窗口上"，让 AI 决定是否继续；
 * 3) 顺带挡住锁屏/安全桌面（此时点击按键全部无效）。
 *
 * 返回 who：切换后实际的前台窗口；switched 表示是否真的切过。
 */
async function prepareAction(): Promise<
	{ ok: true; who: WindowRef | null; switched: boolean; note: string } | { ok: false; reason: string }
> {
	const p = getPlatform();
	let who = await currentWindow();
	// 模态框优先：原生文件对话框、确认框弹出时宿主窗口被禁用，用户此刻只能应对这个框。
	// 若还按"切回上次感知的窗口"处理，等于把模态框顶到后面——用户既动不了框，
	// 也动不了被禁用的宿主，整个流程卡死（实测踩过）。
	if (who?.modal) {
		perceivedWindow = who;
		return { ok: true, who, switched: false, note: "当前是模态对话框，已把它作为操作目标。" };
	}
	if (isDesktopUnavailable(who)) {
		return {
			ok: false,
			reason:
				"当前桌面不可操作：前台是锁屏/登录界面或读不到（" +
				(describeWindow(who) || "hwnd=0") +
				"）。解锁后再试——锁屏状态下的点击与按键不会生效。",
		};
	}
	// 目标窗口可能已被关闭（用户关掉了它），此时句柄会被系统回收复用，
	// 拿旧句柄去 activate 可能"成功"地切到另一个同号新窗口上。
	// 先确认目标还活着，不活就直接拒绝，不要试图切。
	if (perceivedWindow && !(await windowAlive(perceivedWindow.hwnd))) {
		return {
			ok: false,
			reason:
				`感知时的目标窗口 ${describeWindow(perceivedWindow)} 已不存在（可能被关闭了）。` +
				"请重新用 cu_windows(choose=N) 选定目标后再操作。",
		};
	}
	// 焦点不在感知窗口 → 主动切回去
	if (perceivedWindow && who && !sameWindow(who, perceivedWindow)) {
		// 判据以"切完实际读到的前台窗口"为准，不信 activate 的即时返回值：
		// 系统完成前台切换有延迟，activate 内部 60ms 后取样时常还是旧窗口，
		// 但紧接着再取一次就已经切好了（实测会误报"切回失败"）。
		await p.activate(perceivedWindow.hwnd).catch(() => false);
		// 给系统 120ms 完成切换，然后重新取样
		await new Promise((r) => setTimeout(r, 120));
		who = await currentWindow();
		if (sameWindow(who, perceivedWindow)) {
			return { ok: true, who, switched: true, note: "已把焦点切回感知时的窗口。" };
		}
		// 切不过去就拒绝执行：动作落到错误窗口上，可能是在聊天框里发出消息、
		// 在删除确认框上点"是"。宁可不做，也不能打错地方（实测出现过点击
		// 打在文件资源管理器上而 AI 以为在操作浏览器）。
		return {
			ok: false,
			reason:
				`焦点切不回感知时的 ${describeWindow(perceivedWindow)}（当前前台是 ${describeWindow(who)}）。` +
				"为避免动作作用在错误窗口上，本次操作已中止。" +
				"请重新用 cu_windows(choose=N) 选定目标后再操作。",
		};
	}
	return { ok: true, who, switched: false, note: "" };
}

/**
 * 动作类工具的统一前置检查：桌面不可操作时直接拒绝，不要假装成功。
 * 锁屏/安全桌面下点击与按键全部无效，抓屏拿到的是锁屏画面——继续执行只会让 AI 误判。
 */
async function ensureDesktopOperable(): Promise<{ ok: true } | { ok: false; reason: string }> {
	const w = await currentWindow();
	if (isDesktopUnavailable(w)) {
		return {
			ok: false,
			reason:
				"当前桌面不可操作：前台窗口是锁屏/登录界面或读不到（" +
				(describeWindow(w) || "hwnd=0") +
				"）。解锁后再试——锁屏状态下的点击与按键不会生效。",
		};
	}
	return { ok: true };
}

/**
 * 找到 pi 自己的窗口。
 *
 * 判据用进程名：pi 跑在终端里（WindowsTerminal / 各种终端 / 编辑器）。
 * 不用"激活时的前台窗口"——用户可能在任意窗口里点确认框，那样会记错。
 * 找不到就返回 null（此时不做"前台是 pi"的判断，宁可放过也不错杀）。
 */
async function findOwnWindow(): Promise<string | null> {
	try {
		const list = await getPlatform().listWindows();
		const ownNames = ["WindowsTerminal", "wt", "conhost", "Code", "Cursor", "pi", "alacritty", "WezTerm", "Tabby", "Hyper"];
		const hit = list.find((w) => ownNames.some((n) => w.proc.toLowerCase().includes(n.toLowerCase())));
		return hit?.hwnd ?? null;
	} catch {
		return null;
	}
}

/**
 * 判断当前是否是桌面（壁纸 + 图标 + 任务栏）。
 *
 * 判据用**窗口类名**而不是进程名或标题：
 * - 标题会随系统语言变（"Program Manager" 在中文系统也叫这个，但不保证）
 * - 进程名 explorer 同时承载文件资源管理器，只看进程名会误判
 * - 类名 Progman / WorkerW 是 Windows 桌面窗口的固定标识，与语言无关
 *
 * 用途只剩两个：桌面放行（否则会被"前台是 pi"拦掉）、排除任务栏区域。
 * 检测阈值已不再依赖场景（统一 0.08，见 DEFAULT_CONF 的说明）。
 */
function isDesktopScene(win: WindowRef | null): boolean {
	if (!win) return false;
	if (win.rect.w <= 0 || win.rect.h <= 0) return false;
	const cls = (win.cls ?? "").toLowerCase();
	return cls === "progman" || cls === "workerw";
}

/**
 * 窗口是否还存在（可安全操作）。
 *
 * 只看 EnumWindows 的句柄不够：进程被强杀后，窗口对象还会在枚举结果里留存
 * 数秒（实测 2.5s 以上仍能枚举到），此时去点击就会落到别的窗口上。
 * 所以再核一次它归属的进程是否还在。
 *
 * 两步都通过才算活着：句柄在枚举列表里 + 该句柄所属进程在运行列表里。
 */
async function windowAlive(hwnd: string): Promise<boolean> {
	try {
		const list = await getPlatform().listWindows();
		// 判据是"这个句柄还在不在枚举结果里"。
		// 不用"进程是否存活"——同一进程常有多个窗口（实测一个 Notepad 进程开了 3 个窗口），
		// 关掉其中一个时进程还活着，按 pid 判会误认为目标窗口仍在。
		return list.some((w) => w.hwnd === hwnd);
	} catch {
		// 枚举失败时按"还活着"处理：宁可后续 activate 失败被拦，也不误杀正常操作
		return true;
	}
}

/** 取当前焦点窗口；失败返回 null（不影响主流程） */
async function currentWindow(): Promise<WindowRef | null> {
	try {
		const p = getPlatform();
		const raw = await p.focus();
		return toWindowRef({ hwnd: raw.hwnd, proc: raw.proc, title: raw.title, cls: raw.cls, rect: raw.rect, modal: raw.modal });
	} catch {
		return null;
	}
}

/**
 * 感知前的准备：归还焦点 + 确认桌面可操作。
 *
 * 为什么感知也要切焦点：AI 调用本扩展时，前台窗口是 pi 自己（终端/编辑器）。
 * 不先切回"用户正对着的那个窗口"，cu_elements 就会去读终端——拿到一堆终端控件，
 * 与用户屏幕上的实际界面完全无关。实测踩过：在帮助中心页面上反复读不到搜索框，
 * 因为读的其实是 pi 的终端。
 *
 * 优先级：若已知目标窗口（上次感知/激活时记录）就切回去；否则以当前前台为准。
 */
async function prepareForPerception(): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
	const p = getPlatform();
	const cur = await currentWindow();
	if (isDesktopUnavailable(cur)) {
		return {
			ok: false,
			reason:
				"当前桌面不可操作：前台是锁屏/登录界面或读不到（" +
				(describeWindow(cur) || "hwnd=0") +
				"）。解锁后再试。",
		};
	}
	// 桌面场景放行：桌面不属于任何"应用的窗口"，但它是最真实的操作目标
	// （AI 要打开桌面上的程序只能从桌面图标点起）。而且桌面没有 UIA 控件树，
	// 视觉检测是唯一通道，拦掉就等于彻底不能让 AI 用桌面。
	if (isDesktopScene(cur)) {
		perceivedWindow = cur;
		return { ok: true, note: "目标为桌面（壁纸区域），已放行。" };
	}
	// 前台是模态对话框：它盖住了一切，就是用户此刻要操作的东西。
	// 不认它就会去切回"上次感知的窗口"，把模态框顶到后面。
	if (cur?.modal) {
		perceivedWindow = cur;
		return { ok: true, note: "当前是模态对话框，已作为感知目标。" };
	}
	// 前台是 pi 自己。分两种情况：
	// a) 已经选定过目标窗口 → 主动切回去（不切的话永远读到 pi 自己的界面，
	//    这是"从 pi 里调工具"的常态，不是异常）；
	// b) 还没选定目标 → 明确让 AI 先选窗口。
	if (piWindowHwnd && cur?.hwnd === piWindowHwnd) {
		if (perceivedWindow && !sameWindow(perceivedWindow, cur)) {
			// 与动作前的处理一致：切完再看实际前台，不信 activate 的即时返回值
			await p.activate(perceivedWindow.hwnd).catch(() => false);
			await new Promise((r) => setTimeout(r, 120));
			const now = await currentWindow();
			if (now && sameWindow(now, perceivedWindow)) {
				return { ok: true, note: "" };
			}
			return {
				ok: false,
				reason: `已尝试切回 ${describeWindow(perceivedWindow)} 但失败，当前前台仍是 ${describeWindow(now)}。请重试 cu_windows(choose=N) 重新选定目标。`,
			};
		}
		return {
			ok: false,
			reason:
				"当前前台是 pi 自己（" + describeWindow(cur) + "），还没有选定目标窗口。" +
				"先调 cu_windows 看窗口清单，再用 cu_windows(choose=N) 选定目标窗口，然后再感知/操作。",
		};
	}
	// 还没有目标窗口：当前前台（且不是 pi）就是用户想看的东西
	if (!perceivedWindow) {
		perceivedWindow = cur;
		return { ok: true, note: "" };
	}
	return prepareAction();
}

/**
 * 动作前的统一准备：确认有感知基线 + 归还焦点。
 *
 * 为什么要求"先有感知"：动作要靠元素编号或窗口身份定位。若 AI 直接给坐标动手，
 * 就不知道它想操作哪个窗口，也就无从归还焦点。
 */
async function prepareForAction(): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
	const p = getPlatform();
	if (!perceivedWindow) {
		// 没感知过：以当前前台窗口为基线（AI 直接给坐标时就是"操作眼前这个窗口"）
		perceivedWindow = await currentWindow();
	}
	const r = await prepareAction();
	if (!r.ok) return r;
	// 切过焦点后重新校准基线：切换本身可能让窗口重绘
	if (r.switched) perceivedWindow = r.who;
	return { ok: true, note: r.note };
}

/**
 * 动作前留一张差分基准。
 *
 * 用宿主算好的块网格而不是截图 PNG：PNG 那条路每张要抓屏 200ms + 解码 150ms，
 * 动作前后各一次等于每个动作白付 600ms——这是"插件慢"的主要来源。
 * 网格在宿主内同一份位图上采样，一次 20~30ms，且算法与 verify.ts 完全一致。
 */
async function captureBaseline(): Promise<void> {
	const p = getPlatform();
	lastGrid = await p.grid();
}

/** 动作后与基准差分 */
async function diffAfterAction(scope?: DiffScope): Promise<DiffOutcome | null> {
	if (!lastGrid) return null;
	const p = getPlatform();
	const after = await p.grid();
	const outcome = diffGrids(lastGrid, after, scope);
	lastGrid = null;
	return outcome;
}

/**
 * 取当前焦点窗口的矩形，作为差分统计范围。
 *
 * 限定在窗口内而不是全屏：全屏统计会把窗口内的变化稀释掉（实测记事本占屏一半，
 * 滚动 3 格时全屏变化块数不到门槛，误报"画面没变"）。窗口外的像素本就不该参与判断。
 * 取不到窗口时返回 undefined，退回全屏比较。
 */
async function scopeOfFocusedWindow(): Promise<DiffScope | undefined> {
	const w = await currentWindow();
	if (!w || w.rect.w <= 0 || w.rect.h <= 0) return undefined;
	return { x: w.rect.x, y: w.rect.y, w: w.rect.w, h: w.rect.h };
}

/** 动作结果拼装：统一带上「作用窗口」与「画面差分」两段事实 */
function actionReport(parts: string[]): string {
	return parts.filter(Boolean).join("　");
}

/**
 * 动作结果里的焦点说明。
 *
 * 与旧版的关键差别：焦点被 pi 抢走是常态，动作前已经自动切回（prepareForAction），
 * 所以这里多数时候报"已切回"，只在切换失败时才警示"打在别的窗口上"。
 * 不再把"与感知时一致"当成需要强调的事——那才是默认状态。
 */
function actionFocusNote(prepNote: string, who: WindowRef | null): string {
	if (prepNote) return prepNote.replace(/s+$/, "");
	return who ? `作用窗口：${describeWindow(who)}` : "作用窗口：读不到";
}

/** 激活说明：只在激活时给一次，占大头的文本挪到这里 */
function activationBriefing(screen: { w: number; h: number }, win: WindowRef | null, visionOk: boolean): string {
	return [
		"已激活桌面操作。本次会话内可直接调用 cu_* 工具，不再逐步确认。",
		"",
		`屏幕：${screen.w}x${screen.h} 物理像素（截图、元素表、点击参数都是这套坐标）`,
		`当前焦点窗口：${describeWindow(win)}`,
		"",
		"工作方式：",
		"· 动面前先 cu_elements 拿元素表与标注图，用编号操作（cu_click element=N）比手算坐标稳。",
		"· 编号只在下一次感知前有效；界面变了要重新感知。",
		"· 焦点会被 pi 的问卷/确认框抢走，这是常态。插件会在每个动作前自动把焦点切回上次感知的窗口，你不用管。",
		"· 动作后会做全屏差分，报告「哪里变了、多大范围」。画面没变不等于动作失败（有的操作本就不改画面）。",
		"· 文本输入：UIA 设值 → 剪贴板+Ctrl+V → 逐字符，前三者自动选路；含中文时前两级不受输入法影响。",
		"· 上传文件：界面上出现了原生「打开/保存」对话框时，直接 cu_upload_file(path)（用正斜杠，如 C:/a/b.pdf）。它负责定位、写路径、提交并确认框已关闭，不要让模型一步步点框里的控件——那类框对 UIA 不可见。", 
		visionOk
			? "· 视觉检测可用：能覆盖 UIA 看不见的区域，元素表里标 Visual 的条目没有名字，靠标注图辨认。"
			: "· 视觉检测不可用（模型未安装），当前只能按 UIA 控件树操作；Canvas/游戏/远程桌面这类界面会看不到元素。",
		"",
		"安全提醒：桌面是真实环境。发送消息、删除文件、确认付款前先向用户复述一遍要做的动作。",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	// ---------------------------- 激活 ----------------------------

	pi.registerTool({
		name: "cu_activate",
		annotations: { readOnlyHint: false },
		label: "激活桌面操作",
		description: "申请激活桌面操作。用户确认后本次会话内 cu_* 工具可用，并返回完整用法与当前屏幕/焦点窗口信息。",
		promptSnippet: "激活桌面操作：cu_activate() → 授权确认 + 用法与屏幕信息",
		parameters: Type.Object({}),
		async execute(callId, _params, _signal, onUpdate, ctx) {
			// 激活要弹确认框等人点，在 codemode 脚本里会同步阻塞到脚本超时，
			// 超时重试还会堆出多次待确认弹窗。按仓库约定先拒绝，引导直接调用。
			if (!activated && isCodemodeCall(callId)) {
				return fail(
					"激活需要用户点确认框，在 codemode 脚本里调用会同步阻塞到脚本超时（脚本有执行时限，用户来不及点）。" +
						"正确做法：本轮不要写脚本，直接发起 cu_activate 这一次工具调用；用户确认后，下一轮再用脚本批量操作。",
				);
			}
			if (activated) {
				const win = await currentWindow();
				const bounds = await getPlatform().bounds();
				return {
					content: [{ type: "text", text: `桌面操作已处于激活状态。${activationBriefing(bounds, win, getDetector().available())}` }],
					details: { activated: true, window: win, screen: bounds },
				};
			}
			if (!ctx.hasUI) return fail("激活需要用户确认，但当前没有交互界面；请在有 UI 的会话里使用。");
			setWaiting("等待确认激活桌面操作");
			try {
				onUpdate?.({ content: [{ type: "text", text: "等待用户确认…" }], details: {} });
				const ok = await ctx.ui.confirm(
					"允许 AI 操作这台电脑的桌面？",
					[
						"激活后会移动真实鼠标、敲真实键盘，作用在你当前打开的窗口上。",
						"只在本次会话内确认一次；之后不再逐步打断。",
						"建议先切到一个不介意被操作的窗口，并留意 AI 的动作结果里报告的「作用窗口」。",
					].join("\n"),
				);
				if (!ok) return fail("用户拒绝了桌面操作授权，本次会话不会再询问。");
				activated = true;
				saveConsent();
				const bounds = await getPlatform().bounds();
				const win = await currentWindow();
				// 记录 pi 自己的窗口：按进程名判断，不能拿"激活时的前台"顶替——
				// 用户在浏览器里点确认框时，前台可能是那个浏览器，误记下来会导致
				// 之后把目标窗口当成 pi 自己而拒绝操作（实测踩过）。
				piWindowHwnd = await findOwnWindow();
				perceivedWindow = null; // 目标窗口尚未确定，由第一次感知设定
				return {
					content: [{ type: "text", text: activationBriefing(bounds, win, getDetector().available()) }],
					details: { activated: true, window: win, screen: bounds },
				};
			} catch (e) {
				return fail(`激活失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				setWaiting(null);
			}
		},
	});

	// ---------------------------- 窗口选择 ----------------------------

	pi.registerTool({
		name: "cu_windows",
		annotations: { readOnlyHint: true },
		label: "列出桌面窗口",
		description: "列出可见的顶层窗口（含进程名与标题）。焦点被 pi 抢走、或要切到别的窗口时用来选目标。",
		promptSnippet: "列出窗口：cu_windows([choose]) → 窗口清单（选中的会成为后续操作目标）",
		parameters: Type.Object({
			choose: Type.Optional(Type.Number({ description: "选定第几个窗口作为后续操作目标（编号从 1 开始）；不填则只列出" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!activated) return notActivated();
			try {
				const p = getPlatform();
				ctx.ui.setStatus("computer-use", "🪟 列窗口");
				// 最小化的窗口报 -32000 坐标，但仍可选中（activate 会先还原它），
				// 所以不能过滤掉——实测把 Edge 过滤掉后，用户就打不开自己最小化的浏览器了。
				// 只去掉没有尺寸的幽灵窗口。
				const minimized = (w: WindowRef) => w.rect.x <= -30000;
				const list = (await p.listWindows())
					.filter((w) => w.rect.w > 0 && w.rect.h > 0)
					.sort((a, b) => {
						// 可见窗口优先，其次按面积
						const am = minimized(a) ? 1 : 0;
						const bm = minimized(b) ? 1 : 0;
						if (am !== bm) return am - bm;
						return b.rect.w * b.rect.h - a.rect.w * a.rect.h;
					});

				if (params.choose !== undefined) {
					const pick = list[params.choose - 1];
					if (!pick) return fail(`没有编号 ${params.choose} 的窗口（共 ${list.length} 个）。`);
					const ok = await p.activate(pick.hwnd);
					perceivedWindow = pick;
					return {
						content: [
							{
								type: "text",
								text: `已选定目标窗口：${describeWindow(pick)}（切换${ok ? "成功" : "可能未生效"}）。后续 cu_elements / cu_click 都会作用在它上面。`,
							},
						],
						details: { window: pick, switched: ok },
					};
				}

				const lines = list.map((w, i) => {
					const mark = perceivedWindow && w.hwnd === perceivedWindow.hwnd ? " ← 当前目标" : "";
					const pi = piWindowHwnd && w.hwnd === piWindowHwnd ? "（pi 自己，别选）" : "";
					const min = minimized(w) ? "（已最小化）" : "";
					return `${i + 1}. ${describeWindow(w)} ${w.rect.w}x${w.rect.h}${min}${pi}${mark}`;
				});
				return {
					content: [
						{
							type: "text",
							text:
								`共 ${list.length} 个窗口：\n` +
								lines.join("\n") +
								`\n\n用 cu_windows(choose=N) 选定目标；选定后 cu_elements 会先切到该窗口再读取。`,
						},
					],
					details: { windows: list, perceived: perceivedWindow },
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError) return fail(e.message);
				return fail(`列出窗口失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	// ---------------------------- 感知 ----------------------------

	pi.registerTool({
		name: "cu_screenshot",
		annotations: { readOnlyHint: true },
		label: "截取桌面画面",
		description: "截取整个桌面并存成 PNG；detect=true 时同时输出带编号的标注图与元素表。",
		promptSnippet: "截取桌面：cu_screenshot([detect][, conf]) → PNG 路径（detect 时附标注图与元素表）",
		parameters: Type.Object({
			detect: Type.Optional(Type.Boolean({ description: "同时做视觉检测并输出带编号的标注图" })),
			conf: Type.Optional(Type.Number({ description: `检测置信度阈值，默认 ${DEFAULT_CONF}`, minimum: 0, maximum: 1 })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			if (!activated) return notActivated();
				// 感知同样要归还焦点：在 pi 里调用工具时前台是终端，
				// 不切回去就会读到终端而不是用户正对着的那个窗口。
				const prep = await prepareForPerception();
				if (!prep.ok) return fail(prep.reason);
			try {
				const p = getPlatform();
				onUpdate?.({ content: [{ type: "text", text: "正在截屏…" }], details: {} });
				ctx.ui.setStatus("computer-use", "📸 截屏中");
				const file = shotPath("shot");
				await p.capture(file);
				const bounds = await p.bounds();
				const win = await currentWindow();
				// 只有拿到真实窗口才更新基線：读不到时不要把 null 写进去，
				// 否则后续动作会因为"没有感知基线"而失去目标。
				if (win) perceivedWindow = win;
				if (!params.detect) {
					return {
						content: [{ type: "text", text: `桌面截图（${bounds.w}x${bounds.h}）：${file}\n焦点窗口：${describeWindow(win)}` }],
						details: { path: file, screen: bounds, window: win },
					};
				}
				const cfg = loadConfig();
				onUpdate?.({ content: [{ type: "text", text: "正在检测元素…" }], details: {} });
				ctx.ui.setStatus("computer-use", "🔍 检测元素中");
				const input = prepareInput(file);
				// 阈值优先级：显式传参 > 用户配置 > 场景自适应
				// 桌面场景必须降阈值：图标在缩图上只有十几像素，模型给分普遍 0.05~0.25，
				// 用 0.25 会把 30 个图标漏成 2 个（实测）。
				const res = await getDetector().detect(input, params.conf ?? cfg.conf ?? DEFAULT_CONF);
				// 裁到焦点窗口内：不裁的话，全屏检测会把任务栏图标、其他窗口的按钮
				// 全算成"当前界面的元素"（实测 140 个元素里大半是任务栏和标题栏按钮，
				// AI 拿着这种元素表根本没法决策）。
				let dets = res.detections;
				if (win?.rect) {
					dets = clipDetections(dets, win.rect);
					if (isDesktopScene(win)) dets = excludeTaskbar(dets, bounds);
				}
				const annotated = file.replace(/\.png$/, "-annotated.png");
				annotatePng(file, annotated, dets);
				const els = mergeElements([], dets, bounds);
				lastElements = els;
				const clipNote = dets.length !== res.detections.length
					? `（全屏检出 ${res.detections.length} 个，裁到焦点窗口内剩 ${dets.length} 个）`
					: "";
				return {
					content: [
						{
							type: "text",
							text:
								`原始图：${file}\n标注图：${annotated}\n` +
								`${els.length} 个可交互元素（视觉通道 ${res.timing.inferMs}ms）：\n${formatElements(els)}`,
						},
					],
					details: { path: file, annotated, screen: bounds, elements: els, window: win, timing: res.timing },
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError || e instanceof ModelUnavailableError) return fail(e.message);
				return fail(`截屏失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	pi.registerTool({
		name: "cu_elements",
		annotations: { readOnlyHint: true },
		label: "列出可交互元素",
		description: "列出焦点窗口的可交互元素（UIA 控件树 + 视觉补盲），返回带编号的元素表与标注图。",
		promptSnippet: "列出可交互元素：cu_elements([vision][, maxNodes]) → 元素表 + 标注图",
		parameters: Type.Object({
			vision: Type.Optional(Type.Boolean({ description: "是否跑视觉检测补齐盲区，默认 true" })),
			maxNodes: Type.Optional(Type.Number({ description: `UIA 元素上限，默认 ${MAX_UIA_NODES}`, minimum: 20, maximum: 2000 })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			if (!activated) return notActivated();
				// 感知同样要归还焦点：在 pi 里调用工具时前台是终端，
				// 不切回去就会读到终端而不是用户正对着的那个窗口。
				const prep = await prepareForPerception();
				if (!prep.ok) return fail(prep.reason);
			try {
				const p = getPlatform();
				const cfg = loadConfig();
				onUpdate?.({ content: [{ type: "text", text: "正在读取界面…" }], details: {} });
				ctx.ui.setStatus("computer-use", "🧭 读取界面");
				const file = shotPath("shot");
				await p.capture(file);
				const bounds = await p.bounds();
				const win = await currentWindow();
				// 不能无条件把"当前前台"设成目标：cu_windows(choose) 选过目标后，
				// 感知时前台若还没切过去，这里覆盖就会把用户选的窗口丢掉
				// （实测：选了记事本，感知后目标被改成终端，后续动作全打错地方）。
				// 只在还没有目标时才认当前前台。
				if (!perceivedWindow && win) perceivedWindow = win;

				let uiaItems: Awaited<ReturnType<Platform["uia"]>>["items"] = [];
				let uiaTitle = "";
				/** 焦点窗口矩形：用来把全屏的视觉检测结果裁到窗口内 */
				let snapRect: { x: number; y: number; w: number; h: number } | undefined;
				try {
					const snap = await p.uia({ maxNodes: params.maxNodes ?? MAX_UIA_NODES });
					uiaItems = snap.items;
					uiaTitle = snap.title;
					snapRect = snap.rect;
				} catch (e) {
					onUpdate?.({ content: [{ type: "text", text: `UIA 不可用（${e instanceof Error ? e.message : String(e)}）` }], details: {} });
				}

				let detections: Awaited<ReturnType<IconDetector["detect"]>>["detections"] = [];
				let visionNote = "";
				if (params.vision ?? cfg.vision ?? true) {
					try {
						const input = prepareInput(file);
						detections = (await getDetector().detect(input, cfg.conf ?? DEFAULT_CONF)).detections;
					} catch (e) {
						visionNote = e instanceof ModelUnavailableError ? `\n视觉检测不可用：${e.message}` : `\n视觉检测失败：${e instanceof Error ? e.message : String(e)}`;
					}
				}

				// 视觉检测跑的是全屏截图，但 UIA 只给焦点窗口的元素。
				// 不裁剪的话，其他窗口里的图标也会被当成"当前界面的元素"混进元素表
				// （实测纸牌窗口只占左上角，右侧终端的控件被算进了纸牌的元素表）。
				const winRect = snapRect ?? win?.rect;
				let clipped = winRect ? clipDetections(detections, winRect) : detections;
				// 桌面场景：任务栏也在截图里，但它不属于桌面内容。
				// 不排除的话，开始按钮会被当成"桌面图标"，按左上角规则筛选就会点错
				// （实测把开始按钮当成回收站点了下去）。
				if (isDesktopScene(win)) clipped = excludeTaskbar(clipped, bounds);
				const els = mergeElements(uiaItems, clipped, bounds);
				lastElements = els;
				const annotated = file.replace(/\.png$/, "-annotated.png");
				annotatePng(file, annotated, els);

				return {
					content: [
						{
							type: "text",
							text:
								`焦点窗口：${uiaTitle || describeWindow(win)}　${bounds.w}x${bounds.h}\n标注图：${annotated}\n` +
								`${els.length} 个元素（UIA ${els.filter((e) => e.source === "uia").length} + 视觉补 ${els.filter((e) => e.source === "vision").length}` +
								(detections.length > els.filter((e) => e.source === "vision").length
									? `；${detections.length - els.filter((e) => e.source === "vision").length} 个视觉框与 UIA 元素重合已合并`
									: "") +
								`）：\n${formatElements(els)}${visionNote}`,
						},
					],
					details: { annotated, screen: bounds, elements: els, window: win },
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError) return fail(e.message);
				return fail(`读取界面失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	// ---------------------------- 原生文件对话框 ----------------------------

	pi.registerTool({
		name: "cu_dialogs",
		annotations: { readOnlyHint: true },
		label: "列出文件对话框",
		description: "列出当前的原生文件对话框（打开/保存/上传选择框）及其文件名框内容。",
		promptSnippet: "列出文件对话框：cu_dialogs() → 对话框清单（hwnd / 标题 / 模态 / 文件名框现值）",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (!activated) return notActivated();
			try {
				const p = getPlatform();
				ctx.ui.setStatus("computer-use", "🪟 查对话框");
				const list = await p.listDialogs();
				if (!list.length) {
					return {
						content: [
							{
								type: "text",
								text:
									"当前没有原生文件对话框。\n" +
									"如果界面上明明有一个：先点触发它的那个按钮（系统框需要被真的弹出一次才能被枚举）。",
							},
						],
						details: { dialogs: [] },
					};
				}
				const lines = list.map((d, i) => {
					const fg = d.foreground ? "（前台）" : "";
					const modal = d.modal ? "（模态）" : "";
					return `${i + 1}. hwnd=${d.hwnd} ${d.title || "（无标题）"}${modal}${fg} 文件名框：${d.fileName || "（空）"}`;
				});
				return {
					content: [
						{
							type: "text",
							text:
								`当前 ${list.length} 个原生文件对话框：\n${lines.join("\n")}\n\n` +
								"用 cu_upload_file(path) 把文件交给它（自动定位、写入路径、提交、确认关闭）。",
						},
					],
					details: { dialogs: list },
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError) return fail(e.message);
				return fail(`查询对话框失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	pi.registerTool({
		name: "cu_upload_file",
		annotations: { readOnlyHint: false },
		label: "向文件对话框提交文件",
		description: "把本地文件路径交给已弹出的原生文件对话框并提交，返回是否真的关闭（=已选定）。",
		promptSnippet: "提交文件对话框：cu_upload_file(path[, hwnd][, submit]) → 是否关闭 + 生效的提交方式",
		parameters: Type.Object({
			path: Type.String({ description: "本地文件绝对路径（用正斜杠，如 C:/dir/file.pdf）" }),
			hwnd: Type.Optional(Type.String({ description: "指定对话框句柄（多个框并存时用，来自 cu_dialogs）；缺省自动挑模态的那个" })),
			submit: Type.Optional(Type.Boolean({ description: "是否直接提交，默认 true；false = 只填路径不提交" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!activated) return notActivated();
			try {
				const p = getPlatform();
				ctx.ui.setStatus("computer-use", "📎 填文件路径");
				// 路径规范化交给宿主（它能读到真实文件系统），这里只把分隔符统一成反斜杠
				const norm = params.path.replace(/\//g, String.fromCharCode(92));
				const r = await p.fillFileDialog({ hwnd: params.hwnd, path: norm, submit: params.submit !== false });
				const win = await currentWindow();
				if (!r.ok) {
					return fail(`提交文件失败：${r.error ?? "未知原因"}${r.steps.length ? `\n已完成的步骤：${r.steps.join("；")}` : ""}`, {
						...r,
						window: win,
					});
				}
				if (params.submit === false) {
					return {
						content: [{ type: "text", text: `已把路径写入对话框（未提交）：${r.fileName ?? params.path}` }],
						details: { ...r, window: win },
					};
				}
				const text = r.closed
					? `已提交并选定文件：${params.path}（对话框已关闭，通道 ${r.via}）`
					: `路径已写入但对话框没有关闭（通道 ${r.via}）——文件可能未被选定。` +
						`\n下一步：用 cu_dialogs 看框里的当前内容，或 cu_screenshot 看框上是否弹了错误提示（如"文件类型不支持"）。`;
				return {
					content: [{ type: "text", text }],
					details: { ...r, window: win },
					...(r.closed ? {} : { isError: true }),
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError) return fail(e.message);
				return fail(`提交文件失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	// ---------------------------- 动作 ----------------------------

	pi.registerTool({
		name: "cu_click",
		annotations: { readOnlyHint: false },
		label: "点击桌面元素",
		description: "点击元素（给编号）或坐标。优先 UIA 触发控件，走不通才发真实鼠标事件。",
		promptSnippet: "点击：cu_click([element] | x+y[, button][, count]) → 作用窗口 + 画面变化",
		parameters: Type.Object({
			element: Type.Optional(Type.Number({ description: "元素编号（来自最近一次感知）" })),
			x: Type.Optional(Type.Number({ description: "屏幕物理像素 x" })),
			y: Type.Optional(Type.Number({ description: "屏幕物理像素 y" })),
			button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], { description: "鼠标键，默认 left" })),
			count: Type.Optional(Type.Number({ description: "点击次数（2=双击），默认 1", minimum: 1, maximum: 3 })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			if (!activated) return notActivated();
				const prep = await prepareForAction();
				if (!prep.ok) return fail(prep.reason);
			try {
				const target = resolveTarget(params.element, params.x, params.y);
				if (!target.ok) return fail(target.reason);
				const p = getPlatform();
				await captureBaseline();
				onUpdate?.({ content: [{ type: "text", text: `点击 ${target.point.x},${target.point.y}…` }], details: {} });
				ctx.ui.setStatus("computer-use", "🖱 点击中");
				const r = await p.click(target.point.x, target.point.y, { button: params.button ?? "left", count: params.count ?? 1 });
				const win = await currentWindow();
				const diff = await diffAfterAction(await scopeOfFocusedWindow());
				const via = r.via.startsWith("uia") ? `UIA 触发${r.target ? `「${r.target}」` : ""}` : "真实鼠标";
				return {
					content: [
						{
							type: "text",
							text: actionReport([
								`已点击 (${target.point.x},${target.point.y})，通道：${via}。`,
								actionFocusNote(prep.note, win),
								diff ? `画面：${diff.summary}` : "",
							]),
						},
					],
					details: { ...r, point: target.point, window: win, diff },
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError) return fail(e.message);
				return fail(`点击失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	pi.registerTool({
		name: "cu_type",
		annotations: { readOnlyHint: false },
		label: "输入文本",
		description: "输入文本到焦点位置或指定元素。三级通道自动降级，含中文也不受输入法影响。",
		promptSnippet: "输入文本：cu_type(text[, element] | [, x, y]) → 走的通道 + 作用窗口 + 画面变化",
		parameters: Type.Object({
			text: Type.String({ description: "要输入的文本" }),
			element: Type.Optional(Type.Number({ description: "目标元素编号（缺省则输入到当前焦点）" })),
			x: Type.Optional(Type.Number({ description: "目标点 x" })),
			y: Type.Optional(Type.Number({ description: "目标点 y" })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			if (!activated) return notActivated();
				const prep = await prepareForAction();
				if (!prep.ok) return fail(prep.reason);
			try {
				const p = getPlatform();
				const target =
					params.element !== undefined || (params.x !== undefined && params.y !== undefined)
						? resolveTarget(params.element, params.x, params.y)
						: null;
				if (target && !target.ok) return fail(target.reason);
				await captureBaseline();
				onUpdate?.({ content: [{ type: "text", text: "正在输入…" }], details: {} });
				ctx.ui.setStatus("computer-use", "⌨️ 输入中");
				// UIA 写完立刻抓图确认渲染层是否真的变了（Edge 实测有"控件接受但没渲染"的情况）。
				// 结果缓存下来，避免随后 diffAfterAction 再抓一张。
				let uiaDiff: DiffOutcome | null = null;
				const outcome = await typeText(p, params.text, target && target.ok ? target.point : undefined, {
					confirmRender: async () => {
						if (!lastGrid) return true;
						uiaDiff = diffGrids(lastGrid, await p.grid(), await scopeOfFocusedWindow());
						return uiaDiff.changed;
					},
				});
				const win = await currentWindow();
				let diff: DiffOutcome | null;
				if (outcome.via === "uia-value" && uiaDiff) {
					// UIA 生效：复用刚才那次采样的差分结论，不再抓屏
					diff = uiaDiff;
					lastGrid = null;
				} else {
					diff = await diffAfterAction();
				}
				const viaLabel =
					{ "uia-value": "UIA 直接设值", clipboard: "剪贴板 + Ctrl+V", sendinput: "逐字符发送" }[outcome.via] ?? outcome.via;
				return {
					content: [
						{
							type: "text",
							text: actionReport([
								`已输入 ${params.text.length} 字符，通道：${viaLabel}。`,
								actionFocusNote(prep.note, win),
								diff ? `画面：${diff.summary}` : "",
								outcome.notes.length ? `降级：${outcome.notes.join("；")}` : "",
							]),
						},
					],
					details: { ...outcome, window: win, diff },
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError) return fail(e.message);
				return fail(`输入失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	pi.registerTool({
		name: "cu_key",
		annotations: { readOnlyHint: false },
		label: "按键或组合键",
		description: "发送按键或组合键，如 [\"ctrl\",\"c\"]、[\"alt\",\"tab\"]。",
		promptSnippet: "按键：cu_key(keys) → 作用窗口 + 画面变化",
		parameters: Type.Object({
			keys: Type.Array(Type.String(), { description: "按键序列，如 [\"ctrl\",\"shift\",\"t\"]", minItems: 1, maxItems: 4 }),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			if (!activated) return notActivated();
				const prep = await prepareForAction();
				if (!prep.ok) return fail(prep.reason);
			try {
				const p = getPlatform();
				await captureBaseline();
				onUpdate?.({ content: [{ type: "text", text: `按键 ${params.keys.join("+")}…` }], details: {} });
				ctx.ui.setStatus("computer-use", "⌨️ 按键中");
				const r = await p.key(params.keys);
				const win = await currentWindow();
				const diff = await diffAfterAction(await scopeOfFocusedWindow());
				return {
					content: [
						{
							type: "text",
							text: actionReport([`已发送 ${params.keys.join("+")}。`, actionFocusNote(prep.note, win), diff ? `画面：${diff.summary}` : ""]),
						},
					],
					details: { ...r, window: win, diff },
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError) return fail(e.message);
				return fail(`按键失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	pi.registerTool({
		name: "cu_scroll",
		annotations: { readOnlyHint: false },
		label: "滚动页面",
		description: "滚动滚轮：正数向下、负数向上，单位是格。",
		promptSnippet: "滚动：cu_scroll(amount[, element] | [, x, y]) → 作用窗口 + 画面变化",
		parameters: Type.Object({
			amount: Type.Number({ description: "滚动格数（一屏通常 3~10）" }),
			element: Type.Optional(Type.Number({ description: "在该元素上滚动" })),
			x: Type.Optional(Type.Number({ description: "滚动位置 x" })),
			y: Type.Optional(Type.Number({ description: "滚动位置 y" })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			if (!activated) return notActivated();
				const prep = await prepareForAction();
				if (!prep.ok) return fail(prep.reason);
			try {
				const p = getPlatform();
				const target =
					params.element !== undefined || (params.x !== undefined && params.y !== undefined)
						? resolveTarget(params.element, params.x, params.y)
						: null;
				if (target && !target.ok) return fail(target.reason);
				await captureBaseline();
				onUpdate?.({ content: [{ type: "text", text: `滚动 ${params.amount} 格…` }], details: {} });
				ctx.ui.setStatus("computer-use", "🖱 滚动中");
				const r = await p.scroll(params.amount, target && target.ok ? target.point : undefined);
				const win = await currentWindow();
				const diff = await diffAfterAction(await scopeOfFocusedWindow());
				return {
					content: [
						{
							type: "text",
							text: actionReport([`已滚动 ${params.amount} 格。`, actionFocusNote(prep.note, win), diff ? `画面：${diff.summary}` : ""]),
						},
					],
					details: { ...r, window: win, diff },
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError) return fail(e.message);
				return fail(`滚动失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	pi.registerTool({
		name: "cu_drag",
		annotations: { readOnlyHint: false },
		label: "拖拽",
		description: "从一点拖到另一点（拖选文字、移动窗口、拖拽文件）。",
		promptSnippet: "拖拽：cu_drag(fromX, fromY, toX, toY) → 作用窗口 + 画面变化",
		parameters: Type.Object({
			fromX: Type.Number({ description: "起点 x" }),
			fromY: Type.Number({ description: "起点 y" }),
			toX: Type.Number({ description: "终点 x" }),
			toY: Type.Number({ description: "终点 y" }),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			if (!activated) return notActivated();
				const prep = await prepareForAction();
				if (!prep.ok) return fail(prep.reason);
			try {
				const p = getPlatform();
				await captureBaseline();
				onUpdate?.({ content: [{ type: "text", text: "正在拖拽…" }], details: {} });
				ctx.ui.setStatus("computer-use", "🖱 拖拽中");
				const r = await p.drag({ x: params.fromX, y: params.fromY }, { x: params.toX, y: params.toY });
				const win = await currentWindow();
				const diff = await diffAfterAction(await scopeOfFocusedWindow());
				return {
					content: [
						{
							type: "text",
							text: actionReport([
								`已从 (${params.fromX},${params.fromY}) 拖到 (${params.toX},${params.toY})。`,
								actionFocusNote(prep.note, win),
								diff ? `画面：${diff.summary}` : "",
							]),
						},
					],
					details: { ...r, window: win, diff },
				};
			} catch (e) {
				if (e instanceof PlatformUnavailableError) return fail(e.message);
				return fail(`拖拽失败：${e instanceof Error ? e.message : String(e)}`);
			} finally {
				ctx.ui.setStatus("computer-use", undefined as unknown as string);
			}
		},
	});

	// ---------------------------- 生命周期 ----------------------------

	pi.on("session_start", async (_event, ctx) => {
		// 激活状态按会话持久化：/reload 后不需要用户重新授权
		const dir = path.join(os.tmpdir(), "pi-computer-use");
		consentFile = path.join(dir, `consent-${ctx.sessionManager.getSessionId()}.json`);
		activated = loadConsent();
	});

	pi.on("session_shutdown", async () => {
		// 注意：不清 activated——它已按会话落盘，/reload 后由 session_start 恢复。
		// 只有用户主动取消或会话真正结束才该失效。
		perceivedWindow = null;
		lastElements = [];
		lastGrid = null;
		try {
			await detector?.release();
		} catch {}
		detector = null;
		try {
			await platform?.stop();
		} catch {}
		platform = null;
	});

	pi.registerCommand("cu-config", {
		description: "电脑操作设置：视觉检测开关与置信度",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const cur = cfg.vision ?? true;
			const pick = await ctx.ui.select("电脑操作设置", [
				`视觉检测：${cur ? "开" : "关"}（关掉则只用 UIA 控件树）`,
				`检测置信度：${cfg.conf ?? DEFAULT_CONF}`,
			]);
			if (!pick) return;
			if (pick.startsWith("视觉检测")) {
				saveJsonConfig(CONFIG_PATH, { ...cfg, vision: !cur });
				ctx.ui.notify(`视觉检测已${!cur ? "开启" : "关闭"}`, "info");
			} else {
				const values = ["0.15（框多，噪音也多）", "0.25（默认）", "0.35（只留高置信）", "0.5（很严格）"];
				const v = await ctx.ui.select("检测置信度", values);
				if (!v) return;
				saveJsonConfig(CONFIG_PATH, { ...cfg, conf: Number.parseFloat(v) });
				ctx.ui.notify(`置信度已设为 ${v}`, "info");
			}
		},
	});
}

/** 解析操作目标：优先按编号取元素中心，其次用显式坐标 */
function resolveTarget(
	element: number | undefined,
	x: number | undefined,
	y: number | undefined,
): { ok: true; point: { x: number; y: number }; rect: { x: number; y: number; w: number; h: number } } | { ok: false; reason: string } {
	if (element !== undefined) {
		const el = findByIndex(lastElements, element);
		if (!el) {
			return { ok: false, reason: `没有编号 ${element} 的元素。先调用 cu_elements 拿最新的元素表（编号只在下一次感知前有效）。` };
		}
		return { ok: true, point: { x: el.cx, y: el.cy }, rect: { x: el.x, y: el.y, w: el.w, h: el.h } };
	}
	if (x !== undefined && y !== undefined) {
		return { ok: true, point: { x, y }, rect: { x: x - 10, y: y - 10, w: 20, h: 20 } };
	}
	return { ok: false, reason: "需要 element 编号，或同时给出 x 与 y 坐标。" };
}
