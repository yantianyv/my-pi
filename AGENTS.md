# AGENTS.md

## 项目概述

pi（@earendil-works/pi-coding-agent）的个人定制配置仓库：主题、扩展、提示音集中管理，`install.js` 一键安装到全局配置目录 `~/.pi/agent/`。纯 JavaScript/TypeScript（扩展由 pi 经 jiti 直接加载，无需编译），无构建系统、无 package.json。

## 常用命令

| 命令 | 作用 | 出处 |
|---|---|---|
| `node install.js` | 安装 themes/extensions/sounds 到 `~/.pi/agent/`，并把 settings.json 的 theme 设为 matrix（install.js:71） | install.js |
| `node install.js --dry-run`（或 `-n`） | 试运行，只打印不修改 | install.js:30 |
| `npx typescript -p tsconfig.json` | 全扩展类型检查（`tsconfig.json` 由 `install.js` 从 `tsconfig.template.json` 生成：探测 `npm root -g` 并用 `paths` 把 pi 全局安装的 `@earendil-works/*` / `typebox` 映射进来；当前 0 报错，换机器/pi 升级后重跑 `node install.js` 即可） | 本仓库惯例 |

无测试、无 lint、无 CI。安装后在 pi 里 `/reload` 热加载扩展生效。

## 目录结构

```
install.js          # 安装脚本：复制 .ts/.json/.wav 到 ~/.pi/agent/ 对应子目录，并生成 tsconfig.json（探测 pi 全局目录）
.gitignore          # 忽略生成物 tsconfig.json / node_modules
README.md           # 项目说明（含 HUD 图例、各扩展用法、卸载方法）
extensions/         # pi 扩展（安装目标 ~/.pi/agent/extensions/）
  hud/              #   3 行 HUD（多文件扩展，pi 只加载 index.ts 作为入口）
    index.ts        #     入口薄壳：re-export hud-core（pi 加载约定）
    hud-core.ts     #     核心：渲染 + 生命周期 + 命令；加载时置 globalThis.__PI_HUD_ACTIVE__；子模块动态加载，缺失时降级显示
    hud-balance.ts  #     hud-balance：供应商余额适配器（BALANCE_ADAPTERS 注册表）
    hud-cost.ts     #     hud-cost：消耗统计 / DeepSeek 定价 / 按量付费文本 / 实时汇率
    hud-git.ts      #     hud-git：git 状态解析
  beautiful-thinking.ts  # 思考折叠标签动画（Thinking... 逐帧动画，独立 UI 反馈插件）
  claude-it.ts      #   Claude Code 风格：/init 在后台独立上下文生成/更新 AGENTS.md（只产出 AGENTS.md，不生成 CLAUDE.md）、/exit 别名、Ctrl+C 取消 turn
  explore-agent.ts  #   explore 工具：只读子代理并行探索代码库（read/ls/grep/find）
  token-saver.ts    #   上下文 token 节省器：自动清洗 bash 工具的冗余输出（git/npm/tsc/pip/docker/--help）
  task-alert.ts     #   任务完成提醒：提示音 + 标题动画 + setStatus 状态推送
  web-search.ts     #   联网搜索工具：web_search 自定义工具，agent 可调（kimi-coding 后端）
themes/matrix.json  # 黑客帝国荧光绿主题
sounds/task_complete.wav  # 任务完成提示音
patches/apply-pi-tui-scroll-freeze.mjs  # pi-tui 滚动冻结补丁：修复流式期间滚轮上翻被拽飞（见 README「pi-tui 滚动冻结补丁」节）；pi 升级后需重跑
patches/apply-pi-ai-usage-guard.mjs     # pi-ai usage 缺失防护补丁：模型偶发返回无 usage 的 assistant 消息导致后续调用瞬时失败（见 README「pi-ai usage 缺失防护补丁」节）；pi 升级后需重跑
models.json                          # OpenRouter 路由模板：install.js 复制/深度合并到 ~/.pi/agent/models.json（见 README「OpenRouter 路由策略」节）
docs/deepseek/      # DeepSeek 官方文档提取（api.md / pricing.md / thinking.md），适配参考
.pi/                # 空目录（占位）
```

## 架构要点

