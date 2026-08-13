/**
 * hud-git：HUD git 状态模块 + 可视化 Git 面板
 *
 * 职责：
 *   1. 解析 `git status --porcelain=v1 --branch` 为结构化统计，供 HUD 行 1 渲染。
 *   2. 提供 `openGitPanel()`，在 TUI 中打开一个可视化 Git 面板，可预览详细状态并执行
 *      常用操作（stage / unstage / discard / commit / refresh）。
 *      提交直接在主页面完成：`g` AI 生成提交信息、`i` 手动输入（支持 ←→ 移动光标）、`c` 提交。
 *
 * 实现要点：
 *   - 子模块独立运行，不依赖 hud-core；缺失时 HUD 仅显示「⎇ 模块缺失」。
 *   - 所有 git 命令使用 `execFile` 直接调用，避免 shell 注入；路径作为独立参数传递。
 *   - git 输出路径默认按 core.quotePath 做 C-style 转义（中文/空格等特殊字符被引号+八进制
 *     包裹），解析时统一经 `gitUnquotePath` 解码后才用于显示与操作，否则删除/暂存会因假路径失败。
 *   - 面板使用 `ctx.ui.custom()` 的 overlay 渲染，内置 commit message 输入行。
 *   - AI 生成走 `completeSimple` 单次调用（复用 explore 的子模型选择策略），不占用主会话上下文。
 *   - 文件列表右侧通过 `git diff --numstat` 显示 +/-/binary 预览，不占用额外空间。
 *   - 操作失败时通过 `ctx.ui.notify` 反馈，成功后面板自动刷新并回调 `onRefresh` 更新 HUD。
 */
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth, parseKey } from "@earendil-works/pi-tui";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { editInput } from "../shared/ui";
import type { Message, Model } from "@earendil-works/pi-ai";
import { execFile } from "child_process";
import { promisify } from "util";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 8_000; // 普通 git 命令超时
const LONG_GIT_TIMEOUT_MS = 30_000; // push/pull/fetch 超时
const PANEL_MIN_WIDTH = 60; // 面板最小宽度

/** commit 输入区最多显示的行数（超出截断提示） */
const COMMIT_MAX_DISPLAY_LINES = 6;

// ---- AI 自动填写提交信息 ----

/** 优先选用的 AI 模型（provider/modelId），与 explore 子代理一致；都不可用时自动选最便宜已认证模型 */
const COMMIT_AI_MODELS: Array<[string, string]> = [["deepseek", "deepseek-v4-flash"]];
/** 喂给模型的暂存区 diff 最大字符数（超出截断） */
const COMMIT_DIFF_MAX_CHARS = 4_000;
/** AI 生成提交信息超时 */
const COMMIT_AI_TIMEOUT_MS = 30_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** HUD 行 1 所需的 git 统计摘要。 */
export interface GitStats {
	branch: string | null;
	staged: number; // 暂存区
	unstaged: number; // 工作区（已修改未暂存）
	untracked: number; // 未跟踪
	ahead: number; // 领先远程
	behind: number; // 落后远程
}

/** 单个文件的 git 状态。 */
export interface GitFileStatus {
	path: string; // 当前路径（重命名时为目标路径）
	xy: string; // 原始双字母状态码，如 " M" / "??" / "R "
	x: string; // index 状态
	y: string; // worktree 状态
	renamedFrom?: string; // 重命名来源路径
	category: "staged" | "unstaged" | "untracked";
}

/** 文件改动的行数预览。 */
export interface GitFileStat {
	added: number;
	removed: number;
	binary: boolean;
}

/** 详细 git 状态（面板数据）。 */
export interface GitDetailedStatus extends GitStats {
	items: GitFileStatus[];
	clean: boolean;
	numStats: Record<string, GitFileStat>;
}

// ---------------------------------------------------------------------------
// 底层 git 执行
// ---------------------------------------------------------------------------

/** 在 cwd 下执行 git 子命令，返回 stdout。 */
async function git(
	cwd: string,
	args: string[],
	timeout = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, {
		cwd,
		timeout,
		windowsHide: true,
	});
	return { stdout, stderr };
}

