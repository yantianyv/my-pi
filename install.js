#!/usr/bin/env node
/**
 * pi 一键环境安装脚本（交互式向导）
 *
 * 新设备拿到本仓库后，一条命令即可完成「pi 本体 + 定制配置」的完整部署：
 *   1. 检测 node 版本（pi 要求 ≥22.19.0）：当前 shell 的 node 低于要求、而 pi 托管安装自带的
 *      node 满足要求时，改用后者重跑本脚本（见 reexecUnderManagedNode）；两者都不行才只警告不阻塞
 *   2. 检测 pi 本体（@earendil-works/pi-coding-agent），缺失则自动 npm i -g
 *   3. 检测构建依赖（src/package.json 声明清单 vs src/node_modules 实况全量比对，不只查 esbuild），缺失则自动 npm install（src/ 下）
 *   4. 自动构建扩展产物（src/build.js → dist/extensions/）
 *   5. 安装配置到 ~/.pi/agent/（扩展/主题/提示音/skills/models.json/settings）；
 *      Linux 上另生成 ~/.config/fontconfig/conf.d/99-pi-symbols.conf（符号字形回退修复，见 installFontFallback）
 *   6. 可选依赖 rtk 二进制（pi-rtk-optimizer 的命令改写引擎）：PATH 上缺失时询问并自动
 *      下载安装（按平台选 release 资产，GitHub 直连优先、加速镜像回落，checksums.txt 校验；
 *      失败不阻塞安装，插件侧安全降级）
 *   7. 安装 vendor 第三方插件（src/vendor/ → ~/.pi/agent/vendor/，有依赖的补 npm install，
 *      并把本地路径注册进 settings.json 的 packages）；清理已被官方版替代的旧扩展文件
 *   8. 复杂外部依赖（static/deps.json）：装不起 skill、要 CLI + MCP + 自带 skill 的那类第三方工具
 *      （如 REA 逆向分析），逐项确认后 npm 全局安装 → 复制自带 skill → 按 codemode 曝光注册进 mcp.json
 *   9. 重打 static/patches/ 的四个 pi 补丁（音频输入 / usage 防护 / 祖冲之汉化 / 启动垫片取证；
 *      脚本各自幂等，单个失败只告警不阻塞——补丁是增强，缺了 pi 照用；pi 升级会重写 dist 与启动器，
 *      故每次安装重打）
 *
 * 安装到 pi 全局配置目录：
 *   dist/extensions/   → ~/.pi/agent/extensions/  （扩展产物，零耦合单文件）
 *   src/vendor/        → ~/.pi/agent/vendor/      （官方插件源码副本，见 src/vendor/README.md）
 *   static/themes/     → ~/.pi/agent/themes/      （主题）
 *   static/sounds/     → ~/.pi/agent/sounds/      （提示音）
 *   static/skills/     → ~/.pi/agent/skills/      （pi skills：目录含 SKILL.md 被递归发现）
 *   static/models.json → ~/.pi/agent/models.json  （OpenRouter 路由等模型配置，已存在则深度合并）
 *   static/AGENTS.md   → ~/.pi/agent/AGENTS.md    （全局输出受众纪律：标记块合并，块外用户手写内容保留）
 *   static/deps.json  → 读取执行，不复制文件（复杂外部依赖清单，见上第 8 步）
 * 并把 settings.json 的 theme 设为本项目主题。
 *
 * Linux 额外一步（installFontFallback）：生成 fontconfig 规则，把系统等宽字体缺的非 CJK 符号
 * （块元素/几何图形/箭头等）钉给 DejaVu Sans Mono，避免回退到比例字体或 CJK 字体后字形高度不一。
 *
 * 用法：
 *   node install.js               交互式安装（每一步询问确认，默认 yes）
 *   node install.js -y            非交互安装（全部默认 yes，一路到底；非 TTY 环境自动等价）
 *   node install.js --dry-run     试运行（预览，不询问、不修改任何文件）
 *   node install.js --skip-build  跳过自动构建
 *
 * npm 源：默认源拉取失败时询问一次是否换镜像源（npmmirror）重试，只给本脚本的 npm 命令加
 * --registry 参数，不改用户的全局 npm 配置；换源后本次安装后续的 npm 调用直接沿用。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn, spawnSync } = require("child_process");
const readline = require("node:readline");

const ROOT = __dirname;
const PI_AGENT = path.join(os.homedir(), ".pi", "agent");
// 扩展产物只认 build.js 的输出（dist/extensions/）；静态资源直接从仓库 static/ 安装（无需编译）
const DIST = path.join(ROOT, "dist");
const BUILD_SCRIPT = path.join(ROOT, "src", "build.js");
const THEMES_SRC = path.join(ROOT, "static", "themes");
const EXT_SRC = path.join(DIST, "extensions");
const SOUNDS_SRC = path.join(ROOT, "static", "sounds");
const SKILLS_SRC = path.join(ROOT, "static", "skills");
const MODELS_SRC = path.join(ROOT, "static", "models.json");
const DEPS_SRC = path.join(ROOT, "static", "deps.json");
const AGENTS_SRC = path.join(ROOT, "static", "AGENTS.md");
const VENDOR_SRC = path.join(ROOT, "src", "vendor");
const THEMES_DST = path.join(PI_AGENT, "themes");
const EXT_DST = path.join(PI_AGENT, "extensions");
/** 扩展的附属资源（不参与编译、但运行时必须就位）：目前只有 computer-use 的
 *  platform/（桌面宿主脚本）与 model/（ONNX 检测权重）。产物目录名 → 源目录。 */
const EXT_ASSETS = {
	"computer-use": ["platform", "model"],
};
const SOUNDS_DST = path.join(PI_AGENT, "sounds");
const SKILLS_DST = path.join(PI_AGENT, "skills");
const VENDOR_DST = path.join(PI_AGENT, "vendor");
const MCP_CONFIG = path.join(PI_AGENT, "mcp.json");
// agentskills.io 标准的用户级 skill 目录：pi 与第三方工具（REA 等）共同识别，装这里两边都能发现
const AGENTS_SKILLS_DST = path.join(os.homedir(), ".agents", "skills");

// src/extensions/ 已不存在的扩展：install 时清理已安装的 stale 副本，避免与 vendor 版命令/工具冲突
const LEGACY_REMOVED_EXTENSIONS = ["explore-agent.ts", "token-saver.ts", "webui.ts", "paste-image.ts", "task-alert.ts", "btf-think.ts", "mimo-media.ts"];

// pi 安装产物补丁（static/patches/，不进构建）：pi 升级会重写 dist 与启动器，每次安装重打一遍
const PATCH_SCRIPTS = [
	"apply-pi-audio-input.mjs",
	"apply-pi-ai-usage-guard.mjs",
	"apply-zuchongzhi-zh.mjs",
	"apply-pi-launch-report.mjs",
];

// ── 字体回退修复（仅 Linux）──
// 系统等宽字体（如 Ubuntu Sans Mono）只有 █░▒▓ 四个块元素，sparkline 的 ▁▂▃▄▅▆▇、余额条的 ▰▱、
// ▲▼○● 等都要回退：fontconfig 会挑中比例字体（DejaVu Sans）或 CJK 字体（Noto Sans CJK），
// 后者字形高 1.2em 越格、前者与后者基线也不同，于是同一条进度条里实心/空心一高一矮。
// 这里生成 per-codepoint 规则，把「等宽字体缺、回退字体有」的非 CJK 符号钉给 DejaVu Sans Mono——
// 实测唯一所有字形都恰好占满一格、且成对字形（▰▱）等高同基线的候选。
const FONTCONF_DST = path.join(os.homedir(), ".config", "fontconfig", "conf.d", "99-pi-symbols.conf");
const FONT_FALLBACK_FAMILY = "DejaVu Sans Mono";
// 覆盖范围：终端与 pi 界面会用到的非 CJK 符号区。CJK 汉字/标点、全角区、私用区（Nerd Font 图标）
// 不在内——它们本该由 CJK 字体渲染，钉给 DejaVu Sans Mono 反而会丢字形或撑错宽度。
const FONT_SYMBOL_RANGES = [[0x2000, 0x2bff], [0x2e00, 0x2e7f], [0x1f300, 0x1faff]];

const THEME_NAME = "matrix"; // 默认启用的主题（对应 static/themes/matrix.json）
const PI_PACKAGE = "@earendil-works/pi-coding-agent"; // pi 本体包名
const NODE_MIN = "22.19.0"; // pi 要求的最低 node 版本（package.json engines）
const NODE_EXE = process.platform === "win32" ? "node.exe" : "node";

// ── npm 镜像源：默认源拉取失败时询问是否换镜像重试（只作用于本脚本的 npm 调用，
//    不改用户的全局 npm 配置——换源影响面比安装本身大，不该由安装脚本替人决定）──
const NPM_DEFAULT_REGISTRY = "https://registry.npmjs.org";
const NPM_MIRROR = "https://registry.npmmirror.com";
// 本次安装已切到镜像源时追加到每条 npm 命令后的参数（空串 = 仍用默认源）
let npmRegistryArg = "";
// 换源只问一次：后到的失败同属一个网络问题，反复弹窗只会拦住安装
let mirrorOffered = false;

// ── rtk（可选依赖）：pi-rtk-optimizer 的命令改写引擎（rtk-ai/rtk，Apache-2.0，单 Rust 二进制），
//    缺失时插件自动旁路改写仅留输出压缩（安全降级），故本步失败不阻塞安装、拒绝也不中断 ──
const RTK_VERSION = "v0.48.0"; // release tag；升级改这里（https://github.com/rtk-ai/rtk/releases）
const RTK_REPO = "rtk-ai/rtk";
const RTK_PROXY = "https://gh-proxy.com/"; // GitHub 直连失败时的下载加速镜像（前置前缀式，置空禁用）
// process.platform + process.arch → release 资产名映射（零硬编码环境：运行时现场探测；rtk 出新平台资产时在此加一行）
const RTK_ASSETS = {
	"win32|x64": "rtk-x86_64-pc-windows-msvc.zip",
	"darwin|arm64": "rtk-aarch64-apple-darwin.tar.gz",
	"darwin|x64": "rtk-x86_64-apple-darwin.tar.gz",
	"linux|x64": "rtk-x86_64-unknown-linux-musl.tar.gz", // musl 静态链接，任意发行版免依赖
	"linux|arm64": "rtk-aarch64-unknown-linux-gnu.tar.gz", // 该平台无 musl 产物
};

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const skipBuild = process.argv.includes("--skip-build");
const nonInteractive = process.argv.includes("-y") || process.argv.includes("--yes");
const log = (...m) => console.log((dryRun ? "[DRY-RUN] " : "") + m.join(" "));

