# 扩展细节 B：外部能力类

## web-tool（`web-tool/`，产物 `web-tool.ts`）

- 文件：`http.ts`（网络层/代理）、`search.ts`（多源搜索 + 评分）、`fetch.ts`（抓取转 md）、`dislike.ts`（差评）、`panel.ts`（配置面板）、`index.ts`。
- 工具 `web_search` / `web_dislike` / `web_fetch`；命令 `/web-tool-config`（代理设置 + 搜索结果黑名单查看/删除选中项）；状态 key `web-search`、`web-fetch`。
- `web_search`：bing + 360 + baidu 三源并行（另含 npm 垂类），结果逐条评分后合并去重取前 15（标题/URL/摘要权重 + 完整短语命中加成，评分 0 滤除）；零 key 零费用、无 AI 总结。第三源选型实测否决 DDG 202 反爬 / Jina 不可达 / Mojeek 403（见 `search.ts` 头注释）。
- `web_dislike`：AI 对低质量域名记差评，×0.6/次、5 次滤除，跨会话持久化 `~/.pi/agent/web-search-blacklist.json`。
- `web_fetch`：正文提取（turndown/domino/gfm 由 build.js 内联）+ 截断；GitHub blob URL 重写为 raw 直取（防源码被当标签吞）；正文极短（JS 空壳）时用 Googlebot UA 重试一次。
- 代理配置 `~/.pi/agent/web-fetch-proxy.json`；直连与降级（系统 curl 自动带代理 / 无 curl 退 Node CONNECT 隧道）**并行竞速**，谁先成功用谁，404 等确定性错误立即判死。HTTP 层复用 `shared/net`。
- 无测试文件。

## webdav-kb（`webdav-kb/`，产物 `webdav-kb.ts`）

- 文件：`client.ts`（WebDAV + 代理）、`tools.ts`、`commands.ts`、`panel.ts`/`panel-config.ts`、`store.ts`（配置 + 同步账本）、`sync.ts`、`search.ts`、`formats.ts`、`protocol.ts`、`secrets.ts`、`crypto.ts`（vault）、`lfs.ts`、`index.ts`。
- 工具 14 个 `kb_*`：`kb_help/search/read/write/append/list/upload/download/lslfs/import/delete/move/status/sync`；命令 `/kb` `/kb-config` `/kb-sync`；状态 key `kb-sync`、`kb-vault`、`kb-op`（kb 工具回执合成一个键，状态行只推短摘要）。
- 配置 `~/.pi/agent/kb-config.json`（`KB_CONFIG_DIR` 可覆盖，测试隔离用）：`baseUrl`/`username`/`password`/`proxyUrl`/`mirrorDir`（默认 `~/.pi/agent/kb/`）/`vault`{salt,check}/`persistVault`/`vaultKey`/`readOnly`/`allowSecretUpload`。同步账本 `.kb-sync.json` 存镜像根（远端 etag/lastModified/size + 本地 mtime 快照 = 增量依据）。
- 同步：etag/mtime 比对，冲突以远端为准 + 本地 `.conflict-<时间戳>` 副本；`.kb-sync.lock` 互斥锁（持锁方 10s 心跳续期 + 进度上报，后到者排队等待，pid 判活/心跳 45s 超时回收残锁）；`.kb-sync-journal.json` 中断恢复（phase: plan/conflict/upload/delete，成功即删）；上传前 secret 扫描拦截（`secrets.ts` 高精度模式，`allowSecretUpload` 兜底）；`delRemote` 404 幂等；同步后清理本地空目录（`.kb-*` 与镜像根保留）。
- 区域：vault 加密区、LFS 大文件区、`/.history` 历史副本区（改动/删除自动留档：结构镜像根、文件名加 `_yymmddhhmmss` 后缀、同秒重名叠 `_hash`、同内容跳过、自身不递归、不参与列表与检索；恢复走 WebDAV 客户端）。
- 检索：纯文本多格式全文索引（md/txt/csv/tsv/json/jsonl/yaml/yml/toml/html/xml，csv/tsv 表头加权，frontmatter 仅 md 强制）；跳过 `.kb-*` 与 `.conflict-*`。
- 分类层级守则 `/命名空间/用途/自由层级`（用途 = 文档功能六值硬约束，自由层级 AI 管理软约束，见 `protocol.ts` 的 `DEFAULT_PROTOCOL`）；守则对 `kb_list`/`kb_status` 不透明（走 `kb_help` 专用通道，`kb_search` 保留索引兜底）；源码为默认版，远端用户可手动迭代。
- 只读模式 `readOnly`（`/kb-config` 面板切换、默认关、**下次会话生效**）：`session_start` 一次性隐藏 6 个写工具（write/append/upload/import/delete/move，`kb_sync` 保留）；syncAll 自适应为仅下载（本地删除 → 重新下载，本地新建/修改留本地）；ensureProtocol 跳过。
- 同步结果统一呈现：`sync.ts` 的 `formatSyncSummary`（计数全人话、0 值省略）与 `formatSyncNotes`（冲突副本路径与处理办法、不可达目录、失败明细），命令/工具/配置面板/后台同步四处共用；`client.ts` 的 `describeSyncError` 把 401/403/404/网络类异常翻成可操作提示。

