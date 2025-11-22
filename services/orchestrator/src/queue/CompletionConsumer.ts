import { context as otelContext, propagation, type TextMapGetter } from "@opentelemetry/api";
import { isDeepStrictEqual } from "node:util";

import { normalizeError, appLogger } from "../observability/logger.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";
import { publishPlanStepEvent, getLatestPlanStepEvent } from "../plan/events.js";

import type { QueueAdapter } from "./QueueAdapter.js";
import type { PlanStateService } from "../services/PlanStateService.js";
import type { PlanStepCompletionPayload } from "./types.js";
import type { PlanStep, PlanSubject } from "../plan/planner.js";
import type { ToolEvent } from "../plan/validation.js";

export const PLAN_COMPLETIONS_QUEUE = "plan.completions";

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

function clonePlanSubject(subject: PlanSubject): PlanSubject {
  return {
    ...subject,
    roles: [...subject.roles],
    scopes: [...subject.scopes],
  };
}

export class CompletionConsumer {
  private readonly logger = appLogger.child({ component: "completion-consumer" });
  private stopped = false;
  
  constructor(
    private readonly queueAdapter: QueueAdapter,
    private readonly stateService: PlanStateService,
    private readonly config: { contentCaptureEnabled: boolean },
    private readonly onStepCompletion?: (planId: string) => Promise<void>
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.queueAdapter.consume<PlanStepCompletionPayload>(
      PLAN_COMPLETIONS_QUEUE,
      async (message) => {
        if (this.stopped) return;
        const headerCarrier = normalizeHeaders(message.headers);
        const parentContext = propagation.extract(
          otelContext.active(),
          headerCarrier,
          propagationGetter,
        );
        await otelContext.with(parentContext, async () => {
            try {
                await this.processMessage(message);
            } catch (error) {
                this.logger.error({ err: normalizeError(error) }, "Unexpected error processing completion message");
                await message.retry().catch(err =>
                    this.logger.error({ err: normalizeError(err) }, "Failed to retry completion message after error")
                );
            }
        });
      }
    );
  }

  stop(): void {
    this.stopped = true;
  }

