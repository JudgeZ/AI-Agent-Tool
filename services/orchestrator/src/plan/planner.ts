import fs from "fs";
import path from "path";
import crypto from "crypto";

import { publishPlanStepEvent } from "./events.js";
import { startSpan } from "../observability/tracing.js";
import { parsePlan, PlanStepSchema, type Plan, type PlanStep } from "./validation.js";

export type { Plan, PlanStep, PlanSubject } from "./validation.js";

const DEFAULT_PLAN_ARTIFACT_RETENTION_DAYS = 30;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_CAPABILITY_LABELS: Record<string, string> = {
  "repo.read": "Read repository",
  "repo.write": "Apply repository changes",
  "test.run": "Execute tests",
  "github.write": "Open pull request",
  "network.egress": "Call external service"
};

const DEFAULT_STEP_TIMEOUTS: Record<string, number> = {
  index_repo: 300,
  apply_changes: 900,
  run_tests: 900,
  open_pr: 300
};

function buildSteps(goal: string): PlanStep[] {
  const labels = ["repo", "automation"];
  return [
    {
      id: "s1",
      action: "index_repo",
      tool: "repo_indexer",
      capability: "repo.read",
      capabilityLabel: DEFAULT_CAPABILITY_LABELS["repo.read"],
      labels,
      timeoutSeconds: DEFAULT_STEP_TIMEOUTS.index_repo,
      approvalRequired: false,
      input: { goal }
    },
    {
      id: "s2",
      action: "apply_changes",
      tool: "code_writer",
      capability: "repo.write",
      capabilityLabel: DEFAULT_CAPABILITY_LABELS["repo.write"],
      labels: [...labels, "approval"],
      timeoutSeconds: DEFAULT_STEP_TIMEOUTS.apply_changes,
      approvalRequired: true,
      input: { goal },
      metadata: { approvalType: "human" }
    },
    {
      id: "s3",
      action: "run_tests",
      tool: "test_runner",
      capability: "test.run",
      capabilityLabel: DEFAULT_CAPABILITY_LABELS["test.run"],
      labels,
      timeoutSeconds: DEFAULT_STEP_TIMEOUTS.run_tests,
      approvalRequired: false,
      input: { goal }
    },
    {
      id: "s4",
      action: "open_pr",
      tool: "github_client",
      capability: "github.write",
      capabilityLabel: DEFAULT_CAPABILITY_LABELS["github.write"],
      labels: [...labels, "approval"],
      timeoutSeconds: DEFAULT_STEP_TIMEOUTS.open_pr,
      approvalRequired: true,
      input: { goal }
    }
  ].map(step => PlanStepSchema.parse(step));
}

function isChildPath(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  return true;
}

function cleanupPlanArtifacts(baseDir: string, retentionDays: number): void {
  if (retentionDays <= 0) {
    return;
  }
  const retentionMs = retentionDays * MILLIS_PER_DAY;
  try {
    const resolvedBase = path.resolve(baseDir);
    const entries = fs.readdirSync(resolvedBase, { withFileTypes: true });
    const cutoff = Date.now() - retentionMs;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }
      const target = path.join(resolvedBase, entry.name);
      if (!isChildPath(resolvedBase, target)) {
        continue;
      }
      let stats: fs.Stats;
      try {
        stats = fs.statSync(target);
      } catch {
        continue;
      }
      const lastModified = stats.mtimeMs ?? stats.ctimeMs ?? 0;
      if (lastModified <= cutoff) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export function createPlan(goal: string, options?: { retentionDays?: number }): Plan {
  const span = startSpan("planner.createPlan", { goal });
  try {
    const id = "plan-" + crypto.randomBytes(4).toString("hex");
    span.setAttribute("plan.id", id);

    const steps = buildSteps(goal);
    const plan = parsePlan({
      id,
      goal,
      steps,
      successCriteria: ["All tests pass", "CI green", "Docs updated"]
    });

    const plansRoot = path.join(process.cwd(), ".plans");
    const dir = path.join(plansRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2));
    fs.writeFileSync(
      path.join(dir, "plan.md"),
      `# Plan ${id}\n\nGoal: ${goal}\n\nSteps:\n` +
        plan.steps
          .map(step =>
            `- **${step.action}** (${step.capabilityLabel}) — tool: ${step.tool}, timeout: ${step.timeoutSeconds}s, approval: ${
              step.approvalRequired ? "required" : "auto"
            }`
          )
          .join("\n")
    );

    const retentionDays = options?.retentionDays ?? DEFAULT_PLAN_ARTIFACT_RETENTION_DAYS;
    if (retentionDays > 0) {
      cleanupPlanArtifacts(plansRoot, retentionDays);
    }

    for (const step of steps) {
      const state = step.approvalRequired ? "waiting_approval" : "queued";
      const summary = step.approvalRequired ? "Awaiting approval" : "Queued for execution";
      publishPlanStepEvent({
        event: "plan.step",
        traceId: span.context.traceId,
        planId: id,
        step: {
          id: step.id,
          action: step.action,
          tool: step.tool,
          state,
          capability: step.capability,
          capabilityLabel: step.capabilityLabel,
          labels: step.labels,
          timeoutSeconds: step.timeoutSeconds,
          approvalRequired: step.approvalRequired,
          summary
        }
      });
    }

    return plan;
  } finally {
    span.end();
  }
}
