# hud 与 shared/

## hud（`src/extensions/hud/`，产物 `hud.ts`）

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口薄壳，`export { default } from "./hud-core"`（pi 加载约定） |
| `hud-core.ts` | 核心：三行三列渲染、`STATUS_STYLE`、生命周期、`/balance` `/git` `/hud`、globalThis 契约、子模块动态加载与降级 |
| `hud-spark.ts` | 速率柱状纯函数：`sparklineCells` / `sparkBarsCells`（逐格字符 + 值 + 该轮输出 token，供调用方逐格上色）、`sparkline`（单行 8 档）、`sparklineBars`（两行 16 档）、`brailleLine`（盲文 2×4 备用）、分档与加权 `rateBand` / `outputFade` / `RATE_BAND_EDGES` / `BRIGHT_LOG_K` / `FADE_MAX` / `FADE_STEP`、`SPARK_WIDTH=24`、`SPARK_BASELINE`、`RATE_REF_DECAY=0.995`。**自身不分色**，0 档与冷启动占位都是最低档 ▁ |
| `hud-balance.ts` | 供应商余额适配器注册表 `BALANCE_ADAPTERS` |
| `hud-cost.ts` | usage 汇总 / 定价 / 按量付费文本 / 实时汇率 / EMA 与本轮速率 / Z.AI 积分轨 |
| `hud-git.ts` | git 状态解析（porcelain + 路径 unquote + numstat）、Visual Git 面板、stage/discard/commit/sync、AI 提交信息与冲突消解、后台静默 fetch（`gitFetchQuiet`）、`/git-config`（两个模型槽 + `fetchIntervalMin` 后台 fetch 间隔，默认 5 分钟、默认开） |
| `test/` | 7 个回归：`sparkline`（宽度/档位/ref）、`token-rate`（速率口径）、`unquote`（八进制与引号解码 + 真实仓库操作 + 后台 fetch 间隔归一化，需 PATH 有 git）、`zai-credits`（积分差分/meteredRateText/adapter）、`price-keys`（Go/Kimi 模型 id → 定价键路由 + Go 额度权重/池）、`kimi-balance`（Kimi 余量字段解析：remaining 回推 / 加油包停用 / 额度耗尽）、`mimo-balance`（MiMo 按量 `platform/balance` 与三区 Token Plan `platform/token_plan` 解析、积分轨估算与夜间 0.8x） |

三行三列（中右之间 dim 竖线，三行共用栏宽）：

- 行 1：左 git 状态 · 中动态区（状态文案，柱图在空间够时借用该行上半区）· 右 `📁 目录名`
- 行 2：左 `[Provider] model (thinking)` · 中速率柱图 + `🔥本轮` + `📊EMA` · 右上下文进度条
- 行 3：左 余额/plan 余量（+ 峰谷徽章）· 中 token `↑↓` + 消耗速率/累计 · 右余额刷新时刻 `↻ HH:MM:SS`

**`STATUS_STYLE`（hud-core.ts，键名 ↔ 颜色 + priority，数字大者胜出；未登记＝灰字 priority 0；同优先级先遍历到的胜出）**——一根轴分五层，另加未登记兜底：

- 输入态：`hud-bash`=100
- 结果提醒：`task-alert-error`=92、`task-alert-wait`=91、`task-alert`=90
- 挂机态：`keep-idle`=87（高于全部工具活动，回来时一眼看出是挂机而不是在干活）
- 阻塞等人：`secure`=86、`ask`=84
- 进行中·具体活动：`init`=80、`balance-error`=78、`img-slim`=76、`web-search`=75、`web-fetch`=74、`kb-sync`=73、`skill-hub`=72、`workflow-mgr`=72、`mimo-omni`=70、`model-switch`=70、`explore`=68、`keep`=66、`qr`=64、`kb-vault`=62、`clipboard`=61、`kb-op`=61、`btw-transfer`=60
- 进行中·通用兜底：`task-alert-run`=58
- 环境信息：`secret`=57、`pair-guard`=56

