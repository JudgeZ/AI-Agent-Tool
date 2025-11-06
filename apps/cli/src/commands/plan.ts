import { createPlan, type Plan } from "@oss/orchestrator/plan";

function formatSteps(plan: Plan): string[] {
  return plan.steps.map(step => {
    const approvalText = step.approvalRequired ? "requires approval" : "auto";
    return `  • ${step.action} (${step.capabilityLabel}) [tool=${step.tool}, timeout=${step.timeoutSeconds}s, ${approvalText}]`;
  });
}

function formatSuccessCriteria(plan: Plan): string[] {
  return (plan.successCriteria ?? []).map(criteria => `  - ${criteria}`);
}

export async function runPlan(goal: string): Promise<Plan> {
  const plan = await createPlan(goal);
  console.log(`Plan created: ${plan.id}`);
  console.log("Goal:", plan.goal);
  console.log("Steps:");
  for (const line of formatSteps(plan)) {
    console.log(line);
  }
  if (plan.successCriteria?.length) {
    console.log("Success criteria:");
    for (const line of formatSuccessCriteria(plan)) {
      console.log(line);
    }
  }
  console.log(`SSE stream: /plan/${plan.id}/events`);
  return plan;
}
