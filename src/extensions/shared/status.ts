/**
 * 官方 setStatus 状态通道的 TTL 包装
 *
 * 展示层统一走 ctx.ui.setStatus 推送（hud 行 1 动态区 / 原生 footer 第 3 行），
 * 各扩展自行管理「显示一段时间后消失」的 TTL 曾大量重复 setTimeout 样板。
 * 本工具以 key 维度维护定时器：重复调用同 key 会重置旧定时器（延长展示），
 * text 传 undefined 则手动清除、不挂新定时器。
 *
 * 复杂行为（闪烁帧、多层撤销、多阶段）仍由调用方自管（如 task-alert 的闪烁）。
 *
 * 生命周期：定时器闭包捕获调用方传入的 ctx——/reload、ctx.switchSession() 等
 * 场景下旧 ctx 会失效，到期回调再调 ctx.ui.setStatus 会抛 stale 错误（曾导致
 * pi 因 uncaughtException 崩溃）。双保险：
 * 1. 调用方在 session_shutdown 时调 clearStatusTimers() 主动清空（治本）；
 * 2. 到期回调内 try/catch 吞掉失效 ctx 错误（兜底，防漏网扩展）。
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** 设置状态并在 ttlMs 后自动清除（同 key 重复调用重置旧定时器；text 为 undefined 仅手动清除） */
export function setStatusWithTTL(
	ctx: { ui: { setStatus(key: string, text?: string): void } },
	key: string,
	text: string | undefined,
	ttlMs: number,
): void {
	ctx.ui.setStatus(key, text);
	const old = timers.get(key);
	if (old) clearTimeout(old);
	if (text === undefined) {
		timers.delete(key);
		return;
	}
	timers.set(
		key,
		setTimeout(() => {
			try {
				ctx.ui.setStatus(key, undefined);
			} catch {
				// 旧 ctx 已失效（reload / session 替换后 TTL 才到期），吞掉避免 uncaughtException
			}
			timers.delete(key);
		}, ttlMs),
	);
}

/** 清空所有 TTL 定时器（reload / quit / session 替换前由各调用方在 session_shutdown 里调用） */
export function clearStatusTimers(): void {
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
}
