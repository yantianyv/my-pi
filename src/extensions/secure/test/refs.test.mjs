#!/usr/bin/env node
/**
 * secure 凭据中转回归测试
 *
 * 钉住的不变量（这几条错了就是安全性质变了，不是功能缺陷）：
 *   1. 展开只在执行瞬间发生，值不进命令参数、不进结果文本；
 *   2. 回遮只按**本次实际注入过的值**替换——不猜，所以不会误伤普通文本；
 *   3. 回遮按长度降序替换，短值是长值前缀时不会切碎；
 *   4. 库按会话槽位隔离，跨会话不串值；
 *   5. 缺名字的引用原样保留并被报告，不静默变成空串。
 *
 * 用法：node src/extensions/secure/test/refs.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../../..");
const BUNDLE_REFS = join(TEST_DIR, ".tmp-refs.mjs");
const BUNDLE_VAULT = join(TEST_DIR, ".tmp-vault.mjs");
// 隔离状态目录：盐文件不许碰真实的 ~/.pi/agent
const STATE = mkdtempSync(join(tmpdir(), "pi-secure-state-"));
process.env.SECURE_STATE_DIR = STATE;

let failures = 0;
const check = (name, ok, extra) => {
	if (ok) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra !== undefined ? `（${JSON.stringify(extra)}）` : ""}`);
		failures++;
	}
};

for (const [entry, out] of [
	["refs.ts", BUNDLE_REFS],
	["vault.ts", BUNDLE_VAULT],
]) {
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "secure", entry)],
		outfile: out,
		bundle: true,
		format: "esm",
		platform: "node",
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});
}
const refs = await import(pathToFileURL(BUNDLE_REFS).href);
const { Vault, vaultFor, dropVault, isValidName } = await import(pathToFileURL(BUNDLE_VAULT).href);

console.log("场景 A：引用展开");
{
	const lib = { gh: "ghp_secretvalue123456", aws: "AKIAIOSFODNN7EXAMPLE" };
	const r = refs.expandRefs("curl -H 'Auth: {{sec:gh}}' {{sec:aws}}", (n) => lib[n]);
	check("A: 两个引用都展开", r.text.includes(lib.gh) && r.text.includes(lib.aws), r.text);
	check("A: used 按出现顺序记录", r.used.join(",") === "gh,aws", r.used);
	check("A: 无缺失", r.missing.length === 0, r.missing);

	const dup = refs.expandRefs("{{sec:gh}} 与 {{sec:gh}}", (n) => lib[n]);
	check("A: 同名字重复引用只记一次", dup.used.join(",") === "gh", dup.used);
	check("A: 重复引用两处都展开", (dup.text.match(/ghp_secretvalue123456/g) ?? []).length === 2, dup.text);

	const miss = refs.expandRefs("echo {{sec:nope}}", () => undefined);
	check("A: 缺失引用原样保留（不变成空串）", miss.text === "echo {{sec:nope}}", miss.text);
	check("A: 缺失被报告", miss.missing.join(",") === "nope", miss.missing);
}

console.log("场景 B：按已知值回遮（不靠猜）");
{
	const known = [{ name: "gh", value: "ghp_secretvalue123456" }];
	const hit = refs.maskKnown("token is ghp_secretvalue123456 done", known);
	check("B: 已知值被替换成占位", hit.text === "token is «已隐藏:gh» done", hit.text);
	check("B: 报告被替换的名字", hit.replaced.join(",") === "gh", hit.replaced);

	// 关键：长得像凭证但本次没注入过的，不许动
	const other = refs.maskKnown("token is ghp_differentvalue99999", known);
	check("B: 未注入过的相似值不被误伤", other.text === "token is ghp_differentvalue99999", other.text);
	check("B: 无误伤时不报告替换", other.replaced.length === 0, other.replaced);

	const plain = refs.maskKnown("hello world, 这是一段普通中文", known);
	check("B: 普通文本零改动", plain.text === "hello world, 这是一段普通中文", plain.text);
}

console.log("场景 C：前缀重叠按长度降序");
{
	// abc 是 abcdef 的前缀：先换短的会留下 «已隐藏:short»def
	const known = [
		{ name: "short", value: "abcdef" },
		{ name: "long", value: "abcdefghij" },
	];
	const r = refs.maskKnown("value=abcdefghij", known);
	check("C: 长值优先，不留残片", r.text === "value=«已隐藏:long»", r.text);
}

console.log("场景 D：库与会话槽位");
{
	const a = vaultFor("session-A");
	a.add({ name: "gh", value: "v1" });
	check("D: 同一槽位拿到同一条目", vaultFor("session-A").get("gh") === "v1");

	const b = vaultFor("session-B");
	check("D: 不同槽位互不可见", b.get("gh") === undefined);

	a.add({ name: "aws", value: "v2", label: "AWS 密钥" });
	const list = a.list();
	check("D: list 不含 value 字段", list.every((e) => !("value" in e)), Object.keys(list[0] ?? {}));
	check("D: list 带 label", list.find((e) => e.name === "aws")?.label === "AWS 密钥");
	check("D: 短值不给 preview", list.find((e) => e.name === "aws")?.preview === undefined);

	const long = new Vault();
	long.add({ name: "k", value: "x".repeat(40) });
	check("D: 长值给首尾预览", long.list()[0].preview === "xxxx…xxxx", long.list()[0].preview);

	dropVault("session-A");
	check("D: drop 后槽位置空", vaultFor("session-A").size() === 0);
	dropVault("session-B");
}

console.log("场景 E：名字规则");
{
	check("E: 合法名字", ["gh", "a.b_c-d1", "A1"].every(isValidName));
	check("E: 非法名字被拒", ["1abc", "-x", "a b", "a{", ""].every((n) => !isValidName(n)));
}

console.log("场景 F：同值不重复入库");
{
	const v = new Vault();
	v.add({ name: "one", value: "same-value-1234" });
	check("F: nameOfValue 找到已有名字", v.nameOfValue("same-value-1234") === "one");
	check("F: 未录入的值返回 undefined", v.nameOfValue("other-5678") === undefined);

	// 同一个密钥重复粘贴三次：只该有一个条目
	const lib = new Vault();
	const store = (value) => {
		const existing = lib.nameOfValue(value);
		if (existing) return existing;
		const name = `k${lib.size() + 1}`;
		lib.add({ name, value });
		return name;
	};
	const first = store("sk-same-key-value");
	const second = store("sk-same-key-value");
	const third = store("sk-same-key-value");
	check("F: 重复粘贴复用同一个名字", first === second && second === third, [first, second, third]);
	check("F: 重复粘贴不增加条目", lib.size() === 1, lib.size());
}

console.log("场景 G：哈希命名（同值同名、异值异名）");
{
	const { nameFor, valueFingerprint } = await import(pathToFileURL(BUNDLE_VAULT).href);
	const a1 = nameFor("API 密钥", "sk-alpha-value-123");
	const a2 = nameFor("API 密钥", "sk-alpha-value-123");
	const b = nameFor("API 密钥", "sk-beta-value-456");
	check("G: 同值同名", a1 === a2, [a1, a2]);
	check("G: 异值异名", a1 !== b, [a1, b]);
	check("G: 名字带类型前缀", a1.startsWith("apikey-"), a1);
	check("G: 指纹为 8 位十六进制", /^[0-9a-f]{8}$/.test(a1.split("-")[1]), a1);
	check("G: 指纹不含值本身", !a1.includes("alpha"), a1);

	// 跨会话可辨的本质：指纹只由值决定，与调用时机无关
	check("G: 指纹稳定", valueFingerprint("same-value") === valueFingerprint("same-value"));
	check("G: 不同前缀同一值仍是同一指纹", nameFor("私钥", "v").split("-")[1] === nameFor("连接串", "v").split("-")[1]);
}

rmSync(BUNDLE_REFS, { force: true });
rmSync(BUNDLE_VAULT, { force: true });
rmSync(STATE, { recursive: true, force: true });
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
