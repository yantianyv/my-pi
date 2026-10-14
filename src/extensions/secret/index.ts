/**
 * secret — 让模型用得上密钥，但永远看不到它
 *
 * 模型与转录里只有 {{sec:名字}}；真值只在两处出现：掩码录入的那一瞬（浮层内存 → 库），
 * 与执行前一刻（库 → 子进程环境）。库是会话级内存，不落盘、不进会话文件、不写临时文件。
 *
 * 入口两道：
 *   input 钩子 —— 粘进对话的凭证在**落盘之前**换成 ref；
 *   tool_call  —— 参数里的 ref 展开成真值；bash 例外，它走 spawnHook 的按次环境变量
 *                 （真值不进 argv，process.env 也不碰，见 bash.ts）。
 *
 * 出口四道网（越靠后越贴近真正离开机器的字节）：
 *   tool_result            主保证：结果消息落盘与进上下文之前就洗过；
 *   bash 的流式帧与快照     pi 边跑边渲染，且截断时会把未脱敏全文写进临时文件只给模型路径；
 *   context                 每次请求前洗全量消息（粘贴、别的扩展注入的内容都在这兜住）；
 *   before_provider_request 真正离开机器的请求体（provider 相关，靠 turn_end 探测是否存在）。
 *
 * 长期指纹表（fingerprint.ts）是这四道网的补充：会话结束后值就没了，但指纹还在，所以同一个
 * 口令下次再出现时仍能被认出来遮住——只能遮，不能拿来执行（没有值）。
 *
 * 交互面只有 `/secret` 一个命令：面板里管条目、指纹表、设置与帮助；`on/off/list` 只是给无
 * 界面场景留的旁路。
 */

import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";
import { REVIEW_REMEMBER, askReview, reviewActions } from "../shared/review-panel";
import { setWaiting } from "../shared/status";
import { toolError, toolText } from "../shared/tool-result";
import { bashIsOurs, registerSecretBash } from "./bash";
import { highEntropySpans, scout, type Finding } from "./detect";
import { adoptCandidate, expandDeep, maskDeep, type MaskOptions } from "./engine";
import { FingerprintTable } from "./fingerprint";
import { envCollisions, isValidName, refFor, refsIn, shapePlaceholder } from "./refs";
import { dropVault, vaultFor, type EntryKind, type PublicEntry } from "./vault";
import { openSecretPanel, promptLine, type PanelDeps, type PanelSettings } from "./ui";

// ---------------------------------------------------------------------------
// 可调配置
// ---------------------------------------------------------------------------

/** pi 的 agent 配置目录；SECRET_CONFIG_DIR 供测试隔离（同 webdav-kb 的 KB_CONFIG_DIR），每次现读。 */
const configDir = (): string => process.env.SECRET_CONFIG_DIR ?? path.join(os.homedir(), ".pi", "agent");
const configFile = (): string => path.join(configDir(), "secret-config.json");
const STATUS_KEY = "secret";

/** 这些工具的参数里 ref 没有意义（搜文件路径），留原样避免无谓替换。 */
const NO_EXPAND_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);

/** 只有 bash 支持按次环境变量注入；别的 shell 工具拿到 ref 只会原样交给 shell。 */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** 提示词里给模型的用法说明。只写模型需要且别处没有的信息。 */
const USAGE_NOTE = [
	"本会话启用了 secret：需要密钥/凭证时不要向用户索要明文。",
	"- secret_list 列出本会话已录入的名字（不含值）；secret_prompt 可以请用户掩码录入一个（值只进用户的库，调用方只拿到名字）；",
	"- 在 bash 命令或工具参数里写 {{sec:名字}}，值在执行前一刻注入，转录里只留这个名字；",
	"- 同一个名字可以在多条命令里重复使用，命令的输出里也会以这个名字出现；",
	"- 名字不在库里时：bash 会被拦下并告知，其它工具则原样保留这段文字（写文档提到 ref 语法时不必特意避开）。",
].join("\n");

interface SecretConfig extends PanelSettings {
	enabled: boolean;
}

const DEFAULT_CONFIG: SecretConfig = {
	enabled: true,
	/** session = 每个名字在本次会话内首次使用时问一次；never = 不问（只靠 perm-gate 与人工把关）。 */
	confirm: "session",
	redactShapes: true,
	captureOnPaste: true,
	/** 粘贴时对孤立高熵串弹一次「这像密钥」确认。 */
	guessConfirm: true,
	fingerprints: true,
};

