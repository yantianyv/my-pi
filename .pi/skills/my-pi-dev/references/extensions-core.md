# 扩展细节 A：会话 / 状态 / 权限 / 子代理

## context-init.ts

- 命令 `/init`（`/init cancel`/`stop` 中止进行中的运行）。唯一职责：生成与维护项目唯一的 `AGENTS.md`。
- **内容规范就是它存在的理由**（写进子代理提示词）：写每行前过两问——不写它 AI 会做错事吗？换一年、换个项目还成立吗？信息按「多常被需要」分四处：每轮用 → `AGENTS.md`；相关才用 → `.pi/skills/<前缀>-<领域>/`（`description` 写明何时用）；在办（进度/待办/当前批次）→ 该工作目录 `STATUS.md`；跨项目经验 → 知识库。禁止：子目录 `AGENTS.md`、进度与待办、变更史、插件已经强制的规则（如钉钉发送纪律）、README 里能读到的、代码原文。产物必含 `## 关于 AGENTS.md 自身`（四条元规则，常量 `SELF_SECTION`）。
- **目录对齐**（提示词层面的引导，不是校验器）：判据「同类只住一处，一处只放一类」——脚本进 `tools/`、共享基准数据进 `data/`、再生品进 `output/`、临时进 `.tmp/`、旧批次进归档；同名不同义的目录（`工具/` vs `tools/`）归并、缺失的机制目录顺手创建；本项目约定写进 `AGENTS.md` 一小段。不强制固定目录树。
- **迁移**：发现子目录 `AGENTS.md` → 内容分流（长期→skill、在办→`STATUS.md`、通用→根）后**删除源文件**，并在总结里附「哪个文件 → 去了哪里」映射表；`CLAUDE.md` 合并后删除。
- 流程：检查目录 → 无文件则 create，有则询问「合并更新 / 完全重写 / 取消」→ 后台 `runAgentLoop`（当前会话模型，主会话零污染、期间可继续对话；同时只允许一个，会话结束自动中止）→ 审计子代理复核 → 结构检查（有问题带问题再审计一轮，最多两轮）。
- 上下文预算（与 explore 共用 `shared/context-budget`）：预算 = 模型窗口 × 0.55；每请求前 `transformContext` 剪超预算的旧工具结果（read/grep/find/ls/bash → explore → 其他，write/edit 不剪，最近 10 条不动）；仍超限则把过程记录压成要点后重启继续（`compactInitNotes`，最多 2 次，失败回退记录尾部），状态行显「⚙ 初始化 · 压缩上下文 n/2」。
- 子代理工具：read/ls/grep/find + write/edit + bash + 可选 `explore`（`getExploreApi()?.createSubagentTool(ctx, { alwaysFresh: true })`，缺席静默降级为自读）。
- 约束：**不设轮数与墙钟上限**；`NO_PROGRESS_TURNS = 8`（连续 8 轮既没写文件也没派 explore → 注入收尾指令，只提醒不硬停）；「没写完不许停」——打算停下但文件没被写过（mtime `> mtimeBefore + 1`）或末句是意图陈述 → 顶回去做完（最多两次），最终如实报「未完成」。
- 审计子代理：主流程成功、文件确实写入、摘要不像「未完成」才启动；全新上下文 + 独立 system prompt；任务里显式列出全部上下文文件与 `.pi/skills/`；工具只有 read/ls/grep/find + write/edit（无 bash、无 explore）；不设轮数上限，带「没动手 / 末句是意图陈述 → 顶回去」与无结论补问一次；验收清单围绕上面的内容规范（两问、四处去向、该留的没丢、元规则板块在场），只做删减/合并/移出/修指针。审计故障只报「审计未完成」，不否定既有产物。
- 纯 fs 的产物检查放在 `shared/context-files.ts`（`findContextFiles` / `checkContextArtifacts`，与本插件、`test/context-init.test.mjs` 共用，不依赖 pi 运行时）。
- 进度经官方 `ctx.ui.setStatus("init", …)`（hud 行 1；hud 缺席回落 pi 原生 footer）。

## claude-it.ts（会话体验，文档生成已拆出）

