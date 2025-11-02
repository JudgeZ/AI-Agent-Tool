import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type {
  EnqueueOptions,
  QueueAdapter,
  QueueHandler,
  QueueMessage,
  RetryOptions
} from "./QueueAdapter.js";
import type { PlanStepEvent } from "../plan/events.js";
import { ToolClientError } from "../grpc/AgentClient.js";
type EventsModule = typeof import("../plan/events.js");
type PublishSpy = Mock<EventsModule["publishPlanStepEvent"]>;

class MockEnvelope<T> {
  constructor(
    public readonly payload: T,
    public readonly headers: Record<string, string>,
    public attempts: number = 0
  ) {}

  acked = false;
  inFlight = false;
}

class MockQueueAdapter implements QueueAdapter {
  private readonly consumers = new Map<string, QueueHandler<any>>();
  private readonly queues = new Map<string, MockEnvelope<any>[]>();
  private readonly events = new EventEmitter();
  readonly retryDelays: number[] = [];

  async connect(): Promise<void> {
    // no-op
  }

  async close(): Promise<void> {
    this.consumers.clear();
    this.queues.clear();
  }

  async enqueue<T>(queue: string, payload: T, options?: EnqueueOptions): Promise<void> {
    const headers = options?.headers ? { ...options.headers } : {};
    const payloadAttempt =
      payload && typeof payload === "object" && payload !== null && "job" in (payload as Record<string, unknown>)
        ? Number((payload as Record<string, any>).job?.attempt ?? 0)
        : undefined;
    const attemptsFromHeaders = headers["x-attempts"] ? Number(headers["x-attempts"]) : undefined;
    const attempts = payloadAttempt ?? attemptsFromHeaders ?? 0;
    headers["x-attempts"] = String(attempts);
    const entry = new MockEnvelope(payload, headers, attempts);
    const list = this.queues.get(queue) ?? [];
    list.push(entry);
    this.queues.set(queue, list);
    this.schedule(queue);
  }

  async consume<T>(queue: string, handler: QueueHandler<T>): Promise<void> {
    this.consumers.set(queue, handler as QueueHandler<any>);
    this.schedule(queue);
  }

  async getQueueDepth(queue: string): Promise<number> {
    return (this.queues.get(queue) ?? []).filter(entry => !entry.acked).length;
  }

  simulateDisconnect(): void {
    for (const envelopes of this.queues.values()) {
      for (const envelope of envelopes) {
        if (!envelope.acked) {
          envelope.inFlight = false;
        }
      }
    }
  }

  waitForDeliveries(queue: string, count: number): Promise<void> {
    let seen = 0;
    return new Promise(resolve => {
      const listener = (deliveredQueue: string) => {
        if (deliveredQueue === queue) {
          seen += 1;
          if (seen >= count) {
            this.events.off("delivered", listener);
            resolve();
          }
        }
      };
      this.events.on("delivered", listener);
      this.schedule(queue);
    });
  }

  waitUntilEmpty(queue: string): Promise<void> {
    const check = async () => {
      const depth = await this.getQueueDepth(queue);
      if (depth === 0) {
        return true;
      }
      return false;
    };

    return new Promise(resolve => {
      const evaluate = () => {
        check().then(done => {
          if (done) {
            this.events.off("acked", evaluate);
            resolve();
          }
        });
      };
      this.events.on("acked", evaluate);
      evaluate();
    });
  }

  private schedule(queue: string): void {
    const handler = this.consumers.get(queue);
    if (!handler) {
      return;
    }
    const envelopes = this.queues.get(queue) ?? [];
    for (const envelope of envelopes) {
      if (envelope.acked || envelope.inFlight) {
        continue;
      }
      envelope.inFlight = true;
      const message: QueueMessage<any> = {
        id: envelope.headers["message-id"] ?? `msg-${Math.random().toString(16).slice(2)}`,
        payload: envelope.payload,
        headers: envelope.headers,
        attempts: envelope.attempts,
        ack: async () => {
          envelope.acked = true;
          envelope.inFlight = false;
          this.events.emit("acked", queue);
        },
        retry: async (options?: RetryOptions) => {
          envelope.inFlight = false;
          envelope.attempts += 1;
        if (envelope.payload && typeof envelope.payload === "object" && envelope.payload !== null) {
          const job = (envelope.payload as Record<string, any>).job;
          if (job && typeof job === "object") {
            job.attempt = envelope.attempts;
          }
        }
        envelope.headers["x-attempts"] = String(envelope.attempts);
          const delay = typeof options?.delayMs === "number" ? options.delayMs : undefined;
          if (delay !== undefined) {
            this.retryDelays.push(delay);
          }
          if (delay !== undefined && delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }
          this.schedule(queue);
        },
        deadLetter: async () => {
          envelope.acked = true;
          envelope.inFlight = false;
          this.events.emit("acked", queue);
        }
      };
      queueMicrotask(() => handler(message));
      this.events.emit("delivered", queue);
    }
  }
}

