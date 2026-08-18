/**
 * webui 扩展配置：端口 / token / 开关
 *
 * 持久化到 ~/.pi/agent/webui-config.json（复用 shared/config.ts 的原子读写）。
 * token 首次启动自动生成（crypto 随机 32 位 hex），浏览器 URL 携带访问；
 * 只允许改端口/开关，token 由系统维护（重置走 /webui token 命令）。
 */
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { loadJsonConfig, saveJsonConfig } from "../shared/config";

/** webui 配置：enabled 是否启用服务；port 监听端口；token 访问凭据（随机生成）。
 *  注意：lan（局域网开放）是**会话级临时状态**，刻意不持久化——由 /webui-lan 在运行时开启，
 *  进程退出自动失效，避免「忘了关导致下次启动自动暴露到局域网」。 */
export interface WebuiConfig {
	enabled: boolean;
	port: number;
	token: string;
}

export const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "webui-config.json");

export const DEFAULT_PORT = 7741; // pi 默认端口（可 /webui port <n> 修改）

const DEFAULT_CONFIG: WebuiConfig = { enabled: true, port: DEFAULT_PORT, token: "" };

function isConfig(v: unknown): v is WebuiConfig {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.enabled === "boolean" &&
		typeof o.port === "number" &&
		Number.isInteger(o.port) &&
		o.port > 0 &&
		o.port < 65536 &&
		typeof o.token === "string"
	);
}

/** 读取配置；token 缺失时自动生成并回写（保证访问凭据存在）。
 *  PI_WEBUI_PORT 环境变量优先于配置文件（测试/调试隔离用，不入库）。
 *  显式挑选字段：剔除旧版配置文件里残留的 lan 等已废弃字段。 */
export function loadConfig(): WebuiConfig {
	const raw = loadJsonConfig(CONFIG_FILE, DEFAULT_CONFIG, isConfig);
	const cfg: WebuiConfig = { enabled: raw.enabled, port: raw.port, token: raw.token };
	const envPort = Number(process.env.PI_WEBUI_PORT);
	if (Number.isInteger(envPort) && envPort >= 0 && envPort < 65536) {
		cfg.port = envPort;
	}
	if (!cfg.token) {
		cfg.token = crypto.randomBytes(16).toString("hex");
		saveConfig(cfg);
	}
	return cfg;
}

export function saveConfig(cfg: WebuiConfig): void {
	saveJsonConfig(CONFIG_FILE, cfg);
}

/** 生成新 token 并持久化（面板「重置凭据」用） */
export function rotateToken(cfg: WebuiConfig): string {
	cfg.token = crypto.randomBytes(16).toString("hex");
	saveConfig(cfg);
	return cfg.token;
}
