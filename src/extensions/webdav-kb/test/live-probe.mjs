#!/usr/bin/env node
/**
 * 探测 123 云盘 WebDAV 能力边界（真实请求）
 * 用法：node src/extensions/webdav-kb/test/live-probe.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Projects/开发工具/my_pi";
const { build } = await import(pathToFileURL(join(ROOT, "src/node_modules/esbuild/lib/main.js")).href);
const tmp = mkdtempSync(join(tmpdir(), "kb-probe-"));
const out = join(tmp, "client.mjs");
await build({
	entryPoints: [join(ROOT, "src/extensions/webdav-kb/client.ts")],
	outfile: out,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	tsconfig: join(ROOT, "src/config/tsconfig.build.json"),
	logLevel: "silent",
});
const { WebDavClient, DavError } = await import(pathToFileURL(out).href);

// 直接从配置读凭据
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cfgPath = join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent", "kb-config.json");
const cfg = JSON.parse(require("node:fs").readFileSync(cfgPath, "utf8"));

const c = new WebDavClient(cfg.baseUrl, cfg.username, cfg.password, { retries: 0, timeoutMs: 15_000 });
const probe = async (label, fn) => {
	try {
		const r = await fn();
		console.log(`✓ ${label} →`, r === undefined ? "ok" : JSON.stringify(r).slice(0, 120));
	} catch (e) {
		console.log(`✗ ${label} → ${e instanceof DavError ? `HTTP ${e.status} ${e.message}` : e.message}`);
	}
};

console.log("目标:", cfg.baseUrl);
await probe("PROPFIND 根 (list /)", () => c.list("/").then((f) => f.map((x) => `${x.path}${x.isDir ? "/" : ""}`)));
await probe("MKCOL /probe-dir", () => c.mkdir("/probe-dir"));
await probe("PUT /probe-dir/x.md", () => c.put("/probe-dir/x.md", "# probe\n").then(() => "put ok"));
await probe("stat /probe-dir/x.md", () => c.stat("/probe-dir/x.md").then((f) => (f ? `size=${f.size} etag=${f.etag}` : "null")));
await probe("GET /probe-dir/x.md", () => c.get("/probe-dir/x.md").then((r) => new TextDecoder().decode(r.data).slice(0, 20)));
await probe("PUT /x-root.md (根)", () => c.put("/x-root.md", "root test\n").then(() => "put root ok"));
await probe("MOVE /probe-dir/x.md → /probe-dir/y.md", () => c.move("/probe-dir/x.md", "/probe-dir/y.md"));
await probe("DELETE /probe-dir/y.md", () => c.delete("/probe-dir/y.md"));
await probe("DELETE /probe-dir", () => c.delete("/probe-dir"));
await probe("DELETE /x-root.md", () => c.delete("/x-root.md"));

rmSync(tmp, { recursive: true, force: true });
