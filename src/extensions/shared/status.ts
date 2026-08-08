/**
 * 官方 setStatus 状态通道的 TTL 包装
 *
 * 展示层统一走 ctx.ui.setStatus 推送（hud 行 1 动态区 / 原生 footer 第 3 行），
 * 各扩展自行管理「显示一段时间后消失」的 TTL 曾大量重复 setTimeout 样板。
 * 本工具以 key 维度维护定时器：重复调用同 key 会重置旧定时器（延长展示），
 * text 传 undefined 则手动清除、不挂新定时器。
 *
 * 复杂行为（闪烁帧、多层撤销、多阶段）仍由调用方自管（如 task-alert 的闪烁）。
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
			ctx.ui.setStatus(key, undefined);
			timers.delete(key);
		}, ttlMs),
	);
}
