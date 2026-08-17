/**
 * 共享网络工具：超时信号工厂 + HTTP 代理 CONNECT 隧道
 *
 * 原先 web-tool/http.ts 与 webdav-kb/client.ts 各自维护一份逐字相同的实现
 * （webdav-kb 注释标注「web-tool 同款」），现收敛到此模块，由 build.js 内联进各产物。
 *
 * 使用方：web-tool（直连/代理/curl 竞速）、webdav-kb（WebDAV 传输层）。
 */
import * as net from "node:net";
import * as tls from "node:tls";

/** 创建带超时 + 外部取消监听的 AbortController；cleanup 清定时器并摘除外部监听（幂等） */
export function makeTimeoutSignal(
	timeoutMs: number,
	outerSignal?: AbortSignal,
): { controller: AbortController; cleanup: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	outerSignal?.addEventListener("abort", onAbort);
	return {
		controller,
		cleanup: () => {
			clearTimeout(timer);
			outerSignal?.removeEventListener("abort", onAbort);
		},
	};
}

/** 为 http/https.request 提供 createConnection：经 HTTP 代理建 CONNECT 隧道（TLS 目标再套 tls） */
export function makeProxyConnection(
	targetUrl: string,
	proxyUrl: string,
): (opts: unknown, cb: (err: Error | null, socket?: any) => void) => undefined {
	const target = new URL(targetUrl);
	const proxy = new URL(proxyUrl);
	if (proxy.protocol !== "http:") throw new Error(`仅支持 http:// 代理，收到 ${proxy.protocol}//`);
	const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
	const proxyPort = Number(proxy.port || 80);
	return (_opts, cb) => {
		const socket = net.connect(proxyPort, proxy.hostname);
		const onError = (e: Error) => {
			socket.removeListener("data", onData);
			cb(e);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			socket.write(`CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n\r\n`);
		});
		let buf = "";
		const onData = (chunk: Buffer) => {
			buf += chunk.toString("latin1");
			const idx = buf.indexOf("\r\n\r\n");
			if (idx < 0) return;
			socket.removeListener("data", onData);
			socket.removeListener("error", onError);
			const m = /^HTTP\/\d+\.\d+\s+(\d+)/.exec(buf.slice(0, idx));
			if (!m || Number(m[1]) !== 200) {
				socket.destroy();
				cb(new Error(`代理 CONNECT 失败：${m ? `HTTP ${m[1]}` : "响应无法解析"}`));
				return undefined;
			}
			if (target.protocol === "https:") {
				const tlsSocket = tls.connect({ socket, servername: target.hostname });
				tlsSocket.once("secureConnect", () => cb(null, tlsSocket));
				tlsSocket.once("error", (e) => {
					socket.removeListener("error", onError);
					cb(e);
				});
			} else {
				cb(null, socket);
			}
			return undefined;
		};
		socket.on("data", onData);
		return undefined;
	};
}
