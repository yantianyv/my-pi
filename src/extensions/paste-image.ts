/**
 * paste-image: 剪贴板图片直接附图粘贴（接管 Ctrl+V / Alt+V）
 *
 * 移植自 webui 扩展的图片粘贴体验（webui 已删除）：把剪贴板里的图片以 base64
 * ImageContent **直接附在下一条用户消息上**，而不是像 pi 原生粘贴那样落临时
 * 文件、往输入框插路径、再让模型用 read 工具读图（多一轮往返、消息混临时路径）。
 *
 * 背景：Windows 下终端（Windows Terminal 等）把 Ctrl+V / 右键粘贴截走当文本
 * 粘贴，pi 原生的图片粘贴只绑在 Alt+V 上且走临时文件方案；本扩展把两个键都
 * 接管过来（扩展快捷键先于内建绑定判定），行为统一为：
 *   - 剪贴板有图片 → 暂存待附（状态栏 📎 提示），Enter 发送时经 input 事件
 *     transform 附到消息上，最多 MAX_IMAGES 张；
 *   - 没有图片 → 回落官方 ctx.ui.pasteToEditor(text) 贴文本（与原生体验一致）；
 *   - 右键粘贴是终端层行为、只送文本，不受影响，照旧可用。
 *
 * 实现要点：
 * - 读图策略（逐级回落）：① @mariozechner/clipboard 原生模块（pi 自带依赖，
 *   从 pi 全局安装目录定位，快）；② Windows PowerShell
 *   [Windows.Forms.Clipboard]::GetImage() 落盘 PNG（覆盖原生模块读不出的
 *   剪贴板来源）；③ Windows PowerShell Get-Clipboard -Format FileDropList
 *   识别「复制的图片文件」（CF_HDROP 文件引用——QQ/微信复制表情、资源管理器
 *   复制图片文件都是这种，①②都看不到、浏览器粘贴却拿得到，是 webui 能贴
 *   而原生贴不了的主因）：jpg/jpeg/png/webp/gif 原样附、bmp 转 PNG；非 Windows 仅 ①；
 * - 附图时机：registerShortcut 暂存 → pi.on("input") transform 返回
 *   { action: "transform", text, images }（pi-ai ImageContent 扁平格式
 *   {type,data,mimeType}，非 Anthropic 嵌套式）——消息照常编辑、照常走模板
 *   展开，附图对用户透明；
 * - 占位显示：pi 渲染 user 消息时丢弃 image content（纯图片消息甚至整条不
 *   渲染），沿用 webui 方案——message_end(user) 收集带图消息，第一条 assistant
 *   message_start（此时 user 已持久化）追加不进 LLM 上下文的 CustomEntry，
 *   registerEntryRenderer 渲染「[N 张图片]」标签紧跟消息下方；
 * - 状态推送走官方 setStatus 通道（key "paste-image"，hud 行 1 动态区 /
 *   原生 footer 兜底）；非视觉模型附图时状态栏警告但仍允许（切模型后再发）；
 * - /paste 命令：无参查看待附图片，/paste clear 撤销全部待附。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setStatusWithTTL, clearStatusTimers } from "./shared/status";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 一次消息最多附几张图（对齐 webui 的 MAX_IMAGES） */
const MAX_IMAGES = 5;
/** setStatus key（hud STATUS_STYLE 可按此 key 映射颜色；未映射走默认样式） */
const STATUS_KEY = "paste-image";
/** 图片占位 CustomEntry 的类型名 */
const ENTRY_TYPE = "paste-image";
/** PowerShell / 系统命令超时（PS 冷启动较慢 + 剪贴板可能被占用挂起） */
const EXEC_TIMEOUT_MS = 6_000;
/** 接管的粘贴键（扩展快捷键先于内建 app.clipboard.pasteImage 判定） */
const SHORTCUTS = ["ctrl+v", "alt+v"] as const;
/** 待附图状态文本前缀 */
const ICON = "📎";

// ---------------------------------------------------------------------------
// 待附图片状态
// ---------------------------------------------------------------------------

let pending: RawImage[] = [];
/** 是否已警告过当前模型不支持图片（每轮待附只警告一次） */
let visionWarned = false;

