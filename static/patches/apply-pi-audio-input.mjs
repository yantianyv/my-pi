/**
 * pi 媒体输入补丁（audio-input）
 *
 * 背景：pi 的消息内容类型只有 text 与 image，全模态模型（当前是小米 MiMo）原生的音频、
 * 视频输入进不了上下文，只能先用 mimo_transcribe 把媒体转成文字——语气、音色、旋律走向
 * 这些只存在于媒体里的信息在转换那一步就永久丢掉了。本补丁把 `audio` / `video` 内容块
 * 打通到 openai-completions 的请求体，让媒体本体进对话上下文（可多轮、可被 /resume 还原）。
 *
 * 上游接口（MiMo 官方文档，均实测过）：
 *   音频 `{ type: "input_audio", input_audio: { data } }`，data 为 data URL 或公网 URL，
 *        ≈6.25 token/秒，base64 字符串上限 50MB、URL 上限 100MB
 *   视频 `{ type: "video_url", video_url: { url }, fps, media_resolution }`，
 *        按抽帧计费（单帧上限 300 token），base64 字符串上限 50MB、URL 上限 300MB
 *
 * 打的四处（一套语义，缺一不可）：
 *   1. model-schema：`MODEL_INPUT_MODALITIES` 加 "audio" / "video"。不加则 models.json 里
 *      给模型声明这些能力会被 schema 判非法，整份 models.json 被拒（pi 静默退回内置目录）。
 *   2. transform-messages：降级判据从单一的 image 拆成 image / audio / video 三个独立判据，
 *      各自替换成占位文本。切到不支持某个模态的模型时，行为与图片降级完全一致：
 *      换成占位文本，不报错、不丢上下文结构。
 *   3. openai-completions：user 与 toolResult 分支各加 audio / video 分支。原代码是
 *      「非 text 一律当 image_url」，新块不加分支会被拼成 `data:undefined` 发出去。
 *   4. 估算：`estimateTextAndImageContentChars` 补媒体分支，按块的 durationSec 折算 token。
 *      不补的话媒体块按图片的固定 4800 字符记账——几分钟的录音会被严重低估，压缩阈值失准；
 *      若改按 base64 长度记账则会反向爆掉（1 分钟 mp3 的 base64 就有上百万字符）。
 *
 * 目标文件两套：主会话跑 `dist/bundle/chunks/*.js` 压缩产物（文件名带哈希，本脚本按内容
 * 探测，不写死名字）；扩展与子代理（jiti 别名表）和测试跑 `dist/**.js` 未压缩产物。
 *
 * 用法：node static/patches/apply-pi-audio-input.mjs [--dry-run]
 * pi 升级会覆盖 node_modules，需重跑（install.js 每次安装代跑）。
 * 幂等：文件含 PATCH(audio-input) 标记即跳过。改完**重启 pi** 生效（/reload 不够）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { piPackageDir } from "./pi-root.mjs";

const MARKER = "PATCH(audio-input)";
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const AI = piPackageDir("@earendil-works/pi-ai");
const CODING = piPackageDir("@earendil-works/pi-coding-agent");
const CHUNKS = path.join(CODING, "dist", "bundle", "chunks");

let changed = 0;
let skipped = 0;
let failed = 0;


const aiFile = (...rel) => path.join(AI, "dist", ...rel);

/**
 * 写盘前确认新增代码引用的标识符在本文件里真的可用。
 * pi 的压缩产物把不同模块打进同一个文件，各 chunk 作用域里有哪些常量并不一致：
 * 曾因替换串里用了 CHARS_PER_TOKEN、而那个 chunk 只声明了 ESTIMATED_IMAGE_CHARS，
 * 语法检查通过（引用合法）、一运行就 ReferenceError 把 pi 崩掉。
 */
function refsResolve(src, target, label) {
	const missing = ["CHARS_PER_TOKEN"].filter((name) => {
		if (!src.includes(name)) return false;
		// 够用即可：只认「声明」与「有该字面量常量的 var」两种形态
		return !new RegExp(`(?:\\b(?:const|let|var)\\s+${name}\\b|${name}\\s*=)`).test(src);
	});
	if (missing.length === 0) return true;
	console.error(`  ⚠ ${label}：${path.basename(target)} 里没有声明 ${missing.join("、")}，替换后的代码会崩——已跳过`);
	failed++;
	return false;
}

