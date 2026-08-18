/**
 * webui 事件桥：pi 事件 → SSE 广播；HTTP 请求 → pi API 操作
 *
 * 双端同步的核心：本扩展跑在 TUI 进程内，与 TUI 共享同一个 session——
 * - 下行（TUI → 浏览器）：pi.on() 监听全部会话/agent/tool 事件，实时广播；
 * - 上行（浏览器 → TUI）：pi.sendUserMessage() 以真实用户消息注入当前会话，
 *   TUI 聊天记录同步出现；abort/切模型/切 thinking 走 pi API 与 ctx。
 *
 * ctx 缓存策略：session_start 时缓存当前 ctx（abort/isIdle 需要），
 * session_shutdown 清空——session 替换后不操作过期 ctx（参考 workflow-mgr store 经验）。
 *
 * hud-cost 生命周期在此驱动：session_start → resetCostTracking，
 * turn_start → startTurn，turn_end → recordTurnCosts（与 hud 各算各的，事件源相同）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resetCostTracking, startTurn, recordTurnCosts, refreshExchangeRate } from "../hud/hud-cost";
import { getDetailedGitStatus, gitAdd, gitReset, gitDiscard, gitRemoveUntracked, gitCommit, gitPush, gitPull, gitFetch, gitBranchList, gitCheckout, type GitDetailedStatus } from "../hud/hud-git";
import { buildSnapshot, type WebuiSnapshot } from "./state";

/** 工具结果广播时的最大长度（避免把巨量输出推给浏览器） */
const TOOL_RESULT_MAX = 2_000;

/** 从 ToolResult 对象提取可读文本（{content:[{type:"text",text}]} → 纯文本；字符串原样；其他 JSON） */
function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const text = content
				.map((c) => (c && typeof c === "object" ? ((c as { text?: unknown }).text ?? "") : ""))
				.filter((t) => typeof t === "string" && t)
				.join("\n");
			if (text) return text;
		}
	}
	return JSON.stringify(result);
}

export type BroadcastFn = (msg: Record<string, unknown>) => void;

/** 浏览器端上传图片（base64），随消息发送 */
export interface WebuiImage {
	mediaType: string;
	data: string; // base64（不带 data: 前缀）
}

/** 历史条目序列化（前端渲染聊天记录） */
export interface HistoryEntry {
	id: string;
	type: string;
	role: string | null;
	message: unknown;
}

export class Bridge {
	constructor(
		private pi: ExtensionAPI,
		private broadcast: BroadcastFn,
	) {}

	private ctx: ExtensionContext | null = null;

	/** 待 flush 的图片占位条目（assistant message_start 时追加到对应 user 消息下） */
	private pendingImages: Array<{ count: number; mediaTypes: string[] }> = [];

	// ------------------------------------------------------------------
	// 会话上下文
	// ------------------------------------------------------------------

	/** 当前缓存 ctx（session_start 后有效）；abort / isIdle / snapshot 用 */
	getCtx(): ExtensionContext | null {
		return this.ctx;
	}

	// ------------------------------------------------------------------
	// 事件注册（session_start 时调用一次，跨 session 常驻）
	// ------------------------------------------------------------------

