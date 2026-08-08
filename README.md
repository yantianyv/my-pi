# pi 一键配置项目

把 pi 的定制配置（主题、扩展、文档）集中在这个仓库里，一条命令安装到全局。

> **AIGC 声明**：本项目的几乎所有代码均由 AI 生成，作者不对代码质量、正确性、安全性做任何保证；使用本项目产生的任何后果由使用者自行承担。本项目以 MIT 许可证发布（见 LICENSE）。

## 快速开始

```bash
git clone <repo> && cd <repo>
node install.js           # 一键：自动 npm install（首次，需网络）→ 构建 → 安装到 ~/.pi/agent/
node install.js --dry-run # 先预览要做什么，不修改
```

安装后重启 pi 或执行 `/reload` 生效。首次运行会自动拉取构建依赖（esbuild）并构建产物，之后每次运行都是：构建 + 安装一步到位。**伪编译架构**：源码层 `src/extensions/shared/` 共享模块（如 btw 与 explore 共用的模型选择器）在构建时内联进各扩展产物——原始代码高复用、编译产物零耦合；`src/extensions/hud/` 多文件扩展也被合并为单个 `hud.ts`（详见「伪编译架构」节）。

## 包含内容

| 目录 | 内容 | 安装目标 |
|------|------|----------|
| `themes/` | `matrix.json` — 黑客帝国风格荧光绿主题 | `~/.pi/agent/themes/` |
| `extensions/` | `hud/`（源码多文件：`index.ts` + `hud-core.ts` + `hud-balance.ts` + `hud-cost.ts` + `hud-git.ts`；build.js 合并为单文件 `hud.ts` 产物）— 3 行 HUD 状态栏，见下 | `~/.pi/agent/extensions/` |
| `extensions/` | `btf-think.ts` — 思考折叠标签动画（Thinking. → Thinking.. → Thinking... → Thinking....，独立 UI 反馈插件） | `~/.pi/agent/extensions/` |
| `extensions/` | `claude-it.ts` — `/init` 生成上下文文件、`/exit` 别名、无斜杠 `exit` 退出、Ctrl+C 取消当前 turn、双击 Ctrl+C 回退（`/rewind`） | `~/.pi/agent/extensions/` |
| `extensions/` | `explore-agent.ts` — `explore` 工具：只读子代理并行探索代码库、返回报告（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `task-alert.ts` — 任务完成提醒：提示音 + 状态栏闪烁 + 标题动画（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `btw.ts` — `/btw` 临时旁支问答：侧栏单轮问答，不写入会话历史（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `token-saver.ts` — 上下文 token 节省器：自动清洗 bash 工具冗余输出（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `web-tool.ts` — 联网工具：`web_search` 多源搜索 + `web_fetch` 抓网页转 markdown（见下） | `~/.pi/agent/extensions/` |
| `patches/` | 三个 pi 补丁：tui 滚动冻结 / ai usage 防护 / 祖冲之汉化（见下） | 打补丁到全局 node_modules |
| `sounds/` | `task_complete.wav` — 任务完成提示音（钢琴音色） | `~/.pi/agent/sounds/` |
| `models.json` | OpenRouter 路由配置模板：provider 级 `compat.openRouterRouting`（对所有 OpenRouter 模型生效；已在则深度合并，保留手改的其他 provider） | `~/.pi/agent/models.json` |

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
| explore 进度 | explore 子代理派发中，实时更新 | `🔎 2/3` | 85 |
| /init 进度 | claude-it 后台 init | `⚙ init · 5` | 80 |
| 联网搜索 | web_search 执行中 | `🔍 搜索中` | 75 |
| 网页抓取 | web_fetch 执行中 | `⬇️ 抓取中` | 74 |
| 短反馈 | 搜索完成 / explore 完成 / 模型切换 / token-saver 节省 | `🔍 5 条`、`🔎 ✓ 2/3`、`⇄ gpt-5`、`✂ 省 12.3k` | 70 |

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

