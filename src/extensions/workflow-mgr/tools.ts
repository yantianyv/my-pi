/**
 * workflow-mgr 工具注册层：9 个 wf_* 工具的 schema 定义与注册。
 *
 * 从 index.ts 拆出：index 只负责组装（tools/commands/events），本模块持有
 * 全部工具注册逻辑与辅助（err/taskDetail/commitAndRefresh），共享 store 经
 * store.ts 的 getStore 会话级缓存访问。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import {
	cloneWorkflow,
	depsSatisfied,
	findTask,
	genTaskId,
	getStore,
	hasDependencyCycle,
	logEvent,
	nextPendingTask,
	reconcile,
} from "./store";
import { lightState, renderBrief, summaryLine } from "./brief";
import { updateWidget } from "./panel";
import type { TaskDef, WorkflowDef, WorkflowMode } from "./types";
import { WORKFLOW_SCHEMA_VERSION } from "./types";

/* ============================== 工具参数 schema ============================== */

const statusParams = Type.Object({});
const switchParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "要切换到的任务 ID（不填则自动切到下一个满足依赖的待办任务）" })),
	complete: Type.Optional(Type.Boolean({ description: "是否完成当前任务（默认 true）；false = 搁置当前任务（回 todo）直接转移" })),
});
const blockParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "任务 ID，默认当前任务" })),
	reason: Type.String({ description: "阻塞原因" }),
});
const rollbackParams = Type.Object({
	taskId: Type.String({ description: "要回退的任务 ID" }),
	to: StringEnum(["todo", "doing"], { description: "回退到的状态（blocked 任务请用 wf_switch 解除）" }),
});
const noteParams = Type.Object({
	action: StringEnum(["list", "add", "edit", "remove"], {
		description: "操作类型：list 查看全部；add 追加（自动 id+时间戳）；edit 修改（按 id）；remove 删除（按 id）",
	}),
	id: Type.Optional(Type.String({ description: "记录 id（edit/remove 必填）" })),
	content: Type.Optional(Type.String({ description: "记录内容（add/edit 必填）" })),
});
const milestoneParams = Type.Object({
	name: Type.String({ description: "里程碑名（不存在则自动创建），如 开题/中期/答辩" }),
	date: Type.Optional(Type.String({ description: "日期，如 2026-03-15" })),
	done: Type.Optional(Type.Boolean({ description: "是否已完成" })),
	remove: Type.Optional(Type.Boolean({ description: "删除该里程碑（默认 false）" })),
	newName: Type.Optional(Type.String({ description: "改名（name 存在时更新名称，保留日期/完成态）" })),
});
const workflowParams = Type.Object({
	action: StringEnum(["list", "add", "edit", "remove", "archive", "reset", "import"], {
		description:
			"操作类型：list 查看全量；import 初始化一次性导入（见 wf_workflow 描述，建新工作流优先用它）；add 新增任务（stageId 不存在则自动创建阶段）；edit 修改任务字段；remove 删除任务；archive 归档整个工作流（收尾退出视野，数据留档）；reset 清空工作流",
	}),
	mode: Type.Optional(
		StringEnum(["human-ai", "agent"], {
			description: "工作流协作模式（add 时设置工作流级；缺省 human-ai 向后兼容）：human-ai = 人机协作（AI 指挥、人执行）；agent = 纯 agent 自动驾驶（无人类分工、渲染隐藏「你:」行、连续执行直到完成）",
		}),
	),
	stageId: Type.Optional(Type.String({ description: "阶段 ID；add 时不存在则自动创建新阶段" })),
	status: Type.Optional(
		Type.String({ description: "归档收尾状态描述（仅 archive 用）：如「全部完成」「放弃：改用其他方案」——归档 ≠ 完成，快照保留任务真实状态，此字符串随快照留档追溯" }),
	),
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
	path: Type.Optional(
		Type.String({ description: "草稿 json 文件路径（仅 import 用）：初始化一次性导入，结构见工具描述中的示例" }),
	),
});

type SwitchParams = Static<typeof switchParams>;
type BlockParams = Static<typeof blockParams>;
type RollbackParams = Static<typeof rollbackParams>;
type NoteParams = Static<typeof noteParams>;
type MilestoneParams = Static<typeof milestoneParams>;
type WorkflowParams = Static<typeof workflowParams>;

