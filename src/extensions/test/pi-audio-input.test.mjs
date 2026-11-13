/**
 * apply-pi-audio-input 补丁的行为验证（离线，不联网）。
 *
 * 验证的是「打完补丁以后 pi 会怎么处理媒体块」这三件事：
 *   1. 全模态模型：audio / video 块被拼成 input_audio / video_url（user 与 toolResult 两条路径）
 *   2. 不支持该模态的模型：换成占位文本，不报错、不丢消息结构
 *   3. read 工具读音视频文件时产出媒体块；不支持时附上提示
 *
 * 它直接跑在**已安装的 pi 产物**上（补丁的目标），所以必须先 `node install.js`（代跑补丁）。
 * 补丁没打时会明确报出来，而不是静默通过。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { piPackageDir } from "../../../static/patches/pi-root.mjs";

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		return;
	}
	failed++;
	console.log(`  ✗ ${name}${detail ? `  ${detail}` : ""}`);
};

const AI = piPackageDir("@earendil-works/pi-ai");
const CODING = piPackageDir("@earendil-works/pi-coding-agent");
const asUrl = (p) => `file:///${p.replaceAll("\\", "/")}`;

// 补丁是否已打
const patched = [
	path.join(AI, "dist", "api", "transform-messages.js"),
	path.join(AI, "dist", "api", "openai-completions.js"),
	path.join(CODING, "dist", "core", "tools", "read.js"),
].every((f) => fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("PATCH(audio-input)"));
if (!patched) {
	console.error("补丁未打（先跑 node install.js 或 node static/patches/apply-pi-audio-input.mjs）");
	process.exit(1);
}

const { convertMessages } = await import(asUrl(path.join(AI, "dist", "api", "openai-completions.js")));
const { createReadToolDefinition } = await import(asUrl(path.join(CODING, "dist", "core", "tools", "read.js")));

const COMPAT = {
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	supportsDeveloperRole: false,
	requiresAssistantAfterToolResult: false,
	requiresToolResultName: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsThinkingTokenBudget: false,
	maxTokensField: "max_completion_tokens",
};
const MODEL = {
	id: "mimo-test",
	name: "test",
	api: "openai-completions",
	provider: "xiaomi-token-plan-cn",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 8192,
};
const AUDIO = { type: "audio", data: "data:audio/wav;base64,QUJD", durationSec: 3.7 };
const VIDEO = { type: "video", data: "data:video/mp4;base64,REVG", fps: 2, durationSec: 10 };
const model = (input) => ({ ...MODEL, input });

const userCtx = (content) => ({ systemPrompt: "s", tools: [], messages: [{ role: "user", content, timestamp: 1 }] });
const toolCtx = (block) => ({
	systemPrompt: "s",
	tools: [],
	messages: [
		{ role: "user", content: [{ type: "text", text: "读" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "toolUse",
			timestamp: 2,
		},
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [block], isError: false, timestamp: 3 },
	],
});
const wire = (input, ctx) => JSON.stringify(convertMessages(model(input), ctx, COMPAT, {}));

console.log("全模态模型：媒体块按原生形状发出去");
{
	const w = wire(["text", "image", "audio", "video"], userCtx([{ type: "text", text: "看" }, AUDIO, VIDEO]));
	check("user 消息里的音频 → input_audio", w.includes('"input_audio"') && w.includes(AUDIO.data));
	check("user 消息里的视频 → video_url + fps", w.includes('"video_url"') && w.includes('"fps":2'));
	check("视频带 media_resolution", w.includes('"media_resolution":"default"'));
}
{
	const wa = wire(["text", "image", "audio", "video"], toolCtx(AUDIO));
	check("toolResult 音频 → 独立的 user 消息携带", wa.includes("Attached audio from tool result"));
	check("toolResult 音频 → input_audio 块", wa.includes('"input_audio"'));
	const wv = wire(["text", "image", "audio", "video"], toolCtx(VIDEO));
	check("toolResult 视频 → video_url 块", wv.includes('"video_url"'));
}

console.log("不支持该模态的模型：换成占位文本");
{
	const w = wire(["text"], userCtx([{ type: "text", text: "看" }, AUDIO, VIDEO]));
	check("音频降级为占位文本", w.includes("audio omitted: model does not support audio input"));
	check("视频降级为占位文本", w.includes("video omitted: model does not support video input"));
	check("原始媒体数据不再出现在请求里", !w.includes(AUDIO.data) && !w.includes(VIDEO.data));
}
{
	const w = wire(["text", "image", "audio"], userCtx([AUDIO, VIDEO]));
	check("仅缺视频能力时音频照常发出", w.includes('"input_audio"') && !w.includes('"video_url"'));
	check("仅缺视频能力时视频降级", w.includes("video omitted"));
}
{
	const w = wire(["text"], toolCtx(AUDIO));
	check("toolResult 音频降级为占位文本", w.includes("tool audio omitted"));
}

console.log("read 工具：媒体文件产出媒体块");
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-audio-input-test-"));
	const wav = path.join(dir, "probe.wav");
	fs.writeFileSync(wav, Buffer.from("RIFF....WAVEfmt ", "utf8"));
	const tool = createReadToolDefinition(dir);

	const full = await tool.execute("t1", { path: "probe.wav" }, undefined, undefined, {
		model: model(["text", "image", "audio", "video"]),
		cwd: dir,
	});
	check("音频文件 → audio 块", full.content.some((b) => b.type === "audio"));
	check("audio 块带 data URL", full.content.some((b) => b.type === "audio" && b.data.startsWith("data:audio/wav;base64,")));
	check("随附说明文本", full.content.some((b) => b.type === "text" && b.text.includes("audio")));

	const textOnly = await tool.execute("t2", { path: "probe.wav" }, undefined, undefined, {
		model: model(["text"]),
		cwd: dir,
	});
	check(
		"纯文本模型读音频时给出省略提示",
		textOnly.content.some((b) => b.type === "text" && b.text.includes("does not support audio input")),
	);

	const txt = path.join(dir, "note.txt");
	fs.writeFileSync(txt, "hello\nworld\n");
	const plain = await tool.execute("t3", { path: "note.txt" }, undefined, undefined, { model: model(["text"]), cwd: dir });
	check("普通文本文件仍走文本分支", plain.content.length === 1 && plain.content[0].type === "text");

	fs.rmSync(dir, { recursive: true, force: true });
}


// 主会话跑的是压缩 bundle，上面的 import 只覆盖未压缩 dist——两套产物必须都打
console.log("压缩产物：主会话实际加载的那套也已打补丁");
{
	const chunks = path.join(CODING, "dist", "bundle", "chunks");
	const all = fs.existsSync(chunks)
		? fs.readdirSync(chunks).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(chunks, f), "utf8")).join(String.fromCharCode(10))
		: "";
	check("bundle 里有音频/视频模态声明", all.includes('MODEL_INPUT_MODALITIES=["text","image","audio","video"]'));
	check("bundle 里有媒体降级逻辑", all.includes("replaceMediaWithPlaceholder"));
	check("bundle 里有媒体块线上形状", all.includes("mediaBlockToWirePart"));
	check("bundle read 工具能产媒体块", all.includes("detectMediaKind"));
	check("bundle 估算折算媒体", all.includes("estimateMediaChars") || all.includes("durationSec"));
}

console.log(failed === 0 ? "\n全部通过。" : `\n${failed} 项失败。`);
process.exit(failed === 0 ? 0 : 1);
