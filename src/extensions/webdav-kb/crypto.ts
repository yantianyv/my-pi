/**
 * webdav-kb / crypto.ts — 可选加密（vault/ 目录级，口令派生密钥）
 *
 * 方案：口令 + 随机 salt → scrypt 派生 256 位密钥 → AES-256-GCM 加密。
 * 文件格式：[MAGIC "KBE1"(4B)][nonce(12B)][authTag(16B)][ciphertext]。
 * 每次加密用随机 nonce（GCM 随机 96 位 nonce 复用概率可忽略），密钥只在解锁时
 * 派生一次、存于模块内存。可选开启「记住口令」：派生密钥会写入本地配置
 * `kb-config.json` 供下次启动自动解锁，关闭记忆时自动清除。
 *
 * 目录策略（按目录分而非按文件）：/vault/ 下所有文件整目录加密，其余命名空间明文。
 * 落盘/传输的永远是密文：镜像里是 xxx.md.enc（sync 层无感知地把它当普通文件同步），
 * 读取/检索时解密。解锁口令校验：配置存 salt + 一段已知明文的密文 check 块，
 * unlockVault 用口令解密 check 成功即视为口令正确并解锁。
 *
 * 边界：GCM 密文被篡改会因 authTag 校验失败直接抛错（不会静默返回坏数据）。
 * 未解锁时调用加密/解密抛 VaultLockedError。
 */
import * as crypto from "node:crypto";
import { KbConfig, putNote, readNoteBytes } from "./sync";
import { loadConfig, saveConfig, agentConfigDir } from "./store";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from("KBE1", "utf8"); // 4B
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + NONCE_LEN + TAG_LEN; // 32
/** check 块的已知明文（用于解锁时验证口令） */
const CHECK_PLAINTEXT = "__kb_vault_check__";

export class VaultLockedError extends Error {
	constructor() {
		super("vault 未解锁：请先输入口令");
		this.name = "VaultLockedError";
	}
}

export class VaultAuthError extends Error {
	constructor() {
		super("口令错误或密文被篡改");
		this.name = "VaultAuthError";
	}
}

// ---------------------------------------------------------------------------
// 模块级密钥状态（仅存内存）
// ---------------------------------------------------------------------------

let currentKey: Buffer | null = null;

export function isUnlocked(): boolean {
	return currentKey !== null;
}

/** 锁定（清空内存密钥）。configDir 非空时同时清除磁盘持久化密钥 */
export function lockVault(configDir?: string): void {
	currentKey = null;
	if (configDir) {
		try {
			const cfg = loadConfig(configDir);
			if (cfg.vaultKey || cfg.persistVault) {
				cfg.vaultKey = undefined;
				cfg.persistVault = undefined;
				saveConfig(configDir, cfg);
			}
		} catch { /* 静默 */ }
	}
}

/** 持久化派生密钥到配置文件（供下次启动自动解锁） */
export function storeVaultKey(key: Buffer, cfg: KbConfig): void {
	try {
		cfg.vaultKey = key.toString("base64");
		cfg.persistVault = true;
		saveConfig(agentConfigDir(), cfg);
	} catch { /* 静默 */ }
}

/** 从配置加载已持久化的密钥（启动时自动解锁用） */
export function loadVaultKey(cfg: KbConfig): Buffer | null {
	if (!cfg.vaultKey) return null;
	try {
		const key = Buffer.from(cfg.vaultKey, "base64");
		return key.length === 32 ? key : null;
	} catch {
		return null;
	}
}

/** 把当前内存密钥持久化到配置（vault 已解锁且 persistVault=true 时调用） */
export function persistCurrentKey(cfg: KbConfig): void {
	if (currentKey && cfg.persistVault) {
		storeVaultKey(currentKey, cfg);
	}
}

// ---------------------------------------------------------------------------
// 口令派生与解锁
// ---------------------------------------------------------------------------

export interface VaultSetup {
	/** salt（base64）——每次 createVault 随机生成，写进配置 */
	salt: string;
	/** 已知明文的密文 check 块（base64）——解锁口令校验用 */
	check: string;
	/** 派生密钥 base64（供 persistVault 选项持久化，可选） */
	key?: string;
}

/** 创建 vault 设置（首次启用时调用）：随机 salt + 派生密钥加密 check 块 */
export function createVault(passphrase: string): VaultSetup {
	const salt = crypto.randomBytes(SALT_LEN);
	const key = deriveKey(passphrase, salt);
	const check = aesGcmEncrypt(key, Buffer.from(CHECK_PLAINTEXT, "utf8"));
	return {
		salt: salt.toString("base64"),
		check: Buffer.from(check).toString("base64"),
		key: key.toString("base64"),
	};
}

