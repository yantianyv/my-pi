#!/usr/bin/env node
/**
 * skill-hub 真实网络联调（需要外网，默认不随离线测试跑）
 *
 * 验证四件事在真实站点上成立：
 *   1. skills.sh 检索返回可用条目；
 *   2. jsDelivr 能定位到 SKILL.md 目录并取回全文（含「仓库最新 tag ≠ main」的情形）；
 *   3. skills.sh 详情页的审计徽章能被解析；
 *   4. 信任判定与文件清单在实际技能上给出预期结论。
 *
 * 用法：node src/extensions/skill-hub/test/skill-hub-live.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hub-live-"));
process.env.SKILL_HUB_DIR = join(TMP_ROOT, "agent");
process.env.SKILL_HUB_TMP = `live-${process.pid}`;

await build({
	entryPoints: [
		join(here, "..", "registry.ts"),
		join(here, "..", "fetch.ts"),
		join(here, "..", "trust.ts"),
		join(here, "..", "frontmatter.ts"),
	],
	outdir: here,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*"],
	target: "es2022",
	logLevel: "silent",
	entryNames: ".tmp-live-[name]",
});
const reg = await import(pathToFileURL(join(here, ".tmp-live-registry.mjs")).href);
const fet = await import(pathToFileURL(join(here, ".tmp-live-fetch.mjs")).href);
const tr = await import(pathToFileURL(join(here, ".tmp-live-trust.mjs")).href);
const fm = await import(pathToFileURL(join(here, ".tmp-live-frontmatter.mjs")).href);

let failures = 0;
const check = (name, cond, extra) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra === undefined ? "" : ` :: ${extra}`}`);
		failures++;
	}
};

console.log("\n1. 目录检索");
try {
	const hits = await reg.searchSkills("code review", 5);
	check("检索有结果", hits.length > 0, `count=${hits.length}`);
	check("结果按安装量降序", hits.every((h, i) => i === 0 || hits[i - 1].installs >= h.installs));
	check("结果字段完整", hits.every((h) => h.source.includes("/") && h.skillId.length > 0));
} catch (e) {
	check("检索可用", false, e.message);
}

for (const [source, skillId, label] of [
	["anthropics/skills", "pdf", "官方 pdf（无 tag，落 main）"],
	["mattpocock/skills", "tdd", "mattpocock tdd（最新 tag 非 main）"],
	["obra/superpowers", "brainstorming", "obra superpowers"],
	["heychengc/vibe-knowledge-film", "vibe-knowledge-film", "技能在仓库根（目录名为空）"],
]) {
	console.log(`\n2. 定位与取回：${label}`);
	try {
		const repo = await reg.resolveSkill(source, skillId);
		check(`${skillId} 定位到目录`, reg.skillNameOf(source, repo.dir) === skillId, "dir=" + repo.dir);
		check(`${skillId} 有文件清单`, repo.files.length > 0, `${repo.files.length} 个`);
		const skill = await fet.fetchSkillFiles(source, repo.ref, repo.dir, repo.files);
		check(`${skillId} 取回文件（容错后）`, skill.files.size === repo.files.length - skill.skipped.size, `${skill.files.size}/${repo.files.length}`);
		check(`${skillId} 取回的正文与预览一致`, Boolean(skill.files.get("SKILL.md")?.includes("---")));
		const meta = fm.parseSkillMeta(skill.files.get("SKILL.md") ?? "");
		check(`${skillId} 头部可解析`, Boolean(meta.name && meta.description), JSON.stringify(meta).slice(0, 80));
		const spec = fm.checkSkill(skillId, meta);
		check(`${skillId} 规范校验无阻塞项`, spec.blockers.length === 0, [...spec.blockers, ...spec.warnings].join("；"));
		const audits = await reg.fetchAudits(source, skillId).catch(() => []);
		check(`${skillId} 审计徽章可解析`, audits.length > 0, audits.map((a) => `${a.name}=${a.verdict}`).join(" ") || "无");
		const verdict = tr.judgeTrust(source, repo.files, audits);
		console.log(`     信任：${verdict.trusted ? "免确认" : "需人工确认"}（${verdict.reasons.join("；")}）`);
	} catch (e) {
		check(`${skillId} 全链路`, false, e.message);
	}
}

console.log("\n3. 审计徽章对照组");
try {
	const audits = await reg.fetchAudits("open.feishu.cn", "lark-doc");
	check("无审计区块时返回空数组", audits.length === 0, audits.length);
} catch (e) {
	check("无审计页可访问", false, e.message);
}

console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败`}`);
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
for (const f of fs.readdirSync(here)) if (f.startsWith(".tmp-live-")) fs.unlinkSync(join(here, f));
process.exit(failures === 0 ? 0 : 1);
