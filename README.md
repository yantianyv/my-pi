# pi 一键配置项目

把 pi 的定制配置（主题、扩展、文档）集中在这个仓库里，一条命令安装到全局。

> **分支说明**：本仓库的公开发布分支是 `public`。本地开发主干保留完整功能集，公开分支剔除仅对本人账号有意义、不宜公开的部分（如把第三方客户端账号当作模型来源的网关类插件）；两者历史独立，不互相合并。

> **AIGC 声明**：本项目的几乎所有代码均由 AI 生成，作者不对代码质量、正确性、安全性做任何保证；使用本项目产生的任何后果由使用者自行承担。本项目以 MIT 许可证发布（见 LICENSE）。

## 快速开始

```bash
git clone <repo> && cd <repo>
node install.js           # 一键：自动 npm install（首次，需网络）→ 构建 → 安装到 ~/.pi/agent/
node install.js --dry-run # 先预览要做什么，不修改
```

安装后重启 pi 或执行 `/reload` 生效。首次运行会自动拉取构建依赖（esbuild）并构建产物，之后每次运行都是：构建 + 安装一步到位。需要 `npm i -g` 的步骤（pi 本体、复杂外部依赖）若权限不足（系统 npm 全局目录属 root），脚本会直接说明原因并问是否改用用户级前缀 `~/.local` 重装，不需要 sudo。**伪编译架构**：源码层 `src/extensions/shared/` 共享模块在构建时内联进各扩展产物——原始代码高复用、编译产物零耦合；`src/extensions/hud/` 多文件扩展也被合并为单个 `hud.ts`（详见「伪编译架构」节）。另外 `src/vendor/` 收录一个社区插件源码副本（pi-rtk-optimizer，MIT 原样收录含 LICENSE），install.js 一并部署（见「官方插件」节）。

## 包含内容

| 目录 | 内容 | 安装目标 |
|------|------|----------|
| `themes/` | `matrix.json` — 黑客帝国风格荧光绿主题 | `~/.pi/agent/themes/` |
| `extensions/` | `hud/`（源码多文件：`index.ts` + `hud-core.ts` + `hud-balance.ts` + `hud-cost.ts` + `hud-git.ts`；build.js 合并为单文件 `hud.ts` 产物）— 3 行 HUD 状态栏，见下 | `~/.pi/agent/extensions/` |
| `extensions/` | `btw/` — `/btw` 旁支问答：侧栏浮层多轮追问、`m` 转正附带、`/btw-config` 选择本插件模型或 auto（交给 model-config；见「模型管理」） | `~/.pi/agent/extensions/` |
| `extensions/` | `claude-it.ts` — `/exit` 别名、无斜杠 `exit` 退出、Ctrl+C 取消当前 turn、双击 Ctrl+C 回退（`/rewind`）（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `context-init.ts` — `/init` 生成/维护项目唯一的 `AGENTS.md`：内容两问 + 信息四去向（`AGENTS.md` / skill / `STATUS.md` / 知识库）+ 目录对齐 + 审计复核；会话开始兜底补 `.pi/.gitignore`（白名单式嵌套忽略） | `~/.pi/agent/extensions/` |
| `extensions/` | `ask/` — 整屏问卷：`ask` 工具批量提问（七题型、条件题 showIf、最多 12 题）+ `/answer` 续答已搁置问卷；必答未完成时连按两次 Enter 可跳过未答直接提交 | `~/.pi/agent/extensions/` |
| `extensions/` | `status-beacon.ts` — 全链路状态感知：执行中标题进度（spinner+工具活动）+ 五状态五音效 + 状态栏闪烁 + 提醒标题动画（见下；前身 task-alert） | `~/.pi/agent/extensions/` |
| `extensions/` | `pair-guard.ts` — 并发会话感知：项目级会话注册表（判活双保险）、变化驱动广播（peer 加入/离开/近窗口文件/标签）、写 peer 近期文件时软警告、`/pair` 查看详情与设置标签；另提供 `set_title` 供 AI 自报工作标题（同步为会话显示名，`/resume` 可见） | `~/.pi/agent/extensions/` |
| `extensions/` | `secure/` — bash 命令权限门：硬拒绝 / 关注项 / 已记住的操作（意图缓存）+ AI 审核与人工确认面板（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `secret/` — 密钥不外发：会话级内存库（掩码录入 / 粘贴捕获 / 形态识别）+ `{{sec:名字}}` 引用（bash 走按次环境变量注入，真值不进 argv）+ 四道出口脱敏网 + 跨会话长期指纹表；`secret_list` / `secret_prompt` 工具、`/secret` 面板（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `web-tool.ts` — 联网工具：`web_search` 多源搜索 + `web_fetch` 抓网页转 markdown（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `skill-hub/` — 技能市场：`/skill-hub` 面板（搜索 / 收藏 / 安装 / 卸载）+ `skill_search` / `skill_inspect` / `skill_install` / `skill_uninstall` 四工具；收藏跨项目共享，agent 检索时置顶（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `explore-agent.ts` — `explore` 只读探索子代理：并行派子代理、成果渐进落盘（`.pi/explore/report.md`）、断点续跑与上下文压缩（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `clipboard.ts` — 剪贴板读写：`clipboard_get` 读取 + `clipboard_set` 写入 + `/clipboard` 命令（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `time.ts` — 时间感知：`context` 渲染层给每条 user 消息贴 `[YYYY-MM-DD HH:mm]` 常量前缀（会话记录/UI 不动、缓存友好）+ `now` 工具按需查绝对当前时间 | `~/.pi/agent/extensions/` |
| `extensions/` | `qr.ts` — 二维码：`qr_encode` 编码（显示到 UI + PNG 落盘）+ `qr_decode` 解码 + `/qr` 命令（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `img-slim.ts` — 图片请求体预算：新图按类型瘦身（同尺寸取 PNG/JPEG 小者、动图 WebP 转静态）+ 轮末把最旧图片永久移出上下文（低水位泄洪）+ 请求级兜底（防 DeepSeek 等上游 48MiB 请求体 413）（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `crash-log.ts` — 崩溃黑匣子：崩溃堆栈同步落盘 `~/.pi/agent/pi-crash.log`，`/crash-log` 报告最近一条崩溃与取证路径（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `keep.ts` — 停顿点续航：工作型停点（本轮有 bash/write/edit/codemode 调用且收尾无 toolCall）经**旁支自检**（复刻主会话前缀跑一次限 1 轮的 agentLoop，提问与回答都不进主记录）拿三选一判定（A 继续 / B 需人工 / C 已完成），A 则注入下一步续跑；判定与挂机收尾摘要都是**单行**文本（纯展示、永不进模型请求）；挂机进度走独立状态 key（`⏳ 挂机中 · 第 n/4 件`，优先级高于工具活动），一眼分清在干活还是在挂机；介入等级 `/keep`（off/default/idle：idle 在完成后探一次在场，无人回应就做白名单内的安全挂机工作） | `~/.pi/agent/extensions/` |
| `extensions/` | `webdav-kb/` — 知识库（WebDAV 云网盘）：14 个 `kb_*` 工具 + `/kb`（含 `sync` 手动同步）与 `/kb-config` 命令；本地镜像增量同步 + vault 加密 + LFS 大文件 + `/.history` 历史副本（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `workflow-mgr/` — 会话任务面板：AI 规划阶段→任务（含人机分工），常驻面板显示当前任务与进度，数据按会话隔离（全局 `~/.pi/agent/workflow/`，见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `mimo-omni.ts` — 媒体兼容层（过渡件）：`mimo_transcribe` 解析音频/视频（逐字稿或按需求解析）+ `mimo_speak` 文字合成语音，`/mimo-config` 面板配置（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `dingtalk-bridge/` — 钉钉受控桥接：业务语义工具（消息/待办/日程/审批/文件/文档表格，AI 不碰 dws 命令）+ 只读知识入口 `dws_skill` + 两阶段确认/人工面板/防重发（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `draw/` — 生图：`draw_image` 按档位主备链调 pi 官方生图接口（`models.generateImages`）并落盘 + `/draw-config` 配链路/目录/尺寸；参数里没有模型字段，模型只由配置决定（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `computer-use/` — 桌面操作：UIA 控件树 + OmniParser 视觉检测双通道感知，激活制 + 焦点自动归还 + 全屏差分验证，八个工具（`cu_activate` / `cu_windows` / `cu_screenshot` / `cu_elements` / `cu_click` / `cu_type` / `cu_key` / `cu_scroll` / `cu_drag`）（见下） | `~/.pi/agent/extensions/` |
| `extensions/` | `model-config/` — 模型管理插件：`/model-config` 面板集中设置各插件用途使用的模型（策略槽 MAX/FAST/LITE/BASE/BATCH 可重指，AUTO/FREE 固定语义），见下 | `~/.pi/agent/extensions/` |
| `patches/` | 三个 pi 补丁：ai usage 防护 / 祖冲之汉化 / 启动垫片崩溃取证（见下；共用 `pi-root.mjs` 定位 pi 安装目录）。install.js 每次安装代跑（幂等、单个失败只告警不阻塞） | 打补丁到 pi 安装目录（托管安装 `~/.pi/agent/install/releases/<版本>/node_modules` 或 npm 全局 node_modules） |
| `sounds/` | 5 个提示音：`task_complete` / `subagent_complete` / `attention` / `error` / `idle_prompt`（播放时机见下「全链路状态感知」） | `~/.pi/agent/sounds/` |
| `skills/` | `markitdown/` — 文档转 Markdown skill（微软 MarkItDown：PDF/Office/图片等 → md，首次使用 AI 自装）；`lean-review/` — AI 产出审查（代码/文档删冗余 + 成稿散文去 AI 味，术语化诊断 + 最小修法）；`web-ui-review/` — Web UI 合规审查（可访问性/焦点/表单/动效/性能等，规则内置可离线用） | `~/.pi/agent/skills/` |
| `models.json` | 模型配置模板：OpenRouter 路由（provider 级 `compat.openRouterRouting`）+ 火山方舟 Coding Plan 自定义供应商（见下；已在则深度合并，保留手改的其他 provider） | `~/.pi/agent/models.json` |
| `deps.json` | 复杂外部依赖清单：装不起 skill、要 CLI + MCP + 自带 skill 的那类工具（REA 逆向分析）。install.js 逐项确认后执行：npm 全局按版本安装 → 选架构相符的 node → 复制包内自带 skill 到 `~/.agents/skills/` → 写 `~/.pi/agent/mcp.json`（按 `exposure: codemode` 接进 pi，工具不进系统提示词）；平台专属配置（Windows 的 Ghidra/JDK 路径等）写在 `platforms.<platform>` 下，其余平台自动跳过；已就绪的项跳过，失败不阻塞 | 不复制文件（读取执行） |

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
- **模型**：`ark-code-latest`（auto 选优）+ 常用具体模型（doubao-seed-2.1-pro / doubao-seed-evolving / doubao-seed-2.0-code / deepseek-v4-pro / deepseek-v4-1-flash / kimi-k2.7-code / glm-5.3 / glm-5.3-flash / minimax-m3），列表随官方更新可自行增删。
- **额度**：订阅制（5h 滑动窗口 + 周 + 月三级），额度在火山控制台「开通管理」页查看（Coding Plan 无 key 直查余额接口）。

## 模型管理（src/extensions/model-config/）

各插件要用模型的地方（btw 问答、explore 子代理、secure 命令审核、status-beacon 动作短语、hud-git 提交信息与冲突消解、/init 子代理）统一走两层设置：

