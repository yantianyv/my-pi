/**
 * skill-hub/frontmatter：SKILL.md 头部的轻量解析与校验（纯函数）
 *
 * 只认规范里的关键字段：name / description / disable-model-invocation。
 * 不引第三方 YAML 解析器——技能头部是简单键值，多行 description 用引号或续行即可；
 * 解析不了的写法按「没写」处理，由校验给出人话提示（技能本体仍会被 pi 拒载，装了也没用）。
 *
 * 校验口径对齐 pi 的 `core/skills.js`：它只把缺 description 当拒载，名字与超长描述都是 warning。
 */

export interface SkillMeta {
	name?: string;
	description?: string;
	disableModelInvocation?: boolean;
}

/** 取 `---` 包围的头部：没有头部时返回 null（pi 允许无头部？不允许：无 description 会被拒载） */
function headBlock(text: string): string | null {
	const norm = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!norm.startsWith("---")) return null;
	const end = norm.indexOf("\n---", 3);
	if (end < 0) return null;
	return norm.slice(4, end);
}

/** 去掉包裹的引号（含折行续写的引号块） */
function unquote(v: string): string {
	const t = v.trim();
	if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
		return t.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
	}
	return t;
}

/** 解析 SKILL.md 头部（未闭合/无头部返回空对象） */
export function parseSkillMeta(text: string): SkillMeta {
	const block = headBlock(text);
	if (block === null) return {};
	const out: SkillMeta = {};
	for (const rawLine of block.split("\n")) {
		const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(rawLine);
		if (!m) continue; // 续行、注释、嵌套结构一律忽略
		const key = m[1]!;
		const value = unquote(m[2]!);
		if (key === "name" && value) out.name = value;
		else if (key === "description" && value) out.description = value;
		else if (key === "disable-model-invocation") out.disableModelInvocation = /^true$/i.test(value);
	}
	return out;
}

/** 校验结果：blockers = pi 真的会拒载的（缺 description）；warnings = pi 只报警但仍加载的规范偏差 */
export interface SkillCheck {
	blockers: string[];
	warnings: string[];
}

/**
 * 按 pi 的实际口径校验（`core/skills.js` 的 validateName / validateDescription）：
 * 名字不合规、description 超长都只是 warning，pi 照常加载；只有 description 缺失/为空才会拒载。
 */
export function checkSkill(name: string, meta: SkillMeta): SkillCheck {
	const blockers: string[] = [];
	const warnings: string[] = [];
	if (!meta.description) blockers.push("SKILL.md 头部缺少 description，pi 不会加载它");
	if (!/^[a-z0-9-]+$/.test(name) || name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
		warnings.push(`技能名 ${name} 不完全合规（规范要求小写字母、数字与连字符，首尾与连续处不能是连字符），pi 会报警告但照常加载`);
	}
	if (name.length > 64) warnings.push(`技能名超过 64 字符，pi 会报警告但照常加载`);
	if (meta.description && meta.description.length > 1024) {
		warnings.push(`description 超过 1024 字符（当前 ${meta.description.length}），pi 会报警告但照常加载`);
	}
	if (meta.name && meta.name !== name) {
		warnings.push(`声明名 ${meta.name} 与目录名 ${name} 不一致，跨工具安装时可能被判不合法`);
	}
	return { blockers, warnings };
}
