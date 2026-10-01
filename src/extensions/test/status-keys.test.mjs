/**
 * HUD 状态键登记回归测试（jiti/esbuild 都不需要：纯文本解析源码）
 *
 * 背景：HUD 行 1 动态区只显示优先级最高的一个状态，而优先级来自 hud-core 的 STATUS_STYLE；
 * 未登记的 key 缺省 priority 0，会被任何已登记状态盖掉——「推了状态却永远看不见」这类
 * 问题光看代码很难发现（曾有 explore / perm-gate / ask / pair-guard / clipboard 五个）。
 *
 * 本测试做双向检查：
 *   1. 所有扩展推的 key 都在 STATUS_STYLE 里登记（否则永远抢不过别人）；
 *   2. STATUS_STYLE 里没有没人推的死条目（曾经有 kb-test）。
 *
 * 运行：node src/extensions/test/status-keys.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "..");
const HUD_SRC = path.join(EXT_ROOT, "hud", "hud-core.ts");

const results = [];
function check(label, ok, extra) {
	results.push({ label, ok, extra });
	console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || extra === undefined ? "" : ` :: ${extra}`}`);
}

/** 递归收集扩展源码（跳过测试目录与 node_modules） */
function sources(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === "node_modules" || e.name === "test") continue;
			out.push(...sources(p));
		} else if (e.name.endsWith(".ts")) out.push(p);
	}
	return out;
}

const hudSrc = fs.readFileSync(HUD_SRC, "utf8");
const styleBlock = hudSrc.slice(hudSrc.indexOf("const STATUS_STYLE"), hudSrc.indexOf("\n\t};", hudSrc.indexOf("const STATUS_STYLE")));
const registered = new Set([...styleBlock.matchAll(/"([a-z][a-z0-9-]*)":\s*\{ color:/g)].map((m) => m[1]));

// 推状态的写法：setStatus("<key>", …) / setStatusWithTTL(<ctx>, "<key>", …)；
// 动态 key 由常量或样式表提供：*STATUS_KEY = "x" / statusKey: "x"
// （hud-core 自身也推状态——hud-bash / balance-error / model-switch，一并纳入检查）
const pushed = new Map(); // key → 出处
for (const file of sources(EXT_ROOT)) {
	const src = fs.readFileSync(file, "utf8");
	const rel = path.relative(EXT_ROOT, file).replace(/\\/g, "/");
	for (const m of src.matchAll(/setStatus(?:WithTTL)?\(\s*(?:ctx\.ui\.|ui\.|lastCtx\?\.ui\.)?(?:"([a-z][a-z0-9-]*)"|(?:ctx,\s*|ui,\s*)?"([a-z][a-z0-9-]*)")/g)) {
		const key = m[1] ?? m[2];
		if (key) pushed.set(key, rel);
	}
	// 包装函数式调用（历史盲区：webdav-kb 的 status(ctx, "kb-read", …) 不走 setStatus，
	// 曾让 10 个键逃过检查）——凡是 `xxxStatus(ctx, "小写键"` 形态都当键处理
	for (const m of src.matchAll(/[Ss]tatus\(\s*ctx,\s*"([a-z][a-z0-9-]*)"\s*,/g)) {
		if (!pushed.has(m[1])) pushed.set(m[1], rel);
	}
	for (const m of src.matchAll(/statusKey:\s*"([a-z][a-z0-9-]*)"/g)) {
		if (!pushed.has(m[1])) pushed.set(m[1], rel);
	}
	// 常量式键：RUN_STATUS_KEY / STATUS_KEY / KB_OP_KEY…（*_WIDGET_KEY 是组件键，不是状态键）
	for (const m of src.matchAll(/([A-Z_]*KEY)\s*=\s*"([a-z][a-z0-9-]*)"/g)) {
		if (/WIDGET/.test(m[1])) continue;
		if (!pushed.has(m[2])) pushed.set(m[2], rel);
	}
}

console.log("状态键登记检查");
const missing = [...pushed.keys()].filter((k) => !registered.has(k));
check("所有推送的 key 都已登记进 STATUS_STYLE", missing.length === 0, missing.map((k) => `${k}（${pushed.get(k)}）`).join("、"));
const dead = [...registered].filter((k) => !pushed.has(k));
check("STATUS_STYLE 里没有没人推的死条目", dead.length === 0, dead.join("、"));
check("登记数量与推送数量吻合", registered.size === pushed.size, `登记 ${registered.size} / 推送 ${pushed.size}`);
check("动态 key 常量被识别到", pushed.has("task-alert-run") && pushed.has("pair-guard"), [...pushed.keys()].join(","));

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "全部通过 ✓" : `${failed.length} 项失败`}`);
process.exit(failed.length === 0 ? 0 : 1);
