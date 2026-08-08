#!/usr/bin/env node
/**
 * 伪编译构建：把 extensions/ 源码 bundle 成 dist/extensions/ 下的零耦合单文件
 *
 * 架构：源码层共享模块（extensions/shared/）被多个扩展 import 复用；本脚本用
 * esbuild（devDependency，node build.js 前先 npm install）把每个扩展入口 + 其
 * 相对依赖（shared/、hud/ 子模块）内联打包成单个 .ts 文件。产物只保留对 pi
 * 官方包（@earendil-works/*、typebox）的外部引用，扩展之间零耦合（互不 import、
 * 无运行时共享依赖）。
 *
 * - 多文件扩展（如 extensions/hud/）的 index 入口会被打包成 <目录名>.ts 单文件，
 *   顺带解决 hud 被拆分为子目录/子模块的问题——产物与其它扩展一致；
 * - 产物是 ESM（内容为 JS 语法的 .ts 文件），pi 经 jiti 加载，与手写源码无差异；
 * - tsconfig 用 tsconfig.build.json（无 paths）：主 tsconfig.json 的 paths 会把
 *   包名解析成 pi 全局目录绝对路径，导致 packages: "external" 的包名匹配失效、
 *   意外内联 typebox 等大包。
 *
 * 用法：npm install（首次）→ node build.js → node install.js
 * 改了扩展源码后重跑 node build.js。
 */
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "extensions");
const OUT = path.join(ROOT, "dist", "extensions");

/** 收集构建入口：顶层 *.ts + 子目录 index.ts/index.js（多文件扩展），排除 shared/ 等无入口目录 */
function collectEntries(dir) {
	const entries = [];
	for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, f.name);
		if (f.isFile() && f.name.endsWith(".ts")) {
			entries.push({ src: p, out: path.join(OUT, f.name) });
		} else if (f.isDirectory() && f.name !== "node_modules") {
			const index = ["index.ts", "index.js"].find((n) => fs.existsSync(path.join(p, n)));
			if (index) {
				// 多文件扩展：打包为单文件 <目录名>.ts（hud/ → hud.ts）
				entries.push({ src: path.join(p, index), out: path.join(OUT, `${f.name}.ts`) });
			}
		}
	}
	return entries;
}

async function buildOne(entry) {
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
			tsconfig: path.join(ROOT, "tsconfig.build.json"),
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
	const entries = collectEntries(SRC);
	if (entries.length === 0) {
		console.error("未找到任何扩展入口（extensions/ 为空？）");
		process.exit(1);
	}
	fs.mkdirSync(OUT, { recursive: true });
	console.log(`伪编译构建 → ${path.relative(ROOT, OUT)}\n`);
	let ok = 0;
	for (const e of entries) if (await buildOne(e)) ok++;
	// 清理：删除 OUT 里已不存在的旧产物（如某扩展被移除）
	for (const f of fs.readdirSync(OUT)) {
		if (f.endsWith(".ts") && !entries.some((e) => e.out.endsWith(f))) {
			fs.rmSync(path.join(OUT, f), { force: true });
			console.log(`– 清理旧产物 ${f}`);
		}
	}
	console.log(`\n${ok}/${entries.length} 个扩展构建成功。运行 node install.js 安装产物。`);
	if (ok !== entries.length) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
