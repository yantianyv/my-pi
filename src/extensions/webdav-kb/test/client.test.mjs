#!/usr/bin/env node
/**
 * webdav-kb / client.ts 单元测试（共享 mock WebDAV 服务器 + esbuild bundle）
 *
 * 原理：node 无法直接 import 相对路径的 .ts，先用 esbuild（src/node_modules 构建
 * 依赖）把 client.ts bundle 成单文件 ESM 再 import；client.ts 只依赖 node 内置模块
 * （http/https/net/tls），bundle 后零外部依赖，node 直接跑。
 * mock 服务器见 test/mock-dav.mjs（挂在 /dav 前缀下，验证 href 前缀剥离逻辑）。
 *
 * 用法：node src/extensions/webdav-kb/test/client.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { startMockDav } from "./mock-dav.mjs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url)); // 如 C:\...\test\
const SRC_DIR = join(TEST_DIR, "../../.."); // src/

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
		failures++;
	}
};

const USER = "test-user";
const PASS = "test-pass";

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "kb-client-test-"));
try {
	// 1) bundle client.ts
	const outfile = join(tmp, "client.mjs");
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "webdav-kb", "client.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
	const { WebDavClient, DavError } = await import(pathToFileURL(outfile));

	// 2) 起 mock 服务器
	const dav = await startMockDav();
	try {
		const mk = (pw = PASS) => new WebDavClient(dav.baseUrl, USER, pw, { retries: 0 });
		const c = mk();

		// ---- 认证 ----
		await (async () => {
			const bad = mk("wrong-pass");
			let err = null;
			try {
				await bad.list("/");
			} catch (e) {
				err = e;
			}
			check("错误口令抛 DavError(401)", err instanceof DavError && err.status === 401, String(err?.status));
		})();

		// ---- mkdir + list ----
		await c.mkdir("/notes");
		await c.mkdir("/references");
		const root = await c.list("/");
		check("list 根目录含两个目录", root.length === 2 && root.every((f) => f.isDir), JSON.stringify(root));
		check("目录路径剥离 base 前缀", root.some((f) => f.path === "/notes") && root.some((f) => f.path === "/references"), JSON.stringify(root.map((f) => f.path)));

		// ---- put + stat + get（中文/空格文件名） ----
		const content = "# 测试笔记\n\n你好，WebDAV！\n";
		await c.put("/notes/测试 文件.md", content);
		const st = await c.stat("/notes/测试 文件.md");
		check("stat 返回文件", st !== null && !st.isDir, JSON.stringify(st));
		check("stat size 正确", st?.size === Buffer.byteLength(content), `size=${st?.size} want=${Buffer.byteLength(content)}`);
		check("stat 有 etag", typeof st?.etag === "string" && st.etag.length > 0);
		const got = await c.get("/notes/测试 文件.md");
		check("get 往返一致", new TextDecoder().decode(got.data) === content);
		check("get 返回 etag", got.etag === st?.etag, `get=${got.etag} stat=${st?.etag}`);
		const listNotes = await c.list("/notes");
		check("list /notes 含该文件", listNotes.length === 1 && listNotes[0].path === "/notes/测试 文件.md", JSON.stringify(listNotes));
		check("文件名 URL 编码无乱码", listNotes[0].path.includes("测试"));

		// ---- If-Match 并发保护 ----
		let conflict = null;
		try {
			await c.put("/notes/测试 文件.md", "新内容", { etag: "wrong-etag" });
		} catch (e) {
			conflict = e;
		}
		check("错误 etag PUT 抛 DavError(412)", conflict instanceof DavError && conflict.status === 412, String(conflict?.status));
		await c.put("/notes/测试 文件.md", "新内容", { etag: st.etag });
		const st2 = await c.stat("/notes/测试 文件.md");
		check("正确 etag PUT 成功且 etag 更新", st2?.etag !== st?.etag, `old=${st?.etag} new=${st2?.etag}`);

		// ---- move ----
		await c.move("/notes/测试 文件.md", "/notes/renamed.md");
		const oldSt = await c.stat("/notes/测试 文件.md");
		const newSt = await c.stat("/notes/renamed.md");
		check("move 后旧路径不存在", oldSt === null);
		check("move 后新路径存在", newSt !== null && newSt.size === Buffer.byteLength("新内容"), JSON.stringify(newSt));

		// ---- delete ----
		await c.delete("/notes/renamed.md");
		check("delete 后 stat 为 null", (await c.stat("/notes/renamed.md")) === null);
		await c.delete("/notes/renamed.md"); // 重复删除幂等
		check("重复 delete 不报错", true);

		// ---- 嵌套目录 ----
		await c.mkdir("/notes/sub");
		await c.put("/notes/sub/a.md", "sub content");
		const subList = await c.list("/notes");
		check("list /notes 含子目录", subList.some((f) => f.path === "/notes/sub" && f.isDir), JSON.stringify(subList));
		const sub = await c.list("/notes/sub");
		check("子目录内容正确", sub.length === 1 && sub[0].path === "/notes/sub/a.md", JSON.stringify(sub));

		// ---- 父目录缺失 ----
		let noParent = null;
		try {
			await c.put("/no-such-dir/x.md", "x");
		} catch (e) {
			noParent = e;
		}
		check("父目录缺失 PUT 抛 DavError", noParent instanceof DavError && noParent.status === 409, String(noParent?.status));

		// ---- 不存在目录 list 返回空 ----
		const emptyList = await c.list("/not-exists");
		check("不存在目录 list 返回 []", Array.isArray(emptyList) && emptyList.length === 0);

		// ---- mkdir 已存在 ----
		let exists = null;
		try {
			await c.mkdir("/notes");
		} catch (e) {
			exists = e;
		}
		check("重复 mkdir 抛 DavError(405)", exists instanceof DavError && exists.status === 405, String(exists?.status));

		// ---- ping ----
		await c.ping();
		check("ping 连通性测试通过", true);

		// ---- stat 根 ----
		const rootStat = await c.stat("/");
		check("stat 根目录", rootStat !== null && rootStat.isDir, JSON.stringify(rootStat));
	} finally {
		dav.close();
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