- **插件侧**（各自配置文件里的 `model` 键，值只有两种）：`auto` = 交给 model-config 管理；或一个具体 `provider/modelId`（本地固定，管理插件在不在都照用）。各插件的模型命令（`/btw-config`、`/explore-config`、`/git-config`、`/beacon-config`、`/secure model`）都打开同一个可搜索选择浮层。
- **管理侧**（`~/.pi/agent/model-config.json`，`/model-config` 面板，全部操作都在面板里）：每个用途可设为某个策略或某个具体模型。
- **策略**：`AUTO`（跟随当前会话模型）与 `FREE`（只在免费模型里选，主选失败自动换下一个）语义固定、只能被选不能改；`MAX`（顶级配置）/ `FAST`（又快又好）/ `LITE`（高速廉价）/ `BASE`（便宜通用）/ `BATCH`（便宜大碗）可由用户重指到具体模型，**一处修改、所有引用该槽的用途一起生效**。
- **解析链**：本地固定模型 → 中心设置 → 插件注册时声明的默认策略 → AUTO；管理插件缺席时仍读 `model-config.json`，因此已做的设置不受影响。任何解析结果都带**故障转移链**（其余可用模型按价格升序）。
- **默认策略**：`btw.chat` / `hud-git.conflict` = FAST；`explore.subagent` / `secure.review` / `hud-git.commit` = LITE；`beacon.phrase` = BATCH；`init` / `audit` = AUTO。
- **能力约束**：声明需要读图的用途（面板里会标注「需读图」）在选模型时**只列出**具备读图能力的模型。
- **本地设置文件**：`btw-config.json` 的 `model`、`explore-model.json` 的 `model`、`status-beacon.json` 的 `model`、`secure.json` 的 `model`、`hud-git.json` 的 `commit` / `conflict`（提交信息与冲突消解各一个键）与 `fetchIntervalMin`（后台 fetch 间隔分钟，0 = 关闭）。
- 面板改完立即生效（插件每次解析都重读设置），无需 `/reload`；管理插件缺席时 `/model-config` 不可用，但设置照常生效。

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
| 行1 `↑N ↓N` | 本地比远程多/少 N 个提交（零值不显示；与 `/git` 面板同一套箭头）。后台会自动 `git fetch`（启动即一次，之后默认每 5 分钟），因此不打开面板也能看到远程的真实进度；间隔改 `/git-config fetch` |
| 行2 速率柱状图 + `🔥28/s` | 一格 = 一轮（采样窗口 40 轮），**按速度分档上色**：`<20` 红 / `20–50` 琥珀 / `50–100` 绿 / `≥100` 青（`🔥` 数字跟当前档同色）；**亮度 = 该轮输出 token 数**（越亮 = 输出越长；对数映射 `log(1+10t)/log(11)`，t = 该轮输出 ÷ 会话内单轮输出的粘性峰值，最多向背景混 62.5%，量化 1/8 档；六档大致按输出量翻倍切分；0 输出与无采样占位为 `dim`）。**宽度 = 下面那行的消耗文本宽度 − 数字宽 − 1**，因此两行的左边缘对齐（整块右对齐到竖线）。**自适应两行 16 档**：行 1 状态右对齐、柱子贴中列左端，状态不长时柱子正上方是空的，就借来画上半行；状态长到压过来时还回位置，退回单行 8 档。0 档与冷启动占位都画最低档 ▁。**速率口径**：分子 = assistant `usage.output` 增量（供应商上报，已含思考 token），分母 = 模型生成段（`turn_start` → assistant `message_end`，含网络与首字延迟，不含工具执行）；数字取整；满格值 = 会话峰值缓慢衰减（0.5%/轮） |
| 行2 `[█▊ 1m]` | 进度条=上下文窗口占用率（绿→黄→红），尾部=窗口总量（占用率高时百分比会顶掉尾部数字，如 `[█████████▏] 90%`）。**宽度跟随右列宽度**（右列按目录名 / 刷新时刻自动缩放，上限 40 格），因此右列是一条整齐的竖带 |
| 行3 `余额 ¥49.09 + 10.00` | 账户余额（主金额=充值余额，`+ X.XX`=赠送余额，无赠送则省略） |
| 行3 `订阅 周 123/500` | 订阅额度余量（Kimi Code 周额度 / 小时频限） |
| 行3 `¥0.015/min ¥1.20` | 最近 10 分钟平均每分钟消耗（估算值）+ 本会话累计消耗，仅按量付费供应商显示（订阅制显示会话 token 数，积分制显示 🪙） |
| 行3 `↻ 17:17` | 余额数据刷新时间（不是当前时间）；在右列宽度内**居中**显示 |
| 行3 `・ 低峰`（绿）/ `・ 高峰`（橙黄） | DeepSeek / OpenCode Go 官方高峰/低峰时段徽章（北京时间每日 9:00-12:00 / 14:00-18:00 为高峰）。高峰时段按官方 2 倍计价（已生效，与徽章一致） |

git 状态每 5 秒自动刷新（本地）、后台 fetch 每 5 分钟自动更新远程进度（启动即 fetch 一次；`/git-config fetch` 改间隔或关闭）；`/balance` 手动刷新余额；`/git` 打开 git 可视化面板（分支/暂存/修改/未跟踪，`s` 键一键同步：fetch→pull→push，无冲突全自动，冲突时可选「让 AI 处理冲突」或「放弃同步」）；`/hud` 开关 HUD。

**行 1 动态区**（`📁 项目名` 之后，空闲时显示「会话 Nmin」占位）：各扩展经**官方 `ctx.ui.setStatus(key, text)` 通道**推送状态（setStatus 触发全局重绘，hud 零延迟可见），HUD 按样式表（颜色 + 优先级，数字大者胜出）显示一条；TTL 由各推送方自管：

| 层 | key | 触发 | 示例 | 优先级 |
|---|---|---|---|---|
| 输入态 | `hud-bash` | 输入以 `!` 开头 | `⚡ 指令模式` | 100 |
| 结果提醒 | `task-alert-error` | 出错终止（闪烁） | `❌ 任务出错` | 92 |
| | `task-alert-wait` | ui_prompt 阻塞（闪烁） | `⏳ 等待人工：权限复核` | 91 |
| | `task-alert` | 正常收尾（闪烁） | `✅ 任务完成` | 90 |
| | `keep-idle` | 挂机 / 在场探测中（高于工具活动） | `⏳ 挂机中 · 第 3/4 件` | 87 |
| 阻塞等人 | `secure` | 命令审核中 | `🛡 正在审核命令…` | 86 |
| | `ask` | 有问卷待答（常年挂着） | `📝 1 份问卷待答 · /answer` | 84 |
| 具体活动 | `init` | `/init` 后台生成 AGENTS.md | `⚙ 初始化 · 5 步` | 80 |
| | `balance-error` | 余额接口报错 | `⚠ 余额查询失败` | 78 |
| | `img-slim` | 移出历史图片 | `🖼 21.3MB · 已移出 8 张` | 76 |
| | `web-search` | `web_search` 执行中 / 完成 | `🔍 搜索中` → `✓ 搜索 8 条` | 75 |
| | `web-fetch` | `web_fetch` 执行中 / 完成 | `🌐 抓取中` → `✓ 抓取完成` | 74 |
| | `kb-sync` | 知识库同步（含后台自动同步） | `🔄 同步中` → `✓ 下载 3 · 上传 1` | 73 |
| | `skill-hub` | 技能检索 / 安装进度 | `🔎 检索技能` → `✓ 已安装` | 72 |
| | `workflow-mgr` | 工作流摘要 | `📋 进度 3/12 · 当前：2.1 重构锁等待` | 72 |
| | `mimo-omni` | 媒体解析 / 语音合成 | `🎙 解析中` → `✓ 已转写` | 70 |
| | `model-switch` | 模型切换（3s TTL） | `⇄ deepseek-chat` | 70 |
| | `computer-use` | 桌面截屏 / 检测 / 点按 | `📸 截屏中` → `✓ 已点击` | 69 |
| | `explore` | 探索子代理进度 | `🔎 探索 3/8 · 并发 4` | 68 |
| | `keep` | 停顿点续航判断 | `🔁 续航 3/16` | 66 |
| | `qr` | 二维码生成 / 解码 | `🔳 生成中` → `✓ 二维码已显示` | 64 |
| | `draw` | 生图进度 | `🎨 生图中（草稿）` → `✓ 已出图 1 张` | 63 |
| | `kb-vault` | vault 解锁 / 口令错误 | `🔓 vault 已解锁` | 62 |
| | `clipboard` | 剪贴板读写 | `📋 读取中` → `✓ 已读取` | 61 |
| | `kb-op` | kb 工具回执（读/写/删/移/上传…共用一个键） | `✓ 已读取笔记` | 61 |
| | `btw-transfer` | btw 问答已附带进下一条消息 | `📎 已附带 btw 问答` | 60 |
| 通用兜底 | `task-alert-run` | 执行中（思考块 / 正文 / 工具） | `💭 思考中` | 58 |
| 环境信息 | `secret` | 本会话已录入的密钥/敏感文本条数 | `🔐 secret 3 条` | 57 |
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
| MiMo Token Plan CN | `xiaomi-token-plan-cn` | `GET /v1/platform/token_plan` | 额度条（已用量百分比，不标周期）；速率走积分轨（🪙） |
| MiMo Token Plan SGP / AMS | `xiaomi-token-plan-sgp` / `-ams` | 同上（区域专属 Base URL） | 同上 |
| 火山方舟 Coding | `volcengine-coding` | 无 API | 显示控制台查询链接 |
| Z.AI Coding CN | `zai-coding-cn` | `GET /api/monitor/usage/quota/limit` | MCP月/周/5h 积分额度条（大周期在前）+ 积分速率（🪙，不换算 ¥/$） |
| MiMo 按量付费 | `xiaomi` | `GET /v1/platform/balance` | 可用余额（现金 + 赠金 + 可用授信）+ 拆解明细 + ¥/min 消耗 |
| OpenRouter | `openrouter` | `GET /api/v1/credits` + `/api/v1/key` | 账户总余额 + 单 Key 限额进度条 |
| SenseNova Token Plan | `sensenova` | 无 API | 显示控制台链接 + 会话 token 累计（免费公测） |
| OpenCode Go | `opencode-go` | `GET /zen/go/v1/usage` | 月/周/5h 订阅额度条 + 等效消耗（¥/min，有汇率时） |

- 余额：官方 `GET /user/balance`（DeepSeek：充值 + 赠送）或 `GET /v1/usages`（Kimi：加油包 + 订阅额度），低余额/额度耗尽变色警示。余额行精简格式：主金额 = 充值/现金余额，赠送以 `+ X.XX` 追加（无赠送省略）。
- 速率：平均每分钟消耗，启动 1 分钟后即显示（分母=实际经过分钟数，封顶 10 分钟，之后过渡为滚动平均）。消耗统计按供应商单独适配（`BalanceAdapter.rateText`）：DeepSeek / MiMo 按量 / Moonshot / OpenRouter 等按量付费显示 `¥/min + 累计`；Z.AI Coding / MiMo Token Plan 走积分轨；其余订阅制仅显示会话 token 累计。DeepSeek 按官方人民币定价直算（`hud/hud-cost.ts` 的 `DEEPSEEK_PRICES`：缓存命中 ¥0.02/0.15、未命中 ¥1/4.5、输出 ¥4/13.5 每百万 tokens，flash / pro 两档），不再经 USD×汇率；峰谷定价（高峰 2 倍）已按官方规则生效（HUD 行 3 的「高峰/低峰」徽章与实际计价一致，见上图例）。其余供应商成本内部按**原始货币 USD** 记录，显示时按汇率换算 RMB。**汇率三态**（`hud/hud-cost.ts`）：① 实时（多源拉取 frankfurter(ECB) → open.er-api，每日快照、免 key，随余额刷新 1h 节流一次）→ ② 磁盘缓存（`~/.pi/agent/tmp/exchange-rate.json`，拉取失败时读缓存）→ ③ 无汇率（断网且无缓存，显示原始货币 USD，**不使用任何固定近似汇率**）。OpenRouter 余额：有汇率时换算 RMB（明细附原始 USD + 汇率，缓存标注「(缓存)」），无汇率时直接显示 USD 原始值。所有供应商在 HUD 第 2 行统一显示 `↑input ↓output rate/s` 的输出 token 速率；该速率为 EMA 平滑值（历史 80% + 新 turn 20%，首轮直接采用），基于 `output token / turn 实际耗时`，比长期平均更能反映当前生成速度，但不是严格的逐 chunk 实时流式速率。
- 思考折叠：默认折叠（`settings.json` 的 `hideThinkingBlock: true`），折叠标签为动画 `Thinking.` → `Thinking..` → `Thinking...` → `Thinking....`（4 帧循环，随思考过程增长），`Ctrl+T` 切换展开。
- 命令：`/balance` 手动刷新余额；`/git` 打开 git 可视化面板；`/hud` 开关 HUD。
- **额外底部行接口**：通用 `__PI_HUD_API__`（`registerExtraRows(provider)` / `notifyExtraRowsUpdate()`）——workflow-mgr 等扩展注册渲染函数，hud 只把返回的行追加到 footer 底部（屏幕最底），**内容与样式由注册方决定**。当前 workflow-mgr 使用：其常驻面板内容（任务/分工 ≈3 行，12 格进度条 + selectedBg 底色与面板同款）在底部渲染，面板隐藏；`/hud` 关闭时置 `__PI_HUD_ACTIVE__=false` 并派发 `hud:state-change`，workflow-mgr 自动注销底部行、恢复自绘面板。

说明：DeepSeek 按量付费，余额过低变色警示；Kimi For Coding 为订阅制 + 加油包（Extra Usage）混合，优先显示加油包余额，没有加油包则显示订阅额度，订阅额度耗尽或余额过低变色警示，右下角显示会话 token 累计；Kimi 开放平台（`moonshotai`/`moonshotai-cn`）为按量付费，显示现金 + 赠金余额；MiMo Token Plan（`xiaomi-token-plan-cn` / `-sgp` / `-ams`，对应 pi 的三个区域供应商配置）为订阅积分制：官方 `GET /v1/platform/token_plan`（专属 `tp-` Key）返回 `quota`。额度只有一份，响应里的 `period` 只是订阅有效期（月卡/年卡差异仅在此），因此余额行标签用「额度」（额度池不是钱），只画一根额度条（已用量百分比，两位小数），不标周期、不显示重置倒计时；消耗速率走积分轨——消息 usage 不含积分，按官方「Credits / 百万 tokens」单价（`hud/hud-cost.ts` 的 `MIMO_CREDITS`，Pro 缓存命中 2.5 / 未命中 300 / 输出 600，Flash 2 / 100 / 200，北京时间 0:00-8:00 乘 0.8 夜间系数）本地估算，显示 `🪙X/min + 🪙累计`。MiMo 按量付费（`xiaomi`）为预充值：`GET /v1/platform/balance` 返回 `cash_balance` / `gift_balance` / `frozen_balance` / `credit_available`，与 DeepSeek 同口径——主金额 = 现金，赠送以 `+ X.XX` 追加（无赠送省略），授信/冻结非空时收进明细；可支出总额（现金 + 赠金 + 授信）用于变色，速率走人民币轨。火山方舟 Coding（`volcengine-coding`）仍无公开余量 API（官方仅提供控制台查看，5h/周/月限额），余额行以灰色 OSC 8 超链接短文本显示控制台查询链接（Windows Terminal 等终端 Ctrl/⌘+点击打开；单击需 pi 端支持），完整 URL 在 `/balance` 通知里，右下角显示会话 token 累计。Z.AI Coding CN（智谱 GLM Coding Plan）为订阅积分制：余额行画 MCP月/周/5h 三窗口额度条（大周期在前，百分比 + 5h 窗口重置倒计时），积分绝对值与套餐档位收进 `/balance` 通知；消耗统计走**积分轨**（积分视为独立货币，不换算 ¥/$，统一用 🪙 符号——`CREDIT_SYMBOL`，未来所有非货币计费复用）：因消息 usage 不含积分，turn_end / 余额刷新时采样 quota 接口的「5h 窗口已用积分」做差分（30s 节流；负增量/窗口滚动仅换基线不记增量），显示 `🪙X.XX/min + 🪙累计`（采样接口不可用时自动回落为会话 token 数）。数字与颜色解耦：🪙 数字只反映额度消耗速率，颜色按 pi 内置 provider 价格（`usage.cost.total`，USD 等效成本）的速率染色——积分/min 高 ≠ 花钱多，成本速率才是价格信号。所有供应商都在 HUD 第 2 行统一显示输出 token 速率。

