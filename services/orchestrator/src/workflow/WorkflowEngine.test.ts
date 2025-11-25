import { describe, expect, it } from "vitest";

import type { Plan } from "../plan/planner.js";
import { workflowEngine } from "./WorkflowEngine.js";

describe("WorkflowEngine", () => {
  it("creates workflows from plans with sequential nodes", () => {
    const plan: Plan = {
      id: "plan-test",
      goal: "demo",
      successCriteria: [],
      steps: [
        {
          id: "s1",
          action: "first",
          tool: "t1",
          capability: "repo.read",
          capabilityLabel: "Read",
          labels: [],
          timeoutSeconds: 30,
          approvalRequired: false,
        },
        {
          id: "s2",
          action: "review",
          tool: "t2",
          capability: "repo.write",
          capabilityLabel: "Write",
          labels: [],
          timeoutSeconds: 30,
          approvalRequired: true,
        },
      ],
    };

    const workflow = workflowEngine.createWorkflowFromPlan(plan, {
      tenantId: "tenant-a",
      projectId: "proj-1",
    });

    expect(workflow.planId).toBe(plan.id);
    expect(workflow.nodes).toHaveLength(2);
    expect(workflow.nodes[0].next).toEqual(["s2"]);
    expect(workflow.nodes[1].type).toBe("ApprovalStep");
    expect(workflowEngine.listWorkflows({ tenantId: "tenant-a" })).toContainEqual(workflow);
  });
});
