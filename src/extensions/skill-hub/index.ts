/**
 * skill-hub/index：按需找技能、看清内容、装进项目或卸掉
 *
 * 来源只走可达通道：GitHub 直连（clone / api / codeload）在本机经常被重置，因此
 * 索引走 skills.sh（检索 / 审计）、jsDelivr（版本定位 + 逐文件取回）；网络层复用
 * shared/http（直连 → 代理 → curl 逐通道降级，代理配置与 web-tool 同一份）。
 *
 * 三个工具的边界：
 *   skill_search    只读，找候选
 *   skill_inspect   只读，拿 SKILL.md 正文 + 文件清单 + 审计 + 信任判定
 *   skill_install   写项目内的插件私有目录，随后自动重载生效——先返回计划，人工确认后落地
 *   skill_uninstall 只删账本里记着的（= 插件自己装的），手动技能碰不到
 *
 * 重载调度：轮中不能 reload（旧运行时一失效，本轮后续扩展工具调用全部报 stale）；
 * followUp 排队 "/reload" 也不会生效（sendUserMessage 默认不派发命令，原文进对话）。
 * 打法是 steer 一条消息让模型立即收尾，等 agent_settled（安全边界）借内部命令走
 * ctx.reload()，重载后由新实例按 globalThis 标记自动续跑原任务。空闲入口直接派发命令。
 *
 * 存储独立于手动技能：`<cwd>/.pi/skill-hub/skills/<name>/`，由 `resources_discover` 注册给 pi
 * （pi 只扫 skills/ 目录，别处必须显式注册）。这样「AI 装的」与「人放的」不会混在一起，
 * 卸载也天然止步于自己那份账本。
 */
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isCodemodeCall } from "../shared/codemode";
import { removePath } from "../shared/fs-safe";
import { REVIEW_ALLOW, REVIEW_REJECT, askReview, reviewActions } from "../shared/review-panel";
import { clearStatusTimers, setStatusWithTTL, setWaiting } from "../shared/status";
import { errorMessage, toolError, toolText } from "../shared/tool-result";
import { favoriteKey, favoriteKeys, isFavorite, loadFavorites, toggleFavorite } from "./favorites";
import { fetchSkillFiles } from "./fetch";
import { openSkillsPanel, type PanelDeps } from "./panel";
import {
	formatAuditGap,
	formatFileSummary,
	formatInspection,
	formatInstalled,
	formatInstalledList,
	formatSearchResults,
	formatUninstalled,
} from "./format";
import { checkSkill, parseSkillMeta, type SkillCheck } from "./frontmatter";
import {
	forgetInstall,
	isManagedPath,
	listInstalled,
	type LedgerEntry,
	recordInstall,
	skillTarget,
	skillsRoot,
	writeSkillTree,
} from "./install";
import { fetchAudits, parseSource, resolveSkill, searchSkills, skillNameOf } from "./registry";
import { createReloadScheduler, type ReloadScheduler } from "./reload";
import { judgeTrust } from "./trust";

/** 状态键（已登记 hud-core 的 STATUS_STYLE） */
const STATUS_KEY = "skill-hub";

/** 面板里 SKILL.md 正文预览行数（完整正文进工具结果，面板只看开头） */
const PREVIEW_ROWS = 12;

