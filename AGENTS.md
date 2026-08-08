# AGENTS.md

## 项目概述

pi（@earendil-works/pi-coding-agent）的个人定制配置仓库：主题、扩展、提示音集中管理，`install.js` 一键安装到全局配置目录 `~/.pi/agent/`。**伪编译架构**：源码层高复用（`src/extensions/shared/` 共享模块），`src/build.js` 用 esbuild 把每个扩展入口打包成 `dist/extensions/` 下的**零耦合单文件**（运行时由 pi 经 jiti 直接加载，不经过 tsc/构建产物转换）。

## 常用命令

| 命令 | 作用 | 出处 |
|---|---|---|
| `node install.js` | 安装 themes/extensions/sounds 到 `~/.pi/agent/`，并把 settings.json 的 theme 设为 matrix（install.js:150）；**默认先自动执行 src/build.js** 再安装（`--skip-build` 跳过，dry-run 只预览不构建）；脚本路径自适应（任意目录下 node <绝对路径>/install.js 均可） | install.js |
| `node install.js --dry-run`（或 `-n`） | 试运行，只打印不修改（不触发自动构建） | install.js:36 |
| `node src/build.js` | 伪编译：esbuild 把 src/extensions/ 源码（含 shared/、hud/ 子模块）内联打包成 dist/extensions/ 下的零耦合单文件（hud/ → hud.ts），并把 src/static/ 静态部署物拷贝到 dist/；install.js 会自动调用，也可手动单独跑 | src/build.js |
| `npm install` | 首次拉取构建依赖（在 src/ 下执行，esbuild 装入 src/node_modules） | src/package.json |
| `npx typescript -p src/config/tsconfig.json` | 全扩展类型检查（`tsconfig.json` 由 `install.js` 从 `tsconfig.template.json` 生成：探测 `npm root -g` 并用 `paths` 把 pi 全局安装的 `@earendil-works/*` / `typebox` 映射进来；当前 0 报错，换机器/pi 升级后重跑 `node install.js` 即可） | 本仓库惯例 |

无测试、无 lint、无 CI。安装后在 pi 里 `/reload` 热加载扩展生效。

## 目录结构

