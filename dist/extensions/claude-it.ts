// extensions/claude-it.ts
import {
  createBashTool,
  createEditTool,
  createReadOnlyTools,
  createWriteTool
} from "@earendil-works/pi-coding-agent";
import {
  runAgentLoop
} from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
var CLEAR_SCREEN_ON_STARTUP = true;
var STARTUP_CLEAR_WIDGET_KEY = "startup-clear";
var REWIND_WINDOW_MS = 2e3;
function clearScreenOnStartup(ctx) {
  ctx.ui.setWidget(STARTUP_CLEAR_WIDGET_KEY, (tui) => {
    tui.terminal.clearScreen();
    tui.requestRender(true);
    return new Text("", 0, 0);
  });
  ctx.ui.setWidget(STARTUP_CLEAR_WIDGET_KEY, void 0);
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(
      (c) => !!c && typeof c === "object" && c.type === "text"
    ).map((c) => c.text).join("\n");
  }
  return "";
}
var CONTEXT_FILE = "AGENTS.md";
var INIT_MAX_TURNS = 30;
var INIT_TIMEOUT_MS = 10 * 6e4;
var INIT_MAX_TOKENS = 8192;
function buildInitPrompt(mode) {
  const modeInstructions = {
    create: `\u5F53\u524D\u76EE\u5F55\u4E0D\u5B58\u5728 ${CONTEXT_FILE}\uFF0C\u8BF7\u4ECE\u5934\u521B\u5EFA\u5B83\u3002`,
    merge: `\u5F53\u524D\u76EE\u5F55\u5DF2\u5B58\u5728 ${CONTEXT_FILE}\u3002\u5148\u5B8C\u6574\u8BFB\u53D6\u5B83\uFF0C\u4FDD\u7559\u5176\u4E2D\u4ECD\u7136\u51C6\u786E\u7684\u5185\u5BB9\uFF08\u5C24\u5176\u662F\u4EBA\u5DE5\u7F16\u5199\u7684\u7EA6\u5B9A\uFF09\uFF0C\u53EA\u66F4\u65B0\u8FC7\u65F6\u7684\u90E8\u5206\u3001\u8865\u5145\u7F3A\u5931\u7684\u90E8\u5206\uFF0C\u4E0D\u8981\u6574\u7BC7\u91CD\u5199\u3002`,
    overwrite: `\u5F53\u524D\u76EE\u5F55\u5DF2\u5B58\u5728 ${CONTEXT_FILE}\uFF0C\u4F46\u7528\u6237\u8981\u6C42\u5B8C\u5168\u91CD\u5199\uFF1A\u901A\u8BFB\u73B0\u6709\u5185\u5BB9\u4E86\u89E3\u9879\u76EE\u540E\uFF0C\u4ECE\u96F6\u751F\u6210\u4E00\u4EFD\u5168\u65B0\u7684 ${CONTEXT_FILE} \u8986\u76D6\u5B83\u3002`
  };
  return [
    `\u5206\u6790\u5F53\u524D\u4EE3\u7801\u5E93\u5E76\u751F\u6210\u4E0A\u4E0B\u6587\u6587\u4EF6 ${CONTEXT_FILE}\uFF08\u5BF9\u9F50 Claude Code /init \u7684\u884C\u4E3A\uFF09\u3002`,
    "",
    modeInstructions[mode],
    "",
    "\u5206\u6790\u65B9\u6CD5\uFF1A",
    "1. \u5148\u770B\u6839\u76EE\u5F55\u6E05\u5355\uFF08ls\uFF09\u3001README\u3001package.json / pyproject.toml / go.mod / Cargo.toml \u7B49\u6E05\u5355\u6587\u4EF6\uFF0C\u786E\u5B9A\u9879\u76EE\u7528\u9014\u3001\u6280\u672F\u6808\u4E0E\u5305\u7BA1\u7406\u5668",
    "2. \u68B3\u7406\u76EE\u5F55\u7ED3\u6784\uFF0C\u8BC6\u522B\u5165\u53E3\u6587\u4EF6\u3001\u6838\u5FC3\u6A21\u5757\u3001\u6D4B\u8BD5\u76EE\u5F55\u4E0E\u914D\u7F6E\u6587\u4EF6",
    "3. \u4ECE\u811A\u672C\u5B9A\u4E49\u3001Makefile\u3001CI \u914D\u7F6E\u4E2D\u63D0\u53D6\u771F\u5B9E\u7684\u6784\u5EFA / \u6D4B\u8BD5 / lint / \u8FD0\u884C\u547D\u4EE4",
    "4. \u5927\u4EE3\u7801\u5E93\u7528 grep / find \u5B9A\u4F4D\u5173\u952E\u6587\u4EF6\u540E\u7CBE\u8BFB\u7247\u6BB5\uFF0C\u914D\u5408 bash\uFF08\u5982 git log \u770B\u63D0\u4EA4\u98CE\u683C\uFF09\uFF1B\u4E0D\u8981\u9010\u6587\u4EF6\u901A\u8BFB",
    "",
    `${CONTEXT_FILE} \u5E94\u5305\u542B\u7684\u7AE0\u8282\uFF08\u6309\u9700\u53D6\u820D\uFF0C\u4E0D\u9700\u8981\u7684\u7AE0\u8282\u7701\u7565\uFF09\uFF1A`,
    "- \u9879\u76EE\u6982\u8FF0\uFF1A\u4E00\u53E5\u8BDD\u8BF4\u660E\u8FD9\u662F\u4EC0\u4E48\u3001\u4E3B\u8981\u6280\u672F\u6808",
    "- \u5E38\u7528\u547D\u4EE4\uFF1A\u6784\u5EFA\u3001\u6D4B\u8BD5\u3001lint\u3001\u7C7B\u578B\u68C0\u67E5\u3001\u8FD0\u884C/\u8C03\u8BD5\uFF08\u5FC5\u987B\u771F\u5B9E\u5B58\u5728\uFF0C\u6807\u6CE8\u51FA\u5904\uFF0C\u5982 package.json scripts\uFF09",
    "- \u76EE\u5F55\u7ED3\u6784\uFF1A\u5173\u952E\u76EE\u5F55\u4E0E\u5404\u81EA\u804C\u8D23",
    "- \u67B6\u6784\u8981\u70B9\uFF1A\u6838\u5FC3\u6A21\u5757\u5982\u4F55\u7EC4\u7EC7\u3001\u6570\u636E\u6D41/\u8C03\u7528\u94FE\u6982\u8981",
    "- \u4EE3\u7801\u98CE\u683C\u4E0E\u7EA6\u5B9A\uFF1A\u547D\u540D\u3001\u7F29\u8FDB\u3001\u6CE8\u91CA\u8BED\u8A00\u3001\u63D0\u4EA4\u4FE1\u606F\u7B49\u53EF\u89C2\u5BDF\u5230\u7684\u7EA6\u5B9A",
    "- \u6D4B\u8BD5\u8BF4\u660E\uFF1A\u6D4B\u8BD5\u6846\u67B6\u3001\u5982\u4F55\u8DD1\u5355\u4E2A\u6D4B\u8BD5",
    "- \u6CE8\u610F\u4E8B\u9879\uFF1A\u5B89\u5168\u89C4\u5219\u3001\u4E0D\u80FD\u52A8\u7684\u6587\u4EF6/\u76EE\u5F55\u3001\u5176\u4ED6\u5BB9\u6613\u51FA\u9519\u7684\u5730\u65B9",
    "",
    "\u786C\u6027\u8981\u6C42\uFF1A",
    "- \u53EA\u5199\u7ECF\u8FC7\u9A8C\u8BC1\u7684\u4FE1\u606F\uFF0C\u547D\u4EE4\u5FC5\u987B\u771F\u5B9E\u5B58\u5728\u4E8E\u9879\u76EE\u914D\u7F6E\u4E2D\uFF0C\u7981\u6B62\u7F16\u9020\uFF1B\u4E0D\u786E\u5B9A\u7684\u5185\u5BB9\u6807\u6CE8\u300C\u5F85\u786E\u8BA4\u300D",
    "- \u4FDD\u6301\u7CBE\u70BC\uFF08\u4E00\u822C\u4E0D\u8D85\u8FC7 150 \u884C\uFF09\uFF0C\u7528\u8DEF\u5F84\u5F15\u7528\u4EE3\u66FF\u7C98\u8D34\u4EE3\u7801\u539F\u6587",
    "- \u5185\u5BB9\u4F7F\u7528\u4E2D\u6587\uFF08\u4EE3\u7801\u3001\u547D\u4EE4\u3001\u6807\u8BC6\u7B26\u9664\u5916\uFF09",
    `- \u7528 write \u5DE5\u5177\u628A\u7ED3\u679C\u5199\u5165 ${CONTEXT_FILE}\uFF1B\u6700\u540E\u4E00\u6761\u56DE\u590D\u7528\u4E00\u4E24\u53E5\u8BDD\u603B\u7ED3\u5199\u5165\u4E86\u4EC0\u4E48\uFF08\u4F1A\u5C55\u793A\u7ED9\u7528\u6237\uFF09`
  ].join("\n");
}
function buildClaudeMergePrompt() {
  return [
    "\u5F53\u524D\u76EE\u5F55\u540C\u65F6\u5B58\u5728 AGENTS.md \u548C CLAUDE.md \u4E24\u4EFD\u4E0A\u4E0B\u6587\u6587\u4EF6\uFF0C\u5C06\u5B83\u4EEC\u5408\u5E76\u4E3A\u4E00\u4EFD AGENTS.md\uFF08pi \u539F\u751F\u8BFB\u53D6 AGENTS.md\uFF0C\u4E0D\u518D\u9700\u8981 CLAUDE.md\uFF09\u3002",
    "",
    "\u5408\u5E76\u6B65\u9AA4\uFF1A",
    "1. \u5B8C\u6574\u8BFB\u53D6 AGENTS.md \u548C CLAUDE.md",
    "2. \u5BF9\u6BD4\u4E24\u4EFD\u5185\u5BB9\uFF1A\u4FDD\u7559\u4ECD\u7136\u51C6\u786E\u7684\u4FE1\u606F\uFF08\u4EBA\u5DE5\u7F16\u5199\u7684\u7EA6\u5B9A\u4F18\u5148\uFF09\uFF0C\u51B2\u7A81\u5904\u4EE5\u66F4\u51C6\u786E/\u66F4\u65B0\u8005\u4E3A\u51C6\uFF0C\u53BB\u91CD",
    "3. \u540C\u65F6\u6309 /init \u7684\u6807\u51C6\u8865\u5168\uFF1A\u5206\u6790\u4EE3\u7801\u5E93\uFF08\u6E05\u5355\u6587\u4EF6\u3001scripts\u3001\u76EE\u5F55\u7ED3\u6784\u3001CI \u914D\u7F6E\uFF09\uFF0C\u66F4\u65B0\u8FC7\u65F6\u5185\u5BB9\u3001\u8865\u5145\u7F3A\u5931\u7AE0\u8282\uFF08\u5E38\u7528\u547D\u4EE4\u5FC5\u987B\u771F\u5B9E\u5B58\u5728\uFF0C\u7981\u6B62\u7F16\u9020\uFF09",
    "4. \u7528 write \u5DE5\u5177\u628A\u5408\u5E76\u7ED3\u679C\u5199\u5165 AGENTS.md\uFF08\u4E2D\u6587\uFF0C\u7CBE\u70BC\uFF0C\u4E00\u822C\u4E0D\u8D85\u8FC7 150 \u884C\uFF09",
    "5. \u7528 bash \u5220\u9664 CLAUDE.md\uFF08Windows \u73AF\u5883\u7528 del \u6216 Remove-Item\uFF0C\u6309\u5F53\u524D shell \u800C\u5B9A\uFF09",
    "6. \u6700\u540E\u4E00\u6761\u56DE\u590D\u7528\u4E00\u4E24\u53E5\u8BDD\u603B\u7ED3\uFF1A\u4FDD\u7559\u4E86\u4EC0\u4E48\u3001\u66F4\u65B0\u4E86\u4EC0\u4E48\u3001\u5220\u9664\u4E86 CLAUDE.md\uFF08\u4F1A\u5C55\u793A\u7ED9\u7528\u6237\uFF09"
  ].join("\n");
}
function convertToLlm(messages) {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
  );
}
function buildInitSystemPrompt(cwd) {
  return [
    "\u4F60\u662F init \u4EE3\u7406\uFF0C\u8D1F\u8D23\u5206\u6790\u4EE3\u7801\u5E93\u5E76\u751F\u6210/\u66F4\u65B0 AGENTS.md \u4E0A\u4E0B\u6587\u6587\u4EF6\u3002",
    "\u4F60\u62E5\u6709\u5DE5\u5177\uFF1Aread / ls / grep / find\uFF08\u63A2\u7D22\uFF09\u3001write / edit\uFF08\u5199\u6587\u4EF6\uFF09\u3001bash\uFF08\u8F85\u52A9\u547D\u4EE4\uFF0C\u5982 git log\u3001\u5220\u9664\u6587\u4EF6\uFF09\u3002",
    "\u8981\u6C42\uFF1A\u9AD8\u6548\u63A2\u7D22\uFF08grep/find \u5B9A\u4F4D + \u7CBE\u8BFB\u7247\u6BB5\uFF0C\u4E0D\u9010\u6587\u4EF6\u901A\u8BFB\uFF09\uFF1B\u53EA\u5199\u7ECF\u8FC7\u9A8C\u8BC1\u7684\u4FE1\u606F\uFF1B\u5B8C\u6210\u540E\u7684\u4E00\u4E24\u6761\u603B\u7ED3\u8981\u7CBE\u70BC\u3002",
    "",
    `\u5DE5\u4F5C\u76EE\u5F55\uFF1A${cwd}`
  ].join("\n");
}
async function runInitAgent(ctx, model, prompt, signal, onToolCall) {
  const tools = [
    ...createReadOnlyTools(ctx.cwd),
    createWriteTool(ctx.cwd),
    createEditTool(ctx.cwd),
    createBashTool(ctx.cwd)
  ];
  const streamFn = async (m, c, options) => {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
    if (!auth.ok) throw new Error(`\u8BA4\u8BC1\u5931\u8D25\uFF1A${auth.error}`);
    return streamSimple(m, c, {
      ...options,
      apiKey: auth.apiKey ?? options?.apiKey,
      headers: { ...auth.headers, ...options?.headers }
    });
  };
  let turns = 0;
  const config = {
    model,
    maxTokens: INIT_MAX_TOKENS,
    convertToLlm,
    shouldStopAfterTurn: () => ++turns >= INIT_MAX_TURNS
  };
  try {
    const userMessage = { role: "user", content: prompt, timestamp: Date.now() };
    const newMessages = await runAgentLoop(
      [userMessage],
      { systemPrompt: buildInitSystemPrompt(ctx.cwd), messages: [], tools },
      config,
      (event) => {
        if (event.type === "tool_execution_start") onToolCall();
      },
      signal,
      streamFn
    );
    for (let i = newMessages.length - 1; i >= 0; i--) {
      const m = newMessages[i];
      if (m.role !== "assistant") continue;
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) return { ok: true, summary: text };
    }
    return { ok: false, summary: "init \u4EE3\u7406\u672A\u4EA7\u51FA\u603B\u7ED3\uFF08\u53EF\u80FD\u9884\u7B97\u7528\u5C3D\uFF09" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, summary: msg.includes("abort") ? "\u5DF2\u4E2D\u6B62\uFF08\u8D85\u65F6\u6216\u4F1A\u8BDD\u7ED3\u675F\uFF09" : msg };
  }
}
function claude_it_default(pi) {
  let initAbort = null;
  function launchBackgroundInit(ctx, prompt, label) {
    if (initAbort) {
      ctx.ui.notify("\u5DF2\u6709\u540E\u53F0 init \u8FDB\u884C\u4E2D\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210", "warning");
      return;
    }
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u6A21\u578B\uFF0C\u65E0\u6CD5\u542F\u52A8\u540E\u53F0 init", "error");
      return;
    }
    const controller = new AbortController();
    initAbort = controller;
    const timer = setTimeout(() => controller.abort(new Error("init \u8D85\u65F6")), INIT_TIMEOUT_MS);
    let toolCalls = 0;
    const modelName = `${model.provider}/${model.id}`;
    ctx.ui.setStatus("init", `\u2699 init \xB7 ${toolCalls}`);
    void (async () => {
      try {
        const result = await runInitAgent(ctx, model, prompt, controller.signal, () => {
          toolCalls++;
          ctx.ui.setStatus("init", `\u2699 init \xB7 ${toolCalls}`);
        });
        ctx.ui.notify(
          result.ok ? `init \u5B8C\u6210\uFF1A${result.summary}\uFF08/reload \u540E\u751F\u6548\uFF09` : `init \u672A\u5B8C\u6210\uFF1A${result.summary}`,
          result.ok ? "info" : "warning"
        );
      } finally {
        clearTimeout(timer);
        ctx.ui.setStatus("init", void 0);
        initAbort = null;
      }
    })();
    ctx.ui.notify(`\u5DF2\u5728\u540E\u53F0\u5F00\u59CB init\uFF08${label}\uFF0C${modelName}\uFF09`, "info");
  }
  pi.registerCommand("init", {
    description: "\u540E\u53F0\u5206\u6790\u4EE3\u7801\u5E93\uFF0C\u751F\u6210\u6216\u66F4\u65B0 AGENTS.md\uFF08\u5DF2\u6709 CLAUDE.md \u4F1A\u88AB\u5408\u5E76\u8FDB\u6765\uFF09",
    handler: async (args, ctx) => {
      if (args?.trim()) {
        ctx.ui.notify("/init \u4E0D\u63A5\u53D7\u53C2\u6570\uFF0C\u56FA\u5B9A\u751F\u6210 AGENTS.md", "warning");
        return;
      }
      const filePath = path.join(ctx.cwd, CONTEXT_FILE);
      const claudePath = path.join(ctx.cwd, "CLAUDE.md");
      if (fs.existsSync(claudePath)) {
        if (fs.existsSync(filePath)) {
          launchBackgroundInit(ctx, buildClaudeMergePrompt(), "\u5408\u5E76 AGENTS.md \u4E0E CLAUDE.md");
          return;
        }
        try {
          fs.renameSync(claudePath, filePath);
          ctx.ui.notify("\u5DF2\u5C06 CLAUDE.md \u91CD\u547D\u540D\u4E3A AGENTS.md", "info");
        } catch (e) {
          ctx.ui.notify(`\u91CD\u547D\u540D\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`, "error");
          return;
        }
      }
      const exists = fs.existsSync(filePath);
      let mode = "create";
      if (exists) {
        if (!ctx.hasUI) {
          ctx.ui.notify(`${CONTEXT_FILE} \u5DF2\u5B58\u5728\uFF0C\u975E\u4EA4\u4E92\u6A21\u5F0F\u4E0B\u4E0D\u8986\u76D6\u3002\u8BF7\u5148\u5220\u9664\u6216\u6539\u7528\u4EA4\u4E92\u6A21\u5F0F\u3002`, "warning");
          return;
        }
        const choice = await ctx.ui.select(`${CONTEXT_FILE} \u5DF2\u5B58\u5728\uFF0C\u5982\u4F55\u5904\u7406\uFF1F`, [
          "\u5408\u5E76\u66F4\u65B0\uFF08\u4FDD\u7559\u73B0\u6709\u5185\u5BB9\uFF0C\u4FEE\u6B63\u8FC7\u65F6\u90E8\u5206\uFF09",
          "\u5B8C\u5168\u91CD\u5199\uFF08\u4ECE\u96F6\u751F\u6210\uFF0C\u8986\u76D6\u73B0\u6709\u6587\u4EF6\uFF09",
          "\u53D6\u6D88"
        ]);
        if (!choice || choice.startsWith("\u53D6\u6D88")) return;
        mode = choice.startsWith("\u5B8C\u5168\u91CD\u5199") ? "overwrite" : "merge";
      }
      const label = `${mode === "create" ? "\u751F\u6210" : mode === "merge" ? "\u66F4\u65B0" : "\u91CD\u5199"} ${CONTEXT_FILE}`;
      launchBackgroundInit(ctx, buildInitPrompt(mode), label);
    }
  });
  pi.registerCommand("exit", {
    description: "\u9000\u51FA pi\uFF08/quit \u7684\u522B\u540D\uFF09",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    }
  });
  pi.on("input", async (event, ctx) => {
    if (event.text.trim() === "exit") {
      ctx.shutdown();
      return { action: "handled" };
    }
    return { action: "continue" };
  });
  pi.registerCommand("rewind", {
    description: "\u56DE\u9000\u5230\u4E0A\u4E00\u6761\u7528\u6237\u6D88\u606F\uFF0C\u6D88\u606F\u5185\u5BB9\u653E\u56DE\u8F93\u5165\u6846",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      let targetId = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === "message" && e.message.role === "user") {
          targetId = e.id;
          break;
        }
      }
      if (!targetId) {
        ctx.ui.notify("\u6CA1\u6709\u53EF\u56DE\u9000\u7684\u7528\u6237\u6D88\u606F", "warning");
        return;
      }
      if (targetId === ctx.sessionManager.getLeafId()) {
        const entry = ctx.sessionManager.getEntry(targetId);
        const msg = entry && entry.type === "message" ? entry.message.content : void 0;
        const text = msg !== void 0 ? extractText(msg) : "";
        if (text) ctx.ui.setEditorText(text);
        ctx.ui.notify("\u5DF2\u628A\u4E0A\u4E00\u6761\u6D88\u606F\u653E\u56DE\u8F93\u5165\u6846", "info");
        return;
      }
      const result = await ctx.navigateTree(targetId);
      if (result.cancelled) return;
      if (result.editorText && !ctx.ui.getEditorText().trim()) {
        ctx.ui.setEditorText(result.editorText);
      }
      ctx.ui.notify("\u5DF2\u56DE\u9000\u5230\u4E0A\u4E00\u6761\u6D88\u606F\uFF0C\u5185\u5BB9\u5DF2\u5728\u8F93\u5165\u6846", "info");
    }
  });
  let currentCtx = null;
  let ctrlCHandlerInstalled = false;
  let lastAbortAt = 0;
  pi.on("session_start", async (event, ctx) => {
    if (CLEAR_SCREEN_ON_STARTUP && event.reason === "startup" && ctx.mode === "tui") {
      clearScreenOnStartup(ctx);
    }
    currentCtx = ctx;
    if (ctx.mode !== "tui" || ctrlCHandlerInstalled) return;
    ctrlCHandlerInstalled = true;
    ctx.ui.onTerminalInput((data) => {
      if (data !== "" || !currentCtx) return { consume: false };
      if (!currentCtx.isIdle()) {
        lastAbortAt = Date.now();
        currentCtx.abort();
        return { consume: true };
      }
      if (lastAbortAt > 0 && Date.now() - lastAbortAt < REWIND_WINDOW_MS) {
        lastAbortAt = 0;
        currentCtx.ui.setEditorText("/rewind");
        currentCtx.ui.notify("\u6309\u56DE\u8F66\u6267\u884C /rewind\uFF1A\u56DE\u9000\u5230\u4E0A\u4E00\u6761\u7528\u6237\u6D88\u606F", "info");
        return { consume: true };
      }
      return { consume: false };
    });
  });
  pi.on("session_shutdown", async () => {
    currentCtx = null;
    initAbort?.abort(new Error("\u4F1A\u8BDD\u7ED3\u675F"));
    initAbort = null;
  });
}
export {
  claude_it_default as default
};
