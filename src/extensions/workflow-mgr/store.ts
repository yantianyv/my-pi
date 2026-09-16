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
 * 多工作流槽位（并发隔离）：一个项目可同时存在多个命名工作流——
 * default 槽 = .pi/workflow/ 根目录三 JSON（向后兼容旧布局），命名槽 =
 * .pi/workflow/slots/<名称>/ 下同样三 JSON（archive 亦按槽分目录）。
 * 每个会话经 .pi/workflow/bindings.json 绑定一个槽（sessionId → 槽名 /
 * null=明确不用工作流 / 无记录=未选择）；未选择时由 events 层按
 * 「槽位 ≥2 或有其他活跃会话已绑定」决定自动绑定还是注入选择指引。
 * 旧路径：.pi/workflow/{workflow,state,config}.json（项目级、跨会话、可 git 审查）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
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

/* ------------------------------ 多工作流槽位与会话绑定 ------------------------------ */

/** 默认槽位名：对应 .pi/workflow/ 根目录（向后兼容既有数据布局） */
export const DEFAULT_SLOT = "default";
/** 保留槽位名（与目录/命令字冲突） */
const RESERVED_SLOTS = new Set([DEFAULT_SLOT, "none", "archive", "slots"]);
/** 绑定记录保鲜期：超过视为失效（防重启堆积的陈旧绑定复活） */
const BINDING_TTL_MS = 7 * 24 * 3600_000;

/** 槽位名合法性：字母/数字/中文开头，可含 _ -，≤32 字符，非保留字 */
export function isValidSlotName(name: string): boolean {
	return /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u.test(name) && !RESERVED_SLOTS.has(name);
}

/** 槽位目录：default → .pi/workflow/；命名槽 → .pi/workflow/slots/<名称>/（archive 随之分槽） */
function slotDir(cwd: string, slot: string): string {
	return slot === DEFAULT_SLOT
		? join(cwd, CONFIG_DIR_NAME, "workflow")
		: join(cwd, CONFIG_DIR_NAME, "workflow", "slots", slot);
}

function workflowPath(cwd: string, slot: string): string {
	return join(slotDir(cwd, slot), "workflow.json");
}
function statePath(cwd: string, slot: string): string {
	return join(slotDir(cwd, slot), "state.json");
}
function panelConfigPath(cwd: string, slot: string): string {
	return join(slotDir(cwd, slot), "config.json");
}
function bindingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "workflow", "bindings.json");
}

/** bindings.json：sessionId → 绑定（slot=槽名 / null=本会话明确不用工作流；无记录=未选择） */
interface BindingsFile {
	schemaVersion: 1;
	sessions: Record<string, { slot: string | null; at: number }>;
}

function isBindingsFile(v: unknown): v is BindingsFile {
	const b = v as BindingsFile | null;
	return !!b && b.schemaVersion === 1 && !!b.sessions && typeof b.sessions === "object";
}

function readBindings(cwd: string): BindingsFile {
	return loadJsonConfig(bindingsPath(cwd), { schemaVersion: 1, sessions: {} }, isBindingsFile);
}

/** 读会话绑定：string=槽位 / null=明确不用工作流 / undefined=未选择（过期按未选择） */
export function getBinding(cwd: string, sid: string): string | null | undefined {
	const b = readBindings(cwd).sessions[sid];
	if (!b || Date.now() - b.at > BINDING_TTL_MS) return undefined;
	return b.slot;
}

/** 写会话绑定（顺带清理过期条目） */
export function setBinding(cwd: string, sid: string, slot: string | null): void {
	const f = readBindings(cwd);
	const now = Date.now();
	for (const [k, v] of Object.entries(f.sessions)) {
		if (now - v.at > BINDING_TTL_MS) delete f.sessions[k];
	}
	f.sessions[sid] = { slot, at: now };
	saveJsonConfig(bindingsPath(cwd), f);
}

/** 列出全部槽位：default（根目录有 workflow.json 才计入）+ slots/ 下各命名槽 */
export function listSlots(cwd: string): string[] {
	const slots: string[] = [];
	if (existsSync(workflowPath(cwd, DEFAULT_SLOT))) slots.push(DEFAULT_SLOT);
	try {
		const base = join(cwd, CONFIG_DIR_NAME, "workflow", "slots");
		for (const e of readdirSync(base, { withFileTypes: true })) {
			if (e.isDirectory() && isValidSlotName(e.name)) slots.push(e.name);
		}
	} catch {
		/* slots 目录不存在 */
	}
	return slots;
}

