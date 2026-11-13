#!/usr/bin/env node
/**
 * skill-hub 回归测试（纯逻辑，离线；网络层用桩）
 *
 * 原理：esbuild 把各纯逻辑模块 bundle 成单文件 ESM 再 import（外部只留 @earendil-works/*）。
 * 覆盖不依赖网络的判定与写盘行为，网络部分（skills.sh / jsDelivr）由 -live 脚本单独联调。
 *
 * 覆盖：
 * - A frontmatter：单行/引号/缺字段/无头部的解析，规范校验的各类问题
 * - B trust：精选名单、三审计全 Pass、带脚本强制人工、非文档文件、体积统计
 * - C install：项目内私有目录解析、账本读写、写盘原子性（失败不留半套）、路径穿越拦截
 * - D 卸载：只认账本记录的技能，越界路径拒绝
 * - E registry：来源字符串解析（各种链接形态）
 *
 * 用法：node src/extensions/skill-hub/test/skill-hub.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// 测试隔离：账本与全局技能目录都指向临时目录
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hub-test-"));

const bundlePath = join(here, ".tmp-skill-hub-bundle.mjs");
await build({
	entryPoints: [join(here, "..", "frontmatter.ts"), join(here, "..", "trust.ts"), join(here, "..", "install.ts"), join(here, "..", "registry.ts"), join(here, "..", "fetch.ts")],
	outdir: here,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*"],
	target: "es2022",
	logLevel: "silent",
	entryNames: ".tmp-skill-hub-[name]",
});
const fm = await import(pathToFileURL(join(here, ".tmp-skill-hub-frontmatter.mjs")).href);
const trust = await import(pathToFileURL(join(here, ".tmp-skill-hub-trust.mjs")).href);
const inst = await import(pathToFileURL(join(here, ".tmp-skill-hub-install.mjs")).href);
const reg = await import(pathToFileURL(join(here, ".tmp-skill-hub-registry.mjs")).href);
const fet = await import(pathToFileURL(join(here, ".tmp-skill-hub-fetch.mjs")).href);

let failures = 0;
const check = (name, cond, extra) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra === undefined ? "" : ` :: ${extra}`}`);
		failures++;
	}
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
section("A frontmatter 解析与规范校验");
// ---------------------------------------------------------------------------

const plain = fm.parseSkillMeta(`---\nname: pdf\ndescription: Handle PDF files\n---\n\n# Body\n`);
check("A1 基本头部解析", plain.name === "pdf" && plain.description === "Handle PDF files");

const quoted = fm.parseSkillMeta(`---\nname: code-review\ndescription: "Review code: diff, tests, risks"\ndisable-model-invocation: true\n---\nbody`);
check("A2 引号包裹与布尔字段", quoted.description === "Review code: diff, tests, risks" && quoted.disableModelInvocation === true);

const multiline = fm.parseSkillMeta(`---\r\nname: x\r\ndescription: line one\r\n---\r\nbody`);
check("A3 CRLF 换行也能解析", multiline.name === "x" && multiline.description === "line one");

check("A4 无头部返回空对象", Object.keys(fm.parseSkillMeta("# just markdown")).length === 0);
check("A5 未闭合头部返回空对象", Object.keys(fm.parseSkillMeta("---\nname: x\nno end")).length === 0);

check(
	"A6 合规名 + 有描述无阻塞也无提示",
	(() => {
		const c = fm.checkSkill("pdf-tools", { name: "pdf-tools", description: "d" });
		return c.blockers.length === 0 && c.warnings.length === 0;
	})(),
);
check("A7 大写名只是提示（pi 照常加载）", (() => {
	const c = fm.checkSkill("PDF", { description: "d" });
	return c.blockers.length === 0 && c.warnings.some((p) => p.includes("不完全合规"));
})());
check("A8 连续连字符只是提示", (() => {
	const c = fm.checkSkill("a--b", { description: "d" });
	return c.blockers.length === 0 && c.warnings.some((p) => p.includes("不完全合规"));
})());
check("A9 缺描述是阻塞项", fm.checkSkill("ok", {}).blockers.some((p) => p.includes("缺少 description")));
check("A10 描述超长只是提示（pi 照常加载）", (() => {
	const c = fm.checkSkill("ok", { description: "x".repeat(1025) });
	return c.blockers.length === 0 && c.warnings.some((p) => p.includes("1024"));
})());
check("A11 声明名与目录名不一致提示", (() => {
	const c = fm.checkSkill("a", { name: "b", description: "d" });
	return c.blockers.length === 0 && c.warnings.some((p) => p.includes("不一致"));
})());

// ---------------------------------------------------------------------------
section("B 信任判定");
// ---------------------------------------------------------------------------

const auditsAllPass = [
	{ name: "Gen Agent Trust Hub", verdict: "Pass", slug: "agent-trust-hub" },
	{ name: "Socket", verdict: "Pass", slug: "socket" },
	{ name: "Snyk", verdict: "Pass", slug: "snyk" },
];
const auditsOneWarn = auditsAllPass.map((a) => (a.name === "Snyk" ? { ...a, verdict: "Warn" } : a));
const docFiles = [
	{ path: "SKILL.md", size: 1000 },
	{ path: "references/guide.md", size: 2000 },
];

check("B1 精选名单识别（大小写不敏感）", trust.isTrustedRepo("Anthropics/Skills") && !trust.isTrustedRepo("someone/other"));
check("B2 三审计全 Pass 才算通过", trust.auditsPass(auditsAllPass) && !trust.auditsPass(auditsOneWarn));
check("B3 返回几家就判几家（端点可能多于三家）", trust.auditsPass(auditsAllPass.slice(0, 2)));
check("B3b 无审计记录不算通过", !trust.auditsPass([]));

const vTrustedRepo = trust.judgeTrust("anthropics/skills", docFiles, []);
check("B4 精选名单免确认", vTrustedRepo.trusted && vTrustedRepo.byRepo && !vTrustedRepo.byAudit);
const vUntrusted = trust.judgeTrust("someone/unknown", docFiles, auditsOneWarn);
check("B5 名单外且审计未全过 → 需确认", !vUntrusted.trusted);
const vAuditOnly = trust.judgeTrust("someone/unknown", docFiles, auditsAllPass);
check("B6 审计全过即可免确认", vAuditOnly.trusted && vAuditOnly.byAudit && !vAuditOnly.byRepo);
const vScripts = trust.judgeTrust("anthropics/skills", [...docFiles, { path: "scripts/run.py", size: 500 }], auditsAllPass);
check("B7 带脚本即使可信也强制人工", !vScripts.trusted && vScripts.hasScripts);
const vOdd = trust.judgeTrust("anthropics/skills", [...docFiles, { path: "assets/blob.dat", size: 500 }], auditsAllPass);
check("B8 非文档文件强制人工", !vOdd.trusted && vOdd.oddFiles.length === 1);
check("B9 体积统计含全部文件", vOdd.bytes === 1000 + 2000 + 500);
check("B10 技能名规范校验函数", trust.isValidSkillName("pdf") && !trust.isValidSkillName("-pdf") && !trust.isValidSkillName("Pdf"));

// 门槛定为三家全 Pass（用户拍板）：任一家 Warn 即不算通过，fail 也一样
check("B11 Warn 不算通过", !trust.auditsPass(auditsOneWarn));
check("B12 Fail 不算通过", !trust.auditsPass(auditsAllPass.map((a) => (a.name === "Socket" ? { ...a, verdict: "Fail" } : a))));
const vWarnOnly = trust.judgeTrust("someone/unknown", docFiles, auditsOneWarn);
check("B13 名单外 + 一家 Warn → 强制人工确认", !vWarnOnly.trusted && !vWarnOnly.byAudit);

// ---------------------------------------------------------------------------
section("C 安装路径、账本与写盘");
// ---------------------------------------------------------------------------

const cwd = join(TMP_ROOT, "project");
fs.mkdirSync(cwd, { recursive: true });
check("C1 存储根在项目 .pi/skill-hub", inst.storeDir(cwd) === join(cwd, ".pi", "skill-hub"));
check("C2 技能根在存储内的 skills 子目录", inst.skillsRoot(cwd) === join(cwd, ".pi", "skill-hub", "skills"));
check("C3 目标路径按技能名拼接", inst.skillTarget(cwd, "demo") === join(cwd, ".pi", "skill-hub", "skills", "demo"));

const targetDir = inst.skillTarget(cwd, "demo");
const files = new Map([
	["SKILL.md", "---\nname: demo\ndescription: d\n---\nbody"],
	["references/a.md", "ref"],
]);
inst.writeSkillTree(targetDir, files);
check("C4 写盘后 SKILL.md 存在", fs.existsSync(join(targetDir, "SKILL.md")));
check("C5 子目录一并创建", fs.existsSync(join(targetDir, "references", "a.md")));
check("C6 不残留临时目录", !fs.readdirSync(inst.skillsRoot(cwd)).some((n) => n.startsWith(".tmp-")));

let traversalBlocked = false;
try {
	inst.writeSkillTree(inst.skillTarget(cwd, "escape"), new Map([["../evil.md", "x"]]));
} catch {
	traversalBlocked = true;
}
check("C7 路径穿越被拦截", traversalBlocked);
check("C8 拦截后不留半套目录", !fs.existsSync(inst.skillTarget(cwd, "escape")));

const fetched = { source: "anthropics/skills", ref: "main", dir: "skills/demo", files, entries: [...files.keys()].map((p) => ({ path: p, size: 1 })), skipped: new Map() };
inst.recordInstall(cwd, fetched, "demo", targetDir);
const ledger = inst.loadLedger(cwd);
check("C9 账本记录来源与版本", ledger.skills.length === 1 && ledger.skills[0].source === "anthropics/skills" && ledger.skills[0].ref === "main");
check("C10 账本记录文件清单", ledger.skills[0].files.includes("SKILL.md"));

inst.recordInstall(cwd, fetched, "demo", targetDir);
check("C11 重复记账不产生重复条目", inst.loadLedger(cwd).skills.length === 1);

const listed = inst.listInstalled(cwd);
check("C12 已装清单能扫到技能", listed.some((i) => i.name === "demo"));
check("C13 已装清单带账本记录", listed.find((i) => i.name === "demo")?.entry?.source === "anthropics/skills");

// 账本里存的是反斜杠写法的路径时，仍要认得出是同一个目录（Windows 上混用分隔符是常态）
const mixedTarget = inst.skillTarget(cwd, "mixed");
inst.writeSkillTree(mixedTarget, new Map([["SKILL.md", "---\nname: mixed\ndescription: d\n---\n"]]));
const ledgerNow = inst.loadLedger(cwd);
ledgerNow.skills.push({
	name: "mixed",
	source: "anthropics/skills",
	ref: "main",
	dir: "skills/mixed",
	path: mixedTarget.replace(/\\/g, "/"),
	installedAt: new Date().toISOString(),
	files: ["SKILL.md"],
});
inst.saveLedger(cwd, ledgerNow);
check("C13b 路径写法不同仍匹配到账本记录", inst.listInstalled(cwd).find((i) => i.name === "mixed")?.entry?.source === "anthropics/skills");

// 手动放进 .pi/skills/ 的技能不在账本里 → 不会出现在可卸载清单中
fs.mkdirSync(join(cwd, ".pi", "skills", "manual"), { recursive: true });
fs.writeFileSync(join(cwd, ".pi", "skills", "manual", "SKILL.md"), "---\nname: manual\ndescription: d\n---\n");
check("C14 手动技能不进可卸载清单", !inst.listInstalled(cwd).some((i) => i.name === "manual"));

check("C15 账本文件落在存储根", fs.existsSync(join(inst.storeDir(cwd), "installed.json")));

check("C16 撤销记录返回 true 且不再列出", inst.forgetInstall(cwd, targetDir) && !inst.loadLedger(cwd).skills.some((e) => e.name === "demo"));
check("C17 撤销不存在的记录返回 false", inst.forgetInstall(cwd, inst.skillTarget(cwd, "nope")) === false);

// ---------------------------------------------------------------------------
section("D 卸载的边界（只认插件自己那份）");
// ---------------------------------------------------------------------------

check("D1 插件存储内的路径被认作可管", inst.isManagedPath(cwd, inst.skillTarget(cwd, "demo")));
check("D2 手动 skills 目录不在插件存储内", !inst.isManagedPath(cwd, join(cwd, ".pi", "skills", "manual")));
check("D3 存储根自身不算技能路径", !inst.isManagedPath(cwd, inst.skillsRoot(cwd)));
check("D4 前缀相近的兄弟目录不误判", !inst.isManagedPath(cwd, join(cwd, ".pi", "skill-hub-other", "skills", "demo")));
check("D5 项目外的绝对路径被拒", !inst.isManagedPath(cwd, join(TMP_ROOT, "elsewhere", "demo")));

// ---------------------------------------------------------------------------
section("E 来源字符串解析");
// ---------------------------------------------------------------------------

const cases = [
	["anthropics/skills", "anthropics/skills", undefined],
	["anthropics/skills/pdf", "anthropics/skills", "pdf"],
	["https://github.com/vercel-labs/agent-skills", "vercel-labs/agent-skills", undefined],
	["https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines", "vercel-labs/agent-skills", "web-design-guidelines"],
	["git:github.com/badlogic/pi-skills", "badlogic/pi-skills", undefined],
	["https://skills.sh/obra/superpowers/brainstorming", "obra/superpowers", "brainstorming"],
	["https://github.com/foo/bar.git", "foo/bar", undefined],
];
for (const [input, source, skillId] of cases) {
	const got = reg.parseSource(input);
	check(`E ${input}`, got !== null && got.source === source && got.skillId === skillId, JSON.stringify(got));
}
check("E 非来源字符串返回 null", reg.parseSource("pdf") === null && reg.parseSource("") === null);

// ---------------------------------------------------------------------------
section("F 取回容错（文件清单与 CDN 不同步时的行为）");
// ---------------------------------------------------------------------------

// fetchSkillFiles 依赖网络层，取文件的成功/失败由 live 脚本覆盖；这里只验证不联网的体积规划：
// 超限文件跳过（不拒装整包），SKILL.md 永不被淘汰。
const tooMany = Array.from({ length: fet.MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.md`, size: 1 }));
let limited = false;
try {
	await fet.fetchSkillFiles("x/y", "main", "", tooMany);
} catch (e) {
	limited = /超过上限/.test(e.message);
}
check("F1 文件数超限被拦截", limited);

const tooHeavy = [
	{ path: "demo/SKILL.md", size: 2000 },
	{ path: "demo/examples/big.gif", size: fet.MAX_FILE_BYTES + 1 },
];
const plannedHeavy = fet.pickWithinLimits("demo", tooHeavy);
check("F2 超大单文件被跳过而非拒装", plannedHeavy.entries.length === 1 && plannedHeavy.skipped.has("examples/big.gif"));

const overTotal = [
	{ path: "demo/SKILL.md", size: 2000 },
	{ path: "demo/a.bin", size: fet.MAX_FILE_BYTES },
	{ path: "demo/b.bin", size: fet.MAX_FILE_BYTES },
	{ path: "demo/c.bin", size: fet.MAX_FILE_BYTES },
	{ path: "demo/d.bin", size: fet.MAX_FILE_BYTES },
];
const plannedTotal = fet.pickWithinLimits("demo", overTotal);
const keptBytes = plannedTotal.entries.reduce((n, f) => n + f.size, 0);
check("F3 超总量时从大到小跳过", keptBytes <= fet.MAX_TOTAL_BYTES && plannedTotal.skipped.size > 0, `${keptBytes}/${fet.MAX_TOTAL_BYTES}`);
check("F4 SKILL.md 不被淘汰", plannedTotal.entries.some((f) => f.path === "demo/SKILL.md"));

let noSkillMd = false;
try {
	fet.pickWithinLimits("demo", [{ path: "demo/SKILL.md", size: fet.MAX_FILE_BYTES + 1 }]);
} catch (e) {
	noSkillMd = /SKILL\.md/.test(e.message);
}
check("F5 SKILL.md 本身超限才算失败", noSkillMd);

check("F6 上限常量已导出", fet.MAX_FILES > 0 && fet.MAX_TOTAL_BYTES > 0);

// ---------------------------------------------------------------------------
section("G 技能目录定位（纯函数）");
// ---------------------------------------------------------------------------

// 技能放在仓库根时没有目录名可比：pi 以 SKILL.md 父目录名兜底，这里同样用仓库名
const rootOnly = [{ path: "SKILL.md" }, { path: "references/a.md" }];
check("G1 仓库根技能定位到空目录", reg.pickSkillDir(rootOnly, "owner/repo", "repo") === "");
check("G2 仓库根技能按仓库名匹配 skillId", reg.pickSkillDir(rootOnly, "repo", "repo") === "");
check("G3 仓库根技能的 name 取仓库名", reg.skillNameOf("owner/repo", "") === "repo");
check("G4 子目录技能的 name 取目录名", reg.skillNameOf("owner/repo", "skill/kit") === "kit");

const nested = [{ path: "SKILL.md" }, { path: "skills/pdf/SKILL.md" }, { path: "skills/docx/SKILL.md" }];
check("G5 精确匹配优先于层级最短", reg.pickSkillDir(nested, "docx", "repo") === "skills/docx");
check("G6 单个技能时不再挑", reg.pickSkillDir([{ path: "a/b/SKILL.md" }], "whatever", "repo") === "a/b");
check("G7 无 SKILL.md 返回 undefined", reg.pickSkillDir([{ path: "README.md" }], "x", "repo") === undefined);

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败`}`);

// 清理临时目录与 bundle 产物
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
for (const f of fs.readdirSync(here)) {
	if (f.startsWith(".tmp-skill-hub-")) fs.unlinkSync(join(here, f));
}
process.exit(failures === 0 ? 0 : 1);
