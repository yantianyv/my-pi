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
 *
 * 健壮性（借鉴 pi-sync）：syncAll 持 .kb-sync.lock 互斥锁——持锁方每 10s 心跳续期，后到者
 * 按「pid 已死/心跳超时」回收残锁（无心跳的旧格式锁回退 30min 判定）；lockWaitMs > 0 时
 * 锁被占先轮询等待（等待期可见对方阶段进度），到点才报错。.kb-sync-journal.json 记录计划
 * 与阶段，成功才删除——中断后下次同步报告并靠重跑差异比对收敛（各操作幂等：重下/重传/
 * 重删安全，删本地前必有 .history 留档）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { WebDavClient, DavError, isNetworkFailure } from "./client";
import {
	KbConfig,
	Ledger,
	LedgerFile,
	loadLedger,
	saveLedger,
	mirrorPath,
} from "./store";
import { isLfsPath, syncLfsCacheFromRemote } from "./lfs";
import { scanSecrets } from "./secrets";

/** 目录遍历并发上限（PROPFIND） */
const WALK_CONCURRENCY = 4;
/** 下载并发上限 */
const DOWNLOAD_CONCURRENCY = 4;
/** 上传并发上限（123 云盘对并发 MKCOL 建目录敏感，串行 + 重试最稳） */
const UPLOAD_CONCURRENCY = 1;

// ---------------------------------------------------------------------------
// 同步锁与恢复日志（借鉴 pi-sync：锁防多会话并发互踩；journal 记录中断点）
// ---------------------------------------------------------------------------

/** 锁文件（.kb- 前缀，scanLocal/上传均不感知） */
const LOCK_NAME = ".kb-sync.lock";
/** 恢复日志：记录上次同步的计划与中断阶段 */
const JOURNAL_NAME = ".kb-sync-journal.json";
/** 持锁心跳间隔：每该时长重写心跳时间戳，向等待方证明持有方仍在推进 */
const LOCK_HEARTBEAT_MS = 10_000;
/** 心跳超过该时长未续期 = 持有进程已死/挂起，锁可回收（活进程的大同步再久也不会被误杀） */
const LOCK_HEARTBEAT_STALE_MS = 45_000;
/** 等待锁释放的轮询间隔 */
const LOCK_POLL_MS = 2_000;
/** 旧格式锁（升级前遗留、无心跳字段）超过该时长仍视为残留 */
const LOCK_STALE_MS = 30 * 60_000;
/** 手动同步（kb_sync 工具 / /kb sync 命令）锁被占时的默认等待上限：大导入/长同步期间后到者先排队而非立刻失败 */
export const SYNC_LOCK_WAIT_MS = 120_000;

interface SyncJournal {
	startedAt: string;
	/** 中断时所在阶段（plan 后的各阶段；同步成功结束会删除 journal，见到即中断） */
	phase: "download" | "conflict" | "upload" | "delete";
	toDownload: string[];
	toUpload: string[];
	delLocal: string[];
	delRemote: string[];
}

/** 进程存活探测：kill(pid, 0) 不杀进程只验活；ESRCH=不存在，EPERM=存在但无权（也算活） */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** 锁文件元数据（等待方读之展示持有方/进度并判定残锁） */
interface SyncLockMeta {
	pid: number;
	/** 持有开始时间（ISO） */
	startedAt: string;
	/** 最近心跳（毫秒时间戳）；缺省 = 升级前旧格式锁 */
	heartbeat?: number;
	/** 持有方最近上报的进度 */
	progress?: string;
}

/** 同步锁句柄 */
interface SyncLock {
	/** 释放锁并停止心跳（同步结束/异常的 finally 必经） */
	release: () => void;
	/** 进度上报：写进锁文件供等待方观察（顺带续心跳） */
	report: (progress: string) => void;
	/** 阶段边界校验：锁被其他实例接管（本进程曾挂起/休眠致心跳过期被回收）即抛错，防双实例互踩 */
	assertOwned: () => void;
}

/** 读锁文件元数据：null = 不存在（含被原子替换的瞬间空窗）；"corrupt" = 半截 JSON（旧版非原子写遗留） */
function readLockMeta(lockPath: string): SyncLockMeta | null | "corrupt" {
	try {
		return JSON.parse(fs.readFileSync(lockPath, "utf8")) as SyncLockMeta;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "corrupt";
	}
}

