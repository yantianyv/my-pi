# AGENTS.md

## 项目概述

pi（`@earendil-works/pi-coding-agent`）的个人定制配置仓库：扩展、主题、提示音、skill 集中管理，`node install.js` 一键装到 `~/.pi/agent/`。**伪编译架构**：源码层高复用（`src/extensions/shared/`），`src/build.js` 用 esbuild 把每个扩展入口打成 `dist/extensions/` 下的**零耦合单文件**（运行时由 pi 经 jiti 直接加载，不经 tsc）。

子系统细节（各扩展的工具/命令/配置文件/硬约束、hud 渲染与状态样式表、测试覆盖、install.js 与补丁全行为）在 skill **`my-pi-dev`** 的 `references/`，**改对应模块前先读那一篇**。

## 常用命令

| 命令 | 作用 |
|---|---|
| `node install.js` | 交互向导：检测 node / pi 本体 / 构建依赖 / rtk → 构建 → 装到 `~/.pi/agent/` → 装复杂外部依赖（static/deps.json，逐项询问）→ 重打四个 pi 补丁。`-y`/`--yes`（非 TTY 自动等价）非交互全自动；`--skip-build` 跳过构建；`--dry-run`/`-n` 只预览 |
| `node src/build.js` | 只构建（install.js 会自动调用；静态资源不经此脚本） |
| `cd src && npm install` | 拉构建依赖（esbuild 等装入 `src/node_modules`） |
| `cd src && npm run typecheck` | = `npx typescript -p config/tsconfig.json`，全扩展类型检查（`tsconfig.json` 是 install.js 生成物；当前 0 报错，换机器/pi 升级后重跑 `node install.js` 重新生成即可） |
| `node src/extensions/<...>/test/<name>.test.mjs` | 回归测试（无 runner、无 test script，见「测试说明」） |
| `node static/patches/<脚本>.mjs` | pi 安装产物补丁（3 个：usage 防护 / 祖冲之汉化 / 启动垫片取证）；install.js 每次安装**代跑**（幂等、单个失败只告警）；pi 升级后重跑 `node install.js` 即可，单独重跑单个脚本仍可用 |

安装后在 pi 里 `/reload` 热加载扩展生效。

## 目录结构

```
install.js            # 安装向导（唯一入口）：见 skill references/install-and-static.md
src/                  # 全部源码 + npm 生态 + 构建脚本（build.js 的唯一输入）
  package.json        #   构建工具与内联依赖声明 + typecheck script；非运行时依赖
  build.js            #   伪编译：只把扩展打成 dist/extensions/
  config/             #   tsconfig.template.json（install.js 填 __PI_PKG_* / __PI_TYPES__ 生成 tsconfig.json）/ tsconfig.build.json（无 paths，build 专用）
  extensions/         #   扩展源码（产物 dist/extensions/）
    shared/           #     共享模块：只被扩展 import、不直接部署，build.js 内联进各产物
    hud/              #     3 行 HUD（多文件，入口 index.ts → 产物 hud.ts）
    ask/ btw/ draw/ web-tool/ webdav-kb/ workflow-mgr/ model-config/ perm-gate/ dingtalk-bridge/ secret/ skill-hub/   # 多文件扩展（入口 index.ts）
    claude-it / context-init / crash-log / clipboard / explore-agent / img-slim / keep / mimo-omni / pair-guard / qr / status-beacon / time   # 单文件扩展
    computer-use/   # 桌面操作（UIA + OmniParser 双通道；激活制 + 焦点校验 + 全屏差分；带 platform/ 宿主与 model/ 权重，见 README）
    test/             #     跨扩展回归测试（status-keys / draw / draw-panel / explore / perm-gate / presence / dingtalk-bridge / dingtalk-intents / mimo-omni / context-init / crash-log / keep / time + *-live.mjs 联调）
  vendor/             #   社区插件源码收录区（当前仅 pi-rtk-optimizer）+ README.md（出处表/收录原则/回退记录）
static/               # 静态部署物（无需编译）：AGENTS.md / themes/ / sounds/(5 音效) / skills/(markitdown、lean-review：删冗余 + 去 AI 味 / web-ui-review：Web UI 合规) / models.json / deps.json(复杂外部依赖清单) / patches/(4 个 pi 补丁，install.js 代跑)
dist/                 # 扩展产物（gitignore 不入库，install.js 每次重建）
.pi/                  # 项目级：skills/(项目技能，入库) + 运行时数据 explore/ questionnaires/ sessions/ keep-idle/ skill-hub/（工作流数据在全局 ~/.pi/agent/workflow/，见「工作流数据按会话隔离」）
```