  private async processMessage(message: any): Promise<void> {
      if (this.stopped) return;
      const payload = message.payload as PlanStepCompletionPayload;
      // ...
      // (rest of the method same as previous write)
      const key = `${payload.planId}:${payload.stepId}`;
      const metadata = this.stateService.getRegistryEntry(payload.planId, payload.stepId);
      const persistedEntry = metadata
        ? undefined
        : await this.stateService.getEntry(payload.planId, payload.stepId);
      const subjectContext =
        metadata?.job.subject ??
        persistedEntry?.subject ??
        this.stateService.getPlanSubject(payload.planId);
      const expectedTraceId = metadata?.traceId ?? persistedEntry?.traceId ?? "";
      const receivedTraceId =
        payload.traceId ||
        message.headers["trace-id"] ||
        message.headers["traceId"] ||
        message.headers["Trace-Id"] ||
        "";
      const expectedIdempotencyKey = metadata
        ? key
        : persistedEntry?.idempotencyKey ?? "";
      const receivedIdempotencyKey =
        message.headers["x-idempotency-key"] ||
        message.headers["idempotency-key"] ||
        message.headers["Idempotency-Key"] ||
        "";
      const headerRequestId =
        payload.requestId ||
        message.headers["request-id"] ||
        message.headers["requestId"] ||
        message.headers["Request-Id"] ||
        "";
      const headerRequest =
        headerRequestId.length > 0 ? headerRequestId : undefined;
      const expectedRequestId =
        metadata?.requestId ??
        metadata?.job.requestId ??
        persistedEntry?.requestId ??
        headerRequest;

      if (!metadata && !persistedEntry) {
        this.logger.warn(
          {
            planId: payload.planId,
            stepId: payload.stepId,
            messageId: message.id,
            event: "plan.completion.unknown_step",
          },
          "Received completion for unknown step",
        );
        logAuditEvent({
          action: "plan.step.completion",
          outcome: "denied",
          traceId: receivedTraceId || message.id,
          requestId: expectedRequestId,
          resource: "plan.step",
          subject: planSubjectToAuditSubject(subjectContext),
          details: {
            planId: payload.planId,
            stepId: payload.stepId,
            messageId: message.id,
            reason: "unknown_step",
          },
        });
        await message.deadLetter({ reason: "unknown_step" });
        return;
      }

      const expectedTracePresent = expectedTraceId.length > 0;
      const expectedIdempotencyPresent =
        expectedIdempotencyKey.length > 0;
      const receivedTracePresent = receivedTraceId.length > 0;
      const receivedIdempotencyPresent =
        receivedIdempotencyKey.length > 0;

      let enforceMetadata = false;
      let metadataMatches = true;

      if (expectedTracePresent && expectedIdempotencyPresent) {
        enforceMetadata = true;
        metadataMatches =
          receivedTracePresent &&
          receivedIdempotencyPresent &&
          expectedTraceId === receivedTraceId &&
          expectedIdempotencyKey === receivedIdempotencyKey;
      } else {
        if (expectedTracePresent) {
          enforceMetadata = true;
          metadataMatches =
            metadataMatches &&
            receivedTracePresent &&
            expectedTraceId === receivedTraceId;
        }
        if (expectedIdempotencyPresent) {
          enforceMetadata = true;
          metadataMatches =
            metadataMatches &&
            receivedIdempotencyPresent &&
            expectedIdempotencyKey === receivedIdempotencyKey;
        }
      }

      if (enforceMetadata && !metadataMatches) {
        this.logger.warn(
          {
            planId: payload.planId,
            stepId: payload.stepId,
            messageId: message.id,
            expectedTraceId,
            receivedTraceId,
            expectedIdempotencyKey,
            receivedIdempotencyKey,
            receivedIdempotencyPresent,
            event: "plan.completion.metadata_mismatch",
          },
          "Plan completion metadata mismatch detected",
        );
        logAuditEvent({
          action: "plan.step.completion",
          outcome: "denied",
          traceId: expectedTraceId || receivedTraceId || message.id,
          requestId: expectedRequestId,
          resource: "plan.step",
          subject: planSubjectToAuditSubject(subjectContext),
          details: {
            planId: payload.planId,
            stepId: payload.stepId,
            messageId: message.id,
            reason: "metadata_mismatch",
            expectedTraceId: expectedTraceId || undefined,
            receivedTraceId: receivedTraceId || undefined,
            expectedIdempotencyKey:
              expectedIdempotencyKey || undefined,
            receivedIdempotencyKey:
              receivedIdempotencyKey || undefined,
          },
        });
        await message.deadLetter({ reason: "metadata_mismatch" });
        return;
      }

      const baseStep = metadata?.step ?? persistedEntry?.step;
      const persistedApprovals = metadata
        ? undefined
        : persistedEntry?.approvals;
      
      if (!metadata && persistedApprovals) {
        this.stateService.cacheApprovals(payload.planId, payload.stepId, persistedApprovals);
      }
      const approvals = payload.approvals ?? persistedApprovals;

      const attempt =
        payload.attempt ??
        metadata?.job.attempt ??
        persistedEntry?.attempt ??
        0;
      const traceId =
        expectedTraceId || receivedTraceId || message.id;

      await this.emitPlanEvent(
        payload.planId, 
        payload.stepId, 
        traceId, 
        expectedRequestId, 
        {
          state: payload.state,
          summary: payload.summary,
          output: payload.output as Record<string, unknown> | undefined,
          attempt,
          occurredAt: payload.occurredAt,
        }, 
        baseStep,
        approvals
      );

      const TERMINAL_STATES = new Set<ToolEvent["state"]>(["completed", "failed", "dead_lettered", "rejected"]);
      if (TERMINAL_STATES.has(payload.state)) {
        if (payload.state === "completed") {
          await this.stateService.withPlanLock(payload.planId, async () => {
            const metadata = await this.stateService.getPlanMetadata(
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
            await this.stateService.rememberPlanMetadata(
              payload.planId,
              metadata,
            );
          });
          
          // Trigger release of next steps
          if (this.onStepCompletion) {
            await this.onStepCompletion(payload.planId).catch(err => {
                this.logger.error({ err: normalizeError(err), planId: payload.planId }, "Failed to release next steps");
            });
          }
        }
        this.stateService.deleteRegistryEntry(payload.planId, payload.stepId);
        this.stateService.clearApprovals(payload.planId, payload.stepId);
        await this.stateService.forgetStep(payload.planId, payload.stepId);
        this.prunePlanSubject(payload.planId);
      }

      await message.ack();
  }

  private async emitPlanEvent(
      planId: string,
      stepId: string,
      traceId: string,
      requestId: string | undefined,
      update: Partial<ToolEvent> & {
        state: ToolEvent["state"];
        summary?: string;
        output?: Record<string, unknown>;
        attempt?: number;
      },
      baseStep?: PlanStep,
      approvals?: Record<string, boolean>
    ): Promise<void> {
      const sanitizedOutput = this.config.contentCaptureEnabled ? update.output : undefined;
      await this.stateService.setState(
        planId,
        stepId,
        update.state,
        update.summary,
        sanitizedOutput,
        update.attempt,
      );
      const latest = getLatestPlanStepEvent(planId, stepId);
      if (latest && latest.step.state === update.state) {
        const summariesMatch =
          update.summary === undefined
            ? latest.step.summary === undefined
            : latest.step.summary === update.summary;
        const outputsMatch = this.config.contentCaptureEnabled
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
      if (!baseStep) {
          return;
      }
      publishPlanStepEvent({
        event: "plan.step",
        traceId,
        requestId,
        planId,
        occurredAt: update.occurredAt ?? new Date().toISOString(),
        step: {
          id: baseStep.id,
          action: baseStep.action,
          tool: baseStep.tool,
          state: update.state,
          capability: baseStep.capability,
          capabilityLabel: baseStep.capabilityLabel,
          labels: baseStep.labels,
          timeoutSeconds: baseStep.timeoutSeconds,
          approvalRequired: baseStep.approvalRequired,
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
}