- `exit` 拦截：裸输入 `exit`（不带 `/`）与 `/exit` 命令都直接退出 pi，属刻意设计。
- `/rewind`：回退到上一条用户消息、内容放回输入框（`navigateTree` 是命令 ctx 专属能力，只返回 `{cancelled}`，文本回填由 interactive-mode 完成）。
- Ctrl+C：打断当前 turn；打断沉降完成（`agent_end`）后 2s 窗口内再按 → 预填 `/rewind` 回车即执行；沉降期内按下的只排队（30s 窗口内有效），不刷新窗口，双击连按永远有效。
- 启动清屏：仅 TUI 冷启动（`session_start` reason=startup）；借 `setWidget` 工厂同步拿 TUI 实例，清视口 + `requestRender(true)` 全量重绘，随即移除占位 widget。

## explore-agent.ts

- 工具 `explore`（一个任务 = 一个只读子代理，read/ls/grep/find），命令 `/explore-config`（子模型，走 shared/model-select 工厂），配置 `~/.pi/agent/explore-model.json`，状态 key `explore`。
- 落盘：`.pi/explore/report.md` 边跑边重写；单任务 `.pi/explore/tasks/<key>.{partial.md,md,json}`，`key` = 规范化任务文本（trim + 连续空白压单空格）的 SHA1 前 12 位。每轮工具调用与正文进展都原子写（tmp+rename）partial + json（含正文与最近 40 条检索轨迹）并刷新报告 → 进程被杀也留证据。
- 断点续跑：`<key>.md` 已完成则直接复用（不花 token）；`fresh: true` 强制现跑；有 partial 时读作起点续跑（要求在其基础上继续、不重复已验证检索、过时结论可复核）；成功写 md + `status: done` 并删 partial；失败/中断保留 partial（json 标 `failed`/`interrupted`）且结果附 partial 相对路径。
- 上下文兜底：单任务最多 40 轮；超限时压缩过程记录后继续（≤2 次）；轮数用尽/无正文 → 用过程记录整理成报告。最多 32 个任务、自适应并发上限 8、可重试错误指数退避（单任务最多重试 2 次）、单任务超时 15min。
- 跨扩展契约 `__PI_EXPLORE_API__`（键名/版本/类型在 `shared/explore-api.ts` 单点定义）：发布 `createSubagentTool(ctx, { alwaysFresh })`，`alwaysFresh` 变体去掉 `fresh` 参数并强制现跑。

## btw（`btw/`，产物 `btw.ts`）

- 文件：`config.ts`（常量/系统提示词/模型设置）、`messages.ts`（消息清洗）、`render.ts`（转发 shared/markdown）、`overlay.ts`、`run.ts`（后台流式问答）、`index.ts`。
- 命令 `/btw`（多轮追问；`Enter` 追问、`m` 转正、`/btw-config` 选模型），状态 key `btw-transfer`。
- 实现：pi-agent-core `runAgentLoop` + `createReadOnlyTools(ctx.cwd)`，认证走 `createPiStreamFn`；最多 6 轮，上下文清洗后 ≤60 条、含面板历史 ≤80 条，工具结果截断 1500 字符；空回答重试一次，失败/空回答按价格顺序故障转移。`/btw` 不写主会话历史；`m` 转正是**暂存 pendingTransfer**，由下一条 interactive 输入经 input transform 附在末尾发送（不是立即 sendUserMessage）。
- 历史：曾用官方 pi-btw 替代，2026-09-07 因多轮追问/上下文携带 bug 回退自研（评估见 `src/vendor/README.md` 回退记录）。

## ask（`ask/`，产物 `ask.ts`）

