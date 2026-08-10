#!/usr/bin/env node
/**
 * webdav-kb / live-status.mjs — 真实环境验证新工具（kb_status / kb_lslfs）
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Projects/开发工具/my_pi";
const { build } = await import(pathToFileURL(join(ROOT, "src/node_modules/esbuild/lib/main.js")).href);
const tmp = mkdtempSync(join(tmpdir(), "kb-live-s-"));
const out = join(ROOT, "src/extensions/webdav-kb/test/.tmp-live-status.mjs");
const entry = join(tmp, "entry.ts");
const rel = (p) => p.replace(/\\/g, "/");
writeFileSync(
	entry,
	[
		'export { default } from "' + rel(join(ROOT, "src/extensions/webdav-kb/index.ts")) + '";',
	].join("\n"),
	"utf8",
);
await build({
	entryPoints: [entry],
	outfile: out,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(ROOT, "src/config/tsconfig.build.json"),
	logLevel: "silent",
});
const mod = await import(pathToFileURL(out).href);
const pi = { tools: [], registerTool(t) { this.tools.push(t); }, registerCommand() {}, on() {} };
mod.default(pi);
const ctx = { cwd: process.cwd(), hasUI: false, mode: "print", ui: { setStatus() {}, notify() {} } };

const status = pi.tools.find((t) => t.name === "kb_status");
const r = await status.execute("1", {}, undefined, undefined, ctx);
console.log("=== kb_status ===");
console.log(r.content[0].text);

const lslfs = pi.tools.find((t) => t.name === "kb_lslfs");
const r2 = await lslfs.execute("2", { force: true }, undefined, undefined, ctx);
console.log("\n=== kb_lslfs (force) ===");
console.log(r2.content[0].text);
rmSync(tmp, { recursive: true, force: true });
