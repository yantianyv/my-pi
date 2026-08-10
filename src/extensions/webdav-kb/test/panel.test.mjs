#!/usr/bin/env node
/**
 * webdav-kb / panel.ts 面板测试（esbuild bundle + theme/tui mock）
 *
 * 覆盖：搜索模式渲染（无崩溃/不超宽）、输入即搜、Enter 进预览（内容渲染）、
 * Esc 返回列表、↑↓ 选择、Enter 插入引用（done 回调带路径）、Esc 关闭（done null）、
 * Backspace 编辑、vault 锁定预览报错、非 TUI /kb 文本结果。
 *
 * 用法：node src/extensions/webdav-kb/test/panel.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

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

/** 纯文本 theme mock：样式 token 透传，不干扰宽度计算 */
const themeMock = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };

/** fake tui：只提供 requestRender 与 terminal.rows */
const fakeTui = { terminal: { rows: 30 }, requestRender: () => {} };

/** 断言渲染行不超宽 + 返回行数组 */
function assertRender(overlay, label, width = 80) {
	let lines = [];
	try {
		lines = overlay.render(width);
	} catch (e) {
		check(`${label}: 渲染不抛异常`, false);
		console.error("      →", e.message);
		return lines;
	}
	check(`${label}: 渲染不抛异常`, true);
	check(`${label}: 行数 > 0（${lines.length}）`, lines.length > 0);
	for (const [i, line] of lines.entries()) {
		const w = visibleWidth(line);
		if (w > width) {
			check(`${label}: 第 ${i} 行宽度 ${w} ≤ ${width}`, false);
			console.error("      →", JSON.stringify(line.slice(0, 60)));
		}
	}
	return lines;
}

