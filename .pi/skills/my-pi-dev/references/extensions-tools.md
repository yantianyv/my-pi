# 扩展细节 B：外部能力类

## web-tool（`web-tool/`，产物 `web-tool.ts`）

- 文件：`shared/http.ts`（网络层/代理，**已下沉到 shared**，skill-hub 共用）、`search.ts`（免费三源搜索 + 评分）、`providers.ts`（provider 清单 + DeepSeek 付费搜索 + 差评降权排序）、`paid-hint.ts`（付费源引导，会话内只提一次）、`fetch.ts`（抓取转 md + 渲染兜底接入）、`render-cdp.ts`（无头渲染引擎）、`dislike.ts`（差评）、`panel.ts`（配置面板）、`index.ts`。
- 工具 `web_search` / `web_dislike` / `web_fetch`；命令 `/web-tool-config`（代理设置 + 搜索结果黑名单查看/删除选中项）、`/web-render-login`（无头渲染的登录态；`clear` 清空 profile）；状态 key `web-search`、`web-fetch`。
- **`web_search` 的两个参数正交**：`provider`（由谁搜：`free` 默认 / `deepseek`）× `source`（搜哪类：`web` 默认 / `npm` / `github`）。npm / GitHub 走官方免费 API、无付费替代，`provider` 不适用（传付费 provider 给一行忽略告警）。返回的 `source` 只报 `web`/`npm`/`github`，`details.provider` 另给 provider；三源实际命中情况由 `[bing]`/`[so360]`/`[baidu]` 分组标题呈现。
- **两个参数的 schema 用 `Type.String` 而非枚举**：枚举会把非法值在校验阶段就拒掉、白白耗掉一轮重试；String 让非法值进到执行层，照常返回结果 + 顶部警告列出合法取值（`warnings[]` 汇总到 `details`，状态行显示 `⚠ 参数已调整`）。
- **`provider: "free"`**：bing + 360 + baidu 三源并行，结果逐条评分后合并去重取前 15（标题/URL/摘要权重 + 完整短语命中加成，评分 0 滤除）；零 key 零费用、无 AI 总结。第三源选型实测否决 DDG 202 反爬 / Jina 不可达 / Mojeek 403（见 `search.ts` 头注释）。
- **`provider: "deepseek"`**：DeepSeek 官方 Search API（`POST https://api.deepseek.com/v1/tools/search`，`count: 15`），服务端 `rerank_score`（0~3）排序，`authority`/`date` 附在摘要尾部，摘要取长 `summary` 截 400 字。**每 1000 次成功搜索 5 元**（失败/无结果不计费）；凭证复用 pi 的 `deepseek` 供应商 key（`ctx.modelRegistry.getApiKeyForProvider`，插件不另存）。结果按 `rerank_score × dislikePenalty` 排序滤除，**不重算关键词分**（服务端语义排序比词面匹配准）。
- **付费源的发现方式（关键设计）**：**不写进工具 `description`**——否则模型每次搜索都会优先选它、白白花钱。改成免费搜索成功时在结果末尾提一次「不满意可换付费源」+ 调用方式，且**每个会话只提一次**（`providers.ts` 的 `sessionId` 记账，`session_shutdown` 清账）；未配 key 时完全不提。
- **供应商实测（2025-10 全量）**：除 DeepSeek 外均不可用——智谱 `web_search` 余额不足、Kimi/小米/opencode-go 的 kimi 是服务端工具调用（拿不到结构化结果且需先跑一轮模型）、opencode 的 gpt/gemini 模型访问权未开通或被地区/隐私设置拦截、火山与 SenseNova 无此端点。新增付费源：`PAID_PROVIDERS` 加一条 + `searchPaid` 加一个分支。
- `web_dislike`：AI 对低质量域名记差评，×0.6/次、5 次滤除，跨会话持久化 `~/.pi/agent/web-search-blacklist.json`。**免费三源与 DeepSeek 付费共用同一份黑名单**。
- `web_fetch`：正文提取（turndown/domino/gfm 由 build.js 内联）+ 截断；GitHub blob URL 重写为 raw 直取（防源码被当标签吞）；正文极短（JS 空壳）时用 Googlebot UA 重试一次；仍极短且像未渲染空壳时走无头渲染兜底；极短且命中 Cloudflare 等挑战特征时报「反爬验证页」并给下一步（换源搜索同类内容 / 需登录的站点用 `/web-render-login` 登录后重试；挑战页要过 JS 校验，无头同样被拦，所以不浪费一次渲染）。回执末尾标注「无头渲染 <持久化|临时> profile，<毫秒>」，`details.rendered` 供渲染/状态判断。
- **渲染兜底（`render-cdp.ts`）**：零依赖——`child_process.spawn` 起 headless shell + Node 内置 WebSocket 直连 CDP（只碰 Target/Page/Runtime）。选它而非 playwright-core 的理由：内联 playwright-core 会让产物从 615KB 涨到 5.2MB（esbuild 实测 4.62MB，且 `chromium-bidi/*` 必须外部化），外置破坏单文件约定，且本机缓存是 chromium-1228 而 1.58.2 期望 1208。实测冷启动约 0.85s、复用会话约 0.33s（navigate 5~20ms）。**每次渲染独占一个标签页**（`Target.createTarget` + attach，用完 `Target.closeTarget`；建+挂实测 100~480ms），浏览器进程仍然复用——并发的两个调用各拿各的页面，不会串页。启动参数由导出纯函数 `buildLaunchArgs({profile, proxyUrl, headless})` 拼装（可不起浏览器就断言代理/profile/headless 分支），**渲染走同一条代理**（`fetch.ts` 调用点传 `proxyUrl: getProxyUrl()`，引擎拼 `--proxy-server`）。
- 触发条件 `looksLikeUnrenderedShell(html, markdown)`（在 `fetch.ts`）：正文 <80 字符、或正文 <400 且 HTML >20KB、或正文 <600 且命中 `__NEXT_DATA__`/`id="root"`/`ng-version` 等挂载点标记。渲染结果**只在新结果更长时**才替换（可能渲染出 cookie 横幅/登录页）；渲染不可用或失败一律静默回落，不改既有行为。
- 浏览器与 profile：`findChromePath()` 扫 `ms-playwright/chromium*` 取最大 revision（版本号不写死；**环境变量 `PI_WEB_RENDER_CHROME` 指向不存在的路径时返回 null**，否则 `rendererReady()` 会撒谎白试一次启动）；持久化 profile 在 `~/.pi/agent/web-render-profile/`（`PI_WEB_RENDER_PROFILE` 可覆盖，测试隔离用），首次渲染时懒启动、空闲 60s 自动关、`session_shutdown` 里 `shutdownRenderer()` 兜底（幂等）。无头浏览器里无法扫码登录，登录走 `/web-render-login`：先关无头渲染器放锁，再用带界面的 chrome 打开同一 profile 供人工登录。
- 三个必须守住的坑：① headless shell **不拦同一 user-data-dir 的第二实例**，两个进程共用一份 cookie 库会互相覆盖，所以持久化 profile 用 `.pi-render.lock`（`{pid,at}`，pid 存活且锁新鲜即视为被占）互斥，被占时本次退回临时 profile；浏览器自己退出时也要放锁，否则死 pid 占死 profile。② 模块级 `session` 必须真正复用，漏赋值会每次新起浏览器、旧进程仍活着共用同一 profile，表现为 navigate 从 5ms 劣化到 **1470ms**（profile 争用）。③ **标签页必须一次渲染一个**：共用一个页面时同一进程内的并发调用互相抢导航，实测并发 A 拿到 B 页的正文（比报错更坏）；`renderPage` 返回的 `phases.{launch,target,navigate,settle,grab}` 就是为定位这类问题留的（`target` = 建/挂标签页），`PI_WEB_RENDER_DEBUG=1` 打到 stderr。
- 代理配置 `~/.pi/agent/web-fetch-proxy.json`；直连与降级（系统 curl 自动带代理 / 无 curl 退 Node CONNECT 隧道）**并行竞速**，谁先成功用谁，404 等确定性错误立即判死。HTTP 层复用 `shared/net`；curl 通道（`hasCurl`/`curlFetch`/`httpGetCurl`）收在 `http.ts` 供 fetch 与 GitHub 源共用。
- 测试：`test/render.test.mjs`（**42 项 A~K**：触发判定、壳页自动兜底、静态页不启动浏览器、启动失败静默回落、超时页面、profile 锁三态、空闲回收后自启、分段耗时；本轮新增 **I** 反爬挑战页报错带指引且不渲染、**J** `buildLaunchArgs` 纯函数（代理/profile/headless）、**K** 并发渲染各拿各的页面）。注意测试用**单入口 bundle**（临时入口同时 re-export `fetch.ts` 与 `render-cdp.ts`）——两个独立 bundle 会各持一份模块状态、各起一个浏览器共用同一 profile，自己就会踩到 profile 争用导致导航 1.5s。
- **真实站点实测（2026-10-14，源码 bundle + 本机代理）**：excalidraw.com 触发渲染（3.9s，拿到渲染后的中文界面文案）、app.diagrams.net 触发渲染（11.2s、正文 12k 字符）、figma.com / react.dev **未**触发（SSR 直出 11.8k 字符，判定没误伤）、wikipedia 静态页未触发；web.telegram.org/k、youtube.com、reddit.com、chatgpt.com（403）在 **HTTP 层**就失败（超时/连接重置/403）——渲染兜底接在「抓取成功但正文极短」之后，HTTP 全失败时它根本不会被触发。代理有效性单独对照：坏代理渲染 example.com 全程取不到正文（settle 烧完 20s 预算，html 39 字节），真代理 1.2s 出正文（证明 `--proxy-server` 真的生效）。
- **渲染兜底的现实命中面比设想窄**（2026-10-14 二轮探测，google / twitch / coursera / chatgpt 四站）：可直连的 JS 站基本都 SSR 直出正文（google 1266 字符、coursera 11.7k，均未触发）；真正会触发的重 SPA 在 15s 预算内常常渲染不完（twitch.tv：全程 23.7s，渲染尝试静默回落，最终只剩「正文极短」警示）；被墙站则多在 HTTP 层就失败（403 / 连接重置），根本走不到渲染。**两个待拍板项（未改）**：① HTTP 403/反爬类失败是否也试一次渲染（浏览器可发真实头，可能比裸抓成功）；② 重 SPA 的渲染预算是否放宽（现状 15s 总预算，超时即回落）。
- **已知缺口（均为已拍板维持现状或人工步骤，已实测/读码核实）**：
  - **强杀不留收尾**（拍板不做）：`session_shutdown` 之外的退出（pi 崩溃 / 被 SIGKILL）不带走浏览器子进程，会留一个占着 profile 的 chrome；下次渲染因锁被占回退临时 profile（功能不坏，丢登录态），进程残留到重启。启动时清扫（按 pid + `--user-data-dir` 匹配残留进程）暂缓，等真实遇到再评估。
  - **极小页面也触发渲染**（拍板维持现状）：判定只看正文 <80 字符，一行公告这类合法小页面也会白付一次约 0.85s；宁可多付也不漏真 SPA。
  - **未实测项**：`openLoginWindow()`（会弹真实窗口，只验证过 `findChromePath({headed:true})` 选到 chrome.exe 而非 headless shell）；mac/Linux 的浏览器路径候选表（Windows 已实测）。

