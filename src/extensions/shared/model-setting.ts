/**
 * shared/model-setting：插件侧「模型设置」的唯一实现（本地设置 → 中心设置 → 默认策略 → AUTO）
 *
 * 两层结构（管理侧 model-config 与插件侧各自独立，插件不依赖管理插件也能工作）：
 * - 插件侧（本模块）：每个用途一个本地设置，值域只有 `auto`（交给 model-config）或 `provider/modelId`（本地固定）。
 *   本地键沿用各插件原有的 `model` 键：历史写下的具体模型会被自然当成本地固定（就是一次无代码迁移），
 *   想改回由中心决定只需在面板/命令里选 auto
 * - 管理侧（model-config 扩展）：`~/.pi/agent/model-config.json` 里每个用途一条中心设置，值域 = 策略或具体模型；
 *   策略 `AUTO`（跟随当前会话模型）与 `FREE`（免费模型池 + 故障转移）语义固定、只能被选不能改，
 *   `MAX / FAST / LITE / BASE / BATCH` 是用户可重指到具体模型的槽
 *
 * 解析链（resolve）：
 *   本地固定模型 → 直接用
 *   本地 auto → 中心里该用途的设置 → 无记录则插件注册时声明的默认策略 → 仍无则 AUTO
 *   中心插件缺席时仍读 model-config.json（文件通道），因此离开管理插件设置依旧生效
 *
 * 跨扩展只走两条既有公开通道：`globalThis.__PI_MODEL_DECLS__`（用途声明清单，供面板枚举）
 * 与 `~/.pi/agent/model-config.json`（中心设置）。每插件产物内联本模块，不 import 对方产物。
 *
 * 回退（failover）：只有 FREE 免费池给出多个候选（按价格升序依次尝试）；
 * 其余解析结果都是单模型，失败由调用方处理。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadJsonConfig, saveJsonConfig } from "./config";
import {
	findConfiguredModel,
	isFreeModel,
	listAvailableModels,
	modelRef,
	type AnyModel,
} from "./model-util";

// ---------------------------------------------------------------------------
// 策略
// ---------------------------------------------------------------------------

export const STRATEGIES = ["AUTO", "MAX", "FAST", "LITE", "BASE", "BATCH", "FREE"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** 可由用户重指到具体模型的策略槽；AUTO / FREE 语义固定（只能被选、不可被改） */
export const MAPPABLE_STRATEGIES: Strategy[] = ["MAX", "FAST", "LITE", "BASE", "BATCH"];

/** 策略简称（面板/命令列表第一列） */
export const STRATEGY_LABEL: Record<Strategy, string> = {
	AUTO: "跟随会话",
	MAX: "顶级配置",
	FAST: "又快又好",
	LITE: "高速廉价",
	BASE: "便宜通用",
	BATCH: "便宜大碗",
	FREE: "免费模型",
};

/** 策略定位说明（面板副标题、命令帮助） */
export const STRATEGY_DESC: Record<Strategy, string> = {
	AUTO: "当前会话使用的模型，随会话切换",
	MAX: "最强能力优先，成本不敏感",
	FAST: "质量与速度兼顾，适合用户直接阅读的结果",
	LITE: "响应快、单价低，适合高频短任务",
	BASE: "通用质量、成本可控",
	BATCH: "最便宜的可用模型，适合批量与后台任务",
	FREE: "只在免费模型里选，主选失败自动换下一个",
};

