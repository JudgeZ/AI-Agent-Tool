import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { context as otelContext, propagation, type TextMapGetter } from "@opentelemetry/api";

import { normalizeError, appLogger } from "../observability/logger.js";
import { withSpan } from "../observability/tracing.js";
import {
  queueDepthGauge,
  queueProcessingHistogram,
  queueResultCounter,
} from "../observability/metrics.js";
import { getToolAgentClient, ToolClientError } from "../grpc/AgentClient.js";
import { publishPlanStepEvent, getLatestPlanStepEvent } from "../plan/events.js";
import { PolicyViolationError, type PolicyEnforcer, type PolicyDecision } from "../policy/PolicyEnforcer.js";

import type { QueueAdapter } from "./QueueAdapter.js";
import type { PlanStateService } from "../services/PlanStateService.js";
import type { PlanJob, ToolEvent } from "../plan/validation.js";
import type { PlanStep, PlanSubject } from "../plan/planner.js";
import type { PlanStepTaskPayload } from "./types.js";

export const PLAN_STEPS_QUEUE = "plan.steps";

const propagationGetter: TextMapGetter<Record<string, string>> = {
  keys: carrier => Object.keys(carrier),
  get: (carrier, key) => {
    const direct = carrier[key];
    if (typeof direct === "string") {
      return direct;
    }
    const lower = carrier[key.toLowerCase()];
    if (typeof lower === "string") {
      return lower;
    }
    const upper = carrier[key.toUpperCase()];
    if (typeof upper === "string") {
      return upper;
    }
    return undefined;
  },
};

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  const carrier: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (typeof rawValue !== "string" || rawValue.length === 0) {
      continue;
    }
    carrier[rawKey] = rawValue;
    const lower = rawKey.toLowerCase();
    if (!(lower in carrier)) {
      carrier[lower] = rawValue;
    }
  }
  return carrier;
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

export class StepConsumer {
  private readonly logger = appLogger.child({ component: "step-consumer" });
  private stopped = false;

  constructor(
    private readonly queueAdapter: QueueAdapter,
    private readonly stateService: PlanStateService,
    private readonly policyEnforcer: PolicyEnforcer,
    private readonly config: { maxRetries: number; retryBackoffBaseMs?: number; contentCaptureEnabled: boolean },
    private readonly onStepCompletion?: (planId: string) => Promise<void>
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.queueAdapter.consume<unknown>(PLAN_STEPS_QUEUE, async (message) => {
      if (this.stopped) return;
      const headerCarrier = normalizeHeaders(message.headers);
      const parentContext = propagation.extract(
        otelContext.active(),
        headerCarrier,
        propagationGetter,
      );
      await otelContext.with(parentContext, async () => {
        let payload: PlanStepTaskPayload;
        try {
          payload = message.payload as PlanStepTaskPayload;
        } catch (error) {
          this.logger.error(
            { err: normalizeError(error), event: "plan.step.invalid_payload" },
            "Received invalid plan step payload",
          );
          await message.ack();
          return;
        }

        const job: PlanJob = {
          ...payload,
          attempt: Math.max(payload.attempt ?? 0, message.attempts ?? 0),
        };
        await this.processJob(job, message);
      });
    });
  }

  stop(): void {
    this.stopped = true;
  }

