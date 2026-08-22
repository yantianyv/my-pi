# pi 一键配置项目

把 pi 的定制配置（主题、扩展、文档）集中在这个仓库里，一条命令安装到全局。

> **AIGC 声明**：本项目的几乎所有代码均由 AI 生成，作者不对代码质量、正确性、安全性做任何保证；使用本项目产生的任何后果由使用者自行承担。本项目以 MIT 许可证发布（见 LICENSE）。

## 快速开始

```bash
git clone <repo> && cd <repo>
node install.js           # 一键：自动 npm install（首次，需网络）→ 构建 → 安装到 ~/.pi/agent/
node install.js --dry-run # 先预览要做什么，不修改
```

安装后重启 pi 或执行 `/reload` 生效。首次运行会自动拉取构建依赖（esbuild）并构建产物，之后每次运行都是：构建 + 安装一步到位。**伪编译架构**：源码层 `src/extensions/shared/` 共享模块在构建时内联进各扩展产物——原始代码高复用、编译产物零耦合；`src/extensions/hud/` 多文件扩展也被合并为单个 `hud.ts`（详见「伪编译架构」节）。另外 `src/vendor/` 收录三个社区官方插件源码副本（pi-subagents / pi-btw / pi-rtk-optimizer，均 MIT 原样收录含 LICENSE），install.js 一并部署（见「官方插件」节）。

## 包含内容

| 目录 | 内容 | 安装目标 |
|------|------|----------|
| `themes/` | `matrix.json` — 黑客帝国风格荧光绿主题 | `~/.pi/agent/themes/` |
| `extensions/` | `hud/`（源码多文件：`index.ts` + `hud-core.ts` + `hud-balance.ts` + `hud-cost.ts` + `hud-git.ts`；build.js 合并为单文件 `hud.ts` 产物）— 3 行 HUD 状态栏，见下 | `~/.pi/agent/extensions/` |
| `extensions/` | `btf-think.ts` — 思考折叠标签动画（Thinking. → Thinking.. → Thinking... → Thinking....，独立 UI 反馈插件） | `~/.pi/agent/extensions/` |
| `extensions/` | `claude-it.ts` — `/init` 生成上下文文件、`/exit` 别名、无斜杠 `exit` 退出、Ctrl+C 取消当前 turn、双击 Ctrl+C 回退（`/rewind`） | `~/.pi/agent/extensions/` |
| `extensions/` | `task-alert.ts` — 任务完成提醒：提示音 + 状态栏闪烁 + 标题动画（见下） | `~/.pi/agent/extensions/` |
| `vendor/` | `pi-subagents` — 子代理委派（scout/reviewer/worker/oracle 等内建角色 + FleetView 舰队面板，替代原自研 explore-agent） | `~/.pi/agent/vendor/` |
| `vendor/` | `pi-btw` — `/btw` 旁支问答（真实子会话、/btw:tangent、inject/summarize 回注，替代原自研 btw） | `~/.pi/agent/vendor/` |
| `vendor/` | `pi-rtk-optimizer` — bash 输出多阶段压缩 + rtk 命令改写（替代原自研 token-saver） | `~/.pi/agent/vendor/` |
| `extensions/` | `web-tool.ts` — 联网工具：`web_search` 多源搜索 + `web_fetch` 抓网页转 markdown（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `webdav-kb/` — 知识库（WebDAV 云网盘）：14 个 `kb_*` 工具 + `/kb` `/kb-config` `/kb-sync` 命令；本地镜像增量同步 + vault 加密 + LFS 大文件 + `/.history` 历史副本（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `webui/` — 本地 Web 界面：TUI 进程内 HTTP+SSE 服务，浏览器与 TUI 实时双向同步（聊天/状态栏/git 操作，复用 hud 模块），`/webui` 命令（见下） | `~/.pi/agent/extensions/` |
| `webui/` | `index.html` — webui 前端单页（聊天 + 状态栏，轻量自写 markdown） | `~/.pi/agent/webui/` |
| `patches/` | 三个 pi 补丁：tui 滚动冻结 / ai usage 防护 / 祖冲之汉化（见下） | 打补丁到全局 node_modules |
| `sounds/` | `task_complete.wav` — 任务完成提示音（钢琴音色） | `~/.pi/agent/sounds/` |
| `skills/` | `markitdown/` — 文档转 Markdown skill（微软 MarkItDown：PDF/Office/图片等 → md，首次使用 AI 自装） | `~/.pi/agent/skills/` |
| `models.json` | 模型配置模板：OpenRouter 路由（provider 级 `compat.openRouterRouting`）+ 火山方舟 Coding Plan 自定义供应商（见下；已在则深度合并，保留手改的其他 provider） | `~/.pi/agent/models.json` |

## OpenRouter 路由策略（models.json）

通过 `compat.openRouterRouting` 把 OpenRouter 官方 `provider` 路由参数原样透传（pi 原生支持，无需扩展代码）。当前模板用的是**软限制**方案，且配置在 **provider 级 `compat`**——pi 会把它合并进 OpenRouter 的每个模型，因此**对所有 OpenRouter 模型生效**（无需按模型逐个写）：

```jsonc
"openRouterRouting": {
  "sort": { "by": "price", "partition": "model" },
  "preferred_min_throughput": { "p50": 50 },
  "preferred_max_latency": { "p50": 3 },
  "allow_fallbacks": true
}
```

- **效果**：价格优先；能达到 p50 ≥ 50 tok/s、延迟 ≤ 3s 的提供商排前面（速度是**软约束**，不达标只降级、不失败，仍走最便宜者）。
- **透传**：整个 `openRouterRouting` 会作为请求体的 `provider` 字段发出，从而**取代 OpenRouter 默认的价格加权均衡/工具 Auto Exacto 路由**。
- **改策略**：直接改 `providers.openrouter.compat.openRouterRouting` 即可，全局生效。若只想个别模型不同，可用 `modelOverrides` 按模型 `id` 覆盖（id 须是目录里真实存在者）。
- **与认证无关**：路由配置不触碰 `auth.json` 的 API key，改完 `/reload`（或重启 pi）即生效，**无需重新登录**。
- **合并语义**：`install.js` 对已存在的 `~/.pi/agent/models.json` 做深度合并——模板里没写的键、你手改的其他 provider 都保留，模板里有的键以仓库为准（只增不删）。

## 火山引擎 Coding Plan（models.json 自定义供应商）

pi 内置供应商无火山引擎（volcengine/ark/doubao），模板通过 pi 官方自定义 provider 机制添加 `volcengine-coding`：

```jsonc
"volcengine-coding": {
  "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",  // OpenAI 兼容端点（勿用 /api/v3 按量计费端点）
  "api": "openai-completions",
  "apiKey": "$VOLCENGINE_CODING_API_KEY",
  "compat": { "supportsDeveloperRole": false },
  "models": [ { "id": "ark-code-latest", ... }, ... ]
}
```