function readConfig(): SecretConfig {
	const raw = loadJsonConfig<Record<string, unknown>>(
		configFile(),
		{},
		(v): v is Record<string, unknown> => typeof v === "object" && v !== null,
	);
	const bool = (key: keyof SecretConfig, fallback: boolean): boolean =>
		typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback;
	return {
		enabled: bool("enabled", DEFAULT_CONFIG.enabled),
		confirm: raw.confirm === "never" ? "never" : DEFAULT_CONFIG.confirm,
		redactShapes: bool("redactShapes", DEFAULT_CONFIG.redactShapes),
		captureOnPaste: bool("captureOnPaste", DEFAULT_CONFIG.captureOnPaste),
		guessConfirm: bool("guessConfirm", DEFAULT_CONFIG.guessConfirm),
		fingerprints: bool("fingerprints", DEFAULT_CONFIG.fingerprints),
	};
}

/** 面板一行设置里能看到的那部分（总开关单独走 enabled，不混进来）。 */
const settingsOf = (config: SecretConfig): PanelSettings => ({
	confirm: config.confirm,
	redactShapes: config.redactShapes,
	captureOnPaste: config.captureOnPaste,
	guessConfirm: config.guessConfirm,
	fingerprints: config.fingerprints,
});

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let config = readConfig();
	let scope = "default";
	/** 本次会话已经确认过的名字（confirm=session 时用）。 */
	const confirmed = new Set<string>();
	let fingerprints: FingerprintTable | null = null;
	let providerHookFired = false;
	let providerHookWarned = false;
	/** 本次会话已确认「不是密钥」的高熵串指纹，不再重复问。 */
	const declined = new Set<string>();
	/** 参数里出现「名字不在库」的工具调用，结果里补一句提醒（否则是静默失改）。 */
	const missingRefs = new Map<string, string[]>();

	const vault = () => vaultFor(scope);

	/** 把值记进长期指纹表（值够长才写；表没开就跳过）。 */
	const remember = (name: string, value: string, kind: EntryKind, label?: string): boolean => {
		if (!config.fingerprints || !fingerprints) return false;
		return fingerprints.remember({ name, value, kind, label });
	};

	/** 收一个自动发现的凭证进库并记指纹，返回名字。 */
	const adopt = (candidate: { value: string; label: string }, source: "paste" | "output"): string => {
		const name = adoptCandidate(vault(), candidate, source);
		remember(name, candidate.value, "secret", candidate.label);
		return name;
	};

	const maskOptions = (): MaskOptions => ({
		shapes: config.redactShapes,
		// 最后一道：本会话没有值、但长期表里有的旧口令，在这里被认出来遮住。
		post: config.fingerprints && fingerprints ? (text: string) => fingerprints!.scan(text) : undefined,
	});

	const pushStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const size = vault().size;
		ctx.ui.setStatus(STATUS_KEY, config.enabled && size > 0 ? `🔐 secret ${size} 条` : undefined);
	};

	/** ref 在给人看的面板里换成「名字的值」，值本身永不显示。 */
	const forDisplay = (text: string): string =>
		text.replace(/\{\{sec:([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}/g, (_raw, name: string) => `«${name} 的值»`);

	/** 会话内首次使用某个名字时问一次。拒绝即阻断工具调用。 */
	async function confirmUse(ctx: ExtensionContext, names: string[], display: string): Promise<boolean> {
		const pending = names.filter((name) => !confirmed.has(name));
		if (config.confirm === "never" || pending.length === 0 || !ctx.hasUI) return true;
		const outcome = await askReview(ctx, {
			title: "密钥使用确认",
			verb: "使用",
			object: `密钥：${pending.map((name) => refFor(name)).join("、")}`,
			content: forDisplay(display).split("\n"),
			impact: ["值只注入本次执行，不进上下文、不写盘", "命令本身仍走 perm-gate 的审核链"],
			actions: reviewActions(true),
			rememberNote: "本次会话内这几个名字不再询问",
		});
		if (outcome.kind === "rejected" || outcome.kind === "no-ui") return false;
		if (outcome.kind === "remembered") for (const name of pending) confirmed.add(name);
		return true;
	}

	/** 值指纹（只用于话术与去重，不落盘）。 */
	const fingerprintOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);

	/** 值是否已经在库里或长期指纹表里（已处理的就不再问）。 */
	const alreadyKnown = (value: string): boolean => {
		if (vault().list().some((entry) => entry.value === value)) return true;
		return fingerprints ? fingerprints.scan(value).hits > 0 : false;
	};

	/**
	 * 粘贴时的「这像密钥」确认。
	 *
	 * 形态与关键词都认不出的裸口令只能在这里被捕获；代价是多问一句，所以只在三个限定下弹：
	 * 有界面、消息短、高熵串不超过两个。答「不是」就记住，同一个值不再问第二次。
	 */
	async function confirmGuesses(ctx: ExtensionContext, text: string): Promise<string> {
		if (!config.guessConfirm || !ctx.hasUI) return text;
		const spans = highEntropySpans(text).filter((value) => !alreadyKnown(value) && !declined.has(fingerprintOf(value)));
		if (spans.length === 0 || spans.length > 2 || text.length > 400) return text;
		let out = text;
		for (const span of spans) {
			const preview = span.length >= 20 ? `${span.slice(0, 3)}…${span.slice(-3)}` : span;
			const yes = await ctx.ui.confirm(
				"这看起来像密钥",
				`${preview}\n\n长度 ${span.length} · 指纹 ${fingerprintOf(span)}\n\n确认是密钥：收进本会话，可在命令里用 ref 引用，值不会进入对话。\n不是密钥：本次会话不再问它，原样留在消息里。`,
			);
			if (!yes) {
				declined.add(fingerprintOf(span));
				continue;
			}
			const name = adopt({ value: span, label: "粘贴时确认" }, "paste");
			out = out.split(span).join(refFor(name));
		}
		return out;
	}

	/**
	 * 把文本里的凭证按三档处理：adopt 入库换 ref，mask 换成不可执行的占位，ignore 原样留下。
	 * 跑在落盘之前，所以用户消息里不会出现明文。
	 */
	function captureFromText(text: string): { text: string; adopted: string[]; masked: number } {
		const findings = scout(text, { source: "paste" });
		if (findings.length === 0) return { text, adopted: [], masked: 0 };
		const adopted: string[] = [];
		let masked = 0;
		let out = text;
		for (const finding of [...findings].reverse()) {
			if (finding.tier === "ignore") continue;
			const replacement = finding.tier === "adopt" ? refFor(adopt(finding, "paste")) : shapePlaceholder(finding.label);
			if (finding.tier === "adopt") adopted.push(replacement.slice("{{sec:".length, -2));
			else masked += finding.spans.length;
			for (const index of [...finding.spans].sort((a, b) => b - a)) {
				out = out.slice(0, index) + replacement + out.slice(index + finding.value.length);
			}
		}
		return { text: out, adopted, masked };
	}

	// ── 工具 ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "secret_list",
		label: "列出可用密钥名",
		description: "列出本次会话已录入的密钥/敏感文本的名字与长度。不含值，也不要向用户索要值。",
		promptSnippet: "中文用途：secret_list() → 本会话可用的 {{sec:名字}} 清单（不含值）",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true },
		async execute() {
			const entries: PublicEntry[] = vault().publicList();
			if (entries.length === 0) {
				return toolText("本会话还没有录入任何密钥。需要时用 secret_prompt 请用户录入，或在面板里录入。", { entries });
			}
			const lines = entries.map((entry) => {
				const kind = entry.kind === "text" ? "敏感文本" : "密钥";
				const label = entry.label ? `，${entry.label}` : "";
				return `${refFor(entry.name)} — ${kind}${label}，${entry.length} 字符`;
			});
			return toolText(lines.join("\n"), { entries });
		},
	});

	pi.registerTool({
		name: "secret_prompt",
		label: "向用户索要密钥",
		description:
			"弹一个掩码输入框请用户录入密钥或敏感文本。值直接进入本会话的库，调用方只拿到名字，永远拿不到值。用户取消时返回失败，此时不要再重复索要。",
		promptSnippet: "中文用途：secret_prompt(name, why) → 请用户掩码录入，返回可引用的 {{sec:名字}}",
		parameters: Type.Object({
			name: Type.String({ description: "给这个密钥起的名字：字母开头，可含字母数字与 . _ -" }),
			why: Type.String({ description: "一句话说明用途，会显示给用户看（不要写密钥本身）" }),
		}),
		annotations: { readOnlyHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = String(params.name ?? "").trim();
			const why = String(params.why ?? "").trim();
			if (!isValidName(name)) {
				return toolError(`名字不合法：只能用字母开头，可含字母数字与 . _ -（收到「${name}」）`);
			}
			if (vault().has(name)) {
				return toolError(`{{sec:${name}}} 本会话已有值，直接用它即可；要换值请在面板里重新录入。`);
			}
			const value = await promptLine(ctx, {
				title: `请录入：${name}`,
				hint: `AI 的用途：${why.slice(0, 60)} · Enter 保存 · Esc 取消`,
				masked: true,
			});
			if (value === null) {
				return toolError("用户取消或当前没有界面，本次不录入。不要重复索要，改用其它办法或在面板里录入。");
			}
			vault().add({ name, value, kind: "secret", source: "prompt" });
			remember(name, value, "secret", why || undefined);
			pushStatus(ctx);
			return toolText(`已录入。用 {{sec:${name}}} 引用（${value.length} 字符，仅本次会话）。值不会进入对话。`, {
				name,
				length: value.length,
			});
		},
	});

	// ── 面板 ────────────────────────────────────────────────────────────────

	async function addEntry(ctx: ExtensionContext, name: string, kind: EntryKind): Promise<string> {
		if (!isValidName(name)) return `名字不合法：只能用字母开头，可含字母数字与 . _ -（收到「${name}」）`;
		const value = await promptLine(ctx, {
			title: kind === "text" ? `录入敏感文本：${name}` : `录入密钥：${name}`,
			hint: "输入不回显 · Enter 保存 · Esc 取消",
			masked: true,
		});
		if (value === null) return "已取消";
		const { replaced } = vault().add({ name, value, kind, source: "prompt" });
		remember(name, value, kind);
		pushStatus(ctx);
		return `${replaced ? "已覆盖" : "已录入"} {{sec:${name}}}（${value.length} 字符，仅本次会话）`;
	}

	async function panelLoop(ctx: ExtensionContext, initialView?: "settings"): Promise<void> {
		let message: string | undefined;
		for (;;) {
			const deps: PanelDeps = {
				entries: () => vault().publicList(),
				enabled: () => config.enabled,
				fingerprints: () => fingerprints?.list() ?? [],
				fingerprintPath: () => fingerprints?.keyPath ?? configDir(),
				settings: () => settingsOf(config),
				setSettings: (patch) => {
					config = { ...config, ...patch };
					saveJsonConfig(configFile(), config);
				},
				message,
			};
			const action = await openSecretPanel(ctx, deps, initialView);
			message = undefined;
			switch (action.kind) {
				case "close":
					return;
				case "toggle": {
					config = { ...config, enabled: !config.enabled };
					saveJsonConfig(configFile(), config);
					if (!config.enabled) vault().clear();
					pushStatus(ctx);
					message = config.enabled ? "已开启" : "已关闭，本次会话录入的值已清空";
					break;
				}
				case "add": {
					const name = await promptLine(ctx, {
						title: action.text ? "新敏感文本的名字" : "新密钥的名字",
						hint: "字母开头，可含 . _ - · Enter 继续 · Esc 取消",
					});
					if (name !== null) message = await addEntry(ctx, name, action.text ? "text" : "secret");
					break;
				}
				case "rename": {
					const next = await promptLine(ctx, { title: `把 ${action.name} 改成`, hint: "Enter 确认 · Esc 取消" });
					if (next !== null) {
						const result = vault().rename(action.name, next);
						message = result.ok ? `已改名为 ${next}` : `改名失败：${result.reason}`;
					}
					break;
				}
				case "remove": {
					const ok = await ctx.ui.confirm("删除条目", `从本会话移除 {{sec:${action.name}}}？（长期指纹表不受影响）`);
					if (ok) {
						vault().remove(action.name);
						confirmed.delete(action.name);
						pushStatus(ctx);
						message = `已移除 ${action.name}`;
					}
					break;
				}
				case "copy": {
					const value = vault().get(action.name);
					if (value === undefined) break;
					try {
						await copyToClipboard(value);
						message = `已把 ${action.name} 的值复制到剪贴板（值不会进对话）`;
					} catch {
						message = "复制失败";
					}
					break;
				}
				case "fingerprint-toggle": {
					const entry = vault().entry(action.name);
					if (!entry) break;
					if (fingerprints?.has(action.name)) {
						fingerprints.forget(action.name);
						message = `已从长期指纹表移出 ${action.name}`;
					} else if (remember(action.name, entry.value, entry.kind, entry.label)) {
						message = `已写进长期指纹表：${action.name}（跨会话只剩指纹）`;
					} else {
						message = `值只有 ${entry.length} 字符，不写进长期指纹表——弱口令进表等于给自己留靶子`;
					}
					break;
				}
				case "fingerprint-forget": {
					if (fingerprints?.forget(action.name)) message = `已删除指纹 ${action.name}`;
					break;
				}
				case "fingerprint-clear": {
					const ok = await ctx.ui.confirm("清空长期指纹表", "以后这些口令再出现就不会被认出来了。确定清空？");
					if (ok) {
						fingerprints?.clear();
						message = "长期指纹表已清空";
					}
					break;
				}
			}
		}
	}

	// ── 命令（面板是唯一入口，on/off/list 只为无界面场景保留） ────────────────

	pi.registerCommand("secret", {
		description: "密钥面板：录入 / 查看 / 长期指纹表 / 设置 / 帮助（无界面时支持 on off list）",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/).filter(Boolean)[0];
			if (!sub) {
				await panelLoop(ctx);
				return;
			}
			if (sub === "on" || sub === "off") {
				const on = sub === "on";
				config = { ...config, enabled: on };
				saveJsonConfig(configFile(), config);
				if (!on) vault().clear();
				pushStatus(ctx);
				ctx.ui.notify(`secret：已${on ? "开启" : "关闭（并清空本次会话的值）"}`, "info");
				return;
			}
			if (sub === "list") {
				const entries = vault().publicList();
				ctx.ui.notify(
					entries.length === 0
						? "secret：本次会话还没有录入任何条目"
						: entries
								.map((e) => `${e.name} · ${e.kind === "text" ? "文本" : "密钥"} · ${e.length} 字符${e.preview ? ` · ${e.preview}` : ""}`)
								.join("\n"),
					"info",
				);
				return;
			}
			ctx.ui.notify("secret：直接执行 /secret 打开面板，录入、指纹表、设置都在里面（无界面时可用 on / off / list）", "info");
		},
	});

	pi.registerCommand("secret-config", {
		description: "secret 设置：打开面板的设置页（等同 /secret 里按 s）",
		handler: async (_args, ctx) => {
			await panelLoop(ctx, "settings");
		},
	});

	// ── 生命周期 ────────────────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		config = readConfig();
		scope = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		if (event.reason !== "reload") confirmed.clear();
		providerHookFired = false;
		providerHookWarned = false;
		const loaded = FingerprintTable.load(configDir());
		fingerprints = loaded.table;
		if (loaded.notice !== undefined && ctx.hasUI) ctx.ui.notify(loaded.notice, "warning");
		registerSecretBash(pi, ctx.cwd, { vault, enabled: () => config.enabled, mask: maskOptions });
		if (!bashIsOurs(pi) && ctx.hasUI) {
			ctx.ui.notify("secret：bash 工具被另一个扩展抢先注册，{{sec:…}} 不会展开（加载顺序决定，扩展之间先注册者胜）", "error");
		}
		pushStatus(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "reload") {
			dropVault(scope);
			confirmed.clear();
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// ── 入口两道 ────────────────────────────────────────────────────────────

	pi.on("input", async (event, ctx) => {
		if (!config.enabled || event.source === "extension") return;
		if (event.text.includes("{{sec:")) return; // 已经是 ref 形态，不必再猜
		let text = event.text;
		const notices: string[] = [];
		if (config.captureOnPaste) {
			const captured = captureFromText(text);
			text = captured.text;
			notices.push(...captured.adopted.map((name) => `secret：已收进本次会话 {{sec:${name}}}（值不会进入对话）`));
			if (captured.masked > 0) {
				notices.push(`secret：遮住了 ${captured.masked} 处像凭证的文字（拿不准，所以只遮不收——要用请在面板里补录）`);
			}
		}
		// 本会话没有值、但长期指纹表里有的旧口令：照旧遮住（占位里会写明本会话没有值）。
		if (config.fingerprints && fingerprints) {
			const scanned = fingerprints.scan(text);
			if (scanned.hits > 0) {
				text = scanned.text;
				notices.push(`secret：遮住了 ${scanned.hits} 处以前录过的口令（本会话没有值，要用来执行请在面板里补录）`);
			}
		}
		// 形态与关键词都认不出的裸口令：在这里问一句。
		text = await confirmGuesses(ctx, text);
		if (text === event.text) return;
		pushStatus(ctx);
		if (ctx.hasUI) for (const line of notices) ctx.ui.notify(line, "info");
		// 值已进库、文本只剩 ref，所以这次变换跑在落盘之前——文件里不会出现明文。
		return { action: "transform" as const, text };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!config.enabled) return;
		const input = event.input as Record<string, unknown>;

		if (SHELL_TOOLS.has(event.toolName)) {
			const command = input.command;
			if (typeof command !== "string") return;
			const names = refsIn(command);
			if (names.length === 0) return;
			if (event.toolName !== "bash") {
				return { block: true, reason: "{{sec:…}} 只在 bash 里展开（该工具的 shell 不会读到注入的环境变量）" };
			}
			const store = vault();
			const missing = names.filter((name) => !store.has(name));
			if (missing.length > 0) {
				return {
					block: true,
					reason: `本会话没有这些名字：${missing.map((n) => refFor(n)).join("、")}。用 secret_list 看已有名字，或用 secret_prompt 请用户录入。`,
				};
			}
			const collisions = envCollisions(names);
			if (collisions.length > 0) {
				return {
					block: true,
					reason: `这些名字会撞成同一个环境变量，无法同时使用：${collisions.map((group) => group.join(" / ")).join("；")}。请改名后重试。`,
				};
			}
			const ok = await confirmUse(ctx, names, command);
			if (!ok) return { block: true, reason: "用户拒绝了这次密钥使用" };
			return;
		}

		if (NO_EXPAND_TOOLS.has(event.toolName)) return;
		const expanded = expandDeep(input, (name) => vault().get(name));
		// 名字不在库里：原样保留、不阻断（写文档或代码时提到 ref 语法是常见需求），
		// 改在结果里补一句提醒，把静默失改变成可见。
		if (expanded.missing.length > 0) missingRefs.set(event.toolCallId, expanded.missing);
		if (expanded.used.length === 0) return;
		const ok = await confirmUse(ctx, expanded.used, JSON.stringify(input, null, 2));
		if (!ok) return { block: true, reason: "用户拒绝了这次密钥使用" };
		// 原地改写：pi 校验参数时做的是 structuredClone，所以转录与模型看到的仍是最初的 ref。
		const value = expanded.value as Record<string, unknown>;
		for (const key of Object.keys(value)) input[key] = value[key];
		return;
	});

	// ── 出口四道网 ──────────────────────────────────────────────────────────

	pi.on("tool_result", async (event, ctx) => {
		const missed = missingRefs.get(event.toolCallId);
		if (missed) missingRefs.delete(event.toolCallId);
		if (!config.enabled) return;
		const store = vault();
		const options = maskOptions();
		const content = maskDeep(event.content, store, options);
		const details = maskDeep(event.details, store, options);
		const structured = event.structuredContent === undefined ? undefined : maskDeep(event.structuredContent, store, options);
		const hits = content.hits + details.hits + (structured?.hits ?? 0);
		if (content.skipped > 0 && ctx.hasUI) {
			ctx.ui.notify("secret：本次结果里有图片/二进制内容，未做脱敏——截图或二进制里若含密钥，仍会发往服务商", "info");
		}
		if (hits === 0 && !missed) return;
		const blocks = content.value as typeof event.content;
		const withNotice = missed
			? [...blocks, { type: "text" as const, text: `⚠ secret：${missed.map((n) => refFor(n)).join("、")} 不在本会话的库里，这段文字已原样处理。` }]
			: blocks;
		return {
			content: withNotice,
			details: details.value,
			// 改 content 必须一并给出 structuredContent，否则 pi 会丢弃它。
			...(structured === undefined ? {} : { structuredContent: structured.value as never }),
			isError: event.isError,
		};
	});

	pi.on("context", async (event) => {
		if (!config.enabled) return;
		const masked = maskDeep(event.messages, vault(), maskOptions());
		if (masked.hits === 0) return;
		return { messages: masked.value as never };
	});

	pi.on("before_provider_request", async (event) => {
		// 记在开关判断之前：这条测的是宿主有没有这个钩子，与用户是否启用无关。
		providerHookFired = true;
		if (!config.enabled) return;
		const masked = maskDeep(event.payload, vault(), maskOptions());
		if (masked.hits === 0) return;
		return masked.value;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (providerHookFired || providerHookWarned || !config.enabled) return;
		providerHookWarned = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				"secret：当前供应商没有触发请求体钩子，最后一道网缺席。转录、工具结果与模型上下文仍然脱敏，只是请求体本身没有二次校验。",
				"warning",
			);
		}
	});

	// ── 给模型的说明 ────────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (!config.enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${USAGE_NOTE}` };
	});
}
