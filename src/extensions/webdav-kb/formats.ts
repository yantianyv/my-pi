/**
 * webdav-kb 文本格式清单（单一事实来源）
 *
 * search.ts（索引）与 tools.ts（写入/导入校验）共用本文件，避免两份后缀清单漂移。
 * 四个集合语义不同，勿合并：
 * - TEXT_EXT：哪些后缀算「文本笔记」（允许写入 + 参与索引）
 * - DOC_EXT：哪些格式写入时强制 frontmatter
 * - FM_PARSE_EXT：哪些格式索引时尝试解析 frontmatter
 * - TABLE_EXT：哪些格式无 frontmatter 时取首行表头作标题
 */

/**
 * 参与索引 & 允许写入的纯文本后缀（其余跳过，避免二进制污染）。纯文本均可全文检索：
 * 文档（md/txt）、表格（csv/tsv，首行表头作标题加权）、结构化数据/配置（json/yaml/toml 等）、标记文档（html/xml）。
 */
export const TEXT_EXT = [
	".md", ".markdown", ".txt",
	".csv", ".tsv",
	".json", ".jsonl", ".yaml", ".yml", ".toml",
	".html", ".xml",
] as const;

/** 强制 frontmatter 的文档格式（md 是知识库原生格式，title/tags 是分类体系根基；表格/数据格式以文件名/表头为标题，不强制） */
export const DOC_EXT: ReadonlySet<string> = new Set([".md", ".markdown"]);

/**
 * 索引时尝试解析 frontmatter 的格式（txt 自由文本可有可无不强制，有则解析出 title/tags）。
 * 数据/配置格式不解析：yaml 允许以 `---` 文档标记开头，走 frontmatter 解析会把开头块误剥出正文。
 */
export const FM_PARSE_EXT: ReadonlySet<string> = new Set([".md", ".markdown", ".txt"]);

/** 表格类格式：无 frontmatter 时用首行表头作标题（加权，检索更精准） */
export const TABLE_EXT: ReadonlySet<string> = new Set([".csv", ".tsv"]);
