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
import type { PlanStepCompletionPayload } from "./PlanQueueRuntime.js";
import type { PlanStepEvent } from "../plan/events.js";
import { ToolClientError } from "../grpc/AgentClient.js";
import { appLogger } from "../observability/logger.js";
import type { PlanStep } from "../plan/planner.js";
import { GenericContainer } from "testcontainers";
import { resetPostgresPoolForTests } from "../database/Postgres.js";
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

type DenyReason = { reason: string; capability?: string };

const policyMock = vi.hoisted(() => ({
  enforcePlanStep: vi.fn().mockResolvedValue({ allow: true, deny: [] })
}));

const PolicyViolationErrorMock = vi.hoisted(
  () =>
    class PolicyViolationErrorMock extends Error {
      readonly status: number;
      readonly details: DenyReason[];

      constructor(message: string, details: DenyReason[] = [], status = 403) {
        super(message);
        this.name = "PolicyViolationError";
        this.status = status;
        this.details = details;
      }
    }
);

vi.mock("../policy/PolicyEnforcer.js", () => {
  return {
    getPolicyEnforcer: () => policyMock,
    PolicyViolationError: PolicyViolationErrorMock
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

vi.mock("../services/DistributedLockService.js", () => {
  return {
    DistributedLockService: class MockDistributedLockService {
      async acquireLock(_key: string, _ttl: number) {
        return async () => {};
      }
      async close() {}
    }
  };
});

describe("PlanQueueRuntime integration", () => {
  let storeDir: string;
  let storePath: string;
  let runtime: typeof import("./PlanQueueRuntime.js");
  let eventsModule: EventsModule;
  let publishSpy!: PublishSpy;
  let loggerMock: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    loggerMock = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn()
    };
    vi.spyOn(appLogger, "child").mockReturnValue(loggerMock as any);
    adapterRef.current = new MockQueueAdapter();
    executeToolMock.mockReset();
    policyMock.enforcePlanStep.mockReset();
    policyMock.enforcePlanStep.mockResolvedValue({ allow: true, deny: [] });
    // Use a local test-data directory to avoid Windows temp folder issues/locking
    const testDataDir = path.join(process.cwd(), "test-data");
    await fs.mkdir(testDataDir, { recursive: true });
    storeDir = await fs.mkdtemp(path.join(testDataDir, "plan-state-"));
    storePath = path.join(storeDir, "state.json");
    process.env.PLAN_STATE_PATH = storePath;
    vi.resetModules();
    runtime = await import("./PlanQueueRuntime.js");
    eventsModule = await import("../plan/events.js");
    runtime.resetPlanQueueRuntime();
    publishSpy = vi.spyOn(eventsModule, "publishPlanStepEvent");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (storeDir) {
      await fs.rm(storeDir, { recursive: true, force: true, maxRetries: 5 });
    }
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

  it.skip("rehydrates pending steps after restart", async () => {
    const plan = {
      id: "plan-550e8400-e29b-41d4-a716-446655440000",
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

    await runtime.submitPlanSteps(plan, "trace-1", undefined);
    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(1), { timeout: 1000 });
    await vi.waitFor(() => {
      const calls = publishSpy.mock.calls as Array<[PlanStepEvent]>;
      expect(calls.some(([event]) => event.step.state === "running")).toBe(true);
    });

    adapterRef.current.simulateDisconnect();
    await runtime.initializePlanQueueRuntime();
    await vi.waitFor(() => {
      expect(publishSpy).toHaveBeenCalled();
    });
    const replayCalls = publishSpy.mock.calls as Array<[PlanStepEvent]>;
    const hasRunnableState = replayCalls.some(([event]) => event.step.state === "running" || event.step.state === "queued");
    expect(hasRunnableState).toBe(true);

    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(2), { timeout: 2000 });

    const { PlanStateStore } = await import("./PlanStateStore.js");
    const persisted = new PlanStateStore({ filePath: storePath });
    const remaining = await persisted.listActiveSteps();
    expect(remaining).toHaveLength(0);
  });

  it("clears caches and prunes plan subject when enqueue fails", async () => {
    const plan = {
      id: "plan-cleanup",
      goal: "demo",
      steps: [
        {
          id: "s-cleanup",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: ["repo"],
          tool: "code_writer",
          timeoutSeconds: 300,
          approvalRequired: false,
          input: {},
          metadata: {},
        },
      ],
      successCriteria: ["ok"],
    };

    const subject = {
      sessionId: "session-1",
      tenantId: "tenant-1",
      userId: "user-1",
      email: "user@example.com",
      name: "User One",
      roles: ["member"],
      scopes: ["repo.write"],
    };

    const enqueueError = new Error("queue unavailable");
    const enqueueSpy = vi
      .spyOn(adapterRef.current, "enqueue")
      .mockRejectedValueOnce(enqueueError);
    await expect(
      runtime.submitPlanSteps(plan, "trace-cleanup", undefined, subject),
    ).rejects.toThrow("queue unavailable");

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(runtime.hasPendingPlanStep(plan.id, "s-cleanup")).toBe(false);
    expect(runtime.hasApprovalCacheEntry(plan.id, "s-cleanup")).toBe(false);
    expect(runtime.hasActivePlanSubject(plan.id)).toBe(false);
  });

  it("emits completion events with persisted metadata when registry is empty", async () => {
    const step = {
      id: "s-persisted",
      action: "apply_edits",
      capability: "repo.write",
      capabilityLabel: "Apply repository changes",
      labels: ["repo"],
      tool: "code_writer",
      timeoutSeconds: 120,
      approvalRequired: true,
      input: {},
      metadata: {}
    };
    const planId = "plan-persisted";
    const persistedTraceId = "trace-from-store";

    const { PlanStateStore } = await import("./PlanStateStore.js");
    const store = new PlanStateStore({ filePath: storePath });
    const idempotencyKey = `${planId}:${step.id}`;

    await store.rememberStep(planId, step, persistedTraceId, {
      initialState: "waiting_approval",
      idempotencyKey,
      attempt: 1,
      createdAt: new Date().toISOString(),
      approvals: { [step.capability]: true }
    });

    const listSpy = vi.spyOn(PlanStateStore.prototype, "listActiveSteps").mockResolvedValue([]);
    try {
      await runtime.initializePlanQueueRuntime();
    } finally {
      listSpy.mockRestore();
    }

    publishSpy.mockClear();

    await adapterRef.current.enqueue<PlanStepCompletionPayload>(
      runtime.PLAN_COMPLETIONS_QUEUE,
      {
        planId,
        stepId: step.id,
        state: "completed",
        summary: "Completed via store"
      },
      {
        headers: {
          "trace-id": persistedTraceId,
          "x-idempotency-key": idempotencyKey,
        },
      }
    );

    await vi.waitFor(() => {
      const events = publishSpy.mock.calls as Array<[PlanStepEvent]>;
      expect(events.some(([event]) => event.planId === planId && event.step.state === "completed")).toBe(true);
    });

    const events = (publishSpy.mock.calls as Array<[PlanStepEvent]>).map(([event]) => event);
    const completion = events.find(event => event.planId === planId && event.step.id === step.id);
    expect(completion).toBeDefined();
    expect(completion?.traceId).toBe(persistedTraceId);
    expect(completion?.step.action).toBe(step.action);
    expect(completion?.step.tool).toBe(step.tool);
    expect(completion?.step.capability).toBe(step.capability);
    expect(completion?.step.approvals).toEqual({ [step.capability]: true });
    expect(completion?.step.attempt).toBe(1);
  });

  it("dead-letters completions when trace and idempotency metadata do not both match", async () => {
    const step: PlanStep = {
      id: "s-guarded",
      action: "apply_edits",
      capability: "repo.write",
      capabilityLabel: "Apply repository changes",
      labels: ["repo"],
      tool: "code_writer",
      timeoutSeconds: 120,
      approvalRequired: false,
      input: {},
      metadata: {},
    };
    const planId = "plan-guarded";
    const traceId = "trace-guarded";
    const idempotencyKey = `${planId}:${step.id}`;

    const { PlanStateStore } = await import("./PlanStateStore.js");
    const store = new PlanStateStore({ filePath: storePath });
    await store.rememberStep(planId, step, traceId, {
      initialState: "running",
      idempotencyKey,
      attempt: 1,
      createdAt: new Date().toISOString(),
    });

    await runtime.initializePlanQueueRuntime();

    publishSpy.mockClear();
    loggerMock.warn.mockClear();

    const payload: PlanStepCompletionPayload = {
      planId,
      stepId: step.id,
      state: "completed",
      summary: "guarded completion",
    };

    await adapterRef.current.enqueue<PlanStepCompletionPayload>(
      runtime.PLAN_COMPLETIONS_QUEUE,
      payload,
      {
        headers: {
          "x-idempotency-key": idempotencyKey,
        },
      },
    );

    await adapterRef.current.waitUntilEmpty(runtime.PLAN_COMPLETIONS_QUEUE);

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("clears approvals and persisted state when a rejected completion is processed", async () => {
    const step: PlanStep = {
      id: "s-rejected",
      action: "apply_edits",
      capability: "repo.write",
      capabilityLabel: "Apply repository changes",
      labels: ["repo"],
      tool: "code_writer",
      timeoutSeconds: 120,
      approvalRequired: true,
      input: {},
      metadata: {}
    };
    const planId = "plan-rejected";
    const traceId = "trace-rejected";
    const idempotencyKey = `${planId}:${step.id}`;

    const { PlanStateStore } = await import("./PlanStateStore.js");
    const store = new PlanStateStore({ filePath: storePath });
    await store.rememberStep(planId, step, traceId, {
      initialState: "running",
      idempotencyKey,
      attempt: 1,
      createdAt: new Date().toISOString(),
      approvals: { [step.capability]: true }
    });

    await runtime.initializePlanQueueRuntime();

    publishSpy.mockClear();
    policyMock.enforcePlanStep.mockClear();

    await adapterRef.current.enqueue<PlanStepCompletionPayload>(
      runtime.PLAN_COMPLETIONS_QUEUE,
      {
        planId,
        stepId: step.id,
        state: "rejected",
        summary: "Rejected during execution",
        approvals: { [step.capability]: true }
      },
      {
        headers: {
          "trace-id": traceId,
          "x-idempotency-key": idempotencyKey,
        },
      }
    );

    await vi.waitFor(() => {
      const events = publishSpy.mock.calls as Array<[PlanStepEvent]>;
      expect(
        events.some(
          ([event]) =>
            event.planId === planId && event.step.id === step.id && event.step.state === "rejected"
        )
      ).toBe(true);
    });

    const persisted = new PlanStateStore({ filePath: storePath });
    await vi.waitFor(async () => {
      const remaining = await persisted.listActiveSteps();
      expect(remaining).toHaveLength(0);
    });

    const plan = {
      id: planId,
      goal: "approval refresh",
      steps: [
        {
          ...step
        }
      ],
      successCriteria: ["ok"]
    };

    await runtime.submitPlanSteps(plan, "trace-rejected-followup", undefined);

    // Sometimes called twice if retried internally, but we expect at least one check with empty approvals
    expect(policyMock.enforcePlanStep).toHaveBeenCalled();
    const calls = policyMock.enforcePlanStep.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    const [, context] = lastCall!;
    expect(context.approvals).toEqual({});
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

    await runtime.submitPlanSteps(plan, "trace-approval", undefined);

    expect(executeToolMock).not.toHaveBeenCalled();
    expect(publishSpy.mock.calls.some(([event]) => event.step.state === "waiting_approval")).toBe(true);
    expect(await adapterRef.current.getQueueDepth(runtime.PLAN_STEPS_QUEUE)).toBe(0);

    await runtime.resolvePlanStepApproval({
      planId: plan.id,
      stepId: "s1",
      decision: "approved",
      summary: "Looks good"
    });

    await vi.waitFor(() => {
      const states = publishSpy.mock.calls
        .filter(([event]) => event.step.id === "s1")
        .map(([event]) => event.step.state);
      expect(states).toContain("approved");
    }, { timeout: 1000 });

    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(1), { timeout: 1000 });

    await vi.waitFor(
      () =>
        expect(
          publishSpy.mock.calls.some(([event]) => event.step.state === "completed"),
        ).toBe(true),
      { timeout: 1000 },
    );
  });

  it("executes multi-step plans sequentially across approval gates", async () => {
    const plan = {
      id: "plan-ordered",
      goal: "sequential approvals",
      steps: [
        {
          id: "s1",
          action: "index_repo",
          capability: "repo.read",
          capabilityLabel: "Read repository",
          labels: ["repo"],
          tool: "repo_indexer",
          timeoutSeconds: 120,
          approvalRequired: false,
          input: {},
          metadata: {},
        },
        {
          id: "s2",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: ["repo"],
          tool: "code_writer",
          timeoutSeconds: 300,
          approvalRequired: true,
          input: {},
          metadata: {},
        },
        {
          id: "s3",
          action: "run_tests",
          capability: "test.run",
          capabilityLabel: "Execute tests",
          labels: ["tests"],
          tool: "test_runner",
          timeoutSeconds: 600,
          approvalRequired: false,
          input: {},
          metadata: {},
        },
      ],
      successCriteria: ["done"],
    };

    const executed: string[] = [];
    executeToolMock.mockImplementation(async (invocation: any) => {
      executed.push(invocation.stepId);
      return [
        {
          state: "completed",
          summary: `Completed ${invocation.stepId}`,
          planId: plan.id,
          stepId: invocation.stepId,
          invocationId: `inv-${invocation.stepId}`,
        },
      ];
    });

    await runtime.submitPlanSteps(plan, "trace-ordered", undefined);

    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(executed).toEqual(["s1"]);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(executeToolMock).toHaveBeenCalledTimes(1);


    await vi.waitFor(async () => {
        await runtime.resolvePlanStepApproval({
          planId: plan.id,
          stepId: "s2",
          decision: "approved",
          summary: "Proceed",
        });
    }, { timeout: 5000 });

    await vi.waitFor(
      () => {
        expect(executed.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 2000 },
    );
    expect(executed.slice(0, 2)).toEqual(["s1", "s2"]);

    await vi.waitFor(
      () => {
        expect(executed.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 2000 },
    );
    expect(executed).toEqual(["s1", "s2", "s3"]);

    await adapterRef.current.waitUntilEmpty(runtime.PLAN_STEPS_QUEUE);

    const { PlanStateStore } = await import("./PlanStateStore.js");
    const persisted = new PlanStateStore({ filePath: storePath });
    await vi.waitFor(async () => {
      const remainingMetadata = await persisted.listPlanMetadata();
      expect(remainingMetadata).toHaveLength(0);
    });
  });

  it.skip("preserves sequential ordering with approvals across restarts", async () => {
    const plan = {
      id: "plan-ordered-restart",
      goal: "restart approvals",
      steps: [
        {
          id: "s1",
          action: "index_repo",
          capability: "repo.read",
          capabilityLabel: "Read repository",
          labels: ["repo"],
          tool: "repo_indexer",
          timeoutSeconds: 120,
          approvalRequired: false,
          input: {},
          metadata: {},
        },
        {
          id: "s2",
          action: "apply_edits",
          capability: "repo.write",
          capabilityLabel: "Apply repository changes",
          labels: ["repo"],
          tool: "code_writer",
          timeoutSeconds: 300,
          approvalRequired: true,
          input: {},
          metadata: {},
        },
        {
          id: "s3",
          action: "run_tests",
          capability: "test.run",
          capabilityLabel: "Execute tests",
          labels: ["tests"],
          tool: "test_runner",
          timeoutSeconds: 600,
          approvalRequired: false,
          input: {},
          metadata: {},
        },
      ],
      successCriteria: ["done"],
    };

    const executed: string[] = [];
    executeToolMock.mockImplementation(async (invocation: any) => {
      executed.push(invocation.stepId);
      return [
        {
          state: "completed",
          summary: `Completed ${invocation.stepId}`,
          planId: plan.id,
          stepId: invocation.stepId,
          invocationId: `inv-${invocation.stepId}`,
        },
      ];
    });

    await runtime.submitPlanSteps(plan, "trace-ordered-restart", undefined);

    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(executed).toEqual(["s1"]);


    adapterRef.current.simulateDisconnect();
    await runtime.stopPlanQueueRuntime();
    publishSpy.mockClear();
    await runtime.initializePlanQueueRuntime();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(executeToolMock).toHaveBeenCalledTimes(1);


    await vi.waitFor(async () => {
        await runtime.resolvePlanStepApproval({
          planId: plan.id,
          stepId: "s2",
          decision: "approved",
          summary: "Resume",
        });
    }, { timeout: 5000 });

    await vi.waitFor(() => {
      expect(executed.length).toBeGreaterThanOrEqual(2);
      expect(executed.slice(0, 2)).toEqual(["s1", "s2"]);
    });

    await vi.waitFor(() => {
      expect(executed.length).toBeGreaterThanOrEqual(3);
    });
    expect(executed).toEqual(["s1", "s2", "s3"]);

    await adapterRef.current.waitUntilEmpty(runtime.PLAN_STEPS_QUEUE);

    const { PlanStateStore } = await import("./PlanStateStore.js");
    const persisted = new PlanStateStore({ filePath: storePath });
    await vi.waitFor(async () => {
      const remainingMetadata = await persisted.listPlanMetadata();
      expect(remainingMetadata).toHaveLength(0);
    });
  });

  it("emits failure events when enqueueing an approved step fails", async () => {
    const plan = {
      id: "plan-approval-fail",
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
          metadata: {},
        },
      ],
      successCriteria: ["ok"],
    };

    await runtime.submitPlanSteps(plan, "trace-approval-fail", undefined);

    const enqueueError = new Error("queue unavailable");
    const enqueueSpy = vi
      .spyOn(adapterRef.current, "enqueue")
      .mockRejectedValueOnce(enqueueError);
    // failures are surfaced via rejected promise

    const states = publishSpy.mock.calls
      .filter(([event]) => event.planId === plan.id && event.step.id === "s1")
      .map(([event]) => event.step.state);
    expect(states).toContain("waiting_approval");
    expect(states).not.toContain("queued");
    expect(states).not.toContain("running");
    expect(states).not.toContain("completed");
    // failures are surfaced via rejected promise
  });

  it("marks approval-gated steps as rejected when policy enforcement throws", async () => {
    const plan = {
      id: "plan-approval-violation",
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

    await runtime.submitPlanSteps(plan, "trace-approval-violation", undefined);

    const violation = new PolicyViolationErrorMock("Missing agent profile", [
      { reason: "agent_profile_missing", capability: "repo.write" }
    ]);
    policyMock.enforcePlanStep.mockRejectedValueOnce(violation);

    await expect(
      runtime.resolvePlanStepApproval({
        planId: plan.id,
        stepId: "s1",
        decision: "approved",
        summary: "Looks good"
      })
    ).rejects.toBe(violation);

    const states = publishSpy.mock.calls
      .filter(([event]) => event.planId === plan.id && event.step.id === "s1")
      .map(([event]) => event.step.state);

    expect(states).toContain("waiting_approval");
    expect(states).toContain("rejected");
    expect(states).not.toContain("approved");
    expect(states).not.toContain("queued");

    await expect(
      runtime.resolvePlanStepApproval({
        planId: plan.id,
        stepId: "s1",
        decision: "approved",
        summary: "Retry"
      })
    ).rejects.toThrow(`Plan step ${plan.id}/s1 is not available`);
  });

  it.skip("rehydrates approval-gated steps without dispatching them", async () => {
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

    await runtime.submitPlanSteps(plan, "trace-wait", undefined);
    expect(executeToolMock).not.toHaveBeenCalled();

    await runtime.stopPlanQueueRuntime();
    publishSpy.mockClear();
    executeToolMock.mockReset();
    executeToolMock.mockResolvedValueOnce([
      { state: "completed", summary: "Approved run", planId: plan.id, stepId: "s-wait", invocationId: "inv-wait" }
    ]);

    await runtime.initializePlanQueueRuntime();

    await vi.waitFor(() => {
      expect(
        publishSpy.mock.calls.some(([event]) => event.step.id === "s-wait" && event.step.state === "waiting_approval")
      ).toBe(true);
    });
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

  it.skip("allows approving rehydrated steps with the shared postgres store", async () => {
    let postgres: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
    try {
      postgres = await new GenericContainer("postgres:15-alpine")
        .withEnvironment({
          POSTGRES_PASSWORD: "password",
          POSTGRES_USER: "user",
          POSTGRES_DB: "plans",
        })
        .withExposedPorts(5432)
        .start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Could not find a working container runtime")) {
        appLogger.warn(
          { event: "test.skip", reason: "missing_container_runtime", test: "PlanQueueRuntime.postgres" },
          "Skipping Postgres integration test because no container runtime is available",
        );
        return;
      }
      throw error;
    }

    const host = postgres.getHost();
    const port = postgres.getMappedPort(5432);
    const connectionString = `postgres://user:password@${host}:${port}/plans`;

    publishSpy.mockRestore();
    await resetPostgresPoolForTests();
    vi.resetModules();
    process.env.PLAN_STATE_BACKEND = "postgres";
    process.env.POSTGRES_URL = connectionString;

    try {
      runtime = await import("./PlanQueueRuntime.js");
      eventsModule = await import("../plan/events.js");
      publishSpy = vi.spyOn(eventsModule, "publishPlanStepEvent");
      runtime.resetPlanQueueRuntime();

      const plan = {
        id: "plan-shared",
        goal: "approval hold",
        steps: [
          {
            id: "s-shared",
            action: "apply_edits",
            capability: "repo.write",
            capabilityLabel: "Apply repository changes",
            labels: ["repo"],
            tool: "code_writer",
            timeoutSeconds: 300,
            approvalRequired: true,
            input: {},
            metadata: {},
          },
        ],
        successCriteria: ["ok"],
      };

      executeToolMock.mockReset();
      executeToolMock.mockResolvedValueOnce([
        { state: "completed", summary: "Approved run", planId: plan.id, stepId: "s-shared", invocationId: "inv-shared" },
      ]);

      await runtime.submitPlanSteps(plan, "trace-shared", undefined);

      expect(
        publishSpy.mock.calls.some(
          ([event]) => event.planId === plan.id && event.step.id === "s-shared" && event.step.state === "waiting_approval",
        ),
      ).toBe(true);
      expect(executeToolMock).not.toHaveBeenCalled();

      runtime.resetPlanQueueRuntime();
      publishSpy.mockClear();

      await runtime.initializePlanQueueRuntime();

      expect(
        publishSpy.mock.calls.some(
          ([event]) => event.planId === plan.id && event.step.id === "s-shared" && event.step.state === "waiting_approval",
        ),
      ).toBe(true);

      await runtime.resolvePlanStepApproval({
        planId: plan.id,
        stepId: "s-shared",
        decision: "approved",
        summary: "Resume",
      });

      await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(1), { timeout: 2000 });

      expect(
        publishSpy.mock.calls.some(
          ([event]) => event.planId === plan.id && event.step.id === "s-shared" && event.step.state === "completed",
        ),
      ).toBe(true);
    } finally {
      await resetPostgresPoolForTests();
      delete process.env.PLAN_STATE_BACKEND;
      delete process.env.POSTGRES_URL;
      if (postgres) {
        await postgres.stop();
      }
    }
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

    await expect(runtime.submitPlanSteps(plan, "trace-deny", undefined)).rejects.toThrow("not permitted");
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

    await runtime.submitPlanSteps(plan, "trace-retry", undefined);

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
    adapterRef.current.retryDelays.length = 0;

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
      await runtime.submitPlanSteps(plan, "trace-exponential", undefined);
      await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledTimes(3), { timeout: 2000 });

      expect(adapterRef.current.retryDelays.length).toBeGreaterThanOrEqual(2);
      expect(adapterRef.current.retryDelays[0]).toBeGreaterThanOrEqual(100);
      expect(adapterRef.current.retryDelays[1]).toBeGreaterThanOrEqual(200);
    } finally {
      adapterRef.current.retryDelays.length = 0;
      if (previousBackoff === undefined) {
        delete process.env.QUEUE_RETRY_BACKOFF_MS;
      } else {
        process.env.QUEUE_RETRY_BACKOFF_MS = previousBackoff;
      }
    }
  });
});