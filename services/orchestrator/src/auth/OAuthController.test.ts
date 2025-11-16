import type { Response } from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { VersionedSecretsManager } from "./VersionedSecretsManager.js";
import { logAuditEvent } from "../observability/audit.js";

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
    },
  };
  manager = new VersionedSecretsManager(store, { retain: 5 });
}

vi.mock("../config.js", () => {
  return {
    loadConfig: () => ({
      auth: {
        oauth: {
          redirectBaseUrl: "http://127.0.0.1:8080",
        },
      },
      tooling: {
        defaultTimeoutMs: 10000,
        agentEndpoint: "127.0.0.1:50051",
        retryAttempts: 3,
      },
      network: {
        egress: {
          mode: "enforce",
          allow: [
            "localhost",
            "127.0.0.1",
            "::1",
            "*.example.com",
            "oauth2.googleapis.com",
            "openrouter.ai",
          ],
        },
      },
    }),
  };
});

vi.mock("../providers/ProviderRegistry.js", () => ({
  getSecretsStore: () => store,
  getVersionedSecretsManager: () => manager,
}));

vi.mock("../observability/audit.js", () => ({
  logAuditEvent: vi.fn(),
  hashIdentifier: vi.fn((value?: string | null) =>
    value && value.length > 0 ? `hash:${value}` : undefined,
  ),
}));

let authorize: typeof import("./OAuthController.js") extends {
  authorize: infer T;
}
  ? T
  : never;
let callback: typeof import("./OAuthController.js") extends {
  callback: infer T;
}
  ? T
  : never;

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
    },
  };
  return base as TestResponse;
}

function getAuditEvents() {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
}

