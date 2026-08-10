/**
 * webdav-kb / sync.ts — 本地镜像 + 增量同步引擎
 *
 * 镜像 = ~/.pi/agent/kb/ 下的目录树（与远端一一对应），所有读操作（搜索/面板/AI 工具）
 * 都打在本地镜像上：毫秒级、离线可用。同步账本（.kb-sync.json）记录每个文件的
 * etag + 本地 mtime 快照，据此做增量：
 *
 *   远端 etag 变 + 本地未动 → 下载
 *   本地 mtime 变 + 远端未动 → 上传（AI 本地写入立即 PUT，此处兜底离线积压）
 *   远端删除 + 本地未动 → 删本地；本地删除 + 远端未动 → 删远端
 *   两侧都变 → 冲突：保留远端为权威，本地版存为 <名>.conflict-<时间戳>.md（仅本地，
 *   不参与上传，防污染远端）
 *
 * 首次同步（无账本）：远端全量下载；本地文件上传。删除语义以「账本存在」为界：
 * 账本有而本地文件消失 = 本地删过；账本无而本地有 = 本地新建。
 *
 * 并发策略：远端遍历与批量下载各带并发上限（避免国产盘并发超限被限流）。
 * 上传前自动补齐远端父目录（MKCOL 链）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { WebDavClient, DavError } from "./client";
import {
	KbConfig,
	Ledger,
	LedgerFile,
	loadLedger,
	saveLedger,
	mirrorPath,
} from "./store";
import { isLfsPath, syncLfsCacheFromRemote } from "./lfs";

/** 目录遍历并发上限（PROPFIND） */
const WALK_CONCURRENCY = 4;
/** 下载并发上限 */
const DOWNLOAD_CONCURRENCY = 4;
/** 上传并发上限（123 云盘对并发 MKCOL 建目录敏感，串行 + 重试最稳） */
const UPLOAD_CONCURRENCY = 1;
// 注意：本地改动检测用「严格大于」而非容差——所有写入（下载/putNote）都即时记录
// statSync 的精确 mtimeMs，之后任何 statSync 都会返回同一值，因此 > 即真实改动；
// 粗粒度文件系统（如 FAT 2s 精度）重写可能落入同一刻 → 等下次同步再发现，可接受。

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface SyncOptions {
	signal?: AbortSignal;
	/** 进度回调（label 如 "遍历远端" / "下载 3/12" / "上传 1/2"） */
	onProgress?: (label: string) => void;
}

export interface SyncStats {
	/** 远端 → 本地 下载数 */
	downloaded: number;
	/** 本地 → 远端 上传数 */
	uploaded: number;
	/** 删除数（本地删 + 远端删合计） */
	deleted: number;
	/** 冲突数（保留远端 + 本地 .conflict 副本） */
	conflicts: number;
	/** 无变化文件数 */
	unchanged: number;
	/** 单个文件失败（不影响其它文件，汇总上报） */
	errors: string[];
}

interface RemoteFile {
	isDir: boolean;
	etag?: string;
	lastModified?: string;
	size?: number;
}

// ---------------------------------------------------------------------------
// 远端遍历
// ---------------------------------------------------------------------------