- 文件：`types.ts`（题型 + 容错规范化）、`store.ts`（问卷文件读写）、`page.ts`（整屏问卷页）、选择器、`tool.ts`、`commands.ts`、`state.ts`（状态推送/排队链）。
- 工具 `ask`（`create` / `cancel`），命令 `/answer`，状态 key `ask`（待答问卷数，优先级 84 常年挂着）。
- 七题型 `single/multi/text/confirm/rating/number/note`（note 为只读说明题，不作答、不进进度分母、不阻塞提交）；选项题自动带「其他」自由输入；上限 12 题、每题 8 选项。漏传 `type` 时推断：有 options → single，有非空 content → note，否则 text；`title` 缺省取第一题问句。
- 「问卷即文件」：`.pi/questionnaires/<id>.json`，手写 JSON 丢进目录也能被 `/answer` 扫描识别。创建即写文件并整屏弹出；Enter 提交（答案作工具结果返回）、Esc 搁置（写回 `status: draft`，`/answer` 续答）、用户删除或 AI `cancel` 即删文件。
- 工具结果状态：`submitted` / `shelved` / `deleted` / `text-fallback`（非 TUI 降级：文件保留、AI 改在对话里逐题问）/ `cancelled`。**`/answer` 提交的答案经 `pi.sendUserMessage(followUp)` 送达；AI 建的问卷由用户直接 Enter 提交时答案先作为工具结果返回**。
- 问卷级上下文：`context` 手动摘要或 `includeLastMessage=true` 自动附上一条回复文本（从 sessionManager 条目倒序提取、遇 user 消息即停、超长截尾 4000 字符），渲染为引用块（超 8 行折叠）；note 正文经 shared/markdown 渲染挂在「│ 」左边线下，超 20 行折叠；两者共享 `x` 展开键。
- 键位：↑↓/Tab 移动（多行简答内 ↑↓ 走行间、到边界才跳题）、`Ctrl+↑/↓` 上/下题、PgUp/PgDn、滚轮滚动内容窗（不挪焦点；答案一览同样可滚）、空格选中、数字键 1-9 直选、`Ctrl+P` 答案一览（一览里 `C` 走官方 `copyToClipboard`）、`?` 键位表、`x` 折叠说明、`Ctrl+D` 或非输入行 `D` 两次确认删除、被必答校验拦下后**再按一次 `Enter`（连按两次）跳过未答直接提交**（未答项在回执里标「（跳过）」）。
- **强制提交为什么是连按两次 Enter**：普通终端把 `Ctrl+Enter` 与 `Enter` 发成同一个 `\r`，只有支持 kitty/modifyOtherKeys 的终端才发 `\x1b[13;5u`——依赖终端协议不可靠，故不再识别 `ctrl+enter`/`alt+enter`，只留「连按两次」（同 `deleteArmed` 的两连按模式）。`forceArmed` 有 **1 秒窗口**（`FORCE_SUBMIT_WINDOW_MS`）：首次 Enter 被拦下时置位并起 `setTimeout`，到点自动复原并撤掉那条提示（`dispose` 清定时器），`handleInput` 开头取走并清零——即窗口内且中间夹任何其他按键都会解除（防误触，有单测）；被拦下的提示行与状态行分别写「再按 Enter 跳过」「连按两次 Enter 跳过」。
- **文案人称规范**：promptGuidelines 要求问卷文案（标题/说明/题干/选项/上下文）一律省略主语，必须指代时写「AI」「用户」（不写「你/我/您/咱们」）——整屏问卷里人称指向不明；创建时 `findPersonWords` 扫出命中项，随工具结果（提交/搁置/删除）回给 AI 提醒，不拦。
- 整屏页 = overlay（width/maxHeight 100% + 左上锚点 + 每行补满全宽；pi 的 overlay 是逐行不透明合成，全屏即遮蔽聊天/HUD）；高度权威值由 `overlayOptions.visible` 回调每帧捕获（`tui.terminal.rows` 可能滞后）。首帧停在顶部不跟随焦点（长说明题从头读），按键后恢复跟随。已知限制：regular（内联）模式下全屏 overlay 与聊天共享原生滚动缓冲，滚轮上滑会看到残影（仅美观问题）；fullscreen 模式零污染。
- 渲染细节：顶部进度条 ▰▰▱▱；长文本经 `wrapTextWithAnsi` 折行完整展示不截断、续行缩进对齐首行文本起点；滚动位置提示（▲▼ 行数）只在状态行右侧；`answerableQuestions()` 排除 note，是进度条/必答/回执的统一分母。

## perm-gate.ts

三层名单（只管 bash，`tool_call` 拦截），判定顺序：**拆段（shared/shell-split）→ deny → remembered → watch 标记 → AI 审核**。

