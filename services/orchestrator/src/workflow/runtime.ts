import { planQueueManager } from "../queue/PlanQueueManager.js";
import type { PlanSubject } from "../plan/planner.js";
import { getWorkflowEngine, type Workflow } from "./WorkflowEngine.js";

export type WorkflowApprovalDecision = "approved" | "rejected";

const workflowPlanMap = new Map<string, string>();
const planWorkflowMap = new Map<string, string>();

function rememberWorkflowPlan(workflowId: string, planId: string): void {
  workflowPlanMap.set(workflowId, planId);
  planWorkflowMap.set(planId, workflowId);
}

function resolvePlanId(workflow: Workflow | string): string | undefined {
  if (typeof workflow !== "string") {
    if (workflow.plan?.id) {
      rememberWorkflowPlan(workflow.id, workflow.plan.id);
      return workflow.plan.id;
    }
    const existing = workflowPlanMap.get(workflow.id);
    if (existing) {
      return existing;
    }
    return undefined;
  }
  const planId = workflowPlanMap.get(workflow);
  if (planId) {
    return planId;
  }
  if (planWorkflowMap.has(workflow)) {
    return workflow;
  }
  return undefined;
}

function resolveWorkflowIdByPlan(planId: string): string | undefined {
  return planWorkflowMap.get(planId);
}

export const initializeWorkflowRuntime = () => planQueueManager.initialize();

export async function submitWorkflow(
  workflow: Workflow,
  traceId: string,
  requestId?: string,
  subject?: PlanSubject,
): Promise<void> {
  await initializeWorkflowRuntime();
  const engine = getWorkflowEngine();
  const plan = workflow.plan ?? engine.toPlan(workflow);
  if (!plan) {
    throw new Error("workflow has no steps to submit");
  }
  const enrichedWorkflow = engine.registerWorkflow({ ...workflow, plan, subject: workflow.subject ?? subject });
  rememberWorkflowPlan(enrichedWorkflow.id, plan.id);
  await planQueueManager.submitPlanSteps(plan, traceId, requestId, subject ?? enrichedWorkflow.subject);
}

export const resolveWorkflowApproval = (options: {
  workflowId: string;
  nodeId: string;
  decision: WorkflowApprovalDecision;
  summary?: string;
}) => {
  const planId = resolvePlanId(options.workflowId);
  if (!planId) {
    throw new Error("unknown workflow");
  }
  return planQueueManager.resolvePlanStepApproval({
    planId,
    stepId: options.nodeId,
    decision: options.decision,
    summary: options.summary,
  });
};

export const getWorkflowSubject = (workflowId: string) => {
  const planId = resolvePlanId(workflowId);
  if (!planId) return undefined;
  return planQueueManager.getPlanSubject(planId);
};

export const getWorkflowNode = (workflowId: string, nodeId: string) => {
  const planId = resolvePlanId(workflowId);
  if (!planId) return undefined;
  return planQueueManager.getPersistedPlanStep(planId, nodeId);
};

export const stopWorkflowRuntime = () => planQueueManager.stop();

export const resetWorkflowRuntime = () => {
  workflowPlanMap.clear();
  planWorkflowMap.clear();
  planQueueManager.reset();
};

export const hasPendingWorkflowNode = (workflowId: string, nodeId: string) => {
  const planId = resolvePlanId(workflowId);
  if (!planId) return false;
  return planQueueManager.hasPendingPlanStep(planId, nodeId);
};