function renderPendingStatus(): string | undefined {
	if (!pending.length) return undefined;
	return `${ICON} 已附 ${pending.length}/${MAX_IMAGES} 张图片，Enter 随消息发送（/paste clear 撤销）`;
}

/** 读剪贴板返回的原始图片（字节 + MIME 类型） */
interface RawImage {
	bytes: Buffer;
	mimeType: string;
}

// ---------------------------------------------------------------------------
// 剪贴板读取（图片 / 文本）
// ---------------------------------------------------------------------------

function execFileP(cmd: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<{ stdout: string; ok: boolean }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
			resolve(err ? { stdout: "", ok: false } : { stdout: String(stdout ?? ""), ok: true });
		});
	});
}

function psEscape(s: string): string {
	return s.replaceAll("'", "''");
}

// -- 策略①：@mariozechner/clipboard 原生模块（pi 自带依赖，从 pi 全局目录定位） --

let nativeClipboard: { hasImage(): boolean; getImageBinary(): Promise<Uint8Array | Buffer> } | null | undefined;

function loadNativeClipboard(): typeof nativeClipboard {
	if (nativeClipboard !== undefined) return nativeClipboard;
	nativeClipboard = null;
	try {
		const requireFromHere = createRequire(fileURLToPath(import.meta.url));
		const candidates: string[] = [];
		if (process.env.APPDATA) {
			candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@mariozechner", "clipboard"));
		}
		candidates.push(path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@mariozechner", "clipboard"));
		candidates.push("/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard");
		for (const dir of candidates) {
			try {
				fs.accessSync(dir);
				const mod = requireFromHere(dir);
				if (mod && typeof mod.hasImage === "function" && typeof mod.getImageBinary === "function") {
					nativeClipboard = mod;
					break;
				}
			} catch {
				// 该候选路径不存在，试下一个
			}
		}
	} catch {
		nativeClipboard = null;
	}
	return nativeClipboard;
}

async function readClipboardImageNative(): Promise<Buffer | null> {
	const clip = loadNativeClipboard();
	if (!clip) return null;
	try {
		if (!clip.hasImage()) return null;
		const binary = await clip.getImageBinary();
		if (!binary || binary.length === 0) return null;
		return Buffer.from(binary as Uint8Array);
	} catch {
		return null;
	}
}

// -- 策略②：Windows PowerShell GetImage() 落盘 PNG（原生模块读不出时的兜底） --

async function readClipboardImageWindowsPS(): Promise<Buffer | null> {
	const tmp = path.join(os.tmpdir(), `pi-paste-image-${crypto.randomUUID()}.png`);
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		`$path = '${psEscape(tmp)}'`,
		"$img = [System.Windows.Forms.Clipboard]::GetImage()",
		"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
	].join("; ");
	try {
		const r = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
		if (!r.ok || r.stdout.trim() !== "ok") return null;
		const bytes = fs.readFileSync(tmp);
		return bytes.length > 0 ? bytes : null;
	} catch {
		return null;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// 落盘失败无所谓，临时目录
		}
	}
}

// -- 策略③：复制的图片文件（CF_HDROP 文件引用，QQ/微信复制表情、资源管理器复制文件） --

/** 图片文件扩展名 → MIME（仅供参考；实际以魔数嗅探为准——QQ/微信表情常把 gif 存成 .jpg） */
const FILE_EXT_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

/** 单个文件大小上限（对齐 webui readBody 的 20MB，防超大图撞 providers 请求上限） */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** GIF 转 PNG（取首帧）后附图：智谱 GLM 等模型只收 jpg/jpeg/png/bmp，
 *  发 gif 会 400「[1210] Invalid API parameter」；视觉模型对动图也只看首帧，转码零损失 */
const CONVERT_GIF_TO_PNG = true;