hud 自己只推 `hud-bash` / `balance-error` / `model-switch` 三个 key，其余是外部扩展推、hud 负责按表呈现（TTL 与闪烁由推送方自管）。

**globalThis 契约**：

- `__PI_HUD_ACTIVE__`：扩展入口与 `installFooter()` 置 true，footer `dispose()` 与 `session_shutdown` 置 false；每次 install/dispose 同时 `process.emit("hud:state-change")`。
- `__PI_HUD_API__`：`registerExtraRows(provider)`（provider 为 `(theme, width) => string[] | null`，返回注销函数）与 `notifyExtraRowsUpdate()`。**当前 workflow-mgr 已依赖**：hud 开启时它注册渲染函数，常驻面板内容改由 hud 在 footer 最底部渲染、自绘面板隐藏；hud 关闭或 showPanel 关时注销并恢复自绘（`workflow-mgr/panel.ts` 与 `events.ts` 监听 `hud:state-change`）。

**余额与定价**：`BALANCE_ADAPTERS` 覆盖 13 个 provider——`deepseek`、`xiaomi`、`kimi-coding`、`moonshotai`、`moonshotai-cn`、`xiaomi-token-plan-{cn,sgp,ams}`、`openrouter`、`volcengine-coding`、`sensenova`、`opencode-go`、`zai-coding-cn`（MiMo 按量问 `api.xiaomimimo.com/v1/platform/balance`（DeepSeek 口径：现金作主金额、赠金 `+ X.XX`、授信/冻结进 detail，可支出总额只用于变色），Token Plan 三区各问 `token-plan-{cn,sgp,ams}.xiaomimimo.com/v1/platform/token_plan`（额度只有一个总数，余额行一根额度条 + 已用百分比、`label` 留空不标周期——响应里的 `period` 只是订阅有效期，月卡年卡同口径；渲染层对空 label 跳过不输出））；余额状态统一 `ok|warning|error`。`BalanceData` 无默认字段：行首标签 `label?`（缺省不印，钱类给「余额」、额度池给「额度」、无 API 的给「余量查询」），`amount?` 可缺席（纯链接型不填），金额与额度条同显只由 `showAmountWithQuotas?` 决定（不嗅探币种），无 `hideLabel`。可返回实时余额 / 控制台链接 / 多窗口 quota / `rateText`。成本口径：DeepSeek / Kimi / MiMo 按官方人民币定价直算（恒 ¥，不依赖汇率），Z.AI 国内通道（`zai-coding-cn`）按国内官方人民币价直算（`ZAI_PRICES`，含高速档；未登记型号回落 pi 目录价），其余用 pi 原始 USD 成本并在显示时换算；Z.AI 与 MiMo Token Plan 走积分独立轨（数字是整数积分，颜色取人民币轨信号，无人民币事件时回落 USD × 汇率）。**OpenCode Go 是单一额度池**（Go $60/月、Go Plus $240/月，跨模型共享）：各模型官方 "Monthly limit" M 是这份池在该模型上的等值，占比 = Σ(标价花费 / M)，故每 $1 标价消耗的额度当量 = 池 / M（Go：$15 档 ×4、$30 档 ×2、$60 档 ×1、$80 档 ×0.75）。`hud-cost` 的 `GO_ALLOWANCE` / `GO_ALLOWANCE_PLUS` 存两档 M 表，`goQuotaUsd` 返回额度当量（不换算 ¥），HUD 行 2 思考强度后显示 `・N×` 相对价（`modelPriceIndex`：模型生效价 ÷ 基准价，越大越贵）：基准硬编码为 DS V4.1 Flash 官方**高峰价**（¥0.04/2/8 每百万 tokens 的缓存命中/未命中/输出），按 340:6:1 混合。**Plan 渠道带订阅折扣**——Go 按 `月费/月额度`（$10/$60 = 1/6，Plus 同）；GLM Coding Plan 按档位积分单价 × 抵扣系数（Lite/Pro/Max 周积分 1万/6万/14万，非高峰 ×0.5，档位由 quota 接口 `level` 或积分上限自动识别）；MiMo Token Plan / Kimi / 火山 / SenseNova 的 `modelPriceIndex` 不加订阅折扣（按量标价直接参与相对价；MiMo Token Plan 虽有公开额度与积分单价，但额度随档位变化，暂不折算）。峰谷（DS 高峰 ×2、Go 的 DeepSeek ×2）按当前时段实时计；美元/Go 通道按实时汇率折（无汇率则不显示）；Go 档位由 hud-balance 用 console 本月分模型花费反推（`/api/usage/models`，每会话一次、月度用量 ≥3% 才试，失败保持 Go 档）。**汇率三态**：实时（frankfurter → open.er-api 双源，1h 节流）→ 磁盘缓存（`~/.pi/agent/tmp/exchange-rate.json`）→ 无（双源请求失败且无缓存时显示原始货币 USD，**不用固定近似值**）。余额刷新周期 5min。