/** 任务详情文本（工具返回文案共用；agent 模式隐藏「用户负责」行——无人类分工） */
function taskDetail(
	t: { id: string; title: string; humanTasks: string[]; aiTasks: string[]; deliverable: string; doneSignal: string },
	stageName: string,
	mode: WorkflowMode = "human-ai",
): string {
	return (
		(mode === "agent" ? "" : `- 用户负责：${t.humanTasks.join("；") || "（暂无）"}\n`) +
		`- AI 负责：${t.aiTasks.join("；") || "（暂无）"}\n` +
		`- 交付物：${t.deliverable || "（未定义）"}\n` +
		`- 完成信号：${t.doneSignal || "（未定义）"}\n` +
		`- 阶段：${stageName}`
	);
}

const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: { kind: "error" as const } });

/** 依赖环检测（导入全图校验用）：从每个起点 DFS 沿 deps 走，回到起点即环，返回环链路 */
function findCycle(tasks: { id: string; deps: string[] }[]): string | null {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	for (const start of tasks) {
		const stack: { task: { id: string; deps: string[] }; path: string[] }[] = [{ task: start, path: [start.id] }];
		while (stack.length) {
			const cur = stack.pop()!;
			for (const d of cur.task.deps) {
				const next = byId.get(d);
				if (d === start.id) return [...cur.path, d].join(" → ");
				if (next) stack.push({ task: next, path: [...cur.path, d] });
			}
		}
	}
	return null;
}

/** 状态/工作流变更后：落盘 + 刷新常驻 UI（供工具与命令共用） */
export function commitAndRefresh(ctx: ExtensionContext): void {
	const s = getStore(ctx);
	s.commitState();
	updateWidget(ctx, s);
}

/* ============================== 工具注册 ============================== */