/** 写盘前的语法校验：语法错的文件会让 pi 启动即崩，宁可跳过并告警。 */
function syntaxOk(src, target) {
	const tmp = path.join(os.tmpdir(), `pi-audio-input-check-${process.pid}.mjs`);
	fs.writeFileSync(tmp, src);
	const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
	fs.rmSync(tmp, { force: true });
	if (r.status === 0) return true;
	console.error(`  ⚠ 语法校验失败，已跳过写入 ${path.basename(target)}：`);
	console.error((r.stderr || "").split("\n").slice(0, 3).join("\n"));
	failed++;
	return false;
}

/**
 * 就地对一个文件应用一组替换（每项 [定位串, 替换串]，定位串必须命中，否则整份放弃）。
 * 任一处对不上就整份文件不写，避免留下半截补丁。
 */
function patchFile(target, label, edits) {
	if (!fs.existsSync(target)) {
		console.log(`  - ${label}：文件不存在，跳过 ${path.basename(target)}`);
		skipped++;
		return;
	}
	const src = fs.readFileSync(target, "utf8");
	// 逐项判三态，顺序不能反：先看替换结果是否已在位（多数替换串包含原文，先看原文会重复叠加），
	// 再看原文，两者都不在才算 pi 代码变了。不按整份文件的标记判断——同一个文件可能被多个小节
	// 依次修改，先打的小节会先盖上标记。
	let out = src;
	for (const [find, repl] of edits) {
		if (out.includes(repl)) continue;
		if (out.includes(find)) {
			out = out.replace(find, repl);
			continue;
		}
		const flat = find.replace(/\s+/g, " ").trim();
		console.error(
			`  ⚠ ${label}：目标片段已变（${flat.length > 70 ? `${flat.slice(0, 70)}…` : flat}）` +
				`（${path.basename(target)}）——pi 版本可能已变动，请人工核对`,
		);
		failed++;
		return;
	}
	if (out === src) {
		skipped++;
		return;
	}
	if (dryRun) {
		console.log(`  [dry-run] 将写入 ${label}：${path.basename(target)}`);
		changed++;
		return;
	}
	if (!syntaxOk(out, target)) return;
	if (!refsResolve(out, target, label)) return;
	fs.writeFileSync(target, out);
	console.log(`  ✓ ${label}：${path.basename(target)}`);
	changed++;
}

/** 在压缩产物里按内容查找命中文件（文件名带哈希，升级后会变），逐个应用。 */
function patchChunks(label, probe, edits) {
	if (!fs.existsSync(CHUNKS)) {
		console.error(`  ⚠ ${label}：找不到 ${CHUNKS}`);
		failed++;
		return;
	}
	const files = fs.readdirSync(CHUNKS).filter((f) => f.endsWith(".js"));
	const contents = new Map(files.map((f) => [f, fs.readFileSync(path.join(CHUNKS, f), "utf8")]));
	const hits = [...contents].filter(([, src]) => src.includes(probe)).map(([f]) => path.join(CHUNKS, f));
	if (hits.length === 0) {
		// 探测串本身就是被替换掉的原文：已经打完补丁时它自然消失，不算异常
		const already = [...contents].filter(([, src]) => src.includes(MARKER)).length;
		if (already > 0) {
			console.log(`  - ${label}：已打补丁，跳过`);
			skipped++;
			return;
		}
		console.error(`  ⚠ ${label}：没有压缩产物命中目标片段——pi 版本可能已变动`);
		failed++;
		return;
	}
	for (const f of hits) patchFile(f, label, edits);
}

// ---------------------------------------------------------------------------
// 1. model-schema：允许声明 audio / video 模态
// ---------------------------------------------------------------------------
console.log("[1/5] model-schema：MODEL_INPUT_MODALITIES 增加 audio / video");
patchFile(aiFile("providers", "model-schema.js"), "pi-ai model-schema", [
	[
		`export const MODEL_INPUT_MODALITIES = ["text", "image"];`,
		`// ${MARKER}: 增加 audio / video，让 models.json 能为全模态模型声明媒体输入能力
export const MODEL_INPUT_MODALITIES = ["text", "image", "audio", "video"];`,
	],
]);
patchChunks("bundle model-schema", 'MODEL_INPUT_MODALITIES=["text","image"]', [
	[
		'MODEL_INPUT_MODALITIES=["text","image"]',
		`MODEL_INPUT_MODALITIES=["text","image","audio","video"]/* ${MARKER} */`,
	],
]);

