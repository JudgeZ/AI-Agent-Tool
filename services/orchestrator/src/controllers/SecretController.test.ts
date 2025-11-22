import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Response } from "express";
import { SecretController } from "./SecretController.js";
import type { AppConfig } from "../config.js";
import type { PolicyEnforcer } from "../policy/PolicyEnforcer.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import type { ExtendedRequest } from "../http/types.js";
import * as providerRegistry from "../providers/ProviderRegistry.js";

// Mock dependencies
vi.mock("../providers/ProviderRegistry.js");
vi.mock("../http/requestIdentity.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../http/requestIdentity.js")>();
    return {
        ...actual,
        createRequestIdentity: vi.fn().mockReturnValue({ agentName: "test-agent", ip: "127.0.0.1" }),
        extractAgent: vi.fn().mockReturnValue("test-agent"),
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
        toPolicySubject: vi.fn().mockImplementation((s) => s),
        resolveAuthFailure: vi.fn().mockReturnValue({ status: 401, code: "unauthorized" }),
        buildAuthFailureAuditDetails: vi.fn().mockReturnValue({}),
    };
});

describe("SecretController", () => {
  let controller: SecretController;
  let config: AppConfig;
  let policy: PolicyEnforcer;
  let rateLimiter: RateLimitStore;
  let req: Partial<ExtendedRequest>;
  let res: Partial<Response>;
  let mockManager: any;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      auth: { oidc: { enabled: false } },
      server: { rateLimits: { secrets: { limit: 10, windowMs: 1000 } } },
      runMode: "production",
    } as any;

    policy = {
      enforceHttpAction: vi.fn().mockResolvedValue({ allow: true }),
    } as any;

    rateLimiter = {
      allow: vi.fn().mockResolvedValue({ allowed: true }),
    } as any;

    mockManager = {
        rotate: vi.fn(),
        promote: vi.fn(),
        listVersions: vi.fn(),
    };
    vi.mocked(providerRegistry.getVersionedSecretsManager).mockReturnValue(mockManager);

    controller = new SecretController(config, policy, rateLimiter);

    req = {
      params: {},
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
      locals: {},
    } as any;
  });

  it("rotates secret successfully", async () => {
    req.params = { key: "my-secret" };
    req.body = { value: "new-value", retain: 5 };
    mockManager.rotate.mockResolvedValue({ id: "v2" });

    await controller.rotateSecret(req as ExtendedRequest, res as Response);

    expect(mockManager.rotate).toHaveBeenCalledWith("my-secret", "new-value", expect.objectContaining({ retain: 5 }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ version: { id: "v2" } }));
  });

  it("promotes secret successfully", async () => {
    req.params = { key: "my-secret" };
    req.body = { versionId: "v2" };
    mockManager.promote.mockResolvedValue({ id: "v2" });

    await controller.promoteSecret(req as ExtendedRequest, res as Response);

    expect(mockManager.promote).toHaveBeenCalledWith("my-secret", "v2");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ version: { id: "v2" } }));
  });

  it("enforces policy on rotate", async () => {
    req.params = { key: "my-secret" };
    req.body = { value: "new-value" };
    policy.enforceHttpAction = vi.fn().mockResolvedValue({ allow: false, deny: [{ reason: "denied" }] });

    await controller.rotateSecret(req as ExtendedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockManager.rotate).not.toHaveBeenCalled();
  });

  it("validates input on rotate", async () => {
    req.params = { key: "my-secret" };
    req.body = {}; // Missing value

    await controller.rotateSecret(req as ExtendedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("gets secret versions successfully", async () => {
    req.params = { key: "my-secret" };
    mockManager.listVersions.mockResolvedValue({ versions: [] });

    await controller.getSecretVersions(req as ExtendedRequest, res as Response);

    expect(mockManager.listVersions).toHaveBeenCalledWith("my-secret");
    expect(res.json).toHaveBeenCalled();
  });
});