## skill-hub（`skill-hub/`，产物 `skill-hub.ts`）

- 文件：`index.ts`（4 工具 + `/skill-hub` 命令 + `resources_discover` + 面板依赖装配）、`reload.ts`（装/卸后的重载调度）、`panel.ts`（技能市场浮层）、`favorites.ts`（收藏存储）、`registry.ts`（skills.sh 检索/审计 + jsDelivr 版本与清单 + 来源字符串解析）、`fetch.ts`（逐文件取回 + 上限 + 容错）、`install.ts`（私有存储路径/账本/原子写盘/越界判定）、`trust.ts`（信任判定）、`frontmatter.ts`（SKILL.md 头部解析与规范校验）、`format.ts`（回执文案）、`test/`。
- 工具 `skill_search` / `skill_inspect`（只读）、`skill_install` / `skill_uninstall`（写，均两段式）；命令 `/skill-hub`（`list` / `remove <名>`）；状态 key `skill-hub`（priority 72，已登记 `STATUS_STYLE`）。
- **存储独立于手动技能**（拍板：只做项目级，不做全局）：技能在 `<cwd>/.pi/skill-hub/skills/<name>/`，账本在 `<cwd>/.pi/skill-hub/installed.json`。理由有两条：① 与 `.pi/skills/` 里人放的技能混在一层时分不清谁装的；② 卸载要成为可交给 AI 的操作，就必须能界定「能删什么」——以账本为准时，手动技能天然不在射程内。`isManagedPath` 另外兜一层路径包含校验（越界、兄弟目录前缀相近都拒绝）。
- **必须用 `resources_discover` 注册**：pi 只扫 `<agentDir>/skills/`、`<cwd>/.pi/skills/` 与 `.agents/skills/`，别处目录不会自己被发现。扩展在 `resources_discover` 里返回 `{ skillPaths: [<cwd>/.pi/skill-hub/skills] }`，仅在目录存在时返回（否则空对象），事件在启动与 `/reload` 时触发。
- **规范校验口径对齐 pi**（`frontmatter.checkSkill`，返回 `{blockers, warnings}`）：pi 的 `core/skills.js` 只把「description 缺失/为空」当拒载，名字不合规与 description > 1024 字符都只是 warning 诊断、照常加载。所以 blockers 只装缺 description（真装不上才拦）；其余进 warnings，在计划与预览里作「规范提示」展示，**不阻断安装**。曾有版本把 1024 当硬门槛，导致 1165 字符的正常技能被拒装。
- **重载调度（reload.ts）**：装/卸后必须重载才生效，但两个坑——① 轮中 reload 会让旧 runner 失效，本轮后续扩展工具调用全部报 stale，只能在安全边界（agent_settled / 空闲）重载；② `pi.sendUserMessage("/reload", {deliverAs:"followUp"})` **根本不会重载**（sendUserMessage 默认 `expandPromptTemplates: false`，命令不派发，原文进对话）。打法：`/skill-hub` 加隐藏子命令 `__reload`（不占顶层命令位、不进自动补全；命令上下文才有 `ctx.reload()`，且 pi 没有编程式命令执行 API，只能经 sendUserMessage + `expandPromptTemplates: true` 派发）；轮中先 `deliverAs:"steer"` 插一条收尾指令让模型立即结束本轮，`agent_settled` 后派发重载命令；空闲且面板未开时直接派发（面板属旧运行时，开着不能 reload，面板关闭补发）；续跑指令存 `globalThis.__PI_SKILL_HUB_RESUME__`（跨 reload 存活），新实例 `session_start(reason=reload)` 时发出让任务自动继续；`settled(aborted)` 清续跑标记但照重载。测试 `test/reload.test.mjs`。
- **网络通道**：GitHub 直连（github.com / api.github.com / codeload）在本机常被重置，**不得把 git clone 当主路径**。检索走 `https://skills.sh/api/search?q=&limit=`；版本定位与文件清单走 `https://data.jsdelivr.com/v1/package/gh/<repo>`（取 `versions[0]` 作 ref，取不到落 `main`）与 `/@<ref>/flat`；文件走 `https://cdn.jsdelivr.net/gh/<repo>@<ref>/<path>`。全部经 `shared/http` 的 `fetchTextAny` / `fetchJsonAny`。
- **文件取回要留备用 CDN 节点**：主站 `cdn.jsdelivr.net` 对部分文件（README.md / SKILL.md / references/*.md 这类源文件）会 301 跳到 `raw.githubusercontent.com`，而后者在本机常不可达或卡到超时——表现为「清单拿到了、正文永远读取失败」。`readRepoFile` 主站失败后再试 `gcore.jsdelivr.net`（同内容直出），两节点共用一个总预算（各分一半，`timeoutMs` 即总预算），避免最坏耗时翻倍。
- **flat 清单两种形态**：`/flat` 端点返回 `files: [{name: "/a/b.md", size}]`（name 自带前导斜杠，**没有 type 字段**）；非 flat 端点返回带 `type` 的嵌套树。`registry.flatten` 两种都认——只按树处理会让路径被多切一段（实测 `skills/pdf` 变 `kills/pdf`，取文件全 404）。
- **`dir` 统一无前导斜杠**（空串 = 仓库根）：清单路径无前导斜杠，两套写法混用会让 `startsWith` 前缀匹配静默失效（取回零个文件）。`resolveSkill` 末尾校验 `<dir>/SKILL.md` 确实在清单里，缺失即报错，不返回半套结果。
- **技能在仓库根时不能按目录名比 skillId**（`registry.pickSkillDir` / `skillNameOf`）：`/SKILL.md` 的目录是空串，旧逻辑拿空目录名与 skillId 比必然不等，于是把这类仓库一律报成「没有名为 X 的技能」——skills.sh 上大量单技能仓库正是这个结构（实测检索 vibe-knowledge 的 9 条结果里 5 条如此）。现在仓库根的技能用**仓库名**当它的名字（与 pi 以 SKILL.md 父目录名兜底同口径）；仓库里只有一个技能时不再挑，`skillId` 只是 skills.sh 的标注，目录才是事实。名字推导统一走 `skillNameOf(source, dir)`，别处不要再写 `dir.split("/").pop()`。
- **审计数据源**：主通道是官方 JSON 端点 `GET /api/v1/skills/audit/{source}/{skill}`（**无需鉴权**，是 v1 里唯一开放的端点；其余要 Vercel OIDC token）。它返回**全部五家**（Gen Agent Trust Hub / Socket / Snyk / Runlayer / ZeroLeaks）+ 结论摘要 + 风险等级 + 审计时间；**网页 HTML 只渲染三家，看不到 Runlayer / ZeroLeaks**（实测 `obra/superpowers/brainstorming` 网页只见 Socket warn，JSON 里 Runlayer 是 fail）。降级通道 `fetchAuditsFromPage` 才解析 HTML，只当端点 404/不可用时兜底。
- **信任判定（`trust.judgeTrust`）**：免人工面板 = 仓库命中精选名单（`TRUSTED_REPOS`：anthropics/skills、badlogic/pi-skills、vercel-labs/agent-skills、obra/superpowers、mattpocock/skills）**或**审计**全 Pass**（拍板口径：**端点返回几家就判几家**，当前五家；任一家 Warn/Fail 即不算通过，空结果也不算）；**带可执行文件（`EXECUTABLE_EXT`）或非文档文件时一律 `trusted=false`**——审计扫不到「模型读到 SKILL.md 后会怎么用这些脚本」。
- **两段式写操作**：install / uninstall 首调只回计划，带 `confirm=true` 才落地；`trusted=false` 的安装与所有卸载还要过 `askReview` 面板。**无界面会话（`hasUI=false`）fail-closed**，并给出「请在交互式会话里重试」的明确失败文案（不是笼统的「人工确认未通过」）。
- **取回容错**：jsDelivr 清单来自仓库索引，CDN 侧个别文件会 404（实测 `anthropics/skills` 的 `check_bounding_boxes_test.py`：清单有、各节点都取不到）。`fetchSkillFiles` **不因单文件失败中止**，记进 `skipped` 并在回执列出；只有 SKILL.md 取不到才抛错。
- **体积上限按文件跳过而非拒装整包**（`fetch.pickWithinLimits`）：超单文件上限（4 MB）的文件跳过；总量超 12 MB 时从最大的开始跳直到装得下，SKILL.md 不参与淘汰，只有它自己超限才算失败。大文件在技能里通常是示例素材（实测 `vibe-knowledge-film` 带两个 17/29 MB 的演示 GIF），为核心文档放弃整包不划算。跳过的原因同时写进 `skipped`，回执按「原因 + 前 10 条 + 余数」展示。
- **技能市场面板（`panel.ts`，人用）**：`/skill-hub` 无参打开，overlay 居中 76% 宽。三态：`browse`（本地视图＝收藏＋已装合并 / 检索结果）、`input`（搜索词编辑）、`confirm`（不可逆动作二次确认）。键位 `↑↓`/`PgUp·PgDn`/`Enter`/`f` 收藏/`/` 搜索/`r` 刷新/`Esc`；browse 下直接打可打印字符即进入输入态（少按一次 `/`）。**面板内的安装不再弹 review 面板**——人在面板里按 Enter 就是授权；但安装先做 `describe`（文件清单＋审计）二次确认、卸载先列目录二次确认，避免手滑。面板与工具共用 `prepare` → `performInstall` / `performUninstall`（后者从工具里抽出来），面板只负责交互与展示，`PanelDeps` 注入便于离线渲染测试。
- **收藏（`favorites.ts`）**：全局 `~/.pi/agent/skill-hub-favorites.json`（`SKILL_HUB_FAVORITES_DIR` 可覆盖），键是 `source/skillId`（与 skills.sh 的 id 同构），按 `addedAt` 倒序。**与安装账本分离**：收藏回答「这人想留着什么」（跨项目），账本回答「这项目装了什么」（项目内）。`skill_search` 把匹配到的收藏项**置顶**并在回执行首标 `★ …（用户已收藏）`；`skill_inspect` 头部也标。命令 `/skill-hub fav <owner/repo/skill>` 可切换。
- **已删能力**：曾有的 `skill_load`（临时加载到系统临时目录、注入 SKILL.md 正文）**已移除**——内容作为工具结果会随上下文压缩被摘要/截断（`docs/compaction.md` 序列化时截到 2000 字符），且多出一条「用了但其实随时会消失」的路径，只会让模型混淆。要长期用就 `skill_install`。
- **网络请求一律给总预算**：`shared/http` 的 `fetchTextAny` 支持 `totalBudgetMs`（跨通道共享额度）——只给单通道超时会让最坏耗时变成「通道数 × 超时」，`resolveSkill` 曾因此可达 36 秒。registry 的版本定位/文件清单/审计各封 12 秒、目录检索 20 秒；`readRepoFile` 的 `timeoutMs` 即跨 CDN 节点的总预算（安装默认 20 秒，面板预览传 5 秒）。registry 另有 10 分钟内存缓存（ref / flat 清单 / 审计），面板里翻同一仓库的技能不重复请求。
- 测试：`test/panel.test.mjs`（面板 A~G：收藏存储 / 渲染与宽度 / 键位含直接打字进输入态与检索置顶 / 确认态二次确认与 Esc 不动数据 / 检索与 describe 失败如实显示 / 选中项详情与缓存与超时 / 描述取不到与未声明区分）、`test/skill-hub.test.mjs`（离线 A~G：frontmatter 解析与规范校验 / 信任判定（含 Warn、Fail 不算通过）/ 私有存储路径与账本与原子写盘与路径穿越 / 卸载边界（手动技能、越界、兄弟目录）/ 临时加载已删 / 来源解析 / 取回上限与体积跳过 / 技能目录定位（仓库根、单技能、精确匹配））、`test/skill-hub-live.mjs`（真实网络：检索、定位、取回、审计、`resources_discover` 前后）。

## webdav-kb（`webdav-kb/`，产物 `webdav-kb.ts`）

- 文件：`client.ts`（WebDAV + 代理）、`tools.ts`、`commands.ts`、`panel.ts`/`panel-config.ts`、`store.ts`（配置 + 同步账本）、`sync.ts`、`search.ts`、`formats.ts`、`protocol.ts`、`secrets.ts`、`crypto.ts`（vault）、`lfs.ts`、`index.ts`。
- 工具 14 个 `kb_*`：`kb_help/search/read/write/append/list/upload/download/lslfs/import/delete/move/status/sync`，全部直接声明；命令 `/kb`（含 `sync` 子命令）与 `/kb-config`；状态 key `kb-sync`、`kb-vault`、`kb-op`（kb 工具回执合成一个键，状态行只推短摘要）。
- 配置 `~/.pi/agent/kb-config.json`（`KB_CONFIG_DIR` 可覆盖，测试隔离用）：`baseUrl`/`username`/`password`/`proxyUrl`/`mirrorDir`（默认 `~/.pi/agent/kb/`）/`vault`{salt,check}/`persistVault`/`vaultKey`/`readOnly`/`allowSecretUpload`。同步账本 `.kb-sync.json` 存镜像根（远端 etag/lastModified/size + 本地 mtime 快照 = 增量依据）。
- 同步：etag/mtime 比对，冲突以远端为准 + 本地 `.conflict-<时间戳>` 副本；`.kb-sync.lock` 互斥锁（持锁方 10s 心跳续期 + 进度上报，后到者排队等待，pid 判活/心跳 45s 超时回收残锁）；`.kb-sync-journal.json` 中断恢复（phase: plan/conflict/upload/delete，成功即删）；上传前 secret 扫描拦截（`secrets.ts` 高精度模式，`allowSecretUpload` 兜底）；`delRemote` 404 幂等；同步后清理本地空目录（`.kb-*` 与镜像根保留）。
- **目录快照剪枝（同步变快的唯一杠杆）**：123 云盘在服务端硬限速 ≈5 请求/秒，实测并发 1/2/4/8/16 吞吐完全一致，**提高并发毫无收益，只能减少请求数**。故 `walkRemote` 在账本 `dirs` 里记每个目录的 mtime（取自父目录 listing 里子目录那条，不需要额外请求），本次 listing 的 mtime 与快照一致 → 整棵子树不下钻（`pruneSubtree` 把旧快照整体继承，深层目录也在内）。实测 2474 目录的全树 495.7s → 0.3s（1 个请求）。三条配套约束：① 被剪枝子树的文件必须由 `inheritSkipped` 用账本记录还原回远端视图，否则会被判成「远端已删」而删本地；② 快照有 `DIR_SNAPSHOT_MAX_AGE_MS`（24h）过期，到期强制重新下钻——123 云盘目录 mtime 有分钟级元数据缓存延迟，且不保证所有服务器都向上传播；③ `/.history` 走 `ONE_WAY_DIRS` 无条件剪掉（历史副本是本地派生物，只推不拉），LFS 元数据缓存同理要保住被剪枝目录的旧条目（`syncLfsCacheFromRemote` 的 `pruned` 参数）。`full: true`（`/kb sync full`、`kb_sync full`）忽略全部快照。
- 上传路径的两个放大器：`ensureRemoteDirs` 的 MKCOL 链按客户端实例缓存已确认目录（`knownRemoteDirs` WeakMap），不再每个文件重走祖先；服务端不回 ETag 时（123 云盘）不再逐文件 `stat`，改在全部上传完后按目录分组发一次 PROPFIND 批量补（`needEtag`）。
- `kb_lslfs` 的 `path` 参数走 `listLfsDir` 只列那一层（1 个请求），不因「先遍历整棵 /lfs 再过滤」把上千目录全问一遍；单目录失败（123 云盘对超大目录返回 504）只记入 `failed` 不阻塞其余结果。
- 区域：vault 加密区、LFS 大文件区、`/.history` 历史副本区（改动/删除自动留档：结构镜像根、文件名加 `_yymmddhhmmss` 后缀、同秒重名叠 `_hash`、同内容跳过、自身不递归、不参与列表与检索；恢复走 WebDAV 客户端）。
- 检索：纯文本多格式全文索引（md/txt/csv/tsv/json/jsonl/yaml/yml/toml/html/xml，csv/tsv 表头加权，frontmatter 仅 md 强制）；跳过 `.kb-*` 与 `.conflict-*`。
- 分类层级守则 `/命名空间/用途/自由层级`（用途 = 文档功能六值硬约束，自由层级 AI 管理软约束，见 `protocol.ts` 的 `DEFAULT_PROTOCOL`）；守则对 `kb_list`/`kb_status` 不透明（走 `kb_help` 专用通道，`kb_search` 保留索引兜底）；源码为默认版，远端用户可手动迭代。
- 只读模式 `readOnly`（`/kb-config` 面板切换、默认关、**下次会话生效**）：6 个写工具注册为 `hidden`（write/append/upload/import/delete/move，`kb_sync` 保留），不会被发现通道激活，`session_start` 同时清理已有活动项；syncAll 自适应为仅下载（本地删除 → 重新下载，本地新建/修改留本地）；ensureProtocol 跳过。
- 同步结果统一呈现：`sync.ts` 的 `formatSyncSummary`（计数全人话、0 值省略）与 `formatSyncNotes`（冲突副本路径与处理办法、不可达目录、失败明细），命令/工具/配置面板/后台同步四处共用（后台同步与 /kb sync 的编排收敛在 commands.ts 的 runSync，notify 与锁等待策略经参数区分）；`client.ts` 的 `describeSyncError` 把 401/403/404/网络类异常翻成可操作提示。

## workflow-mgr（`workflow-mgr/`，产物 `workflow-mgr.ts`）

- 文件职责：`index.ts`（组装薄壳）、`tools.ts`（5 个工具）、`commands.ts`（`/wf` 状态摘要 + `/wf-config` 无参浮窗）、`events.ts`（session 钩子 / hud 联动 / 角色注入）、`store.ts`（数据层 + 路径解析）、`types.ts`（类型 + schema 常量）、`panel.ts`（展示层）、`brief.ts`（AI 简报 `renderBrief`/`summaryLine`/`lightState`）。
- 工具：`wf_workflow`（`list`/`add`/`edit`/`remove`/`archive`/`import`）/ `wf_status` / `wf_switch`（完成 + 推进一步到位，`complete=false` 搁置）/ `wf_block` / `wf_rollback`。无绑定守卫，任何会话随时可用。
- 存储（全局、按会话隔离）：`<workflowHome>/<项目标识>/<会话 ID>/{workflow.json,state.json}`。`workflowHome` = `~/.pi/agent/workflow`（`PI_WORKFLOW_HOME` 可覆盖，测试用）；项目标识 = 目录名净化 + cwd sha1 前 8 位（同名目录不串）；面板开关 `config.json` 全局单份；`archive` 移入 `<项目标识>/archive/<时间戳>-<名称>/`。工作流数据不进项目 `.pi/`。状态 key `workflow-mgr`。
- `WorkflowStore` 构造时固化 cwd 与会话 ID（不持 ctx），`getStore` 按二者变化重建——session 替换不触发 stale，同项目多会话各写各的会话文件、天然隔离。
- `session_start` 加载本会话数据并刷新 UI（无工作流 → 隐藏面板）；`before_agent_start` 仅在有非空工作流时按 `mode` 注入（human-ai = 指挥者、agent = 自动驾驶执行者），否则零注入。
- 展示：常驻 widget（belowEditor）+ `/wf-config` 浮窗 + 非 TUI 文本回落（`compactLines` 单一渲染源）；hud 在场且开启时改由 `__PI_HUD_API__` 渲染在 footer 最底部（见 `hud-and-shared.md`）。
- 测试：`test/render.test.mjs`（17 场景 A~R，含 `__PI_HUD_API__` 注册/通知/注销）、`test/stale-ctx.test.mjs`。

## dingtalk-bridge/（钉钉 dws CLI 受控桥接 + 业务语义层）

- 目录：`index.ts`（注册工具 + 受控管线 + 解析层）、`intents.ts`（语义层纯映射：业务参数 → dws argv，离线可测）。
- **模型侧只有 1 个常驻工具 + 8 个延迟工具**：`dingtalk_help`（无参，装载业务工具）常驻；业务工具 6 个语义层（`dingtalk_msg` / `dingtalk_todo` / `dingtalk_calendar` / `dingtalk_approval` / `dingtalk_file` / `dingtalk_doc`）+ `dingtalk_confirm`（二次确认）+ 唯一逃生舱 `dws_skill`（只给官方技能正文当知识，**没有任何命令执行通道**，也不是插件缺口的出路）全部 `defaultActive: false`，装载前不声明给模型、不占上下文。命令 `/dws`（状态 / unload 卸下 / forget / refresh）。
- **按需装载的边界（实测约束）**：`pi.setActiveTools()` 在纯名单式 `--tools`（如 `-t read,bash,x`）下不生效，必须用 `+name` 形式或默认选择；装载在**下一轮**才生效（同一轮里紧接调 `dingtalk_*` 会失败），help 的返回文本与 promptGuidelines 都要说清。未装载时 `before_agent_start` 不注入任何钉钉规则（省上下文），装载后才注入写操作两阶段等五条。曾试 pi 自带 `tool_search` + `exposure: "deferred"`：其 BM25 只索引 ASCII，中文描述完全进不了索引（查「钉钉消息 发送」恒空），故不用。
- 语义层设计：`intents.ts` 一动作一行纯映射；`index.ts` 负责解析（姓名→userId、DING 另补 openDingTalkId、群名→openConversationId、消息关键词+会话→msgId、文档标题→nodeId、多维表名→baseId/tableId、钉盘名→nodeId、完整手机号→账号、本人 userId）后调 `runGuarded`——**与内部执行管线共用同一条门禁链**（换行归一→分档→参数自检→两阶段→人工面板→台账→结果注解），语义层绕不开任何一道拦截。文件消息（`send` 带 `file`）只用 userId（`--user`），管线自己换 openDingTalkId：**别在语义层要 openId**，按 ID 解析出来的收件人本来就没有它（重名消歧给出的就是 userId，那正是发文件的入口）；只有 `ding --users` 是真的只要 openDingTalkId，那里才走 `withOpenIds`。
- **同名/同名群不弹人工确认**：把候选（含部门/职务/工号与账号 ID）作为结果回给 AI，由 AI 自己挑定后把该项换成候选 ID 重调（提示词第 3 条明确要求）；查无此人时改用手机号即可（插件走 `contact user search-mobile`）。
- **「查询失败」与「查无此人」分开报，自指词直连本人**：姓名搜索统一走 `searchPeople`（`aisearch` 只有 ~3 秒预算，网关 `request_timeout` 在审计日志里每天都出现，失败自动重试一次，只读幂等）；两次都失败时报 `searchFailedNote`（真实原因 + 「原样重试」，不再说成「核对用字」）——压成后者会把一次超时误判成「搜不到某人」。「我/自己/本人/me」与本人的姓名、userId 一律走 `contact +me`（`isSelfToken`，结果含 openDingTalkId）拿账号，不依赖语义搜索是否把自己排进结果。
- **AI 角标由插件带**：发送类映射统一加 `--ai-tag`（dws 原生角标），模型不必在正文写【AI发送】；正文里的字面反斜杠-n 仍自动归一为真换行。
- 在线表格创建走 `dingtalk_doc action="sheetCreate"`（有 values → `sheet create-with-data` 创建+写入+回读一体，空表 → `sheet create`；长整数自动转文本防精度丢失；失败/超时时结果里附续做指引——读回现状只补失败步骤，禁止整体重跑）。
- 表格下拉列表三件套：`sheetSetDropdown`（options 与 sourceRange 二选一、选项禁英文逗号、sourceRange 只收 A1 区域不带表前缀；set 成功后结果附 get-dropdown 只读核验指引）/ `sheetGetDropdown` / `sheetDeleteDropdown`；缺 sheetId 时 resolve 用 `+list-sheets` 取首个工作表（禁止猜 Sheet1/0）。
- 覆盖范围即上表六个域的主用动作；长尾（听记/考勤/邮箱/组织/表格结构/多维表视图等）**AI 做不了**：先回报用户缺什么、常用的话建议补进插件，`dws_skill` 只为这份回报评估可行性而读，禁止照文档换参数/换格式自己继续试；需要时按动作表补进插件。
- 安全门禁（`decideExec` + `runGuarded`）：读直通 / 写两阶段（草稿 + `dingtalk_confirm`）/ 敏感档人工面板（`shared/review-panel.ts`，面板只写人话、无 argv/ID，无界面会话直接拒绝）；面板「当前工作区不再询问」写 `remembered`（cli_path，destructive 不可记）。分档由 dws schema 元数据的 `effect`/`availability` 决定（缓存 `~/.pi/agent/dingtalk-bridge-schema.json` + 手写表兜底）：上游标 `availability≠available` 的命令直接报不可用与原因，不掩成内容错；命令路径（canonical/点分/本地旧写法）统一归一到可执行 cli_path。
- **确认只给 token（省 token）**：业务工具不再有 `confirm` 参数；草稿阶段把已解析好的完整 argv（含群发 vars/plan）存进 `state.pending`，`dingtalk_confirm(token)` 取出即执行（`peekDraft` 纯函数负责存在/过期判定，10 分钟 TTL）——长正文、表格 values、群发变量表不必重写一遍。确认模式复用同一条 `execTool.execute`（内部入参带 `draft`），跳过策略重判、只补一次防重发核对；敏感档仍在真正执行前弹面板。
- **外发文件一律带时间戳命名**：`stampOutgoingFiles` 把远端名改成 `<原名>-YYYYMMDD-HHmmss.<ext>`——`drive +upload` 用 `--file-name`（本地文件不动），文件消息没这个参数，就在系统临时目录生成副本并把 argv 指向它（发送完 `removePath` 递归清理，`done()` 包住每条 return 路径）。**签名必须在改名之前算**（用原始 argv + `fileFingerprints` 的 size/mtime）：否则每次都成新签名，防重发台账会被架空；反过来改内容重发则因指纹变化而放行（同路径不同内容不再被误判重复）。
- **codemode 下拒绝敏感档**：`shared/codemode.ts` 的 `isCodemodeCall(toolCallId)`（嵌套调用 id 形如 `<父 id>/<n>`）判定调用来源；脚本里弹不出人工面板、等待会一直计入脚本超时且超时重试会堆积，所以敏感档直接拒绝并提示改直接调用，只读与两阶段写照常可用；`dingtalk_confirm` 同样拒绝在脚本内确认敏感档草稿（脚本内用 confirm 生成草稿→执行两段则正常可用）。
- 群发逐人个性化：`dingtalk_msg` 的 `vars` 参数（`{收件人: 值}` 或 `{收件人: {变量: 值}}`）映射到管线的私有 `--vars`，正文含 `{{变量}}` 时由管线逐人渲染发送；缺变量表在草稿前拦下。**变量表的键三种写法都认**（预检回显的显示名 / `--to` 里的原文 token / userId，`matchRecipientAliases` + `personalizedRow` 按此顺序取），所以同名消歧后把 `--to` 换成 userId、变量表还照姓名写也能通过。**草稿阶段定下的变量表随草稿走**：`--vars` 在管线入口就剥离、草稿 argv 里没有它，确认时 `resolveRunVars` 先用 `draft.vars`，绝不回头按 argv 重解（否则确认恒报「没有给变量表」，逐人个性化整条路径不可用）；渲染样例存在 `draft.varsSample`，确认回执与发送完成回执各展示一次，人不用凭 argv 判断发出去的是什么。
- 查消息连附件一起落盘：`dingtalk_msg action="read"` 默认附 `--download-resources --output-dir <outDir>`（缺省 `.tmp/dingtalk-media`），dws 把命中消息的 mediaId/fileId 全下到该目录（非 NTFS 卷自动重定向），结果里回显目录与 localPath（模型可直接 read）；`downloadResources=false` 只查文字，`outDir` 改目录（必须是工作目录内相对路径，插件先拦盘符/前导斜杠/`..`）。
- 会话参数可写人名：`inGroup` / `destGroup`（转发目标）先当群找，找不到就按人找单聊（`aisearch person` 取 openDingTalkId → `+conversation-info --open-dingtalk-id` 取单聊会话 ID），重名走候选流程；已是 `cid` 的不再猜人。
- 群解析（`resolveGroup`）：`isIdLike` 判为 cid 就直通（字符类含 `=`，base64 填充合法）；否则 `+chat-search` 后由 `matchGroupsByName` 按 name **全等**过滤——`parseGroups` 输出键是 `{cid,name,extra}`，改这里别再按上游原始键 `title`/`openConversationId` 读（曾因键名错配导致群名解析恒空）。全员群/内部群在搜索范围内，多候选强制人工挑 cid。
- 模型侧不出现 dws 命令路径：错误与提示一律指向插件动作（如「用 action="send" to=[…] 重发」），也不写「用 dws_skill 查文档自己试」——前者会让模型去 bash 里敲原生命令，后者会让它把只读知识当绕行手册，两者都绕开全部门禁。能力缺口就如实回报，常用的话由人补进插件。
- 群发 `chat +broadcast`：草稿前先跑只读 dry-run 预检收件人，有人未唯一解析就整体拦下（不半批次发送）；正文含 `{{变量}}` 时改走逐人单聊（`sendPersonalized`，每人一份变量表 + 确定性幂等键，重跑自动跳过）。
- 分享链接落地走 `dingtalk_file action="fetch"`（link 或 spaceId+nodeId；文件直下、文件夹递归镜像，非 NTFS 卷自动改到系统临时区下载再搬回）。
- **非 NTFS 卷（exFAT/网络盘）落盘自动重定向**：dws 用「`.part` 临时文件 → `link` 硬链接到正式名」做原子发布，硬链接只在 NTFS 可用 → exFAT 上必然 `link …: Incorrect function`。触发不看退出码（`--download-resources` 类把失败写进结果 JSON、exit 仍是 0），也不靠手写命令清单：`isLinkPublishFailure(输出)` + `shouldRetryRedirect`（已知下载类直通；否则要求 argv 带输出类 flag 且 schema 参数表含 `output`/`output-dir`/`local-folder`/`transcript-output`、且 `effect=read`——写命令不自动重放）。重试只把 cwd 换到 `os.tmpdir()`，相对输出路径原样保留（不猜文件还是目录），搬回时按产出物本身决定落文件还是落目录（默认不覆盖）、`.part` 残留不搬、`localPath`/`savedPath` 改写为用户视角；搬回失败（盘满/只读/FAT32 单文件 4GB 上限）则放弃重试、保留原始输出，不假装已搬回。落盘类超时下限 5 分钟（`DOWNLOAD_TIMEOUT_MS`）。
- 配置 `~/.pi/agent/dingtalk-bridge.json`；防重发台账 `~/.pi/agent/dingtalk-bridge-sent.json`（`dedupMinutes` 默认 60）；官方 `dingtalk-*` 技能不再常驻系统提示词（`before_agent_start` 过滤，`dws_skill` 按需取回）。
- 回归测试：`node src/extensions/test/dingtalk-bridge.test.mjs`（策略层 A~AM，AM 为按需装载）、`node src/extensions/test/dingtalk-intents.test.mjs`（语义层映射 A~G）；真实联调 `dingtalk-bridge-live.mjs`。

## mimo-omni.ts（媒体兼容层，过渡件）

- 工具 `mimo_transcribe`（音频/视频 → 逐字稿，或按 prompt 解析要点/行动项/时间轴）、`mimo_speak`（文字 → wav，默认播放）；命令 `/mimo-config`（模型与音色面板）；配置 `~/.pi/agent/mimo-omni.json`；状态 key `mimo-omni`。
- 存在理由：`.pi` 消息类型只有 text/image，全模态模型的原生音频/视频输入还进不了上下文，用两个工具把能力补上；**等 pi 支持音频内容类型后这一层即可整体撤掉**。
- 格式：音频 wav/mp3/m4a/flac/ogg/aac/opus，视频 mp4/mov/avi/wmv（fps 0.1~10、media_resolution `default`/`max`）；本地文件走 base64（>45MB 提前拦截，官方上限 50MB）、公网 URL 直传。
- 解析链带模型降级 + 空正文重试（便宜档 flash 实测约半数只回思考不回正文，会自动降级到 pro；这是全模态通道的技术回退，不属「跨模型回退只给 FREE 池」纪律的范围）；解析模型声明用途 `mimo-omni.parse`（默认策略 BASE，中心设置优先于本地 config 的 model 键，两者同文件互通）；播放器候选表复用 `shared/audio-player`。
- 通道：注册表里第一个已登录的 MiMo provider（`xiaomi-token-plan-cn` → `-sgp` → `-ams` → `xiaomi`，Token Plan 优先），端点取该 provider 的 baseUrl（订阅套餐与按量付费 host 不同，`tp-` key 不能打按量付费端点）；注册表无凭证时才用 `MIMO_API_KEY`（`tp-` 前缀走套餐端点，`MIMO_BASE_URL` 可换集群）。

## time.ts

- 工具 `now()`（无参）；无命令、无状态 key。
- 机制：`context` 事件给 user 消息贴 `[YYYY-MM-DD HH:mm]` 前缀（带年，本地时区）——只改发往模型的副本，会话记录/UI 不动；详见 extensions-core.md 的 time 段（含缓存影响与边界）。

## draw/（生图：draw_image + /draw-config 面板）

- 多文件：`index.ts`（工具与命令）+ `panel.ts`（配置面板，复用 `shared/ui` 的 `createBoxRenderer` / `renderChoiceList` / `choiceKey`）。工具 `draw_image` + 命令 `/draw-config`；状态 key `draw`（priority 63）；配置 `~/.pi/agent/draw.json`（`PI_DRAW_CONFIG_FILE` 可覆盖，测试用）。
- **为什么不直接让模型用 codemode 的 `models.generateImages`**：pi 的 image 模型是**无状态工具层能力**——不进 `/model`、没有「当前生图模型」设置、没有默认值，调用时 model 必填。而 `getAvailableOfType("image")` 只保证凭证有效，不保证真能出图（实测 63 个候选里大量 403 区域限制 / 404 无端点 / 402 余额门槛），把选模型交给模型就是纯赌运气。
- **约束手段是 schema 而不是提示词**：参数里**没有** model 字段，模型只能表达意图（`tier` = draft/final），具体模型由配置决定——「选错模型」在协议层无从发生。这是本插件存在的核心理由；不要因为「顺手让调用方传 model」而破坏它。
- 解耦：只读 `ctx.modelRegistry`（`findOfType("image", provider, id)` / `generateImages`），不 import 任何插件、不读任何插件的数据文件。因此任何按 pi 协议注册的 image 模型都能用。
- 主备链：每个 tier 是一个有序 `provider/modelId` 数组，逐项尝试直到成功；失败原因逐条收集，整链失败才回 `isError`（否则「模型没注册」和「上游 402」人看着一样）。`provider/modelId` **只按第一个斜杠切**（OpenRouter 的 id 自身含斜杠，如 `bytedance-seed/seedream-5-0-pro`）。
- 返回值：默认**只回路径不附图**（附图会进会话历史、逐轮重发，参见 `img-slim`）；`preview=true` 才附图。落盘目录默认项目内 `.pi/images/`。
- 前置检查：执行前先验「tier 链首个候选是否真实注册」，不通过就直接报错并列出当前可用生图模型 + 指引（`models.json` 配 `type:"image"` 或 `/draw-config` 选模型）；不把这类问题留到生图跑完才发现。
- `/draw-config set` 会逐项校验引用必须是真实注册的 image 模型，非法引用拒绝并列出可用项。配置每次调用时重读，改完即时生效。
- **面板（`panel.ts`）自绘，不借官方 `ctx.ui.select`**：动作菜单（替换/上移/下移/移除）在面板内完成，这样 Esc 逐级返回、不可执行项能标灰注明原因（`已是首选` / `末位` / `需保留一个`），且全部可离线测试。面板只读 `deps`（getConfig/saveConfig/listModels/modelLabel 四个注入项），不认识 `ExtensionContext`——换渲染实现或做测试都不牵动入口。
- **本插件里哪些限制是上游的、哪些是本地的**（按 AGENTS.md「不对上游限制层层加码」审过一遍）：`MAX_REF_IMAGES = 3` 是**上游协议**（官方 CLI 的 image_gen 工具 schema 只有 image1/2/3）；`n`（出图张数）**不钳制**，官方 CLI 是 `n = i.n || 1` 原样透传，本地拦只会让人困惑；请求**不设本地超时**，生图慢时可能好几分钟而丢图比多等更亏，中断靠透传 `signal`；只有 `MAX_DOWNLOAD_BYTES`（64MB）与 `DOWNLOAD_TIMEOUT_MS`（60s）是本地防异常巨物/挂死的兜底，取值远高于实测（3MB / 十几秒）。
- 测试两个文件：`src/extensions/test/draw.test.mjs`（A 目录识别 / B input 拆分 / C 请求体分支 / D 错误转人话 / E 配置与主备链 / F 无模型兜底）与 `src/extensions/test/draw-panel.test.mjs`（A 总览渲染 / B 键位 / C 链条编辑 / C2 过滤 / C3 动作菜单 / C4 替换 / D 设置编辑 / E 边界，60 项）。**draw.test 必须用 `PI_DRAW_CONFIG_FILE` 指到临时目录**，否则会写脏用户真实配置（踩过）；面板测试全用桩，不碰磁盘。

## qr.ts

- 工具 `qr_encode` / `qr_decode`；命令 `/qr`；状态 key `qr`。
- 编码：图形终端渲染 PNG 真图（kitty/iTerm2 走 Image 组件），普通终端用字符绘制（可扫）：默认半块 ▀（1 cell 宽 × 半行高），**Tab 切纯背景色兼容模式**（每模块两个空格 + 24bit 背景色，零字形依赖、宽度翻倍）——字体缺 ▀ 字形的终端会把它渲染成别的符号、行列错位扫不出；`/qr` 浮层与其它扫码类浮层都转发 Tab，图形协议终端不提示切换。显示组件与编码逻辑在 `shared/qr-code.ts`（`QrCodeView` / `buildQrMatrix` / `encodeQrPngBase64`）；`save=false` 不落盘，默认落盘 `os.tmpdir()/pi-qr-<时间戳>.png`；默认 512px（128~2048 钳制）、纠错级别 M；文本超容量时失败提示带纠错建议。
- 解码：本地路径或 URL，PNG/JPEG 纯 JS（pngjs/jpeg-js/jsqr 由 build.js 内联）；支持 PNG 转 JPEG 后解码；非图片/无二维码给明确报错。图片体积上限 64MB（远高于扫描件/高分辨率照片，只防异常巨物吃满内存）：远程先看 `Content-Length`，未声明时边读边累计，超限即中断并给出裁剪/压缩指引；本地文件按 `stat` 预检。
- 会话回放安全：工具 details 只存原文，渲染时同步重新编码；`session_shutdown` 清 shared/status 的 TTL timer。
- **`qr/` 目录只是测试目录**（无 `index.ts`，build.js 不会把它当扩展入口），源码是顶层 `qr.ts`；测试 `qr/test/qr.test.mjs` 用 esbuild bundle + jiti 加载产物，14 场景 A~L（含 B2 / K2 两个兼容模式子场景）。