## 浮层统一底色（src/extensions/shared/ui.ts）

所有浮层面板（问卷、审核、模型选择、技能市场、知识库配置、Git、工作流、扫码登录…）默认铺同一层底色，叠在对话输出上时不容易看花眼。

- 底色键 `PANEL_BG = "customMessageBg"`——pi 内置主题里已有的键（自定义消息块也用），不新增主题键，换主题不会出现「少一个键就没底色」；`system` 主题在终端不报色时该键为空，等同没有底色，不会报错。
- 走 `createBoxRenderer` 的面板自动带底色（**整行铺满**，含边框与行尾留白；只给文字上底色会让行尾露白）。自绘边框的面板用 `paintSurface(theme, lines, width)` 收口。
- **提示行一律用 `box.hint(text)`**：它内部走 `row()`，铺底与补宽都跟着其它行；把裸文本（或裸 `keyHintRow`）直接 push 进面板，会在底部留下一段没有底色的横带。
- 需要无底色的场合传 `bg: false`（例如嵌在别处的小控件）。

## 上下文初始化（src/extensions/context-init.ts）

`/init`：在**后台独立上下文**中分析项目，生成/维护项目唯一的上下文文件 `AGENTS.md`——它每轮对话都会加载，所以只有「不写就会让 AI 做错」的信息才配留在里面。

- **信息按「多常被需要」分四处放**（写每行前过两问：不写它会做错吗？换一年、换个项目还成立吗？）：每轮都要用 → `AGENTS.md`；相关时才用（子系统流程、口径、坑）→ `.pi/skills/<前缀>-<领域>/`（启动只暴露一行 description，正文按需加载）；在办的事（进度、待办、当前批次）→ 该工作目录的 `STATUS.md`；跨项目可复用的经验 → 知识库。
- **一个项目一份 `AGENTS.md`**：发现子目录 `AGENTS.md` 就按上面四处分流，然后删除源文件并在总结里附映射表；`CLAUDE.md` 合并后删除。
- **顺手对齐目录**（判据「同类只住一处，一处只放一类」：脚本进 `tools/`、共享数据进 `data/`、再生品进 `output/`、临时文件进 `.tmp/`），同名不同义的目录归并；不强制固定目录树。
- 已存在时询问「合并更新 / 完全重写 / 取消」；不设轮数与时间上限（`/init cancel` 中止）；完成后由全新上下文的**审计子代理**按同一套纪律删减、合并、移出、修指针，再做结构检查（指针可达、skill 索引与 references 对应）。

## Claude Code 风格增强（src/extensions/claude-it.ts）

让 pi 的操作习惯更接近 Claude Code：

- `/exit`：与 `/quit` 等效的斜杠命令。
- `exit`：直接输入 `exit`（不带 `/`）也能立即退出 pi，不会把该文本当作普通消息发送给模型。
- **Ctrl+C**：当前 turn 正在生成时，按 `Ctrl+C` 会取消该轮输出（Claude Code 风格）；空闲时不拦截，保留默认行为。打断后 2 秒内**再按一次 `Ctrl+C`**：输入框预填 `/rewind`，回车即**回退到上一条用户消息**（丢弃其后的全部内容，消息文本放回输入框，可修改后重发）——回答不满意时的快速回退；打断本身**不触发 status-beacon 完成提醒**（视为中断而非完成）。
- `/rewind`：手动回退到上一条用户消息（内容放回输入框），与双击 Ctrl+C 等价。

> 注意：不带 `/` 的 `exit` 会被无条件解释为退出指令。如果你确实需要把单词 "exit" 作为普通问题发给模型，可临时加空格或换种说法，例如 `"exit" 是什么意思？`。

**新增供应商适配**：在 `hud/hud-balance.ts` 的 `BALANCE_ADAPTERS` 注册表里添加一个 `BalanceAdapter` 即可（参考 `deepseekAdapter` 或 `kimiCodingAdapter`）。余额/余量在 `fetch` 里实现；右下角消耗统计在 `rateText(ctx, now)` 里单独实现（按量付费用 `hud/hud-cost.ts` 共享的 `meteredRateText`，订阅制可返回 token 消耗，不需要则返回 `null`）。

## 旁支问答（src/extensions/btw/）

Claude Code 风格 `/btw` 临时旁支问答（by the way）：主任务进行中打开右侧浮层做临时问答，不写入会话历史、主会话零污染：

- **`/btw <问题>`**：打开浮层立即提问；面板内可多轮追问（Enter 输入，最多 6 轮），上下文 = 主会话（含压缩结果）+ 面板内历次问答；流式显示回答（markdown 渲染：标题/列表/表格/代码块，与主会话同一套），`Esc` 关闭并中止，`↑↓` 逐行、`PgUp/PgDn` 整页滚动（分隔行显示剩余行数）
- **`m` 转正**：面板内按 `m` 把全部问答打包暂存，随下一条交互消息附带发送（输入框只见自己文本 + 「📎 已附带」提示，不立即发出，可控可撤）
- **只读工具**：始终携带 read / ls / grep / find（无 bash）——「xx 函数在哪定义」类问题可直接查证代码，只读不写
- **`/btw-config`**：模型选择——`auto`（交给 model-config，默认策略 FAST）或任意 `provider/modelId`（本地固定），支持关键词搜索；持久化到 `~/.pi/agent/btw-config.json` 的 `model` 键；问答按价格升序故障转移（失败自动换下一个重试）。详见「模型管理」

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
| 等待人工 | `ui_prompt_start`（pi 0.84.4 新增事件）且 agent 运行中被阻塞——secure 人工确认、ask 问卷等 | `attention.wav` | 状态栏 + 标题动画（⏳/🔔 闪烁，HUD 黄色，附提示标题）；**应答（`ui_prompt_end`）自动撤，按键不撤**（用户需要按键回答提示本身） |
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

## 命令权限门（src/extensions/secure/）

bash 命令三层名单（`tool_call` 事件拦截，只管 bash）：**复合命令先拆段**（`shared/shell-split.ts`：按 `&&`/`||`/`;`/`|`/换行拆分，`$()`/反引号子 shell 递归拆出，引号/转义保护）→ **硬拒绝 deny**（命中即拒、不询问，默认覆盖 `rm -rf /`、`mkfs`、`dd` 写块设备、`curl|sh`、`chmod -R 777 /`）→ **已记住的操作 remembered**（**逐段判定：每个子命令段都要命中才放行**，防「git status && rm -rf x」被前半段连带放行）→ **关注项 watch**（命中不打断，只是把命令标记给 AI 要求从严：宁可确认一次也别放过）→ **AI 审核**（未命中名单的命令交给辅助小模型；AI 不可用——超时/无模型/网络错误/输出无法解析——降级为人工确认，文案说明是降级而非任务失败）。

- **人工确认面板**（`secure` 自有 `ReviewPanel`；**选项渲染复用 `shared/ui.ts` 的 `renderChoiceList`**，与钉钉审核面板同一套竖排样式）：**默认高亮「允许一次」**，三选项——允许一次 / 允许并永久记住这类操作（旁标将被记住的操作意图）/ 拒绝，`Esc` = 拒绝（不执行）；`↑↓` 选择、`Enter` 确认、`1-3` 直选。面板顶部是**人话信息区**（不随滚动消失）：AI 一句话解读 + 影响面（写/删/联网/凭证等）+ 命中原因（「命中关注项」等分类标签，**不展示正则原文**）；命令全文折行展示不截断，超出可视区 PgUp/PgDn 滚动，滚动余量在分隔行指示；并行工具批里多个待确认命令经 Promise 链串行弹面板。无可泛化规则时只剩两项（允许一次 / 拒绝）。
- **allow 自动记住意图**（意图缓存，避免常用无害命令反复烧审核 token）：AI 每次 `allow` 都会把「这类操作」写进 `remembered`——规则优先生效 AI 提炼的语义正则（用 `<*>` 占位可变参数，落库前校验必须能命中当前命令，否则退结构化兜底 `^命令\s+子命令`，多段命令退整串精确匹配）；护栏：硬拒绝/关注项永远优先、去重、不覆盖已有规则；每次记住都发通知且**展示人话意图而非正则**（如「已记住「查看 git 提交历史」，以后同类命令直接放行」）；**保鲜机制**：记忆规则带 `addedAt`/`lastHit`/`hits`，命中时刷新，超 30 天未命中在启动/记住时自动清理，`/secure prune` 手动清理（**过期≠失效：清理前仍生效**，状态行会写明）。
- **AI 审核**：选模型走统一模型设置——`/secure-config model` 或面板里「审核模型」打开模型选择浮层（`auto` 或具体 `provider/modelId`）；`auto` 时由 model-config 按用途 `secure.review` 解析（默认策略 LITE），可解析到会话模型/策略槽/具体模型，失败按价格升序换候选；`completeSimple` 单次调用不占主会话上下文；进度经官方 `setStatus("secure", …)` 通道推送（hud 行 1 动态区，未登记 key 默认灰字）；allow/reject 结论会话级缓存（同一精确命令不重复审核），review 不缓存（每次由人决定）；
- **sudo 授权通道（密码即授权，仅当次有效）**：AI 在 bash 里直接写 `sudo` 会被拦截打回并引导改用 `sudo_exec` 工具（`command` 不带 sudo 前缀，整条以 root 执行）；调用时弹整屏授权面板——命令全文折行展示（PgUp/PgDn 滚动）+ 掩码密码框（提示写明「密码仅用于本次执行，每次提权都需重新输入」），Enter 授权 / Esc 拒绝，密码错误原地重试共 3 次；扩展内 `sudo -kS` 从 stdin 喂密执行，`-k` 使凭据不被缓存（收尾再补 `sudo -k` 双保险），**每次调用必重新弹窗授权**；密码只经扩展内存，不进会话历史/工具结果/磁盘；NOPASSWD 免密账户退化为确认弹窗（仍逐次授权）；`requiretty` 或未装 sudo 时明确报错请用户手动执行；`/secure sudo on|off` 开关（配置项 `sudoExec`，默认开）；
- **配置**：`~/.pi/agent/secure.json`（首次运行自动写默认配置；手动编辑，无管理面板）——`enabled` 总开关、`deny` 硬拒绝正则列表、`watch` 关注项正则列表、`remembered` 已记住的操作（`{pattern, intent, addedAt, lastHit, hits}`）、`aiReview`（false = 未命中名单一律转人工确认）、`sudoExec`、`model`；无效正则跳过并在 `/secure` 状态里提示（附配置路径）；
- **命令**：`/secure` 查看状态（开关/审核模型/sudo 通道/已记住条数含过期提示/关注项与硬拒绝条数/无效正则/配置路径）+ `on|off` 开关、`sudo on|off`、`reload` 重读配置、`prune` 清理过期记忆；**`/secure-config` 配置面板**（AI 审核开关 / 审核模型 / 审核超时 / sudo 通道 / 硬拒绝与关注项名单；带参可直设 `aiReview|sudo on|off`、`timeout <秒>`、`model <auto|id>`）。**名单编辑**：输入即校验正则（非法拒绝保存）+ 一行「测试命令」实时看是否命中 + `deny` 删除需再确认一次，Ctrl+D 删除、Enter 编辑。

## 探索子代理（src/extensions/explore-agent.ts）

`explore` 工具：一个任务 = 一个只读子代理（read/ls/grep/find），并行探索代码库并交回结构化报告，主上下文不加载原始文件内容。

**成果渐进落盘**（不白烧 token）：子代理每轮的正文与检索轨迹实时写进项目内 `.pi/explore/tasks/<任务哈希>.partial.md`，报告文件 `.pi/explore/report.md` 同步重写——跑的过程中就能打开看着它长，不必等最后一次性总结。

**断点续跑**：同一任务文本第二次调用会直接复用已完成成果（`tasks/<哈希>.md`，零 token）；上次被中断的任务会带着半成品作为起点继续跑（提示词里明确「不要重复已验证的检索」）。要强制重跑传 `fresh=true`。

**上下文与轮数兜底**：上下文超限（各家措辞都识别）→ 把过程记录压缩成要点后继续跑（每任务最多 2 次）；轮数用尽或没有正文产出 → 用过程记录整理出报告。超时/网络中断/进程被杀时，返回结果里会带上「中断前已确认的部分」，半成品留在磁盘上等下次续跑。

`/explore-config` 选择子模型（`auto` = 交给 model-config，默认策略 BATCH；或指定 `provider/modelId`）。

**与 `/init` 的联动**：`/init` 的子代理会探测本插件挂载的 `__PI_EXPLORE_API__` 契约（`shared/explore-api.ts`）——探索工具在场时子代理可自己派探索子代理并行摸底（大仓库先摸目录/命令/架构/约定，再用 read 抽查），状态栏显「⚙ 初始化 · 探索 n/m」；此时一律现跑、不复用历史成果，其他情况（未装/被禁用）自动退回自读模式。

## 联网工具（src/extensions/web-tool/）

