#!/usr/bin/env node
/**
 * secure 形态识别回归测试
 *
 * 钉住的是「宁可漏、不可误」这条取舍：
 *   1. 13 条固定形态能认出来；
 *   2. 形似但不是凭证的普通文本零命中（这是删掉打分猜��后必须守住的线）；
 *   3. 重叠命中保留最长的那段；
 *   4. 文档里的占位/示例值不命中（靠形态本身，不靠语境判断）。
 *
 * 用法：node src/extensions/secure/test/shapes.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync } from "node:fs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../../..");
const BUNDLE = join(TEST_DIR, ".tmp-shapes.mjs");

let failures = 0;
const check = (name, ok, extra) => {
	if (ok) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra !== undefined ? `（${JSON.stringify(extra)}）` : ""}`);
		failures++;
	}
};

await build({
	entryPoints: [join(SRC_DIR, "extensions", "secure", "shapes.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
const { findShapes, hasShape } = await import(pathToFileURL(BUNDLE).href);

console.log("场景 A：固定形态能认出");
{
	const cases = [
		["GitHub 令牌", "ghp_" + "a".repeat(36)],
		["API 密钥", "sk-" + "b".repeat(32)],
		["AWS 访问密钥", "AKIA" + "C".repeat(16)],
		["GitLab 令牌", "glpat-" + "d".repeat(20)],
		["Slack 令牌", "xoxb-" + "1234567890-abc"],
		["HuggingFace 令牌", "hf_" + "e".repeat(30)],
		["Google 密钥", "AIza" + "f".repeat(35)],
		["npm 令牌", "npm_" + "g".repeat(36)],
	];
	for (const [label, value] of cases) {
		const hits = findShapes(`token is ${value} ok`);
		check(`A: ${label}`, hits.length === 1 && hits[0].label === label, hits.map((h) => h.label));
	}
}

console.log("场景 B：普通文本零命中（误报线）");
{
	const benign = [
		"git commit -m 'fix: 修复登录'",
		"password: true",
		"token = process.env.TOKEN",
		"AKIA 是 AWS 的前缀",
		"sk- 开头的短串不算",
		"eyJhbGci 这不是完整 JWT",
		"这是一个普通中文段落，包含 password 和 secret 两个词",
		"https://example.com/path?q=1",
		"commit abc1234def5678",
		"sha256: 9f86d081884c7d659a2feaa0c55ad015",
	];
	for (const text of benign) {
		check(`B: 不误报·${text.slice(0, 28)}`, !hasShape(text), findShapes(text).map((h) => `${h.label}:${h.value}`));
	}
}

console.log("场景 C：重叠取最长");
{
	// 连接串里嵌着 sk- 形态的密码：取整条连接串
	const dsn = "postgres://user:sk-" + "x".repeat(32) + "@db.example.com:5432/app";
	const hits = findShapes(`DB=${dsn}`);
	check("C: 只命中一处", hits.length === 1, hits.map((h) => h.label));
	check("C: 取整条连接串", hits[0]?.value === dsn, hits[0]?.value);
}

console.log("场景 D：多处命中各自独立");
{
	const text = `a=ghp_${"a".repeat(36)} b=AKIA${"C".repeat(16)}`;
	const hits = findShapes(text);
	check("D: 两处都命中", hits.length === 2, hits.map((h) => h.label));
	check("D: 按起点排序", hits[0].start < hits[1].start, hits.map((h) => h.start));
	check("D: 偏移量能定位", text.slice(hits[0].start, hits[0].end) === hits[0].value);
}

console.log("场景 E：私钥多行");
{
	const pem = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA", "-----END RSA PRIVATE KEY-----"].join("\n");
	const hits = findShapes(`key:\n${pem}\ndone`);
	check("E: 私钥整段命中", hits.length === 1 && hits[0].label === "私钥", hits.map((h) => h.label));
	check("E: 包含结束标记", hits[0]?.value.includes("-----END RSA PRIVATE KEY-----"), hits[0]?.value?.slice(-30));
}

console.log("场景 F：同一值多条形态命中只留一条");
{
	// sk-ant- 同时匹配 sk- 与 sk-ant- 前缀规则（同一条规则内部已覆盖），不应重复
	const value = "sk-ant-api03-" + "z".repeat(40);
	const hits = findShapes(`key=${value}`);
	check("F: 不重复报告", hits.length === 1, hits.map((h) => h.value.slice(0, 20)));
}

rmSync(BUNDLE, { force: true });
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
