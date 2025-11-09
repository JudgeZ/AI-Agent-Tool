import fs from "node:fs/promises";
import path from "node:path";

import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { PlanStep, PlanSubject } from "../plan/planner.js";
import type { PlanStepState } from "../plan/validation.js";

export type PersistedStep = {
  id: string;
  planId: string;
  stepId: string;
  traceId: string;
  step: PlanStep;
  state: PlanStepState;
  summary?: string;
  output?: Record<string, unknown>;
  updatedAt: string;
  attempt: number;
  idempotencyKey: string;
  createdAt: string;
  approvals?: Record<string, boolean>;
  subject?: PlanSubject;
};

export type PlanStepMetadata = {
  step: PlanStep;
  createdAt: string;
  attempt: number;
  subject?: PlanSubject;
};

export type PersistedPlanMetadata = {
  planId: string;
  traceId: string;
  steps: PlanStepMetadata[];
  nextStepIndex: number;
  lastCompletedIndex: number;
};

type PersistedDocument = {
  version: number;
  steps: PersistedStep[];
  plans?: PersistedPlanMetadata[];
};

type FilePlanStateStoreOptions = {
  filePath?: string;
  retentionMs?: number;
};

export type RememberStepOptions = {
  initialState?: PlanStepState;
  idempotencyKey?: string;
  attempt?: number;
  createdAt?: string;
  approvals?: Record<string, boolean>;
  subject?: PlanSubject;
};

export const TERMINAL_STATES: ReadonlySet<PlanStepState> = new Set([
  "completed",
  "failed",
  "rejected",
  "dead_lettered"
]);

function defaultPath(): string {
  const override = process.env.PLAN_STATE_PATH;
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(process.cwd(), "data", "plan-state.json");
}

export interface PlanStatePersistence {
  rememberStep(
    planId: string,
    step: PlanStep,
    traceId: string,
    options: {
      initialState?: PlanStepState;
      idempotencyKey: string;
      attempt: number;
      createdAt: string;
      approvals?: Record<string, boolean>;
      subject?: PlanSubject;
    }
  ): Promise<void>;
  setState(
    planId: string,
    stepId: string,
    state: PlanStepState,
    summary?: string,
    output?: Record<string, unknown>,
    attempt?: number
  ): Promise<void>;
  recordApproval(planId: string, stepId: string, capability: string, granted: boolean): Promise<void>;
  forgetStep(planId: string, stepId: string): Promise<void>;
  listActiveSteps(): Promise<PersistedStep[]>;
  getEntry(planId: string, stepId: string): Promise<PersistedStep | undefined>;
  getStep(planId: string, stepId: string): Promise<{ step: PlanStep; traceId: string } | undefined>;
  rememberPlanMetadata(planId: string, metadata: PersistedPlanMetadata): Promise<void>;
  getPlanMetadata(planId: string): Promise<PersistedPlanMetadata | undefined>;
  listPlanMetadata(): Promise<PersistedPlanMetadata[]>;
  forgetPlanMetadata(planId: string): Promise<void>;
  clear(): Promise<void>;
}

