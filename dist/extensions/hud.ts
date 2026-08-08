var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// extensions/hud/hud-cost.ts
var hud_cost_exports = {};
__export(hud_cost_exports, {
  currencySymbol: () => currencySymbol,
  fmtNum: () => fmtNum,
  getRateSource: () => getRateSource,
  getStartupTime: () => getStartupTime,
  getTokenRate: () => getTokenRate,
  getUsdCnyRate: () => getUsdCnyRate,
  meteredRateText: () => meteredRateText,
  recordTurnCosts: () => recordTurnCosts,
  refreshExchangeRate: () => refreshExchangeRate,
  resetCostTracking: () => resetCostTracking,
  startTurn: () => startTurn,
  sumSessionUsage: () => sumSessionUsage
});
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function loadRateCache() {
  try {
    if (fs.existsSync(RATE_CACHE_FILE)) {
      const d = JSON.parse(fs.readFileSync(RATE_CACHE_FILE, "utf8"));
      if (typeof d.rate === "number" && d.rate > 0) return d.rate;
    }
  } catch {
  }
  return null;
}
function saveRateCache(rate) {
  try {
    fs.mkdirSync(path.dirname(RATE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(RATE_CACHE_FILE, JSON.stringify({ rate, fetchedAt: Date.now() }));
  } catch {
  }
}
function getUsdCnyRate() {
  return usdCnyRate;
}
function getRateSource() {
  return rateSource;
}
async function refreshExchangeRate() {
  const sources = [
    async () => {
      const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY", {
        signal: AbortSignal.timeout(8e3)
      });
      if (!res.ok) return null;
      const d = await res.json();
      const v = d.rates?.CNY;
      return typeof v === "number" && v > 0 ? v : null;
    },
    async () => {
      const res = await fetch("https://open.er-api.com/v6/latest/USD", {
        signal: AbortSignal.timeout(8e3)
      });
      if (!res.ok) return null;
      const d = await res.json();
      const v = d.result === "success" ? d.rates?.CNY : void 0;
      return typeof v === "number" && v > 0 ? v : null;
    }
  ];
  for (const src of sources) {
    try {
      const rate = await src();
      if (rate !== null) {
        usdCnyRate = rate;
        rateSource = "live";
        saveRateCache(rate);
        return;
      }
    } catch {
    }
  }
  const cached = loadRateCache();
  usdCnyRate = cached;
  rateSource = cached !== null ? "cached" : "none";
}
function currencySymbol(currency) {
  switch (currency) {
    case "CNY":
      return "\xA5";
    case "USD":
      return "$";
    default:
      return `${currency} `;
  }
}
function sumSessionUsage(ctx) {
  const t = {
    input: 0,
    output: 0,
    cacheRead: 0,
    costTotalCny: 0,
    costTotalUsd: 0,
    turns: 0
  };
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant") {
      const m = e.message;
      const u = m.usage;
      t.input += u.input;
      t.output += u.output;
      t.cacheRead += u.cacheRead;
      const c = msgCost(m);
      if ("cny" in c) t.costTotalCny += c.cny;
      else t.costTotalUsd += c.usd;
      t.turns++;
    }
  }
  return t;
}
function getStartupTime() {
  return startupTime;
}
function computeRate(now) {
  const elapsed = now - startupTime;
  if (elapsed < MIN_WINDOW_MS) return { cny: null, usd: null };
  const windowMs = Math.min(elapsed, RATE_WINDOW_MS);
  const cutoff = now - windowMs;
  let cny = 0, usd = 0;
  for (const e of costEvents) {
    if (e.ts < cutoff) continue;
    cny += e.cny;
    usd += e.usd;
  }
  const div = windowMs / 6e4;
  return { cny: cny / div, usd: usd / div };
}
function sumOutputTokens(ctx) {
  let total = 0;
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant") {
      total += e.message.usage.output;
    }
  }
  return total;
}
function computeTokenRate(_now) {
  return smoothedTokenRate;
}
function resetCostTracking(ctx) {
  startupTime = Date.now();
  const sums = sumCosts(ctx);
  lastRecordedCny = sums.cny;
  lastRecordedUsd = sums.usd;
  lastRecordedOutputTotal = sumOutputTokens(ctx);
  costEvents = [];
  turnStartTime = null;
  smoothedTokenRate = null;
}
function startTurn() {
  turnStartTime = Date.now();
}
function recordTurnCosts(ctx) {
  const sums = sumCosts(ctx);
  const dcny = sums.cny - lastRecordedCny;
  const dusd = sums.usd - lastRecordedUsd;
  lastRecordedCny = sums.cny;
  lastRecordedUsd = sums.usd;
  if (dcny > 0 || dusd > 0) {
    costEvents.push({ ts: Date.now(), cny: dcny, usd: dusd });
    const cutoff = Date.now() - RATE_WINDOW_MS;
    costEvents = costEvents.filter((e) => e.ts >= cutoff);
  }
  const outputTotal = sumOutputTokens(ctx);
  const outputDelta = outputTotal - lastRecordedOutputTotal;
  lastRecordedOutputTotal = outputTotal;
  if (outputDelta > 0 && turnStartTime != null) {
    const durationMs = Math.max(100, Date.now() - turnStartTime);
    const turnRate = outputDelta / (durationMs / 1e3);
    smoothedTokenRate = smoothedTokenRate == null ? turnRate : smoothedTokenRate * (1 - TOKEN_RATE_SMOOTH_FACTOR) + turnRate * TOKEN_RATE_SMOOTH_FACTOR;
  }
  turnStartTime = null;
}
function sumCosts(ctx) {
  let cny = 0, usd = 0;
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant") {
      const c = msgCost(e.message);
      if ("cny" in c) cny += c.cny;
      else usd += c.usd;
    }
  }
  return { cny, usd };
}
function getTokenRate(now) {
  return computeTokenRate(now);
}
function isDeepSeekPeakHour(ts) {
  const hour = new Date(ts + 8 * 36e5).getUTCHours();
  return DEEPSEEK_PEAK_HOURS.some(([start, end]) => hour >= start && hour < end);
}
function deepseekModelKey(modelId) {
  return modelId.toLowerCase().includes("pro") ? "deepseek-v4-pro" : "deepseek-v4-flash";
}
function deepseekCostCny(u, modelId, ts) {
  const p = DEEPSEEK_PRICES[deepseekModelKey(modelId)] ?? DEEPSEEK_PRICES["deepseek-v4-flash"];
  const peak = DEEPSEEK_PEAK_PRICING && isDeepSeekPeakHour(ts) ? 2 : 1;
  return (p.cacheMiss * u.input + p.cacheHit * u.cacheRead + p.output * u.output) * peak / 1e6;
}
function msgCost(m) {
  if (m.provider === "deepseek") return { cny: deepseekCostCny(m.usage, m.model, m.timestamp) };
  return { usd: m.usage.cost.total };
}
function meteredRateText(ctx, now) {
  const t = sumSessionUsage(ctx);
  if (t.turns === 0) return null;
  if (ctx.model?.provider === "deepseek") {
    const perMinCny = computeRate(now).cny ?? 0;
    return [
      { text: `\xA5${perMinCny.toFixed(3)}/min`, color: "muted" },
      { text: `\xA5${t.costTotalCny.toFixed(2)}`, color: "dim" }
    ];
  }
  const perMinUsd = computeRate(now).usd ?? 0;
  const totalUsd = t.costTotalUsd;
  const rate = usdCnyRate;
  if (rate !== null && rate > 0) {
    return [
      { text: `\xA5${(perMinUsd * rate).toFixed(3)}/min`, color: "muted" },
      { text: `\xA5${(totalUsd * rate).toFixed(2)}`, color: "dim" }
    ];
  }
  return [
    { text: `$${perMinUsd.toFixed(3)}/min`, color: "muted" },
    { text: `$${totalUsd.toFixed(2)}`, color: "dim" }
  ];
}
var usdCnyRate, rateSource, RATE_CACHE_FILE, RATE_WINDOW_MS, MIN_WINDOW_MS, costEvents, lastRecordedCny, lastRecordedUsd, startupTime, lastRecordedOutputTotal, turnStartTime, smoothedTokenRate, TOKEN_RATE_SMOOTH_FACTOR, fmtNum, DEEPSEEK_PRICES, DEEPSEEK_PEAK_PRICING, DEEPSEEK_PEAK_HOURS;
var init_hud_cost = __esm({
  "extensions/hud/hud-cost.ts"() {
    usdCnyRate = null;
    rateSource = "none";
    RATE_CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "tmp", "exchange-rate.json");
    RATE_WINDOW_MS = 10 * 60 * 1e3;
    MIN_WINDOW_MS = 60 * 1e3;
    costEvents = [];
    lastRecordedCny = 0;
    lastRecordedUsd = 0;
    startupTime = Date.now();
    lastRecordedOutputTotal = 0;
    turnStartTime = null;
    smoothedTokenRate = null;
    TOKEN_RATE_SMOOTH_FACTOR = 0.2;
    fmtNum = (n) => {
      if (n >= 1e6) {
        const v = n / 1e6;
        return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}m`;
      }
      if (n >= 1e3) {
        const v = n / 1e3;
        return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}k`;
      }
      return `${n}`;
    };
    DEEPSEEK_PRICES = {
      "deepseek-v4-flash": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
      "deepseek-v4-pro": { cacheHit: 0.025, cacheMiss: 3, output: 6 }
    };
    DEEPSEEK_PEAK_PRICING = false;
    DEEPSEEK_PEAK_HOURS = [
      [9, 12],
      [14, 18]
    ];
  }
});

