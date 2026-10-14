/**
 * secret / refs.ts — 占位引用（ref）的语法、校验与展开
 *
 * 模型与转录里只见 {{sec:名字}}，真值只在执行前一刻进入子进程。ref 是整条链路唯一的
 * 交换格式，所以语法、名字校验、环境变量名与撞名检测都收在这一个文件里。
 *
 * 约定：
 *   - 名字限 [A-Za-z][A-Za-z0-9_.-]{0,63}；
 *   - bash 展开不写进 argv：ref 换成 "${PI_SEC_<规范化>}"，真值只在该次子进程的环境里；
 *   - 规范化后同名的两个名字（a.b 与 a-b 都成 A_B）必须拒绝执行，否则互相覆盖。
 */

/** 捕获组 1 是名字。作为字符串导出，供调用方自行拼正则（避免共享带 g 的 RegExp 状态）。 */
export const REF_RE_SOURCE = "\\{\\{sec:([A-Za-z][A-Za-z0-9_.-]{0,63})\\}\\}";
export const REF_PREFIX = "{{sec:";
export const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** 环境变量前缀：与 pi 自己的 PI_* 会话变量区分，一眼能认出是本扩展注入的。 */
export const ENV_PREFIX = "PI_SEC_";

/** 形态脱敏（认不出名字、只知道像凭证）时的兜底占位。 */
export const shapePlaceholder = (label: string): string => `«已隐藏:${label}»`;

export const refRegex = (): RegExp => new RegExp(REF_RE_SOURCE, "g");

export const refFor = (name: string): string => `${REF_PREFIX}${name}}}`;

export const isValidName = (name: string): boolean => NAME_RE.test(name);

/** 名字 → 子进程环境变量名。非字母数字一律折叠为下划线。 */
export const envVarName = (name: string): string =>
	ENV_PREFIX + name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();

/** bash 里的替换写法。自带双引号：裸用不被分词，已被双引号包裹时结果同样正确。 */
export const bashExpansion = (envName: string): string => `"\${${envName}}"`;

/**
 * 转义：`\{{sec:名字}}` 表示字面量——不校验、不展开，反斜杠由 bash 展开时去掉。
 * 没有它，任何提到 ref 语法的命令（grep、echo 文档、写测试）都会被「名字不在库里」拦下来。
 */
const ESCAPED_RE = /\\\{\{sec:[A-Za-z][A-Za-z0-9_.-]{0,63}\}\}/g;
/** 去掉转义反斜杠，得到该原样输出的文本。 */
export const unescapeRefs = (text: string): string => text.replace(ESCAPED_RE, (matched) => matched.slice(1));

/** 文本里出现的 ref 名字，按首次出现顺序去重。转义的引用不计入。 */
export function refsIn(text: string): string[] {
	const out: string[] = [];
	// 先把转义的形式抹掉（换成不可能出现在名字里的字节），免得它们被当成真正的引用。
	for (const m of text.replace(ESCAPED_RE, "\u0000").matchAll(refRegex())) {
		if (!out.includes(m[1])) out.push(m[1]);
	}
	return out;
}

/** 规范化后撞名的名字组（每组 ≥2 个）。非空即表示这批 ref 不能同批展开。 */
export function envCollisions(names: string[]): string[][] {
	const byEnv = new Map<string, string[]>();
	for (const name of names) {
		const key = envVarName(name);
		byEnv.set(key, [...(byEnv.get(key) ?? []), name]);
	}
	return [...byEnv.values()].filter((group) => group.length > 1);
}

export interface ExpandResult {
	text: string;
	/** 实际展开过的名字。 */
	used: string[];
	/** 库里没有的名字，原样留在文本里。 */
	missing: string[];
}
export interface BashExpandResult {
	command: string;
	/** 只属于本次调用的环境变量；调用方自行与 spawn 的 env 合并。 */
	env: Record<string, string>;
	used: string[];
}

/**
 * bash 命令的展开：ref 换成 "${PI_SEC_*}"，真值只进环境变量、不进 argv。
 * 展开后命令行里没有明文，所以进程列表、`ps`、崩溃日志里都不会出现密钥。
 * 转义的引用（`\{{sec:名字}}`）只去掉反斜杠，当字面量交给 shell。
 */
export function expandForBash(command: string, lookup: (name: string) => string | undefined): BashExpandResult {
	const env: Record<string, string> = {};
	const used: string[] = [];
	let out = command;
	for (const name of refsIn(command)) {
		const value = lookup(name);
		if (value === undefined) continue;
		const envName = envVarName(name);
		env[envName] = value;
		out = out.split(refFor(name)).join(bashExpansion(envName));
		used.push(name);
	}
	return { command: unescapeRefs(out), env, used };
}

/** 把文本里的 ref 换成真值（非 bash 的工具参数走这里；bash 走 expandForBash）。 */
export function expandRefs(text: string, resolve: (name: string) => string | undefined): ExpandResult {
	const used: string[] = [];
	const missing: string[] = [];
	const out = text.replace(refRegex(), (raw: string, name: string) => {
		const value = resolve(name);
		if (value === undefined) {
			if (!missing.includes(name)) missing.push(name);
			return raw;
		}
		if (!used.includes(name)) used.push(name);
		return value;
	});
	return { text: out, used, missing };
}
