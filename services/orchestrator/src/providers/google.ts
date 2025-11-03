import { createSign } from "node:crypto";

import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatMessage, ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import { callWithRetry, coalesceText, ProviderError, requireSecret } from "./utils.js";

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/generative-language";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_EXPIRY_SKEW_MS = 60_000;

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: GeminiUsageMetadata;
  error?: { message?: string };
};

type OAuthTokenRecord = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
};

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type GoogleProviderOptions = {
  defaultModel?: string;
  retryAttempts?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

type GoogleAuth =
  | { type: "apiKey"; apiKey: string }
  | { type: "bearer"; token: string; source: "oauth" | "service-account" };

type OAuthState = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

type CachedServiceAccountToken = {
  accessToken: string;
  expiresAt: number;
};

function toGeminiContents(messages: ChatMessage[]) {
  return messages
    .filter(msg => msg.role !== "system")
    .map(msg => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }]
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class GoogleProvider implements ModelProvider {
  name = "google";
  supportsOAuth = true;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private serviceAccountKeyCache?: { raw: string; key: ServiceAccountKey };
  private serviceAccountToken?: CachedServiceAccountToken;

  constructor(private readonly secrets: SecretsStore, private readonly options: GoogleProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const modelId = req.model ?? this.options.defaultModel ?? "gemini-1.5-flash";
    const auth = await this.resolveAuth();

    const response = await callWithRetry(
      async () => this.invokeGemini(modelId, req.messages, auth),
      { attempts: this.options.retryAttempts ?? 2 }
    );

    const output = coalesceText(response.candidates?.[0]?.content?.parts ?? []);
    if (!output) {
      throw new ProviderError("Google Gemini returned an empty response", {
        status: 502,
        provider: this.name,
        retryable: false
      });
    }

    const usage = response.usageMetadata;

    return {
      output,
      provider: this.name,
      usage: usage
        ? {
            promptTokens: usage.promptTokenCount,
            completionTokens: usage.candidatesTokenCount,
            totalTokens: usage.totalTokenCount
          }
        : undefined
    };
  }

  private async resolveAuth(): Promise<GoogleAuth> {
    const oauthToken = await this.ensureOAuthAccessToken();
    if (oauthToken) {
      return { type: "bearer", token: oauthToken, source: "oauth" };
    }

    const serviceAccountToken = await this.ensureServiceAccountToken();
    if (serviceAccountToken) {
      return { type: "bearer", token: serviceAccountToken, source: "service-account" };
    }

    const apiKey = await requireSecret(this.secrets, this.name, {
      key: "provider:google:apiKey",
      env: "GOOGLE_API_KEY",
      description: "API key"
    });
    return { type: "apiKey", apiKey };
  }

  private async ensureOAuthAccessToken(): Promise<string | undefined> {
    const state = await this.loadOAuthState();
    if (!state) {
      return undefined;
    }
    if (this.isExpired(state.expiresAt)) {
      if (!state.refreshToken) {
        return undefined;
      }
      const refreshed = await this.refreshOAuthToken(state.refreshToken);
      return refreshed?.accessToken;
    }
    return state.accessToken;
  }

  private async loadOAuthState(): Promise<OAuthState | undefined> {
    const storedTokensRaw = await this.secrets.get("oauth:google:tokens");
    let parsed: OAuthTokenRecord | undefined;
    if (storedTokensRaw) {
      try {
        const value = JSON.parse(storedTokensRaw);
        if (isRecord(value) && typeof value.access_token === "string") {
          parsed = value as OAuthTokenRecord;
        }
      } catch {
        // ignore malformed entries
      }
    }

    const accessToken =
      parsed?.access_token ?? (await this.secrets.get("oauth:google:access_token")) ?? undefined;
    if (!accessToken) {
      return undefined;
    }

    const refreshToken =
      parsed?.refresh_token ?? (await this.secrets.get("oauth:google:refresh_token")) ?? undefined;
    const expiresAt =
      typeof parsed?.expires_at === "number"
        ? parsed.expires_at
        : typeof parsed?.expires_in === "number"
          ? this.now() + parsed.expires_in * 1000
          : undefined;

    return { accessToken, refreshToken, expiresAt };
  }

  private async refreshOAuthToken(refreshToken: string): Promise<OAuthState | undefined> {
    const clientId =
      (await this.secrets.get("provider:google:oauthClientId")) ?? process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
    if (!clientId) {
      return undefined;
    }
    const clientSecret =
      (await this.secrets.get("provider:google:oauthClientSecret")) ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId
    });
    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }

    const response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as Partial<OAuthTokenRecord>;
    if (typeof payload.access_token !== "string") {
      return undefined;
    }

    const expiresAt =
      typeof payload.expires_at === "number"
        ? payload.expires_at
        : typeof payload.expires_in === "number"
          ? this.now() + payload.expires_in * 1000
          : undefined;

    const state: OAuthState = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? refreshToken,
      expiresAt
    };

    await this.persistOAuthTokens({
      access_token: state.accessToken,
      refresh_token: state.refreshToken,
      expires_at: state.expiresAt
    });

    return state;
  }

  private async persistOAuthTokens(tokens: OAuthTokenRecord): Promise<void> {
    const entries: Array<Promise<void>> = [
      this.secrets.set("oauth:google:access_token", tokens.access_token),
      this.secrets.set("oauth:google:tokens", JSON.stringify(tokens))
    ];
    if (tokens.refresh_token) {
      entries.push(this.secrets.set("oauth:google:refresh_token", tokens.refresh_token));
    } else {
      entries.push(this.secrets.delete("oauth:google:refresh_token"));
    }
    await Promise.all(entries);
  }

  private async ensureServiceAccountToken(): Promise<string | undefined> {
    const key = await this.loadServiceAccountKey();
    if (!key) {
      return undefined;
    }
    if (!this.serviceAccountToken || this.isExpired(this.serviceAccountToken.expiresAt)) {
      this.serviceAccountToken = await this.requestServiceAccountToken(key);
    }
    return this.serviceAccountToken?.accessToken;
  }

  private async loadServiceAccountKey(): Promise<ServiceAccountKey | undefined> {
    const raw =
      (await this.secrets.get("provider:google:serviceAccount")) ?? process.env.GOOGLE_SERVICE_ACCOUNT ?? "";
    if (!raw) {
      this.serviceAccountKeyCache = undefined;
      return undefined;
    }

    if (this.serviceAccountKeyCache?.raw === raw) {
      return this.serviceAccountKeyCache.key;
    }

    try {
      const parsed = JSON.parse(raw) as ServiceAccountKey;
      if (!parsed || typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
        throw new Error("invalid service account payload");
      }
      this.serviceAccountKeyCache = { raw, key: parsed };
      this.serviceAccountToken = undefined;
      return parsed;
    } catch (error) {
      throw new ProviderError("Google service account credentials are invalid", {
        status: 401,
        provider: this.name,
        retryable: false,
        cause: error
      });
    }
  }

  private async requestServiceAccountToken(key: ServiceAccountKey): Promise<CachedServiceAccountToken> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const expSeconds = nowSeconds + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: key.client_email,
        scope: GOOGLE_SCOPE,
        aud: key.token_uri ?? GOOGLE_TOKEN_URL,
        iat: nowSeconds,
        exp: expSeconds
      })
    ).toString("base64url");

    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(key.private_key, "base64url");
    const assertion = `${header}.${payload}.${signature}`;

    const params = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    });

    const response = await this.fetchImpl(key.token_uri ?? GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    if (!response.ok) {
      const message = await this.extractError(response);
      throw new ProviderError(`Google service account token exchange failed: ${message}`, {
        status: response.status,
        provider: this.name,
        retryable: response.status >= 500
      });
    }

    const payloadJson = (await response.json()) as Partial<OAuthTokenRecord>;
    if (typeof payloadJson.access_token !== "string") {
      throw new ProviderError("Google service account token response missing access_token", {
        status: 502,
        provider: this.name,
        retryable: false
      });
    }

    const expiresAt = this.now() + (typeof payloadJson.expires_in === "number" ? payloadJson.expires_in * 1000 : 3600_000);

    return {
      accessToken: payloadJson.access_token,
      expiresAt
    };
  }

  private isExpired(expiresAt?: number): boolean {
    if (!expiresAt) {
      return false;
    }
    return expiresAt - TOKEN_EXPIRY_SKEW_MS <= this.now();
  }

  private async invokeGemini(
    modelId: string,
    messages: ChatMessage[],
    auth: GoogleAuth
  ): Promise<GeminiGenerateResponse> {
    const normalizedModelPath = this.normalizeModelPath(modelId);
    const url = new URL(`${GOOGLE_API_BASE}/models/${normalizedModelPath}:generateContent`);
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (auth.type === "apiKey") {
      url.searchParams.set("key", auth.apiKey);
    } else {
      headers.Authorization = `Bearer ${auth.token}`;
    }

    const systemMessage = messages.find(msg => msg.role === "system")?.content;
    const body: Record<string, unknown> = {
      contents: toGeminiContents(messages)
    };

    if (systemMessage) {
      body.systemInstruction = {
        role: "system",
        parts: [{ text: systemMessage }]
      };
    }

    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const message = await this.extractError(response);
      throw new ProviderError(message || `Google Gemini returned ${response.status}`, {
        status: response.status,
        provider: this.name,
        retryable: response.status >= 500
      });
    }

    return (await response.json()) as GeminiGenerateResponse;
  }

  private normalizeModelPath(modelId: string): string {
    const trimmed = modelId.replace(/^models\//, "");
    const segments = trimmed.split("/").filter(segment => segment.length > 0);
    if (segments.length === 0) {
      return "";
    }
    return segments.map(encodeURIComponent).join("/");
  }

  private async extractError(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as GeminiGenerateResponse;
      if (payload.error?.message) {
        return payload.error.message;
      }
      if (payload.candidates?.length) {
        return JSON.stringify(payload);
      }
    } catch {
      // fall back to text body
    }
    try {
      const text = await response.text();
      return text;
    } catch {
      return "";
    }
  }
}