// ---------------------------------------------------------------------------
// 2. transform-messages：按模态独立降级
// ---------------------------------------------------------------------------
console.log("[2/5] transform-messages：audio / video 各自独立降级（切模型即降级，与图片同一语义）");
patchFile(aiFile("api", "transform-messages.js"), "pi-ai transform-messages", [
	[
		`const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";`,
		`const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
// ${MARKER}: 音频/视频沿用图片的降级语义——换成占位文本，不报错、不丢上下文结构
const NON_AUDIO_USER_PLACEHOLDER = "(audio omitted: model does not support audio input)";
const NON_AUDIO_TOOL_PLACEHOLDER = "(tool audio omitted: model does not support audio input)";
const NON_VIDEO_USER_PLACEHOLDER = "(video omitted: model does not support video input)";
const NON_VIDEO_TOOL_PLACEHOLDER = "(tool video omitted: model does not support video input)";`,
	],
	[
		`function replaceImagesWithPlaceholder(content, placeholder) {
    const result = [];
    let previousWasPlaceholder = false;
    for (const block of content) {
        if (block.type === "image") {
            if (!previousWasPlaceholder) {
                result.push({ type: "text", text: placeholder });
            }
            previousWasPlaceholder = true;
            continue;
        }
        result.push(block);
        previousWasPlaceholder = block.text === placeholder;
    }
    return result;
}`,
		`/**
 * ${MARKER}: 把 placeholders（按内容类型索引的占位文案）里列出的块换成占位文本。
 * 只列了某个模态的占位文案时才处理该模态，其余模态原样保留。
 */
function replaceMediaWithPlaceholder(content, placeholders) {
    const result = [];
    for (const block of content) {
        const placeholder = Object.hasOwn(placeholders, block.type) ? placeholders[block.type] : undefined;
        if (placeholder !== undefined) {
            // 只合并相邻的**同一个**占位：音频与视频的占位文案不同，各占一行才不会串成一句
            const last = result[result.length - 1];
            if (!(last && last.type === "text" && last.text === placeholder)) {
                result.push({ type: "text", text: placeholder });
            }
            continue;
        }
        result.push(block);
    }
    return result;
}
function replaceImagesWithPlaceholder(content, placeholder) {
    return replaceMediaWithPlaceholder(content, { image: placeholder });
}`,
	],
	[
		`function downgradeUnsupportedImages(messages, model) {
    if (model.input.includes("image")) {
        return messages;
    }
    return messages.map((msg) => {
        if (msg.role === "user" && Array.isArray(msg.content)) {
            return {
                ...msg,
                content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
            };
        }
        if (msg.role === "toolResult") {
            return {
                ...msg,
                content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
            };
        }
        return msg;
    });
}`,
		`function downgradeUnsupportedImages(messages, model) {
    // ${MARKER}: 各模态各判各的——只支持图片的模型照常丢音频，反之亦然
    const supports = (modality) => model.input.includes(modality);
    if (supports("image") && supports("audio") && supports("video")) {
        return messages;
    }
    return messages.map((msg) => {
        if (msg.role !== "user" && msg.role !== "toolResult") {
            return msg;
        }
        if (!Array.isArray(msg.content)) {
            return msg;
        }
        const isUser = msg.role === "user";
        const placeholders = {};
        if (!supports("image")) {
            placeholders.image = isUser ? NON_VISION_USER_IMAGE_PLACEHOLDER : NON_VISION_TOOL_IMAGE_PLACEHOLDER;
        }
        if (!supports("audio")) {
            placeholders.audio = isUser ? NON_AUDIO_USER_PLACEHOLDER : NON_AUDIO_TOOL_PLACEHOLDER;
        }
        if (!supports("video")) {
            placeholders.video = isUser ? NON_VIDEO_USER_PLACEHOLDER : NON_VIDEO_TOOL_PLACEHOLDER;
        }
        return { ...msg, content: replaceMediaWithPlaceholder(msg.content, placeholders) };
    });
}`,
	],
]);

const MIN_PLACEHOLDER_DECL =
	'ERROR_TOOL_IMAGE_PLACEHOLDER="(image attached after the tool results)";';
const MIN_REPLACE_FN =
	'function replaceImagesWithPlaceholder(content,placeholder){let result=[],previousWasPlaceholder=!1;for(let block of content){if(block.type==="image"){previousWasPlaceholder||result.push({type:"text",text:placeholder}),previousWasPlaceholder=!0;continue}result.push(block),previousWasPlaceholder=block.text===placeholder}return result}';
const MIN_DOWNGRADE =
	'function downgradeUnsupportedImages(messages,model){return model.input.includes("image")?messages:messages.map(msg=>msg.role==="user"&&Array.isArray(msg.content)?{...msg,content:replaceImagesWithPlaceholder(msg.content,NON_VISION_USER_IMAGE_PLACEHOLDER)}:msg.role==="toolResult"?{...msg,content:replaceImagesWithPlaceholder(msg.content,NON_VISION_TOOL_IMAGE_PLACEHOLDER)}:msg)}';
