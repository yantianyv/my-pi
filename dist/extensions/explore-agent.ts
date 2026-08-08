// extensions/explore-agent.ts
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import {
  runAgentLoop
} from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";

// extensions/shared/model-select.ts
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
function modelTotalCost(m) {
  const c = m.cost;
  if (!c) return Infinity;
  const { input = 0, output = 0 } = c;
  if (input < 0 || output < 0) return Infinity;
  return input + output;
}
function listAvailableModels(ctx, opts) {
  const reg = ctx.modelRegistry;
  return reg.getAvailable().filter((m) => reg.hasConfiguredAuth(m)).filter((m) => !opts?.excludeFree || modelTotalCost(m) > 0).sort((a, b) => modelTotalCost(a) - modelTotalCost(b) || a.id.localeCompare(b.id));
}
function formatModelPrice(m) {
  const c = m.cost;
  if (!c) return "\u4EF7\u683C\u672A\u77E5";
  if (c.input < 0 || c.output < 0) return "\u52A8\u6001\u5B9A\u4EF7";
  return `$${c.input}/${c.output} per M`;
}
function formatContextWindow(n) {
  if (!n || n <= 0) return "?";
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}
function modelSettingLabel(setting, opts) {
  if (setting === "auto") return opts?.auto ?? "\u81EA\u52A8\u9009\u62E9\uFF08\u6700\u4FBF\u5B9C\u53EF\u7528\u6A21\u578B\uFF09";
  if (setting === "auto-not-free") return opts?.autoNotFree ?? "\u5FFD\u7565\u514D\u8D39\u6A21\u578B\uFF0C\u6700\u4FBF\u5B9C\u7684\u975E\u514D\u8D39\u6A21\u578B";
  return setting;
}
function findConfiguredModel(ctx, setting) {
  const reg = ctx.modelRegistry;
  if (setting.includes("/")) {
    const [provider, id] = setting.split("/", 2);
    const m = reg.find(provider.trim(), id?.trim() ?? "");
    return m && reg.hasConfiguredAuth(m) ? m : void 0;
  }
  const matches = listAvailableModels(ctx).filter((m) => m.id.toLowerCase().includes(setting.toLowerCase()));
  return matches.length === 1 ? matches[0] : void 0;
}
function charIndexAtWidth(text, targetW) {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const chW = visibleWidth(text[i]);
    if (w + chW > targetW) return i;
    w += chW;
  }
  return text.length;
}
function sliceByWidth(text, startChar, maxW) {
  let out = "";
  let w = 0;
  for (let i = startChar; i < text.length; i++) {
    const chW = visibleWidth(text[i]);
    if (w + chW > maxW) break;
    out += text[i];
    w += chW;
  }
  return out;
}
var ModelSelectOverlay = class {
  focused = true;
  tui;
  theme;
  done;
  items;
  /** 当前生效设置（列表里带 ✓ 标记） */
  current;
  /** 浮层标题（调用方自定义，如「选择 btw 模型」） */
  title;
  query = "";
  queryCursor = 0;
  filtered = [];
  selectedIndex = 0;
  scrollOffset = 0;
  constructor(tui, theme, items, current, done, opts) {
    this.tui = tui;
    this.theme = theme;
    this.items = items;
    this.current = current;
    this.done = done;
    this.title = opts?.title ?? "\u9009\u62E9\u6A21\u578B";
    const idx = items.findIndex((it) => it.value === current);
    this.selectedIndex = idx >= 0 ? idx : 0;
    this.applyFilter();
    this.clampScroll();
  }
  /** 重新过滤并钳制选中项 */
  applyFilter() {
    const q = this.query.trim().toLowerCase();
    this.filtered = q ? this.items.filter((it) => it.search.includes(q)) : this.items;
    if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = Math.max(0, this.filtered.length - 1);
    }
    this.tui.requestRender();
  }
  /** 列表可见行数（按终端高度自适应） */
  getListRows() {
    const termRows = this.tui.terminal.rows;
    if (!termRows || termRows <= 0) return 20;
    return Math.max(6, Math.min(24, Math.floor(termRows * 0.6)));
  }
  /** 滚动窗口跟随选中项：上超窗顶对齐，下超窗底留一行 */
  clampScroll() {
    const rows = this.getListRows();
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + rows - 1) {
      this.scrollOffset = this.selectedIndex - rows + 2;
    }
  }
  handleInput(data) {
    if (matchesKey(data, "escape")) {
      this.done(null);
      return;
    }
    if (matchesKey(data, "return")) {
      const item = this.filtered[this.selectedIndex];
      if (item) this.done(item.value);
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.queryCursor > 0) {
        this.query = this.query.slice(0, this.queryCursor - 1) + this.query.slice(this.queryCursor);
        this.queryCursor--;
        this.applyFilter();
      }
      return;
    }
    if (matchesKey(data, "left")) {
      this.queryCursor = Math.max(0, this.queryCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "right")) {
      this.queryCursor = Math.min(this.query.length, this.queryCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.clampScroll();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "down")) {
      if (this.selectedIndex < this.filtered.length - 1) {
        this.selectedIndex++;
        this.clampScroll();
        this.tui.requestRender();
      }
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query = this.query.slice(0, this.queryCursor) + data + this.query.slice(this.queryCursor);
      this.queryCursor++;
      this.applyFilter();
    }
  }
  render(width) {
    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const border = (s) => th.fg("border", s);
    const row = (content) => border("\u2502") + truncateToWidth(content, innerW, "\u2026", true) + border("\u2502");
    const lines = [];
    const titleStr = ` ${th.fg("accent", `\u{1F50D} ${this.title}`)} `;
    lines.push(border(`\u256D${titleStr}${"\u2500".repeat(Math.max(0, innerW - visibleWidth(titleStr)))}\u256E`));
    const inputW = Math.max(8, innerW - 3);
    const full = this.query;
    const totalW = visibleWidth(full);
    let startChar = 0;
    if (totalW > inputW) {
      const cursorW = visibleWidth(full.slice(0, this.queryCursor));
      startChar = charIndexAtWidth(full, Math.max(0, cursorW - Math.floor(inputW * 0.6)));
    }
    const windowText = sliceByWidth(full, startChar, inputW);
    const cursorInWindow = Math.min(Math.max(0, this.queryCursor - startChar), windowText.length);
    let inputDisplay = windowText;
    if (this.focused) {
      const before = inputDisplay.slice(0, cursorInWindow);
      const cursorChar = cursorInWindow < inputDisplay.length ? inputDisplay[cursorInWindow] : " ";
      const after = inputDisplay.slice(cursorInWindow + 1);
      inputDisplay = `${before}${CURSOR_MARKER}\x1B[7m${cursorChar}\x1B[27m${after}`;
    }
    lines.push(row(` ${th.fg("accent", "\u276F")} ${inputDisplay}`));
    const listRows = this.getListRows();
    this.clampScroll();
    const visible = this.filtered.slice(this.scrollOffset, this.scrollOffset + listRows);
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const isCurrent = item.value === this.current;
      const isSelected = this.scrollOffset + i === this.selectedIndex;
      let text = `${isCurrent ? "\u2713 " : "  "}${item.label}`;
      if (isSelected) text = `\x1B[7m${text}\x1B[27m`;
      lines.push(row(` ${text}`));
    }
    for (let i = visible.length; i < listRows; i++) lines.push(row(""));
    const currentItem = this.filtered[this.selectedIndex];
    const status = currentItem ? `${this.filtered.length} \u4E2A\u5339\u914D` : "\u65E0\u5339\u914D\uFF08Esc \u53D6\u6D88\uFF09";
    lines.push(row(th.fg("dim", `${status} \xB7 \u2191\u2193 \u9009\u62E9 \xB7 Enter \u786E\u8BA4 \xB7 Esc \u53D6\u6D88`)));
    lines.push(border(`\u2570${"\u2500".repeat(innerW)}\u256F`));
    return lines;
  }
  invalidate() {
  }
  dispose() {
  }
};