const SRC_DIR = path.join(ROOT, "src");
const ESBUILD_DIR = path.join(SRC_DIR, "node_modules", "esbuild");
const crypto = require("crypto");

// 全局 npm 安装失败（EACCES/EPERM）时回落到用户级前缀：与 PATH 上已有的 ~/.local/bin 天然一致，不需要 sudo
const USER_NPM_PREFIX = path.join(os.homedir(), ".local");
let userNpmPrefixActive = false;

/** 统一确认：非交互（-y / 非 TTY）/ dry-run 直接返回默认值；否则 readline 询问。 */
function confirm(question, { defaultYes = true } = {}) {
	if (nonInteractive || dryRun || !process.stdin.isTTY) return Promise.resolve(defaultYes);
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			const a = answer.trim().toLowerCase();
			resolve(defaultYes ? !a.startsWith("n") : a.startsWith("y"));
		});
	});
}

/** 跑一条 npm 命令（走 shell，与既有风格一致：spawnSync 直接调 npm.cmd 在 Node 24 会 EINVAL）。
 *  输出实时透传，同时累积起来给调用方判断失败原因（权限/网络）。返回 { ok, output }。 */
function npmExec(cmd, { cwd } = {}) {
	return new Promise((resolve) => {
		const child = spawn(cmd + npmRegistryArg, {
			cwd,
			shell: true,
			env: userNpmPrefixActive ? { ...process.env, npm_config_prefix: USER_NPM_PREFIX } : process.env,
		});
		let output = "";
		child.stdout.on("data", (d) => {
			output += d;
			process.stdout.write(d);
		});
		child.stderr.on("data", (d) => {
			output += d;
			process.stderr.write(d);
		});
		child.on("error", (e) => resolve({ ok: false, output: output + (e.message ?? "") }));
		child.on("close", (code) => resolve({ ok: code === 0, output }));
	});
}

/** 跑一条 npm 命令；失败时询问一次是否换成镜像源重试，已切镜像后不再重复询问。
 *  权限类失败不问镜像（换源救不了），交给 npmInstallGlobal 处理。 */
async function npmRun(cmd, opts) {
	const first = await npmExec(cmd, opts);
	if (first.ok || npmRegistryArg || mirrorOffered || isPermissionDenied(first.output)) return first;
	mirrorOffered = true;
	console.error(`\n⚠ ${cmd} 失败（默认源 ${NPM_DEFAULT_REGISTRY} 不可达或超时）`);
	if (!(await confirm(`  是否换用镜像源 ${NPM_MIRROR} 重试？（只影响本次安装，不改你的全局 npm 配置）（Y/n）`))) return first;
	npmRegistryArg = ` --registry=${NPM_MIRROR}`;
	log(`改用镜像源重试：${cmd}`);
	return npmExec(cmd, opts);
}

/** 该 node 版本号是否满足 pi 要求。 */
function meetsNodeMin(version) {
	const want = NODE_MIN.split(".").map(Number);
	const got = version.replace(/^v/, "").split(".").map(Number);
	if (!Number.isFinite(got[0])) return false; // 探测不出真实版本（空串/非版本号）按不满足算
	for (let i = 0; i < want.length; i++) {
		const g = got[i] ?? 0;
		if (g > want[i]) return true;
		if (g < want[i]) return false;
	}
	return true;
}

/** 检测 node 版本是否满足 pi 要求（过低仅返回 ok:false 供警告，不阻塞安装）。 */
function checkNode() {
	return { ok: meetsNodeMin(process.versions.node), version: process.versions.node };
}

/** pi 自带安装器装的 node 的 bin 目录（<数据目录>/pi-node/current/bin，pi 启动器正是把这个目录
 *  插到 PATH 最前，pi 本体就是用它跑的）；没有则返回 null。
 *  数据目录依次试：PI_NODE_DATA_DIR、XDG_DATA_HOME、~/.local/share（Linux）、~/Library/Application Support
 *  （macOS）、%LOCALAPPDATA% / %APPDATA%（Windows）。current 下也可能直接放可执行文件，两种都认。 */
function managedNodeBin() {
	const dataDirs = [
		process.env.PI_NODE_DATA_DIR,
		process.env.XDG_DATA_HOME,
		path.join(os.homedir(), ".local", "share"),
		path.join(os.homedir(), "Library", "Application Support"),
		process.env.LOCALAPPDATA,
		process.env.APPDATA,
	].filter(Boolean);
	for (const dir of dataDirs) {
		for (const bin of [path.join(dir, "pi-node", "current", "bin"), path.join(dir, "pi-node", "current")]) {
			if (fs.existsSync(path.join(bin, NODE_EXE))) return bin;
		}
	}
	return null;
}

/** 当前 shell 的 node 太旧（低于 pi 要求）而 pi 托管安装自带满足要求的 node 时，改用后者重跑本脚本。
 *  不换的真正代价不只是版本号：那套 npm 的全局前缀往往不可写（EACCES）、engine 检查也全按旧 node
 *  判定（第三方依赖 EBADENGINE 警告后继续装，装出来的东西跑不起来），换一次就把整串失败一起消掉。
 *  已在托管 node 下运行时由 PI_INSTALL_REEXEC 标记拦住，不会反复重入。 */
function reexecUnderManagedNode() {
	if (process.env.PI_INSTALL_REEXEC || checkNode().ok) return;
	const bin = managedNodeBin();
	if (!bin || path.resolve(bin) === path.dirname(process.execPath)) return;
	const exe = path.join(bin, NODE_EXE);
	const probe = spawnSync(exe, ["-v"], { encoding: "utf8", windowsHide: true });
	const version = (probe.stdout ?? "").trim();
	if (!meetsNodeMin(version)) return;
	console.log(`改用 pi 自带的 node ${version} 继续（当前 shell 的 node ${process.versions.node} 低于 pi 要求 ≥ ${NODE_MIN}）\n`);
	const child = spawnSync(exe, [__filename, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PI_INSTALL_REEXEC: "1" },
	});
	if (child.error) {
		console.error(`⚠ 用 ${exe} 重跑失败（${child.error.message}），继续用当前 node。`);
		return;
	}
	process.exit(child.signal ? 1 : (child.status ?? 0));
}

/** pi 自带安装器的托管安装根（releases-v1 布局）：PI_MANAGED_INSTALL_ROOT 优先，
 *  其次由 pi 启动器位置反推（<agent>/bin/pi 的兄弟目录 install/）。*/
function managedInstallRoot() {
	const candidates = [process.env.PI_MANAGED_INSTALL_ROOT];
	try {
		const launcher = execSync(process.platform === "win32" ? "where pi" : "command -v pi", { encoding: "utf8", windowsHide: true })
			.trim()
			.split(/\r?\n/)[0];
		if (launcher) candidates.push(path.join(path.dirname(path.dirname(fs.realpathSync(launcher))), "install"));
	} catch {}
	for (const c of candidates) {
		if (!c) continue;
		const root = path.resolve(c);
		if (fs.existsSync(path.join(root, "managed-install.json"))) return root;
	}
	return null;
}

/** 托管安装当前版本的 node_modules 根（<install>/releases/<版本>/node_modules）。 */
function managedNodeModulesRoot() {
	const root = managedInstallRoot();
	if (!root) return null;
	try {
		const version = fs.readFileSync(path.join(root, "current-version"), "utf8").trim();
		const modules = path.join(root, "releases", version, "node_modules");
		return fs.existsSync(path.join(modules, ...PI_PACKAGE.split("/"))) ? modules : null;
	} catch {
		return null;
	}
}

/** 探测 pi 安装的 node_modules 根（含 @earendil-works/pi-coding-agent）：
 *  托管安装优先（pi 自带安装器 / pi update 的布局），其次 npm 全局安装。 */
function findPiGlobalRoot() {
	const managed = managedNodeModulesRoot();
	if (managed) return managed;
	// npm root -g（覆盖 Windows/macOS/Linux 的 npm 默认全局目录）
	try {
		const root = execSync("npm root -g", { encoding: "utf8", windowsHide: true }).trim();
		if (root && fs.existsSync(path.join(root, "@earendil-works", "pi-coding-agent"))) return root;
	} catch (e) {
		log(`npm root -g 探测失败（${e.message}），改用兜底候选目录`);
	}
	// 兜底：常见全局目录（pnpm / nvm-global / brew / 系统 npm）
	const candidates = [
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : null, // Windows
		path.join(os.homedir(), ".npm-global", "node_modules"), // nvm 常见全局前缀
		path.join(USER_NPM_PREFIX, "lib", "node_modules"), // 用户级前缀（无 sudo 安装）
		"/usr/local/lib/node_modules", // macOS / brew
		"/usr/lib/node_modules", // Linux 系统 npm
	];
	for (const c of candidates) {
		if (c && fs.existsSync(path.join(c, "@earendil-works", "pi-coding-agent"))) return c;
	}
	return null;
}

/** 安装 pi 本体（npm i -g）：与复杂依赖同一套权限兑底（EACCES 时问是否改用户级前缀）；dry-run 只预览。 */
async function installPi() {
	if (dryRun) {
		log(`安装 pi 本体：npm install -g ${PI_PACKAGE}`);
		return;
	}
	if (!(await npmInstallGlobal(PI_PACKAGE))) {
		console.error(`\npi 本体没装上，先停在这里——装好后重跑 install.js 即可。`);
		process.exit(1);
	}
}

/** 检测 pi 本体是否已全局安装；缺失则交互确认后自动安装（-y / 非 TTY 自动装）。 */
async function ensurePi() {
	if (findPiGlobalRoot()) return;
	log(`未检测到 pi 本体（${PI_PACKAGE}）`);
	if (!(await confirm("  是否自动安装 pi 本体？（Y/n）"))) {
		console.error(`已取消。请手动执行 npm i -g ${PI_PACKAGE} 后重新运行 install.js。`);
		process.exit(1);
	}
	await installPi();
	if (!dryRun && !findPiGlobalRoot()) {
		console.error("安装后仍检测不到 pi，请确认 npm 全局目录在 PATH 中后重新运行 install.js。");
		process.exit(1);
	}
}

/** 读取 src/package.json 声明的全部构建依赖（dependencies + devDependencies），
 *  返回缺失于 src/node_modules 的包名列表（scoped 包 @scope/name 按目录层级检查）。
 *  @types/* 虽只服务类型检查不参与构建，但统一纳入同一检测口径，缺了一起补。 */
function missingBuildDeps() {
	const pkgPath = path.join(SRC_DIR, "package.json");
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
		const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
		return names.filter((n) => !fs.existsSync(path.join(SRC_DIR, "node_modules", ...n.split("/"))));
	} catch {
		return [
			/* 清单解析失败：退化为原有的 esbuild 单项检查（该包在则视为依赖无恙，避免误报） */
			...(fs.existsSync(ESBUILD_DIR) ? [] : ["esbuild"]),
		];
	}
}

