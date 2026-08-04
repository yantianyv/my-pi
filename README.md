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
| `extensions/` | `exit-alias.ts` — `/exit` 别名与无斜杠 `exit` 退出 | `~/.pi/agent/extensions/` |
| `templates/` | 自定义 provider / OAuth provider 模板（**不会被自动加载**） | — |
| `docs/deepseek/` | DeepSeek API / 价格 / 思考模式文档提取（适配参考） | — |

## 3 行 HUD（extensions/hud.ts）

```
⎇ main ・ 暂存1 ・ 修改2 ・ 未跟踪3               📁 my_pi
[DeepSeek] ・ deepseek-v4-flash 思考high         输入87.5k 输出125k 成本$0.076 │ 上下文[█▊        ] 1m
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
| 行2 `输入/输出` | 本会话已消耗的输入、输出 token（k=千，m=百万） |
| 行2 `成本$` | 本会话累计花费（美元） |
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
- 速率：平均每分钟消耗，启动 1 分钟后即显示（分母=实际经过分钟数，封顶 10 分钟，之后过渡为滚动平均）。消耗统计按供应商单独适配（`BalanceAdapter.rateText`）：DeepSeek / Moonshot 等按量付费显示 `¥/min + 累计`；Kimi / MiMo 等订阅制显示会话 token 消耗。DeepSeek 按官方人民币定价直算（`hud.ts` 的 `DEEPSEEK_PRICES`：缓存命中 ¥0.02/0.025、未命中 ¥1/3、输出 ¥2/6 每百万 tokens），不再经 USD×汇率；峰谷定价（高峰 2 倍）已预留开关 `DEEPSEEK_PEAK_PRICING`，官方生效后改为 true。其余供应商仍用 pi 成本(USD)×`EXCHANGE_RATE` 换算。
- 思考折叠：默认折叠（`settings.json` 的 `hideThinkingBlock: true`），折叠标签为动画 `Thinking.` → `Thinking..` → `Thinking...`（随思考过程增长），`Ctrl+T` 切换展开。
- 命令：`/balance` 手动刷新余额；`/hud` 开关 HUD；`/balance-debug` 调试当前供应商的余额接口（打印认证来源 + 原始 HTTP 响应）。

说明：DeepSeek 按量付费，余额过低变色警示；Kimi For Coding 为订阅制 + 加油包（Extra Usage）混合，优先显示加油包余额，没有加油包则显示订阅额度，订阅额度耗尽或余额过低变色警示，右下角显示会话 token 消耗；Kimi 开放平台（`moonshotai`/`moonshotai-cn`）为按量付费，显示现金 + 赠金余额；MiMo Token Plan CN（`xiaomi-token-plan-cn`）无公开余量 API，余额行显示控制台链接，右下角显示会话 token 消耗。

## /exit 别名（extensions/exit-alias.ts）

为内置 `/quit` 提供两个便捷退出方式：

- `/exit`：与 `/quit` 等效的斜杠命令。
- `exit`：直接输入 `exit`（不带 `/`）也能立即退出 pi，不会把该文本当作普通消息发送给模型。

> 注意：不带 `/` 的 `exit` 会被无条件解释为退出指令。如果你确实需要把单词 "exit" 作为普通问题发给模型，可临时加空格或换种说法，例如 `"exit" 是什么意思？`。

**新增供应商适配**：在 `hud.ts` 的 `BALANCE_ADAPTERS` 注册表里添加一个 `BalanceAdapter` 即可（参考 `deepseekAdapter` 或 `kimiCodingAdapter`）。余额/余量在 `fetch` 里实现；右下角消耗统计在 `rateText(ctx, now)` 里单独实现（按量付费用共享的 `meteredRateText`，订阅制可返回 token 消耗，不需要则返回 `null`）。

## 卸载

```bash
rm ~/.pi/agent/themes/matrix.json
rm ~/.pi/agent/extensions/hud.ts
```

（`settings.json` 里的 `"theme": "matrix"` 改回其他主题即可。）

## 说明

- `templates/` 是自定义 provider 的起步模板（OpenAI-compatible 和 OAuth），放在 `.pi/extensions/` 外避免被 pi 自动加载成假 provider；需要时把对应文件复制到 `~/.pi/agent/extensions/` 再改。
- `docs/deepseek/` 是从官网提取的原始文档文本，供 deepseek 适配开发时查价格、思考模式、API 细节。