/** skill_search 的结构化结果（codemode 脚本按字段筛选用，模型侧仍看文本） */
const SearchOutput = Type.Object({
	query: Type.String({ description: "检索词" }),
	hits: Type.Array(
		Type.Object({
			name: Type.String({ description: "技能名" }),
			source: Type.String({ description: "来源仓库 owner/repo" }),
			skillId: Type.String({ description: "仓库内技能目录名" }),
			installs: Type.Integer({ description: "安装量" }),
		}),
		{ description: "按安装量降序" },
	),
});

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", () => {
		clearStatusTimers();
	});

	const reloadScheduler = createReloadScheduler(pi);
	pi.on("agent_settled", (event) => reloadScheduler.settled(event.aborted));
	pi.on("session_start", (event) => reloadScheduler.sessionStarted(event.reason));
	const scheduleReload: ReloadSchedulerFn = (ctx, resume) => reloadScheduler.schedule(ctx, resume);

	// 把插件私有技能目录注册给 pi（pi 只扫 skills/ 与 .agents/skills/，别处必须显式声明）
	pi.on("resources_discover", (event) => {
		const root = skillsRoot(event.cwd);
		return fs.existsSync(root) ? { skillPaths: [root] } : {};
	});

	// -------------------------------------------------------------------------
	// skill_search
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "skill_search",
		annotations: { readOnlyHint: true },
		label: "搜索技能",
		description:
			"在技能目录（skills.sh）里按需求检索 agent 技能，返回名称、来源仓库与安装量。"
			+ "找到候选后用 skill_inspect 看内容与信任判定，再决定是否 skill_install。",
		promptSnippet: "搜索 agent 技能：skill_search(查询词[, limit]) → 名称+来源+安装量",
		parameters: Type.Object({
			query: Type.String({ description: "能力描述或关键词（如 pdf、code review、react testing）" }),
			limit: Type.Optional(Type.Integer({ description: "返回条数，默认 12，上限 50", minimum: 1, maximum: 50 })),
		}),
		promptGuidelines: ["本地已有技能够用时不要联网找；需要新能力时先用 skill_search 看有没有现成的。"],
		outputSchema: SearchOutput,
		async execute(_id, params, _signal, onUpdate, ctx) {
			push(ctx, "🔍 查技能");
			onUpdate?.({ content: [{ type: "text", text: `正在检索：${params.query}` }], details: {} });
			try {
				const hits = await searchSkills(params.query, params.limit ?? 12);
				// 收藏优先：匹配到的已收藏项置顶，且在回执里标明（收藏是人的偏好，模型据此优先推荐）
				const favKeys = favoriteKeys();
				const ranked = hits
					.map((h) => ({ ...h, favorited: favKeys.has(favoriteKey(h.source, h.skillId)) }))
					.sort((a, b) => Number(b.favorited) - Number(a.favorited) || b.installs - a.installs);
				const favCount = ranked.filter((h) => h.favorited).length;
				push(ctx, `✓ 找到 ${hits.length} 个`, 6000);
				return toolText(
					formatSearchResults(params.query, ranked, favCount),
					{ count: hits.length, favorites: favCount, hits: ranked },
					{
						query: params.query,
						hits: ranked.map((h) => ({ name: h.name, source: h.source, skillId: h.skillId, installs: h.installs })),
					},
				);
			} catch (e) {
				push(ctx, "⚠ 技能检索失败", 6000);
				return toolError(`技能检索失败：${errorMessage(e)}。可以直接给出仓库（如 anthropics/skills）改用 skill_inspect。`);
			}
		},
	});

	// -------------------------------------------------------------------------
	// skill_inspect
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "skill_inspect",
		annotations: { readOnlyHint: true },
		label: "查看技能",
		description:
			"取回技能的 SKILL.md 全文、文件清单与审计结论，判断是否值得装。source 支持 owner/repo、owner/repo/skillId 或 GitHub 链接。",
		promptSnippet: "查看技能内容与信任判定：skill_inspect(source[, skillId]) → SKILL.md 全文+文件清单+审计",
		parameters: Type.Object({
			source: Type.String({ description: "来源：owner/repo、owner/repo/skillId 或仓库链接" }),
			skillId: Type.Optional(Type.String({ description: "仓库里的技能目录名（source 已含时可省）" })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			push(ctx, "📖 读取技能");
			const parsed = parseSource(params.source);
			if (!parsed) return toolError(`看不懂这个来源：${params.source}。用 owner/repo 或 owner/repo/skillId 的形式。`);
			const skillId = params.skillId ?? parsed.skillId ?? "";
			try {
				onUpdate?.({ content: [{ type: "text", text: "正在解析仓库与文件清单" }], details: {} });
				const repo = await resolveSkill(parsed.source, skillId || undefined);
				const name = skillNameOf(parsed.source, repo.dir);
				const audits = await fetchAudits(parsed.source, name).catch(() => []);
				const trust = judgeTrust(parsed.source, repo.files, audits);
				const body = await fetchSkillFilesText(parsed.source, repo);
				const meta = parseSkillMeta(body);
				const check = checkSkill(name, meta);
				const favorited = isFavorite(parsed.source, name);
				const text = formatInspection({
					hit: { source: parsed.source, skillId: name },
					ref: repo.ref,
					dir: repo.dir,
					entries: repo.files,
					audits,
					trust,
					name,
					description: meta.description ?? "（SKILL.md 未声明 description）",
					body,
					favorited,
				});
				push(ctx, "✓ 已读取", 6000);
				const notes = [...check.blockers, ...check.warnings];
				return toolText(
					notes.length ? `${text}\n\n⚠ 规范提示：\n${notes.map((p) => `  · ${p}`).join("\n")}` : text,
					{ source: parsed.source, name, ref: repo.ref, trust, audits, blockers: check.blockers, warnings: check.warnings },
				);
			} catch (e) {
				push(ctx, "⚠ 读取失败", 6000);
				return toolError(`读取技能失败：${errorMessage(e)}`);
			}
		},
	});

	// -------------------------------------------------------------------------
	// skill_install
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "skill_install",
		annotations: { readOnlyHint: false },
		label: "安装技能",
		description:
			"把技能装进项目内的插件存储（.pi/skill-hub/skills/）并排队 /reload，装完可用 /skill:name 或由模型自动调用。"
			+ "首次调用只返回执行计划，人工确认后带 confirm=true 再调用才落地。",
		promptSnippet: "安装技能：skill_install(source[, skillId][, confirm]) → 计划 / 已安装",
		parameters: Type.Object({
			source: Type.String({ description: "来源：owner/repo、owner/repo/skillId 或仓库链接" }),
			skillId: Type.Optional(Type.String({ description: "仓库里的技能目录名" })),
			confirm: Type.Optional(Type.Boolean({ description: "人在对话里确认后传 true，才真正写盘" })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			if (isCodemodeCall(_id)) {
				return toolError("安装技能需要人确认，不能在 codemode 脚本里调用；请直接调用本工具。");
			}
			const parsed = parseSource(params.source);
			if (!parsed) return toolError(`看不懂这个来源：${params.source}。用 owner/repo 或 owner/repo/skillId 的形式。`);
			const skillId = params.skillId ?? parsed.skillId ?? "";

			push(ctx, "📦 准备安装");
			let prepared: Prepared;
			try {
				prepared = await prepare(parsed.source, skillId, ctx.cwd);
			} catch (e) {
				push(ctx, "⚠ 准备失败", 6000);
				return toolError(`安装前检查失败：${errorMessage(e)}`);
			}
			const { name, repo, audits, trust, check, targetDir } = prepared;

			if (check.blockers.length) {
				push(ctx, "⚠ 技能不合规", 6000);
				return toolError(`这个技能装进去 pi 会加载不了：\n${check.blockers.map((p) => `  · ${p}`).join("\n")}`);
			}
			if (fs.existsSync(targetDir)) {
				push(ctx, "⚠ 已存在同名技能", 6000);
				return toolError(`目标目录已存在：${targetDir}。先用 skill_uninstall 卸掉旧的，或换一个技能。`);
			}

			const gap = formatAuditGap(audits);
			const plan = [
				`准备安装技能 ${name}`,
				`来源：${parsed.source}@${repo.ref}　目录：${repo.dir || "（仓库根）"}`,
				`目标：${targetDir}`,
				formatFileSummary(repo.files, trust.hasScripts),
				`信任依据：${trust.reasons.join("；")}`,
				`审计：${audits.length ? audits.map((a) => `${a.name} ${a.verdict}`).join(" · ") : "无记录"}`,
				...(gap ? [gap] : []),
				...check.warnings.map((w) => `规范提示：${w}`),
				"",
				"文件清单：",
				...repo.files.map((f) => `  ${f.path}（${Math.max(1, Math.round(f.size / 1024))} KB）`),
			];

			if (!params.confirm) {
				push(ctx, "⏸ 等待确认", 60_000);
				return toolText([...plan, "", "确认安装请带 confirm=true 再调用一次；放弃则不用再调用。"].join("\n"), {
					status: "planned",
					name,
					source: parsed.source,
					ref: repo.ref,
					targetDir,
					trust,
				});
			}

			if (!trust.trusted) {
				const outcome = await confirmWithPanel(ctx, {
					name,
					source: parsed.source,
					ref: repo.ref,
					targetDir,
					trust,
					audits,
					files: repo.files,
					body: prepared.body,
				});
				if (outcome === "no-ui") {
					push(ctx, "⚠ 无界面无法确认", 6000);
					return toolError(`未安装 ${name}：这个技能需要人工确认，而当前会话没有界面（print/RPC 等）弹不出确认面板。请在交互式会话里重试。`);
				}
				if (outcome !== "allowed") {
					push(ctx, "✋ 已取消安装", 6000);
					return toolText(`未安装 ${name}：人工确认未通过。`, { status: "cancelled", name });
				}
			}

			onUpdate?.({ content: [{ type: "text", text: "正在取回文件" }], details: {} });
			const done = await performInstall(ctx, prepared, scheduleReload, (t) =>
				onUpdate?.({ content: [{ type: "text", text: t }], details: {} }),
			);
			if (!done.ok) {
				push(ctx, "⚠ 安装失败", 6000);
				return toolError(done.message);
			}
			push(ctx, `✓ 已安装 ${name}`, 6000);
			return toolText(done.message, { status: "installed", entry: done.entry });
		},
	});

	// -------------------------------------------------------------------------
	// skill_uninstall
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "skill_uninstall",
		annotations: { readOnlyHint: false },
		label: "卸载技能",
		description:
			"卸载由 skill_install 装进项目的技能（删除目录并清账本）。手动放进 .pi/skills/ 的技能不在账本里，不会被这里删到。",
		promptSnippet: "卸载插件装的技能：skill_uninstall(技能名[, confirm]) → 计划 / 已卸载",
		parameters: Type.Object({
			name: Type.String({ description: "已装技能名（skill_install 时装进去的名字）" }),
			confirm: Type.Optional(Type.Boolean({ description: "人在对话里确认后传 true，才真正删除" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (isCodemodeCall(_id)) {
				return toolError("卸载技能需要人确认，不能在 codemode 脚本里调用；请直接调用本工具。");
			}
			const hit = listInstalled(ctx.cwd).find((i) => i.name === params.name);
			if (!hit) {
				const known = listInstalled(ctx.cwd).map((i) => i.name);
				return toolError(
					known.length
						? `没有名为 ${params.name} 的已装技能。当前装了：${known.join("、")}`
						: "这个项目还没有用 skill_install 装过技能（手动放进 .pi/skills/ 的请自己删）。",
				);
			}
			if (!isManagedPath(ctx.cwd, hit.dir)) {
				return toolError(`路径不在插件存储内，拒绝删除：${hit.dir}`);
			}

			const origin = `${hit.entry.source}@${hit.entry.ref}`;
			if (!params.confirm) {
				push(ctx, "⏸ 等待确认卸载", 60_000);
				return toolText(
					[
						`准备卸载技能 ${hit.name}`,
						`来源：${origin}　装于 ${hit.entry.installedAt.slice(0, 10)}`,
						`目录：${hit.dir}（${hit.entry.files.length} 个文件）`,
						"",
						"确认卸载请带 confirm=true 再调用一次；放弃则不用再调用。",
					].join("\n"),
					{ status: "planned", name: hit.name, dir: hit.dir },
				);
			}

			const outcome = await confirmPanelForUninstall(ctx, hit.name, hit.dir, origin);
			if (outcome === "no-ui") {
				push(ctx, "⚠ 无界面无法确认", 6000);
				return toolError(`未卸载 ${hit.name}：卸载需要确认，而当前会话没有界面（print/RPC 等）弹不出确认面板。`);
			}
			if (outcome !== "allowed") {
				push(ctx, "✋ 已取消卸载", 6000);
				return toolText(`未卸载 ${hit.name}：人工确认未通过。`, { status: "cancelled", name: hit.name });
			}

			forgetInstall(ctx.cwd, hit.dir);
			const ok = removePath(hit.dir);
			if (!ok) {
				push(ctx, "⚠ 卸载失败", 6000);
				return toolError(`删除目录失败：${hit.dir}（账本记录已清，可手动删除该目录）`);
			}
			scheduleReload(ctx, "技能列表已重载刷新，请继续刚才的任务。");
			push(ctx, `✓ 已卸载 ${hit.name}`, 6000);
			return toolText(formatUninstalled(hit.name, origin), { status: "uninstalled", name: hit.name });
		},
	});

	// -------------------------------------------------------------------------
	// /skill-hub 命令
	// -------------------------------------------------------------------------

	pi.registerCommand("skill-hub", {
		description: "技能市场：无参开面板，list 看已装 / remove 卸载 / fav 收藏",
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
			// 内部子命令：装/卸技能后的重载入口（只有命令上下文拿得到 ctx.reload()）
			if (sub === "__reload") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("正在运行中，本轮结束后再重载", "warning");
					return;
				}
				await ctx.reload();
				return;
			}
			if (!sub) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`${formatInstalledList(listInstalled(ctx.cwd))}\n\n（面板需要界面；非交互会话用 list / remove）`, "info");
					return;
				}
				setWaiting("技能市场面板");
				reloadScheduler.panelOpened();
				try {
					await openSkillsPanel(ctx as unknown as Parameters<typeof openSkillsPanel>[0], panelDeps(pi, ctx, scheduleReload));
				} finally {
					reloadScheduler.panelClosed(ctx);
					setWaiting(null);
				}
				return;
			}
			if (sub === "list") {
				const favorites = loadFavorites();
				ctx.ui.notify(
					[
						formatInstalledList(listInstalled(ctx.cwd)),
						"",
						favorites.length
							? `收藏的技能（${favorites.length} 个）：\n${favorites.map((f) => `  ★ ${f.name}  —  ${f.source}`).join("\n")}`
							: "还没有收藏任何技能（面板里按 f 收藏）。",
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "remove") {
				const name = rest[0];
				if (!name) {
					ctx.ui.notify("用法：/skill-hub remove <技能名>", "warning");
					return;
				}
				await removeByCommand(name, ctx, scheduleReload);
				return;
			}
			if (sub === "fav" || sub === "favorite") {
				const parsed = parseSource(rest.join(" "));
				if (!parsed?.skillId) {
					ctx.ui.notify("用法：/skill-hub fav <owner/repo/skillId>", "warning");
					return;
				}
				const on = toggleFavorite(parsed.source, parsed.skillId, parsed.skillId);
				ctx.ui.notify(on ? `已收藏 ${parsed.source}/${parsed.skillId}` : `已取消收藏 ${parsed.source}/${parsed.skillId}`, "info");
				return;
			}
			ctx.ui.notify(
				[
					"/skill-hub                   打开技能市场面板（搜索 / 收藏 / 安装 / 卸载）",
					"/skill-hub list              文本列出已装与收藏（非交互场景用）",
					"/skill-hub remove <技能名>   卸载已装技能",
					"/skill-hub fav <owner/repo/skill>  收藏或取消收藏",
				].join("\n"),
				"info",
			);
		},
	});
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/**
 * 面板依赖：把工具侧同一套「准备 → 确认 → 落盘」能力交给面板调用。
 * 面板内的确认视图替代 review 面板（人在那里按 Enter 就是确认）。
 */
