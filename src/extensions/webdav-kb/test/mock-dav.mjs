/**
 * webdav-kb / test/mock-dav.mjs — 内存版 WebDAV 服务器（测试共用）
 *
 * Node http 内置实现 PROPFIND/GET/PUT/MKCOL/DELETE/MOVE + Basic 认证，挂在
 * 指定前缀（默认 /dav）下——模拟真实服务器的「base 前缀」。响应 XML 用 d:/lp1:
 * 双命名空间前缀（模仿 Nextcloud/Apache mod_dav），考验客户端正则解析健壮性。
 *
 * 用法：
 *   const dav = await startMockDav({ user, pass, prefix });
 *   dav.baseUrl  // http://127.0.0.1:PORT/dav
 *   dav.store    // Map，键=服务器绝对路径（无尾斜杠，根=prefix）——测试可直接注入/篡改远端状态
 *   dav.close()
 */
import { createHash } from "node:crypto";
import * as http from "node:http";

export async function startMockDav({ user = "test-user", pass = "test-pass", prefix = "/dav" } = {}) {
	const store = new Map(); // 键 = 服务器绝对路径（无尾斜杠；根 = prefix）；值 = {data|isDir, etag, mtime}
	store.set(prefix, { isDir: true, mtime: new Date().toUTCString() });

	const norm = (p) => {
		let s = p;
		while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
		return s || prefix;
	};
	const childKeys = (dirKey) => {
		const pre = dirKey + "/";
		return [...store.keys()].filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes("/"));
	};
	const propXml = (key) => {
		const e = store.get(key);
		const isDir = e.isDir;
		const href = key === prefix ? prefix + "/" : key + (isDir ? "/" : "");
		const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		let out = `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>`;
		if (!isDir) {
			out += `<lp1:getcontentlength>${e.data.length}</lp1:getcontentlength>`;
			out += `<lp1:getetag>"${e.etag}"</lp1:getetag>`;
		}
		out += `<lp1:getlastmodified>${e.mtime}</lp1:getlastmodified>`;
		if (isDir) out += `<d:resourcetype><d:collection/></d:resourcetype>`;
		out += `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
		return out;
	};

	const server = http.createServer((req, res) => {
		const expect = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
		if ((req.headers.authorization || "") !== expect) {
			res.writeHead(401, { "WWW-Authenticate": 'Basic realm="mock-dav"' });
			res.end();
			return;
		}
		let path;
		try {
			path = decodeURIComponent(new URL(req.url, "http://x").pathname);
		} catch {
			path = req.url.split("?")[0];
		}
		const key = norm(path);
		const entry = store.get(key);
		const send = (status, body, headers = {}) => {
			res.writeHead(status, { "Content-Type": "text/xml; charset=utf-8", ...headers });
			res.end(body);
		};

		switch (req.method) {
			case "PROPFIND": {
				if (!entry) return send(404, "");
				const depth = req.headers.depth ?? "0";
				const keys = [key];
				if (depth === "1" && entry.isDir) keys.push(...childKeys(key));
				const xml =
					`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:lp1="DAV:">\n` +
					keys.map(propXml).join("\n") +
					`\n</d:multistatus>`;
				return send(207, xml);
			}
			case "GET": {
				if (!entry) return send(404, "not found");
				if (entry.isDir) return send(405, "is a directory");
				return send(200, entry.data, {
					ETag: `"${entry.etag}"`,
					"Last-Modified": entry.mtime,
					"Content-Type": "text/markdown; charset=utf-8",
				});
			}
			case "PUT": {
				const parent = norm(key.slice(0, key.lastIndexOf("/")) || prefix);
				if (!store.has(parent) || !store.get(parent).isDir) return send(409, "parent missing");
				const chunks = [];
				req.on("data", (c) => chunks.push(c));
				req.on("end", () => {
					const data = Buffer.concat(chunks);
					const ifMatch = req.headers["if-match"];
					if (ifMatch && entry && `"${entry.etag}"` !== ifMatch && ifMatch !== "*") {
						return send(412, "etag mismatch");
					}
					const mtime = new Date().toUTCString();
					const etag = createHash("md5").update(data).update(mtime).digest("hex").slice(0, 16);
					store.set(key, { data, etag, mtime, isDir: false });
					return send(201, "", { ETag: `"${etag}"` });
				});
				return;
			}
			case "MKCOL": {
				if (entry) return send(405, "exists");
				const parent = norm(key.slice(0, key.lastIndexOf("/")) || prefix);
				if (!store.has(parent) || !store.get(parent).isDir) return send(409, "parent missing");
				store.set(key, { isDir: true, mtime: new Date().toUTCString() });
				return send(201, "");
			}
			case "DELETE": {
				if (!entry) return send(404, "not found");
				for (const k of [...store.keys()]) {
					if (k === key || k.startsWith(key + "/")) store.delete(k);
				}
				return send(204, "");
			}
			case "MOVE": {
				const destPath = decodeURIComponent(new URL(req.headers.destination, "http://x").pathname);
				const destKey = norm(destPath);
				if (!entry) return send(404, "not found");
				for (const k of [...store.keys()]) {
					if (k === key || k.startsWith(key + "/")) {
						const moved = store.get(k);
						store.delete(k);
						store.set(destKey + k.slice(key.length), moved);
					}
				}
				return send(201, "");
			}
			default:
				return send(405, "");
		}
	});
	const addr = { port: 0 };
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			addr.port = server.address().port;
			resolve({
				baseUrl: `http://127.0.0.1:${addr.port}${prefix}`,
				close: () => server.close(),
				store,
				prefix,
				// 便捷注入：远端文件/目录（content 传 Buffer 或字符串；etag 缺省按内容生成），
				// 自动补齐父目录链（与真实服务器的“隐式目录”一致）
				seed(path, content, { isDir = false, etag } = {}) {
					const segs = String(path)
						.split("/")
						.filter(Boolean);
					const mtime = new Date().toUTCString();
					for (let i = 0; i < segs.length - 1; i++) {
						const dirKey = norm(prefix + "/" + segs.slice(0, i + 1).join("/"));
						if (!store.has(dirKey)) store.set(dirKey, { isDir: true, mtime });
					}
					const key = norm(prefix + "/" + segs.join("/"));
					if (isDir) {
						if (!store.has(key)) store.set(key, { isDir: true, mtime });
						return;
					}
					const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
					const tag = etag ?? createHash("md5").update(data).update(mtime).digest("hex").slice(0, 16);
					store.set(key, { data, etag: tag, mtime, isDir: false });
				},
			});
		});
	});
}