/** GIF → PNG 临时文件（System.Drawing 取首帧；GDI+ 原生支持 GIF 解码） */
async function convertGifFileToPngWindowsPS(file: string): Promise<Buffer | null> {
	const tmp = path.join(os.tmpdir(), `pi-paste-gif2png-${crypto.randomUUID()}.png`);
	const script = [
		"$ErrorActionPreference = 'SilentlyContinue'",
		"Add-Type -AssemblyName System.Drawing",
		`$img = New-Object System.Drawing.Bitmap('${psEscape(file)}')`,
		`$img.Save('${psEscape(tmp)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
		"if (Test-Path -LiteralPath '" + psEscape(tmp) + "') { Write-Output 'ok' } else { Write-Output 'fail' }",
	].join("; ");
	try {
		const r = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
		if (!r.ok || r.stdout.trim() !== "ok") return null;
		const bytes = fs.readFileSync(tmp);
		return bytes.length > 0 ? bytes : null;
	} catch {
		return null;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// 忽略
		}
	}
}

/** 魔数嗅探真实图片格式（扩展名不可信）；bmp 不在支持列表（PS 侧已转 PNG，这里仅识别用于拒绝） */
function sniffImageMime(b: Buffer): string | null {
	if (b.length >= 8 && b.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.length >= 6 && b.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
	if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
	return null;
}

async function readClipboardImageFilesWindowsPS(): Promise<RawImage[]> {
	const out = path.join(os.tmpdir(), `pi-paste-filelist-${crypto.randomUUID()}.txt`);
	// FileDropList 拿到的是文件引用（可能有多个）；图片扩展名原样输出，bmp 转 PNG 临时文件后输出；
	// 结果经临时文件中转（路径含中文/空格，不拼回显），格式「扩展名|路径」逐行
	const script = [
		"$ErrorActionPreference = 'SilentlyContinue'",
		"Add-Type -AssemblyName System.Drawing",
		`$out = '${psEscape(out)}'`,
		"$fl = Get-Clipboard -Format FileDropList",
		"if ($fl) {",
		"	foreach ($f in $fl) {",
		"		if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }",
		"		$ext = [System.IO.Path]::GetExtension($f).ToLower()",
		"		if ($ext -notin '.png','.jpg','.jpeg','.webp','.gif','.bmp') { continue }",
		"		# 魔数嗅探：QQ/微信表情常把 gif/png 存成 .jpg 扩展名，扩展名不可信；BMP 转码 PNG",
		"		$fs = [System.IO.File]::OpenRead($f)",
		"		$magic = New-Object byte[] 4",
		"		$null = $fs.Read($magic, 0, 4)",
		"		$fs.Close()",
		"		$sig = [System.BitConverter]::ToString($magic).Replace('-', '')",
		"		if ($sig.StartsWith('424D') -or $ext -eq '.bmp') {",
		"			$png = Join-Path $env:TEMP ([System.IO.Path]::GetRandomFileName() + '.png')",
		"			$img = New-Object System.Drawing.Bitmap($f)",
		"			$img.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)",
		"			[System.IO.File]::AppendAllText($out, \".png|$png`n\")",
		"		} else {",
		"			[System.IO.File]::AppendAllText($out, \"$ext|$f`n\")",
		"		}",
		"	}",
		"}",
	].join("\n");
	const results: RawImage[] = [];
	try {
		const r = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
		if (!r.ok || !fs.existsSync(out)) return results;
		const lines = fs.readFileSync(out, "utf8").split(/\r?\n/).filter(Boolean);
		for (const line of lines) {
			const idx = line.indexOf("|");
			if (idx <= 0) continue;
			const ext = line.slice(0, idx);
			const file = line.slice(idx + 1);
			const mimeType = FILE_EXT_MIME[ext];
			if (!mimeType) continue;
			try {
				const bytes = fs.readFileSync(file);
				if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) continue;
				// 扩展名不可信（QQ/微信表情把 gif 存成 .jpg）：魔数嗅探优先，扩展名 MIME 兑底
				const sniffed = sniffImageMime(bytes);
				if (sniffed === "image/gif" && CONVERT_GIF_TO_PNG) {
					// 智谱 GLM 等只收 jpg/png/bmp，gif 会 400：转 PNG（首帧）后附
					const png = await convertGifFileToPngWindowsPS(file);
					if (png) {
						results.push({ bytes: png, mimeType: "image/png" });
						if (results.length >= MAX_IMAGES) break;
						continue;
					}
				}
				const mimeType = sniffed && sniffed !== "image/bmp" ? sniffed : FILE_EXT_MIME[ext];
				if (!mimeType) continue;
				results.push({ bytes, mimeType });
				if (results.length >= MAX_IMAGES) break;
			} catch {
				// 单个文件读失败（被占用/已删）不影响其余
			}
		}
		return results;
	} catch {
		return results;
	} finally {
		try {
			fs.unlinkSync(out);
		} catch {
			// 忽略
		}
	}
}