patchChunks("bundle transform-messages", MIN_DOWNGRADE, [
	[
		MIN_PLACEHOLDER_DECL,
		`${MIN_PLACEHOLDER_DECL.slice(0, -1)},NON_AUDIO_USER_PLACEHOLDER="(audio omitted: model does not support audio input)",NON_AUDIO_TOOL_PLACEHOLDER="(tool audio omitted: model does not support audio input)",NON_VIDEO_USER_PLACEHOLDER="(video omitted: model does not support video input)",NON_VIDEO_TOOL_PLACEHOLDER="(tool video omitted: model does not support video input)";/* ${MARKER} */`,
	],
	[
		MIN_REPLACE_FN,
		`function replaceMediaWithPlaceholder(content,placeholders){let result=[];for(let block of content){let placeholder=Object.hasOwn(placeholders,block.type)?placeholders[block.type]:void 0;if(placeholder!==void 0){let last=result[result.length-1];last&&last.type==="text"&&last.text===placeholder||result.push({type:"text",text:placeholder});continue}result.push(block)}return result}function replaceImagesWithPlaceholder(content,placeholder){return replaceMediaWithPlaceholder(content,{image:placeholder})}`,
	],
	[
		MIN_DOWNGRADE,
		`function downgradeUnsupportedImages(messages,model){/* ${MARKER} */let supports=modality=>model.input.includes(modality);if(supports("image")&&supports("audio")&&supports("video"))return messages;return messages.map(msg=>{if(msg.role!=="user"&&msg.role!=="toolResult")return msg;if(!Array.isArray(msg.content))return msg;let isUser=msg.role==="user",placeholders={};return supports("image")||(placeholders.image=isUser?NON_VISION_USER_IMAGE_PLACEHOLDER:NON_VISION_TOOL_IMAGE_PLACEHOLDER),supports("audio")||(placeholders.audio=isUser?NON_AUDIO_USER_PLACEHOLDER:NON_AUDIO_TOOL_PLACEHOLDER),supports("video")||(placeholders.video=isUser?NON_VIDEO_USER_PLACEHOLDER:NON_VIDEO_TOOL_PLACEHOLDER),{...msg,content:replaceMediaWithPlaceholder(msg.content,placeholders)}})}`,
	],
]);