	attach(): void {
		const pi = this.pi;

		pi.on("session_start", async (event, ctx) => {
			await this.onSessionStart(event, ctx);
		});

		pi.on("session_shutdown", async (event) => {
			this.ctx = null;
			this.broadcast({ type: "session_shutdown", reason: event.reason });
		});

		pi.on("session_info_changed", async (event) => {
			this.broadcast({ type: "session_info_changed", name: event.name ?? null });
		});

		// 会话树导航（/tree 回退）与压缩：消息集已变，通知前端全量重建
		pi.on("session_tree", async () => {
			this.broadcast({ type: "session_tree" });
		});

		pi.on("session_compact", async () => {
			this.broadcast({ type: "session_compact" });
		});

		// -- 消息生命周期（前端据此渲染聊天流） --

		// 待追加的图片占位条目（TUI 侧）：message_end(user) 时收集，随后第一条 assistant
		// message_start 时 flush——此时该 user 消息已持久化、leafId 已指向它，appendCustomEntry
		// 的 parentId 挂到 user 消息下（成为其子节点），回退/删除该消息时标签一起消失。
		// 若在 message_end(user) 立即追加，user 尚未写入 sessionManager（appendMessage 在扩展
		// 事件之后执行），custom 会成为上一条消息的子节点，树变成「上一条 → custom → user」，
		// 回退（navigateTree 到 user 消息取 parentId）时标签残留在界面上。
		pi.on("message_start", async (event) => {
			this.broadcast({ type: "message_start", message: event.message });
			if (event.message.role === "assistant" && this.pendingImages.length) {
				for (const p of this.pendingImages) {
					try {
						this.pi.appendEntry("webui-images", p);
					} catch {
						// 占位追加失败不影响消息本身
					}
				}
				this.pendingImages = [];
			}
		});

		pi.on("message_update", async (event) => {
			this.broadcast({ type: "message_update", event: event.assistantMessageEvent });
		});

		// message_end 时该消息已写入 sessionManager，leafId 即其 entryId（供前端绑定回退按钮）
		pi.on("message_end", async (event, ctx) => {
			this.broadcast({ type: "message_end", message: event.message, entryId: ctx.sessionManager.getLeafId() });
			// 图片占位显示组件：TUI 渲染 user 消息时丢弃 image content（getUserMessageText 只取 text，
			// 纯图片消息甚至整条不渲染）。收集带图 user 消息，由上方 message_start(assistant) 在
			// user 持久化后追加一条**不进 LLM 上下文**的 CustomEntry（type:"custom"，buildSessionContext
			// 忽略），由 registerEntryRenderer("webui-images") 渲染为「[N 张图片]」标签，紧跟在用户消息
			// 下方显示——占位纯显示，不污染发给模型的文本。
			// 追加必须用 pi.appendEntry（会 emit entry_appended → TUI addCustomEntryToChat 实时渲染），
			// 不能用 ctx.sessionManager.appendCustomEntry（只 persist 不通知渲染，标签要等 TUI 全量
			// 重渲染才可见，表现为「一轮对话结束后才出现」）。
			if (event.message.role === "user") {
				const content = event.message.content;
				const images = Array.isArray(content) ? content.filter((c) => c.type === "image") : [];
				if (images.length) {
					this.pendingImages.push({
						count: images.length,
						mediaTypes: images.map((i) => (i as { mimeType?: string }).mimeType ?? ""),
					});
				}
			}
		});

		// -- 工具执行 --

		pi.on("tool_execution_start", async (event) => {
			this.broadcast({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
		});

		pi.on("tool_execution_end", async (event) => {
			const result = extractToolResultText(event.result);
			this.broadcast({
				type: "tool_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				result: result.length > TOOL_RESULT_MAX ? `${result.slice(0, TOOL_RESULT_MAX)}…` : result,
			});
		});

		// -- agent / turn 生命周期 --

		pi.on("agent_start", async () => {
			this.broadcast({ type: "agent_start" });
		});

		pi.on("agent_end", async () => {
			this.broadcast({ type: "agent_end" });
		});

		pi.on("agent_settled", async () => {
			this.broadcast({ type: "agent_settled" });
		});

		pi.on("turn_start", async (event) => {
			startTurn();
			this.broadcast({ type: "turn_start", turnIndex: event.turnIndex });
		});

		pi.on("turn_end", async (event, ctx) => {
			recordTurnCosts(ctx);
			this.broadcast({ type: "turn_end", turnIndex: event.turnIndex });
			// 顺带推一次状态快照（成本/git 等实时更新；git/余额有内部节流，开销可控）
			const snapshot = await buildSnapshot(ctx, this.pi);
			this.broadcast({ type: "snapshot", snapshot });
		});

		// -- 模型 / thinking --

		pi.on("model_select", async (event, ctx) => {
			this.broadcast({ type: "model_select", model: event.model, previousModel: event.previousModel ?? null, source: event.source });
			// 切模型后余额/消耗等卡片数据随 provider 变化，立即推一次快照同步侧栏
			const snapshot = await buildSnapshot(ctx, this.pi);
			this.broadcast({ type: "snapshot", snapshot });
		});

		pi.on("thinking_level_select", async (event) => {
			this.broadcast({ type: "thinking_select", level: event.level });
		});
	}

	/** 会话初始化（attach 的 session_start 事件与 index 入口手动调用共用，避免首次 ctx 丢失） */
	async onSessionStart(event: { reason: string }, ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		// 会话替换（fork/switch）后清掉未 flush 的占位队列，避免残留到新会话
		this.pendingImages = [];
		resetCostTracking(ctx);
		// 汇率缓存预热（1h 节流在 hud-cost 内部，失败静默）
		void refreshExchangeRate();
		this.broadcast({ type: "session_start", reason: event.reason, snapshot: await buildSnapshot(ctx, this.pi) });
	}

	// ------------------------------------------------------------------
	// 状态 / 历史
	// ------------------------------------------------------------------

	/** 状态快照（前端 /api/state 与定时刷新用） */
	async getSnapshot(): Promise<WebuiSnapshot | null> {
		const ctx = this.ctx;
		if (!ctx) return null;
		return buildSnapshot(ctx, this.pi);
	}

	/** 历史条目（sessionManager 全量 entries，前端首屏渲染） */
	getHistory(): HistoryEntry[] {
		const ctx = this.ctx;
		if (!ctx) return [];
		return ctx.sessionManager
			.getEntries()
			.filter((e) => e.type === "message" || e.type === "custom")
			.map((e) => ({
				id: e.id,
				type: e.type,
				role: e.type === "message" ? (e as { message: { role: string } }).message.role : null,
				message: e.type === "message" ? (e as { message: unknown }).message : null,
			}));
	}

	// ------------------------------------------------------------------
	// 操作（浏览器 → pi）
	// ------------------------------------------------------------------

	/** 发送用户消息（idle 直发；流式中默认 steer 排队，前端可指定 deliverAs；支持图片）
	 *  / 开头的消息自动带 expandPromptTemplates（分发扩展命令 / 展开 skill 与 prompt 模板） */
	async sendMessage(
		text: string,
		deliverAs?: "steer" | "followUp",
		images?: WebuiImage[],
	): Promise<{ ok: boolean; error?: string }> {
		try {
			// 视觉能力防御：当前模型不支持图片时直接报错（避免发出必然 400 的请求）
			if (images?.length) {
				const input = this.ctx?.model?.input;
				if (input && !input.includes("image")) {
					const id = this.ctx?.model?.id ?? "当前模型";
					return { ok: false, error: `当前模型 ${id} 不支持上传图片，请切换到视觉模型（如 anthropic/openai 系列）` };
				}
			}
			// 有图片走 content array。pi-ai 的 ImageContent 是扁平格式 {type,data,mimeType}，
			// 注意不是 Anthropic 嵌套式 source:{}（嵌套式会被原样转发导致 provider 400）
			const payload: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }> = images?.length
				? [
						...(text.trim() ? [{ type: "text", text }] : []),
						...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mediaType })),
					]
				: text;
			const expand = text.startsWith("/") ? { expandPromptTemplates: true as const } : {};
			if (this.ctx && !this.ctx.isIdle() && !deliverAs) {
				await this.pi.sendUserMessage(payload as string, { deliverAs: "steer", ...expand });
			} else if (deliverAs) {
				await this.pi.sendUserMessage(payload as string, { deliverAs, ...expand });
			} else {
				await this.pi.sendUserMessage(payload as string, expand);
			}
			return { ok: true };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	/** 回退（fork）到指定消息：经 /webui 的隐藏 fork 子命令分发（fire-and-forget——fork 会触发
	 *  session 替换（旧 server 随之释放），HTTP 响应拿不到 fork 返回文本；前端已持有
	 *  消息原文，等 session_start(fork) 事件后自行填入输入框即可） */
	async fork(entryId: string): Promise<{ ok: boolean; error?: string }> {
		if (!entryId) return { ok: false, error: "缺少 entryId" };
		try {
			await this.pi.sendUserMessage(`/webui fork ${entryId}`, { expandPromptTemplates: true });
			return { ok: true };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	/** 可用模型列表（webui 模型选择器；含视觉/推理能力标记供前端展示徽标） */
	getModels(): Array<{ provider: string; id: string; vision: boolean; reasoning: boolean; current: boolean }> {
		const ctx = this.ctx;
		if (!ctx) return [];
		try {
			const cur = ctx.model;
			return ctx.modelRegistry.getAvailable().map((m) => ({
				provider: m.provider,
				id: m.id,
				vision: m.input?.includes("image") ?? false,
				reasoning: m.reasoning ?? false,
				current: !!cur && cur.provider === m.provider && cur.id === m.id,
			}));
		} catch {
			return [];
		}
	}

	/** 可用斜杠命令列表（扩展命令 + prompt 模板 + skill 命令；内置交互命令不在其中） */
	getCommands(): Array<{ name: string; description?: string; source: string }> {
		try {
			return this.pi
				.getCommands()
				.map((c) => ({ name: c.name, description: c.description, source: c.source }));
		} catch {
			return [];
		}
	}

	/** 中止当前 agent 运行（session_shutdown 后 ctx 过期则不操作） */
	abort(): void {
		this.ctx?.abort();
	}

	/** 切换模型（pi.setModel 需要 modelRegistry 解析出的 Model 对象） */
	async setModel(provider: string, id: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const model = this.ctx?.modelRegistry.find(provider, id);
			if (!model) return { ok: false, error: `模型不存在：${provider}/${id}` };
			const success = await this.pi.setModel(model);
			return success ? { ok: true } : { ok: false, error: "该模型无可用 API key" };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	/** 设置 thinking 级别（clamped 到模型能力，非推理模型恒 off） */
	setThinking(level: string): { ok: boolean; error?: string } {
		try {
			this.pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			return { ok: true };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	/** git 操作（复用 hud-git，纯 cwd 级） */
	async gitOp(
		op: string,
		params: { paths?: string[]; message?: string; branch?: string; create?: boolean },
	): Promise<{ ok: boolean; error?: string; data?: unknown }> {
		const ctx = this.ctx;
		if (!ctx) return { ok: false, error: "会话未就绪" };
		const cwd = ctx.cwd;
		try {
			switch (op) {
				case "status":
					return { ok: true, data: await getDetailedGitStatus(cwd) };
				case "add":
					await gitAdd(cwd, params.paths ?? []);
					break;
				case "reset":
					await gitReset(cwd, params.paths ?? []);
					break;
				case "discard":
					await gitDiscard(cwd, params.paths ?? []);
					break;
				case "rm-untracked":
					await gitRemoveUntracked(cwd, params.paths ?? []);
					break;
				case "commit":
					await gitCommit(cwd, params.message ?? "");
					break;
				case "push":
					await gitPush(cwd);
					break;
				case "pull":
					await gitPull(cwd);
					break;
				case "fetch":
					await gitFetch(cwd);
					break;
				case "branches":
					return { ok: true, data: await gitBranchList(cwd) };
				case "checkout":
					await gitCheckout(cwd, params.branch ?? "", params.create ?? false);
					break;
				default:
					return { ok: false, error: `未知 git 操作：${op}` };
			}
			// 操作成功后返回最新状态（state.ts 的 30s 节流缓存随后自然刷新）
			return { ok: true, data: await getDetailedGitStatus(cwd) };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
}
