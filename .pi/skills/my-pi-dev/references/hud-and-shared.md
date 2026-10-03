# hud 与 shared/

## hud（`src/extensions/hud/`，产物 `hud.ts`）

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口薄壳，`export { default } from "./hud-core"`（pi 加载约定） |
| `hud-core.ts` | 核心：三行三列渲染、`STATUS_STYLE`、生命周期、`/balance` `/git` `/hud`、globalThis 契约、子模块动态加载与降级 |
| `hud-spark.ts` | 速率柱状纯函数：`sparkline`（单行 8 档）、`sparklineBars`（两行 16 档）、`brailleLine`（盲文 2×4 备用）、`SPARK_WIDTH=24`、`SPARK_BASELINE`、`RATE_REF_DECAY=0.995`。**只出字符不分色**（柱图统一 accent 单色），0 档与冷启动占位都是最低档 ▁ |
| `hud-balance.ts` | 供应商余额适配器注册表 `BALANCE_ADAPTERS` |
| `hud-cost.ts` | usage 汇总 / 定价 / 按量付费文本 / 实时汇率 / EMA 与本轮速率 / Z.AI 积分轨 |
| `hud-git.ts` | git 状态解析（porcelain + 路径 unquote + numstat）、Visual Git 面板、stage/discard/commit/sync、AI 提交信息与冲突消解 |
| `test/` | 4 个回归：`sparkline`（宽度/档位/ref）、`token-rate`（速率口径）、`unquote`（八进制与引号解码 + 真实仓库操作，需 PATH 有 git）、`zai-credits`（积分差分/meteredRateText/adapter） |

三行三列（中右之间 dim 竖线，三行共用栏宽）：

- 行 1：左 git 状态 · 中动态区（状态文案，柱图在空间够时借用该行上半区）· 右 `📁 目录名`
- 行 2：左 `[Provider] model (thinking)` · 中速率柱图 + `🔥本轮` + `📊EMA` · 右上下文进度条
- 行 3：左 余额/plan 余量（+ 峰谷徽章）· 中 token `↑↓` + 消耗速率/累计 · 右余额刷新时刻 `↻ HH:MM:SS`

**`STATUS_STYLE`（hud-core.ts，键名 ↔ 颜色 + priority，数字大者胜出；未登记＝灰字 priority 0；同优先级先遍历到的胜出）**——一根轴分五层，另加未登记兜底：

- 输入态：`hud-bash`=100
- 结果提醒：`task-alert-error`=92、`task-alert-wait`=91、`task-alert`=90
- 阻塞等人：`perm-gate`=86、`ask`=84
- 进行中·具体活动：`init`=80、`balance-error`=78、`img-slim`=76、`web-search`=75、`web-fetch`=74、`kb-sync`=73、`workflow-mgr`=72、`mimo-omni`=70、`model-switch`=70、`explore`=68、`qr`=64、`kb-vault`=62、`clipboard`=61、`kb-op`=61、`btw-transfer`=60
- 进行中·通用兜底：`task-alert-run`=58
- 环境信息：`pair-guard`=56

hud 自己只推 `hud-bash` / `balance-error` / `model-switch` 三个 key，其余是外部扩展推、hud 负责按表呈现（TTL 与闪烁由推送方自管）。

**globalThis 契约**：

- `__PI_HUD_ACTIVE__`：扩展入口与 `installFooter()` 置 true，footer `dispose()` 与 `session_shutdown` 置 false；每次 install/dispose 同时 `process.emit("hud:state-change")`。
- `__PI_HUD_API__`：`registerExtraRows(provider)`（provider 为 `(theme, width) => string[] | null`，返回注销函数）与 `notifyExtraRowsUpdate()`。**当前 workflow-mgr 已依赖**：hud 开启时它注册渲染函数，常驻面板内容改由 hud 在 footer 最底部渲染、自绘面板隐藏；hud 关闭或 showPanel 关时注销并恢复自绘（`workflow-mgr/panel.ts` 与 `events.ts` 监听 `hud:state-change`）。

**余额与定价**：`BALANCE_ADAPTERS` 覆盖 11 个 provider——`deepseek`、`xiaomi`、`kimi-coding`、`moonshotai`、`moonshotai-cn`、`xiaomi-token-plan-cn`、`openrouter`、`volcengine-coding`、`sensenova`、`opencode-go`、`zai-coding-cn`；余额状态统一 `ok|warning|error`，可返回实时余额 / 控制台链接 / 多窗口 quota / `rateText`。成本口径：DeepSeek / Kimi / MiMo 按官方人民币定价直算（恒 ¥，不依赖汇率），OpenCode Go 按其 USD 定价直算，其余用 pi 原始 USD 成本并在显示时换算；Z.AI 走积分独立轨（数字是积分、颜色按 USD 等效成本）。**汇率三态**：实时（frankfurter → open.er-api 双源，1h 节流）→ 磁盘缓存（`~/.pi/agent/tmp/exchange-rate.json`）→ 无（双源请求失败且无缓存时显示原始货币 USD，**不用固定近似值**）。余额刷新周期 5min。

**两套速率口径**：

- 消耗速率：10 分钟滚动窗口，启动不足 1 分钟不显示。
- 输出 token 速率：分子 = assistant `usage.output` 增量（供应商上报，已含 reasoning/thinking token），分母 = 模型生成段（`turn_start` → assistant `message_end`，含网络与首字延迟、**不含工具执行**，最短按 100ms）；原值 + EMA 双显。
- 曲线采样：`turn_end` 每轮一次，窗口 `RATE_TURNS = 40`；每轮取该轮值否则 EMA；满格参考 `rateRef = max(本轮值, 上轮 ref × RATE_REF_DECAY)`（粘性 EMA 位置，不因峰值滚出窗口而突缩），`hud-spark` 再保证 ref 不低于窗口峰值。

