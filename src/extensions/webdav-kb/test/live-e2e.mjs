#!/usr/bin/env node
/**
 * webdav-kb 真实环境端到端实测脚本（123 云盘）
 * 用法：node src/extensions/webdav-kb/test/live-e2e.mjs
 * 流程：引导 PROTOCOL.md → 同步 → AI 写入真实笔记 → 检索命中 → 二次同步幂等
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Projects/开发工具/my_pi";
const { build } = await import(pathToFileURL(join(ROOT, "src/node_modules/esbuild/lib/main.js")).href);

const tmp = mkdtempSync(join(tmpdir(), "kb-e2e-"));
const out = join(tmp, "bundle.mjs");
const entry = join(tmp, "entry.ts");
const rel = (p) => p.replace(/\\/g, "/");
writeFileSync(
	entry,
	[
		'export * from "' + rel(join(ROOT, "src/extensions/webdav-kb/sync.ts")) + '";',
		'export * from "' + rel(join(ROOT, "src/extensions/webdav-kb/search.ts")) + '";',
		'export { DEFAULT_PROTOCOL, PROTOCOL_HEADER } from "' + rel(join(ROOT, "src/extensions/webdav-kb/protocol.ts")) + '";',
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
	tsconfig: join(ROOT, "src/config/tsconfig.build.json"),
	logLevel: "silent",
});
const {
	syncAll, putNote, readNote, getIndex, loadConfig, agentConfigDir, defaultMirrorDir, DEFAULT_PROTOCOL, PROTOCOL_HEADER,
} = await import(pathToFileURL(out).href);

const cfg = loadConfig(agentConfigDir());
if (!cfg.baseUrl || !cfg.username || !cfg.password) {
	console.error("配置不完整，请先 /kb-config");
	process.exit(1);
}
const mirror = cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
const step = (s) => console.log("\n▶", s);

// 1) 引导 PROTOCOL.md（模拟 index.ts ensureProtocol）
step("1) 引导 PROTOCOL.md 上传");
if (readNote(mirror, "/PROTOCOL.md") === null) {
	const etag = await putNote(cfg, mirror, "/PROTOCOL.md", PROTOCOL_HEADER + DEFAULT_PROTOCOL);
	console.log("  PROTOCOL.md 写入本地 + 上传", etag ? "(远端 etag: " + etag + ")" : "(离线?)");
} else {
	console.log("  本地已有 PROTOCOL.md（不重复引导）");
}

// 2) 同步
step("2) 同步");
let s = await syncAll(cfg, mirror);
console.log("  下载:", s.downloaded, "上传:", s.uploaded, "删除:", s.deleted, "冲突:", s.conflicts, "错误:", s.errors.length);
if (s.errors.length) s.errors.forEach((e) => console.log("   !", e));
console.log("  本地 PROTOCOL.md 存在:", readNote(mirror, "/PROTOCOL.md") !== null);

// 3) AI 写入真实笔记（kb_write 同款通道）
step("3) kb_write 通道写入真实笔记");
const note =
	"---\ntitle: 123云盘WebDAV实测\ntags: [webdav, 实测]\n---\n"
	+ "## 现象\n123云盘的 WebDAV 地址是 https://webdav.123pan.cn/webdav，Basic 认证。\n"
	+ "## 结论\n连通正常，同步耗时 <1s。\n";
const etag = await putNote(cfg, mirror, "/notes/123云盘-webdav-实测.md", note);
console.log("  已写入（本地 + PUT 远端）", etag ? `etag=${etag}` : "(etag 缺失!)");
// 诊断：putNote 后账本里该条目的状态
const { loadLedger } = await import(pathToFileURL(out).href);
const after = loadLedger(mirror);
const e2 = after.files["/notes/123云盘-webdav-实测.md"];
console.log("  账本条目: etag=", e2?.etag ?? "(无)", "localMtime=", e2?.localMtime, "本地mtime=", (await import("node:fs")).statSync(join(mirror, "notes", "123云盘-webdav-实测.md")).mtimeMs);

// 4) 检索命中
step("4) kb_search 检索");
const idx = getIndex(mirror);
const results = idx.search("123云盘");
console.log("  命中:", results.length, "篇");
results.slice(0, 3).forEach((r) => console.log("   -", r.path, "(score", r.score + ")", "片段:", r.snippet.slice(0, 50)));

// 5) 二次同步幂等
step("5) 二次同步（应 0 变化）");
s = await syncAll(cfg, mirror);
console.log("  下载:", s.downloaded, "上传:", s.uploaded, "无变化:", s.unchanged, "错误:", s.errors.length);
if (s.errors.length) s.errors.forEach((e) => console.log("   !", e));

rmSync(tmp, { recursive: true, force: true });