- 余额：官方 `GET /user/balance`（DeepSeek：充值 + 赠送）或 `GET /v1/usages`（Kimi：加油包 + 订阅额度），低余额/额度耗尽变色警示。余额行精简格式：主金额 = 充值/现金余额，赠送以 `+ X.XX` 追加（无赠送省略）。
- 速率：平均每分钟消耗，启动 1 分钟后即显示（分母=实际经过分钟数，封顶 10 分钟，之后过渡为滚动平均）。消耗统计按供应商单独适配（`BalanceAdapter.rateText`）：DeepSeek / Moonshot / OpenRouter 等按量付费显示 `¥/min + 累计`；Kimi / MiMo 等订阅制仅显示会话 token 累计。DeepSeek 按官方人民币定价直算（`hud/cost.ts` 的 `DEEPSEEK_PRICES`：缓存命中 ¥0.02/0.025、未命中 ¥1/3、输出 ¥2/6 每百万 tokens），不再经 USD×汇率；峰谷定价（高峰 2 倍）已预留开关 `DEEPSEEK_PEAK_PRICING`，官方生效后改为 true（生效前 HUD 行 3 的「高峰/低峰」徽章仍如实显示当前时段，见上图例，仅提醒不参与计价）。其余供应商成本内部按**原始货币 USD** 记录，显示时按汇率换算 RMB。**汇率三态**（`hud/cost.ts`）：① 实时（多源拉取 frankfurter(ECB) → open.er-api，每日快照、免 key，随余额刷新 1h 节流一次）→ ② 磁盘缓存（`~/.pi/agent/tmp/exchange-rate.json`，拉取失败时读缓存）→ ③ 无汇率（断网且无缓存，显示原始货币 USD，**不使用任何固定近似汇率**）。OpenRouter 余额：有汇率时换算 RMB（明细附原始 USD + 汇率，缓存标注「(缓存)」），无汇率时直接显示 USD 原始值。所有供应商在 HUD 第 2 行统一显示 `↑input ↓output rate/s` 的输出 token 速率；该速率为 EMA 平滑值（历史 80% + 新 turn 20%，首轮直接采用），基于 `output token / turn 实际耗时`，比长期平均更能反映当前生成速度，但不是严格的逐 chunk 实时流式速率。
- 思考折叠：默认折叠（`settings.json` 的 `hideThinkingBlock: true`），折叠标签为动画 `Thinking.` → `Thinking..` → `Thinking...` → `Thinking....`（4 帧循环，随思考过程增长），`Ctrl+T` 切换展开。
- 命令：`/balance` 手动刷新余额；`/git` 打开 git 可视化面板；`/hud` 开关 HUD。
- **额外底部行接口**：通用 `__PI_HUD_API__`（`registerExtraRows(provider)` / `notifyExtraRowsUpdate()`）——workflow-mgr 等扩展注册渲染函数，hud 只把返回的行追加到 footer 底部（屏幕最底），**内容与样式由注册方决定**。当前 workflow-mgr 使用：其常驻面板内容（任务/分工/里程碑 ≈4 行，12 格进度条 + selectedBg 底色与面板同款）在底部渲染，面板隐藏；`/hud` 关闭时置 `__PI_HUD_ACTIVE__=false` 并派发 `hud:state-change`，workflow-mgr 自动注销底部行、恢复自绘面板。

说明：DeepSeek 按量付费，余额过低变色警示；Kimi For Coding 为订阅制 + 加油包（Extra Usage）混合，优先显示加油包余额，没有加油包则显示订阅额度，订阅额度耗尽或余额过低变色警示，右下角显示会话 token 累计；Kimi 开放平台（`moonshotai`/`moonshotai-cn`）为按量付费，显示现金 + 赠金余额；MiMo Token Plan CN（`xiaomi-token-plan-cn`）无公开余量 API，余额行显示控制台链接，右下角显示会话 token 累计。所有供应商都在 HUD 第 2 行统一显示输出 token 速率。

## Claude Code 风格增强（src/extensions/claude-it.ts）

让 pi 的操作习惯更接近 Claude Code：

