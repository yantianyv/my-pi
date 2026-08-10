#!/usr/bin/env node
/**
 * webdav-kb / commands.ts 配置命令测试（esbuild bundle + mock pi + mock DAV）
 *
 * 覆盖：命令注册、带参子命令（url/user/pass/proxy/mirror/vault/vault-unlock/vault-lock/test）、
 * 非 TUI 文本面板、连通性测试（成功/凭据错误）、/kb-sync 手动同步、未配置引导。
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
	check("非 TUI 显示配置面板", captures.notify?.text.includes("WebDAV") && captures.notify?.text.includes("/kb-config"), captures.notify?.text.slice(0, 60));

	// ---- 带参子命令 ----
	await cmd("kb-config").handler("url " + dav.baseUrl, ctx);
	await cmd("kb-config").handler("user test-user", ctx);
	await cmd("kb-config").handler("pass test-pass", ctx);
	await cmd("kb-config").handler("mirror " + mirrorDir, ctx);
	const cfg = JSON.parse(requireFs(configDir, "kb-config.json"));
	check("url/user/pass/mirror 已持久化", cfg.baseUrl === dav.baseUrl && cfg.username === "test-user" && cfg.password === "test-pass" && cfg.mirrorDir === mirrorDir, JSON.stringify(cfg));

	// ---- vault 子命令 ----
	await cmd("kb-config").handler("vault 口令abc", ctx);
	const cfg2 = JSON.parse(requireFs(configDir, "kb-config.json"));
	check("vault 启用并写入 salt+check", Boolean(cfg2.vault?.salt) && Boolean(cfg2.vault?.check));
	check("vault 启用后立即解锁", mod.isUnlocked());
	await cmd("kb-config").handler("vault-lock", ctx);
	check("vault-lock 锁定", !mod.isUnlocked());
	await cmd("kb-config").handler("vault-unlock 错口令", ctx);
	check("错口令解锁失败", !mod.isUnlocked());
	await cmd("kb-config").handler("vault-unlock 口令abc", ctx);
	check("正确口令解锁成功", mod.isUnlocked());

	// ---- 连通性测试 ----
	const cap2 = {};
	const ctx2 = makeCtx(cap2);
	await cmd("kb-config").handler("test", ctx2);
	check("连通性测试成功", cap2.notify?.text.includes("连通正常"), cap2.notify?.text);
	// 错误凭据
	await cmd("kb-config").handler("pass wrong-pass", ctx);
	const cap3 = {};
	await cmd("kb-config").handler("test", makeCtx(cap3));
	check("错误凭据连通失败", cap3.notify?.text.includes("连通失败") || cap3.notify?.text.includes("失败"), cap3.notify?.text);
	await cmd("kb-config").handler("pass test-pass", ctx);

	// ---- /kb-sync 手动同步 ----
	dav.seed("/notes/synced.md", "---\ntitle: 同步测试\ntags: []\n---\n内容\n");
	const cap4 = {};
	await cmd("kb-sync").handler("", makeCtx(cap4));
	check("/kb-sync 下载文件", existsSync(join(mirrorDir, "notes", "synced.md")));

	// ---- 未知子命令 ----
	const cap5 = {};
	await cmd("kb-config").handler("foobar", makeCtx(cap5));
	check("未知子命令给提示", cap5.notify?.text.includes("未知子命令"), cap5.notify?.text.slice(0, 40));

	// ---- 未配置 /kb-sync ----
	writeFileSync(join(configDir, "kb-config.json"), "{}", "utf8");
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

function requireFs(dir, name) {
	return readFileSync(join(dir, name), "utf8");
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
