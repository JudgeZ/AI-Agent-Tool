import fs from "node:fs/promises";
import path from "node:path";

import { GatewayConfig, postJson, resolveGatewayConfig } from "../gateway";
import { printLine } from "../output";

export interface PlanStep {
  id: string;
  action: string;
  tool: string;
  capability: string;
  capabilityLabel: string;
  timeoutSeconds: number;
  approvalRequired: boolean;
  labels?: string[];
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  successCriteria?: string[];
}

async function requestPlan(goal: string, config: GatewayConfig): Promise<Plan> {
  try {
    return await postJson<Plan>("plan", { goal }, config);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to create plan: ${error.message}`);
    }
    throw new Error("Failed to create plan due to an unknown error");
  }
}

const PLAN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function ensureSafePlanId(planId: string | undefined): string {
  const trimmed = planId?.trim() ?? "";
  if (!PLAN_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Gateway returned invalid plan id "${planId ?? ""}". Plan ids must match ${PLAN_ID_PATTERN}.`,
    );
  }
  return trimmed;
}

async function persistPlanArtifacts(plan: Plan): Promise<void> {
  const safePlanId = ensureSafePlanId(plan.id);
  const plansRoot = path.join(process.cwd(), ".plans", safePlanId);
  await fs.mkdir(plansRoot, { recursive: true });
  const planJsonPath = path.join(plansRoot, "plan.json");
  const planMdPath = path.join(plansRoot, "plan.md");

  const markdownSteps = plan.steps
    .map((step) => {
      const labelsText = step.labels?.length
        ? ` labels: ${step.labels.join(", ")}`
        : "";
      const approvalText = step.approvalRequired ? "approval required" : "auto";
      return `- **${step.action}** (${step.capabilityLabel}) — tool: ${step.tool}, timeout: ${step.timeoutSeconds}s, approval: ${approvalText}${labelsText}`;
    })
    .join("\n");

  const markdown = `# Plan ${safePlanId}\n\nGoal: ${plan.goal}\n\nSteps:\n${markdownSteps}`;

  await Promise.all([
    fs.writeFile(planJsonPath, JSON.stringify(plan, null, 2), "utf8"),
    fs.writeFile(planMdPath, markdown, "utf8"),
  ]);
}

export async function createPlan(goal: string): Promise<Plan> {
  const config = resolveGatewayConfig();
  const plan = await requestPlan(goal, config);
  await persistPlanArtifacts(plan);
  return plan;
}

function formatSteps(plan: Plan): string[] {
  return plan.steps.map((step) => {
    const approvalText = step.approvalRequired ? "requires approval" : "auto";
    return `  • ${step.action} (${step.capabilityLabel}) [tool=${step.tool}, timeout=${step.timeoutSeconds}s, ${approvalText}]`;
  });
}

function formatSuccessCriteria(plan: Plan): string[] {
  return (plan.successCriteria ?? []).map((criteria) => `  - ${criteria}`);
}

export async function runPlan(goal: string): Promise<Plan> {
  const plan = await createPlan(goal);
  printLine(`Plan created: ${plan.id}`);
  printLine("Goal:", plan.goal);
  printLine("Steps:");
  for (const line of formatSteps(plan)) {
    printLine(line);
  }
  if (plan.successCriteria?.length) {
    printLine("Success criteria:");
    for (const line of formatSuccessCriteria(plan)) {
      printLine(line);
    }
  }
  printLine(`SSE stream: /plan/${plan.id}/events`);
  return plan;
}
