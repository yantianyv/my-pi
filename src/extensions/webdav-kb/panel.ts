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
import { matchesKey, Text, type TUI } from "@earendil-works/pi-tui";
import { createBoxRenderer, editInput, renderScrollingInput } from "../shared/ui";
import { loadConfig, defaultMirrorDir, agentConfigDir } from "./store";
import { getIndex, type SearchResult } from "./search";
import { vaultReadNote } from "./crypto";

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
		if (matchesKey(data, "escape")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "return")) {
			const item = this.results[this.selectedIndex];
			if (item) this.openPreview(item.path, item.title);
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
		// 编辑键（粘贴/backspace/left/right/home/end/delete/ctrl+u/可打印）统一走 shared/ui editInput
		const r = editInput(this.query, this.queryCursor, data);
		if (r !== "skip") {
			this.query = r.text;
			this.queryCursor = r.cursor;
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
		const { row, topBorder, bottomBorder } = createBoxRenderer(t, innerW);
		const lines: string[] = [topBorder()];

		// 搜索框（水平滚动窗口，与其他面板一致）
		const { display: inputDisplay } = renderScrollingInput(this.query, this.queryCursor, innerW, {
			showCursor: true,
		});
		lines.push(row(` ${t.fg("accent", "❯")} ${inputDisplay}`));

		// 结果列表
		const rows = this.getListRows();
		if (this.query.trim() === "") {
			lines.push(row(t.fg("dim", "  输入关键词检索知识库（webdav 云盘本地镜像）")));
		} else if (this.results.length === 0) {
			lines.push(row(t.fg("warning", "  无匹配结果")));
		}
		for (let i = 0; i < Math.min(rows, this.results.length); i++) {
			const idx = this.scrollOffset + i;
			const r = this.results[idx];
			if (!r) break;
			const selected = idx === this.selectedIndex;
			const tag = r.tags.length > 0 ? `  [${r.tags.slice(0, 2).join(", ")}]` : "";
			const rowText = ` ${r.path}${tag}`;
			const titleRow = `   ${r.title}`;
			if (selected) {
				lines.push(row(`\x1b[7m${rowText}\x1b[27m`));
				lines.push(row(`\x1b[7m${titleRow}\x1b[27m`));
			} else {
				lines.push(row(t.fg("accent", rowText)));
				lines.push(row(t.fg("dim", titleRow)));
			}
		}

		// 底部提示（框内，与其他面板一致）
		const hint =
			this.query.trim() === ""
				? "输入即搜 · Enter 预览"
				: `${this.results.length} 个结果 · ↑↓ 选择 · Enter 预览 · Esc 关闭`;
		lines.push(row(t.fg("dim", hint)));
		lines.push(bottomBorder());
		return lines;
	}

	private renderPreview(width: number): string[] {
		const t = this.theme;
		const innerW = Math.max(20, width - 2);
		const { row, topBorder, bottomBorder } = createBoxRenderer(t, innerW);
		const lines: string[] = [topBorder()];
		lines.push(row(t.bold(t.fg("accent", ` ${this.previewPath ?? ""}`))));
		lines.push(row(t.fg("dim", `  ${this.previewTitle}`)));

		const rows = this.getListRows();
		if (this.previewError) {
			lines.push(row(t.fg("warning", `  ${this.previewError}`)));
		} else {
			const maxOffset = Math.max(0, this.previewLines.length - rows);
			const off = Math.min(this.previewOffset, maxOffset);
			for (let i = 0; i < rows; i++) {
				const src = this.previewLines[off + i];
				const line = src === undefined ? "" : src.replace(/\t/g, "  ");
				lines.push(row(line));
			}
		}

		const hint = `Enter 插入引用 · ↑↓ 滚动 · Esc 返回列表`;
		lines.push(row(t.fg("dim", hint)));
		lines.push(bottomBorder());
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
