/**
 * mimo-omni: 媒体兼容层——让 AI 能「听音频 / 看视频 / 说话」（走小米 MiMo 开放平台）
 *
 * 为什么需要这一层：pi 的消息类型只有 text / image，全模态模型的原生音频、视频输入
 * 暂时进不了上下文，也没有录音播放能力。所以这里用两个工具把能力补上：
 *   mimo_transcribe：给音频/视频，返回逐字稿或按指定要求解析（音频 6.25 token/秒，视频按帧计）
 *   mimo_speak     ：给文字，合成语音文件（可选直接播放）
 *
 * 它是过渡兼容层：等 pi 的消息类型支持音频后，这一层应整体撤掉，让主模型直接听。
 * 定位上它不做任何判断——只做媒介转换，判断与决策留给主会话。
 *
 * 音频：wav/mp3/m4a/flac/ogg/aac/opus；视频：mp4/mov/avi/wmv（fps、media_resolution 可调）
 * 官方限制：base64 传入 ≤50MB（本层按 45MB 留余量拦截）；URL 传入音频 ≤100MB、视频 ≤300MB
 *
 * - /mimo-config          TUI 面板：设置解析模型与合成音色（带参数可直接设置，如 /mimo-config model <id>）
 * - API Key：pi 注册表的 xiaomi provider → ~/.pi/agent/auth.json → 环境变量 MIMO_API_KEY
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------- 可调配置 ----------------
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "mimo-omni.json");
const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MODEL = "mimo-v2.6-flash"; // 最便宜档；解析质量要求高时 /mimo-config 换 pro
const FALLBACK_MODELS = ["mimo-v2.6-pro", "mimo-v2.5"];
const TTS_MODEL = "mimo-v2.5-tts";
const DEFAULT_VOICE = "mimo_default";
const VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
/** 模型选择面板候选（带价格/稳定性提示，避免误选贵档） */
const MODEL_CHOICES = [
	{ id: "mimo-v2.6-flash", label: "mimo-v2.6-flash（最便宜，偶发空回复）" },
	{ id: "mimo-v2.6-pro", label: "mimo-v2.6-pro（推荐，稳定）" },
	{ id: "mimo-v2.6-pro-ultraspeed", label: "mimo-v2.6-pro-ultraspeed（最快，价格 10 倍）" },
	{ id: "mimo-v2.5", label: "mimo-v2.5（上一代）" },
];
const MAX_BASE64_MB = 45; // 官方上限 50MB（base64 字符串），留余量提前拦截
const MAX_OUTPUT_TOKENS = 8192; // 思考型模型会先烧思考 token，留足空间防空正文
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

function loadConfig(): MimoConfig {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
	} catch {
		return {};
	}
}

function saveConfig(cfg: MimoConfig) {
	try {
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
	} catch {
		/* 配置保存失败不阻断功能 */
	}
}

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

/** MiMo API Key：pi 注册表 → auth.json → 环境变量 */
async function resolveKey(ctx: ExtensionContext): Promise<string | undefined> {
	if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY;
	for (const provider of ["xiaomi", "xiaomi-token-plan-cn"]) {
		try {
			const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
			if (key) return key;
		} catch {
			/* 试下一个来源 */
		}
	}
	try {
		const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf-8"));
		return auth["xiaomi"]?.key ?? auth["xiaomi-token-plan-cn"]?.key;
	} catch {
		return undefined;
	}
}

/** 非流式单轮调用（解析/合成通用）：返回 choices[0].message.content */
export async function mimoChat(
	apiKey: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ text: string; usage: Record<string, unknown> | undefined }> {
	const res = await fetch(`${MIMO_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
export async function mimoTts(apiKey: string, text: string, voice: string): Promise<Buffer> {
	const res = await fetch(`${MIMO_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: TTS_MODEL,
			messages: [{ role: "assistant", content: text }],
			audio: { format: "wav", voice },
		}),
	});
	if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const j = (await res.json()) as { choices?: Array<{ message?: { audio?: { data?: string } } }> };
	const b64 = j.choices?.[0]?.message?.audio?.data;
	if (!b64) throw new Error("TTS 未返回音频数据");
	return Buffer.from(b64, "base64");
}

