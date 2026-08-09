/**
 * workflow-mgr 数据层：workflow.json / state.json / config.json 的加载保存与一致性
 *
 * 与垂直版 thesis-workflow 的最大差异：工作流定义从「模块常量」变为「运行时数据」，
 * 本模块负责：
 * - 三个 JSON 的路径定位、加载（schemaVersion 校验 + fallback）、保存（自动建目录）；
 * - 派生表（taskMap/stageOf/all）按工作流动态构建，工作流变更后失效重建；
 * - reconcile 一致性兜底：工作流被工具/人工增删任务后，清理 state 孤儿 key、
 *   补齐缺失任务、currentTaskId 失效时用「依赖满足的下一任务」补位；
 * - 依赖环检测（add/edit 时防呆，DFS 沿依赖能否回到自身）；
 * - WorkflowStore 类持有三份缓存（单会话内存态），session_start / cwd 变化时重建。
 *
 * 路径：.pi/workflow/{workflow,state,config}.json（项目级、跨会话、可 git 审查）。
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";
import {
	PANEL_SCHEMA_VERSION,
	STATE_SCHEMA_VERSION,
	WORKFLOW_MODES,
	WORKFLOW_SCHEMA_VERSION,
	type PanelConfig,
	type StageDef,
	type TaskDef,
	type TaskState,
	type WorkflowDef,
	type WorkflowMode,
	type WorkflowState,
} from "./types";

/** 派生表：由工作流构建的快速索引（工作流变更后需重建）；mode 为有效协作模式（缺省 human-ai） */
export interface Derived {
	taskMap: Map<string, TaskDef>;
	stageOf: Map<string, StageDef>;
	all: TaskDef[];
	mode: WorkflowMode;
}

/* ------------------------------ 路径与校验 ------------------------------ */

function workflowPath(ctx: ExtensionContext): string {
	return join(ctx.cwd, CONFIG_DIR_NAME, "workflow", "workflow.json");
}
function statePath(ctx: ExtensionContext): string {
	return join(ctx.cwd, CONFIG_DIR_NAME, "workflow", "state.json");
}
function panelConfigPath(ctx: ExtensionContext): string {
	return join(ctx.cwd, CONFIG_DIR_NAME, "workflow", "config.json");
}

/** 空工作流：无内置示例——数据缺失 / wf_workflow reset 后均为「无阶段无任务」，AI 用 wf_workflow 从零创建 */
const EMPTY_WORKFLOW: WorkflowDef = { schemaVersion: WORKFLOW_SCHEMA_VERSION, stages: [] };

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function isTaskDef(v: unknown): v is TaskDef {
	const t = v as TaskDef | null;
	return (
		!!t &&
		isStr(t.id) &&
		isStr(t.title) &&
		isStr(t.desc) &&
		isStrArray(t.humanTasks) &&
		isStrArray(t.aiTasks) &&
		isStr(t.deliverable) &&
		isStr(t.doneSignal) &&
		isStrArray(t.deps)
	);
}

/** workflow.json 校验：schemaVersion 匹配 + stages 结构完整（mode 可选，存在时必须为合法枚举） */
export function isWorkflowDef(v: unknown): v is WorkflowDef {
	const w = v as WorkflowDef | null;
	return (
		!!w &&
		w.schemaVersion === WORKFLOW_SCHEMA_VERSION &&
		(w.mode === undefined || (WORKFLOW_MODES as readonly string[]).includes(w.mode)) &&
		Array.isArray(w.stages) &&
		w.stages.every(
			(s) =>
				!!s &&
				isStr(s.id) &&
				isStr(s.name) &&
				isStr(s.goal) &&
				Array.isArray(s.tasks) &&
				s.tasks.every(isTaskDef),
		)
	);
}

/** state.json 校验：schemaVersion 匹配 + tasks 结构完整（宽松：缺字段按默认） */
export function isWorkflowState(v: unknown): v is WorkflowState {
	const s = v as WorkflowState | null;
	if (!s || s.schemaVersion !== STATE_SCHEMA_VERSION || !s.tasks || typeof s.tasks !== "object") return false;
	for (const [k, t] of Object.entries(s.tasks)) {
		if (!t || typeof t !== "object" || !["todo", "doing", "done", "blocked"].includes(t.status as string)) return false;
	}
	if (s.currentTaskId !== null && typeof s.currentTaskId !== "string") return false;
	if (!s.milestones || typeof s.milestones !== "object") return false;
	// notes 允许缺失（旧 v1 数据仅含 decisions）→ getState 加载后丢弃 decisions 并补空数组
	if (s.notes !== undefined && !Array.isArray(s.notes)) return false;
	if (!Array.isArray(s.log)) return false;
	return true;
}

/** config.json 校验 */
export function isPanelConfig(v: unknown): v is PanelConfig {
	const c = v as PanelConfig | null;
	return !!c && c.schemaVersion === PANEL_SCHEMA_VERSION && typeof c.showPanel === "boolean";
}

/* ------------------------------ 状态构造与一致性 ------------------------------ */

