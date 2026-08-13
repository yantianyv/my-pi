/**
 * web-tool: 联网搜索 + 网页抓取转 markdown（入口薄壳：注册 web_search / web_fetch / web_dislike
 * 三个工具与 /web-tool-config 命令；核心逻辑在 http.ts / search.ts / fetch.ts / dislike.ts / panel.ts）
 *
 * 多源搜索，零 API key 零费用（彻底去除对 kimi-coding 的依赖）：
 * - 通用网页：cn.bing.com RSS + 360 搜索 HTML 双源并行，结果**逐条评分合并**：
 *   标题/URL/摘要按权重计分 + 完整查询短语命中强加成，跨源去重（URL 规范化 /
 *   标题归一化）后按分数降序取前 15 条——两个源的高质量条目都能入选，bing 泛化
 *   查询（地名+机构被吞长尾词）混入的低相关条目自然沉底；
 * - 垂类包：npm registry JSON API（source: "npm"）；pypi.org 搜索页有 Client
 *   Challenge 反爬（实测 curl 只回挑战页），不做垂类源，Python 包让 agent 走
 *   普通网页搜索查；
 * - 不依赖服务端 AI 总结：直接返回 标题+URL+摘要 列表由主 agent 自行判断，
 *   需要深读时用 web_fetch 抓取——成本从 kimi 时代每次 2 万+ token 降到 0。
 *
 * 差评降权（动态黑名单）：AI 发现低质量结果（内容与标题不符/灌水/死链）时调用
 * web_dislike 对域名记差评，持久化到 ~/.pi/agent/web-search-blacklist.json（跨会话）；
 * 搜索评分时按差评次数降权（×DECAY^count），累计到阈值直接滤除——无需维护域名白名单，
 * 降权对象由 AI 使用中自然沉淀。
 *
 * fetch：抓取 URL → 双通道竞速（直连 / curl+代理）→ domino 解析 DOM → 选正文容器
 * → turndown(+gfm 表格) 转 markdown → 压缩空行/截断。turndown 与其依赖 domino、
 * turndown-plugin-gfm 由 build.js（esbuild）内联进单文件产物——build.js 的
 * external 白名单只保留 @earendil-works/* 与 typebox，产物仍是零外部依赖单文件。
 *
 * 抓不到的站点（GitHub 等被墙、反爬挑战页）如实报错，提示改用 web_search 查摘要。
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { setStatusWithTTL, clearStatusTimers } from "../shared/status";
import { searchWeb, searchNpm, formatSearchResults, type SearchResult } from "./search";
import { fetchAsMarkdown, DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT } from "./fetch";
import { loadDislikeData, saveDislikeData, dislikeKey, DISLIKE_BAN_THRESHOLD } from "./dislike";
import { getProxyUrl, setProxySetting, validateProxy } from "./http";
import { ProxyConfigOverlay } from "./panel";

/** 调用卡片参数展示上限（超长截断，防 URL/查询词撑爆卡片） */
const MAX_CALL_ARG_CHARS = 72;

/** 工具调用卡片渲染：粗体「图标+参数」，风格对齐内置工具（bash 显示 `$ 命令`）；参数缺失（流式未到）时用工具名兜底 */
function renderToolCall(icon: string, arg: string | undefined, theme: Theme, fallback: string): Text {
	const label = arg ?? fallback;
	const text = theme.fg(
		"toolTitle",
		theme.bold(`${icon} ${label.length > MAX_CALL_ARG_CHARS ? label.slice(0, MAX_CALL_ARG_CHARS) + "…" : label}`),
	);
	return new Text(text, 0, 0);
}