各扩展一句话职责见 `README.md`；工具名、命令、配置文件、状态 key、坑见 skill 的 `references/extensions-*.md`。

## 架构要点

- **伪编译**：`src/extensions/`（含 shared/、hud/ 多文件目录）→ `src/build.js` → `dist/extensions/`；顺序：改 `src/` → `node install.js`（自动构建+安装）→ pi 内 `/reload`。构建**必须**用 `src/config/tsconfig.build.json`：主 tsconfig 的 `paths` 会把包名解析成 pi 全局绝对路径，破坏 external 白名单匹配、意外内联 typebox。external 白名单只有 `@earendil-works/*` 与 `typebox`，其余 npm 依赖内联 → 产物零外部依赖、运行时零安装。入口规则：顶层 `*.ts` 是单文件扩展，子目录只有含 `index.ts` 才作多文件扩展（`src/extensions/qr/` 只有 test/、不是入口）。
- **安装模型**：install.js 把 dist 产物与 static 资源复制/合并进 `~/.pi/agent/`（会改动的全局文件清单见 skill）。克隆后直接 `node install.js` 即用：自动装 pi 本体、按 package.json 清单**与本机平台**补全构建依赖（双系统共享 `src/node_modules` 时，另一平台的原生包还在、本机的没有，install.js 按 package-lock 的 os/cpu 约束查出并自动补装）、重建 dist。
- **扩展间零耦合**，通信只走三条公开通道：官方 `ctx.ui.setStatus(key, text)`；`globalThis` 契约 `__PI_HUD_API__` / `__PI_EXPLORE_API__` / `__PI_STATUS_BEACON_API__`（键名与版本在各自 shared 模块单点定义，缺席静默降级）；`.pi/` 下的项目文件（问卷、会话注册表）。不许 import 对方产物。
- **状态通道分层**：行 1 只显示 priority 最高的一个 key，`STATUS_STYLE`（`src/extensions/hud/hud-core.ts`）是一根轴——输入态 100 > 结果提醒 90+ > 挂机态 87 > 阻塞等人 86/84 > 具体活动 80~60 > 通用运行兜底 58 > 环境信息 56；未登记 key 灰字 priority 0。文案约定：进行中 `<emoji>动作中`、成功 `✓ 结果`、失败 `⚠ 对象失败`，数字与单位空格分隔。`src/extensions/test/status-keys.test.mjs` 双向校验推送 key 与登记表一致。hud 缺席时这些状态自动回落 pi 原生 footer 第 3 行。
- **模型调用纪律（新增/改动调用模型的插件必须遵守）**：一次成型的调用一律走 `shared/llm` 的 `aiComplete` 并传入 `shared/model-setting` 的解析链（**禁止**裸调 `completeSimple`/`streamSimple`、也**禁止**自建重试/选模型逻辑——裸调缺 pi 的供应商会话头管道，opencode 系直接 400 MissingSessionID，表现为「AI 审核/概括永远失败降级」）。**超时按失败代价定**：失败比等待更亏的（审核、生成、压缩等）不设 `timeoutMs`，时间给足，中断靠透传 `ctx.signal`（用户 Esc）；只有失败几乎无损的增强类调用（如 Working 行的短语概括）才允许设短超时，快速放弃。**回退只属于 FREE 免费池**（`shared/model-setting`）：其余解析结果为单模型，禁止自建跨模型回退/选模型逻辑。**不得自设输出上限 `maxTokens`**（推理模型的思考 token 计入该预算，小上限会把预算吃在思考阶段，导致正文为空或 JSON 被截断）——成本由模型策略槽控制、长度由提示词约束，与 pi 主会话同一口径。注：`shared/agent` 的 `createPiStreamFn` 只服务子代理多轮循环。
- **模型设置的统一约定（新增用模型的插件必须遵守）**：需要调用模型的插件声明一个**用途**（`shared/model-setting` 的 `createModelSetting({purpose, plugin, label, file?, key?, defaultStrategy})`），由它解析「本地设置（auto|具体模型）→ 中心设置（策略|具体模型）→ 注册时声明的默认策略 → AUTO」并给故障转移链；策略 `AUTO`（当前会话模型）/`FREE`（免费池）语义固定，`MAX/FAST/LITE/BASE/BATCH` 可在 `model-config` 面板重指模型。**禁止**插件自写选模型逻辑或自设优先列表；本地设置 key 只在插件自己的配置文件里（`shared/model-setting` 读改写，保留同文件其它键），中心设置落在 `~/.pi/agent/model-config.json`，跨扩展只走 `globalThis.__PI_MODEL_DECLS__`（用途清单）与这两个文件（面板改完靠每次解析重读生效，无需 /reload）。**两个入口分工**：`/model-config` 面板管中心设置（也能改本地设置，改前二次确认）；各插件自己的 `<插件>-config` 管本地设置。
- **提醒适配（新扩展对齐 status-beacon，禁止自放提示音）**：完成/出错声由 status-beacon 在 turn 收尾自动触发；凡阻塞等人的 UI（`ctx.ui.custom/select/confirm/input/editor`，含自绘 overlay）自动进 waiting 告警链（提示音 + 标题闪烁 + `task-alert-wait`），无需自己做声音；要让 Working 行说清「在等什么」，弹层**前**调 `shared/status.ts` 的 `setWaiting(text)`、结束 `setWaiting(null)`（串行弹层逐个登记；不要自行去摸 `__PI_STATUS_BEACON_API__`）。新增 `setStatus` key 必须同步登记 `STATUS_STYLE`（见测试说明节）。
- **hud 供外部扩展挂底部行**：`__PI_HUD_API__` 的 `registerExtraRows` / `notifyExtraRowsUpdate`；当前 workflow-mgr 已依赖（hud 开启时其常驻面板由 hud 渲染在 footer 最底、自绘面板隐藏，靠 `process.emit("hud:state-change")` 切换）。
- **扩展可带附属资源目录（computer-use 是唯一先例）**：产物是单文件 `dist/extensions/<名>.ts`，但桌面宿主脚本（PowerShell）与 ONNX 权重内联不进去，源码留在 `src/extensions/<名>/{platform,model}/`，由 install.js 的 `EXT_ASSETS` 表 + `installExtAssets()` 整体搬到 `~/.pi/agent/extensions/<名>/`；运行时按产物路径去掉扩展名定位（`extensionDir()`）。两个配套机制：`copyDir` / `removeStaleFiles` 必须跳过这些目录（否则按扩展名过滤会丢 .ts、按"来源已移除"会删权重）、扩展目录可放 `build-external.json` 声明不能内联的 npm 包（目前只有 `onnxruntime-node`）。
- **vendor**：`src/vendor/` 收录社区插件源码副本（当前 pi-rtk-optimizer；pi-subagents / pi-btw 曾收录后回退自研 explore-agent / btw），收录原则、出处表、对齐更新流程、回退记录见 `src/vendor/README.md`。rtk 二进制不入库，由 install.js 按平台下载。
- **工作流数据按会话隔离（全局存储）**：workflow-mgr 的 `workflow.json`/`state.json` 存 `~/.pi/agent/workflow/<项目标识>/<会话 ID>/`（项目标识 = 目录名 + cwd 短哈希，`PI_WORKFLOW_HOME` 可覆盖）——同一项目的多个 pi 会话各写各的文件，天然互不干扰；`resume` 恢复会话即带回其工作流，无需任何选择或绑定。工作流数据不进项目 `.pi/`，项目目录只留随项目走的运行时数据。
- **context-init `/init`**：后台 fork 独立上下文维护项目唯一的 `AGENTS.md`（主会话零污染）。核心是**内容规范**：写每行前过两问（不写会做错吗 / 换一年还成立吗），信息按「多常被需要」分四处——每轮用 → `AGENTS.md`、相关才用 → `.pi/skills/`、在办状态 → 该目录 `STATUS.md`、跨项目经验 → 知识库；子目录 `AGENTS.md` 分流后删除（附映射表），`CLAUDE.md` 合并后删除；顺手做目录对齐（同类只住一处），不强制目录树。explore 在场则派子代理并行摸底（缺席自读）；不设轮数与墙钟上限（`/init cancel` 中止）；上下文超限自动压缩后续跑（≤2 次）；收尾由审计子代理复核 + `shared/context-files.ts` 的结构检查（死指针 / skill 索引对应），有问题带问题再审一轮（最多两轮）。该插件只依赖 pi 的 fs、模型与官方 `setStatus`，其余（explore / hud / 知识库）全是可选增强，缺席静默降级；会话开始时兜底补 `.pi/.gitignore`（白名单式嵌套忽略：放行项目 skill 与本文件自身，其余 pi 运行时数据不入库）。

