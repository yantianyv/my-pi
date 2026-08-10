/**
 * webdav-kb / panel.ts — /kb 人类查询引用面板（搜索 → 预览 → 插入引用）
 *
 * 复用 shared/model-select.ts 的浮层模式（ctx.ui.custom + overlay 组件协议），
 * 但交互扩展为两态：
 *   search 模式：搜索框实时检索（bigram+BM25，命中即搜）+ 结果列表 ↑↓ 选择
 *   preview 模式：Enter 进入 → 读笔记全文滚动查看；Enter 再按 = 插入引用并关闭；
 *                Esc 返回列表
 * 插入引用 = 把「📚 路径（标题）」贴进输入框（pasteToEditor），AI 看到路径可
 * 直接 kb_read 读全文。非 TUI 回落：/kb <查询词> 直接输出文本结果列表。
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, Text, type TUI } from "@earendil-works/pi-tui";
import { renderInputWithCursor } from "../shared/ui";
import { loadConfig, defaultMirrorDir, agentConfigDir } from "./store";
import { getIndex, type SearchResult } from "./search";
import { vaultReadNote } from "./crypto";

/** 搜索框可见宽度（字符） */
const INPUT_MAX_W = 48;
/** 列表一次最多展示的结果数 */
const SEARCH_LIMIT = 15;
/** 预览一次最多展示的行数 */
const PREVIEW_MAX_LINES = 200;

// ---------------------------------------------------------------------------
// 浮层组件
// ---------------------------------------------------------------------------

export class KbOverlay {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private mirrorDir: string;
	private done: (result: string | null) => void;

