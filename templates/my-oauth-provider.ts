import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

/**
 * 自定义 OAuth Provider 示例
 *
 * 支持 /login my-oauth-provider，走 OAuth 流程。
 * 凭证（access token / refresh token）会保存到 ~/.pi/agent/auth.json。
 *
 * 这是一个模板，你需要替换 CLIENT_ID、authorize URL、token URL 和实际 token 交换逻辑。
 */

const CLIENT_ID = "your-client-id";
const AUTHORIZE_URL = "https://sso.example.com/oauth/authorize";
const TOKEN_URL = "https://sso.example.com/oauth/token";
const REDIRECT_URI = "http://127.0.0.1:8080/callback";

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return { verifier, challenge };
}

async function loginMyOAuth(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();

  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "api",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: crypto.randomUUID(),
  });

  // 打开浏览器或显示 URL
  callbacks.onAuth({ url: `${AUTHORIZE_URL}?${authParams.toString()}` });

  // 等待用户粘贴回调 URL 或 authorization code
  const callbackUrl = await callbacks.onPrompt({ message: "Paste the callback URL or authorization code:" });

  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("No authorization code found");

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
  }

  const data = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

async function refreshMyOAuthToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: credentials.refresh,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token ?? credentials.refresh,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-oauth-provider", {
    name: "My OAuth Provider",
    baseUrl: "https://api.my-oauth-provider.com/v1",
    api: "openai-completions",
    models: [
      {
        id: "my-oauth-model",
        name: "My OAuth Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    oauth: {
      name: "My OAuth Provider",
      login: loginMyOAuth,
      refreshToken: refreshMyOAuthToken,
      getApiKey: (credentials) => credentials.access,
    },
  });
}
