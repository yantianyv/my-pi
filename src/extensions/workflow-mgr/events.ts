/**
 * workflow-mgr 事件注册层：session 钩子 + 会话绑定 + hud 联动 + 注入。
 *
 * 从 index.ts 拆出：
 * - session_start：解析会话绑定（多工作流并发隔离）——未绑定时按
 *   「槽位 ≥2 或有其他活跃会话已绑定」决定：自动绑定唯一槽（零行为变化）
 *   或请用户拍板——TUI 直接弹选择框（promptSlotChoice，确定性流程），
 *   非 TUI 退化为 before_agent_start 注入选择指引（AI 询问用户后 bind）；
 *   弹窗第二项「从 resume 中加载」放弃本会话、转官方恢复流程（/wf-resume 命令），
 *   恢复后按被恢复会话自己的绑定加载其工作流空间；
 * - hud:state-change：hud 开启/关闭时重算展示方式（hud 接管底部行 vs 自绘面板）；
 * - session_shutdown：注销 hud 底部行 + 移除 process 级监听器（跨 session/reload 防泄漏）；
 * - before_agent_start：刷新 UI + 条件注入（未绑定→选择指引；agent 模式→执行者；
 *   human-ai→指挥者角色；暂不启用/不用工作流→零注入）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BINDING_AUTO,
	DEFAULT_SLOT,
	getStore,
	hasOtherLiveBinding,
	invalidateBindingCache,
	isValidSlotName,
	listSlots,
	resolveBinding,
	setBinding,
	slotSummaries,
} from "./store";
import { hideWidget, unregisterHudRows, updateWidget } from "./panel";
import { SlotPickerComponent, type SlotPick } from "./slot-picker";
import { summaryLine } from "./brief";

/**
 * 工作流选择浮窗（session_start，TUI 专用）：多槽/并发场景请用户拍板本会话绑定。
 * 自绘分组浮窗（slot-picker.ts）：「通用」组（暂不启用 = 默认高亮、Esc 同此；
 * 从 resume 中加载会话 = 放弃本会话转恢复流程）与「实际工作流」槽位（带进度摘要）
 * + 新建视觉上明确区分。选定槽位/暂不启用即写 bindings.json 并失效缓存；
 * resume 不写绑定（由被恢复会话自己的绑定决定工作流空间）；
 * undefined = 浮窗自身异常、未决定——交回注入兜底路径。
 */
type SlotChoice = { kind: "slot"; slot: string } | { kind: "resume" } | undefined;

async function promptSlotChoice(ctx: ExtensionContext, sid: string, slots: string[]): Promise<SlotChoice> {
	const sums = slotSummaries(ctx.cwd);
	let pick: SlotPick | undefined;
	try {
		pick = await ctx.ui.custom<SlotPick>(
			(tui, theme, _kb, done) => {
				const comp = new SlotPickerComponent(sums, theme, done);
				comp.setTui(tui);
				return comp;
			},
			{ overlay: true, overlayOptions: { width: "64%", minWidth: 56, maxHeight: "80%" } },
		);
	} catch {
		// 浮窗基础设施异常（如启动时序 UI 未就绪）：不定绑定，走注入兑底
		return undefined;
	}
	if (pick?.kind === "resume") return { kind: "resume" }; // 不写绑定：本会话即将被恢复流程替换
	let slot: string;
	if (!pick || pick.kind === "defer") {
		slot = BINDING_AUTO; // Esc/明确选择 = 暂不启用（是否使用交给 AI 判断）
	} else if (pick.kind === "new") {
		let name: string | undefined;
		try {
			name = (await ctx.ui.input("新工作流名称", "字母/数字/中文开头，可含 _ -，≤32 字符"))?.trim();
		} catch {
			return undefined; // 输入框异常：不定绑定，走注入兑底
		}
		if (!name) {
			slot = BINDING_AUTO; // 输入框 Esc/空 → 暂不启用
		} else if (!isValidSlotName(name)) {
			ctx.ui.notify(`工作流名称不合法：「${name}」，已按「暂不启用」记下（可让 AI wf_workflow bind 重新绑定）`, "warning");
			slot = BINDING_AUTO;
		} else {
			slot = name;
		}
	} else {
		slot = pick.slot;
	}
	setBinding(ctx.cwd, sid, slot);
	invalidateBindingCache();
	if (slot === BINDING_AUTO) {
		ctx.ui.notify("已记下「暂不启用」：是否使用工作流由 AI 依任务判断（也可随时让 AI 用 wf_workflow bind 指定）", "info");
	} else if (!slots.includes(slot)) {
		ctx.ui.notify(`已创建并绑定新工作流「${slot}」（空）——让 AI 用 wf_workflow import/add 规划任务`, "info");
	}
	return { kind: "slot", slot };
}

