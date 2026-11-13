/**
 * mimo-omni: 让 AI 能「说话」，以及给媒体做转写/结构化解读（走小米 MiMo 开放平台）
 *
 * 音频与视频本身已经能进上下文：`static/patches/apply-pi-audio-input.mjs` 把 audio / video
 * 内容块打通到请求体，`read` 读数媒文件直接产出媒体块，MiMo 系列模型在 models.json 里声明了
 * audio / video 能力——全模态模型能原生听语气、看画面。本扩展补的是这之外的两种需求：
 *   mimo_transcribe：需要「转成文字」时（便宜、可检索、之后可被任何模型读取；音频 6.25 token/秒）
 *   mimo_speak     ：给文字，合成语音文件（可选直接播放）
 *
 * 不读原媒体也能用的场景用 read；要让某模型「听到语气/音色」用 read（需音频能力模型）；
 * 要一份可搜索的逐字稿用 mimo_transcribe。
 *
 * 音频：wav/mp3/m4a/flac/ogg/aac/opus；视频：mp4/mov/avi/wmv（fps、media_resolution 可调）
 * 官方限制：base64 传入 ≤50MB（本层按 45MB 留余量拦截）；URL 传入音频 ≤100MB、视频 ≤300MB
 *
 * - /mimo-config          TUI 面板：设置解析模型与合成音色（带参数可直接设置，如 /mimo-config model <id>）
 * - 通道：pi 已登录的 MiMo provider，Token Plan 优先（订阅额度先花），其次按量付费。
 *   两者的 host 不同（token-plan-<集群>.xiaomimimo.com / api.xiaomimimo.com），key 不能串用，
 *   所以端点跟着 provider 走，不在代码里写死。
 * - 环境变量 MIMO_API_KEY 直供（registry 没配置时）：tp-/ttp- 开头的 key 视为 Token Plan，
 *   端点默认取注册表里订阅套餐 provider 的 baseUrl，可用 MIMO_BASE_URL 覆盖（换集群）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadJsonConfig, saveJsonConfig } from "./shared/config";
import { createModelSetting } from "./shared/model-setting";
import { firstPlayerFor } from "./shared/audio-player";
import { setStatusWithTTL } from "./shared/status";

// ---------------- 可调配置 ----------------
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "mimo-omni.json");
/** pi 里已登录的 MiMo provider，按优先级：Token Plan 三集群（订阅额度）→ 按量付费 */
const MIMO_PROVIDERS = ["xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi"];
const PAYG_PROVIDER = "xiaomi";
const PAYG_BASE_URL = "https://api.xiaomimimo.com/v1"; // provider 查不到时的兜底（环境变量直供）
const DEFAULT_MODEL = "mimo-v2.6-flash"; // 最便宜档；解析质量要求高时 /mimo-config 换 pro
const FALLBACK_MODELS = ["mimo-v2.6-pro"]; // 两个通道都有，且都是全模态模型
const TTS_MODEL = "mimo-v2.5-tts";
const DEFAULT_VOICE = "mimo_default";
const VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
/** 模型选择面板候选（带价格/稳定性提示，避免误选贵档） */
const MODEL_CHOICES = [
	{ id: "mimo-v2.6-flash", label: "mimo-v2.6-flash（最便宜，偶发空回复）" },
	{ id: "mimo-v2.6-pro", label: "mimo-v2.6-pro（推荐，稳定）" },
	{ id: "mimo-v2.6-pro-ultraspeed", label: "mimo-v2.6-pro-ultraspeed（最快，价格 10 倍；Token Plan 不含）" },
];
const MAX_BASE64_MB = 45; // 官方上限 50MB（base64 字符串），留余量提前拦截
const MISSING_AUTH = "缺少小米 MiMo 凭证（在 pi 里登录 xiaomi-token-plan-cn / xiaomi provider，或设置 MIMO_API_KEY）";
const DEFAULT_PROMPT = "把这段媒体内容转成完整的逐字稿；没有人声或无法转写时，说明媒体里的实际内容。";
const PLAY_TIMEOUT_MS = 120_000;

const AUDIO_MIME: Record<string, string> = {
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".aac": "audio/aac",
	".opus": "audio/opus",
};
const VIDEO_MIME: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".avi": "video/x-msvideo",
	".wmv": "video/x-ms-wmv",
};
// ------------------------------------------

interface MimoConfig {
	model?: string;
	voice?: string;
}

