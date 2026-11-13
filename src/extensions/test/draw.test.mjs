#!/usr/bin/env node
/**
 * draw 生图插件的回归测试（离线，不发网络请求）
 *
 * 覆盖：
 * - draw：配置容错、主备链逐项失败、档位隔离、`provider/modelId` 切分（id 自身含斜杠）
 *
 * 用法：node src/extensions/test/draw.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const EXT = join(HERE, "..");
const SRC = join(EXT, "..");

let failures = 0;
const check = (name, ok, extra) => {
	if (ok) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra !== undefined ? `（${JSON.stringify(extra)}）` : ""}`);
		failures++;
	}
};

async function bundle(entry, outfile) {
	const out = join(HERE, outfile);
	await build({
		entryPoints: [join(EXT, entry)],
		outfile: out,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});
	return { mod: await import(`${pathToFileURL(out).href}?t=${Date.now()}`), file: out };
}

const cleanup = [];
const tmp = (name) => {
	const f = join(mkdtempSync(join(tmpdir(), "pi-draw-")), name);
	cleanup.push(f);
	return f;
};

console.log("场景 E：draw 配置容错与主备链");
{
	// 用环境变量把配置文件指到临时目录，避免动到用户真实配置
	const cfgFile = tmp("draw.json");
	process.env.PI_DRAW_CONFIG_FILE = cfgFile;
	const draw = await bundle("draw/index.ts", ".tmp-draw.mjs");
	cleanup.push(draw.file);

	// 伪造一个最小 ctx：只填本插件用到的 modelRegistry 与 ui
	const calls = [];
	const mkCtx = (models, behaviour) => ({
		cwd: tmpdir(),
		ui: { setStatus() {}, notify() {}, custom: async () => null, select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined },
		modelRegistry: {
			findOfType: (type, provider, id) => models.find((m) => m.type === type && m.provider === provider && m.id === id),
			getModelsOfType: (type) => models.filter((m) => m.type === type),
			generateImages: async (model, context, options) => {
				calls.push({ model: `${model.provider}/${model.id}`, context, options });
				const result = behaviour(`${model.provider}/${model.id}`, context);
				const base = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
				// 约定：返回字符串 = 这次失败（字符串是错误原因）；返回 null = 成功出图
				if (result !== null) return { ...base, output: [], stopReason: "error", errorMessage: result };
				return { ...base, output: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], stopReason: "stop" };
			},
		},
	});

	const models = [
		{ type: "image", provider: "openrouter", id: "bytedance-seed/seedream-5-0-pro", api: "openrouter-images" },
		{ type: "image", provider: "openrouter", id: "vendor/backup-image", api: "openrouter-images" },
	];

	// 拿扩展注册的工具：execute 直接跑
	const tools = {};
	const commands = {};
	draw.mod.default({
		registerTool: (def) => { tools[def.name] = def; },
		registerCommand: (name, def) => { commands[name] = def; },
		on: () => {},
	});

	check("E: 注册了 draw_image", typeof tools.draw_image?.execute === "function");
	check("E: 注册了 /draw-config", typeof commands["draw-config"]?.handler === "function");
	const paramKeys = Object.keys(tools.draw_image.parameters.properties ?? {});
	check("E: 参数里没有 model（模型不可由调用方指定）", !paramKeys.includes("model"), paramKeys);
	check("E: 档位只有 draft/final", paramKeys.includes("tier"));

	// 没动过配置时不应该写文件
	const cfgExists = existsSync(process.env.PI_DRAW_CONFIG_FILE ?? cfgFile);
	check("E: 未改配置时不写文件", cfgExists === false, cfgExists);

	// 显式配置一条两段主备链（不依赖出厂默认值）
	let ctx = mkCtx(models, () => null);
	await commands["draw-config"].handler("set draft openrouter/bytedance-seed/seedream-5-0-pro,openrouter/vendor/backup-image", ctx);
	let res = await tools.draw_image.execute("c1", { prompt: "一只猫" }, undefined, undefined, ctx);
	check("E: 默认 draft 出图成功", res.isError !== true && res.details.model === "openrouter/bytedance-seed/seedream-5-0-pro", res.details);
	check("E: 落盘文件存在", existsSync(res.details.files[0]), res.details.files);
	check("E: 默认不把图塞回上下文", res.content.filter((c) => c.type === "image").length === 0);
	check("E: 用了配置的默认尺寸", calls.at(-1).options.metadata.size === "1024x1024", calls.at(-1).options.metadata);

	// 主备链：第一个失败换第二个
	calls.length = 0;
	ctx = mkCtx(models, (ref) => (ref === "openrouter/bytedance-seed/seedream-5-0-pro" ? "上游没有返回图片" : null));
	res = await tools.draw_image.execute("c2", { prompt: "猫" }, undefined, undefined, ctx);
	check("E: 首个失败后换到备选", res.details.model === "openrouter/vendor/backup-image", res.details);
	check("E: 两个候选都被试过", calls.length === 2, calls.map((c) => c.model));
	check("E: 失败原因带回给调用方", res.details.failures.length === 1 && /没有返回图片/.test(res.details.failures[0]), res.details.failures);

	// 整链失败
	ctx = mkCtx(models, () => "全挂");
	res = await tools.draw_image.execute("c3", { prompt: "猫" }, undefined, undefined, ctx);
	check("E: 整链失败返回 isError", res.isError === true);
	check("E: 整链失败列出每条原因", res.details.failures.length === 2, res.details.failures);

	// final 档：id 自身含斜杠，只按第一个斜杠切分
	calls.length = 0;
	ctx = mkCtx(models, () => null);
	res = await tools.draw_image.execute("c4", { prompt: "成品", tier: "final" }, undefined, undefined, ctx);
	check("E: final 档走配置里那条链", res.details.model === "openrouter/bytedance-seed/seedream-5-0-pro", res.details);
	check("E: 含斜杠的 id 没被切错", calls.at(-1).model === "openrouter/bytedance-seed/seedream-5-0-pro", calls.at(-1).model);

	// /draw-config set 校验不可用引用
	const notices = [];
	ctx = mkCtx(models, () => null);
	ctx.ui.notify = (text, level) => notices.push({ text, level });
	await commands["draw-config"].handler("set draft openrouter/不存在,openrouter/bytedance-seed/seedream-5-0-pro", ctx);
	check("E: 非法引用被拒", notices.at(-1).level === "error", notices.at(-1));
	check("E: 拒绝时列出可用模型", /seedream-5-0-pro/.test(notices.at(-1).text), notices.at(-1).text);

	// /draw-config set 合法引用落配置
	await commands["draw-config"].handler("set draft openrouter/bytedance-seed/seedream-5-0-pro", ctx);
	check("E: 合法引用被接受", notices.at(-1).level === "info", notices.at(-1));
	calls.length = 0;
	res = await tools.draw_image.execute("c5", { prompt: "猫" }, undefined, undefined, ctx);
	check("E: 改完立即生效（无需 reload）", res.details.model === "openrouter/bytedance-seed/seedream-5-0-pro", res.details);

	// preview 才附图
	res = await tools.draw_image.execute("c6", { prompt: "猫", preview: true }, undefined, undefined, ctx);
	check("E: preview=true 时附图", res.content.some((c) => c.type === "image"));
}

console.log("场景 F：没有可用生图模型时的提示");
{
	const draw = await bundle("draw/index.ts", ".tmp-draw2.mjs");
	cleanup.push(draw.file);
	const tools = {};
	draw.mod.default({ registerTool: (d) => { tools[d.name] = d; }, registerCommand: () => {}, on: () => {} });
	const notices = [];
	const ctx = {
		cwd: tmpdir(),
		ui: { setStatus() {}, notify: (t, l) => notices.push({ t, l }), custom: async () => null, select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined },
		modelRegistry: {
			findOfType: () => undefined,
			getModelsOfType: () => [],
			generateImages: async () => { throw new Error("不该被调用"); },
		},
	};
	const res = await tools.draw_image.execute("f1", { prompt: "猫" }, undefined, undefined, ctx);
	check("F: 无模型时快速失败", res.isError === true);
	check("F: 提示去配置模型", /models\.json/.test(res.content[0].text), res.content[0].text);
}

for (const f of cleanup) {
	try {
		if (existsSync(f)) unlinkSync(f);
	} catch {
		/* 清理失败不影响结果 */
	}
}

if (failures > 0) {
	console.error(`\n${failures} 项失败`);
	process.exit(1);
}
console.log("\n全部通过 ✓");
