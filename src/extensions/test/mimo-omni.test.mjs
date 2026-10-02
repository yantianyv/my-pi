/**
 * mimo-omni 回归测试：媒体内容块的构造（纯离线）
 *
 * 锁住的不变量：
 * - 扩展名 → 类型判定（音频/视频；不认识返回 undefined）
 * - 本地音频 → input_audio；本地视频 → video_url（fps/resolution 透传）
 * - URL 直传不读盘
 * - 超大文件提前拦截（不白传一遍）
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

const args = process.argv.slice(2);
const audioPath = args[0];
const videoPath = args[1];
if (audioPath && videoPath) {
	console.log("三、本地文件（真实文件）");
	const a = buildMediaPart(audioPath);
	check("本地音频 → input_audio + data URI", a.type === "input_audio" && String(a.input_audio.data).startsWith("data:audio/wav;base64,"));
	const v = buildMediaPart(videoPath);
	check("本地视频 → video_url + data URI", v.type === "video_url" && String(v.video_url.url).startsWith("data:video/mp4;base64,"));

	console.log("四、错误处理");
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
	console.log("五、联测（真实调用 API）");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf-8"));
	const key = auth.xiaomi?.key;
	for (const [label, file, extra] of [
		["音频解析", audioPath, {}],
		["视频解析", videoPath, { fps: 2 }],
	]) {
		if (!file) continue;
		const part = buildMediaPart(file, extra);
		try {
			// 走真实解析链（模型降级 + 空正文重试），这才是工具实际路径
			const { text, model, usage, attempts } = await mod.runMediaParse(
				key,
				part,
				"把内容转成逐字稿；没有语音就描述画面。",
				["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5"],
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
