/**
 * ask/state：跨模块运行时状态（最近 ctx、待答状态推送、问卷页排队链）
 *
 * - rememberCtx：工具/命令/事件各自拿到 ctx 时登记，供状态推送使用（stale 时吞错）
 * - refreshPendingStatus：扫描问卷目录 → setStatus("ask", …)（hud 缺席自动回落原生 footer）
 * - enqueueQuestionnaireUI：AI 同批创建多份问卷时整屏页逐个打开（前一份关闭才开下一份）
 */
import { listQuestionnaires } from "./store";

interface StatusSink {
	ui: { setStatus(key: string, text?: string): void };
}

let lastCtx: StatusSink | undefined;

export function rememberCtx(ctx: StatusSink): void {
	lastCtx = ctx;
}

/** 待答数量 → 状态通道（0 时清除）；ctx 失效（reload/会话切换）时静默放弃 */
export async function refreshPendingStatus(): Promise<void> {
	let n = 0;
	try {
		n = listQuestionnaires().items.length;
	} catch {
		/* 目录不可读视为 0 */
	}
	try {
		lastCtx?.ui.setStatus("ask", n > 0 ? `📝 ${n} 份问卷待答 · /answer` : undefined);
	} catch {
		/* stale ctx 忽略 */
	}
}

let uiChain: Promise<unknown> = Promise.resolve();

/** Working 行等待登记（status-beacon 桥，缺席静默）：整屏问卷打开时告诉用户「在等什么」 */
export function setWorkingWait(text: string | null): void {
	try {
		((globalThis as Record<string, unknown>).__PI_STATUS_BEACON_API__ as
			| { wait?: (t: string | null) => void }
			| undefined)?.wait?.(text);
	} catch {
		/* 联动是增强，缺席不影响问卷 */
	}
}

/** 问卷页排队链：fn 在前一份问卷 UI 关闭后才执行（前一份异常不阻塞后续） */
export function enqueueQuestionnaireUI<T>(fn: () => Promise<T>): Promise<T> {
	const run = uiChain.then(fn, fn);
	uiChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
