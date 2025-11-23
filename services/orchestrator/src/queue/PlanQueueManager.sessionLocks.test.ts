import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import * as DistributedLockService from "../services/DistributedLockService.js";
import * as PlanStateStore from "./PlanStateStore.js";

import { PlanQueueManager } from "./PlanQueueManager.js";

const dummyStep = { id: "step-1", action: "test", tool: "noop", capability: "run", capabilityLabel: "Run" } as any;

describe("PlanQueueManager session lock tracking", () => {
  let manager: PlanQueueManager;

  beforeEach(() => {
    manager = new PlanQueueManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers LOCK_REDIS_URL when selecting the distributed lock service", async () => {
    const originalLockRedisUrl = process.env.LOCK_REDIS_URL;
    const originalRedisUrl = process.env.REDIS_URL;

    const lockRedisUrl = "redis://lock-specific:6379";
    const rateLimitRedisUrl = "redis://rate-limit:6379";
    process.env.LOCK_REDIS_URL = lockRedisUrl;
    process.env.REDIS_URL = "redis://general:6379";

    const getLockServiceSpy = vi
      .spyOn(DistributedLockService, "getDistributedLockService")
      .mockResolvedValue({} as any);
    vi.spyOn(PlanStateStore, "createPlanStateStore").mockReturnValue({} as any);

    const anyManager = manager as unknown as { config: any; setupServices: () => Promise<void> };
    anyManager.config = {
      planState: { backend: "file" },
      retention: { planStateDays: 0, contentCapture: { enabled: false } },
      server: { rateLimits: { backend: { provider: "redis", redisUrl: rateLimitRedisUrl } } },
    };

    try {
      await anyManager.setupServices();
    } finally {
      process.env.LOCK_REDIS_URL = originalLockRedisUrl;
      process.env.REDIS_URL = originalRedisUrl;
    }

    expect(getLockServiceSpy).toHaveBeenCalledWith(lockRedisUrl);
  });

  it("rolls back session tracking when submission fails after restore", async () => {
    const anyManager = manager as unknown as {
      initialize: () => Promise<void>;
      stateService: any;
      planSessions: Map<string, string>;
      sessionRefCounts: Map<string, number>;
      fileLockManager: any;
      releaseNextPlanSteps: (planId: string) => Promise<void>;
    };

    anyManager.initialize = vi.fn().mockResolvedValue(undefined);
    anyManager.fileLockManager = {
      restoreSessionLocks: vi.fn().mockResolvedValue(undefined),
      releaseSessionLocks: vi.fn().mockResolvedValue(undefined),
    };
    anyManager.stateService = {
      setPlanSubject: vi.fn(),
      clearRetainedPlanSubject: vi.fn(),
      deletePlanSubject: vi.fn(),
      withPlanLock: async (_planId: string, cb: () => Promise<void>) => cb(),
      rememberPlanMetadata: vi.fn().mockRejectedValue(new Error("persist failed")),
      getPlanSubject: vi.fn().mockReturnValue(undefined),
      clearApprovals: vi.fn(),
      forgetStep: vi.fn(),
      deleteRegistryEntry: vi.fn(),
    };
    vi.spyOn(anyManager, "releaseNextPlanSteps").mockResolvedValue();

    const subject = { sessionId: "sess", roles: [], scopes: [], tenantId: "t-1" } as any;

    await expect(
      manager.submitPlanSteps({ id: "plan-1", steps: [dummyStep] } as any, "trace", "req-1", subject),
    ).rejects.toThrow("persist failed");

    expect(anyManager.planSessions.has("plan-1")).toBe(false);
    expect(anyManager.sessionRefCounts.has("sess")).toBe(false);
    expect(anyManager.fileLockManager.releaseSessionLocks).toHaveBeenCalledWith("sess");
  });

  it("increments ref counts per plan during rehydrate while restoring locks once", async () => {
    const anyManager = manager as unknown as {
      stateService: any;
      planSessions: Map<string, string>;
      sessionRefCounts: Map<string, number>;
      fileLockManager: any;
      emitPlanEvent: (...args: any[]) => Promise<void>;
    };

    const persistedSteps = [
      {
        idempotencyKey: "key-1",
        planId: "plan-a",
        step: dummyStep,
        attempt: 0,
        createdAt: new Date().toISOString(),
        traceId: "trace",
        requestId: "req",
        subject: { sessionId: "sess" },
        state: "waiting_approval",
      },
      {
        idempotencyKey: "key-2",
        planId: "plan-b",
        step: dummyStep,
        attempt: 0,
        createdAt: new Date().toISOString(),
        traceId: "trace",
        requestId: "req",
        subject: { sessionId: "sess" },
        state: "waiting_approval",
      },
    ];

    anyManager.stateService = {
      listActiveSteps: vi.fn().mockResolvedValue(persistedSteps),
      getRegistryEntry: vi.fn().mockReturnValue(undefined),
      setRegistryEntry: vi.fn(),
      getPlanSubject: vi.fn(),
    };
    anyManager.fileLockManager = { restoreSessionLocks: vi.fn().mockResolvedValue(undefined) };
    anyManager.emitPlanEvent = vi.fn().mockResolvedValue(undefined);

    await manager.rehydratePendingSteps();

    expect(anyManager.sessionRefCounts.get("sess")).toBe(2);
    expect(anyManager.fileLockManager.restoreSessionLocks).toHaveBeenCalledTimes(1);
    expect(anyManager.planSessions.get("plan-a")).toBe("sess");
    expect(anyManager.planSessions.get("plan-b")).toBe("sess");
  });
});