/** 按工作流生成全新状态（所有任务 todo、无当前任务、里程碑/决策/日志为空） */
export function freshState(wf: WorkflowDef): WorkflowState {
	const tasks: Record<string, TaskState> = {};
	for (const stage of wf.stages) for (const t of stage.tasks) tasks[t.id] = { status: "todo" };
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		updatedAt: new Date().toISOString(),
		currentTaskId: null,
		tasks,
		milestones: {},
		notes: [],
		log: [],
	};
}

/** 构建派生表（工作流变更后必须重建）；mode 缺省 human-ai（0.3 拍板：向后兼容） */
export function derive(wf: WorkflowDef): Derived {
	const taskMap = new Map<string, TaskDef>();
	const stageOf = new Map<string, StageDef>();
	for (const s of wf.stages) for (const t of s.tasks) {
		taskMap.set(t.id, t);
		stageOf.set(t.id, s);
	}
	return { taskMap, stageOf, all: [...taskMap.values()], mode: wf.mode ?? "human-ai" };
}

/** 依赖是否全部完成 */
export function depsSatisfied(t: TaskDef, state: WorkflowState): boolean {
	return t.deps.every((d) => state.tasks[d]?.status === "done");
}

/** 下一个「可开始」的任务：todo 且依赖满足（按工作流顺序） */
export function nextPendingTask(state: WorkflowState, derived: Derived): TaskDef | null {
	for (const t of derived.all) {
		const st = state.tasks[t.id];
		if (st && st.status === "todo" && depsSatisfied(t, state)) return t;
	}
	return null;
}

/**
 * 一致性兜底：工作流增删任务后清理/补齐 state，currentTaskId 失效时补位。
 * 在 getState 首次加载、以及 wf_workflow 增删任务后调用。
 */
export function reconcile(state: WorkflowState, wf: WorkflowDef, derived: Derived): void {
	// 1. 补齐工作流中缺失的任务状态
	for (const t of derived.all) {
		if (!state.tasks[t.id]) state.tasks[t.id] = { status: "todo" };
	}
	// 2. 清理孤儿状态（工作流中已不存在的任务）
	for (const id of Object.keys(state.tasks)) {
		if (!derived.taskMap.has(id)) delete state.tasks[id];
	}
	// 3. currentTaskId 失效（任务不存在/已 done）→ 用依赖满足的下一任务补位
	const cur = state.currentTaskId ? derived.taskMap.get(state.currentTaskId) : undefined;
	if (!cur || state.tasks[cur.id]?.status === "done") {
		state.currentTaskId = nextPendingTask(state, derived)?.id ?? null;
	}
}

/**
 * 依赖环检测：从 taskId 沿（新的）deps 深度搜索，能回到自身即成环。
 * 只检查本次变更的 deps——其余任务的依赖是既有状态，不在此校验。
 */
export function hasDependencyCycle(taskId: string, newDeps: string[], derived: Derived): boolean {
	const stack = [...newDeps];
	const visited = new Set<string>();
	while (stack.length) {
		const d = stack.pop()!;
		if (d === taskId) return true;
		if (visited.has(d)) continue;
		visited.add(d);
		const t = derived.taskMap.get(d);
		if (t) stack.push(...t.deps);
	}
	return false;
}

/** 深拷贝（reset 回默认工作流时避免污染模块常量） */
export function cloneWorkflow(wf: WorkflowDef): WorkflowDef {
	return JSON.parse(JSON.stringify(wf)) as WorkflowDef;
}

/** 在阶段内查找任务 */
export function findTask(wf: WorkflowDef, taskId: string): { stage: StageDef; task: TaskDef } | null {
	for (const s of wf.stages) {
		const t = s.tasks.find((x) => x.id === taskId);
		if (t) return { stage: s, task: t };
	}
	return null;
}

/** 自动生成任务 id：`${阶段index}.${序号}`，与现有 id 冲突时递增 */
export function genTaskId(wf: WorkflowDef, stage: StageDef): string {
	const idx = wf.stages.indexOf(stage);
	const taken = new Set(wf.stages.flatMap((s) => s.tasks.map((t) => t.id)));
	let n = stage.tasks.length + 1;
	let id = `${idx}.${n}`;
	while (taken.has(id)) {
		n++;
		id = `${idx}.${n}`;
	}
	return id;
}

/** 向状态日志追加一条记录（截断 500 条） */
export function logEvent(state: WorkflowState, event: string, msg?: string, taskId?: string) {
	state.log.push({ ts: new Date().toISOString(), event, taskId, msg });
	if (state.log.length > 500) state.log = state.log.slice(-500);
}

/* ------------------------------ WorkflowStore ------------------------------ */

/**
 * 单会话缓存容器：三个 JSON + 派生表。
 * session_start 或 cwd 变化时重建（重建即从磁盘重新加载——文件被外部修改后自动生效）。
 */
export class WorkflowStore {
	private ctx: ExtensionContext;
	private wf: WorkflowDef | null = null;
	private derived: Derived | null = null;
	private state: WorkflowState | null = null;
	private panelCfg: PanelConfig | null = null;

