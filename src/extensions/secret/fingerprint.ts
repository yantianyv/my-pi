/**
 * secret / fingerprint.ts — 长期指纹表（跨会话，只有指纹没有值）
 *
 * 定位：值一旦落盘，本扩展的防护就退化成文件权限。所以这里只存 HMAC 指纹，够做且只做
 * 一件事——在文本里再遇到同一个值的时候认出来并遮住。它没法把值交给命令（那是会话内存
 * 库的活），命中时给模型看的是「本会话没有值」的占位。
 *
 * 键控：HMAC-SHA256(key, value)，key 是 32 字节随机数，落在同目录的另一个文件里。单拿表
 * 文件撞不了库；两个文件都拿到才可能对弱口令做字典攻击——因此只给 ≥16 字符的值建条目
 * （暴力破解无望的长度），短口令不进表。
 *
 * 匹配方式：值不可逆，没法 indexOf，只能把文本切成候选片段逐个算指纹比对。所以密码以
 * 独立片段出现（`密码：xxx`、`DB_PASSWORD=xxx`、`u:xxx@host`）能命中，嵌在更长串里的会漏。
 * 为此用宽窄两套分隔符各切一遍：宽集切出 `u:xxx@host` 里的 xxx，窄集保住含点号的 JWT 整段。
 */
import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";
import { variants } from "./detect";
import { shapePlaceholder } from "./refs";
import type { EntryKind } from "./vault";

/** 进长期表的长度下限。低于它的值只活在会话内存里。 */
export const MIN_FINGERPRINT_LEN = 16;
/** 单片段长度上限：防把整段二进制/长文当候选去算指纹。 */
const MAX_CANDIDATE_LEN = 4096;
/** 单次扫描的候选上限（超出只扫前这么多，避免超大输出把 UI 卡住）。 */
const MAX_CANDIDATES = 60_000;

