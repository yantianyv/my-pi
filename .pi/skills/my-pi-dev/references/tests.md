# 跨扩展回归测试

## 运行方式

**无框架、无 runner、无 test script**：69 个 `*.test.mjs` 都是独立可执行脚本（`#!/usr/bin/env node`），自带断言与 exit code：

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

重建（换机器 / pi 升级后）：`node src/extensions/test/relink-deps.mjs`（仓库根执行）。脚本把 pi 安装的 node_modules 树扁平搬运过来（第三方 + `@earendil-works/*` + pi 本体；托管安装依赖提升在 releases 层、npm 全局可能嵌套在 pi 包内，两处都扫、同名先到先得），优先 symbolic link / junction，不支持链接的文件系统（如 D:）回退为递归复制（约 270MB）。**各 test 子目录里不要再放 node_modules**——空壳会挡在解析路径上。

每个条目写入前先删后写，否则换布局时（npm 全局嵌套 → 托管安装提升）旧包自带的嵌套 `node_modules` 会残留下来，与新树合并出跨版本混合树（表现为 `pi-coding-agent/dist/core/model-config.js` 去解析它自己那份旧 `pi-ai` 的 `providers/compat-schema.js` 报 ERRMODULE_NOT_FOUND）。删除用手写递归（`unlinkSync`/`rmdirSync`）而非 `fs.rmSync`：本机实测 `rmSync` 在含中文的路径下报成功却不删，删不掉直接报错退出。

- `hud/test/` 与 `shared/test/` 不需要（前者用 esbuild `alias` 把 pi / pi-ai 别名到内联的 `.tmp-pi-mock.mjs` 并需补齐用到的导出，后者零外部依赖）
- `webdav-kb/test/node_modules/` 另有真实 npm 依赖树（跑 `npm install` 即可）

缺依赖时集成类测试会 `ERR_MODULE_NOT_FOUND`。

## mock 方式

- `makePi()` 收集 `tools`/`commands`/`events`；`makeCtx(cwd, captures)` 捕获 `ui.setStatus`/`widget`/`notify`/`custom`；`themeMock` 纯文本透传（`fg/bg` 直返文本、`bold` 直返）以免干扰 `visibleWidth` 计算。原型在 `workflow-mgr/test/render.test.mjs`，ask/qr/secure/pair-guard 复用。
- 扩展从不接触真实 `~/.pi/agent/`：`secure.test.mjs` 只测模块级导出的 ReviewPanel 与纯函数（含配置面板的正则校验/命中测试）（不触发默认导出，避免写真实 `secure.json`）；webdav-kb 用 `KB_CONFIG_DIR`；presence 用 `PI_PRESENCE_DIR`、`PI_OS_IDLE_MS`；crash-log 用 `PI_CRASH_LOG_FILE`（ack 落同目录）；ask 用 `mkdtempSync` 临时问卷目录。

## 各测试覆盖

