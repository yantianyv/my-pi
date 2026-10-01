#!/usr/bin/env node
/**
 * explore-agent 成果落盘/断点续跑回归测试
 *
 * 只测模块导出的落盘原语与报告渲染（不触发子代理模型调用）：
 * - 场景 A：任务哈希稳定（同任务文本同 key，空白差异归一化）
 * - 场景 B：渐进式落盘——半成品（正文 + 检索轨迹）可读回，作为续跑起点
 * - 场景 C：缓存复用——完整成果优先于半成品；stripTitle 去掉独立阅读用的一级标题
 * - 场景 D：报告渲染——进行中/复用/中断/失败四种状态都能看出状态与已确认正文
 * - 场景 E：上下文超限识别——常见措辞命中、无关错误不误判
 *
 * 用法：node src/extensions/test/explore.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../..");
const BUNDLE = join(TEST_DIR, ".tmp-explore-bundle.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
		failures++;
	}
};

const tmp = mkdtempSync(join(tmpdir(), "explore-test-"));

async function main() {
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "explore-agent.ts")],
		outfile: BUNDLE,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});
	const m = await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}`);

	// ---- 场景 A：任务哈希稳定 ----
	console.log("场景 A：任务哈希");
	{
		const a1 = m.artifactsFor(tmp, "查清 HUD 渲染链路");
		const a2 = m.artifactsFor(tmp, "  查清   HUD 渲染链路  ");
		const a3 = m.artifactsFor(tmp, "查清 perm-gate 判定链路");
		check("A: 同一任务文本 → 同一 key（空白归一）", a1.key === a2.key);
		check("A: 不同任务文本 → 不同 key", a1.key !== a3.key);
		check("A: key 落在 .pi/explore/tasks/ 下", a1.finalPath.includes(join(".pi", "explore", "tasks")));
	}

	// ---- 场景 B：渐进式落盘与续跑起点 ----
	console.log("场景 B：半成品即成果");
	{
		const a = m.artifactsFor(tmp, "任务 B");
		check("B: 初次无半成品", m.readPartialNotes(a) === null);
		m.writeAtomic(a.partialPath, m.renderPartial("任务 B", ["已确认：src/a.ts:10 定义 X"], ["read src/a.ts:1-40", "grep X"]));
		const notes = m.readPartialNotes(a);
		check("B: 半成品可读回（含正文）", !!notes && notes.includes("src/a.ts:10"));
		check("B: 半成品含检索轨迹（被 kill 也留证据）", !!notes && notes.includes("read src/a.ts:1-40"));
		check("B: 无正文时也保留轨迹占位", m.renderPartial("t", [], ["grep y"]).includes("仅有检索轨迹"));
	}

	// ---- 场景 C：缓存复用优先级 ----
	console.log("场景 C：复用与标题");
	{
		const a = m.artifactsFor(tmp, "任务 C");
		m.writeAtomic(a.partialPath, m.renderPartial("任务 C", ["半成品"], []));
		check("C: 只有半成品时不算已完成", m.readCachedFinal(a) === null);
		m.writeAtomic(a.finalPath, `# 任务 C\n\n最终报告正文`);
		const cached = m.readCachedFinal(a);
		check("C: 完整成果可复用", !!cached && cached.includes("最终报告正文"));
		check("C: stripTitle 去掉独立标题", m.stripTitle(cached, "任务 C") === "最终报告正文");
		check("C: 标题不匹配时原样保留", m.stripTitle("# 别的标题\n正文", "任务 C").includes("别的标题"));
	}

	// ---- 场景 D：报告渲染 ----
	console.log("场景 D：报告渲染");
	{
		const text = m.renderReport("run-x", "deepseek/x", [
			{ task: "进行中的任务", key: "k1", status: "running", content: "已确认：A 依赖 B", tools: 7, cached: false },
			{ task: "复用的任务", key: "k2", status: "cached", content: "上次结论", tools: 0, cached: true },
			{ task: "中断的任务", key: "k3", status: "interrupted", content: "中断前的发现", tools: 3, cached: false },
			{ task: "失败的任务", key: "k4", status: "failed", content: "", tools: 1, cached: false, error: "上下文超限" },
		]);
		check("D: 标题含 run 与模型", text.includes("run-x") && text.includes("deepseek/x"));
		check("D: 进行中显示工具调用数", text.includes("进行中（7 次工具调用）"));
		check("D: 进行中也能看到已确认正文（渐进式）", text.includes("已确认：A 依赖 B"));
		check("D: 复用状态可见", text.includes("复用上次成果") && text.includes("上次结论"));
		check("D: 中断状态提示可续跑", text.includes("中断") && text.includes("可续跑"));
		check("D: 失败带错误原因", text.includes("上下文超限"));
		check("D: 每个任务都有独立小节", text.includes("## 任务 1：") && text.includes("## 任务 4："));
	}

	// ---- 场景 E：上下文超限识别 ----
	console.log("场景 E：超限识别");
	{
		const hit = [
			"This model's maximum context length is 128000 tokens",
			"Error 413: request entity too large",
			"prompt is too long: 210000 tokens > 200000 maximum",
			"context window exceeded",
			"too many tokens",
		];
		const miss = ["fetch failed", "rate limit exceeded", "429 too many requests", "工具执行失败", "子代理超时"];
		check("E: 常见超限措辞全部命中", hit.every((h) => m.CONTEXT_OVERFLOW_RE.test(h)), hit.filter((h) => !m.CONTEXT_OVERFLOW_RE.test(h)).join(" | "));
		check("E: 网络/限流/超时类不误判为超限", miss.every((x) => !m.CONTEXT_OVERFLOW_RE.test(x)), miss.filter((x) => m.CONTEXT_OVERFLOW_RE.test(x)).join(" | "));
	}

	check("F: 落盘目录已建立（写盘副作用）", existsSync(join(tmp, ".pi", "explore", "tasks")));
}

try {
	await main();
} finally {
	rmSync(tmp, { recursive: true, force: true });
	rmSync(BUNDLE, { force: true });
}
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
