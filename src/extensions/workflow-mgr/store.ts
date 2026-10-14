/**
 * workflow-mgr 数据层：workflow.json / state.json 的加载保存与一致性
 *
 * 存储位置（全局、按会话隔离）：
 * - 工作流数据：`~/.pi/agent/workflow/<项目标识>/<会话ID>/{workflow.json,state.json}`
 * - 面板开关：`~/.pi/agent/workflow/config.json`（全局单份，与项目/会话无关）
 * - 归档：`~/.pi/agent/workflow/<项目标识>/archive/<时间戳>-<名称>/`
 * 项目标识 = 目录名（净化）+ 路径短哈希，避免同名目录互相串数据；
 * `PI_WORKFLOW_HOME` 可整体覆盖根目录（测试用）。
 *
 * 本模块负责：
 * - 两个 JSON 的路径定位、加载（schemaVersion 校验 + fallback）、保存（自动建目录）；
 * - 派生表（taskMap/stageOf/all）按工作流动态构建，工作流变更后失效重建；
 * - reconcile 一致性兜底：工作流被工具/人工增删任务后，清理 state 孤儿 key、
 *   补齐缺失任务、currentTaskId 失效时用「依赖满足的下一任务」补位；
 * - 依赖环检测（add/edit 时防呆，DFS 沿依赖能否回到自身）；
 * - WorkflowStore 类持有缓存（单会话内存态），会话/cwd 变化时重建。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/* ------------------------------ 存储路径 ------------------------------ */

/** 数据根目录（`PI_WORKFLOW_HOME` 覆盖，测试用） */
export function workflowHome(): string {
	return process.env.PI_WORKFLOW_HOME || join(homedir(), ".pi", "agent", "workflow");
}

/** 项目标识：目录名净化（保留中文/字母数字/_-.）+ 路径短哈希（同名目录不串） */
export function projectKey(cwd: string): string {
	const name = basename(cwd).replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "project";
	return `${name}-${createHash("sha1").update(cwd).digest("hex").slice(0, 8)}`;
}

/** 会话数据目录：`<根>/<项目标识>/<会话ID>/`（会话 ID 里的非法字符替换为 _） */
export function sessionDir(cwd: string, sid: string): string {
	return join(workflowHome(), projectKey(cwd), sid.replace(/[^\w.-]/g, "_"));
}

function workflowPath(cwd: string, sid: string): string {
	return join(sessionDir(cwd, sid), "workflow.json");
}
function statePath(cwd: string, sid: string): string {
	return join(sessionDir(cwd, sid), "state.json");
}
/** 面板开关配置：全局单份（用户偏好，不随项目/会话分家） */
export function panelConfigPath(): string {
	return join(workflowHome(), "config.json");
}
/** 归档目录：项目内聚合各会话的历史快照 */
function archiveDir(cwd: string): string {
	return join(workflowHome(), projectKey(cwd), "archive");
}

/* ------------------------------ 空工作流与校验 ------------------------------ */

/** 空工作流：无内置示例——数据缺失时为「无阶段无任务」，AI 用 wf_workflow 从零创建 */
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
	for (const t of Object.values(s.tasks)) {
		if (!t || typeof t !== "object" || !["todo", "doing", "done", "blocked"].includes(t.status as string)) return false;
	}
	if (s.currentTaskId !== null && typeof s.currentTaskId !== "string") return false;
	if (!Array.isArray(s.log)) return false;
	return true;
}

/** config.json 校验 */
export function isPanelConfig(v: unknown): v is PanelConfig {
	const c = v as PanelConfig | null;
	return !!c && c.schemaVersion === PANEL_SCHEMA_VERSION && typeof c.showPanel === "boolean";
}

/* ------------------------------ 状态构造与一致性 ------------------------------ */

/** 按工作流生成全新状态（所有任务 todo、无当前任务、日志为空） */
export function freshState(wf: WorkflowDef): WorkflowState {
	const tasks: Record<string, TaskState> = {};
	for (const stage of wf.stages) for (const t of stage.tasks) tasks[t.id] = { status: "todo" };
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		updatedAt: new Date().toISOString(),
		currentTaskId: null,
		tasks,
		log: [],
	};
}

/** 构建派生表（工作流变更后必须重建）；mode 缺省 human-ai */
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

/** 深拷贝（构造空工作流/导入时避免污染模块常量） */
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
 * 单会话缓存容器：两个 JSON + 派生表 + 面板配置。
 * 会话/cwd 变化时重建（重建即从磁盘重新加载——文件被外部修改后自动生效）。
 *
 * stale 防护：构造时把 cwd 与会话 ID 固化为字符串，之后不再持有/访问 ctx——session 替换
 * （compaction / reload）后旧 ctx 被 pi 标记 stale，任何属性访问都会抛
 * assertActive 错误。路径函数全部接收固化值，store 方法在 stale 后仍可安全读写磁盘。
 */
export class WorkflowStore {
	/** 构造时固化的工作目录：后续所有文件操作基于此值，不访问可能 stale 的 ctx */
	readonly cwd: string;
	/** 构造时固化的会话 ID（数据隔离键） */
	readonly sid: string;
	private wf: WorkflowDef | null = null;
	private derived: Derived | null = null;
	private state: WorkflowState | null = null;
	private panelCfg: PanelConfig | null = null;