export interface SlotSummary {
	slot: string;
	total: number;
	done: number;
	current: string;
}

/** 各槽位进度摘要（绑定选择指引 / bind 无参列表用；损坏槽按 0/0 兜底） */
export function slotSummaries(cwd: string): SlotSummary[] {
	return listSlots(cwd).map((slot) => {
		let total = 0;
		let done = 0;
		let current = "";
		try {
			const wf = JSON.parse(readFileSync(workflowPath(cwd, slot), "utf8")) as {
				stages?: { tasks?: { id: string; title: string }[] }[];
			};
			const st = JSON.parse(readFileSync(statePath(cwd, slot), "utf8")) as {
				currentTaskId?: string | null;
				tasks?: Record<string, { status?: string }>;
			};
			const tasks = (wf.stages ?? []).flatMap((s) => s.tasks ?? []);
			total = tasks.length;
			done = tasks.filter((t) => st.tasks?.[t.id]?.status === "done").length;
			current = tasks.find((t) => t.id === st.currentTaskId)?.title ?? "";
		} catch {
			/* 文件缺失/损坏 → 0/0 空摘要 */
		}
		return { slot, total, done, current };
	});
}

/**
 * 是否有其他「活着的」会话已绑定工作流（session_start 自动绑定判定用）：
 * 优先借 pair-guard 注册表心跳判活（零耦合可选读，缺席/无记录时按绑定时间 24h 内视为活跃）；
 * 绑定为 null（不用工作流）的会话不占槽，不参与判定。
 */
export function hasOtherLiveBinding(cwd: string, selfSid: string): boolean {
	const now = Date.now();
	for (const [sid, b] of Object.entries(readBindings(cwd).sessions)) {
		if (sid === selfSid || b.slot === null || now - b.at > BINDING_TTL_MS) continue;
		let live = now - b.at < 24 * 3600_000;
		try {
			const rec = JSON.parse(readFileSync(join(cwd, CONFIG_DIR_NAME, "sessions", `${sid}.json`), "utf8")) as {
				lastBeat?: number;
			};
			if (typeof rec.lastBeat === "number") live = now - rec.lastBeat < 6 * 60_000;
		} catch {
			/* pair-guard 缺席/无该会话记录 → 按绑定时间兜底 */
		}
		if (live) return true;
	}
	return false;
}

/* ------------------------------ 空工作流与校验 ------------------------------ */

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
	return !!c && c.schemaVersion === PANEL_SCHEMA_VERSION && typeof c.showPanel === "boolean" &&
		(c.auditOnComplete === undefined || typeof c.auditOnComplete === "boolean");
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
 *
 * stale 防护：构造时把 cwd 固化为字符串，之后不再持有/访问 ctx——session 替换
 * （compaction / reload）后旧 ctx 被 pi 标记 stale，任何属性访问都会抛
 * assertActive 错误（此前 getStore 比较 sessionStore.cwd 时动态访问旧 ctx 即崩溃）。
 * 路径函数全部接收固化 cwd，store 方法在 stale 后仍可安全读写磁盘。
 */
export class WorkflowStore {
	/** 构造时固化的工作目录：后续所有文件操作基于此值，不访问可能 stale 的 ctx */
	readonly cwd: string;
	/** 本 store 对应的槽位（default = 根目录布局） */
	readonly slot: string;
	/**
	 * 绑定阻塞态（getStore 赋值）：undecided=会话未绑定（多槽/并发待选择）
	 * none=本会话明确不用工作流；非 null 时工具层应拒绝操作并引导 bind。
	 * 阻塞时 store 落在 default 槽（惰性、不主动写盘），仅作占位。
	 */
	blocked: "undecided" | "none" | null = null;
	private wf: WorkflowDef | null = null;
	private derived: Derived | null = null;
	private state: WorkflowState | null = null;
	private panelCfg: PanelConfig | null = null;

	constructor(ctx: ExtensionContext, slot: string = DEFAULT_SLOT) {
		// 构造时刻的 ctx 必然是新鲜的（getStore 只在事件/工具携带的新 ctx 下新建），固化后彻底解耦
		this.cwd = ctx.cwd;
		this.slot = slot;
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
		return existsSync(workflowPath(this.cwd, this.slot));
	}

