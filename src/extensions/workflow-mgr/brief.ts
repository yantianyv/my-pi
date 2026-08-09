/**
 * workflow-mgr 简报层：给 AI 看的文本视图（不依赖 TUI，非 TUI 模式也能用）
 *
 * - renderBrief：完整状态简报（当前任务+人机分工+交付物+完成信号、下一步、
 *   阻塞项、里程碑、最近决策、流程指令）——wf_status 的正文，也是
 *   before_agent_start 注入 systemPrompt 时 AI 参考的状态视图；
 * - summaryLine：一行进度摘要（常驻面板底部状态条 / session_start notify）；
 * - lightState：工具 results 的轻量 details——只带状态摘要与最近记录，
 *   不把 500 条 log 全量塞进会话条目。
 */
import type { TaskDef, WorkflowState } from "./types";
import type { Derived } from "./store";
import { nextPendingTask } from "./store";

export function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** 阻塞任务清单 */
export function blockedList(state: WorkflowState, derived: Derived): TaskDef[] {
	return derived.all.filter((t) => state.tasks[t.id]?.status === "blocked");
}

/** 当前任务（可能为 null：未开始 / 全部完成 / 空工作流） */
export function currentTask(state: WorkflowState, derived: Derived): TaskDef | null {
	if (!state.currentTaskId) return null;
	return derived.taskMap.get(state.currentTaskId) ?? null;
}

/** 给 AI 看的完整状态简报（也是 wf_status 返回的正文） */
export function renderBrief(state: WorkflowState, derived: Derived): string {
	const lines: string[] = [];
	const cur = currentTask(state, derived);
	const next = nextPendingTask(state, derived);

	lines.push("【工作流状态】");
	if (derived.all.length === 0) {
		lines.push("- 工作流为空：请用 wf_workflow add 规划阶段/任务（含人机分工、交付物、完成信号、依赖）");
	} else if (cur) {
		const stage = derived.stageOf.get(cur.id);
		lines.push(
			`- 当前阶段：${stage?.name ?? "?"}｜当前任务：${cur.id} ${cur.title}（${state.tasks[cur.id]?.status === "doing" ? "进行中" : "待开始"}）`,
		);
		// agent 模式（纯 agent 自动驾驶）不显示人类分工（0.3 拍板）
		if (derived.mode !== "agent") lines.push(`- 用户负责：${cur.humanTasks.join("；") || "（暂无）"}`);
		lines.push(`- 你（AI）负责：${cur.aiTasks.join("；") || "（暂无）"}`);
		lines.push(`- 交付物：${cur.deliverable || "（未定义）"}`);
		lines.push(`- 完成信号：${cur.doneSignal || "（未定义）"}`);
	} else if (next) {
		lines.push(`- 下一个任务：${next.id} ${next.title}（${derived.stageOf.get(next.id)?.name ?? "?"}）`);
	} else {
		lines.push("- 所有任务已完成");
	}

	const blocked = blockedList(state, derived);
	if (blocked.length) {
		lines.push(`- 阻塞任务：${blocked.map((t) => `${t.id} ${t.title}`).join("、")}`);
	}

	const milestones = Object.entries(state.milestones)
		.map(([name, m]) => `${name}${m.done ? "✓" : m.date ? `(${m.date})` : "(未定)"}`)
		.join(" ");
	if (milestones) lines.push(`- 里程碑：${milestones}`);

	if (state.notes.length) {
		const recent = state.notes.slice(-3).map((n) => truncate(n.content, 30));
		lines.push(`- 最近记录：${recent.join("｜")}`);
	}

	lines.push(
		"- 流程指令：你是流程指挥者，向用户下达当前任务的具体指令（📋 任务/🎯 目标/📌 做法/✅ 回报/🔍 验证）；任务完成后先按完成信号验证再调用 wf_switch 推进；交流中的重要结论/约束/偏好用 wf_note 记录（对用户透明）；卡住用 wf_block。",
	);
	return lines.join("\n");
}

/** 一行进度摘要：`进度 3/7｜当前：1.2 xxx` */
export function summaryLine(state: WorkflowState, derived: Derived): string {
	const done = derived.all.filter((t) => state.tasks[t.id]?.status === "done").length;
	const cur = currentTask(state, derived);
	return `进度 ${done}/${derived.all.length}｜当前：${cur ? cur.id + " " + cur.title : "全部完成"}`;
}

/** 轻量状态视图：工具 results 的 details（不带完整 log） */
export function lightState(state: WorkflowState) {
	const tasks: Record<string, { status: string; doneAt?: string; blockReason?: string }> = {};
	for (const [k, v] of Object.entries(state.tasks)) {
		tasks[k] = { status: v.status, doneAt: v.doneAt, blockReason: v.blockReason };
	}
	return {
		currentTaskId: state.currentTaskId,
		tasks,
		milestones: state.milestones,
		notes: state.notes.slice(-10),
		log: state.log.slice(-10),
	};
}
