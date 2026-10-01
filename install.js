#!/usr/bin/env node
/**
 * pi 一键环境安装脚本（交互式向导）
 *
 * 新设备拿到本仓库后，一条命令即可完成「pi 本体 + 定制配置」的完整部署：
 *   1. 检测 node 版本（pi 要求 ≥22.19.0，过低仅警告不阻塞）
 *   2. 检测 pi 本体（@earendil-works/pi-coding-agent），缺失则自动 npm i -g
 *   3. 检测构建依赖 esbuild，缺失则自动 npm install（src/ 下）
 *   4. 自动构建扩展产物（src/build.js → dist/extensions/）
 *   5. 安装配置到 ~/.pi/agent/（扩展/主题/提示音/skills/models.json/settings）
 *   6. 可选依赖 rtk 二进制（pi-rtk-optimizer 的命令改写引擎）：PATH 上缺失时询问并自动
 *      下载安装（按平台选 release 资产，GitHub 直连优先、加速镜像回落，checksums.txt 校验；
 *      失败不阻塞安装，插件侧安全降级）
 *   7. 安装 vendor 第三方插件（src/vendor/ → ~/.pi/agent/vendor/，有依赖的补 npm install，
 *      并把本地路径注册进 settings.json 的 packages）；清理已被官方版替代的旧扩展文件
 *
 * 安装到 pi 全局配置目录：
 *   dist/extensions/   → ~/.pi/agent/extensions/  （扩展产物，零耦合单文件）
 *   src/vendor/        → ~/.pi/agent/vendor/      （官方插件源码副本，见 src/vendor/README.md）
 *   static/themes/     → ~/.pi/agent/themes/      （主题）
 *   static/sounds/     → ~/.pi/agent/sounds/      （提示音）
 *   static/skills/     → ~/.pi/agent/skills/      （pi skills：目录含 SKILL.md 被递归发现）
 *   static/models.json → ~/.pi/agent/models.json  （OpenRouter 路由等模型配置，已存在则深度合并）
 *   static/AGENTS.md   → ~/.pi/agent/AGENTS.md    （全局输出受众纪律：标记块合并，块外用户手写内容保留）
 * 并把 settings.json 的 theme 设为本项目主题。
 *
 * 用法：
 *   node install.js               交互式安装（每一步询问确认，默认 yes）
 *   node install.js -y            非交互安装（全部默认 yes，一路到底；非 TTY 环境自动等价）
 *   node install.js --dry-run     试运行（预览，不询问、不修改任何文件）
 *   node install.js --skip-build  跳过自动构建
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawnSync } = require("child_process");
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
const AGENTS_SRC = path.join(ROOT, "static", "AGENTS.md");
const VENDOR_SRC = path.join(ROOT, "src", "vendor");
const THEMES_DST = path.join(PI_AGENT, "themes");
const EXT_DST = path.join(PI_AGENT, "extensions");
const SOUNDS_DST = path.join(PI_AGENT, "sounds");
const SKILLS_DST = path.join(PI_AGENT, "skills");
const VENDOR_DST = path.join(PI_AGENT, "vendor");

// 已删除的自研扩展（src/extensions/ 中删除源码后，install 时同步清理已安装的 stale 副本，
// 避免与 vendor 版命令/工具冲突，如 /btw、bash 输出 hook）
const LEGACY_REMOVED_EXTENSIONS = ["explore-agent.ts", "token-saver.ts", "webui.ts", "paste-image.ts", "task-alert.ts", "btf-think.ts"]; // btf-think 并入 status-beacon // task-alert.ts 改名 status-beacon.ts（全链路状态感知）

const THEME_NAME = "matrix"; // 默认启用的主题（对应 static/themes/matrix.json）
const PI_PACKAGE = "@earendil-works/pi-coding-agent"; // pi 本体包名
const NODE_MIN = "22.19.0"; // pi 要求的最低 node 版本（package.json engines）

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

/** 检测 node 版本是否满足 pi 要求（过低仅返回 ok:false 供警告，不阻塞安装）。 */
function checkNode() {
	const want = NODE_MIN.split(".").map(Number);
	const got = process.versions.node.split(".").map(Number);
	for (let i = 0; i < want.length; i++) {
		const g = got[i] ?? 0;
		if (g > want[i]) break;
		if (g < want[i]) return { ok: false, version: process.versions.node };
	}
	return { ok: true, version: process.versions.node };
}

/** 探测 pi 全局安装根目录（含 @earendil-works/pi-coding-agent 的 node_modules 根）。 */
function findPiGlobalRoot() {
	// 优先 npm root -g（覆盖 Windows/macOS/Linux 的 npm 默认全局目录）
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
		"/usr/local/lib/node_modules", // macOS / brew
		"/usr/lib/node_modules", // Linux 系统 npm
	];
	for (const c of candidates) {
		if (c && fs.existsSync(path.join(c, "@earendil-works", "pi-coding-agent"))) return c;
	}
	return null;
}