## 代码风格与约定

- 缩进 **Tab**；中文注释与文档；文件头有块注释说明用途与实现要点。
- 扩展导出 `export default function (pi: ExtensionAPI)`，配置常量集中在文件顶部「可调配置」区。
- 配置 JSON 读写一律走 `shared/config.ts`（原子写 + 损坏隔离 `.corrupt-`），不要自己 `writeFileSync`。
- **旧配置自然迁移或遗弃，不为迁移写代码**（改功能时同样适用）：同名键、同语义就继续读（旧值自然承接）；读不到就走默认值（旧值自然遗弃）；**不写搬迁脚本、兼容分支、“拒绝旧值”的守卫**。仅当旧值与新语义**冲突**（同名不同义会读错、类型不兼容会崩）时才处理，且取最小改法（如读取时忽略该字段、用新键区分），并在注释里写明冲突原因。**但能顺手清的就顺手清**：改动让某个文件/目录/键彻底失去意义时，若**不写代码**就能处理（删掉废弃的配置与数据文件、把全局目录里的旧文件删掉、清掉临时残留），就在当次改动里一并做；判断不准（可能在用、是他人数据、删了不可恢复）就放着不动——**清理不许成为新增代码的理由**。
- **复用优先：重复功能一律走共享组件，非必要不造轮子**。动手写一块新逻辑前先搜 `shared/`（以及 pi-tui / pi-ai 等依赖自身）有没有现成的：UI 边框输入列表走 `shared/ui.ts`，JSON 读写走 `shared/config.ts`，文件删除走 `shared/fs-safe.ts`，模型调用走 `shared/llm` + `shared/model-setting`，状态文案走 `shared/status.ts`，宽度优先用 pi-tui 的 `visibleWidth`/`truncateToWidth`（不要手写全角宽度表）。**已有但不够用就改那一处**，不为「我这块只差一点」而在扩展内另写一份；只有目标语义确实不同（如只读视图 vs 可编辑表单）才新建，且优先放进 `shared/` 供他人复用。判据：同一职责出现第二份实现时，除非能说清为何不能共享，否则就是重复。
- **提示词瘦身（所有插件 + 本文档）**：注入给模型的文本（工具 description / promptSnippet / promptGuidelines / 系统提示词 / 注入消息）只写模型需要且别处没有的信息——不解释实现、不复述参数名已表达的内容、不写变更史与自我说明；同一事实只写一处；成段子系统细节下沉到 skill 的 `references/`，所有插件注释不记变更史。改完逐句自问「删掉它会损失什么」，答不上来就删。
- **命令与工具的对外约定**（新增/改名时照此，改动后跑 `scratch/audit-*.mjs` 类的清单脚本自查）：
  - 命令：**配置类一律 `<插件>-config`，无参开面板、带参只接受"值"直设**（`/mimo-config voice <音色>`）；开关与维护类子命令（`on|off`、`prune`、`clear`）允许留在主命令里；`description` ≤ 45 字符、一句话写用途（必要时附子命令清单），完整用法由命令自身在无参/误用时打印；一个插件只用一个前缀词根，且与工具前缀一致（`wf_*` ↔ `/wf-*`）。
  - 工具：名称 snake_case，多工具插件加 `<插件>_` 前缀（`kb_search`），语义唯一的全局主工具可不带前缀（`ask`、`now`）；**注册必带 `annotations: { readOnlyHint }`**（keep 的停点判定与权限类扩展消费，缺失按只读处理）；参数 camelCase，同义参数固定叫法（`overwrite` 允许覆盖 / `refresh` 强制刷新缓存 / `force` 突破硬限制 / `confirm` 破坏性确认 / `out` 输出文件 / `outDir` 输出目录 / `sourcePath`·`destPath` 本地源与目标 / `maxChars`·`fps`·`pngWidth` 带单位后缀）；`label` 一律动宾短语（`向用户提问`、`查钉钉命令`），不用名词。
  - **codemode 适配**：需要人工交互的工具（问卷、审核面板、输密码）在 codemode 脚本里会同步阻塞（等待计入脚本 `timeout_ms`，超时重试还会堆积），入口先用 `shared/codemode.ts` 的 `isCodemodeCall(toolCallId)` 判定并返回人话拒绝，引导改为直接调用；不带交互的只读/两阶段写法照常可用。高频只读工具建议声明 `outputSchema` 并同时给 `structuredContent`（codemode 脚本拿到结构化对象而非文本；模型侧仍看 content 文本，两者保持一致），用 `shared/tool-result.ts` 的 `toolText(文本, details, structuredContent)` 构造。
  - 模型可见文本：`promptSnippet` 统一 `中文用途：工具名(签名) → 返回物`；`description` 写"做什么 + 关键约束"，用法细节不进；失败**返回 `isError: true` 的人话结果**（含原因与下一步），不 throw（仅编程错误可抛）；工具结果统一带 `details`。
