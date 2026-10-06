/**
 * perm-gate/config-panel：`/perm-gate-config` 配置面板（↑↓ 选择 · Enter 修改 · Esc 返回）
 *
 * 覆盖六项：AI 审核开关、审核模型（内嵌 shared/model-select 的选择浮层）、审核超时（秒）、
 * sudo 授权通道开关、硬拒绝名单、关注项名单。
 *
 * 名单编辑是面板存在的主要理由（原先只能手改 JSON，正则写错要等运行时才暴露）：
 *   ① 输入即校验：保存前 `new RegExp(pattern, "is")` 试编译，非法即时提示、拒绝保存；
 *   ② 必须能测：编辑器里带一行「测试命令」，实时显示命中/未命中；
 *   ③ 删除分级：watch 直接删；deny 要再按一次 Enter 确认（放开硬拒绝是安全相关的）。
 *
 * 写盘统一走 host.persist()（调用方负责 saveConfig），本模块不直接碰配置文件。
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { createBoxRenderer, choiceKey, editInput, renderChoiceList, type ChoiceItem } from "../shared/ui";
import { ModelSelectOverlay, buildLocalModelItems } from "../shared/model-select";
import { LOCAL_AUTO, type ModelSetting } from "../shared/model-setting";

/** 面板需要的最小配置视图（由 perm-gate/index.ts 的 PermGateConfig 满足） */
export interface ConfigPanelConfig {
	aiReview: boolean;
	aiTimeoutMs: number;
	sudoExec: boolean;
	deny: string[];
	watch: string[];
}

export interface ConfigPanelHost {
	cfg: ConfigPanelConfig;
	/** 落盘（读-改-写由调用方保证） */
	persist(): void;
	/** 审核模型（本地设置，shared/model-setting） */
	reviewModel: ModelSetting;
}

type Row =
	| { kind: "toggle"; key: "aiReview" | "sudoExec"; label: string }
	| { kind: "model"; label: string }
	| { kind: "timeout"; label: string }
	| { kind: "list"; key: "deny" | "watch"; label: string };

const ROWS: Row[] = [
	{ kind: "toggle", key: "aiReview", label: "AI 审核" },
	{ kind: "model", label: "审核模型" },
	{ kind: "timeout", label: "审核超时（秒）" },
	{ kind: "toggle", key: "sudoExec", label: "sudo 授权通道" },
	{ kind: "list", key: "deny", label: "硬拒绝名单" },
	{ kind: "list", key: "watch", label: "关注项名单" },
];