**定价/余量数据的核对方法**（上游改价或改模型时走这三步）：
1. pi 侧权威价目：`~/.pi/agent/models-store.json`（按 provider 分文件，每次会话自动刷新）——可直接对照 `hud-cost.ts` 的 `DEEPSEEK_PRICES` / `MIMO_PRICES` / `KIMI_PRICES` / `GO_PRICES` / `ZAI_PRICES`；
   - pi 目录把部分型号的 `cost` 写成 0（已知：`glm-5.3-highspeed`、`glm-5.2-highspeed`）——判 0 为免费会让 FREE 策略选中它们，故 `shared/model-util.ts` 的 `COST_OVERRIDES` 兜住生效价（只影响「是否免费」与排序）；新增此类型号时同处登记；
2. 现网接口实测：`/coding/v1/usages`（Kimi）、`/zen/go/v1/usage`（OpenCode Go）、`/user/balance`（DeepSeek）、`/api/v1/key`（OpenRouter）、`/api/monitor/usage/quota/limit`（Z.AI）、`/v1/models`（火山方舟 / SenseNova），curl 一遍看字段形状是否变；
3. 官方定价页与模型列表：OpenCode Go 表、Kimi 开放平台定价、DeepSeek 定价、火山 Coding Plan 套餐概览。

模型 id 映射改动后跑 `node src/extensions/hud/test/price-keys.test.mjs`（盯 Go / Kimi / Z.AI 的路由键、Go 两档额度权重与相对价、GLM 档位识别/折扣）与 `node src/extensions/shared/test/model-util.test.mjs`（盯 0 价高速档不被判免费）。

**两套速率口径**：

- 消耗速率：10 分钟滚动窗口，启动不足 1 分钟不显示。
- 输出 token 速率：分子 = assistant `usage.output` 增量（供应商上报，已含 reasoning/thinking token），分母 = 模型生成段（`turn_start` → assistant `message_end`，含网络与首字延迟、**不含工具执行**，最短按 100ms）；原值 + EMA 双显。
- 曲线采样：`turn_end` 每轮一次，窗口 `RATE_TURNS = 40`；每轮取该轮值否则 EMA；满格参考 `rateRef = max(本轮值, 上轮 ref × RATE_REF_DECAY)`（粘性 EMA 位置，不因峰值滚出窗口而突缩），`hud-spark` 再保证 ref 不低于窗口峰值。采样时同时存该轮输出 token 数（`costMod.getTurnOutput()`，hud-cost 的 `lastTurnOutput`）入并行的 `turnOutputs`。
- 柱色：分档用 `RATE_BAND_COLORS`（hud-core 顶部，可改）——`rateBand` 按下标取色（`<20` 红 #ff5470 / `20–50` 琥珀 #ffe066 / `50–100` 绿 #00ff41 / `≥100` 青 #00ffd5），`🔥` 数字同色；亮度用 `outputFade(本轮输出, outputRef)`——**输出越长越亮**，`bright = log(1+10t)/log(11)`（`BRIGHT_LOG_K=10`，实测重尾分布下 6 档铺满，幂/线性映射会把 2/3 柱子挤在一两档），向背景混色最多 `FADE_MAX=0.625`、量化 `FADE_STEP=0.125`，深色主题向黑、浅色主题向白（`theme.appearance`）；`0` 值与占位格用 `theme.colors.dim`；逐格按 key 合并同色段后 `theme.style(seg, {fg})`。参考峰值 `outputRef = max(本轮输出, 上轮 × RATE_REF_DECAY)`（与 rateRef 同理）。无主题部分全在 `hud-spark`（`rateBand`/`outputFade`/`sparklineCells`/`sparkBarsCells`），可单测。

