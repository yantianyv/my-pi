# pi 一键配置项目

把 pi 的定制配置（主题、扩展、文档）集中在这个仓库里，一条命令安装到全局。

## 快速开始

```bash
node install.js            # 安装到 ~/.pi/agent/
node install.js --dry-run  # 先预览要做什么，不修改
```

安装后重启 pi 或执行 `/reload` 生效。

## 包含内容

| 目录 | 内容 | 安装目标 |
|------|------|----------|
| `themes/` | `matrix.json` — 黑客帝国风格荧光绿主题 | `~/.pi/agent/themes/` |
| `extensions/` | `hud.ts` — 3 行 HUD 状态栏（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `claude-it.ts` — `/exit` 别名、无斜杠 `exit` 退出、Ctrl+C 取消当前 turn | `~/.pi/agent/extensions/` |
| `extensions/` | `explore-agent.ts` — `explore` 工具：只读子代理并行探索代码库、返回报告（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `task-alert.ts` — 任务完成提醒：提示音 + 状态栏闪烁 + 标题动画（见下） | `~/.pi/agent/extensions/` |
| `sounds/` | `task_complete.wav` — 任务完成提示音（钢琴音色） | `~/.pi/agent/sounds/` |
| `docs/deepseek/` | DeepSeek API / 价格 / 思考模式文档提取（适配参考） | — |

## 3 行 HUD（extensions/hud.ts）