## workflow-mgr（`workflow-mgr/`，产物 `workflow-mgr.ts`）

- 文件职责：`index.ts`（组装薄壳）、`tools.ts`（7 个工具）、`commands.ts`（`/wf` 主命令 + `/wf-config` 只留无参 + `/wf resume`）、`events.ts`（session 钩子 / hud 联动 / 条件注入）、`store.ts`（数据层）、`types.ts`（类型 + schema 常量）、`panel.ts`（展示层）、`brief.ts`（AI 简报 `renderBrief`/`summaryLine`/`lightState`）、`audit.ts`（完成信号独立审计）、`slot-picker.ts`（槽位选择浮窗）。
- 工具：`wf_workflow`（`import` 一次性导入工作流草稿 json、`bind` 会话绑定、`add`/`archive` 等）/ `wf_status` / `wf_switch`（完成 + 推进一步到位，`complete=false` 搁置；推进后附 status 记录复核提醒）/ `wf_block` / `wf_rollback` / `wf_note`（`kind=fact/status` 时效分类 + `key` 主题键顶替防决策打架）/ `wf_milestone`。未绑定/暂不启用/明确不用时其余 6 个工具被 `guardBound` 拒绝。
- 数据：多工作流槽位——default 槽 = `.pi/workflow/` 根三 JSON（`workflow.json`/`state.json`/`config.json`，可 git 审查）、命名槽 = `.pi/workflow/slots/<名称>/`、archive 随槽分目录（`wf_workflow archive` 移入，无找回功能）；会话绑定表 `.pi/workflow/bindings.json`（sessionId → 槽 / `auto` = 暂不启用 / `null` = 明确不用 / 无记录 = 未选择；7 天保鲜 `BINDING_TTL_MS`）。`WorkflowStore` 构造时固化 cwd（不持 ctx），session 替换不触发 stale。状态 key `workflow-mgr`。
- 并发隔离动机：多 pi 会话同项目跑不同任务时共享单工作流会互相干扰（wf_switch 乱推进、内存缓存写盘互相覆盖）。
- `session_start` 绑定判定：单槽/无槽自动绑定（零行为变化）；多槽或侦测到其他活跃会话已绑定（借 pair-guard 注册表心跳零耦合判活，缺席按 24h 内绑定视为活跃）→ TUI 弹自绘选择浮窗（`slot-picker.ts`：「通用」组 =「暂不启用」默认高亮 / Esc 同此 /「从 resume 中加载」，与「工作流（N）」槽位列表分区 + ▶ 高亮 + 数字键直选）；选 resume 放弃本会话、转 `/wf resume`（官方 `SessionSelectorComponent` → `switchSession`；恢复后按被恢复会话自己的绑定加载其工作流空间，不写本会话绑定）；非 TUI 退化为注入选择指引让 AI 用 ask 问，最终 `wf_workflow action=bind` 落地。`session_start` 开头强制重读绑定缓存（resume/new/fork 换会话即恢复对应工作流空间）。
- 展示：常驻 widget（belowEditor）+ `/wf-config` 浮窗 + 非 TUI 文本回落（`compactLines` 单一渲染源）；hud 在场且开启时改由 `__PI_HUD_API__` 渲染在 footer 最底部（见 `hud-and-shared.md`）。
- 审计：`config.json` 开 `auditOnComplete` 后，`wf_switch` 完成推进前派全新上下文的只读 + bash 子代理核验 `doneSignal`，不通过则打回（`kind=evidence` 证据不足 / `format` 审计输出无法解析，失败提示附任务交付物 + 完成信号）；审计自身故障放行（增强不是门禁）；审计模型按用途 `audit` 解析（默认策略 AUTO = 当前会话模型，可在 `/model-config` 改指）。
- 测试：`test/render.test.mjs`（16 场景 A~R，含 `__PI_HUD_API__` 注册/通知/注销）、`test/stale-ctx.test.mjs`。

