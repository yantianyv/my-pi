/**
 * skill-hub/trust：安装前的信任判定（纯函数，便于单测）
 *
 * 两条并列判据，任一满足即免人工面板：
 *   1. 仓库在精选名单里（维护者明确、长期更新的来源）；
 *   2. skills.sh 上全部审计合作方（主通道五家：Gen Agent Trust Hub / Socket / Snyk / Runlayer / ZeroLeaks）
 *      **全部 Pass**——任一家 Warn 或 Fail 即不算通过。
 * 除此之外一律要人点一下。
 *
 * 技能自带可执行文件（脚本、二进制）时，无论来源多可信都强制要求人工确认：
 * 审计扫的是已知风险，模型读到 SKILL.md 后怎么调用这些脚本是审计看不到的。
 */
import { TRUSTED_REPOS, type AuditEntry } from "./registry";

/** 可执行/二进制扩展名：出现即视为「技能带脚本」 */
const EXECUTABLE_EXT = new Set([
	".sh",
	".bash",
	".zsh",
	".ps1",
	".bat",
	".cmd",
	".py",
	".js",
	".mjs",
	".cjs",
	".ts",
	".rb",
	".pl",
	".php",
	".go",
	".rs",
	".exe",
	".dll",
	".so",
	".dylib",
	".node",
	".jar",
	".wasm",
	".bin",
]);

/** 文档类扩展名：允许随技能装进项目（其余类型需要人工确认） */
const DOCUMENT_EXT = new Set([
	"",
	".md",
	".markdown",
	".txt",
	".json",
	".jsonl",
	".yaml",
	".yml",
	".toml",
	".csv",
	".tsv",
	".xml",
	".html",
	".css",
	".svg",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".pdf",
]);

export interface FileEntry {
	path: string;
	size: number;
}

export interface TrustVerdict {
	/** 免人工面板 */
	trusted: boolean;
	/** 判定依据（给回执与面板用，人话） */
	reasons: string[];
	/** 命中精选名单 */
	byRepo: boolean;
	/** 审计全 Pass */
	byAudit: boolean;
	/** 带可执行文件（强制人工确认） */
	hasScripts: boolean;
	/** 非文档类文件（强制人工确认） */
	oddFiles: string[];
	/** 总字节数 */
	bytes: number;
}

function extOf(p: string): string {
	const base = p.split("/").pop() ?? "";
	const i = base.lastIndexOf(".");
	return i <= 0 ? "" : base.slice(i).toLowerCase();
}

/** 来源仓库是否在精选名单（大小写不敏感） */
export function isTrustedRepo(source: string): boolean {
	const s = source.toLowerCase();
	return (TRUSTED_REPOS as readonly string[]).some((r) => r.toLowerCase() === s);
}

/**
 * 审计是否全 Pass：端点返回几家就判几家（当前五家），任一家非 Pass（Warn/Fail/Unknown）即不算通过。
 * 空结果同样算未通过（无审计记录不能当背书）。
 */
export function auditsPass(audits: AuditEntry[]): boolean {
	return audits.length > 0 && audits.every((a) => a.verdict === "Pass");
}

/** 汇总信任判定 */
export function judgeTrust(source: string, files: FileEntry[], audits: AuditEntry[]): TrustVerdict {
	const byRepo = isTrustedRepo(source);
	const byAudit = auditsPass(audits);
	const hasScripts = files.some((f) => EXECUTABLE_EXT.has(extOf(f.path)));
	const oddFiles = files.filter((f) => {
		const ext = extOf(f.path);
		return !EXECUTABLE_EXT.has(ext) && !DOCUMENT_EXT.has(ext);
	}).map((f) => f.path);
	const bytes = files.reduce((n, f) => n + f.size, 0);

	const reasons: string[] = [];
	if (byRepo) reasons.push("来源在精选名单");
	if (byAudit) reasons.push("审计全部通过");
	if (!byRepo && !byAudit) reasons.push("来源不在精选名单，审计未全部通过");
	if (hasScripts) reasons.push("技能自带可执行文件");
	if (oddFiles.length) reasons.push(`含 ${oddFiles.length} 个非文档文件`);

	return {
		trusted: (byRepo || byAudit) && !hasScripts && oddFiles.length === 0,
		reasons,
		byRepo,
		byAudit,
		hasScripts,
		oddFiles,
		bytes,
	};
}

/** 技能名合法性（Agent Skills 规范：小写字母数字与连字符，≤64 字符，首尾/连续连字符不允许） */
export function isValidSkillName(name: string): boolean {
	return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64;
}