- **不对上游限制层层加码，不给不该限制的东西加限制**（判据见下，两类必须分清）：
  - **上游确有的硬限制 → 只做「如实传递 + 提前预警」，绝不再加一道更严的自己的墙**。上游会明确报错，那个报错有诊断价值；自己先拦下来，用户看到的是「插件坏了」而不是「上游拒绝了这个请求」，还得反查是谁拦的。典型反例：本地转发层曾对请求体设 24MB 硬上限（上游能吃更大），而 pi 会把历史图片每轮原样重发、几十 MB 是正常现象，结果表现为「请求体解析失败：请求体超过 24MB 上限」——一个纯本地发明、且比上游更严的墙。需要缓冲内存时把上限定在**明显高于真实需求**的位置（如 512MB）只防失控，并把「上游多少、留多少余量」写进注释。
  - **适配上游时，预算口径要与上游的计量单位对齐，不要各自换算后各设一套**：同一件事只留一处数字。若必须多处，就在注释里交叉引用并保证方向正确（本地预算 < 上游上限），否则会出现「A 认为安全、B 提前拒收」的空档。
  - **不给自己发明的场景加限制**：超时、重试次数、输出长度、字符截断、并发数这类数字，加之前先答「不加会怎样」。答不出具体危害（OOM、刷屏、计费失控）就不要加；能答出就按那个危害定值，并在注释里写下这个值对应哪个危害——**没有危害说明的上限默认是错的**。
  - **该等的地方不要用「设个短超时快速放弃」代替正确的等待**：失败代价高于等待代价的操作（审核、生成、压缩、抓取）不设 timeout，靠透传 `ctx.signal` 允许用户 Esc 中断；只有失败几乎无损的增强类调用才允许短超时。参见「模型调用纪律」。
