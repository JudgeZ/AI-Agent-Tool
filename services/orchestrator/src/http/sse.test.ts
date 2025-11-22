import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearPlanHistory, getPlanHistory, publishPlanStepEvent } from "../plan/events.js";
import { sessionStore } from "../auth/SessionStore.js";

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

describe("orchestrator sse", () => {
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
    sessionStore.clear();
  });

  it("limits concurrent SSE connections per IP", async () => {
    const { createServer, createHttpServer } = await import("../index.js");
    const { loadConfig } = await import("../config.js");

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
      const payload = JSON.parse(body);
      expect(payload).toMatchObject({
        code: "too_many_requests",
        message: "too many concurrent event streams",
      });
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
    const { createServer, createHttpServer } = await import("../index.js");
    const { loadConfig } = await import("../config.js");

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

  it("releases SSE quotas when history replay writes fail", async () => {
    const { createServer, createHttpServer } = await import("../index.js");
    const { loadConfig } = await import("../config.js");

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
      .send({ goal: "history replay resiliency" })
      .expect(201);

    const planId: string = planResponse.body.plan.id;
    const firstStep = planResponse.body.plan.steps[0];
    if (!firstStep) {
      throw new Error("expected a plan step to exist");
    }

    publishPlanStepEvent({
      event: "plan.step",
      traceId: "trace-history-replay",
      planId,
      step: {
        id: firstStep.id,
        action: firstStep.action,
        tool: firstStep.tool,
        state: "queued",
        capability: firstStep.capability,
        capabilityLabel: firstStep.capabilityLabel,
        labels: firstStep.labels,
        timeoutSeconds: firstStep.timeoutSeconds,
        approvalRequired: firstStep.approvalRequired,
        summary: firstStep.summary ?? undefined,
      },
    });

    expect(getPlanHistory(planId).length).toBeGreaterThan(0);

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

    const originalWrite = http.ServerResponse.prototype.write;
    let firstWriteFailed = false;
    const writeSpy = vi
      .spyOn(http.ServerResponse.prototype, "write")
      .mockImplementation(function (this: http.ServerResponse, chunk: unknown, encoding?: unknown, cb?: unknown) {
        if (!firstWriteFailed && typeof chunk === "string" && chunk.startsWith("event: ")) {
          firstWriteFailed = true;
          throw new Error("write failure");
        }
        return originalWrite.call(this, chunk as never, encoding as never, cb as never);
      });

    let firstConnection: { request: http.ClientRequest; response: http.IncomingMessage } | undefined;
    try {
      firstConnection = await openSse(`${baseUrl}/plan/${planId}/events`);
      expect(firstConnection.response.statusCode).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      writeSpy.mockRestore();
    }

    expect(firstWriteFailed).toBe(true);

    const secondConnection = await openSse(`${baseUrl}/plan/${planId}/events`);
    try {
      expect(secondConnection.response.statusCode).toBe(200);
      secondConnection.response.resume();
    } finally {
      secondConnection.request.destroy();
      secondConnection.response.destroy();
    }

    if (firstConnection) {
      firstConnection.request.destroy();
      firstConnection.response.destroy();
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
  });

  it("keeps SSE streams alive when write backpressure occurs", async () => {
    const { createServer, createHttpServer } = await import("../index.js");
    const { loadConfig } = await import("../config.js");

    const baseConfig = loadConfig();
    const config = {
      ...baseConfig,
      server: {
        ...baseConfig.server,
        sseKeepAliveMs: 50,
      },
    };

    const app = createServer(config);
    const planResponse = await request(app)
      .post("/plan")
      .send({ goal: "backpressure resilience" })
      .expect(201);

    const planId: string = planResponse.body.plan.id;
    const firstStep = planResponse.body.plan.steps[0];
    if (!firstStep) {
      throw new Error("expected a plan step to exist");
    }

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

    const originalWrite = http.ServerResponse.prototype.write;
    let backpressureApplied = false;
    let drainEmitter: (() => void) | undefined;
    let drained = false;
    let event2WritesBeforeDrain = 0;
    let event2WritesAfterDrain = 0;
    const writeSpy = vi
      .spyOn(http.ServerResponse.prototype, "write")
      .mockImplementation(function (this: http.ServerResponse, chunk: unknown, encoding?: unknown, cb?: unknown) {
        if (
          !backpressureApplied &&
          typeof chunk === "string" &&
          chunk.includes("backpressure-event-1")
        ) {
          backpressureApplied = true;
          originalWrite.call(this, chunk as never, encoding as never, cb as never);
          drainEmitter = () => {
            drained = true;
            this.emit("drain");
          };
          return false;
        }
        if (typeof chunk === "string" && chunk.includes("backpressure-event-2")) {
          if (drained) {
            event2WritesAfterDrain += 1;
          } else {
            event2WritesBeforeDrain += 1;
          }
        }
        return originalWrite.call(this, chunk as never, encoding as never, cb as never);
      });

    let connection: { request: http.ClientRequest; response: http.IncomingMessage } | undefined;
    try {
      connection = await openSse(`${baseUrl}/plan/${planId}/events`);
      expect(connection.response.statusCode).toBe(200);
      connection.response.setEncoding("utf8");

      let closed = false;
      connection.response.on("close", () => {
        closed = true;
      });

      const received: string[] = [];
      connection.response.on("data", (chunk) => {
        received.push(chunk);
      });

      publishPlanStepEvent({
        event: "plan.step",
        traceId: "trace-backpressure-1",
        planId,
        step: {
          id: firstStep.id,
          action: firstStep.action,
          tool: firstStep.tool,
          state: "queued",
          capability: firstStep.capability,
          capabilityLabel: firstStep.capabilityLabel,
          labels: firstStep.labels,
          timeoutSeconds: firstStep.timeoutSeconds,
          approvalRequired: firstStep.approvalRequired,
          summary: "backpressure-event-1",
        },
      });

      setTimeout(() => {
        publishPlanStepEvent({
          event: "plan.step",
          traceId: "trace-backpressure-2",
          planId,
          step: {
            id: firstStep.id,
            action: firstStep.action,
            tool: firstStep.tool,
            state: "running",
            capability: firstStep.capability,
            capabilityLabel: firstStep.capabilityLabel,
            labels: firstStep.labels,
            timeoutSeconds: firstStep.timeoutSeconds,
            approvalRequired: firstStep.approvalRequired,
            summary: "backpressure-event-2",
          },
        });
      }, 10);

      await new Promise((resolve) => setTimeout(resolve, 75));

      expect(drainEmitter).toBeDefined();
      expect(event2WritesBeforeDrain).toBe(0);

      drainEmitter?.();

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(closed).toBe(false);
      const payload = received.join("");
      expect(payload).toContain("backpressure-event-1");
      expect(payload).toContain("backpressure-event-2");
      expect(event2WritesAfterDrain).toBeGreaterThan(0);
    } finally {
      writeSpy.mockRestore();
      if (connection) {
        connection.request.destroy();
        connection.response.destroy();
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

  it("queues keep-alive writes when backpressure occurs", async () => {
    const { createServer, createHttpServer } = await import("../index.js");
    const { loadConfig } = await import("../config.js");

    const baseConfig = loadConfig();
    const config = {
      ...baseConfig,
      server: {
        ...baseConfig.server,
        sseKeepAliveMs: 25,
      },
    };

    const app = createServer(config);
    const planResponse = await request(app)
      .post("/plan")
      .send({ goal: "keep alive backpressure" })
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

    const originalWrite = http.ServerResponse.prototype.write;
    let keepAliveBackpressured = false;
    const writeSpy = vi
      .spyOn(http.ServerResponse.prototype, "write")
      .mockImplementation(function (this: http.ServerResponse, chunk: unknown, encoding?: unknown, cb?: unknown) {
        if (
          !keepAliveBackpressured &&
          typeof chunk === "string" &&
          chunk.trim() === ": keep-alive"
        ) {
          keepAliveBackpressured = true;
          originalWrite.call(this, chunk as never, encoding as never, cb as never);
          setTimeout(() => {
            this.emit("drain");
          }, 100);
          return false;
        }
        return originalWrite.call(this, chunk as never, encoding as never, cb as never);
      });

    let connection: { request: http.ClientRequest; response: http.IncomingMessage } | undefined;
    try {
      connection = await openSse(`${baseUrl}/plan/${planId}/events`);
      expect(connection.response.statusCode).toBe(200);
      connection.response.setEncoding("utf8");

      let closed = false;
      connection.response.on("close", () => {
        closed = true;
      });

      const received: string[] = [];
      connection.response.on("data", (chunk) => {
        received.push(chunk);
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(closed).toBe(false);
      const payload = received.join("");
      const keepAliveOccurrences = payload.split(": keep-alive").length - 1;
      expect(keepAliveOccurrences).toBeGreaterThanOrEqual(2);
      expect(keepAliveBackpressured).toBe(true);
    } finally {
      writeSpy.mockRestore();
      if (connection) {
        connection.request.destroy();
        connection.response.destroy();
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
});