/** 只接受字符串字段（畸形值回默认，不让坏配置渗进运行逻辑） */
const isMimoConfig = (v: unknown): v is MimoConfig => {
	const c = v as { model?: unknown; voice?: unknown } | null;
	if (!c || typeof c !== "object") return false;
	return (c.model === undefined || typeof c.model === "string") && (c.voice === undefined || typeof c.voice === "string");
};

function loadConfig(): MimoConfig {
	return loadJsonConfig<MimoConfig>(CONFIG_PATH, {}, isMimoConfig);
}

function saveConfig(cfg: MimoConfig): void {
	saveJsonConfig(CONFIG_PATH, cfg);
}

/** 解析模型用途声明：接入 /model-config 中心设置（key 同本插件 config 的 model，
 *  本地设值与插件面板互写互通）。通道（端点/auth）仍由 provider 探测决定，不走模型链；
 *  FALLBACK_MODELS 是全模态通道的技术回退（flash 档实测约半数空正文，降 pro 才能出结果），
 *  不属「跨模型回退只给 FREE 池」的纪律范围。 */
const parseModelSetting = createModelSetting({
	purpose: "mimo-omni.parse",
	plugin: "mimo-omni",
	label: "媒体解析",
	file: CONFIG_PATH,
	key: "model",
	defaultStrategy: "BASE",
	requiresVision: true,
});

/** 媒体类型判定：按扩展名分音频/视频；不认识的扩展名返回 undefined */
export function detectMediaKind(file: string): { kind: "audio" | "video"; mime: string } | undefined {
	const ext = path.extname(file.split("?")[0]).toLowerCase();
	if (AUDIO_MIME[ext]) return { kind: "audio", mime: AUDIO_MIME[ext] };
	if (VIDEO_MIME[ext]) return { kind: "video", mime: VIDEO_MIME[ext] };
	return undefined;
}

export interface MediaPartOptions {
	fps?: number;
	resolution?: "default" | "max";
}

/**
 * 构造 MiMo 媒体内容块。source 为 http(s) URL 时直传（音频 ≤100MB / 视频 ≤300MB），
 * 否则读本地文件转 base64 data URI（超过 MAX_BASE64_MB 直接报错，避免白传一遍）。
 */
export function buildMediaPart(source: string, opts: MediaPartOptions = {}): Record<string, unknown> {
	const isUrl = /^https?:\/\//i.test(source);
	let kind: "audio" | "video";
	let data: string;

	if (isUrl) {
		const guessed = detectMediaKind(source);
		kind = guessed?.kind ?? "audio"; // URL 无扩展名时按音频处理（官方两种传入共用一个字段族）
		data = source;
	} else {
		if (!fs.existsSync(source)) throw new Error(`文件不存在：${source}`);
		const stat = fs.statSync(source);
		if (!stat.isFile()) throw new Error(`不是文件：${source}`);
		const detected = detectMediaKind(source);
		if (!detected) {
			throw new Error(
				`不支持的媒体格式：${path.extname(source)}（音频支持 ${Object.keys(AUDIO_MIME).join("/")}；视频支持 ${Object.keys(VIDEO_MIME).join("/")}）`,
			);
		}
		kind = detected.kind;
		const bytes = stat.size;
		const base64Bytes = Math.ceil(bytes / 3) * 4;
		if (base64Bytes > MAX_BASE64_MB * 1024 * 1024) {
			throw new Error(
				`文件过大：${(bytes / 1024 / 1024).toFixed(1)}MB（base64 后约 ${(base64Bytes / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_BASE64_MB}MB）。` +
					"请先压缩/切片，或改用公网可访问的 URL 传入（音频 ≤100MB、视频 ≤300MB）。",
			);
		}
		data = `data:${detected.mime};base64,${fs.readFileSync(source).toString("base64")}`;
	}

	if (kind === "video") {
		return {
			type: "video_url",
			video_url: { url: data },
			fps: opts.fps ?? 2,
			media_resolution: opts.resolution ?? "default",
		};
	}
	return { type: "input_audio", input_audio: { data } };
}

export interface MimoAuth {
	apiKey: string;
	baseUrl: string;
	provider: string;
	headers?: Record<string, string>;
}

/** ProviderHeaders 允许 null（表示删除该头），转成 fetch 能用的头表 */
function usableHeaders(h: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!h) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h)) if (v !== null) out[k] = v;
	return Object.keys(out).length ? out : undefined;
}

