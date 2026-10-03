# pi 一键配置项目

把 pi 的定制配置（主题、扩展、文档）集中在这个仓库里，一条命令安装到全局。

> **AIGC 声明**：本项目的几乎所有代码均由 AI 生成，作者不对代码质量、正确性、安全性做任何保证；使用本项目产生的任何后果由使用者自行承担。本项目以 MIT 许可证发布（见 LICENSE）。

## 快速开始

```bash
git clone <repo> && cd <repo>
node install.js           # 一键：自动 npm install（首次，需网络）→ 构建 → 安装到 ~/.pi/agent/
node install.js --dry-run # 先预览要做什么，不修改
```

安装后重启 pi 或执行 `/reload` 生效。首次运行会自动拉取构建依赖（esbuild）并构建产物，之后每次运行都是：构建 + 安装一步到位。**伪编译架构**：源码层 `src/extensions/shared/` 共享模块在构建时内联进各扩展产物——原始代码高复用、编译产物零耦合；`src/extensions/hud/` 多文件扩展也被合并为单个 `hud.ts`（详见「伪编译架构」节）。另外 `src/vendor/` 收录一个社区插件源码副本（pi-rtk-optimizer，MIT 原样收录含 LICENSE），install.js 一并部署（见「官方插件」节）。

## 包含内容

