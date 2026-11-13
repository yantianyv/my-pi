/**
 * computer-use/platform：桌面控制平台层的类型契约
 *
 * 上层（工具、感知、标注）只依赖这里的接口，不直接碰 PowerShell 或 Win32 细节。
 * 目前只有 win32 实现；加 macOS/Linux 时补一个文件、在 index.ts 里按 process.platform 选即可，
 * 上层代码不用改。
 *
 * 坐标约定：**所有坐标一律是物理像素**，原点在虚拟屏左上角（虚拟屏左上角可以是负数，
 * 副屏在主屏左侧时如此）。截图按整个虚拟屏抓，因此截图上的框就是点击用的坐标，中间不做换算。
 * 混合 DPI 多屏下不存在唯一的缩放比，这个约定绕开了那个问题。
 */

/** 屏幕边界（物理像素） */
export interface ScreenBounds {
	x: number;
	y: number;
	w: number;
	h: number;
	/** DPI 感知模式（诊断用；permonitorv2 表示坐标已是物理像素） */
	dpi: string;
}

/** 焦点窗口身份 */
export interface WindowInfo {
	/** 窗口句柄（十进制字符串；标题会变，判等只能靠它） */
	hwnd: string;
	proc: string;
	title: string;
	/** 窗口类名（与语言无关的身份标识：Progman/WorkerW 即桌面） */
	cls: string;
	/** 所属进程 PID（判断窗口归属的进程是否还在跑） */
	pid: number;
	rect: { x: number; y: number; w: number; h: number };
	/**
	 * 是否为模态窗口（有 owner 且 owner 已被禁用）。
	 *
	 * 用途：原生文件对话框、确认框弹出时宿主窗口会被禁用，此时「用户正在应对的是这个框」——
	 * 焦点归还逻辑必须优先认它，否则会把模态框顶到后面，用户既动不了框也动不了宿主。
	 */
	modal?: boolean;
	/** 模态窗口的宿主（owner）句柄；非模态为 "0" */
	owner?: string;
}

/**
 * 灰度块网格：动作前后差分用。
 *
 * 数值语义与 verify.ts 的 Frame 一致（0~255 亮度），块边长固定 32px，
 * 但由宿主按同一算法采样产出。两侧算法必须保持一致，改一处要同步另一处。
 */
export interface ScreenGrid {
	w: number;
	h: number;
	/** 横向块数（算索引用：index = y * cols + x） */
	cols: number;
	/** 纵向块数 */
	rows: number;
	/** 按行优先排列的块平均亮度 */
	cells: Float32Array;
}

/** 一次抓屏的结果 */
export interface CaptureResult {
	/** PNG 落盘路径（交给读图工具用） */
	path: string;
	/** 截图的物理像素尺寸，通常等于虚拟屏尺寸 */
	w: number;
	h: number;
	/** 抓屏耗时 ms（不含写盘） */
	capMs: number;
	/** 本次调用总耗时 ms */
	ms: number;
}

/** UIA 元素：带物理像素包围盒与控件语义 */
export interface UiaElement {
	name: string;
	/** 控件类型，去掉 ControlType. 前缀（Button / Edit / TabItem …） */
	type: string;
	x: number;
	y: number;
	w: number;
	h: number;
	enabled: boolean;
	/** 该类型是否属于"人真的会点"的控件 */
	interactive: boolean;
}

/** 焦点窗口的 UIA 快照 */
export interface UiaSnapshot {
	title: string;
	/** 窗口类名 */
	cls: string;
	proc: number;
	rect: { x: number; y: number; w: number; h: number };
	count: number;
	items: UiaElement[];
	ms: number;
}

/** 动作执行结果：via 说明走的是哪条通道（uia-invoke 说明没动真实鼠标） */
export interface ActionResult {
	/** 走哪条通道：mouse / uia-invoke / uia-toggle / uia-select / uia-value / clipboard / sendinput */
	via: string;
	/** 命中的元素名与类型（UIA 通道才有） */
	target?: string;
	type?: string;
	/** 该动作的服务端耗时 ms */
	ms?: number;
	[key: string]: unknown;
}

/** 原生文件对话框（打开/保存/上传选择框） */
export interface FileDialog {
	hwnd: string;
	title: string;
	/** 是否模态：模态框盖住宿主，且宿主已被禁用——用户此刻只能应对它 */
	modal: boolean;
	/** 是否当前前台 */
	foreground: boolean;
	/** 文件名框当前内容（不在前台或读不到时为空串） */
	fileName: string;
	rect: { x: number; y: number; w: number; h: number };
}

/** 一次「把文件交给对话框」的结果 */
export interface DialogFillResult {
	/** 是否启动了对话框操作（false 表示压根没找到框，看 error） */
	ok: boolean;
	/** 对话框在操作后是否已关闭（= 文件确实被提交了） */
	closed: boolean;
	/** 实际生效的提交方式：bm_click / bm_click+enter / bm_click+enter+idok */
	via: string;
	/** 各步骤记录 */
	steps: string[];
	/** 失败原因（人话） */
	error?: string;
	/** 操作后框里的文件名 */
	fileName?: string;
}

/** 鼠标按键 */
export type MouseButton = "left" | "right" | "middle";

