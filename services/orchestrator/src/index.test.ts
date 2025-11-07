import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import express from "express";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionStore } from "./auth/SessionStore.js";

import { clearPlanHistory, getPlanHistory, publishPlanStepEvent } from "./plan/events.js";

vi.mock("./providers/ProviderRegistry.js", () => {
  return {
    routeChat: vi.fn().mockResolvedValue({ output: "hello", usage: { promptTokens: 5, completionTokens: 3 } })
  };
});

const policyMock = {
  enforceHttpAction: vi.fn().mockResolvedValue({ allow: true, deny: [] })
};

const getPlanSubjectMock = vi.fn().mockResolvedValue(undefined);

vi.mock("./policy/PolicyEnforcer.js", () => {
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

vi.mock("./queue/PlanQueueRuntime.js", () => {
  return {
    initializePlanQueueRuntime: vi.fn().mockResolvedValue(undefined),
    submitPlanSteps: vi.fn().mockResolvedValue(undefined),
    resolvePlanStepApproval: vi.fn().mockResolvedValue(undefined),
    getPlanSubject: getPlanSubjectMock
  };
});

describe("orchestrator http api", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    clearPlanHistory();
  });

  afterEach(() => {
    clearPlanHistory();
    fs.rmSync(path.join(process.cwd(), ".plans"), { recursive: true, force: true });
    vi.clearAllMocks();
    policyMock.enforceHttpAction.mockReset();
    policyMock.enforceHttpAction.mockResolvedValue({ allow: true, deny: [] });
    getPlanSubjectMock.mockReset();
    getPlanSubjectMock.mockResolvedValue(undefined);
    sessionStore.clear();
  });

  it("creates a plan and exposes step events", async () => {
    const { createServer } = await import("./index.js");
    const app = createServer();

    const planResponse = await request(app).post("/plan").send({ goal: "Ship the next milestone" }).expect(201);

    expect(planResponse.body.plan).toBeDefined();
    expect(planResponse.body.plan.goal).toBe("Ship the next milestone");
    expect(planResponse.body.traceId).toBeTruthy();

    const { submitPlanSteps } = await import("./queue/PlanQueueRuntime.js");
    expect(submitPlanSteps).toHaveBeenCalledWith(expect.objectContaining({ id: planResponse.body.plan.id }), expect.any(String));

    const planId: string = planResponse.body.plan.id;

    const eventsResponse = await request(app)
      .get(`/plan/${planId}/events`)
      .set("Accept", "application/json")
      .expect(200);

    expect(eventsResponse.body.events).toHaveLength(planResponse.body.plan.steps.length);
    expect(eventsResponse.body.events[0].step.capability).toBeDefined();
  });

  it("handles concurrent plan creation requests without blocking the event loop", async () => {
    const { createServer } = await import("./index.js");
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
    const { createServer } = await import("./index.js");
    const app = createServer();

    const response = await request(app).post("/plan").send({ goal: "   " }).expect(400);

    expect(response.body.error).toBe("invalid request");
    expect(response.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "goal" })]),
    );
  });

  it("limits concurrent SSE connections per IP", async () => {
    const { createServer, createHttpServer } = await import("./index.js");
    const { loadConfig } = await import("./config.js");

    const baseConfig = loadConfig();
    const config = {
      ...baseConfig,
      server: {
        ...baseConfig.server,
        sseQuotas: {
          perIp: 1,
          perSubject: 1,
        },
      },
    };

    const app = createServer(config);
    const planResponse = await request(app)
      .post("/plan")
      .send({ goal: "limit sse" })
      .expect(201);

    const planId: string = planResponse.body.plan.id;

    const server = createHttpServer(app, config);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });

    let serverClosed = false;
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
      serverClosed = true;
      throw new Error("failed to determine server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const openSse = (url: string) =>
      new Promise<{ request: http.ClientRequest; response: http.IncomingMessage }>((resolve, reject) => {
        const req = http.request(
          url,
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

    let firstConnection: { request: http.ClientRequest; response: http.IncomingMessage } | undefined;
    try {
      firstConnection = await openSse(`${baseUrl}/plan/${planId}/events`);
      expect(firstConnection.response.statusCode).toBe(200);

      const secondConnection = await openSse(`${baseUrl}/plan/${planId}/events`);
      expect(secondConnection.response.statusCode).toBe(429);

      const body = await new Promise<string>((resolve, reject) => {
        let data = "";
        secondConnection.response.setEncoding("utf8");
        secondConnection.response.on("data", (chunk) => {
          data += chunk;
        });
        secondConnection.response.on("end", () => resolve(data));
        secondConnection.response.on("error", reject);
      });
      expect(body).toContain("too many concurrent event streams");
      secondConnection.request.destroy();
      secondConnection.request.destroy();
    } finally {
      if (firstConnection) {
        firstConnection.request.destroy();
      }
      if (!serverClosed) {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
        serverClosed = true;
      }
    }
  });

  it("cleans up keep-alive intervals when clients disconnect", async () => {
    const { createServer, createHttpServer } = await import("./index.js");
    const { loadConfig } = await import("./config.js");

    const baseConfig = loadConfig();
    const config = {
      ...baseConfig,
      server: {
        ...baseConfig.server,
        sseKeepAliveMs: 10,
        sseQuotas: {
          perIp: 1,
          perSubject: 1,
        },
      },
    };

    const app = createServer(config);
    const planResponse = await request(app)
      .post("/plan")
      .send({ goal: "resilient keep alive" })
      .expect(201);

    const planId: string = planResponse.body.plan.id;

    const server = createHttpServer(app, config);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });

    let serverClosed = false;
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
      serverClosed = true;
      throw new Error("failed to determine server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const openSse = (url: string) =>
      new Promise<{ request: http.ClientRequest; response: http.IncomingMessage }>((resolve, reject) => {
        const req = http.request(
          url,
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

    let shouldFailWrites = false;
    let keepAliveWriteFailed = false;
    let keepAliveWrites = 0;
    let keepAliveWritesAtFailure = 0;
    const originalWrite = http.ServerResponse.prototype.write;
    const writeSpy = vi
      .spyOn(http.ServerResponse.prototype, "write")
      .mockImplementation(function (this: http.ServerResponse, chunk: unknown, encoding?: unknown, cb?: unknown) {
        if (typeof chunk === "string" && chunk.includes(": keep-alive")) {
          keepAliveWrites += 1;
          if (shouldFailWrites) {
            keepAliveWriteFailed = true;
            keepAliveWritesAtFailure = keepAliveWrites;
            return false;
          }
        }
        return originalWrite.call(this, chunk as never, encoding as never, cb as never);
      });

    let firstConnection: { request: http.ClientRequest; response: http.IncomingMessage } | undefined;
    try {
      firstConnection = await openSse(`${baseUrl}/plan/${planId}/events`);
      expect(firstConnection.response.statusCode).toBe(200);
      firstConnection.response.resume();

      await new Promise((resolve) => setTimeout(resolve, config.server.sseKeepAliveMs * 2));

      const writesBeforeClose = keepAliveWrites;
      expect(writesBeforeClose).toBeGreaterThan(0);

      const connectionClosed = new Promise<void>((resolve) => {
        firstConnection?.response.on("close", resolve);
        firstConnection?.response.on("end", resolve);
        firstConnection?.response.on("error", () => resolve());
      });

      shouldFailWrites = true;
      firstConnection.request.destroy();
      await connectionClosed;

      await new Promise((resolve) => setTimeout(resolve, config.server.sseKeepAliveMs * 2));

      if (keepAliveWriteFailed) {
        expect(keepAliveWritesAtFailure).toBeGreaterThan(0);
        expect(keepAliveWrites).toBe(keepAliveWritesAtFailure);
      } else {
        expect(keepAliveWrites).toBe(writesBeforeClose);
      }

      shouldFailWrites = false;

      const secondConnection = await openSse(`${baseUrl}/plan/${planId}/events`);
      expect(secondConnection.response.statusCode).toBe(200);
      secondConnection.response.resume();
      secondConnection.request.destroy();

      const healthStatus = await new Promise<number>((resolve, reject) => {
        http
          .get(`${baseUrl}/healthz`, (res) => {
            const status = res.statusCode ?? 0;
            res.resume();
            resolve(status);
          })
          .on("error", reject);
      });
      expect(healthStatus).toBe(200);
    } finally {
      writeSpy.mockRestore();
      if (firstConnection) {
        firstConnection.request.destroy();
      }
      if (!serverClosed) {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            serverClosed = true;
            resolve();
          });
        });
      }
    }
  });

  it("denies plan event history when subject does not match plan owner", async () => {
    const { createServer } = await import("./index.js");
    const app = createServer();

    const planId = "plan-deadbeef";
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

    expect(response.body.error).toContain("subject does not match plan owner");
    expect(policyMock.enforceHttpAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "http.get.plan.events" }),
    );
  });

  it("denies plan event history when tenant does not match plan owner", async () => {
    const { createServer } = await import("./index.js");
    const { loadConfig } = await import("./config.js");

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
        tokens: {},
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

    const planId = "plan-ffee0011";
    const response = await request(app)
      .get(`/plan/${planId}/events`)
      .set("Accept", "application/json")
      .set("Cookie", `${config.auth.oidc.session.cookieName}=${session.id}`)
      .expect(403);

    expect(response.status).toBe(403);
    expect(response.body.error).toContain("subject does not match plan owner");
  });

  it("denies SSE plan events when subject does not match plan owner", async () => {
    const { createServer, createHttpServer } = await import("./index.js");
    const { loadConfig } = await import("./config.js");

    const config = loadConfig();
    const app = createServer(config);
    const planId = "plan-cafebabe";
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

  it("allows plan event history when subject matches plan owner", async () => {
    const { createServer } = await import("./index.js");
    const { loadConfig } = await import("./config.js");

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
        tokens: {},
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

    const planId = "plan-1234abcd";
    const response = await request(app)
      .get(`/plan/${planId}/events`)
      .set("Accept", "application/json")
      .set("Cookie", `${config.auth.oidc.session.cookieName}=${session.id}`)
      .expect(200);

    expect(response.body.events).toEqual(expect.any(Array));
  });

  it("allows SSE plan events when subject matches plan owner", async () => {
    const { createServer, createHttpServer } = await import("./index.js");
    const { loadConfig } = await import("./config.js");

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
        tokens: {},
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

    const planId = "plan-abcdef12";
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

  it("exposes Prometheus metrics", async () => {
    const { createServer } = await import("./index.js");
    const app = createServer();

    const metricsResponse = await request(app).get("/metrics").expect(200);
    expect(metricsResponse.headers["content-type"]).toContain("text/plain");
    expect(metricsResponse.text).toContain("orchestrator_queue_depth");
  });

  describe("step approvals", () => {
    it("publishes approval events when a pending step is approved", async () => {
      const { createServer } = await import("./index.js");
      const app = createServer();

      const planResponse = await request(app).post("/plan").send({ goal: "Request approval" }).expect(201);
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
        .send({ decision: "approve", rationale: "Looks good" })
        .expect(204);

      const { resolvePlanStepApproval } = await import("./queue/PlanQueueRuntime.js");
      expect(resolvePlanStepApproval).toHaveBeenCalledWith({
        planId,
        stepId: approvalStep.id,
        decision: "approved",
        summary: expect.stringContaining("Looks good")
      });
    });

    it("publishes rejection events when a pending step is rejected", async () => {
      const { createServer } = await import("./index.js");
      const app = createServer();

      const planResponse = await request(app).post("/plan").send({ goal: "Reject approval" }).expect(201);
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
        .send({ decision: "reject", rationale: "Needs work" })
        .expect(204);

      const { resolvePlanStepApproval } = await import("./queue/PlanQueueRuntime.js");
      expect(resolvePlanStepApproval).toHaveBeenCalledWith({
        planId,
        stepId: approvalStep.id,
        decision: "rejected",
        summary: expect.stringContaining("Needs work")
      });
    });

    it("returns a conflict when the step is not awaiting approval", async () => {
      const { createServer } = await import("./index.js");
      const app = createServer();

      const planResponse = await request(app).post("/plan").send({ goal: "Invalid state" }).expect(201);
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
        .send({ decision: "approve" })
        .expect(409);
    });

    it("returns not found when the step has no history", async () => {
      const { createServer } = await import("./index.js");
      const app = createServer();

      const planResponse = await request(app).post("/plan").send({ goal: "Unknown step" }).expect(201);
      const planId: string = planResponse.body.plan.id;

      await request(app)
        .post(`/plan/${planId}/steps/does-not-exist/approve`)
        .send({ decision: "approve" })
        .expect(404);
    });
  });

  it("routes chat requests through the provider registry", async () => {
    const { createServer } = await import("./index.js");
    const app = createServer();

    const chatResponse = await request(app)
      .post("/chat")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(200);

    expect(chatResponse.body.traceId).toBeTruthy();
    expect(chatResponse.body.response.output).toBe("hello");

    const { routeChat } = await import("./providers/ProviderRegistry.js");
    expect(routeChat).toHaveBeenCalledWith({ messages: [{ role: "user", content: "hi" }] });
  });

  it("validates chat payloads", async () => {
    const { createServer } = await import("./index.js");
    const app = createServer();

    const invalidResponse = await request(app).post("/chat").send({}).expect(400);
    expect(invalidResponse.body.error).toBe("invalid request");
    expect(Array.isArray(invalidResponse.body.details)).toBe(true);
    expect(invalidResponse.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "messages" }),
      ]),
    );
  });
});

