#!/usr/bin/env node
/**
 * webdav-kb / commands.ts 配置命令测试（esbuild bundle + mock pi + mock DAV）
 *
 * 覆盖：命令注册、非 TUI 文本面板（摘要 + TUI 面板提示）、无子命令（参数被忽略，
 * 不解析不持久化）、/kb-sync 手动同步、未配置引导。
 * （面板本身的字段编辑/vault 口令/连通测试/立即同步等行为由 panel-config.test.mjs 覆盖）
 *
 * 用法：node src/extensions/webdav-kb/test/commands.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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

function makeCtx(captures = {}) {
	return {
		cwd: process.cwd(),
		hasUI: false,
		mode: "print",
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

const tmp = mkdtempSync(join(tmpdir(), "kb-commands-test-"));
const dav = await startMockDav();
try {
	const configDir = join(tmp, "agent");
	mkdirSync(configDir, { recursive: true });
	const mirrorDir = join(tmp, "mirror");
	process.env.KB_CONFIG_DIR = configDir;

	const outfile = join(TEST_DIR, ".tmp-kb-cmd-bundle.mjs");
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
	const mod = await import(pathToFileURL(outfile).href);
	const pi = makePi();
	mod.default(pi);
	const cmd = (name) => pi.commands[name];

	// ---- 命令注册 ----
	check("注册 /kb-config", typeof cmd("kb-config")?.handler === "function");
	check("注册 /kb-sync", typeof cmd("kb-sync")?.handler === "function");

	// ---- 非 TUI 文本面板 ----
	const captures = {};
	const ctx = makeCtx(captures);
	await cmd("kb-config").handler("", ctx);
	check("非 TUI 显示配置摘要", captures.notify?.text.includes("WebDAV") && captures.notify?.text.includes("/kb-config"), captures.notify?.text.slice(0, 60));

	// ---- 无子命令：参数被忽略，不解析不持久化 ----
	const cfgFile = join(configDir, "kb-config.json");
	writeFileSync(cfgFile, "{}", "utf8"); // 初始空配置（面板保存路径由 panel-config.test.mjs 覆盖）
	await cmd("kb-config").handler("url " + dav.baseUrl, ctx);
	await cmd("kb-config").handler("user test-user", ctx);
	await cmd("kb-config").handler("pass test-pass", ctx);
	await cmd("kb-config").handler("mirror " + mirrorDir, ctx);
	await cmd("kb-config").handler("vault 口令abc", ctx);
	const cfgAfter = JSON.parse(readFileSync(cfgFile, "utf8"));
	check("传参不解析不持久化（无子命令）", !cfgAfter.baseUrl && !cfgAfter.username && !cfgAfter.password && !cfgAfter.mirrorDir && !cfgAfter.vault, JSON.stringify(cfgAfter));
	// 任意参数同样被忽略，仍走非 TUI 摘要 + TUI 面板提示
	const cap5 = {};
	await cmd("kb-config").handler("foobar", makeCtx(cap5));
	check("任意参数忽略并提示 TUI 面板", cap5.notify?.text.includes("TUI") && cap5.notify?.text.includes("/kb-config"), cap5.notify?.text.slice(0, 60));

	// ---- /kb-sync 手动同步（配置直接写入，模拟面板已保存） ----
	writeFileSync(cfgFile, JSON.stringify({ baseUrl: dav.baseUrl, username: "test-user", password: "test-pass", mirrorDir }), "utf8");
	dav.seed("/notes/synced.md", "---\ntitle: 同步测试\ntags: []\n---\n内容\n");
	const cap4 = {};
	await cmd("kb-sync").handler("", makeCtx(cap4));
	check("/kb-sync 下载文件", existsSync(join(mirrorDir, "notes", "synced.md")));

	// ---- 未配置 /kb-sync ----
	writeFileSync(cfgFile, "{}", "utf8");
	const cap6 = {};
	await cmd("kb-sync").handler("", makeCtx(cap6));
	check("未配置 /kb-sync 引导", cap6.notify?.text.includes("/kb-config"), cap6.notify?.text.slice(0, 50));
} finally {
	delete process.env.KB_CONFIG_DIR;
	dav.close();
	try {
		rmSync(outfile, { force: true });
	} catch {
		/* 清理 bundle */
	}
	rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
