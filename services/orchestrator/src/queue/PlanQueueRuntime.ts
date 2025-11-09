import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";

import {
  queueDepthGauge,
  queueProcessingHistogram,
  queueResultCounter,
} from "../observability/metrics.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";
import {
  getLatestPlanStepEvent,
  publishPlanStepEvent,
  HISTORY_RETENTION_MS,
} from "../plan/events.js";
import type { Plan, PlanStep, PlanSubject } from "../plan/planner.js";
import {
  getToolAgentClient,
  resetToolAgentClient,
  ToolClientError,
} from "../grpc/AgentClient.js";
import type { PlanJob, ToolEvent } from "../plan/validation.js";
import { getQueueAdapter } from "./QueueAdapter.js";
import type { QueueAdapter } from "./QueueAdapter.js";
import {
  createPlanStateStore,
  type PlanStatePersistence,
} from "./PlanStateStore.js";
import { getPostgresPool } from "../database/Postgres.js";
import { withSpan } from "../observability/tracing.js";
import {
  getPolicyEnforcer,
  PolicyViolationError,
  type PolicyDecision,
} from "../policy/PolicyEnforcer.js";
import { loadConfig } from "../config.js";

export const PLAN_STEPS_QUEUE = "plan.steps";
export const PLAN_COMPLETIONS_QUEUE = "plan.completions";

export type PlanStepTaskPayload = PlanJob;

export type PlanStepCompletionPayload = {
  planId: string;
  stepId: string;
  state: ToolEvent["state"];
  summary?: string;
  output?: Record<string, unknown>;
  capability?: string;
  capabilityLabel?: string;
  labels?: string[];
  tool?: string;
  timeoutSeconds?: number;
  approvalRequired?: boolean;
  traceId?: string;
  occurredAt?: string;
  attempt?: number;
  approvals?: Record<string, boolean>;
};

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INIT_MAX_ATTEMPTS = 5;

const runtimeConfig = loadConfig();
const DAY_MS = 24 * 60 * 60 * 1000;
const planStateRetentionMs =
  runtimeConfig.retention.planStateDays > 0
    ? runtimeConfig.retention.planStateDays * DAY_MS
    : undefined;
const contentCaptureEnabled = runtimeConfig.retention.contentCapture.enabled;

function instantiatePlanStateStore(): PlanStatePersistence {
  if (runtimeConfig.planState.backend === "postgres") {
    const pool = getPostgresPool();
    if (!pool) {
      throw new Error(
        "POSTGRES_URL must be configured when using the postgres plan state backend",
      );
    }
    return createPlanStateStore({
      backend: "postgres",
      retentionMs: planStateRetentionMs,
      pool,
    });
  }
  return createPlanStateStore({
    backend: "file",
    retentionMs: planStateRetentionMs,
  });
}

const stepRegistry = new Map<
  string,
  { step: PlanStep; traceId: string; job: PlanJob; inFlight: boolean }
>();
const approvalCache = new Map<string, Record<string, boolean>>();
const planSubjects = new Map<string, PlanSubject>();
const retainedPlanSubjects = new Map<
  string,
  { subject: PlanSubject; timeout?: NodeJS.Timeout }
>();
const planMetadataLocks = new Map<string, Promise<void>>();

function clonePlanSubject(subject: PlanSubject): PlanSubject {
  return {
    ...subject,
    roles: [...subject.roles],
    scopes: [...subject.scopes],
  };
}

function clearRetainedPlanSubject(planId: string): void {
  const entry = retainedPlanSubjects.get(planId);
  if (entry?.timeout) {
    clearTimeout(entry.timeout);
  }
  retainedPlanSubjects.delete(planId);
}

function retainCompletedPlanSubject(planId: string, subject: PlanSubject): void {
  clearRetainedPlanSubject(planId);
  const timeout = setTimeout(() => {
    retainedPlanSubjects.delete(planId);
  }, HISTORY_RETENTION_MS);
  timeout.unref?.();
  retainedPlanSubjects.set(planId, { subject: clonePlanSubject(subject), timeout });
}

function getRetainedPlanSubject(planId: string): PlanSubject | undefined {
  const entry = retainedPlanSubjects.get(planId);
  if (!entry) {
    return undefined;
  }
  return clonePlanSubject(entry.subject);
}
const policyEnforcer = getPolicyEnforcer();
let planStateStore: PlanStatePersistence | null = instantiatePlanStateStore();
let initialized: Promise<void> | null = null;

let stepConsumerSetupPromise: Promise<void> | null = null;
let stepConsumerReady = false;

let completionConsumerSetupPromise: Promise<void> | null = null;
let completionConsumerReady = false;

const TERMINAL_STATES = new Set<ToolEvent["state"]>([
  "completed",
  "failed",
  "dead_lettered",
  "rejected",
]);

function planSubjectToAuditSubject(
  subject?: PlanSubject,
): AuditSubject | undefined {
  if (!subject) {
    return undefined;
  }
  return {
    sessionId: subject.sessionId,
    userId: subject.userId,
    tenantId: subject.tenantId,
    email: subject.email ?? null,
    name: subject.name ?? null,
    roles: subject.roles.length > 0 ? [...subject.roles] : undefined,
    scopes: subject.scopes.length > 0 ? [...subject.scopes] : undefined,
  };
}

function parseIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const MAX_RETRIES = parseIntEnv("QUEUE_RETRY_MAX") ?? DEFAULT_MAX_RETRIES;
const INIT_MAX_ATTEMPTS = Math.max(
  parseIntEnv("QUEUE_INIT_MAX_ATTEMPTS") ?? DEFAULT_INIT_MAX_ATTEMPTS,
  1,
);
const INIT_BACKOFF_BASE_MS = parseIntEnv("QUEUE_INIT_BACKOFF_MS");

function computeRetryDelayMs(attempt: number): number | undefined {
  const base = parseIntEnv("QUEUE_RETRY_BACKOFF_MS");
  if (base === undefined || base <= 0) {
    return undefined;
  }
  const normalizedAttempt = Math.max(0, attempt);
  const multiplier = 2 ** normalizedAttempt;
  const rawDelay = base * multiplier;
  if (!Number.isFinite(rawDelay)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.min(rawDelay, Number.MAX_SAFE_INTEGER);
}

function computeInitializationDelayMs(attempt: number): number | undefined {
  if (INIT_BACKOFF_BASE_MS === undefined || INIT_BACKOFF_BASE_MS <= 0) {
    return undefined;
  }
  const normalizedAttempt = Math.max(0, attempt);
  const multiplier = 2 ** normalizedAttempt;
  const rawDelay = INIT_BACKOFF_BASE_MS * multiplier;
  if (!Number.isFinite(rawDelay)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.min(rawDelay, Number.MAX_SAFE_INTEGER);
}

function delay(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function approvalKey(planId: string, stepId: string): string {
  return `${planId}:${stepId}`;
}

async function ensureApprovals(
  planId: string,
  stepId: string,
): Promise<Record<string, boolean>> {
  const key = approvalKey(planId, stepId);
  const cached = approvalCache.get(key);
  if (cached) {
    return cached;
  }
  const persisted = await planStateStore?.getEntry(planId, stepId);
  const approvals = persisted?.approvals ? { ...persisted.approvals } : {};
  approvalCache.set(key, approvals);
  return approvals;
}

function cacheApprovals(
  planId: string,
  stepId: string,
  approvals: Record<string, boolean>,
): void {
  approvalCache.set(approvalKey(planId, stepId), { ...approvals });
}

function clearApprovals(planId: string, stepId: string): void {
  approvalCache.delete(approvalKey(planId, stepId));
}

export function hasPendingPlanStep(planId: string, stepId: string): boolean {
  return stepRegistry.has(`${planId}:${stepId}`);
}

export function hasApprovalCacheEntry(planId: string, stepId: string): boolean {
  return approvalCache.has(approvalKey(planId, stepId));
}

export function hasActivePlanSubject(planId: string): boolean {
  return planSubjects.has(planId);
}

export async function persistPlanStepState(
  planId: string,
  stepId: string,
  state: ToolEvent["state"],
  summary?: string,
  output?: Record<string, unknown>,
  attempt?: number,
): Promise<void> {
  const sanitizedOutput = contentCaptureEnabled ? output : undefined;
  await planStateStore?.setState(
    planId,
    stepId,
    state,
    summary,
    sanitizedOutput,
    attempt,
  );
}

async function authorizePlanStep(
  planId: string,
  step: PlanStep,
  traceId: string,
  approvals: Record<string, boolean>,
  subject?: PlanSubject,
): Promise<PolicyDecision> {
  try {
    const decision = await policyEnforcer.enforcePlanStep(step, {
      planId,
      traceId,
      approvals,
      subject: toPolicySubject(subject),
    });
    const blockingReasons = decision.deny.filter(
      (reason) => reason.reason !== "approval_required",
    );
    if (
      !decision.allow &&
      (blockingReasons.length > 0 || !step.approvalRequired)
    ) {
      logAuditEvent({
        action: "plan.step.authorize",
        outcome: "denied",
        traceId,
        agent: step.tool,
        resource: "plan.step",
        subject: planSubjectToAuditSubject(subject),
        details: {
          planId,
          stepId: step.id,
          capability: step.capability,
          deny: decision.deny,
        },
      });
      throw new PolicyViolationError(
        `Plan step ${step.id} for capability ${step.capability} is not permitted`,
        decision.deny,
      );
    }
    return decision;
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      logAuditEvent({
        action: "plan.step.authorize",
        outcome: "denied",
        traceId,
        agent: step.tool,
        resource: "plan.step",
        subject: planSubjectToAuditSubject(subject),
        details: {
          planId,
          stepId: step.id,
          capability: step.capability,
          deny: error.details,
          error: error.message,
        },
      });
    }
    throw error;
  }
}

async function withPlanMetadataLock(
  planId: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = planMetadataLocks.get(planId) ?? Promise.resolve();
  let nextHandle: Promise<void>;
  const execute = async () => {
    await previous.catch(() => undefined);
    try {
      await task();
    } finally {
      if (planMetadataLocks.get(planId) === nextHandle) {
        planMetadataLocks.delete(planId);
      }
    }
  };
  nextHandle = execute();
  planMetadataLocks.set(planId, nextHandle.catch(() => undefined));
  await nextHandle;
}

async function releaseNextPlanSteps(planId: string): Promise<void> {
  await withPlanMetadataLock(planId, async () => {
    const metadata = await planStateStore?.getPlanMetadata(planId);
    if (!metadata) {
      return;
    }
    let adapter: QueueAdapter | undefined;
    const ensureAdapter = async (): Promise<QueueAdapter> => {
      if (!adapter) {
        adapter = await getQueueAdapter();
      }
      return adapter;
    };

    const canReleaseNextStep = () =>
      metadata.nextStepIndex < metadata.steps.length &&
      metadata.nextStepIndex <= metadata.lastCompletedIndex + 1;

    while (canReleaseNextStep()) {
      const stepEntry = metadata.steps[metadata.nextStepIndex];
      const key = `${planId}:${stepEntry.step.id}`;
      const existing = await planStateStore?.getEntry(planId, stepEntry.step.id);
      if (existing) {
        if (
          existing.state === "queued" ||
          existing.state === "running" ||
          existing.state === "retrying"
        ) {
          break;
        }
      }

      const subjectContext =
        stepEntry.subject ?? existing?.subject ?? planSubjects.get(planId);
      const job: PlanJob = {
        planId,
        step: stepEntry.step,
        attempt: existing?.attempt ?? stepEntry.attempt ?? 0,
        createdAt: existing?.createdAt ?? stepEntry.createdAt,
        traceId: metadata.traceId,
        subject: subjectContext ? clonePlanSubject(subjectContext) : undefined,
      };

      stepEntry.attempt = job.attempt;
      stepEntry.createdAt = job.createdAt;
      stepEntry.subject = job.subject ? clonePlanSubject(job.subject) : undefined;

      const approvals = await ensureApprovals(planId, stepEntry.step.id);
      await authorizePlanStep(
        planId,
        stepEntry.step,
        metadata.traceId,
        approvals,
        job.subject,
      );

      stepRegistry.set(key, {
        step: stepEntry.step,
        traceId: metadata.traceId,
        job,
        inFlight: false,
      });

      const requiresApproval =
        stepEntry.step.approvalRequired &&
        !approvals[stepEntry.step.capability];

      if (requiresApproval) {
        if (!existing) {
          await planStateStore?.rememberStep(
            planId,
            stepEntry.step,
            metadata.traceId,
            {
              initialState: "waiting_approval",
              idempotencyKey: key,
              attempt: job.attempt,
              createdAt: job.createdAt,
              approvals,
              subject: job.subject,
            },
          );
          await emitPlanEvent(planId, stepEntry.step, metadata.traceId, {
            state: "waiting_approval",
            summary: "Awaiting approval",
            attempt: job.attempt,
          });
        }
        break;
      }

      cacheApprovals(planId, stepEntry.step.id, approvals);

      const queueAdapter = await ensureAdapter();
      if (!existing) {
        await planStateStore?.rememberStep(
          planId,
          stepEntry.step,
          metadata.traceId,
          {
            initialState: "queued",
            idempotencyKey: key,
            attempt: job.attempt,
            createdAt: job.createdAt,
            approvals,
            subject: job.subject,
          },
        );
      }

      try {
        await queueAdapter.enqueue<PlanStepTaskPayload>(
          PLAN_STEPS_QUEUE,
          { ...job },
          {
            idempotencyKey: key,
            headers: { "trace-id": metadata.traceId },
          },
        );
      } catch (error) {
        const summary =
          error instanceof Error ? error.message : "Failed to enqueue plan step";
        await emitPlanEvent(planId, stepEntry.step, metadata.traceId, {
          state: "failed",
          summary,
          attempt: job.attempt,
        });
        stepRegistry.delete(key);
        clearApprovals(planId, stepEntry.step.id);
        prunePlanSubject(planId);
        console.warn(
          "plan.step.enqueue_failed_cleanup",
          { planId, stepId: stepEntry.step.id },
          error,
        );
        throw error;
      }

      await emitPlanEvent(planId, stepEntry.step, metadata.traceId, {
        state: "queued",
        summary: "Queued for execution",
        attempt: job.attempt,
      });

      metadata.nextStepIndex += 1;
    }

    if (metadata.nextStepIndex >= metadata.steps.length) {
      if (metadata.lastCompletedIndex >= metadata.steps.length - 1) {
        await planStateStore?.forgetPlanMetadata(planId);
      } else {
        await planStateStore?.rememberPlanMetadata(planId, metadata);
      }
    } else {
      await planStateStore?.rememberPlanMetadata(planId, metadata);
    }

    if (adapter) {
      const depth = await adapter.getQueueDepth(PLAN_STEPS_QUEUE);
      queueDepthGauge.labels(PLAN_STEPS_QUEUE).set(depth);
    }
  });
}

async function emitPlanEvent(
  planId: string,
  step: PlanStep,
  traceId: string,
  update: Partial<ToolEvent> & {
    state: ToolEvent["state"];
    summary?: string;
    output?: Record<string, unknown>;
    attempt?: number;
  },
): Promise<void> {
  const sanitizedOutput = contentCaptureEnabled ? update.output : undefined;
  await planStateStore?.setState(
    planId,
    step.id,
    update.state,
    update.summary,
    sanitizedOutput,
    update.attempt,
  );
  const latest = getLatestPlanStepEvent(planId, step.id);
  if (latest && latest.step.state === update.state) {
    const summariesMatch =
      update.summary === undefined
        ? latest.step.summary === undefined
        : latest.step.summary === update.summary;
    const outputsMatch = contentCaptureEnabled
      ? update.output === undefined
        ? latest.step.output === undefined
        : isDeepStrictEqual(latest.step.output, update.output)
      : latest.step.output === undefined;
    const occurredAtDiffers =
      update.occurredAt !== undefined &&
      latest.occurredAt !== update.occurredAt;
    if (summariesMatch && outputsMatch && !occurredAtDiffers) {
      return;
    }
  }
  publishPlanStepEvent({
    event: "plan.step",
    traceId,
    planId,
    occurredAt: update.occurredAt ?? new Date().toISOString(),
    step: {
      id: step.id,
      action: step.action,
      tool: step.tool,
      state: update.state,
      capability: step.capability,
      capabilityLabel: step.capabilityLabel,
      labels: step.labels,
      timeoutSeconds: step.timeoutSeconds,
      approvalRequired: step.approvalRequired,
      attempt: update.attempt,
      summary: update.summary ?? undefined,
      output: sanitizedOutput as Record<string, unknown> | undefined,
    },
  });
}

async function publishToolEvents(
  planId: string,
  baseStep: PlanStep,
  traceId: string,
  job: PlanJob,
  events: ToolEvent[],
): Promise<void> {
  for (const event of events) {
    await emitPlanEvent(planId, baseStep, traceId, {
      state: event.state,
      summary: event.summary,
      occurredAt: event.occurredAt,
      output: event.output as Record<string, unknown> | undefined,
      attempt: job.attempt,
    });
  }
}

async function performInitialization(): Promise<void> {
  await Promise.all([
    setupStepConsumer(),
    setupCompletionConsumer(),
    rehydratePendingSteps(),
  ]);
}

async function initializeWithRetry(): Promise<void> {
  const maxAttempts = Math.max(1, INIT_MAX_ATTEMPTS);
  let attempt = 0;
  for (;;) {
    try {
      await performInitialization();
      return;
    } catch (error) {
      attempt += 1;
      const willRetry = attempt < maxAttempts;
      const retryDelayMs = willRetry
        ? computeInitializationDelayMs(attempt - 1)
        : undefined;
      const context: {
        attempt: number;
        maxAttempts: number;
        willRetry: boolean;
        retryDelayMs?: number;
      } = {
        attempt,
        maxAttempts,
        willRetry,
      };
      if (retryDelayMs !== undefined) {
        context.retryDelayMs = retryDelayMs;
      }
      console.error("plan.queue_runtime.initialization_failed", context, error);
      if (!willRetry) {
        throw error;
      }
      if (retryDelayMs !== undefined) {
        await delay(retryDelayMs);
      }
    }
  }
}

export async function initializePlanQueueRuntime(): Promise<void> {
  if (!initialized) {
    initialized = initializeWithRetry().catch((error) => {
      initialized = null;
      throw error;
    });
  }
  await initialized;
}

export function resetPlanQueueRuntime(): void {
  initialized = null;
  stepRegistry.clear();
  approvalCache.clear();
  planSubjects.clear();
  planMetadataLocks.clear();
  retainedPlanSubjects.forEach(({ timeout }) => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
  retainedPlanSubjects.clear();
  resetToolAgentClient();
  planStateStore = instantiatePlanStateStore();
  stepConsumerReady = false;
  stepConsumerSetupPromise = null;
  completionConsumerReady = false;
  completionConsumerSetupPromise = null;
}

export async function submitPlanSteps(
  plan: Plan,
  traceId: string,
  subject?: PlanSubject,
): Promise<void> {
  await initializePlanQueueRuntime();

  if (subject) {
    planSubjects.set(plan.id, clonePlanSubject(subject));
    clearRetainedPlanSubject(plan.id);
  } else {
    planSubjects.delete(plan.id);
    clearRetainedPlanSubject(plan.id);
  }

  const activeSubject = subject ?? planSubjects.get(plan.id);
  const metadataSteps = plan.steps.map((step) => ({
    step,
    createdAt: new Date().toISOString(),
    attempt: 0,
    subject: activeSubject ? clonePlanSubject(activeSubject) : undefined,
  }));

  await withPlanMetadataLock(plan.id, async () => {
    await planStateStore?.rememberPlanMetadata(plan.id, {
      planId: plan.id,
      traceId,
      steps: metadataSteps,
      nextStepIndex: 0,
      lastCompletedIndex: -1,
    });
  });

  await releaseNextPlanSteps(plan.id);
}

export type ApprovalDecision = "approved" | "rejected";

export async function resolvePlanStepApproval(options: {
  planId: string;
  stepId: string;
  decision: ApprovalDecision;
  summary?: string;
}): Promise<void> {
  const { planId, stepId, decision, summary } = options;
  await initializePlanQueueRuntime();
  const key = `${planId}:${stepId}`;

  let metadata = stepRegistry.get(key);
  if (!metadata) {
    const persisted = await planStateStore?.getEntry(planId, stepId);
    if (persisted) {
      const job: PlanJob = {
        planId: persisted.planId,
        step: persisted.step,
        attempt: persisted.attempt,
        createdAt: persisted.createdAt,
        traceId: persisted.traceId,
      };
      metadata = {
        step: persisted.step,
        traceId: persisted.traceId,
        job,
        inFlight: false,
      };
      stepRegistry.set(key, metadata);
    }
  }

  if (!metadata) {
    throw new Error(`Plan step ${planId}/${stepId} is not available`);
  }

  const { step, traceId, job } = metadata;
  const decisionSummary =
    summary ??
    (decision === "approved" ? "Approved for execution" : "Step rejected");

  if (decision === "rejected") {
    await emitPlanEvent(planId, step, traceId, {
      state: "rejected",
      summary: decisionSummary,
      attempt: job.attempt,
    });
    stepRegistry.delete(key);
    clearApprovals(planId, stepId);
    await planStateStore?.forgetStep(planId, stepId);
    prunePlanSubject(planId);
    return;
  }

  const approvals = await ensureApprovals(planId, stepId);
  const updatedApprovals = { ...approvals, [step.capability]: true };
  const subjectContext = metadata.job.subject ?? planSubjects.get(planId);
  try {
    await authorizePlanStep(planId, step, traceId, updatedApprovals, subjectContext);
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      const details = Array.isArray(error.details) ? error.details : [];
      const summary =
        details.length > 0
          ? details
              .map((entry) =>
                entry.capability
                  ? `${entry.reason}:${entry.capability}`
                  : entry.reason,
              )
              .join("; ")
          : error.message;
      await emitPlanEvent(planId, step, traceId, {
        state: "rejected",
        summary,
        attempt: job.attempt,
      });
      stepRegistry.delete(key);
      clearApprovals(planId, stepId);
      await planStateStore?.forgetStep(planId, stepId);
      prunePlanSubject(planId);
    }
    throw error;
  }

  cacheApprovals(planId, stepId, updatedApprovals);
  await planStateStore?.recordApproval(planId, stepId, step.capability, true);

  await emitPlanEvent(planId, step, traceId, {
    state: "approved",
    summary: decisionSummary,
    attempt: job.attempt,
  });
  const refreshedJob: PlanJob = { ...job, createdAt: new Date().toISOString() };
  metadata.job = refreshedJob;
  stepRegistry.set(key, { step, traceId, job: refreshedJob, inFlight: false });

  await releaseNextPlanSteps(planId);
}

async function setupCompletionConsumer(): Promise<void> {
  if (completionConsumerReady) {
    return;
  }
  if (!completionConsumerSetupPromise) {
    completionConsumerSetupPromise = (async () => {
      const adapter = await getQueueAdapter();
      await adapter.consume<PlanStepCompletionPayload>(
        PLAN_COMPLETIONS_QUEUE,
        async (message) => {
          const payload = message.payload;
          const key = `${payload.planId}:${payload.stepId}`;
          const metadata = stepRegistry.get(key);
          const persistedEntry = metadata
            ? undefined
            : await planStateStore?.getEntry(payload.planId, payload.stepId);
          const baseStep = metadata?.step ?? persistedEntry?.step;
          const persistedApprovals = metadata
            ? undefined
            : persistedEntry?.approvals;
          if (!metadata && persistedApprovals) {
            cacheApprovals(payload.planId, payload.stepId, persistedApprovals);
          }
          const attempt =
            payload.attempt ??
            metadata?.job.attempt ??
            persistedEntry?.attempt ??
            0;
          const traceId =
            payload.traceId ||
            metadata?.traceId ||
            persistedEntry?.traceId ||
            message.headers["trace-id"] ||
            message.headers["traceId"] ||
            message.headers["Trace-Id"] ||
            "";

          await persistPlanStepState(
            payload.planId,
            payload.stepId,
            payload.state,
            payload.summary,
            payload.output as Record<string, unknown> | undefined,
            attempt,
          );
          const sanitizedOutput = contentCaptureEnabled
            ? (payload.output as Record<string, unknown> | undefined)
            : undefined;
          publishPlanStepEvent({
            event: "plan.step",
            traceId: traceId || message.id,
            planId: payload.planId,
            occurredAt: payload.occurredAt ?? new Date().toISOString(),
            step: {
              id: payload.stepId,
              action: baseStep?.action ?? payload.stepId,
              tool: payload.tool ?? baseStep?.tool ?? payload.stepId,
              state: payload.state,
              capability:
                payload.capability ?? baseStep?.capability ?? "unknown",
              capabilityLabel:
                payload.capabilityLabel ??
                baseStep?.capabilityLabel ??
                payload.capability ??
                "unknown",
              labels: payload.labels ?? baseStep?.labels ?? [],
              timeoutSeconds:
                payload.timeoutSeconds ?? baseStep?.timeoutSeconds ?? 0,
              approvalRequired:
                payload.approvalRequired ?? baseStep?.approvalRequired ?? false,
              attempt,
              summary: payload.summary,
              output: sanitizedOutput,
              approvals: payload.approvals ?? persistedApprovals,
            },
          });

          if (TERMINAL_STATES.has(payload.state)) {
            if (payload.state === "completed") {
              await withPlanMetadataLock(payload.planId, async () => {
                const metadata = await planStateStore?.getPlanMetadata(
                  payload.planId,
                );
                if (!metadata) {
                  return;
                }
                const index = metadata.steps.findIndex(
                  (entry) => entry.step.id === payload.stepId,
                );
                if (index === -1) {
                  return;
                }
                metadata.lastCompletedIndex = Math.max(
                  metadata.lastCompletedIndex,
                  index,
                );
                if (metadata.nextStepIndex <= index) {
                  metadata.nextStepIndex = index + 1;
                }
                await planStateStore?.rememberPlanMetadata(
                  payload.planId,
                  metadata,
                );
              });
            }
            stepRegistry.delete(key);
            clearApprovals(payload.planId, payload.stepId);
            await planStateStore?.forgetStep(payload.planId, payload.stepId);
            prunePlanSubject(payload.planId);
            if (payload.state === "completed") {
              await releaseNextPlanSteps(payload.planId);
            }
          }

          await message.ack();
        },
      );
      completionConsumerReady = true;
    })().catch((error) => {
      completionConsumerSetupPromise = null;
      throw error;
    });
  }
  await completionConsumerSetupPromise;
}

async function setupStepConsumer(): Promise<void> {
  if (stepConsumerReady) {
    return;
  }
  if (!stepConsumerSetupPromise) {
    stepConsumerSetupPromise = (async () => {
      const adapter = await getQueueAdapter();
      await adapter.consume<unknown>(PLAN_STEPS_QUEUE, async (message) => {
        let payload: PlanStepTaskPayload;
        try {
          payload = message.payload as PlanStepTaskPayload;
        } catch (error) {
          console.error("plan.step.invalid_payload", error);
          await message.ack();
          return;
        }

        const job: PlanJob = {
          ...payload,
          attempt: Math.max(payload.attempt ?? 0, message.attempts ?? 0),
        };
        const planId = job.planId;
        const step = payload.step;
        const traceId =
          job.traceId || message.headers["trace-id"] || message.id;
        const invocationId = randomUUID();
        const key = `${planId}:${step.id}`;

        await withSpan(
          "queue.plan_step.process",
          async (span) => {
            span.setAttribute("queue", PLAN_STEPS_QUEUE);
            span.setAttribute("plan.id", planId);
            span.setAttribute("plan.id_length", planId.length);
            span.setAttribute("plan.step_id", step.id);
            span.setAttribute("queue.attempt", job.attempt);
            span.setAttribute("trace.id", traceId);

            const entry = stepRegistry.get(key);
            const existingAttempt = entry?.job.attempt ?? -1;
            if (entry) {
              if (!entry.inFlight || existingAttempt < job.attempt) {
                entry.traceId = traceId;
                entry.job = job;
                entry.inFlight = true;
              } else {
                await message.ack();
                return;
              }
            } else {
              stepRegistry.set(key, { step, traceId, job, inFlight: true });
            }

            const startedAt = performance.now();
            type QueueResult =
              | "completed"
              | "failed"
              | "dead_lettered"
              | "retry"
              | "rejected";

            const recordResult = (result: QueueResult) => {
              const durationSeconds = (performance.now() - startedAt) / 1000;
              queueProcessingHistogram
                .labels(PLAN_STEPS_QUEUE)
                .observe(durationSeconds);
              queueResultCounter.labels(PLAN_STEPS_QUEUE, result).inc();
              span.setAttribute("queue.result", result);
              span.setAttribute("queue.duration_ms", durationSeconds * 1000);
            };

            const metadataSnapshot = await planStateStore?.getPlanMetadata(planId);
            if (metadataSnapshot) {
              const stepIndex = metadataSnapshot.steps.findIndex(
                (candidate) => candidate.step.id === step.id,
              );
              if (
                stepIndex !== -1 &&
                metadataSnapshot.lastCompletedIndex >= stepIndex
              ) {
                await message.ack();
                recordResult("completed");
                return;
              }
            }

            const persisted = await planStateStore?.getEntry(planId, step.id);
            if (persisted) {
              if (
                entry?.inFlight &&
                persisted.state === "running" &&
                persisted.attempt >= job.attempt
              ) {
                await message.ack();
                return;
              }
              await planStateStore?.setState(
                planId,
                step.id,
                "running",
                undefined,
                undefined,
                job.attempt,
              );
            }
            const subjectContext = job.subject ?? planSubjects.get(planId);
            if (job.subject) {
              planSubjects.set(planId, clonePlanSubject(job.subject));
              clearRetainedPlanSubject(planId);
            }
            if (!persisted) {
              await planStateStore?.rememberStep(planId, step, traceId, {
                initialState: "running",
                idempotencyKey: key,
                attempt: job.attempt,
                createdAt: job.createdAt,
                subject: subjectContext,
              });
            }

            await emitPlanEvent(planId, step, traceId, {
              state: "running",
              summary: "Dispatching tool agent",
              attempt: job.attempt,
            });

            const approvals = await ensureApprovals(planId, step.id);
            let policyDecision: PolicyDecision;
            try {
              policyDecision = await policyEnforcer.enforcePlanStep(step, {
                planId,
                traceId,
                approvals,
                subject: toPolicySubject(subjectContext),
              });
            } catch (error) {
              if (error instanceof PolicyViolationError) {
                logAuditEvent({
                  action: "plan.step.authorize",
                  outcome: "denied",
                  traceId,
                  agent: step.tool,
                  resource: "plan.step",
                  subject: planSubjectToAuditSubject(subjectContext),
                  details: {
                    planId,
                    stepId: step.id,
                    capability: step.capability,
                    deny: error.details,
                    error: error.message,
                  },
                });

                const summary =
                  error.details.length > 0
                    ? error.details
                        .map((entry) =>
                          entry.capability
                            ? `${entry.reason}:${entry.capability}`
                            : entry.reason,
                        )
                        .join("; ")
                    : error.message;

                await emitPlanEvent(planId, step, traceId, {
                  state: "rejected",
                  summary,
                  attempt: job.attempt,
                });
                stepRegistry.delete(key);
                clearApprovals(planId, step.id);
                await planStateStore?.forgetStep(planId, step.id);
                prunePlanSubject(planId);
                await message.ack();
                recordResult("rejected");
                return;
              }
              throw error;
            }

            if (!policyDecision.allow) {
              const summary =
                policyDecision.deny.length > 0
                  ? policyDecision.deny
                      .map((entry) =>
                        entry.capability
                          ? `${entry.reason}:${entry.capability}`
                          : entry.reason,
                      )
                      .join("; ")
                  : "Capability policy denied execution";
              await emitPlanEvent(planId, step, traceId, {
                state: "rejected",
                summary,
                attempt: job.attempt,
              });
              stepRegistry.delete(key);
              clearApprovals(planId, step.id);
              await planStateStore?.forgetStep(planId, step.id);
              prunePlanSubject(planId);
              await message.ack();
              recordResult("rejected");
              return;
            }

            try {
              const client = getToolAgentClient();
              const events = await client.executeTool(
                {
                  invocationId,
                  planId,
                  stepId: step.id,
                  tool: step.tool,
                  capability: step.capability,
                  capabilityLabel: step.capabilityLabel,
                  labels: step.labels,
                  timeoutSeconds: step.timeoutSeconds,
                  approvalRequired: step.approvalRequired,
                  input: step.input,
                  metadata: step.metadata ?? {},
                },
                {
                  timeoutMs:
                    step.timeoutSeconds > 0
                      ? step.timeoutSeconds * 1000
                      : undefined,
                  metadata: { "trace-id": traceId },
                },
              );

              if (events.length > 0) {
                await publishToolEvents(planId, step, traceId, job, events);
              } else {
                await emitPlanEvent(planId, step, traceId, {
                  state: "completed",
                  summary: "Tool completed",
                  attempt: job.attempt,
                });
              }

              const terminalEvent = [...events]
                .reverse()
                .find((event) => TERMINAL_STATES.has(event.state));
              const terminalState = (terminalEvent?.state ??
                "completed") as QueueResult;

              stepRegistry.delete(key);
              clearApprovals(planId, step.id);
              await planStateStore?.forgetStep(planId, step.id);
              prunePlanSubject(planId);

              await message.ack();
              recordResult(
                terminalState === "rejected" ? "rejected" : terminalState,
              );
              if (terminalState === "completed") {
                await withPlanMetadataLock(planId, async () => {
                  const metadata = await planStateStore?.getPlanMetadata(planId);
                  if (!metadata) {
                    return;
                  }
                  const index = metadata.steps.findIndex(
                    (entry) => entry.step.id === step.id,
                  );
                  if (index === -1) {
                    return;
                  }
                  metadata.lastCompletedIndex = Math.max(
                    metadata.lastCompletedIndex,
                    index,
                  );
                  if (metadata.nextStepIndex <= index) {
                    metadata.nextStepIndex = index + 1;
                  }
                  await planStateStore?.rememberPlanMetadata(planId, metadata);
                });
                try {
                  await releaseNextPlanSteps(planId);
                } catch (error) {
                  console.error("plan.step.release_failed", {
                    planId,
                    stepId: step.id,
                    error,
                  });
                }
              }
            } catch (error) {
              const toolError =
                error instanceof ToolClientError
                  ? error
                  : new ToolClientError(
                      error instanceof Error
                        ? error.message
                        : "Tool execution failed",
                      {
                        retryable: false,
                        cause: error,
                      },
                    );

              if (toolError.retryable && job.attempt < MAX_RETRIES) {
                await emitPlanEvent(planId, step, traceId, {
                  state: "retrying",
                  summary: `Retry scheduled (attempt ${job.attempt + 1}/${MAX_RETRIES}): ${toolError.message}`,
                  attempt: job.attempt,
                });
                const delayMs = computeRetryDelayMs(job.attempt);
                if (delayMs !== undefined) {
                  await message.retry({ delayMs });
                } else {
                  await message.retry();
                }
                const nextAttempt = job.attempt + 1;
                job.attempt = nextAttempt;
                const entry = stepRegistry.get(key);
                if (entry) {
                  entry.inFlight = false;
                  entry.job = job;
                  entry.traceId = traceId;
                } else {
                  stepRegistry.set(key, { step, traceId, job, inFlight: false });
                }
                await planStateStore?.setState(
                  planId,
                  step.id,
                  "queued",
                  undefined,
                  undefined,
                  nextAttempt,
                );
                await emitPlanEvent(planId, step, traceId, {
                  state: "queued",
                  summary: `Retry enqueued (attempt ${nextAttempt}/${MAX_RETRIES})`,
                  attempt: nextAttempt,
                });
                recordResult("retry");
                return;
              }

              if (toolError.retryable) {
                const reason = `Retries exhausted after ${job.attempt} attempts: ${toolError.message}`;
                await emitPlanEvent(planId, step, traceId, {
                  state: "dead_lettered",
                  summary: reason,
                  attempt: job.attempt,
                });
                await message.deadLetter({ reason });
                stepRegistry.delete(key);
                clearApprovals(planId, step.id);
                await planStateStore?.forgetStep(planId, step.id);
                prunePlanSubject(planId);
                recordResult("dead_lettered");
                return;
              }

              await emitPlanEvent(planId, step, traceId, {
                state: "failed",
                summary: toolError.message,
                attempt: job.attempt,
              });
              stepRegistry.delete(key);
              clearApprovals(planId, step.id);
              await planStateStore?.forgetStep(planId, step.id);
              prunePlanSubject(planId);
              await message.ack();
              recordResult("failed");
            }
          },
          {
            queue: PLAN_STEPS_QUEUE,
            "plan.id": planId,
            "plan.step_id": step.id,
            traceId,
            attempt: job.attempt,
          },
        );
      });
      stepConsumerReady = true;
    })().catch((error) => {
      stepConsumerSetupPromise = null;
      throw error;
    });
  }
  await stepConsumerSetupPromise;
}

async function rehydratePendingSteps(): Promise<void> {
  const pending = await planStateStore?.listActiveSteps();
  if (!pending) {
    return;
  }
  for (const entry of pending) {
    const key = `${entry.planId}:${entry.stepId}`;
    const job: PlanJob = {
      planId: entry.planId,
      step: entry.step,
      attempt: entry.attempt,
      createdAt: entry.createdAt,
      traceId: entry.traceId,
    };
    stepRegistry.set(key, {
      step: entry.step,
      traceId: entry.traceId,
      job,
      inFlight: false,
    });
    cacheApprovals(entry.planId, entry.stepId, entry.approvals ?? {});
    if (entry.subject) {
      planSubjects.set(entry.planId, clonePlanSubject(entry.subject));
      clearRetainedPlanSubject(entry.planId);
    }
    if (entry.state === "running") {
      await planStateStore?.setState(
        entry.planId,
        entry.stepId,
        "queued",
        entry.summary,
        entry.output,
        entry.attempt,
      );
    }
    publishPlanStepEvent({
      event: "plan.step",
      traceId: entry.traceId,
      planId: entry.planId,
      occurredAt: entry.updatedAt,
      step: {
        id: entry.stepId,
        action: entry.step.action,
        tool: entry.step.tool,
        state: entry.state,
        capability: entry.step.capability,
        capabilityLabel: entry.step.capabilityLabel,
        labels: entry.step.labels,
        timeoutSeconds: entry.step.timeoutSeconds,
        approvalRequired: entry.step.approvalRequired,
        attempt: entry.attempt,
        summary: entry.summary,
        output: entry.output as Record<string, unknown> | undefined,
        approvals: entry.approvals,
      },
    });
  }

  const plans = await planStateStore?.listPlanMetadata();
  if (plans) {
    for (const metadata of plans) {
      await releaseNextPlanSteps(metadata.planId);
    }
  }
}

function toPolicySubject(subject?: PlanSubject) {
  if (!subject) {
    return undefined;
  }
  return {
    tenant: subject.tenantId,
    sessionId: subject.sessionId,
    roles: subject.roles,
    scopes: subject.scopes,
    user: {
      id: subject.userId,
      email: subject.email,
      name: subject.name,
    },
  };
}

function prunePlanSubject(planId: string): void {
  if (!planSubjects.has(planId)) {
    return;
  }
  for (const key of stepRegistry.keys()) {
    if (key.startsWith(`${planId}:`)) {
      return;
    }
  }
  const subject = planSubjects.get(planId);
  planSubjects.delete(planId);
  if (subject) {
    retainCompletedPlanSubject(planId, subject);
  }
}

export async function getPlanSubject(
  planId: string,
): Promise<PlanSubject | undefined> {
  const cached = planSubjects.get(planId);
  if (cached) {
    return clonePlanSubject(cached);
  }
  const store = planStateStore;
  if (!store) {
    return getRetainedPlanSubject(planId);
  }
  const pending = await store.listActiveSteps();
  if (!pending) {
    return getRetainedPlanSubject(planId);
  }
  for (const entry of pending) {
    if (entry.planId !== planId) {
      continue;
    }
    if (!entry.subject) {
      continue;
    }
    const subject = clonePlanSubject(entry.subject);
    planSubjects.set(planId, subject);
    clearRetainedPlanSubject(planId);
    return subject;
  }
  return getRetainedPlanSubject(planId);
}
