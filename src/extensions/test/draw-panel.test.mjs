#!/usr/bin/env node
/**
 * draw 配置面板回归测试（离线；deps 全部用桩，不碰真实配置）
 *
 * 原理：esbuild 把 panel.ts 与 shared/ui.ts bundle 成单文件 ESM 再 import；
 * theme mock 纯文本透传，tui mock 只提供 requestRender。
 *
 * 覆盖：
 * - A 总览渲染：两档链路、落盘目录、尺寸、模型计数、键位提示
 * - B 键位：↑↓ 移动、Enter 进入、Esc 关闭；空链提示
 * - C 链条编辑：进入档位、追加模型（输入过滤 + Enter）、替换、上移下移、移除、末位保护
 * - D 设置编辑：落盘目录与尺寸的输入/退格/校验/保存
 * - E 边界：无可用模型、搜索无匹配、Esc 逐级返回
 *
 * 用法：node src/extensions/test/draw-panel.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");

await build({
	entryPoints: [join(ext, "draw", "panel.ts")],
	outfile: join(here, ".tmp-draw-panel.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["@earendil-works/*", "typebox"],
	target: "es2022",
	logLevel: "silent",
});
const P = await import(pathToFileURL(join(here, ".tmp-draw-panel.mjs")).href);

let failures = 0;
const check = (name, cond, extra) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra === undefined ? "" : ` :: ${extra}`}`);
		failures++;
	}
};
const section = (t) => console.log(`\n${t}`);

/** 面板渲染结果里第一条包含 needle 的行（断言失败时给出上下文） */
const lineOf = (p, needle) => p.text().split("\n").find((l) => l.includes(needle));

const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", backspace: "\x7f" };

/** 造一个面板 + 可变配置 */
function makePanel(initial, models = ["openrouter/vendor/quick-image", "openrouter/vendor/better-image", "openrouter/bytedance-seed/seedream-5-0-pro"]) {
	let cfg = JSON.parse(JSON.stringify(initial));
	const saves = [];
	let closed = false;
	const tui = { requestRender() {} };
	const overlay = new P.DrawConfigOverlay(tui, theme, {
		getConfig: () => JSON.parse(JSON.stringify(cfg)),
		saveConfig: (next) => {
			cfg = JSON.parse(JSON.stringify(next));
			saves.push(JSON.parse(JSON.stringify(next)));
		},
		listModels: () => models,
		modelLabel: (ref) => {
			const slash = ref.indexOf("/");
			return slash > 0 ? ref.slice(slash + 1) : ref;
		},
	}, () => { closed = true; });
	return {
		overlay,
		text: () => overlay.render(90).join("\n"),
		cfg: () => cfg,
		saves,
		closed: () => closed,
		press: (k) => { overlay.handleInput(k); },
	};
}

const base = {
	tiers: { draft: ["openrouter/vendor/quick-image"], final: ["openrouter/bytedance-seed/seedream-5-0-pro"] },
	outDir: ".pi/images",
	size: "1024x1024",
};

section("A 总览渲染");
{
	const p = makePanel(base);
	const t = p.text();
	check("A: 标题带图标", t.includes("生图配置") && t.includes("🎨"), t.split("\n")[0]);
	check("A: 两个档位都在", t.includes("草稿（draft）") && t.includes("成品（final）"));
	check("A: 显示档位链路", t.includes("quick-image") && t.includes("seedream-5-0-pro"));
	check("A: 显示落盘目录", t.includes(".pi/images"));
	check("A: 显示默认尺寸", t.includes("1024x1024"));
	check("A: 显示已注册模型数", t.includes("已注册生图模型 3 个"));
	check("A: 有键位提示", t.includes("Enter 进入") && t.includes("Esc 关闭"));
	check("A: 边框完整", t.trimStart().startsWith("╭") && t.trimEnd().endsWith("╯"));
}

section("B 总览键位");
{
	const p = makePanel(base);
	p.press(KEY.down);
	p.press(KEY.down);
	check("B: ↓ 移到落盘目录项", p.text().includes("› 落盘目录"), p.text().split("\n").find((l) => l.includes("›")));
	p.press(KEY.up);
	p.press(KEY.up);
	check("B: ↑ 回到首个档位", p.text().includes("› 草稿"), p.text().split("\n").find((l) => l.includes("›")));
	p.press(KEY.up);
	check("B: 首项再 ↑ 停住（不绕回）", p.text().includes("› 草稿"));

	// Esc 关闭
	p.press(KEY.esc);
	check("B: Esc 关闭面板", p.closed() === true);
}

