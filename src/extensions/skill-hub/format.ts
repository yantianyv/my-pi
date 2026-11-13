/**
 * skill-hub/format：回执文案（工具结果与命令输出共用，保证两处说法一致）
 *
 * 只写模型与用户需要判断的信息：来源、安装量、信任依据、文件构成、下一步怎么做。
 */
import type { FetchedSkill } from "./fetch";
import type { LedgerEntry } from "./install";
import type { AuditEntry, SkillHit } from "./registry";
import type { TrustVerdict } from "./trust";

/** 安装量：万级折算，其余原数（人一眼能比大小即可） */
export function formatInstalls(n: number): string {
	if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")} 万`;
	return String(n);
}

/**
 * 检索结果列表。传入的 hits 可带 `favorited`（人收藏过的）：那类排在最前，
 * 行首标 ★ 并注明「用户已收藏」——收藏是人的偏好，模型据此优先推荐。
 */
export function formatSearchResults(
	query: string,
	hits: (SkillHit & { favorited?: boolean })[],
	favCount = 0,
): string {
	if (!hits.length) {
		return `没有找到与「${query}」匹配的技能。换个更具体的词（如 pdf、code-review、react）再试，或直接用 skill_inspect 指定仓库。`;
	}
	const head = favCount
		? `「${query}」找到 ${hits.length} 个技能（★ 为用户收藏，${favCount} 个匹配，已置顶）：`
		: `「${query}」找到 ${hits.length} 个技能（按安装量排序）：`;
	const lines = [head, ""];
	hits.forEach((h, i) => {
		const star = h.favorited ? "★ " : "";
		const tag = h.favorited ? "　（用户已收藏）" : "";
		lines.push(`${i + 1}. ${star}${h.name}  —  ${formatInstalls(h.installs)} 次安装${tag}`);
		lines.push(`   来源 ${h.source}`);
	});
	lines.push("", "用 skill_inspect(source, skillId) 看内容与信任判定。");
	return lines.join("\n");
}

/** 审计徽章一行 */
export function formatAudits(audits: AuditEntry[]): string {
	if (!audits.length) return "审计：该技能在 skills.sh 上没有审计记录";
	return `审计：${audits.map((a) => `${a.name} ${a.verdict}`).join(" · ")}`;
}

/** 哪几家没通过、结论各是什么（门槛是全 Pass，差一家就不算过） */
export function formatAuditGap(audits: AuditEntry[]): string {
	const bad = audits.filter((a) => a.verdict !== "Pass");
	if (!bad.length) return "";
	return `审计未全过：${bad.map((a) => `${a.name} ${a.verdict}`).join("、")}（门槛是全 Pass）`;
}

/** 信任判定一行 */
export function formatTrust(v: TrustVerdict): string {
	const parts: string[] = [];
	if (v.byRepo) parts.push("来源在精选名单");
	if (v.byAudit) parts.push("审计全部通过");
	if (!parts.length) parts.push("来源与审计都不满足免确认条件");
	if (v.hasScripts) parts.push("自带可执行文件，安装时需要人工确认");
	if (v.oddFiles.length) parts.push(`含 ${v.oddFiles.length} 个非文档文件，安装时需要人工确认`);
	return `信任：${parts.join("；")}`;
}

/** 文件构成摘要：文件数 + 体积 + 带脚本时的脚本清单 */
export function formatFileSummary(entries: { path: string; size: number }[], hasScripts: boolean): string {
	const kb = Math.max(1, Math.round(entries.reduce((n, f) => n + f.size, 0) / 1024));
	const head = `文件：${entries.length} 个，约 ${kb} KB`;
	if (!hasScripts) return head;
	return `${head}（含可执行文件）`;
}

/** 预览回执：头部信息 + SKILL.md 正文 */
export function formatInspection(opts: {
	hit: { source: string; skillId: string; installs?: number };
	ref: string;
	dir: string;
	entries: { path: string; size: number }[];
	audits: AuditEntry[];
	trust: TrustVerdict;
	name: string;
	description: string;
	body: string;
	/** 人收藏过：在头部标出来，模型据此优先考虑 */
	favorited?: boolean;
}): string {
	const { hit, ref, dir, entries, audits, trust, name, description, body, favorited } = opts;
	const gap = formatAuditGap(audits);
	const lines = [
		`${favorited ? "★ " : ""}${name}  —  ${hit.source}${favorited ? "　（用户已收藏）" : ""}`,
		`描述：${description}`,
		`版本：${ref}　目录：${dir || "（仓库根）"}`,
		formatAudits(audits),
		...(gap ? [gap] : []),
		formatTrust(trust),
		formatFileSummary(entries, trust.hasScripts),
		"",
		"文件清单：",
		...entries.map((f) => `  ${f.path}（${Math.max(1, Math.round(f.size / 1024))} KB）`),
		"",
		"--- SKILL.md ---",
		body.trim(),
	];
	return lines.join("\n");
}

/** 安装回执 */
export function formatInstalled(entry: LedgerEntry, skill: FetchedSkill): string {
	const lines = [
		`已安装技能 ${entry.name}：${entry.path}`,
		`来源：${entry.source}@${entry.ref}　文件：${skill.files.size} 个`,
		"",
		"随后会自动重载加载该技能：若任务正在进行会先收尾本轮，重载后自动继续；生效后可用 /skill:" + entry.name + " 直接调用，模型也会按描述自动使用。",
	];
	if (skill.skipped.size) {
		const reasons = [...skill.skipped.entries()];
		lines.push("", `以下 ${reasons.length} 个文件未安装（技能主体仍可用）：`);
		for (const [file, why] of reasons.slice(0, 10)) lines.push(`  ${file}（${why}）`);
		if (reasons.length > 10) lines.push(`  …另有 ${reasons.length - 10} 个`);
	}
	return lines.join("\n");
}

/** 已装清单（命令用） */
export function formatInstalledList(items: { name: string; dir: string; entry: LedgerEntry }[]): string {
	if (!items.length) return "当前项目还没有用 skill_install 装过技能（手动放进 .pi/skills/ 的不在此列）。";
	const lines = [`插件装的技能（${items.length} 个）：`];
	for (const it of items) {
		const e = it.entry;
		lines.push(`  ${e.name}  —  ${e.source}@${e.ref}  —  ${e.dir || "（仓库根）"}  —  ${e.installedAt.slice(0, 10)}  —  ${e.files.length} 个文件`);
	}
	lines.push("", "卸载：/skill-hub remove <技能名>，或让 AI 用 skill_uninstall");
	return lines.join("\n");
}

/** 卸载回执 */
export function formatUninstalled(name: string, origin: string): string {
	return [
		`已卸载技能 ${name}（来源 ${origin}）`,
		"",
		"随后会自动重载刷新技能列表（若任务正在进行会先收尾本轮，重载后自动继续）。",
	].join("\n");
}