- **安装模型**：仓库即源码，`install.js` 按扩展名（`.ts`/`.json`/`.wav`）复制到 `~/.pi/agent/` 下的 `themes/`、`extensions/`、`sounds/`；改扩展后必须重跑 install.js + pi 内 `/reload`。
- **扩展间联动**：展示层统一走**官方 `ctx.ui.setStatus(key, text)` 状态通道**（`task-alert` 推 `task-alert` 闪烁帧、`claude-it` 推 `init` 进度、`explore` 推 `explore` 进度、`web-search` 推 `web-search` 状态、`token-saver` 推 `token-saver` 节省量、hud 自身推 `balance-error`/`model-switch`/`hud-bash`）；`hud/hud-core.ts` 渲染行 1 动态区时按 `STATUS_STYLE` 样式表（hud/hud-core.ts）映射颜色与优先级（数字大者胜出），TTL/闪烁由各推送方自管。扩展间零耦合：setStatus 是 pi 原生接口，各插件推状态**不依赖 hud**（hud 缺席时状态自动回落原生 footer 第 3 行 `getExtensionStatuses()`，hud 兼容该通道仅做展示）。hud 仍置 `globalThis.__PI_HUD_ACTIVE__` 供未来真正依赖 hud 特有功能的扩展校验（当前无插件依赖）。
- **hud 余额适配**：`BALANCE_ADAPTERS` 注册表（hud/hud-balance.ts）按 providerId 逐一适配；DeepSeek 消耗按 `DEEPSEEK_PRICES`（hud/hud-cost.ts）官方人民币定价直算（恒 ¥，永不依赖汇率），峰谷开关 `DEEPSEEK_PEAK_PRICING`（hud/hud-cost.ts，当前 false）；其余供应商成本按原始货币 USD 记录、显示时换算。汇率三态（hud/hud-cost.ts）：实时（frankfurter→open.er-api 多源，1h 节流）→ 磁盘缓存（`~/.pi/agent/tmp/exchange-rate.json`）→ 无（断网且无缓存，显示原始货币 USD，不用固定近似值）。hud 子模块**可选加载**：任一缺失时对应功能降级（余额行显「模块缺失」/ 隐藏消耗统计 / git 恒「⎇ -」），不拖垮整个 HUD。
- **explore 子代理**：跑 pi-agent-core 官方 `agentLoop`，认证走 `ctx.modelRegistry.getApiKeyAndHeaders()`；子模型优先 `PREFERRED_MODELS`（explore-agent.ts:32），兜底选已认证最低价模型。
- **claude-it /init**：fork 独立上下文后台跑 init 子代理（只读探索 + write/edit AGENTS.md），主会话零污染、期间可继续对话；进度经 `ctx.ui.setStatus("init", …)` 推送由 hud 行 1 动态区显示。同时只允许一个，超时/轮数/输出上限常量在文件顶部（claude-it.ts:33-39）。

## 代码风格与约定

- 缩进用 **Tab**；中文注释与文档；文件头有块注释说明用途与实现要点
- 扩展导出 `export default function (pi: ExtensionAPI)`，配置常量集中在文件顶部「可调配置」区
- 提交信息：中文 conventional commits（`feat:` / `fix:` / `refactor:` / `chore:`），早期有 `hud:` 前缀的裸格式；单行主题，必要时附正文要点

## 注意事项

- **改完扩展不重装不生效**：源码在仓库，运行时是 `~/.pi/agent/extensions/` 的副本，两处易不同步
- `tsconfig.template.json` → `install.js` 探测 pi 全局目录生成 `tsconfig.json`（`.gitignore` 忽略生成物，不入库）；生成物仅服务本地 tsc 检查（`paths` 映射 `@earendil-works/*` / `typebox`），运行时仍由 jiti 直接加载，不经 tsc。换机器/pi 升级路径变了重跑 `node install.js` 即可
- README 末尾「说明」一节提到的 `templates/` 目录已在 dab2af6 删除，该段说明已过时
- `install.js` 会修改全局 `~/.pi/agent/settings.json`（theme 字段），跑 `--dry-run` 先预览；copyDir 已支持子目录递归（多文件扩展 hud/）
- `docs/deepseek/` 是参考资料，不要当作可执行配置；`sounds/` 只放提示音
- `claude-it.ts` 会拦截裸输入 `exit`（不带 `/`）直接退出 pi，属刻意设计