/**
 * 解析调用凭证：取注册表里第一个已配置认证的 MiMo provider（Token Plan 优先），
 * 端点跟着 provider 走——Token Plan 与按量付费是不同的 host，key 不能串用。
 */
export async function resolveAuth(ctx: ExtensionContext): Promise<MimoAuth | undefined> {
	const registry = ctx.modelRegistry;
	for (const provider of MIMO_PROVIDERS) {
		const model = registry.find(provider, DEFAULT_MODEL) ?? registry.getModelsOfType("chat", provider)[0];
		if (!model || !registry.hasConfiguredAuth(model)) continue;
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) continue;
		return { apiKey: auth.apiKey, baseUrl: auth.baseUrl ?? model.baseUrl, provider, headers: usableHeaders(auth.headers) };
	}
	const envKey = process.env.MIMO_API_KEY;
	if (!envKey) return undefined;
	const provider = /^t{1,2}p-/i.test(envKey) ? MIMO_PROVIDERS[0] : PAYG_PROVIDER;
	return {
		apiKey: envKey,
		baseUrl: process.env.MIMO_BASE_URL ?? registry.getProvider(provider)?.baseUrl ?? PAYG_BASE_URL,
		provider,
	};
}

/** 非流式单轮调用（解析/合成通用）：返回 choices[0].message.content */
export async function mimoChat(
	auth: MimoAuth,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ text: string; usage: Record<string, unknown> | undefined }> {
	const res = await fetch(`${auth.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { ...(auth.headers ?? {}), Authorization: `Bearer ${auth.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) throw new Error(`MiMo HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const j = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
		usage?: Record<string, unknown>;
	};
	return { text: j.choices?.[0]?.message?.content ?? "", usage: j.usage };
}

/** 合成语音：返回 wav 字节 */
export async function mimoTts(auth: MimoAuth, text: string, voice: string, signal?: AbortSignal): Promise<Buffer> {
	const res = await fetch(`${auth.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { ...(auth.headers ?? {}), Authorization: `Bearer ${auth.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: TTS_MODEL,
			messages: [{ role: "assistant", content: text }],
			audio: { format: "wav", voice },
		}),
		signal,
	});
	if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const j = (await res.json()) as { choices?: Array<{ message?: { audio?: { data?: string } } }> };
	const b64 = j.choices?.[0]?.message?.audio?.data;
	if (!b64) throw new Error("TTS 未返回音频数据");
	return Buffer.from(b64, "base64");
}

/** 播放音频文件（平台自带播放器，零额外依赖；候选表在 shared/audio-player） */
function playAudio(file: string, signal?: AbortSignal): Promise<void> {
	const first = firstPlayerFor(file);
	if (!first) return Promise.reject(new Error(`平台 ${process.platform} 没有可用播放器`));
	return new Promise((resolve, reject) => {
		const tryNext = (cur: typeof first | null) => {
			if (!cur) {
				reject(new Error("所有播放器都失败了"));
				return;
			}
			execFile(cur.cmd, cur.args, { timeout: PLAY_TIMEOUT_MS, signal }, (err) => {
				if (err) tryNext(cur.next());
				else resolve();
			});
		};
		tryNext(first);
	});
}

export interface ParseAttempt {
	model: string;
	attempt: number;
	ok: boolean;
	note: string;
}

/**
 * 解析链：按模型顺序尝试，每个模型对「空正文」重试一次（便宜模型偶发只回思考不回正文），
 * 全空则降级到下一个模型。onAttempt 用于日志/调试观察每次尝试的结果。
 */
export async function runMediaParse(
	auth: MimoAuth,
	part: Record<string, unknown>,
	instruction: string,
	models: string[],
	signal?: AbortSignal,
	onAttempt?: (a: ParseAttempt) => void,
): Promise<{ text: string; model: string; usage: Record<string, unknown> | undefined; attempts: ParseAttempt[] }> {
	const attempts: ParseAttempt[] = [];
	let lastErr: unknown;
	for (const model of models) {
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				const { text, usage } = await mimoChat(
					auth,
					{
						model,
						messages: [
							{ role: "system", content: "你是媒体内容解析助手。准确、忠于原内容，不要编造；听不清或看不清的地方明确说明。" },
							{ role: "user", content: [part, { type: "text", text: instruction }] },
						],
					},
					signal,
				);
				const ok = text.trim().length > 0;
				const a = { model, attempt, ok, note: ok ? `${text.trim().length} 字` : "空正文" };
				attempts.push(a);
				onAttempt?.(a);
				if (ok) return { text: text.trim(), model, usage, attempts };
			} catch (e) {
				const a = { model, attempt, ok: false, note: e instanceof Error ? e.message.slice(0, 80) : String(e) };
				attempts.push(a);
				onAttempt?.(a);
				lastErr = e;
			}
		}
	}
	if (lastErr) throw lastErr;
	throw new Error("全部模型都返回空内容");
}

export default function (pi: ExtensionAPI) {
	function currentModel(): string {
		// 中心设置（model-config）优先于本地值（同其它用途的解析顺序）
		const center = parseModelSetting.getCenterSetting();
		if (center) return center;
		return loadConfig().model ?? DEFAULT_MODEL;
	}

	pi.registerCommand("mimo-config", {
		description: "MiMo 媒体能力设置（模型与音色，TUI 面板）",
		handler: async (args, ctx) => {
			const [key, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const val = rest.join(" ");
			// 带参数时直接设置（便于脚本化；无参数则开面板）
			if (key) {
				if (key === "model" && val) {
					saveConfig({ ...loadConfig(), model: val });
					ctx.ui.notify(`解析模型已设为 ${val}`, "info");
				} else if (key === "voice" && VOICES.includes(val)) {
					saveConfig({ ...loadConfig(), voice: val });
					ctx.ui.notify(`音色已设为 ${val}`, "info");
				} else {
					ctx.ui.notify("用法：/mimo-config（面板）｜/mimo-config model <id>｜/mimo-config voice <音色>", "warning");
				}
				return;
			}
			// 面板：官方 select/input 弹窗（逐项设置，Esc 退出）
			for (;;) {
				const cfg = loadConfig();
				const choice = await ctx.ui.select("MiMo 媒体设置", [
					`解析模型：${currentModel()}`,
					`合成音色：${cfg.voice ?? DEFAULT_VOICE}`,
					"完成",
				]);
				if (!choice || choice === "完成") return;
				if (choice.startsWith("解析模型")) {
					const labels = MODEL_CHOICES.map((m) => m.label);
					const pick = await ctx.ui.select("解析用模型", [...labels, "其他（手动输入 id）"]);
					if (!pick) continue;
					const id = pick.startsWith("其他") ? (await ctx.ui.input("模型 id", "例如 mimo-v2.6-flash"))?.trim() : MODEL_CHOICES.find((m) => m.label === pick)?.id;
					if (!id) continue;
					saveConfig({ ...loadConfig(), model: id });
					ctx.ui.notify(`解析模型已设为 ${id}`, "info");
					continue;
				}
				if (choice.startsWith("合成音色")) {
					const pick = await ctx.ui.select("合成音色", VOICES);
					if (!pick) continue;
					saveConfig({ ...loadConfig(), voice: pick });
					ctx.ui.notify(`音色已设为 ${pick}`, "info");
					continue;
				}
			}
		},
	});

	pi.registerTool({
		name: "mimo_transcribe",
		annotations: { readOnlyHint: true },
		label: "解析音频/视频",
		description:
			"把音频/视频转成文字（逐字稿，或按 prompt 指定要求解析：要点、行动项、时间轴）。" +
			"要让模型自己听语气/看画面，直接 read 媒体文件即可，不要先转写。" +
			"音频 wav/mp3/m4a/flac/ogg/aac/opus，视频 mp4/mov/avi/wmv；本地文件上限 45MB，超大改用 URL。",
		promptSnippet: "解析音频/视频：mimo_transcribe(path[, prompt][, fps][, resolution]) → 文本",
		parameters: Type.Object({
			path: Type.String({ description: "本地文件路径或公网 http(s) URL" }),
			prompt: Type.Optional(Type.String({ description: "解析要求（缺省输出完整逐字稿），如「提取行动项与负责人」" })),
			fps: Type.Optional(Type.Number({ description: "视频抽帧率 0.1~10，默认 2（越高越准也越贵）", minimum: 0.1, maximum: 10 })),
			resolution: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("max")], { description: "视频单帧分辨率，默认 default" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const auth = await resolveAuth(ctx);
			if (!auth) {
				return { content: [{ type: "text", text: MISSING_AUTH }], details: {}, isError: true };
			}
			let part: Record<string, unknown>;
			let kindLabel: string;
			try {
				const detected = detectMediaKind(params.path);
				kindLabel = detected?.kind === "video" ? "视频" : "音频";
				part = buildMediaPart(params.path, { fps: params.fps, resolution: params.resolution });
			} catch (e) {
				return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], details: {}, isError: true };
			}
			onUpdate?.({ content: [{ type: "text", text: `正在解析${kindLabel}…` }], details: {} });
			ctx.ui.setStatus("mimo-omni", `🎬 解析${kindLabel}中`);

			const instruction = params.prompt?.trim() || DEFAULT_PROMPT;
			const chain = [currentModel(), ...FALLBACK_MODELS.filter((m) => m !== currentModel())];
			let attemptsLog: ParseAttempt[] = [];
			try {
				const { text, model, usage, attempts } = await runMediaParse(auth, part, instruction, chain, signal, (a) => {
					attemptsLog = [...attemptsLog, a];
					ctx.ui.setStatus("mimo-omni", `🎬 ${a.model}：${a.note}`);
				});
				return {
					content: [{ type: "text", text }],
					details: { model, provider: auth.provider, source: params.path, instruction, usage, attempts },
				};
			} catch (e) {
				const summary = attemptsLog.length
					? `（尝试记录：${attemptsLog.map((a) => `${a.model}#${a.attempt} ${a.note}`).join("；")}）`
					: "";
				setStatusWithTTL(ctx, "mimo-omni", "⚠ 解析失败", 10_000);
				return {
					content: [{ type: "text", text: `解析失败（${auth.provider}）：${e instanceof Error ? e.message : String(e)}${summary}` }],
					details: {},
					isError: true,
				};
			} finally {
				ctx.ui.setStatus("mimo-omni", undefined);
			}
		},
	});

	pi.registerTool({
		name: "mimo_speak",
		annotations: { readOnlyHint: false },
		label: "合成语音",
		description: "把文字合成为语音文件并播放（可换音色；适合把较长内容念给用户听）。",
		promptSnippet: "合成语音：mimo_speak(text[, voice][, out][, play]) → 音频文件路径",
		parameters: Type.Object({
			text: Type.String({ description: "要合成的文字（建议口语化短句，不支持 markdown）" }),
			voice: Type.Optional(Type.String({ description: `音色，缺省 ${DEFAULT_VOICE}；可选 ${VOICES.join("/")}` })),
			out: Type.Optional(Type.String({ description: "输出 wav 路径（缺省写系统临时目录）" })),
			play: Type.Optional(Type.Boolean({ description: "是否立即播放，默认 true" })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			const auth = await resolveAuth(ctx);
			if (!auth) {
				return { content: [{ type: "text", text: MISSING_AUTH }], details: {}, isError: true };
			}
			const voice = params.voice ?? loadConfig().voice ?? DEFAULT_VOICE;
			if (params.voice && !VOICES.includes(params.voice)) {
				return { content: [{ type: "text", text: `未知音色 ${params.voice}；可选 ${VOICES.join(" / ")}` }], details: {}, isError: true };
			}
			onUpdate?.({ content: [{ type: "text", text: "正在合成语音…" }], details: {} });
			ctx.ui.setStatus("mimo-omni", "🔊 合成语音中");
			try {
				const wav = await mimoTts(auth, params.text, voice, _signal);
				const out = params.out ?? path.join(os.tmpdir(), `mimo-speak-${Date.now()}.wav`);
				fs.mkdirSync(path.dirname(out), { recursive: true });
				fs.writeFileSync(out, wav);
				const shouldPlay = params.play !== false;
				let played = false;
				if (shouldPlay) {
					try {
						await playAudio(out, _signal);
						played = true;
					} catch (e) {
						/* 播放失败不算功能失败：文件已生成 */
						ctx.ui.notify(`播放失败（音频已存到 ${out}）：${e instanceof Error ? e.message : String(e)}`, "warning");
					}
				}
				const secs = (wav.length - 44) / 2 / 24000;
				return {
					content: [{ type: "text", text: `已生成语音（${secs.toFixed(1)} 秒，音色 ${voice}）：${out}${played ? "（已播放）" : ""}` }],
					details: { path: out, voice, seconds: Number(secs.toFixed(2)), played, provider: auth.provider },
				};
			} catch (e) {
				setStatusWithTTL(ctx, "mimo-omni", "⚠ 合成失败", 10_000);
				return { content: [{ type: "text", text: `合成失败（${auth.provider}）：${e instanceof Error ? e.message : String(e)}` }], details: {}, isError: true };
			} finally {
				ctx.ui.setStatus("mimo-omni", undefined);
			}
		},
	});
}
