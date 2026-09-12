/**
 * pair-guard：多 pi 会话并发协作守卫
 *
 * 场景：多个 pi 实例同时编辑同一项目时，AI 对其他会话的存在与动向一无所知，
 * 容易互相覆盖/冲突。本扩展让每个会话互相可见，并把并发状态注入 AI 上下文。
 *
 * 机制（项目级会话注册表：<cwd>/.pi/sessions/<sessionId>.json）：
 * - session_start 注册自己（sessionId/pid/启动时间），心跳周期更新 lastBeat；
 *   心跳超 PEER_TIMEOUT_MS 判定死亡（崩溃残留由其他会话扫描时顺带清理）
 * - write/edit 工具调用记录「我最近在改哪些文件」（滚动窗口 RECENT_FILE_TTL_MS）
 * - 广播式知情：peer 加入/离开/触碰新文件/标签变化等事件以定制消息
 *   （customType=pair-guard）追加到对话历史尾部（下一轮开始前投递）——
 *   尾部追加不破坏前缀缓存，且每条广播成为历史中的即时记录，AI 可随时回查
 * - 软冲突警告：write/edit 命中 peer 近窗口期内写过的文件时，tool_result 追加
 *   ⚠️ 警告文本（不阻断，AI 自行调整：先读最新内容、小步修改、告知用户）
 * - 状态栏推「👥 N 并发会话」（hud 动态区），peer 出现/消失时 notify 用户
 * - /pair 命令：查看 peer 详情 / label <文本> 设置自己的任务标签 / prune 手动清残留
 *
 * 任务标签：/pair label 手动设置优先；未设置时自动读 workflow-mgr 的
 * .pi/workflow/state.json 当前任务标题（零耦合读文件，缺失落空串）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveJsonConfig } from "./shared/config";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000; // 心跳间隔（同时承担 peer 扫描/状态刷新）
const PEER_TIMEOUT_MS = 5 * 60_000; // 心跳超时判死（崩溃残留清理阈值）
const RECENT_FILE_TTL_MS = 10 * 60_000; // 「最近修改」滚动窗口（注入与冲突判定共用）
const MAX_RECENT_FILES = 20; // 每会话记录的最近文件上限
const EDIT_PERSIST_THROTTLE_MS = 3_000; // 编辑记录落盘节流（连续编辑时）
const WF_CACHE_TTL_MS = 30_000; // workflow 任务标题读取缓存
const STATUS_KEY = "pair-guard";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface RecentFile {
	path: string; // 相对 cwd 的 posix 风格路径
	at: number;
	op: "write" | "edit";
}

/** 会话注册表记录（.pi/sessions/<sessionId>.json） */
interface SessionRecord {
	sessionId: string;
	pid: number;
	startedAt: number;
	lastBeat: number;
	/** 手动任务标签（/pair label 设置，跨 reload 保留） */
	label: string;
	/** 自动任务标签（workflow-mgr 当前任务标题，心跳时刷新） */
	task: string;
	recentFiles: RecentFile[];
}

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let self: SessionRecord | null = null;
	let selfFile = "";
	let sessionsDir = "";
	let cwd = "";
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	/** peer 快照（sessionId → 已知文件集合/标签），心跳 diff 出广播事件 */
	let peerSnapshot = new Map<string, { files: Set<string>; label: string }>();
	/** 待投递广播队列（before_agent_start 一次性排空合并为一条消息） */
	let pendingBroadcasts: string[] = [];
	let lastEditPersist = 0;
	let wfCache: { at: number; title: string } | null = null;

	// ---- 小工具 ------------------------------------------------------------

	const short = (sid: string) => sid.slice(0, 6);

	/** 广播行时间戳：绝对 HH:MM（消息是永久历史记录，相对时间会在回查时误导） */
	function hhmm(): string {
		const d = new Date();
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}

	/** 任意路径 → 相对 cwd 的 posix 风格路径（cwd 外保留绝对路径） */
	function relPath(base: string, p: string): string {
		const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p);
		const rel = path.relative(base, abs);
		return (rel && !rel.startsWith("..") ? rel : abs).split(path.sep).join("/");
	}

	/** 路径等价比较（Windows 大小写不敏感） */
	function samePath(a: string, b: string): boolean {
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	}

	function persistSelf(): void {
		if (self && selfFile) saveJsonConfig(selfFile, self);
	}

	/** 读取 workflow-mgr 当前任务标题（零耦合读文件，带缓存；无工作流 → 空串） */
	function workflowTaskTitle(): string {
		const now = Date.now();
		if (wfCache && now - wfCache.at < WF_CACHE_TTL_MS) return wfCache.title;
		let title = "";
		try {
			const state = JSON.parse(
				fs.readFileSync(path.join(cwd, ".pi", "workflow", "state.json"), "utf8"),
			) as { currentTaskId?: string | null };
			if (state.currentTaskId) {
				const wf = JSON.parse(
					fs.readFileSync(path.join(cwd, ".pi", "workflow", "workflow.json"), "utf8"),
				) as { stages?: Array<{ tasks?: Array<{ id?: string; title?: string }> }> };
				for (const s of wf.stages ?? []) {
					for (const t of s.tasks ?? []) {
						if (t.id === state.currentTaskId && t.title) {
							title = t.title;
							break;
						}
					}
					if (title) break;
				}
			}
		} catch {
			/* 无工作流或文件损坏 → 空串 */
		}
		wfCache = { at: now, title };
		return title;
	}

	/** 扫描活跃 peer：读注册表，剔除自己，顺带清理心跳超时的死亡会话文件 */
	function scanPeers(): SessionRecord[] {
		const now = Date.now();
		const peers: SessionRecord[] = [];
		let names: string[] = [];
		try {
			names = fs.readdirSync(sessionsDir);
		} catch {
			return peers; // 目录不存在 = 无 peer
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(sessionsDir, name);
			let rec: SessionRecord | null = null;
			try {
				rec = JSON.parse(fs.readFileSync(file, "utf8")) as SessionRecord;
			} catch {
				continue; // 损坏文件跳过（写入是原子的，正常不会坏）
			}
			if (!rec || typeof rec.sessionId !== "string" || typeof rec.lastBeat !== "number") continue;
			if (self && rec.sessionId === self.sessionId) continue;
			if (now - rec.lastBeat > PEER_TIMEOUT_MS) {
				try {
					fs.unlinkSync(file); // 死亡会话残留，顺手清理
				} catch {
					/* 清理失败下次再来 */
				}
				continue;
			}
			if (!Array.isArray(rec.recentFiles)) rec.recentFiles = [];
			peers.push(rec);
		}
		return peers.sort((a, b) => b.lastBeat - a.lastBeat);
	}

	function updateStatus(ctx: ExtensionContext, peerCount: number): void {
		ctx.ui.setStatus(STATUS_KEY, peerCount > 0 ? `👥 ${peerCount} 并发会话` : undefined);
	}

	/**
	 * peer 快照 diff → 广播事件 + 用户通知 + 状态行
	 * 广播只报变化（加入/离开/新触碰文件/标签变化），连续编辑同一文件不重复报（降噪）
	 */
	function diffPeers(peers: SessionRecord[], ctx: ExtensionContext): void {
		const now = Date.now();
		const seen = new Set(peers.map((p) => p.sessionId));
		for (const p of peers) {
			const label = p.label || p.task;
			const who = `会话 ${short(p.sessionId)}${label ? `（任务：${label}）` : ""}`;
			const files = p.recentFiles.filter((f) => now - f.at < RECENT_FILE_TTL_MS).map((f) => f.path);
			const prev = peerSnapshot.get(p.sessionId);
			if (!prev) {
				pendingBroadcasts.push(
					files.length > 0
						? `${hhmm()} ${who} 加入本项目，近 10 分钟改过：${files.slice(0, 5).join("、")}`
					: `${hhmm()} ${who} 加入本项目，暂无文件修改记录`,
				);
				ctx.ui.notify(`pair-guard：新的并发会话加入（${short(p.sessionId)}${label ? `，任务：${label}` : ""}）`, "info");
			} else {
				for (const f of files) {
					if (![...prev.files].some((pf) => samePath(pf, f))) {
						pendingBroadcasts.push(`${hhmm()} ${who} 开始修改 ${f}`);
					}
				}
				if (label !== prev.label) {
					pendingBroadcasts.push(`${hhmm()} ${who} 任务标签更新为「${label || "无"}」`);
				}
			}
			peerSnapshot.set(p.sessionId, { files: new Set(files), label });
		}
		for (const id of [...peerSnapshot.keys()]) {
			if (!seen.has(id)) {
				pendingBroadcasts.push(`${hhmm()} 会话 ${short(id)} 已离开`);
				peerSnapshot.delete(id);
				ctx.ui.notify(`pair-guard：并发会话 ${short(id)} 已结束`, "info");
			}
		}
		if (pendingBroadcasts.length > 50) pendingBroadcasts.splice(0, pendingBroadcasts.length - 50); // 防长时间空闲无限累积
		updateStatus(ctx, peers.length);
	}

	/** 心跳：刷新自己的 lastBeat/自动标签/滚动窗口，扫描 peer 变化并生成广播 */
	function beat(ctx: ExtensionContext): void {
		if (!self) return;
		const now = Date.now();
		self.lastBeat = now;
		self.task = workflowTaskTitle();
		self.recentFiles = self.recentFiles.filter((f) => now - f.at < RECENT_FILE_TTL_MS);
		persistSelf();
		diffPeers(scanPeers(), ctx);
	}

	// ---- 生命周期 ----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		sessionsDir = path.join(cwd, ".pi", "sessions");
		const sid = ctx.sessionManager.getSessionId();
		selfFile = path.join(sessionsDir, `${sid}.json`);
		// 跨 reload 保留手动标签（同一 sessionId 的旧文件还在）
		let prevLabel = "";
		try {
			prevLabel = (JSON.parse(fs.readFileSync(selfFile, "utf8")) as SessionRecord).label ?? "";
		} catch {
			/* 首次注册 */
		}
		self = {
			sessionId: sid,
			pid: process.pid,
			startedAt: Date.now(),
			lastBeat: Date.now(),
			label: prevLabel,
			task: workflowTaskTitle(),
			recentFiles: [],
		};
		persistSelf();
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(() => beat(ctx), HEARTBEAT_INTERVAL_MS);

		// 初始扫描：peerSnapshot 为空，diff 自然生成全部 peer 的「加入」广播（首轮即知情）
		diffPeers(scanPeers(), ctx);
	});

	pi.on("session_shutdown", async () => {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		if (selfFile) {
			try {
				fs.unlinkSync(selfFile); // 注销自己；崩溃时靠心跳超时由 peer 清理
			} catch {
				/* 已不存在 */
			}
		}
		self = null;
		peerSnapshot.clear();
		pendingBroadcasts = [];
		wfCache = null;
	});

	// ---- 文件修改跟踪（write/edit 记录进自己的注册文件，不阻断） --------------

	pi.on("tool_call", async (event, ctx) => {
		if (!self) return;
		const isWrite = isToolCallEventType("write", event);
		const isEdit = isToolCallEventType("edit", event);
		if (!isWrite && !isEdit) return;
		const rel = relPath(ctx.cwd, event.input.path);
		if (rel.startsWith(".pi/")) return; // 注册表/工作流等运行时数据不跟踪
		const now = Date.now();
		self.recentFiles = self.recentFiles.filter((f) => !samePath(f.path, rel));
		self.recentFiles.unshift({ path: rel, at: now, op: isWrite ? "write" : "edit" });
		if (self.recentFiles.length > MAX_RECENT_FILES) self.recentFiles.length = MAX_RECENT_FILES;
		self.lastBeat = now;
		if (now - lastEditPersist > EDIT_PERSIST_THROTTLE_MS) {
			lastEditPersist = now;
			persistSelf();
		}
	});

	// ---- 软冲突警告（write/edit 命中 peer 近窗口写过的文件 → 结果追加 ⚠️） -------

	pi.on("tool_result", async (event, _ctx) => {
		if (!self) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (event.isError) return;
		const p = (event.input as { path?: unknown }).path;
		if (typeof p !== "string") return;
		const rel = relPath(cwd, p);
		if (rel.startsWith(".pi/")) return;
		const now = Date.now();
		for (const peer of scanPeers()) {
			const hit = peer.recentFiles.find((f) => samePath(f.path, rel) && now - f.at < RECENT_FILE_TTL_MS);
			if (!hit) continue;
			const agoMin = Math.max(1, Math.round((now - hit.at) / 60_000));
			const label = peer.label || peer.task;
			const who = `${short(peer.sessionId)}${label ? `（任务：${label}）` : ""}`;
			const warn: (typeof event.content)[number] = {
				type: "text",
				text:
					`[pair-guard ⚠️ 并发提示] 文件 ${rel} 在最近 ${agoMin} 分钟内也被另一个 pi 会话 ${who} 修改过，存在并发冲突风险：\n` +
					`1) 你的本次修改可能覆盖了对方刚写入的内容（或对方稍后会覆盖你的）；\n` +
					`2) 后续修改此文件前建议先重新读取最新内容；\n` +
					`3) 若涉及同一区域的实质性改动，请在回复中提醒用户存在并发编辑，由用户协调两个会话的分工。`,
			};
			return { content: [...event.content, warn] };
		}
	});

	// ---- 广播投递（下一轮开始前把累积事件合并为一条消息追加到历史尾部） ----------
	// 尾部追加不破坏前缀缓存；消息入历史后内容不变，后续轮次自身也参与缓存命中

	pi.on("before_agent_start", async () => {
		if (pendingBroadcasts.length === 0) return;
		const lines = pendingBroadcasts.splice(0);
		return {
			message: {
				customType: "pair-guard",
				display: true,
				content:
					"[pair-guard 并发广播] 其他 pi 会话的实时动向：\n" +
					lines.map((l) => `- ${l}`).join("\n") +
					"\n（协作约定：修改上述会话近期触碰的文件前先重读最新内容、改动保持最小；涉及同一区域的实质性改动请在回复中提醒用户协调分工。）",
			},
		};
	});

	// ---- /pair 命令 ------------------------------------------------------------

	pi.registerCommand("pair", {
		description: "并发协作守卫：查看并发会话 / label <任务标签> / prune 清理死亡会话注册",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "prune") {
				let removed = 0;
				const now = Date.now();
				try {
					for (const name of fs.readdirSync(sessionsDir)) {
						if (!name.endsWith(".json")) continue;
						const file = path.join(sessionsDir, name);
						try {
							const rec = JSON.parse(fs.readFileSync(file, "utf8")) as SessionRecord;
							if (now - rec.lastBeat > PEER_TIMEOUT_MS && rec.sessionId !== self?.sessionId) {
								fs.unlinkSync(file);
								removed++;
							}
						} catch {
							/* 跳过 */
						}
					}
				} catch {
					/* 目录不存在 */
				}
				ctx.ui.notify(`pair-guard：已清理 ${removed} 个死亡会话注册`, "info");
				return;
			}
			if (sub === "label" || sub.startsWith("label ")) {
				if (!self) return;
				self.label = sub.slice(5).trim();
				persistSelf();
				ctx.ui.notify(
					self.label ? `pair-guard：本会话任务标签已设为「${self.label}」` : "pair-guard：已清除任务标签",
					"info",
				);
				return;
			}
			// 无参：peer 详情
			const peers = scanPeers();
			updateStatus(ctx, peers.length);
			if (peers.length === 0) {
				ctx.ui.notify("pair-guard：当前没有其他并发会话", "info");
				return;
			}
			const now = Date.now();
			const lines = peers.map((p) => {
				const agoMin = Math.max(0, Math.round((now - p.lastBeat) / 60_000));
				const label = p.label || p.task || "（无标签）";
				const files = p.recentFiles
					.filter((f) => now - f.at < RECENT_FILE_TTL_MS)
					.map((f) => `${f.path}（${Math.max(0, Math.round((now - f.at) / 60_000))} 分钟前）`)
					.join("、");
				return `会话 ${short(p.sessionId)}（pid ${p.pid}，${agoMin} 分钟前活跃）\n  任务：${label}\n  最近修改：${files || "无"}`;
			});
			ctx.ui.notify(`pair-guard：${peers.length} 个并发会话\n${lines.join("\n")}`, "info");
		},
	});
}
