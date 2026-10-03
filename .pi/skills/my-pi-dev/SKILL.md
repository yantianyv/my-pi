---
name: my-pi-dev
description: my_pi 仓库（pi 个人定制配置：扩展/安装器/静态资源/补丁）的子系统细节手册。要改 src/extensions/ 下某个扩展、动 install.js 安装逻辑或 build.js、写/跑回归测试、改 static/ 补丁与 models.json/sounds/skills，或要查某扩展的工具名、命令、配置文件、setStatus key、跨扩展契约时读本 skill；日常读 AGENTS.md 即可，本 skill 按需加载。
---

# my_pi 子系统细节

AGENTS.md 只保留每轮都用得上的信息（命令、目录职责、不变量、坑）。这里放成段的子系统细节——**改对应模块前先读对应文件**（不读会漏掉该模块的既有约定与硬约束）。

| 要动的东西 | 读 |
|---|---|
| hud 三行渲染、STATUS_STYLE 状态样式表、余额/定价/汇率、速率曲线 | `references/hud-and-shared.md` |
| 会话/状态/权限/子代理类扩展：claude-it、explore-agent、btw、ask、perm-gate、pair-guard、status-beacon、clipboard、crash-log、img-slim | `references/extensions-core.md` |
| 外部能力类扩展：web-tool、webdav-kb、workflow-mgr、dingtalk-bridge、mimo-omni、qr | `references/extensions-tools.md` |
| install.js 安装行为与它会改的全局文件、src/build.js、static/（主题/音效/skill/models.json/三个补丁） | `references/install-and-static.md` |
| 回归测试怎么跑、各测试覆盖什么、live 联调脚本 | `references/tests.md` |

跨模块不变量（改任何扩展都要守）：

- 扩展导出 `export default function (pi: ExtensionAPI)`，配置常量集中在文件顶部「可调配置」区；缩进 Tab，注释中文。
- 扩展之间**零耦合**，通信只走三条公开通道：官方 `ctx.ui.setStatus(key, text)`；`globalThis` 契约（`__PI_HUD_API__` / `__PI_EXPLORE_API__` / `__PI_STATUS_BEACON_API__`）；项目内文件（`.pi/` 下的工作流/问卷/注册表）。不允许直接 import 对方产物（产物是零耦合单文件）。
- 新推一个 setStatus key 必须同时登记进 `src/extensions/hud/hud-core.ts` 的 `STATUS_STYLE`（否则 priority 0 永远被盖），`src/extensions/test/status-keys.test.mjs` 会双向校验。
- 注入给模型的文本（工具 description / promptSnippet / promptGuidelines / 系统提示词 / 注入消息）只写模型需要且别处没有的信息：不解释实现、不复述参数名已表达的内容、不写变更史；同一事实只写一处。
- 配置读写一律走 `shared/config.ts`（原子写 + 损坏隔离），不要自己 `writeFileSync` JSON。
