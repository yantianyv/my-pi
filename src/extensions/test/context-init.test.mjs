#!/usr/bin/env node
/**
 * context-init 产物契约回归测试
 *
 * 覆盖 /init 闭环里不依赖模型的两个纯逻辑件：
 * - 场景 A：estimateTokens —— CJK 与 ASCII 的粗估口径、单调性
 * - 场景 B：pruneOldToolResults —— 超预算才剪、从最旧/最廉价（read/grep）开始、
 *   近期消息与 assistant/user 正文不动、write/edit 结果不剪、explore 报告次之、结构不变
 * - 场景 C：checkContextArtifacts / findContextFiles —— L1 与子目录 AGENTS.md 的死指针、索引对应、
 *   frontmatter、空文件、无 skill 时不误报
 * - 场景 D：CONTEXT_OVERFLOW_RE —— 常见超限措辞命中、限流/网络类不误判
 * - 场景 F：ensurePiGitignore —— 首次写入白名单模板、已有文件不动、非 git 仓库不写、根已忽略不写
 *
 * 用法：node src/extensions/test/context-init.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../..");
const BUDGET_BUNDLE = join(TEST_DIR, ".tmp-context-budget.mjs");
const IT_BUNDLE = join(TEST_DIR, ".tmp-context-files.mjs");
const PI_IGNORE_BUNDLE = join(TEST_DIR, ".tmp-pi-ignore.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
		failures++;
	}
};

const tmp = mkdtempSync(join(tmpdir(), "context-init-test-"));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});
	return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

/** 造一个 toolResult 消息 */
const toolResult = (toolName, text) => ({
	role: "toolResult",
	toolCallId: `${toolName}-1`,
	toolName,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: Date.now(),
});

