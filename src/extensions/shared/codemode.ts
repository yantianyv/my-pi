/**
 * shared/codemode：判断工具调用是否来自 codemode 脚本
 *
 * 脚本调用工具走的是同一条工具管线（参数校验、tool_call 钩子、权限校验全一样），
 * 唯一区别在调用 id：pi 给嵌套调用分配 `<父调用 id>/<序号>`，模型直接调用则是单段 id。
 * 需要人工交互（问卷、审核面板、输密码）的工具在脚本里会同步阻塞，等待时间计入脚本
 * timeout_ms，超时后模型重试还会造成多次调用堆积；这类分支先用本判定拒绝，引导改为
 * 直接调用。
 */
export function isCodemodeCall(toolCallId: string | undefined): boolean {
	if (typeof toolCallId !== "string") return false;
	const i = toolCallId.lastIndexOf("/");
	return i > 0 && i < toolCallId.length - 1;
}