/** 本机 libc（仅 Linux 有意义）：有 glibc 运行时版本号即 glibc，否则按 musl；探测不到返回 null（不参与比对）。 */
function currentLibc() {
	if (process.platform !== "linux") return null;
	try {
		return process.report?.getReport?.().header?.glibcVersionRuntime ? "glibc" : "musl";
	} catch {
		return null;
	}
}

/** npm 的 os/cpu/libc 约束是否命中给定值（支持 "!win32" 取反写法；无约束视为命中）。 */
function constraintMatches(list, value) {
	if (!Array.isArray(list) || list.length === 0) return true;
	if (list.includes(`!${value}`)) return false;
	if (list.some((v) => typeof v === "string" && !v.startsWith("!"))) return list.includes(value);
	return true; // 只有取反项且未命中 → 适用本机
}

/** 本机平台的原生可选依赖（package-lock 里带 os/cpu/libc 约束且命中本机的条目）在 src/node_modules 里缺失的清单。
 *  只看包名与否查不出这类问题：双系统共享同一份 node_modules 时，另一平台的 @esbuild/<平台> 还在、本机的那个没有，
 *  构建会以「原生二进制平台不符」全量失败（且 esbuild 不报编译诊断，错误信息看起来是空的）。
 *  补装只增不删，两个平台的包可共存：两个系统各跑一次 install.js 后，来回切换都不再需要重装。 */