	getWorkflow(): WorkflowDef {
		if (!this.wf) {
			// 无内置示例：文件缺失 → 空工作流（无阶段无任务），面板按 hasWorkflowFile 隐藏/显示空提示
			this.wf = loadJsonConfig(workflowPath(this.cwd, this.slot), cloneWorkflow(EMPTY_WORKFLOW), isWorkflowDef);
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
			this.state = loadJsonConfig(statePath(this.cwd, this.slot), freshState(wf), isWorkflowState);
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
			this.panelCfg = loadJsonConfig(panelConfigPath(this.cwd, this.slot), { schemaVersion: PANEL_SCHEMA_VERSION, showPanel: true }, isPanelConfig);
		}
		return this.panelCfg;
	}

	/** 工作流落盘 + 派生表失效（下次 getDerived 重建） */
	commitWorkflow(): void {
		if (this.wf) {
			saveJsonConfig(workflowPath(this.cwd, this.slot), this.wf);
			this.derived = null;
		}
	}

	commitState(): void {
		if (this.state) {
			this.state.updatedAt = new Date().toISOString();
			saveJsonConfig(statePath(this.cwd, this.slot), this.state);
		}
	}

	commitPanelConfig(): void {
		if (this.panelCfg) saveJsonConfig(panelConfigPath(this.cwd, this.slot), this.panelCfg);
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
		const base = join(dirname(workflowPath(this.cwd, this.slot)), "archive");
		const name = (this.wf?.stages[0]?.name ?? "工作流").replace(/[\\/:*?"<>|\s]+/g, "-");
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const dir = join(base, `${ts}-${name}`);
		mkdirSync(dir, { recursive: true });
		// rename 跨文件系统（如镜像目录与工作流目录不同盘符/分区）会抛 EXDEV，退化为复制+删除
		const moveFile = (src: string, dest: string) => {
			try {
				renameSync(src, dest);
			} catch {
				copyFileSync(src, dest);
				unlinkSync(src);
			}
		};
		for (const p of [workflowPath(this.cwd, this.slot), statePath(this.cwd, this.slot), panelConfigPath(this.cwd, this.slot)]) {
			if (existsSync(p)) moveFile(p, join(dir, basename(p)));
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
 *
 * stale 防护：WorkflowStore 构造时已固化 cwd（不持有 ctx），此处的 cwd 比较是纯字符串
 * 比较，session 替换后旧实例即使持有 stale ctx 引用也不触发访问，直接重建/复用。
 */
let sessionStore: WorkflowStore | null = null;
/** 本会话绑定缓存（rebind 后需 invalidateBindingCache 失效重建）；键含 cwd 防同 sid 跨目录串 */
let sessionBinding: { sid: string; cwd: string; value: string | null | undefined } | null = null;

/** 解析本会话绑定：string=槽位 / null=不用工作流 / undefined=未选择（会话内缓存） */
export function resolveBinding(ctx: ExtensionContext): string | null | undefined {
	// sessionManager 在真实 pi 中恒存在；可选链兜底测试 mock 与极端场景
	const sid = ctx.sessionManager?.getSessionId?.() ?? "unknown";
	if (!sessionBinding || sessionBinding.sid !== sid || sessionBinding.cwd !== ctx.cwd) {
		sessionBinding = { sid, cwd: ctx.cwd, value: getBinding(ctx.cwd, sid) };
	}
	return sessionBinding.value;
}

/** 绑定缓存失效（wf_workflow bind / session_start 自动绑定后调用） */
export function invalidateBindingCache(): void {
	sessionBinding = null;
}

export function getStore(ctx: ExtensionContext): WorkflowStore {
	const binding = resolveBinding(ctx);
	const slot = typeof binding === "string" ? binding : DEFAULT_SLOT;
	const blocked = binding === undefined ? ("undecided" as const) : binding === null ? ("none" as const) : null;
	if (!sessionStore || sessionStore.cwd !== ctx.cwd || sessionStore.slot !== slot || sessionStore.blocked !== blocked) {
		sessionStore = new WorkflowStore(ctx, slot);
		sessionStore.blocked = blocked;
	}
	return sessionStore;
}
