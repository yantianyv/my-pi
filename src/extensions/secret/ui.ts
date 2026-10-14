/**
 * secret / ui.ts — 掩码输入浮层与 /secret 面板
 *
 * 面板是唯一入口：条目管理、长期指纹表、设置、帮助全在里面，所以命令只需记 `/secret`。
 * 需要填字（新名字、改名、录入值）时才弹一个单行浮层——掩码沿用 perm-gate 的 sudo 密码框
 * 范式：明文只活在浮层内存里，渲染成等长的 •，Esc 取消。
 *
 * 面板本身不做事，只返回一个动作给 index.ts 执行，改完再打开一次；设置项例外，直接在面板
 * 内改（每次 render 从 deps 现读，所以改完当帧就生效）。
 *
 * 两个浮层都是自绘 overlay，pi 不会给 status-beacon 提供等待文案（custom 不带 title），
 * 进出必须自己登记 setWaiting。
 */
import { Key, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createBoxRenderer, editInput, renderScrollingInput } from "../shared/ui";
import { setWaiting } from "../shared/status";
import type { PublicFingerprint } from "./fingerprint";
import type { PublicEntry } from "./vault";

const SOURCE_LABEL: Record<string, string> = {
	prompt: "手工录入",
	paste: "粘贴捕获",
	file: "文件导入",
	output: "输出捕获",
};

const KIND_LABEL: Record<string, string> = { secret: "密钥", text: "文本" };

export function fmtAge(addedAt: number): string {
	const ms = Date.now() - addedAt;
	if (ms < 60_000) return "刚刚";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
	return `${Math.floor(ms / 86_400_000)} 天前`;
}

const fits = (text: string, width: number): string => {
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};

// ---------------------------------------------------------------------------
// 单行输入浮层（掩码 / 明文两用）
// ---------------------------------------------------------------------------

class LineOverlay {
	focused = false;
	private text = "";
	private cursor = 0;

	constructor(
		private theme: Theme,
		private title: string,
		private hint: string,
		private masked: boolean,
		private maxLength: number,
		private done: (value: string | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const value = this.text.trim();
			this.done(value.length > 0 ? value : null);
			return;
		}
		const next = editInput(this.text, this.cursor, data, { maxLength: this.maxLength });
		if (next !== "skip") {
			this.text = next.text;
			this.cursor = next.cursor;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(12, width - 2);
		const { row, topBorder, bottomBorder } = createBoxRenderer(th, innerW);
		const shown = this.masked ? "•".repeat(this.text.length) : this.text;
		const { display } = renderScrollingInput(shown, this.cursor, innerW - 4);
		const counter = this.masked && this.text.length > 0 ? th.fg("dim", ` ${this.text.length} 字符`) : "";
		return [topBorder(` ${this.title} `), row(` ${display}`), row(th.fg("dim", ` ${this.hint}`) + counter), bottomBorder()];
	}

	invalidate(): void {}
	dispose(): void {}
}

export interface LinePromptOptions {
	title: string;
	hint: string;
	masked?: boolean;
	maxLength?: number;
}

/** 弹一个单行输入框。无界面或用户取消时返回 null。 */
export async function promptLine(ctx: ExtensionContext, options: LinePromptOptions): Promise<string | null> {
	if (!ctx.hasUI) return null;
	setWaiting(`等待${options.masked ? "输入密钥" : "填写"}：${options.title}`.slice(0, 40));
	try {
		return await ctx.ui.custom<string | null>(
			(_tui, theme, _kb, done) =>
				new LineOverlay(theme, options.title, options.hint, options.masked ?? false, options.maxLength ?? 4096, done),
			{ overlay: true, overlayOptions: { width: "72%", minWidth: 52, maxHeight: "40%" } },
		);
	} finally {
		setWaiting(null);
	}
}

// ---------------------------------------------------------------------------
// /secret 面板
// ---------------------------------------------------------------------------

export type PanelAction =
	| { kind: "close" }
	| { kind: "toggle" }
	| { kind: "add"; text: boolean }
	| { kind: "copy"; name: string }
	| { kind: "rename"; name: string }
	| { kind: "remove"; name: string }
	| { kind: "fingerprint-toggle"; name: string }
	| { kind: "fingerprint-forget"; name: string }
	| { kind: "fingerprint-clear" };

export interface PanelSettings {
	confirm: "session" | "never";
	redactShapes: boolean;
	captureOnPaste: boolean;
	guessConfirm: boolean;
	fingerprints: boolean;
}

export interface PanelDeps {
	entries: () => PublicEntry[];
	enabled: () => boolean;
	fingerprints: () => PublicFingerprint[];
	fingerprintPath: () => string;
	settings: () => PanelSettings;
	setSettings: (patch: Partial<PanelSettings>) => void;
	/** 最近一次动作的人话回执。 */
	message?: string;
}

type View = "list" | "detail" | "fingerprints" | "settings" | "help";

const SETTING_ROWS: { key: keyof PanelSettings; label: string; value: (s: PanelSettings) => string }[] = [
	{ key: "confirm", label: "使用确认", value: (s) => (s.confirm === "session" ? "会话内首次确认" : "不确认") },
	{ key: "redactShapes", label: "形态脱敏", value: (s) => (s.redactShapes ? "开" : "关") },
	{ key: "captureOnPaste", label: "粘贴捕获", value: (s) => (s.captureOnPaste ? "开" : "关") },
	{ key: "guessConfirm", label: "高熵确认", value: (s) => (s.guessConfirm ? "开" : "关") },
	{ key: "fingerprints", label: "长期指纹表", value: (s) => (s.fingerprints ? "开" : "关") },
];

class SecretPanel {
	focused = false;
	private view: View;
	private selected = 0;
	private settingIndex = 0;

