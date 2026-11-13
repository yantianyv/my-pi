/**
 * computer-use/elements：把 UIA 元素与视觉检测框合并成一张统一的元素表
 *
 * 双通道各自的价值（实测得出）：
 * - **UIA** 精确、带控件类型与名字（"Button|关闭标签页|422,67,64,48"），能按名字定位，
 *   走 UIA Invoke 时连鼠标都不用动。缺点是原生控件以外的区域（Canvas、游戏、远程桌面、
 *   Chromium 未开无障碍时空一片）完全看不见。
 * - **视觉检测** 只要画在屏幕上就看得见，不依赖应用是否实现无障碍。缺点是没有语义
 *   （只知道"这儿有个控件"）、框可能比真实控件大一圈。
 *
 * 合并原则：**UIA 优先，视觉补空**。两者描述的是同一样东西时留 UIA（更准、可 Invoke）；
 * 视觉框只有在 UIA 没覆盖到时才作为独立条目留下。判据用"视觉框中心落在 UIA 元素内"
 * 而不是 IoU：视觉框常比 UIA 大一圈（把图标的留白也算进去），IoU 会偏低而误判成两个元素。
 *
 * 每个元素都带物理像素中心点，模型点击时直接给坐标，不必自己算框中心。
 */
import type { UiaElement } from "./platform/types";
import type { Detection } from "./model/detector";

/** 统一元素：来源标记决定走哪条动作通道 */
export interface Element {
	/** 元素表里的编号（从 1 开始，与标注图上的编号一致） */
	idx: number;
	source: "uia" | "vision";
	/** 控件类型（uia）或 "Visual"（vision） */
	type: string;
	/** 控件名（uia 常有，vision 永远为空） */
	name: string;
	x: number;
	y: number;
	w: number;
	h: number;
	/** 中心点（物理像素）：点击直接用这个 */
	cx: number;
	cy: number;
	/** 是否可交互（UIA 按控件类型判定；vision 一律视为可交互候选） */
	interactive: boolean;
	/** 视觉置信度（仅 vision） */
	conf?: number;
}

/** UIA 元素里那些"占了整屏的容器"：它们框住一切，留着只会让视觉框全被吃掉 */
const CONTAINER_MIN_RATIO = 0.55;

/**
 * 判断某个 UIA 元素是不是"大容器"。
 * 大容器（整窗 Pane / Custom / Document）虽然本身可能有包围盒，但它不是可点的目标，
 * 而视觉框很容易整个落在它里面——不排除的话"视觉补空"永远补不上。
 */
function isLargeContainer(el: UiaElement, screen: { w: number; h: number }): boolean {
	if (el.interactive) return false;
	return (el.w * el.h) / (screen.w * screen.h) > CONTAINER_MIN_RATIO;
}

/** 点是否落在矩形内 */
function hit(px: number, py: number, r: { x: number; y: number; w: number; h: number }): boolean {
	return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** 把 UIA 元素转成统一条目（按面积从小到大排序，让具体控件排在容器前面） */
function uiaToElements(items: UiaElement[], screen: { w: number; h: number }): Element[] {
	return items
		.filter((e) => e.w > 0 && e.h > 0 && !isLargeContainer(e, screen))
		// 有名字或可交互才留下：匿名的 Pane/Image 对模型没有信息量，只是噪音
		.filter((e) => e.interactive || e.name.trim().length > 0)
		.sort((a, b) => a.w * a.h - b.w * b.h)
		.map((e) => ({
			idx: 0,
			source: "uia" as const,
			type: e.type,
			name: e.name,
			x: e.x,
			y: e.y,
			w: e.w,
			h: e.h,
			cx: Math.round(e.x + e.w / 2),
			cy: Math.round(e.y + e.h / 2),
			interactive: e.interactive,
		}));
}

/**
 * 合并双通道。
 *
 * @param uia UIA 元素（可为空数组：视觉独跑）
 * @param vision 视觉检测框（可为空：UIA 独跑）
 * @param screen 屏幕尺寸（判大容器用）
 * @param opts.includeNonInteractive 是否保留"有名字但不可交互"的 UIA 元素（如标题文本、
 *   只读区域）。默认保留——模型常需要读它们来判断当前界面状态，只是不点。
 */
export function mergeElements(
	uia: UiaElement[],
	vision: Detection[],
	screen: { w: number; h: number },
	opts: { includeNonInteractive?: boolean } = {},
): Element[] {
	const includeNonInteractive = opts.includeNonInteractive ?? true;
	const uiaEls = uiaToElements(uia, screen).filter((e) => includeNonInteractive || e.interactive);

	// UIA 元素按面积升序：判断"视觉框是否已被覆盖"时先用最具体的元素命中
	const visionKept: Element[] = [];
	for (const d of vision) {
		const cx = d.x + d.w / 2;
		const cy = d.y + d.h / 2;
		// 去重判据：视觉框中心落在某个 UIA 元素内，就认为说的是同一个控件。
		// 实测过换成"重叠面积占比 >= 0.6"更严谨，但钉钉页面上 41 个保留的视觉框
		// 与最近 UIA 框的重叠全部 < 0.2——没有重复可去，那个改动只是增加复杂度。
		// 保留中心点判据：够简单，且覆盖了"视觉框比 UIA 框大一圈"的情形。
		const covered = uiaEls.some((e) => hit(cx, cy, e));
		if (covered) continue;
		visionKept.push({
			idx: 0,
			source: "vision",
			type: "Visual",
			name: "",
			x: d.x,
			y: d.y,
			w: d.w,
			h: d.h,
			cx: Math.round(cx),
			cy: Math.round(cy),
			interactive: true,
			conf: d.conf,
		});
	}

	// 统一编号：UIA 在前（更可靠），视觉在后；各自内部保持"从小到大/从高到低"
	const all = [...uiaEls, ...visionKept.sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0))];
	// 编号要跟标注图的绘制顺序一致，所以按最终顺序从 1 开始
	return all.map((e, i) => ({ ...e, idx: i + 1 }));
}

/** 元素表渲染成给模型看的紧凑文本（一行一个，避免占太多 token） */
export function formatElements(els: Element[]): string {
	if (!els.length) return "（没有找到可交互元素）";
	return els
		.map((e) => {
			const label = e.name ? `${e.type}「${truncate(e.name, 28)}」` : e.type;
			const conf = e.conf !== undefined ? ` conf=${e.conf.toFixed(2)}` : "";
			const mark = e.interactive ? "" : "（只读）";
			return `${e.idx}. ${label}${mark} @(${e.cx},${e.cy}) ${e.w}x${e.h}${conf}`;
		})
		.join("\n");
}

function truncate(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** 按编号找元素（工具参数里的 element 就是它） */
export function findByIndex(els: Element[], idx: number): Element | undefined {
	return els.find((e) => e.idx === idx);
}
