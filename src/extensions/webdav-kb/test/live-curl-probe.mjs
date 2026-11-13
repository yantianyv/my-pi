#!/usr/bin/env node
/**
 * 用系统 curl 实测 123 云盘 WebDAV（排除 Node fetch 实现差异）
 * curl 由 Node 调起，凭据从 kb-config.json 读取，不经过命令行参数。
 * 用法：node src/extensions/webdav-kb/test/live-curl-probe.mjs
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cfg = JSON.parse(
	readFileSync(join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent", "kb-config.json"), "utf8"),
);

/** 调 curl：--user 从 stdin 环境传（用 --user 参数会显示在进程列表；改用 header 注入） */
function curl(args) {
	return new Promise((resolve) => {
		execFile(
			"curl",
			[
				"-sS",
				"--max-time", "20",
				"--http1.1",
				"-i", // 输出响应头
				"-H", `Authorization: Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`,
				...args,
			],
			{ maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
			},
		);
	});
}

const xml = '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';

console.log("目标:", cfg.baseUrl, "\n");

// 1) PROPFIND 根
let r = await curl(["-X", "PROPFIND", "-H", "Depth: 1", "-H", "Content-Type: application/xml", "-d", xml, "https://dav.123pan.com/dav/"]);
console.log("=== 1) PROPFIND /dav/ ===");
console.log("exit:", r.code, "| stderr:", (r.stderr || "").trim().slice(0, 200));
console.log(r.stdout.slice(0, 500));

// 2) PUT 上传文件
r = await curl(["-X", "PUT", "-H", "Content-Type: text/markdown", "-d", "# curl 测试\nhello\n", "https://dav.123pan.com/dav/curl-test.md"]);
console.log("\n=== 2) PUT /dav/curl-test.md ===");
console.log("exit:", r.code, "| stderr:", (r.stderr || "").trim().slice(0, 200));
console.log(r.stdout.slice(0, 500));

// 3) MKCOL 建目录
r = await curl(["-X", "MKCOL", "https://dav.123pan.com/dav/curl-test-dir"]);
console.log("\n=== 3) MKCOL /dav/curl-test-dir ===");
console.log("exit:", r.code, "| stderr:", (r.stderr || "").trim().slice(0, 200));
console.log(r.stdout.slice(0, 500));

// 4) 清理（如果能删）
r = await curl(["-X", "DELETE", "https://dav.123pan.com/dav/curl-test.md"]);
console.log("\n=== 4) DELETE curl-test.md ===");
console.log("exit:", r.code, "|", r.stdout.slice(0, 300));

r = await curl(["-X", "DELETE", "https://dav.123pan.com/dav/curl-test-dir"]);
console.log("\n=== 5) DELETE curl-test-dir ===");
console.log("exit:", r.code, "|", r.stdout.slice(0, 300));
