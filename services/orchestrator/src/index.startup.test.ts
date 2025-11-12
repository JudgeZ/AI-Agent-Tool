import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "./observability/logger.js";

const originalNodeEnv = process.env.NODE_ENV;

describe("bootstrapOrchestrator", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("logs and rejects when the queue runtime cannot initialize", async () => {
    const initializePlanQueueRuntime = vi.fn().mockRejectedValue(new Error("queue offline"));

    vi.doMock("./queue/PlanQueueRuntime.js", () => ({
      initializePlanQueueRuntime,
      submitPlanSteps: vi.fn(),
      resolvePlanStepApproval: vi.fn()
    }));

    vi.spyOn(appLogger, "error").mockImplementation(() => undefined);

    const module = await import("./index.js");

    const createServerSpy = vi.spyOn(module, "createServer");
    const createHttpServerSpy = vi.spyOn(module, "createHttpServer");

    await expect(module.bootstrapOrchestrator()).rejects.toThrow("queue offline");

    expect(initializePlanQueueRuntime).toHaveBeenCalledTimes(1);
    expect(createServerSpy).not.toHaveBeenCalled();
    expect(createHttpServerSpy).not.toHaveBeenCalled();
  }, 10000);
});
