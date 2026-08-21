/**
 * ask/store：问卷文件读写（.pi/questionnaires/*.json）
 *
 * 「问卷即文件」：AI 经 ask 工具创建、用户手写/外部程序放入均可，/answer 扫描目录识别。
 * 提交后立即删除文件；搁置时草稿（status:draft + answers）写回原文件。
 * 写入复用 shared/config 的原子写（临时文件 + rename），防半截 JSON。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { saveJsonConfig } from "../shared/config";
import { normalizeQuestionnaire, type Questionnaire } from "./types";

let cwd = process.cwd();

/** 固定项目根（session_start / 工具 execute 时以 ctx.cwd 刷新） */
export function initStore(projectCwd: string): void {
	cwd = projectCwd;
}

export function questionnairesDir(): string {
	return path.join(cwd, ".pi", "questionnaires");
}

export interface ListedQuestionnaire {
	file: string;
	q: Questionnaire;
}

/** 扫描目录：返回可识别的问卷（按 createdAt 升序）与无法解析的文件名列表 */
export function listQuestionnaires(): { items: ListedQuestionnaire[]; invalid: string[] } {
	const items: ListedQuestionnaire[] = [];
	const invalid: string[] = [];
	let names: string[] = [];
	try {
		names = fs.readdirSync(questionnairesDir()).filter((n) => n.endsWith(".json"));
	} catch {
		return { items, invalid }; // 目录不存在 = 没有问卷
	}
	for (const name of names) {
		const file = path.join(questionnairesDir(), name);
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
			const r = normalizeQuestionnaire(raw, { fallbackId: path.basename(name, ".json") });
			if (r.ok) items.push({ file, q: r.q });
			else invalid.push(name);
		} catch {
			invalid.push(name);
		}
	}
	items.sort((a, b) => a.q.createdAt.localeCompare(b.q.createdAt));
	return { items, invalid };
}

/** 创建问卷文件：id 清洗为安全文件名，冲突自动加 -2/-3 后缀（不覆盖已有问卷） */
export function createQuestionnaire(q: Questionnaire): string {
	const base =
		q.id
			.toLowerCase()
			.replace(/[^a-z0-9-_]+/g, "-")
			.replace(/^-+|-+$/g, "") || `survey-${Date.now().toString(36)}`;
	let name = `${base}.json`;
	for (let n = 2; fs.existsSync(path.join(questionnairesDir(), name)); n++) name = `${base}-${n}.json`;
	const file = path.join(questionnairesDir(), name);
	saveJsonConfig(file, q);
	return file;
}

/** 草稿/状态写回（原子写） */
export function saveQuestionnaire(file: string, q: Questionnaire): void {
	saveJsonConfig(file, q);
}

/** 提交后删除问卷文件（答案已送达 AI，文件使命完成） */
export function removeQuestionnaire(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		/* 已不存在则忽略 */
	}
}
