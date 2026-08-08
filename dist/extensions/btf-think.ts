// src/extensions/btf-think.ts
var FRAME_INTERVAL_MS = 400;
function btf_think_default(pi) {
  let thinkingAnimTimer;
  let thinkingDots = 0;
  function startAnimation(ctx) {
    stopAnimation();
    const tick = () => {
      thinkingDots = thinkingDots % 4 + 1;
      ctx.ui.setHiddenThinkingLabel(`Thinking${".".repeat(thinkingDots)}`);
    };
    tick();
    thinkingAnimTimer = setInterval(tick, FRAME_INTERVAL_MS);
  }
  function stopAnimation(ctx) {
    if (thinkingAnimTimer) {
      clearInterval(thinkingAnimTimer);
      thinkingAnimTimer = void 0;
    }
    if (ctx) ctx.ui.setHiddenThinkingLabel();
  }
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role === "assistant") startAnimation(ctx);
  });
  pi.on("message_end", async (_event, ctx) => {
    stopAnimation(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    stopAnimation(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    stopAnimation(ctx);
  });
  pi.on("session_shutdown", async () => {
    stopAnimation();
  });
}
export {
  btf_think_default as default
};