/** 注册全部事件钩子 */
export function registerEvents(pi: ExtensionAPI) {
	let lastCtx: ExtensionContext | null = null;

	/* ---------- 事件：session_start 解析会话绑定 + 初始化常驻 UI ---------- */
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// resume/new/fork 会替换会话：强制重读绑定（bindings.json 以 sessionId 为键，
		// 被恢复会话命中自己的记录即恢复其工作流空间）
		invalidateBindingCache();
		let binding = resolveBinding(ctx);
		if (binding === undefined) {
			// sessionManager 在真实 pi 中恒存在；可选链兜底测试 mock
			const sid = ctx.sessionManager?.getSessionId?.() ?? "unknown";
			const slots = listSlots(ctx.cwd);
			if (slots.length >= 2 || hasOtherLiveBinding(ctx.cwd, sid)) {
				// 多工作流并存 / 有其他活跃会话已绑定：需用户拍板本会话用哪个。
				// 固定分支流程走确定性 TUI 弹窗（不靠提示词驱动 AI 询问，更稳定）；
				// 非 TUI 环境无法弹窗，退化为 before_agent_start 注入选择指引。
				if (ctx.hasUI) {
					const choice = await promptSlotChoice(ctx, sid, slots);
					if (choice === undefined) {
						// 弹窗异常未决：隐藏面板，交给 before_agent_start 注入兑底
						hideWidget(ctx);
						return;
					}
					if (choice.kind === "resume") {
						// 放弃本会话、恢复历史会话：转 /wf-resume 命令（switchSession 只在
						// 命令上下文可用，事件处理器拿不到；sendUserMessage 会派发自注册命令）。
						// 不写本会话绑定——恢复后由被恢复会话自己的绑定决定工作流空间。
						hideWidget(ctx);
						pi.sendUserMessage("/wf-resume", { expandPromptTemplates: true });
						return;
					}
					binding = choice.slot;
				} else {
					hideWidget(ctx);
					return;
				}
			} else {
				// 单工作流或无工作流：自动绑定（对既有单工作流项目零行为变化）
				setBinding(ctx.cwd, sid, slots[0] ?? DEFAULT_SLOT);
				invalidateBindingCache();
				binding = slots[0] ?? DEFAULT_SLOT;
			}
		}
		if (binding === null || binding === BINDING_AUTO) {
			// 明确不用 / 暂不启用：面板隐藏、零注入（暂不启用由 AI 需要时自行 bind）
			hideWidget(ctx);
			return;
		}
		const s = getStore(ctx);
		s.reload();
		updateWidget(ctx, s);
		const state = s.getState();
		const derived = s.getDerived();
		// 空工作流（无任务）不弹状态通知，避免「进度 0/0｜当前：全部完成」
		if (derived.all.length > 0) ctx.ui.notify(summaryLine(state, derived, s.slot), "info");
	});

	// hud 开启/关闭时重算展示方式：hud 接管底部行（面板隐藏） vs workflow 自绘常驻面板。
	// hud 是事件源（footer dispose 时 emit("hud:state-change")），本扩展持最新 ctx 响应，不依赖加载顺序。
	// reload 陷阱：/reload 先 dispose 旧 UI（hud dispose → emit 本事件）再发 session_shutdown，
	// 此时 lastCtx 已被 pi 标记 stale，getStore 因 cwd 已固化不会再崩（stale-ctx 修复），但
	// updateWidget(lastCtx) 访问 lastCtx.ui 仍会触发 assertActive 抛错——process 事件回调里的
	// 异常无人捕获会成为 uncaughtException 直接杀掉 pi，这里 try/catch 静默跳过：旧实例即将
	// 卸载，刷新交给新实例的 session_start 完成。
	const onHudStateChange = () => {
		if (!lastCtx) return;
		try {
			const s = getStore(lastCtx);
			if (s.blocked) {
				hideWidget(lastCtx);
				return;
			}
			s.reload(); // 面板/数据槽路径可能已切，重载后再刷新
			updateWidget(lastCtx, s);
		} catch {
			// ctx stale（reload 收尾阶段）：跳过即可，不向上抛。
		}
	};
	(process as unknown as { on: (e: string, fn: () => void) => unknown }).on("hud:state-change", onHudStateChange);

	/* ---------- 事件：session_shutdown 注销 hud 底部行 + 移除 process 级监听器（跨 session/reload 防泄漏） ---------- */
	pi.on("session_shutdown", async () => {
		unregisterHudRows();
		(process as unknown as { removeListener?: (e: string, fn: () => void) => unknown }).removeListener?.("hud:state-change", onHudStateChange);
	});

	/* ---------- 事件：before_agent_start 条件注入（0.2 拍板：有活动工作流才注入，按 mode 三态） ---------- */
	pi.on("before_agent_start", async (event, ctx) => {
		const s = getStore(ctx);
		// 未绑定（非 TUI 环境弹不了选择框的兜底；TUI 已在 session_start 弹窗拍板）：注入选择指引
		if (s.blocked === "undecided") {
			hideWidget(ctx);
			const sums = slotSummaries(ctx.cwd);
			const list = sums.length
				? sums.map((x) => `- ${x.slot}：进度 ${x.done}/${x.total}${x.current ? `｜当前：${x.current}` : ""}`).join("\n")
				: "（暂无）";
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\n【工作流】本项目存在多个并发工作流，本会话尚未绑定：\n" +
					list +
					"\n请用 ask 工具询问用户本会话使用哪个工作流（选项：「暂不启用（由 AI 依任务判断）」排第一，其次为上述现有工作流 / 新建工作流），" +
					"然后调用 wf_workflow action=bind 完成绑定（slot=工作流名，新名称即新建空工作流再用 import 规划；" +
					"slot=\"auto\" = 用户暂不启用、由你判断是否使用；slot=\"none\" = 明确不用）。" +
					"绑定前不要调用其他 wf_* 工具（会被拒绝）。",
			};
		}
		// 本会话明确不用工作流：零注入、面板隐藏
		if (s.blocked === "none") {
			hideWidget(ctx);
			return {};
		}
		// 暂不启用（用户不指定工作流、也不关掉）：零注入零打扰——需要时由 AI 自行 wf_workflow bind 启用
		if (s.blocked === "auto") {
			hideWidget(ctx);
			return {};
		}
		updateWidget(ctx, s);
		// 无工作流（未创建或空）→ 零注入：简单任务不被引导使用工作流，agent 靠 wf_workflow 工具描述按需发现
		if (!s.hasWorkflowFile()) return {};
		const derived = s.getDerived();
		if (derived.all.length === 0) return {};
		// 纯 agent 模式（0.3 拍板：自动驾驶，无人类分工）→ 轻量执行者提示词
		if (derived.mode === "agent") {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\n【工作流】你是自动驾驶执行者（纯 agent 模式，无人类分工）：" +
					"用 wf_status 获取当前任务；用 wf_switch 连续推进（完成当前+开始下一个）直到全部任务完成并 wf_workflow archive 收尾；" +
					"执行中产生了后续任务需要知晓的事实/约束时，用 wf_note 记录；" +
					"遇到确实无法完成的任务（缺数据/权限/外部依赖）用 wf_block 标记原因并停下向用户报告，不擅自跳过或放宽完成信号。",
			};
		}
		// 人机协作模式 → 完整指挥者角色提示词
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n【工作流】你是工作流指挥者，用户是执行者：" +
				"用 wf_status 获取当前任务与分工；用 wf_workflow 规划/调整任务（阶段→任务，含人机分工、交付物、完成信号、依赖）；" +
				"向用户下达具体指令（📋 任务/🎯 目标/📌 做法/✅ 回报/🔍 验证）；" +
				"用户完成后先按完成信号验证再调 wf_switch 推进；交流中产生了后续步骤需要知晓的结论/约束时，用 wf_note 记录；卡住时用 wf_block。" +
				"界面底部的 📋 面板已为用户展示当前状态，无需重复汇报。",
		};
	});
}