/** 锁是否已残：持有进程死 / 心跳超时（旧格式锁回退 startedAt+30min 判定） */
function isLockStale(meta: SyncLockMeta): boolean {
	if (!meta.pid || !pidAlive(meta.pid)) return true;
	if (meta.heartbeat != null) return Date.now() - meta.heartbeat > LOCK_HEARTBEAT_STALE_MS;
	const started = meta.startedAt ? Date.parse(meta.startedAt) : Number.NaN;
	return !Number.isFinite(started) || Date.now() - started > LOCK_STALE_MS;
}

/** 原子写锁文件（tmp + rename：等待方要么读到旧完整版要么读到新完整版，永不读到半截） */
function writeLockMeta(lockPath: string, meta: SyncLockMeta): void {
	const tmp = `${lockPath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(meta), "utf8");
	fs.renameSync(tmp, lockPath);
}

/** 可取消 sleep：signal 中止时抛「同步已取消」 */
function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new DavError("同步已取消", undefined, "SYNC"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DavError("同步已取消", undefined, "SYNC"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 获取同步锁（wx 独占创建 + 持锁心跳）。锁被占时按 opts.waitMs 轮询等待（每 LOCK_POLL_MS 一次，
 * 经 opts.onWait 报告持有方与进度），到点仍拿不到才抛 DavError（method="SYNC_LOCKED"）；残锁随时
 * 回收。持锁期间每 LOCK_HEARTBEAT_MS 续期心跳——活进程的大同步再久也不会被误回收，真挂死 45s 内可接管。
 */
async function acquireSyncLock(
	mirrorDir: string,
	opts: { waitMs?: number; onWait?: (msg: string) => void; signal?: AbortSignal } = {},
): Promise<SyncLock> {
	const lockPath = path.join(mirrorDir, LOCK_NAME);
	fs.mkdirSync(mirrorDir, { recursive: true });
	const waitMs = opts.waitMs ?? 0;
	const deadline = Date.now() + waitMs;
	let staleRetries = 0;
	for (;;) {
		const meta: SyncLockMeta = { pid: process.pid, startedAt: new Date().toISOString(), heartbeat: Date.now() };
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.writeFileSync(fd, JSON.stringify(meta), "utf8");
			fs.closeSync(fd);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			// 锁已存在：读持有者；残锁复认后回收（限次），活锁等待或报错
			const first = readLockMeta(lockPath);
			if (first === null) continue; // 刚消失（释放/原子替换空窗）→ 直接抢锁
			if (first === "corrupt" || isLockStale(first)) {
				// 50ms 后复认仍残才回收——防把「心跳原子替换瞬间」的活跃锁误判成残锁
				await sleepCancellable(50, opts.signal);
				const again = readLockMeta(lockPath);
				const stillBad = again === "corrupt" || (again !== null && isLockStale(again));
				if (stillBad && ++staleRetries <= 3) {
					try {
						fs.unlinkSync(lockPath);
					} catch {
						/* 被竞态抢走也无妨，下轮 wx 判定 */
					}
					continue;
				}
			}
			const holder =
				first === "corrupt"
					? "未知持有者（锁文件残缺）"
					: `PID ${first.pid}（始于 ${first.startedAt}${first.progress ? `，${first.progress}` : ""}）`;
			if (Date.now() >= deadline) {
				throw new DavError(
					`另一个实例正在同步：${holder}。对方活跃期间锁自动续期、结束后自动释放` +
						`（异常退出会被秒级回收）；仅当确认对方进程已挂死且锁长期未释放时，才需手动删除 ${lockPath}`,
					undefined,
					"SYNC_LOCKED",
				);
			}
			if (first !== "corrupt") {
				const waited = Math.round((waitMs - (deadline - Date.now())) / 1000);
				const budget = Math.round(waitMs / 1000);
				opts.onWait?.(`等待另一实例释放同步锁（${holder}），已等 ${waited}s，最多等 ${budget}s…`);
			}
			await sleepCancellable(LOCK_POLL_MS, opts.signal);
			continue;
		}
		// 拿到锁：心跳定时器 + 句柄
		const timer = setInterval(() => {
			meta.heartbeat = Date.now();
			writeLockMeta(lockPath, meta);
		}, LOCK_HEARTBEAT_MS);
		timer.unref();
		let released = false;
		return {
			report: (progress) => {
				meta.progress = progress;
				meta.heartbeat = Date.now();
				if (!released) writeLockMeta(lockPath, meta);
			},
			assertOwned: () => {
				const cur = readLockMeta(lockPath);
				if (cur !== null && cur !== "corrupt" && cur.pid !== process.pid) {
					throw new DavError(
						"同步锁已被其他实例接管（本实例可能曾挂起/休眠致心跳过期被回收），中止本次同步以防两侧同时写镜像",
						undefined,
						"SYNC_LOCKED",
					);
				}
			},
			release: () => {
				released = true;
				clearInterval(timer);
				const cur = readLockMeta(lockPath);
				if (cur !== null && cur !== "corrupt" && cur.pid === process.pid) {
					try {
						fs.unlinkSync(lockPath);
					} catch {
						/* 已消失也无妨 */
					}
				}
			},
		};
	}
}

/** 读残留 journal（上次同步中断）：有则返回之并清除（报告后重跑差异比对即可收敛——各操作幂等） */
function recoverJournal(mirrorDir: string): SyncJournal | null {
	const jp = path.join(mirrorDir, JOURNAL_NAME);
	try {
		const j = JSON.parse(fs.readFileSync(jp, "utf8")) as SyncJournal;
		fs.unlinkSync(jp);
		return j;
	} catch {
		return null;
	}
}

/** 写 journal（覆盖式：阶段推进即更新，成功结束由 clearJournal 删除） */
function writeJournal(mirrorDir: string, j: SyncJournal): void {
	try {
		fs.writeFileSync(path.join(mirrorDir, JOURNAL_NAME), JSON.stringify(j, null, 1), "utf8");
	} catch {
		/* journal 写失败不阻塞同步 */
	}
}

function clearJournal(mirrorDir: string): void {
	try {
		fs.unlinkSync(path.join(mirrorDir, JOURNAL_NAME));
	} catch {
		/* 不存在 */
	}
}
// 注意：本地改动检测用「严格大于」而非容差——所有写入（下载/putNote）都即时记录
// statSync 的精确 mtimeMs，之后任何 statSync 都会返回同一值，因此 > 即真实改动；
// 粗粒度文件系统（如 FAT 2s 精度）重写可能落入同一刻 → 等下次同步再发现，可接受。

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface SyncOptions {
	signal?: AbortSignal;
	/** 进度回调（label 如 "遍历远端" / "下载 3/12" / "上传 1/2"；锁等待消息也经此回调） */
	onProgress?: (label: string) => void;
	/** 锁被占时的最长等待毫秒数；0/缺省 = 立即报错。等待期间每 2s 轮询并经 onProgress 报告对方进度 */
	lockWaitMs?: number;
}

/** 遍历失败的远端目录（带失败原因，提示里能直接说清是哪个目录、为什么） */
export interface FailedDir {
	/** 相对路径（"/" 表示根目录） */
	dir: string;
	/** 失败原因短标签（如 "HTTP 401"/"网络不可达"） */
	reason: string;
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
	/** 冲突文件路径（用于向用户指出哪些文件产生了副本） */
	conflictFiles: string[];
	/** 遍历失败、内容未纳入同步的远端目录（权限/网络） */
	failedDirs: FailedDir[];
	/** 无变化文件数 */
	unchanged: number;
	/** 单个文件失败（不影响其它文件，汇总上报） */
	errors: string[];
}

/**
 * 同步摘要（单一渲染源，命令/工具/面板/后台同步共用）：计数全人话，0 值省略；
 * 无任何变化时返回「已是最新」。附带说明行（冲突副本、失败明细、不可达目录）另由 formatSyncNotes 给出。
 */
export function formatSyncSummary(stats: SyncStats): string {
	const parts: string[] = [];
	if (stats.downloaded) parts.push(`下载 ${stats.downloaded}`);
	if (stats.uploaded) parts.push(`上传 ${stats.uploaded}`);
	if (stats.deleted) parts.push(`删除 ${stats.deleted}`);
	if (stats.conflicts) parts.push(`冲突 ${stats.conflicts}`);
	if (parts.length === 0) parts.push("已是最新");
	if (stats.errors.length) parts.push(`失败 ${stats.errors.length}`);
	return parts.join(" · ");
}

/**
 * 同步摘要的补充说明（给用户看的细节）：冲突副本落位/处理方式、失败明细、不可达目录。
 * 返回逐行文本（已带前缀），调用方自行决定放进 notify 正文或状态条。
 */
export function formatSyncNotes(stats: SyncStats, maxErrors = 3): string[] {
	const notes: string[] = [];
	if (stats.conflictFiles.length) {
		const shown = stats.conflictFiles.slice(0, 3).join("、");
		const more = stats.conflictFiles.length > 3 ? ` 等 ${stats.conflictFiles.length} 个` : "";
		notes.push(
			`冲突 ${shown}${more}：本地版本已另存为同目录 .conflict-<时间> 副本，远端版本已就位（核对后可直接删除副本）`,
		);
	}
	if (stats.failedDirs.length) {
		const shown = stats.failedDirs
			.slice(0, 3)
			.map((f) => `${f.dir}（${f.reason}）`)
			.join("、");
		const more = stats.failedDirs.length > 3 ? ` 等 ${stats.failedDirs.length} 个` : "";
		notes.push(`⚠ 远端目录读取失败：${shown}${more}，这些目录未纳入本次同步，结果可能不完整`);
	}
	for (const err of stats.errors.slice(0, maxErrors)) notes.push(`⚠ ${err}`);
	if (stats.errors.length > maxErrors) notes.push(`⚠ …另有 ${stats.errors.length - maxErrors} 条失败明细`);
	return notes;
}

/** 目录遍历失败的短原因标签：HTTP 状态优先，网络类归一句，其余取原始消息截断 */
function failureReason(e: unknown): string {
	if (e instanceof DavError && e.status != null) return `HTTP ${e.status}`;
	if (isNetworkFailure(e)) return "网络不可达";
	const msg = e instanceof Error ? e.message : String(e);
	return msg.length > 40 ? `${msg.slice(0, 40)}…` : msg;
}

interface RemoteFile {
	isDir: boolean;
	etag?: string;
	lastModified?: string;
	size?: number;
}

/**
 * 下载/冲突落盘后记账。etag 与远端修改时间**优先用遍历（PROPFIND）结果**：
 * 部分服务器只在 PROPFIND 给 etag（GET 响应无 ETag），且两处的修改时间并不一致；
 * 只记 GET 的值会让账本与远端永远对不上——文件每次同步都被当成「远端变过」重复下载。
 */
function recordDownloaded(
	ledger: Ledger,
	rel: string,
	abs: string,
	data: Uint8Array,
	known: RemoteFile | undefined,
	got: { etag?: string; lastModified?: string },
): void {
	const etag = got.etag ?? known?.etag;
	const lastModified = known?.lastModified ?? got.lastModified;
	ledger.files[rel] = {
		...(etag ? { etag } : {}),
		...(lastModified ? { remoteLastModified: lastModified } : {}),
		size: data.length,
		localMtime: fs.statSync(abs).mtimeMs,
	};
}

// ---------------------------------------------------------------------------
// 远端遍历
// ---------------------------------------------------------------------------

/** 递归遍历远端整树（BFS + 并发上限），返回 path → RemoteFile */
async function walkRemote(
	client: WebDavClient,
	onProgress?: (label: string) => void,
	signal?: AbortSignal,
): Promise<{ files: Map<string, RemoteFile>; failedDirs: FailedDir[] }> {
	const out = new Map<string, RemoteFile>();
	const failedDirs: FailedDir[] = [];
	const queue: string[] = ["/"];
	let dirsDone = 0;
	while (queue.length > 0) {
		if (signal?.aborted) throw new DavError("同步已取消", undefined, "SYNC");
		const batch = queue.splice(0, WALK_CONCURRENCY);
		await Promise.all(
			batch.map(async (dir) => {
				// 单目录失败重试一次（client 层已有网络错误/5xx/429 重试，此处兜偶发失败）；
				// 彻底失败则跳过该目录子树并记入 failedDirs——调用方据此抑制「远端已删」误判
				// （否则该目录下的文件会被当作远端已删而删本地），遍历不中断
				let entries;
				try {
					entries = await client.list(dir);
				} catch {
					await new Promise((r) => setTimeout(r, 1_000));
					try {
						entries = await client.list(dir);
					} catch (e) {
						failedDirs.push({ dir, reason: failureReason(e) });
						onProgress?.(`⚠ 目录 ${dir} 遍历失败已跳过：${e instanceof Error ? e.message : String(e)}`);
						return;
					}
				}
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
	return { files: out, failedDirs };
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
/**
 * 远端是否相对账本记录发生变化（自适应降级）：
 * - 双端 etag 都在：用 etag 比对（最可靠）；
 * - 任一 etag 缺失（部分 WebDAV 服务器不回 etag）：降级 lastModified(HTTP date 原文) + size 比对；
 * - 都不可比：false（感知不到，宁漏判不误判）。
 */
function remoteChangedSince(lf: LedgerFile, r: RemoteFile): boolean {
	if (lf.etag !== undefined && r.etag !== undefined) return lf.etag !== r.etag;
	if (lf.remoteLastModified && r.lastModified && lf.remoteLastModified !== r.lastModified) return true;
	if (r.size !== undefined && lf.size !== undefined && lf.size !== r.size) return true;
	return false;
}

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

/**
 * 增量同步（带锁 + 恢复日志）：锁被占按 opts.lockWaitMs 等待后仍拿不到才报错；上次中断
 * （journal 残留）报告后经重跑差异比对自然收敛——下载/上传/删除均幂等（删除前已有 .history 留档）。
 */
export async function syncAll(cfg: KbConfig, mirrorDir: string, opts: SyncOptions = {}): Promise<SyncStats> {
	const lock = await acquireSyncLock(mirrorDir, {
		waitMs: opts.lockWaitMs,
		signal: opts.signal,
		// 等待消息走进度通道：工具/命令/后台同步无需新增回调即可呈现「等待对方」
		onWait: (msg) => opts.onProgress?.(`⏳ ${msg}`),
	});
	try {
		const stale = recoverJournal(mirrorDir);
		if (stale) {
			const phaseName: Record<string, string> = {
				download: "下载",
				conflict: "冲突处理",
				upload: "上传",
				delete: "删除",
			};
			const when = stale.startedAt ? new Date(stale.startedAt).toLocaleString() : "上次";
			opts.onProgress?.(
				`上次同步（${when}）在「${phaseName[stale.phase] ?? stale.phase}」阶段被中断，正在自动继续（不会重复覆盖）`,
			);
		}
		return await syncAllInner(cfg, mirrorDir, opts, lock);
	} finally {
		lock.release();
	}
}

/** 增量同步主体（lock：acquireSyncLock 句柄，用于进度上报与阶段边界接管校验） */
async function syncAllInner(cfg: KbConfig, mirrorDir: string, opts: SyncOptions = {}, lock: SyncLock): Promise<SyncStats> {
	const stats: SyncStats = {
		downloaded: 0,
		uploaded: 0,
		deleted: 0,
		conflicts: 0,
		conflictFiles: [],
		failedDirs: [],
		unchanged: 0,
		errors: [],
	};
	const signal = opts.signal;
	const client = new WebDavClient(cfg.baseUrl!, cfg.username!, cfg.password!, {
		proxyUrl: cfg.proxyUrl,
	});
	const ledger = loadLedger(mirrorDir);
	// 进度统一走此包装：回调调用方的同时写进锁文件，等待方可见持有方实时进度
	const progress = (label: string) => {
		opts.onProgress?.(label);
		lock.report(label);
	};

	// 1) 远端遍历
	progress("遍历远端…");
	const { files: remote, failedDirs } = await walkRemote(client, progress, signal);
	stats.failedDirs = failedDirs;

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
		const remoteChanged = lf ? remoteChangedSince(lf, r) : false;
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
			// 遍历失败的目录子树不可信（远端可能有，只是没爬到）→ 跳过「远端已删」判定，等下次同步
			if (failedDirs.some((f) => (f.dir === "/" ? p.startsWith("/") : p.startsWith(f.dir + "/")))) continue;
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

	// 只读模式：不上传、不删远端——本地删除改为重新下载（远端为准），本地新建/修改留在本地
	if (cfg.readOnly) {
		toDownload.push(...delRemote);
		delRemote.length = 0;
		toUpload.length = 0;
	}

	// 恢复日志：计划落盘，各阶段推进时更新 phase；成功结束才删除（见到残留 journal 即上次中断）
	const journal: SyncJournal = {
		startedAt: new Date().toISOString(),
		phase: "download",
		toDownload,
		toUpload,
		delLocal,
		delRemote,
	};
	writeJournal(mirrorDir, journal);
	lock.assertOwned(); // 阶段边界校验：锁若已被接管（本进程曾挂起），到此为止

	// 3) 下载（并发）
	await mapLimit(toDownload, DOWNLOAD_CONCURRENCY, async (p) => {
		if (signal?.aborted) return;
		try {
			const { data, etag, lastModified } = await client.get(p);
			const abs = safeLocal(mirrorDir, p);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, data);
			recordDownloaded(ledger, p, abs, data, remote.get(p), { etag, lastModified });
			stats.downloaded++;
		} catch (e) {
			stats.errors.push(`下载 ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}
		progress(`下载 ${stats.downloaded}/${toDownload.length}`);
	});

	// 4) 冲突处理：保留远端为权威，本地版存 .conflict-<时间戳>.md（仅本地，不参与上传）
	journal.phase = "conflict";
	writeJournal(mirrorDir, journal);
	lock.assertOwned();
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
			recordDownloaded(ledger, p, abs, data, remote.get(p), { etag, lastModified });
			stats.conflicts++;
			stats.conflictFiles.push(p);
		} catch (e) {
			stats.errors.push(`冲突处理 ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}
		progress(`冲突处理 ${stats.conflicts}/${conflicts.length}`);
	}

	// 5) 上传（并发 + 父目录补齐）
	journal.phase = "upload";
	writeJournal(mirrorDir, journal);
	lock.assertOwned();
	await mapLimit(toUpload, UPLOAD_CONCURRENCY, async (p) => {
		if (signal?.aborted) return;
		try {
			const abs = safeLocal(mirrorDir, p);
			const data = fs.readFileSync(abs);
			// secret 扫描：命中疑似密钥 → 拦截上传（本地保留；账本无 etag 每次同步都会重试报错，提醒用户处理）
			if (!cfg.allowSecretUpload) {
				const hits = scanSecrets(data.toString("utf8"));
				if (hits.length) {
					stats.errors.push(
						`上传 ${p}: 含疑似密钥（${hits.join("、")}），已拦截上传，本地文件保留；确认无敏感信息后可移除密钥再同步，或把配置项 allowSecretUpload 设为 true 放行全部`,
					);
					return;
				}
			}
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
		progress(`上传 ${stats.uploaded}/${toUpload.length}`);
	});

	// 6) 删除：远端删本地文件；本地删远端文件（不删远端目录，目录由服务器自管）
	// 远端已删（delLocal）：本地是最后的副本 → 先留 .history 历史再删，防远端误删
	journal.phase = "delete";
	writeJournal(mirrorDir, journal);
	lock.assertOwned();
	for (const p of delLocal) {
		try {
			const abs = safeLocal(mirrorDir, p);
			try {
				backupToHistory(mirrorDir, p, new Uint8Array(fs.readFileSync(abs)));
			} catch {
				/* 备份失败不阻塞删除 */
			}
			fs.unlinkSync(abs);
			delete ledger.files[p];
			stats.deleted++;
		} catch (e) {
			stats.errors.push(`删除本地 ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}
		progress(`删除远端已删的文件 ${stats.deleted}/${delLocal.length}`);
	}
	let remoteDeleted = 0;
	for (const p of delRemote) {
		try {
			await client.delete(p);
			delete ledger.files[p];
			stats.deleted++;
		} catch (e) {
			// 404 = 远端已不存在，删除目标已达成（幂等）：照样清账本，不计错误
			if (e instanceof DavError && e.status === 404) {
				delete ledger.files[p];
				continue;
			}
			stats.errors.push(`删除远端 ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}
		progress(`删除本地已删的远端文件 ${++remoteDeleted}/${delRemote.length}`);
	}

	// 6.5) 清理本地镜像空目录（删文件后的残留；.kb- 与镜像根保留）
	pruneEmptyDirs(mirrorDir);

	// 7) 账本落盘
	ledger.syncedAt = new Date().toISOString();
	saveLedger(mirrorDir, ledger);

	// 8) LFS 元数据缓存刷新（只同步元数据，不下载本体）
	syncLfsCacheFromRemote(mirrorDir, remote);
	clearJournal(mirrorDir); // 全部完成，清除恢复日志
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
	// 覆盖（本地已有旧版）→ 先留 .history 历史副本（备份失败不阻塞写入）
	if (fs.existsSync(abs)) {
		try {
			backupToHistory(mirrorDir, relPath, new Uint8Array(fs.readFileSync(abs)));
		} catch {
			/* 忽略 */
		}
	}
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const tmp = abs + ".kb-tmp";
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, abs);
	const ledger = loadLedger(mirrorDir);
	const mtime = fs.statSync(abs).mtimeMs;
	ledger.files[relPath] = { ...ledger.files[relPath], size: fs.statSync(abs).size, localMtime: mtime };
	saveLedger(mirrorDir, ledger);
	// 立即上传（失败静默：账本 mtime 已更新，下次同步自动补传）
	// secret 扫描例外：命中疑似密钥不静默——抛错让工具层如实告知 AI/用户（本地已落盘，仅远端被拦）
	if (!cfg.allowSecretUpload) {
		const text = typeof content === "string" ? content : new TextDecoder().decode(content);
		const hits = scanSecrets(text);
		if (hits.length) {
			throw new Error(`笔记已在本地保存，但含疑似密钥（${hits.join("、")}），已拦截上传；确认无敏感信息后在 kb-config.json 设 allowSecretUpload 或手动移除密钥再同步`);
		}
	}
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
			if (rel === "/.history" || rel === "/PROTOCOL.md") continue; // 历史区/守则：内容浏览不透明（守则走 kb_help，历史走 WebDAV 客户端）
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
// .history 历史副本区：所有文件改动/删除的留档（/.history/，与根结构一致）
// ---------------------------------------------------------------------------

/** 历史副本区路径判断（/.history 及子树；备份与浏览/检索都排除它） */
export function isHistoryPath(rel: string): boolean {
	return rel === "/.history" || rel.startsWith("/.history/");
}

/** 时间戳后缀（yymmddhhmmss，本地时间） */
function historyStamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 内容哈希（sha1 前 8 位十六进制；同秒同内容判重用） */
function contentHash(bytes: Uint8Array): string {
	return createHash("sha1").update(bytes).digest("hex").slice(0, 8);
}

/**
 * 留历史副本：把 bytes 写入 /.history/<原路径>_yymmddhhmmss[.ext]（目录结构与根一致）。
 * 同秒重名 → 叠加 _hash 后缀；hash 也重名 → 同一份内容，跳过（返回 null）。
 * 自身不递归：/.history 与 /lfs/ 下的文件不备份。返回历史副本相对路径；跳过返回 null。
 */
export function backupToHistory(mirrorDir: string, relPath: string, bytes: Uint8Array): string | null {
	if (isHistoryPath(relPath) || isLfsPath(relPath)) return null;
	const histRel = "/.history" + relPath; // /notes/a.md → /.history/notes/a.md
	const dir = path.dirname(histRel);
	const name = path.basename(histRel);
	const stamp = historyStamp();
	const withStamp = name.replace(/(\.[^.]*)?$/, `_${stamp}$1`); // 扩展名前插后缀：a.md → a_250812102030.md
	let target = `${dir}/${withStamp}`;
	if (fs.existsSync(safeLocal(mirrorDir, target))) {
		const hash = contentHash(bytes);
		target = `${dir}/${withStamp.replace(/(\.[^.]*)?$/, `_${hash}$1`)}`;
		if (fs.existsSync(safeLocal(mirrorDir, target))) return null; // 同秒同内容：同一份，跳过
	}
	const abs = safeLocal(mirrorDir, target);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, bytes);
	// 账本登记（无 etag → 下次同步自动补传）
	const ledger = loadLedger(mirrorDir);
	ledger.files[target] = { size: bytes.byteLength, localMtime: fs.statSync(abs).mtimeMs };
	saveLedger(mirrorDir, ledger);
	return target;
}

/** 清理本地镜像空目录（删文件后的残留；.kb- 隐藏项与镜像根保留） */
function pruneEmptyDirs(mirrorDir: string): void {
	const walk = (dir: string): boolean => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const ent of entries) {
			if (!ent.isDirectory() || ent.name.startsWith(".kb-")) continue;
			const abs = path.join(dir, ent.name);
			if (walk(abs)) {
				try {
					fs.rmdirSync(abs);
				} catch {
					/* 目录非空/占用：忽略 */
				}
			}
		}
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => !e.name.startsWith(".kb-")).length === 0;
	};
	walk(mirrorDir);
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