**子模块可选加载与降级**（任一缺失不拖垮 HUD）：`hud-balance` 缺失 → 行 3 显「余额 模块未加载」且不发余额请求；`hud-cost` 缺失 → 行 2 不画柱图、右列显「用量 模块缺失」、行 3 中列隐藏 token/消耗；`hud-git` 缺失 → 行 1 显「⎇ git模块未加载」、`/git` 报未加载，与「⎇ -（非 git 仓库）」可区分。

## shared/（`src/extensions/shared/`，被扩展 import、build.js 内联、不直接部署）

| 模块 | 导出 / 职责 | 消费方 |
|---|---|---|
| `agent.ts` | `convertToLlm`（只放行 system/user/assistant/toolResult，**system 必须放行**：0.86 起系统提示词以前导 system 消息挂在 messages 里）、`systemMessage`、`createPiStreamFn(ctx)`（走 pi 已登录通道，每次调用前取最新认证，头管道复用 `llm.ts` 的 `piAttributionHeaders`；**单次调用需求走 `llm.ts` 的 `aiComplete`，不要用它做一次性调用**） | context-init、btw、explore-agent |
| `config.ts` | `loadJsonConfig`（缺失/校验不过回默认；JSON 损坏则改名 `.corrupt-<时间戳>` 隔离留证；顺带清理 `.tmp-<pid>` 残档）、`saveJsonConfig`（临时文件 + rename 原子写）、`isModelConfig` | 几乎所有扩展 |
| `fs-safe.ts` | `removePath(target)`：删文件/目录树，返回目标是否已不存在（不抛错，调用方按返回值提示失败）。手写递归（`unlinkSync` + `rmdirSync`）+ 结尾复核，符号链接/junction 只删链接本身——本机 `fs.rmSync` 在**含中文的路径**下报成功却不删，项目目录下的清理会“看着成功、实际什么都没删” | crash-log、explore-agent、dingtalk-bridge、presence |
| `status.ts` | `setStatusWithTTL(ctx,key,text,ttl)`（同 key 重置定时器；text=undefined 只清）、`clearStatusTimers()`、`STATUS_BEACON_API_KEY`（beacon 等待契约键名单点：status-beacon 生产与本模块消费共用同一常量）、`setWaiting`；对失效 ctx 抛错有 try/catch 兜底 | hud-core、explore-agent、web-tool、webdav-kb、clipboard、qr、mimo-omni、status-beacon 等 |
| `ui.ts` | `createBoxRenderer`（╭╮│╰╯ 全封闭浮层边框 + `…` 截断，可选 borderMuted，**底色默认铺满**：`PANEL_BG = "customMessageBg"`，传 `bg: false` 关闭）、`paintSurface(theme, lines, width)`（给自绘边框的面板整行铺底色并补齐到满宽，必须补满——只给文字上底色会让行尾露白）、**`hint(text)`（BoxRenderer 方法：灰字提示行的唯一正确入口，内部走 `row()` 铺底补宽；用裸的 `keyHintRow` 直接 push 会在底部露出没有底色的横带“断层”）**、`editInput`（输入编辑键统一：backspace/delete/home/end/ctrl+u/ctrl+←→按词移动/ctrl+w 删词/粘贴，grapheme 安全步进）、`renderScrollingInput`、`renderInputWithCursor`、`charIndexAtWidth`/`sliceByWidth` | 所有浮层面板 |
| `qr-code.ts` | 二维码编码与 TUI 显示：`buildQrMatrix`（同步矩阵）、`withQuietZone`、`encodeQrPngBase64`（同步 PNG，图形协议终端用）、`QrCodeView` 组件（kitty/iTerm2 走 `Image` 真图，其余字符绘制；默认半块 ▀，宿主转发 Tab 调 `toggleMode()` 切纯背景色兼容模式——缺 ▀ 字形的终端扫不出半块图；`narrowHint` 定制窄终端提示）、`createQrView` | qr（编码显示） |
| `markdown.ts` | `wrapText`（= pi-tui `wrapTextWithAnsi`）、`renderAnswer`（**渲染交给 pi-tui 的 `Markdown` 组件**：折行前解析行内样式、标题去 `#`、表格按列宽换行不截断、列表续行缩进、代码块高亮；本模块只把 theme 映射为 `MarkdownTheme`（按 theme 实例缓存）再套缩进前缀，结果按 theme+宽度+文本缓存 LRU 24 条）；`btw/render.ts` 保留同名转发 | ask 说明题、btw |
| `model-util.ts` | 纯查询：`modelTotalCost`/`isFreeModel`/`listAvailableModels`/`findConfiguredModel`/`modelHasVision`/`modelRef`/`formatModelPrice`/`formatContextWindow`（无 UI 依赖，供不弹面板的插件内联） | model-setting、model-select |
| `llm.ts` | 单次 LLM 调用公共服务：`aiComplete(ctx, chain, {systemPrompt, prompt, temperature, timeoutMs, textJoin, validate})`（认证 + 供应商会话/归因头注入 + completeSimple + 文本抽取，失败返回 `{ok:false,error}` 不抛）。`chain` = `shared/model-setting` 的解析结果（`{model, failover}`；**回退只属于 FREE 免费池**，其余策略/具体模型都是单模型）。超时按「失败代价 vs 等待代价」定：默认不设，中断靠透传 `ctx.signal`（用户 Esc）；只有失败几乎无损的增强类调用才传 `timeoutMs`（传了就用满，回退尝试吃剩余）。错误信息带模型与耗时（如「超时 6s · opencode-go/glm-5.3-flash」「已中断 · …」），便于定位。`extractAiText`（从 content blocks 抽纯文本；claude-it/context-init/explore-agent/btw 的文本抽取统一走它）、`piAttributionHeaders`（头管道单点，pi 内部 `dist/core/provider-attribution.js` 深加载，查不到降级不带头）。**不提供 `maxTokens`，也不得另开**（推理模型思考 token 计入该预算 → 正文/JSON 截断）。 | secure、hud-git、status-beacon、context-init、explore-agent、agent.ts |
| `model-setting.ts` | 插件侧模型设置唯一实现：策略常量（AUTO/FREE 固定 + MAX/FAST/LITE/BASE/BATCH 可重指）、`createModelSetting`、解析链（本地 → 中心 → 默认策略 → AUTO）、故障转移链、本地设置读改写（保留同文件其它键）、用途声明清单 `__PI_MODEL_DECLS__`、中心设置文件 `~/.pi/agent/model-config.json` 读写 | btw、explore-agent、secure、status-beacon、hud-git、context-init、model-config |
| `model-select.ts` | `ModelSelectOverlay`（可搜索模型浮层，仅 auto + 已认证模型两种取值）、`buildLocalModelItems`/`openLocalModelPicker`/`resolveSettingArg`、`registerModelConfigCommand(pi, opts)`（`/btw-config` `/explore-config` 同构工厂）；纯查询函数自 model-util 转出 | btw、explore-agent、secure、status-beacon、model-config |
| `net.ts` | `makeTimeoutSignal`（超时 + 外部取消 + cleanup）、`makeProxyConnection`（HTTP 代理 CONNECT 隧道，仅支持 `http://` 代理，TLS 目标再套 tls；原 web-tool 与 webdav-kb 逐字重复的实现收敛于此） | web-tool、webdav-kb、shared/http |
| `http.ts` | HTTP 传输层（自 web-tool 下沉，供多扩展共用；多通道降级用 `totalBudgetMs` 给**总预算**，否则最坏耗时 = 通道数 × 单通道超时）：`UA_POOL`/`browserHeaders`/`httpStatusHint`、代理配置读写（`getProxyUrl`/`setProxySetting`/`validateProxy`，持久化 `~/.pi/agent/web-fetch-proxy.json`，与 `/web-tool-config` 同一份）、`directFetch`/`proxyFetch`（Node http/https + CONNECT 隧道）/`fetchWithRetry`、`curlFetch`（系统 curl，绕过 Node TLS 指纹判死）、`decodeBody`（gbk/big5 探测）、`httpGet`/`httpGetCurl`，以及多通道降级 `fetchTextAny`/`fetchJsonAny`（**直连 → 代理 → curl 逐通道试，换通道判据是失败而非错误类型**——各站被封方式不同，按类型分类会漏）、`isWalledFailure`（「网络不可达/被墙」判定单点，webdav-kb 的 `isNetworkFailure` 是其转发） | web-tool、skill-hub、webdav-kb |
| `review-panel.ts` | 人工审核面板（通用 overlay）：`askReview`/`renderChoiceList`——分区写人话、↑↓/Enter/1-9/PgUp-PgDn/Esc 拒绝、默认高亮首项；内部处理无界面 fail-closed、并行请求串行弹窗、等待期切「正在等用户确认」状态 | dingtalk-bridge、secret（secure 自绘版复用 `renderChoiceList`） |
| `tool-result.ts` | 工具结果与失败语义：`toolText`（成功）/`toolError`（失败，带 `isError: true`）/`errorMessage`。**失败一律走 toolError 返回**——pi 只在扩展返回 isError 时原样透传 content/details；execute 抛异常会被 pi 包成 `Error: <msg>` 且丢 details（throw 只留编程错误） | 所有带工具的扩展 |
| `shell-split.ts` | `splitShellSegments`：`&&`/`||`/`;`/`|`/换行切段、`$()`/反引号递归拆出、引号与转义保护、单个 `&` 不切、**heredoc 主体是数据不逐行拆**（但主体内 `$()` 仍递归拆出）；启发式，宁多拆不漏拆 | secure |
| `presence.ts` | 跨实例「用户在场」判定 + 提示音全局去重：`getOsIdleMs()`（Windows GetLastInputInfo 常驻 PowerShell 每 2s 上报、macOS ioreg、Linux xprintidle；`PI_OS_IDLE_MS` 可注入）、一实例一文件的在场记录（`~/.pi/agent/presence/<sid>.json`，原子替换、死进程/陈旧档忽略）、`computeActive`/`computeAway`、`claimSoundSlot`（`wx` 独占创建 + 超龄回收的跨进程名额）、`disposeIdleProbe` | status-beacon |
| `explore-api.ts` | 跨扩展契约单点定义：`EXPLORE_API_KEY="__PI_EXPLORE_API__"`、`EXPLORE_API_VERSION=1`、`publishExploreApi`/`getExploreApi`（版本不符或未加载返回 null） | explore-agent 发布、context-init 消费 |
| `hud-api.ts` | hud 底部行契约单点定义：`HUD_API_KEY`/`HUD_ACTIVE_KEY`/`HudExtraRowsApi`/`getHudApi()`/`hudActive()`（生产端 hud-core 与消费端 workflow-mgr import 同一常量，不再两端各写字符串） | hud-core 挂载、workflow-mgr 消费 |
| `audio-player.ts` | 跨平台播放器候选表（Win PowerShell SoundPlayer / macOS afplay / Linux paplay→aplay）与 `firstPlayerFor(file)`：候选拼装单点，错误策略留给调用方（beacon 静默退响铃、mimo 报错给人） | status-beacon、mimo-omni |
| `context-budget.ts` | `estimateTokens`（CJK 按 1 字 1 token、ASCII 按 3.5 字符）、`pruneOldToolResults(messages, budget)`（超预算从最旧/最廉价开始把工具结果换成占位文本：read/grep/find/ls/bash → explore → 其他，write/edit 不剪，最近 10 条不动）、`CONTEXT_OVERFLOW_RE`（各家超限措辞，explore 转出） | context-init、explore-agent |
| `context-files.ts` | `CONTEXT_FILE`、`findContextFiles(cwd)`（根 + 子目录的 AGENTS.md/CLAUDE.md，跳过 node_modules/.git/dist/.tmp/vendor 与隐藏目录）、`checkContextArtifacts(cwd)`（references 死指针、SKILL.md 索引与 references 一一对应、frontmatter name/description、近乎空文件）；纯 fs、无 pi 依赖 | context-init、`test/context-init.test.mjs` |
| `pi-ignore.ts` | `.pi/.gitignore` 的自动维护：`PI_GITIGNORE`（白名单模板：`*` + 放行 `.gitignore`/`skills/`）、`ensurePiGitignore(cwd)`——仅在 git 仓库、尚无该文件、根 `.gitignore` 未整体忽略 `.pi/` 时写入（`wx` 不覆盖、异常静默）；纯 fs、无 pi 依赖 | context-init、`test/context-init.test.mjs` |
| `turndown-gfm.d.ts` | `turndown-plugin-gfm` 的类型声明 | web-tool |

