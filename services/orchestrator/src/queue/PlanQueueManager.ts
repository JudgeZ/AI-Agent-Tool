import { randomUUID } from "node:crypto";
import { propagation, context as otelContext } from "@opentelemetry/api";

import { appLogger, normalizeError } from "../observability/logger.js";
import { queueDepthGauge } from "../observability/metrics.js";
import { getDefaultTenantLabel } from "../observability/metrics.js";
import { loadConfig, type AppConfig } from "../config.js";
import { getQueueAdapter, type QueueAdapter } from "./QueueAdapter.js";
import { StepConsumer, PLAN_STEPS_QUEUE } from "./StepConsumer.js";
import { CompletionConsumer, PLAN_COMPLETIONS_QUEUE } from "./CompletionConsumer.js";
import { PlanStateService } from "../services/PlanStateService.js";
import { createPlanStateStore } from "./PlanStateStore.js";
import { getDistributedLockService } from "../services/DistributedLockService.js";
import { getPolicyEnforcer, PolicyViolationError } from "../policy/PolicyEnforcer.js";
import { getPostgresPool } from "../database/Postgres.js";
import { publishPlanStepEvent } from "../plan/events.js";
import { fileLockManager } from "../services/FileLockManager.js";

import type { Plan, PlanStep, PlanSubject } from "../plan/planner.js";
import type { PlanJob, ToolEvent } from "../plan/validation.js";
import type { ApprovalDecision, PlanStepTaskPayload } from "./types.js";

function clonePlanSubject(subject: PlanSubject): PlanSubject {
  return { ...subject, roles: [...subject.roles], scopes: [...subject.scopes] };
}

const propagationSetter: any = {
  set: (carrier: any, key: string, value: string) => {
    if (!value) return;
    carrier[key] = value;
  },
};

export class PlanQueueManager {
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  
  private stateService: PlanStateService | undefined;
  private stepConsumer!: StepConsumer;
  private completionConsumer!: CompletionConsumer;
  private queueAdapter: QueueAdapter | undefined;
  private readonly fileLockManager = fileLockManager;
  private readonly planSessions = new Map<string, string>();
  private readonly sessionRefCounts = new Map<string, number>();

  private config: AppConfig; // Remove readonly to allow updates
  private readonly queueLogger = appLogger.child({ component: "plan-queue-manager" });

  constructor() {
    this.config = loadConfig();
  }

  private async setupServices() {
    const pool = this.config.planState.backend === "postgres" ? getPostgresPool() : undefined;

    const lockRedisUrl =
      process.env.LOCK_REDIS_URL ??
      this.config.server.rateLimits.backend.redisUrl ??
      process.env.REDIS_URL ??
      "redis://localhost:6379";
    const lockService = await getDistributedLockService(lockRedisUrl);
    const store = createPlanStateStore({
        backend: this.config.planState.backend,
        retentionMs: this.config.retention.planStateDays > 0 ? this.config.retention.planStateDays * 24 * 60 * 60 * 1000 : undefined,
        pool: pool ?? undefined
    });

    this.stateService = new PlanStateService(store, lockService);
  }

