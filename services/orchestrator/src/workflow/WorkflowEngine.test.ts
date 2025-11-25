import { describe, expect, it, beforeEach } from "vitest";

import { getWorkflowEngine, resetWorkflowEngine } from "./WorkflowEngine.js";
import type { Plan } from "../plan/planner.js";

const plan: Plan = {
  id: "plan-123",
  goal: "Build feature",
  steps: [
    {
      id: "s1",
      action: "design",
      tool: "design_agent",
      capability: "design",
      capabilityLabel: "Design",
      labels: ["automation"],
      timeoutSeconds: 120,
      approvalRequired: false,
      input: {},
    },
    {
      id: "s2",
      action: "review",
      tool: "code_reviewer",
      capability: "review",
      capabilityLabel: "Review",
      labels: ["approval"],
      timeoutSeconds: 120,
      approvalRequired: true,
      input: {},
    },
  ],
  successCriteria: ["done"],
};

describe("WorkflowEngine", () => {
  beforeEach(() => {
    resetWorkflowEngine();
  });

  it("creates workflows from plans and preserves plan link", async () => {
    const engine = getWorkflowEngine();
    const workflow = await engine.createWorkflowFromPlan(plan, { tenantId: "tenant-1", projectId: "proj" });

    expect(workflow.plan?.id).toBe(plan.id);
    expect(workflow.nodes).toHaveLength(plan.steps.length);
    expect(workflow.nodes[0].type).toBe("AgentStep");
    expect(workflow.nodes[1].type).toBe("ApprovalStep");
  });

  it("rebuilds a plan from workflow nodes when missing", async () => {
    const engine = getWorkflowEngine();
    const workflow = await engine.createWorkflowFromPlan(plan);
    const rebuilt = engine.toPlan({ ...workflow, plan: undefined });

    expect(rebuilt).toBeDefined();
    expect(rebuilt?.steps).toHaveLength(plan.steps.length);
  });
});
