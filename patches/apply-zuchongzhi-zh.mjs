#!/usr/bin/env node
/**
 * 祖冲之汉化补丁（Zu Chongzhi：祖冲之算 π，π 的汉化者）
 *
 * 背景：pi 无官方 i18n（settings.json 无 language 字段，TUI 文案硬编码英文）。
 * 扩展 API 只有「新增渲染」钩子（registerMessageRenderer 按 customType 精确匹配、
 * registerMarkdownTransformer 只作用于消息区域），没有覆盖原生 UI（footer/菜单/
 * 对话框//settings 界面）的钩子；主题 themes/*.json 是纯颜色 schema，无文字字段。
 * 因此汉化只能直接替换全局安装 dist 编译产物里的硬编码字符串。
 *
 * 覆盖范围（首批高频可见文案，按文件定向替换）：
 *   - settings-selector.js   /settings 界面全部标题/描述/按钮（~77 条）
 *   - session-selector.js    /resume 会话选择器
 *   - tree-selector.js       /tree 树选择器（标签提示 + 消息前缀）
 *   - model-selector.js      /model 模型选择器
 *   - login-dialog.js        登录对话框（提示 fallback 文本）
 *   - trust-selector.js      项目信任选择器
 *   - config-selector.js     /config 资源配置器（扩展/技能/主题等节名）
 *   - footer.js              底部状态栏（no-model / thinking off / sub / auto）
 *   - interactive-mode.js    命令反馈、usage 信息面板、警告提示（~90 条）
 *
 * 安全策略（逐个核对过 dist 源码上下文，见上方替换表注释）：
 *   1. 只替换首字母大写的 UI 展示文案（label/标题/描述/提示）；
 *      绝不碰小写 value（"apply"/"save and go back"/"all"/"dark" 等是配置值或
 *      下拉框返回值，替换会改变 pi 行为）。
 *   2. 排除颜色 key（accent/dim/error/muted/success/warning...）、快捷键 key
 *      （app.* / tui.*）、模块名（node:*）、HTTP 头名（User-Agent）。
 *   3. 同文件内子串冲突（"Theme" ⊂ "Dark Theme"）由「按原文长度降序替换」保证：
 *      先换长串再换短串，长串替换后不再含短串。
 *   4. 写盘前对替换结果跑 node --check（临时 .mjs，仅语法检查不执行）验证，
 *      失败则不写盘并报错；替换前自动备份原文件。
 *
 * 用法：
 *   node patches/apply-zuchongzhi-zh.mjs            应用汉化（幂等，已汉化则跳过）
 *   node patches/apply-zuchongzhi-zh.mjs --dry-run  试运行（只打印将替换的数量）
 *   node patches/apply-zuchongzhi-zh.mjs --restore  从备份还原英文原文
 *
 * 环境变量（测试/调试用）：
 *   PI_HAN_ROOT  覆盖 pi 安装根目录（默认 npm root -g 探测）
 *   PI_HAN_TMP   覆盖状态/备份目录（默认 ~/.pi/agent/tmp/zuchongzhi/）
 *
 * 幂等与升级：~/.pi/agent/tmp/zuchongzhi/state.json 记录每个文件 SHA256，
 * 哈希一致则跳过；pi 升级覆盖 dist 后哈希变化，自动重新打补丁。
 * 缺失目标串（pi 升级导致文案变动）只警告不致命，汇总列出供人工核对。
 * 汉化后用 /reload 或重启 pi 生效；不改会话文件，不影响 LLM 上下文。
 */
import { execSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const restore = process.argv.includes("--restore");
const log = (...m) => console.log((dryRun ? "[DRY-RUN] " : "") + m.join(" "));

// ---------------------------------------------------------------------------
// 替换表：文件相对路径（相对 dist/modes/interactive/）→ [原文, 译文] 列表。
// 条目顺序无要求，执行时按原文长度降序保证子串安全。
// ---------------------------------------------------------------------------
const PATCHES = {
	// ---- /settings 界面：全部为首字母大写的 label/标题/描述，value 是小写，不碰 ----
	"components/settings-selector.js": [
		["Action when pressing Escape twice with empty editor", "在编辑器为空时按两次 Esc 的动作"],
		["Automatically compact context when it gets too large", "上下文过大时自动压缩"],
		["Choose themes for terminal light and dark appearance.", "为终端浅色和深色外观选择主题。"],
		["Clear empty rows when content shrinks (may cause flicker)", "内容收缩时清除空行（可能闪烁）"],
		["Color theme for the interface", "界面颜色主题"],
		["Default filter when opening /tree", "打开 /tree 时的默认过滤器"],
		["Disable verbose printing at startup", "启动时禁用冗长输出"],
		["Double-escape action", "双击 Esc 的动作"],
		["Editor padding", "编辑器内边距"],
		["Enable or disable individual warnings", "启用或禁用单项警告"],
		["Fallback behavior when no extension or saved trust decision decides project trust", "当扩展或已保存的信任决定均未决策项目信任时的回退行为"],
		["Hide thinking blocks in assistant responses", "隐藏助手回复中的思考块"],
		["Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.", "等待 HTTP 响应头或正文分块的最大空闲间隔。本地模型暂停超过五分钟时请禁用。"],
		["Preferred inline image width in terminal cells", "终端单元格中内联图片的优选宽度"],
		["Preferred transport for providers that support multiple transports", "支持多种传输方式的提供商的首选传输"],
		["Prevent images from being sent to LLM providers", "阻止图片发送给 LLM 提供商"],
		["Reasoning depth for thinking-capable models", "支持思考的模型的推理深度"],
		["Register skills as /skill:name commands", "将技能注册为 /skill:name 命令"],
		["Render Mermaid code blocks as Unicode diagrams", "将 Mermaid 代码块渲染为 Unicode 图表"],
		["Render images inline in terminal", "在终端内联渲染图片"],
		["Select reasoning depth for thinking-capable models", "为支持思考的模型选择推理深度"],
		["Select the theme to use for dark terminal appearance", "选择深色终端外观使用的主题"],
		["Select the theme to use for light terminal appearance", "选择浅色终端外观使用的主题"],
		["Send an anonymous version/update ping after changelog-detected updates", "检测到更新后发送匿名版本/更新信号"],
		["Show condensed changelog after updates", "更新后显示精简更新日志"],
		["Show the terminal cursor while still positioning it for IME support", "为 IME 支持定位光标的同时显示终端光标"],
		["Show transcript notices for significant prompt-cache misses", "对显著的提示缓存未命中显示记录提示"],
		["Switch to one theme for light and dark", "浅色深色共用同一主题"],
		["Theme to use in automatic mode when the terminal is dark", "自动模式下终端为深色时使用的主题"],
		["Theme to use in automatic mode when the terminal is light", "自动模式下终端为浅色时使用的主题"],
		["Use separate themes for light and dark terminal appearance", "浅色和深色终端外观使用不同主题"],
		["Warn when Anthropic subscription auth may use paid extra usage", "当 Anthropic 订阅认证可能产生付费额外用量时发出警告"],
		["Automatic Theme", "自动主题"],
		["Always trust", "始终信任"],
		["Anthropic extra usage", "Anthropic 额外用量"],
		["Autocomplete max items", "自动补全最大条目数"],
		["Block images", "阻止图片"],
		["Cache miss notices", "缓存未命中提示"],
		["Change mode", "切换模式"],
		["Clear on shrink", "收缩时清屏"],
		["Collapse changelog", "折叠更新日志"],
		["Default project trust", "默认项目信任"],
		["Follow-up mode", "跟进模式"],
		["Fullscreen scrollbar", "全屏滚动条"],
		["HTTP idle timeout", "HTTP 空闲超时"],
		["Hide thinking", "隐藏思考"],
		["Image width", "图片宽度"],
		["Install telemetry", "安装遥测"],
		["Maximum reasoning", "最大推理"],
		["Mermaid diagrams", "Mermaid 图表"],
		["Never trust", "永不信任"],
		["No reasoning", "无推理"],
		["Output padding", "输出内边距"],
		["Quiet startup", "安静启动"],
		["Save and go back", "保存并返回"],
		["Show hardware cursor", "显示硬件光标"],
		["Show images", "显示图片"],
		["Skill commands", "技能命令"],
		["Steering mode", "转向模式"],
		["Terminal progress", "终端进度"],
		["Thinking Level", "思考级别"],
		["Thinking level", "思考级别"],
		["Transport", "传输方式"],
		["Tree filter mode", "树过滤器模式"],
		["Automatic", "自动"],
		["Dark Theme", "深色主题"],
		["Dark theme", "深色主题"],
		["Light Theme", "浅色主题"],
		["Light theme", "浅色主题"],
		["Apply", "应用"],
		["Ask", "询问"],
		["Theme", "主题"],
		["Warnings", "警告"],
		["TUI mode", "TUI 模式"],
	],
	// ---- /resume 会话选择器：大写 label 安全，value 是小写（all/recent/threaded）----
	"components/session-selector.js": [
		["Cannot delete the currently active session", "无法删除当前活动会话"],
		["Resume Session (Current Folder)", "恢复会话（当前文件夹）"],
		["Resume Session (All)", "恢复会话（全部）"],
		["Session moved to trash", "会话已移入回收站"],
		["Rename Session", "重命名会话"],
		["Session deleted", "会话已删除"],
		["Current folder", "当前文件夹"],
		["Name: ", "名称："],
		["Sort: ", "排序："],
		["Threaded", "线程化"],
		["Named", "已命名"],
		["Recent", "最近"],
		["Unknown error", "未知错误"],
		["Fuzzy", "模糊"],
		["All", "全部"],
	],
	// ---- /tree 树选择器 ----
	"components/tree-selector.js": [
		["Label (empty to remove):", "标签（留空删除）："],
		["Type to search:", "输入搜索："],
		["branch summary", "分支摘要"],
		["assistant: ", "助手："],
		["user: ", "用户："],
	],
	// ---- /model 模型选择器 ----
	"components/model-selector.js": [
		["Model catalogs refreshed.", "模型目录已刷新。"],
		["Only showing models from configured providers. Use /login to add providers.", "仅显示已配置提供商的模型。使用 /login 添加提供商。"],
		["Scope: ", "范围："],
		["no results", "无结果"],
	],
	// ---- 登录对话框：keyHint 的英文 fallback（快捷键找不到时显示），替换后为 "(esc 取消)" 形式 ----
	"components/login-dialog.js": [
		["to cancel,", "取消，"],
		["Login cancelled", "登录已取消"],
		["to cancel", "取消"],
		["to submit", "提交"],
		["to close", "关闭"],
	],
	// ---- 项目信任选择器 ----
	"components/trust-selector.js": [["Project trust", "项目信任"]],
	// ---- /config 资源配置器：节名标题 ----
	"components/config-selector.js": [
		["Project Local Resources", "项目本地资源"],
		["Global Resources", "全局资源"],
		["Project settings", "项目设置"],
		["User settings", "用户设置"],
		["Extensions", "扩展"],
		["Prompts", "提示模板"],
		["Themes", "主题"],
		["Skills", "技能"],
	],
	// ---- footer 状态栏 ----
	"components/footer.js": [
		// thinking off 位于模板字符串内（`${modelName} • thinking off`），无引号匹配；
		// 源码中仅此一处出现，无歧义
		["thinking off", "思考关闭", false],
		["no-model", "无模型"],
		[" (auto)", " (自动)"],
		[" (sub)", " (订阅)"],
	],
	// ---- interactive-mode.js：命令反馈 / usage 信息面板 / 警告提示（长串在前保证子串安全）----
	"interactive-mode.js": [
		["Close active overlays before changing TUI mode", "切换 TUI 模式前请关闭活动浮层"],
		["Suspend to background is not supported on Windows", "Windows 不支持挂起到后台"],
		["Wait for compaction to finish before reloading.", "请等待压缩完成后再重新加载。"],
		["Wait for the current response to finish before reloading.", "请等待当前响应完成后再重新加载。"],
		["Package updates are available. Run ", "有可用的软件包更新。运行 "],
		["Select authentication method:", "选择认证方式："],
		["GitHub CLI (gh) is not installed. Install it from https://cli.github.com/", "未安装 GitHub CLI（gh）。请从 https://cli.github.com/ 安装"],
		["Custom summarization instructions", "自定义摘要说明"],
		["Current model does not support thinking", "当前模型不支持思考"],
		["Copied last agent message to clipboard", "已将最后一条助手消息复制到剪贴板"],
		["Copied selected message to clipboard", "已复制所选消息到剪贴板"],
		["Selected entry has no text to copy", "所选条目没有可复制的文本"],
		["Cache miss after model switch", "模型切换后缓存未命中"],
		["Queued message for after compaction", "已排队压缩后的消息"],
		["Model catalogs refreshed.", "模型目录已刷新。"],
		["Model selection saved to settings", "模型选择已保存到设置"],
		["No API key providers available.", "没有可用的 API 密钥提供商。"],
		["No subscription providers available.", "没有可用的订阅提供商。"],
		["No login methods available.", "没有可用的登录方式。"],
		["No login providers available.", "没有可用的登录提供商。"],
		["No agent messages to copy yet.", "还没有可复制的助手消息。"],
		["No changelog entries found.", "未找到更新日志条目。"],
		["No queued messages to restore", "没有要恢复的排队消息"],
		["Waiting for authentication...", "正在等待认证..."],
		["Failed to parse gist ID from gh output", "无法从 gh 输出解析 gist ID"],
		["Keyboard Shortcuts", "键盘快捷键"],
		["Resumed session in current cwd", "已在当前目录恢复会话"],
		["Package Updates Available", "有可用的软件包更新"],
		["Navigated to selected point", "已导航到所选位置"],
		["Session cwd not found", "未找到会话工作目录"],
		["Auto-compaction cancelled", "自动压缩已取消"],
		["Branch summarization cancelled", "分支摘要已取消"],
		["Compaction cancelled", "压缩已取消"],
		["Resume cancelled", "恢复已取消"],
		["Import cancelled", "导入已取消"],
		["Share cancelled", "分享已取消"],
		["Login cancelled", "登录已取消"],
		["Navigation cancelled", "导航已取消"],
		["Only one model available", "只有一个可用模型"],
		["Only one model in scope", "范围内只有一个模型"],
		["No messages to fork from", "没有可派生的消息"],
		["Nothing to clone yet", "还没有可克隆的内容"],
		["No entries in session", "会话中没有条目"],
		["Failed to create session", "创建会话失败"],
		["Failed to fork session", "派生会话失败"],
		["Failed to import session", "导入会话失败"],
		["Failed to resume session", "恢复会话失败"],
		["Cloned to new session", "已克隆到新会话"],
		["Forked to new session", "已派生到新会话"],
		["Import session", "导入会话"],
		["Resumed session", "已恢复会话"],
		["Session Info", "会话信息"],
		["Unknown error occurred", "发生未知错误"],
		["Update Available", "有可用更新"],
		["To resume this session:", "要恢复此会话："],
		["Sign in with an API key", "使用 API 密钥登录"],
		["Sign in with an account", "使用账户登录"],
		["Summarize with custom prompt", "使用自定义提示词摘要"],
		["Operation aborted", "操作已中止"],
		["Fullscreen layout is not initialized", "全屏布局尚未初始化"],
		["Already at this point", "已在此位置"],
		["Creating gist...", "正在创建 gist..."],
		["Unknown error", "未知错误"],
		["Thinking...", "思考中..."],
		["Working...", "处理中..."],
		["Cache Re-billed:", "缓存重新计费："],
		["Cache miss", "缓存未命中"],
		["Changelog: ", "更新日志："],
		["Summarize", "摘要"],
		["Cached:", "缓存："],
		["Uncached:", "未缓存："],
		["Output:", "输出："],
		["Total:", "总计："],
		["Assistant:", "助手："],
		["User:", "用户："],
		["Tools:", "工具："],
		["Input:", "输入："],
		["In-memory", "内存中"],
		["Packages:", "软件包："],
		["Authentication", "认证"],
		["Messages", "消息"],
		["Context", "上下文"],
		["Tokens", "令牌"],
		["Extensions", "扩展"],
		["Themes", "主题"],
		["Prompts", "提示模板"],
		["Skills", "技能"],
		["No summary", "无摘要"],
	],
};

/** 探测 pi 安装根目录（含 dist/modes/interactive/ 的包根）。 */
function findPiRoot() {
	if (process.env.PI_HAN_ROOT) return process.env.PI_HAN_ROOT;
	try {
		// execSync 走 shell，Windows 下能解析 npm.cmd
		const root = execSync("npm root -g", { encoding: "utf8" }).trim();
		if (root && fs.existsSync(path.join(root, "@earendil-works", "pi-coding-agent"))) {
			return path.join(root, "@earendil-works", "pi-coding-agent");
		}
	} catch {}
	throw new Error("未找到 pi 全局安装（npm root -g 探测失败），可设置 PI_HAN_ROOT 指定安装根目录");
}

function sha256(s) {
	return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** 正则转义：from 里可能含 . / ( ) : 等字符。 */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 对替换结果做语法校验（node --check，仅解析不执行）。 */
function syntaxCheck(content) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zuchongzhi-"));
	const tmpFile = path.join(tmpDir, "check.mjs");
	fs.writeFileSync(tmpFile, content, "utf8");
	try {
		const r = spawnSync(process.execPath, ["--check", tmpFile], { encoding: "utf8" });
		if (r.status !== 0) {
			return `node --check 失败: ${(r.stderr || r.stdout || "").trim()}`;
		}
		return null;
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

function main() {
	if (restore) {
		const root = findPiRoot();
		const tmpDir = process.env.PI_HAN_TMP || path.join(os.homedir(), ".pi", "agent", "tmp", "zuchongzhi");
		const backupDir = path.join(tmpDir, "backup");
		const interactiveDir = path.join(root, "dist", "modes", "interactive");
		if (!fs.existsSync(backupDir)) {
			console.log("没有备份目录，无需还原。");
			return;
		}
		let restored = 0;
		for (const rel of fs.readdirSync(backupDir, { recursive: true })) {
			const from = path.join(backupDir, rel);
			if (!fs.statSync(from).isFile()) continue;
			const to = path.join(interactiveDir, rel);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
			restored++;
			console.log(`已还原: ${rel}`);
		}
		fs.rmSync(path.join(tmpDir, "state.json"), { force: true });
		console.log(`还原完成（${restored} 个文件），已清除汉化状态记录。重启 pi 生效。`);
		return;
	}

	const root = findPiRoot();
	const interactiveDir = path.join(root, "dist", "modes", "interactive");
	if (!fs.existsSync(interactiveDir)) {
		console.error(`找不到 dist/modes/interactive/: ${interactiveDir}`);
		process.exit(1);
	}
	const tmpDir = process.env.PI_HAN_TMP || path.join(os.homedir(), ".pi", "agent", "tmp", "zuchongzhi");
	const backupDir = path.join(tmpDir, "backup");
	const statePath = path.join(tmpDir, "state.json");
	if (!dryRun) fs.mkdirSync(backupDir, { recursive: true });
	const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};

	let totalReplaced = 0;
	let totalSkipped = 0;
	let totalMissing = 0;
	const missingReports = [];
	let syntaxError = null;

	for (const [rel, entries] of Object.entries(PATCHES)) {
		const absPath = path.join(interactiveDir, rel);
		if (!fs.existsSync(absPath)) {
			console.warn(`⚠ 文件不存在（pi 版本可能已变动）: ${rel}`);
			continue;
		}
		const src = fs.readFileSync(absPath, "utf8");
		const srcSha = sha256(src);

		if (!dryRun && state[absPath] === srcSha) {
			console.log(`已汉化，跳过: ${rel}`);
			totalSkipped++;
			continue;
		}

		// 按原文长度降序替换，保证 "Theme" ⊂ "Dark Theme" 这类子串先长后短
		// 按原文长度降序替换（双保险）；默认只匹配双引号字符串字面量（"<原文>"），
		// 绝不碰 JS 标识符/属性名（如 onTerminalInput: 含 Input 子串）；
		// 显式传 false 的条目做无引号匹配（仅限模板字符串内、确认无歧义的文案）。
		let out = src;
		let replaced = 0;
		const missing = [];
		for (const [from, to, quoted = true] of [...entries].sort((a, b) => b[0].length - a[0].length)) {
			const needle = quoted ? '"' + from + '"' : from;
			const re = new RegExp(escapeRegExp(needle), "g");
			let count = 0;
			out = out.replace(re, () => {
				count++;
				return quoted ? '"' + to + '"' : to;
			});
			if (count === 0) {
				// 未命中：若原文（对应形式）本身也不含该串，记缺失
				if (!src.includes(needle)) missing.push(from);
			} else {
				replaced += count;
			}
		}

		if (missing.length > 0) {
			totalMissing += missing.length;
			missingReports.push(`  ${rel}: 缺失 ${missing.length} 条目标串（pi 升级后文案变动？）`);
		}
		totalReplaced += replaced;

		if (dryRun) {
			console.log(`将替换 ${replaced} 处: ${rel}`);
			continue;
		}

		const err = syntaxCheck(out);
		if (err) {
			syntaxError = `${rel}: ${err}`;
			break;
		}
		// 备份原文件（首次）
		const backupPath = path.join(backupDir, rel);
		if (!fs.existsSync(backupPath)) {
			fs.mkdirSync(path.dirname(backupPath), { recursive: true });
			fs.copyFileSync(absPath, backupPath);
		}
		fs.writeFileSync(absPath, out, "utf8");
		state[absPath] = sha256(out);
		console.log(`已替换 ${replaced} 处: ${rel}`);
	}

	if (syntaxError) {
		console.error(`\n✘ 语法校验未通过，未写入该文件（其余文件已写回，可用 --restore 整体还原）:\n  ${syntaxError}`);
		process.exit(1);
	}

	if (!dryRun) fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

	console.log("");
	if (dryRun) {
		console.log(`试运行完成：共将替换 ${totalReplaced} 处（跳过 ${totalSkipped} 个文件），去掉 --dry-run 正式应用。`);
	} else {
		console.log(`祖冲之补丁完成：共替换 ${totalReplaced} 处（跳过 ${totalSkipped} 个已汉化文件）。重启 pi（或 /reload）生效。`);
	}
	if (totalMissing > 0) {
		console.warn(`\n⚠ ${totalMissing} 条目标串未找到，请人工核对 pi 版本（汉化不全属正常，缺了不致命）:`);
		for (const m of missingReports) console.warn(m);
	}
	if (!dryRun) {
		console.log(`备份与状态: ${tmpDir}（还原: node patches/apply-zuchongzhi-zh.mjs --restore）`);
	}
}

main();