export function registerTools(pi: ExtensionAPI) {
	/* ---------- 工具：wf_workflow（工作流定义管理） ---------- */
	pi.registerTool({
		name: "wf_workflow",
		label: "工作流定义",
		description:
			"创建/修改工作流定义（阶段→任务，含人机分工、交付物、完成信号、依赖）。" +
			"**初始化优先用 import**：新建工作流时用 write 写一份草稿 json 文件（一次性导入整份计划，远比逐条 add 省 token；add 一般只用于已有工作流的增补调整）。" +
			"import 草稿结构：{\"mode\":\"human-ai\", \"stages\":[{\"id\":\"design\", \"name\":\"阶段名\", \"goal\":\"阶段目标\", \"tasks\":[{\"title\":\"任务标题\", \"desc\":\"目标\", \"humanTasks\":[], \"aiTasks\":[], \"deliverable\":\"\", \"doneSignal\":\"\", \"deps\":[\"0.1\"]}]}]}——id 缺省自动生成（\"<阶段序号>.<序号>\"，如 0.1/1.2），deps 可直接引用本批未来 id；当前工作流非空时拒绝导入（请先 archive/reset）。" +
			"list 查看全量（含各任务状态）；add 新增任务（stageId 不存在自动创建阶段，id 缺省自动生成）；" +
			"edit 修改任务任意字段（传空数组清空列表字段）；remove 删除任务（同步清理状态与空阶段）；" +
			"archive 归档当前工作流（收尾退出视野：可带 status 描述收尾状态——完成/放弃/其他，快照保留任务真实状态，数据移入 .pi/workflow/archive/ 留档，不提供找回功能，需要时手动查看）；" +
			"reset 清空工作流（无阶段无任务，不可逆）。",
		promptSnippet: "workflow: create/update the human-AI collaboration workflow definition",
		parameters: workflowParams,
		async execute(_id, params: WorkflowParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			const derived = s.getDerived();
			const wf = s.getWorkflow();

			if (params.action === "list") {
				const text =
					`【工作流定义】共 ${wf.stages.length} 个阶段、${derived.all.length} 个任务${derived.mode === "agent" ? "（纯 agent 模式：无人类分工，自动驾驶）" : ""}\n\n` +
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

			if (params.action === "import") {
				if (!params.path) return err("wf_workflow import 需要 path（指向草稿 json 文件）");
				if (wf.stages.length > 0 || Object.keys(state.tasks).length > 0) {
					return err(
						`当前工作流非空（${wf.stages.length} 个阶段、${derived.all.length} 个任务）——import 是「初始化一次性导入」，请先 archive/reset 清空；已有工作流的增补请用 add/edit`,
					);
				}
				let raw: string;
				try {
					raw = readFileSync(params.path, "utf8");
				} catch {
					return err(`读取草稿文件失败：${params.path}（路径不存在或无权限）`);
				}
				let draft: unknown;
				try {
					draft = JSON.parse(raw);
				} catch (e) {
					const msg = String((e as Error).message ?? e);
					let line = "?";
					const pm = /position (\d+)/.exec(msg); // node <22：Unexpected token ... at position N
					if (pm) line = String(raw.slice(0, Number(pm[1])).split("\n").length);
					else {
						const fm = /\.\.\."([\s\S]*?)" is not valid JSON/.exec(msg); // node 22+：上下文片段定位（含换行）
						const idx = fm ? raw.indexOf(fm[1]) : -1;
						if (idx >= 0) line = String(raw.slice(0, idx).split("\n").length);
					}
					return err(`草稿 JSON 解析失败（第 ${line} 行附近）：${msg}`);
				}
				// —— 结构校验（宽松校验 + 出错定位到阶段/任务）——
				const errors: string[] = [];
				if (!draft || typeof draft !== "object" || !Array.isArray((draft as { stages?: unknown }).stages)) {
					return err("草稿结构错误：顶层需要 { stages: [...] }（阶段数组）");
				}
				const draftObj = draft as { mode?: unknown; stages: unknown[] };
				const draftMode = draftObj.mode;
				if (draftMode !== undefined && draftMode !== "human-ai" && draftMode !== "agent") errors.push("mode 仅支持 human-ai / agent");
				const stages: {
					id: string;
					name: string;
					goal: string;
					tasks: { title: string; desc: string; humanTasks: string[]; aiTasks: string[]; deliverable: string; doneSignal: string; deps: string[] }[];
				}[] = [];
				for (let i = 0; i < draftObj.stages.length; i++) {
					const s = draftObj.stages[i] as { id?: unknown; name?: unknown; goal?: unknown; tasks?: unknown };
					const label = `第 ${i + 1} 个阶段`;
					if (!s || typeof s !== "object") {
						errors.push(`${label}不是对象`);
						continue;
					}
					if (typeof s.name !== "string" || !s.name.trim()) errors.push(`${label}缺 name（阶段名）`);
					if (!Array.isArray(s.tasks)) {
						errors.push(`${label}缺 tasks 数组`);
						continue;
					}
					const tasks: (typeof stages)[number]["tasks"][number][] = [];
					for (let j = 0; j < s.tasks.length; j++) {
						const t = s.tasks[j] as {
							title?: unknown;
							desc?: unknown;
							humanTasks?: unknown;
							aiTasks?: unknown;
							deliverable?: unknown;
							doneSignal?: unknown;
							deps?: unknown;
						};
						const tlabel = `${label}的第 ${j + 1} 个任务`;
						if (!t || typeof t !== "object") {
							errors.push(`${tlabel}不是对象`);
							continue;
						}
						if (typeof t.title !== "string" || !t.title.trim()) errors.push(`${tlabel}缺 title（任务标题）`);
						if (t.deps !== undefined && (!Array.isArray(t.deps) || t.deps.some((d) => typeof d !== "string"))) {
							errors.push(`${tlabel}的 deps 需为字符串数组`);
						}
						if (t.humanTasks !== undefined && !Array.isArray(t.humanTasks)) errors.push(`${tlabel}的 humanTasks 需为数组`);
						if (t.aiTasks !== undefined && !Array.isArray(t.aiTasks)) errors.push(`${tlabel}的 aiTasks 需为数组`);
						tasks.push({
							title: typeof t.title === "string" ? t.title : "",
							desc: typeof t.desc === "string" ? t.desc : "",
							humanTasks: Array.isArray(t.humanTasks) ? t.humanTasks : [],
							aiTasks: Array.isArray(t.aiTasks) ? t.aiTasks : [],
							deliverable: typeof t.deliverable === "string" ? t.deliverable : "",
							doneSignal: typeof t.doneSignal === "string" ? t.doneSignal : "",
							deps: Array.isArray(t.deps) ? t.deps : [],
						});
					}
					stages.push({
						id: typeof s.id === "string" && s.id.trim() ? s.id : String(i),
						name: typeof s.name === "string" && s.name.trim() ? s.name : `阶段${i + 1}`,
						goal: typeof s.goal === "string" ? s.goal : "",
						tasks,
					});
				}
				if (errors.length) {
					return err(
						`草稿校验失败：\n${errors
							.slice(0, 10)
							.map((e) => `- ${e}`)
							.join("\n")}${errors.length > 10 ? `\n…共 ${errors.length} 处` : ""}`,
					);
				}
				// —— 构建工作流（id 按 genTaskId 规则自动生成：<阶段序号>.<序号>，deps 引用未来 id 自然匹配）——
				const newWf: WorkflowDef = {
					schemaVersion: WORKFLOW_SCHEMA_VERSION,
					mode: draftMode === "agent" ? "agent" : "human-ai",
					stages: [],
				};
				for (const st of stages) {
					const stage = { id: st.id, name: st.name, goal: st.goal, tasks: [] as TaskDef[] };
					newWf.stages.push(stage);
					for (const t of st.tasks) {
						stage.tasks.push({ id: genTaskId(newWf, stage), ...t });
					}
				}
				// —— 全量校验：自依赖 / 依赖存在 / 依赖环（带链路）——
				const all = newWf.stages.flatMap((x) => x.tasks);
				const ids = new Set(all.map((t) => t.id));
				for (const t of all) {
					if (t.deps.includes(t.id)) errors.push(`任务 ${t.id} 不能依赖自己`);
					for (const d of t.deps) {
						if (!ids.has(d)) errors.push(`任务 ${t.id} 的依赖 ${d} 不存在（全部任务 id: ${[...ids].join(", ")}）`);
					}
				}
				const cycle = findCycle(all);
				if (cycle) errors.push(`依赖环：${cycle}`);
				if (errors.length) return err(`草稿校验失败：\n${errors.join("\n")}`);
				s.importAll(newWf);
				updateWidget(ctx, s);
				const cur = s.getState().currentTaskId;
				return {
					content: [
						{
							type: "text",
							text:
								`✅ 已导入工作流：${newWf.stages.length} 个阶段、${all.length} 个任务${newWf.mode === "agent" ? "（纯 agent 模式）" : ""}\n` +
							newWf.stages
								.map((st) => `- ${st.name}（${st.id}）：${st.tasks.map((t) => `${t.id} ${t.title}`).join("，")}`)
								.join("\n") +
							`\n当前任务：${cur ? all.find((t) => t.id === cur)?.title ?? cur : "（无）"}（工作流第一步）`,
						},
					],
					details: { kind: "workflow-import", state: lightState(s.getState()) },
				};
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
				if (params.mode) wf.mode = params.mode as WorkflowMode; // add 时设置工作流级协作模式（缺省 human-ai）
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
								taskDetail(task, stage.name, derived.mode) +
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

			// archive：工作流收尾——退出用户视野，数据留档（不提供找回功能，需时手动查 archive/）
			s.archiveAll(params.status ?? "");
			updateWidget(ctx, s);
			return {
				content: [
					{
						type: "text",
						text:
							"已归档工作流：退出面板视野，数据移入 .pi/workflow/archive/（按时间戳-名称分目录留档，可 git 审查）。\n" +
							`收尾状态：${params.status ? `「${params.status}」` : "（未描述）"}——快照保留任务真实状态（完成/放弃/暂停一目了然），不做强制完成标记。\n` +
							"不提供找回功能——真需要时手动查看该目录；当前工作流为空，用 wf_workflow add 开新任务。",
					},
				],
				details: { kind: "workflow-archive", state: lightState(s.getState()) },
			};

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

	/* ---------- 工具：wf_switch（推进核心：完成当前 + 开始下一个，或显式切换/搁置转移） ---------- */
	pi.registerTool({
		name: "wf_switch",
		label: "切换任务",
		description:
			"推进工作流：一次调用完成「完成当前任务 + 开始下一个」两步。" +
			"无参数 = 完成当前任务并自动切换到下一个满足依赖的待办任务；没有下一个则全部任务完成，进入收尾（可 wf_workflow archive 归档）；" +
			"工作流刚开始（无当前任务）时无参数 = 开始第一个满足依赖的任务。" +
			"taskId=X = 显式切换到 X（同时完成当前任务）；对 blocked 任务调用即解除阻塞并开始；" +
			"complete=false = 搁置当前任务（回 todo，不标记完成）直接切换到 taskId。" +
			"调用前先按当前任务的「完成信号」验证其确实完成（检查交付物、运行验证命令等）。",
		promptSnippet: "switch to the next workflow task (completing the current one)",
		parameters: switchParams,
		async execute(_id, params: SwitchParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			const derived = s.getDerived();
			const curId = state.currentTaskId;
			const cur = curId ? derived.taskMap.get(curId) : undefined;
			const curSt = curId ? state.tasks[curId] : undefined;
			const complete = params.complete !== false; // 缺省 true

			/** 完成/搁置当前任务（两种模式共用；blocked 任务也按「推进即画句号」处理） */
			const settleCur = () => {
				if (cur && curId && curSt) {
					if (complete) {
						if (curSt.status !== "done") {
							state.tasks[curId] = { status: "done", doneAt: new Date().toISOString() };
							logEvent(state, "task_done", cur.title, curId);
						}
					} else {
						// 搁置：回 todo，清状态字段（0.1 拍板：不新增 paused 状态）
						state.tasks[curId] = { ...curSt, status: "todo", startedAt: undefined, doneAt: undefined, blockReason: undefined };
						logEvent(state, "task_hold", cur.title, curId);
					}
				}
			};

			/** 开始目标任务并返回工具结果 */
			const startTarget = (target: TaskDef) => {
				state.tasks[target.id] = { status: "doing", startedAt: new Date().toISOString() };
				state.currentTaskId = target.id;
				logEvent(state, "task_start", target.title, target.id);
				commitAndRefresh(ctx);
				const stage = derived.stageOf.get(target.id)!;
				const prevMsg =
					cur && curSt && curId !== target.id
						? complete
							? `已完成任务 ${cur.id} ${cur.title}，`
							: `已搁置任务 ${cur.id} ${cur.title}（回 todo，未完成），`
						: "";
				return {
					content: [
						{
							type: "text" as const,
							text: `${prevMsg}开始任务 ${target.id} ${target.title}（${stage.name}）\n` + taskDetail(target, stage.name, derived.mode),
						},
					],
					details: { kind: "switch" as const, state: lightState(state) },
				};
			};

			// 模式一：显式 taskId 切换（先校验，再 settle 当前，最后开始目标）
			if (params.taskId) {
				const t = derived.taskMap.get(params.taskId);
				if (!t) return err(`任务 ${params.taskId} 不存在。可用: ${derived.all.map((x) => x.id).join(", ")}`);
				if (state.tasks[t.id]?.status === "done") return err(`任务 ${t.id} 已完成，无需切换`);
				if (t.id === curId) return err(`任务 ${t.id} 已是当前任务`);
				// 依赖检查：complete=true 时当前任务即将被完成，不视为未满足依赖
				const depBlocked = t.deps.filter((d) => state.tasks[d]?.status !== "done" && !(d === curId && complete));
				if (depBlocked.length) return err(`任务 ${t.id} 依赖未满足：${depBlocked.join(", ")} 需先完成`);
				settleCur();
				return startTarget(t);
			}

			// 模式二：无参自动推进（先 settle 当前，再找下一个满足依赖的 todo——排除当前任务自身）
			if (derived.all.length === 0) return err("工作流为空，没有可推进的任务——先用 wf_workflow add 规划");
			settleCur();
			let target: TaskDef | null = null;
			for (const t of derived.all) {
				if (t.id === curId) continue;
				const st = state.tasks[t.id];
				if (st && st.status === "todo" && depsSatisfied(t, state)) {
					target = t;
					break;
				}
			}
			if (!target) {
				state.currentTaskId = null;
				commitAndRefresh(ctx);
				const allDone = derived.all.every((t) => state.tasks[t.id]?.status === "done");
				return {
					content: [
						{
							type: "text",
							text: allDone
								? `🎉 全部任务完成！（${summaryLine(state, derived)}）进入收尾：可 wf_workflow archive 归档（自动标记全部完成，退出面板视野）。`
								: "没有满足依赖的待办任务——请检查依赖或先用 wf_workflow 调整。",
						},
					],
					details: { kind: "switch", state: lightState(state) },
				};
			}
			return startTarget(target);
		},
	});

	/* ---------- 工具：wf_block ---------- */
	pi.registerTool({
		name: "wf_block",
		label: "标记阻塞",
		description: "把任务标记为阻塞并记录原因（如等待导师意见、等待数据）。解除时用 wf_switch 重新开始。",
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

	/* ---------- 工具：wf_note（AI 记录） ---------- */
	pi.registerTool({
		name: "wf_note",
		label: "记录",
		description:
			"AI 的记录工具：在工作流中，用于记录后续步骤需要用到的信息。每进入新的步骤，应当主动使用list动作查看已有记录，并及时remove不再用得到的记录。\n" +
			"使用准则：用户明确拍板的选择、硬约束（如「不要用 X」）、需要后续遵守的重要结论 → 记；\n" +
			"对话琐碎细节、任务字段已覆盖的内容（分工/交付物/完成信号）→ 不记。\n" +
			"action：add 追加（自动 id+时间戳）/ list 查看全部 / edit 修改（按 id）/ remove 删除（按 id）。",
		promptSnippet: "记录当前步骤产生、后续步骤需要知晓的信息",
		parameters: noteParams,
		async execute(_id, params: NoteParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();

			if (params.action === "add") {
				if (!params.content) return err("wf_note add 需要 content（记录内容）");
				// 自动 id：n + 现有最大序号 + 1
				let max = 0;
				for (const n of state.notes) {
					const m = /^n(\d+)$/.exec(n.id);
					if (m) max = Math.max(max, Number(m[1]));
				}
				const id = `n${max + 1}`;
				state.notes.push({ id, ts: new Date().toISOString(), content: params.content });
				logEvent(state, "note_add", params.content, id);
				commitAndRefresh(ctx);
				return {
					content: [{ type: "text", text: `已记录（${id}）：${params.content}` }],
					details: { kind: "note", state: lightState(state) },
				};
			}

			if (params.action === "list") {
				if (!state.notes.length)
					return { content: [{ type: "text", text: "暂无记录" }], details: { kind: "note", state: lightState(state) } };
				const text =
					`【记录】共 ${state.notes.length} 条\n` +
					state.notes
						.map((n) => `  ${n.id} ${new Date(n.ts).toLocaleString()} ${n.content}`)
						.join("\n");
				return { content: [{ type: "text", text }], details: { kind: "note", state: lightState(state) } };
			}

			if (params.action === "edit") {
				if (!params.id) return err("wf_note edit 需要 id");
				if (params.content === undefined) return err("wf_note edit 需要 content");
				const n = state.notes.find((x) => x.id === params.id);
				if (!n) return err(`记录 ${params.id} 不存在`);
				n.content = params.content;
				logEvent(state, "note_edit", params.id);
				commitAndRefresh(ctx);
				return {
					content: [{ type: "text", text: `已修改 ${params.id}：${n.content}` }],
					details: { kind: "note", state: lightState(state) },
				};
			}

			// remove
			if (!params.id) return err("wf_note remove 需要 id");
			const idx = state.notes.findIndex((x) => x.id === params.id);
			if (idx < 0) return err(`记录 ${params.id} 不存在`);
			const [removed] = state.notes.splice(idx, 1);
			logEvent(state, "note_remove", params.id);
			commitAndRefresh(ctx);
			return {
				content: [{ type: "text", text: `已删除 ${removed.id}：${removed.content}` }],
				details: { kind: "note", state: lightState(state) },
			};
		},
	});

	/* ---------- 工具：wf_milestone ---------- */
	pi.registerTool({
		name: "wf_milestone",
		label: "里程碑设置",
		description:
			"设置/更新/删除里程碑（名称/日期/完成态）。名称不存在则自动创建，如 开题、中期、答辩。" +
			"remove=true 删除该里程碑；newName 给已存在的里程碑改名（保留日期/完成态）。",
		promptSnippet: "set a workflow milestone date or status",
		parameters: milestoneParams,
		async execute(_id, params: MilestoneParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			// 删除：remove=true 移除该里程碑（不存在时报错）
			if (params.remove) {
				if (!(params.name in state.milestones)) return err(`里程碑 ${params.name} 不存在`);
				delete state.milestones[params.name];
				logEvent(state, "milestone_remove", params.name);
				commitAndRefresh(ctx);
				return {
					content: [{ type: "text", text: `里程碑 ${params.name} 已删除` }],
					details: { kind: "milestone", state: lightState(state) },
				};
			}
			// 改名：newName 且 name 已存在（保留 date/done）
			if (params.newName) {
				if (!(params.name in state.milestones)) return err(`里程碑 ${params.name} 不存在，无法改名`);
				const m = state.milestones[params.name];
				delete state.milestones[params.name];
				state.milestones[params.newName] = { ...m };
				logEvent(state, "milestone_rename", `${params.name} → ${params.newName}`);
				commitAndRefresh(ctx);
				return {
					content: [{ type: "text", text: `里程碑 ${params.name} 已改名为 ${params.newName}` }],
					details: { kind: "milestone", state: lightState(state) },
				};
			}
			// 增/改：缺省行为（0.2 兼容）
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
}