## shared/ui.ts（浮层 UI 公共层）

所有浮层（ask / btw / secure / model-select / review-panel）共用这里的原语，**不允许各扩展自维护一套同类实现**——缺能力就补进 ui.ts，写得不好就改那一处。

| 原语 | 用途 |
|---|---|
| `createBoxRenderer(th, innerW)` | `╭╮│╰╯` 全封闭外框行 + 统一 `row()` 截断 |
| `renderChoiceList(th, items, selected, notes?)` | 选项竖排：选中 accent + `›`、括注灰字（secure 与 review-panel 同一份） |
| `dividerScrollNote(th, border, innerW, above, below)` | 正文区滚动余量行（`▲N ▼M（PgUp/PgDn）`，宽度走 `visibleWidth`） |
| `wrapIndented(text, width, indent)` | 按显示宽度折行 + 左缩进 |
| `clampScroll` / `scrollByPage` | 滚动窗位置（PgUp/PgDn 整页） |
| `choiceKey(data, index, count)` | 选项面板按键语义（Esc/↑↓/Enter/1-9/PgUp/PgDn），只解析意图、回调留给调用方 |
| `editInput` / `renderScrollingInput` / `pasteText` | 输入框编辑与水平滚动 |
| `ratingIndicator(th, min, max, value, focused)` | 评分行（‹ ●●○○○ 3/5 ›；ask 评分题使用） |

