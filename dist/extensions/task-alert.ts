// src/extensions/task-alert.ts
import * as os from "node:os";
import * as path from "node:path";
var SOUND_PATH = path.join(os.homedir(), ".pi", "agent", "sounds", "task_complete.wav");
var PLAYERS = {
  win32: [
    { cmd: "powershell", args: (f) => ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${f}').PlaySync()`] }
  ],
  darwin: [
    { cmd: "afplay", args: (f) => [f] }
    // macOS 自带
  ],
  linux: [
    { cmd: "paplay", args: (f) => [f] },
    // PulseAudio / PipeWire
    { cmd: "aplay", args: (f) => [f] }
    // ALSA
  ]
};
var TITLE_INTERVAL_MS = 500;
var AUTO_DISMISS_MS = 6e5;
var TITLE_FRAMES = ["\u2705 \u4EFB\u52A1\u5B8C\u6210 \u2014 pi", "\u2728 \u4EFB\u52A1\u5B8C\u6210 \u2014 pi"];
var STATUS_FRAMES = ["\u2705 \u4EFB\u52A1\u5B8C\u6210", "\u2728 \u4EFB\u52A1\u5B8C\u6210"];
function isAbortedEnd(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") return m.stopReason === "aborted";
  }
  return false;
}
function task_alert_default(pi) {
  let titleTimer;
  let dismissTimer;
  let statusTimer;
  let statusFrame = 0;
  let frame = 0;
  let alertActive = false;
  let currentCtx = null;
  let inputHookInstalled = false;
  let lastEndWasAbort = false;
  function clearTimers() {
    if (titleTimer) clearInterval(titleTimer);
    if (dismissTimer) clearTimeout(dismissTimer);
    if (statusTimer) clearInterval(statusTimer);
    titleTimer = void 0;
    dismissTimer = void 0;
    statusTimer = void 0;
  }
  function stopAlert(ctx) {
    if (!alertActive) return;
    alertActive = false;
    clearTimers();
    ctx.ui.setStatus("task-alert", void 0);
    if (ctx.hasUI) ctx.ui.setTitle("");
  }
  function playSound() {
    const candidates = PLAYERS[process.platform] ?? [];
    const tryNext = (i) => {
      if (i >= candidates.length) {
        process.stdout.write("\x07");
        return;
      }
      const { cmd, args } = candidates[i];
      pi.exec(cmd, args(SOUND_PATH)).then((r) => {
        if (r.code !== 0) tryNext(i + 1);
      }).catch(() => tryNext(i + 1));
    };
    tryNext(0);
  }
  pi.on("agent_end", async (event) => {
    lastEndWasAbort = isAbortedEnd(event.messages);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (lastEndWasAbort) {
      lastEndWasAbort = false;
      return;
    }
    alertActive = true;
    playSound();
    if (ctx.hasUI) {
      statusFrame = 0;
      ctx.ui.setStatus("task-alert", STATUS_FRAMES[0]);
      statusTimer = setInterval(() => {
        statusFrame++;
        ctx.ui.setStatus("task-alert", STATUS_FRAMES[statusFrame % STATUS_FRAMES.length]);
      }, TITLE_INTERVAL_MS);
    }
    if (ctx.hasUI) {
      frame = 0;
      titleTimer = setInterval(() => {
        frame++;
        ctx.ui.setTitle(TITLE_FRAMES[frame % TITLE_FRAMES.length]);
      }, TITLE_INTERVAL_MS);
    }
    dismissTimer = setTimeout(() => stopAlert(ctx), AUTO_DISMISS_MS);
  });
  pi.on("agent_start", async (_event, ctx) => {
    lastEndWasAbort = false;
    stopAlert(ctx);
  });
  pi.on("input", async (_event, ctx) => {
    stopAlert(ctx);
    return { action: "continue" };
  });
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.mode !== "tui" || inputHookInstalled) return;
    inputHookInstalled = true;
    ctx.ui.onTerminalInput(() => {
      if (alertActive && currentCtx) stopAlert(currentCtx);
      return { consume: false };
    });
  });
  pi.on("session_shutdown", async () => clearTimers());
}
export {
  task_alert_default as default
};
