#!/usr/bin/env node
/**
 * keep 扩展回归测试（无 runner，仓库根执行：node src/extensions/test/keep.test.mjs）
 *
 * 原理：esbuild 把扩展 bundle 成单文件 ESM 再 import（同 qr 测试模式），
 * 用假 pi/ctx 直接驱动 on("turn_end") / on("context") / 命令处理器断言行为。
 *
 * 覆盖：
 * - context 过滤：已完成问答被滤、活尾巴保留、带工具调用的回答保留（工具配对）
 * - 状态机：自然停点注入 keep-ask → A 注入 keep-go → 续跑空转直接停
 * - B/C/解析失败/预算耗尽/排队消息/aborted/关闭状态 均保持停下
 */
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, ".tmp-keep.bundle.mjs");

const results = [];
function check(label, ok, extra) {
	results.push({ label, ok });
	console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || extra === undefined ? "" : ` :: ${extra}`}`);
}

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

const user = (text = "干活") => ({ role: "user", content: text, timestamp: 1 });
const ask = () => ({ role: "custom", customType: "keep-ask", content: "?", display: true, timestamp: 2 });
const go = () => ({ role: "custom", customType: "keep-go", content: "!", display: true, timestamp: 3 });
const answerText = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 4 });
const answerTools = () => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }],
	timestamp: 5,
});
const toolResult = () => ({ role: "toolResult", toolCallId: "1", toolName: "bash", content: [], timestamp: 6 });

let importCount = 0;
// 每个场景独立 import（模块级 enabled 状态不串场；URL 加查询串绕过模块缓存）
// 配置文件经 PI_KEEP_CONFIG 指向唯一临时路径，与真实配置隔离（默认开 = 文件不存在）
async function makeHarness(tools = [], configPath) {
	process.env.PI_KEEP_CONFIG = configPath ?? path.join(os.tmpdir(), `keep-test-${process.pid}-${importCount}.json`);
	const mod = await import(pathToFileURL(OUT).href + `?i=${importCount++}`);
	const handlers = {};
	const notifies = [];
	const commands = {};
	const renderers = {};
	const pi = {
		registerCommand: (name, def) => (commands[name] = def),
		on: (ev, fn) => (handlers[ev] = fn),
		getAllTools: () => tools,
		registerMessageRenderer: (type, r) => (renderers[type] = r),
	};
	(mod.default ?? mod)(pi);
	const ctx = { ui: { notify: (t, k) => notifies.push([k, t]), setStatus: () => {} } };
	const turnEnd = (message, opts = {}) =>
		handlers["turn_end"](
			{ outcome: "completed", message, context: { pendingMessages: [], ...opts.context }, ...opts },
			ctx,
		);
	const filter = (messages) => handlers["context"]({ messages }, ctx).messages;
	const work = (toolName = "edit") => handlers["tool_execution_end"]({ toolName }, ctx);
	const newRun = () => handlers["before_agent_start"]({}, ctx);
	const messageEnd = (message) => handlers["message_end"]?.({ message }, ctx);
	return { handlers, commands, notifies, ctx, turnEnd, filter, work, newRun, messageEnd, renderers };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
	await build({
		entryPoints: [path.join(ROOT, "src/extensions/keep.ts")],
		outfile: OUT,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		logLevel: "silent",
	});
	// ---- context 过滤 ----
	{
		const h = await makeHarness();
		const seq = [user(), answerText("做到一半"), ask(), answerText('{"class":"A"}'), go(), answerTools(), toolResult()];
		const out = h.filter(seq);
		check("过滤：已完成问答（ask/回答/go）被滤掉", out.length === 4 && out.every((m) => m.customType === undefined));
		check("过滤：带工具调用的回答保留（工具配对）", out.some((m) => m.role === "assistant"));
	}
	{
		const h = await makeHarness();
		const live1 = [user(), ask()];
		check("过滤：活尾巴 […, ask] 原样保留", h.filter(live1).length === 2);
		const live2 = [user(), ask(), answerText('{"class":"A"}')];
		check("过滤：活尾巴 […, ask, 回答] 原样保留", h.filter(live2).length === 3);
		const live3 = [user(), ask(), answerText('{"class":"A"}'), go()];
		check("过滤：活尾巴 […, ask, 回答, go] 原样保留", h.filter(live3).length === 4);
	}
	{
		const h = await makeHarness();
		const seq = [user(), ask(), answerTools(), toolResult()];
		const out = h.filter(seq);
		check("过滤：自检轮带工具调用 → 只滤 ask、保留 assistant（配对）",
			out.length === 3 && out[1].role === "assistant" && out[2].role === "toolResult");
	}
	{
		const h = await makeHarness();
		const seq = [user(), answerText("无 keep 消息")];
		check("过滤：无 keep 消息原样通过", h.filter(seq).length === 2);
	}

	// ---- 状态机 ----
	{
		const h = await makeHarness();
		h.work();
		const r1 = h.turnEnd(answerText("做到这里先停了"));
		check("默认开：自然停点 → 注入 keep-ask 并 continue",
			r1?.continue === true && r1.entries?.[0]?.customType === "keep-ask");
		const r2 = h.turnEnd(answerText('{"class":"A","reason":"还差测试","next":"跑测试"}'));
		check("答 A → 注入 keep-go 并 continue",
			r2?.continue === true && r2.entries?.[0]?.customType === "keep-go");
		const r3 = h.turnEnd(answerText("我想了想还是不干了"));
		check("续跑轮仍无 toolCall → 直接停（防死循环）", r3 === undefined);
		check("空转停下有通知", h.notifies.some(([, t]) => t.includes("无实际动作")));
	}
	{
		const h = await makeHarness();
		check("零工具轮（纯问答）不自检", h.turnEnd(answerText("这是答案")) === undefined);
		h.work("read");
		h.work("web_search");
		check("只读工具轮（调研后作答）不自检", h.turnEnd(answerText("调研结论如下")) === undefined);
		h.work("bash");
		check("改写类工具轮（工作型停点）自检", h.turnEnd(answerText("停"))?.continue === true);
	}
	{
		const h = await makeHarness();
		h.work();
		check("工作轮停点自检", h.turnEnd(answerText("停"))?.continue === true);
		h.newRun(); // 新的用户输入 → 重置
		check("新一轮零工具停点不再自检", h.turnEnd(answerText("答")) === undefined);
	}
	{
		// 注解三层判定：readOnlyHint=false → 工作；true → 只读；未声明 → 只读（安全默认）
		const tools = [
			{ name: "kb_write", annotations: { readOnlyHint: false } },
			{ name: "kb_read", annotations: { readOnlyHint: true } },
			{ name: "some_plugin_tool" }, // 无注解
		];
		const h = await makeHarness(tools);
		h.work("kb_read");
		h.work("some_plugin_tool");
		check("注解只读 + 无注解工具 → 不自检", h.turnEnd(answerText("答")) === undefined);
		h.work("kb_write");
		check("注解 readOnlyHint=false → 工作型停点自检", h.turnEnd(answerText("停"))?.continue === true);
	}
	{
		const h = await makeHarness();
		h.work();
		h.turnEnd(answerText("停")); // 注入 keep-ask，进入等回答状态
		const pretty = h.messageEnd(answerText('{"class":"B","reason":"要用户选方案"}'));
		check("答 B → 消息替换为人话行", pretty?.message?.content?.[0]?.text?.includes("需要人工") === true);
		const r = h.turnEnd(answerText('{"class":"B","reason":"要用户选方案"}'));
		check("答 B → 停下", r === undefined);
	}
	{
		const h = await makeHarness();
		check("未在等回答时 message_end 不替换", h.messageEnd(answerText('{"class":"C"}')) === undefined);
		h.work();
		h.turnEnd(answerText("停"));
		check("无法解析的回答原样保留", h.messageEnd(answerText("我觉得可能是 A")) === undefined);
		check("渲染器已注册 keep-ask / keep-go",
			typeof h.renderers["keep-ask"] === "function" && typeof h.renderers["keep-go"] === "function");
	}
	{
		const h = await makeHarness();
		h.work();
		h.turnEnd(answerText("停"));
		const r = h.turnEnd(answerText('{"class":"C","reason":"全部完成"}'));
		check("答 C → 静默停下（无警告通知）",
			r === undefined && !h.notifies.some(([k]) => k === "warning"));
	}
	{
		const h = await makeHarness();
		h.work();
		h.turnEnd(answerText("停"));
		const r = h.turnEnd(answerText("我觉得可能是 A 吧"));
		check("回答无法解析 → 降级停下并通知", r === undefined && h.notifies.some(([, t]) => t.includes("无法解析")));
	}
	{
		const h = await makeHarness();
		h.work();
		h.turnEnd(answerText("停"));
		const r = h.turnEnd(answerText('分析一下：当前还有收尾工作。{"class":"A","reason":"剩收尾","next":"收尾"} 以上。'));
		check("解析加固：散文裹 JSON → 捞出并续跑", r?.continue === true && r.entries?.[0]?.customType === "keep-go");
	}
	{
		const h = await makeHarness();
		h.work();
		h.turnEnd(answerText("停"));
		const r = h.turnEnd(answerText('```json\n{"class":"C","reason":"完了","next":""}\n```'));
		check("解析加固：代码围栏 JSON → 捞出并判 C 停下", r === undefined);
	}
	{
		const h = await makeHarness();
		h.work();
		h.turnEnd(answerText("停"));
		// 第一段花括号是干扰项（无合法 class），第二段才是答案
		const r = h.turnEnd(answerText('格式是 {"class":"D"} 吗？不对，应该是 {"class":"B","reason":"要人拍板","next":""}'));
		check("解析加固：跳过非法候选取后续合法 JSON（判 B 停下）", r === undefined);
	}
	{
		const h = await makeHarness();
		h.work();
		check("aborted 不动作", h.turnEnd(answerText("停"), { outcome: "aborted" }) === undefined);
		check("有排队消息不动作",
			h.turnEnd(answerText("停"), { context: { pendingMessages: [{ role: "user" }] } }) === undefined);
		check("本轮有 toolCall 不动作", h.turnEnd(answerTools()) === undefined);
	}
	{
		const h = await makeHarness();
		h.work();
		let asks = 0;
		for (let i = 0; i < 20; i++) {
			const r = h.turnEnd(answerText("停")); // 自然停点
			if (r?.continue) {
				asks++;
				h.turnEnd(answerText('{"class":"C","reason":"完了"}')); // 答 C 停下，下个停点再自检
			}
		}
		check("预算 16 次用完后强制停", asks === 16, `实际自检 ${asks} 次`);
		check("预算耗尽有通知", h.notifies.some(([, t]) => t.includes("预算")));
	}
	{
		const h = await makeHarness();
		await h.commands["keep"].handler("", h.ctx); // 默认开 → 此调为关
		h.work();
		check("/keep 关闭后自然停点不动作", h.turnEnd(answerText("做完了")) === undefined);
		check("开关已写盘", JSON.parse(readFileSync(process.env.PI_KEEP_CONFIG, "utf8")).enabled === false);
		const h2 = await makeHarness([], process.env.PI_KEEP_CONFIG); // 重新 import 模拟 /reload
		h2.work();
		check("持久化：reload 后仍为关", h2.turnEnd(answerText("又做完了")) === undefined);
		await h2.commands["keep"].handler("", h2.ctx); // 开回
		const h3 = await makeHarness([], process.env.PI_KEEP_CONFIG);
		h3.work();
		check("持久化：开回后 reload 仍为开", h3.turnEnd(answerText("停了"))?.continue === true);
	}
	{
		const h = await makeHarness();
		await h.commands["keep"].handler("多余的参数", h.ctx);
		check("带参调用给用法提示", h.notifies.some(([k]) => k === "warning"));
		h.work();
		check("带参调用不改变开关（仍为开）", h.turnEnd(answerText("停了"))?.continue === true);
	}

	const failed = results.filter((r) => !r.ok);
	console.log(failed.length === 0 ? "\n全部通过 ✓" : `\n${failed.length} 项失败 ✗`);
	rmSync(OUT, { force: true });
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	rmSync(OUT, { force: true });
	process.exit(1);
});
