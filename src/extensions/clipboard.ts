/**
 * clipboard: 剪贴板读写工具（clipboard_get / clipboard_set）+ /clipboard 命令
 *
 * 为 AI 提供系统剪贴板的读取与写入能力：
 * - clipboard_get：读取当前剪贴板文本（可截断防撑爆上下文；空/非文本给提示）
 * - clipboard_set：把文本写入剪贴板（AI 编辑后的结果写回，用户可直接 Ctrl+V
 *   粘贴；空字符串 = 清空剪贴板）
 * - /clipboard 命令：用户自查当前剪贴板内容、/clipboard clear 清空
 *
 * 平台实现（零依赖，不引入原生模块——产物保持零外部依赖单文件）：
 * - Windows：PowerShell 内置 cmdlet Get-Clipboard -Raw / Set-Clipboard -Value
 *   （系统自带；PS5.1 重定向输出是 UTF-16LE，故统一走临时文件中转）
 * - macOS：pbpaste / pbcopy（系统自带）
 * - Linux：xclip（优先）/ xsel（兜底），需系统已安装
 *
 * 读写均经临时文件中转（os.tmpdir()，用完即删）：
 * - 规避 PowerShell 管道编码问题（PS5.1 stdout 重定向下是 UTF-16LE，Node 按
 *   utf8 解码会乱码——让命令把内容落盘、Node 读文件，编码显式可控）；
 * - 规避命令行转义（内容经文件传递，不拼进命令参数——引号、$、- 开头等
 *   特殊字符均安全）。
 *
 * 安全性：剪贴板常存用户刚复制的敏感内容（密码/密钥/链接）。clipboard_set
 * 返回时报告被覆盖旧内容摘要（长度+前 40 字符），让 AI 与用户感知覆盖了什么；
 * 工具描述与 promptGuidelines 提示 AI：写入前如有疑虑先 clipboard_get 看旧内容。
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { setStatusWithTTL, clearStatusTimers } from "./shared/status";
import { toolError } from "./shared/tool-result";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 读剪贴板返回的默认最大字符数（超长截断防撑爆上下文） */
const DEFAULT_MAX_CHARS = 50_000;
/** maxChars 参数上限 */
const MAX_CHARS_LIMIT = 200_000;
/** 系统命令执行超时（PowerShell 冷启动较慢 + 剪贴板可能被其他进程占用挂起） */
const EXEC_TIMEOUT_MS = 15_000;
/** 调用卡片参数展示上限 */
const MAX_CALL_ARG_CHARS = 72;

// ---------------------------------------------------------------------------
// 平台命令构建（纯函数）
// ---------------------------------------------------------------------------

const PLATFORM = process.platform;

