/**
 * explore-agent: Claude Code 风格的并行文件探索子代理
 *
 * 注册 explore_files 工具：主 agent 给出若干文件路径，本扩展用一个廉价/快速
 * 的子模型并行阅读每个文件并返回精炼摘要，避免把大量原始文件内容塞进主上下文，
 * 同时降低 token 成本、加快了解陌生项目的速度。
 *
 * 实现说明：
 * - pi 没有“子代理会话”公开 API，这里用「并行调子模型 + 返回摘要」做到功能等价；
 * - 子模型只支持 openai-completions 类 API（DeepSeek / Moonshot / OpenAI 等均属此类）；
 * - 子模型选择：优先 PREFERRED_MODELS，兜底选「已配置认证、上下文 >= 32k、价格最低」的可用模型。
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 优先选用的子模型（provider/modelId），按顺序尝试；都不可用时自动选最便宜的可用模型 */
const PREFERRED_MODELS: Array<[string, string]> = [["deepseek", "deepseek-v4-flash"]];

/** 单次最多探索的文件数（超出部分截断并在结果里说明） */
const MAX_FILES = 20;
/** 子请求并发数 */
const CONCURRENCY = 4;
/** 单文件最多读入的字节数（超过则截断） */
const MAX_FILE_BYTES = 64 * 1024;
/** 文件超过 2MB 直接跳过 */
const HARD_SKIP_BYTES = 2 * 1024 * 1024;
/** 截断时保留首尾行数 */
const HEAD_LINES = 1200;
const TAIL_LINES = 200;
/** 子模型单次输出上限 */
const SUBAGENT_MAX_TOKENS = 1024;
/** 单次子请求超时 */
const REQUEST_TIMEOUT_MS = 90_000;
/** 子模型最小上下文窗口（太小的模型跳过） */
const MIN_CONTEXT_WINDOW = 32 * 1024;

const BINARY_EXTS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns",
	".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar",
	".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".wasm",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	".mp3", ".wav", ".ogg", ".flac", ".mp4", ".avi", ".mov", ".mkv", ".webm",
	".pyc", ".pyo", ".class", ".jar", ".lockb", ".sqlite", ".db",
]);

const SYSTEM_PROMPT = [
	"你是代码探索子代理，为上级 coding agent 提炼单个源码/文档/配置文件的关键信息。",
	"",
	"输出要求：",
	"- 用简洁中文输出，一般不超过 200 字（复杂文件可到 400 字）",
	"- 覆盖：文件用途、主要导出/符号、关键逻辑、对外依赖（import 了什么）",
	"- 若上级给了额外要求，优先围绕额外要求回答",
	"- 只输出结论，不要粘贴大段原文，不要客套话",
].join("\n");

// ---------------------------------------------------------------------------
// 子模型选择
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

function pickExploreModel(ctx: ExtensionContext): AnyModel | undefined {
	const reg = ctx.modelRegistry;
	for (const [provider, modelId] of PREFERRED_MODELS) {
		const m = reg.find(provider, modelId);
		if (m && m.api === "openai-completions" && reg.hasConfiguredAuth(m)) return m;
	}
	// 兜底：已配置认证的 openai-completions 模型里选 input+output 最便宜的
	let best: AnyModel | undefined;
	let bestCost = Infinity;
	for (const m of reg.getAvailable()) {
		if (m.api !== "openai-completions") continue;
		if (m.contextWindow < MIN_CONTEXT_WINDOW) continue;
		if (!reg.hasConfiguredAuth(m)) continue;
		const c = (m.cost?.input ?? Infinity) + (m.cost?.output ?? Infinity);
		if (c < bestCost) {
			best = m;
			bestCost = c;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// 文件读取（限大小 / 跳过二进制 / 截断）
// ---------------------------------------------------------------------------

interface FilePayload {
	content: string;
	bytes: number;
	truncated: boolean;
	note?: string;
}

async function readFileForExplore(absPath: string): Promise<FilePayload> {
	const ext = path.extname(absPath).toLowerCase();
	if (BINARY_EXTS.has(ext)) {
		return { content: "", bytes: 0, truncated: false, note: `跳过：二进制文件（${ext}）` };
	}
	const stat = await fs.stat(absPath);
	if (stat.isDirectory()) return { content: "", bytes: 0, truncated: false, note: "跳过：是目录" };
	if (stat.size > HARD_SKIP_BYTES) {
		return { content: "", bytes: stat.size, truncated: false, note: `跳过：文件过大（${fmtBytes(stat.size)} > 2MB）` };
	}
	const buf = await fs.readFile(absPath);
	// 二进制探测：前 8KB 含 null 字节视为二进制
	const probe = buf.subarray(0, 8192);
	if (probe.includes(0)) {
		return { content: "", bytes: stat.size, truncated: false, note: "跳过：检测到二进制内容" };
	}
	let text = buf.toString("utf8");
	let truncated = false;
	if (buf.length > MAX_FILE_BYTES) {
		const lines = text.split("\n");
		if (lines.length > HEAD_LINES + TAIL_LINES) {
			text = [
				...lines.slice(0, HEAD_LINES),
				`\n……（中间省略 ${lines.length - HEAD_LINES - TAIL_LINES} 行）……\n`,
				...lines.slice(-TAIL_LINES),
			].join("\n");
		} else {
			text = text.slice(0, MAX_FILE_BYTES) + "\n……（尾部被截断）……";
		}
		truncated = true;
	}
	if (!text.trim()) return { content: "", bytes: stat.size, truncated: false, note: "跳过：空文件" };
	return { content: text, bytes: stat.size, truncated };
}

// ---------------------------------------------------------------------------
// 子模型调用（openai-completions）
// ---------------------------------------------------------------------------

async function callSubModel(
	ctx: ExtensionContext,
	model: AnyModel,
	userPrompt: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`认证失败：${auth.error}`);

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(auth.headers ?? {}),
	};
	if (auth.apiKey) headers["Authorization"] = `Bearer ${auth.apiKey}`;

	const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
	if (signal) signals.push(signal);

	const res = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: model.id,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
			max_tokens: SUBAGENT_MAX_TOKENS,
			stream: false,
		}),
		signal: AbortSignal.any(signals),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = (await res.json()) as any;
	const content = data?.choices?.[0]?.message?.content;
	if (typeof content !== "string" || !content.trim()) throw new Error("子模型返回为空");
	return content.trim();
}

