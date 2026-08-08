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

/** 用户拍板的决策记录 */
export interface DecisionRecord {
	ts: string;
	topic: string;
	options: string[];
	choice?: string;
	reason?: string;
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
	decisions: DecisionRecord[];
	log: { ts: string; event: string; taskId?: string; msg?: string }[];
}

/** 面板开关等 UI 配置（config.json） */
export interface PanelConfig {
	schemaVersion: number;
	showPanel: boolean;
}