| 目录 | 内容 | 安装目标 |
|------|------|----------|
| `themes/` | `matrix.json` — 黑客帝国风格荧光绿主题 | `~/.pi/agent/themes/` |
| `extensions/` | `hud/`（源码多文件：`index.ts` + `hud-core.ts` + `hud-balance.ts` + `hud-cost.ts` + `hud-git.ts`；build.js 合并为单文件 `hud.ts` 产物）— 3 行 HUD 状态栏，见下 | `~/.pi/agent/extensions/` |
| `extensions/` | `btw/` — `/btw` 旁支问答：侧栏浮层多轮追问、`m` 转正附带、`/btw-config` 模型 auto 最便宜故障转移（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `claude-it.ts` — `/init` 生成上下文文件、`/exit` 别名、无斜杠 `exit` 退出、Ctrl+C 取消当前 turn、双击 Ctrl+C 回退（`/rewind`） | `~/.pi/agent/extensions/` |
| `extensions/` | `status-beacon.ts` — 全链路状态感知：执行中标题进度（spinner+工具活动）+ 五状态五音效 + 状态栏闪烁 + 提醒标题动画（见下；前身 task-alert） | `~/.pi/agent/extensions/` |
| `extensions/` | `perm-gate.ts` — bash 命令权限门：硬拒绝 / 关注项 / 已记住的操作（意图缓存）+ AI 审核与人工确认面板（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `web-tool.ts` — 联网工具：`web_search` 多源搜索 + `web_fetch` 抓网页转 markdown（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `explore-agent.ts` — `explore` 只读探索子代理：并行派子代理、成果渐进落盘（`.pi/explore/report.md`）、断点续跑与上下文压缩（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `clipboard.ts` — 剪贴板读写：`clipboard_get` 读取 + `clipboard_set` 写入 + `/clipboard` 命令（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `qr.ts` — 二维码：`qr_encode` 编码（显示到 UI + PNG 落盘）+ `qr_decode` 解码 + `/qr` 命令（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `img-slim.ts` — 图片请求体预算：新图按类型瘦身（照片→JPEG、图形→优先 PNG、动图 WebP 转静态）+ 每轮请求前按总量预算省略最旧历史图片（防 DeepSeek 等上游 48MiB 请求体 413）（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `crash-log.ts` — 崩溃黑匣子：崩溃堆栈同步落盘 `~/.pi/agent/pi-crash.log`，`/crash-log` 报告最近一条崩溃与取证路径（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `webdav-kb/` — 知识库（WebDAV 云网盘）：14 个 `kb_*` 工具 + `/kb` `/kb-config` `/kb-sync` 命令；本地镜像增量同步 + vault 加密 + LFS 大文件 + `/.history` 历史副本（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `mimo-omni.ts` — 媒体兼容层（过渡件）：`mimo_transcribe` 解析音频/视频（逐字稿或按需求解析）+ `mimo_speak` 文字合成语音，`/mimo-config` 面板配置（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `dingtalk-bridge.ts` — 钉钉受控桥接：屏蔽 dingtalk-* 技能注入，`dws_schema` 活内省 + `dws_exec` 受控执行（发送两阶段确认/标签强制/防重发）+ `dws_resolve_user` 人员解析（见下） | `~/.pi/agent/extensions/` |
| `patches/` | 两个 pi 补丁：ai usage 防护 / 祖冲之汉化（见下） | 打补丁到全局 node_modules |
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
⎇ main +1 ~2 ?3        🔎 探索 3/8 · 并发 4 · 已完成 2                │         📁 my_pi
[DeepSeek] deepseek-v4-pro (high)   速率 ▁▁▂▃▄▆█▅▃ 121/s              │ [█▊        ] 1m
余额 ¥49.09 +10.00 ・ 低峰            ↑212k ↓79.7k ¥0.015/min ¥1.20   │       ↻ 17:17
```

三行**三列**（中列与右列之间一条 dim 竖线，三行共用同一组栏宽、列起止对齐）：
- **左列**：git 状态 / 模型·思考级别 / 余额·峰谷
- **中列**：动态区（扩展状态，空闲时是会话时长；超长才裁 `…`）/ **速率曲线** + 当前速率 / 消耗（token 进出 + 计价与花费）
- **右列**：目录名 / 上下文进度条 / 余额刷新时刻

**图例：**

| 位置 | 含义 |
|---|---|
| 行1 `⎇ main` | git 分支（无提交时也正常显示分支名） |
| 行1 `+N`（绿） | 已 git add 还没 commit 的文件数 |
| 行1 `~N`（黄） | 改过但没 add 的文件数 |
| 行1 `?N`（灰） | 新文件还没 add 的文件数 |
| 行1 `↑N ↓N` | 本地比远程多/少 N 个提交（零值不显示；与 `/git` 面板同一套箭头） |
| 行2 速率柱状图 + `🔥28/s` | 一格 = 一轮（采样窗口 40 轮），**按速度分档上色**：`<20` 红 / `20–50` 琥珀 / `50–100` 绿 / `≥100` 青（`🔥` 数字跟当前档同色）；**亮度 = 该轮输出 token 数**（越亮 = 输出越长；对数映射 `log(1+10t)/log(11)`，t = 该轮输出 ÷ 会话内单轮输出的粘性峰值，最多向背景混 62.5%，量化 1/8 档；六档大致按输出量翻倍切分；0 输出与无采样占位为 `dim`）。**宽度 = 下面那行的消耗文本宽度 − 数字宽 − 1**，因此两行的左边缘对齐（整块右对齐到竖线）。**自适应两行 16 档**：行 1 状态右对齐、柱子贴中列左端，状态不长时柱子正上方是空的，就借来画上半行；状态长到压过来时还回位置，退回单行 8 档。0 档与冷启动占位都画最低档 ▁。**速率口径**：分子 = assistant `usage.output` 增量（供应商上报，已含思考 token），分母 = 模型生成段（`turn_start` → assistant `message_end`，含网络与首字延迟，不含工具执行）；数字取整；满格值 = 会话峰值缓慢衰减（0.5%/轮） |
| 行2 `[█▊ 1m]` | 进度条=上下文窗口占用率（绿→黄→红），尾部=窗口总量（占用率高时百分比会顶掉尾部数字，如 `[█████████▏] 90%`）。**宽度跟随右列宽度**（右列按目录名 / 刷新时刻自动缩放，上限 40 格），因此右列是一条整齐的竖带 |
| 行3 `余额 ¥49.09 + 10.00` | 账户余额（主金额=充值余额，`+ X.XX`=赠送余额，无赠送则省略） |
| 行3 `订阅 周 123/500` | 订阅额度余量（Kimi Code 周额度 / 小时频限） |
| 行3 `¥0.015/min ¥1.20` | 最近 10 分钟平均每分钟消耗（估算值）+ 本会话累计消耗，仅按量付费供应商显示（订阅制显示会话 token 数，积分制显示 🪙） |
| 行3 `↻ 17:17` | 余额数据刷新时间（不是当前时间）；在右列宽度内**居中**显示 |
| 行3 `・ 低峰`（绿）/ `・ 高峰`（橙黄） | DeepSeek / OpenCode Go 官方高峰/低峰时段徽章（北京时间每日 9:00-12:00 / 14:00-18:00 为高峰）。高峰时段按官方 2 倍计价（已生效，与徽章一致） |

git 状态每 5 秒自动刷新；`/balance` 手动刷新余额；`/git` 打开 git 可视化面板（分支/暂存/修改/未跟踪，`s` 键一键同步：fetch→pull→push，无冲突全自动，冲突时可选「让 AI 处理冲突」或「放弃同步」）；`/hud` 开关 HUD。

**行 1 动态区**（`📁 项目名` 之后，空闲时显示「会话 Nmin」占位）：各扩展经**官方 `ctx.ui.setStatus(key, text)` 通道**推送状态（setStatus 触发全局重绘，hud 零延迟可见），HUD 按样式表（颜色 + 优先级，数字大者胜出）显示一条；TTL 由各推送方自管：

| 层 | key | 触发 | 示例 | 优先级 |
|---|---|---|---|---|
| 输入态 | `hud-bash` | 输入以 `!` 开头 | `⚡ 指令模式` | 100 |
| 结果提醒 | `task-alert-error` | 出错终止（闪烁） | `❌ 任务出错` | 92 |
| | `task-alert-wait` | ui_prompt 阻塞（闪烁） | `⏳ 等待人工：权限复核` | 91 |
| | `task-alert` | 正常收尾（闪烁） | `✅ 任务完成` | 90 |
| 阻塞等人 | `perm-gate` | 命令审核中 | `🛡 正在审核命令…（≤40 秒）` | 86 |
| | `ask` | 有问卷待答（常年挂着） | `📝 1 份问卷待答 · /answer` | 84 |
| 具体活动 | `init` | `/init` 后台生成 AGENTS.md | `⚙ 初始化 · 5 步` | 80 |
| | `balance-error` | 余额接口报错 | `⚠ 余额查询失败` | 78 |
| | `img-slim` | 省略历史图片 | `🖼 34.2MB · 已省略 3 张旧图` | 76 |
| | `web-search` | `web_search` 执行中 / 完成 | `🔍 搜索中` → `✓ 搜索 8 条` | 75 |
| | `web-fetch` | `web_fetch` 执行中 / 完成 | `🌐 抓取中` → `✓ 抓取完成` | 74 |
| | `kb-sync` | 知识库同步（含后台自动同步） | `🔄 同步中` → `✓ 下载 3、上传 1` | 73 |
| | `workflow-mgr` | 工作流摘要 / 完成信号审计 | `📋 进度 3/12 · 当前：2.1 重构锁等待` | 72 |
| | `model-switch` | 模型切换（3s TTL） | `⇄ deepseek-chat` | 70 |
| | `explore` | 探索子代理进度 | `🔎 探索 3/8 · 并发 4` | 68 |
| | `qr` | 二维码生成 / 解码 | `🔳 生成中` → `✓ 二维码已显示` | 64 |
| | `kb-vault` | vault 解锁 / 口令错误 | `🔓 vault 已解锁` | 62 |
| | `clipboard` | 剪贴板读写 | `📋 读取中` → `✓ 已读取` | 61 |
| | `kb-op` | kb 工具回执（读/写/删/移/上传…共用一个键） | `✓ 已读取笔记` | 61 |
| | `btw-transfer` | btw 问答已附带进下一条消息 | `📎 已附带 btw 问答` | 60 |
| 通用兜底 | `task-alert-run` | 执行中（思考块 / 正文 / 工具） | `💭 思考中` | 58 |
| 环境信息 | `pair-guard` | 有并发 pi 会话 | `👥 2 并发会话` | 56 |

状态文案约定（同一根轴上的并列状态，尽量一眼并列）：**进行中** = `<emoji> 动作/对象 + 中`（`🔍 搜索中`、`🔎 探索 3/8`）；**成功** = `✓ 结果`（`✓ 搜索 8 条`）；**失败** = `⚠ 对象失败`（`⚠ 搜索失败`）；数字与单位之间留空格。三处语义化例外：`🔓/🔒 vault 已解锁/口令错误`（锁状态本身是信息）、`📎 已附带 btw 问答`（附件语义）、`✅/❌/⏳` 结果提醒（本身是家族标识）。`src/extensions/test/status-keys.test.mjs` 双向校验「推的 key 都登记了」+「登记的 key 都有人推」。

各扩展只负责 `setStatus(key, text)`，不知道 hud 的存在；`key` 与样式表约定在 `hud/hud-core.ts` 的 `STATUS_STYLE`（未登记的 key 平时以灰字显示，一旦有已登记状态就自动让位）。hud 被 `/hud` 关闭时，这些状态自动回落**原生 footer 第 3 行**显示（官方 `getExtensionStatuses()` 通道），信息屏B 无缝接管。

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
| Z.AI Coding CN | `zai-coding-cn` | `GET /api/monitor/usage/quota/limit` | MCP月/周/5h 积分额度条（大周期在前）+ 积分速率（🪙，不换算 ¥/$） |
| MiMo 按量付费 | `xiaomi` | 无 API | 只显示控制台查询链接 + ¥/min 消耗 |
| OpenRouter | `openrouter` | `GET /api/v1/credits` + `/api/v1/key` | 账户总余额 + 单 Key 限额进度条 |
| SenseNova Token Plan | `sensenova` | 无 API | 显示控制台链接 + 会话 token 累计（免费公测） |
| OpenCode Go | `opencode-go` | `GET /zen/go/v1/usage` | 月/周/5h 订阅额度条 + 等效消耗（¥/min，有汇率时） |

- 余额：官方 `GET /user/balance`（DeepSeek：充值 + 赠送）或 `GET /v1/usages`（Kimi：加油包 + 订阅额度），低余额/额度耗尽变色警示。余额行精简格式：主金额 = 充值/现金余额，赠送以 `+ X.XX` 追加（无赠送省略）。
- 速率：平均每分钟消耗，启动 1 分钟后即显示（分母=实际经过分钟数，封顶 10 分钟，之后过渡为滚动平均）。消耗统计按供应商单独适配（`BalanceAdapter.rateText`）：DeepSeek / Moonshot / OpenRouter 等按量付费显示 `¥/min + 累计`；Kimi / MiMo 等订阅制仅显示会话 token 累计。DeepSeek 按官方人民币定价直算（`hud/cost.ts` 的 `DEEPSEEK_PRICES`：缓存命中 ¥0.02/0.025、未命中 ¥1/3、输出 ¥2/6 每百万 tokens），不再经 USD×汇率；峰谷定价（高峰 2 倍）已按官方规则生效（HUD 行 3 的「高峰/低峰」徽章与实际计价一致，见上图例）。其余供应商成本内部按**原始货币 USD** 记录，显示时按汇率换算 RMB。**汇率三态**（`hud/cost.ts`）：① 实时（多源拉取 frankfurter(ECB) → open.er-api，每日快照、免 key，随余额刷新 1h 节流一次）→ ② 磁盘缓存（`~/.pi/agent/tmp/exchange-rate.json`，拉取失败时读缓存）→ ③ 无汇率（断网且无缓存，显示原始货币 USD，**不使用任何固定近似汇率**）。OpenRouter 余额：有汇率时换算 RMB（明细附原始 USD + 汇率，缓存标注「(缓存)」），无汇率时直接显示 USD 原始值。所有供应商在 HUD 第 2 行统一显示 `↑input ↓output rate/s` 的输出 token 速率；该速率为 EMA 平滑值（历史 80% + 新 turn 20%，首轮直接采用），基于 `output token / turn 实际耗时`，比长期平均更能反映当前生成速度，但不是严格的逐 chunk 实时流式速率。
- 思考折叠：默认折叠（`settings.json` 的 `hideThinkingBlock: true`），折叠标签为动画 `Thinking.` → `Thinking..` → `Thinking...` → `Thinking....`（4 帧循环，随思考过程增长），`Ctrl+T` 切换展开。
- 命令：`/balance` 手动刷新余额；`/git` 打开 git 可视化面板；`/hud` 开关 HUD。
- **额外底部行接口**：通用 `__PI_HUD_API__`（`registerExtraRows(provider)` / `notifyExtraRowsUpdate()`）——workflow-mgr 等扩展注册渲染函数，hud 只把返回的行追加到 footer 底部（屏幕最底），**内容与样式由注册方决定**。当前 workflow-mgr 使用：其常驻面板内容（任务/分工/里程碑 ≈4 行，12 格进度条 + selectedBg 底色与面板同款）在底部渲染，面板隐藏；`/hud` 关闭时置 `__PI_HUD_ACTIVE__=false` 并派发 `hud:state-change`，workflow-mgr 自动注销底部行、恢复自绘面板。

说明：DeepSeek 按量付费，余额过低变色警示；Kimi For Coding 为订阅制 + 加油包（Extra Usage）混合，优先显示加油包余额，没有加油包则显示订阅额度，订阅额度耗尽或余额过低变色警示，右下角显示会话 token 累计；Kimi 开放平台（`moonshotai`/`moonshotai-cn`）为按量付费，显示现金 + 赠金余额；MiMo Token Plan CN（`xiaomi-token-plan-cn`）与火山方舟 Coding（`volcengine-coding`）均无公开余量 API（官方仅提供控制台查看，5h/周/月限额），余额行以灰色 OSC 8 超链接短文本显示控制台查询链接（Windows Terminal 等终端 Ctrl/⌘+点击打开；单击需 pi 端支持），完整 URL 在 `/balance` 通知里，右下角显示会话 token 累计。Z.AI Coding CN（智谱 GLM Coding Plan）为订阅积分制：余额行画 MCP月/周/5h 三窗口额度条（大周期在前，百分比 + 5h 窗口重置倒计时），积分绝对值与套餐档位收进 `/balance` 通知；消耗统计走**积分轨**（积分视为独立货币，不换算 ¥/$，统一用 🪙 符号——`CREDIT_SYMBOL`，未来所有非货币计费复用）：因消息 usage 不含积分，turn_end / 余额刷新时采样 quota 接口的「5h 窗口已用积分」做差分（30s 节流；负增量/窗口滚动仅换基线不记增量），显示 `🪙X.XX/min + 🪙累计`（采样接口不可用时自动回落为会话 token 数）。数字与颜色解耦：🪙 数字只反映额度消耗速率，颜色按 pi 内置 provider 价格（`usage.cost.total`，USD 等效成本）的速率染色——积分/min 高 ≠ 花钱多，成本速率才是价格信号。所有供应商都在 HUD 第 2 行统一显示输出 token 速率。

## Claude Code 风格增强（src/extensions/claude-it.ts）

让 pi 的操作习惯更接近 Claude Code：

- `/init`：对齐 Claude Code 的 `/init`——在**后台独立上下文**中分析代码库并生成上下文文件 `AGENTS.md`（独立 agentLoop + 当前会话模型，主会话零污染，期间可继续对话；状态栏显示进度，完成后通知总结；不设轮数与时间上限，`/init cancel` 随时中止；打算停下却没写入文件、或末句是意图陈述时会被自动顶回去做完）。文件已存在时会询问「合并更新 / 完全重写 / 取消」。同时兼容已有 Claude Code 项目：只有 `CLAUDE.md` 时直接重命名为 `AGENTS.md` 再继续；两者并存时合并为一份 `AGENTS.md` 并删除 `CLAUDE.md`。探索子代理插件在场时，子代理可自行派 explore 并行摸底大仓库（未装/被禁用则退回自读；详见「探索子代理」一节）。产出物按**提示词纪律**约束：只写能改变 AI 行为的「不写就会做错」的信息，不写变更史、实现解释、README 里能自行读到的内容（`AGENTS.md` 每轮对话都会加载，字数即长期成本）；已存在时允许压缩冗余（事实与约定一条不丢，只是表达变短）。**上下文分层**：`AGENTS.md` 只留每轮都用得上的（命令、目录职责、不变量、约定、坑），子系统细节成段超载时下沉为项目 skill `.pi/skills/<项目名>-dev/`（`SKILL.md` + `references/`，启动只暴露一行描述、按需加载；首次使用会弹一次项目信任确认），README/docs 只留一行指路；写完后由全新上下文的**审计子代理**按验收清单复核修正。
- `/exit`：与 `/quit` 等效的斜杠命令。
- `exit`：直接输入 `exit`（不带 `/`）也能立即退出 pi，不会把该文本当作普通消息发送给模型。
- **Ctrl+C**：当前 turn 正在生成时，按 `Ctrl+C` 会取消该轮输出（Claude Code 风格）；空闲时不拦截，保留默认行为。打断后 2 秒内**再按一次 `Ctrl+C`**：输入框预填 `/rewind`，回车即**回退到上一条用户消息**（丢弃其后的全部内容，消息文本放回输入框，可修改后重发）——回答不满意时的快速回退；打断本身**不触发 status-beacon 完成提醒**（视为中断而非完成）。
- `/rewind`：手动回退到上一条用户消息（内容放回输入框），与双击 Ctrl+C 等价。

> 注意：不带 `/` 的 `exit` 会被无条件解释为退出指令。如果你确实需要把单词 "exit" 作为普通问题发给模型，可临时加空格或换种说法，例如 `"exit" 是什么意思？`。

**新增供应商适配**：在 `hud/balance.ts` 的 `BALANCE_ADAPTERS` 注册表里添加一个 `BalanceAdapter` 即可（参考 `deepseekAdapter` 或 `kimiCodingAdapter`）。余额/余量在 `fetch` 里实现；右下角消耗统计在 `rateText(ctx, now)` 里单独实现（按量付费用 `hud/cost.ts` 共享的 `meteredRateText`，订阅制可返回 token 消耗，不需要则返回 `null`）。

## 旁支问答（src/extensions/btw/）

Claude Code 风格 `/btw` 临时旁支问答（by the way）：主任务进行中打开右侧浮层做临时问答，不写入会话历史、主会话零污染：

- **`/btw <问题>`**：打开浮层立即提问；面板内可多轮追问（Enter 输入，最多 6 轮），上下文 = 主会话（含压缩结果）+ 面板内历次问答；流式显示回答，`Esc` 关闭并中止，`↑↓` 滚动查看
- **`m` 转正**：面板内按 `m` 把全部问答打包暂存，随下一条交互消息附带发送（输入框只见自己文本 + 「📎 已附带」提示，不立即发出，可控可撤）
- **只读工具**：始终携带 read / ls / grep / find（无 bash）——「xx 函数在哪定义」类问题可直接查证代码，只读不写
- **`/btw-config`**：模型选择——默认 auto = 已认证可用模型中最便宜的，按价格顺序故障转移（调用失败自动换下一个更贵的重试）；另有 auto-not-free 与任意 provider/modelId 可选，支持关键词搜索；持久化到 `~/.pi/agent/btw-config.json`

实现：问答跑 pi-agent-core 官方 agentLoop（与 /init 子代理同构），认证走 `ctx.modelRegistry.getApiKeyAndHeaders()`；消息序列全量降级清洗（toolResult 降 user、剥 tool_use/thinking、合并同角色、保证 user 结尾），兼容 OpenAI/Anthropic 两类端点；浮层走 `ctx.ui.custom` overlay 模式。曾收录官方 pi-btw 替代（2026-08-22），实测多轮追问/上下文携带有 bug 于 2026-09-07 回退自研版（出处与借鉴评估见 `src/vendor/README.md` 回退记录）。

## 官方插件（src/vendor/，收录社区实现）

目前仅收录 **[pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer)**（替代 token-saver）：bash/read/grep 输出多阶段压缩（ANSI 剥离、测试聚合、构建过滤、git 压缩、linter 聚合、搜索分组、截断）+ `/rtk stats` 节省统计 + `/rtk` 设置面板；命令改写委托外部 `rtk` 二进制（[rtk-ai/rtk](https://github.com/rtk-ai/rtk)，Apache-2.0，单 Rust 二进制零依赖）。rtk 不入库，由 install.js 按平台自动安装（当前 `v0.48.0`：`process.platform` + `process.arch` 现场探测选 release 资产——win32-x64 / darwin-arm64+x64 / linux-x64(musl)+arm64；GitHub 直连优先、`gh-proxy.com` 镜像回落、`checksums.txt` sha256 校验；Windows 装 `%APPDATA%\npm\`，Unix 优先 `~/.local/bin`，否则 `~/.pi/agent/bin/` 并提示加 PATH；任何失败只警告不阻塞，缺失时插件自动旁路仅留压缩）。

其余两个曾收录的包均已回退自研版（pi-subagents → explore-agent，2026-08-30；pi-btw → btw，2026-09-07），出处与借鉴评估见 `src/vendor/README.md` 回退记录。

## 全链路状态感知（src/extensions/status-beacon.ts，前身 task-alert）

**执行中标题进度**（2026-09 新增，全链路「进行中」段）：`agent_start` → `agent_settled` 全程在终端标题显示 spinner（200ms 转帧）+ 当前活动 + 目录名，**活动段与 Working 行、HUD 行 1 用同一套词**：工具执行 `⠋ ⌨️ bash — my_pi`、思考块流式 `⠋ 思考中 — my_pi`、正文生成 `⠋ 输出中 — my_pi`、块间隙只显目录 `⠋ my_pi`；等待人工提醒期间让位、应答后自动恢复；Ctrl+C 打断（abort）时还给 pi 默认标题。切到其他窗口也能从任务栏/标签页看到 pi 在跑什么。

提示音与收尾提醒移植自 ClaudeCodeInit 的 hooks 提示音方案，五种状态五种音效（钢琴音色，音源 `ClaudeCodeInit/wav/piano/`，部署到 `~/.pi/agent/sounds/`）：

| 状态 | 触发时机 | 音效 | 视觉 |
|---|---|---|---|
| 任务完成 | `agent_settled` 正常结束（不会再自动重试/压缩/续跑） | `task_complete.wav` | 状态栏 + 标题动画（✅/✨ 闪烁） |
| 任务出错 | `agent_settled` 且末条 assistant `stopReason="error"` | `error.wav` | 状态栏 + 标题动画（❌/⚠️ 闪烁，HUD 红色） |
| 等待人工 | `ui_prompt_start`（pi 0.84.4 新增事件）且 agent 运行中被阻塞——perm-gate 人工确认、ask 问卷等 | `attention.wav` | 状态栏 + 标题动画（⏳/🔔 闪烁，HUD 黄色，附提示标题）；**应答（`ui_prompt_end`）自动撤，按键不撤**（用户需要按键回答提示本身） |
| 空闲提醒 | 完成提醒后 60 秒仍无人应答**且判定人已离开** | `idle_prompt.wav` | 仅补一声，不动视觉 |
| 子代理完成 | 子代理工具成功结束（`explore` / `subagent` / `Task`，`tool_execution_end` 且 `!isError`） | `subagent_complete.wav` | 仅提示音（中间事件，不打断标题/状态；失败交给 turn 级 error 统一收尾） |

**提示音的在场门控（跨实例协调，`shared/presence.ts`）**：提示音不再由单个实例说了算，避免「人明明在电脑前却被提示音打断」和「多个 pi 同时收尾变成提示音交响乐」：

- **系统级空闲**：Windows 用 `GetLastInputInfo`（常驻 PowerShell 进程每 2s 上报，不反复起进程）、macOS 用 `ioreg HIDIdleTime`、Linux 用 `xprintidle`；取不到时退用跨实例信号；
- **跨实例输入**：每个 pi 实例把自己的「最后一次用户输入时刻」写进 `~/.pi/agent/presence/<sessionId>.json`（一实例一文件、原子替换，无写冲突；死进程/陈旧档自动忽略），判定取所有活实例里最近的一次；
- **判定**：系统空闲 < 20s（或任一实例 20s 内有输入）→ 判为**人在操作**，只闪标题不出声；所有信号都超过 5 分钟 → 判为**已离开**，第二声空闲提醒才会响；
- **全局去重**：出声前抢一次跨进程名额（独占创建 + 超龄回收），多实例同时收尾**只有第一个出声**，视觉提醒仍各窗口各闪；
- 查看与调参：`/beacon status` 报告当前判定与读数；阈值可在 `~/.pi/agent/status-beacon.json` 覆盖（`presenceGate:false` 关闭门控、`activeIdleMs` / `awayIdleMs` / `dedupeMs`）。

**执行中动画的位置**：终端标题的 spinner（200ms 转帧）由本扩展驱动；**Working 行行首那支转圈是 pi 指示器自带的**（默认盲文帧 80ms），本扩展只提供文案——文案里不再拼第二支 spinner。pi 的折叠思考标签不再被改写，交回默认静态 `Thinking...`。

**Working 行分层**（`等人工 > 等工具 > 思考中 > 正在做什么`）：
| 阶段 | 文案 |
|---|---|
| 等你回答（问卷 / 权限复核） | `等你：回答问卷「方案确认」` |
| 工具执行中 | `等 ⌨️ bash 完成…`（工具名带图标） |
| 思考块流式中（有概括短语） | `思考中：重构 HUD 余额模块…` |
| 思考块流式中（无短语） | `思考中…` |
| 正文生成中（有概括短语） | `正在重构 HUD 余额模块…` |
| 正文生成中（无短语） | `正在输出…` |
| 内容块间隙 / 收尾 | `工作中…` |

**「思考」的边界**：严格等于思考块流出的那段时间（`message_update` 的 `thinking_start` → `thinking_end`）。思考块结束后的正文生成算「输出」、工具执行算「等 X 完成」——思考块之外的时间不会显示「思考中」。

同一状态同步推 HUD 行 1 动态区（key `task-alert-run`）：`💭 思考中`（思考块流式）/ `✍️ 输出中`（正文生成）/ 工具名（执行中），块间隙与收尾不显状态；优先级 58，低于通知、同步、抓取等具体活动状态——有具体事在发生时优先显具体事。

**Ctrl+C 打断（abort）不算完成，不触发提醒**：打断后 agent-loop 的最后一条 assistant 消息 `stopReason="aborted"`，status-beacon 据此跳过。「等待人工」有 `ctx.isIdle()` 守卫：用户空闲时主动开的提示（如 `/answer` 续答问卷）不打扰。

- **状态栏闪烁**：三种需要视觉的状态各用独立 key 走官方 `ctx.ui.setStatus(key, …)` 通道（`task-alert` / `task-alert-error` / `task-alert-wait` 三个 key 沿用旧名（另有执行中状态 `task-alert-run`，不闪烁、agent 收尾即撤），HUD STATUS_STYLE 零改动；500ms 交替帧，本扩展自管帧切换与清除），HUD 按 `STATUS_STYLE` 映射不同颜色后在行 1 动态区闪烁。两扩展零耦合——status-beacon 不知道 hud 的存在；HUD 被禁用时状态自动回落原生 footer 第 3 行，提示退化为标题栏动画；
- **标题单通道所有权**：执行中标题与提醒标题互斥（startAlert 停执行标题，stopAlert 在 agent 仍运行时恢复执行标题），两动画不互相覆盖；
- **音频播放**：跨平台——Windows 用 PowerShell `Media.SoundPlayer`，macOS 用 `afplay`，Linux 依次尝试 `paplay`/`aplay`，全部不可用时退到终端响铃；任何失败都静默；
- **标题栏动画**：终端标题同步闪烁，切到其他窗口也能看到。

撤销时机（完成/出错）：任意按键（`onTerminalInput` 原始终端按键流，无需等到发送）/ 新任务开始立即撤；10 分钟无操作自动撤。

## 命令权限门（src/extensions/perm-gate.ts）

bash 命令三层名单（`tool_call` 事件拦截，只管 bash）：**复合命令先拆段**（`shared/shell-split.ts`：按 `&&`/`||`/`;`/`|`/换行拆分，`$()`/反引号子 shell 递归拆出，引号/转义保护）→ **硬拒绝 deny**（命中即拒、不询问，默认覆盖 `rm -rf /`、`mkfs`、`dd` 写块设备、`curl|sh`、`chmod -R 777 /`）→ **已记住的操作 remembered**（**逐段判定：每个子命令段都要命中才放行**，防「git status && rm -rf x」被前半段连带放行）→ **关注项 watch**（命中不打断，只是把命令标记给 AI 要求从严：宁可确认一次也别放过）→ **AI 审核**（未命中名单的命令交给辅助小模型；AI 不可用——超时/无模型/网络错误/输出无法解析——降级为人工确认，文案说明是降级而非任务失败）。

- **人工确认面板**（`perm-gate` 自有 `ReviewPanel`；**选项渲染复用 `shared/ui.ts` 的 `renderChoiceList`**，与钉钉审核面板同一套竖排样式）：**默认高亮「允许一次」**，三选项——允许一次 / 允许并永久记住这类操作（旁标将被记住的操作意图）/ 拒绝，`Esc` = 拒绝（不执行）；`↑↓` 选择、`Enter` 确认、`1-3` 直选。面板顶部是**人话信息区**（不随滚动消失）：AI 一句话解读 + 影响面（写/删/联网/凭证等）+ 命中原因（「命中关注项」等分类标签，**不展示正则原文**）；命令全文折行展示不截断，超出可视区 PgUp/PgDn 滚动，滚动余量在分隔行指示；并行工具批里多个待确认命令经 Promise 链串行弹面板。无可泛化规则时只剩两项（允许一次 / 拒绝）。
- **allow 自动记住意图**（意图缓存，避免常用无害命令反复烧审核 token）：AI 每次 `allow` 都会把「这类操作」写进 `remembered`——规则优先生效 AI 提炼的语义正则（用 `<*>` 占位可变参数，落库前校验必须能命中当前命令，否则退结构化兜底 `^命令\s+子命令`，多段命令退整串精确匹配）；护栏：硬拒绝/关注项永远优先、去重、不覆盖已有规则；每次记住都发通知且**展示人话意图而非正则**（如「已记住「查看 git 提交历史」，以后同类命令直接放行」）；**保鲜机制**：记忆规则带 `addedAt`/`lastHit`/`hits`，命中时刷新，超 30 天未命中在启动/记住时自动清理，`/perm-gate prune` 手动清理（**过期≠失效：清理前仍生效**，状态行会写明）；旧配置（`blacklist`/`whitelist`）自动迁移为 `watch`/`remembered`。
- **AI 审核**：选模型仿 pi-btw 覆盖项语义——`/perm-gate model` 打开**官方模型选择面板**（`shared/model-selector.ts` 直接复用 pi 导出的 `ModelSelectorComponent`，与内置 `/model` 同组件：搜索/scoped 切换/目录刷新；`ModelRegistry.runtime` 直通组件所需的 ModelRuntime），`/perm-gate model <provider>/<id>|auto` 直接设置；未覆盖时走共享模块 `shared/model-pick.ts` 自动选（与 hud-git 的 AI 提交信息同款「优先列表 + 最便宜已认证兜底」，优先 `deepseek/deepseek-v4-flash`），覆盖模型不可用/未认证时自动回落；`completeSimple` 单次调用不占主会话上下文；进度经官方 `setStatus("perm-gate", …)` 通道推送（hud 行 1 动态区，未登记 key 默认灰字）；allow/reject 结论会话级缓存（同一精确命令不重复审核），review 不缓存（每次由人决定）；
- **sudo 授权通道（密码即授权，仅当次有效）**：AI 在 bash 里直接写 `sudo` 会被拦截打回并引导改用 `sudo_exec` 工具（`command` 不带 sudo 前缀，整条以 root 执行）；调用时弹整屏授权面板——命令全文折行展示（PgUp/PgDn 滚动）+ 掩码密码框（提示写明「密码仅用于本次执行，每次提权都需重新输入」），Enter 授权 / Esc 拒绝，密码错误原地重试共 3 次；扩展内 `sudo -kS` 从 stdin 喂密执行，`-k` 使凭据不被缓存（收尾再补 `sudo -k` 双保险），**每次调用必重新弹窗授权**；密码只经扩展内存，不进会话历史/工具结果/磁盘；NOPASSWD 免密账户退化为确认弹窗（仍逐次授权）；`requiretty` 或未装 sudo 时明确报错请用户手动执行；`/perm-gate sudo on|off` 开关（配置项 `sudoExec`，默认开）；
- **配置**：`~/.pi/agent/perm-gate.json`（首次运行自动写默认配置；手动编辑，无管理面板）——`enabled` 总开关、`deny` 硬拒绝正则列表、`watch` 关注项正则列表、`remembered` 已记住的操作（`{pattern, intent, addedAt, lastHit, hits}`）、`aiReview`（false = 未命中名单一律转人工确认）、`aiTimeoutMs`、`sudoExec`、`model`；无效正则跳过并在 `/perm-gate` 状态里提示（附配置路径）；
- **命令**：`/perm-gate` 查看状态（开关/审核模型/sudo 通道/已记住条数含过期提示/关注项与硬拒绝条数/无效正则/配置路径）、`/perm-gate on|off` 开关（持久化）、`/perm-gate sudo on|off` sudo 通道开关（持久化）、`/perm-gate reload` 重读配置、`/perm-gate model` 选审核模型（`<provider>/<id>|auto` 直接设置）、`/perm-gate prune` 清理过期记忆。

## 探索子代理（src/extensions/explore-agent.ts）

`explore` 工具：一个任务 = 一个只读子代理（read/ls/grep/find），并行探索代码库并交回结构化报告，主上下文不加载原始文件内容。

**成果渐进落盘**（不白烧 token）：子代理每轮的正文与检索轨迹实时写进项目内 `.pi/explore/tasks/<任务哈希>.partial.md`，报告文件 `.pi/explore/report.md` 同步重写——跑的过程中就能打开看着它长，不必等最后一次性总结。

**断点续跑**：同一任务文本第二次调用会直接复用已完成成果（`tasks/<哈希>.md`，零 token）；上次被中断的任务会带着半成品作为起点继续跑（提示词里明确「不要重复已验证的检索」）。要强制重跑传 `fresh=true`。

**上下文与轮数兜底**：上下文超限（各家措辞都识别）→ 把过程记录压缩成要点后继续跑（每任务最多 2 次）；轮数用尽或没有正文产出 → 用过程记录整理出报告。超时/网络中断/进程被杀时，返回结果里会带上「中断前已确认的部分」，半成品留在磁盘上等下次续跑。

`/explore-config` 选择子模型（默认 auto = 最便宜可用模型，可指定 provider/modelId）。

**与 `/init` 的联动**：`/init` 的子代理会探测本插件挂载的 `__PI_EXPLORE_API__` 契约（`shared/explore-api.ts`）——探索工具在场时子代理可自己派探索子代理并行摸底（大仓库先摸目录/命令/架构/约定，再用 read 抽查），状态栏显「⚙ 初始化 · 探索 n/m」；此时一律现跑、不复用历史成果，其他情况（未装/被禁用）自动退回自读模式。

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

## 剪贴板工具（src/extensions/clipboard.ts）

为 AI 提供系统剪贴板的读写能力，零原生依赖（产物保持零外部依赖单文件）：

- **`clipboard_get([maxChars])`**：读取当前剪贴板文本（用户最近复制的内容，适合「看我复制的xxx」/把链接/代码/文本拿进来处理）。默认最多返回 50000 字符、上限 200000，超长截断防撑爆上下文；空或仅含图片等非文本内容时给明确提示。
- **`clipboard_set(content)`**：把文本写入剪贴板（AI 编辑结果写回，用户直接 Ctrl+V 粘贴；空字符串 = 清空）。返回时报告**被覆盖旧内容的摘要**（长度 + 前 40 字符），让 AI 与用户感知覆盖了什么——剪贴板常存敏感内容（密码/密钥），工具描述提示 AI 写入前先 `clipboard_get` 确认。
- **`/clipboard`**：用户自查当前剪贴板内容；`/clipboard clear` 清空。

跨平台实现（均为系统自带命令，无需额外安装）：Windows 用 PowerShell `Get-Clipboard -Raw` / `Set-Clipboard -Value`，macOS 用 `pbpaste` / `pbcopy`，Linux 用 `xclip`（缺失退 `xsel`）。读写统一经 `os.tmpdir()` 临时文件中转再删（规避 PowerShell 5.1 管道输出 UTF-16LE 的编码乱码、规避命令行转义）；读时把 CRLF/CR 归一化为 LF（Windows 剪贴板物理存 CRLF，与 mac/Linux 的 `\n` 输出对齐）。

## 二维码工具（src/extensions/qr.ts）

为 AI 提供二维码的编码与解码能力，并把 AI 生成的二维码直接显示在用户界面：

- **`qr_encode(text, ecc?, save?, pngWidth?)`**：把文本（URL、Wi-Fi 配置、名片、任意文字）编码成二维码并**直接显示在用户界面**——图形终端（kitty/iTerm2 图形协议）显示 PNG 真图；普通终端用 Unicode 半块字符（▀）显式黑白 ANSI 绘制（暗模块=黑、亮模块=白、含 4 模块静区，逐字符着色不依赖终端主题背景），1 cell 宽 × 半行高的模块近似正方形，**可直接扫码**。默认纠错级别 M（L/M/Q/H 可调），默认落盘 PNG（`os.tmpdir()/pi-qr-<时间戳>.png`，边长默认 512px，128~2048 钳制），路径随结果返回。
- **`qr_decode(image)`**：从图片解码二维码——支持本地文件路径或 http(s) URL，PNG/JPEG（qrcode/jsqr/pngjs/jpeg-js 纯 JS 解码，由 build.js 内联进产物），自动尝试正反色、小图最近邻放大；返回码内文本与版本/尺寸元信息。
- **`/qr <文本>`**：用户侧快速生成二维码并显示，按任意键关闭。
- **会话回放安全**：details 只存原文（不存矩阵/PNG，会话文件不膨胀）；渲染时从原文同步重新编码，历史会话重新打开时二维码照样渲染。
- 状态推送 `qr` 走 shared/status 联动 hud（行 1 动态区 accent 色）；回归测试 `node src/extensions/qr/test/qr.test.mjs`（esbuild bundle + jiti 加载，12 场景）。

## 图片请求体预算（src/extensions/img-slim.ts）

防止「上下文里的历史图片把请求体撑爆」导致上游 413（DeepSeek 直连/中转实测上限 ≈48 MiB：46.4MB 通过、52.6MB 失败；超限报错形态为 openresty 的 413 HTML 或中转的 `413 {"Upstream response was not valid JSON"}`）。根因是 pi 会把分支内历史图片**每轮原样重发**且无淘汰，而上下文 token 估算把每张图只记 4800 字符 ≈1200 tokens（DeepSeek-flash 窗口 1M ⇒ 要 ~820 张图才可能触发自动压缩，**请求体上限永远先到**；实测某会话 76 张/75.6MB 起连续 413、全天涨到 186 张/186.5MB，纯文字追问也一起报错）。

三层防护：

- **新图瘦身**（`tool_result` 钩子 + `input` 钩子）：工具（`read` 等）读入的图片与用户粘贴/`@file` 附带的图片，按类型重编码到单图预算内——照片（jpeg 源）≤900KB base64、图形/截图（png/gif/webp 源）≤1.6MB，最长边 2000px；**动图 WebP 强制取首帧转静态 PNG**（上游会 400 拒收动图 WebP，且历史重发会让后续每轮都失败）；小于 300KB 的图不碰，避免重编码抖动。
- **总量预算**（`context` 钩子，每轮请求前）：统计仍在上下文里的历史图片总量，超过 32MB base64 就**从最旧开始**把图片换成占位文本（非破坏性：只改本次请求，会话记录不动，需要时重新 `read` 即可）；会话已积累超过 40MB 时新图按半预算处理（温和降级）。状态行显示 `🖼 24.5MB 裁2图`（走官方 `setStatus`，hud 缺席回落原生 footer）。
- **`/img-slim`**：报告分支内图片张数/体积/预算与当前单图策略；`/img-slim on|off` 本次会话开关。

取舍（实测数据，2000px 上限）：**无损重编码对 JPEG 源无解**（7.43MB 照片 → 无损 WebP 11.44MB，1.5 倍膨胀且 87s/张；JPEG 已是有损 DCT，解码后熵高）；PNG 截图转无损 WebP 只省 ~20-30% 且不能降分辨率，打不过现状的降采样。真杠杆是分辨率：1400px+JPEG q90 平均 433KB（48MiB ≈113 张）、1024px+q85 平均 198KB（≈248 张）、现状（pi 2000px）1618KB（≈30 张）。本扩展保守沿用 2000px，想更狠改文件顶部 `MAX_SIDE` / `PHOTO_MAX_B64` / `GRAPHIC_MAX_B64` 即可。已知限制：APNG（动图 PNG）在 pi 的图片嗅探层就被判为非图片（会当文本读入），钩子层拿不到 `ImageContent`，无法在此修复。

## 人机协作任务面板（src/extensions/workflow-mgr/）

通用工作流面板：AI 是**流程指挥者**（拆解、排序、验证、推进），你是**执行者**（做任务、拍板）。对 AI 说「帮我规划 X」，它会用 `wf_workflow` 建出阶段→任务工作流，常驻面板立刻出现——你抬眼就知道「现在该做什么」。泛化自论文工作流垂直版（thesis-workflow），工作流定义不再写死，AI 用工具动态创建，可加载任意任务。

- **数据（项目级、跨会话、可 git 审查）**：`.pi/workflow/workflow.json`（工作流定义：阶段→任务，含人机分工/交付物/完成信号/依赖 + 可选 `mode`：`human-ai`/`agent`）、`state.json`（进度：当前任务/任务状态/里程碑/AI 记录/日志）、`config.json`（面板开关）；**无内置示例**：从未创建过时为空工作流（常驻面板整体隐藏），AI 用 `wf_workflow` 从零创建；
- **协作模式（mode）**：工作流级可选字段，缺省 `human-ai`（AI 指挥、人执行）向后兼容；`agent` = **纯 agent 自动驾驶**（0.3 拍板）——无人类分工（`humanTasks` 可不填、渲染/简报隐藏「你:」行）、AI 用 `wf_switch` 连续推进直到全部完成并 `wf_workflow archive` 收尾，遇到无法完成的任务用 `wf_block` 标记原因停下报告；
- **常驻面板**：输入框下方背景色区块，3~5 行——当前任务（最显眼）+ 阶段 + 右对齐进度条（`▓`实心/`░`空心，附 完成数/总数）、分工两行 `你:/AI:`（多项「、」连接，agent 模式隐藏「你:」）、阻塞 warning 提示、里程碑三态（`▶`当前目标/`○`未完成/`✓`已完成）；宽度自适应（`visibleWidth`：中文=2 列、块元素=1 列），窗口 resize 自动重排；空工作流显示「无任务，请先让 AI 用 wf_workflow 规划」；**hud 接管**：hud 存在且开启时，面板内容改由 hud 在 footer 底部渲染（屏幕最底，任务/分工/里程碑 ≈4 行），常驻面板隐藏——经 hud 通用接口 `__PI_HUD_API__.registerExtraRows` 注册渲染函数（**内容与样式由 workflow 自决**，与常驻面板同款：12 格进度条 + selectedBg 底色，确保体验一致），`notifyExtraRowsUpdate` 请求重绘，零耦合零 import；**常驻面板开关联动**：`showPanel=false` 时 hud 底部行一并隐藏；`/hud` 关闭后自动恢复自绘面板（`hud:state-change` 事件驱动）；
- **工具（7 个）**：`wf_workflow`（list/import/add/edit/remove/archive/reset——**初始化优先 import**：用 write 写一份草稿 json（`{stages:[{name,goal,tasks:[{title,deps,...}]}]}`，id 自动生成如 0.1/1.2、deps 可直接引用本批未来 id）一次性导入整份计划，远比逐条 add 省 token，add 只用于已有工作流增补调整；非空时拒绝导入；add 时 stageId 不存在自动建阶段、id 自动生成如 1.2、防依赖环（导入含全图环检测带链路）；可带 `mode` 设工作流级协作模式；remove 同步清状态、空阶段自动移除；**archive 归档工作流**：可带 `status` 描述收尾状态（完成/放弃/其他），**归档 ≠ 完成**——快照保留任务真实状态、不做强制 done 标记，数据移入 `.pi/workflow/archive/` 留档可 git 审查，不提供找回功能需时手动查看；reset 清空工作流）、`wf_status`（当前任务+分工+交付物+完成信号+下一步+阻塞+里程碑+最近记录）、`wf_switch`（**推进核心**：一次调用替代 start+done——无参=完成当前任务并自动开始下一个依赖满足的任务，无下一个则全部完成；`taskId=X` 显式切换；`complete=false` 搁置当前任务回 todo 直接转移；switch 到 blocked 任务即解除阻塞；**独立审计**（借鉴 pi-goal-x completion auditor）：`.pi/workflow/config.json` 设 `auditOnComplete:true` 后，完成推进前派全新上下文的只读+bash 子代理核验完成信号（不信宣布者、自己查证据），不通过则打回任务保持 doing；审计自身故障放行——增强不是门禁）、`wf_block`（阻塞+原因）、`wf_rollback`（回退 todo/doing，输出依赖警告清单不自动回退下游）、`wf_note`（**AI 记录，对用户透明**：交流中的重要结论/约束/偏好，增删读改 {id,ts,content}，作为跨会话记忆）、`wf_milestone`（增/改/删/改名里程碑）；
- **命令**：`/workflow-config` 轻量功能浮窗（居中浮窗：显示详细信息/常驻面板开关，↑↓ 选择 Enter 执行 Esc 关闭；详细信息页任意键返回）——**只留无参**（0.4 拍板：人无需管理工作流，管理是 AI 的事）；`/wf-resume` 恢复历史会话（复用 pi 官方会话选择器全屏选择，等价手动 `/resume`）——工作流选择弹窗「从 resume 中加载」的内部入口，也可手动输入重试恢复；
- **会话工作流选择（多工作流并发隔离）**：一个项目可并存多个命名工作流。多槽或其他活跃会话已绑定时，启动会话会弹选择框——**「暂不启用（AI 自动判断）」居首位并默认高亮**：不指定工作流、也不关掉，是否使用交由 AI 视任务判断（需要时它自行绑定，不需要则零打扰）；也可选某个已有工作流或「＋ 新建工作流…」自建，Esc 同暂不启用；单槽/无槽仍自动绑定，零打扰。
- **AI 角色注入（条件注入，0.2 拍板）**：`before_agent_start` 按三态把指南追加进 systemPrompt（不进对话、不膨胀会话文件）：暂不启用（`auto`）/明确不用（`none`）→ **零注入**（前者是否使用由 AI 自行判断，需要时它自己 `wf_workflow bind`，不反复提示用户）；无工作流/空工作流 → **零注入**（简单任务不被引导，AI 靠工具描述按需发现）；`human-ai` → 完整指挥者角色（下达指令格式 📋任务/🎯目标/📌做法/✅回报/🔍验证、完成信号验证后 `wf_switch`、重要结论用 `wf_note` 记录）；`agent` → 轻量自动驾驶执行者（连续 `wf_switch` 直到完成并 archive，障碍 `wf_block` 停下报告）；
- **多工作流并发与恢复**：多槽或有其他活跃会话已绑定时启动弹**自绘分组选择浮窗**——「通用」组（**暂不启用**（默认高亮，Esc 同此）/ **从 resume 中加载会话**（放弃本会话直接触发恢复流程，不写本会话绑定，恢复后按被恢复会话自己的绑定加载其工作流空间））与「工作流（N）」槽位列表（进度摘要）分区呈现，＋新建收尾；↑↓/j/k 移动、Enter 确认、数字键 1-9 直选；被恢复的会话无绑定时再弹框拍板；
- **渲染回归测试**：`node src/extensions/workflow-mgr/test/render.test.mjs`（test/ 下 node_modules junction 指向 pi 全局包；esbuild bundle 扩展 + mock pi/ctx → 17 场景 A-O、Q、R：三态渲染断言、工具流程、switch 语义、mode、注入三态、wf_note 增删读改、archive 自动完成、import 一次性导入、多槽绑定「暂不启用」/「从 resume 中加载」派发与恢复绑定断言）。

## 知识库（src/extensions/webdav-kb/）

给 AI 用的云网盘（WebDAV 驱动）：AI 自发沉淀有用的东西（技术笔记、踩坑记录、参考资料摘录），需要时自发检索；本地镜像离线可用，人类用 `/kb` 面板查询引用。14 个 `kb_*` 工具 + `/kb`（检索/引用）、`/kb-config`（WebDAV/vault 口令配置）、`/kb-sync`（手动同步）三个命令。

- **四命名空间**：`/notes`（永久知识）/ `/references`（文档摘录，markitdown 产出）/ `/scratch`（临时草稿，可随时清理）/ `/vault`（加密区：需口令解锁、口令只存内存、密文仅 kb 工具可读写，口令忘了=数据永久丢失）；路径必须分层 `/命名空间/用途/自由层级/文件名`（至少 4 段，禁止命名空间/用途下放裸文件）；
- **分类层级守则（PROTOCOL.md）**：`/references` 第 2 层按文档功能**六值判定**（知识文献/规范文书/操作指南/数据名录/表单模板/素材资源，互斥判整体体裁），`/notes` 按知识主题类判定（技术笔记/研究笔记/方法总结/工作职业/生活管理/兴趣创作）；自由层级由 AI 管理（<3 个文件并入相近层、长期 <2 个文件的层并入、层级名禁项目名/来源形态/编号前缀）。守则本体 = 网盘根 `PROTOCOL.md`（跨设备同步、用户可直接编辑迭代，`kb_help` 优先读它、缺失回退内嵌默认版 protocol.ts）；`PROTOCOL.md` 对 `kb_list`/`kb_status` **不透明**（守则走 `kb_help` 专用通道，不混入内容浏览，`kb_search` 保留索引作兜底旁路）；
- **本地镜像 + 增量同步**：所有读操作（搜索/面板/AI 工具）打在本地镜像（毫秒级、离线可用）；同步账本 `.kb-sync.json` 记录 etag + 本地 mtime 快照，增量比对——远端 etag 变+本地未动→下载、本地 mtime 变+远端未动→上传、远端删+本地未动→删本地、本地删+远端未动→删远端、两侧都变→**冲突**（保留远端为权威，本地版存 `.conflict-<时间戳>` 副本、仅本地不回传）；上传前自动补齐远端父目录（MKCOL 链，123 云盘对并发 MKCOL 敏感、串行+重试最稳）；**同步健壮性**（借鉴 pi-sync）：`.kb-sync.lock` 互斥锁防多会话并发互踩（活锁拒绝、死进程/30 分钟超时安全回收）、`.kb-sync-journal.json` 记录中断阶段（成功才删除，下次同步报告并靠幂等重跑收敛）、**上传前 secret 扫描**（高精度密钥模式命中即拦截上传、本地保留，配置 `allowSecretUpload:true` 可关）、远端删除 404 幂等；**同步结果统一呈现**：计数全人话（下载/上传/删除/冲突/失败，0 值省略），并附说明行——冲突列出具体文件与 `.conflict-` 副本处理办法、遍历不到（权限/网络）的目录、失败明细（含 secret 拦截的解除方式）；锁等待提示带等待预算，401/403/404/网络类失败直接给出下一步（改凭据/目录/代理）；**同步后自动清理本地镜像空目录**（`.kb-` 隐藏项与镜像根保留）；AI 写入（`kb_write`/`kb_append`）本地原子落盘 + 立即 PUT 远端，离线失败留账本下次同步补传；
- **只读模式**：适配 WebDAV 账号只有读权限的场景；`/kb-config` 面板切换（默认关，下次会话生效）。开启后：AI 只见只读工具（`kb_write`/`kb_append`/`kb_upload`/`kb_import`/`kb_delete`/`kb_move` 在 session_start 一次性隐藏，`kb_sync` 保留）、同步自适应为仅下载（本地删过的远端文件重新下载回本地，本地新建/修改留在本地不上传）、首次引导的 PROTOCOL.md 写入跳过；
- **全文检索**：零依赖零向量（中文 bigram 滑动窗口 + 英文分词 + BM25），增量索引持久化 `.kb-index.json`（按 mtime 只重读变更文件）；纯文本多格式（md/txt/csv/tsv/json/jsonl/yaml/yml/toml/html/xml），csv/tsv 表头加权、frontmatter 仅 md 强制；vault 未解锁时加密区内容不可见（密文仅内存索引）；
- **vault 加密区**：口令只存内存，密文落盘 `.enc` 后缀，读写经解密/加密（列表/检索按明文路径对齐）；未解锁写入报错；
- **LFS 大文件区（/lfs/）**：附加真网盘，任何类型文件、不随知识库同步、不参与检索、不加密；`kb_upload`/`kb_download`/`kb_lslfs` 独立工具，单文件上限 1GB；md 笔记引用 lfs 用纯路径文本（如「附件：lfs/xxx.png」）；人类直接用 WebDAV 客户端挂载管理；
- **`/.history` 历史副本区**：所有文件的改动（覆盖/追加）与删除自动留档——副本存 `/.history/`、目录结构与根一致、文件名加 `_yymmddhhmmss` 后缀；同秒重名叠加 `_hash`（sha1 前 8 位），`_hash` 也重名说明是同一份内容直接跳过；**自身不递归**（`/.history` 与 `/lfs/` 下文件不备份）；`.history` 不参与 `kb_list`/`kb_search`（内容浏览不透明），恢复用 WebDAV 客户端取回副本（vault 历史为密文 `.enc`，拷回 `/vault/` 对应路径后经 kb 工具解密）；备份先落本地、账本登记、**下次同步补传远端**（延迟一轮）；`kb_move` 不备份（内容未变、只是路径变化，目标被删时仍会留档）；
- **工具清单**：`kb_help`（守则，topic 按节筛选）/ `kb_search`（全文检索，namespace 限定）/ `kb_read`（读全文）/ `kb_write`（写/覆盖，需 overwrite:true，文本上限 50MB）/ `kb_append`（追加）/ `kb_list`（目录树，路径可不带前导 `/`）/ `kb_upload` `kb_download` `kb_lslfs`（LFS）/ `kb_move`（移动/重命名，镜像+远端+账本三方一致、vault 透明搬移）/ `kb_delete`（删除，需 confirm:true，先留 `.history` 副本再删）/ `kb_status`（同步状态）/ `kb_sync`（手动同步）/ `kb_import`（本地目录批量导入，导入后按守则重新归位）；
- **测试**：`node src/extensions/webdav-kb/test/sync.test.mjs`（esbuild bundle + mock DAV：增量同步全场景 + `.history` 留档/命名/去重/不递归 + 空目录清理 + PROTOCOL 过滤）、`tools.test.mjs`/`search.test.mjs`/`client.test.mjs`/`crypto.test.mjs`/`panel-config.test.mjs`/`commands.test.mjs`/`lfs.test.mjs`/`panel.test.mjs`；`live-*` 为真实网盘联调脚本（不自动跑）。

## 媒体兼容层（src/extensions/mimo-omni.ts）

给 AI 补上「听音频 / 看视频 / 说话」三种能力，走小米 MiMo 开放平台。

**为什么需要它**：pi 的消息内容类型只有 text / image，全模态模型的原生音频、视频输入暂时进不了上下文。所以这里用工具把媒体转成文字——**文字在编码场景里反而更好用**：可搜索、可引用、可编辑、可回看。这是过渡件，等 pi 支持音频内容类型后应整体撤掉。

**两个工具**：

- **`mimo_transcribe(path, prompt?, fps?, resolution?)`**：解析本地音频/视频（也可传公网 URL），返回逐字稿或按 `prompt` 指定的要求解析（如「提取行动项与负责人」「按时间轴分段总结」）。
  - 音频 `wav/mp3/m4a/flac/ogg/aac/opus`；视频 `mp4/mov/avi/wmv`；视频可调 `fps`（0.1~10，默认 2）与 `media_resolution`（default/max）
  - 本地文件走 base64，超过 45MB 提前拦截并提示改走 URL（官方上限：base64 50MB、URL 音频 100MB / 视频 300MB）
  - 计费参考：音频约 6.25 token/秒，视频按抽帧计（fps 与分辨率越高越贵）
- **`mimo_speak(text, voice?, out?, play?)`**：文字 → 语音 wav，默认立即播放（系统自带播放器：Windows PowerShell SoundPlayer / macOS afplay / Linux paplay，零额外依赖）。
  - 音色：`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`

**配置**（`/mimo-config`）：TUI 面板逐项设置解析模型与合成音色（Esc 退出）；也可 `/mimo-config model mimo-v2.6-pro`、`/mimo-config voice 冰糖` 直接设置。配置存 `~/.pi/agent/mimo-omni.json`。

**解析链的可靠性设计**：默认用最便宜的 `mimo-v2.6-flash`，实测它约有一半概率**只回思考不回正文**（返回空内容）；因此链路上做了「同一模型空正文重试一次 → 仍空则降级到 `mimo-v2.6-pro` → 再降级 `mimo-v2.5`」，并把每次尝试记录在工具结果的 details 里。追求稳定可直接 `/mimo model mimo-v2.6-pro`。

**API Key**：优先取 pi 注册表的 `xiaomi` provider（`/login xiaomi` 后可用），回落 `~/.pi/agent/auth.json`，再回落环境变量 `MIMO_API_KEY`。

**回归测试**：`node src/extensions/test/mimo-omni.test.mjs [音频] [视频]`（离线 18 项：类型判定、内容块构造、fps/分辨率透传、超大与格式错误拦截）；加 `MIMO_LIVE=1` 则额外用真实文件打一次 API 验证音频与视频两条路径。

## 钉钉受控桥接（src/extensions/dingtalk-bridge.ts）

替代 dingtalk-* 技能的插件方案：技能是「冻结说明书 + 凭记忆拼命令」，对高风险操作（发消息）已被事故史证明不可靠；插件把机械可判的铁律变成工具层硬拦截。

- **技能屏蔽**：启动时把 `dingtalk-*` 从系统提示词的技能清单过滤（不动 dws 托管的文件——它由 npm postinstall 安装、`dws upgrade` 时全量还原，改了也没用）；`/skill:dingtalk-xxx` 手动加载不受影响，留作逃生舱。
- **`dws_schema(path?)`**：包 `dws schema --compact` 活内省（随 CLI 版本实时更新）。无参看 29 个产品概览 → 传产品 id 看工具清单 → 传 canonical_path 看参数 schema，逐层下钻。
- **`dws_exec(args[, confirm][, formal])`**：argv 数组直传 spawn（不过 shell，免去转义坑），自动补 `--format json --yes`。发送/转发类命令（`+dm`、`+messages-send*`、`+messages-batch-send-by-bot`、`+messages-reply`、`+messages-forward*`、`+messages-update-card`、`+broadcast`、`ding send-*`）强制：
  - **两阶段确认**：首次调用只回草稿回执不发送，对话里经用户明确同意后带 `confirm` 重调才真发（草稿 10 分钟有效）
  - **【AI发送】标签强制**：缺失即拒（用户明确要求的正式通知传 `formal=true` 豁免；可在配置关闭）。转发（`+messages-forward*`）与卡片更新（`+messages-update-card`）无正文也无 `--ai-tag`，豁免此项、仍走两阶段
  - **中文姓名目标拒执**：强制先 `dws_resolve_user` 实时解析，严禁凭记忆硬编码 userId
  - **防重发**：相同目标+内容第二次发送直接拒——会话内存 + 跨会话台账（`~/.pi/agent/dingtalk-bridge-sent.json`，保留 `dedupMinutes` 分钟），重开会话重跑也拦得住
- **`dws_resolve_user(name[, pick])`**：包 `aisearch person` + `contact user get`——候选带部门路径/职务/工号（重名消歧靠的就是这个），无部门/工号者标注为家长或外部联系人账号；单候选自动确认，多候选列出后带 `pick=<userId>` 确认。
- **`dws_resolve_group(name[, pick])`**：包 `chat +chat-search` 解析群 `openConversationId`——实测搜「教研室」返回两个同名群（7 人/8 人）加一个集团群，群名作目标会被直接拦截，必须用 cid。
- **撤回也要过两阶段**：`+messages-recall` 等撤回命令同样先回草稿（预览标出「撤回后双方均不可见，不可恢复」），确认后执行，且同一 messageId 不会重复撤回。
- **群发也要过两阶段 + 发送前预检**：`+broadcast` 首次同样只回草稿（自动附加的 `--yes` 绕不过去），且草稿前先跑一次只读 `--dry-run` 预检收件人，草稿里列出「将发给谁（含解析出的单聊 ID）」。有任何一个收件人未唯一解析（多候选/零候选）就整体拦下——不生成草稿、不做半批次发送，并把候选与稳定 ID 一并列出。消歧办法是**把重名的名字直接换成候选里的 userId，其余名字照旧**（同一条命令里姓名与 userId 可混用，实测 `--to "苗文硕,016113645862842894"` 两人都发；而把重名名字与 userId **并列**——`--to "李娜,016113645862842894"`——不解决歧义，重名那个 token 仍会被跳过）。「中文姓名目标拒执」对群发不适用（其目标按设计就是姓名），改由预检把关；转发的 `--dest-conversation-id` 会按群目标同等把关（中文群名直接拦）。
- **预检失败不再只给一句笼统报错**：dws 在「一个都没解析出来」时会直接 exit 3 且不给计划（只有一句「没有任何人收到消息，请检查姓名是否正确」）。工具改为退回**逐名自探**：用 CLI 自己的解析链（`+messages-send --user-query`，与 broadcast 同源）拿到结构化候选，再补部门/职务/工号，输出「可发 N 人 / 有问题 N 人」（多候选附部门路径与 userId、查无此人给手机号反查入口）。每次收件人也可主动跑 `dws_exec ["chat","+broadcast",…,"--dry-run"]` 拿这份两栏预演（只读，不进两阶段）。
- **候选带部门/职务/工号**：`dws_resolve_user` 在 aisearch 候选基础上再拉 `contact user get`（批量、失败则静默降级）补部门全路径/职务/工号；同名的两个李娜一眼分出（班主任-诚毅校区 vs 英语教研组）。**无部门且无工号会被标注为「可能是家长或外部联系人账号」**（实测家长账号 depts 为空、jobNumber 为 null）——单候选自动确认时也带着这行标注。
- **`--dry-run` 是只读预演**：不进两阶段门（不会生成草稿待确认）、不记防重发台账（不会拦掉随后的真发），结果尾部明确标注未发送。
- **发送后自核验入口**：结果里直接给出 `openTaskId`（查发送状态/转 DING 用）与只读核验命令（`+search-msg --sender <本人>`），叉住「输出看不清就重跑发送」的冲动。
- **文件存在性预检**：`--file` 路径不存在时直接拦下（不再真去捅 dws）。
- **`dws_skill([topic])`（逃生舱）**：消息收发之外的复杂操作（表格/文档/日历/审批/组织/听记等）按需拉取官方技能正文——无参给技能索引（14 个 + 一句话），传 topic 取完整 SKILL.md。技能文件不动，只是不再常驻系统提示词。
- **`dws_fetch(link 或 spaceId+nodeId[, outDir])`**：钉盘/云盘分享落地——文件直下、文件夹递归镜像并列回文件清单（绝对路径）。**这类消息用 `+messages-resource-download` 会报 `TABLE_NOT_FOUND`**（实测：resourceRefs 给的是 `238322429838&type=file` 数字 dentryId 缺 spaceId，真正可用的 spaceId 藏在正文 yunpan 链接里），必须走 drive。只读查询结果会自动把这类引用结构化成带下载命令的指引。
- **「文件夹」消息无法读取（平台限制，已实测坐实）**：钉钉对这类消息只给一句 `[文件夹] 姓名`，无 resourceRefs、无 id、无 mediaId，`download-media` 也无从下手——工具会直接给出结论并提示让对方打包 zip 或逐个文件重发，避免反复尝试。
- **字段拼写不一致自解释**：群成员等接口返回 `openDingtalkId`（小写 t），消息接口返回 `openDingTalkId`（大写 T）。插件不擅自改写返回数据，而是在结果里自动附一行提示（两种拼写都要认），内部解析一律大小写不敏感。
- **消息发送的三处硬处理（实测沉淀）**：① 正文里的字面 `\n`（模型常把换行写成两个字符）自动归一为真换行——dws 会把它吃成空格；② 多行正文自动补 markdown **行尾双空格**硬换行——钉钉客户端把单个换行当段落内空格拼成一行（实测有效；空行分段也可但行距松，纯文本 `--text` 更会直接拼行，故多行走 `--markdown`，`--text` 多行会提示）；③ 文件/媒体消息（`--file`/`--media-id`）与正文协议层互斥，发出后明确回报「本条不含正文」（`--title` 只作文件卡标题、不显示给收件人），说明文字必须另发一条。
- 查询类命令结果自动附**当前系统时间**（时间窗一律相对此刻推算）。

  - **面板统一布局**（`shared/review-panel.ts`）：弱化标题 → `动作 | 对象` 表头（对象是名单时按可用宽度塞名字、剩余收口为「等 N 人」，仅重名才带部门括注）→ 固定 5 行正文（超出用 PgUp/PgDn 翻页，分隔线内 ▲▼ 给余量）→ `⚠` 影响行 → 竖排选项。撤回类在弹窗前用只读查询补齐对象（`+messages-mget` + `conversation-info`：会话名 + 时间 + 正文预览）。**面板内不放 argv / flag / JSON / ID**（有单测断言）。
  - **实测纠错**：官方 `capability-limits.md` 写「个人身份发送的消息无法通过 API 撤回」，实测**能撤**（25 分钟前的消息也撤成功了）；撤回后面板/回执按真实 `recallStatus` 报，同一 messageId 不会重复撤回。
- **三步走：读直通 / 写两阶段 / 敏感档弹窗**（不再靠提示词自觉）：分档由 dws 自己的 schema 元数据决定（`dws schema --cli-path <path> --compact` 的 `effect`/`confirmation`，本地缓存 `~/.pi/agent/dingtalk-bridge-schema.json`，手写表兜底；查不到就当写入）。
  - **读**：直通（`list/get/search/info/query…` 类词快速判定，命中写词则一律按写处理）。
  - **写**：首次只回草稿/计划（不执行），AI 把计划展示给用户、经明确同意后带 `confirm` 重调才执行。
  - **敏感档**（破坏性 + 会对外发出内容：发送/群发/转发/撤回/邀请/删除/清空/审批发起…）：在**真正执行的最后一瞬弹人工审核面板**——面板只写人话（要做什么 / 对谁 / 内容预览 / 影响与可逆性），**不放 argv、JSON、ID**；选项为「允许一次 / 当前工作区不再询问 / 拒绝」（destructive 不开放记住），Esc=拒绝。`当前工作区不再询问` 按命令路径记，可用 `/dws-bridge forget` 查看或清除。**无界面会话（print/RPC）直接拒绝敏感档**，绝不因为弹不出窗就放行。（面板复用 `shared/review-panel.ts`；与 perm-gate 的复核面板同一套串行链，避免并行工具批里浮层打架。）
配置 `~/.pi/agent/dingtalk-bridge.json`（`requireAiTag` / `blockedSkillPrefixes` / `dwsPath` / `execTimeoutMs` / `maxOutputChars` / `dedupMinutes` / `skillsDir` / `remembered`）；`/dws-bridge` 查看状态，`/dws-bridge forget <命令|all>` 清除「当前工作区不再询问」，`/dws-bridge refresh` 清空命令元数据缓存。回归测试：`node src/extensions/test/dingtalk-bridge.test.mjs`（策略层纯函数 A~Z 场景，不真实起 dws 进程）；真实联调 `node src/extensions/test/dingtalk-bridge-live.mjs [姓名]`（发送只走到草稿/预检即停，永不 confirm）。

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
rm ~/.pi/agent/extensions/claude-it.ts
rm ~/.pi/agent/extensions/status-beacon.ts
rm ~/.pi/agent/extensions/web-tool.ts
rm ~/.pi/agent/extensions/webdav-kb.ts
rm ~/.pi/agent/extensions/workflow-mgr.ts
rm ~/.pi/agent/extensions/ask.ts
rm ~/.pi/agent/sounds/task_complete.wav
# 官方插件（vendor）：pi remove 按本地路径移除（同时清 settings.json packages 登记）
pi remove ~/.pi/agent/vendor/pi-rtk-optimizer
rm -rf ~/.pi/agent/vendor
```

