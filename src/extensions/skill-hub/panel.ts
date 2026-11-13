/**
 * skill-hub/panel：技能市场浮层（人用）
 *
 * 一屏解决人这边的事：浏览、搜索、收藏、安装、卸载。三个区域从上到下——
 *   搜索行（输入词后 Enter 打 skills.sh；空词显示「收藏 + 已装」本地视图）
 *   列表（★ 收藏 / 已装 标记，安装量右对齐；收藏的排最前）
 *   提示行（忙碌/结果反馈）+ 键位
 *
 * 键盘：
 *   ↑↓ 选择 · PgUp/PgDn 翻页 · Enter 安装/卸载（弹确认）· f 收藏 · / 搜索 · r 刷新 · Esc 关闭
 *   输入态：Enter 检索 · Esc 取消
 *   确认态：Enter 执行 · Esc 返回
 *
 * 面板内的安装不弹 review 面板——人在这里按下 Enter 就是确认；但**不可逆动作仍要二次确认**
 * （安装看文件与审计，卸载看目录），避免手滑。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { choiceKey, createBoxRenderer, editInput, renderScrollingInput } from "../shared/ui";
import type { Favorite } from "./favorites";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 列表可视行数（不含边框与提示行） */
const LIST_ROWS = 12;
/** 单行里安装量列的宽度 */
const INSTALLS_W = 9;
/** 详情拉取的总时限：超过就先报超时，数据晚到再覆盖（不让面板一直卡在「读取中」） */
const DETAIL_TIMEOUT_MS = 8000;

export interface MarketRow {
	source: string;
	skillId: string;
	name: string;
	/** 安装量；本地视图（收藏/已装）里未知 */
	installs?: number;
	favorited: boolean;
	installed: boolean;
}

export interface InstalledView {
	name: string;
	dir: string;
	source: string;
	ref: string;
}

/** 面板依赖（由入口注入，便于脱离网络与 pi 运行时做渲染测试） */
export interface PanelDeps {
	favorites: () => Favorite[];
	installed: () => InstalledView[];
	/** 联网检索；失败抛错，由面板展示 */
	search: (query: string) => Promise<{ source: string; skillId: string; name: string; installs: number }[]>;
	/** 安装：返回人话结果；progress 回调用于面板上显示阶段 */
	install: (row: MarketRow, progress: (text: string) => void) => Promise<{ ok: boolean; message: string }>;
	uninstall: (name: string) => Promise<{ ok: boolean; message: string }>;
	toggleFavorite: (row: MarketRow) => boolean;
	/** 打开时是否需要取审计与文件清单（安装前确认用） */
	describe: (row: MarketRow) => Promise<{
		files: string[];
		audits: string[];
		trust: string[];
		target: string;
		/** SKILL.md 头部声明的描述；null = 这次没取到（网络/来源问题），空串 = 文件里就没写 */
		description: string | null;
		ref: string;
	}>;
}

type Mode = "browse" | "input" | "confirm";

type DetailState =
	| { kind: "loading" }
	| { kind: "failed"; message: string }
	| { kind: "ready"; description: string | null; audits: string[]; files: number; ref: string };

interface ConfirmState {
	action: "install" | "uninstall";
	row: MarketRow;
	lines: string[];
}