注册 `web_search`（多源搜索）与 `web_fetch`（抓网页转 markdown）两个自定义工具：agent 查实时信息（GitHub issue、文档、新闻、价格）时搜索，需要深读时抓取。默认全部**零 API key 零费用**（不依赖 kimi 订阅）；另有一个付费 provider 可按需选用。

- **`web_search` 多源搜索**：`query` + 两个正交参数——`provider`（**由谁搜**：`free` 默认 / `deepseek`）与 `source`（**搜哪类资源**：`web` 默认 / `npm` / `github`）；返回 标题+URL+摘要 列表（**最多 15 条**），无 AI 总结——由主 agent 自行判断；
  - **通用网页**（`source: "web"` + `provider: "free"`）：cn.bing.com RSS + 360 搜索 HTML + 百度搜索 HTML **三源并行**（baidu 块级 `mu` 属性直取真实 URL，摘要从 `s-data` 注释 JSON 解析；第三源选型实测否决：DuckDuckGo 两端点 202 反爬、Jina 不可达、Mojeek 403），结果**逐条评分合并**（不再整源择优）：标题/URL（仅 hostname+pathname，query 参数是搜索词 echo 不计）/摘要按权重逐词计分 + 完整查询短语命中强加成 + 标题全命中加成；跨源去重（URL 规范化去跟踪参数 / 标题归一化）后按分数降序取前 15 条——bing 泛化查询（如「陕西师范大学」被吞成长尾词）混入的低相关条目自然沉底，三个源的高质量条目都能入选，混合时**按来源分组展示**（`[bing]`/`[so360]`/`[baidu]` 组标题，组内分数降序、序号全局连续）；限流时 bing 只回 1 条占位，评分 0 自动滤除（实测 360 稳定、`data-mdurl` 带真实 URL）；评分权重在文件顶部可调；
  - **DeepSeek 付费**（`provider: "deepseek"`）：DeepSeek 官方 Search API（结构化 JSON，服务端 `rerank_score` 排序 + `authority`/`date` 元信息，长摘要 `summary` 截 400 字附在摘要尾部），**每 1000 次成功搜索 5 元**、失败与无结果不计费；凭证复用 pi 已配置的 `deepseek` 供应商 key（`ctx.modelRegistry`，插件不另存）；结果按 `rerank_score × 差评系数` 排序滤除（不重算关键词分——服务端语义排序比词面匹配准）；
  - **付费源的发现方式**：**不写进工具描述**——否则模型每次搜索都会优先选它、白白花钱。改成免费搜索成功时在结果末尾提一次「不满意可换付费源」+ 调用方式，且**每个会话只提一次**（`sessionId` 记账，`session_shutdown` 清账）；未配 key 时完全不提；
  - **npm / GitHub 垂类**（`source: "npm"` / `"github"`）：走官方免费 API，本身不收费也没有付费替代，因此 `provider` 不适用（传了付费 provider 会在结果顶部给一行忽略告警）；npm 查包名/版本/描述/主页；GitHub 查仓库名/简介/语言/星数；pypi.org 搜索页有 Client Challenge 反爬，Python 包走默认网页搜索（如 `site:pypi.org/project/`）；
  - **参数容错**：`provider` / `source` 的 schema 用 `Type.String` 而非枚举——枚举会把非法值在校验阶段就拒掉、白白耗掉一轮重试；写成 String 则非法值能进到执行层，**照常返回结果 + 顶部警告列出合法取值**，不浪费对话；
  - **供应商实测**（2025-10 全量探测）：除 DeepSeek 外均不可用——智谱 `web_search` 余额不足、Kimi/小米/opencode-go 的 kimi 是服务端工具调用（拿不到结构化结果且需先跑一轮模型）、opencode 的 gpt/gemini 模型访问权未开通或被地区/隐私设置拦截、火山与 SenseNova 无此端点；新增付费源只需在 `providers.ts` 的 `PAID_PROVIDERS` 加一条 + `searchPaid` 加一个分支；
- **`web_fetch` 抓取转 markdown**：`url` + 可选 `maxChars`（默认 12000、上限 60000）；HTML 经 domino 解析 → 启发式选正文容器（article/main/常见内容 class，回退 body）→ turndown(+gfm) 转 markdown（表格/代码块/列表/引用）→ 相对链接补全为绝对 → 压缩空行/截断；**GitHub blob URL 重写为 raw 直取**（blob 页行号/按钮噪音大，raw 纯文本原文直出、防源码被当 HTML 标签吞掉）；**正文极短（JS 空壳）用 Googlebot UA 重试一次**（不少 SPA 只对搜索引擎爬虫做预渲染）；非 HTML（PDF 等）与抓不到的站点如实报错并提示改用搜索；
- **被墙自动代理重试**：直连与降级**并行竞速**——直连（含换 UA）与系统 curl（自动 `-x` 代理，TLS 指纹不同可绕过 GitHub 等对 Node 的 301 挑战）同时发起，谁先成功用谁、另一条立即掐断；被墙站点 curl 秒回，不傻等直连连接黑洞超时；404 等确定性错误立即判死（任何传输方式结果相同）；两条皆失败才认定失败并聚合错误；curl 缺失时降级退 Node 内置 net/tls CONNECT 隧道（**零新增 npm 依赖**）；代理由 **`/web-tool-config`** 命令设置——无参数打开设置面板输入 `http://` 地址（Enter 保存 / Esc 取消 / 清空回车 = 清除），或 `/web-tool-config <url>` 直接设置、`/web-tool-config off` 清除、`show` 查看；设置持久化到 `~/.pi/agent/web-fetch-proxy.json`（**不读环境变量**，避免系统 HTTPS_PROXY 意外生效）；仅支持 `http://` 代理（Clash/V2Ray 等本地代理的常见形态）；web_search 的搜索请求同样享受代理降级；
- **token 节约**：正文提取 + 截断，实测 100KB HTML 页面 → 约 800 字符 markdown；turndown/domino/gfm 由 build.js（esbuild）内联进单文件产物，运行时零外部依赖（build.js external 白名单只留 `@earendil-works/*` 与 `typebox`）；
- **差评降权（动态黑名单）**：`web_dislike(domains, reason?)` 工具——AI 深读某条结果发现内容与标题不符/灌水/死链时对其域名记差评，持久化到 `~/.pi/agent/web-search-blacklist.json`（跨会话生效，**无需维护域名白名单**，降权对象由使用中自然沉淀）；搜索评分按差评次数降权（`×0.6/次`），累计 5 次直接滤除该域名条目（子域名同样受降权，父域不受）；**免费三源与付费 DeepSeek 共用同一份黑名单**；`/web-tool-config blacklist` 查看（累计次数/降权系数/原因）、`blacklist clear` 清空；
- **可调配置**：文件顶部「可调配置」区（源顺序、结果数、超时、字节/字符上限、差评降权系数/封禁阈值），改后 `node install.js` 重装生效。

## 技能按需获取（src/extensions/skill-hub/）

让 agent 在缺能力时自己找技能、看清内容、装进项目或卸掉。索引与文件都走可达通道：**GitHub 直连（clone / api / codeload）在国内网络下经常被重置**，所以检索与审计走 skills.sh、版本定位与逐文件取回走 jsDelivr，网络层复用 `shared/http`（直连 → 代理 → curl 逐通道降级，代理配置与 web-tool 共用一份）。

- **`skill_search`**：按能力描述检索技能目录，返回名称、来源仓库与安装量；
- **`skill_inspect`**：取回 SKILL.md 全文 + 文件清单 + 审计结论，并给出信任判定；`source` 接受 `owner/repo`、`owner/repo/skillId`、GitHub 链接；
- **`skill_install`**：装进项目内的插件私有目录 `.pi/skill-hub/skills/<名>/`。**两段式**：首次调用只回执行计划（来源、版本、文件清单、信任依据、目标路径），带 `confirm=true` 重入才落地，装完排队 `/reload`，之后可用 `/skill:<名>` 或由模型按描述自动调用；
- **`skill_uninstall`**：只删**账本里记着的**（= 插件自己装的）技能。同样是两段式，人工确认后删目录并清账本；
- **`/skill-hub` 技能市场面板**（无参打开，人用）：一屏搞定浏览 / 搜索 / 收藏 / 安装 / 卸载。搜索行输入词回车打 skills.sh，列表里 ★ 是收藏、`[已装]` 是状态、右侧对齐安装量；选中项下方另给三行细节——**描述**（SKILL.md 声明的那段，最多两行）、**审计**（逐家着色）、**规模**（文件数 + 版本），按需拉取并缓存，不重复打网络。`↑↓` 选择 · `Enter` 安装或卸载 · `f` 收藏 · `/` 搜索 · `r` 刷新 · `Esc` 关闭。**不可逆动作在面板内二次确认**（安装先列文件与审计，卸载先列目录），人按下那一次 Enter 就是授权，不再叠一层 review 面板；
- **收藏**：全局存 `~/.pi/agent/skill-hub-favorites.json`（跨项目，像主题一样属于个人偏好），面板里按 `f` 或 `/skill-hub fav <owner/repo/skill>` 切换。**agent 检索时匹配到的收藏项会置顶并标 ★（用户已收藏）**，`skill_inspect` 也会在头部标出来——收藏是人的偏好，模型据此优先推荐；
- **其它子命令**：`list` 文本列出已装与收藏（非交互场景用）；`remove <名>` 卸载；
- **为什么单独放一处**：AI 装的技能与手动放进 `.pi/skills/` 的技能混在同一层时，既分不清谁装的，卸载也会变成危险操作（可能删掉人写的技能）。放在插件自己的目录里，「能卸什么」与「插件装了什么」严格一致——卸载天然止步于自己那份账本。该目录由扩展的 `resources_discover` 事件注册给 pi（pi 只扫 `skills/` 与 `.agents/skills/`，别处必须显式声明）；
- **信任策略**：仓库命中精选名单（anthropics/skills、badlogic/pi-skills、vercel-labs/agent-skills、obra/superpowers、mattpocock/skills）**或**审计全部 Pass，即免掉人工面板；技能带可执行文件（`scripts/` 等）或非文档文件时，**无论来源多可信一律人工确认**——审计扫的是已知风险，看不到模型会怎么用这些脚本。审计通过的门槛是**端点返回几家就判几家、全部 Pass**（当前五家：Gen Agent Trust Hub / Socket / Snyk / Runlayer / ZeroLeaks）；
- **账本**：`.pi/skill-hub/installed.json` 记每个已装技能的来源仓库、版本标签、安装时间与文件清单，卸载与排障都以它为准；
- **取回容错**：jsDelivr 的文件清单来自仓库索引，个别文件 CDN 侧取不到（404、或主站 301 掉到不可达的 raw 域名）是常态，此时主站失败会自动换 gcore 节点；仍取不到的照常安装并在回执里列出——SKILL.md 拿不到才中止。体积过大的文件（示例 GIF、视频）按上限跳过而非放弃整包，回执会写清原因。

## 剪贴板工具（src/extensions/clipboard.ts）

为 AI 提供系统剪贴板的读写能力，零原生依赖（产物保持零外部依赖单文件）：

- **`clipboard_get([maxChars])`**：读取当前剪贴板文本（用户最近复制的内容，适合「看我复制的xxx」/把链接/代码/文本拿进来处理）。默认最多返回 50000 字符、上限 200000，超长截断防撑爆上下文；空或仅含图片等非文本内容时给明确提示。
- **`clipboard_set(content)`**：把文本写入剪贴板（AI 编辑结果写回，用户直接 Ctrl+V 粘贴；空字符串 = 清空）。返回时报告**被覆盖旧内容的摘要**（长度 + 前 40 字符），让 AI 与用户感知覆盖了什么——剪贴板常存敏感内容（密码/密钥），工具描述提示 AI 写入前先 `clipboard_get` 确认。
- **`/clipboard`**：用户自查当前剪贴板内容；`/clipboard clear` 清空。

跨平台实现（均为系统自带命令，无需额外安装）：Windows 用 PowerShell `Get-Clipboard -Raw` / `Set-Clipboard -Value`，macOS 用 `pbpaste` / `pbcopy`，Linux 用 `xclip`（缺失退 `xsel`）。读写统一经 `os.tmpdir()` 临时文件中转再删（规避 PowerShell 5.1 管道输出 UTF-16LE 的编码乱码、规避命令行转义）；读时把 CRLF/CR 归一化为 LF（Windows 剪贴板物理存 CRLF，与 mac/Linux 的 `\n` 输出对齐）。

## 二维码工具（src/extensions/qr.ts）

为 AI 提供二维码的编码与解码能力，并把 AI 生成的二维码直接显示在用户界面：

- **`qr_encode(text, ecc?, save?, pngWidth?)`**：把文本（URL、Wi-Fi 配置、名片、任意文字）编码成二维码并**直接显示在用户界面**——图形终端（kitty/iTerm2 图形协议）显示 PNG 真图；普通终端用 Unicode 半块字符（▀）显式黑白 ANSI 绘制（暗模块=黑、亮模块=白、含 4 模块静区，逐字符着色不依赖终端主题背景），1 cell 宽 × 半行高的模块近似正方形，**可直接扫码**。默认纠错级别 M（L/M/Q/H 可调），默认落盘 PNG（`os.tmpdir()/pi-qr-<时间戳>.png`，边长默认 512px，128~2048 钳制），路径随结果返回。
- **`qr_decode(path)`**：从图片解码二维码——支持本地文件路径或 http(s) URL，PNG/JPEG（qrcode/jsqr/pngjs/jpeg-js 纯 JS 解码，由 build.js 内联进产物），自动尝试正反色、小图最近邻放大；返回码内文本与版本/尺寸元信息。
- **`/qr <文本>`**：用户侧快速生成二维码并显示，按任意键关闭。
- **会话回放安全**：details 只存原文（不存矩阵/PNG，会话文件不膨胀）；渲染时从原文同步重新编码，历史会话重新打开时二维码照样渲染。
- 状态推送 `qr` 走 shared/status 联动 hud（行 1 动态区 accent 色）；回归测试 `node src/extensions/qr/test/qr.test.mjs`（esbuild bundle + jiti 加载，14 场景）。

