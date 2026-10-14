/**
 * secret / bash.ts — 接管 bash 工具，让 ref 在不进 argv 的前提下展开
 *
 * 为什么必须替换 bash 工具，而不是在 tool_call 里改写参数：真值要经**环境变量**交给子进程，
 * 而最终 env 只有 spawn 那一刻才定得下来，钩子拿不到。pi 自带的 createBashToolDefinition 正好
 * 暴露了 spawnHook，而且它看到的是**未被改写**的原始命令（tool_call 只校验、不改），所以
 * 「转录留 ref、执行用真值」这两件事可以同时成立。
 *
 * 三件事：
 *   1. spawnHook —— ref 换成 "${PI_SEC_*}"，真值放进本次调用的 env；process.env 不碰，
 *      并发命令看不到彼此的值；
 *   2. 包装 execute —— bash 边跑边把输出渲染出去（tool_execution_update），tool_result 只在
 *      结束时才触发，所以流式帧也要洗；
 *   3. 截断快照 —— 输出超限时 pi 把**未脱敏**的全文写进临时文件、只把路径给模型，下一轮模型
 *      read 它就漏了；必须就地重写这份文件。
 */
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { maskText, type MaskOptions } from "./engine";
import { expandForBash } from "./refs";
import type { Vault } from "./vault";

/** 超过这个大小的快照不整读（读进内存再写回代价过高），清空并留话。 */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

type BashDef = ReturnType<typeof createBashToolDefinition>;
type BashExec = BashDef["execute"];

export interface SecretBashOptions {
	vault: () => Vault;
	enabled: () => boolean;
	/** 出口脱敏选项（是否认形态、是否自动收录），与其它出口一致。 */
	mask: () => MaskOptions;
}

/** 洗一个流式帧：只动文本块。 */
function scrubPartial(partial: unknown, options: SecretBashOptions): unknown {
	if (!partial || typeof partial !== "object") return partial;
	const record = partial as { content?: unknown };
	if (!Array.isArray(record.content)) return partial;
	const content = record.content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const text = (block as { type?: unknown; text?: unknown }).type === "text" ? (block as { text?: unknown }).text : undefined;
		if (typeof text !== "string") return block;
		return { ...(block as Record<string, unknown>), text: maskText(text, options.vault(), options.mask()).text };
	});
	return { ...(partial as Record<string, unknown>), content };
}

/** 就地重写 pi 落下的截断快照（它是未脱敏的全文，模型会拿到它的路径）。 */
function scrubSnapshot(result: unknown, options: SecretBashOptions): void {
	const details = (result as { details?: unknown } | null)?.details as { fullOutputPath?: unknown } | undefined;
	const path = details?.fullOutputPath;
	if (typeof path !== "string" || path.length === 0) return;
	try {
		const size = fs.statSync(path).size;
		if (size > MAX_SNAPSHOT_BYTES) {
			fs.writeFileSync(path, `[输出超过 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)}MB，已清空以避免未脱敏内容外流]\n`, "utf8");
			return;
		}
		const raw = fs.readFileSync(path, "utf8");
		const masked = maskText(raw, options.vault(), options.mask());
		if (masked.text !== raw) fs.writeFileSync(path, masked.text, "utf8");
	} catch {
		// 文件已被清理 / 不可写：出口那几道网仍会兜住，不为此中断工具调用。
	}
}

export function createSecretBashDefinition(cwd: string, options: SecretBashOptions): BashDef {
	const base = createBashToolDefinition(cwd, {
		spawnHook: (context) => {
			if (!options.enabled()) return context;
			// 名字不存在与撞名都在 tool_call 里拦掉了；这里只兜底，不改写、让 shell 原样报错。
			const expanded = expandForBash(context.command, (name) => options.vault().get(name));
			if (expanded.used.length === 0) return context;
			return { ...context, command: expanded.command, env: { ...context.env, ...expanded.env } };
		},
	});

	const run = base.execute.bind(base);
	const execute: BashExec = async (toolCallId, params, signal, onUpdate, ctx) => {
		const scrub = typeof onUpdate === "function" ? (partial: unknown) => onUpdate(scrubPartial(partial, options) as never) : undefined;
		const result = await run(toolCallId, params, signal, scrub, ctx);
		scrubSnapshot(result, options);
		return result;
	};

	return { ...base, execute };
}

export function registerSecretBash(pi: ExtensionAPI, cwd: string, options: SecretBashOptions): void {
	pi.registerTool(createSecretBashDefinition(cwd, options));
}

/**
 * 注册是否真的生效。扩展之间「同名工具先注册者胜」，被别的扩展抢先时 pi 不报错，
 * 结果是 ref 原样进 shell —— 静默失败，所以要在 session_start 显式查一次。
 */
export function bashIsOurs(pi: ExtensionAPI): boolean {
	const effective = pi.getAllTools().find((tool) => tool.name === "bash");
	if (!effective) return false;
	const realpath = (p: string): string => {
		try {
			return fs.realpathSync(p);
		} catch {
			return p;
		}
	};
	return realpath(effective.sourceInfo.path) === realpath(fileURLToPath(import.meta.url));
}