	constructor(ctx: ExtensionContext) {
		// 构造时刻的 ctx 必然是新鲜的（getStore 只在事件/工具携带的新 ctx 下新建），固化后彻底解耦
		this.cwd = ctx.cwd;
		this.sid = ctx.sessionManager?.getSessionId?.() ?? "unknown";
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
		return existsSync(workflowPath(this.cwd, this.sid));
	}

	getWorkflow(): WorkflowDef {
		if (!this.wf) {
			// 无内置示例：文件缺失 → 空工作流（无阶段无任务），面板按 hasWorkflowFile 隐藏/显示空提示
			this.wf = loadJsonConfig(workflowPath(this.cwd, this.sid), cloneWorkflow(EMPTY_WORKFLOW), isWorkflowDef);
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
			this.state = loadJsonConfig(statePath(this.cwd, this.sid), freshState(wf), isWorkflowState);
			reconcile(this.state, wf, this.getDerived());
		}
		return this.state;
	}

	getPanelConfig(): PanelConfig {
		if (!this.panelCfg) {
			this.panelCfg = loadJsonConfig(panelConfigPath(), { schemaVersion: PANEL_SCHEMA_VERSION, showPanel: true }, isPanelConfig);
		}
		return this.panelCfg;
	}

	/** 工作流落盘 + 派生表失效（下次 getDerived 重建） */
	commitWorkflow(): void {
		if (this.wf) {
			saveJsonConfig(workflowPath(this.cwd, this.sid), this.wf);
			this.derived = null;
		}
	}

	commitState(): void {
		if (this.state) {
			this.state.updatedAt = new Date().toISOString();
			saveJsonConfig(statePath(this.cwd, this.sid), this.state);
		}
	}

	commitPanelConfig(): void {
		if (this.panelCfg) saveJsonConfig(panelConfigPath(), this.panelCfg);
	}

	/**
	 * 整体导入（wf_workflow import 用）：用草稿构建的工作流定义整体替换 + 状态重建。
	 * 初始化一次性导入：当前工作流非空时工具层拒绝（安全策略），此处直接替换。
	 */
	importAll(wf: WorkflowDef): void {
		this.wf = cloneWorkflow(wf);
		this.derived = null;
		this.state = freshState(this.wf);
		if (this.wf.stages.length > 0 && this.wf.stages[0].tasks.length > 0) {
			this.state.currentTaskId = this.wf.stages[0].tasks[0].id;
		}
		this.commitWorkflow();
		this.commitState();
	}

	/**
	 * 归档（wf_workflow archive 用）：把当前工作流两个 JSON 移动到
	 * `<项目>/archive/<时间戳>-<名称>/` 留档。
	 * 归档 ≠ 完成（可能是放弃/暂停/换方案）：不强制标 done，快照保留任务真实状态，
	 * 收尾状态经 status 字符串记录（archiveStatus 字段）供追溯；当前工作流区清空
	 * （hasWorkflowFile → false，面板自动隐藏退出视野）；数据保留可人工查看，
	 * 但不提供找回功能。
	 */
	archiveAll(status = ""): void {
		// 归档前：写入收尾状态描述（不强制改任务状态）
		if (this.state) {
			this.state.archiveStatus = status;
			this.state.currentTaskId = null;
			this.commitState();
		}
		const name = (this.wf?.stages[0]?.name ?? "工作流").replace(/[\\/:*?"<>|\s]+/g, "-");
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const dir = join(archiveDir(this.cwd), `${ts}-${name}`);
		mkdirSync(dir, { recursive: true });
		// rename 跨文件系统（如镜像目录与数据目录不同盘符/分区）会抛 EXDEV，退化为复制+删除
		const moveFile = (src: string, dest: string) => {
			try {
				renameSync(src, dest);
			} catch {
				copyFileSync(src, dest);
				unlinkSync(src);
			}
		};
		for (const p of [workflowPath(this.cwd, this.sid), statePath(this.cwd, this.sid)]) {
			if (existsSync(p)) moveFile(p, join(dir, basename(p)));
		}
		this.wf = null;
		this.derived = null;
		this.state = null;
	}
}

/* ------------------------------ 会话级 store 访问（跨模块共享） ------------------------------ */

/**
 * 单会话 store：会话内按 (cwd, 会话 ID) 缓存，任一变化即重建（重建即从磁盘重载）。
 * 由 tools/commands/events 各模块共享——index 只负责组装，不持有 store 生命周期。
 *
 * stale 防护：WorkflowStore 构造时已固化 cwd/sid（不持有 ctx），此处的比较是纯字符串
 * 比较，session 替换后旧实例即使持有 stale ctx 引用也不触发访问，直接重建/复用。
 */
let sessionStore: WorkflowStore | null = null;

export function getStore(ctx: ExtensionContext): WorkflowStore {
	const sid = ctx.sessionManager?.getSessionId?.() ?? "unknown";
	if (!sessionStore || sessionStore.cwd !== ctx.cwd || sessionStore.sid !== sid) {
		sessionStore = new WorkflowStore(ctx);
	}
	return sessionStore;
}
