// extensions/token-saver.ts
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
var TMP_DIR = path.join(os.homedir(), ".pi", "agent", "tmp");
var UNIVERSAL_MAX_LINES = 200;
var UNIVERSAL_HEAD_LINES = 150;
var UNIVERSAL_TAIL_LINES = 30;
var GIT_MAX_LINES = 80;
var GIT_HEAD_LINES = 60;
var GIT_TAIL_LINES = 10;
var TSC_MAX_ERRORS = 20;
var HELP_MAX_LINES = 40;
var HELP_HEAD_LINES = 35;
function truncate(text, maxLines, headLines, tailLines) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, headLines).join("\n");
  const omitted = lines.length - headLines - tailLines;
  const summary = `

... [\u7701\u7565 ${omitted} \u884C\uFF0C\u539F\u59CB ${lines.length} \u884C] ...`;
  if (tailLines <= 0) {
    return `${head}${summary}
`;
  }
  const tail = lines.slice(-tailLines).join("\n");
  return `${head}${summary}

${tail}`;
}
function trimTrailing(text) {
  return text.replace(/\n+$/, "\n");
}
function hasCommand(command, bin) {
  const re = new RegExp(`(?:^|[|;&\\s])${bin}(?:\\s|[|;&]|$)`);
  return re.test(command);
}
function saveOriginal(command, text) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const now = /* @__PURE__ */ new Date();
  const ts = [
    String(now.getFullYear()).slice(-2),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");
  const hash = crypto.createHash("md5").update(text).digest("hex").slice(0, 12);
  const filename = `${ts}_${hash}.log`;
  const filepath = path.join(TMP_DIR, filename);
  fs.writeFileSync(filepath, text, "utf8");
  return filepath;
}
function makeHint(filepath) {
  return `

[token-saver] \u4E3A\u8282\u7701 token\uFF0C\u8F93\u51FA\u5DF2\u88AB\u7CBE\u7B80\u5904\u7406\u3002\u5B8C\u6574\u539F\u59CB\u8F93\u51FA\u5DF2\u4FDD\u5B58\uFF1A${filepath}`;
}
var CRLF_RE = /^(?:warning|note): (?:LF|CRLF) (?:will be|would be) /;
var HINT_START = /^(Changes to be committed|Changes not staged|Untracked files):/;
function isGitCommand(command) {
  const re = /(?:^|[|;&\s])git\s/;
  if (!re.test(command)) return false;
  const sub = getGitSubcommand(command);
  const excluded = ["credential", "remote-ext", "remote-ftp", "remote-ftps", "remote-http", "remote-https"];
  return !excluded.includes(sub);
}
function getGitSubcommand(command) {
  const gitMatch = command.match(/(?:^|[|;&\s])git\s+/);
  if (!gitMatch) return "";
  const afterGit = command.slice((gitMatch.index ?? 0) + gitMatch[0].length);
  const parts = afterGit.split(/\s+/);
  for (const part of parts) {
    if (part.startsWith("-")) continue;
    return part;
  }
  return "";
}
function filterGitStatus(text) {
  const lines = text.split("\n");
  const result = [];
  let inHintBlock = false;
  for (const line of lines) {
    if (/^\s*\(use /.test(line) || /^no changes added to commit /.test(line)) {
      inHintBlock = true;
      continue;
    }
    if (inHintBlock) {
      if (line === "" || HINT_START.test(line)) {
        inHintBlock = false;
        if (line !== "") result.push(line);
      }
      continue;
    }
    result.push(line);
  }
  return result.join("\n");
}
function filterGit(command, text) {
  const sub = getGitSubcommand(command);
  let r = text;
  if (sub === "status" && !command.includes("--porcelain")) r = filterGitStatus(r);
  if (sub === "diff" || sub === "log" || sub === "show") r = truncate(r, GIT_MAX_LINES, GIT_HEAD_LINES, GIT_TAIL_LINES);
  if (["commit", "push", "pull", "merge", "rebase", "checkout", "stash"].includes(sub)) {
    r = r.split("\n").filter((l) => !CRLF_RE.test(l)).join("\n");
  }
  return trimTrailing(r);
}
function filterNpm(text) {
  const filtered = text.split("\n").filter((line) => {
    if (/^npm WARN\b/.test(line)) return false;
    if (/^npm audit\b/.test(line)) return false;
    if (/^\d+ vulnerabilities? /.test(line)) return false;
    return true;
  });
  return trimTrailing(filtered.join("\n"));
}
function filterPnpm(text) {
  const filtered = text.split("\n").filter((line) => {
    if (/^Progress:/.test(line)) return false;
    if (/^\s*└─/.test(line) && /Packages:/.test(line)) return false;
    if (/^ /.test(line) && /WARN/.test(line)) return false;
    return true;
  });
  return trimTrailing(filtered.join("\n"));
}
function filterTsc(text) {
  const lines = text.split("\n");
  const tscErrorRe = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;
  const errors = [];
  const otherLines = [];
  let seenFiles = /* @__PURE__ */ new Set();
  for (const line of lines) {
    const m = line.match(tscErrorRe);
    if (m) {
      seenFiles.add(m[1]);
      errors.push({ file: m[1], line });
    } else {
      otherLines.push(line);
    }
  }
  if (errors.length === 0) return text;
  if (errors.length <= TSC_MAX_ERRORS) return trimTrailing(text);
  const kept = errors.slice(0, TSC_MAX_ERRORS);
  const byFile = /* @__PURE__ */ new Map();
  for (const e of errors) byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1);
  const result = [...otherLines.filter((l) => l.trim() !== "")];
  for (const e of kept) result.push(e.line);
  result.push("");
  result.push(`... [\u5171 ${errors.length} \u4E2A\u9519\u8BEF\uFF0C\u6D89\u53CA ${seenFiles.size} \u4E2A\u6587\u4EF6\uFF0C\u4EC5\u663E\u793A\u524D ${TSC_MAX_ERRORS} \u4E2A] ...`);
  result.push(`\u6587\u4EF6\u5206\u5E03\uFF1A${[...byFile.entries()].map(([f, n]) => `${f}(${n})`).join(" \xB7 ")}`);
  return trimTrailing(result.join("\n"));
}
function filterPip(text) {
  const filtered = text.split("\n").filter((line) => {
    if (/[▏▎▍▌▋▊▉█]{2,}/.test(line)) return false;
    if (/^\s*\d+%/.test(line)) return false;
    if (/^\s*\d+\.\d+ [KM]B\/s/.test(line)) return false;
    if (/^WARNING: /i.test(line)) return false;
    return true;
  });
  return trimTrailing(filtered.join("\n"));
}
function filterDocker(text) {
  const filtered = text.split("\n").filter((line) => {
    if (/^\[=*>?\s*\]\s*\d+%/.test(line)) return false;
    if (/^\w+: (Pulling|Downloading|Download complete|Verifying|Pull complete|Already exists)/.test(line)) return false;
    if (/^---> [a-f0-9]+$/.test(line)) return false;
    return true;
  });
  return trimTrailing(filtered.join("\n"));
}
function filterHelpOutput(text) {
  return truncate(text, HELP_MAX_LINES, HELP_HEAD_LINES, 0);
}
function filterOutput(command, text) {
  let filtered = text;
  if (/\s--?h(elp)?\b/.test(command)) filtered = filterHelpOutput(filtered);
  if (isGitCommand(command)) filtered = filterGit(command, filtered);
  if (hasCommand(command, "pnpm")) filtered = filterPnpm(filtered);
  else if (hasCommand(command, "npm")) filtered = filterNpm(filtered);
  if (hasCommand(command, "tsc")) filtered = filterTsc(filtered);
  if (hasCommand(command, "pip3") || hasCommand(command, "pip")) filtered = filterPip(filtered);
  if (hasCommand(command, "docker")) filtered = filterDocker(filtered);
  filtered = trimTrailing(filtered);
  if (filtered.split("\n").length > UNIVERSAL_MAX_LINES) {
    filtered = truncate(filtered, UNIVERSAL_MAX_LINES, UNIVERSAL_HEAD_LINES, UNIVERSAL_TAIL_LINES);
  }
  return { filtered, truncated: filtered !== text };
}
function token_saver_default(pi) {
  const SAVE_EMIT_THROTTLE_MS = 4e3;
  let savedChars = 0;
  let savedLines = 0;
  let lastSaveEmit = 0;
  let saveClearTimer;
  function emitSaved(ctx) {
    if (savedChars <= 0) return;
    const now = Date.now();
    if (now - lastSaveEmit < SAVE_EMIT_THROTTLE_MS) return;
    const unit = savedChars >= 1e6 ? `${(savedChars / 1e6).toFixed(1)}M` : savedChars >= 1e3 ? `${(savedChars / 1e3).toFixed(1)}k` : String(savedChars);
    ctx.ui.setStatus("token-saver", `\u2702 \u7701 ${unit}`);
    if (saveClearTimer) clearTimeout(saveClearTimer);
    saveClearTimer = setTimeout(() => ctx.ui.setStatus("token-saver", void 0), 6e3);
    savedChars = 0;
    savedLines = 0;
    lastSaveEmit = now;
  }
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = event.input?.command ?? "";
    if (!command) return;
    for (const block of event.content) {
      if (block.type !== "text" || !block.text) continue;
      const original = block.text;
      const { filtered, truncated } = filterOutput(command, original);
      if (truncated) {
        const filepath = saveOriginal(command, original);
        block.text = filtered + makeHint(filepath);
        savedChars += original.length - filtered.length;
        savedLines += original.split(/\r?\n/).length - filtered.split(/\r?\n/).length;
        emitSaved(ctx);
      }
    }
  });
}
export {
  token_saver_default as default
};
