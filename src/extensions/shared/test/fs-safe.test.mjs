#!/usr/bin/env node
/**
 * shared/fs-safe 回归测试：删除类操作在中文路径下必须真的删掉
 *
 * 锁住的不变量：
 * - removePath 能删掉**路径含中文**的文件与目录树（本机 fs.rmSync 在这种路径下静默失败，
 *   所以这里刻意把探针建在含中文的临时目录里；换成 rmSync 实现本测试会失败）
 * - 目标不存在时返回 true；符号链接/junction 只删链接本身，不跟进删目标
 *
 * 用法：node src/extensions/shared/test/fs-safe.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SHARED_DIR = join(TEST_DIR, "..");
const SRC_DIR = join(SHARED_DIR, "../..");
const BUNDLE = join(TEST_DIR, ".tmp-fs-safe-bundle.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

await build({
	entryPoints: [join(SHARED_DIR, "fs-safe.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
const { removePath } = await import(pathToFileURL(BUNDLE).href);

// 探针根目录刻意含中文：本机 rmSync 正是在这种路径下静默不删
const ROOT = mkdtempSync(join(tmpdir(), "fs-safe-中文-探针-"));
check("导出 removePath", typeof removePath === "function");
check("探针路径含中文（复现前提）", /[^\u0000-\u007f]/.test(ROOT), ROOT);

// ---- 文件 ----
const file = join(ROOT, "单文件.txt");
writeFileSync(file, "x");
check("删除中文路径下的文件", removePath(file) === true && !existsSync(file), file);

// ---- 目录树 ----
const tree = join(ROOT, "目录树", "子目录");
mkdirSync(tree, { recursive: true });
writeFileSync(join(tree, "a.txt"), "x");
writeFileSync(join(ROOT, "目录树", "b.json"), "{}");
check("删除目录树（含嵌套与多文件）", removePath(join(ROOT, "目录树")) === true && !existsSync(join(ROOT, "目录树")));

// ---- 不存在 ----
check("目标不存在返回 true", removePath(join(ROOT, "本来就没有")) === true);

// ---- 链接：只删链接，不跟进目标 ----
const target = join(ROOT, "链接目标");
mkdirSync(target, { recursive: true });
writeFileSync(join(target, "keep.txt"), "x");
const link = join(ROOT, "链接");
let linked = false;
try {
	symlinkSync(target, link, "junction"); // junction 无需管理员权限
	linked = true;
} catch {
	try {
		symlinkSync(target, link, "dir");
		linked = true;
	} catch {
		/* 该文件系统不支持链接（如部分 D: 卷）：跳过，不算失败 */
	}
}
if (linked) {
	check("删链接不跟进目标（目标文件仍在）", removePath(link) === true && !existsSync(link) && existsSync(join(target, "keep.txt")));
} else {
	console.log("  - 跳过链接用例（本机文件系统建不了链接）");
}
removePath(target);
removePath(ROOT);

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