| 测试 | 覆盖 |
|---|---|
| `test/status-keys.test.mjs` | **跨扩展**：源码文本解析出所有 `setStatus` key，与 `hud/hud-core.ts` 的 `STATUS_STYLE` 双向校验（推送 key 必须登记、登记不得是死条目）。新增状态 key 后必须先改 STATUS_STYLE 再跑它 |
| `test/explore.test.mjs` | 落盘原语：任务哈希稳定、渐进落盘续跑、缓存复用、报告四状态渲染、上下文超限识别；场景 G 校验 `__PI_EXPLORE_API__` 契约（键名/版本/工具形状/alwaysFresh/4 参降级） |
| `test/secure.test.mjs` | ReviewPanel（信息区/折行/键位/canRemember 收敛）+ `shared/shell-split` 拆段判定 + `/secure-config` 名单编辑的正则校验与命中测试（`compilePatternError`/`patternHits`） |
| `test/presence.test.mjs` | `shared/presence` 与 status-beacon 接线：computeActive/computeAway 三态、在场文件写/删/死进程忽略、`claimSoundSlot` 去重、人不在才出声；会起 win32 空闲探测，测完 `disposeIdleProbe()` |
| `test/dingtalk-bridge.test.mjs` | 纯函数策略层（buildArgv / 标签拦截与豁免 / 两阶段草稿与 peekDraft 取草稿 / 防重发 / 文件内容指纹 / 时间戳命名 / parsePeople / schema 截断 / 命令路径归一与上游可用性 / 群发变量表：resolveRunVars 以草稿为准、三种键写法对齐、渲染样例），不起真实 dws 进程 |
| `test/dingtalk-intents.test.mjs` | 语义层纯映射（intents.ts：时间/优先级/单元格规范化 + 消息/待办/日程/审批/文件/文档六域的业务参数 → dws argv），不联网不起进程 |
| `test/mimo-omni.test.mjs` | 媒体内容块构造离线 22 项（含凭证通道优先级与端点跟随）；传音频/视频路径再加本地文件与错误拦截 5 项；`MIMO_LIVE=1` 才真打 API |
| `test/context-init.test.mjs` | /init 闭环的纯逻辑（不依赖 pi 包）：`estimateTokens` 口径、`pruneOldToolResults`（超预算才剪/按重读代价排序/write-edit 与近期不剪）、`checkContextArtifacts`（各上下文文件死指针、索引与 references 对应、frontmatter、空文件、无 skill 不误报）、`CONTEXT_OVERFLOW_RE` 命中与不误判、`ensurePiGitignore`（首次写入白名单模板、已有文件不动、非 git 仓库不写、根已整体忽略 `.pi/` 时不写） |
| `test/crash-log.test.mjs` | 用 `PI_CRASH_LOG_FILE` 注入临时日志 + 打两份 bundle（同进程两实例 = 模拟 /reload）：启动头/process 监听器只挂一次；同一条崩溃只提醒一次（新建崩溃再提醒）、无 UI 不提醒也不写 ack、`/crash-log` 视图即标已看、`clear` 清日志与 ack |
| `test/keep.test.mjs` | 停顿点自检闭环（假 pi/ctx 驱动 turn_end/context）：A 注入判定块+续跑、B/C 挂块停下、零工具与只读工具停点不自检、内建与 readOnlyHint=false 视为工作、解析失败/预算耗尽/排队消息/aborted 降级、判定块不进请求与旧追问过滤、开关持久化、idle 探在场与挂机（挂机轮只注入隐藏指令、状态行走 `keep-idle`、段末发单行收尾摘要：做满/无活可干/用户回来） |
| `test/time.test.mjs` | 纯函数策略层：stamp 形状（带年/本地时区/分钟粒度）、user 贴前缀与已带前缀防重贴、非 user 角色原样、now 输出组装 |
| `test/img-slim.test.mjs` | 图片泄洪策略层（esbuild bundle + 依赖桩）：未超水位不动、超 HIGH 一次丢到 ≤ LOW、最新 N 张永不丢、同条目多图一次替换且其它块原样、占位文本落到每张被丢图、空列表与少量图不崩 |
| `ask/test/ask.test.mjs` | A~X 场景 + 渲染不变量（U：连按两次 Enter 跳过必答直接提交 + 防误触 + 人称词提醒；V：条件题 showIf —— 隐藏题不渲染/不计分母/不阻塞提交、出现后正常作答、三类非法条件报错；W：滚动锚定 —— 导航后按 x 展开上下文开头仍在视野内、收起后起点可见；X：口径一致性 —— 多选 min 未达时进度/一览/提示三者一致且题号不重复、判断题条件显示「是/否」而非 true） |
| `qr/test/qr.test.mjs` | A~L 共 14 场景（编码/半块渲染/B2 兼容模式渲染/PNG 往返/JPEG 往返/钳制/错误路径/`/qr` 命令/K2 Tab 切渲染模式） |
| `hud/test/*` | 见 `hud-and-shared.md` |
| `model-config/test/panel.test.mjs` | 面板主页/动作层/策略层渲染与键位：AUTO·FREE 标固定语义且 Enter 只给提示、用途行 Enter 出动作层、section 行不被选中、↑ 越界不越位、Esc 逐层退出、非交互 `renderTextSummary` 列出策略槽与全部用途 |
| `shared/test/llm.test.mjs` | 单次 LLM 调用公共服务：多 text 块抽取与空值、aiComplete 永不抛（认证失败返回 ok:false，不网络直调）、候选链依次尝试与总时长受 timeoutMs 约束、opencode 会话头不依赖 pi 内部管道 |
| `shared/test/model-setting.test.mjs` | 两层模型设置的解析链：本地固定优先于中心、中心缺记录用注册默认策略、未映射槽回落会话模型、FREE 只在免费池取且带链、不可用回落 AUTO、本地键读改写保留同文件其它键、旧值 auto-not-free 归一化、用途声明去重（沙箱 HOME，不碰真实 `~/.pi/agent`） |
| `shared/test/model-util.test.mjs` | 价格口径与筛选：目录 0 价的高速档不判免费（`COST_OVERRIDES`）、有效价参与排序、真 0 价仍免费、动态定价与无价排最后、`excludeFree` 不吃高速档 |
| `shared/test/review-panel.test.mjs` | 写操作确认面板（钉钉 / secret 共用）：长单行正文按宽度折行且 PgDn 能看全尾部（不被行截断吞掉）、正文区高度固定（空/单行/不满一页同高，超一页只多一行滚动指示）、短正文不受折行影响 |
| `shared/test/ui-box.test.mjs` | `shared/ui` 边框与底色：`theme.fg()` 以 `\x1b[39m` 收尾，拼接后会让同串后续横线掉回默认色（「顶边白、其余有色」）；假主题用真实 SGR 序列，兼顾可见宽度断言与颜色归属 |
| `secret/test/*.test.mjs`（3 个） | core（纯逻辑 + 指纹表加解密往返与密钥丢失重建）、e2e（假 pi/ctx 驱动真实钩子链：多步浮层、真跑 shell 验证环境变量注入且 process.env 未污染、转录保持 ref、跨会话指纹、reload 保留库）、detect-bench（识别档位语料 + 编码形式 + 真实负样本不误判） |
| `shared/test/shell-split.test.mjs` | 28 项（顶层分隔符 / 引号转义 / 子 shell / 权限门关键样本 / heredoc） |
| `shared/test/codemode.test.mjs` | codemode 嵌套调用判定：`<父 id>/<n>` 为嵌套、单段 id 为直接调用、空/未传/首尾斜杠不误判 |
| `shared/test/markdown.test.mjs` | 回答渲染（btw / ask 说明题共用）：行内样式跨行不裂开（原始 `**` / 反引号不出现、折行后样式序列成对且文字不丢）、标题去 `#`、表格按列宽换行不截断丢字且每行不超宽（30/40/60/80 四档）、列表续行缩进、缩进前缀与首尾空行处理、按 theme 分桶的缓存不串色 |
| `shared/test/fs-safe.test.mjs` | `shared/fs-safe` 的 `removePath`：**探针建在含中文的临时目录**（本机 `fs.rmSync` 在此静默不删——改用 rmSync 实现本测试即失败）、中文路径下删文件与目录树、目标不存在返回 true、删链接不跟进目标 |
| `workflow-mgr/test/render.test.mjs` | 渲染 17 场景 A~R（R = 会话隔离），含 `__PI_HUD_API__` 注册/通知/注销 |
| `workflow-mgr/test/stale-ctx.test.mjs` | session 替换后 getStore 不崩（固化 cwd + 会话 ID）+ 会话/cwd 变化重建 |
| `skill-hub/test/panel.test.mjs` | 技能市场面板（桩 deps，零网络）：收藏存储（切换/幂等/删除/按 id 判断/最近在前）、渲染（空态、收藏与已装合并、★ 与 `[已装]` 标记、统计行、行宽不超面板宽）、键位（↑↓、f 收藏、`/` 与直接打字进输入态、回车检索、Esc 关闭）、确认态（安装/卸载都要二次 Enter，Esc 返回且不动数据）、失败态（检索失败与 describe 失败如实显示） |
| `skill-hub/test/skill-hub.test.mjs` | 离线 A~F：SKILL.md 头部解析（单行/引号/CRLF/无头部/未闭合）与规范校验（名字非法/缺 description/超长/声明名不一致）、信任判定（精选名单 / 审计全 Pass / Warn 与 Fail 都不算通过 / 带脚本强制人工 / 非文档文件 / 体积）、私有存储路径与账本（存储根与 skills 子目录、重复记账去重、手动技能不进可卸载清单）、原子写盘与路径穿越拦截、**卸载边界**（手动 skills 目录 / 存储根自身 / 前缀相近的兄弟目录 / 项目外路径都拒绝）、来源字符串解析（含 `/tree/<ref>/` 形态）、取回上限拦截 |
| `skill-hub/test/reload.test.mjs` | 装/卸后的重载调度（纯逻辑）：空闲立即派发重载子命令且不发 steer；轮中先 steer 收尾、`agent_settled` 后补发且不重复；多次 schedule 只 steer 一次、只派发一次；续跑标记写入与清理 |
| `web-tool/test/render.test.mjs` | web_fetch 渲染兜底：判定函数与「不触发渲染」场景离线可跑，渲染类场景需本机 Chromium（缺浏览器自动跳过） |
| `web-tool/test/provider.test.mjs` | `web_search` 的 provider/source 正交性：provider 清单与派生取值、`isPaidProvider` 判定、付费引导会话去重（第二次不提示 / 无 key 不提示 / reset 后可再提）、`formatSearchResults` 的 header（告警置顶）与 footer（引导）共存、差评系数（封禁/子域名继承/未达阈值/无关域名）、**源码级断言**防字段语义回归（source 只取 web/npm/github、付费路径不把 provider 当 source） |
| `webdav-kb/test/*.test.mjs`（9 个） | client / sync / tools / commands / search / crypto / lfs / panel / panel-config，全部离线：`mock-dav.mjs` 是进程内 HTTP mock（PROPFIND/GET/PUT/MKCOL/DELETE/MOVE + Basic 认证，Nextcloud/Apache 双命名空间），不联网 |