（`settings.json` 里的 `"theme": "matrix"` 改回其他主题即可；`models.json` 已并入你手改的 `~/.pi/agent/models.json`（深度合并，模板键以仓库为准），要还原需手动移除模板注入的 `providers.openrouter.compat.openRouterRouting`；三个补丁打在全局 node_modules 上，重装 pi 即还原，祖冲之汉化另有 `--restore` 一键还原英文；rtk 二进制按安装位置删（Windows `%APPDATA%\npm\rtk.exe`，Unix `~/.local/bin/rtk` 或 `~/.pi/agent/bin/rtk`）。）

## 说明

- **伪编译架构**：`src/` 是全部源码与工具（`extensions/` 扩展源码，`shared/` 共享模块被多个扩展 import 复用，`hud/` 拆分为多文件便于维护，`package.json` + `config/` + `build.js` 为构建工具与配置）；`node src/build.js` 用 esbuild 把每个扩展入口内联打包成 `dist/extensions/` 单文件（零耦合、只依赖 pi 官方包；`hud/` 合并为 `hud.ts`）；静态资源（`static/`）无需编译，`install.js` 直接从 static/ 安装。**dist 不入库**（gitignore）：克隆后 `cd src && npm install && node install.js` 即可用；改了源码后跑 `node install.js` 一步重建+安装，改静态资源则 `--skip-build` 重装即可。
- `docs/deepseek/` 是本地参考资料（不入库，版权归 DeepSeek），供 deepseek 适配开发时查价格、思考模式、API 细节。

