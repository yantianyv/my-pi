#!/usr/bin/env node
/**
 * webdav-kb / tools.ts + index.ts 集成测试（esbuild bundle + mock pi + mock DAV）
 *
 * 覆盖：6 工具注册、session_start 后台同步（vault 解锁询问跳过 hasUI=false）、
 * kb_help 守则、kb_search 检索、kb_read 读、kb_write（frontmatter 校验/命名空间
 * 白名单/查重 overwrite 守卫）、kb_append、kb_list、vault 透明读写、未配置引导。
 *
 * 配置隔离：process.env.KB_CONFIG_DIR 指向临时目录（store.ts 支持）。
 * 用法：node src/extensions/webdav-kb/test/tools.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
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

/** mock pi：收集工具注册与事件 */
function makePi() {
	const pi = {
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
	return pi;
}

/** mock ctx：捕获 setStatus/notify */
function makeCtx(captures = {}) {
	return {
		cwd: process.cwd(),
		hasUI: false, // 跳过 vault 解锁询问
		ui: {
			setStatus: (key, text) => {
				captures.status = { key, text };
			},
			notify: (text, kind) => {
				captures.notify = { text, kind };
			},
		},
	};
}

const tmp = mkdtempSync(join(tmpdir(), "kb-tools-test-"));
const dav = await startMockDav();
try {
	// 配置隔离
	const configDir = join(tmp, "agent");
	mkdirSync(configDir, { recursive: true });
	const mirrorDir = join(tmp, "mirror");
	process.env.KB_CONFIG_DIR = configDir;

	// bundle index.ts（@earendil-works/*、typebox 外部——经本目录 node_modules junction → pi 全局解析）
	const outfile = join(TEST_DIR, ".tmp-kb-bundle.mjs");
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "webdav-kb", "index.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
	const mod = await import(pathToFileURL(outfile));

	// ---- 工具注册 ----
	const pi = makePi();
	mod.default(pi);
	const names = pi.tools.map((t) => t.name);
	check("注册 6 个工具", ["kb_help", "kb_search", "kb_read", "kb_write", "kb_append", "kb_list"].every((n) => names.includes(n)), JSON.stringify(names));
	const tool = (name) => pi.tools.find((t) => t.name === name);

	// ---- 未配置引导 ----
	let r = await tool("kb_search").execute("1", { query: "x" }, undefined, undefined, makeCtx());
	check("未配置时给引导", r.content[0].text.includes("/kb-config"), r.content[0].text.slice(0, 60));

	// ---- 写配置 + 远端种子 + session_start 后台同步 ----
	writeFileSync(
		join(configDir, "kb-config.json"),
		JSON.stringify({ baseUrl: dav.baseUrl, username: "test-user", password: "test-pass", mirrorDir }, null, 2),
		"utf8",
	);
	dav.seed("/notes/tsc-build-gotcha.md", "---\ntitle: tsc 构建坑\ntags: [tsc, 构建]\n---\ntsc 检查会卡死，需要跳过 node_modules。\n");
	dav.seed("/notes/加密方案.md", "---\ntitle: 加密方案\ntags: [安全]\n---\nPBKDF2 派生密钥，AES-256-GCM。\n");

	const captures = {};
	const ctx = makeCtx(captures);
	const sessionStart = pi.events.session_start;
	await sessionStart({ reason: "startup" }, ctx);
	// 等后台同步完成（轮询镜像文件出现）
	const appear = async (rel, timeoutMs = 8000) => {
		const t0 = Date.now();
		const abs = join(mirrorDir, ...rel.split("/").filter(Boolean));
		while (Date.now() - t0 < timeoutMs) {
			try {
				statSync(abs);
				return true;
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		return false;
	};
	check("session_start 后台同步落地镜像", await appear("/notes/tsc-build-gotcha.md"), JSON.stringify(captures.status));

	// ---- kb_help ----
	r = await tool("kb_help").execute("2", {}, undefined, undefined, ctx);
	const help = r.content[0].text;
	check("kb_help 返回守则", help.includes("命名空间") && help.includes("kb_write"), help.slice(0, 40));

	// ---- kb_search ----
	r = await tool("kb_search").execute("3", { query: "卡死" }, undefined, undefined, ctx);
	check("kb_search 命中", r.content[0].text.includes("/notes/tsc-build-gotcha.md"), r.content[0].text.slice(0, 80));
	r = await tool("kb_search").execute("4", { query: "zzzqqq12345xyz" }, undefined, undefined, ctx);
	check("kb_search 未命中如实说", r.content[0].text.includes("未找到"), r.content[0].text.slice(0, 60));

	// ---- kb_read ----
	r = await tool("kb_read").execute("5", { path: "/notes/tsc-build-gotcha.md" }, undefined, undefined, ctx);
	check("kb_read 读全文", r.content[0].text.includes("跳过 node_modules"), r.content[0].text.slice(0, 60));
	r = await tool("kb_read").execute("6", { path: "/notes/不存在分类/不存在.md" }, undefined, undefined, ctx);
	check("kb_read 不存在给引导", r.content[0].text.includes("kb_search"), r.content[0].text.slice(0, 60));

	// ---- kb_write：frontmatter 校验 / 命名空间白名单 ----
	r = await tool("kb_write").execute("7", { path: "/notes/测试分类/无frontmatter.md", content: "没有 frontmatter" }, undefined, undefined, ctx);
	check("kb_write 缺 frontmatter 拒绝", r.content[0].text.includes("frontmatter"), r.content[0].text.slice(0, 60));
	r = await tool("kb_write").execute("8", { path: "/etc/passwd", content: "---\ntitle: x\ntags: []\n---\n" }, undefined, undefined, ctx);
	check("kb_write 非法命名空间拒绝", r.content[0].text.includes("命名空间"), r.content[0].text.slice(0, 60));

	// ---- kb_write 新建（含 frontmatter） ----
	const newNote = "---\ntitle: WebDAV 踩坑\ntags: [webdav]\n---\n123 云盘的 WebDAV 用 https://dav.123pan.com。\n";
	r = await tool("kb_write").execute("9", { path: "/notes/webdav分类/坑记录/webdav-坑.md", content: newNote }, undefined, undefined, ctx);
	check("kb_write 新建成功", r.content[0].text.includes("已写入"), r.content[0].text.slice(0, 60));
	check("kb_write 同步上传远端", dav.store.has(dav.prefix + "/notes/webdav分类/坑记录/webdav-坑.md"));

	// ---- kb_write 查重守卫 ----
	r = await tool("kb_write").execute("10", { path: "/notes/webdav分类/坑记录/webdav-坑.md", content: newNote }, undefined, undefined, ctx);
	check("kb_write 已存在需 overwrite", r.content[0].text.includes("overwrite"), r.content[0].text.slice(0, 80));
	r = await tool("kb_write").execute("11", { path: "/notes/webdav分类/坑记录/webdav-坑.md", content: newNote.replace("123 云盘", "坚果云"), overwrite: true }, undefined, undefined, ctx);
	check("kb_write overwrite:true 覆盖", r.content[0].text.includes("已写入"), r.content[0].text.slice(0, 60));

	// ---- kb_append ----
	r = await tool("kb_append").execute("12", { path: "/notes/webdav分类/坑记录/webdav-坑.md", content: "补充：不要用 PUT 传大文件。" }, undefined, undefined, ctx);
	check("kb_append 成功", r.content[0].text.includes("已追加"), r.content[0].text.slice(0, 60));
	r = await tool("kb_read").execute("13", { path: "/notes/webdav分类/坑记录/webdav-坑.md" }, undefined, undefined, ctx);
	check("kb_append 内容合并", r.content[0].text.includes("补充：不要用 PUT"), r.content[0].text.slice(-60));

	// ---- kb_list ----
	r = await tool("kb_list").execute("14", {}, undefined, undefined, ctx);
	check("kb_list 列出目录", r.content[0].text.includes("📁 notes") && r.content[0].text.includes("📄 webdav-坑.md"), r.content[0].text.slice(0, 80));

	// ---- vault 透明读写（解锁后） ----
	const cryptoMod = await import(pathToFileURL(outfile).href); // 同 bundle：createVault/unlockVault 可用
	const setup = cryptoMod.createVault("口令x");
	writeFileSync(
		join(configDir, "kb-config.json"),
		JSON.stringify({ baseUrl: dav.baseUrl, username: "test-user", password: "test-pass", mirrorDir, vault: setup }, null, 2),
		"utf8",
	);
	// 未解锁时写 vault → 应报错
	r = await tool("kb_write").execute("15", { path: "/vault/密分类/测试/密.md", content: "---\ntitle: 密\ntags: []\n---\n机密内容\n" }, undefined, undefined, ctx);
	check("未解锁写 vault 报错", r.content[0].text.includes("失败"), r.content[0].text.slice(0, 80));
	// 解锁后写读
	cryptoMod.unlockVault("口令x", setup);
	r = await tool("kb_write").execute("16", { path: "/vault/密分类/测试/密.md", content: "---\ntitle: 密\ntags: []\n---\n机密内容：勿外传。\n" }, undefined, undefined, ctx);
	check("解锁后写 vault 成功", r.content[0].text.includes("已写入"), r.content[0].text.slice(0, 60));
	check("vault 明文未落盘", !existsSync(join(mirrorDir, "vault", "密分类", "测试", "密.md")));
	check("vault .enc 已落盘", existsSync(join(mirrorDir, "vault", "密分类", "测试", "密.md.enc")));
	r = await tool("kb_read").execute("17", { path: "/vault/密分类/测试/密.md" }, undefined, undefined, ctx);
	check("解锁后读 vault 解密", r.content[0].text.includes("勿外传"), r.content[0].text.slice(0, 60));

	// ---- vault 锁定后读报错 ----
	cryptoMod.lockVault();
	r = await tool("kb_read").execute("18", { path: "/vault/密分类/测试/密.md" }, undefined, undefined, ctx);
	check("锁定后读 vault 报错", r.content[0].text.includes("未解锁"), r.content[0].text.slice(0, 80));

	// ---- kb_help 读 PROTOCOL.md（存在时优先） ----
	writeFileSync(join(mirrorDir, "PROTOCOL.md"), "# 自定义协议\nAI 自定的使用守则。\n", "utf8");
	r = await tool("kb_help").execute("19", {}, undefined, undefined, ctx);
	check("kb_help 优先 PROTOCOL.md", r.content[0].text.includes("自定义协议"), r.content[0].text.slice(0, 60));

	// ---- kb_read 分页（offset） ----
	const longNote = "---\ntitle: 长文\ntags: []\n---\n" + "字".repeat(100);
	await tool("kb_write").execute("20", { path: "/notes/长文分类/测试/长文.md", content: longNote }, undefined, undefined, ctx);
	r = await tool("kb_read").execute("21", { path: "/notes/长文分类/测试/长文.md", offset: 20 }, undefined, undefined, ctx);
	check("kb_read offset 生效", r.content[0].text.includes("21-") && r.content[0].text.includes("/ 共"), r.content[0].text.slice(0, 60));
	check("kb_read offset 内容正确", r.content[0].text.includes("字".repeat(5)) && !r.content[0].text.startsWith("---"), r.content[0].text.slice(0, 60));
	r = await tool("kb_read").execute("22", { path: "/notes/长文分类/测试/长文.md", offset: 99999 }, undefined, undefined, ctx);
	check("kb_read offset 越界提示", r.content[0].text.includes("没有更多内容"), r.content[0].text.slice(0, 60));

	// ---- kb_import 批量导入 ----
	const importDir = join(tmp, "import-src");
	mkdirSync(join(importDir, "学校论文要求"), { recursive: true });
	writeFileSync(join(importDir, "学校论文要求", "论文格式.md"), "# 论文格式要求\n正文内容\n");
	writeFileSync(join(importDir, "学校论文要求", "引用规范.md"), "---\ntitle: 已有标题\ntags: [已有]\n---\n保留 frontmatter\n");
	writeFileSync(join(importDir, "学校论文要求", "说明.txt"), "txt 也要导入\n");
	writeFileSync(join(importDir, "学校论文要求", "配图.png"), "not text");
	r = await tool("kb_import").execute("23", { sourceDir: importDir, namespace: "/references" }, undefined, undefined, ctx);
	check("kb_import 导入成功数", r.content[0].text.includes("3 成功"), r.content[0].text.slice(0, 80));
	// 目录结构 + frontmatter 自动生成
	const imported1 = readFileSync(join(mirrorDir, "references", "学校论文要求", "论文格式.md"), "utf8");
	check("kb_import 自动 frontmatter", imported1.startsWith("---\ntitle: 论文格式"), imported1.slice(0, 60));
	const imported2 = readFileSync(join(mirrorDir, "references", "学校论文要求", "引用规范.md"), "utf8");
	check("kb_import 保留已有 frontmatter", imported2.includes("已有标题"), imported2.slice(0, 60));
	check("kb_import txt 导入", existsSync(join(mirrorDir, "references", "学校论文要求", "说明.txt")));
	check("kb_import 非文本跳过", r.content[0].text.includes("3 成功") && !r.content[0].text.includes("png"));
	// 再次导入（同名跳过）
	r = await tool("kb_import").execute("24", { sourceDir: importDir, namespace: "/references" }, undefined, undefined, ctx);
	check("kb_import 同名跳过", r.content[0].text.includes("0 成功") && r.content[0].text.includes("3 跳过"), r.content[0].text.slice(0, 80));
	// mode=overwrite 覆盖
	r = await tool("kb_import").execute("25", { sourceDir: importDir, namespace: "/references", mode: "overwrite" }, undefined, undefined, ctx);
	check("kb_import overwrite 覆盖", r.content[0].text.includes("3 成功"), r.content[0].text.slice(0, 80));

	// ---- kb_delete ----
	// 未确认拒绝
	r = await tool("kb_delete").execute("26", { path: "/notes/长文分类/测试/长文.md" }, undefined, undefined, ctx);
	check("kb_delete 需 confirm", r.content[0].text.includes("confirm:true"), r.content[0].text.slice(0, 60));
	// 确认删除
	r = await tool("kb_delete").execute("27", { path: "/notes/长文分类/测试/长文.md", confirm: true }, undefined, undefined, ctx);
	check("kb_delete 删除成功", r.content[0].text.includes("已删除"), r.content[0].text.slice(0, 60));
	check("kb_delete 本地镜像删", !existsSync(join(mirrorDir, "notes", "长文分类", "测试", "长文.md")));
	check("kb_delete 远端删", !dav.store.has(dav.prefix + "/notes/长文分类/测试/长文.md"));
	check("kb_delete 审计日志", existsSync(join(mirrorDir, ".kb-delete-log")));
	check("kb_delete 账本清条目", !JSON.parse(readFileSync(join(mirrorDir, ".kb-sync.json"), "utf8")).files["/notes/长文分类/测试/长文.md"]);
	// lfs 删除引导
	r = await tool("kb_delete").execute("28", { path: "/lfs/x.png", confirm: true }, undefined, undefined, ctx);
	check("kb_delete lfs 引导", r.content[0].text.includes("WebDAV"), r.content[0].text.slice(0, 60));

	// ---- 新格式：csv/json 写入无需 frontmatter，导入原样不加工 ----
	r = await tool("kb_write").execute("30", { path: "/notes/数据分类/表格/城市.csv", content: "城市,人口\n杭州,1200万\n" }, undefined, undefined, ctx);
	check("kb_write csv 无需 frontmatter", r.content[0].text.includes("已写入"), r.content[0].text.slice(0, 60));
	check("kb_write csv 原样落盘", readFileSync(join(mirrorDir, "notes", "数据分类", "表格", "城市.csv"), "utf8").startsWith("城市,人口"));
	r = await tool("kb_write").execute("31", { path: "/notes/数据分类/表格/汇率.json", content: '{"usd_cny": 7.25}\n' }, undefined, undefined, ctx);
	check("kb_write json 无需 frontmatter", r.content[0].text.includes("已写入"), r.content[0].text.slice(0, 60));
	r = await tool("kb_write").execute("32", { path: "/notes/数据分类/表格/无fm.md", content: "没有 frontmatter" }, undefined, undefined, ctx);
	check("kb_write md 仍强制 frontmatter", r.content[0].text.includes("frontmatter"), r.content[0].text.slice(0, 60));
	const importDir2 = join(tmp, "import-csv");
	mkdirSync(join(importDir2, "数据表格"), { recursive: true });
	writeFileSync(join(importDir2, "数据表格", "城市.csv"), "城市,人口\n杭州,1200万\n");
	writeFileSync(join(importDir2, "数据表格", "配置.yaml"), "port: 8080\n");
	r = await tool("kb_import").execute("33", { sourceDir: importDir2, namespace: "/notes" }, undefined, undefined, ctx);
	check("kb_import 表格/数据格式导入成功", r.content[0].text.includes("2 成功"), r.content[0].text.slice(0, 80));
	check("kb_import csv 原样保留（不自动补 frontmatter）", readFileSync(join(mirrorDir, "notes", "数据表格", "城市.csv"), "utf8").startsWith("城市,人口"));
	check("kb_import yaml 原样保留", readFileSync(join(mirrorDir, "notes", "数据表格", "配置.yaml"), "utf8").startsWith("port: 8080"));

	// ---- kb_status ----
	r = await tool("kb_status").execute("29", {}, undefined, undefined, ctx);
	check("kb_status 返回摘要", r.content[0].text.includes("上次同步") && r.content[0].text.includes("笔记总数"), r.content[0].text.slice(0, 80));
} finally {
	delete process.env.KB_CONFIG_DIR;
	dav.close();
	try {
		rmSync(outfile, { force: true });
	} catch {
		/* 清理测试 bundle */
	}
	rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