const adapterRef: { current: MockQueueAdapter } = { current: new MockQueueAdapter() };

const originalQueueRetryMax = process.env.QUEUE_RETRY_MAX;
const originalQueueRetryBackoff = process.env.QUEUE_RETRY_BACKOFF_MS;

process.env.QUEUE_RETRY_MAX = "2";
process.env.QUEUE_RETRY_BACKOFF_MS = "0";

vi.mock("./QueueAdapter.js", async actual => {
  const module = (await actual()) as typeof import("./QueueAdapter.js");
  return {
    ...module,
    getQueueAdapter: vi.fn(async () => adapterRef.current),
    createQueueAdapterFromConfig: vi.fn(() => adapterRef.current),
    resetQueueAdapter: vi.fn()
  };
});

const executeToolMock = vi.fn<(invocation: unknown) => Promise<any[]>>();

const policyMock = vi.hoisted(() => ({
  enforcePlanStep: vi.fn().mockResolvedValue({ allow: true, deny: [] })
}));

vi.mock("../policy/PolicyEnforcer.js", () => {
  return {
    getPolicyEnforcer: () => policyMock,
    PolicyViolationError: class extends Error {}
  };
});

vi.mock("../grpc/AgentClient.js", async actual => {
  const module = (await actual()) as typeof import("../grpc/AgentClient.js");
  return {
    ...module,
    getToolAgentClient: vi.fn(() => ({ executeTool: executeToolMock })),
    resetToolAgentClient: vi.fn()
  };
});

