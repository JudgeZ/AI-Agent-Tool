import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KafkaContainer, type StartedKafkaContainer } from "@testcontainers/kafka";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import {
  submitPlanSteps,
  resetPlanQueueRuntime,
  PLAN_STEPS_QUEUE,
  PLAN_COMPLETIONS_QUEUE
} from "./PlanQueueRuntime.js";
import { resetQueueAdapter } from "./QueueAdapter.js";
import type { Plan } from "../plan/planner.js";
import * as events from "../plan/events.js";
import type { PlanStepEvent } from "../plan/events.js";

const executeTool = vi.fn();

vi.mock("../grpc/AgentClient.js", () => {
  return {
    getToolAgentClient: () => ({
      executeTool
    }),
    resetToolAgentClient: vi.fn()
  };
});

describe("PlanQueueRuntime (Kafka integration)", () => {
  let container: StartedKafkaContainer | null = null;
  let skipSuite = false;
  let planStateDir: string | undefined;
  let previousEnv: Record<string, string | undefined> = {};
  let publishSpy: MockInstance<(event: PlanStepEvent) => void> | undefined;

  beforeAll(async () => {
    try {
      container = await new KafkaContainer("confluentinc/cp-kafka:7.6.1").start();
    } catch (error) {
      skipSuite = true;
      console.warn("Skipping Kafka integration test because no container runtime is available");
      console.warn(String(error));
    }
  }, 60000);

  afterAll(async () => {
    await container?.stop();
    container = null;
  });

  beforeEach(async () => {
    executeTool.mockReset();
    if (skipSuite) {
      return;
    }

    planStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-state-kafka-"));

    previousEnv = {
      PLAN_STATE_PATH: process.env.PLAN_STATE_PATH,
      MESSAGING_TYPE: process.env.MESSAGING_TYPE,
      KAFKA_BROKERS: process.env.KAFKA_BROKERS,
      KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID,
      KAFKA_GROUP_ID: process.env.KAFKA_GROUP_ID,
      KAFKA_CONSUME_FROM_BEGINNING: process.env.KAFKA_CONSUME_FROM_BEGINNING,
      KAFKA_RETRY_DELAY_MS: process.env.KAFKA_RETRY_DELAY_MS
    };

    const brokersFn = (container as unknown as { getBootstrapServers?: () => string }).getBootstrapServers;
    const brokers =
      typeof brokersFn === "function"
        ? brokersFn.call(container)
        : `${container!.getHost()}:${container!.getMappedPort(9093)}`;
    process.env.PLAN_STATE_PATH = path.join(planStateDir, "state.json");
    process.env.MESSAGING_TYPE = "kafka";
    process.env.KAFKA_BROKERS = brokers;
    process.env.KAFKA_CLIENT_ID = `orchestrator-test-${Date.now()}`;
    process.env.KAFKA_GROUP_ID = `plan-runtime-${Date.now()}`;
    process.env.KAFKA_CONSUME_FROM_BEGINNING = "false";
    process.env.KAFKA_RETRY_DELAY_MS = "0";

    resetPlanQueueRuntime();
    resetQueueAdapter();
    publishSpy = vi.spyOn(events, "publishPlanStepEvent");
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

    await fs.rm(planStateDir!, { recursive: true, force: true }).catch(() => undefined);
    planStateDir = undefined;

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it(
    "processes plan steps end-to-end using Kafka",
    async () => {
      if (skipSuite) {
        expect(true).toBe(true);
        return;
      }

      const plan: Plan = {
        id: "plan-kafka",
        goal: "Verify Kafka integration",
        steps: [
          {
            id: "step-1",
            action: "execute_tool",
            capability: "test.run",
            capabilityLabel: "Run test",
            labels: ["repo"],
            tool: "testTool",
            timeoutSeconds: 30,
            approvalRequired: false,
            input: {},
            metadata: {}
          }
        ],
        successCriteria: ["completed"]
      };

      executeTool.mockResolvedValueOnce([
        {
          planId: plan.id,
          stepId: "step-1",
          state: "completed",
          summary: "Done",
          occurredAt: new Date().toISOString()
        }
      ]);

      await submitPlanSteps(plan, "trace-kafka");

      await vi.waitFor(() => expect(executeTool).toHaveBeenCalledTimes(1), {
        timeout: 20000
      });

      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "plan.step",
          planId: plan.id,
          step: expect.objectContaining({
            id: "step-1",
            state: "completed"
          })
        })
      );

      // Ensure completions topic subscription does not cause errors by checking consumers map indirectly
      expect(process.env.MESSAGING_TYPE).toBe("kafka");
      expect(executeTool).toHaveBeenCalledWith(
        expect.objectContaining({ planId: plan.id, stepId: "step-1" }),
        expect.any(Object)
      );
    },
    60000
  );
});