- **配置 key**：设环境变量 `VOLCENGINE_CODING_API_KEY`（Coding Plan 专属 key，前缀 `sk-sp-`），或在 pi 里 `/login volcengine-coding` 输入。
- **模型**：`ark-code-latest`（auto 选优）+ 常用具体模型（doubao-seed-2.0-code / deepseek-v3.2 / glm-5.1 / kimi-k2.6 / minimax-m2.7），列表随官方更新可自行增删。
- **额度**：订阅制（5h 滑动窗口 + 周 + 月三级），额度在火山控制台「开通管理」页查看（Coding Plan 无 key 直查余额接口）。

## 3 行 HUD（src/extensions/hud/）

```
⎇ main ・ 暂存1 ・ 修改2 ・ 未跟踪3               📁 my_pi
[DeepSeek] ・ deepseek-v4-pro 思考high         ↑212k ↓79.7k 12.3/s  上下文[█▊        ] 1m
余额 ¥49.09 + 10.00 ・ 低峰                   消耗≈¥0.020/min │ 17:17:35
```

**图例：**

| 位置 | 含义 |
|---|---|
| 行1 `⎇ main` | git 分支（无提交时也正常显示分支名） |
| 行1 `暂存N`（绿） | 已 git add 还没 commit 的文件数 |
| 行1 `修改N`（黄） | 改过但没 add 的文件数 |
| 行1 `未跟踪N`（灰） | 新文件还没 add 的文件数 |
| 行1 `领先/落后N` | 本地比远程多/少 N 个提交 |
| 行2 `↑212k ↓79.7k 12.3/s` | 本会话已消耗的输入、输出 token + 输出 token 生成速率（tok/s，EMA 平滑：历史 80% + 新 turn 20%，首轮直接采用） |
| 行2 `上下文[█████▎] 64k` | 进度条=上下文窗口占用率（绿→黄→红），64k=窗口总量 |
| 行3 `余额 ¥49.09 + 10.00` | 账户余额（主金额=充值余额，`+ X.XX`=赠送余额，无赠送则省略） |
| 行3 `订阅 周 123/500` | 订阅额度余量（Kimi Code 周额度 / 小时频限） |
| 行3 `消耗≈¥0.020/min` | 最近 10 分钟平均每分钟消耗（仅按量付费供应商显示） |
| 行3 `・ 低峰`（绿）/ `・ 高峰`（橙黄） | DeepSeek 官方高峰/低峰时段徽章（北京时间每日 9:00-12:00 / 14:00-18:00 为高峰），挂在余额行末尾，仅显示当前状态。纯时段判断，与计价开关 `DEEPSEEK_PEAK_PRICING` 无关，仅 DeepSeek 供应商显示 |

git 状态每 5 秒自动刷新；`/balance` 手动刷新余额；`/git` 打开 git 可视化面板（分支/暂存/修改/未跟踪）；`/hud` 开关 HUD。

**行 1 动态区**（`📁 项目名` 之后，空闲时显示「会话 Nmin」占位）：各扩展经**官方 `ctx.ui.setStatus(key, text)` 通道**推送状态（setStatus 触发全局重绘，hud 零延迟可见），HUD 按样式表（颜色 + 优先级，数字大者胜出）显示一条；TTL 由各推送方自管：

| 槽位 | 触发 | 示例 | 优先级 |
|---|---|---|---|
| 指令模式 | 输入以 `!` 开头 | `⚡ 指令模式` | 100 |
| 余额查询失败 | 余额接口报错（错误变化时才推，防刷屏） | `⚠ 余额查询失败` | 95 |
| 任务完成 | task-alert 推送（自管闪烁帧） | `✅ 任务完成`（闪烁） | 90 |
| /init 进度 | claude-it 后台 init | `⚙ init · 5` | 80 |
| 联网搜索 | web_search 执行中 | `🔍 搜索中` | 75 |
| 网页抓取 | web_fetch 执行中 | `⬇️ 抓取中` | 74 |
| 短反馈 | 搜索完成 / 模型切换 | `🔍 5 条`、`⇄ gpt-5` | 70 |

各扩展只负责 `setStatus(key, text)`，不知道 hud 的存在；`key` 与样式表约定在 `hud/hud-core.ts` 的 `STATUS_STYLE`（未登记 key 默认灰字、不参与竞争）。hud 被 `/hud` 关闭时，这些状态自动回落**原生 footer 第 3 行**显示（官方 `getExtensionStatuses()` 通道），信息屏B 无缝接管。

**注意**：setStatus 是 pi 原生接口，各插件推状态**不依赖 hud**（hud 缺席时原生 footer 自动展示）；hud 兼容该通道仅做行 1 动态区呈现。hud 加载时置 `globalThis.__PI_HUD_ACTIVE__` 仅供未来真正依赖 hud 特有功能的扩展校验（当前无插件依赖，未在插件侧做存在性检测）。

**已适配的余额 / 额度供应商：**

| 供应商 | providerId | 接口 | 显示内容 |
|---|---|---|---|
| DeepSeek | `deepseek` | `GET /user/balance` | 充值余额 + 赠送余额 |
| Kimi For Coding | `kimi-coding` | `GET /v1/usages` | 加油包余额 + 订阅额度/频限 |
| Kimi 开放平台 | `moonshotai` | `GET /v1/users/me/balance` | 按量付费余额（现金 + 赠金） |
| Kimi 开放平台(CN) | `moonshotai-cn` | `GET /v1/users/me/balance` | 按量付费余额（现金 + 赠金） |
| MiMo Token Plan CN | `xiaomi-token-plan-cn` | 无 API | 显示控制台链接 |
| 火山方舟 Coding | `volcengine-coding` | 无 API | 显示控制台查询链接 |