function missingNativeDeps() {
	let lock;
	try {
		lock = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "package-lock.json"), "utf8"));
	} catch {
		return []; // 无锁文件/解析失败：退回包名检测口径，不误报
	}
	const libc = currentLibc();
	const missing = [];
	for (const [rel, meta] of Object.entries(lock.packages ?? {})) {
		if (!rel.startsWith("node_modules/") || !meta) continue;
		if (!meta.os && !meta.cpu && !meta.libc) continue; // 与平台无关的普通包
		if (!constraintMatches(meta.os, process.platform)) continue;
		if (!constraintMatches(meta.cpu, process.arch)) continue;
		if (libc && !constraintMatches(meta.libc, libc)) continue;
		if (fs.existsSync(path.join(SRC_DIR, rel))) continue;
		missing.push({ name: rel.replace(/^.*?node_modules\//, ""), version: meta.version ?? null });
	}
	return missing;
}

/** 确保构建依赖已安装：按 src/package.json 清单与 src/node_modules 实况全量比对
 *  （不只查 esbuild 一个包），任一依赖缺失即交互确认后 npm install 补装——
 *  覆盖克隆后首次、node_modules 不完整（如 install 中途中断、包被手删）、以及双系统换系统后
 *  本机原生包（@esbuild/<平台>）缺席的情形。 */
async function ensureDeps() {
	const missing = missingBuildDeps();
	const native = missingNativeDeps();
	if (missing.length === 0 && native.length === 0) return;
	if (missing.length > 0) log(`构建依赖缺失（${missing.length}）：${missing.join(", ")}`);
	if (native.length > 0) {
		log(`本机原生依赖缺失（${native.length}）：${native.map((d) => d.name).join(", ")}（本机 ${process.platform}-${process.arch}）`);
	}
	if (!(await confirm("  是否自动执行 npm install 拉取构建依赖？（Y/n）"))) {
		console.error("已取消。请手动执行 cd src && npm install 后重新运行 install.js。");
		process.exit(1);
	}
	log("自动执行 npm install（src/ 下）…");
	if (dryRun) return;
	if (!(await npmRun("npm install", { cwd: SRC_DIR })).ok) {
		console.error("\nnpm install 失败（需要网络）。请手动执行 cd src && npm install 后重新运行 install.js。");
		process.exit(1);
	}
	// npm 对「已装另一平台同名可选包」的树偶尔判定无需变更而跳过补装：按锁文件版本点名补一次
	const stillNative = missingNativeDeps();
	if (stillNative.length > 0) {
		log(`单独补装本机原生依赖：${stillNative.map((d) => d.name).join(", ")}`);
		const specs = stillNative.map((d) => (d.version ? `${d.name}@${d.version}` : d.name)).join(" ");
		/* 补装失败由下方复查统一报错退出 */
		await npmRun(`npm install --no-save ${specs}`, { cwd: SRC_DIR });
	}
	// 补装后复查：仍缺说明 npm 源异常或 package.json 与锁文件不一致，明示给用户
	const still = [...missingBuildDeps(), ...missingNativeDeps().map((d) => d.name)];
	if (still.length > 0) {
		console.error(`\n✗ 仍有依赖未安装成功：${still.join(", ")}。请检查网络重试；若刚改过 package.json，先 npm install 更新锁文件。`);
		if (missingNativeDeps().length > 0) {
			console.error(`   本机原生依赖（${process.platform}-${process.arch}）仍缺席：npm 源可能不提供该平台包，或 src/node_modules 不可写。`);
		}
		process.exit(1);
	}
}

/** 自动构建：install 前先跑 build.js（dry-run 只预览不构建）。 */
function autoBuild() {
	if (!fs.existsSync(BUILD_SCRIPT)) {
		console.error(`错误: 未找到构建脚本 ${BUILD_SCRIPT}`);
		process.exit(1);
	}
	log(`自动构建：node ${path.relative(ROOT, BUILD_SCRIPT)}`);
	if (dryRun) return; // 试运行不执行
	const r = spawnSync(process.execPath, [BUILD_SCRIPT, "--from-install"], { cwd: ROOT, stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`\n构建失败（退出码 ${r.status}）。请检查 src/ 源码与网络后重试。`);
		process.exit(1);
	}
}

/** rtk 安装落点：Windows 装进 npm 全局目录（天然在 PATH）；其余优先已在 PATH 的 ~/.local/bin，
 *  否则退 ~/.pi/agent/bin 并提示加 PATH。返回 { dir, needsPathHint }。 */
function rtkDestDir() {
	if (process.platform === "win32") {
		return { dir: path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm"), needsPathHint: false };
	}
	const localBin = path.join(os.homedir(), ".local", "bin");
	if (process.env.PATH?.split(path.delimiter).includes(localBin)) return { dir: localBin, needsPathHint: false };
	return { dir: path.join(PI_AGENT, "bin"), needsPathHint: true };
}

/** rtk 是否已在 PATH 上可用（shell:true 让 cmd/PATH 负责解析 rtk/rtk.exe）。 */
function rtkOnPath() {
	try {
		return spawnSync("rtk", ["--version"], { shell: true, encoding: "utf8", windowsHide: true }).status === 0;
	} catch {
		return false;
	}
}

/** curl 下载（本仓库网络工具惯例：系统 curl 自动带代理）；失败返回 false。 */
function rtkDownload(url, dest) {
	try {
		return spawnSync("curl", ["-fsSL", "-m", "300", "-o", dest, url], { encoding: "utf8", windowsHide: true }).status === 0;
	} catch {
		return false;
	}
}

/** 校验下载产物的 sha256 与官方 checksums.txt 一致（sha256sum 格式：<hash>  <文件名>）。 */
function rtkVerify(asset, file, checksumsFile) {
	try {
		const line = fs.readFileSync(checksumsFile, "utf8")
			.split(/\r?\n/)
			.find((l) => l.trimEnd().endsWith(`  ${asset}`));
		if (!line) return false;
		const want = line.trim().split(/\s+/)[0].toLowerCase();
		const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		return want === got;
	} catch {
		return false;
	}
}

/** 解压到 dir 并返回解出的 rtk 可执行文件路径（二进制在压缩包内的位置不假设，解压后递归找 rtk/rtk.exe）。
 *  zip 仅出现在 Windows：优先用系统自带 bsdtar（System32\tar.exe 支持 zip）；PATH 上的 tar 可能是
 *  Git Bash 的 GNU tar（不支持 zip），失败则回落 PowerShell Expand-Archive。tar.gz 走系统 tar。 */
function rtkExtract(archive, dir, isZip) {
	fs.mkdirSync(dir, { recursive: true });
	const spawn = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
	let r;
	if (isZip) {
		const bsdtar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
		r = spawn(bsdtar, ["-xf", archive, "-C", dir]);
		if (r.status !== 0 || r.error) {
			const psPath = `${archive.replace(/'/g, "''")}`;
			const psDir = `${dir.replace(/'/g, "''")}`;
			r = spawn("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${psPath}' -DestinationPath '${psDir}' -Force`]);
		}
	} else {
		r = spawn("tar", ["-xzf", archive, "-C", dir]);
	}
	if (r.status !== 0 || r.error) return null;
	const binName = process.platform === "win32" ? "rtk.exe" : "rtk";
	const stack = [dir];
	while (stack.length) {
		const cur = stack.pop();
		for (const f of fs.readdirSync(cur, { withFileTypes: true })) {
			const p = path.join(cur, f.name);
			if (f.isDirectory()) stack.push(p);
			else if (f.name === binName) return p;
		}
	}
	return null;
}

/** 可选依赖：rtk 二进制安装。PATH 已有则跳过；缺失时询问 → 下载（直连→镜像）→ 校验 → 落盘。
 *  任何失败只警告不阻塞（插件侧缺失即安全降级）。 */
async function ensureRtk() {
	const asset = RTK_ASSETS[`${process.platform}|${process.arch}`];
	if (rtkOnPath()) {
		log("rtk ✓（已在 PATH 上，pi-rtk-optimizer 命令改写可用）");
		return;
	}
	if (!asset) {
		log(`rtk 跳过（暂无 ${process.platform}/${process.arch} 官方资产，可在 ${RTK_REPO} releases 确认后手动安装）`);
		return;
	}
	const { dir, needsPathHint } = rtkDestDir();
	const destBin = path.join(dir, process.platform === "win32" ? "rtk.exe" : "rtk");
	if (fs.existsSync(destBin)) {
		log(`rtk ✓（已安装在 ${destBin}，不在 PATH 上——重启终端或把该目录加入 PATH 后生效）`);
		return;
	}
	log("rtk 未检测到（可选依赖：pi-rtk-optimizer 的命令改写引擎，缺失时该插件自动旁路仅留输出压缩）");
	if (!(await confirm(`  是否自动下载安装 rtk ${RTK_VERSION}（${asset}）？（Y/n）`))) {
		log(`已跳过 rtk（不影响安装；需要时手动装：https://github.com/${RTK_REPO}/releases）`);
		return;
	}
	if (dryRun) {
		log(`[预览] 下载 ${RTK_REPO} ${RTK_VERSION}/${asset} → 校验 sha256 → 解压安装到 ${destBin}`);
		return;
	}
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtk-install-"));
	try {
		const direct = `https://github.com/${RTK_REPO}/releases/download/${RTK_VERSION}`;
		const urls = RTK_PROXY ? [direct, RTK_PROXY + direct] : [direct]; // 直连优先，镜像回落
		const archive = path.join(tmp, asset);
		let ok = false, via = "";
		for (const u of urls) {
			console.log(`  下载 ${asset} …（${u.startsWith("https://github.com") ? "GitHub 直连" : "镜像"}）`);
			if ((ok = rtkDownload(`${u}/${asset}`, archive))) { via = u; break; }
		}
		if (!ok) throw new Error("所有下载源均失败（直连与镜像）");
		const checksums = path.join(tmp, "checksums.txt");
		if (!rtkDownload(`${via}/checksums.txt`, checksums)) throw new Error("checksums.txt 下载失败");
		if (!rtkVerify(asset, archive, checksums)) throw new Error("sha256 校验不通过（文件损坏或被篡改）");
		const bin = rtkExtract(archive, path.join(tmp, "out"), asset.endsWith(".zip"));
		if (!bin) throw new Error("解压后未找到 rtk 可执行文件");
		fs.mkdirSync(dir, { recursive: true });
		fs.copyFileSync(bin, destBin);
		if (process.platform !== "win32") fs.chmodSync(destBin, 0o755);
		log(`rtk ${RTK_VERSION} 已安装到 ${destBin}`);
		if (needsPathHint) console.log(`  提示：${dir} 不在 PATH 上，请把它加入 PATH（如 ~/.bashrc / ~/.zshrc 加 export PATH="$HOME/.pi/agent/bin:$PATH"）后重启终端。`);
	} catch (e) {
		console.warn(`⚠ rtk 自动安装失败（${e.message}），跳过（不影响安装；pi-rtk-optimizer 会安全降级）。`);
		console.warn(`  可稍后手动安装：https://github.com/${RTK_REPO}/releases/tag/${RTK_VERSION}`);
	} finally {
		try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录残留无害 */ }
	}
}

/**
 * 判断 parentDir/name 是不是某个扩展的资源目录（copyDir 与 removeStaleFiles 都要跳过它们）。
 *
 * 两侧命名一致（都叫 <扩展名>/<资源目录>），所以只看末两段即可：
 * 源侧是 src/extensions/computer-use/model，目标侧是 ~/.pi/agent/extensions/computer-use/model。
 */
function isExtAssetDir(parentDir, name) {
	const extName = path.basename(parentDir);
	const dirs = EXT_ASSETS[extName];
	return Array.isArray(dirs) && dirs.includes(name);
}

/**
 * 复制扩展附属资源到已安装目录。
 *
 * 扩展产物是单文件（dist/extensions/<名>.ts），但有几类东西内联不进去也不该内联：
 * 桌面宿主脚本（PowerShell，要按原样交给解释器执行）、ONNX 权重（二进制大文件）。
 * 它们的源码留在 src/extensions/<名>/ 下，这里整体搬到 ~/.pi/agent/extensions/<名>/，
 * 运行时通过扩展产物自身的目录定位（import.meta.url 的同级目录）。
 *
 * 先删后拷：宿主脚本会随仓库更新，残留旧文件（已改名的脚本）不该留在安装目录里。
 * 用 removePathSafe 而非 rmSync——后者在含中文的路径下会静默不删。
 */
function installExtAssets() {
	for (const [ext, dirs] of Object.entries(EXT_ASSETS)) {
		const srcRoot = path.join(ROOT, "src", "extensions", ext);
		if (!fs.existsSync(srcRoot)) continue;
		for (const dir of dirs) {
			const from = path.join(srcRoot, dir);
			const to = path.join(EXT_DST, ext, dir);
			if (!fs.existsSync(from)) continue;
			if (dryRun) {
				log(`将复制资源 ${path.relative(ROOT, from)} -> ${to}`);
				continue;
			}
			removePathSafe(to);
			fs.mkdirSync(to, { recursive: true });
			fs.cpSync(from, to, {
				recursive: true,
				// 只搬运行时真需要的东西：测试与临时产物留在仓库里。
				// 注意 model/ 下的 .ts 是真正的运行时代码（预处理/推理/标注），不能按扩展名筛。
				filter: (p) => {
					const b = path.basename(p);
					return !(b.endsWith(".test.mjs") || b.startsWith(".tmp") || b === "node_modules");
				},
			});
			log(`复制资源 ${path.relative(ROOT, from)} -> ${to}`);
		}
	}
}

function copyDir(src, dst, exts = [".json", ".ts"]) {
	if (!fs.existsSync(src)) {
		log(`跳过（目录不存在）: ${src}`);
		return;
	}
	if (!dryRun) fs.mkdirSync(dst, { recursive: true });
	for (const f of fs.readdirSync(src, { withFileTypes: true })) {
		const from = path.join(src, f.name);
		// 子目录递归（多文件扩展，如 extensions/hud/{index,balance,cost,git}.ts）
		if (f.isDirectory()) {
			if (f.name === "node_modules") continue;
			// 扩展附属资源目录（platform/、model/）由 installExtAssets 整体搬运：
			// 它们里面没有 .ts 扩展入口，按扩展名过滤会被全部丢掉；而 removeStaleFiles
			// 更会把"dist 里没有的"资源文件当成旧文件删掉（实测删过 model/*.ts 与权重）。
			if (isExtAssetDir(src, f.name)) continue;
			copyDir(from, path.join(dst, f.name), exts);
			continue;
		}
		if (!exts.some((e) => f.name.endsWith(e))) continue;
		const to = path.join(dst, f.name);
		log(`复制 ${path.relative(ROOT, from)} -> ${to}`);
		if (!dryRun) {
			try {
				fs.copyFileSync(from, to);
			} catch (e) {
				// 磁盘满/文件被占用/权限不足：报出具体文件并中断，避免静默留下半成品
				console.error(`\n✗ 复制失败：${from} -> ${to}\n  原因：${e.message}\n  提示：已复制的文件保留在目标目录，修复后重跑 install.js 即可（幂等）。`);
				process.exit(1);
			}
		}
	}
	removeStaleFiles(src, dst, exts);
}

/** 删除目标目录里来源已不存在的文件，避免重安装后新旧内容混成一棵树。 */
function removeStaleFiles(src, dst, exts) {
	if (!fs.existsSync(dst)) return;
	for (const f of fs.readdirSync(dst, { withFileTypes: true })) {
		const target = path.join(dst, f.name);
		if (f.isDirectory()) {
			// 扩展资源目录里的内容不来自 dist，不能按"来源已移除"判断（会删掉权重与宿主脚本）
			if (f.name === "node_modules" || isExtAssetDir(src, f.name)) continue;
			// 源目录里没有同名子目录 → 这个目录不是 copyDir 建的（插件运行时自己建的数据目录，
			// 如 pi-rtk-optimizer 的 config.json），里面所有文件都不在"来源"的视野内，一律不动：
			// 递归进去会把用户配置当成旧文件删干净。
			if (!fs.existsSync(path.join(src, f.name))) continue;
			removeStaleFiles(path.join(src, f.name), target, exts);
			continue;
		}
		if (exts && !exts.some((e) => f.name.endsWith(e))) continue;
		if (fs.existsSync(path.join(src, f.name))) continue;
		log(`删除来源已移除的旧文件: ${target}`);
		if (!dryRun) {
			try { fs.unlinkSync(target); } catch (e) { console.warn(`⚠ 删除旧文件失败：${target}（${e.message}）`); }
		}
	}
}

/** 递归删除：不用 rmSync（本机实测其在含中文的路径下会静默不删）。 */
function removePathSafe(target) {
	let st;
	try { st = fs.lstatSync(target); } catch { return; }
	if (st.isDirectory() && !st.isSymbolicLink()) {
		for (const name of fs.readdirSync(target)) removePathSafe(path.join(target, name));
		try { fs.rmdirSync(target); } catch { /* 删除失败时保留现场 */ }
	} else {
		try { fs.unlinkSync(target); } catch { /* 同上 */ }
	}
}

function isPlainObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 全量递归复制（vendor 包原样搬运：ts/js/mjs/md/json/png/LICENSE 等所有文件）。 */
function copyAll(src, dst) {
	if (!dryRun) fs.mkdirSync(dst, { recursive: true });
	for (const f of fs.readdirSync(src, { withFileTypes: true })) {
		if (f.name === "node_modules") continue; // 依赖由 installVendor 的 npm install 重建
		const from = path.join(src, f.name);
		const to = path.join(dst, f.name);
		if (f.isDirectory()) {
			copyAll(from, to);
			continue;
		}
		log(`复制 ${path.relative(ROOT, from)} -> ${to}`);
		if (!dryRun) {
			try {
				fs.copyFileSync(from, to);
			} catch (e) {
				console.error(`\n✗ 复制失败：${from} -> ${to}\n  原因：${e.message}\n  提示：已复制的文件保留在目标目录，修复后重跑 install.js 即可（幂等）。`);
				process.exit(1);
			}
		}
	}
	removeStaleFiles(src, dst, null);
}

/** 注册 vendor 包到 settings.json 的 packages（本地路径形式，幂等：已存在不重复添加）；
 *  同时注销已从 src/vendor/ 移除的包（如回退自研版时），并清理已安装目录残留。 */
function registerVendorPackages(pkgDirs) {
	const settingsPath = path.join(PI_AGENT, "settings.json");
	let settings = {};
	if (fs.existsSync(settingsPath)) {
		try {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		} catch {
			log(`警告: 无法解析 ${settingsPath}，跳过 vendor 包注册`);
			return;
		}
	}
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const norm = (p) => p.replace(/\//g, "\\").toLowerCase();
	const existing = new Set(
		packages.map((p) => norm(typeof p === "string" ? p : String(p?.source ?? ""))),
	);
	const missing = pkgDirs.filter((dir) => !existing.has(norm(dir)));
	// 注销：packages 里指向 ~/.pi/agent/vendor/<名>/ 但 src/vendor/ 已无同名目录的条目 →
	// 从 settings 移除 + 删除已安装目录（回退自研扩展后残留会继续生效，必须同步清理）
	const validVendorDirs = new Set(pkgDirs.map((d) => norm(d)));
	const stale = packages.filter((p) => {
		const s = typeof p === "string" ? p : String(p?.source ?? "");
		return !validVendorDirs.has(norm(s)) && norm(s).startsWith(norm(VENDOR_DST + path.sep));
	});
	const staleDirs = stale.map((p) => (typeof p === "string" ? p : String(p?.source ?? "")));
	const keep = packages.filter((p) => !staleDirs.includes(typeof p === "string" ? p : String(p?.source ?? "")));
	for (const dir of staleDirs) {
		log(`注销已移除的 vendor 包: ${dir}`);
		if (!dryRun) {
			const root = path.resolve(VENDOR_DST);
			const resolved = path.resolve(dir);
			const rel = path.relative(root, resolved);
			// 只允许删除 vendor 的直接子目录：含 ..、根自身或更深层路径都不能进入删除流程
			if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
				log(`警告: 拒绝删除 vendor 范围外的路径: ${dir}`);
			} else {
				removePathSafe(resolved);
			}
		}
	}
	if (missing.length === 0 && stale.length === 0) {
		log("settings.packages 与 src/vendor/ 一致，无需修改");
		return;
	}
	for (const dir of missing) log(`注册 vendor 包: ${dir}`);
	if (!dryRun) {
		settings.packages = [...keep, ...missing];
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
	}
}

/**
 * 安装 vendor 第三方插件：原样复制到 ~/.pi/agent/vendor/<包名>/，
 * 对声明运行时 dependencies 的包补 npm install --omit=dev（pi 只对 npm/git 来源自动装依赖，本地路径不装），
 * 最后把本地路径注册进 settings.json 的 packages。
 */
async function installVendor() {
	if (!fs.existsSync(VENDOR_SRC)) {
		log(`跳过 vendor（目录不存在）: ${VENDOR_SRC}`);
		registerVendorPackages([]);
		return;
	}
	const pkgs = fs.readdirSync(VENDOR_SRC, { withFileTypes: true }).filter((d) => d.isDirectory());
	if (pkgs.length === 0) {
		registerVendorPackages([]);
		return;
	}
	const installed = [];
	for (const d of pkgs) {
		const src = path.join(VENDOR_SRC, d.name);
		const dst = path.join(VENDOR_DST, d.name);
		copyAll(src, dst);
		let deps = {};
		try {
			deps = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).dependencies ?? {};
		} catch {
			log(`警告: ${d.name} 无 package.json 或无法解析，跳过依赖安装`);
		}
		if (Object.keys(deps).length > 0) {
			log(`安装 ${d.name} 运行时依赖：npm install --omit=dev（${Object.keys(deps).join(", ")}）`);
			if (!dryRun) {
				if (!(await npmRun("npm install --omit=dev --no-audit --no-fund", { cwd: dst })).ok) {
					console.error(`\n✗ ${d.name} 依赖安装失败（需要网络）。修复后重跑 install.js 即可（幂等）。`);
					process.exit(1);
				}
			}
		}
		installed.push(dst);
	}
	registerVendorPackages(installed);
}

/** 清理已被官方版替代的旧扩展文件：仅当源码已从 dist 消失、且文件在已安装目录中存在时删除（安全幂等）。 */
function removeLegacyExtensions() {
	for (const name of LEGACY_REMOVED_EXTENSIONS) {
		const stale = path.join(EXT_DST, name);
		const stillBuilt = fs.existsSync(path.join(EXT_SRC, name));
		if (stillBuilt || !fs.existsSync(stale)) continue;
		log(`删除已替代的旧扩展: ${stale}`);
		if (!dryRun) removePathSafe(stale);
	}
}

/**
 * 深度合并两个 JSON 对象（返回新对象，不改动入参）。
 * 标量/数组：override 直接覆盖 base；对象：递归合并。
 */
function deepMerge(base, override) {
	const out = { ...base };
	for (const k of Object.keys(override)) {
		if (isPlainObject(base?.[k]) && isPlainObject(override[k])) {
			out[k] = deepMerge(base[k], override[k]);
		} else {
			out[k] = override[k];
		}
	}
	return out;
}

/** 安装/合并 models.json：不存在则复制，存在则把仓库模板层层合并进既有配置（保留用户手改的其他 provider/模型）。 */
function installModelsJson() {
	if (!fs.existsSync(MODELS_SRC)) {
		log(`跳过 models.json（模板不存在）: ${MODELS_SRC}`);
		return;
	}
	const dstPath = path.join(PI_AGENT, "models.json");
	let repo, merged;
	try {
		repo = JSON.parse(fs.readFileSync(MODELS_SRC, "utf8"));
	} catch (e) {
		log(`警告: 仓库模板 ${MODELS_SRC} 无法解析，跳过 models.json`);
		return;
	}
	if (fs.existsSync(dstPath)) {
		let existing = {};
		try {
			existing = JSON.parse(fs.readFileSync(dstPath, "utf8"));
		} catch {
			log(`警告: 无法解析 ${dstPath}，将用仓库模板覆盖`);
		}
		merged = deepMerge(existing, repo);
	} else {
		merged = repo;
	}
	log(`更新 models.json（${dstPath}）`);
	if (!dryRun) fs.writeFileSync(dstPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

// 全局 AGENTS.md 标记块：本脚本只管理标记之间的内容，块外用户手写规则原样保留（幂等可重装）
const AGENTS_MARK_BEGIN = "<!-- my_pi:begin -->";
const AGENTS_MARK_END = "<!-- my_pi:end -->";

/**
 * 安装/合并全局 AGENTS.md：static/AGENTS.md 的内容包进 my_pi 标记块写入 ~/.pi/agent/AGENTS.md。
 * - 目标不存在 → 直接写入；
 * - 已有标记块 → 替换块内内容（用户块外手写内容保留）；
 * - 已存在但无标记块 → 交互询问是否追加到末尾（-y / 非 TTY 默认追加）。
 */
async function installAgentsMd() {
	if (!fs.existsSync(AGENTS_SRC)) {
		log(`跳过全局 AGENTS.md（模板不存在）: ${AGENTS_SRC}`);
		return;
	}
	const dstPath = path.join(PI_AGENT, "AGENTS.md");
	const block = `${AGENTS_MARK_BEGIN}\n${fs.readFileSync(AGENTS_SRC, "utf8").trim()}\n${AGENTS_MARK_END}`;
	if (!fs.existsSync(dstPath)) {
		log(`写入全局 AGENTS.md（${dstPath}）`);
		if (!dryRun) fs.writeFileSync(dstPath, block + "\n", "utf8");
		return;
	}
	const existing = fs.readFileSync(dstPath, "utf8");
	const bi = existing.indexOf(AGENTS_MARK_BEGIN);
	const ei = existing.indexOf(AGENTS_MARK_END);
	if (bi !== -1 && ei !== -1 && ei > bi) {
		const merged = existing.slice(0, bi) + block + existing.slice(ei + AGENTS_MARK_END.length);
		if (merged === existing) {
			log("全局 AGENTS.md 已是最新，无需修改");
			return;
		}
		log(`更新全局 AGENTS.md 标记块（${dstPath}）`);
		if (!dryRun) fs.writeFileSync(dstPath, merged, "utf8");
		return;
	}
	// 已存在用户手写的全局 AGENTS.md（无标记块）：询问后追加，不覆盖
	if (!(await confirm(`检测到已有全局 AGENTS.md（无 my_pi 标记块），是否把输出受众纪律追加到末尾？（Y/n）`))) {
		log(`跳过全局 AGENTS.md（保留用户既有文件）: ${dstPath}`);
		return;
	}
	log(`追加全局 AGENTS.md 标记块到既有文件末尾（${dstPath}）`);
	if (!dryRun) fs.writeFileSync(dstPath, existing.replace(/\n*$/, "\n\n") + block + "\n", "utf8");
}

function applySettings() {
	const settingsPath = path.join(PI_AGENT, "settings.json");
	if (!fs.existsSync(settingsPath)) {
		log(`跳过 settings（文件不存在）: ${settingsPath}`);
		return;
	}
	let settings;
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch {
		log(`警告: 无法解析 ${settingsPath}，跳过 settings 设置`);
		return;
	}
	// 本脚本声明的配置项：主题 + 思考块默认折叠
	const changes = [];
	if (settings.theme !== THEME_NAME) changes.push(`theme = "${THEME_NAME}"`);
	if (settings.hideThinkingBlock !== true) changes.push("hideThinkingBlock = true");
	if (changes.length === 0) {
		log("settings 已是目标配置，无需修改");
		return;
	}
	log(`更新 settings: ${changes.join(", ")}（${settingsPath}）`);
	if (!dryRun) {
		settings.theme = THEME_NAME;
		settings.hideThinkingBlock = true;
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
	}
}

/** pi 依赖包目录：npm 全局可能嵌套在 pi 包内，托管安装与 npm 默认则提升到 node_modules 根，两种都认。 */
function piPackageDir(root, name) {
	const nested = path.join(root, ...PI_PACKAGE.split("/"), "node_modules", ...name.split("/"));
	const hoisted = path.join(root, ...name.split("/"));
	for (const dir of [nested, hoisted]) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
	}
	return hoisted; // 都缺：留下提升布局的预期路径，让 TS 报出具体缺失文件
}

/** 用模板生成 tsconfig.json（paths 指向探测到的 pi 安装目录），换机器/pi 升级后重跑即可。 */
function generateTsconfig() {
	const templatePath = path.join(ROOT, "src", "config", "tsconfig.template.json");
	const outPath = path.join(ROOT, "src", "config", "tsconfig.json");
	if (!fs.existsSync(templatePath)) {
		log(`跳过 tsconfig（模板不存在）: ${templatePath}`);
		return;
	}
	const root = findPiGlobalRoot();
	if (!root) {
		log("跳过 tsconfig（未找到 pi 安装目录 @earendil-works/pi-coding-agent，可手动修改 src/config/tsconfig.json）");
		return;
	}
	// 占位符 → 候选列表 [{pkg, rel}]，取第一个存在的 d.ts（旧版 pi 没有 extension view 文件，要能落回包根入口）。
	const aiView = { pkg: PI_PACKAGE, rel: ["dist", "core", "extensions", "pi-ai-extension-view.d.ts"] };
	const aiPkg = (rel) => ({ pkg: "@earendil-works/pi-ai", rel });
	const entries = {
		__PI_PKG_CODING_AGENT__: [{ pkg: PI_PACKAGE, rel: ["dist", "index.d.ts"] }],
		__PI_PKG_AGENT_CORE__: [{ pkg: "@earendil-works/pi-agent-core", rel: ["dist", "index.d.ts"] }],
		// 扩展里的 `@earendil-works/pi-ai` 在运行时被 jiti 别名指到 extension view
		// （compat 全集 + TypeBox 的 Type/Static/TSchema），类型侧必须跟同一个文件，
		// 否则类型推导与实际运行不一致（StringEnum 等 schema 会被推成 unknown）。
		// `/compat` 子路径仍指 pi-ai 自己的 compat 入口：view 用 `export * from
		// "@earendil-works/pi-ai/compat"` 展开 compat，指回 view 会自引循环、导出全空。
		__PI_PKG_AI__: [aiView, aiPkg(["dist", "index.d.ts"])],
		__PI_PKG_AI_COMPAT__: [aiPkg(["dist", "compat.d.ts"])],
		__PI_PKG_TUI__: [{ pkg: "@earendil-works/pi-tui", rel: ["dist", "index.d.ts"] }],
		__PI_PKG_TYPEBOX__: [{ pkg: "typebox", rel: ["build", "index.d.mts"] }],
	};
	let out = fs.readFileSync(templatePath, "utf8");
	for (const [token, candidates] of Object.entries(entries)) {
		const resolved = candidates.map((c) => path.join(piPackageDir(root, c.pkg), ...c.rel));
		const found = resolved.find((p) => fs.existsSync(p)) ?? resolved[0];
		out = out.replaceAll(token, found.replace(/\\/g, "/"));
	}
	const typeRoots =
		[path.join(root, "@types"), path.join(piPackageDir(root, PI_PACKAGE), "node_modules", "@types")].find((d) => fs.existsSync(d)) ??
		path.join(root, "@types");
	out = out.replaceAll("__PI_TYPES__", typeRoots.replace(/\\/g, "/"));
	log(`生成 src/config/tsconfig.json（paths → ${root}）`);
	if (!dryRun) fs.writeFileSync(outPath, out, "utf8");
}

/** 执行外部查询命令；命令不存在或报错返回 null（供整步静默跳过）。 */
function probe(cmd, args) {
	try {
		const r = spawnSync(cmd, args, { encoding: "utf8" });
		if (r.status !== 0 || !r.stdout) return null;
		const out = r.stdout.trim();
		return out === "" ? null : out;
	} catch {
		return null;
	}
}

/** 终端实际在用的等宽字体族名：gnome-terminal 显式配置 > 系统等宽字体 > fontconfig 的 monospace 别名。 */
function terminalFontFamily() {
	const strip = (s) => (s ? s.replace(/^['"]|['"]$/g, "").replace(/\s+\d+(\.\d+)?$/, "") : null);
	const profiles = probe("gsettings", ["get", "org.gnome.Terminal.ProfilesList", "default"]);
	const id = profiles ? profiles.replace(/['\s]/g, "") : null;
	if (id) {
		const profile = `/org/gnome/terminal/legacy/profiles:/:${id}/`;
		// use-system-font 未设置时默认 true（跟随系统等宽字体），此处只在显式设为 false 时读专有字体
		if ((probe("dconf", ["read", `${profile}use-system-font`]) ?? "").includes("false")) {
			const family = strip(probe("dconf", ["read", `${profile}font`]));
			if (family) return family;
		}
	}
	return strip(probe("gsettings", ["get", "org.gnome.desktop.interface", "monospace-font-name"])) ?? "monospace";
}

/** 字体族/文件名 → 字体文件路径；fontconfig 不可用时返回 null。 */
function resolveFontFile(pattern) {
	return probe("fc-match", ["-f", "%{file}", pattern]);
}

/** 解析 fontconfig 的 charset 输出（形如 "20-7e a0-10a5"）为码点数组。 */
function parseCharset(text) {
	const cps = [];
	for (const part of (text ?? "").split(/[\s,]+/)) {
		if (!part) continue;
		const [a, b] = part.split("-");
		const lo = parseInt(a, 16);
		if (!Number.isFinite(lo)) continue;
		const hi = b ? parseInt(b, 16) : lo;
		for (let c = lo; c <= hi; c++) cps.push(c);
	}
	return cps;
}

/**
 * Linux：生成 fontconfig 规则，把终端等宽字体缺的非 CJK 符号钉给 DejaVu Sans Mono。
 * 覆盖范围随本地字体覆盖情况现场计算，幂等（内容不变不重写）；非 Linux / 无 fontconfig / 无需处理时跳过。
 */
function installFontFallback() {
	if (process.platform !== "linux") return;
	const family = terminalFontFamily();
	const monoFile = resolveFontFile(family);
	const fallbackFile = resolveFontFile(FONT_FALLBACK_FAMILY);
	if (!monoFile || !fallbackFile) {
		log("跳过字体回退修复（无 fontconfig 或字体查询失败）");
		return;
	}
	if (path.resolve(monoFile) === path.resolve(fallbackFile)) {
		log(`字体回退修复无需处理（终端字体已是 ${FONT_FALLBACK_FAMILY}）`);
		return;
	}
	const monoSet = new Set(parseCharset(probe("fc-list", ["-f", "%{charset}", `:file=${monoFile}`])));
	const fallbackSet = new Set(parseCharset(probe("fc-list", ["-f", "%{charset}", `:file=${fallbackFile}`])));
	// 读不到终端字体覆盖范围时不敢乱钉：会把该字体已有的字形也抢过来
	if (monoSet.size === 0 || fallbackSet.size === 0) {
		log("跳过字体回退修复（读取字体覆盖范围失败）");
		return;
	}
	const pinned = [];
	for (const [lo, hi] of FONT_SYMBOL_RANGES) {
		for (let c = lo; c <= hi; c++) if (fallbackSet.has(c) && !monoSet.has(c)) pinned.push(c);
	}
	if (pinned.length === 0) {
		log(`字体回退修复无需处理（${family} 已覆盖全部符号区）`);
		return;
	}
	const lines = [
		'<?xml version="1.0"?>',
		'<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
		"<!-- 由 my_pi install.js 生成，重跑安装会覆盖本文件。",
		`     ${family} 不含这些符号时，fontconfig 会回退到比例字体或 CJK 字体（字形高约 1.2em，越出格子且基线不同），`,
		`     使同一条进度条里实心与空心字形一高一矮；改由 ${FONT_FALLBACK_FAMILY} 统一提供。 -->`,
		"<fontconfig>",
	];
	for (const c of pinned) {
		lines.push(
			'\t<match target="pattern">',
			`\t\t<test name="charset" compare="contains"><charset><int>0x${c.toString(16)}</int></charset></test>`,
			`\t\t<edit name="family" mode="prepend" binding="strong"><string>${FONT_FALLBACK_FAMILY}</string></edit>`,
			"\t</match>",
		);
	}
	lines.push("</fontconfig>", "");
	const content = lines.join("\n");
	const existing = fs.existsSync(FONTCONF_DST) ? fs.readFileSync(FONTCONF_DST, "utf8") : null;
	if (existing === content) {
		log(`字体回退修复已是最新（${pinned.length} 个符号 → ${FONT_FALLBACK_FAMILY}）`);
		return;
	}
	log(`字体回退修复：${family} 缺的 ${pinned.length} 个非 CJK 符号改由 ${FONT_FALLBACK_FAMILY} 提供 → ${FONTCONF_DST}`);
	if (!dryRun) {
		fs.mkdirSync(path.dirname(FONTCONF_DST), { recursive: true });
		fs.writeFileSync(FONTCONF_DST, content, "utf8");
		log("  需新开终端窗口/标签才生效（运行中的终端不会重读字体配置）");
	}
}

/** 重打 static/patches/ 的四个 pi 补丁：脚本各自幂等（已打则跳过），失败只告警不阻塞。
 *  dry-run 只列脚本名——补丁直接写 pi 安装目录，无法在这里预览它们的行为。 */
async function applyPatches() {
	const dir = path.join(ROOT, "static", "patches");
	const scripts = PATCH_SCRIPTS.map((f) => path.join(dir, f));
	const missing = scripts.filter((f) => !fs.existsSync(f));
	if (missing.length) {
		log(`跳过补丁（脚本缺失: ${missing.map((f) => path.basename(f)).join(", ")}）`);
		return;
	}
	if (!(await confirm("是否给 pi 打四个补丁（音频输入 / usage 防护 / 汉化 / 启动垫片取证）？（Y/n）"))) {
		log("跳过补丁；需要时可手动跑 static/patches/*.mjs");
		return;
	}
	for (const script of scripts) {
		const name = path.basename(script);
		if (dryRun) {
			log(`补丁：node static/patches/${name}`);
			continue;
		}
		log(`补丁：${name}`);
		const r = spawnSync(process.execPath, [script], { stdio: "inherit" });
		if (r.error || r.status !== 0) {
			console.error(`⚠ 补丁未完成：${name}（${r.error ? r.error.message : `退出码 ${r.status}`}）；pi 仍可正常使用，可稍后单独重跑该脚本。`);
		}
	}
}

/** npm 全局 node_modules 根（算包内路径用）：优先找真的装着该包的那个根。
 *  不能只信 `npm root -g`：权限兑底把包装到用户级前缀后，它仍然只报旧的全局目录，
 *  于是脚本会以为没装、每次重跑都重装一遍。 */
function npmGlobalRoot(pkgName) {
	const roots = [];
	if (userNpmPrefixActive) roots.push(path.join(USER_NPM_PREFIX, "lib", "node_modules"));
	try {
		const root = execSync("npm root -g", { encoding: "utf8", windowsHide: true }).trim();
		if (root) roots.push(root);
	} catch {}
	roots.push(
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : null, // Windows
		path.join(os.homedir(), ".npm-global", "node_modules"), // nvm 常见全局前缀
		path.join(USER_NPM_PREFIX, "lib", "node_modules"), // 用户级前缀（无 sudo 安装）
		"/usr/local/lib/node_modules", // macOS / brew
		"/usr/lib/node_modules", // Linux 系统 npm
	);
	const existing = roots.filter((c) => c && fs.existsSync(c));
	if (!pkgName) return existing[0] ?? null;
	// 优先装有所需包的那个根，找不到时才退到第一个存在的目录（调用方据此判定"未安装"）
	return existing.find((c) => fs.existsSync(path.join(c, ...pkgName.split("/")))) ?? existing[0] ?? null;
}

/** mcp.json 里该服务的现状：不存在 → { exists: false, invalidEnv: [] }；
 *  存在 → 算出本机不可用的 env 键（另一平台写下的脏值，会让服务直接拒绝启动）。
 *  只看键在不在不够：旧条目带着 Windows 路径时键是齐的，不查值就会把「启动即报错」判成「已就绪」而永远不修。 */
function mcpEntryState(dep) {
	const cfg = readJsonFile(MCP_CONFIG);
	const entry = cfg && isPlainObject(cfg.mcpServers) ? cfg.mcpServers[dep.mcp.server] : null;
	if (!entry) return { exists: false, invalidEnv: [] };
	const invalidEnv = Object.keys(entry.env ?? {}).filter((k) => !isPathUsableOnThisPlatform(entry.env[k]));
	return { exists: true, invalidEnv };
}

/** 读 JSON 文件：不存在/坏 JSON 都返回 null（坏文件一律不覆写）。 */
function readJsonFile(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** 从 npm 的失败输出里删掉与本脚本无关的排查段（日志路径 / 「确认文件权限」套话 / 重复的堆栈），
 *  只留首行 + 原始 errno/路径 + 该干嘛。npm 自己那 20 行在这儿全是噪音。 */
function npmFailureDigest(output) {
	const lines = String(output).replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
	const keep = [];
	for (const line of lines) {
		const t = line.replace(/^npm (ERR!|error)\s*/, "npm ").trim();
		if (!t || keep.includes(t)) continue;
		if (/^(A complete log|If you believe|Please double|It is likely|\})/.test(t)) break;
		if (/^at /.test(t)) continue;
		keep.push(t);
	}
	return keep;
}

/** 全局 npm 安装失败是不是权限问题（而非网络/包不存在）。 */
function isPermissionDenied(output) {
	return /EACCES|EPERM/.test(String(output));
}

/** 跑 npm 全局安装；权限不足时说明原因、问是否改用用户级前缀重装。
 *  返回 true = 装好了；false = 没装成（调用方降级继续，不中断整个安装）。 */
async function npmInstallGlobal(spec) {
	log(`npm install -g ${spec}`);
	if (dryRun) return false;
	let r = await npmRun(`npm install -g ${spec}`);
	if (r.ok) return true;
	const failedRoot = userNpmPrefixActive ? USER_NPM_PREFIX : npmGlobalRoot();
	if (!isPermissionDenied(r.output)) {
		console.error(`✗ 安装 ${spec} 失败（不是权限问题，多半是网络或包不存在）：`);
		for (const l of npmFailureDigest(r.output)) console.error(`  ${l}`);
		return false;
	}
	if (!userNpmPrefixActive) {
		console.error(`\n✗ 装不进去：当前用户对 npm 全局目录没有写权限。`);
		console.error(`  目标目录：${failedRoot ?? "未知（npm root -g 探测失败）"}（属主不是 ${os.userInfo().username}）`);
		console.error(`  这类目录由系统包管理器创建，当前用户无法写入，重试结果一样。`);
		const ok = await confirm(`  改用用户级目录 ${USER_NPM_PREFIX} 重装？（Y/n，不需要 sudo）`);
		if (!ok) {
			console.error(`  已跳过 ${spec}。自己装好后就位（sudo npm i -g ${spec}），重跑 install.js 会自动接上后续配置。`);
			return false;
		}
	} else {
		console.error(`\n✗ 用户级目录 ${USER_NPM_PREFIX} 也装不进去（同样被系统拒绝），不再重试。`);
		console.error(`  手动排查：ls -ld ${path.join(USER_NPM_PREFIX, "lib", "node_modules")}，或用 sudo npm i -g ${spec}`);
		return false;
	}
	userNpmPrefixActive = true;
	log(`改用 ${USER_NPM_PREFIX} 重装（之后全局安装一律用该前缀）`);
	r = await npmRun(`npm install -g ${spec}`);
	if (r.ok) {
		log(`已用用户级前缀装好：${path.join(USER_NPM_PREFIX, "bin", spec.split("@")[0])}（该目录已在 PATH 上时可直接用）`);
		return true;
	}
	console.error(`✗ ${USER_NPM_PREFIX} 下仍安装失败：`);
	for (const l of npmFailureDigest(r.output)) console.error(`  ${l}`);
	return false;
}

/** 选 dep 能用的 node 可执行文件：`node.arch` 声明要求（如 REA 在 Windows 上只认 x64——
 *  arm64 机器上系统 node 是 arm64，必须用另装的 x64 node，否则 REA 直接判 unsupported_host）。
 *  依次试：显式 node.path → 当前 node → node.searchDirs 下一层目录 → PATH 上的各个 node；
 *  都不满足就返回 null（调用方不写配置，避免写一条跑不起来的条目）。 */
function resolveDepNode(dep) {
	const want = dep.node?.arch;
	const exe = NODE_EXE;
	// 托管 node 走 current 这个稳定路径：pi 升级换 node 版本后它仍指到新的那份，写进 mcp.json 不会失效
	const managedBin = managedNodeBin();
	const candidates = [dep.node?.path, managedBin ? path.join(managedBin, exe) : null, process.execPath];
	for (const dir of dep.node?.searchDirs ?? []) {
		candidates.push(path.join(dir, exe));
		try {
			for (const f of fs.readdirSync(dir, { withFileTypes: true })) if (f.isDirectory()) candidates.push(path.join(dir, f.name, exe));
		} catch {}
	}
	try {
		const list = execSync(process.platform === "win32" ? "where node" : "which -a node", { encoding: "utf8", windowsHide: true });
		candidates.push(...list.split(/\r?\n/).map((l) => l.trim()));
	} catch {}
	for (const c of candidates) {
		if (!c || !fs.existsSync(c)) continue;
		if (!want) return c;
		try {
			if (execSync(`"${c}" -p process.arch`, { encoding: "utf8", windowsHide: true }).trim() === want) return c;
		} catch {}
	}
	return null;
}


/** 把 deps.json 条目的 platforms.<本机平台> 小节合并进来（node / mcp.env 这类专属配置）：
 *  deps.json 是跨平台共享的一份，Windows 的 Ghidra/JDK/node 路径在 Linux 上写进 mcp.json 会让工具直接拒绝启动。
 *  合并且只增：平台小节里出现的键覆盖顶层，没出现的保持原样（浅合 node 与 mcp，mcp.env 再合一层）。 */
function applyPlatformOverrides(dep) {
	const over = dep.platforms?.[process.platform];
	if (!isPlainObject(over)) return dep;
	return {
		...dep,
		...(isPlainObject(over.node) ? { node: { ...(dep.node ?? {}), ...over.node } } : {}),
		...(isPlainObject(over.mcp)
			? { mcp: { ...(dep.mcp ?? {}), ...over.mcp, env: { ...(dep.mcp?.env ?? {}), ...(over.mcp.env ?? {}) } } }
			: {}),
	};
}

/** 该路径值在本机能不能用：Windows 盘符路径在 POSIX 上不是绝对路径，写进 env 会让 REA 这类工具直接拒绝启动。 */
function isPathUsableOnThisPlatform(value) {
	if (typeof value !== "string" || !value) return false;
	const winDrive = /^[A-Za-z]:[\\/]/.test(value);
	if (process.platform === "win32") return true; // Windows 接受盘符与正/反斜杠两种写法
	return !winDrive;
}

/** 把一项复杂依赖接进 ~/.pi/agent/mcp.json：
 *  - 条目不存在：新写一条（command = 选定的 node，args = 包内 MCP 入口，exposure 默认 codemode——
 *    工具不声明给模型、不进 codemode 描述，只在脚本里按需检索，省 token）；
 *  - 条目已存在：其余字段一律不动（用户手改优先），只在缺 env 键时补上，不覆盖已有值。
 *  env 取值优先级：现有条目 → deps.json 声明值（验证过的 Ghidra/JDK 路径）→ 进程环境变量。
 *  env 值按平台过滤：deps.json 是跨平台共享的一份，里面声明的 Windows 盘符路径在本机不适用，
 *  写进 mcp.json 会让工具直接拒绝启动——丢掉；已写进旧条目的同类脏值也一并清除。 */
function ensureMcpServer(dep, pkgDir, nodeExe) {
	const cfg = fs.existsSync(MCP_CONFIG) ? readJsonFile(MCP_CONFIG) : { mcpServers: {} };
	if (!cfg || !isPlainObject(cfg)) {
		console.error(`⚠ ${MCP_CONFIG} 不是合法 JSON，跳过 ${dep.mcp.server} 注册（修好该文件后重跑 install.js）。`);
		return;
	}
	cfg.mcpServers = isPlainObject(cfg.mcpServers) ? cfg.mcpServers : {};
	const existing = cfg.mcpServers[dep.mcp.server];
	const env = {};
	for (const [key, declared] of Object.entries(dep.mcp.env ?? {})) {
		const value = existing?.env?.[key] || declared || process.env[key];
		if (!value) continue;
		if (!isPathUsableOnThisPlatform(value)) {
			log(`跳过 ${dep.mcp.server} 的 ${key}：${value} 不是本机（${process.platform}）可用的路径`);
			continue;
		}
		env[key] = value;
		if (path.isAbsolute(value) && !fs.existsSync(value)) {
			console.error(`⚠ ${dep.name}：${key} 指向的本机路径不存在（${value}）——先自备该环境或改 static/deps.json 再重跑。`);
		}
	}
	// 已存在的条目可能带着上一次（另一平台）写下的无效路径：不清掉 MCP 起不来
	const staleKeys = Object.keys(existing?.env ?? {}).filter((k) => !isPathUsableOnThisPlatform(existing.env[k]));
	if (existing && staleKeys.length > 0) {
		for (const k of staleKeys) delete existing.env[k];
		if (Object.keys(existing.env).length === 0) delete existing.env;
		console.error(`⚠ 从 mcp.json 移除 ${dep.mcp.server} 的无效环境变量：${staleKeys.join(", ")}`);
	}
	if (existing) {
		const add = Object.entries(env).filter(([k, v]) => !existing.env?.[k] && v);
		if (add.length === 0 && staleKeys.length === 0) {
			log(`mcp.json 已有 ${dep.mcp.server} 且 env 齐备，保留现有配置`);
			return;
		}
		if (add.length > 0) existing.env = { ...(existing.env ?? {}), ...Object.fromEntries(add) };
		fs.writeFileSync(MCP_CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
		if (add.length > 0) log(`补齐 ${dep.mcp.server} 缺失的环境变量：${add.map(([k]) => k).join(", ")}`);
		return;
	}
	cfg.mcpServers[dep.mcp.server] = {
		command: nodeExe,
		args: [path.join(pkgDir, dep.mcp.entry), ...(dep.mcp.args ?? [])],
		...(Object.keys(env).length ? { env } : {}),
		...(dep.mcp.timeout ? { timeout: dep.mcp.timeout } : {}),
		exposure: dep.mcp.exposure ?? "codemode",
		...(dep.mcp.description ? { description: dep.mcp.description } : {}),
	};
	fs.writeFileSync(MCP_CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
	log(`注册 MCP 服务 ${dep.mcp.server} → ${MCP_CONFIG}（node ${nodeExe}，exposure ${dep.mcp.exposure ?? "codemode"}）`);
}

/**
 * 下载模型权重到扩展资源目录。
 *
 * 走多源回退：国内直连 huggingface.co 常不通，hf-mirror 是同一份权重的镜像。
 * 用 302 跟随与临时文件 + rename，避免下到一半中断留下半个文件（下次会被误判成"已就绪"）。
 */
async function downloadModel(model, dest) {
	const urls = Array.isArray(model.urls) ? model.urls : [model.urls];
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const tmp = `${dest}.part`;
	for (const url of urls) {
		if (dryRun) {
			log(`将下载模型 → ${dest}（来源 ${new URL(url).host}）`);
			return true;
		}
		log(`下载模型权重：${url}`);
		const ok = await new Promise((resolve) => {
			const out = fs.createWriteStream(tmp);
			const curl = spawn("curl", ["-sSL", "--fail", "--connect-timeout", "20", "-o", "-", url], {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let fed = false;
			curl.stdout.pipe(out);
			curl.on("close", (code) => {
				out.close(() => resolve(code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 1024 * 1024));
			});
			curl.on("error", () => {
				fed = true;
				resolve(false);
			});
			void fed;
		});
		if (!ok) {
			try { fs.unlinkSync(tmp); } catch {}
			continue;
		}
		try {
			fs.renameSync(tmp, dest);
			log(`模型已就位：${dest}`);
			return true;
		} catch (e) {
			console.error(`⚠ 模型落盘失败：${e.message}`);
			return false;
		}
	}
	console.error(`⚠ 模型下载失败（所有来源都不通）。${model.hint ?? "稍后重跑 install.js 可补装。"}`);
	console.error(`  也可手动下载后放到：${dest}`);
	return false;
}

/** 复杂外部依赖（static/deps.json）：要装 npm 全局包 + 注册 MCP + 自带 skill 的那类第三方工具
 *  （如 REA：200+ 工具，塞不进 skill，得装 CLI 再按 codemode 曝光接进 pi）。
 *  逐项确认后安装：npm i -g <包@版本> → 复制包内自带 skill → 写 mcp.json；
 *  已就绪的项跳过（含版本比对与 env 键比对），任一步失败只告警不阻塞——依赖缺席时 pi 照常可用。
 *  条目可带 platforms.<platform> 覆盖：node / mcp.env 这类本机专属路径写在那里，其他平台自然跳过。 */
async function installExternalDeps() {
	const manifest = readJsonFile(DEPS_SRC);
	const deps = manifest?.deps;
	if (!Array.isArray(deps) || deps.length === 0) return;
	for (const raw of deps) {
		const dep = applyPlatformOverrides(raw);
		const spec = dep.version ? `${dep.npm}@${dep.version}` : dep.npm;
		let root = npmGlobalRoot(dep.npm);
		let pkgDir = root ? path.join(root, ...dep.npm.split("/")) : null;
		let installedVersion = pkgDir ? readJsonFile(path.join(pkgDir, "package.json"))?.version ?? null : null;
		const versionOk = Boolean(installedVersion) && (!dep.version || installedVersion === dep.version);
		// 装到 ~/.agents/skills（agentskills.io 标准目录）：pi 与依赖自带的工具（REA 的 doctor 只认这里）都能发现；
		// 装到 ~/.pi/agent/skills 会让 pi 从两处看到同名 skill 而报名称冲突
		const skillDst = dep.skill ? path.join(AGENTS_SKILLS_DST, path.basename(dep.skill.dir)) : null;
		const skillReady = !skillDst || fs.existsSync(skillDst);
		const mcpState = dep.mcp ? mcpEntryState(dep) : { exists: true, invalidEnv: [] };
		const mcpReady = mcpState.exists && mcpState.invalidEnv.length === 0;
		// 模型权重（如 computer-use 的 ONNX 检测器）：跟着依赖一起装，装好即用
		const modelPath = dep.model ? path.join(EXT_DST, dep.model.dest) : null;
		const modelReady = !modelPath || fs.existsSync(modelPath);
		if (versionOk && skillReady && mcpReady && modelReady) {
			log(`复杂依赖已就绪：${dep.name}（${installedVersion}）`);
			continue;
		}
		const pending = [
			!installedVersion ? `npm 全局装 ${spec}` : versionOk ? null : `升级到 ${dep.version}（当前 ${installedVersion}）`,
			skillReady ? null : "装自带 skill",
			mcpState.exists ? null : `注册 MCP ${dep.mcp.server}`,
			mcpState.invalidEnv.length ? `清除 ${dep.mcp.server} 的无效环境变量 ${mcpState.invalidEnv.join("/")}` : null,
			modelReady ? null : "下载模型权重",
		].filter(Boolean);
		if (!(await confirm(`是否安装复杂依赖 ${dep.name}（${pending.join(" + ")}）？（Y/n）`))) {
			log(`跳过 ${dep.name}（以后重跑 install.js 可补装）`);
			continue;
		}
		if (dryRun) {
			log(`将执行：${pending.join(" + ")}`);
			continue;
		}
		// 选 node（可能要求特定架构）在安装之前定：选不出就不写一条跑不起来的 MCP 条目
		const nodeExe = dep.mcp ? resolveDepNode(dep) : null;
		if (dep.mcp && !nodeExe) {
			console.error(`⚠ ${dep.name}：找不到符合要求的 node（${dep.node?.arch ?? "任意"}）——${
				dep.node?.hint ?? "在 static/deps.json 的 node.path 里指定一个可用的 node，然后重跑 install.js。"
			}`);
			if (!installedVersion) continue; // 包本身还没装时干脆停下，避免只装一半
		}
		// 包已就位就不动它（版本不符则升到声明版本，同样是全局 npm 安装：权限不够走兜底）
		if (!versionOk) {
			log(`安装 ${dep.name}：npm install -g ${spec}`);
			if (!(await npmInstallGlobal(spec))) {
				console.error(`⚠ 跳过 ${dep.name} 的后续配置（skill / MCP 依赖这个包）；装好后重跑 install.js 即可。`);
				continue;
			}
			root = npmGlobalRoot(dep.npm);
			pkgDir = root ? path.join(root, ...dep.npm.split("/")) : null;
			installedVersion = pkgDir ? readJsonFile(path.join(pkgDir, "package.json"))?.version ?? null : null;
			if (!installedVersion) {
				console.error(`⚠ 装完仍找不到 ${dep.npm} 包目录，跳过后续配置；可稍后重跑 install.js。`);
				continue;
			}
		}
		if (skillDst && dep.skill && fs.existsSync(path.join(pkgDir, dep.skill.dir))) {
			if (fs.existsSync(skillDst)) {
				log(`skill 已在，保留现有：${skillDst}`);
			} else {
				log(`复制自带 skill → ${skillDst}`);
				fs.mkdirSync(path.dirname(skillDst), { recursive: true });
				fs.cpSync(path.join(pkgDir, dep.skill.dir), skillDst, { recursive: true });
			}
			// 早前版本把它装在 ~/.pi/agent/skills：两处同时存在时 pi 会报 name collision，清掉旧位置
			const staleSkill = path.join(SKILLS_DST, path.basename(dep.skill.dir));
			if (fs.existsSync(staleSkill)) {
				removePathSafe(staleSkill);
				log(`移除旧位置的同名 skill（两处共存会让 pi 报名称冲突）：${staleSkill}`);
			}
		}
		if (dep.mcp && nodeExe) ensureMcpServer(dep, pkgDir, nodeExe);
		if (dep.model && !modelReady) await downloadModel(dep.model, modelPath);
		console.log(`✓ ${dep.name} 已接好（重启 pi 生效）`);
	}
}

async function main() {
	reexecUnderManagedNode();
	console.log(`pi 一键环境安装 → ${PI_AGENT}\n`);

	// 0. 环境检测报告（非交互，只展示）
	const node = checkNode();
	console.log(`检测环境：`);
	console.log(`  node ${node.version} ${node.ok ? "✓" : `✗（pi 要求 ≥ ${NODE_MIN}，建议先升级 node 再启动 pi）`}`);
	const piRootBefore = findPiGlobalRoot();
	console.log(`  pi 本体 ${piRootBefore ? `✓ ${piRootBefore}` : `✗ 未安装（${PI_PACKAGE}）`}`);
	const buildDepsMissing = [...missingBuildDeps(), ...missingNativeDeps().map((d) => d.name)];
	console.log(`  构建依赖 ${buildDepsMissing.length === 0 ? "✓" : `✗ 缺 ${buildDepsMissing.length} 个（${buildDepsMissing.join(", ")}）`}`);
	console.log(`  rtk（可选，pi-rtk-optimizer 命令改写）${rtkOnPath() ? "✓" : "✗ 未安装（稍后可选自动安装）"}`);
	console.log("");

	// 1. pi 本体：缺失则交互确认后自动安装
	await ensurePi();

	// 2. 构建：--skip-build 跳过，否则交互确认后执行
	if (!skipBuild) {
		await ensureDeps();
		if (await confirm("是否自动构建扩展产物？（Y/n）")) {
			autoBuild();
		}
	}

	// 3. 构建后 dist 应已生成；仍缺失时：dry-run 给出预期说明，正式安装报错退出
	if (!fs.existsSync(DIST) || !fs.existsSync(path.join(DIST, "extensions"))) {
		if (dryRun) {
			console.log("dist 产物缺失——正式安装时会先自动执行 build.js 生成后再安装。\n");
		} else {
			console.error(`错误: 自动构建后仍找不到产物 ${DIST}。请先手动运行 node src/build.js 排查（或用 --skip-build 跳过自动构建）。`);
			process.exit(1);
		}
	}
	if (!fs.existsSync(path.join(THEMES_SRC, `${THEME_NAME}.json`))) {
		console.error(`错误: 找不到默认主题 ${THEME_NAME}.json（${THEMES_SRC}）`);
		process.exit(1);
	}

	// 4. 安装配置：交互确认后执行
	if (!(await confirm("确认安装配置到 ~/.pi/agent/？（Y/n）"))) {
		console.error("已取消安装。");
		process.exit(1);
	}
	copyDir(THEMES_SRC, THEMES_DST);
	copyDir(EXT_SRC, EXT_DST);
	installExtAssets();
	copyDir(SOUNDS_SRC, SOUNDS_DST, [".wav"]);
	copyDir(SKILLS_SRC, SKILLS_DST, [".md"]);
	await installVendor();
	removeLegacyExtensions();
	applySettings();
	installModelsJson();
	await installAgentsMd();
	generateTsconfig();
	installFontFallback();

	// 5. 复杂外部依赖、pi 补丁、可选依赖 rtk（均失败不阻塞；dry-run 下只预览）
	await installExternalDeps();
	await applyPatches();
	await ensureRtk();

	if (dryRun) {
		console.log("\n试运行完成（未做任何修改），去掉 --dry-run 正式安装。");
		return;
	}
	console.log("\n安装完成。在 pi 里执行 /reload 或重启后生效。");
	console.log("\n下一步：");
	console.log("  · 配置模型：启动 pi 后 /login <provider> 添加认证，或 export API_KEY 环境变量（key 支持 $ENV 语法）");
	console.log("  · 启动：pi");
}

if (require.main === module) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports.__test__ = { registerVendorPackages, copyAll, copyDir };