// ---------------------------------------------------------------------------
// 并发池
// ---------------------------------------------------------------------------

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${n}B`;
}

interface FileResult {
	path: string;
	ok: boolean;
	bytes: number;
	truncated: boolean;
	summary?: string;
	note?: string;
}

interface ExploreDetails {
	model: string;
	total: number;
	succeeded: number;
	files: FileResult[];
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "explore_files",
		label: "探索文件",
		description:
			"用廉价快速的子模型并行阅读多个文件，返回每个文件的精炼摘要列表。" +
			"了解陌生项目/模块结构时优先用它批量探索，而不是逐个 read 大文件——可以显著节省主上下文、降低 token 成本。" +
			"子模型只看单个文件，无法跨文件推理；拿到摘要后可再对关键文件做精确 read。",
		promptSnippet: "explore_files: 用子模型并行总结多个文件的内容（省主上下文、省成本）",
		promptGuidelines: [
			"初步了解陌生项目/模块时，先用 ls/glob 列出候选文件，再用 explore_files 批量获取摘要；确认关键文件后再用 read 精读。",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), {
				description: `要探索的文件路径（相对当前工作目录或绝对路径），一次最多 ${MAX_FILES} 个`,
			}),
			instructions: Type.Optional(
				Type.String({ description: "希望子模型重点关注/回答的问题（可选），会应用到每个文件" }),
			),
		}),
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ExploreDetails>> => {
			const fail = (text: string): AgentToolResult<ExploreDetails> => ({
				content: [{ type: "text", text }],
				details: { model: "", total: 0, succeeded: 0, files: [] },
			});

			if (!params.paths?.length) return fail("explore_files：paths 为空，未指定任何文件。");

			const model = pickExploreModel(ctx);
			if (!model) {
				return fail(
					"explore_files：找不到可用的子模型（需要已配置认证的 openai-completions 模型）。请改用 read 逐个读取文件。",
				);
			}

			// 路径规范化 + 数量截断
			const truncatedListNote =
				params.paths.length > MAX_FILES ? `\n（注意：只探索了前 ${MAX_FILES} 个，其余已忽略）` : "";
			const relPaths = params.paths.slice(0, MAX_FILES);
			const extra = params.instructions?.trim();

			let done = 0;
			const report = () => {
				onUpdate?.({
					content: [{ type: "text", text: `探索中… ${done}/${relPaths.length} 完成（子模型 ${model.provider}/${model.id}）` }],
					details: { model: `${model.provider}/${model.id}`, total: relPaths.length, succeeded: 0, files: [] },
				});
			};
			report();

			const results = await pool(relPaths, CONCURRENCY, async (rel): Promise<FileResult> => {
				const abs = path.isAbsolute(rel) ? rel : path.resolve(ctx.cwd, rel);
				try {
					const payload = await readFileForExplore(abs);
					if (payload.note) {
						return { path: rel, ok: false, bytes: payload.bytes, truncated: false, note: payload.note };
					}
					const userPrompt = [
						`文件路径：${rel}`,
						`文件大小：${fmtBytes(payload.bytes)}${payload.truncated ? "（内容过大，已截断为首尾片段）" : ""}`,
						extra ? `\n上级 agent 的额外要求：${extra}` : "",
						"",
						"文件内容：",
						"```",
						payload.content,
						"```",
					].join("\n");
					const summary = await callSubModel(ctx, model, userPrompt, signal);
					return { path: rel, ok: true, bytes: payload.bytes, truncated: payload.truncated, summary };
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return { path: rel, ok: false, bytes: 0, truncated: false, note: `处理失败：${msg}` };
				} finally {
					done++;
					report();
				}
			});

			const succeeded = results.filter((r) => r.ok).length;
			const sections = results.map((r) => {
				if (r.ok) {
					return `## ${r.path}${r.truncated ? "（已截断）" : ""}\n${r.summary}`;
				}
				return `## ${r.path}\n⚠ ${r.note}`;
			});
			const text = [
				`探索完成：${succeeded}/${results.length} 个文件成功（子模型 ${model.provider}/${model.id}）${truncatedListNote}`,
				"",
				...sections,
			].join("\n\n");

			return {
				content: [{ type: "text", text }],
				details: { model: `${model.provider}/${model.id}`, total: results.length, succeeded, files: results },
			};
		},
	});

	// 调试用：查看当前会被选中的子模型
	pi.registerCommand("explore-model", {
		description: "查看 explore_files 将使用的子模型",
		handler: async (_args, ctx) => {
			const m = pickExploreModel(ctx);
			ctx.ui.notify(
				m ? `explore 子模型：${m.provider}/${m.id}` : "explore 子模型：无可用模型（需已认证 openai-completions 模型）",
				m ? "info" : "warning",
			);
		},
	});
}
