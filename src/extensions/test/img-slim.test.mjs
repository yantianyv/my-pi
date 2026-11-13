#!/usr/bin/env node
/**
 * img-slim 回归测试（esbuild bundle + 依赖桩，只测纯函数策略层）
 *
 * - 场景 A：未超泄洪水位 → 不动
 * - 场景 B：超水位 → 从最旧丢到 ≤ LOW，剩下的在低水位以内
 * - 场景 C：最新 N 张永不丢（即使它们本身很大）
 * - 场景 D：同一会话条目里的多张图一次替换，未丢的图与非图块原样保留
 * - 场景 E：占位文本落到被丢的每一张图上
 * - 场景 F：空列表 / 只有少量图都不崩
 *
 * 用法：node src/extensions/test/img-slim.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "img-slim.ts");
const OUT = join(HERE, ".tmp-img-slim-bundle.mjs");
const STUB = join(HERE, ".tmp-img-slim-stub.mjs");

// 策略层不需要真的处理图片：把 pi 的图片编码入口换成空实现，只为让模块能加载
writeFileSync(
	STUB,
	["export const convertToPng = async () => null;", "export const resizeImage = async () => null;"].join("\n"),
);

const results = [];
function check(label, ok, extra) {
	results.push({ label, ok });
	console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || extra === undefined ? "" : ` :: ${extra}`}`);
}

await build({
	entryPoints: [EXT],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: OUT,
	external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"],
	alias: { "@earendil-works/pi-coding-agent": STUB },
	logLevel: "silent",
});
const { planOmissions } = await import(pathToFileURL(OUT).href);

const MB = 1024 * 1024;
const NOTE = "[placeholder]";

/** 造一条消息：blocks 里 "i" 代表一张图（按给定字节数），其余是文本 */
function spot(entryId, blocks, index) {
	return { entryId, bytes: blocks[index], blocks: blocks.map((b) => (typeof b === "number" ? { type: "image", data: "x" } : b)), index };
}

console.log("img-slim: planOmissions");

// ---- A. 未超水位不动 ----
{
	const spots = [spot("e1", [{ type: "text", text: "t" }, 5 * MB], 1)];
	const plan = planOmissions(spots, 32 * MB, 20 * MB, 4, NOTE);
	check("A1 未超 HIGH → 无编辑", plan.edits.length === 0);
	check("A2 未超 HIGH → dropped=0", plan.dropped === 0);
	check("A3 未超 HIGH → remaining 为原总量", plan.remaining === 5 * MB, plan.remaining);
}

// ---- B. 超水位丢到 LOW 以内 ----
{
	const spots = [];
	for (let i = 0; i < 10; i++) spots.push(spot(`e${i + 1}`, [{ type: "text", text: "t" }, 5 * MB], 1)); // 共 50MB
	const plan = planOmissions(spots, 32 * MB, 20 * MB, 4, NOTE);
	check("B1 超 HIGH → 有编辑", plan.edits.length > 0);
	check("B2 降到 LOW 以内", plan.remaining <= 20 * MB, plan.remaining);
	check("B3 从最旧开始丢（e1 在列）", plan.edits.some((e) => e.entryId === "e1"));
	check("B4 最新 4 张不丢（e10 不在列）", !plan.edits.some((e) => e.entryId === "e10"));
	check("B5 dropped 计数与实际一致", plan.dropped === 6, plan.dropped);
}

// ---- C. 最新 N 张即使巨大也不丢 ----
{
	const spots = [
		spot("old", [{ type: "text", text: "t" }, 30 * MB], 1),
		spot("n1", [{ type: "text", text: "t" }, 40 * MB], 1), // 超过 HIGH 本身
	];
	const plan = planOmissions(spots, 32 * MB, 20 * MB, 1, NOTE);
	check("C1 只丢旧图", plan.edits.length === 1 && plan.edits[0].entryId === "old");
	check("C2 最新一张保留（即使自身超水位）", !plan.edits.some((e) => e.entryId === "n1"));
}

// ---- D. 同一条目多图一起替换，非图块与保留图片原样 ----
{
	const blocks = [{ type: "text", text: "截图如下" }, 20 * MB, { type: "text", text: "说明" }, 20 * MB];
	const spots = [spot("e1", blocks, 1), spot("e1", blocks, 3)];
	const plan = planOmissions(spots, 32 * MB, 10 * MB, 0, NOTE);
	check("D1 同条目合并为一条编辑", plan.edits.length === 1);
	const content = plan.edits[0].replacement.content;
	check("D2 两张图都被替换", content[1].type === "text" && content[3].type === "text");
	check("D3 文本块原样保留", content[0].text === "截图如下" && content[2].text === "说明");
	check("D4 块数不变（占位而非删除）", content.length === 4);
}

// ---- E. 保留的图片块不动 ----
{
	const blocks = [2 * MB, 31 * MB];
	const spots = [spot("e1", blocks, 0), spot("e1", blocks, 1)];
	const plan = planOmissions(spots, 32 * MB, 20 * MB, 1, NOTE);
	const content = plan.edits[0].replacement.content;
	check("E1 旧图被替换为占位文本", content[0].type === "text" && content[0].text === NOTE);
	check("E2 最新图保持 image 块", content[1].type === "image");
}

// ---- F. 边界 ----
{
	check("F1 空列表不崩", planOmissions([], 32 * MB, 20 * MB, 4, NOTE).edits.length === 0);
	const one = [spot("e1", [50 * MB], 0)];
	const plan = planOmissions(one, 32 * MB, 20 * MB, 4, NOTE);
	check("F2 图少于保留张数时不丢", plan.edits.length === 0);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed > 0) process.exit(1);
