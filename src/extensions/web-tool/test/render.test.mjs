#!/usr/bin/env node
/**
 * web_fetch 渲染兜底回归测试（判定函数 + 引擎 + fetch 接入）
 *
 * 用法：node src/extensions/web-tool/test/render.test.mjs
 *   需要本机有 Chromium（ms-playwright 缓存，或用 PI_WEB_RENDER_CHROME 指定）；没有浏览器的机器会跳过
 *   渲染类场景，判定函数与「不触发渲染」类场景仍照常断言。
 *
 * 原理与覆盖：
 * - esbuild 现场 bundle 一个临时入口（同时 re-export fetch.ts 与 render-cdp.ts），因此两个模块在测试里
 *   共用同一份模块状态——两个独立 bundle 会各起一个浏览器、共用同一持久化 profile，导航会被拖到 1.5s
 *   （profile 争用），测试本身就会踩到生产上的坑。产物 .tmp-* 由 .gitignore 忽略。
 * - 本地 node:http 起假站，全程不出网；profile 目录用 PI_WEB_RENDER_PROFILE 指向临时目录，
 *   不碰真实 ~/.pi/agent/web-render-profile。
 * - 场景 A~H：
 *   A 触发判定（HTML 厚正文薄 / 挂载点标记 / 静态长文不触发）
 *   B 壳页：fetchAsMarkdown 自动兜底渲染出 JS 注入的正文，rendered=true、回执带渲染说明、状态行有提示
 *   C 静态长文页：不启动浏览器（用锁文件是否生成来判定，不靠耗时）
 *   D 渲染启动失败（浏览器路径不可执行）：静默回落 + 极短正文警示，不抛错
 *   E 渲染结果更长时采用（短横幅正文）
 *   F 永不 complete 的页面：预算内返回，不挂死
 *   G profile 锁：另一会话持锁 → 回退临时 profile；陈旧锁不阻挡；关闭后释放
 *   H 空闲回收后自动重启；shutdownRenderer 幂等；分段耗时齐全
 *   I 反爬挑战页：报错带下一步指引，且不浪费一次渲染
 *   J 启动参数拼装（代理 / profile / headless，纯函数，不启浏览器）
 *   K 并发渲染各拿各的页面（独占标签页；共用一个页时实测会拿到对方的正文）
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..", ".."); // src/
const ENTRY = path.join(HERE, ".tmp-render-entry.ts");
const BUNDLE = path.join(HERE, ".tmp-render-entry.mjs");

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// 假站：壳页（JS 注入）/ 静态长文 / 渲染后只有短横幅 / 永不完成
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	const send = (body, type = "text/html; charset=utf-8") => {
		res.writeHead(200, { "content-type": type });
		res.end(body);
	};
	if (url.pathname === "/shell") {
		send(`<!DOCTYPE html><html><head><title>壳页标题</title></head><body><div id="root"></div>
<script>setTimeout(() => { document.getElementById("root").innerHTML =
  "<h1>渲染后的标题</h1><p>" + "渲染注入的正文段落。".repeat(30) + "</p>"; }, 200);</script></body></html>`);
	} else if (url.pathname === "/static") {
		send(`<!DOCTYPE html><html><head><title>静态页</title></head><body><article><p>${"静态正文。".repeat(80)}</p></article></body></html>`);
	} else if (url.pathname === "/banner") {
		send(`<!DOCTYPE html><html><head><title>横幅页</title></head><body><div id="root"></div>
<script>setTimeout(() => { document.getElementById("root").textContent = "请下载 App 继续阅读"; }, 100);</script></body></html>`);
	} else if (url.pathname === "/hang") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.write("<html><body><p>加载中");
	} else if (url.pathname === "/challenge") {
		send(`<!DOCTYPE html><html><head><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></head><body></body></html>`);
	} else if (url.pathname === "/conc-a") {
		// 延迟 1.5s 才写入自己的标记：与立即写入的 /conc-b 并发时，共用标签页的实现在这里会串页
		send(`<!DOCTYPE html><html><body><div id="root"></div>
<script>setTimeout(() => { document.getElementById("root").innerHTML = "<p>" + "AAAA-MARKER ".repeat(40) + "</p>"; }, 1500);</script></body></html>`);
	} else if (url.pathname === "/conc-b") {
		send(`<!DOCTYPE html><html><body><div id="root"></div>
<script>document.getElementById("root").innerHTML = "<p>" + "BBBB-MARKER ".repeat(40) + "</p>";</script></body></html>`);
	} else {
		send(`<!DOCTYPE html><html><body><p>${"普通正文。".repeat(30)}</p></body></html>`);
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// 单入口构建：fetch 与 render-cdp 共用一份模块状态
// ---------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), "web-fetch-render-"));
process.env.PI_WEB_RENDER_PROFILE = path.join(work, "profile");
fs.writeFileSync(
	ENTRY,
	[
		`export * from ${JSON.stringify(path.relative(HERE, path.join(SRC, "extensions", "web-tool", "fetch.ts")).replace(/\\/g, "/"))};`,
		`export * from ${JSON.stringify(path.relative(HERE, path.join(SRC, "extensions", "web-tool", "render-cdp.ts")).replace(/\\/g, "/"))};`,
	].join("\n"),
);
await build({
	entryPoints: [ENTRY],
	outfile: BUNDLE,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	external: ["@earendil-works/*", "typebox"],
	tsconfig: path.join(SRC, "config", "tsconfig.build.json"),
	logLevel: "silent",
});
const mod = await import(pathToFileURL(BUNDLE).href);

/** 锁文件是否存在 = 本次是否真的起过浏览器（比耗时判定稳定） */
const lockFile = () => path.join(mod.profileDir(), ".pi-render.lock");
const lockExists = () => fs.existsSync(lockFile());
/** 造一个「存在但不可执行」的浏览器路径，用来验证启动失败时的回落 */
const FAKE_CHROME = path.join(work, "not-a-browser.txt");
fs.writeFileSync(FAKE_CHROME, "not a browser");
const realChrome = mod.findChromePath();
const hasChrome = realChrome !== null;

