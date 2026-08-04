import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 自定义 Provider 示例（OpenAI-compatible + API key）
 *
 * 支持：
 * - /login my-provider 保存 API key 到 ~/.pi/agent/auth.json
 * - 直接设置环境变量 MY_PROVIDER_API_KEY 也能用
 * - 使用 OpenAI Chat Completions API 协议
 *
 * 测试：
 *   pi -e ./.pi/extensions/my-provider.ts
 *   /login my-provider
 *   /model my-provider/my-model
 *
 * 如果你需要 OAuth 或自定义 streaming，告诉我，我可以再给你一份模板。
 */

export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-provider", {
    name: "My Provider",
    baseUrl: "https://api.my-provider.com/v1",

    // 环境变量 fallback：如果 /login 没存，会尝试读这个环境变量
    apiKey: "$MY_PROVIDER_API_KEY",

    // OpenAI Chat Completions 协议
    api: "openai-completions",

    models: [
      {
        id: "my-model",
        name: "My Model",
        reasoning: false, // 改为 true 如果支持推理/extended thinking
        input: ["text"], // 支持图片的话加上 "image"
        cost: {
          input: 0.5, // 每百万 token 美元
          output: 1.5,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
