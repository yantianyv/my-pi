// src/extensions/web-search.ts
import { Type } from "typebox";
var KIMI_PROVIDER = "kimi-coding";
var ENDPOINT = "https://api.kimi.com/coding/v1/messages";
var SEARCH_MODEL = "k3";
var MAX_TOKENS = 6e3;
var MAX_RESULTS_RETURN = 12;
var REQUEST_TIMEOUT_MS = 12e4;
function extractText(blocks) {
  return blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
}
async function searchAndSummarize(ctx, query, language) {
  const auth = await ctx.modelRegistry.getProviderAuth(KIMI_PROVIDER);
  const bearer = auth?.auth?.headers?.Authorization;
  if (!bearer) {
    throw new Error("kimi-coding \u672A\u767B\u5F55\uFF08\u6216\u51ED\u636E\u5DF2\u5931\u6548\uFF09\u3002\u8BF7\u5728 pi \u91CC\u6267\u884C /login \u91CD\u65B0\u767B\u5F55\u540E\u518D\u7528 web_search\u3002");
  }
  const headers = {
    Authorization: bearer,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json"
  };
  const tools = [{ type: "web_search_20250305", name: "web_search" }];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  async function call(messages) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: SEARCH_MODEL,
        max_tokens: MAX_TOKENS,
        messages,
        tools
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`\u641C\u7D22\u8BF7\u6C42\u5931\u8D25\uFF1A${msg}`);
    }
    return data.content ?? [];
  }
  try {
    const first = await call([{ role: "user", content: query }]);
    const assistantBlocks = first.filter((b) => b.type !== "thinking");
    const resultBlocks = first.filter((b) => b.type === "web_search_tool_result");
    const results = [];
    for (const rb of resultBlocks) {
      if (!Array.isArray(rb.content)) continue;
      for (const r of rb.content) {
        if (r?.url) results.push({ title: r.title ?? r.url, url: r.url });
      }
    }
    const summaryBlocks = await call([
      { role: "user", content: query },
      { role: "assistant", content: assistantBlocks },
      {
        role: "user",
        content: `\u8BF7\u57FA\u4E8E\u4E0A\u9762\u7684\u641C\u7D22\u7ED3\u679C\uFF0C\u7528${language}\u603B\u7ED3\u3002\u8981\u70B9\uFF1A\u6709\u54EA\u4E9B\u76F8\u5173\u6761\u76EE\u3001\u5404\u81EA\u7684\u5173\u952E\u4FE1\u606F\u4E0E\u7ED3\u8BBA\u3002\u4E0D\u8981\u53EA\u7F57\u5217\u94FE\u63A5\u3002\u5982\u679C\u641C\u7D22\u7ED3\u679C\u4E0D\u8DB3\u4EE5\u56DE\u7B54\u95EE\u9898\uFF0C\u5982\u5B9E\u8BF4\u660E\u3002`
      }
    ]);
    const summary = extractText(summaryBlocks) || "(kimi \u672A\u4EA7\u51FA\u603B\u7ED3\u6587\u672C)";
    return { summary, results };
  } finally {
    clearTimeout(timer);
  }
}
function web_search_default(pi) {
  pi.registerTool({
    name: "web_search",
    label: "\u8054\u7F51\u641C\u7D22",
    description: "\u641C\u7D22\u4E92\u8054\u7F51\uFF08Kimi Code \u8054\u7F51\u641C\u7D22\uFF0C\u670D\u52A1\u7AEF\u6267\u884C\uFF09\uFF0C\u8FD4\u56DE\u6587\u5B57\u603B\u7ED3 + \u7ED3\u679C\u6807\u9898/URL \u5217\u8868\u3002\u7528\u4E8E\u67E5\u8BE2 GitHub issue\u3001\u6587\u6863\u3001\u65B0\u95FB\u3001\u4EF7\u683C\u7B49\u5B9E\u65F6\u4FE1\u606F\u3002\u4E00\u6B21\u641C\u7D22\u6210\u672C\u7EA6 1~2 \u4E07 token + \u6309\u6B21\u641C\u7D22\u8D39\uFF0C\u907F\u514D\u9891\u7E41\u8C03\u7528\u3002",
    promptSnippet: "\u641C\u7D22\u4E92\u8054\u7F51\uFF1Aweb_search(\u67E5\u8BE2\u8BCD) \u2192 \u6587\u5B57\u603B\u7ED3 + \u6765\u6E90\u94FE\u63A5",
    promptGuidelines: [
      "Use web_search to look up real-time or external information (GitHub issues, docs, news, prices) instead of guessing or relying on stale memory.",
      "Pass a concrete search query; if the first result set is unsatisfying, call web_search again with a refined query."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "\u641C\u7D22\u67E5\u8BE2\u8BCD\uFF08\u53EF\u542B\u7AD9\u70B9\u9650\u5B9A\uFF0C\u5982 site:github.com\uFF09" }),
      language: Type.Optional(Type.String({ description: "\u603B\u7ED3\u8F93\u51FA\u8BED\u8A00\uFF0C\u9ED8\u8BA4\u300C\u4E2D\u6587\u300D" }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "\u5DF2\u53D6\u6D88" }], details: {} };
      }
      let clearTimer;
      const push = (text, ttlMs) => {
        ctx.ui.setStatus("web-search", text);
        if (clearTimer) clearTimeout(clearTimer);
        clearTimer = setTimeout(() => ctx.ui.setStatus("web-search", void 0), ttlMs);
      };
      push("\u{1F50D} \u641C\u7D22\u4E2D", 3e4);
      onUpdate?.({ content: [{ type: "text", text: `\u6B63\u5728\u641C\u7D22\uFF1A${params.query}` }], details: { progress: 10 } });
      try {
        const { summary, results } = await searchAndSummarize(ctx, params.query, params.language ?? "\u4E2D\u6587");
        push(`\u{1F50D} ${results.length} \u6761`, 6e3);
        const lines = [summary, "", `\u5171 ${results.length} \u6761\u7ED3\u679C\uFF1A`];
        for (const r of results.slice(0, MAX_RESULTS_RETURN)) {
          lines.push(`- ${r.title}
  ${r.url}`);
        }
        if (results.length > MAX_RESULTS_RETURN) {
          lines.push(`\u2026\uFF08\u53E6 ${results.length - MAX_RESULTS_RETURN} \u6761\u672A\u5217\u51FA\uFF09`);
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { results: results.length }
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        push("\u{1F50D} \u5931\u8D25", 6e3);
        return {
          content: [{ type: "text", text: `\u641C\u7D22\u5931\u8D25\uFF1A${msg}` }],
          details: { error: msg }
        };
      }
    }
  });
}
export {
  web_search_default as default
};