// ---------------------------------------------------------------------------
// 3. openai-completions：user / toolResult 的 audio / video 分支
// ---------------------------------------------------------------------------
console.log("[3/5] openai-completions：user / toolResult 的 audio / video 分支");
patchFile(aiFile("api", "openai-completions.js"), "pi-ai openai-completions", [
	[
		`                    else {
                        return {
                            type: "image_url",
                            image_url: {
                                url: \`data:\${item.mimeType};base64,\${item.data}\`,
                            },
                        };
                    }
                });`,
		`                    else if (item.type === "audio") {
                        // ${MARKER}: 音频交回给模型原生听（MiMo 等全模态模型）
                        return mediaBlockToWirePart(item);
                    }
                    else if (item.type === "video") {
                        // ${MARKER}: 视频按抽帧送（fps / media_resolution 随块携带）
                        return mediaBlockToWirePart(item);
                    }
                    else {
                        return {
                            type: "image_url",
                            image_url: {
                                url: \`data:\${item.mimeType};base64,\${item.data}\`,
                            },
                        };
                    }
                });`,
	],
	[
		`function isImageContentBlock(block) {
    return block.type === "image";
}`,
		`function isImageContentBlock(block) {
    return block.type === "image";
}
/** ${MARKER}: audio / video 块的线上形状（MiMo 开放平台的 OpenAI 兼容扩展字段） */
function mediaBlockToWirePart(block) {
    if (block.type === "audio") {
        return { type: "input_audio", input_audio: { data: block.data } };
    }
    return {
        type: "video_url",
        video_url: { url: block.data },
        fps: block.fps ?? 2,
        media_resolution: block.resolution ?? "default",
    };
}`,
	],
	[
		`            const imageBlocks = [];
            let j = i;`,
		`            const imageBlocks = [];
            const mediaBlocks = [];
            let j = i;`,
	],
	[
		`                const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";`,
		`                // ${MARKER}: 纯媒体的工具结果也要有说明文本（兼容接口要求 tool 消息带 content）
                const mediaKind = toolMsg.content.some((c) => c.type === "audio")
                    ? "audio"
                    : toolMsg.content.some((c) => c.type === "video")
                        ? "video"
                        : undefined;
                const toolResultText = hasText
                    ? textResult
                    : hasImages
                        ? "(see attached image)"
                        : mediaKind
                            ? \`(see attached \${mediaKind})\`
                            : "(no tool output)";`,
	],
	[
		`                if (hasImages && model.input.includes("image")) {
                    for (const block of toolMsg.content) {
                        if (isImageContentBlock(block)) {
                            imageBlocks.push({
                                type: "image_url",
                                image_url: {
                                    url: \`data:\${block.mimeType};base64,\${block.data}\`,
                                },
                            });
                        }
                    }
                }`,
		`                if (hasImages && model.input.includes("image")) {
                    for (const block of toolMsg.content) {
                        if (isImageContentBlock(block)) {
                            imageBlocks.push({
                                type: "image_url",
                                image_url: {
                                    url: \`data:\${block.mimeType};base64,\${block.data}\`,
                                },
                            });
                        }
                    }
                }
                // ${MARKER}: 音频/视频与图片一样，排在所有 tool 消息之后用 user 消息携带
                for (const block of toolMsg.content) {
                    if ((block.type === "audio" || block.type === "video") && model.input.includes(block.type)) {
                        mediaBlocks.push({ kind: block.type, part: mediaBlockToWirePart(block) });
                    }
                }`,
	],
	[
		`            if (imageBlocks.length > 0) {
                if (compat.requiresAssistantAfterToolResult) {
                    params.push({
                        role: "assistant",
                        content: "I have processed the tool results.",
                    });
                }
                params.push({
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Attached image(s) from tool result:",
                        },
                        ...imageBlocks,
                    ],
                });
                lastRole = "user";
            }
            else {
                lastRole = "toolResult";
            }`,
		`            if (imageBlocks.length > 0 || mediaBlocks.length > 0) {
                if (compat.requiresAssistantAfterToolResult) {
                    params.push({
                        role: "assistant",
                        content: "I have processed the tool results.",
                    });
                }
                if (imageBlocks.length > 0) {
                    params.push({
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "Attached image(s) from tool result:",
                            },
                            ...imageBlocks,
                        ],
                    });
                }
                // ${MARKER}: 每种媒体单独一条 user 消息，说明文本才能指对类型
                for (const kind of ["audio", "video"]) {
                    const parts = mediaBlocks.filter((b) => b.kind === kind).map((b) => b.part);
                    if (parts.length === 0) {
                        continue;
                    }
                    params.push({
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: \`Attached \${kind} from tool result:\`,
                            },
                            ...parts,
                        ],
                    });
                }
                lastRole = "user";
            }
            else {
                lastRole = "toolResult";
            }`,
	],
]);

patchChunks("bundle openai-completions", 'let imageBlocks=[],j=i;', [
	[
		'let content=msg.content.filter(item=>item.type!=="text"||item.text.length>0).map(item=>item.type==="text"?{type:"text",text:sanitizeSurrogates(item.text)}:{type:"image_url",image_url:{url:`data:${item.mimeType};base64,${item.data}`}});',
		`let content=msg.content.filter(item=>item.type!=="text"||item.text.length>0).map(item=>item.type==="text"?{type:"text",text:sanitizeSurrogates(item.text)}:item.type==="audio"||item.type==="video"?mediaBlockToWirePart(item):{type:"image_url",image_url:{url:\`data:\${item.mimeType};base64,\${item.data}\`}});/* ${MARKER} */`,
	],
	[
		'function isImageContentBlock(block){return block.type==="image"}',
		`function isImageContentBlock(block){return block.type==="image"}function mediaBlockToWirePart(block){return block.type==="audio"?{type:"input_audio",input_audio:{data:block.data}}:{type:"video_url",video_url:{url:block.data},fps:block.fps??2,media_resolution:block.resolution??"default"}}/* ${MARKER} */`,
	],
	["let imageBlocks=[],j=i;", "let imageBlocks=[],mediaBlocks=[],j=i;"],
	[
		'hasImages=toolMsg.content.some(c=>c.type==="image"),toolResultText=textResult.trim().length>0?textResult:hasImages?"(see attached image)":"(no tool output)"',
		'hasImages=toolMsg.content.some(c=>c.type==="image"),mediaKind=toolMsg.content.some(c=>c.type==="audio")?"audio":toolMsg.content.some(c=>c.type==="video")?"video":void 0,toolResultText=textResult.trim().length>0?textResult:hasImages?"(see attached image)":mediaKind?`(see attached ${mediaKind})`:"(no tool output)"',
	],
	[
		'isImageContentBlock(block)&&imageBlocks.push({type:"image_url",image_url:{url:`data:${block.mimeType};base64,${block.data}`}})}',
		'isImageContentBlock(block)&&imageBlocks.push({type:"image_url",image_url:{url:`data:${block.mimeType};base64,${block.data}`}});for(let block of toolMsg.content)(block.type==="audio"||block.type==="video")&&model.input.includes(block.type)&&mediaBlocks.push({kind:block.type,part:mediaBlockToWirePart(block)})}',
	],
	[
		'i=j-1,imageBlocks.length>0?(compat.requiresAssistantAfterToolResult&&params.push({role:"assistant",content:"I have processed the tool results."}),params.push({role:"user",content:[{type:"text",text:"Attached image(s) from tool result:"},...imageBlocks]}),lastRole="user"):lastRole="toolResult"',
		`i=j-1,imageBlocks.length>0||mediaBlocks.length>0?(compat.requiresAssistantAfterToolResult&&params.push({role:"assistant",content:"I have processed the tool results."}),imageBlocks.length>0&&params.push({role:"user",content:[{type:"text",text:"Attached image(s) from tool result:"},...imageBlocks]}),["audio","video"].forEach(kind=>{let parts=mediaBlocks.filter(b=>b.kind===kind).map(b=>b.part);parts.length>0&&params.push({role:"user",content:[{type:"text",text:\`Attached \${kind} from tool result:\`},...parts]})}),lastRole="user"):lastRole="toolResult"/* ${MARKER} */`,
	],
]);