/** 平台实现契约：win32-host.ps1 对应的 Node 侧封装 */
export interface Platform {
	/** 平台标识（win32 / darwin / linux） */
	readonly name: string;
	/** 宿主是否已就绪（首次调用自动拉起） */
	start(): Promise<void>;
	/** 关掉常驻宿主 */
	stop(): Promise<void>;
	/** 屏幕边界 */
	bounds(): Promise<ScreenBounds>;
	/**
	 * 当前焦点窗口的身份（进程名 / 标题 / 矩形），约 9ms。
	 * 每个动作前后都调它，用来在结果里如实报告"这一步实际作用在哪个窗口"。
	 */
	focus(): Promise<WindowInfo>;
	/**
	 * 把指定窗口切回前台，返回是否真的切到了。
	 *
	 * 必须有的理由：pi 的问卷/确认框/任何交互都会把焦点抢回 pi，而 AI 每次调工具
	 * 本身又可能改变焦点——"焦点不在目标窗口"是常态而非异常。所以不能只报告失配
	 * 让 AI 自己切（它做不到），必须由插件在动作前主动把焦点还给目标窗口。
	 *
	 * 实现要点：前台锁会让 SetForegroundWindow 静默失败，需先 AttachThreadInput
	 * 到当前前台线程借权限（已实测跨进程可用）。
	 */
	activate(hwnd: string): Promise<boolean>;
	/**
	 * 列出可见顶层窗口（有标题、有尺寸）。
	 *
	 * 用途：焦点被 pi 抢走时，AI 需要一种方式明确"我要操作哪个窗口"——
	 * 光靠"当前前台"不行，因为调用工具的瞬间前台总是 pi。
	 */
	listWindows(): Promise<WindowInfo[]>;
	/** 抓屏到指定 PNG 路径 */
	capture(outPath: string): Promise<CaptureResult>;
	/**
	 * 抓屏并直接返回灰度块网格（动作前后差分用），不落盘。
	 *
	 * 为什么不复用 capture：差分只需要"每块平均亮度"，而 capture 要 PNG 编码（~200ms）
	 * 再由 Node 解码（~150ms）。这条路在宿主内算完直接回传，实测 21~29ms。
	 * 跨进程传 4000 个 float 的 JSON 约 30KB，比传一张 PNG 便宜一个数量级。
	 */
	grid(): Promise<ScreenGrid>;
	/** 列出当前的原生文件对话框 */
	listDialogs(): Promise<FileDialog[]>;
	/**
	 * 把文件路径交给原生文件对话框（定位 → 写路径 → 提交 → 确认关闭）。
	 *
	 * 为什么要有这个封装而不是让模型自己点：这类框对 UIA 不友好（控件被报成 Pane、
	 * 没有 ValuePattern），靠元素编号根本点不到；且它是系统固定形状的 UI，
	 * 分四五步让模型试错没有意义。
	 */
	fillFileDialog(opts: { hwnd?: string; path?: string; submit?: boolean; cancel?: boolean }): Promise<DialogFillResult>;
	/** 焦点窗口的 UIA 元素树 */
	uia(opts?: { maxNodes?: number; maxDepth?: number }): Promise<UiaSnapshot>;
	/** 移动鼠标 */
	move(x: number, y: number): Promise<ActionResult>;
	/**
	 * 点击。preferUia=true 时先问 UIA 能否 Invoke（不动真实鼠标，窗口被遮挡也成立），
	 * 走不通再发真实鼠标事件。
	 */
	click(x: number, y: number, opts?: { button?: MouseButton; count?: number; preferUia?: boolean }): Promise<ActionResult>;
	/** 从一点拖到另一点 */
	drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<ActionResult>;
	/** 滚轮：amount>0 向下，单位是"格" */
	scroll(amount: number, at?: { x: number; y: number }): Promise<ActionResult>;
	/** 按键或组合键，如 ["ctrl","c"]、["enter"] */
	key(keys: string[]): Promise<ActionResult>;
	/**
	 * 通过 UIA 的 ValuePattern 直接设置控件值（不经过键盘，不受输入法影响）。
	 * 失败时抛错由上层换通道。
	 */
	setValue(x: number, y: number, value: string): Promise<ActionResult>;
	/**
	 * 逐字符发送纯 ASCII 文本（SendInput 的 Unicode 路径）。
	 * 只用于最后的兜底：含非 ASCII 时会被输入法拦截并组合，调用方应先判断。
	 */
	typeAscii(text: string): Promise<ActionResult>;
	/**
	 * 把文本写进系统剪贴板（供"剪贴板 + Ctrl+V"通道用）。
	 */
	setClipboard?(text: string): Promise<void>;
	/**
	 * 读剪贴板（用于粘贴前备份、粘贴后还原）。
	 *
	 * 必须由平台层提供：早期实现每次起一个 `powershell -Command Get-Clipboard`
	 * 子进程，实测 965ms/次——每输入一次文本就卡将近一秒，是"慢"的主要来源之一。
	 * 宿主内用 P/Invoke 读只要 2.5ms。
	 */
	getClipboard?(): Promise<string>;
}

/** 平台宿主不可用（未安装/启动失败/平台不支持）时抛这个，上层转成 isError 人话结果 */
export class PlatformUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlatformUnavailableError";
	}
}
