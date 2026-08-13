/**
 * web-tool/panel：/web-tool-config 设置面板（web-tool 多文件扩展的组成部分）
 *
 * 重做后的交互（吸取 ModelSelectOverlay 精华，弃旧版双焦点混乱）：
 * - 单焦点模型：Tab 在「代理输入框 ↔ 差评列表」间切换（弃旧版 ↑↓ 到顶/到底的「自然出口」）
 * - 输入框焦点：Enter 保存/清空回车清除、Esc 取消；backspace/left/right/home/end/粘贴
 *   统一走 shared/ui editInput（补齐旧版缺的粘贴）
 * - 差评列表焦点：↑↓ 选择、Del 删除选中项（语义明确，弃旧版 d/Backspace 删条目）、
 *   Enter/Tab 回输入框、Esc 取消
 * - 弃：Delete 无确认清空全部差评（危险）、双焦点自然出口（反直觉）
 * - 复用 shared/ui 的 createBoxRenderer / editInput / renderScrollingInput
 *
 * 注意：本模块不注册任何 pi API，仅导出组件类，由入口（/web-tool-config 命令）实例化。
 */
import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createBoxRenderer, editInput, renderScrollingInput } from "../shared/ui";
import { loadDislikeData, saveDislikeData, DISLIKE_DECAY, DISLIKE_BAN_THRESHOLD } from "./dislike";
import { validateProxy } from "./http";

/**
 * /web-tool-config 设置面板：输入代理地址（Enter 保存 / 清空回车 = 清除代理）+ 搜索差评管理。
 * 单焦点（input ↔ dislike，Tab 切换）；差评列表 Del 删除选中项；非法地址回车不关闭面板。
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
	// 单焦点：input = 代理输入框；dislike = 差评列表（↑↓ 选择、Del 删除选中项）
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

		// ---- 差评列表焦点：↑↓ 选择、Del 删除选中项、Enter/Tab 回输入框 ----
		if (this.focus === "dislike") {
			const keys = this.sortedDislikeKeys(loadDislikeData());
			if (matchesKey(data, "up")) {
				if (this.selected > 0) {
					this.selected--;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, "down")) {
				if (this.selected < keys.length - 1) {
					this.selected++;
					this.tui.requestRender();
				}
				return;
			}
			// Del：删除选中项（语义明确，弃旧版 d/Backspace 删条目）
			if (matchesKey(data, "delete")) {
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
			// Enter / Tab：回输入框
			if (matchesKey(data, "return") || matchesKey(data, "tab")) {
				this.focus = "input";
				this.tui.requestRender();
				return;
			}
			return; // 列表焦点下其余按键忽略
		}

		// ---- 输入框焦点：Tab 切到差评区（若有）；Enter 保存；其余走 editInput ----
		if (matchesKey(data, "tab")) {
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
		// 编辑键（backspace/left/right/home/end/可打印字符/粘贴）统一走 shared/ui editInput
		const r = editInput(this.value, this.cursor, data);
		if (r !== "skip") {
			this.value = r.text;
			this.cursor = r.cursor;
			this.tui.requestRender();
		}
	}

	/** 底部提示行（按焦点态区分，只列按键动作） */
	private hintText(): string {
		if (this.focus === "input") return "回车保存 · 清空回车 = 清除代理 · Tab 差评 · Esc 取消";
		return "↑↓ 选择 · Del 删除选中 · Enter/Tab 回输入 · Esc 取消";
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const { row, topBorder, bottomBorder } = createBoxRenderer(th, innerW);
		const lines: string[] = [];

		const titleStr = ` ${th.fg("accent", "⚙️ web-tool 配置")} `;
		lines.push(topBorder(titleStr));

		// 输入框：水平滚动窗口跟随光标（❯ 前缀占 4 个显示宽度）；光标只在输入框焦点时显示
		const { display: inputDisplay } = renderScrollingInput(this.value, this.cursor, innerW, {
			showCursor: this.focus === "input",
		});
		lines.push(row(` ${th.fg("accent", "❯")} ${inputDisplay}`));

		// 搜索差评（拉黑管理，面板唯一入口）：不显示 reason（那是给 AI 追踪的，人看只会添乱）
		const dislike = loadDislikeData();
		const dislikeKeys = this.sortedDislikeKeys(dislike);
		lines.push(row(` ${th.fg("warning", "🔨 搜索差评")} ${th.fg("dim", `(${dislikeKeys.length} 个)`)}`));
		if (dislikeKeys.length) {
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
			lines.push(row(` ${th.fg("dim", "无记录")}`));
		}

		// 错误 / 操作反馈 / 提示（error 优先于 statusMsg；常驻一行操作提示）
		if (this.error) lines.push(row(th.fg("warning", ` ⚠ ${this.error}`)));
		else if (this.statusMsg) lines.push(row(th.fg("accent", this.statusMsg)));
		lines.push(row(th.fg("dim", this.hintText())));

		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
