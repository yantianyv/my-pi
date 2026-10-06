/**
 * 上下文文件的发现与结构检查（纯 fs，不依赖 pi 运行时）
 *
 * 从 context-init 抽出：这两件事只跟磁盘上的文件有关，与模型、插件上下文无关，
 * 放 shared 后可被回归测试直接加载（不需要 test/node_modules 的 pi 包链接）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 唯一的上下文文件名（pi 原生读取；CLAUDE.md 只会被归并，不会被生成） */
export const CONTEXT_FILE = "AGENTS.md";

/**
 * 找出项目里的上下文文件（根 + 子目录的 AGENTS.md / CLAUDE.md，跳过依赖/构建/隐藏目录）。
 * 新规范下一个项目只应有一份（根），子目录里的属于待迁移对象——/init 需要看得见它们。
 */
export function findContextFiles(cwd: string, limit = 25): string[] {
	const names = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.MD"]);
	const skip = new Set(["node_modules", ".git", "dist", ".tmp", "vendor"]);
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 6 || found.length >= limit) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (found.length >= limit) return;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (skip.has(e.name) || e.name.startsWith(".")) continue;
				walk(p, depth + 1);
			} else if (names.has(e.name)) {
				found.push(p);
			}
		}
	};
	const rootFile = path.join(cwd, CONTEXT_FILE);
	if (fs.existsSync(rootFile)) found.push(rootFile);
	walk(cwd, 1);
	return [...new Set(found)];
}

/**
 * 产物的确定性结构检查（不依赖模型）：上下文文件指针可解析、SKILL.md 索引与 references
 * 一一对应、frontmatter 有 name/description、不留空文件。返回人话问题清单（空 = 通过）。
 */
export function checkContextArtifacts(cwd: string): string[] {
	const issues: string[] = [];
	const skillRoot = path.join(cwd, ".pi", "skills");
	const skills = fs.existsSync(skillRoot)
		? fs.readdirSync(skillRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
		: [];
	const allRefs = new Set<string>();
	for (const s of skills) {
		const dir = path.join(skillRoot, s.name);
		const skillFile = path.join(dir, "SKILL.md");
		if (!fs.existsSync(skillFile)) {
			issues.push(`skill ${s.name}：缺 SKILL.md`);
			continue;
		}
		const skillText = fs.readFileSync(skillFile, "utf8");
		const fm = skillText.match(/^---\n([\s\S]*?)\n---/);
		if (!fm || !/^name:\s*\S/m.test(fm[1]) || !/^description:\s*\S/m.test(fm[1])) {
			issues.push(`skill ${s.name}：frontmatter 缺 name 或 description`);
		}
		const refDir = path.join(dir, "references");
		const files = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter((f) => f.endsWith(".md")) : [];
		for (const f of files) {
			allRefs.add(f);
			if (fs.statSync(path.join(refDir, f)).size < 80) issues.push(`skill ${s.name}：references/${f} 近乎空文件`);
			if (!skillText.includes(f)) issues.push(`skill ${s.name}：references/${f} 未写进 SKILL.md 索引`);
		}
		for (const m of skillText.matchAll(/references\/([\w.-]+\.md)/g)) {
			if (!files.includes(m[1])) issues.push(`skill ${s.name}：SKILL.md 指向不存在的 references/${m[1]}`);
		}
	}
	for (const file of findContextFiles(cwd)) {
		const rel = path.relative(cwd, file) || file;
		const text = fs.readFileSync(file, "utf8");
		for (const m of text.matchAll(/references\/([\w.-]+\.md)/g)) {
			if (!allRefs.has(m[1])) issues.push(`${rel} 指向不存在的 references/${m[1]}`);
		}
	}
	return issues;
}
