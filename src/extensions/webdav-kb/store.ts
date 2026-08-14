/**
 * webdav-kb / store.ts — 配置 + 同步账本数据层
 *
 * 配置（kb-config.json，存 ~/.pi/agent/）：WebDAV 地址/凭据/代理/镜像目录。
 * 同步账本（.kb-sync.json，存镜像根目录）：每个远端文件的 etag/lastModified/size
 * + 本地文件 mtime 快照——增量同步的依据（本地 mtime 比账本新 = 本地改过；
 * 远端 etag 比账本新 = 远端改过）。
 *
 * 数据层不持有 pi ctx（session 替换不触发 stale）：配置/账本只依赖文件路径，运行时无状态。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface KbConfig {
	/** WebDAV 地址（如 https://dav.123pan.com/dav） */
	baseUrl?: string;
	username?: string;
	password?: string;
	/** HTTP 代理（可选） */
	proxyUrl?: string;
	/** 本地镜像目录（默认 ~/.pi/agent/kb/） */
	mirrorDir?: string;
	/** vault 加密区设置（见 crypto.ts）：口令校验用的 salt + 密文 check 块，不含口令本身 */
	vault?: { salt: string; check: string };
	/** 启动时自动解锁 vault（派生密钥持久化到磁盘，仅本机可用） */
	persistVault?: boolean;
	/** 持久化的派生密钥 base64（配合 persistVault 使用，lockVault 时清除） */
	vaultKey?: string;
	/** 只读模式：隐藏写工具、同步仅下载（面板切换，下次会话生效） */
	readOnly?: boolean;
}

const isKbConfig = (v: unknown): v is KbConfig => {
	const c = v as KbConfig | null;
	return (
		typeof c === "object" &&
		c !== null &&
		(c.baseUrl === undefined || typeof c.baseUrl === "string") &&
		(c.username === undefined || typeof c.username === "string") &&
		(c.password === undefined || typeof c.password === "string") &&
		(c.proxyUrl === undefined || typeof c.proxyUrl === "string") &&
		(c.mirrorDir === undefined || typeof c.mirrorDir === "string") &&
		(c.vault === undefined ||
			(typeof c.vault === "object" &&
				c.vault !== null &&
				typeof c.vault.salt === "string" &&
				typeof c.vault.check === "string")) &&
			(c.persistVault === undefined || typeof c.persistVault === "boolean") &&
			(c.vaultKey === undefined || typeof c.vaultKey === "string") &&
			(c.readOnly === undefined || typeof c.readOnly === "boolean")
	);
};

/** pi 的 agent 配置目录（~/.pi/agent/；可用环境变量 KB_CONFIG_DIR 覆盖——测试隔离用） */
export function agentConfigDir(): string {
	return process.env.KB_CONFIG_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** 扩展配置文件路径（可被测试覆盖） */
export function configFile(configDir: string): string {
	return path.join(configDir, "kb-config.json");
}

/** 默认本地镜像目录 */
export function defaultMirrorDir(configDir: string): string {
	return path.join(configDir, "kb");
}

export function loadConfig(configDir: string): KbConfig {
	return loadJsonConfig<KbConfig>(configFile(configDir), {}, isKbConfig);
}

export function saveConfig(configDir: string, cfg: KbConfig): void {
	saveJsonConfig(configFile(configDir), cfg);
}

/** 配置是否可用于连接（baseUrl + 凭据齐备） */
export function isConfigured(cfg: KbConfig): boolean {
	return Boolean(cfg.baseUrl?.trim() && cfg.username && cfg.password);
}

// ---------------------------------------------------------------------------
// 同步账本
// ---------------------------------------------------------------------------

export interface LedgerFile {
	/** 远端 etag（去引号；目录无） */
	etag?: string;
	/** 远端最后修改时间（HTTP date 原文） */
	remoteLastModified?: string;
	size?: number;
	/** 本地文件 mtime（ms）快照：上次下载/上传/写入时记录 */
	localMtime: number;
}

export interface Ledger {
	version: 1;
	syncedAt: string;
	/** key = 相对路径（"/notes/a.md"） */
	files: Record<string, LedgerFile>;
}

export function emptyLedger(): Ledger {
	return { version: 1, syncedAt: "", files: {} };
}

/** 账本文件路径（镜像根下） */
export function ledgerFile(mirrorDir: string): string {
	return path.join(mirrorDir, ".kb-sync.json");
}

export function loadLedger(mirrorDir: string): Ledger {
	const f = ledgerFile(mirrorDir);
	if (fs.existsSync(f)) {
		try {
			const d = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
			if (typeof d === "object" && d !== null && typeof (d as { files?: unknown }).files === "object") {
				return {
					version: 1,
					syncedAt: typeof (d as { syncedAt?: unknown }).syncedAt === "string" ? (d as { syncedAt: string }).syncedAt : "",
					files: (d as { files: Record<string, LedgerFile> }).files,
				};
			}
		} catch {
			/* 账本损坏按空账本处理（下次全量重建） */
		}
	}
	return emptyLedger();
}

/** 原子写账本（tmp + rename，防中途崩溃写坏） */
export function saveLedger(mirrorDir: string, ledger: Ledger): void {
	try {
		fs.mkdirSync(mirrorDir, { recursive: true });
		const f = ledgerFile(mirrorDir);
		const tmp = f + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n", "utf8");
		fs.renameSync(tmp, f);
	} catch {
		/* 写账本失败静默——下次同步重建，不阻塞业务 */
	}
}

// ---------------------------------------------------------------------------
// 镜像路径工具
// ---------------------------------------------------------------------------

/** 相对路径（"/notes/a.md"）→ 镜像本地绝对路径（跨平台分隔符） */
export function mirrorPath(mirrorDir: string, rel: string): string {
	const segs = rel.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..");
	return path.join(mirrorDir, ...segs);
}

/** 本地绝对路径 → 相对路径（"/" 开头，forward slash）；镜像外的路径返回 null */
export function toRelPath(mirrorDir: string, abs: string): string | null {
	const rel = path.relative(mirrorDir, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return "/" + rel.split(path.sep).join("/");
}
