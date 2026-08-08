/**
 * 通用 JSON 配置持久化（~/.pi/agent/ 下的扩展设置文件读写）
 *
 * 模式统一：load = 存在性检查 + JSON.parse + 类型校验，任一失败回退默认值；
 * save = 自动建目录 + 格式化写入。读写失败一律静默（配置损坏/写失败不阻塞扩展功能）。
 *
 * 使用方：btw（模型设置）、explore（子模型设置）、hud-cost（汇率缓存）等。
 * 伪编译时被 build.js 内联进各产物，运行时零依赖。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 读取 JSON 配置文件：缺失/损坏/校验不过时返回 fallback（不抛异常） */
export function loadJsonConfig<T>(file: string, fallback: T, validate: (v: unknown) => v is T): T {
	try {
		if (fs.existsSync(file)) {
			const d = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
			if (validate(d)) return d;
		}
	} catch {
		/* 文件损坏视为默认 */
	}
	return fallback;
}

/** 保存 JSON 配置（自动建目录、格式化、失败静默——仅本次会话生效，reload 后回默认） */
export function saveJsonConfig(file: string, value: unknown): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
	} catch {
		/* 写配置失败不影响本次运行 */
	}
}

/** 常见校验器：`{ model: string 非空 }` 结构（btw / explore 模型设置文件） */
export const isModelConfig = (v: unknown): v is { model: string } => {
	const m = (v as { model?: unknown } | null)?.model;
	return typeof m === "string" && m.trim().length > 0;
};