// extensions/hud/hud-balance.ts
var hud_balance_exports = {};
__export(hud_balance_exports, {
  BALANCE_ADAPTERS: () => BALANCE_ADAPTERS,
  KIMI_CODING_BASE_URL: () => KIMI_CODING_BASE_URL
});
function toInt(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}
function fixedPointToCents(value) {
  const cents = value / KIMI_FIXED_POINT_CENTS;
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}
function formatMoney(cents, currency) {
  const amount = (cents / 100).toFixed(2);
  return currency === "CNY" || currency === "" ? `CNY ${amount}` : `${currency} ${amount}`;
}
function formatWindow(window) {
  const duration = toInt(window?.duration);
  if (duration === null) return "";
  switch (window?.timeUnit) {
    case "TIME_UNIT_MINUTE":
      return `${duration}min`;
    case "TIME_UNIT_HOUR":
      return `${duration}h`;
    case "TIME_UNIT_DAY":
      return `${duration}d`;
    case "TIME_UNIT_WEEK":
      return duration === 1 ? "\u5468" : `${duration}\u5468`;
    default:
      return "";
  }
}
function formatWindowShort(window) {
  const duration = toInt(window?.duration);
  if (duration === null) return "";
  if (window?.timeUnit === "TIME_UNIT_MINUTE" && duration >= 60 && duration % 60 === 0) {
    return `${duration / 60}h`;
  }
  return formatWindow(window);
}
function formatUsageRow(row) {
  const name = row.name && row.name.length > 0 ? row.name : formatWindowShort(row.window);
  const used = toInt(row.used) ?? 0;
  const limit = toInt(row.limit) ?? 0;
  const label = name || "\u989D\u5EA6";
  return `${label} ${used}/${limit}`;
}
function rowLabel(row) {
  return (row.name && row.name.length > 0 ? row.name : formatWindowShort(row.window)) || "\u989D\u5EA6";
}
function moonshotAdapter(providerId, baseUrl) {
  return {
    providerId,
    label: providerId === "moonshotai" ? "Kimi \u5F00\u653E\u5E73\u53F0" : "Kimi \u5F00\u653E\u5E73\u53F0(CN)",
    rateText: meteredRateText,
    async fetch(ctx) {
      const key = await ctx.modelRegistry.getApiKeyForProvider(providerId);
      if (!key) throw new Error(`\u672A\u914D\u7F6E API key\uFF08\u8BF7\u8BBE\u7F6E MOONSHOT_API_KEY \u73AF\u5883\u53D8\u91CF\uFF09`);
      const res = await fetch(`${baseUrl}/users/me/balance`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(1e4)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      }
      const data = await res.json();
      if (data.code !== 0 || !data.data) throw new Error("\u54CD\u5E94\u7F3A\u5C11 data");
      const toNum = (v) => {
        const n = typeof v === "number" ? v : parseFloat(v ?? "");
        return Number.isFinite(n) ? n : 0;
      };
      const available = toNum(data.data.available_balance);
      const cash = toNum(data.data.cash_balance);
      const vouchers = toNum(data.data.vouchers_balance);
      const status = available <= 1 ? "error" : available < 5 ? "warning" : "ok";
      return {
        status,
        // 与 DeepSeek 一致的精简格式：主金额 = 现金余额，赠金以 “+ X.XX” 追加
        amount: `CNY ${cash.toFixed(2)}`,
        detail: vouchers > 0 ? `+ ${vouchers.toFixed(2)}` : void 0
      };
    }
  };
}
var deepseekAdapter, KIMI_CODING_BASE_URL, KIMI_FIXED_POINT_CENTS, kimiCodingAdapter, moonshotaiAdapter, moonshotaiCnAdapter, xiaomiTokenPlanCnAdapter, openrouterAdapter, BALANCE_ADAPTERS;
var init_hud_balance = __esm({
  "extensions/hud/hud-balance.ts"() {
    init_hud_cost();
    deepseekAdapter = {
      providerId: "deepseek",
      label: "DeepSeek",
      rateText: meteredRateText,
      async fetch(ctx) {
        const key = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
        if (!key) throw new Error("\u672A\u914D\u7F6E API key");
        const res = await fetch("https://api.deepseek.com/user/balance", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(1e4)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const info = data.balance_infos?.[0];
        if (!info?.total_balance) throw new Error("\u54CD\u5E94\u7F3A\u5C11 balance_infos");
        const total = parseFloat(info.total_balance) || 0;
        const granted = parseFloat(info.granted_balance || "0") || 0;
        const topped = parseFloat(info.topped_up_balance || "0") || 0;
        const currency = info.currency || "CNY";
        const status = data.is_available === false ? "warning" : total <= 1 ? "error" : total < 5 ? "warning" : "ok";
        return {
          status,
          // 精简格式：主金额 = 充值余额，赠送以 “+ X.XX” 追加（无赠送则省略）
          amount: `${currency} ${topped.toFixed(2)}`,
          detail: granted > 0 ? `+ ${granted.toFixed(2)}` : void 0
        };
      }
    };
    KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
    KIMI_FIXED_POINT_CENTS = 1e6;
    kimiCodingAdapter = {
      providerId: "kimi-coding",
      label: "Kimi For Coding",
      // 订阅制：不显示 ¥/min，展示会话 token 消耗
      rateText(ctx, _now) {
        const t = sumSessionUsage(ctx);
        if (t.turns === 0) return null;
        return [{ text: `${fmtNum(t.input + t.output + t.cacheRead)} tokens`, color: "dim" }];
      },
      async fetch(ctx) {
        const auth = await ctx.modelRegistry.getProviderAuth("kimi-coding");
        const key = auth?.auth.apiKey ?? auth?.auth.headers?.Authorization?.replace(/^Bearer\s+/i, "");
        if (!key) throw new Error("\u672A\u914D\u7F6E API key \u6216 OAuth\uFF08\u8BF7\u8BBE\u7F6E KIMI_API_KEY \u73AF\u5883\u53D8\u91CF\u6216\u6267\u884C /login kimi-coding\uFF09");
        const res = await fetch(`${KIMI_CODING_BASE_URL}/usages`, {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json"
          },
          signal: AbortSignal.timeout(1e4)
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
        }
        const data = await res.json();
        let summary = null;
        if (data.usage) {
          summary = {
            ...data.usage,
            window: data.usage.window ?? { duration: 1, timeUnit: "TIME_UNIT_WEEK" }
          };
        }
        const limits = [];
        for (const item of data.limits ?? []) {
          if (item.detail) {
            limits.push({
              ...item.detail,
              name: item.detail.name ?? item.name,
              window: item.detail.window ?? item.window
            });
          }
        }
        let boosterCents = null;
        let boosterTotalCents = null;
        let boosterCurrency = "CNY";
        const booster = data.boosterWallet;
        if (booster?.balance?.type === "BOOSTER") {
          const amount2 = toInt(booster.balance.amount);
          const amountLeft = toInt(booster.balance.amountLeft);
          if (amount2 !== null && amount2 > 0) {
            boosterTotalCents = fixedPointToCents(amount2);
            boosterCents = amountLeft !== null ? fixedPointToCents(amountLeft) : 0;
          }
          boosterCurrency = booster.monthlyChargeLimit?.currency || booster.monthlyUsed?.currency || "CNY";
        }
        let status = "ok";
        const summaryLimit = summary?.limit ?? 0;
        const summaryUsed = summary?.used ?? 0;
        if (summaryLimit > 0) {
          const ratio = summaryUsed / summaryLimit;
          if (ratio >= 1) status = "error";
          else if (ratio >= 0.8) status = "warning";
        }
        if (boosterCents !== null && boosterTotalCents !== null && boosterTotalCents > 0) {
          if (boosterCents < 100) status = "error";
          else if (boosterCents / boosterTotalCents < 0.2) status = "warning";
        }
        const amount = boosterCents !== null ? formatMoney(boosterCents, boosterCurrency) : summary ? formatUsageRow(summary) : "-";
        const detailParts = [];
        if (boosterCents !== null && summary) {
          detailParts.push(`\u8BA2\u9605 ${formatUsageRow(summary)}`);
        }
        for (const limit of limits) {
          detailParts.push(formatUsageRow(limit));
        }
        const quotas = [];
        if (summary) {
          quotas.push({ label: rowLabel(summary), used: toInt(summary.used) ?? 0, limit: toInt(summary.limit) ?? 0 });
        }
        for (const limit of limits) {
          quotas.push({ label: rowLabel(limit), used: toInt(limit.used) ?? 0, limit: toInt(limit.limit) ?? 0 });
        }
        return {
          status,
          amount,
          detail: detailParts.join(" \xB7 ") || void 0,
          quotas
        };
      }
    };
    moonshotaiAdapter = moonshotAdapter("moonshotai", "https://api.moonshot.ai/v1");
    moonshotaiCnAdapter = moonshotAdapter("moonshotai-cn", "https://api.moonshot.cn/v1");
    xiaomiTokenPlanCnAdapter = {
      providerId: "xiaomi-token-plan-cn",
      label: "MiMo Token Plan",
      // 订阅制且无等效单价：展示会话 token 消耗
      rateText(ctx, _now) {
        const t = sumSessionUsage(ctx);
        if (t.turns === 0) return null;
        return [{ text: `${fmtNum(t.input + t.output + t.cacheRead)} tokens`, color: "dim" }];
      },
      async fetch(_ctx) {
        return {
          status: "ok",
          amount: "\u4F59\u91CF\u67E5\u8BE2",
          detail: "https://platform.xiaomimimo.com/console/plan-manage",
          hideLabel: true
        };
      }
    };
    openrouterAdapter = {
      providerId: "openrouter",
      label: "OpenRouter",
      // 按量付费：¥/min + 累计（统一 RMB 计价）
      rateText: meteredRateText,
      async fetch(ctx) {
        const key = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
        if (!key) throw new Error("\u672A\u914D\u7F6E API key");
        const headers = { Authorization: `Bearer ${key}` };
        const signal = AbortSignal.timeout(1e4);
        const res = await fetch("https://openrouter.ai/api/v1/credits", { headers, signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const d = data.data;
        if (typeof d?.total_credits !== "number" && typeof d?.total_usage !== "number") {
          throw new Error("\u54CD\u5E94\u7F3A\u5C11 total_credits/total_usage");
        }
        const total = d.total_credits || 0;
        const used = d.total_usage || 0;
        const remainingUsd = Math.max(total - used, 0);
        const status = remainingUsd <= 1 ? "error" : remainingUsd < 5 ? "warning" : "ok";
        const keyQuota = (() => {
          try {
            return (async () => {
              const keyRes = await fetch("https://openrouter.ai/api/v1/key", { headers, signal });
              if (!keyRes.ok) return null;
              const kd = await keyRes.json();
              const k = kd.data;
              const limit = typeof k?.limit === "number" ? k.limit : 0;
              if (limit <= 0) return null;
              const kused = (typeof k?.usage_monthly === "number" ? k.usage_monthly : 0) || (typeof k?.usage === "number" ? k.usage : 0) || 0;
              return { used: kused, limit };
            })();
          } catch {
            return null;
          }
        })();
        const kq = await keyQuota;
        const rate = getUsdCnyRate();
        const rateSource2 = getRateSource();
        if (rate !== null) {
          const remainingCny = remainingUsd * rate;
          const quotas = kq ? [{ label: "Key", used: kq.used * rate, limit: kq.limit * rate, currency: "CNY" }] : [];
          return {
            status,
            // 主金额 = 账户总余额（RMB）；已用明细按需求隐藏
            amount: `CNY ${remainingCny.toFixed(2)}`,
            // 明细：原始 USD 金额 + 所用汇率（实时/磁盘缓存标注），货币缩写统一转符号
            detail: `${currencySymbol("USD")}${remainingUsd.toFixed(2)} \xB7 \u6C47\u7387 ${rate.toFixed(4)}${rateSource2 === "live" ? "" : "(\u7F13\u5B58)"}`,
            quotas: quotas.length > 0 ? quotas : void 0,
            showAmountWithQuotas: true
          };
        }
        const quotasUsd = kq ? [{ label: "Key", used: kq.used, limit: kq.limit, currency: "USD" }] : [];
        return {
          status,
          amount: `USD ${remainingUsd.toFixed(2)}`,
          detail: "\u6C47\u7387\u4E0D\u53EF\u7528\uFF08\u79BB\u7EBF\uFF09\uFF0C\u663E\u793A\u539F\u59CB\u8D27\u5E01",
          quotas: quotasUsd.length > 0 ? quotasUsd : void 0,
          showAmountWithQuotas: true
        };
      }
    };
    BALANCE_ADAPTERS = {
      [deepseekAdapter.providerId]: deepseekAdapter,
      [kimiCodingAdapter.providerId]: kimiCodingAdapter,
      [moonshotaiAdapter.providerId]: moonshotaiAdapter,
      [moonshotaiCnAdapter.providerId]: moonshotaiCnAdapter,
      [xiaomiTokenPlanCnAdapter.providerId]: xiaomiTokenPlanCnAdapter,
      [openrouterAdapter.providerId]: openrouterAdapter
    };
  }
});

// extensions/hud/hud-git.ts
var hud_git_exports = {};
__export(hud_git_exports, {
  generateCommitMessage: () => generateCommitMessage,
  getDetailedGitStatus: () => getDetailedGitStatus,
  gitAdd: () => gitAdd,
  gitBranchList: () => gitBranchList,
  gitCheckout: () => gitCheckout,
  gitCommit: () => gitCommit,
  gitDiscard: () => gitDiscard,
  gitFetch: () => gitFetch,
  gitPull: () => gitPull,
  gitPush: () => gitPush,
  gitRemoveUntracked: () => gitRemoveUntracked,
  gitReset: () => gitReset,
  isGitRepo: () => isGitRepo,
  openGitPanel: () => openGitPanel,
  parseDetailedGitStatus: () => parseDetailedGitStatus,
  parseGitStatus: () => parseGitStatus,
  parseNumStats: () => parseNumStats
});
import { matchesKey, Key, truncateToWidth, visibleWidth, parseKey } from "@earendil-works/pi-tui";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { execFile } from "child_process";
import { promisify } from "util";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
async function git(cwd, args, timeout = GIT_TIMEOUT_MS) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    timeout,
    windowsHide: true
  });
  return { stdout, stderr };
}
async function isGitRepo(cwd) {
  try {
    await git(cwd, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}
function parseGitStatus(stdout) {
  const lines = stdout.split(/\r?\n/);
  const first = lines[0] ?? "";
  let branch = null;
  const branchM = first.match(/^## (.+?)(?:\.\.\.|$)/);
  if (branchM) {
    const raw = branchM[1];
    const noCommit = raw.match(/^(?:No commits yet|Initial commit) on (.+)$/);
    branch = noCommit ? noCommit[1] : raw === "HEAD (no branch)" ? "HEAD" : raw;
  }
  let staged = 0, unstaged = 0, untracked = 0;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }
    if (x !== " " && x !== "?") staged++;
    if (y !== " " && y !== "?") unstaged++;
  }
  const ahead = first.match(/ahead (\d+)/);
  const behind = first.match(/behind (\d+)/);
  return {
    branch,
    staged,
    unstaged,
    untracked,
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0
  };
}
function parseDetailedGitStatus(stdout) {
  const stats = parseGitStatus(stdout);
  const items = [];
  const lines = stdout.split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    const x = xy[0];
    const y = xy[1];
    let path2 = rest;
    let renamedFrom;
    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx !== -1) {
      renamedFrom = rest.slice(0, arrowIdx);
      path2 = rest.slice(arrowIdx + 4);
    }
    let category;
    if (x === "?" && y === "?") {
      category = "untracked";
    } else if (x !== " " && x !== "?") {
      category = "staged";
    } else if (y !== " " && y !== "?") {
      category = "unstaged";
    } else {
      continue;
    }
    items.push({ path: path2, xy, x, y, renamedFrom, category });
  }
  return {
    ...stats,
    items,
    clean: stats.staged === 0 && stats.unstaged === 0 && stats.untracked === 0
  };
}
function parseNumStats(stdout) {
  const result = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("	");
    if (parts.length !== 3) continue;
    const [added, removed, path2] = parts;
    if (!path2) continue;
    const binary = added === "-" && removed === "-";
    const arrowIdx = path2.indexOf(" => ");
    const realPath = arrowIdx !== -1 ? path2.slice(arrowIdx + 4) : path2;
    result[realPath] = {
      added: binary ? 0 : Number(added) || 0,
      removed: binary ? 0 : Number(removed) || 0,
      binary
    };
  }
  return result;
}
async function getDetailedGitStatus(cwd, timeout = GIT_TIMEOUT_MS) {
  try {
    const [{ stdout: statusOut }, { stdout: cachedOut }, { stdout: normalOut }] = await Promise.all([
      git(cwd, ["status", "--porcelain=v1", "--branch"], timeout),
      git(cwd, ["diff", "--cached", "--numstat"], timeout).catch(() => ({ stdout: "", stderr: "" })),
      git(cwd, ["diff", "--numstat"], timeout).catch(() => ({ stdout: "", stderr: "" }))
    ]);
    const status = parseDetailedGitStatus(statusOut);
    const numStats = {};
    for (const [path2, stat] of Object.entries(parseNumStats(cachedOut))) numStats[path2] = stat;
    for (const [path2, stat] of Object.entries(parseNumStats(normalOut))) numStats[path2] = stat;
    return { ...status, numStats };
  } catch {
    return null;
  }
}
async function gitAdd(cwd, paths) {
  if (paths.length === 0) return;
  await git(cwd, ["add", "--", ...paths]);
}
async function gitReset(cwd, paths) {
  if (paths.length === 0) return;
  await git(cwd, ["reset", "HEAD", "--", ...paths]);
}
async function gitDiscard(cwd, paths) {
  if (paths.length === 0) return;
  await git(cwd, ["checkout", "HEAD", "--", ...paths]);
}
async function gitRemoveUntracked(cwd, paths) {
  for (const p of paths) {
    await unlink(resolve(cwd, p));
  }
}
async function gitCommit(cwd, message) {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("\u63D0\u4EA4\u4FE1\u606F\u4E0D\u80FD\u4E3A\u7A7A");
  await git(cwd, ["commit", "-m", trimmed]);
}
async function gitPush(cwd, args = []) {
  await git(cwd, ["push", ...args], LONG_GIT_TIMEOUT_MS);
}
async function gitPull(cwd, args = []) {
  await git(cwd, ["pull", ...args], LONG_GIT_TIMEOUT_MS);
}
async function gitFetch(cwd) {
  await git(cwd, ["fetch"], LONG_GIT_TIMEOUT_MS);
}
async function gitBranchList(cwd) {
  const { stdout } = await git(cwd, ["branch", "--format=%(refname:short)"]);
  return stdout.split(/\r?\n/).map((b) => b.trim()).filter(Boolean);
}
async function gitCheckout(cwd, branch, create = false) {
  const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
  await git(cwd, args);
}
function pickCommitModel(ctx) {
  const reg = ctx.modelRegistry;
  for (const [provider, modelId] of COMMIT_AI_MODELS) {
    const m = reg.find(provider, modelId);
    if (m && reg.hasConfiguredAuth(m)) return m;
  }
  let best;
  let bestCost = Infinity;
  for (const m of reg.getAvailable()) {
    if (!reg.hasConfiguredAuth(m)) continue;
    const c = (m.cost?.input ?? Infinity) + (m.cost?.output ?? Infinity);
    if (c < bestCost) {
      best = m;
      bestCost = c;
    }
  }
  return best;
}
async function generateCommitMessage(ctx, cwd) {
  const { stdout: diff } = await git(cwd, ["diff", "--cached"], LONG_GIT_TIMEOUT_MS);
  if (!diff.trim()) throw new Error("\u6682\u5B58\u533A\u6CA1\u6709\u6539\u52A8");
  const truncated = diff.length > COMMIT_DIFF_MAX_CHARS ? diff.slice(0, COMMIT_DIFF_MAX_CHARS) + "\n\u2026(diff \u8FC7\u957F\u5DF2\u622A\u65AD)" : diff;
  const model = pickCommitModel(ctx);
  if (!model) throw new Error("\u627E\u4E0D\u5230\u5DF2\u8BA4\u8BC1\u7684\u53EF\u7528\u6A21\u578B");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`\u8BA4\u8BC1\u5931\u8D25\uFF1A${auth.error}`);
  const systemPrompt = [
    "\u4F60\u662F git \u63D0\u4EA4\u4FE1\u606F\u52A9\u624B\uFF0C\u6839\u636E\u7528\u6237\u63D0\u4F9B\u7684\u6682\u5B58\u533A diff \u751F\u6210\u4E00\u6761\u7B80\u6D01\u7684\u63D0\u4EA4\u4FE1\u606F\u3002",
    "\u8981\u6C42\uFF1A",
    "1. \u9996\u884C\u4E3A\u6807\u9898\uFF0C\u4E0D\u8D85\u8FC7 72 \u5B57\u7B26\uFF0C\u9075\u5FAA conventional commits \u683C\u5F0F\uFF1Afeat: / fix: / refactor: / chore: / docs: / test: / style: / perf: / build: / ci: / revert:",
    "2. \u5982\u9700\u8865\u5145\u7EC6\u8282\uFF0C\u6807\u9898\u4E0B\u7A7A\u4E00\u884C\uFF0C\u518D\u5217 2~3 \u6761\u8981\u70B9\uFF08\u6BCF\u884C\u4EE5 - \u5F00\u5934\uFF09",
    "3. \u6B63\u6587\u8BED\u8A00\u8DDF\u968F diff \u5185\u5BB9\uFF1Adiff \u542B\u4E2D\u6587\u5219\u7528\u4E2D\u6587\uFF0C\u5426\u5219\u7528\u82F1\u6587",
    "4. \u53EA\u8F93\u51FA\u63D0\u4EA4\u4FE1\u606F\u672C\u8EAB\uFF0C\u4E0D\u8981\u89E3\u91CA\u3001\u4E0D\u8981\u5F15\u53F7\u3001\u4E0D\u8981\u4EE3\u7801\u5757\u56F4\u680F"
  ].join("\n");
  const messages = [
    {
      role: "user",
      content: `\u4EE5\u4E0B\u662F\u6682\u5B58\u533A\u6539\u52A8\uFF08git diff --cached\uFF09\uFF1A

${truncated}`,
      timestamp: Date.now()
    }
  ];
  const result = await completeSimple(
    model,
    { systemPrompt, messages },
    {
      apiKey: auth.apiKey,
      headers: { ...auth.headers },
      maxTokens: 300,
      temperature: 0.3,
      signal: AbortSignal.timeout(COMMIT_AI_TIMEOUT_MS)
    }
  );
  const text = result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) throw new Error("AI \u672A\u8FD4\u56DE\u5185\u5BB9");
  return text.replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "").trim();
}
async function openGitPanel(ctx, onRefresh) {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("/git \u4EC5\u5728\u4EA4\u4E92\u6A21\u5F0F\u4E0B\u53EF\u7528", "warning");
    return;
  }
  const cwd = ctx.cwd;
  if (!await isGitRepo(cwd)) {
    ctx.ui.notify("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F git \u4ED3\u5E93", "warning");
    return;
  }
  await ctx.ui.custom(
    (tui, theme, _kb, done) => {
      const panel = new GitPanel(
        ctx,
        theme,
        cwd,
        () => done(),
        () => onRefresh?.(),
        () => tui.requestRender()
      );
      void panel.init();
      return {
        render: (width) => panel.render(width),
        handleInput: (data) => panel.handleInput(data),
        invalidate: () => {
        }
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        minWidth: PANEL_MIN_WIDTH,
        maxHeight: "80%",
        margin: 2
      }
    }
  );
}
var execFileAsync, GIT_TIMEOUT_MS, LONG_GIT_TIMEOUT_MS, PANEL_MIN_WIDTH, COMMIT_MAX_DISPLAY_LINES, COMMIT_AI_MODELS, COMMIT_DIFF_MAX_CHARS, COMMIT_AI_TIMEOUT_MS, GitPanel;
var init_hud_git = __esm({
  "extensions/hud/hud-git.ts"() {
    execFileAsync = promisify(execFile);
    GIT_TIMEOUT_MS = 8e3;
    LONG_GIT_TIMEOUT_MS = 3e4;
    PANEL_MIN_WIDTH = 60;
    COMMIT_MAX_DISPLAY_LINES = 6;
    COMMIT_AI_MODELS = [["deepseek", "deepseek-v4-flash"]];
    COMMIT_DIFF_MAX_CHARS = 4e3;
    COMMIT_AI_TIMEOUT_MS = 3e4;
    GitPanel = class {
      ctx;
      theme;
      cwd;
      onClose;
      onRefresh;
      requestRender;
      status = null;
      rows = [];
      selectedRow = 0;
      mode = "list";
      commitMsg = "";
      cursor = 0;
      // 手动输入模式的光标位置（0..commitMsg.length）
      busy = false;
      busyText = "\u6267\u884C\u4E2D\u2026";
      message = "";
      // 底部提示/错误信息
      cachedWidth;
      cachedLines;
      constructor(ctx, theme, cwd, onClose, onRefresh, requestRender) {
        this.ctx = ctx;
        this.theme = theme;
        this.cwd = cwd;
        this.onClose = onClose;
        this.onRefresh = onRefresh;
        this.requestRender = requestRender;
      }
      async init() {
        await this.refresh();
      }
      async refresh() {
        this.status = await getDetailedGitStatus(this.cwd);
        this.buildRows();
        if (this.selectedRow >= this.rows.length) this.selectedRow = Math.max(0, this.rows.length - 1);
        this.invalidate();
        this.onRefresh();
      }
      buildRows() {
        this.rows = [];
        if (!this.status || this.status.items.length === 0) return;
        const addCategory = (category, label) => {
          const items = this.status.items.filter((i) => i.category === category);
          if (items.length === 0) return;
          this.rows.push({ type: "header", category, label, count: items.length });
          for (const item of items) this.rows.push({ type: "file", item });
        };
        addCategory("staged", "\u5DF2\u6682\u5B58");
        addCategory("unstaged", "\u5DE5\u4F5C\u533A\u4FEE\u6539");
        addCategory("untracked", "\u672A\u8DDF\u8E2A");
      }
      getSelectedPaths() {
        const row = this.rows[this.selectedRow];
        if (!row) return { paths: [], category: null };
        if (row.type === "file") return { paths: [row.item.path], category: row.item.category };
        const category = row.category;
        const paths = this.status?.items.filter((i) => i.category === category).map((i) => i.path) ?? [];
        return { paths, category };
      }
      setBusy(value) {
        this.busy = value;
        this.invalidate();
        this.requestRender();
      }
      async runOp(name, op) {
        this.setBusy(true);
        this.message = "";
        try {
          await op();
          this.message = `${name} \u6210\u529F`;
          await this.refresh();
          return true;
        } catch (err) {
          this.message = `${name} \u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`;
          return false;
        } finally {
          this.setBusy(false);
        }
      }
      invalidate() {
        this.cachedWidth = void 0;
        this.cachedLines = void 0;
      }
      handleInput(data) {
        if (this.busy) return;
        if (this.mode === "commit") {
          this.handleCommitInput(data);
          return;
        }
        const key = parseKey(data) ?? data;
        if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p")) || key === "k" || key === "K") {
          this.moveSelection(-1);
        } else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n")) || key === "j" || key === "J") {
          this.moveSelection(1);
        } else if (key === "h" || key === "H") {
          this.moveToCategory(-1);
        } else if (key === "l" || key === "L") {
          this.moveToCategory(1);
        } else if (matchesKey(data, Key.home)) {
          this.selectedRow = 0;
          this.invalidate();
          this.requestRender();
        } else if (matchesKey(data, Key.end)) {
          this.selectedRow = Math.max(0, this.rows.length - 1);
          this.invalidate();
          this.requestRender();
        } else if (key === "a" || key === "A") {
          void this.stage();
        } else if (key === "u" || key === "U") {
          void this.unstage();
        } else if (key === "d" || key === "D") {
          void this.discard();
        } else if (key === "c" || key === "C") {
          void this.commit();
        } else if (key === "i" || key === "I") {
          this.startCommit();
        } else if (key === "g" || key === "G") {
          void this.aiGenerateCommit();
        } else if (key === "r" || key === "R") {
          void this.refresh();
        } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || key === "q" || key === "Q") {
          this.onClose();
        }
      }
      moveSelection(delta) {
        const next = Math.max(0, Math.min(this.rows.length - 1, this.selectedRow + delta));
        if (next !== this.selectedRow) {
          this.selectedRow = next;
          this.invalidate();
          this.requestRender();
        }
      }
      /** 跳到上一个/下一个分类标题（h/l）。 */
      moveToCategory(delta) {
        const current = this.selectedRow;
        let target = -1;
        if (delta > 0) {
          for (let i = current + 1; i < this.rows.length; i++) {
            if (this.rows[i].type === "header") {
              target = i;
              break;
            }
          }
        } else {
          for (let i = current - 1; i >= 0; i--) {
            if (this.rows[i].type === "header") {
              target = i;
              break;
            }
          }
        }
        if (target !== -1) {
          this.selectedRow = target;
          this.invalidate();
          this.requestRender();
        }
      }
      async stage() {
        const { paths, category } = this.getSelectedPaths();
        if (category === "staged" || paths.length === 0) return;
        await this.runOp("\u6682\u5B58", () => gitAdd(this.cwd, paths));
      }
      async unstage() {
        const { paths, category } = this.getSelectedPaths();
        if (category !== "staged" || paths.length === 0) return;
        await this.runOp("\u53D6\u6D88\u6682\u5B58", () => gitReset(this.cwd, paths));
      }
      async discard() {
        const { paths, category } = this.getSelectedPaths();
        if (paths.length === 0) return;
        if (category === "untracked") {
          const ok2 = await this.ctx.ui.confirm(
            "\u5220\u9664\u672A\u8DDF\u8E2A\u6587\u4EF6",
            `\u5C06\u6C38\u4E45\u5220\u9664 ${paths.length} \u4E2A\u672A\u8DDF\u8E2A\u6587\u4EF6\uFF0C\u786E\u5B9A\u5417\uFF1F`
          );
          if (!ok2) return;
          await this.runOp("\u5220\u9664", () => gitRemoveUntracked(this.cwd, paths));
          return;
        }
        const ok = await this.ctx.ui.confirm(
          "\u4E22\u5F03\u6539\u52A8",
          `\u5C06\u4E22\u5F03 ${paths.length} \u4E2A\u6587\u4EF6\u7684\u6539\u52A8\uFF0C\u786E\u5B9A\u5417\uFF1F`
        );
        if (!ok) return;
        await this.runOp("\u4E22\u5F03", () => gitDiscard(this.cwd, paths));
      }
      /** 提交当前待提交信息（c 键直接提交；失败或无信息时给提示）。 */
      async commit() {
        const msg = this.commitMsg.trim();
        if (!msg) {
          this.message = "\u63D0\u4EA4\u4FE1\u606F\u4E3A\u7A7A\uFF1A\u6309 g \u8BA9 AI \u751F\u6210\uFF0C\u6216\u6309 i \u624B\u52A8\u8F93\u5165";
          this.invalidate();
          this.requestRender();
          return;
        }
        await this.doCommit(msg);
      }
      async doCommit(msg) {
        const staged = this.status?.items.filter((i) => i.category === "staged") ?? [];
        if (staged.length === 0) {
          this.message = "\u6CA1\u6709\u5DF2\u6682\u5B58\u7684\u6587\u4EF6\uFF0C\u65E0\u6CD5\u63D0\u4EA4";
          this.invalidate();
          this.requestRender();
          return;
        }
        const ok = await this.runOp("\u63D0\u4EA4", () => gitCommit(this.cwd, msg));
        if (ok) this.commitMsg = "";
      }
      startCommit() {
        const staged = this.status?.items.filter((i) => i.category === "staged") ?? [];
        if (staged.length === 0) {
          this.message = "\u6CA1\u6709\u5DF2\u6682\u5B58\u7684\u6587\u4EF6\uFF0C\u65E0\u6CD5\u63D0\u4EA4";
          this.invalidate();
          this.requestRender();
          return;
        }
        this.mode = "commit";
        this.cursor = this.commitMsg.length;
        this.invalidate();
        this.requestRender();
      }
      handleCommitInput(data) {
        const key = parseKey(data) ?? data;
        if (matchesKey(data, Key.escape)) {
          this.mode = "list";
          this.invalidate();
          this.requestRender();
          return;
        }
        if (key === "g" || key === "G") {
          void this.aiGenerateCommit();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const msg = this.commitMsg.trim();
          if (!msg) {
            this.message = "\u63D0\u4EA4\u4FE1\u606F\u4E0D\u80FD\u4E3A\u7A7A";
            this.invalidate();
            this.requestRender();
            return;
          }
          this.mode = "list";
          void this.doCommit(msg);
          return;
        }
        if (matchesKey(data, Key.left)) {
          this.cursor = Math.max(0, this.cursor - 1);
        } else if (matchesKey(data, Key.right)) {
          this.cursor = Math.min(this.commitMsg.length, this.cursor + 1);
        } else if (matchesKey(data, Key.home)) {
          this.cursor = 0;
        } else if (matchesKey(data, Key.end)) {
          this.cursor = this.commitMsg.length;
        } else if (matchesKey(data, Key.backspace)) {
          if (this.cursor > 0) {
            this.commitMsg = this.commitMsg.slice(0, this.cursor - 1) + this.commitMsg.slice(this.cursor);
            this.cursor--;
          }
        } else if (matchesKey(data, Key.delete)) {
          if (this.cursor < this.commitMsg.length) {
            this.commitMsg = this.commitMsg.slice(0, this.cursor) + this.commitMsg.slice(this.cursor + 1);
          }
        } else if (matchesKey(data, Key.ctrl("u"))) {
          this.commitMsg = "";
          this.cursor = 0;
        } else if (key.length === 1 && key.charCodeAt(0) >= 32) {
          this.commitMsg = this.commitMsg.slice(0, this.cursor) + key + this.commitMsg.slice(this.cursor);
          this.cursor++;
        }
        this.invalidate();
        this.requestRender();
      }
      async aiGenerateCommit() {
        this.busyText = "AI \u751F\u6210\u63D0\u4EA4\u4FE1\u606F\u4E2D\u2026";
        this.setBusy(true);
        this.message = "";
        try {
          const msg = await generateCommitMessage(this.ctx, this.cwd);
          this.commitMsg = msg;
          this.cursor = msg.length;
          this.message = "AI \u5DF2\u751F\u6210\uFF0C\u6309 c \u63D0\u4EA4\uFF0C\u6216\u6309 i \u624B\u52A8\u7F16\u8F91";
        } catch (err) {
          this.message = `AI \u751F\u6210\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`;
        }
        this.busyText = "\u6267\u884C\u4E2D\u2026";
        this.setBusy(false);
      }
      render(width) {
        if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
        const th = this.theme;
        const innerW = Math.max(20, width - 2);
        const lines = [];
        const branch = this.status?.branch ?? "-";
        const ahead = this.status?.ahead ?? 0;
        const behind = this.status?.behind ?? 0;
        const branchInfo = `\u2387 ${branch}${ahead ? ` \u2191${ahead}` : ""}${behind ? ` \u2193${behind}` : ""}`;
        const title = th.fg("accent", th.bold(" Git \u9762\u677F ")) + th.fg("dim", `  ${branchInfo}`);
        lines.push(th.fg("border", "\u250C") + title + th.fg("border", "\u2500".repeat(Math.max(0, width - visibleWidth(title) - 2)) + "\u2510"));
        if (!this.status) {
          lines.push(this.padLine(th.fg("warning", "  \u975E git \u4ED3\u5E93\u6216 git \u4E0D\u53EF\u7528"), width));
        } else if (this.status.clean) {
          lines.push(this.padLine(th.fg("success", "  \u5DE5\u4F5C\u533A\u5E72\u51C0 \u2713"), width));
        } else {
          for (let i = 0; i < this.rows.length; i++) {
            lines.push(this.renderRow(this.rows[i], i === this.selectedRow, innerW, width));
          }
        }
        lines.push(th.fg("border", "\u251C") + th.fg("border", "\u2500".repeat(width - 2)) + th.fg("border", "\u2524"));
        if (this.mode === "commit") {
          const full = this.commitMsg.slice(0, this.cursor) + "_" + this.commitMsg.slice(this.cursor);
          const msgLines = full.split("\n");
          const showLines = msgLines.slice(0, COMMIT_MAX_DISPLAY_LINES);
          lines.push(this.padLine(th.fg("dim", "  \u63D0\u4EA4\u4FE1\u606F:"), width));
          showLines.forEach((l) => lines.push(this.padLine(th.fg("text", `  ${l}`), width)));
          if (msgLines.length > COMMIT_MAX_DISPLAY_LINES) {
            lines.push(this.padLine(th.fg("dim", `  \u2026(\u5171 ${msgLines.length} \u884C\uFF0C\u4EC5\u663E\u793A\u524D ${COMMIT_MAX_DISPLAY_LINES} \u884C)`), width));
          }
          lines.push(this.padLine(th.fg("dim", "  \u2190\u2192 \u79FB\u52A8\u5149\u6807 | [g] AI \u751F\u6210 | [Enter] \u63D0\u4EA4 | [Esc] \u9000\u51FA"), width));
        } else {
          if (this.commitMsg.trim()) {
            const firstLine = this.commitMsg.split("\n")[0];
            lines.push(this.padLine(th.fg("accent", `  \u5F85\u63D0\u4EA4: ${truncateToWidth(firstLine, Math.max(8, innerW - 8), "\u2026")}`), width));
          }
          for (const hint of this.buildHints()) {
            lines.push(this.padLine(th.fg("dim", hint), width));
          }
        }
        if (this.message) {
          const color = this.message.includes("\u5931\u8D25") ? "error" : this.message.includes("\u6210\u529F") ? "success" : "warning";
          lines.push(this.padLine(th.fg(color, `  ${this.message}`), width));
        } else {
          lines.push(this.padLine("", width));
        }
        if (this.busy) {
          lines.push(this.padLine(th.fg("accent", `  ${this.busyText}`), width));
        }
        lines.push(th.fg("border", "\u2514") + th.fg("border", "\u2500".repeat(width - 2)) + th.fg("border", "\u2518"));
        const result = lines.map((l) => truncateToWidth(l, width));
        this.cachedWidth = width;
        this.cachedLines = result;
        return result;
      }
      renderRow(row, selected, innerW, width) {
        const th = this.theme;
        let content = "";
        if (row.type === "header") {
          const color = row.category === "staged" ? "success" : row.category === "unstaged" ? "warning" : "muted";
          const icon = row.category === "staged" ? "+" : row.category === "unstaged" ? "~" : "?";
          const headerText = `${icon} ${row.label} (${row.count})`;
          content = selected ? th.inverse(th.fg(color, headerText)) : th.fg(color, headerText);
        } else {
          const item = row.item;
          const code = th.fg(this.statusColor(item), item.xy.padEnd(2));
          let pathText = item.path;
          if (item.renamedFrom) pathText = `${item.renamedFrom} \u2192 ${item.path}`;
          const prefix = `    ${code} `;
          const prefixWidth = visibleWidth(prefix);
          const stat = this.formatStat(item);
          const statWidth = stat ? visibleWidth(stat.text) + 1 : 0;
          const maxPathWidth = Math.max(4, innerW - prefixWidth - statWidth);
          const displayPath = truncateToWidth(pathText, maxPathWidth, "\u2026");
          const line = `${prefix}${displayPath}`;
          const padding = " ".repeat(Math.max(0, innerW - visibleWidth(line) - (stat ? visibleWidth(stat.text) : 0)));
          const statText = stat ? th.fg(stat.color, stat.text) : "";
          content = selected ? th.inverse(th.fg("text", line)) + padding + statText : th.fg("text", line) + padding + statText;
        }
        return this.padLine(content, width);
      }
      statusColor(item) {
        if (item.category === "staged") return "success";
        if (item.category === "unstaged") return item.y === "D" ? "error" : "warning";
        return "muted";
      }
      formatStat(item) {
        const stat = this.status?.numStats[item.path];
        if (!stat) {
          if (item.category === "untracked") return { text: "\u65B0\u6587\u4EF6", color: "muted" };
          return null;
        }
        if (stat.binary) return { text: "binary", color: "warning" };
        return { text: `+${stat.added}/-${stat.removed}`, color: "dim" };
      }
      padLine(content, width) {
        const th = this.theme;
        const pad = " ".repeat(Math.max(0, width - 2 - visibleWidth(content)));
        return th.fg("border", "\u2502") + content + pad + th.fg("border", "\u2502");
      }
      buildHints() {
        const { category } = this.getSelectedPaths();
        const hints = [];
        hints.push(`  \u5BFC\u822A [j/k]\u4E0A\u4E0B [h/l]\u8DF3\u5206\u7C7B [Home/End]\u9996\u5C3E`);
        if (category === "staged") hints.push(`  \u6587\u4EF6 [u]\u53D6\u6D88\u6682\u5B58 [d]\u4E22\u5F03`);
        else if (category === "unstaged") hints.push(`  \u6587\u4EF6 [a]\u6682\u5B58 [d]\u4E22\u5F03`);
        else if (category === "untracked") hints.push(`  \u6587\u4EF6 [a]\u6682\u5B58 [d]\u5220\u9664`);
        else hints.push(`  \u6587\u4EF6 [a]\u6682\u5B58 [u]\u53D6\u6D88\u6682\u5B58 [d]\u4E22\u5F03`);
        hints.push(`  \u63D0\u4EA4 [c]\u63D0\u4EA4 [g]AI\u751F\u6210 [i]\u624B\u52A8\u8F93\u5165 \xB7  [r]\u5237\u65B0 [q]\u9000\u51FA`);
        return hints;
      }
    };
  }
});

