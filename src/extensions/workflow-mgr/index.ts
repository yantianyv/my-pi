/**
 * workflow-mgr — 人机协作任务面板（通用工作流版）
 *
 * 定位：AI 是流程指挥者（拆解、排序、验证、推进），人类是执行者（做任务、拍板）。
 * 插件把「流程控制」变成稳定基础设施，不依赖提示词级别的自觉。
 *
 * 与 thesis-workflow（论文垂直版）的差异：工作流定义不再写死在代码里，
 * 由 AI 用 wf_workflow 工具动态创建/修改，加载任意任务；里程碑动态增删；
 * /workflow-config 命令组 + 面板开关持久化（.pi/workflow/config.json）。
 * hud 接管：hud 存在且开启（globalThis.__PI_HUD_ACTIVE__）时，经 hud 通用接口
 * （globalThis.__PI_HUD_API__.registerExtraRows）注册底部行渲染，内容与样式由本扩展
 * 决定（与常驻面板同款），常驻面板隐藏；hud 缺席/关闭（hud:state-change 事件）时
 * 退化自绘常驻面板，两者零耦合。
 *
 * 数据（项目级、跨会话、可 git 审查）：
 * - .pi/workflow/workflow.json  工作流定义（阶段→任务，含人机分工/交付物/完成信号/依赖）
 * - .pi/workflow/state.json     进度状态（currentTaskId/tasks/milestones/decisions/log）
 * - .pi/workflow/config.json    面板开关等 UI 配置
 *
 * 工具：wf_workflow（list/add/edit/remove/reset）、wf_status、wf_start、wf_done、
 *       wf_block、wf_rollback、wf_decision、wf_milestone。
 * 命令：/workflow-config 轻量功能浮窗（显示详细信息/常驻面板开关）；快捷子命令 toggle/done/start/block。
 * 事件：session_start 加载+刷新+notify；before_agent_start 向 systemPrompt 追加
 *       「指挥者角色」指南（不注入 message——避免淹没对话、膨胀会话文件）。
 *
 * 架构：多文件扩展（index/store/brief/panel/types），build.js
 * 打包为单文件 dist/extensions/workflow-mgr.ts；展示层走官方 setStatus 通道
 * （key "workflow-mgr"），hud 缺席时自动回落原生 footer。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
	WorkflowStore,
	cloneWorkflow,
	findTask,
	genTaskId,
	hasDependencyCycle,
	logEvent,
	nextPendingTask,
	reconcile,
} from "./store";
import { lightState, renderBrief, summaryLine } from "./brief";
import { textPanel, unregisterHudRows, updateWidget, WfmgMenuPanelComponent } from "./panel";
import type { TaskDef } from "./types";

/* ============================== 工具参数 schema ============================== */

const statusParams = Type.Object({});
const startParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "任务 ID，如 1.2（不填则开始下一个满足依赖的待办任务）" })),
});
const doneParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "任务 ID，默认当前任务" })),
	note: Type.Optional(Type.String({ description: "完成备注（可选）" })),
});
const blockParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "任务 ID，默认当前任务" })),
	reason: Type.String({ description: "阻塞原因" }),
});
const rollbackParams = Type.Object({
	taskId: Type.String({ description: "要回退的任务 ID" }),
	to: StringEnum(["todo", "doing"], { description: "回退到的状态（blocked 任务请用 wf_start 解除）" }),
});
const decisionParams = Type.Object({
	topic: Type.String({ description: "决策主题" }),
	options: Type.Array(Type.String({ description: "候选选项" })),
	choice: Type.Optional(Type.String({ description: "用户的选择" })),
	reason: Type.Optional(Type.String({ description: "选择理由" })),
});
const milestoneParams = Type.Object({
	name: Type.String({ description: "里程碑名（不存在则自动创建），如 开题/中期/答辩" }),
	date: Type.Optional(Type.String({ description: "日期，如 2026-03-15" })),
	done: Type.Optional(Type.Boolean({ description: "是否已完成" })),
});
const workflowParams = Type.Object({
	action: StringEnum(["list", "add", "edit", "remove", "reset"], {
		description: "操作类型：list 查看全量；add 新增任务（stageId 不存在则自动创建阶段）；edit 修改任务字段；remove 删除任务；reset 清空工作流",
	}),
	stageId: Type.Optional(Type.String({ description: "阶段 ID；add 时不存在则自动创建新阶段" })),
	stageName: Type.Optional(Type.String({ description: "阶段名（add 创建新阶段时使用，缺省用 stageId）" })),
	stageGoal: Type.Optional(Type.String({ description: "阶段目标（add 创建新阶段时使用）" })),
	taskId: Type.Optional(Type.String({ description: "任务 ID：add 可选指定（缺省自动生成如 1.2）；edit/remove 必填" })),
	title: Type.Optional(Type.String({ description: "任务标题" })),
	desc: Type.Optional(Type.String({ description: "任务目标/描述" })),
	humanTasks: Type.Optional(Type.Array(Type.String({ description: "人类负责的事项（传空数组清空）" }))),
	aiTasks: Type.Optional(Type.Array(Type.String({ description: "AI 负责的事项（传空数组清空）" }))),
	deliverable: Type.Optional(Type.String({ description: "交付物" })),
	doneSignal: Type.Optional(Type.String({ description: "完成信号（AI 据此验证）" })),
	deps: Type.Optional(Type.Array(Type.String({ description: "依赖的任务 id 列表（传空数组清空）" }))),
});

