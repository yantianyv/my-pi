#!/usr/bin/env node
/**
 * perm-gate 回归测试（复用 ask 测试基建模式）
 *
 * 原理：esbuild（src/node_modules 构建依赖）把 perm-gate/index.ts bundle 成单文件 ESM 再 import；
 * 只测模块级导出的 ReviewPanel 确认面板与纯函数（不触发默认导出函数，避免读写真实
 * ~/.pi/agent/perm-gate.json）。theme mock 纯文本透传，不干扰宽度计算。
 *
 * 覆盖：
 * - 场景 A：信息区完整（一句解读/影响面/命中原因）+ 选项与键位提示，行宽不超限
 * - 场景 B：超长命令全文折行不截断——PgDn 滚动能看到命令尾部，分隔行有滚动指示
 * - 场景 C：键位与默认项——Enter = 当前项（默认「允许一次」）、↑↓ 移动、数字直选、Esc = 拒绝
 * - 场景 D：无「永久允许」可选时（canRemember=false）选项收敛为两项
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

function makePanel(mod, command, info) {
	let result = { done: false, choice: undefined };
	const panel = new mod.ReviewPanel(
		makeTui(),
		themeMock,
		"⚠ 需要你确认这条命令",
		command,
		info ?? { summary: "这条命令没命中已知规则，请你确认是否执行。", impact: [], canRemember: true, intent: "查看 git 状态" },
		(choice) => {
			result = { done: true, choice };
		},
	);
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
		entryPoints: [join(SRC_DIR, "extensions", "perm-gate", "index.ts")],
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

	// ---- 配置面板核心逻辑（/perm-gate-config 的名单编辑）----
	console.log("配置面板：名单编辑的校验与命中测试");
	check("compilePatternError 导出", typeof mod.compilePatternError === "function");
	check("合法正则通过校验", mod.compilePatternError("\\bdws\\s+chat\\s+send\\b") === null, String(mod.compilePatternError("a")));
	check("非法正则给出原因", typeof mod.compilePatternError("(") === "string", String(mod.compilePatternError("(")));
	check("命中测试：命中", mod.patternHits("\\bgit\\s+push\\b", "git push origin main") === true);
	check("命中测试：不误命中", mod.patternHits("\\bgit\\s+push\\b", "git status") === false);
	check("命中测试：非法正则视为未命中", mod.patternHits("(", "anything") === false);

	// ---- 场景 A：人话信息区 + 选项 + 键位 ----
	console.log("场景 A：信息区与选项");
	{
		const { panel } = makePanel(mod, "git push origin main --force", {
			summary: "把本地提交强推覆盖远端分支，可能导致他人提交丢失。",
			impact: ["联网：github.com", "改写远端分支：main"],
			hitLabel: "命中关注项（整条命令）",
			canRemember: true,
			intent: "强推远端分支",
		});
		const lines = panel.render(100);
		let bad = 0;
		for (const line of lines) if (visibleWidth(line) > 100) bad++;
		check("A: 每行 ≤ 100 列（违例 " + bad + " 行）", bad === 0);
		const text = panelText(lines);
		check("A: 含一句话解读", text.includes("强推覆盖远端分支"));
		check("A: 含影响面", text.includes("影响面：联网：github.com；改写远端分支：main"));
		check("A: 含命中原因", text.includes("命中关注项"));
		check("A: 含命令全文", text.includes("git push origin main --force"));
		check("A: 三个操作齐全", ["允许一次", "允许并永久记住这类操作", "拒绝"].every((a) => text.includes(a)));
		check("A: 永久允许旁标出将被记住的意图", text.includes("强推远端分支"));
		check("A: 键位说明 Esc 语义", text.includes("Esc 拒绝（不执行）"));
		check("A: 不暴露正则原文", !/\\s\+|\\b/.test(text));
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
		const { panel } = makePanel(mod, longCmd, {
			summary: "运行一段内嵌 Python 脚本并回显结果。",
			impact: ["无副作用"],
			canRemember: false,
		});
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
		check("B: 信息区不随滚动消失（解读始终可见）", seen.includes("运行一段内嵌 Python 脚本"));
		// PgUp 回到顶部
		for (let i = 0; i < hops + 1; i++) panel.handleInput(K.pageUp);
		const backTop = panelText(panel.render(WIDTH));
		check("B: PgUp 回到顶部（python 开头可见）", backTop.includes("python -c"));
	}

	// ---- 场景 C：键位与默认项 ----
	console.log("场景 C：键位与默认项");
	{
		const { panel, result } = makePanel(mod, "git status");
		panel.render(WIDTH);
		panel.handleInput(K.enter);
		check("C: Enter 默认选「允许一次」", result().done && result().choice === "允许一次");
	}
	{
		const { panel, result } = makePanel(mod, "git status");
		panel.render(WIDTH);
		panel.handleInput(K.down);
		panel.handleInput(K.down);
		panel.handleInput(K.enter);
		check("C: ↓↓+Enter 返回「拒绝」", result().done && result().choice === "拒绝");
	}
	{
		const { panel, result } = makePanel(mod, "git status");
		panel.render(WIDTH);
		panel.handleInput("2");
		check("C: 数字键 2 直选「允许并永久记住这类操作」", result().done && result().choice === "允许并永久记住这类操作");
	}
	{
		const { panel, result } = makePanel(mod, "git status");
		panel.render(WIDTH);
		panel.handleInput(K.escape);
		check("C: Esc 返回 null（拒绝，不执行）", result().done && result().choice === null);
	}
	{
		const { panel, result } = makePanel(mod, "git status");
		panel.render(WIDTH);
		panel.handleInput(K.up); // 首项再 ↓ 上滚不动
		panel.handleInput(K.enter);
		check("C: 首项再 ↑ 不越界", result().choice === "允许一次");
	}

	// ---- 场景 D：无法泛化时不提供「永久允许」 ----
	console.log("场景 D：无可泛化规则");
	{
		const { panel, result } = makePanel(mod, "some-command --flag", {
			summary: "未知命令。",
			impact: [],
			canRemember: false,
		});
		const text = panelText(panel.render(WIDTH));
		check("D: 不出现「永久允许」选项", !text.includes("允许并永久记住"));
		check("D: 只有两项（Enter 允许 / ↓ 拒绝）", text.includes("1-2 直选"));
		panel.handleInput(K.down);
		panel.handleInput(K.enter);
		check("D: 第二项是「拒绝」", result().choice === "拒绝");
	}

	console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
