/**
 * workflow-mgr / audit.ts — 完成信号独立审计（借鉴 pi-goal-x 的 completion auditor）
 *
 * 灵感：pi-goal-x 在 agent 宣布完成时派**独立 agent**（全新上下文，不带宣布者的心智锚点）
 * 核验完成信号——同上下文自验容易「锚定在自己的表述上，ratify 而不是 attack」。
 *
 * 本模块在 wf_switch 完成推进前被调用（需 config.json 开启 auditOnComplete，默认关）：
 * 只读工具 + bash 的审计子代理自行到工作区找证据（读交付物、跑验证命令），
 * 输出 {"pass": bool, "reason": "..."}；不通过则 wf_switch 打回，任务保持 doing。
 *
 * 注意：审计跑在当前会话模型上（认证走 ctx 的 streamFn，与 claude-it /init 同路线）。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { runAgentLoop, type AgentLoopConfig, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { convertToLlm, createPiStreamFn, systemMessage } from "../shared/agent";
import { createModelSetting, type ModelSetting } from "../shared/model-setting";
import type { TaskDef } from "./types";

/**
 * 审计子代理模型（用途 `audit`，默认策略 AUTO = 跟随当前会话模型）：
 * 审计与主会话同源上下文更可比；可在 /model-config 里改指别的策略或具体模型。
 */
const auditModelSetting: ModelSetting = createModelSetting({
	purpose: "audit",
	plugin: "workflow-mgr",
	label: "完成信号审计",
	defaultStrategy: "AUTO",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

/** 审计子代理最大轮数（read/bash 验证通常 3-5 轮足够） */
const AUDIT_MAX_TURNS = 10;
/** 审计超时（毫秒）：审计是同步阻塞 wf_switch 的，不能拖太久 */
const AUDIT_TIMEOUT_MS = 90_000;
/** 审计输出上限 */
const AUDIT_MAX_TOKENS = 2048;

export interface AuditVerdict {
	pass: boolean;
	reason: string;
	/** 不通过的种类：evidence=证据不足（审计读到了东西但不足以支撑完成）；
	 *  format=审计输出无法解析（保守视为不通过）；infra=审计基础设施故障（此类放行，不产生 pass=false） */
	kind?: "evidence" | "format" | "infra";
}

function buildAuditPrompt(task: TaskDef): string {
	return (
		`你是独立审计者。一个协作任务刚被宣布完成，请核验「完成信号」是否真的满足。\n` +
		`不要信任宣布者的任何说法——自己在工作区里找证据（读文件、跑命令）。\n\n` +
		`任务标题：${task.title}\n` +
		`任务目标：${task.desc || "（未定义）"}\n` +
		`交付物：${task.deliverable || "（未定义）"}\n` +
		`完成信号：${task.doneSignal}\n\n` +
		`核验要点：\n` +
		`- 交付物是否存在且内容实质（不是空壳/占位）\n` +
		`- 完成信号描述的验证方式，能跑就跑（如「npm test 通过」就真的去跑）\n` +
		`- 警惕「部分完成当完成」：逐字对照完成信号的每个分句\n\n` +
		`最后且仅最后一行输出 JSON：{"pass": true|false, "reason": "一句话依据"}`
	);
}

/** 从审计输出解析结论：取最后一个 JSON 对象；解析失败视为不通过（保守） */
function parseVerdict(text: string): AuditVerdict {
	const matches = [...text.matchAll(/\{[^{}]*"pass"[^{}]*\}/g)];
	const last = matches[matches.length - 1]?.[0];
	if (last) {
		try {
			const j = JSON.parse(last) as { pass?: unknown; reason?: unknown };
			return {
				pass: j.pass === true,
				reason: typeof j.reason === "string" ? j.reason : "（无理由）",
				kind: j.pass === true ? undefined : "evidence",
			};
		} catch {
			/* fallthrough */
		}
	}
	return { pass: false, reason: "审计输出未包含合法结论 JSON（保守视为不通过）", kind: "format" };
}

/**
 * 独立审计任务完成度。审计自身失败（超时/无模型/异常）时**放行并附警告**——
 * 审计是增强而非门禁，基础设施故障不应卡死工作流推进。
 */
export async function auditCompletion(ctx: ExtensionContext, task: TaskDef): Promise<AuditVerdict> {
	const model = auditModelSetting.resolve(ctx).model ?? (ctx.model as AnyModel | undefined);
	if (!model) return { pass: true, reason: "（审计跳过：无可用模型）" };

	const tools = [...createReadOnlyTools(ctx.cwd), createBashTool(ctx.cwd)];
	const config: AgentLoopConfig = {
		model,
		maxTokens: AUDIT_MAX_TOKENS,
		convertToLlm,
		finishTurn: (() => {
			let turns = 0;
			return () => (++turns >= AUDIT_MAX_TURNS ? { action: "end" as const } : undefined);
		})(),
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
	try {
		const userMessage: AgentMessage = { role: "user", content: buildAuditPrompt(task), timestamp: Date.now() };
		const newMessages = await runAgentLoop(
			[userMessage],
			{ messages: [systemMessage("你是严谨冷峻的独立审计者，只说证据，不给面子。")], tools },
			config,
			() => {},
			controller.signal,
			createPiStreamFn(ctx),
		);
		for (let i = newMessages.length - 1; i >= 0; i--) {
			const m = newMessages[i];
			if (m.role !== "assistant") continue;
			const text = m.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { type: "text"; text: string }).text)
				.join("\n")
				.trim();
			if (text) return parseVerdict(text);
		}
		return { pass: true, reason: "（审计无产出，放行）" };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { pass: true, reason: `（审计异常放行：${msg.includes("abort") ? "超时" : msg}）` };
	} finally {
		clearTimeout(timer);
	}
}
