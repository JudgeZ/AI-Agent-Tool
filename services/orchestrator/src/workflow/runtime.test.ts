import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowEngine, resetWorkflowEngine, type Workflow } from "./WorkflowEngine.js";
import { WorkflowRepository, resetWorkflowRepository } from "./WorkflowRepository.js";
import {
  WorkflowRuntime,
  resetWorkflowRuntime,
  type WorkflowApprovalDecision,
} from "./runtime.js";

vi.mock("../queue/PlanQueueManager.js", () => ({
  planQueueManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    submitPlanSteps: vi.fn().mockResolvedValue(undefined),
    resolvePlanStepApproval: vi.fn().mockResolvedValue(undefined),
    getPlanSubject: vi.fn(),
    getPersistedPlanStep: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    hasPendingPlanStep: vi.fn(),
  },
}));

import { planQueueManager } from "../queue/PlanQueueManager.js";
const mockedPlanQueueManager = planQueueManager as vi.Mocked<typeof planQueueManager>;

const baseWorkflow: Workflow = {
  id: "wf-123",
  name: "Test Workflow",
  tenantId: "tenant-1",
  nodes: [],
  plan: {
    id: "plan-abc",
    goal: "Test",
    steps: [],
    successCriteria: ["done"],
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function createRuntime() {
  const repository = new WorkflowRepository(null);
  const engine = new WorkflowEngine(repository);
  return { runtime: new WorkflowRuntime(engine, repository), repository };
}

describe("WorkflowRuntime", () => {
  beforeEach(() => {
    resetWorkflowRuntime();
    resetWorkflowEngine();
    resetWorkflowRepository();
    vi.clearAllMocks();
  });

  it("persists workflow-plan mapping and submits steps", async () => {
    const { runtime, repository } = createRuntime();

    await runtime.submitWorkflow({ ...baseWorkflow }, "trace-1", "req-1");

    expect(mockedPlanQueueManager.initialize).toHaveBeenCalled();
    expect(mockedPlanQueueManager.submitPlanSteps).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plan-abc" }),
      "trace-1",
      "req-1",
      undefined,
    );
    await expect(repository.getPlanId(baseWorkflow.id)).resolves.toBe("plan-abc");
  });

  it("routes approval resolution through persisted mapping", async () => {
    const { runtime } = createRuntime();
    await runtime.submitWorkflow({ ...baseWorkflow }, "trace-2");

    const decision: WorkflowApprovalDecision = "approved";
    await runtime.resolveWorkflowApproval({ workflowId: baseWorkflow.id, nodeId: "n1", decision });

    expect(mockedPlanQueueManager.resolvePlanStepApproval).toHaveBeenCalledWith({
      planId: "plan-abc",
      stepId: "n1",
      decision,
      summary: undefined,
    });
  });

  it("returns false for pending node lookups without mappings", async () => {
    const { runtime } = createRuntime();

    await expect(runtime.hasPendingWorkflowNode("unknown", "n1")).resolves.toBe(false);
    expect(mockedPlanQueueManager.hasPendingPlanStep).not.toHaveBeenCalled();
  });

  it("reads workflow subject through mapping", async () => {
    mockedPlanQueueManager.getPlanSubject.mockReturnValue({ tenantId: "tenant-1" });
    const { runtime } = createRuntime();
    await runtime.submitWorkflow({ ...baseWorkflow }, "trace-3");

    await expect(runtime.getWorkflowSubject(baseWorkflow.id)).resolves.toEqual({ tenantId: "tenant-1" });
  });
});
