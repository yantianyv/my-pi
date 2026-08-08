#!/usr/bin/env node
/**
 * 伪编译构建：把 src/ 源码组装成 dist/ 部署物（install.js 只认 dist/）
 *
 * 架构：源码层高复用（src/extensions/shared/ 共享模块被多个扩展 import 复用，
 * src/extensions/hud/ 多文件便于维护），本脚本用 esbuild 把每个扩展入口 + 其
 * 相对依赖内联打包成 dist/extensions/ 下的零耦合单文件 .ts（产物只保留对 pi
 * 官方包 @earendil-works/*、typebox 的外部引用，扩展之间互不依赖），并把
 * 静态部署物（themes/ sounds/ patches/ models.json）原样拷贝到 dist/。
 *
 * - 多文件扩展（src/extensions/hud/）的 index 入口打包成 <目录名>.ts 单文件，
 *   解决 hud 被拆分为子目录/子模块的问题——产物与其它扩展一致；
 * - 产物是 ESM（内容为 JS 语法的 .ts 文件），pi 经 jiti 加载，与手写源码无差异；
 * - tsconfig 用 tsconfig.build.json（无 paths）：主 tsconfig.json 的 paths 会把
 *   包名解析成 pi 全局目录绝对路径，导致 packages: "external" 的包名匹配失效、
 *   意外内联 typebox 等大包。
 *
 * 用法：npm install（首次）→ node build.js → node install.js
 * 改了 src/ 后重跑 node build.js。
 */
const { createRequire } = require("node:module");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
// esbuild 安装在 src/node_modules（package.json 在 src/ 下，npm install 在那里生成），
// 用 src/package.json 位置创建 require 以便解析到 esbuild
const req = createRequire(path.join(ROOT, "src", "package.json"));
let esbuild;
try {
	esbuild = req("esbuild");
} catch {
	console.error("未找到 esbuild（构建依赖）。首次使用请先执行：cd src && npm install\n");
	process.exit(1);
}
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

/** 静态部署物：原样拷贝到 dist/ 对应子目录（不做任何编译） */
const STATIC_DIRS = ["themes", "sounds", "patches"];
const STATIC_FILES = ["models.json"];

/** 递归拷贝目录（不拷贝 node_modules） */
function copyDir(src, dst) {
	fs.mkdirSync(dst, { recursive: true });
	for (const f of fs.readdirSync(src, { withFileTypes: true })) {
		const from = path.join(src, f.name);
		if (f.isDirectory()) {
			if (f.name === "node_modules") continue;
			copyDir(from, path.join(dst, f.name));
		} else {
			fs.copyFileSync(from, path.join(dst, f.name));
		}
	}
}

/** 收集扩展构建入口：src/extensions/ 顶层 *.ts + 子目录 index.ts/index.js（多文件扩展），排除 shared/ 等无入口目录 */
function collectEntries(dir) {
	const entries = [];
	for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, f.name);
		if (f.isFile() && f.name.endsWith(".ts")) {
			entries.push({ src: p, out: path.join(DIST, "extensions", f.name) });
		} else if (f.isDirectory() && f.name !== "node_modules") {
			const index = ["index.ts", "index.js"].find((n) => fs.existsSync(path.join(p, n)));
			if (index) {
				// 多文件扩展：打包为单文件 <目录名>.ts（hud/ → hud.ts）
				entries.push({ src: path.join(p, index), out: path.join(DIST, "extensions", `${f.name}.ts`) });
			}
		}
	}
	return entries;
}

async function buildExtension(entry) {
	try {
		// packages: "external"：import 的包（@earendil-works/*、typebox 等）保持外部引用，
		// 相对 import（./shared/...）被内联；产物单文件、零耦合
		await esbuild.build({
			entryPoints: [entry.src],
			outfile: entry.out,
			bundle: true,
			format: "esm",
			platform: "node",
			packages: "external",
			tsconfig: path.join(ROOT, "src", "config", "tsconfig.build.json"),
			target: "es2022",
			logLevel: "silent",
		});
		const size = (fs.statSync(entry.out).size / 1024).toFixed(1);
		console.log(`✓ ${path.relative(ROOT, entry.src)} → ${path.relative(ROOT, entry.out)}（${size} KB）`);
		return true;
	} catch (err) {
		console.error(`✗ ${path.relative(ROOT, entry.src)} 构建失败：`);
		for (const e of err.errors ?? []) {
			console.error(`  ${path.relative(ROOT, e.location?.file ?? entry.src)}:${e.location?.line ?? "?"}: ${e.text}`);
		}
		return false;
	}
}

async function main() {
	const entries = collectEntries(path.join(SRC, "extensions"));
	if (entries.length === 0) {
		console.error("未找到任何扩展入口（src/extensions/ 为空？）");
		process.exit(1);
	}
	fs.mkdirSync(path.join(DIST, "extensions"), { recursive: true });
	console.log(`伪编译构建 → ${path.relative(ROOT, DIST)}\n`);

	// 1) 编译扩展
	let ok = 0;
	for (const e of entries) if (await buildExtension(e)) ok++;
	// 清理 dist/extensions 里已不存在的旧产物（如某扩展被移除）
	for (const f of fs.readdirSync(path.join(DIST, "extensions"))) {
		if (f.endsWith(".ts") && !entries.some((e) => e.out.endsWith(f))) {
			fs.rmSync(path.join(DIST, "extensions", f), { force: true });
			console.log(`– 清理旧产物 ${f}`);
		}
	}
	if (ok !== entries.length) {
		console.error(`\n${ok}/${entries.length} 个扩展构建失败，中止（静态资源未拷贝）。`);
		process.exit(1);
	}

	// 2) 组装静态部署物
	for (const d of STATIC_DIRS) {
		const srcDir = path.join(SRC, d);
		if (fs.existsSync(srcDir)) copyDir(srcDir, path.join(DIST, d));
	}
	for (const f of STATIC_FILES) {
		const srcFile = path.join(SRC, f);
		if (fs.existsSync(srcFile)) fs.copyFileSync(srcFile, path.join(DIST, f));
	}
	console.log("✓ 静态部署物（themes/ sounds/ patches/ models.json）已拷贝");

	console.log(`\n${ok}/${entries.length} 个扩展构建成功。运行 node install.js 安装 dist/ 产物。`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
