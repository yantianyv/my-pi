#!/usr/bin/env node
/**
 * shared/config 回归测试：并发写临时文件的所有权与损坏隔离
 * 用法：node src/extensions/shared/test/config.test.mjs（仓库根执行）
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = join(HERE, ".tmp-config.mjs");
const failures = [];
const check = (name, ok) => {
	console.log(`  ${ok ? "✓" : "✗"} ${name}`);
	if (!ok) failures.push(name);
};

await build({
	entryPoints: [join(HERE, "..", "config.ts")],
	outfile: OUT,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	logLevel: "silent",
});
const { loadJsonConfig, saveJsonConfig } = await import(pathToFileURL(OUT).href);
const dir = mkdtempSync(join(tmpdir(), "pi-config-test-"));
const file = join(dir, "settings.json");
try {
	writeFileSync(file, JSON.stringify({ theme: "old" }));
	const otherTmp = `${file}.tmp-424242`;
	writeFileSync(otherTmp, JSON.stringify({ theme: "in-flight" }));
	check("读取配置不删除其他进程的写入临时文件", loadJsonConfig(file, {}, (v) => typeof v === "object" && v !== null) && existsSync(otherTmp));

	saveJsonConfig(file, { theme: "new" });
	check("正常写配置仍原子替换", JSON.parse(readFileSync(file, "utf8")).theme === "new");
	check("当前进程临时文件不残留", !existsSync(`${file}.tmp-${process.pid}`));

	writeFileSync(file, "{ broken");
	loadJsonConfig(file, { fallback: true }, () => true);
	check("坏 JSON 仍隔离留证", existsSync(`${file}.corrupt-${Date.now()}`) || existsSync(file) === false);
} finally {
	rmSync(dir, { recursive: true, force: true });
	rmSync(OUT, { force: true });
}
console.log(failures.length === 0 ? "\n全部通过 ✓" : `\n${failures.length} 项失败 ✗`);
process.exit(failures.length === 0 ? 0 : 1);
