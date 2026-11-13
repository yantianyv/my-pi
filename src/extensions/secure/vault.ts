/**
 * secure / vault.ts — 会话级内存凭据库
 *
 * 值只活在内存：不落盘、不进会话 JSONL、不写临时文件。槽位按会话标识索引，
 * /reload 保留（注册表挂 globalThis），/new 与退出即弃。
 *
 * 名字带值指纹（`apikey-a3f9c2d1`）：同值恒定、异值不同，所以历史记录里同一个名字
 * 永远指同一个值，跨会话可辨。指纹用本机盐做 HMAC——没有盐文件算不出来，
 * 因此拿到历史记录也无法用候选值逐个验证。盐丢了（重装/卸载）只影响可辨性，
 * 不影响任何已存数据（本来就不落盘）。
 *
 * 对外一律给 PublicEntry（没有 value 字段）：列表、回执、状态栏都走它，值只从 get() 出。
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type EntryKind = "secret" | "text";

export interface Entry {
	name: string;
	value: string;
	kind: EntryKind;
	/** 录入时用户填的用途说明，给面板与 secret_list 展示 */
	label?: string;
	addedAt: number;
	length: number;
}

export interface PublicEntry {
	name: string;
	kind: EntryKind;
	label?: string;
	addedAt: number;
	/** 值长度（用于让用户确认录入的是完整值），不含值本身 */
	length: number;
	/** 长值给首尾各 4 字符，供用户认领；短值不给 */
	preview?: string;
}

/** 值短于此长度时不给 preview（前后各 4 字符几近全文） */
const PREVIEW_MIN_LEN = 24;

const previewOf = (value: string): string | undefined =>
	value.length >= PREVIEW_MIN_LEN ? `${value.slice(0, 4)}…${value.slice(-4)}` : undefined;

/** 值的内容指纹（去重判据，不可逆） */
const fingerprintOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);

export function toPublic(entry: Entry): PublicEntry {
	return {
		name: entry.name,
		kind: entry.kind,
		...(entry.label ? { label: entry.label } : {}),
		addedAt: entry.addedAt,
		length: entry.length,
		preview: previewOf(entry.value),
	};
}

/** 名字规则：字母开头，可含字母数字与 . _ -（与 ref 语法一致） */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const isValidName = (name: string): boolean => NAME_RE.test(name);

export class Vault {
	private entries = new Map<string, Entry>();

	size(): number {
		return this.entries.size;
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	get(name: string): string | undefined {
		return this.entries.get(name)?.value;
	}

	/** 按值查找已存在的条目名（同值不重复入库） */
	nameOfValue(value: string): string | undefined {
		const fp = fingerprintOf(value);
		for (const entry of this.entries.values()) {
			if (fingerprintOf(entry.value) === fp) return entry.name;
		}
		return undefined;
	}

	add(input: { name: string; value: string; kind?: EntryKind; label?: string }): Entry {
		const entry: Entry = {
			name: input.name,
			value: input.value,
			kind: input.kind ?? "secret",
			...(input.label ? { label: input.label } : {}),
			addedAt: Date.now(),
			length: input.value.length,
		};
		this.entries.set(entry.name, entry);
		return entry;
	}

	remove(name: string): boolean {
		return this.entries.delete(name);
	}

	list(): PublicEntry[] {
		return [...this.entries.values()].map(toPublic).sort((a, b) => a.name.localeCompare(b.name));
	}

	clear(): void {
		this.entries.clear();
	}

}

// ---------------------------------------------------------------------------
// 会话槽位（globalThis 承载，跨 /reload 保留）
// ---------------------------------------------------------------------------

interface VaultRegistry {
	vaults: Map<string, Vault>;
}

const REGISTRY_KEY = "__PI_SECURE_VAULTS__";

function registry(): VaultRegistry {
	const holder = globalThis as Record<string, unknown>;
	let reg = holder[REGISTRY_KEY] as VaultRegistry | undefined;
	if (!reg) {
		reg = { vaults: new Map() };
		holder[REGISTRY_KEY] = reg;
	}
	return reg;
}

export function vaultFor(scope: string): Vault {
	const reg = registry();
	let vault = reg.vaults.get(scope);
	if (!vault) {
		vault = new Vault();
		reg.vaults.set(scope, vault);
	}
	return vault;
}

export function dropVault(scope: string): void {
	registry().vaults.delete(scope);
}

// ---------------------------------------------------------------------------
// 值指纹与名字生成
// ---------------------------------------------------------------------------

/**
 * 盐文件：首次运行生成 32 字节随机数。丢失只影响「跨会话认得出同值」，不影响任何数据。
 * SECURE_STATE_DIR 供测试隔离（同 webdav-kb 的 KB_CONFIG_DIR），每次现读。
 */
const stateDir = (): string => process.env.SECURE_STATE_DIR ?? path.join(os.homedir(), ".pi", "agent");
const saltFile = (): string => path.join(stateDir(), "secure-salt");
const SALT_BYTES = 32;
/** 名字里的指纹位数：8 位十六进制 = 32 bit，几百个凭据也几乎不会撞（4 位在上百个时会撞） */
const FINGERPRINT_LEN = 8;

let cachedSalt: Buffer | undefined;

/** 读盐；不存在则生成。读写失败返回 undefined（指纹退化为不含盐的哈希，仍可用）。 */
function loadSalt(): Buffer | undefined {
	if (cachedSalt) return cachedSalt;
	try {
		const raw = fs.readFileSync(saltFile());
		if (raw.length >= SALT_BYTES) {
			cachedSalt = raw.subarray(0, SALT_BYTES);
			return cachedSalt;
		}
	} catch {
		// 不存在或读不了：下面生成
	}
	try {
		const salt = randomBytes(SALT_BYTES);
		fs.mkdirSync(stateDir(), { recursive: true });
		fs.writeFileSync(saltFile(), salt, { mode: 0o600 });
		cachedSalt = salt;
		return salt;
	} catch {
		// 写不了（只读文件系统等）：不阻塞功能，指纹退化为无盐哈希
		return undefined;
	}
}

/** 值指纹：同值恒定、异值不同。有盐时用 HMAC（无从用候选值反推），无盐时退化为 sha256。 */
export function valueFingerprint(value: string): string {
	const salt = loadSalt();
	const digest = salt
		? createHmac("sha256", salt).update(value, "utf8").digest("hex")
		: createHash("sha256").update(value, "utf8").digest("hex");
	return digest.slice(0, FINGERPRINT_LEN);
}

/** 形态标签 → 名字前缀（无对应时用 cred） */
const PREFIX_BY_LABEL: Record<string, string> = {
	"GitHub 令牌": "gh",
	"API 密钥": "apikey",
	"Stripe 密钥": "stripe",
	"AWS 访问密钥": "aws",
	"Google 密钥": "google",
	"Slack 令牌": "slack",
	"GitLab 令牌": "gitlab",
	"npm 令牌": "npm",
	"HuggingFace 令牌": "hf",
	"SendGrid 密钥": "sendgrid",
	JWT: "jwt",
	私钥: "key",
	连接串: "dsn",
};

/**
 * 按值和形态生成名字：`<前缀>-<指纹>`。同一个值永远得到同一个名字，
 * 所以重复粘贴不会产生第二条，历史记录里也能认出「上次那个就是这个」。
 */
export function nameFor(label: string, value: string): string {
	const prefix = PREFIX_BY_LABEL[label] ?? "cred";
	return `${prefix}-${valueFingerprint(value)}`;
}