## 联调脚本（不自动跑、需真实环境）

- `webdav-kb/test/live-*.mjs`：真实 123 云盘联调（e2e / lfs / probe / proto-update / status / curl-probe）。**硬编码本机绝对路径**，跨机器必失败。
- `test/dingtalk-bridge-live.mjs`：真实 dws 进程 + 钉钉网络；发送只到「草稿待确认」，唯一会用 `dingtalk_confirm` 的是群发个性化草稿与日程取消——两者在无界面会话里必然 fail-closed，用来验证「过得了变量表校验、再到执行前被拒」，不发任何真实消息。含命令路径归一（技能文档旧写法 → cli_path、canonical 当 argv）、上游不可用与不存在路径的报错文案、错误 token 拒绝、同名候选列回、按需装载后各域冒烟。
- `test/mimo-omni.test.mjs` 加 `MIMO_LIVE=1`。
- `skill-hub/test/skill-hub-live.mjs`：真实网络（skills.sh 检索 + jsDelivr 定位/取回 + 官方审计端点解析）。刻意选「最新 tag ≠ main」的仓库（mattpocock/skills）验证版本定位；pdf 技能用于验证单文件取不回时的容错（`skipped` 非空但整装成功）。国内网络下 github.com/api.github.com 不可达属预期——脚本不依赖它们。
