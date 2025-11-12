import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => {
  return {
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  };
});

import { logAuditEvent } from "./audit.js";
import auditLogger from "./logger.js";
import { runWithContext } from "./requestContext.js";

describe("logAuditEvent", () => {
  const logger = auditLogger as unknown as {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  it("emits hashed identifiers and sanitised details", () => {
    runWithContext(
      {
        requestId: "req-123",
        traceId: "trace-abc"
      },
      () => {
        logAuditEvent({
          action: "access-control",
          outcome: "success",
          resource: "resource-1",
          details: {
            allowed: true,
            apiKey: "secret-key",
            nested: {
              refresh_token: "very-secret"
            }
          },
          subject: {
            sessionId: "session-1",
            userId: "user-1",
            email: "user@example.com",
            roles: ["admin"]
          }
        });
      }
    );

    expect(logger.info).toHaveBeenCalledTimes(1);
    const payload = logger.info.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      ts: "2024-01-01T00:00:00.000Z",
      level: "info",
      service: "orchestrator",
      event: "access-control",
      outcome: "success",
      target: "resource-1",
      request_id: "req-123",
      trace_id: "trace-abc",
      redacted_details: {
        allowed: true,
        apiKey: "[redacted]",
        nested: {
          refresh_token: "[redacted]"
        }
      }
    });

    expect(typeof payload.actor_id).toBe("string");
    expect((payload.actor_id as string).length).toBe(64);
    expect(payload.actor_id).not.toContain("session-1");

    const subject = payload.subject as Record<string, unknown>;
    expect(subject.session_id).toBeTypeOf("string");
    expect(subject.session_id).not.toBe("session-1");
    expect(subject.roles).toEqual(["admin"]);
  });

  it("falls back to warning/error levels based on outcome", () => {
    logAuditEvent({
      action: "plan.approval",
      outcome: "denied",
      details: {
        capability: "plan.approve"
      }
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnPayload = logger.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(warnPayload.capability).toBe("plan.approve");

    logAuditEvent({
      action: "plan.execution",
      outcome: "failure",
      error: "timeout"
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const errorPayload = logger.error.mock.calls[0][0] as Record<string, unknown>;
    expect(errorPayload.error).toBe("timeout");
  });

  it("reports logger failures without throwing", () => {
    logger.info.mockImplementationOnce(() => {
      throw new Error("write failed");
    });

    expect(() =>
      logAuditEvent({
        action: "plan.execute",
        outcome: "success",
      }),
    ).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "audit.log_failure",
    );
  });

  it("hashes anonymous actor when no identifiers are present", () => {
    logAuditEvent({
      action: "plan.execute",
      outcome: "success",
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const payload = logger.info.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.actor_id).toBeTypeOf("string");
    expect((payload.actor_id as string).length).toBe(64);
  });
});
