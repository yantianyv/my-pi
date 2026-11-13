/**
 * skill-hub/favorites：人类收藏的技能（全局，跨项目）
 *
 * 收藏回答的是「这个人觉得哪些技能值得留着」，与「本项目装了什么」是两件事，
 * 所以它不随项目走：存在 pi 的 agent 配置目录，换项目照样能在检索结果里看到。
 *
 * 键用 `source/skillId`（与 skills.sh 的 id 同构），不存安装路径——收藏可以指向
 * 一个还没装、甚至本机永远不会装的技能。
 */
import * as os from "node:os";
import * as path from "node:path";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

const FILE_NAME = "skill-hub-favorites.json";

export interface Favorite {
	/** 来源仓库 owner/repo */
	source: string;
	/** 仓库内技能目录名 */
	skillId: string;
	/** 展示名（缺省用 skillId） */
	name: string;
	addedAt: string;
}

interface Store {
	favorites: Favorite[];
}

function storeFile(): string {
	const dir = process.env.SKILL_HUB_FAVORITES_DIR ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(dir, FILE_NAME);
}

function isStore(v: unknown): v is Store {
	return v !== null && typeof v === "object" && Array.isArray((v as Store).favorites);
}

/** 收藏键：与 skills.sh 的 id 同构，便于按 id 直接比对 */
export function favoriteKey(source: string, skillId: string): string {
	return `${source}/${skillId}`;
}

function normalize(e: Favorite): Favorite {
	return { source: e.source, skillId: e.skillId, name: e.name || e.skillId, addedAt: e.addedAt || new Date().toISOString() };
}

export function loadFavorites(): Favorite[] {
	const raw = loadJsonConfig<Store>(storeFile(), { favorites: [] }, isStore);
	return raw.favorites
		.filter((e) => e && typeof e.source === "string" && typeof e.skillId === "string")
		.map(normalize)
		.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

function save(favorites: Favorite[]): void {
	saveJsonConfig(storeFile(), { favorites });
}

/** 收藏集合（按 id 快速判断） */
export function favoriteKeys(): Set<string> {
	return new Set(loadFavorites().map((f) => favoriteKey(f.source, f.skillId)));
}

export function isFavorite(source: string, skillId: string): boolean {
	return loadFavorites().some((f) => f.source === source && f.skillId === skillId);
}

/** 切换收藏，返回切换后的状态（true = 现在是收藏） */
export function toggleFavorite(source: string, skillId: string, name?: string): boolean {
	const list = loadFavorites();
	const i = list.findIndex((f) => f.source === source && f.skillId === skillId);
	if (i >= 0) {
		list.splice(i, 1);
		save(list);
		return false;
	}
	list.unshift({ source, skillId, name: name || skillId, addedAt: new Date().toISOString() });
	save(list);
	return true;
}

/** 显式取消收藏（收藏列表里删除用），返回是否确实删掉了 */
export function removeFavorite(source: string, skillId: string): boolean {
	const list = loadFavorites();
	const next = list.filter((f) => !(f.source === source && f.skillId === skillId));
	if (next.length === list.length) return false;
	save(next);
	return true;
}
