/**
 * pi-tui 滚动冻结补丁（scroll-freeze）
 *
 * 背景：pi 流式输出时，AssistantMessageComponent 每帧都从 markdown 源码重渲染整条消息，
 * 消息开头几行（段落重排/代码块高亮/表格列宽）会持续变化。一旦消息开头滚出视口，
 * pi-tui 的差分渲染判定 firstChanged < prevViewportTop，触发 fullRender(true)：
 * 发送 \x1b[2J\x1b[H\x1b[3J 清空终端滚动缓冲区再全量重写——实测每秒 2~3 次。
 * 用户此时用滚轮翻看历史，滚动缓冲区被反复清空重建，Windows Terminal 滚动位置被拽飞。
 *
 * 补丁策略（与 Claude Code / Ink <Static> 同款思路）：
 * 1. 流式期间 firstChanged < prevViewportTop：冻结视口上方已滚入滚动缓冲区的内容
 *    （保留流式中间帧），只重绘视口内可见部分，不再清空整个滚动缓冲区。
 *    代价：滚上去看到的旧内容可能是流式中间帧，与最终渲染略有出入——可接受。
 * 2. 内容收缩（shrink）且变化涉及视口上方：逻辑行号位移无法局部差分，按收缩幅度分流：
 *    - 小幅收缩（≤1 屏，任务完成时消息定稿收窄 1~2 行等）：保持视口顶部不变，逐行
 *      \x1b[2K 重写视口内全部行并清掉收缩的空行（\x1b[1B 下移不滚动）——不清屏、不滚动、
 *      不动滚动缓冲 → 滚动缓冲（旧帧 0..prevViewportTop）与可见屏（新帧 prevViewportTop..）
 *      行号连续，无重叠。
 *    - 大幅收缩（超 1 屏，或视口顶部已落到内容之外）：滚动缓冲里的旧帧与可见屏大量重叠
 *      且已无意义，清滚动缓冲做整屏重绘（滚动位置跳顶一次，可接受；同步输出下无闪烁）。
 * 3. 为何不用 V2 的 fullRender("screen")（\x1b[2J 清可见屏 + 保留滚动缓冲 + 重写末尾一屏）：
 *    Windows Terminal 的 ED2 清屏会把可见屏旧帧移入滚动缓冲，重写后滚动缓冲（旧中间帧）
 *    与可见屏（新定稿）内容重叠——任务完成时用户滚动即看到"重复绘制"。
 *
 * 用法：node patches/apply-pi-tui-scroll-freeze.mjs
 * pi 升级会覆盖 node_modules，需重跑本脚本。改完重启 pi 生效。
 * 幂等：已打 V3 补丁时直接跳过；已打 V1/V2 补丁时自动升级 shrink 分支。
 * 另补 interactive-mode.js 三处：全局重建（Ctrl+T 折叠思考、compaction、设置变更、会话切换、主题切换）
 * 必须整屏重绘（requestRender(true)），否则 scroll-freeze 钳制路径会把新旧内容硬拼接。
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MARKER = "PATCH(scroll-freeze)";

// ---- 块 A：fullRender 清屏行——\x1b[3J（清滚动缓冲）改为仅 true 时发送 ----
// V1 未动过此处，升级路径与全新安装共用同一替换。
const OLD_CLEAR_LINE = `                buffer += "\\x1b[2J\\x1b[H\\x1b[3J"; // Clear screen, home, then clear scrollback`;

const NEW_CLEAR_LINE = `                // PATCH(scroll-freeze): \\x1b[3J 会清空终端滚动缓冲区，Windows Terminal 中滚动位置被拽飞。
                // fullRender(true) 保留原语义（清滚动缓冲）；fullRender("screen") 只清可见屏、保留滚动缓冲，
                // 供任务完成时的内容收缩重绘使用，避免每轮结束时滚动位置跳顶。
                buffer += "\\x1b[2J\\x1b[H"; // Clear screen, home
                if (clear === true) {
                    buffer += "\\x1b[3J"; // Clear scrollback
                }`;

// ---- 块 A2：fullRender 渲染循环——"screen" 模式只重写最后一个屏幕的行 ----
// 全量重写会把整段历史重复压进未清空的滚动缓冲区（每次收缩重绘多一份拷贝）。
const OLD_LOOP_START = `            for (let i = 0; i < newLines.length; i++) {
                if (i > 0)
                    buffer += "\\r\\n";`;

const NEW_LOOP_START = `            // PATCH(scroll-freeze): "screen" 模式只重写最后一个屏幕的行——
            // 全量重写会把整段历史重复压进未清空的滚动缓冲区（每次收缩重绘多一份拷贝）。
            const renderStart = clear === "screen" ? Math.max(0, newLines.length - height) : 0;
            for (let i = renderStart; i < newLines.length; i++) {
                if (i > renderStart)
                    buffer += "\\r\\n";`;

// ---- 块 B：shrink 分支——V1（fullRender(true)）升级为 V2（fullRender("screen")）----
const V1_SHRINK_BLOCK = `            if (newLines.length < this.previousLines.length) {
                // 内容收缩且变化涉及视口上方（逻辑行号位移）：罕见情况，维持原始整屏重绘
                logRedraw(\`firstChanged < viewportTop with shrink (\${firstChanged} < \${prevViewportTop})\`);
                fullRender(true);
                return;
            }`;

const V2_SHRINK_BLOCK = `            if (newLines.length < this.previousLines.length) {
                // 内容收缩且变化涉及视口上方（逻辑行号位移）：逻辑行号位移无法局部差分，
                // 但整屏重绘不能再用 fullRender(true) 清滚动缓冲（\\x1b[3J 会拽飞 Windows Terminal
                // 滚动位置——任务完成时消息定稿收窄 1~2 行，每轮结束必现一次跳顶）。
                // 改走 fullRender("screen")：只清可见屏、保留滚动缓冲，同步输出下无闪烁。
                logRedraw(\`firstChanged < viewportTop with shrink, clear screen only (\${firstChanged} < \${prevViewportTop})\`);
                fullRender("screen");
                return;
            }`;

// ---- 块 B3：V3 shrink 分支——小幅收缩保持视口顶部重绘（不清屏），大幅收缩退回整屏重绘 ----
// V2 的 fullRender("screen")（\x1b[2J 清可见屏 + 保留滚动缓冲 + 重写末尾一屏）在 Windows Terminal
// 中产生"重复绘制"：ED2 清屏会把可见屏旧帧移入滚动缓冲，重写后滚动缓冲（旧中间帧）与可见屏
// （新定稿）内容重叠，用户滚动时看到同一段内容出现两次。V3 改为按收缩幅度分流：
// - 小幅收缩（≤1 屏）：不清屏、不滚动、不动滚动缓冲，保持视口顶部不变，逐行 \x1b[2K 重写
//   视口内全部行并清掉收缩的空行（\x1b[1B 下移不滚动）→ 滚动缓冲（旧帧 0..prevViewportTop）
//   与可见屏（新帧 prevViewportTop..）行号连续，无重叠。
// - 大幅收缩（超 1 屏或视口顶部落出内容）：旧帧已无意义，清滚动缓冲整屏重绘（跳顶一次可接受）。
const V3_SHRINK_BLOCK = `            if (newLines.length < this.previousLines.length) {
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
                // 同步输出内：光标移到视口顶部（屏幕第 0 行），逐行 \\x1b[2K 重写视口内全部行，
                // 再清掉收缩的空行（\\x1b[1B 下移不滚动），最后移回内容末尾
                let buf = "\\x1b[?2026h";
                // 硬件光标不在视口内（异常状态，如输入框移出视口）：逐行重绘会错位，保守整屏重绘
                const curScreenRow = hardwareCursorRow - prevViewportTop;
                if (curScreenRow < 0 || curScreenRow >= height) {
                    logRedraw(\`hardware cursor outside viewport (row=\${hardwareCursorRow}), full redraw\`);
                    fullRender(true);
                    return;
                }
                if (curScreenRow > 0)
                    buf += \`\\x1b[\${curScreenRow}A\`;
                buf += "\\r";
                for (let i = prevViewportTop; i < newLines.length; i++) {
                    if (i > prevViewportTop)
                        buf += "\\r\\n";
                    buf += "\\x1b[2K" + newLines[i];
                }
                // 先下移一行到内容末尾之后，再逐行清掉收缩的空行（\\x1b[1B 下移不滚动）
                buf += "\\r\\n";
                for (let i = 0; i < shrinkDelta; i++) {
                    buf += "\\x1b[2K";
                    if (i < shrinkDelta - 1)
                        buf += "\\x1b[1B";
                }
                if (shrinkDelta > 0)
                    buf += \`\\x1b[\${shrinkDelta}A\`;
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
            }`;

// ---- 块 B4：V3 修正版升级——旧 V3（清行循环误清内容末尾行 + 光标越界无保护）→ 修正版 ----
const V3_OLD_SHRINK_BLOCK = `            if (newLines.length < this.previousLines.length) {
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
                // 同步输出内：光标移到视口顶部（屏幕第 0 行），逐行 \\x1b[2K 重写视口内全部行，
                // 再清掉收缩的空行（\\x1b[1B 下移不滚动），最后移回内容末尾
                let buf = "\\x1b[?2026h";
                const curScreenRow = hardwareCursorRow - prevViewportTop;
                if (curScreenRow > 0)
                    buf += \`\\x1b[\${curScreenRow}A\`;
                else if (curScreenRow < 0)
                    buf += \`\\x1b[\${-curScreenRow}B\`;
                buf += "\\r";
                for (let i = prevViewportTop; i < newLines.length; i++) {
                    if (i > prevViewportTop)
                        buf += "\\r\\n";
                    buf += "\\x1b[2K" + newLines[i];
                }
                for (let i = 0; i < shrinkDelta; i++) {
                    buf += "\\r\\x1b[2K";
                    if (i < shrinkDelta - 1)
                        buf += "\\x1b[1B";
                }
                if (shrinkDelta > 0)
                    buf += \`\\x1b[\${shrinkDelta}A\`;
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
            }`;

// ---- 块 C：全新安装——原始未打补丁块 → V3 完整块 ----
const OLD_BLOCK = `        // Differential rendering can only touch what was actually visible.
        // If the first changed line is above the previous viewport, we need a full redraw.
        if (firstChanged < prevViewportTop) {
            logRedraw(\`firstChanged < viewportTop (\${firstChanged} < \${prevViewportTop})\`);
            fullRender(true);
            return;
        }`;

const NEW_BLOCK = `        // Differential rendering can only touch what was actually visible.
        // If the first changed line is above the previous viewport, we need a full redraw.
        if (firstChanged < prevViewportTop) {
            // PATCH(scroll-freeze): 不做整屏重绘——fullRender(true) 会发 \\x1b[3J 清空终端滚动缓冲区，
            // 流式输出期间每秒触发 2~3 次，导致 Windows Terminal 中用户的手动滚动位置被拽飞。
            // 改为冻结视口上方已滚入滚动缓冲区的内容（保留流式中间帧），只重绘视口内可见部分。
${V3_SHRINK_BLOCK}
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

function findTuiJs() {
	const npmRoot = execSync("npm root -g").toString().trim();
	const p = path.join(
		npmRoot,
		"@earendil-works",
		"pi-coding-agent",
		"node_modules",
		"@earendil-works",
		"pi-tui",
		"dist",
		"tui.js",
	);
	if (!fs.existsSync(p)) {
		throw new Error(`找不到 pi-tui: ${p}`);
	}
	return p;
}

// ---- 块 D：interactive-mode.js 全局重建强制全量渲染 ----
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

const tuiPath = findTuiJs();
let src = fs.readFileSync(tuiPath, "utf8");
let changed = false;

const hasMarker = src.includes(MARKER);
const hasV1Shrink = src.includes(V1_SHRINK_BLOCK);
const hasV2Shrink = src.includes(V2_SHRINK_BLOCK);
const hasV3Shrink = src.includes(V3_SHRINK_BLOCK);
const hasV3OldShrink = src.includes(V3_OLD_SHRINK_BLOCK);
const hasOldClearLine = src.includes(OLD_CLEAR_LINE);

if (hasMarker && !hasV1Shrink && !hasV2Shrink && !hasV3Shrink && !hasV3OldShrink) {
	console.error("检测到补丁标记但无法识别补丁版本——pi-tui 可能已被改动，请人工核对。");
	process.exit(1);
}

if (!hasMarker) {
	// 全新安装：原始块 + 原始清屏行 + 原始循环头都必须存在
	if (!src.includes(OLD_BLOCK)) {
		console.error("未找到目标代码块——pi-tui 版本可能已变动，请人工核对后再打补丁。");
		process.exit(1);
	}
	if (!hasOldClearLine) {
		console.error("未找到 fullRender 清屏行——pi-tui 版本可能已变动，请人工核对后再打补丁。");
		process.exit(1);
	}
	if (!src.includes(OLD_LOOP_START)) {
		console.error("未找到 fullRender 渲染循环头——pi-tui 版本可能已变动，请人工核对后再打补丁。");
		process.exit(1);
	}
	src = src.replace(OLD_BLOCK, NEW_BLOCK).replace(OLD_CLEAR_LINE, NEW_CLEAR_LINE).replace(OLD_LOOP_START, NEW_LOOP_START);
	changed = true;
	console.log(`已应用 V3 补丁: ${tuiPath}`);
} else if (hasV1Shrink) {
	// V1 → V3 升级：shrink 分支从 fullRender(true) 改为小幅收缩视口重绘 / 大幅收缩整屏重绘
	src = src.replace(V1_SHRINK_BLOCK, V3_SHRINK_BLOCK);
	if (hasOldClearLine) {
		src = src.replace(OLD_CLEAR_LINE, NEW_CLEAR_LINE);
	}
	if (src.includes(OLD_LOOP_START)) {
		src = src.replace(OLD_LOOP_START, NEW_LOOP_START);
	}
	changed = true;
	console.log(`V1 → V3 补丁升级完成: ${tuiPath}`);
} else if (hasV2Shrink) {
	// V2 → V3 升级：shrink 分支从 fullRender("screen") 改为小幅收缩视口重绘 / 大幅收缩整屏重绘
	src = src.replace(V2_SHRINK_BLOCK, V3_SHRINK_BLOCK);
	changed = true;
	console.log(`V2 → V3 补丁升级完成: ${tuiPath}`);
} else if (hasV3OldShrink) {
	// 旧 V3 → V3 修正版：清行循环先下移一行再清（旧版误清内容末尾行）+ 硬件光标越界保护
	src = src.replace(V3_OLD_SHRINK_BLOCK, V3_SHRINK_BLOCK);
	changed = true;
	console.log(`V3 修正版补丁更新完成: ${tuiPath}`);
} else {
	// 已是 V3：补齐缺失的补丁块（清屏行 / 循环头）
	if (hasOldClearLine) {
		src = src.replace(OLD_CLEAR_LINE, NEW_CLEAR_LINE);
		changed = true;
		console.log(`补齐 fullRender 清屏行: ${tuiPath}`);
	}
	if (src.includes(OLD_LOOP_START)) {
		src = src.replace(OLD_LOOP_START, NEW_LOOP_START);
		changed = true;
		console.log(`补齐 fullRender 渲染循环头: ${tuiPath}`);
	}
}

if (!changed) {
	console.log(`已打 V3 补丁，跳过: ${tuiPath}`);
} else {
	fs.writeFileSync(tuiPath, src);
	console.log(`tui.js 补丁已写入: ${tuiPath}`);
}

applyInteractiveModePatches();

console.log("重启 pi 后生效。可用 PI_DEBUG_REDRAW=1 验证 fullRender 是否消失（日志在 ~/.pi/agent/pi-debug.log）。");
