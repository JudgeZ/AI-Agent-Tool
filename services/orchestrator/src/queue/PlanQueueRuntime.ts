import { planQueueManager } from "./PlanQueueManager.js";

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
