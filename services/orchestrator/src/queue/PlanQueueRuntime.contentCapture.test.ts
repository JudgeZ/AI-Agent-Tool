import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  DeadLetterOptions,
  EnqueueOptions,
  QueueAdapter,
  QueueHandler,
  QueueMessage,
  RetryOptions,
} from "./QueueAdapter.js";
import type { PlanStepCompletionPayload } from "./PlanQueueRuntime.js";
import type { PlanStep } from "../plan/planner.js";

class TestQueueAdapter implements QueueAdapter {
  private readonly handlers = new Map<string, QueueHandler<unknown>>();
  readonly deadLetters: Array<{
    queue: string;
    payload: unknown;
    headers: Record<string, string>;
    reason?: string;
  }> = [];
  readonly enqueued: Array<{
    queue: string;
    payload: unknown;
    options?: EnqueueOptions;
  }> = [];

  async connect(): Promise<void> {
    // no-op for tests
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }

  async enqueue<T>(queue: string, payload: T, options?: EnqueueOptions): Promise<void> {
    this.enqueued.push({ queue, payload, options });
  }

  async consume<T>(queue: string, handler: QueueHandler<T>): Promise<void> {
    this.handlers.set(queue, handler as QueueHandler<unknown>);
  }

  async getQueueDepth(): Promise<number> {
    return 0;
  }

  async deliver<T>(
    queue: string,
    payload: T,
    headers: Record<string, string> = {},
  ): Promise<{ acked: boolean }> {
    const handler = this.handlers.get(queue);
    if (!handler) {
      throw new Error(`No handler registered for queue ${queue}`);
    }
    let acked = false;
    const message: QueueMessage<T> = {
      id: headers["message-id"] ?? `msg-${Math.random().toString(16).slice(2)}`,
      payload,
      headers,
      attempts: 0,
      ack: async () => {
        acked = true;
      },
      retry: async (_options?: RetryOptions) => {
        throw new Error("retry not implemented in TestQueueAdapter");
      },
      deadLetter: async (options?: DeadLetterOptions) => {
        this.deadLetters.push({ queue, payload, headers, reason: options?.reason });
      },
    };
    await handler(message);
    return { acked };
  }
}

const adapterRef: { current: TestQueueAdapter } = { current: new TestQueueAdapter() };

vi.mock("./QueueAdapter.js", async (actual) => {
  const module = (await actual()) as typeof import("./QueueAdapter.js");
  return {
    ...module,
    getQueueAdapter: vi.fn(async () => adapterRef.current),
    createQueueAdapterFromConfig: vi.fn(() => adapterRef.current),
    resetQueueAdapter: vi.fn(),
  };
});

const originalContentCapture = process.env.CONTENT_CAPTURE_ENABLED;
const originalPlanStatePath = process.env.PLAN_STATE_PATH;

const planId = "plan-output";
const step: PlanStep = {
  id: "step-output",
  action: "apply_edits",
  capability: "repo.write",
  capabilityLabel: "Apply repository changes",
  labels: ["repo"],
  tool: "code_writer",
  timeoutSeconds: 60,
  approvalRequired: false,
  input: {},
  metadata: {},
};

async function setupRuntime(contentCaptureEnabled: boolean, storePath: string) {
  if (contentCaptureEnabled) {
    process.env.CONTENT_CAPTURE_ENABLED = "true";
  } else {
    delete process.env.CONTENT_CAPTURE_ENABLED;
  }

  vi.resetModules();
  const configModule = await import("../config.js");
  configModule.invalidateConfigCache();

  const runtime = await import("./PlanQueueRuntime.js");
  const events = await import("../plan/events.js");
  const { PlanStateStore } = await import("./PlanStateStore.js");

  runtime.resetPlanQueueRuntime();
  const bootstrapStore = new PlanStateStore({ filePath: storePath });
  await bootstrapStore.rememberStep(planId, step, "trace-output", {
    initialState: "queued",
    idempotencyKey: `${planId}:${step.id}`,
    attempt: 1,
    createdAt: new Date().toISOString(),
  });

  events.clearPlanHistory();
  await runtime.initializePlanQueueRuntime();

  return { runtime, events, PlanStateStore };
}

describe("PlanQueueRuntime completion content capture", () => {
  let storeDir: string;
  let storePath: string;

  beforeEach(() => {
    adapterRef.current = new TestQueueAdapter();
    storeDir = mkdtempSync(path.join(os.tmpdir(), "plan-state-"));
    storePath = path.join(storeDir, "state.json");
    process.env.PLAN_STATE_PATH = storePath;
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
    if (originalContentCapture === undefined) {
      delete process.env.CONTENT_CAPTURE_ENABLED;
    } else {
      process.env.CONTENT_CAPTURE_ENABLED = originalContentCapture;
    }
    if (originalPlanStatePath === undefined) {
      delete process.env.PLAN_STATE_PATH;
    } else {
      process.env.PLAN_STATE_PATH = originalPlanStatePath;
    }
    const events = await import("../plan/events.js");
    events.clearPlanHistory();
    vi.resetModules();
  });

  it("persists completion output when content capture is enabled", async () => {
    const { runtime, events, PlanStateStore } = await setupRuntime(true, storePath);
    const output = { text: "hello", tokens: 42 } as Record<string, unknown>;
    const payload: PlanStepCompletionPayload = {
      planId,
      stepId: step.id,
      state: "running",
      summary: "tool streaming",
      output,
    };

    const result = await adapterRef.current.deliver(runtime.PLAN_COMPLETIONS_QUEUE, payload, {
      "trace-id": "trace-output",
      "x-idempotency-key": `${planId}:${step.id}`,
    });
    expect(result.acked).toBe(true);

    const history = events.getPlanHistory(planId);
    const completionEvent = history.find(
      (event) => event.step.state === payload.state && event.step.summary === payload.summary,
    );
    expect(completionEvent?.step.output).toEqual(output);

    const store = new PlanStateStore({ filePath: storePath });
    const entry = await store.getEntry(planId, step.id);
    expect(entry?.output).toEqual(output);

    runtime.resetPlanQueueRuntime();
  }, 15000);

  it("omits completion output when content capture is disabled", async () => {
    const { runtime, events, PlanStateStore } = await setupRuntime(false, storePath);
    const output = { text: "secret", tokens: 7 } as Record<string, unknown>;
    const payload: PlanStepCompletionPayload = {
      planId,
      stepId: step.id,
      state: "running",
      summary: "sensitive output",
      output,
    };

    const result = await adapterRef.current.deliver(runtime.PLAN_COMPLETIONS_QUEUE, payload, {
      "trace-id": "trace-output",
      "x-idempotency-key": `${planId}:${step.id}`,
    });
    expect(result.acked).toBe(true);

    const history = events.getPlanHistory(planId);
    const completionEvent = history.find(
      (event) => event.step.state === payload.state && event.step.summary === payload.summary,
    );
    expect(completionEvent?.step.output).toBeUndefined();

    const store = new PlanStateStore({ filePath: storePath });
    const entry = await store.getEntry(planId, step.id);
    expect(entry?.output).toBeUndefined();

    runtime.resetPlanQueueRuntime();
  }, 10000);
});
