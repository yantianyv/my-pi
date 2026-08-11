/**
 * workflow-mgr 事件注册层：session 钩子 + hud 联动 + 注入。
 *
 * 从 index.ts 拆出：
 * - session_start：重载缓存、刷新常驻 UI、进度通知；
 * - hud:state-change：hud 开启/关闭时重算展示方式（hud 接管底部行 vs 自绘面板）；
 * - session_shutdown：注销 hud 底部行 + 移除 process 级监听器（跨 session/reload 防泄漏）；
 * - before_agent_start：刷新 UI + 注入「指挥者角色」systemPrompt（1.5 改为条件注入）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getStore } from "./store";
import { unregisterHudRows, updateWidget } from "./panel";
import { summaryLine } from "./brief";

/** 注册全部事件钩子 */
export function registerEvents(pi: ExtensionAPI) {
	let lastCtx: ExtensionContext | null = null;

	/* ---------- 事件：session_start 初始化常驻 UI ---------- */
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		const s = getStore(ctx);
		s.reload();
		updateWidget(ctx, s);
		const state = s.getState();
		const derived = s.getDerived();
		// 空工作流（无任务）不弹状态通知，避免「进度 0/0｜当前：全部完成」
		if (derived.all.length > 0) ctx.ui.notify(summaryLine(state, derived), "info");
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
