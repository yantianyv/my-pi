/**
 * token-saver: 上下文 token 节省器——自动清洗 bash 工具的冗余输出。
 *
 * 实现要点：
 * - 通过 pi.on("tool_result") 钩子在 bash 输出返回 AI 前拦截修改，对 AI 透明
 * - 按命令类型（git/npm/pnpm/tsc/pip/docker/--help）清洗冗余行（hint/警告/进度条）
 * - 超长输出截断（保留头尾，中间省略提示）；截断时完整原始输出保存到
 *   ~/.pi/agent/tmp/ 并在结果末尾附文件路径，AI 需要时可自行 read 查看
 * - 仅当输出真正被修改时才写文件，干净输出零开销
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP_DIR = path.join(os.homedir(), ".pi", "agent", "tmp");
const UNIVERSAL_MAX_LINES = 200;
const UNIVERSAL_HEAD_LINES = 150;
const UNIVERSAL_TAIL_LINES = 30;
const GIT_MAX_LINES = 80;
const GIT_HEAD_LINES = 60;
const GIT_TAIL_LINES = 10;
const TSC_MAX_ERRORS = 20;
const HELP_MAX_LINES = 40;
const HELP_HEAD_LINES = 35;

function truncate(text: string, maxLines: number, headLines: number, tailLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const head = lines.slice(0, headLines).join("\n");
	const omitted = lines.length - headLines - tailLines;
	const summary = `\n\n... [省略 ${omitted} 行，原始 ${lines.length} 行] ...`;
	if (tailLines <= 0) {
		return `${head}${summary}\n`;
	}
	const tail = lines.slice(-tailLines).join("\n");
	return `${head}${summary}\n\n${tail}`;
}

function trimTrailing(text: string): string {
	return text.replace(/\n+$/, "\n");
}

function hasCommand(command: string, bin: string): boolean {
	const re = new RegExp(`(?:^|[|;&\\s])${bin}(?:\\s|[|;&]|$)`);
	return re.test(command);
}

function saveOriginal(command: string, text: string): string {
	fs.mkdirSync(TMP_DIR, { recursive: true });
	const now = new Date();
	const ts = [
		String(now.getFullYear()).slice(-2),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
		String(now.getHours()).padStart(2, "0"),
		String(now.getMinutes()).padStart(2, "0"),
	].join("");
	// 内容哈希：同秒内不同输出互不覆盖，相同输出复用同一文件
	const hash = crypto.createHash("md5").update(text).digest("hex").slice(0, 8);
	const filename = `${ts}_${hash}.log`;
	const filepath = path.join(TMP_DIR, filename);
	fs.writeFileSync(filepath, text, "utf8");
	return filepath;
}

function makeHint(filepath: string): string {
	return `\n\n[token-saver] 为节省 token，输出已被精简处理。完整原始输出已保存：${filepath}`;
}

// --- Git ---

const CRLF_RE = /^(?:warning|note): (?:LF|CRLF) (?:will be|would be) /;
const HINT_START = /^(Changes to be committed|Changes not staged|Untracked files):/;

function isGitCommand(command: string): boolean {
	// 支持链式命令（如 `cd dir && git status`）
	const re = /(?:^|[|;&\s])git\s/;
	if (!re.test(command)) return false;
	const sub = getGitSubcommand(command);
	const excluded = ["credential", "remote-ext", "remote-ftp", "remote-ftps", "remote-http", "remote-https"];
	return !excluded.includes(sub);
}

function getGitSubcommand(command: string): string {
	// 找到 git 在命令中的位置，提取子命令
	const gitMatch = command.match(/(?:^|[|;&\s])git\s+/);
	if (!gitMatch) return "";
	const afterGit = command.slice((gitMatch.index ?? 0) + gitMatch[0].length);
	const parts = afterGit.split(/\s+/);
	for (const part of parts) {
		if (part.startsWith("-")) continue;
		return part;
	}
	return "";
}

function filterGitStatus(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let inHintBlock = false;
	for (const line of lines) {
		// 跳过 hint 行（如 `  (use "git add ...`）和末尾的总结提示
		if (/^\s*\(use /.test(line) || /^no changes added to commit /.test(line)) { inHintBlock = true; continue; }
		if (inHintBlock) {
			if (line === "" || HINT_START.test(line)) { inHintBlock = false; if (line !== "") result.push(line); }
			continue;
		}
		result.push(line);
	}
	return result.join("\n");
}

function filterGit(command: string, text: string): string {
	const sub = getGitSubcommand(command);
	let r = text;
	if (sub === "status" && !command.includes("--porcelain")) r = filterGitStatus(r);
	if (sub === "diff" || sub === "log" || sub === "show") r = truncate(r, GIT_MAX_LINES, GIT_HEAD_LINES, GIT_TAIL_LINES);
	if (["commit", "push", "pull", "merge", "rebase", "checkout", "stash"].includes(sub)) {
		r = r.split("\n").filter((l) => !CRLF_RE.test(l)).join("\n");
	}
	return trimTrailing(r);
}

// --- npm / pnpm ---

function filterNpm(text: string): string {
	const filtered = text.split("\n").filter((line) => {
		if (/^npm WARN\b/.test(line)) return false;
		if (/^npm audit\b/.test(line)) return false;
		if (/^\d+ vulnerabilities? /.test(line)) return false;
		return true;
	});
	return trimTrailing(filtered.join("\n"));
}

function filterPnpm(text: string): string {
	const filtered = text.split("\n").filter((line) => {
		if (/^Progress:/.test(line)) return false;
		if (/^\s*└─/.test(line) && /Packages:/.test(line)) return false;
		if (/^ /.test(line) && /WARN/.test(line)) return false;
		return true;
	});
	return trimTrailing(filtered.join("\n"));
}

// --- tsc ---

function filterTsc(text: string): string {
	const lines = text.split("\n");
	const tscErrorRe = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;
	const errors: Array<{ file: string; line: string }> = [];
	const otherLines: string[] = [];
	let seenFiles = new Set<string>();

	for (const line of lines) {
		const m = line.match(tscErrorRe);
		if (m) {
			seenFiles.add(m[1]);
			errors.push({ file: m[1], line });
		} else {
			otherLines.push(line);
		}
	}

	if (errors.length === 0) return text;
	if (errors.length <= TSC_MAX_ERRORS) return trimTrailing(text);

	const kept = errors.slice(0, TSC_MAX_ERRORS);
	const byFile = new Map<string, number>();
	for (const e of errors) byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1);

	const result: string[] = [...otherLines.filter((l) => l.trim() !== "")];
	for (const e of kept) result.push(e.line);
	result.push("");
	result.push(`... [共 ${errors.length} 个错误，涉及 ${seenFiles.size} 个文件，仅显示前 ${TSC_MAX_ERRORS} 个] ...`);
	result.push(`文件分布：${[...byFile.entries()].map(([f, n]) => `${f}(${n})`).join(" · ")}`);

	return trimTrailing(result.join("\n"));
}

// --- pip ---

function filterPip(text: string): string {
	const filtered = text.split("\n").filter((line) => {
		if (/[▏▎▍▌▋▊▉█]{2,}/.test(line)) return false;
		if (/^\s*\d+%/.test(line)) return false;
		if (/^\s*\d+\.\d+ [KM]B\/s/.test(line)) return false;
		if (/^WARNING: /i.test(line)) return false;
		return true;
	});
	return trimTrailing(filtered.join("\n"));
}

// --- docker ---

function filterDocker(text: string): string {
	const filtered = text.split("\n").filter((line) => {
		if (/^\[=*>?\s*\]\s*\d+%/.test(line)) return false;
		if (/^\w+: (Pulling|Downloading|Download complete|Verifying|Pull complete|Already exists)/.test(line)) return false;
		if (/^---> [a-f0-9]+$/.test(line)) return false;
		return true;
	});
	return trimTrailing(filtered.join("\n"));
}

// --- help ---

function filterHelpOutput(text: string): string {
	return truncate(text, HELP_MAX_LINES, HELP_HEAD_LINES, 0);
}

// --- main ---

function filterOutput(command: string, text: string): { filtered: string; truncated: boolean } {
	let filtered = text;

	if (/\s--?h(elp)?\b/.test(command)) filtered = filterHelpOutput(filtered);
	if (isGitCommand(command)) filtered = filterGit(command, filtered);
	if (hasCommand(command, "pnpm")) filtered = filterPnpm(filtered);
	else if (hasCommand(command, "npm")) filtered = filterNpm(filtered);
	if (hasCommand(command, "tsc")) filtered = filterTsc(filtered);
	if (hasCommand(command, "pip3") || hasCommand(command, "pip")) filtered = filterPip(filtered);
	if (hasCommand(command, "docker")) filtered = filterDocker(filtered);

	filtered = trimTrailing(filtered);

	if (filtered.split("\n").length > UNIVERSAL_MAX_LINES) {
		filtered = truncate(filtered, UNIVERSAL_MAX_LINES, UNIVERSAL_HEAD_LINES, UNIVERSAL_TAIL_LINES);
	}

	return { filtered, truncated: filtered !== text };
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event: any) => {
		if (event.toolName !== "bash") return;

		const command = (event.input as { command?: string })?.command ?? "";
		if (!command) return;

		for (const block of event.content) {
			if (block.type !== "text" || !block.text) continue;
			const original = block.text;
			const { filtered, truncated } = filterOutput(command, original);
			if (truncated) {
				const filepath = saveOriginal(command, original);
				block.text = filtered + makeHint(filepath);
			}
		}
	});
}