**宽度一律用 pi-tui 的 `visibleWidth`**（中文 2 列）：自己写 `[...str].length` 会低估一半，导致该收口时还在折行。

## shared/review-panel.ts（写操作确认面板）

钉钉敏感档与 secret 密钥确认共用这一份；secure 的确认面板是自绘版本，但选项行同样走 `renderChoiceList`。

- 布局：标题栏（dim）→ 动作·对象表头（动作 accent，对象按可用宽度塞名单、塞不下补「等 N 人」）→ 正文区（固定 `CONTENT_ROWS = 5` 行，不足补空行使面板高度稳定）→ `⚠` 影响行 → 选项竖排；无键位提示行。
- **正文先按宽度折行再取窗口**：`row()` 只按宽度截断不折行，长单行正文直出会把尾部连翻页一起丢掉；翻页按**折行后**的行数算（`bodyRows` 在 render 时更新），不足一页时 PgUp/PgDn 原地不动、也不显示滚动指示。回归测试 `shared/test/review-panel.test.mjs`。
- 内容纪律：调用方负责把 argv/ID 翻译成人话；`rememberNote`（「当前工作区不再询问」的旁标）传人能读懂的动作名，不传 cli_path 这类内部键——真正记住的键仍是 cli_path，由调用方自己保管。
- `askReview` 用模块级 Promise 链把弹窗串行化（并行工具批不会同时弹两个），`hasUI === false` 返回 `no-ui` 由调用方 fail-closed 拒绝执行。
