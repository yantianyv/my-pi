# 跨扩展回归测试

## 运行方式

**无框架、无 runner、无 test script**：26 个 `*.test.mjs` 都是独立可执行脚本（`#!/usr/bin/env node`），自带断言与 exit code：

- 多数：自写 `check(name, cond, extra)` 累加 failures，末尾 `process.exit(failures === 0 ? 0 : 1)`
- `shared/test/shell-split.test.mjs`：唯一用 `node:assert/strict`（失败即抛）
- 单文件运行：仓库根目录 `node src/extensions/<...>/test/<name>.test.mjs`
- 全跑（无现成聚合 runner，可用 shell）：`for f in $(find src/extensions -name '*.test.mjs'); do echo "== $f"; node "$f" || exit 1; done`
- 测试文件头注释是最完整的文档：都写了「用法 + 原理 + 覆盖场景」

**加载 `.ts` 的唯一手段是测试内用 esbuild 现场 bundle**（node 不能 import `.ts`，也不能 import 无扩展名的相对路径如 `"../shared/config"`）：

```js
await build({ entryPoints: [入口 .ts], outfile: 测试目录/.tmp-xxx.mjs, bundle: true,
  format: "esm", platform: "node", target: "es2022",
  external: ["@earendil-works/*", "typebox"],
  tsconfig: src/config/tsconfig.build.json,   // 必须用无 paths 的构建 tsconfig，否则 external 白名单失效
  logLevel: "silent" });
const mod = await import(pathToFileURL(bundle).href);
```

产物 `.tmp-*` / `.dbg-*` 由 `.gitignore` 忽略、每次重生成。唯一例外：`qr/test/qr.test.mjs` 用 **jiti** 加载产物（产物内联的 qrcode 含动态 require，与 pi 运行时的加载方式一致）。

## 前置：src/extensions/node_modules

集成类测试（ask / qr / workflow-mgr / `src/extensions/test/` 等）需要能解析到 pi 全局包（`@earendil-works/*`、`typebox`）。依赖统一放在 **`src/extensions/node_modules/`**（gitignore，不入库），所有子目录测试沿祖先向上解析到同一份。

重建（换机器 / pi 升级后）：`node src/extensions/test/relink-deps.mjs`（仓库根执行）。脚本把全局 `pi-coding-agent/node_modules` 树扁平搬运过来（第三方 + `@earendil-works/*` + pi 本体），优先 symbolic link / junction，不支持链接的文件系统（如 D:）回退为递归复制（约 270MB）。**各 test 子目录里不要再放 node_modules**——空壳会挡在解析路径上。

- `hud/test/` 与 `shared/test/` 不需要（前者用 esbuild `alias` 把 pi / pi-ai 别名到内联的 `.tmp-pi-mock.mjs` 并需补齐用到的导出，后者零外部依赖）
- `webdav-kb/test/node_modules/` 另有真实 npm 依赖树（跑 `npm install` 即可）

缺依赖时集成类测试会 `ERR_MODULE_NOT_FOUND`。

## mock 方式

- `makePi()` 收集 `tools`/`commands`/`events`；`makeCtx(cwd, captures)` 捕获 `ui.setStatus`/`widget`/`notify`/`custom`；`themeMock` 纯文本透传（`fg/bg` 直返文本、`bold` 直返）以免干扰 `visibleWidth` 计算。原型在 `workflow-mgr/test/render.test.mjs`，ask/qr/perm-gate/pair-guard 复用。
- 扩展从不接触真实 `~/.pi/agent/`：`perm-gate.test.mjs` 只测模块级导出的 ReviewPanel 与纯函数（不触发默认导出，避免写真实 `perm-gate.json`）；webdav-kb 用 `KB_CONFIG_DIR`；presence 用 `PI_PRESENCE_DIR`、`PI_OS_IDLE_MS`；crash-log 用 `PI_CRASH_LOG_FILE`（ack 落同目录）；ask 用 `mkdtempSync` 临时问卷目录。

## 各测试覆盖

