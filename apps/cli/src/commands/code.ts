import { runPlan } from "./plan";

export async function runCode(goal: string): Promise<void> {
  if (!goal.trim()) {
    throw new Error("Code command requires a goal or description");
  }
  await runPlan(goal);
}
