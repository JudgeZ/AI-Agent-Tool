import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GenericContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import {
  submitPlanSteps,
  resetPlanQueueRuntime,
  initializePlanQueueRuntime,
  PLAN_COMPLETIONS_QUEUE
} from "./PlanQueueRuntime.js";
import { getQueueAdapter, resetQueueAdapter } from "./QueueAdapter.js";
import type { Plan } from "../plan/planner.js";
import * as events from "../plan/events.js";
import type { PlanStepEvent } from "../plan/events.js";
import { appLogger } from "../observability/logger.js";
import { invalidateConfigCache } from "../config.js";

const executeTool = vi.fn();

const policyMock = vi.hoisted(() => ({
  enforcePlanStep: vi.fn(async () => ({ allow: true, deny: [] as unknown[] }))
}));

vi.mock("../policy/PolicyEnforcer.js", () => {
  return {
    getPolicyEnforcer: () => policyMock,
    PolicyViolationError: class extends Error {}
  };
});

vi.mock("../grpc/AgentClient.js", () => {
  return {
    getToolAgentClient: () => ({
      executeTool
    }),
    resetToolAgentClient: vi.fn()
  };
});

vi.mock("../services/DistributedLockService.js", () => {
  return {
    DistributedLockService: class {
      async connect() { return; }
      async disconnect() { return; }
      async acquireLock() {
        return async () => { return; };
      }
    }
  };
});

async function waitForCondition(condition: () => boolean, timeoutMs = 15000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("PlanQueueRuntime (RabbitMQ integration)", () => {
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
  let skipSuite = false;
  let rabbitUrl: string | undefined;
  let publishSpy: MockInstance<(event: PlanStepEvent) => void> | undefined;
  let planStateDir: string | undefined;
  let previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const rabbitUrlOverride = process.env.CI_RABBITMQ_URL?.trim();
    if (rabbitUrlOverride) {
      rabbitUrl = rabbitUrlOverride;
      return;
    }

    try {
      const containerStart = new GenericContainer("rabbitmq:3.13-management")
        .withExposedPorts(5672)
        .start();

      container = await Promise.race([
        containerStart,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Container start timed out")), 60000))
      ]);

      const mappedPort = container.getMappedPort(5672);
      const host = container.getHost();
      rabbitUrl = `amqp://guest:guest@${host}:${mappedPort}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Could not find a working container runtime") || message.includes("Container start timed out")) {
        appLogger.warn(
          { event: "test.skip", reason: "missing_container_runtime", test: "PlanQueueRuntime.rabbitmq" },
          "Skipping RabbitMQ integration test because no container runtime is available or timed out",
        );
        skipSuite = true;
        return;
      }
      throw error;
    }
  }, 120000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  beforeEach(async () => {
    executeTool.mockReset();
    policyMock.enforcePlanStep.mockReset();
    policyMock.enforcePlanStep.mockResolvedValue({ allow: true, deny: [] });
    
    if (skipSuite) {
      return;
    }

    if (!rabbitUrl) {
      throw new Error("RabbitMQ URL was not configured for the test");
    }

    publishSpy = vi.spyOn(events, "publishPlanStepEvent");

    const prefetchOverride = process.env.CI_RABBITMQ_PREFETCH?.trim();
    planStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-state-rmq-"));
    
    previousEnv = {
      PLAN_STATE_PATH: process.env.PLAN_STATE_PATH,
      RABBITMQ_URL: process.env.RABBITMQ_URL,
      RABBITMQ_PREFETCH: process.env.RABBITMQ_PREFETCH
    };

    process.env.PLAN_STATE_PATH = path.join(planStateDir, "state.json");
    process.env.RABBITMQ_URL = rabbitUrl;
    process.env.RABBITMQ_PREFETCH = prefetchOverride ?? "1";
    
    invalidateConfigCache();
    resetPlanQueueRuntime();
    resetQueueAdapter();
  });

  afterEach(async () => {
    if (publishSpy) {
      publishSpy.mockRestore();
      publishSpy = undefined;
    }

    if (skipSuite) {
      return;
    }

    resetPlanQueueRuntime();
    resetQueueAdapter();
    invalidateConfigCache();

    if (planStateDir) {
        await fs.rm(planStateDir, { recursive: true, force: true });
    }
    
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
  });

  it("processes plan steps end-to-end using RabbitMQ", async () => {
    if (skipSuite) {
        expect(true).toBe(true);
        return;
    }

    const plan: Plan = {
      id: "plan-rabbitmq",
      goal: "Verify RabbitMQ integration",
      steps: [
        {
          id: "step-1",
          action: "Execute tool",
          capability: "test.run",
          capabilityLabel: "Run test",
          labels: [],
          tool: "testTool",
          timeoutSeconds: 5,
          approvalRequired: false,
          input: {},
          metadata: {}
        }
      ],
      successCriteria: ["completed"]
    };

    executeTool.mockResolvedValue([
      {
        invocationId: "inv-1",
        planId: plan.id,
        stepId: plan.steps[0]!.id,
        state: "completed",
        summary: "Tool finished",
        occurredAt: new Date().toISOString()
      }
    ]);

    await submitPlanSteps(plan, "trace-rabbitmq", undefined);

    await waitForCondition(() => executeTool.mock.calls.length > 0);
    await waitForCondition(() =>
      publishSpy!.mock.calls.some(([event]) => event.step.id === plan.steps[0]!.id && event.step.state === "completed")
    );

    expect(executeTool).toHaveBeenCalledTimes(1);
    const [invocation] = executeTool.mock.calls[0] ?? [];
    expect(invocation).toMatchObject({
      planId: plan.id,
      stepId: plan.steps[0]!.id,
      tool: plan.steps[0]!.tool
    });
  }, 120000);

  it("dead-letters forged completion messages", async () => {
    if (skipSuite) {
        expect(true).toBe(true);
        return;
    }

    await initializePlanQueueRuntime();
    const adapter = await getQueueAdapter();

    const forgedPlanId = `forged-plan-${Date.now()}`;
    await adapter.enqueue(
      PLAN_COMPLETIONS_QUEUE,
      {
        planId: forgedPlanId,
        stepId: "ghost-step",
        state: "completed",
        summary: "forged completion",
      },
      {
        headers: {
          "trace-id": "trace-forged",
          "x-idempotency-key": `${forgedPlanId}:ghost-step`,
        },
      },
    );

    await vi.waitFor(
      async () => {
        expect(
          await adapter.getQueueDepth(PLAN_COMPLETIONS_QUEUE),
        ).toBe(0);
      },
      { timeout: 30000 },
    );

    const forgedEvents = publishSpy!.mock.calls.filter(
      ([event]) =>
        event.planId === forgedPlanId && event.step.id === "ghost-step",
    );
    expect(forgedEvents).toHaveLength(0);
  }, 120000);
});
