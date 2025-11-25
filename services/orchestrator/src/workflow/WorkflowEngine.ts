import { randomUUID } from "node:crypto";

import type { Plan, PlanSubject } from "../plan/planner.js";

export type WorkflowNodeType = "AgentStep" | "CodeStep" | "ApprovalStep" | "TriggerStep";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  name: string;
  next?: string[];
  approvalRequired?: boolean;
  inputs?: Record<string, unknown>;
}

export type WorkflowStatus = "pending" | "running" | "completed" | "failed";

export interface Workflow {
  id: string;
  planId?: string;
  tenantId?: string;
  projectId?: string;
  caseId?: string;
  nodes: WorkflowNode[];
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
  traceId?: string;
  requestId?: string;
  subject?: PlanSubject;
}

export interface WorkflowQuery {
  tenantId?: string;
  projectId?: string;
}

export class WorkflowEngine {
  private readonly workflows = new Map<string, Workflow>();

  createWorkflowFromPlan(
    plan: Plan,
    options: { tenantId?: string; projectId?: string; caseId?: string; traceId?: string; requestId?: string; subject?: PlanSubject } = {}
  ): Workflow {
    const now = new Date().toISOString();
    const nodes: WorkflowNode[] = plan.steps.map((step, index, all) => {
      const next = index < all.length - 1 ? [all[index + 1].id] : undefined;
      return {
        id: step.id,
        name: step.action,
        type: step.approvalRequired ? "ApprovalStep" : "CodeStep",
        next,
        approvalRequired: step.approvalRequired,
        inputs: {
          tool: step.tool,
          capability: step.capability,
          labels: step.labels,
          timeoutSeconds: step.timeoutSeconds,
        },
      };
    });

    const workflow: Workflow = {
      id: `wf-${randomUUID()}`,
      planId: plan.id,
      tenantId: options.tenantId,
      projectId: options.projectId,
      caseId: options.caseId,
      nodes,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      traceId: options.traceId,
      requestId: options.requestId,
      subject: options.subject,
    };

    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  setStatus(workflowId: string, status: WorkflowStatus): void {
    const record = this.workflows.get(workflowId);
    if (!record) {
      return;
    }
    record.status = status;
    record.updatedAt = new Date().toISOString();
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  listWorkflows(query: WorkflowQuery = {}): Workflow[] {
    return Array.from(this.workflows.values()).filter((workflow) => {
      if (query.tenantId && workflow.tenantId !== query.tenantId) {
        return false;
      }
      if (query.projectId && workflow.projectId !== query.projectId) {
        return false;
      }
      return true;
    });
  }
}

export const workflowEngine = new WorkflowEngine();
