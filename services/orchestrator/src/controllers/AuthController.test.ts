import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Response } from "express";
import { AuthController } from "./AuthController.js";
import type { AppConfig } from "../config.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import type { ExtendedRequest } from "../http/types.js";
import * as oauthController from "../auth/OAuthController.js";
import * as oidcController from "../auth/OidcController.js";

// Mock dependencies
vi.mock("../auth/OAuthController.js");
vi.mock("../auth/OidcController.js");
vi.mock("../http/requestIdentity.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../http/requestIdentity.js")>();
    return {
        ...actual,
        createRequestIdentity: vi.fn().mockReturnValue({ agentName: "test-agent", ip: "127.0.0.1" }),
    };
});
vi.mock("../observability/audit.js", () => ({
    logAuditEvent: vi.fn(),
    toAuditSubject: vi.fn(),
}));
vi.mock("../http/helpers.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../http/helpers.js")>();
    return {
        ...actual,
        getRequestIds: vi.fn().mockReturnValue({ requestId: "req-1", traceId: "trace-1" }),
        toAuditSubject: vi.fn().mockImplementation((s) => s),
    };
});

describe("AuthController", () => {
  let controller: AuthController;
  let config: AppConfig;
  let rateLimiter: RateLimitStore;
  let req: Partial<ExtendedRequest>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      auth: { oidc: { enabled: true } },
      server: { rateLimits: { auth: { maxRequests: 10, windowMs: 1000 } } },
      runMode: "production",
    } as any;

    rateLimiter = {
      allow: vi.fn().mockResolvedValue({ allowed: true }),
    } as any;

    controller = new AuthController(config, rateLimiter);

    req = {
      body: {},
      auth: { session: { tenantId: "tenant-1", subject: "user-1", id: "session-1", roles: [], scopes: [], issuedAt: "", expiresAt: "", claims: {} } },
      headers: {},
    };

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn(),
      setHeader: vi.fn(),
      getHeader: vi.fn().mockReturnValue("test-header"),
    } as any;
  });

  it("delegates oauth authorize", async () => {
    await controller.oauthAuthorize(req as ExtendedRequest, res as Response);
    expect(oauthController.authorize).toHaveBeenCalled();
  });

  it("delegates oauth callback", async () => {
    await controller.oauthCallback(req as ExtendedRequest, res as Response);
    expect(oauthController.callback).toHaveBeenCalled();
  });

  it("delegates oidc config", async () => {
    await controller.getOidcConfig(req as ExtendedRequest, res as Response);
    expect(oidcController.getOidcConfiguration).toHaveBeenCalled();
  });

  it("enforces rate limits on oauth", async () => {
    rateLimiter.allow = vi.fn().mockResolvedValue({ allowed: false });
    await controller.oauthAuthorize(req as ExtendedRequest, res as Response);
    expect(oauthController.authorize).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("enforces rate limits on oidc", async () => {
    rateLimiter.allow = vi.fn().mockResolvedValue({ allowed: false });
    await controller.getOidcConfig(req as ExtendedRequest, res as Response);
    expect(oidcController.getOidcConfiguration).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
