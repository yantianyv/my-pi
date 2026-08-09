/**
 * workflow-mgr — 人机协作任务面板（通用工作流版）
 *
 * 定位：AI 是流程指挥者（拆解、排序、验证、推进），人类是执行者（做任务、拍板）。
 * 插件把「流程控制」变成稳定基础设施，不依赖提示词级别的自觉。
 *
 * 本文件为组装薄壳：工具注册（tools.ts）/ 命令注册（commands.ts）/ 事件钩子（events.ts）
 * 各自独立模块，共享 store 经 store.ts 的 getStore 会话级缓存访问。build.js 把整个
 * workflow-mgr/ 目录打包为单文件 dist/extensions/workflow-mgr.ts。
 *
 * 数据（项目级、跨会话、可 git 审查）：
 * - .pi/workflow/workflow.json  工作流定义（阶段→任务，含人机分工/交付物/完成信号/依赖）
 * - .pi/workflow/state.json     进度状态（currentTaskId/tasks/milestones/decisions/log）
 * - .pi/workflow/config.json    面板开关等 UI 配置
 *
 * 工具：wf_workflow（list/add/edit/remove/archive/reset）、wf_status、wf_start、wf_done、
 *       wf_block、wf_rollback、wf_decision、wf_milestone。
 * 命令：/workflow-config 轻量功能浮窗（显示详细信息/常驻面板开关）。
 * 事件：session_start 加载+刷新+notify；before_agent_start 向 systemPrompt 追加
 *       「指挥者角色」指南（不注入 message——避免淹没对话、膨胀会话文件）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools";
import { registerCommand } from "./commands";
import { registerEvents } from "./events";

export default function (pi: ExtensionAPI) {
	registerTools(pi);
	registerCommand(pi);
	registerEvents(pi);
}
