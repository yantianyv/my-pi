# AGENTS.md

## 项目概述

pi（@earendil-works/pi-coding-agent）的个人定制配置仓库：主题、扩展、提示音集中管理，`install.js` 一键安装到全局配置目录 `~/.pi/agent/`。**伪编译架构**：源码层高复用（`src/extensions/shared/` 共享模块），`src/build.js` 用 esbuild 把每个扩展入口打包成 `dist/extensions/` 下的**零耦合单文件**（运行时由 pi 经 jiti 直接加载，不经过 tsc/构建产物转换）。

## 常用命令

| 命令 | 作用 | 出处 |
|---|---|---|
| `node install.js` | 交互式环境安装向导：检测 node/pi 本体/esbuild/rtk → 逐步确认（pi 缺失自动 `npm i -g @earendil-works/pi-coding-agent`、esbuild 缺失自动 `npm install`、rtk 缺失可选自动下载跨平台二进制）→ 构建 → 安装到 `~/.pi/agent/`（含 theme=matrix）；**`-y` 非交互全自动**（非 TTY 环境自动等价）；`--skip-build` 跳过构建、`--dry-run` 只预览不询问不修改；脚本路径自适应（任意目录下 node <绝对路径>/install.js 均可） | install.js |
| `node install.js --dry-run`（或 `-n`） | 试运行，只打印不修改（不询问、不触发构建/安装） | install.js |
| `node src/build.js` | 伪编译：esbuild 把 src/extensions/ 源码（含 shared/、hud/ 子模块）内联打包成 dist/extensions/ 下的零耦合单文件（hud/ → hud.ts）；静态资源不经本脚本；install.js 会自动调用，也可手动单独跑 | src/build.js |
| `npm install` | 首次拉取构建依赖（在 src/ 下执行，esbuild 装入 src/node_modules） | src/package.json |
| `npx typescript -p src/config/tsconfig.json` | 全扩展类型检查（`tsconfig.json` 由 `install.js` 从 `tsconfig.template.json` 生成：探测 `npm root -g` 并用 `paths` 把 pi 全局安装的 `@earendil-works/*` / `typebox` 映射进来；当前 0 报错，换机器/pi 升级后重跑 `node install.js` 即可） | 本仓库惯例 |

无测试、无 lint、无 CI。安装后在 pi 里 `/reload` 热加载扩展生效。

## 目录结构

