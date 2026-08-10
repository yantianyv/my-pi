#!/usr/bin/env node
/**
 * webdav-kb / crypto.ts 加密单元测试（esbuild bundle + 本地镜像 fixture）
 *
 * 覆盖：口令派生/解锁（错口令拒绝）、加解密往返（文本+二进制）、篡改检测
 * （GCM authTag）、未解锁保护、路径映射（/vault 明文 ↔ .enc）、vaultPutNote/
 * vaultReadNote 透明读写（明文不落盘）、vault 密文随 sync 同步、search 解密钩子
 * 索引（解锁可搜/锁定跳过）+ 缓存不落盘明文词频。
 *
 * 用法：node src/extensions/webdav-kb/test/crypto.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { startMockDav } from "./mock-dav.mjs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "../../..");

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		console.error(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
		failures++;
	}
};

/** 读文件原始字节（不存在返回 null） */
function rawRead(mirror, rel) {
	try {
		return readFileSync(join(mirror, ...rel.split("/").filter(Boolean)));
	} catch {
		return null;
	}
}

const tmp = mkdtempSync(join(tmpdir(), "kb-crypto-test-"));
const dav = await startMockDav();
try {
	// 组合入口：crypto + sync 的 syncAll + search 的 NoteIndex（单一 bundle 供测试）
	const entry = join(tmp, "entry.ts");
	writeFileSync(
		entry,
		[
			'export * from "' + join(SRC_DIR, "extensions", "webdav-kb", "crypto.ts").replace(/\\/g, "/") + '";',
			'export { syncAll } from "' + join(SRC_DIR, "extensions", "webdav-kb", "sync.ts").replace(/\\/g, "/") + '";',
			'export { NoteIndex } from "' + join(SRC_DIR, "extensions", "webdav-kb", "search.ts").replace(/\\/g, "/") + '";',
		].join("\n"),
		"utf8",
	);
	const outfile = join(tmp, "crypto.mjs");
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
	const m = await import(pathToFileURL(outfile));
	const {
		createVault, unlockVault, isUnlocked, lockVault, encryptBytes, decryptBytes,
		encryptPath, decryptPath, isVaultPath, vaultPutNote, vaultReadNote,
		VaultLockedError, VaultAuthError, syncAll, NoteIndex,
	} = m;

	// ---- 口令派生与解锁 ----
	const setup = createVault("正确口令123");
	check("createVault 生成 salt+check", setup.salt.length > 0 && setup.check.length > 0);
	check("初始未解锁", !isUnlocked());
	check("错口令解锁失败", unlockVault("错误口令", setup) === false && !isUnlocked());
	check("正确口令解锁成功", unlockVault("正确口令123", setup) === true && isUnlocked());

	// ---- 加解密往返 ----
	const text = "秘密内容：PBKDF2 与 AES-256-GCM 的加密笔记。";
	const enc = encryptBytes(new TextEncoder().encode(text));
	check("密文非明文", !new TextDecoder().decode(enc).includes("PBKDF2"));
	check("解密往返一致", new TextDecoder().decode(decryptBytes(enc)) === text);
	// 二进制往返
	const bin = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
	const binDec = decryptBytes(encryptBytes(bin));
	check("二进制往返一致", Buffer.from(binDec).equals(Buffer.from(bin)));

	// ---- 篡改检测 ----
	const tampered = Uint8Array.from(enc);
	tampered[tampered.length - 1] ^= 0xff;
	let tamperErr = null;
	try {
		decryptBytes(tampered);
	} catch (e) {
		tamperErr = e;
	}
	check("篡改被 GCM 检出", tamperErr instanceof VaultAuthError, String(tamperErr?.name));

	// ---- 锁定后保护 ----
	lockVault();
	let lockErr = null;
	try {
		encryptBytes(new TextEncoder().encode("x"));
	} catch (e) {
		lockErr = e;
	}
	check("锁定后加密抛 VaultLockedError", lockErr instanceof VaultLockedError);
	unlockVault("正确口令123", setup);

	// ---- 路径映射 ----
	check("isVaultPath 判定", isVaultPath("/vault/a.md") && !isVaultPath("/notes/a.md"));
	check("encryptPath 映射", encryptPath("/vault/a.md") === "/vault/a.md.enc" && encryptPath("/notes/a.md") === "/notes/a.md");
	check("decryptPath 还原", decryptPath("/vault/a.md.enc") === "/vault/a.md" && decryptPath("/notes/a.md") === null);

	// ---- vault 透明读写（明文不落盘） ----
	const mirror = join(tmp, "mirror");
	const cfg = { baseUrl: dav.baseUrl, username: "test-user", password: "test-pass" };
	await vaultPutNote(cfg, mirror, "/vault/机密.md", "# 机密\n口令是 hunter2\n");
	await vaultPutNote(cfg, mirror, "/notes/普通.md", "# 普通\n公开内容\n");
	const disk = readdirSync(join(mirror, "vault"));
	check("vault 落盘为 .enc", disk.length === 1 && disk[0] === "机密.md.enc", JSON.stringify(disk));
	check("磁盘密文不含明文", !rawRead(mirror, "/vault/机密.md.enc").toString("utf8").includes("hunter2"));
	check("明文路径文件不存在", rawRead(mirror, "/vault/机密.md") === null);
	check("vaultReadNote 解密正确", vaultReadNote(mirror, "/vault/机密.md")?.includes("hunter2"));
	check("普通区读写不受影响", vaultReadNote(mirror, "/notes/普通.md") === "# 普通\n公开内容\n");

	// ---- 锁定后 vault 读抛错 ----
	lockVault();
	let lockedRead = null;
	try {
		vaultReadNote(mirror, "/vault/机密.md");
	} catch (e) {
		lockedRead = e;
	}
	check("锁定后读 vault 抛 VaultLockedError", lockedRead instanceof VaultLockedError, String(lockedRead?.name));

	// ---- vault 密文随 sync 同步（sync 无感知） ----
	unlockVault("正确口令123", setup);
	await syncAll(cfg, mirror);
	check("vault .enc 已上传", dav.store.has(dav.prefix + "/vault/机密.md.enc"));
	check("明文未上传", !dav.store.has(dav.prefix + "/vault/机密.md"));
	check("普通区文件已上传", dav.store.has(dav.prefix + "/notes/普通.md"));

	// ---- search 解密钩子：解锁可搜、锁定跳过、缓存不落盘明文 ----
	const idx = new NoteIndex(mirror);
	idx.refresh();
	check("无解密钩子不索引 vault", !idx.paths().includes("/vault/机密.md"), JSON.stringify(idx.paths()));
	idx.setDecryptor((rel) => (isUnlocked() ? vaultReadNote(mirror, rel) : null));
	const r = idx.search("hunter2");
	check("解锁后 vault 可检索", r.some((x) => x.path === "/vault/机密.md"), JSON.stringify(r.map((x) => x.path)));
	check("vault 片段来自解密内容", r.some((x) => x.path === "/vault/机密.md" && x.snippet.includes("hunter2")), JSON.stringify(r.map((x) => x.snippet)));
	const cacheRaw = readFileSync(join(mirror, ".kb-index.json"), "utf8");
	check("索引缓存不含 vault 明文词频", !cacheRaw.includes("/vault/") && !cacheRaw.includes("hunter2"));
	lockVault();
	const idxLocked = new NoteIndex(mirror);
	idxLocked.setDecryptor((rel) => (isUnlocked() ? vaultReadNote(mirror, rel) : null));
	idxLocked.refresh();
	check("锁定后 vault 不被索引", !idxLocked.paths().includes("/vault/机密.md"), JSON.stringify(idxLocked.paths()));
	check("锁定后 vault 搜不到", idxLocked.search("hunter2").length === 0);
} finally {
	dav.close();
	rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
