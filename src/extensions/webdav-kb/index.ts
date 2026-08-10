/**
 * webdav-kb / index.ts — 扩展入口（组装薄壳）
 *
 * 职责：
 * - 注册 AI 工具（tools.ts：kb_help/search/read/write/append/list）
 * - session_start 钩子：后台增量同步（setStatus 推送进度）+ vault 口令询问（仅解锁
 *   成功才置密钥，口令只存内存）+ search 解密钩子接线
 * - session_shutdown：清 TTL 定时器（防旧 ctx 到期回调抛 stale）
 *
 * 同步策略：只读操作（搜索/读取/面板）打本地镜像，session 启动时后台同步一次；
 * 写入工具（kb_write/append）本地落盘 + 立即 PUT，离线积压下次同步补传。
 * 与 hud 零耦合：状态走官方 setStatus 通道（hud 行 1 动态区 / 原生 footer 自动展示）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setStatusWithTTL, clearStatusTimers } from "../shared/status";
import { loadConfig, isConfigured, defaultMirrorDir, agentConfigDir } from "./store";
import { syncAll, putNote, readNote } from "./sync";
import { getIndex } from "./search";
import { unlockVault, isUnlocked, vaultReadNote, VaultAuthError } from "./crypto";
import { registerKbTools } from "./tools";
import { registerKbCommands } from "./commands";
import { registerKbPanel } from "./panel";
import { DEFAULT_PROTOCOL, PROTOCOL_HEADER } from "./protocol";

// re-export crypto 门面（commands/panel 与外部测试要用：vault 解锁、透明读写、路径映射）
export {
	createVault,
	unlockVault,
	isUnlocked,
	lockVault,
	vaultPutNote,
	vaultReadNote,
	encryptPath,
	decryptPath,
	isVaultPath,
} from "./crypto";

/** 后台同步的并发保护（避免多次 session_start 重叠同步） */
let syncInFlight: Promise<void> | null = null;
/** 后台同步启动延迟（ms）：reload 后先让 UI 就绪，再发起远端遍历/下载，避免抢占网络与磁盘 */
const SYNC_DELAY_MS = 3_000;

/** session_start：后台增量同步 + vault 解锁询问 + 解密钩子接线 */
async function onSessionStart(_event: unknown, ctx: ExtensionContext): Promise<void> {
	const cfg = loadConfig(agentConfigDir());
	if (!isConfigured(cfg)) return; // 未配置：工具会给引导
	const mirrorDir = cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());

	// vault：配置了加密区则询问口令解锁。fire-and-forget（不 await）——弹窗不阻塞 reload 完成
	if (cfg.vault && !isUnlocked() && ctx.hasUI) {
		void promptVaultUnlock(ctx, cfg);
	}

	// search 解密钩子（vault 解锁后可检索密文区，未解锁自动跳过）
	getIndex(mirrorDir).setDecryptor((rel) => (isUnlocked() ? vaultReadNote(mirrorDir, rel) : null));

	// 首次使用引导：网盘根缺 PROTOCOL.md 时写入默认守则（本地镜像 + 上传远端）
	ensureProtocol(cfg, mirrorDir);

	// 后台同步：延迟启动（先让 reload/UI 就绪），不阻塞会话，失败静默——读操作用镜像，写操作即时 PUT
	if (!syncInFlight) {
		syncInFlight = new Promise((resolve) => {
			setTimeout(() => {
				runBackgroundSync(ctx, cfg, mirrorDir)
					.catch(() => undefined)
					.finally(() => {
						syncInFlight = null;
						resolve();
					});
			}, SYNC_DELAY_MS);
		});
	}
}

/** 后台同步：setStatus 推送进度 → 完成摘要；失败仅在状态条提示 */
async function runBackgroundSync(ctx: ExtensionContext, cfg: ReturnType<typeof loadConfig>, mirrorDir: string): Promise<void> {
	const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "kb-sync", text, ttlMs);
	try {
		push("🔄 同步中", 30_000);
		const stats = await syncAll(cfg, mirrorDir, {
			onProgress: (label) => push(`🔄 ${label}`, 30_000),
		});
		const parts: string[] = [];
		if (stats.downloaded > 0) parts.push(`↓${stats.downloaded}`);
		if (stats.uploaded > 0) parts.push(`↑${stats.uploaded}`);
		if (stats.deleted > 0) parts.push(`×${stats.deleted}`);
		if (stats.conflicts > 0) parts.push(`⚠冲突${stats.conflicts}`);
		const summary = parts.length > 0 ? parts.join(" ") : "最新";
		push(`📚 ${summary}`, 8_000);
		if (stats.errors.length > 0) {
			push(`⚠ 同步 ${stats.errors.length} 个文件失败`, 10_000);
		}
	} catch (e) {
		push(`⚠ 同步失败：${e instanceof Error ? e.message : String(e)}`, 10_000);
	}
}

/** 首次使用引导：镜像缺 PROTOCOL.md 时写入默认守则（本地 + 上传网盘根），失败静默 */
function ensureProtocol(cfg: ReturnType<typeof loadConfig>, mirrorDir: string): void {
	if (readNote(mirrorDir, "/PROTOCOL.md") !== null) return;
	const content = PROTOCOL_HEADER + DEFAULT_PROTOCOL;
	try {
		putNote(cfg, mirrorDir, "/PROTOCOL.md", content).catch(() => undefined); // 上传失败不阻塞（镜像已有，下次同步补传）
	} catch {
		/* 写本地失败静默 */
	}
}

/** 询问 vault 口令并解锁（失败给出明确提示，不阻塞会话） */
async function promptVaultUnlock(ctx: ExtensionContext, cfg: ReturnType<typeof loadConfig>): Promise<void> {
	try {
		const pass = await ctx.ui.input("vault 加密区口令", "输入口令解锁加密区（取消则保持锁定）");
		if (!pass) return; // 用户取消
		if (cfg.vault && unlockVault(pass, cfg.vault)) {
			ctx.ui.notify("🔓 vault 已解锁", "info");
			setStatusWithTTL(ctx, "kb-vault", "🔓 vault 已解锁", 6_000);
		} else {
			ctx.ui.notify("vault 口令错误，加密区保持锁定", "error");
			setStatusWithTTL(ctx, "kb-vault", "🔒 vault 口令错误", 6_000);
		}
	} catch {
		/* ui 不可用等异常静默 */
	}
}

export default function (pi: ExtensionAPI): void {
	// reload / session 替换前清 TTL 定时器（旧 ctx 失效，到期回调会抛 stale）
	pi.on("session_shutdown", () => clearStatusTimers());
	pi.on("session_start", onSessionStart);
	registerKbTools(pi);
	registerKbCommands(pi);
	registerKbPanel(pi);
}
