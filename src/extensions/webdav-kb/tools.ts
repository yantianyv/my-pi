/**
 * webdav-kb / tools.ts — AI 工具集（kb_help / kb_search / kb_read / kb_write / kb_append / kb_list）
 *
 * 零注入 pull 式：所有工具按需调用，AI 首次使用前经 kb_help 读取使用守则
 * （守则本体 = 网盘根 PROTOCOL.md，跨设备同步、用户可迭代；缺失时回退内嵌版）。
 *
 * 设计约束：
 * - 写入前查重：kb_write 对已存在文件要求显式 overwrite:true（协议约束的硬落地）
 * - 命名空间白名单：/notes /references /scratch /vault（/memory 已废弃），防 AI 写乱库
 * - vault 透明：/vault/ 下自动加解密（见 crypto.ts），其余命名空间明文
 * - 结果限长：读全文截断、列表限条数、搜索限条数——保护上下文
 * - 未配置时给出明确引导（/kb-config 设置 WebDAV）
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { setStatusWithTTL } from "../shared/status";
import { loadConfig, isConfigured, defaultMirrorDir, agentConfigDir } from "./store";
import { readNote, readNoteBytes, listNotes, ensureRemoteDirs, loadLedger, saveLedger, syncAll } from "./sync";
import { getIndex } from "./search";
import { vaultPutNote, vaultReadNote, isUnlocked, isVaultPath, encryptPath, decryptPath } from "./crypto";
import { DEFAULT_PROTOCOL } from "./protocol";
import { WebDavClient, DavError } from "./client";
import {
	isLfsPath,
	getLfsFiles,
	touchLfsCache,
	formatSize,
	loadLfsCache,
	isLfsCacheFresh,
} from "./lfs";
import { mirrorPath } from "./store";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 写入允许的顶层命名空间（/memory 已废弃：知识库只存知识，不承担记忆功能） */
const ALLOWED_NAMESPACES = ["/notes", "/references", "/scratch", "/vault"] as const;
/** 写入允许的文件后缀 */
const VALID_EXT = [".md", ".markdown", ".txt"] as const;
/** kb_read 全文上限（超出截断并提示） */
const READ_MAX_CHARS = 30_000;
/** kb_list 返回上限（防超大目录撑爆上下文） */
const LIST_MAX = 400;
/** 搜索默认/上限条数 */
const SEARCH_LIMIT = 8;
const SEARCH_LIMIT_MAX = 20;
/** 搜索片段最大长度（结果里再加说明） */
const SNIPPET_MAX = 240;
/** md 文本最大字节数（防伪装上传大文件；正常笔记远小于此，专指异常场景） */
const MD_MAX_BYTES = 50 * 1024 * 1024;
/** LFS 单文件最大字节数（超过需 force 强制；force 参数不在工具说明中显示，仅警告揭示） */
const LFS_MAX_BYTES = 1024 * 1024 * 1024;
/** kb_lslfs 返回条数上限 */
const LFS_LIST_MAX = 200;

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

function mirrorOf(): string {
	const cfg = loadConfig(agentConfigDir());
	return cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
}