	constructor(ctx: ExtensionContext) {
		this.ctx = ctx;
	}

	/** 当前会话工作目录（getStore 据此检测会话切换，自动重建） */
	get cwd(): string {
		return this.ctx.cwd;
	}

	/** 清空全部缓存（下次访问重新从磁盘加载） */
	reload(): void {
		this.wf = null;
		this.derived = null;
		this.state = null;
		this.panelCfg = null;
	}

	/** 工作流定义文件是否已落盘（从未创建过工作流 → 常驻面板整体隐藏） */
	hasWorkflowFile(): boolean {
		return existsSync(workflowPath(this.ctx));
	}

	getWorkflow(): WorkflowDef {
		if (!this.wf) {
			// 无内置示例：文件缺失 → 空工作流（无阶段无任务），面板按 hasWorkflowFile 隐藏/显示空提示
			this.wf = loadJsonConfig(workflowPath(this.ctx), cloneWorkflow(EMPTY_WORKFLOW), isWorkflowDef);
		}
		return this.wf;
	}

	getDerived(): Derived {
		if (!this.derived) this.derived = derive(this.getWorkflow());
		return this.derived;
	}

	getState(): WorkflowState {
		if (!this.state) {
			const wf = this.getWorkflow();
			this.state = loadJsonConfig(statePath(this.ctx), freshState(wf), isWorkflowState);
			// 1.7 拍板：decisions → notes 替换，旧数据直接丢弃（插件未被大规模使用，不迁移）
			const old = (this.state as WorkflowState & { decisions?: unknown }).decisions;
			if (old !== undefined || !Array.isArray(this.state.notes)) {
				delete (this.state as { decisions?: unknown }).decisions;
				if (!Array.isArray(this.state.notes)) this.state.notes = [];
			}
			reconcile(this.state, wf, this.getDerived());
		}
		return this.state;
	}

	getPanelConfig(): PanelConfig {
		if (!this.panelCfg) {
			this.panelCfg = loadJsonConfig(panelConfigPath(this.ctx), { schemaVersion: PANEL_SCHEMA_VERSION, showPanel: true }, isPanelConfig);
		}
		return this.panelCfg;
	}

	/** 工作流落盘 + 派生表失效（下次 getDerived 重建） */
	commitWorkflow(): void {
		if (this.wf) {
			saveJsonConfig(workflowPath(this.ctx), this.wf);
			this.derived = null;
		}
	}

	commitState(): void {
		if (this.state) {
			this.state.updatedAt = new Date().toISOString();
			saveJsonConfig(statePath(this.ctx), this.state);
		}
	}

	commitPanelConfig(): void {
		if (this.panelCfg) saveJsonConfig(panelConfigPath(this.ctx), this.panelCfg);
	}

	/** 全量重置：清空工作流（无阶段无任务）+ 状态重建（wf_workflow reset 用） */
	resetAll(): void {
		this.wf = cloneWorkflow(EMPTY_WORKFLOW);
		this.derived = null;
		this.state = freshState(this.wf);
		this.commitWorkflow();
		this.commitState();
	}

	/**
	 * 归档（wf_workflow archive 用）：把当前工作流三 JSON 移动到 archive/<时间戳>-<名称>/ 留档。
	 * 归档 ≠ 完成（可能是放弃/暂停/换方案）：不再强制标 done，快照保留任务真实状态，
	 * 收尾状态经 status 字符串记录（archiveStatus 字段）供追溯；当前工作流区清空
	 * （hasWorkflowFile → false，面板自动隐藏退出视野）；数据保留可 git 审查，
	 * 但不提供找回功能——真需要时由人手动查看 archive/ 目录。
	 */
	archiveAll(status = ""): void {
		// 归档前：写入收尾状态描述（不强制改任务状态）
		if (this.state) {
			this.state.archiveStatus = status;
			this.state.currentTaskId = null;
			this.commitState();
		}
		const base = join(dirname(workflowPath(this.ctx)), "archive");
		const name = (this.wf?.stages[0]?.name ?? "工作流").replace(/[\\/:*?"<>|\s]+/g, "-");
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const dir = join(base, `${ts}-${name}`);
		mkdirSync(dir, { recursive: true });
		for (const p of [workflowPath(this.ctx), statePath(this.ctx), panelConfigPath(this.ctx)]) {
			if (existsSync(p)) renameSync(p, join(dir, basename(p)));
		}
		this.wf = null;
		this.derived = null;
		this.state = null;
		this.panelCfg = null;
	}
}

/* ------------------------------ 会话级 store 访问（跨模块共享） ------------------------------ */

/**
 * 单会话 store：会话内按 cwd 缓存，cwd 变化自动重建（重建即从磁盘重载）。
 * 由 tools/commands/events 各模块共享——index 只负责组装，不再持有 store 生命周期。
 */
let sessionStore: WorkflowStore | null = null;
export function getStore(ctx: ExtensionContext): WorkflowStore {
	if (!sessionStore || sessionStore.cwd !== ctx.cwd) sessionStore = new WorkflowStore(ctx);
	return sessionStore;
}
