#!/usr/bin/env node
/**
 * computer-use 扩展回归测试
 *
 * 原理：esbuild 把纯逻辑模块 bundle 成单文件 ESM 再 import（与 build.js 同口径）。
 * 只测不碰真实桌面的部分——所有动作/截图/UIA 都依赖真实系统状态，属于联调范畴
 * （见文件末尾的联调说明），进 CI 会变成一堆无法复现的"偶尔失败"。
 *
 * 覆盖的是最容易静默出错、且出错后表现为"点偏/漏元素/假装成功"的那几块：
 * - 预处理：边长必须是 32 的倍数、等比不拉伸、坐标映射回屏幕
 * - 合并：UIA 优先、视觉只在 UIA 未覆盖处补空、编号连续
 * - 验证：全屏差分能检出"大画面里只改一行"，单块抖动被门槛压掉，
 *   限定窗口范围时不被全屏稀释、窗口外变化不计入
 * - 输入通道：含非 ASCII 时不走 SendInput、UIA 失败降级剪贴板、剪贴板也失败才报错；
 *   UIA 设值后渲染层无变化时必须继续降级（Edge 会静默接受写入却不渲染）
 * - 焦点窗口：句柄判等、失配警示（焦点被抢走时必须明说）、锁屏判定
 * - 宿主输出编码：中文/emoji 字段走 Base64 回传（stdout 直传会损坏成 U+FFFD）
 * - 元素表：格式化输出含编号/坐标/只读标记，超长名字截断
 *
 * 用法：node src/extensions/computer-use/test/computer-use.test.mjs（仓库根执行）
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const EXT_DIR = join(TEST_DIR, "..");
const SRC_DIR = join(TEST_DIR, "..", "..", "..");
const BUNDLE_DIR = join(TEST_DIR, ".tmp-bundle");

let failures = 0;
const check = (name, cond, extra) => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `（${extra}）` : ""}`);
		failures++;
	}
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// 构建待测模块
// ---------------------------------------------------------------------------

async function bundle() {
	const entries = {
		preprocess: join(EXT_DIR, "model", "preprocess.ts"),
		detector: join(EXT_DIR, "model", "detector.ts"),
		elements: join(EXT_DIR, "elements.ts"),
		verify: join(EXT_DIR, "verify.ts"),
		typing: join(EXT_DIR, "typing.ts"),
		focus: join(EXT_DIR, "focus.ts"),
	};
	const out = {};
	for (const [name, src] of Object.entries(entries)) {
		const file = join(BUNDLE_DIR, `${name}.mjs`);
		await build({
			entryPoints: [src],
			outfile: file,
			bundle: true,
			format: "esm",
			platform: "node",
			// onnxruntime-node 只能在真实安装处加载；typing 的动态 import 也留外部
			external: ["@earendil-works/*", "typebox", "onnxruntime-node", "pngjs", "node:child_process"],
			tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
			target: "es2022",
			logLevel: "silent",
		});
		out[name] = await import(pathToFileURL(file).href);
	}
	return out;
}

// 造一张纯色 PNG，模拟截图
function makePng(path, w, h, rgb = [20, 20, 20]) {
	const png = new PNG({ width: w, height: h });
	for (let i = 0; i < w * h; i++) {
		png.data[i * 4] = rgb[0];
		png.data[i * 4 + 1] = rgb[1];
		png.data[i * 4 + 2] = rgb[2];
		png.data[i * 4 + 3] = 255;
	}
	writeFileSync(path, PNG.sync.write(png));
}

/** 造一张带一块亮色矩形的 PNG（用于验证"画面变了"） */
function makePngWithRect(path, w, h, rect) {
	const png = new PNG({ width: w, height: h });
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
			const v = inside ? 240 : 20;
			png.data[i] = v;
			png.data[i + 1] = v;
			png.data[i + 2] = v;
			png.data[i + 3] = 255;
		}
	}
	writeFileSync(path, PNG.sync.write(png));
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