- `deny` 硬拒绝：命中即拒、不询问（默认含 `rm -rf /`、`mkfs`、`dd` 写块设备、`curl|sh`、`chmod -R 777 /`；整串或任一段命中）。
- `watch` 关注项：命中不打断，只把命令标记给 AI 要求从严（宁可 review 不 allow）。
- `remembered` 意图缓存：命中即放行，带人类可读 intent，30 天未命中自动清理（`/perm-gate prune` 手动清）；**逐段判定，每个子命令段都要命中才放行**（防「git status && rm -rf x」被前半段连带放行）。
- AI 审核：输出 `{action, reason, impact[], pattern}`，`pattern` 用 `<*>` 占位可变参数、落库前校验能命中当前命令否则退结构化兜底；`allow` 自动记住意图（通知写人话意图，不暴露正则），`reject` 拒绝；AI 不可用（超时/无模型/网络错/输出无法解析）降级人工确认，文案说明是降级而非任务失败；allow/reject 结论有会话级缓存，`completeSimple` 单次调用不占主会话上下文。
- 人工确认面板 ReviewPanel（自有实现；**选项行渲染改用 `shared/ui.ts` 的 `renderChoiceList`**，与钉钉审核面板同一份代码）：顶部人话信息区（一句解读/影响面/命中原因），命令全文折行可滚、不展示正则原文；默认高亮「允许一次」，选项 = 允许一次 / 允许并永久记住这类操作（旁标将被记住的意图）/ 拒绝，Esc = 拒绝不执行。滚动提示、折行、按键语义、滚动位置已抽到 shared（见 hud-and-shared.md）。
- 配置 `~/.pi/agent/perm-gate.json`：`enabled`、`deny`、`watch`、`remembered`、`aiReview`、`aiTimeoutMs`、`sudoExec`、`model`；旧配置自动迁移（blacklist → watch、whitelist → remembered）；首次运行写默认配置。
- 命令 `/perm-gate`：`on/off`、`sudo on|off`、`reload`、`prune`、`model [provider/id|auto]`（无参开官方模型选择面板，未覆盖时回落 shared/model-pick 自动选）。
- sudo 专用授权通道：bash 里的段首 `sudo` 被拦截、引导改用 `sudo_exec` 工具；整屏授权面板（命令全文折行可滚 + 掩码密码框，错误原地重试 3 次，Esc 拒绝），扩展内 `spawn sudo -kS` 喂密执行（`-k` 不缓存 + 收尾 `sudo -k` 双保险，每次调用必重新授权）；密码只经扩展内存进 sudo stdin，不进会话/结果/磁盘；NOPASSWD 账户退化为确认弹窗（仍逐次授权）；requiretty / 无 sudo 明确报错请用户手动执行。
- 状态 key `perm-gate`（审核中）；人工确认与 sudo 等待经 `globalThis.__PI_STATUS_BEACON_API__.wait(text)` 交给 status-beacon 的 Working 行。

## pair-guard.ts

- 工具 `set_title({work?})`（work 同步 `pi.setSessionName`（`/resume` 选择器可见）+ 注册表；标题不单独发广播，随其他事件行内捎带，`/pair` 详情完整展示）；命令 `/pair`（无参查看、`label <文本>`、`prune`）；状态 key `pair-guard`（「👥 N 并发会话」）。
- 项目级会话注册表 `.pi/sessions/<sid>.json`（gitignore）：字段 `sessionId/pid/startedAt/lastBeat/label/work/recentFiles`；30s 心跳；判死双保险——扫描时 `process.kill(pid, 0)` 判活（关窗强杀不走 session_shutdown，pid 一死下次扫描即清，秒级）+ 5min 心跳超时兜底；`session_shutdown` 按 reason 分流（reload 保留注册表，quit/new/resume/fork 才注销，否则每次 `/reload` 冲掉标题与标签）；`write/edit` 记录最近在改哪些文件（10min 滚动窗口）。
- 并发广播：peer 加入/离开/新触碰文件/标签变化以定制消息注入（变化驱动、事件键去重、极简直播格式、协作约定仅首批附带；绝对时间戳、尾部追加不破坏前缀缓存）。投递两路——agent 运行中 `sendMessage(deliverAs: "steer")` 实时送达，空闲攒到 `before_agent_start` 排空；检测走 `turn_start`（每个模型调用边界扫一次）+ `before_agent_start`（注入前先扫）+ 30s 心跳；写 peer 近窗口文件时 `tool_result` 追加 ⚠️ 软警告。
- 任务标签仅 `/pair label` 手动设置（曾自动读 workflow-mgr 当前任务，多会话下同标签无意义已移除）；执行中 Working 行由 status-beacon 负责，本扩展不写。