/** 读剪贴板图片（可能多张）：原生模块 → PowerShell 位图 → 复制的图片文件（统一最高优先可用者） */
async function readClipboardImages(): Promise<RawImage[]> {
	const viaNative = await readClipboardImageNative();
	if (viaNative) return [{ bytes: viaNative, mimeType: "image/png" }];
	if (process.platform === "win32") {
		const viaPS = await readClipboardImageWindowsPS();
		if (viaPS) return [{ bytes: viaPS, mimeType: "image/png" }];
		return readClipboardImageFilesWindowsPS();
	}
	return [];
}

// -- 文本回落（无图时贴文本；临时文件中转规避 PS5.1 管道 UTF-16LE 乱码） --

async function readClipboardText(): Promise<string | null> {
	const tmp = path.join(os.tmpdir(), `pi-paste-text-${crypto.randomUUID()}.txt`);
	try {
		if (process.platform === "win32") {
			const r = await execFileP("powershell", [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$t = Get-Clipboard -Raw; if ($null -ne $t) { [System.IO.File]::WriteAllText('${psEscape(tmp)}', [string]$t, [System.Text.UTF8Encoding]::new($false)) }`,
			]);
			if (!r.ok) return null;
		} else if (process.platform === "darwin") {
			const r = await execFileP("sh", ["-c", `pbpaste > "${tmp}"`]);
			if (!r.ok) return null;
		} else {
			const r = await execFileP("sh", ["-c", `(xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null) > "${tmp}"`]);
			if (!r.ok) return null;
		}
		if (!fs.existsSync(tmp)) return null;
		return fs.readFileSync(tmp, "utf8");
	} catch {
		return null;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// 忽略
		}
	}
}

// ---- 贴进来的图片路径 → 附图（终端层粘贴的兑底） ----
// Windows Terminal 等终端的右键/Ctrl+V 粘贴是**终端层行为**：终端把剪贴板文本直接
// 打进输入框，按键根本到不了 pi，上面的粘贴键接管不触发。而 QQ/微信复制表情时
// 除文件引用（CF_HDROP）外还把**路径文本**放进剪贴板，终端就把它当文本贴进来了。
// 兑底：提交消息时扫描文本中的图片文件路径——真实存在的图片就读文件附图：
// 纯路径消息（只贴了路径）整条替换为图片（复刻 webui 效果）；路径混在文字里
// 附图但保留原文不动（用户可能刻意要模型拿到路径）。

/** 图片文件路径（Windows 盘符路径含空格非贪婪匹配 + Unix 无空格路径） */
const IMAGE_PATH_RE = /(?:[A-Za-z]:\\[^\r\n]+?\.(?:png|jpe?g|webp|gif|bmp))|(?:\/(?:[^\s\\]+\/)+[^\s\\]+?\.(?:png|jpe?g|webp|gif|bmp))/gi;

/** 去掉路径首尾可能被终端/用户加上的包裹符 */
function trimPathToken(s: string): string {
	return s.replace(/^["'<(\[]+/, "").replace(/["'>)\]]+$/, "");
}

/** 读图片文件（魔数嗅探真实格式；bmp 无转换器跳过，策略③已覆盖；gif 转 PNG 后附，模型侧不收 gif） */
async function readImageFile(file: string): Promise<RawImage | null> {
	try {
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
		if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
		const bytes = fs.readFileSync(file);
		if (bytes.length === 0) return null;
		const sniffed = sniffImageMime(bytes);
		if (!sniffed || sniffed === "image/bmp") return null;
		if (sniffed === "image/gif" && CONVERT_GIF_TO_PNG && process.platform === "win32") {
			const png = await convertGifFileToPngWindowsPS(file);
			if (png) return { bytes: png, mimeType: "image/png" };
		}
		return { bytes, mimeType: sniffed };
	} catch {
		return null;
	}
}

/**
 * 从消息文本提取可附图的图片文件路径。
 * 返回 { images, pure }：images 为读到的图片（去重、限上限）；pure 表示文本剥掉路径后
 * 只剩空白（典型：右键/Ctrl+V 把路径贴进空输入框——整条替换为图片，复刻 webui 效果）。
 */
async function extractImagePathsFromText(text: string): Promise<{ images: RawImage[]; pure: boolean }> {
	const matches = text.match(IMAGE_PATH_RE);
	if (!matches?.length) return { images: [], pure: false };
	const images: RawImage[] = [];
	const seen = new Set<string>();
	for (const m of matches) {
		const file = trimPathToken(m);
		const key = file.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const img = await readImageFile(file);
		if (img) {
			images.push(img);
			if (images.length >= MAX_IMAGES) break;
		}
	}
	const pure = images.length > 0 && text.replace(IMAGE_PATH_RE, "").trim() === "";
	return { images, pure };
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// ---- 接管粘贴键：有图附图、无图贴文本 ----
	const handler = async (ctx: Parameters<Parameters<typeof pi.registerShortcut>[1]["handler"]>[0]): Promise<void> => {
		ctx.ui.setStatus(STATUS_KEY, "⏳ 正在读取剪贴板…");
		const images = await readClipboardImages();

		if (images.length) {
			const room = MAX_IMAGES - pending.length;
			if (room <= 0) {
				setStatusWithTTL(ctx, STATUS_KEY, `最多附 ${MAX_IMAGES} 张图片，/paste clear 撤销重附`, 5_000);
				return;
			}
			pending.push(...images.slice(0, room));
			if (images.length > room) {
				ctx.ui.notify(`剪贴板里有 ${images.length} 张图片，超出上限只附前 ${room} 张`, "warning");
			}
			// 非视觉模型提示但允许（可能切模型后再发）
			const modelInput = (ctx as { model?: { input?: string[]; id?: string } }).model?.input;
			if (modelInput && !modelInput.includes("image")) {
				const id = (ctx as { model?: { id?: string } }).model?.id ?? "当前模型";
				ctx.ui.setStatus(STATUS_KEY, `⚠ 已附 ${pending.length} 张图片，但 ${id} 可能不支持图片输入`);
				if (!visionWarned) {
					visionWarned = true;
					ctx.ui.notify(`${id} 不支持图片输入，发出的图片会被拒绝；建议 /model 切换视觉模型`, "warning");
				}
				return;
			}
			visionWarned = false;
			ctx.ui.setStatus(STATUS_KEY, renderPendingStatus());
			return;
		}

		// 无图：文本回落，但剪贴板文本若是纯图片文件路径（部分应用只放路径文本、不放文件引用），
		// 直接读文件附图而非贴路径
		const text = await readClipboardText();
		if (text) {
			const trimmed = text.trim();
			const extracted = await extractImagePathsFromText(trimmed);
			if (extracted.pure && pending.length < MAX_IMAGES) {
				pending.push(...extracted.images.slice(0, MAX_IMAGES - pending.length));
				const modelInput = (ctx as { model?: { input?: string[]; id?: string } }).model?.input;
				if (modelInput && !modelInput.includes("image")) {
					ctx.ui.setStatus(STATUS_KEY, `⚠ 已附 ${pending.length} 张图片，但当前模型可能不支持图片输入`);
				} else {
					ctx.ui.setStatus(STATUS_KEY, renderPendingStatus());
				}
				return;
			}
			if (pending.length) ctx.ui.setStatus(STATUS_KEY, renderPendingStatus());
			else ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.pasteToEditor(text);
			return;
		}
		// 剪贴板既无图也无文本
		setStatusWithTTL(ctx, STATUS_KEY, "剪贴板里没有图片或文本", 4_000);
	};
	for (const key of SHORTCUTS) {
		pi.registerShortcut(key, {
			description: "粘贴：剪贴板有图片直接附图（Enter 随消息发送），否则贴文本",
			handler,
		});
	}

	// ---- /paste：查看 / 撤销待附图片 ----
	pi.registerCommand("paste", {
		description: "查看/清除待附图片：/paste（查看）、/paste clear（撤销全部）",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "clear") {
				if (!pending.length) {
					setStatusWithTTL(ctx, STATUS_KEY, "当前没有待附图片", 4_000);
					return;
				}
				pending = [];
				ctx.ui.setStatus(STATUS_KEY, undefined);
				setStatusWithTTL(ctx, STATUS_KEY, "待附图片已全部撤销", 4_000);
				return;
			}
			if (!pending.length) {
				setStatusWithTTL(ctx, STATUS_KEY, `当前没有待附图片；Ctrl+V 粘贴剪贴板图片（最多 ${MAX_IMAGES} 张）`, 6_000);
				return;
			}
			ctx.ui.setStatus(STATUS_KEY, renderPendingStatus());
			ctx.ui.notify(`待附 ${pending.length} 张图片（共 ${Math.round(pending.reduce((s, p) => s + p.bytes.length, 0) / 1024)} KB），Enter 随下一条消息发送`, "info");
		},
	});

	// ---- input 事件：待附图片 + 贴进来的图片路径 transform 到即将发出的消息上 ----
	pi.on("input", async (event, ctx) => {
		// 来源一：粘贴键暂存的图片
		const images: RawImage[] = pending;
		pending = [];
		visionWarned = false;
		// 来源二：终端层粘贴进文本里的图片路径（右键/Ctrl+V 被终端截走时的兑底）
		let text = event.text;
		if (text) {
			const extracted = await extractImagePathsFromText(text);
			if (extracted.images.length) {
				const room = Math.max(0, MAX_IMAGES - images.length);
				images.push(...extracted.images.slice(0, room));
				if (extracted.pure) {
					// 只贴了路径：整条替换为图片（复刻 webui 的纯图消息）
					text = "";
				}
				// 路径混在文字里：附图但保留原文（用户可能刻意要模型拿到路径）
			}
		}
		if (!images.length) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// 状态栏失效不阻塞发送
		}
		// pi-ai ImageContent 扁平格式 {type,data,mimeType}（非 Anthropic 嵌套式 source:{}）
		return {
			action: "transform" as const,
			text,
			images: images.map((i) => ({ type: "image" as const, data: i.bytes.toString("base64"), mimeType: i.mimeType })),
		};
	});

	// ---- 占位显示：[N 张图片] CustomEntry（不进 LLM 上下文） ----
	// message_end(user) 时该消息尚未持久化（appendMessage 在扩展事件之后），
	// 立即追加会把占位挂到上一条消息下；等 assistant message_start（user 已
	// 写入、leafId 指向它）再 flush，回退时标签随消息一起消失。
	// 追加必须用 pi.appendEntry（emit entry_appended → TUI 实时渲染），
	// ctx.sessionManager.appendCustomEntry 只 persist 不通知渲染。
	let pendingPlaceholders: Array<{ count: number }> = [];

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant" && pendingPlaceholders.length) {
			for (const p of pendingPlaceholders) {
				try {
					pi.appendEntry(ENTRY_TYPE, p);
				} catch {
					// 占位追加失败不影响消息本身
				}
			}
			pendingPlaceholders = [];
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "user") {
			const content = event.message.content;
			const images = Array.isArray(content) ? content.filter((c) => (c as { type?: string }).type === "image") : [];
			if (images.length) pendingPlaceholders.push({ count: images.length });
		}
	});

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _opts, theme) => {
		const d = entry.data as { count?: number } | undefined;
		const n = Math.max(1, d?.count ?? 1);
		return new Text(theme.fg("accent", `[${n} 张图片]`), 0, 0);
	});

	// ---- 会话结束：清 TTL 定时器 + 待附状态（shared/status 约定） ----
	pi.on("session_shutdown", async () => {
		clearStatusTimers();
		pending = [];
		pendingPlaceholders = [];
	});
}
