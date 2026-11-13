/**
 * computer-use/model/detector：OmniParser icon_detect 推理（ONNX Runtime）
 *
 * 模型选型与落差（实测得出，别照抄 OmniParser 官方仓库）：
 * - 官方仓库要 torch + transformers + ultralytics，但 **PyTorch 没有 win-arm64 wheel**，
 *   在 ARM64 Windows 上装不了。所以用社区转好的 ONNX 权重。
 * - `onnx-community/OmniParser-icon_detect` 的 fp32（12MB）与 int8（3.2MB）都能跑；
 *   fp32 精度明显更好（int8 在同一张设置页上漏掉近半元素），而原生推理只要 35ms，
 *   省这 8MB 不值得。默认 fp32，int8 留作低配机器的开关。
 *
 * 只做检测，不做图标语义描述：icon_detect 输出的是"这有个可交互控件"的框，
 * 不给"这是个设置按钮"。要语义得再挂 Florence-2 caption（1.5GB、CPU 上数秒），
 * 而多模态模型看带编号的标注图本身就能认出来，所以 caption 是可选的二级增强。
 *
 * 加载策略：onnxruntime-node 是全局安装的外部包（不走构建内联——它带原生二进制，
 * 内联不进去）。扩展在运行时按绝对路径动态 import；缺席时抛 ModelUnavailableError，
 * 上层降级为"只用 UIA"并提示怎么装。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelInput } from "./preprocess";
import { mapBox } from "./preprocess";

/** 检测结果（屏幕物理像素） */
export interface Detection {
	x: number;
	y: number;
	w: number;
	h: number;
	/** 置信度 0..1 */
	conf: number;
}

/** 推理耗时明细 */
export interface DetectTiming {
	/** 会话加载（首次） */
	loadMs: number;
	/** 预处理（解码 PNG + 缩放 + 张量） */
	prepMs: number;
	/** 推理本身 */
	inferMs: number;
	/** 后处理（阈值 + NMS + 映射回屏幕） */
	postMs: number;
}

export interface DetectResult {
	detections: Detection[];
	timing: DetectTiming;
}

/** 模型文件缺失/onnxruntime 不可用时抛这个 */
export class ModelUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelUnavailableError";
	}
}

/** 检测阈值：低于它的候选多半是图标内部的纹理片段 */
const DEFAULT_CONF = 0.25;
/** NMS IoU 阈值（单类检测，0.5 足够） */
const NMS_IOU = 0.5;
/** 过小的框一律丢掉：小于这个面积的"元素"点不准，也没意义 */
const MIN_BOX_PX = 8;

/** onnxruntime-node 的最小可用面（避免依赖它的类型定义，它不在构建依赖里） */
interface OrtTensor {
	data: Float32Array;
	dims: readonly number[];
}
interface OrtSession {
	run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
	release?(): Promise<void> | void;
	outputNames?: readonly string[];
}
interface OrtModule {
	InferenceSession: {
		create(modelPath: string, opts?: Record<string, unknown>): Promise<OrtSession>;
	};
	Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

/**
 * 动态加载 onnxruntime-node。
 * 优先按包名解析（正常 npm 全局安装的布局）；失败时按 deps.json 安装记录里的绝对路径回退。
 */
async function loadOrt(): Promise<OrtModule> {
	for (const spec of ortCandidates()) {
		try {
			const mod = await import(spec);
			if (mod) return (("default" in mod ? mod.default : mod) as unknown) as OrtModule;
		} catch {
			/* 试下一个候选 */
		}
	}
	throw new ModelUnavailableError(
		"缺少 onnxruntime-node（视觉检测的后端）。运行 node install.js 选择安装「桌面视觉检测」，或手动 npm i -g onnxruntime-node。",
	);
}

/**
 * onnxruntime-node 的候选加载路径。
 *
 * 它由 static/deps.json 走 **全局** npm 安装，而扩展产物在 ~/.pi/agent/extensions/ 下，
 * 从那里按包名 import 只能看见 pi 自己的依赖树，看不到全局 node_modules（实测 ENOENT）。
 * 所以先试包名（本地依赖布局、或用户自己装进了项目），再按各平台全局根逐个试。
 * 全局根用绝对路径 import：Windows 上 ESM 加载绝对路径必须转成 file: URL。
 */
function ortCandidates(): string[] {
	const out = ["onnxruntime-node"];
	const roots = [
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : null,
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
		path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
		path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
	];
	for (const root of roots) {
		if (!root) continue;
		const pkg = path.join(root, "onnxruntime-node");
		if (!fs.existsSync(path.join(pkg, "package.json"))) continue;
		out.push(pathToFileURL(path.join(pkg, "dist", "index.js")).href);
	}
	return out;
}

export class IconDetector {
	private session: OrtSession | null = null;
	private ort: OrtModule | null = null;
	private loadMs = 0;
	private readonly modelPath: string;

