/**
 * 重建跨扩展测试的依赖：src/extensions/node_modules/
 *
 * 这些包不入库（pi 全局安装的副本），换机器 / pi 升级后需要重建。放在 src/extensions/ 下
 * （而非某个 test 子目录），所有子目录测试都能沿祖先向上解析到同一份依赖。
 * 目标是把全局 pi 的 node_modules 树"扁平化搬运"过来：
 *   src/extensions/node_modules/<第三方>                    ← pi-coding-agent/node_modules/<第三方>
 *   src/extensions/node_modules/@earendil-works/<包>         ← 同上（chord/pi-ai/pi-tui…）
 *   src/extensions/node_modules/@earendil-works/pi-coding-agent ← pi 本体（含它自己的 node_modules）
 *
 * 优先 symbolic link / junction，不支持链接的文件系统（如 D:）回退为递归复制（约 270MB）。
 * 用法：node src/extensions/test/relink-deps.mjs（仓库根目录执行）
 */
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const TEST_NM = path.join(ROOT, "src", "extensions", "node_modules");

let GLOBAL_SCOPE;
try {
	GLOBAL_SCOPE = path.join(cp.execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works");
} catch {
	console.error("✗ 无法定位全局 npm 包目录（npm root -g 失败）");
	process.exit(1);
}
const CORE = path.join(GLOBAL_SCOPE, "pi-coding-agent");
const CORE_NM = path.join(CORE, "node_modules");
if (!fs.existsSync(CORE)) {
	console.error(`✗ 找不到全局 pi 包：${CORE}`);
	process.exit(1);
}

function remove(target) {
	try {
		fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
	} catch {
		/* 链接/只读文件删除失败时继续下一步 */
	}
}

function link(src, dest) {
	for (const type of ["dir", "junction"]) {
		try {
			fs.symlinkSync(src, dest, type);
			return type;
		} catch {
			remove(dest);
		}
	}
	return null;
}

/** 手写递归复制：fs.cpSync 在部分环境（D: + 中文路径）下会静默不写入，不能依赖 */
function copyDir(src, dest) {
	const st = fs.lstatSync(src);
	if (st.isSymbolicLink()) return copyDir(fs.realpathSync(src), dest);
	if (!st.isDirectory()) {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(src, dest);
		return;
	}
	fs.mkdirSync(dest, { recursive: true });
	for (const e of fs.readdirSync(src, { withFileTypes: true })) {
		copyDir(path.join(src, e.name), path.join(dest, e.name));
	}
}

// 收集要搬运的条目：第三方依赖 + @earendil-works 下的包 + pi 本体
const entries = [];
for (const e of fs.readdirSync(CORE_NM, { withFileTypes: true })) {
	if (e.name === "@earendil-works") continue;
	entries.push([e.name, path.join(CORE_NM, e.name)]);
}
const scopeDir = path.join(CORE_NM, "@earendil-works");
for (const e of fs.readdirSync(scopeDir, { withFileTypes: true })) {
	entries.push([path.join("@earendil-works", e.name), path.join(scopeDir, e.name)]);
}
entries.push([path.join("@earendil-works", "pi-coding-agent"), CORE]);

fs.mkdirSync(TEST_NM, { recursive: true });
let linked = 0;
let copied = 0;
let skipped = 0;
for (const [rel, src] of entries) {
	const dest = path.join(TEST_NM, rel);
	if (!fs.existsSync(src)) {
		skipped++;
		continue;
	}
	remove(dest);
	const type = link(src, dest);
	if (type) {
		linked++;
		continue;
	}
	copyDir(src, dest);
	copied++;
}
console.log(
	`完成：共 ${entries.length} 项（链接 ${linked} · 复制 ${copied}${skipped ? ` · 跳过 ${skipped}` : ""}）` +
		(copied ? "——复制的项约占 270MB，pi 升级后重跑本脚本即可" : ""),
);