- 提交信息：中文 conventional commits（`feat:` / `fix:` / `refactor:` / `chore:` / `docs:`，scope 写扩展名或模块名），单行主题，必要时附正文要点。

## 测试说明

- **无框架、无 runner、无 CI、无 lint**：69 个 `*.test.mjs` 都是独立可执行脚本（自定义 `check()` + exit code，唯一例外 `shared/test/shell-split.test.mjs` 用 `node:assert/strict`），每个文件单独跑：`node src/extensions/<...>/test/<name>.test.mjs`（仓库根执行）。
- 测试需要 `.ts` 时用 esbuild 现场 bundle 成 `.tmp-*.mjs` 再 import（external 白名单同 build.js，tsconfig 用 `config/tsconfig.build.json`）；`qr` 例外（用 jiti 加载产物，与运行时一致）。
- 集成类测试（ask / qr / workflow-mgr / `src/extensions/test/`）依赖 `src/extensions/node_modules/` 的 pi 安装包副本（不入库）——换机器或 pi 升级后跑 `node src/extensions/test/relink-deps.mjs` 重建（优先链接，不支持链接的文件系统回退递归复制）；`hud/test` 与 `shared/test` 不需要。
- 缺省全部离线可跑；`MIMO_LIVE=1`、各 `*-live.mjs` 才需要真实网络/环境（硬编码本机路径，换机器不可用）。
- 新增/修改 `setStatus` 的 key 必须同步登记 `hud-core.ts` 的 `STATUS_STYLE`，否则 `status-keys.test.mjs` 失败且状态永远不会显示。

