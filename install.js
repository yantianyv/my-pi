#!/usr/bin/env node
/**
 * pi 一键配置安装脚本
 *
 * 把 build.js 生成的 dist/ 部署物安装到 pi 全局配置目录：
 *   dist/themes/      → ~/.pi/agent/themes/      （主题）
 *   dist/extensions/  → ~/.pi/agent/extensions/  （扩展产物，零耦合单文件）
 *   dist/sounds/      → ~/.pi/agent/sounds/      （提示音）
 *   dist/models.json  → ~/.pi/agent/models.json  （OpenRouter 路由等模型配置，已存在则深度合并）
 * 并把 settings.json 的 theme 设为本项目主题。
 *
 * 用法：
 *   node install.js          安装
 *   node install.js --dry-run  试运行（只显示将要做什么，不修改）
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawnSync } = require("child_process");

const ROOT = __dirname;
const PI_AGENT = path.join(os.homedir(), ".pi", "agent");
// 只安装 build.js 的产物；install 默认先自动执行一次 build（--skip-build 可跳过）
const DIST = path.join(ROOT, "dist");
const BUILD_SCRIPT = path.join(ROOT, "build.js");
const THEMES_SRC = path.join(DIST, "themes");
const EXT_SRC = path.join(DIST, "extensions");
const SOUNDS_SRC = path.join(DIST, "sounds");
const MODELS_SRC = path.join(DIST, "models.json");
const THEMES_DST = path.join(PI_AGENT, "themes");
const EXT_DST = path.join(PI_AGENT, "extensions");
const SOUNDS_DST = path.join(PI_AGENT, "sounds");

const THEME_NAME = "matrix"; // 默认启用的主题（对应 dist/themes/matrix.json）

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const skipBuild = process.argv.includes("--skip-build");
const log = (...m) => console.log((dryRun ? "[DRY-RUN] " : "") + m.join(" "));

/** 自动构建：install 前先跑 build.js（dry-run 只预览不构建；--skip-build 显式跳过） */
function autoBuild() {
	if (!fs.existsSync(BUILD_SCRIPT)) {
		console.error(`错误: 未找到构建脚本 ${BUILD_SCRIPT}`);
		process.exit(1);
	}
	log(`自动构建：node ${path.relative(ROOT, BUILD_SCRIPT)}`);
	if (dryRun) return; // 试运行不执行
	const r = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: ROOT, stdio: "inherit" });
	if (r.status !== 0) {
		console.error(
			`\n构建失败（退出码 ${r.status}）。请先执行 cd src && npm install（拉取 esbuild），再重新 install。`,
		);
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
		if (!dryRun) fs.copyFileSync(from, to);
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

/** 探测 pi 全局安装根目录（含 @earendil-works/pi-coding-agent 的 node_modules 根）。 */
function findPiGlobalRoot() {
	// 优先 npm root -g（覆盖 Windows/macOS/Linux 的 npm 默认全局目录）
	try {
		const root = execSync("npm root -g", { encoding: "utf8", windowsHide: true }).trim();
		if (root && fs.existsSync(path.join(root, "@earendil-works", "pi-coding-agent"))) return root;
	} catch {}
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

function main() {
	console.log(`pi 一键配置安装 → ${PI_AGENT}\n`);
	// 默认自动构建（dry-run / --skip-build 跳过）；构建失败即退出
	if (!skipBuild) autoBuild();
	// 构建后 dist 应已生成；仍缺失时：dry-run 给出预期说明，正式安装报错退出
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
	copyDir(THEMES_SRC, THEMES_DST);
	copyDir(EXT_SRC, EXT_DST);
	copyDir(SOUNDS_SRC, SOUNDS_DST, [".wav"]);
	applySettings();
	installModelsJson();
	generateTsconfig();
	console.log(dryRun ? "\n试运行完成（未做任何修改），去掉 --dry-run 正式安装。" : "\n安装完成。在 pi 里执行 /reload 或重启后生效。");
}

main();
