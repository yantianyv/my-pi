#!/usr/bin/env node
/**
 * qr 扩展回归测试（复用 ask 测试基建模式）
 *
 * 原理：esbuild（src/node_modules 构建依赖）把扩展 bundle 成单文件 ESM 再 import；
 * external 白名单与 build.js 一致（@earendil-works/*、typebox），运行时经本目录
 * node_modules junction（→ pi 全局）解析。theme mock 纯文本透传，不干扰宽度计算。
 *
 * 覆盖：
 * - 场景 A：qr_encode 基本编码（版本/模块数/纠错级别 + PNG 落盘）
 * - 场景 B：renderResult 半块字符渲染（行数 = ⌈(size+8)/2⌉、可见宽度不超终端、含 ▀）
 * - 场景 C：pngPath → qr_decode 往返（码内文本一致）
 * - 场景 D：save=false 不落盘
 * - 场景 E：pngWidth 越界钳制（9999 → 2048，IHDR 校验）
 * - 场景 F：JPEG 往返（PNG 转 JPEG 后解码一致）
 * - 场景 G：非图片输入报错（仅支持 PNG/JPEG）
 * - 场景 H：无二维码图片报错（纯白 PNG）
 * - 场景 I：renderResult 失败路径（✗ + 真实原因）
 * - 场景 J：文本超容量报错（失败提示含纠错建议）
 * - 场景 K：/qr <文本> 弹出显示组件（含二维码 + 按任意键关闭，按键即关）
 * - 场景 L：/qr 无参数提示用法
 *
 * 用法：node src/extensions/qr/test/qr.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const EXT_SRC = join(TEST_DIR, "..", "..", "qr.ts"); // src/extensions/qr.ts（单文件扩展，与测试目录 qr/test/ 同名并存）
const SRC_DIR = join(TEST_DIR, "..", "..", ".."); // src/
const BUNDLE = join(TEST_DIR, ".tmp-bundle.mjs");

let failures = 0;
const check = (name, cond) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}`);
		failures++;
	}
};

const themeMock = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const TERM_COLS = 80;
const makeTui = () => ({ terminal: { rows: 24, columns: TERM_COLS }, requestRender() {} });

function makePi() {
	return {
		tools: [],
		commands: {},
		events: {},
		registerTool(t) {
			this.tools.push(t);
		},
		registerCommand(name, c) {
			this.commands[name] = c;
		},
		on(ev, cb) {
			this.events[ev] = cb;
		},
	};
}

function makeCtx(captures) {
	return {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: (key, text) => {
				captures.statuses[key] = text;
			},
			notify: (text, kind) => {
				captures.notifies.push({ text, kind });
			},
			custom: (factory, opts) =>
				new Promise((resolve) => {
					captures.customs.push({ factory, opts, resolve });
				}),
		},
	};
}

const makeCaptures = () => ({ customs: [], statuses: {}, notifies: [] });

/** 去 ANSI 转义（可见宽度计算用） */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** PNG IHDR 宽度（字节 16~20，大端） */
function pngWidth(bytes) {
	return bytes.readUInt32BE(16);
}