```
install.js          # 安装脚本（根目录）：交互式向导——检测并自动安装 pi 本体（npm i -g，缺失时）+ 构建依赖 esbuild（npm install）+ 可选依赖 rtk 二进制（缺失时按平台下载 GitHub release，直连优先、gh-proxy 镜像回落，checksums.txt 校验）→ 执行 src/build.js 构建 → 从 dist/extensions/ 装扩展产物、从 static/ 装静态资源（themes/sounds/models.json，无需编译）→ 生成 src/config/tsconfig.json（探测 pi 全局目录）；-y 非交互全自动，--skip-build 跳过构建，--dry-run 只预览
.gitignore          # 忽略生成物 tsconfig.json / node_modules / dist（产物不入库）
README.md           # 项目说明（含 HUD 图例、各扩展用法、卸载方法）
src/                # 全部源码 / 原始素材 + npm 生态 + 构建脚本（build.js 的唯一输入）
  package.json      #   构建工具声明（esbuild + turndown/domino/gfm 构建时内联依赖；npm install 拉取）+ typecheck script；非运行时依赖
  package-lock.json #   npm 锁定文件（入库）
  node_modules/     #   npm install 生成（gitignore，不入库）
  build.js          #   伪编译脚本（与 npm 生态同层，require esbuild 自然命中 src/node_modules）：只打包扩展产物到 dist/extensions/（静态资源不经编译，install.js 直接从 static/ 装）
  config/           #   tsconfig 模板 / 构建配置 / 生成物
    tsconfig.template.json  #     install.js 探测 pi 全局目录后替换 __PI_ROOT__ 生成 tsconfig.json
    tsconfig.build.json     #     build.js 专用：无 paths 的构建 tsconfig（主 tsconfig 的 paths 会破坏 external 白名单的包名匹配）
    tsconfig.json           #     生成物（gitignore，不入库）
  extensions/       #   扩展源码（产物 dist/extensions/ 由 build.js 生成）
    shared/         #     共享模块：只被扩展 import，不直接部署；build.js 内联进各产物
      agent.ts      #       子代理公共件：convertToLlm 消息转换 + createPiStreamFn 认证通道（claude-it /init、workflow-mgr 审计共用）
      config.ts     #       JSON 配置读写：原子写（tmp+rename）、损坏隔离（.corrupt- 留证）、残留 tmp 清理
      ui.ts         #       通用面板组件原语：createBoxRenderer（浮层边框渲染）/ editInput（输入编辑键统一：
                      #       含 paste 粘贴、ctrl+←→ 按词移动、ctrl+w 删词、grapheme 安全步进）/
                      #       renderScrollingInput（水平滚动输入框）/ renderInputWithCursor
      markdown.ts   #       终端 markdown 轻渲染（wrapText / renderAnswer：行内样式、代码块、表格块整体渲染），
                      #       原 btw/render.ts，ask 说明题复用后上提；btw/render.ts 保留同名转发
      model-pick.ts #       辅助 AI 任务选模型：pickAuxModel（优先列表 + 最便宜已认证兜底），hud-git / perm-gate 共用
      model-selector.ts #   通用模型选择面板：复用 pi 官方 ModelSelectorComponent（ModelRegistry.runtime 直通），perm-gate 用
      shell-split.ts  #     shell 复合命令拆段（&&/||/;/|/换行/子 shell 递归，引号转义保护），perm-gate 逐段判定用；
                      #       test/shell-split.test.mjs 回归测试（20 场景）
    hud/            #     3 行 HUD（多文件扩展源码：build.js 把 index.ts 入口打包成单文件 hud.ts）
      index.ts      #       入口薄壳：re-export hud-core（pi 加载约定）
      hud-core.ts   #       核心：渲染 + 生命周期 + 命令；开启时置 globalThis.__PI_HUD_ACTIVE__（dispose 时清），workflow-mgr 据此接管底部行；子模块动态加载，缺失时降级显示
      hud-balance.ts#       hud-balance：供应商余额适配器（BALANCE_ADAPTERS 注册表）
      hud-cost.ts   #       hud-cost：消耗统计 / DeepSeek 定价 / 按量付费文本 / 实时汇率
      hud-git.ts    #       hud-git：git 状态解析
      test/         #       hud-git 路径引号解码回归测试（node src/extensions/hud/test/unquote.test.mjs）
    ask/          #     问卷（多文件扩展源码，build.js 把 index.ts 打包成单文件 ask.ts）：types.ts 数据模型/容错规范化（含 note 只读说明题与问卷级 context）+ store.ts 问卷文件读写（.pi/questionnaires/）+ page.ts 整屏问卷页（进度条/跳题/答案一览/帮助屏/删除/说明题与上下文折叠）+ 选择器 + tool.ts ask 工具（create 创建 / cancel 作废，context/includeLastMessage 附上下文）+ commands.ts /answer 命令 + state.ts 状态推送/排队链；test/ask.test.mjs 回归测试（A~R + 渲染不变量）
    btf-think.ts  #   思考折叠标签动画（Thinking... 逐帧动画，独立 UI 反馈插件）
    btw/          #   旁支问答（多文件扩展源码，build.js 把 index.ts 打包成单文件 btw.ts）：
                    #     config.ts 常量/系统提示词/模型设置（auto 最便宜故障转移）+ messages.ts 消息清洗 +
                    #     render.ts（转发 shared/markdown：markdown 渲染已上提共用）+ overlay.ts 浮层组件 +
                    #     run.ts 后台流式问答 + index.ts 入口；
                    #     /btw 多轮追问 + m 转正附带 + /btw-config 模型选择；只读工具；曾用官方 pi-btw 替代，
                    #     2026-09-07 因 bug 回退（出处与借鉴评估见 src/vendor/README.md 回退记录）
    clipboard.ts #   剪贴板读写：clipboard_get 读取（可截断）+ clipboard_set 写入（空串清空）+ /clipboard 命令；
                    #   跨平台（Windows PowerShell Get/Set-Clipboard、macOS pbpaste/pbcopy、Linux xclip 退 xsel，
                    #   零依赖，统一临时文件中转规避 PS5.1 管道 UTF-16LE 编码乱码与 shell 转义；读时 CRLF→LF 归一化），
                    #   write 前读旧内容摘要报告覆盖、状态走 shared/status 联动 hud
    qr.ts         #   二维码：qr_encode 编码（显示到 UI：图形终端 PNG 真图 / 普通终端半块字符 ANSI 绘制，
                    #   可扫；PNG 可选落盘）+ qr_decode 解码（本地路径/URL，PNG/JPEG 纯 JS）+ /qr 命令；
                    #   qrcode/jsqr/pngjs/jpeg-js 由 build.js 内联，会话回放安全（details 只存原文，
                    #   渲染时同步重编码）；test/qr.test.mjs 回归测试（jiti 加载产物，24 场景）
    img-slim.ts   #   图片请求体预算：三层防护防上游 48MiB 请求体 413——tool_result/input 钩子给新图瘦身
                    #   （照片 ≤900KB、图形 ≤1.6MB、最长边 2000px、PNG 优先，动图 WebP 强制转静态 PNG，
                    #   <300KB 不碰）+ context 钩子每轮请求前按 32MB 总量预算从最旧开始省略历史图片
                    #   （只改本次请求、非破坏性，>40MB 时新图半预算温和降级）+ /img-slim 报告与开关；
                    #   背景：pi 历史图片每轮原样重发、token 估算每图仅记 1200 tokens（1M 窗口要 820 张才
                    #   触发压缩），请求体上限永远先到（实测会话 76 张/75.6MB 起连续 413、涨到 186 张/186.5MB）
    crash-log.ts  #   崩溃黑匣子：prependListener 抢在 pi 的 uncaughtException 处理器（同步 exit）之前把堆栈
                    #   同步落盘 ~/.pi/agent/pi-crash.log（含 unhandledRejection 与 exit 码），崩溃条目与会话文件按时间配对
    perm-gate.ts    #   bash 命令三级权限门：黑名单人工复核 / 白名单放行 / AI 审核（模型覆盖项仿 pi-btw：
                    #   /perm-gate model 复用官方 ModelSelectorComponent 面板直选，未覆盖回落 shared/model-pick 自动选；审核失败转人工；
                    #   复合命令经 shared/shell-split 拆段逐段判定（白名单每段都要命中，防「git status && rm -rf x」绕过）；
                    #   review 结论附 AI 提炼的候选正则（1~3 个、从窄到宽），加白/加黑时选用；
                    #   allow 结论自动加白：采纳 AI 提炼的单条语义白名单正则 whitelistPattern（AI 语义自选粒度），
                    #   缺失/跑偏退结构化兜底/精确段规则；review 结论才提炼 1~3 候选正则供人工面板选粒度；
                    #   自动加白通知展示 AI 概括的命令意图而非规则原文；
                    #   白名单规则带保鲜元数据（addedAt/lastHit/hits，命中时刷新），超 30 天未命中自动清理（启动/加白时），
                    #   /perm-gate prune 手动清理、状态行提示过期条数；旧版纯字符串配置自动归一化兼容；
                    #   ~/.pi/agent/perm-gate.json 配置 + /perm-gate 命令）
    pair-guard.ts   #   多 pi 会话并发协作守卫：项目级会话注册表（.pi/sessions/<sid>.json，30s 心跳、5min 超时判死、
                    #   崩溃残留扫描时顺带清理）；write/edit 记录「最近在改哪些文件」（10min 滚动窗口）；
                    #   并发广播：peer 加入/离开/新触碰文件/标签变化以定制消息追加对话尾部（变化驱动、事件键去重、
                    #   极简直播格式、协作约定仅首批附带；绝对时间戳，尾部追加不破坏前缀缓存，消息入历史可回查）；写 peer 近窗口文件时 tool_result
                    #   追加 ⚠️ 软警告；任务标签手动 /pair label 优先、自动读 workflow-mgr 当前任务回落；
                    #   状态行推「👥 N 并发会话」+ peer 出现/消失 notify + /pair 命令
    claude-it.ts      #   Claude Code 风格：/init 在后台独立上下文生成/更新 AGENTS.md（只产出 AGENTS.md，不生成 CLAUDE.md）、/exit 别名、Ctrl+C 取消 turn、双击 Ctrl+C 预填 /rewind 回退
    status-beacon.ts  #   全链路状态感知（前身 task-alert）：执行中标题进度（agent_start→settled 全程 spinner+当前工具活动+目录名，提醒期间让位、应答后恢复）+ 五状态五音效（完成/出错/等待人工 ui_prompt/空闲 60s/子代理完成，音源 ClaudeCodeInit wav/piano）+ 提醒标题动画 + setStatus 状态推送（三状态独立 key，沿用 task-alert* 旧名）
    workflow-mgr/     #   人机协作任务面板（多文件扩展源码：build.js 把 index.ts 入口打包成单文件 workflow-mgr.ts）
      index.ts        #     插件主体（组装薄壳）：tools.ts（7 个工具 wf_workflow/status/switch/block/rollback/note/milestone，含 import 一次性导入）+ commands.ts（/workflow-config 只留无参）+ events.ts（session 钩子 + hud 联动 + 条件注入）+ 事件钩子
      tools.ts       #     工具注册：wf_switch（完成+推进一步到位，complete=false 搁置；推进后附 status 记录复核提醒）/ wf_note（AI 记录，对用户透明：kind=fact/status 时效分类 + key 主题键顶替防决策打架，status 记录切换任务时提醒复核）/ wf_milestone（增删改）等 7 工具；wf_workflow import 初始化一次性导入（草稿 json，id 自动生成 + 全图环检测带链路，非空拒绝）
      commands.ts    #     /workflow-config 命令：只留无参（TUI 浮窗 / 非 TUI 文本面板），无子命令
      events.ts      #     事件钩子：session_start / hud:state-change / session_shutdown / before_agent_start（三态条件注入）
      store.ts        #     数据层：workflow/state/config 三 JSON 加载保存 + 派生表（含 mode）+ reconcile 一致性 + 依赖环检测；WorkflowStore 构造时固化 cwd（不持有 ctx），session 替换后不触发 stale
      audit.ts        #     完成信号独立审计（借鉴 pi-goal-x completion auditor）：config.json 开 auditOnComplete 后，wf_switch 完成推进前派全新上下文的只读+bash 子代理核验 doneSignal，不通过则打回；审计自身故障放行（增强不是门禁）
      brief.ts        #     AI 简报：renderBrief（当前任务+分工+完成信号+最近记录）/ summaryLine / lightState
      panel.ts        #     展示层：常驻 widget（belowEditor）+ /workflow-config 浮窗 + 非 TUI 文本回落（compactLines 单一渲染源）
      types.ts        #     TaskDef/StageDef/WorkflowState(mode+notes)/PanelConfig 类型 + schema 常量
      test/render.test.mjs #   渲染回归测试（esbuild bundle + mock pi/ctx；test/node_modules junction 指 pi 全局，不入库；15 场景 A-O）
      test/stale-ctx.test.mjs#  stale ctx 回归测试：session 替换后 getStore 不崩（固化 cwd）+ cwd 变化重建
    web-tool/         #   联网工具（多文件扩展源码，build.js 把 index.ts 打包成单文件 web-tool.ts：http.ts 网络层/代理 + search.ts 搜索评分 + fetch.ts 抓取 + dislike.ts 差评 + panel.ts 面板 + index.ts 入口）：web_search 多源搜索（bing + 360 + baidu 三源并行，结果逐条评分合并去重取前 15：标题/URL/摘要权重计分 + 完整短语命中加成，评分 0 滤除；npm 垂类，零 key 零费用，无 AI 总结；第三源选型实测否决 DDG 202 反爬/Jina 不可达/Mojeek 403，见 search.ts 头注释）+ web_dislike 差评降权（AI 对低质量域名记差评，持久化黑名单跨会话生效，×0.6/次、5 次滤除）+ web_fetch 抓网页转 markdown（正文提取 + 截断；turndown/domino/gfm 由 build.js 内联；GitHub blob URL 重写 raw 直取防源码被当标签吞；正文极短（JS 空壳）用 Googlebot UA 重试一次）+ /web-tool-config 代理设置面板（含 blacklist 差评查看/清空）；直连与降级（系统 curl 自动带代理 / 无 curl 退 Node CONNECT 隧道）并行竞速，谁先成功用谁、404 等确定性错误立即判死
    webdav-kb/        #   知识库（WebDAV 云网盘）：14 个 kb_* 工具（help/search/read/write/append/list/upload/download/lslfs/move/delete/status/sync/import）+ /kb /kb-config /kb-sync 命令；本地镜像 + 增量同步（etag/mtime 比对、冲突 .conflict- 副本、同步后自动清理本地空目录）+ 同步健壮性（借鉴 pi-sync：.kb-sync.lock 互斥锁（活锁拒绝/死进程 30min 回收）+ .kb-sync-journal.json 中断恢复 + 上传前 secret 扫描拦截（secrets.ts 高精度模式，allowSecretUpload 兜底）+ delRemote 404 幂等）+ vault 加密区 + LFS 大文件区 + /.history 历史副本区（改动/删除自动留档：结构镜像根、文件名 _yymmddhhmmss 后缀、同秒重名叠 _hash、同内容跳过、自身不递归、不参与列表/检索，恢复走 WebDAV 客户端）；纯文本多格式全文索引（md/txt/csv/tsv/json/jsonl/yaml/yml/toml/html/xml，csv/tsv 表头加权，frontmatter 仅 md 强制）；分类层级守则：/命名空间/用途/自由层级（用途=文档功能六值判定硬约束，自由层级 AI 管理软约束，见 PROTOCOL.md「五、分类层级」）；PROTOCOL.md 守则对 kb_list/kb_status 不透明（走 kb_help 专用通道，kb_search 保留索引兜底；源码默认版 protocol.ts，远端用户可手动迭代）；只读模式（`readOnly`，/kb-config 面板切换、默认关、下次会话生效）：session_start 一次性隐藏 6 个写工具（write/append/upload/import/delete/move，kb_sync 保留），syncAll 随 cfg.readOnly 自适应为仅下载（本地删除→重新下载、本地新建/修改留本地），ensureProtocol 跳过
static/              #   静态部署物（无需编译，install.js 直接从这装到 ~/.pi/agent/，见 README 各补丁节；仓库根目录）
  themes/matrix.json  #     黑客帝国荧光绿主题
  sounds/task_complete.wav  #     任务完成提示音
  patches/            #     pi 补丁脚本
    apply-pi-ai-usage-guard.mjs     #       pi-ai usage 缺失防护补丁：模型偶发返回无 usage 的 assistant 消息导致后续调用瞬时失败；pi 升级后需重跑
    apply-zuchongzhi-zh.mjs        #       祖冲之汉化补丁：pi 无官方 i18n，直接替换 dist 编译产物硬编码英文为中文（236 处/9 文件）；pi 升级后需重跑
    apply-pi-launch-report.mjs     #       启动垫片取证补丁 v2：给 npm 的 pi.cmd/pi.ps1/pi 注入 NODE_OPTIONS（8GB 堆 + --report-on-fatalerror）
                                   #       + stderr 追加落盘 ~/.pi/agent/pi-stderr.log + ps1 记录 [START]/[EXIT] 退出码；背景是 pi 反复无声崩溃，
                                   #       崩溃取证史（含当时的机器与退出码细节）见补丁文件头注释，不写入本文档（与环境解耦）
                                   #       ；幂等、自动清理 v1 注入；pi 升级后需重跑
  models.json        #     OpenRouter 路由模板：install.js 复制/深度合并到 ~/.pi/agent/models.json（见 README「OpenRouter 路由策略」节）
  vendor/           #   官方（社区）插件源码收录区（与 extensions/ 同级）：pi-rtk-optimizer（替代自研 token-saver；
                      #   pi-subagents / pi-btw 曾收录后回退自研版，见 README 回退记录）；MIT 原样收录（含各自 LICENSE），
                      #   README.md 含出处表与对齐更新流程；install.js 复制到 ~/.pi/agent/vendor/、有依赖的包补
                      #   npm install --omit=dev、本地路径注册进 settings.json 的 packages（并自动注销已移除的包）；
                      #   伴随物 rtk 二进制（Apache-2.0）不入库，由 install.js 按平台自动下载（跨平台资产映射见 install.js 顶部配置）
dist/               # 扩展产物（build.js 生成，gitignore 不入库）：install.js 只认这里的 extensions/；每次 install 自动重建，克隆后 node install.js 即用（pi/esbuild 缺失自动装）
  extensions/       #   扩展产物：每扩展一个零耦合单文件 .ts（hud.ts 由 hud/ 合并而来）
    ask.ts          #     ask/ 合并为单文件（问卷）
    hud.ts          #     hud/ 五个子模块合并为单文件（解决 hud 拆分问题）
    ...             #     其余扩展与源码同名
.pi/                # 项目级运行时数据：workflow/ 三 JSON（workflow.json/state.json/config.json，可 git 审查）+ archive/ 归档留档（wf_workflow archive 移入，无找回功能）；空目录占位防空
```

