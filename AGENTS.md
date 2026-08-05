# AGENTS.md

## 项目概述

pi（@earendil-works/pi-coding-agent）的个人定制配置仓库：主题、扩展、提示音集中管理，`install.js` 一键安装到全局配置目录 `~/.pi/agent/`。纯 JavaScript/TypeScript（扩展由 pi 经 jiti 直接加载，无需编译），无构建系统、无 package.json。

## 常用命令

| 命令 | 作用 | 出处 |
|---|---|---|
| `node install.js` | 安装 themes/extensions/sounds 到 `~/.pi/agent/`，并把 settings.json 的 theme 设为 matrix（install.js:71） | install.js |
| `node install.js --dry-run`（或 `-n`） | 试运行，只打印不修改 | install.js:30 |
| `npx typescript --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck extensions/<file>.ts` | 扩展语法检查（无 tsconfig；`TS2307`/`TS2591`/`TS7006` 报错是缺 node_modules 所致，可忽略） | 本仓库惯例 |

无测试、无 lint、无 CI。安装后在 pi 里 `/reload` 热加载扩展生效。

## 目录结构

```
install.js          # 安装脚本：复制 .ts/.json/.wav 到 ~/.pi/agent/ 对应子目录
README.md           # 项目说明（含 HUD 图例、各扩展用法、卸载方法）
extensions/         # pi 扩展（安装目标 ~/.pi/agent/extensions/）
  claude-it.ts      #   Claude Code 风格：/init 在后台独立上下文生成/更新 AGENTS.md（只产出 AGENTS.md，不生成 CLAUDE.md）、/exit 别名、Ctrl+C 取消 turn
  explore-agent.ts  #   explore 工具：只读子代理并行探索代码库（read/ls/grep/find）
  hud.ts            #   3 行 HUD：git 状态 / 模型+token 速率 / 余额+消耗速率
  task-alert.ts     #   任务完成提醒：提示音 + 标题动画 + 事件总线广播
  web-search.ts     #   联网搜索工具：web_search 自定义工具，agent 可调（kimi-coding 后端）
themes/matrix.json  # 黑客帝国荧光绿主题
sounds/task_complete.wav  # 任务完成提示音
patches/apply-pi-tui-scroll-freeze.mjs  # pi-tui 滚动冻结补丁：修复流式期间滚轮上翻被拽飞（见 README「pi-tui 滚动冻结补丁」节）；pi 升级后需重跑
docs/deepseek/      # DeepSeek 官方文档提取（api.md / pricing.md / thinking.md），适配参考
.pi/                # 空目录（占位）
```

## 架构要点

- **安装模型**：仓库即源码，`install.js` 按扩展名（`.ts`/`.json`/`.wav`）复制到 `~/.pi/agent/` 下的 `themes/`、`extensions/`、`sounds/`；改扩展后必须重跑 install.js + pi 内 `/reload`。
- **扩展间联动**：`task-alert.ts` 不直接操作 HUD，只在 `agent_settled` 时通过 `pi.events` 广播 `task-alert:done`（task-alert.ts:101）；`claude-it.ts` 同理广播 `claude-it:init-progress` 汇报 /init 进度；`hud.ts` 订阅两个事件（hud.ts:1120/1135）在行 1 动态区显示。扩展间零耦合，hud 缺席时各自退化为标题动画/无进度显示。
- **hud 余额适配**：`BALANCE_ADAPTERS` 注册表（hud.ts:572）按 providerId 逐一适配；DeepSeek 消耗按 `DEEPSEEK_PRICES`（hud.ts:179）人民币定价直算，峰谷开关 `DEEPSEEK_PEAK_PRICING`（hud.ts:186，当前 false）；其余供应商 USD × `EXCHANGE_RATE`。
- **explore 子代理**：跑 pi-agent-core 官方 `agentLoop`，认证走 `ctx.modelRegistry.getApiKeyAndHeaders()`；子模型优先 `PREFERRED_MODELS`（explore-agent.ts:32），兜底选已认证最低价模型。
- **claude-it /init**：fork 独立上下文后台跑 init 子代理（只读探索 + write/edit AGENTS.md），主会话零污染、期间可继续对话；进度经 `pi.events` 广播由 hud 行 1 动态区显示。同时只允许一个，超时/轮数/输出上限常量在文件顶部（claude-it.ts:33-39）。

## 代码风格与约定

- 缩进用 **Tab**；中文注释与文档；文件头有块注释说明用途与实现要点
- 扩展导出 `export default function (pi: ExtensionAPI)`，配置常量集中在文件顶部「可调配置」区
- 提交信息：中文 conventional commits（`feat:` / `fix:` / `refactor:` / `chore:`），早期有 `hud:` 前缀的裸格式；单行主题，必要时附正文要点

## 注意事项

- **改完扩展不重装不生效**：源码在仓库，运行时是 `~/.pi/agent/extensions/` 的副本，两处易不同步
- 扩展运行时拿不到 `node_modules` 里的类型包，本地 tsc 报的模块解析类错误（TS2307/TS2591/TS7006）不影响 jiti 实际加载
- README 末尾「说明」一节提到的 `templates/` 目录已在 dab2af6 删除，该段说明已过时
- `install.js` 会修改全局 `~/.pi/agent/settings.json`（theme 字段），跑 `--dry-run` 先预览
- `docs/deepseek/` 是参考资料，不要当作可执行配置；`sounds/` 只放提示音
- `claude-it.ts` 会拦截裸输入 `exit`（不带 `/`）直接退出 pi，属刻意设计
