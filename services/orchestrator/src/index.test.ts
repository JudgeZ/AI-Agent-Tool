import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import express from "express";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearPlanHistory, getPlanHistory, publishPlanStepEvent } from "./plan/events.js";

vi.mock("./providers/ProviderRegistry.js", () => {
  return {
    routeChat: vi.fn().mockResolvedValue({ output: "hello", usage: { promptTokens: 5, completionTokens: 3 } })
  };
});

const policyMock = {
  enforceHttpAction: vi.fn().mockResolvedValue({ allow: true, deny: [] })
};

vi.mock("./policy/PolicyEnforcer.js", () => {
  return {
    getPolicyEnforcer: () => policyMock,
    PolicyViolationError: class extends Error {}
  };
});

vi.mock("./queue/PlanQueueRuntime.js", () => {
  return {
    initializePlanQueueRuntime: vi.fn().mockResolvedValue(undefined),
    submitPlanSteps: vi.fn().mockResolvedValue(undefined),
    resolvePlanStepApproval: vi.fn().mockResolvedValue(undefined)
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
    expect(invalidResponse.body.error).toContain("messages");
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
