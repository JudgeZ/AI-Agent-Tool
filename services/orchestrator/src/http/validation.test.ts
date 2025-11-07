import { describe, expect, it } from "vitest";
import {
  ChatRequestSchema,
  PlanApprovalSchema,
  PlanIdSchema,
  PlanRequestSchema,
  formatValidationIssues
} from "./validation.js";

describe("PlanIdSchema", () => {
  it.each([
    { value: "plan-deadbeef", valid: true },
    { value: "plan-12345678", valid: true },
    { value: "plan-xyz", valid: false, message: "plan id is invalid" },
    { value: "wrong-12345678", valid: false, message: "plan id is invalid" }
  ])("validates plan id $value", ({ value, valid, message }) => {
    const result = PlanIdSchema.safeParse(value);
    if (valid) {
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(value);
      }
    } else {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(message);
      }
    }
  });
});

describe("PlanRequestSchema", () => {
  it.each([
    {
      name: "trims and returns goal",
      input: { goal: "  launch feature  " },
      expected: { goal: "launch feature" }
    }
  ])("parses valid payload: $name", ({ input, expected }) => {
    expect(PlanRequestSchema.parse(input)).toEqual(expected);
  });

  it.each([
    {
      name: "missing goal",
      input: { goal: "" },
      message: "goal is required"
    },
    {
      name: "exceeds max length",
      input: { goal: "x".repeat(2049) },
      message: "goal must not exceed 2048 characters"
    }
  ])("rejects invalid payloads: $name", ({ input, message }) => {
    const result = PlanRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(message);
    }
  });
});

describe("PlanApprovalSchema", () => {
  it.each([
    {
      name: "defaults to approved when decision omitted",
      input: {},
      expected: { decision: "approved", rationale: undefined }
    },
    {
      name: "maps reject decision and trims rationale",
      input: { decision: "reject", rationale: "  needs changes  " },
      expected: { decision: "rejected", rationale: "needs changes" }
    },
    {
      name: "omits empty rationale",
      input: { decision: "approve", rationale: "   " },
      expected: { decision: "approved", rationale: undefined }
    }
  ])("transforms approval payloads: $name", ({ input, expected }) => {
    expect(PlanApprovalSchema.parse(input)).toEqual(expected);
  });

  it("rejects invalid decisions", () => {
    const result = PlanApprovalSchema.safeParse({ decision: "hold" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Expected");
    }
  });

  it("rejects rationale that exceeds the limit", () => {
    const result = PlanApprovalSchema.safeParse({ rationale: "x".repeat(2001) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("rationale must not exceed 2000 characters");
    }
  });
});

describe("ChatRequestSchema", () => {
  it.each([
    {
      name: "trims model and message content",
      input: {
        model: "  gpt-test  ",
        messages: [{ role: "user", content: "  hello  " }]
      },
      expected: {
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }]
      }
    },
    {
      name: "omits empty model",
      input: {
        model: "   ",
        messages: [{ role: "assistant", content: "ack" }]
      },
      expected: {
        model: undefined,
        messages: [{ role: "assistant", content: "ack" }]
      }
    }
  ])("parses valid chat payloads: $name", ({ input, expected }) => {
    expect(ChatRequestSchema.parse(input)).toEqual(expected);
  });

  it.each([
    {
      name: "missing messages",
      input: { messages: [] },
      message: "messages must contain at least one entry"
    },
    {
      name: "too many messages",
      input: { messages: Array.from({ length: 51 }, () => ({ role: "user", content: "hi" })) },
      message: "messages must not exceed 50 entries"
    },
    {
      name: "invalid role",
      input: { messages: [{ role: "tool", content: "hi" }] },
      message: "role must be system, user, or assistant"
    },
    {
      name: "empty content",
      input: { messages: [{ role: "user", content: "   " }] },
      message: "content is required"
    }
  ])("rejects invalid chat payloads: $name", ({ input, message }) => {
    const result = ChatRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(message);
    }
  });
});

describe("formatValidationIssues", () => {
  it("returns simplified issue structures", () => {
    const issues = [
      { path: ["messages", 0, "role"], message: "role is invalid" },
      { path: ["goal"], message: "goal is required" }
    ] as const;

    expect(formatValidationIssues(issues as any)).toEqual([
      { path: "messages.0.role", message: "role is invalid" },
      { path: "goal", message: "goal is required" }
    ]);
  });
});
