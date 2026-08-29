/**
 * shell 复合命令拆分（共享模块）
 *
 * AI 常一次下发复合命令（`git add . && git commit`、`cat a | grep b`、
 * `rm -rf $(cat f)`）。权限判定若对整串做子串匹配有漏洞：
 * 白名单模式命中前半段会连带放行藏在后半段的危险命令。
 * 本模块按 shell 语义把命令拆成子命令段，供「逐段判定」使用：
 *   - 顶层分隔符：&& ｜ || ｜ ; ｜ | ｜ 换行（引号/转义内不切）；
 *   - 子 shell：$(...) 与 `...` 的内容会递归拆出追加为独立段
 *     （外层段保留，$(...) 原样留在段文本中供名单匹配）；
 *   - 单/双/反引号与反斜杠转义识别，echo "a && b" 不会误拆；
 *   - heredoc（<<[-~]['"]TAG['"] ... TAG）：主体是数据不是命令，不逐行拆分，
 *     整段留在操作符所在命令段内（白名单逐段加白时不会产生脚本逐行死规则；
 *     主体内若有 $(...)/`...` 仍会被递归拆出，不藏危险命令）。
 *
 * 启发式实现，不追求完整 POSIX 解析（process substitution 等边角按普通文本
 * 处理）——权限门场景下宁多拆不漏拆：拆出的段只会让更多子命令暴露在名单
 * 匹配下，不会减少覆盖面。heredoc 是唯一刻意不拆的例外（主体是数据）。
 *
 * 使用方：perm-gate（黑名单整串+逐段、白名单逐段全中才放行）。
 */
export function splitShellSegments(command: string): string[] {
	const all: string[] = [];
	const queue = [command];
	while (queue.length > 0) {
		const head = queue.shift()!;
		for (const seg of splitTopLevel(head)) {
			const t = seg.trim();
			if (!t) continue;
			all.push(t);
			// 子 shell 内容递归拆分（每轮严格变短，不会死循环）
			for (const inner of extractSubshellInners(t)) queue.push(inner);
		}
	}
	return all;
}

/** 顶层拆分：&& / || / ; / | / 换行；单双反引号、反斜杠转义与 $(...) 内部不切（子 shell 由递归拆出） */
function splitTopLevel(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null; // ' " `
	let parenDepth = 0; // $( 深度
	// 待收主体的 heredoc 队列：同行多个 <<A <<B 时主体在行后依次排列，逐个消费
	const pendingHeredocs: Array<{ delim: string; dash: boolean }> = [];
	let i = 0;
	const push = () => {
		out.push(cur);
		cur = "";
	};
	while (i < command.length) {
		const ch = command[i];
		if (quote) {
			// 单引号内无转义；双引号/反引号内反斜杠转义下一字符
			if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
				cur += ch + command[i + 1];
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			cur += ch;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			cur += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			cur += ch + command[i + 1];
			i += 2;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			parenDepth++;
			cur += "$(";
			i += 2;
			continue;
		}
		if (ch === ")" && parenDepth > 0) {
			parenDepth--;
			cur += ch;
			i++;
			continue;
		}
		if (parenDepth > 0) {
			cur += ch; // $(...) 内部不切段，内容递归处理
			i++;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<") {
			// heredoc 操作符：记录定界符，主体从下一行开始（<<< here-string 不匹配）
			const hd = parseHeredocOp(command, i);
			if (hd) {
				cur += hd.text;
				i += hd.text.length;
				pendingHeredocs.push({ delim: hd.delim, dash: hd.dash });
				continue;
			}
		}
		if (ch === "\n" || ch === ";") {
			if (ch === "\n" && pendingHeredocs.length > 0) {
				// 吞掉 heredoc 主体（含定界符行），不逐行切段
				const hd = pendingHeredocs.shift()!;
				const body = consumeHeredocBody(command, i, hd);
				cur += body.text;
				i = body.end;
				continue;
			}
			push();
			i++;
			continue;
		}
		if (ch === "&") {
			if (command[i + 1] === "&") {
				push();
				i += 2;
			} else {
				cur += ch; // 单个 &（后台运行/重定向）不切段
				i++;
			}
			continue;
		}
		if (ch === "|") {
			push(); // || 与 | 都切段
			i += command[i + 1] === "|" ? 2 : 1;
			continue;
		}
		cur += ch;
		i++;
	}
	push();
	return out;
}

/** 解析 heredoc 操作符：<<[-~] 可选 + 可选空白 + 定界符（可带单/双引号）。不匹配返回 null（含 <<< here-string） */
function parseHeredocOp(command: string, i: number): { text: string; delim: string; dash: boolean } | null {
	const m = /^<<([-~]?)\s*(["']?)([A-Za-z0-9_]+)\2/.exec(command.slice(i, i + 40));
	if (!m) return null;
	return { text: m[0], delim: m[3], dash: m[1].includes("-") };
}

/**
 * 吞掉 heredoc 主体：从命令行尾的换行符（nl）起，逐行扫描到定界符行（<<- 允许前导 Tab）。
 * 返回吞掉的文本与结束位置（定界符行末尾，不含其后换行）；未找到定界符行则吞到末尾
 * （AI 下发的脚本偶尔截断，整个余量按一段处理，不逐行拆）。
 */
function consumeHeredocBody(command: string, nl: number, hd: { delim: string; dash: boolean }): { text: string; end: number } {
	let pos = nl; // pos 始终指向行尾 '\n'
	while (pos < command.length) {
		const next = command.indexOf("\n", pos + 1);
		const lineEnd = next === -1 ? command.length : next;
		let line = command.slice(pos + 1, lineEnd);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		const cmp = hd.dash ? line.replace(/^\t+/, "") : line;
		if (cmp === hd.delim) return { text: command.slice(nl, lineEnd), end: lineEnd };
		if (next === -1) break;
		pos = next;
	}
	return { text: command.slice(nl), end: command.length };
}

/** 提取 $(...) 与 `...` 的内部文本（支持 $(...) 内嵌套括号一层以上的平衡扫描） */
function extractSubshellInners(segment: string): string[] {
	const inners: string[] = [];
	// $(...)：平衡括号扫描（引号简化处理：子 shell 内引号含括号属边角，宁多拆）
	for (let i = 0; i < segment.length; i++) {
		if (segment[i] === "$" && segment[i + 1] === "(") {
			let depth = 1;
			let j = i + 2;
			const start = j;
			while (j < segment.length && depth > 0) {
				if (segment[j] === "(") depth++;
				else if (segment[j] === ")") {
					depth--;
					if (depth === 0) break;
				}
				j++;
			}
			if (depth === 0) {
				inners.push(segment.slice(start, j));
				i = j;
			}
		}
	}
	// `...`：成对反引号
	for (const m of segment.matchAll(/`([^`]*)`/g)) inners.push(m[1]);
	return inners;
}