describe("PlanQueueRuntime integration", () => {
  let storeDir: string;
  let storePath: string;
  let runtime: typeof import("./PlanQueueRuntime.js");
  let eventsModule: EventsModule;
  let publishSpy!: PublishSpy;

  beforeAll(async () => {
    runtime = await import("./PlanQueueRuntime.js");
    eventsModule = await import("../plan/events.js");
  });

  beforeEach(() => {
    adapterRef.current = new MockQueueAdapter();
    executeToolMock.mockReset();
    policyMock.enforcePlanStep.mockReset();
    policyMock.enforcePlanStep.mockResolvedValue({ allow: true, deny: [] });
    storeDir = mkdtempSync(path.join(os.tmpdir(), "plan-state-"));
    storePath = path.join(storeDir, "state.json");
    process.env.PLAN_STATE_PATH = storePath;
    runtime.resetPlanQueueRuntime();
    publishSpy = vi.spyOn(eventsModule, "publishPlanStepEvent");
  });

  afterEach(async () => {
    publishSpy.mockRestore();
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (originalQueueRetryMax === undefined) {
      delete process.env.QUEUE_RETRY_MAX;
    } else {
      process.env.QUEUE_RETRY_MAX = originalQueueRetryMax;
    }
    if (originalQueueRetryBackoff === undefined) {
      delete process.env.QUEUE_RETRY_BACKOFF_MS;
    } else {
      process.env.QUEUE_RETRY_BACKOFF_MS = originalQueueRetryBackoff;
    }
  });

  it("rehydrates pending steps after restart", async () => {
    const plan = {
      id: "plan-1",
      goal: "demo",
      steps: [
        {
          id: "s1",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: ["repo"],
          tool: "code_writer",
          timeoutSeconds: 300,
          approvalRequired: false,
          input: {},
          metadata: {}
        }
      ],
      successCriteria: ["ok"]
    };

    executeToolMock.mockImplementationOnce(() => new Promise<any[]>(() => {}));
    executeToolMock.mockImplementationOnce(async () => [
      { state: "completed", summary: "Completed run", planId: plan.id, stepId: "s1", invocationId: "inv-2" }
    ]);

    await runtime.submitPlanSteps(plan, "trace-1");
    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(1), { timeout: 1000 });
    const calls = publishSpy.mock.calls as Array<[PlanStepEvent]>;
    expect(calls.some(([event]) => event.step.state === "running")).toBe(true);

    adapterRef.current.simulateDisconnect();
    runtime.resetPlanQueueRuntime();

    publishSpy.mockClear();
    await runtime.initializePlanQueueRuntime();
    expect(publishSpy).toHaveBeenCalled();
    const replayCalls = publishSpy.mock.calls as Array<[PlanStepEvent]>;
    const hasRunnableState = replayCalls.some(([event]) => event.step.state === "running" || event.step.state === "queued");
    expect(hasRunnableState).toBe(true);

    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(2), { timeout: 2000 });

    const { PlanStateStore } = await import("./PlanStateStore.js");
    const persisted = new PlanStateStore({ filePath: storePath });
    const remaining = await persisted.listActiveSteps();
    expect(remaining).toHaveLength(0);

    const finalCalls = publishSpy.mock.calls as Array<[PlanStepEvent]>;
    expect(finalCalls.some(([event]) => event.step.state === "completed")).toBe(true);
  });

  it("queues approval-gated steps only after approval is granted", async () => {
    const plan = {
      id: "plan-approval",
      goal: "approval demo",
      steps: [
        {
          id: "s1",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: ["repo"],
          tool: "code_writer",
          timeoutSeconds: 300,
          approvalRequired: true,
          input: {},
          metadata: {}
        }
      ],
      successCriteria: ["ok"]
    };

    executeToolMock.mockResolvedValueOnce([
      { state: "completed", summary: "Completed run", planId: plan.id, stepId: "s1", invocationId: "inv-1" }
    ]);

    await runtime.submitPlanSteps(plan, "trace-approval");

    expect(executeToolMock).not.toHaveBeenCalled();
    expect(publishSpy.mock.calls.some(([event]) => event.step.state === "waiting_approval")).toBe(true);
    expect(await adapterRef.current.getQueueDepth(runtime.PLAN_STEPS_QUEUE)).toBe(0);

    await runtime.resolvePlanStepApproval({
      planId: plan.id,
      stepId: "s1",
      decision: "approved",
      summary: "Looks good"
    });

    const states = publishSpy.mock.calls
      .filter(([event]) => event.step.id === "s1")
      .map(([event]) => event.step.state);
    expect(states).toContain("approved");
    expect(states).toContain("queued");

    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(1), { timeout: 1000 });

    expect(publishSpy.mock.calls.some(([event]) => event.step.state === "completed")).toBe(true);
  });

  it("rehydrates approval-gated steps without dispatching them", async () => {
    const plan = {
      id: "plan-wait",
      goal: "approval hold",
      steps: [
        {
          id: "s-wait",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: ["repo"],
          tool: "code_writer",
          timeoutSeconds: 300,
          approvalRequired: true,
          input: {},
          metadata: {}
        }
      ],
      successCriteria: ["ok"]
    };

    await runtime.submitPlanSteps(plan, "trace-wait");
    expect(executeToolMock).not.toHaveBeenCalled();

    runtime.resetPlanQueueRuntime();
    publishSpy.mockClear();
    executeToolMock.mockReset();
    executeToolMock.mockResolvedValueOnce([
      { state: "completed", summary: "Approved run", planId: plan.id, stepId: "s-wait", invocationId: "inv-wait" }
    ]);

    await runtime.initializePlanQueueRuntime();

    expect(
      publishSpy.mock.calls.some(([event]) => event.step.id === "s-wait" && event.step.state === "waiting_approval")
    ).toBe(true);
    expect(executeToolMock).not.toHaveBeenCalled();

    await runtime.resolvePlanStepApproval({
      planId: plan.id,
      stepId: "s-wait",
      decision: "approved",
      summary: "Resume"
    });

    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(1), { timeout: 1000 });

    expect(publishSpy.mock.calls.some(([event]) => event.step.id === "s-wait" && event.step.state === "completed")).toBe(true);
  });

  it("rejects plan submission when the capability policy denies a step", async () => {
    const plan = {
      id: "plan-policy-deny",
      goal: "deny",
      steps: [
        {
          id: "s1",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: [],
          tool: "code_writer",
          timeoutSeconds: 120,
          approvalRequired: false,
          input: {},
          metadata: {}
        }
      ],
      successCriteria: ["blocked"]
    };

    policyMock.enforcePlanStep.mockResolvedValueOnce({
      allow: false,
      deny: [{ reason: "missing_capability", capability: "repo.write" }]
    });

    await expect(runtime.submitPlanSteps(plan, "trace-deny")).rejects.toThrow("not permitted");
  });

  it("retries retryable tool errors before succeeding", async () => {
    const plan = {
      id: "plan-retry",
      goal: "retry demo",
      steps: [
        {
          id: "s-retry",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: ["repo"],
          tool: "code_writer",
          timeoutSeconds: 120,
          approvalRequired: false,
          input: {},
          metadata: {}
        }
      ],
      successCriteria: ["ok"]
    };

    let attempts = 0;
    executeToolMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ToolClientError("temporary failure", { retryable: true });
      }
      return [
        {
          state: "completed",
          summary: "Recovered",
          planId: plan.id,
          stepId: "s-retry",
          invocationId: `inv-${attempts}`
        }
      ];
    });

    await runtime.submitPlanSteps(plan, "trace-retry");

    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await adapterRef.current.waitUntilEmpty(runtime.PLAN_STEPS_QUEUE);

    const events = (publishSpy.mock.calls as Array<[PlanStepEvent]>).filter(
      ([event]) => event.planId === plan.id && event.step.id === "s-retry"
    );
    const states = events.map(([event]) => ({ state: event.step.state, attempt: event.step.attempt ?? -1 }));

    expect(states.some(entry => entry.state === "retrying" && entry.attempt === 0)).toBe(true);
    expect(states.some(entry => entry.state === "queued" && entry.attempt === 1)).toBe(true);
    expect(states.some(entry => entry.state === "running" && entry.attempt === 1)).toBe(true);
    expect(states.some(entry => entry.state === "completed" && entry.attempt === 1)).toBe(true);
  });

  it("applies exponential backoff to retry delays", async () => {
    const previousBackoff = process.env.QUEUE_RETRY_BACKOFF_MS;
    process.env.QUEUE_RETRY_BACKOFF_MS = "100";

    const plan = {
      id: "plan-exponential",
      goal: "retry with exponential backoff",
      steps: [
        {
          id: "s-exp",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: ["repo"],
          tool: "code_writer",
          timeoutSeconds: 120,
          approvalRequired: false,
          input: {},
          metadata: {}
        }
      ],
      successCriteria: ["ok"]
    };

    let attempts = 0;
    executeToolMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new ToolClientError("temporary failure", { retryable: true });
      }
      return [
        {
          state: "completed",
          summary: "Recovered",
          planId: plan.id,
          stepId: "s-exp",
          invocationId: `inv-${attempts}`
        }
      ];
    });

    try {
      await runtime.submitPlanSteps(plan, "trace-exp");

      await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(3), { timeout: 3000 });
      await adapterRef.current.waitUntilEmpty(runtime.PLAN_STEPS_QUEUE);

      expect(adapterRef.current.retryDelays).toEqual([100, 200]);
    } finally {
      if (previousBackoff === undefined) {
        delete process.env.QUEUE_RETRY_BACKOFF_MS;
      } else {
        process.env.QUEUE_RETRY_BACKOFF_MS = previousBackoff;
      }
    }
  });

  it("dead-letters steps after exhausting retries", async () => {
    const plan = {
      id: "plan-dead-letter",
      goal: "dead letter demo",
      steps: [
        {
          id: "s-dead",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: ["repo"],
          tool: "code_writer",
          timeoutSeconds: 60,
          approvalRequired: false,
          input: {},
          metadata: {}
        }
      ],
      successCriteria: ["ok"]
    };

    executeToolMock.mockImplementation(async () => {
      throw new ToolClientError("still failing", { retryable: true });
    });

    await runtime.submitPlanSteps(plan, "trace-dead-letter");

    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(3), { timeout: 3000 });
    await adapterRef.current.waitUntilEmpty(runtime.PLAN_STEPS_QUEUE);

    const events = (publishSpy.mock.calls as Array<[PlanStepEvent]>).filter(
      ([event]) => event.planId === plan.id && event.step.id === "s-dead"
    );
    const states = events.map(([event]) => ({ state: event.step.state, attempt: event.step.attempt ?? -1 }));

    expect(states.filter(entry => entry.state === "retrying")).not.toHaveLength(0);
    expect(states.some(entry => entry.state === "dead_lettered" && entry.attempt >= 2)).toBe(true);

    const { PlanStateStore } = await import("./PlanStateStore.js");
    const persisted = new PlanStateStore({ filePath: storePath });
    const remaining = await persisted.listActiveSteps();
    expect(remaining).toHaveLength(0);
  });
});