async function main() {
	console.log("computer-use 回归测试\n");
	const mod = await bundle();
	const { planInputSize, mapBox, prepareInput, MODEL_STRIDE, MODEL_LONG_EDGE } = mod.preprocess;
	const { mergeElements, formatElements, findByIndex } = mod.elements;
	const { diffFrames, diffGrids, readFrame, MIN_CHANGED_BLOCKS } = mod.verify;
	const { typeText } = mod.typing;
	const { toWindowRef, describeWindow, sameWindow, focusNote, isDesktopUnavailable } = mod.focus;

	const tmp = mkdtempSync(join(tmpdir(), "cu-test-"));

	// -----------------------------------------------------------------------
	console.log("[1] 预处理：尺寸规划");
	{
		// 16:10 屏幕 → 最长边 640，绘制区 640x400，补齐到 32 的倍数
		const p = planInputSize(2560, 1600);
		check("绘制宽 = 最长边（默认 1024）", p.drawnW === MODEL_LONG_EDGE, `实际 ${p.drawnW}`);
		check("绘制高按比例（16:10 → 640）", p.drawnH === 640, `实际 ${p.drawnH}`);
		check("张量宽是 32 的倍数", p.w % MODEL_STRIDE === 0, `实际 ${p.w}`);
		check("张量高是 32 的倍数", p.h % MODEL_STRIDE === 0, `实际 ${p.h}`);
		check("张量高 >= 绘制高（补齐不裁剪）", p.h >= p.drawnH, `张量 ${p.h} vs 绘制 ${p.drawnH}`);
		check("缩放比 = 2.5（2560/1024）", near(p.scale, 2.5, 0.01), `实际 ${p.scale}`);

		// 竖屏：宽小于高时应以高为最长边
		const q = planInputSize(1080, 1920);
		check("竖屏：绘制高 = 最长边", q.drawnH === MODEL_LONG_EDGE, `实际 ${q.drawnH}`);
		check("竖屏：绘制宽按比例（9:16 → 576）", q.drawnW === 576, `实际 ${q.drawnW}`);
		check("竖屏：张量宽是 32 的倍数", q.w % MODEL_STRIDE === 0, `实际 ${q.w}`);

		// 极端窄条不该产出 0 尺寸
		const r = planInputSize(4000, 100);
		check("窄条：绘制高至少 32", r.drawnH >= MODEL_STRIDE, `实际 ${r.drawnH}`);
	}

	// -----------------------------------------------------------------------
	console.log("[2] 预处理：坐标映射回屏幕");
	{
		const input = { scale: 4, srcW: 2560, srcH: 1600 };
		const b = mapBox({ x: 100, y: 50, w: 40, h: 20 }, input);
		check("x 乘缩放比", b.x === 400, `实际 ${b.x}`);
		check("y 乘缩放比", b.y === 200, `实际 ${b.y}`);
		check("宽乘缩放比", b.w === 160, `实际 ${b.w}`);

		// 越界框夹回屏幕内（模型偶尔会在黑边上给框）
		const edge = mapBox({ x: 620, y: 390, w: 100, h: 100 }, input);
		check("越界框不超出右边界", edge.x + edge.w <= input.srcW, `${edge.x}+${edge.w} > ${input.srcW}`);
		check("越界框不超出下边界", edge.y + edge.h <= input.srcH, `${edge.y}+${edge.h} > ${input.srcH}`);
		check("负坐标夹到 0", mapBox({ x: -50, y: -50, w: 10, h: 10 }, input).x === 0);
	}

	// -----------------------------------------------------------------------
	console.log("[3] 预处理：真实 PNG → 张量");
	{
		const shot = join(tmp, "shot.png");
		makePng(shot, 2560, 1600, [128, 64, 32]);
		const input = prepareInput(shot);
		check("张量长度 = 3*W*H", input.tensor.length === 3 * input.w * input.h, `实际 ${input.tensor.length}`);
		check("张量尺寸对齐 32", input.w % 32 === 0 && input.h % 32 === 0, `${input.w}x${input.h}`);
		check("源尺寸保留为物理像素", input.srcW === 2560 && input.srcH === 1600, `${input.srcW}x${input.srcH}`);
		// 值域 0..1：纯色的三个通道都应接近 128/255、64/255、32/255
		const n = input.w * input.h;
		check("R 通道归一化", near(input.tensor[0], 128 / 255, 0.02), `实际 ${input.tensor[0]}`);
		check("G 通道归一化", near(input.tensor[n], 64 / 255, 0.02), `实际 ${input.tensor[n]}`);
		check("B 通道归一化", near(input.tensor[2 * n], 32 / 255, 0.02), `实际 ${input.tensor[2 * n]}`);
		// 黑边区域必须是 0（右下角补齐部分）。16:10 在 1024 长边下 drawnH=640
		// 恰好是 32 的倍数，没有黑边；换成会留黑边的尺寸来验证补齐逻辑。
		const oddShot = join(tmp, "odd.png");
		makePng(oddShot, 2560, 1500, [200, 100, 50]);  // 15:8.79，缩后高度非 32 倍数
		const oddInput = prepareInput(oddShot);
		check("非整倍数尺寸会留黑边", oddInput.h > oddInput.drawnH, `张量高 ${oddInput.h} vs 绘制高 ${oddInput.drawnH}`);
		const padIdx = (oddInput.h - 1) * oddInput.w + (oddInput.w - 1);
		check("补齐区为黑（0）", oddInput.tensor[padIdx] === 0, `实际 ${oddInput.tensor[padIdx]}`);
	}

	// -----------------------------------------------------------------------
	console.log("[4] 元素合并：UIA 优先、视觉补空");
	{
		const screen = { w: 2560, h: 1600 };
		const uia = [
			{ name: "确定", type: "Button", x: 100, y: 100, w: 80, h: 40, enabled: true, interactive: true },
			{ name: "整窗容器", type: "Pane", x: 0, y: 0, w: 2560, h: 1600, enabled: true, interactive: false },
			{ name: "", type: "Image", x: 300, y: 300, w: 20, h: 20, enabled: true, interactive: false },
		];
		const vision = [
			// 中心落在"确定"按钮内 → 应被 UIA 吸收，不单独成条
			{ x: 110, y: 105, w: 60, h: 30, conf: 0.9 },
			// 中心在大容器内但在空区域 → 应保留为独立视觉元素
			{ x: 1000, y: 800, w: 50, h: 30, conf: 0.8 },
		];
		const els = mergeElements(uia, vision, screen);
		check("大容器被排除（整窗 Pane 不占位）", !els.some((e) => e.name === "整窗容器"));
		check("匿名不可交互元素被排除", !els.some((e) => e.type === "Image"));
		check("UIA 按钮在表内", els.some((e) => e.name === "确定" && e.source === "uia"));
		check("被 UIA 覆盖的视觉框不重复出现", els.filter((e) => e.conf === 0.9).length === 0);
		check("UIA 盲区的视觉框保留", els.some((e) => e.source === "vision" && e.conf === 0.8));
		check("编号从 1 开始且连续", els.every((e, i) => e.idx === i + 1), els.map((e) => e.idx).join(","));
		check("中心点 = 框中心", els.find((e) => e.name === "确定").cx === 140);
		check("按编号能取回元素", findByIndex(els, 1)?.idx === 1);
		check("取不存在的编号返回 undefined", findByIndex(els, 999) === undefined);

		// 只有一个视觉框且没有 UIA 时也要能成表
		const onlyVision = mergeElements([], [{ x: 10, y: 10, w: 30, h: 30, conf: 0.5 }], screen);
		check("仅视觉通道也能出元素", onlyVision.length === 1 && onlyVision[0].source === "vision");
	}

	// -----------------------------------------------------------------------
	console.log("[5] 元素表格式化");
	{
		const els = [
			{ idx: 1, source: "uia", type: "Button", name: "确定", x: 0, y: 0, w: 80, h: 40, cx: 40, cy: 20, interactive: true },
			{ idx: 2, source: "uia", type: "Text", name: "一段很长很长很长很长很长很长很长很长的标题文本", x: 0, y: 0, w: 80, h: 40, cx: 40, cy: 20, interactive: false },
			{ idx: 3, source: "vision", type: "Visual", name: "", x: 0, y: 0, w: 10, h: 10, cx: 5, cy: 5, interactive: true, conf: 0.42 },
		];
		const text = formatElements(els);
		check("含编号与坐标", text.includes("1.") && text.includes("@(40,20)"), text.slice(0, 80));
		check("不可交互标为只读", text.includes("（只读）"));
		check("视觉元素带置信度", text.includes("conf=0.42"));
		check("超长名字被截断", text.split("\n")[1].length < 60, `第 2 行长度 ${text.split("\n")[1].length}`);
		check("空表给出明确提示", formatElements([]).includes("没有找到"));
	}

	// -----------------------------------------------------------------------
	console.log("[6] 动作后验证：全屏差分定位变化区");
	{
		// 关键回归：大画面里只有一小块变了，旧的平均法会稀释成"没变"。
		// 这里造一张 2560x1600 的图，只改其中一行（模拟输入进记事本的那一行文字）。
		const W = 2560, H = 1600;
		const base = join(tmp, "f1.png");
		const sameShot = join(tmp, "f2.png");
		const oneLine = join(tmp, "f3.png");
		makePng(base, W, H, [20, 20, 20]);
		makePng(sameShot, W, H, [20, 20, 20]);
		makePngWithRect(oneLine, W, H, { x: 100, y: 1200, w: 600, h: 40 });

		const f0 = readFrame(base);
		const fSame = readFrame(sameShot);
		const fOne = readFrame(oneLine);

		const noChange = diffFrames(f0, fSame);
		check("同画面 changed=false", noChange.changed === false, noChange.summary);
		check("同画面变化块为 0", noChange.changedBlocks === 0);
		check("同画面结论提示可能未生效", noChange.summary.includes("没有可辨变化"), noChange.summary);

		const lineChange = diffFrames(f0, fOne);
		check("只改一行也被判定为有变化（旧实现会漏）", lineChange.changed === true, lineChange.summary);
		check("变化块数达到门槛", lineChange.changedBlocks >= MIN_CHANGED_BLOCKS, `实际 ${lineChange.changedBlocks}`);
		check("变化比例很小（不是整屏都在变）", lineChange.changedRatio < 0.05, `实际 ${(lineChange.changedRatio * 100).toFixed(2)}%`);
		check("给出了变化区包围盒", lineChange.region !== null, String(lineChange.region));
		if (lineChange.region) {
			const r = lineChange.region;
			check("变化区覆盖到被改的那一行", r.y <= 1240 && r.y + r.h >= 1200, `区 ${r.y}..${r.y + r.h} vs 行 1200..1240`);
			check("变化区不夸张地铺满全屏", r.w < W * 0.6, `宽 ${r.w}`);
		}

		// 单块变化（光标闪烁那种）不该被判为有变化
		const tiny = join(tmp, "f4.png");
		makePngWithRect(tiny, W, H, { x: 10, y: 10, w: 8, h: 8 });
		const tinyDiff = diffFrames(f0, readFrame(tiny));
		check("单块微小变化被门槛压掉", tinyDiff.changed === false, tinyDiff.summary);

		// 尺寸变化必须被识别出来（换分辨率/改缩放）
		const other = join(tmp, "f5.png");
		makePng(other, 800, 600, [20, 20, 20]);
		const sizeDiff = diffFrames(f0, readFrame(other));
		check("尺寸不一致时明确说明", sizeDiff.summary.includes("尺寸"), sizeDiff.summary);
	}

	// -----------------------------------------------------------------------
	console.log("[7] 文本输入通道降级");
	{
		// 造一个假平台，按调用情况返回/抛错，验证降级顺序
		const makeFake = (opts) => {
			const calls = [];
			return {
				calls,
				platform: {
					name: "fake",
					async start() {},
					async stop() {},
					async bounds() {
						return { x: 0, y: 0, w: 100, h: 100, dpi: "x" };
					},
					async capture() {
						return { path: "", w: 100, h: 100, capMs: 0, ms: 0 };
					},
					async uia() {
						return { title: "", cls: "", proc: 0, rect: { x: 0, y: 0, w: 100, h: 100 }, count: 0, items: [], ms: 0 };
					},
					async move() {
						return { via: "mouse" };
					},
					async click() {
						return { via: "mouse" };
					},
					async drag() {
						return { via: "mouse" };
					},
					async scroll() {
						return { via: "mouse" };
					},
					async key(keys) {
						calls.push(["key", keys.join("+")]);
						return { via: "sendinput" };
					},
					async typeAscii(text) {
						calls.push(["typeAscii", text]);
						return { via: "sendinput" };
					},
					async setValue(x, y, v) {
						calls.push(["setValue", v]);
						if (opts.uiaFails) throw new Error("不支持 ValuePattern");
						return { via: "uia-value", target: "编辑框" };
					},
					...(opts.hasClipboard === false
						? {}
						: {
								async setClipboard(t) {
									calls.push(["setClipboard", t]);
									if (opts.clipboardFails) throw new Error("剪贴板忙");
								},
							}),
				},
			};
		};

		// 7.1 UIA 可用 → 走 UIA，不再碰剪贴板与键盘
		{
			const f = makeFake({});
			const out = await typeText(f.platform, "你好世界", { x: 10, y: 10 });
			check("UIA 可用时走 uia-value", out.via === "uia-value", out.via);
			check("UIA 成功时不写剪贴板", !f.calls.some((c) => c[0] === "setClipboard"));
		}

		// 7.2 UIA 失败 → 剪贴板 + Ctrl+V
		{
			const f = makeFake({ uiaFails: true });
			const out = await typeText(f.platform, "含中文的文本", { x: 10, y: 10 });
			check("UIA 失败时降级到剪贴板", out.via === "clipboard", out.via);
			check("剪贴板通道写了文本", f.calls.some((c) => c[0] === "setClipboard" && c[1] === "含中文的文本"));
			check("剪贴板通道发了 Ctrl+V", f.calls.some((c) => c[0] === "key" && c[1] === "ctrl+v"));
			check("降级过程有记录", out.notes.some((n) => n.includes("UIA")), out.notes.join("；"));
		}

		// 7.3 含非 ASCII 且前两级都不可用 → 直接失败，不能用 SendInput 糊过去
		{
			const f = makeFake({ uiaFails: true, clipboardFails: true });
			let err = "";
			try {
				await typeText(f.platform, "中文", { x: 10, y: 10 });
			} catch (e) {
				err = e.message;
			}
			check("非 ASCII 且无可靠通道时报错", err.length > 0, err);
			check("报错说明输入法原因", err.includes("输入法") || err.includes("ASCII"), err);
			check("非 ASCII 未走 SendInput", !f.calls.some((c) => c[0] === "typeAscii"));
		}

		// 7.4 纯 ASCII 且前两级都不可用 → 允许 SendInput 兜底
		{
			const f = makeFake({ uiaFails: true, clipboardFails: true });
			const out = await typeText(f.platform, "hello", { x: 10, y: 10 });
			check("纯 ASCII 可降级到 SendInput", out.via === "sendinput", out.via);
			check("SendInput 收到了文本", f.calls.some((c) => c[0] === "typeAscii" && c[1] === "hello"));
		}

		// 7.5 没给坐标 → 跳过 UIA，直接剪贴板
		{
			const f = makeFake({});
			const out = await typeText(f.platform, "abc");
			check("无坐标时跳过 UIA", out.via === "clipboard", out.via);
			check("无坐标时未调用 setValue", !f.calls.some((c) => c[0] === "setValue"));
		}
	}

	// -----------------------------------------------------------------------
	console.log("[8] 焦点窗口：识别与失配提示");
	{
		const a = toWindowRef({ hwnd: "100", proc: "Notepad", title: "无标题 - 记事本", rect: { x: 1, y: 2, w: 800, h: 600 } });
		const b = toWindowRef({ hwnd: "100", proc: "Notepad", title: "已改名 - 记事本", rect: { x: 1, y: 2, w: 800, h: 600 } });
		const c = toWindowRef({ hwnd: "200", proc: "pi", title: "pi", rect: { x: 0, y: 0, w: 100, h: 100 } });

		check("解析出窗口身份", a !== null && a.hwnd === "100" && a.proc === "Notepad");
		check("缺 hwnd 时返回 null", toWindowRef({}) === null);
		check("标题变了但句柄相同 → 同一窗口", sameWindow(a, b) === true);
		check("句柄不同 → 不同窗口", sameWindow(a, c) === false);
		check("null 不崩溃且判为不同", sameWindow(a, null) === false && sameWindow(null, null) === false);

		check("可读描述含进程名与标题", describeWindow(a).includes("Notepad") && describeWindow(a).includes("记事本"), describeWindow(a));
		check("空标题有兜底", describeWindow(toWindowRef({ hwnd: "1", proc: "X", title: "" })).includes("无标题"));
		check("读不到窗口时明说", describeWindow(null).includes("无法读取"));

		// 这是本轮最关键的一条：焦点被抢走后必须明确警示
		const noted = focusNote(c, a);
		check("失配时警示「不是感知时的窗口」", noted.includes("不是感知时的窗口"), noted);
		check("失配时同时给出实际窗口与预期窗口", noted.includes("pi") && noted.includes("Notepad"), noted);
		check("一致时不啰嗦，只标一致", focusNote(a, b).includes("与感知时一致"), focusNote(a, b));
		check("没有感知基线时不报失配", !focusNote(a, null).includes("不是感知时"), focusNote(a, null));

		// 锁屏/安全桌面：动作必须被拒，不能假装成功
		check("hwnd=0 判为不可操作", isDesktopUnavailable(toWindowRef({ hwnd: "0", proc: "Idle", title: "" })) === true);
		check("Idle 进程判为不可操作", isDesktopUnavailable(toWindowRef({ hwnd: "9", proc: "Idle", title: "" })) === true);
		check("LockApp 判为不可操作", isDesktopUnavailable(toWindowRef({ hwnd: "9", proc: "LockApp", title: "W" })) === true);
		check("LogonUI 判为不可操作", isDesktopUnavailable(toWindowRef({ hwnd: "9", proc: "LogonUI", title: "" })) === true);
		check("正常窗口判为可操作", isDesktopUnavailable(a) === false);
		check("读不到窗口时判为不可操作", isDesktopUnavailable(null) === true);
	}

	// -----------------------------------------------------------------------
	console.log("[9] 宿主输出编码：中文/emoji 字段不得损坏");
	{
		// 实测：经 stdout 直传含非 ASCII 的字符串会被控制台代码页破坏成 U+FFFD
		// （"⠸ ⌨️ bash — my_pi" → "?? ?? bash �� my_pi"），而转 Base64 传输完好。
		// 这里锁定「解码后的字符串与原始一致」，防止有人把 Base64 改回直传。
		const { execFileSync } = await import("node:child_process");
		const sample = "⠸ ⌨️ bash — my_pi 中文标题";
		const b64 = Buffer.from(sample, "utf8").toString("base64");
		const decoded = Buffer.from(b64, "base64").toString("utf8");
		check("Base64 往返无损（含 emoji 与中文）", decoded === sample, JSON.stringify(decoded));
		check("往返后码点无替换字符", !decoded.includes("�"), decoded);

		// 宿主脚本里这三个字段必须以 Base64 形式回传
		const script = (await import("node:fs")).readFileSync(join(EXT_DIR, "platform", "win32-host.ps1"), "utf8");
		check("focus 回传 titleB64", script.includes("titleB64"));
		check("uia 元素回传 nameB64", script.includes("nameB64"));
		check("GetWindowTextW 声明了 CharSet.Unicode", /GetWindowTextW[^;]*CharSets*=s*CharSet.Unicode|CharSets*=s*CharSet.Unicode[^;]*GetWindowTextW/.test(script) || script.includes("CharSet = CharSet.Unicode)] static extern int GetWindowTextW"));
	}

	// -----------------------------------------------------------------------
	console.log("[10] 焦点归还：切换失败与成功的判定");
	{
		// 这条锁定"以切完实际读到的窗口为准"的逻辑。判据不能信 activate 的即时返回值：
		// 系统完成前台切换有延迟，实测会误报"切回失败"。
		const a = toWindowRef({ hwnd: "100", proc: "msedge", title: "网页", rect: { x: 0, y: 0, w: 800, h: 600 } });
		const same = toWindowRef({ hwnd: "100", proc: "msedge", title: "换了个标题", rect: { x: 0, y: 0, w: 800, h: 600 } });
		const other = toWindowRef({ hwnd: "200", proc: "pi", title: "pi", rect: { x: 0, y: 0, w: 100, h: 100 } });
		check("切完读回同一窗口 → 判为成功", sameWindow(same, a) === true);
		check("切完仍在别的窗口 → 判为失败", sameWindow(other, a) === false);
		check("切回成功时不再报失配", !focusNote(a, a).includes("不是感知时"), focusNote(a, a));
		check("切换失败时明确说是哪个窗口在生效", focusNote(other, a).includes("pi") && focusNote(other, a).includes("msedge"), focusNote(other, a));
	}

	// -----------------------------------------------------------------------
	console.log("[11] UIA 设值：控件接受但未渲染时必须继续降级");
	{
		// 实测 Edge 网页输入框：ValuePattern.SetValue 不抛异常、Current.Value 也读得到新值，
		// 但页面上输入框仍是空的。只信控件读回会把"假成功"报给 AI。
		const makeFake = (renderChanged) => {
			const calls = [];
			return {
				calls,
				platform: {
					name: "fake", async start() {}, async stop() {},
					async bounds() { return { x: 0, y: 0, w: 100, h: 100, dpi: "x" }; },
					async focus() { return { hwnd: "1", proc: "x", title: "", rect: { x: 0, y: 0, w: 1, h: 1 } }; },
					async capture() { return { path: "", w: 100, h: 100, capMs: 0, ms: 0 }; },
					async uia() { return { title: "", cls: "", proc: 0, rect: { x: 0, y: 0, w: 100, h: 100 }, count: 0, items: [], ms: 0 }; },
					async move() { return { via: "mouse" }; },
					async click() { return { via: "mouse" }; },
					async drag() { return { via: "mouse" }; },
					async scroll() { return { via: "mouse" }; },
					async key(keys) { calls.push(["key", keys.join("+")]); return { via: "sendinput" }; },
					async typeAscii(t) { calls.push(["typeAscii", t]); return { via: "sendinput" }; },
					async setValue(x, y, v) { calls.push(["setValue", v]); return { via: "uia-value", target: "输入框" }; },
					async setClipboard(t) { calls.push(["setClipboard", t]); },
				},
			};
		};

		// 11.1 渲染层没变 → 不能报 uia-value，必须继续走剪贴板
		{
			const f = makeFake(false);
			let confirmed = 0;
			const out = await typeText(f.platform, "听力", { x: 1, y: 1 }, {
				confirmRender: async () => { confirmed++; return false; },
			});
			check("调用了渲染确认", confirmed === 1);
			check("渲染未变时不报 uia-value", out.via !== "uia-value", out.via);
			check("渲染未变时降级到剪贴板", out.via === "clipboard", out.via);
			check("降级原因写进 notes", out.notes.some((n) => n.includes("画面无变化")), out.notes.join("；"));
		}

		// 11.2 渲染层确实变了 → 采信 UIA，不再走剪贴板
		{
			const f = makeFake(true);
			const out = await typeText(f.platform, "abc", { x: 1, y: 1 }, { confirmRender: async () => true });
			check("渲染确认通过时采信 uia-value", out.via === "uia-value", out.via);
			check("渲染确认通过时不碰剪贴板", !f.calls.some((c) => c[0] === "setClipboard"));
		}

		// 11.3 宿主侧读回不匹配（抛错）→ 同样降级
		{
			const f = makeFake(true);
			f.platform.setValue = async () => { throw new Error("控件未接受该值（读回不匹配）"); };
			const out = await typeText(f.platform, "abc", { x: 1, y: 1 }, { confirmRender: async () => true });
			check("读回不匹配时降级", out.via === "clipboard", out.via);
			check("读回不匹配原因入 notes", out.notes.some((n) => n.includes("读回不匹配")), out.notes.join("；"));
		}

		// 11.4 没有渲染确认回调时保持原行为（不引入回归）
		{
			const f = makeFake(true);
			const out = await typeText(f.platform, "abc", { x: 1, y: 1 });
			check("未提供 confirmRender 时沿用 UIA 结果", out.via === "uia-value", out.via);
		}
	}

	// -----------------------------------------------------------------------
	console.log("[12] codemode 适配：需人工确认的工具不能在脚本里阻塞");
	{
		// 实测：在 codemode 里调 cu_activate，确认框无人响应时会一直挂着
		// （112 秒直到脚本超时）。按仓库约定，需人工交互的工具在脚本里先拒绝。
		const { isCodemodeCall } = await import(join(SRC_DIR, "extensions", "shared", "codemode.ts").replace(/.ts$/, ".ts"))
			.catch(() => ({}));
		if (typeof isCodemodeCall === "function") {
			check("直接调用（单段 id）不算 codemode", isCodemodeCall("call_abc") === false);
			check("脚本内嵌套调用（含斜杠）算 codemode", isCodemodeCall("call_abc/1") === true);
			check("undefined 不算 codemode", isCodemodeCall(undefined) === false);
		} else {
			// 测试环境直接 import .ts 不可用时退化为源码断言
			const src = (await import("node:fs")).readFileSync(join(EXT_DIR, "index.ts"), "utf8");
			check("cu_activate 有 codemode 守卫", src.includes("isCodemodeCall(callId)"));
			check("守卫只在未激活时触发", src.includes("!activated && isCodemodeCall(callId)"));
		}
	}

	// -----------------------------------------------------------------------
	console.log("[13] 差分范围：窗口内统计，不被全屏稀释");
	{
		// 实测：记事本窗口 1920x1118 占全屏 2560x1600 一半，滚动 3 格时
		// 全屏统计的变化块数不到门槛 -> 误报"画面没变"。限定窗口范围后才判对。
		const W = 2560, H = 1600;
		const base = join(tmp, "s1.png");
		const same = join(tmp, "s2.png");
		const rolled = join(tmp, "s3.png");
		makePng(base, W, H, [20, 20, 20]);
		makePng(same, W, H, [20, 20, 20]);
		// 只有窗口内一小块变了（模拟滚动），窗口外完全没变
		makePngWithRect(rolled, W, H, { x: 300, y: 400, w: 400, h: 120 });

		const f0 = readFrame(base);
		const fRolled = readFrame(rolled);
		const win = { x: 196, y: 316, w: 1920, h: 1118 };

		const noScope = diffFrames(f0, fRolled);
		const withScope = diffFrames(f0, fRolled, win);

		check("不给范围时也能检出变化", noScope.changed === true, noScope.summary);
		check("给范围时同样检出", withScope.changed === true, withScope.summary);
		check("范围统计的块数不多于全屏", withScope.changedBlocks <= noScope.changedBlocks,
			`范围 ${withScope.changedBlocks} vs 全屏 ${noScope.changedBlocks}`);
		check("范围结论注明限定在窗口内", withScope.summary.includes("目标窗口"), withScope.summary);

		// 窗口范围内无变化、窗口外有变化 -> 限定范围时应判为没变
		const outside = join(tmp, "s4.png");
		makePngWithRect(outside, W, H, { x: 2300, y: 1400, w: 200, h: 150 });
		const fOutside = readFrame(outside);
		const outsideNoScope = diffFrames(f0, fOutside);
		const outsideScoped = diffFrames(f0, fOutside, win);
		check("窗口外变化：全屏统计能检出", outsideNoScope.changed === true, outsideNoScope.summary);
		check("窗口外变化：窗口内统计判为没变", outsideScoped.changed === false, outsideScoped.summary);

		// 越界的范围要被裁到画面内，不能崩
		const crazy = diffFrames(f0, fRolled, { x: -500, y: -500, w: 99999, h: 99999 });
		check("越界范围不崩且能检出", crazy.changed === true, crazy.summary);
	}

	// -----------------------------------------------------------------------
	console.log("[14] 视觉框裁剪：只保留焦点窗口内的");
	{
		// 实测：纸牌窗口只占屏幕左上角，视觉检测跑全屏会把右侧终端的控件
		// 也算进"纸牌的元素表"。这里锁定裁剪行为。
		const win = { x: 100, y: 100, w: 800, h: 600 };
		const dets = [
			{ x: 150, y: 150, w: 100, h: 50, conf: 0.9 }, // 完全在窗口内
			{ x: 950, y: 150, w: 100, h: 50, conf: 0.9 }, // 完全在窗口外（中心 1000 > 右边界 900）
			{ x: 50, y: 50, w: 100, h: 100, conf: 0.9 },  // 跨窗口左上边界，中心在 (100,100) 边界上
			{ x: 400, y: 400, w: 100, h: 50, conf: 0.9 }, // 窗口内偏右下
		];
		// 与 index.ts 的 clipDetections 同逻辑
		const clip = (items, r) => items.filter((d) => {
			const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
			return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
		});
		const kept = clip(dets, win);
		check("窗口外的视觉框被丢弃", !kept.some((d) => d.x === 950), String(kept.length));
		check("窗口内的视觉框保留", kept.some((d) => d.x === 150));
		check("右下角窗口内的保留", kept.some((d) => d.x === 400));
		check("跨边界的按中心点判定（中心在边界上算在内）", kept.some((d) => d.x === 50), "中心 (100,100) 恰在窗口左上角");
		check("裁剪后数量正确", kept.length === 3, `实际 ${kept.length}`);
	}

	// -----------------------------------------------------------------------
	console.log("[15] 目标窗口消失后必须拒绝动作");
	{
		// 实测：感知的窗口被关掉后，动作应被拒绝——落在错误窗口上的点击
		// 可能是在聊天框里发出消息、在删除确认框上点"是"。
		// 判据是"句柄还在不在枚举结果里"，不是"进程是否存活"：
		// 一个进程常开多个窗口，关掉其中一个时进程仍活着。
		const src = (await import("node:fs")).readFileSync(join(EXT_DIR, "index.ts"), "utf8");
		check("有 windowAlive 判据", src.includes("async function windowAlive"));
		check("按句柄枚举结果判断存在性", /return list\.some\(\(w\) => w\.hwnd === hwnd\)/.test(src), "应比对 hwnd");
		check("目标不存在时返回拒绝", src.includes("已不存在（可能被关闭了）"));
		check("拒绝文案给出下一步", src.includes("请重新用 cu_windows(choose=N) 选定目标"));
		// 反向断言：不能按 pid 判活（同进程多窗口会误判）
		check("没有按 pid 判活的逻辑", !src.includes("processExistsById"));
	}

	// -----------------------------------------------------------------------
	console.log("[16] 块网格差分：与 PNG 差分同结论");
	{
		// 网格由宿主按同一算法（32px 块 / 4×4 采样 / BT.601）产出，
		// 两条路必须给出同样的判断，否则"动作画面差分数值变了"会引发误判。
		const mkGrid = (w, h, fill) => {
			const cols = Math.ceil(w / 32);
			const rows = Math.ceil(h / 32);
			const cells = new Float32Array(cols * rows).fill(fill);
			return { w, h, cols, rows, cells };
		};
		const W = 2560, H = 1600;

		const base = mkGrid(W, H, 20);
		const same = mkGrid(W, H, 20);
		const noChange = diffGrids(base, same);
		check("网格：同画面判为未变", noChange.changed === false, noChange.summary);

		// 只在某一行区域改变若干块（模拟输入一行文字）
		const lined = mkGrid(W, H, 20);
		const cols = lined.cols;
		for (let bx = 3; bx < 20; bx++) lined.cells[6 * cols + bx] = 240;
		const lineDiff = diffGrids(base, lined);
		check("网格：局部变化被检出（不被大面积稀释）", lineDiff.changed === true, lineDiff.summary);
		check("网格：给出变化区包围盒", lineDiff.region !== null, String(lineDiff.region));
		check("网格：变化比例很小", lineDiff.changedRatio < 0.05, `${(lineDiff.changedRatio * 100).toFixed(2)}%`);

		// 单块变化不算（对应光标闪烁）
		const one = mkGrid(W, H, 20);
		one.cells[5] = 240;
		check("网格：单块抖动被门槛压掉", diffGrids(base, one).changed === false);

		// 限定窗口范围
		const scoped = diffGrids(base, lined, { x: 0, y: 1000, w: 800, h: 400 });
		check("网格：范围外的变化不计入", scoped.changed === false, scoped.summary);

		// 尺寸变化要明确说明
		check("网格：尺寸不一致时说明原因", diffGrids(base, mkGrid(800, 600, 20)).summary.includes("尺寸"));

		// 与 PNG 路径对照：同一画面两条路的结论必须一致
		const samePng = diffFrames(readFrame(join(tmp, "f1.png")), readFrame(join(tmp, "f2.png")));
		check("两条路径对'未变'结论一致", noChange.changed === samePng.changed);
	}

	// -----------------------------------------------------------------------
	console.log("[17] 原生文件对话框：识别与提交的硬约束");
	{
		const hostSrc = (await import("node:fs")).readFileSync(join(EXT_DIR, "platform", "win32-host.ps1"), "utf8");

		// 这条是本轮最关键的回归：按 AutomationId + 控件类型找文件名框会落空。
		// 实测这类框把 Edit 报成 Pane、ValuePattern 全缺，带类型条件必然查不到。
		check("文件名框按 ID 查、不绑控件类型", !/ControlType\]::Edit\)\)\s*\)\s*\n\s*\$edit/.test(hostSrc));
		check("提供多套文件名框 ID 兜底（1148/1152/1001）",
			hostSrc.includes("1148") && hostSrc.includes("1152") && hostSrc.includes("1001"));
		check("用 Win32 消息写路径（绕开 IME）", hostSrc.includes("WM_SETTEXT"));
		check("点击用 BM_CLICK", hostSrc.includes("BM_CLICK"));
		check("提交有多通道兜底", hostSrc.includes("bm_click") && hostSrc.includes("enter") && hostSrc.includes("idok"));
		check("对挂死窗口不发送同步消息", hostSrc.includes("IsHungAppWindow"));

		// 中文路径必须不被 SendInput 处理：对话框路径走 WM_SETTEXT
		check("对话框路径不走 SendInput", !/dialog[\s\S]{0,2000}TypeAscii/.test(hostSrc));
	}

	// -----------------------------------------------------------------------
	console.log("[18] 焦点归还：模态对话框优先");
	{
		const src = (await import("node:fs")).readFileSync(join(EXT_DIR, "index.ts"), "utf8");
		// 模态框出现时宿主窗口被禁用，此时必须认框，不能"切回上次感知的窗口"——
		// 那会把框顶到后面，用户既动不了框也动不了宿主。
		check("动作前认模态框为目标", /if \(who\?\.modal\)/.test(src), "prepareAction 应优先认模态框");
		check("感知前认模态框为目标", /if \(cur\?\.modal\)/.test(src), "prepareForPerception 应优先认模态框");
		check("模态框说明写进描述",
			(await import("node:fs")).readFileSync(join(EXT_DIR, "focus.ts"), "utf8").includes("模态对话框"));

		// 窗口身份要带 modal 字段，否则上层永远判不出模态
		const a = toWindowRef({ hwnd: "9", proc: "firefox", title: "打开", rect: { x: 0, y: 0, w: 10, h: 10 }, modal: true });
		check("窗口身份解析出 modal", a?.modal === true);
		check("模态窗口在描述里标出来", describeWindow(a).includes("模态对话框"), describeWindow(a));
		const b = toWindowRef({ hwnd: "9", proc: "firefox", title: "页面", rect: { x: 0, y: 0, w: 10, h: 10 } });
		check("非模态不误标", !describeWindow(b).includes("模态"));
	}

	// -----------------------------------------------------------------------
	console.log("[19] 剪贴板与 perf：不走独立进程");
	{
		const typingSrc = (await import("node:fs")).readFileSync(join(EXT_DIR, "typing.ts"), "utf8");
		// 早期实现每次起 powershell -Command Get-Clipboard 读剪贴板，实测 965ms/次。
		check("剪贴板备份走平台层", typingSrc.includes("platform.getClipboard"));
		// 注释里会提到旧方案（解释为什么换掉），所以判据是"没有真的调起那个命令"
		check("不再起独立进程读剪贴板",
			!/execFile\(\s*"powershell"[\s\S]{0,200}Get-Clipboard/.test(typingSrc));

		const win32Src = (await import("node:fs")).readFileSync(join(EXT_DIR, "platform", "win32.ts"), "utf8");
		check("写剪贴板走宿主", win32Src.includes('op: "clipset"'));
		check("读剪贴板走宿主", win32Src.includes('op: "clipget"'));
		check("灰度网格走宿主", win32Src.includes("async grid()"));

		const idxSrc = (await import("node:fs")).readFileSync(join(EXT_DIR, "index.ts"), "utf8");
		// 动作差分不该再走抓屏 PNG（那是每个动作白付 ~600ms 的来源）
		check("动作基准用网格", idxSrc.includes("lastGrid = await p.grid()"));
		check("动作差分用网格", idxSrc.includes("diffGrids(lastGrid"));
	}

	console.log("");
	if (failures === 0) {
		console.log("全部通过。");
		console.log("\n联调（真实桌面，需人工在场，不进回归）：");
		console.log("  1) cu_elements 读取当前焦点窗口，核对元素表与标注图编号是否一致");
		console.log("  2) 在一个可输入控件上 cu_type 中文，检查是否走 clipboard 且文字正确");
		console.log("  3) 点击前后各截一图，确认 cu_click 的验证结论与肉眼观察一致");
		process.exit(0);
	}
	console.error(`${failures} 项失败。`);
	process.exit(1);
}

main().catch((e) => {
	console.error("测试崩溃：", e);
	process.exit(1);
});
