#!/usr/bin/env node
/**
 * webdav-kb / live-proto-update.mjs — 检查并更新网盘根 PROTOCOL.md 到最新默认版
 * （旧版含 wf_note 越界引用，需替换为边界清晰的新版）
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Projects/开发工具/my_pi";
const { build } = await import(pathToFileURL(join(ROOT, "src/node_modules/esbuild/lib/main.js")).href);
const tmp = mkdtempSync(join(tmpdir(), "kb-proto-"));
const out = join(ROOT, "src/extensions/webdav-kb/test/.tmp-proto.mjs");
const entry = join(tmp, "e.ts");
const rel = (p) => p.replace(/\\/g, "/");
writeFileSync(
	entry,
	[
		'export { DEFAULT_PROTOCOL, PROTOCOL_HEADER } from "' + rel(join(ROOT, "src/extensions/webdav-kb/protocol.ts")) + '";',
		'export * from "' + rel(join(ROOT, "src/extensions/webdav-kb/sync.ts")) + '";',
		'export { loadConfig, agentConfigDir, defaultMirrorDir } from "' + rel(join(ROOT, "src/extensions/webdav-kb/store.ts")) + '";',
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
const { DEFAULT_PROTOCOL, PROTOCOL_HEADER, putNote, readNote, loadConfig, agentConfigDir, defaultMirrorDir } =
	await import(pathToFileURL(out).href);
const cfg = loadConfig(agentConfigDir());
const mirror = cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
const existing = readNote(mirror, "/PROTOCOL.md");
const latest = PROTOCOL_HEADER + DEFAULT_PROTOCOL;
console.log("本地 PROTOCOL.md 存在:", existing !== null);
const stale = !existing || existing !== latest;
if (stale) {
	console.log("协议与最新默认版不一致 → 更新（若用户自定义过会被覆盖，注意）");
	const etag = await putNote(cfg, mirror, "/PROTOCOL.md", latest);
	console.log("已更新，etag:", etag ?? "(离线?)");
} else {
	console.log("已是最新，无需更新");
}
rmSync(tmp, { recursive: true, force: true });
try {
	rmSync(out, { force: true });
} catch {
	/* 清理 */
}
