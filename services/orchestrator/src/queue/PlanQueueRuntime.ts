import { planQueueManager } from "./PlanQueueManager.js";
import type { Plan } from "../plan/planner.js";
import { workflowEngine, type Workflow } from "../workflow/WorkflowEngine.js";

// Re-export types
export type ApprovalDecision = "approved" | "rejected";

// Proxy functions
export const initializePlanQueueRuntime = () => planQueueManager.initialize();

export const submitPlanSteps = (
  plan: any,
  traceId: string,
  requestId?: string,
  subject?: any
) => planQueueManager.submitPlanSteps(plan, traceId, requestId, subject);

export const registerWorkflowForPlan = (
  plan: Plan,
  options: { tenantId?: string; projectId?: string; caseId?: string; traceId?: string; requestId?: string; subject?: any } = {}
): Workflow => {
  const workflow = workflowEngine.createWorkflowFromPlan(plan, options);
  workflowEngine.setStatus(workflow.id, "running");
  return workflow;
};

export const listWorkflows = (query?: { tenantId?: string; projectId?: string }): Workflow[] =>
  workflowEngine.listWorkflows(query);

export const getWorkflow = (workflowId: string): Workflow | undefined => workflowEngine.getWorkflow(workflowId);

export const resolvePlanStepApproval = (options: {
  planId: string;
  stepId: string;
  decision: ApprovalDecision;
  summary?: string;
}) => planQueueManager.resolvePlanStepApproval(options);

export const getPlanSubject = (planId: string) => planQueueManager.getPlanSubject(planId);

export const getPersistedPlanStep = (planId: string, stepId: string) => 
    planQueueManager.getPersistedPlanStep(planId, stepId);

export const stopPlanQueueRuntime = () => planQueueManager.stop();

export const resetPlanQueueRuntime = () => planQueueManager.reset();

export const hasPendingPlanStep = (planId: string, stepId: string) => 
    planQueueManager.hasPendingPlanStep(planId, stepId);

export const hasApprovalCacheEntry = (planId: string, stepId: string) => 
    planQueueManager.hasApprovalCacheEntry(planId, stepId);

export const hasActivePlanSubject = (planId: string) => 
    planQueueManager.hasActivePlanSubject(planId);


// Export legacy stuff if needed?
export { PLAN_STEPS_QUEUE } from "./StepConsumer.js";
export { PLAN_COMPLETIONS_QUEUE } from "./CompletionConsumer.js";
export type { PlanStepCompletionPayload, PlanStepTaskPayload } from "./types.js";
