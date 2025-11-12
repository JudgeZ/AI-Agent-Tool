import type { Response } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { VersionedSecretsManager } from "./VersionedSecretsManager.js";

const secretsStoreData = new Map<string, string>();

let store: {
  set: (key: string, value: string) => Promise<void>;
  get: (key: string) => Promise<string | undefined>;
  delete: (key: string) => Promise<void>;
};
let manager: VersionedSecretsManager;

function rebuildStore() {
  store = {
    set: async (key: string, value: string) => {
      secretsStoreData.set(key, value);
    },
    get: async (key: string) => secretsStoreData.get(key),
    delete: async (key: string) => {
      secretsStoreData.delete(key);
    }
  };
  manager = new VersionedSecretsManager(store, { retain: 5 });
}

vi.mock("../config.js", () => {
  return {
    loadConfig: () => ({
      auth: {
        oauth: {
          redirectBaseUrl: "http://127.0.0.1:8080"
        }
      },
      tooling: {
        defaultTimeoutMs: 10000,
        agentEndpoint: "127.0.0.1:50051",
        retryAttempts: 3
      },
      network: {
        egress: {
          mode: "enforce",
          allow: ["localhost", "127.0.0.1", "::1", "*.example.com"]
        }
      }
    })
  };
});

vi.mock("../providers/ProviderRegistry.js", () => ({
  getSecretsStore: () => store,
  getVersionedSecretsManager: () => manager
}));

let authorize: typeof import("./OAuthController.js") extends { authorize: infer T } ? T : never;
let callback: typeof import("./OAuthController.js") extends { callback: infer T } ? T : never;

beforeAll(async () => {
  rebuildStore();
  ({ authorize, callback } = await import("./OAuthController.js"));
});

type TestResponse = Response & { statusCode: number; payload?: unknown };

function createResponse(): TestResponse {
  const base: Partial<Response> & { statusCode: number; payload?: unknown } = {
    statusCode: 200,
    payload: undefined,
    status(code: number) {
      this.statusCode = code;
      return this as unknown as Response;
    },
    json(data: unknown) {
      this.payload = data;
      return this as unknown as Response;
    }
  };
  return base as TestResponse;
}

describe("OAuthController", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    secretsStoreData.clear();
    rebuildStore();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
  });

  afterEach(() => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns redirect metadata for a known provider", async () => {
    const req = { params: { provider: "google" } } as any;
    const res = createResponse();

    await authorize(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      provider: "google",
      redirectUri: "http://127.0.0.1:8080/auth/google/callback"
    });
  });

  it("returns 404 for unknown provider during authorization", async () => {
    const req = { params: { provider: "unknown" } } as any;
    const res = createResponse();

    await authorize(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toMatchObject({
      code: "not_found",
      message: "unknown provider"
    });
  });

  it("returns 404 for unknown provider during callback", async () => {
    const req = {
      params: { provider: "missing" },
      body: { code: "c", code_verifier: "v".repeat(64), redirect_uri: "http://127.0.0.1:8080/auth/missing/callback" }
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toMatchObject({
      code: "not_found",
      message: "unknown provider"
    });
  });

  it("exchanges authorization code and stores tokens", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer"
      })
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback"
      }
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.payload).toEqual({ ok: true });

    expect(secretsStoreData.get("oauth:google:access_token")).toBe("access-token");
    expect(secretsStoreData.get("oauth:google:refresh_token")).toBe("refresh-token");
    const storedTokens = secretsStoreData.get("oauth:google:tokens");
    expect(storedTokens).toBeDefined();
    expect(JSON.parse(storedTokens!)).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token"
    });

    const metadata = secretsStoreData.get("secretmeta:oauth:google:refresh_token");
    expect(metadata).toBeDefined();
    const parsedMetadata = JSON.parse(metadata!);
    expect(parsedMetadata.currentVersion).toBeDefined();
  });

  it("rejects requests with missing parameters", async () => {
    const req = {
      params: { provider: "google" },
      body: {
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback"
      }
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
      details: [{ path: "code", message: "code is required" }]
    });
    expect(secretsStoreData.size).toBe(0);
  });

  it("rejects callbacks with mismatched redirect uri", async () => {
    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "https://evil.example.com/callback"
      }
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
      details: [{ path: "redirect_uri", message: "redirect_uri mismatch" }]
    });
  });

  it("propagates provider errors when access_token is missing", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ refresh_token: "refresh-token" })
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback"
      }
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.payload).toMatchObject({
      code: "upstream_error",
      message: "access_token missing in response"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secretsStoreData.size).toBe(0);
  });

  it("clears stored refresh state when provider omits refresh token", async () => {
    const clearSpy = vi.spyOn(manager, "clear");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "access-token",
        expires_in: 60
      })
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback"
      }
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(200);
    expect(clearSpy).toHaveBeenCalledWith("oauth:google:refresh_token");
    expect(secretsStoreData.get("oauth:google:access_token")).toBe("access-token");
    expect(secretsStoreData.has("oauth:google:refresh_token")).toBe(false);
  });

  it("returns upstream error when token endpoint responds with HTTP error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited"
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback"
      }
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(429);
    expect(res.payload).toMatchObject({
      code: "bad_request",
      message: "rate limited"
    });
  });

  it("responds with timeout error when token endpoint aborts", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    fetchMock.mockRejectedValue(abortError);

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback"
      }
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(504);
    expect(res.payload).toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("token endpoint timed out")
    });
  });
});

