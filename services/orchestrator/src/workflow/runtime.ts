import { planQueueManager } from "../queue/PlanQueueManager.js";
import type { PlanSubject } from "../plan/planner.js";
import { getWorkflowEngine, resetWorkflowEngine, type Workflow } from "./WorkflowEngine.js";
import { getWorkflowRepository, resetWorkflowRepository, type WorkflowRepository } from "./WorkflowRepository.js";

export type WorkflowApprovalDecision = "approved" | "rejected";

export class WorkflowRuntime {
  constructor(
    private readonly engine = getWorkflowEngine(),
    private readonly repository: WorkflowRepository = getWorkflowRepository(),
  ) {}

  initialize(): Promise<void> {
    return planQueueManager.initialize();
  }

  async submitWorkflow(
    workflow: Workflow,
    traceId: string,
    requestId?: string,
    subject?: PlanSubject,
  ): Promise<void> {
    await this.initialize();
    const plan = workflow.plan ?? this.engine.toPlan(workflow);
    if (!plan) {
      throw new Error("workflow has no steps to submit");
    }
    const enrichedWorkflow = await this.engine.registerWorkflow({
      ...workflow,
      plan,
      subject: workflow.subject ?? subject,
    });
    await this.repository.rememberPlanMapping({
      workflowId: enrichedWorkflow.id,
      planId: plan.id,
      tenantId: enrichedWorkflow.tenantId,
    });
    await planQueueManager.submitPlanSteps(plan, traceId, requestId, subject ?? enrichedWorkflow.subject);
  }

  async resolveWorkflowApproval(options: {
    workflowId: string;
    nodeId: string;
    decision: WorkflowApprovalDecision;
    summary?: string;
  }) {
    const planId = await this.resolvePlanId(options.workflowId);
    if (!planId) {
      throw new Error("unknown workflow");
    }
    return planQueueManager.resolvePlanStepApproval({
      planId,
      stepId: options.nodeId,
      decision: options.decision,
      summary: options.summary,
    });
  }

  async getWorkflowSubject(workflowId: string) {
    const planId = await this.resolvePlanId(workflowId);
    if (!planId) return undefined;
    return planQueueManager.getPlanSubject(planId);
  }

  async getWorkflowNode(workflowId: string, nodeId: string) {
    const planId = await this.resolvePlanId(workflowId);
    if (!planId) return undefined;
    return planQueueManager.getPersistedPlanStep(planId, nodeId);
  }

  stop(): void {
    planQueueManager.stop();
  }

  reset(): void {
    resetWorkflowRepository();
    planQueueManager.reset();
  }

  async hasPendingWorkflowNode(workflowId: string, nodeId: string): Promise<boolean> {
    const planId = await this.resolvePlanId(workflowId);
    if (!planId) return false;
    return planQueueManager.hasPendingPlanStep(planId, nodeId);
  }

  private async resolvePlanId(workflow: Workflow | string): Promise<string | undefined> {
    if (typeof workflow !== "string") {
      if (workflow.plan?.id) {
        await this.repository.rememberPlanMapping({
          workflowId: workflow.id,
          planId: workflow.plan.id,
          tenantId: workflow.tenantId,
        });
        return workflow.plan.id;
      }
      return this.repository.getPlanId(workflow.id);
    }
    const planId = await this.repository.getPlanId(workflow);
    if (planId) {
      return planId;
    }
    const workflowId = await this.repository.getWorkflowIdForPlan(workflow);
    return workflowId ? workflow : undefined;
  }
}

let runtimeInstance: WorkflowRuntime | null = null;

export function getWorkflowRuntime(): WorkflowRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new WorkflowRuntime();
  }
  return runtimeInstance;
}

export function initializeWorkflowRuntime(): Promise<void> {
  return getWorkflowRuntime().initialize();
}

export async function submitWorkflow(
  workflow: Workflow,
  traceId: string,
  requestId?: string,
  subject?: PlanSubject,
): Promise<void> {
  return getWorkflowRuntime().submitWorkflow(workflow, traceId, requestId, subject);
}

export const resolveWorkflowApproval = (options: {
  workflowId: string;
  nodeId: string;
  decision: WorkflowApprovalDecision;
  summary?: string;
}) => getWorkflowRuntime().resolveWorkflowApproval(options);

export const getWorkflowSubject = (workflowId: string) => getWorkflowRuntime().getWorkflowSubject(workflowId);

export const getWorkflowNode = (workflowId: string, nodeId: string) => getWorkflowRuntime().getWorkflowNode(workflowId, nodeId);

export const stopWorkflowRuntime = () => getWorkflowRuntime().stop();

export const resetWorkflowRuntime = () => {
  runtimeInstance?.reset();
  resetWorkflowEngine();
  runtimeInstance = null;
};

export const hasPendingWorkflowNode = (workflowId: string, nodeId: string) =>
  getWorkflowRuntime().hasPendingWorkflowNode(workflowId, nodeId);
