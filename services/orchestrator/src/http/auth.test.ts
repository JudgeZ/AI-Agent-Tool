import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionStore } from "../auth/SessionStore.js";
import { loadConfig } from "../config.js";
import { clearPlanHistory, publishPlanStepEvent } from "../plan/events.js";
import type { PersistedStep } from "../queue/PlanStateStore.js";
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

const getPlanSubjectMock = vi.fn().mockResolvedValue(undefined);
const getPersistedPlanStepMock = vi.fn().mockResolvedValue(undefined);
const resolvePlanStepApprovalMock = vi.fn().mockResolvedValue(undefined);

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
    resolvePlanStepApproval: resolvePlanStepApprovalMock,
    getPlanSubject: getPlanSubjectMock,
    getPersistedPlanStep: getPersistedPlanStepMock,
    registerWorkflowForPlan: vi.fn().mockReturnValue({ id: "wf-mock" }),
    listWorkflows: vi.fn().mockReturnValue([]),
  };
});

const TEST_PLAN_ID = "plan-550e8400-e29b-41d4-a716-446655440000";
const ALT_PLAN_ID = "plan-12345678-9abc-4def-8abc-1234567890ab";
const THIRD_PLAN_ID = "plan-abcdefab-cdef-4abc-8def-abcdefabcdef";
const FOURTH_PLAN_ID = "plan-00112233-4455-4677-8899-aabbccddeeff";
const FIFTH_PLAN_ID = "plan-8899aabb-ccdd-4eef-8a0b-112233445566";
const SIXTH_PLAN_ID = "plan-ffeeddcc-bbaa-4a99-8c77-665544332211";

