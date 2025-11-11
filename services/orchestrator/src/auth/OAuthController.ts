import type { Request, Response } from "express";
import { loadConfig } from "../config.js";
import { OAuthCallbackSchema, formatValidationIssues } from "../http/validation.js";
import { getSecretsStore, getVersionedSecretsManager } from "../providers/ProviderRegistry.js";
import { respondWithError, respondWithValidationError } from "../http/errors.js";
import { type SecretsStore } from "./SecretsStore.js";
import { resolveEnv } from "../utils/env.js";
import { ensureEgressAllowed } from "../network/EgressGuard.js";

class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
};

type ProviderConfig = {
  name: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  extraParams?: Record<string, string>;
};

function secrets(): SecretsStore {
  return getSecretsStore();
}

function getProviderConfig(provider: string): ProviderConfig | undefined {
  const cfg = loadConfig();
  const redirectBase = cfg.auth.oauth.redirectBaseUrl.replace(/\/$/, "");
  const definitions: Record<string, ProviderConfig> = {
    openrouter: {
      name: "openrouter",
      tokenUrl: "https://openrouter.ai/api/v1/oauth/token",
      clientId: resolveEnv("OPENROUTER_CLIENT_ID", "") ?? "",
      clientSecret: resolveEnv("OPENROUTER_CLIENT_SECRET"),
      redirectUri: `${redirectBase}/auth/openrouter/callback`,
      extraParams: { grant_type: "authorization_code" }
    },
    google: {
      name: "google",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: resolveEnv("GOOGLE_OAUTH_CLIENT_ID", "") ?? "",
      clientSecret: resolveEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      redirectUri: `${redirectBase}/auth/google/callback`,
      extraParams: { grant_type: "authorization_code" }
    }
  };

  const def = definitions[provider];
  if (!def || !def.clientId) {
    return undefined;
  }
  return def;
}

export async function authorize(req: Request, res: Response) {
  const provider = req.params.provider;
  const cfg = getProviderConfig(provider);
  if (!cfg) {
    respondWithError(res, 404, {
      code: "not_found",
      message: "unknown provider",
    });
    return;
  }
  res.json({ provider: cfg.name, redirectUri: cfg.redirectUri });
}

export async function callback(req: Request, res: Response) {
  const provider = req.params.provider;
  const cfg = getProviderConfig(provider);
  if (!cfg) {
    respondWithError(res, 404, {
      code: "not_found",
      message: "unknown provider",
    });
    return;
  }

  const parsedBody = OAuthCallbackSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    respondWithValidationError(
      res,
      formatValidationIssues(parsedBody.error.issues),
    );
    return;
  }
  const { code, codeVerifier, redirectUri } = parsedBody.data;

  if (redirectUri !== cfg.redirectUri) {
    respondWithValidationError(res, [
      { path: "redirect_uri", message: "redirect_uri mismatch" },
    ]);
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(cfg, code, codeVerifier);
    const store = secrets();
    const rotator = getVersionedSecretsManager();
    const normalizedTokens: TokenResponse & { expires_at?: number } = { ...tokens };
    if (typeof tokens.expires_in === "number") {
      normalizedTokens.expires_at = Date.now() + tokens.expires_in * 1000;
    }

    const operations: Array<Promise<unknown>> = [
      store.set(`oauth:${provider}:access_token`, tokens.access_token),
      store.set(`oauth:${provider}:tokens`, JSON.stringify(normalizedTokens))
    ];

    if (tokens.refresh_token) {
      operations.push(
        rotator.rotate(`oauth:${provider}:refresh_token`, tokens.refresh_token, {
          retain: 5,
          labels: { provider }
        })
      );
    } else {
      operations.push(rotator.clear(`oauth:${provider}:refresh_token`));
    }

    await Promise.all(operations);
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to exchange code";
    type StatusLike = { status?: unknown };
    const statusCandidate =
      error instanceof HttpError
        ? error.status
        : typeof error === "object" && error !== null && typeof (error as StatusLike).status === "number"
          ? (error as StatusLike).status
          : undefined;
    const status = typeof statusCandidate === "number" && Number.isFinite(statusCandidate) ? statusCandidate : 502;
    respondWithError(res, status, {
      code: status >= 500 ? "upstream_error" : "bad_request",
      message,
    });
  }
}

async function exchangeCodeForTokens(cfg: ProviderConfig, code: string, codeVerifier: string): Promise<TokenResponse> {
  const params = new URLSearchParams({
    code,
    code_verifier: codeVerifier,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    grant_type: "authorization_code"
  });
  if (cfg.clientSecret) {
    params.set("client_secret", cfg.clientSecret);
  }
  if (cfg.extraParams) {
    for (const [key, value] of Object.entries(cfg.extraParams)) {
      params.set(key, value);
    }
  }

  const timeoutMs = loadConfig().tooling.defaultTimeoutMs;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  let fetchResponse: globalThis.Response;
  try {
    ensureEgressAllowed(cfg.tokenUrl, {
      action: "oauth.token",
      metadata: { provider: cfg.name },
    });
    fetchResponse = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(`token endpoint timed out after ${timeoutMs}ms`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!fetchResponse.ok) {
    const text = await fetchResponse.text();
    throw new HttpError(text || `token endpoint returned ${fetchResponse.status}`, fetchResponse.status);
  }
  const payload = (await fetchResponse.json()) as TokenResponse;
  if (typeof payload.access_token !== "string") {
    throw new HttpError("access_token missing in response", 502);
  }
  return payload;
}
