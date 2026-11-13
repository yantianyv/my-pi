/**
 * 删除类 fs 操作的安全封装
 *
 * 为什么不用 fs.rmSync：本机实测它在**路径含中文**时静默失败——不抛错也不删（与盘符、进程
 * cwd 都无关，`%TEMP%\中文\…` 同样中招），而 unlinkSync / rmdirSync 正常。项目目录常落在
 * 中文路径下，一旦清理逻辑依赖 rmSync，就会「看着成功、实际什么都没删」：半成品、临时残留、
 * 在场文件持续堆积，且症状（同任务重跑时旧正文被当成续跑起点）离原因很远。
 *
 * 故删除一律走 removePath：手写递归 + 结尾复核；符号链接 / junction 只删链接本身，不跟进。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 删除文件或目录树，返回目标是否已不存在（本来就不存在也算成功）。
 * 不抛错：调用方按返回值决定是否提示失败（如 `/crash-log clear`）。
 */
export function removePath(target: string): boolean {
	let st: fs.Stats;
	try {
		st = fs.lstatSync(target);
	} catch {
		return true;
	}
	if (st.isDirectory() && !st.isSymbolicLink()) {
		let names: string[];
		try {
			names = fs.readdirSync(target);
		} catch {
			names = []; // 读不了子项 → 下面 rmdir 失败 → 返回 false
		}
		for (const name of names) removePath(path.join(target, name));
		try {
			fs.rmdirSync(target);
		} catch {
			/* 结尾复核兜底 */
		}
	} else {
		try {
			fs.unlinkSync(target);
		} catch {
			try {
				fs.rmdirSync(target);
			} catch {
				/* 结尾复核兜底 */
			}
		}
	}
	return !fs.existsSync(target);
}
