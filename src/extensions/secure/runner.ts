/**
 * secure / runner.ts — 带凭据的命令执行内核
 *
 * 本插件要执行的三类命令，差别只在「凭据从哪来」，执行与结果处理完全一样：
 *   bash 审核通过后的普通执行 → 无凭据；
 *   sudo_exec                → 用户当场输入的密码；
 *   secret_run                → 库里的值（经环境变量，不进 argv）。
 *
 * 统一收在这里的好处是出口只有一处：结果文本在返回前统一过一遍回遮，任何执行通道
 * 都不可能绕过去。密码只经 stdin 进 sudo，永不进 argv、不进结果、不落盘。
 */
import { spawn } from "node:child_process";

/** 单次执行输出上限（超了截断并标注）：够看清错误，又不至于把上下文塞满 */
const OUTPUT_CAP = 256 * 1024;
/** sudo 认证失败的错误特征 */
const SUDO_AUTH_FAIL_RE = /(?:incorrect password|Sorry, try again|no password was provided)/i;
/** sudoers 配置 requiretty 的错误特征 */
const SUDO_REQUIRETTY_RE = /must have a tty to run sudo|sorry, you must have a tty/i;

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
	/** 执行器本身不可用（命令没跑起来），重试无意义 */
	fatal: string | null;
	/** 认证失败（sudo 密码错误），可换密码重试 */
	authFailed: boolean;
}

export interface RunOptions {
	cwd?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** 附加环境变量（secret_run 用它注入展开后的值） */
	env?: NodeJS.ProcessEnv;
}

/**
 * 执行一条 shell 命令（不涉及提权）。值经 env 传入子进程，不出现在命令行参数里，
 * 因此 `ps aux` 看不到。
 */
export function runCommand(command: string, options: RunOptions): Promise<RunResult> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("bash", ["-c", command], {
				cwd: options.cwd,
				env: options.env ? { ...process.env, ...options.env } : process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			resolve(fatalResult(`命令启动失败：${e instanceof Error ? e.message : String(e)}`));
			return;
		}
		collect(child, options, resolve, null);
	});
}

/**
 * 以 root 执行一条命令。password=null 表示走免密路径（NOPASSWD 账户，-n）。
 *
 * -k 是关键语义：忽略且不更新凭据缓存，所以每次授权天然仅当次有效；
 * 收尾再补一发 `sudo -k` 双保险（兼容不遵守该语义的老 sudo）。
 */
export function runSudo(command: string, password: string | null, options: RunOptions): Promise<RunResult> {
	return new Promise((resolve) => {
		const args = password == null ? ["-kn", "--", "bash", "-c", command] : ["-kS", "-p", "", "--", "bash", "-c", command];
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("sudo", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
		} catch (e) {
			resolve(fatalResult(`sudo 启动失败：${e instanceof Error ? e.message : String(e)}`));
			return;
		}
		if (password != null && child.stdin) {
			child.stdin.on("error", () => {}); // EPIPE（sudo 提前退出）
			child.stdin.write(`${password}\n`);
		}
		child.stdin?.end();
		collect(child, options, resolve, password);
	});
}

/** 免密判定：`sudo -kn true` 成功即 NOPASSWD 账户（-k 防止用户终端的缓存造成误判） */
export function hasPasswordlessSudo(): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("sudo", ["-kn", "true"], { stdio: "ignore" });
		} catch {
			resolve(false);
			return;
		}
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}

// ---------------------------------------------------------------------------

function fatalResult(message: string): RunResult {
	return { code: null, stdout: "", stderr: "", timedOut: false, truncated: false, fatal: message, authFailed: false };
}

/** 收输出、挂超时与中断，收尾清理凭据缓存 */
function collect(
	child: ReturnType<typeof spawn>,
	options: RunOptions,
	resolve: (result: RunResult) => void,
	sudoPassword: string | null,
): void {
	let stdout = "";
	let stderr = "";
	let truncated = false;
	let timedOut = false;
	let settled = false;

	const finish = (result: RunResult): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		resolve({ ...result, stdout, stderr, timedOut, truncated });
	};

	const onAbort = (): void => {
		child.kill("SIGTERM");
	};
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.();
	}, options.timeoutMs);

	options.signal?.addEventListener("abort", onAbort, { once: true });

	child.stdout?.on("data", (chunk: Buffer) => {
		if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf8");
		else truncated = true;
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf8");
		else truncated = true;
	});
	child.on("error", (e) =>
		finish({
			...fatalResult(`执行器不可用：${e.message}`),
			timedOut,
		}),
	);
	child.on("close", (code) => {
		if (sudoPassword != null) {
			// 双保险：作废可能残留的凭据缓存（不等结果，尽力而为）
			try {
				spawn("sudo", ["-k"], { stdio: "ignore" }).on("error", () => {});
			} catch {
				/* 忽略 */
			}
		}
		if (SUDO_REQUIRETTY_RE.test(stderr)) {
			finish({
				code,
				timedOut,
				truncated,
				stdout,
				stderr,
				authFailed: false,
				fatal: "目标机 sudoers 配置了 requiretty，非交互通道无法供密，只能请用户手动执行",
			});
			return;
		}
		const authFailed = sudoPassword != null && code !== 0 && SUDO_AUTH_FAIL_RE.test(stderr);
		finish({ code, timedOut, truncated, stdout, stderr, authFailed, fatal: null });
	});
}