  private async processJob(job: PlanJob, message: any): Promise<void> {
    if (this.stopped) return;
    const planId = job.planId;
    const step = job.step;
    const traceId = job.traceId || message.headers["trace-id"] || message.id;
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

        const entry = this.stateService.getRegistryEntry(planId, step.id);
        const existingAttempt = entry?.job.attempt ?? -1;
        if (entry) {
          if (!entry.inFlight || existingAttempt < job.attempt) {
            entry.traceId = traceId;
            entry.job = job;
            if (job.requestId) {
              entry.requestId = job.requestId;
            }
            entry.inFlight = true;
          } else {
            await message.ack();
            return;
          }
        } else {
          this.stateService.setRegistryEntry(planId, step.id, {
            step,
            traceId,
            requestId: job.requestId,
            job,
            inFlight: true,
          });
        }

        const startedAt = performance.now();
        const recordResult = (result: string) => {
          const durationSeconds = (performance.now() - startedAt) / 1000;
          queueProcessingHistogram
            .labels(PLAN_STEPS_QUEUE)
            .observe(durationSeconds);
          queueResultCounter.labels(PLAN_STEPS_QUEUE, result).inc();
          span.setAttribute("queue.result", result);
        };

        try {
            await this.executeStep(job, step, planId, traceId, key, message, invocationId);
            recordResult("completed");
        } catch (error) {
             this.logger.error({ err: normalizeError(error) }, "Unexpected error in processJob");
             recordResult("failed");
             await message.retry().catch((err: unknown) => 
                this.logger.error({ err: normalizeError(err) }, "Failed to retry message after processing error")
             );
        }
      }
    );
  }

  private async executeStep(
    job: PlanJob, 
    step: PlanStep, 
    planId: string, 
    traceId: string, 
    key: string, 
    message: any, 
    invocationId: string
  ): Promise<void> {
      if (this.stopped) return;
      const metadataSnapshot = await this.stateService.getPlanMetadata(planId);
      if (metadataSnapshot) {
        const stepIndex = metadataSnapshot.steps.findIndex(
          (candidate) => candidate.step.id === step.id,
        );
        if (
          stepIndex !== -1 &&
          metadataSnapshot.lastCompletedIndex >= stepIndex
        ) {
          await message.ack();
          return;
        }
      }

      const persisted = await this.stateService.getEntry(planId, step.id);
      if (persisted) {
        const entry = this.stateService.getRegistryEntry(planId, step.id);
        if (
          entry?.inFlight &&
          persisted.state === "running" &&
          persisted.attempt >= job.attempt
        ) {
          await message.ack();
          return;
        }
        await this.stateService.setState(
          planId,
          step.id,
          "running",
          undefined,
          undefined,
          job.attempt,
        );
      }
      const subjectContext = job.subject ?? this.stateService.getPlanSubject(planId);
      if (job.subject) {
        this.stateService.setPlanSubject(planId, job.subject);
        this.stateService.clearRetainedPlanSubject(planId);
      }
      if (!persisted) {
        await this.stateService.rememberStep(planId, step, traceId, {
          initialState: "running",
          idempotencyKey: key,
          attempt: job.attempt,
          createdAt: job.createdAt,
          requestId: job.requestId,
          subject: subjectContext,
        });
      }

      // Fetch approvals before emitting event so we can include them?
      // But emitting "running" usually doesn't need approvals list.
      // However, if we want consistency...
      const approvals = await this.stateService.ensureApprovals(planId, step.id);

      await this.emitPlanEvent(planId, step, traceId, job.requestId, {
        state: "running",
        summary: "Dispatching tool agent",
        attempt: job.attempt,
      }, approvals);

      let policyDecision: PolicyDecision;
      try {
        policyDecision = await this.policyEnforcer.enforcePlanStep(step, {
          planId,
          traceId,
          approvals,
          subject: toPolicySubject(subjectContext),
        });
      } catch (error) {
        if (error instanceof PolicyViolationError) {
            this.logger.warn({ err: error }, "Policy violation during execution");
            await this.handleRejection(planId, step, traceId, job, key, message, error.message, error.details, approvals);
            return;
        }
        throw error;
      }

      if (!policyDecision.allow) {
          const summary = policyDecision.deny.length > 0
            ? policyDecision.deny.map(d => d.reason).join("; ")
            : "Capability policy denied execution";
          await this.handleRejection(planId, step, traceId, job, key, message, summary, policyDecision.deny, approvals);
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
                timeoutMs: step.timeoutSeconds > 0 ? step.timeoutSeconds * 1000 : undefined,
                metadata: { "trace-id": traceId },
            }
        );

        if (events.length > 0) {
            for (const event of events) {
                await this.emitPlanEvent(planId, step, traceId, job.requestId, {
                    state: event.state,
                    summary: event.summary,
                    occurredAt: event.occurredAt,
                    output: event.output as Record<string, unknown> | undefined,
                    attempt: job.attempt,
                }, approvals);
            }
        } else {
            await this.emitPlanEvent(planId, step, traceId, job.requestId, {
                state: "completed",
                summary: "Tool completed",
                attempt: job.attempt,
            }, approvals);
        }

        const TERMINAL_STATES = new Set<ToolEvent["state"]>(["completed", "failed", "dead_lettered", "rejected"]);
        const terminalEvent = [...events].reverse().find((event) => TERMINAL_STATES.has(event.state));
        const terminalState = terminalEvent?.state ?? "completed";

        this.stateService.deleteRegistryEntry(planId, step.id);
        this.stateService.clearApprovals(planId, step.id);
        await this.stateService.forgetStep(planId, step.id);
        this.prunePlanSubject(planId);
        await message.ack();

        if (terminalState === "completed") {
            await this.stateService.withPlanLock(planId, async () => {
                const metadata = await this.stateService.getPlanMetadata(planId);
                if (!metadata) return;
                const index = metadata.steps.findIndex(s => s.step.id === step.id);
                if (index === -1) return;
                metadata.lastCompletedIndex = Math.max(metadata.lastCompletedIndex, index);
                if (metadata.nextStepIndex <= index) {
                    metadata.nextStepIndex = index + 1;
                }
                await this.stateService.rememberPlanMetadata(planId, metadata);
            });
            
            if (this.onStepCompletion) {
                await this.onStepCompletion(planId).catch(err => {
                    this.logger.error({ err: normalizeError(err), planId }, "Failed to release next steps");
                });
            }
        }
      } catch (error) {
          await this.handleToolError(error, job, planId, step, traceId, key, message, approvals);
      }
  }

  private async handleRejection(
    planId: string, 
    step: PlanStep, 
    traceId: string, 
    job: PlanJob, 
    key: string, 
    message: any, 
    summary: string, 
    details?: any[],
    approvals?: Record<string, boolean>
  ) {
      await this.emitPlanEvent(planId, step, traceId, job.requestId, {
          state: "rejected",
          summary,
          attempt: job.attempt,
      }, approvals);
      this.stateService.deleteRegistryEntry(planId, step.id);
      this.stateService.clearApprovals(planId, step.id);
      await this.stateService.forgetStep(planId, step.id);
      this.prunePlanSubject(planId);
      await message.ack();
  }

  private async handleToolError(
    error: unknown, 
    job: PlanJob, 
    planId: string, 
    step: PlanStep, 
    traceId: string, 
    key: string, 
    message: any,
    approvals?: Record<string, boolean>
  ) {
      const toolError = error instanceof ToolClientError ? error : new ToolClientError(
          error instanceof Error ? error.message : "Tool execution failed",
          { retryable: false, cause: error }
      );

      if (toolError.retryable && job.attempt < this.config.maxRetries) {
          await this.emitPlanEvent(planId, step, traceId, job.requestId, {
              state: "retrying",
              summary: `Retry scheduled (attempt ${job.attempt + 1}/${this.config.maxRetries}): ${toolError.message}`,
              attempt: job.attempt,
          }, approvals);
          const delayMs = this.computeRetryDelayMs(job.attempt);
          if (delayMs !== undefined) {
              await message.retry({ delayMs });
          } else {
              await message.retry();
          }
          
          const nextAttempt = job.attempt + 1;
          job.attempt = nextAttempt;
          const entry = this.stateService.getRegistryEntry(planId, step.id);
          if (entry) {
              entry.inFlight = false;
              entry.job = job;
              entry.traceId = traceId;
          } else {
              this.stateService.setRegistryEntry(planId, step.id, { step, traceId, requestId: job.requestId, job, inFlight: false });
          }
          await this.stateService.setState(planId, step.id, "queued", undefined, undefined, nextAttempt);
          await this.emitPlanEvent(planId, step, traceId, job.requestId, {
              state: "queued",
              summary: `Retry enqueued (attempt ${nextAttempt}/${this.config.maxRetries})`,
              attempt: nextAttempt,
          }, approvals);
          return;
      }

      if (toolError.retryable) {
          const reason = `Retries exhausted after ${job.attempt} attempts: ${toolError.message}`;
          await this.emitPlanEvent(planId, step, traceId, job.requestId, {
              state: "dead_lettered",
              summary: reason,
              attempt: job.attempt,
          }, approvals);
          await message.deadLetter({ reason });
          this.stateService.deleteRegistryEntry(planId, step.id);
          this.stateService.clearApprovals(planId, step.id);
          await this.stateService.forgetStep(planId, step.id);
          this.prunePlanSubject(planId);
          return;
      }

      await this.emitPlanEvent(planId, step, traceId, job.requestId, {
          state: "failed",
          summary: toolError.message,
          attempt: job.attempt,
      }, approvals);
      this.stateService.deleteRegistryEntry(planId, step.id);
      this.stateService.clearApprovals(planId, step.id);
      await this.stateService.forgetStep(planId, step.id);
      this.prunePlanSubject(planId);
      await message.ack();
  }

  private async emitPlanEvent(
      planId: string,
      step: PlanStep,
      traceId: string,
      requestId: string | undefined,
      update: Partial<ToolEvent> & {
        state: ToolEvent["state"];
        summary?: string;
        output?: Record<string, unknown>;
        attempt?: number;
      },
      approvals?: Record<string, boolean>
    ): Promise<void> {
      const sanitizedOutput = this.config.contentCaptureEnabled ? update.output : undefined;
      await this.stateService.setState(
        planId,
        step.id,
        update.state,
        update.summary,
        sanitizedOutput,
        update.attempt,
      );
      const latest = getLatestPlanStepEvent(planId, step.id);
      publishPlanStepEvent({
        event: "plan.step",
        traceId,
        requestId,
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
          approvals,
        },
      });
    }

  private prunePlanSubject(planId: string): void {
    if (!this.stateService.hasPlanSubject(planId)) {
        return;
    }
    for (const key of this.stateService.getRegistryKeys()) {
        if (key.startsWith(`${planId}:`)) {
            return;
        }
    }
    const subject = this.stateService.getPlanSubject(planId);
    this.stateService.deletePlanSubject(planId);
    if (subject) {
        this.stateService.retainCompletedPlanSubject(planId, subject);
    }
  }

  private computeRetryDelayMs(attempt: number): number | undefined {
      if (!this.config.retryBackoffBaseMs) return undefined;
      const normalizedAttempt = Math.max(0, attempt);
      const multiplier = 2 ** normalizedAttempt;
      const rawDelay = this.config.retryBackoffBaseMs * multiplier;
      if (!Number.isFinite(rawDelay)) return Number.MAX_SAFE_INTEGER;
      return Math.min(rawDelay, Number.MAX_SAFE_INTEGER);
  }
}