describe("orchestrator auth", () => {
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
    getPlanSubjectMock.mockReset();
    getPlanSubjectMock.mockResolvedValue(undefined);
    getPersistedPlanStepMock.mockReset();
    getPersistedPlanStepMock.mockResolvedValue(undefined);
    resolvePlanStepApprovalMock.mockReset();
    resolvePlanStepApprovalMock.mockResolvedValue(undefined);
    sessionStore.clear();
  });

  it("denies plan event history when subject does not match plan owner", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const planId = TEST_PLAN_ID;
    getPlanSubjectMock.mockResolvedValueOnce({
      sessionId: "session-owner",
      tenantId: "tenant-1",
      userId: "user-owner",
      email: "owner@example.com",
      name: "Owner Subject",
      roles: ["reader"],
      scopes: ["plan.read"],
    });

    const response = await request(app)
      .get(`/plan/${planId}/events`)
      .set("Accept", "application/json")
      .expect(403);

    expect(response.body.message).toContain("subject does not match plan owner");
    expect(policyMock.enforceHttpAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "http.get.plan.events" }),
    );
  });

  it("denies plan event history when capability policy denies access", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const planId = ALT_PLAN_ID;

    policyMock.enforceHttpAction
      .mockResolvedValueOnce({ allow: true, deny: [] })
      .mockResolvedValueOnce({
        allow: false,
        deny: [{ reason: "forbidden", capability: "plan.read" }],
      });

    const response = await request(app)
      .get(`/plan/${planId}/events`)
      .set("Accept", "application/json")
      .expect(403);

    expect(response.body.message).toContain("plan.read denied");
    expect(policyMock.enforceHttpAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "http.get.plan.events.history" }),
    );
  });

  it("denies plan event history when subject does not match plan owner (cookie auth)", async () => {
    const { createServer } = await import("../index.js");
    const baseConfig = loadConfig();
    const config = {
      ...baseConfig,
      auth: {
        ...baseConfig.auth,
        oidc: {
          ...baseConfig.auth.oidc,
          enabled: true,
          issuer: "http://issuer.test",
          clientId: "client-id",
          clientSecret: "client-secret",
        },
      },
    };

    const app = createServer(config);
    const session = sessionStore.createSession(
      {
        subject: "user-owner",
        email: "owner@example.com",
        name: "Owner Subject",
        tenantId: "tenant-2",
        roles: ["reader"],
        scopes: ["plan.read"],
        claims: {},
      },
      config.auth.oidc.session.ttlSeconds,
    );

    getPlanSubjectMock.mockResolvedValueOnce({
      sessionId: "session-original-owner",
      tenantId: "tenant-1",
      userId: session.subject,
      email: session.email,
      name: session.name,
      roles: [...session.roles],
      scopes: [...session.scopes],
    });

    const planId = THIRD_PLAN_ID;
    const response = await request(app)
      .get(`/plan/${planId}/events`)
      .set("Accept", "application/json")
      .set("Cookie", `${config.auth.oidc.session.cookieName}=${session.id}`)
      .expect(403);

    expect(response.status).toBe(403);
    expect(response.body.message).toContain("subject does not match plan owner");
  });

  it("denies plan event history when subject does not match plan owner (OIDC enabled)", async () => {
    const { createServer } = await import("../index.js");
    const config = createOidcEnabledConfig();

    const app = createServer(config);
    const planId = SIXTH_PLAN_ID;

    const ownerSubject = {
      sessionId: "session-owner",
      tenantId: "tenant-1",
      userId: "user-owner",
      email: "owner@example.com",
      name: "Owner Subject",
      roles: ["reader"],
      scopes: ["plan.read"],
    } as const;

    getPlanSubjectMock.mockResolvedValueOnce({ ...ownerSubject });

    const session = sessionStore.createSession(
      {
        subject: "user-other",
        email: "other@example.com",
        name: "Other Subject",
        tenantId: ownerSubject.tenantId,
        roles: ["reader"],
        scopes: ["plan.read"],
        claims: {},
      },
      config.auth.oidc.session.ttlSeconds,
    );

    const response = await request(app)
      .get(`/plan/${planId}/events`)
      .set("Accept", "application/json")
      .set("Cookie", `${config.auth.oidc.session.cookieName}=${session.id}`)
      .expect(403);

    expect(response.body.message).toContain("subject does not match plan owner");
  });

  it("denies SSE plan events when subject does not match plan owner", async () => {
    const { createServer, createHttpServer } = await import("../index.js");
    const config = loadConfig();
    const app = createServer(config);
    const planId = FOURTH_PLAN_ID;
    getPlanSubjectMock.mockResolvedValueOnce({
      sessionId: "session-owner",
      tenantId: "tenant-1",
      userId: "user-owner",
      email: "owner@example.com",
      name: "Owner Subject",
      roles: ["reader"],
      scopes: ["plan.read"],
    });

    const server = createHttpServer(app, config);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== "number") {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      throw new Error("failed to determine server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const connection = await new Promise<{
      request: http.ClientRequest;
      response: http.IncomingMessage;
    }>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/plan/${planId}/events`,
        {
          headers: {
            Accept: "text/event-stream",
          },
        },
        (res) => {
          resolve({ request: req, response: res });
        },
      );
      req.on("error", reject);
      req.end();
    });

    try {
      expect(connection.response.statusCode).toBe(403);

      const body = await new Promise<string>((resolve, reject) => {
        let data = "";
        connection.response.setEncoding("utf8");
        connection.response.on("data", (chunk) => {
          data += chunk;
        });
        connection.response.on("end", () => resolve(data));
        connection.response.on("error", reject);
      });

      expect(body).toContain("subject does not match plan owner");
    } finally {
      connection.request.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("denies SSE plan events when capability policy denies access", async () => {
    const { createServer, createHttpServer } = await import("../index.js");
    const config = loadConfig();
    const app = createServer(config);
    const planId = FIFTH_PLAN_ID;

    policyMock.enforceHttpAction
      .mockResolvedValueOnce({ allow: true, deny: [] })
      .mockResolvedValueOnce({
        allow: false,
        deny: [{ reason: "forbidden", capability: "plan.read" }],
      });

    const server = createHttpServer(app, config);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== "number") {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      throw new Error("failed to determine server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const connection = await new Promise<{
      request: http.ClientRequest;
      response: http.IncomingMessage;
    }>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/plan/${planId}/events`,
        {
          headers: {
            Accept: "text/event-stream",
          },
        },
        (res) => {
          resolve({ request: req, response: res });
        },
      );
      req.on("error", reject);
      req.end();
    });

    try {
      expect(connection.response.statusCode).toBe(403);
      const body = await new Promise<string>((resolve, reject) => {
        let data = "";
        connection.response.setEncoding("utf8");
        connection.response.on("data", (chunk) => {
          data += chunk;
        });
        connection.response.on("end", () => resolve(data));
        connection.response.on("error", reject);
      });
      expect(body).toContain("plan.read denied");
      expect(policyMock.enforceHttpAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "http.get.plan.events.stream" }),
      );
    } finally {
      connection.request.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("allows plan event history when subject matches plan owner", async () => {
    const { createServer } = await import("../index.js");
    const baseConfig = loadConfig();
    const config = {
      ...baseConfig,
      auth: {
        ...baseConfig.auth,
        oidc: {
          ...baseConfig.auth.oidc,
          enabled: true,
          issuer: "http://issuer.test",
          clientId: "client-id",
          clientSecret: "client-secret",
        },
      },
    };

    const app = createServer(config);
    const session = sessionStore.createSession(
      {
        subject: "user-owner",
        email: "owner@example.com",
        name: "Owner Subject",
        tenantId: "tenant-1",
        roles: ["reader"],
        scopes: ["plan.read"],
        claims: {},
      },
      config.auth.oidc.session.ttlSeconds,
    );

    getPlanSubjectMock.mockResolvedValueOnce({
      sessionId: "session-original-owner",
      tenantId: session.tenantId,
      userId: session.subject,
      email: session.email,
      name: session.name,
      roles: [...session.roles],
      scopes: [...session.scopes],
    });

    const planId = SIXTH_PLAN_ID;
    const response = await request(app)
      .get(`/plan/${planId}/events`)
      .set("Accept", "application/json")
      .set("Cookie", `${config.auth.oidc.session.cookieName}=${session.id}`)
      .expect(200);

    expect(response.body.events).toEqual(expect.any(Array));
    expect(response.headers["cache-control"]).toBe(
      "no-cache, no-store, must-revalidate",
    );
    expect(response.headers.pragma).toBe("no-cache");
  });

  it("allows SSE plan events when subject matches plan owner", async () => {
    const { createServer, createHttpServer } = await import("../index.js");
    const baseConfig = loadConfig();
    const config = {
      ...baseConfig,
      auth: {
        ...baseConfig.auth,
        oidc: {
          ...baseConfig.auth.oidc,
          enabled: true,
          issuer: "http://issuer.test",
          clientId: "client-id",
          clientSecret: "client-secret",
        },
      },
    };

    const app = createServer(config);
    const server = createHttpServer(app, config);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== "number") {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      throw new Error("failed to determine server address");
    }

    const session = sessionStore.createSession(
      {
        subject: "user-owner",
        email: "owner@example.com",
        name: "Owner Subject",
        tenantId: "tenant-1",
        roles: ["reader"],
        scopes: ["plan.read"],
        claims: {},
      },
      config.auth.oidc.session.ttlSeconds,
    );

    getPlanSubjectMock.mockResolvedValueOnce({
      sessionId: "session-original-owner",
      tenantId: session.tenantId,
      userId: session.subject,
      email: session.email,
      name: session.name,
      roles: [...session.roles],
      scopes: [...session.scopes],
    });

    const planId = TEST_PLAN_ID;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const connection = await new Promise<{
      request: http.ClientRequest;
      response: http.IncomingMessage;
    }>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/plan/${planId}/events`,
        {
          headers: {
            Accept: "text/event-stream",
            Cookie: `${config.auth.oidc.session.cookieName}=${session.id}`,
          },
        },
        (res) => {
          resolve({ request: req, response: res });
        },
      );
      req.on("error", reject);
      req.end();
    });

    try {
      expect(connection.response.statusCode).toBe(200);
      expect(connection.response.headers["content-type"]).toContain(
        "text/event-stream",
      );
      connection.response.resume();
    } finally {
      connection.request.destroy();
      connection.response.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("allows session reads with credentials when the origin is permitted", async () => {
    const { createServer } = await import("../index.js");
    const config = createOidcEnabledConfig();
    const corsEnabledConfig = {
      ...config,
      server: {
        ...config.server,
        cors: { allowedOrigins: ["https://ui.example.com"] },
      },
    };
    const app = createServer(corsEnabledConfig);
    const session = createSessionForUser(corsEnabledConfig, { userId: "user-789" });
    const cookieName = corsEnabledConfig.auth.oidc.session.cookieName;

    const response = await request(app)
      .get("/auth/session")
      .set("Origin", "https://ui.example.com")
      .set("Cookie", `${cookieName}=${session.id}`)
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe("https://ui.example.com");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.body.session.id).toBe(session.id);
  });

  it("omits CORS headers for untrusted origins to block cookie access", async () => {
    const { createServer } = await import("../index.js");
    const config = createOidcEnabledConfig();
    const corsEnabledConfig = {
      ...config,
      server: {
        ...config.server,
        cors: { allowedOrigins: ["https://ui.example.com"] },
      },
    };
    const app = createServer(corsEnabledConfig);
    const session = createSessionForUser(corsEnabledConfig, { userId: "user-987" });
    const cookieName = corsEnabledConfig.auth.oidc.session.cookieName;

    const response = await request(app)
      .get("/auth/session")
      .set("Origin", "https://evil.example.com")
      .set("Cookie", `${cookieName}=${session.id}`)
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(response.body.session.id).toBe(session.id);
  });

  describe("step approvals", () => {
    it("publishes approval events when a pending step is approved", async () => {
      const { createServer } = await import("../index.js");
      const config = createOidcEnabledConfig();
      const approverSession = createSessionForUser(config, {
        userId: "user-approval",
        tenantId: "tenant-approval",
        email: "approver@example.com",
        name: "Plan Approver"
      });
      const planSubject = {
        sessionId: approverSession.id,
        tenantId: "tenant-approval",
        userId: "user-approval",
        email: "approver@example.com",
        name: "Plan Approver",
        roles: [],
        scopes: []
      };
      getPlanSubjectMock.mockResolvedValue(planSubject);
      const app = createServer(config);

      const planResponse = await request(app)
        .post("/plan")
        .set("Authorization", `Bearer ${approverSession.id}`)
        .send({ goal: "Request approval" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;
      const approvalStep = planResponse.body.plan.steps.find((step: { approvalRequired: boolean }) => step.approvalRequired);
      if (!approvalStep) {
        throw new Error("expected an approval-requiring step");
      }

      publishPlanStepEvent({
        event: "plan.step",
        traceId: "trace-approval",
        planId,
        step: {
          id: approvalStep.id,
          action: approvalStep.action,
          tool: approvalStep.tool,
          state: "waiting_approval",
          capability: approvalStep.capability,
          capabilityLabel: approvalStep.capabilityLabel,
          labels: approvalStep.labels,
          timeoutSeconds: approvalStep.timeoutSeconds,
          approvalRequired: true,
          summary: "Awaiting confirmation"
        }
      });

      await request(app)
        .post(`/plan/${planId}/steps/${approvalStep.id}/approve`)
        .set("Authorization", `Bearer ${approverSession.id}`)
        .send({ decision: "approve", rationale: "Looks good" })
        .expect(204);

      expect(resolvePlanStepApprovalMock).toHaveBeenCalledWith({
        planId,
        stepId: approvalStep.id,
        decision: "approved",
        summary: expect.stringContaining("Looks good")
      });
      expect(getPlanSubjectMock).toHaveBeenCalledWith(planId);
    });

    it("allows approvals when OIDC is disabled", async () => {
      const { createServer } = await import("../index.js");
      const app = createServer();

      const planResponse = await request(app)
        .post("/plan")
        .send({ goal: "Approve without oidc" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;
      const approvalStep = planResponse.body.plan.steps.find((step: { approvalRequired: boolean }) => step.approvalRequired);
      if (!approvalStep) {
        throw new Error("expected an approval-requiring step");
      }

      publishPlanStepEvent({
        event: "plan.step",
        traceId: "trace-no-oidc",
        planId,
        step: {
          id: approvalStep.id,
          action: approvalStep.action,
          tool: approvalStep.tool,
          state: "waiting_approval",
          capability: approvalStep.capability,
          capabilityLabel: approvalStep.capabilityLabel,
          labels: approvalStep.labels,
          timeoutSeconds: approvalStep.timeoutSeconds,
          approvalRequired: true,
          summary: "Awaiting approval"
        }
      });

      await request(app)
        .post(`/plan/${planId}/steps/${approvalStep.id}/approve`)
        .send({ decision: "approve" })
        .expect(204);

      expect(resolvePlanStepApprovalMock).toHaveBeenCalledWith({
        planId,
        stepId: approvalStep.id,
        decision: "approved",
        summary: "Awaiting approval"
      });
      expect(getPlanSubjectMock).toHaveBeenCalledWith(planId);
    });

    it("approves persisted steps when event history is unavailable", async () => {
      const { createServer } = await import("../index.js");
      const app = createServer();

      const planResponse = await request(app)
        .post("/plan")
        .send({ goal: "Approve after restart" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;
      const approvalStep = planResponse.body.plan.steps.find((step: { approvalRequired: boolean }) => step.approvalRequired);
      if (!approvalStep) {
        throw new Error("expected an approval-requiring step");
      }

      clearPlanHistory();

      const stepDefinition = {
        id: approvalStep.id,
        action: approvalStep.action,
        tool: approvalStep.tool,
        capability: approvalStep.capability,
        capabilityLabel: approvalStep.capabilityLabel,
        labels: approvalStep.labels ?? [],
        timeoutSeconds: approvalStep.timeoutSeconds ?? 0,
        approvalRequired: approvalStep.approvalRequired ?? false,
        input: approvalStep.input ?? {},
        metadata: approvalStep.metadata ?? {}
      };
      const persistedStep: PersistedStep = {
        id: "persisted-entry",
        planId,
        stepId: approvalStep.id,
        traceId: "trace-persisted",
        step: stepDefinition,
        state: "waiting_approval",
        summary: "Restored summary",
        updatedAt: new Date().toISOString(),
        attempt: 0,
        idempotencyKey: "persisted-entry",
        createdAt: new Date().toISOString(),
        approvals: {}
      };
      getPersistedPlanStepMock.mockResolvedValueOnce(persistedStep);

      await request(app)
        .post(`/plan/${planId}/steps/${approvalStep.id}/approve`)
        .send({ decision: "approve" })
        .expect(204);

      expect(getPersistedPlanStepMock).toHaveBeenCalledWith(planId, approvalStep.id);
      expect(resolvePlanStepApprovalMock).toHaveBeenCalledWith({
        planId,
        stepId: approvalStep.id,
        decision: "approved",
        summary: "Restored summary"
      });
    });

    it("rejects persisted steps that are not awaiting approval", async () => {
      const { createServer } = await import("../index.js");
      const app = createServer();

      const planResponse = await request(app)
        .post("/plan")
        .send({ goal: "Reject after restart" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;
      const approvalStep = planResponse.body.plan.steps.find((step: { approvalRequired: boolean }) => step.approvalRequired);
      if (!approvalStep) {
        throw new Error("expected an approval-requiring step");
      }

      clearPlanHistory();

      const stepDefinition = {
        id: approvalStep.id,
        action: approvalStep.action,
        tool: approvalStep.tool,
        capability: approvalStep.capability,
        capabilityLabel: approvalStep.capabilityLabel,
        labels: approvalStep.labels ?? [],
        timeoutSeconds: approvalStep.timeoutSeconds ?? 0,
        approvalRequired: approvalStep.approvalRequired ?? false,
        input: approvalStep.input ?? {},
        metadata: approvalStep.metadata ?? {}
      };
      const persistedStep: PersistedStep = {
        id: "persisted-entry-running",
        planId,
        stepId: approvalStep.id,
        traceId: "trace-running",
        step: stepDefinition,
        state: "running",
        updatedAt: new Date().toISOString(),
        attempt: 0,
        idempotencyKey: "persisted-entry-running",
        createdAt: new Date().toISOString(),
        approvals: {}
      };
      getPersistedPlanStepMock.mockResolvedValueOnce(persistedStep);

      await request(app)
        .post(`/plan/${planId}/steps/${approvalStep.id}/approve`)
        .send({ decision: "approve" })
        .expect(409);

      expect(getPersistedPlanStepMock).toHaveBeenCalledWith(planId, approvalStep.id);
      expect(resolvePlanStepApprovalMock).not.toHaveBeenCalled();
    });

    it("publishes rejection events when a pending step is rejected", async () => {
      const { createServer } = await import("../index.js");
      const config = createOidcEnabledConfig();
      const approverSession = createSessionForUser(config, {
        userId: "user-reject",
        tenantId: "tenant-reject",
        email: "rejector@example.com",
        name: "Plan Rejector"
      });
      const planSubject = {
        sessionId: approverSession.id,
        tenantId: "tenant-reject",
        userId: "user-reject",
        email: "rejector@example.com",
        name: "Plan Rejector",
        roles: [],
        scopes: []
      };
      getPlanSubjectMock.mockResolvedValue(planSubject);
      const app = createServer(config);

      const planResponse = await request(app)
        .post("/plan")
        .set("Authorization", `Bearer ${approverSession.id}`)
        .send({ goal: "Reject approval" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;
      const approvalStep = planResponse.body.plan.steps.find((step: { approvalRequired: boolean }) => step.approvalRequired);
      if (!approvalStep) {
        throw new Error("expected an approval-requiring step");
      }

      publishPlanStepEvent({
        event: "plan.step",
        traceId: "trace-reject",
        planId,
        step: {
          id: approvalStep.id,
          action: approvalStep.action,
          tool: approvalStep.tool,
          state: "waiting_approval",
          capability: approvalStep.capability,
          capabilityLabel: approvalStep.capabilityLabel,
          labels: approvalStep.labels,
          timeoutSeconds: approvalStep.timeoutSeconds,
          approvalRequired: true,
          summary: "Pending"
        }
      });

      await request(app)
        .post(`/plan/${planId}/steps/${approvalStep.id}/approve`)
        .set("Authorization", `Bearer ${approverSession.id}`)
        .send({ decision: "reject", rationale: "Needs work" })
        .expect(204);

      expect(resolvePlanStepApprovalMock).toHaveBeenCalledWith({
        planId,
        stepId: approvalStep.id,
        decision: "rejected",
        summary: expect.stringContaining("Needs work")
      });
      expect(getPlanSubjectMock).toHaveBeenCalledWith(planId);
    });

    it("returns a conflict when the step is not awaiting approval", async () => {
      const { createServer } = await import("../index.js");
      const config = createOidcEnabledConfig();
      const approverSession = createSessionForUser(config, {
        userId: "user-conflict",
        tenantId: "tenant-conflict",
        email: "conflict@example.com",
        name: "Conflict User"
      });
      const planSubject = {
        sessionId: approverSession.id,
        tenantId: "tenant-conflict",
        userId: "user-conflict",
        email: "conflict@example.com",
        name: "Conflict User",
        roles: [],
        scopes: []
      };
      getPlanSubjectMock.mockResolvedValue(planSubject);
      const app = createServer(config);

      const planResponse = await request(app)
        .post("/plan")
        .set("Authorization", `Bearer ${approverSession.id}`)
        .send({ goal: "Invalid state" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;
      const approvalStep = planResponse.body.plan.steps.find((step: { approvalRequired: boolean }) => step.approvalRequired);
      if (!approvalStep) {
        throw new Error("expected an approval-requiring step");
      }

    publishPlanStepEvent({
      event: "plan.step",
      traceId: "trace-conflict",
      planId,
      step: {
        id: approvalStep.id,
        action: approvalStep.action,
        tool: approvalStep.tool,
        state: "queued",
        capability: approvalStep.capability,
        capabilityLabel: approvalStep.capabilityLabel,
        labels: approvalStep.labels,
        timeoutSeconds: approvalStep.timeoutSeconds,
        approvalRequired: true,
        summary: "Ready to execute"
      }
    });

      await request(app)
        .post(`/plan/${planId}/steps/${approvalStep.id}/approve`)
        .set("Authorization", `Bearer ${approverSession.id}`)
        .send({ decision: "approve" })
        .expect(409);
    });

    it("returns not found when the step has no history", async () => {
      const { createServer } = await import("../index.js");
      const config = createOidcEnabledConfig();
      const approverSession = createSessionForUser(config, {
        userId: "user-notfound",
        tenantId: "tenant-notfound",
        email: "missing@example.com",
        name: "Missing Step"
      });
      const planSubject = {
        sessionId: approverSession.id,
        tenantId: "tenant-notfound",
        userId: "user-notfound",
        email: "missing@example.com",
        name: "Missing Step",
        roles: [],
        scopes: []
      };
      getPlanSubjectMock.mockResolvedValue(planSubject);
      const app = createServer(config);

      const planResponse = await request(app)
        .post("/plan")
        .set("Authorization", `Bearer ${approverSession.id}`)
        .send({ goal: "Unknown step" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;

      await request(app)
        .post(`/plan/${planId}/steps/does-not-exist/approve`)
        .set("Authorization", `Bearer ${approverSession.id}`)
        .send({ decision: "approve" })
        .expect(404);
    });

    it("rejects approvals without an authenticated session", async () => {
      const { createServer } = await import("../index.js");
      const config = createOidcEnabledConfig();
      const ownerSession = createSessionForUser(config, {
        userId: "user-nosession",
        tenantId: "tenant-nosession",
        email: "owner@example.com",
        name: "Plan Owner"
      });
      const planSubject = {
        sessionId: ownerSession.id,
        tenantId: "tenant-nosession",
        userId: "user-nosession",
        email: "owner@example.com",
        name: "Plan Owner",
        roles: [],
        scopes: []
      };
      getPlanSubjectMock.mockResolvedValue(planSubject);
      const app = createServer(config);

      const planResponse = await request(app)
        .post("/plan")
        .set("Authorization", `Bearer ${ownerSession.id}`)
        .send({ goal: "Require auth" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;
      const approvalStep = planResponse.body.plan.steps.find((step: { approvalRequired: boolean }) => step.approvalRequired);
      if (!approvalStep) {
        throw new Error("expected an approval-requiring step");
      }
      const initialPolicyCalls = policyMock.enforceHttpAction.mock.calls.length;

      publishPlanStepEvent({
        event: "plan.step",
        traceId: "trace-nosession",
        planId,
        step: {
          id: approvalStep.id,
          action: approvalStep.action,
          tool: approvalStep.tool,
          state: "waiting_approval",
          capability: approvalStep.capability,
          capabilityLabel: approvalStep.capabilityLabel,
          labels: approvalStep.labels,
          timeoutSeconds: approvalStep.timeoutSeconds,
          approvalRequired: true,
          summary: "Awaiting approval"
        }
      });

      const response = await request(app)
        .post(`/plan/${planId}/steps/${approvalStep.id}/approve`)
        .send({ decision: "approve" })
        .expect(401);

      expect(response.body).toMatchObject({
        code: "unauthorized",
        message: "authentication required",
      });
      expect(resolvePlanStepApprovalMock).not.toHaveBeenCalled();
      expect(getPlanSubjectMock).not.toHaveBeenCalled();
      expect(policyMock.enforceHttpAction).toHaveBeenCalledTimes(initialPolicyCalls);
    });

    it("rejects approvals from a different user", async () => {
      const { createServer } = await import("../index.js");
      const config = createOidcEnabledConfig();
      const ownerSession = createSessionForUser(config, {
        userId: "user-owner",
        tenantId: "tenant-shared",
        email: "owner@example.com",
        name: "Plan Owner"
      });
      const attackerSession = createSessionForUser(config, {
        userId: "user-attacker",
        tenantId: "tenant-shared",
        email: "attacker@example.com",
        name: "Attacker"
      });
      const planSubject = {
        sessionId: ownerSession.id,
        tenantId: "tenant-shared",
        userId: "user-owner",
        email: "owner@example.com",
        name: "Plan Owner",
        roles: [],
        scopes: []
      };
      getPlanSubjectMock.mockResolvedValue(planSubject);
      const app = createServer(config);

      const planResponse = await request(app)
        .post("/plan")
        .set("Authorization", `Bearer ${ownerSession.id}`)
        .send({ goal: "Protect plan" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;
      const approvalStep = planResponse.body.plan.steps.find((step: { approvalRequired: boolean }) => step.approvalRequired);
      if (!approvalStep) {
        throw new Error("expected an approval-requiring step");
      }
      const initialPolicyCalls = policyMock.enforceHttpAction.mock.calls.length;

      publishPlanStepEvent({
        event: "plan.step",
        traceId: "trace-attacker",
        planId,
        step: {
          id: approvalStep.id,
          action: approvalStep.action,
          tool: approvalStep.tool,
          state: "waiting_approval",
          capability: approvalStep.capability,
          capabilityLabel: approvalStep.capabilityLabel,
          labels: approvalStep.labels,
          timeoutSeconds: approvalStep.timeoutSeconds,
          approvalRequired: true,
          summary: "Awaiting approval"
        }
      });

      const response = await request(app)
        .post(`/plan/${planId}/steps/${approvalStep.id}/approve`)
        .set("Authorization", `Bearer ${attackerSession.id}`)
        .send({ decision: "approve" })
        .expect(403);

      expect(response.body).toMatchObject({
        code: "forbidden",
        message: "approval subject mismatch",
      });
      expect(resolvePlanStepApprovalMock).not.toHaveBeenCalled();
      expect(policyMock.enforceHttpAction).toHaveBeenCalledTimes(initialPolicyCalls);
      expect(getPlanSubjectMock).toHaveBeenCalledWith(planId);
    });

    it("approves when the subject matches even if the session has rotated", async () => {
      const { createServer } = await import("../index.js");
      const config = createOidcEnabledConfig();
      const ownerSession = createSessionForUser(config, {
        userId: "user-owner-agent",
        tenantId: "tenant-agent",
        email: "owner-agent@example.com",
        name: "Plan Owner Agent"
      });
      const spoofedSession = createSessionForUser(config, {
        userId: "user-owner-agent",
        tenantId: "tenant-agent",
        email: "spoof@example.com",
        name: "Spoofed Agent"
      });
      const planSubject = {
        sessionId: ownerSession.id,
        tenantId: "tenant-agent",
        userId: "user-owner-agent",
        email: "owner-agent@example.com",
        name: "Plan Owner Agent",
        roles: [],
        scopes: []
      };
      getPlanSubjectMock.mockResolvedValue(planSubject);
      const app = createServer(config);

      const planResponse = await request(app)
        .post("/plan")
        .set("Authorization", `Bearer ${ownerSession.id}`)
        .send({ goal: "Defend plan" })
        .expect(201);
      const planId: string = planResponse.body.plan.id;
      const approvalStep = planResponse.body.plan.steps.find((step: { approvalRequired: boolean }) => step.approvalRequired);
      if (!approvalStep) {
        throw new Error("expected an approval-requiring step");
      }
      const initialPolicyCalls = policyMock.enforceHttpAction.mock.calls.length;

      publishPlanStepEvent({
        event: "plan.step",
        traceId: "trace-spoof",
        planId,
        step: {
          id: approvalStep.id,
          action: approvalStep.action,
          tool: approvalStep.tool,
          state: "waiting_approval",
          capability: approvalStep.capability,
          capabilityLabel: approvalStep.capabilityLabel,
          labels: approvalStep.labels,
          timeoutSeconds: approvalStep.timeoutSeconds,
          approvalRequired: true,
          summary: "Awaiting approval"
        }
      });

      await request(app)
        .post(`/plan/${planId}/steps/${approvalStep.id}/approve`)
        .set("Authorization", `Bearer ${spoofedSession.id}`)
        .set("x-agent", "code_writer")
        .send({ decision: "approve" })
        .expect(204);

      expect(resolvePlanStepApprovalMock).toHaveBeenCalledWith({
        planId,
        stepId: approvalStep.id,
        decision: "approved",
        summary: expect.stringContaining("Awaiting approval"),
      });
      expect(policyMock.enforceHttpAction).toHaveBeenCalledTimes(
        initialPolicyCalls + 1,
      );
      expect(getPlanSubjectMock).toHaveBeenCalledWith(planId);
    });
  });
});