// ---------------------------------------------------------------------------
// 4. read 工具：读媒体文件时产出 audio / video 块
// ---------------------------------------------------------------------------
console.log("[4/5] read 工具：音频 / 视频文件产出声音块（模型可直接听/看）");
const READ_MEDIA_HELPER = `/**
 * ${MARKER}: 媒体文件的类型与时长。时长只用于上下文记账（estimateMediaChars），探测不到就留空由
 * 估算侧按缺省值计——不为它引入 ffprobe 这类外部依赖。
 */
const MEDIA_MIME_TYPES = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".aac": "audio/aac",
    ".opus": "audio/opus",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".wmv": "video/x-ms-wmv",
};
function detectMediaKind(absolutePath) {
    const ext = absolutePath.slice(absolutePath.lastIndexOf(".")).toLowerCase();
    const mimeType = MEDIA_MIME_TYPES[ext];
    if (!mimeType) {
        return undefined;
    }
    return { kind: mimeType.startsWith("audio/") ? "audio" : "video", mimeType };
}`;

const READ_HELPER_ANCHOR = `function getNonVisionImageNote(model) {`;
const READ_VISION_NOTE_OLD = `function getNonVisionImageNote(model) {
    if (!model || model.input.includes("image")) {
        return undefined;
    }
    return "[Current model does not support images. The image will be omitted from this request.]";
}`;
const READ_VISION_NOTE_NEW = `${READ_MEDIA_HELPER}
function getNonVisionImageNote(model) {
    if (!model || model.input.includes("image")) {
        return undefined;
    }
    return "[Current model does not support images. The image will be omitted from this request.]";
}
/** ${MARKER}: 媒体能力提示（与图片同一形式，让模型知道它这次听不到） */
function getNonMediaNote(model, kind) {
    if (!model || model.input.includes(kind)) {
        return undefined;
    }
    return kind === "audio"
        ? "[Current model does not support audio input. The audio will be omitted from this request.]"
        : "[Current model does not support video input. The video will be omitted from this request.]";
}`;

const READ_BRANCH_OLD = `                        const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
                        let content;
                        let details;
                        const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
                        if (mimeType) {`;
const READ_BRANCH_NEW = `                        const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
                        const media = mimeType ? undefined : detectMediaKind(absolutePath);
                        let content;
                        let details;
                        const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
                        if (media) {
                            // ${MARKER}: 音频/视频作为媒体块交给模型原生处理
                            const buffer = await ops.readFile(absolutePath);
                            const mediaNote = getNonMediaNote(ctx?.model, media.kind);
                            let textNote = \`Read \${media.kind} file [\${media.mimeType}], \${formatSize(buffer.length)}\`;
                            if (mediaNote)
                                textNote += \`\\n\${mediaNote}\`;
                            content = [
                                { type: "text", text: textNote },
                                {
                                    type: media.kind,
                                    mimeType: media.mimeType,
                                    data: \`data:\${media.mimeType};base64,\${buffer.toString("base64")}\`,
                                },
                            ];
                        }
                        else if (mimeType) {`;

