#!/usr/bin/env node
/**
 * shared/ui 边框与底色的回归测试（离线，零依赖）
 *
 * 起因：`theme.fg()` 输出以 `\x1b[39m`（重置前景色）收尾。若把带样式的标题与横线拼成一个
 * 字符串、只在外层套一次边框色，标题自带的重置会把**同串里后面的横线**打回终端默认色——
 * 表现为「顶边是白的、其余边框有色」。
 *
 * 假主题用**真实 SGR 序列**（256 色，按颜色名分配编号）：既能让 visibleWidth 正确计算
 * （文字标记会被当成可见字符，导致行宽断言失真），又能断言某段到底上了哪种颜色。
 *
 * 覆盖：
 * - A topBorder：标题含内部样式时横线仍带边框色；裸标题也上色；可见宽度不变
 * - B dividerScrollNote：滚动提示里的横线同样保持边框色
 * - C hint：铺底色 + 补满宽度 + 带左右边框 + 灰字
 * - D 默认铺底 / `bg: false` 关闭 / paintSurface 补宽与截断
 *
 * 用法：node src/extensions/shared/test/ui-box.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, ".tmp-ui-box-bundle.mjs");
await build({
	entryPoints: [join(here, "..", "ui.ts")],
	outfile: out,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*"],
	target: "es2022",
	logLevel: "silent",
});
const ui = await import(pathToFileURL(out).href);

let failures = 0;
const check = (name, cond, extra) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra === undefined ? "" : ` :: ${extra}`}`);
		failures++;
	}
};
const section = (t) => console.log(`\n${t}`);

const ANSI = /\x1b\[[0-9;]*m/g;
/** 可见文本（ANSI 宽度为 0，去掉即可） */
const plain = (s) => s.replace(ANSI, "");
/** 某颜色编号的 256 色前景 / 背景序列 */
const fgSeq = (n) => `\x1b[38;5;${n}m`;
const bgSeq = (n) => `\x1b[48;5;${n}m`;
const BORDER_CODE = 90;
const BG_CODE = 100;
const countBorder = (s) => (s.match(new RegExp(fgSeq(BORDER_CODE).replace(/\[/g, "\\["), "g")) ?? []).length;

const theme = {
	fg: (color, text) => `${fgSeq(color === "border" ? BORDER_CODE : color === "dim" ? 91 : 92)}${text}\x1b[39m`,
	bg: (color, text) => `${bgSeq(color === "customMessageBg" ? BG_CODE : 101)}${text}\x1b[49m`,
	bold: (t) => t,
	inverse: (t) => t,
	dim: (t) => t,
};

// ---------------------------------------------------------------------------
section("A topBorder 的分段上色");
// ---------------------------------------------------------------------------

const W = 20;
const box = ui.createBoxRenderer(theme, W);
const bare = box.topBorder();
check("A1 无标题：╭ 与横线各带边框色", countBorder(bare) === 2, countBorder(bare));
check("A1b 可见宽度 = 内宽 + 2", visibleWidth(bare) === W + 2, visibleWidth(bare));

// 面板的实际用法：标题自带 dim 样式（其结尾会发 \x1b[39m）
const styled = box.topBorder(` ${theme.fg("dim", "技能市场")} `);
const afterReset = styled.slice(styled.indexOf("\x1b[39m"));
check("A2 标题收尾之后的横线仍带边框色", afterReset.includes(fgSeq(BORDER_CODE)), JSON.stringify(plain(afterReset).slice(0, 12)));
check("A3 可见宽度不变", visibleWidth(styled) === W + 2, visibleWidth(styled));
check("A4 标题保留自己的样式", styled.includes(fgSeq(91) + "技能市场"));

const bareTitle = box.topBorder(" 标题 ");
check("A5 裸标题也上边框色", countBorder(bareTitle) === 3, countBorder(bareTitle));

// ---------------------------------------------------------------------------
section("B dividerScrollNote 的横线");
// ---------------------------------------------------------------------------

const borderFn = (s) => `${fgSeq(BORDER_CODE)}${s}\x1b[39m`;
const note = ui.dividerScrollNote(theme, borderFn, 30, 5, 7);
const noteTail = note.slice(note.indexOf("\x1b[39m"));
check("B1 提示文字后的横线保持边框色", noteTail.includes(fgSeq(BORDER_CODE)), JSON.stringify(plain(noteTail).slice(0, 12)));
check("B2 提示带上下余量", plain(note).includes("▲5") && plain(note).includes("▼7"));
check("B3 无滚动余量时是纯分隔线", !ui.dividerScrollNote(theme, borderFn, 20, 0, 0).includes("▲"));

// ---------------------------------------------------------------------------
section("C hint：铺底 + 补宽 + 边框");
// ---------------------------------------------------------------------------

const hintLine = box.hint(" ↑↓ 选择 · Esc 关闭");
check("C1 带左右边框", plain(hintLine).startsWith("│") && plain(hintLine).endsWith("│"), JSON.stringify(plain(hintLine)));
check("C2 可见宽度正好等于面板宽度", visibleWidth(hintLine) === W + 2, visibleWidth(hintLine));
check("C3 整行有底色", hintLine.includes(bgSeq(BG_CODE)));
check("C4 文案是灰字", hintLine.includes(fgSeq(91)));

// ---------------------------------------------------------------------------
section("D 默认铺底与 paintSurface");
// ---------------------------------------------------------------------------

check("D1 PANEL_BG 是 customMessageBg", ui.PANEL_BG === "customMessageBg");
check("D2 row 默认带底色", box.row("内容").includes(bgSeq(BG_CODE)));
const noBg = ui.createBoxRenderer(theme, W, { bg: false });
check("D3 bg:false 关闭底色", !noBg.row("内容").includes(bgSeq(BG_CODE)));
check("D4 bg:false 时边框仍在", plain(noBg.row("内容")).startsWith("│"), JSON.stringify(plain(noBg.row("内容"))));

const painted = ui.paintSurface(theme, ["abc"], 10);
check("D5 paintSurface 补到指定宽度", visibleWidth(painted[0]) === 10, visibleWidth(painted[0]));
check("D6 paintSurface 带底色", painted[0].includes(bgSeq(BG_CODE)));
check("D7 超宽行被截断而不是溢出", visibleWidth(ui.paintSurface(theme, ["x".repeat(30)], 10)[0]) <= 10);
check("D8 已有 ANSI 的内容可见部分不变", plain(ui.paintSurface(theme, [theme.fg("dim", "ab")], 4)[0]) === "ab  ", JSON.stringify(plain(ui.paintSurface(theme, [theme.fg("dim", "ab")], 4)[0])));

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败`}`);
fs.unlinkSync(out);
process.exit(failures === 0 ? 0 : 1);
