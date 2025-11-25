import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { getPostgresPool } from "../database/Postgres.js";
import { logAuditEvent } from "../observability/audit.js";
import { appLogger, normalizeError } from "../observability/logger.js";

export type CaseStatus = "open" | "active" | "closed";
export type TaskStatus = "pending" | "running" | "completed" | "failed";

export type CaseRecord = {
  id: string;
  tenantId: string;
  projectId?: string;
  title: string;
  description?: string;
  status: CaseStatus;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type TaskRecord = {
  id: string;
  caseId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactRecord = {
  id: string;
  caseId: string;
  type: string;
  ref: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type CreateCaseInput = {
  tenantId: string;
  projectId?: string;
  title: string;
  description?: string;
  status?: CaseStatus;
  metadata?: Record<string, unknown>;
};

export type CreateTaskInput = {
  caseId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  metadata?: Record<string, unknown>;
};

export type CreateArtifactInput = {
  caseId: string;
  type: string;
  ref: string;
  metadata?: Record<string, unknown>;
};

export class CaseService {
  private readonly pool: Pool | null;
  private readonly logger = appLogger.child({ component: "CaseService" });
  private readonly cases = new Map<string, CaseRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly sessionCaseMap = new Map<string, string>();

  constructor(pool?: Pool | null) {
    this.pool = pool ?? getPostgresPool();
  }

  async initialize(): Promise<void> {
    if (!this.pool) {
      this.logger.warn(
        {
          event: "cases.disabled",
          reason: "missing_postgres_pool",
        },
        "CaseService running in in-memory mode because no Postgres connection is configured",
      );
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS cases (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          project_id TEXT,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          ref TEXT NOT NULL,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cases_tenant_project ON cases(tenant_id, project_id);
      `);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      this.logger.error({ err: normalizeError(error) }, "failed to initialize CaseService tables");
      throw error;
    } finally {
      client.release();
    }
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private async persistCase(record: CaseRecord): Promise<void> {
    if (!this.pool) {
      this.cases.set(record.id, record);
      return;
    }

    await this.pool.query(
      `INSERT INTO cases (id, tenant_id, project_id, title, description, status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (id)
       DO UPDATE SET title = EXCLUDED.title,
                     description = EXCLUDED.description,
                     status = EXCLUDED.status,
                     metadata = EXCLUDED.metadata,
                     project_id = EXCLUDED.project_id,
                     updated_at = NOW()`,
      [
        record.id,
        record.tenantId,
        record.projectId ?? null,
        record.title,
        record.description ?? null,
        record.status,
        record.metadata ?? null,
        record.createdAt,
      ],
    );
  }

  private async persistTask(record: TaskRecord): Promise<void> {
    if (!this.pool) {
      this.tasks.set(record.id, record);
      return;
    }

    await this.pool.query(
      `INSERT INTO tasks (id, case_id, title, description, status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (id)
       DO UPDATE SET title = EXCLUDED.title,
                     description = EXCLUDED.description,
                     status = EXCLUDED.status,
                     metadata = EXCLUDED.metadata,
                     updated_at = NOW()`,
      [
        record.id,
        record.caseId,
        record.title,
        record.description ?? null,
        record.status,
        record.metadata ?? null,
        record.createdAt,
      ],
    );
  }

  private async persistArtifact(record: ArtifactRecord): Promise<void> {
    if (!this.pool) {
      this.artifacts.set(record.id, record);
      return;
    }

    await this.pool.query(
      `INSERT INTO artifacts (id, case_id, type, ref, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id)
       DO NOTHING`,
      [record.id, record.caseId, record.type, record.ref, record.metadata ?? null, record.createdAt],
    );
  }

  async createCase(input: CreateCaseInput): Promise<CaseRecord> {
    const now = this.nowIso();
    const record: CaseRecord = {
      id: `case-${randomUUID()}`,
      tenantId: input.tenantId,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: input.status ?? "open",
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    await this.persistCase(record);
    logAuditEvent({
      action: "case.create",
      outcome: "success",
      resource: record.id,
      subject: { tenantId: record.tenantId },
      details: { projectId: record.projectId },
    });

    return record;
  }

  async getCase(caseId: string): Promise<CaseRecord | undefined> {
    if (!this.pool) {
      return this.cases.get(caseId);
    }

    const result = await this.pool.query(
      `SELECT id, tenant_id as "tenantId", project_id as "projectId", title, description, status, metadata,
              created_at as "createdAt", updated_at as "updatedAt"
         FROM cases WHERE id = $1`,
      [caseId],
    );
    return result.rows[0];
  }

  async listCases(filter: { tenantId: string; projectId?: string; status?: CaseStatus[] }): Promise<CaseRecord[]> {
    if (!this.pool) {
      return Array.from(this.cases.values()).filter((record) => {
        if (record.tenantId !== filter.tenantId) return false;
        if (filter.projectId && record.projectId !== filter.projectId) return false;
        if (filter.status && filter.status.length > 0 && !filter.status.includes(record.status)) return false;
        return true;
      });
    }

    const conditions = ["tenant_id = $1"];
    const values: Array<string | string[]> = [filter.tenantId];

    if (filter.projectId) {
      conditions.push("project_id = $2");
      values.push(filter.projectId);
    }
    if (filter.status && filter.status.length > 0) {
      conditions.push(`status = ANY($${values.length + 1})`);
      values.push(filter.status);
    }

    const result = await this.pool.query(
      `SELECT id, tenant_id as "tenantId", project_id as "projectId", title, description, status, metadata,
              created_at as "createdAt", updated_at as "updatedAt"
         FROM cases
        WHERE ${conditions.join(" AND ")}
        ORDER BY updated_at DESC`,
      values,
    );
    return result.rows;
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const now = this.nowIso();
    const record: TaskRecord = {
      id: `task-${randomUUID()}`,
      caseId: input.caseId,
      title: input.title,
      description: input.description,
      status: input.status ?? "pending",
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    await this.persistTask(record);
    logAuditEvent({
      action: "case.task.create",
      outcome: "success",
      resource: record.caseId,
      details: { taskId: record.id, status: record.status },
    });
    return record;
  }

  async listTasks(caseId: string): Promise<TaskRecord[]> {
    if (!this.pool) {
      return Array.from(this.tasks.values()).filter((task) => task.caseId === caseId);
    }

    const result = await this.pool.query(
      `SELECT id, case_id as "caseId", title, description, status, metadata,
              created_at as "createdAt", updated_at as "updatedAt"
         FROM tasks
        WHERE case_id = $1
        ORDER BY created_at ASC`,
      [caseId],
    );
    return result.rows;
  }

  async attachArtifact(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const record: ArtifactRecord = {
      id: `artifact-${randomUUID()}`,
      caseId: input.caseId,
      type: input.type,
      ref: input.ref,
      metadata: input.metadata,
      createdAt: this.nowIso(),
    };

    await this.persistArtifact(record);
    logAuditEvent({
      action: "case.artifact.attach",
      outcome: "success",
      resource: record.caseId,
      details: { artifactId: record.id, type: record.type },
    });
    return record;
  }

  async listArtifacts(caseId: string): Promise<ArtifactRecord[]> {
    if (!this.pool) {
      return Array.from(this.artifacts.values()).filter((artifact) => artifact.caseId === caseId);
    }

    const result = await this.pool.query(
      `SELECT id, case_id as "caseId", type, ref, metadata, created_at as "createdAt"
         FROM artifacts
        WHERE case_id = $1
        ORDER BY created_at DESC`,
      [caseId],
    );
    return result.rows;
  }

  async getOrCreateCaseForSession(
    sessionId: string,
    tenantId: string,
    projectId?: string,
  ): Promise<CaseRecord> {
    const existingCaseId = this.sessionCaseMap.get(sessionId);
    if (existingCaseId) {
      const existing = await this.getCase(existingCaseId);
      if (existing) {
        return existing;
      }
    }

    const created = await this.createCase({
      tenantId,
      projectId,
      title: `Session ${sessionId.slice(0, 8)}`,
      status: "active",
    });
    this.sessionCaseMap.set(sessionId, created.id);
    return created;
  }
}

let caseServiceInstance: CaseService | null = null;

export function getCaseService(): CaseService {
  if (caseServiceInstance) {
    return caseServiceInstance;
  }
  caseServiceInstance = new CaseService();
  return caseServiceInstance;
}

export function resetCaseServiceForTests(): void {
  caseServiceInstance = null;
}
