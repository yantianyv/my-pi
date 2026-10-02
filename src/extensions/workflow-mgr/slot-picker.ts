/**
 * 工作流槽位选择浮层（session_start 多槽/并发场景，TUI 专用）。
 *
 * 替代 ctx.ui.select 纯文本平铺列表：自绘圆角浮窗把「通用操作」与「实际工作流」
 * 分组呈现——
 * - 通用：暂不启用（Esc 同此，默认高亮）/ 从 resume 中加载会话（放弃本会话转恢复流程）；
 * - 工作流（N）：槽位一行一项，行尾 dim 摘要（进度 x/y｜当前：任务，空槽显示「空」）；
 * - ＋ 新建工作流…（名称由调用方经 ctx.ui.input 收集）。
 *
 * 键位：↑↓/j/k 移动（循环）、Enter/空格确认、Esc/Ctrl+C = 暂不启用、数字键 1-9 直选。
 * 组件只产出 SlotPick 意图，写绑定 / 收集新槽名 / 派发恢复命令都由 events.ts 负责。
 *
 * 渲染与 /workflow-config 菜单同款（createBoxRenderer 圆角 + borderMuted 暗色 +
 * ▶ 选中前缀），宽度自适应 pi-tui visibleWidth（中文=2、块元素=1）。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { SlotSummary } from "./store";
import { createBoxRenderer } from "../shared/ui";

/** 选择意图：events.ts 据 kind 分派（defer=暂不启用 / resume=恢复会话 / slot=选定槽 / new=新建） */
export type SlotPick = { kind: "defer" } | { kind: "resume" } | { kind: "slot"; slot: string } | { kind: "new" };

/** 渲染行：分组小标题 / 分隔线 / 可选条目（note = 行尾 dim 摘要，空串 = 无） */
type Row = { type: "header"; text: string } | { type: "divider" } | { type: "item"; pick: SlotPick; label: string; note: string };

export class SlotPickerComponent {
	private rows: Row[];
	private items: SlotPick[];
	private selected = 0;
	private theme: Theme;
	private tui: TUI | null = null;
	private onDone: (pick: SlotPick) => void;

	constructor(sums: SlotSummary[], theme: Theme, onDone: (pick: SlotPick) => void) {
		this.theme = theme;
		this.onDone = onDone;
		this.rows = [
			{ type: "header", text: "通用" },
			{ type: "item", pick: { kind: "defer" }, label: "暂不启用", note: "" },
			{ type: "item", pick: { kind: "resume" }, label: "从 resume 中加载会话", note: "" },
			{ type: "divider" },
			{ type: "header", text: `工作流（${sums.length}）` },
			...sums.map(
				(s): Row => ({
					type: "item",
					pick: { kind: "slot", slot: s.slot },
					label: s.slot,
					note: s.total > 0 ? `进度 ${s.done}/${s.total}${s.current ? `｜当前：${s.current}` : ""}` : "空",
				}),
			),
			{ type: "divider" },
			{ type: "item", pick: { kind: "new" }, label: "＋ 新建工作流…", note: "" },
		];
		this.items = this.rows.filter((r) => r.type === "item").map((r) => (r as { pick: SlotPick }).pick);
	}

	setTui(tui: TUI): void {
		this.tui = tui;
	}

	handleInput(data: string): void {
		const n = this.items.length;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onDone({ kind: "defer" }); // Esc 视同「暂不启用」（与旧选择框语义一致）
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.selected = (this.selected - 1 + n) % n;
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.selected = (this.selected + 1) % n;
		else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			this.onDone(this.items[this.selected]);
			return;
		} else if (data >= "1" && data <= "9") {
			const i = Number(data) - 1;
			if (i < n) {
				this.onDone(this.items[i]);
				return;
			}
		}
		this.tui?.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		// 浮窗边框：innerW = width-2；内容行 pad 到 innerW-2（左右各留 1 空格内边距），边框与行同宽
		const innerW = Math.max(30, width - 2);
		const b = (s: string) => th.fg("borderMuted", s);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - 2 - visibleWidth(s)));

		const content: string[] = [];
		content.push(pad(th.fg("accent", th.bold(" 选择本会话的工作流 "))));
		content.push(pad(""));
		let itemIdx = 0;
		for (const row of this.rows) {
			if (row.type === "header") {
				content.push(pad(th.fg("dim", ` ${row.text}`)));
			} else if (row.type === "divider") {
				content.push(pad(th.fg("dim", ` ${"─".repeat(Math.max(4, innerW - 6))}`)));
			} else {
				const selected = itemIdx === this.selected;
				itemIdx++;
				const prefix = selected ? th.fg("accent", "▶ ") : th.fg("dim", "  ");
				const label = selected ? th.fg("text", th.bold(row.label)) : th.fg("muted", row.label);
				const note = row.note ? "  " + th.fg("dim", row.note) : "";
				content.push(pad(truncateToWidth(` ${prefix}${label}${note}`, innerW - 2, "…")));
			}
		}
		content.push(pad(""));
		content.push(pad(th.fg("dim", " ↑↓ 选择　Enter 确认　Esc 暂不启用　1-9 直选")));

		const { topBorder, bottomBorder } = createBoxRenderer(th, innerW, { color: "borderMuted" });
		return [topBorder(), ...content.map((l) => b("│ ") + l + b(" │")), bottomBorder()];
	}

	invalidate(): void {
		/* 渲染无缓存，每次现算 */
	}
}