/** 编译校验：非法返回错误消息，合法返回 null */
export function compilePatternError(pattern: string): string | null {
	try {
		new RegExp(pattern, "is");
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

/** 用一段样例命令测试是否命中（非法正则视为未命中） */
export function patternHits(pattern: string, sample: string): boolean {
	try {
		return new RegExp(pattern, "is").test(sample);
	} catch {
		return false;
	}
}

interface Editor {
	index: number | null;
	pattern: string;
	patternCursor: number;
	sample: string;
	sampleCursor: number;
	focus: "pattern" | "sample";
}

export class PermGateConfigOverlay {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private ctx: ExtensionContext;
	private host: ConfigPanelHost;
	private done: () => void;

	private selected = 0;
	private listKey: "deny" | "watch" | null = null;
	private listSel = 0;
	private editor: Editor | null = null;
	private timeoutEdit: { text: string; cursor: number } | null = null;
	private picker: ModelSelectOverlay | null = null;
	private pickerDone: ((v: string | null) => void) | null = null;
	private pendingDelete = -1;
	private status = "";

	constructor(tui: TUI, theme: Theme, ctx: ExtensionContext, host: ConfigPanelHost, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.host = host;
		this.done = done;
	}

	// ---- 摘要 ----

	private summary(row: Row): string {
		const c = this.host.cfg;
		switch (row.kind) {
			case "toggle":
				return c[row.key] ? "开" : "关";
			case "model": {
				const local = this.host.reviewModel.getLocal();
				return local === LOCAL_AUTO ? "auto（由 model-config 管理）" : local;
			}
			case "timeout":
				return `${Math.round(c.aiTimeoutMs / 1000)}s`;
			case "list":
				return `${c[row.key].length} 条`;
		}
	}

	// ---- 输入 ----

	handleInput(data: string): void {
		if (this.picker) {
			this.picker.handleInput(data);
			return;
		}
		if (this.editor) {
			this.handleEditor(data);
			return;
		}
		if (this.timeoutEdit) {
			this.handleTimeoutEdit(data);
			return;
		}
		if (this.listKey) {
			this.handleList(data);
			return;
		}

		const r = choiceKey(data, this.selected, ROWS.length);
		if (r.kind === "cancel") this.done();
		else if (r.kind === "move") this.selected = r.index;
		else if (r.kind === "page") this.selected = Math.min(Math.max(0, this.selected + r.dir * 3), ROWS.length - 1);
		else if (r.kind === "select") void this.activate(ROWS[r.index]!);
		this.tui.requestRender();
	}

	private async activate(row: Row): Promise<void> {
		this.status = "";
		if (row.kind === "toggle") {
			this.host.cfg[row.key] = !this.host.cfg[row.key];
			this.host.persist();
			this.status = `${row.label}：${this.host.cfg[row.key] ? "开" : "关"}`;
			return;
		}
		if (row.kind === "timeout") {
			const text = String(Math.round(this.host.cfg.aiTimeoutMs / 1000));
			this.timeoutEdit = { text, cursor: text.length };
			return;
		}
		if (row.kind === "model") {
			await this.pickModel();
			return;
		}
		this.listKey = row.key;
		this.listSel = 0;
		this.pendingDelete = -1;
	}

	/** 内嵌模型选择浮层（不叠 ctx.ui.custom，避免嵌套弹层） */
	private pickModel(): Promise<void> {
		const items = buildLocalModelItems(this.ctx);
		return new Promise<void>((resolve) => {
			this.pickerDone = (v) => {
				this.picker = null;
				this.pickerDone = null;
				if (v) {
					this.host.reviewModel.setLocal(v);
					this.status = `审核模型：${v === LOCAL_AUTO ? "auto（由 model-config 管理）" : v}`;
				}
				this.tui.requestRender();
				resolve();
			};
			this.picker = new ModelSelectOverlay(
				this.tui,
				this.theme,
				items,
				this.host.reviewModel.getLocal(),
				(v) => this.pickerDone?.(v),
				{ title: "选择审核模型" },
			);
		});
	}

	private handleTimeoutEdit(data: string): void {
		const ed = this.timeoutEdit;
		if (!ed) return;
		if (matchesKey(data, "escape")) {
			this.timeoutEdit = null;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			const secs = Number.parseInt(ed.text, 10);
			if (!Number.isFinite(secs) || secs < 1 || secs > 600) {
				this.status = "超时需为 1~600 秒";
			} else {
				this.host.cfg.aiTimeoutMs = secs * 1000;
				this.host.persist();
				this.status = `审核超时已设为 ${secs}s`;
				this.timeoutEdit = null;
			}
			this.tui.requestRender();
			return;
		}
		const r = editInput(ed.text, ed.cursor, data);
		if (r !== "skip") this.timeoutEdit = { text: r.text, cursor: r.cursor };
		this.tui.requestRender();
	}

	// ---- 名单页 ----

	private listItems(): string[] {
		return this.listKey ? this.host.cfg[this.listKey] : [];
	}

	private handleList(data: string): void {
		const items = this.listItems();
		const count = items.length + 1; // 末行 = 添加
		if (matchesKey(data, "ctrl+d")) {
			if (this.listSel < items.length) this.tryDelete(this.listSel);
			this.tui.requestRender();
			return;
		}
		const r = choiceKey(data, this.listSel, count);
		if (r.kind === "cancel") {
			this.listKey = null;
			this.pendingDelete = -1;
			this.status = "";
		} else if (r.kind === "move" || r.kind === "page") {
			const next = r.kind === "move" ? r.index : this.listSel + r.dir * 5;
			this.listSel = Math.min(Math.max(0, next), count - 1);
			this.pendingDelete = -1;
		} else if (r.kind === "select") {
			if (r.index === items.length) {
				this.editor = { index: null, pattern: "", patternCursor: 0, sample: "", sampleCursor: 0, focus: "pattern" };
				this.status = "";
			} else {
				const p = items[r.index]!;
				this.editor = { index: r.index, pattern: p, patternCursor: p.length, sample: "", sampleCursor: 0, focus: "pattern" };
				this.status = "";
			}
		}
		this.tui.requestRender();
	}

	private tryDelete(index: number): void {
		if (!this.listKey) return;
		const list = this.host.cfg[this.listKey];
		if (this.listKey === "deny" && this.pendingDelete !== index) {
			this.pendingDelete = index;
			this.status = "再按一次 Ctrl+D 确认删除硬拒绝规则（其他键取消）";
			return;
		}
		list.splice(index, 1);
		this.host.persist();
		this.pendingDelete = -1;
		this.listSel = Math.min(this.listSel, Math.max(0, list.length));
		this.status = `已删除一条（剩 ${list.length} 条）`;
	}

	// ---- 编辑器 ----

	private handleEditor(data: string): void {
		const ed = this.editor;
		if (!ed) return;
		if (matchesKey(data, "escape")) {
			this.editor = null;
			this.status = "已取消编辑";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "tab")) {
			ed.focus = ed.focus === "pattern" ? "sample" : "pattern";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			if (ed.focus === "pattern" && !ed.sample) {
				// 正则还没测过：先跳到测试行（逼一次命中验证，避免盲存）
				ed.focus = "sample";
			} else {
				const err = compilePatternError(ed.pattern);
				if (err) this.status = `正则非法，未保存：${err}`;
				else if (this.listKey) {
					const list = this.host.cfg[this.listKey];
					if (ed.index === null) list.push(ed.pattern);
					else list[ed.index] = ed.pattern;
					this.host.persist();
					this.status = `已保存（${this.listKey} 共 ${list.length} 条）`;
					this.editor = null;
				}
			}
			this.tui.requestRender();
			return;
		}
		const target = ed.focus === "pattern" ? { text: ed.pattern, cursor: ed.patternCursor } : { text: ed.sample, cursor: ed.sampleCursor };
		const r = editInput(target.text, target.cursor, data);
		if (r !== "skip") {
			if (ed.focus === "pattern") {
				ed.pattern = r.text;
				ed.patternCursor = r.cursor;
			} else {
				ed.sample = r.text;
				ed.sampleCursor = r.cursor;
			}
		}
		this.tui.requestRender();
	}

	// ---- 渲染 ----

	render(width: number): string[] {
		if (this.picker) return this.picker.render(width);
		const th = this.theme;
		const innerW = Math.max(30, width - 2);
		const { row, topBorder, bottomBorder } = createBoxRenderer(th, innerW);
		const lines: string[] = [];
		const title = this.listKey ? (this.listKey === "deny" ? "硬拒绝名单" : "关注项名单") : "perm-gate 配置";
		lines.push(topBorder(` ${th.fg("accent", `🛡 ${title}`)} `));

		if (this.editor) {
			const ed = this.editor;
			const bad = compilePatternError(ed.pattern);
			const focus = (f: "pattern" | "sample") => (ed.focus === f ? th.fg("accent", "❯") : " ");
			lines.push(row(` ${focus("pattern")} 正则 ${truncateToWidth(ed.pattern || "（输入正则，如 \\bdws\\s+chat\\s+send\\b）", innerW - 8, "…")}`));
			lines.push(row(` ${focus("sample")} 测试 ${truncateToWidth(ed.sample || "（输入一段命令，实时看是否命中）", innerW - 8, "…")}`));
			lines.push(
				row(
					bad
						? th.fg("error", `  ✗ 正则非法：${bad}`)
						: ed.sample
							? patternHits(ed.pattern, ed.sample)
								? th.fg("success", "  ✓ 命中（这类命令会被拦/标记）")
								: th.fg("dim", "  · 未命中（确认是否写得太窄/太宽）")
							: th.fg("dim", `  · 正则合法（Tab 切行；Enter 保存 · Esc 取消）`),
				),
			);
			if (this.status) lines.push(row(th.fg("warning", `  ${this.status}`)));
			lines.push(row(th.fg("dim", "  Tab 切换 · Enter 下一行/保存（非法正则拒绝保存）· Esc 取消")));
			lines.push(bottomBorder());
			return lines;
		}

		if (this.timeoutEdit) {
			lines.push(row(""));
			lines.push(row(`  审核超时：${this.timeoutEdit.text} 秒`));
			if (this.status) lines.push(row(th.fg("warning", `  ${this.status}`)));
			lines.push(row(th.fg("dim", "  Enter 保存（1~600）· Esc 取消")));
			lines.push(bottomBorder());
			return lines;
		}

		if (this.listKey) {
			const items = this.listItems();
			const budget = Math.max(6, Math.min(16, (this.tui.terminal.rows || 24) - 9));
			const choiceItems: ChoiceItem[] = items.map((p, i) => ({
				label: p,
				note: i === this.pendingDelete ? "再按 Ctrl+D 确认" : undefined,
			}));
			choiceItems.push({ label: "＋ 添加规则", note: "Enter 进入编辑器" });
			const start = Math.max(0, Math.min(this.listSel - budget + 2, Math.max(0, choiceItems.length - budget)));
			const visible = choiceItems.slice(start, start + budget);
			for (const l of renderChoiceList(th, visible, this.listSel - start, { width: innerW - 2 })) lines.push(row(` ${l}`));
			if (this.status) lines.push(row(th.fg("warning", `  ${this.status}`)));
			lines.push(row(th.fg("dim", "  ↑↓ 选择 · Enter 编辑 · Ctrl+D 删除 · Esc 返回")));
			lines.push(bottomBorder());
			return lines;
		}

		const items: ChoiceItem[] = ROWS.map((r) => ({ label: r.label, note: this.summary(r) }));
		for (const l of renderChoiceList(th, items, this.selected, { width: innerW - 2 })) lines.push(row(` ${l}`));
		if (this.status) lines.push(row(th.fg("warning", `  ${this.status}`)));
		lines.push(row(th.fg("dim", "  ↑↓ 选择 · Enter 切换/修改 · Esc 关闭（开关与维护仍在 /perm-gate）")));
		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
