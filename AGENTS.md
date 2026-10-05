# AGENTS.md

## 项目概述

pi（`@earendil-works/pi-coding-agent`）的个人定制配置仓库：扩展、主题、提示音、skill 集中管理，`node install.js` 一键装到 `~/.pi/agent/`。**伪编译架构**：源码层高复用（`src/extensions/shared/`），`src/build.js` 用 esbuild 把每个扩展入口打成 `dist/extensions/` 下的**零耦合单文件**（运行时由 pi 经 jiti 直接加载，不经 tsc）。

子系统细节（各扩展的工具/命令/配置文件/硬约束、hud 渲染与状态样式表、测试覆盖、install.js 与补丁全行为）在 skill **`my-pi-dev`** 的 `references/`，**改对应模块前先读那一篇**。

## 常用命令

| 命令 | 作用 |
|---|---|
| `node install.js` | 交互向导：检测 node / pi 本体 / 构建依赖 / rtk → 构建 → 装到 `~/.pi/agent/`。`-y`/`--yes`（非 TTY 自动等价）非交互全自动；`--skip-build` 跳过构建；`--dry-run`/`-n` 只预览 |
| `node src/build.js` | 只构建（install.js 会自动调用；静态资源不经此脚本） |
| `cd src && npm install` | 拉构建依赖（esbuild 等装入 `src/node_modules`） |
| `cd src && npm run typecheck` | = `npx typescript -p config/tsconfig.json`，全扩展类型检查（`tsconfig.json` 是 install.js 生成物；当前 0 报错，换机器/pi 升级后重跑 `node install.js` 重新生成即可） |
| `node src/extensions/<...>/test/<name>.test.mjs` | 回归测试（无 runner、无 test script，见「测试说明」） |
| `node static/patches/<脚本>.mjs` | pi 全局产物补丁（install.js **不会**代跑；pi 升级后需重跑） |

安装后在 pi 里 `/reload` 热加载扩展生效。

## 目录结构

```
install.js            # 安装向导（唯一入口）：见 skill references/install-and-static.md
src/                  # 全部源码 + npm 生态 + 构建脚本（build.js 的唯一输入）
  package.json        #   构建工具与内联依赖声明 + typecheck script；非运行时依赖
  build.js            #   伪编译：只把扩展打成 dist/extensions/
  config/             #   tsconfig.template.json（install.js 填 __PI_ROOT__ 生成 tsconfig.json）/ tsconfig.build.json（无 paths，build 专用）
  extensions/         #   扩展源码（产物 dist/extensions/）
    shared/           #     共享模块：只被扩展 import、不直接部署，build.js 内联进各产物
    hud/              #     3 行 HUD（多文件，入口 index.ts → 产物 hud.ts）
    ask/ btw/ web-tool/ webdav-kb/ workflow-mgr/   # 多文件扩展（入口 index.ts）
    claude-it / explore-agent / status-beacon / perm-gate / pair-guard / crash-log / clipboard / img-slim / dingtalk-bridge / mimo-omni / qr   # 单文件扩展
    test/             #     跨扩展回归测试（status-keys / explore / perm-gate / presence / dingtalk-bridge / mimo-omni + *-live.mjs 联调）
  vendor/             #   社区插件源码收录区（当前仅 pi-rtk-optimizer）+ README.md（出处表/收录原则/回退记录）
static/               # 静态部署物（无需编译）：AGENTS.md / themes/ / sounds/(5 音效) / skills/markitdown/ / models.json / patches/(3 个手工补丁)
dist/                 # 扩展产物（gitignore 不入库，install.js 每次重建）
.pi/                  # 项目级运行时数据：workflow/(工作流区+bindings.json) / explore/ / questionnaires/ / sessions/
```

各扩展一句话职责见 `README.md`；工具名、命令、配置文件、状态 key、坑见 skill 的 `references/extensions-*.md`。

## 架构要点