export function isStrategy(v: string): v is Strategy {
	return (STRATEGIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// 中心设置（~/.pi/agent/model-config.json）
// ---------------------------------------------------------------------------

export const MODEL_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "model-config.json");
const MODEL_CONFIG_VERSION = 1;

export interface ModelConfigState {
	version: number;
	/** 策略槽映射：只出现被用户改过的槽；缺失 = 默认路由（AUTO） */
	strategies: Partial<Record<Strategy, string>>;
	/** 用途设置：purpose → 策略名或 `provider/modelId`；缺失 = 用插件注册的默认策略 */
	purposes: Record<string, string>;
}

function emptyState(): ModelConfigState {
	return { version: MODEL_CONFIG_VERSION, strategies: {}, purposes: {} };
}

function isState(v: unknown): v is ModelConfigState {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	const strategies = o.strategies ?? {};
	const purposes = o.purposes ?? {};
	const strOk = (x: unknown) => typeof x === "string" && x.trim().length > 0;
	return (
		typeof strategies === "object" && strategies !== null && Object.values(strategies).every(strOk) &&
		typeof purposes === "object" && purposes !== null && Object.values(purposes).every(strOk)
	);
}

let stateCache: { mtimeMs: number; state: ModelConfigState } | null = null;

/**
 * 读中心设置（按文件 mtime 缓存，面板改完立刻生效，无需 /reload）。
 * 文件不存在/损坏 → 空状态（loadJsonConfig 会把损坏文件隔离为 .corrupt-*）。
 */
export function loadModelConfigState(): ModelConfigState {
	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(MODEL_CONFIG_FILE).mtimeMs;
	} catch {
		/* 文件不存在 → mtime 0 */
	}
	if (stateCache && stateCache.mtimeMs === mtimeMs) return stateCache.state;
	const raw = loadJsonConfig<ModelConfigState>(MODEL_CONFIG_FILE, emptyState(), isState);
	const state: ModelConfigState = {
		version: MODEL_CONFIG_VERSION,
		strategies: { ...(raw.strategies ?? {}) },
		purposes: { ...(raw.purposes ?? {}) },
	};
	stateCache = { mtimeMs, state };
	return state;
}

/** 写中心设置（原子写 + 刷新 mtime 缓存）。 */
export function saveModelConfigState(state: ModelConfigState): void {
	const next: ModelConfigState = {
		version: MODEL_CONFIG_VERSION,
		strategies: { ...state.strategies },
		purposes: { ...state.purposes },
	};
	saveJsonConfig(MODEL_CONFIG_FILE, next);
	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(MODEL_CONFIG_FILE).mtimeMs;
	} catch {
		/* 写失败时按未缓存处理 */
	}
	stateCache = { mtimeMs, state: next };
}

/** 设置/清除策略槽映射（model 为 null = 清除，回到默认路由）。 */
export function setStrategyMapping(strategy: Strategy, model: string | null): void {
	const state = loadModelConfigState();
	if (model) state.strategies[strategy] = model;
	else delete state.strategies[strategy];
	saveModelConfigState(state);
}

/** 设置/清除某用途的中心设置（setting 为 null = 清除，回到插件注册的默认策略）。 */
export function setPurposeSetting(purpose: string, setting: string | null): void {
	const state = loadModelConfigState();
	if (setting) state.purposes[purpose] = setting;
	else delete state.purposes[purpose];
	saveModelConfigState(state);
}

// ---------------------------------------------------------------------------
// 用途声明（插件加载时推入 globalThis，供面板枚举；无加载顺序问题）
// ---------------------------------------------------------------------------

export interface PurposeDecl {
	/** 用途 id（`插件.场景`，如 btw.chat） */
	purpose: string;
	plugin: string;
	/** 面板显示名（如「侧栏问答」） */
	label: string;
	/** 注册时声明的默认策略（中心无该用途记录时生效） */
	defaultStrategy: Strategy;
	/** 本地设置存储文件；缺省表示该用途不支持本地覆盖（如跟随会话的 /init） */
	file?: string;
	/** 本地设置键名（同一文件多个用途时区分），默认 "model" */
	key?: string;
	/** 该用途要求模型能读图（面板在选择时禁止无读图能力的模型） */
	requiresVision?: boolean;
}

export const MODEL_DECLS_KEY = "__PI_MODEL_DECLS__";
export const MODEL_DECLS_VERSION = 1;

interface DeclRegistry {
	version: number;
	list: PurposeDecl[];
}

function declRegistry(): DeclRegistry {
	const g = globalThis as Record<string, unknown>;
	const cur = g[MODEL_DECLS_KEY] as DeclRegistry | undefined;
	if (cur && cur.version === MODEL_DECLS_VERSION && Array.isArray(cur.list)) return cur;
	const reg: DeclRegistry = { version: MODEL_DECLS_VERSION, list: [] };
	g[MODEL_DECLS_KEY] = reg;
	return reg;
}

