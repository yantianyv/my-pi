#!/usr/bin/env node
/**
 * secret / 纯逻辑回归测试：ref 语法、会话库、凭证识别
 *
 * 三个模块都不依赖 pi 运行时，只用 node 内置模块；用 esbuild（src/node_modules）bundle
 * 成 ESM 后 import。测试的是一条链路上最容易静默出错的部分——名字规范化、撞名、短值
 * 边界、误伤——所以断言都写成「该命中」与「不该命中」两侧。
 *
 * 用法：node src/extensions/secret/test/core.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../../..");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
		failures++;
	}
};

const tmp = mkdtempSync(join(tmpdir(), "secret-core-test-"));
try {
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "secret", "refs.ts"), join(SRC_DIR, "extensions", "secret", "vault.ts"), join(SRC_DIR, "extensions", "secret", "detect.ts"), join(SRC_DIR, "extensions", "secret", "engine.ts"), join(SRC_DIR, "extensions", "secret", "fingerprint.ts")],
		outdir: tmp,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
	const refs = await import(pathToFileURL(join(tmp, "refs.js")));
	const vaultMod = await import(pathToFileURL(join(tmp, "vault.js")));
	const detect = await import(pathToFileURL(join(tmp, "detect.js")));
	const engine = await import(pathToFileURL(join(tmp, "engine.js")));
	const fp = await import(pathToFileURL(join(tmp, "fingerprint.js")));

	// ── refs ────────────────────────────────────────────────────────────────
	console.log("\nrefs");
	check("refFor 拼出 ref", refs.refFor("db_pass") === "{{sec:db_pass}}");
	check("合法名字通过", refs.isValidName("db-pass.v2") && refs.isValidName("A"));
	check("非法名字拒绝", !refs.isValidName("1abc") && !refs.isValidName("a b") && !refs.isValidName(""));
	check("名字长度上限 64", refs.isValidName("a".repeat(64)) && !refs.isValidName("a".repeat(65)));
	check("环境变量名规范化", refs.envVarName("db-pass.v2") === "PI_SEC_DB_PASS_V2");
	check("bash 展开自带双引号", refs.bashExpansion("PI_SEC_A") === '"${PI_SEC_A}"');
	check("refsIn 去重保序", JSON.stringify(refs.refsIn("{{sec:a}} x {{sec:b}} {{sec:a}}")) === '["a","b"]');
	check("refsIn 忽略非法名字", refs.refsIn("{{sec:1bad}} {{sec:ok}}").length === 1);
	check("撞名检出", refs.envCollisions(["db-pass", "db.pass"]).length === 1);
	check("无撞名时为空", refs.envCollisions(["a", "b"]).length === 0);

	const ex = refs.expandRefs("run {{sec:a}} and {{sec:gone}}", (n) => (n === "a" ? "REAL" : undefined));
	check("展开命中", ex.text === "run REAL and {{sec:gone}}", ex.text);
	check("展开记录 used/missing", ex.used.length === 1 && ex.missing[0] === "gone");

	const bash = refs.expandForBash('curl -H "x: {{sec:db_pass}}" {{sec:gone}} end', (n) => (n === "db_pass" ? "REAL" : undefined));
	check("bash 展开成环境变量引用", bash.command === 'curl -H "x: "${PI_SEC_DB_PASS}"" {{sec:gone}} end', bash.command);
	check("bash 展开不把真值写进命令", !bash.command.includes("REAL"));
	check("bash 真值只进 env", bash.env.PI_SEC_DB_PASS === "REAL" && Object.keys(bash.env).length === 1);
	check("bash 缺名字时保持原样", bash.command.includes("{{sec:gone}}") && bash.used.length === 1);

	// ── vault ───────────────────────────────────────────────────────────────
	console.log("\nvault");
	const v = new vaultMod.Vault();
	const long = "sk-live-" + "a".repeat(40);
	v.add({ name: "short", value: "abc" });
	v.add({ name: "long", value: long });
	check("get 取值", v.get("long") === long);
	check("同名覆盖标记 replaced", v.add({ name: "long", value: long + "x" }).replaced === true);
	check("publicList 不带 value", v.publicList().every((e) => !("value" in e)));
	check("preview 仅长值有", v.publicList().find((e) => e.name === "long").preview !== undefined && v.publicList().find((e) => e.name === "short").preview === undefined);
	check("maskables 过滤短值并按长度降序", v.maskables().length === 1 && v.maskables()[0].name === "long");
	check("rename 重名拒绝", v.rename("long", "short").ok === false);
	check("rename 成功", v.rename("long", "renamed").ok === true && v.get("renamed") !== undefined);
	check("remove 生效", v.remove("renamed") === true && v.size === 1);

	const v2 = vaultMod.vaultFor("scope-a");
	v2.add({ name: "x", value: "0123456789" });
	check("vaultFor 同 scope 同实例", vaultMod.vaultFor("scope-a") === v2);
	vaultMod.dropVault("scope-a");
	check("dropVault 后是空库", vaultMod.vaultFor("scope-a").size === 0);

	// ── detect ──────────────────────────────────────────────────────────────
	// 语料级的判定在 detect-bench.test.mjs；这里只钉住 scout 的三档语义与位置行为。
	console.log("detect");
	const gh = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
	const asPaste = (t) => detect.scout(t, { source: "paste" });
	const asOutput = (t) => detect.scout(t, { source: "output" });
	check("粘贴的令牌可收录", asPaste(`token=${gh}`).some((f) => f.value === gh && f.tier === "adopt"));
	check("同一内容在输出侧只遮不收", asOutput(`token=${gh}`).every((f) => f.tier === "mask"));
	check("中文关键词命中并收录", asPaste("我的密码：hunter2xyz 记一下").some((f) => f.value === "hunter2xyz" && f.tier === "adopt"));
	check("尾部标点被剥掉", asPaste("密码：hunter2xyz。").some((f) => f.value === "hunter2xyz"));
	check("配置词形落到 ignore", asOutput('password: "required"').every((f) => f.tier === "ignore"));
	check("普通代码不误伤", asOutput('const hash = "a1b2c3d4e5f6";').length === 0);
	check("过短值不收", asOutput("token=abc").length === 0);
	check("逐项得分可读", asPaste(`token=${gh}`)[0].reasons.length > 0);

	const masked = detect.maskShapes(`key is ${gh} end`, "output");
	check("形态遮蔽替换为占位", !masked.text.includes(gh) && masked.hits === 1, masked.text);
	check("ignore 档原样留下", detect.maskShapes('password: "required"', "output").text === 'password: "required"');
	check("可自定替换文本", detect.maskShapes(gh, "output", () => "{{sec:gh}}").text === "{{sec:gh}}");

	// ── engine ──────────────────────────────────────────────────────────────
	console.log("\nengine");
	const ev = new vaultMod.Vault();
	const secret = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
	ev.add({ name: "gh", value: secret });
	const masked1 = engine.maskText(`curl -H 'x: ${secret}' https://x`, ev);
	check("已知值换成 ref", masked1.text.includes("{{sec:gh}}") && !masked1.text.includes(secret), masked1.text);
	check("命中计数", masked1.hits === 1);

	const shortish = new vaultMod.Vault();
	shortish.add({ name: "short", value: "abcdefgh" });
	check("短值只在词边界替换", engine.maskText("xabcdefghy", shortish).hits === 0);
	check("短值边界外照常替换", engine.maskText("here abcdefgh end", shortish).text === "here {{sec:short}} end");

	const b64v = new vaultMod.Vault();
	b64v.add({ name: "enc", value: "hunter2xyz" });
	const asB64 = Buffer.from("hunter2xyz", "utf8").toString("base64");
	check("编码变体也能回收到 ref", engine.maskText(`blob ${asB64} end`, b64v).text === "blob {{sec:enc}} end");

	const deep = engine.maskDeep(
		[
			{ role: "toolResult", content: [{ type: "text", text: secret }] },
			{ role: "toolResult", content: [{ type: "image", data: secret, mimeType: "image/png" }] },
			{ role: "assistant", content: [{ type: "thinking", thinkingSignature: secret }] },
		],
		ev,
	);
	check("maskDeep 写了正文", deep.value[0].content[0].text === "{{sec:gh}}", JSON.stringify(deep.value[0]));
	check("maskDeep 不动图片数据", deep.value[1].content[0].data === secret);
	check("maskDeep 不动回放签名", deep.value[2].content[0].thinkingSignature === secret);
	// 只统计二进制类整体跳过（会向用户告警“图里看得见的密钥照样发出去”）；
	// 签名回放字段是静默放行，不进计数。
	check("maskDeep 只统计二进制跳过", deep.skipped === 1, String(deep.skipped));

	const exh = engine.expandDeep({ command: "echo {{sec:gh}}", opts: { token: "{{sec:gh}}" } }, (n) => ev.get(n));
	check("expandDeep 换回真值", exh.value.command === `echo ${secret}` && exh.value.opts.token === secret);
	check("expandDeep 记录 used", exh.used.length === 1 && exh.used[0] === "gh", JSON.stringify(exh.used));
	check("expandDeep 未知名字留原样", engine.expandDeep("{{sec:nope}}", () => undefined).value === "{{sec:nope}}");

	const adoptVault = new vaultMod.Vault();
	const n1 = engine.adoptCandidate(adoptVault, { value: secret, label: "GitHub 令牌" });
	const n2 = engine.adoptCandidate(adoptVault, { value: secret, label: "GitHub 令牌" });
	check("自动收录生成 auto 名", n1 === "auto_1", n1);
	check("同值只收录一次", n2 === n1 && adoptVault.size === 1);
	check("出口形态命中用兜底占位（不建档）", engine.maskText(`key=${secret}`, new vaultMod.Vault(), { shapes: true }).text === "key=«已隐藏:GitHub 令牌»");

	// ── fingerprint（长期指纹表） ──────────────────────────────────────────
	console.log("\nfingerprint");
	const fpDir = mkdtempSync(join(tmpdir(), "secret-fp-"));
	try {
		const LONG = "Zq7-tR4mWp2xLb9Ns6Kd";
		const t1 = fp.FingerprintTable.load(fpDir).table;
		check("短值不进长期表（弱口令不留靶子）", t1.remember({ name: "short", value: "abc12345", kind: "secret" }) === false);
		check("长值进表", t1.remember({ name: "db", value: LONG, kind: "secret" }) === true && t1.size === 1);
		check("表文件里没有明文", !readFileSync(join(fpDir, "secret-fingerprints.json"), "utf8").includes(LONG));
		const hit = t1.scan(`DB_PASSWORD=${LONG} end`);
		check("独立片段命中并遮住", hit.hits === 1 && !hit.text.includes(LONG) && hit.text.includes("本会话没有值"), hit.text);
		check("URL 里的口令也命中", t1.scan(`postgres://u:${LONG}@h/db`).hits === 1);
		check("编码变体也命中", t1.scan(`blob ${Buffer.from(LONG, "utf8").toString("base64")} end`).hits === 1);
		check("嵌在更长串里认不出（已知取舍）", t1.scan(`x${LONG}y`).hits === 0);
		check("普通文本不误伤", t1.scan("这是一段普通的中文说明，没有任何口令").hits === 0);
		check("重载后仍在", fp.FingerprintTable.load(fpDir).table.scan(`v ${LONG}`).hits === 1);
		check("forget 后不再命中", t1.forget("db") === true && fp.FingerprintTable.load(fpDir).table.size === 0);
		const t2 = fp.FingerprintTable.load(fpDir).table;
		t2.remember({ name: "x", value: LONG, kind: "secret" });
		unlinkSync(join(fpDir, "secret-fingerprints.key"));
		const lost = fp.FingerprintTable.load(fpDir);
		check("密钥文件丢失时整表重建并告知", lost.table.size === 0 && typeof lost.notice === "string", String(lost.notice));
	} finally {
		rmSync(fpDir, { recursive: true, force: true });
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