- **伪编译**：`src/extensions/`（含 shared/、hud/ 多文件目录）→ `src/build.js` → `dist/extensions/`；顺序：改 `src/` → `node install.js`（自动构建+安装）→ pi 内 `/reload`。构建**必须**用 `src/config/tsconfig.build.json`：主 tsconfig 的 `paths` 会把包名解析成 pi 全局绝对路径，破坏 external 白名单匹配、意外内联 typebox。external 白名单只有 `@earendil-works/*` 与 `typebox`，其余 npm 依赖内联 → 产物零外部依赖、运行时零安装。入口规则：顶层 `*.ts` 是单文件扩展，子目录只有含 `index.ts` 才作多文件扩展（`src/extensions/qr/` 只有 test/、不是入口）。
- **安装模型**：install.js 把 dist 产物与 static 资源复制/合并进 `~/.pi/agent/`（会改动的全局文件清单见 skill）。克隆后直接 `node install.js` 即用：自动装 pi 本体、按 package.json 清单补全构建依赖、重建 dist。
- **扩展间零耦合**，通信只走三条公开通道：官方 `ctx.ui.setStatus(key, text)`；`globalThis` 契约 `__PI_HUD_API__` / `__PI_EXPLORE_API__` / `__PI_STATUS_BEACON_API__`（键名与版本在各自 shared 模块单点定义，缺席静默降级）；`.pi/` 下的项目文件（工作流、问卷、会话注册表）。不许 import 对方产物。
- **状态通道分层**：行 1 只显示 priority 最高的一个 key，`STATUS_STYLE`（`src/extensions/hud/hud-core.ts`）是一根轴——输入态 100 > 结果提醒 90+ > 阻塞等人 86/84 > 具体活动 80~60 > 通用运行兜底 58 > 环境信息 56；未登记 key 灰字 priority 0。文案约定：进行中 `<emoji>动作中`、成功 `✓ 结果`、失败 `⚠ 对象失败`，数字与单位空格分隔。`src/extensions/test/status-keys.test.mjs` 双向校验推送 key 与登记表一致。hud 缺席时这些状态自动回落 pi 原生 footer 第 3 行。
- **提醒适配（新扩展对齐 status-beacon，禁止自放提示音）**：完成/出错声由 status-beacon 在 turn 收尾自动触发；凡阻塞等人的 UI（`ctx.ui.custom/select/confirm/input/editor`，含自绘 overlay）自动进 waiting 告警链（提示音 + 标题闪烁 + `task-alert-wait`），无需自己做声音；要让 Working 行说清「在等什么」，弹层**前**经 `__PI_STATUS_BEACON_API__.wait(text)` 登记、结束 `wait(null)`（串行弹层逐个登记）。新增 `setStatus` key 必须同步登记 `STATUS_STYLE`（见测试说明节）。
- **hud 供外部扩展挂底部行**：`__PI_HUD_API__` 的 `registerExtraRows` / `notifyExtraRowsUpdate`；当前 workflow-mgr 已依赖（hud 开启时其常驻面板由 hud 渲染在 footer 最底、自绘面板隐藏，靠 `process.emit("hud:state-change")` 切换）。
- **vendor**：`src/vendor/` 收录社区插件源码副本（当前 pi-rtk-optimizer；pi-subagents / pi-btw 曾收录后回退自研 explore-agent / btw），收录原则、出处表、对齐更新流程、回退记录见 `src/vendor/README.md`。rtk 二进制不入库，由 install.js 按平台下载。
- **多工作流并发隔离**：一个项目可并存多个命名工作流（default 槽 = `.pi/workflow/` 根三 JSON；命名槽 = `slots/<名称>/`），每会话经 `bindings.json` 绑一个槽——解决多 pi 会话同项目跑不同任务互相干扰。session_start 自动判定：单槽/无槽直接绑定（零行为变化）；多槽或有其他活跃会话已绑定 → TUI 弹选择浮窗（「暂不启用」默认高亮 = 绑定 `auto`、不占槽位、AI 自行判断是否用；「从 resume 中加载」放弃本会话转 `/wf-resume`），非 TUI 退化为注入指引让 AI 用 `ask` 问后 `wf_workflow action=bind` 落地。
- **claude-it `/init`**：后台 fork 独立上下文写 `AGENTS.md`（主会话零污染），explore 在场则子代理可派 explore 并行摸底；不设轮数与墙钟上限（`/init cancel` 中止），有「没写完不许停」与完成度核对；**上下文超限自动压缩后续跑**（预算内每请求前剪旧工具结果，超限则把过程记录压成要点重启，最多 2 次）；产出按**上下文分层** L1 `AGENTS.md` / L2 `.pi/skills/<项目名>-dev/`（默认不建，细节成段超载才建，重跑同步维护 L2）/ L3 README 只留一行指路，项目已有子目录 AGENTS.md 时沿用该结构；写完后由全新上下文的审计子代理复核修正（任务里显式列出根+子目录的全部上下文文件，只做删减/合并/下沉/修指针，没动手或末句是意图陈述会被顶回去），再做**确定性结构检查**（各上下文文件死指针 / SKILL.md 索引与 references 一一对应 / frontmatter），有问题带问题再审计一轮（最多两轮）。

## 代码风格与约定

