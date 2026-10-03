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

- 文件职责：`index.ts`（组装薄壳）、`tools.ts`（7 个工具）、`commands.ts`（`/workflow-config` 只留无参 + `/wf-resume`）、`events.ts`（session 钩子 / hud 联动 / 条件注入）、`store.ts`（数据层）、`types.ts`（类型 + schema 常量）、`panel.ts`（展示层）、`brief.ts`（AI 简报 `renderBrief`/`summaryLine`/`lightState`）、`audit.ts`（完成信号独立审计）、`slot-picker.ts`（槽位选择浮窗）。
- 工具：`wf_workflow`（`import` 一次性导入工作流草稿 json、`bind` 会话绑定、`add`/`archive` 等）/ `wf_status` / `wf_switch`（完成 + 推进一步到位，`complete=false` 搁置；推进后附 status 记录复核提醒）/ `wf_block` / `wf_rollback` / `wf_note`（`kind=fact/status` 时效分类 + `key` 主题键顶替防决策打架）/ `wf_milestone`。未绑定/暂不启用/明确不用时其余 6 个工具被 `guardBound` 拒绝。
- 数据：多工作流槽位——default 槽 = `.pi/workflow/` 根三 JSON（`workflow.json`/`state.json`/`config.json`，可 git 审查）、命名槽 = `.pi/workflow/slots/<名称>/`、archive 随槽分目录（`wf_workflow archive` 移入，无找回功能）；会话绑定表 `.pi/workflow/bindings.json`（sessionId → 槽 / `auto` = 暂不启用 / `null` = 明确不用 / 无记录 = 未选择；7 天保鲜 `BINDING_TTL_MS`）。`WorkflowStore` 构造时固化 cwd（不持 ctx），session 替换不触发 stale。状态 key `workflow-mgr`。
- 并发隔离动机：多 pi 会话同项目跑不同任务时共享单工作流会互相干扰（wf_switch 乱推进、内存缓存写盘互相覆盖）。
- `session_start` 绑定判定：单槽/无槽自动绑定（零行为变化）；多槽或侦测到其他活跃会话已绑定（借 pair-guard 注册表心跳零耦合判活，缺席按 24h 内绑定视为活跃）→ TUI 弹自绘选择浮窗（`slot-picker.ts`：「通用」组 =「暂不启用」默认高亮 / Esc 同此 /「从 resume 中加载」，与「工作流（N）」槽位列表分区 + ▶ 高亮 + 数字键直选）；选 resume 放弃本会话、转 `/wf-resume`（官方 `SessionSelectorComponent` → `switchSession`；恢复后按被恢复会话自己的绑定加载其工作流空间，不写本会话绑定）；非 TUI 退化为注入选择指引让 AI 用 ask 问，最终 `wf_workflow action=bind` 落地。`session_start` 开头强制重读绑定缓存（resume/new/fork 换会话即恢复对应工作流空间）。
- 展示：常驻 widget（belowEditor）+ `/workflow-config` 浮窗 + 非 TUI 文本回落（`compactLines` 单一渲染源）；hud 在场且开启时改由 `__PI_HUD_API__` 渲染在 footer 最底部（见 `hud-and-shared.md`）。
- 审计：`config.json` 开 `auditOnComplete` 后，`wf_switch` 完成推进前派全新上下文的只读 + bash 子代理核验 `doneSignal`，不通过则打回（`kind=evidence` 证据不足 / `format` 审计输出无法解析，失败提示附任务交付物 + 完成信号）；审计自身故障放行（增强不是门禁）。
- 测试：`test/render.test.mjs`（16 场景 A~R，含 `__PI_HUD_API__` 注册/通知/注销）、`test/stale-ctx.test.mjs`。

## dingtalk-bridge.ts（钉钉 dws CLI 受控桥接）