/** 安装 pi 本体（npm i -g）；dry-run 只预览。 */
function installPi() {
	log(`安装 pi 本体：npm install -g ${PI_PACKAGE}`);
	if (dryRun) return;
	try {
		execSync(`npm install -g ${PI_PACKAGE}`, { stdio: "inherit" });
	} catch {
		console.error(`\npi 本体安装失败（需要网络）。请手动执行 npm i -g ${PI_PACKAGE} 后重新运行 install.js。`);
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
	installPi();
	if (!dryRun && !findPiGlobalRoot()) {
		console.error("安装后仍检测不到 pi，请确认 npm 全局目录在 PATH 中后重新运行 install.js。");
		process.exit(1);
	}
}

/** 确保构建依赖已安装：src/node_modules/esbuild 缺失（克隆后首次）时交互确认后自动 npm install。 */
async function ensureDeps() {
	if (fs.existsSync(ESBUILD_DIR)) return;
	log("未找到 esbuild（构建依赖）");
	if (!(await confirm("  是否自动执行 npm install 拉取构建依赖（esbuild）？（Y/n）"))) {
		console.error("已取消。请手动执行 cd src && npm install 后重新运行 install.js。");
		process.exit(1);
	}
	log("自动执行 npm install（src/ 下）…");
	if (dryRun) return;
	try {
		execSync("npm install", { cwd: SRC_DIR, stdio: "inherit" });
	} catch {
		console.error("\nnpm install 失败（需要网络）。请手动执行 cd src && npm install 后重新运行 install.js。");
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

function copyDir(src, dst, exts = [".json", ".ts"]) {
	if (!fs.existsSync(src)) {
		log(`跳过（目录不存在）: ${src}`);
		return;
	}
	fs.mkdirSync(dst, { recursive: true });
	for (const f of fs.readdirSync(src, { withFileTypes: true })) {
		const from = path.join(src, f.name);
		// 子目录递归（多文件扩展，如 extensions/hud/{index,balance,cost,git}.ts）
		if (f.isDirectory()) {
			if (f.name === "node_modules") continue;
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
}

function isPlainObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 全量递归复制（vendor 包原样搬运：ts/js/mjs/md/json/png/LICENSE 等所有文件）。 */
function copyAll(src, dst) {
	fs.mkdirSync(dst, { recursive: true });
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
		const n = norm(s);
		return !validVendorDirs.has(n) && n.startsWith(norm(VENDOR_DST + path.sep));
	});
	const staleDirs = stale.map((p) => (typeof p === "string" ? p : String(p?.source ?? "")));
	const keep = packages.filter((p) => !staleDirs.includes(typeof p === "string" ? p : String(p?.source ?? "")));
	for (const dir of staleDirs) {
		log(`注销已移除的 vendor 包: ${dir}`);
		if (!dryRun) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				log(`警告: 删除已安装目录失败: ${dir}（可手动清理）`);
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
function installVendor() {
	if (!fs.existsSync(VENDOR_SRC)) {
		log(`跳过 vendor（目录不存在）: ${VENDOR_SRC}`);
		return;
	}
	const pkgs = fs.readdirSync(VENDOR_SRC, { withFileTypes: true }).filter((d) => d.isDirectory());
	if (pkgs.length === 0) return;
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
				try {
					// execSync 走 shell（本脚本既有风格，如 npm root -g / npm i -g）；
					// spawnSync 直接调 npm.cmd 在 Node 24 会 EINVAL（CVE-2024-27980 缓解）
					execSync("npm install --omit=dev --no-audit --no-fund", { cwd: dst, stdio: "inherit" });
				} catch {
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
		if (!dryRun) fs.rmSync(stale, { force: true });
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

/** 用模板生成 tsconfig.json（paths 指向探测到的 pi 全局目录），换机器/pi 升级后重跑即可。 */
function generateTsconfig() {
	const templatePath = path.join(ROOT, "src", "config", "tsconfig.template.json");
	const outPath = path.join(ROOT, "src", "config", "tsconfig.json");
	if (!fs.existsSync(templatePath)) {
		log(`跳过 tsconfig（模板不存在）: ${templatePath}`);
		return;
	}
	const root = findPiGlobalRoot();
	if (!root) {
		log("跳过 tsconfig（未找到 pi 全局安装目录 @earendil-works/pi-coding-agent，可手动修改 src/config/tsconfig.json）");
		return;
	}
	const template = fs.readFileSync(templatePath, "utf8");
	const out = template.replace(/__PI_ROOT__/g, root.replace(/\\/g, "/")); // 统一正斜杠，JSON 免转义
	log(`生成 src/config/tsconfig.json（paths → ${root}）`);
	if (!dryRun) fs.writeFileSync(outPath, out, "utf8");
}

async function main() {
	console.log(`pi 一键环境安装 → ${PI_AGENT}\n`);

	// 0. 环境检测报告（非交互，只展示）
	const node = checkNode();
	console.log(`检测环境：`);
	console.log(`  node ${node.version} ${node.ok ? "✓" : `✗（pi 要求 ≥ ${NODE_MIN}，建议先升级 node 再启动 pi）`}`);
	const piRootBefore = findPiGlobalRoot();
	console.log(`  pi 本体 ${piRootBefore ? `✓ ${piRootBefore}` : `✗ 未安装（${PI_PACKAGE}）`}`);
	console.log(`  构建依赖 esbuild ${fs.existsSync(ESBUILD_DIR) ? "✓" : "✗ 未安装"}`);
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
			console.error(`错误: 自动构建后仍找不到产物 ${DIST}。请先手动运行 node build.js 排查（或用 --skip-build 跳过自动构建）。`);
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
	copyDir(SOUNDS_SRC, SOUNDS_DST, [".wav"]);
	copyDir(SKILLS_SRC, SKILLS_DST, [".md"]);
	installVendor();
	removeLegacyExtensions();
	applySettings();
	installModelsJson();
	await installAgentsMd();
	generateTsconfig();

	// 5. 可选依赖 rtk（失败不阻塞）；dry-run 下只预览
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

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
