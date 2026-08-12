/**
 * webdav-kb / search.ts — 本地全文检索（中文 bigram + 英文分词 + BM25）
 *
 * 零依赖零向量：索引构建在本地镜像上（毫秒级、离线可用）。中文用滑动窗口
 * 双字（bigram）切词（"知识库检索" → 知识/识库/库检/检索），英文按字母数字
 * 词切分；BM25(k1=1.5, b=0.75) 排序，标题词加权重（tf 翻倍）。
 *
 * 增量策略（跟随同步）：索引持久化到镜像根 .kb-index.json；refresh() 时按
 * 文件 mtime 与索引内 updatedMs 比对——只重读变更文件，新增/删除同样处理。
 * 与 sync.ts 零耦合：sync 只管文件落地，search 看到的是最新镜像。
 *
 * 检索结果含 路径/标题/tags/分数/命中片段（片段取首个命中词 ± 窗口，即时读
 * 文件生成，不占索引体积）。vault/ 加密目录由 crypto 层（0.4）在 refresh 时
 * 注入明文副本索引，此处不感知。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FM_PARSE_EXT, TABLE_EXT, TEXT_EXT } from "./formats";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 命中片段窗口（命中词前后各留多少字符） */
const SNIPPET_RADIUS = 100;
/** 默认返回结果条数 */
const DEFAULT_LIMIT = 8;
/** 参与索引的文件后缀（清单一处维护，见 formats.ts） */
const INDEXED_EXT: ReadonlySet<string> = new Set(TEXT_EXT);
/** 表头作标题时的最大长度（超长表头截断，防单行撑爆索引） */
const HEADER_TITLE_MAX = 200;
/** 标题词权重（计入 tf 时翻的倍数） */
const TITLE_WEIGHT = 2;

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/** 切词：英文单词 + 中文 bigram（滑动窗口双字）。返回 term 数组（可重复） */
export function tokenize(text: string): string[] {
	const terms: string[] = [];
	// 英文/数字词（含大小写归一）
	for (const m of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) terms.push(m);
	// 中文 bigram：从连续 CJK 段内按双字滑动
	for (const run of text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []) {
		if (run.length >= 2) {
			for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
		} else {
			terms.push(run); // 单字段（罕见）按单字进索引，保证能命中
		}
	}
	return terms;
}

// ---------------------------------------------------------------------------
// frontmatter 解析
// ---------------------------------------------------------------------------

export interface NoteMeta {
	title: string;
	tags: string[];
	/** 正文（不含 frontmatter） */
	body: string;
}

