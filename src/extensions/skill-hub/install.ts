/**
 * skill-hub/install：技能落盘、来源账本与 reload 排队
 *
 * 存储独立于手动技能：插件装的技能全部落在
 *
 *   <cwd>/.pi/skill-hub/skills/<name>/     技能目录（通过 resources_discover 注册给 pi）
 *   <cwd>/.pi/skill-hub/installed.json     安装账本
 *
 * 为什么单独一处：手动放进 `.pi/skills/` 的技能与 AI 装的技能混在同一层时，既分不清
 * 谁装的，也让「卸载」变成危险操作（可能删掉人写的技能）。放在插件自己的目录里，
 * 卸载就只能是「删自己账本里记着的东西」，手动技能天然碰不到。
 *
 * 目录已存在即拒绝——安装不是覆盖操作；重装/升级先卸载再装。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";
import { removePath } from "../shared/fs-safe";
import type { FetchedSkill } from "./fetch";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** 插件私有存储目录（项目内） */
const STORE_DIR = path.join(".pi", "skill-hub");
/** 技能目录名（相对存储目录） */
const SKILLS_SUBDIR = "skills";
/** 账本文件名（相对存储目录） */
const LEDGER_FILE = "installed.json";

export interface LedgerEntry {
	name: string;
	/** 来源仓库 owner/repo */
	source: string;
	/** 安装时用的版本标签 */
	ref: string;
	/** 仓库内技能目录（无前导斜杠，空串 = 仓库根） */
	dir: string;
	/** 安装绝对路径 */
	path: string;
	installedAt: string;
	files: string[];
}

interface Ledger {
	skills: LedgerEntry[];
}

/** 插件存储根（项目内） */
export function storeDir(cwd: string): string {
	return path.join(path.resolve(cwd), STORE_DIR);
}

/** 技能根目录：交给 `resources_discover` 注册的就是它 */
export function skillsRoot(cwd: string): string {
	return path.join(storeDir(cwd), SKILLS_SUBDIR);
}

export function skillTarget(cwd: string, name: string): string {
	return path.join(skillsRoot(cwd), name);
}

function ledgerFile(cwd: string): string {
	return path.join(storeDir(cwd), LEDGER_FILE);
}

function isLedger(v: unknown): v is Ledger {
	return v !== null && typeof v === "object" && Array.isArray((v as Ledger).skills);
}

export function loadLedger(cwd: string): Ledger {
	const raw = loadJsonConfig<Ledger>(ledgerFile(cwd), { skills: [] }, isLedger);
	return { skills: raw.skills.filter((e) => e && typeof e.name === "string" && typeof e.path === "string") };
}

export function saveLedger(cwd: string, ledger: Ledger): void {
	saveJsonConfig(ledgerFile(cwd), ledger);
}

/** 路径比较键：同一目录可能以 `C:\\a/b` 与 `C:\\a\\b` 两种写法出现，直接比字符串会认成两个 */
function pathKey(p: string): string {
	return path.resolve(p).toLowerCase();
}

/**
 * 把取回的文件写到目标目录。先写同级的临时目录再整体 rename：
 * 半途失败时不会留下一个看着像装好了、实则缺文件的技能目录。
 */
export function writeSkillTree(targetDir: string, files: Map<string, string>): void {
	const parent = path.dirname(targetDir);
	fs.mkdirSync(parent, { recursive: true });
	const tmp = path.join(parent, `.tmp-${path.basename(targetDir)}-${process.pid}`);
	removePath(tmp);
	const root = path.resolve(tmp);
	try {
		for (const [rel, text] of files) {
			const abs = path.resolve(path.join(tmp, rel));
			// 路径穿越防护：远端清单里的文件名不可信
			if (!abs.startsWith(root + path.sep)) throw new Error(`文件路径越界：${rel}`);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, text, "utf8");
		}
		fs.renameSync(tmp, targetDir);
	} catch (e) {
		removePath(tmp);
		throw e;
	}
}

/** 记一笔安装 */
export function recordInstall(cwd: string, skill: FetchedSkill, name: string, targetDir: string): LedgerEntry {
	const ledger = loadLedger(cwd);
	const key = pathKey(targetDir);
	ledger.skills = ledger.skills.filter((e) => pathKey(e.path) !== key && e.name !== name);
	const entry: LedgerEntry = {
		name,
		source: skill.source,
		ref: skill.ref,
		dir: skill.dir,
		path: path.resolve(targetDir),
		installedAt: new Date().toISOString(),
		files: [...skill.files.keys()].sort(),
	};
	ledger.skills.push(entry);
	saveLedger(cwd, ledger);
	return entry;
}

/** 删账本记录；目录本身由调用方删（账本先删，避免删盘失败后留下对不上的陈账） */
export function forgetInstall(cwd: string, targetDir: string): boolean {
	const ledger = loadLedger(cwd);
	const key = pathKey(targetDir);
	const next = ledger.skills.filter((e) => pathKey(e.path) !== key);
	if (next.length === ledger.skills.length) return false;
	saveLedger(cwd, { skills: next });
	return true;
}

export interface InstalledSkill {
	name: string;
	dir: string;
	entry: LedgerEntry;
}

/**
 * 插件装的技能清单：**以账本为准**，不扫目录。
 * 这样「AI 能卸载什么」与「插件装了什么」严格一致——人手动放进别处的技能不会出现在这里。
 */
export function listInstalled(cwd: string): InstalledSkill[] {
	return loadLedger(cwd)
		.skills.map((entry) => ({ name: entry.name, dir: entry.path, entry }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** 目标路径是否落在插件技能根目录内（卸载前的防越界检查） */
export function isManagedPath(cwd: string, target: string): boolean {
	const root = pathKey(skillsRoot(cwd));
	const key = pathKey(target);
	return key.startsWith(root + path.sep);
}
