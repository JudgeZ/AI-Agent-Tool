import { randomUUID } from "node:crypto";

import type { Plan, PlanStep, PlanSubject } from "../plan/planner.js";
import { getWorkflowRepository, resetWorkflowRepository, type WorkflowRepository } from "./WorkflowRepository.js";

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
  constructor(private readonly repository: WorkflowRepository = getWorkflowRepository()) {}

  async registerWorkflow(workflow: Workflow): Promise<Workflow> {
    const existing = await this.repository.get(workflow.id);
    const now = new Date().toISOString();
    const merged: Workflow = {
      ...workflow,
      createdAt: existing?.createdAt ?? workflow.createdAt ?? now,
      updatedAt: now,
    };
    return this.repository.save(merged);
  }

  async createWorkflowFromPlan(
    plan: Plan,
    context?: { tenantId?: string; projectId?: string; subject?: PlanSubject },
  ): Promise<Workflow> {
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

  async getWorkflow(id: string): Promise<Workflow | undefined> {
    return this.repository.get(id);
  }

  async listWorkflows(filter?: { tenantId?: string; projectId?: string }): Promise<Workflow[]> {
    return this.repository.list(filter);
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
  resetWorkflowRepository();
  workflowEngineInstance = null;
}
