/**
 * workflow-mgr 工具注册层：5 个 wf_* 工具的 schema 定义与注册。
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
const workflowParams = Type.Object({
	action: StringEnum(["list", "add", "edit", "remove", "archive", "import"], {
		description:
			"操作类型：list 查看全量；import 初始化一次性导入（草稿结构见工具描述，建新工作流优先用它）；add 新增任务（stageId 不存在则自动创建阶段）；edit 修改任务字段（空数组清空列表字段）；remove 删除任务；archive 归档整个工作流（收尾退出视野，数据留档，无找回）",
	}),
	mode: Type.Optional(
		StringEnum(["human-ai", "agent"], {
			description:
				"工作流协作模式（add 时设置工作流级；缺省 human-ai）：human-ai = 人机协作（AI 指挥、人执行）；agent = 纯 agent 自动驾驶（无人类分工、渲染隐藏「你:」行、连续执行直到完成）",
		}),
	),
	stageId: Type.Optional(Type.String({ description: "阶段 ID；add 时不存在则自动创建新阶段" })),
	status: Type.Optional(
		Type.String({ description: "归档收尾状态描述（仅 archive 用）：如「全部完成」「放弃：改用其他方案」——随快照留档追溯（归档 ≠ 完成）" }),
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
	path: Type.Optional(Type.String({ description: "草稿 json 文件路径（仅 import 用）：初始化一次性导入，结构见工具描述中的示例" })),
});

type SwitchParams = Static<typeof switchParams>;
type BlockParams = Static<typeof blockParams>;
type RollbackParams = Static<typeof rollbackParams>;
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

/** 失败结果：带 isError，pi 侧模型与 UI 才识别为失败（与 shared/tool-result 同一口径） */
const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: { kind: "error" as const }, isError: true as const });

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
		annotations: { readOnlyHint: false },
		label: "维护工作流",
		description:
			"创建/修改工作流定义（阶段→任务，含人机分工、交付物、完成信号、依赖）；动作作用于本会话的工作流。" +
			"新建优先用 import：先 write 一份草稿 json 再一次性导入（比逐条 add 省 token）；add 只用于后续增补调整。" +
			"import 草稿结构：{\"mode\":\"human-ai\",\"stages\":[{\"id\":\"design\",\"name\":\"阶段名\",\"goal\":\"阶段目标\",\"tasks\":[{\"title\":\"任务标题\",\"desc\":\"目标\",\"humanTasks\":[],\"aiTasks\":[],\"deliverable\":\"\",\"doneSignal\":\"\",\"deps\":[\"0.1\"]}]}]}——id 缺省自动生成（0.1/1.2 式），deps 可引用本批未来 id；工作流非空时拒绝导入（先 archive 归档）。",
		promptSnippet: "工作流定义：wf_workflow(action, …) → 阶段→任务的增删改与一次性导入",
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
						`当前工作流非空（${wf.stages.length} 个阶段、${derived.all.length} 个任务）——import 是「初始化一次性导入」，请先 archive 归档；已有工作流的增补请用 add/edit`,
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
				const knownIds = new Set(derived.all.map((t) => t.id));
				const missingDeps = deps.filter((d) => !knownIds.has(d));
				if (missingDeps.length) return err(`依赖的任务不存在：${missingDeps.join(", ")}（现有任务 id: ${[...knownIds].join(", ")}）`);
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
					const knownIds = new Set(derived.all.map((x) => x.id));
					const missingDeps = params.deps.filter((d) => !knownIds.has(d));
					if (missingDeps.length) return err(`依赖的任务不存在：${missingDeps.join(", ")}（现有任务 id: ${[...knownIds].join(", ")}）`);
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
				// 依赖悬空清理：其他任务对被删任务的依赖引用一并移除（不清理会造成静默死锁——
				// depsSatisfied 对不存在的 id 恒为 false，那些任务将永远无法开始）
				const dependents = derived.all.filter((x) => x.deps.includes(task.id));
				for (const d of dependents) d.deps = d.deps.filter((x) => x !== task.id);
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
					text += `\n\n已同步清理 ${dependents.length} 个任务对它的依赖：${dependents.map((t) => `${t.id} ${t.title}`).join("、")}`;
				}
				return { content: [{ type: "text", text }], details: { kind: "workflow-remove", state: lightState(state) } };
			}

			// archive：工作流收尾——退出用户视野，数据留档（不提供找回功能，需时手动查归档目录）
			s.archiveAll(params.status ?? "");
			updateWidget(ctx, s);
			return {
				content: [
					{
						type: "text",
						text:
							"已归档工作流：退出面板视野，数据移入归档目录（按时间戳-名称分目录留档）。\n" +
							`收尾状态：${params.status ? `「${params.status}」` : "（未描述）"}——快照保留任务真实状态（完成/放弃/暂停一目了然），不做强制完成标记。\n` +
							"不提供找回功能——真需要时手动查看该目录；当前工作流为空，用 wf_workflow add 开新任务。",
					},
				],
				details: { kind: "workflow-archive", state: lightState(s.getState()) },
			};
		},
	});

	/* ---------- 工具：wf_status ---------- */
	pi.registerTool({
		name: "wf_status",
		annotations: { readOnlyHint: true },
		label: "查工作流状态",
		description:
			"工作流管理：获取当前阶段、当前任务（含人机分工、交付物、完成信号）、下一步、阻塞项。" +
			"会话开始时、每次用户汇报进展后、以及推进任务前都应调用。",
		promptSnippet: "工作流状态：wf_status() → 当前阶段/任务分工/下一步/阻塞项",
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
		annotations: { readOnlyHint: false },
		label: "切换任务",
		description:
			"推进工作流：一次调用 = 完成当前任务 + 开始下一个。" +
			"无参数：自动切到下一个满足依赖的待办（无当前任务则开始第一个；没有下一个则全部完成，可 wf_workflow archive 收尾）。" +
			"taskId=X：显式切换（同时完成当前）；对 blocked 任务即解除阻塞并开始；complete=false = 搁置当前任务（回 todo）直接切换。" +
			"调用前先按当前任务的「完成信号」验证其确实完成（检查交付物、运行验证命令等）。",
		promptSnippet: "推进工作流：wf_switch([taskId][, complete]) → 完成当前任务并开始下一个",
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
						// 搁置：回 todo，清状态字段（不新增 paused 状态）
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
								? `🎉 全部任务完成！（${summaryLine(state, derived)}）进入收尾：可 wf_workflow archive 归档留档，退出面板视野。`
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
		annotations: { readOnlyHint: false },
		label: "标记阻塞",
		description: "把任务标记为阻塞并记录原因（如等待导师意见、等待数据）。解除时用 wf_switch 重新开始。",
		promptSnippet: "标记阻塞：wf_block(reason[, taskId]) → 任务转 blocked 并记录原因",
		parameters: blockParams,
		async execute(_id, params: BlockParams, _signal, _onUpdate, ctx) {
			const s = getStore(ctx);
			const state = s.getState();
			const derived = s.getDerived();
			const taskId = params.taskId ?? state.currentTaskId;
			if (!taskId) return err("没有当前任务，请用 taskId 指定要标记阻塞的任务");
			if (!derived.taskMap.has(taskId)) return err(`任务 ${taskId} 不存在。可用: ${derived.all.map((t) => t.id).join(", ")}`);
			state.tasks[taskId] = { ...state.tasks[taskId], status: "blocked", blockReason: params.reason };
			logEvent(state, "task_blocked", `${taskId}: ${params.reason}`, taskId);
			commitAndRefresh(ctx);
			return {
				content: [
					{
						type: "text",
						text: `任务 ${taskId} 已标记阻塞：${params.reason}\n解除后调用 wf_switch（taskId=${taskId}）继续。`,
					},
				],
				details: { kind: "blocked", state: lightState(state) },
			};
		},
	});

	/* ---------- 工具：wf_rollback ---------- */
	pi.registerTool({
		name: "wf_rollback",
		annotations: { readOnlyHint: false },
		label: "回退任务",
		description:
			"把任务状态回退到 todo 或 doing（如发现误标完成、需要重做）。" +
			"回退后若该任务被其他已完成任务依赖，会输出依赖警告清单（不自动回退下游，由你判断）。",
		promptSnippet: "回退任务：wf_rollback(taskId, to) → 回到 todo/doing，并列出下游依赖警告",
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
}