describe("createHttpServer", () => {
  const TEST_CERT = "-----BEGIN CERTIFICATE-----\nMIIBsjCCAVmgAwIBAgIUFRDummyCertExample000000000000000wDQYJKoZIhvcNAQELBQAwEzERMA8GA1UEAwwIdGVzdC1jYTAeFw0yNTAxMDEwMDAwMDBaFw0zNTAxMDEwMDAwMDBaMBMxETAPBgNVBAMMCHRlc3QtY2EwXDANBgkqhkiG9w0BAQEFAANLADBIAkEAxX0p+Qn3zX2Bqk9N0xYp7xIqh+apMI2vlA38nSxrdbidKdvUSsfx8bVsgcuyo6edSxnl2xe50Tzw9uQWGWpZJwIDAQABMA0GCSqGSIb3DQEBCwUAA0EAKtO2Qd6hw2yYB9H9n1tFoZT3zh0+BTtPlqvGjufH6G+jD/adJzi10BGSAdoo6gWQBaIj++ImQxGc1dQc5sKXc/w==\n-----END CERTIFICATE-----\n";
  const TEST_KEY = "-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAxX0p+Qn3zX2Bqk9N0xYp7xIqh+apMI2vlA38nSxrdbidKdvUSsfx8bVsgcuyo6edSxnl2xe50Tzw9uQWGWpZJwIDAQABAkAy70dNDO7xjoMnIKh4j/wcgUp3NEPoPFcAckU4iigIvuXvYDn8ApX2HFqRSbuuSSMzdg3NofM8JrIoVNewc19AiEA6yF87o5iV/mQJu1WDVYj1WFJsbgx5caX5/C/PObbIV8CIQDPLOcAfeUeawuO/7dBDEuDfSU/EYEYVplpXCMVvjJPEwIhAJBgqsSVqSdz+CA0nVddOZXS6jttuPAHyBs+K6TfGsZ5AiBWlQt1zArhcXd1LSeX776BF3/f6/Dr7guPmyAnbcWfSQIhAMAnbcWcCYwiVdc+GqOR/mdrIW6DCeU44yWiNysGEi2S\n-----END PRIVATE KEY-----\n";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an HTTPS server that enforces client certificates", async () => {
    const { loadConfig } = await import("./config.js");
    const { createHttpServer } = await import("./index.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mtls-test-"));
    const keyPath = path.join(tmpDir, "server.key");
    const certPath = path.join(tmpDir, "server.crt");
    const caPath = path.join(tmpDir, "ca.crt");
    fs.writeFileSync(keyPath, TEST_KEY);
    fs.writeFileSync(certPath, TEST_CERT);
    fs.writeFileSync(caPath, TEST_CERT);

    const captured: https.ServerOptions[] = [];
    const fakeHttpsServer = { listen: vi.fn() } as unknown as https.Server;
    const httpsSpy = vi
      .spyOn(https, "createServer")
      .mockImplementation(((options: https.ServerOptions) => {
        captured.push(options);
        return fakeHttpsServer;
      }) as unknown as typeof https.createServer);
    const httpSpy = vi.spyOn(http, "createServer");

    const config = loadConfig();
    config.server.tls = {
      enabled: true,
      keyPath,
      certPath,
      caPaths: [caPath],
      requestClientCert: true
    };

    const app = express();
    const server = createHttpServer(app, config);

    expect(server).toBe(fakeHttpsServer);
    expect(httpsSpy).toHaveBeenCalledTimes(1);
    expect(httpSpy).not.toHaveBeenCalled();

    const options = captured[0]!;
    expect(options.requestCert).toBe(true);
    expect(options.rejectUnauthorized).toBe(true);
    const ca = options.ca;
    expect(ca).toBeDefined();
    expect(Array.isArray(ca)).toBe(true);
    if (Array.isArray(ca)) {
      expect(ca).toHaveLength(1);
    }
  });

  it("throws when TLS is enabled without key material", async () => {
    const { loadConfig } = await import("./config.js");
    const { createHttpServer } = await import("./index.js");

    const config = loadConfig();
    config.server.tls = {
      enabled: true,
      keyPath: "",
      certPath: "",
      caPaths: [],
      requestClientCert: true
    };

    expect(() => createHttpServer(express(), config)).toThrow("TLS is enabled but keyPath or certPath is undefined");
  });
});
