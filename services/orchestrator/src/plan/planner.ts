import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "path";
import crypto from "crypto";

import { publishPlanStepEvent } from "./events.js";
import { startSpan } from "../observability/tracing.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { getTenantKeyManager } from "../security/tenantKeys.js";
import {
  parsePlan,
  PlanStepSchema,
  type Plan,
  type PlanStep,
  type PlanSubject
} from "./validation.js";

export type { Plan, PlanStep, PlanSubject } from "./validation.js";

const DEFAULT_PLAN_ARTIFACT_RETENTION_DAYS = 30;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
// Restrict artifact readability to the orchestrator user; encryption keys live out of process so
// there is no need for group/world access.
const ARTIFACT_FILE_MODE = 0o600;

function getRealpath(): (target: string) => Promise<string> {
  const withNative = fsPromises.realpath as typeof fsPromises.realpath & {
    native?: typeof fsPromises.realpath;
  };
  if (typeof withNative.native === "function") {
    return withNative.native.bind(fsPromises);
  }
  return fsPromises.realpath.bind(fsPromises);
}

const realpath = getRealpath();

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
  if (!relative || path.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(path.sep);
  if (segments.some(segment => segment === "..")) {
    return false;
  }
  const posixSegments = relative.split(path.posix.sep);
  if (posixSegments.some(segment => segment === "..")) {
    return false;
  }
  return true;
}

function isSafeDirentName(name: string): boolean {
  if (!name) {
    return false;
  }
  if (name.includes("..")) {
    return false;
  }
  if (name.includes(path.sep) || name.includes(path.posix.sep)) {
    return false;
  }
  return path.basename(name) === name;
}

async function cleanupPlanArtifacts(baseDir: string, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) {
    return;
  }
  const retentionMs = retentionDays * MILLIS_PER_DAY;
  let resolvedBase: string;
  try {
    resolvedBase = await realpath(baseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  let dir: fs.Dir | null = null;
  try {
    dir = await fsPromises.opendir(resolvedBase);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const cutoff = Date.now() - retentionMs;

  try {
    for await (const entry of dir) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }
      const entryName = entry.name;
      if (!isSafeDirentName(entryName)) {
        continue;
      }

      const targetCandidate = resolvedBase.endsWith(path.sep)
        ? `${resolvedBase}${entryName}`
        : `${resolvedBase}${path.sep}${entryName}`;

      let target: string;
      try {
        target = await realpath(targetCandidate);
      } catch {
        continue;
      }

      if (!isChildPath(resolvedBase, target)) {
        continue;
      }

      let stats: fs.Stats;
      try {
        stats = await fsPromises.stat(target);
      } catch {
        continue;
      }

      const lastModified = stats.mtimeMs ?? stats.ctimeMs ?? 0;
      if (lastModified <= cutoff) {
        try {
          await fsPromises.rm(target, { recursive: true, force: true });
        } catch {
          // Ignore failures and continue attempting to clean other entries.
        }
      }
    }
  } finally {
    await dir?.close();
  }
}

async function writeEncryptedArtifact(
  targetPath: string,
  content: string,
  tenantId?: string
): Promise<void> {
  const manager = getTenantKeyManager();
  const payload = await manager.encryptArtifact(tenantId, Buffer.from(content, "utf-8"));
  await fsPromises.writeFile(targetPath, JSON.stringify(payload, null, 2), { mode: ARTIFACT_FILE_MODE });
}

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

type CleanupState = {
  baseDir?: string;
  retentionDays?: number;
  interval?: NodeJS.Timeout;
  immediateTimer?: NodeJS.Timeout;
  pending?: Promise<void> | null;
};

const cleanupState: CleanupState = {
  pending: null
};

async function runScheduledCleanup(): Promise<void> {
  if (!cleanupState.baseDir || !cleanupState.retentionDays || cleanupState.retentionDays <= 0) {
    return;
  }

  if (cleanupState.pending) {
    await cleanupState.pending;
    return;
  }

  cleanupState.pending = cleanupPlanArtifacts(cleanupState.baseDir, cleanupState.retentionDays)
    .catch(error => {
      if (process.env.NODE_ENV !== "test") {
        appLogger.error(
          { err: normalizeError(error), event: "plan.cleanup_failed" },
          "Failed to clean plan artifacts",
        );
      }
    })
    .finally(() => {
      cleanupState.pending = null;
    });

  await cleanupState.pending;
}

function cancelCleanupTimers(): void {
  if (cleanupState.interval) {
    clearInterval(cleanupState.interval);
    cleanupState.interval = undefined;
  }
  if (cleanupState.immediateTimer) {
    clearTimeout(cleanupState.immediateTimer);
    cleanupState.immediateTimer = undefined;
  }
}

function ensureCleanupInterval(): void {
  if (!cleanupState.interval) {
    cleanupState.interval = setInterval(() => {
      void runScheduledCleanup();
    }, CLEANUP_INTERVAL_MS);
    cleanupState.interval.unref?.();
  }
}

function queueImmediateCleanup(): void {
  if (!cleanupState.immediateTimer) {
    cleanupState.immediateTimer = setTimeout(() => {
      cleanupState.immediateTimer = undefined;
      void runScheduledCleanup();
    }, 0);
    cleanupState.immediateTimer.unref?.();
  }
}

function schedulePlanArtifactCleanup(baseDir: string, retentionDays: number): void {
  cleanupState.baseDir = baseDir;
  cleanupState.retentionDays = retentionDays;

  if (retentionDays <= 0) {
    cancelCleanupTimers();
    return;
  }

  ensureCleanupInterval();
  queueImmediateCleanup();
}

export async function flushPlanArtifactCleanup(): Promise<void> {
  if (cleanupState.immediateTimer) {
    clearTimeout(cleanupState.immediateTimer);
    cleanupState.immediateTimer = undefined;
  }
  await runScheduledCleanup();
}

export function resetPlanArtifactCleanupSchedulerForTests(): void {
  cancelCleanupTimers();
  cleanupState.baseDir = undefined;
  cleanupState.retentionDays = undefined;
  cleanupState.pending = null;
}

export async function createPlan(
  goal: string,
  options?: { retentionDays?: number; subject?: PlanSubject }
): Promise<Plan> {
  const span = startSpan("planner.createPlan", { goal });
  try {
    const id = `plan-${crypto.randomUUID()}`;
    span.setAttribute("plan.id", id);
    span.setAttribute("plan.id_length", id.length);

    const steps = buildSteps(goal);
    const plan = parsePlan({
      id,
      goal,
      steps,
      successCriteria: ["All tests pass", "CI green", "Docs updated"]
    });

    const plansRoot = path.join(process.cwd(), ".plans");
    const dir = path.join(plansRoot, id);
    await fsPromises.mkdir(dir, { recursive: true });
    const artifactTenantId = options?.subject?.tenantId;
    await Promise.all([
      writeEncryptedArtifact(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2), artifactTenantId),
      writeEncryptedArtifact(
        path.join(dir, "plan.md"),
        `# Plan ${id}\n\nGoal: ${goal}\n\nSteps:\n` +
          plan.steps
            .map(step =>
              `- **${step.action}** (${step.capabilityLabel}) — tool: ${step.tool}, timeout: ${step.timeoutSeconds}s, approval: ${
                step.approvalRequired ? "required" : "auto"
              }`
            )
            .join("\n"),
        artifactTenantId
      )
    ]);

    const retentionDays = options?.retentionDays ?? DEFAULT_PLAN_ARTIFACT_RETENTION_DAYS;
    schedulePlanArtifactCleanup(plansRoot, retentionDays);

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
