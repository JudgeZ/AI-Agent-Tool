import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "../observability/logger.js";

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

describe("initializePlanQueueRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    restoreEnv();
    process.env.QUEUE_INIT_MAX_ATTEMPTS = "3";
    process.env.QUEUE_INIT_BACKOFF_MS = "0";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    restoreEnv();
  });

  it("retries when the queue adapter connection fails initially", async () => {
    const adapter = {
      consume: vi.fn().mockResolvedValue(undefined)
    };

    const getQueueAdapter = vi
      .fn()
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValue(adapter);

    vi.doMock("./QueueAdapter.js", () => ({
      getQueueAdapter
    }));

    vi.doMock("../grpc/AgentClient.js", () => ({
      getToolAgentClient: vi.fn(),
      resetToolAgentClient: vi.fn(),
      ToolClientError: class extends Error {}
    }));

    const loggerMock = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    };
    vi.spyOn(appLogger, "child").mockReturnValue(loggerMock as any);

    const module = await import("./PlanQueueRuntime.js");

    await expect(module.initializePlanQueueRuntime()).resolves.toBeUndefined();

    // First attempt fails (one call), subsequent successful attempt initializes consumers.
    expect(getQueueAdapter.mock.calls.length).toBeGreaterThanOrEqual(2);

    module.resetPlanQueueRuntime();
  }, 10000);

  it("throws after exhausting all retry attempts", async () => {
    process.env.QUEUE_INIT_MAX_ATTEMPTS = "2";

    const getQueueAdapter = vi.fn().mockRejectedValue(new Error("broker offline"));

    vi.doMock("./QueueAdapter.js", () => ({
      getQueueAdapter
    }));

    vi.doMock("../grpc/AgentClient.js", () => ({
      getToolAgentClient: vi.fn(),
      resetToolAgentClient: vi.fn(),
      ToolClientError: class extends Error {}
    }));

    const loggerMock = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    };
    vi.spyOn(appLogger, "child").mockReturnValue(loggerMock as any);

    const module = await import("./PlanQueueRuntime.js");

    await expect(module.initializePlanQueueRuntime()).rejects.toThrow("broker offline");

    module.resetPlanQueueRuntime();
  });
});
