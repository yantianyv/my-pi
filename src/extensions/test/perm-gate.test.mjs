#!/usr/bin/env node
/**
 * perm-gate 回归测试（复用 ask 测试基建模式）
 *
 * 原理：esbuild（src/node_modules 构建依赖）把 perm-gate.ts bundle 成单文件 ESM 再 import；
 * 只测模块级导出的 ReviewPanel 复核面板（不触发默认导出函数，避免读写真实
 * ~/.pi/agent/perm-gate.json）。theme mock 纯文本透传，不干扰宽度计算。
 *
 * 覆盖：
 * - 场景 A：短命令渲染——命令/说明/四操作完整呈现，行宽不超限
 * - 场景 B：超长命令全文折行不截断——PgDn 滚动能看到命令尾部，分隔行有滚动指示
 * - 场景 C：键位——Enter 返回当前操作、↑↓ 移动、1-5 直选、Esc 返回 null（驳回）
 *
 * 用法：node src/extensions/test/perm-gate.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../.."); // src/
const BUNDLE = join(TEST_DIR, ".tmp-perm-gate-bundle.mjs");

let failures = 0;
const check = (name, cond) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}`);
		failures++;
	}
};

const themeMock = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const TERM_ROWS = 24;
const makeTui = () => ({ terminal: { rows: TERM_ROWS, columns: 80 }, requestRender() {} });

const K = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
};

const WIDTH = 60;

/** 抽取面板文本：去掉 │ 边框与补位后逐行拼接（折行点拆开的串据此还原） */
function panelText(lines) {
	return lines
		.map((l) => {
			const m = l.match(/^│([\s\S]*)│$/);
			return (m ? m[1] : l).trim();
		})
		.join("");
}

function makePanel(mod, command, detail = "") {
	let result = { done: false, choice: undefined };
	const panel = new mod.ReviewPanel(makeTui(), themeMock, "⚠️ 命中黑名单，需人工复核", command, detail, (choice) => {
		result = { done: true, choice };
	});
	panel.focused = true;
	return { panel, result: () => result };
}

/** 渲染不变量：每行可见宽度 ≤ WIDTH */
function checkWidth(lines, label) {
	let bad = 0;
	for (const line of lines) if (visibleWidth(line) > WIDTH) bad++;
	check(`${label}: 每行 ≤ ${WIDTH} 列（违例 ${bad} 行）`, bad === 0);
}

async function main() {
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "perm-gate.ts")],
		outfile: BUNDLE,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});
	const mod = await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}`);
	check("ReviewPanel 已导出", typeof mod.ReviewPanel === "function");

	// ---- 场景 A：短命令完整渲染 ----
	console.log("场景 A：短命令渲染");
	{
		const { panel } = makePanel(mod, "git status", "命中黑名单规则：\\bsudo\\b");
		const lines = panel.render(100);
		let bad = 0;
		for (const line of lines) if (visibleWidth(line) > 100) bad++;
		check("A: 每行 ≤ 100 列（违例 " + bad + " 行）", bad === 0);
		const text = panelText(lines);
		check("A: 含命令全文", text.includes("git status"));
		check("A: 含说明", text.includes("命中黑名单规则"));
		check("A: 含四个操作", ["放行一次", "放行并加白名单", "驳回", "驳回并加黑名单"].every((a) => text.includes(a)));
		check("A: 含键位提示", text.includes("Esc 驳回"));
		check("A: 短命令无滚动指示", !text.includes("▼") && !text.includes("▲"));
		checkWidth(panel.render(WIDTH), "A: 窄宽度（60）");
	}

	// ---- 场景 B：超长命令全文折行不截断 ----
	console.log("场景 B：超长命令折行 + 滚动");
	{
		const tail = "命令尾部标记子丑寅卯辰巳午未";
		const longCmd =
			"python -c \"print('这是一段很长的内嵌脚本内容'.upper())\"".repeat(10) +
			" && echo " +
			tail +
			"\nsecond line 也是一段不短的后续命令";
		const { panel } = makePanel(mod, longCmd);
		const first = panel.render(WIDTH);
		checkWidth(first, "B: 首页");
		check("B: 首页分隔行有 ▼ 滚动指示", panelText(first).includes("▼") || first.join("").includes("▼"));
		// 逐次 PgDn 直到命令尾部出现（trim+拼接还原折行点拆开的串）
		let seen = panelText(first);
		let hops = 0;
		while (!seen.includes(tail) && hops < 50) {
			panel.handleInput(K.pageDown);
			seen = panelText(panel.render(WIDTH));
			hops++;
		}
		check("B: PgDn 滚动后命令尾部完整可见（未截断）", seen.includes(tail));
		checkWidth(panel.render(WIDTH), "B: 滚动后");
		check("B: 滚动后分隔行有 ▲ 指示", seen.includes("▲"));
		// PgUp 回到顶部
		for (let i = 0; i < hops + 1; i++) panel.handleInput(K.pageUp);
		const backTop = panelText(panel.render(WIDTH));
		check("B: PgUp 回到顶部（python 开头可见）", backTop.includes("python -c"));
	}

	// ---- 场景 C：键位 ----
	console.log("场景 C：键位");
	{
		const { panel, result } = makePanel(mod, "git status");
		panel.render(WIDTH);
		panel.handleInput(K.enter);
		check("C: Enter 返回「放行一次」", result().done && result().choice === "放行一次");
	}
	{
		const { panel, result } = makePanel(mod, "git status");
		panel.render(WIDTH);
		panel.handleInput(K.down);
		panel.handleInput(K.down);
		panel.handleInput(K.down);
		panel.handleInput(K.enter);
		check("C: ↓↓↓+Enter 返回「驳回」", result().done && result().choice === "驳回");
	}
	{
		const { panel, result } = makePanel(mod, "git status");
		panel.render(WIDTH);
		panel.handleInput("2");
		check("C: 数字键 2 直选「放行并加白名单」", result().done && result().choice === "放行并加白名单");
	}
	{
		const { panel, result } = makePanel(mod, "git status");
		panel.render(WIDTH);
		panel.handleInput(K.escape);
		check("C: Esc 返回 null（驳回）", result().done && result().choice === null);
	}

	console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
