#!/usr/bin/env node
/**
 * 伪编译构建：把 src/extensions/ 源码组装成 dist/extensions/ 部署物（install.js 只认 dist/）
 *
 * 架构：源码层高复用（src/extensions/shared/ 共享模块被多个扩展 import 复用，
 * src/extensions/hud/ 多文件便于维护），本脚本用 esbuild 把每个扩展入口 + 其
 * 相对依赖内联打包成 dist/extensions/ 下的零耦合单文件 .ts（产物只保留对 pi
 * 官方包 @earendil-works/*、typebox 的外部引用，扩展之间互不依赖）。
 * 静态资源（static/ 下的 themes/ sounds/ patches/ models.json）无需编译，
 * 不经本脚本，install.js 直接从 static/ 安装。
 *
 * - 多文件扩展（src/extensions/hud/）的 index 入口打包成 <目录名>.ts 单文件，
 *   解决 hud 被拆分为子目录/子模块的问题——产物与其它扩展一致；
 * - 产物是 ESM（内容为 JS 语法的 .ts 文件），pi 经 jiti 加载，与手写源码无差异；
 * - tsconfig 用 src/config/tsconfig.build.json（无 paths）：主 tsconfig 的 paths 会
 *   把包名解析成 pi 全局目录绝对路径，导致 external 白名单的包名匹配失效、
 *   意外内联 typebox 等大包。
 *
 * 用法：cd src && npm install（首次）→ node install.js（根目录，自动调用本脚本）
 * 或直接 node src/build.js。改了 src/ 后重跑。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, ".."); // 仓库根目录（本脚本在 src/ 内）
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");
// 被 install.js 调用时传入（此时不打印“去运行 install.js”之类的提示，避免误导）
const fromInstall = process.argv.includes("--from-install");
// 非编译类错误的原文（原生依赖平台不符时 21 个入口会报同一句），去重后只提示一次
const reportedErrors = new Set();

// esbuild 是 src/package.json 的 devDependency，安装在 src/node_modules——
// 本脚本就在 src/ 内，require 从 src/ 向上解析自然命中，无需 createRequire hack
let esbuild;
try {
	esbuild = require("esbuild");
} catch {
	console.error("未找到 esbuild（构建依赖）。首次使用请先执行：cd src && npm install\n");
	process.exit(1);
}

/** 打印 esbuild 抛出的非编译诊断错误（原生二进制平台不符、子进程启动失败等，此时 err.errors 为空）。
 *  同一句只提示一次：平台不符会让全部入口以同一原因失败，逐条重复只会淹没真正有用的那行提示。 */
function reportNonCompileError(entry, err) {
	const first = String(err?.message ?? err).trim().split("\n")[0];
	if (reportedErrors.has(first)) return;
	reportedErrors.add(first);
	console.error(`✗ ${path.relative(ROOT, entry.src)} 构建失败：`);
	console.error(`  ${first}`);
	if (/another platform than the one you're currently using/.test(first)) {
		console.error(
			`  提示：本机是 ${process.platform}-${process.arch}，而 src/node_modules 里的原生依赖（esbuild）属于其他平台。` +
				"双系统共享同一份 node_modules 时，换系统后需各自补装本机二进制：cd src && npm install（或仓库根目录 node install.js）。" +
				"补装不会删掉另一平台的包，两个系统来回切换各装一次即可长期可用。",
		);
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
		// external 白名单：pi 官方包（@earendil-works/*）与 typebox 保持外部引用（jiti 运行时
		// 经 pi 全局安装目录解析），其余 npm 包（如 web-tool 内联的 turndown/domino/gfm）被
		// bundle 进产物——产物仍是零外部依赖单文件。显式白名单而非 packages: "external"
		// 才能让 npm 依赖内联（packages: external 会把一切包名 import 都外部化）。
		await esbuild.build({
			entryPoints: [entry.src],
			outfile: entry.out,
			bundle: true,
			format: "esm",
			platform: "node",
			external: ["@earendil-works/*", "typebox"],
			tsconfig: path.join(ROOT, "src", "config", "tsconfig.build.json"),
			target: "es2022",
			logLevel: "silent",
		});
		const size = (fs.statSync(entry.out).size / 1024).toFixed(1);
		console.log(`✓ ${path.relative(ROOT, entry.src)} → ${path.relative(ROOT, entry.out)}（${size} KB）`);
		return true;
	} catch (err) {
		const errors = err.errors ?? [];
		if (errors.length === 0) reportNonCompileError(entry, err);
		else {
			console.error(`✗ ${path.relative(ROOT, entry.src)} 构建失败：`);
			for (const e of errors) {
				console.error(`  ${path.relative(ROOT, e.location?.file ?? entry.src)}:${e.location?.line ?? "?"}: ${e.text}`);
			}
			// 依赖缺失（npm install 不完整/未装）是最常见的构建失败原因，给出可直接照做的补救提示
			if (errors.some((e) => /Could not resolve/.test(e.text ?? ""))) {
				console.error("  提示：Could not resolve 多为 npm 构建依赖缺失。在仓库根目录运行 node install.js（自动检测并补装依赖），或 cd src && npm install 后重试。");
			}
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
			// fs.rmSync 在含中文的路径下会静默删除失败（报成功但不删），
			// 改用 unlinkSync（实测可靠）；失败仅告警不中断构建
			try {
				fs.unlinkSync(path.join(DIST, "extensions", f));
				console.log(`– 清理旧产物 ${f}`);
			} catch (e) {
				console.warn(`  ⚠ 清理旧产物 ${f} 失败：${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	if (ok !== entries.length) {
		console.error(`\n${ok}/${entries.length} 个扩展构建失败，中止。`);
		process.exit(1);
	}

	if (fromInstall) {
		console.log(`${ok}/${entries.length} 个扩展构建成功。`);
	} else {
		console.log(
			`\n${ok}/${entries.length} 个扩展构建成功。\n提示：install.js 会自动构建，无需单独运行本脚本——直接在仓库根目录运行 node install.js 即可。`,
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