/** 播放音频文件（平台自带播放器，零额外依赖） */
function playAudio(file: string): Promise<void> {
	const cmd =
		process.platform === "win32"
			? { bin: "powershell", args: ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${file}').PlaySync()`] }
			: process.platform === "darwin"
				? { bin: "afplay", args: [file] }
				: { bin: "paplay", args: [file] };
	return new Promise((resolve, reject) => {
		execFile(cmd.bin, cmd.args, { timeout: PLAY_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
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
	apiKey: string,
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
					apiKey,
					{
						model,
						max_tokens: MAX_OUTPUT_TOKENS,
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
					`解析模型：${cfg.model ?? DEFAULT_MODEL}`,
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
		label: "解析音频/视频",
		description:
			"解析本地音频/视频（或公网 URL）：返回逐字稿，或按 prompt 指定要求解析（要点、行动项、时间轴）。" +
			"音频 wav/mp3/m4a/flac/ogg/aac/opus，视频 mp4/mov/avi/wmv；本地文件上限 45MB，超大改用 URL。",
		promptSnippet: "解析音频/视频：mimo_transcribe(path[, prompt][, fps][, resolution]) → 文本",
		parameters: Type.Object({
			path: Type.String({ description: "本地文件路径或公网 http(s) URL" }),
			prompt: Type.Optional(Type.String({ description: "解析要求（缺省输出完整逐字稿），如「提取行动项与负责人」" })),
			fps: Type.Optional(Type.Number({ description: "视频抽帧率 0.1~10，默认 2（越高越准也越贵）", minimum: 0.1, maximum: 10 })),
			resolution: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("max")], { description: "视频单帧分辨率，默认 default" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const apiKey = await resolveKey(ctx);
			if (!apiKey) {
				return { content: [{ type: "text", text: "缺少小米 MiMo API Key（请在 pi 里登录 xiaomi provider，或设置 MIMO_API_KEY）" }], details: {}, isError: true };
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
				const { text, model, usage, attempts } = await runMediaParse(apiKey, part, instruction, chain, signal, (a) => {
					attemptsLog = [...attemptsLog, a];
					ctx.ui.setStatus("mimo-omni", `🎬 ${a.model}：${a.note}`);
				});
				const tokens = usage ? `（用量 ${JSON.stringify(usage)}）` : "";
				return {
					content: [{ type: "text", text: `${text}

—— 由 ${model} 解析${tokens}` }],
					details: { model, source: params.path, instruction, usage, attempts },
				};
			} catch (e) {
				const summary = attemptsLog.length
					? `（尝试记录：${attemptsLog.map((a) => `${a.model}#${a.attempt} ${a.note}`).join("；")}）`
					: "";
				return {
					content: [{ type: "text", text: `解析失败：${e instanceof Error ? e.message : String(e)}${summary}` }],
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
			const apiKey = await resolveKey(ctx);
			if (!apiKey) {
				return { content: [{ type: "text", text: "缺少小米 MiMo API Key（请在 pi 里登录 xiaomi provider，或设置 MIMO_API_KEY）" }], details: {}, isError: true };
			}
			const voice = params.voice ?? loadConfig().voice ?? DEFAULT_VOICE;
			if (params.voice && !VOICES.includes(params.voice)) {
				return { content: [{ type: "text", text: `未知音色 ${params.voice}；可选 ${VOICES.join(" / ")}` }], details: {}, isError: true };
			}
			onUpdate?.({ content: [{ type: "text", text: "正在合成语音…" }], details: {} });
			ctx.ui.setStatus("mimo-omni", "🔊 合成语音中");
			try {
				const wav = await mimoTts(apiKey, params.text, voice);
				const out = params.out ?? path.join(os.tmpdir(), `mimo-speak-${Date.now()}.wav`);
				fs.mkdirSync(path.dirname(out), { recursive: true });
				fs.writeFileSync(out, wav);
				const shouldPlay = params.play !== false;
				let played = false;
				if (shouldPlay) {
					try {
						await playAudio(out);
						played = true;
					} catch (e) {
						/* 播放失败不算功能失败：文件已生成 */
						ctx.ui.notify(`播放失败（音频已存到 ${out}）：${e instanceof Error ? e.message : String(e)}`, "warning");
					}
				}
				const secs = (wav.length - 44) / 2 / 24000;
				return {
					content: [{ type: "text", text: `已生成语音（${secs.toFixed(1)} 秒，音色 ${voice}）：${out}${played ? "（已播放）" : ""}` }],
					details: { path: out, voice, seconds: Number(secs.toFixed(2)), played },
				};
			} catch (e) {
				return { content: [{ type: "text", text: `合成失败：${e instanceof Error ? e.message : String(e)}` }], details: {}, isError: true };
			} finally {
				ctx.ui.setStatus("mimo-omni", undefined);
			}
		},
	});
}
