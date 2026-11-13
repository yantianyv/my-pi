/**
 * skill-hub/fetch：把技能目录下的文件逐个取回内存（含大小与数量上限）
 *
 * 为什么不能 git clone：本机到 github.com / api.github.com / codeload 的连接常被重置，
 * clone 直接失败；jsDelivr 的 CDN 与数据 API 可达，文件按条取即可。
 *
 * 取文件用固定并发（默认 4）：串行在 30 个文件的技能上要十几秒，全并发又容易被打回限流。
 *
 * 个别文件取不到是常态而非异常：jsDelivr 的清单来自仓库索引，CDN 侧对个别文件（含空文件、
 * 短时间内刚改动的文件）会回 404，换其它 CDN 节点也一样。因此**不因单个文件失败中止**：
 * 把缺失的记进 skipped，只要 SKILL.md 拿到了就算成功——装一份缺了附属脚本的技能，
 * 比装到一半失败留下半套目录更好，而且回执会如实说明缺了什么。体积超限的文件同样按跳过处理。
 */
import { readRepoFile } from "./registry";
import type { FileEntry } from "./trust";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 单个技能的总字节上限（超出后按体积从大到小跳过文件，防误装大仓库） */
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

/** 单文件上限（超出该文件的跳过，不装） */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** 文件数量上限 */
export const MAX_FILES = 200;

/** 并发取文件数 */
const CONCURRENCY = 4;

export interface FetchedSkill {
	source: string;
	ref: string;
	dir: string;
	files: Map<string, string>;
	entries: FileEntry[];
	/** 取不回来的文件（相对路径 → 原因）；超体积上限而未取的文件也记在这里 */
	skipped: Map<string, string>;
}

function relOf(dir: string, p: string): string {
	return dir ? p.slice(dir.length + 1) : p;
}

/**
 * 按体积上限挑选能取的文件：**超限的文件跳过而不拒装整包**。
 * 大体积文件在技能里往往是示例素材（演示 GIF、截图），核心是 SKILL.md 与 references；
 * 为了它们放弃整个技能不如装上主体、把缺的如实列出。只有连 SKILL.md 都放不下才算失败。
 */
export function pickWithinLimits(dir: string, entries: FileEntry[]): { entries: FileEntry[]; skipped: Map<string, string> } {
	const skipped = new Map<string, string>();
	if (entries.length > MAX_FILES) {
		throw new Error(`技能包含 ${entries.length} 个文件，超过上限 ${MAX_FILES}，未安装`);
	}
	const perFileReason = `超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1024)} KB`;
	const kept = entries.filter((f) => {
		if (f.size <= MAX_FILE_BYTES) return true;
		skipped.set(relOf(dir, f.path), `${perFileReason}（${Math.round(f.size / 1024)} KB）`);
		return false;
	});
	const totalReason = `超过技能总体积上限 ${Math.round(MAX_TOTAL_BYTES / 1024)} KB`;
	let total = kept.reduce((n, f) => n + f.size, 0);
	// 仍超总量时从最大的开始跳，直到装得下（SKILL.md 不参与淘汰）
	for (const f of [...kept].sort((a, b) => b.size - a.size)) {
		if (total <= MAX_TOTAL_BYTES) break;
		if (relOf(dir, f.path) === "SKILL.md") continue;
		kept.splice(kept.indexOf(f), 1);
		total -= f.size;
		skipped.set(relOf(dir, f.path), totalReason);
	}
	if (!kept.some((f) => relOf(dir, f.path) === "SKILL.md")) throw new Error(`SKILL.md 本身超过体积上限，无法安装`);
	return { entries: kept, skipped };
}

/**
 * 取回技能目录下全部文件。文本按 utf-8 读（技能文件都是文本；图片等二进制会被解成乱码，
 * 因此非文档类文件在信任判定里就会被拦下，不会走到这里）。
 * SKILL.md 取不到时抛错——没有它就没有技能。
 */
export async function fetchSkillFiles(
	source: string,
	ref: string,
	dir: string,
	entries: FileEntry[],
	onProgress?: (done: number, total: number) => void,
): Promise<FetchedSkill> {
	const planned = pickWithinLimits(dir, entries);
	const files = new Map<string, string>();
	const skipped = planned.skipped;
	let done = 0;
	let cursor = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const i = cursor++;
			const entry = planned.entries[i];
			if (!entry) return;
			const repoPath = entry.path;
			const rel = relOf(dir, repoPath);
			try {
				files.set(rel, await readRepoFile(source, ref, repoPath));
			} catch (e) {
				if (rel === "SKILL.md") throw new Error(`取不到 SKILL.md：${e instanceof Error ? e.message : String(e)}`);
				skipped.set(rel, e instanceof Error ? e.message : String(e));
			}
			done++;
			onProgress?.(done, planned.entries.length);
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, planned.entries.length) }, () => worker()));
	return { source, ref, dir, files, entries, skipped };
}
