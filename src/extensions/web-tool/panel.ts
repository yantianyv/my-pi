/**
 * web-tool/panel：/web-tool-config 设置面板（web-tool 多文件扩展的组成部分）
 *
 * 职责：
 * - ProxyConfigOverlay：代理地址输入（Enter 保存 / Esc 取消 / 清空回车 = 清除代理）
 *   + 搜索差评列表管理（↑↓/Tab 切换焦点、列表焦点 d/Backspace 删选中项、Delete 清空全部）
 * - 手写输入框（与 ModelSelectOverlay 同款：水平滚动 + 光标反显），非法地址回车不关闭面板
 *
 * 注意：本模块不注册任何 pi API，仅导出组件类，由入口（/web-tool-config 命令）实例化。
 */
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderInputWithCursor } from "../shared/ui";
import { loadDislikeData, saveDislikeData, DISLIKE_DECAY, DISLIKE_BAN_THRESHOLD } from "./dislike";
import { validateProxy } from "./http";

/** 返回文本显示宽度达到 targetW 时的字符索引（输入框水平滚动窗口定位用） */
function charIndexAtWidth(text: string, targetW: number): number {
	let w = 0;
	for (let i = 0; i < text.length; i++) {
		const chW = visibleWidth(text[i]!);
		if (w + chW > targetW) return i;
		w += chW;
	}
	return text.length;
}

/** 从 startChar 起按显示宽度截取最多 maxW 宽的文本（不截断字符） */
function sliceByWidth(text: string, startChar: number, maxW: number): string {
	let out = "";
	let w = 0;
	for (let i = startChar; i < text.length; i++) {
		const chW = visibleWidth(text[i]!);
		if (w + chW > maxW) break;
		out += text[i];
		w += chW;
	}
	return out;
}

/**
 * /web-tool-config 设置面板：输入代理地址（Enter 保存 / Esc 取消 / 清空回车 = 清除代理）。
 * 手写输入框（与 ModelSelectOverlay 同款：水平滚动 + 光标反显），非法地址回车时不关闭面板、提示修改。
 */
export class ProxyConfigOverlay {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private done: (result: string | null) => void;
	private value = "";
	private cursor = 0;
	private error = "";
	private statusMsg = ""; // 操作反馈（如「已删除差评：blog.csdn.net」）
	// 焦点模型：input = 代理输入框；dislike = 差评列表（↑↓ 选择、Delete 删除选中项）——Tab/方向键在两区自由切换
	private focus: "input" | "dislike" = "input";
	private selected = 0;

