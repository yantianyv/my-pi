#!/usr/bin/env node
/**
 * time 回归测试（esbuild bundle，同 dingtalk-bridge 测试基建）
 *
 * 只测纯函数策略层（不起 pi 实例）：
 * - 场景 A：stamp 形状（带年、本地时区、分钟粒度）
 * - 场景 B：tagUserMessage 的 user 贴/不贴判定（string 与数组两种 content）
 * - 场景 C：非 user 角色一律原样（toolResult / custom混页 / assistant）
 * - 场景 D：防重复贴（已带前缀跳过）
 * - 场景 E：now 输出组装（星期/时区/ISO/epoch 都在）
 *
 * 用法：node src/extensions/test/time.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "time.ts");
const OUT = join(HERE, ".tmp-time-bundle.mjs");

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
	external: ["@earendil-works/*", "typebox"],
	logLevel: "silent",
});
const mod = await import(pathToFileURL(OUT).href);
const { stamp, tagUserMessage, formatNow } = mod;

// 固定锚点（本地时区：+08:00 上是 14:30，恰是 UTC 06:30）
const T1 = Date.parse("2026-10-06T06:30:45Z");
const user = (content, ts = T1, extra = {}) => ({ role: "user", timestamp: ts, content, ...extra });

console.log("A、stamp 形状");
{
	const s = stamp(T1);
	check("带年月日时分", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s), s);
	const s2 = stamp(Date.parse("2026-01-05T00:07:00+08:00"));
	check("单月份/日/时分补零", s2 === "2026-01-05 00:07", s2);
}

console.log("B、user 贴/不贴");
{
	const out = tagUserMessage(user("继续"));
	check("string content 贴前缀（独立成行）", out.content.startsWith("[") && /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\n继续$/.test(out.content));
	const out2 = tagUserMessage(user("  \n"));
	check("纯空白不贴", out2.content === "  \n");
	const out3 = tagUserMessage(user([{ type: "text", text: "帮我看下" }, { type: "image", data: "x" }]));
	check("数组 content 贴到首个 text 块", out3.content[0].text.endsWith("帮我看下") && /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\n/.test(out3.content[0].text));
	const out4 = tagUserMessage(user([{ type: "image", data: "x" }]));
	check("纯图消息不贴", out4.content.length === 1 && out4.content[0].type === "image");
	const out5 = tagUserMessage(user("", T1));
	check("空串不贴", out5.content === "");
}

console.log("C、非 user 原样");
{
	const toolResult = { role: "toolResult", toolCallId: "t1", toolName: "read", timestamp: T1, content: [{ type: "text", text: "文件内容" }], isError: false };
	check("toolResult 不贴", tagUserMessage(toolResult) === toolResult);
	const custom = { role: "custom", customType: "plan-mode", timestamp: T1, content: "注入内容", display: false };
	check("custom 不贴", tagUserMessage(custom) === custom);
	const assistant = { role: "assistant", timestamp: T1, content: [{ type: "text", text: "回复" }] };
	check("assistant 不贴", tagUserMessage(assistant) === assistant);
	const bc = { role: "bashExecution", timestamp: T1, content: "ls", excludeFromContext: false };
	check("bashExecution 不贴", tagUserMessage(bc) === bc);
}

console.log("D、防重复贴（精确对照：同格式但时间不同≠已贴）");
{
	const once = tagUserMessage(user("继续"));
	const twice = tagUserMessage(once);
	check("已贴（时间一致）跳过", twice.content === `[${stamp(T1)}]\n继续`, twice.content);
	// 用户正文自带同格式前缀但时间不同（如粘贴会议纪要）→ 必须照贴，不能误判为已贴
	const pseudo = user("[2026-10-06 10:00] 会议纪要：……");
	const tagged = tagUserMessage(pseudo);
	check("正文自带同格式前缀≠已贴，照贴", tagged.content === `[${stamp(T1)}]\n[2026-10-06 10:00] 会议纪要：……`, tagged.content);
	const arrOnce = tagUserMessage(user([{ type: "text", text: "文本" }]));
	const arrTwice = tagUserMessage(arrOnce);
	const textCount = (arrTwice.content[0].text.match(/\[/g) || []).length;
	check("数组已贴跳过", textCount === 1, arrTwice.content[0].text);
}

console.log("E、now 组装");
{
	const now = Date.now();
	const f = formatNow(now);
	check("text 含星期与时区", /星期/.test(f.text) && /UTC[+-]\d{2}:\d{2}/.test(f.text), f.text);
	check("structured 字段齐全（local/weekday/iso/epochMs）",  f.structured.local && f.structured.weekday && f.structured.iso.includes("T") && f.structured.epochMs === now);
	check("local 与 stamp 一致", f.structured.local === stamp(now));
}

const fail = results.filter((r) => !r.ok).length;
console.log(fail === 0 ? "全部通过 ✓" : `${fail} 项失败 ✗`);
process.exit(fail === 0 ? 0 : 1);
