#!/usr/bin/env node
/**
 * webdav-kb / panel-config.ts 单页表单面板测试（esbuild bundle + theme/tui mock + mock DAV）
 *
 * 覆盖：单页渲染（所有输入框同页、无二级）、直接打字即改即存、↑↓ 焦点移动、
 * Enter 下移/执行、密码与 vault 掩码、vault 行输入口令 Enter 启用解锁、
 * 动作项（测试连通/立即同步/vault-lock/修改口令）执行、Esc 关闭。
 *
 * 用法：node src/extensions/webdav-kb/test/panel-config.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
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

const themeMock = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const fakeTui = { terminal: { rows: 30 }, requestRender: () => {} };

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

async function waitIdle(overlay, timeoutMs = 8000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (!overlay.working) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

const tmp = mkdtempSync(join(tmpdir(), "kb-cfg-panel-test-"));
const dav = await startMockDav();
let outfile;
try {
	const configDir = join(tmp, "agent");
	mkdirSync(configDir, { recursive: true });
	const mirrorDir = join(tmp, "mirror");
	process.env.KB_CONFIG_DIR = configDir;
	const cfgFile = join(configDir, "kb-config.json");

	outfile = join(TEST_DIR, ".tmp-kb-cfg-panel.mjs");
	const entry = join(tmp, "entry.ts");
	writeFileSync(
		entry,
		[
			'export * from "' + join(SRC_DIR, "extensions", "webdav-kb", "panel-config.ts").replace(/\\/g, "/") + '";',
			'export { createVault, unlockVault, isUnlocked, lockVault } from "' + join(SRC_DIR, "extensions", "webdav-kb", "crypto.ts").replace(/\\/g, "/") + '";',
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
	const { KbConfigOverlay } = mod;

	// 初始配置
	const cfg = { baseUrl: "", username: "", password: "" };
	writeFileSync(cfgFile, JSON.stringify(cfg), "utf8");
	let doneResult = "unset";
	const overlay = new KbConfigOverlay(fakeTui, themeMock, cfg, (r) => (doneResult = r));

	// ---- 单页渲染：所有输入框同页 ----
	const lines = assertRender(overlay, "单页表单", 80);
	check("单页显示全部字段", ["WebDAV 地址", "用户名", "密码", "HTTP 代理", "镜像目录", "vault 口令"].every((l) => lines.some((x) => x.includes(l))), lines.join("|").slice(0, 100));
	check("动作项同页", lines.some((l) => l.includes("测试连通")) && lines.some((l) => l.includes("立即同步")));
	check("焦点在第一个字段（反显）", lines.some((l) => l.includes("\x1b[7m") && l.includes("WebDAV")));
	check("无二级页面（同一 render 含输入框与动作）", overlay.render(80).length === lines.length);

	// ---- 直接打字即改即存（焦点 0 = WebDAV 地址） ----
	// 清空初始 seed（默认填充 dav.123pan.com）
	for (let i = 0; i < 40; i++) overlay.handleInput("\x7f"); // DEL 逐个删
	for (const ch of "https://dav.example.com/dav") overlay.handleInput(ch);
	let cfgNow = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("地址输入即保存", cfgNow.baseUrl === "https://dav.example.com/dav", JSON.stringify(cfgNow));
	check("光标跟随", overlay.cursors.baseUrl === "https://dav.example.com/dav".length, String(overlay.cursors.baseUrl));

	// ---- 粘贴（bracketed paste 整段） ----
	for (let i = 0; i < 40; i++) overlay.handleInput("\x7f");
	overlay.handleInput("\x1b[200~https://pasted.example.org/root\x1b[201~");
	cfgNow = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("粘贴整段插入", cfgNow.baseUrl === "https://pasted.example.org/root", JSON.stringify(cfgNow));
	check("粘贴光标落在末尾", overlay.cursors.baseUrl === "https://pasted.example.org/root".length, String(overlay.cursors.baseUrl));
	// 粘贴含换行压成空格
	for (let i = 0; i < 40; i++) overlay.handleInput("\x7f");
	overlay.handleInput("\x1b[200~abc\r\ndef\x1b[201~");
	cfgNow = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("粘贴换行压空格", cfgNow.baseUrl === "abc def", JSON.stringify(cfgNow));
	// 无标记整段文本（部分终端直接送）
	for (let i = 0; i < 40; i++) overlay.handleInput("\x7f");
	overlay.handleInput("direct-paste-text");
	cfgNow = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("无标记整段粘贴", cfgNow.baseUrl === "direct-paste-text", JSON.stringify(cfgNow));
	// 焦点在动作上时粘贴被忽略（不误写字段）
	overlay.handleInput("\x1b[B");
	overlay.handleInput("\x1b[B");
	overlay.handleInput("\x1b[B");
	overlay.handleInput("\x1b[B");
	overlay.handleInput("\x1b[B");
	overlay.handleInput("\x1b[B"); // 到动作区（测试连通）
	overlay.handleInput("\x1b[200~ignored\x1b[201~");
	cfgNow = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("动作上粘贴被忽略", cfgNow.baseUrl === "direct-paste-text", JSON.stringify(cfgNow));
	// 焦点回字段区（粘贴测试把焦点带到了动作区）
	while (overlay.focus > 0) overlay.handleInput("\x1b[A");
	check("焦点已回字段 0", overlay.focus === 0, String(overlay.focus));

	// ---- ↑↓ 焦点移动 ----
	overlay.handleInput("\x1b[B"); // 用户名
	check("↓ 焦点到用户名", overlay.focus === 1, String(overlay.focus));
	overlay.handleInput("\x1b[B"); // 密码
	overlay.handleInput("\x1b[B"); // 代理
	check("↓ 连续移动", overlay.focus === 3, String(overlay.focus));
	overlay.handleInput("\x1b[A");
	check("↑ 回移", overlay.focus === 2, String(overlay.focus));

	// ---- 密码行：掩码 + 输入保存 ----
	for (const ch of "secret-pass") overlay.handleInput(ch);
	cfgNow = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("密码输入即保存", cfgNow.password === "secret-pass");
	const masked = overlay.render(80).some((l) => l.includes("●"));
	check("密码焦点行掩码", masked);

	// ---- 用户名行输入 ----
	overlay.handleInput("\x1b[A"); // 用户名
	for (const ch of "my-user") overlay.handleInput(ch);
	cfgNow = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("用户名输入即保存", cfgNow.username === "my-user");

	// ---- vault 行：输入口令 Enter 启用并解锁 ----
	while (overlay.focus < 5) overlay.handleInput("\x1b[B"); // 到 vault
	for (const ch of "vault-pass-123") overlay.handleInput(ch);
	check("vault 输入被掩码", overlay.render(80).some((l) => l.includes("●")));
	overlay.handleInput("\r");
	cfgNow = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("vault setup 已保存", Boolean(cfgNow.vault?.salt) && Boolean(cfgNow.vault?.check));
	check("vault 已解锁", mod.isUnlocked());
	check("vault 行 Enter 后清空缓冲", overlay.bufs.vault === "");

	// ---- 动作：测试连通（真实 mock dav） ----
	const cfgFull = { ...JSON.parse(readFileSync(cfgFile, "utf8")), baseUrl: dav.baseUrl, username: "test-user", password: "test-pass", mirrorDir };
	writeFileSync(cfgFile, JSON.stringify(cfgFull), "utf8");
	const overlay2 = new KbConfigOverlay(fakeTui, themeMock, cfgFull, () => {});
	while (overlay2.focus < 6) overlay2.handleInput("\x1b[B"); // 到动作区第一个（测试连通）
	overlay2.handleInput("\r");
	check("测试连通进入 working", overlay2.working !== null);
	await waitIdle(overlay2);
	check("测试连通成功", overlay2.result?.includes("连通正常"), overlay2.result ?? "");

	// ---- 动作：立即同步 ----
	dav.seed("/notes/x.md", "---\ntitle: X\ntags: []\n---\n内容\n");
	overlay2.handleInput("\x1b[B"); // 立即同步
	overlay2.handleInput("\r");
	await waitIdle(overlay2);
	check("立即同步完成", overlay2.result?.includes("同步完成"), overlay2.result ?? "");
	check("同步下载到镜像", readFileSync(join(mirrorDir, "notes", "x.md"), "utf8").includes("内容"));

	// ---- 动作：vault-lock ----
	overlay2.handleInput("\x1b[B"); // 修改口令
	overlay2.handleInput("\x1b[B"); // 锁定 vault
	overlay2.handleInput("\r");
	check("vault-lock 锁定", !mod.isUnlocked());

	// ---- 修改口令：vault 已解锁时输入新口令 Enter = 覆盖 ----
	mod.unlockVault("vault-pass-123", JSON.parse(readFileSync(cfgFile, "utf8")).vault); // 先解锁
	overlay2.handleInput("\x1b[A"); // 回修改口令
	overlay2.handleInput("\r"); // 焦点移到 vault 字段并提示
	check("修改口令焦点回 vault 字段", overlay2.focus === 5, String(overlay2.focus));
	for (const ch of "new-pass-456") overlay2.handleInput(ch);
	overlay2.handleInput("\r");
	const cfg6 = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("新口令已解锁", mod.isUnlocked());
	mod.lockVault();
	check("旧口令失效", !mod.unlockVault("vault-pass-123", cfg6.vault));
	check("新口令可解锁", mod.unlockVault("new-pass-456", cfg6.vault));

	// ---- UX：vault 输入未 Enter → 失焦警告 + Esc 防误丢 ----
	let closed = false;
	const overlay3 = new KbConfigOverlay(fakeTui, themeMock, { baseUrl: "", username: "", password: "" }, () => { closed = true; });
	while (overlay3.focus < 5) overlay3.handleInput("\x1b[B"); // 到 vault
	for (const ch of "half-pass") overlay3.handleInput(ch);
	overlay3.handleInput("\x1b[B"); // 失焦到动作区
	check("未确认口令显示警告", overlay3.render(80).some((l) => l.includes("未确认")));
	overlay3.handleInput("\x1b[A"); // 回 vault 行
	overlay3.handleInput("\x1b"); // Esc 第一次
	check("Esc 第一次不关闭（提示再按）", !closed && overlay3.result?.includes("再按 Esc"));
	overlay3.handleInput("\x1b"); // Esc 第二次
	check("Esc 第二次关闭", closed);

	// ---- Esc 关闭 ----
	overlay.handleInput("\x1b");
	check("Esc 关闭回调 null", doneResult === null);
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