- `/init`：对齐 Claude Code 的 `/init`——在**后台独立上下文**中分析代码库并生成上下文文件 `AGENTS.md`（独立 agentLoop + 当前会话模型，主会话零污染，期间可继续对话；状态栏显示进度，完成后通知总结）。文件已存在时会询问「合并更新 / 完全重写 / 取消」。同时兼容已有 Claude Code 项目：只有 `CLAUDE.md` 时直接重命名为 `AGENTS.md` 再继续；两者并存时合并为一份 `AGENTS.md` 并删除 `CLAUDE.md`。
- `/exit`：与 `/quit` 等效的斜杠命令。
- `exit`：直接输入 `exit`（不带 `/`）也能立即退出 pi，不会把该文本当作普通消息发送给模型。
- **Ctrl+C**：当前 turn 正在生成时，按 `Ctrl+C` 会取消该轮输出（Claude Code 风格）；空闲时不拦截，保留默认行为。打断后 2 秒内**再按一次 `Ctrl+C`**：输入框预填 `/rewind`，回车即**回退到上一条用户消息**（丢弃其后的全部内容，消息文本放回输入框，可修改后重发）——回答不满意时的快速回退；打断本身**不触发 task-alert 完成提醒**（视为中断而非完成）。
- `/rewind`：手动回退到上一条用户消息（内容放回输入框），与双击 Ctrl+C 等价。

> 注意：不带 `/` 的 `exit` 会被无条件解释为退出指令。如果你确实需要把单词 "exit" 作为普通问题发给模型，可临时加空格或换种说法，例如 `"exit" 是什么意思？`。

**新增供应商适配**：在 `hud/balance.ts` 的 `BALANCE_ADAPTERS` 注册表里添加一个 `BalanceAdapter` 即可（参考 `deepseekAdapter` 或 `kimiCodingAdapter`）。余额/余量在 `fetch` 里实现；右下角消耗统计在 `rateText(ctx, now)` 里单独实现（按量付费用 `hud/cost.ts` 共享的 `meteredRateText`，订阅制可返回 token 消耗，不需要则返回 `null`）。

## 并行探索子代理（src/extensions/explore-agent.ts）

类似 Claude Code 的 explore agent：注册 `explore` 工具，主 agent 只负责**分配任务**，每个任务派一个子代理自主探索并返回精炼报告——节省主上下文、降低成本（默认用廉价模型）、加快速度。

- **子代理形态**：跑 pi-agent-core 的官方 `agentLoop`，拥有 pi 官方只读工具集（`read` / `ls` / `grep` / `find`），自主决定探索路径；主 agent 不指定文件，只描述任务（如「搞清 auth 模块的登录流程，给出关键文件与函数」）。
- **模型调用**：直接走 pi 已登录的通道——认证来自 `ctx.modelRegistry.getApiKeyAndHeaders()`（含 OAuth），请求由 pi-ai 自己的 provider 实现发出，支持任意 API 类型。
- **子模型选择**：默认 `auto`——优先 `PREFERRED_MODELS`（默认 `deepseek/deepseek-v4-flash`），不可用时自动选已认证且价格最低的模型；`/explore-model` 可配置子模型（与 `/btw-config` 同款交互）：`auto` / `auto-not-free`（忽略免费模型）/ `provider/modelId` 固定指定，无参数打开**可搜索选择器**（↑↓ 选择、Enter 确认、Esc 取消、顶部搜索框实时过滤、当前项 ✓ 标记），设置持久化到 `~/.pi/agent/explore-model.json`，`/reload` 后保留。
- **预算保护**：一次最多 6 个任务、3 并发、单子代理最多 12 轮 / 4 分钟超时、跟随主 agent 的 abort 信号（Ctrl+C 可中断）。
- **结果**：所有子代理的报告汇总为一个 Markdown 返回给主 agent；单任务失败不影响其他任务。

## 任务完成提醒（src/extensions/task-alert.ts）

pi 完全空闲（`agent_settled`，即不会再自动重试/压缩/续跑）时给出三重提醒，便于及时回来发下一步指令；**Ctrl+C 打断（abort）不算完成，不触发提醒**：打断后 agent-loop 的最后一条 assistant 消息 `stopReason="aborted"`，task-alert 据此跳过。

- **提示音**：播放 `sounds/task_complete.wav`（钢琴音色，移植自 ClaudeCodeInit，源码在 src/sounds/）。跨平台：Windows 用 PowerShell `Media.SoundPlayer`，macOS 用 `afplay`，Linux 依次尝试 `paplay`/`aplay`，全部不可用时退到终端响铃；任何失败都静默；
- **状态栏闪烁**：通过官方 `ctx.ui.setStatus("task-alert", …)` 通道推送闪烁帧（500ms 交替 `✅ 任务完成` / `✨ 任务完成`，本扩展自管帧切换与清除），HUD 按 `STATUS_STYLE` 映射样式后在行 1 动态区闪烁（替换「会话 Nmin」占位）。两扩展零耦合——task-alert 不知道 hud 的存在；HUD 被禁用时状态自动回落原生 footer 第 3 行，提示退化为标题栏动画；
- **标题栏动画**：终端标题同步闪烁，切到其他窗口也能看到。

