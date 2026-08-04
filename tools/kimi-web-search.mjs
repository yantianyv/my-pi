/**
 * Kimi Code 联网搜索（Anthropic 兼容端点 + web_search 服务端工具）
 *
 * 用法: node tools/kimi-web-search.mjs "你的问题"
 *
 * 原理：POST https://api.kimi.com/coding/v1/messages，tools 声明
 *   {"type":"web_search_20250305","name":"web_search"}（Anthropic 服务端工具格式），
 *   搜索由 Kimi 服务端执行。鉴权复用 pi 的 ~/.pi/agent/auth.json 里 kimi-coding 的
 *   OAuth access token（有效期约 15 分钟，pi 运行时会自动刷新——过期了就先去用一下 pi）。
 *
 * 注意：
 * - 联网搜索按次收取调用费，搜索结果 token 计入 prompt_tokens（通常 1 万+）；
 * - 搜索结果正文是加密引用块（encrypted_content），只有模型能读；
 *   脚本只能拿到 title/url/page_age + 模型自己写的总结文本；
 * - k3 思考常开，tool_choice 强制搜索不可用；模型偶尔拒绝调用工具，
 *   在问题里直接给出建议搜索词最稳；
 * - 参考文档：https://platform.kimi.com/docs/guide/claude-code-kimi
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const question = process.argv[2];
if (!question) {
	console.error('用法: node tools/kimi-web-search.mjs "你的问题"');
	process.exit(1);
}

const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"))["kimi-coding"];
if (!auth?.access) {
	console.error("auth.json 里没有 kimi-coding 凭据");
	process.exit(1);
}
const remainMin = (auth.expires - Date.now()) / 60000;
if (remainMin < 1) {
	console.error(`access token 已过期（${remainMin.toFixed(1)} 分钟）。先随便用一下 pi 让它刷新，再重试。`);
	process.exit(1);
}
console.error(`[token 剩余 ${remainMin.toFixed(1)} 分钟]`);

const res = await fetch("https://api.kimi.com/coding/v1/messages", {
	method: "POST",
	headers: {
		Authorization: `Bearer ${auth.access}`,
		"anthropic-version": "2023-06-01",
		"Content-Type": "application/json",
	},
	body: JSON.stringify({
		model: "k3",
		max_tokens: 6000,
		messages: [{ role: "user", content: question }],
		tools: [{ type: "web_search_20250305", name: "web_search" }],
	}),
});

if (!res.ok) {
	console.error(`HTTP ${res.status}:`, await res.text());
	process.exit(1);
}

const data = await res.json();
for (const b of data.content ?? []) {
	if (b.type === "text") {
		console.log(b.text);
	} else if (b.type === "server_tool_use") {
		console.log(`\n[搜索] ${b.input?.query}`);
	} else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
		for (const r of b.content) {
			console.log(`  - ${r.title}${r.page_age ? ` (${r.page_age})` : ""}\n    ${r.url}`);
		}
	}
}
console.error(`[usage] ${JSON.stringify(data.usage)}`);