	constructor(modelPath: string) {
		this.modelPath = modelPath;
	}

	/** 模型文件在不在（据此判断能否走视觉通道） */
	available(): boolean {
		return fs.existsSync(this.modelPath);
	}

	/** 惰性加载会话：只有真的要用视觉检测时才付加载成本 */
	async ensure(): Promise<void> {
		if (this.session) return;
		if (!this.available()) {
			throw new ModelUnavailableError(
				`找不到检测模型：${this.modelPath}。运行 node install.js 选择安装「桌面视觉检测」以自动下载。`,
			);
		}
		const t0 = Date.now();
		this.ort = await loadOrt();
		this.session = await this.ort.InferenceSession.create(this.modelPath, {
			executionProviders: ["cpu"],
			// 4 线程：实测比单线程快 ~2.5 倍，再往上收益递减且抢占其他应用
			intraOpNumThreads: 4,
			graphOptimizationLevel: "all",
		});
		this.loadMs = Date.now() - t0;
	}

	async release(): Promise<void> {
		if (this.session?.release) await this.session.release();
		this.session = null;
	}

	/**
	 * 在给定输入上跑检测，返回屏幕坐标框。
	 * 框已在模型坐标系里做过 NMS，再统一映射回屏幕物理像素。
	 */
	async detect(input: ModelInput, confThreshold = DEFAULT_CONF): Promise<DetectResult> {
		await this.ensure();
		const ort = this.ort!;
		const session = this.session!;
		const t0 = Date.now();
		const out = await session.run({
			images: new ort.Tensor("float32", input.tensor, [1, 3, input.h, input.w]),
		});
		const inferMs = Date.now() - t0;

		// YOLOv8 输出 [1, 4+nc, N]：前 4 行 cx,cy,w,h，其余为类别分数（OmniParser 单类，取第 5 行）
		const tensor = out.output0 ?? Object.values(out)[0];
		if (!tensor) throw new Error("检测模型没有返回输出");
		const [, rows, n] = tensor.dims as unknown as [number, number, number];
		if (rows < 5) throw new Error(`检测模型输出形状异常：${JSON.stringify(tensor.dims)}`);
		const d = tensor.data;

		const t1 = Date.now();
		const cands: { conf: number; cx: number; cy: number; bw: number; bh: number }[] = [];
		for (let i = 0; i < n; i++) {
			const s = d[4 * n + i]!;
			if (s > confThreshold && Number.isFinite(s)) {
				cands.push({ conf: s, cx: d[i]!, cy: d[n + i]!, bw: d[2 * n + i]!, bh: d[3 * n + i]! });
			}
		}
		cands.sort((a, b) => b.conf - a.conf);
		const kept: typeof cands = [];
		for (const c of cands) {
			if (kept.every((k) => iou(c, k) <= NMS_IOU)) kept.push(c);
		}
		const detections = kept
			.map((c) => ({
				...mapBox({ x: c.cx - c.bw / 2, y: c.cy - c.bh / 2, w: c.bw, h: c.bh }, input),
				conf: c.conf,
			}))
			.filter((b) => b.w >= MIN_BOX_PX && b.h >= MIN_BOX_PX);

		return { detections, timing: { loadMs: this.loadMs, prepMs: 0, inferMs, postMs: Date.now() - t1 } };
	}
}

/** 两个框的 IoU（x,y,w,h 形式） */
function iou(
	a: { cx: number; cy: number; bw: number; bh: number },
	b: { cx: number; cy: number; bw: number; bh: number },
): number {
	const ax1 = a.cx - a.bw / 2, ax2 = a.cx + a.bw / 2;
	const ay1 = a.cy - a.bh / 2, ay2 = a.cy + a.bh / 2;
	const bx1 = b.cx - b.bw / 2, bx2 = b.cx + b.bw / 2;
	const by1 = b.cy - b.bh / 2, by2 = b.cy + b.bh / 2;
	const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
	const ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
	const inter = iw * ih;
	const union = a.bw * a.bh + b.bw * b.bh - inter;
	return union <= 0 ? 0 : inter / union;
}
