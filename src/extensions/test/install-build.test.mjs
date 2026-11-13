#!/usr/bin/env node
/**
 * install.js / build.js 回归：vendor 删除边界、空清单清理、失效文件移除与 dry-run 不写目录
 * 用法：node src/extensions/test/install-build.test.mjs（仓库根执行）
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures = [];
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !extra ? "" : `：${extra}`}`);
	if (!ok) failures.push(name);
};

const home = mkdtempSync(join(tmpdir(), "pi-install-test-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const install = createRequire(import.meta.url)("../../../install.js");
const { registerVendorPackages, copyAll, copyDir } = install.__test__;
const vendor = join(home, ".pi", "agent", "vendor");
const settingsPath = join(home, ".pi", "agent", "settings.json");
const oldPkg = join(vendor, "old-package");
const outside = join(vendor, "..", "outside");
mkdirSync(oldPkg, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(oldPkg, "keep.txt"), "old");
writeFileSync(join(outside, "keep.txt"), "outside");
writeFileSync(settingsPath, JSON.stringify({ packages: [oldPkg, `${vendor}/../outside`] }));

try {
	registerVendorPackages([]);
	check("空 vendor 清单清理直接子目录", !existsSync(oldPkg));
	check("含 .. 的路径不能越界删除", existsSync(outside));
	check("settings.packages 同步清空", JSON.parse(readFileSync(settingsPath, "utf8")).packages.length === 0, readFileSync(settingsPath, "utf8"));

	const src = join(home, "src-pkg");
	const dst = join(home, "dst-pkg");
	mkdirSync(src, { recursive: true });
	mkdirSync(dst, { recursive: true });
	writeFileSync(join(src, "new.ts"), "new");
	writeFileSync(join(dst, "stale.ts"), "stale");
	copyAll(src, dst);
	check("复制时删除来源已移除的文件", !existsSync(join(dst, "stale.ts")) && existsSync(join(dst, "new.ts")));

	const noWrite = join(home, "dry-run-destination");
	copyDir(src, noWrite);
	check("非 dry-run 的复制调用创建目标目录", existsSync(noWrite));

	const buildSource = readFileSync(join(process.cwd(), "src", "build.js"), "utf8");
	check("构建旧产物按 basename 集合比较", buildSource.includes("expected.has(f)") && !buildSource.includes("e.out.endsWith(f)"));
	const installSource = readFileSync(join(process.cwd(), "install.js"), "utf8");
	check("构建错误提示指向 src/build.js", installSource.includes("node src/build.js 排查") && !installSource.includes("node build.js 排查"));
} finally {
	rmSync(home, { recursive: true, force: true });
}
console.log(failures.length === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures.length === 0 ? 0 : 1);