- 工具 6 个：`dws_schema`（`dws schema --compact` 活内省分层下钻）、`dws_exec`（argv 数组直调不过 shell）、`dws_fetch`（钉盘/云盘分享落地：文件直下、文件夹镜像到本地）、`dws_resolve_user`（aisearch 人员解析，多候选 pick 确认）、`dws_resolve_group`（chat +chat-search 群解析，同名群强制用 cid）、`dws_skill`（逃生舱：按需拉取官方技能正文，无参给索引）；命令 `/dws-bridge`。
- 配置 `~/.pi/agent/dingtalk-bridge.json`（含 `skillsDir`，默认 `~/.agents/skills`）；防重发台账 `~/.pi/agent/dingtalk-bridge-sent.json`（会话内存 + 跨会话台账，`dedupMinutes` 默认 60）。
- 背景：dws 官方技能由 npm postinstall 托管、升级即还原不可改，故不碰文件——`before_agent_start` 把 `dingtalk-*` 从注入清单过滤（配置化前缀，`/skill:` 手动加载仍可用）。
- 安全硬约束（**读直通 / 写两阶段 / 敏感档弹窗**，元数据驱动）：分档 = `effect`（`dws schema --cli-path <path> --compact -f json`；缓存 `~/.pi/agent/dingtalk-bridge-schema.json`，手写表兜底，取不到当写入）+ `presumedRead` 只读快判（读词命中且无写词）。写操作首次只回草稿（`pending` 存 `tier`/`canRemember`/`review`），带 `confirm` 重调才执行；敏感档（destructive 或发送/转发/撤回/邀请/删除/清空等）在执行前 `askReview`（`shared/review-panel.ts`：弱化标题 + `动作|对象` 表头 + 固定 5 行正文 + `⚠` 影响行 + 竖排选项；串行链 + status-beacon wait，**无 argv/ID**），无 `hasUI` 直接拒绝；面板「当前工作区不再询问」写 `remembered`（cli_path，destructive 不可记），`/dws-bridge forget|refresh` 管理。发送/转发类**两阶段**
- 敏感档面板字段：`verb`（动作 2~4 字）+ `object`/`objectItems`（对象 = 收件人名册，弹窗前用 `contact user get --ids` 换「姓名（部门）」、仅重名带部门、按可用宽度收口「等 N 人」；撤回 = 会话名 + 时间 + 正文预览）+ `content`（固定 5 行正文）+ `impact`（⚠ 影响）。面板内无 argv/flag/JSON/ID（单测锁住）。官方 capability-limits 那句「个人身份消息无法撤回」与实测不符（实测可撤）。
- 群发 `chat +broadcast`：同样两阶段（不被自动附加的 `--yes` 绕过），且草稿前先跑一次只读 `--dry-run` 预检收件人——有任一收件人未唯一解析（多候选/零候选）就整体拦下、不生成草稿、不做半批次发送，报出候选与消歧办法；消歧 = **把重名的名字换成候选里的 userId**（同命令内可与其它姓名混用；与 userId **并列不解决歧义**，重名 token 仍跳过）。“中文姓名即拦”对群发不适用（其目标按设计就是姓名），由预检把关。收件人也可主动 `--dry-run` 拿「将发给谁 / 未唯一解析」两栏预演。
- 预检明细：dws 在“一个都没解析出来”时直接 exit 3 且不给计划（只有一句笼统报错），插件退回 `probeTarget` **逐名自探**（`+messages-send --user-query`，与 broadcast 同源，**失败 JSON 在 stderr**）；多候选补 `parseOrgInfo` 拿到的部门路径/职务/工号，查无此人给手机号反查入口。
- 人员解析 `dws_resolve_user`：aisearch 候选（名字在 `meta.name`/`author`，不在顶层 `name`）+ `contact user get --ids` 批量补部门/职务/工号；无部门且无工号 = 家长/外部联系人账号（家长账号实测 `depts: []`、`jobNumber: null`），已标注。
- `--dry-run` 一律视为只读预演：不进两阶段门、不记防重发台账（否则会拦掉随后的真发）、结果尾部附明确提示。
- 其他：字面 `\n` 归一 + 多行自动补 markdown 行尾双空格硬换行（钉钉单换行会拼成一行）；文件/媒体消息回报「本条不含正文」（`--title` 不显示给收件人）；查询结果附当前时间锚点；字段拼写不一致自解释（群成员 `openDingtalkId` / 消息 `openDingTalkId`，解析大小写不敏感）。
- 已知限制：这类分享消息用 `+messages-resource-download` 会 `TABLE_NOT_FOUND`——`resourceRefs` 是缺 spaceId 的数字 dentryId，spaceId 藏在正文 yunpan 链接里，只读结果会自动附结构化下载指引；「[文件夹] 姓名」形式无任何引用、实测不可读，直接提示让对方重发 zip。

## mimo-omni.ts（媒体兼容层，过渡件）

- 工具 `mimo_transcribe`（音频/视频 → 逐字稿，或按 prompt 解析要点/行动项/时间轴）、`mimo_speak`（文字 → wav，默认播放）；命令 `/mimo-config`（模型与音色面板）；配置 `~/.pi/agent/mimo-omni.json`；状态 key `mimo-omni`。
- 存在理由：`.pi` 消息类型只有 text/image，全模态模型的原生音频/视频输入还进不了上下文，用两个工具把能力补上；**等 pi 支持音频内容类型后这一层即可整体撤掉**。
- 格式：音频 wav/mp3/m4a/flac/ogg/aac/opus，视频 mp4/mov/avi/wmv（fps 0.1~10、media_resolution `default`/`max`）；本地文件走 base64（>45MB 提前拦截，官方上限 50MB）、公网 URL 直传。
- 解析链带模型降级 + 空正文重试（便宜档 flash 实测约半数只回思考不回正文，会自动降级到 pro/v2.5）；播放走系统自带播放器（Win PowerShell SoundPlayer / afplay / paplay），零依赖。

## qr.ts

- 工具 `qr_encode` / `qr_decode`；命令 `/qr`；状态 key `qr`。
- 编码：图形终端渲染 PNG 真图（kitty/iTerm2 走 Image 组件），普通终端用半块字符 ANSI 绘制（可扫）；`save=false` 不落盘，默认落盘 `os.tmpdir()/pi-qr-<时间戳>.png`；默认 512px（128~2048 钳制）、纠错级别 M；文本超容量时失败提示带纠错建议。
- 解码：本地路径或 URL，PNG/JPEG 纯 JS（pngjs/jpeg-js/jsqr 由 build.js 内联）；支持 PNG 转 JPEG 后解码；非图片/无二维码给明确报错。
- 会话回放安全：工具 details 只存原文，渲染时同步重新编码；`session_shutdown` 清 shared/status 的 TTL timer。
- **`qr/` 目录只是测试目录**（无 `index.ts`，build.js 不会把它当扩展入口），源码是顶层 `qr.ts`；测试 `qr/test/qr.test.mjs` 用 esbuild bundle + jiti 加载产物，12 场景 A~L。