撤销时机：任意按键（`onTerminalInput` 原始终端按键流，无需等到发送）/ 新任务开始立即撤；10 分钟无操作自动撤。

## 上下文 Token 节省器（src/extensions/token-saver.ts）

自动清洗 bash 工具的冗余输出，节省上下文 token（0 配置，加载即生效）：

- **清洗规则**：git（status/log/diff 精简）、npm/pnpm（去安装横幅）、tsc（去重复错误头）、pip、docker、`--help` 长帮助文本；
- **截断保护**：超长输出截断后保存到 `~/.pi/agent/tmp/` 并附文件路径，需要时可 read 查看全文；
- **节省量反馈**：经官方 `ctx.ui.setStatus("token-saver", "✂ 省 Xk")` 通道推送，HUD 行 1 动态区显示（见上「短反馈」槽位），hud 缺席时回落原生 footer。

## 联网工具（src/extensions/web-tool.ts）

注册 `web_search`（多源搜索）与 `web_fetch`（抓网页转 markdown）两个自定义工具：agent 查实时信息（GitHub issue、文档、新闻、价格）时搜索，需要深读时抓取，全部**零 API key 零费用**（不依赖 kimi 订阅）。

- **`web_search` 多源搜索**：`query` + 可选 `source`（`web` 默认 / `npm` 垂类）；返回 标题+URL+摘要 列表，无 AI 总结——由主 agent 自行判断，成本为 0；
  - **通用网页**：cn.bing.com RSS 为主 + 360 搜索 HTML 备用，自动降级——bing 免费接口限流特征（连续请求后只回 1 条 item）命中即换 360（实测 360 稳定、`data-mdurl` 带真实 URL）；源顺序在文件顶部可调；
  - **npm 垂类**（`source: "npm"`）：npm registry JSON API 查包名/版本/描述/主页；pypi.org 搜索页有 Client Challenge 反爬，Python 包走默认网页搜索（如 `site:pypi.org/project/`）；
- **`web_fetch` 抓取转 markdown**：`url` + 可选 `maxChars`（默认 12000、上限 60000）；HTML 经 domino 解析 → 启发式选正文容器（article/main/常见内容 class，回退 body）→ turndown(+gfm) 转 markdown（表格/代码块/列表/引用）→ 相对链接补全为绝对 → 压缩空行/截断；非 HTML（PDF 等）与抓不到的站点（GitHub 等被墙、反爬挑战页）如实报错并提示改用搜索；
- **token 节约**：正文提取 + 截断，实测 100KB HTML 页面 → 约 800 字符 markdown；turndown/domino/gfm 由 build.js（esbuild）内联进单文件产物，运行时零外部依赖（build.js external 白名单只留 `@earendil-works/*` 与 `typebox`）；
- **可调配置**：文件顶部「可调配置」区（源顺序、结果数、超时、字节/字符上限），改后 `node install.js` 重装生效。

## 临时旁支问答（src/extensions/btw.ts）

对齐 Claude Code 的 `/btw`：主任务进行中想顺便问个小事（如「刚才为什么选这个方案」「改了哪些关键文件」），直接 `/btw <问题>` 在右侧浮层里得到回答，不打断当前任务、不污染主会话。