const tmp = mkdtempSync(join(tmpdir(), "kb-panel-test-"));
try {
	const mirror = join(tmp, "mirror");
	const w = (rel, content) => {
		const abs = join(mirror, ...rel.split("/").filter(Boolean));
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	};
	w("/notes/加密实践.md", "---\ntitle: 加密实践记录\ntags: [安全]\n---\n加密实践：scrypt 派生密钥，密钥只存内存。\n");
	w("/notes/加密方案.md", "---\ntitle: 本地加密方案\ntags: [安全]\n---\n口令派生密钥 PBKDF2，AES-256-GCM 加密，口令只存在内存里。\n这是第二行内容，用于预览滚动。\n");
	w("/notes/webdav.md", "---\ntitle: WebDAV 速查\ntags: [webdav]\n---\nPROPFIND 列目录，PUT 上传，MKCOL 建目录。\n");
	w("/vault/秘密.md.enc", "encrypted-bytes");

	// bundle panel.ts（@earendil-works/* 外部，经 junction 解析）
	const outfile = join(TEST_DIR, ".tmp-kb-panel-bundle.mjs");
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "webdav-kb", "panel.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
	const { KbOverlay } = await import(pathToFileURL(outfile).href);

	// ---- 搜索模式 ----
	let doneResult = "unset";
	const overlay = new KbOverlay(fakeTui, themeMock, mirror, (r) => (doneResult = r));
	assertRender(overlay, "初始搜索框", 80);
	check("初始无结果", overlay.render(80).some((l) => l.includes("输入关键词")));

	// 输入「加密」
	for (const ch of "加密") overlay.handleInput(ch);
	assertRender(overlay, "输入后检索", 80);
	check("输入即搜命中", overlay.render(80).some((l) => l.includes("/notes/加密方案.md")));

	// 搜索框粘贴（bracketed paste 整段）
	overlay.handleInput("\x1b[200~webdav\x1b[201~");
	check("搜索框粘贴插入", overlay.query === "加密webdav", overlay.query);
	check("粘贴后触发检索", overlay.render(80).some((l) => l.includes("/notes/webdav.md")));
	// 换行粘贴压空格
	overlay.handleInput("\x1b[200~\r\n方案\r\x1b[201~");
	check("粘贴换行压空格", overlay.query === "加密webdav 方案 ", JSON.stringify(overlay.query));
	// 恢复原始 query（粘贴测试改变了结果排序，后续断言依赖 query="加密"）
	overlay.query = "加密";
	overlay.queryCursor = 2;
	overlay.applyFilter();
	check("恢复 query 后仍命中", overlay.results.length === 2, String(overlay.results.length));

	// ↑↓ 移动选择
	overlay.handleInput("\u001b[B"); // down
	check("↓ 移动选择", overlay.selectedIndex === 1, String(overlay.selectedIndex));
	overlay.handleInput("\u001b[A"); // up
	check("↑ 移动选择", overlay.selectedIndex === 0, String(overlay.selectedIndex));

	// ---- Enter 进预览 ----
	overlay.handleInput("\r");
	check("进入预览模式", overlay.mode === "preview", overlay.mode);
	const pv = assertRender(overlay, "预览内容", 80);
	check("预览渲染正文", pv.some((l) => l.includes("scrypt")), pv.slice(0, 5).join("|"));

	// 预览滚动
	overlay.handleInput("\u001b[B");
	check("预览 ↓ 滚动", overlay.previewOffset === 1, String(overlay.previewOffset));
	overlay.handleInput("\u001b[A");
	check("预览 ↑ 滚动", overlay.previewOffset === 0, String(overlay.previewOffset));

	// ---- Esc 返回列表 ----
	overlay.handleInput("\u001b");
	check("Esc 返回搜索模式", overlay.mode === "search", overlay.mode);

	// ---- Enter 插入引用（done 回调） ----
	overlay.handleInput("\r"); // 进预览
	overlay.handleInput("\r"); // 插入引用
	check("Enter 插入引用回调带路径", doneResult === "/notes/加密实践.md", String(doneResult));

	// ---- Esc 关闭（done null） ----
	let escResult = "unset";
	const ov2 = new KbOverlay(fakeTui, themeMock, mirror, (r) => (escResult = r));
	ov2.handleInput("\u001b");
	check("Esc 关闭回调 null", escResult === null);

	// ---- Backspace 编辑 ----
	const ov3 = new KbOverlay(fakeTui, themeMock, mirror, () => {});
	for (const ch of "加密方案") ov3.handleInput(ch);
	ov3.handleInput(""); // backspace (DEL)
	check("Backspace 删字", ov3.query === "加密方", ov3.query);

	// ---- vault 锁定预览报错（未解锁时 vaultReadNote 抛错 → 预览显示错误） ----
	const ov4 = new KbOverlay(fakeTui, themeMock, mirror, () => {});
	for (const ch of "秘密") ov4.handleInput(ch);
	check("vault 未解锁不在结果中（无解密钩子）", ov4.results.length === 0, JSON.stringify(ov4.results.map((r) => r.path)));

	// ---- 非 TUI /kb 文本结果（经 index 完整命令） ----
	const outfile2 = join(TEST_DIR, ".tmp-kb-panel-index.mjs");
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "webdav-kb", "index.ts")],
		outfile: outfile2,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
	const indexMod = await import(pathToFileURL(outfile2).href);
	const configDir = join(tmp, "agent");
	mkdirSync(configDir, { recursive: true });
	process.env.KB_CONFIG_DIR = configDir;
	writeFileSync(
		join(configDir, "kb-config.json"),
		JSON.stringify({ baseUrl: "http://mock", username: "u", password: "p", mirrorDir: mirror }),
		"utf8",
	);
	const pi = { tools: [], commands: {}, events: {}, registerTool() {}, registerCommand(n, c) { this.commands[n] = c; }, on() {} };
	indexMod.default(pi);
	const captures = {};
	const nctx = {
		hasUI: false,
		mode: "print",
		ui: { notify: (text, kind) => (captures.notify = { text, kind }) },
	};
	await pi.commands.kb.handler("加密", nctx);
	check("非 TUI /kb 返回结果", captures.notify?.text.includes("/notes/加密方案.md"), captures.notify?.text?.slice(0, 80));
	const cap2 = {};
	await pi.commands.kb.handler("", { hasUI: false, mode: "print", ui: { notify: (t, k) => (cap2.notify = { text: t, kind: k }) } });
	check("非 TUI /kb 无参提示用法", cap2.notify?.text.includes("/kb <查询词>"), cap2.notify?.text?.slice(0, 60));
} finally {
	delete process.env.KB_CONFIG_DIR;
	try {
		rmSync(join(TEST_DIR, ".tmp-kb-panel-bundle.mjs"), { force: true });
		rmSync(join(TEST_DIR, ".tmp-kb-panel-index.mjs"), { force: true });
	} catch {
		/* 清理 */
	}
	rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
