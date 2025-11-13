import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GenericContainer } from "testcontainers";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  submitPlanSteps,
  resetPlanQueueRuntime,
  initializePlanQueueRuntime,
  PLAN_COMPLETIONS_QUEUE
} from "./PlanQueueRuntime.js";
import { getQueueAdapter, resetQueueAdapter } from "./QueueAdapter.js";
import type { Plan } from "../plan/planner.js";
import * as events from "../plan/events.js";
import { appLogger } from "../observability/logger.js";

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

async function waitForCondition(condition: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
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
  const publishSpy = vi.spyOn(events, "publishPlanStepEvent");

  afterAll(() => {
    publishSpy.mockRestore();
  });

  it("processes plan steps end-to-end using RabbitMQ", async () => {
    policyMock.enforcePlanStep.mockReset();
    policyMock.enforcePlanStep.mockResolvedValue({ allow: true, deny: [] });
    executeTool.mockReset();
    publishSpy.mockClear();

    let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
    const rabbitUrlOverride = process.env.CI_RABBITMQ_URL?.trim();
    const prefetchOverride = process.env.CI_RABBITMQ_PREFETCH?.trim();
    let rabbitUrl: string | undefined;
    try {
      if (!rabbitUrlOverride) {
        container = await new GenericContainer("rabbitmq:3.13-management")
          .withExposedPorts(5672)
          .start();
        const mappedPort = container.getMappedPort(5672);
        const host = container.getHost();
        rabbitUrl = `amqp://guest:guest@${host}:${mappedPort}`;
      } else {
        rabbitUrl = rabbitUrlOverride;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Could not find a working container runtime")) {
        appLogger.warn(
          { event: "test.skip", reason: "missing_container_runtime", test: "PlanQueueRuntime.rabbitmq" },
          "Skipping RabbitMQ integration test because no container runtime is available",
        );
        return;
      }
      throw error;
    }

    if (!rabbitUrl) {
      throw new Error("RabbitMQ URL was not configured for the test");
    }

    const previousUrl = process.env.RABBITMQ_URL;
    const previousPrefetch = process.env.RABBITMQ_PREFETCH;
    let tempDir: string | undefined;

    try {
      process.env.RABBITMQ_URL = rabbitUrl;
      process.env.RABBITMQ_PREFETCH = prefetchOverride ?? "1";

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-state-rmq-"));
      process.env.PLAN_STATE_PATH = path.join(tempDir, "state.json");

      resetPlanQueueRuntime();
      resetQueueAdapter();

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
        publishSpy.mock.calls.some(([event]) => event.step.id === plan.steps[0]!.id && event.step.state === "completed")
      );

      expect(executeTool).toHaveBeenCalledTimes(1);
      const [invocation] = executeTool.mock.calls[0] ?? [];
      expect(invocation).toMatchObject({
        planId: plan.id,
        stepId: plan.steps[0]!.id,
        tool: plan.steps[0]!.tool
      });
    } finally {
      process.env.RABBITMQ_URL = previousUrl;
      process.env.RABBITMQ_PREFETCH = previousPrefetch;
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      if (container) {
        await container.stop();
      }
    }
  });

  it("dead-letters forged completion messages", async () => {
    executeTool.mockReset();
    publishSpy.mockClear();

    let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
    const rabbitUrlOverride = process.env.CI_RABBITMQ_URL?.trim();
    const prefetchOverride = process.env.CI_RABBITMQ_PREFETCH?.trim();
    let rabbitUrl: string | undefined;
    try {
      if (!rabbitUrlOverride) {
        container = await new GenericContainer("rabbitmq:3.13-management")
          .withExposedPorts(5672)
          .start();
        const mappedPort = container.getMappedPort(5672);
        const host = container.getHost();
        rabbitUrl = `amqp://guest:guest@${host}:${mappedPort}`;
      } else {
        rabbitUrl = rabbitUrlOverride;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Could not find a working container runtime")) {
        appLogger.warn(
          { event: "test.skip", reason: "missing_container_runtime", test: "PlanQueueRuntime.rabbitmq" },
          "Skipping RabbitMQ integration test because no container runtime is available",
        );
        return;
      }
      throw error;
    }

    if (!rabbitUrl) {
      throw new Error("RabbitMQ URL was not configured for the test");
    }

    const previousUrl = process.env.RABBITMQ_URL;
    const previousPrefetch = process.env.RABBITMQ_PREFETCH;
    let tempDir: string | undefined;

    try {
      process.env.RABBITMQ_URL = rabbitUrl;
      process.env.RABBITMQ_PREFETCH = prefetchOverride ?? "1";

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-state-rmq-"));
      process.env.PLAN_STATE_PATH = path.join(tempDir, "state.json");

      resetPlanQueueRuntime();
      resetQueueAdapter();

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
        { timeout: 10000 },
      );

      const forgedEvents = publishSpy.mock.calls.filter(
        ([event]) =>
          event.planId === forgedPlanId && event.step.id === "ghost-step",
      );
      expect(forgedEvents).toHaveLength(0);
    } finally {
      process.env.RABBITMQ_URL = previousUrl;
      process.env.RABBITMQ_PREFETCH = previousPrefetch;
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      if (container) {
        await container.stop();
      }
    }
  });
});