- **零污染**：回答在独立上下文中生成，不写入会话历史，主 agent 并行运行不受影响；
- **面板内多轮追问**：回答完成后按 `Enter` 底部弹出输入框继续问（最多 8 轮），上下文 = 主会话 + 面板内历次问答，仍独立于主会话；`Esc` 退回浏览、`↑`/`↓` 滚动查看完整记录；
- **一键转正**：按 `m` 把面板内全部 Q/A 打包，**随下一条消息附带发送**（不立即发出）——输入框只显示你正常输入的内容，HUD 常驻提示 `📎 已附带 btw 问答`（hud 关着时显示在原生 footer 第 3 行），提交下一条消息时问答自动拼接到消息末尾，随后提示消失；临时问题值得跟进时无缝升级为正式任务；
- **带上下文**：自动携带当前会话已解析的上下文（含压缩结果），能回答与当前任务相关的问题；主 agent 正在工作时，上下文**截止到最近一次用户输入**（不含未完成的 turn 和中间工具结果），避免带偏；
- **Markdown 轻量渲染**：回答区支持行内粗体/斜体/代码、`#` 标题、`-` 列表、``` 代码块、markdown 表格（列宽自适应、超宽自动压缩、表头高亮）样式，阅读更清晰；
- **只读工具常驻**：面板内始终可读文件/搜索代码（`read` / `ls` / `grep` / `find`，无 bash、只读不写），问「xx 函数在哪定义」「这个配置是干嘛的」类问题可直接查证代码，工具执行时状态行显示 `🔧 read src/a.ts`；需要跨仓库大规模探索仍建议用 `explore`，需要保留分支讨论用 `/fork`；
- **操作**：流式显示回答（含工具轮次的中间过程文本），`Esc` 关闭并中止请求；同时只允许一个面板；
- **模型可选（/btw-config）**：默认 `auto` = 当前已认证可用模型中最便宜的（input+output 单价合计，同价按 id 序），并按价格从低到高**故障转移**——最便宜模型调用失败（认证/网络/API 错误）自动换下一个更贵的模型重试，全部失败才报错；`auto-not-free` 机制相同但忽略价格 ≤ 0 的免费模型；也可 `/btw-config provider/modelId` 指定固定模型；`/btw-config` 不带参数弹出**可搜索选择器**：顶部输入框打字即实时过滤（匹配 provider/id/显示名，不区分大小写），列表展示全部已认证可用模型（价格、上下文窗口），`↑↓` 选择、`Enter` 确认、`Esc` 取消，当前设置带 ✓ 标记；面板标题栏常驻显示实际使用的模型名（auto 故障转移换模型时同步更新），开面板时 also notify 当前生效模型；设置持久化到 `~/.pi/agent/btw-config.json`，`/reload` 重载扩展后保留；
- **成本控制**：主会话上下文限最近 60 条、单条工具输出截断 1500 字符、单轮问答最多 6 轮 LLM 调用、回答上限 4096 token、面板线程限 8 轮（文件顶部可调）。
- **缓存友好（无需额外配置）**：btw 与主会话走同一序列化管线，pi-ai 自动给 system + 最后一条 user 消息打 `cache_control`（Claude Code 同款做法，缓存前缀）——btw 的系统提示词是常量、面板线程是稳定增长前缀，短时间内追问、agentLoop 多轮工具迭代都能命中 provider 前缀缓存；DeepSeek / OpenAI 兼容端点走自动前缀缓存。Anthropic 类端点可用环境变量 `PI_CACHE_RETENTION=long` 把缓存 TTL 提到 1 小时（需模型支持）。注意：“复用主会话缓存”不可行——严格前缀匹配下，btw 的序列与主会话序列不同，缓存 key 天然不重合，这是设计使然。

## 人机协作任务面板（src/extensions/workflow-mgr/）

通用工作流面板：AI 是**流程指挥者**（拆解、排序、验证、推进），你是**执行者**（做任务、拍板）。对 AI 说「帮我规划 X」，它会用 `wf_workflow` 建出阶段→任务工作流，常驻面板立刻出现——你抬眼就知道「现在该做什么」。泛化自论文工作流垂直版（thesis-workflow），工作流定义不再写死，AI 用工具动态创建，可加载任意任务。

- **数据（项目级、跨会话、可 git 审查）**：`.pi/workflow/workflow.json`（工作流定义：阶段→任务，含人机分工/交付物/完成信号/依赖）、`state.json`（进度：当前任务/任务状态/里程碑/决策/日志）、`config.json`（面板开关）；默认工作流为「搭建个人博客」最小示例，AI 会按需改造；
- **常驻面板**：输入框下方背景色区块，3~5 行——当前任务（最显眼）+ 阶段 + 右对齐进度条（`▓`实心/`░`空心，附 完成数/总数）、分工两行 `你:/AI:`、阻塞 warning 提示、里程碑三态（`▶`当前目标/`○`未完成/`✓`已完成）；宽度自适应（`visibleWidth`：中文=2 列、块元素=1 列），窗口 resize 自动重排；空工作流显示「无任务，请先让 AI 用 wf_workflow 规划」；**hud 接管**：hud 存在且开启时，面板内容改由 hud 在 footer 底部渲染（屏幕最底，任务/分工/里程碑 ≈4 行），常驻面板隐藏——经 hud 通用接口 `__PI_HUD_API__.registerExtraRows` 注册渲染函数（**内容与样式由 workflow 自决**，与常驻面板同款：12 格进度条 + selectedBg 底色，确保体验一致），`notifyExtraRowsUpdate` 请求重绘，零耦合零 import；**常驻面板开关联动**：`showPanel=false` 时 hud 底部行一并隐藏；`/hud` 关闭后自动恢复自绘面板（`hud:state-change` 事件驱动）；
- **工具（8 个）**：`wf_workflow`（list/add/edit/remove/reset——add 时 stageId 不存在自动建阶段、id 自动生成如 1.2、防依赖环；remove 同步清状态、空阶段自动移除；reset 回内置示例）、`wf_status`（当前任务+分工+交付物+完成信号+下一步+阻塞+里程碑）、`wf_start`（不填 id 自动开始下一个依赖满足的待办；对 blocked 调用即解除）、`wf_done`（先按完成信号验证再调，自动推进下一步）、`wf_block`、`wf_rollback`（回退 todo/doing，输出依赖警告清单不自动回退下游）、`wf_decision`（记录拍板）、`wf_milestone`（动态增删里程碑）；
- **命令**：`/workflow-config` 轻量功能浮窗（居中浮窗：显示详细信息/常驻面板开关，↑↓ 选择 Enter 执行 Esc 关闭；详细信息页任意键返回），快捷子命令 `toggle`、`done|start [id]`、`block <原因>`；
- **AI 角色注入**：`before_agent_start` 把「指挥者角色」指南追加进 systemPrompt（不进对话、不膨胀会话文件）：下达指令格式（📋任务/🎯目标/📌做法/✅回报/🔍验证）、完成信号验证后 `wf_done`、决策用 `wf_decision` 记录；
- **渲染回归测试**：`node src/extensions/workflow-mgr/test/render.test.mjs`（test/ 下 node_modules junction 指向 pi 全局包；esbuild bundle 扩展 + mock pi/ctx → 三态渲染断言：不抛异常、行宽不溢出、中文/空工作流/完成态、工具流程推进、toggle 持久化）。

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
rm ~/.pi/agent/extensions/explore-agent.ts
rm ~/.pi/agent/extensions/task-alert.ts
rm ~/.pi/agent/extensions/btw.ts
rm ~/.pi/agent/extensions/token-saver.ts
rm ~/.pi/agent/extensions/web-tool.ts
rm ~/.pi/agent/sounds/task_complete.wav
```