- 缩进 **Tab**；中文注释与文档；文件头有块注释说明用途与实现要点。
- 扩展导出 `export default function (pi: ExtensionAPI)`，配置常量集中在文件顶部「可调配置」区。
- 配置 JSON 读写一律走 `shared/config.ts`（原子写 + 损坏隔离 `.corrupt-`），不要自己 `writeFileSync`。
- **UI 与通用能力一律复用 `shared/`**：浮层边框/输入框/截断/宽度计算走 `shared/ui.ts`（宽度优先用 pi-tui 的 `visibleWidth` / `truncateToWidth`，不要手写全角宽度表），选择列表与确认面板等成块 UI 也收在 shared；shared 里缺能力就补进去、写得不好就改那一处，禁止各扩展自维护一套同类实现。
- **提示词瘦身（所有插件 + 本文档）**：注入给模型的文本（工具 description / promptSnippet / promptGuidelines / 系统提示词 / 注入消息）只写模型需要且别处没有的信息——不解释实现、不复述参数名已表达的内容、不写变更史与自我说明；同一事实只写一处；成段子系统细节下沉到 skill 的 `references/`，所有插件注释不记变更史。改完逐句自问「删掉它会损失什么」，答不上来就删。
- 提交信息：中文 conventional commits（`feat:` / `fix:` / `refactor:` / `chore:` / `docs:`，scope 写扩展名或模块名），单行主题，必要时附正文要点。

## 测试说明

- **无框架、无 runner、无 CI、无 lint**：26 个 `*.test.mjs` 都是独立可执行脚本（自定义 `check()` + exit code，唯一例外 `shared/test/shell-split.test.mjs` 用 `node:assert/strict`），每个文件单独跑：`node src/extensions/<...>/test/<name>.test.mjs`（仓库根执行）。
- 测试需要 `.ts` 时用 esbuild 现场 bundle 成 `.tmp-*.mjs` 再 import（external 白名单同 build.js，tsconfig 用 `config/tsconfig.build.json`）；`qr` 例外（用 jiti 加载产物，与运行时一致）。
- 集成类测试（ask / qr / workflow-mgr / `src/extensions/test/`）依赖 `test/node_modules`（指向 pi 全局包的 link/junction ，**仓库无脚本创建、不入库**，换机器需手工重建）；`hud/test` 与 `shared/test` 不需要。
- 缺省全部离线可跑；`MIMO_LIVE=1`、各 `*-live.mjs` 才需要真实网络/环境（硬编码本机路径，换机器不可用）。
- 新增/修改 `setStatus` 的 key 必须同步登记 `hud-core.ts` 的 `STATUS_STYLE`，否则 `status-keys.test.mjs` 失败且状态永远不会显示。

## 注意事项

- **改完不重装不生效**：源码在 `src/extensions/`，运行时是 `~/.pi/agent/extensions/` 的副本（dist 产物），两处易不同步。流程：改 `src/extensions/` → `node src/build.js` → `node install.js`（或一步 `node install.js`）→ pi 内 `/reload`。只改静态资源（主题色、提示音）可 `node install.js --skip-build`。
- **install.js 会改用户全局文件/目录**（`~/.pi/agent/` 下 settings.json 的 theme + hideThinkingBlock + packages、models.json、AGENTS.md 标记块、extensions 并删历史扩展、vendor 并删已移除包、themes/sounds/skills、rtk 二进制、全局 npm；Linux 另写 `~/.config/fontconfig/conf.d/99-pi-symbols.conf` 修符号字形回退）；先跑 `--dry-run` 预览。models.json 是深度合并（模板键为准），用户文件 JSON 解析失败会被模板覆盖。
- `static/patches/` 三个补丁**不由 install.js 执行**，需手工 `node static/patches/<脚本>.mjs`；pi 升级后都要重跑（祖冲之脚本重跑即自动收敛）。
- `src/config/tsconfig.json` 是 install.js 生成物（gitignore）：`npm root -g` 探测失败会回落常见全局目录候选，全找不到才跳过生成并给出提示。换机器/pi 升级重跑 `node install.js` 即可。
- **`tool_result` 钩子改写 content 必须透传 `structuredContent`**（`structuredContent: event.structuredContent`）：pi ≥ 0.99 的 runner 见到 content 被替换而未带 structuredContent 会丢弃它。img-slim / pair-guard 已遵此约束。
- **`navigateTree` 只返回 `{cancelled}`**：编辑框文本回填由 interactive-mode 内部完成，扩展侧拿不到 editorText（claude-it `/rewind` 依赖此行为）。
- `claude-it.ts` 会拦截裸输入 `exit`（不带 `/`）直接退出 pi，属刻意设计。
- `fullscreen` 渲染模式已定稿（旧 regular 模式的滚动冻结补丁已移除）；其余三补丁与渲染模式无关。
- `docs/`（本地参考资料，版权归第三方）、`scratch/`、`.tmp*`、`dist/`、`.pi/` 下运行时数据均不入库或已被 gitignore；根目录没有 `build.js`（构建脚本在 `src/`）。
