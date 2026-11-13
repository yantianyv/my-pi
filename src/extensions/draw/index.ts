/**
 * draw：生图工具（draw_image / draw_config）
 *
 * pi 官方把生图模型放在 codemode 里（`models.generateImages`），**没有「当前生图模型」**
 * 这个概念——每次调用都要求显式传模型。让模型自己在几十个候选里挑是纯赌运气：
 * `getAvailableOfType("image")` 只保证「凭证有效」，不保证真能出图。
 *
 * 本扩展只做一件事：把那层选择收进配置，并暴露成普通 tool call。
 * 模型侧只表达**意图**（draft 草稿 / final 成品），具体用哪个模型由配置决定；
 * 参数 schema 里根本没有 model 字段，所以「选错模型」在协议层就无从发生。
 *
 * 与上游无关：任何已按 pi 协议注册的 image 模型都能用，本扩展只读 `ctx.modelRegistry`，
 * 不碰任何插件的数据文件。
 *
 * 主备链：每个档位是一个有序列表，前一个失败自动换下一个；整链的每个候选都记录
 * 失败原因，最终一次性报出来，方便判断是「模型不可用」还是「上游全线挂了」。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";
import { setStatusWithTTL, clearStatusTimers } from "../shared/status";
import { DrawConfigOverlay, OVERLAY_OPTIONS } from "./panel";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 档位：模型只表达意图，不表达产品 */
const TIERS = ["draft", "final"] as const;
type Tier = (typeof TIERS)[number];

const TIER_LABEL: Record<Tier, string> = {
	draft: "草稿",
	final: "成品",
};

/** 默认主备链：draft 用便宜的快速档，final 用无水印的付费模型。
 *  只写“开箱即可用”的公共供应商；没有配 OpenRouter 的机器上两种档都是空链，
 *  首次使用用 `/draw-config` 选模型即可（面板只列本机真实注册的 image 模型）。 */
const DEFAULT_TIERS: Record<Tier, string[]> = {
	draft: ["openrouter/bytedance-seed/seedream-5-0-pro"],
	final: ["openrouter/bytedance-seed/seedream-5-0-pro"],
};

/** 默认尺寸（上游缺省也是 1024x1024） */
const DEFAULT_SIZE = "1024x1024";
/** 落盘目录：项目内相对路径，不落进用户全局目录 */
const DEFAULT_OUT_DIR = ".pi/images";
/** 状态行停留时长 */
const STATUS_TTL_MS = 120_000;
/** 结果里回显提示词的长度上限 */
const PROMPT_PREVIEW = 80;

const STATUS_KEY = "draw";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

interface DrawConfig {
	/** 档位 → 主备模型链（`provider/modelId`） */
	tiers: Record<Tier, string[]>;
	/** 落盘目录（相对项目根目录） */
	outDir: string;
	/** 默认尺寸 */
	size: string;
}

const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "draw.json");

/** 配置文件路径（PI_DRAW_CONFIG_FILE 可覆盖，测试用） */
function configFile(): string {
	return process.env.PI_DRAW_CONFIG_FILE || CONFIG_FILE;
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim().length > 0);
}

function isConfig(v: unknown): v is Partial<DrawConfig> {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	if (o.tiers !== undefined) {
		if (!o.tiers || typeof o.tiers !== "object") return false;
		const t = o.tiers as Record<string, unknown>;
		if (t.draft !== undefined && !isStringArray(t.draft)) return false;
		if (t.final !== undefined && !isStringArray(t.final)) return false;
	}
	if (o.outDir !== undefined && typeof o.outDir !== "string") return false;
	return true;
}

function loadConfig(): DrawConfig {
	const raw = loadJsonConfig<Partial<DrawConfig>>(configFile(), {}, isConfig);
	const tiers = { ...DEFAULT_TIERS };
	for (const tier of TIERS) {
		const list = raw.tiers?.[tier];
		if (list && list.length > 0) tiers[tier] = list;
	}
	return {
		tiers,
		outDir: raw.outDir?.trim() || DEFAULT_OUT_DIR,
		size: raw.size?.trim() || DEFAULT_SIZE,
	};
}

