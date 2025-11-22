import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionStore } from "../auth/SessionStore.js";
import { clearPlanHistory } from "../plan/events.js";
import { createOidcEnabledConfig, createSessionForUser } from "../test/utils.js";

vi.mock("../providers/ProviderRegistry.js", async () => {
  const { VersionedSecretsManager } = await import("../auth/VersionedSecretsManager.js");
  const storage = new Map<string, string>();
  const secretsStore = {
    async get(key: string): Promise<string | undefined> {
      return storage.get(key);
    },
    async set(key: string, value: string): Promise<void> {
      storage.set(key, value);
    },
    async delete(key: string): Promise<void> {
      storage.delete(key);
    },
    __reset(): void {
      storage.clear();
    },
  };
  const manager = new VersionedSecretsManager(secretsStore);
  return {
    routeChat: vi.fn().mockResolvedValue({
      output: "hello",
      usage: { promptTokens: 5, completionTokens: 3 },
    }),
    getSecretsStore: () => secretsStore,
    getVersionedSecretsManager: () => manager,
  };
});

const policyMock = {
  enforceHttpAction: vi.fn().mockResolvedValue({ allow: true, deny: [] })
};

vi.mock("../policy/PolicyEnforcer.js", () => {
  class MockPolicyViolationError extends Error {
    status: number;
    details: unknown;

    constructor(message: string, details: unknown = [], status = 403) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }

  return {
    getPolicyEnforcer: () => policyMock,
    PolicyViolationError: MockPolicyViolationError
  };
});

vi.mock("../queue/PlanQueueRuntime.js", () => {
  return {
    initializePlanQueueRuntime: vi.fn().mockResolvedValue(undefined),
    submitPlanSteps: vi.fn().mockResolvedValue(undefined),
    resolvePlanStepApproval: vi.fn().mockResolvedValue(undefined),
    getPlanSubject: vi.fn().mockResolvedValue(undefined),
    getPersistedPlanStep: vi.fn().mockResolvedValue(undefined)
  };
});

describe("orchestrator http api", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    clearPlanHistory();
  });

  afterEach(() => {
    clearPlanHistory();
    try {
      fs.rmSync(path.join(process.cwd(), ".plans"), { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EPERM") {
        throw error;
      }
    }
    vi.clearAllMocks();
    policyMock.enforceHttpAction.mockReset();
    policyMock.enforceHttpAction.mockResolvedValue({ allow: true, deny: [] });
    sessionStore.clear();
  });

  it("creates a plan and exposes step events", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const planResponse = await request(app).post("/plan").send({ goal: "Ship the next milestone" }).expect(201);

    expect(planResponse.body.plan).toBeDefined();
    expect(planResponse.body.plan.goal).toBe("Ship the next milestone");
    expect(planResponse.body.traceId).toBeTruthy();

    const { submitPlanSteps } = await import("../queue/PlanQueueRuntime.js");
    expect(submitPlanSteps).toHaveBeenCalledWith(
      expect.objectContaining({ id: planResponse.body.plan.id }),
      expect.any(String),
      expect.any(String),
    );

    const planId: string = planResponse.body.plan.id;

    const eventsResponse = await request(app)
      .get(`/plan/${planId}/events`)
      .set("Accept", "application/json")
      .expect(200);

    expect(eventsResponse.body.events).toHaveLength(planResponse.body.plan.steps.length);
    expect(eventsResponse.body.events[0].step.capability).toBeDefined();
  });

  it("handles concurrent plan creation requests without blocking the event loop", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const timerPromise = new Promise<number>(resolve => {
      const started = Date.now();
      setTimeout(() => resolve(Date.now() - started), 25);
    });

    const requests = Array.from({ length: 5 }, (_, index) =>
      request(app).post("/plan").send({ goal: `Concurrent request ${index}` }).expect(201)
    );

    const [elapsed, responses] = await Promise.all([timerPromise, Promise.all(requests)]);

    for (const response of responses) {
      expect(response.body.plan?.id).toBeTruthy();
      expect(response.body.traceId).toBeTruthy();
    }

    expect(elapsed).toBeLessThan(200);
  });

  it("returns validation errors when the plan goal is empty", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const response = await request(app).post("/plan").send({ goal: "   " }).expect(400);

    expect(response.body).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
    });
    expect(response.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "goal" })]),
    );
  });

  it("routes chat requests through the provider registry", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const chatResponse = await request(app)
      .post("/chat")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(200);

    expect(chatResponse.body.traceId).toBeTruthy();
    expect(chatResponse.body.response.output).toBe("hello");

    const { routeChat } = await import("../providers/ProviderRegistry.js");
    expect(routeChat).toHaveBeenCalledWith({ messages: [{ role: "user", content: "hi" }] });
  });

  it("passes the tenant context to the provider router when a session is present", async () => {
    const { createServer } = await import("../index.js");
    const oidcConfig = createOidcEnabledConfig();
    const app = createServer(oidcConfig);
    const session = createSessionForUser(oidcConfig, {
      userId: "tenant-user",
      tenantId: "tenant-123",
    });

    await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${session.id}`)
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(200);

    const { routeChat } = await import("../providers/ProviderRegistry.js");
    expect(routeChat).toHaveBeenLastCalledWith(
      { messages: [{ role: "user", content: "hi" }] },
      { tenantId: "tenant-123" },
    );
  });

  it("validates chat payloads", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const invalidResponse = await request(app).post("/chat").send({}).expect(400);
    expect(invalidResponse.body).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
    });
    expect(Array.isArray(invalidResponse.body.details)).toBe(true);
    expect(invalidResponse.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "messages" }),
      ]),
    );
  });

  it("exposes Prometheus metrics", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const metricsResponse = await request(app).get("/metrics").expect(200);
    expect(metricsResponse.headers["content-type"]).toContain("text/plain");
    expect(metricsResponse.text).toContain("orchestrator_queue_depth");
  });

  it("reports readiness status with dependency details", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const response = await request(app).get("/readyz").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      details: expect.objectContaining({
        queue: expect.objectContaining({ status: expect.any(String) }),
      }),
    });
    expect(typeof response.body.uptimeSeconds).toBe("number");
    expect(typeof response.body.timestamp).toBe("string");
  });
});

