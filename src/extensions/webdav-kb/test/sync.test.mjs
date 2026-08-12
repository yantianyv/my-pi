#!/usr/bin/env node
/**
 * webdav-kb / sync.ts 增量同步单元测试（共享 mock DAV + esbuild bundle）
 *
 * 覆盖：首次全量下载、无变化幂等、远端改/删、本地新建/改/删、冲突（保留远端 +
 * 本地 .conflict 副本且不回传）、父目录自动创建、账本跨实例持久化、离线写入兜底补传、
 * .history 历史副本（远端删除留档/命名规则/不自我递归）、空目录清理、PROTOCOL 过滤。
 *
 * 用法：node src/extensions/webdav-kb/test/sync.test.mjs（仓库根目录执行）
 */
import { build } from "esbuild";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const USER = "test-user";
const PASS = "test-pass";

const tmp = mkdtempSync(join(tmpdir(), "kb-sync-test-"));
const dav = await startMockDav();
let syncAll, putNote, readNote, listNotes, loadLedger, backupToHistory;
try {
	// bundle sync.ts（连带 client/store 内联）
	const outfile = join(tmp, "sync.mjs");
	await build({
		entryPoints: [join(SRC_DIR, "extensions", "webdav-kb", "sync.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		tsconfig: join(SRC_DIR, "config", "tsconfig.build.json"),
		logLevel: "silent",
	});
	const m = await import(pathToFileURL(outfile));
	syncAll = m.syncAll;
	putNote = m.putNote;
	readNote = m.readNote;
	listNotes = m.listNotes;
	loadLedger = m.loadLedger;
	backupToHistory = m.backupToHistory;

	const mirrorDir = join(tmp, "mirror");
	const cfg = { baseUrl: dav.baseUrl, username: USER, password: PASS };
	const local = (rel) => join(mirrorDir, ...rel.split("/").filter(Boolean));

	// ---- 1) 首次同步全量下载 ----
	dav.seed("/notes/a.md", "# A\n远端内容 A\n");
	dav.seed("/notes/sub/b.md", "# B\n远端内容 B\n");
	dav.seed("/refs/c.md", "# C\n引用 C\n");
	let s = await syncAll(cfg, mirrorDir);
	check("首次同步下载 3 个文件", s.downloaded === 3 && s.errors.length === 0, JSON.stringify(s));
	check("镜像内容正确", readNote(mirrorDir, "/notes/a.md") === "# A\n远端内容 A\n");
	check("嵌套目录落盘", readNote(mirrorDir, "/notes/sub/b.md") === "# B\n远端内容 B\n");
	check("账本生成 3 条", Object.keys(loadLedger(mirrorDir).files).length === 3);

	// ---- 2) 无变化二次同步幂等 ----
	s = await syncAll(cfg, mirrorDir);
	check("二次同步零操作", s.downloaded === 0 && s.uploaded === 0 && s.deleted === 0 && s.conflicts === 0, JSON.stringify(s));
	check("无变化计数 = 3", s.unchanged === 3, String(s.unchanged));

	// ---- 3) 远端修改 → 下载 ----
	dav.seed("/notes/a.md", "# A\n远端内容 A v2\n");
	s = await syncAll(cfg, mirrorDir);
	check("远端修改被下载", s.downloaded === 1 && readNote(mirrorDir, "/notes/a.md") === "# A\n远端内容 A v2\n", JSON.stringify(s));

	// ---- 4) 远端删除 → 删本地 ----
	dav.store.delete(dav.prefix + "/refs/c.md");
	s = await syncAll(cfg, mirrorDir);
	check("远端删除同步到本地", s.deleted === 1 && !existsSync(local("/refs/c.md")), JSON.stringify(s));

	// ---- 5) 本地新建 → 上传（含父目录自动创建） ----
	mkdirSync(local("/deep/x"), { recursive: true });
	writeFileSync(local("/deep/x/new.md"), "# 本地新建\n");
	s = await syncAll(cfg, mirrorDir);
	// uploaded>=1：新建文件 + 上轮远端删除留档的 .history 副本补传（延迟一轮同步）
	check("本地新建上传", s.uploaded >= 1 && s.errors.length === 0, JSON.stringify(s));
	check("远端父目录已创建", dav.store.has(dav.prefix + "/deep/x"));
	check("远端内容正确", dav.store.get(dav.prefix + "/deep/x/new.md").data.toString() === "# 本地新建\n");

	// ---- 6) 本地修改 → 上传 ----
	writeFileSync(local("/notes/sub/b.md"), "# B\n本地改的内容\n");
	s = await syncAll(cfg, mirrorDir);
	check("本地修改上传", s.uploaded === 1, JSON.stringify(s));
	check("远端已更新", dav.store.get(dav.prefix + "/notes/sub/b.md").data.toString() === "# B\n本地改的内容\n");

	// ---- 7) 本地删除 → 删远端 ----
	rmSync(local("/deep/x/new.md"));
	s = await syncAll(cfg, mirrorDir);
	check("本地删除同步到远端", s.deleted === 1 && !dav.store.has(dav.prefix + "/deep/x/new.md"), JSON.stringify(s));

	// ---- 8) 冲突：两侧都改 → 保留远端 + 本地 .conflict 副本 ----
	writeFileSync(local("/notes/a.md"), "# A\n本地抢先修改\n"); // 本地改
	// 稍候让 mtime 稳定，再改远端
	await new Promise((r) => setTimeout(r, 50));
	dav.seed("/notes/a.md", "# A\n远端也改了\n"); // 远端改
	s = await syncAll(cfg, mirrorDir);
	check("冲突被检出", s.conflicts === 1, JSON.stringify(s));
	check("冲突后本地为远端版", readNote(mirrorDir, "/notes/a.md") === "# A\n远端也改了\n");
	const conflictFiles = readdirSync(local("/notes")).filter((f) => f.includes(".conflict-"));
	check("冲突副本已保留", conflictFiles.length === 1 && conflictFiles[0].startsWith("a.conflict-"), JSON.stringify(conflictFiles));
	check("冲突副本内容为本地版", readFileSync(local("/notes/" + conflictFiles[0]), "utf8") === "# A\n本地抢先修改\n");

	// ---- 9) 冲突副本不回传 ----
	s = await syncAll(cfg, mirrorDir);
	check("冲突副本不参与上传", s.uploaded === 0, JSON.stringify(s));
	check("远端仍是远端版", dav.store.get(dav.prefix + "/notes/a.md").data.toString() === "# A\n远端也改了\n");

	// ---- 10) 账本跨实例持久化（新 syncAll 调用仍识别无变化） ----
	const before = Object.keys(loadLedger(mirrorDir).files).length;
	s = await syncAll(cfg, mirrorDir);
	check("跨实例账本持久且幂等", s.downloaded === 0 && s.uploaded === 0 && Object.keys(loadLedger(mirrorDir).files).length === before, JSON.stringify(s));

	// ---- 11) 离线上传兜底：putNote 写本地失败后下次同步补传 ----
	await putNote({ baseUrl: "http://127.0.0.1:1", username: USER, password: PASS }, mirrorDir, "/notes/offline.md", "# 离线写入\n");
	check("putNote 断网时仅写本地", existsSync(local("/notes/offline.md")));
	check("putNote 断网时远端无", !dav.store.has(dav.prefix + "/notes/offline.md"));
	s = await syncAll(cfg, mirrorDir);
	check("离线积压被补传", s.uploaded === 1 && dav.store.has(dav.prefix + "/notes/offline.md"), JSON.stringify(s));
	check("补传后本地未误删", existsSync(local("/notes/offline.md")));

	// ---- 12) 本地目录与文件列表 ----
	const listing = listNotes(mirrorDir);
	check("listNotes 含文件与目录", listing.some((f) => f.path === "/notes/offline.md") && listing.some((f) => f.path === "/notes" && f.isDir), JSON.stringify(listing));
	check("listNotes 跳过账本与冲突副本", !listing.some((f) => f.path.includes(".conflict-") || f.path.includes(".kb-")), JSON.stringify(listing));

	// ---- 13) .history 历史副本：远端删除留档（结构镜像根、内容为旧版、已补传远端） ----
	const histFiles = readdirSync(local("/.history/refs")).filter((f) => f.startsWith("c_"));
	check("远端删除留 .history 副本", histFiles.length >= 1, JSON.stringify(histFiles));
	check("历史副本内容为旧版", histFiles.every((f) => readFileSync(local("/.history/refs/" + f), "utf8") === "# C\n引用 C\n"));
	check("历史副本已上传远端", histFiles.length >= 1 && dav.store.has(dav.prefix + "/.history/refs/" + histFiles[0]));

	// ---- 14) 历史备份命名：_yymmddhhmmss 后缀 / 同秒重名 _hash / 同秒同内容跳过 / 不自我递归 ----
	// backupToHistory 为同步函数，三连调用同时间戳（yymmddhhmmss 12 位）
	const enc = (s) => new TextEncoder().encode(s);
	const h1 = backupToHistory(mirrorDir, "/notes/a.md", enc("# A\n第一版\n"));
	check("备份路径带时间戳后缀且结构镜像根", h1 !== null && /^\/\.history\/notes\/a_\d{12}\.md$/.test(h1), String(h1));
	const h2 = backupToHistory(mirrorDir, "/notes/a.md", enc("# A\n第二版\n"));
	check("同秒不同内容 → 叠加 _hash", h2 !== null && h2 !== h1 && /^\/\.history\/notes\/a_\d{12}_[0-9a-f]{8}\.md$/.test(h2), String(h2));
	const h3 = backupToHistory(mirrorDir, "/notes/a.md", enc("# A\n第二版\n"));
	check("同秒同内容 → 跳过", h3 === null, String(h3));
	check("history 不自我递归", backupToHistory(mirrorDir, "/.history/notes/a.md", enc("x")) === null);
	check("LFS 不备份", backupToHistory(mirrorDir, "/lfs/x.bin", enc("x")) === null);

	// ---- 15) 空目录清理 + 列表过滤（.history / PROTOCOL.md 对内容浏览不透明） ----
	mkdirSync(local("/scratch/空目录"), { recursive: true });
	writeFileSync(local("/PROTOCOL.md"), "# 守则\n");
	s = await syncAll(cfg, mirrorDir);
	check("空目录被清理", !existsSync(local("/scratch/空目录")) && !existsSync(local("/scratch")));
	const listing2 = listNotes(mirrorDir);
	check("listNotes 跳过 .history 与 PROTOCOL", !listing2.some((f) => f.path.startsWith("/.history") || f.path === "/PROTOCOL.md"), JSON.stringify(listing2));
	// PROTOCOL.md 仍可被 kb_help 读取（readNote 不经 listNotes）
	check("PROTOCOL.md 仍可直读", readNote(mirrorDir, "/PROTOCOL.md") === "# 守则\n");
} finally {
	dav.close();
	rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