## 注意事项

- **改完不重装不生效**：源码在 `src/extensions/`，运行时是 `~/.pi/agent/extensions/` 的副本（dist 产物），两处易不同步。流程：改 `src/extensions/` → `node src/build.js` → `node install.js`（或一步 `node install.js`）→ pi 内 `/reload`。只改静态资源（主题色、提示音）可 `node install.js --skip-build`。
- **install.js 会改用户全局文件/目录**（`~/.pi/agent/` 下 settings.json 的 theme + hideThinkingBlock + packages、models.json、AGENTS.md 标记块、extensions 并删历史扩展、vendor 并删已移除包、themes/sounds/skills、rtk 二进制、全局 npm；Linux 另写 `~/.config/fontconfig/conf.d/99-pi-symbols.conf` 修符号字形回退）；先跑 `--dry-run` 预览。models.json 是深度合并（模板键为准），用户文件 JSON 解析失败会被模板覆盖。
- `static/patches/` 四个补丁由 install.js 每次安装**代跑**（幂等，已打则跳过，单个失败只告警不阻塞）；单独重跑仍可 `node static/patches/<脚本>.mjs`，pi 升级后重跑 `node install.js` 就一起重打了。**pi 安装目录定位统一走 `static/patches/pi-root.mjs`**（托管安装 releases-v1 与 npm 全局两种布局都认，别在各脚本里自写探测）。
- `src/config/tsconfig.json` 是 install.js 生成物（gitignore）：按 `__PI_PKG_*` / `__PI_TYPES__` 占位符逐个解析 pi 各包 .d.ts（托管安装与 npm 全局、嵌套与提升布局都认）；探测不到 pi 安装目录才跳过生成并给出提示。换机器/pi 升级重跑 `node install.js` 即可。
- **pi 用自带安装器时为「托管安装」**（`~/.pi/agent/install/releases/<版本>/node_modules` + 启动器 `~/.pi/agent/bin/pi`，环境变量 `PI_MANAGED_INSTALL_ROOT`），此时 `npm root -g` 下没有 pi：install.js、补丁脚本、relink-deps 均按托管安装优先探测，不要再假设 npm 全局。
- **`tool_result` 钩子改写 content 必须透传 `structuredContent`**（`structuredContent: event.structuredContent`）：pi ≥ 0.99 的 runner 见到 content 被替换而未带 structuredContent 会丢弃它。img-slim / pair-guard 已遵此约束。
- **`@earendil-works/pi-ai` 只能从根入口或 `compat` / `oauth` / `providers/all` 导入**：pi 加载扩展走 jiti 别名表，深路径（如 `pi-ai/utils/transcript`）在 node ESM 下能解析、在 pi 里加载即报错（keep 曾因此加载失败）。
- **`navigateTree` 只返回 `{cancelled}`**：编辑框文本回填由 interactive-mode 内部完成，扩展侧拿不到 editorText（claude-it `/rewind` 依赖此行为）。
- **`fs.rmSync` 在含中文的路径下会静默不删**（报成功但文件仍在；`unlinkSync` / `rmdirSync` 正常）：运行时扩展的删除一律走 `shared/fs-safe.ts` 的 `removePath()`，脚本侧用同款手写递归（build.js 清旧产物、relink-deps 换布局），不要依赖 `rmSync`。先删后写的覆盖类操作尤其危险：删不掉的旧目录会被新文件就地合并，两版内容混成一棵树。
- `claude-it.ts` 会拦截裸输入 `exit`（不带 `/`）直接退出 pi，属刻意设计。
- `fullscreen` 渲染模式已定稿（旧 regular 模式的滚动冻结补丁已移除）；其余三补丁与渲染模式无关。
- `docs/`（本地参考资料，版权归第三方）、`scratch/`、`.tmp*`、`dist/`、`.pi/` 下运行时数据均不入库或已被 gitignore；根目录没有 `build.js`（构建脚本在 `src/`）。