function panelDeps(pi: ExtensionAPI, ctx: ExtensionContext, scheduleReload: ReloadSchedulerFn): PanelDeps {
	return {
		favorites: () => loadFavorites(),
		installed: () =>
			listInstalled(ctx.cwd).map((i) => ({ name: i.name, dir: i.dir, source: i.entry.source, ref: i.entry.ref })),
		search: (query) => searchSkills(query, 20),
		describe: async (row) => {
			const repo = await resolveSkill(row.source, row.skillId);
			const name = skillNameOf(row.source, repo.dir);
			// 审计与描述各自兜底：其中一个取不到不该让整块详情变成「读取失败」
			const audits = await fetchAudits(row.source, name).catch(() => []);
			const trust = judgeTrust(row.source, repo.files, audits);
			// 预览用短超时：面板里等 20 秒不如先给审计与规模，描述留空（两个 CDN 节点分这 5 秒）
			const description = await fetchSkillFilesText(row.source, repo, 5000)
				.then((text) => parseSkillMeta(text).description ?? "")
				.catch(() => null);
			return {
				files: repo.files.map((f) => f.path),
				audits: audits.map((a) => `${a.name} ${a.verdict}`),
				trust: trust.reasons,
				target: skillTarget(ctx.cwd, name),
				description,
				ref: repo.ref,
			};
		},
		install: async (row, progress) => {
			let prepared: Prepared;
			try {
				prepared = await prepare(row.source, row.skillId, ctx.cwd);
			} catch (e) {
				return { ok: false, message: `安装前检查失败：${errorMessage(e)}` };
			}
			if (prepared.check.blockers.length) return { ok: false, message: `技能无法加载：${prepared.check.blockers.join("；")}` };
			if (fs.existsSync(prepared.targetDir)) return { ok: false, message: `目标目录已存在：${prepared.targetDir}` };
			const done = await performInstall(ctx, prepared, scheduleReload, progress);
			if (done.ok) push(ctx, `✓ 已安装 ${prepared.name}`, 6000);
			return { ok: done.ok, message: done.message };
		},
		uninstall: async (name) => {
			const done = performUninstall(ctx, name, scheduleReload);
			if (done.ok) push(ctx, `✓ 已卸载 ${name}`, 6000);
			return done;
		},
		toggleFavorite: (row) => toggleFavorite(row.source, row.skillId, row.name),
	};
}