type StartParams = Static<typeof startParams>;
type DoneParams = Static<typeof doneParams>;
type BlockParams = Static<typeof blockParams>;
type RollbackParams = Static<typeof rollbackParams>;
type DecisionParams = Static<typeof decisionParams>;
type MilestoneParams = Static<typeof milestoneParams>;
type WorkflowParams = Static<typeof workflowParams>;

/** 任务详情文本（wf_start / wf_done 下一步共用） */
function taskDetail(t: { id: string; title: string; humanTasks: string[]; aiTasks: string[]; deliverable: string; doneSignal: string }, stageName: string): string {
	return (
		`- 用户负责：${t.humanTasks.join("；") || "（暂无）"}\n` +
		`- AI 负责：${t.aiTasks.join("；") || "（暂无）"}\n` +
		`- 交付物：${t.deliverable || "（未定义）"}\n` +
		`- 完成信号：${t.doneSignal || "（未定义）"}\n` +
		`- 阶段：${stageName}`
	);
}

export default function (pi: ExtensionAPI) {
	// 单会话缓存容器：session_start 或 cwd 变化时重建（重建即从磁盘重载）
	let store: WorkflowStore | null = null;
	const getStore = (ctx: ExtensionContext): WorkflowStore => {
		if (!store || store.cwd !== ctx.cwd) store = new WorkflowStore(ctx);
		return store;
	};
	/** 状态/工作流变更后：落盘 + 刷新常驻 UI */
	const commitAndRefresh = (ctx: ExtensionContext) => {
		const s = getStore(ctx);
		s.commitState();
		updateWidget(ctx, s);
	};
	const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: { kind: "error" as const } });

	/* ---------- 工具：wf_workflow（工作流定义管理） ---------- */
	pi.registerTool({
		name: "wf_workflow",
		label: "工作流定义",
		description:
			"创建/修改工作流定义（阶段→任务，含人机分工、交付物、完成信号、依赖）。" +
			"list 查看全量（含各任务状态）；add 新增任务（stageId 不存在自动创建阶段，id 缺省自动生成）；" +
			"edit 修改任务任意字段（传空数组清空列表字段）；remove 删除任务（同步清理状态与空阶段）；" +
			"reset 清空工作流（无阶段无任务，不可逆）。规划复杂项目时先用 add 建出完整骨架，再逐步细化。",
		promptSnippet: "workflow: create/update the human-AI collaboration workflow definition",
		parameters: workflowParams,
		async execute(_id, params: WorkflowParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			const derived = s.getDerived();
			const wf = s.getWorkflow();

			if (params.action === "list") {
				const text =
					`【工作流定义】共 ${wf.stages.length} 个阶段、${derived.all.length} 个任务\n\n` +
					wf.stages
						.map((st) => {
							const done = st.tasks.filter((t) => state.tasks[t.id]?.status === "done").length;
							return (
								`▎${st.name}（${st.id}，${done}/${st.tasks.length} 完成）${st.goal ? `：${st.goal}` : ""}\n` +
								st.tasks
									.map((t) => {
										const stt = state.tasks[t.id]?.status ?? "todo";
										const mark = stt === "done" ? "✓" : stt === "doing" ? "▶" : stt === "blocked" ? "⛔" : "○";
										return (
											`  ${mark} ${t.id} ${t.title}${stt === "blocked" && state.tasks[t.id]?.blockReason ? `（${state.tasks[t.id].blockReason}）` : ""}\n` +
											`      目标：${t.desc || "—"}｜交付物：${t.deliverable || "—"}｜完成信号：${t.doneSignal || "—"}｜依赖：${t.deps.length ? t.deps.join(", ") : "无"}`
										);
									})
									.join("\n")
							);
						})
						.join("\n\n");
				return { content: [{ type: "text", text }], details: { kind: "workflow-list", state: lightState(state) } };
			}

			if (params.action === "add") {
				if (!params.title) return err("wf_workflow add 需要 title（任务标题）");
				if (!params.stageId) return err("wf_workflow add 需要 stageId（指定/新建阶段）");
				let stage = wf.stages.find((x) => x.id === params.stageId);
				if (!stage) {
					stage = { id: params.stageId, name: params.stageName ?? params.stageId, goal: params.stageGoal ?? "", tasks: [] };
					wf.stages.push(stage);
				}
				const id = params.taskId ?? genTaskId(wf, stage);
				const taken = new Set(wf.stages.flatMap((x) => x.tasks.map((t) => t.id)));
				if (taken.has(id)) return err(`任务 id ${id} 已存在，请换一个（可用: ${[...taken].join(", ")}）`);
				const deps = params.deps ?? [];
				if (deps.includes(id)) return err("任务不能依赖自己");
				if (hasDependencyCycle(id, deps, derived)) return err(`依赖环：${id} 的依赖链最终会回到自身，请检查 deps`);
				const task = {
					id,
					title: params.title,
					desc: params.desc ?? "",
					humanTasks: params.humanTasks ?? [],
					aiTasks: params.aiTasks ?? [],
					deliverable: params.deliverable ?? "",
					doneSignal: params.doneSignal ?? "",
					deps,
				};
				stage.tasks.push(task);
				state.tasks[id] = { status: "todo" };
				if (!state.currentTaskId) state.currentTaskId = id; // 从空工作流起步：首任务即当前任务
				s.commitWorkflow();
				reconcile(state, wf, s.getDerived());
				s.commitState();
				updateWidget(ctx, s);
				return {
					content: [
						{
							type: "text",
							text:
								`✅ 已添加任务 ${id} ${task.title}（阶段：${stage.name}）\n` +
								taskDetail(task, stage.name) +
								(state.currentTaskId === id ? "\n（这是工作流中第一个任务，已设为当前任务）" : ""),
						},
					],
					details: { kind: "workflow-add", state: lightState(state) },
				};
			}

			if (params.action === "edit") {
				if (!params.taskId) return err("wf_workflow edit 需要 taskId");
				const found = findTask(wf, params.taskId);
				if (!found) return err(`任务 ${params.taskId} 不存在。可用: ${derived.all.map((t) => t.id).join(", ")}`);
				const t = found.task;
				if (params.title !== undefined) t.title = params.title;
				if (params.desc !== undefined) t.desc = params.desc;
				if (params.humanTasks !== undefined) t.humanTasks = params.humanTasks;
				if (params.aiTasks !== undefined) t.aiTasks = params.aiTasks;
				if (params.deliverable !== undefined) t.deliverable = params.deliverable;
				if (params.doneSignal !== undefined) t.doneSignal = params.doneSignal;
				if (params.stageName !== undefined) found.stage.name = params.stageName; // 顺带支持改阶段名
				if (params.stageGoal !== undefined) found.stage.goal = params.stageGoal;
				if (params.deps !== undefined) {
					if (params.deps.includes(t.id)) return err("任务不能依赖自己");
					if (hasDependencyCycle(t.id, params.deps, derived)) return err(`依赖环：${t.id} 的依赖链最终会回到自身，请检查 deps`);
					t.deps = params.deps;
				}
				s.commitWorkflow();
				updateWidget(ctx, s);
				return {
					content: [{ type: "text", text: `已更新任务 ${t.id} ${t.title}` }],
					details: { kind: "workflow-edit", state: lightState(state) },
				};
			}

			if (params.action === "remove") {
				if (!params.taskId) return err("wf_workflow remove 需要 taskId");
				const found = findTask(wf, params.taskId);
				if (!found) return err(`任务 ${params.taskId} 不存在`);
				const { stage, task } = found;
				stage.tasks = stage.tasks.filter((t) => t.id !== task.id);
				delete state.tasks[task.id];
				// 依赖告警：谁还在依赖被删的任务
				const dependents = derived.all.filter((x) => x.deps.includes(task.id));
				// 当前任务被删 → 重算
				if (state.currentTaskId === task.id) {
					reconcile(state, wf, derived);
				}
				// 阶段空 → 自动移除
				if (stage.tasks.length === 0) wf.stages = wf.stages.filter((x) => x.id !== stage.id);
				s.commitWorkflow();
				s.commitState();
				updateWidget(ctx, s);
				let text = `已删除任务 ${task.id} ${task.title}${stage.tasks.length === 0 ? `（阶段 ${stage.name} 已清空并移除）` : ""}`;
				if (dependents.length) {
					text += `\n\n⚠️ 以下任务还依赖它（deps 含 ${task.id}），如需请用 edit 清理：${dependents.map((t) => `${t.id} ${t.title}`).join("、")}`;
				}
				return { content: [{ type: "text", text }], details: { kind: "workflow-remove", state: lightState(state) } };
			}

			// reset
			s.resetAll();
			updateWidget(ctx, s);
			return {
				content: [
					{
						type: "text",
						text:
							"已清空工作流（无阶段无任务）。\n用 wf_workflow add 从零创建（stageId 不存在会自动创建阶段）；从未创建过时常驻面板隐藏。",
					},
				],
				details: { kind: "workflow-reset", state: lightState(s.getState()) },
			};
		},
	});

	/* ---------- 工具：wf_status ---------- */
	pi.registerTool({
		name: "wf_status",
		label: "工作流状态",
		description:
			"工作流管理：获取当前阶段、当前任务（含人机分工、交付物、完成信号）、下一步、阻塞项、里程碑。" +
			"会话开始时、每次用户汇报进展后、以及推进任务前都应调用。",
		promptSnippet: "get workflow status and next action",
		parameters: statusParams,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			const derived = s.getDerived();
			return { content: [{ type: "text", text: renderBrief(state, derived) }], details: { kind: "status", state: lightState(state) } };
		},
	});

	/* ---------- 工具：wf_start ---------- */
	pi.registerTool({
		name: "wf_start",
		label: "开始任务",
		description: "标记某个任务为进行中（doing）。不填 taskId 时自动开始下一个满足依赖的待办任务；对 blocked 任务调用即解除阻塞。",
		promptSnippet: "mark a workflow task as started",
		parameters: startParams,
		async execute(_id, params: StartParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			const derived = s.getDerived();
			let target: TaskDef | null = null;
			if (params.taskId) {
				const t = derived.taskMap.get(params.taskId);
				if (!t) return err(`任务 ${params.taskId} 不存在。可用: ${derived.all.map((x) => x.id).join(", ")}`);
				if (state.tasks[t.id]?.status === "done") return err(`任务 ${t.id} 已完成，无需开始`);
				const depBlocked = t.deps.filter((d) => state.tasks[d]?.status !== "done");
				if (depBlocked.length) return err(`依赖未满足：${depBlocked.join(", ")} 需先完成`);
				target = t;
			} else {
				target = nextPendingTask(state, derived);
				if (!target) return err("没有可开始的待办任务");
			}
			state.tasks[target.id] = { status: "doing", startedAt: new Date().toISOString() };
			state.currentTaskId = target.id;
			logEvent(state, "task_start", target.title, target.id);
			commitAndRefresh(ctx);
			const stage = derived.stageOf.get(target.id)!;
			return {
				content: [
					{
						type: "text",
						text: `已开始任务 ${target.id} ${target.title}（${stage.name}）\n` + taskDetail(target, stage.name),
					},
				],
				details: { kind: "started", state: lightState(state) },
			};
		},
	});

	/* ---------- 工具：wf_done ---------- */
	pi.registerTool({
		name: "wf_done",
		label: "完成任务",
		description:
			"标记任务完成并自动推进到下一个待办任务。调用前先按该任务的「完成信号」验证（检查交付物、运行验证命令等）。完成时自动给出下一步指令。",
		promptSnippet: "mark a workflow task done and advance",
		parameters: doneParams,
		async execute(_id, params: DoneParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			const derived = s.getDerived();
			const taskId = params.taskId ?? state.currentTaskId;
			if (!taskId || !derived.taskMap.has(taskId)) return err("没有当前任务，请用 wf_start 开始（或用 wf_workflow add 先建任务）");
			const t = derived.taskMap.get(taskId)!;
			state.tasks[taskId] = { status: "done", doneAt: new Date().toISOString(), note: params.note };
			logEvent(state, "task_done", t.title, taskId);
			const next = nextPendingTask(state, derived);
			state.currentTaskId = next?.id ?? null;
			commitAndRefresh(ctx);

			let text = `✅ 任务 ${taskId} ${t.title} 已完成（${summaryLine(state, derived)}）`;
			if (next) {
				const stage = derived.stageOf.get(next.id)!;
				text +=
					`\n\n【下一步：${next.id} ${next.title}（${stage.name}）】\n` +
					`- 目标：${next.desc || "—"}\n` +
					taskDetail(next, stage.name);
			} else {
				text += "\n🎉 全部任务完成！进入收尾。";
			}
			return { content: [{ type: "text", text }], details: { kind: "done", state: lightState(state) } };
		},
	});

	/* ---------- 工具：wf_block ---------- */
	pi.registerTool({
		name: "wf_block",
		label: "标记阻塞",
		description: "把任务标记为阻塞并记录原因（如等待导师意见、等待数据）。解除时用 wf_start 重新开始。",
		promptSnippet: "mark a workflow task blocked",
		parameters: blockParams,
		async execute(_id, params: BlockParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			const derived = s.getDerived();
			const taskId = params.taskId ?? state.currentTaskId;
			if (!taskId || !derived.taskMap.has(taskId)) return err("没有当前任务");
			state.tasks[taskId] = { ...state.tasks[taskId], status: "blocked", blockReason: params.reason };
			logEvent(state, "task_blocked", `${taskId}: ${params.reason}`, taskId);
			commitAndRefresh(ctx);
			return {
				content: [
					{
						type: "text",
						text: `任务 ${taskId} 已标记阻塞：${params.reason}\n解除后调用 wf_start ${taskId} 继续。`,
					},
				],
				details: { kind: "blocked", state: lightState(state) },
			};
		},
	});

	/* ---------- 工具：wf_rollback ---------- */
	pi.registerTool({
		name: "wf_rollback",
		label: "回退任务",
		description:
			"把任务状态回退到 todo 或 doing（如发现误标完成、需要重做）。" +
			"回退后若该任务被其他已完成任务依赖，会输出依赖警告清单（不自动回退下游，由你判断）。",
		promptSnippet: "rollback a workflow task to todo or doing",
		parameters: rollbackParams,
		async execute(_id, params: RollbackParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			const derived = s.getDerived();
			const t = derived.taskMap.get(params.taskId);
			if (!t) return err(`任务 ${params.taskId} 不存在`);
			const cur = state.tasks[params.taskId] ?? { status: "todo" as const };
			if (params.to === "doing") {
				state.tasks[params.taskId] = {
					...cur,
					status: "doing",
					startedAt: cur.startedAt ?? new Date().toISOString(),
					doneAt: undefined,
					blockReason: undefined,
				};
				state.currentTaskId = params.taskId;
			} else {
				state.tasks[params.taskId] = {
					...cur,
					status: "todo",
					startedAt: undefined,
					doneAt: undefined,
					blockReason: undefined,
				};
				if (state.currentTaskId === params.taskId) {
					state.currentTaskId = nextPendingTask(state, derived)?.id ?? null;
				}
			}
			logEvent(state, "task_rollback", `${params.taskId} → ${params.to}`, params.taskId);
			commitAndRefresh(ctx);
			const dependents = derived.all.filter((x) => x.deps.includes(params.taskId) && state.tasks[x.id]?.status === "done");
			let text = `任务 ${params.taskId} ${t.title} 已回退为「${params.to === "doing" ? "进行中" : "待开始"}」`;
			if (dependents.length) {
				text += `\n\n⚠️ 依赖警告：以下已完成任务依赖它，需你判断是否也要回退（不会自动回退）：\n${dependents.map((x) => `  ${x.id} ${x.title}`).join("\n")}`;
			}
			return { content: [{ type: "text", text }], details: { kind: "rollback", state: lightState(state) } };
		},
	});

	/* ---------- 工具：wf_decision ---------- */
	pi.registerTool({
		name: "wf_decision",
		label: "记录决策",
		description: "记录用户的决策（主题、选项、选择、理由）。用户拍板的关键决策（方法选择、方案取舍等）都应记录，供后续追溯。",
		promptSnippet: "record a user decision in the workflow",
		parameters: decisionParams,
		async execute(_id, params: DecisionParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			state.decisions.push({
				ts: new Date().toISOString(),
				topic: params.topic,
				options: params.options,
				choice: params.choice,
				reason: params.reason,
			});
			logEvent(state, "decision", params.topic);
			commitAndRefresh(ctx);
			const text = `已记录决策：${params.topic}\n- 选项：${params.options.join(" / ")}\n- 选择：${params.choice ?? "待拍板"}${params.reason ? `\n- 理由：${params.reason}` : ""}`;
			return { content: [{ type: "text", text }], details: { kind: "decision", state: lightState(state) } };
		},
	});

	/* ---------- 工具：wf_milestone ---------- */
	pi.registerTool({
		name: "wf_milestone",
		label: "里程碑设置",
		description: "设置或更新里程碑（名称/日期/完成态）。名称不存在则自动创建，如 开题、中期、答辩。",
		promptSnippet: "set a workflow milestone date or status",
		parameters: milestoneParams,
		async execute(_id, params: MilestoneParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			if (!(params.name in state.milestones)) state.milestones[params.name] = { done: false };
			if (params.date) state.milestones[params.name].date = params.date;
			if (params.done !== undefined) state.milestones[params.name].done = params.done;
			logEvent(state, "milestone", `${params.name} ${params.date ?? ""} done=${params.done ?? false}`);
			commitAndRefresh(ctx);
			return {
				content: [
					{
						type: "text",
						// 用存储后的实际值回显（本次未传 date 时也应显示已存日期）
						text: `里程碑 ${params.name} 已更新：${state.milestones[params.name].date ?? "日期未定"}${state.milestones[params.name].done ? "（已完成）" : ""}`,
					},
				],
				details: { kind: "milestone", state: lightState(state) },
			};
		},
	});

	/* ---------- 命令：/workflow-config ---------- */
	const workflowConfigHandler = async (args: string, ctx: ExtensionContext) => {
		const s = getStore(ctx);
		const state = s.getState();
		const derived = s.getDerived();
		const [action, ...rest] = args.trim().split(/\s+/);

			/** 统一功能浮窗（overlay） */
			const openMenu = async () => {
				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						const comp = new WfmgMenuPanelComponent(s, ctx, theme, () => done());
						comp.setTui(tui);
						return comp;
					},
					{
						overlay: true,
						overlayOptions: { width: "60%", maxHeight: "60%" },
					},
				);
			};

			if (action === "toggle") {
				const cfg = s.getPanelConfig();
				cfg.showPanel = !cfg.showPanel;
				s.commitPanelConfig();
				updateWidget(ctx, s);
				ctx.ui.notify(`常驻面板已${cfg.showPanel ? "开启" : "关闭"}（/workflow-config 可再切换）`, "info");
				return;
			}
			if (action === "done") {
				const taskId = rest[0] ?? state.currentTaskId;
				if (taskId && derived.taskMap.has(taskId)) {
					state.tasks[taskId] = { status: "done", doneAt: new Date().toISOString() };
					logEvent(state, "task_done", derived.taskMap.get(taskId)!.title, taskId);
					const next = nextPendingTask(state, derived);
					state.currentTaskId = next?.id ?? null;
					commitAndRefresh(ctx);
					ctx.ui.notify(`已完成 ${taskId}。下一步：${next ? next.id + " " + next.title : "全部完成"}`, "info");
					return;
				}
				ctx.ui.notify(`任务 ${taskId ?? "(无)"} 不存在`, "error");
				return;
			}
			if (action === "start") {
				const taskId = rest[0] ?? nextPendingTask(state, derived)?.id;
				if (taskId && derived.taskMap.has(taskId)) {
					state.tasks[taskId] = { ...state.tasks[taskId], status: "doing", startedAt: new Date().toISOString() };
					state.currentTaskId = taskId;
					logEvent(state, "task_start", derived.taskMap.get(taskId)!.title, taskId);
					commitAndRefresh(ctx);
					ctx.ui.notify(`已开始 ${taskId} ${derived.taskMap.get(taskId)!.title}`, "info");
					return;
				}
				ctx.ui.notify(`任务 ${taskId ?? "(无)"} 不存在`, "error");
				return;
			}
			if (action === "block") {
				const reason = rest.join(" ") || "未说明原因";
				const taskId = state.currentTaskId;
				if (taskId && derived.taskMap.has(taskId)) {
					state.tasks[taskId] = { ...state.tasks[taskId], status: "blocked", blockReason: reason };
					logEvent(state, "task_blocked", `${taskId}: ${reason}`, taskId);
					commitAndRefresh(ctx);
					ctx.ui.notify(`已阻塞 ${taskId}：${reason}`, "warning");
					return;
				}
				ctx.ui.notify("没有当前任务可阻塞", "error");
				return;
			}

			// 默认：TUI 弹统一功能浮窗（menu）；非 TUI 输出文本面板
			if (ctx.mode === "tui") {
				await openMenu();
				return;
			}
			console.log(textPanel(state, derived).join("\n"));
	};

	// 主命令 /workflow-config（同一 handler 分发子命令）
	const wfmgDesc =
		"人机协作任务面板：/workflow-config 打开轻量功能浮窗（显示详细信息/常驻面板开关，↑↓ 选择 Enter 执行 Esc 关闭）；快捷子命令：toggle、done [id]、start [id]、block <原因>";
	pi.registerCommand("workflow-config", { description: wfmgDesc, handler: workflowConfigHandler });

	/* ---------- 事件：session_start 初始化常驻 UI ---------- */
	let lastCtx: ExtensionContext | null = null;
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		const s = getStore(ctx);
		s.reload();
		updateWidget(ctx, s);
		const state = s.getState();
		const derived = s.getDerived();
		ctx.ui.notify(summaryLine(state, derived), "info");
	});

	// hud 开启/关闭时重算展示方式：hud 接管底部行（面板隐藏） vs workflow 自绘常驻面板。
	// hud 是事件源（footer dispose 时 emit("hud:state-change")），本扩展持最新 ctx 响应，不依赖加载顺序。
	// reload 陷阱：/reload 先 dispose 旧 UI（hud dispose → emit 本事件）再发 session_shutdown，
	// 此时旧 ctx 已被 pi 标记 stale，getStore(lastCtx) 访问 ctx.cwd 触发 assertActive 抛错——
	// process 事件回调里的异常无人捕获会成为 uncaughtException 直接杀掉 pi。这里 try/catch
	// 静默跳过：旧实例即将卸载，刷新交给新实例的 session_start 完成。
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

	/* ---------- 事件：before_agent_start 注入指挥者角色（不进对话、不占 LLM 上下文） ---------- */
	pi.on("before_agent_start", async (event, ctx) => {
		const s = getStore(ctx);
		updateWidget(ctx, s);
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n【工作流】你是工作流指挥者，用户是执行者：" +
				"用 wf_status 获取当前任务与分工；用 wf_workflow 规划/调整任务（阶段→任务，含人机分工、交付物、完成信号、依赖）；" +
				"向用户下达具体指令（📋 任务/🎯 目标/📌 做法/✅ 回报/🔍 验证）；" +
				"用户完成后先按完成信号验证再调 wf_done 推进；用户拍板的决策用 wf_decision 记录；卡住时用 wf_block。" +
				"界面底部的 📋 面板是当前状态，随时可参考。",
		};
	});
}
