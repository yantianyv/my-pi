# computer-use / Windows 桌面宿主
#
# 常驻进程，从 stdin 读一行 JSON 请求，向 stdout 写一行 "@@CU@@<json>" 响应。
# 常驻的理由：PowerShell 冷启动 ~330ms，而单次抓屏只要 ~100ms；每次动作重开进程会把
# 延迟堆到秒级。这里启动一次、之后每次调用只付真实工作的成本（实测 ping 1ms、抓屏 130ms、
# UIA 热调 23ms）。
#
# 编码约定：凡是可能含非 ASCII 的字段（窗口标题、控件名）一律 Base64 编码后回传，
# 由 Node 侧解码。实测：经 stdout 直传会被控制台代码页破坏成 U+FFFD
# （"⠸ ⌨️ bash — my_pi" 变成 "?? ?? bash �� my_pi"），而同一字符串转 Base64 完好；
# GetWindowTextW 还必须声明 CharSet.Unicode，否则 StringBuilder 按 ANSI 封送、只拿到首字符。
#
# 坐标约定：进程启动即声明 PerMonitorV2 DPI 感知，此后本进程看到的一切（VirtualScreen、
# UIA BoundingRectangle、SendInput 绝对坐标）都是物理像素。截图按 VirtualScreen 抓，
# 因此模型返回的框乘以缩放比后可直接用于点击，中间不做逻辑像素换算——混合 DPI 多屏下
# 没有唯一的缩放比，绕开它比修它便宜。
#
# 文本输入交给 UIA 的 ValuePattern / 剪贴板（见 Node 侧），不在这里发 Unicode：
# 中文 IME 会拦截 SendInput 的 Unicode 字符并组合（实测 "CU type test 123" 变成
# "CU 3333...3333"）。宿主只负责按键与鼠标这类输入法无关的动作。

$ErrorActionPreference = 'Stop'
# stdout 与 stdin 都必须显式 UTF-8：Windows 控制台默认代码页（GBK）会把中文 JSON 字段
# 破坏掉。实测 1）setvalue 的文本变成 "镀姏 垎噀?"，UIA 收到乱码直接报错；
# 2）窗口标题经 stdout 回来变成 U+FFFD。两边都用 UTF-8 才无损。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes

$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class CUHost {
	[StructLayout(LayoutKind.Sequential)]
	public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Sequential)]
	public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Explicit)]
	public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
	[StructLayout(LayoutKind.Sequential)]
	public struct INPUT { public uint type; public INPUTUNION u; }

	[DllImport("user32.dll", SetLastError = true)]
	static extern uint SendInput(uint n, INPUT[] p, int cb);
	[DllImport("user32.dll")]
	static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
	[DllImport("user32.dll")]
	static extern bool SetCursorPos(int x, int y);

	const uint IN_MOUSE = 0, IN_KEY = 1;
	const uint MOVE = 0x0001, ABS = 0x8000, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010;
	const uint MDOWN = 0x0020, MUP = 0x0040, WHEEL = 0x0800;
	const uint KEYUP = 0x0002, UNI = 0x0004;

	static int SW = 1, SH = 1;

	// PerMonitorV2 = -4：让本线程按物理像素思考，三套坐标系收敛成一套
	public static string InitDpi() {
		try { SetThreadDpiAwarenessContext(new IntPtr(-4)); return "permonitorv2"; }
		catch { return "unavailable"; }
	}

	public static void InitBounds(int w, int h) { SW = w < 1 ? 1 : w; SH = h < 1 ? 1 : h; }

	// 虚拟屏左上角可能为负（副屏在主屏左侧），坐标先减去原点再映射到 0..65535
	static int ToAbs(int v, int origin, int span) {
		return (int)Math.Round((v - origin) * 65535.0 / (span - 1));
	}

	public static void MoveTo(int x, int y, int ox, int oy) {
		var a = new INPUT[1];
		a[0].type = IN_MOUSE;
		a[0].u.mi.dx = ToAbs(x, ox, SW);
		a[0].u.mi.dy = ToAbs(y, oy, SH);
		a[0].u.mi.dwFlags = ABS | MOVE;
		SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
	}

	public static void ClickAt(int x, int y, int ox, int oy, string button, int count) {
		MoveTo(x, y, ox, oy);
		uint down = LDOWN, up = LUP;
		if (button == "right") { down = RDOWN; up = RUP; }
		else if (button == "middle") { down = MDOWN; up = MUP; }
		var seq = new INPUT[count * 2];
		for (int i = 0; i < count; i++) {
			seq[i * 2].type = IN_MOUSE; seq[i * 2].u.mi.dwFlags = down;
			seq[i * 2 + 1].type = IN_MOUSE; seq[i * 2 + 1].u.mi.dwFlags = up;
		}
		SendInput((uint)seq.Length, seq, Marshal.SizeOf(typeof(INPUT)));
	}

	public static void DragFromTo(int x1, int y1, int x2, int y2, int ox, int oy) {
		MoveTo(x1, y1, ox, oy);
		var d = new INPUT[1]; d[0].type = IN_MOUSE; d[0].u.mi.dwFlags = LDOWN;
		SendInput(1, d, Marshal.SizeOf(typeof(INPUT)));
		// 分步移动：一步跳到终点会被许多控件识别成"传送"而非拖拽
		for (int i = 1; i <= 10; i++) {
			MoveTo(x1 + (x2 - x1) * i / 10, y1 + (y2 - y1) * i / 10, ox, oy);
			System.Threading.Thread.Sleep(12);
		}
		var u = new INPUT[1]; u[0].type = IN_MOUSE; u[0].u.mi.dwFlags = LUP;
		SendInput(1, u, Marshal.SizeOf(typeof(INPUT)));
	}

	public static void Wheel(int amount) {
		var a = new INPUT[1];
		a[0].type = IN_MOUSE;
		a[0].u.mi.mouseData = unchecked((uint)(amount * 120));
		a[0].u.mi.dwFlags = WHEEL;
		SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
	}

	// 组合键：形如 ["ctrl","shift","t"]，按下顺序与释放顺序相反
	[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int n);
	// CharSet.Unicode 必加：不声明时 StringBuilder 按 ANSI 封送，W 版函数写入的 UTF-16
	// 会被截成第一个字符（实测 19 字符的窗口标题只拿到一个 "R"）
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder sb, int n);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECTR r);
	[StructLayout(LayoutKind.Sequential)] public struct RECTR { public int L, T, R, B; }

	[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
	[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
	[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
	[DllImport("user32.dll")] public static extern IntPtr GetWindowThreadProcessId(IntPtr h, IntPtr pid);
	[DllImport("user32.dll")] public static extern bool AttachThreadInput(IntPtr a, IntPtr b, bool f);
	[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentThreadId();

	// 窗口归属与模态：原生文件对话框由独立进程承载（Win11 的 IFileOpenDialog 跑在 Explorer 的
	// 「打开/保存」宿主里），所以「同进程」不能当归属判据。真正的判据是 owner 链，
	// 以及「owner 当前是否被禁用」——模态对话框一出现，宿主窗口立刻被禁用。
	[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
	[DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
	[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
	const uint GW_OWNER = 4;

	public static IntPtr OwnerOf(IntPtr h) { return GetWindow(h, GW_OWNER); }

	/** 模态 = 有 owner 且 owner 已被禁用；比 WindowPattern.IsModal 稳（后者要多一次跨进程调用） */
	public static bool IsModal(IntPtr h) {
		IntPtr o = GetWindow(h, GW_OWNER);
		return o != IntPtr.Zero && !IsWindowEnabled(o);
	}

	[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr h);
	[DllImport("user32.dll")] static extern IntPtr GetShellWindow();
	delegate bool EnumProc(IntPtr h, IntPtr l);

	// List visible top-level windows with a title, as "hwnd|pid|proc|title" lines.
	// Used to let the AI pick a target window explicitly when focus sits on pi.
	//
	// 进程名带缓存：Process.GetProcessById 实测量到 194ms/次（首次枚举 30 个窗口时逐个查），
	// 而 pid→进程名在一轮操作里不会变。缓存后同一份枚举降到 3ms 量级。
	static Dictionary<uint, string> procNames = new Dictionary<uint, string>();

	static string ProcName(uint pid) {
		string v;
		if (procNames.TryGetValue(pid, out v)) return v;
		try { v = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { v = "?"; }
		procNames[pid] = v;
		return v;
	}

	public static string ListWindows() {
		var sb = new StringBuilder();
		EnumWindows(delegate(IntPtr h, IntPtr l) {
			// 桌面窗口（GetShellWindow 返回的 Program Manager）不再排除：
			// 它没有 UIA 控件树，桌面图标只能靠视觉定位，是 AI 打开桌面程序的唯一入口。
			if (!IsWindowVisible(h)) return true;
			int len = GetWindowTextLengthW(h);
			var cls = new StringBuilder(256);
			GetClassNameW(h, cls, 256);
			string cname = cls.ToString();
			// 原生对话框（#32770）没有标题时也要列出：它是流程卡住的现场，
			// 按「有标题」一刀切会把它整条丢掉，AI 就看不见自己卡在哪。
			if (len <= 0 && cname != "#32770") return true;
			var t = new StringBuilder(len + 2);
			GetWindowTextW(h, t, t.Capacity);
			uint pid;
			GetWindowThreadProcessId(h, out pid);
			if (pid == 0) return true;
			RECTR r;
			GetWindowRect(h, out r);
			if (r.R - r.L <= 0 || r.B - r.T <= 0) return true;
			// 标题里的换行会破坏行协议（把一条记录切成两段，解析时拿到半条），
			// 字段分隔符 (char)1 同理。一律替换成空格。
			string safeTitle = t.ToString().Replace((char)10, ' ').Replace((char)13, ' ').Replace((char)1, ' ');
			IntPtr owner = GetWindow(h, GW_OWNER);
			sb.Append(h.ToInt64()).Append((char)1).Append(pid).Append((char)1).Append(ProcName(pid))
				.Append((char)1).Append(safeTitle).Append((char)1)
				.Append(r.L).Append((char)44).Append(r.T).Append((char)44).Append(r.R - r.L).Append((char)44).Append(r.B - r.T)
				.Append((char)1).Append(cname)
				.Append((char)1).Append(owner.ToInt64())
				.Append((char)1).Append(IsModal(h) ? 1 : 0)
				.Append((char)10);
			return true;
		}, IntPtr.Zero);
		return sb.ToString();
	}

	// 把窗口切到前台。前台锁会让 SetForegroundWindow 静默失败，必须借权限——
	// 但**挂接的必须是「目标窗口线程 ↔ 当前前台线程」，而不是「本线程 ↔ 前台线程」**。
	//
	// 这是实测踩出来的关键差别：本宿主是后台常驻进程，挂接本线程对 SetForegroundWindow
	// 的权限判定没有帮助，于是对"由别的进程承载、且宿主窗口已被禁用的模态对话框"
	// （原生文件对话框正是此类）永远返回 False——表现为插件反复"切回失败"、
	// 而模态框就卡在那儿没人能动。改成挂接目标窗口线程后实测 100% 成功（见 WayB 对照）。
	public static bool Activate(IntPtr t) {
		if (t == IntPtr.Zero) return false;
		if (!IsWindow(t)) return false;
		if (IsIconic(t)) ShowWindow(t, 9);
		if (GetForegroundWindow() == t) return true;
		IntPtr fg = GetForegroundWindow();
		IntPtr tt = GetWindowThreadProcessId(t, IntPtr.Zero);
		IntPtr ft = GetWindowThreadProcessId(fg, IntPtr.Zero);
		bool att = false;
		try {
			if (tt != IntPtr.Zero && ft != IntPtr.Zero && tt != ft) att = AttachThreadInput(tt, ft, true);
			bool ok = SetForegroundWindow(t);
			if (!ok) { ShowWindow(t, 5); ok = SetForegroundWindow(t); }
			return ok;
		} finally { if (att) AttachThreadInput(tt, ft, false); }
	}

	// 焦点窗口身份：约 9ms，不做控件树遍历。字段用 "|" 分隔，由 PowerShell 侧拆开后序列化
	public static string FocusFields() {
		IntPtr h = GetForegroundWindow();
		var sb = new System.Text.StringBuilder(512);
		GetWindowTextW(h, sb, 512);
		uint pid;
		GetWindowThreadProcessId(h, out pid);
		RECTR r;
		GetWindowRect(h, out r);
		string pn = "?";
		try { pn = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
		// 类名是判断窗口身份最稳的依据：与语言无关，Progman/WorkerW 即桌面
		var cls = new System.Text.StringBuilder(256);
		GetClassNameW(h, cls, 256);
		return h.ToInt64() + "" + pn + "" + sb.ToString() + "" + r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T) + "" + cls.ToString();
	}

	// ---------------- 原生文件对话框的 Win32 访问 ----------------
	//
	// 为什么绕开 UIA：实测同一个原生文件对话框（Firefox/浏览器触发的 IFileOpenDialog），
	// UIA 把它的控件全部降级成 ControlType.Pane——文件名框、打开按钮的真实 Win32 类名
	// 明明是 Edit / Button，UIA 却报 Pane 且不给 ValuePattern / InvokePattern，
	// 于是「按 UIA 元素点 / 按 ValuePattern 写路径」两条路都走不通。
	// 而 Win32 经典接口对同一个窗口完全可用：
	//   GetDlgItem(dlg, 1148) → ComboBoxEx32 → FindWindowEx("ComboBox") → FindWindowEx("Edit")
	//   WM_SETTEXT 写中文路径（实测 240ms、读回一致，不经键盘所以 IME 无从干预）
	//   GetDlgItem(dlg, 1) = 打开按钮 → BM_CLICK（实测 800ms 内对话框关闭）
	// 所以对话框路径一律走 Win32 消息，UIA 只负责「这是不是一个文件对话框」的识别。
	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
	[DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
	static extern IntPtr SendMsgStr(IntPtr h, uint msg, IntPtr w, string l);
	[DllImport("user32.dll", EntryPoint = "SendMessageW")]
	static extern IntPtr SendMsgInt(IntPtr h, uint msg, IntPtr w, IntPtr l);
	[DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
	static extern IntPtr SendMsgBuf(IntPtr h, uint msg, IntPtr w, System.Text.StringBuilder l);
	[DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dlg, int id);
	[DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);

	[DllImport("user32.dll")] static extern bool SetFocus(IntPtr h);

	/**
	 * 填文件名 + 提交，整段在一个方法里完成。
	 *
	 * 为什么不在 PowerShell 层拼步骤：这条链路对时序敏感（写完要等对话框消化路径、
	 * 提交按钮才会从 disabled 切回 enabled），而每一步中间的 PowerShell 语句都会引入
	 * 额外的调度与等待。实测同样的步骤写在 PowerShell 里时"点了不关框"，
	 * 收进一个方法后稳定通过。步骤拆细的代价在这里大过它的可读性收益。
	 *
	 * 返回一行状态：written=<读回值> closed=<0|1> via=<提交方式>
	 */
	public static string FillAndSubmit(IntPtr dlg, IntPtr edit, string path, bool submit) {
		if (edit == IntPtr.Zero) return "error=no-edit";
		string readBack;
		if (!string.IsNullOrEmpty(path)) {
			SendMsgStr(edit, WM_SETTEXT, IntPtr.Zero, path);
			readBack = WmGetText(edit);
			if (readBack != path) return "readback-mismatch=" + readBack;
			// 给对话框消化路径的时间：它要校验文件、刷新列表、恢复主按钮
			System.Threading.Thread.Sleep(200);
		} else {
			// 不传路径 = 沿用框里已有的内容。绝不能写空串：那会把上一步填好的路径清掉，
			// 于是"只提交"变成了"提交一个空文件名"，表现为点了没反应。
			readBack = WmGetText(edit);
		}
		if (!submit) return "written=" + readBack + " closed=0 via=none";
		IntPtr btn = GetDlgItem(dlg, 1);
		if (btn == IntPtr.Zero) return "error=no-button";
		// 主按钮在路径无效时是 disabled，此时 BM_CLICK 什么都不做。
		// 不用固定 sleep 代替这个判据：路径解析耗时随机器与目录大小浮动（实测 100~800ms），
		// 睡死一个数是赌，等它真的可用才是对的。超时后照常尝试，交给下面的三种方式兜底。
		int waited = 0;
		while (!IsWindowEnabled(btn) && waited < 2000) {
			System.Threading.Thread.Sleep(50);
			waited += 50;
		}
		if (!IsWindowEnabled(btn)) return "error=button-disabled";

		bool closed = false;
		string via = "";
		// 依次尝试三种提交方式，任一种让窗口消失即成功。
		// 不同宿主接受的方式确实不同（实测标准 #32770 吃第一种，自绘宿主会漏到后两种）。
		SendMsgInt(btn, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
		via = "bm_click";
		closed = WaitGone(dlg, 1500);
		if (!closed) {
			// Enter：把焦点放到文件名框再发回车（对话框默认按钮响应回车）
			SetFocus(edit);
			SendMsgInt(dlg, 0x0100, (IntPtr)0x0D, IntPtr.Zero);  // WM_KEYDOWN VK_RETURN
			SendMsgInt(dlg, 0x0101, (IntPtr)0x0D, IntPtr.Zero);  // WM_KEYUP
			via += "+enter";
			closed = WaitGone(dlg, 1200);
		}
		if (!closed) {
			// IDOK 命令：等价于用户确认，部分自绘宿主只认这个
			SendMsgInt(dlg, 0x0111, (IntPtr)1, btn);
			via += "+idok";
			closed = WaitGone(dlg, 1200);
		}
		return "written=" + readBack + " closed=" + (closed ? "1" : "0") + " via=" + via;
	}

	static bool WaitGone(IntPtr h, int ms) {
		int waited = 0;
		while (waited < ms) {
			if (!IsWindow(h)) return true;
			System.Threading.Thread.Sleep(60);
			waited += 60;
		}
		return !IsWindow(h);
	}
	[DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);

	const uint WM_SETTEXT = 0x000C, WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E, BM_CLICK = 0x00F5;

	/** 控件的真实 Win32 类名（UIA 的类型不可靠，见上面注释） */
	public static string WinClassOf(IntPtr h) {
		var sb = new System.Text.StringBuilder(256);
		GetClassNameW(h, sb, 256);
		return sb.ToString();
	}

	public static string WmGetText(IntPtr h) {
		int len = (int)SendMsgInt(h, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
		if (len <= 0) return "";
		var sb = new System.Text.StringBuilder(len + 2);
		SendMsgBuf(h, WM_GETTEXT, (IntPtr)(len + 1), sb);
		return sb.ToString();
	}

	public static void WmClick(IntPtr h) { SendMsgInt(h, BM_CLICK, IntPtr.Zero, IntPtr.Zero); }

	/**
	 * 在对话框里找文件名输入框的**真实 Edit 句柄**。
	 * 新版对话框是 ComboBoxEx32(1148) → ComboBox → Edit 三层；旧版可能直接是
	 * Edit(1152) 或 ComboBox。逐层探测，返回第一个拿到文本的 Edit。
	 */
	public static IntPtr FileNameEdit(IntPtr dlg) {
		// 挂住的对话框一律当作「没有文件名框」：继续往下调会阻塞宿主。上层看到的就是
		// 「读不到」，而不是整个插件卡住。
		if (dlg == IntPtr.Zero || !IsWindow(dlg) || IsHungAppWindow(dlg)) return IntPtr.Zero;
		foreach (int id in new int[] { 1148, 1152, 1001 }) {
			IntPtr h = GetDlgItem(dlg, id);
			if (h == IntPtr.Zero) continue;
			string cls = WinClassOf(h);
			if (cls == "Edit") return h;
			// ComboBoxEx32 / ComboBox：往下剥一层到真正的 Edit
			IntPtr inner = FindWindowExW(h, IntPtr.Zero, "Edit", null);
			if (inner == IntPtr.Zero) {
				IntPtr combo = FindWindowExW(h, IntPtr.Zero, "ComboBox", null);
				if (combo == IntPtr.Zero && cls == "ComboBox") combo = h;
				if (combo != IntPtr.Zero) inner = FindWindowExW(combo, IntPtr.Zero, "Edit", null);
			}
			if (inner != IntPtr.Zero && WinClassOf(inner) == "Edit") return inner;
		}
		return IntPtr.Zero;
	}

	// ---------------- Win32 控件直读（补 UIA 的信息丢失） ----------------
	//
	// UIA 对**经典 Win32 控件**（Edit / Button / ComboBox / Static / SysListView32 …）
	// 的信息是不完整的：同一个控件用 FromPoint 或 FindAll 拿到的 ControlType 可能只是
	// 匿名 Pane，Name 为空、也没有 ValuePattern / InvokePattern。
	// 实测一个标准 #32770 文件对话框：34 个 Win32 子窗口里 17 个在 UIA 侧是空壳 Pane，
	// 而 Win32 侧明明是 Edit(文件名框) / Button(打开、取消) / Static(标签)。
	// 这不只影响文件对话框：消息框、打印框、属性页、MFC/VB6 写的界面都中招。
	//
	// 所以感知层补一次 Win32 读：把真实类名/文本/可用状态合进元素表。
	// 这不是给某个框开特例，而是把「UIA 看不见的东西」按 Win32 的事实补齐。
	[DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);

	/** Win32 窗口类名 → 元素类型名。只映射有语义的类，其余保持原类名便于诊断。 */
	public static string TypeOfClass(string cls) {
		switch (cls) {
			case "Button": return "Button";
			case "Edit": return "Edit";
			case "ComboBox": return "ComboBox";
			case "ComboBoxEx32": return "ComboBox";
			case "SysListView32": return "List";
			case "SysTreeView32": return "Tree";
			case "SysTabControl32": return "Tab";
			case "msctls_trackbar32": return "Slider";
			case "msctls_updown32": return "Spinner";
			case "msctls_progress32": return "ProgressBar";
			case "ScrollBar": return "ScrollBar";
			case "RichEdit20W": case "RICHEDIT50W": return "Document";
			case "Static": return "Text";
			case "SysHeader32": return "Header";
			case "ToolbarWindow32": return "ToolBar";
			case "msctls_statusbar32": return "StatusBar";
			case "SysLink": return "Hyperlink";
			default: return cls;
		}
	}

	/** 这些类名是人会操作的控件（Static 之类只提供文字，标 interactive=false） */
	public static bool InteractiveClass(string cls) {
		switch (cls) {
			case "Button": case "Edit": case "ComboBox": case "ComboBoxEx32":
			case "SysListView32": case "SysTreeView32": case "SysTabControl32":
			case "msctls_trackbar32": case "msctls_updown32": case "RichEdit20W":
			case "RICHEDIT50W": case "SysLink": case "ScrollBar":
				return true;
			default: return false;
		}
	}

	/**
	 * 枚举某个窗口的全部可见 Win32 子窗口。
	 * 返回 "hwnd|cls|textB64|x,y,w,h|enabled|interactive" 行，由 PowerShell 侧组装。
	 */
	public static string[] ChildControls(IntPtr root) {
		var list = new List<string>();
		EnumChildWindows(root, delegate(IntPtr h, IntPtr l) {
			if (!IsWindowVisible(h)) return true;
			var c = new System.Text.StringBuilder(128);
			GetClassNameW(h, c, 128);
			string cls = c.ToString();
			// 只收有语义的类和真正带文字的 Static，避免元素表被布局容器淹没
			var t = new System.Text.StringBuilder(512);
			GetWindowTextW(h, t, 512);
			string text = t.ToString();
			RECTR r;
			GetWindowRect(h, out r);
			if (r.R - r.L < 2 || r.B - r.T < 2) return true;  // 尺寸为 0 的分隔条之类
			bool known = InteractiveClass(cls) || cls == "Static" || cls == "SysHeader32"
				|| cls == "ToolbarWindow32" || cls == "msctls_progress32" || cls == "msctls_statusbar32";
			if (!known) return true;
			string textB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(text));
			list.Add(h.ToInt64() + "|" + cls + "|" + textB64 + "|" + r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T)
				+ "|" + (IsWindowEnabled(h) ? "1" : "0") + "|" + (InteractiveClass(cls) ? "1" : "0"));
			return true;
		}, IntPtr.Zero);
		return list.ToArray();
	}

	/**
	 * 对话框按钮的句柄（id 1 = 打开/保存，id 2 = 取消）。
	 *
	 * GetDlgItem 对「已经挂住（未响应）」的窗口会**跨进程阻塞**，一次调用就能把常驻宿主
	 * 卡死几十秒——表现为插件整体卡住、后续请求全部超时。所以先排除挂住的窗口：
	 * 挂住就是没响应，任何消息都不该发，返回「取不到」比拖死调用方好。
	 *
	 * 只按 ID 取、不校验类名：ID 1/2 是 Win32 对话框的固定约定，而类名在 WebView /
	 * 自绘宿主上不一定是 Button（实测同一台机器上标准对话框是 Button）。
	 */
	public static IntPtr DialogButton(IntPtr dlg, int id) {
		if (dlg == IntPtr.Zero || !IsWindow(dlg) || IsHungAppWindow(dlg)) return IntPtr.Zero;
		return GetDlgItem(dlg, id);
	}

	// ---------------- 抓屏灰度网格（动作前后差分用） ----------------
	// 为什么把差分采样搬到宿主：原来每条验证链路是
	//   抓屏存 PNG(~200ms) → Node 用 pngjs 解码(~150ms) → JS 逐块采样
	// 而差分只需要"每块平均亮度"。改为抓屏后在内存位图上直接算块网格（实测 8ms），
	// 把 PNG 存盘与解码整个省掉；需要给用户看图的感知路径（cu_elements）才存 PNG。
	//
	// 算法与 Node 侧 verify.ts 严格一致：32px 块、每块均匀采样 4×4 点、BT.601 亮度。
	// 两边都是"平均后比阈值"，任何一侧改了另一边必须跟着改。
	public static float[] GridFromBitmap(System.Drawing.Bitmap bmp, int block) {
		int cols = (bmp.Width + block - 1) / block;
		int rows = (bmp.Height + block - 1) / block;
		var res = new float[cols * rows];
		var data = bmp.LockBits(new System.Drawing.Rectangle(0, 0, bmp.Width, bmp.Height),
			System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
		try {
			int stride = data.Stride;
			byte[] buf = new byte[stride * bmp.Height];
			Marshal.Copy(data.Scan0, buf, 0, buf.Length);
			for (int by = 0; by < rows; by++) {
				int y0 = by * block, y1 = Math.Min(bmp.Height, y0 + block);
				int stepY = Math.Max(1, (y1 - y0) / 4);
				for (int bx = 0; bx < cols; bx++) {
					int x0 = bx * block, x1 = Math.Min(bmp.Width, x0 + block);
					int stepX = Math.Max(1, (x1 - x0) / 4);
					long sum = 0; int n = 0;
					for (int y = y0; y < y1; y += stepY) {
						int off = y * stride;
						for (int x = x0; x < x1; x += stepX) {
							int i = off + x * 3;
							sum += (long)Math.Round(buf[i + 2] * 0.299 + buf[i + 1] * 0.587 + buf[i] * 0.114);
							n++;
						}
					}
					res[by * cols + bx] = n > 0 ? (float)sum / n : 0f;
				}
			}
		} finally { bmp.UnlockBits(data); }
		return res;
	}

	// ---------------- 剪贴板（P/Invoke，写入 7ms / 读取 2.5ms） ----------------
	// 为什么不用 clip.exe / Get-Clipboard：两者都是独立进程，实测 Get-Clipboard 965ms/次、
	// clip.exe 37ms/次。而"剪贴板 + Ctrl+V"恰恰是中文路径输入的主通道（中文路径走
	// SendInput 会被 IME 打乱，"承诺书C:\..." 这种），每输一次都要先备份、再还原。
	[DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
	[DllImport("user32.dll")] static extern bool CloseClipboard();
	[DllImport("user32.dll")] static extern bool EmptyClipboard();
	[DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint fmt);
	[DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint fmt, IntPtr mem);
	[DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint fmt);
	[DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
	[DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
	[DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
	const uint CF_UNICODETEXT = 13;
	const uint GMEM_MOVEABLE = 0x0002;

	// 剪贴板是全局独占资源：别的进程占用时 OpenClipboard 会直接失败，稍等重试即可
	public static string ClipGet() {
		if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return "";
		for (int i = 0; i < 6; i++) {
			if (!OpenClipboard(IntPtr.Zero)) { System.Threading.Thread.Sleep(15); continue; }
			try {
				IntPtr h = GetClipboardData(CF_UNICODETEXT);
				if (h == IntPtr.Zero) return "";
				IntPtr p = GlobalLock(h);
				if (p == IntPtr.Zero) return "";
				try { return Marshal.PtrToStringUni(p); } finally { GlobalUnlock(h); }
			} finally { CloseClipboard(); }
		}
		return "";
	}

	public static bool ClipSet(string text) {
		byte[] buf = Encoding.Unicode.GetBytes((text ?? "") + "\0");
		for (int i = 0; i < 6; i++) {
			if (!OpenClipboard(IntPtr.Zero)) { System.Threading.Thread.Sleep(15); continue; }
			try {
				EmptyClipboard();
				IntPtr h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)buf.Length);
				if (h == IntPtr.Zero) return false;
				IntPtr p = GlobalLock(h);
				if (p == IntPtr.Zero) return false;
				try { Marshal.Copy(buf, 0, p, buf.Length); } finally { GlobalUnlock(h); }
				// SetClipboardData 成功后内存块归系统所有，不能自己释放
				return SetClipboardData(CF_UNICODETEXT, h) != IntPtr.Zero;
			} finally { CloseClipboard(); }
		}
		return false;
	}

	public static void TypeAscii(string s) {
		var seq = new List<INPUT>();
		foreach (char c in s) {
			var d = new INPUT(); d.type = IN_KEY; d.u.ki.wScan = c; d.u.ki.dwFlags = UNI;
			seq.Add(d);
			var u = new INPUT(); u.type = IN_KEY; u.u.ki.wScan = c; u.u.ki.dwFlags = UNI | KEYUP;
			seq.Add(u);
		}
		SendInput((uint)seq.Count, seq.ToArray(), Marshal.SizeOf(typeof(INPUT)));
	}

	public static void KeyChord(string[] keys) {
		var vks = new List<ushort>();
		foreach (var k in keys) { vks.Add(VkOf(k)); }
		var seq = new List<INPUT>();
		foreach (var vk in vks) {
			var a = new INPUT(); a.type = IN_KEY; a.u.ki.wVk = vk; seq.Add(a);
		}
		for (int i = vks.Count - 1; i >= 0; i--) {
			var a = new INPUT(); a.type = IN_KEY; a.u.ki.wVk = vks[i]; a.u.ki.dwFlags = KEYUP; seq.Add(a);
		}
		SendInput((uint)seq.Count, seq.ToArray(), Marshal.SizeOf(typeof(INPUT)));
	}

	static ushort VkOf(string name) {
		string n = name.ToLowerInvariant();
		if (n.Length == 1) {
			char c = char.ToUpperInvariant(n[0]);
			if (c >= 'A' && c <= 'Z') return (ushort)c;
			if (c >= '0' && c <= '9') return (ushort)c;
		}
		switch (n) {
			case "ctrl": case "control": return 0x11;
			case "shift": return 0x10;
			case "alt": return 0x12;
			case "win": case "meta": return 0x5B;
			case "enter": case "return": return 0x0D;
			case "esc": case "escape": return 0x1B;
			case "tab": return 0x09;
			case "space": return 0x20;
			case "backspace": return 0x08;
			case "delete": case "del": return 0x2E;
			case "insert": return 0x2D;
			case "home": return 0x24;
			case "end": return 0x23;
			case "pageup": return 0x21;
			case "pagedown": return 0x22;
			case "left": return 0x25;
			case "up": return 0x26;
			case "right": return 0x27;
			case "down": return 0x28;
			case "capslock": return 0x14;
			case "f1": return 0x70; case "f2": return 0x71; case "f3": return 0x72; case "f4": return 0x73;
			case "f5": return 0x74; case "f6": return 0x75; case "f7": return 0x76; case "f8": return 0x77;
			case "f9": return 0x78; case "f10": return 0x79; case "f11": return 0x7A; case "f12": return 0x7B;
			default: throw new ArgumentException("unknown key: " + name);
		}
	}
}
'@

# System.Drawing 要显式列进引用：Add-Type 在 -Language CSharp 下默认只带 System 等基础程序集
# （WinForms 是脚本侧 Add-Type -AssemblyName 装的，不自动进 C# 编译器的引用表）。
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Drawing } catch {
	[Console]::Out.WriteLine("@@CU@@" + (@{ ok = $false; fatal = "C# 编译失败：$($_.Exception.Message)" } | ConvertTo-Json -Compress))
	exit 1
}

$script:dpiMode = [CUHost]::InitDpi()
$script:vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
[CUHost]::InitBounds($script:vs.Width, $script:vs.Height)

function Emit($obj) {
	[Console]::Out.WriteLine("@@CU@@" + ($obj | ConvertTo-Json -Compress -Depth 12))
	[Console]::Out.Flush()
}

# 按控件类型判断是否可交互：UIA 的 IsControlElement 在 Chromium/WPF 里太宽（容器也报 true），
# 这里按类型白名单取"人真的会点的东西"。
$InteractiveTypes = @(
	'ControlType.Button', 'ControlType.Edit', 'ControlType.CheckBox', 'ControlType.RadioButton',
	'ControlType.ComboBox', 'ControlType.ListItem', 'ControlType.MenuItem', 'ControlType.TabItem',
	'ControlType.Hyperlink', 'ControlType.Slider', 'ControlType.Spinner', 'ControlType.TreeItem',
	'ControlType.DataItem', 'ControlType.Document', 'ControlType.SplitButton', 'ControlType.HeaderItem'
)

function GetFocusWindow {
	$el = [System.Windows.Automation.AutomationElement]::FocusedElement
	if ($null -eq $el) { return $null }
	$walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
	while ($null -ne $el -and $el.Current.ControlType.ProgrammaticName -ne 'ControlType.Window') {
		$el = $walk.GetParent($el)
	}
	return $el
}

# 元素树：深度/数量双上限，防止大型应用（VS Code、浏览器）把一次调用拖成几秒
function GetElements($root, $maxNodes, $maxDepth) {
	$out = New-Object System.Collections.ArrayList
	$stack = New-Object System.Collections.Stack
	$stack.Push(@{ el = $root; depth = 0 })
	$cond = [System.Windows.Automation.Condition]::TrueCondition
	while ($stack.Count -gt 0 -and $out.Count -lt $maxNodes) {
		$item = $stack.Pop()
		if ($item.depth -gt $maxDepth) { continue }
		$children = @()
		try { $children = $item.el.FindAll([System.Windows.Automation.TreeScope]::Children, $cond) } catch { continue }
		foreach ($c in $children) {
			if ($out.Count -ge $maxNodes) { break }
			$cur = $c.Current
			if (-not $cur.IsOffscreen) {
				$r = $cur.BoundingRectangle
				$typeName = $cur.ControlType.ProgrammaticName
				# 跳过全屏容器：它们框住整个窗口，作为候选框会把真正的元素全盖住
				if ($r.Width -gt 1 -and $r.Height -gt 1) {
					[void]$out.Add([pscustomobject]@{
						nameB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$cur.Name))
						type = ($typeName -replace 'ControlType\.', '')
						x = [int]$r.X; y = [int]$r.Y
						w = [int]$r.Width; h = [int]$r.Height
						enabled = [bool]$cur.IsEnabled
						interactive = [bool]($InteractiveTypes -contains $typeName)
					})
				}
			}
			$stack.Push(@{ el = $c; depth = $item.depth + 1 })
		}
	}
	return , $out
}

# 读 Win32 子控件（补 UIA 的空壳 Pane）并转成与 UIA 元素同形的条目。
# 为什么不并进 GetElements：UIA 给的是树、Win32 给的是扁平子窗口列表，两者坐标系一致
# （都是物理像素），只要按包围盒判重就能合并——重叠超过一半就认为是同一个控件，
# 保留 UIA 那条（它有 AutomationId、能走 pattern），用 Win32 的信息补类型/名字。
function GetWin32Controls($root) {
	$hwnd = [IntPtr]::Zero
	try { $hwnd = [IntPtr]$root.Current.NativeWindowHandle } catch { return , (New-Object System.Collections.ArrayList) }
	return , (GetWin32ControlsByHwnd $hwnd)
}

function GetWin32ControlsByHwnd($hwnd) {
	$out = New-Object System.Collections.ArrayList
	if ($hwnd -eq [IntPtr]::Zero) { return , $out }
	foreach ($line in [CUHost]::ChildControls($hwnd)) {
		$p = $line.Split('|')
		if ($p.Count -lt 6) { continue }
		$rp = $p[3].Split(',')
		if ($rp.Count -lt 4) { continue }
		$cls = $p[1]
		[void]$out.Add([pscustomobject]@{
			hwnd = $p[0]
			winClass = $cls
			nameB64 = $p[2]
			type = [CUHost]::TypeOfClass($cls)
			x = [int]$rp[0]; y = [int]$rp[1]; w = [int]$rp[2]; h = [int]$rp[3]
			enabled = ($p[4] -eq '1')
			interactive = ($p[5] -eq '1')
		})
	}
	return , $out
}

# 合并：UIA 条目优先保留；Win32 条目只在「未被 UIA 以有信息的形式覆盖」时补进来。
# 判据是重叠面积占比（Win32 子窗口与 UIA 元素的包围盒重叠 > 50% 视为同一控件）。
function MergeWin32Controls($uiaItems, $winItems) {
	$merged = New-Object System.Collections.ArrayList
	foreach ($it in $uiaItems) { [void]$merged.Add($it) }
	foreach ($w in $winItems) {
		$wa = [double]$w.w * $w.h
		$covered = $false
		foreach ($u in $merged) {
			$ix = [Math]::Max(0, [Math]::Min($w.x + $w.w, $u.x + $u.w) - [Math]::Max($w.x, $u.x))
			$iy = [Math]::Max(0, [Math]::Min($w.y + $w.h, $u.y + $u.h) - [Math]::Max($w.y, $u.y))
			$inter = [double]$ix * $iy
			if ($wa -le 0) { continue }
			if ($inter / $wa -gt 0.5) {
				# 同一控件：UIA 那条若名字/类型缺失，用 Win32 的事实补上
				if ([string]::IsNullOrEmpty($u.type) -or $u.type -eq 'Pane') {
					$u.type = $w.type
					if ([string]::IsNullOrEmpty($u.nameB64) -or $u.nameB64 -eq '') { $u.nameB64 = $w.nameB64 }
					$u.interactive = $w.interactive
				}
				$covered = $true
				break
			}
		}
		if (-not $covered) { [void]$merged.Add($w) }
	}
	return , $merged
}

# 在窗口的 Win32 子控件里找命中某点、面积最小的那个。
#
# 为什么需要：UIA 把经典 Win32 控件报成匿名 Pane，没有 InvokePattern，于是
# "点这个元素"只能落到真实鼠标——而真实鼠标要先有焦点，焦点又常被别的窗口抢走。
# Win32 子窗口的句柄是确定的，直接给它发消息既不需要焦点也不受遮挡影响。
function FindWin32ChildAt($hwnd, $x, $y) {
	$best = $null; $bestArea = [double]::MaxValue
	foreach ($c in (GetWin32ControlsByHwnd $hwnd)) {
		if ($x -lt $c.x -or $x -gt ($c.x + $c.w) -or $y -lt $c.y -or $y -gt ($c.y + $c.h)) { continue }
		$area = [double]$c.w * $c.h
		if ($area -lt $bestArea) { $bestArea = $area; $best = $c }
	}
	return $best
}

# 找到元素并执行 UIA 动作（不移动真实鼠标：能走 UIA 的优先走 UIA，不受窗口遮挡影响）
function InvokeOnElement($root, $x, $y, $action, $value) {
	$cond = [System.Windows.Automation.Condition]::TrueCondition
	$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
	$best = $null; $bestArea = [double]::MaxValue
	$bestHasPattern = $false
	foreach ($e in $all) {
		$r = $e.Current.BoundingRectangle
		if ($r.Width -le 0 -or $r.Height -le 0) { continue }
		if ($x -lt $r.X -or $x -gt ($r.X + $r.Width) -or $y -lt $r.Y -or $y -gt ($r.Y + $r.Height)) { continue }

		# 选元素不能只看面积：输入场景下，内层容器（Pane/Custom）常常比真正可写的
		# Document/Edit 更小，按面积选会挑中不支持 ValuePattern 的那层（实测记事本
		# 编辑区就是 Document 支持、内层 Pane 不支持）。所以 setvalue 时优先选
		# "能接受写入"的元素，其余动作仍按最具体（面积最小）来选。
		$hasPattern = $false
		if ($action -eq 'setvalue') {
			$vp = $null
			$hasPattern = $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)
		}
		$area = $r.Width * $r.Height
		$better = $false
		if ($hasPattern -and -not $bestHasPattern) { $better = $true }
		elseif ($hasPattern -eq $bestHasPattern -and $area -lt $bestArea) { $better = $true }
		if ($better) { $bestArea = $area; $best = $e; $bestHasPattern = $hasPattern }
	}
	if ($null -eq $best) { return @{ ok = $false; error = '该坐标下没有 UIA 元素' } }
	$name = $best.Current.Name
	$typeName = $best.Current.ControlType.ProgrammaticName

	if ($action -eq 'setvalue') {
		$p = $null
		if (-not $best.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
			return @{ ok = $false; error = "$typeName 不支持 ValuePattern"; target = $name }
		}
		# 写入后必须读回校验：SetValue 不抛异常 ≠ 值真的进去了。
		# 实测 Edge 网页输入框：SetValue 静默成功、Current.Value 也能读出写入的值，
		# 但页面上输入框仍是空的——控件接受了写入却没反映到渲染层（Web 视图常见）。
		# 所以读回匹配只算“控件层面确认”，上层还要用抓屏差分做渲染层确认。
		try {
			$p.SetValue([string]$value)
		} catch {
			return @{ ok = $false; error = "SetValue 抛错：$($_.Exception.Message)"; target = $name; type = $typeName }
		}
		$readBack = ""
		try { $readBack = [string]$p.Current.Value } catch { }
		if ($readBack -ne [string]$value) {
			return @{
				ok = $false
				error = "控件未接受该值（读回不匹配）"
				target = $name; type = $typeName
				readBackLen = $readBack.Length
			}
		}
		return @{ ok = $true; via = 'uia-value'; target = $name; type = $typeName; verified = $true; readBackLen = $readBack.Length }
	}

	$p = $null
	if ($best.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
		$p.Invoke()
		return @{ ok = $true; via = 'uia-invoke'; target = $name; type = $typeName }
	}
	if ($best.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
		$p.Toggle()
		return @{ ok = $true; via = 'uia-toggle'; target = $name; type = $typeName }
	}
	if ($best.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
		$p.Select()
		return @{ ok = $true; via = 'uia-select'; target = $name; type = $typeName }
	}
	# UIA 侧没有可调用模式：经典 Win32 控件常被报成匿名 Pane（没有 InvokePattern），
	# 但它本身是真的 Button/Edit。按包围盒找到对应的 Win32 子窗口，直接发 BN_CLICKED
	# 语义的消息（BM_CLICK）——这条路不依赖焦点，被遮挡也成立。
	$rootHwnd = [IntPtr]::Zero
	try { $rootHwnd = [IntPtr]$root.Current.NativeWindowHandle } catch { }
	$winHit = FindWin32ChildAt $rootHwnd $x $y
	if ($null -ne $winHit) {
		if ($winHit.interactive) {
			[CUHost]::WmClick([IntPtr][long]$winHit.hwnd)
			return @{ ok = $true; via = 'win32-click'; target = $name; type = $winHit.type; winHwnd = $winHit.hwnd; winCls = $winHit.winClass }
		}
	}
	return @{ ok = $false; error = "$typeName 没有 UIA 可调用模式（需坐标点击）"; target = $name }
}

# ---------------------------------------------------------------------------
# 原生文件对话框（#32770）
#
# 为什么单独写一层：它是一类固定形状的系统 UI，却对 UIA 很不友好。实测（Win11、
# Firefox 触发的 IFileOpenDialog）：
#   - 对话框是 #32770，由**独立进程**承载（Explorer 的打开/保存宿主），
#     所以「同进程」不能当归属判据，用 owner 链 + owner 被禁用判模态。
#   - 文件名框的 Win32 类名是 Edit、按钮是 Button，但 UIA 把它们整棵报成
#     ControlType.Pane，ValuePattern / InvokePattern 全缺——按 UIA 找会一无所获，
#     这就是「原生对话框操作不了」的成因。
#   - 改成 Win32 消息后：GetDlgItem(1148) → 子窗口 Edit，WM_SETTEXT 写中文路径
#     48ms 且读回一致（不经过键盘，IME 无从干预），BM_CLICK 提交即关框。
#   - **对话框失去前台焦点时 UIA tree 会进一步退化**，同一次 FindAll 从 65 个降到
#     查不到控件；而 GetDlgItem 始终可用。所以识别与操作都必须走 Win32 侧。
# ---------------------------------------------------------------------------

# 判据：类名 #32770（或标题像文件框）且 GetDlgItem 能拿到文件名输入框。
# 不要求"能读到可写的 UIA 文件名框"——UIA 在这里本就不成立。
$DialogTitleRe = '打开|保存|选择|上传|浏览|Open|Save|Select|Upload|Browse'

# Win32 对话框按钮的资源 ID 约定：1 = 打开/保存，2 = 取消
$OpenButtonId = 1
$CancelButtonId = 2

# 点对话框按钮：按 Win32 资源 ID 取句柄，再 BM_CLICK。
# 不用 UIA：这类框的按钮在 UIA 侧是 Pane、没有 InvokePattern（见上方说明）。
function Click-DialogButton($dlg, $id) {
	$btn = [CUHost]::DialogButton($dlg, $id)
	if ($btn -eq [IntPtr]::Zero) { return $false }
	[CUHost]::WmClick($btn)
	return $true
}

function LooksLikeFileDialog($el) {
	$cls = $el.Current.ClassName
	# 类名不是 #32770 且标题也不像文件框时立刻返回：GetDlgItem 是跨进程调用，
	# 对每个顶层窗口都试一遍会卡住（Terminal/浏览器这类窗口上会阻塞数秒）。
	if ($cls -ne '#32770' -and [string]$el.Current.Name -notmatch $DialogTitleRe) { return $false }
	$hwnd = [IntPtr]$el.Current.NativeWindowHandle
	return ([CUHost]::FileNameEdit($hwnd) -ne [IntPtr]::Zero)
}

# 找「像文件对话框」的顶层窗口。模态的优先（它盖在最上面，是用户此刻应对的东西）。
function FindFileDialog($preferHwnd) {
	if ($preferHwnd -and $preferHwnd -ne '0') {
		$h = [IntPtr][long]$preferHwnd
		if ([CUHost]::IsWindow($h) -and [CUHost]::FileNameEdit($h) -ne [IntPtr]::Zero) {
			return @{ hwnd = $h; modal = [CUHost]::IsModal($h) }
		}
		return $null
	}
	$root = [System.Windows.Automation.AutomationElement]::RootElement
	$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
	$best = $null
	foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
		$ok = $false
		try { $ok = LooksLikeFileDialog $w } catch { $ok = $false }
		if (-not $ok) { continue }
		$hwnd = [IntPtr]$w.Current.NativeWindowHandle
		$modal = [CUHost]::IsModal($hwnd)
		if ($null -eq $best -or ($modal -and -not $best.modal)) { $best = @{ hwnd = $hwnd; modal = $modal } }
	}
	return $best
}

# 读对话框状态（列表/结果共用）
function DescribeDialog($hwnd) {
	$title = ""; $rect = @{ x = 0; y = 0; w = 0; h = 0 }
	try {
		$el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
		$title = [string]$el.Current.Name
		$r = $el.Current.BoundingRectangle
		$rect = @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
	} catch { }
	$edit = [CUHost]::FileNameEdit($hwnd)
	$cur = if ($edit -ne [IntPtr]::Zero) { [CUHost]::WmGetText($edit) } else { "" }
	return @{
		hwnd = ([string]$hwnd.ToInt64())
		titleB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($title))
		modal = [CUHost]::IsModal($hwnd)
		foreground = ([CUHost]::GetForegroundWindow() -eq $hwnd)
		fileName = $cur
		rect = $rect
	}
}

while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line) { break }
	if ($line.Trim() -eq '') { continue }
	$sw = [Diagnostics.Stopwatch]::StartNew()
	try {
		$req = $line | ConvertFrom-Json
		switch ($req.op) {
			'windows' {
				# 列出可见顶层窗口，供 AI 在焦点位于 pi 时明确选择目标
				$raw = [CUHost]::ListWindows()
				$list = @()
				$skipped = 0
				foreach ($ln in ($raw -split "`n")) {
					if ([string]::IsNullOrWhiteSpace($ln)) { continue }
					# 单条记录解析失败只跳过它，不能让整个 windows 操作失败
					# （之前一条坏记录会让 cu_windows 直接返回"未给出原因"）
					try {
						$parts = $ln.Split([char]1)
						if ($parts.Count -lt 5) { $skipped++; continue }
						$rp = $parts[4].Split(',')
						if ($rp.Count -lt 4) { $skipped++; continue }
						$list += @{
							hwnd = $parts[0]
							pid = [int]$parts[1]
							proc = $parts[2]
							titleB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$parts[3]))
							rect = @{ x = [int]$rp[0]; y = [int]$rp[1]; w = [int]$rp[2]; h = [int]$rp[3] }
							# 以下三个字段是「原生对话框」识别依据（旧版只回前五个字段）
							cls = if ($parts.Count -ge 6) { [string]$parts[5] } else { "" }
							owner = if ($parts.Count -ge 7) { [string]$parts[6] } else { "0" }
							modal = if ($parts.Count -ge 8) { $parts[7] -eq '1' } else { $false }
						}
					} catch { $skipped++ }
				}
				Emit @{ ok = $true; windows = $list; count = $list.Count; skipped = $skipped; ms = $sw.ElapsedMilliseconds }
			}
			'activate' {
				# 把指定 hwnd 切回前台：pi 的问卷/确认框总会抢焦点，动作前需要主动归还
				$hwnd = [IntPtr][long]$req.hwnd
				$ok = [CUHost]::Activate($hwnd)
				Start-Sleep -Milliseconds 60
				$now = [CUHost]::GetForegroundWindow()
				Emit @{ ok = $ok; reached = ($now -eq $hwnd); foreground = $now.ToInt64(); ms = $sw.ElapsedMilliseconds }
			}
			'focus' {
				$f = [CUHost]::FocusFields().Split([char]1)
				$rectParts = $f[3].Split(',')
				# 窗口标题常含中文/emoji。经 stdout 传普通字符串会被控制台代码页破坏成 U+FFFD，
				# 用 Base64 传字节、由 Node 侧解码——实测这样才无损。
				$titleB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$f[2]))
				$fh = [IntPtr][long]$f[0]
				Emit @{
					ok = $true; hwnd = $f[0]; proc = $f[1]; titleB64 = $titleB64; cls = $f[4]
					rect = @{ x = [int]$rectParts[0]; y = [int]$rectParts[1]; w = [int]$rectParts[2]; h = [int]$rectParts[3] }
					modal = [CUHost]::IsModal($fh); owner = ([string]([CUHost]::OwnerOf($fh).ToInt64()))
					ms = $sw.ElapsedMilliseconds
				}
			}
			'ping' {
				Emit @{ ok = $true; dpi = $script:dpiMode; ms = $sw.ElapsedMilliseconds }
			}
			'bounds' {
				Emit @{ ok = $true; x = $script:vs.X; y = $script:vs.Y; w = $script:vs.Width; h = $script:vs.Height; dpi = $script:dpiMode }
			}
			'capture' {
				# path 省略 = 只要灰度网格（动作前后差分用，不落盘）；
				# 给了 path 才存 PNG（感知路径要交给模型看图）。两件事分开的理由见 GridFromBitmap。
				$bmp = New-Object System.Drawing.Bitmap($script:vs.Width, $script:vs.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
				$g = [System.Drawing.Graphics]::FromImage($bmp)
				$g.CopyFromScreen($script:vs.Left, $script:vs.Top, 0, 0, $bmp.Size)
				$g.Dispose()
				$tCap = $sw.ElapsedMilliseconds
				$grid = [CUHost]::GridFromBitmap($bmp, 32)
				$tGrid = $sw.ElapsedMilliseconds
				if ($req.path) { $bmp.Save($req.path, [System.Drawing.Imaging.ImageFormat]::Png) }
				$tAll = $sw.ElapsedMilliseconds
				$bmp.Dispose()
				Emit @{ ok = $true; path = $req.path; w = $script:vs.Width; h = $script:vs.Height; cap = $tCap; gridMs = ($tGrid - $tCap); cols = [int][math]::Ceiling($script:vs.Width / 32); grid = $grid; ms = $tAll }
			}
			'uia' {
				$win = GetFocusWindow
				if ($null -eq $win) { Emit @{ ok = $false; error = '没有焦点窗口' }; break }
				$maxNodes = if ($req.maxNodes) { [int]$req.maxNodes } else { 400 }
				$maxDepth = if ($req.maxDepth) { [int]$req.maxDepth } else { 24 }
				$items = GetElements $win $maxNodes $maxDepth
				# 补 UIA 看不见的经典 Win32 控件（详见 C# 侧 ChildControls 的说明）
				$winItems = GetWin32Controls $win
				$uiaCount = $items.Count
				$items = MergeWin32Controls $items $winItems
				$w = $win.Current
				Emit @{
					ok = $true; titleB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$w.Name)); cls = $w.ClassName
					proc = $w.ProcessId; uiaCount = $uiaCount; win32Count = $winItems.Count
					rect = @{ x = [int]$win.Current.BoundingRectangle.X; y = [int]$win.Current.BoundingRectangle.Y; w = [int]$win.Current.BoundingRectangle.Width; h = [int]$win.Current.BoundingRectangle.Height }
					count = $items.Count; items = $items; ms = $sw.ElapsedMilliseconds
				}
			}
			'uiaat' {
				# 按 hwnd 读控件树。与 'uia' 的区别：后者只能读「当前焦点窗口」，
				# 而原生文件对话框弹出时焦点可能已被 pi 抢走，靠焦点定位会读到错的窗口。
				# 只读四个属性：Name / ControlType / BoundingRectangle / IsOffscreen。
				# 实测 Firefox 657 节点：读 5 个属性 424ms、4 个 348ms、3 个 273ms，
				# IsEnabled 前端没人用（元素表只标「只读」，判据是 interactive），去掉即省 76ms。
				$h = [IntPtr][long]$req.hwnd
				if ($h -eq [IntPtr]::Zero -or -not [CUHost]::IsWindow($h)) { Emit @{ ok = $false; error = '该窗口已不存在' }; break }
				$el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
				if ($null -eq $el) { Emit @{ ok = $false; error = '无法获取该窗口的 UIA 元素' }; break }
				$maxNodes = if ($req.maxNodes) { [int]$req.maxNodes } else { 400 }
				$maxDepth = if ($req.maxDepth) { [int]$req.maxDepth } else { 24 }
				$items = GetElements $el $maxNodes $maxDepth
				$winItems = GetWin32Controls $el
				$uiaCount = $items.Count
				$items = MergeWin32Controls $items $winItems
				$wr = $el.Current.BoundingRectangle
				Emit @{
					ok = $true; hwnd = [string]$req.hwnd; uiaCount = $uiaCount; win32Count = $winItems.Count
					titleB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$el.Current.Name))
					cls = $el.Current.ClassName; proc = $el.Current.ProcessId
					rect = @{ x = [int]$wr.X; y = [int]$wr.Y; w = [int]$wr.Width; h = [int]$wr.Height }
					count = $items.Count; items = $items; ms = $sw.ElapsedMilliseconds
				}
			}
			'move' {
				[CUHost]::MoveTo([int]$req.x, [int]$req.y, $script:vs.X, $script:vs.Y)
				Emit @{ ok = $true; x = [int]$req.x; y = [int]$req.y; ms = $sw.ElapsedMilliseconds }
			}
			'click' {
				$count = if ($req.count) { [int]$req.count } else { 1 }
				$btn = if ($req.button) { [string]$req.button } else { 'left' }
				$via = 'mouse'
				$detail = $null
				# 坐标点击先问 UIA：能 Invoke 就不动真实鼠标，窗口被遮挡时也成立
				if ($req.preferUia -ne $false) {
					$win = GetFocusWindow
					if ($null -ne $win) {
						$r = InvokeOnElement $win ([int]$req.x) ([int]$req.y) 'click' $null
						if ($r.ok) { $via = $r.via; $detail = $r }
					}
				}
				if ($null -eq $detail) {
					[CUHost]::ClickAt([int]$req.x, [int]$req.y, $script:vs.X, $script:vs.Y, $btn, $count)
				}
				Emit @{ ok = $true; via = $via; x = [int]$req.x; y = [int]$req.y; detail = $detail; ms = $sw.ElapsedMilliseconds }
			}
			'drag' {
				[CUHost]::DragFromTo([int]$req.fromX, [int]$req.fromY, [int]$req.toX, [int]$req.toY, $script:vs.X, $script:vs.Y)
				Emit @{ ok = $true; ms = $sw.ElapsedMilliseconds }
			}
			'scroll' {
				if ($req.x -ne $null) { [CUHost]::MoveTo([int]$req.x, [int]$req.y, $script:vs.X, $script:vs.Y) }
				[CUHost]::Wheel([int]$req.amount)
				Emit @{ ok = $true; amount = [int]$req.amount; ms = $sw.ElapsedMilliseconds }
			}
			'type' {
				[CUHost]::TypeAscii([string]$req.text)
				Emit @{ ok = $true; len = ([string]$req.text).Length; ms = $sw.ElapsedMilliseconds }
			}
			'key' {
				[CUHost]::KeyChord([string[]]$req.keys)
				Emit @{ ok = $true; keys = $req.keys; ms = $sw.ElapsedMilliseconds }
			}
			'setvalue' {
				$win = GetFocusWindow
				if ($null -eq $win) { Emit @{ ok = $false; error = '没有焦点窗口' }; break }
				$r = InvokeOnElement $win ([int]$req.x) ([int]$req.y) 'setvalue' ([string]$req.value)
				$r.ms = $sw.ElapsedMilliseconds
				Emit $r
			}
			'dialogs' {
				# 单独列原生文件对话框：它们是流程卡住的现场，混在窗口清单里
				# 要 AI 自己从 30 个窗口里认出「哪个是刚弹出来的框」。
				$list = @()
				$root = [System.Windows.Automation.AutomationElement]::RootElement
				$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
				foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
					$ok = $false
					try { $ok = LooksLikeFileDialog $w } catch { $ok = $false }
					if (-not $ok) { continue }
					$list += (DescribeDialog ([IntPtr]$w.Current.NativeWindowHandle))
				}
				Emit @{ ok = $true; dialogs = $list; count = $list.Count; ms = $sw.ElapsedMilliseconds }
			}
			'dialog' {
				# 一步完成「把文件路径交给原生文件对话框」：定位 → 写路径 → 提交 → 确认关框。
				#
				# 顺序与"重试"都要克制——实测这个框对反复切焦点很敏感：
				# 只 Activate 一次（不要求成功，失败也照常继续），写完路径立刻 BM_CLICK，
				# 成功率最高。之前版本在提交前后反复 Activate、还轮询按钮可用性，
				# 反而表现为"点了但框不关"（而同一个框用单次 Activate 一次点就关）。
				$found = FindFileDialog ([string]$req.hwnd)
				if ($null -eq $found) {
					Emit @{ ok = $false; error = '没有找到原生文件对话框（可能还没弹出来、已被关闭，或目标不是文件对话框）' }
					break
				}
				$h = $found.hwnd
				$steps = @()
				# 不主动切焦点：实测对这个框切焦点反而干扰后续提交（用户自己点开它时它已经在前台）。
				# 只有在它确实不是前台时才尝试一次，且不重试。
				if ([CUHost]::GetForegroundWindow() -ne $h) {
					$null = [CUHost]::Activate($h)
					Start-Sleep -Milliseconds 120
					$steps += "切回对话框前台"
				}

				$edit = [CUHost]::FileNameEdit($h)
				if ($edit -eq [IntPtr]::Zero) { Emit @{ ok = $false; error = '对话框里找不到文件名输入框'; hwnd = ([string]$h.ToInt64()); steps = $steps }; break }
				$steps += "定位到文件名框"

				if ($req.action -eq 'cancel') {
					if (-not (Click-DialogButton $h $CancelButtonId)) { Emit @{ ok = $false; error = '找不到「取消」按钮'; steps = $steps }; break }
					Emit @{ ok = $true; hwnd = ([string]$h.ToInt64()); action = 'cancel'; steps = $steps; ms = $sw.ElapsedMilliseconds }
					break
				}

				$path = [string]$req.path
				$closed = $false
				$via = ""
				if ($path) {
					# 路径可能在上游被转义破坏（\t、\n 这类序列被当转义符吃掉），
					# 写进框里对话框不认，表现为"点了打开但框不关"。
					$path = $path -replace '/', [char]92
					if ($path -match '[\x00-\x1F]') {
						Emit @{ ok = $false; hwnd = ([string]$h.ToInt64()); error = '路径含控制字符，几乎肯定是转义把反斜杠吃掉了；请用正斜杠重传，如 C:/dir/file.pdf'; steps = $steps }
						break
					}
					if (-not (Test-Path -LiteralPath $path)) {
						Emit @{ ok = $false; hwnd = ([string]$h.ToInt64()); error = "文件不存在：$path"; steps = $steps }
						break
					}
				}
				# 填值+提交整段交给 C#：这段对时序敏感（写完要等对话框消化路径，
				# 主按钮才会从 disabled 切回 enabled），步骤拆在 PowerShell 里会引入
				# 额外调度，实测同样的操作就"点了不关框"。
				$res = [CUHost]::FillAndSubmit($h, $edit, $path, ($req.submit -ne $false))
				$steps += $res
				$closed = $res -match 'closed=1'
				$via = if ($res -match 'via=([^ ]+)') { $Matches[1] } else { "" }
				Emit @{
					ok = ($res -notmatch '^(error|readback-mismatch)')
					hwnd = ([string]$h.ToInt64()); closed = $closed; via = $via; steps = $steps
					error = $(if ($res -match '^(error|readback-mismatch)=(.+)$') { $Matches[2] } else { $null })
					fileName = $(if ([CUHost]::IsWindow($h)) { [CUHost]::WmGetText($edit) } else { "" })
					ms = $sw.ElapsedMilliseconds
				}
			}
			'clipget' {
				Emit @{ ok = $true; textB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([CUHost]::ClipGet())); ms = $sw.ElapsedMilliseconds }
			}
			'clipset' {
				$okc = [CUHost]::ClipSet([string]$req.text)
				Emit @{ ok = $okc; error = $(if ($okc) { $null } else { '写剪贴板失败（被其他进程占用）' }); ms = $sw.ElapsedMilliseconds }
			}
			'exit' { Emit @{ ok = $true }; break }
			default { Emit @{ ok = $false; error = "未知操作：$($req.op)" } }
		}
	} catch {
		Emit @{ ok = $false; error = $_.Exception.Message }
	}
}
