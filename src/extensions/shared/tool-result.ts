/**
 * shared/tool-result：工具结果构造与失败语义（所有扩展的工具共用）
 *
 * 失败一律以 **`isError: true` 的结果**返回，不用 throw 传递：pi 只在扩展返回 isError 时原样透传
 * content/details；而 execute 抛异常会被 pi 包成 `Error: <message>`（无 details、无自定义渲染）。
 * throw 只留给编程错误（真 bug 应当冒泡）。
 *
 * 用法（各扩展的结果 helper 收敛到这里，不再各写一份）：
 *   const text = toolText;            // 成功结果
 *   return err("笔记不存在：…");       // 失败结果（isError）
 *   return toolError("…", { error }); // 失败 + 结构化 details
 */
export interface ToolTextResult {
	content: { type: "text"; text: string }[];
	details: unknown;
	isError?: true;
}

/** 成功结果 */
export function toolText(text: string, details: Record<string, unknown> = {}): ToolTextResult {
	return { content: [{ type: "text", text }], details };
}

/** 失败结果（模型与 UI 都会识别为失败） */
export function toolError(text: string, details: Record<string, unknown> = {}): ToolTextResult {
	return { content: [{ type: "text", text }], details, isError: true };
}

/** 任意异常 → 人话消息（工具失败文案里统一用它，避免 `String(e)` 满天飞） */
export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
