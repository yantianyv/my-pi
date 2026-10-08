#!/usr/bin/env node
/**
 * shared/model-setting 回归测试：两层模型设置的解析链与文件读写
 *
 * 锁住的不变量（改动 shared/model-setting 或各插件注册参数前先看这里）：
 * - 本地固定模型优先于中心设置；本地 auto 才看中心
 * - 中心无该用途记录 → 用插件注册时声明的默认策略；策略未映射 → 回落当前会话模型
 * - AUTO = 当前会话模型；FREE = 只在免费模型里取，且带回退链（唯一有多候选的策略）
 * - 回退链 = 免费模型按价格升序
 * - 任何解析结果都带链（单模型链的回退为空）；具体模型不可用时回落 AUTO
 * - 本地设置写入是读-改-写：不丢同文件里插件的其它配置键；解析不出的本地值不做兼容映射，自然回落 AUTO
 *
 * 原理：把 HOME/USERPROFILE 指向临时目录后动态 import esbuild bundle，
 * 使 MODEL_CONFIG_FILE / 各插件配置文件都落在沙箱里（不碰真实 ~/.pi/agent）。
 *
 * 用法：node src/extensions/shared/test/model-setting.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "..", "..", "..");
const BUNDLE_OUT = join(TEST_DIR, ".tmp-model-setting-bundle.mjs");

// 沙箱：HOME / USERPROFILE 指向临时目录（os.homedir() 在 Windows 读 USERPROFILE）
const sandbox = mkdtempSync(join(tmpdir(), "pi-model-setting-"));
mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `：${extra}` : ""}`);
		failures++;
	}
};

await build({
	entryPoints: [join(SRC_DIR, "extensions", "shared", "model-setting.ts")],
	outfile: BUNDLE_OUT,
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
	target: "es2022",
	logLevel: "silent",
});
const mod = await import(pathToFileURL(BUNDLE_OUT).href);
rmSync(BUNDLE_OUT, { force: true });

const {
	createModelSetting,
	loadModelConfigState,
	saveModelConfigState,
	setPurposeSetting,
	setStrategyMapping,
	readLocalSetting,
	writeLocalSetting,
	resolveSetting,
	listPurposeDecls,
} = mod;

// ---- 假模型注册表 ----
const mk = (provider, id, input, output, inputModalities = ["text"]) => ({
	provider,
	id,
	name: id,
	cost: { input, output, cacheRead: 0, cacheWrite: 0 },
	input: inputModalities,
	contextWindow: 100_000,
});
const free1 = mk("freeA", "free-a", 0, 0);
const free2 = mk("freeB", "free-b", 0, 0);
const cheap = mk("p1", "cheap", 0.1, 0.2);
const mid = mk("p2", "mid", 1, 2);
const strong = mk("p3", "strong", 3, 6);
const vision = mk("p4", "vision", 4, 8, ["text", "image"]);
const session = mk("main", "session-model", 2, 4);
const all = [free1, free2, cheap, mid, strong, vision, session];
const ctx = {
	model: session,
	modelRegistry: {
		getAvailable: () => all,
		hasConfiguredAuth: () => true,
		find: (p, i) => all.find((m) => m.provider === p && m.id === i),
	},
};

const refs = (chain) => chain.chain.map((m) => `${m.provider}/${m.id}`).join(" > ");

// ---- 1. 默认策略：AUTO 跟随会话；未映射槽回落会话 ----
const declA = {
	purpose: "t.auto",
	plugin: "test",
	label: "auto 用途",
	defaultStrategy: "AUTO",
};
const settingAuto = createModelSetting(declA);
check("默认策略 AUTO → 当前会话模型", settingAuto.resolve(ctx).model?.id === "session-model", settingAuto.resolve(ctx).model?.id);
check("默认策略 AUTO 的来源 = default", settingAuto.resolve(ctx).source === "default");
check("AUTO 链只有会话模型（不跨模型回退）", refs(settingAuto.resolve(ctx)) === "main/session-model", refs(settingAuto.resolve(ctx)));
check("AUTO 无回退候选", settingAuto.resolve(ctx).failover() === undefined, refs(settingAuto.resolve(ctx)));

// ---- 2. 未映射的策略槽 → 回落会话模型 ----
const settingLite = createModelSetting({ purpose: "t.lite", plugin: "test", label: "lite 用途", defaultStrategy: "LITE" });
check("LITE 未映射 → 回落会话模型", settingLite.resolve(ctx).model?.id === "session-model");

// ---- 3. 映射策略槽 → 用映射的模型，且所有引用该槽的用途一起变 ----
setStrategyMapping("LITE", "p1/cheap");
check("LITE 映射后取该模型", settingLite.resolve(ctx).model?.id === "cheap");
check("映射后来源 = default（用注册的默认策略解析）", settingLite.resolve(ctx).source === "default");

// ---- 4. 中心设置覆盖默认策略 ----
setPurposeSetting("t.lite", "MAX");
setStrategyMapping("MAX", "p3/strong");
check("中心设置 MAX 生效", settingLite.resolve(ctx).model?.id === "strong");
check("中心设置来源 = center", settingLite.resolve(ctx).source === "center");

// ---- 5. 本地固定模型优先于中心设置 ----
const sandboxFile = join(sandbox, "plugin.json");
writeFileSync(join(sandbox, "plugin.json"), JSON.stringify({ other: "keep-me", model: "auto" }), "utf8");
const settingLocal = createModelSetting({
	purpose: "t.lite",
	plugin: "test",
	label: "lite 用途",
	file: sandboxFile,
	key: "model",
	defaultStrategy: "LITE",
});
check("未固定时本地 = auto", settingLocal.getLocal() === "auto");
settingLocal.setLocal("p2/mid");
check("本地固定后优先于中心设置", settingLocal.resolve(ctx).model?.id === "mid");
check("本地固定来源 = local", settingLocal.resolve(ctx).source === "local");
check("写入保留同文件其它键", JSON.parse(readFileSync(sandboxFile, "utf8")).other === "keep-me");
settingLocal.setLocal("auto");
check("改回 auto 后中心设置重新生效", settingLocal.resolve(ctx).model?.id === "strong");

// ---- 6. 具体模型不可用 → 回落 AUTO ----
setPurposeSetting("t.lite", "p9/not-exist");
check("中心指向的模型不可用 → 回落会话模型", settingLite.resolve(ctx).model?.id === "session-model");

// ---- 7. FREE：只在免费模型里选 + 故障转移链 ----
const freeChain = resolveSetting("FREE", ctx);
check("FREE 链只含免费模型", freeChain.chain.every((m) => m.provider.startsWith("free")), refs(freeChain));
check("FREE 链第二个是价格升序的另一个免费模型", freeChain.failover()?.id === "free-b", freeChain.failover()?.id);

// ---- 8. 解析不出的本地值不写守卫，自然回落 AUTO ----
writeFileSync(sandboxFile, JSON.stringify({ model: "已废弃的取值" }), "utf8");
const oddDecl = { purpose: "t.odd", plugin: "test", label: "解析不出的值", file: sandboxFile, key: "model", defaultStrategy: "AUTO" };
check("读到的值原样保留（不做兼容映射）", readLocalSetting(oddDecl) === "已废弃的取值", readLocalSetting(oddDecl));
check(
	"解析不出时自然回落当前会话模型",
	createModelSetting(oddDecl).resolve(ctx).model?.id === "session-model",
	createModelSetting(oddDecl).resolve(ctx).model?.id,
);

// ---- 9. 用途声明清单（面板据此枚举，重复注册幂等） ----
createModelSetting({ purpose: "t.lite", plugin: "test", label: "lite 用途（重注册）", defaultStrategy: "LITE" });
const decls = listPurposeDecls();
check("声明清单按 purpose 去重", decls.filter((d) => d.purpose === "t.lite").length === 1);
check("重注册更新 label", decls.find((d) => d.purpose === "t.lite")?.label === "lite 用途（重注册）");
check("声明清单含全部已注册用途", ["t.auto", "t.lite"].every((p) => decls.some((d) => d.purpose === p)));

// ---- 10. 中心状态读写 ----
const state = loadModelConfigState();
check("中心状态记录了策略映射与用途设置", state.strategies.LITE === "p1/cheap" && state.purposes["t.lite"] === "p9/not-exist", JSON.stringify(state));
saveModelConfigState({ version: 1, strategies: {}, purposes: {} });
check("清除后回到默认策略", loadModelConfigState().purposes["t.lite"] === undefined && resolveSetting("AUTO", ctx).model?.id === "session-model");

rmSync(sandbox, { recursive: true, force: true });
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