async function main() {
	// bundle：external 白名单与 build.js 一致，其余依赖（qrcode/jsqr/pngjs/jpeg-js）内联
	await build({
		entryPoints: [EXT_SRC],
		outfile: BUNDLE,
		bundle: true,
		format: "esm",
		platform: "node",
		external: ["@earendil-works/*", "typebox"],
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		target: "es2022",
		logLevel: "silent",
	});
	// 产物是 ESM，但内联的 qrcode 等包含动态 require——生产环境由 pi 经 jiti 加载，
	// 测试同样经 jiti 加载（与运行时行为一致，CJS 互操作可用）；jiti 取自 pi 全局
	// （test/node_modules/@earendil-works/pi-coding-agent junction 的嵌套依赖）
	const requirePi = createRequire(join(TEST_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
	const { createJiti } = requirePi("jiti");
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import(`file://${BUNDLE.split("\\").join("/")}`);

	const pi = makePi();
	mod.default(pi);
	const enc = pi.tools.find((t) => t.name === "qr_encode");
	const dec = pi.tools.find((t) => t.name === "qr_decode");
	check("工具已注册（qr_encode / qr_decode）", !!(enc && dec));
	if (!enc || !dec) process.exit(1);

	const TEXT = "https://example.com/pi-qr-test 🎉 中文";

	// ---- 场景 A：qr_encode 基本编码 ----
	console.log("场景 A：qr_encode 基本编码");
	const captures = makeCaptures();
	const ctx = makeCtx(captures);
	{
		const r = await enc.execute("t1", { text: TEXT }, undefined, undefined, ctx);
		const d = r.details;
		check("A: details.version ≥ 1", d?.version >= 1 && d.version <= 40);
		check("A: details.size 为正方形边长", d?.size >= 21 && d.size <= 177);
		check("A: 默认纠错级别 M", d?.ecc === "M");
		check("A: PNG 已落盘", typeof d?.pngPath === "string" && existsSync(d.pngPath));
		check("A: 结果文本提示已显示与路径", r.content[0].text.includes("显示在用户界面") && r.content[0].text.includes(d.pngPath));
		check("A: 状态推送 qr", captures.statuses["qr"] !== undefined);
		globalThis.__qrPngPath = d.pngPath;
		globalThis.__qrDetails = d;
	}

	// ---- 场景 B：renderResult 半块渲染 ----
	console.log("场景 B：renderResult 半块渲染");
	{
		const comp = enc.renderResult({ content: [{ type: "text", text: "x" }], details: globalThis.__qrDetails }, {}, themeMock, {
			isError: false,
			args: {},
		});
		const lines = comp.render(TERM_COLS);
		const n = globalThis.__qrDetails.size + 8; // 含静区
		check("B: 元信息行", lines[0].includes("二维码") && lines[0].includes(String(globalThis.__qrDetails.version)));
		const qrLines = lines.slice(1, 1 + Math.ceil(n / 2));
		check("B: 行数 = ⌈(size+8)/2⌉", qrLines.length === Math.ceil(n / 2));
		check("B: 全部含 ▀ 半块", qrLines.every((l) => l.includes("▀")));
		check(
			"B: 可见宽度 ≤ 终端宽度",
			qrLines.every((l) => stripAnsi(l).length <= TERM_COLS),
		);
		const body = stripAnsi(qrLines[0]);
		const expectedLeft = Math.floor((TERM_COLS - n) / 2);
		check("B: 半块行可见宽度 = 居中留白 + 静区矩阵边长", body.length === expectedLeft + n && body.trimEnd().length === expectedLeft + n);
		check("B: 尾行 PNG 路径提示", lines[lines.length - 1].includes("PNG："));
	}

	// ---- 场景 C：PNG 往返解码 ----
	console.log("场景 C：qr_decode PNG 往返");
	{
		const r = await dec.execute("t2", { image: globalThis.__qrPngPath }, undefined, undefined, ctx);
		check("C: 解码文本与原文一致", r.details?.text === TEXT);
		check("C: 结果含图片尺寸", /图片 \d+×\d+px/.test(r.content[0].text));
		check("C: 结果含二维码版本", /二维码版本 \d+/.test(r.content[0].text));
	}

	// ---- 场景 D：save=false 不落盘 ----
	console.log("场景 D：save=false 不落盘");
	{
		const r = await enc.execute("t3", { text: "no-save", save: false }, undefined, undefined, ctx);
		check("D: details 无 pngPath", r.details?.pngPath === undefined);
		check("D: 结果文本不含路径", !r.content[0].text.includes("PNG 已保存"));
	}

	// ---- 场景 E：pngWidth 越界钳制 ----
	console.log("场景 E：pngWidth 越界钳制");
	{
		const r = await enc.execute("t4", { text: "clamp", pngWidth: 9999 }, undefined, undefined, ctx);
		check("E: PNG 宽度钳制到 2048", pngWidth(readFileSync(r.details.pngPath)) === 2048);
		const r2 = await enc.execute("t5", { text: "clamp2", pngWidth: 10 }, undefined, undefined, ctx);
		check("E: PNG 宽度钳制到 128", pngWidth(readFileSync(r2.details.pngPath)) === 128);
	}

	// ---- 场景 F：JPEG 往返 ----
	console.log("场景 F：JPEG 往返");
	{
		const require2 = createRequire(import.meta.url);
		const { PNG } = require2("pngjs");
		const jpeg = require2("jpeg-js");
		const png = PNG.sync.read(readFileSync(globalThis.__qrPngPath));
		const jpg = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 90);
		const jpgPath = join(tmpdir(), `pi-qr-test-${Date.now()}.jpg`);
		writeFileSync(jpgPath, jpg.data);
		const r = await dec.execute("t6", { image: jpgPath }, undefined, undefined, ctx);
		check("F: JPEG 解码文本一致", r.details?.text === TEXT);
		rmSync(jpgPath, { force: true });
	}

	// ---- 场景 G：非图片输入 ----
	console.log("场景 G：非图片输入报错");
	{
		const txtPath = join(tmpdir(), `pi-qr-test-${Date.now()}.txt`);
		writeFileSync(txtPath, "not an image");
		const r = await dec.execute("t7", { image: txtPath }, undefined, undefined, ctx);
		check("G: 报错含「仅支持 PNG」", r.content[0].text.includes("仅支持 PNG"));
		check("G: 状态推送解码失败", captures.statuses["qr"].includes("失败"));
		rmSync(txtPath, { force: true });
	}

	// ---- 场景 H：无二维码图片 ----
	console.log("场景 H：无二维码图片报错");
	{
		const require2 = createRequire(import.meta.url);
		const { PNG } = require2("pngjs");
		const png = new PNG({ width: 240, height: 240 });
		for (let i = 0; i < png.data.length; i += 4) {
			png.data[i] = 255;
			png.data[i + 1] = 255;
			png.data[i + 2] = 255;
			png.data[i + 3] = 255;
		}
		const p = join(tmpdir(), `pi-qr-test-blank-${Date.now()}.png`);
		writeFileSync(p, PNG.sync.write(png));
		const r = await dec.execute("t8", { image: p }, undefined, undefined, ctx);
		check("H: 报错含「未找到二维码」", r.content[0].text.includes("未找到二维码"));
		rmSync(p, { force: true });
	}

	// ---- 场景 I：renderResult 失败路径 ----
	console.log("场景 I：renderResult 失败路径");
	{
		const errText = "解码二维码失败：图中未找到二维码";
		const comp = dec.renderResult(
			{ content: [{ type: "text", text: errText }], details: { error: errText } },
			{},
			themeMock,
			{ isError: true, args: {} },
		);
		const text = comp.render(TERM_COLS).map(stripAnsi).join("");
		check("I: 失败显示 ✗ 与真实原因", text.includes("✗") && text.includes("未找到二维码"));
	}

	// ---- 场景 J：文本超容量 ----
	console.log("场景 J：文本超容量报错");
	{
		const r = await enc.execute("t9", { text: "a".repeat(3000), ecc: "H" }, undefined, undefined, ctx);
		check("J: 报错含「失败」", r.content[0].text.includes("失败"));
		check("J: 提示换纠错级别或精简文本", r.content[0].text.includes("ecc") || r.content[0].text.includes("精简"));
	}

	// ---- 场景 K：/qr 命令 ----
	console.log("场景 K：/qr 命令弹出显示组件");
	{
		const handler = pi.commands["qr"].handler;
		const caps2 = makeCaptures();
		const ctx2 = makeCtx(caps2);
		const p = handler(` Hello QR `, ctx2);
		await new Promise((r) => setTimeout(r, 20));
		check("K: custom 组件已弹出", caps2.customs.length === 1);
		let resolved = false;
		const done = () => {
			resolved = true;
			caps2.customs[0].resolve();
		};
		const comp = caps2.customs[0].factory(makeTui(), themeMock, {}, done);
		const lines = comp.render(TERM_COLS);
		check("K: 标题含原文", lines[0].includes("Hello QR"));
		check("K: 含二维码半块行", lines.some((l) => l.includes("▀")));
		check("K: 含关闭提示", lines[lines.length - 1].includes("按任意键关闭"));
		comp.handleInput("\x1b");
		await p;
		check("K: 任意键关闭", resolved);
	}

	// ---- 场景 L：/qr 无参数 ----
	console.log("场景 L：/qr 无参数提示用法");
	{
		const caps2 = makeCaptures();
		await pi.commands["qr"].handler("", makeCtx(caps2));
		check("L: notify 提示用法", caps2.notifies.some((n) => n.text.includes("用法：/qr")));
		check("L: 未弹组件", caps2.customs.length === 0);
	}

	// 清理：TTL 定时器 + 测试产物
	pi.events["session_shutdown"]?.({}, makeCtx(makeCaptures()));
	rmSync(globalThis.__qrPngPath, { force: true });
	rmSync(BUNDLE, { force: true });

	console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