## dingtalk-bridge/（钉钉 dws CLI 受控桥接 + 业务语义层）

- 目录：`index.ts`（注册工具 + 受控管线 + 解析层）、`intents.ts`（语义层纯映射：业务参数 → dws argv，离线可测）。
- **模型侧只有 7 个工具**：语义层 6 个（`dingtalk_msg` / `dingtalk_todo` / `dingtalk_calendar` / `dingtalk_approval` / `dingtalk_file` / `dingtalk_doc`）+ 唯一逃生舱 `dws_skill`（只给官方技能正文当知识，**没有任何命令执行通道**）；命令 `/dws`（状态 + forget/refresh）。
- 语义层设计：`intents.ts` 一动作一行纯映射；`index.ts` 负责解析（姓名→userId、DING 另补 openDingTalkId、群名→openConversationId、消息关键词+会话→msgId、文档标题→nodeId、多维表名→baseId/tableId、钉盘名→nodeId、完整手机号→账号、本人 userId）后调 `runGuarded`——**与内部执行管线共用同一条门禁链**（换行归一→分档→参数自检→两阶段→人工面板→台账→结果注解），语义层绕不开任何一道拦截。
- **同名/同名群不弹人工确认**：把候选（含部门/职务/工号与账号 ID）作为结果回给 AI，由 AI 自己挑定后把该项换成候选 ID 重调（提示词第 3 条明确要求）；查无此人时改用手机号即可（插件走 `contact user search-mobile`）。
- **AI 角标由插件带**：发送类映射统一加 `--ai-tag`（dws 原生角标），模型不必在正文写【AI发送】；正文里的字面反斜杠-n 仍自动归一为真换行。
- 覆盖范围即上表六个域的主用动作；长尾（听记/考勤/邮箱/组织/表格结构/多维表视图等）**AI 做不了**，只能读 `dws_skill` 判断可行性后回报用户——需要时按动作表补进行。
- 安全门禁（`decideExec` + `runGuarded`）：读直通 / 写两阶段（草稿 + confirm）/ 敏感档人工面板（`shared/review-panel.ts`，面板只写人话、无 argv/ID，无界面会话直接拒绝）；面板「当前工作区不再询问」写 `remembered`（cli_path，destructive 不可记）。分档由 dws schema 元数据的 `effect`/`availability` 决定（缓存 `~/.pi/agent/dingtalk-bridge-schema.json` + 手写表兜底）：上游标 `availability≠available` 的命令直接报不可用与原因，不掩成内容错；命令路径（canonical/点分/本地旧写法）统一归一到可执行 cli_path。
- 群发逐人个性化：`dingtalk_msg` 的 `vars` 参数（`{收件人: 值}` 或 `{收件人: {变量: 值}}`）映射到管线的私有 `--vars`，正文含 `{{变量}}` 时由管线逐人渲染发送；缺变量表在草稿前拦下。
- 查消息连附件一起落盘：`dingtalk_msg action="read"` 默认附 `--download-resources --output-dir <outDir>`（缺省 `.tmp/dingtalk-media`），dws 把命中消息的 mediaId/fileId 全下到该目录（非 NTFS 卷自动重定向），结果里回显目录与 localPath（模型可直接 read）；`downloadResources=false` 只查文字，`outDir` 改目录（必须是工作目录内相对路径，插件先拦盘符/前导斜杠/`..`）。
- 会话参数可写人名：`inGroup` / `destGroup`（转发目标）先当群找，找不到就按人找单聊（`aisearch person` 取 openDingTalkId → `+conversation-info --open-dingtalk-id` 取单聊会话 ID），重名走候选流程；已是 `cid` 的不再猜人。
- 模型侧不出现 dws 命令路径：错误与提示一律指向插件动作（如“用 action=\"send\" to=[…] 重发”），不写「逃生舱 chat +xxx」——模型会照做去 bash 里敲原生命令，绕开全部门禁与 exFAT 兜底。
- 群发 `chat +broadcast`：草稿前先跑只读 dry-run 预检收件人，有人未唯一解析就整体拦下（不半批次发送）；正文含 `{{变量}}` 时改走逐人单聊（`sendPersonalized`，每人一份变量表 + 确定性幂等键，重跑自动跳过）。
- 分享链接落地走 `dingtalk_file action="fetch"`（link 或 spaceId+nodeId；文件直下、文件夹递归镜像，非 NTFS 卷自动改到系统临时区下载再搬回）。
- **非 NTFS 卷（exFAT/网络盘）落盘自动重定向**：dws 用「`.part` 临时文件 → `link` 硬链接到正式名」做原子发布，硬链接只在 NTFS 可用 → exFAT 上必然 `link …: Incorrect function`。触发不看退出码（`--download-resources` 类把失败写进结果 JSON、exit 仍是 0），也不靠手写命令清单：`isLinkPublishFailure(输出)` + `shouldRetryRedirect`（已知下载类直通；否则要求 argv 带输出类 flag 且 schema 参数表含 `output`/`output-dir`/`local-folder`/`transcript-output`、且 `effect=read`——写命令不自动重放）。重试只把 cwd 换到 `os.tmpdir()`，相对输出路径原样保留（不猜文件还是目录），搬回时按产出物本身决定落文件还是落目录（默认不覆盖）、`.part` 残留不搬、`localPath`/`savedPath` 改写为用户视角；搬回失败（盘满/只读/FAT32 单文件 4GB 上限）则放弃重试、保留原始输出，不假装已搬回。落盘类超时下限 5 分钟（`DOWNLOAD_TIMEOUT_MS`）。
- 配置 `~/.pi/agent/dingtalk-bridge.json`；防重发台账 `~/.pi/agent/dingtalk-bridge-sent.json`（`dedupMinutes` 默认 60）；官方 `dingtalk-*` 技能不再常驻系统提示词（`before_agent_start` 过滤，`dws_skill` 按需取回）。
- 回归测试：`node src/extensions/test/dingtalk-bridge.test.mjs`（策略层 A~AH）、`node src/extensions/test/dingtalk-intents.test.mjs`（语义层映射 A~G）；真实联调 `dingtalk-bridge-live.mjs`。