async function main() {
	const budget = await bundle(join(SRC_DIR, "extensions", "shared", "context-budget.ts"), BUDGET_BUNDLE);
	const it = await bundle(join(SRC_DIR, "extensions", "shared", "context-files.ts"), IT_BUNDLE);
	const ignore = await bundle(join(SRC_DIR, "extensions", "shared", "pi-ignore.ts"), PI_IGNORE_BUNDLE);

	// ---- 场景 A：token 粗估 ----
	console.log("场景 A：estimateTokens");
	{
		check("A: 空串为 0", budget.estimateTokens("") === 0);
		const ascii = budget.estimateTokens("a".repeat(350));
		check("A: 350 个 ASCII ≈ 100 token", Math.round(ascii) === 100, String(ascii));
		const cjk = budget.estimateTokens("字".repeat(100));
		check("A: 100 个汉字 ≈ 100 token", Math.round(cjk) === 100, String(cjk));
		check("A: 长文本不低估", budget.estimateTokens("x".repeat(1000)) > budget.estimateTokens("x".repeat(100)));
	}

	// ---- 场景 B：旧工具结果剪枝 ----
	console.log("场景 B：pruneOldToolResults");
	{
		const big = "x".repeat(4_000); // ≈1143 token
		const msgs = [
			{ role: "system", content: "系统提示" },
			{ role: "user", content: "任务" },
			toolResult("read", big),
			{ role: "assistant", content: [{ type: "text", text: "结论一" }] },
			toolResult("explore", big),
			toolResult("write", big),
			...Array.from({ length: 10 }, (_, i) => toolResult("read", `近期${i}`)),
		];
		const under = budget.pruneOldToolResults(msgs, 100_000);
		check("B: 未超预算时原样返回（同引用）", under === msgs);

		const pruned = budget.pruneOldToolResults(msgs, 1_000);
		check("B: 超预算时返回新数组", pruned !== msgs && pruned.length === msgs.length);
		check("B: 最旧的 read 结果被剪", JSON.stringify(pruned[2].content).includes("已省略"));
		check("B: write 结果不剪", !JSON.stringify(pruned[5].content).includes("已省略"));
		check("B: 近期消息不动", pruned.slice(-3).every((m) => !JSON.stringify(m.content).includes("已省略")));
		check("B: assistant 正文不动", pruned[3].content[0].text === "结论一");
		check("B: 系统/用户消息不动", pruned[0].content === "系统提示" && pruned[1].content === "任务");

		// 只够剪一个：应先剪 read（代价 0）而不是 explore（代价 1）
		const oneShot = budget.pruneOldToolResults(msgs, 2_500);
		const readPruned = JSON.stringify(oneShot[2].content).includes("已省略");
		const explorePruned = JSON.stringify(oneShot[4].content).includes("已省略");
		check("B: 按重读代价排序（先 read 后 explore）", readPruned && !explorePruned, `read=${readPruned} explore=${explorePruned}`);
	}

	// ---- 场景 C：产物结构检查 ----
	console.log("场景 C：checkContextArtifacts");
	{
		const clean = join(tmp, "clean");
		mkdirSync(join(clean, ".pi", "skills", "demo-dev", "references"), { recursive: true });
		writeFileSync(
			join(clean, "AGENTS.md"),
			"# AGENTS\n\n细节见 skill `demo-dev` 的 references/core.md。\n",
		);
		writeFileSync(
			join(clean, ".pi", "skills", "demo-dev", "SKILL.md"),
			"---\nname: demo-dev\ndescription: 改 demo 的子系统时读。\n---\n\n| 要动的 | 读 |\n|---|---|\n| 核心 | references/core.md |\n",
		);
		writeFileSync(join(clean, ".pi", "skills", "demo-dev", "references", "core.md"), "# 核心\n".repeat(30));
		check("C: 结构完好时无问题", it.checkContextArtifacts(clean).length === 0, it.checkContextArtifacts(clean).join("；"));

		const noSkillFile = join(tmp, "no-skill-file");
		mkdirSync(join(noSkillFile, ".pi", "skills", "demo-dev"), { recursive: true });
		check("C: 缺 SKILL.md → 报问题", it.checkContextArtifacts(noSkillFile).some((s) => s.includes("缺 SKILL.md")));

		const orphan = join(tmp, "orphan");
		mkdirSync(join(orphan, ".pi", "skills", "demo-dev", "references"), { recursive: true });
		writeFileSync(join(orphan, ".pi", "skills", "demo-dev", "SKILL.md"), "---\nname: a\ndescription: b\n---\n\n无索引\n");
		writeFileSync(join(orphan, ".pi", "skills", "demo-dev", "references", "core.md"), "x".repeat(200));
		check("C: references 未进索引 → 报问题", it.checkContextArtifacts(orphan).some((s) => s.includes("未写进 SKILL.md 索引")));

		const deadRef = join(tmp, "dead-ref");
		mkdirSync(join(deadRef, ".pi", "skills", "demo-dev"), { recursive: true });
		writeFileSync(join(deadRef, ".pi", "skills", "demo-dev", "SKILL.md"), "---\nname: a\ndescription: b\n---\n\n读 references/gone.md\n");
		check("C: SKILL.md 死指针 → 报问题", it.checkContextArtifacts(deadRef).some((s) => s.includes("指向不存在的 references/gone.md")));

		const deadL1 = join(tmp, "dead-l1");
		mkdirSync(join(deadL1, ".pi", "skills", "demo-dev"), { recursive: true });
		writeFileSync(join(deadL1, "AGENTS.md"), "细节见 skill 的 references/missing.md\n");
		writeFileSync(join(deadL1, ".pi", "skills", "demo-dev", "SKILL.md"), "---\nname: a\ndescription: b\n---\n");
		const l1Issues = it.checkContextArtifacts(deadL1);
		check("C: L1 死指针 → 报问题", l1Issues.some((s) => s.includes("AGENTS.md 指向不存在的 references/missing.md")), l1Issues.join("；"));

		const noSkill = join(tmp, "no-skill");
		mkdirSync(noSkill, { recursive: true });
		writeFileSync(join(noSkill, "AGENTS.md"), "# AGENTS\n");
		check("C: 没有 L2 skill 时只要 L1 无指针就通过", it.checkContextArtifacts(noSkill).length === 0);

		// 子目录上下文文件也在检查范围内（分层靠子文件的项目同样受保护）
		const nested = join(tmp, "nested");
		mkdirSync(join(nested, "tools", "dingtalk"), { recursive: true });
		writeFileSync(join(nested, "AGENTS.md"), "# 根\n");
		writeFileSync(join(nested, "tools", "AGENTS.md"), "细节见 references/tools.md\n");
		writeFileSync(join(nested, "tools", "dingtalk", "AGENTS.md"), "参考 skill 的 references/dw.md\n");
		const nestedIssues = it.checkContextArtifacts(nested);
		check(
			"C: 子目录 AGENTS.md 的死指针会被发现",
			nestedIssues.some((s) => s.includes("tools.md")) && nestedIssues.some((s) => s.includes("dw.md")),
			nestedIssues.join("；"),
		);
		check("C: findContextFiles 能列出根与子目录文件", it.findContextFiles(nested).length === 3, String(it.findContextFiles(nested).length));
		check(
			"C: findContextFiles 跳过 node_modules",
			(() => {
				mkdirSync(join(nested, "node_modules", "x"), { recursive: true });
				writeFileSync(join(nested, "node_modules", "x", "AGENTS.md"), "# 依赖里的\n");
				return it.findContextFiles(nested).length === 3;
			})(),
		);

		const noFrontmatter = join(tmp, "no-fm");
		mkdirSync(join(noFrontmatter, ".pi", "skills", "demo-dev"), { recursive: true });
		writeFileSync(join(noFrontmatter, ".pi", "skills", "demo-dev", "SKILL.md"), "# 没有 frontmatter\n");
		check("C: frontmatter 缺 name/description → 报问题", it.checkContextArtifacts(noFrontmatter).some((s) => s.includes("frontmatter")));
		check("C: 未创建 references 目录不报问题", !it.checkContextArtifacts(noFrontmatter).some((s) => s.includes("近乎空文件")));
		check("C: 不存在的目录不崩", it.checkContextArtifacts(join(tmp, "nope")).length === 0);
	}

	// ---- 场景 D：超限措辞识别 ----
	console.log("场景 D：CONTEXT_OVERFLOW_RE");
	{
		const hit = [
			"This model's maximum context length is 128000 tokens",
			"Error 413: request entity too large",
			"prompt is too long: 210000 tokens > 200000 maximum",
			"context window exceeded",
			"too many tokens",
			"输入超过长度上限",
		];
		const miss = ["fetch failed", "rate limit exceeded", "429 too many requests", "工具执行失败", "子代理超时", "ECONNRESET"];
		check("D: 超限措辞全部命中", hit.every((h) => budget.CONTEXT_OVERFLOW_RE.test(h)), hit.filter((h) => !budget.CONTEXT_OVERFLOW_RE.test(h)).join(" | "));
		check("D: 限流/网络类不误判", miss.every((m) => !budget.CONTEXT_OVERFLOW_RE.test(m)), miss.filter((m) => budget.CONTEXT_OVERFLOW_RE.test(m)).join(" | "));
	}

	// ---- 场景 F：.pi/.gitignore 自动补（白名单模板，幂等） ----
	console.log("场景 F：ensurePiGitignore");
	{
		const mkRepo = (name) => {
			const d = join(tmp, name);
			mkdirSync(join(d, ".git"), { recursive: true });
			return d;
		};
		const a = mkRepo("repo-a");
		ignore.ensurePiGitignore(a);
		const written = readFileSync(join(a, ".pi", ".gitignore"), "utf8");
		check("F: 首次调用写入白名单模板", written.includes("*") && written.includes("!.gitignore") && written.includes("!skills/**"));
		check("F: 模板不含黑名单式的运行时目录逐条", !written.includes("explore/") && !written.includes("questionnaires/"));

		writeFileSync(join(a, ".pi", ".gitignore"), "项目自定义\n");
		ignore.ensurePiGitignore(a);
		check("F: 已有文件不动（保留项目自定义）", readFileSync(join(a, ".pi", ".gitignore"), "utf8") === "项目自定义\n");

		const b = join(tmp, "no-git");
		mkdirSync(b, { recursive: true });
		ignore.ensurePiGitignore(b);
		check("F: 非 git 仓库不写", !existsSync(join(b, ".pi", ".gitignore")));

		const c = mkRepo("repo-c");
		writeFileSync(join(c, ".gitignore"), "node_modules/\n.pi/\n");
		ignore.ensurePiGitignore(c);
		check("F: 根 .gitignore 已整体忽略 .pi/ 时不写", !existsSync(join(c, ".pi", ".gitignore")));

		const d = mkRepo("repo-d");
		writeFileSync(join(d, ".gitignore"), "node_modules/\n*.log\n");
		ignore.ensurePiGitignore(d);
		check("F: 根规则与 .pi/ 无关时照常写", existsSync(join(d, ".pi", ".gitignore")));
	}

	check("E: 临时产物已清理（构建产物落 test/ 下）", existsSync(BUDGET_BUNDLE) && existsSync(IT_BUNDLE));
}

try {
	await main();
} finally {
	rmSync(tmp, { recursive: true, force: true });
	rmSync(BUDGET_BUNDLE, { force: true });
	rmSync(IT_BUNDLE, { force: true });
	rmSync(PI_IGNORE_BUNDLE, { force: true });
}
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
