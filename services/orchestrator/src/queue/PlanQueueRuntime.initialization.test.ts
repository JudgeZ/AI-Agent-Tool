import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const module = await import("./PlanQueueRuntime.js");

    await expect(module.initializePlanQueueRuntime()).resolves.toBeUndefined();

    // First attempt fails (one call), subsequent successful attempt initializes two consumers.
    expect(getQueueAdapter.mock.calls.length).toBeGreaterThanOrEqual(3);

    const firstCall = consoleError.mock.calls[0];
    expect(firstCall?.[0]).toBe("plan.queue_runtime.initialization_failed");
    expect(firstCall?.[1]).toMatchObject({ attempt: 1, maxAttempts: 3, willRetry: true });
    expect(firstCall?.[2]).toBeInstanceOf(Error);

    module.resetPlanQueueRuntime();
  });

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

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const module = await import("./PlanQueueRuntime.js");

    await expect(module.initializePlanQueueRuntime()).rejects.toThrow("broker offline");

    expect(consoleError.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = consoleError.mock.calls[consoleError.mock.calls.length - 1];
    expect(lastCall?.[1]).toMatchObject({ attempt: 2, maxAttempts: 2, willRetry: false });

    module.resetPlanQueueRuntime();
  });
});