	constructor(tui: TUI, theme: Theme, current: string, done: (result: string | null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.value = current;
		this.cursor = current.length;
	}

	/** 差评键按次数降序（与面板显示一致，selected 索引基于此序） */
	private sortedDislikeKeys(data: Record<string, { count: number; reasons: string[] }>): string[] {
		return Object.keys(data).sort((a, b) => data[b]!.count - data[a]!.count);
	}

	handleInput(data: string): void {
		// Esc：任意焦点态都关闭面板
		if (matchesKey(data, "escape")) {
			this.done(null);
			return;
		}

		// ---- 差评列表焦点：↑↓ 选择（到顶/到底自然回输入框）、Enter/Tab 回输入框、Delete/Backspace 删除选中项 ----
		if (this.focus === "dislike") {
			const keys = this.sortedDislikeKeys(loadDislikeData());
			if (matchesKey(data, "up")) {
				if (this.selected === 0) {
					this.focus = "input"; // 顶部再按 ↑：自然出口
					this.tui.requestRender();
					return;
				}
				this.selected--;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				if (this.selected === keys.length - 1) {
					this.focus = "input"; // 底部再按 ↓：自然出口
					this.tui.requestRender();
					return;
				}
				this.selected++;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, "enter")) {
				this.focus = "input";
				this.tui.requestRender();
				return;
			}
			// d / Backspace：删除选中项（单条精细管理）
			if (data === "d" || data === "D" || matchesKey(data, "backspace")) {
				const key = keys[this.selected];
				if (key) {
					const d = loadDislikeData();
					delete d[key];
					saveDislikeData(d);
					this.statusMsg = `✅ 已删除差评：${key}`;
					this.selected = Math.max(0, Math.min(this.selected, keys.length - 2));
					if (!Object.keys(d).length) this.focus = "input"; // 删空了自动回输入框
					this.tui.requestRender();
				}
				return;
			}
			// Delete：清空全部差评（差评区焦点下的明确操作，不与输入框语义混淆）
			if (matchesKey(data, "delete")) {
				const d = loadDislikeData();
				const n = Object.keys(d).length;
				if (n) {
					saveDislikeData({});
					this.statusMsg = `✅ 已清空全部搜索差评（共 ${n} 个域名）`;
					this.focus = "input";
					this.tui.requestRender();
				}
				return;
			}
			return; // 列表焦点下其余按键忽略
		}

		// ---- 输入框焦点：Tab/方向键切到差评区；其余为代理编辑（Delete 无操作，避免与差评区语义混淆） ----
		if (matchesKey(data, "tab") || matchesKey(data, "up") || matchesKey(data, "down")) {
			if (Object.keys(loadDislikeData()).length) {
				this.focus = "dislike";
				this.selected = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "return")) {
			const v = this.value.trim();
			if (v && !validateProxy(v)) {
				this.error = `非法代理地址「${v}」，需 http://host:port 形式`;
				this.tui.requestRender();
				return;
			}
			this.done(v);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.cursor > 0) {
				this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor--;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "left")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.cursor = Math.min(this.value.length, this.cursor + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.cursor = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.cursor = this.value.length;
			this.tui.requestRender();
			return;
		}
		// 可打印字符：插入光标处
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
			this.cursor++;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const border = (s: string) => th.fg("border", s);
		const row = (content: string) => border("│") + truncateToWidth(content, innerW, "…", true) + border("│");
		const lines: string[] = [];

		const titleStr = ` ${th.fg("accent", "⚙️ web-tool 配置")} `;
		lines.push(border(`╭${titleStr}${"─".repeat(Math.max(0, innerW - visibleWidth(titleStr)))}╮`));

		// 搜索差评（拉黑管理，面板唯一入口）：↑↓/Tab 切换焦点、列表焦点下 Delete 删除选中项、输入框焦点下 Delete 清空全部；不显示 reason（那是给 AI 追踪的，人看只会添乱）
		const dislike = loadDislikeData();
		const dislikeKeys = this.sortedDislikeKeys(dislike);
		if (dislikeKeys.length) {
			lines.push(row(` ${th.fg("warning", "🔨 搜索差评")} ${th.fg("dim", `(${dislikeKeys.length} 个)`)}`));
			for (let i = 0; i < dislikeKeys.length; i++) {
				const k = dislikeKeys[i]!;
				const rec = dislike[k]!;
				const state =
					rec.count >= DISLIKE_BAN_THRESHOLD
						? th.fg("warning", "已滤除")
						: th.fg("dim", `降权×${Math.pow(DISLIKE_DECAY, rec.count).toFixed(2)}`);
				let text = `   ${k} ${th.fg("accent", `×${rec.count}`)} ${state}`;
				if (this.focus === "dislike" && i === this.selected) text = `\x1b[7m${text}\x1b[27m`; // 选中项反显
				lines.push(row(text));
			}
		} else {
			lines.push(row(` ${th.fg("dim", "🔨 搜索差评：无记录")}`));
		}
		if (this.statusMsg) lines.push(row(` ${th.fg("accent", this.statusMsg)}`));
		lines.push(border(`├${"─".repeat(innerW)}┤`)); // 差评区与代理输入区分隔

		// 输入框：水平滚动窗口跟随光标（❯ 前缀占 4 个显示宽度），不截断内容
		const inputW = Math.max(8, innerW - 3);
		const full = this.value;
		const totalW = visibleWidth(full);
		let startChar = 0;
		if (totalW > inputW) {
			const cursorW = visibleWidth(full.slice(0, this.cursor));
			startChar = charIndexAtWidth(full, Math.max(0, cursorW - Math.floor(inputW * 0.6)));
		}
		const windowText = sliceByWidth(full, startChar, inputW);
		const cursorInWindow = Math.min(Math.max(0, this.cursor - startChar), windowText.length);
		let inputDisplay = windowText;
		if (this.focus === "input") inputDisplay = renderInputWithCursor(inputDisplay, cursorInWindow); // 光标只在输入框焦点时显示
		lines.push(row(` ${th.fg("accent", "❯")} ${inputDisplay}`));

		// 错误提示或操作提示（按焦点态区分，只列按键动作不解释）
		if (this.error) {
			lines.push(row(th.fg("warning", ` ⚠ ${this.error}`)));
		} else if (this.focus === "dislike") {
			lines.push(row(th.fg("dim", ` ↑↓ 选择 · d 删除 · Del 清空 · Esc 取消`)));
		} else {
			lines.push(row(th.fg("dim", ` 回车保存 · 清空回车 = 清除代理 · Esc 取消`)));
		}

		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