## mimo-omni.ts（媒体兼容层，过渡件）

- 工具 `mimo_transcribe`（音频/视频 → 逐字稿，或按 prompt 解析要点/行动项/时间轴）、`mimo_speak`（文字 → wav，默认播放）；命令 `/mimo-config`（模型与音色面板）；配置 `~/.pi/agent/mimo-omni.json`；状态 key `mimo-omni`。
- 存在理由：`.pi` 消息类型只有 text/image，全模态模型的原生音频/视频输入还进不了上下文，用两个工具把能力补上；**等 pi 支持音频内容类型后这一层即可整体撤掉**。
- 格式：音频 wav/mp3/m4a/flac/ogg/aac/opus，视频 mp4/mov/avi/wmv（fps 0.1~10、media_resolution `default`/`max`）；本地文件走 base64（>45MB 提前拦截，官方上限 50MB）、公网 URL 直传。
- 解析链带模型降级 + 空正文重试（便宜档 flash 实测约半数只回思考不回正文，会自动降级到 pro/v2.5）；播放走系统自带播放器（Win PowerShell SoundPlayer / afplay / paplay），零依赖。

## time.ts

- 工具 `now()`（无参）；无命令、无状态 key。
- 机制：`context` 事件给 user 消息贴 `[YYYY-MM-DD HH:mm]` 前缀（带年，本地时区）——只改发往模型的副本，会话记录/UI 不动；详见 extensions-core.md 的 time 段（含缓存影响与边界）。

## qr.ts

- 工具 `qr_encode` / `qr_decode`；命令 `/qr`；状态 key `qr`。
- 编码：图形终端渲染 PNG 真图（kitty/iTerm2 走 Image 组件），普通终端用半块字符 ANSI 绘制（可扫）；`save=false` 不落盘，默认落盘 `os.tmpdir()/pi-qr-<时间戳>.png`；默认 512px（128~2048 钳制）、纠错级别 M；文本超容量时失败提示带纠错建议。
- 解码：本地路径或 URL，PNG/JPEG 纯 JS（pngjs/jpeg-js/jsqr 由 build.js 内联）；支持 PNG 转 JPEG 后解码；非图片/无二维码给明确报错。
- 会话回放安全：工具 details 只存原文，渲染时同步重新编码；`session_shutdown` 清 shared/status 的 TTL timer。
- **`qr/` 目录只是测试目录**（无 `index.ts`，build.js 不会把它当扩展入口），源码是顶层 `qr.ts`；测试 `qr/test/qr.test.mjs` 用 esbuild bundle + jiti 加载产物，12 场景 A~L。
