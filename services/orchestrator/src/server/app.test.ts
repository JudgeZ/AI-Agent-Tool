import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionStore } from "../auth/SessionStore.js";
import { loadConfig, type AppConfig } from "../config.js";

const createPlanMock = vi.fn();
const submitPlanStepsMock = vi.fn();

const policyMock = {
  enforceHttpAction: vi.fn(),
};

const getOidcConfigurationMock = vi.fn();
const handleOidcCallbackMock = vi.fn();
const getOidcSessionMock = vi.fn();
const oidcLogoutMock = vi.fn();

vi.mock("../plan/index.js", () => ({
  createPlan: (...args: unknown[]) => createPlanMock(...args),
}));

vi.mock("../queue/PlanQueueRuntime.js", () => ({
  submitPlanSteps: (...args: unknown[]) => submitPlanStepsMock(...args),
  getPlanSubject: vi.fn(),
  getPersistedPlanStep: vi.fn(),
  resolvePlanStepApproval: vi.fn(),
}));

vi.mock("../policy/PolicyEnforcer.js", () => ({
  getPolicyEnforcer: () => policyMock,
}));

vi.mock("../auth/OidcController.js", () => ({
  getOidcConfiguration: (...args: unknown[]) =>
    getOidcConfigurationMock(...args),
  handleOidcCallback: (...args: unknown[]) =>
    handleOidcCallbackMock(...args),
  getSession: (...args: unknown[]) => getOidcSessionMock(...args),
  logout: (...args: unknown[]) => oidcLogoutMock(...args),
}));

async function createServer(config?: AppConfig) {
  const module = await import("./app.js");
  return module.createServer(config);
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown>
    ? DeepPartial<T[K]>
    : T[K];
};

function buildConfig(overrides: DeepPartial<AppConfig> = {}): AppConfig {
  const base = loadConfig();
  const config: AppConfig = {
    ...base,
    auth: {
      ...base.auth,
      oauth: { ...base.auth.oauth },
      oidc: {
        ...base.auth.oidc,
        roles: { ...base.auth.oidc.roles },
        session: { ...base.auth.oidc.session },
      },
    },
    server: {
      ...base.server,
      rateLimits: {
        backend: { ...base.server.rateLimits.backend },
        plan: { ...base.server.rateLimits.plan },
        chat: { ...base.server.rateLimits.chat },
        auth: { ...base.server.rateLimits.auth },
      },
      securityHeaders: {
        contentSecurityPolicy: {
          ...base.server.securityHeaders.contentSecurityPolicy,
        },
        strictTransportSecurity: {
          ...base.server.securityHeaders.strictTransportSecurity,
        },
        xFrameOptions: { ...base.server.securityHeaders.xFrameOptions },
        xContentTypeOptions: {
          ...base.server.securityHeaders.xContentTypeOptions,
        },
        referrerPolicy: { ...base.server.securityHeaders.referrerPolicy },
        permissionsPolicy: {
          ...base.server.securityHeaders.permissionsPolicy,
        },
        crossOriginOpenerPolicy: {
          ...base.server.securityHeaders.crossOriginOpenerPolicy,
        },
        crossOriginResourcePolicy: {
          ...base.server.securityHeaders.crossOriginResourcePolicy,
        },
        crossOriginEmbedderPolicy: {
          ...base.server.securityHeaders.crossOriginEmbedderPolicy,
        },
        xDnsPrefetchControl: {
          ...base.server.securityHeaders.xDnsPrefetchControl,
        },
      },
    },
  };

  const { auth: authOverrides, server: serverOverrides, ...rest } = overrides;
  Object.assign(config, rest);

  if (authOverrides) {
    const { oidc: oidcOverrides, oauth: oauthOverrides, ...authRest } =
      authOverrides;
    Object.assign(config.auth, authRest);
    if (oauthOverrides) {
      Object.assign(config.auth.oauth, oauthOverrides);
    }
    if (oidcOverrides) {
      const { roles: roleOverrides, session: sessionOverrides, ...oidcRest } =
        oidcOverrides;
      Object.assign(config.auth.oidc, oidcRest);
      if (roleOverrides) {
        Object.assign(config.auth.oidc.roles, roleOverrides);
      }
      if (sessionOverrides) {
        Object.assign(config.auth.oidc.session, sessionOverrides);
      }
    }
  }

  if (serverOverrides) {
    const {
      rateLimits: rateLimitOverrides,
      securityHeaders: securityHeaderOverrides,
      ...serverRest
    } = serverOverrides;
    Object.assign(config.server, serverRest);
    if (rateLimitOverrides) {
      if (rateLimitOverrides.backend) {
        Object.assign(
          config.server.rateLimits.backend,
          rateLimitOverrides.backend,
        );
      }
      if (rateLimitOverrides.plan) {
        Object.assign(
          config.server.rateLimits.plan,
          rateLimitOverrides.plan,
        );
      }
      if (rateLimitOverrides.chat) {
        Object.assign(
          config.server.rateLimits.chat,
          rateLimitOverrides.chat,
        );
      }
      if (rateLimitOverrides.auth) {
        Object.assign(
          config.server.rateLimits.auth,
          rateLimitOverrides.auth,
        );
      }
    }
    if (securityHeaderOverrides) {
      for (const [key, value] of Object.entries(securityHeaderOverrides)) {
        if (!value) {
          continue;
        }
        Object.assign(
          config.server.securityHeaders[
            key as keyof AppConfig["server"]["securityHeaders"]
          ],
          value,
        );
      }
    }
  }

  return config;
}

