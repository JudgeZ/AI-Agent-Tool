import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Response } from "express";
import { PlanController } from "./PlanController.js";
import type { AppConfig } from "../config.js";
import type { PolicyEnforcer } from "../policy/PolicyEnforcer.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import type { SseQuotaManager } from "../server/SseQuotaManager.js";
import type { ExtendedRequest } from "../http/types.js";
import * as planModule from "../plan/index.js";
import * as queueModule from "../queue/PlanQueueRuntime.js";

// Mock dependencies
vi.mock("../plan/index.js");
vi.mock("../queue/PlanQueueRuntime.js");
vi.mock("../plan/events.js");
vi.mock("../observability/audit.js", () => ({
    logAuditEvent: vi.fn(),
    toAuditSubject: vi.fn(),
}));
vi.mock("../http/helpers.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../http/helpers.js")>();
    return {
        ...actual,
        getRequestIds: vi.fn().mockReturnValue({ requestId: "req-1", traceId: "trace-1" }),
    };
});
vi.mock("../http/requestIdentity.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../http/requestIdentity.js")>();
    return {
        ...actual,
        createRequestIdentity: vi.fn().mockReturnValue({ agentName: "test-agent", ip: "127.0.0.1" }),
    };
});

describe("PlanController", () => {
  let controller: PlanController;
  let config: AppConfig;
  let policy: PolicyEnforcer;
  let rateLimiter: RateLimitStore;
  let quotaManager: SseQuotaManager;
  let req: Partial<ExtendedRequest>;
  let res: Partial<Response>;

  beforeEach(() => {
    config = {
      auth: { oidc: { enabled: false } },
      server: { rateLimits: { plan: { limit: 10, windowMs: 1000 } } },
      retention: { planArtifactsDays: 7 },
      runMode: "production",
    } as any;

    policy = {
      enforceHttpAction: vi.fn().mockResolvedValue({ allow: true }),
    } as any;

    rateLimiter = {
      allow: vi.fn().mockResolvedValue({ allowed: true }),
    } as any;

    quotaManager = {
      acquire: vi.fn().mockReturnValue(() => {}),
    } as any;

    controller = new PlanController(config, policy, rateLimiter, quotaManager);

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
      locals: {},
    } as any;
  });

  it("creates a plan successfully", async () => {
    req.body = { goal: "test goal" };
    const mockPlan = { id: "plan-1", steps: [] };
    vi.mocked(planModule.createPlan).mockResolvedValue(mockPlan as any);
    vi.mocked(queueModule.submitPlanSteps).mockResolvedValue(undefined);

    await controller.createPlan(req as ExtendedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ plan: mockPlan }));
    expect(planModule.createPlan).toHaveBeenCalledWith("test goal", expect.anything());
    expect(queueModule.submitPlanSteps).toHaveBeenCalled();
  });

  it("enforces rate limits", async () => {
    req.body = { goal: "test goal" };
    rateLimiter.allow = vi.fn().mockResolvedValue({ allowed: false });

    await controller.createPlan(req as ExtendedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("enforces policy", async () => {
    req.body = { goal: "test goal" };
    policy.enforceHttpAction = vi.fn().mockResolvedValue({ allow: false, deny: [{ reason: "denied" }] });

    await controller.createPlan(req as ExtendedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("validates input", async () => {
    req.body = {}; // Missing goal

    await controller.createPlan(req as ExtendedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
