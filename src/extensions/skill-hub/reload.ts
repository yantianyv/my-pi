/**
 * skill-hub/reload：技能变更后的重载调度
 *
 * 轮中不能 reload（旧运行时一失效，本轮后续的扩展工具调用全部报 stale）；followUp 排队
 * "/reload" 也不生效（sendUserMessage 默认不派发命令，原文进对话）。打法：轮中 steer 一条
 * 收尾指令让模型立即结束本轮，等 agent_settled（运行时安全边界）借 /skill-hub 的隐藏子
 * 命令走 ctx.reload()；重载后由新实例按 globalThis 标记自动续跑原任务。空闲且面板未开
 * 时直接派发子命令立即重载。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 重载派发文本：借 /skill-hub 的隐藏子命令拿到带 ctx.reload() 的命令上下文（不占顶层命令位，不进自动补全） */
export const RELOAD_DISPATCH = "/skill-hub __reload";

/** 重载后续跑任务的标记键（globalThis 跨 reload 存活，模块状态不存活） */
export const RESUME_KEY = "__PI_SKILL_HUB_RESUME__";

/** 插给模型的收尾指令（steer：当前工具批结束后、下次 LLM 调用前送达） */
export const STEER_TEXT =
	"（系统自动消息）技能变更已落盘，需要重载运行时才能生效。请立即用一句话收尾并结束本轮，不要再发起新的工具调用；重载完成后会自动继续当前任务。";

type Sender = Pick<ExtensionAPI, "sendUserMessage">;

export interface ReloadScheduler {
	/** 技能已装/卸：安排重载（resume 为重载完成后发给模型的续跑指令，空闲入口传 null） */
	schedule(ctx: ExtensionContext, resume: string | null): void;
	/** 市场面板开/关：面板属于旧运行时，开着时不能重载 */
	panelOpened(): void;
	panelClosed(ctx: ExtensionContext): void;
	/** agent_settled：轮彻底结束，补发重载；用户中断（Esc）则取消续跑 */
	settled(aborted: boolean): void;
	/** session_start：重载完成的新实例按标记续跑（其他原因的 session_start 只清标记） */
	sessionStarted(reason: string): void;
}

export function createReloadScheduler(pi: Sender): ReloadScheduler {
	let reloadPending = false;
	let panelOpen = false;

	/** 派发内部重载子命令：expandPromptTemplates 让它作为命令执行，而不是原文进对话 */
	function dispatch(): void {
		pi.sendUserMessage(RELOAD_DISPATCH, { expandPromptTemplates: true });
	}

	return {
		schedule(ctx, resume) {
			if (resume) (globalThis as Record<string, unknown>)[RESUME_KEY] = resume;
			if (ctx.isIdle?.() && !panelOpen) {
				dispatch();
				return;
			}
			if (!reloadPending) {
				reloadPending = true;
				if (!ctx.isIdle?.()) pi.sendUserMessage(STEER_TEXT, { deliverAs: "steer" });
			}
		},
		panelOpened() {
			panelOpen = true;
		},
		panelClosed(ctx) {
			panelOpen = false;
			if (reloadPending && ctx.isIdle?.()) {
				reloadPending = false;
				dispatch();
			}
		},
		settled(aborted) {
			if (!reloadPending) return;
			reloadPending = false;
			if (aborted) delete (globalThis as Record<string, unknown>)[RESUME_KEY];
			dispatch();
		},
		sessionStarted(reason) {
			const resume = (globalThis as Record<string, unknown>)[RESUME_KEY] as string | undefined;
			if (!resume) return;
			delete (globalThis as Record<string, unknown>)[RESUME_KEY];
			if (reason !== "reload") return;
			// setTimeout 让 reload 的 session_start 流程先走完再发起续跑
			setTimeout(() => {
				try {
					pi.sendUserMessage(resume);
				} catch {
					/* 会话已切换或无可用模型，静默放弃 */
				}
			}, 0);
		},
	};
}
