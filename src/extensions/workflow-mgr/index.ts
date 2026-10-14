/**
 * workflow-mgr — 会话级任务面板
 *
 * 定位：AI 是流程指挥者（拆解、排序、验证、推进），人类是执行者（做任务、拍板）。
 * 插件把「流程控制」变成稳定基础设施，不依赖提示词级别的自觉。
 *
 * 本文件为组装薄壳：工具注册（tools.ts）/ 命令注册（commands.ts）/ 事件钩子（events.ts）
 * 各自独立模块，共享 store 经 store.ts 的 getStore 会话级缓存访问。build.js 把整个
 * workflow-mgr/ 目录打包为单文件 dist/extensions/workflow-mgr.ts。
 *
 * 数据（全局、按会话隔离，可人工查阅）：
 * - <workflowHome>/<项目标识>/<会话ID>/workflow.json  工作流定义（阶段→任务，含人机分工/交付物/完成信号/依赖）
 * - <workflowHome>/<项目标识>/<会话ID>/state.json     进度状态（currentTaskId/tasks/log）
 * workflowHome 缺省为 ~/.pi/agent/workflow（PI_WORKFLOW_HOME 可覆盖）。
 *
 * 工具：wf_workflow（list/add/edit/remove/archive/import）、wf_status、wf_switch、
 *       wf_block、wf_rollback。
 * 命令：/wf（状态摘要）、/wf-config（进度总览 + 常驻面板开关）。
 * 事件：session_start 加载本会话工作流并刷新 UI；before_agent_start 按 mode 注入角色指引
 *       （不注入 message——避免淹没对话、膨胀会话文件）。
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
