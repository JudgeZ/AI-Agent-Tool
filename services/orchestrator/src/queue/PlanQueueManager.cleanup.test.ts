import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlanQueueManager } from "./PlanQueueManager.js";

describe("PlanQueueManager cleanup", () => {
  let manager: PlanQueueManager;

  beforeEach(() => {
    manager = new PlanQueueManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears session tracking on stop", async () => {
    const anyManager = manager as unknown as {
      planSessions: Map<string, string>;
      sessionRefCounts: Map<string, number>;
      stepConsumer?: { stop: () => void };
      completionConsumer?: { stop: () => void };
      stateService?: { close: () => Promise<void> };
    };

    anyManager.planSessions.set("plan-1", "session-1");
    anyManager.sessionRefCounts.set("session-1", 2);
    anyManager.stepConsumer = { stop: vi.fn() };
    anyManager.completionConsumer = { stop: vi.fn() };
    anyManager.stateService = { close: vi.fn().mockResolvedValue(undefined) };

    await manager.stop();

    expect(anyManager.planSessions.size).toBe(0);
    expect(anyManager.sessionRefCounts.size).toBe(0);
  });

  it("clears session tracking on reset", async () => {
    const anyManager = manager as unknown as {
      planSessions: Map<string, string>;
      sessionRefCounts: Map<string, number>;
      stepConsumer?: { stop: () => void };
      completionConsumer?: { stop: () => void };
      stateService?: { clearAll: () => void; close: () => Promise<void> };
      setupServices: () => Promise<void>;
    };

    anyManager.planSessions.set("plan-1", "session-1");
    anyManager.sessionRefCounts.set("session-1", 1);
    anyManager.stepConsumer = { stop: vi.fn() };
    anyManager.completionConsumer = { stop: vi.fn() };
    anyManager.stateService = {
      clearAll: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(anyManager, "setupServices").mockResolvedValue(undefined);

    await manager.reset();

    expect(anyManager.planSessions.size).toBe(0);
    expect(anyManager.sessionRefCounts.size).toBe(0);
  });
});