/** 递归遍历远端整树（BFS + 并发上限），返回 path → RemoteFile */
async function walkRemote(
	client: WebDavClient,
	onProgress?: (label: string) => void,
	signal?: AbortSignal,
): Promise<Map<string, RemoteFile>> {
	const out = new Map<string, RemoteFile>();
	const queue: string[] = ["/"];
	let dirsDone = 0;
	while (queue.length > 0) {
		if (signal?.aborted) throw new DavError("同步已取消", undefined, "SYNC");
		const batch = queue.splice(0, WALK_CONCURRENCY);
		await Promise.all(
			batch.map(async (dir) => {
				const entries = await client.list(dir);
				for (const f of entries) {
					out.set(f.path, {
						isDir: f.isDir,
						etag: f.etag,
						lastModified: f.lastModified,
						size: f.size,
					});
					if (f.isDir && f.path !== dir) queue.push(f.path);
				}
			}),
		);
		dirsDone += batch.length;
		onProgress?.(`遍历远端 ${dirsDone} 个目录`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 本地镜像扫描
// ---------------------------------------------------------------------------

interface LocalFile {
	mtimeMs: number;
	size: number;
}

/** 扫描本地镜像：跳过账本 / .conflict- 冲突副本（后者仅本地保留，永不回传） */
function scanLocal(mirrorDir: string): Map<string, LocalFile> {
	const out = new Map<string, LocalFile>();
	const walk = (dir: string, relPrefix: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // 镜像目录不存在 → 空
		}
		for (const ent of entries) {
			const rel = `${relPrefix}/${ent.name}`;
			if (ent.name.startsWith(".kb-") || ent.name.includes(".conflict-")) continue;
			const full = path.join(dir, ent.name);
			try {
				if (ent.isDirectory()) {
					walk(full, rel);
				} else if (ent.isFile()) {
					const st = fs.statSync(full);
					out.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
				}
			} catch {
				/* 单个文件读取失败跳过 */
			}
		}
	};
	walk(mirrorDir, "");
	return out;
}

// ---------------------------------------------------------------------------
// 同步主体
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 确保远端父目录存在（MKCOL 链，幂等）；123 云盘对 MKCOL 并发限流（423），退避重试 */
export async function ensureRemoteDirs(client: WebDavClient, relPath: string): Promise<void> {
	const segs = relPath.split("/").filter(Boolean);
	let cur = "";
	for (let i = 0; i < segs.length - 1; i++) {
		cur += "/" + segs[i];
		for (let attempt = 0; ; attempt++) {
			try {
				await client.mkdir(cur);
				break;
			} catch (e) {
				if (e instanceof DavError && e.status === 405) break; // 目录已存在
				if (e instanceof DavError && (e.status === 423 || e.status === 429) && attempt < 3) {
					await sleep(400 * (attempt + 1)); // 退避 400ms/800ms/1200ms
					continue;
				}
				throw e;
			}
		}
	}
}

/** 本地相对路径 → 绝对路径（防目录穿越） */
function safeLocal(mirrorDir: string, rel: string): string {
	const abs = mirrorPath(mirrorDir, rel);
	if (!abs.startsWith(path.resolve(mirrorDir))) throw new Error(`非法路径：${rel}`);
	return abs;
}

/** 增量同步主体 */
export async function syncAll(cfg: KbConfig, mirrorDir: string, opts: SyncOptions = {}): Promise<SyncStats> {
	const stats: SyncStats = { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, unchanged: 0, errors: [] };
	const signal = opts.signal;
	const client = new WebDavClient(cfg.baseUrl!, cfg.username!, cfg.password!, {
		proxyUrl: cfg.proxyUrl,
	});
	const ledger = loadLedger(mirrorDir);

	// 1) 远端遍历
	opts.onProgress?.("遍历远端…");
	const remote = await walkRemote(client, opts.onProgress, signal);

	// 2) 本地扫描 + 差异比对
	const local = scanLocal(mirrorDir);
	const toDownload: string[] = [];
	const toUpload: string[] = [];
	const delRemote: string[] = [];
	const delLocal: string[] = [];
	const conflicts: string[] = [];

	for (const [p, r] of remote) {
		if (signal?.aborted) throw new DavError("同步已取消", undefined, "SYNC");
		if (r.isDir) continue; // 目录在下载/上传时按需创建
		if (isLfsPath(p)) continue; // LFS：不参与 md 比对/下载/上传，只刷新元数据缓存（见末尾）
		const lf = ledger.files[p];
		const li = local.get(p);
		if (!li) {
			// 本地无此文件：账本有 = 本地删过 → 删远端；账本无 = 远端新增 → 下载
			if (lf) delRemote.push(p);
			else toDownload.push(p);
			continue;
		}
		const localChanged = lf ? li.mtimeMs > lf.localMtime : true;
		const remoteChanged = lf ? lf.etag !== undefined && r.etag !== undefined && lf.etag !== r.etag : false;
		if (!lf) {
			// 本地有、账本无 → 本地新建（未传过）→ 上传
			toUpload.push(p);
		} else if (localChanged && remoteChanged) {
			conflicts.push(p);
		} else if (remoteChanged) {
			toDownload.push(p);
		} else if (localChanged || !lf.etag) {
			// 本地改过，或从未上传成功（账本无 etag，如离线 putNote 的积压）→ 上传
			toUpload.push(p);
		} else {
			stats.unchanged++;
		}
	}
	// 远端已删：账本有记录但远端无——曾上传过（有 etag）且本地还在 → 删本地（远端为准）；
	// 从未上传（无 etag）→ 视为待补传；两端都无 → 清账本条目
	for (const p of Object.keys(ledger.files)) {
		if (!remote.has(p)) {
			if (local.has(p)) {
				if (ledger.files[p].etag) delLocal.push(p);
				else toUpload.push(p);
			} else {
				delete ledger.files[p];
			}
		}
	}
	// 本地新建：远端无此路径且账本无记录 → 上传（含尚未同步过的目录树；LFS 文件不归 sync 管，走 kb_upload）
	for (const [p] of local) {
		if (isLfsPath(p)) continue;
		if (!remote.has(p) && !ledger.files[p]) toUpload.push(p);
	}

	// 3) 下载（并发）
	await mapLimit(toDownload, DOWNLOAD_CONCURRENCY, async (p) => {
		if (signal?.aborted) return;
		try {
			const { data, etag, lastModified } = await client.get(p);
			const abs = safeLocal(mirrorDir, p);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, data);
			ledger.files[p] = {
				...(etag ? { etag } : {}),
				...(lastModified ? { remoteLastModified: lastModified } : {}),
				size: data.length,
				localMtime: fs.statSync(abs).mtimeMs,
			};
			stats.downloaded++;
		} catch (e) {
			stats.errors.push(`下载 ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}
		opts.onProgress?.(`下载 ${stats.downloaded}/${toDownload.length}`);
	});

	// 4) 冲突处理：保留远端为权威，本地版存 .conflict-<时间戳>.md（仅本地，不参与上传）
	for (const p of conflicts) {
		if (signal?.aborted) throw new DavError("同步已取消", undefined, "SYNC");
		try {
			const { data, etag, lastModified } = await client.get(p);
			const abs = safeLocal(mirrorDir, p);
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			const conflictAbs = abs.replace(/(\.\w+)?$/, `.conflict-${ts}$1`);
			fs.mkdirSync(path.dirname(conflictAbs), { recursive: true });
			fs.renameSync(abs, conflictAbs); // 本地版挪走
			fs.writeFileSync(abs, data); // 远端版落位
			ledger.files[p] = {
				...(etag ? { etag } : {}),
				...(lastModified ? { remoteLastModified: lastModified } : {}),
				size: data.length,
				localMtime: fs.statSync(abs).mtimeMs,
			};
			stats.conflicts++;
		} catch (e) {
			stats.errors.push(`冲突处理 ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 5) 上传（并发 + 父目录补齐）
	await mapLimit(toUpload, UPLOAD_CONCURRENCY, async (p) => {
		if (signal?.aborted) return;
		try {
			const abs = safeLocal(mirrorDir, p);
			const data = fs.readFileSync(abs);
			await ensureRemoteDirs(client, p);
			const etag = await putWithEtag(client, p, data);
			ledger.files[p] = {
				...(etag ? { etag } : {}),
				size: data.length,
				localMtime: fs.statSync(abs).mtimeMs,
			};
			stats.uploaded++;
		} catch (e) {
			stats.errors.push(`上传 ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}
		opts.onProgress?.(`上传 ${stats.uploaded}/${toUpload.length}`);
	});

	// 6) 删除：远端删本地文件；本地删远端文件（不删远端目录，目录由服务器自管）
	for (const p of delLocal) {
		try {
			fs.unlinkSync(safeLocal(mirrorDir, p));
			delete ledger.files[p];
			stats.deleted++;
		} catch (e) {
			stats.errors.push(`删除本地 ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	for (const p of delRemote) {
		try {
			await client.delete(p);
			delete ledger.files[p];
			stats.deleted++;
		} catch (e) {
			stats.errors.push(`删除远端 ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 7) 账本落盘
	ledger.syncedAt = new Date().toISOString();
	saveLedger(mirrorDir, ledger);

	// 8) LFS 元数据缓存刷新（只同步元数据，不下载本体）
	syncLfsCacheFromRemote(mirrorDir, remote);
	return stats;
}

// ---------------------------------------------------------------------------
// AI 写入通道（工具层用）：本地写 + 立即 PUT
// ---------------------------------------------------------------------------

/** 上传并尽可能拿到 etag：PUT 响应无 ETag（如 123 云盘）时补一次 PROPFIND stat */
async function putWithEtag(
	client: WebDavClient,
	relPath: string,
	data: Uint8Array,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const { etag } = await client.put(relPath, data, { signal });
	if (etag) return etag;
	const st = await client.stat(relPath);
	return st?.etag;
}

/**
 * 写笔记：本地镜像落盘（原子）→ 立即 PUT 远端（离线失败则留待下次同步上传）。
 * 返回：etag（PUT 成功）或 null（仅本地）。
 */
export async function putNote(
	cfg: KbConfig,
	mirrorDir: string,
	relPath: string,
	content: string | Uint8Array,
	opts: { signal?: AbortSignal } = {},
): Promise<string | null> {
	const abs = safeLocal(mirrorDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const tmp = abs + ".kb-tmp";
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, abs);
	const ledger = loadLedger(mirrorDir);
	const mtime = fs.statSync(abs).mtimeMs;
	ledger.files[relPath] = { ...ledger.files[relPath], size: fs.statSync(abs).size, localMtime: mtime };
	saveLedger(mirrorDir, ledger);
	// 立即上传（失败静默：账本 mtime 已更新，下次同步自动补传）
	try {
		const client = new WebDavClient(cfg.baseUrl!, cfg.username!, cfg.password!, { proxyUrl: cfg.proxyUrl });
		await ensureRemoteDirs(client, relPath);
		const etag = await putWithEtag(client, relPath, typeof content === "string" ? new TextEncoder().encode(content) : content, opts.signal);
		const ledger2 = loadLedger(mirrorDir);
		ledger2.files[relPath] = {
			...(etag ? { etag } : {}),
			size: fs.statSync(abs).size,
			localMtime: fs.statSync(abs).mtimeMs,
		};
		saveLedger(mirrorDir, ledger2);
		return etag ?? null;
	} catch {
		return null;
	}
}

/** 读笔记（本地镜像；不存在返回 null） */
export function readNote(mirrorDir: string, relPath: string): string | null {
	const abs = safeLocal(mirrorDir, relPath);
	try {
		return fs.readFileSync(abs, "utf8");
	} catch {
		return null;
	}
}

/** 读笔记原始字节（密文/二进制用；不存在返回 null） */
export function readNoteBytes(mirrorDir: string, relPath: string): Uint8Array | null {
	const abs = safeLocal(mirrorDir, relPath);
	try {
		return new Uint8Array(fs.readFileSync(abs));
	} catch {
		return null;
	}
}

/** 本地镜像文件列表（相对路径，含目录；跳过账本/冲突副本） */
export function listNotes(mirrorDir: string): { path: string; isDir: boolean }[] {
	const out: { path: string; isDir: boolean }[] = [];
	const walk = (dir: string, relPrefix: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (ent.name.startsWith(".kb-") || ent.name.includes(".conflict-")) continue;
			const rel = `${relPrefix}/${ent.name}`;
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				out.push({ path: rel, isDir: true });
				walk(full, rel);
			} else if (ent.isFile()) {
				out.push({ path: rel, isDir: false });
			}
		}
	};
	walk(mirrorDir, "");
	return out;
}

// ---------------------------------------------------------------------------
// 并发工具
// ---------------------------------------------------------------------------

/** 限并发 map（每个任务最多同时运行 limit 个；任务抛错由调用方各自捕获） */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			await fn(items[i]);
		}
	});
	await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// 对外的门面：store 数据层一并 re-export（工具/面板只 import sync.ts 即可）
// ---------------------------------------------------------------------------

export {
	KbConfig,
	Ledger,
	LedgerFile,
	loadConfig,
	saveConfig,
	isConfigured,
	loadLedger,
	saveLedger,
	emptyLedger,
	agentConfigDir,
	configFile,
	defaultMirrorDir,
	mirrorPath,
	toRelPath,
} from "./store";