/** 检测 cwd 是否为 git 仓库。 */
export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await git(cwd, ["rev-parse", "--git-dir"]);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// git 路径引号转义解码
// ---------------------------------------------------------------------------

/**
 * 解码 git 的 C-style 路径转义（core.quotePath 默认开启，路径含非 ASCII / 空格 /
 * 引号等字符时整体被引号包裹、特殊字节转成 \ooo 八进制），返回真实文件名字符串。
 * 未加引号的路径原样返回。
 */
export function gitUnquotePath(raw: string): string {
	if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
	const body = raw.slice(1, -1);
	const bytes: number[] = [];
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (ch !== "\\") {
			bytes.push(ch.codePointAt(0)!);
			i++;
			continue;
		}
		const next = body[i + 1];
		if (next !== undefined && next >= "0" && next <= "7") {
			// 3 位八进制字节（非 ASCII 字符的 UTF-8 编码）
			bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
			i += 4;
		} else {
			const escapes: Record<string, number> = {
				a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92,
			};
			const code = next !== undefined ? escapes[next] : undefined;
			if (code !== undefined) {
				bytes.push(code);
				i += 2;
			} else {
				// 未知转义：保留反斜杠原样（git 不会输出，防御性兜底）
				bytes.push(92);
				i++;
			}
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/** 判断 s[i] 处的双引号是否为转义引号 `\"`（前面连续反斜杠个数为奇数）。 */
function isEscapedQuote(s: string, i: number): boolean {
	let backslashes = 0;
	for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
	return backslashes % 2 === 1;
}

/** 在「引号外」查找分隔符（如 status 的 ` -> ` / numstat 的 ` => `）位置，找不到返回 -1。git 输出中分隔符永远在引号包裹之外。 */
function findSeparatorOutsideQuotes(s: string, sep: string): number {
	let inQuote = false;
	for (let i = 0; i <= s.length - sep.length; i++) {
		if (s[i] === '"' && !isEscapedQuote(s, i)) {
			inQuote = !inQuote;
		} else if (!inQuote && s.startsWith(sep, i)) {
			return i;
		}
	}
	return -1;
}

// ---------------------------------------------------------------------------
// 状态解析
// ---------------------------------------------------------------------------

/** 解析 `git status --porcelain=v1 --branch` 输出为 HUD 摘要。 */
export function parseGitStatus(stdout: string): GitStats {
	const lines = stdout.split(/\r?\n/);
	const first = lines[0] ?? "";
	let branch: string | null = null;
	const branchM = first.match(/^## (.+?)(?:\.\.\.|$)/);
	if (branchM) {
		const raw = branchM[1];
		const noCommit = raw.match(/^(?:No commits yet|Initial commit) on (.+)$/);
		branch = noCommit ? noCommit[1] : raw === "HEAD (no branch)" ? "HEAD" : raw;
	}
	let staged = 0,
		unstaged = 0,
		untracked = 0;
	for (const line of lines.slice(1)) {
		if (!line) continue;
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked++;
			continue;
		}
		if (x !== " " && x !== "?") staged++;
		if (y !== " " && y !== "?") unstaged++;
	}
	const ahead = first.match(/ahead (\d+)/);
	const behind = first.match(/behind (\d+)/);
	return {
		branch,
		staged,
		unstaged,
		untracked,
		ahead: ahead ? Number(ahead[1]) : 0,
		behind: behind ? Number(behind[1]) : 0,
	};
}

/** 解析完整 git status 为面板数据。 */
export function parseDetailedGitStatus(stdout: string): Omit<GitDetailedStatus, "numStats"> {
	const stats = parseGitStatus(stdout);
	const items: GitFileStatus[] = [];
	const lines = stdout.split(/\r?\n/).slice(1);

	for (const line of lines) {
		if (!line) continue;
		const xy = line.slice(0, 2);
		const rest = line.slice(3);
		const x = xy[0];
		const y = xy[1];

		let path: string;
		let renamedFrom: string | undefined;
		const arrowIdx = findSeparatorOutsideQuotes(rest, " -> ");
		if (arrowIdx !== -1) {
			renamedFrom = gitUnquotePath(rest.slice(0, arrowIdx));
			path = gitUnquotePath(rest.slice(arrowIdx + 4));
		} else {
			path = gitUnquotePath(rest);
		}

		let category: GitFileStatus["category"];
		if (x === "?" && y === "?") {
			category = "untracked";
		} else if (x !== " " && x !== "?") {
			category = "staged";
		} else if (y !== " " && y !== "?") {
			category = "unstaged";
		} else {
			continue; // 忽略不应出现的行
		}

		items.push({ path, xy, x, y, renamedFrom, category });
	}

	return {
		...stats,
		items,
		clean: stats.staged === 0 && stats.unstaged === 0 && stats.untracked === 0,
	};
}

/** 解析 `git diff --numstat` 输出为路径 → 行数统计。 */
export function parseNumStats(stdout: string): Record<string, GitFileStat> {
	const result: Record<string, GitFileStat> = {};
	for (const line of stdout.split(/\r?\n/)) {
		if (!line) continue;
		const parts = line.split("\t");
		if (parts.length !== 3) continue;
		const [added, removed, path] = parts;
		if (!path) continue;
		const binary = added === "-" && removed === "-";
		// 重命名时 numstat 路径为 `old => new`（与 status 的 `old -> new` 不同），取目标路径
		const arrowIdx = findSeparatorOutsideQuotes(path, " => ");
		const realPath = arrowIdx !== -1 ? gitUnquotePath(path.slice(arrowIdx + 4)) : gitUnquotePath(path);
		result[realPath] = {
			added: binary ? 0 : Number(added) || 0,
			removed: binary ? 0 : Number(removed) || 0,
			binary,
		};
	}
	return result;
}

/** 获取当前目录详细 git 状态（含行数预览）。 */
export async function getDetailedGitStatus(
	cwd: string,
	timeout = GIT_TIMEOUT_MS,
): Promise<GitDetailedStatus | null> {
	try {
		const [{ stdout: statusOut }, { stdout: cachedOut }, { stdout: normalOut }] = await Promise.all([
			git(cwd, ["status", "--porcelain=v1", "--branch"], timeout),
			git(cwd, ["diff", "--cached", "--numstat"], timeout).catch(() => ({ stdout: "", stderr: "" })),
			git(cwd, ["diff", "--numstat"], timeout).catch(() => ({ stdout: "", stderr: "" })),
		]);

		const status = parseDetailedGitStatus(statusOut);
		const numStats: Record<string, GitFileStat> = {};
		for (const [path, stat] of Object.entries(parseNumStats(cachedOut))) numStats[path] = stat;
		for (const [path, stat] of Object.entries(parseNumStats(normalOut))) numStats[path] = stat;

		return { ...status, numStats };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// 常用 git 操作
// ---------------------------------------------------------------------------

/** Stage 指定文件（对 untracked 同样有效）。 */
export async function gitAdd(cwd: string, paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	await git(cwd, ["add", "--", ...paths]);
}

/** Unstage 指定文件。 */
export async function gitReset(cwd: string, paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	await git(cwd, ["reset", "HEAD", "--", ...paths]);
}

/** 丢弃工作区改动（unstaged）或同时丢弃暂存 + 工作区改动（staged）。 */
export async function gitDiscard(cwd: string, paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	await git(cwd, ["checkout", "HEAD", "--", ...paths]);
}

/** 删除未跟踪文件或目录（路径相对于 cwd；git 对未跟踪目录输出整目录条目，须递归删除）。 */
export async function gitRemoveUntracked(cwd: string, paths: string[]): Promise<void> {
	for (const p of paths) {
		await rm(resolve(cwd, p), { recursive: true, force: true });
	}
}

/** 提交已暂存文件。 */
export async function gitCommit(cwd: string, message: string): Promise<void> {
	const trimmed = message.trim();
	if (!trimmed) throw new Error("提交信息不能为空");
	await git(cwd, ["commit", "-m", trimmed]);
}

/** Push。 */
export async function gitPush(cwd: string, args: string[] = []): Promise<void> {
	await git(cwd, ["push", ...args], LONG_GIT_TIMEOUT_MS);
}

/** Pull。 */
export async function gitPull(cwd: string, args: string[] = []): Promise<void> {
	await git(cwd, ["pull", ...args], LONG_GIT_TIMEOUT_MS);
}

/** Fetch。 */
export async function gitFetch(cwd: string): Promise<void> {
	await git(cwd, ["fetch"], LONG_GIT_TIMEOUT_MS);
}

/** 列出本地分支。 */
export async function gitBranchList(cwd: string): Promise<string[]> {
	const { stdout } = await git(cwd, ["branch", "--format=%(refname:short)"]);
	return stdout
		.split(/\r?\n/)
		.map((b) => b.trim())
		.filter(Boolean);
}

/** 切换或创建分支。 */
export async function gitCheckout(cwd: string, branch: string, create = false): Promise<void> {
	const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
	await git(cwd, args);
}

// ---------------------------------------------------------------------------
// AI 自动填写提交信息
// ---------------------------------------------------------------------------

function pickCommitModel(ctx: ExtensionContext): AnyModel | undefined {
	const reg = ctx.modelRegistry;
	for (const [provider, modelId] of COMMIT_AI_MODELS) {
		const m = reg.find(provider, modelId);
		if (m && reg.hasConfiguredAuth(m)) return m;
	}
	// 兜底：已配置认证的模型里选 input+output 最便宜的
	let best: AnyModel | undefined;
	let bestCost = Infinity;
	for (const m of reg.getAvailable()) {
		if (!reg.hasConfiguredAuth(m)) continue;
		const c = (m.cost?.input ?? Infinity) + (m.cost?.output ?? Infinity);
		if (c < bestCost) {
			best = m;
			bestCost = c;
		}
	}
	return best;
}

/** 由 AI 根据暂存区改动（git diff --cached）生成提交信息。 */
export async function generateCommitMessage(ctx: ExtensionContext, cwd: string): Promise<string> {
	const { stdout: diff } = await git(cwd, ["diff", "--cached"], LONG_GIT_TIMEOUT_MS);
	if (!diff.trim()) throw new Error("暂存区没有改动");
	const truncated =
		diff.length > COMMIT_DIFF_MAX_CHARS ? diff.slice(0, COMMIT_DIFF_MAX_CHARS) + "\n…(diff 过长已截断)" : diff;

	const model = pickCommitModel(ctx);
	if (!model) throw new Error("找不到已认证的可用模型");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`认证失败：${auth.error}`);

	const systemPrompt = [
		"你是 git 提交信息助手，根据用户提供的暂存区 diff 生成一条简洁的提交信息。",
		"要求：",
		"1. 首行为标题，不超过 72 字符，遵循 conventional commits 格式：feat: / fix: / refactor: / chore: / docs: / test: / style: / perf: / build: / ci: / revert:",
		"2. 如需补充细节，标题下空一行，再列 2~3 条要点（每行以 - 开头）",
		"3. 正文语言跟随 diff 内容：diff 含中文则用中文，否则用英文",
		"4. 只输出提交信息本身，不要解释、不要引号、不要代码块围栏",
	].join("\n");

	const messages: Message[] = [
		{
			role: "user",
			content: `以下是暂存区改动（git diff --cached）：\n\n${truncated}`,
			timestamp: Date.now(),
		},
	];

	const result = await completeSimple(
		model,
		{ systemPrompt, messages },
		{
			apiKey: auth.apiKey,
			headers: { ...auth.headers },
			maxTokens: 300,
			temperature: 0.3,
			signal: AbortSignal.timeout(COMMIT_AI_TIMEOUT_MS),
		},
	);

	const text = result.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { type: "text"; text: string }).text)
		.join("\n")
		.trim();
	if (!text) throw new Error("AI 未返回内容");
	// 去掉可能的 markdown 代码块围栏
	return text.replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// 面板 UI
// ---------------------------------------------------------------------------

type PanelMode = "list" | "commit";

type Row =
	| { type: "header"; category: "staged" | "unstaged" | "untracked"; label: string; count: number }
	| { type: "file"; item: GitFileStatus };

class GitPanel {
	private ctx: ExtensionContext;
	private theme: Theme;
	private cwd: string;
	private onClose: () => void;
	private onRefresh: () => void;
	private requestRender: () => void;

	private status: GitDetailedStatus | null = null;
	private rows: Row[] = [];
	private selectedRow = 0;
	private mode: PanelMode = "list";
	private commitMsg = "";
	private cursor = 0; // 手动输入模式的光标位置（0..commitMsg.length）
	private busy = false;
	private busyText = "执行中…";
	private message = ""; // 底部提示/错误信息
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		ctx: ExtensionContext,
		theme: Theme,
		cwd: string,
		onClose: () => void,
		onRefresh: () => void,
		requestRender: () => void,
	) {
		this.ctx = ctx;
		this.theme = theme;
		this.cwd = cwd;
		this.onClose = onClose;
		this.onRefresh = onRefresh;
		this.requestRender = requestRender;
	}

	async init() {
		await this.refresh();
	}

	private async refresh() {
		this.status = await getDetailedGitStatus(this.cwd);
		this.buildRows();
		if (this.selectedRow >= this.rows.length) this.selectedRow = Math.max(0, this.rows.length - 1);
		this.invalidate();
		this.onRefresh();
	}

	private buildRows() {
		this.rows = [];
		if (!this.status || this.status.items.length === 0) return;

		const addCategory = (category: GitFileStatus["category"], label: string) => {
			const items = this.status!.items.filter((i) => i.category === category);
			if (items.length === 0) return;
			this.rows.push({ type: "header", category, label, count: items.length });
			for (const item of items) this.rows.push({ type: "file", item });
		};

		addCategory("staged", "已暂存");
		addCategory("unstaged", "工作区修改");
		addCategory("untracked", "未跟踪");
	}

	private getSelectedPaths(): { paths: string[]; category: GitFileStatus["category"] | null } {
		const row = this.rows[this.selectedRow];
		if (!row) return { paths: [], category: null };

		if (row.type === "file") return { paths: [row.item.path], category: row.item.category };

		const category = row.category;
		const paths = this.status?.items.filter((i) => i.category === category).map((i) => i.path) ?? [];
		return { paths, category };
	}

	private setBusy(value: boolean) {
		this.busy = value;
		this.invalidate();
		this.requestRender();
	}

	private async runOp(name: string, op: () => Promise<unknown>): Promise<boolean> {
		this.setBusy(true);
		this.message = "";
		try {
			await op();
			this.message = `${name} 成功`;
			await this.refresh();
			return true;
		} catch (err) {
			this.message = `${name} 失败：${err instanceof Error ? err.message : String(err)}`;
			return false;
		} finally {
			this.setBusy(false);
		}
	}

	private invalidate() {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.busy) return;

		// commit 输入模式
		if (this.mode === "commit") {
			this.handleCommitInput(data);
			return;
		}

		// 列表模式
		const key = parseKey(data) ?? data;
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p")) || key === "k" || key === "K") {
			this.moveSelection(-1);
		} else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n")) || key === "j" || key === "J") {
			this.moveSelection(1);
		} else if (key === "h" || key === "H") {
			this.moveToCategory(-1);
		} else if (key === "l" || key === "L") {
			this.moveToCategory(1);
		} else if (matchesKey(data, Key.home)) {
			this.selectedRow = 0;
			this.invalidate();
			this.requestRender();
		} else if (matchesKey(data, Key.end)) {
			this.selectedRow = Math.max(0, this.rows.length - 1);
			this.invalidate();
			this.requestRender();
		} else if (key === "a" || key === "A") {
			void this.stage();
		} else if (key === "u" || key === "U") {
			void this.unstage();
		} else if (key === "d" || key === "D") {
			void this.discard();
		} else if (key === "c" || key === "C") {
			void this.commit();
		} else if (key === "i" || key === "I") {
			this.startCommit();
		} else if (key === "g" || key === "G") {
			void this.aiGenerateCommit();
		} else if (key === "r" || key === "R") {
			void this.refresh();
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || key === "q" || key === "Q") {
			this.onClose();
		}
	}

	private moveSelection(delta: number) {
		const next = Math.max(0, Math.min(this.rows.length - 1, this.selectedRow + delta));
		if (next !== this.selectedRow) {
			this.selectedRow = next;
			this.invalidate();
			this.requestRender();
		}
	}

	/** 跳到上一个/下一个分类标题（h/l）。 */
	private moveToCategory(delta: number) {
		const current = this.selectedRow;
		let target = -1;
		if (delta > 0) {
			for (let i = current + 1; i < this.rows.length; i++) {
				if (this.rows[i].type === "header") {
					target = i;
					break;
				}
			}
		} else {
			for (let i = current - 1; i >= 0; i--) {
				if (this.rows[i].type === "header") {
					target = i;
					break;
				}
			}
		}
		if (target !== -1) {
			this.selectedRow = target;
			this.invalidate();
			this.requestRender();
		}
	}

	private async stage() {
		const { paths, category } = this.getSelectedPaths();
		if (category === "staged" || paths.length === 0) return;
		await this.runOp("暂存", () => gitAdd(this.cwd, paths));
	}

	private async unstage() {
		const { paths, category } = this.getSelectedPaths();
		if (category !== "staged" || paths.length === 0) return;
		await this.runOp("取消暂存", () => gitReset(this.cwd, paths));
	}

	private async discard() {
		const { paths, category } = this.getSelectedPaths();
		if (paths.length === 0) return;

		if (category === "untracked") {
			const ok = await this.ctx.ui.confirm(
				"删除未跟踪文件",
				`将永久删除 ${paths.length} 个未跟踪文件，确定吗？`,
			);
			if (!ok) return;
			await this.runOp("删除", () => gitRemoveUntracked(this.cwd, paths));
			return;
		}

		const ok = await this.ctx.ui.confirm(
			"丢弃改动",
			`将丢弃 ${paths.length} 个文件的改动，确定吗？`,
		);
		if (!ok) return;
		await this.runOp("丢弃", () => gitDiscard(this.cwd, paths));
	}

	/** 提交当前待提交信息（c 键直接提交；失败或无信息时给提示）。 */
	private async commit() {
		const msg = this.commitMsg.trim();
		if (!msg) {
			this.message = "提交信息为空：按 g 让 AI 生成，或按 i 手动输入";
			this.invalidate();
			this.requestRender();
			return;
		}
		await this.doCommit(msg);
	}

	private async doCommit(msg: string) {
		const staged = this.status?.items.filter((i) => i.category === "staged") ?? [];
		if (staged.length === 0) {
			this.message = "没有已暂存的文件，无法提交";
			this.invalidate();
			this.requestRender();
			return;
		}
		const ok = await this.runOp("提交", () => gitCommit(this.cwd, msg));
		if (ok) this.commitMsg = ""; // 提交成功后清空待提交信息
	}

	private startCommit() {
		const staged = this.status?.items.filter((i) => i.category === "staged") ?? [];
		if (staged.length === 0) {
			this.message = "没有已暂存的文件，无法提交";
			this.invalidate();
			this.requestRender();
			return;
		}
		this.mode = "commit";
		this.cursor = this.commitMsg.length; // 进入编辑时光标在末尾
		this.invalidate();
		this.requestRender();
	}

	private handleCommitInput(data: string) {
		const key = parseKey(data) ?? data;
		if (matchesKey(data, Key.escape)) {
			this.mode = "list"; // 退出编辑，保留已输入内容
			this.invalidate();
			this.requestRender();
			return;
		}
		if (key === "g" || key === "G") {
			void this.aiGenerateCommit();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const msg = this.commitMsg.trim();
			if (!msg) {
				this.message = "提交信息不能为空";
				this.invalidate();
				this.requestRender();
				return;
			}
			this.mode = "list";
			void this.doCommit(msg);
			return;
		}
		// 编辑键（left/right/home/end/backspace/delete/ctrl+u/可打印字符/粘贴）统一走 shared/ui editInput
		const r = editInput(this.commitMsg, this.cursor, data);
		if (r !== "skip") {
			this.commitMsg = r.text;
			this.cursor = r.cursor;
		}
		this.invalidate();
		this.requestRender();
	}

	private async aiGenerateCommit() {
		this.busyText = "AI 生成提交信息中…";
		this.setBusy(true);
		this.message = "";
		try {
			const msg = await generateCommitMessage(this.ctx, this.cwd);
			this.commitMsg = msg;
			this.cursor = msg.length;
			this.message = "AI 已生成，按 c 提交，或按 i 手动编辑";
		} catch (err) {
			this.message = `AI 生成失败：${err instanceof Error ? err.message : String(err)}`;
		}
		this.busyText = "执行中…";
		this.setBusy(false);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const innerW = Math.max(20, width - 2); // 预留左右边框
		const lines: string[] = [];

		// 顶部标题
		const branch = this.status?.branch ?? "-";
		const ahead = this.status?.ahead ?? 0;
		const behind = this.status?.behind ?? 0;
		const branchInfo = `⎇ ${branch}${ahead ? ` ↑${ahead}` : ""}${behind ? ` ↓${behind}` : ""}`;
		const title = th.fg("accent", th.bold(" Git 面板 ")) + th.fg("dim", `  ${branchInfo}`);
		lines.push(th.fg("border", "╭") + title + th.fg("border", "─".repeat(Math.max(0, width - visibleWidth(title) - 2)) + "╮"));

		// 文件列表
		if (!this.status) {
			lines.push(this.padLine(th.fg("warning", "  非 git 仓库或 git 不可用"), width));
		} else if (this.status.clean) {
			lines.push(this.padLine(th.fg("success", "  工作区干净 ✓"), width));
		} else {
			for (let i = 0; i < this.rows.length; i++) {
				lines.push(this.renderRow(this.rows[i], i === this.selectedRow, innerW, width));
			}
		}

		// 分隔线
		lines.push(th.fg("border", "├") + th.fg("border", "─".repeat(width - 2)) + th.fg("border", "┤"));

		// 输入/提示区
		if (this.mode === "commit") {
			// 把光标插入到文本中再分行显示，支持行内任意位置编辑
			const full = this.commitMsg.slice(0, this.cursor) + "_" + this.commitMsg.slice(this.cursor);
			const msgLines = full.split("\n");
			const showLines = msgLines.slice(0, COMMIT_MAX_DISPLAY_LINES);
			lines.push(this.padLine(th.fg("dim", "  提交信息:"), width));
			showLines.forEach((l) => lines.push(this.padLine(th.fg("text", `  ${l}`), width)));
			if (msgLines.length > COMMIT_MAX_DISPLAY_LINES) {
				lines.push(this.padLine(th.fg("dim", `  …(共 ${msgLines.length} 行，仅显示前 ${COMMIT_MAX_DISPLAY_LINES} 行)`), width));
			}
			lines.push(this.padLine(th.fg("dim", "  ←→ 移动光标 | [g] AI 生成 | [Enter] 提交 | [Esc] 退出"), width));
		} else {
			// 列表模式：显示待提交信息（如有）+ 操作提示
			if (this.commitMsg.trim()) {
				const firstLine = this.commitMsg.split("\n")[0];
				lines.push(this.padLine(th.fg("accent", `  待提交: ${truncateToWidth(firstLine, Math.max(8, innerW - 8), "…")}`), width));
			}
			for (const hint of this.buildHints()) {
				lines.push(this.padLine(th.fg("dim", hint), width));
			}
		}

		// 消息区
		if (this.message) {
			const color = this.message.includes("失败") ? "error" : this.message.includes("成功") ? "success" : "warning";
			lines.push(this.padLine(th.fg(color, `  ${this.message}`), width));
		} else {
			lines.push(this.padLine("", width));
		}

		// 忙碌提示
		if (this.busy) {
			lines.push(this.padLine(th.fg("accent", `  ${this.busyText}`), width));
		}

		// 底部边框
		lines.push(th.fg("border", "╰") + th.fg("border", "─".repeat(width - 2)) + th.fg("border", "╯"));

		// 截断每行到精确宽度
		const result = lines.map((l) => truncateToWidth(l, width));
		this.cachedWidth = width;
		this.cachedLines = result;
		return result;
	}

	private renderRow(row: Row, selected: boolean, innerW: number, width: number): string {
		const th = this.theme;
		let content = "";
		if (row.type === "header") {
			const color: "success" | "warning" | "muted" =
				row.category === "staged" ? "success" : row.category === "unstaged" ? "warning" : "muted";
			const icon = row.category === "staged" ? "+" : row.category === "unstaged" ? "~" : "?";
			const headerText = `${icon} ${row.label} (${row.count})`;
			content = selected ? th.inverse(th.fg(color, headerText)) : th.fg(color, headerText);
		} else {
			const item = row.item;
			const code = th.fg(this.statusColor(item), item.xy.padEnd(2));
			let pathText = item.path;
			if (item.renamedFrom) pathText = `${item.renamedFrom} → ${item.path}`;

			const prefix = `    ${code} `;
			const prefixWidth = visibleWidth(prefix);
			const stat = this.formatStat(item);
			const statWidth = stat ? visibleWidth(stat.text) + 1 : 0; // 与路径之间留 1 格空格
			const maxPathWidth = Math.max(4, innerW - prefixWidth - statWidth);
			const displayPath = truncateToWidth(pathText, maxPathWidth, "…");
			const line = `${prefix}${displayPath}`;
			const padding = " ".repeat(Math.max(0, innerW - visibleWidth(line) - (stat ? visibleWidth(stat.text) : 0)));
			const statText = stat ? th.fg(stat.color, stat.text) : "";
			content = selected ? th.inverse(th.fg("text", line)) + padding + statText : th.fg("text", line) + padding + statText;
		}
		return this.padLine(content, width);
	}

	private statusColor(item: GitFileStatus): "success" | "warning" | "muted" | "error" {
		if (item.category === "staged") return "success";
		if (item.category === "unstaged") return item.y === "D" ? "error" : "warning";
		return "muted";
	}

	private formatStat(item: GitFileStatus): { text: string; color: ThemeColor } | null {
		const stat = this.status?.numStats[item.path];
		if (!stat) {
			if (item.category === "untracked") return { text: "新文件", color: "muted" };
			return null;
		}
		if (stat.binary) return { text: "binary", color: "warning" };
		return { text: `+${stat.added}/-${stat.removed}`, color: "dim" };
	}

	private padLine(content: string, width: number): string {
		const th = this.theme;
		const pad = " ".repeat(Math.max(0, width - 2 - visibleWidth(content)));
		return th.fg("border", "│") + content + pad + th.fg("border", "│");
	}

	private buildHints(): string[] {
		const { category } = this.getSelectedPaths();
		const hints: string[] = [];

		hints.push(`  导航 [j/k]上下 [h/l]跳分类 [Home/End]首尾`);

		if (category === "staged") hints.push(`  文件 [u]取消暂存 [d]丢弃`);
		else if (category === "unstaged") hints.push(`  文件 [a]暂存 [d]丢弃`);
		else if (category === "untracked") hints.push(`  文件 [a]暂存 [d]删除`);
		else hints.push(`  文件 [a]暂存 [u]取消暂存 [d]丢弃`);

		hints.push(`  提交 [c]提交 [g]AI生成 [i]手动输入 ·  [r]刷新 [q]退出`);
		return hints;
	}
}

/** 打开 Git 面板。 */
export async function openGitPanel(ctx: ExtensionContext, onRefresh?: () => void): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("/git 仅在交互模式下可用", "warning");
		return;
	}

	const cwd = ctx.cwd;
	if (!(await isGitRepo(cwd))) {
		ctx.ui.notify("当前目录不是 git 仓库", "warning");
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			const panel = new GitPanel(
				ctx,
				theme,
				cwd,
				() => done(),
				() => onRefresh?.(),
				() => tui.requestRender(),
			);

			// 初始化时首次拉取状态
			void panel.init();

			return {
				render: (width) => panel.render(width),
				handleInput: (data) => panel.handleInput(data),
				invalidate: () => {},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "80%",
				minWidth: PANEL_MIN_WIDTH,
				maxHeight: "80%",
				margin: 2,
			},
		},
	);
}