/** 工具通用前置：未配置时返回引导文本（返回 null 表示可用） */
function notConfiguredHint(): string | null {
	const cfg = loadConfig(agentConfigDir());
	if (!isConfigured(cfg)) {
		return "知识库未配置：请先运行 /kb-config 设置 WebDAV 地址与账号，然后 /kb-sync 完成首次同步。";
	}
	return null;
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

export function registerKbTools(pi: ExtensionAPI): void {
	// ---------- kb_help ----------
	pi.registerTool({
		name: "kb_help",
		label: "知识库使用守则",
		description:
			"知识库（WebDAV 云网盘）的使用守则：命名空间、写入规范、检索策略。"
			+ "首次使用任何 kb_* 工具前必须先调用本工具读守则，之后按守则执行。"
			+ "topic 可指定关注点（写入/检索/命名空间），不传返回完整守则。",
		promptSnippet: "知识库使用守则：kb_help() → 协议全文（首次使用 kb_* 前必读）",
		parameters: Type.Object({
			topic: Type.Optional(
				Type.String({ description: "关注的守则主题（写入/检索/命名空间 等），不传返回完整守则" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const mirror = mirrorOf();
			const proto = readNote(mirror, "/PROTOCOL.md");
			let content = proto ?? DEFAULT_PROTOCOL;
			const topic = params.topic?.trim();
			if (topic) {
				// 按主题筛选段落（简单切块：按 ## 分节）
				const sections = content.split(/(?=^## )/m);
				const matched = sections.filter((s) => s.includes(topic));
				if (matched.length > 0) content = matched.join("\n\n") + "\n\n（完整守则可用 kb_help 查看）";
			}
			status(ctx, "kb-help", "📖", 6_000);
			return text(content, {});
		},
	});

	// ---------- kb_search ----------
	pi.registerTool({
		name: "kb_search",
		label: "检索知识库",
		description:
			"本地全文检索知识库（中文 bigram + 英文分词，BM25 排序），返回 路径/标题/命中片段/分数。"
			+ "命中后按需 kb_read 读全文。namespace 可限定（/notes /references /scratch /vault）。"
			+ "vault 未解锁时加密区内容不可见。",
		promptSnippet: "检索知识库：kb_search(查询词[, limit][, namespace]) → 片段列表",
		parameters: Type.Object({
			query: Type.String({ description: "检索词（中文/英文均可，多个词用空格分隔）" }),
			limit: Type.Optional(
				Type.Integer({ description: `返回条数，默认 ${SEARCH_LIMIT}，上限 ${SEARCH_LIMIT_MAX}` }),
			),
			namespace: Type.Optional(
				Type.String({ description: "限定命名空间前缀，如 /notes 或 /references" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			if (params.namespace && params.namespace.startsWith("/lfs")) {
				return text(`/lfs/（LFS 大文件区）不参与检索。请用 kb_lslfs 查看文件列表、kb_download 按需下载。`, {});
			}
			const mirror = mirrorOf();
			const idx = getIndex(mirror);
			const limit = Math.min(params.limit ?? SEARCH_LIMIT, SEARCH_LIMIT_MAX);
			try {
				const results = idx.search(params.query, { limit, namespace: params.namespace });
				status(ctx, "kb-search", `🔍 ${results.length} 条`, 6_000);
				if (results.length === 0) {
					return text(
						`知识库未找到与「${params.query}」相关的内容。\n`
							+ `可尝试：更短的关键词、换说法、或 kb_list 浏览现有目录。不要编造笔记内容。`,
						{ results: 0 },
					);
				}
				const lines: string[] = [`🔍 ${results.length} 条结果（按相关度排序）：`];
				results.forEach((r, i) => {
					const tag = r.tags.length > 0 ? `  [${r.tags.slice(0, 3).join(", ")}]` : "";
					lines.push(`${i + 1}. ${r.path}  (score ${r.score})${tag}`);
					const snip = r.snippet.length > SNIPPET_MAX ? r.snippet.slice(0, SNIPPET_MAX) + "…" : r.snippet;
					lines.push(`   ${snip.replace(/\n/g, " ")}`);
				});
				lines.push(`\n命中后用 kb_read 读全文。`);
				return text(lines.join("\n"), { results: results.length });
			} catch (e) {
				return text(`检索失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
		},
	});

	// ---------- kb_read ----------
	pi.registerTool({
		name: "kb_read",
		label: "读取笔记",
		description:
			`读取笔记全文（相对路径，如 /notes/分类/webdav.md；vault 下自动解密）。`
			+ `单次上限 ${READ_MAX_CHARS} 字符，长文件用 offset 续读（每次传上次的 offset + ${READ_MAX_CHARS}）。`
			+ "路径不存在时先用 kb_search 或 kb_list 定位。",
		promptSnippet: "读笔记：kb_read(路径[, offset]) → 全文",
		parameters: Type.Object({
			path: Type.String({ description: "笔记相对路径，如 /notes/分类/webdav.md" }),
			offset: Type.Optional(
				Type.Integer({ description: `字符偏移（分页续读用），默认 0，每页上限 ${READ_MAX_CHARS}` }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			if (isLfsPath(params.path)) {
				return text(
					`/lfs/ 是 LFS 大文件区，不参与知识库读取。请用 kb_lslfs 查看可用文件、kb_download 下载到本地。`,
					{},
				);
			}
			const mirror = mirrorOf();
			try {
				const content = vaultReadNote(mirror, params.path);
				if (content === null) {
					return text(
						`笔记不存在：${params.path}\n可先用 kb_search 搜关键词或 kb_list 浏览目录找到正确路径。`,
						{},
					);
				}
				status(ctx, "kb-read", "📖", 4_000);
				const offset = Math.max(0, params.offset ?? 0);
				if (offset >= content.length) {
					return text(`（${params.path} 共 ${content.length} 字符，offset ${offset} 已越界，没有更多内容）`, {});
				}
				const chunk = content.slice(offset, offset + READ_MAX_CHARS);
				const hasMore = offset + READ_MAX_CHARS < content.length;
				const head = `（${params.path} ${offset + 1}-${offset + chunk.length} / 共 ${content.length} 字符${hasMore ? 
					`，续读用 offset=${offset + READ_MAX_CHARS}` : ""}）\n---\n`;
				return text(head + chunk, { offset, truncated: hasMore });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return text(`读取失败（${params.path}）：${msg}`, { error: msg });
			}
		},
	});

	// ---------- kb_write ----------
	pi.registerTool({
		name: "kb_write",
		label: "写入笔记",
		description:
			"写入/覆盖一篇笔记（相对路径，必须位于 /notes /references /scratch /vault 之一，"
			+ `.md/.markdown/.txt 后缀；vault 下自动加密）。`
			+ "已存在文件需显式 overwrite:true；补充内容用 kb_append。"
			+ "内容须以 frontmatter（title/tags）开头，否则会被拒绝。",
		promptSnippet: "写笔记：kb_write(路径, 内容[, overwrite]) → 已写入",
		parameters: Type.Object({
			path: Type.String({ description: "笔记相对路径，如 /notes/webdav-踩坑.md" }),
			content: Type.String({ description: "笔记内容（含 frontmatter：title/tags）" }),
			overwrite: Type.Optional(
				Type.Boolean({ description: "已存在文件需 true 才允许覆盖（默认 false）" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const p = validateWritablePath(params.path);
			if (p) return text(p, {});
			// md 大小硬限制：防伪装上传大文件（正常笔记远小于 50MB）；放最前，大内容直接拒
			const contentBytes = Buffer.byteLength(params.content, "utf8");
			if (contentBytes > MD_MAX_BYTES) {
				return text(
					`内容 ${formatSize(contentBytes)} 超过 md 笔记上限 ${formatSize(MD_MAX_BYTES)}——笔记不应如此大。`
						+ `大文件请用 kb_upload 上传到 LFS（/lfs/）。`,
					{ size: contentBytes },
				);
			}
			if (!hasFrontmatter(params.content)) {
				return text(
					"内容缺少 frontmatter。每个笔记必须以下格式开头：\n"
						+ "---\ntitle: 一句话标题\ntags: [标签1, 标签2]\n---\n正文…",
					{},
				);
			}
			const mirror = mirrorOf();
			// 查重守卫：已存在且未显式 overwrite → 拒绝
			const exists = vaultReadNote(mirror, params.path) !== null;
			if (exists && !params.overwrite) {
				return text(
					`${params.path} 已存在。为防止误覆盖：\n`
						+ "- 确认覆盖请重试并加 overwrite:true\n"
						+ "- 补充内容用 kb_append\n"
						+ `- 若本意是新建，先 kb_search 确认没有类似笔记，再换路径`,
					{ conflict: true },
				);
			}
			const cfg = loadConfig(agentConfigDir());
			try {
				const etag = await vaultPutNote(cfg, mirror, params.path, params.content, { signal });
				status(ctx, "kb-write", "✍️", 4_000);
				return text(
					`✓ 已写入 ${params.path}${etag ? "" : "（离线：仅本地，稍后自动同步）"}\n`
						+ (exists ? "（覆盖已有笔记）" : "（新建）"),
					{ etag },
				);
			} catch (e) {
				return text(`写入失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
		},
	});

	// ---------- kb_append ----------
	pi.registerTool({
		name: "kb_append",
		label: "追加笔记",
		description:
			"向已有笔记追加内容（vault 下自动解密-追加-加密）。笔记不存在时报错。"
			+ "适合记录「后续更新」「踩坑补充」。",
		promptSnippet: "追加笔记：kb_append(路径, 内容) → 已追加",
		parameters: Type.Object({
			path: Type.String({ description: "笔记相对路径，如 /notes/webdav-踩坑.md" }),
			content: Type.String({ description: "要追加的内容（换行开头更清晰）" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const p = validateWritablePath(params.path);
			if (p) return text(p, {});
			const mirror = mirrorOf();
			let existing: string;
			try {
				const cur = vaultReadNote(mirror, params.path);
				if (cur === null) {
					return text(`笔记不存在：${params.path}。新建请用 kb_write（需带 frontmatter）。`, {});
				}
				existing = cur;
			} catch (e) {
				return text(`读取失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
			const merged = existing.endsWith("\n") ? existing + params.content + "\n" : existing + "\n\n" + params.content + "\n";
			const cfg = loadConfig(agentConfigDir());
			try {
				await vaultPutNote(cfg, mirror, params.path, merged, { signal });
				status(ctx, "kb-append", "➕", 4_000);
				return text(`✓ 已追加 ${params.path}（共 ${merged.length} 字符）`, {});
			} catch (e) {
				return text(`追加失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
		},
	});

	// ---------- kb_list ----------
	pi.registerTool({
		name: "kb_list",
		label: "列出知识库",
		description:
			`列出本地镜像目录（相对路径），便于浏览知识库结构、确认命名空间与已有笔记。`
			+ `上限 ${LIST_MAX} 条。`,
		promptSnippet: "列目录：kb_list([路径]) → 目录树",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "要浏览的目录，缺省为根（全部）" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const mirror = mirrorOf();
			const all = listNotes(mirror)
				.filter((f) => !isLfsPath(f.path))
				.map((f) => {
					// vault 落盘为密文（xxx.md.enc），对外展示/过滤统一用明文路径（与 kb_read/kb_write/kb_search 一致），
					// 否则 AI 照列表路径 kb_read 会找不到（读的是明文约定路径）；目录项 vault 下也不带 .enc，原样保留
					if (f.isDir) return f;
					const plain = decryptPath(f.path);
					return plain ? { path: plain, isDir: false } : f;
				});
			const base = params.path ? params.path.replace(/\/+$/, "") : "";
			if (base.startsWith("/lfs")) {
				return text(`/lfs/ 是 LFS 大文件区，不在知识库目录中。请用 kb_lslfs 查看。`, {});
			}
			const filtered = base ? all.filter((f) => f.path.startsWith(base + "/")) : all;
			const shown = filtered.slice(0, LIST_MAX);
			if (shown.length === 0) {
				return text(
					`${base || "/"} 下暂无内容${base ? "" : "（首次使用请先 /kb-sync 同步远端）"}。`,
					{ count: 0 },
				);
			}
			const lines = shown.map((f) => (f.isDir ? `📁 ${f.path}` : `📄 ${f.path}`));
			if (filtered.length > LIST_MAX) lines.push(`…（还有 ${filtered.length - LIST_MAX} 项未显示）`);
			lines.push(`\n共 ${shown.length} 项。需要内容请 kb_read。`);
			return text(lines.join("\n"), { count: shown.length });
		},
	});

	// ---------- kb_upload（LFS：附加真网盘，与 md 知识库隔离） ----------
	pi.registerTool({
		name: "kb_upload",
		label: "上传文件到 LFS",
		description:
			"把本地文件上传到知识库的 LFS 大文件区（/lfs/：任何类型文件，不随知识库同步、不参与检索）。"
			+ "sourcePath 为相对当前工作目录的本地文件路径。已存在文件需 overwrite:true。"
			+ "上传后返回远端路径，可用 kb_download 取回。",
		promptSnippet: "上传到 LFS：kb_upload(远端路径, 本地路径[, overwrite]) → 已上传",
		parameters: Type.Object({
			path: Type.String({ description: "/lfs/ 下的目标路径，如 /lfs/screenshots/1.png" }),
			sourcePath: Type.String({ description: "本地文件路径（相对当前工作目录）" }),
			overwrite: Type.Optional(Type.Boolean()),
			// force：文档隐藏，仅在 >1GB 拒绝警告中揭示（防滥用强制参数）
			force: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const p = params.path;
			if (!isLfsPath(p)) return text(`路径必须位于 /lfs/ 下（LFS 大文件区）。当前：${p}`, {});
			// 次级分类约束：/lfs/ 根不直接放文件（与 md 命名空间一致）
			if (p.split("/").filter(Boolean).length < 3) {
				return text(`路径必须包含次级分类目录：/lfs/分类名/文件名（当前：${p}）。`, {});
			}
			let src: string;
			try {
				src = path.resolve(ctx.cwd, params.sourcePath);
			} catch {
				return text(`源路径无法解析：${params.sourcePath}`, {});
			}
			let data: Buffer;
			try {
				data = fs.readFileSync(src);
			} catch (e) {
				return text(
					`读取源文件失败：${params.sourcePath}（相对工作目录 ${ctx.cwd}）。${e instanceof Error ? e.message : String(e)}`,
					{},
				);
			}
			if (data.length > LFS_MAX_BYTES && !params.force) {
				return text(
					`文件 ${formatSize(data.length)} 超过 LFS 单文件上限 1GB。如确需上传请重试并加 force:true 参数。`,
					{ size: data.length },
				);
			}
			const cfg = loadConfig(agentConfigDir());
			const mirror = mirrorOf();
			try {
				const client = new WebDavClient(cfg.baseUrl!, cfg.username!, cfg.password!, { proxyUrl: cfg.proxyUrl });
				// 已存在守卫（与 kb_write 一致）
				const exists = await client.stat(p);
				if (exists && !params.overwrite) {
					return text(`${p} 已存在。确认覆盖请加 overwrite:true。`, { conflict: true });
				}
				await ensureRemoteDirs(client, p);
				const { etag } = await client.put(p, data, { signal });
				touchLfsCache(mirror, { path: p, size: data.length });
				status(ctx, "kb-lfs", "📤", 4_000);
				return text(
					`✓ 已上传到 LFS：${p}（${formatSize(data.length)}${etag ? "" : "（etag 缺失）"}）\n`
						+ `md 笔记里引用方式：附件路径 ${p}\n`
						+ `需要时用 kb_download 取回。`,
					{ size: data.length },
				);
			} catch (e) {
				return text(`上传失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
		},
	});

	// ---------- kb_download ----------
	pi.registerTool({
		name: "kb_download",
		label: "从 LFS 下载文件",
		description:
			"把 /lfs/ 下的文件下载到本地（一次性操作，不留知识库缓存）。"
			+ "destPath 为相对当前工作目录的路径，缺省 = 工作目录下用远端文件名。"
			+ "目标已存在需 overwrite:true（防覆盖本地文件）。",
		promptSnippet: "从 LFS 下载：kb_download(远端路径[, 本地路径][, overwrite]) → 已下载",
		parameters: Type.Object({
			path: Type.String({ description: "/lfs/ 下的远端路径，如 /lfs/screenshots/1.png" }),
			destPath: Type.Optional(
				Type.String({ description: "本地目标路径（相对当前工作目录，缺省 = 工作目录/远端文件名）" }),
			),
			overwrite: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const p = params.path;
			if (!isLfsPath(p)) return text(`路径必须位于 /lfs/ 下（LFS 大文件区）。当前：${p}`, {});
			const cfg = loadConfig(agentConfigDir());
			try {
				const client = new WebDavClient(cfg.baseUrl!, cfg.username!, cfg.password!, { proxyUrl: cfg.proxyUrl });
				const { data } = await client.get(p, { signal });
				const dest = params.destPath
					? path.resolve(ctx.cwd, params.destPath)
					: path.join(ctx.cwd, path.basename(p));
				if (fs.existsSync(dest) && !params.overwrite) {
					return text(`目标已存在：${dest}。确认覆盖请加 overwrite:true。`, { conflict: true });
				}
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.writeFileSync(dest, data);
				status(ctx, "kb-lfs", "📥", 4_000);
				return text(`✓ 已下载：${dest}（${formatSize(data.length)}）`, { path: dest, size: data.length });
			} catch (e) {
				if (e instanceof DavError && e.status === 404) {
					return text(`远端文件不存在：${p}。可用 kb_lslfs 查看 /lfs/ 下现有文件。`, {});
				}
				return text(`下载失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
		},
	});

	// ---------- kb_lslfs ----------
	pi.registerTool({
		name: "kb_lslfs",
		label: "列出 LFS 大文件",
		description:
			"列出 LFS 大文件区（/lfs/）的文件（路径/大小/时间）。基于元数据缓存（1 小时有效，AI 上传后即时更新）；"
			+ "跨设备刚上传的文件可能未同步，可加 force:true 强制从远端刷新。",
		promptSnippet: "列 LFS：kb_lslfs([路径][, force]) → 文件列表",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "要列的子目录，缺省为 /lfs/ 全部" })),
			force: Type.Optional(Type.Boolean({ description: "强制从远端刷新（忽略 1 小时缓存）" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const cfg = loadConfig(agentConfigDir());
			const mirror = mirrorOf();
			try {
				const files = await getLfsFiles(cfg, mirror, { force: params.force, signal });
				const base = params.path ? params.path.replace(/\/+$/, "") : "";
				const filtered = base ? files.filter((f) => f.path.startsWith(base + "/")) : files;
				const shown = filtered.slice(0, LFS_LIST_MAX);
				if (shown.length === 0) {
					return text(`${base || "/lfs/"} 下暂无文件${params.force ? "（已强制刷新）" : ""}。`, { count: 0 });
				}
				const lines = shown.map(
					(f) => `${f.path}  ${formatSize(f.size)}${f.lastModified ? `  ${f.lastModified}` : ""}`,
				);
				if (filtered.length > LFS_LIST_MAX) lines.push(`…（还有 ${filtered.length - LFS_LIST_MAX} 项）`);
				lines.push(`\n共 ${shown.length} 项。需要时用 kb_download 下载到本地。`);
				return text(lines.join("\n"), { count: shown.length });
			} catch (e) {
				return text(`列出失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
		},
	});

	// ---------- kb_import（批量导入：本地目录 → kb 命名空间） ----------
	pi.registerTool({
		name: "kb_import",
		label: "批量导入本地目录",
		description:
			"把本地目录批量导入知识库（迁移场景）：递归扫描 sourceDir（相对工作目录）下所有 .md/.markdown/.txt，"
			+ `目标 = ${"namespace"} + 原目录结构（自动生成 frontmatter：title=文件名、tags 空；已有 frontmatter 保留）。`
			+ "同名已存在默认跳过，mode=\"overwrite\" 则覆盖。非文本文件与超限文件跳过并在结果中列出（大文件用 kb_upload）。"
			+ "vault 目标自动加密。",
		promptSnippet: "批量导入：kb_import(源目录, 命名空间[, mode]) → 导入摘要",
		parameters: Type.Object({
			sourceDir: Type.String({ description: "本地目录路径（相对当前工作目录），如 knowledge/学校论文要求" }),
			namespace: Type.String({ description: "目标命名空间：/notes /references /scratch /vault" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("skip"), Type.Literal("overwrite")], { description: "同名已存在时：skip 跳过（默认）/ overwrite 覆盖" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const ns = params.namespace.replace(/\/+$/, "");
			if (!(ALLOWED_NAMESPACES as readonly string[]).includes(ns)) {
				return text(`目标命名空间必须为：${ALLOWED_NAMESPACES.join(" ")}（当前：${params.namespace}）。`, {});
			}
			let root: string;
			try {
				root = path.resolve(ctx.cwd, params.sourceDir);
			} catch {
				return text(`源目录无法解析：${params.sourceDir}`, {});
			}
			if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
				return text(`源目录不存在或不是目录：${params.sourceDir}（相对工作目录 ${ctx.cwd}）`, {});
			}
			const mode = params.mode ?? "skip";
			const cfg = loadConfig(agentConfigDir());
			const mirror = mirrorOf();
			// 递归收集文本文件
			const files: { abs: string; rel: string }[] = [];
			const walk = (dir: string, relPrefix: string) => {
				let entries: fs.Dirent[];
				try {
					entries = fs.readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const ent of entries) {
					const abs = path.join(dir, ent.name);
					const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
					if (ent.isDirectory()) walk(abs, rel);
					else if (ent.isFile() && /\.[a-z0-9]+$/i.test(ent.name)) {
						const ext = ent.name.split(".").pop()?.toLowerCase();
						if ((VALID_EXT as readonly string[]).includes("." + ext)) files.push({ abs, rel });
					}
				}
			};
			walk(root, "");
			if (files.length === 0) {
				return text(`目录下没有可导入的文本文件（.md/.markdown/.txt）：${params.sourceDir}`, { count: 0 });
			}
			const stats = { imported: 0, skipped: 0, failed: 0 };
			const skippedList: string[] = [];
			const failedList: string[] = [];
			// 并发导入（与 sync 同款限并发）
			let next = 0;
			const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
				while (next < files.length) {
					if (signal?.aborted) return;
					const i = next++;
					const f = files[i];
					try {
						const stat = fs.statSync(f.abs);
						if (stat.size > MD_MAX_BYTES) {
							skippedList.push(`${f.rel}（${formatSize(stat.size)}，超 md 上限，请用 kb_upload）`);
							stats.skipped++;
							continue;
						}
						let raw = fs.readFileSync(f.abs, "utf8");
						// 自动 frontmatter（没有则补，title=文件名、tags 空）
						if (!/^---\r?\n/.test(raw)) {
							const title = f.rel.split("/").pop()?.replace(/\.[^.]+$/, "") ?? f.rel;
							raw = `---\ntitle: ${title}\ntags: []\n---\n` + raw;
						}
						const target = `${ns}/${f.rel}`;
						// 查重：已存在且 skip → 跳过
						const exists = vaultReadNote(mirror, target) !== null;
						if (exists && mode === "skip") {
							stats.skipped++;
							continue;
						}
						await vaultPutNote(cfg, mirror, target, raw, { signal });
						stats.imported++;
					} catch (e) {
						failedList.push(`${f.rel}（${e instanceof Error ? e.message : String(e)}）`);
						stats.failed++;
					}
				}
			});
			await Promise.all(workers);
			const lines = [`✓ 导入完成：${stats.imported} 成功 / ${stats.skipped} 跳过 / ${stats.failed} 失败`];
			if (skippedList.length > 0) lines.push(`跳过（${skippedList.length}）：\n  - ${skippedList.join("\n  - ")}`);
			if (failedList.length > 0) lines.push(`失败（${failedList.length}）：\n  - ${failedList.join("\n  - ")}`);
			status(ctx, "kb-import", "📥", 5_000);
			return text(lines.join("\n"), { ...stats });
		},
	});

	// ---------- kb_delete（带二次确认的删除） ----------
	pi.registerTool({
		name: "kb_delete",
		label: "删除笔记",
		description:
			"删除一篇笔记（本地镜像 + 远端 + 账本三方一致，vault 自动删密文）。"
			+ "必须传 confirm:true 才执行（防误删）；操作记入 .kb-delete-log 审计。"
			+ "LFS（/lfs/）删除请用 WebDAV 客户端。",
		promptSnippet: "删除笔记：kb_delete(路径, confirm:true) → 已删除",
		parameters: Type.Object({
			path: Type.String({ description: "要删除的笔记相对路径，如 /notes/分类/废弃草稿.md" }),
			confirm: Type.Boolean({ description: "必须为 true 才执行删除" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			if (isLfsPath(params.path)) {
				return text(`/lfs/ 文件删除请用 WebDAV 客户端（LFS 是网盘，不经知识库删除工具）。`, {});
			}
			const p = validateWritablePath(params.path);
			if (p) return text(p, {});
			if (params.confirm !== true) {
				return text(`删除需要二次确认：请重试并传 confirm:true。`, { confirm: false });
			}
			const cfg = loadConfig(agentConfigDir());
			const mirror = mirrorOf();
			// 目标 = 明文路径（vault 落盘为 .enc，见 crypto）
			const rel = isVaultPath(params.path) ? encryptPath(params.path) : params.path;
			try {
				const client = new WebDavClient(cfg.baseUrl!, cfg.username!, cfg.password!, { proxyUrl: cfg.proxyUrl });
				await client.delete(rel); // 远端删（幂等：不存在也返回成功）
				const ledger = loadLedger(mirror);
				delete ledger.files[params.path];
				saveLedger(mirror, ledger);
				// 本地镜像删（含 vault 的 .enc）
				const abs = mirrorPath(mirror, rel);
				if (fs.existsSync(abs)) fs.unlinkSync(abs);
				// 审计日志
				appendDeleteLog(mirror, params.path);
				status(ctx, "kb-delete", "🗑️", 4_000);
				return text(`✓ 已删除：${params.path}（远端 + 本地镜像 + 账本）`, {});
			} catch (e) {
				return text(`删除失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
		},
	});

	// ---------- kb_move（移动/重命名：镜像 + 远端 + 账本三方一致，vault 透明搬移） ----------
	pi.registerTool({
		name: "kb_move",
		label: "移动/重命名笔记",
		description:
			"移动或重命名笔记（本地镜像 + 远端 + 账本三方一致）。"
			+ "vault 文件自动解密-搬移-重加密，无需解锁；目标已存在拒绝（防覆盖）。"
			+ "适合：自由层级调整（分类重命名/合并/迁移）、路径归位。",
		promptSnippet: "移动笔记：kb_move(源路径, 目标路径) → 已移动",
		parameters: Type.Object({
			path: Type.String({ description: "源笔记相对路径（可含旧结构 3 段路径）" }),
			destPath: Type.String({ description: "目标相对路径，须满足 /命名空间/用途/自由层级/文件名" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			if (isLfsPath(params.path)) {
				return text(`/lfs/ 文件移动请用 WebDAV 客户端（LFS 是网盘，不经知识库工具）。`, {});
			}
			// 源：宽松校验（兼容旧结构 3 段路径）；目标：严格分层校验
			const errSrc = validateNs(params.path);
			if (errSrc) return text(errSrc, {});
			const errDst = validateWritablePath(params.destPath);
			if (errDst) return text(errDst, {});
			if (params.path === params.destPath) return text(`源与目标相同，无需移动。`, {});
			const cfg = loadConfig(agentConfigDir());
			const mirror = mirrorOf();
			// 读源（vault 透明：解密为明文，写入时按目标路径重加密；非 vault 原字节）
			let content: string | Uint8Array | null;
			if (isVaultPath(params.path)) {
				content = vaultReadNote(mirror, params.path);
			} else {
				const bytes = readNoteBytes(mirror, params.path);
				content = bytes === null ? null : new TextDecoder().decode(bytes);
			}
			if (content === null) return text(`源文件不存在：${params.path}`, {});
			// 目标已存在防护（本地镜像判断）
			const destExists = isVaultPath(params.destPath)
				? vaultReadNote(mirror, params.destPath) !== null
				: readNoteBytes(mirror, params.destPath) !== null;
			if (destExists) return text(`目标已存在（防覆盖）：${params.destPath}。如需覆盖请先 kb_delete 目标。`, {});
			try {
				// 写目标（远端 + 本地镜像 + 账本）
				await vaultPutNote(cfg, mirror, params.destPath, content, { signal });
				// 删源（远端 + 本地 + 账本）
				const rel = isVaultPath(params.path) ? encryptPath(params.path) : params.path;
				const client = new WebDavClient(cfg.baseUrl!, cfg.username!, cfg.password!, { proxyUrl: cfg.proxyUrl });
				await client.delete(rel);
				const ledger = loadLedger(mirror);
				delete ledger.files[params.path];
				saveLedger(mirror, ledger);
				const abs = mirrorPath(mirror, rel);
				if (fs.existsSync(abs)) fs.unlinkSync(abs);
				appendDeleteLog(mirror, `${params.path} → ${params.destPath}`);
				status(ctx, "kb-move", "➡️", 4_000);
				return text(`✓ 已移动：${params.path} → ${params.destPath}`, {});
			} catch (e) {
				return text(`移动失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
		},
	});

	// ---------- kb_status（同步状态可见性，pull 式轻量） ----------
	pi.registerTool({
		name: "kb_status",
		label: "知识库同步状态",
		description:
			"查看知识库同步状态（本地账本，无需网络）：上次同步时间、冲突文件数（.conflict- 副本）、"
			+ "待上传积压、LFS 缓存情况。据此判断是否需要提醒用户运行 /kb-sync 或解决冲突。",
		promptSnippet: "同步状态：kb_status() → 摘要",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const mirror = mirrorOf();
			const ledger = loadLedger(mirror);
			const lfsCache = loadLfsCache(mirror);
			// 冲突副本计数（镜像递归扫 .conflict-）
			let conflicts = 0;
			const walkMirror = (dir: string) => {
				let entries: fs.Dirent[];
				try {
					entries = fs.readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const ent of entries) {
					const abs = path.join(dir, ent.name);
					if (ent.isDirectory()) {
						if (!ent.name.startsWith(".kb-")) walkMirror(abs);
					} else if (ent.name.includes(".conflict-")) {
						conflicts++;
					}
				}
			};
			walkMirror(mirror);
			const syncedAt = ledger.syncedAt ? new Date(ledger.syncedAt).toLocaleString() : "（从未同步）";
			// 待上传积压：账本有 etag 缺（从未上传成功）的本地文件 + 本地 mtime 新于账本
			const local = listNotes(mirror).filter((f) => !f.isDir && !isLfsPath(f.path));
			let pending = 0;
			for (const f of local) {
				const lf = ledger.files[f.path];
				if (!lf || !lf.etag) pending++;
			}
			const lines = [
				`上次同步：${syncedAt}`,
				`笔记总数：${local.length}（本地镜像）`,
				`冲突副本：${conflicts > 0 ? `${conflicts}（位于镜像 .conflict- 文件，需人工处理）` : "无"}`,
				`待上传积压：${pending > 0 ? `${pending}（离线写入未上传，下次同步补传）` : "无"}`,
				`LFS 文件：${lfsCache.files.length}（元数据缓存，${isLfsCacheFresh(lfsCache) ? "新鲜" : "已过期，kb_lslfs force 刷新"}）`,
			];
			status(ctx, "kb-status", "📊", 4_000);
			return text(lines.join("\n"), { conflicts, pending });
		},
	});

	// ---------- kb_sync（AI 触发手动同步：首次配置后 / 离线写入补传 / 迁移与守则更新后同步远端） ----------
	pi.registerTool({
		name: "kb_sync",
		label: "手动同步知识库",
		description:
			"手动增量同步知识库（下载/上传/删除/冲突，远端与本地镜像与账本三方一致）。"
			+ "通常无需主动调用（会话启动已自动同步）；用于：首次配置后、离线写入后补传、"
			+ "守则/目录结构变更后同步远端。",
		promptSnippet: "同步：kb_sync() → 同步摘要",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			if (notConfiguredHint()) return text(notConfiguredHint()!, {});
			const cfg = loadConfig(agentConfigDir());
			const mirror = mirrorOf();
			status(ctx, "kb-sync", "🔄 同步中", 30_000);
			try {
				const stats = await syncAll(cfg, mirror, { signal });
				const parts: string[] = [];
				if (stats.downloaded) parts.push(`下载 ${stats.downloaded}`);
				if (stats.uploaded) parts.push(`上传 ${stats.uploaded}`);
				if (stats.deleted) parts.push(`删除 ${stats.deleted}`);
				if (stats.conflicts) parts.push(`冲突 ${stats.conflicts}（已保留 .conflict 副本）`);
				if (parts.length === 0) parts.push("已是最新");
				if (stats.errors.length) parts.push(`失败 ${stats.errors.length}`);
				status(ctx, "kb-sync", `📚 ${parts.join("，")}`, 8_000);
				return text(`✓ 同步完成：${parts.join("，")}`, {
					downloaded: stats.downloaded,
					uploaded: stats.uploaded,
					deleted: stats.deleted,
					conflicts: stats.conflicts,
					errors: stats.errors.length,
				});
			} catch (e) {
				return text(`同步失败：${e instanceof Error ? e.message : String(e)}`, { error: String(e) });
			}
		},
	});
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 校验命名空间合法 + 后缀合法（不查段数：用于 kb_move 源路径等旧结构读取场景） */
function validateNs(p: string): string | null {
	if (!p.startsWith("/")) return "路径必须以 / 开头（相对知识库根）。";
	const segs = p.split("/").filter(Boolean);
	const ns = "/" + segs[0];
	if (!(ALLOWED_NAMESPACES as readonly string[]).includes(ns)) {
		return `路径必须位于以下命名空间之一：${ALLOWED_NAMESPACES.join(" ")}（当前：${p}）。`;
	}
	const ext = "." + p.split(".").pop()?.toLowerCase();
	if (!(VALID_EXT as readonly string[]).includes(ext)) {
		return `文件后缀必须为 ${VALID_EXT.join(" / ")}（当前：${p}）。`;
	}
	return null;
}

/** 校验可写路径：合法命名空间 + 分层约束（/命名空间/用途/自由层级/文件名，至少 4 段）+ 合法后缀；不合法返回错误提示 */
function validateWritablePath(p: string): string | null {
	if (!p.startsWith("/")) return "路径必须以 / 开头（相对知识库根）。";
	const segs = p.split("/").filter(Boolean);
	const ns = "/" + segs[0];
	if (!(ALLOWED_NAMESPACES as readonly string[]).includes(ns)) {
		return `路径必须位于以下命名空间之一：${ALLOWED_NAMESPACES.join(" ")}（当前：${p}）。`;
	}
	// 分层约束：/命名空间/用途/自由层级/文件名（至少 4 段），命名空间/用途下不直接放文件
	if (segs.length < 4) {
		return `路径必须分层：/命名空间/用途/自由层级/文件名（命名空间/用途下不直接放文件，当前：${p}）。`;
	}
	const ext = "." + p.split(".").pop()?.toLowerCase();
	if (!(VALID_EXT as readonly string[]).includes(ext)) {
		return `文件后缀必须为 ${VALID_EXT.join(" / ")}（当前：${p}）。`;
	}
	return null;
}

/** 粗略检查 frontmatter（--- 起止 + title/tags 至少出现一项） */
function hasFrontmatter(content: string): boolean {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!m) return false;
	return /title\s*:/.test(m[1]) || /tags\s*:/.test(m[1]);
}

function status(ctx: ExtensionContext, key: string, icon: string, ttlMs: number): void {
	setStatusWithTTL(ctx, key, icon, ttlMs);
}

/** 删除审计：追加到镜像根 .kb-delete-log（时间/路径），失败静默 */
function appendDeleteLog(mirrorDir: string, relPath: string): void {
	try {
		const f = path.join(mirrorDir, ".kb-delete-log");
		fs.appendFileSync(f, `${new Date().toISOString()}  ${relPath}\n`, "utf8");
	} catch {
		/* 审计失败不影响删除 */
	}
}

function text(text: string, details: Record<string, unknown>): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text }], details };
}
