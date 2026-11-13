#!/usr/bin/env node
/**
 * secure 凭据面板回归测试
 *
 * 钉住的面板行为：
 *   1. 空库时给引导（不是空白面板）；
 *   2. 三步录入（名字 → 用途 → 值）逐级校验，非法名字不往下走；
 *   3. 值全程掩码，面板文本里不出现明文（截屏/录屏泄漏面）；
 *   4. 删除要二次确认，n/Esc 取消不删；
 *   5. 重名不许录入；
 *   6. 值不可为空。
 *
 * 用法：node src/extensions/secure/test/cred-panel.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync } from "node:fs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../../..");
const BUNDLE = join(TEST_DIR, ".tmp-cred-panel.mjs");

let failures = 0;
const check = (name, ok, extra) => {
	if (ok) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra !== undefined ? `（${JSON.stringify(extra)}）` : ""}`);
		failures++;
	}
};

await build({
	entryPoints: [join(SRC_DIR, "extensions", "secure", "cred-panel.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
const { CredPanel } = await import(pathToFileURL(BUNDLE).href);

const themeMock = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const K = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" };
const WIDTH = 72;

/** 面板文本（去边框后拼接，便于断言跨行内容） */
const panelText = (lines) =>
	lines
		.map((l) => {
			const m = l.match(/^│([\s\S]*)│$/);
			return (m ? m[1] : l).trim();
		})
		.join("");

/** 建一个带内存库的面板；返回 { panel, lines, type, store } */
function makePanel(initial = {}) {
	const store = new Map(Object.entries(initial));
	let closed = false;
	const panel = new CredPanel(
		{ requestRender() {} },
		themeMock,
		{
			entries: () =>
				[...store.entries()].map(([name, v]) => ({
					name,
					kind: "secret",
					length: v.length,
					addedAt: 0,
					...(v.length >= 24 ? { preview: `${v.slice(0, 4)}…${v.slice(-4)}` } : {}),
				})),
			add: ({ name, label, value }) => {
				if (store.has(name)) return `已有 {{sec:${name}}}`;
				store.set(name, value);
				void label;
				return null;
			},
			remove: (name) => store.delete(name),
		},
		() => {
			closed = true;
		},
	);
	const lines = () => panel.render(WIDTH);
	const type = (text) => {
		for (const ch of text) panel.handleInput(ch);
	};
	return { panel, lines, type, store, isClosed: () => closed };
}

console.log("场景 A：空库引导");
{
	const { lines } = makePanel();
	const text = panelText(lines());
	check("A: 提示按 n 录入", text.includes("按 n 录入"), text);
	check("A: 提示不落盘", text.includes("不落盘"), text);
}

console.log("场景 B：三步录入");
{
	const { panel, lines, type, store } = makePanel();
	panel.handleInput("n");
	check("B: n 进入名字步", panelText(lines()).includes("新增凭据 · 名字"), panelText(lines()));

	type("gh");
	panel.handleInput(K.enter);
	check("B: 合法名字进入用途步", panelText(lines()).includes("新增凭据 · 用途"), panelText(lines()));

	// 用途可留空
	panel.handleInput(K.enter);
	check("B: 空用途允许进入值步", panelText(lines()).includes("新增凭据 · 值"), panelText(lines()));

	type("ghp_realtoken_value_1234567890");
	const masked = panelText(lines());
	check("B: 值显示为掩码点", masked.includes("••••"), masked);
	check("B: 面板文本不含明文", !masked.includes("ghp_realtoken_value"), masked);

	panel.handleInput(K.enter);
	check("B: 录入成功入库", store.get("gh") === "ghp_realtoken_value_1234567890", store.get("gh"));
	check("B: 回到列表态", panelText(lines()).includes("凭据（本会话内存"), panelText(lines()));
	check("B: 列表显示新条目", panelText(lines()).includes("{{sec:gh}}"), panelText(lines()));
}

console.log("场景 C：录入校验");
{
	// 非法名字不许往下走
	const a = makePanel();
	a.panel.handleInput("n");
	a.type("1bad");
	a.panel.handleInput(K.enter);
	check("C: 非法名字停在名字步", panelText(a.lines()).includes("新增凭据 · 名字"), panelText(a.lines()));
	check("C: 非法名字给原因", panelText(a.lines()).includes("名字不合法"), panelText(a.lines()));

	// 重名不许录入
	const b = makePanel({ gh: "existing-value-1234" });
	b.panel.handleInput("n");
	b.type("gh");
	b.panel.handleInput(K.enter);
	check("C: 重名停在名字步", panelText(b.lines()).includes("新增凭据 · 名字"), panelText(b.lines()));
	check("C: 重名给提示", panelText(b.lines()).includes("已经") || panelText(b.lines()).includes("已有"), panelText(b.lines()));

	// 空值不许提交
	const c = makePanel();
	c.panel.handleInput("n");
	c.type("k");
	c.panel.handleInput(K.enter);
	c.panel.handleInput(K.enter); // 跳过用途
	c.panel.handleInput(K.enter); // 空值直接 Enter
	check("C: 空值不提交", c.store.size === 0, [...c.store.keys()]);
	check("C: 空值给原因", panelText(c.lines()).includes("不能为空"), panelText(c.lines()));
}

console.log("场景 D：删除需二次确认");
{
	const { panel, lines, store } = makePanel({ gh: "v".repeat(30), aws: "w".repeat(30) });
	// 选第二条（aws）
	panel.handleInput(K.down);
	check("D: 选中条目不显示真值", !panelText(lines()).includes("w".repeat(30)), "泄漏");

	panel.handleInput("d");
	check("D: d 进入确认态", panelText(lines()).includes("确认删除"), panelText(lines()));
	check("D: 确认态尚未删除", store.size === 2, store.size);

	panel.handleInput("n");
	check("D: n 取消不删", store.size === 2, store.size);
	check("D: 取消回到列表", panelText(lines()).includes("凭据（本会话内存"), panelText(lines()));

	panel.handleInput("d");
	panel.handleInput("y");
	check("D: y 确认删除", store.size === 1, store.size);
	check("D: 删掉的是选中那条", !store.has("aws") && store.has("gh"), [...store.keys()]);
}

console.log("场景 E：Esc 逐级返回");
{
	const { panel, lines, type, isClosed } = makePanel({ gh: "v".repeat(30) });
	panel.handleInput("n");
	type("x");
	panel.handleInput(K.escape);
	check("E: 编辑态 Esc 回列表", panelText(lines()).includes("凭据（本会话内存"), panelText(lines()));
	check("E: 编辑态 Esc 不关闭面板", !isClosed());

	panel.handleInput(K.escape);
	check("E: 列表态 Esc 关闭面板", isClosed());
}

rmSync(BUNDLE, { force: true });
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
