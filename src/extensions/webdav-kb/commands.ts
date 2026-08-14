/**
 * webdav-kb / commands.ts — /kb-config 配置命令 + /kb-sync 手动同步
 *
 * /kb-config 交互式配置（TUI 用 ui.select/ui.input 对话框流；非 TUI 文本面板）：
 *   - 设置 WebDAV 地址 / 用户名 / 密码 / 代理 / 镜像目录
 *   - vault 口令：启用/修改（createVault 生成 salt+check，口令只存内存立即解锁）、
 *     解锁 / 锁定 / 记住口令（面板动作开关）
 *   - 连通性测试（ping 根目录）
 * 也支持带参直设：/kb-config url <url> / user / pass / proxy / mirror / vault / vault-unlock / vault-lock / test
 *
 * /kb-sync：手动增量同步（session_start 已自动后台同步，此处用于首次/异常后手动触发）
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { setStatusWithTTL } from "../shared/status";
import { loadConfig, saveConfig, isConfigured, defaultMirrorDir, agentConfigDir } from "./store";
import { syncAll } from "./sync";
import { WebDavClient } from "./client";
import { createVault, unlockVault, isUnlocked, lockVault, storeVaultKey } from "./crypto";
import { KbConfigOverlay } from "./panel-config";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

type Cfg = ReturnType<typeof loadConfig>;

function maskPassword(p?: string): string {
	if (!p) return "（未设置）";
	return p.length <= 4 ? "***" : `${p.slice(0, 2)}${"*".repeat(Math.max(4, p.length - 4))}`;
}

/** 当前配置的文本摘要（非 TUI 面板 / 查看配置用） */
function configSummary(cfg: Cfg, unlocked: boolean): string {
	const mirror = cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
	return [
		`WebDAV：${cfg.baseUrl || "（未设置）"}`,
		`账号：${cfg.username || "（未设置）"} ／ 密码：${maskPassword(cfg.password)}`,
		`代理：${cfg.proxyUrl || "（直连）"}`,
		`镜像目录：${mirror}`,
		`vault 加密区：${cfg.vault ? (unlocked ? "🔓 已解锁" : "🔒 已启用，未解锁") + (cfg.persistVault ? "（口令已记忆）" : "") : "（未启用）"}`,
	].join("\n");
}

function usageText(): string {
	return [
		"/kb-config                     交互式配置",
		"/kb-config url <地址>           设置 WebDAV 地址（如 https://dav.123pan.com/dav）",
		"/kb-config user <用户名>        设置用户名",
		"/kb-config pass <密码>          设置密码",
		"/kb-config proxy <地址>         设置 HTTP 代理（空 = 清除）",
		"/kb-config mirror <目录>        设置本地镜像目录",
		"/kb-config vault <口令>         启用/修改 vault 加密区口令",
		"/kb-config vault-unlock <口令>  解锁 vault",
		"/kb-config vault-lock           锁定 vault",
		"/kb-config test                 连通性测试",
		"/kb-config test                 连通性测试",
		"/kb-sync                        手动增量同步",
	].join("\n");
}

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