## 桌面操作（src/extensions/computer-use/）

把真实桌面交给 AI 操作。**双通道感知**：UIA 控件树给精确控件（类型、名字、包围盒，可 Invoke 时连鼠标都不用动），OmniParser 视觉检测补 UIA 看不见的地方（Canvas / 游戏 / 远程桌面 / 未开无障碍的应用）。两者合并成带编号的元素表，并画出编号一致的标注图——AI 看标注图判断"3 号是亮度卡片"，元素表告诉它"点 3 号 = 点 (289,462)"。

- **激活制**：十个工具常驻注册（动态注册会让 prompt cache 失效，代价比省 token 大），但**激活前一律拒绝执行**。`cu_activate` 弹一次授权确认，同意后在返回文本里给完整用法、屏幕尺寸、当前焦点窗口与边界条件——工具描述本身因此压到最短，长文本挪到"真要用时才付"的位置。
  - `cu_activate` / `cu_windows([choose])` / `cu_screenshot([detect][, conf])` / `cu_elements([vision][, maxNodes])` / `cu_click([element] | x+y[, button][, count])` / `cu_type(text[, element| x,y])` / `cu_key(keys)` / `cu_scroll(amount[, ...])` / `cu_drag(...)` / `cu_dialogs()` / `cu_upload_file(path[, hwnd][, submit])`
- **动作前自动归还焦点**（本扩展最关键的适应机制）：pi 的问卷/确认框/任何 UI 交互都会把焦点抢回 pi，AI 每调一次工具也可能改变焦点——**焦点不在目标窗口是常态，不是异常**。所以每个动作前先取当前前台窗口，不在感知窗口就调 `activate` 主动切回去，切成功再动手。判据以"切完实际读到的窗口"为准而非 activate 的即时返回值——系统完成切换有延迟，早期版本会误报"切回失败"。切不过去才如实报告"本次动作会作用在 B 上"。
  - **挂接的必须是「目标窗口线程 ↔ 当前前台线程」**：早期版本挂的是「本线程 ↔ 前台线程」，对由别的进程承载的模态框（原生文件对话框正是此类）永远返回失败。这是"对话框永远切不回前台"的根因。
  - **模态框优先**：检测到前台是模态窗口（有 owner 且 owner 已被禁用）就直接把它当目标，不再切回"上次感知的窗口"。否则会把模态框顶到后面——而对话框一旦失去前台，UIA 树会退化成没有 ValuePattern/InvokePattern 的空壳 Pane，用户既动不了框也动不了被禁用的宿主，整个流程卡死。
- **锁屏/安全桌面直接拒绝**：`GetForegroundWindow` 返回 0 或进程退化为 Idle/LockApp/LogonUI 时，动作类工具一律拒绝并说明原因——锁屏下的点击与按键不会生效，继续执行只会让 AI 误判。
- **动作后全屏差分**：不按元素框比较。实测往记事本输入一行中文，元素框接近整窗，降采样后差异被稀释到 0.0%，工具报"画面没变"而文字已进去——**区域越大、变化越局部，平均法就越瞎**。改为前后两张全屏图按 32×32 分块比对，直接报"哪里变了、多大范围"，单块变化（光标闪烁）被门槛压掉。
- **检测参数按任务调，不按场景调**：`conf` 统一 0.08、输入长边 1024。`0.25`/`640` 是 OmniParser 论文给"图标识别"（少而准）的建议值，而本任务要"发现界面上有哪些可操作的东西"（宁多勿漏）——实测同一张桌面 0.25 只出 33 个框、0.08 出 103 个；输入长边 640→1024 让桌面图标召回从 8 涨到 16，多花 20ms。**漏掉的东西模型无法补回来，多给的可以靠标注图分辨**。早期版本按"桌面 vs 窗口"动态切换两套阈值，后来发现是伪需求：问题在默认值设错，不在缺自适应。
- **场景判据用窗口类名而非进程名/标题**：`Progman`/`WorkerW` 才是桌面窗口的固定标识。判据曾用 `proc === "explorer"` + `title === "Program Manager"`，标题会随系统语言变、进程名又被文件资源管理器共用，两头都不可靠。现在 `isDesktopScene` 只剩两个用途（桌面放行、排除任务栏区域），与检测参数无关。
- **视觉框要裁到焦点窗口**：视觉检测跑全屏截图，UIA 只返回焦点窗口——不裁剪的话，其他窗口里的图标会混进当前界面的元素表（实测纸牌窗口只占左上角，右侧终端的控件却被算进它的元素表）。桌面场景还要额外排除任务栏区域，否则开始按钮会被当成桌面图标（实测按"左上角第一个"筛选时点出了开始菜单）。
- **坐标系只有一套**：宿主声明 PerMonitorV2 DPI 感知，截图/UIA/点击参数全是物理像素，中间不做换算。
- **文本输入三级降级 + 双层校验**：UIA `ValuePattern` → 剪贴板 + `Ctrl+V` → 逐字符 SendInput。前两级不受输入法影响；含非 ASCII 而前两级都不可用时直接报错——实测中文 IME 会拦截 SendInput 的 Unicode 并组合（"CU type test 123" → "CU 3333...3333"）。UIA 写完后做**两层确认**才采信：控件层读回 `Current.Value` 比对（`SetValue` 不抛异常 ≠ 值进去了），渲染层再抓图比对（Edge 这类 Web 视图会静默接受写入却不渲染，控件层读回还是新值——只信回读会把假成功报给 AI）。任一层不过就继续降级到剪贴板。另：选元素时 `setvalue` 优先选支持 `ValuePattern` 的那一层，否则记事本的编辑区会选中不支持写入的内层 Pane。
- **原生文件对话框（`cu_dialogs` / `cu_upload_file`）**：打开/保存/上传选择框是一类系统固定形状的 UI，但对 UIA 很不友好——实测浏览器触发的 IFileOpenDialog 把文件名框与按钮整棵报成 `ControlType.Pane`，ValuePattern / InvokePattern 全缺，按"元素编号点击"或"ValuePattern 写值"两条路都走不通。所以识别走 Win32（类名 `#32770` + `GetDlgItem` 能拿到文件名框），操作也走 Win32：`WM_SETTEXT` 写路径（不经键盘，中文路径不会被输入法打乱，实测读回一致）、`BM_CLICK` 提交（失败依次兜底 Enter → WM_COMMAND IDOK），最后**等窗口真的消失**才算提交成功——报"已提交"而框还开着，AI 会接着做下一步。
  - 两个坑记牢：① 对挂死（未响应）的窗口调 `GetDlgItem` 会跨进程阻塞，能把常驻宿主卡死，所以先 `IsHungAppWindow` 判掉；② 写完路径要等主按钮从 disabled 切回 enabled 再点，路径解析耗时随机器浮动（实测 100~800ms），固定 sleep 是赌。
- **性能预算**（每个动作都会付的成本）：动作差分用**宿主内采样的灰度块网格**（抓屏+采样 20~30ms）而不是"抓屏存 PNG（200ms）+ Node 解码（150ms）"——后者在动作前后各一次，等于每个动作白付 600ms。剪贴板读写走宿主 P/Invoke（写 7ms / 读 2.5ms），早期 `Get-Clipboard` 独立进程是 965ms/次。窗口枚举带进程名缓存（194ms → 3ms）。UIA 树不读 `IsEnabled`（前端不用它，Firefox 657 节点省 76ms）。
- **构成**：`platform/win32-host.ps1` 常驻 PowerShell 宿主（行协议；ping 1ms、抓屏+网格 ~25ms、UIA 热调 ~350ms、焦点 ~24ms、冷启动只付一次），`platform/win32.ts` 是其 Node 封装，`model/` 是纯 JS 预处理 / ONNX 推理 / 标注渲染，`focus.ts` 是窗口身份与焦点归还，`verify.ts` 是差分（PNG 与网格两条入口，算法一致）。
- **外部依赖**：`onnxruntime-node`（经 `static/deps.json` 全局安装，扩展按绝对路径动态 import——带原生二进制内联不进产物，故该扩展目录有 `build-external.json`）+ OmniParser icon_detect 权重（~12MB，hf-mirror 回退 huggingface）。缺任一者时视觉通道自动降级为只用 UIA 并说明怎么装。
- 回归测试 `node src/extensions/computer-use/test/computer-use.test.mjs`（预处理/坐标映射/元素合并/差分/输入降级/焦点失配/锁屏判定/视觉框裁剪/网格差分/对话框识别与提交约束/模态优先/剪贴板走宿主）。真实桌面联调需人工在场（含"弹出原生文件对话框→cu_upload_file 提交→确认关闭"），不进回归。

## 生图（src/extensions/draw/）

pi 把生图模型归为**无状态的工具层能力**（`type: "image"`）：它不出现在 `/model`、没有「当前生图模型」这个设置，只能在 codemode 里用 `models.generateImages(model, …)` 显式传模型调用。让模型自己在候选里挑就是赌运气——`getAvailableOfType("image")` 只保证凭证有效，不保证真能出图。

本仓库的做法是把它收进配置，并暴露成普通 tool call：

- **由模型插件负责登记**（各自按 pi 的 image 协议注册 `type: "image"` 条目 + `images` 表实现，例如 OpenRouter 的 seedream）。生图模型不出现在 `/model` 里，它们是另一条协议，不是聊天模型。
- **draw 负责调用**（`src/extensions/draw/`）：只读 `ctx.modelRegistry`，不碰任何插件的数据文件，因此任何按 pi 协议注册的 image 模型都能用。

**`draw_image(prompt, tier?, size?, ref?, out?, preview?)`**

- 参数里**没有 model 字段**：「选错模型」在 schema 层就无从发生，模型只由配置决定。模型只能表达意图：`tier` = `draft`（草稿，默认）或 `final`（交付成品）。
- 每个档位是一条**主备链**：前一个失败（限速、额度、上游报错、模型不可用）自动换下一个，整链失败才报错，并逐条带回失败原因。
- 默认落盘到项目内 `.pi/images/`，`out` 可指定文件名（仅单张时生效）。
- `preview=true` 才把图一起回给自己看——默认只返回路径，避免每张图都进会话历史被逐轮重发（参见 `img-slim` 的预算问题）。
- `ref` 传参考图路径走图生图（上游最多三张）。

**`/draw-config`**：无参开面板（↑↓ 选档位/设置 · Enter 进链条编辑：追加、替换、上移下移、移除；可搜索过滤，候选只列已注册的生图模型）；带参直设：`set <draft|final> <provider/model[,provider/model]>` 设主备链（逐项校验必须是真实注册的 image 模型）、`out <目录>`、`size <宽x高>`、`list` 列出可用生图模型。配置存 `~/.pi/agent/draw.json`，改完即时生效，无需 `/reload`。

面板自绘（复用 `shared/ui` 的 `createBoxRenderer` / `renderChoiceList`），动作菜单也在面板内完成：不可执行项标灰注明原因（已是首选 / 末位 / 需保留一个），Esc 逐级返回。

状态推送 `draw` 走 shared/status 联动 hud（行 1 动态区 accent 色）。回归测试：`node src/extensions/test/draw.test.mjs`（工具与配置）与 `node src/extensions/test/draw-panel.test.mjs`（面板，60 项）。

## 图片请求体预算（src/extensions/img-slim.ts）

防止「上下文里的历史图片把请求体撑爆」导致上游 413（DeepSeek 直连/中转实测上限 ≈48 MiB：46.4MB 通过、52.6MB 失败；超限报错形态为 openresty 的 413 HTML 或中转的 `413 {"Upstream response was not valid JSON"}`）。根因是 pi 会把分支内历史图片**每轮原样重发**且无淘汰，而上下文 token 估算把每张图只记 4800 字符 ≈1200 tokens（DeepSeek-flash 窗口 1M ⇒ 要 ~820 张图才可能触发自动压缩，**请求体上限永远先到**；实测某会话 76 张/75.6MB 起连续 413、全天涨到 186 张/186.5MB，纯文字追问也一起报错）。

四层防护（按代价从低到高）：

- **新图瘦身**（`tool_result` + `input` 钩子）：工具读入与用户粘贴的图片按类型重编码到单图预算内——照片（jpeg 源）≤900KB base64、图形/截图（png/gif/webp 源）≤1.6MB，最长边 2000px；**动图 WebP 强制取首帧转静态 PNG**（上游会 400 拒收，且历史重发会让后续每轮都失败）；小于 300KB 不碰。pi 自带的 `resizeImage` 是「PNG 优先、装不下才退 JPEG」，本扩展改成**以体积决定格式**：同尺寸下 PNG 与 JPEG 取小者，未超预算时绝不接受降分辨率。
- **轮末泄洪**（`turn_end` 钩子）：模型可见图片总量超 32MB（base64）时，把最旧的图片**永久**移出上下文（`context_edit` 边界草稿，原图仍在会话记录，需要时重新 `read` 即可），并且**一次泄到 20MB 以下**、最新 4 张永不移动。低水位而非「丢到刚好够」，是为了让之后的新图都是纯尾部追加：prompt 前缀命中缓存、零重付，而不是每来一张图就断裂一次前缀（那样每次都要整段重计费）。
- **请求级兜底**（`context` 钩子）：单轮内塞进太多图、轮末泄洪还没到时，只在本次请求里把最旧图片换成占位文本（会话记录不动）；会话已积累超过 40MB 时新图按半预算处理。
- **`/img-slim`**：报告模型可见图片张数/体积与水位；`on|off` 本次会话开关。

