#!/usr/bin/env node
/**
 * model-config 面板回归测试（离线）：两个页签的渲染、单行宽度约束与层级进出
 *
 * 锁住的不变量：
 * - 用途页：按插件列出行，右侧摘要含「本地固定」或「auto · 策略 → 模型」；标题栏含「· 用途」
 * - 策略槽页（Tab 切换）：7 个槽齐全，AUTO/FREE 标「固定语义」且 Enter 只给提示、不出动作菜单
 * - 每行可见宽度 ≤ 渲染宽度（面板严禁折行——折行会让行数与滚动预算失配、顶穿边框）
 * - ↑ 越界不越位；Enter 进动作层；Esc 逐层退出
 * - 非交互环境的 renderTextSummary 列出策略槽与全部用途
 *
 * 原理：沙箱 HOME 后 esbuild bundle panel.ts / index.ts；TUI 与主题用假对象
 * （面板只用到 terminal.rows、requestRender 与 theme.fg/bold）。
 *
 * 用法：node src/extensions/model-config/test/panel.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "..", "..", "..");
const PANEL_BUNDLE = join(TEST_DIR, ".tmp-panel-bundle.mjs");
const INDEX_BUNDLE = join(TEST_DIR, ".tmp-index-bundle.mjs");

const sandbox = mkdtempSync(join(tmpdir(), "pi-model-config-"));
mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

const bundle = (entry, outfile) =>
	build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});

await bundle(join(SRC_DIR, "extensions", "model-config", "panel.ts"), PANEL_BUNDLE);
await bundle(join(SRC_DIR, "extensions", "model-config", "index.ts"), INDEX_BUNDLE);
const { ModelConfigOverlay } = await import(pathToFileURL(PANEL_BUNDLE).href);
const { renderTextSummary } = await import(pathToFileURL(INDEX_BUNDLE).href);
rmSync(PANEL_BUNDLE, { force: true });
rmSync(INDEX_BUNDLE, { force: true });

// ---- 假 ctx / 假 TUI / 假主题 ----
const mk = (provider, id, input, output, modalities = ["text"]) => ({
	provider,
	id,
	name: id,
	cost: { input, output, cacheRead: 0, cacheWrite: 0 },
	input: modalities,
	contextWindow: 100_000,
});
const session = mk("main", "session-model", 2, 4);
const cheap = mk("p1", "cheap", 0.1, 0.2);
const free = mk("freeA", "free-a", 0, 0);
const all = [free, cheap, session];
const ctx = {
	model: session,
	hasUI: true,
	modelRegistry: {
		getAvailable: () => all,
		hasConfiguredAuth: () => true,
		find: (p, i) => all.find((m) => m.provider === p && m.id === i),
	},
	ui: { custom: async () => undefined, notify: () => {} },
};
const tui = { terminal: { rows: 40 }, requestRender: () => {} };
const theme = { fg: (_c, text) => text, bold: (text) => text, dim: (text) => text };

// 用途声明：面板从 globalThis.__PI_MODEL_DECLS__ 读（插件加载时由 shared/model-setting 推入）
globalThis.__PI_MODEL_DECLS__ = {
	version: 1,
	list: [
		{ purpose: "btw.chat", plugin: "btw", label: "侧栏问答", defaultStrategy: "FAST" },
		{
			purpose: "hud-git.commit",
			plugin: "hud-git",
			label: "提交信息生成",
			defaultStrategy: "LITE",
			file: join(sandbox, "hud-git.json"),
			key: "commit",
		},
	],
};

const K = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", tab: "\t" };
const WIDTH = 90;
const overlay = new ModelConfigOverlay(tui, theme, ctx, () => {});
const lines = () => overlay.render(WIDTH);
const text = () => lines().join("\n");
const widest = () => Math.max(...lines().map((l) => visibleWidth(l)));

// ---- 用途页 ----
const main = text();
check("标题栏标注当前页签", main.includes("模型配置") && main.includes("· 用途"));
check("列出插件与用途标签", main.includes("[btw]") && main.includes("侧栏问答") && main.includes("[hud-git]"));
check("auto 用途显示「auto · 策略（默认） → 模型」", main.includes("auto · FAST（默认） → main/session-model"));
check("底部键位提示含页签切换", main.includes("Tab 策略槽"));
check("每行宽度不超过渲染宽度", widest() <= WIDTH, `最宽 ${widest()} > ${WIDTH}`);

// ↑ 越界：仍在用途页
overlay.handleInput(K.up);
check("↑ 越界不越位且不误触动作层", text().includes("Enter 修改") && !text().includes("中心：按策略"));

// Enter 第一项（btw.chat）→ 动作层
overlay.handleInput(K.enter);
const actions = text();
check("用途行 Enter 打开动作层", actions.includes("中心：按策略") && actions.includes("中心：指定具体模型"));
check("动作层含清除中心设置", actions.includes("清除中心设置"));
check("动作层每行不折行", widest() <= WIDTH, `最宽 ${widest()}`);
overlay.handleInput(K.escape);

// ---- 策略槽页 ----
overlay.handleInput(K.tab);
const strategies = text();
check("Tab 切到策略槽页", strategies.includes("· 策略槽"));
check(
	"7 个策略槽齐全",
	["AUTO", "MAX", "FAST", "LITE", "BASE", "BATCH", "FREE"].every((s) => strategies.includes(s)),
);
check("AUTO/FREE 标固定语义", (strategies.match(/固定语义/g) ?? []).length >= 2);
check("策略页每行不折行", widest() <= WIDTH, `最宽 ${widest()}`);

// AUTO（第 0 项）Enter → 只给提示
overlay.handleInput(K.enter);
const autoView = text();
check("AUTO 行 Enter 给不可改提示", autoView.includes("只能被用途选用"));
check("AUTO 行 Enter 不出动作菜单", !autoView.includes("指定具体模型…"));

// MAX（第 1 项）Enter → 动作层
overlay.handleInput(K.down);
overlay.handleInput(K.enter);
check("MAX 行 Enter 出动作层", text().includes("指定具体模型…") && text().includes("清除映射"));
overlay.handleInput(K.escape);
overlay.handleInput(K.escape); // 关面板（不抛错）
check("Esc 逐层退出不抛错", true);

// ---- 文本摘要（非交互环境） ----
const summary = renderTextSummary(ctx);
check(
	"摘要列出 7 个策略槽",
	["AUTO", "MAX", "FAST", "LITE", "BASE", "BATCH", "FREE"].every((x) => summary.includes(x)),
);
check("摘要列出全部用途", summary.includes("侧栏问答") && summary.includes("提交信息生成"));

rmSync(sandbox, { recursive: true, force: true });
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
