/**
 * webui 扩展入口：TUI 进程内的本地 Web 界面（HTTP + SSE），单端口多会话
 *
 * 双端同步原理：本扩展跑在 pi TUI 进程内，与 TUI 共享同一 session——
 * 浏览器只是这个进程的另一个「眼睛和手」：
 * - 下行：pi.on() 监听全部会话/agent/tool 事件 → SSE 实时广播给浏览器；
 * - 上行：浏览器发消息走 pi.sendUserMessage() 注入当前会话，TUI 同步可见；
 * - 状态：复用 hud 子模块（git 状态 / 余额适配 / 消耗统计）推给浏览器状态栏。
 *
 * 单端口多会话（主-从架构）：
 * - 第一个启动的 pi 进程成为主（host）监听配置端口，浏览器统一访问；
 * - 后续进程探测到主存在（GET /internal/ping）→ 成为从（relay），
 *   事件经 HTTP 上行给主、命令经 attach 长连接下行（relay.ts）；
 * - 浏览器按 pid 路由区分会话：/s/<pid>/，/ 为会话列表页；
 * - 主退出 → 从进程断线重连失败 → 自动抢占端口升级为新主（故障转移）。
 *
 * 生命周期：session_start 初始化桥并接入/启动服务（跨 session 常驻），
 * session_shutdown(reload/quit) 停止释放端口（reload 后新实例重建）。
 *
 * 命令：
 * - /webui            查看状态与访问地址
 * - /webui on|off     启用/停用服务
 * - /webui port <n>   改端口并重启
 * - /webui token      重置访问凭据（旧地址失效）
 * - /webui restart    重启服务
 * - /webui-lan        开启局域网访问（临时：退出/重载自动关闭，无需关闭参数）
 */