取舍（实测，1400×900 渲染截图）：**格式比分辨率更划算**——同尺寸下 JPEG q86 只有 PNG 的 16~31%（2151KB → 398KB），视觉几乎无损，且不动分辨率；无损 WebP 反而比 PNG 还大或只小一点（1663KB），灰度只省约 23% 但丢掉颜色语义，降饱和几乎不变（PNG 是无损压缩，减色不减字节）。真正的分辨率杠杆：1400px+JPEG q90 平均 433KB、1024px+q85 平均 198KB，但那会丢细节，默认不做（改 `MAX_SIDE` 即可）。已知限制：APNG（动图 PNG）在 pi 的图片嗅探层就被判为非图片（会当文本读入），钩子层拿不到 `ImageContent`，无法在此修复。

## 会话任务面板（src/extensions/workflow-mgr/）

AI 是流程指挥者（拆解、排序、验证、推进），用户是执行者（做任务、拍板）。对 AI 说「帮我规划 X」，它用 `wf_workflow` 建出阶段→任务工作流，常驻面板随即出现。

- **数据按会话隔离**：`~/.pi/agent/workflow/<项目标识>/<会话 ID>/{workflow.json,state.json}`（`PI_WORKFLOW_HOME` 可覆盖）。项目标识 = 目录名 + 路径哈希，同一项目的多个会话各写各的文件、天然互不干扰，`resume` 恢复会话即带回其工作流；面板开关 `config.json` 全局单份，归档移入 `<项目标识>/archive/`。工作流数据不进项目 `.pi/`。
- **协作模式（`mode`）**：缺省 `human-ai`（AI 指挥、用户执行）；`agent` = 纯 agent 自动驾驶（不显示人类分工，AI 用 `wf_switch` 连续推进到全部完成并 `wf_workflow archive` 收尾，卡住用 `wf_block` 停下报告）。
- **常驻面板**：输入框下方背景色区块——当前任务 + 阶段 + 右对齐进度条、分工两行 `你:/AI:`（多项「、」连接，agent 模式隐藏「你:」）、阻塞提示；宽度自适应（`visibleWidth`）。hud 开启时改由 hud 在 footer 最底部渲染同款内容（经 `__PI_HUD_API__.registerExtraRows` 注册，`/hud` 关闭后自动恢复自绘），`showPanel=false` 时一并隐藏。
- **工具（5 个）**：`wf_workflow`（`list`/`add`/`edit`/`remove`/`archive`/`import`——初始化优先 `import`：写一份草稿 json 一次性导入，id 自动生成、`deps` 可引用本批未来 id、非空时拒绝；`archive` 可带 `status` 描述收尾状态，归档 ≠ 完成、快照保留真实状态）、`wf_status`（当前任务+分工+交付物+完成信号+下一步+阻塞项）、`wf_switch`（推进核心：无参 = 完成当前并开始下一个依赖满足的任务；`taskId=X` 显式切换；`complete=false` 搁置当前回 todo；切到 blocked 任务即解除阻塞）、`wf_block`、`wf_rollback`。
- **命令**：`/wf` 状态摘要；`/wf-config` 无参功能浮窗（进度总览 / 常驻面板开关）。
- **AI 角色注入**：`before_agent_start` 仅在存在非空工作流时把角色指南追加进 systemPrompt（不进对话），无工作流时零注入。
- **渲染回归测试**：`node src/extensions/workflow-mgr/test/render.test.mjs`（17 场景 A~R）、`node src/extensions/workflow-mgr/test/stale-ctx.test.mjs`。

## 知识库（src/extensions/webdav-kb/）

给 AI 用的云网盘（WebDAV 驱动）：AI 自发沉淀有用的东西（技术笔记、踩坑记录、参考资料摘录），需要时自发检索；本地镜像离线可用，人类用 `/kb` 面板查询引用。14 个 `kb_*` 工具 + `/kb`（检索/引用，`/kb sync` 手动同步）、`/kb-config`（WebDAV/vault 口令配置）两个命令。

- **四命名空间**：`/notes`（永久知识）/ `/references`（文档摘录，markitdown 产出）/ `/scratch`（临时草稿，可随时清理）/ `/vault`（加密区：需口令解锁、口令只存内存、密文仅 kb 工具可读写，口令忘了=数据永久丢失）；路径必须分层 `/命名空间/用途/自由层级/文件名`（至少 4 段，禁止命名空间/用途下放裸文件）；
- **分类层级守则（PROTOCOL.md）**：`/references` 第 2 层按文档功能**六值判定**（知识文献/规范文书/操作指南/数据名录/表单模板/素材资源，互斥判整体体裁），`/notes` 按知识主题类判定（技术笔记/研究笔记/方法总结/工作职业/生活管理/兴趣创作）；自由层级由 AI 管理（<3 个文件并入相近层、长期 <2 个文件的层并入、层级名禁项目名/来源形态/编号前缀）。守则本体 = 网盘根 `PROTOCOL.md`（跨设备同步、用户可直接编辑迭代，`kb_help` 优先读它、缺失回退内嵌默认版 protocol.ts）；`PROTOCOL.md` 对 `kb_list`/`kb_status` **不透明**（守则走 `kb_help` 专用通道，不混入内容浏览，`kb_search` 保留索引作兜底旁路）；
- **本地镜像 + 增量同步**：所有读操作（搜索/面板/AI 工具）打在本地镜像（毫秒级、离线可用）；同步账本 `.kb-sync.json` 记录 etag + 本地 mtime 快照，增量比对——远端 etag 变+本地未动→下载、本地 mtime 变+远端未动→上传、远端删+本地未动→删本地、本地删+远端未动→删远端、两侧都变→**冲突**（保留远端为权威，本地版存 `.conflict-<时间戳>` 副本、仅本地不回传）；上传前自动补齐远端父目录（MKCOL 链，123 云盘对并发 MKCOL 敏感、串行+重试最稳）；**同步健壮性**（借鉴 pi-sync）：`.kb-sync.lock` 互斥锁防多会话并发互踩（活锁拒绝、死进程/30 分钟超时安全回收）、`.kb-sync-journal.json` 记录中断阶段（成功才删除，下次同步报告并靠幂等重跑收敛）、**上传前 secret 扫描**（高精度密钥模式命中即拦截上传、本地保留，配置 `allowSecretUpload:true` 可关）、远端删除 404 幂等；**同步结果统一呈现**：计数全人话（下载/上传/删除/冲突/失败，0 值省略），并附说明行——冲突列出具体文件与 `.conflict-` 副本处理办法、遍历不到（权限/网络）的目录、失败明细（含 secret 拦截的解除方式）；锁等待提示带等待预算，401/403/404/网络类失败直接给出下一步（改凭据/目录/代理）；**同步后自动清理本地镜像空目录**（`.kb-` 隐藏项与镜像根保留）；AI 写入（`kb_write`/`kb_append`）本地原子落盘 + 立即 PUT 远端，离线失败留账本下次同步补传；
- **只读模式**：适配 WebDAV 账号只有读权限的场景；`/kb-config` 面板切换（默认关，下次会话生效）。开启后：`kb_write`/`kb_append`/`kb_upload`/`kb_import`/`kb_delete`/`kb_move` 注册为 `hidden`，不会被发现通道激活（`kb_sync` 保留）、同步自适应为仅下载（本地删过的远端文件重新下载回本地，本地新建/修改留在本地不上传）、首次引导的 PROTOCOL.md 写入跳过；
- **全文检索**：零依赖零向量（中文 bigram 滑动窗口 + 英文分词 + BM25），增量索引持久化 `.kb-index.json`（按 mtime 只重读变更文件）；纯文本多格式（md/txt/csv/tsv/json/jsonl/yaml/yml/toml/html/xml），csv/tsv 表头加权、frontmatter 仅 md 强制；vault 未解锁时加密区内容不可见（密文仅内存索引）；
- **vault 加密区**：口令只存内存，密文落盘 `.enc` 后缀，读写经解密/加密（列表/检索按明文路径对齐）；未解锁写入报错；
- **LFS 大文件区（/lfs/）**：附加真网盘，任何类型文件、不随知识库同步、不参与检索、不加密；`kb_upload`/`kb_download`/`kb_lslfs` 独立工具，单文件上限 1GB；md 笔记引用 lfs 用纯路径文本（如「附件：lfs/xxx.png」）；人类直接用 WebDAV 客户端挂载管理；
- **`/.history` 历史副本区**：所有文件的改动（覆盖/追加）与删除自动留档——副本存 `/.history/`、目录结构与根一致、文件名加 `_yymmddhhmmss` 后缀；同秒重名叠加 `_hash`（sha1 前 8 位），`_hash` 也重名说明是同一份内容直接跳过；**自身不递归**（`/.history` 与 `/lfs/` 下文件不备份）；`.history` 不参与 `kb_list`/`kb_search`（内容浏览不透明），恢复用 WebDAV 客户端取回副本（vault 历史为密文 `.enc`，拷回 `/vault/` 对应路径后经 kb 工具解密）；备份先落本地、账本登记、**下次同步补传远端**（延迟一轮）；`kb_move` 不备份（内容未变、只是路径变化，目标被删时仍会留档）；
- **工具清单**：`kb_help`（守则，topic 按节筛选）/ `kb_search`（全文检索，namespace 限定）/ `kb_read`（读全文）/ `kb_write`（写/覆盖，需 overwrite:true，文本上限 50MB）/ `kb_append`（追加）/ `kb_list`（目录树，路径可不带前导 `/`）/ `kb_upload` `kb_download` `kb_lslfs`（LFS）/ `kb_move`（移动/重命名，镜像+远端+账本三方一致、vault 透明搬移）/ `kb_delete`（删除，需 confirm:true，先留 `.history` 副本再删）/ `kb_status`（同步状态）/ `kb_sync`（手动同步）/ `kb_import`（本地目录批量导入，导入后按守则重新归位）；
- **测试**：`node src/extensions/webdav-kb/test/sync.test.mjs`（esbuild bundle + mock DAV：增量同步全场景 + `.history` 留档/命名/去重/不递归 + 空目录清理 + PROTOCOL 过滤）、`tools.test.mjs`/`search.test.mjs`/`client.test.mjs`/`crypto.test.mjs`/`panel-config.test.mjs`/`commands.test.mjs`/`lfs.test.mjs`/`panel.test.mjs`；`live-*` 为真实网盘联调脚本（不自动跑）。

## 密钥保护（`src/extensions/secret/`，产物 `secret.ts`）

模型与转录里只有 `{{sec:名字}}`；真值只出现在两处：掩码录入的那一瞬，与执行前一刻。

- **交互面只有一个命令**：`/secret` 开面板，录入、条目管理（复制/改名/删除）、长期指纹表、设置、帮助全在里面。`on/off/list` 只是给无界面场景留的旁路，不必记。
- **库**：会话级内存，不落盘、不进会话 JSONL、不写临时文件（设置存 `~/.pi/agent/secret-config.json`）；`/reload` 保留，`/new` 与退出即清空。
- **录入三条路**：面板里 `a` 密钥 / `t` 其它敏感文本（掩码输入）；粘进对话的凭证由 `input` 钩子在**落盘之前**换成 ref；工具输出里认出的凭证自动收成 `auto_N`。
- **AI 可以主动要**：`secret_prompt(name, why)` 弹掩码框请用户录入（框上写明是谁在要、要什么、为什么），值直接进用户的内存库，AI 只拿到名字；用户 Esc 即取消，工具返回失败。
- **给模型**：`secret_list` 只列名字、类型与字符数——不含值，也不含值的片段（首尾切片仍是密钥的一部分）。
- **使用**：在 bash 命令或工具参数里写 `{{sec:名字}}`。bash 由 spawnHook 换成 `"${PI_SEC_*}"`，真值只进该次子进程的环境（`process.env` 不碰、并发命令互不可见、`argv` 里没有明文）；其它工具在 `tool_call` 时原地展开——pi 校验参数时做的是 `structuredClone`，所以转录与模型看到的仍是 ref。
- **出口四道网**：`tool_result`（落盘前）→ bash 的流式帧与「截断快照」（pi 会把未脱敏全文写进临时文件、只把路径给模型）→ `context`（每次请求前洗全量消息）→ `before_provider_request`（真正离开机器的请求体，靠 `turn_end` 探测该钩子是否被供应商触发）。
- **长期指纹表**（跨会话，只存指纹不存值）：≥16 字符的值入库时顺带记一条 HMAC 指纹（密钥为另存的 32 字节随机数），所以下次会话即使值已忘记，同一个口令再出现仍能被认出来遮住。**只能遮，不能拿来执行**（没有值），命中后占位会写明「本会话没有值」。匹配靠「切候选片段 + 逐段算指纹」，因此 `密码：xxx` / `DB_PASSWORD=xxx` / `u:xxx@host` 能命中，嵌在更长串里的会漏；弱口令（<16 字符）不入表，免得给自己留一个可撞库的靶。面板里可单条删除或清空整表。
- **识别分三档**（`detect.ts`）：打分后落到「收 / 只遮 / 不管」——形态 3 分、关键词 2 分、编码命中 3 分、高熵 1 分、主动粘贴 2 分，再减去示例词、占位符语法、配置词形、哈希语境、含空白、批量命中。≥4 且来自粘贴才收进库；1~3 只换成不可执行的占位；≤0 原样放过（配置项、UUID、校验和都落在这一档）。
- **工具输出侧永远不收**：模型读文档和读真密钥是同一个动作，实测一次研究任务因此收进 6 条第三方 README 里的示例 token——库里塞满是噪音，所以输出侧只遮不建档。
- **认得什么**：13 种供应商形态（GitHub/AWS/Stripe/Slack/GitLab/npm/HuggingFace/SendGrid/JWT/PEM/连接串/Google/通用）、关键词与中文写法（`密码：`、`密钥是`、`改为`、`口令是`）、CLI 旗标、`Authorization: Bearer`、以及前面这些的 base64 / hex / URL 编码形式（解开后认得出就算）。短于 8 字符的值不参与脱敏，8~15 字符的只在词边界替换。
- **认不出的裸口令**：粘贴时弹一次「这看起来像密钥」，答不是就在本次会话里不再问它。
- **在 bash 里写 ref 的字面量**用 `\{{sec:名字}}`（反斜杠转义，不展开也不校验）；其它工具里名字不在库时一律原样保留，结果里补一句提醒。
- **基准测试**：`test/corpus/detect.tsv`（带档位标签的语料）+ `test/detect-bench.test.mjs`（48 项：语料档位、编码形式、真实负样本——package-lock.json / README / AGENTS.md / 本扩展自己的源码必须零误报）。改识别规则先跑它。
- **边界**（明确不设防）：图片/音频等二进制原样放行（改 base64 会让请求 400），命中时会主动告知；供应商回放签名字段不碰；同账户进程可读 `/proc/<pid>/environ`；模型可用 shell 切片重建值；explore 子代理有自己的模型循环，不经过这些钩子。
- **测试**：`node src/extensions/secret/test/core.test.mjs`（纯逻辑，含指纹表加解密往返与密钥丢失重建）与 `.../e2e.test.mjs`（假 pi/ctx 驱动真实钩子链：面板多步浮层、真跑一次 shell 验证环境变量注入、确认面板、跨会话指纹、`reload` 保留库）。

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