// extensions/explore-agent.ts
var PREFERRED_MODELS = [["deepseek", "deepseek-v4-flash"]];
var EXPLORE_MODEL_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "explore-model.json");
var EXPLORE_DEFAULT_MODEL = "auto";
var MAX_TASKS = 6;
var CONCURRENCY = 3;
var MAX_TURNS = 12;
var TASK_TIMEOUT_MS = 4 * 6e4;
var SUBAGENT_MAX_TOKENS = 4096;
var exploreModelSetting = loadExploreModelSetting();
function loadExploreModelSetting() {
  try {
    if (fs.existsSync(EXPLORE_MODEL_CONFIG_FILE)) {
      const d = JSON.parse(fs.readFileSync(EXPLORE_MODEL_CONFIG_FILE, "utf8"));
      if (typeof d.model === "string" && d.model.trim()) return d.model;
    }
  } catch {
  }
  return EXPLORE_DEFAULT_MODEL;
}
function saveExploreModelSetting(value) {
  try {
    fs.mkdirSync(path.dirname(EXPLORE_MODEL_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(EXPLORE_MODEL_CONFIG_FILE, JSON.stringify({ model: value }, null, 2) + "\n", "utf8");
  } catch {
  }
}
function setExploreModelSetting(value) {
  exploreModelSetting = value;
  saveExploreModelSetting(value);
}
function exploreSettingLabel(setting) {
  return modelSettingLabel(setting, {
    auto: "\u4F18\u5148\u6307\u5B9A\u6A21\u578B\uFF0C\u4E0D\u53EF\u7528\u5219\u6700\u4FBF\u5B9C\u53EF\u7528\u6A21\u578B",
    autoNotFree: "\u5FFD\u7565\u514D\u8D39\u6A21\u578B\uFF0C\u6700\u4FBF\u5B9C\u7684\u975E\u514D\u8D39\u6A21\u578B"
  });
}
function cheapestAvailable(ctx, opts) {
  return listAvailableModels(ctx, opts)[0];
}
function pickExploreModel(ctx) {
  const reg = ctx.modelRegistry;
  if (exploreModelSetting === "auto") {
    for (const [provider, modelId] of PREFERRED_MODELS) {
      const m = reg.find(provider, modelId);
      if (m && reg.hasConfiguredAuth(m)) return m;
    }
    return cheapestAvailable(ctx);
  }
  if (exploreModelSetting === "auto-not-free") {
    return cheapestAvailable(ctx, { excludeFree: true });
  }
  return findConfiguredModel(ctx, exploreModelSetting) ?? cheapestAvailable(ctx);
}
function buildSystemPrompt(cwd) {
  return [
    "\u4F60\u662F\u300C\u63A2\u7D22\u5B50\u4EE3\u7406\u300D\uFF0C\u5728\u4EE3\u7801\u4ED3\u5E93\u4E2D\u5B8C\u6210\u4E0A\u7EA7 agent \u5206\u914D\u7684\u63A2\u7D22\u4EFB\u52A1\u3002",
    "\u4F60\u62E5\u6709\u53EA\u8BFB\u5DE5\u5177\uFF1Aread\uFF08\u8BFB\u6587\u4EF6\uFF09\u3001ls\uFF08\u5217\u76EE\u5F55\uFF09\u3001grep\uFF08\u5185\u5BB9\u641C\u7D22\uFF09\u3001find\uFF08\u6309\u6587\u4EF6\u540D\u67E5\u627E\uFF09\u3002",
    "",
    "\u5DE5\u4F5C\u8981\u6C42\uFF1A",
    "1. \u81EA\u4E3B\u51B3\u5B9A\u63A2\u7D22\u8DEF\u5F84\uFF1A\u5148\u7528 ls / find / grep \u5B9A\u4F4D\u76F8\u5173\u6587\u4EF6\uFF0C\u518D\u7528 read \u7CBE\u8BFB\u5173\u952E\u7247\u6BB5",
    "2. \u9AD8\u6548\uFF1A\u5C3D\u91CF\u63A7\u5236\u5728 10 \u6B21\u5DE5\u5177\u8C03\u7528\u4EE5\u5185\uFF0C\u4E0D\u8981\u8BFB\u65E0\u5173\u6587\u4EF6",
    "3. \u62A5\u544A\u8981\u7CBE\u70BC\uFF1A\u4E0D\u8981\u5BA2\u5957\u8BDD\uFF0C\u4E0D\u8981\u7C98\u8D34\u4EE3\u7801\u539F\u6587\uFF08\u4E00\u5F8B\u7528\u300E\u8DEF\u5F84:\u884C\u53F7\u300F\u5F15\u7528\u4EE3\u66FF\uFF09\uFF0C\u7ED3\u8BBA\u5FC5\u987B\u81EA\u5DF1\u5F52\u7EB3\uFF0C\u4E0D\u80FD\u7528\u5DE5\u5177\u8F93\u51FA\u4EE3\u66FF\u601D\u8003",
    "4. \u4E0D\u8981\u5C1D\u8BD5\u300C\u987A\u624B\u6539\u8FDB\u300D\u4EFB\u4F55\u6587\u4EF6\u2014\u2014\u4F60\u53EA\u8BFB\uFF0C\u53D1\u73B0\u95EE\u9898\u8BB0\u5F55\u5728\u62A5\u544A\u91CC\u5373\u53EF",
    "",
    "\u8F93\u51FA\u683C\u5F0F\uFF08\u4E25\u683C\u9075\u5B88\uFF09\uFF1A",
    "- \u6587\u4EF6\u6E05\u5355/\u5B9A\u4F4D\u7C7B\u4EFB\u52A1\uFF1A\u6309\u76EE\u5F55\u5206\u7EC4\u5217\u51FA\u6587\u4EF6\u8DEF\u5F84\uFF0C\u6BCF\u6761\u5E26\u884C\u53F7\u8303\u56F4\u4E0E\u4E00\u53E5\u6458\u8981\uFF08\u6D89\u53CA\u4EC0\u4E48\u51FD\u6570/\u8C03\u7528\u4E0A\u4E0B\u6587\uFF09\uFF0C\u4F8B\u5982\uFF1A",
    "  src/auth/jwt.ts:45-78 \u2014 parseToken\uFF0C\u6838\u5FC3\u89E3\u6790\u903B\u8F91",
    "- \u7B80\u5355\u95EE\u7B54\u7C7B\u4EFB\u52A1\uFF1A\u76F4\u63A5\u56DE\u7B54\uFF0C\u4E0D\u5FC5\u5957\u6E05\u5355\u683C\u5F0F",
    "- \u4E0D\u786E\u5B9A\u6216\u6CA1\u627E\u5230\u7684\u5730\u65B9\uFF1A\u6807\u6CE8\u7F6E\u4FE1\u5EA6\uFF08\u786E\u5B9A/\u63A8\u6D4B\uFF09\uFF0C\u4E0D\u8981\u731C\u6D4B\u4E0D\u5B58\u5728\u7684\u8DEF\u5F84",
    "- \u5982\u679C\u62A5\u544A\u5305\u542B\u300C\u6CA1\u6709/\u4E0D\u5B58\u5728/\u6240\u6709/\u53EA\u6709\u8FD9\u4E9B\u300D\u8FD9\u7C7B\u5B8C\u5907\u6027\u7ED3\u8BBA\uFF0C\u5FC5\u987B\u5728\u7ED3\u8BBA\u65C1\u6CE8\u660E\u641C\u7D22\u8303\u56F4\uFF08\u641C\u4E86\u54EA\u4E9B\u76EE\u5F55/\u5173\u952E\u8BCD\uFF09\u2014\u2014\u5426\u5219\u4E0A\u7EA7\u65E0\u6CD5\u5224\u65AD\u662F\u786E\u5B9E\u6CA1\u6709\u8FD8\u662F\u6CA1\u641C\u5230",
    "",
    `\u5DE5\u4F5C\u76EE\u5F55\uFF1A${cwd}`
  ].join("\n");
}
function convertToLlm(messages) {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
  );
}
function linkSignals(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("\u5B50\u4EE3\u7406\u8D85\u65F6")), timeoutMs);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  };
}
async function runSubAgent(ctx, model, task, parentSignal, onToolCall) {
  const { signal, dispose } = linkSignals(parentSignal, TASK_TIMEOUT_MS);
  try {
    const tools = createReadOnlyTools(ctx.cwd);
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
      maxTokens: SUBAGENT_MAX_TOKENS,
      convertToLlm,
      shouldStopAfterTurn: () => ++turns >= MAX_TURNS
    };
    const userMessage = { role: "user", content: task, timestamp: Date.now() };
    const newMessages = await runAgentLoop(
      [userMessage],
      { systemPrompt: buildSystemPrompt(ctx.cwd), messages: [], tools },
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
      if (text) return { task, ok: true, report: text };
    }
    return { task, ok: false, error: "\u5B50\u4EE3\u7406\u672A\u4EA7\u51FA\u62A5\u544A\uFF08\u53EF\u80FD\u9884\u7B97\u7528\u5C3D\uFF09" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { task, ok: false, error: msg.includes("abort") ? "\u5DF2\u4E2D\u6B62\uFF08\u8D85\u65F6\u6216\u7528\u6237\u53D6\u6D88\uFF09" : msg };
  } finally {
    dispose();
  }
}
async function pool(items, limit, fn) {
  const results = new Array(items.length);
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
function explore_agent_default(pi) {
  pi.registerTool({
    name: "explore",
    label: "\u63A2\u7D22\u5B50\u4EE3\u7406",
    description: "\u6D3E\u51FA\u4E00\u4E2A\u6216\u591A\u4E2A\u53EA\u8BFB\u5B50\u4EE3\u7406\u5E76\u884C\u63A2\u7D22\u4EE3\u7801\u5E93\u5E76\u8FD4\u56DE\u62A5\u544A\u3002\u6BCF\u4E2A\u5B50\u4EE3\u7406\u62E5\u6709 read/ls/grep/find \u5DE5\u5177\uFF0C\u4F1A\u81EA\u4E3B\u51B3\u5B9A\u9605\u8BFB\u54EA\u4E9B\u6587\u4EF6\uFF0C\u4F60\u53EA\u8D1F\u8D23\u5206\u914D\u4EFB\u52A1\u3002\u9002\u5408\uFF1A\u4E86\u89E3\u964C\u751F\u6A21\u5757\u7ED3\u6784\u3001\u5B9A\u4F4D\u529F\u80FD\u5B9E\u73B0\u3001\u68B3\u7406\u8C03\u7528\u94FE\u7B49\u2014\u2014\u6BD4\u4E3B agent \u9010\u6587\u4EF6 read \u66F4\u7701\u4E0A\u4E0B\u6587\u3001\u66F4\u5FEB\u3001\u66F4\u4FBF\u5B9C\uFF08\u5B50\u4EE3\u7406\u9ED8\u8BA4\u7528\u5EC9\u4EF7\u6A21\u578B\uFF09\u3002\u4EFB\u52A1\u63CF\u8FF0\u8981\u5177\u4F53\u53EF\u56DE\u7B54\uFF1B\u591A\u4E2A\u76F8\u4E92\u72EC\u7ACB\u7684\u4EFB\u52A1\u4E00\u6B21\u6D3E\u51FA\u3002\u5B50\u4EE3\u7406\u4E0D\u80FD\u4FEE\u6539\u6587\u4EF6\u3002",
    promptSnippet: "explore: \u6D3E\u53EA\u8BFB\u5B50\u4EE3\u7406\u5E76\u884C\u63A2\u7D22\u4EE3\u7801\u5E93\u5E76\u8FD4\u56DE\u62A5\u544A\uFF08\u7701\u4E3B\u4E0A\u4E0B\u6587\uFF09",
    promptGuidelines: [
      "\u9700\u8981\u4E86\u89E3\u964C\u751F\u4EE3\u7801\u7ED3\u6784\u6216\u5B9A\u4F4D\u5B9E\u73B0\u65F6\uFF0C\u4F18\u5148\u7528 explore \u6D3E\u5B50\u4EE3\u7406\uFF0C\u800C\u4E0D\u662F\u81EA\u5DF1\u9010\u6587\u4EF6 read\uFF1B\u62FF\u5230\u62A5\u544A\u540E\u518D\u5BF9\u5173\u952E\u6587\u4EF6\u7CBE\u8BFB\u3002",
      "explore \u7684\u4EFB\u52A1\u63CF\u8FF0\u8981\u5177\u4F53\u53EF\u56DE\u7B54\uFF0C\u63A8\u8350\u683C\u5F0F\uFF1A\u3010\u76EE\u6807\u3011\u8981\u67E5\u6E05\u7684\u95EE\u9898\u3010\u8303\u56F4\u3011\u76F8\u5173\u76EE\u5F55\u6216\u5173\u952E\u8BCD\u3010\u671F\u671B\u4EA7\u51FA\u3011\u5982\u300E\u6309\u76EE\u5F55\u5206\u7EC4\u7684\u6587\u4EF6\u6E05\u5355+\u884C\u53F7\u300F\uFF1B\u591A\u4E2A\u76F8\u4E92\u72EC\u7ACB\u7684\u4EFB\u52A1\u653E\u5728\u4E00\u6B21\u8C03\u7528\u91CC\u5E76\u884C\u6267\u884C\u3002",
      "explore \u62A5\u544A\u62BD\u6837\u9A8C\u8BC1\u540E\u518D\u91C7\u4FE1\uFF1A\u5173\u952E\u8DEF\u5F84\u53EF\u7528 read \u62BD\u67E5\u662F\u5426\u771F\u5B9E\u5B58\u5728\uFF0C\u518D\u636E\u6B64\u6D3E\u5DE5\u4FEE\u6539\u3002"
    ],
    parameters: Type.Object({
      tasks: Type.Array(Type.String(), {
        description: `\u5206\u914D\u7ED9\u5B50\u4EE3\u7406\u7684\u63A2\u7D22\u4EFB\u52A1\u5217\u8868\uFF0C\u6BCF\u4E2A\u4EFB\u52A1\u6D3E\u4E00\u4E2A\u5B50\u4EE3\u7406\uFF0C\u4E00\u6B21\u6700\u591A ${MAX_TASKS} \u4E2A`,
        minItems: 1
      })
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      const fail = (text2) => ({
        content: [{ type: "text", text: text2 }],
        details: { model: "", total: 0, succeeded: 0, tasks: [] }
      });
      const model = pickExploreModel(ctx);
      if (!model) {
        return fail("explore\uFF1A\u627E\u4E0D\u5230\u53EF\u7528\u7684\u5B50\u6A21\u578B\uFF08\u6CA1\u6709\u4EFB\u4F55\u5DF2\u914D\u7F6E\u8BA4\u8BC1\u7684\u6A21\u578B\uFF09\u3002\u8BF7\u6539\u7528 read/grep \u81EA\u884C\u63A2\u7D22\u3002");
      }
      const truncatedNote = params.tasks.length > MAX_TASKS ? `
\uFF08\u6CE8\u610F\uFF1A\u53EA\u6267\u884C\u4E86\u524D ${MAX_TASKS} \u4E2A\u4EFB\u52A1\uFF0C\u5176\u4F59\u5DF2\u5FFD\u7565\uFF09` : "";
      const tasks = params.tasks.slice(0, MAX_TASKS);
      const modelName = `${model.provider}/${model.id}`;
      const toolCallCounts = new Array(tasks.length).fill(0);
      const doneFlags = new Array(tasks.length).fill(false);
      const doneCount = () => doneFlags.filter(Boolean).length;
      const report = () => {
        const perTask = tasks.map((t, i) => {
          const status = doneFlags[i] ? "\u2713" : `${toolCallCounts[i]} \u6B21\u5DE5\u5177\u8C03\u7528`;
          const label = t.length > 24 ? t.slice(0, 24) + "\u2026" : t;
          return `  ${i + 1}. [${status}] ${label}`;
        }).join("\n");
        onUpdate?.({
          content: [{ type: "text", text: `\u5B50\u4EE3\u7406\u63A2\u7D22\u4E2D\uFF08${modelName}\uFF09\uFF1A
${perTask}` }],
          details: { model: modelName, total: tasks.length, succeeded: 0, tasks: [] }
        });
        ctx.ui.setStatus("explore", `\u{1F50E} ${doneCount()}/${tasks.length}`);
      };
      report();
      const results = await pool(tasks, CONCURRENCY, async (task, i) => {
        try {
          return await runSubAgent(ctx, model, task, signal, () => {
            toolCallCounts[i]++;
            report();
          });
        } finally {
          doneFlags[i] = true;
          report();
        }
      });
      const succeeded = results.filter((r) => r.ok).length;
      ctx.ui.setStatus("explore", `\u{1F50E} \u2713 ${succeeded}/${results.length}`);
      setTimeout(() => ctx.ui.setStatus("explore", void 0), 6e3);
      const sections = results.map(
        (r) => r.ok ? `## \u4EFB\u52A1\uFF1A${r.task}
${r.report}` : `## \u4EFB\u52A1\uFF1A${r.task}
\u26A0 ${r.error}`
      );
      const text = [
        `\u63A2\u7D22\u5B8C\u6210\uFF1A${succeeded}/${results.length} \u4E2A\u4EFB\u52A1\u6210\u529F\uFF08\u5B50\u6A21\u578B ${modelName}\uFF09${truncatedNote}`,
        "",
        ...sections
      ].join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: { model: modelName, total: results.length, succeeded, tasks: results }
      };
    }
  });
  pi.registerCommand("explore-model", {
    description: "\u914D\u7F6E explore \u5B50\u6A21\u578B\uFF1Aauto\uFF08\u9ED8\u8BA4\uFF0C\u4F18\u5148\u6307\u5B9A\u6A21\u578B\u5426\u5219\u6700\u4FBF\u5B9C\uFF09\u3001auto-not-free\uFF08\u5FFD\u7565\u514D\u8D39\u6A21\u578B\uFF09\u6216 provider/modelId\uFF1B\u4E0D\u5E26\u53C2\u6570\u8FDB\u5165\u4EA4\u4E92\u9009\u62E9\uFF08\u542B\u641C\u7D22\uFF09",
    handler: async (args, ctx) => {
      const arg = args?.trim() ?? "";
      if (arg) {
        if (arg === "auto" || arg === "auto-not-free") {
          setExploreModelSetting(arg);
          ctx.ui.notify(`explore \u5B50\u6A21\u578B\u5DF2\u8BBE\u4E3A ${arg}\uFF08${exploreSettingLabel(arg)}\uFF09`, "info");
          return;
        }
        const m = findConfiguredModel(ctx, arg);
        if (m) {
          setExploreModelSetting(`${m.provider}/${m.id}`);
          ctx.ui.notify(`explore \u5B50\u6A21\u578B\u5DF2\u8BBE\u4E3A ${exploreModelSetting}`, "info");
          return;
        }
        const matches = listAvailableModels(ctx).filter(
          (x) => `${x.provider}/${x.id}`.toLowerCase().includes(arg.toLowerCase())
        );
        ctx.ui.notify(
          matches.length > 0 ? `\u300C${arg}\u300D\u5339\u914D ${matches.length} \u4E2A\u6A21\u578B\uFF08${matches.slice(0, 3).map((x) => `${x.provider}/${x.id}`).join("\u3001")}${matches.length > 3 ? " \u7B49" : ""}\uFF09\uFF0C\u8BF7\u7528\u5B8C\u6574 provider/modelId \u6307\u5B9A` : `\u672A\u627E\u5230\u300C${arg}\u300D\u3002\u7528\u6CD5\uFF1A/explore-model auto\u3001auto-not-free \u6216 /explore-model provider/modelId`,
          "warning"
        );
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(
          `\u5F53\u524D explore \u5B50\u6A21\u578B\uFF1A${exploreModelSetting}\u3002\u7528\u6CD5\uFF1A/explore-model auto\u3001auto-not-free \u6216 /explore-model provider/modelId`,
          "info"
        );
        return;
      }
      const models = listAvailableModels(ctx);
      const items = [
        {
          label: "auto\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u4F18\u5148\u6307\u5B9A\u6A21\u578B\uFF08deepseek/deepseek-v4-flash\uFF09\uFF0C\u4E0D\u53EF\u7528\u5219\u6700\u4FBF\u5B9C",
          value: "auto",
          search: "auto \u9ED8\u8BA4"
        },
        {
          label: "auto-not-free\uFF1A\u5FFD\u7565\u514D\u8D39\u6A21\u578B\uFF0C\u6700\u4FBF\u5B9C\u7684\u975E\u514D\u8D39\u6A21\u578B",
          value: "auto-not-free",
          search: "auto-not-free \u5FFD\u7565\u514D\u8D39"
        },
        ...models.map((m) => ({
          label: `${m.provider}/${m.id}\uFF08${formatModelPrice(m)} \xB7 ctx ${formatContextWindow(m.contextWindow)}\uFF09`,
          value: `${m.provider}/${m.id}`,
          search: `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase()
        }))
      ];
      const result = await ctx.ui.custom(
        (tui, theme, _kb, done) => new ModelSelectOverlay(tui, theme, items, exploreModelSetting, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            width: "58%",
            minWidth: 58,
            maxHeight: "90%",
            margin: { right: 1 }
          }
        }
      );
      if (result) {
        setExploreModelSetting(result);
        ctx.ui.notify(`explore \u5B50\u6A21\u578B\u5DF2\u8BBE\u4E3A ${result}\uFF08${exploreSettingLabel(result)}\uFF09`, "info");
      }
    }
  });
}
export {
  explore_agent_default as default
};
