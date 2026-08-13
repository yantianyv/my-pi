/**
 * btw: Claude Code 风格 /btw 临时旁支问答（入口薄壳：注册 /btw 与 /btw-config 命令、
 * m 转正 input 钩子、session_shutdown 清理；核心逻辑在 config.ts / messages.ts /
 * render.ts / overlay.ts / run.ts）
 *
 * - /btw <问题>：在主任务进行中打开右侧浮层，做临时问答（by the way）
 * - 面板内可多轮追问（Enter 输入，最多 BTW_MAX_THREAD_TURNS 轮），
 *   上下文 = 主会话 + 面板内历次问答，仍独立于主会话、零污染
 * - m 一键转正：把全部 Q/A 打包，随下一条消息附带发送（不立即发出，界面提示已附带）
 * - 携带当前会话上下文（buildSessionContext，含压缩结果），能回答与当前
 *   任务相关的问题（如「刚才为什么选这个方案」「改了哪些文件」）
 * - /btw-config：配置 btw 使用的模型；默认 auto = 已认证可用模型中最便宜的，
 *   按价格顺序故障转移（便宜模型调用失败自动换下一个更贵的重试，全失败才报错）；
 *   另有 auto-not-free（忽略价格 ≤ 0 的免费模型）与任意 provider/modelId 可选，
 *   交互选择里支持关键词搜索模型；设置持久化到 ~/.pi/agent/btw-config.json，
 *   /reload 重载扩展后保留
 * - 始终携带只读工具（read / ls / grep / find，无 bash）：问「xx 函数在哪
 *   定义」「这个配置是干嘛的」类问题可直接查证代码，只读不写
 * - 流式显示回答；Esc 关闭并中止请求；↑↓ 滚动查看完整回答
 *
 * 实现要点：
 * - 认证走 ctx.modelRegistry.getApiKeyAndHeaders()（与 init 子代理同一条链）；
 * - 消息序列全量降级清洗：toolResult 降级为 user、剥离 tool_use/thinking 块、
 *   合并连续同角色、保证以 user 结尾——兼容 OpenAI（role 'tool' 配对校验）与
 *   Anthropic（tool_result 紧跟 assistant tool_use）两类端点，截断也安全；
 * - 问答跑 pi-agent-core 官方 agentLoop（与 init 子代理同构）：每轮 LLM 调用
 *   经 streamFn 包装转发 text_delta 到面板实现流式；工具轮次的状态
 *   （tool_execution_start/end）在面板状态行显示当前工具；
 * - 浮层用 ctx.ui.custom + overlay 模式，组件持有 tui 引用，delta 时 requestRender。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import {
	formatContextWindow,
	formatModelPrice,
	findConfiguredModel,
	listAvailableModels,
	ModelSelectItem,
	ModelSelectOverlay,
} from "../shared/model-select";
import {
	resolveBtwModel,
	btwModelSetting,
	setBtwModelSetting,
	btwSettingLabel,
	BTW_TIMEOUT_MS,
	BTW_OVERLAY_WIDTH,
	BTW_OVERLAY_MIN_WIDTH,
	BTW_OVERLAY_MAX_HEIGHT,
	BTW_MAX_THREAD_TURNS,
} from "./config";
import { BtwOverlay } from "./overlay";
import { runBtwTurn } from "./run";

export default function (pi: ExtensionAPI) {
	// 同时只允许一个 btw 面板
	let activeBtw: { abort: () => void } | null = null;

	// ---- m 转正：暂存待附带的问答，等用户下一条交互消息随附发送 ----
	// 按 m 不立即 sendUserMessage，而是记入 pendingTransfer；用户在 input 事件提交
	// 下一条消息时（source === "interactive"）通过 transform 把问答拼到消息末尾，
	// 输入框里用户只看到自己的文本 + "📎 已附带"提示，不出现原始问答内容。
	let pendingTransfer: string | null = null;

	pi.on("input", async (event, ctx) => {
		if (pendingTransfer && event.source === "interactive") {
			const attach = pendingTransfer;
			pendingTransfer = null;
			ctx.ui.setStatus("btw-transfer", undefined); // 提示随发送消失（hud 行 1 / 原生 footer 第 3 行）
			return { action: "transform", text: `${event.text}\n\n---\n\n${attach}` };
		}
		return { action: "continue" };
	});

	pi.registerCommand("btw", {
		description: "临时旁支问答（by the way）：侧栏问答，不写入会话历史；Enter 追问、m 转正",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw 需要交互模式", "error");
				return;
			}
			const firstQuestion = args?.trim();
			if (!firstQuestion) {
				ctx.ui.notify("用法：/btw <问题>", "warning");
				return;
			}
			const plan = resolveBtwModel(ctx);
			if (!plan.model) {
				ctx.ui.notify("没有可用的已认证模型，无法启动 btw（请先配置 provider 认证）", "error");
				return;
			}
			const autoHint =
				btwModelSetting === "auto-not-free"
					? "（auto-not-free，最便宜非免费模型，按价格顺序故障转移）"
					: "（auto，最便宜可用，按价格顺序故障转移）";
			ctx.ui.notify(`btw 使用模型：${plan.model.provider}/${plan.model.id}${plan.mode === "auto" ? autoHint : ""}`, "info");
			if (activeBtw) {
				ctx.ui.notify("已有 btw 面板打开，先按 Esc 关闭再提问", "warning");
				return;
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new Error("btw 超时")), BTW_TIMEOUT_MS);
			activeBtw = { abort: () => controller.abort() };

			// btw 面板内对话线程（user/assistant 交替，不写主会话）
			const thread: Message[] = [];
			let overlayRef: BtwOverlay | null = null;
			let closePanel: (() => void) | null = null;

			/** 发起一轮问答（首问与追问共用） */
			const ask = (question: string) => {
				if (controller.signal.aborted) return;
				// 每次提问重新解析：auto 实时选当前最便宜模型；固定模型失效自动回退 auto
				const p = resolveBtwModel(ctx);
				if (!p.model) {
					overlayRef?.fail("没有可用的已认证模型");
					return;
				}
				overlayRef?.setModel(`${p.model.provider}/${p.model.id}`); // 标题栏显示实际使用模型
				overlayRef?.startQuestion(question);
				void runBtwTurn(ctx, p.model, thread, question, controller.signal, overlayRef!, (answer) => {
					thread.push({ role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() } as Message);
					thread.push({ role: "assistant", content: [{ type: "text", text: answer }], timestamp: Date.now() } as Message);
					// 控制面板线程长度：超过上限丢弃最早轮次
					if (thread.length > BTW_MAX_THREAD_TURNS * 2) {
						thread.splice(0, thread.length - BTW_MAX_THREAD_TURNS * 2);
					}
					overlayRef?.commit();
				}, p.failover);
			};

			/** m 转正：把 btw 问答打包，随下一条消息附带发送（不立即发出），然后关闭面板 */
			const transfer = () => {
				if (controller.signal.aborted) return;
				const transcript = overlayRef?.getTranscript() ?? "";
				if (!transcript) return;
				pendingTransfer =
					`[btw 转交] 以下是我在侧栏用 /btw 的临时问答（未写入本会话历史），` +
					`其中值得继续跟进，请基于此继续处理：\n\n${transcript}\n\n` +
					`（直接按内容继续即可，无需回应此来源标记本身）`;
				// 常驻提示直到随附发送（hud 开着显示在行 1 动态区，关着回落原生 footer 第 3 行）
				ctx.ui.setStatus("btw-transfer", "📎 已附带 btw 问答");
				ctx.ui.notify("📎 已附带 btw 问答，下一条消息将随附发送", "info");
				closePanel?.();
			};

			try {
				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						closePanel = () => done();
						const overlay = new BtwOverlay(tui, theme, ask, transfer, done);
						overlayRef = overlay;
						ask(firstQuestion);
						return overlay;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "right-center",
							width: BTW_OVERLAY_WIDTH,
							minWidth: BTW_OVERLAY_MIN_WIDTH,
							maxHeight: BTW_OVERLAY_MAX_HEIGHT,
							margin: { right: 1 },
						},
					},
				);
			} finally {
				clearTimeout(timer);
				activeBtw = null;
				// 面板关闭（Esc/转正/超时/会话切换）后中止仍在跑的流式请求
				controller.abort();
			}
		},
	});

	// ---- /btw-config：配置 btw 问答使用的模型 ----
	pi.registerCommand("btw-config", {
		description: "配置 btw 使用的模型：auto（默认，最便宜可用模型）、auto-not-free（忽略免费模型）或 provider/modelId；不带参数进入交互选择（含搜索）",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";

			// 带参数：直接设置
			if (arg) {
				if (arg === "auto" || arg === "auto-not-free") {
					setBtwModelSetting(arg);
					ctx.ui.notify(`btw 模型已设为 ${arg}（${btwSettingLabel(arg)}）`, "info");
					return;
				}
				const m = findConfiguredModel(ctx, arg);
				if (m) {
					setBtwModelSetting(`${m.provider}/${m.id}`);
					ctx.ui.notify(`btw 模型已设为 ${btwModelSetting}`, "info");
					return;
				}
				// 未命中：子串匹配到多个时列出部分候选，没有时给用法提示
				const matches = listAvailableModels(ctx).filter((x) =>
					`${x.provider}/${x.id}`.toLowerCase().includes(arg.toLowerCase()),
				);
				ctx.ui.notify(
					matches.length > 0
						? `「${arg}」匹配 ${matches.length} 个模型（${matches
								.slice(0, 3)
								.map((x) => `${x.provider}/${x.id}`)
								.join("、")}${matches.length > 3 ? " 等" : ""}），请用完整 provider/modelId 指定`
						: `未找到「${arg}」。用法：/btw-config auto、auto-not-free 或 /btw-config provider/modelId`,
					"warning",
				);
				return;
			}

			// 无参数：打开可搜索模型选择器（非交互模式只展示当前设置与用法）
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`当前 btw 模型：${btwModelSetting}。用法：/btw-config auto、auto-not-free 或 /btw-config provider/modelId`,
					"info",
				);
				return;
			}
			// 列表 = 两个 auto 策略 + 全部已认证可用模型（价格升序）；顶部搜索框实时过滤
			const models = listAvailableModels(ctx);
			const items: ModelSelectItem[] = [
				{
					label: "auto（默认）：最便宜可用模型，按价格顺序故障转移",
					value: "auto",
					search: "auto 默认",
				},
				{
					label: "auto-not-free：忽略免费模型，最便宜的非免费模型按价格顺序故障转移",
					value: "auto-not-free",
					search: "auto-not-free 忽略免费",
				},
				...models.map((m) => ({
					label: `${m.provider}/${m.id}（${formatModelPrice(m)} · ctx ${formatContextWindow(m.contextWindow)}）`,
					value: `${m.provider}/${m.id}`,
					search: `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase(),
				})),
			];
			const result = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => new ModelSelectOverlay(tui, theme, items, btwModelSetting, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "58%",
						minWidth: 58,
						maxHeight: "90%",
						margin: { right: 1 },
					},
				},
			);
			if (result) {
				setBtwModelSetting(result);
				ctx.ui.notify(`btw 模型已设为 ${result}（${btwSettingLabel(result)}）`, "info");
			}
		},
	});

	// 会话切换/关闭时中止后台流、清掉未发送的转交内容
	pi.on("session_shutdown", async () => {
		activeBtw?.abort();
		activeBtw = null;
		pendingTransfer = null;
	});
}
