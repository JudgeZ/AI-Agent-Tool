import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ChatRequestSchema,
  PlanApprovalSchema,
  PlanIdSchema,
  PlanRequestSchema,
  SessionIdSchema,
  StepIdSchema,
  formatValidationIssues,
} from "./validation.js";

describe("PlanIdSchema", () => {
  it.each([
    {
      name: "accepts canonical id",
      value: "plan-12345678-1234-1234-1234-1234567890ab",
    },
    {
      name: "accepts legacy short id",
      value: "plan-deadbeef",
    },
    {
      name: "trims extraneous whitespace",
      value: "  plan-12345678-1234-1234-1234-1234567890ab  ",
    },
  ])("parses valid plan ids: $name", ({ value }) => {
    expect(PlanIdSchema.parse(value)).toBe(value.trim());
  });

  it.each([
    { name: "invalid prefix", value: "wrong-12345678-1234-1234-1234-1234567890ab" },
    { name: "truncated uuid", value: "plan-12345678-1234" },
    { name: "too short for legacy", value: "plan-dead" },
    { name: "non hex characters", value: "plan-zzzzzzzz-1234-1234-1234-1234567890ab" },
  ])("rejects invalid plan ids: $name", ({ value }) => {
    const result = PlanIdSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("plan id is invalid");
    }
  });
});

describe("SessionIdSchema", () => {
  it("accepts valid uuids", () => {
    const value = "123e4567-e89b-12d3-a456-426614174000";
    expect(SessionIdSchema.parse(value)).toBe(value);
  });

  it.each([
    { name: "blank", value: "" },
    { name: "too long", value: `${"a".repeat(65)}` },
    { name: "invalid format", value: "not-a-uuid" },
  ])("rejects invalid session ids: $name", ({ value }) => {
    const result = SessionIdSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/session id/i);
    }
  });
});

describe("StepIdSchema", () => {
  it("allows alphanumeric ids", () => {
    expect(StepIdSchema.parse("step-01")).toBe("step-01");
  });

  it("trims whitespace before validating", () => {
    expect(StepIdSchema.parse("  STEP_1  ")).toBe("STEP_1");
  });

  it.each([
    { name: "contains spaces", value: "step one" },
    { name: "contains invalid symbols", value: "step$1" },
    { name: "too long", value: "s".repeat(65) },
  ])("rejects invalid step ids: $name", ({ value }) => {
    const result = StepIdSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("step id is invalid");
    }
  });
});

describe("PlanRequestSchema", () => {
  it("trims whitespace from the goal", () => {
    expect(PlanRequestSchema.parse({ goal: "  launch feature  " })).toEqual({
      goal: "launch feature",
    });
  });

  it.each([
    { name: "missing goal", goal: "", message: "goal is required" },
    {
      name: "too long",
      goal: "x".repeat(2049),
      message: "goal must not exceed 2048 characters",
    },
  ])("rejects invalid plan requests: $name", ({ goal, message }) => {
    const result = PlanRequestSchema.safeParse({ goal });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(message);
    }
  });
});

describe("PlanApprovalSchema", () => {
  it("defaults decision to approved when omitted", () => {
    expect(PlanApprovalSchema.parse({})).toEqual({
      decision: "approved",
      rationale: undefined,
    });
  });

  it("maps reject to rejected and trims rationale", () => {
    expect(
      PlanApprovalSchema.parse({ decision: "reject", rationale: "  needs changes  " }),
    ).toEqual({
      decision: "rejected",
      rationale: "needs changes",
    });
  });

  it("omits empty rationale after trimming", () => {
    expect(
      PlanApprovalSchema.parse({ decision: "approve", rationale: "   " }),
    ).toEqual({ decision: "approved", rationale: undefined });
  });

  it("rejects invalid decisions", () => {
    const result = PlanApprovalSchema.safeParse({ decision: "hold" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Expected 'approve' | 'reject'");
    }
  });

  it("rejects rationale that exceeds the limit", () => {
    const result = PlanApprovalSchema.safeParse({ rationale: "x".repeat(2001) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        "rationale must not exceed 2000 characters",
      );
    }
  });
});

describe("ChatRequestSchema", () => {
  it("trims model and message content", () => {
    expect(
      ChatRequestSchema.parse({
        model: "  gpt-test  ",
        messages: [{ role: "user", content: "  hello  " }],
      }),
    ).toEqual({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("omits model when blank after trimming", () => {
    expect(
      ChatRequestSchema.parse({
        model: "   ",
        messages: [{ role: "assistant", content: "ack" }],
      }),
    ).toEqual({
      model: undefined,
      messages: [{ role: "assistant", content: "ack" }],
    });
  });

  it("maps routing default alias to balanced", () => {
    expect(
      ChatRequestSchema.parse({
        routing: "default",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toEqual({
      routing: "balanced",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it.each([
    { label: "lower bound", temperature: 0 },
    { label: "upper bound", temperature: 2 },
  ])("accepts the $label temperature", ({ temperature }) => {
    expect(
      ChatRequestSchema.parse({
        temperature,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toEqual({
      temperature,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it.each([
    {
      name: "missing messages",
      payload: { messages: [] },
      message: "messages must contain at least one entry",
    },
    {
      name: "too many messages",
      payload: {
        messages: Array.from({ length: 51 }, () => ({ role: "user", content: "hi" })),
      },
      message: "messages must not exceed 50 entries",
    },
    {
      name: "invalid role",
      payload: { messages: [{ role: "tool", content: "hi" }] },
      message: "role must be system, user, or assistant",
    },
    {
      name: "empty content",
      payload: { messages: [{ role: "user", content: "   " }] },
      message: "content is required",
    },
    {
      name: "model too long",
      payload: {
        model: "x".repeat(257),
        messages: [{ role: "user", content: "hi" }],
      },
      message: "model must not exceed 256 characters",
    },
    {
      name: "message too long",
      payload: {
        messages: [{ role: "assistant", content: "x".repeat(16001) }],
      },
      message: "content must not exceed 16000 characters",
    },
  ])("rejects invalid chat payloads: $name", ({ payload, message }) => {
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(message);
    }
  });
});

describe("formatValidationIssues", () => {
  it("flattens nested issue paths", () => {
    const issues: z.ZodIssue[] = [
      {
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        inclusive: true,
        type: "string",
        message: "content is required",
        path: ["messages", 0, "content"],
      },
      {
        code: z.ZodIssueCode.invalid_type,
        expected: "string",
        received: "undefined",
        message: "goal is required",
        path: ["goal"],
      },
    ];

    expect(formatValidationIssues(issues)).toEqual([
      { path: "messages.0.content", message: "content is required" },
      { path: "goal", message: "goal is required" },
    ]);
  });
});
