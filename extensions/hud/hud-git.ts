/**
 * hud-git：HUD git 状态模块（hud 多文件扩展的组成部分，仅被 hud/index.ts import）
 *
 * 职责：解析 `git status --porcelain=v1 --branch` 输出为结构化统计
 * （分支 / 暂存 / 工作区 / 未跟踪 / 领先落后），供 HUD 行 1 渲染。
 */
export interface GitStats {
	branch: string | null;
	staged: number; // 暂存区
	unstaged: number; // 工作区（已修改未暂存）
	untracked: number; // 未跟踪
	ahead: number; // 领先远程
	behind: number; // 落后远程
}

/** 解析 `git status --porcelain=v1 --branch` 输出。 */
export function parseGitStatus(stdout: string): GitStats {
	const lines = stdout.split(/\r?\n/);
	const first = lines[0] ?? "";
	let branch: string | null = null;
	const branchM = first.match(/^## (.+?)(?:\.\.\.|$)/);
	if (branchM) {
		const raw = branchM[1];
		// 尚未提交的仓库：git 输出 "No commits yet on <branch>" / "Initial commit on <branch>"
		const noCommit = raw.match(/^(?:No commits yet|Initial commit) on (.+)$/);
		branch = noCommit ? noCommit[1] : raw === "HEAD (no branch)" ? "HEAD" : raw;
	}
	let staged = 0,
		unstaged = 0,
		untracked = 0;
	for (const line of lines.slice(1)) {
		if (!line) continue;
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked++;
			continue;
		}
		if (x !== " " && x !== "?") staged++;
		if (y !== " " && y !== "?") unstaged++;
	}
	const ahead = first.match(/ahead (\d+)/);
	const behind = first.match(/behind (\d+)/);
	return {
		branch,
		staged,
		unstaged,
		untracked,
		ahead: ahead ? Number(ahead[1]) : 0,
		behind: behind ? Number(behind[1]) : 0,
	};
}