（`settings.json` 里的 `"theme": "matrix"` 改回其他主题即可；`models.json` 已并入你手改的 `~/.pi/agent/models.json`（深度合并，模板键以仓库为准），要还原需手动移除模板注入的 `providers.openrouter.compat.openRouterRouting`；三个补丁打在全局 node_modules 上，重装 pi 即还原，祖冲之汉化另有 `--restore` 一键还原英文。）

## 说明

- **伪编译架构**：`src/` 是全部源码与工具（`extensions/` 扩展源码，`shared/` 共享模块被多个扩展 import 复用，`hud/` 拆分为多文件便于维护，`package.json` + `config/` + `build.js` 为构建工具与配置）；`node src/build.js` 用 esbuild 把每个扩展入口内联打包成 `dist/extensions/` 单文件（零耦合、只依赖 pi 官方包；`hud/` 合并为 `hud.ts`）；静态资源（`static/`）无需编译，`install.js` 直接从 static/ 安装。**dist 不入库**（gitignore）：克隆后 `cd src && npm install && node install.js` 即可用；改了源码后跑 `node install.js` 一步重建+安装，改静态资源则 `--skip-build` 重装即可。
- `docs/deepseek/` 是本地参考资料（不入库，版权归 DeepSeek），供 deepseek 适配开发时查价格、思考模式、API 细节。

