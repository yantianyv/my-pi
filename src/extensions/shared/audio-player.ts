/**
 * shared/audio-player：跨平台音频播放的统一封装
 *
 * Windows PowerShell SoundPlayer、macOS afplay、Linux paplay→aplay（status-beacon 与
 * mimo-omni 共用）。各平台候选按优先级排列，逐个尝试，全部失败或抛错由调用方兜底。
 * 消费方需要自己的错误策略（beacon 静默退终端响铃、mimo 报错给人），故本模块只做
 * 拼装与播放，不做兜底。
 */

/** 各平台的播放器候选，按优先级排列 */
const PLAYERS: Record<string, Array<{ cmd: string; args: (file: string) => string[] }>> = {
	win32: [
		{ cmd: "powershell", args: (f) => ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${f}').PlaySync()`] },
	],
	darwin: [
		{ cmd: "afplay", args: (f) => [f] }, // macOS 自带
	],
	linux: [
		{ cmd: "paplay", args: (f) => [f] }, // PulseAudio / PipeWire
		{ cmd: "aplay", args: (f) => [f] }, // ALSA
	],
};

export interface PlayerRun {
	/** 单个播放器命令与参数（目标文件已拼好） */
	cmd: string;
	args: string[];
	/** 当前平台是否还有下一个候选（首个候选失败时换下一个再试） */
	next: () => PlayerRun | null;
}

/** 取当前平台的首个播放器候选；平台无候选返回 null（由调用方走自己的兜底） */
export function firstPlayerFor(file: string): PlayerRun | null {
	const candidates = PLAYERS[process.platform] ?? [];
	const at = (i: number): PlayerRun | null =>
		i >= candidates.length
			? null
			: { cmd: candidates[i].cmd, args: candidates[i].args(file), next: () => at(i + 1) };
	return at(0);
}