/** 推状态（失败静默：状态只是展示，不该影响功能） */
function push(ctx: ExtensionContext, text: string, ttlMs = 30_000): void {
	try {
		setStatusWithTTL(ctx, STATUS_KEY, text, ttlMs);
	} catch {
		/* 旧 ctx 已失效 */
	}
}

interface Prepared {
	name: string;
	source: string;
	repo: Awaited<ReturnType<typeof resolveSkill>>;
	audits: Awaited<ReturnType<typeof fetchAudits>>;
	trust: ReturnType<typeof judgeTrust>;
	check: SkillCheck;
	targetDir: string;
	body: string;
}

/** 安装前检查：定位技能、取审计、判定信任、校验规范、算目标路径（不写盘） */
async function prepare(source: string, skillId: string, cwd: string): Promise<Prepared> {
	const repo = await resolveSkill(source, skillId || undefined);
	const name = skillNameOf(source, repo.dir);
	const audits = await fetchAudits(source, name).catch(() => []);
	const trust = judgeTrust(source, repo.files, audits);
	const body = await fetchSkillFilesText(source, repo);
	const check = checkSkill(name, parseSkillMeta(body));
	return { name, source, repo, audits, trust, check, targetDir: skillTarget(cwd, name), body };
}

interface InstallOutcome {
	ok: boolean;
	message: string;
	entry?: LedgerEntry;
}