/** 尝试解锁：口令能解密 check 块即解锁成功；失败返回 null（不置密钥）。persistVault=true 时派生密钥写盘供下次自动解锁 */
export function unlockVault(passphrase: string, setup: VaultSetup, persistVault?: boolean): Buffer | null {
	try {
		const key = deriveKey(passphrase, Buffer.from(setup.salt, "base64"));
		const check = aesGcmDecrypt(key, Buffer.from(setup.check, "base64"));
		if (check.toString("utf8") !== CHECK_PLAINTEXT) return null;
		currentKey = key;
		if (persistVault) {
			const cfg = loadConfig(agentConfigDir());
			cfg.vaultKey = key.toString("base64");
			cfg.persistVault = true;
			saveConfig(agentConfigDir(), cfg);
		}
		return key;
	} catch {
		return null;
	}
}

/** 直接用已存密钥解锁（自动解锁场景，不需口令） */
export function unlockVaultWithKey(keyBase64: string, setup: VaultSetup): boolean {
	try {
		const key = Buffer.from(keyBase64, "base64");
		if (key.length !== 32) return false;
		const check = aesGcmDecrypt(key, Buffer.from(setup.check, "base64"));
		if (check.toString("utf8") !== CHECK_PLAINTEXT) return false;
		currentKey = key;
		return true;
	} catch {
		return false;
	}
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
	// scrypt：内存硬、抗 GPU 并行（Node 内置，零依赖）；默认参数已足够（~50-100ms）
	return crypto.scryptSync(passphrase, salt, 32);
}

// ---------------------------------------------------------------------------
// 加解密原语
// ---------------------------------------------------------------------------

function aesGcmEncrypt(key: Buffer, plain: Buffer): Buffer {
	const nonce = crypto.randomBytes(NONCE_LEN);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
	const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([MAGIC, nonce, tag, enc]);
}

function aesGcmDecrypt(key: Buffer, blob: Buffer): Buffer {
	if (blob.length < HEADER_LEN || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
		throw new VaultAuthError();
	}
	const nonce = blob.subarray(MAGIC.length, MAGIC.length + NONCE_LEN);
	const tag = blob.subarray(MAGIC.length + NONCE_LEN, HEADER_LEN);
	const enc = blob.subarray(HEADER_LEN);
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAuthTag(tag);
	try {
		return Buffer.concat([decipher.update(enc), decipher.final()]);
	} catch {
		throw new VaultAuthError(); // GCM 校验失败 = 口令错或数据被篡改
	}
}

/** 加密（未解锁抛 VaultLockedError） */
export function encryptBytes(data: Uint8Array): Uint8Array {
	if (!currentKey) throw new VaultLockedError();
	return aesGcmEncrypt(currentKey, Buffer.from(data));
}

/** 解密（未解锁抛 VaultLockedError；口令错/被篡改抛 VaultAuthError） */
export function decryptBytes(data: Uint8Array): Uint8Array {
	if (!currentKey) throw new VaultLockedError();
	return aesGcmDecrypt(currentKey, Buffer.from(data));
}

// ---------------------------------------------------------------------------
// 路径映射：/vault/ 下 xxx.md ↔ xxx.md.enc
// ---------------------------------------------------------------------------

export const VAULT_PREFIX = "/vault";

/** 是否属于加密区 */
export function isVaultPath(rel: string): boolean {
	return rel.startsWith(VAULT_PREFIX + "/") || rel === VAULT_PREFIX;
}

/** 明文相对路径 → 密文文件名（"/vault/a.md" → "/vault/a.md.enc"）；非 vault 原样返回 */
export function encryptPath(rel: string): string {
	if (!isVaultPath(rel)) return rel;
	return rel + ".enc";
}

/** 密文文件名 → 明文路径（"/vault/a.md.enc" → "/vault/a.md"）；非 .enc 返回 null */
export function decryptPath(relEnc: string): string | null {
	if (!relEnc.endsWith(".enc")) return null;
	const plain = relEnc.slice(0, -".enc".length);
	return isVaultPath(plain) ? plain : null;
}

// ---------------------------------------------------------------------------
// 镜像级读写封装（工具层用）：vault 透明加解密
// ---------------------------------------------------------------------------

/**
 * 写笔记（vault 透明）：/vault/ 下自动加密后落盘+上传 .enc（明文永不落盘/上传）；
 * 其余命名空间直写。返回远端 etag 或 null（离线仅本地）。
 */
export async function vaultPutNote(
	cfg: KbConfig,
	mirrorDir: string,
	relPath: string,
	content: string | Uint8Array,
	opts: { signal?: AbortSignal } = {},
): Promise<string | null> {
	if (isVaultPath(relPath)) {
		const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
		return putNote(cfg, mirrorDir, encryptPath(relPath), encryptBytes(data), opts);
	}
	return putNote(cfg, mirrorDir, relPath, content, opts);
}

/** 读笔记（vault 透明）：/vault/ 下读 .enc 字节并解密；未解锁/口令错抛对应错误 */
export function vaultReadNote(mirrorDir: string, relPath: string): string | null {
	if (!isVaultPath(relPath)) {
		const plain = readNoteBytes(mirrorDir, relPath);
		return plain === null ? null : new TextDecoder().decode(plain);
	}
	const blob = readNoteBytes(mirrorDir, encryptPath(relPath));
	if (blob === null) return null;
	return new TextDecoder().decode(decryptBytes(blob));
}