patchFile(path.join(CODING, "dist", "core", "tools", "read.js"), "pi-ai read 工具", [
	[READ_VISION_NOTE_OLD, READ_VISION_NOTE_NEW],
	[READ_BRANCH_OLD, READ_BRANCH_NEW],
	[
		`Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments.`,
		`Supports text files, images (jpg, png, gif, webp, bmp), audio (wav, mp3, m4a, flac, ogg, aac, opus) and video (mp4, mov, avi, wmv). Images, audio and video are sent as attachments.`,
	],
]);
patchChunks("bundle read 工具", 'let mimeType=ops.detectImageMimeType?await ops.detectImageMimeType(absolutePath):void 0', [
	[
		'let mimeType=ops.detectImageMimeType?await ops.detectImageMimeType(absolutePath):void 0,content,details,nonVisionImageNote=getNonVisionImageNote(ctx?.model);if(mimeType){',
		`let mimeType=ops.detectImageMimeType?await ops.detectImageMimeType(absolutePath):void 0,media=mimeType?void 0:detectMediaKind(absolutePath),content,details,nonVisionImageNote=getNonVisionImageNote(ctx?.model);if(media){let buffer=await ops.readFile(absolutePath),mediaNote=getNonMediaNote(ctx?.model,media.kind),textNote=\`Read \${media.kind} file [\${media.mimeType}], \${formatSize(buffer.length)}\`;mediaNote&&(textNote+=\`\n\${mediaNote}\`),content=[{type:"text",text:textNote},{type:media.kind,mimeType:media.mimeType,data:\`data:\${media.mimeType};base64,\${buffer.toString("base64")}\`}]}else if(mimeType){/* ${MARKER} */`,
	],
	[
		'function getNonVisionImageNote(model){',
		`const MEDIA_MIME_TYPES={".wav":"audio/wav",".mp3":"audio/mpeg",".m4a":"audio/mp4",".flac":"audio/flac",".ogg":"audio/ogg",".aac":"audio/aac",".opus":"audio/opus",".mp4":"video/mp4",".mov":"video/quicktime",".avi":"video/x-msvideo",".wmv":"video/x-ms-wmv"};function detectMediaKind(absolutePath){let ext=absolutePath.slice(absolutePath.lastIndexOf(".")).toLowerCase(),mimeType=MEDIA_MIME_TYPES[ext];if(mimeType)return{kind:mimeType.startsWith("audio/")?"audio":"video",mimeType}}function getNonMediaNote(model,kind){if(!model||model.input.includes(kind))return;return kind==="audio"?"[Current model does not support audio input. The audio will be omitted from this request.]":"[Current model does not support video input. The video will be omitted from this request.]"}function getNonVisionImageNote(model){/* ${MARKER} */`,
	],
	[
		'Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments.',
		'Supports text files, images (jpg, png, gif, webp, bmp), audio (wav, mp3, m4a, flac, ogg, aac, opus) and video (mp4, mov, avi, wmv). Images, audio and video are sent as attachments.',
	],
]);

// ---------------------------------------------------------------------------
// 5. 估算：媒体块按 durationSec 折算 token
// ---------------------------------------------------------------------------
console.log("[5/5] 估算：媒体块按 durationSec 折算 token（不套用图片的固定值）");
const ESTIMATE_HELPER = `/**
 * ${MARKER}: 媒体块的上下文记账。音频官方 ≈6.25 token/秒；视频按抽帧算（单帧上限 300 token）。
 * durationSec 由产生块的扩展按文件探测后写入，缺省按 60 秒估——这个值只影响压缩时机，
 * 不影响请求内容，所以宁可粗一点也不要为了它去解析每一种容器格式。
 */
function estimateMediaChars(block) {
    const seconds = typeof block.durationSec === "number" && block.durationSec > 0 ? block.durationSec : 60;
    if (block.type === "audio") {
        return seconds * 6.25 * CHARS_PER_TOKEN;
    }
    return seconds * (block.fps ?? 2) * 300 * CHARS_PER_TOKEN;
}`;

patchFile(aiFile("utils", "estimate.js"), "pi-ai estimate", [
	[
		`function estimateTextAndImageContentChars(content) {
    if (typeof content === "string")
        return content.length;
    let chars = 0;
    for (const block of content)
        chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
    return chars;
}`,
		`${ESTIMATE_HELPER}
function estimateTextAndImageContentChars(content) {
    if (typeof content === "string")
        return content.length;
    let chars = 0;
    for (const block of content)
        chars +=
            block.type === "text"
                ? block.text.length
                : block.type === "audio" || block.type === "video"
                    ? estimateMediaChars(block)
                    : ESTIMATED_IMAGE_CHARS;
    return chars;
}`,
	],
]);