**解析链的可靠性设计**：默认用最便宜的 `mimo-v2.6-flash`，实测它约有一半概率**只回思考不回正文**（返回空内容）；因此链路上做了「同一模型空正文重试一次 → 仍空则降级到 `mimo-v2.6-pro`」，并把每次尝试记录在工具结果的 details 里。追求稳定可直接 `/mimo-config model mimo-v2.6-pro`。

**通道（Token Plan 优先）**：调用凭证取自 pi 注册表里第一个已登录的 MiMo provider，顺序是 `xiaomi-token-plan-cn` → `-sgp` → `-ams` → `xiaomi`（按量付费）——订阅套餐先花额度，不额外计费。Token Plan 与按量付费是**不同 host、key 不能串用**（前者 key 形如 `tp-`），所以端点跟着选中的 provider 走，不在代码里写死。注册表全无凭证时才用环境变量 `MIMO_API_KEY`：`tp-`/`ttp-` 开头的 key 视为 Token Plan（端点默认中国集群，`MIMO_BASE_URL` 可改集群），其余走按量付费端点。

**回归测试**：`node src/extensions/test/mimo-omni.test.mjs [音频] [视频]`（离线 22 项：类型判定、内容块构造、fps/分辨率透传、凭证通道优先级与端点跟随；传文件时再加本地文件与错误拦截 5 项）；加 `MIMO_LIVE=1` 则额外用真实文件打一次 API 验证音频与视频两条路径。

## 钉钉受控桥接（src/extensions/dingtalk-bridge/）

替代 dingtalk-* 技能的插件方案：技能是「冻结说明书 + 凭记忆拼命令」，对高风险操作（发消息）已被事故史证明不可靠；插件把机械可判的铁律变成工具层硬拦截。

- **按需装载（不占上下文）**：8 个钉钉业务工具（6 个语义工具 + `dingtalk_confirm` + `dws_skill`）默认不声明给模型，常驻的只有 `dingtalk_help`（无参）。模型要做钉钉操作时先调它装载，下一轮起可直接调用；`/dws unload` 卸下。不用钉钉的项目里钉钉相关开销 ≈ 100 token（原先 3300）。

- **技能屏蔽**：启动时把 `dingtalk-*` 从系统提示词的技能清单过滤（不动 dws 托管的文件——它由 npm postinstall 安装、`dws upgrade` 时全量还原，改了也没用）；`/skill:dingtalk-xxx` 手动加载不受影响（用户自己看文档用，不是 AI 的执行通道）。
- **命令元数据自省（插件内部，模型侧不可见）**：包 `dws schema --compact` 活内省（随 CLI 版本实时更新）解析产品/工具/参数 schema 与 effect 分档，结果落本地缓存 `~/.pi/agent/dingtalk-bridge-schema.json`，查不到用手写表兜底。
- **受控执行管线（语义工具与内部执行器共用同一条链）**：argv 数组直传 spawn（不过 shell，免去转义坑），自动补 `--format json --yes`。发送/转发类命令（`+dm`、`+messages-send*`、`+messages-batch-send-by-bot`、`+messages-reply`、`+messages-forward*`、`+messages-update-card`、`+broadcast`、`ding send-*`）强制：
  - **两阶段确认**：首次调用只回草稿回执不发送，对话里经用户明确同意后调 `dingtalk_confirm(token)` 执行（草稿 10 分钟有效）——确认只带 token，不重写业务参数
  - **外发文件带时间戳命名**：每次发送/上传的文件远端名加 `-YYYYMMDD-HHmmss`（钉盘上传用 `--file-name`，消息发文件用本地临时副本并在发送后清理）——“改了内容重发”与钉盘同名自动改名都不再出现；防重发签名同时纳入文件内容指纹（大小+mtime），内容改了才允许重发
  - **【AI发送】标签强制**：缺失即拒（用户明确要求的正式通知传 `formal=true` 豁免；可在配置关闭）。转发（`+messages-forward*`）与卡片更新（`+messages-update-card`）无正文也无 `--ai-tag`，豁免此项、仍走两阶段
  - **中文姓名目标拒执**：收件人一律经插件的姓名解析实时拿账号，严禁凭记忆硬编码 userId
  - **防重发**：相同目标+内容第二次发送直接拒——会话内存 + 跨会话台账（`~/.pi/agent/dingtalk-bridge-sent.json`，保留 `dedupMinutes` 分钟），重开会话重跑也拦得住
- **姓名解析**：包 `aisearch person` + `contact user get`——候选带部门路径/职务/工号（重名消歧靠的就是这个），无部门/工号者标注为家长或外部联系人账号；单候选自动确认，多候选列回给 AI，由它挑定后带账号 ID 重调。
- **群解析**：包 `chat +chat-search` 解析群 `openConversationId`——实测搜「教研室」返回两个同名群（7 人/8 人）加一个集团群，群名作目标会被直接拦截，必须用 cid。
- **撤回也要过两阶段**：`+messages-recall` 等撤回命令同样先回草稿（预览标出「撤回后双方均不可见，不可恢复」），确认后执行，且同一 messageId 不会重复撤回。
- **群发也要过两阶段 + 发送前预检**：`+broadcast` 首次同样只回草稿（自动附加的 `--yes` 绕不过去），且草稿前先跑一次只读 `--dry-run` 预检收件人，草稿里列出「将发给谁（含解析出的单聊 ID）」。有任何一个收件人未唯一解析（多候选/零候选）就整体拦下——不生成草稿、不做半批次发送，并把候选与稳定 ID 一并列出。消歧办法是**把重名的名字直接换成候选里的 userId，其余名字照旧**（同一条命令里姓名与 userId 可混用，实测 `--to "张示例,016100000000000001"` 两人都发；而把重名名字与 userId **并列**——`--to "王示例,016100000000000001"`——不解决歧义，重名那个 token 仍会被跳过）。「中文姓名目标拒执」对群发不适用（其目标按设计就是姓名），改由预检把关；转发的 `--dest-conversation-id` 会按群目标同等把关（中文群名直接拦）。
- **预检失败不再只给一句笼统报错**：dws 在「一个都没解析出来」时会直接 exit 3 且不给计划（只有一句「没有任何人收到消息，请检查姓名是否正确」）。工具改为退回**逐名自探**：用 CLI 自己的解析链（`+messages-send --user-query`，与 broadcast 同源）拿到结构化候选，再补部门/职务/工号，输出「可发 N 人 / 有问题 N 人」（多候选附部门路径与 userId、查无此人给手机号反查入口）。这份两栏预演在群发草稿前自动附上（只读，不进两阶段）。
- **候选带部门/职务/工号**：姓名解析在 aisearch 候选基础上再拉 `contact user get`（批量、失败则静默降级）补部门全路径/职务/工号；同名的两个王示例一眼分出（班主任-示例校区 vs 英语教研组）。**无部门且无工号会被标注为「可能是家长或外部联系人账号」**（实测家长账号 depts 为空、jobNumber 为 null）——单候选自动确认时也带着这行标注。
- **`--dry-run` 是只读预演**：不进两阶段门（不会生成草稿待确认）、不记防重发台账（不会拦掉随后的真发），结果尾部明确标注未发送。
- **发送后自核验入口**：结果里直接给出 `openTaskId`（查发送状态/转 DING 用）与只读核验命令（`+search-msg --sender <本人>`），叉住「输出看不清就重跑发送」的冲动。
- **文件存在性预检**：`--file` 路径不存在时直接拦下（不再真去捅 dws）。
- **`dws_skill([topic])`（只读知识，不是执行通道）**：无参给技能索引（14 个 + 一句话），传 topic 取完整 SKILL.md。唯一用途是让 AI 判断「这个操作插件到底支不支持」并把结论回报用户——插件做不到的事不会因为它读了文档就变得做得了，下文各条错误文案也一律不用它当出路。技能文件不动，只是不再常驻系统提示词。
- **`dingtalk_file action="fetch"`（link 或 spaceId+nodeId[, out]）**：钉盘/云盘分享落地——文件直下、文件夹递归镜像并列回文件清单（绝对路径）。**这类消息用 `+messages-resource-download` 会报 `TABLE_NOT_FOUND`**（实测：resourceRefs 给的是 `238322429838&type=file` 数字 dentryId 缺 spaceId，真正可用的 spaceId 藏在正文 yunpan 链接里），必须走 drive。只读查询结果会自动把这类引用结构化成带下载动作的指引。
- **「文件夹」消息无法读取（平台限制，已实测坐实）**：钉钉对这类消息只给一句 `[文件夹] 姓名`，无 resourceRefs、无 id、无 mediaId，`download-media` 也无从下手——工具会直接给出结论并提示让对方打包 zip 或逐个文件重发，避免反复尝试。
- **字段拼写不一致自解释**：群成员等接口返回 `openDingtalkId`（小写 t），消息接口返回 `openDingTalkId`（大写 T）。插件不擅自改写返回数据，而是在结果里自动附一行提示（两种拼写都要认），内部解析一律大小写不敏感。
- **消息发送的三处硬处理（实测沉淀）**：① 正文里的字面 `\n`（模型常把换行写成两个字符）自动归一为真换行——dws 会把它吃成空格；② 多行正文自动补 markdown **行尾双空格**硬换行——钉钉客户端把单个换行当段落内空格拼成一行（实测有效；空行分段也可但行距松，纯文本 `--text` 更会直接拼行，故多行走 `--markdown`，`--text` 多行会提示）；③ 文件/媒体消息（`--file`/`--media-id`）与正文协议层互斥，发出后明确回报「本条不含正文」（`--title` 只作文件卡标题、不显示给收件人），说明文字必须另发一条。
- 查询类命令结果自动附**当前系统时间**（时间窗一律相对此刻推算）。

  - **面板统一布局**（`shared/review-panel.ts`）：弱化标题 → `动作 | 对象` 表头（对象是名单时按可用宽度塞名字、剩余收口为「等 N 人」，仅重名才带部门括注）→ 固定 5 行正文（超出用 PgUp/PgDn 翻页，分隔线内 ▲▼ 给余量）→ `⚠` 影响行 → 竖排选项。撤回类在弹窗前用只读查询补齐对象（`+messages-mget` + `conversation-info`：会话名 + 时间 + 正文预览）。**面板内不放 argv / flag / JSON / ID**（有单测断言）。
  - **实测纠错**：官方 `capability-limits.md` 写「个人身份发送的消息无法通过 API 撤回」，实测**能撤**（25 分钟前的消息也撤成功了）；撤回后面板/回执按真实 `recallStatus` 报，同一 messageId 不会重复撤回。
