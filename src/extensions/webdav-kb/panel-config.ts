/**
 * webdav-kb / panel-config.ts — /kb-config 的 TUI 单页表单面板
 *
 * 一页显示全部输入框：每个字段一行（焦点行 = 输入框 + 光标，非焦点行 = 显示值
 * 掩码），↑↓ 移动焦点、直接打字即改即存（防丢失）、Enter 移到下一项、
 * Esc 关闭。底部动作行（测试连通 / 立即同步 / 修改 vault 口令 / 锁定 vault）
 * Enter 直接执行。无二级页面。
 *
 * vault 字段语义：焦点时直接输入口令，Enter 后——未启用 → 启用并解锁；
 * 已启用未解锁 → 尝试解锁；已解锁时输入 = 修改口令（覆盖 setup，提示迁移）。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { createBoxRenderer, editInput, renderInputWithCursor } from "../shared/ui";
import { loadConfig, saveConfig, isConfigured, defaultMirrorDir, agentConfigDir, type KbConfig } from "./store";
import { syncAll } from "./sync";
import { WebDavClient } from "./client";
import { createVault, unlockVault, lockVault, isUnlocked, storeVaultKey, persistCurrentKey } from "./crypto";

// ---------------------------------------------------------------------------
// 字段与动作定义
// ---------------------------------------------------------------------------

type FieldKey = "baseUrl" | "username" | "password" | "proxyUrl" | "mirrorDir" | "vault";
type ActionKey = "test" | "sync" | "vault-change" | "vault-lock" | "vault-remember" | "vault-remember-off" | "readonly" | "readonly-off";

interface Field {
	key: FieldKey;
	label: string;
	/** 显示值（非焦点行，掩码后） */
	display(cfg: KbConfig): string;
	/** 编辑初始值 */
	seed(cfg: KbConfig): string;
	/** 保存：输入 → 写回 cfg（vault 不在此处理，走 Enter 语义） */
	apply(cfg: KbConfig, value: string): void;
	/** 焦点时是否掩码（密码类） */
	maskOnFocus?: boolean;
}

const FIELDS: Field[] = [
	{
		key: "baseUrl",
		label: "WebDAV 地址",
		display: (c) => c.baseUrl || "（未设置）",
		seed: (c) => c.baseUrl ?? "https://dav.123pan.com/dav",
		apply: (c, v) => (c.baseUrl = v.trim() || undefined),
	},
	{
		key: "username",
		label: "用户名",
		display: (c) => c.username || "（未设置）",
		seed: (c) => c.username ?? "",
		apply: (c, v) => (c.username = v.trim() || undefined),
	},
	{
		key: "password",
		label: "密码",
		display: (c) => {
			const p = c.password;
			if (!p) return "（未设置）";
			return p.length <= 4 ? "●●●●" : `${p.slice(0, 2)}${"●".repeat(Math.max(4, p.length - 4))}`;
		},
		seed: (c) => c.password ?? "",
		apply: (c, v) => (c.password = v || undefined),
		maskOnFocus: true,
	},
	{
		key: "proxyUrl",
		label: "HTTP 代理",
		display: (c) => c.proxyUrl || "（直连）",
		seed: (c) => c.proxyUrl ?? "",
		apply: (c, v) => (c.proxyUrl = v.trim() || undefined),
	},
	{
		key: "mirrorDir",
		label: "镜像目录",
		display: (c) => c.mirrorDir || defaultMirrorDir(agentConfigDir()),
		seed: (c) => c.mirrorDir ?? defaultMirrorDir(agentConfigDir()),
		apply: (c, v) => (c.mirrorDir = v.trim() || undefined),
	},
	{
		key: "vault",
		label: "vault 口令",
		display: (c) =>
			c.vault ? (isUnlocked() ? "🔓 已解锁" : "🔒 未解锁") : "（未启用）",
		seed: () => "",
		apply: () => {}, // vault 不即时保存，Enter 时处理
		maskOnFocus: true,
	},
];

interface Action {
	key: ActionKey;
	label: string;
	visible(cfg: KbConfig): boolean;
}

const ACTIONS: Action[] = [
	{ key: "test", label: "① 测试连通", visible: () => true },
	{ key: "sync", label: "② 立即同步", visible: () => true },
	{ key: "vault-change", label: "③ 修改 vault 口令", visible: (c) => Boolean(c.vault) },
	{ key: "vault-remember", label: "④ 记住口令：关", visible: (c) => Boolean(c.vault) && !c.persistVault },
	{ key: "vault-remember-off", label: "④ 记住口令：开", visible: (c) => Boolean(c.vault) && Boolean(c.persistVault) },
	{ key: "vault-lock", label: "⑤ 锁定 vault", visible: () => isUnlocked() },
	{ key: "readonly", label: "⑥ 只读模式：关", visible: (c) => !c.readOnly },
	{ key: "readonly-off", label: "⑥ 只读模式：开", visible: (c) => Boolean(c.readOnly) },
];