// extensions/hud/hud-core.ts
import { truncateToWidth as truncateToWidth2, visibleWidth as visibleWidth2 } from "@earendil-works/pi-tui";
import { execFile as execFile2 } from "child_process";
import { promisify as promisify2 } from "util";
var execFileAsync2 = promisify2(execFile2);
var REFRESH_INTERVAL_MS = 5 * 60 * 1e3;
var TURN_REFRESH_THROTTLE_MS = 60 * 1e3;
var RATE_REFRESH_INTERVAL_MS = 60 * 60 * 1e3;
var lastRateRefresh = 0;
var GIT_REFRESH_INTERVAL_MS = 5e3;
var RIGHT_SEG1 = 22;
var RIGHT_SEG2 = 16;
var RIGHT_TOTAL = 41;
var THINKING_LABEL = {
  off: "off",
  minimal: "min",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};
async function hud_core_default(pi) {
  globalThis.__PI_HUD_ACTIVE__ = true;
  let balanceMod = null;
  let costMod = null;
  let gitMod = null;
  try {
    balanceMod = await Promise.resolve().then(() => (init_hud_balance(), hud_balance_exports));
  } catch {
    console.warn("[hud] \u5B50\u6A21\u5757 hud-balance.ts \u7F3A\u5931\uFF1A\u4F59\u989D\u884C\u5C06\u964D\u7EA7\u663E\u793A");
  }
  try {
    costMod = await Promise.resolve().then(() => (init_hud_cost(), hud_cost_exports));
  } catch {
    console.warn("[hud] \u5B50\u6A21\u5757 hud-cost.ts \u7F3A\u5931\uFF1A\u6D88\u8017\u7EDF\u8BA1\u5C06\u9690\u85CF");
  }
  try {
    gitMod = await Promise.resolve().then(() => (init_hud_git(), hud_git_exports));
  } catch {
    console.warn("[hud] \u5B50\u6A21\u5757 hud-git.ts \u7F3A\u5931\uFF1Agit \u72B6\u6001\u5C06\u9690\u85CF");
  }
  function formatAmount(amount) {
    const m = amount.match(/^([A-Z]{3})\s+(.+)$/);
    if (!m) return amount;
    const sym = costMod?.currencySymbol(m[1]);
    return sym ? `${sym}${m[2]}` : amount;
  }
  let footerInstalled = false;
  let tuiRef;
  let refreshTimer;
  let gitTimer;
  let gitStats = null;
  let gitInflight = false;
  const STATUS_STYLE = {
    "hud-bash": { color: "warning", priority: 100 },
    // 指令模式提示（输入以 ! 开头）
    "balance-error": { color: "error", priority: 95 },
    // 余额查询失败
    "task-alert": { color: "success", priority: 90 },
    // 任务完成（task-alert 自管闪烁帧）
    "explore": { color: "accent", priority: 85 },
    // explore 子代理进度
    "init": { color: "warning", priority: 80 },
    // claude-it /init 进度
    "web-search": { color: "accent", priority: 75 },
    // 联网搜索状态
    "token-saver": { color: "muted", priority: 70 },
    // 节省量反馈
    "model-switch": { color: "accent", priority: 70 }
    // 模型切换
  };
  const statusClearTimers = /* @__PURE__ */ new Map();
  function pushStatus(ctx, key, text, ttlMs) {
    ctx.ui.setStatus(key, text);
    const old = statusClearTimers.get(key);
    if (old) clearTimeout(old);
    statusClearTimers.set(
      key,
      setTimeout(() => ctx.ui.setStatus(key, void 0), ttlMs)
    );
  }
  let lastBalanceError = "";
  let balance = { loading: false };
  let inflight = false;
  let lastAutoRefresh = 0;
  const fmtTime = (ts) => new Date(ts).toTimeString().slice(0, 8);
  const fmtDuration = (ms) => {
    const m = Math.floor(ms / 6e4);
    if (m < 1) return "<1min";
    if (m < 60) return `${m}min`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
    return `${Math.floor(h / 24)}d`;
  };
  async function refreshBalance(ctx) {
    const provider = ctx.model?.provider;
    if (inflight) return;
    if (!balanceMod) {
      balance = { loading: false, moduleMissing: true };
      lastAutoRefresh = Date.now();
      tuiRef?.requestRender();
      return;
    }
    if (costMod && Date.now() - lastRateRefresh > RATE_REFRESH_INTERVAL_MS) {
      lastRateRefresh = Date.now();
      await costMod.refreshExchangeRate();
    }
    if (!provider) {
      balance = { loading: false, unsupported: true, providerId: void 0 };
      lastAutoRefresh = Date.now();
      tuiRef?.requestRender();
      return;
    }
    const adapter = balanceMod.BALANCE_ADAPTERS[provider];
    if (!adapter) {
      balance = { loading: false, providerId: provider, unsupported: true };
      lastAutoRefresh = Date.now();
      tuiRef?.requestRender();
      return;
    }
    inflight = true;
    balance = { loading: true, providerId: provider };
    tuiRef?.requestRender();
    try {
      const data = await adapter.fetch(ctx);
      balance = { loading: false, providerId: provider, data, fetchedAt: Date.now() };
      lastBalanceError = "";
    } catch (err) {
      balance = {
        loading: false,
        providerId: provider,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt: Date.now()
      };
      const msg = err instanceof Error ? err.message : String(err);
      if (lastBalanceError !== msg) {
        lastBalanceError = msg;
        pushStatus(ctx, "balance-error", "\u26A0 \u4F59\u989D\u67E5\u8BE2\u5931\u8D25", 15e3);
      }
    } finally {
      inflight = false;
      lastAutoRefresh = Date.now();
      tuiRef?.requestRender();
    }
  }
  async function refreshGitStats(ctx) {
    if (!gitMod) return;
    if (gitInflight) return;
    gitInflight = true;
    try {
      const { stdout } = await execFileAsync2("git", ["status", "--porcelain=v1", "--branch"], {
        cwd: ctx.cwd,
        timeout: 5e3,
        windowsHide: true
      });
      gitStats = gitMod.parseGitStatus(stdout);
    } catch {
      gitStats = null;
    } finally {
      gitInflight = false;
      tuiRef?.requestRender();
    }
  }
  function describeBalance() {
    const b = balance;
    if (b.loading) return "\u4F59\u989D\uFF1A\u67E5\u8BE2\u4E2D\u2026";
    if (b.moduleMissing) return "\u4F59\u989D\uFF1Ahud-balance \u5B50\u6A21\u5757\u7F3A\u5931\uFF08\u672A\u5B89\u88C5\u5B8C\u6574 hud/\uFF09";
    if (b.unsupported) return `\u4F59\u989D\uFF1A${b.providerId ?? "?"} \u672A\u9002\u914D\uFF08\u5DF2\u9002\u914D: ${Object.keys(balanceMod?.BALANCE_ADAPTERS ?? {}).join(", ")}\uFF09`;
    if (b.error) return `\u4F59\u989D\uFF1A\u83B7\u53D6\u5931\u8D25\uFF08${b.error}\uFF09`;
    if (b.data) {
      const amount = formatAmount(b.data.amount);
      const prefix = b.data.hideLabel ? "" : "\u4F59\u989D\uFF1A";
      return `${prefix}${amount}${b.data.detail ? `\uFF08${b.data.detail}\uFF09` : ""}`;
    }
    return "\u4F59\u989D\uFF1A-";
  }
  function installFooter(ctx) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      tuiRef = tui;
      footerInstalled = true;
      const unsubBranch = footerData.onBranchChange(() => {
        void refreshGitStats(ctx);
        tui.requestRender();
      });
      let inputBuffer = "";
      let bashModeHint = false;
      const unsubInput = ctx.ui.onTerminalInput((data) => {
        if (data === "\r" || data === "\n") {
          inputBuffer = "";
        } else if (data === "\x7F" || data === "\b") {
          inputBuffer = inputBuffer.slice(0, -1);
        } else if (data.length === 1) {
          inputBuffer += data;
        }
        const isBash = inputBuffer.trimStart().startsWith("!");
        if (isBash !== bashModeHint) {
          bashModeHint = isBash;
          if (isBash) ctx.ui.setStatus("hud-bash", "\u26A1 \u6307\u4EE4\u6A21\u5F0F");
          else ctx.ui.setStatus("hud-bash", void 0);
        }
      });
      void refreshBalance(ctx);
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => void refreshBalance(ctx), REFRESH_INTERVAL_MS);
      void refreshGitStats(ctx);
      if (gitTimer) clearInterval(gitTimer);
      gitTimer = setInterval(() => void refreshGitStats(ctx), GIT_REFRESH_INTERVAL_MS);
      const layout = (left, right, width) => {
        const pad = " ".repeat(Math.max(1, width - visibleWidth2(left) - visibleWidth2(right)));
        return left + pad + right;
      };
      const padTo = (str, w) => str + " ".repeat(Math.max(0, w - visibleWidth2(str)));
      const padLeft = (str, w) => " ".repeat(Math.max(0, w - visibleWidth2(str))) + str;
      const BAR_BLOCKS = ["\u258F", "\u258E", "\u258D", "\u258C", "\u258B", "\u258A", "\u2589"];
      const pctColor = (pct) => pct > 90 ? "error" : pct > 75 ? "warning" : pct > 50 ? "accent" : "success";
      const progressBar = (pct, width = 10) => {
        const total = width * 8;
        const filled = Math.max(0, Math.min(total, Math.round(pct / 100 * total)));
        const full = Math.floor(filled / 8);
        const part = filled % 8;
        const empty = Math.max(0, width - full - (part ? 1 : 0));
        const color = pctColor(pct);
        let s = theme.fg(color, "\u2588".repeat(full));
        if (part) s += theme.fg(color, BAR_BLOCKS[part - 1]);
        s += " ".repeat(empty);
        return s;
      };
      const renderBalanceLine = () => {
        const b = balance;
        const label = theme.fg("dim", "\u4F59\u989D");
        if (b.loading) return `${label} \u67E5\u8BE2\u4E2D\u2026`;
        if (b.moduleMissing) return `${label} ${theme.fg("warning", "\u6A21\u5757\u7F3A\u5931")}`;
        if (b.unsupported) return `${label} ${b.providerId ?? "?"} \u672A\u9002\u914D\uFF08\u4F59\u989D/plan \u67E5\u8BE2\uFF09`;
        if (b.error) return `${label} \u83B7\u53D6\u5931\u8D25\uFF08${b.error}\uFF09`;
        if (b.data) {
          const color = b.data.status === "ok" ? "success" : b.data.status === "warning" ? "warning" : "error";
          if (b.data.quotas && b.data.quotas.length > 0) {
            const amountText2 = formatAmount(b.data.amount);
            const showMoney = b.data.showAmountWithQuotas || amountText2.startsWith("\xA5");
            const amountPart = showMoney ? `${theme.fg(color, amountText2)}` : "";
            const pct = (used, limit) => limit > 0 ? Math.round(used / limit * 100) : 0;
            const gauge = (used, limit, width = 5) => {
              if (limit <= 0) return theme.fg("dim", "\u25B1".repeat(width));
              const p = pct(used, limit);
              const filled = Math.max(0, Math.min(width, Math.round(used / limit * width)));
              const c = pctColor(p);
              return theme.fg(c, "\u25B0".repeat(filled)) + theme.fg("dim", "\u25B1".repeat(width - filled));
            };
            const qText = b.data.quotas.map((q) => {
              const p = pct(q.used, q.limit);
              const c = pctColor(p);
              const val = q.currency ? `${costMod?.currencySymbol(q.currency) ?? `${q.currency} `}${q.used.toFixed(2)}/${q.limit.toFixed(2)}` : theme.fg(c, `${p}%`);
              return `${gauge(q.used, q.limit)} ${theme.fg("dim", q.label)} ${q.currency ? theme.fg(c, val) : val}`;
            }).join(` ${theme.fg("dim", "\xB7")} `);
            const parts = [label, amountPart, qText].filter(Boolean);
            return parts.join(" ");
          }
          const amountText = formatAmount(b.data.amount);
          const amount = theme.fg(color, amountText);
          const detail = b.data.detail ? ` ${theme.fg("dim", b.data.detail)}` : "";
          const prefix = b.data.hideLabel ? "" : `${label} `;
          return `${prefix}${amount}${detail}`;
        }
        return `${label} -`;
      };
      const renderGitLine = () => {
        if (!gitMod) return theme.fg("warning", "\u2387 \u6A21\u5757\u7F3A\u5931");
        if (!gitStats) return theme.fg("dim", "\u2387 -");
        const g = gitStats;
        const badge = theme.fg("accent", `\u2387 ${g.branch ?? "HEAD"}`);
        const parts = [];
        if (g.ahead || g.behind) parts.push(theme.fg("dim", `\u9886\u5148${g.ahead} \u843D\u540E${g.behind}`));
        if (g.staged) parts.push(theme.fg("success", `\u6682\u5B58${g.staged}`));
        if (g.unstaged) parts.push(theme.fg("warning", `\u4FEE\u6539${g.unstaged}`));
        if (g.untracked) parts.push(theme.fg("muted", `\u672A\u8DDF\u8E2A${g.untracked}`));
        return parts.length ? `${badge}${theme.fg("dim", " \u30FB ")}${parts.join(theme.fg("dim", " \u30FB "))}` : badge;
      };
      const renderStatuses = () => {
        let best = null;
        for (const [key, text] of footerData.getExtensionStatuses()) {
          if (!text) continue;
          const style = STATUS_STYLE[key];
          const priority = style?.priority ?? 0;
          if (!best || priority > best.priority) best = { text, color: style?.color, priority };
        }
        if (!best) {
          const tip = truncateToWidth2(`\u4F1A\u8BDD ${fmtDuration(Date.now() - (costMod?.getStartupTime() ?? Date.now()))}`, RIGHT_SEG2, "");
          return theme.fg("muted", tip) + " ".repeat(RIGHT_SEG2 - visibleWidth2(tip));
        }
        const truncated = truncateToWidth2(best.text, RIGHT_SEG2, "");
        const content = best.color ? theme.fg(best.color, truncated) : truncated;
        return content + " ".repeat(RIGHT_SEG2 - visibleWidth2(truncated));
      };
      return {
        dispose() {
          unsubBranch();
          unsubInput();
          footerInstalled = false;
          if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = void 0;
          }
          if (gitTimer) {
            clearInterval(gitTimer);
            gitTimer = void 0;
          }
        },
        invalidate() {
        },
        render(width) {
          const model = ctx.model;
          const left1 = renderGitLine();
          const project = ctx.cwd.split(/[\\/]/).filter(Boolean).pop() || ctx.cwd;
          const right1 = `${padLeft(project ? theme.fg("dim", `\u{1F4C1} ${project}`) : "", RIGHT_SEG1)}${theme.fg("dim", " \u2502 ")}${renderStatuses()}`;
          const providerDisplay = model ? ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider : "no-model";
          const thinkingTag = ctx.thinkingLevel ? theme.fg("dim", `(${THINKING_LABEL[ctx.thinkingLevel] ?? ctx.thinkingLevel})`) : "";
          const left2 = theme.fg("accent", `[${providerDisplay}]`) + " " + theme.fg("text", model?.id ?? "\u672A\u9009\u62E9\u6A21\u578B") + (thinkingTag ? ` ${thinkingTag}` : "");
          let input = 0, output = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message;
              input += m.usage.input;
              output += m.usage.output;
            }
          }
          const tokensSeg = costMod ? (() => {
            const tokenRate = costMod.getTokenRate(Date.now()) ?? 0;
            const rateStr = tokenRate >= 1e3 ? `${costMod.fmtNum(tokenRate)}/s` : tokenRate >= 100 ? `${tokenRate.toFixed(1)}/s` : `${tokenRate.toFixed(2)}/s`;
            return `${theme.fg("muted", `\u2191${costMod.fmtNum(input)}`)} ${theme.fg("muted", `\u2193${costMod.fmtNum(output)}`)} ${theme.fg("muted", rateStr)}`;
          })() : "";
          const usage = ctx.getContextUsage();
          const ctxSeg = costMod ? (() => {
            const pctRaw = usage?.percent;
            const pct = pctRaw != null ? Math.round(pctRaw) : 0;
            const pctText = `${pct}%`;
            const pctWidth = visibleWidth2(pctText);
            const windowText = usage?.contextWindow != null ? costMod.fmtNum(usage.contextWindow) : null;
            if (windowText == null) {
              const numText = pctRaw != null ? pctText : "0";
              const barWidth2 = Math.max(3, RIGHT_SEG2 - 3 - visibleWidth2(numText));
              return `[${progressBar(pct, barWidth2)}] ${numText}`;
            }
            if (pctRaw == null) {
              const barWidth2 = Math.max(3, RIGHT_SEG2 - 3 - visibleWidth2(windowText));
              return `[${progressBar(0, barWidth2)}] ${windowText}`;
            }
            const barWidth = Math.max(3, RIGHT_SEG2 - 3 - visibleWidth2(windowText));
            const total = barWidth * 8;
            const filledCells = Math.round(pct / 100 * total);
            const used = Math.floor(filledCells / 8) + (filledCells % 8 ? 1 : 0);
            const empty = Math.max(0, barWidth - used);
            if (empty >= pctWidth + 1) {
              const bar = progressBar(pct, barWidth);
              const core = bar.slice(0, bar.length - empty);
              const rest = " ".repeat(empty - (pctWidth + 1));
              return `[${core}${theme.fg("dim", ` ${pctText}`)}${rest}] ${windowText}`;
            }
            const barWidthB = Math.max(3, RIGHT_SEG2 - 3 - pctWidth);
            return `[${progressBar(pct, barWidthB)}] ${pctText}`;
          })() : "";
          const right2 = costMod ? `${padLeft(tokensSeg, RIGHT_SEG1)}${theme.fg("dim", " \u2502 ")}${padTo(ctxSeg, RIGHT_SEG2)}` : `${padLeft(theme.fg("warning", "\u7528\u91CF \u6A21\u5757\u7F3A\u5931"), RIGHT_SEG1)}${theme.fg("dim", " \u2502 ")}${padTo("", RIGHT_SEG2)}`;
          const left3 = renderBalanceLine();
          const adapter = ctx.model?.provider && balanceMod ? balanceMod.BALANCE_ADAPTERS[ctx.model.provider] : void 0;
          const rateText = adapter?.rateText ? (adapter.rateText(ctx, Date.now()) ?? []).map((p) => theme.fg(p.color ?? "muted", p.text)).join(" ") : "";
          const timeText = balance.fetchedAt ? theme.fg("dim", fmtTime(balance.fetchedAt)) : "";
          const right3 = timeText ? `${padLeft(rateText, RIGHT_SEG1)}${theme.fg("dim", " \u2502 ")}${padTo(timeText, RIGHT_TOTAL - RIGHT_SEG1 - 3)}` : padLeft(rateText, RIGHT_TOTAL);
          const line1 = layout(left1, right1, width);
          const line2 = layout(left2, right2, width);
          const line3 = layout(left3, right3, width);
          return [line1, line2, line3].map((l) => truncateToWidth2(l, width));
        }
      };
    });
  }
  pi.on("session_start", async (_event, ctx) => {
    if (costMod) costMod.resetCostTracking(ctx);
    if (ctx.mode !== "tui") return;
    installFooter(ctx);
  });
  pi.on("turn_start", async () => {
    if (costMod) costMod.startTurn();
  });
  pi.on("turn_end", async (_event, ctx) => {
    if (costMod) costMod.recordTurnCosts(ctx);
    if (!footerInstalled) return;
    if (Date.now() - lastAutoRefresh > TURN_REFRESH_THROTTLE_MS) void refreshBalance(ctx);
    void refreshGitStats(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    balance = { loading: false };
    tuiRef?.requestRender();
    if (ctx.model?.id) pushStatus(ctx, "model-switch", `\u21C4 ${ctx.model.id}`, 3e3);
    if (footerInstalled) void refreshBalance(ctx);
  });
  pi.on("session_shutdown", async () => {
    for (const t of statusClearTimers.values()) clearTimeout(t);
    statusClearTimers.clear();
    if (gitTimer) {
      clearInterval(gitTimer);
      gitTimer = void 0;
    }
  });
  pi.registerCommand("balance", {
    description: "\u7ACB\u5373\u5237\u65B0\u8D26\u6237\u4F59\u989D / plan \u4F59\u91CF\u5E76\u901A\u77E5",
    handler: async (_args, ctx) => {
      await refreshBalance(ctx);
      ctx.ui.notify(
        describeBalance(),
        balance.data?.status === "error" ? "error" : balance.data?.status === "warning" ? "warning" : "info"
      );
    }
  });
  pi.registerCommand("git", {
    description: "\u6253\u5F00\u53EF\u89C6\u5316 Git \u9762\u677F\uFF08stage / unstage / discard / commit / refresh\uFF09",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/git \u4EC5\u5728\u4EA4\u4E92\u6A21\u5F0F\u4E0B\u53EF\u7528", "warning");
        return;
      }
      if (!gitMod) {
        ctx.ui.notify("hud-git \u5B50\u6A21\u5757\u7F3A\u5931\uFF0C\u65E0\u6CD5\u6253\u5F00 Git \u9762\u677F", "error");
        return;
      }
      if (!await gitMod.isGitRepo(ctx.cwd)) {
        ctx.ui.notify("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F git \u4ED3\u5E93", "warning");
        return;
      }
      await gitMod.openGitPanel(ctx, () => void refreshGitStats(ctx));
    }
  });
  pi.registerCommand("hud", {
    description: "\u5207\u6362 3 \u884C HUD \u72B6\u6001\u680F",
    handler: async (_args, ctx) => {
      if (footerInstalled) {
        ctx.ui.setFooter(void 0);
        ctx.ui.notify("3 \u884C HUD \u5DF2\u5173\u95ED", "info");
      } else {
        installFooter(ctx);
        ctx.ui.notify("3 \u884C HUD \u5DF2\u5F00\u542F", "info");
      }
    }
  });
}
export {
  hud_core_default as default
};
