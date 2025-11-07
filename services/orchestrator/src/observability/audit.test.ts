import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { logAuditEvent } from "./audit";

describe("logAuditEvent", () => {
  let logSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("omits undefined fields and serializes subjects", () => {
    logAuditEvent({
      action: "access-control",
      outcome: "success",
      resource: "resource-1",
      traceId: "trace-123",
      agent: "policy",
      subject: {
        sessionId: "session-1",
        userId: "user-1",
        tenantId: undefined,
        email: "user@example.com",
        name: null,
        roles: ["admin", "user"],
        scopes: []
      },
      details: {
        allowed: true,
        skipped: undefined
      }
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0][0]));

    expect(payload).toMatchObject({
      level: "audit",
      timestamp: "2024-01-01T00:00:00.000Z",
      service: "orchestrator",
      action: "access-control",
      outcome: "success",
      resource: "resource-1",
      trace_id: "trace-123",
      agent: "policy",
      subject: {
        session_id: "session-1",
        user_id: "user-1",
        email: "user@example.com",
        roles: ["admin", "user"]
      },
      details: {
        allowed: true
      }
    });

    expect(payload).not.toHaveProperty("request_id");
    expect(payload.subject).not.toHaveProperty("tenant_id");
    expect(payload.subject).not.toHaveProperty("scopes");
    expect(payload.subject).not.toHaveProperty("name");
  });

  it("swallows serialization failures", () => {
    const stringifySpy = vi
      .spyOn(JSON, "stringify")
      .mockImplementation(() => {
        throw new Error("boom");
      });

    expect(() =>
      logAuditEvent({
        action: "broken",
        outcome: "failure"
      })
    ).not.toThrow();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe("Failed to serialize audit event");
    expect(errorSpy.mock.calls[0][1]).toBeInstanceOf(Error);
    expect((errorSpy.mock.calls[0][1] as Error).message).toBe("boom");

    stringifySpy.mockRestore();
  });
});
