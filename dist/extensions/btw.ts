// extensions/btw.ts
import {
  createReadOnlyTools
} from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { CURSOR_MARKER as CURSOR_MARKER2, matchesKey as matchesKey2, truncateToWidth as truncateToWidth2, visibleWidth as visibleWidth2 } from "@earendil-works/pi-tui";

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

// extensions/btw.ts
var BTW_MAX_TOKENS = 4096;
var BTW_MAX_TURNS = 6;
var BTW_EMPTY_RETRY = 1;
var BTW_TIMEOUT_MS = 5 * 6e4;
var BTW_MAX_CONTEXT_MESSAGES = 60;
var BTW_MAX_THREAD_TURNS = 8;
var BTW_MAX_TOTAL_MESSAGES = 80;
var BTW_MAX_TOOL_RESULT_CHARS = 1500;
var BTW_OVERLAY_WIDTH = "42%";
var BTW_OVERLAY_MIN_WIDTH = 46;
var BTW_OVERLAY_MAX_HEIGHT = "80%";
var BTW_MAX_ROWS = 32;
var BTW_MAX_QUESTION_LINES = 4;
var BTW_MAX_INPUT_LENGTH = 300;
var BTW_DEFAULT_MODEL = "auto";
var BTW_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "btw-config.json");
var BTW_SYSTEM_PROMPT = [
  "\u4F60\u662F btw \u52A9\u624B\uFF08by the way\uFF09\uFF0C\u8FD0\u884C\u5728\u7528\u6237\u6B63\u5728\u8FDB\u884C\u7684\u7F16\u7801\u4EFB\u52A1\u65C1\u8FB9\u7684\u4FA7\u680F\u95EE\u7B54\u9762\u677F\u91CC\u3002",
  "\u7528\u6237\u6B64\u523B\u5C31\u662F\u5728\u8FD9\u4E2A\u9762\u677F\u4E2D\u4E0E\u4F60\u5BF9\u8BDD\u2014\u2014\u672C\u9762\u677F\u72EC\u7ACB\u4E8E\u4E3B\u4F1A\u8BDD\uFF0C\u4F60\u7684\u56DE\u7B54\u4E0D\u4F1A\u5199\u5165\u4E3B\u4F1A\u8BDD\u3002",
  "\u4F60\u7684\u56DE\u7B54\u4F1A\u4EE5 markdown \u8F7B\u91CF\u6E32\u67D3\u663E\u793A\uFF08**\u7C97\u4F53**\u3001`\u884C\u5185\u4EE3\u7801`\u3001`# \u6807\u9898`\u3001`- \u5217\u8868`\u3001markdown \u8868\u683C\uFF09\uFF0C\u9700\u8981\u7ED3\u6784\u5316\u65F6\u5C3D\u7BA1\u4F7F\u7528\u3002",
  "",
  "\u4F60\u53EF\u4EE5\u4F7F\u7528\u53EA\u8BFB\u5DE5\u5177\uFF08read / ls / grep / find\uFF09\u67E5\u8BC1\u4EE3\u7801\u4E0E\u6587\u4EF6\u5185\u5BB9\u6765\u56DE\u7B54\u5F97\u66F4\u51C6\u786E\uFF0C",
  "\u4F46\u53EA\u8BFB\u4E0D\u5199\uFF1A\u4E0D\u8981\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6\uFF0C\u4E5F\u4E0D\u80FD\u6267\u884C\u547D\u4EE4\uFF08\u6CA1\u6709 bash \u5DE5\u5177\uFF09\u3002",
  "",
  "\u8F93\u5165\u7ED3\u6784\uFF1A",
  "- \u524D\u534A\u90E8\u5206\u662F\u4E3B\u4F1A\u8BDD\u7684\u5BF9\u8BDD\u5386\u53F2\uFF08\u7528\u6237\u6D88\u606F\u3001\u52A9\u624B\u6D88\u606F\u3001\u5DE5\u5177\u8F93\u51FA\uFF09\uFF0C\u5E2E\u52A9\u4F60\u7406\u89E3\u4EFB\u52A1\u80CC\u666F\uFF1B",
  "- \u540E\u534A\u90E8\u5206\u662F\u672C\u9762\u677F\u5185\u4F60\u4E0E\u6B64\u7528\u6237\u7684\u5386\u6B21\u95EE\u7B54\uFF08user \u662F\u95EE\u9898\u3001assistant \u662F\u4F60\u7684\u56DE\u7B54\uFF09\uFF1B",
  "- \u6700\u540E\u4E00\u6761 user \u6D88\u606F\u662F\u5F53\u524D\u8981\u56DE\u7B54\u7684\u95EE\u9898\u3002",
  "",
  "\u8981\u6C42\uFF1A",
  "- \u56DE\u7B54\u51C6\u786E\u3001\u7B80\u6D01\u3001\u76F4\u63A5\uFF1A\u9ED8\u8BA4\u63A7\u5236\u5728\u51E0\u53E5\u8BDD\u5230\u4E00\u5C0F\u6BB5\uFF0C\u50CF\u8D44\u6DF1\u540C\u4E8B\u968F\u53E3\u56DE\u7B54\uFF1B\u7528\u6237\u660E\u786E\u8981\u6C42\u8BE6\u7EC6\u65F6\u624D\u5C55\u5F00",
  "- \u4E13\u6CE8\u5F53\u524D\u95EE\u9898\u672C\u8EAB\uFF1A\u4E0D\u8981\u6C47\u62A5/\u603B\u7ED3\u4E3B\u4F1A\u8BDD\u7684\u8FDB\u5EA6\u3001\u72B6\u6001\u6216\u505A\u4E86\u4EC0\u4E48\uFF0C\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42",
  "- \u5F00\u573A\u76F4\u63A5\u7ED9\u7B54\u6848\uFF0C\u4E0D\u8981\u300C\u8BA9\u6211\u770B\u770B\u300D\u300C\u68B3\u7406\u4E00\u4E0B\u300D\u300C\u6211\u53D1\u73B0\u4E86\u95EE\u9898\u300D\u8FD9\u7C7B\u8FC7\u6E21\u8BED\u6216\u590D\u76D8",
  "- \u53EA\u56DE\u7B54\u5F53\u524D\u95EE\u9898\u672C\u8EAB\uFF0C\u4E0D\u8981\u590D\u8FF0\u4EFB\u52A1\u3001\u4E0D\u8981\u5217\u884C\u52A8\u6E05\u5355\u3001\u4E0D\u8981\u5EFA\u8BAE\u4E0B\u4E00\u6B65\u884C\u52A8",
  "- \u9700\u8981\u67E5\u8BC1\u65F6\u5148\u7528\u53EA\u8BFB\u5DE5\u5177\u770B\u6587\u4EF6\uFF0C\u518D\u56DE\u7B54\uFF1B\u5DE5\u5177\u8C03\u7528\u8F6E\u6B21\u91CC\u4E0D\u8981\u957F\u7BC7\u5927\u8BBA\uFF0C\u6700\u7EC8\u56DE\u7B54\u624D\u5C55\u5F00",
  "- \u88AB\u95EE\u5230\u5173\u4E8E\u4F60\u81EA\u5DF1\u7684\u95EE\u9898\uFF08\u5982\u300C\u4F60\u77E5\u9053\u81EA\u5DF1\u5728\u54EA\u5417\u300D\u300C\u4F60\u80FD\u7528\u5DE5\u5177\u5417\u300D\uFF09\uFF0C\u5982\u5B9E\u8BF4\u660E\uFF1A\u4F60\u662F btw \u9762\u677F\u52A9\u624B\uFF0C",
  "  \u72EC\u7ACB\u4E8E\u4E3B\u4F1A\u8BDD\uFF0C\u53EA\u80FD\u8BFB\u6587\u4EF6\uFF08read / ls / grep / find\uFF09\uFF0C\u4E0D\u80FD\u4FEE\u6539\u6587\u4EF6\u6216\u6267\u884C\u547D\u4EE4",
  "- \u8FFD\u95EE\u65F6\u7ED3\u5408\u524D\u9762\u7684\u95EE\u7B54\uFF08\u4F8B\u5982\u300C\u6211\u521A\u624D\u63D0\u5230\u7684 xx \u5177\u4F53\u6307\uFF1F\u300D\uFF09\uFF0C\u4E0D\u8981\u91CD\u590D\u5DF2\u7ED9\u8FC7\u7684\u5185\u5BB9",
  "- \u4E0D\u63D0\u53CA\u300C\u5BF9\u8BDD\u5386\u53F2\u300D\u300C\u4E0A\u4E0B\u6587\u300D\u7B49\u5185\u90E8\u673A\u5236\uFF0C\u76F4\u63A5\u56DE\u7B54\u95EE\u9898",
  "- \u5982\u679C\u4F9D\u636E\u73B0\u6709\u4FE1\u606F\u65E0\u6CD5\u5224\u65AD\uFF0C\u660E\u786E\u8BF4\u660E\u8FD9\u4E00\u70B9"
].join("\n");
function btwSettingLabel(setting) {
  return modelSettingLabel(setting, {
    auto: "\u6700\u4FBF\u5B9C\u53EF\u7528\u6A21\u578B\uFF0C\u6309\u4EF7\u683C\u987A\u5E8F\u6545\u969C\u8F6C\u79FB",
    autoNotFree: "\u5FFD\u7565\u514D\u8D39\u6A21\u578B\uFF0C\u6700\u4FBF\u5B9C\u7684\u975E\u514D\u8D39\u6A21\u578B\u6309\u4EF7\u683C\u987A\u5E8F\u6545\u969C\u8F6C\u79FB"
  });
}
var btwModelSetting = loadBtwModelSetting();
function loadBtwModelSetting() {
  try {
    if (fs.existsSync(BTW_CONFIG_FILE)) {
      const d = JSON.parse(fs.readFileSync(BTW_CONFIG_FILE, "utf8"));
      if (typeof d.model === "string" && d.model.trim()) return d.model;
    }
  } catch {
  }
  return BTW_DEFAULT_MODEL;
}
function saveBtwModelSetting(value) {
  try {
    fs.mkdirSync(path.dirname(BTW_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(BTW_CONFIG_FILE, JSON.stringify({ model: value }, null, 2) + "\n", "utf8");
  } catch {
  }
}
function setBtwModelSetting(value) {
  btwModelSetting = value;
  saveBtwModelSetting(value);
}
function resolveBtwModel(ctx) {
  if (btwModelSetting !== "auto" && btwModelSetting !== "auto-not-free") {
    const fixed = findConfiguredModel(ctx, btwModelSetting);
    if (fixed) return { mode: "fixed", model: fixed, failover: void 0 };
    btwModelSetting = BTW_DEFAULT_MODEL;
  }
  const excludeFree = btwModelSetting === "auto-not-free";
  let sorted = listAvailableModels(ctx, { excludeFree });
  if (sorted.length === 0 && excludeFree) sorted = listAvailableModels(ctx);
  if (sorted.length === 0) return { mode: "auto", model: void 0, failover: void 0 };
  let idx = 0;
  return {
    mode: "auto",
    model: sorted[0],
    failover: () => sorted[++idx]
  };
}
function extractTextBlocks(m) {
  const content = m.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.filter((b) => {
      const block = b;
      return block.type === "text" && typeof block.text === "string";
    }).map((b) => b.text).join("\n").trim();
  }
  return "";
}
function asTextBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.filter((b) => b.type === "text" && typeof b.text === "string");
}
function mergeAdjacent(messages) {
  const out = [];
  for (const msg of messages) {
    const blocks = asTextBlocks(msg.content);
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === msg.role) {
      const sep = msg.role === "user" ? [{ type: "text", text: "\n\n" }] : [];
      last.content = [...asTextBlocks(last.content), ...sep, ...blocks];
    } else {
      out.push({ ...msg, content: blocks });
    }
  }
  return out;
}
function buildContextMessages(sessionMessages, ctx) {
  if (!ctx.isIdle()) {
    let lastUser = -1;
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      if (sessionMessages[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    if (lastUser >= 0) sessionMessages = sessionMessages.slice(0, lastUser);
  }
  const cleaned = [];
  for (const m of sessionMessages) {
    if (m.role === "user" || m.role === "assistant") {
      const text = extractTextBlocks(m);
      if (text) cleaned.push({ role: m.role, content: [{ type: "text", text }], timestamp: m.timestamp });
    } else if (m.role === "toolResult") {
      const text = extractTextBlocks(m).slice(0, BTW_MAX_TOOL_RESULT_CHARS);
      if (text) {
        cleaned.push({ role: "user", content: [{ type: "text", text: `[\u5DE5\u5177 ${m.toolName} \u8F93\u51FA]
${text}` }], timestamp: Date.now() });
      }
    }
  }
  return cleaned.slice(-BTW_MAX_CONTEXT_MESSAGES);
}
function extractText(message) {
  return (message.content ?? []).filter((b) => b.type === "text" && !!b.text).map((b) => b.text).join("\n").trim();
}
function convertToLlm(messages) {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
  );
}
function wrapText(text, width) {
  const out = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") {
      out.push("");
      continue;
    }
    let current = "";
    let currentW = 0;
    for (const ch of rawLine) {
      const w = visibleWidth2(ch);
      if (currentW + w > width && current !== "") {
        out.push(current);
        current = ch;
        currentW = w;
      } else {
        current += ch;
        currentW += w;
      }
    }
    out.push(current);
  }
  return out;
}
function renderInline(text, th) {
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => th.fg("accent", code));
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, bold) => th.bold(bold));
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre, italic) => `${pre}${th.italic(italic)}`);
  return text;
}
function renderLine(line, th) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("```")) return th.fg("muted", line);
  if (/^#{1,6}\s/.test(trimmed)) return th.fg("accent", th.bold(line));
  const listMatch = /^[-*]\s+/.exec(trimmed);
  if (listMatch) return "\u2022 " + renderInline(trimmed.slice(listMatch[0].length), th);
  return renderInline(line, th);
}
function isTableRow(line) {
  return line.startsWith("|") && line.endsWith("|") && line.includes("|", 1);
}
function splitTableRow(line) {
  return line.slice(1, -1).split("|").map((s) => s.trim());
}
function isTableSeparator(line) {
  if (!isTableRow(line)) return false;
  return splitTableRow(line).every((cell) => /^:?-{1,}:?$/.test(cell));
}
function renderTable(rows, th, maxW) {
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < colCount; c++) {
    let w = 0;
    for (const r of rows) {
      if (c < r.length) w = Math.max(w, visibleWidth2(r[c]));
    }
    widths.push(w);
  }
  const totalW = () => widths.reduce((a, b) => a + b, 0) + colCount * 3 + 1;
  let guard = 0;
  while (totalW() > maxW && guard < colCount * 50) {
    guard++;
    let widest = -1;
    let widestW = 0;
    for (let c = 0; c < colCount; c++) {
      if (widths[c] > 1 && widths[c] > widestW) {
        widestW = widths[c];
        widest = c;
      }
    }
    if (widest < 0) break;
    widths[widest] = widestW - 1;
  }
  const cells = (row, isHeader) => {
    let line = "\u2502";
    for (let c = 0; c < colCount; c++) {
      const cell = c < row.length ? row[c] : "";
      const display = truncateToWidth2(cell, widths[c], "\u2026", false);
      const pad = Math.max(0, widths[c] - visibleWidth2(display));
      const styled = isHeader ? th.bold(display) : display;
      line += ` ${styled}${" ".repeat(pad)} \u2502`;
    }
    return isHeader ? th.fg("accent", line) : th.fg("text", line);
  };
  const separator = () => {
    let line = "\u251C";
    for (let c = 0; c < colCount; c++) {
      line += "\u2500".repeat(widths[c] + 2) + (c < colCount - 1 ? "\u253C" : "\u2524");
    }
    return th.fg("muted", line);
  };
  const out = [];
  out.push(`  ${cells(rows[0], true)}`);
  out.push(`  ${separator()}`);
  for (const r of rows.slice(1)) out.push(`  ${cells(r, false)}`);
  return out;
}
function renderAnswer(text, th, contentWidth) {
  const rawLines = text.split("\n");
  const out = [];
  let inCode = false;
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      out.push(`  ${th.fg("muted", line)}`);
      inCode = !inCode;
      i++;
      continue;
    }
    if (inCode) {
      for (const l of wrapText(line, contentWidth)) out.push(`  ${l}`);
      i++;
      continue;
    }
    if (isTableRow(trimmed) && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1].trim())) {
      const rows = [splitTableRow(trimmed)];
      i += 2;
      while (i < rawLines.length && isTableRow(rawLines[i].trim())) {
        rows.push(splitTableRow(rawLines[i].trim()));
        i++;
      }
      out.push(...renderTable(rows, th, contentWidth));
      continue;
    }
    for (const l of wrapText(line, contentWidth)) out.push(`  ${renderLine(l, th)}`);
    i++;
  }
  return out;
}
var BtwOverlay = class {
  focused = false;
  tui;
  theme;
  done;
  onAsk;
  onTransfer;
  /** 已完成的问答对（展示 + 转正素材） */
  qaPairs = [];
  /** 当前正在回答的问题 */
  currentQuestion = "";
  /** 当前回答的已累积文本 */
  answer = "";
  status = "thinking";
  errorText = "";
  /** 正在执行的只读工具（如「read src/a.ts」），无则空串 */
  toolLabel = "";
  scrollOffset = 0;
  mode = "viewing";
  inputText = "";
  inputCursor = 0;
  constructor(tui, theme, onAsk, onTransfer, done) {
    this.tui = tui;
    this.theme = theme;
    this.onAsk = onAsk;
    this.onTransfer = onTransfer;
    this.done = done;
  }
  // ---- 流式回调（runBtwTurn 调用） ----
  /** 当前实际使用的模型（provider/id），问答开始时由 ask / 故障转移更新 */
  modelLabel = "";
  /** 设置当前实际使用的模型名并重绘（auto 故障转移换模型时也会调用） */
  setModel(label) {
    this.modelLabel = label;
    this.tui.requestRender();
  }
  /** 开始回答新问题：清空当前回答并滚到最新 */
  startQuestion(question) {
    this.currentQuestion = question;
    this.answer = "";
    this.status = "thinking";
    this.errorText = "";
    this.toolLabel = "";
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.tui.requestRender();
  }
  appendAnswer(delta) {
    if (this.status === "thinking") this.status = "streaming";
    this.answer += delta;
    this.tui.requestRender();
  }
  finish(message) {
    if (message) this.answer = message;
    this.status = "done";
    this.tui.requestRender();
  }
  fail(error) {
    this.status = "error";
    this.errorText = error.length > 300 ? error.slice(0, 300) + "\u2026" : error;
    this.tui.requestRender();
  }
  /** 当前问答完成，压入历史并进入待命状态 */
  commit() {
    this.qaPairs.push({ q: this.currentQuestion, a: this.answer || "\uFF08\u65E0\u6587\u5B57\u56DE\u7B54\uFF09" });
    this.currentQuestion = "";
    this.answer = "";
    this.status = "thinking";
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.tui.requestRender();
  }
  isStreaming() {
    return this.status === "streaming" || this.status === "thinking";
  }
  /** 工具开始执行：在状态行显示当前工具与目标 */
  showTool(toolName, args) {
    const raw = args?.path ?? args?.pattern ?? args?.query ?? args?.command ?? "";
    const target = raw.length > 48 ? `\u2026${raw.slice(-48)}` : raw;
    this.toolLabel = `\u{1F527} ${toolName}${target ? ` ${target}` : ""}`;
    this.tui.requestRender();
  }
  hideTool() {
    this.toolLabel = "";
    this.tui.requestRender();
  }
  getAnswer() {
    return this.answer;
  }
  /** 生成转正用的完整问答记录 */
  getTranscript() {
    const lines = [];
    for (const { q, a } of this.qaPairs) lines.push(`Q: ${q}`, `A: ${a}`);
    if (this.currentQuestion) {
      lines.push(`Q: ${this.currentQuestion}`, `A: ${this.answer || "\uFF08\u65E0\u6587\u5B57\u56DE\u7B54\uFF09"}`);
    }
    return lines.join("\n");
  }
  /** 当前是否处于可交互状态（回答完成或出错，可追问/转正） */
  isSettled() {
    return this.status === "done" || this.status === "error";
  }
  /** 按终端高度自适应面板最大行数：小终端收缩到 80% 高度内，避免底部被 maxHeight 截掉 */
  getMaxRows() {
    const termRows = this.tui.terminal.rows;
    if (!termRows || termRows <= 0) return BTW_MAX_ROWS;
    return Math.max(12, Math.min(BTW_MAX_ROWS, Math.floor(termRows * 0.8)));
  }
  // ---- 组件接口 ----
  handleInput(data) {
    if (this.mode === "input") {
      if (matchesKey2(data, "escape")) {
        this.mode = "viewing";
        this.tui.requestRender();
        return;
      }
      if (matchesKey2(data, "return")) {
        const q = this.inputText.trim();
        this.mode = "viewing";
        this.inputText = "";
        this.inputCursor = 0;
        if (q) this.onAsk(q);
        else this.tui.requestRender();
        return;
      }
      if (matchesKey2(data, "backspace")) {
        if (this.inputCursor > 0) {
          this.inputText = this.inputText.slice(0, this.inputCursor - 1) + this.inputText.slice(this.inputCursor);
          this.inputCursor--;
          this.tui.requestRender();
        }
        return;
      }
      if (matchesKey2(data, "left")) {
        this.inputCursor = Math.max(0, this.inputCursor - 1);
        this.tui.requestRender();
        return;
      }
      if (matchesKey2(data, "right")) {
        this.inputCursor = Math.min(this.inputText.length, this.inputCursor + 1);
        this.tui.requestRender();
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32 && this.inputText.length < BTW_MAX_INPUT_LENGTH) {
        this.inputText = this.inputText.slice(0, this.inputCursor) + data + this.inputText.slice(this.inputCursor);
        this.inputCursor++;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey2(data, "escape")) {
      this.done();
      return;
    }
    if (matchesKey2(data, "return")) {
      if (!this.currentQuestion || this.isSettled()) {
        this.mode = "input";
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey2(data, "m") && (!this.currentQuestion || this.isSettled())) {
      this.onTransfer();
      return;
    }
    if (matchesKey2(data, "up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
    } else if (matchesKey2(data, "down")) {
      this.scrollOffset++;
      this.tui.requestRender();
    }
  }
  render(width) {
    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const border = (s) => th.fg("border", s);
    const row = (content) => border("\u2502") + truncateToWidth2(content, innerW, "...", true) + border("\u2502");
    const blank = () => row("");
    const lines = [];
    const titleStr = ` ${th.fg("accent", "\u{1F4AC} btw")}${this.modelLabel ? `${th.fg("dim", " \xB7 ")}${th.fg("dim", this.modelLabel)}` : ""} `;
    const titleW = visibleWidth2(titleStr);
    lines.push(border(`\u256D${titleStr}${"\u2500".repeat(Math.max(0, innerW - titleW))}\u256E`));
    const contentWidth = innerW - 2;
    const contentLines = [];
    for (const { q, a } of this.qaPairs) {
      for (const ql of wrapText(q, contentWidth).slice(0, BTW_MAX_QUESTION_LINES)) {
        contentLines.push(th.fg("muted", `Q ${ql}`));
      }
      contentLines.push(...renderAnswer(a, th, contentWidth));
      contentLines.push("");
    }
    if (this.currentQuestion) {
      for (const ql of wrapText(this.currentQuestion, contentWidth).slice(0, BTW_MAX_QUESTION_LINES)) {
        contentLines.push(th.fg("accent", `Q ${ql}`));
      }
      if (this.status === "thinking") {
        contentLines.push(th.fg("dim", "  \u601D\u8003\u4E2D\u2026"));
      } else {
        contentLines.push(...renderAnswer(this.answer, th, contentWidth));
      }
      if (this.status === "error") contentLines.push(th.fg("error", `  \u2717 ${this.errorText}`));
    }
    const budget = Math.max(1, this.getMaxRows() - lines.length - 3);
    const maxOffset = Math.max(0, contentLines.length - budget);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
    const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + budget);
    for (const cl of visible) lines.push(row(` ${cl}`));
    for (let i = visible.length; i < budget; i++) lines.push(blank());
    if (this.mode === "input") {
      const inputW = Math.max(8, innerW - 5);
      const full = this.inputText;
      const totalW = visibleWidth2(full);
      let startChar = 0;
      if (totalW > inputW) {
        const cursorW = visibleWidth2(full.slice(0, this.inputCursor));
        startChar = charIndexAtWidth(full, Math.max(0, cursorW - Math.floor(inputW * 0.6)));
      }
      const windowText = sliceByWidth(full, startChar, inputW);
      const cursorInWindow = Math.min(Math.max(0, this.inputCursor - startChar), windowText.length);
      let inputDisplay = windowText;
      if (this.focused) {
        const before = inputDisplay.slice(0, cursorInWindow);
        const cursorChar = cursorInWindow < inputDisplay.length ? inputDisplay[cursorInWindow] : " ";
        const after = inputDisplay.slice(cursorInWindow + 1);
        inputDisplay = `${before}${CURSOR_MARKER2}\x1B[7m${cursorChar}\x1B[27m${after}`;
      }
      lines.push(row(` ${th.fg("accent", "\u276F")} ${inputDisplay}`));
      lines.push(row(th.fg("dim", "Enter \u53D1\u9001 \xB7 Esc \u53D6\u6D88")));
    } else {
      let statusStr;
      if (!this.currentQuestion) statusStr = th.fg("success", "\u2713 \u5F85\u547D \xB7 Enter \u63D0\u95EE");
      else if (this.status === "thinking") statusStr = th.fg("dim", "\u23F3 \u601D\u8003\u4E2D\u2026");
      else if (this.status === "streaming")
        statusStr = th.fg("accent", this.toolLabel ? `\u23F3 ${this.toolLabel}` : "\u23F3 \u56DE\u7B54\u4E2D\u2026");
      else if (this.status === "done") statusStr = th.fg("success", "\u2713 \u56DE\u7B54\u5B8C\u6BD5");
      else statusStr = th.fg("error", `\u2717 ${this.errorText}`);
      const hints = [];
      if (!this.currentQuestion) hints.push("Enter \u63D0\u95EE", "m \u8F6C\u6B63");
      else if (this.isSettled()) hints.push("Enter \u8FFD\u95EE", "m \u8F6C\u6B63");
      hints.push("Esc \u5173\u95ED");
      if (contentLines.length > budget) hints.push("\u2191\u2193 \u6EDA\u52A8");
      lines.push(row(statusStr));
      lines.push(row(th.fg("dim", hints.join(" \xB7 "))));
    }
    lines.push(border(`\u2570${"\u2500".repeat(innerW)}\u256F`));
    return lines;
  }
  invalidate() {
  }
  dispose() {
  }
};
async function runBtwTurn(ctx, model, thread, question, signal, overlay, onDone, failover, retries = 0) {
  const tools = createReadOnlyTools(ctx.cwd);
  const sessionMessages = ctx.sessionManager.buildSessionContext().messages;
  const context = buildContextMessages(sessionMessages, ctx);
  const history = mergeAdjacent([...context, ...thread]).slice(-BTW_MAX_TOTAL_MESSAGES);
  const userMessage = { role: "user", content: question, timestamp: Date.now() };
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
    maxTokens: BTW_MAX_TOKENS,
    convertToLlm,
    shouldStopAfterTurn: () => ++turns >= BTW_MAX_TURNS
  };
  try {
    const newMessages = await runAgentLoop(
      [userMessage],
      { systemPrompt: BTW_SYSTEM_PROMPT, messages: history, tools },
      config,
      (event) => {
        if (event.type === "tool_execution_start") {
          overlay.showTool(event.toolName, event.args);
        } else if (event.type === "tool_execution_end") {
          overlay.hideTool();
        } else if (event.type === "message_update") {
          const s = event.assistantMessageEvent;
          if (s.type === "text_delta") overlay.appendAnswer(s.delta);
        }
      },
      signal,
      streamFn
    );
    for (let i = newMessages.length - 1; i >= 0; i--) {
      const m = newMessages[i];
      if (m.role !== "assistant") continue;
      const text = extractText(m);
      if (text) {
        overlay.finish(text);
        onDone(text);
        return;
      }
    }
    const fallback = overlay.getAnswer();
    if (!fallback) {
      if (retries < BTW_EMPTY_RETRY) {
        overlay.startQuestion(question);
        return runBtwTurn(ctx, model, thread, question, signal, overlay, onDone, failover, retries + 1);
      }
      const next = failover?.();
      if (next) {
        overlay.setModel(`${next.provider}/${next.id}`);
        overlay.startQuestion(question);
        return runBtwTurn(ctx, next, thread, question, signal, overlay, onDone, failover, 0);
      }
      overlay.fail(`\u6240\u6709\u5019\u9009\u6A21\u578B\u5747\u65E0\u6587\u5B57\u56DE\u7B54\uFF08\u6700\u540E\u5C1D\u8BD5\uFF1A${model.provider}/${model.id}\uFF09`);
      return;
    }
    overlay.finish(fallback);
    onDone(fallback);
  } catch (e) {
    if (signal.aborted) return;
    const next = failover?.();
    if (next) {
      overlay.setModel(`${next.provider}/${next.id}`);
      overlay.startQuestion(question);
      return runBtwTurn(ctx, next, thread, question, signal, overlay, onDone, failover, retries);
    }
    overlay.fail(e instanceof Error ? e.message : String(e));
  }
}
function btw_default(pi) {
  let activeBtw = null;
  let pendingTransfer = null;
  pi.on("input", async (event, ctx) => {
    if (pendingTransfer && event.source === "interactive") {
      const attach = pendingTransfer;
      pendingTransfer = null;
      ctx.ui.setStatus("btw-transfer", void 0);
      return { action: "transform", text: `${event.text}

---

${attach}` };
    }
    return { action: "continue" };
  });
  pi.registerCommand("btw", {
    description: "\u4E34\u65F6\u65C1\u652F\u95EE\u7B54\uFF08by the way\uFF09\uFF1A\u4FA7\u680F\u95EE\u7B54\uFF0C\u4E0D\u5199\u5165\u4F1A\u8BDD\u5386\u53F2\uFF1BEnter \u8FFD\u95EE\u3001m \u8F6C\u6B63",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw \u9700\u8981\u4EA4\u4E92\u6A21\u5F0F", "error");
        return;
      }
      const firstQuestion = args?.trim();
      if (!firstQuestion) {
        ctx.ui.notify("\u7528\u6CD5\uFF1A/btw <\u95EE\u9898>", "warning");
        return;
      }
      const plan = resolveBtwModel(ctx);
      if (!plan.model) {
        ctx.ui.notify("\u6CA1\u6709\u53EF\u7528\u7684\u5DF2\u8BA4\u8BC1\u6A21\u578B\uFF0C\u65E0\u6CD5\u542F\u52A8 btw\uFF08\u8BF7\u5148\u914D\u7F6E provider \u8BA4\u8BC1\uFF09", "error");
        return;
      }
      const autoHint = btwModelSetting === "auto-not-free" ? "\uFF08auto-not-free\uFF0C\u6700\u4FBF\u5B9C\u975E\u514D\u8D39\u6A21\u578B\uFF0C\u6309\u4EF7\u683C\u987A\u5E8F\u6545\u969C\u8F6C\u79FB\uFF09" : "\uFF08auto\uFF0C\u6700\u4FBF\u5B9C\u53EF\u7528\uFF0C\u6309\u4EF7\u683C\u987A\u5E8F\u6545\u969C\u8F6C\u79FB\uFF09";
      ctx.ui.notify(`btw \u4F7F\u7528\u6A21\u578B\uFF1A${plan.model.provider}/${plan.model.id}${plan.mode === "auto" ? autoHint : ""}`, "info");
      if (activeBtw) {
        ctx.ui.notify("\u5DF2\u6709 btw \u9762\u677F\u6253\u5F00\uFF0C\u5148\u6309 Esc \u5173\u95ED\u518D\u63D0\u95EE", "warning");
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("btw \u8D85\u65F6")), BTW_TIMEOUT_MS);
      activeBtw = { abort: () => controller.abort() };
      const thread = [];
      let overlayRef = null;
      let closePanel = null;
      const ask = (question) => {
        if (controller.signal.aborted) return;
        const p = resolveBtwModel(ctx);
        if (!p.model) {
          overlayRef?.fail("\u6CA1\u6709\u53EF\u7528\u7684\u5DF2\u8BA4\u8BC1\u6A21\u578B");
          return;
        }
        overlayRef?.setModel(`${p.model.provider}/${p.model.id}`);
        overlayRef?.startQuestion(question);
        void runBtwTurn(ctx, p.model, thread, question, controller.signal, overlayRef, (answer) => {
          thread.push({ role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() });
          thread.push({ role: "assistant", content: [{ type: "text", text: answer }], timestamp: Date.now() });
          if (thread.length > BTW_MAX_THREAD_TURNS * 2) {
            thread.splice(0, thread.length - BTW_MAX_THREAD_TURNS * 2);
          }
          overlayRef?.commit();
        }, p.failover);
      };
      const transfer = () => {
        if (controller.signal.aborted) return;
        const transcript = overlayRef?.getTranscript() ?? "";
        if (!transcript) return;
        pendingTransfer = `[btw \u8F6C\u4EA4] \u4EE5\u4E0B\u662F\u6211\u5728\u4FA7\u680F\u7528 /btw \u7684\u4E34\u65F6\u95EE\u7B54\uFF08\u672A\u5199\u5165\u672C\u4F1A\u8BDD\u5386\u53F2\uFF09\uFF0C\u5176\u4E2D\u503C\u5F97\u7EE7\u7EED\u8DDF\u8FDB\uFF0C\u8BF7\u57FA\u4E8E\u6B64\u7EE7\u7EED\u5904\u7406\uFF1A

${transcript}

\uFF08\u76F4\u63A5\u6309\u5185\u5BB9\u7EE7\u7EED\u5373\u53EF\uFF0C\u65E0\u9700\u56DE\u5E94\u6B64\u6765\u6E90\u6807\u8BB0\u672C\u8EAB\uFF09`;
        ctx.ui.setStatus("btw-transfer", "\u{1F4CE} \u5DF2\u9644\u5E26 btw \u95EE\u7B54");
        ctx.ui.notify("\u{1F4CE} \u5DF2\u9644\u5E26 btw \u95EE\u7B54\uFF0C\u4E0B\u4E00\u6761\u6D88\u606F\u5C06\u968F\u9644\u53D1\u9001", "info");
        closePanel?.();
      };
      try {
        await ctx.ui.custom(
          (tui, theme, _kb, done) => {
            closePanel = () => done();
            const overlay = new BtwOverlay(tui, theme, ask, transfer, done);
            overlayRef = overlay;
            ask(firstQuestion);
            return overlay;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "right-center",
              width: BTW_OVERLAY_WIDTH,
              minWidth: BTW_OVERLAY_MIN_WIDTH,
              maxHeight: BTW_OVERLAY_MAX_HEIGHT,
              margin: { right: 1 }
            }
          }
        );
      } finally {
        clearTimeout(timer);
        activeBtw = null;
        controller.abort();
      }
    }
  });
  pi.registerCommand("btw-config", {
    description: "\u914D\u7F6E btw \u4F7F\u7528\u7684\u6A21\u578B\uFF1Aauto\uFF08\u9ED8\u8BA4\uFF0C\u6700\u4FBF\u5B9C\u53EF\u7528\u6A21\u578B\uFF09\u3001auto-not-free\uFF08\u5FFD\u7565\u514D\u8D39\u6A21\u578B\uFF09\u6216 provider/modelId\uFF1B\u4E0D\u5E26\u53C2\u6570\u8FDB\u5165\u4EA4\u4E92\u9009\u62E9\uFF08\u542B\u641C\u7D22\uFF09",
    handler: async (args, ctx) => {
      const arg = args?.trim() ?? "";
      if (arg) {
        if (arg === "auto" || arg === "auto-not-free") {
          setBtwModelSetting(arg);
          ctx.ui.notify(`btw \u6A21\u578B\u5DF2\u8BBE\u4E3A ${arg}\uFF08${btwSettingLabel(arg)}\uFF09`, "info");
          return;
        }
        const m = findConfiguredModel(ctx, arg);
        if (m) {
          setBtwModelSetting(`${m.provider}/${m.id}`);
          ctx.ui.notify(`btw \u6A21\u578B\u5DF2\u8BBE\u4E3A ${btwModelSetting}`, "info");
          return;
        }
        const matches = listAvailableModels(ctx).filter(
          (x) => `${x.provider}/${x.id}`.toLowerCase().includes(arg.toLowerCase())
        );
        ctx.ui.notify(
          matches.length > 0 ? `\u300C${arg}\u300D\u5339\u914D ${matches.length} \u4E2A\u6A21\u578B\uFF08${matches.slice(0, 3).map((x) => `${x.provider}/${x.id}`).join("\u3001")}${matches.length > 3 ? " \u7B49" : ""}\uFF09\uFF0C\u8BF7\u7528\u5B8C\u6574 provider/modelId \u6307\u5B9A` : `\u672A\u627E\u5230\u300C${arg}\u300D\u3002\u7528\u6CD5\uFF1A/btw-config auto\u3001auto-not-free \u6216 /btw-config provider/modelId`,
          "warning"
        );
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(
          `\u5F53\u524D btw \u6A21\u578B\uFF1A${btwModelSetting}\u3002\u7528\u6CD5\uFF1A/btw-config auto\u3001auto-not-free \u6216 /btw-config provider/modelId`,
          "info"
        );
        return;
      }
      const models = listAvailableModels(ctx);
      const items = [
        {
          label: "auto\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u6700\u4FBF\u5B9C\u53EF\u7528\u6A21\u578B\uFF0C\u6309\u4EF7\u683C\u987A\u5E8F\u6545\u969C\u8F6C\u79FB",
          value: "auto",
          search: "auto \u9ED8\u8BA4"
        },
        {
          label: "auto-not-free\uFF1A\u5FFD\u7565\u514D\u8D39\u6A21\u578B\uFF0C\u6700\u4FBF\u5B9C\u7684\u975E\u514D\u8D39\u6A21\u578B\u6309\u4EF7\u683C\u987A\u5E8F\u6545\u969C\u8F6C\u79FB",
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
        (tui, theme, _kb, done) => new ModelSelectOverlay(tui, theme, items, btwModelSetting, done),
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
        setBtwModelSetting(result);
        ctx.ui.notify(`btw \u6A21\u578B\u5DF2\u8BBE\u4E3A ${result}\uFF08${btwSettingLabel(result)}\uFF09`, "info");
      }
    }
  });
  pi.on("session_shutdown", async () => {
    activeBtw?.abort();
    activeBtw = null;
    pendingTransfer = null;
  });
}
export {
  btw_default as default
};
