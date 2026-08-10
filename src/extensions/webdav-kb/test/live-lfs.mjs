#!/usr/bin/env node
/**
 * webdav-kb / live-lfs.mjs — 真实环境（123 云盘）LFS 功能验证
 * 上传 → 列出 → 下载 → 清理，全流程走真实 WebDAV。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Projects/开发工具/my_pi";
const { build } = await import(pathToFileURL(join(ROOT, "src/node_modules/esbuild/lib/main.js")).href);
const tmp = mkdtempSync(join(tmpdir(), "kb-live-lfs-"));
const out = join(tmp, "bundle.mjs");
const entry = join(tmp, "entry.ts");
const rel = (p) => p.replace(/\\/g, "/");
writeFileSync(
	entry,
	[
		'export * from "' + rel(join(ROOT, "src/extensions/webdav-kb/lfs.ts")) + '";',
		'export { loadConfig, agentConfigDir, defaultMirrorDir } from "' + rel(join(ROOT, "src/extensions/webdav-kb/store.ts")) + '";',
		'export { WebDavClient, DavError } from "' + rel(join(ROOT, "src/extensions/webdav-kb/client.ts")) + '";',
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
const { getLfsFiles, touchLfsCache, formatSize, loadLfsCache } = await import(pathToFileURL(out).href);
const { loadConfig, agentConfigDir, defaultMirrorDir } = await import(pathToFileURL(out).href);
const { WebDavClient } = await import(pathToFileURL(out).href);

const cfg = loadConfig(agentConfigDir());
if (!cfg.baseUrl) {
	console.error("未配置，退出");
	process.exit(1);
}
const mirror = cfg.mirrorDir?.trim() || defaultMirrorDir(agentConfigDir());
const client = new WebDavClient(cfg.baseUrl, cfg.username, cfg.password);
console.log("目标:", cfg.baseUrl);

// 1) 上传一个真实文件
const content = Buffer.from("lfs 实测内容\n".repeat(100));
const path = "/lfs/live-test.txt";
await client.put(path, content);
touchLfsCache(mirror, { path, size: content.length });
console.log("✓ 上传:", path, formatSize(content.length));

// 2) 列表（force 刷新）
const files = await getLfsFiles(cfg, mirror, { force: true });
const hit = files.find((f) => f.path === path);
console.log("✓ 列表命中:", hit ? `${hit.path} ${formatSize(hit.size)}` : "未命中！");

// 3) 下载回本地对比
const { data } = await client.get(path);
const ok = Buffer.from(data).equals(content);
console.log("✓ 下载往返一致:", ok);

// 4) 清理
await client.delete(path);
console.log("✓ 已清理远端");
rmSync(tmp, { recursive: true, force: true });
