/**
 * .pi/ 目录的忽略规则维护（纯 fs，不依赖 pi 运行时）
 *
 * 语义：白名单——`.pi/` 是 pi 的项目运行时目录，默认整体不入库，只放行值得随项目
 * 长期留存的东西（项目 skill 与 `.gitignore` 自身）。规则写在 `.pi/.gitignore`
 * （嵌套 .gitignore：路径相对该目录、只作用于 `.pi/` 以内，与项目根规则互不干扰）。
 *
 * 只在「是 git 仓库 + 尚无该文件 + 根 .gitignore 未整体忽略 `.pi/`」时写入：
 * 根里写了 `.pi/` 的项目，git 不会进该目录，子规则也就不会被读取——写了是噪音。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 写入 `.pi/.gitignore` 的白名单模板 */
export const PI_GITIGNORE = `# .pi/ 内部的忽略规则（嵌套 .gitignore：路径相对本目录，只作用于 .pi/ 以内）
#
# 语义：白名单——只放行值得随项目长期留存的东西（项目 skill、本文件自身），
# 其余（pi 的运行时数据）一律不入库。
*
!.gitignore
# 项目自己的 skill（随项目走的文档与约定）
!skills/
!skills/**
`;

/** 根 .gitignore 里是否有一行整体忽略 `.pi/`（`\.pi` / `\.pi/` / `/\.pi/` 等写法） */
function rootIgnoresPi(cwd: string): boolean {
	const file = path.join(cwd, ".gitignore");
	if (!fs.existsSync(file)) return false;
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.map((l) => l.trim())
			.some((l) => /^\/?\.pi\/?$/.test(l));
	} catch {
		return true; // 读不到就别写（避免造出用不上的规则）
	}
}

/**
 * 幂等补 `.pi/.gitignore`：已有文件、非 git 仓库、根已整体忽略 `.pi/` 时都不动。
 * 任何异常（只读、无权限）静默跳过——它只是仓库卫生，不该影响会话。
 */
export function ensurePiGitignore(cwd: string): void {
	const target = path.join(cwd, ".pi", ".gitignore");
	try {
		if (!fs.existsSync(path.join(cwd, ".git")) || fs.existsSync(target)) return;
		if (rootIgnoresPi(cwd)) return;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, PI_GITIGNORE, { flag: "wx" }); // wx：并发会话下不覆盖对方
	} catch {
		/* 仓库卫生不阻塞会话 */
	}
}
