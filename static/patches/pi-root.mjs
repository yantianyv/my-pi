/**
 * pi 安装位置探测（static/patches/ 下补丁脚本共用）。
 *
 * 两种布局都要认：
 *   - 托管安装（pi 自带安装器 / pi update）：<agent>/install/releases/<版本>/node_modules，
 *     启动器是 <agent>/bin/pi（sh），运行时环境带 PI_MANAGED_INSTALL_ROOT
 *   - npm 全局安装：<npm root -g>/@earendil-works/pi-coding-agent
 *
 * 本模块不参与构建；pi 升级后随补丁脚本一起重跑。
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** PATH 上第一个 pi（**不解析符号链接**，bin 目录要用它本身的位置）。找不到返回 null。 */
function launcherOnPath() {
	try {
		const out = execSync(process.platform === "win32" ? "where pi" : "command -v pi", { encoding: "utf8", windowsHide: true }).trim();
		return out.split(/\r?\n/)[0] || null;
	} catch {
		return null;
	}
}

/** 托管安装根（含 managed-install.json 的目录）：PI_MANAGED_INSTALL_ROOT 优先，其次由启动器实路径反推。 */
export function managedInstallRoot() {
	const launcher = launcherOnPath();
	let realLauncher = null;
	try {
		realLauncher = launcher ? fs.realpathSync(launcher) : null;
	} catch {}
	const candidates = [
		process.env.PI_MANAGED_INSTALL_ROOT,
		realLauncher ? path.join(path.dirname(path.dirname(realLauncher)), "install") : null,
	];
	for (const c of candidates) {
		if (!c) continue;
		const root = path.resolve(c);
		if (fs.existsSync(path.join(root, "managed-install.json"))) return root;
	}
	return null;
}

/** pi-coding-agent 包根（含 dist/）。找不到时抛错，提示用环境变量指定。 */
export function piPackageRoot() {
	const managed = managedInstallRoot();
	if (managed) {
		try {
			const version = fs.readFileSync(path.join(managed, "current-version"), "utf8").trim();
			const pkg = path.join(managed, "releases", version, "node_modules", ...PI_PACKAGE.split("/"));
			if (fs.existsSync(path.join(pkg, "package.json"))) return pkg;
		} catch {}
	}
	const roots = [];
	try {
		roots.push(execSync("npm root -g", { encoding: "utf8", windowsHide: true }).trim());
	} catch {}
	roots.push(
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : null,
		path.join(os.homedir(), ".npm-global", "node_modules"),
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
	);
	for (const root of roots) {
		if (!root) continue;
		const pkg = path.join(root, ...PI_PACKAGE.split("/"));
		if (fs.existsSync(path.join(pkg, "package.json"))) return pkg;
	}
	throw new Error("未找到 pi 安装目录（托管安装与 npm 全局均未命中），可用 PI_MANAGED_INSTALL_ROOT / PI_HAN_ROOT 指定");
}

/** pi 安装的 node_modules 根（@earendil-works/ 的上一级）。 */
export function piNodeModulesRoot() {
	return path.dirname(path.dirname(piPackageRoot()));
}

/** pi 依赖包目录（如 @earendil-works/pi-ai）：嵌套布局优先，其次提升布局。 */
export function piPackageDir(name) {
	const modules = piNodeModulesRoot();
	const nested = path.join(modules, ...PI_PACKAGE.split("/"), "node_modules", ...name.split("/"));
	const hoisted = path.join(modules, ...name.split("/"));
	for (const dir of [nested, hoisted]) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
	}
	return hoisted;
}

/** 启动垫片所在目录（去重，按「实际在用 → 托管 → npm 全局」排序）：补丁只改真正被执行的垫片。
 *  用 PATH 上的启动器位置本身（不解析符号链接）——npm 11 起全局 bin 的 pi 是符号链接，
 *  要补的就是该链接所在目录。 */
export function piBinDirs() {
	const dirs = [];
	const launcher = launcherOnPath();
	if (launcher) dirs.push(path.dirname(launcher));
	const managed = managedInstallRoot();
	if (managed) dirs.push(path.join(path.dirname(managed), "bin"));
	try {
		const prefix = execSync("npm prefix -g", { encoding: "utf8", windowsHide: true }).trim();
		if (prefix) dirs.push(path.join(prefix, process.platform === "win32" ? "" : "bin"));
	} catch {}
	return [...new Set(dirs)];
}
