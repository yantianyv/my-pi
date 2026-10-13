# install.js、构建链与 static/

## install.js（仓库根目录唯一安装入口）

单文件向导，`main()` 顺序：环境检测 → `ensurePi` → `ensureDeps`+（询问后）构建 → 安装确认 → copyDir 各目录 → `installVendor` → `removeLegacyExtensions` → `applySettings` → `installModelsJson` → `installAgentsMd` → `generateTsconfig` → `installFontFallback`（仅 Linux）→ `ensureRtk`（rtk 在最后询问下载）。
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
| `~/.config/fontconfig/conf.d/99-pi-symbols.conf` | 仅 Linux：`installFontFallback` 生成的符号字形回退规则（终端等宽字体缺的非 CJK 符号钉给 DejaVu Sans Mono）；幂等，内容不变不重写 |
| 全局 npm | pi 缺失时 `npm i -g @earendil-works/pi-coding-agent` |
| `src/node_modules/` | `ensureDeps` 按 src/package.json 清单全量比对，任一缺失即 `npm install` 补装；另查**本机平台原生可选包**（`missingNativeDeps` 按 `package-lock.json` 里带 `os`/`cpu`/`libc` 且命中本机的条目，目录缺失即算缺，如 `@esbuild/linux-arm64`）——双系统共享同一份 `node_modules` 时另一平台的包还在、本机的没有，不查会以「原生二进制平台不符」全量构建失败；`npm install` 后仍缺则按锁文件版本 `npm install --no-save <包@版本>` 点名补一次（某些 npm 版本会判定树无需变更而跳过）。补装只增不删，两平台包共存，换系统各装一次即可 |
| rtk 二进制 | 按平台下载 GitHub release（直连优先、gh-proxy 镜像回落、checksums.txt 校验）；Windows → `%APPDATA%\npm\`，Unix 优先 `~/.local/bin`，否则 `~/.pi/agent/bin` |
| `src/config/tsconfig.json` | `generateTsconfig` 探测 pi 安装目录（托管安装优先，其次 `npm root -g` + 常见全局目录候选）后逐个解析 `__PI_PKG_*` / `__PI_TYPES__` 占位符替换模板；包目录嵌套/提升两种布局都认；模板缺失或探测失败只打 log **静默跳过**（不报错） |

vendor 包若有运行时 `dependencies`：`npm install --omit=dev --no-audit --no-fund`，失败 `process.exit(1)` 中断整个安装。

### installFontFallback（Linux 符号字形回退修复）

系统等宽字体常缺块元素/几何图形（如 Ubuntu Sans Mono 只有 `█░▒▓`，没有 `▁▂▃▄▅▆▇` `▰▱` `▲▼○●`）。缺字形时 fontconfig 会回退到比例字体（DejaVu Sans）或 CJK 字体（Noto Sans CJK，字形高约 1.2em 越出格子、基线也不同），HUD 余额条 `▰▱` 与 sparkline 就会一高一矮。本步生成 fontconfig 规则把这类符号钉给 **DejaVu Sans Mono**——唯一所有字形恰好占满一格、且成对字形（`▰▱`）等高同基线的候选（Noto Sans Mono / Noto Sans Symbols2 / Noto Sans CJK 都把 `▰▱` 画成两格宽，会把进度条撑歪）。

- 覆盖集现场计算：`terminalFontFamily()` 取 gnome-terminal 专有字体（`use-system-font=false` 时）→ gsettings `monospace-font-name` → `monospace` 别名；`fc-list -f '%{charset}' ':file=<字体文件>'` 取字体覆盖范围，`pinned = (DejaVu Sans Mono ∩ 符号区) \ 终端字体`
- 符号区白名单 `FONT_SYMBOL_RANGES`：`0x2000–0x2BFF`、`0x2E00–0x2E7F`、`0x1F300–0x1FAFF`；**不含** CJK/全角/私用区（Nerd Font 图标）——它们本该由 CJK 字体渲染，钉走会丢字形或撑错宽度
- 每码点一条 `<match target="pattern">`（fontconfig 一个 match 内多个 test 是 AND、无 OR，区间无法合并，只能逐点展开）
- 跳过（只打 log 不报错）：非 Linux、无 fontconfig、终端字体已是 DejaVu Sans Mono、无待钉字符；`--dry-run` 打印条数与目标路径但不写文件
- 生效：`~/.config/fontconfig/conf.d/` 由 fontconfig 自身加载（不依赖 `/etc/fonts/fonts.conf` 的 xdg include）；运行中的终端不会重读配置，需新开窗口/标签
- 验证/回退：`fc-match 'Ubuntu Sans Mono:charset=25b0' family` 应回 `DejaVu Sans Mono`；删掉该文件即恢复系统默认回退

### pi 安装布局（托管安装 vs npm 全局）

pi 用自带安装器时为**托管安装**（releases-v1）：`<agent>/install/` 下 `managed-install.json` + `current-version` + `releases/<版本>/node_modules`（依赖提升到这一层），启动器 `<agent>/bin/pi` 导出 `PI_MANAGED_INSTALL_ROOT`；`pi update` 只改 `current-version` 与 releases（保留新旧两个版本）。此时 `npm root -g` 里没有 pi。

仓库里探测 pi 安装位置的地方共四处，逻辑一致（nested → hoisted、托管 → npm 全局）：install.js（CJS，自带内联实现）与 `static/patches/pi-root.mjs`（ESM，供三个补丁脚本 + `src/extensions/test/relink-deps.mjs` import）。


## src/build.js（伪编译）

- 入口发现规则：`src/extensions/` 下**顶层 `*.ts`** 直接作单文件扩展；**子目录**只有含 `index.ts`（或 `index.js`）才作多文件扩展，产物名 = 目录名 + `.ts`（`hud/` → `hud.ts`）。
- `src/extensions/qr/` 里只有 `test/`、没有 `index.ts`，所以它**不是扩展入口**（源码是顶层 `qr.ts`），不会被重复打包。
- 输出 `dist/extensions/`，esbuild `bundle: true`，external 白名单只有 `@earendil-works/*` 与 `typebox`，其余 npm 依赖（turndown/domino/gfm、qrcode/jsqr/pngjs/jpeg-js）内联进单文件 → 产物零外部依赖、运行时零安装。
- **必须用 `src/config/tsconfig.build.json`（无 `paths`）**：主 tsconfig 的 `paths` 会把包名解析成 pi 全局绝对路径，破坏 external 包名匹配、意外内联 typebox。
- 静态资源不经本脚本；`install.js` 会调用它，也可 `node src/build.js` 单跑。
- 构建失败分两路报错：esbuild 编译诊断（`err.errors`）逐条打印；原生依赖平台不符等**非编译错误**（`err.errors` 为空）走 `reportNonCompileError` 打印 `err.message` 首行 + 针对性提示，且同一句只提示一次（平台不符会让 21 个入口以同一原因失败，逐条重复会淹没提示）。

## static/（无需编译，install.js 直接部署）

| 项 | 内容 |
|---|---|
| `AGENTS.md` | 全局输出受众纪律（解释进对话 / 注释不记变更史 / 文案受众自查），标记块方式并入 `~/.pi/agent/AGENTS.md` |
| `themes/matrix.json` | 黑客帝国荧光绿主题（`vars` + `colors`），install.js 把它设为默认 `settings.json.theme = "matrix"` |
| `sounds/*.wav` | 5 个音效，**只服务 status-beacon**：`task_complete`（正常结束）/`error`（出错）/`attention`（等待人工：问卷、权限复核）/`idle_prompt`（完成提醒后 60s 无操作补一声）/`subagent_complete`（explore/subagent/Task 工具成功）。音源 ClaudeCodeInit wav/piano；播放走系统播放器（Windows SoundPlayer / afplay / paplay→aplay，全不可用退终端响铃） |
| `skills/markitdown/SKILL.md` | 微软 MarkItDown（MIT，Python 3.10+）文档转 Markdown skill，装到 `~/.pi/agent/skills/`；skill 本身不预装工具，规定 AI 每次先 `markitdown --version`，缺失自行 `pip install 'markitdown[all]'` |
| `models.json` | OpenRouter 路由模板（`providers.openrouter.compat.openRouterRouting`）+ 自定义 provider `volcengine-coding`（Coding Plan OpenAI 兼容端点 `/api/coding/v3`，ark-code-latest + doubao/deepseek/kimi/glm/minimax 常用档）+ `sensenova`（token-plan 端点，含 thinkingLevelMap）；深度合并，`models` 数组以模板为准 |
| `patches/` | 3 个手工补丁脚本，**install.js 不会执行**，pi 升级后需重跑 |

## vendor

收录原则/出处表/对齐更新流程/回退记录全在 `src/vendor/README.md`（改 vendor 前必读）。当前只有 `pi-rtk-optimizer`（输出压缩 + rtk 命令改写；无 rtk 二进制时自动旁路，仅压缩生效）；兼容性：它不动 footer、setStatus 键与自研扩展不冲突。收录版本固定，不参与 `pi update --extensions`（升级靠手动）。

## static/patches/ 三个补丁

共用 `pi-root.mjs` 定位 pi 安装目录（托管安装 / npm 全局，见上文），补丁目标一律是**当前活动安装**：托管安装为 `~/.pi/agent/install/releases/<版本>/node_modules/...` 与启动器 `~/.pi/agent/bin/pi`；npm 全局为 `npm root -g` 与全局 bin。

| 脚本 | 作用 | 写入位置 | 参数 / 幂等 |
|---|---|---|---|
| `apply-pi-ai-usage-guard.mjs` | pi-ai `dist/utils/estimate.js` 的 `calculateContextTokens` 对缺 usage 的消息抛 TypeError（模型偶发无文字回答会导致后续调用瞬时失败）；顺带把 `dist/api/anthropic-messages.js` 的 `message_start` usage 解析改可选链 | 活动安装的 `@earendil-works/pi-ai/dist/`（原地 patch） | 无参数；源码含 `PATCH(usage-guard)` 标记即跳过；目标旧串匹配不上 `exit(1)` 拒绝执行 |
| `apply-zuchongzhi-zh.mjs` | 祖冲之汉化：直接替换 pi 全局 dist 编译产物里硬编码的英文 UI 文案（`dist/modes/interactive/` 10 个文件 + `pi-tui` 的 settings-list + `dist/bundle/chunks/*.js` 并集，仅带引号条目扩散到压缩产物） | 同上（dist 与 pi-tui dist） | `--dry-run`/`-n`、`--restore`（从 `~/.pi/agent/tmp/zuchongzhi/backup/` 还原，还原前校验 `version.json` 的 pi 版本戳，不符拒绝）；`state.json` 记 SHA256，pi 升级哈希变化 → 自动废弃旧备份、重新备份重打；写盘前 `node --check` 语法校验。处数口径以脚本实跑输出为准（文档里的数字已过时） |
| `apply-pi-launch-report.mjs` | 启动垫片取证 v2：给 pi 启动器注入 `--max-old-space-size=8192 --report-on-fatalerror --report-directory=~/.pi/agent/reports`、stderr 追加落盘 `~/.pi/agent/pi-stderr.log`、记 `[START]/[EXIT]`。托管安装的 `pi-launcher.js`（Windows 的 `pi.cmd`/`pi.ps1` 与部分布局的 `pi` sh 都只是转发到它）在 spawnSync 的 node 旗标位前插取证旗标 + stderr 落盘；托管安装 `<agent>/bin/pi` sh 在调用行前 export NODE_OPTIONS、行尾 `2>>` 重定向、去掉 `exec` 以便记退出码；npm 侧 Windows `pi.cmd`/`pi.ps1`，POSIX 旧式 sh 垫片走 NODE_OPTIONS（cmd 因 SETLOCAL 回收环境变量改为调用行内联 node 旗标）；npm 11 起 POSIX 全局 bin 是符号链接（pi → 包内 ESM 垫片），补丁把它改写为 spawn wrapper 拉起 `cli-runtime.js` + 信号/退出码转发 + 保留 NODE_COMPILE_CACHE | pi 启动器（实际在用 / 托管 / npm 全局里第一个存在的启动器目录；**不写 node_modules**），并建 `~/.pi/agent/reports` | 无参数；含 `PI-CRASH-FORENSICS` 标记跳过；每次运行先 strip 旧注入；注入失败（启动器形态不认识）只警告不写盘；薄转发垫片（内容含 `pi-launcher.js`）不报错、只提示取证由其承担；崩溃取证史见文件头注释（不写入本文档） |

## pi 升级收尾清单

触发：`pi update` / `npm i -g`（或换机器）——它会重写 pi 自身 dist、启动器与 node_modules，而**这三样正是本仓库的下游**。逐项重做，别只跑其中一个。

**1. 重建、重装、重生成**

```bash
node install.js -y                                    # 重建 dist + 重装 + 重生成 src/config/tsconfig.json
grep -o "releases/[0-9.]*" src/config/tsconfig.json   # 指向的版本应是新装的那个
node src/extensions/test/relink-deps.mjs              # 测试依赖副本换成新 pi（依赖树踩坑见 tests.md）
cd src && npm run typecheck                           # 对新 pi 的 .d.ts 应为 0 报错，报错即扩展用到了变动的 API
```

然后是 35 个回归测试（无 runner，逐个跑）：

```bash
for f in $(ls src/extensions/*/test/*.test.mjs src/extensions/test/*.test.mjs | sort -u); do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
```

**2. 三个补丁（`install.js` 不代跑）**

```bash
node static/patches/apply-pi-ai-usage-guard.mjs
node static/patches/apply-zuchongzhi-zh.mjs
node static/patches/apply-pi-launch-report.mjs
```

看什么算成功：usage-guard 看 `PATCH(usage-guard)` 标记或“已应用”；祖冲之看末尾的“未找到目标串”告警——**有告警说明 pi 改了该文案，要同步补丁表**（正常现象，不清就会留一句英文）；启动垫片看“共补丁 N 个垫片”，托管安装在 Windows 下应为 `1`（`pi-launcher.js`），报**0** 就是启动器形态又变了，需适配（垫片形态与各分支见上表）。补丁改的是 pi 自身 dist，**生效要重启 pi，`/reload` 不够**。

**3. 主题与配置 schema**

pi 在启动期也会校验主题（内置主题不校验），改主题后用 pi 自带的校验器验一遍（比对比对 schema 键名更真）：

```bash
cd ~/.pi/agent/install/releases/<版本>/node_modules && node --input-type=module -e "
import { validateThemeJson } from './@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.js';
import fs from 'node:fs';
validateThemeJson('matrix', JSON.parse(fs.readFileSync(process.env.USERPROFILE + '/.pi/agent/themes/matrix.json', 'utf8')));
console.log('主题校验通过');"
```

主题 `$schema` 指向 `https://pi.dev/schemas/theme.schema.json`（旧的 GitHub raw 路径已废弃）。`settings.json` / `models.json` 的 schema 只服务编辑器提示，用户文件里多出的键不会导致启动失败（两个 schema 都没开 `additionalProperties: false`）。

**4. 新版本 breaking change 与扩展的对照**

```bash
cd ~/.pi/agent/install/releases && diff -u <旧>/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts <新>/.../index.d.ts | head -60
```

顶层导出的增减就是扩展能碰到的 API 面；再读新版本 `CHANGELOG.md` 的 Breaking Changes 段逐条落到扩展的事件/API 用法上。历史上真影响过本仓库的点：`before_agent_start` 事件对象变成 `messageType` 联合并对 `sendMessage({triggerTurn:true})` 触发的 run 也触发（只读 `systemPrompt`/`systemPromptOptions` 的 handler 无需改）；运行启动期即算 busy（`ctx.isIdle()` 此时为 false、`pi.sendUserMessage()` 需 `deliverAs`）；`tool_result` 改写 content 必须透传 `structuredContent`；主题 schema 迁移与启动期校验。

**5. 汉化覆盖自查（可选，用祖冲之脚本的数据）**

拿旧版与新版的 interactive dist 对比引号字符串差集，只挑含空格的句子（`"[A-Z][A-Za-z0-9 ,.'\`\-/()%:•→…]{14,110}"` 这类启发式），剔除只在主题 schema 里当描述的条目（除非 pi 新开了主题编辑 UI，这些不需要译）——1.2.0 新增的 62 条里 60 条属此类，只有 `Show hardware cursor` 的描述变了需要换表。

---

三个补丁都与渲染模式无关；`fullscreen` 渲染已是定稿默认，旧的滚动冻结补丁（apply-pi-tui-scroll-freeze.mjs）已随定稿移除。pi 升级（`pi update` / `npm i -g`）会重写 dist 与启动器，故都需重跑（祖冲之脚本重跑即自动收敛）。