- 余额：官方 `GET /user/balance`（DeepSeek：充值 + 赠送）或 `GET /v1/usages`（Kimi：加油包 + 订阅额度），低余额/额度耗尽变色警示。余额行精简格式：主金额 = 充值/现金余额，赠送以 `+ X.XX` 追加（无赠送省略）。
- 速率：平均每分钟消耗，启动 1 分钟后即显示（分母=实际经过分钟数，封顶 10 分钟，之后过渡为滚动平均）。消耗统计按供应商单独适配（`BalanceAdapter.rateText`）：DeepSeek / Moonshot / OpenRouter 等按量付费显示 `¥/min + 累计`；Kimi / MiMo 等订阅制仅显示会话 token 累计。DeepSeek 按官方人民币定价直算（`hud/cost.ts` 的 `DEEPSEEK_PRICES`：缓存命中 ¥0.02/0.025、未命中 ¥1/3、输出 ¥2/6 每百万 tokens），不再经 USD×汇率；峰谷定价（高峰 2 倍）已预留开关 `DEEPSEEK_PEAK_PRICING`，官方生效后改为 true（生效前 HUD 行 3 的「高峰/低峰」徽章仍如实显示当前时段，见上图例，仅提醒不参与计价）。其余供应商成本内部按**原始货币 USD** 记录，显示时按汇率换算 RMB。**汇率三态**（`hud/cost.ts`）：① 实时（多源拉取 frankfurter(ECB) → open.er-api，每日快照、免 key，随余额刷新 1h 节流一次）→ ② 磁盘缓存（`~/.pi/agent/tmp/exchange-rate.json`，拉取失败时读缓存）→ ③ 无汇率（断网且无缓存，显示原始货币 USD，**不使用任何固定近似汇率**）。OpenRouter 余额：有汇率时换算 RMB（明细附原始 USD + 汇率，缓存标注「(缓存)」），无汇率时直接显示 USD 原始值。所有供应商在 HUD 第 2 行统一显示 `↑input ↓output rate/s` 的输出 token 速率；该速率为 EMA 平滑值（历史 80% + 新 turn 20%，首轮直接采用），基于 `output token / turn 实际耗时`，比长期平均更能反映当前生成速度，但不是严格的逐 chunk 实时流式速率。
- 思考折叠：默认折叠（`settings.json` 的 `hideThinkingBlock: true`），折叠标签为动画 `Thinking.` → `Thinking..` → `Thinking...` → `Thinking....`（4 帧循环，随思考过程增长），`Ctrl+T` 切换展开。
- 命令：`/balance` 手动刷新余额；`/git` 打开 git 可视化面板；`/hud` 开关 HUD。
- **额外底部行接口**：通用 `__PI_HUD_API__`（`registerExtraRows(provider)` / `notifyExtraRowsUpdate()`）——workflow-mgr 等扩展注册渲染函数，hud 只把返回的行追加到 footer 底部（屏幕最底），**内容与样式由注册方决定**。当前 workflow-mgr 使用：其常驻面板内容（任务/分工/里程碑 ≈4 行，12 格进度条 + selectedBg 底色与面板同款）在底部渲染，面板隐藏；`/hud` 关闭时置 `__PI_HUD_ACTIVE__=false` 并派发 `hud:state-change`，workflow-mgr 自动注销底部行、恢复自绘面板。

说明：DeepSeek 按量付费，余额过低变色警示；Kimi For Coding 为订阅制 + 加油包（Extra Usage）混合，优先显示加油包余额，没有加油包则显示订阅额度，订阅额度耗尽或余额过低变色警示，右下角显示会话 token 累计；Kimi 开放平台（`moonshotai`/`moonshotai-cn`）为按量付费，显示现金 + 赠金余额；MiMo Token Plan CN（`xiaomi-token-plan-cn`）与火山方舟 Coding（`volcengine-coding`）均无公开余量 API（官方仅提供控制台查看，5h/周/月限额），余额行以灰色 OSC 8 超链接短文本显示控制台查询链接（Windows Terminal 等终端 Ctrl/⌘+点击打开；单击需 pi 端支持），完整 URL 在 `/balance` 通知里，右下角显示会话 token 累计。所有供应商都在 HUD 第 2 行统一显示输出 token 速率。

## Claude Code 风格增强（src/extensions/claude-it.ts）

让 pi 的操作习惯更接近 Claude Code：

- `/init`：对齐 Claude Code 的 `/init`——在**后台独立上下文**中分析代码库并生成上下文文件 `AGENTS.md`（独立 agentLoop + 当前会话模型，主会话零污染，期间可继续对话；状态栏显示进度，完成后通知总结）。文件已存在时会询问「合并更新 / 完全重写 / 取消」。同时兼容已有 Claude Code 项目：只有 `CLAUDE.md` 时直接重命名为 `AGENTS.md` 再继续；两者并存时合并为一份 `AGENTS.md` 并删除 `CLAUDE.md`。
- `/exit`：与 `/quit` 等效的斜杠命令。
- `exit`：直接输入 `exit`（不带 `/`）也能立即退出 pi，不会把该文本当作普通消息发送给模型。
- **Ctrl+C**：当前 turn 正在生成时，按 `Ctrl+C` 会取消该轮输出（Claude Code 风格）；空闲时不拦截，保留默认行为。打断后 2 秒内**再按一次 `Ctrl+C`**：输入框预填 `/rewind`，回车即**回退到上一条用户消息**（丢弃其后的全部内容，消息文本放回输入框，可修改后重发）——回答不满意时的快速回退；打断本身**不触发 task-alert 完成提醒**（视为中断而非完成）。
- `/rewind`：手动回退到上一条用户消息（内容放回输入框），与双击 Ctrl+C 等价。

> 注意：不带 `/` 的 `exit` 会被无条件解释为退出指令。如果你确实需要把单词 "exit" 作为普通问题发给模型，可临时加空格或换种说法，例如 `"exit" 是什么意思？`。

**新增供应商适配**：在 `hud/balance.ts` 的 `BALANCE_ADAPTERS` 注册表里添加一个 `BalanceAdapter` 即可（参考 `deepseekAdapter` 或 `kimiCodingAdapter`）。余额/余量在 `fetch` 里实现；右下角消耗统计在 `rateText(ctx, now)` 里单独实现（按量付费用 `hud/cost.ts` 共享的 `meteredRateText`，订阅制可返回 token 消耗，不需要则返回 `null`）。

## 官方插件（src/vendor/，收录社区实现）

