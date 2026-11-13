/**
 * computer-use/focus：追踪"当前操作的是哪个窗口"，并在每个动作结果里如实报告
 *
 * 为什么需要这一层：实测出现过最危险的一类失败——**授权弹窗把焦点抢回 pi 自己**，
 * 用户在弹窗上点完确认，焦点就留在 pi 里了；紧接着的点击/输入全部打在 pi 自己的窗口上，
 * 而工具只返回"ok"。AI 以为在操作记事本，实际在往自己的输入框里打字。
 * 这一次没造成破坏，但同样的失配可能把内容发进聊天窗口、在删除确认框上点"是"。
 *
 * 处理策略：**动作前主动把焦点还给目标窗口**，而不是只报告失配。
 *
 * 为什么不能只报告：pi 的问卷、确认框、任何交互都会把焦点抢回 pi；而且 AI 每调一次
 * 工具都可能再次改变焦点——"焦点不在目标窗口"是常态，不是异常。指望 AI 自己切也做不到
 * （它没有切窗口的能力，再调工具只会又动一次焦点）。所以由插件在动作前调 activate
 * 把焦点还给上次感知到的窗口，切成功再动手；切不过去才如实报告。
 *
 * 仍保留"实际作用在哪个窗口"的报告：切焦点可能被系统拒绝（前台锁、权限、窗口已关闭），
 * 那时必须让 AI 知道自己刚才那步打在了别处。
 *
 * 成本：拿一次焦点窗口身份约 9ms（GetForegroundWindow + 进程名 + 标题 + 矩形），
 * 相比抓屏 130ms 可以忽略，因此每个动作都做，不必挑时机。
 */
import { execFileSync } from "node:child_process";

/** 窗口身份：够判断"是不是同一个窗口"，也够让模型认出来 */
export interface WindowRef {
	/** 窗口句柄（十进制字符串，跨调用稳定） */
	hwnd: string;
	/** 进程名，如 Notepad / explorer */
	proc: string;
	/** 窗口标题 */
	title: string;
	/** 窗口类名（与语言无关；Progman/WorkerW 即桌面） */
	cls: string;
	/** 所属进程 PID */
	pid: number;
	/** 窗口矩形（物理像素） */
	rect: { x: number; y: number; w: number; h: number };
	/**
	 * 是否模态（有 owner 且 owner 已被禁用）。
	 *
	 * 为什么放在窗口身份里：模态框意味着"用户此刻只能应对它"，焦点归还逻辑
	 * 必须优先认它，否则会把框顶到后面、把流程卡死。
	 */
	modal?: boolean;
}

/** 取焦点窗口身份的 PowerShell 片段（走常驻宿主，避免每次 ~40ms 的进程启动开销） */
export const FOCUS_OP = "focus";

/** 把宿主返回的原始字段转成 WindowRef */
export function toWindowRef(raw: Record<string, unknown>): WindowRef | null {
	const hwnd = raw.hwnd;
	if (hwnd === undefined || hwnd === null || hwnd === "") return null;
	const rect = (raw.rect ?? {}) as Record<string, number>;
	return {
		hwnd: String(hwnd),
		proc: String(raw.proc ?? "?"),
		title: String(raw.title ?? ""),
		cls: String(raw.cls ?? ""),
		pid: Number(raw.pid ?? 0),
		rect: { x: Number(rect.x ?? 0), y: Number(rect.y ?? 0), w: Number(rect.w ?? 0), h: Number(rect.h ?? 0) },
		modal: raw.modal === true,
	};
}

/**
 * 桌面是否处于"不可操作"状态：锁屏、切换用户、UAC 安全桌面等。
 *
 * 判据：GetForegroundWindow 返回 0（或进程名退化到 Idle），说明当前前台不在用户的
 * 交互桌面上——典型是锁屏（LockApp）或 CSP 安全桌面。此时抓屏会得到锁屏画面，
 * 点击与按键全部无效，继续执行只会让 AI 以为在操作、实际什么都没发生。
 *
 * 这不是"限制"，是如实告知：AI 需要知道此刻桌面不归它管。
 */