	private mode: "search" | "preview" = "search";
	private query = "";
	private queryCursor = 0;
	private results: SearchResult[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	/** preview 态：当前预览的路径 / 行数组 / 滚动偏移 */
	private previewPath: string | null = null;
	private previewTitle = "";
	private previewLines: string[] = [];
	private previewOffset = 0;
	/** preview 读取失败的错误信息（如 vault 未解锁） */
	private previewError: string | null = null;

	constructor(tui: TUI, theme: Theme, mirrorDir: string, done: (result: string | null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.mirrorDir = mirrorDir;
		this.done = done;
	}

	// ---- 搜索 ----

	private applyFilter(): void {
		const q = this.query.trim();
		this.results = q
			? getIndex(this.mirrorDir).search(q, { limit: SEARCH_LIMIT })
			: [];
		if (this.selectedIndex >= this.results.length) {
			this.selectedIndex = Math.max(0, this.results.length - 1);
		}
		this.clampScroll();
		this.tui.requestRender();
	}

	private getListRows(): number {
		const termRows = this.tui.terminal.rows;
		if (!termRows || termRows <= 0) return 12;
		return Math.max(6, Math.min(20, Math.floor(termRows * 0.55)));
	}

	private clampScroll(): void {
		const rows = this.getListRows();
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + rows - 1) {
			this.scrollOffset = this.selectedIndex - rows + 2;
		}
	}

	/** 打开预览：读取笔记全文并按行切分 */
	private openPreview(path: string, title: string): void {
		this.previewPath = path;
		this.previewTitle = title;
		this.previewOffset = 0;
		this.previewError = null;
		try {
			const content = vaultReadNote(this.mirrorDir, path) ?? "";
			this.previewLines = content.split("\n").slice(0, PREVIEW_MAX_LINES);
		} catch (e) {
			this.previewError = e instanceof Error ? e.message : String(e);
			this.previewLines = [];
		}
		this.mode = "preview";
		this.tui.requestRender();
	}

	// ---- 键盘 ----

	handleInput(data: string): void {
		if (this.mode === "preview") {
			this.handlePreviewInput(data);
			return;
		}
		// 终端粘贴（bracketed paste 整段）或多字符文本 → 插入搜索框
		if (data.includes("\x1b[200~") || (data.length > 1 && !data.startsWith("\x1b"))) {
			const text = data
				.replace(/\x1b\[200~/g, "")
				.replace(/\x1b\[201~/g, "")
				.replace(/\r\n?/g, " ")
				.replace(/\n/g, " ");
			if (text) {
				this.query = this.query.slice(0, this.queryCursor) + text + this.query.slice(this.queryCursor);
				this.queryCursor += text.length;
				this.applyFilter();
			}
			return;
		}
		if (matchesKey(data, "escape")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "return")) {
			const item = this.results[this.selectedIndex];
			if (item) this.openPreview(item.path, item.title);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.queryCursor > 0) {
				this.query = this.query.slice(0, this.queryCursor - 1) + this.query.slice(this.queryCursor);
				this.queryCursor--;
				this.applyFilter();
			}
			return;
		}
		if (matchesKey(data, "left")) {
			this.queryCursor = Math.max(0, this.queryCursor - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.queryCursor = Math.min(this.query.length, this.queryCursor + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.clampScroll();
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.selectedIndex < this.results.length - 1) {
				this.selectedIndex++;
				this.clampScroll();
				this.tui.requestRender();
			}
			return;
		}
		// 可打印字符 → 插入并实时检索
		if (data.length === 1 && data >= " ") {
			this.query = this.query.slice(0, this.queryCursor) + data + this.query.slice(this.queryCursor);
			this.queryCursor++;
			this.applyFilter();
		}
	}

	private handlePreviewInput(data: string): void {
		if (matchesKey(data, "escape")) {
			// 返回列表
			this.mode = "search";
			this.previewPath = null;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			// 插入引用并关闭
			if (this.previewPath) this.done(this.previewPath);
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.previewOffset > 0) {
				this.previewOffset--;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "down")) {
			this.previewOffset++;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.previewOffset = Math.max(0, this.previewOffset - this.getListRows());
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.previewOffset += this.getListRows();
			this.tui.requestRender();
			return;
		}
	}

	// ---- 渲染 ----

	render(width: number): string[] {
		return this.mode === "search" ? this.renderSearch(width) : this.renderPreview(width);
	}

	private renderSearch(width: number): string[] {
		const t = this.theme;
		const innerW = Math.max(20, width - 2);
		const border = (edge: string) => t.fg("border", t.bold(`${edge}${"─".repeat(innerW)}${edge}`));
		const lines: string[] = [border("╭")];
		// 显示宽度补白（CJK 按 2 列计，不能直接用 padEnd）
		const pad = (s: string) => truncateToWidth(s, innerW, "", true);

		// 搜索框（水平滚动窗口）
		const inputDisplay = truncateToWidth(this.query, INPUT_MAX_W);
		const cursorInWindow = Math.min(this.queryCursor, inputDisplay.length);
		const inputLine = `❯ ${renderInputWithCursor(inputDisplay, cursorInWindow)}`;
		lines.push(t.fg("dim", `│ ${inputLine}${" ".repeat(Math.max(0, innerW - visibleWidth(inputLine)))}`));

		// 结果列表
		const rows = this.getListRows();
		if (this.query.trim() === "") {
			lines.push(t.fg("dim", `│ ${pad(" 输入关键词检索知识库（webdav 云盘本地镜像）")}`));
		} else if (this.results.length === 0) {
			lines.push(t.fg("warning", `│ ${pad(" 无匹配结果")}`));
		}
		for (let i = 0; i < Math.min(rows, this.results.length); i++) {
			const idx = this.scrollOffset + i;
			const r = this.results[idx];
			if (!r) break;
			const selected = idx === this.selectedIndex;
			const tag = r.tags.length > 0 ? `  [${r.tags.slice(0, 2).join(", ")}]` : "";
			const row = truncateToWidth(` ${r.path}${tag}`, innerW);
			const titleRow = truncateToWidth(`   ${r.title}`, innerW);
			if (selected) {
				const sel = (s: string) => "\x1b[7m" + truncateToWidth(s, innerW, "", true) + "\x1b[27m";
				lines.push(`│ ${sel(row)}`);
				lines.push(`│ ${sel(titleRow)}`);
			} else {
				lines.push(`│ ${t.fg("accent", truncateToWidth(row, innerW, "", true))}`);
				lines.push(`│ ${t.fg("dim", truncateToWidth(titleRow, innerW, "", true))}`);
			}
		}

		// 底部提示
		const hint =
			this.query.trim() === ""
				? "输入即搜 · Enter 预览"
				: `${this.results.length} 个结果 · ↑↓ 选择 · Enter 预览 · Esc 关闭`;
		lines.push(border("╰"));
		lines.push(t.fg("dim", `${" ".repeat(Math.max(0, (width - visibleWidth(hint)) / 2))}${hint}`));
		return lines;
	}

	private renderPreview(width: number): string[] {
		const t = this.theme;
		const innerW = Math.max(20, width - 2);
		const border = (edge: string) => t.fg("border", t.bold(`${edge}${"─".repeat(innerW)}${edge}`));
		// 显示宽度补白（CJK 按 2 列计）
		const pad = (s: string) => truncateToWidth(s, innerW, "", true);
		const lines: string[] = [border("╭")];
		lines.push(t.bold(t.fg("accent", `│ ${pad(this.previewPath ?? "")}`)));
		lines.push(t.fg("dim", `│ ${pad(`  ${this.previewTitle}`)}`));

		const rows = this.getListRows();
		if (this.previewError) {
			lines.push(t.fg("warning", `│ ${pad("  " + this.previewError)}`));
		} else {
			const maxOffset = Math.max(0, this.previewLines.length - rows);
			const off = Math.min(this.previewOffset, maxOffset);
			for (let i = 0; i < rows; i++) {
				const src = this.previewLines[off + i];
				const line = src === undefined ? "" : src.replace(/\t/g, "  ");
				lines.push(`│ ${pad(line)}`);
			}
		}

		lines.push(border("╰"));
		const hint = `Enter 插入引用 · ↑↓ 滚动 · Esc 返回列表`;
		lines.push(t.fg("dim", `${" ".repeat(Math.max(0, (width - visibleWidth(hint)) / 2))}${hint}`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/** 把「📚 路径（标题）」插进输入框（引用格式：AI 见路径即可 kb_read 定位） */
function insertReference(ctx: ExtensionCommandContext, path: string, title: string): void {
	const line = `📚 ${path}（${title || "知识库笔记"}）`;
	ctx.ui.pasteToEditor(line);
	ctx.ui.notify(`已插入引用：${path}`, "info");
}

export function registerKbPanel(pi: ExtensionAPI): void {
	pi.registerCommand("kb", {
		description: "知识库面板：搜索笔记 → 预览 → 插入引用（/kb <查询词> 非 TUI 文本结果）",
		async handler(args, ctx) {
			const cfg = loadConfig(agentConfigDir());
			if (!cfg.baseUrl) {
				ctx.ui.notify("知识库未配置：请先运行 /kb-config 设置 WebDAV 地址与账号。", "warning");
				return;
			}
			const mirrorDir = cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
			const query = args.trim();

			// TUI：浮层面板
			if (ctx.hasUI && ctx.mode === "tui") {
				const result = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) => new KbOverlay(tui, theme, mirrorDir, done),
					{
						overlay: true,
						overlayOptions: {
							anchor: "right-center",
							width: "62%",
							minWidth: 62,
							maxHeight: "88%",
							margin: { right: 1 },
						},
					},
				);
				if (result) {
					const idx = getIndex(mirrorDir);
					const hit = idx.search(result.split("/").pop()?.replace(/\.\w+$/, "") ?? "", { limit: 5 }).find((r) => r.path === result);
					insertReference(ctx, result, hit?.title ?? "");
				}
				return;
			}

			// 非 TUI：/kb <查询词> 文本结果列表
			if (!query) {
				ctx.ui.notify("非交互模式用法：/kb <查询词> 直接列出检索结果（路径+标题+片段）。", "info");
				return;
			}
			const results = getIndex(mirrorDir).search(query, { limit: 8 });
			if (results.length === 0) {
				ctx.ui.notify(`知识库未找到与「${query}」相关的内容。`, "info");
				return;
			}
			const lines = results.map(
				(r) => `${r.path}（${r.title}）\n  ${r.snippet.slice(0, 120)}${r.snippet.length > 120 ? "…" : ""}`,
			);
			ctx.ui.notify(`📚 检索「${query}」：\n${lines.join("\n")}`, "info");
		},
	});
}