经过与 [pi 包目录](https://pi.dev/packages) 的逐一对比（2026-08），三个自研扩展被更成熟的社区实现替代，源码原样收录进 `src/vendor/`（均 MIT，含各自 LICENSE 与出处表，对齐更新流程见 `src/vendor/README.md`）：

- **[pi-subagents](https://github.com/nicobailon/pi-subagents)**（替代 explore-agent）：子代理委派——内建 scout（代码侦察）/researcher/worker/reviewer/oracle 等角色，支持并行、后台运行、FleetView 舰队面板（`/subagents-fleet`）、`/council` 多模型议事；用自然语言即可调用（「用 scout 探索一下这个仓库」）。
- **[pi-btw](https://github.com/dbachelder/pi-btw)**（替代 btw）：`/btw` 旁支问答——真实子会话（带 read/bash/edit 工具）、`/btw:tangent` 无上下文分支、`/btw:inject` / `/btw:summarize` 回注主会话、隐藏线程跨 `/reload` 持久化、`Alt+/` 焦点切换。
- **[pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer)**（替代 token-saver）：bash/read/grep 输出多阶段压缩（ANSI 剥离、测试聚合、构建过滤、git 压缩、linter 聚合、搜索分组、截断）+ `/rtk stats` 节省统计 + `/rtk` 设置面板；命令改写委托外部 `rtk` 二进制（[rtk-ai/rtk](https://github.com/rtk-ai/rtk)，Apache-2.0，已装于 `%APPDATA%\npm\rtk.exe`，缺失时自动旁路仅留压缩）。

## 任务完成提醒（src/extensions/task-alert.ts）

pi 完全空闲（`agent_settled`，即不会再自动重试/压缩/续跑）时给出三重提醒，便于及时回来发下一步指令；**Ctrl+C 打断（abort）不算完成，不触发提醒**：打断后 agent-loop 的最后一条 assistant 消息 `stopReason="aborted"`，task-alert 据此跳过。

- **提示音**：播放 `sounds/task_complete.wav`（钢琴音色，移植自 ClaudeCodeInit，源码在 src/sounds/）。跨平台：Windows 用 PowerShell `Media.SoundPlayer`，macOS 用 `afplay`，Linux 依次尝试 `paplay`/`aplay`，全部不可用时退到终端响铃；任何失败都静默；
- **状态栏闪烁**：通过官方 `ctx.ui.setStatus("task-alert", …)` 通道推送闪烁帧（500ms 交替 `✅ 任务完成` / `✨ 任务完成`，本扩展自管帧切换与清除），HUD 按 `STATUS_STYLE` 映射样式后在行 1 动态区闪烁（替换「会话 Nmin」占位）。两扩展零耦合——task-alert 不知道 hud 的存在；HUD 被禁用时状态自动回落原生 footer 第 3 行，提示退化为标题栏动画；
- **标题栏动画**：终端标题同步闪烁，切到其他窗口也能看到。

撤销时机：任意按键（`onTerminalInput` 原始终端按键流，无需等到发送）/ 新任务开始立即撤；10 分钟无操作自动撤。

## 联网工具（src/extensions/web-tool/）

注册 `web_search`（多源搜索）与 `web_fetch`（抓网页转 markdown）两个自定义工具：agent 查实时信息（GitHub issue、文档、新闻、价格）时搜索，需要深读时抓取，全部**零 API key 零费用**（不依赖 kimi 订阅）。

- **`web_search` 多源搜索**：`query` + 可选 `source`（`web` 默认 / `npm` 垂类）；返回 标题+URL+摘要 列表（**最多 15 条**），无 AI 总结——由主 agent 自行判断，成本为 0；
  - **通用网页**：cn.bing.com RSS + 360 搜索 HTML + 百度搜索 HTML **三源并行**（baidu 块级 `mu` 属性直取真实 URL，摘要从 `s-data` 注释 JSON 解析；第三源选型实测否决：DuckDuckGo 两端点 202 反爬、Jina 不可达、Mojeek 403），结果**逐条评分合并**（不再整源择优）：标题/URL（仅 hostname+pathname，query 参数是搜索词 echo 不计）/摘要按权重逐词计分 + 完整查询短语命中强加成 + 标题全命中加成；跨源去重（URL 规范化去跟踪参数 / 标题归一化）后按分数降序取前 15 条——bing 泛化查询（如「陕西师范大学」被吞成长尾词）混入的低相关条目自然沉底，三个源的高质量条目都能入选，混合时**按来源分组展示**（`[bing]`/`[so360]`/`[baidu]` 组标题，组内分数降序、序号全局连续）；限流时 bing 只回 1 条占位，评分 0 自动滤除（实测 360 稳定、`data-mdurl` 带真实 URL）；评分权重在文件顶部可调；
  - **npm 垂类**（`source: "npm"`）：npm registry JSON API 查包名/版本/描述/主页；pypi.org 搜索页有 Client Challenge 反爬，Python 包走默认网页搜索（如 `site:pypi.org/project/`）；
- **`web_fetch` 抓取转 markdown**：`url` + 可选 `maxChars`（默认 12000、上限 60000）；HTML 经 domino 解析 → 启发式选正文容器（article/main/常见内容 class，回退 body）→ turndown(+gfm) 转 markdown（表格/代码块/列表/引用）→ 相对链接补全为绝对 → 压缩空行/截断；**GitHub blob URL 重写为 raw 直取**（blob 页行号/按钮噪音大，raw 纯文本原文直出、防源码被当 HTML 标签吞掉）；**正文极短（JS 空壳）用 Googlebot UA 重试一次**（不少 SPA 只对搜索引擎爬虫做预渲染）；非 HTML（PDF 等）与抓不到的站点如实报错并提示改用搜索；
- **被墙自动代理重试**：直连与降级**并行竞速**——直连（含换 UA）与系统 curl（自动 `-x` 代理，TLS 指纹不同可绕过 GitHub 等对 Node 的 301 挑战）同时发起，谁先成功用谁、另一条立即掐断；被墙站点 curl 秒回，不傻等直连连接黑洞超时；404 等确定性错误立即判死（任何传输方式结果相同）；两条皆失败才认定失败并聚合错误；curl 缺失时降级退 Node 内置 net/tls CONNECT 隧道（**零新增 npm 依赖**）；代理由 **`/web-tool-config`** 命令设置——无参数打开设置面板输入 `http://` 地址（Enter 保存 / Esc 取消 / 清空回车 = 清除），或 `/web-tool-config <url>` 直接设置、`/web-tool-config off` 清除、`show` 查看；设置持久化到 `~/.pi/agent/web-fetch-proxy.json`（**不读环境变量**，避免系统 HTTPS_PROXY 意外生效）；仅支持 `http://` 代理（Clash/V2Ray 等本地代理的常见形态）；web_search 的搜索请求同样享受代理降级；
- **token 节约**：正文提取 + 截断，实测 100KB HTML 页面 → 约 800 字符 markdown；turndown/domino/gfm 由 build.js（esbuild）内联进单文件产物，运行时零外部依赖（build.js external 白名单只留 `@earendil-works/*` 与 `typebox`）；
- **差评降权（动态黑名单）**：`web_dislike(domains, reason?)` 工具——AI 深读某条结果发现内容与标题不符/灌水/死链时对其域名记差评，持久化到 `~/.pi/agent/web-search-blacklist.json`（跨会话生效，**无需维护域名白名单**，降权对象由使用中自然沉淀）；搜索评分按差评次数降权（`×0.6/次`），累计 5 次直接滤除该域名条目（子域名同样受降权，父域不受）；`/web-tool-config blacklist` 查看（累计次数/降权系数/原因）、`blacklist clear` 清空；
- **可调配置**：文件顶部「可调配置」区（源顺序、结果数、超时、字节/字符上限、差评降权系数/封禁阈值），改后 `node install.js` 重装生效。

## 人机协作任务面板（src/extensions/workflow-mgr/）

通用工作流面板：AI 是**流程指挥者**（拆解、排序、验证、推进），你是**执行者**（做任务、拍板）。对 AI 说「帮我规划 X」，它会用 `wf_workflow` 建出阶段→任务工作流，常驻面板立刻出现——你抬眼就知道「现在该做什么」。泛化自论文工作流垂直版（thesis-workflow），工作流定义不再写死，AI 用工具动态创建，可加载任意任务。

- **数据（项目级、跨会话、可 git 审查）**：`.pi/workflow/workflow.json`（工作流定义：阶段→任务，含人机分工/交付物/完成信号/依赖 + 可选 `mode`：`human-ai`/`agent`）、`state.json`（进度：当前任务/任务状态/里程碑/AI 记录/日志）、`config.json`（面板开关）；**无内置示例**：从未创建过时为空工作流（常驻面板整体隐藏），AI 用 `wf_workflow` 从零创建；
- **协作模式（mode）**：工作流级可选字段，缺省 `human-ai`（AI 指挥、人执行）向后兼容；`agent` = **纯 agent 自动驾驶**（0.3 拍板）——无人类分工（`humanTasks` 可不填、渲染/简报隐藏「你:」行）、AI 用 `wf_switch` 连续推进直到全部完成并 `wf_workflow archive` 收尾，遇到无法完成的任务用 `wf_block` 标记原因停下报告；
- **常驻面板**：输入框下方背景色区块，3~5 行——当前任务（最显眼）+ 阶段 + 右对齐进度条（`▓`实心/`░`空心，附 完成数/总数）、分工两行 `你:/AI:`（多项「、」连接，agent 模式隐藏「你:」）、阻塞 warning 提示、里程碑三态（`▶`当前目标/`○`未完成/`✓`已完成）；宽度自适应（`visibleWidth`：中文=2 列、块元素=1 列），窗口 resize 自动重排；空工作流显示「无任务，请先让 AI 用 wf_workflow 规划」；**hud 接管**：hud 存在且开启时，面板内容改由 hud 在 footer 底部渲染（屏幕最底，任务/分工/里程碑 ≈4 行），常驻面板隐藏——经 hud 通用接口 `__PI_HUD_API__.registerExtraRows` 注册渲染函数（**内容与样式由 workflow 自决**，与常驻面板同款：12 格进度条 + selectedBg 底色，确保体验一致），`notifyExtraRowsUpdate` 请求重绘，零耦合零 import；**常驻面板开关联动**：`showPanel=false` 时 hud 底部行一并隐藏；`/hud` 关闭后自动恢复自绘面板（`hud:state-change` 事件驱动）；
- **工具（7 个）**：`wf_workflow`（list/import/add/edit/remove/archive/reset——**初始化优先 import**：用 write 写一份草稿 json（`{stages:[{name,goal,tasks:[{title,deps,...}]}]}`，id 自动生成如 0.1/1.2、deps 可直接引用本批未来 id）一次性导入整份计划，远比逐条 add 省 token，add 只用于已有工作流增补调整；非空时拒绝导入；add 时 stageId 不存在自动建阶段、id 自动生成如 1.2、防依赖环（导入含全图环检测带链路）；可带 `mode` 设工作流级协作模式；remove 同步清状态、空阶段自动移除；**archive 归档工作流**：可带 `status` 描述收尾状态（完成/放弃/其他），**归档 ≠ 完成**——快照保留任务真实状态、不做强制 done 标记，数据移入 `.pi/workflow/archive/` 留档可 git 审查，不提供找回功能需时手动查看；reset 清空工作流）、`wf_status`（当前任务+分工+交付物+完成信号+下一步+阻塞+里程碑+最近记录）、`wf_switch`（**推进核心**：一次调用替代 start+done——无参=完成当前任务并自动开始下一个依赖满足的任务，无下一个则全部完成；`taskId=X` 显式切换；`complete=false` 搁置当前任务回 todo 直接转移；switch 到 blocked 任务即解除阻塞；**独立审计**（借鉴 pi-goal-x completion auditor）：`.pi/workflow/config.json` 设 `auditOnComplete:true` 后，完成推进前派全新上下文的只读+bash 子代理核验完成信号（不信宣布者、自己查证据），不通过则打回任务保持 doing；审计自身故障放行——增强不是门禁）、`wf_block`（阻塞+原因）、`wf_rollback`（回退 todo/doing，输出依赖警告清单不自动回退下游）、`wf_note`（**AI 记录，对用户透明**：交流中的重要结论/约束/偏好，增删读改 {id,ts,content}，作为跨会话记忆）、`wf_milestone`（增/改/删/改名里程碑）；
- **命令**：`/workflow-config` 轻量功能浮窗（居中浮窗：显示详细信息/常驻面板开关，↑↓ 选择 Enter 执行 Esc 关闭；详细信息页任意键返回）——**只留无参**（0.4 拍板：人无需管理工作流，管理是 AI 的事）；
- **AI 角色注入（条件注入，0.2 拍板）**：`before_agent_start` 按三态把指南追加进 systemPrompt（不进对话、不膨胀会话文件）：无工作流/空工作流 → **零注入**（简单任务不被引导，AI 靠工具描述按需发现）；`human-ai` → 完整指挥者角色（下达指令格式 📋任务/🎯目标/📌做法/✅回报/🔍验证、完成信号验证后 `wf_switch`、重要结论用 `wf_note` 记录）；`agent` → 轻量自动驾驶执行者（连续 `wf_switch` 直到完成并 archive，障碍 `wf_block` 停下报告）；
- **渲染回归测试**：`node src/extensions/workflow-mgr/test/render.test.mjs`（test/ 下 node_modules junction 指向 pi 全局包；esbuild bundle 扩展 + mock pi/ctx → 15 场景 A-O：三态渲染断言、工具流程、switch 语义、mode、注入三态、wf_note 增删读改、archive 自动完成）。

## 知识库（src/extensions/webdav-kb/）

给 AI 用的云网盘（WebDAV 驱动）：AI 自发沉淀有用的东西（技术笔记、踩坑记录、参考资料摘录），需要时自发检索；本地镜像离线可用，人类用 `/kb` 面板查询引用。14 个 `kb_*` 工具 + `/kb`（检索/引用）、`/kb-config`（WebDAV/vault 口令配置）、`/kb-sync`（手动同步）三个命令。

- **四命名空间**：`/notes`（永久知识）/ `/references`（文档摘录，markitdown 产出）/ `/scratch`（临时草稿，可随时清理）/ `/vault`（加密区：需口令解锁、口令只存内存、密文仅 kb 工具可读写，口令忘了=数据永久丢失）；路径必须分层 `/命名空间/用途/自由层级/文件名`（至少 4 段，禁止命名空间/用途下放裸文件）；
- **分类层级守则（PROTOCOL.md）**：`/references` 第 2 层按文档功能**六值判定**（知识文献/规范文书/操作指南/数据名录/表单模板/素材资源，互斥判整体体裁），`/notes` 按知识主题类判定（技术笔记/研究笔记/方法总结/工作职业/生活管理/兴趣创作）；自由层级由 AI 管理（<3 个文件并入相近层、长期 <2 个文件的层并入、层级名禁项目名/来源形态/编号前缀）。守则本体 = 网盘根 `PROTOCOL.md`（跨设备同步、用户可直接编辑迭代，`kb_help` 优先读它、缺失回退内嵌默认版 protocol.ts）；`PROTOCOL.md` 对 `kb_list`/`kb_status` **不透明**（守则走 `kb_help` 专用通道，不混入内容浏览，`kb_search` 保留索引作兜底旁路）；
- **本地镜像 + 增量同步**：所有读操作（搜索/面板/AI 工具）打在本地镜像（毫秒级、离线可用）；同步账本 `.kb-sync.json` 记录 etag + 本地 mtime 快照，增量比对——远端 etag 变+本地未动→下载、本地 mtime 变+远端未动→上传、远端删+本地未动→删本地、本地删+远端未动→删远端、两侧都变→**冲突**（保留远端为权威，本地版存 `.conflict-<时间戳>` 副本、仅本地不回传）；上传前自动补齐远端父目录（MKCOL 链，123 云盘对并发 MKCOL 敏感、串行+重试最稳）；**同步健壮性**（借鉴 pi-sync）：`.kb-sync.lock` 互斥锁防多会话并发互踩（活锁拒绝、死进程/30 分钟超时安全回收）、`.kb-sync-journal.json` 记录中断阶段（成功才删除，下次同步报告并靠幂等重跑收敛）、**上传前 secret 扫描**（高精度密钥模式命中即拦截上传、本地保留，配置 `allowSecretUpload:true` 可关）、远端删除 404 幂等；**同步后自动清理本地镜像空目录**（`.kb-` 隐藏项与镜像根保留）；AI 写入（`kb_write`/`kb_append`）本地原子落盘 + 立即 PUT 远端，离线失败留账本下次同步补传；
- **只读模式**：适配 WebDAV 账号只有读权限的场景；`/kb-config` 面板切换（默认关，下次会话生效）。开启后：AI 只见只读工具（`kb_write`/`kb_append`/`kb_upload`/`kb_import`/`kb_delete`/`kb_move` 在 session_start 一次性隐藏，`kb_sync` 保留）、同步自适应为仅下载（本地删过的远端文件重新下载回本地，本地新建/修改留在本地不上传）、首次引导的 PROTOCOL.md 写入跳过；
- **全文检索**：零依赖零向量（中文 bigram 滑动窗口 + 英文分词 + BM25），增量索引持久化 `.kb-index.json`（按 mtime 只重读变更文件）；纯文本多格式（md/txt/csv/tsv/json/jsonl/yaml/yml/toml/html/xml），csv/tsv 表头加权、frontmatter 仅 md 强制；vault 未解锁时加密区内容不可见（密文仅内存索引）；
- **vault 加密区**：口令只存内存，密文落盘 `.enc` 后缀，读写经解密/加密（列表/检索按明文路径对齐）；未解锁写入报错；
- **LFS 大文件区（/lfs/）**：附加真网盘，任何类型文件、不随知识库同步、不参与检索、不加密；`kb_upload`/`kb_download`/`kb_lslfs` 独立工具，单文件上限 1GB；md 笔记引用 lfs 用纯路径文本（如「附件：lfs/xxx.png」）；人类直接用 WebDAV 客户端挂载管理；
- **`/.history` 历史副本区**：所有文件的改动（覆盖/追加）与删除自动留档——副本存 `/.history/`、目录结构与根一致、文件名加 `_yymmddhhmmss` 后缀；同秒重名叠加 `_hash`（sha1 前 8 位），`_hash` 也重名说明是同一份内容直接跳过；**自身不递归**（`/.history` 与 `/lfs/` 下文件不备份）；`.history` 不参与 `kb_list`/`kb_search`（内容浏览不透明），恢复用 WebDAV 客户端取回副本（vault 历史为密文 `.enc`，拷回 `/vault/` 对应路径后经 kb 工具解密）；备份先落本地、账本登记、**下次同步补传远端**（延迟一轮）；`kb_move` 不备份（内容未变、只是路径变化，目标被删时仍会留档）；
- **工具清单**：`kb_help`（守则，topic 按节筛选）/ `kb_search`（全文检索，namespace 限定）/ `kb_read`（读全文）/ `kb_write`（写/覆盖，需 overwrite:true，文本上限 50MB）/ `kb_append`（追加）/ `kb_list`（目录树，路径可不带前导 `/`）/ `kb_upload` `kb_download` `kb_lslfs`（LFS）/ `kb_move`（移动/重命名，镜像+远端+账本三方一致、vault 透明搬移）/ `kb_delete`（删除，需 confirm:true，先留 `.history` 副本再删）/ `kb_status`（同步状态）/ `kb_sync`（手动同步）/ `kb_import`（本地目录批量导入，导入后按守则重新归位）；
- **测试**：`node src/extensions/webdav-kb/test/sync.test.mjs`（esbuild bundle + mock DAV：增量同步全场景 + `.history` 留档/命名/去重/不递归 + 空目录清理 + PROTOCOL 过滤）、`tools.test.mjs`/`search.test.mjs`/`client.test.mjs`/`crypto.test.mjs`/`panel-config.test.mjs`/`commands.test.mjs`/`lfs.test.mjs`/`panel.test.mjs`；`live-*` 为真实网盘联调脚本（不自动跑）。

## 本地 Web 界面（src/extensions/webui/ + static/webui/）

TUI 进程内的本地 Web UI：浏览器是 pi 的**另一只眼睛和手**，与 TUI **共享同一会话、实时双向同步**——不是独立进程连 session 文件，而是 webui 扩展跑在 pi 进程内：`pi.on()` 监听全部会话/agent/tool 事件经 **SSE** 实时广播给浏览器；浏览器发消息走 `pi.sendUserMessage()` 以真实用户消息注入当前会话，TUI 聊天记录同步出现；切模型/切 thinking/中止走 pi API 与 `ctx.abort()`。

- **单端口多会话（主-从架构）**：第一个启动的 pi 进程成为**主**（host）监听配置端口（默认 7741），后续进程探测到主存在（`GET /internal/ping`）→ 成为**从**（relay），不监听端口，而是作为 HTTP 客户端接入主——事件上行（`POST /internal/event`）、命令下行（attach 长连接 SSE）；**浏览器统一访问主端口**，按 pid 路由区分会话：`http://localhost:7741/`（会话列表页，5s 轮询）、`http://localhost:7741/s/<pid>/`（某会话的聊天页）；token 配置文件全会话共享，天然单凭据；**主退出自动故障转移**：从进程断线重连失败 3 次 → 抢占端口升级为新主（谁抢到谁是主，其余继续 relay）；端口被非 webui 程序占用时退随机端口孤立模式（只服务本进程）并提示；
- **使用**：pi 内 `/reload` 后运行 `/webui` 查看本会话地址（带 token），或打开列表页挑选会话；旧无 pid 路由（`/events`、`/api/*`）301 重定向到本地会话，平滑过渡；
- **命令**：`/webui`（状态/地址/主从模式）、`/webui on|off`、`/webui port <n>`、`/webui token`、`/webui restart`、`/webui-lan`（**局域网临时开放**：独立命令无参数，执行即开启——监听 0.0.0.0，通知里给局域网地址 `http://192.168.x.x:7741/?token=…`；**会话级临时状态不持久化，pi 退出自动关闭**，下次需要重开；token 即凭据注意安全；主从架构下所有会话经主进程端口统一暴露，列表页挑选；从模式会话执行会提示去主会话；注意故障转移后新主进程不继承 lan 状态）；
- **聊天**：历史加载（sessionManager entries）+ 流式渲染（text/thinking delta）+ 工具卡片（图标映射 + spinner + 结果截断 2KB）+ 思考折叠 + **粘贴/拖拽图片**（预览缩略图可删、最多 5 张、base64 content array 注入；**非视觉模型发送前拦截并明确提示「当前模型不支持上传图片」**——预览条直接亮红色警告、发送按钮拦截，后端兜底校验；**TUI 侧可见性**：pi 渲染 user 消息时丢弃 image content（纯图片消息甚至整条不渲染），webui 在 user 消息持久化后（assistant message_start，此时 leafId 已指向该消息）追加一条**不进 LLM 上下文**的 CustomEntry（type:"custom"，buildSessionContext 忽略，挂在 user 消息下作为子节点、回退时随消息一起消失），由 `registerEntryRenderer("webui-images")` 渲染为「[N 张图片]」小标签紧跟用户消息下方——纯显示组件，**不污染发给模型的文本**）+ **斜杠命令**：输入 `/` 弹出补全面板（`pi.getCommands()` 命令列表：扩展命令/模板/skill，↑↓ 选择 Tab/Enter 补全），发送 `/` 开头消息自动带 `expandPromptTemplates: true` 分发执行（内置交互命令如 /model 不在其中，用顶栏胶囊替代）；发送固定走自动模式（空闲直发、运行中自动 steer 插队）；**消息操作**（hover 显示）：复制 / **编辑重发**（user）/ **重新生成**（assistant，向上找最近 user 消息回退）——回退经 `/webui fork <entryId>` 隐藏子命令分发 `ctx.fork`（command ctx 专属能力的间接通道：收编为 /webui 子参数而非独立命令，TUI `/` 列表零新增项；fork 触发 session 替换，前端从 SSE 的 `session_start(fork)` 事件感知、重建历史并把暂存原文填回输入框）；TUI 侧 `/tree` 回退与 `/compact` 压缩经 `session_tree`/`session_compact` 事件广播，webui 自动全量重建；message_end 广播附 `entryId`（leafId）供卡片绑定回退锚点；turn_end 顺带推状态快照（成本/git 实时更新）；
- **状态侧栏**（可折叠、localStorage 记忆）：git 面板（分支/徽章/多选文件列表 + add/reset/discard/commit/push/pull/fetch）、余额卡片（复用 `BALANCE_ADAPTERS`，60s 节流）、消耗卡片（`hud-cost` 生命周期：DeepSeek 人民币直算 + 汇率三态 + 会话时长）、会话元信息；
- **操作**：点击模型/thinking 胶囊切换、代码块复制按钮（>8KB 省略）、滚动到底悬浮钮、Esc 中止；
- **架构**：`server.ts`（主端：路由分发 + 会话注册表 + 内部通道 + 浏览器 SSE 订阅；Node 原生 http 零依赖，`requestTimeout=0` 保长连接）、`relay.ts`（从端：attach 长连接 + 命令执行回传 + 事件上行 + 指数退避重连 + 升级为主回调）、`bridge.ts`（事件桥 + pi API 操作，broadcast 注入式——host 直广播 / relay 上行）、`state.ts`（状态快照组装，复用 hud 模块）、`config.ts`（配置持久化，`PI_WEBUI_PORT` 环境变量覆盖端口——测试隔离用）；前端单文件（列表/聊天双视图按 URL 分流）；
- **安全**：仅本地回环监听 + 共享 token 鉴权（API/SSE/内部通道全校验，静态页免校验——HTML 壳无敏感数据）；
- **测试**：暂无自动化测试（主-从/SSE/图片链路靠手工联调，后续可补）。

## pi-tui 滚动冻结补丁（patches/）

修「agent 工作时滚轮上翻会被拽飞（滚到顶部）」的问题。根因：流式输出时整条消息每帧从 markdown 源码重渲染，消息开头几行持续变化；一旦滚出视口，pi-tui 判定 `firstChanged < prevViewportTop` 就整屏重绘——发 `\x1b[3J` 清空终端滚动缓冲区再全量重写，实测每秒 2~3 次，Windows Terminal 的滚动位置随之丢失。

```bash
node static/patches/apply-pi-tui-scroll-freeze.mjs   # 打补丁/升级（幂等），重启 pi 生效
```

补丁思路（同 Claude Code / Ink `<Static>`）：

1. **流式期间**：冻结视口上方已滚入滚动缓冲区的内容（保留流式中间帧），只重绘视口内可见部分，不再清空滚动缓冲。代价：滚上去看到的旧内容可能是流式中间帧，与最终渲染略有出入。
2. **内容收缩（任务完成时必现）**：消息定稿时通常会比最后流式帧收窄 1~2 行，逻辑行号位移无法局部差分，按收缩幅度分流：
   - **小幅收缩（≤1 屏）**：保持视口顶部不变，逐行 `\x1b[2K` 重写视口内全部行并清掉收缩的空行（`\x1b[1B` 下移不滚动）——不清屏、不滚动、不动滚动缓冲 → 滚动缓冲（旧帧）与可见屏（新帧）行号连续，无重叠。
   - **大幅收缩（超 1 屏或视口顶部落出内容）**：滚动缓冲里的旧帧与可见屏大量重叠且已无意义，清滚动缓冲做整屏重绘（滚动位置跳顶一次，可接受）。
   - 不用 `fullRender("screen")`（`\x1b[2J` 清可见屏 + 保留滚动缓冲 + 重写末尾一屏）的原因：Windows Terminal 的 ED2 清屏会把可见屏旧帧移入滚动缓冲，重写后滚动缓冲（旧中间帧）与可见屏（新定稿）内容重叠——任务完成时用户滚动即看到「重复绘制」。同步输出（`\x1b[?2026h`）下整屏重绘无闪烁。
3. **显式全局重建必须整屏重绘**：Ctrl+T 折叠思考、compaction、设置变更、会话切换、主题切换会重建整段对话。钳制路径只适合「流式增量」，全局重建走钳制会把视口上方旧内容冻结、新内容硬拼接（实测 Ctrl+T 后滚动缓冲里思考块 0 条可见、历史错乱）。因此补丁同时改 `interactive-mode.js` 三处（`rebuildChatFromMessages` / `renderCurrentSessionState` 尾部、`onThemeChange`），强制 `requestRender(true)` 整屏重绘重建滚动缓冲。

脚本当前为 **V4（适配 pi 0.84+）**：0.84 起差分渲染逻辑从 `pi-tui/dist/tui.js` 移到 `tui-main-screen.js`（pi-tui 为全屏模式拆出 main/alt 两个实现），`fullRender` 从类方法改为 `doRender()` 内闭包；V4 随之迁移补丁目标，并额外处理 0.84 新增的 clearOnShrink 分支（默认关，`PI_CLEAR_ON_SHRINK=1` 启用时小幅收缩也不再清滚动缓冲）。补丁覆盖 `pi-tui/dist/tui-main-screen.js` + `dist/modes/interactive/interactive-mode.js` 两个文件，幂等（已打 V4 直接跳过）。若 pi 版本变动导致匹配失败，脚本会拒绝执行并提示人工核对。

注意：补丁打在全局 `node_modules` 的 pi-tui 上，**pi 每次升级会覆盖，需重跑脚本**；若 pi-tui 版本变动导致匹配失败，脚本会拒绝执行并提示人工核对。

## pi-ai usage 缺失防护补丁（patches/apply-pi-ai-usage-guard.mjs）

修「模型偶发无文字回答」（实测 deepseek-v4-flash，/btw 面板表现为 `（无文字回答）`，主会话同理可触发）。根因：pi-ai 的 `estimate.js` 估算上下文 token 时对每条 assistant 消息调 `calculateContextTokens(assistant.usage)`，**usage 为 undefined 时抛 TypeError**（`Cannot read properties of undefined (reading 'totalTokens')`）。该异常发生在每次 LLM 调用的**请求构建阶段**（`clampMaxTokensToContext` → `estimateContextTokens` → `getLastAssistantUsageInfo`），只要 history（含主会话上下文，compaction summary 消息常缺 usage）里混入一条缺 usage 的 assistant 消息，后续调用就**瞬时失败**（1~5ms 返回 `stopReason="error"`，请求根本没发出）——这也解释了为何失败总是“瞬时”。

```bash
node static/patches/apply-pi-ai-usage-guard.mjs   # 打补丁/升级（幂等），重启 pi 生效
```

补丁内容（覆盖 pi-ai 两个文件，幂等）：

1. `pi-ai/dist/utils/estimate.js`：`calculateContextTokens` 对 usage 缺失返回 0——调用处 `> 0` 判断自然跳过该消息，与“不用缺失 usage 的消息估算上下文”语义一致（主修复）。
2. `pi-ai/dist/api/anthropic-messages.js`：`message_start` 解析 usage 处改可选链——兼容端点（如 deepseek）响应缺 usage 字段时不再抛 `'input_tokens'` 类异常（防御）。

注意：补丁打在全局 `node_modules` 的 pi-ai 上，**pi 每次升级会覆盖，需重跑脚本**；若版本变动导致匹配失败，脚本会拒绝执行并提示人工核对。

## 祖冲之汉化补丁（patches/apply-zuchongzhi-zh.mjs）

pi 无官方 i18n（settings 无 language 字段，TUI 文案硬编码在 `dist/modes/interactive/` 下）；扩展 API 只有「新增渲染」钩子（renderer 按 customType 精确匹配、markdownTransformer 只作用于消息区域），没有覆盖原生 UI（footer/菜单/对话框//settings 界面）的钩子，主题又是纯颜色 schema。汉化只能直接替换 dist 编译产物里的字符串——祖冲之算 π，π 的汉化者。

```bash
node static/patches/apply-zuchongzhi-zh.mjs             # 应用/升级（幂等），重启 pi 生效
node static/patches/apply-zuchongzhi-zh.mjs --dry-run   # 试运行（只打印将替换的数量）
node static/patches/apply-zuchongzhi-zh.mjs --restore   # 从备份还原英文
```

覆盖首批高频可见文案，**236 处 / 9 个文件**：

| 文件 | 处数 | 内容 |
|---|---|---|
| `settings-selector.js` | 75 | `/settings` 界面全部标题/描述/按钮 |
| `interactive-mode.js` | 112 | 命令反馈、usage 信息面板、警告提示 |
| `session-selector.js` | 16 | `/resume` 会话选择器 |
| `tree-selector.js` | 9 | `/tree`（标签提示 + 消息前缀） |
| `config-selector.js` | 8 | `/config` 节名（全局资源/技能/主题…） |
| `login-dialog.js` | 7 | 登录对话框 |
| `model-selector.js` | 4 | `/model` |
| `footer.js` | 4 | `no-model` / `thinking off` / `(订阅)` / `(自动)` |
| `trust-selector.js` | 1 | 项目信任 |

安全机制（逐条核对过 dist 源码上下文）：

1. **只替换双引号字符串字面量**（`quoted: false` 条目仅限模板字符串内确认无歧义的文案，如 footer 的 `thinking off`）——绝不碰 JS 标识符/属性名（踩过 `onTerminalInput:` 被 `Input:` 误伤的坑，已加引号边界修复并 diff 验证零误伤）；不碰小写 value（`"apply"`/`"save and go back"`/`"dark"` 等是配置值或下拉框返回值，替换会改行为）、颜色 key、快捷键 key、HTTP 头名。
2. **写盘前 `node --check` 语法验证**，失败不写盘并报错。
3. **自动备份 + `--restore` 一键还原**；状态与备份在 `~/.pi/agent/tmp/zuchongzhi/`。
4. **幂等（SHA256 记录）**：pi 升级覆盖 dist 后哈希变化自动重打；缺失目标串（升级后文案变动）只警告不致命，汇总列出供人工核对。

注意：补丁打在全局 `node_modules` 的 pi 上，**pi 每次升级会覆盖，需重跑脚本**；汉化不影响会话文件与 LLM 上下文（仅 TUI 显示层），还原后重启即回英文。

## 卸载

```bash
rm ~/.pi/agent/themes/matrix.json
rm ~/.pi/agent/extensions/hud.ts
rm ~/.pi/agent/extensions/btf-think.ts
rm ~/.pi/agent/extensions/claude-it.ts
rm ~/.pi/agent/extensions/task-alert.ts
rm ~/.pi/agent/extensions/web-tool.ts
rm ~/.pi/agent/extensions/webdav-kb.ts
rm ~/.pi/agent/extensions/webui.ts
rm ~/.pi/agent/extensions/workflow-mgr.ts
rm ~/.pi/agent/extensions/ask.ts
rm ~/.pi/agent/sounds/task_complete.wav
# 官方插件（vendor）：pi remove 按本地路径移除（同时清 settings.json packages 登记）
pi remove ~/.pi/agent/vendor/pi-subagents
pi remove ~/.pi/agent/vendor/pi-btw
pi remove ~/.pi/agent/vendor/pi-rtk-optimizer
rm -rf ~/.pi/agent/vendor
```

（`settings.json` 里的 `"theme": "matrix"` 改回其他主题即可；`models.json` 已并入你手改的 `~/.pi/agent/models.json`（深度合并，模板键以仓库为准），要还原需手动移除模板注入的 `providers.openrouter.compat.openRouterRouting`；三个补丁打在全局 node_modules 上，重装 pi 即还原，祖冲之汉化另有 `--restore` 一键还原英文；rtk 二进制删 `%APPDATA%\npm\rtk.exe` 即可。）

## 说明

- **伪编译架构**：`src/` 是全部源码与工具（`extensions/` 扩展源码，`shared/` 共享模块被多个扩展 import 复用，`hud/` 拆分为多文件便于维护，`package.json` + `config/` + `build.js` 为构建工具与配置）；`node src/build.js` 用 esbuild 把每个扩展入口内联打包成 `dist/extensions/` 单文件（零耦合、只依赖 pi 官方包；`hud/` 合并为 `hud.ts`）；静态资源（`static/`）无需编译，`install.js` 直接从 static/ 安装。**dist 不入库**（gitignore）：克隆后 `cd src && npm install && node install.js` 即可用；改了源码后跑 `node install.js` 一步重建+安装，改静态资源则 `--skip-build` 重装即可。
- `docs/deepseek/` 是本地参考资料（不入库，版权归 DeepSeek），供 deepseek 适配开发时查价格、思考模式、API 细节。

