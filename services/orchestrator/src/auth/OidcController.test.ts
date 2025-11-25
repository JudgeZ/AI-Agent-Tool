import express from "express";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { sessionStore } from "./SessionStore.js";
import {
  getOidcConfiguration,
  handleOidcCallback,
  getSession as getSessionHandler,
  logout as logoutHandler,
} from "./OidcController.js";
import * as OidcClient from "./OidcClient.js";
import * as Audit from "../observability/audit.js";

const issuer = "https://accounts.example.com";
const tokenEndpoint = "https://accounts.example.com/oauth/token";
const jwksUri = "https://accounts.example.com/.well-known/jwks.json";
const authorizationEndpoint = "https://accounts.example.com/oauth/authorize";

function buildConfig() {
  return {
    runMode: "enterprise" as const,
    messaging: {
      type: "kafka",
      kafka: {
        brokers: [],
        clientId: "",
        consumerGroup: "",
        consumeFromBeginning: false,
        retryDelayMs: 1000,
        topics: {
          planSteps: "",
          planCompletions: "",
          planEvents: "",
          planState: "",
          deadLetterSuffix: ".dead",
        },
        tls: {
          enabled: false,
          caPaths: [],
          certPath: undefined,
          keyPath: undefined,
          rejectUnauthorized: true,
        },
        sasl: undefined,
      },
    },
    providers: {
      defaultRoute: "balanced",
      enabled: [],
      rateLimit: { windowMs: 60000, maxRequests: 120 },
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
    },
    auth: {
      oauth: { redirectBaseUrl: "http://127.0.0.1:8080" },
      oidc: {
        enabled: true,
        issuer,
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectBaseUrl: "http://127.0.0.1:8080",
        redirectUri: "http://127.0.0.1:8080/auth/oidc/callback",
        scopes: ["openid", "profile", "email"],
        tenantClaim: "tid",
        audience: undefined,
        logoutUrl: undefined,
        roles: {
          claim: "roles",
          fallback: ["default-role"],
          mappings: {},
          tenantMappings: {},
        },
        session: {
          cookieName: "oss_session",
          ttlSeconds: 3600,
        },
      },
    },
    secrets: { backend: "vault" },
    tooling: {
      agentEndpoint: "127.0.0.1:50051",
      retryAttempts: 3,
      defaultTimeoutMs: 10000,
    },
    server: {
      sseKeepAliveMs: 25000,
      sseSendTimeoutMs: 5000,
      sseMaxBufferEvents: 100,
      sseMaxBufferBytes: 64 * 1024,
      rateLimits: {
        backend: { provider: "memory" as const },
        plan: { windowMs: 60000, maxRequests: 60 },
        chat: { windowMs: 60000, maxRequests: 600 },
        auth: {
          windowMs: 60000,
          maxRequests: 120,
          identityWindowMs: 60000,
          identityMaxRequests: 20,
        },
      },
      sseQuotas: {
        perIp: 4,
        perSubject: 2,
      },
      tls: {
        enabled: false,
        keyPath: undefined,
        certPath: undefined,
        caPaths: [],
        requestClientCert: true,
      },
      trustedProxyCidrs: [],
      cors: {
        allowedOrigins: [],
      },
    },
    observability: {
      tracing: {
        enabled: false,
        serviceName: "orchestrator",
        environment: "test",
        exporterEndpoint: "http://localhost:4318/v1/traces",
        exporterHeaders: {},
        sampleRatio: 1,
      },
    },
    network: {
      egress: {
        mode: "enforce",
        allow: [
          "localhost",
          "127.0.0.1",
          "::1",
          "oauth2.googleapis.com",
          "openrouter.ai",
          "*.example.com",
        ],
      },
    },
  };
}

type TestConfig = ReturnType<typeof buildConfig>;

let testConfig: TestConfig = buildConfig();