try {
	// ---- A 触发判定（纯函数） ----
	check("A1 正文极短 → 触发渲染", mod.looksLikeUnrenderedShell("<html><body></body></html>", "") === true);
	check("A2 静态长文 → 不触发", mod.looksLikeUnrenderedShell("<html><body>x</body></html>", "很长".repeat(200)) === false);
	check(
		"A3 HTML 厚正文薄 → 触发",
		mod.looksLikeUnrenderedShell(`<html><body><div id="root"></div>${"<script>x</script>".repeat(900)}</body></html>`, "两百个字符的正文".repeat(10)) === true,
	);
	check("A4 挂载点标记 + 中量正文 → 触发", mod.looksLikeUnrenderedShell('<html><body><div id="app"></div></body></html>', "正文".repeat(150)) === true);
	check("A5 无标记的中量正文 → 不触发", mod.looksLikeUnrenderedShell("<html><body><div class=x></div></body></html>", "正文".repeat(150)) === false);

	// ---- J 启动参数拼装（纯函数：有代理/无代理/profile/headless） ----
	const argsProxy = mod.buildLaunchArgs({ profile: "P", proxyUrl: "http://127.0.0.1:10808" });
	const argsPlain = mod.buildLaunchArgs({ profile: "P" });
	check("J1 有代理时带 --proxy-server", argsProxy.includes("--proxy-server=http://127.0.0.1:10808"));
	check("J2 无代理时不带", !argsPlain.some((a) => a.startsWith("--proxy-server")));
	check("J3 空代理值不拼空参数", !mod.buildLaunchArgs({ profile: "P", proxyUrl: "" }).some((a) => a.startsWith("--proxy-server")));
	check("J4 profile 与调试端口照传", argsPlain.includes("--user-data-dir=P") && argsPlain.includes("--remote-debugging-port=0"));
	check("J5 默认 headless，headless:false 时不带", argsPlain.includes("--headless") && !mod.buildLaunchArgs({ profile: "P", headless: false }).includes("--headless"));

	// ---- C 静态长文页不启动浏览器 ----
	await mod.shutdownRenderer();
	fs.rmSync(lockFile(), { force: true });
	const staticRes = await mod.fetchAsMarkdown(`${base}/static`, 12_000);
	check("C1 静态页正文照常提取", staticRes.markdown.includes("静态正文"));
	check("C2 静态页没有渲染过", staticRes.rendered === false && staticRes.renderNote === "");
	check("C3 静态页没启动浏览器", !lockExists());

	// ---- I 反爬挑战页：报错给下一步指引，且不白白渲染一次 ----
	let challengeMsg = "";
	try {
		await mod.fetchAsMarkdown(`${base}/challenge`, 12_000);
	} catch (e) {
		challengeMsg = e instanceof Error ? e.message : String(e);
	}
	check("I1 挑战页报错含下一步指引", challengeMsg.includes("换源") && challengeMsg.includes("/web-render-login"), challengeMsg);
	check("I2 挑战页不触发渲染", !lockExists());

	if (!hasChrome) {
		console.log(`… 本机没有可用的 Chromium（PI_WEB_RENDER_CHROME=${process.env.PI_WEB_RENDER_CHROME ?? "未设"}），跳过渲染类场景 B/E/F/G/H`);
	} else {
		// ---- B 壳页自动兜底：本次改动的目标行为 ----
		const progress = [];
		const shellRes = await mod.fetchAsMarkdown(`${base}/shell`, 12_000, undefined, (t) => progress.push(t));
		check("B1 壳页被渲染兜底", shellRes.rendered === true, shellRes.renderNote);
		check("B2 正文来自 JS 注入", shellRes.markdown.includes("渲染注入的正文段落。"));
		check("B3 回执带渲染说明", /(持久化|临时) profile，\d+ms/.test(shellRes.renderNote));
		check("B4 渲染前推了状态行", progress.some((t) => t.includes("渲染中")));
		check("B5 极短正文警示不再出现", !shellRes.markdown.includes("页面正文极短"));
		check("B6 渲染时用了持久化 profile", lockExists());

		// ---- E 渲染结果更长时采用（短横幅正文） ----
		const banner = await mod.fetchAsMarkdown(`${base}/banner`, 12_000);
		check("E1 渲染后的短横幅正文被采用", banner.markdown.includes("请下载 App 继续阅读"));

		// ---- K 并发渲染：各拿各的页面（共用标签页时会互相抢导航） ----
		const [concA, concB] = await Promise.all([
			mod.renderPage(`${base}/conc-a`, { quietMs: 300, timeoutMs: 15_000 }),
			mod.renderPage(`${base}/conc-b`, { quietMs: 300, timeoutMs: 15_000 }),
		]);
		check("K1 并发 A 拿到自己的正文", concA.html.includes("AAAA-MARKER"), concA.finalUrl);
		check("K2 并发 A 的 finalUrl 是 A", concA.finalUrl.endsWith("/conc-a"));
		check("K3 并发 B 拿到自己的正文", concB.html.includes("BBBB-MARKER"), concB.finalUrl);
		check("K4 并发 B 的 finalUrl 是 B", concB.finalUrl.endsWith("/conc-b"));
		check("K5 A 没串到 B 的内容", !concA.html.includes("BBBB-MARKER"));
		check("K6 并发走独占标签页", typeof concA.phases.target === "number" && typeof concB.phases.target === "number");

		// ---- F 永不 complete 的页面 ----
		const t0 = Date.now();
		const hang = await mod.renderPage(`${base}/hang`, { timeoutMs: 3000, quietMs: 400 });
		const hangMs = Date.now() - t0;
		check("F1 超时页面在预算内返回", hangMs < 8000, `${hangMs}ms`);
		check("F2 超时也返回已渲染 DOM", hang.html.includes("加载中"));

		// ---- G profile 锁 ----
		await mod.shutdownRenderer();
		fs.mkdirSync(mod.profileDir(), { recursive: true });
		const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
		await new Promise((resolve) => setTimeout(resolve, 600));
		fs.writeFileSync(lockFile(), JSON.stringify({ pid: holder.pid, at: Date.now() }));
		const concurrent = await mod.renderPage(`${base}/static`, { quietMs: 300 });
		check("G1 另一会话持锁时仍能渲染", concurrent.html.includes("静态正文"));
		check("G2 已回退到临时 profile", concurrent.persistent === false);
		holder.kill();
		await mod.shutdownRenderer();
		fs.writeFileSync(lockFile(), JSON.stringify({ pid: 999999, at: Date.now() }));
		const stale = await mod.renderPage(`${base}/static`, { quietMs: 300 });
		check("G3 陈旧锁不阻挡持久化 profile", stale.persistent === true);
		await mod.shutdownRenderer();
		check("G4 关闭后释放锁", !lockExists());

		// ---- H 空闲回收与幂等 ----
		mod.scheduleIdleClose(400);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await mod.shutdownRenderer();
		await mod.shutdownRenderer();
		const after = await mod.renderPage(`${base}/static`, { quietMs: 300 });
		check("H1 空闲回收后自动重启", after.html.includes("静态正文"));
		check("H2 分段耗时齐全", ["launch", "target", "navigate", "settle", "grab"].every((k) => typeof after.phases[k] === "number"), JSON.stringify(after.phases));
		check("H3 复用会话时不再重新启动（launch 接近 0）", await mod.renderPage(`${base}/static`, { quietMs: 300 }).then((r) => r.phases.launch < 50));
		await mod.shutdownRenderer();
	}

	// ---- D 浏览器不可用时的行为（不需要真浏览器，放在最后避免污染上面的会话） ----
	process.env.PI_WEB_RENDER_CHROME = path.join(work, "no-such-chrome");
	check("D1 不存在的浏览器路径 → 视为没有浏览器", mod.rendererReady() === false);
	const noChromeRes = await mod.fetchAsMarkdown(`${base}/shell`, 12_000);
	check("D2 没有浏览器时静默回落", noChromeRes.rendered === false && noChromeRes.markdown.includes("页面正文极短"));

	// 存在但不可执行：rendererReady 为真，真正启动才失败——验证启动失败也能静默回落
	process.env.PI_WEB_RENDER_CHROME = FAKE_CHROME;
	await mod.shutdownRenderer();
	check("D3 存在但不可执行的路径仍视为可用（交由启动失败处理）", mod.rendererReady() === true);
	const fakeRes = await mod.fetchAsMarkdown(`${base}/shell`, 12_000);
	check("D4 启动失败不抛错、不污染结果", fakeRes.rendered === false && typeof fakeRes.markdown === "string");
	check("D5 启动失败仍给极短正文警示", fakeRes.markdown.includes("页面正文极短"));
} finally {
	await mod.shutdownRenderer().catch(() => {});
	server.close();
	for (const f of [ENTRY, BUNDLE]) {
		try {
			// 用 unlinkSync：fs.rmSync 在含中文的路径下会静默不删（本仓库路径含「开发工具」），留下临时 bundle 会干扰下次判断
			fs.unlinkSync(f);
		} catch {
			/* 忽略 */
		}
	}
	try {
		fs.rmSync(work, { recursive: true, force: true });
	} catch {
		/* 忽略 */
	}
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