type ReloadSchedulerFn = ReloadScheduler["schedule"];

/**
 * 执行安装（工具与面板共用）：取回文件 → 原子写盘 → 记账 → 调度重载。
 * 调用方负责前置检查与人工确认（工具用 review 面板，市场面板用面板内的确认视图）。
 */
async function performInstall(
	ctx: ExtensionContext,
	prepared: Prepared,
	schedule: ReloadSchedulerFn,
	progress?: (text: string) => void,
): Promise<InstallOutcome> {
	const { name, repo } = prepared;
	const targetDir = prepared.targetDir;
	try {
		progress?.(`正在取回 ${repo.files.length} 个文件`);
		const skill = await fetchSkillFiles(prepared.source, repo.ref, repo.dir, repo.files);
		writeSkillTree(targetDir, skill.files);
		const entry = recordInstall(ctx.cwd, skill, name, targetDir);
		schedule(ctx, "技能已加载完成，请继续刚才的任务。");
		return { ok: true, message: formatInstalled(entry, skill), entry };
	} catch (e) {
		return { ok: false, message: `安装失败：${errorMessage(e)}（已写入的部分已清理）` };
	}
}

/** 执行卸载（面板共用）：先删账本再删目录，删不掉时如实报告 */
function performUninstall(
	ctx: ExtensionContext,
	name: string,
	schedule: ReloadSchedulerFn,
): { ok: boolean; message: string } {
	const hit = listInstalled(ctx.cwd).find((i) => i.name === name);
	if (!hit) return { ok: false, message: `没有名为 ${name} 的已装技能` };
	if (!isManagedPath(ctx.cwd, hit.dir)) return { ok: false, message: `路径不在插件存储内，拒绝删除：${hit.dir}` };
	const origin = `${hit.entry.source}@${hit.entry.ref}`;
	forgetInstall(ctx.cwd, hit.dir);
	if (!removePath(hit.dir)) return { ok: false, message: `删除目录失败：${hit.dir}（账本记录已清，可手动删除）` };
	schedule(ctx, null);
	return { ok: true, message: formatUninstalled(name, origin) };
}