## 架构要点

- **伪编译架构**：`src/`（源码：extensions/ 含 shared/ 共享模块与 hud/ 子目录）→ `src/build.js`（esbuild bundle 扩展，与 npm 生态同层、require esbuild 自然命中）→ `dist/extensions/`（扩展产物，**gitignore 不入库**）；静态资源（static/）无需编译，install.js 直接从 static/ 安装。`install.js` 每次运行先自动 build（缺失即报错提示）。克隆后直接 `node install.js` 即用（自动装 pi 本体/esbuild 并重建 dist，无需入库）；改了 src/ 后 `node install.js` 一步构建+安装。构建用 `src/config/tsconfig.build.json`（无 paths）——主 tsconfig 的 paths 会把包名解析成 pi 全局绝对路径，导致 external 白名单的包名匹配失效、意外内联 typebox。产物 external 白名单只留 `@earendil-works/*` 与 `typebox`，其余 npm 依赖（如 web-tool 的 turndown/domino/gfm）被 esbuild 内联进单文件——产物仍是零外部依赖单文件，运行时零安装。
- **安装模型**：`install.js` 把 dist/extensions/ 产物与 static/ 静态资源（themes/sounds/models.json）复制到 `~/.pi/agent/` 对应位置；改扩展源码后跑 `node install.js`（自动 build）+ pi 内 `/reload`；改静态资源（主题色、提示音）只需 `node install.js --skip-build` 重装即可，无需重新编译。
- **扩展间联动**：展示层统一走**官方 `ctx.ui.setStatus(key, text)` 状态通道**（`status-beacon` 推 `task-alert`/`task-alert-error`/`task-alert-wait` 闪烁帧（key 沿用旧名）、`claude-it` 推 `init` 进度、`web-tool` 推 `web-search`/`web-fetch` 状态、`workflow-mgr` 推 `workflow-mgr` 进度摘要、hud 自身推 `balance-error`/`model-switch`/`hud-bash`）；`hud/hud-core.ts` 渲染行 1 动态区时按 `STATUS_STYLE` 样式表（hud/hud-core.ts）映射颜色与优先级（数字大者胜出），TTL/闪烁由各推送方自管。扩展间零耦合：setStatus 是 pi 原生接口，各插件推状态**不依赖 hud**（hud 缺席时状态自动回落原生 footer 第 3 行 `getExtensionStatuses()`，hud 兼容该通道仅做展示）。hud 置 `globalThis.__PI_HUD_ACTIVE__`（installFooter 时 true、dispose 时 false）供依赖 hud 特有功能的扩展校验，并暴露**通用底部行接口** `__PI_HUD_API__`（`registerExtraRows`/`notifyExtraRowsUpdate`，hud-core.ts）——**当前 workflow-mgr 已依赖**：hud 存在且开启时经该接口注册渲染函数，其常驻面板内容（任务/分工/里程碑 ≈4 行，内容与样式由 workflow 自决、与面板同款）由 hud 在 footer 底部渲染（屏幕最底），面板隐藏；showPanel 关闭或 hud 关闭（`hud:state-change` 事件）时注销底部行并恢复自绘面板（hud-core.ts extraRowProviders / workflow-mgr panel.ts renderHudRows）。
- **hud 余额适配**：`BALANCE_ADAPTERS` 注册表（hud/hud-balance.ts）按 providerId 逐一适配；DeepSeek 消耗按 `DEEPSEEK_PRICES`（hud/hud-cost.ts）官方人民币定价直算（恒 ¥，永不依赖汇率），峰谷开关 `DEEPSEEK_PEAK_PRICING`（hud/hud-cost.ts，当前 false）；其余供应商成本按原始货币 USD 记录、显示时换算。汇率三态（hud/hud-cost.ts）：实时（frankfurter→open.er-api 多源，1h 节流）→ 磁盘缓存（`~/.pi/agent/tmp/exchange-rate.json`）→ 无（断网且无缓存，显示原始货币 USD，不用固定近似值）。hud 子模块**可选加载**：任一缺失时对应功能降级（余额行显「模块缺失」/ 隐藏消耗统计 / git 恒「⎇ -」），不拖垮整个 HUD。
- **vendor 官方插件**：src/vendor/ 收录社区插件源码副本（pi-rtk-optimizer 输出压缩+rtk 命令改写；pi-subagents/pi-btw 曾收录后回退自研 explore-agent/btw，回退原因与借鉴评估见 src/vendor/README.md 回退记录）；收录原则/出处/更新流程见 src/vendor/README.md。兼容性：pi-rtk-optimizer 不动 footer、setStatus 键不冲突
- **claude-it /init**：fork 独立上下文后台跑 init 子代理（只读探索 + write/edit AGENTS.md），主会话零污染、期间可继续对话；进度经 `ctx.ui.setStatus("init", …)` 推送由 hud 行 1 动态区显示。同时只允许一个，超时/轮数/输出上限常量在文件顶部（claude-it.ts:61-65）。
- **ask 问卷**：AI 侧 `ask` 工具创建问卷（single/multi/text/confirm/rating/number/**note 只读说明**七题型，选项题自动带「其他」自由输入）写入 `.pi/questionnaires/<id>.json` 并立即整屏弹出；用户 Enter 提交（答案作工具结果返回）、Esc 搁置（草稿写回文件 status:draft，随时 /answer 续答，提交后答案经 `pi.sendUserMessage` 以 followUp 送达，文件即删）或主动删除（`Ctrl+D`/非输入行 `D` 按两次确认 → 工具结果 status=deleted，AI 不再等待/不重建）。**问卷级上下文**：整屏弹出会遮住聊天记录，问题依赖 AI 刚发的消息时用 `context` 手动摘要背景或 `includeLastMessage=true` 自动附上上一条回复文本（从 sessionManager 条目倒序提取、遇 user 消息即停、超长截尾 4000 字符），合并后渲染为标题下方的引用块（💬 上下文，超 8 行折叠、与说明题共享 x 键展开）；非 TUI 降级时 flattenQuestions 同样携带。`ask action=cancel id=xxx` 是 AI 侧作废通道（问卷即文件，删文件即撤回；正在整屏作答中的问卷无法作废）。「问卷即文件」：手写 JSON 丢进目录也能被 /answer 扫描识别（有 options 推断 single、有 content 推断 note）。**note 说明题**解决「问卷里看不到 AI 拟的内容」：正文 `content` 多行保留换行、经 shared/markdown 轻渲染后挂在「│ 」左边线下展示，超 20 行默认折叠（x 展开/收起），不产生焦点行、不进进度分母、不阻塞提交、回执里不重复携带正文——AI 把待审草稿原文 + 跟进问题放进同一份问卷，用户边看边答。页面键位：↑↓/Tab 移动（多行简答内 ↑↓ 行间移动光标，边界处才跳出本题）、`Ctrl+↑/↓` 上/下一题（状态行常显「第 i/n 题」）、PgUp/PgDn 翻页、空格选中、数字键 1-9 直选、`Ctrl+P` 答案一览（一览里 `C` 经 pi 官方 `copyToClipboard` 复制答案）、`?` 全屏键位表、`x` 折叠说明、`Ctrl+D` 删除、Esc 搁置；输入行支持 Ctrl+←/→ 按词移动、Ctrl+W 删词、grapheme 安全光标。整屏页 = overlay（width/maxHeight 100% + 左上锚点 + 每行补满全宽）——pi 的 overlay 是逐行不透明合成，全屏即遮蔽聊天/HUD；高度权威值由 overlayOptions.visible 回调每帧捕获（tui.terminal.rows 可能滞后）。渲染细节：顶部进度条 ▰▰▱▱、长文本（标题/题干/选项/说明）经 `wrapTextWithAnsi` 折行完整展示不截断、续行缩进对齐首行文本起点；**首帧停在顶部不跟随焦点**（长说明题从头读），按键后恢复跟随；滚动位置提示（▲▼ 行数）只在状态行右侧，不占正文行；内容窗恒为纯内容。选择器（多份时）显示创建时间/题数/可答题数/草稿标记，支持 `D` 两次删除选中问卷。已知限制：regular（内联）模式下全屏 overlay 与聊天共享原生滚动缓冲，滚轮上滑会看到残影（仅美观问题，实时画面正常）；fullscreen 模式（alternate screen）下零污染。
- **img-slim 图片预算**：三个钩子组成三层防护——`tool_result`/`input` 给新进上下文的图片瘦身（照片≤900KB、图形≤1.6MB base64、最长边 2000px、PNG 优先退 JPEG；动图 WebP 强制转静态 PNG，因为上游 400 拒收且历史重发会让后续每轮都失败），`context` 钩子每轮请求前按 32MB 总量预算从最旧开始把图片换成占位文本（非破坏性：只改本次请求，会话记录不动；`context` 事件的 messages 本就是 pi 的 structuredClone 副本，加处理器不增加拷贝成本）；状态行 `🖼 xMB 裁N图` 走 setStatus。风险模型：上游 48MiB 请求体上限 → 而 pi 的 token 估算每图仅 1200 tokens（4800 字符/4），1M 窗口要 ~820 张才触发自动压缩 ⇒ 上限永远先到（实测 76 张/75.6MB 起连续 413）。
- **claude-it 回退**：`/rewind` 命令（navigateTree 是命令 ctx 专属能力）回退到上一条用户消息、内容放回输入框；双击 Ctrl+C（打断后 2s 窗口内）预填 `/rewind` 命令，回车执行。Ctrl+C 打断不触发 status-beacon 完成提醒——status-beacon 监听 agent_end，最后一条 assistant 消息 `stopReason="aborted"` 即跳过 agent_settled 提醒（零耦合，不依赖 claude-it）。

## 代码风格与约定

- 缩进用 **Tab**；中文注释与文档；文件头有块注释说明用途与实现要点
- 扩展导出 `export default function (pi: ExtensionAPI)`，配置常量集中在文件顶部「可调配置」区
- 提交信息：中文 conventional commits（`feat:` / `fix:` / `refactor:` / `chore:`），早期有 `hud:` 前缀的裸格式；单行主题，必要时附正文要点

## 注意事项

- **改完扩展不重装不生效**：源码在 src/extensions/，运行时是 `~/.pi/agent/extensions/` 的副本（dist 产物），两处易不同步。改动流程：改 `src/extensions/` → `node build.js` → `node install.js` → pi 内 `/reload`。
- `src/config/tsconfig.template.json` → `install.js` 探测 pi 全局目录生成 `src/config/tsconfig.json`（`.gitignore` 忽略生成物，不入库）；生成物仅服务本地 tsc 检查（`paths` 映射 `@earendil-works/*` / `typebox`），运行时仍由 jiti 直接加载，不经 tsc。换机器/pi 升级路径变了重跑 `node install.js` 即可
- `install.js` 会修改全局 `~/.pi/agent/settings.json`（theme 字段），跑 `--dry-run` 先预览；copyDir 已支持子目录递归（多文件扩展 hud/）
- `docs/deepseek/` 是本地参考资料（不入库，版权归 DeepSeek），不要当作可执行配置；`src/sounds/` 只放提示音
- **fullscreen 渲染模式已定稿**（2026-08 起试用，长期观察后转正）：旧 regular（内联）模式的滚动冻结补丁（`apply-pi-tui-scroll-freeze.mjs`）已随 fullscreen 定稿移除（fullscreen 渲染走 `tui-alt-screen.js`，补丁在其下本是死代码）。剩余两个补丁（`apply-pi-ai-usage-guard.mjs` / `apply-zuchongzhi-zh.mjs`）与渲染模式无关，pi 升级后都需重跑。
- `claude-it.ts` 会拦截裸输入 `exit`（不带 `/`）直接退出 pi，属刻意设计
