#!/usr/bin/env node
/**
 * pi 一键配置安装脚本
 *
 * 把本项目的 themes/、extensions/ 和 sounds/ 安装到 pi 全局配置目录：
 *   ~/.pi/agent/themes/      （主题）
 *   ~/.pi/agent/extensions/  （扩展）
 *   ~/.pi/agent/sounds/      （提示音）
 * 并把 settings.json 的 theme 设为本项目主题。
 *
 * 用法：
 *   node install.js          安装
 *   node install.js --dry-run  试运行（只显示将要做什么，不修改）
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = __dirname;
const PI_AGENT = path.join(os.homedir(), ".pi", "agent");
const THEMES_SRC = path.join(ROOT, "themes");
const EXT_SRC = path.join(ROOT, "extensions");
const SOUNDS_SRC = path.join(ROOT, "sounds");
const THEMES_DST = path.join(PI_AGENT, "themes");
const EXT_DST = path.join(PI_AGENT, "extensions");
const SOUNDS_DST = path.join(PI_AGENT, "sounds");

const THEME_NAME = "matrix"; // 默认启用的主题（对应 themes/matrix.json）

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const log = (...m) => console.log((dryRun ? "[DRY-RUN] " : "") + m.join(" "));

function copyDir(src, dst, exts = [".json", ".ts"]) {
	if (!fs.existsSync(src)) {
		log(`跳过（目录不存在）: ${src}`);
		return;
	}
	fs.mkdirSync(dst, { recursive: true });
	for (const f of fs.readdirSync(src)) {
		if (!exts.some((e) => f.endsWith(e))) continue;
		const from = path.join(src, f);
		const to = path.join(dst, f);
		log(`复制 ${path.relative(ROOT, from)} -> ${to}`);
		if (!dryRun) fs.copyFileSync(from, to);
	}
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

function main() {
	console.log(`pi 一键配置安装 → ${PI_AGENT}\n`);
	if (!fs.existsSync(path.join(THEMES_SRC, `${THEME_NAME}.json`))) {
		console.error(`错误: 找不到默认主题 ${THEME_NAME}.json`);
		process.exit(1);
	}
	copyDir(THEMES_SRC, THEMES_DST);
	copyDir(EXT_SRC, EXT_DST);
	copyDir(SOUNDS_SRC, SOUNDS_DST, [".wav"]);
	applySettings();
	console.log(dryRun ? "\n试运行完成（未做任何修改），去掉 --dry-run 正式安装。" : "\n安装完成。在 pi 里执行 /reload 或重启后生效。");
}

main();
