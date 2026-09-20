/**
 * pair-guard：会话注册表与在场感知（多 pi 会话并发协作 + AI 自报进度标题）
 *
 * 场景：多个 pi 实例同时编辑同一项目时，AI 对其他会话的存在与动向一无所知，
 * 容易互相覆盖/冲突。本扩展让每个会话互相可见，并把并发状态注入 AI 上下文。
 * 注册表是本扩展的核心：守卫（软冲突警告）与标题互见都是其上的应用。
 *
 * 机制（项目级会话注册表：<cwd>/.pi/sessions/<sessionId>.json）：
 * - session_start 注册自己（sessionId/pid/启动时间），心跳周期更新 lastBeat；
 *   判死双保险：①扫描时 process.kill(pid, 0) 探测进程存活（关窗强杀走不了
 *   session_shutdown，pid 一死下次扫描即清理，秒级）；②lastBeat 超 PEER_TIMEOUT_MS
 *   兑底（pid 探测不可用的场景）；process.on("exit") 同步注销补漏崩溃场景
 * - write/edit 工具调用记录「我最近在改哪些文件」（滚动窗口 RECENT_FILE_TTL_MS）
 * - 广播式知情：peer 加入/离开/触碰新文件/标签变化等事件以定制消息
 *   （customType=pair-guard）注入对话历史——检测走双通道：turn_start 每个模型
 *   调用边界扫一次 peer（主通道，延迟 ≈ 一次模型调用）+ 30s 心跳兑底（长单次
 *   流式/空闲期）；检测到变化即经 sendMessage(deliverAs="steer") 在下一个工具
 *   边界实时送达运行中的 turn，空闲时攒到 before_agent_start（先扫一次再排空，
 *   新指令开局即最新）；尾部追加不破坏前缀缓存，每条广播成为历史中的即时记录；
 *   事件行极筒（时间 + 短 id + 动作，标签只在加入/变更行带）、队列按事件键去重
 *   （防 reload 快照重建出重复行）、协作约定只在首批广播附带一次
 * - 软冲突警告：write/edit 命中 peer 近窗口期内写过的文件时，tool_result 追加
 *   ⚠️ 警告文本（不阻断，AI 自行调整：先读最新内容、小步修改、告知用户）
 * - 状态栏推「👥 N 并发会话」（hud 动态区），peer 出现/消失时 notify 用户
 * - AI 自报标题：set_title 工具写两级标题——work（整个工作在干啥，同步
 *   pi.setSessionName，/resume 会话选择器直接可见）+ step（当前步骤在干啥，
 *   带 stepSource=manual/auto 来源标记，workflow-mgr 自动兜底不覆盖 AI 手写值）；
 *   step 同时推送到执行中 Working 行（ctx.ui.setWorkingMessage：manual 显「正在…」，
 *   auto 显「正在推进「任务」…」，step 清空恢复默认）；
 *   标题进注册表供 peer 互见，不单独发广播（随其他广播事件行内捎带，/pair 详情完整展示）
 * - /pair 命令：查看 peer 详情 / label <文本> 设置自己的任务标签 / prune 手动清残留
 *
 * 任务标签：仅 /pair label 手动设置（曾自动读 workflow-mgr 当前任务，但工作流是
 * 项目级共享的——多会话并发时各会话显示同一标签，没有意义，已移除）。
 * 多工作流并发隔离由 workflow-mgr 的会话绑定（wf_workflow bind）负责。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
const STATUS_KEY = "pair-guard";
const MAX_TITLE_LEN = 60; // work/step 标题长度上限（超出截断，防广播行与会话选择器被刷屏）

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
	/** AI 自报：整个工作的标题（set_title work，同步 pi.setSessionName） */
	work?: string;
	/** AI 自报：当前步骤标题（set_title step 或 workflow-mgr 联动兜底） */
	step?: string;
	/** step 来源：manual=AI 显式设置（workflow 兜底不覆盖）/ auto=workflow-mgr 联动写入 */
	stepSource?: "manual" | "auto";
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
	/** 待投递广播队列（before_agent_start 一次性排空合并为一条消息）；
	 *  pendingKeys 去重：同一排空窗口内同类事件只报一次（reload 快照重建等时序下防重复行） */
	let pendingBroadcasts: string[] = [];
	let pendingKeys = new Set<string>();
	/** 本会话是否已投递过首批广播（协作约定只在首批附带一次，后续不重复） */
	let conventionSent = false;
	/** 已推送到 Working 行的 step 值（null=尚未推送过；变化检测防重复调用） */
	let lastPushedStep: string | undefined | null = null;
	/** agent 是否在运行（agent_start→agent_end）：运行中心跳把广播 steer 进 turn，空闲攒到下轮注入 */
	let agentRunning = false;
	let lastEditPersist = 0;

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

	/** 进程是否存活（ESRCH=不存在；EPERM=活着但无权限；异常按活着处理，交由心跳超时兑底） */
	function pidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			return (e as NodeJS.ErrnoException).code !== "ESRCH";
		}
	}

	/** 扫描活跃 peer：读注册表，剔除自己，顺带清理死亡会话文件（pid 死亡 / 心跳超时） */
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
			// 判死①：pid 已死 = 进程不在（关窗强杀不会走 session_shutdown，靠此秒级发现）
			// 判死②：心跳超时兑底（pid 缺失/探测受限的场景）
			const dead =
				typeof rec.pid === "number" && !pidAlive(rec.pid) ? true : now - rec.lastBeat > PEER_TIMEOUT_MS;
			if (dead) {
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

	/** 入队一条广播（同 key 去重；队列满则丢弃新事件，防长时间不排空爆积） */
	function pushBroadcast(key: string, line: string): void {
		if (pendingKeys.has(key) || pendingBroadcasts.length >= 50) return;
		pendingKeys.add(key);
		pendingBroadcasts.push(line);
	}

	/** 排空广播队列 → 合并为一条消息文本（协作约定首批附带）；无待投递返回 null */
	function drainBroadcasts(): string | null {
		if (pendingBroadcasts.length === 0) return null;
		const lines = pendingBroadcasts.splice(0);
		pendingKeys.clear();
		let content = "[pair-guard] 并发会话动向：\n" + lines.map((l) => `- ${l}`).join("\n");
		if (!conventionSent) {
			// 协作约定只在首批广播附带一次（历史里永久可见，后续广播不再重复）
			conventionSent = true;
			content += "\n（协作约定：改上述会话近期文件前先重读最新内容；大改同一区域请提醒用户协调分工。后续广播不再重复本约定。）";
		}
		return content;
	}

	/**
	 * 运行中实时投递：agent 在跑且有积压广播时，经 sendMessage(deliverAs="steer")
	 * 在下一个工具边界注入当前 turn——长 turn（几分钟级）不用等下轮才看到 peer 动向。
	 * 空闲时不主动发（不 triggerTurn），留给 before_agent_start 排空。
	 */
	function flushSteer(): void {
		if (!agentRunning) return;
		const content = drainBroadcasts();
		if (!content) return;
		pi.sendMessage(
			{ customType: "pair-guard", display: true, content },
			{ deliverAs: "steer", triggerTurn: false },
		);
	}

	/** peer 的紧凑活动描述：step（带 work 前缀）优先，其次 work，再次手动 label */
	function peerActivity(p: SessionRecord): string {
		if (p.step) return p.work ? `${p.work}：${p.step}` : p.step;
		return p.work ?? (p.label || "");
	}

	const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

	/** 把当前 step 同步到 pi 的 Working 加载行（streaming 时替代默认「Working」）；step 清空时恢复默认 */
	function syncWorkingMessage(ctx: ExtensionContext): void {
		const cur = self?.step;
		if (cur === lastPushedStep) return;
		lastPushedStep = cur;
		// manual 是 AI 写的动词短语（工具描述要求不带「正在」）；auto 是工作流任务标题（名词短语，加「推进」）
		ctx.ui.setWorkingMessage(
			cur ? (self?.stepSource === "auto" ? `正在推进「${cur}」…` : `正在${cur}…`) : undefined,
		);
	}

	/**
	 * peer 快照 diff → 广播事件 + 用户通知 + 状态行
	 * 广播只报变化（加入/离开/新触碰文件/标签变化），连续编辑同一文件不重复报；
	 * 标题（work/step）不单独发广播，随事件行行内捎带（截断防刷屏）；/pair 详情看完整值
	 */
	function diffPeers(peers: SessionRecord[], ctx: ExtensionContext, initial = false): void {
		const now = Date.now();
		const seen = new Set(peers.map((p) => p.sessionId));
		for (const p of peers) {
			const label = p.label;
			const act = trunc(peerActivity(p), 50);
			const files = p.recentFiles.filter((f) => now - f.at < RECENT_FILE_TTL_MS).map((f) => f.path);
			const prev = peerSnapshot.get(p.sessionId);
			if (!prev) {
				let line = `${hhmm()} ${short(p.sessionId)} ${initial ? "已在工作" : "加入"}`;
				if (act) line += `（${act}）`;
				if (files.length > 0) line += `，近期改过：${files.slice(0, 5).join("、")}`;
				pushBroadcast(`join:${p.sessionId}`, line);
				if (!initial) {
					ctx.ui.notify(`pair-guard：新的并发会话加入（${short(p.sessionId)}${act ? `，${act}` : ""}）`, "info");
				}
			} else {
				for (const f of files) {
					if (![...prev.files].some((pf) => samePath(pf, f))) {
						pushBroadcast(`file:${p.sessionId}:${f.toLowerCase()}`, `${hhmm()} ${short(p.sessionId)} 修改了 ${f}${act ? `（${act}）` : ""}`);
					}
				}
				if (label !== prev.label && label) {
					pushBroadcast(`label:${p.sessionId}:${label}`, `${hhmm()} ${short(p.sessionId)} 任务：${label}`);
				}
			}
			peerSnapshot.set(p.sessionId, { files: new Set(files), label });
		}
		for (const id of [...peerSnapshot.keys()]) {
			if (!seen.has(id)) {
				pushBroadcast(`leave:${id}`, `${hhmm()} ${short(id)} 离开`);
				peerSnapshot.delete(id);
				ctx.ui.notify(`pair-guard：并发会话 ${short(id)} 已结束`, "info");
			}
		}
		updateStatus(ctx, peers.length);
	}

	/** 心跳：刷新自己的 lastBeat/滚动窗口，扫描 peer 变化并生成广播（运行中实时 steer 投递） */
	function beat(ctx: ExtensionContext): void {
		if (!self) return;
		const now = Date.now();
		self.lastBeat = now;
		self.recentFiles = self.recentFiles.filter((f) => now - f.at < RECENT_FILE_TTL_MS);
		persistSelf();
		syncWorkingMessage(ctx); // API 桥（workflow-mgr 兑底）无 ctx，统一在这里检出变化后推送
		diffPeers(scanPeers(), ctx);
		flushSteer();
	}

	// ---- 生命周期 ----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		sessionsDir = path.join(cwd, ".pi", "sessions");
		const sid = ctx.sessionManager.getSessionId();
		selfFile = path.join(sessionsDir, `${sid}.json`);
		// 跨 reload 保留手动标签与 AI 自报标题（同一 sessionId 的旧文件还在）
		let prev: Partial<SessionRecord> = {};
		try {
			prev = JSON.parse(fs.readFileSync(selfFile, "utf8")) as SessionRecord;
		} catch {
			/* 首次注册 */
		}
		self = {
			sessionId: sid,
			pid: process.pid,
			startedAt: Date.now(),
			lastBeat: Date.now(),
			label: prev.label ?? "",
			work: prev.work,
			step: prev.step,
			stepSource: prev.stepSource,
			recentFiles: [],
		};
		persistSelf();
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(() => beat(ctx), HEARTBEAT_INTERVAL_MS);

		// 初始扫描：peerSnapshot 为空，diff 生成「已在工作」现状行（首轮即知情；区别于中途「加入」事件）
		const peers = scanPeers();
		diffPeers(peers, ctx, true);
		if (peers.length > 0) {
			ctx.ui.notify(`pair-guard：${peers.length} 个并发会话在线（/pair 查看详情）`, "info");
		}
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
		lastPushedStep = null;
		delete (globalThis as Record<string, unknown>).__PI_PAIR_GUARD_API__;
		peerSnapshot.clear();
		pendingBroadcasts = [];
		pendingKeys.clear();
		conventionSent = false;
		agentRunning = false;
	});

	// ---- agent 运行状态跟踪（决定广播是 steer 实时投递还是攒到下轮注入） -------------

	pi.on("agent_start", async () => {
		agentRunning = true;
	});

	pi.on("agent_end", async () => {
		agentRunning = false;
	});

	// ---- turn 边界扫描（实时性主通道） ------------------------------------------------
	// turn_start 每个模型调用边界都触发（agent 循环里每步一次），比 30s 心跳快得多：
	// peer 事件最迟下一个 turn 边界被发现，随即 steer 注入（交付延迟 ≈ 一次模型调用）。
	// 心跳仍保留：长单次流式（无工具调用）/ 空闲期的兜底检测与用户通知。

	pi.on("turn_start", async (_event, ctx) => {
		if (!self) return;
		syncWorkingMessage(ctx); // turn 边界即推送：Working 行本就只有 streaming 时可见，零感知延迟
		diffPeers(scanPeers(), ctx);
		flushSteer();
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
			const act = trunc(peerActivity(peer), 30);
			const who = `${short(peer.sessionId)}${act ? `（${act}）` : ""}`;
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

	// ---- 广播投递（空闲路径：下一轮开始前把累积事件合并为一条消息追加到历史尾部） ------
	// 尾部追加不破坏前缀缓存；消息入历史后内容不变，后续轮次自身也参与缓存命中。
	// 运行中的实时投递见 flushSteer（turn_start/心跳里 steer 注入当前 turn）。

	pi.on("before_agent_start", async (_event, ctx) => {
		// 开局即最新：注入前先扫一次 peer——空闲期积累的事件在此检测，
		// 本轮首次模型调用就带上最新状态，不等 turn_start 边界（此时 agent 未跑，
		// diffPeers 产的广播走下方排空而非 steer）
		if (self) diffPeers(scanPeers(), ctx);
		const content = drainBroadcasts();
		if (!content) return;
		return {
			message: {
				customType: "pair-guard",
				display: true,
				content,
			},
		};
	});

	// ---- set_title 工具（AI 自报进度标题） ------------------------------------------

	/** 应用标题变更并落盘：work 同步 pi.setSessionName，step 带来源标记；返回变更描述行 */
	function applyTitle(work: string | undefined, step: string | undefined, source: "manual" | "auto"): string[] {
		if (!self) return [];
		const changed: string[] = [];
		if (work !== undefined) {
			const w = work.trim().slice(0, MAX_TITLE_LEN);
			self.work = w || undefined;
			if (w) pi.setSessionName(w); // 会话显示名：/resume 选择器直接可见（pi 原生持久化）
			changed.push(w ? `工作标题已设为「${w}」` : "工作标题已清除");
		}
		if (step !== undefined) {
			const s = step.trim().slice(0, MAX_TITLE_LEN);
			self.step = s || undefined;
			self.stepSource = s ? source : undefined;
			changed.push(s ? `步骤标题已设为「${s}」` : "步骤标题已清除");
		}
		if (changed.length > 0) persistSelf();
		return changed;
	}

	/** 跨扩展联动桥：workflow-mgr 经此写入自动兜底的 step 标题（仿 __PI_HUD_API__ 模式） */
	(globalThis as Record<string, unknown>).__PI_PAIR_GUARD_API__ = {
		setTitle: (work: string | undefined, step: string | undefined, source: "manual" | "auto"): void => {
			if (!self) return;
			if (source === "auto") {
				// AI 手写的 step 优先：manual 值不被自动兑底覆盖；无变化不落盘
				if (step === undefined || self.stepSource === "manual" || step === self.step) return;
			}
			applyTitle(work, step, source);
		},
	};

	pi.registerTool({
		name: "set_title",
		label: "自报进度标题",
		description:
			"给当前会话设置两级标题，讲述自己正在干啥。" +
			"work=整个工作的标题（如「重构 HUD 余额模块」）：同步为会话显示名，用户在 /resume 恢复会话时直接看到，" +
			"也写入会话注册表供同项目的其他并发 pi 会话互见；开始一项新工作时设置一次，工作转向时更新。" +
			"step=当前步骤的标题（如「正在改 hud-balance 适配器」）：随工作推进及时更新，" +
			"其他并发会话据此了解你的实时进度、避免冲突。" +
			"两者至少传一个；传空字符串清除对应标题。",
		promptSnippet:
			"自报进度：set_title({work?, step?}) → work=整体工作标题（/resume 可见），step=当前步骤（并发会话互见）",
		parameters: Type.Object({
			work: Type.Optional(Type.String({ description: "整个工作的标题（空串清除）；开始新工作时设置" })),
			step: Type.Optional(
				Type.String({
					description:
						"当前步骤的标题（空串清除）；推进到不同步骤时更新。用简短动词短语（如「改 hud-balance 适配器」），不要带「正在」前缀——本会话执行中的 Working 行会显示为「正在…」",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!self) {
				return { content: [{ type: "text", text: "会话尚未注册（session_start 未触发），稍后再试" }], details: {} };
			}
			const work = typeof params.work === "string" ? params.work : undefined;
			const step = typeof params.step === "string" ? params.step : undefined;
			if (work === undefined && step === undefined) {
				return { content: [{ type: "text", text: "work 与 step 至少传一个" }], details: {} };
			}
			const changed = applyTitle(work, step, "manual");
			syncWorkingMessage(ctx); // 立即生效，不等下个 turn 边界
			return { content: [{ type: "text", text: changed.join("；") }], details: {} };
		},
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
							const deadByPid = typeof rec.pid === "number" && !pidAlive(rec.pid);
							if ((deadByPid || now - rec.lastBeat > PEER_TIMEOUT_MS) && rec.sessionId !== self?.sessionId) {
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
				const label = p.label || "（无标签）";
				const titles = (p.work ? `\n  工作：${p.work}` : "") + (p.step ? `\n  步骤：${p.step}` : "");
				const files = p.recentFiles
					.filter((f) => now - f.at < RECENT_FILE_TTL_MS)
					.map((f) => `${f.path}（${Math.max(0, Math.round((now - f.at) / 60_000))} 分钟前）`)
					.join("、");
				return `会话 ${short(p.sessionId)}（pid ${p.pid}，${agoMin} 分钟前活跃）${titles}\n  任务：${label}\n  最近修改：${files || "无"}`;
			});
			ctx.ui.notify(`pair-guard：${peers.length} 个并发会话\n${lines.join("\n")}`, "info");
		},
	});
}
