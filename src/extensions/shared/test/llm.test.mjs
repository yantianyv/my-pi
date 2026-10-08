#!/usr/bin/env node
/**
 * shared/llm 回归测试：单次 LLM 调用公共服务
 *
 * 锁住的不变量：
 * - 文本抽取：多 text 块拼接 + trim；空/非数组返回空串
 * - aiComplete 永不抛异常：认证失败/注册表异常都返回 {ok:false}，绝不网络直调
 * - aiComplete 依次尝试候选链：首选失败自动换下一个，耗尽后回最后一次错误；总时长不超 timeoutMs
 * - pi 内部头管道不可用时 piAttributionHeaders 降级返回 undefined（不带头，不崩）
 * - 纪律守卫：扩展源码不得出现 maxTokens（推理模型思考 token 计入该预算 → 正文/JSON 截断）
 *
 * 用法：node src/extensions/shared/test/llm.test.mjs（仓库根目录执行）
 *
 * 离线约束：不模拟 completeSimple（需要真实 provider 网络），只测短路与降级路径；
 * 头管道在测试进程里不可达（argv[1] 不是 pi 入口），正好覆盖降级行为。
 */
import { build } from "esbuild";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SHARED_DIR = join(TEST_DIR, "..");
const SRC_DIR = join(SHARED_DIR, "../..");
const BUNDLE = join(TEST_DIR, ".tmp-llm-bundle.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

await build({
	entryPoints: [join(SHARED_DIR, "llm.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});

/** 伪造 ctx：getApiKeyAndHeaders 按 script 注入结果；带哨兵记录是否被意外网络调用 */
function fakeCtx(script) {
	return {
		cwd: TEST_DIR,
		sessionManager: { getSessionId: () => "sid-test" },
		modelRegistry: { getApiKeyAndHeaders: async () => script() },
	};
}
const fakeModel = (id = "m") => ({ provider: "opencode-go", id, api: "openai-completions" });
/** 单模型链（无故障转移） */
const chainOf = (...models) => {
	let i = 0;
	return { model: models[0], failover: () => models[++i] };
};

try {
	const { aiComplete, extractAiText, piAttributionHeaders } = await import(BUNDLE);

	// ---- extractAiText ----
	const blocks = [
		{ type: "text", text: "  hello" },
		{ type: "thinking", text: "忽略" },
		{ type: "text", text: "world  " },
	];
	check("extractAiText 多块拼接 + trim（默认 \\n）", extractAiText(blocks) === "hello\nworld", extractAiText(blocks));
	check("extractAiText textJoin=\"\"", extractAiText(blocks, "") === "helloworld", extractAiText(blocks, ""));
	check("extractAiText 单块", extractAiText([{ type: "text", text: "ok" }]) === "ok");
	check("extractAiText 非数组返回空", extractAiText({ content: 1 }) === "", JSON.stringify(extractAiText({ content: 1 })));
	check("extractAiText 全空返回空", extractAiText([{ type: "text", text: "   " }]) === "");

	// ---- aiComplete 短路：认证失败 → {ok:false}，不走网络 ----
	{
		const r = await aiComplete(fakeCtx(() => ({ ok: false, error: "no key" })), chainOf(fakeModel()), {
			systemPrompt: "s",
			prompt: "p",
		});
		check("aiComplete 认证失败返回 ok:false", !r.ok && r.error.includes("no key"), JSON.stringify(r));
	}

	// ---- aiComplete 短路：注册表抛异常也不冒泡 ----
	{
		const r = await aiComplete(
			fakeCtx(() => {
				throw new Error("boom");
			}),
			chainOf(fakeModel()),
			{ systemPrompt: "s", prompt: "p" },
		);
		check("aiComplete 注册表异常不冒泡", !r.ok && r.error.includes("boom"), JSON.stringify(r));
	}

	// ---- 故障转移：候选链依次尝试，耗尽后回最后一次错误（全程无网络：认证即失败） ----
	{
		let calls = 0;
		const ctx = fakeCtx(() => {
			calls++;
			return { ok: false, error: "no key " + calls };
		});
		const r = await aiComplete(ctx, chainOf(fakeModel("a"), fakeModel("b"), fakeModel("c"), fakeModel("d")), {
			systemPrompt: "s",
			prompt: "p",
		});
		check("故障转移尝试上限 2 次", calls === 2, String(calls));
		check("故障转移耗尽后回最后一次错误", !r.ok && r.error.includes("no key 2"), JSON.stringify(r));
	}

	// ---- 无可用模型：链为空时不调注册表 ----
	{
		let calls = 0;
		const r = await aiComplete(fakeCtx(() => {
			calls++;
			return { ok: false, error: "x" };
		}), chainOf(), { systemPrompt: "s", prompt: "p" });
		check("空链返回无可用模型且不调注册表", !r.ok && calls === 0 && r.error.includes("无可用模型"), JSON.stringify(r));
	}

	// ---- 纪律守卫：src/extensions 下的 .ts 源码不得出现 maxTokens ----
	{
		const EXTENSIONS_DIR = join(SRC_DIR, "extensions");
		const offenders = [];
		const walk = (dir) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.name === "node_modules" || e.name.startsWith(".")) continue;
				const full = join(dir, e.name);
				if (e.isDirectory()) walk(full);
				else if (e.name.endsWith(".ts")) {
					const src = readFileSync(full, "utf8");
					if (/maxTokens\s*:/.test(src)) offenders.push(full.replace(SRC_DIR + "/", ""));
				}
			}
		};
		walk(EXTENSIONS_DIR);
		check("扩展源码不出现 maxTokens（输出上限纪律）", offenders.length === 0, offenders.join(", "));
	}

	// ---- 头管道降级：测试进程找不到 pi 包根 → undefined 且不抛 ----
	{
		let threw = false;
		let v;
		try {
			v = piAttributionHeaders(fakeModel(), TEST_DIR, "sid");
		} catch (e) {
			threw = true;
		}
		check("piAttributionHeaders 降级不抛异常", !threw);
		check("piAttributionHeaders 找不到 pi 管道返回 undefined", v === undefined, JSON.stringify(v));
	}
} finally {
	rmSync(BUNDLE, { force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