## status-beacon.ts

- 命令 `/beacon`：无参开模型选择面板、`auto`、`provider/modelId`、`status`/`presence`（报告在场门控判定）。配置 `~/.pi/agent/status-beacon.json`：`model`、`presenceGate`、`activeIdleMs`、`awayIdleMs`、`dedupeMs`。选模型走 shared/model-pick 或 shared/model-selector。
- 执行中标题进度（`agent_start` → settled）：spinner + 活动段 + 目录名，活动段与 Working 行/HUD 同一套词（工具名 / 思考中 / 输出中 / 块间隙只显目录）；提醒期间让位、应答后恢复。
- 接管执行中 Working 行（独占 `setWorkingMessage`），按「在等什么」分层：等人工（`ui_prompt` 阻塞；ask/perm-gate 经 `__PI_STATUS_BEACON_API__.wait` 登记具体文本，如「等你：回答问卷「方案确认」」）> 等工具/子代理完成 > 思考中 > 正在{短语}… / 正在输出…。**「思考中」只覆盖思考块流出的那段时间**（`message_update` 的 thinking_start → thinking_end），带廉价 AI 概括的动作短语 `思考中：重构 HUD…`（`message_end` 触发异步概括，`pickAuxModel` 选最便宜已认证模型，仿 perm-gate 的 `completeSimple` 路线）；无短语只显「思考中…」。思考结束后的内容生成与块间隙显「正在输出…」，不冒充思考中。行首那支转圈是 pi 指示器自带、Working 行不自带 spinner；折叠思考标签交回 pi 默认静态 `Thinking...`（其动画已并入本扩展）。
- 状态 key（`STATUS_STYLE` 中登记）：`task-alert`（完成闪烁帧）/`task-alert-error`/`task-alert-wait`（等待人工）/`task-alert-run`（思考中/当前工具；run 开局重置防残留，块间隙与收尾不显）。key 沿用 task-alert* 旧名（前身即 task-alert）。
- 五音效（`~/.pi/agent/sounds/`，由 install.js 部署 static/sounds）：`task_complete`（正常结束）/`error`（stopReason=error）/`attention`（阻塞等人工）/`idle_prompt`（完成提醒后 60s 无操作，且人真的离开时才补）/`subagent_complete`（工具名 ∈ {explore, subagent, Task} 成功）。超时自动撤销提醒 600s。
- 提示音经 `shared/presence` 在场门控：系统空闲 <20s 或任一实例 20s 内有输入 → 只闪不出声；`claimSoundSlot` 全局去重（窗口 2.5s）只响第一声。
- **扩展侧适配纪律**（AGENTS.md「提醒适配」条目的实施细节）：① 等人 UI 不要自己做声音——pi 把 `ctx.ui.custom/select/confirm/input/editor` 全部包进 `ui_prompt_start/end`（`wrapUIPromptContext`），自绘 overlay 也自动进 waiting 告警链；② 要让 Working 行显示具体等待内容，弹层前 `waitApi()?.wait?.(text)`、结束 `wait(null)`（dingtalk 的 review-panel 与 perm-gate 两处已按此实现，`wait` 在 `ui_prompt_start`（microtask 异步 emit）之前登记即生效）；③ 子代理完成音按工具名集合自动（`SUBAGENT_TOOLS` = subagent/explore/Task，新子代理工具名要手动加进该集合）；④ 完成/出错声音只在 turn 收尾触发一次，工具级完成不响。
- 发布 `__PI_STATUS_BEACON_API__ = { wait(text|null) }`（session_shutdown 删除）；读 pair-guard 注册表的 `work` 字段。Ctrl+C 打断不触发完成提醒：`agent_end` 记 `lastEndStopReason`，`agent_settled` 时若为 `aborted` 则跳过（零耦合，不依赖 claude-it）。

