import { appLogger } from "../observability/logger.js";
import type { PlanStatePersistence, PersistedStep, PersistedPlanMetadata } from "../queue/PlanStateStore.js";
import type { PlanJob, ToolEvent } from "../plan/validation.js";
import type { PlanStep, PlanSubject } from "../plan/planner.js";
import type { DistributedLockService } from "./DistributedLockService.js";

function clonePlanSubject(subject: PlanSubject): PlanSubject {
  return {
    ...subject,
    roles: [...subject.roles],
    scopes: [...subject.scopes],
  };
}

export class PlanStateService {
  private readonly stepRegistry = new Map<
    string,
    { step: PlanStep; traceId: string; requestId?: string; job: PlanJob; inFlight: boolean }
  >();
  private readonly approvalCache = new Map<string, Record<string, boolean>>();
  private readonly planSubjects = new Map<string, PlanSubject>();
  private readonly retainedPlanSubjects = new Map<
    string,
    { subject: PlanSubject; timeout?: NodeJS.Timeout }
  >();

  constructor(
    private readonly store: PlanStatePersistence,
    private readonly lockService: DistributedLockService,
    private readonly retentionMs: number = 24 * 60 * 60 * 1000
  ) {}

  async withPlanLock(planId: string, task: () => Promise<void>): Promise<void> {
    let release: () => Promise<void>;
    try {
      release = await this.lockService.acquireLock(`plan:${planId}`, 30000);
    } catch (error) {
       appLogger.warn({ planId, err: error }, "Failed to acquire plan lock");
       throw error;
    }
    try {
      await task();
    } finally {
      await release();
    }
  }

  async getEntry(planId: string, stepId: string) {
      return this.store.getEntry(planId, stepId);
  }

  async setState(
    planId: string,
    stepId: string,
    state: ToolEvent["state"],
    summary?: string,
    output?: Record<string, unknown>,
    attempt?: number
  ) {
    return this.store.setState(planId, stepId, state, summary, output, attempt);
  }

  async rememberStep(
    planId: string,
    step: PlanStep,
    traceId: string,
    options: {
        initialState: ToolEvent["state"];
        idempotencyKey: string;
        attempt: number;
        createdAt: string;
        requestId?: string;
        approvals?: Record<string, boolean>;
        subject?: PlanSubject;
    }
  ) {
      return this.store.rememberStep(planId, step, traceId, options);
  }

  async forgetStep(planId: string, stepId: string) {
      return this.store.forgetStep(planId, stepId);
  }

  async recordApproval(planId: string, stepId: string, capability: string, approved: boolean) {
      return this.store.recordApproval(planId, stepId, capability, approved);
  }

  async getPlanMetadata(planId: string) {
      return this.store.getPlanMetadata(planId);
  }

  async rememberPlanMetadata(planId: string, metadata: PersistedPlanMetadata) {
      return this.store.rememberPlanMetadata(planId, metadata);
  }

  async forgetPlanMetadata(planId: string) {
      return this.store.forgetPlanMetadata(planId);
  }

  async listActiveSteps() {
      return this.store.listActiveSteps();
  }

  async listPlanMetadata() {
      return this.store.listPlanMetadata();
  }

  getRegistryEntry(planId: string, stepId: string) {
      return this.stepRegistry.get(`${planId}:${stepId}`);
  }

  setRegistryEntry(planId: string, stepId: string, entry: { step: PlanStep; traceId: string; requestId?: string; job: PlanJob; inFlight: boolean }) {
      this.stepRegistry.set(`${planId}:${stepId}`, entry);
  }

  deleteRegistryEntry(planId: string, stepId: string) {
      this.stepRegistry.delete(`${planId}:${stepId}`);
  }
  
  hasRegistryEntry(planId: string, stepId: string): boolean {
      return this.stepRegistry.has(`${planId}:${stepId}`);
  }

  getRegistryKeys() {
      return this.stepRegistry.keys();
  }

  async ensureApprovals(planId: string, stepId: string): Promise<Record<string, boolean>> {
    const key = `${planId}:${stepId}`;
    const cached = this.approvalCache.get(key);
    if (cached) {
      return cached;
    }
    const persisted = await this.store.getEntry(planId, stepId);
    const approvals = persisted?.approvals ? { ...persisted.approvals } : {};
    this.approvalCache.set(key, approvals);
    return approvals;
  }

  cacheApprovals(planId: string, stepId: string, approvals: Record<string, boolean>): void {
    this.approvalCache.set(`${planId}:${stepId}`, { ...approvals });
  }

  clearApprovals(planId: string, stepId: string): void {
    this.approvalCache.delete(`${planId}:${stepId}`);
  }

  hasApprovalCacheEntry(planId: string, stepId: string): boolean {
    return this.approvalCache.has(`${planId}:${stepId}`);
  }

  getPlanSubject(planId: string): PlanSubject | undefined {
      return this.planSubjects.get(planId);
  }
  
  setPlanSubject(planId: string, subject: PlanSubject) {
      this.planSubjects.set(planId, clonePlanSubject(subject));
  }
  
  deletePlanSubject(planId: string) {
      this.planSubjects.delete(planId);
  }
  
  hasPlanSubject(planId: string): boolean {
      return this.planSubjects.has(planId);
  }

  retainCompletedPlanSubject(planId: string, subject: PlanSubject): void {
    this.clearRetainedPlanSubject(planId);
    const timeout = setTimeout(() => {
      this.retainedPlanSubjects.delete(planId);
    }, this.retentionMs);
    timeout.unref?.();
    this.retainedPlanSubjects.set(planId, { subject: clonePlanSubject(subject), timeout });
  }

  clearRetainedPlanSubject(planId: string): void {
    const entry = this.retainedPlanSubjects.get(planId);
    if (entry?.timeout) {
      clearTimeout(entry.timeout);
    }
    this.retainedPlanSubjects.delete(planId);
  }

  getRetainedPlanSubject(planId: string): PlanSubject | undefined {
    const entry = this.retainedPlanSubjects.get(planId);
    if (!entry) {
      return undefined;
    }
    return clonePlanSubject(entry.subject);
  }

  clearAll() {
      this.stepRegistry.clear();
      this.approvalCache.clear();
      this.planSubjects.clear();
      this.retainedPlanSubjects.forEach(({ timeout }) => {
        if (timeout) clearTimeout(timeout);
      });
      this.retainedPlanSubjects.clear();
  }

  async close() {
      return this.store.close();
  }
}
