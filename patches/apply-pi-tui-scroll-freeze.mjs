/**
 * pi-tui 滚动冻结补丁 V4（scroll-freeze，适配 pi 0.84.x）
 *
 * 背景：pi 流式输出时，AssistantMessageComponent 每帧都从 markdown 源码重渲染整条消息，
 * 消息开头几行（段落重排/代码块高亮/表格列宽）会持续变化。一旦消息开头滚出视口，
 * pi-tui 的差分渲染判定 firstChanged < prevViewportTop，触发 fullRender(true)：
 * 发送 \x1b[2J\x1b[H\x1b[3J 清空终端滚动缓冲区再全量重写——实测每秒 2~3 次。
 * 用户此时用滚轮翻看历史，滚动缓冲区被反复清空重建，Windows Terminal 滚动位置被拽飞。
 *
 * V4 变更（pi 0.84.0 起）：
 * - 差分渲染逻辑从 dist/tui.js 整体移到 dist/tui-main-screen.js（pi-tui 为全屏模式
 *   拆出 main-screen / alt-screen 两个实现）；fullRender 从类方法改为 doRender() 内闭包。
 * - 补丁目标随之迁移：critical 块（firstChanged < prevViewportTop → fullRender(true)）
 *   与新增的 clearOnShrink 分支（内容收缩整屏重绘）。
 * - V3 的 shrink 分支在 0.84 中从 critical 块内消失，改为独立的 clearOnShrink 分支
 *   （默认关闭：PI_CLEAR_ON_SHRINK=1 才启用）；V3 的小幅收缩视口重绘逻辑保留并移植。
 *
 * 补丁策略（与 Claude Code / Ink <Static> 同款思路）：
 * 1. 流式期间 firstChanged < prevViewportTop：冻结视口上方已滚入滚动缓冲区的内容
 *    （保留流式中间帧），只重绘视口内可见部分，不再清空整个滚动缓冲区。
 *    代价：滚上去看到的旧内容可能是流式中间帧，与最终渲染略有出入——可接受。
 * 2. 内容收缩（shrink）且变化涉及视口上方（逻辑行号位移无法局部差分），按收缩幅度分流：
 *    - 小幅收缩（≤1 屏，任务完成时消息定稿收窄 1~2 行等）：保持视口顶部不变，逐行
 *      \x1b[2K 重写视口内可见行并清掉收缩残留的空行（\x1b[1B 下移不滚动）——不清屏、
 *      不滚动、不动滚动缓冲 → 滚动缓冲（旧帧 0..prevViewportTop）与可见屏
 *      （新帧 prevViewportTop..）行号连续，无重叠。
 *    - 大幅收缩（超 1 屏，或视口顶部已落到内容之外）：滚动缓冲里的旧帧与可见屏大量重叠
 *      且已无意义，清滚动缓冲做整屏重绘（滚动位置跳顶一次，可接受；同步输出下无闪烁）。
 * 3. clearOnShrink 分支（0.84 新增，默认关）：小幅收缩放行到差分渲染路径（尾部会逐行
 *    清多余行），仅大幅收缩保留整屏重绘——避免启用该开关后任务收尾时滚动跳顶。
 *
 * 用法：node patches/apply-pi-tui-scroll-freeze.mjs
 * pi 升级会覆盖 node_modules，需重跑本脚本。改完重启 pi 生效。
 * 幂等：已打 V4 补丁时直接跳过。
 * 另补 interactive-mode.js 三处：全局重建（Ctrl+T 折叠思考、compaction、设置变更、会话切换、主题切换）
 * 必须整屏重绘（requestRender(true)），否则 scroll-freeze 钳制路径会把新旧内容硬拼接。
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MARKER = "PATCH(scroll-freeze)";

// ---- 块 1：critical 块——firstChanged < prevViewportTop 时不再 fullRender(true) ----
// 旧行为：fullRender(true) 发 \x1b[3J 清空滚动缓冲，流式期间每秒 2~3 次，滚动位置被拽飞。
// 新行为：shrink 按幅度分流（大幅整屏重绘 / 小幅视口内重绘），全部变化在视口上方则冻结，
// 其余情况钳制 firstChanged = prevViewportTop 后走差分渲染。
const OLD_CRITICAL_BLOCK = `        // Differential rendering can only touch what was actually visible.
        // If the first changed line is above the previous viewport, we need a full redraw.
        if (firstChanged < prevViewportTop) {
            logRedraw(\`firstChanged < viewportTop (\${firstChanged} < \${prevViewportTop})\`);
            fullRender(true);
            return;
        }`;

const NEW_CRITICAL_BLOCK = `        // Differential rendering can only touch what was actually visible.
        // If the first changed line is above the previous viewport, we need a full redraw.
        if (firstChanged < prevViewportTop) {
            // PATCH(scroll-freeze): 不做整屏重绘——fullRender(true) 会发 \\x1b[3J 清空终端滚动缓冲区，
            // 流式输出期间每秒触发 2~3 次，导致 Windows Terminal 中用户的手动滚动位置被拽飞。
            // 改为冻结视口上方已滚入滚动缓冲区的内容（保留流式中间帧），只重绘视口内可见部分。
            if (newLines.length < this.previousLines.length) {
                // 内容收缩且变化涉及视口上方（逻辑行号位移）：逻辑行号位移无法局部差分。
                // 按收缩幅度分流：
                // - 大幅收缩（超出一屏，或视口顶部已落到内容之外）：滚动缓冲里的旧帧会与
                //   可见屏大量重叠（用户滚动时看到重复内容），且旧帧已无意义——清滚动缓冲
                //   做整屏重绘（滚动位置跳顶一次，可接受；同步输出下无闪烁）。
                // - 小幅收缩（任务完成时消息定稿收窄 1~2 行等）：保持视口顶部不变，重绘视口内
                //   全部行并清掉收缩的空行——不清屏（\\x1b[2J 在 Windows Terminal 会把旧帧残留
                //   进滚动缓冲，与可见屏重叠成"重复绘制"）、不滚动（\\r\\n 在屏幕最后一行会滚动）、
                //   不动滚动缓冲 → 滚动缓冲（旧帧 0..prevViewportTop）与可见屏（新帧
                //   prevViewportTop..）行号连续，无重叠。
                const shrinkDelta = this.previousLines.length - newLines.length;
                if (shrinkDelta > height || newLines.length <= prevViewportTop) {
                    logRedraw(\`firstChanged < viewportTop with large shrink (\${firstChanged} < \${prevViewportTop}, shrink=\${shrinkDelta})\`);
                    fullRender(true);
                    return;
                }
                logRedraw(\`firstChanged < viewportTop with shrink, viewport redraw (\${firstChanged} < \${prevViewportTop}, shrink=\${shrinkDelta})\`);
                // 视口内存在图片行（占多行、无法逐行重写）时保守走整屏重绘
                let viewportHasImage = false;
                for (let i = prevViewportTop; i < this.previousLines.length; i++) {
                    if (isImageLine(this.previousLines[i]) || (i < newLines.length && isImageLine(newLines[i]))) {
                        viewportHasImage = true;
                        break;
                    }
                }
                if (viewportHasImage) {
                    logRedraw(\`viewport contains kitty images, full redraw (\${firstChanged} < \${prevViewportTop})\`);
                    fullRender(true);
                    return;
                }
                // 同步输出内：光标移到视口顶部（屏幕第 0 行），逐行 \\x1b[2K 重写视口内可见行，
                // 再清掉收缩残留的空行（\\x1b[1B 下移不滚动），最后移回内容末尾。
                // 只重写可见行（不超过一屏）：视口顶部若落到内容之外（全屏模式切换恢复的
                // 滚动状态等），超出屏幕的行位于终端滚动缓冲中不可见，保持冻结即可。
                let buf = "\\x1b[?2026h";
                const curScreenRow = hardwareCursorRow - prevViewportTop;
                if (curScreenRow < 0 || curScreenRow >= height) {
                    logRedraw(\`hardware cursor outside viewport (row=\${hardwareCursorRow}), full redraw\`);
                    fullRender(true);
                    return;
                }
                if (curScreenRow > 0)
                    buf += \`\\x1b[\${curScreenRow}A\`;
                buf += "\\r";
                const visibleEnd = Math.min(newLines.length, prevViewportTop + height);
                for (let i = prevViewportTop; i < visibleEnd; i++) {
                    if (i > prevViewportTop)
                        buf += "\\r\\n";
                    buf += "\\x1b[2K" + newLines[i];
                }
                const staleVisible = (prevViewportTop + height) - newLines.length;
                if (staleVisible > 0) {
                    buf += "\\r\\n";
                    for (let i = 0; i < staleVisible; i++) {
                        buf += "\\x1b[2K";
                        if (i < staleVisible - 1)
                            buf += "\\x1b[1B";
                    }
                    buf += \`\\x1b[\${staleVisible}A\`;
                }
                buf += "\\x1b[?2026l";
                this.terminal.write(buf);
                // 同步逻辑状态：视口顶部不变，不清屏故 maxLinesRendered 保持增长语义
                this.cursorRow = Math.max(0, newLines.length - 1);
                this.hardwareCursorRow = Math.max(0, newLines.length - 1);
                this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
                this.previousViewportTop = prevViewportTop;
                this.previousLines = newLines;
                this.previousKittyImageIds = this.collectKittyImageIds(newLines);
                this.previousWidth = width;
                this.previousHeight = height;
                this.positionHardwareCursor(cursorPos, newLines.length);
                return;
            }
            if (lastChanged < prevViewportTop) {
                // 所有变化都在视口上方：全部冻结，无需输出，仅同步逻辑状态
                this.positionHardwareCursor(cursorPos, newLines.length);
                this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
                this.previousLines = newLines;
                this.previousKittyImageIds = this.collectKittyImageIds(newLines);
                this.previousWidth = width;
                this.previousHeight = height;
                this.previousViewportTop = prevViewportTop;
                return;
            }
            logRedraw(\`firstChanged < viewportTop clamped (\${firstChanged} -> \${prevViewportTop})\`);
            firstChanged = prevViewportTop;
        }`;

// ---- 块 2：clearOnShrink 分支——小幅收缩不再整屏重绘 ----
// 0.84 新增分支（默认关闭，PI_CLEAR_ON_SHRINK=1 启用）：内容收缩到低于 maxLinesRendered
// 就 fullRender(true) 清滚动缓冲。任务完成时消息定稿收窄 1~2 行（或流式中间帧短暂变窄）
// 就会触发，同样拽飞滚动位置。小幅收缩放行到差分渲染路径（其尾部会逐行清多余行），
// 仅大幅收缩保留整屏重绘。
const OLD_CLEAR_ON_SHRINK_BLOCK = `        if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
            logRedraw(\`clearOnShrink (maxLinesRendered=\${this.maxLinesRendered})\`);
            fullRender(true);
            return;
        }`;

const NEW_CLEAR_ON_SHRINK_BLOCK = `        if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
            // PATCH(scroll-freeze): 原逻辑对任何收缩都 fullRender(true)（\\x1b[3J 清滚动缓冲），
            // 任务完成时消息定稿收窄 1~2 行就会触发，滚动位置被拽飞。
            // 小幅收缩交给差分渲染路径（尾部逐行清掉多余行，不动滚动缓冲），
            // 仅大幅收缩（超一屏或视口顶部落出内容）才清滚动缓冲整屏重绘。
            const shrinkDelta = this.previousLines.length - newLines.length;
            if (shrinkDelta > height || newLines.length <= prevViewportTop) {
                logRedraw(\`clearOnShrink (maxLinesRendered=\${this.maxLinesRendered}, shrink=\${shrinkDelta})\`);
                fullRender(true);
                return;
            }
            logRedraw(\`clearOnShrink small (shrink=\${shrinkDelta}), deferring to diff\`);
        }`;

// ---- 块 3：interactive-mode.js 全局重建强制全量渲染 ----
// scroll-freeze 的钳制路径只适合「流式增量」（变化在底部）。显式全局重建（Ctrl+T 折叠思考、
// compaction、设置变更、会话恢复/切换、主题切换）会重排整段对话，必须整屏重绘（含重建滚动缓冲），
// 否则钳制路径冻结视口上方旧内容，新旧内容硬拼接导致页面错乱。
const IM_PATCHES = [
	{
		name: "rebuildChatFromMessages 强制全量渲染",
		old: `    rebuildChatFromMessages() {
        this.chatContainer.clear();
        this.renderSessionEntries(this.sessionManager.buildContextEntries());
    }`,
		new: `    rebuildChatFromMessages() {
        this.chatContainer.clear();
        this.renderSessionEntries(this.sessionManager.buildContextEntries());
        // PATCH(scroll-freeze): 全局重建（Ctrl+T 折叠思考、compaction、设置变更、会话恢复等）
        // 必须整屏重绘（清滚动缓冲重建），否则 scroll-freeze 的钳制路径会把新旧内容硬拼接。
        this.ui.requestRender(true);
    }`,
	},
	{
		name: "renderCurrentSessionState 强制全量渲染",
		old: `        this.pendingTools.clear();
        this.renderInitialMessages();
    }`,
		new: `        this.pendingTools.clear();
        this.renderInitialMessages();
        // PATCH(scroll-freeze): session 切换等同理，强制整屏重绘
        this.ui.requestRender(true);
    }`,
	},
	{
		name: "onThemeChange 强制全量渲染",
		old: `        onThemeChange(() => {
            this.ui.invalidate();
            this.updateEditorBorderColor();
            this.ui.requestRender();
        });`,
		new: `        onThemeChange(() => {
            this.ui.invalidate();
            this.updateEditorBorderColor();
            this.ui.requestRender(true);
        });`,
	},
];

function findTuiMainScreenJs() {
	const npmRoot = execSync("npm root -g").toString().trim();
	const p = path.join(
		npmRoot,
		"@earendil-works",
		"pi-coding-agent",
		"node_modules",
		"@earendil-works",
		"pi-tui",
		"dist",
		"tui-main-screen.js",
	);
	if (!fs.existsSync(p)) {
		throw new Error(`找不到 pi-tui tui-main-screen.js: ${p}`);
	}
	return p;
}

function findInteractiveModeJs() {
	const npmRoot = execSync("npm root -g").toString().trim();
	const p = path.join(
		npmRoot,
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"modes",
		"interactive",
		"interactive-mode.js",
	);
	if (!fs.existsSync(p)) {
		throw new Error(`找不到 interactive-mode.js: ${p}`);
	}
	return p;
}

function applyInteractiveModePatches() {
	const imPath = findInteractiveModeJs();
	let imSrc = fs.readFileSync(imPath, "utf8");
	let imChanged = false;
	for (const p of IM_PATCHES) {
		if (imSrc.includes(p.new)) {
			continue; // 已打
		}
		if (!imSrc.includes(p.old)) {
			console.error(`未找到补丁目标「${p.name}」——pi 版本可能已变动，请人工核对。`);
			continue;
		}
		imSrc = imSrc.replace(p.old, p.new);
		imChanged = true;
		console.log(`已应用: ${p.name}`);
	}
	if (imChanged) {
		fs.writeFileSync(imPath, imSrc);
		console.log(`interactive-mode.js 补丁已写入: ${imPath}`);
	} else {
		console.log(`interactive-mode.js 已打补丁，跳过: ${imPath}`);
	}
}

const tuiPath = findTuiMainScreenJs();
let src = fs.readFileSync(tuiPath, "utf8");
let changed = false;

const hasMarker = src.includes(MARKER);

if (!hasMarker) {
	// 全新安装：两个目标块都必须存在
	if (!src.includes(OLD_CRITICAL_BLOCK)) {
		console.error("未找到 critical 目标代码块——pi-tui 版本可能已变动，请人工核对后再打补丁。");
		process.exit(1);
	}
	if (!src.includes(OLD_CLEAR_ON_SHRINK_BLOCK)) {
		console.error("未找到 clearOnShrink 目标代码块——pi-tui 版本可能已变动，请人工核对后再打补丁。");
		process.exit(1);
	}
	src = src.replace(OLD_CRITICAL_BLOCK, NEW_CRITICAL_BLOCK).replace(OLD_CLEAR_ON_SHRINK_BLOCK, NEW_CLEAR_ON_SHRINK_BLOCK);
	changed = true;
	console.log(`已应用 V4 补丁: ${tuiPath}`);
} else {
	console.log(`已打 V4 补丁，跳过: ${tuiPath}`);
}

if (changed) {
	fs.writeFileSync(tuiPath, src);
	console.log(`tui-main-screen.js 补丁已写入: ${tuiPath}`);
}

applyInteractiveModePatches();

console.log("重启 pi 后生效。可用 PI_DEBUG_REDRAW=1 验证 fullRender 是否消失（日志在 ~/.pi/agent/pi-debug.log）。");
