#!/usr/bin/env node
/**
 * web_search 的 provider 参数回归测试（付费源分发 + 引导去重）
 *
 * 用法：node src/extensions/web-tool/test/provider.test.mjs
 *
 * 原理与覆盖：
 * - esbuild 现场 bundle providers.ts / paid-hint.ts / search.ts / dislike.ts，全程离线（不发请求）：
 *   分发逻辑、降权排序与提示文案都是纯函数，付费源的真实 HTTP 调用不在本测试范围内（靠集成手测）。
 * - 场景 A~H：
 *   A provider 清单（默认 free、付费清单从同一处派生、无 web- 前缀残留）
 *   B 会话内只提示一次（第二次返回 undefined）
 *   C 无可用付费源时不给提示（不提用不了的能力）
 *   D 提示文案带正确的 provider 取值与计费说明
 *   E resetPaidHint 后同一会话可再次提示（会话重启/切换）
 *   F 结果末尾追加 footer，不追加时输出不变（formatSearchResults 向后兼容）
 *   G isPaidProvider 只认清单内的取值（未知取值不当作付费源）
 *   H 差评降权对付费源生效（封禁阈值命中即滤除、未达阈值仍保留）
 *   I source 的对外取值与 provider 解耦（source 只报 web/npm/github）
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..", ".."); // src/
const ROOT = path.join(SRC, "extensions", "web-tool");
const ENTRY = path.join(ROOT, ".tmp-provider-entry.ts");
const BUNDLE = path.join(ROOT, ".tmp-provider-entry.mjs");

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures++;
}

fs.writeFileSync(
	ENTRY,
	["providers", "paid-hint", "search", "dislike"]
		.map((m) => `export * from ${JSON.stringify(pathToFileURL(path.join(ROOT, `${m}.ts`)).href)};`)
		.join("\n"),
);

try {
	await build({
		entryPoints: [ENTRY],
		outfile: BUNDLE,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: path.join(SRC, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
} catch (e) {
	// esbuild 不认 file:// 入口说明，回退到相对路径
	fs.writeFileSync(
		ENTRY,
		["providers", "paid-hint", "search", "dislike"].map((m) => `export * from "./${m}";`).join("\n"),
	);
	await build({
		entryPoints: [ENTRY],
		outfile: BUNDLE,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: path.join(SRC, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
}

const mod = await import(pathToFileURL(BUNDLE).href);

// ---- A 常量与清单 ----
check("默认 provider 是 free", mod.FREE_PROVIDER === "free");
check("取值清单从付费清单派生", mod.PROVIDER_VALUES.includes(mod.FREE_PROVIDER) && mod.PROVIDER_VALUES.includes("deepseek"));
check("取值清单无 web 前缀残留", !mod.PROVIDER_VALUES.some((v) => v.startsWith("web-")));
check("付费清单含 deepseek", Object.keys(mod.PAID_PROVIDERS).includes("deepseek"));
check(
	"deepseek 有展示名与计费说明",
	mod.PAID_PROVIDERS["deepseek"].label === "DeepSeek" && /1000/.test(mod.PAID_PROVIDERS["deepseek"].costNote),
	mod.PAID_PROVIDERS["deepseek"].costNote,
);

// ---- B 会话内只提示一次 ----
mod.resetPaidHint("s1");
const first = mod.takePaidHint("s1", ["deepseek"]);
const second = mod.takePaidHint("s1", ["deepseek"]);
check("首次免费搜索给出提示", typeof first === "string" && first.length > 0);
check("同一会话第二次不再提示", second === undefined);
check("另一个会话各有各的第一次", typeof mod.takePaidHint("s2", ["deepseek"]) === "string");

// ---- C 无可用付费源 ----
mod.resetPaidHint("s3");
check("没有付费源可用时不提示", mod.takePaidHint("s3", []) === undefined);

// ---- D 提示文案 ----
check("提示带 provider 取值", /provider="deepseek"/.test(first ?? ""), (first ?? "").split("\n").pop());

// ---- E reset 后可再次提示 ----
mod.resetPaidHint("s1");
check("reset 后同一会话可再次提示", typeof mod.takePaidHint("s1", ["deepseek"]) === "string");

// ---- F formatSearchResults 的 footer ----
const rows = [
	{ title: "标题一", url: "https://a.example.com/x", snippet: "摘要一", src: "bing" },
	{ title: "标题二", url: "https://b.example.com/y", snippet: "摘要二", src: "so360" },
];
const plain = mod.formatSearchResults(rows, "free");
const withFooter = mod.formatSearchResults(rows, "free", "FOOTER-MARKER");
check("不传 footer 时输出不含标记", !plain.includes("FOOTER-MARKER"));
check("传 footer 时追加在末尾", withFooter.includes("FOOTER-MARKER") && withFooter.indexOf("FOOTER-MARKER") > withFooter.indexOf("web_fetch"));
check("footer 不破坏原有内容", withFooter.startsWith(plain.split("\n").slice(0, 3).join("\n")));

// ---- G isPaidProvider 的取值判定 ----
check("清单内取值是付费源", mod.isPaidProvider("deepseek") === true);
check("免费源不是付费源", mod.isPaidProvider(mod.FREE_PROVIDER) === false);
check("旧值 web-deepseek 不再是付费源", mod.isPaidProvider("web-deepseek") === false);
check("旧值 web-free 不再是免费源", mod.FREE_PROVIDER !== "web-free");
check("空取值不是付费源", mod.isPaidProvider("") === false);

// ---- H 差评对付费源生效（用 dislikePenalty 验证共用的判定）----
const banned = { "blog.csdn.net": { count: 5, reasons: ["灌水"] } }; // 达封禁阈值
const weak = { "blog.csdn.net": { count: 1, reasons: ["灌水"] } }; // 仅降权
check("封禁域名的系数为 0（会被滤除）", mod.dislikePenalty("blog.csdn.net", banned) === 0);
check("子域名继承封禁", mod.dislikePenalty("sub.blog.csdn.net", banned) === 0);
check("未达阈值的域名仍有系数", mod.dislikePenalty("blog.csdn.net", weak) > 0);
check("不相关域名不受影响", mod.dislikePenalty("github.com", banned) === 1);

// ---- I source / provider 解耦（读源码断言，避免行为回归）----
const idxSrc = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
check("source 取值清单只有 web/npm/github", /SOURCE_VALUES = \["web", "npm", "github"\]/.test(idxSrc));
check("付费路径不把 provider 当 source", !/usedSource = paidProvider/.test(idxSrc));
check("免费网页路径 source 固定报 web", /usedSource = "web"/.test(idxSrc));
check("npm/github 路径 provider 恒为 free", /let usedProvider: string = FREE_PROVIDER/.test(idxSrc));

// 元信息必须放摘要开头：展示层会在 200 字处再截断，追加在尾部会被切掉
const provSrc = fs.readFileSync(path.join(ROOT, "providers.ts"), "utf8");
check("权威度/日期放在摘要开头", /snippet: meta\.length \? `（\$\{meta\.join/.test(provSrc));
check("元信息不再追加在摘要尾部", !/\$\{snippet\}（\$\{meta\.join/.test(provSrc));

fs.rmSync(ENTRY, { force: true });
fs.rmSync(BUNDLE, { force: true });

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