function findAuditEvent(action: string, outcome?: string) {
  return getAuditEvents().find((event) => {
    return (
      event.action === action && (outcome ? event.outcome === outcome : true)
    );
  });
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
    vi.mocked(logAuditEvent).mockClear();
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
      redirectUri: "http://127.0.0.1:8080/auth/google/callback",
    });
    const event = findAuditEvent("auth.oauth.authorize", "success");
    expect(event).toBeDefined();
    expect(event?.details?.provider).toBe("google");
  });

  it("returns 404 for unknown provider during authorization", async () => {
    const req = { params: { provider: "unknown" } } as any;
    const res = createResponse();

    await authorize(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toMatchObject({
      code: "not_found",
      message: "unknown provider",
    });
    const event = findAuditEvent("auth.oauth.authorize", "denied");
    expect(event).toBeDefined();
    expect(event?.details?.provider).toBe("unknown");
  });

  it("returns 404 for unknown provider during callback", async () => {
    const req = {
      params: { provider: "missing" },
      body: {
        code: "c",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/missing/callback",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toMatchObject({
      code: "not_found",
      message: "unknown provider",
    });
    const event = findAuditEvent("auth.oauth.callback", "denied");
    expect(event).toBeDefined();
    expect(event?.details?.provider).toBe("missing");
  });

  it("exchanges authorization code and stores tokens", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.payload).toEqual({ ok: true });

    expect(secretsStoreData.get("oauth:google:access_token")).toBe(
      "access-token",
    );
    expect(secretsStoreData.get("oauth:google:refresh_token")).toBe(
      "refresh-token",
    );
    const storedTokens = secretsStoreData.get("oauth:google:tokens");
    expect(storedTokens).toBeDefined();
    expect(JSON.parse(storedTokens!)).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });

    const metadata = secretsStoreData.get(
      "secretmeta:oauth:google:refresh_token",
    );
    expect(metadata).toBeDefined();
    const parsedMetadata = JSON.parse(metadata!);
    expect(parsedMetadata.currentVersion).toBeDefined();
    const event = findAuditEvent("auth.oauth.callback", "success");
    expect(event).toBeDefined();
    expect(event?.details?.provider).toBe("google");
    expect(event?.details?.refreshTokenStored).toBe(true);
    expect(event?.details?.refreshTokenVersion).toBeDefined();
  });

  it("namespaces stored secrets when tenant_id is provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "tenant-access",
        refresh_token: "tenant-refresh",
        expires_in: 1800,
        token_type: "Bearer",
      }),
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback",
        tenant_id: "acme",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(secretsStoreData.get("tenant:acme:oauth:google:access_token")).toBe(
      "tenant-access",
    );
    expect(
      secretsStoreData.get("tenant:acme:oauth:google:refresh_token"),
    ).toBe("tenant-refresh");
    expect(
      secretsStoreData.get("oauth:google:access_token"),
    ).toBeUndefined();

    const event = findAuditEvent("auth.oauth.callback", "success");
    expect(event?.details?.tenantId).toBe("acme");
    expect(event?.subject?.tenantId).toBe("acme");
    expect(event?.details?.refreshTokenVersion).toBeDefined();
  });

  it("rejects requests with missing parameters", async () => {
    const req = {
      params: { provider: "google" },
      body: {
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
      details: [{ path: "code", message: "code is required" }],
    });
    expect(secretsStoreData.size).toBe(0);
    const event = findAuditEvent("auth.oauth.callback", "failure");
    expect(event).toBeDefined();
    expect(event?.details?.reason).toBe("invalid_request");
  });

  it("rejects callbacks with mismatched redirect uri", async () => {
    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "https://evil.example.com/callback",
        tenant_id: "acme",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
      details: [{ path: "redirect_uri", message: "redirect_uri mismatch" }],
    });
    const event = findAuditEvent("auth.oauth.callback", "failure");
    expect(event?.details?.reason).toBe("redirect_mismatch");
    expect(event?.details?.tenantId).toBe("acme");
    expect(event?.subject?.tenantId).toBe("acme");
  });

  it("propagates provider errors when access_token is missing", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ refresh_token: "refresh-token" }),
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.payload).toMatchObject({
      code: "upstream_error",
      message: "OAuth provider is unavailable. Please retry later.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secretsStoreData.size).toBe(0);
    const event = findAuditEvent("auth.oauth.callback", "failure");
    expect(event).toBeDefined();
    expect(event?.details?.status).toBe(502);
    expect(event?.details?.reason).toBe("upstream_error");
  });

  it("clears stored refresh state when provider omits refresh token", async () => {
    const clearSpy = vi.spyOn(manager, "clear");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "access-token",
        expires_in: 60,
      }),
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(200);
    expect(clearSpy).toHaveBeenCalledWith("oauth:google:refresh_token");
    expect(secretsStoreData.get("oauth:google:access_token")).toBe(
      "access-token",
    );
    expect(secretsStoreData.has("oauth:google:refresh_token")).toBe(false);
    const event = findAuditEvent("auth.oauth.callback", "success");
    expect(event?.details?.refreshTokenStored).toBe(false);
    expect(event?.details?.refreshTokenVersion).toBeUndefined();
  });

  it("records tenant subject metadata when the provider rejects the callback", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback",
        tenant_id: "acme",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    const event = findAuditEvent("auth.oauth.callback", "denied");
    expect(event?.subject?.tenantId).toBe("acme");
    expect(event?.details?.tenantId).toBe("acme");
  });

  it("returns upstream error when token endpoint responds with HTTP error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    const req = {
      params: { provider: "google" },
      body: {
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(429);
    expect(res.payload).toMatchObject({
      code: "bad_request",
      message: "OAuth provider rejected the authorization request.",
    });
    const event = findAuditEvent("auth.oauth.callback", "denied");
    expect(event).toBeDefined();
    expect(event?.details?.reason).toBe("provider_rejected");
    expect(event?.details?.status).toBe(429);
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
        redirect_uri: "http://127.0.0.1:8080/auth/google/callback",
      },
    } as any;
    const res = createResponse();

    await callback(req, res);

    expect(res.statusCode).toBe(504);
    expect(res.payload).toMatchObject({
      code: "upstream_error",
      message: "OAuth provider is unavailable. Please retry later.",
    });
    const event = findAuditEvent("auth.oauth.callback", "failure");
    expect(event).toBeDefined();
    expect(event?.details?.reason).toBe("upstream_error");
    expect(event?.details?.status).toBe(504);
  });
});
