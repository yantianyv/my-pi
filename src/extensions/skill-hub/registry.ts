/**
 * skill-hub/registry：技能目录检索与来源解析（纯网络 + 纯数据，无 pi API）
 *
 * 两个索引源：
 * - skills.sh 检索 API（`/api/search?q=&limit=`）：给「按需求找技能」用，返回
 *   `{source: "owner/repo", skillId, installs}`；该站只索引登记过的仓库。
 * - jsDelivr 数据 API：给「拿文件清单 / 定位 SKILL.md / 逐文件取回」用。GitHub 直连在本机常不可达
 *   （git clone、api.github.com 均失败），jsDelivr 是可用通道；`@ref` 用仓库最新 tag，
 *   版本号大小写与 `@main` 的 404 问题都在这里统一抹平（实测某些仓库 `@main` 取文件 404，
 *   而按版本标签的 flat 清单能正常取）。
 *
 * 信任判定所需的审计徽章走 skills.sh 详情页 HTML（该站没有公开的审计 JSON 接口，
 * `/api/skill/...` 返回 401，只能解析页面里的 Security Audits 区块）。
 */
import { fetchJsonAny, fetchTextAny } from "../shared/http";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 精选来源：命中即免人工面板（审计徽章仍会照常展示，作为并列判据） */
export const TRUSTED_REPOS = [
	"anthropics/skills",
	"badlogic/pi-skills",
	"vercel-labs/agent-skills",
	"obra/superpowers",
	"mattpocock/skills",
] as const;

/** 审计徽章必须全部为 Pass 才算通过（Warn / Fail / 缺项都不算） */
/** 参考名单：网页兜底通道只会回这三家（JSON 端点还有 Runlayer / ZeroLeaks） */
export const AUDIT_NAMES = ["Gen Agent Trust Hub", "Socket", "Snyk"] as const;

/** 目录检索超时 */
const SEARCH_TIMEOUT_MS = 12_000;

export interface SkillHit {
	/** skills.sh 的稳定标识：owner/repo/skillId */
	id: string;
	/** 仓库：owner/repo */
	source: string;
	skillId: string;
	name: string;
	installs: number;
}

export interface AuditEntry {
	name: string;
	verdict: string;
	slug: string;
	/** 结论摘要（JSON 端点给，HTML 通道没有） */
	summary?: string;
	/** 风险等级（JSON 端点给） */
	riskLevel?: string;
}

export interface RepoRef {
	/** jsDelivr 上可用的版本标签（仓库最新 tag，取不到时回退 main） */
	ref: string;
	/** 仓库内技能目录（无前导斜杠，空串 = 仓库根） */
	dir: string;
	/** 该目录下的全部相对路径（不含前导斜杠） */
	files: { path: string; size: number }[];
}

interface JsdelivrFlat {
	files?: JsdelivrFile[];
}

// ---------------------------------------------------------------------------
// 目录检索
// ---------------------------------------------------------------------------

/** 在 skills.sh 检索技能（按安装量降序，过滤掉与查询无关的空结果） */
export async function searchSkills(query: string, limit = 12): Promise<SkillHit[]> {
	const url = `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${Math.max(1, Math.min(50, limit))}`;
	const data = await fetchJsonAny<{ skills?: unknown[]; error?: string }>(url, { timeoutMs: SEARCH_TIMEOUT_MS, totalBudgetMs: 20_000 });
	if (data.error) throw new Error(`技能目录暂时不可用：${data.error}`);
	return (data.skills ?? [])
		.map((raw): SkillHit | null => {
			const s = raw as Record<string, unknown>;
			const id = typeof s.id === "string" ? s.id : "";
			const source = typeof s.source === "string" ? s.source : "";
			const skillId = typeof s.skillId === "string" ? s.skillId : "";
			if (!id || !source || !skillId) return null;
			return {
				id,
				source,
				skillId,
				name: typeof s.name === "string" && s.name ? s.name : skillId,
				installs: typeof s.installs === "number" ? s.installs : 0,
			};
		})
		.filter((x): x is SkillHit => x !== null)
		.sort((a, b) => b.installs - a.installs);
}