export function isDesktopUnavailable(w: WindowRef | null): boolean {
	if (!w) return true;
	if (w.hwnd === "0" || w.hwnd === "") return true;
	if (w.proc === "Idle" || w.proc === "LockApp" || w.proc === "LogonUI") return true;
	return false;
}

/** 窗口的可读描述（给模型看） */
export function describeWindow(w: WindowRef | null): string {
	if (!w) return "（无法读取焦点窗口）";
	const title = w.title.trim() || "（无标题）";
	const modal = w.modal ? "（模态对话框）" : "";
	return `${w.proc}「${title.length > 40 ? `${title.slice(0, 39)}…` : title}」${modal}`;
}

/** 判断两次是不是同一个窗口：句柄相同即同一窗口（标题会变，不能拿标题判等） */
export function sameWindow(a: WindowRef | null, b: WindowRef | null): boolean {
	if (!a || !b) return false;
	return a.hwnd === b.hwnd;
}

/**
 * 生成"焦点失配"的说明文本。
 *
 * 注意：现在主流程用的是"动作前自动归还焦点"（见 index.ts 的 prepareForAction），
 * 这个函数只在**切焦点失败**时才会被用到，所以文案按"出问题了"来写。
 * 保留成独立函数便于单测，也便于将来别的调用方复用。
 */
export function focusNote(action: WindowRef | null, perceived: WindowRef | null): string {
	if (!action) return "作用窗口：读不到焦点窗口信息。";
	if (!perceived) return `作用窗口：${describeWindow(action)}`;
	if (sameWindow(action, perceived)) return `作用窗口：${describeWindow(action)}（与感知时一致）`;
	return (
		`作用窗口：${describeWindow(action)}` +
		`　⚠ 这不是感知时的窗口（${describeWindow(perceived)}）——焦点可能被其他窗口抢走，` +
		"当前操作落到了别的窗口上；需要操作原窗口请先把焦点切回去并重新感知。"
	);
}

/** 用独立进程取一次焦点窗口（宿主不可用时的兜底，约 40ms） */
export function focusViaChildProcess(): WindowRef | null {
	try {
		const out = execFileSync(
			"powershell",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				[
					"Add-Type -AssemblyName System.Windows.Forms",
					"$cs=@'",
					"using System; using System.Text; using System.Diagnostics; using System.Runtime.InteropServices;",
					"public class FQ {",
					'  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
					'  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
					'  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
					'  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
					"  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }",
					"  public static string Go() {",
					"    IntPtr h = GetForegroundWindow();",
					"    var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);",
					"    uint pid; GetWindowThreadProcessId(h, out pid);",
					"    RECT r; GetWindowRect(h, out r);",
					'    string pn = "?"; try { pn = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) {}',
					'    return h.ToInt64()+"|"+pn+"|"+sb.ToString()+"|"+r.L+","+r.T+","+(r.R-r.L)+","+(r.B-r.T);',
					"  }",
					"}",
					"'@",
					"Add-Type -TypeDefinition $cs -Language CSharp",
					"[FQ]::Go()",
				].join("\n"),
			],
			{ encoding: "utf8", windowsHide: true, timeout: 15_000 },
		)
			.trim()
			.split("\n")
			.pop() ?? "";
		const [hwnd, proc, title, rectStr] = out.split("|");
		if (!hwnd) return null;
		const [x, y, w, h] = (rectStr ?? "0,0,0,0").split(",").map(Number);
		// 独立进程兜底拿不到类名（要多一次 P/Invoke），留空即可——
		// isDesktopScene 判不出桌面时只会少一个放行，不影响正常操作。
		return { hwnd: hwnd.trim(), proc: proc ?? "?", title: title ?? "", cls: "", pid: 0, rect: { x: x ?? 0, y: y ?? 0, w: w ?? 0, h: h ?? 0 } };
	} catch {
		return null;
	}
}
