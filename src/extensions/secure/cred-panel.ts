/**
 * secure / cred-panel.ts — 凭据管理面板（/secure 无参打开）
 *
 * 三件事：看有哪些凭据（名字/用途/长度/预览）、新增（掩码录入）、删除（二次确认）。
 * 值从不显示：面板只拿 list() 的 PublicEntry，任何一步都取不到真值。
 *
 * 掩码录入用 star 覆盖显示——屏幕上不出现明文，避免截屏/录屏泄漏；
 * 粘贴照常可用（editInput 统一处理）。
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createBoxRenderer, editInput, renderChoiceList } from "../shared/ui";
import { isValidName, type PublicEntry } from "./vault";

export interface CredPanelDeps {
	/** 当前库里的条目（不含值） */
	entries: () => PublicEntry[];
	/** 录入：成功返回 null，失败返回人话原因 */
	add: (input: { name: string; label: string; value: string }) => string | null;
	/** 删除 */
	remove: (name: string) => boolean;
}

type Mode =
	| { kind: "list" }
	| { kind: "add-name"; name: string }
	| { kind: "add-label"; name: string; label: string }
	| { kind: "add-value"; name: string; label: string; value: string }
	| { kind: "confirm-delete"; name: string };

const MASK_CHAR = "•";

export class CredPanel {
	focused = false;
	private mode: Mode = { kind: "list" };
	private selected = 0;
	/** 列表滚动起点（条目多时） */
	private scroll = 0;
	private notice: string | undefined;

	constructor(
		private tui: { requestRender: () => void },
		private theme: Theme,
		private deps: CredPanelDeps,
		private done: (result: void) => void,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			// 编辑态：退回列表；列表态：关闭面板
			if (this.mode.kind === "list") {
				this.done();
				return;
			}
			this.mode = { kind: "list" };
			this.notice = undefined;
			this.tui.requestRender();
			return;
		}