**子模块可选加载与降级**（任一缺失不拖垮 HUD）：`hud-balance` 缺失 → 行 3 显「余额 模块未加载」且不发余额请求；`hud-cost` 缺失 → 行 2 不画柱图、右列显「用量 模块缺失」、行 3 中列隐藏 token/消耗；`hud-git` 缺失 → 行 1 显「⎇ git模块未加载」、`/git` 报未加载，与「⎇ -（非 git 仓库）」可区分。

## shared/（`src/extensions/shared/`，被扩展 import、build.js 内联、不直接部署）

| 模块 | 导出 / 职责 | 消费方 |
|---|---|---|
| `agent.ts` | `convertToLlm`（只放行 system/user/assistant/toolResult，**system 必须放行**：0.86 起系统提示词以前导 system 消息挂在 messages 里）、`systemMessage`、`createPiStreamFn(ctx)`（走 pi 已登录通道，每次调用前取最新认证，并按供应商规则注入会话/归因头——深加载 pi 内部 `dist/core/provider-attribution.js`，查不到就降级不带头） | claude-it /init、btw、workflow-mgr 审计、explore-agent |
| `config.ts` | `loadJsonConfig`（缺失/校验不过回默认；JSON 损坏则改名 `.corrupt-<时间戳>` 隔离留证；顺带清理 `.tmp-<pid>` 残档）、`saveJsonConfig`（临时文件 + rename 原子写）、`isModelConfig` | 几乎所有扩展 |
| `status.ts` | `setStatusWithTTL(ctx,key,text,ttl)`（同 key 重置定时器；text=undefined 只清）、`clearStatusTimers()`；对失效 ctx 抛错有 try/catch 兜底 | hud-core、explore-agent、web-tool、webdav-kb、clipboard、qr 等 |
| `ui.ts` | `createBoxRenderer`（╭╮│╰╯ 全封闭浮层边框 + `…` 截断，可选 borderMuted）、`editInput`（输入编辑键统一：backspace/delete/home/end/ctrl+u/ctrl+←→按词移动/ctrl+w 删词/粘贴，grapheme 安全步进）、`renderScrollingInput`、`renderInputWithCursor`、`charIndexAtWidth`/`sliceByWidth` | 所有浮层面板 |
| `markdown.ts` | `wrapText`、`renderAnswer`（行内样式 / 代码块 / 标题 / 列表 / 表格整块渲染避免换行拆散对齐，列宽自适应超宽压缩），原 `btw/render.ts` 上提；`btw/render.ts` 保留同名转发 | ask 说明题、btw |
| `model-pick.ts` | `pickAuxModel(ctx, preferred)`：辅助 AI 任务选模型——按优先列表找已认证，兜底最便宜的已认证模型，找不到返回 undefined 由调用方降级 | hud-git、perm-gate、status-beacon |
| `model-selector.ts` | `pickModelViaSelector(ctx)`：复用 pi 官方 `ModelSelectorComponent`（`ModelRegistry.runtime` 直通，d.ts 标 private 但运行时公开） | perm-gate、status-beacon |
| `model-select.ts` | `ModelSelectOverlay`（可搜索模型浮层）、`listAvailableModels`/`findConfiguredModel`/`modelTotalCost`/`formatModelPrice`/`formatContextWindow`/`modelSettingLabel`、`registerModelConfigCommand(pi, opts)`（`/btw-config` `/explore-config` 等同构交互的工厂：带参数直设、无参开面板） | btw、explore-agent、webdav-kb 面板模式参考 |
| `net.ts` | `makeTimeoutSignal`（超时 + 外部取消 + cleanup）、`makeProxyConnection`（HTTP 代理 CONNECT 隧道，仅支持 `http://` 代理，TLS 目标再套 tls；原 web-tool 与 webdav-kb 逐字重复的实现收敛于此） | web-tool、webdav-kb |
| `shell-split.ts` | `splitShellSegments`：`&&`/`||`/`;`/`|`/换行切段、`$()`/反引号递归拆出、引号与转义保护、单个 `&` 不切、**heredoc 主体是数据不逐行拆**（但主体内 `$()` 仍递归拆出）；启发式，宁多拆不漏拆 | perm-gate |
| `presence.ts` | 跨实例「用户在场」判定 + 提示音全局去重：`getOsIdleMs()`（Windows GetLastInputInfo 常驻 PowerShell 每 2s 上报、macOS ioreg、Linux xprintidle；`PI_OS_IDLE_MS` 可注入）、一实例一文件的在场记录（`~/.pi/agent/presence/<sid>.json`，原子替换、死进程/陈旧档忽略）、`computeActive`/`computeAway`、`claimSoundSlot`（`wx` 独占创建 + 超龄回收的跨进程名额）、`disposeIdleProbe` | status-beacon |
| `explore-api.ts` | 跨扩展契约单点定义：`EXPLORE_API_KEY="__PI_EXPLORE_API__"`、`EXPLORE_API_VERSION=1`、`publishExploreApi`/`getExploreApi`（版本不符或未加载返回 null） | explore-agent 发布、claude-it 消费 |
| `context-budget.ts` | `estimateTokens`（CJK 按 1 字 1 token、ASCII 按 3.5 字符）、`pruneOldToolResults(messages, budget)`（超预算从最旧/最廉价开始把工具结果换成占位文本：read/grep/find/ls/bash → explore → 其他，write/edit 不剪，最近 10 条不动）、`CONTEXT_OVERFLOW_RE`（各家超限措辞，explore 转出） | claude-it /init、explore-agent |
| `turndown-gfm.d.ts` | `turndown-plugin-gfm` 的类型声明 | web-tool |