	constructor(
		private theme: Theme,
		private deps: PanelDeps,
		private done: (action: PanelAction) => void,
		initialView: View = "list",
	) {
		this.view = initialView;
	}

	private clamp(max: number): void {
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, max)));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.view === "list") this.done({ kind: "close" });
			else this.view = "list";
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.view === "settings") this.settingIndex = Math.max(0, this.settingIndex - 1);
			else {
				this.selected--;
				this.clamp(this.rowCount() - 1);
			}
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.view === "settings") this.settingIndex = Math.min(SETTING_ROWS.length - 1, this.settingIndex + 1);
			else {
				this.selected++;
				this.clamp(this.rowCount() - 1);
			}
			return;
		}
		if (this.view === "settings") this.handleSettings(data);
		else if (this.view === "list") this.handleList(data);
		else if (this.view === "detail") this.handleDetail(data);
		else if (this.view === "fingerprints") this.handleFingerprints(data);
	}

	private rowCount(): number {
		if (this.view === "list") return Math.max(1, this.deps.entries().length);
		if (this.view === "fingerprints") return Math.max(1, this.deps.fingerprints().length);
		return 1;
	}

	private handleList(data: string): void {
		const entries = this.deps.entries();
		const entry = entries[this.selected];
		if (matchesKey(data, Key.enter) && entry) {
			this.view = "detail";
			return;
		}
		switch (data.toLowerCase()) {
			case "a":
				this.done({ kind: "add", text: false });
				return;
			case "t":
				this.done({ kind: "add", text: true });
				return;
			case "o":
				this.done({ kind: "toggle" });
				return;
			case "f":
				this.selected = 0;
				this.view = "fingerprints";
				return;
			case "s":
				this.settingIndex = 0;
				this.view = "settings";
				return;
			case "?":
			case "h":
				this.view = "help";
				return;
			default:
				return;
		}
	}

	private handleDetail(data: string): void {
		const entry = this.deps.entries()[this.selected];
		if (!entry) {
			this.view = "list";
			return;
		}
		switch (data.toLowerCase()) {
			case "c":
				this.done({ kind: "copy", name: entry.name });
				return;
			case "r":
				this.done({ kind: "rename", name: entry.name });
				return;
			case "d":
				this.done({ kind: "remove", name: entry.name });
				return;
			case "f":
				this.done({ kind: "fingerprint-toggle", name: entry.name });
				return;
			default:
				return;
		}
	}

	private handleFingerprints(data: string): void {
		const rows = this.deps.fingerprints();
		const row = rows[this.selected];
		switch (data.toLowerCase()) {
			case "d":
				if (row) this.done({ kind: "fingerprint-forget", name: row.name });
				return;
			case "x":
				if (rows.length > 0) this.done({ kind: "fingerprint-clear" });
				return;
			default:
				return;
		}
	}

	private handleSettings(data: string): void {
		if (!matchesKey(data, Key.enter) && data !== " " && data !== "left" && data !== "right") return;
		const row = SETTING_ROWS[this.settingIndex];
		const current = this.deps.settings();
		switch (row.key) {
			case "confirm":
				this.deps.setSettings({ confirm: current.confirm === "session" ? "never" : "session" });
				return;
			case "redactShapes":
				this.deps.setSettings({ redactShapes: !current.redactShapes });
				return;
			case "captureOnPaste":
				this.deps.setSettings({ captureOnPaste: !current.captureOnPaste });
				return;
			case "guessConfirm":
				this.deps.setSettings({ guessConfirm: !current.guessConfirm });
				return;
			case "fingerprints":
				this.deps.setSettings({ fingerprints: !current.fingerprints });
				return;
		}
	}

	render(width: number): string[] {
		const innerW = Math.max(24, width - 2);
		const { row, topBorder, bottomBorder, divider } = createBoxRenderer(this.theme, innerW);
		if (this.view === "detail") return this.renderDetail(row, topBorder, bottomBorder, divider, innerW);
		if (this.view === "fingerprints") return this.renderFingerprints(row, topBorder, bottomBorder, divider, innerW);
		if (this.view === "settings") return this.renderSettings(row, topBorder, bottomBorder, divider, innerW);
		if (this.view === "help") return this.renderHelp(row, topBorder, bottomBorder, innerW);
		return this.renderList(row, topBorder, bottomBorder, divider, innerW);
	}

	private renderList(
		row: (t: string) => string,
		topBorder: (t?: string) => string,
		bottomBorder: () => string,
		divider: () => string,
		innerW: number,
	): string[] {
		const th = this.theme;
		const entries = this.deps.entries();
		const on = this.deps.enabled();
		const state = on ? th.fg("success", "ON") : th.fg("warning", "OFF");
		const lines = [
			topBorder(" 🔐 secret（值只在本进程内存里） "),
			row(` ${state} · ${th.fg("dim", `${entries.length} 条 · 长期指纹表 ${this.deps.fingerprints().length} 条`)}`),
			divider(),
		];
		if (entries.length === 0) {
			lines.push(row(th.fg("dim", " （空）按 a 录入密钥，或按 t 录入其它敏感文本")));
		} else {
			const nameW = Math.min(22, Math.max(...entries.map((e) => visibleWidth(e.name))) + 2);
			const metaW = Math.max(12, innerW - nameW - 6);
			entries.forEach((entry, index) => {
				const selected = index === this.selected;
				const mark = selected ? th.fg("accent", "❯") : " ";
				const name = selected ? th.fg("accent", fits(entry.name, nameW)) : fits(entry.name, nameW);
				const meta = [KIND_LABEL[entry.kind] ?? entry.kind, `${entry.length} 字符`, SOURCE_LABEL[entry.source] ?? entry.source, fmtAge(entry.addedAt)];
				const tail = `${entry.preview ? `${entry.preview} · ` : ""}${meta.join(" · ")}`;
				lines.push(row(` ${mark} ${name} ${th.fg("dim", truncateToWidth(tail, metaW, "…"))}`));
			});
		}
		lines.push(divider());
		lines.push(row(` ${th.fg("accent", "enter")} 打开条目 · ${th.fg("accent", "a")} 新增密钥 · ${th.fg("accent", "t")} 新增敏感文本`));
		lines.push(row(` ${th.fg("accent", "f")} 长期指纹表 · ${th.fg("accent", "s")} 设置 · ${th.fg("accent", "o")} 开关 · ${th.fg("accent", "?")} 帮助`));
		if (this.deps.message) lines.push(row(` ${th.fg("accent", this.deps.message)}`));
		lines.push(row(th.fg("dim", " ↑↓ 选择 · esc 关闭 · 值只读得到复制，不会被显示")));
		lines.push(bottomBorder());
		return lines;
	}

	private renderDetail(
		row: (t: string) => string,
		topBorder: (t?: string) => string,
		bottomBorder: () => string,
		divider: () => string,
		innerW: number,
	): string[] {
		const th = this.theme;
		const entry = this.deps.entries()[this.selected];
		if (!entry) {
			this.view = "list";
			return this.render(innerW + 2);
		}
		const inTable = this.deps.fingerprints().some((f) => f.name === entry.name);
		const lines = [
			topBorder(` 条目 ${entry.name} `),
			row(` 类型 ${KIND_LABEL[entry.kind] ?? entry.kind} · 长度 ${entry.length} 字符 · 来源 ${SOURCE_LABEL[entry.source] ?? entry.source} · ${fmtAge(entry.addedAt)}`),
		];
		if (entry.preview) lines.push(row(` 预览 ${th.fg("dim", entry.preview)}`));
		if (entry.label) lines.push(row(` 识别为 ${th.fg("dim", entry.label)}`));
		lines.push(divider());
		lines.push(row(` ${th.fg("accent", "c")} 复制值到剪贴板（值不会进对话）`));
		lines.push(row(` ${th.fg("accent", "r")} 改名`));
		lines.push(row(` ${th.fg("accent", "f")} ${inTable ? "从长期指纹表移出" : "写进长期指纹表（跨会话只留指纹）"}`));
		lines.push(row(` ${th.fg("accent", "d")} 删除（仅本会话；长期指纹表另管）`));
		if (this.deps.message) lines.push(row(` ${th.fg("accent", this.deps.message)}`));
		lines.push(row(th.fg("dim", " esc 返回")));
		lines.push(bottomBorder());
		return lines;
	}

	private renderFingerprints(
		row: (t: string) => string,
		topBorder: (t?: string) => string,
		bottomBorder: () => string,
		divider: () => string,
		innerW: number,
	): string[] {
		const th = this.theme;
		const rows = this.deps.fingerprints();
		const lines = [
			topBorder(" 长期指纹表（跨会话，只有指纹没有值） "),
			row(th.fg("dim", ` ${rows.length} 条 · ${this.deps.fingerprintPath()}`)),
			divider(),
		];
		if (rows.length === 0) {
			lines.push(row(th.fg("dim", " （空）录入 ≥16 字符的值时会自动记一条指纹")));
		} else {
			const nameW = Math.min(22, Math.max(...rows.map((r) => visibleWidth(r.name))) + 2);
			rows.forEach((item, index) => {
				const selected = index === this.selected;
				const mark = selected ? th.fg("accent", "❯") : " ";
				const name = selected ? th.fg("accent", fits(item.name, nameW)) : fits(item.name, nameW);
				const meta = [KIND_LABEL[item.kind] ?? item.kind, `${item.length} 字符`, `${item.count} 个指纹`, fmtAge(item.addedAt)];
				lines.push(row(` ${mark} ${name} ${th.fg("dim", meta.join(" · "))}`));
			});
		}
		lines.push(divider());
		lines.push(row(th.fg("warning", " 只能「认出来并遮住」，不能拿来执行（没有值）")));
		lines.push(row(` ${th.fg("accent", "d")} 删除选中 · ${th.fg("accent", "X")} 清空整表`));
		if (this.deps.message) lines.push(row(` ${th.fg("accent", this.deps.message)}`));
		lines.push(row(th.fg("dim", " ↑↓ 选择 · esc 返回")));
		lines.push(bottomBorder());
		return lines;
	}

	private renderSettings(
		row: (t: string) => string,
		topBorder: (t?: string) => string,
		bottomBorder: () => string,
		divider: () => string,
		innerW: number,
	): string[] {
		const th = this.theme;
		const settings = this.deps.settings();
		const lines = [
			topBorder(" 设置 "),
			row(` 总开关 ${this.deps.enabled() ? th.fg("success", "ON") : th.fg("warning", "OFF")}  ${th.fg("dim", "（o 键在列表页也可切）")}`),
			divider(),
		];
		SETTING_ROWS.forEach((item, index) => {
			const selected = index === this.settingIndex;
			const mark = selected ? th.fg("accent", "❯") : " ";
			const label = selected ? th.fg("accent", fits(item.label, 14)) : fits(item.label, 14);
			lines.push(row(` ${mark} ${label} ${item.value(settings)}`));
		});
		lines.push(divider());
		lines.push(row(th.fg("dim", " 使用确认：每个名字在本次会话内首次使用时问一次")));
		lines.push(row(th.fg("dim", " 形态脱敏：出口把像凭证的文字换成不可执行的占位")));
		lines.push(row(th.fg("dim", " 高熵确认：粘贴裸口令时问一次是不是密钥")));
		lines.push(row(th.fg("dim", " 长期指纹表：≥16 字符的值记指纹，跨会话仍能认出并遮住")));
		if (this.deps.message) lines.push(row(` ${th.fg("accent", this.deps.message)}`));
		lines.push(row(th.fg("dim", " ↑↓ 选择 · enter/空格 切换 · esc 返回")));
		lines.push(bottomBorder());
		return lines;
	}

	private renderHelp(row: (t: string) => string, topBorder: (t?: string) => string, bottomBorder: () => string, innerW: number): string[] {
		const th = this.theme;
		const dim = (t: string) => row(th.fg("dim", ` ${t}`));
		return [
			topBorder(" 怎么用 "),
			row(" AI 写 {{sec:名字}} 引用密钥，值在执行前一刻注入子进程。"),
			dim("它拿不到值，会话记录里也只有这个名字。"),
			row(""),
			row(" 录入：a 密钥 · t 敏感文本 · 粘贴进对话的凭证会自动收。"),
			row(" 复用：同一名字可以在多条命令里反复用。"),
			row(" 确认：本会话首次使用某名字时，会把命令摊开问你。"),
			row(" 关闭：o 键；关闭会清空本次会话已录入的值。"),
			row(""),
			row(" 值存在内存，退出即消失；长期指纹表只留指纹。"),
			dim("指纹能认出来并遮住，但不能拿来执行。"),
			row(""),
			row(" 挡不住的：截图里的密钥 · 同账户的其它程序 ·"),
			dim("模型用 shell 切片重建值 · 子代理自己的模型循环。"),
			row(""),
			row(th.fg("dim", " esc 返回")),
			bottomBorder(),
		];
	}

	invalidate(): void {}
	dispose(): void {}
}

/** 打开面板并等一个动作。无界面时立即返回 close。 */
export async function openSecretPanel(ctx: ExtensionContext, deps: PanelDeps, initialView?: View): Promise<PanelAction> {
	if (!ctx.hasUI) return { kind: "close" };
	setWaiting("等待选择：secret 面板");
	try {
		return await ctx.ui.custom<PanelAction>((_tui, theme, _kb, done) => new SecretPanel(theme, deps, done, initialView), {
			overlay: true,
			overlayOptions: { width: "86%", minWidth: 58, maxHeight: "85%" },
		});
	} finally {
		setWaiting(null);
	}
}