/** 只取 SKILL.md 正文（预览/校验用，不下载整棵目录） */
async function fetchSkillFilesText(
	source: string,
	repo: Awaited<ReturnType<typeof resolveSkill>>,
	timeoutMs?: number,
): Promise<string> {
	const repoPath = repo.dir ? `${repo.dir}/SKILL.md` : "SKILL.md";
	const { readRepoFile } = await import("./registry");
	return readRepoFile(source, repo.ref, repoPath, timeoutMs);
}

/** 安装确认面板（严格模式：没有界面就不装） */
async function confirmWithPanel(
	ctx: ExtensionContext,
	info: {
		name: string;
		source: string;
		ref: string;
		targetDir: string;
		trust: ReturnType<typeof judgeTrust>;
		audits: { name: string; verdict: string }[];
		files: { path: string; size: number }[];
		body: string;
	},
): Promise<string> {
	if (!ctx.hasUI) return "no-ui";
	setWaiting(`等待确认安装技能 ${info.name}`);
	try {
		const preview = info.body.split("\n").slice(0, PREVIEW_ROWS);
		const outcome = await askReview(ctx as unknown as { hasUI: boolean; ui: ExtensionUIContext }, {
			title: "技能安装",
			verb: "安装技能",
			object: info.name,
			sections: [
				{
					kind: "kv",
					label: "来源",
					items: [
						["仓库", `${info.source}@${info.ref}`],
						["目标", info.targetDir],
						["审计", info.audits.length ? info.audits.map((a) => `${a.name} ${a.verdict}`).join(" · ") : "无记录"],
					],
				},
				{ kind: "list", label: "文件", items: info.files.map((f) => f.path) },
				{ kind: "text", label: "判定", items: info.trust.reasons },
				{ kind: "text", label: "SKILL.md 开头", items: preview },
			],
			impact: [
				"技能是给模型的指令，会引导它执行命令与读写文件",
				"装在项目内 .pi/skill-hub/ 下，可用 /skill-hub remove 或 skill_uninstall 卸掉",
			],
			actions: reviewActions(false),
		});
		return outcome.kind === "allowed" ? REVIEW_ALLOW : REVIEW_REJECT;
	} finally {
		setWaiting(null);
	}
}

