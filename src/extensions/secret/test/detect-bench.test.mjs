#!/usr/bin/env node
/**
 * secret / 识别算法基准测试
 *
 * 三部分：
 *   1. 语料（corpus/detect.tsv）：每条断言「档位」，失败时打印逐项得分，便于定位是哪一项在起作用；
 *   2. 运行时生成的用例：编码形式（base64/hex 后的令牌应被认出来）；
 *   3. 真实世界的负样本：package-lock.json、本仓库 README、本扩展自己的源码——必须一条都不判成凭证。
 *
 * 三档语义与打分规则见 src/extensions/secret/detect.ts 的文件头。改识别规则后先跑这个，
 * 看一眼命中与误报有没有变化，再决定要不要调分。
 *
 * 输出只印标签、档位、得分、值指纹与理由，**不印值**：测试输出也是要回流到模型的东西，
 * 不该自己再造一份泄漏面。
 *
 * 用法：node src/extensions/secret/test/detect-bench.test.mjs（仓库根目录执行）
 */
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../../..");
const CORPUS = join(TEST_DIR, "corpus", "detect.tsv");

let failures = 0;
let checked = 0;
const check = (name, cond, extra = "") => {
	checked++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`);
		failures++;
	}
};

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);

const describeFindings = (findings) =>
	findings.length === 0
		? "无命中"
		: findings.map((f) => `[${f.tier} ${f.score}] #${digest(f.value)} len=${f.value.length} — ${f.reasons.join(" / ")}`).join("\n      ");

/** 期望档位与命中情况的一致性判定。 */
const matches = (findings, expected) =>
	expected === "ignore"
		? findings.every((f) => f.tier === "ignore")
		: findings.some((f) => f.tier === expected) && findings.every((f) => f.tier === expected);

function parseCorpus() {
	const rows = [];
	for (const raw of readFileSync(CORPUS, "utf8").split("\n")) {
		const line = raw.trimEnd();
		if (line.length === 0 || line.startsWith("#")) continue;
		const [tier, source, label, ...rest] = line.split("\t");
		rows.push({ tier, source, label, text: rest.join("\t").replace(/\\n/g, "\n") });
	}
	return rows;
}

const tmp = mkdtempSync(join(tmpdir(), "secret-bench-"));
await build({
	entryPoints: [join(SRC_DIR, "extensions", "secret", "detect.ts")],
	outfile: join(tmp, "detect.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	logLevel: "silent",
});
const { scout, highEntropySpans } = await import(pathToFileURL(join(tmp, "detect.mjs")));
const scan = (text, source) => scout(text, { source });

// ── 1. 语料 ────────────────────────────────────────────────────────────
const rows = parseCorpus();
console.log(`语料：${rows.length} 条`);
for (const row of rows) {
	const findings = scan(row.text, row.source);
	check(`${row.tier}/${row.source} — ${row.label}`, matches(findings, row.tier), `实际：${describeFindings(findings)}`);
}

// ── 2. 编码形式（运行时生成，免得把 base64 硬编码进语料） ────────────────
console.log("\n编码形式");
const GH = "ghp_" + "Qw8ErTy2UiOp3AsDf4GhJk5LzXc6Vb7Nm9Q1";
const asBase64 = Buffer.from(GH, "utf8").toString("base64");
const encoded = scan(`备用令牌 ${asBase64}`, "paste");
check("base64 后的令牌能被认出来", encoded.some((f) => f.tier === "adopt"), describeFindings(encoded));
const asHex = Buffer.from(GH, "utf8").toString("hex");
check("hex 后的令牌能被认出来", scan(`备用 ${asHex}`, "paste").some((f) => f.tier === "adopt"));
const prose = Buffer.from("this is just some ordinary text that is not a credential", "utf8").toString("base64");
const proseFindings = scan(`备注 ${prose}`, "output");
check("普通文本的 base64 不误报", proseFindings.every((f) => f.tier === "ignore"), describeFindings(proseFindings));

// ── 3. 真实负样本 ──────────────────────────────────────────────────────
console.log("\n真实文本（必须一条都不判成凭证）");
const bulk = [
	["package-lock.json", join(SRC_DIR, "package-lock.json")],
	["仓库 README.md", join(SRC_DIR, "..", "README.md")],
	["AGENTS.md", join(SRC_DIR, "..", "AGENTS.md")],
	["detect.ts 自身", join(SRC_DIR, "extensions", "secret", "detect.ts")],
	["index.ts 自身", join(SRC_DIR, "extensions", "secret", "index.ts")],
	["fingerprint.ts 自身", join(SRC_DIR, "extensions", "secret", "fingerprint.ts")],
];
for (const [label, file] of bulk) {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		check(`${label} 可读`, false, `读不到：${file}`);
		continue;
	}
	const findings = scan(text, "output").filter((f) => f.tier !== "ignore");
	check(`${label}（${text.length} 字符）零误报`, findings.length === 0, describeFindings(findings));
}

// ── 4. 高熵确认的触发条件 ──────────────────────────────────────────────
console.log("\n高熵确认");
const bare = "Zq7-tR4mWp2xLb9Ns6Kd";
const bareSpans = highEntropySpans(`帮我拿 ${bare} 试一下`);
check("裸口令会被高熵确认捕获", bareSpans.length === 1 && digest(bareSpans[0]) === digest(bare));
check("路径不会被捕获", highEntropySpans("打开 D:/Projects/开发工具/my_pi/src/extensions/secret/index.ts 看看").length === 0);
check("带关键词的值不走高熵确认", highEntropySpans("密码：hunter2xyz").length === 0);
check("英文句子不会被捕获", highEntropySpans("The password must be at least 12 characters long and rotated.").length === 0);
check("git 提交号不会被捕获", highEntropySpans("见提交 9f8e7d6c5b4a39281706f5e4d3c2b1a098765432 的改动").length === 0);

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? `\n全部通过（${checked} 项）` : `\n${failures}/${checked} 项失败`);
// 用 exitCode 而不是 process.exit()：后者会丢掉尚未刷出的 stdout 缓冲。
process.exitCode = failures === 0 ? 0 : 1;