```
⎇ main ・ 暂存1 ・ 修改2 ・ 未跟踪3               📁 my_pi
[DeepSeek] ・ deepseek-v4-pro 思考high         ↑212k ↓79.7k 12.3/s  上下文[█▊        ] 1m
余额 ¥49.09 + 10.00                        消耗≈¥0.020/min │ 17:17:35
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

git 状态每 5 秒自动刷新；`/balance` 手动刷新余额；`/hud` 开关 HUD。

**已适配的余额 / 额度供应商：**

| 供应商 | providerId | 接口 | 显示内容 |
|---|---|---|---|
| DeepSeek | `deepseek` | `GET /user/balance` | 充值余额 + 赠送余额 |
| Kimi For Coding | `kimi-coding` | `GET /v1/usages` | 加油包余额 + 订阅额度/频限 |
| Kimi 开放平台 | `moonshotai` | `GET /v1/users/me/balance` | 按量付费余额（现金 + 赠金） |
| Kimi 开放平台(CN) | `moonshotai-cn` | `GET /v1/users/me/balance` | 按量付费余额（现金 + 赠金） |
| MiMo Token Plan CN | `xiaomi-token-plan-cn` | 无 API | 显示控制台链接 |

- 余额：官方 `GET /user/balance`（DeepSeek：充值 + 赠送）或 `GET /v1/usages`（Kimi：加油包 + 订阅额度），低余额/额度耗尽变色警示。余额行精简格式：主金额 = 充值/现金余额，赠送以 `+ X.XX` 追加（无赠送省略）。
- 速率：平均每分钟消耗，启动 1 分钟后即显示（分母=实际经过分钟数，封顶 10 分钟，之后过渡为滚动平均）。消耗统计按供应商单独适配（`BalanceAdapter.rateText`）：DeepSeek / Moonshot 等按量付费显示 `¥/min + 累计`；Kimi / MiMo 等订阅制仅显示会话 token 累计。DeepSeek 按官方人民币定价直算（`hud.ts` 的 `DEEPSEEK_PRICES`：缓存命中 ¥0.02/0.025、未命中 ¥1/3、输出 ¥2/6 每百万 tokens），不再经 USD×汇率；峰谷定价（高峰 2 倍）已预留开关 `DEEPSEEK_PEAK_PRICING`，官方生效后改为 true。其余供应商仍用 pi 成本(USD)×`EXCHANGE_RATE` 换算。所有供应商在 HUD 第 2 行统一显示 `↑input ↓output rate/s` 的输出 token 速率；该速率为 EMA 平滑值（历史 80% + 新 turn 20%，首轮直接采用），基于 `output token / turn 实际耗时`，比长期平均更能反映当前生成速度，但不是严格的逐 chunk 实时流式速率。
- 思考折叠：默认折叠（`settings.json` 的 `hideThinkingBlock: true`），折叠标签为动画 `Thinking.` → `Thinking..` → `Thinking...`（随思考过程增长），`Ctrl+T` 切换展开。
- 命令：`/balance` 手动刷新余额；`/hud` 开关 HUD；`/balance-debug` 调试当前供应商的余额接口（打印认证来源 + 原始 HTTP 响应）。

说明：DeepSeek 按量付费，余额过低变色警示；Kimi For Coding 为订阅制 + 加油包（Extra Usage）混合，优先显示加油包余额，没有加油包则显示订阅额度，订阅额度耗尽或余额过低变色警示，右下角显示会话 token 累计；Kimi 开放平台（`moonshotai`/`moonshotai-cn`）为按量付费，显示现金 + 赠金余额；MiMo Token Plan CN（`xiaomi-token-plan-cn`）无公开余量 API，余额行显示控制台链接，右下角显示会话 token 累计。所有供应商都在 HUD 第 2 行统一显示输出 token 速率。

## Claude Code 风格增强（extensions/claude-it.ts）

让 pi 的操作习惯更接近 Claude Code：

- `/exit`：与 `/quit` 等效的斜杠命令。
- `exit`：直接输入 `exit`（不带 `/`）也能立即退出 pi，不会把该文本当作普通消息发送给模型。
- **Ctrl+C**：当前 turn 正在生成时，按 `Ctrl+C` 会取消该轮输出（Claude Code 风格）；空闲时不拦截，保留默认行为。

> 注意：不带 `/` 的 `exit` 会被无条件解释为退出指令。如果你确实需要把单词 "exit" 作为普通问题发给模型，可临时加空格或换种说法，例如 `"exit" 是什么意思？`。

**新增供应商适配**：在 `hud.ts` 的 `BALANCE_ADAPTERS` 注册表里添加一个 `BalanceAdapter` 即可（参考 `deepseekAdapter` 或 `kimiCodingAdapter`）。余额/余量在 `fetch` 里实现；右下角消耗统计在 `rateText(ctx, now)` 里单独实现（按量付费用共享的 `meteredRateText`，订阅制可返回 token 消耗，不需要则返回 `null`）。

## 并行探索子代理（extensions/explore-agent.ts）

类似 Claude Code 的 explore agent：注册 `explore` 工具，主 agent 只负责**分配任务**，每个任务派一个子代理自主探索并返回精炼报告——节省主上下文、降低成本（默认用廉价模型）、加快速度。

- **子代理形态**：跑 pi-agent-core 的官方 `agentLoop`，拥有 pi 官方只读工具集（`read` / `ls` / `grep` / `find`），自主决定探索路径；主 agent 不指定文件，只描述任务（如「搞清 auth 模块的登录流程，给出关键文件与函数」）。
- **模型调用**：直接走 pi 已登录的通道——认证来自 `ctx.modelRegistry.getApiKeyAndHeaders()`（含 OAuth），请求由 pi-ai 自己的 provider 实现发出，支持任意 API 类型。
- **子模型选择**：优先 `PREFERRED_MODELS`（默认 `deepseek/deepseek-v4-flash`），不可用时自动选已认证且价格最低的模型；`/explore-model` 命令可查看当前选中的子模型。
- **预算保护**：一次最多 6 个任务、3 并发、单子代理最多 12 轮 / 4 分钟超时、跟随主 agent 的 abort 信号（Ctrl+C 可中断）。
- **结果**：所有子代理的报告汇总为一个 Markdown 返回给主 agent；单任务失败不影响其他任务。

## 任务完成提醒（extensions/task-alert.ts）

pi 完全空闲（`agent_settled`，即不会再自动重试/压缩/续跑）时给出三重提醒，便于及时回来发下一步指令：

- **提示音**：播放 `sounds/task_complete.wav`（钢琴音色，移植自 ClaudeCodeInit）。跨平台：Windows 用 PowerShell `Media.SoundPlayer`，macOS 用 `afplay`，Linux 依次尝试 `paplay`/`aplay`，全部不可用时退到终端响铃；任何失败都静默；
- **状态栏闪烁**：通过 `pi.events` 官方事件总线广播 `task-alert:done`，HUD 订阅后在行 1 动态区闪烁 `✅ 任务完成` / `✨ 任务完成`（替换「会话 Nmin」占位）。两扩展零耦合——task-alert 不知道 hud 的存在；HUD 被禁用时提示自然退化为标题栏动画；
- **标题栏动画**：终端标题同步闪烁，切到其他窗口也能看到。

撤销时机：开始输入 / 新任务开始立即撤；60 秒无操作自动撤。

## 卸载

```bash
rm ~/.pi/agent/themes/matrix.json
rm ~/.pi/agent/extensions/hud.ts
rm ~/.pi/agent/extensions/claude-it.ts
rm ~/.pi/agent/extensions/explore-agent.ts
rm ~/.pi/agent/extensions/task-alert.ts
rm ~/.pi/agent/sounds/task_complete.wav
```

（`settings.json` 里的 `"theme": "matrix"` 改回其他主题即可。）

## 说明

- `templates/` 是自定义 provider 的起步模板（OpenAI-compatible 和 OAuth），放在 `.pi/extensions/` 外避免被 pi 自动加载成假 provider；需要时把对应文件复制到 `~/.pi/agent/extensions/` 再改。
- `docs/deepseek/` 是从官网提取的原始文档文本，供 deepseek 适配开发时查价格、思考模式、API 细节。
