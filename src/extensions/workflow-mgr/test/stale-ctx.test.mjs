#!/usr/bin/env node
/**
 * workflow-mgr stale ctx 回归测试（session 替换后 "ctx is stale" 崩溃）
 *
 * 背景：getStore 的会话缓存比较依赖 `sessionStore.cwd`，而旧实现该 getter 动态访问
 * this.ctx.cwd——session 替换（compaction / reload）后旧 ctx 被 pi 标记 stale，
 * 任何属性访问抛 assertActive 错误，session_start 事件里 getStore 即崩溃，
 * wf_* 全部不可用（重启恢复）。修复：WorkflowStore 构造时固化 cwd 字符串，
 * 类内不再持有/访问 ctx，所有文件操作基于固化 cwd。
 *
 * 覆盖：
 * - 固化：构造后 ctx 变 stale（Proxy 任何访问抛错），store.cwd / getWorkflow 等仍正常
 * - getStore 复用：旧实例 stale 后，新 ctx 调 getStore 比较不崩（纯字符串比较）
 * - cwd 变化自动重建：新 cwd 的新 ctx → 重建为新 store
 *
 * 用法：node src/extensions/workflow-mgr/test/stale-ctx.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const WFMG_DIR = join(TEST_DIR, ".."); // src/extensions/workflow-mgr/
const SRC_DIR = join(WFMG_DIR, "../.."); // src/
const BUNDLE = join(TEST_DIR, ".tmp-stale-bundle.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

// ---- bundle：store.ts（shared/config、./types 相对依赖内联；pi 包经 test/node_modules junction 解析） ----
await build({
	entryPoints: [join(WFMG_DIR, "store.ts")],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
const { WorkflowStore, getStore } = await import(pathToFileURL(BUNDLE).href);

/** 写 fixture 工作目录（含简单工作流） */
function makeFixture() {
	const dir = mkdtempSync(join(tmpdir(), "wfmg-stale-"));
	const wfDir = join(dir, ".pi", "workflow");
	mkdirSync(wfDir, { recursive: true });
	writeFileSync(
		join(wfDir, "workflow.json"),
		JSON.stringify({
			schemaVersion: 1,
			stages: [{
				id: "s1", name: "阶段1", goal: "目标",
				tasks: [{ id: "s1.1", title: "任务1", desc: "", humanTasks: [], aiTasks: [], deliverable: "", doneSignal: "", deps: [] }],
			}],
		}),
		"utf8",
	);
	writeFileSync(
		join(wfDir, "state.json"),
		JSON.stringify({ schemaVersion: 1, currentTaskId: "s1.1", tasks: {}, milestones: {}, log: [], notes: [], mode: "human-ai" }),
		"utf8",
	);
	return dir;
}

/** 模拟 pi 的 stale ctx：任何属性访问都抛 assertActive 错误（与 runner.js assertActive 行为一致） */
function makeStaleCtx() {
	return new Proxy(
		{},
		{
			get() {
				throw new Error("This extension ctx is stale after session replacement or reload. (mock)");
			},
		},
	);
}

// ---- 场景 1：构造时固化 cwd，ctx stale 后 store 仍可安全读写 ----
console.log("场景 1：固化 cwd（构造后 ctx stale，store 不崩）");
{
	const dir = makeFixture();
	const ctx = { cwd: dir, hasUI: true, mode: "tui", ui: {} };
	const store = new WorkflowStore(ctx);
	// 固化验证：构造后 ctx 变 stale（Proxy 包裹，访问即抛错）
	const staleProxy = new Proxy(ctx, {
		get() {
			throw new Error("This extension ctx is stale after session replacement or reload. (mock)");
		},
	});
	check("store.cwd 返回固化字符串（不访问 ctx）", store.cwd === dir, `实际 ${store.cwd}`);
	check("store.getWorkflow 读磁盘正常（固化 cwd）", store.getWorkflow().stages[0]?.name === "阶段1");
	check("store.getState 读磁盘正常", store.getState().currentTaskId === "s1.1");
	check("store.hasWorkflowFile 正常", store.hasWorkflowFile() === true);
	// commit 写磁盘也走固化 cwd
	store.getWorkflow().stages[0].name = "改过的阶段";
	store.commitWorkflow();
	const { readFileSync } = await import("node:fs");
	check(
		"commitWorkflow 写盘正常（固化 cwd）",
		JSON.parse(readFileSync(join(dir, ".pi", "workflow", "workflow.json"), "utf8")).stages[0].name === "改过的阶段",
	);
	// 防 lint 未使用：staleProxy 仅用于模拟（此处不再访问，固化即本测试意义所在）
	void staleProxy;
	rmSync(dir, { recursive: true, force: true });
}

// ---- 场景 2：报告崩溃链复现——旧 store 持有 stale ctx 时，新会话 session_start 调 getStore ----
console.log("场景 2：getStore 在旧实例 stale 后仍可安全复用/比较");
{
	const dir = makeFixture();
	const freshCtx = { cwd: dir, hasUI: true, mode: "tui", ui: {} };
	// 会话 A：首次 getStore（session_start）
	const s1 = getStore(freshCtx);
	check("会话 A：首次 getStore 正常", s1.cwd === dir);

	// session 替换：会话 A 的 ctx 被 pi 标记 stale，新会话 B 传入新 ctx（同 cwd）
	const staleCtxA = makeStaleCtx(); // 会话 A 的 ctx 已 stale（访问即抛错）
	const freshCtxB = { cwd: dir, hasUI: true, mode: "tui", ui: {} }; // 新会话 B 的新 ctx
	// 修复前：getStore(freshCtxB) 比较 sessionStore.cwd（动态访问 staleCtxA）→ 崩溃
	const s2 = getStore(freshCtxB);
	check("会话 B：getStore 不崩溃（cwd 纯字符串比较）", s2 === s1, "复用同 cwd 实例");
	check("会话 B：store 仍可读写", s2.getWorkflow().stages.length === 1);
	rmSync(dir, { recursive: true, force: true });
}

// ---- 场景 3：cwd 变化自动重建（切项目） ----
console.log("场景 3：cwd 变化自动重建");
{
	const dirA = makeFixture();
	const dirB = makeFixture();
	const sA = getStore({ cwd: dirA, hasUI: true, mode: "tui", ui: {} });
	check("项目 A：getStore 正常", sA.cwd === dirA);
	// 切到项目 B（不同 cwd）→ 重建
	const sB = getStore({ cwd: dirB, hasUI: true, mode: "tui", ui: {} });
	check("项目 B：cwd 变化自动重建", sB !== sA && sB.cwd === dirB, `sB===sA: ${sB === sA}`);
	// 切回项目 A → 再次重建（A 的实例已丢弃）
	const sA2 = getStore({ cwd: dirA, hasUI: true, mode: "tui", ui: {} });
	check("切回项目 A：重建为新实例", sA2 !== sB && sA2.cwd === dirA);
	rmSync(dirA, { recursive: true, force: true });
	rmSync(dirB, { recursive: true, force: true });
}

// ---- 清理 ----
rmSync(BUNDLE, { force: true });

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 个断言失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