/** 卸载确认面板 */
async function confirmPanelForUninstall(
	ctx: ExtensionContext,
	name: string,
	dir: string,
	origin: string,
): Promise<string> {
	if (!ctx.hasUI) return "no-ui";
	setWaiting(`等待确认卸载技能 ${name}`);
	try {
		const outcome = await askReview(ctx as unknown as { hasUI: boolean; ui: ExtensionUIContext }, {
			title: "技能卸载",
			verb: "卸载技能",
			object: name,
			sections: [
				{ kind: "kv", label: "位置", items: [["目录", dir], ["来源", origin]] },
			],
			impact: ["目录会被删除（手改过的内容一并丢失）", "卸载后本轮继续可用，/reload 后消失"],
			actions: reviewActions(false),
		});
		return outcome.kind === "allowed" ? REVIEW_ALLOW : REVIEW_REJECT;
	} finally {
		setWaiting(null);
	}
}

/** 命令侧卸载：面板确认后删目录与账本（与工具同一套判定） */
async function removeByCommand(
	name: string,
	ctx: ExtensionContext,
	scheduleReload: ReloadSchedulerFn,
): Promise<void> {
	const hit = listInstalled(ctx.cwd).find((i) => i.name === name);
	if (!hit) {
		ctx.ui.notify(`插件没有装过名为 ${name} 的技能（手动放进 .pi/skills/ 的请自己删）`, "warning");
		return;
	}
	if (!isManagedPath(ctx.cwd, hit.dir)) {
		ctx.ui.notify(`路径不在插件存储内，拒绝删除：${hit.dir}`, "error");
		return;
	}
	const origin = `${hit.entry.source}@${hit.entry.ref}`;
	const outcome = await confirmPanelForUninstall(ctx, hit.name, hit.dir, origin);
	if (outcome !== "allowed") {
		ctx.ui.notify("已取消", "info");
		return;
	}
	forgetInstall(ctx.cwd, hit.dir);
	const ok = removePath(hit.dir);
	ctx.ui.notify(ok ? `已删除 ${hit.dir}，重载后生效` : `删除失败：${hit.dir}`, ok ? "info" : "error");
	// notify 先于重载派发：重载会使本 ctx 失效
	if (ok) scheduleReload(ctx, null);
}
