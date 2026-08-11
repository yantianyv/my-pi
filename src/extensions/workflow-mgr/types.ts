/**
 * workflow-mgr 类型定义（人机协作任务面板）
 *
 * 三个 JSON 文件的 schema：
 * - workflow.json：工作流定义（AI 用 wf_workflow 工具读写，人可手工编辑）
 * - state.json：进度状态（工具自动维护，可 git 审查）
 * - config.json：面板开关等 UI 配置（与进度语义分离）
 */

export const WORKFLOW_SCHEMA_VERSION = 1;
export const STATE_SCHEMA_VERSION = 1;
export const PANEL_SCHEMA_VERSION = 1;

/** 工作流协作模式：human-ai = 人机协作（AI 指挥、人执行）；agent = 纯 agent（AI 自动驾驶，无人类分工） */
export const WORKFLOW_MODES = ["human-ai", "agent"] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

/** 任务定义（工作流中的人机分工单元） */
export interface TaskDef {
	id: string;
	title: string;
	desc: string;
	humanTasks: string[];
	aiTasks: string[];
	deliverable: string;
	doneSignal: string;
	deps: string[];
}

/** 阶段定义（任务的容器） */
export interface StageDef {
	id: string;
	name: string;
	goal: string;
	tasks: TaskDef[];
}

/** 工作流定义（workflow.json） */
export interface WorkflowDef {
	schemaVersion: number;
	/** 协作模式（0.3 拍板：工作流级，缺省 human-ai 向后兼容；agent 模式无人类分工、渲染隐藏「你:」行） */
	mode?: WorkflowMode;
	stages: StageDef[];
}

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

/** 单个任务的进度状态 */
export interface TaskState {
	status: TaskStatus;
	startedAt?: string;
	doneAt?: string;
	blockReason?: string;
	note?: string;
}

/** AI 记录（wf_note）：工作流内的决策记录（当前步骤产生、后续步骤需要知晓的信息） */
export interface NoteRecord {
	id: string;
	ts: string;
	content: string;
}

/** 里程碑（名称 → 日期/完成态） */
export interface MilestoneState {
	date?: string;
	done?: boolean;
}

/** 进度状态（state.json） */
export interface WorkflowState {
	schemaVersion: number;
	updatedAt: string;
	currentTaskId: string | null;
	tasks: Record<string, TaskState>;
	milestones: Record<string, MilestoneState>;
	/** AI 记录（wf_note）；旧 decisions 数据已丢弃（1.7 拍板，不迁移） */
	notes: NoteRecord[];
	/** 归档时的收尾状态描述（wf_workflow archive status 参数写入；完成/放弃/其他——归档 ≠ 完成，快照保留任务真实状态） */
	archiveStatus?: string;
	log: { ts: string; event: string; taskId?: string; msg?: string }[];
}

/** 面板开关等 UI 配置（config.json） */
export interface PanelConfig {
	schemaVersion: number;
	showPanel: boolean;
}
