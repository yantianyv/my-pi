#!/usr/bin/env node
/**
 * webdav-kb / search.ts 全文检索单元测试（esbuild bundle + 本地镜像 fixture）
 *
 * 覆盖：frontmatter 解析、英文/中文检索、标题加权排序、命中片段、增量索引
 * （改文件/删文件跟随）、索引缓存持久化（新实例复用）、namespace 过滤、跳过
 * 账本/冲突副本/非 md 文件、重建幂等。
 *
 * 用法：node src/extensions/webdav-kb/test/search.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, rmSync as rm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../../..");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
		failures++;
	}
};

const tmp = mkdtempSync(join(tmpdir(), "kb-search-test-"));
try {
	const outfile = join(tmp, "search.mjs");
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "webdav-kb", "search.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
	const { NoteIndex, getIndex, tokenize, parseFrontmatter } = await import(pathToFileURL(outfile));

	const mirror = join(tmp, "mirror");
	const w = (rel, content) => {
		const abs = join(mirror, ...rel.split("/").filter(Boolean));
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	};

	// ---- 分词 ----
	check("英文分词", JSON.stringify(tokenize("Hello World!")) === JSON.stringify(["hello", "world"]));
	const cjk = tokenize("知识库检索");
	check("中文 bigram 切词", cjk.includes("知识") && cjk.includes("识库") && cjk.includes("库检") && cjk.includes("检索"), JSON.stringify(cjk));

	// ---- frontmatter 解析 ----
	const fm = parseFrontmatter("---\ntitle: 我的测试笔记\ntags: [ai, webdav]\n---\n正文内容\n");
	check("frontmatter title", fm.title === "我的测试笔记", fm.title);
	check("frontmatter tags", JSON.stringify(fm.tags) === JSON.stringify(["ai", "webdav"]), JSON.stringify(fm.tags));
	check("frontmatter 剥离正文", fm.body.trim() === "正文内容", fm.body);
	const noFm = parseFrontmatter("没有 frontmatter 的笔记\n");
	check("无 frontmatter 不炸", noFm.title === "" && noFm.body.startsWith("没有"));

	// ---- 建库 ----
	w("/notes/webdav.md", "---\ntitle: WebDAV 协议速查\ntags: [webdav, 同步]\n---\nWebDAV 是基于 HTTP 的分布式文件系统协议，支持 PROPFIND 列目录、PUT 上传、MKCOL 建目录。\n");
	w("/notes/加密.md", "---\ntitle: 本地加密方案\ntags: [安全]\n---\n口令派生密钥 PBKDF2，AES-256-GCM 加密，口令只存在内存里。\n");
	w("/notes/中文检索示例.md", "这是关于知识库检索的中文笔记，包含检索与排序的说明。\n");
	w("/refs/websocket.md", "WebSocket 是 HTML5 的全双工通信协议，与 HTTP 同属应用层。\n");
	w("/notes/skip.bin", "not text \x00\x01\x02 binary");
	w("/notes/.kb-hidden.md", "hidden file 不应该被索引");
	w("/notes/a.conflict-2024.md", "conflict copy 不应该被索引");
	mkdirSync(join(mirror, "notes"), { recursive: true });
	writeFileSync(join(mirror, ".kb-index.json"), "{}", "utf8"); // 脏缓存，应被容错重建

	const idx = new NoteIndex(mirror);
	idx.refresh();
	check("索引跳过非 md / 隐藏 / 冲突副本", idx.paths().length === 4, JSON.stringify(idx.paths()));
	check("索引含中文文件名", idx.paths().includes("/notes/中文检索示例.md"));

	// ---- 新格式：csv/json/yaml 等纯文本可索引（表格表头加权） ----
	w("/data/城市列表.csv", "城市,省份,人口\n杭州,浙江,1200万\n成都,四川,2100万\n");
	w("/data/汇率快照.json", '{"usd_cny": 7.25, "updated": "2026-01-01"}\n');
	w("/notes/配置示例.yaml", "server:\n  host: localhost\n  port: 8080\n");
	idx.refresh();
	check("csv 可索引", idx.paths().includes("/data/城市列表.csv"));
	check("json 可索引", idx.paths().includes("/data/汇率快照.json"));
	check("yaml 可索引", idx.paths().includes("/notes/配置示例.yaml"));
	let r = idx.search("人口");
	check("csv 正文检索", r.some((x) => x.path === "/data/城市列表.csv"), JSON.stringify(r.map((x) => x.path)));
	r = idx.search("省份");
	check("csv 表头作标题加权", r.length >= 1 && r[0].path === "/data/城市列表.csv" && r[0].title.includes("省份"), JSON.stringify(r.map((x) => [x.path, x.score, x.title])));
	r = idx.search("usd_cny");
	check("json 检索", r.some((x) => x.path === "/data/汇率快照.json"), JSON.stringify(r.map((x) => x.path)));
	r = idx.search("8080");
	check("yaml 检索", r.some((x) => x.path === "/notes/配置示例.yaml"), JSON.stringify(r.map((x) => x.path)));
	r = idx.search("城市", { namespace: "/data" });
	check("csv 正文命中片段含表头", r.length >= 1 && r[0].snippet.includes("城市"), JSON.stringify(r.map((x) => x.snippet)));

	// ---- 回归：yaml 以 --- 文档标记开头不被误剥 frontmatter（开头块内容仍可检索） ----
	w("/notes/文档标记.yaml", "---\nname: 示例服务\n---\nport: 9090\n");
	idx.refresh();
	r = idx.search("示例服务");
	check("yaml --- 文档标记不剥正文", r.some((x) => x.path === "/notes/文档标记.yaml"), JSON.stringify(r.map((x) => x.path)));
	r = idx.search("9090");
	check("yaml --- 文档标记后正文可检索", r.some((x) => x.path === "/notes/文档标记.yaml"), JSON.stringify(r.map((x) => x.path)));

	// ---- 英文检索 ----
	r = idx.search("propfind");
	check("英文检索命中", r.length >= 1 && r[0].path === "/notes/webdav.md", JSON.stringify(r.map((x) => x.path)));
	check("英文检索含片段", r[0].snippet.includes("PROPFIND"), r[0].snippet);

	// ---- 中文检索（bigram） ----
	r = idx.search("加密");
	check("中文检索命中", r.length >= 1 && r[0].path === "/notes/加密.md", JSON.stringify(r.map((x) => x.path)));
	r = idx.search("知识库");
	check("中文检索命中文名笔记", r.some((x) => x.path === "/notes/中文检索示例.md"), JSON.stringify(r.map((x) => x.path)));

	// ---- 标题加权：标题含词应排前 ----
	w("/notes/title-hit.md", "---\ntitle: PBKDF2 专题\n---\n正文里提到一次 PBKDF2 相关内容。\n");
	idx.refresh();
	r = idx.search("PBKDF2");
	check("标题命中排前", r.length >= 2 && r[0].path === "/notes/title-hit.md", JSON.stringify(r.map((x) => [x.path, x.score])));
	check("标题文件 tags 为空数组", Array.isArray(r[0].tags));

	// ---- tags 可检索 ----
	r = idx.search("webdav");
	check("tags 参与索引", r.some((x) => x.path === "/notes/webdav.md"), JSON.stringify(r.map((x) => x.path)));

	// ---- namespace 过滤 ----
	r = idx.search("协议", { namespace: "/notes" });
	check("namespace 过滤 /notes", r.every((x) => x.path.startsWith("/notes")) && r.length >= 1, JSON.stringify(r.map((x) => x.path)));
	r = idx.search("协议", { namespace: "/refs" });
	check("namespace 过滤 /refs", r.every((x) => x.path.startsWith("/refs")), JSON.stringify(r.map((x) => x.path)));

	// ---- limit ----
	r = idx.search("协议", { limit: 1 });
	check("limit 生效", r.length === 1, String(r.length));

	// ---- 增量：修改文件跟随 ----
	await new Promise((res) => setTimeout(res, 20)); // 确保 mtime 前进
	w("/notes/加密.md", "---\ntitle: 本地加密方案\ntags: [安全]\n---\n全新内容：量子加密量子纠缠。\n");
	idx.refresh();
	r = idx.search("量子");
	check("增量索引跟修改", r.some((x) => x.path === "/notes/加密.md"), JSON.stringify(r.map((x) => x.path)));
	r = idx.search("PBKDF2");
	check("旧内容已剔除", !r.some((x) => x.path === "/notes/加密.md"), JSON.stringify(r.map((x) => x.path)));

	// ---- 增量：删除文件跟随 ----
	rm(join(mirror, "notes", "title-hit.md"));
	idx.refresh();
	check("增量索引跟删除", !idx.paths().includes("/notes/title-hit.md"));
	r = idx.search("PBKDF2");
	check("删除后检索不到", !r.some((x) => x.path === "/notes/title-hit.md"));

	// ---- 缓存持久化：新实例复用（结果一致） ----
	const idx2 = new NoteIndex(mirror);
	idx2.refresh();
	check("新实例加载缓存后结果一致", idx2.search("加密").some((x) => x.path === "/notes/加密.md"));

	// ---- 重建幂等 ----
	const before = JSON.stringify(idx.search("协议").map((x) => [x.path, x.score]));
	idx.refresh();
	idx.refresh();
	const after = JSON.stringify(idx.search("协议").map((x) => [x.path, x.score]));
	check("重复 refresh 幂等", before === after);

	// ---- getIndex 单例 ----
	check("getIndex 返回同实例", getIndex(mirror) === getIndex(mirror));

	// ---- 空库检索不炸 ----
	const emptyIdx = new NoteIndex(join(tmp, "empty"));
	check("空库检索返回空", emptyIdx.search("任意").length === 0);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
