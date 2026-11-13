/**
 * computer-use/typing：文本输入的三级通道
 *
 * 为什么不能直接用 SendInput 发 Unicode：**中文 IME 会拦截并组合**。
 * 实测往记事本发 "CU type test 123"，得到的是 "CU 3333...3333"——字母走后门进了，
 * 数字被 IME 当候选键吃掉。这不是 SendInput 的 bug，是中英文输入法的正常行为：
 * 它拦截键盘消息并在组合窗口里处理。任何"发字符"的方案都会撞上同一堵墙。
 *
 * 所以按可靠性降级，能走上面的绝不走下面的：
 *
 * 1. **UIA ValuePattern.SetValue**（最可靠）：直接把值写进控件，不经过键盘、不经过输入法、
 *    不需要窗口有焦点。Edit/ComboBox 一般都支持。缺点是只对支持 ValuePattern 的控件有效，
 *    而且有些控件（如记事本的 Edit）SetValue 后光标位置不跟随。
 * 2. **剪贴板 + Ctrl+V**（通用）：先把文本写进剪贴板，再发 Ctrl+V。剪贴板内容是既成事实，
 *    IME 无从干预。Web 编辑器、Electron 应用、富文本框都吃这条。要处理好三件事：
 *    备份用户原有剪贴板（读完就还回去，不吞用户的东西）、粘贴后等一会儿再还、
 *    发 Ctrl+V 之前确保目标窗口在前台。
 * 3. **SendInput 逐字符**（兜底）：只在纯 ASCII 且上面两条都不通时用。非 ASCII 字符
 *    在这条路上基本必坏，所以此时宁可报错让模型换手段，也不假装成功。
 *
 * 每一级都返回 via，让模型知道实际走了哪条路——输入没生效时这是排错的第一个线索。
 */
import type { Platform } from "./platform/types";

/** 逐级尝试的输入结果 */
export interface TypeOutcome {
	/** uia-value / clipboard / sendinput */
	via: string;
	/** 走 UIA 时命中的控件名 */
	target?: string;
	/** 说明为什么降级了（每级失败一行，便于排查） */
	notes: string[];
}

/** 纯 ASCII 判定：非 ASCII 走 SendInput 基本必坏（IME），只在没有别的办法时才试 */
function isAscii(s: string): boolean {
	return /^[\x20-\x7E\r\n\t]*$/.test(s);
}

/**
 * 把文本输入到某个坐标所在的控件。
 *
 * @param at 目标坐标（通常是元素中心）。给了它才能走 UIA SetValue；
 *   不给则跳过第 1 级，直接走剪贴板/键盘（相当于"往当前焦点打字"）。
 */
export async function typeText(
	platform: Platform,
	text: string,
	at?: { x: number; y: number },
	opts?: {
		/**
		 * 渲染层确认：UIA 写入后调用，返回画面是否真的变了。
		 *
		 * 必须有的理由：实测 Edge 的输入框 ValuePattern 会静默接受写入
		 * （连 Current.Value 都读得到新值），但页面上输入框仍是空的。
		 * 只信控件读回会把"假成功"报给 AI，它接着按回车就落在空框上。
		 * 由调用方注入是因为截图属于平台层能力，typing 不该自己抓屏。
		 */
		confirmRender?: () => Promise<boolean>;
	},
): Promise<TypeOutcome> {
	const notes: string[] = [];

	// 1) UIA 直接设值
	if (at) {
		try {
			const r = await platform.setValue(at.x, at.y, text);
			// 宿主已做过"写入后读回值"的校验（SetValue 不抛异常不等于值进去了）。
			// 但读回匹配只证明控件层接受了值——Edge 这类 Web 视图会静默接受却不渲染，
			// 页面上输入框仍是空的（实测）。所以这里再做一次渲染层确认：
			// 写之前与写之后各截一张目标区域，画面没变就认为没真正落进去，继续降级。
			if (opts?.confirmRender) {
				const changed = await opts.confirmRender();
				if (changed === false) {
					notes.push("UIA 设值：控件已接受但画面无变化（可能未真正写入），改用剪贴板");
				} else {
					return { via: r.via, target: r.target, notes };
				}
			} else {
				return { via: r.via, target: r.target, notes };
			}
		} catch (e) {
			notes.push(`UIA 设值失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 2) 剪贴板 + Ctrl+V
	if (platform.setClipboard) {
		try {
			const backup = await readClipboardSafe(platform);
			await platform.setClipboard(text);
			await platform.key(["ctrl", "v"]);
			// 粘贴是异步的（目标应用要读剪贴板），立即还原会把内容撤走
			await new Promise((r) => setTimeout(r, 220));
			// 还原用户原有内容：只在原来有内容时还，空剪贴板就留着我们写的（免得再花一次写入）
			if (backup !== null && backup !== text) await platform.setClipboard(backup);
			return { via: "clipboard", notes };
		} catch (e) {
			notes.push(`剪贴板粘贴失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 3) 逐字符发送（仅 ASCII）
	if (isAscii(text)) {
		try {
			await platform.typeAscii(text);
			return { via: "sendinput", notes };
		} catch (e) {
			notes.push(`键盘输入失败：${e instanceof Error ? e.message : String(e)}`);
		}
	} else {
		notes.push("文本含非 ASCII 字符，键盘通道在中文输入法下必然出错，已跳过");
	}

	throw new Error(`文本输入失败：${notes.join("；")}`);
}
/**
 * 读剪贴板用于备份。
 *
 * 必须走平台层的 P/Invoke（宿主内 2.5ms）。早期实现每次起一个
 * `powershell -Command Get-Clipboard` 子进程，实测 965ms/次——而这条通道
 * （剪贴板 + Ctrl+V）正是含中文时唯一可靠的输入路径，等于每输一次文本卡一秒。
 *
 * 读失败不算错：最坏情况是把用户剪贴板内容换成我们写的文本，
 * 为这个让整个输入流程失败不值得。
 */
async function readClipboardSafe(platform: Platform): Promise<string | null> {
	if (!platform.getClipboard) return null;
	try {
		return await platform.getClipboard();
	} catch {
		return null;
	}
}