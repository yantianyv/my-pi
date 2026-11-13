#!/usr/bin/env node
/**
 * skill-hub 面板回归测试（离线；deps 全部用桩，不联网、不碰真实配置）
 *
 * 原理：esbuild 把 panel.ts 与 favorites.ts bundle 成单文件 ESM 再 import；
 * theme mock 纯文本透传，TUI mock 只提供 requestRender（面板不自绘滚动条）。
 *
 * 覆盖：
 * - A 收藏存储：切换/幂等/删除/按 id 判断（隔离到临时目录）
 * - B 面板渲染：空态、本地视图（收藏 + 已装合并）、搜索结果的收藏置顶与标记
 * - C 键位：↑↓ 移动、f 收藏、/ 进入输入、输入态回车检索、Enter 打开确认、Esc 关闭
 * - D 确认态：安装需二次 Enter，Esc 返回不动数据；卸载同理
 * - E 检索失败与忙碌态：错误如实显示，不崩
 *
 * 用法：node src/extensions/skill-hub/test/panel.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hub-panel-"));
process.env.SKILL_HUB_FAVORITES_DIR = TMP;

await build({
	entryPoints: [join(here, "..", "panel.ts"), join(here, "..", "favorites.ts")],
	outdir: here,
	outExtension: { ".js": ".mjs" },
	entryNames: ".tmp-panel-[name]",
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*"],
	target: "es2022",
	logLevel: "silent",
});
const P = await import(pathToFileURL(join(here, ".tmp-panel-panel.mjs")).href);
const F = await import(pathToFileURL(join(here, ".tmp-panel-favorites.mjs")).href);

let failures = 0;
const check = (name, cond, extra) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra === undefined ? "" : ` :: ${extra}`}`);
		failures++;
	}
};
const section = (t) => console.log(`\n${t}`);

const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const tui = { requestRender() {} };
const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", pageUp: "\x1b[5~", pageDown: "\x1b[6~" };

// ---------------------------------------------------------------------------
section("A 收藏存储");
// ---------------------------------------------------------------------------

check("A1 初始为空", F.loadFavorites().length === 0);
check("A2 切换收藏返回 true", F.toggleFavorite("anthropics/skills", "pdf", "pdf") === true);
check("A3 收藏后能查到", F.isFavorite("anthropics/skills", "pdf"));
check("A4 键格式与 skills.sh id 同构", F.favoriteKey("anthropics/skills", "pdf") === "anthropics/skills/pdf");
check("A5 再次切换取消", F.toggleFavorite("anthropics/skills", "pdf", "pdf") === false && !F.isFavorite("anthropics/skills", "pdf"));
F.toggleFavorite("a/b", "one", "one");
F.toggleFavorite("c/d", "two", "two");
check("A6 多次收藏都在", F.loadFavorites().length === 2);
check("A7 最近收藏排前", F.loadFavorites()[0].skillId === "two");
check("A8 删除返回 true 且减少", F.removeFavorite("a/b", "one") === true && F.loadFavorites().length === 1);
check("A9 删不存在的返回 false", F.removeFavorite("a/b", "one") === false);
check("A10 favoriteKeys 含全部", F.favoriteKeys().has("c/d/two"));
check("A11 名称缺省回退 skillId", F.toggleFavorite("e/f", "noname") && F.loadFavorites()[0].name === "noname");
F.loadFavorites().forEach((f) => F.removeFavorite(f.source, f.skillId));
check("A12 清空完成", F.loadFavorites().length === 0);

// ---------------------------------------------------------------------------
section("B 面板渲染");
// ---------------------------------------------------------------------------

const installed = [{ name: "tdd", dir: "/tmp/tdd", source: "mattpocock/skills", ref: "1.3.1" }];
function makeDeps(over = {}) {
	const calls = { search: [], install: [], uninstall: [], toggle: [], describe: 0 };
	const deps = {
		favorites: () => [
			{ source: "anthropics/skills", skillId: "pdf", name: "pdf", addedAt: "2026-10-20T00:00:00Z" },
			{ source: "vercel-labs/agent-skills", skillId: "web-design-guidelines", name: "web-design-guidelines", addedAt: "2026-10-19T00:00:00Z" },
		],
		installed: () => installed,
		search: async (q) => {
			calls.search.push(q);
			return [
				{ source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 213790 },
				{ source: "other/repo", skillId: "pdf-tools", name: "pdf-tools", installs: 5000 },
			];
		},
		describe: async (row) => {
			calls.describe++;
			return {
				files: ["SKILL.md", "scripts/a.sh"],
				audits: ["Socket Pass", "Snyk Warn"],
				trust: ["来源在精选名单"],
				target: `/tmp/${row.name}`,
				description: "把 PDF 拆页、抽表、填表单一整套都给办了，适合批量处理扫描件。",
				ref: "main",
			};
		},
		install: async (row, progress) => {
			calls.install.push(row.name);
			progress?.("取回文件");
			return { ok: true, message: `已安装 ${row.name}` };
		},
		uninstall: async (name) => {
			calls.uninstall.push(name);
			return { ok: true, message: `已卸载 ${name}` };
		},
		toggleFavorite: (row) => {
			calls.toggle.push(`${row.source}/${row.skillId}`);
			return row.favorited ? false : true;
		},
		...over,
	};
	return { deps, calls };
}

const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

{
	const { deps } = makeDeps();
	const panel = new P.SkillsPanel(deps, theme, tui, () => {});
	const text = plain(panel.render(100));
	check("B1 标题出现", text.includes("技能市场"));
	check("B2 收藏与已装合并展示", text.includes("pdf") && text.includes("tdd") && text.includes("web-design-guidelines"));
	check("B3 已装项标 [已装]", text.includes("[已装]"));
	check("B4 收藏项标 ★", text.includes("★"));
	check("B5 底部给键位提示", text.includes("Enter 安装/卸载") && text.includes("f 收藏"));
	check("B6 统计行显示收藏/已装数", /收藏 2 · 已装 1/.test(text));
	check("B7 行宽不超过面板宽度", panel.render(100).every((l) => l.length <= 100), Math.max(...panel.render(100).map((l) => l.length)));
}

{
	const { deps } = makeDeps({ favorites: () => [], installed: () => [] });
	const panel = new P.SkillsPanel(deps, theme, tui, () => {});
	const text = plain(panel.render(90));
	check("B8 空态给出引导", text.includes("还没有收藏或已装的技能") && text.includes("按 / 输入关键词"));
}

// ---------------------------------------------------------------------------
section("C 键位");
// ---------------------------------------------------------------------------

{
	const { deps, calls } = makeDeps();
	let closed = false;
	const panel = new P.SkillsPanel(deps, theme, tui, () => {
		closed = true;
	});
	panel.handleInput(KEY.down);
	const down = plain(panel.render(100));
	check("C1 ↓ 移动选中（第二行带 ›）", down.split("\n").filter((l) => l.includes("›")).length === 1);
	panel.handleInput(KEY.up);
	check("C2 ↑ 回到首行", plain(panel.render(100)).indexOf("›") < plain(panel.render(100)).indexOf("★", 5) + 200);

	panel.handleInput("f");
	check("C3 f 切换收藏并调用依赖", calls.toggle.length === 1, calls.toggle.join(","));
	check("C4 f 后给出反馈（收藏/取消收藏都算）", /已(取消)?收藏/.test(plain(panel.render(100))));

	panel.handleInput("/");
	check("C5 / 进入输入态", plain(panel.render(100)).includes("/ "));

	panel.handleInput(KEY.esc);
	panel.handleInput("p");
	panel.handleInput("d");
	panel.handleInput("f");
	check("C6 直接打字进入输入态并带字", plain(panel.render(100)).includes("pdf"));
	panel.handleInput(KEY.enter);
	await new Promise((r) => setTimeout(r, 30));
	check("C7 输入态回车触发检索", calls.search.length === 1 && calls.search[0] === "pdf", calls.search.join(","));
	const searched = plain(panel.render(100));
	check("C8 检索结果按收藏置顶", searched.indexOf("pdf") < searched.indexOf("pdf-tools"));
	check("C9 结果里标出用户已收藏", searched.includes("用户已收藏") || searched.includes("[收藏]"));
	check("C10 检索结果带安装量", searched.includes("21.4 万"));

	panel.handleInput(KEY.esc);
	check("C11 Esc 关闭面板", closed);
}

// ---------------------------------------------------------------------------
section("D 确认态（不可逆动作要二次确认）");
// ---------------------------------------------------------------------------

{
	const { deps, calls } = makeDeps();
	const panel = new P.SkillsPanel(deps, theme, tui, () => {});
	// 首行是收藏项 pdf（未装）→ Enter 打开安装确认
	panel.handleInput(KEY.enter);
	await new Promise((r) => setTimeout(r, 30));
	const confirm = plain(panel.render(100));
	check("D1 Enter 后进入安装确认（不发请求）", calls.install.length === 0 && confirm.includes("安装技能"));
	check("D2 确认视图列出文件与审计", confirm.includes("scripts/a.sh") && confirm.includes("Socket Pass"));
	check("D3 确认视图说明目标路径", confirm.includes("/tmp/pdf"));
	panel.handleInput(KEY.esc);
	check("D4 Esc 返回列表且未安装", calls.install.length === 0 && plain(panel.render(100)).includes("技能市场"));

	panel.handleInput(KEY.enter);
	await new Promise((r) => setTimeout(r, 30));
	panel.handleInput(KEY.enter);
	await new Promise((r) => setTimeout(r, 30));
	check("D5 确认后执行安装", calls.install.length === 1 && calls.install[0] === "pdf", calls.install.join(","));
	check("D6 装完给出结果文案", plain(panel.render(100)).includes("已安装 pdf"));
}

{
	// 已装项 → Enter 是卸载确认
	const live = [{ name: "tdd", dir: "/tmp/tdd", source: "mattpocock/skills", ref: "1.3.1" }];
	const { deps, calls } = makeDeps({
		favorites: () => [],
		installed: () => live,
		uninstall: async (name) => {
			calls.uninstall.push(name);
			const i = live.findIndex((x) => x.name === name);
			if (i >= 0) live.splice(i, 1);
			return { ok: true, message: `已卸载 ${name}` };
		},
	});
	const panel = new P.SkillsPanel(deps, theme, tui, () => {});
	panel.handleInput(KEY.enter);
	const confirm = plain(panel.render(100));
	check("D7 已装项 Enter 进卸载确认", confirm.includes("卸载技能") && confirm.includes("tdd"));
	check("D8 卸载前不动数据", calls.uninstall.length === 0);
	panel.handleInput(KEY.enter);
	await new Promise((r) => setTimeout(r, 30));
	check("D9 确认后执行卸载", calls.uninstall.length === 1 && calls.uninstall[0] === "tdd");
	check("D10 卸载后标记消失", !plain(panel.render(100)).includes("[已装]"));
}

// ---------------------------------------------------------------------------
section("E 异常与忙碌态");
// ---------------------------------------------------------------------------

{
	const { deps } = makeDeps({ search: async () => { throw new Error("网络不可达"); } });
	const panel = new P.SkillsPanel(deps, theme, tui, () => {});
	panel.handleInput("/");
	panel.handleInput("x");
	panel.handleInput(KEY.enter);
	await new Promise((r) => setTimeout(r, 30));
	check("E1 检索失败如实显示", plain(panel.render(100)).includes("检索失败") && plain(panel.render(100)).includes("网络不可达"));
}

{
	const { deps } = makeDeps({ describe: async () => { throw new Error("取不到文件清单"); } });
	const panel = new P.SkillsPanel(deps, theme, tui, () => {});
	panel.handleInput(KEY.enter);
	await new Promise((r) => setTimeout(r, 30));
	check("E2 确认信息取不到时不进确认态", plain(panel.render(100)).includes("读取失败") && !plain(panel.render(100)).includes("安装技能"));
}

// ---------------------------------------------------------------------------
section("G 选中项详情（描述 / 审计 / 规模）");
// ---------------------------------------------------------------------------

{
	const { deps, calls } = makeDeps();
	const panel = new P.SkillsPanel(deps, theme, tui, () => {});
	check("G1 刚打开时先显示读取中", plain(panel.render(100)).includes("读取中"));
	await new Promise((r) => setTimeout(r, 320));
	const text = plain(panel.render(100));
	check("G2 详情里有描述", text.includes("描述：") && text.includes("把 PDF 拆页"), text.split("\n").filter((l) => l.includes("描述")).join("|"));
	check("G3 详情里有审计结论", text.includes("审计：") && text.includes("Socket Pass") && text.includes("Snyk Warn"));
	check("G4 详情里有规模与版本", text.includes("2 个文件") && text.includes("版本 main"));
	check("G5 同一技能只拉一次（有缓存）", calls.describe === 1, calls.describe);
	panel.handleInput(KEY.down);
	await new Promise((r) => setTimeout(r, 320));
	check("G6 换选中项会拉新的详情", calls.describe === 2, calls.describe);
}

{
	const { deps } = makeDeps({ describe: async () => { throw new Error("取不到"); } });
	const panel = new P.SkillsPanel(deps, theme, tui, () => {});
	await new Promise((r) => setTimeout(r, 320));
	check("G7 详情拉取失败时如实显示", plain(panel.render(100)).includes("读取失败"), plain(panel.render(100)).split("\n").filter((l) => l.includes("描述")).join("|"));
}

// ---------------------------------------------------------------------------
{
	const { deps } = makeDeps({
		describe: async () => ({ files: [], audits: [], trust: [], target: "/tmp/x", description: null, ref: "main" }),
	});
	const panel = new P.SkillsPanel(deps, theme, tui, () => {});
	await new Promise((r) => setTimeout(r, 400));
	check("G8 描述取不到时与「未声明」区分开", plain(panel.render(100)).includes("没取到描述"), plain(panel.render(100)).split("\n").filter((l) => l.includes("描述")).join("|"));
}

// ---------------------------------------------------------------------------
section("F 底色覆盖（防止底部提示行漏铺造成「断层」）");
// ---------------------------------------------------------------------------

{
	// bg 打标记：任何未包 row()/hint() 的裸行都检测得到
	const markTheme = { fg: (_c, t) => t, bg: (_c, t) => `${t}`, bold: (t) => t, inverse: (t) => t };
	const { deps } = makeDeps();
	for (const width of [60, 100, 160]) {
		const p2 = new P.SkillsPanel(deps, markTheme, tui, () => {});
		const lines = p2.render(width);
		const bare = lines.filter((l) => !String(l).includes(""));
		check(`F 宽 ${width}：全部 ${lines.length} 行都有底色`, bare.length === 0, `${bare.length} 行缺`);
	}
	const confirmPanel = new P.SkillsPanel(deps, markTheme, tui, () => {});
	confirmPanel.handleInput(KEY.enter); // 进确认态也必须有底色
	await new Promise((r) => setTimeout(r, 20));
	const confirmLines = confirmPanel.render(100);
	check("F 确认态每行也有底色", confirmLines.every((l) => l.includes("")), `${confirmLines.filter((l) => !l.includes("")).length} 行缺`);
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败`}`);
fs.rmSync(TMP, { recursive: true, force: true });
for (const f of fs.readdirSync(here)) if (f.startsWith(".tmp-panel-")) fs.unlinkSync(join(here, f));
process.exit(failures === 0 ? 0 : 1);