section("C 链条编辑");
{
	const p = makePanel(base);
	p.press(KEY.enter); // 进入草稿档
	check("C: 进入档位后标题带档名", p.text().includes("生图配置 · 草稿"));
	check("C: 显示尝试顺序说明", p.text().includes("按顺序尝试"));
	check("C: 首选标记在第一位", p.text().includes("首选"));
	check("C: 有添加模型项", p.text().includes("添加模型"));

	// 走到「添加模型」并追加
	p.press(KEY.down); // 光标到 ＋添加模型
	p.press(KEY.enter); // 进入选择
	check("C: 进入选择后显示过滤框", p.text().includes("追加到") && p.text().includes("输入关键词过滤"));
	check("C: 已在链中的模型不出现在候选里", !p.text().includes("› quick-image"));
	p.press(KEY.enter); // 选第一个候选（better-image）
	check("C: 追加后配置写入", p.cfg().tiers.draft.length === 2, p.cfg().tiers.draft);
	check("C: 追加的是 better-image", p.cfg().tiers.draft[1] === "openrouter/vendor/better-image", p.cfg().tiers.draft);
	check("C: 追加后有反馈", p.text().includes("已追加"));
	check("C: 返回链条视图", p.text().includes("备选 1"));
}

section("C2 输入过滤");
{
	const p = makePanel(base);
	p.press(KEY.enter); // 草稿
	p.press(KEY.down);
	p.press(KEY.enter); // 进选择
	// 输入 "seed"
	for (const ch of "seed") p.press(ch);
	check("C2: 过滤词回显", p.text().includes("seed"));
	check("C2: 只剩匹配项", p.text().includes("seedream-5-0-pro") && !p.text().includes("better-image"));
	p.press(KEY.backspace);
	check("C2: 退格有效", p.text().includes("see") && !p.text().includes("seed "));
	// Esc 先清词：看搜索行（以 ` / ` 开头的那行）里是否还留着 seed
	p.press(KEY.esc);
	const searchLine = p.text().split("\n").find((l) => l.includes(" / ")) ?? "";
	check("C2: 有词时 Esc 先清空过滤", !searchLine.includes("seed"), searchLine);
	check("C2: 清词后仍在选择视图", p.text().includes("追加到"));
	// 再 Esc 返回链条
	p.press(KEY.esc);
	check("C2: 再 Esc 回到链条视图", p.text().includes("首选"));
}

section("C3 动作菜单：上移 / 下移 / 移除 / 替换");
{
	const two = { ...base, tiers: { draft: ["openrouter/vendor/quick-image", "openrouter/vendor/better-image"], final: base.tiers.final } };
	const p = makePanel(two);
	p.press(KEY.enter); // 进草稿
	p.press(KEY.down); // 光标到 better-image
	p.press(KEY.enter); // 打开动作菜单
	check("C3: 动作菜单四项", ["替换模型", "上移", "下移", "移除"].every((a) => p.text().includes(a)));
	check("C3: 末位时「下移」标注原因", p.text().includes("末位"), lineOf(p, "下移"));

	// 上移
	p.press(KEY.down); // 光标到"上移"
	p.press(KEY.enter);
	check("C3: 上移生效（顺序互换）", p.cfg().tiers.draft[0] === "openrouter/vendor/better-image", p.cfg().tiers.draft);
	check("C3: 上移后光标跟随", p.text().includes("› vendor/better-image"), lineOf(p, "›"));

	// 首选位上移被拒
	p.press(KEY.enter);
	check("C3: 首选位「上移」标注原因", p.text().includes("已是首选"), lineOf(p, "上移"));
	p.press(KEY.down);
	p.press(KEY.enter); // 执行上移 → 应被拒
	check("C3: 首选位上移被拒并提示", p.text().includes("已经是首选"), lineOf(p, "已经"));

	// 下移回来
	p.press(KEY.esc); // 回链条
	p.press(KEY.enter); // 打开动作
	p.press(KEY.down);
	p.press(KEY.down); // 光标到"下移"
	p.press(KEY.enter);
	check("C3: 下移生效", p.cfg().tiers.draft[1] === "openrouter/vendor/better-image", p.cfg().tiers.draft);

	// 移除
	p.press(KEY.enter);
	p.press(KEY.down);
	p.press(KEY.down);
	p.press(KEY.down); // 光标到"移除"
	p.press(KEY.enter);
	check("C3: 移除生效", p.cfg().tiers.draft.length === 1 && p.cfg().tiers.draft[0] === "openrouter/vendor/quick-image", p.cfg().tiers.draft);
	check("C3: 移除后有反馈", p.text().includes("已移除"));

	// 只剩一个时移除被拒
	p.press(KEY.enter);
	check("C3: 唯一项「移除」标注原因", p.text().includes("需保留一个"), lineOf(p, "移除"));
	p.press(KEY.down); p.press(KEY.down); p.press(KEY.down);
	p.press(KEY.enter);
	check("C3: 唯一项移除被拒", p.cfg().tiers.draft.length === 1 && p.text().includes("至少要留一个"), lineOf(p, "至少"));
}