import * as http from "node:http";
import * as os from "node:os";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge } from "./bridge";
import { WebuiServer } from "./server";
import { Relay } from "./relay";
import { loadConfig, saveConfig, rotateToken, type WebuiConfig } from "./config";

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	const myPid = process.pid;

	// 图片占位显示组件：webui 发送的带图消息，TUI 渲染时丢弃 image content（纯图片消息
	// 甚至整条不显示）。bridge 在 user 消息持久化后（assistant message_start）追加 CustomEntry
	// （type:"custom"，不进 LLM 上下文），这里注册其渲染器——显示为「[N 张图片]」小标签，
	// 紧跟用户消息下方。方括号纯文本即可区分独立标签，不用 emoji。
	pi.registerEntryRenderer("webui-images", (entry, _opts, theme) => {
		const d = entry.data as { count?: number } | undefined;
		const n = Math.max(1, d?.count ?? 1);
		return new Text(theme.fg("accent", `[${n}张图片]`), 0, 0);
	});

	let bridge: Bridge | null = null;
	let server: WebuiServer | null = null;
	let relay: Relay | null = null;
	let role: "host" | "relay" | null = null;
	/** 局域网开放：会话级临时状态，刻意不持久化——进程退出自动失效（安全设计：避免忘关导致下次启动自动暴露） */
	let lanOn = false;
	let currentCtx: ExtensionContext | null = null;

	/** bridge 事件出口：按当前角色转发（host 直广播；relay 上行给主） */
	const emit = (msg: Record<string, unknown>) => {
		if (role === "host") server?.broadcastTo(myPid, msg);
		else if (role === "relay") relay?.postEvent(msg);
	};

	function myUrl(): string {
		const port = role === "host" && server ? server.port() : cfg.port;
		return `http://localhost:${port}/s/${myPid}/?token=${cfg.token}`;
	}

	/** 局域网 IPv4 地址（lan 模式下展示用；无则 null） */
	function lanAddress(): string | null {
		for (const list of Object.values(os.networkInterfaces())) {
			for (const iface of list ?? []) {
				if (iface.family === "IPv4" && !iface.internal) return iface.address;
			}
		}
		return null;
	}

	/** 跨设备访问地址（lan 模式） */
	function lanUrl(): string {
		const ip = lanAddress() ?? "<局域网IP>";
		const port = role === "host" && server ? server.port() : cfg.port;
		return `http://${ip}:${port}/?token=${cfg.token}`;
	}

	function sessionInfo(): { cwd: string; sessionName: string } {
		return {
			cwd: currentCtx?.cwd ?? "",
			sessionName: currentCtx?.sessionManager.getSessionName() ?? "",
		};
	}

	// ------------------------------------------------------------------
	// 角色启动
	// ------------------------------------------------------------------

	/** 探测配置端口是否已有 webui 主（2s 超时，失败视为无主） */
	function probeMaster(): Promise<boolean> {
		return new Promise((resolve) => {
			const req = http.get(
				`http://127.0.0.1:${cfg.port}/internal/ping?token=${encodeURIComponent(cfg.token)}`,
				(res) => {
					let data = "";
					res.on("data", (c) => (data += c));
					res.on("end", () => {
						try {
							const j = JSON.parse(data) as { ok?: boolean; role?: string };
							resolve(j.ok === true && j.role === "webui");
						} catch {
							resolve(false);
						}
					});
				},
			);
			req.on("error", () => resolve(false));
			req.setTimeout(2_000, () => {
				req.destroy();
				resolve(false);
			});
		});
	}

	/** 成为主（host）：listen 指定端口；成功返回 true，端口被占返回 false */
	async function startHost(port: number): Promise<boolean> {
		const srv = new WebuiServer(cfg, () => bridge);
		const actual = await srv.start(port, lanOn);
		if (actual < 0) return false; // EADDRINUSE
		if (actual === 0) return false; // 其他错误
		server = srv;
		role = "host";
		srv.registerLocal(myPid, sessionInfo());
		return true;
	}

	/** 成为从（relay）：接入主服务 */
	function startRelay(): void {
		role = "relay";
		const r = new Relay(cfg, () => bridge, sessionInfo);
		r.onMasterGone = () => {
			// 主已下线：尝试抢占端口升级为主；抢不到（别的从抢先）则继续 relay
			void (async () => {
				r.stop();
				if (relay === r) relay = null;
				if (await startHost(cfg.port)) {
					currentCtx?.ui.notify(`WebUI 主已迁移到本会话：${myUrl()}`, "info");
				} else {
					startRelay();
				}
			})();
		};
		relay = r;
		r.connect();
	}

	function stopAll(): void {
		relay?.stop();
		relay = null;
		if (server) {
			server.unregisterLocal(myPid);
			server.stop();
			server = null;
		}
		role = null;
	}

	/** 启动（或接入）webui 服务 */
	async function startService(notify: (text: string) => void): Promise<void> {
		if (server || relay) return;
		if (!cfg.enabled) {
			notify(`WebUI 已停用（/webui on 开启）`);
			return;
		}
		if (!bridge) {
			bridge = new Bridge(pi, emit);
			bridge.attach();
		}
		if (await probeMaster()) {
			startRelay();
			notify(`WebUI 已接入主服务：${myUrl()}`);
			return;
		}
		if (await startHost(cfg.port)) {
			notify(`WebUI: ${myUrl()}（列表页 http://localhost:${cfg.port}/?token=…）`);
			return;
		}
		// 端口被非 webui 程序占用：退随机端口孤立模式（只服务本进程，其他会话探测不到）
		if (await startHost(0)) {
			notify(`WebUI（孤立模式，${cfg.port} 被其他程序占用）：${myUrl()}`);
			return;
		}
		notify(`WebUI 启动失败，请检查端口 ${cfg.port}`);
	}

	// -- 会话生命周期 --

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		// 桥与服务器跨 session 常驻（TUI 进程内共享会话数据，session 切换自动跟随）
		if (!bridge) {
			bridge = new Bridge(pi, emit);
			bridge.attach();
		}
		// 手动初始化会话上下文（attach 的 session_start 事件在本轮之后才触发，不能等它）
		await bridge.onSessionStart(event, ctx);
		// 主模式下会话切换更新注册表元信息
		if (role === "host") server?.updateLocalInfo(myPid, sessionInfo());
		if (cfg.enabled && !server && !relay) {
			await startService((text) => ctx.ui.notify(text, "info"));
		}
	});

	pi.on("session_shutdown", async (event) => {
		// 所有 session 替换流程（new/resume/fork/reload/quit）都会 reload 扩展——
		// 旧实例必须释放端口/断开 relay，否则新实例会 relay 到本实例的死 server 上
		// （旧 server 仍监听但 localBridge 指向已卸载的旧闭包）。
		stopAll();
	});

	// -- 命令 --

	pi.registerCommand("webui", {
		description: "本地 Web 界面：查看地址 / 开关 / 端口 / 凭据",
		handler: async (args, ctx) => {
			const cmd = (args.trim() || "status").toLowerCase();

			// 隐藏子命令：webui 回退按钮的 fork 通道（ctx.fork 是 command ctx 专属能力，
			// 只能经扩展命令分发间接触达；收编为 /webui 子参数而非独立命令，
			// 避免 TUI / 列表多出一条内部命令。不列入帮助文本。）
			if (cmd.startsWith("fork ")) {
				const entryId = args.trim().slice(5).trim(); // 从原始 args 取，防 toLowerCase 破坏 entryId
				if (!entryId) return;
				try {
					await ctx.fork(entryId);
				} catch (e) {
					ctx.ui.notify(`回退失败：${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}

			if (cmd === "on") {
				cfg.enabled = true;
				saveConfig(cfg);
				await startService((t) => ctx.ui.notify(t, "info"));
				ctx.ui.notify("WebUI 已启用", "info");
				return;
			}

			if (cmd === "off") {
				cfg.enabled = false;
				saveConfig(cfg);
				stopAll();
				ctx.ui.notify("WebUI 已停用（浏览器连接将断开）", "warning");
				return;
			}

			if (cmd === "restart") {
				stopAll();
				await startService((t) => ctx.ui.notify(t, "info"));
				return;
			}

			if (cmd === "token") {
				const t = rotateToken(cfg);
				stopAll();
				await startService((text) => ctx.ui.notify(text, "info"));
				ctx.ui.notify(`新访问凭据已生成：${t}`, "warning");
				return;
			}

			if (cmd.startsWith("port ")) {
				const n = Number(cmd.slice(5).trim());
				if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
					ctx.ui.notify(`无效端口：${cmd.slice(5).trim()}`, "error");
					return;
				}
				cfg.port = n;
				saveConfig(cfg);
				stopAll();
				await startService((t) => ctx.ui.notify(t, "info"));
				ctx.ui.notify(`端口已改为 ${n}`, "info");
				return;
			}

			// status（默认）
			const roleText = role === "host" ? "主" : role === "relay" ? "从" : "未启动";
			const state = server || relay ? `运行中（${roleText}模式）` : cfg.enabled ? `未启动` : `已停用`;
			const port = server ? server.port() : cfg.port;
			const lines = [
				`WebUI 状态：${state}${lanOn ? "（局域网开放·临时）" : ""}`,
				`本会话地址：${myUrl()}`,
				`会话列表页：http://localhost:${port}/?token=${cfg.token}`,
			];
			if (lanOn) lines.push(`局域网地址：${lanUrl()}`);
			lines.push(
				`端口：${port}`,
				``,
				`命令：/webui on|off | port <n> | token | restart；/webui-lan 临时开放局域网`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// 局域网开放：独立命令、无参数——执行即开启，退出/重载自动关闭（不设关闭参数，避免状态管理）
	pi.registerCommand("webui-lan", {
		description: "临时开放局域网访问（本次运行有效，退出自动关闭）",
		handler: async (_args, ctx) => {
			if (!cfg.enabled) {
				ctx.ui.notify("WebUI 已停用，请先 /webui on", "error");
				return;
			}
			if (role === "relay") {
				ctx.ui.notify("本会话为从模式（不监听端口），请在主会话执行 /webui-lan", "warning");
				return;
			}
			if (lanOn) {
				ctx.ui.notify(`局域网访问已开启：${lanUrl()}\n（临时状态，pi 退出自动关闭）`, "info");
				return;
			}
			lanOn = true; // 临时状态：不写配置文件，进程退出自动失效
			stopAll();
			await startService((t) => ctx.ui.notify(t, "info"));
			ctx.ui.notify(`局域网访问已开启（仅本次运行，退出自动关闭）：${lanUrl()}\n注意：token 即访问凭据，勿泄露`, "warning");
		},
	});
}
