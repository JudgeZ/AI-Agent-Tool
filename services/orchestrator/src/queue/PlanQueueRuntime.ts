import { planQueueManager } from "./PlanQueueManager.js";
import { getWorkflowEngine } from "../workflow/WorkflowEngine.js";
import {
  initializeWorkflowRuntime,
  submitWorkflow,
  resolveWorkflowApproval,
  getWorkflowSubject as getWorkflowSubjectForWorkflow,
  getWorkflowNode,
  stopWorkflowRuntime,
  resetWorkflowRuntime,
  hasPendingWorkflowNode,
  type WorkflowApprovalDecision,
} from "../workflow/runtime.js";

// Re-export types
export type ApprovalDecision = WorkflowApprovalDecision;

// Proxy functions
export const initializePlanQueueRuntime = initializeWorkflowRuntime;

export const submitPlanSteps = (
  plan: any,
  traceId: string,
  requestId?: string,
  subject?: any,
) => {
  const workflow = getWorkflowEngine().createWorkflowFromPlan(plan, {
    tenantId: subject?.tenantId,
    projectId: subject?.projectId,
    subject,
  });
  return submitWorkflow(workflow, traceId, requestId, subject);
};

export const resolvePlanStepApproval = (options: {
  planId: string;
  stepId: string;
  decision: ApprovalDecision;
  summary?: string;
}) => resolveWorkflowApproval({
  workflowId: options.planId,
  nodeId: options.stepId,
  decision: options.decision,
  summary: options.summary,
});

export const getPlanSubject = (planId: string) => getWorkflowSubjectForWorkflow(planId);

export const getPersistedPlanStep = (planId: string, stepId: string) =>
  getWorkflowNode(planId, stepId);

export const stopPlanQueueRuntime = () => stopWorkflowRuntime();

export const resetPlanQueueRuntime = () => resetWorkflowRuntime();

export const hasPendingPlanStep = (planId: string, stepId: string) =>
  hasPendingWorkflowNode(planId, stepId);

export const hasApprovalCacheEntry = (planId: string, stepId: string) =>
  planQueueManager.hasApprovalCacheEntry(planId, stepId);

export const hasActivePlanSubject = (planId: string) =>
  planQueueManager.hasActivePlanSubject(planId);

// Export legacy stuff if needed?
export { PLAN_STEPS_QUEUE } from "./StepConsumer.js";
export { PLAN_COMPLETIONS_QUEUE } from "./CompletionConsumer.js";
export type { PlanStepCompletionPayload, PlanStepTaskPayload } from "./types.js";