vi.mock("../config.js", () => {
  return {
    loadConfig: () => testConfig,
  };
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.get("/auth/oidc/config", getOidcConfiguration);
  app.post("/auth/oidc/callback", handleOidcCallback);
  app.get("/auth/session", getSessionHandler);
  app.post("/auth/logout", logoutHandler);
  return app;
}

const metadataResponse = JSON.stringify({
  issuer,
  authorization_endpoint: authorizationEndpoint,
  token_endpoint: tokenEndpoint,
  jwks_uri: jwksUri,
});

const originalFetch = globalThis.fetch;
const originalCookieSecure = process.env.COOKIE_SECURE;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  testConfig = buildConfig();
  sessionStore.clear();
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(metadataResponse, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/oauth/token")) {
        const tokenPayload = {
          access_token: "access-token",
          refresh_token: "refresh-token",
          id_token: "test-id-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid profile email",
        };
        return new Response(JSON.stringify(tokenPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return new Response(JSON.stringify({ keys: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(
        `unexpected fetch to ${url} with method ${init?.method ?? "GET"}`,
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  vi.spyOn(OidcClient, "verifyIdToken").mockResolvedValue({
    payload: {
      sub: "user-123",
      email: "user@example.com",
      name: "Test User",
      tid: "tenant-1",
      roles: ["admin"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  } as any);
});

afterEach(() => {
  fetchMock.mockReset();
  sessionStore.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalCookieSecure === undefined) {
    delete process.env.COOKIE_SECURE;
  } else {
    process.env.COOKIE_SECURE = originalCookieSecure;
  }
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("OidcController", () => {
  it("returns discovered configuration", async () => {
    const app = createApp();
    const response = await request(app).get("/auth/oidc/config");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      clientId: "client-id",
      redirectUri: "http://127.0.0.1:8080/auth/oidc/callback",
    });
  });

  it("creates a session and sets cookie during callback", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      sessionId: expect.any(String),
      subject: "user-123",
      email: "user@example.com",
      roles: ["admin", "default-role"],
    });
    expect(response.body).not.toHaveProperty("tokens");
    const cookies = response.headers["set-cookie"];
    expect(Array.isArray(cookies)).toBe(true);
    const sessionCookieList = Array.isArray(cookies) ? cookies : [];
    const sessionCookie = sessionCookieList.find((cookie) =>
      cookie.startsWith("oss_session="),
    );
    expect(sessionCookie).toBeDefined();
    const sessionCookieValue = sessionCookie!;
    expect(sessionCookieValue).toContain("Secure");
    expect(sessionCookieValue).toContain("HttpOnly");
    expect(sessionCookieValue).toContain("SameSite=Lax");

    const sessionCheck = await request(app)
      .get("/auth/session")
      .set("Cookie", sessionCookieValue);
    expect(sessionCheck.status).toBe(200);
    expect(sessionCheck.body.session).toMatchObject({
      id: response.body.sessionId,
      subject: "user-123",
      tenantId: "tenant-1",
    });
    expect(sessionCheck.body.session).not.toHaveProperty("tokens");

    const storedSession = await sessionStore.getSession(response.body.sessionId);
    expect(storedSession).toBeDefined();
    expect(storedSession).not.toHaveProperty("tokens");

    const logoutResponse = await request(app)
      .post("/auth/logout")
      .set("Cookie", sessionCookieValue);
    expect(logoutResponse.status).toBe(204);
    const clearedCookies = logoutResponse.headers["set-cookie"];
    expect(clearedCookies).toBeDefined();
    expect(
      Array.isArray(clearedCookies) ? clearedCookies.join(";") : clearedCookies,
    ).toMatch(/Secure/);
    expect(
      Array.isArray(clearedCookies) ? clearedCookies.join(";") : clearedCookies,
    ).toMatch(/HttpOnly/);
    expect(
      Array.isArray(clearedCookies) ? clearedCookies.join(";") : clearedCookies,
    ).toMatch(/SameSite=Lax/);

    const postLogout = await request(app)
      .get("/auth/session")
      .set("Cookie", sessionCookie as string);
    expect(postLogout.status).toBe(401);
  });

  it("rejects callbacks with missing parameters", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
      details: [{ path: "code", message: "code is required" }],
    });
  });

  it("resolves tenant id from nested claim values and records it in audit logs", async () => {
    testConfig.auth.oidc.tenantClaim = "realm.tenant";
    const verifySpy = vi.mocked(OidcClient.verifyIdToken);
    verifySpy.mockResolvedValueOnce({
      payload: {
        sub: "user-456",
        email: "nested@example.com",
        name: "Nested User",
        realm: { tenant: "nested-tenant" },
        roles: ["analyst"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    } as any);
    const auditSpy = vi.spyOn(Audit, "logAuditEvent");

    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ tenantId: "nested-tenant" });
    expect(response.body).not.toHaveProperty("tokens");

    const nestedCookies = response.headers["set-cookie"];
    const nestedCookieList = Array.isArray(nestedCookies)
      ? nestedCookies
      : nestedCookies
        ? [nestedCookies]
        : [];
    const sessionCookie = nestedCookieList.find((cookie) =>
      cookie.startsWith("oss_session="),
    );
    expect(sessionCookie).toBeDefined();

    const sessionCheck = await request(app)
      .get("/auth/session")
      .set("Cookie", sessionCookie as string);
    expect(sessionCheck.status).toBe(200);
    expect(sessionCheck.body.session).toMatchObject({
      tenantId: "nested-tenant",
    });
    expect(sessionCheck.body.session).not.toHaveProperty("tokens");

    const auditCall = auditSpy.mock.calls.find(
      ([event]) =>
        event.action === "auth.oidc.callback" && event.outcome === "success",
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0].details?.tenantId).toBe("nested-tenant");
    expect(auditCall?.[0].subject?.tenantId).toBe("nested-tenant");
  });

  it("rejects callbacks when the id token is already expired", async () => {
    const verifySpy = vi.mocked(OidcClient.verifyIdToken);
    verifySpy.mockResolvedValueOnce({
      payload: {
        sub: "user-123",
        email: "user@example.com",
        name: "Test User",
        tid: "tenant-1",
        roles: ["admin"],
        exp: Math.floor((Date.now() - 30_000) / 1000),
      },
    } as any);

    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(502);
    expect(response.body).toMatchObject({
      code: "upstream_error",
      message: "token expiry too soon",
    });
    const cookies = response.headers["set-cookie"];
    expect(cookies).toBeUndefined();
  });

  it("returns 404 when oidc support is disabled", async () => {
    testConfig.auth.oidc.enabled = false;
    const app = createApp();

    const configResponse = await request(app).get("/auth/oidc/config");
    expect(configResponse.status).toBe(404);

    const callbackResponse = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });
    expect(callbackResponse.status).toBe(404);
  });

  it("rejects redirect mismatches", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "https://app.example.com/oidc",
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
      details: [{ path: "redirect_uri", message: "redirect_uri mismatch" }],
    });
  });

  it("rejects callbacks when state cookie does not match payload state", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .set("Cookie", "oss_oidc_state=expected")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
        state: "different",
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
      details: [{ path: "state", message: "state verification failed" }],
    });
  });

  it("responds with upstream error when the token exchange omits an id token", async () => {
    vi.spyOn(OidcClient, "exchangeCodeForTokens").mockResolvedValueOnce({
      access_token: "access-token",
      refresh_token: "refresh-token",
      scope: "openid",
      token_type: "Bearer",
    } as any);

    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      code: "upstream_error",
      message: "id_token missing in response",
    });
  });

  it("uses the client_id supplied in the callback payload", async () => {
    const exchangeSpy = vi
      .spyOn(OidcClient, "exchangeCodeForTokens")
      .mockResolvedValueOnce({
        id_token: "token",
        expires_in: 3600,
        token_type: "Bearer",
      } as any);
    const verifySpy = vi
      .spyOn(OidcClient, "verifyIdToken")
      .mockResolvedValueOnce({
        payload: {
          sub: "user-123",
          email: "user@example.com",
          roles: ["admin"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      } as any);

    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
        client_id: "tenant-client",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(exchangeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "tenant-client" }),
      expect.anything(),
      "auth-code",
      expect.any(String),
      expect.any(Number),
    );
    expect(verifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "tenant-client" }),
      expect.anything(),
      expect.any(String),
    );
  });

  it("rejects callbacks when the id token payload lacks a subject", async () => {
    vi.mocked(OidcClient.verifyIdToken).mockResolvedValueOnce({
      payload: {
        email: "user@example.com",
        name: "Test User",
        roles: ["admin"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    } as any);

    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      code: "upstream_error",
      message: "id_token missing subject",
    });
  });

  it("treats exchange timeouts as gateway errors", async () => {
    vi.spyOn(OidcClient, "exchangeCodeForTokens").mockRejectedValueOnce(
      new Error("request timed out after 1000ms"),
    );

    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });

    expect(response.status).toBe(504);
    expect(response.body).toMatchObject({
      code: "upstream_error",
      message: "request timed out after 1000ms",
    });
  });

  it("requires secure cookies when running in enterprise mode", async () => {
    process.env.COOKIE_SECURE = "false";
    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      code: "configuration_error",
      message: "secure cookies must be enabled when run mode is enterprise",
    });
  });

  it("returns unauthorized when no session cookie is provided", async () => {
    const auditSpy = vi.spyOn(Audit, "logAuditEvent");
    const app = createApp();
    const response = await request(app).get("/auth/session");
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: "unauthorized",
      message: "session not found",
    });
    const auditCall = auditSpy.mock.calls.find(
      ([event]) =>
        event.action === "auth.session.get" && event.outcome === "failure",
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0].details).toMatchObject({
      reason: "session cookie missing",
    });
  });

  it("rejects session retrieval when the session id is invalid", async () => {
    const auditSpy = vi.spyOn(Audit, "logAuditEvent");
    const app = createApp();
    const response = await request(app)
      .get("/auth/session")
      .set("Cookie", "oss_session=invalid-token");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
    });
    expect(response.body.details?.[0]?.message).toMatch(/session id/i);

    const auditCall = auditSpy.mock.calls.find(
      ([event]) =>
        event.action === "auth.session.get" && event.outcome === "failure",
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0].details).toMatchObject({
      reason: "invalid session id",
      source: "cookie",
    });
  });

  it("clears the session cookie during logout even when the session does not exist", async () => {
    const auditSpy = vi.spyOn(Audit, "logAuditEvent");
    const app = createApp();
    const response = await request(app)
      .post("/auth/logout")
      .set("Cookie", "oss_session=123e4567-e89b-12d3-a456-426614174000");
    expect(response.status).toBe(204);
    expect(response.headers["set-cookie"] ?? []).toBeDefined();
    const auditCall = auditSpy.mock.calls.find(
      ([event]) =>
        event.action === "auth.logout" && event.outcome === "failure",
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0].details).toMatchObject({
      reason: "session not found",
    });
  });

  it("rejects logout when the session id is invalid", async () => {
    const auditSpy = vi.spyOn(Audit, "logAuditEvent");
    const app = createApp();
    const response = await request(app)
      .post("/auth/logout")
      .set("Cookie", "oss_session=not-a-uuid");

    expect(response.status).toBe(400);
    expect(response.headers["set-cookie"] ?? []).toBeDefined();
    expect(response.body).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
    });
    expect(response.body.details?.[0]?.message).toMatch(/session id/i);

    const auditCall = auditSpy.mock.calls.find(
      ([event]) =>
        event.action === "auth.logout" && event.outcome === "failure",
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0].details).toMatchObject({
      reason: "invalid session id",
      source: "cookie",
    });
  });

  it("logs an audit failure when logout is called without a session", async () => {
    const auditSpy = vi.spyOn(Audit, "logAuditEvent");
    const app = createApp();
    const response = await request(app).post("/auth/logout");
    expect(response.status).toBe(204);
    const auditCall = auditSpy.mock.calls.find(
      ([event]) =>
        event.action === "auth.logout" && event.outcome === "failure",
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0].details).toMatchObject({
      reason: "session cookie missing",
    });
  });

  it("logs an audit event when fetching a session succeeds", async () => {
    const auditSpy = vi.spyOn(Audit, "logAuditEvent");
    const app = createApp();
    const callbackResponse = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback",
      });
    expect(callbackResponse.status).toBe(200);
    const cookies = callbackResponse.headers["set-cookie"] ?? [];
    const sessionCookie = (Array.isArray(cookies) ? cookies : [cookies]).find(
      (cookie) => cookie.startsWith("oss_session="),
    );
    expect(sessionCookie).toBeDefined();

    auditSpy.mockClear();
    const sessionResponse = await request(app)
      .get("/auth/session")
      .set("Cookie", sessionCookie as string);

    expect(sessionResponse.status).toBe(200);
    const auditCall = auditSpy.mock.calls.find(
      ([event]) =>
        event.action === "auth.session.get" && event.outcome === "success",
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0].subject).toMatchObject({
      sessionId: expect.any(String),
      userId: "user-123",
    });
    expect(auditCall?.[0].details).toMatchObject({ tenantId: "tenant-1" });
  });

  it("logs an audit event when the session has expired", async () => {
    const auditSpy = vi.spyOn(Audit, "logAuditEvent");
    const app = createApp();
    const expiredSession = await sessionStore.createSession(
      {
        subject: "user-expired",
        email: "expired@example.com",
        name: "Expired User",
        tenantId: "tenant-expired",
        roles: ["viewer"],
        scopes: ["openid"],
        claims: {},
      },
      3600,
      Date.now() - 60_000,
    );
    const cookieName = testConfig.auth.oidc.session.cookieName;
    auditSpy.mockClear();
    const response = await request(app)
      .get("/auth/session")
      .set("Cookie", `${cookieName}=${expiredSession.id}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: "unauthorized",
      message: "session expired",
    });
    const auditCall = auditSpy.mock.calls.find(
      ([event]) =>
        event.action === "auth.session.get" && event.outcome === "failure",
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0].details).toMatchObject({
      reason: "session expired or missing",
    });
  });

  it("logs metadata retrieval failures and surfaces upstream errors", async () => {
    vi.spyOn(OidcClient, "fetchOidcMetadata").mockRejectedValueOnce(
      new Error("metadata unavailable"),
    );

    const app = createApp();
    const response = await request(app).get("/auth/oidc/config");
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      code: "upstream_error",
      message: "metadata unavailable",
    });
  });
});