section("C4 替换模型");
{
	const p = makePanel(base);
	p.press(KEY.enter); // 进草稿
	p.press(KEY.enter); // 在首项上直接打开动作菜单
	p.press(KEY.enter); // 执行"替换模型"
	check("C4: 进入替换视图", p.text().includes("替换为"), lineOf(p, "替换为"));
	check("C4: 候选包含当前项自身", p.text().includes("quick-image"));
	p.press(KEY.down); // 选下一个候选
	p.press(KEY.enter);
	check("C4: 替换后链长度不变", p.cfg().tiers.draft.length === 1, p.cfg().tiers.draft);
	check("C4: 替换成新模型", p.cfg().tiers.draft[0] !== "openrouter/vendor/quick-image", p.cfg().tiers.draft);
	check("C4: 替换后有反馈", p.text().includes("已替换"));
}

section("D 设置编辑");
{
	const p = makePanel(base);
	p.press(KEY.down);
	p.press(KEY.down); // 落盘目录
	p.press(KEY.enter);
	check("D: 进入目录编辑", p.text().includes("图片保存目录"));
	check("D: 初值是当前目录", p.text().includes(".pi/images"));
	// 清空重输
	for (let i = 0; i < ".pi/images".length; i++) p.press(KEY.backspace);
	p.press(KEY.enter);
	check("D: 空值被拒", p.text().includes("不能为空"), p.text().split("\n").find((l) => l.includes("不能为空")));
	for (const ch of "out/pics") p.press(ch);
	p.press(KEY.enter);
	check("D: 新目录已保存", p.cfg().outDir === "out/pics", p.cfg().outDir);
	check("D: 保存后有反馈", p.text().includes("已保存"));
	check("D: 回到总览", p.text().includes("已注册生图模型"));

	// 尺寸校验
	p.press(KEY.down);
	p.press(KEY.down);
	p.press(KEY.down); // 默认尺寸
	p.press(KEY.enter);
	for (let i = 0; i < "1024x1024".length; i++) p.press(KEY.backspace);
	for (const ch of "big") p.press(ch);
	p.press(KEY.enter);
	check("D: 非法尺寸被拒", p.text().includes("宽x高"), p.text().split("\n").find((l) => l.includes("宽x高")));
	for (let i = 0; i < 3; i++) p.press(KEY.backspace);
	for (const ch of "512x512") p.press(ch);
	p.press(KEY.enter);
	check("D: 合法尺寸已保存", p.cfg().size === "512x512", p.cfg().size);
}

section("E 边界");
{
	// 没有任何生图模型
	const p = makePanel(base, []);
	check("E: 零模型时正常渲染", p.text().includes("已注册生图模型 0 个"));
	p.press(KEY.enter); // 进草稿
	p.press(KEY.down); // 添加模型
	p.press(KEY.enter);
	check("E: 无模型可加时提示", p.text().includes("没有可追加的生图模型"), p.text().split("\n").find((l) => l.includes("没有可追加")));
	check("E: 不进入选择视图", !p.text().includes("追加到"));

	// 空链也能渲染
	const empty = makePanel({ ...base, tiers: { draft: [], final: [] } });
	check("E: 空链提示无法出图", empty.text().includes("空：该档无法出图"), empty.text().split("\n").find((l) => l.includes("草稿")));
	empty.press(KEY.enter);
	check("E: 空链时只有添加项", empty.text().includes("添加模型") && !empty.text().includes("首选"));

	// 搜索无匹配
	const q = makePanel(base);
	q.press(KEY.enter);
	q.press(KEY.down);
	q.press(KEY.enter);
	for (const ch of "zzzz") q.press(ch);
	check("E: 无匹配给出提示", q.text().includes("没有匹配的模型"), q.text().split("\n").find((l) => l.includes("没有匹配")));
	q.press(KEY.enter); // 回车不应崩
	check("E: 无匹配时回车不写入", q.cfg().tiers.draft.length === 1, q.cfg().tiers.draft);
}

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