beforeEach(() => {
  getOidcConfigurationMock.mockReset();
  getOidcConfigurationMock.mockImplementation((_req, res) => {
    res.json({ ok: true });
  });
  handleOidcCallbackMock.mockReset();
  getOidcSessionMock.mockReset();
  oidcLogoutMock.mockReset();
});

describe("POST /plan security", () => {
  beforeEach(() => {
    createPlanMock.mockReset();
    createPlanMock.mockResolvedValue({
      id: "plan-123",
      goal: "test goal",
      steps: [
        {
          id: "step-1",
          action: "noop",
          capability: "plan.read",
          capabilityLabel: "Read plan",
          labels: [],
          tool: "noop",
          timeoutSeconds: 0,
          approvalRequired: false,
          input: {},
          metadata: {},
        },
      ],
      successCriteria: ["done"],
    });
    submitPlanStepsMock.mockReset();
    submitPlanStepsMock.mockResolvedValue(undefined);
    policyMock.enforceHttpAction.mockReset();
    policyMock.enforceHttpAction.mockResolvedValue({ allow: true, deny: [] });
    sessionStore.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    sessionStore.clear();
  });

  it("returns 401 when OIDC is enabled and no session is present", async () => {
    const config = buildConfig({
      auth: {
        oidc: {
          enabled: true,
        },
      },
    });

    const app = await createServer(config);

    const response = await request(app)
      .post("/plan")
      .send({ goal: "Ship it" })
      .expect(401);

    expect(response.body).toMatchObject({
      code: "unauthorized",
      message: "authentication required",
    });
    expect(policyMock.enforceHttpAction).not.toHaveBeenCalled();
    expect(createPlanMock).not.toHaveBeenCalled();
    expect(submitPlanStepsMock).not.toHaveBeenCalled();
  });

  it("returns 400 with invalid session details when the session id fails validation", async () => {
    const config = buildConfig({
      auth: {
        oidc: {
          enabled: true,
        },
      },
    });

    const app = await createServer(config);

    const response = await request(app)
      .post("/plan")
      .set("Cookie", "oss_session=bad-token")
      .send({ goal: "Ship it" })
      .expect(400);

    expect(response.body).toMatchObject({
      code: "invalid_request",
      message: "invalid session",
      details: { source: "cookie" },
    });
    expect(policyMock.enforceHttpAction).not.toHaveBeenCalled();
    expect(createPlanMock).not.toHaveBeenCalled();
    expect(submitPlanStepsMock).not.toHaveBeenCalled();
  });

  it("returns 403 and deny details when policy rejects plan creation", async () => {
    const denyDetails = [
      { reason: "agent_profile_missing", capability: "plan.create" },
    ];
    policyMock.enforceHttpAction.mockResolvedValueOnce({
      allow: false,
      deny: denyDetails,
    });

    const app = await createServer(buildConfig());

    const response = await request(app)
      .post("/plan")
      .send({ goal: "Ship it" })
      .expect(403);

    expect(response.body).toMatchObject({
      code: "forbidden",
      details: denyDetails,
      message: "plan.create denied",
    });
    expect(policyMock.enforceHttpAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "http.post.plan",
        requiredCapabilities: ["plan.create"],
      }),
    );
    expect(createPlanMock).not.toHaveBeenCalled();
    expect(submitPlanStepsMock).not.toHaveBeenCalled();
  });
});

