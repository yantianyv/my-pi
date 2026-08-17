/**
 * webdav-kb / commands.ts — /kb-config 配置命令 + /kb-sync 手动同步
 *
 * /kb-config：所有配置修改统一走 TUI 单页表单面板（KbConfigOverlay：WebDAV 地址 /
 *   用户名 / 密码 / 代理 / 镜像目录 / vault 口令 / 测试连通 / 立即同步 / 只读模式，
 *   改动即存）。不带任何子命令（0.5 决策：面板已全覆盖全部配置项，子命令与面板
 *   重复，全部移除；非 TUI 环境仅打印当前配置摘要与 TUI 面板提示）。
 *
 * /kb-sync：手动增量同步（session_start 已自动后台同步，此处用于首次/异常后手动触发）
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { setStatusWithTTL } from "../shared/status";
import { loadConfig, isConfigured, defaultMirrorDir, agentConfigDir } from "./store";
import { syncAll } from "./sync";
import { isUnlocked } from "./crypto";
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

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

export function registerKbCommands(pi: ExtensionAPI): void {
	// ---------- /kb-config ----------
	pi.registerCommand("kb-config", {
		description: "知识库（WebDAV）配置面板：地址/凭据/代理/vault 口令/连通测试/只读模式（TUI 交互，无子命令）",
		async handler(_args, ctx) {
			const cfg = loadConfig(agentConfigDir());
			// 所有配置修改均通过 TUI 面板完成；参数一律忽略（不再有子命令）
			if (ctx.hasUI && ctx.mode === "tui") {
				await openConfigPanel(ctx, cfg);
				return;
			}
			// 非 TUI 文本回落：仅打印摘要，配置需在 TUI 面板修改
			ctx.ui.notify(
				`知识库配置\n${configSummary(cfg, isUnlocked())}\n\n（所有配置修改请在 TUI 交互模式运行 /kb-config 打开面板完成）`,
				"info",
			);
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