		switch (this.mode.kind) {
			case "list":
				this.handleListInput(data);
				return;
			case "add-name":
				this.handleTextInput(data, "add-name");
				return;
			case "add-label":
				this.handleTextInput(data, "add-label");
				return;
			case "add-value":
				this.handleTextInput(data, "add-value");
				return;
			case "confirm-delete":
				this.handleConfirmDelete(data);
				return;
		}
	}

	private handleListInput(data: string): void {
		const entries = this.deps.entries();
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, entries.length - 1), this.selected + 1);
		} else if (matchesKey(data, "enter")) {
			// 列表态 Enter 无动作（新增大用 n，删除用 d）
		} else if (data === "n") {
			this.mode = { kind: "add-name", name: "" };
			this.notice = undefined;
		} else if (data === "d" && entries.length > 0) {
			const target = entries[this.selected];
			if (target) {
				this.mode = { kind: "confirm-delete", name: target.name };
				this.notice = undefined;
			}
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private handleTextInput(data: string, kind: "add-name" | "add-label" | "add-value"): void {
		if (matchesKey(data, "enter")) {
			this.advance(kind);
			this.tui.requestRender();
			return;
		}
		// 各步的当前文本与光标（光标恒在末尾：面板是单行录入，不做左右移动）
		const current = kind === "add-name" ? this.modeName() : kind === "add-label" ? this.modeLabel() : this.modeValue();
		const result = editInput(current, current.length, data);
		if (result === "skip" || result.text === current) return;
		if (kind === "add-name" && this.mode.kind === "add-name") this.mode = { kind: "add-name", name: result.text };
		if (kind === "add-label" && this.mode.kind === "add-label") this.mode = { ...this.mode, label: result.text };
		if (kind === "add-value" && this.mode.kind === "add-value") this.mode = { ...this.mode, value: result.text };
		this.tui.requestRender();
	}

	private modeName(): string {
		return this.mode.kind === "add-name" ? this.mode.name : "";
	}
	private modeLabel(): string {
		return this.mode.kind === "add-label" ? this.mode.label : "";
	}
	private modeValue(): string {
		return this.mode.kind === "add-value" ? this.mode.value : "";
	}

	/** 三步录入的推进与校验 */
	private advance(kind: "add-name" | "add-label" | "add-value"): void {
		if (kind === "add-name" && this.mode.kind === "add-name") {
			const name = this.mode.name.trim();
			if (!isValidName(name)) {
				this.notice = "名字不合法：字母开头，可含字母数字与 . _ -";
				return;
			}
			if (this.deps.entries().some((e) => e.name === name)) {
				this.notice = `已有 {{sec:${name}}}，换个名字或先删除旧条目`;
				return;
			}
			this.notice = undefined;
			this.mode = { kind: "add-label", name, label: "" };
			return;
		}
		if (kind === "add-label" && this.mode.kind === "add-label") {
			// label 可空（直接 Enter 跳过）
			this.mode = { kind: "add-value", name: this.mode.name, label: this.mode.label.trim(), value: "" };
			return;
		}
		if (kind === "add-value" && this.mode.kind === "add-value") {
			const value = this.mode.value;
			if (value.trim().length === 0) {
				this.notice = "值不能为空";
				return;
			}
			const error = this.deps.add({ name: this.mode.name, label: this.mode.label, value });
			if (error) {
				this.notice = error;
				return;
			}
			const added = this.mode.name;
			this.notice = `已录入 {{sec:${added}}}`;
			this.mode = { kind: "list" };
			// 选中刚加的那条，省得用户再翻
			const entries = this.deps.entries();
			const idx = entries.findIndex((e) => e.name === added);
			this.selected = idx >= 0 ? idx : Math.max(0, Math.min(entries.length - 1, this.selected));
		}
	}

	private handleConfirmDelete(data: string): void {
		if (this.mode.kind !== "confirm-delete") return;
		if (data === "y" || matchesKey(data, "enter")) {
			const ok = this.deps.remove(this.mode.name);
			this.notice = ok ? `已删除 {{sec:${this.mode.name}}}` : "删除失败：条目不存在";
			this.mode = { kind: "list" };
			const entries = this.deps.entries();
			this.selected = Math.max(0, Math.min(this.selected, Math.max(0, entries.length - 1)));
			this.tui.requestRender();
			return;
		}
		if (data === "n" || matchesKey(data, "escape")) {
			this.mode = { kind: "list" };
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const innerW = Math.max(20, Math.min(width - 4, 88));
		const box = createBoxRenderer(this.theme, innerW);
		const entries = this.deps.entries();
		const lines: string[] = [];

		const title =
			this.mode.kind === "add-name"
				? " 新增凭据 · 名字 "
				: this.mode.kind === "add-label"
					? " 新增凭据 · 用途 "
					: this.mode.kind === "add-value"
						? " 新增凭据 · 值（掩码） "
						: this.mode.kind === "confirm-delete"
							? " 确认删除 "
							: " 凭据（本会话内存，不落盘） ";

		lines.push(box.topBorder(this.theme.fg("accent", title)));
		lines.push(box.row(""));

		if (this.mode.kind === "list") {
			if (entries.length === 0) {
				lines.push(box.row(this.theme.fg("muted", "  本会话还没有凭据。按 n 录入一条。")));
			} else {
				const visible = 10;
				if (this.selected < this.scroll) this.scroll = this.selected;
				if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1;
				const slice = entries.slice(this.scroll, this.scroll + visible);
				const items = slice.map((e) => ({
					label: `{{sec:${e.name}}}`,
					note: `${e.length} 字符${e.label ? ` · ${e.label}` : ""}${e.preview ? ` · ${e.preview}` : ""}`,
				}));
				lines.push(
					...renderChoiceList(
						this.theme,
						items,
						this.selected - this.scroll,
						{},
					),
				);
				if (entries.length > visible) {
					lines.push(box.row(this.theme.fg("dim", `  … 共 ${entries.length} 条，↑↓ 移动`)));
				}
			}
		} else if (this.mode.kind === "add-name") {
			lines.push(box.row(`  名字：${this.mode.name}${this.theme.fg("dim", "▏")}`));
			lines.push(box.row(this.theme.fg("dim", "  字母开头，可含字母数字与 . _ -")));
		} else if (this.mode.kind === "add-label") {
			lines.push(box.row(`  名字：${this.theme.fg("muted", this.mode.name)}`));
			lines.push(box.row(`  用途：${this.mode.label}${this.theme.fg("dim", "▏")}`));
			lines.push(box.row(this.theme.fg("dim", "  给未来的自己看的说明，可留空")));
		} else if (this.mode.kind === "add-value") {
			const masked = MASK_CHAR.repeat(this.mode.value.length);
			lines.push(box.row(`  名字：${this.theme.fg("muted", this.mode.name)}`));
			if (this.mode.label) lines.push(box.row(`  用途：${this.theme.fg("muted", this.mode.label)}`));
			const shown = masked.length > 60 ? `${masked.slice(0, 60)}…（共 ${this.mode.value.length} 字符）` : masked;
			lines.push(box.row(`  值：${shown||this.theme.fg("dim", "▏")}`));
			lines.push(box.row(this.theme.fg("dim", "  只存在本会话内存，不落盘、不进对话")));
		} else if (this.mode.kind === "confirm-delete") {
			lines.push(box.row(`  确定删除 ${this.theme.fg("accent", `{{sec:${this.mode.name}}}`)} ？`));
			lines.push(box.row(this.theme.fg("dim", "  删除后本会话就取不到这个值了。")));
		}

		if (this.notice) {
			lines.push(box.row(""));
			lines.push(box.row(`  ${this.theme.fg("warning", this.notice)}`));
		}

		lines.push(box.row(""));
		lines.push(box.divider());
		const hint =
			this.mode.kind === "list"
				? "↑↓ 选择 · n 新增 · d 删除 · Esc 关闭"
				: this.mode.kind === "confirm-delete"
					? "y/Enter 删除 · n/Esc 取消"
					: "Enter 下一步 · Esc 返回";
		lines.push(box.hint(hint));
		lines.push(box.bottomBorder());
		return lines;
	}
}
