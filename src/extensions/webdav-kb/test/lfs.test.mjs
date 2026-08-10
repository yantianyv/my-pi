#!/usr/bin/env node
/**
 * webdav-kb / lfs 功能集成测试（esbuild bundle + mock pi + mock DAV + 临时工作目录）
 *
 * 覆盖：kb_upload（上传/已存在守卫/非 /lfs/ 拒绝/force 参数）、kb_download
 * （下载/目标已存在守卫/404 引导）、kb_lslfs（列表/缓存/force 刷新）、隔离
 * （kb_read 引导、kb_list 过滤、kb_search namespace 提示）、md 50MB 上限、
 * syncAll 对 /lfs/ 只刷元数据不下载、本地 lfs 文件不参与上传、search 不索引 /lfs/。
 *
 * 用法：node src/extensions/webdav-kb/test/lfs.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { startMockDav } from "./mock-dav.mjs";

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

function makePi() {
	return {
		tools: [],
		commands: {},
		events: {},
		registerTool(t) {
			this.tools.push(t);
		},
		registerCommand(name, c) {
			this.commands[name] = c;
		},
		on(ev, cb) {
			this.events[ev] = cb;
		},
	};
}

function makeCtx(cwd, captures = {}) {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		ui: {
			setStatus: (key, text) => (captures.status = { key, text }),
			notify: (text, kind) => (captures.notify = { text, kind }),
		},
	};
}

const tmp = mkdtempSync(join(tmpdir(), "kb-lfs-test-"));
const dav = await startMockDav();
let outfile;
try {
	const configDir = join(tmp, "agent");
	mkdirSync(configDir, { recursive: true });
	const mirrorDir = join(tmp, "mirror");
	const workDir = join(tmp, "work"); // AI 工作目录
	mkdirSync(workDir, { recursive: true });
	process.env.KB_CONFIG_DIR = configDir;
	const cfgFile = join(configDir, "kb-config.json");
	writeFileSync(cfgFile, JSON.stringify({ baseUrl: dav.baseUrl, username: "test-user", password: "test-pass", mirrorDir }), "utf8");

	outfile = join(TEST_DIR, ".tmp-kb-lfs-bundle.mjs");
	const entry = join(tmp, "entry.ts");
	const rel = (p) => p.replace(/\\/g, "/");
	writeFileSync(
		entry,
		[
			'export { default } from "' + rel(join(SRC_DIR, "extensions", "webdav-kb", "index.ts")) + '";',
			'export { syncAll } from "' + rel(join(SRC_DIR, "extensions", "webdav-kb", "sync.ts")) + '";',
			'export { getIndex } from "' + rel(join(SRC_DIR, "extensions", "webdav-kb", "search.ts")) + '";',
		].join("\n"),
		"utf8",
	);
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
	const mod = await import(pathToFileURL(outfile).href);
	const pi = makePi();
	mod.default(pi);
	const tool = (name) => pi.tools.find((t) => t.name === name);
	const names = pi.tools.map((t) => t.name);
	check("注册 11 个工具", ["kb_help", "kb_search", "kb_read", "kb_write", "kb_append", "kb_list", "kb_upload", "kb_download", "kb_lslfs", "kb_move", "kb_sync"].every((n) => names.includes(n)), JSON.stringify(names));

	const ctx = makeCtx(workDir);

	// ---- kb_upload：上传 ----
	const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04]);
	writeFileSync(join(workDir, "screenshot.png"), pngBytes);
	let r = await tool("kb_upload").execute("1", { path: "/lfs/screenshots/1.png", sourcePath: "screenshot.png" }, undefined, undefined, ctx);
	check("kb_upload 上传成功", r.content[0].text.includes("已上传") && r.content[0].text.includes("/lfs/screenshots/1.png"), r.content[0].text.slice(0, 80));
	check("远端存在", dav.store.has(dav.prefix + "/lfs/screenshots/1.png"));
	check("字节一致", Buffer.from(dav.store.get(dav.prefix + "/lfs/screenshots/1.png").data).equals(pngBytes));

	// ---- kb_upload：守卫与拒绝 ----
	r = await tool("kb_upload").execute("2", { path: "/lfs/screenshots/1.png", sourcePath: "screenshot.png" }, undefined, undefined, ctx);
	check("已存在需 overwrite", r.content[0].text.includes("overwrite"), r.content[0].text.slice(0, 80));
	r = await tool("kb_upload").execute("3", { path: "/notes/x.png", sourcePath: "screenshot.png" }, undefined, undefined, ctx);
	check("非 /lfs/ 路径拒绝", r.content[0].text.includes("/lfs/"), r.content[0].text.slice(0, 60));
	r = await tool("kb_upload").execute("4", { path: "/lfs/sub/x.png", sourcePath: "no-such-file" }, undefined, undefined, ctx);
	check("源文件不存在报错", r.content[0].text.includes("读取源文件失败"), r.content[0].text.slice(0, 60));
	r = await tool("kb_upload").execute("5", { path: "/lfs/screenshots/1.png", sourcePath: "screenshot.png", overwrite: true }, undefined, undefined, ctx);
	check("overwrite 覆盖成功", r.content[0].text.includes("已上传"), r.content[0].text.slice(0, 60));

	// ---- kb_upload：force 参数可被 schema 接受（大小上限边界见代码常量，此处验证参数不报错） ----
	writeFileSync(join(workDir, "big.bin"), "tiny");
	r = await tool("kb_upload").execute("6", { path: "/lfs/sub/big.bin", sourcePath: "big.bin", force: true }, undefined, undefined, ctx);
	check("force 参数可接受", r.content[0].text.includes("已上传"), r.content[0].text.slice(0, 60));

	// ---- kb_download：下载 ----
	r = await tool("kb_download").execute("7", { path: "/lfs/screenshots/1.png", destPath: "out/1.png" }, undefined, undefined, ctx);
	check("kb_download 成功", r.content[0].text.includes("已下载") && r.content[0].text.includes("out"), r.content[0].text.slice(0, 80));
	check("本地内容一致", Buffer.from(readFileSync(join(workDir, "out", "1.png"))).equals(pngBytes));
	r = await tool("kb_download").execute("8", { path: "/lfs/sub/big.bin" }, undefined, undefined, ctx);
	check("缺省 destPath 落到工作目录", existsSync(join(workDir, "big.bin")), r.content[0].text.slice(0, 60));
	r = await tool("kb_download").execute("9", { path: "/lfs/screenshots/1.png", destPath: "out/1.png" }, undefined, undefined, ctx);
	check("目标已存在需 overwrite", r.content[0].text.includes("overwrite"), r.content[0].text.slice(0, 80));
	r = await tool("kb_download").execute("10", { path: "/lfs/sub/nope.png" }, undefined, undefined, ctx);
	check("404 引导 lslfs", r.content[0].text.includes("kb_lslfs"), r.content[0].text.slice(0, 60));
	r = await tool("kb_download").execute("11", { path: "/notes/a.md" }, undefined, undefined, ctx);
	check("下载非 /lfs/ 拒绝", r.content[0].text.includes("/lfs/"), r.content[0].text.slice(0, 60));

	// ---- kb_lslfs：列表（缓存来自上传 touch） ----
	r = await tool("kb_lslfs").execute("12", {}, undefined, undefined, ctx);
	check("kb_lslfs 列出文件", r.content[0].text.includes("/lfs/screenshots/1.png") && r.content[0].text.includes("/lfs/sub/big.bin"), r.content[0].text.slice(0, 100));
	r = await tool("kb_lslfs").execute("13", { path: "/lfs/screenshots" }, undefined, undefined, ctx);
	check("子目录过滤", r.content[0].text.includes("1.png") && !r.content[0].text.includes("big.bin"), r.content[0].text.slice(0, 80));
	dav.seed("/lfs/other.txt", "other");
	r = await tool("kb_lslfs").execute("14", {}, undefined, undefined, ctx);
	check("缓存内看不到新文件", !r.content[0].text.includes("other.txt"), r.content[0].text.slice(0, 60));
	r = await tool("kb_lslfs").execute("15", { force: true }, undefined, undefined, ctx);
	check("force 刷新看到新文件", r.content[0].text.includes("other.txt"), r.content[0].text.slice(0, 60));

	// ---- 隔离：md 工具看不到 lfs ----
	r = await tool("kb_read").execute("16", { path: "/lfs/screenshots/1.png" }, undefined, undefined, ctx);
	check("kb_read 对 lfs 引导", r.content[0].text.includes("kb_download"), r.content[0].text.slice(0, 60));
	r = await tool("kb_search").execute("17", { query: "x", namespace: "/lfs" }, undefined, undefined, ctx);
	check("kb_search /lfs 提示", r.content[0].text.includes("kb_lslfs"), r.content[0].text.slice(0, 60));
	r = await tool("kb_list").execute("18", { path: "/lfs" }, undefined, undefined, ctx);
	check("kb_list /lfs 提示", r.content[0].text.includes("kb_lslfs"), r.content[0].text.slice(0, 60));
	r = await tool("kb_list").execute("19", {}, undefined, undefined, ctx);
	check("kb_list 过滤 lfs", !r.content[0].text.includes("/lfs/"), r.content[0].text.slice(0, 80));

	// ---- kb_list：vault 密文路径转明文（列表/读取路径约定一致，否则照列表 kb_read 找不到） ----
	const vaultDir = join(mirrorDir, "vault");
	mkdirSync(vaultDir, { recursive: true });
	writeFileSync(join(vaultDir, "秘密笔记.md.enc"), "encrypted-bytes");
	r = await tool("kb_list").execute("19b", {}, undefined, undefined, ctx);
	check("kb_list vault 显示明文路径", r.content[0].text.includes("秘密笔记.md") && !r.content[0].text.includes(".enc"), r.content[0].text.slice(0, 120));
	r = await tool("kb_list").execute("19c", { path: "/vault" }, undefined, undefined, ctx);
	check("kb_list /vault 过滤用明文路径", r.content[0].text.includes("秘密笔记.md"), r.content[0].text.slice(0, 120));

	// ---- kb_move：移动/重命名（镜像+远端+账本三方一致）+ 旧结构 3 段源可迁 ----
	await tool("kb_write").execute("21", { path: "/notes/技术笔记/WebDAV/旧位置.md", content: "---\ntitle: 移动测试\ntags: [webdav]\n---\n内容", overwrite: true }, undefined, undefined, ctx);
	r = await tool("kb_move").execute("22", { path: "/notes/技术笔记/WebDAV/旧位置.md", destPath: "/notes/技术笔记/WebDAV/新位置.md" }, undefined, undefined, ctx);
	check("kb_move 成功", r.content[0].text.includes("已移动"), r.content[0].text.slice(0, 80));
	check("本地目标存在", existsSync(join(mirrorDir, "notes", "技术笔记", "WebDAV", "新位置.md")));
	check("本地源已删", !existsSync(join(mirrorDir, "notes", "技术笔记", "WebDAV", "旧位置.md")));
	check("远端目标存在", dav.store.has(dav.prefix + "/notes/技术笔记/WebDAV/新位置.md"));
	check("远端源已删", !dav.store.has(dav.prefix + "/notes/技术笔记/WebDAV/旧位置.md"));
	r = await tool("kb_move").execute("23", { path: "/notes/技术笔记/WebDAV/新位置.md", destPath: "/notes/技术笔记/WebDAV/新位置.md" }, undefined, undefined, ctx);
	check("kb_move 同路径拒绝", r.content[0].text.includes("无需移动"), r.content[0].text.slice(0, 60));
	// 旧结构 3 段源路径（如 /references/01-xxx/xxx.txt）可被迁走：源校验宽松、目标严格
	mkdirSync(join(mirrorDir, "references", "旧结构"), { recursive: true });
	writeFileSync(join(mirrorDir, "references", "旧结构", "旧文件.md"), "---\ntitle: 旧结构\ntags: []\n---\n旧内容");
	r = await tool("kb_move").execute("24", { path: "/references/旧结构/旧文件.md", destPath: "/references/知识文献/论文/旧文件.md" }, undefined, undefined, ctx);
	check("kb_move 旧 3 段源可迁移", r.content[0].text.includes("已移动"), r.content[0].text.slice(0, 80));
	check("迁移后目标存在", existsSync(join(mirrorDir, "references", "知识文献", "论文", "旧文件.md")));
	r = await tool("kb_move").execute("25", { path: "/references/知识文献/论文/旧文件.md", destPath: "/references/知识文献/论文/旧文件.md" }, undefined, undefined, ctx);
	check("kb_move 同路径拒绝 2", r.content[0].text.includes("无需移动"), r.content[0].text.slice(0, 60));
	await tool("kb_write").execute("25b", { path: "/references/知识文献/论文/另一个.md", content: "---\ntitle: 另一个\ntags: []\n---\n内容" }, undefined, undefined, ctx);
	r = await tool("kb_move").execute("25c", { path: "/references/知识文献/论文/另一个.md", destPath: "/references/知识文献/论文/旧文件.md" }, undefined, undefined, ctx);
	check("kb_move 目标已存在防护", r.content[0].text.includes("防覆盖"), r.content[0].text.slice(0, 80));
	r = await tool("kb_move").execute("26", { path: "/notes/不存在/文件.md", destPath: "/notes/技术笔记/WebDAV/x.md" }, undefined, undefined, ctx);
	check("kb_move 源不存在报错", r.content[0].text.includes("源文件不存在"), r.content[0].text.slice(0, 60));
	r = await tool("kb_move").execute("27", { path: "/notes/技术笔记/WebDAV/新位置.md", destPath: "/notes/技术笔记/裸文件.md" }, undefined, undefined, ctx);
	check("kb_move 目标不满足分层拒绝", r.content[0].text.includes("分层"), r.content[0].text.slice(0, 80));

	// ---- kb_sync：AI 触发手动同步（远端新增 → 下载到本地镜像） ----
	dav.seed("/notes/技术笔记/WebDAV/远端新增.md", "---\ntitle: 远端新增\ntags: []\n---\n来自远端");
	r = await tool("kb_sync").execute("28", {}, undefined, undefined, ctx);
	check("kb_sync 同步成功", r.content[0].text.includes("同步完成"), r.content[0].text.slice(0, 80));
	check("kb_sync 下载远端新文件", r.content[0].text.includes("下载"), r.content[0].text.slice(0, 80));
	check("本地出现远端文件", existsSync(join(mirrorDir, "notes", "技术笔记", "WebDAV", "远端新增.md")));
	r = await tool("kb_sync").execute("29", {}, undefined, undefined, ctx);
	check("kb_sync 二次同步已最新", r.content[0].text.includes("已是最新"), r.content[0].text.slice(0, 80));

	// ---- kb_write 大内容拒绝（md 上限 50MB，构造字符串用 Buffer 生成快） ----
	const bigContent = "a".repeat(50 * 1024 * 1024 + 1);
	r = await tool("kb_write").execute("20", { path: "/notes/技术笔记/WebDAV/容量测试/huge.md", content: bigContent }, undefined, undefined, ctx);
	check("kb_write 超大内容拒绝", r.content[0].text.includes("超过 md 笔记上限"), r.content[0].text.slice(0, 80));

	// ---- syncAll：/lfs/ 只刷元数据不下载 ----
	const cfg = { baseUrl: dav.baseUrl, username: "test-user", password: "test-pass", mirrorDir };
	await mod.syncAll(cfg, mirrorDir);
	check("sync 不下载 lfs 本体", !existsSync(join(mirrorDir, "lfs", "screenshots", "1.png")) && !existsSync(join(mirrorDir, "lfs", "big.bin")));
	check("sync 生成 lfs 缓存", existsSync(join(mirrorDir, ".kb-lfs-cache.json")));
	const cache = JSON.parse(readFileSync(join(mirrorDir, ".kb-lfs-cache.json"), "utf8"));
	check("缓存含 lfs 元数据", cache.files.some((f) => f.path === "/lfs/screenshots/1.png") && cache.files.some((f) => f.path === "/lfs/other.txt"), JSON.stringify(cache.files));

	// ---- 本地 lfs 文件不参与上传 + search 不索引 ----
	mkdirSync(join(mirrorDir, "lfs", "manual"), { recursive: true });
	writeFileSync(join(mirrorDir, "lfs", "manual", "local-only.bin"), "local");
	writeFileSync(join(mirrorDir, "lfs", "manual", "doc.md"), "---\ntitle: lfs doc\ntags: []\n---\nlfs 特殊内容。\n");
	await mod.syncAll(cfg, mirrorDir);
	check("本地 lfs 文件不被 sync 上传", !dav.store.has(dav.prefix + "/lfs/manual/local-only.bin"));
	const idx = mod.getIndex(mirrorDir);
	const sr = idx.search("特殊");
	check("search 不索引 /lfs/", !sr.some((x) => x.path.startsWith("/lfs/")), JSON.stringify(sr.map((x) => x.path)));
	check("search 索引不含 lfs 路径", !idx.paths().some((p2) => p2.startsWith("/lfs/")), JSON.stringify(idx.paths().slice(0, 5)));
} finally {
	delete process.env.KB_CONFIG_DIR;
	dav.close();
	if (outfile) {
		try {
			rmSync(outfile, { force: true });
		} catch {
			/* 清理 */
		}
	}
	rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