export class SkillsPanel implements Component {
	private mode: Mode = "browse";
	private query = "";
	private cursor = 0;
	private rows: MarketRow[] = [];
	private sel = 0;
	private top = 0;
	private note = "";
	private busy = false;
	private confirmState: ConfirmState | null = null;
	/** 本次打开后是否已做过一次检索（决定空态文案） */
	private searched = false;
	/** 选中项详情缓存：选中变化时按需拉一次，同一技能不重复拉 */
	private details = new Map<string, DetailState>();
	private detailTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private deps: PanelDeps,
		private theme: Theme,
		private tui: TUI,
		private done: () => void,
	) {
		this.reloadLocal();
	}

	dispose(): void {
		if (this.detailTimer) clearTimeout(this.detailTimer);
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	// -------------------------------------------------------------------------
	// 数据
	// -------------------------------------------------------------------------

	/** 本地视图：收藏（按收藏时间）+ 已装（未在收藏里的），不发网络请求 */
	private reloadLocal(): void {
		const favorites = this.deps.favorites();
		const installed = this.deps.installed();
		const rows: MarketRow[] = [];
		for (const f of favorites) {
			rows.push({
				source: f.source,
				skillId: f.skillId,
				name: f.name,
				favorited: true,
				installed: installed.some((i) => i.name === f.skillId),
			});
		}
		for (const i of installed) {
			if (rows.some((r) => r.skillId === i.name)) continue;
			rows.push({
				source: i.source,
				skillId: i.name,
				name: i.name,
				favorited: false,
				installed: true,
			});
		}
		this.rows = rows;
		this.searched = false;
		this.clamp();
		this.scheduleDetails();
	}

	/** 用检索结果建行：收藏的排最前，其余按安装量降序 */
	private applySearch(
		hits: { source: string; skillId: string; name: string; installs: number }[],
		query: string,
	): void {
		const installed = this.deps.installed();
		const favorites = this.deps.favorites();
		const isFav = (source: string, skillId: string) => favorites.some((f) => f.source === source && f.skillId === skillId);
		const rows = hits.map((h) => ({
			source: h.source,
			skillId: h.skillId,
			name: h.name,
			installs: h.installs,
			favorited: isFav(h.source, h.skillId),
			installed: installed.some((i) => i.name === h.skillId),
		}));
		rows.sort((a, b) => Number(b.favorited) - Number(a.favorited) || (b.installs ?? 0) - (a.installs ?? 0));
		this.rows = rows;
		this.searched = true;
		this.sel = 0;
		this.top = 0;
		this.scheduleDetails();
		this.note = rows.length ? `「${query}」找到 ${rows.length} 个` : `「${query}」没有匹配的技能`;
	}

	private clamp(): void {
		this.sel = Math.min(Math.max(0, this.sel), Math.max(0, this.rows.length - 1));
		if (this.sel < this.top) this.top = this.sel;
		if (this.sel >= this.top + LIST_ROWS) this.top = this.sel - LIST_ROWS + 1;
	}

	private current(): MarketRow | undefined {
		return this.rows[this.sel];
	}

	/** 选中项的详情：缓存命中直接用，否则 250ms 防抖后拉一次（翻列表时不打请求风暴） */
	private scheduleDetails(): void {
		if (this.detailTimer) clearTimeout(this.detailTimer);
		const row = this.current();
		if (!row) return;
		const key = `${row.source}/${row.skillId}`;
		if (this.details.has(key)) return;
		this.details.set(key, { kind: "loading" });
		this.detailTimer = setTimeout(() => {
			const pending = this.deps.describe(row);
			// 总时限只为「界面别卡住」：真实结果晚到仍会覆盖超时提示
			const timer = setTimeout(() => {
				if (this.details.get(key)?.kind === "loading") {
					this.details.set(key, { kind: "failed", message: "读取超时（重选可重试）" });
					this.tui.requestRender();
				}
			}, DETAIL_TIMEOUT_MS);
			timer.unref?.();
			void pending
				.then((info) =>
					this.details.set(key, {
						kind: "ready",
						description: info.description,
						audits: info.audits,
						files: info.files.length,
						ref: info.ref,
					}),
				)
				.catch((e) => this.details.set(key, { kind: "failed", message: e instanceof Error ? e.message : String(e) }))
				.finally(() => {
					clearTimeout(timer);
					this.tui.requestRender();
				});
		}, 250);
		this.detailTimer.unref?.();
	}

	// -------------------------------------------------------------------------
	// 输入
	// -------------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.busy) {
			// 忙碌时只允许 Esc 关闭（避免操作与进行中的请求交叉）
			if (matchesKey(data, Key.escape)) this.done();
			return;
		}
		if (this.mode === "input") {
			this.handleInputMode(data);
			return;
		}
		if (this.mode === "confirm") {
			this.handleConfirmMode(data);
			return;
		}
		this.handleBrowseMode(data);
	}

	private handleInputMode(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.mode = "browse";
			this.note = "";
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.mode = "browse";
			void this.runSearch();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			return;
		}
		const edited = editInput(this.query, this.cursor, data, { maxLength: 120 });
		if (edited !== "skip") {
			this.query = edited.text;
			this.cursor = edited.cursor;
		}
	}

	private handleConfirmMode(data: string): void {
		const st = this.confirmState;
		if (!st) {
			this.mode = "browse";
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.confirmState = null;
			this.mode = "browse";
			this.note = "";
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.confirmState = null;
			this.mode = "browse";
			if (st.action === "install") void this.runInstall(st.row);
			else void this.runUninstall(st.row);
		}
	}

	private handleBrowseMode(data: string): void {
		const r = choiceKey(data, this.sel, this.rows.length);
		switch (r.kind) {
			case "cancel":
				this.done();
				return;
			case "move":
				this.sel = r.index;
				this.clamp();
				this.scheduleDetails();
				return;
			case "page":
				this.sel = Math.min(Math.max(0, this.sel + r.dir * LIST_ROWS), Math.max(0, this.rows.length - 1));
				this.clamp();
				this.scheduleDetails();
				return;
			case "select":
				this.beginAction();
				return;
			case "skip":
				break;
		}
		if (data === "/" || matchesKey(data, Key.ctrl("f"))) {
			this.mode = "input";
			this.cursor = this.query.length;
			return;
		}
		if (data === "f") {
			const row = this.current();
			if (!row) return;
			const nowFav = this.deps.toggleFavorite(row);
			row.favorited = nowFav;
			this.note = nowFav ? `已收藏 ${row.name}` : `已取消收藏 ${row.name}`;
			// 收藏优先：浏览器视图下立刻按收藏状态重排
			if (!this.searched) this.reloadLocal();
			return;
		}
		if (data === "r") {
			this.reloadLocal();
			this.note = "已刷新";
			return;
		}
		// 直接打字＝开始搜索（少按一次 /）
		if (/^[\x20-\x7e]$/.test(data) && data !== " ") {
			this.mode = "input";
			this.query = data;
			this.cursor = data.length;
		}
	}

	// -------------------------------------------------------------------------
	// 动作
	// -------------------------------------------------------------------------

	private beginAction(): void {
		const row = this.current();
		if (!row) {
			this.mode = "input";
			return;
		}
		if (row.installed) {
			this.confirmState = {
				action: "uninstall",
				row,
				lines: ["将从项目删除该技能的目录", "手改过的内容会一并丢失（可重新安装）"],
			};
			this.mode = "confirm";
			return;
		}
		// 安装前先取文件清单与审计，作为确认内容（网络失败也能看到原因）
		this.busy = true;
		this.note = "正在读取技能信息…";
		void this.deps
			.describe(row)
			.then((info) => {
				this.confirmState = {
					action: "install",
					row,
					lines: [
						`来源 ${row.source}`,
						`目标 ${info.target}`,
						`文件 ${info.files.length} 个：${info.files.slice(0, 4).join("、")}${info.files.length > 4 ? " …" : ""}`,
						`审计 ${info.audits.join(" · ") || "无记录"}`,
						...info.trust,
					],
				};
				this.mode = "confirm";
			})
			.catch((e) => {
				this.note = `读取失败：${e instanceof Error ? e.message : String(e)}`;
			})
			.finally(() => {
				this.busy = false;
				this.tui.requestRender();
			});
	}

	private async runSearch(): Promise<void> {
		const q = this.query.trim();
		if (!q) {
			this.reloadLocal();
			this.note = "";
			return;
		}
		this.busy = true;
		this.note = `正在检索「${q}」…`;
		this.tui.requestRender();
		try {
			this.applySearch(await this.deps.search(q), q);
		} catch (e) {
			this.note = `检索失败：${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	private async runInstall(row: MarketRow): Promise<void> {
		this.busy = true;
		this.note = `正在安装 ${row.name}…`;
		this.tui.requestRender();
		try {
			const r = await this.deps.install(row, (text) => {
				this.note = text;
				this.tui.requestRender();
			});
			this.note = r.message;
			if (r.ok) {
				row.installed = true;
				// 装完会触发自动重载（面板关闭后派发）；本地状态以账本为准重新取一遍
				this.refreshInPlace();
			}
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	private async runUninstall(row: MarketRow): Promise<void> {
		this.busy = true;
		this.note = `正在卸载 ${row.name}…`;
		this.tui.requestRender();
		try {
			const r = await this.deps.uninstall(row.name);
			this.note = r.message;
			if (r.ok) {
				row.installed = false;
				this.refreshInPlace();
			}
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	/** 只更新「已装」标记，不打乱当前列表（检索结果不该因为装完就跳走） */
	private refreshInPlace(): void {
		const installed = new Set(this.deps.installed().map((i) => i.name));
		for (const r of this.rows) r.installed = installed.has(r.skillId);
	}

	// -------------------------------------------------------------------------
	// 渲染
	// -------------------------------------------------------------------------

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const { row, topBorder, bottomBorder, divider, border, hint } = createBoxRenderer(th, innerW);
		const out: string[] = [];

		const favCount = this.rows.filter((r) => r.favorited).length;
		const installedCount = this.deps.installed().length;
		out.push(topBorder(` ${th.fg("dim", "技能市场")} `));

		// 搜索行：输入态显示光标与可编辑窗口
		const inputActive = this.mode === "input";
		const prefix = inputActive ? th.fg("accent", " / ") : th.fg("dim", " / ");
		const placeholder = th.fg("dim", this.query ? "" : "输入关键词检索（Enter 检索，Esc 关闭）");
		let line: string;
		if (inputActive) {
			const avail = Math.max(8, innerW - 4);
			const { display } = renderScrollingInput(this.query, this.cursor, avail, { inputOffset: 0 });
			line = `${prefix}${display}`;
		} else {
			line = `${prefix}${this.query ? th.fg("text", this.query) : ""}${placeholder}`;
		}
		out.push(row(truncateToWidth(` ${line}`, innerW, "…", true)));
		out.push(divider());

		// 确认态：整块换成确认内容
		if (this.mode === "confirm" && this.confirmState) {
			const st = this.confirmState;
			const verb = st.action === "install" ? "安装" : "卸载";
			out.push(row(truncateToWidth(` ${th.bold(th.fg("accent", `${verb}技能`))}  ${th.fg("dim", "|")}  ${st.row.name}`, innerW, "…", true)));
			out.push(row(""));
			for (const l of st.lines) out.push(row(truncateToWidth(`   ${l}`, innerW, "…", true)));
			out.push(row(""));
			out.push(hint(" Enter 确认 · Esc 返回"));
			out.push(bottomBorder());
			return out;
		}

		// 列表
		if (!this.rows.length) {
			out.push(row(""));
			out.push(row(truncateToWidth(`   ${th.fg("dim", this.searched ? "没有结果" : "还没有收藏或已装的技能")}`, innerW, "…", true)));
			out.push(row(truncateToWidth(`   ${th.fg("dim", "按 / 输入关键词去技能市场里找")}`, innerW, "…", true)));
			out.push(row(""));
		} else {
			const view = this.rows.slice(this.top, this.top + LIST_ROWS);
			view.forEach((r, i) => {
				const index = this.top + i;
				const focused = index === this.sel;
				out.push(row(this.rowLine(r, focused, innerW)));
			});
			for (let k = view.length; k < LIST_ROWS; k++) out.push(row(""));
		}

		// 选中项详情（描述 + 审计 + 文件数）——列表只放名字与来源，细节在这里给，
		// 既不挤占列表密度，也省得为了看一眼描述就按 Enter 进确认态
		for (const line of this.detailLines(innerW)) out.push(row(line));

		// 提示行与键位
		out.push(divider());
		if (this.note) out.push(hint(` ${this.busy ? "⏳" : "·"} ${this.note}`));
		const scroll = this.rows.length > LIST_ROWS ? ` · 共 ${this.rows.length} 项` : "";
		out.push(hint(` ↑↓ 选择${scroll} · Enter 安装/卸载 · f 收藏 · / 搜索 · r 刷新 · Esc 关闭`));
		out.push(hint(` 收藏 ${favCount} · 已装 ${installedCount}`));
		out.push(bottomBorder());
		return out;
	}

	/** 选中项详情：描述一行（超宽折行到两行）+ 审计与文件数一行 */
	private detailLines(innerW: number): string[] {
		const row = this.current();
		if (!row) return [];
		const th = this.theme;
		const key = `${row.source}/${row.skillId}`;
		const st = this.details.get(key);
		const label = (t: string) => th.fg("dim", t);
		const out: string[] = [];
		if (!st || st.kind === "loading") {
			out.push(` ${label("描述：")}${th.fg("dim", "读取中…")}`);
			return out;
		}
		if (st.kind === "failed") {
			out.push(` ${label("描述：")}${th.fg("warning", `读取失败（${st.message}）`)}`);
			return out;
		}
		// 描述：按可用宽度折行，最多两行，避免长描述把面板撑高
		const descWidth = Math.max(20, innerW - 8);
		const descText = st.description === null ? "（没取到描述，可能是网络或来源问题）" : st.description.trim() || "（SKILL.md 未声明 description）";
		const wrapped: string[] = [];
		let cur = "";
		for (const ch of descText) {
			if (visibleWidth(cur + ch) > descWidth) {
				wrapped.push(cur);
				cur = "";
				if (wrapped.length === 2) break;
			}
			cur += ch;
		}
		if (wrapped.length < 2 && cur) wrapped.push(cur);
		wrapped.forEach((l, i) => out.push(` ${i === 0 ? label("描述：") : "      "}${th.fg("text", l)}`));

		const auditText = st.audits.length
			? st.audits.map((a) => (/Pass$/.test(a) ? th.fg("success", a) : th.fg("warning", a))).join(th.fg("dim", " · "))
			: th.fg("dim", "无记录");
		out.push(` ${label("审计：")}${auditText}`);
		out.push(
			` ${label("规模：")}${th.fg("dim", `${st.files} 个文件 · 版本 ${st.ref}`)}${row.installed ? th.fg("success", " · 已装") : ""}${row.favorited ? th.fg("warning", " · 已收藏") : ""}`,
		);
		return out;
	}

	/** 单行：★ 名称  来源  安装量  [状态] */
	private rowLine(r: MarketRow, focused: boolean, innerW: number): string {
		const th = this.theme;
		const star = r.favorited ? th.fg("warning", "★") : " ";
		const cursor = focused ? th.fg("accent", " › ") : "   ";
		const nameText = focused ? th.fg("accent", th.bold(r.name)) : r.name;
		const sourceText = th.fg("dim", r.source);
		const tags: string[] = [];
		if (r.installed) tags.push(th.fg("success", "[已装]"));
		else if (r.favorited) tags.push(th.fg("warning", "[收藏]"));
		const installs = r.installs === undefined ? "" : `${formatInstalls(r.installs)}`;
		const tailParts = [installs ? th.fg("dim", installs.padStart(INSTALLS_W)) : " ".repeat(INSTALLS_W)];
		if (tags.length) tailParts.push(tags.join(" "));
		const tail = tailParts.join(" ");
		const headW = Math.max(8, innerW - visibleWidth(tail) - 4);
		const head = truncateToWidth(`${cursor}${star} ${nameText}  ${sourceText}`, headW, "…", true);
		const pad = Math.max(1, innerW - 1 - visibleWidth(head) - visibleWidth(tail));
		return ` ${head}${" ".repeat(pad)}${tail}`;
	}
}

/** 安装量：万级折算（与工具回执同一口径） */
function formatInstalls(n: number): string {
	if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")} 万`;
	return String(n);
}

/** 打开面板需要用到的 ctx 面（只依赖 custom，便于测试与降级） */
export interface PanelHost {
	ui: {
		custom: (
			factory: (tui: TUI, theme: Theme, kb: unknown, done: () => void) => Component,
			opts?: Record<string, unknown>,
		) => Promise<unknown>;
	};
}

/** 打开面板：overlay 居中偏宽，列表要横向空间放来源与安装量 */
export async function openSkillsPanel(ctx: PanelHost, deps: PanelDeps): Promise<void> {
	await ctx.ui.custom(
		(tui, theme, _kb, done) => new SkillsPanel(deps, theme, tui, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "76%", minWidth: 60, maxHeight: "86%", margin: { top: 1, bottom: 1 } },
		},
	);
}
