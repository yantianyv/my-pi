# 自定义 Provider 扩展

这个目录下的 `my-provider.ts` 是一个 pi extension，用来向 pi 注册一个新的模型 provider。

## 适用场景

- 你要接入一个 **OpenAI-compatible** 的 API（`/v1/chat/completions`）
- 使用 **API key** 认证
- 不需要自己写 streaming 逻辑

如果你需要 OAuth、自定义协议、非 OpenAI 的 API，或自定义 reasoning/thinking 映射，参考 pi 官方文档：
`C:/Users/yanti/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`

## 快速使用

### 1. 修改 `my-provider.ts`

把下面这几个占位符改成你 provider 的真实信息：

| 字段 | 说明 |
|------|------|
| `id` | provider 唯一标识，会出现在 `/login` 和 `/model` 里 |
| `name` | 显示名称 |
| `baseUrl` | API 基础地址，通常是 `https://api.xxx.com/v1` |
| `apiKey` | 环境变量名，如 `$MY_PROVIDER_API_KEY` |
| `models` | 模型列表，按实际情况填写 id/name/contextWindow/maxTokens/cost |

### 2. 临时测试

```bash
cd C:/Projects/开发工具/my_pi
pi -e ./.pi/extensions/my-provider.ts
```

启动后：

```
/login my-provider
/model my-provider/my-model
```

### 3. 让 pi 自动加载（推荐）

把这个目录放到 pi 会自动发现的位置：

- **全局可用**：`~/.pi/agent/extensions/my-provider/`
- **当前项目可用**：`.pi/extensions/`（已经在当前项目里了）

目录结构示例：

```
.pi/extensions/my-provider/
├── index.ts
└── package.json          # 如果需要 npm 依赖再加
```n
如果你不需要额外 npm 依赖，像现在这样只放 `my-provider.ts` 也可以。

## 认证方式

### 方式 A：通过 `/login` 保存 API key（推荐）

在 pi 里运行：

```
/login my-provider
```

会提示输入 API key，保存到 `~/.pi/agent/auth.json`。

### 方式 B：环境变量

启动时设置：

```bash
MY_PROVIDER_API_KEY=sk-xxx pi
```

或者在 shell 配置文件里永久设置。

### 方式 C：直接写死（不推荐）

把 `apiKey: "$MY_PROVIDER_API_KEY"` 改成明文：

```ts
apiKey: "sk-xxx",
```

会泄露密钥，只在你本地临时测试时使用。

## 常用 `api` 类型

| api 值 | 说明 |
|--------|------|
| `openai-completions` | OpenAI Chat Completions，最常用 |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Gemini |
| `google-vertex` | Google Vertex AI |
| `mistral-conversations` | Mistral SDK |
| `azure-openai-responses` | Azure OpenAI |
| `openai-codex-responses` | OpenAI Codex |
| `bedrock-converse-stream` | AWS Bedrock |

## 验证是否注册成功

```bash
MY_PROVIDER_API_KEY=fake-key pi -e ./.pi/extensions/my-provider.ts --list-models
```

如果看到 `my-provider/my-model`，说明注册成功。

## 支持图片或多模态

把 `input: ["text"]` 改成：

```ts
input: ["text", "image"],
```

## 支持 reasoning/extended thinking

把 `reasoning: false` 改成 `true`，并可加 `thinkingLevelMap`：

```ts
reasoning: true,
thinkingLevelMap: {
  medium: "default",
  high: "max",
},
```

具体 map 值取决于你的 provider API。