/** 宽集：把 `k=v`、`u:p@h`、`a/b` 也切开。 */
const SPLIT_WIDE = /[\s"'`´+,;()[\]{}<>|=:@/\\*]+/;
/** 窄集：只按空白与结构符号切，保住含点号/短横线的整段（JWT、连接串）。 */
const SPLIT_NARROW = /[\s"'`´;,()[\]{}<>|]+/;

export interface FingerprintEntry {
	name: string;
	kind: EntryKind;
	length: number;
	label?: string;
	addedAt: number;
	/** 值本身与它的编码变体各自的指纹。 */
	hashes: string[];
}

export interface PublicFingerprint {
	name: string;
	kind: EntryKind;
	length: number;
	label?: string;
	addedAt: number;
	/** 指纹条数（值 + 编码变体）。 */
	count: number;
}

interface TableFile {
	v: number;
	entries: FingerprintEntry[];
}

const TABLE_VERSION = 1;

const isTableFile = (value: unknown): value is TableFile =>
	typeof value === "object" && value !== null && Array.isArray((value as TableFile).entries);

export class FingerprintTable {
	private entries = new Map<string, FingerprintEntry>();
	/** 指纹 → 名字，扫描时的查表索引。 */
	private index = new Map<string, string>();

	private constructor(
		private readonly tableFile: string,
		private readonly keyFile: string,
		private key: Buffer,
	) {}

	/** 载入（缺文件就空表）。表在而密钥丢了 → 旧指纹无从校验，重建密钥并清表。 */
	static load(dir: string): { table: FingerprintTable; notice?: string } {
		const tableFile = path.join(dir, "secret-fingerprints.json");
		const keyFile = path.join(dir, "secret-fingerprints.key");
		let key: Buffer | undefined;
		try {
			const raw = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
			if (raw.length === 32) key = raw;
		} catch {
			/* 没密钥文件：下面新建 */
		}
		const hadKeyFile = key !== undefined;
		const file = loadJsonConfig<TableFile>(tableFile, { v: TABLE_VERSION, entries: [] }, isTableFile);
		let notice: string | undefined;
		if (!key) {
			key = randomBytes(32);
			try {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(keyFile, key.toString("base64") + "\n", { encoding: "utf8", mode: 0o600 });
			} catch {
				/* 写不了密钥文件：本次会话仍可用，只是指纹不能跨会话 */
			}
		}
		const table = new FingerprintTable(tableFile, keyFile, key);
		// 换过密钥就认不了旧指纹（HMAC 对不上），旧条目必须丢掉——留着只会变成永远不命中的死数据。
		if (hadKeyFile) {
			for (const entry of file.entries) {
				if (entry && typeof entry.name === "string" && Array.isArray(entry.hashes)) table.put(entry);
			}
		} else if (file.entries.length > 0) {
			notice = "secret：指纹表的密钥文件丢失，旧指纹已无法校验，整表已重建";
			table.save();
		}
		return { table, notice };
	}

	private fingerprint(value: string): string {
		return createHmac("sha256", this.key).update(value, "utf8").digest("hex");
	}

	private put(entry: FingerprintEntry): void {
		this.entries.set(entry.name, entry);
		for (const hash of entry.hashes) this.index.set(hash, entry.name);
	}

	save(): void {
		const file: TableFile = { v: TABLE_VERSION, entries: [...this.entries.values()] };
		saveJsonConfig(this.tableFile, file);
	}

	/** 密钥文件路径（面板里给人看）。 */
	get keyPath(): string {
		return this.keyFile;
	}

	/**
	 * 记一条指纹。值短于下限时不写（返回 false）——弱口令进表等于把字典攻击的靶子搬回家。
	 */
	remember(input: { name: string; value: string; kind: EntryKind; label?: string }): boolean {
		if (input.value.length < MIN_FINGERPRINT_LEN) return false;
		const previous = this.entries.get(input.name);
		if (previous) this.forget(input.name);
		const hashes = [...new Set(variants(input.value).filter((v) => v.length >= MIN_FINGERPRINT_LEN))]
			.map((v) => this.fingerprint(v))
			.concat(this.fingerprint(input.value));
		this.put({
			name: input.name,
			kind: input.kind,
			length: input.value.length,
			label: input.label,
			addedAt: Date.now(),
			hashes: [...new Set(hashes)],
		});
		this.save();
		return true;
	}

	forget(name: string): boolean {
		const entry = this.entries.get(name);
		if (!entry) return false;
		this.entries.delete(name);
		// 同一个指纹可能被别的条目共用（同值的不同名字极少见），重建索引最省心。
		this.index.clear();
		for (const item of this.entries.values()) for (const hash of item.hashes) this.index.set(hash, item.name);
		this.save();
		return true;
	}

	clear(): void {
		this.entries.clear();
		this.index.clear();
		this.save();
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	get size(): number {
		return this.entries.size;
	}

	list(): PublicFingerprint[] {
		return [...this.entries.values()]
			.sort((a, b) => b.addedAt - a.addedAt)
			.map((entry) => ({
				name: entry.name,
				kind: entry.kind,
				length: entry.length,
				label: entry.label,
				addedAt: entry.addedAt,
				count: entry.hashes.length,
			}));
	}

	/** 文本里所有值得拿去比对的候选片段（宽窄两套切法，去重）。 */
	private candidates(text: string): string[] {
		const out = new Set<string>();
		for (const split of [SPLIT_WIDE, SPLIT_NARROW]) {
			for (const piece of text.split(split)) {
				if (piece.length >= MIN_FINGERPRINT_LEN && piece.length <= MAX_CANDIDATE_LEN) out.add(piece);
				if (out.size >= MAX_CANDIDATES) return [...out];
			}
		}
		return [...out];
	}

	/** 扫描文本：命中即换成「本会话没有值」的占位；返回新文本与命中数。 */
	scan(text: string): { text: string; hits: number } {
		if (this.index.size === 0 || text.length < MIN_FINGERPRINT_LEN) return { text, hits: 0 };
		let out = text;
		let hits = 0;
		for (const candidate of this.candidates(text)) {
			const name = this.index.get(this.fingerprint(candidate));
			if (name === undefined) continue;
			if (!out.includes(candidate)) continue;
			out = out.split(candidate).join(shapePlaceholder(`${name}（本会话没有值）`));
			hits++;
		}
		return { text: out, hits };
	}
}
