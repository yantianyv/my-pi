/**
 * mimo-omni 回归测试：媒体内容块的构造（纯离线）
 *
 * 锁住的不变量：
 * - 扩展名 → 类型判定（音频/视频；不认识返回 undefined）
 * - 本地音频 → input_audio；本地视频 → video_url（fps/resolution 透传）
 * - URL 直传不读盘
 * - 超大文件提前拦截（不白传一遍）
 * - 凭证通道：Token Plan provider 优先，端点跟着 provider 走（两种 key 不能串用）
 *
 * 可选联测：MIMO_LIVE=1 时用真实文件打一次 API（默认跳过，避免联网/花钱）。
 * 运行：node src/extensions/test/mimo-omni.test.mjs [音频路径] [视频路径]
 */
import { build } from "esbuild";
import { rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "mimo-omni.ts");
const OUT = join(HERE, ".tmp-mimo-omni-bundle.mjs");

const results = [];
function check(label, ok, extra) {
	results.push({ label, ok, extra });
	console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || extra === undefined ? "" : ` :: ${extra}`}`);
}

await build({
	entryPoints: [EXT],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: OUT,
	external: ["@earendil-works/*", "typebox"],
	logLevel: "silent",
});
const mod = await import(pathToFileURL(OUT).href);
const { buildMediaPart, detectMediaKind } = mod;

console.log("一、扩展名判定");
check("wav → audio", detectMediaKind("a.wav")?.kind === "audio");
check("mp3 → audio", detectMediaKind("a.MP3")?.kind === "audio");
check("mp4 → video", detectMediaKind("a.mp4")?.kind === "video");
check("mov → video", detectMediaKind("a.mov")?.kind === "video");
check("txt → 不支持", detectMediaKind("a.txt") === undefined);
check("URL 带查询串也能识别", detectMediaKind("https://x.com/a.wav?token=1")?.kind === "audio");

console.log("二、内容块构造");
const urlPart = buildMediaPart("https://example.com/a.mp3");
check("URL 音频 → input_audio", urlPart.type === "input_audio" && urlPart.input_audio.data === "https://example.com/a.mp3");
const urlVideo = buildMediaPart("https://example.com/a.mp4", { fps: 4, resolution: "max" });
check("URL 视频 → video_url", urlVideo.type === "video_url");
check("fps 透传", urlVideo.fps === 4, `fps=${urlVideo.fps}`);
check("resolution 透传", urlVideo.media_resolution === "max");
check("默认 fps=2", buildMediaPart("https://example.com/a.mp4").fps === 2);

console.log("三、取消信号与端点透传");
{
	const controller = new AbortController();
	let seenSignal;
	let seenUrl;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		seenUrl = String(url);
		seenSignal = init?.signal;
		return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from("RIFF").toString("base64") } } }] }) };
	};
	try {
		const auth = { apiKey: "test-key", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", provider: "xiaomi-token-plan-cn" };
		await mod.mimoTts(auth, "测试", "mimo_default", controller.signal);
		check("TTS fetch 使用调用方 AbortSignal", seenSignal === controller.signal);
		check("TTS 打到凭证的 baseUrl", seenUrl === "https://token-plan-cn.xiaomimimo.com/v1/chat/completions", seenUrl);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

console.log("四、凭证通道优先级");
{
	const model = (provider, baseUrl) => ({ provider, id: "mimo-v2.6-flash", baseUrl });
	const fakeCtx = (configured, providerBases = {}) => ({
		modelRegistry: {
			find: (provider, id) => configured[provider]?.models.find((m) => m.id === id),
			getModelsOfType: (_type, provider) => configured[provider]?.models ?? [],
			hasConfiguredAuth: (m) => !!configured[m.provider],
			getApiKeyAndHeaders: async (m) => ({ ok: true, apiKey: configured[m.provider].key, headers: { "x-trace": "1", "x-drop": null } }),
			getProvider: (provider) => ({ id: provider, baseUrl: providerBases[provider] }),
		},
	});
	const savedEnv = process.env.MIMO_API_KEY;
	delete process.env.MIMO_API_KEY;
	try {
		const both = await mod.resolveAuth(fakeCtx({
			xiaomi: { key: "sk-payg", models: [model("xiaomi", "https://api.xiaomimimo.com/v1")] },
			"xiaomi-token-plan-cn": { key: "tp-plan", models: [model("xiaomi-token-plan-cn", "https://token-plan-cn.xiaomimimo.com/v1")] },
		}));
		check("两种凭证都在时选 Token Plan", both?.provider === "xiaomi-token-plan-cn", both?.provider);
		check("端点随 Token Plan provider", both?.baseUrl === "https://token-plan-cn.xiaomimimo.com/v1", both?.baseUrl);
		check("头表过滤 null 值", both?.headers?.["x-trace"] === "1" && both?.headers?.["x-drop"] === undefined);

		const onlyPayg = await mod.resolveAuth(fakeCtx({ xiaomi: { key: "sk-payg", models: [model("xiaomi", "https://api.xiaomimimo.com/v1")] } }));
		check("只有按量付费时用它", onlyPayg?.provider === "xiaomi" && onlyPayg?.baseUrl === "https://api.xiaomimimo.com/v1", JSON.stringify(onlyPayg));

		const none = await mod.resolveAuth(fakeCtx({}));
		check("都没配置时返回 undefined", none === undefined);

		// 环境变量直供：registry 有凭证时让位给 registry，全无凭证时才用环境变量
		process.env.MIMO_API_KEY = "tp-env-key";
		try {
			const envWithRegistry = await mod.resolveAuth(fakeCtx({
				"xiaomi-token-plan-cn": { key: "tp-plan", models: [model("xiaomi-token-plan-cn", "https://token-plan-cn.xiaomimimo.com/v1")] },
			}));
			check("registry 有凭证时不用环境变量", envWithRegistry?.apiKey === "tp-plan", JSON.stringify(envWithRegistry));

			const envTp = await mod.resolveAuth(fakeCtx({}, { "xiaomi-token-plan-cn": "https://token-plan-cn.xiaomimimo.com/v1" }));
			check("环境变量 tp- key 走 Token Plan 端点", envTp?.provider === "xiaomi-token-plan-cn" && envTp?.baseUrl === "https://token-plan-cn.xiaomimimo.com/v1", JSON.stringify(envTp));

			process.env.MIMO_API_KEY = "sk-env-key";
			const envPayg = await mod.resolveAuth(fakeCtx({}, { xiaomi: "https://api.xiaomimimo.com/v1" }));
			check("环境变量 sk- key 走按量付费端点", envPayg?.provider === "xiaomi" && envPayg?.baseUrl === "https://api.xiaomimimo.com/v1", JSON.stringify(envPayg));

			process.env.MIMO_API_KEY = "tp-env-key";
			process.env.MIMO_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";
			const envOverride = await mod.resolveAuth(fakeCtx({}));
			check("MIMO_BASE_URL 可覆盖集群端点", envOverride?.baseUrl === "https://token-plan-sgp.xiaomimimo.com/v1", JSON.stringify(envOverride));
		} finally {
			delete process.env.MIMO_BASE_URL;
		}
	} finally {
		if (savedEnv === undefined) delete process.env.MIMO_API_KEY;
		else process.env.MIMO_API_KEY = savedEnv;
	}
}

const args = process.argv.slice(2);
const audioPath = args[0];
const videoPath = args[1];
if (audioPath && videoPath) {
	console.log("五、本地文件（真实文件）");
	const a = buildMediaPart(audioPath);
	check("本地音频 → input_audio + data URI", a.type === "input_audio" && String(a.input_audio.data).startsWith("data:audio/wav;base64,"));
	const v = buildMediaPart(videoPath);
	check("本地视频 → video_url + data URI", v.type === "video_url" && String(v.video_url.url).startsWith("data:video/mp4;base64,"));

	console.log("六、错误处理");
	let err = "";
	try {
		buildMediaPart("不存在的文件.wav");
	} catch (e) {
		err = String(e.message);
	}
	check("文件不存在时报错", err.includes("文件不存在"), err.slice(0, 40));
	let err2 = "";
	try {
		buildMediaPart("src/package.json");
	} catch (e) {
		err2 = String(e.message);
	}
	check("不支持的格式报错", err2.includes("不支持的媒体格式"), err2.slice(0, 40));
	check("测试视频确实不大（可 base64 传入）", statSync(videoPath).size < 45 * 1024 * 1024);
}

if (process.env.MIMO_LIVE === "1" && audioPath) {
	console.log("七、联测（真实调用 API）");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const creds = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf-8"));
	// 与插件同口径：Token Plan 优先
	const liveProvider = ["xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams"].find((p) => creds[p]?.key) ?? "xiaomi";
	const liveAuth = {
		apiKey: creds[liveProvider].key,
		baseUrl: liveProvider === "xiaomi" ? "https://api.xiaomimimo.com/v1" : `https://token-plan-${liveProvider.slice("xiaomi-token-plan-".length)}.xiaomimimo.com/v1`,
		provider: liveProvider,
	};
	console.log(`     通道：${liveAuth.provider}`);
	for (const [label, file, extra] of [
		["音频解析", audioPath, {}],
		["视频解析", videoPath, { fps: 2 }],
	]) {
		if (!file) continue;
		const part = buildMediaPart(file, extra);
		try {
			// 走真实解析链（模型降级 + 空正文重试），这才是工具实际路径
			const { text, model, usage, attempts } = await mod.runMediaParse(
				liveAuth,
				part,
				"把内容转成逐字稿；没有语音就描述画面。",
				["mimo-v2.6-flash", "mimo-v2.6-pro"],
				AbortSignal.timeout(180_000),
			);
			check(`${label}返回非空文本`, text.trim().length > 0, text.trim().slice(0, 60));
			console.log(`     用时模型：${model}｜尝试：${attempts.map((a) => `${a.model}#${a.attempt}=${a.note}`).join(", ")}`);
			console.log(`     实际输出：${text.trim().slice(0, 200).split("\n").join(" / ")}`);
			console.log(`     用量：${JSON.stringify(usage)}`);
		} catch (e) {
			check(`${label}调用成功`, false, String(e.message).slice(0, 120));
		}
	}
}

rmSync(OUT, { force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