| 测试 | 覆盖 |
|---|---|
| `test/status-keys.test.mjs` | **跨扩展**：源码文本解析出所有 `setStatus` key，与 `hud/hud-core.ts` 的 `STATUS_STYLE` 双向校验（推送 key 必须登记、登记不得是死条目）。新增状态 key 后必须先改 STATUS_STYLE 再跑它 |
| `test/explore.test.mjs` | 落盘原语：任务哈希稳定、渐进落盘续跑、缓存复用、报告四状态渲染、上下文超限识别；场景 G 校验 `__PI_EXPLORE_API__` 契约（键名/版本/工具形状/alwaysFresh/4 参降级） |
| `test/perm-gate.test.mjs` | ReviewPanel（信息区/折行/键位/canRemember 收敛）+ `shared/shell-split` 拆段判定 |
| `test/presence.test.mjs` | `shared/presence` 与 status-beacon 接线：computeActive/computeAway 三态、在场文件写/删/死进程忽略、`claimSoundSlot` 去重、人不在才出声；会起 win32 空闲探测，测完 `disposeIdleProbe()` |
| `test/dingtalk-bridge.test.mjs` | 纯函数策略层（buildArgv / 标签拦截 / 两阶段确认 / 防重发 / parsePeople / schema 截断），不起真实 dws 进程 |
| `test/mimo-omni.test.mjs` | 媒体内容块构造离线 18 项；`MIMO_LIVE=1` + 传音频/视频路径才真打 API |
| `test/context-init.test.mjs` | /init 闭环的纯逻辑（不依赖 pi 包）：`estimateTokens` 口径、`pruneOldToolResults`（超预算才剪/按重读代价排序/write-edit 与近期不剪）、`checkContextArtifacts`（各上下文文件死指针、索引与 references 对应、frontmatter、空文件、无 skill 不误报）、`CONTEXT_OVERFLOW_RE` 命中与不误判 |
| `test/crash-log.test.mjs` | 用 `PI_CRASH_LOG_FILE` 注入临时日志 + 打两份 bundle（同进程两实例 = 模拟 /reload）：启动头/process 监听器只挂一次；同一条崩溃只提醒一次（新建崩溃再提醒）、无 UI 不提醒也不写 ack、`/crash-log` 视图即标已看、`clear` 清日志与 ack |
| `ask/test/ask.test.mjs` | A~U 场景 + 渲染不变量（U：连按两次 Enter 跳过必答直接提交 + 防误触 + 人称词提醒） |
| `qr/test/qr.test.mjs` | A~L 共 12 场景（编码/半块渲染/PNG 往返/JPEG 往返/钳制/错误路径/`/qr` 命令） |
| `hud/test/*` | 见 `hud-and-shared.md` |
| `model-config/test/panel.test.mjs` | 面板主页/动作层/策略层渲染与键位：AUTO·FREE 标固定语义且 Enter 只给提示、用途行 Enter 出动作层、section 行不被选中、↑ 越界不越位、Esc 逐层退出、非交互 `renderTextSummary` 列出策略槽与全部用途 |
| `shared/test/model-setting.test.mjs` | 两层模型设置的解析链：本地固定优先于中心、中心缺记录用注册默认策略、未映射槽回落会话模型、FREE 只在免费池取且带链、不可用回落 AUTO、本地键读改写保留同文件其它键、旧值 auto-not-free 归一化、用途声明去重（沙箱 HOME，不碰真实 `~/.pi/agent`） |
| `shared/test/shell-split.test.mjs` | 20 场景（顶层分隔符 / 引号转义 / 子 shell / 权限门关键样本 / heredoc） |
| `workflow-mgr/test/render.test.mjs` | 渲染 16 场景 A~R（R=多槽绑定），含 `__PI_HUD_API__` 注册/通知/注销 |
| `workflow-mgr/test/stale-ctx.test.mjs` | session 替换后 getStore 不崩（固化 cwd）+ cwd 变化重建 |
| `webdav-kb/test/*.test.mjs`（9 个） | client / sync / tools / commands / search / crypto / lfs / panel / panel-config，全部离线：`mock-dav.mjs` 是进程内 HTTP mock（PROPFIND/GET/PUT/MKCOL/DELETE/MOVE + Basic 认证，Nextcloud/Apache 双命名空间），不联网 |

## 联调脚本（不自动跑、需真实环境）

- `webdav-kb/test/live-*.mjs`：真实 123 云盘联调（e2e / lfs / probe / proto-update / status / curl-probe）。**硬编码本机绝对路径**，跨机器必失败。
- `test/dingtalk-bridge-live.mjs`：真实 dws 进程 + 钉钉网络；发送只到「草稿待确认」，绝不 confirm。
- `test/mimo-omni.test.mjs` 加 `MIMO_LIVE=1`。
