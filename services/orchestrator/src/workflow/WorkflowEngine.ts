import { randomUUID } from "node:crypto";

import type { Plan, PlanStep, PlanSubject } from "../plan/planner.js";

export type WorkflowNodeType = "AgentStep" | "CodeStep" | "ApprovalStep" | "TriggerStep";

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  name: string;
  planStepId?: string;
  capability?: string;
  requiresApproval?: boolean;
  metadata?: Record<string, unknown>;
};

export type Workflow = {
  id: string;
  name: string;
  tenantId?: string;
  projectId?: string;
  nodes: WorkflowNode[];
  plan?: Plan;
  subject?: PlanSubject;
  createdAt: string;
  updatedAt: string;
};

function nodeTypeFromPlanStep(step: PlanStep): WorkflowNodeType {
  if (step.approvalRequired) {
    return "ApprovalStep";
  }
  if (step.labels?.includes("automation")) {
    return "AgentStep";
  }
  return "CodeStep";
}

export class WorkflowEngine {
  private readonly workflows = new Map<string, Workflow>();

  registerWorkflow(workflow: Workflow): Workflow {
    const existing = this.workflows.get(workflow.id);
    const now = new Date().toISOString();
    const merged: Workflow = {
      ...workflow,
      createdAt: existing?.createdAt ?? workflow.createdAt ?? now,
      updatedAt: now,
    };
    this.workflows.set(merged.id, merged);
    return merged;
  }

  createWorkflowFromPlan(plan: Plan, context?: { tenantId?: string; projectId?: string; subject?: PlanSubject }): Workflow {
    const id = `wf-${randomUUID()}`;
    const nodes: WorkflowNode[] = plan.steps.map((step) => ({
      id: `wf-${step.id}`,
      name: step.action,
      type: nodeTypeFromPlanStep(step),
      planStepId: step.id,
      capability: step.capability,
      requiresApproval: step.approvalRequired,
      metadata: { tool: step.tool, labels: step.labels },
    }));

    const now = new Date().toISOString();
    const workflow: Workflow = {
      id,
      name: plan.goal,
      tenantId: context?.tenantId,
      projectId: context?.projectId,
      plan,
      nodes,
      subject: context?.subject,
      createdAt: now,
      updatedAt: now,
    };

    return this.registerWorkflow(workflow);
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  listWorkflows(filter?: { tenantId?: string; projectId?: string }): Workflow[] {
    return Array.from(this.workflows.values()).filter((workflow) => {
      if (filter?.tenantId && workflow.tenantId && workflow.tenantId !== filter.tenantId) {
        return false;
      }
      if (filter?.projectId && workflow.projectId && workflow.projectId !== filter.projectId) {
        return false;
      }
      return true;
    });
  }

  toPlan(workflow: Workflow): Plan | undefined {
    if (workflow.plan) {
      return workflow.plan;
    }
    if (!workflow.nodes || workflow.nodes.length === 0) {
      return undefined;
    }
    const steps: PlanStep[] = workflow.nodes.map((node, index) => ({
      id: node.planStepId ?? `wf-step-${index + 1}`,
      action: node.name,
      tool: node.metadata?.tool ? String(node.metadata.tool) : "workflow_step",
      capability: node.capability ?? "workflow.run",
      capabilityLabel: node.capability ?? "workflow.run",
      labels: Array.isArray(node.metadata?.labels) ? (node.metadata?.labels as string[]) : ["workflow"],
      timeoutSeconds: 300,
      approvalRequired: node.requiresApproval ?? node.type === "ApprovalStep",
      input: {},
    }));
    const plan: Plan = {
      id: `plan-${randomUUID()}`,
      goal: workflow.name,
      steps,
      successCriteria: ["workflow completed"],
    };
    return plan;
  }
}

let workflowEngineInstance: WorkflowEngine | null = null;

export function getWorkflowEngine(): WorkflowEngine {
  if (!workflowEngineInstance) {
    workflowEngineInstance = new WorkflowEngine();
  }
  return workflowEngineInstance;
}

export function resetWorkflowEngine(): void {
  workflowEngineInstance = null;
}