```
install.js          # 安装脚本（根目录）：把 dist/ 部署物（themes/extensions/sounds/models.json）复制到 ~/.pi/agent/ 对应子目录，并生成 src/config/tsconfig.json（探测 pi 全局目录）；默认先自动执行 src/build.js 再安装（--skip-build 跳过）；dist 缺失报错提示先 build
.gitignore          # 忽略生成物 tsconfig.json / node_modules / dist（产物不入库）
README.md           # 项目说明（含 HUD 图例、各扩展用法、卸载方法）
src/                # 全部源码 / 原始素材 + npm 生态 + 构建脚本（build.js 的唯一输入）
  package.json      #   构建工具声明（esbuild devDependency；npm install 拉取）+ npm scripts；非运行时依赖
  package-lock.json #   npm 锁定文件（入库）
  node_modules/     #   npm install 生成（gitignore，不入库）
  build.js          #   伪编译脚本（与 npm 生态同层，require esbuild 自然命中 src/node_modules）：打包扩展产物 + 拷贝静态素材到 dist/
  config/           #   tsconfig 模板 / 构建配置 / 生成物
    tsconfig.template.json  #     install.js 探测 pi 全局目录后替换 __PI_ROOT__ 生成 tsconfig.json
    tsconfig.build.json     #     build.js 专用：无 paths 的构建 tsconfig（主 tsconfig 的 paths 会破坏 packages: external）
    tsconfig.json           #     生成物（gitignore，不入库）
  extensions/       #   扩展源码（产物 dist/extensions/ 由 build.js 生成）
    shared/         #     共享模块：只被扩展 import，不直接部署；build.js 内联进各产物
      model-select.ts #       可搜索模型选择器（ModelSelectOverlay）+ 模型工具函数（btw / explore 共用）
    hud/            #     3 行 HUD（多文件扩展源码：build.js 把 index.ts 入口打包成单文件 hud.ts）
      index.ts      #       入口薄壳：re-export hud-core（pi 加载约定）
      hud-core.ts   #       核心：渲染 + 生命周期 + 命令；加载时置 globalThis.__PI_HUD_ACTIVE__；子模块动态加载，缺失时降级显示
      hud-balance.ts#       hud-balance：供应商余额适配器（BALANCE_ADAPTERS 注册表）
      hud-cost.ts   #       hud-cost：消耗统计 / DeepSeek 定价 / 按量付费文本 / 实时汇率
      hud-git.ts    #       hud-git：git 状态解析
    btw.ts        #     /btw 临时旁支问答浮层 + /btw-config 模型配置（设置持久化到 ~/.pi/agent/btw-config.json）
    btf-think.ts  #   思考折叠标签动画（Thinking... 逐帧动画，独立 UI 反馈插件）
    claude-it.ts      #   Claude Code 风格：/init 在后台独立上下文生成/更新 AGENTS.md（只产出 AGENTS.md，不生成 CLAUDE.md）、/exit 别名、Ctrl+C 取消 turn、双击 Ctrl+C 预填 /rewind 回退
    explore-agent.ts  #   explore 工具：只读子代理并行探索代码库（read/ls/grep/find）
    token-saver.ts    #   上下文 token 节省器：自动清洗 bash 工具的冗余输出（git/npm/tsc/pip/docker/--help）
    task-alert.ts     #   任务完成提醒：提示音 + 标题动画 + setStatus 状态推送
    web-search.ts     #   联网搜索工具：web_search 自定义工具，agent 可调（kimi-coding 后端）
  static/           #   静态部署物（build.js 原样拷入 dist/，见 README 各补丁节）
    themes/matrix.json  #     黑客帝国荧光绿主题
    sounds/task_complete.wav  #     任务完成提示音
    patches/            #     pi 补丁脚本
      apply-pi-tui-scroll-freeze.mjs  #       pi-tui 滚动冻结补丁：修复流式期间滚轮上翻被拽飞；pi 升级后需重跑
      apply-pi-ai-usage-guard.mjs     #       pi-ai usage 缺失防护补丁：模型偶发返回无 usage 的 assistant 消息导致后续调用瞬时失败；pi 升级后需重跑
      apply-zuchongzhi-zh.mjs        #       祖冲之汉化补丁：pi 无官方 i18n，直接替换 dist 编译产物硬编码英文为中文（236 处/9 文件）；pi 升级后需重跑
    models.json        #     OpenRouter 路由模板：install.js 复制/深度合并到 ~/.pi/agent/models.json（见 README「OpenRouter 路由策略」节）
dist/               # 全部部署物（build.js 生成，gitignore 不入库）：install.js 只认这里；每次 install 自动重建，克隆后 cd src && npm install && node install.js 即用
  extensions/       #   扩展产物：每扩展一个零耦合单文件 .ts（hud.ts 由 hud/ 合并而来）
    btw.ts          #     内含 shared/model-select.ts 内联（btw 与 explore 共用模型选择器）
    hud.ts          #     hud/ 五个子模块合并为单文件（解决 hud 拆分问题）
    ...             #     其余扩展与源码同名
  themes/  sounds/  patches/  models.json  #   静态部署物（原样拷贝）
.pi/                # 空目录（占位）
```

## 架构要点