/** 解析 md 的 YAML frontmatter（--- 起止块）：title / tags 支持字符串与数组 */
export function parseFrontmatter(raw: string): NoteMeta {
	let title = "";
	const tags: string[] = [];
	let body = raw;
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (m) {
		body = raw.slice(m[0].length);
		for (const line of m[1].split(/\r?\n/)) {
			const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
			if (!kv) continue;
			const key = kv[1].toLowerCase();
			const val = kv[2].trim();
			if (key === "title") {
				title = val.replace(/^["']|["']$/g, "");
			} else if (key === "tags") {
				// [a, b] 或 "a, b" 或 a, b
				const list = val.replace(/^\[|\]$/g, "").split(",");
				for (const t of list) {
					const tt = t.trim().replace(/^["']|["']$/g, "");
					if (tt) tags.push(tt);
				}
			}
		}
	}
	return { title, tags, body };
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

interface IndexedDoc {
	path: string;
	title: string;
	tags: string[];
	/** 词数（BM25 的 dl） */
	len: number;
	/** term → tf */
	terms: Record<string, number>;
	updatedMs: number;
}

export interface SearchResult {
	path: string;
	title: string;
	tags: string[];
	score: number;
	/** 命中片段（含命中上下文） */
	snippet: string;
	updatedMs: number;
}

const INDEX_VERSION = 1;
/** 节流窗口（ms）：search 连续调用时窗口内复用上次索引扫描，避免每次全扫镜像 */
const REFRESH_THROTTLE_MS = 3_000;
/** 命中词数加权系数（多词查询：命中词越多排序越前，改善召回排序质量） */
const HIT_BONUS = 0.5;

export class NoteIndex {
	constructor(private readonly mirrorDir: string) {
		this.cacheFile = path.join(mirrorDir, ".kb-index.json");
		this.docs = new Map<string, IndexedDoc>();
	}

	private readonly cacheFile: string;
	private docs: Map<string, IndexedDoc>;
	/** 最近一次 search 触发的 refresh 时间（节流用） */
	private lastRefreshMs = 0;
	/** vault 解密钩子（crypto 层注入）：接收明文相对路径（/vault/x.md），返回明文内容或 null */
	private decryptor: ((relPath: string) => string | null) | null = null;

	/** 注册 vault 解密钩子（由扩展组装时注入 vaultReadNote；未解锁时返回 null → 跳过加密区） */
	setDecryptor(fn: (relPath: string) => string | null): void {
		this.decryptor = fn;
	}

	/** 增量刷新：扫描镜像，按 mtime 比对，重读变更文件；删除消失文件 */
	refresh(): void {
		this.docs = this.loadCache();
		const seen = new Set<string>();
		const walk = (dir: string, relPrefix: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				if (ent.name.startsWith(".kb-") || ent.name.includes(".conflict-")) continue;
				const rel = `${relPrefix}/${ent.name}`;
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) {
					if (rel.startsWith("/lfs") || rel === "/.history" || rel.startsWith("/.history/")) continue; // LFS/历史副本区不索引
					walk(full, rel);
					continue;
				}
				// vault 密文（.enc）：有解密钩子则解密后按明文路径建索引（仅内存，不落缓存）
				if (ent.name.endsWith(".enc") && rel.startsWith("/vault/") && this.decryptor) {
					const plain = rel.slice(0, -".enc".length);
					seen.add(plain);
					let st: fs.Stats;
					try {
						st = fs.statSync(full);
					} catch {
						continue;
					}
					const prev = this.docs.get(plain);
					if (prev && prev.updatedMs === st.mtimeMs) continue;
					let text: string | null = null;
					try {
						text = this.decryptor(plain); // 未解锁时抛错 → 视为 null，跳过加密区（与设计语义一致）
					} catch {
						text = null;
					}
					if (text !== null) this.docs.set(plain, this.buildDoc(plain, text, st.mtimeMs));
					continue;
				}
				const ext = path.extname(ent.name).toLowerCase();
				if (!INDEXED_EXT.has(ext)) continue;
				seen.add(rel);
				let st: fs.Stats;
				try {
					st = fs.statSync(full);
				} catch {
					continue;
				}
				const prev = this.docs.get(rel);
				if (prev && prev.updatedMs === st.mtimeMs) continue; // 未变
				const raw = fs.readFileSync(full, "utf8");
				this.docs.set(rel, this.buildDoc(rel, raw, st.mtimeMs));
			}
		};
		walk(this.mirrorDir, "");
		// 删除消失文件
		for (const p of [...this.docs.keys()]) {
			if (!seen.has(p)) this.docs.delete(p);
		}
		this.saveCache();
	}

	private buildDoc(rel: string, raw: string, mtimeMs: number): IndexedDoc {
		const ext = path.extname(rel).toLowerCase();
		// frontmatter 只按格式解析：yaml 等数据格式允许以 --- 文档标记开头，盲解析会把开头块误剥出正文
		const meta = FM_PARSE_EXT.has(ext) ? parseFrontmatter(raw) : { title: "", tags: [] as string[], body: raw };
		let title = meta.title;
		const tags = meta.tags;
		const body = meta.body;
		// 表格类：无 frontmatter 时用首行表头作标题（检索加权；对 csv/tsv 表头即列名，命中列名比命中文件名更有意义）
		if (!title && TABLE_EXT.has(ext)) {
			const head = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
			if (head) title = head.slice(0, HEADER_TITLE_MAX);
		}
		const terms = tokenize(`${title} ${title} ${tags.join(" ")} ${body}`);
		const tf: Record<string, number> = {};
		let len = 0;
		for (const t of terms) {
			len++;
			tf[t] = (tf[t] ?? 0) + 1;
		}
		// 标题词权重翻倍（title 重复计了两次，再按权重补）
		for (const t of tokenize(`${title} ${tags.join(" ")}`)) {
			tf[t] = (tf[t] ?? 0) + TITLE_WEIGHT;
			len += TITLE_WEIGHT;
		}
		return {
			path: rel,
			title: title || rel.split("/").pop()?.replace(/\.[^.]+$/, "") || rel,
			tags,
			len,
			terms: tf,
			updatedMs: mtimeMs,
		};
	}

	// ---- 持久化 ----

	private loadCache(): Map<string, IndexedDoc> {
		try {
			const d = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")) as {
				version?: number;
				docs?: IndexedDoc[];
			};
			if (d.version === INDEX_VERSION && Array.isArray(d.docs)) {
				return new Map(d.docs.map((doc) => [doc.path, doc]));
			}
		} catch {
			/* 缓存缺失/损坏 → 全量重建 */
		}
		return new Map();
	}

	private saveCache(): void {
		try {
			const tmp = this.cacheFile + ".tmp";
			// vault 文档只存内存不落盘：词频会泄露明文信息，解锁状态也不该持久化
			const docs = [...this.docs.values()].filter((d) => !d.path.startsWith("/vault/"));
			fs.writeFileSync(
				tmp,
				JSON.stringify({ version: INDEX_VERSION, docs }, null, 0) + "\n",
				"utf8",
			);
			fs.renameSync(tmp, this.cacheFile);
		} catch {
			/* 写索引缓存失败静默（下次重建） */
		}
	}

	// ---- 检索 ----

	/** BM25 检索（自动 refresh 增量索引；连续调用节流）。opts.namespace 可限定前缀（如 "/notes"） */
	search(query: string, opts: { limit?: number; namespace?: string } = {}): SearchResult[] {
		// 节流：窗口内复用上次扫描（镜像在本机，全扫约几十 ms，无需每次搜索都跑）
		const now = Date.now();
		if (!this.lastRefreshMs || now - this.lastRefreshMs >= REFRESH_THROTTLE_MS) {
			this.lastRefreshMs = now;
			this.refresh();
		}
		const qTerms = tokenize(query);
		if (qTerms.length === 0) return [];
		const limit = opts.limit ?? DEFAULT_LIMIT;
		const namespace = opts.namespace;

		const N = this.docs.size;
		if (N === 0) return [];
		// 文档频率
		const df = new Map<string, number>();
		for (const doc of this.docs.values()) {
			for (const t of new Set(Object.keys(doc.terms))) df.set(t, (df.get(t) ?? 0) + 1);
		}
		// 平均长度
		let totalLen = 0;
		for (const doc of this.docs.values()) totalLen += doc.len;
		const avgdl = totalLen / N;

		const scored: { doc: IndexedDoc; score: number }[] = [];
		for (const doc of this.docs.values()) {
			if (namespace && !doc.path.startsWith(namespace)) continue;
			let score = 0;
			let hits = 0;
			for (const t of qTerms) {
				const tf = doc.terms[t];
				if (!tf) continue;
				hits++;
				const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
				score += idf * ((tf * (1.5 + 1)) / (tf + 1.5 * (1 - 0.75 + 0.75 * (doc.len / avgdl))));
			}
			if (score > 0) scored.push({ doc, score: score + hits * HIT_BONUS });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map(({ doc, score }) => ({
			path: doc.path,
			title: doc.title,
			tags: doc.tags,
			score: Math.round(score * 1000) / 1000,
			snippet: this.snippet(doc, qTerms),
			updatedMs: doc.updatedMs,
		}));
	}

	/** 生成命中片段：取首个命中词位置 ± 半径窗口；正文无命中（仅标题命中）取开头 */
	private snippet(doc: IndexedDoc, qTerms: string[]): string {
		let body: string | null = null;
		if (doc.path.startsWith("/vault/") && this.decryptor) {
			try {
				body = this.decryptor(doc.path); // vault 明文在内存，从解密钩子取；未解锁抛错 → 无 snippet
			} catch {
				body = null;
			}
		} else {
			body = readLocal(this.mirrorDir, doc.path);
		}
		const norm = (body ?? "").replace(/\s+/g, " ").trim();
		// 优先找命中词（按词长降序，长词更精准）
		const sorted = [...new Set(qTerms)].sort((a, b) => b.length - a.length);
		for (const t of sorted) {
			const idx = norm.indexOf(t);
			if (idx >= 0) {
				const start = Math.max(0, idx - SNIPPET_RADIUS);
				const end = Math.min(norm.length, idx + t.length + SNIPPET_RADIUS);
				return `${start > 0 ? "…" : ""}${norm.slice(start, end)}${end < norm.length ? "…" : ""}`;
			}
		}
		return norm.slice(0, SNIPPET_RADIUS * 2) + (norm.length > SNIPPET_RADIUS * 2 ? "…" : "");
	}

	/** 笔记总数（refresh 后有效） */
	get size(): number {
		return this.docs.size;
	}

	/** 全部文档路径（refresh 后有效；供列表/统计用） */
	paths(): string[] {
		return [...this.docs.keys()];
	}
}

/** 读本地镜像文件（utf8；不存在返回 null） */
function readLocal(mirrorDir: string, rel: string): string | null {
	const segs = rel.split("/").filter((s) => s.length > 0);
	const abs = path.join(mirrorDir, ...segs);
	if (!abs.startsWith(path.resolve(mirrorDir))) return null;
	try {
		return fs.readFileSync(abs, "utf8");
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// 便捷入口：单例索引（工具/面板共用，进程内只建一次）
// ---------------------------------------------------------------------------

const instances = new Map<string, NoteIndex>();

/** 获取镜像对应的索引实例（缓存） */
export function getIndex(mirrorDir: string): NoteIndex {
	let idx = instances.get(mirrorDir);
	if (!idx) {
		idx = new NoteIndex(mirrorDir);
		instances.set(mirrorDir, idx);
	}
	return idx;
}
