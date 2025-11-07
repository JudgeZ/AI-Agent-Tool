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
import { createPlanStateStore, type PlanStateStore } from "./PlanStateStore.js";
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
const planStateStoreOptions = planStateRetentionMs
  ? { retentionMs: planStateRetentionMs }
  : undefined;

const stepRegistry = new Map<
  string,
  { step: PlanStep; traceId: string; job: PlanJob }
>();
const approvalCache = new Map<string, Record<string, boolean>>();
const planSubjects = new Map<string, PlanSubject>();
const retainedPlanSubjects = new Map<
  string,
  { subject: PlanSubject; timeout?: NodeJS.Timeout }
>();

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
let planStateStore: PlanStateStore | null = createPlanStateStore(
  planStateStoreOptions,
);
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
  retainedPlanSubjects.forEach(({ timeout }) => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
  retainedPlanSubjects.clear();
  resetToolAgentClient();
  planStateStore = createPlanStateStore(planStateStoreOptions);
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
  const adapter = await getQueueAdapter();

  if (subject) {
    planSubjects.set(plan.id, clonePlanSubject(subject));
    clearRetainedPlanSubject(plan.id);
  } else {
    planSubjects.delete(plan.id);
    clearRetainedPlanSubject(plan.id);
  }

  const submissions = plan.steps.map(async (step) => {
    const key = `${plan.id}:${step.id}`;
    const activeSubject = subject ?? planSubjects.get(plan.id);
    const job: PlanJob = {
      planId: plan.id,
      step,
      attempt: 0,
      createdAt: new Date().toISOString(),
      traceId,
      subject: activeSubject
        ? {
            ...activeSubject,
            roles: [...activeSubject.roles],
            scopes: [...activeSubject.scopes],
          }
        : undefined,
    };
    const approvals = await ensureApprovals(plan.id, step.id);
    let decision: PolicyDecision;
    try {
      decision = await policyEnforcer.enforcePlanStep(step, {
        planId: plan.id,
        traceId,
        approvals,
        subject: toPolicySubject(activeSubject),
      });
    } catch (error) {
      if (error instanceof PolicyViolationError) {
        logAuditEvent({
          action: "plan.step.authorize",
          outcome: "denied",
          traceId,
          agent: step.tool,
          resource: "plan.step",
          subject: planSubjectToAuditSubject(activeSubject),
          details: {
            planId: plan.id,
            stepId: step.id,
            capability: step.capability,
            deny: error.details,
            error: error.message,
          },
        });
      }
      throw error;
    }
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
        subject: planSubjectToAuditSubject(activeSubject),
        details: {
          planId: plan.id,
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

    stepRegistry.set(key, { step, traceId, job });
    const initialState = step.approvalRequired ? "waiting_approval" : "queued";
    await planStateStore?.rememberStep(plan.id, step, traceId, {
      initialState,
      idempotencyKey: key,
      attempt: job.attempt,
      createdAt: job.createdAt,
      approvals,
      subject: activeSubject,
    });
    if (step.approvalRequired) {
      await emitPlanEvent(plan.id, step, traceId, {
        state: "waiting_approval",
        summary: "Awaiting approval",
        attempt: job.attempt,
      });
      return;
    }

    cacheApprovals(plan.id, step.id, approvals);

    try {
      await adapter.enqueue<PlanStepTaskPayload>(
        PLAN_STEPS_QUEUE,
        { ...job },
        {
          idempotencyKey: key,
          headers: { "trace-id": traceId },
        },
      );
    } catch (error) {
      const summary =
        error instanceof Error ? error.message : "Failed to enqueue plan step";
      await emitPlanEvent(plan.id, step, traceId, {
        state: "failed",
        summary,
        attempt: job.attempt,
      });
      throw error;
    }
    await emitPlanEvent(plan.id, step, traceId, {
      state: "queued",
      summary: "Queued for execution",
      attempt: job.attempt,
    });
  });

  await Promise.all(submissions);
  const depth = await adapter.getQueueDepth(PLAN_STEPS_QUEUE);
  queueDepthGauge.labels(PLAN_STEPS_QUEUE).set(depth);
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
      metadata = { step: persisted.step, traceId: persisted.traceId, job };
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
  const policyDecision = await policyEnforcer.enforcePlanStep(step, {
    planId,
    traceId,
    approvals: updatedApprovals,
    subject: toPolicySubject(subjectContext),
  });

  if (!policyDecision.allow) {
    const rejectionSummary = policyDecision.deny.length
      ? `Approval denied by policy: ${policyDecision.deny
          .map((entry) =>
            entry.capability
              ? `${entry.reason}:${entry.capability}`
              : entry.reason,
          )
          .join("; ")}`
      : "Approval denied by policy";
    await emitPlanEvent(planId, step, traceId, {
      state: "rejected",
      summary: rejectionSummary,
      attempt: job.attempt,
    });
    stepRegistry.delete(key);
    clearApprovals(planId, stepId);
    await planStateStore?.forgetStep(planId, stepId);
    prunePlanSubject(planId);

    throw new PolicyViolationError(
      `Approval denied by policy for plan ${planId} step ${stepId}`,
      policyDecision.deny,
    );
  }

  cacheApprovals(planId, stepId, updatedApprovals);
  await planStateStore?.recordApproval(planId, stepId, step.capability, true);

  const adapter = await getQueueAdapter();

  await emitPlanEvent(planId, step, traceId, {
    state: "approved",
    summary: decisionSummary,
    attempt: job.attempt,
  });
  const refreshedJob: PlanJob = {
    ...job,
    createdAt: new Date().toISOString(),
  };
  metadata.job = refreshedJob;

  await adapter.enqueue<PlanStepTaskPayload>(
    PLAN_STEPS_QUEUE,
    { ...refreshedJob },
    {
      idempotencyKey: key,
      headers: { "trace-id": traceId },
    },
  );

  await emitPlanEvent(planId, step, traceId, {
    state: "queued",
    summary: decisionSummary,
    attempt: refreshedJob.attempt,
  });

  const depth = await adapter.getQueueDepth(PLAN_STEPS_QUEUE);
  queueDepthGauge.labels(PLAN_STEPS_QUEUE).set(depth);
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
            stepRegistry.delete(key);
            clearApprovals(payload.planId, payload.stepId);
            await planStateStore?.forgetStep(payload.planId, payload.stepId);
            prunePlanSubject(payload.planId);
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
            span.setAttribute("plan.step_id", step.id);
            span.setAttribute("queue.attempt", job.attempt);
            span.setAttribute("trace.id", traceId);

            const entry = stepRegistry.get(key);
            if (entry) {
              entry.traceId = traceId;
              entry.job = job;
            } else {
              stepRegistry.set(key, { step, traceId, job });
            }

            const persisted = await planStateStore?.getEntry(planId, step.id);
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

            const approvals = await ensureApprovals(planId, step.id);
            const policyDecision = await policyEnforcer.enforcePlanStep(step, {
              planId,
              traceId,
              approvals,
              subject: toPolicySubject(subjectContext),
            });

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
    stepRegistry.set(key, { step: entry.step, traceId: entry.traceId, job });
    cacheApprovals(entry.planId, entry.stepId, entry.approvals ?? {});
    if (entry.subject) {
      planSubjects.set(entry.planId, clonePlanSubject(entry.subject));
      clearRetainedPlanSubject(entry.planId);
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