patchFile(path.join(CODING, "dist", "core", "compaction", "compaction.js"), "compaction 估算", [
	[
		`        else if (block.type === "image") {
            chars += ESTIMATED_IMAGE_CHARS;
        }`,
		`        else if (block.type === "image") {
            chars += ESTIMATED_IMAGE_CHARS;
        }
        else if (block.type === "audio" || block.type === "video") {
            // ${MARKER}: 媒体块按 durationSec 折算。这里用 3.5 而不是文件里的常量——
            // compaction.js 不声明那个常量，且它自己的换算基数是 chars/4（见 estimateTokens），
            // 两处基数本就不同，不能共用。3.5 与同文件其他分支持平。
            const seconds = typeof block.durationSec === "number" && block.durationSec > 0 ? block.durationSec : 60;
            chars += block.type === "audio" ? seconds * 6.25 * 3.5 : seconds * (block.fps ?? 2) * 300 * 3.5;
        }`,
	],
]);

// 压缩产物里的估算有多份（pi-ai 一份、compaction 一份），累积变量名各自不同（chars / chars2）
for (const name of fs.readdirSync(CHUNKS).filter((f) => f.endsWith(".js"))) {
	const target = path.join(CHUNKS, name);
	const src = fs.readFileSync(target, "utf8");
	const isPiAiEstimate = /for\(let block of content\)\w+\+=\w+\.type==="text"\?\w+\.text\.length:ESTIMATED_IMAGE_CHARS/.test(src);
	const isCompactionEstimate =
		/for\(let block of content\)block\.type==="text"&&block\.text\?chars\+=block\.text\.length:block\.type==="image"&&\(chars\+=ESTIMATED_IMAGE_CHARS\)/.test(src);
	// 同一个 chunk 可能已因前面的小节带上了标记，所以这里按「本小节是否已改过」判，不看整份文件
	if (!isPiAiEstimate && !isCompactionEstimate) continue;
	let out = src;
	if (isPiAiEstimate) {
		out = out.replace(
			/for\(let block of content\)(\w+)\+=(\w+)\.type==="text"\?\2\.text\.length:ESTIMATED_IMAGE_CHARS/,
			(_m, acc, blk) =>
				`for(let block of content)${acc}+=${blk}.type==="text"?${blk}.text.length:${blk}.type==="audio"||${blk}.type==="video"?estimateMediaChars(${blk}):ESTIMATED_IMAGE_CHARS`,
		);
	}
	if (isCompactionEstimate) {
		out = out.replace(
			/for\(let block of content\)block\.type==="text"&&block\.text\?chars\+=block\.text\.length:block\.type==="image"&&\(chars\+=ESTIMATED_IMAGE_CHARS\)/,
			`for(let block of content)block.type==="text"&&block.text?chars+=block.text.length:block.type==="image"?chars+=ESTIMATED_IMAGE_CHARS:(block.type==="audio"||block.type==="video")&&(chars+=(typeof block.durationSec=="number"&&block.durationSec>0?block.durationSec:60)*(block.type==="audio"?6.25:(block.fps??2)*300)*3.5)`,
		);
	}
	if (out === src) {
		console.error(`  ⚠ bundle estimate：${name} 正则未命中——pi 版本可能已变动`);
		failed++;
		continue;
	}
	// estimateMediaChars 的助手函数只需在 pi-ai 那份里补（compaction 那份自带内联算式）
	if (isPiAiEstimate) {
		const anchor = `function estimateTextAndImageContentChars(content){`;
		if (!out.includes(anchor)) {
			console.error(`  ⚠ bundle estimate：${name} 找不到估算函数入口`);
			failed++;
			continue;
		}
		out = out.replace(
			anchor,
			`function estimateMediaChars(block){/* ${MARKER} */let seconds=typeof block.durationSec=="number"&&block.durationSec>0?block.durationSec:60;return block.type==="audio"?seconds*6.25*3.5:seconds*(block.fps??2)*300*3.5}${anchor}`,
		);
	}
	if (!out.includes(MARKER)) out += `\n/* ${MARKER} */\n`;
	if (dryRun) {
		console.log(`  [dry-run] 将写入 bundle estimate：${name}`);
		changed++;
		continue;
	}
	if (!syntaxOk(out, target)) continue;
	if (!refsResolve(out, target, "bundle estimate")) continue;
	fs.writeFileSync(target, out);
	console.log(`  ✓ bundle estimate：${name}`);
	changed++;
}

console.log(`\n完成：改动 ${changed} 处，跳过 ${skipped} 处，失败 ${failed} 处。`);
if (changed > 0 && !dryRun) console.log("重启 pi 后生效（/reload 不够）。");
if (failed > 0) process.exit(1);