describe("security headers and oauth rate limiting", () => {
  it("applies default security headers to responses", async () => {
    const app = await createServer(buildConfig());

    const response = await request(app)
      .get("/auth/oauth/unknown/authorize")
      .expect(404);

    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(response.headers["strict-transport-security"]).toBeUndefined();
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["cross-origin-resource-policy"]).toBe(
      "same-origin",
    );
    expect(response.headers["cross-origin-embedder-policy"]).toBe(
      "require-corp",
    );
    expect(response.headers["x-dns-prefetch-control"]).toBe("off");
  });

  it("emits HSTS when TLS is enabled", async () => {
    const config = buildConfig({
      server: {
        tls: {
          ...buildConfig().server.tls,
          enabled: true,
        },
      },
    });

    const app = await createServer(config);

    const response = await request(app)
      .get("/auth/oauth/unknown/authorize")
      .expect(404);

    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });

  it("allows overriding security headers", async () => {
    const config = buildConfig({
      server: {
        securityHeaders: {
          contentSecurityPolicy: {
            value: "default-src 'self'",
          },
          strictTransportSecurity: {
            value: "max-age=60",
            requireTls: false,
          },
          crossOriginOpenerPolicy: {
            enabled: false,
          },
          xDnsPrefetchControl: {
            value: "on",
          },
        },
      },
    });

    const app = await createServer(config);

    const response = await request(app)
      .get("/auth/oauth/unknown/authorize")
      .expect(404);

    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'self'",
    );
    expect(response.headers["strict-transport-security"]).toBe("max-age=60");
    expect(response.headers["cross-origin-opener-policy"]).toBeUndefined();
    expect(response.headers["x-dns-prefetch-control"]).toBe("on");
  });

  it("rate limits oauth authorization attempts", async () => {
    const config = buildConfig({
      server: {
        rateLimits: {
          ...buildConfig().server.rateLimits,
          auth: {
            windowMs: 60_000,
            maxRequests: 1,
            identityWindowMs: null,
            identityMaxRequests: null,
          },
        },
      },
    });

    const app = await createServer(config);

    await request(app).get("/auth/oauth/unknown/authorize").expect(404);
    const limited = await request(app)
      .get("/auth/oauth/unknown/authorize")
      .expect(429);
    expect(limited.body).toMatchObject({
      code: "too_many_requests",
      message: "oauth rate limit exceeded",
    });
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("rate limits oidc configuration requests", async () => {
    const config = buildConfig({
      auth: {
        oidc: {
          enabled: true,
        },
      },
      server: {
        rateLimits: {
          ...buildConfig().server.rateLimits,
          auth: {
            windowMs: 60_000,
            maxRequests: 1,
            identityWindowMs: null,
            identityMaxRequests: null,
          },
        },
      },
    });

    const app = await createServer(config);

    const success = await request(app).get("/auth/oidc/config").expect(200);
    expect(success.body).toEqual({ ok: true });

    const limited = await request(app)
      .get("/auth/oidc/config")
      .expect(429);
    expect(limited.body).toMatchObject({
      code: "too_many_requests",
      message: "oidc rate limit exceeded",
    });
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(getOidcConfigurationMock).toHaveBeenCalledTimes(1);
  });
});
