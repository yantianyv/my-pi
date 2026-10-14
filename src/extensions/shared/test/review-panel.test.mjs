#!/usr/bin/env node
/**
 * shared/review-panel 回归测试（钉钉 / secret 等写操作确认面板共用）
 *
 * 原理：esbuild 把 shared/review-panel.ts bundle 成单文件 ESM 再 import；
 * theme mock 纯文本透传，TUI mock 只提供 terminal 尺寸（面板不自绘滚动条）。
 *
 * 覆盖：
 * - 场景 A：长单行正文按面板宽度折行——PgDn 能一路看到尾，不出现 "…" 吞字
 * - 场景 B：正文区高度固定（正文 0 行 / 1 行 / 长文，面板总行数一致）
 * - 场景 C：短正文不受折行影响，PgUp/PgDn 在不足一页时原地不动
 *
 * 用法：node src/extensions/shared/test/review-panel.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, ".tmp-review-panel-bundle.mjs");
await build({
	entryPoints: [join(here, "..", "review-panel.ts")],
	outfile: bundlePath,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*"],
	target: "es2022",
	logLevel: "silent",
});
const mod = await import(pathToFileURL(bundlePath).href);

const WIDTH = 100;
const K = { pageUp: "\x1b[5~", pageDown: "\x1b[6~" };
const themeMock = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const makeTui = () => ({ terminal: { rows: 30, columns: WIDTH }, requestRender() {} });

let failures = 0;
const check = (name, cond) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}`);
		failures++;
	}
};

function makePanel(req) {
	return new mod.ReviewPanel(makeTui(), themeMock, {
		title: "agent请求操作钉钉",
		verb: "群发单聊",
		object: "收件人：李娜 等 8 人",
		impact: ["每人各收到一条单聊；发出即送达"],
		actions: [mod.REVIEW_ALLOW, mod.REVIEW_REMEMBER, mod.REVIEW_REJECT],
		rememberNote: "群发单聊",
		...req,
	}, () => {});
}

/** 去掉边框与缩进，便于断言内容是否可见 */
const bodyText = (lines) => lines.map((l) => l.replace(/^│|│$/g, "").trim()).join("\n");

console.log("场景 A：长单行正文折行 + 翻页");
{
	const tail = "正文尾部标记甲乙方";
	const body = "各位老师请注意，" + "这是一段需要核对的长消息内容。".repeat(30) + tail;
	const panel = makePanel({ content: [body] });
	const first = panel.render(WIDTH);
	check("A: 每行不超宽（面板宽度 100）", first.every((l) => visibleWidth(l) <= WIDTH));
	check("A: 首屏有 ▼ 翻页指示", bodyText(first).includes("▼"));
	let seen = bodyText(first);
	let hops = 0;
	while (!seen.includes(tail) && hops < 30) {
		panel.handleInput(K.pageDown);
		seen = bodyText(panel.render(WIDTH));
		hops++;
	}
	check(`A: PgDn 后正文尾部完整可见（翻了 ${hops} 页）`, seen.includes(tail));
	check("A: 尾部可见时仍有 ▲ 回页指示", seen.includes("▲"));
	for (let i = 0; i < hops + 1; i++) panel.handleInput(K.pageUp);
	check("A: PgUp 回到顶部（正文开头可见）", bodyText(panel.render(WIDTH)).includes("各位老师请注意"));
}

console.log("场景 B：正文区高度固定");
{
	const rows = (req) => makePanel(req).render(WIDTH).length;
	const empty = rows({ content: [] });
	const one = rows({ content: ["【AI发送】今晚 8 点线上教研"] });
	// 折行后恰好不满一页（5 行）的正文：仍占满固定区
	const short = rows({ content: ["这是一行不长不短的正文。".repeat(12)] });
	check(`B: 空正文 / 单行 / 不满一页的面板行数一致（${empty} 行）`, empty === one && one === short);
	const long = rows({ content: ["很长的一行正文".repeat(60)] });
	check(`B: 超一页时只多一行滚动指示（${empty} → ${long}）`, long === empty + 1);
}

console.log("场景 C：短正文不受影响");
{
	const panel = makePanel({ content: ["【AI发送】今晚 8 点线上教研"] });
	const first = bodyText(panel.render(WIDTH));
	check("C: 短正文原样可见", first.includes("【AI发送】今晚 8 点线上教研"));
	panel.handleInput(K.pageDown);
	check("C: 不足一页时 PgDn 不移动内容", bodyText(panel.render(WIDTH)).includes("【AI发送】今晚 8 点线上教研"));
}

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
