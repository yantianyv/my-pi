/**
 * pi-ai usage 缺失防护补丁（usage-guard）
 *
 * 背景：部分模型（实测 deepseek-v4-flash）偶发返回不带 usage 字段的 assistant 消息。
 * pi-ai 的 dist/utils/estimate.js 在估算上下文 token 时对每条 assistant 消息调用
 * calculateContextTokens(assistant.usage)，usage 为 undefined 时抛
 * TypeError：Cannot read properties of undefined (reading 'totalTokens')。
 * 该异常发生在每次 LLM 调用的请求构建阶段（clampMaxTokensToContext →
 * estimateContextTokens → estimateMessages → getLastAssistantUsageInfo），
 * 因此只要 history（含主会话上下文，compaction summary 消息也常缺 usage）里混入
 * 一条缺 usage 的 assistant 消息，后续调用就会瞬时失败（1~5ms 返回 stopReason="error"，
 * 请求根本没发出）——表现为模型"偶发无文字回答"（如 /btw 面板显示"无文字回答"）。
 *
 * 修复：
 * 1. estimate.js：calculateContextTokens 对 usage 缺失返回 0——调用处 `> 0` 判断
 *    自然跳过该消息，与"不用缺失 usage 的消息估算上下文"语义一致。
 * 2. anthropic-messages.js：message_start 解析 usage 处改可选链——deepseek 等
 *    兼容端点响应缺 usage 字段时不再抛 'input_tokens' 类异常。
 *
 * 用法：node patches/apply-pi-ai-usage-guard.mjs
 * pi 升级会覆盖 node_modules，需重跑本脚本。改完重启 pi 生效。
 * 幂等：已打补丁时直接跳过。
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MARKER = "PATCH(usage-guard)";

// ---- 块 1：estimate.js calculateContextTokens 防护 ----
const OLD_ESTIMATE = `export function calculateContextTokens(usage) {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}`;

const NEW_ESTIMATE = `export function calculateContextTokens(usage) {
    // PATCH(usage-guard): 模型偶发返回无 usage 的 assistant 消息（compaction summary 亦常缺），
    // 缺失时返回 0，调用处（> 0 判断）自然跳过该消息，不再抛 TypeError。
    if (!usage) return 0;
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}`;

// ---- 块 2：anthropic-messages.js message_start usage 可选链 ----
const OLD_ANTHROPIC_USAGE = `                    output.usage.input = event.message.usage.input_tokens || 0;
                    output.usage.output = event.message.usage.output_tokens || 0;
                    output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
                    output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;`;

const NEW_ANTHROPIC_USAGE = `                    // PATCH(usage-guard): usage 字段可选——兼容端点（如 deepseek）偶发不带 usage
                    output.usage.input = event.message.usage?.input_tokens || 0;
                    output.usage.output = event.message.usage?.output_tokens || 0;
                    output.usage.cacheRead = event.message.usage?.cache_read_input_tokens || 0;
                    output.usage.cacheWrite = event.message.usage?.cache_creation_input_tokens || 0;`;

function piPath(rel) {
	const npmRoot = execSync("npm root -g").toString().trim();
	const p = path.join(npmRoot, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", ...rel);
	if (!fs.existsSync(p)) {
		throw new Error(`找不到 ${p}`);
	}
	return p;
}

function applyFile(filePath, oldBlock, newBlock, label) {
	let src = fs.readFileSync(filePath, "utf8");
	if (src.includes(MARKER)) {
		console.log(`已打 ${label} 补丁，跳过: ${filePath}`);
		return;
	}
	if (!src.includes(oldBlock)) {
		console.error(`未找到 ${label} 目标代码——pi-ai 版本可能已变动，请人工核对。`);
		process.exit(1);
	}
	src = src.replace(oldBlock, newBlock);
	fs.writeFileSync(filePath, src);
	console.log(`已应用 ${label} 补丁: ${filePath}`);
}

applyFile(piPath(["utils", "estimate.js"]), OLD_ESTIMATE, NEW_ESTIMATE, "estimate.js calculateContextTokens");
applyFile(piPath(["api", "anthropic-messages.js"]), OLD_ANTHROPIC_USAGE, NEW_ANTHROPIC_USAGE, "anthropic-messages.js message_start usage");

console.log("重启 pi 后生效。");
