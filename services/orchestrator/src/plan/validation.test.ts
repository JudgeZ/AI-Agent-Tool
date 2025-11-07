import { describe, expect, it } from "vitest";

import {
  parsePlan,
  parsePlanStepEvent,
  parseToolEvent,
  parseToolInvocation
} from "./validation.js";

describe("plan validation schemas", () => {
  it("validates a minimal plan", () => {
    const plan = parsePlan({
      id: "plan-550e8400-e29b-41d4-a716-446655440000",
      goal: "Test",
      successCriteria: ["Pass"],
      steps: [
        {
          id: "s1",
          action: "index_repo",
          tool: "repo_indexer",
          capability: "repo.read",
          capabilityLabel: "Read repository",
          labels: [],
          timeoutSeconds: 60,
          approvalRequired: false,
          input: {},
          metadata: {}
        }
      ]
    });
    expect(plan.steps[0]?.action).toBe("index_repo");
  });

  it("rejects invalid step events", () => {
    expect(() =>
      parsePlanStepEvent({
        event: "plan.step",
        traceId: "trace",
        planId: "plan-550e8400-e29b-41d4-a716-446655440000",
        step: {
          id: "s1",
          state: "running",
          capability: "repo.read",
          capabilityLabel: "Read repository",
          tool: "repo_indexer",
          labels: [],
          timeoutSeconds: 60,
          approvalRequired: false
        }
      })
    ).toThrow();
  });

  it("parses tool invocation and events", () => {
    const invocation = parseToolInvocation({
      invocationId: "inv-1",
      planId: "plan-550e8400-e29b-41d4-a716-446655440000",
      stepId: "s1",
      tool: "repo_indexer",
      capability: "repo.read",
      capabilityLabel: "Read repository",
      labels: [],
      timeoutSeconds: 10,
      approvalRequired: false,
      input: { goal: "test" },
      metadata: { actor: "qa" }
    });
    expect(invocation.metadata.actor).toBe("qa");

    const event = parseToolEvent({
      invocationId: invocation.invocationId,
      planId: invocation.planId,
      stepId: invocation.stepId,
      state: "completed",
      summary: "done",
      output: { ok: true }
    });
    expect(event.state).toBe("completed");
  });
});