/** 统计镜像 /vault/ 下存量密文数量（改口令警告用；目录不存在/读取失败返回 0） */
function countVaultBlobs(mirrorDir: string): number {
	try {
		const vaultDir = path.join(mirrorDir, "vault");
		if (!fs.existsSync(vaultDir)) return 0;
		let n = 0;
		const walk = (d: string): void => {
			for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
				if (ent.isDirectory()) walk(path.join(d, ent.name));
				else if (ent.name.endsWith(".enc")) n++;
			}
		};
		walk(vaultDir);
		return n;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// 面板组件（单页表单）
// ---------------------------------------------------------------------------

export class KbConfigOverlay {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private done: (result: string | null) => void;
	private cfg: KbConfig;

	/** 每个字段的编辑缓冲（含光标） */
	private bufs: Record<FieldKey, string> = {} as Record<FieldKey, string>;
	private cursors: Record<FieldKey, number> = {} as Record<FieldKey, number>;
	/** 待二次确认的改口令（有存量密文时第一次 Enter 只警告不执行，再次输入同口令 Enter 才确认） */
	private pendingVaultChange: string | null = null;
	/** 焦点索引：0..fields-1 字段，之后是可见动作 */
	private focus = 0;
	/** 正在执行的动作标签 */
	private working: string | null = null;
	/** 最近一次结果提示 */
	private result: string | null = null;

	constructor(tui: TUI, theme: Theme, cfg: KbConfig, done: (result: string | null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.cfg = { ...cfg, vault: cfg.vault ? { ...cfg.vault } : undefined };
		this.done = done;
		for (const f of FIELDS) {
			const seed = f.seed(this.cfg);
			this.bufs[f.key] = seed;
			this.cursors[f.key] = seed.length;
		}
	}

	// ---- 焦点与可见项 ----

	private visibleActions(): Action[] {
		return ACTIONS.filter((a) => a.visible(this.cfg));
	}

	/** 当前焦点指向什么 */
	private currentTarget(): { kind: "field"; field: Field } | { kind: "action"; action: Action } | null {
		if (this.focus < FIELDS.length) return { kind: "field", field: FIELDS[this.focus] };
		const acts = this.visibleActions();
		const idx = this.focus - FIELDS.length;
		const action = acts[idx];
		return action ? { kind: "action", action } : null;
	}

	private totalTargets(): number {
		return FIELDS.length + this.visibleActions().length;
	}

	private clampFocus(): void {
		this.focus = Math.max(0, Math.min(this.focus, this.totalTargets() - 1));
	}

	// ---- 键盘 ----

	handleInput(data: string): void {
		if (this.working) return; // 动作执行中忽略输入
		if (matchesKey(data, "escape")) {
			// vault 口令已输入未按 Enter：先警告（第一次 Esc），再按一次 Esc 才放弃（防误丢，不卡死）
			if (this.bufs.vault && this.result !== "⚠ vault 口令未按 Enter 保存，再按 Esc 放弃") {
				this.result = "⚠ vault 口令未按 Enter 保存，再按 Esc 放弃";
				this.tui.requestRender();
				return;
			}
			this.done(null);
			return;
		}
		if (matchesKey(data, "return")) {
			this.handleEnter();
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.focus > 0) {
				this.focus--;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.focus < this.totalTargets() - 1) {
				this.focus++;
				this.tui.requestRender();
			}
			return;
		}
		const target = this.currentTarget();
		if (!target || target.kind !== "field") return;
		const f = target.field;
		// 编辑键（粘贴/backspace/left/right/home/end/delete/ctrl+u/可打印）统一走 shared/ui editInput
		const before = this.bufs[f.key];
		const r = editInput(before, this.cursors[f.key], data);
		if (r !== "skip") {
			this.bufs[f.key] = r.text;
			this.cursors[f.key] = r.cursor;
			if (r.text !== before) this.saveField(f); // 内容变化才持久化
			this.tui.requestRender();
		}
	}

	private handleEnter(): void {
		const target = this.currentTarget();
		if (!target) return;
		if (target.kind === "field") {
			const f = target.field;
			if (f.key === "vault") {
				this.handleVaultEnter();
			}
			// 字段上 Enter = 移到下一项
			if (this.focus < this.totalTargets() - 1) {
				this.focus++;
			}
			this.tui.requestRender();
			return;
		}
		this.runAction(target.action.key);
	}

	/** vault 字段 Enter：输入口令 → 启用/解锁/修改 */
	private handleVaultEnter(): void {
		const pass = this.bufs.vault.trim();
		if (!pass) return;
		if (!this.cfg.vault) {
			const setup = createVault(pass);
			this.cfg.vault = setup;
			saveConfig(agentConfigDir(), this.cfg);
			const key = unlockVault(pass, setup, this.cfg.persistVault);
			if (key && this.cfg.persistVault) storeVaultKey(key, this.cfg);
			this.result = "🔓 vault 已启用并解锁" + (this.cfg.persistVault ? "（口令已持久化）" : "");
		} else if (isUnlocked()) {
			// 已解锁：视为修改口令。存量密文不会自动迁移——有旧密文时第一次 Enter 只警告，
			// 再次输入同一口令按 Enter 才确认执行（防误改导致旧笔记永久不可解密）
			const mirrorDir = this.cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
			const blobs = countVaultBlobs(mirrorDir);
			if (blobs > 0 && this.pendingVaultChange !== pass) {
				this.pendingVaultChange = pass;
				this.result = `⚠ 镜像中有 ${blobs} 篇旧口令加密的笔记，改口令后只能用旧口令解密（需手动迁移）。确认修改请重新输入该口令再按 Enter`;
				this.bufs.vault = "";
				this.cursors.vault = 0;
				this.tui.requestRender();
				return;
			}
			this.pendingVaultChange = null;
			const setup = createVault(pass);
			this.cfg.vault = setup;
			saveConfig(agentConfigDir(), this.cfg);
			const key = unlockVault(pass, setup, this.cfg.persistVault);
			if (key && this.cfg.persistVault) storeVaultKey(key, this.cfg);
			this.result =
				"🔓 vault 口令已更新" +
				(this.cfg.persistVault ? "（口令已持久化）" : "") +
				(blobs > 0 ? `（⚠ ${blobs} 篇旧密文需用旧口令手动迁移）` : "");
		} else {
			const key = unlockVault(pass, this.cfg.vault, this.cfg.persistVault);
			if (key) {
				if (this.cfg.persistVault) storeVaultKey(key, this.cfg);
				this.result = "🔓 vault 已解锁";
			} else {
				this.result = "口令错误，仍锁定";
			}
		}
		this.bufs.vault = "";
		this.cursors.vault = 0;
	}

	/** 字段变更即时保存（vault 除外） */
	private saveField(f: Field): void {
		if (f.key === "vault") {
			this.tui.requestRender();
			return;
		}
		f.apply(this.cfg, this.bufs[f.key]);
		saveConfig(agentConfigDir(), this.cfg);
		this.tui.requestRender();
	}

	// ---- 动作 ----

	private runAction(key: ActionKey): void {
		switch (key) {
			case "test":
				this.working = "测试连通…";
				void this.testConnection();
				return;
			case "sync":
				this.working = "同步中…";
				void this.runSync();
				return;
			case "vault-change": {
				// 输入新口令 → Enter 覆盖（与已解锁时 vault 行输入语义一致，这里只是把焦点放过去）
				if (this.focus >= FIELDS.length) this.focus = FIELDS.length - 1; // vault 字段
				this.bufs.vault = "";
				this.cursors.vault = 0;
				this.result = "输入新口令后按 Enter（存量密文需手动迁移）";
				this.tui.requestRender();
				return;
			}
			case "vault-lock": {
				lockVault(agentConfigDir()); // 清内存密钥 + 磁盘持久化密钥
				this.cfg.vaultKey = undefined;
				this.cfg.persistVault = undefined;
				saveConfig(agentConfigDir(), this.cfg);
				this.result = "✅ vault 已锁定（内存与磁盘密钥已清除）";
				this.tui.requestRender();
				return;
			}
			case "vault-remember":
			case "vault-remember-off": {
				const on = key === "vault-remember";
				this.cfg.persistVault = on ? true : undefined;
				if (on) {
					if (isUnlocked()) {
						persistCurrentKey(this.cfg);
						this.result = "✅ 已记住口令（当前及下次启动自动解锁）";
					} else {
						this.result = "✅ 已记住口令，解锁后自动保存密钥";
					}
				} else {
					this.cfg.vaultKey = undefined;
					lockVault(agentConfigDir());
					this.result = "✅ 已取消记住口令，磁盘+内存密钥已清除";
				}
				saveConfig(agentConfigDir(), this.cfg);
				this.tui.requestRender();
				return;
			}
			case "readonly":
			case "readonly-off": {
				this.cfg.readOnly = key === "readonly" ? true : undefined;
				saveConfig(agentConfigDir(), this.cfg);
				this.result = `✅ 只读模式已${key === "readonly" ? "开启" : "关闭"}（下次会话生效）`;
				this.tui.requestRender();
				return;
			}
		}
	}

	private async testConnection(): Promise<void> {
		try {
			if (!isConfigured(this.cfg)) throw new Error("未设置 WebDAV 地址或账号");
			const client = new WebDavClient(this.cfg.baseUrl!, this.cfg.username!, this.cfg.password!, {
				proxyUrl: this.cfg.proxyUrl,
				timeoutMs: 10_000,
			});
			await client.ping();
			this.result = "✅ 连通正常，凭据有效";
		} catch (e) {
			this.result = `❌ 连通失败：${e instanceof Error ? e.message : String(e)}`;
		}
		this.working = null;
		this.tui.requestRender();
	}

	private async runSync(): Promise<void> {
		try {
			if (!isConfigured(this.cfg)) throw new Error("未设置 WebDAV 地址或账号");
			const mirrorDir = this.cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
			const stats = await syncAll(this.cfg, mirrorDir, {
				onProgress: (label) => {
					this.working = label;
					this.tui.requestRender();
				},
			});
			const parts = [`↓${stats.downloaded} ↑${stats.uploaded} ×${stats.deleted} ⚠${stats.conflicts}`];
			if (stats.errors.length) parts.push(`失败 ${stats.errors.length}`);
			this.result = `同步完成：${parts.join("，")}`;
		} catch (e) {
			this.result = `同步失败：${e instanceof Error ? e.message : String(e)}`;
		}
		this.working = null;
		this.tui.requestRender();
	}

	// ---- 渲染 ----

	render(width: number): string[] {
		const t = this.theme;
		const innerW = Math.max(30, width - 2);
		const { row, topBorder, bottomBorder, divider } = createBoxRenderer(t, innerW);
		const lines: string[] = [topBorder()];
		lines.push(row(t.fg("accent", t.bold(" ⚙ 知识库配置（↑↓ 选择 · 直接输入即改）"))));
		lines.push(divider());

		// 字段：焦点行 = 输入框 + 光标；非焦点 = 显示值
		FIELDS.forEach((f, i) => {
			const focused = i === this.focus;
			const labelW = 10;
			const label = f.label.padEnd(labelW, " ");
			let value: string;
			if (focused) {
				// 焦点行：明文缓冲 + 光标（密码/vault 掩码）
				const raw = this.bufs[f.key];
				const disp = f.maskOnFocus ? "●".repeat(raw.length) : raw;
				if (raw.length === 0 && f.key === "vault") {
					value = "（输入口令，按 Enter 启用）";
				} else {
					const inputW = innerW - labelW - 2;
					const visible = truncateToWidth(disp, inputW);
					const curInWindow = Math.min(this.cursors[f.key], visible.length);
					value = renderInputWithCursor(visible, curInWindow);
				}
			} else {
				value = f.display(this.cfg);
				// vault 已输入但未按 Enter（未保存）→ 警告提示，防丢失
				if (f.key === "vault" && this.bufs.vault) {
					value = "⚠ 未确认（回到本行按 Enter 启用）";
				}
			}
			const fieldRow = `${label} ${value}`;
			lines.push(focused ? row(`\x1b[7m${fieldRow}\x1b[27m`) : row(t.fg("text", fieldRow)));
		});

		// 动作行
		lines.push(divider());
		this.visibleActions().forEach((a, i) => {
			const focused = FIELDS.length + i === this.focus;
			const actRow = ` ${a.label}`;
			lines.push(focused ? row(`\x1b[7m${actRow}\x1b[27m`) : row(t.fg("accent", actRow)));
		});

		// 状态行
		lines.push(divider());
		const status = this.working ?? this.result ?? (isConfigured(this.cfg) ? "✓ 已配置（改动即时保存）" : "⚠ 未配置完整");
		const statusColor = this.working ? "accent" : this.result?.startsWith("❌") ? "error" : this.result?.startsWith("⚠") ? "warning" : "dim";
		lines.push(row(t.fg(statusColor as "accent", ` ${status}`)));

		const hint = `↑↓ 选择 · 直接输入即改 · Enter 下一项/执行 · Esc 关闭`;
		lines.push(row(t.fg("dim", hint)));
		lines.push(bottomBorder());
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