export default function (pi: ExtensionAPI) {
	// reload / session 替换前清掉 TTL 定时器（旧 ctx 已失效，到期回调会抛 stale 错误）
	pi.on("session_shutdown", async () => clearStatusTimers());
	pi.registerTool({
		name: "web_search",
		label: "联网搜索",
		description:
			"搜索互联网，返回标题 + URL + 摘要列表。需要深读某条结果时用 web_fetch 抓取该 URL。"
			+ "查 npm 包用 source=\"npm\"。Python 包请走默认网页搜索（如 site:pypi.org/project/）。"
			+ "发现低质量结果（内容与标题不符/灌水/死链）时，可调用 web_dislike 对其域名记差评，累计差评会降权该域名。",
		promptSnippet: "搜索互联网：web_search(查询词[, source]) → 标题+URL+摘要列表",
		renderCall: (args, theme) => {
			const query = typeof args?.query === "string" ? args.query.trim() : "";
			const source = args?.source && args.source !== "web" ? ` [${args.source}]` : "";
			return renderToolCall("🔍", query ? `${query}${source}` : undefined, theme, "web_search");
		},
		promptGuidelines: [
			"Use web_search to look up real-time or external information (GitHub issues, docs, news, prices) instead of guessing or relying on stale memory.",
			"Pass a concrete search query; if the first result set is unsatisfying, call web_search again with a refined query.",
			"web_search returns title + snippet only; use web_fetch to read a result URL in depth.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "搜索查询词（可含站点限定，如 site:github.com）" }),
			source: Type.Optional(
				Type.Union(
					[
						Type.Literal("web", { description: "通用网页搜索（bing + 360 双源合并，条目级评分排序）" }),
						Type.Literal("npm", { description: "npm 包搜索（npm registry JSON API）" }),
					],
					{ description: "搜索源类型，默认 web" },
				),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "web-search", text, ttlMs);
			push("🔍 搜索中", 30_000);
			onUpdate?.({ content: [{ type: "text", text: `正在搜索：${params.query}` }], details: { progress: 10 } });
			try {
					let results: SearchResult[];
					let src: string;
					if ((params.source ?? "web") === "npm") {
						results = await searchNpm(params.query);
						src = "npm";
					} else {
						const r = await searchWeb(params.query);
						results = r.results;
						src = r.source;
					}
				push(`🔍 ${results.length} 条`, 6_000);
				return {
					content: [{ type: "text", text: formatSearchResults(results, src) }],
					details: { results: results.length, source: src },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				push("🔍 失败", 6_000);
				return {
					content: [{ type: "text", text: `搜索失败：${msg}` }],
					details: { error: msg },
				};
			}
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "抓取网页",
		description:
			"抓取网页 URL 并自动转换为 markdown（正文提取 + 去导航广告 + 截断，节约 tokens）。"
			+ "适合深读 web_search 找到的链接、官方文档、README。抓取失败时改用 web_search 查摘要。"
			+ `默认返回前 ${DEFAULT_MAX_CHARS} 字符，上限 ${MAX_CHARS_LIMIT} 字符。`,
		promptSnippet: "抓取网页转 markdown：web_fetch(URL[, maxChars]) → 正文",
		renderCall: (args, theme) =>
			renderToolCall("🌐", typeof args?.url === "string" ? args.url : undefined, theme, "web_fetch"),
		parameters: Type.Object({
			url: Type.String({ description: "要抓取的完整 URL（http/https）" }),
			maxChars: Type.Optional(
				Type.Integer({
					description: `返回 markdown 最大字符数，默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_CHARS_LIMIT}`,
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const push = (text: string, ttlMs: number) => setStatusWithTTL(ctx, "web-fetch", text, ttlMs);
			push("🌐 抓取中", 30_000);
			onUpdate?.({ content: [{ type: "text", text: `正在抓取：${params.url}` }], details: { progress: 10 } });
			try {
				const maxChars = Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT);
				const { markdown, title, finalUrl, bytes, truncated } = await fetchAsMarkdown(params.url, maxChars, signal);
				push("🌐 完成", 6_000);
				const header: string[] = [];
				if (title) header.push(`标题: ${title}`);
				header.push(`源: ${finalUrl}`);
				header.push(`（HTML 约 ${(bytes / 1024).toFixed(0)} KB，正文 ${markdown.length} 字符${truncated ? "，已截断" : ""}）`);
				return {
					content: [{ type: "text", text: `${header.join("\n")}\n---\n${markdown}` }],
					details: { bytes, chars: markdown.length, truncated },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				push("🌐 失败", 6_000);
				return {
					content: [
						{
							type: "text",
							text: `抓取失败：${msg}\n提示：目标站点可能被墙或反爬；可改用 web_search 搜该页面关键词查摘要。`,
						},
					],
					details: { error: msg },
				};
			}
		},
	});

	// ---- web_dislike：搜索结果差评（动态黑名单，持久化降权） ----
	pi.registerTool({
		name: "web_dislike",
		label: "搜索差评",
		description:
			"给搜索结果中的低质量域名记差评（持久化到本地，跨会话生效）：累计差评会使该域名在后续搜索结果中降权"
			+ "（排名靠后，x0.6/次），差评累计 5 次直接滤除。用于深读某条结果后发现内容与标题不符/灌水/死链时，"
			+ "对其所在域名记差评。用 /web-tool-config 面板查看、Delete 键清空。",
		promptSnippet: "搜索差评：web_dislike(域名/URL[, reason]) → 累计差评降权该域名",
		renderCall: (args, theme) => {
			const domains = Array.isArray(args?.domains) ? (args.domains as string[]).slice(0, 3).join(", ") : "";
			return renderToolCall("👎", domains || undefined, theme, "web_dislike");
		},
		parameters: Type.Object({
			domains: Type.Array(Type.String({ description: "要差评的域名（如 blog.csdn.net）或结果 URL（自动提取域名）" })),
			reason: Type.Optional(Type.String({ description: "差评原因（如：内容与标题不符 / 灌水 / 死链），仅用于追踪" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const data = loadDislikeData();
			const added: Array<{ key: string; count: number }> = [];
			for (const d of params.domains ?? []) {
				const key = dislikeKey(d);
				if (!key) continue;
				const rec = data[key] ?? { count: 0, reasons: [] as string[] };
				rec.count++;
				if (params.reason && !rec.reasons.includes(params.reason)) rec.reasons.push(params.reason);
				data[key] = rec;
				added.push({ key, count: rec.count });
			}
			if (added.length) saveDislikeData(data);
			const detail = added.length
				? added.map((a) => `${a.key}×${a.count}`).join("、")
				: "没有有效的域名/URL";
			const hint =
				added.some((a) => a.count >= DISLIKE_BAN_THRESHOLD)
					? "；已达封禁阈值，该域名条目将被滤除"
					: added.length
						? "；后续搜索该域名将按次数降权（/web-tool-config 面板可查看）"
						: "";
			return {
				content: [{ type: "text", text: `已差评：${detail}${hint}` }],
				details: { disliked: added.map((a) => a.key), counts: Object.fromEntries(added.map((a) => [a.key, a.count])) },
			};
		},
	});

	// ---- /web-tool-config：配置 web_fetch/web_search 被墙自动重试的代理地址；搜索差评管理在面板内（Delete 清空） ----
	pi.registerCommand("web-tool-config", {
		description:
			"配置 web_fetch/web_search 被墙自动重试的代理：无参数打开设置面板输入 http:// 代理地址（面板内同时展示搜索差评列表，Delete 键清空）；`/web-tool-config <url>` 直接设置；`/web-tool-config off` 清除",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			// 带参数：直接设置 / 清除 / 查看
			if (arg) {
				if (arg === "off" || arg === "clear" || arg === "none") {
					setProxySetting("");
					ctx.ui.notify("已清除代理设置，web_fetch/web_search 恢复直连", "info");
					return;
				}
				if (arg === "show" || arg === "status" || arg === "?") {
					ctx.ui.notify(`当前代理：${getProxyUrl() ?? "未设置"}`, "info");
					return;
				}
				if (!validateProxy(arg)) {
					ctx.ui.notify(`非法代理地址「${arg}」，需 http://host:port 形式（如 http://127.0.0.1:7890）`, "warning");
					return;
				}
				setProxySetting(arg);
				ctx.ui.notify(`代理已设为 ${arg}（被墙时自动经此重试）`, "info");
				return;
			}

			// 无参数：打开设置面板（非 TUI 回落为文本提示）
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`当前代理：${getProxyUrl() ?? "未设置"}。用法：/web-tool-config（面板）、/web-tool-config <url> 直接设置、/web-tool-config off 清除`,
					"info",
				);
				return;
			}
			const result = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => new ProxyConfigOverlay(tui, theme, getProxyUrl() ?? "", done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "46%",
						minWidth: 44,
						maxHeight: "90%",
						margin: { right: 1 },
					},
				},
			);
			if (result === null) return; // 取消
			setProxySetting(result);
			ctx.ui.notify(result ? `代理已设为 ${result}（被墙时自动经此重试）` : "已清除代理设置，web_fetch/web_search 恢复直连", "info");
		},
	});
}