export function registerKbCommands(pi: ExtensionAPI): void {
	// ---------- /kb-config ----------
	pi.registerCommand("kb-config", {
		description: "知识库（WebDAV）配置：地址/凭据/代理/vault 口令/连通测试",
		async handler(args, ctx) {
			const cfg = loadConfig(agentConfigDir());
			const arg = args.trim();
			if (arg) {
				await handleSubcommand(arg, cfg, ctx);
				return;
			}
			if (ctx.hasUI && ctx.mode === "tui") {
				await openConfigPanel(ctx, cfg);
				return;
			}
			// 非 TUI 文本回落
			ctx.ui.notify(`知识库配置\n${configSummary(cfg, isUnlocked())}\n\n${usageText()}`, "info");
		},
	});

	// ---------- /kb-sync ----------
	pi.registerCommand("kb-sync", {
		description: "手动增量同步知识库镜像（启动时已自动同步，此命令用于手动触发）",
		async handler(_args, ctx) {
			const cfg = loadConfig(agentConfigDir());
			if (!isConfigured(cfg)) {
				ctx.ui.notify("知识库未配置：请先运行 /kb-config 设置 WebDAV 地址与账号。", "warning");
				return;
			}
			const mirrorDir = cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
			const push = (t: string, ttl: number) => setStatusWithTTL(ctx, "kb-sync", t, ttl);
			try {
				push("🔄 同步中", 30_000);
				const stats = await syncAll(cfg, mirrorDir, {
					onProgress: (label) => push(`🔄 ${label}`, 30_000),
				});
				const parts: string[] = [];
				if (stats.downloaded) parts.push(`下载 ${stats.downloaded}`);
				if (stats.uploaded) parts.push(`上传 ${stats.uploaded}`);
				if (stats.deleted) parts.push(`删除 ${stats.deleted}`);
				if (stats.conflicts) parts.push(`冲突 ${stats.conflicts}（已保留 .conflict 副本）`);
				if (parts.length === 0) parts.push("已是最新");
				if (stats.errors.length) parts.push(`失败 ${stats.errors.length}`);
				push(`📚 ${parts.join("，")}`, 8_000);
				ctx.ui.notify(`同步完成：${parts.join("，")}`, stats.errors.length ? "warning" : "info");
			} catch (e) {
				push(`⚠ 同步失败：${e instanceof Error ? e.message : String(e)}`, 10_000);
				ctx.ui.notify(`同步失败：${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});
}

// ---------------------------------------------------------------------------
// 带参子命令
// ---------------------------------------------------------------------------

async function handleSubcommand(arg: string, cfg: Cfg, ctx: ExtensionCommandContext): Promise<void> {
	const space = arg.indexOf(" ");
	const cmd = (space < 0 ? arg : arg.slice(0, space)).trim().toLowerCase();
	const value = (space < 0 ? "" : arg.slice(space + 1).trim()).replace(/^["']|["']$/g, "");

	switch (cmd) {
		case "url":
			saveConfig(agentConfigDir(), { ...cfg, baseUrl: value });
			ctx.ui.notify(`WebDAV 地址已设为 ${value}`, "info");
			return;
		case "user":
			saveConfig(agentConfigDir(), { ...cfg, username: value });
			ctx.ui.notify(`用户名已设为 ${value}`, "info");
			return;
		case "pass":
			saveConfig(agentConfigDir(), { ...cfg, password: value });
			ctx.ui.notify("密码已设置", "info");
			return;
		case "proxy":
			saveConfig(agentConfigDir(), { ...cfg, proxyUrl: value || undefined });
			ctx.ui.notify(value ? `代理已设为 ${value}` : "代理已清除（直连）", "info");
			return;
		case "mirror":
			saveConfig(agentConfigDir(), { ...cfg, mirrorDir: value });
			ctx.ui.notify(`镜像目录已设为 ${value}`, "info");
			return;
		case "vault":
			if (!value) {
				ctx.ui.notify("用法：/kb-config vault <口令>", "warning");
				return;
			}
			setupVault(cfg, value, ctx);
			return;
		case "vault-unlock":
			if (!value) {
				ctx.ui.notify("用法：/kb-config vault-unlock <口令>", "warning");
				return;
			}
			if (cfg.vault) {
				const key = unlockVault(value, cfg.vault, cfg.persistVault);
				if (key) {
					if (cfg.persistVault) storeVaultKey(key, cfg);
					ctx.ui.notify("🔓 vault 已解锁", "info");
				} else {
					ctx.ui.notify("口令错误，vault 保持锁定", "error");
				}
			}
			return;
		case "vault-lock":
			lockVault(agentConfigDir());
			ctx.ui.notify("🔒 vault 已锁定（内存+磁盘密钥已清除）", "info");
			return;
		case "test":
			await testConnection(cfg, ctx);
			return;
		default:
			ctx.ui.notify(`未知子命令：${cmd}\n${usageText()}`, "warning");
	}
}

/** 启用/修改 vault 口令（createVault 生成新 salt+check，立即解锁）。修改口令不迁移存量密文，给出提示 */
function setupVault(cfg: Cfg, pass: string, ctx: ExtensionCommandContext): void {
	if (cfg.vault && isUnlocked()) {
		ctx.ui.notify(
			"注意：修改口令后，已存在的 vault 密文仍用旧口令加密，需先逐篇读取并用新口令重写迁移（本版不自动迁移）。",
			"warning",
		);
	}
	const setup = createVault(pass);
	saveConfig(agentConfigDir(), { ...cfg, vault: setup });
	const key = unlockVault(pass, setup, cfg.persistVault);
	if (key && cfg.persistVault) storeVaultKey(key, cfg);
	ctx.ui.notify("🔓 vault 已启用并解锁" + (cfg.persistVault ? "（口令已持久化，下次启动自动解锁）" : "（口令仅存内存）"), "info");
}

/** 连通性测试：ping 根目录 */
async function testConnection(cfg: Cfg, ctx: ExtensionCommandContext): Promise<void> {
	if (!isConfigured(cfg)) {
		ctx.ui.notify("请先设置 WebDAV 地址与账号。", "warning");
		return;
	}
	setStatusWithTTL(ctx, "kb-test", "🔌 测试连通…", 30_000);
	try {
		const client = new WebDavClient(cfg.baseUrl!, cfg.username!, cfg.password!, {
			proxyUrl: cfg.proxyUrl,
			timeoutMs: 10_000,
		});
		await client.ping();
		setStatusWithTTL(ctx, "kb-test", "✅ 连通正常", 6_000);
		ctx.ui.notify("✅ WebDAV 连通正常，凭据有效。", "info");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		setStatusWithTTL(ctx, "kb-test", "❌ 连通失败", 6_000);
		ctx.ui.notify(`❌ 连通失败：${msg}`, "error");
	}
}

// ---------------------------------------------------------------------------
// TUI 表单面板
// ---------------------------------------------------------------------------

/** 打开 /kb-config 表单浮层（一次看到全部配置项，行内编辑） */
async function openConfigPanel(ctx: ExtensionCommandContext, cfg: Cfg): Promise<void> {
	await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => new KbConfigOverlay(tui, theme, loadConfig(agentConfigDir()), done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "right-center",
				width: "58%",
				minWidth: 58,
				maxHeight: "80%",
				margin: { right: 1 },
			},
		},
	);
}

// ---------------------------------------------------------------------------
// TUI 交互菜单（旧版，保留供参考；当前 TUI 走 openConfigPanel）
// ---------------------------------------------------------------------------

async function interactiveMenu(cfg: Cfg, ctx: ExtensionCommandContext): Promise<void> {
	const choice = await ctx.ui.select("知识库配置", [
		"查看当前配置",
		"设置 WebDAV 地址",
		"设置用户名 / 密码",
		"设置 HTTP 代理",
		"设置镜像目录",
		"设置 vault 口令（启用/修改）",
		"解锁 / 锁定 vault",
		"连通性测试",
		"立即同步",
	]);
	if (!choice) return;

	switch (choice) {
		case "查看当前配置":
			ctx.ui.notify(configSummary(cfg, isUnlocked()), "info");
			return;
		case "设置 WebDAV 地址": {
			const url = await ctx.ui.input("WebDAV 地址", cfg.baseUrl ?? "https://dav.123pan.com/dav");
			if (!url) return;
			saveConfig(agentConfigDir(), { ...cfg, baseUrl: url.trim() });
			ctx.ui.notify(`已设置：${url.trim()}`, "info");
			return;
		}
		case "设置用户名 / 密码": {
			const user = await ctx.ui.input("用户名", cfg.username ?? "");
			if (!user) return;
			const pass = await ctx.ui.input("密码", cfg.password ?? "");
			if (pass === undefined) return;
			saveConfig(agentConfigDir(), { ...cfg, username: user.trim(), password: pass });
			ctx.ui.notify(`已设置账号 ${user.trim()}`, "info");
			return;
		}
		case "设置 HTTP 代理": {
			const proxy = await ctx.ui.input("HTTP 代理地址（留空 = 清除）", cfg.proxyUrl ?? "");
			if (proxy === undefined) return;
			saveConfig(agentConfigDir(), { ...cfg, proxyUrl: proxy.trim() || undefined });
			ctx.ui.notify(proxy.trim() ? `代理已设为 ${proxy.trim()}` : "代理已清除（直连）", "info");
			return;
		}
		case "设置镜像目录": {
			const mirror = await ctx.ui.input("本地镜像目录", cfg.mirrorDir ?? defaultMirrorDir(agentConfigDir()));
			if (!mirror) return;
			saveConfig(agentConfigDir(), { ...cfg, mirrorDir: mirror.trim() });
			ctx.ui.notify(`镜像目录已设为 ${mirror.trim()}`, "info");
			return;
		}
		case "设置 vault 口令（启用/修改）": {
			const pass = await ctx.ui.input("vault 口令（启用/修改；旧口令加密的存量文件需手动迁移）");
			if (!pass) return;
			setupVault(cfg, pass, ctx);
			return;
		}
		case "解锁 / 锁定 vault": {
			if (!cfg.vault) {
				ctx.ui.notify("vault 未启用：先「设置 vault 口令」。", "warning");
				return;
			}
			const op = await ctx.ui.select("vault 状态", isUnlocked() ? ["锁定", "重新解锁"] : ["解锁", "取消"]);
			if (op === "锁定") {
				lockVault(agentConfigDir());
				ctx.ui.notify("🔒 vault 已锁定", "info");
			} else if (op === "解锁") {
				const pass = await ctx.ui.input("vault 口令");
				if (!pass) return;
				const key = unlockVault(pass, cfg.vault, cfg.persistVault);
				if (key) {
					if (cfg.persistVault) storeVaultKey(key, cfg);
					ctx.ui.notify("🔓 vault 已解锁", "info");
				} else {
					ctx.ui.notify("口令错误", "error");
				}
			}
			return;
		}
		case "连通性测试":
			await testConnection(cfg, ctx);
			return;
		case "立即同步": {
			// 复用 /kb-sync 的逻辑（直接调用 syncAll）
			const mirrorDir = cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
			if (!isConfigured(cfg)) {
				ctx.ui.notify("请先设置 WebDAV 地址与账号。", "warning");
				return;
			}
			const push = (t: string, ttl: number) => setStatusWithTTL(ctx, "kb-sync", t, ttl);
			push("🔄 同步中", 30_000);
			try {
				const stats = await syncAll(cfg, mirrorDir, { onProgress: (l) => push(`🔄 ${l}`, 30_000) });
				push(`📚 ↓${stats.downloaded} ↑${stats.uploaded} ×${stats.deleted} ⚠${stats.conflicts}`, 8_000);
				ctx.ui.notify(`同步完成：↓${stats.downloaded} ↑${stats.uploaded} ×${stats.deleted} ⚠冲突${stats.conflicts}`, "info");
			} catch (e) {
				ctx.ui.notify(`同步失败：${e instanceof Error ? e.message : String(e)}`, "error");
			}
			return;
		}
	}
}
