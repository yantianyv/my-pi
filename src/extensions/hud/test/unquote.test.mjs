#!/usr/bin/env node
/**
 * hud-git 路径引号解码回归测试
 *
 * 背景：git status / diff --numstat 输出对含非 ASCII（如中文）、空格等字符的路径
 * 默认按 core.quotePath 做 C-style 引号 + 八进制转义（如 `?? "准备/"`），旧解析器
 * 不解码，导致：删除未跟踪报 ENOENT（`unlink '...\".pi\workflow...'`）、stage/discard
 * 中文路径失败、行数预览匹配不上。本测试锁定该修复。
 *
 * 覆盖：
 * - 纯函数解码：引号/八进制/空格/引号/反斜杠/控制字符/未包裹原样
 * - 真实 git 仓库链路：中文/空格/目录路径解析 + numStats 匹配、
 *   gitAdd / gitDiscard / gitRemoveUntracked（含目录递归删除）、重命名解析
 *
 * 原理：node 无法直接 import .ts，先用 esbuild（src/node_modules 构建依赖）把
 * hud-git.ts bundle 成单文件 ESM 再 import；external 白名单与 build.js 一致
 * （@earendil-works/*、typebox），pi 包别名到内联 mock（解析层不触发 UI 符号）。
 *
 * 用法：node src/extensions/hud/test/unquote.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const HUD_DIR = join(TEST_DIR, ".."); // src/extensions/hud/
const SRC_DIR = join(HUD_DIR, "../.."); // src/
const BUNDLE = join(TEST_DIR, ".tmp-bundle.mjs");
const PI_MOCK = join(TEST_DIR, ".tmp-pi-mock.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

// ---- bundle：hud-git.ts + pi 包 mock（解析层不触发 UI 符号） ----
writeFileSync(
	PI_MOCK,
	[
		'export const matchesKey = () => false;',
		"export const Key = {};",
		"export const CURSOR_MARKER = '';",
		"export const truncateToWidth = (s, w) => s;",
		"export const visibleWidth = (s) => s.length;",
		"export const parseKey = (s) => null;",
		"export const completeSimple = async () => { throw new Error('mock'); };",
	].join("\n"),
);
await build({
	entryPoints: [join(HUD_DIR, "hud-git.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	alias: { "@earendil-works/pi-tui": PI_MOCK, "@earendil-works/pi-ai/compat": PI_MOCK },
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
const mod = await import(pathToFileURL(BUNDLE).href);

// ---- 场景 1：纯函数解码 ----
console.log("场景 1：gitUnquotePath 纯函数解码");
const unquoteCases = [
	['".pi/workflow/a-\\345\\207\\206\\345\\244\\207/"', ".pi/workflow/a-准备/"],
	['"a b.txt"', "a b.txt"],
	['"\\"q\\".txt"', '"q".txt'], // Linux 场景：文件名含引号
	['"a\\\\b.txt"', "a\\b.txt"],
	['"\\346\\226\\260\\345\\220\\215.txt"', "新名.txt"],
	["plain.txt", "plain.txt"], // 未包裹原样
	['"\\t\\n.txt"', "\t\n.txt"],
];
for (const [raw, want] of unquoteCases) {
	check(`gitUnquotePath(${JSON.stringify(raw)}) → ${JSON.stringify(want)}`, mod.gitUnquotePath(raw) === want, `实际 ${JSON.stringify(mod.gitUnquotePath(raw))}`);
}

// ---- 场景 2：真实 git 仓库完整链路（git 不可用则跳过） ----
let gitOk = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	gitOk = false;
	console.log("（git 不可用，跳过场景 2-4）");
}

if (gitOk) {
	console.log("场景 2：真实 git 仓库状态解析");
	const tmp = join(tmpdir(), "hud-git-test");
	rmSync(tmp, { recursive: true, force: true });
	const repo = join(tmp, "repo");
	mkdirSync(repo, { recursive: true });
	const sh = (args) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	sh(["init", "-q"]);
	sh(["config", "user.email", "t@t.t"]);
	sh(["config", "user.name", "t"]);

	// 已跟踪中文文件（改内容 → unstaged）
	writeFileSync(join(repo, "中文文件.txt"), "v1\n");
	sh(["add", "-A"]);
	sh(["commit", "-qm", "init"]);

	// 未跟踪：中文目录 + 空格文件 + 时间戳中文目录（复现用户报错场景）
	mkdirSync(join(repo, "准备目录"), { recursive: true });
	writeFileSync(join(repo, "准备目录", "内容.txt"), "x\n");
	writeFileSync(join(repo, "带 空格.txt"), "y\n");
	mkdirSync(join(repo, "2026-08-09T09-17-14-332Z-准备"), { recursive: true });
	writeFileSync(join(repo, "2026-08-09T09-17-14-332Z-准备", "data.json"), "{}\n");
	writeFileSync(join(repo, "中文文件.txt"), "v2\n");

	const status = await mod.getDetailedGitStatus(repo);
	check("getDetailedGitStatus 可用", !!status);

	const expected = [
		{ path: "中文文件.txt", category: "unstaged" },
		{ path: "准备目录/", category: "untracked" },
		{ path: "带 空格.txt", category: "untracked" },
		{ path: "2026-08-09T09-17-14-332Z-准备/", category: "untracked" },
	];
	for (const e of expected) {
		const found = status.items.find((i) => i.path === e.path);
		check(
			`路径解析: ${e.path}(${e.category})`,
			!!found && found.category === e.category,
			`实际 items=${JSON.stringify(status.items.map((i) => [i.path, i.category]))}`,
		);
	}
	check(
		"numStats 中文路径匹配（行数预览）",
		!!status.numStats["中文文件.txt"],
		`实际 keys=${JSON.stringify(Object.keys(status.numStats))}`,
	);

	console.log("场景 3：stage / discard / 删除未跟踪");
	await mod.gitAdd(repo, ["中文文件.txt", "带 空格.txt"]);
	let st = await mod.getDetailedGitStatus(repo);
	check(
		"gitAdd 中文/空格路径成功",
		st.items.find((i) => i.path === "中文文件.txt")?.category === "staged",
		JSON.stringify(st.items.map((i) => [i.path, i.category])),
	);

	// checkout HEAD 恢复 index+工作区 → 文件变 clean 不在列表
	await mod.gitDiscard(repo, ["中文文件.txt"]);
	st = await mod.getDetailedGitStatus(repo);
	check("gitDiscard 中文路径成功", !st.items.some((i) => i.path === "中文文件.txt"), JSON.stringify(st.items));

	// 删除未跟踪：文件 + 目录（复现 ENOENT 场景）
	await mod.gitRemoveUntracked(repo, ["准备目录/", "带 空格.txt", "2026-08-09T09-17-14-332Z-准备/"]);
	const remain = ["准备目录", "带 空格.txt", "2026-08-09T09-17-14-332Z-准备"].filter((p) => existsSync(join(repo, p)));
	st = await mod.getDetailedGitStatus(repo);
	check("gitRemoveUntracked 删除未跟踪文件+目录成功", remain.length === 0 && !st.items.some((i) => i.category === "untracked"), `残留 ${remain}`);

	console.log("场景 4：重命名解析（中文目标路径）");
	writeFileSync(join(repo, "ren-src.txt"), "r\n");
	await mod.gitAdd(repo, ["ren-src.txt"]);
	sh(["commit", "-qm", "ren"]);
	rmSync(join(repo, "ren-src.txt"));
	writeFileSync(join(repo, "重命名目标.txt"), "r\n");
	sh(["add", "-A"]);
	const st2 = await mod.getDetailedGitStatus(repo);
	const ren = st2.items.find((i) => i.xy[0] === "R");
	check("重命名解析: 中文目标路径 + 来源", !!ren && ren.path === "重命名目标.txt" && ren.renamedFrom === "ren-src.txt", JSON.stringify(ren));

	rmSync(tmp, { recursive: true, force: true });
}

// ---- 清理 ----
rmSync(BUNDLE, { force: true });
rmSync(PI_MOCK, { force: true });

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 个断言失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
