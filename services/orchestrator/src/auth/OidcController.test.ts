import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionStore } from "./SessionStore.js";
import {
  getOidcConfiguration,
  handleOidcCallback,
  getSession as getSessionHandler,
  logout as logoutHandler
} from "./OidcController.js";
import * as OidcClient from "./OidcClient.js";

const issuer = "https://accounts.example.com";
const tokenEndpoint = "https://accounts.example.com/oauth/token";
const jwksUri = "https://accounts.example.com/.well-known/jwks.json";
const authorizationEndpoint = "https://accounts.example.com/oauth/authorize";

vi.mock("../config.js", () => {
  return {
    loadConfig: () => ({
      runMode: "enterprise",
      messaging: { type: "kafka", kafka: { brokers: [], clientId: "", consumerGroup: "", consumeFromBeginning: false, retryDelayMs: 1000, topics: { planSteps: "", planCompletions: "", planEvents: "", planState: "", deadLetterSuffix: ".dead" }, tls: { enabled: false, caPaths: [], certPath: undefined, keyPath: undefined, rejectUnauthorized: true }, sasl: undefined } },
      providers: { defaultRoute: "balanced", enabled: [], rateLimit: { windowMs: 60000, maxRequests: 120 }, circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 } },
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
            tenantMappings: {}
          },
          session: {
            cookieName: "oss_session",
            ttlSeconds: 3600
          }
        }
      },
      secrets: { backend: "vault" },
      tooling: {
        agentEndpoint: "127.0.0.1:50051",
        retryAttempts: 3,
        defaultTimeoutMs: 10000
      },
      server: {
        sseKeepAliveMs: 25000,
        rateLimits: {
          plan: { windowMs: 60000, maxRequests: 60 },
          chat: { windowMs: 60000, maxRequests: 600 }
        },
        tls: {
          enabled: false,
          keyPath: undefined,
          certPath: undefined,
          caPaths: [],
          requestClientCert: true
        }
      },
      observability: {
        tracing: {
          enabled: false,
          serviceName: "orchestrator",
          environment: "test",
          exporterEndpoint: "http://localhost:4318/v1/traces",
          exporterHeaders: {},
          sampleRatio: 1
        }
      }
    })
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
  jwks_uri: jwksUri
});

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  sessionStore.clear();
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(metadataResponse, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/oauth/token")) {
      const tokenPayload = {
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "test-id-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid profile email"
      };
      return new Response(JSON.stringify(tokenPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/.well-known/jwks.json")) {
      return new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    throw new Error(`unexpected fetch to ${url} with method ${(init?.method) ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  vi.spyOn(OidcClient, "verifyIdToken").mockResolvedValue({
    payload: {
      sub: "user-123",
      email: "user@example.com",
      name: "Test User",
      tid: "tenant-1",
      roles: ["admin"],
      exp: Math.floor(Date.now() / 1000) + 3600
    }
  } as any);
});

afterEach(() => {
  fetchMock.mockReset();
  sessionStore.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      redirectUri: "http://127.0.0.1:8080/auth/oidc/callback"
    });
  });

  it("creates a session and sets cookie during callback", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/auth/oidc/callback")
      .send({
        code: "auth-code",
        code_verifier: "v".repeat(64),
        redirect_uri: "http://127.0.0.1:8080/auth/oidc/callback"
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      sessionId: expect.any(String),
      subject: "user-123",
      email: "user@example.com",
      roles: ["admin", "default-role"]
    });
    const cookies = response.headers["set-cookie"];
    expect(Array.isArray(cookies)).toBe(true);
    const sessionCookie = (cookies as string[]).find(cookie => cookie.startsWith("oss_session="));
    expect(sessionCookie).toBeDefined();

    const sessionCheck = await request(app)
      .get("/auth/session")
      .set("Cookie", sessionCookie as string);
    expect(sessionCheck.status).toBe(200);
    expect(sessionCheck.body.session).toMatchObject({
      id: response.body.sessionId,
      subject: "user-123",
      tenantId: "tenant-1"
    });

    const logoutResponse = await request(app)
      .post("/auth/logout")
      .set("Cookie", sessionCookie as string);
    expect(logoutResponse.status).toBe(204);

    const postLogout = await request(app)
      .get("/auth/session")
      .set("Cookie", sessionCookie as string);
    expect(postLogout.status).toBe(401);
  });
});
