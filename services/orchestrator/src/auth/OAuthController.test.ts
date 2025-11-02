import type { Response } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const secretsStoreData = new Map<string, string>();

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
      }
    })
  };
});

vi.mock("../providers/ProviderRegistry.js", () => {
  return {
    getSecretsStore: () => ({
      set: async (key: string, value: string) => {
        secretsStoreData.set(key, value);
      },
      get: async (key: string) => secretsStoreData.get(key),
      delete: async (key: string) => {
        secretsStoreData.delete(key);
      }
    })
  };
});

let callback: typeof import("./OAuthController.js") extends { callback: infer T } ? T : never;

beforeAll(async () => {
  ({ callback } = await import("./OAuthController.js"));
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
    expect(res.payload).toEqual({ error: "code is required" });
    expect(secretsStoreData.size).toBe(0);
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
    expect(res.payload).toEqual({ error: "access_token missing in response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secretsStoreData.size).toBe(0);
  });
});

