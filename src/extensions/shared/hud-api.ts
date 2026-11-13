/**
 * shared/hud-api：hud 底部行契约的键名单点定义
 *
 * hud 挂 globalThis.__PI_HUD_API__（registerExtraRows）与 __PI_HUD_ACTIVE__（hud 开启
 * 标记），workflow-mgr 等扩展消费；零 import 耦合下，键名两端各写一遍会静默漂移，
 * 故收敛到本模块（同 explore-api 的做法）。生产端 hud-core 与消费端 import 同一常量。
 */

export const HUD_API_KEY = "__PI_HUD_API__";
export const HUD_ACTIVE_KEY = "__PI_HUD_ACTIVE__";

/** hud 侧持有的「额外底部行」接口形状（消费方据此类型化读取，不 import hud 产物） */
export interface HudExtraRowsApi {
	/** 注册一个渲染函数（theme, width) => string[] | null；返回注销函数 */
	registerExtraRows: (provider: (theme: unknown, width: number) => string[] | null) => () => void;
	/** 注册内容变化时通知 hud 重绘 */
	notifyExtraRowsUpdate: () => void;
}

/** 取 HUD API；hud 未加载时返回 null（消费方自行降级，如恢复自绘面板） */
export function getHudApi(): HudExtraRowsApi | null {
	const g = globalThis as Record<string, unknown>;
	return (g[HUD_API_KEY] as HudExtraRowsApi | undefined) ?? null;
}

/** hud 是否在场且开启（不在场时消费方不该渲染） */
export function hudActive(): boolean {
	return Boolean((globalThis as Record<string, unknown>)[HUD_ACTIVE_KEY]);
}
