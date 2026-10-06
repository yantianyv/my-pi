/**
 * btw/config：常量配置 + 系统提示词 + 模型设置与选择（btw 多文件扩展的组成部分）
 *
 * 职责：
 * - 可调配置常量集中定义（超时/轮数/字数/浮层尺寸等）
 * - BTW_SYSTEM_PROMPT：btw 助手系统提示词（固定指令在前，利于 provider 端 prompt 缓存命中）
 * - btw 模型设置（~/.pi/agent/btw-config.json 的 model 键）：auto = 交给 model-config 按用途
 *   `btw.chat` 设置解析（默认策略 FAST）；也可本地固定一个 provider/modelId（谁在不在都照用）
 *
 * 注意：本模块不注册任何 pi API，仅导出常量/状态/纯函数，由本目录其它模块与入口驱动。
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createModelSetting, type ModelSetting, type ResolvedModel } from "../shared/model-setting";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** btw 单次 LLM 调用最大输出 token（含工具轮次） */
export const BTW_MAX_TOKENS = 4096;
/** btw 面板单轮问答最多跑几轮（一轮 = 一次 LLM 调用 + 可能的工具调用） */
export const BTW_MAX_TURNS = 6;
/** 空回答自动重试次数：部分模型（如 deepseek-flash）偶发返回空 assistant 消息（content 空数组、无流式、瞬时完成），重试可大概率恢复 */
export const BTW_EMPTY_RETRY = 1;
/** 请求超时 */
export const BTW_TIMEOUT_MS = 5 * 60_000;
/** 携带的主会话上下文消息条数上限（超出从最早丢弃，保留最近） */
export const BTW_MAX_CONTEXT_MESSAGES = 60;
/** btw 面板内最多追问轮数（一轮 = 一问一答） */
export const BTW_MAX_THREAD_TURNS = 8;
/** 最终请求消息总数上限（主会话 + 面板线程） */
export const BTW_MAX_TOTAL_MESSAGES = 80;
/** 单条 toolResult 消息文本最多保留字符数（控制 token 成本） */
export const BTW_MAX_TOOL_RESULT_CHARS = 1500;
/** 浮层宽度（终端宽度百分比） */
export const BTW_OVERLAY_WIDTH = "42%";
/** 浮层最小宽度（列） */
export const BTW_OVERLAY_MIN_WIDTH = 46;
/** 浮层最大高度（终端高度百分比） */
export const BTW_OVERLAY_MAX_HEIGHT = "80%";
/** 浮层渲染行数上限（render 按终端高度自适应，保证边框完整） */
export const BTW_MAX_ROWS = 32;
/** 单条问题最多显示几行（超出截断） */
export const BTW_MAX_QUESTION_LINES = 4;
/** 输入框最多多少个字符 */
export const BTW_MAX_INPUT_LENGTH = 300;

/** btw 模型设置持久化文件（agent 目录下） */
const BTW_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "btw-config.json");

/** btw 助手的系统提示词（固定指令在前，利于 provider 端 prompt 缓存命中） */
export const BTW_SYSTEM_PROMPT = [
	"你是 btw 助手（by the way），运行在用户正在进行的编码任务旁边的侧栏问答面板里。",
	"用户此刻就是在这个面板中与你对话——本面板独立于主会话，你的回答不会写入主会话。",
	"你的回答会以 markdown 轻量渲染显示（**粗体**、`行内代码`、`# 标题`、`- 列表`、markdown 表格），需要结构化时尽管使用。",
	"",
	"你可以使用只读工具（read / ls / grep / find）查证代码与文件内容来回答得更准确，",
	"但只读不写：不要修改任何文件，也不能执行命令（没有 bash 工具）。",
	"",
	"输入结构：",
	"- 前半部分是主会话的对话历史（用户消息、助手消息、工具输出），帮助你理解任务背景；",
	"- 后半部分是本面板内你与此用户的历次问答（user 是问题、assistant 是你的回答）；",
	"- 最后一条 user 消息是当前要回答的问题。",
	"",
	"要求：",
	"- 回答准确、简洁、直接：默认控制在几句话到一小段，像资深同事随口回答；用户明确要求详细时才展开",
	"- 专注当前问题本身：不要汇报/总结主会话的进度、状态或做了什么，除非用户明确要求",
	"- 开场直接给答案，不要「让我看看」「梳理一下」「我发现了问题」这类过渡语或复盘",
	"- 只回答当前问题本身，不要复述任务、不要列行动清单、不要建议下一步行动",
	"- 需要查证时先用只读工具看文件，再回答；工具调用轮次里不要长篇大论，最终回答才展开",
	"- 被问到关于你自己的问题（如「你知道自己在哪吗」「你能用工具吗」），如实说明：你是 btw 面板助手，",
	"  独立于主会话，只能读文件（read / ls / grep / find），不能修改文件或执行命令",
	"- 追问时结合前面的问答（例如「我刚才提到的 xx 具体指？」），不要重复已给过的内容",
	"- 不提及「对话历史」「上下文」等内部机制，直接回答问题",
	"- 如果依据现有信息无法判断，明确说明这一点",
].join("\n");

// ---------------------------------------------------------------------------
// btw 模型设置
// ---------------------------------------------------------------------------

/**
 * btw 的模型设置（用途 `btw.chat`，默认策略 FAST）：
 * 本地值 auto = 交给 model-config；或本地固定 provider/modelId。
 * 解析链与故障转移见 shared/model-setting。
 */
export const btwModelSetting: ModelSetting = createModelSetting({
	purpose: "btw.chat",
	plugin: "btw",
	label: "侧栏问答",
	file: BTW_CONFIG_FILE,
	key: "model",
	defaultStrategy: "FAST",
});

/** 解析当前 btw 模型（每次提问都重新解析：面板改完立即生效，无需 /reload） */
export function resolveBtwModel(ctx: ExtensionCommandContext): ResolvedModel {
	return btwModelSetting.resolve(ctx);
}
