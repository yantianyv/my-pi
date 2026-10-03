# install.js、构建链与 static/

## install.js（仓库根目录唯一安装入口）

单文件向导，`main()` 顺序：环境检测 → `ensurePi` → `ensureDeps`+（询问后）构建 → 安装确认 → copyDir 各目录 → `installVendor` → `removeLegacyExtensions` → `applySettings` → `installModelsJson` → `installAgentsMd` → `generateTsconfig` → `ensureRtk`（rtk 在最后询问下载）。
所有写操作都有 `dryRun` 守卫；`confirm()` 在 `--dry-run` / `-y` / 非 TTY 三态下短路为默认值。

CLI 参数（仅 4 个）：`--dry-run`/`-n`、`--skip-build`、`-y`/`--yes`（非 TTY 自动等价）、（无位置参数）。`ROOT = __dirname`，任意目录下 `node <绝对路径>/install.js` 均可。

**会写入/删除的用户全局位置**（跑 `--dry-run` 预览）：

| 位置 | 行为 |
|---|---|
| `~/.pi/agent/extensions/` | 复制 dist 产物；**删除** `LEGACY_REMOVED_EXTENSIONS` 名单里的历史扩展（explore-agent/token-saver/webui/paste-image/task-alert/btf-think/mimo-media 的 stale 副本） |
| `~/.pi/agent/themes/`、`sounds/`、`skills/` | 复制 static 对应目录；copyDir 带扩展名白名单（themes/extensions = `.json`+`.ts`，sounds = `.wav`，skills = `.md`，递归且跳过 node_modules） |
| `~/.pi/agent/vendor/` | 复制 src/vendor 各包；`settings.json.packages` 注册本地路径；**注销**已移除包时连目录一起 `rmSync` 删除 |
| `~/.pi/agent/settings.json` | `applySettings` 写 `theme="matrix"` 与 `hideThinkingBlock=true`（硬置）；`registerVendorPackages` 写 `packages` |
| `~/.pi/agent/models.json` | 不存在则写模板；存在则 `deepMerge(existing, repo)`（模板键为 override、只增不删，保留用户手改的其他 provider）；**用户文件 JSON 解析失败会用仓库模板覆盖**，坏内容丢失 |
| `~/.pi/agent/AGENTS.md` | static/AGENTS.md 包进 `<!-- my_pi:begin -->…<!-- my_pi:end -->` 标记块写入；块外用户手写内容保留；已有无标记块文件时交互询问追加（`-y` 默认追加） |
| 全局 npm | pi 缺失时 `npm i -g @earendil-works/pi-coding-agent` |
| `src/node_modules/` | `ensureDeps` 按 src/package.json 清单全量比对，任一缺失即 `npm install` |
| rtk 二进制 | 按平台下载 GitHub release（直连优先、gh-proxy 镜像回落、checksums.txt 校验）；Windows → `%APPDATA%\npm\`，Unix 优先 `~/.local/bin`，否则 `~/.pi/agent/bin` |
| `src/config/tsconfig.json` | `generateTsconfig` 探测 `npm root -g` 替换模板 `__PI_ROOT__`；模板缺失或探测失败只打 log **静默跳过**（不报错） |

vendor 包若有运行时 `dependencies`：`npm install --omit=dev --no-audit --no-fund`，失败 `process.exit(1)` 中断整个安装。

## src/build.js（伪编译）

- 入口发现规则：`src/extensions/` 下**顶层 `*.ts`** 直接作单文件扩展；**子目录**只有含 `index.ts`（或 `index.js`）才作多文件扩展，产物名 = 目录名 + `.ts`（`hud/` → `hud.ts`）。
- `src/extensions/qr/` 里只有 `test/`、没有 `index.ts`，所以它**不是扩展入口**（源码是顶层 `qr.ts`），不会被重复打包。
- 输出 `dist/extensions/`，esbuild `bundle: true`，external 白名单只有 `@earendil-works/*` 与 `typebox`，其余 npm 依赖（turndown/domino/gfm、qrcode/jsqr/pngjs/jpeg-js）内联进单文件 → 产物零外部依赖、运行时零安装。
- **必须用 `src/config/tsconfig.build.json`（无 `paths`）**：主 tsconfig 的 `paths` 会把包名解析成 pi 全局绝对路径，破坏 external 包名匹配、意外内联 typebox。
- 静态资源不经本脚本；`install.js` 会调用它，也可 `node src/build.js` 单跑。

## static/（无需编译，install.js 直接部署）

| 项 | 内容 |
|---|---|
| `AGENTS.md` | 全局输出受众纪律（解释进对话 / 注释不记变更史 / 文案受众自查），标记块方式并入 `~/.pi/agent/AGENTS.md` |
| `themes/matrix.json` | 黑客帝国荧光绿主题（`vars` + `colors`），install.js 把它设为默认 `settings.json.theme = "matrix"` |
| `sounds/*.wav` | 5 个音效，**只服务 status-beacon**：`task_complete`（正常结束）/`error`（出错）/`attention`（等待人工：问卷、权限复核）/`idle_prompt`（完成提醒后 60s 无操作补一声）/`subagent_complete`（explore/subagent/Task 工具成功）。音源 ClaudeCodeInit wav/piano；播放走系统播放器（Windows SoundPlayer / afplay / paplay→aplay，全不可用退终端响铃） |
| `skills/markitdown/SKILL.md` | 微软 MarkItDown（MIT，Python 3.10+）文档转 Markdown skill，装到 `~/.pi/agent/skills/`；skill 本身不预装工具，规定 AI 每次先 `markitdown --version`，缺失自行 `pip install 'markitdown[all]'` |
| `models.json` | OpenRouter 路由模板（`providers.openrouter.compat.openRouterRouting`）+ 自定义 provider `volcengine-coding`（ark-code-latest / deepseek-v4-flash / pro，含 modelOverrides thinkingFormat）+ `sensenova`（含 thinkingLevelMap） |
| `patches/` | 3 个手工补丁脚本，**install.js 不会执行**，pi 升级后需重跑 |

## vendor

收录原则/出处表/对齐更新流程/回退记录全在 `src/vendor/README.md`（改 vendor 前必读）。当前只有 `pi-rtk-optimizer`（输出压缩 + rtk 命令改写；无 rtk 二进制时自动旁路，仅压缩生效）；兼容性：它不动 footer、setStatus 键与自研扩展不冲突。收录版本固定，不参与 `pi update --extensions`（升级靠手动）。

## static/patches/ 三个补丁

| 脚本 | 作用 | 写入位置 | 参数 / 幂等 |
|---|---|---|---|
| `apply-pi-ai-usage-guard.mjs` | pi-ai `dist/utils/estimate.js` 的 `calculateContextTokens` 对缺 usage 的消息抛 TypeError（模型偶发无文字回答会导致后续调用瞬时失败）；顺带把 `dist/api/anthropic-messages.js` 的 `message_start` usage 解析改可选链 | 全局 `node_modules/@earendil-works/pi-ai/dist/`（原地 patch） | 无参数；源码含 `PATCH(usage-guard)` 标记即跳过；目标旧串匹配不上 `exit(1)` 拒绝执行 |
| `apply-zuchongzhi-zh.mjs` | 祖冲之汉化：直接替换 pi 全局 dist 编译产物里硬编码的英文 UI 文案（`dist/modes/interactive/` 10 个文件 + `pi-tui` 的 settings-list + `dist/bundle/chunks/*.js` 并集，仅带引号条目扩散到压缩产物） | 同上（dist 与 pi-tui dist） | `--dry-run`/`-n`、`--restore`（从 `~/.pi/agent/tmp/zuchongzhi/backup/` 还原，还原前校验 `version.json` 的 pi 版本戳，不符拒绝）；`state.json` 记 SHA256，pi 升级哈希变化 → 自动废弃旧备份、重新备份重打；写盘前 `node --check` 语法校验。处数口径以脚本实跑输出为准（文档里的数字已过时） |
| `apply-pi-launch-report.mjs` | 启动垫片取证 v2：给 npm 的 pi 启动垫片注入 `--max-old-space-size=8192 --report-on-fatalerror --report-directory=~/.pi/agent/reports`、stderr 追加落盘 `~/.pi/agent/pi-stderr.log`、ps1 记 `[START]/[EXIT]`。Windows `pi.cmd`/`pi.ps1`；POSIX 旧式 sh 垫片走 NODE_OPTIONS（cmd 因 SETLOCAL 回收环境变量改为调用行内联 node 旗标）；npm 11 起 POSIX 全局 bin 是符号链接（pi → 包内 ESM 垫片），补丁把它改写为 spawn wrapper 拉起 `cli-runtime.js` + 信号/退出码转发 + 保留 NODE_COMPILE_CACHE | npm 全局 bin 垫片（**不写 node_modules**），并建 `~/.pi/agent/reports` | 无参数；含 `PI-CRASH-FORENSICS` 标记跳过；每次运行先 strip 旧 v1 注入；崩溃取证史见文件头注释（不写入本文档） |

三个补丁都与渲染模式无关；`fullscreen` 渲染已是定稿默认，旧的滚动冻结补丁（`apply-pi-tui-scroll-freeze.mjs`）已随定稿移除。pi 升级（`npm i -g`）会覆盖 dist/垫片，故都需重跑（祖冲之脚本重跑即自动收敛）。