/**
 * 从用户输入解析来源：支持 owner/repo、owner/repo/skillId、含 /tree/<ref>/ 的 GitHub 链接、
 * skills.sh 链接、git: 前缀。路径里多出来的层级（如 /tree/main/skills/foo）取最后一段作 skillId。
 */
export function parseSource(input: string): { source: string; skillId?: string } | null {
	let text = input.trim();
	if (!text) return null;
	text = text.replace(/^git:github\.com\//, "").replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
	text = text.replace(/^www\./, "");
	if (text.startsWith("skills.sh/")) text = text.slice("skills.sh/".length);
	text = text.replace(/\/\.git$/, "").replace(/\.git$/, "").split(/[?#]/)[0]!;
	const parts = text.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	const source = `${parts[0]}/${parts[1]}`;
	// 去掉 /tree/<ref> 之类的路径前缀，剩下的是仓库内路径
	const tail = parts.slice(2);
	const treeAt = tail.indexOf("tree");
	const rest = treeAt >= 0 ? tail.slice(treeAt + 2) : tail;
	const skillId = rest.length ? rest[rest.length - 1] : undefined;
	return { source, skillId };
}

// ---------------------------------------------------------------------------
// 审计结果
// ---------------------------------------------------------------------------

/**
 * 取某个技能的审计结果。
 *
 * 主通道是官方 JSON 端点 `GET /api/v1/skills/audit/{source}/{skill}`（无需鉴权，是唯一开放的 v1 端点）：
 * 返回全部五家合作方（Gen Agent Trust Hub / Socket / Snyk / Runlayer / ZeroLeaks），且带结论摘要、
 * 风险等级与审计时间：网页 HTML 只渲染其中三家，看不到 Runlayer / ZeroLeaks 的结论。
 *
 * 降级：端点 404（未收录/来源形态不符）或网络失败时，回退解析详情页 HTML 里的审计徽章
 * （三家 + 依赖 Tailwind class 的解析，只当兜底用）。
 */
export async function fetchAudits(source: string, skillId: string): Promise<AuditEntry[]> {
	return cached(`audit:${source}/${skillId}`, () => fetchAuditsUncached(source, skillId));
}

async function fetchAuditsUncached(source: string, skillId: string): Promise<AuditEntry[]> {
	try {
		const url = `https://skills.sh/api/v1/skills/audit/${source}/${skillId}`;
		const data = await fetchJsonAny<{ audits?: unknown[] }>(url, { timeoutMs: SEARCH_TIMEOUT_MS, totalBudgetMs: 12_000 });
		const entries = (data.audits ?? [])
			.map((raw): AuditEntry | null => {
				const a = raw as Record<string, unknown>;
				const name = typeof a.provider === "string" ? a.provider : "";
				const verdict = typeof a.status === "string" ? capitalize(a.status) : "";
				if (!name || !verdict) return null;
				return {
					slug: typeof a.slug === "string" ? a.slug : name.toLowerCase(),
					name,
					verdict,
					...(typeof a.summary === "string" && a.summary ? { summary: a.summary } : {}),
					...(typeof a.riskLevel === "string" && a.riskLevel ? { riskLevel: a.riskLevel } : {}),
				};
			})
			.filter((x): x is AuditEntry => x !== null);
		if (entries.length) return entries;
	} catch {
		/* 落到 HTML 兜底 */
	}
	return fetchAuditsFromPage(source, skillId);
}

/** 把端点里的 `pass`/`warn` 转成与网页徽章一致的 `Pass`/`Warn`。非字母值原样保留（判定方只认 Pass） */
function capitalize(s: string): string {
	const t = s.trim();
	return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/**
 * 降级通道：解析详情页 HTML 的 Security Audits 区块。
 * 页面路径不总是 /<owner>/<repo>/<skill>：来自站点直营来源的技能落在 /site/<domain>/<skill>，两种都试。
 */
async function fetchAuditsFromPage(source: string, skillId: string): Promise<AuditEntry[]> {
	const paths = [`https://skills.sh/${source}/${skillId}`, `https://skills.sh/site/${source}/${skillId}`];
	let html = "";
	let lastError: unknown;
	for (const url of paths) {
		try {
			html = await fetchTextAny(url, { timeoutMs: SEARCH_TIMEOUT_MS, totalBudgetMs: 12_000 });
			break;
		} catch (e) {
			lastError = e;
		}
	}
	if (!html) throw lastError instanceof Error ? lastError : new Error("审计页不可访问");
	const start = html.indexOf("Security Audits");
	if (start < 0) return [];
	const seg = html.slice(start, start + 6000);
	const out: AuditEntry[] = [];
	const re = /\/security\/([a-z0-9-]+)"[\s\S]{0,400}?truncate">([^<]*)<[\s\S]{0,200}?uppercase[^>]*>(Pass|Warn|Fail|Unknown)</g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(seg))) {
		out.push({ slug: m[1]!, name: decodeEntities(m[2]!.trim()), verdict: m[3]! });
	}
	return out;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'");
}

// ---------------------------------------------------------------------------
// jsDelivr：版本定位与文件清单
// ---------------------------------------------------------------------------

/**
 * 进程内短缓存：面板里逐个翻技能时，同一仓库的版本定位 / 文件清单 / 审计会被反复请求，
 * 而它们在这几分钟内不会变。只缓存成功结果，失败下次重试。
 */
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
	const value = await load();
	cache.set(key, { at: Date.now(), value });
	return value;
}

async function latestRef(source: string): Promise<string> {
	try {
		return await cached(`ref:${source}`, async () => {
			const meta = await fetchJsonAny<{ versions?: string[] }>(`https://data.jsdelivr.com/v1/package/gh/${source}`, {
				timeoutMs: SEARCH_TIMEOUT_MS,
				totalBudgetMs: 12_000,
			});
			return meta.versions?.[0] ?? "main";
		});
	} catch {
		return "main";
	}
}

/** jsDelivr 文件清单条目：flat 接口给「路径字符串列表」，非 flat 接口给「嵌套树」 */
type JsdelivrFile =
	| { name: string; size?: number }
	| { type: "file" | "directory"; name: string; size?: number; files?: JsdelivrFile[] };

/**
 * 把 jsDelivr 的两种清单形态统一成「仓库内相对路径（无前导斜杠）+ 字节数」。
 * flat 接口返回的 name 本身就是带前导斜杠的完整路径，树形态需要逐层拼接。
 */
function flatten(nodes: JsdelivrFile[], prefix = ""): { path: string; size: number }[] {
	const out: { path: string; size: number }[] = [];
	for (const n of nodes) {
		const isTree = "type" in n && (n as { type?: string }).type !== undefined;
		if (!isTree) {
			const name = (n as { name: string }).name;
			out.push({ path: name.replace(/^\/+/, ""), size: (n as { size?: number }).size ?? 0 });
			continue;
		}
		const tree = n as { type: "file" | "directory"; name: string; size?: number; files?: JsdelivrFile[] };
		const p = prefix ? `${prefix}/${tree.name}` : tree.name;
		if (tree.type === "directory") out.push(...flatten(tree.files ?? [], p));
		else out.push({ path: p, size: tree.size ?? 0 });
	}
	return out;
}

/**
 * SKILL.md 所在目录（空串 = 技能在仓库根）。仓库根的技能没有目录名可比，用仓库名当它的名字
 * （pi 也以 SKILL.md 的父目录名兜底），否则这类仓库会被误判成「没有名为 X 的技能」。
 */
export function pickSkillDir(files: { path: string }[], skillId: string, repoName = ""): string | undefined {
	const dirs = files
		.map((f) => f.path)
		.filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
		.map((p) => p.slice(0, Math.max(0, p.length - "/SKILL.md".length)));
	if (!dirs.length) return undefined;
	const exact = skillId
		? dirs.filter((d) => (d ? (d.split("/").pop() ?? "") : repoName) === skillId)
		: [];
	if (exact.length) return exact.sort((a, b) => a.length - b.length)[0];
	// 仓库里只有一个技能时不再挑：skills.sh 的 skillId 只是它自己的标注，目录才是事实
	if (dirs.length === 1) return dirs[0];
	return dirs.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
}

/** 技能名：目录名；技能在仓库根时用仓库名 */
export function skillNameOf(source: string, dir: string): string {
	return dir ? (dir.split("/").pop() ?? "") : (source.split("/").pop() ?? "");
}

/**
 * 定位某个技能：拿仓库最新版本标签 + SKILL.md 目录 + 该目录下全部文件。
 * skillId 缺省时按名字猜（目录名等于技能名）；猜不到时报错并给出可选的技能名清单。
 *
 * dir 统一为**无前导斜杠**的仓库内相对目录（空串 = 技能在仓库根）：jsDelivr 的文件清单不带前导斜杠，
 * 两套写法混用会让前缀匹配静默失效（取回零个文件）。
 */
export async function resolveSkill(source: string, skillId?: string): Promise<RepoRef> {
	const ref = await latestRef(source);
	const flat = await cached(`flat:${source}@${ref}`, () =>
		fetchJsonAny<JsdelivrFlat>(`https://data.jsdelivr.com/v1/package/gh/${source}@${ref}/flat`, {
			timeoutMs: SEARCH_TIMEOUT_MS,
			totalBudgetMs: 12_000,
		}),
	);
	const files = flatten(flat.files ?? []);
	if (!files.length) throw new Error(`仓库 ${source} 为空或不可访问`);
	const repoName = source.split("/")[1] ?? "";
	const dir = pickSkillDir(files, skillId ?? "", repoName);
	if (dir === undefined) throw new Error(`仓库 ${source} 里没有 SKILL.md`);
	if (skillId) {
		const dirs = files
			.map((f) => f.path)
			.filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
			.map((p) => p.slice(0, Math.max(0, p.length - "/SKILL.md".length)));
		const dirName = skillNameOf(source, dir);
		if (dirName !== skillId) {
			const names = dirs.map((d) => skillNameOf(source, d));
			throw new Error(`仓库 ${source} 里没有名为 ${skillId} 的技能。可选：${[...new Set(names)].join("、")}`);
		}
	}
	const prefix = dir ? `${dir}/` : "";
	const own = files.filter((f) => f.path.startsWith(prefix));
	if (!own.some((f) => f.path === `${prefix}SKILL.md`)) {
		throw new Error(`定位到目录 ${dir || "（仓库根）"} 但文件清单里没有 SKILL.md，仓库结构可能异常`);
	}
	return { ref, dir, files: own };
}

/**
 * jsDelivr 的两个接入点。主站对部分文件会 301 跳到 raw.githubusercontent（本机常不可达、或卡到超时），
 * gcore 直出同一份内容，一个接不到就换另一个。
 */
const CDN_HOSTS = ["https://cdn.jsdelivr.net/gh/", "https://gcore.jsdelivr.net/gh/"] as const;

/**
 * 取单个文件文本（jsDelivr 直达，路径相对仓库根）。
 * timeoutMs 按用途给：安装要拿全量文件，值得多等；面板预览只是看一眼，短超时失败即止。
 * 多节点共用一个总预算，避免「每个节点各等一次」把最坏耗时叠成节点数倍。
 */
export async function readRepoFile(source: string, ref: string, path: string, timeoutMs = 20_000): Promise<string> {
	const rel = path.replace(/^\/+/, "");
	const deadline = Date.now() + timeoutMs;
	const errors: string[] = [];
	for (const host of CDN_HOSTS) {
		const left = deadline - Date.now();
		if (left < 800) break;
		const budget = Math.min(left, Math.max(1200, Math.round(timeoutMs / 2)));
		try {
			return await fetchTextAny(`${host}${source}@${ref}/${rel}`, {
				timeoutMs: budget,
				totalBudgetMs: budget,
				maxBytes: 8 * 1024 * 1024,
			});
		} catch (e) {
			errors.push(`${new URL(host).host} ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	throw new Error(errors.length ? errors.join("；") : "取文件超时");
}