- **伪编译架构**：`src/`（源码：extensions/ 含 shared/ 共享模块与 hud/ 子目录，static/ 为静态素材）→ `src/build.js`（esbuild bundle 扩展 + 拷贝静态素材，与 npm 生态同层、require esbuild 自然命中）→ `dist/`（全部部署物，**gitignore 不入库**）。`install.js` **只认 dist/**，每次运行先自动 build（缺失即报错提示）。克隆后 `cd src && npm install && node install.js` 即用（dist 自动重建，无需入库）；改了 src/ 后 `node install.js` 一步构建+安装。构建用 `src/config/tsconfig.build.json`（无 paths）——主 tsconfig 的 paths 会把包名解析成 pi 全局绝对路径，导致 `packages: external` 包名匹配失效、意外内联 typebox。
- **安装模型**：`install.js` 把 dist/ 下 themes/extensions/sounds/models.json 复制到 `~/.pi/agent/` 对应位置；改扩展后必须重跑 build.js + install.js + pi 内 `/reload`。
- **扩展间联动**：展示层统一走**官方 `ctx.ui.setStatus(key, text)` 状态通道**（`task-alert` 推 `task-alert` 闪烁帧、`claude-it` 推 `init` 进度、`explore` 推 `explore` 进度、`web-search` 推 `web-search` 状态、`token-saver` 推 `token-saver` 节省量、hud 自身推 `balance-error`/`model-switch`/`hud-bash`）；`hud/hud-core.ts` 渲染行 1 动态区时按 `STATUS_STYLE` 样式表（hud/hud-core.ts）映射颜色与优先级（数字大者胜出），TTL/闪烁由各推送方自管。扩展间零耦合：setStatus 是 pi 原生接口，各插件推状态**不依赖 hud**（hud 缺席时状态自动回落原生 footer 第 3 行 `getExtensionStatuses()`，hud 兼容该通道仅做展示）。hud 仍置 `globalThis.__PI_HUD_ACTIVE__` 供未来真正依赖 hud 特有功能的扩展校验（当前无插件依赖）。
- **hud 余额适配**：`BALANCE_ADAPTERS` 注册表（hud/hud-balance.ts）按 providerId 逐一适配；DeepSeek 消耗按 `DEEPSEEK_PRICES`（hud/hud-cost.ts）官方人民币定价直算（恒 ¥，永不依赖汇率），峰谷开关 `DEEPSEEK_PEAK_PRICING`（hud/hud-cost.ts，当前 false）；其余供应商成本按原始货币 USD 记录、显示时换算。汇率三态（hud/hud-cost.ts）：实时（frankfurter→open.er-api 多源，1h 节流）→ 磁盘缓存（`~/.pi/agent/tmp/exchange-rate.json`）→ 无（断网且无缓存，显示原始货币 USD，不用固定近似值）。hud 子模块**可选加载**：任一缺失时对应功能降级（余额行显「模块缺失」/ 隐藏消耗统计 / git 恒「⎇ -」），不拖垮整个 HUD。
- **explore 子代理**：跑 pi-agent-core 官方 `agentLoop`，认证走 `ctx.modelRegistry.getApiKeyAndHeaders()`；子模型默认 `auto`（优先 `PREFERRED_MODELS`，explore-agent.ts:32，兜底选已认证最低价模型），`/explore-model` 可配 `auto`/`auto-not-free`/固定 provider/modelId，无参数弹可搜索选择器（与 /btw-config 同款 ModelSelectOverlay），设置持久化到 `~/.pi/agent/explore-model.json`。
- **claude-it /init**：fork 独立上下文后台跑 init 子代理（只读探索 + write/edit AGENTS.md），主会话零污染、期间可继续对话；进度经 `ctx.ui.setStatus("init", …)` 推送由 hud 行 1 动态区显示。同时只允许一个，超时/轮数/输出上限常量在文件顶部（claude-it.ts:61-65）。
- **claude-it 回退**：`/rewind` 命令（navigateTree 是命令 ctx 专属能力）回退到上一条用户消息、内容放回输入框；双击 Ctrl+C（打断后 2s 窗口内）预填 `/rewind` 命令，回车执行。Ctrl+C 打断不触发 task-alert 完成提醒——task-alert 监听 agent_end，最后一条 assistant 消息 `stopReason="aborted"` 即跳过 agent_settled 提醒（零耦合，不依赖 claude-it）。

## 代码风格与约定

- 缩进用 **Tab**；中文注释与文档；文件头有块注释说明用途与实现要点
- 扩展导出 `export default function (pi: ExtensionAPI)`，配置常量集中在文件顶部「可调配置」区
- 提交信息：中文 conventional commits（`feat:` / `fix:` / `refactor:` / `chore:`），早期有 `hud:` 前缀的裸格式；单行主题，必要时附正文要点

## 注意事项

- **改完扩展不重装不生效**：源码在 src/extensions/，运行时是 `~/.pi/agent/extensions/` 的副本（dist 产物），两处易不同步。改动流程：改 `src/extensions/` → `node build.js` → `node install.js` → pi 内 `/reload`。
- `src/config/tsconfig.template.json` → `install.js` 探测 pi 全局目录生成 `src/config/tsconfig.json`（`.gitignore` 忽略生成物，不入库）；生成物仅服务本地 tsc 检查（`paths` 映射 `@earendil-works/*` / `typebox`），运行时仍由 jiti 直接加载，不经 tsc。换机器/pi 升级路径变了重跑 `node install.js` 即可
- README 末尾「说明」一节提到的 `templates/` 目录已在 dab2af6 删除，该段说明已过时
- `install.js` 会修改全局 `~/.pi/agent/settings.json`（theme 字段），跑 `--dry-run` 先预览；copyDir 已支持子目录递归（多文件扩展 hud/）
- `docs/deepseek/` 是本地参考资料（不入库，版权归 DeepSeek），不要当作可执行配置；`src/sounds/` 只放提示音
- `claude-it.ts` 会拦截裸输入 `exit`（不带 `/`）直接退出 pi，属刻意设计