function saveConfig(cfg: DrawConfig): void {
	saveJsonConfig(configFile(), cfg);
}

// ---------------------------------------------------------------------------
// 模型链解析
// ---------------------------------------------------------------------------

/** `provider/modelId` → 已注册的 image 模型（id 自身可能含 `/`，只按第一个斜杠切） */
function resolveRef(ctx: ExtensionContext, ref: string): { model?: ReturnType<typeof findImage>; error?: string } {
	const slash = ref.indexOf("/");
	if (slash <= 0) return { error: `\`${ref}\` 不是 \`provider/modelId\` 形式` };
	const provider = ref.slice(0, slash).trim();
	const id = ref.slice(slash + 1).trim();
	if (!provider || !id) return { error: `\`${ref}\` 不是 \`provider/modelId\` 形式` };
	const model = findImage(ctx, provider, id);
	if (!model) {
		return { error: `\`${ref}\` 不是已注册的生图模型（检查插件是否加载、模型目录是否已刷新）` };
	}
	return { model };
}

function findImage(ctx: ExtensionContext, provider: string, id: string) {
	const found = ctx.modelRegistry.findOfType("image", provider, id);
	return found ?? undefined;
}

/** 列出所有已注册的生图模型（配置面板与报错提示共用） */
function listImageModels(ctx: ExtensionContext): string[] {
	try {
		const reg = ctx.modelRegistry as unknown as {
			getModelsOfType?: (type: "image") => readonly { provider: string; id: string; name?: string }[];
		};
		const list = reg.getModelsOfType?.("image") ?? [];
		return list.map((m) => `${m.provider}/${m.id}`);
	} catch {
		return [];
	}
}