  async initialize(): Promise<void> {
    if (this.initialized && this.stateService) return;
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = (async () => {
      try {
        if (!this.stateService) {
            await this.setupServices();
        }

        let attempts = 0;
        const maxAttempts = parseInt(process.env.QUEUE_INIT_MAX_ATTEMPTS ?? "5");
        const backoffMs = parseInt(process.env.QUEUE_INIT_BACKOFF_MS ?? "1000");

        while (true) {
          try {
            this.queueAdapter = await getQueueAdapter();
            break;
          } catch (err) {
            attempts++;
            if (attempts >= maxAttempts) {
              throw err;
            }
            this.queueLogger.warn(
              { err: normalizeError(err), attempt: attempts }, 
              "Failed to connect to queue adapter, retrying..."
            );
            if (backoffMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
          }
        }
        const policyEnforcer = getPolicyEnforcer();

        this.stepConsumer = new StepConsumer(this.queueAdapter, this.stateService!, policyEnforcer, {
            maxRetries: parseInt(process.env.QUEUE_RETRY_MAX ?? "5"),
            retryBackoffBaseMs: parseInt(process.env.QUEUE_RETRY_BACKOFF_MS ?? "0") || undefined,
            contentCaptureEnabled: this.config.retention.contentCapture.enabled
        }, (planId) => this.releaseNextPlanSteps(planId));

        this.completionConsumer = new CompletionConsumer(this.queueAdapter, this.stateService!, {
            contentCaptureEnabled: this.config.retention.contentCapture.enabled
        }, (planId) => this.releaseNextPlanSteps(planId));

        await Promise.all([
            this.stepConsumer.start(),
            this.completionConsumer.start(),
            this.rehydratePendingSteps()
        ]);
        
        this.initialized = true;
      } catch (error) {
          this.initializationPromise = null;
          throw error;
      }
    })();
    
    await this.initializationPromise;
  }

  // ... rest of methods ...
  async submitPlanSteps(plan: Plan, traceId: string, requestId?: string, subject?: PlanSubject): Promise<void> {
      await this.initialize();

    const sessionId = subject?.sessionId;
    let sessionTracked = false;
    try {
      if (sessionId) {
        this.planSessions.set(plan.id, sessionId);
        this.sessionRefCounts.set(sessionId, (this.sessionRefCounts.get(sessionId) ?? 0) + 1);
        sessionTracked = true;
        await this.fileLockManager.restoreSessionLocks(sessionId).catch((err) =>
          this.queueLogger.warn(
            { err: normalizeError(err), planId: plan.id, sessionId },
            "failed to restore session locks",
          ),
        );
      } else {
          this.planSessions.delete(plan.id);
      }

      if (subject) {
          this.stateService!.setPlanSubject(plan.id, subject);
          this.stateService!.clearRetainedPlanSubject(plan.id);
      } else {
          this.stateService!.deletePlanSubject(plan.id);
          this.stateService!.clearRetainedPlanSubject(plan.id);
      }

      const activeSubject = subject ?? this.stateService!.getPlanSubject(plan.id);
      const normalizedRequestId = requestId ?? randomUUID();
      const metadataSteps = plan.steps.map((step) => ({
        step,
        createdAt: new Date().toISOString(),
        attempt: 0,
        requestId: normalizedRequestId,
        subject: activeSubject ? clonePlanSubject(activeSubject) : undefined,
      }));

      await this.stateService!.withPlanLock(plan.id, async () => {
          await this.stateService!.rememberPlanMetadata(plan.id, {
            planId: plan.id,
            traceId,
            requestId: normalizedRequestId,
            steps: metadataSteps,
            nextStepIndex: 0,
            lastCompletedIndex: -1,
          });
      });

      await this.releaseNextPlanSteps(plan.id);
    } catch (error) {
      if (sessionId && sessionTracked) {
        const remaining = (this.sessionRefCounts.get(sessionId) ?? 1) - 1;
        if (remaining <= 0) {
          this.sessionRefCounts.delete(sessionId);
          await this.fileLockManager.releaseSessionLocks(sessionId).catch((err) =>
            this.queueLogger.warn(
              { err: normalizeError(err), planId: plan.id, sessionId },
              "failed to release session locks after submission failure",
            ),
          );
        } else {
          this.sessionRefCounts.set(sessionId, remaining);
        }
        this.planSessions.delete(plan.id);
      }
      throw error;
    }
  }

  async resolvePlanStepApproval(options: {
    planId: string;
    stepId: string;
    decision: ApprovalDecision;
    summary?: string;
  }): Promise<void> {
      const { planId, stepId, decision, summary } = options;
      await this.initialize();
      
      let metadata = this.stateService!.getRegistryEntry(planId, stepId);
      if (!metadata) {
          const persisted = await this.stateService!.getEntry(planId, stepId);
          if (persisted) {
               const job: PlanJob = {
                    planId: persisted.planId,
                    step: persisted.step,
                    attempt: persisted.attempt,
                    createdAt: persisted.createdAt,
                    traceId: persisted.traceId,
                    requestId: persisted.requestId,
               };
               metadata = {
                   step: persisted.step,
                   traceId: persisted.traceId,
                   requestId: persisted.requestId,
                   job,
                   inFlight: false
               };
               this.stateService!.setRegistryEntry(planId, stepId, metadata);
          }
      }

      if (!metadata) {
          throw new Error(`Plan step ${planId}/${stepId} is not available`);
      }

      const { step, traceId, job } = metadata;
      const requestId = metadata.requestId ?? job.requestId;
      const decisionSummary = summary ?? (decision === "approved" ? "Approved for execution" : "Step rejected");

      if (decision === "rejected") {
          await this.emitPlanEvent(planId, step, traceId, requestId, {
              state: "rejected",
              summary: decisionSummary,
              attempt: job.attempt,
          });
          this.stateService!.deleteRegistryEntry(planId, stepId);
          this.stateService!.clearApprovals(planId, stepId);
          await this.stateService!.forgetStep(planId, stepId);
          this.prunePlanSubject(planId);
          return;
      }

      const approvals = await this.stateService!.ensureApprovals(planId, stepId);
      const updatedApprovals = { ...approvals, [step.capability]: true };
      const subjectContext = metadata.job.subject ?? this.stateService!.getPlanSubject(planId);
      
      try {
        const policyEnforcer = getPolicyEnforcer();
        const decision = await policyEnforcer.enforcePlanStep(step, {
          planId,
          traceId,
          approvals: updatedApprovals,
          subject: this.toPolicySubject(subjectContext),
        });
        
        const blockingReasons = decision.deny.filter(reason => reason.reason !== "approval_required");
        if (!decision.allow && (blockingReasons.length > 0 || !step.approvalRequired)) {
             throw new PolicyViolationError(`Plan step ${step.id} for capability ${step.capability} is not permitted`, decision.deny);
        }
      } catch (error) {
           if (error instanceof PolicyViolationError) {
               const reason = error.details.map(d => d.reason).join("; ");
               await this.emitPlanEvent(planId, step, traceId, requestId, {
                   state: "rejected",
                   summary: reason,
                   attempt: job.attempt,
               });
               this.stateService!.deleteRegistryEntry(planId, stepId);
               this.stateService!.clearApprovals(planId, stepId);
               await this.stateService!.forgetStep(planId, stepId);
               this.prunePlanSubject(planId);
           }
           throw error;
      }

      this.stateService!.cacheApprovals(planId, stepId, updatedApprovals);
      await this.stateService!.recordApproval(planId, stepId, step.capability, true);

      await this.emitPlanEvent(planId, step, traceId, requestId, {
          state: "approved",
          summary: decisionSummary,
          attempt: job.attempt,
      });

      const refreshedJob: PlanJob = { ...job, createdAt: new Date().toISOString() };
      metadata.job = refreshedJob;
      metadata.requestId = requestId;
      this.stateService!.setRegistryEntry(planId, stepId, { step, traceId, requestId, job: refreshedJob, inFlight: false });

      await this.releaseNextPlanSteps(planId);
  }

  async releaseNextPlanSteps(planId: string): Promise<void> {
    await this.stateService!.withPlanLock(planId, async () => {
      const metadata = await this.stateService!.getPlanMetadata(planId);
      if (!metadata) return;
      
      const canReleaseNextStep = () =>
        metadata.nextStepIndex < metadata.steps.length &&
        metadata.nextStepIndex <= metadata.lastCompletedIndex + 1;

      while (canReleaseNextStep()) {
        const stepEntry = metadata.steps[metadata.nextStepIndex];
        const key = `${planId}:${stepEntry.step.id}`;
        const existing = await this.stateService!.getEntry(planId, stepEntry.step.id);
        
        if (existing && ["queued", "running", "retrying"].includes(existing.state)) {
             break;
        }

        const subjectContext = stepEntry.subject ?? existing?.subject ?? this.stateService!.getPlanSubject(planId);
        const baseRequestId = metadata.requestId ?? stepEntry.requestId ?? randomUUID();
        const job: PlanJob = {
            planId,
            step: stepEntry.step,
            attempt: existing?.attempt ?? stepEntry.attempt ?? 0,
            createdAt: existing?.createdAt ?? stepEntry.createdAt,
            traceId: metadata.traceId,
            requestId: baseRequestId,
            subject: subjectContext ? clonePlanSubject(subjectContext) : undefined,
        };

        metadata.requestId = baseRequestId;
        stepEntry.attempt = job.attempt;
        stepEntry.createdAt = job.createdAt;
        stepEntry.requestId = baseRequestId;
        stepEntry.subject = job.subject ? clonePlanSubject(job.subject) : undefined;

        const approvals = await this.stateService!.ensureApprovals(planId, stepEntry.step.id);
        const policyEnforcer = getPolicyEnforcer();
        let policyDecision;
        try {
             policyDecision = await policyEnforcer.enforcePlanStep(stepEntry.step, {
                  planId,
                  traceId: metadata.traceId,
                  approvals,
                  subject: this.toPolicySubject(job.subject),
             });
             const blockingReasons = policyDecision.deny.filter(reason => reason.reason !== "approval_required");
                    if (!policyDecision.allow && (blockingReasons.length > 0 || !stepEntry.step.approvalRequired)) {
                        throw new PolicyViolationError(`Plan step ${stepEntry.step.id} for capability ${stepEntry.step.capability} is not permitted`, policyDecision.deny);
                    }
        } catch (error) {
             // Log or rethrow?
             throw error; 
        }

        this.stateService!.setRegistryEntry(planId, stepEntry.step.id, {
            step: stepEntry.step,
            traceId: metadata.traceId,
            requestId: job.requestId,
            job,
            inFlight: false,
        });

        const requiresApproval = stepEntry.step.approvalRequired && !approvals[stepEntry.step.capability];

        if (requiresApproval) {
             if (!existing) {
                 await this.stateService!.rememberStep(planId, stepEntry.step, metadata.traceId, {
                      initialState: "waiting_approval",
                      idempotencyKey: key,
                      attempt: job.attempt,
                      createdAt: job.createdAt,
                      requestId: job.requestId,
                      approvals,
                      subject: job.subject,
                 });
                 await this.emitPlanEvent(planId, stepEntry.step, metadata.traceId, job.requestId, {
                      state: "waiting_approval",
                      summary: "Awaiting approval",
                      attempt: job.attempt,
                 });
             }
             break;
        }

        this.stateService!.cacheApprovals(planId, stepEntry.step.id, approvals);

        const queueAdapter = await getQueueAdapter();
        if (!existing) {
             await this.stateService!.rememberStep(planId, stepEntry.step, metadata.traceId, {
                  initialState: "queued",
                  idempotencyKey: key,
                  attempt: job.attempt,
                  createdAt: job.createdAt,
                  requestId: job.requestId,
                  approvals,
                  subject: job.subject,
             });
        }

        try {
            const headers: Record<string, string> = {};
            propagation.inject(otelContext.active(), headers, propagationSetter);
            headers["trace-id"] = metadata.traceId;
            if (job.requestId) headers["request-id"] = job.requestId;

            await queueAdapter.enqueue<PlanStepTaskPayload>(
                 PLAN_STEPS_QUEUE,
                 { ...job },
                 { idempotencyKey: key, headers }
            );
        } catch (error) {
             this.stateService!.deleteRegistryEntry(planId, stepEntry.step.id);
             this.stateService!.clearApprovals(planId, stepEntry.step.id);
             await this.stateService!.forgetStep(planId, stepEntry.step.id);
             this.prunePlanSubject(planId);
             throw error;
        }

        await this.emitPlanEvent(planId, stepEntry.step, metadata.traceId, job.requestId, {
             state: "queued",
             summary: "Queued for execution",
             attempt: job.attempt,
        });

        metadata.nextStepIndex += 1;
      }
      
      const completed =
        metadata.nextStepIndex >= metadata.steps.length &&
        metadata.lastCompletedIndex >= metadata.steps.length - 1;

      if (completed) {
           await this.stateService!.forgetPlanMetadata(planId);
      } else {
           await this.stateService!.rememberPlanMetadata(planId, metadata);
      }

      if (completed) {
        const sessionId = this.planSessions.get(planId);
        if (sessionId) {
          const remaining = (this.sessionRefCounts.get(sessionId) ?? 1) - 1;
          if (remaining <= 0) {
            await this.fileLockManager.releaseSessionLocks(sessionId).catch((err) =>
              this.queueLogger.warn(
                { err: normalizeError(err), planId, sessionId },
                "failed to release session locks",
              ),
            );
            this.sessionRefCounts.delete(sessionId);
          } else {
            this.sessionRefCounts.set(sessionId, remaining);
          }
          this.planSessions.delete(planId);
        }
      }
      
      if (this.queueAdapter) {
           const depth = await this.queueAdapter.getQueueDepth(PLAN_STEPS_QUEUE);
           queueDepthGauge.labels(PLAN_STEPS_QUEUE, this.config.messaging.type ?? "rabbitmq", getDefaultTenantLabel()).set(depth);
      }
    });
  }

  async rehydratePendingSteps(): Promise<void> {
      const pendingSteps = await this.stateService!.listActiveSteps();
      const restoredSessions = new Set<string>();
      for (const persisted of pendingSteps) {
          const key = persisted.idempotencyKey;
          const metadata = this.stateService!.getRegistryEntry(persisted.planId, persisted.step.id);
          if (metadata) {
              continue;
          }

          const sessionId = persisted.subject?.sessionId;
          if (sessionId) {
            this.planSessions.set(persisted.planId, sessionId);
            this.sessionRefCounts.set(sessionId, (this.sessionRefCounts.get(sessionId) ?? 0) + 1);

            if (!restoredSessions.has(sessionId)) {
              restoredSessions.add(sessionId);
              await this.fileLockManager.restoreSessionLocks(sessionId).catch((err) =>
                this.queueLogger.warn(
                  { err: normalizeError(err), sessionId, planId: persisted.planId },
                  "failed to restore session locks during rehydrate",
                ),
              );
            }
          }
          
          const job: PlanJob = {
              planId: persisted.planId,
              step: persisted.step,
              attempt: persisted.attempt,
              createdAt: persisted.createdAt,
              traceId: persisted.traceId,
              requestId: persisted.requestId,
          };
          
          this.stateService!.setRegistryEntry(persisted.planId, persisted.step.id, {
              step: persisted.step,
              traceId: persisted.traceId,
              requestId: persisted.requestId,
              job,
              inFlight: false
          });

          if (persisted.state === "waiting_approval") {
             await this.emitPlanEvent(persisted.planId, persisted.step, persisted.traceId, persisted.requestId, {
                 state: "waiting_approval",
                 summary: "Awaiting approval (rehydrated)",
                 attempt: persisted.attempt
             });
             continue;
          }

          if (persisted.state === "running" || persisted.state === "queued") {
               const queueAdapter = await getQueueAdapter();
               const headers: Record<string, string> = {};
               headers["trace-id"] = persisted.traceId;
               if (persisted.requestId) headers["request-id"] = persisted.requestId;
               
               await queueAdapter.enqueue<PlanStepTaskPayload>(
                    PLAN_STEPS_QUEUE,
                    { ...job },
                    { idempotencyKey: key, headers }
               );
               
               if (persisted.state === "running") {
                   await this.emitPlanEvent(persisted.planId, persisted.step, persisted.traceId, persisted.requestId, {
                       state: "queued",
                       summary: `Retry enqueued (attempt ${persisted.attempt})`,
                       attempt: persisted.attempt
                   });
               }
          }
      }
  }

  private toPolicySubject(subject?: PlanSubject) {
      if (!subject) return undefined;
      return {
          tenant: subject.tenantId,
          sessionId: subject.sessionId,
          roles: subject.roles,
          scopes: subject.scopes,
          user: { id: subject.userId, email: subject.email, name: subject.name },
      };
  }

  private async emitPlanEvent(
      planId: string,
      step: PlanStep,
      traceId: string,
      requestId: string | undefined,
      update: Partial<ToolEvent> & { state: ToolEvent["state"]; summary?: string; output?: Record<string, unknown>; attempt?: number },
    ): Promise<void> {
      const sanitizedOutput = this.config.retention.contentCapture.enabled ? update.output : undefined;
      await this.stateService!.setState(
        planId,
        step.id,
        update.state,
        update.summary,
        sanitizedOutput,
        update.attempt,
      );
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
        },
      });
    }
    
    private prunePlanSubject(planId: string): void {
        if (!this.stateService!.hasPlanSubject(planId)) {
            return;
        }
        for (const key of this.stateService!.getRegistryKeys()) {
            if (key.startsWith(`${planId}:`)) {
                return;
            }
        }
        const subject = this.stateService!.getPlanSubject(planId);
        this.stateService!.deletePlanSubject(planId);
        if (subject) {
            this.stateService!.retainCompletedPlanSubject(planId, subject);
        }
    }
    
  getPlanSubject(planId: string) {
      if (!this.stateService) return undefined;
      return this.stateService.getPlanSubject(planId) ?? this.stateService.getRetainedPlanSubject(planId);
  }

  async getPersistedPlanStep(planId: string, stepId: string) {
      if (!this.stateService) return undefined;
      return this.stateService.getEntry(planId, stepId);
  }

  private async releaseTrackedSessionLocks(): Promise<void> {
    const sessionIds = new Set<string>();
    for (const sessionId of this.sessionRefCounts.keys()) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of this.planSessions.values()) {
      sessionIds.add(sessionId);
    }

    for (const sessionId of sessionIds) {
      await this.fileLockManager.releaseSessionLocks(sessionId).catch((err) =>
        this.queueLogger.warn(
          { err: normalizeError(err), sessionId },
          "failed to release session locks during shutdown",
        ),
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stepConsumer) {
      this.stepConsumer.stop();
    }
        if (this.completionConsumer) {
      this.completionConsumer.stop();
    }

    await this.releaseTrackedSessionLocks();

    if (this.stateService) {
        // Close without clearing to preserve state for restart tests
        await this.stateService.close().catch(() => {});
    }
        this.stateService = undefined;
        this.initialized = false;
        this.initializationPromise = null;
        this.planSessions.clear();
        this.sessionRefCounts.clear();
    }

    async reset(): Promise<void> {
        if (this.stepConsumer) {
          this.stepConsumer.stop();
        }
        if (this.completionConsumer) {
      this.completionConsumer.stop();
    }

    await this.releaseTrackedSessionLocks();

    if (this.stateService) {
        this.stateService.clearAll();
        // Ensure persistence is closed to avoid race conditions in tests
        await this.stateService.close().catch(() => {});
        }
        this.stateService = undefined;
        this.initialized = false;
        this.initializationPromise = null;
        // Reload config and setup services again to pick up env changes in tests
        this.config = loadConfig();
        await this.setupServices();
        this.planSessions.clear();
        this.sessionRefCounts.clear();
    }

    hasPendingPlanStep(planId: string, stepId: string): boolean {
        if (!this.stateService) return false;
        return this.stateService.hasRegistryEntry(planId, stepId);
    }
    
    hasApprovalCacheEntry(planId: string, stepId: string): boolean {
        if (!this.stateService) return false;
        return this.stateService.hasApprovalCacheEntry(planId, stepId);
    }
    
    hasActivePlanSubject(planId: string): boolean {
        if (!this.stateService) return false;
        return this.stateService.hasPlanSubject(planId);
    }
}

export const planQueueManager = new PlanQueueManager();