export class FilePlanStateStore implements PlanStatePersistence {
  private readonly filePath: string;
  private readonly retentionMs: number | null;
  private loaded = false;
  private readonly records = new Map<string, PersistedStep>();
  private readonly planRecords = new Map<string, PersistedPlanMetadata & { updatedAt: string }>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options?: FilePlanStateStoreOptions) {
    this.filePath = options?.filePath ?? defaultPath();
    this.retentionMs = options?.retentionMs && options.retentionMs > 0 ? options.retentionMs : null;
  }

  async rememberStep(
    planId: string,
    step: PlanStep,
    traceId: string,
    options: {
      initialState?: PlanStepState;
      idempotencyKey: string;
      attempt: number;
      createdAt: string;
      approvals?: Record<string, boolean>;
      subject?: PlanSubject;
    }
  ): Promise<void> {
    await this.ensureLoaded();
    this.purgeExpired();
    const key = this.toKey(planId, step.id);
    const entry: PersistedStep = {
      id: randomUUID(),
      planId,
      stepId: step.id,
      traceId,
      step,
      state: options.initialState ?? "queued",
      updatedAt: new Date().toISOString(),
      attempt: options.attempt,
      idempotencyKey: options.idempotencyKey,
      createdAt: options.createdAt,
      approvals: options.approvals,
      subject: options.subject
        ? {
            ...options.subject,
            roles: [...options.subject.roles],
            scopes: [...options.subject.scopes]
          }
        : undefined
    };
    this.records.set(key, entry);
    await this.enqueuePersist();
  }

  async setState(
    planId: string,
    stepId: string,
    state: PlanStepState,
    summary?: string,
    output?: Record<string, unknown>,
    attempt?: number
  ): Promise<void> {
    await this.ensureLoaded();
    const purged = this.purgeExpired();
    const key = this.toKey(planId, stepId);
    const existing = this.records.get(key);
    if (!existing) {
      if (purged) {
        await this.enqueuePersist();
      }
      return;
    }

    if (TERMINAL_STATES.has(state)) {
      this.records.delete(key);
    } else {
      this.records.set(key, {
        ...existing,
        state,
        summary,
        output,
        updatedAt: new Date().toISOString(),
        attempt: attempt ?? existing.attempt
      });
    }

    await this.enqueuePersist();
  }

  async recordApproval(planId: string, stepId: string, capability: string, granted: boolean): Promise<void> {
    await this.ensureLoaded();
    const purged = this.purgeExpired();
    const key = this.toKey(planId, stepId);
    const existing = this.records.get(key);
    if (!existing) {
      if (purged) {
        await this.enqueuePersist();
      }
      return;
    }

    const approvals = { ...(existing.approvals ?? {}) };
    if (granted) {
      approvals[capability] = true;
    } else {
      delete approvals[capability];
    }

    this.records.set(key, {
      ...existing,
      approvals,
      updatedAt: new Date().toISOString()
    });

    await this.enqueuePersist();
  }

  async forgetStep(planId: string, stepId: string): Promise<void> {
    await this.ensureLoaded();
    const purged = this.purgeExpired();
    const key = this.toKey(planId, stepId);
    let updated = purged;
    if (this.records.delete(key)) {
      updated = true;
    }
    if (updated) {
      await this.enqueuePersist();
    }
  }

  async listActiveSteps(): Promise<PersistedStep[]> {
    await this.ensureLoaded();
    const purged = this.purgeExpired();
    const entries = Array.from(this.records.values()).map(entry => ({
      ...entry,
      subject: entry.subject
        ? { ...entry.subject, roles: [...entry.subject.roles], scopes: [...entry.subject.scopes] }
        : undefined
    }));
    if (purged) {
      await this.enqueuePersist();
    }
    return entries;
  }

  async getEntry(planId: string, stepId: string): Promise<PersistedStep | undefined> {
    await this.ensureLoaded();
    const purged = this.purgeExpired();
    const entry = this.records.get(this.toKey(planId, stepId));
    if (purged) {
      await this.enqueuePersist();
    }
    return entry;
  }

  async getStep(planId: string, stepId: string): Promise<{ step: PlanStep; traceId: string } | undefined> {
    await this.ensureLoaded();
    const purged = this.purgeExpired();
    const record = this.records.get(this.toKey(planId, stepId));
    if (purged) {
      await this.enqueuePersist();
    }
    if (!record) {
      return undefined;
    }
    return { step: record.step, traceId: record.traceId };
  }

  async rememberPlanMetadata(planId: string, metadata: PersistedPlanMetadata): Promise<void> {
    await this.ensureLoaded();
    this.purgeExpired();
    const entry: PersistedPlanMetadata & { updatedAt: string } = {
      ...metadata,
      steps: metadata.steps.map(stepEntry => ({
        step: { ...stepEntry.step, labels: [...stepEntry.step.labels] },
        createdAt: stepEntry.createdAt,
        attempt: stepEntry.attempt,
        subject: stepEntry.subject
          ? {
              ...stepEntry.subject,
              roles: [...stepEntry.subject.roles],
              scopes: [...stepEntry.subject.scopes]
            }
          : undefined
      })),
      updatedAt: new Date().toISOString()
    };
    this.planRecords.set(planId, entry);
    await this.enqueuePersist();
  }

  async getPlanMetadata(planId: string): Promise<PersistedPlanMetadata | undefined> {
    await this.ensureLoaded();
    const purged = this.purgeExpired();
    const entry = this.planRecords.get(planId);
    if (purged) {
      await this.enqueuePersist();
    }
    if (!entry) {
      return undefined;
    }
    return {
      planId: entry.planId,
      traceId: entry.traceId,
      nextStepIndex: entry.nextStepIndex,
      lastCompletedIndex: entry.lastCompletedIndex,
      steps: entry.steps.map(stepEntry => ({
        step: { ...stepEntry.step, labels: [...stepEntry.step.labels] },
        createdAt: stepEntry.createdAt,
        attempt: stepEntry.attempt,
        subject: stepEntry.subject
          ? {
              ...stepEntry.subject,
              roles: [...stepEntry.subject.roles],
              scopes: [...stepEntry.subject.scopes]
            }
          : undefined
      }))
    };
  }

  async listPlanMetadata(): Promise<PersistedPlanMetadata[]> {
    await this.ensureLoaded();
    const purged = this.purgeExpired();
    const plans = Array.from(this.planRecords.values()).map(entry => ({
      planId: entry.planId,
      traceId: entry.traceId,
      nextStepIndex: entry.nextStepIndex,
      lastCompletedIndex: entry.lastCompletedIndex,
      steps: entry.steps.map(stepEntry => ({
        step: { ...stepEntry.step, labels: [...stepEntry.step.labels] },
        createdAt: stepEntry.createdAt,
        attempt: stepEntry.attempt,
        subject: stepEntry.subject
          ? {
              ...stepEntry.subject,
              roles: [...stepEntry.subject.roles],
              scopes: [...stepEntry.subject.scopes]
            }
          : undefined
      }))
    }));
    if (purged) {
      await this.enqueuePersist();
    }
    return plans;
  }

  async forgetPlanMetadata(planId: string): Promise<void> {
    await this.ensureLoaded();
    const purged = this.purgeExpired();
    const removed = this.planRecords.delete(planId);
    if (purged || removed) {
      await this.enqueuePersist();
    }
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    this.records.clear();
    this.planRecords.clear();
    await this.enqueuePersist();
  }

  private toKey(planId: string, stepId: string): string {
    return `${planId}:${stepId}`;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await this.load();
    this.loaded = true;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const document = JSON.parse(raw) as PersistedDocument;
      if (!Array.isArray(document.steps)) {
        return;
      }
      for (const entry of document.steps) {
        if (entry && typeof entry.planId === "string" && typeof entry.stepId === "string") {
          this.records.set(this.toKey(entry.planId, entry.stepId), entry);
        }
      }
      if (Array.isArray(document.plans)) {
        for (const plan of document.plans) {
          if (plan && typeof plan.planId === "string") {
            this.planRecords.set(plan.planId, {
              ...plan,
              steps: plan.steps.map(stepEntry => ({
                step: stepEntry.step,
                createdAt: stepEntry.createdAt,
                attempt: stepEntry.attempt,
                subject: stepEntry.subject
              })),
              updatedAt: new Date().toISOString()
            });
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private enqueuePersist(): Promise<void> {
    const run = this.persistChain.then(() => this.persist());
    this.persistChain = run.catch(() => {
      /* swallow persist errors for subsequent attempts */
    });
    return run;
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const payload: PersistedDocument = {
      version: 1,
      steps: Array.from(this.records.values()),
      plans: Array.from(this.planRecords.values()).map(entry => ({
        planId: entry.planId,
        traceId: entry.traceId,
        nextStepIndex: entry.nextStepIndex,
        lastCompletedIndex: entry.lastCompletedIndex,
        steps: entry.steps.map(stepEntry => ({
          step: stepEntry.step,
          createdAt: stepEntry.createdAt,
          attempt: stepEntry.attempt,
          subject: stepEntry.subject
        }))
      }))
    };
    const tempPath = path.join(dir, `${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    const data = JSON.stringify(payload, null, 2);
    try {
      await fs.writeFile(tempPath, data, { mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private purgeExpired(now = Date.now()): boolean {
    if (this.retentionMs === null) {
      return false;
    }
    const cutoff = now - this.retentionMs;
    let removed = false;
    for (const [key, entry] of this.records.entries()) {
      const updated = Date.parse(entry.updatedAt ?? "");
      const created = Date.parse(entry.createdAt ?? "");
      const reference = Number.isFinite(updated) ? updated : Number.isFinite(created) ? created : undefined;
      if (reference !== undefined && reference < cutoff) {
        this.records.delete(key);
        removed = true;
      }
    }
    for (const [planId, metadata] of this.planRecords.entries()) {
      const reference = Date.parse(metadata.updatedAt ?? "");
      if (Number.isFinite(reference) && reference < cutoff) {
        this.planRecords.delete(planId);
        removed = true;
      }
    }
    return removed;
  }
}

type PostgresPlanStateStoreOptions = {
  retentionMs?: number;
};

type PlanStateRow = {
  plan_id: string;
  step_id: string;
  id: string;
  trace_id: string;
  step: PlanStep;
  state: PlanStepState;
  summary: string | null;
  output: Record<string, unknown> | null;
  updated_at: string | Date;
  attempt: number;
  idempotency_key: string;
  created_at: string | Date;
  approvals: Record<string, boolean> | null;
  subject: PlanSubject | null;
};

type PlanMetadataRow = {
  plan_id: string;
  trace_id: string;
  steps: PlanStepMetadata[];
  next_step_index: number;
  last_completed_index: number;
  updated_at: string | Date;
};

function cloneSubject(subject: PlanSubject | undefined): PlanSubject | undefined {
  if (!subject) {
    return undefined;
  }
  return {
    ...subject,
    roles: [...subject.roles],
    scopes: [...subject.scopes],
  };
}

function cloneStep(step: PlanStep): PlanStep {
  return {
    ...step,
    labels: [...step.labels],
  };
}

export class PostgresPlanStateStore implements PlanStatePersistence {
  private readonly retentionMs: number | null;
  private readonly ready: Promise<void>;

  constructor(private readonly pool: Pool, options?: PostgresPlanStateStoreOptions) {
    this.retentionMs = options?.retentionMs && options.retentionMs > 0 ? options.retentionMs : null;
    this.ready = this.initialize();
  }

  async rememberStep(
    planId: string,
    step: PlanStep,
    traceId: string,
    options: {
      initialState?: PlanStepState;
      idempotencyKey: string;
      attempt: number;
      createdAt: string;
      approvals?: Record<string, boolean>;
      subject?: PlanSubject;
    }
  ): Promise<void> {
    await this.ready;
    await this.purgeExpired();
    const now = new Date();
    const createdAt = this.parseTimestamp(options.createdAt) ?? now;
    const subject = options.subject ? cloneSubject(options.subject) : null;
    const storedStep = cloneStep(step);
    await this.pool.query(
      `INSERT INTO plan_state (
        plan_id,
        step_id,
        id,
        trace_id,
        step,
        state,
        summary,
        output,
        updated_at,
        attempt,
        idempotency_key,
        created_at,
        approvals,
        subject
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (plan_id, step_id)
      DO UPDATE SET
        id = EXCLUDED.id,
        trace_id = EXCLUDED.trace_id,
        step = EXCLUDED.step,
        state = EXCLUDED.state,
        summary = EXCLUDED.summary,
        output = EXCLUDED.output,
        updated_at = EXCLUDED.updated_at,
        attempt = EXCLUDED.attempt,
        idempotency_key = EXCLUDED.idempotency_key,
        created_at = EXCLUDED.created_at,
        approvals = EXCLUDED.approvals,
        subject = EXCLUDED.subject`,
      [
        planId,
        step.id,
        randomUUID(),
        traceId,
        storedStep,
        options.initialState ?? "queued",
        null,
        null,
        now,
        options.attempt,
        options.idempotencyKey,
        createdAt,
        options.approvals ?? {},
        subject ?? null,
      ],
    );
  }

  async setState(
    planId: string,
    stepId: string,
    state: PlanStepState,
    summary?: string,
    output?: Record<string, unknown>,
    attempt?: number,
  ): Promise<void> {
    await this.ready;
    await this.purgeExpired();
    if (TERMINAL_STATES.has(state)) {
      await this.pool.query(`DELETE FROM plan_state WHERE plan_id = $1 AND step_id = $2`, [planId, stepId]);
      return;
    }
    const updatedAt = new Date();
    await this.pool.query(
      `UPDATE plan_state
        SET state = $3,
            summary = $4,
            output = $5,
            updated_at = $6,
            attempt = COALESCE($7, attempt)
        WHERE plan_id = $1 AND step_id = $2`,
      [planId, stepId, state, summary ?? null, output ?? null, updatedAt, attempt ?? null],
    );
  }

  async recordApproval(planId: string, stepId: string, capability: string, granted: boolean): Promise<void> {
    await this.ready;
    await this.purgeExpired();
    const existing = await this.pool.query<{ approvals: Record<string, boolean> | null }>(
      `SELECT approvals FROM plan_state WHERE plan_id = $1 AND step_id = $2`,
      [planId, stepId],
    );
    if (existing.rowCount === 0) {
      return;
    }
    const approvals = { ...(existing.rows[0]?.approvals ?? {}) };
    if (granted) {
      approvals[capability] = true;
    } else {
      delete approvals[capability];
    }
    await this.pool.query(
      `UPDATE plan_state SET approvals = $3, updated_at = $4 WHERE plan_id = $1 AND step_id = $2`,
      [planId, stepId, approvals, new Date()],
    );
  }

  async forgetStep(planId: string, stepId: string): Promise<void> {
    await this.ready;
    await this.purgeExpired();
    await this.pool.query(`DELETE FROM plan_state WHERE plan_id = $1 AND step_id = $2`, [planId, stepId]);
  }

  async listActiveSteps(): Promise<PersistedStep[]> {
    await this.ready;
    await this.purgeExpired();
    const result = await this.pool.query<PlanStateRow>(
      `SELECT plan_id, step_id, id, trace_id, step, state, summary, output, updated_at, attempt, idempotency_key, created_at, approvals, subject
       FROM plan_state`,
    );
    return result.rows.map((row: PlanStateRow) => this.toPersistedStep(row));
  }

  async getEntry(planId: string, stepId: string): Promise<PersistedStep | undefined> {
    await this.ready;
    await this.purgeExpired();
    const result = await this.pool.query<PlanStateRow>(
      `SELECT plan_id, step_id, id, trace_id, step, state, summary, output, updated_at, attempt, idempotency_key, created_at, approvals, subject
       FROM plan_state
       WHERE plan_id = $1 AND step_id = $2`,
      [planId, stepId],
    );
    const row = result.rows[0];
    return row ? this.toPersistedStep(row) : undefined;
  }

  async getStep(planId: string, stepId: string): Promise<{ step: PlanStep; traceId: string } | undefined> {
    await this.ready;
    await this.purgeExpired();
    const result = await this.pool.query<{ step: PlanStep; trace_id: string }>(
      `SELECT step, trace_id FROM plan_state WHERE plan_id = $1 AND step_id = $2`,
      [planId, stepId],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return { step: cloneStep(row.step), traceId: row.trace_id };
  }

  async rememberPlanMetadata(planId: string, metadata: PersistedPlanMetadata): Promise<void> {
    await this.ready;
    await this.purgeExpired();
    const now = new Date();
    await this.pool.query(
      `INSERT INTO plan_state_metadata (plan_id, trace_id, steps, next_step_index, last_completed_index, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (plan_id)
       DO UPDATE SET trace_id = EXCLUDED.trace_id,
                     steps = EXCLUDED.steps,
                     next_step_index = EXCLUDED.next_step_index,
                     last_completed_index = EXCLUDED.last_completed_index,
                     updated_at = EXCLUDED.updated_at`,
      [
        planId,
        metadata.traceId,
        metadata.steps.map((entry) => ({
          step: cloneStep(entry.step),
          createdAt: entry.createdAt,
          attempt: entry.attempt,
          subject: cloneSubject(entry.subject),
        })),
        metadata.nextStepIndex,
        metadata.lastCompletedIndex,
        now,
      ],
    );
  }

  async getPlanMetadata(planId: string): Promise<PersistedPlanMetadata | undefined> {
    await this.ready;
    await this.purgeExpired();
    const result = await this.pool.query<PlanMetadataRow>(
      `SELECT plan_id, trace_id, steps, next_step_index, last_completed_index, updated_at
       FROM plan_state_metadata
       WHERE plan_id = $1`,
      [planId],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return this.toPersistedPlanMetadata(row);
  }

  async listPlanMetadata(): Promise<PersistedPlanMetadata[]> {
    await this.ready;
    await this.purgeExpired();
    const result = await this.pool.query<PlanMetadataRow>(
      `SELECT plan_id, trace_id, steps, next_step_index, last_completed_index, updated_at FROM plan_state_metadata`,
    );
    return result.rows.map((row) => this.toPersistedPlanMetadata(row));
  }

  async forgetPlanMetadata(planId: string): Promise<void> {
    await this.ready;
    await this.purgeExpired();
    await this.pool.query(`DELETE FROM plan_state_metadata WHERE plan_id = $1`, [planId]);
  }

  async clear(): Promise<void> {
    await this.ready;
    await this.pool.query(`DELETE FROM plan_state`);
    await this.pool.query(`DELETE FROM plan_state_metadata`);
  }

  private async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS plan_state (
        plan_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        id UUID NOT NULL,
        trace_id TEXT NOT NULL,
        step JSONB NOT NULL,
        state TEXT NOT NULL,
        summary TEXT,
        output JSONB,
        updated_at TIMESTAMPTZ NOT NULL,
        attempt INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        approvals JSONB,
        subject JSONB,
        PRIMARY KEY (plan_id, step_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS plan_state_updated_at_idx ON plan_state(updated_at)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS plan_state_metadata (
        plan_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        steps JSONB NOT NULL,
        next_step_index INTEGER NOT NULL,
        last_completed_index INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS plan_state_metadata_updated_at_idx ON plan_state_metadata(updated_at)
    `);
  }

  private async purgeExpired(now = Date.now()): Promise<void> {
    if (this.retentionMs === null) {
      return;
    }
    const cutoff = new Date(now - this.retentionMs);
    await this.pool.query(`DELETE FROM plan_state WHERE updated_at < $1`, [cutoff]);
    await this.pool.query(`DELETE FROM plan_state_metadata WHERE updated_at < $1`, [cutoff]);
  }

  private parseTimestamp(value: string | undefined): Date | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }
    return parsed;
  }

  private toIso(value: string | Date): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return new Date().toISOString();
    }
    return parsed.toISOString();
  }

  private toPersistedStep(row: PlanStateRow): PersistedStep {
    return {
      id: row.id,
      planId: row.plan_id,
      stepId: row.step_id,
      traceId: row.trace_id,
      step: cloneStep(row.step),
      state: row.state,
      summary: row.summary ?? undefined,
      output: row.output ?? undefined,
      updatedAt: this.toIso(row.updated_at),
      attempt: row.attempt,
      idempotencyKey: row.idempotency_key,
      createdAt: this.toIso(row.created_at),
      approvals: row.approvals ?? undefined,
      subject: cloneSubject(row.subject ?? undefined),
    };
  }

  private toPersistedPlanMetadata(row: PlanMetadataRow): PersistedPlanMetadata {
    return {
      planId: row.plan_id,
      traceId: row.trace_id,
      nextStepIndex: row.next_step_index,
      lastCompletedIndex: row.last_completed_index,
      steps: row.steps.map((entry) => ({
        step: cloneStep(entry.step),
        createdAt: entry.createdAt,
        attempt: entry.attempt,
        subject: cloneSubject(entry.subject),
      })),
    };
  }
}

export type PlanStateStoreBackend = "file" | "postgres";

export type PlanStateStoreFactoryOptions = {
  backend?: PlanStateStoreBackend;
  filePath?: string;
  retentionMs?: number;
  pool?: Pool;
};

export function createPlanStateStore(options?: PlanStateStoreFactoryOptions): PlanStatePersistence {
  const backend = options?.backend ?? "file";
  if (backend === "postgres") {
    const pool = options?.pool;
    if (!pool) {
      throw new Error("Postgres plan state backend requires a database pool");
    }
    return new PostgresPlanStateStore(pool, { retentionMs: options?.retentionMs });
  }
  return new FilePlanStateStore({ filePath: options?.filePath, retentionMs: options?.retentionMs });
}

export { FilePlanStateStore as PlanStateStore };