/** `provider/modelId` → 展示名（取不到名字就用模型 id 末段） */
function modelDisplayName(ctx: ExtensionContext, ref: string): string {
	const slash = ref.indexOf("/");
	if (slash <= 0) return ref;
	const model = findImage(ctx, ref.slice(0, slash), ref.slice(slash + 1));
	const name = (model as { name?: string } | undefined)?.name;
	return name?.trim() || ref.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/** 按 PID + 序号定名，避免覆盖已有图片 */
function imagePath(dir: string, index: number): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return path.join(dir, `draw-${stamp}-${index + 1}.png`);
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

/** 扩展名随 mimeType 走（上游目前只出 PNG，但别把 webp 写成 .png） */
function extFor(mimeType: string): string {
	if (mimeType.includes("jpeg")) return ".jpg";
	if (mimeType.includes("webp")) return ".webp";
	if (mimeType.includes("gif")) return ".gif";
	return ".png";
}

// ---------------------------------------------------------------------------
// 工具执行层
// ---------------------------------------------------------------------------

interface DrawParams {
	prompt: string;
	tier?: Tier;
	size?: string;
	ref?: string;
	out?: string;
	preview?: boolean;
}

interface DrawOutcome {
	tier: Tier;
	model: string;
	/** 落盘路径（preview 时也落盘，预览只是额外把图给模型看） */
	files: string[];
	/** 预览用图片块（只有 preview=true 才填） */
	images: ImageContent[];
	/** 整条链的失败记录（成功时为空） */
	failures: string[];
}

/**
 * 按主备链依次尝试。返回第一个成功的模型；整条链都失败才报错。
 * 失败原因逐条带回：分不清「模型没注册」和「上游 402」时，人只能瞎猜。
 */
async function runChain(
	ctx: ExtensionContext,
	tier: Tier,
	params: DrawParams,
	signal: AbortSignal,
): Promise<DrawOutcome> {
	const cfg = loadConfig();
	const chain = cfg.tiers[tier];
	const failures: string[] = [];
	for (const ref of chain) {
		const { model, error } = resolveRef(ctx, ref);
		if (!model) {
			failures.push(`${ref}：${error}`);
			continue;
		}
		const images: ImageContent[] = [];
		// 参考图：本地路径读成 base64 块（与 read 工具同一条路，不依赖网络）
		if (params.ref) {
			try {
				const abs = path.isAbsolute(params.ref) ? params.ref : path.resolve(ctx.cwd, params.ref);
				const data = fs.readFileSync(abs);
				images.push({ type: "image", data: data.toString("base64"), mimeType: mimeForExt(abs) });
			} catch (err) {
				return {
					tier,
					model: ref,
					files: [],
					images: [],
					failures: [`参考图读取失败：${err instanceof Error ? err.message : String(err)}`],
				};
			}
		}
		const result = await ctx.modelRegistry.generateImages(
			model,
			{ input: [{ type: "text", text: params.prompt }, ...images] },
			{
				signal,
				metadata: { size: params.size || cfg.size },
			},
		);
		if (result.stopReason !== "stop") {
			failures.push(`${ref}：${result.errorMessage ?? "未知错误"}`);
			continue;
		}
		const outImages = result.output.filter((b): b is ImageContent => b.type === "image");
		if (outImages.length === 0) {
			failures.push(`${ref}：上游没有返回图片`);
			continue;
		}
		const dir = path.isAbsolute(cfg.outDir) ? cfg.outDir : path.resolve(ctx.cwd, cfg.outDir);
		ensureDir(dir);
		const files: string[] = [];
		for (const [i, block] of outImages.entries()) {
			const file = params.out && outImages.length === 1
				? path.resolve(ctx.cwd, params.out)
				: imagePath(dir, i).replace(/\.png$/, extFor(block.mimeType));
			ensureDir(path.dirname(file));
			// 单张且指定了 out 时用用户给的名字，其余按时间戳
			fs.writeFileSync(file, Buffer.from(block.data, "base64"));
			files.push(file);
		}
		return {
			tier,
			model: ref,
			files,
			images: params.preview ? outImages : [],
			failures,
		};
	}
	return { tier, model: "", files: [], images: [], failures };
}

function mimeForExt(file: string): string {
	const ext = path.extname(file).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return "image/png";
}

function resultText(outcome: DrawOutcome, params: DrawParams): string {
	const prompt = params.prompt.length > PROMPT_PREVIEW
		? `${params.prompt.slice(0, PROMPT_PREVIEW)}…`
		: params.prompt;
	const lines = [
		`已生成 ${outcome.files.length} 张（${TIER_LABEL[outcome.tier]}档 · ${outcome.model}）`,
		`提示词：${prompt}`,
	];
	if (outcome.failures.length > 0) {
		lines.push(`主备链换过 ${outcome.failures.length} 个模型：`, ...outcome.failures.map((f) => `- ${f}`));
	}
	lines.push(`文件：${outcome.files.join("、")}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "draw_image",
		label: "生图",
		description:
			"用已配置的生图模型出图并保存到磁盘。档位 draft=内部草稿、final=交付成品；具体模型由 draw_config 配置的主备链决定，本工具不接受模型参数。可选 ref 传参考图做图生图。",
		promptSnippet: "中文用途：draw_image(prompt[, tier][, ref][, size][, out][, preview]) → 生成图片并落盘，返回文件路径",
		promptGuidelines: [
			"生图前先判断用途：只在内部查看/试配方用 draft（默认），要进交付物、给用户看的成品才用 final。",
			"要基于已有图片修改时传 ref（图片路径），不要用文字描述替代参考图。",
			"draw_image 默认只返回路径不附图；需要自己看图判断效果时才传 preview=true。",
		],
		// 只读：本工具只写自己的输出文件，不改动用户数据；keep 的停点判定据此放行
		annotations: { readOnlyHint: false },
		parameters: Type.Object({
			prompt: Type.String({ description: "画面描述（越具体越好：主体、风格、光线、构图）" }),
			tier: Type.Optional(
				Type.Union(
					TIERS.map((t) => Type.Literal(t)),
					{ description: "draft=内部草稿（默认）/ final=交付成品" },
				),
			),
			size: Type.Optional(Type.String({ description: `尺寸，如 ${DEFAULT_SIZE}` })),
			ref: Type.Optional(Type.String({ description: "参考图路径（图生图；需所配模型支持图片输入）" })),
			out: Type.Optional(Type.String({ description: "输出文件路径（只在单张时生效）；缺省写配置的落盘目录" })),
			preview: Type.Optional(Type.Boolean({ description: "是否把生成的图一并发给自己看（会增加上下文占用）" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tier: Tier = params.tier ?? "draft";
			const cfg = loadConfig();
			// 先做一次「有没有配、配的模型在不在」的前置检查：这类问题不该等生图跑一遍才发现
			const ready = cfg.tiers[tier].length > 0 ? resolveRef(ctx, cfg.tiers[tier][0]!) : {};
			if (ready.model === undefined) {
				const available = listImageModels(ctx);
				const hint = available.length > 0
					? `\n当前已注册的生图模型：${available.join("、")}`
					: "\n当前没有任何已注册的生图模型：在 models.json 里配一条带 type:\"image\" 的模型即可。";
				return {
					content: [{
						type: "text",
						text: `${TIER_LABEL[tier]}档的模型链第一个候选不可用：${ready.error ?? "未配置"}。${hint}\n用 /draw-config 设置主备链。`,
					}],
					details: { tier, configured: cfg.tiers[tier], available },
					isError: true,
				};
			}

			setStatusWithTTL(ctx, STATUS_KEY, `🎨 生图中（${TIER_LABEL[tier]}）`, STATUS_TTL_MS);
			// 不设自己的超时：生图慢的时候可能好几分钟，而失败（丢一张图）比多等更亏。
			// 需要中断时用 Esc，走透传的用户信号；每张图的下载各自设上限。
			let outcome: DrawOutcome;
			try {
				outcome = await runChain(ctx, tier, params, signal ?? new AbortController().signal);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setStatusWithTTL(ctx, STATUS_KEY, `⚠ 生图失败`, 10_000);
				return {
					content: [{ type: "text", text: `生图失败：${message}` }],
					details: { tier },
					isError: true,
				};
			}
			if (outcome.files.length === 0) {
				setStatusWithTTL(ctx, STATUS_KEY, `⚠ ${TIER_LABEL[tier]}档出图失败`, 10_000);
				const tried = outcome.failures.length > 0
					? outcome.failures.map((f) => `- ${f}`).join("\n")
					: "（模型链为空）";
				return {
					content: [{
						type: "text",
						text: `${TIER_LABEL[tier]}档的整条主备链都失败了：\n${tried}\n\n可换档位、换模型（/draw-config），或检查上游额度与登录态。`,
					}],
					details: { tier, failures: outcome.failures },
					isError: true,
				};
			}
			ctx.ui.setStatus(STATUS_KEY, `✓ 已出图 ${outcome.files.length} 张`);
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: resultText(outcome, params) }];
			content.push(...outcome.images);
			return {
				content,
				details: {
					tier: outcome.tier,
					model: outcome.model,
					files: outcome.files,
					failures: outcome.failures,
				},
			};
		},
	});

	pi.registerCommand("draw-config", {
		description: "生图配置：档位主备链、落盘目录、默认尺寸",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const [verb, ...rest] = tokens;

			if (!verb) {
				// 无参开面板（配置类命令的约定）；无 UI 环境才退回文本摘要
				if (ctx.hasUI) {
					await ctx.ui.custom<void>(
						(tui, theme, _kb, done) => {
							const overlay = new DrawConfigOverlay(
								tui,
								theme,
								{
									getConfig: () => {
										const c = loadConfig();
										return { tiers: { draft: c.tiers.draft, final: c.tiers.final }, outDir: c.outDir, size: c.size };
									},
									saveConfig: (next) => saveConfig({ ...loadConfig(), ...next }),
									listModels: () => listImageModels(ctx),
									modelLabel: (ref) => modelDisplayName(ctx, ref),
								},
								done,
							);
							return overlay;
						},
						OVERLAY_OPTIONS,
					);
					return;
				}
				const available = listImageModels(ctx);
				const lines = [
					"生图配置（/draw-config）",
					"",
					...TIERS.map((t) => {
						const chain = cfg.tiers[t].join(" → ");
						return `  ${t.padEnd(6)} ${TIER_LABEL[t]}：${chain}`;
					}),
					"",
					`  落盘目录：${cfg.outDir}`,
					`  默认尺寸：${cfg.size}`,
					"",
					"用法：",
					"  /draw-config                                                 打开面板",
					"  /draw-config set <draft|final> <provider/model[,provider/model...]>  设置主备链（逗号分隔，前者失败换后者）",
					"  /draw-config out <目录>      落盘目录（相对项目根）",
					"  /draw-config size <宽x高>    默认尺寸",
					"  /draw-config list            列出所有已注册的生图模型",
					"",
					available.length > 0
						? `已注册的生图模型：${available.join("、")}`
						: "当前没有已注册的生图模型（在 models.json 里配好 type:\"image\" 的模型）",
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (verb === "list") {
				const available = listImageModels(ctx);
				ctx.ui.notify(
					available.length > 0 ? available.join("\n") : "没有已注册的生图模型：在 models.json 里配 type:\"image\" 条目，或用 /draw-config list 查看。",
					"info",
				);
				return;
			}

			if (verb === "set") {
				const [tierName, chainArg] = rest;
				if (!tierName || !TIERS.includes(tierName as Tier)) {
					ctx.ui.notify(`档位必须是 ${TIERS.join(" / ")}`, "error");
					return;
				}
				if (!chainArg) {
					ctx.ui.notify("缺少模型链：/draw-config set draft <provider>/<model>[,<provider>/<model>...]", "error");
					return;
				}
				const chain = chainArg.split(",").map((s) => s.trim()).filter(Boolean);
				// 逐项校验：写进配置的引用必须是真实存在的 image 模型，否则生图时才发现
				const bad: string[] = [];
				for (const ref of chain) {
					const { model, error } = resolveRef(ctx, ref);
					if (!model) bad.push(error ?? ref);
				}
				if (bad.length > 0) {
					const available = listImageModels(ctx);
					ctx.ui.notify(
						`以下引用不可用：\n${bad.map((b) => `- ${b}`).join("\n")}\n\n已注册的生图模型：${available.join("、") || "（无）"}`,
						"error",
					);
					return;
				}
				cfg.tiers[tierName as Tier] = chain;
				saveConfig(cfg);
				ctx.ui.notify(`${TIER_LABEL[tierName as Tier]}档主备链已设为：${chain.join(" → ")}`, "info");
				return;
			}

			if (verb === "out") {
				const dir = rest[0];
				if (!dir) {
					ctx.ui.notify(`当前落盘目录：${cfg.outDir}`, "info");
					return;
				}
				cfg.outDir = dir;
				saveConfig(cfg);
				ctx.ui.notify(`落盘目录已设为：${dir}`, "info");
				return;
			}

			if (verb === "size") {
				const size = rest[0];
				if (!size) {
					ctx.ui.notify(`当前默认尺寸：${cfg.size}`, "info");
					return;
				}
				if (!/^\d+x\d+$/.test(size)) {
					ctx.ui.notify(`尺寸写成 宽x高，如 ${DEFAULT_SIZE}`, "error");
					return;
				}
				cfg.size = size;
				saveConfig(cfg);
				ctx.ui.notify(`默认尺寸已设为：${size}`, "info");
				return;
			}

			ctx.ui.notify(`未知子命令 ${verb}：可用 set / out / size / list`, "error");
		},
	});

	pi.on("session_shutdown", () => {
		clearStatusTimers();
	});
}
