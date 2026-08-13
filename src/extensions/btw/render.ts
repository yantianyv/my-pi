/**
 * btw/render：回答的 markdown 轻量渲染（btw 多文件扩展的组成部分）
 *
 * 职责：把模型回答渲染成面板内可读的行文本：
 * - 按显示宽度换行（考虑中文/全角字符，\n 保留为空行）
 * - 行内样式：`行内代码` / **粗体** / *斜体*（ANSI 不参与宽度计算）
 * - 代码块 / 标题 / 列表前缀
 * - markdown 表格整体渲染（在 wrap 之前识别整块，避免换行拆散对齐；列宽自适应，超宽压缩）
 *
 * 注意：本模块不注册任何 pi API，仅导出纯函数，由 overlay.ts 驱动。
 */
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** 按显示宽度换行（考虑中文/全角字符，\n 保留为空行） */
export function wrapText(text: string, width: number): string[] {
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine === "") {
			out.push("");
			continue;
		}
		let current = "";
		let currentW = 0;
		for (const ch of rawLine) {
			const w = visibleWidth(ch);
			if (currentW + w > width && current !== "") {
				out.push(current);
				current = ch;
				currentW = w;
			} else {
				current += ch;
				currentW += w;
			}
		}
		out.push(current);
	}
	return out;
}

/** 行内 markdown 轻量渲染：行内代码 / 粗体 / 斜体（在 wrap 之后调用，ANSI 不参与宽度计算） */
function renderInline(text: string, th: Theme): string {
	// 行内代码 `code`（先处理，避免与粗体/斜体标记混淆）
	text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => th.fg("accent", code));
	// 粗体 **bold**
	text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, bold: string) => th.bold(bold));
	// 斜体 *italic*（单个星号，粗体已被替换不会误伤）
	text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, italic: string) => `${pre}${th.italic(italic)}`);
	return text;
}

/** 单行 markdown 轻量渲染：代码块分隔 / 标题 / 列表前缀 + 行内样式 */
function renderLine(line: string, th: Theme): string {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("```")) return th.fg("muted", line);
	if (/^#{1,6}\s/.test(trimmed)) return th.fg("accent", th.bold(line));
	const listMatch = /^[-*]\s+/.exec(trimmed);
	if (listMatch) return "• " + renderInline(trimmed.slice(listMatch[0].length), th);
	return renderInline(line, th);
}

// ---- markdown 表格（在 wrap 之前识别整块，避免换行拆散对齐） ----

/** 表格行判定：以 | 开头且结尾，且中间还有 | */
function isTableRow(line: string): boolean {
	return line.startsWith("|") && line.endsWith("|") && line.includes("|", 1);
}

/** 拆分成单元格（去首尾 |，按 | 切分并 trim） */
function splitTableRow(line: string): string[] {
	return line.slice(1, -1).split("|").map((s) => s.trim());
}

/** 分隔行判定：如 |---|---|、|:--:| */
function isTableSeparator(line: string): boolean {
	if (!isTableRow(line)) return false;
	return splitTableRow(line).every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** 渲染 markdown 表格：列宽按内容自适应，超宽时压缩最宽列，表头高亮 */
function renderTable(rows: string[][], th: Theme, maxW: number): string[] {
	const colCount = Math.max(1, ...rows.map((r) => r.length));

	// 列宽 = 该列单元格的最大可见宽度
	const widths: number[] = [];
	for (let c = 0; c < colCount; c++) {
		let w = 0;
		for (const r of rows) {
			if (c < r.length) w = Math.max(w, visibleWidth(r[c]!));
		}
		widths.push(w);
	}

	// 总宽 = 边框 + 各列（内容 + 两侧 padding）+ 列分隔
	const totalW = () => widths.reduce((a, b) => a + b, 0) + colCount * 3 + 1;
	// 超宽压缩：反复削减当前最宽且可减的列，每列至少 1 宽
	let guard = 0;
	while (totalW() > maxW && guard < colCount * 50) {
		guard++;
		let widest = -1;
		let widestW = 0;
		for (let c = 0; c < colCount; c++) {
			if (widths[c]! > 1 && widths[c]! > widestW) {
				widestW = widths[c]!;
				widest = c;
			}
		}
		if (widest < 0) break; // 全部已到最小宽度
		widths[widest] = widestW - 1;
	}

	const cells = (row: string[], isHeader: boolean): string => {
		let line = "│";
		for (let c = 0; c < colCount; c++) {
			const cell = c < row.length ? row[c]! : "";
			const display = truncateToWidth(cell, widths[c]!, "…", false);
			const pad = Math.max(0, widths[c]! - visibleWidth(display));
			const styled = isHeader ? th.bold(display) : display;
			line += ` ${styled}${' '.repeat(pad)} │`;
		}
		return isHeader ? th.fg("accent", line) : th.fg("text", line);
	};
	const separator = (): string => {
		let line = "├";
		for (let c = 0; c < colCount; c++) {
			line += "─".repeat(widths[c]! + 2) + (c < colCount - 1 ? "┼" : "┤");
		}
		return th.fg("muted", line);
	};

	const out: string[] = [];
	out.push(`  ${cells(rows[0]!, true)}`);
	out.push(`  ${separator()}`);
	for (const r of rows.slice(1)) out.push(`  ${cells(r, false)}`);
	return out;
}

/** 渲染一段回答：识别表格块整体渲染，其余按行 wrap + 行内样式（含代码块状态） */
export function renderAnswer(text: string, th: Theme, contentWidth: number): string[] {
	const rawLines = text.split("\n");
	const out: string[] = [];
	let inCode = false;
	let i = 0;
	while (i < rawLines.length) {
		const line = rawLines[i]!;
		const trimmed = line.trim();

		if (trimmed.startsWith("```")) {
			out.push(`  ${th.fg("muted", line)}`);
			inCode = !inCode;
			i++;
			continue;
		}
		if (inCode) {
			for (const l of wrapText(line, contentWidth)) out.push(`  ${l}`);
			i++;
			continue;
		}
		// 表格块：当前行是表格行且下一行是分隔行
		if (isTableRow(trimmed) && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1]!.trim())) {
			const rows: string[][] = [splitTableRow(trimmed)];
			i += 2; // 跳过表头行与分隔行
			while (i < rawLines.length && isTableRow(rawLines[i]!.trim())) {
				rows.push(splitTableRow(rawLines[i]!.trim()));
				i++;
			}
			out.push(...renderTable(rows, th, contentWidth));
			continue;
		}
		for (const l of wrapText(line, contentWidth)) out.push(`  ${renderLine(l, th)}`);
		i++;
	}
	return out;
}