/** 注册用途声明（同 id 幂等；插件重复加载不会重复登记）。 */
export function declarePurpose(decl: PurposeDecl): void {
	const reg = declRegistry();
	const i = reg.list.findIndex((d) => d.purpose === decl.purpose);
	if (i >= 0) reg.list[i] = decl;
	else reg.list.push(decl);
}

/** 当前已注册的用途（按插件名、再按用途 id 排序，供面板稳定展示）。 */
export function listPurposeDecls(): PurposeDecl[] {
	return [...declRegistry().list].sort(
		(a, b) => a.plugin.localeCompare(b.plugin) || a.purpose.localeCompare(b.purpose),
	);
}

// ---------------------------------------------------------------------------
// 本地设置（插件侧：auto | provider/modelId）
// ---------------------------------------------------------------------------

export const LOCAL_AUTO = "auto";

/** 本地值归一化：缺失/null/空串 → auto；其余原样当具体模型引用（解析不出时自然回落 AUTO） */
function normalizeLocal(v: unknown): string {
	if (typeof v !== "string") return LOCAL_AUTO;
	const s = v.trim();
	if (!s || s === LOCAL_AUTO) return LOCAL_AUTO;
	return s;
}

/** 读用途的本地设置；未声明本地文件（或读取失败）→ auto */
export function readLocalSetting(decl: PurposeDecl): string {
	if (!decl.file || !decl.key) return LOCAL_AUTO;
	try {
		const obj = JSON.parse(fs.readFileSync(decl.file, "utf8")) as Record<string, unknown>;
		return normalizeLocal(obj?.[decl.key]);
	} catch {
		return LOCAL_AUTO;
	}
}

/** 写用途的本地设置（读-改-写，保留同文件里该插件的其它配置键）。 */
export function writeLocalSetting(decl: PurposeDecl, value: string): void {
	if (!decl.file || !decl.key) return;
	let obj: Record<string, unknown> = {};
	try {
		const cur = JSON.parse(fs.readFileSync(decl.file, "utf8")) as unknown;
		if (cur && typeof cur === "object" && !Array.isArray(cur)) obj = cur as Record<string, unknown>;
	} catch {
		/* 文件缺失/损坏 → 从空对象开始 */
	}
	obj[decl.key] = normalizeLocal(value);
	saveJsonConfig(decl.file, obj);
}

// ---------------------------------------------------------------------------
// 解析（设置串 → 模型链）
// ---------------------------------------------------------------------------

export interface ResolvedChain {
	/** 首选模型；没有任何可用模型时为 undefined（调用方降级） */
	model?: AnyModel;
	/** 依次取下一个候选；只有 FREE 免费池是多候选，其余返回 undefined */
	failover: () => AnyModel | undefined;
	/** 候选链（FREE 池多个；其余只一个） */
	chain: AnyModel[];
	/** 解析来源说明（面板/通知文案） */
	label: string;
}

function chainOf(models: AnyModel[], label: string): ResolvedChain {
	const chain = models.filter((m, i) => models.findIndex((x) => modelRef(x) === modelRef(m)) === i);
	let idx = 0;
	return { model: chain[0], chain, label, failover: () => chain[++idx] };
}

/** 具体模型（或槽映射值）→ 单模型链：不跨模型回退（回退只属于 FREE 免费池） */
function chainForModel(m: AnyModel, label: string): ResolvedChain {
	return chainOf([m], label);
}

/** AUTO：当前会话模型（会话模型不可用时取最便宜的可用模型） */
function chainForSession(ctx: ExtensionContext): ResolvedChain {
	const session = ctx.model as AnyModel | undefined;
	const available = listAvailableModels(ctx);
	const usable =
		session && ctx.modelRegistry.hasConfiguredAuth(session) &&
		available.some((m) => modelRef(m) === modelRef(session))
			? session
			: available[0];
	if (!usable) return chainOf([], "AUTO 跟随会话（无可用模型）");
	return chainOf([usable], "AUTO 跟随会话");
}

/**
 * 设置串 → 模型链。设置串可为：
 * - 策略名（AUTO / FREE / MAX / FAST / LITE / BASE / BATCH）
 * - `provider/modelId` 或模型 id 子串（同 findConfiguredModel 语义）
 * 无法解析（槽未映射、模型不可用）时统一回落到 AUTO（跟随会话）。
 */