/** PowerShell 单引号字符串转义（' → ''） */
function psEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/** 生成一次性临时文件路径（pid+时间戳+随机串防冲突） */
function makeTmpFile(): string {
	return path.join(os.tmpdir(), `pi-clipboard-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
}

/** 读取剪贴板 → 写入 tmp 文件的命令（Windows 用 powershell 参数数组，mac/Linux 用 sh -c 做重定向） */
function readToFileCmd(tmpFile: string): { cmd: string; args: string[] } {
	if (PLATFORM === "win32") {
		// -Raw 保留多行与原始文本（普通 Get-Clipboard 会按行拆数组）。落盘用
		// [System.IO.File]::WriteAllText 而非 Out-File：Out-File 会在每条输出后追加换行
		// 并在 PS5.1 写 UTF-8 BOM，WriteAllText 原样写入、显式指定无 BOM 编码——
		// Node 读回字节与剪贴板一致。空剪贴板（Get-Clipboard 返回 $null）不写文件。
		return {
			cmd: "powershell",
			args: ["-NoProfile", "-NonInteractive", "-Command", `$t = Get-Clipboard -Raw; if ($null -ne $t) { [System.IO.File]::WriteAllText('${psEscape(tmpFile)}', [string]$t, [System.Text.UTF8Encoding]::new($false)) }`],
		};
	}
	if (PLATFORM === "darwin") {
		return { cmd: "sh", args: ["-c", `pbpaste > "${tmpFile}"`] };
	}
	// Linux：xclip 优先，缺失退 xsel；两者都缺则命令失败（stderr 带原因）
	return { cmd: "sh", args: ["-c", `(xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null) > "${tmpFile}"`] };
}

/** 从 tmp 文件写入剪贴板的命令 */
function setFromFileCmd(tmpFile: string): { cmd: string; args: string[] } {
	if (PLATFORM === "win32") {
		// Node 写无 BOM UTF-8；Get-Content 显式指定 -Encoding UTF8 解码，无需 BOM
		return {
			cmd: "powershell",
			args: ["-NoProfile", "-NonInteractive", "-Command", `$c = Get-Content -LiteralPath '${psEscape(tmpFile)}' -Raw -Encoding UTF8; Set-Clipboard -Value $c`],
		};
	}
	if (PLATFORM === "darwin") {
		return { cmd: "sh", args: ["-c", `pbcopy < "${tmpFile}"`] };
	}
	return { cmd: "sh", args: ["-c", `(xclip -selection clipboard -i 2>/dev/null || xsel --clipboard --input 2>/dev/null) < "${tmpFile}"`] };
}

/** 工具调用卡片渲染：粗体「图标+参数」，风格对齐 web-tool */
function renderToolCall(icon: string, arg: string | undefined, theme: Theme, fallback: string): Text {
	const label = arg ?? fallback;
	const text = theme.fg(
		"toolTitle",
		theme.bold(`${icon} ${label.length > MAX_CALL_ARG_CHARS ? label.slice(0, MAX_CALL_ARG_CHARS) + "…" : label}`),
	);
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// reload / session 替换前清掉 TTL 定时器（旧 ctx 已失效）
	pi.on("session_shutdown", async () => clearStatusTimers());

	/** 换行归一化：CRLF/CR → LF。Windows 剪贴板物理上存 CRLF（Out-File 也带出 \r\n），
 * 而 mac/Linux（pbpaste/xclip）输出本就是 \n——统一成 LF 保证跨平台一致、
 * 给 AI 干净内容，避免多余的 \r 混入上下文。 */
function normalizeNewlines(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 读剪贴板：命令把内容落盘到 tmp，Node 读文件（编码可控、无 shell 转义） */
	async function readClipboard(signal?: AbortSignal): Promise<string> {
		const tmp = makeTmpFile();
		try {
			const { cmd, args } = readToFileCmd(tmp);
			const r = await pi.exec(cmd, args, { signal, timeout: EXEC_TIMEOUT_MS });
			if (r.code !== 0) {
				throw new Error(`${cmd} 退出码 ${r.code}：${(r.stderr || r.stdout).trim() || "未知错误（剪贴板可能被其他程序占用）"}`);
			}
			if (!fs.existsSync(tmp)) return ""; // 命令未产出文件 = 空剪贴板
			// strip PS5.1 的 UTF-8 BOM + 换行归一化（见 normalizeNewlines）
			return normalizeNewlines(fs.readFileSync(tmp, "utf8").replace(/^\uFEFF/, ""));
		} finally {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* 文件不存在或删除失败，忽略 */
			}
		}
	}

	/** 写剪贴板：Node 把内容落盘到 tmp，命令读文件写入剪贴板 */
	async function writeClipboard(content: string, signal?: AbortSignal): Promise<void> {
		const tmp = makeTmpFile();
		try {
			fs.writeFileSync(tmp, content, "utf8");
			const { cmd, args } = setFromFileCmd(tmp);
			const r = await pi.exec(cmd, args, { signal, timeout: EXEC_TIMEOUT_MS });
			if (r.code !== 0) {
				throw new Error(`${cmd} 退出码 ${r.code}：${(r.stderr || r.stdout).trim() || "未知错误（剪贴板可能被其他程序占用）"}`);
			}
		} finally {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* 同上 */
			}
		}
	}

	// ---- clipboard_get：读取剪贴板 ----
	pi.registerTool({
		name: "clipboard_get",
		label: "读取剪贴板",
		description:
			"读取系统剪贴板文本（用户最近复制的内容）。为空或只含图片等非文本时返回提示；超长截断并提示。",
		promptSnippet: "读取剪贴板：clipboard_get([maxChars]) → 当前剪贴板文本",
		renderCall: (_args, theme) => renderToolCall("📋", undefined, theme, "clipboard_get"),
		parameters: Type.Object({
			maxChars: Type.Optional(
				Type.Integer({
					description: `返回最大字符数，默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_CHARS_LIMIT}；超长截断并提示`,
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "clipboard", text, ttlMs);
			push("📋 读取中", 30_000);
			onUpdate?.({ content: [{ type: "text", text: "正在读取剪贴板…" }], details: { progress: 10 } });
			try {
				const text = await readClipboard(signal);
				push("✓ 已读取", 6_000);
				if (text.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "剪贴板为空，或当前内容不是文本（如图片/文件引用）。\n提示：可先请用户在别处复制文本后再调用。",
							},
						],
						details: { empty: true },
					};
				}
				const maxChars = Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT);
				const truncated = text.length > maxChars;
				const shown = truncated ? text.slice(0, maxChars) : text;
				const lines = text.split(/\r\n|\r|\n/).length;
				const meta = `（${text.length} 字符，${lines} 行${truncated ? `，已截断只显示前 ${maxChars} 字符` : ""}）`;
				return {
					content: [{ type: "text", text: `${meta}\n---\n${shown}` }],
					details: { chars: text.length, lines, truncated },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				push("⚠ 读取失败", 6_000);
				return toolError(`读取剪贴板失败：${msg}`, { error: msg });
			}
		},
	});

	// ---- clipboard_set：写入剪贴板 ----
	pi.registerTool({
		name: "clipboard_set",
		label: "写入剪贴板",
		description:
			"把文本写入系统剪贴板（覆盖现有内容），供用户直接 Ctrl+V 粘贴；空字符串 = 清空。"
			+ "剪贴板可能存有敏感内容（密码/密钥）：写入前有疑虑先 clipboard_get 查看；返回时会报告被覆盖的旧内容摘要。",
		promptSnippet: "写入剪贴板：clipboard_set(文本) → 覆盖当前剪贴板",
		renderCall: (args, theme) => {
			const c = typeof args?.content === "string" ? args.content : "";
			return renderToolCall("📝", c === "" ? "(清空)" : c.length > 24 ? `${c.slice(0, 24)}…` : c, theme, "clipboard_set");
		},
		parameters: Type.Object({
			content: Type.String({ description: "要写入剪贴板的文本（空字符串 = 清空剪贴板）" }),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "clipboard", text, ttlMs);
			push("📝 写入中", 30_000);
			onUpdate?.({ content: [{ type: "text", text: "正在写入剪贴板…" }], details: { progress: 10 } });
			try {
				// 先读旧内容（仅摘要），报告覆盖了什么；读取失败不阻断写入
				let oldInfo = "（读取旧内容失败，无法报告）";
				try {
					const old = await readClipboard(signal);
					oldInfo =
						old.length === 0
							? "（剪贴板原为空或非文本）"
							: `（原内容 ${old.length} 字符：${old.length > 40 ? `${old.slice(0, 40)}…` : old.replace(/\n/g, "⏎")}）`;
				} catch {
					/* 旧内容读取失败：保留默认文案继续写入 */
				}
				await writeClipboard(params.content, signal);
				push("✓ 已写入", 6_000);
				const len = params.content.length;
				return {
					content: [
						{
							type: "text",
							text: `已写入剪贴板（${len} 字符），用户可直接 Ctrl+V 粘贴。\n覆盖前${oldInfo}`,
						},
					],
					details: { chars: len, previous: oldInfo },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				push("⚠ 写入失败", 6_000);
				return toolError(`写入剪贴板失败：${msg}`, { error: msg });
			}
		},
	});

	// ---- /clipboard：用户自查剪贴板（/clipboard clear 清空） ----
	pi.registerCommand("clipboard", {
		description: "查看/清空剪贴板：/clipboard（显示当前剪贴板内容）、/clipboard clear（清空）",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "clear" || arg === "off") {
				try {
					await writeClipboard("");
					ctx.ui.notify("剪贴板已清空", "info");
				} catch (e) {
					ctx.ui.notify(`清空剪贴板失败：${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}
			try {
				const text = await readClipboard();
				if (text.length === 0) {
					ctx.ui.notify("剪贴板为空，或内容不是文本（如图片）", "info");
					return;
				}
				const shown = text.length > 2000 ? `${text.slice(0, 2000)}\n…（共 ${text.length} 字符，截断显示）` : text;
				ctx.ui.notify(`剪贴板（${text.length} 字符）：\n${shown}`, "info");
			} catch (e) {
				ctx.ui.notify(`读取剪贴板失败：${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});
}