## clipboard.ts

工具 `clipboard_get`（可截断）/ `clipboard_set`（空串清空）/ 命令 `/clipboard`（无参查看、`clear`/`off` 清空），状态 key `clipboard`。跨平台零依赖：Windows PowerShell `Get/Set-Clipboard`、macOS `pbpaste/pbcopy`、Linux `xclip` 退 `xsel`；统一临时文件中转（`os.tmpdir()/pi-clipboard-<pid>-<ts>-<rand>.txt`，用后即删）以规避 PS5.1 管道 UTF-16LE 乱码与 shell 转义；读时 CRLF→LF 归一化；写入前读旧内容摘要报告「已覆盖」。

## time.ts

时间感知：`context` 事件给每条 user 消息的**发往模型的副本**贴 `[YYYY-MM-DD HH:mm]` 常量前缀（带年），会话记录/UI/其他扩展看到的上下文均不动。核心事实：AgentMessage 自带 `timestamp`（ms，常量），零对齐零读盘；toolResult 是独立 role 天然不误伤；前缀是常量 → provider 前缀缓存照常命中；`/reload` 后首轮对长历史一次性全 miss（部署时机选在会话初期可避开）。只贴非空文本（string 或首个 text 块），已带前缀（`/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /`）跳过防重贴；纯图/空串不贴。工具 `now()`：本地时间+星期+时区+ISO，需要绝对「现在」时按需调。无状态 key（behind-the-scenes，不进 STATUS_STYLE 也不报警）。

## crash-log.ts

崩溃黑匣子：`prependListener` 抢在 pi 的 `uncaughtException` 处理器（同步 exit）之前把堆栈同步落盘 `~/.pi/agent/pi-crash.log`（含 unhandledRejection 与 exit 码；滚动上限 2MB、保留尾部 1MB），崩溃条目与会话文件按时间配对；命令 `/crash-log` 报告最近一条崩溃与取证路径（`clear` 清空日志与 ack）。

启动提醒去重：`session_start` 只在「日志里最新崩溃时间戳 ≠ `~/.pi/agent/crash-log-ack.json` 里已提示的时间」时提醒（无 UI 不提醒、也不写 ack），避免同一条崩溃每次启动都念叨——提醒一次或用户 `/crash-log` 看过即标已看，记录仍在日志里。进程级监听与启动头用 `globalThis.__PI_CRASH_LOG_HOOKED__` 守住只挂一次（`/reload` 会重新执行模块，而 process 监听器不随扩展卸载消失，重复挂会写出重复条目）。日志路径可用 `PI_CRASH_LOG_FILE` 注入（回归测试用，ack 落同目录）。

## img-slim.ts

三个钩子三层防护（上游 48MiB 请求体上限 → 而 pi 的 token 估算每图仅 1200 tokens，1M 窗口要 ~820 张才触发自动压缩，故请求体上限永远先到；实测 76 张/75.6MB 起连续 413）：

- `tool_result` / `input`：给新进上下文的图片瘦身——照片 ≤900KB、图形 ≤1.6MB（base64）、最长边 2000px、PNG 优先退 JPEG，动图 WebP 强制转静态 PNG（上游 400 拒收，且历史重发会让后续每轮都失败），<300KB 且非动图不碰。
- `context`：每轮请求前按 `REQ_BUDGET_B64 = 32MB` 总量预算从最旧开始把图片换成占位文本（非破坏性：只改本次请求，会话记录不动；`context` 事件的 messages 本是 pi 的 structuredClone 副本，加处理器不额外增加拷贝成本）；`WARN_AT_B64 = 24MB` 起推状态行 `🖼 xMB · 已省略N张旧图`（key `img-slim`），`TIGHT_AT_B64 = 40MB` 时新图按半预算温和降级；首次省略额外 notify 一次（说明原图仍在会话记录、需要时可重新 read）。
- 命令 `/img-slim`（无参报告、`on/off`）。
