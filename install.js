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
 *
 * 安装到 pi 全局配置目录：
 *   dist/extensions/   → ~/.pi/agent/extensions/  （扩展产物，零耦合单文件）
 *   static/themes/     → ~/.pi/agent/themes/      （主题）
 *   static/sounds/     → ~/.pi/agent/sounds/      （提示音）
 *   static/skills/     → ~/.pi/agent/skills/      （pi skills：目录含 SKILL.md 被递归发现）
 *   static/models.json → ~/.pi/agent/models.json  （OpenRouter 路由等模型配置，已存在则深度合并）
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
const THEMES_DST = path.join(PI_AGENT, "themes");
const EXT_DST = path.join(PI_AGENT, "extensions");
const SOUNDS_DST = path.join(PI_AGENT, "sounds");
const SKILLS_DST = path.join(PI_AGENT, "skills");

const THEME_NAME = "matrix"; // 默认启用的主题（对应 static/themes/matrix.json）
const PI_PACKAGE = "@earendil-works/pi-coding-agent"; // pi 本体包名
const NODE_MIN = "22.19.0"; // pi 要求的最低 node 版本（package.json engines）

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const skipBuild = process.argv.includes("--skip-build");
const nonInteractive = process.argv.includes("-y") || process.argv.includes("--yes");
const log = (...m) => console.log((dryRun ? "[DRY-RUN] " : "") + m.join(" "));

const SRC_DIR = path.join(ROOT, "src");
const ESBUILD_DIR = path.join(SRC_DIR, "node_modules", "esbuild");

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
	applySettings();
	installModelsJson();
	generateTsconfig();

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
