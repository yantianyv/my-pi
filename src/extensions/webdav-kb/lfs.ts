/**
 * webdav-kb / lfs.ts — LFS 大文件区（/lfs/）：附加的真·网盘
 *
 * 与 md 知识库完全隔离：不自动同步、不参与冲突逻辑、不进入检索、不加密。
 * 定位 = 纯存取（网盘哲学）：AI 用 kb_upload 上传、kb_download 一次性下载
 * （下载后本地副本归用户/系统管，插件不跟踪不留缓存）。
 *
 * 元数据缓存（.kb-lfs-cache.json，TTL 1 小时）：kb_lslfs 的列表数据源。
 * 由两处维护：① syncAll 遍历远端时顺手刷新（只同步元数据，不下载本体）；
 * ② kb_upload 成功后即时更新单条。跨设备即时性靠 kb_lslfs force:true 手动刷新。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { WebDavClient, DavError } from "./client";
import type { KbConfig } from "./store";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const LFS_PREFIX = "/lfs";
/** 元数据缓存有效期（毫秒） */
const CACHE_TTL_MS = 60 * 60 * 1000;

export function isLfsPath(rel: string): boolean {
	return rel.startsWith(LFS_PREFIX + "/") || rel === LFS_PREFIX;
}

// ---------------------------------------------------------------------------
// 元数据缓存
// ---------------------------------------------------------------------------

export interface LfsFile {
	/** 相对路径（/lfs/xxx） */
	path: string;
	size: number;
	/** HTTP date 原文（如 "Mon, 10 Aug 2026 05:44:40 GMT"） */
	lastModified?: string;
}

export interface LfsCache {
	version: 1;
	/** 最近一次刷新时间（ISO） */
	fetchedAt: string;
	files: LfsFile[];
}

export function lfsCacheFile(mirrorDir: string): string {
	return path.join(mirrorDir, ".kb-lfs-cache.json");
}

export function loadLfsCache(mirrorDir: string): LfsCache {
	try {
		const d = JSON.parse(fs.readFileSync(lfsCacheFile(mirrorDir), "utf8")) as unknown;
		if (
			typeof d === "object" &&
			d !== null &&
			Array.isArray((d as { files?: unknown }).files)
		) {
			return d as LfsCache;
		}
	} catch {
		/* 缓存缺失/损坏 → 空 */
	}
	return { version: 1, fetchedAt: "", files: [] };
}

export function saveLfsCache(mirrorDir: string, cache: LfsCache): void {
	try {
		fs.mkdirSync(mirrorDir, { recursive: true });
		const f = lfsCacheFile(mirrorDir);
		fs.writeFileSync(f + ".tmp", JSON.stringify(cache, null, 2) + "\n", "utf8");
		fs.renameSync(f + ".tmp", f);
	} catch {
		/* 写缓存失败静默 */
	}
}

/** 缓存是否未过期（fetchedAt 存在且距今 < TTL） */
export function isLfsCacheFresh(cache: LfsCache): boolean {
	if (!cache.fetchedAt) return false;
	return Date.now() - new Date(cache.fetchedAt).getTime() < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// 远端遍历
// ---------------------------------------------------------------------------

/** 递归 PROPFIND /lfs/ 子树（实时刷新用） */
export async function walkLfs(
	client: WebDavClient,
	signal?: AbortSignal,
): Promise<LfsFile[]> {
	const out: LfsFile[] = [];
	const queue: string[] = [LFS_PREFIX];
	while (queue.length > 0) {
		if (signal?.aborted) throw new DavError("已取消", undefined, "SYNC");
		const batch = queue.splice(0, 4);
		await Promise.all(
			batch.map(async (dir) => {
				const entries = await client.list(dir);
				for (const f of entries) {
					if (f.isDir) {
						queue.push(f.path);
						continue;
					}
					out.push({ path: f.path, size: f.size ?? 0, lastModified: f.lastModified });
				}
			}),
		);
	}
	return out;
}

/** 获取 lfs 文件列表：缓存新鲜直接用；过期或 force → 实时 PROPFIND 刷新并写缓存 */
export async function getLfsFiles(
	cfg: KbConfig,
	mirrorDir: string,
	opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<LfsFile[]> {
	const cache = loadLfsCache(mirrorDir);
	if (isLfsCacheFresh(cache) && !opts.force) return cache.files;
	const client = new WebDavClient(cfg.baseUrl!, cfg.username!, cfg.password!, {
		proxyUrl: cfg.proxyUrl,
	});
	const files = await walkLfs(client, opts.signal);
	saveLfsCache(mirrorDir, { version: 1, fetchedAt: new Date().toISOString(), files });
	return files;
}

/** 上传成功后即时更新缓存单条（新增或替换） */
export function touchLfsCache(mirrorDir: string, file: LfsFile): void {
	const cache = loadLfsCache(mirrorDir);
	const idx = cache.files.findIndex((f) => f.path === file.path);
	if (idx >= 0) cache.files[idx] = file;
	else cache.files.push(file);
	saveLfsCache(mirrorDir, cache);
}

/** syncAll 遍历结束后：从远端全树快照提取 lfs 部分刷新缓存（只同步元数据，不下载本体） */
export function syncLfsCacheFromRemote(
	mirrorDir: string,
	remote: Map<string, { isDir: boolean; size?: number; lastModified?: string }>,
): void {
	const files: LfsFile[] = [];
	for (const [p, r] of remote) {
		if (r.isDir || !isLfsPath(p)) continue;
		files.push({ path: p, size: r.size ?? 0, lastModified: r.lastModified });
	}
	saveLfsCache(mirrorDir, { version: 1, fetchedAt: new Date().toISOString(), files });
}

// ---------------------------------------------------------------------------
// 展示工具
// ---------------------------------------------------------------------------

/** 字节数 → 人类可读（B/KB/MB/GB） */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
