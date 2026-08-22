/**
 * webdav-kb / secrets.ts — 上传前 secret 扫描（借鉴 pi-sync 的 secret scanning）
 *
 * 知识库是**会上云**的笔记库：AI 写笔记时可能无意把 API key / token / 私钥带进去。
 * 上传（syncAll 批量上传 / putNote 立即 PUT）前对文本做高精度模式扫描，
 * 命中即拦截远端上传（本地镜像保留），防止密钥泄露到网盘。
 *
 * 设计取舍：模式宁可少而精（低误报），命中的是「确定的密钥格式」而非模糊熵检测；
 * 误伤时用户可在 kb-config.json 加 `"allowSecretUpload": true` 关闭（KbConfig 字段）。
 */

/** 密钥模式表：name 用于拦截提示（告诉用户拦到了什么类型） */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
	// OpenAI / DeepSeek / OpenRouter（sk-or-v1-...）/ Anthropic（sk-ant-...）等同族 sk- 前缀
	{ name: "API key（sk-…）", re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
	// AWS Access Key ID
	{ name: "AWS Access Key（AKIA…）", re: /\bAKIA[0-9A-Z]{16}\b/ },
	// GitHub 各型 token（personal/oauth/server-to-server/fine-grained）
	{ name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
	// JWT（header.payload.signature 三段，eyJ 是 {" 的 base64 特征头）
	{ name: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
	// PEM 私钥块
	{ name: "私钥块", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
	// Slack token
	{ name: "Slack token（xox…）", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
	// 通用赋值形态：api_key/secret/token/password = "长串"（变量名 + 引号包裹的高确定性形态）
	{
		name: "密钥赋值（api_key/token/secret = \"…\"）",
		re: /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_+\/.=-]{16,}["']/i,
	},
];

/**
 * 扫描文本中的疑似密钥，返回命中的类型名列表（去重）；未命中返回空数组。
 * 仅用于文本笔记（md/txt/json/yaml 等）；二进制/LFS 不扫。
 */
export function scanSecrets(text: string): string[] {
	const hits = new Set<string>();
	for (const { name, re } of SECRET_PATTERNS) {
		if (re.test(text)) hits.add(name);
	}
	return [...hits];
}
