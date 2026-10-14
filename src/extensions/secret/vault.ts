/**
 * secret / vault.ts — 会话级内存库
 *
 * 只活在内存：不落盘、不进会话 JSONL、不写临时文件。槽位按会话标识索引，所以 /reload
 * 保留、/new 与退出即弃；跨 /reload 的保留需要模块外的容器，注册表因此挂在 globalThis 上。
 *
 * 条目分两类：secret（凭证本身）与 text（其它不想外发的敏感文本）。两类在脱敏与展开上
 * 完全同权，只在 UI 文案上区分——换句话说这条链路保护的是「值」，不判断它是什么。
 *
 * 对外一律给 PublicEntry（没有 value 字段）：列表、回执、状态栏都走它，值只从 get() 出。
 */
import { createHash } from "node:crypto";

export type EntryKind = "secret" | "text";
export type EntrySource = "prompt" | "paste" | "file" | "output";

/** 参与脱敏的最短值。更短的值在普通文本里出现频率太高，遮了就是误伤。 */
export const MIN_MASK_LEN = 8;
/** 短于该长度的值只在词边界替换（前后不接字母数字），否则「test」会打掉「latest」。 */
export const WORD_BOUNDARY_LEN = 16;

export interface Entry {
	name: string;
	value: string;
	kind: EntryKind;
	source: EntrySource;
	addedAt: number;
	length: number;
	fingerprint: string;
	/** 仅长值有：首尾各 4 字符，给人认领用（读屏/截图泄漏面因此有界）。 */
	preview?: string;
	/** 自动收录时的来源说明（如「GitHub 令牌」）；人工录入的条目没有。 */
	label?: string;
}

export interface PublicEntry {
	name: string;
	kind: EntryKind;
	source: EntrySource;
	addedAt: number;
	length: number;
	fingerprint: string;
	preview?: string;
	label?: string;
}

export interface AddInput {
	name: string;
	value: string;
	kind?: EntryKind;
	source?: EntrySource;
	label?: string;
}

const fingerprint = (value: string): string =>
	createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);

const previewOf = (value: string): string | undefined =>
	value.length >= 32 ? `${value.slice(0, 4)}…${value.slice(-4)}` : undefined;

export const toPublic = (entry: Entry): PublicEntry => {
	const { value: _value, ...rest } = entry;
	return { ...rest };
};

export class Vault {
	private entries = new Map<string, Entry>();

	get size(): number {
		return this.entries.size;
	}

	/** 值只从这里出。找不到返回 undefined（ref 保留原样）。 */
	get(name: string): string | undefined {
		return this.entries.get(name)?.value;
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	entry(name: string): Entry | undefined {
		return this.entries.get(name);
	}

	/** 按加入时间升序。 */
	list(): Entry[] {
		return [...this.entries.values()].sort((a, b) => a.addedAt - b.addedAt);
	}

	publicList(): PublicEntry[] {
		return this.list().map(toPublic);
	}

	/** 同名覆盖（值换了就是换了，不留历史）。 */
	add(input: AddInput): { entry: Entry; replaced: boolean } {
		const replaced = this.entries.has(input.name);
		const entry: Entry = {
			name: input.name,
			value: input.value,
			kind: input.kind ?? "secret",
			source: input.source ?? "prompt",
			addedAt: Date.now(),
			length: input.value.length,
			fingerprint: fingerprint(input.value),
			preview: previewOf(input.value),
			label: input.label,
		};
		this.entries.set(entry.name, entry);
		return { entry, replaced };
	}

	remove(name: string): boolean {
		return this.entries.delete(name);
	}

	rename(oldName: string, newName: string): { ok: boolean; reason?: string } {
		const entry = this.entries.get(oldName);
		if (!entry) return { ok: false, reason: `没有 {{sec:${oldName}}}` };
		if (oldName === newName) return { ok: true };
		if (this.entries.has(newName)) return { ok: false, reason: `{{sec:${newName}} 已存在` };
		this.entries.delete(oldName);
		this.entries.set(newName, { ...entry, name: newName });
		return { ok: true };
	}

	clear(): void {
		this.entries.clear();
	}

	/** 参与脱敏的条目：值够长，长的排前面（短值可能是长值的子串，先替换长的才不会被切碎）。 */
	maskables(): Entry[] {
		return this.list()
			.filter((entry) => entry.value.length >= MIN_MASK_LEN)
			.sort((a, b) => b.value.length - a.value.length);
	}
}

// ---------------------------------------------------------------------------
// 注册表：跨 /reload 保留，跨会话丢弃
// ---------------------------------------------------------------------------

const REGISTRY_KEY = "__PI_SECRET_VAULTS__";

type Registry = Map<string, Vault>;

function registry(): Registry {
	const bag = globalThis as unknown as Record<string, unknown>;
	let reg = bag[REGISTRY_KEY] as Registry | undefined;
	if (!reg) {
		reg = new Map<string, Vault>();
		bag[REGISTRY_KEY] = reg;
	}
	return reg;
}

/** 取（必要时建）某个会话的库。scope 由调用方给会话标识，通常是会话文件路径。 */
export function vaultFor(scope: string): Vault {
	const reg = registry();
	let vault = reg.get(scope);
	if (!vault) {
		vault = new Vault();
		reg.set(scope, vault);
	}
	return vault;
}

export function dropVault(scope: string): void {
	registry().delete(scope);
}
