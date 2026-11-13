#!/usr/bin/env node
/**
 * codemode 调用判定回归测试（复用 shared/test 的 esbuild bundle 模式）
 *
 * 判定规则来自 pi：嵌套调用（codemode 脚本发起）的 toolCallId 为 `<父 id>/<序号>`，
 * 模型直接调用则是单段 id。判定只用来分流「需要人工交互的工具」，
 * 误判会把正常调用拒掉，所以边界要钉住。
 */
import { build } from "esbuild";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, ".tmp-codemode-bundle.mjs");
await build({
	entryPoints: [join(here, "..", "codemode.ts")],
	outfile: bundlePath,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	logLevel: "silent",
});
const { isCodemodeCall } = await import(pathToFileURL(bundlePath).href);

let passed = 0;
function check(name, input, expected) {
	assert.equal(isCodemodeCall(input), expected, `${name}：输入 ${JSON.stringify(input)}`);
	console.log(`  ✓ ${name}`);
	passed++;
}

console.log("A、嵌套调用（来自 codemode 脚本）");
check("父 id/序号", "call_abc/1", true);
check("父 id 本身含下划线", "toolu_01ABC123/12", true);
check("取最后一段判定", "a/b/3", true);

console.log("B、直接调用");
check("单段 id", "call_abc123", false);
check("纯数字", "42", false);
check("空串", "", false);
check("未传", undefined, false);

console.log("C、可疑形态不误判");
check("结尾斜杠", "call_abc/", false);
check("开头斜杠", "/call_abc", false);
check("单独斜杠", "/", false);

console.log(`\n全部通过（${passed} 项）`);