- **落盘命令在非 NTFS 卷上自动重定向**：dws 下载资源用「写 `.part` 临时文件 → 硬链接到正式名」做原子发布（link 天然实现“不覆盖同名文件”），硬链接需 NTFS——exFAT（如 D: 盘）/某些网络盘上必然报 `link …: Incorrect function`。触发不看退出码（查消息附带下载把失败写进结果 JSON，exit 仍是 0），也不靠手写命令清单：输出里出现硬链接失败 + 该命令确实往本地写文件（已知下载类，或 argv 带输出类 flag 且 schema 参数表坐实、且是只读命令）才重试一次——写命令宁可漏重试，也不自动重放。重试只把 cwd 换到系统临时区（通常 NTFS），**相对输出路径原样保留**（不猜文件还是目录），搬回时按产出物本身决定落文件还是落目录、`.part` 残留不搬、结果里的 `localPath`/`savedPath` 改写为用户视角，并在回执尾部说明；落盘类命令超时下限抬到 5 分钟（下载比查询慢）。
- **群发逐人个性化（正文占位符）**：dws 的 `+broadcast` schema 原文就是「所有人收到同一条」，所以正文一旦写出 `{{变量}}`，桥就自动切成**逐人模式**：只读预检拿到每人 openDingTalkId → 按变量表逐人渲染正文 → 逐人 `+messages-send --as user --open-dingtalk-id … --idempotency-key <确定性 UUID>`。变量表用 `--vars '<JSON>'` 或 `--vars-file <相对路径>`（key 与 `--to` 逐字一致，用 userId 消歧的就写 userId；正文只有一个占位符时值可简写为字符串）；覆盖不全、用字符串简写却多占位符、非广播命令里写占位符——都在草稿前拦下。草稿给渲染样例，人审面板仍给完整名单；逐人失败不阻断其余（回执给失败名单），同一人同一正文幂等键固定（重跑自动跳过，不会重复发）。
- **三步走：读直通 / 写两阶段 / 敏感档弹窗**（不再靠提示词自觉）：分档由 dws 自己的 schema 元数据决定（`dws schema --cli-path <path> --compact` 的 `effect`/`confirmation`，本地缓存 `~/.pi/agent/dingtalk-bridge-schema.json`，手写表兜底；查不到就当写入）。
  - **读**：直通（`list/get/search/info/query…` 类词快速判定，命中写词则一律按写处理）。
  - **写**：首次只回草稿/计划（不执行），AI 把计划展示给用户、经明确同意后调 `dingtalk_confirm(token)` 执行（token 对应用户看过的那份草稿，参数不再重写）。
  - **敏感档**（破坏性 + 会对外发出内容：发送/群发/转发/撤回/邀请/删除/清空/审批发起…）：在**真正执行的最后一瞬弹人工审核面板**——面板只写人话（要做什么 / 对谁 / 内容预览 / 影响与可逆性），**不放 argv、JSON、ID**；选项为「允许一次 / 当前工作区不再询问 / 拒绝」（destructive 不开放记住），Esc=拒绝。`当前工作区不再询问` 按命令路径记，可用 `/dws forget` 查看或清除。**无界面会话（print/RPC）直接拒绝敏感档**，绝不因为弹不出窗就放行。**codemode 脚本内直接拒绝敏感档**（脚本里弹不出面板，等待会一直计入脚本超时、超时重试还会堆积），只读与两阶段写照常可用。（面板复用 `shared/review-panel.ts`；与 secure 的复核面板同一套串行链，避免并行工具批里浮层打架。）
配置 `~/.pi/agent/dingtalk-bridge.json`（`requireAiTag` / `blockedSkillPrefixes` / `dwsPath` / `execTimeoutMs` / `maxOutputChars` / `dedupMinutes` / `skillsDir` / `remembered`）；`/dws` 查看状态，`/dws unload` 卸下业务工具，`/dws forget <命令|all>` 清除「当前工作区不再询问」，`/dws refresh` 清空命令元数据缓存。回归测试：`node src/extensions/test/dingtalk-bridge.test.mjs`（策略层纯函数 A~AM 场景，不真实起 dws 进程）、`node src/extensions/test/dingtalk-intents.test.mjs`（语义层映射纯函数 A~G 场景）；真实联调 `node src/extensions/test/dingtalk-bridge-live.mjs [姓名]`（发送只走到草稿/预检即停，永不 confirm）。

## 音频/视频进上下文补丁（patches/apply-pi-audio-input.mjs）

pi 的消息内容类型只有 text 与 image，全模态模型原生的音频/视频输入进不了上下文，只能先用 `mimo_transcribe` 转成文字——语气、音色、旋律走向这些只存在于媒体里的信息在转换那一步就永久丢失。本补丁把 `audio` / `video` 内容块打通到请求体，让媒体本体进对话上下文（可多轮、可被 `/resume` 还原）。

打通后：`read` 一个 wav/mp4，模型直接听到/看到，不再经过一次转写。切到不支持某模态的模型时**自动降级**，与图片降级完全同语义（换成占位文本，不报错、不丢上下文结构）。

```bash
node static/patches/apply-pi-audio-input.mjs            # 打补丁（幂等），重启 pi 生效
node static/patches/apply-pi-audio-input.mjs --dry-run  # 只列会改哪些文件
```

补丁改五处（缺一不可）：

| 层 | 文件 | 改动 |
|---|---|---|
| 能力声明 | `pi-ai/dist/providers/model-schema.js` | `MODEL_INPUT_MODALITIES` 加 `audio` / `video`。不加则 models.json 里给模型声明这些能力会被 schema 判非法，**整份 models.json 被拒**（pi 静默退回内置目录） |
| 降级 | `pi-ai/dist/api/transform-messages.js` | 判据从单一的 image 拆成 image / audio / video 三个独立判据，各自替换占位文本（原本「不支持图片就全丢」，会让只支持图片的模型连音频一起吞掉） |
| 请求体 | `pi-ai/dist/api/openai-completions.js` | user 与 toolResult 分支各加 audio（`input_audio`）/ video（`video_url` + `fps` / `media_resolution`）。原代码「非 text 一律当 image_url」，新块会被拼成 `data:undefined` 发出去 |
| 入口 | `pi-coding-agent/dist/core/tools/read.js` | 读音视频文件时产出媒体块（附时长/大小说明），不支持时给模型一句省略提示 |
| 记账 | `pi-ai/dist/utils/estimate.js`、`compaction/compaction.js` | 媒体块按 `durationSec` 折算（音频官方 ≈6.25 token/秒，视频按抽帧 `fps × 300`/秒，缺省 60 秒）。不折算会按图片的固定 4800 字符记账，几分钟的录音被严重低估 |

**改两套产物**：主会话跑 `pi-coding-agent/dist/bundle/chunks/*.js`（压缩、文件名带哈希，脚本按内容探测），扩展与子代理经 jiti 别名表跑 `dist/**.js` 未压缩产物。两套都要打，脚本各自确认。

**要配合 `models.json` 声明能力**：仓库模板已为 `xiaomi` 与三个 `xiaomi-token-plan-*` 的 MiMo 模型写好 `modelOverrides.input = ["text","image","audio","video"]`。换别的全模态供应商时照此加一条即可。

上游接口与实测：音频 `{ type: "input_audio", input_audio: { data } }`（data 为 data URL 或公网 URL），视频 `{ type: "video_url", video_url: { url }, fps, media_resolution }`。base64 字符串上限 50MB；URL 传入音频 ≤100MB、视频 ≤300MB。

注意：补丁打在 pi 安装目录上，**pi 每次升级会覆盖**，重跑 `node install.js` 即可（已代跑）；若版本变动导致目标代码对不上，脚本会**整份文件跳过并告警**（不写半截补丁），提示人工对齐定位串。

回归验证：`node src/extensions/test/pi-audio-input.test.mjs`（离线，验证原生发出/降级/read 三条路径；未打补丁会直接失败）。

## pi-ai usage 缺失防护补丁（patches/apply-pi-ai-usage-guard.mjs）

修「模型偶发无文字回答」（实测 deepseek-v4-flash，/btw 面板表现为 `（无文字回答）`，主会话同理可触发）。根因：pi-ai 的 `estimate.js` 估算上下文 token 时对每条 assistant 消息调 `calculateContextTokens(assistant.usage)`，**usage 为 undefined 时抛 TypeError**（`Cannot read properties of undefined (reading 'totalTokens')`）。该异常发生在每次 LLM 调用的**请求构建阶段**（`clampMaxTokensToContext` → `estimateContextTokens` → `getLastAssistantUsageInfo`），只要 history（含主会话上下文，compaction summary 消息常缺 usage）里混入一条缺 usage 的 assistant 消息，后续调用就**瞬时失败**（1~5ms 返回 `stopReason="error"`，请求根本没发出）——这也解释了为何失败总是“瞬时”。

install.js 每次安装已代跑本补丁（四个补丁一起，幂等）；下列命令供单独重跑。

```bash
node static/patches/apply-pi-ai-usage-guard.mjs   # 打补丁/升级（幂等），重启 pi 生效
```

补丁内容（覆盖 pi-ai 两个文件，幂等）：

1. `pi-ai/dist/utils/estimate.js`：`calculateContextTokens` 对 usage 缺失返回 0——调用处 `> 0` 判断自然跳过该消息，与“不用缺失 usage 的消息估算上下文”语义一致（主修复）。
2. `pi-ai/dist/api/anthropic-messages.js`：`message_start` 解析 usage 处改可选链——兼容端点（如 deepseek）响应缺 usage 字段时不再抛 `'input_tokens'` 类异常（防御）。

注意：补丁打在 pi 安装目录的 pi-ai 上（托管安装为 `~/.pi/agent/install/releases/<版本>/node_modules`，npm 全局为 `npm root -g`），**pi 每次升级会覆盖，需重跑脚本**；若版本变动导致匹配失败，脚本会拒绝执行并提示人工核对。

## 祖冲之汉化补丁（patches/apply-zuchongzhi-zh.mjs）

pi 无官方 i18n（settings 无 language 字段，TUI 文案硬编码在 `dist/modes/interactive/` 下）；扩展 API 只有「新增渲染」钩子（renderer 按 customType 精确匹配、markdownTransformer 只作用于消息区域），没有覆盖原生 UI（footer/菜单/对话框//settings 界面）的钩子，主题又是纯颜色 schema。汉化只能直接替换 dist 编译产物里的字符串——祖冲之算 π，π 的汉化者。install.js 每次安装已代跑；下列命令供单独重跑。

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
| `model-selector.js` | 4 | `/model`（本仓库扩展现统一用自绘选择浮层，不再依赖该组件） |
| `footer.js` | 4 | `no-model` / `thinking off` / `(订阅)` / `(自动)` |
| `trust-selector.js` | 1 | 项目信任 |

安全机制（逐条核对过 dist 源码上下文）：

1. **只替换双引号字符串字面量**（`quoted: false` 条目仅限模板字符串内确认无歧义的文案，如 footer 的 `thinking off`）——绝不碰 JS 标识符/属性名（踩过 `onTerminalInput:` 被 `Input:` 误伤的坑，已加引号边界修复并 diff 验证零误伤）；不碰小写 value（`"apply"`/`"save and go back"`/`"dark"` 等是配置值或下拉框返回值，替换会改行为）、颜色 key、快捷键 key、HTTP 头名。
2. **写盘前 `node --check` 语法验证**，失败不写盘并报错。
3. **自动备份 + `--restore` 一键还原**；状态与备份在 `~/.pi/agent/tmp/zuchongzhi/`。
4. **幂等（SHA256 记录）**：pi 升级覆盖 dist 后哈希变化自动重打；缺失目标串（升级后文案变动）只警告不致命，汇总列出供人工核对。

注意：补丁打在 pi 安装目录的 pi 上，**pi 每次升级会覆盖，需重跑脚本**；汉化不影响会话文件与 LLM 上下文（仅 TUI 显示层），还原后重启即回英文。

## 启动垫片崩溃取证补丁（patches/apply-pi-launch-report.mjs）

修「无声崩溃零痕迹」：进程直接消失、无 JS 异常、无 V8 报告时，abort 类原生死亡（node 内部断言 / V8 CHECK）只会在 stderr 留下原生调用栈——本补丁给 pi 启动器加上这整条取证通道。install.js 每次安装已代跑；下列命令供单独重跑。

```bash
node static/patches/apply-pi-launch-report.mjs   # 打补丁/升级（幂等），重启 pi 生效
```

注入内容（按启动器形态适配，托管安装的 `<agent>/bin/pi` 与 npm 全局的 `pi` / `pi.cmd` / `pi.ps1` 都支持）：`--max-old-space-size=8192`（排除堆上限 OOM）、`--report-on-fatalerror --report-directory=~/.pi/agent/reports`（V8 诊断报告）、stderr 追加落盘 `~/.pi/agent/pi-stderr.log`、启动/退出记 `[START]/[EXIT]` 行。

注意：**pi 每次升级会重写启动器，需重跑脚本**；崩溃后先看 `~/.pi/agent/pi-stderr.log` 尾部（`/crash-log` 会指向取证路径）。

## 卸载

```bash
rm ~/.pi/agent/themes/matrix.json
rm ~/.pi/agent/extensions/{hud,ask,btw,claude-it,clipboard,context-init,crash-log,dingtalk-bridge,explore-agent,img-slim,keep,mimo-omni,model-config,pair-guard,secure,qr,secret,skill-hub,status-beacon,time,web-tool,webdav-kb,workflow-mgr}.ts
rm ~/.pi/agent/sounds/{task_complete,subagent_complete,attention,error,idle_prompt}.wav
# 官方插件（vendor）：pi remove 按本地路径移除（同时清 settings.json packages 登记）
pi remove ~/.pi/agent/vendor/pi-rtk-optimizer
rm -rf ~/.pi/agent/vendor
```

（`settings.json` 里的 `"theme": "matrix"` 改回其他主题即可；`models.json` 已并入你手改的 `~/.pi/agent/models.json`（深度合并，模板键以仓库为准），要还原需手动移除模板注入的 `providers.openrouter.compat.openRouterRouting`；四个补丁打在 pi 安装目录上，重装 pi 即还原，祖冲之汉化另有 `--restore` 一键还原英文；rtk 二进制按安装位置删（Windows `%APPDATA%\npm\rtk.exe`，Unix `~/.local/bin/rtk` 或 `~/.pi/agent/bin/rtk`）。）

## 说明

- **伪编译架构**：`src/` 是全部源码与工具（`extensions/` 扩展源码，`shared/` 共享模块被多个扩展 import 复用，`hud/` 拆分为多文件便于维护，`package.json` + `config/` + `build.js` 为构建工具与配置）；`node src/build.js` 用 esbuild 把每个扩展入口内联打包成 `dist/extensions/` 单文件（零耦合、只依赖 pi 官方包；`hud/` 合并为 `hud.ts`）；静态资源（`static/`）无需编译，`install.js` 直接从 static/ 安装。**dist 不入库**（gitignore）：克隆后 `cd src && npm install && node install.js` 即可用；改了源码后跑 `node install.js` 一步重建+安装，改静态资源则 `--skip-build` 重装即可。
- `docs/deepseek/` 是本地参考资料（不入库，版权归 DeepSeek），供 deepseek 适配开发时查价格、思考模式、API 细节。