export function resolveSetting(setting: string, ctx: ExtensionContext): ResolvedChain {
	const raw = (setting ?? "").trim();
	const upper = raw.toUpperCase();
	if (upper === "FREE") {
		const free = listAvailableModels(ctx).filter(isFreeModel);
		if (free.length > 0) return chainOf(free, "FREE 免费模型池");
		return chainOf(listAvailableModels(ctx).slice(0, 1), "FREE（无免费模型，回落最便宜）");
	}
	if (upper === "AUTO") return chainForSession(ctx);
	if (isStrategy(upper)) {
		const mapped = loadModelConfigState().strategies[upper];
		if (!mapped) return chainForSession(ctx);
		const m = findConfiguredModel(ctx, mapped);
		if (!m) return chainForSession(ctx);
		return chainForModel(m, `${upper} → ${mapped}`);
	}
	const m = findConfiguredModel(ctx, raw);
	if (m) return chainForModel(m, raw);
	return chainForSession(ctx);
}

// ---------------------------------------------------------------------------
// 用途的模型设置（插件侧入口）
// ---------------------------------------------------------------------------

export interface ResolvedModel extends ResolvedChain {
	/** 本地设置值：auto | provider/modelId */
	local: string;
	/** 中心里该用途的设置（未记录 = null） */
	centerSetting: string | null;
	/** 实际生效的设置串（策略名或模型引用） */
	setting: string;
	/** 生效来源：local（本地固定）/ center（中心设置）/ default（注册默认策略）/ fallback（AUTO 兜底） */
	source: "local" | "center" | "default" | "fallback";
}

export interface ModelSetting {
	decl: PurposeDecl;
	/** 本地设置值（auto | provider/modelId） */
	getLocal(): string;
	setLocal(value: string): void;
	/** 中心里该用途的设置（未记录 = null） */
	getCenterSetting(): string | null;
	/** 解析出最终模型链（含来源信息，供面板/通知展示） */
	resolve(ctx: ExtensionContext): ResolvedModel;
	/** 一行式说明，如「中心 FAST → deepseek/deepseek-v4.1-flash」 */
	describe(ctx: ExtensionContext): string;
}

/**
 * 创建用途的模型设置：注册声明（供面板枚举）+ 本地设置读写 + 解析链。
 * 插件只在加载时调用一次，之后每次要用模型时调 resolve()（会重读文件，面板改完即生效）。
 */
export function createModelSetting(opts: PurposeDecl): ModelSetting {
	declarePurpose(opts);
	const setting: ModelSetting = {
		decl: opts,
		getLocal: () => readLocalSetting(opts),
		setLocal: (v: string) => writeLocalSetting(opts, v),
		getCenterSetting: () => loadModelConfigState().purposes[opts.purpose] ?? null,
		resolve(ctx) {
			const local = readLocalSetting(opts);
			const center = loadModelConfigState().purposes[opts.purpose] ?? null;
			if (local !== LOCAL_AUTO) {
				const chain = resolveSetting(local, ctx);
				return { ...chain, local, centerSetting: center, setting: local, source: "local" };
			}
			if (center) {
				const chain = resolveSetting(center, ctx);
				return { ...chain, local, centerSetting: center, setting: center, source: "center" };
			}
			if (isStrategy(opts.defaultStrategy)) {
				const chain = resolveSetting(opts.defaultStrategy, ctx);
				return {
					...chain,
					local,
					centerSetting: center,
					setting: opts.defaultStrategy,
					source: "default",
				};
			}
			const chain = resolveSetting("AUTO", ctx);
			return { ...chain, local, centerSetting: center, setting: "AUTO", source: "fallback" };
		},
		describe(ctx) {
			const r = setting.resolve(ctx);
			return `${r.label}（${modelRef(r.model)}）`;
		},
	};
	return setting;
}

/** 来源说明（面板/通知文案统一口径） */
export const SOURCE_LABEL: Record<ResolvedModel["source"], string> = {
	local: "本地固定",
	center: "中心设置",
	default: "默认策略",
	fallback: "AUTO 兜底",
};
